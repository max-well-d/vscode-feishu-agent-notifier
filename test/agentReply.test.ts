import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AgentReplyJob, AgentReplyQueue, AgentReplyResult, AgentReplyRunner, buildAgentCommand, extractClaudeSessionId, extractCodexTurnId, hasGitMetadataAncestor, isCodexActiveWriterConflict, ManagedCodexExecutor, shouldForkClaudeSession } from "../src/agentReply";
import { AgentSession } from "../src/types";

const codex: AgentSession = {
  source: "codex",
  sessionId: "codex-session",
  cwd: process.cwd(),
  project: "repo",
  lastSeenAt: new Date().toISOString(),
  status: "completed"
};

class FakeRunner extends AgentReplyRunner {
  public readonly started: string[] = [];
  public release: (() => void) | undefined;

  public override async run(job: AgentReplyJob, signal: AbortSignal): Promise<AgentReplyResult> {
    this.started.push(job.prompt);
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return { exitCode: 0, durationMs: 1, outputTail: "" };
  }
}

test("builds public resume commands without bypass flags", () => {
  const codexCommand = buildAgentCommand(codex, "planOnly");
  assert.ok(codexCommand.args.includes("read-only"));
  assert.ok(codexCommand.args.includes("resume"));
  assert.ok(!codexCommand.args.some((arg) => arg.includes("dangerously")));
  const claudeCommand = buildAgentCommand({ ...codex, source: "claude-code" }, "planOnly");
  assert.deepEqual(claudeCommand.args.slice(0, 2), ["--resume", "codex-session"]);
  assert.ok(claudeCommand.args.includes("plan"));
  assert.ok(!buildAgentCommand({ ...codex, sessionId: "new:test" }, "planOnly").args.includes("resume"));
  assert.ok(!buildAgentCommand({ ...codex, source: "claude-code", sessionId: "new:test" }, "planOnly").args.includes("--resume"));
  const claudeFork = buildAgentCommand(
    { ...codex, source: "claude-code", ownership: "external", completionEvidence: "authoritative" },
    "inherit",
    { forkClaudeSession: true }
  );
  assert.ok(claudeFork.args.includes("--fork-session"));
});

test("uses explicit full-access flags only for the fullAccess policy", () => {
  const codexCommand = buildAgentCommand(codex, "fullAccess");
  assert.ok(codexCommand.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  const claudeCommand = buildAgentCommand({ ...codex, source: "claude-code" }, "fullAccess");
  assert.ok(claudeCommand.args.includes("--dangerously-skip-permissions"));

  assert.ok(!buildAgentCommand(codex, "inherit").args.some((arg) => arg.includes("dangerously")));
  assert.ok(!buildAgentCommand({ ...codex, source: "claude-code" }, "inherit").args.some((arg) => arg.includes("permission")));
});

test("allows non-Git Codex resume only for an authoritative external session", () => {
  const authoritativeExternal: AgentSession = {
    ...codex,
    ownership: "external",
    completionEvidence: "authoritative"
  };
  const command = buildAgentCommand(authoritativeExternal, "inherit", { allowNonGitWorkspace: true });
  assert.ok(command.args.includes("--skip-git-repo-check"));
  assert.ok(!buildAgentCommand({ ...authoritativeExternal, completionEvidence: "discovered" }, "inherit", { allowNonGitWorkspace: true }).args.includes("--skip-git-repo-check"));
  assert.ok(!buildAgentCommand({ ...authoritativeExternal, ownership: "managed" }, "inherit", { allowNonGitWorkspace: true }).args.includes("--skip-git-repo-check"));
  assert.ok(!buildAgentCommand({ ...authoritativeExternal, sessionId: "new:test" }, "inherit", { allowNonGitWorkspace: true }).args.includes("--skip-git-repo-check"));
  assert.ok(!buildAgentCommand({ ...authoritativeExternal, source: "claude-code" }, "inherit", { allowNonGitWorkspace: true }).args.includes("--skip-git-repo-check"));
});

test("detects Git metadata only in the working directory ancestry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-agent-git-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const child = path.join(repository, "nested");
  const sibling = path.join(root, "plain");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  assert.equal(await hasGitMetadataAncestor(child), true);
  assert.equal(await hasGitMetadataAncestor(sibling), false);
});

test("serializes jobs for the same session and can cancel queued work", async () => {
  const runner = new FakeRunner();
  const queue = new AgentReplyQueue(runner, 2);
  const first = queue.enqueue({ chatId: "chat", inboundMessageId: "m1", session: codex, prompt: "one", policy: "planOnly" });
  const second = queue.enqueue({ chatId: "chat", inboundMessageId: "m2", session: codex, prompt: "two", policy: "planOnly" });
  const firstRejected = assert.rejects(first.completion);
  const secondRejected = assert.rejects(second.completion);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runner.started, ["one"]);
  assert.equal(queue.cancelForChat("chat"), 2);
  await firstRejected;
  await secondRejected;
});

test("extracts the actual Claude session id from stream-json output", () => {
  assert.equal(extractClaudeSessionId([
    '{"type":"system","session_id":"claude-session-1"}',
    '{"type":"result","session_id":"claude-session-1","result":"done"}'
  ].join("\n")), "claude-session-1");
  assert.equal(extractClaudeSessionId("plain diagnostics"), undefined);
});

test("extracts Codex turn ids and recognizes only the active-writer conflict", () => {
  assert.equal(extractCodexTurnId([
    '{"type":"turn.started","turn":{"id":"turn-remote"}}',
    '{"type":"turn.completed","turn_id":"turn-remote"}'
  ].join("\n")), "turn-remote");
  assert.equal(isCodexActiveWriterConflict("thread-store conflict: thread x already has an active writer"), true);
  assert.equal(isCodexActiveWriterConflict("Not inside a trusted directory"), false);
});

test("always creates a persistent managed fork before replying to an external Codex session", async () => {
  const source: AgentSession = {
    ...codex,
    ownership: "external",
    completionEvidence: "authoritative",
    name: "Source session"
  };
  let forkedCallback = "";
  let publicResumeSpawned = false;
  const managed: ManagedCodexExecutor = {
    forkThread: async (session, turnId) => ({
      ...session,
      sessionId: "forked-session",
      name: "Source session · 飞书",
      ownership: "managed",
      managedBackend: "codex-app-server",
      forkedFromSessionId: session.sessionId,
      forkedFromTurnId: turnId
    }),
    runTurn: async (session) => ({
      exitCode: 0,
      durationMs: 2,
      outputTail: "forked result",
      sessionId: session.sessionId,
      turnId: "fork-turn",
      backend: "codex-app-server"
    })
  };
  const runner = new AgentReplyRunner(
    10_000,
    (() => {
      publicResumeSpawned = true;
      throw new Error("external Codex resume must not be spawned");
    }) as unknown as typeof spawn,
    async () => "codex",
    managed,
    async (_job, session) => { forkedCallback = session.sessionId; }
  );
  const job: AgentReplyJob = {
    id: "job-fork",
    chatId: "chat",
    inboundMessageId: "inbound",
    session: { ...source },
    originalSession: { ...source },
    anchorTurnId: "source-turn",
    prompt: "continue",
    policy: "planOnly"
  };

  const result = await runner.run(job, new AbortController().signal);
  assert.equal(result.sessionId, "forked-session");
  assert.equal(result.turnId, "fork-turn");
  assert.equal(job.session.sessionId, "forked-session");
  assert.equal(forkedCallback, "forked-session");
  assert.equal(publicResumeSpawned, false);
});

test("adopts an external Codex session without changing its session id when the shared server is available", async () => {
  const source: AgentSession = {
    ...codex,
    sessionId: "shared-source",
    ownership: "external",
    completionEvidence: "authoritative"
  };
  let forkAttempted = false;
  let adoptedCallback = "";
  const managed: ManagedCodexExecutor = {
    adoptThread: async (session) => ({
      ...session,
      ownership: "managed",
      managedBackend: "codex-app-server"
    }),
    forkThread: async () => {
      forkAttempted = true;
      throw new Error("must not fork");
    },
    runTurn: async (session) => ({
      exitCode: 0,
      durationMs: 1,
      outputTail: "same session",
      sessionId: session.sessionId,
      turnId: "shared-turn",
      backend: "codex-app-server"
    })
  };
  const runner = new AgentReplyRunner(
    10_000,
    undefined,
    async () => "codex",
    managed,
    undefined,
    async (_job, session) => { adoptedCallback = session.sessionId; }
  );
  const job: AgentReplyJob = {
    id: "job-adopt",
    chatId: "chat",
    inboundMessageId: "inbound",
    session: { ...source },
    originalSession: { ...source },
    anchorTurnId: "source-turn",
    prompt: "continue",
    policy: "planOnly"
  };

  const result = await runner.run(job, new AbortController().signal);
  assert.equal(result.sessionId, "shared-source");
  assert.equal(job.session.sessionId, "shared-source");
  assert.equal(job.session.ownership, "managed");
  assert.equal(adoptedCallback, "shared-source");
  assert.equal(forkAttempted, false);
});

test("never forks or opens a second writer when a shared Codex delivery fails", async () => {
  const source: AgentSession = {
    ...codex,
    ownership: "managed",
    managedBackend: "codex-app-server",
    completionEvidence: "authoritative"
  };
  let forkAttempted = false;
  const managed: ManagedCodexExecutor = {
    forkThread: async () => {
      forkAttempted = true;
      throw new Error("must not fork");
    },
    runTurn: async () => {
      throw new Error("thread codex-session already has an active writer");
    }
  };
  const runner = new AgentReplyRunner(10_000, undefined, async () => "codex", managed);
  const job: AgentReplyJob = {
    id: "job-shared-conflict",
    chatId: "chat",
    inboundMessageId: "inbound",
    session: { ...source },
    originalSession: { ...source },
    anchorTurnId: "source-turn",
    prompt: "continue",
    policy: "inherit"
  };

  await assert.rejects(
    runner.run(job, new AbortController().signal),
    /already has an active writer/
  );
  assert.equal(forkAttempted, false);
  assert.equal(job.session.sessionId, source.sessionId);
});

test("rejects an external Codex reply without an exact turn anchor before opening the session", async () => {
  const source: AgentSession = {
    ...codex,
    ownership: "external",
    completionEvidence: "authoritative"
  };
  let forkAttempted = false;
  const managed: ManagedCodexExecutor = {
    forkThread: async () => {
      forkAttempted = true;
      throw new Error("must not be reached");
    },
    runTurn: async () => {
      throw new Error("must not be reached");
    }
  };
  const runner = new AgentReplyRunner(10_000, undefined, async () => "codex", managed);
  const job: AgentReplyJob = {
    id: "job-no-anchor",
    chatId: "chat",
    inboundMessageId: "inbound",
    session: { ...source },
    originalSession: { ...source },
    prompt: "continue",
    policy: "planOnly"
  };

  await assert.rejects(
    runner.run(job, new AbortController().signal),
    /必须引用包含精确 turnId/
  );
  assert.equal(forkAttempted, false);
  assert.equal(job.session.sessionId, source.sessionId);
});

test("forks an active external Claude session and persists the returned session id", async () => {
  const source: AgentSession = {
    ...codex,
    source: "claude-code",
    sessionId: "claude-source",
    name: "Claude source",
    ownership: "external",
    completionEvidence: "authoritative"
  };
  let callbackSession: AgentSession | undefined;
  let spawnedArgs: string[] = [];
  const runner = new AgentReplyRunner(
    10_000,
    successfulClaudeForkSpawn((args) => { spawnedArgs = args; }),
    async () => "claude",
    undefined,
    async (_job, session) => { callbackSession = session; }
  );
  const job: AgentReplyJob = {
    id: "job-claude-fork",
    chatId: "chat",
    inboundMessageId: "inbound",
    session: { ...source },
    originalSession: { ...source },
    anchorTurnId: "claude-source-turn",
    prompt: "continue",
    policy: "inherit"
  };

  assert.equal(shouldForkClaudeSession(job), true);

  const result = await runner.run(job, new AbortController().signal);

  assert.ok(spawnedArgs.includes("--fork-session"));
  assert.deepEqual(spawnedArgs.slice(0, 2), ["--resume", "claude-source"]);
  assert.equal(result.sessionId, "claude-remote-branch");
  assert.equal(job.session.sessionId, "claude-remote-branch");
  assert.equal(job.session.ownership, "managed");
  assert.equal(job.session.managedBackend, "claude-cli");
  assert.equal(callbackSession?.forkedFromSessionId, "claude-source");
  assert.equal(callbackSession?.forkedFromTurnId, "claude-source-turn");
});

function successfulClaudeForkSpawn(onSpawn: (args: string[]) => void): typeof spawn {
  return ((_executable: string, args: readonly string[]) => {
    onSpawn([...args]);
    const processEvents = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.once("finish", () => setImmediate(() => {
      stdout.write('{"type":"result","session_id":"claude-remote-branch","result":"done"}\n');
      processEvents.emit("close", 0);
    }));
    return Object.assign(processEvents, {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      pid: 5432
    }) as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
}
