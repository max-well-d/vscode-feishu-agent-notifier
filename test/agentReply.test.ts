import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AgentReplyJob, AgentReplyQueue, AgentReplyResult, AgentReplyRunner, buildAgentCommand, extractClaudeSessionId, extractCodexTurnId, hasGitMetadataAncestor, isCodexActiveWriterConflict, ManagedCodexExecutor } from "../src/agentReply";
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

test("falls back to a persistent managed fork when Codex reports an active writer", async () => {
  const source: AgentSession = {
    ...codex,
    ownership: "external",
    completionEvidence: "authoritative",
    name: "Source session"
  };
  let forkedCallback = "";
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
    activeWriterSpawn(),
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
});

function activeWriterSpawn(): typeof spawn {
  return (() => {
    const processEvents = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.once("finish", () => setImmediate(() => {
      stderr.write("thread-store conflict: thread codex-session already has an active writer");
      processEvents.emit("close", 1);
    }));
    return Object.assign(processEvents, {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      pid: 4321
    }) as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
}
