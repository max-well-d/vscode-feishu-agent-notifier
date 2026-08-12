import assert from "node:assert/strict";
import test from "node:test";
import { AgentReplyJob, AgentReplyQueue, AgentReplyResult, AgentReplyRunner, buildAgentCommand, extractClaudeSessionId } from "../src/agentReply";
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
