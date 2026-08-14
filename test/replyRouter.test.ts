import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentReplyJob, AgentReplyQueue, AgentReplyResult, AgentReplyRunner } from "../src/agentReply";
import { ReplyRouter } from "../src/replyRouter";
import { SessionRegistry } from "../src/sessionRegistry";
import { AgentEvent, InboundReplyContext } from "../src/types";

class ImmediateRunner extends AgentReplyRunner {
  public readonly jobs: AgentReplyJob[] = [];
  public constructor(private readonly onRun?: () => void) {
    super();
  }
  public override async run(job: AgentReplyJob): Promise<AgentReplyResult> {
    this.onRun?.();
    this.jobs.push(job);
    return { exitCode: 0, durationMs: 1, outputTail: "" };
  }
}

const event: AgentEvent = {
  source: "codex",
  eventName: "Stop",
  status: "completed",
  sessionId: "session-router",
  turnId: "turn-router",
  cwd: process.cwd(),
  project: "notifier",
  message: "done",
  occurredAt: new Date().toISOString()
};

function inbound(overrides: Partial<InboundReplyContext> = {}): InboundReplyContext {
  return {
    messageId: `incoming-${Math.random()}`,
    parentMessageId: "outgoing-1",
    chatId: "chat-1",
    chatType: "p2p",
    senderOpenId: "ou_allowed",
    text: "continue",
    mentionedBot: false,
    ...overrides
  };
}

test("routes a quoted Feishu reply to the exact persisted Agent session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-router-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordDelivery(event, [{ messageId: "outgoing-1", chunkIndex: 1 }]);
  const runner = new ImmediateRunner();
  const queue = new AgentReplyQueue(runner);
  const replies: string[] = [];
  const router = new ReplyRouter({
    registry,
    queue,
    policy: () => "planOnly",
    refreshSessions: async () => undefined,
    reply: async (_message, text) => { replies.push(text); },
    status: () => "connected",
    defaultWorkspace: () => ({ cwd: process.cwd(), project: "notifier" })
  });
  await router.handle(inbound());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.jobs.length, 1);
  assert.equal(runner.jobs[0].session.sessionId, "session-router");
  assert.equal(runner.jobs[0].anchorTurnId, "turn-router");
  assert.equal(runner.jobs[0].prompt, "continue");
  assert.match(replies[0], /已接收/);
  assert.match(replies[0], /Codex\/notifier \(session-router\)/);
  assert.match(replies[0], new RegExp(`位置：${escapeRegExp(process.cwd())}`, "i"));
});

test("acknowledges an inbound reply before starting its Agent job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-router-ack-order-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordDelivery(event, [{ messageId: "outgoing-1", chunkIndex: 1 }]);
  const order: string[] = [];
  const runner = new ImmediateRunner(() => order.push("run"));
  const router = new ReplyRouter({
    registry,
    queue: new AgentReplyQueue(runner),
    policy: () => "planOnly",
    refreshSessions: async () => undefined,
    reply: async () => {
      order.push("ack");
      await new Promise((resolve) => setImmediate(resolve));
    },
    status: () => "connected",
    defaultWorkspace: () => ({ cwd: process.cwd(), project: "notifier" })
  });
  await router.handle(inbound({ messageId: "ack-order" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["ack", "run"]);
});

test("supports session listing, selection, aliases, status, and inbound deduplication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-router-commands-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordEvent(event);
  const replies: string[] = [];
  const runner = new ImmediateRunner();
  const router = new ReplyRouter({
    registry,
    queue: new AgentReplyQueue(runner),
    policy: () => "planOnly",
    refreshSessions: async () => undefined,
    reply: async (_message, text) => { replies.push(text); },
    status: () => "connected",
    defaultWorkspace: () => ({ cwd: process.cwd(), project: "notifier" })
  });
  await router.handle(inbound({ messageId: "list", parentMessageId: undefined, text: "/sessions" }));
  await router.handle(inbound({ messageId: "use", parentMessageId: undefined, text: "/use 1" }));
  await router.handle(inbound({ messageId: "alias", parentMessageId: undefined, text: "/alias primary" }));
  await router.handle(inbound({ messageId: "status", parentMessageId: undefined, text: "/status" }));
  await router.handle(inbound({ messageId: "status", parentMessageId: undefined, text: "/status" }));
  await router.handle(inbound({ messageId: "new", parentMessageId: undefined, text: "/new cc inspect tests" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies[0], /最近会话/);
  assert.match(replies[1], /已选择/);
  assert.equal((await registry.getSession("primary"))?.sessionId, "session-router");
  assert.equal(replies.filter((reply) => reply === "connected").length, 1);
  assert.equal(runner.jobs.at(-1)?.session.source, "claude-code");
  assert.match(runner.jobs.at(-1)?.session.sessionId ?? "", /^new:/);
});

test("shows project, authoritative title, full session id, and location separately", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-router-label-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordEvent({
    ...event,
    sessionId: "019ff39e-81a2-7da2-abdf-29e29a020275",
    cwd: "D:\\code\\git\\LEADER",
    project: "LEADER",
    sessionName: "实现 Codex Claude Code 手机通知"
  });
  await registry.recordMessageRoute("named-session", (await registry.getSession("019ff39e-81a2-7da2-abdf-29e29a020275"))!, "turn-router");
  const replies: string[] = [];
  const router = new ReplyRouter({
    registry,
    queue: new AgentReplyQueue(new ImmediateRunner()),
    policy: () => "inherit",
    refreshSessions: async () => undefined,
    reply: async (_message, text) => { replies.push(text); },
    status: () => "connected",
    defaultWorkspace: () => undefined
  });

  await router.handle(inbound({ parentMessageId: "named-session" }));
  assert.match(replies[0], /Codex\/LEADER · 实现 Codex Claude Code 手机通知 \(019ff39e-81a2-7da2-abdf-29e29a020275\)/);
  assert.match(replies[0], /位置：D:\\code\\git\\LEADER/);
});

test("rejects a file-discovered external session without an authoritative completion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-router-discovered-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordDiscoveredSessions([{
    source: "codex",
    sessionId: "discovered-only",
    cwd: process.cwd(),
    project: "notifier",
    lastSeenAt: new Date().toISOString(),
    status: "completed",
    ownership: "external",
    completionEvidence: "discovered"
  }]);
  const runner = new ImmediateRunner();
  const replies: string[] = [];
  const router = new ReplyRouter({
    registry,
    queue: new AgentReplyQueue(runner),
    policy: () => "planOnly",
    refreshSessions: async () => undefined,
    reply: async (_message, text) => { replies.push(text); },
    status: () => "connected",
    defaultWorkspace: () => ({ cwd: process.cwd(), project: "notifier" })
  });
  await router.handle(inbound({ messageId: "unsafe-send", parentMessageId: undefined, text: "/send discovered-only continue" }));
  assert.equal(runner.jobs.length, 0);
  assert.match(replies[0], /权威完成事件/);
});

test("creates Codex sessions through the managed-session factory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-router-managed-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  const runner = new ImmediateRunner();
  const replies: string[] = [];
  const router = new ReplyRouter({
    registry,
    queue: new AgentReplyQueue(runner),
    policy: () => "planOnly",
    refreshSessions: async () => undefined,
    reply: async (_message, text) => { replies.push(text); return "bot-managed"; },
    status: () => "connected",
    defaultWorkspace: () => ({ cwd: process.cwd(), project: "notifier" }),
    createManagedCodexSession: async (cwd, project) => registry.recordManagedSession({
      source: "codex",
      sessionId: "managed-thread",
      cwd,
      project,
      lastSeenAt: new Date().toISOString(),
      status: "completed",
      ownership: "managed",
      completionEvidence: "authoritative",
      managedBackend: "codex-app-server"
    })
  });
  await router.handle(inbound({ messageId: "new-managed", parentMessageId: undefined, text: "/new codex inspect tests" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.jobs[0].session.sessionId, "managed-thread");
  assert.equal(runner.jobs[0].session.ownership, "managed");
  assert.equal((await registry.resolveMessage("bot-managed"))?.sessionId, "managed-thread");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
