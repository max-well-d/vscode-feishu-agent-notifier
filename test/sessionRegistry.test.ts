import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionRegistry } from "../src/sessionRegistry";
import { AgentEvent } from "../src/types";

const event: AgentEvent = {
  source: "codex",
  eventName: "Stop",
  status: "completed",
  sessionId: "session-1",
  turnId: "turn-1",
  cwd: "D:\\work\\demo",
  project: "demo",
  message: "done",
  occurredAt: "2026-08-13T00:00:00.000Z"
};

test("persists message routes, chat selection, aliases, and inbound deduplication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-"));
  const file = path.join(root, "registry.json");
  const registry = new SessionRegistry(file, { now: () => new Date("2026-08-13T01:00:00.000Z") });
  await registry.recordDelivery(event, [{ messageId: "om_1", chatId: "oc_1", chunkIndex: 1 }]);
  const resolved = await registry.resolveMessage("om_1");
  assert.equal(resolved?.sessionId, "session-1");
  const stored = JSON.parse(await fs.readFile(file, "utf8")) as {
    version: number;
    messages: Record<string, { kind?: string; eventStatus?: string }>;
  };
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.messages.om_1, {
    sessionKey: "codex:session-1",
    createdAt: "2026-08-13T01:00:00.000Z",
    kind: "agent-event",
    eventStatus: "completed"
  });
  assert.equal(await registry.claimInbound("incoming-1"), true);
  assert.equal(await registry.claimInbound("incoming-1"), false);
  await registry.setAlias(resolved!, "leader");
  assert.equal((await registry.getSession("leader"))?.sessionId, "session-1");
  await registry.selectForChat("oc_chat", resolved!);

  const reloaded = new SessionRegistry(file);
  assert.equal((await reloaded.selectedForChat("oc_chat"))?.alias, "leader");
});

test("updates a recently discovered active session to idle without changing mtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-status-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  const session = {
    source: "claude-code" as const,
    sessionId: "session-2",
    cwd: "/work/demo",
    project: "demo",
    lastSeenAt: "2026-08-13T00:00:00.000Z",
    status: "progress" as const
  };
  await registry.recordDiscoveredSessions([session]);
  await registry.recordDiscoveredSessions([{ ...session, status: "completed" }]);
  assert.equal((await registry.getSession("session-2"))?.status, "completed");
});

test("does not let transcript mtime override an authoritative active state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-authoritative-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordEvent({ ...event, sessionId: "session-active", status: "progress", eventName: "assistant" });
  await registry.recordDiscoveredSessions([{
    source: "codex",
    sessionId: "session-active",
    cwd: event.cwd,
    project: event.project,
    lastSeenAt: "2026-08-13T02:00:00.000Z",
    status: "completed",
    ownership: "external",
    completionEvidence: "discovered"
  }]);
  const session = await registry.getSession("session-active");
  assert.equal(session?.status, "progress");
  assert.equal(session?.completionEvidence, "authoritative");
});

test("treats newer transcript activity after completion as active until the next completion event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-new-turn-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  await registry.recordEvent({ ...event, sessionId: "session-new-turn", status: "completed" });
  await registry.recordDiscoveredSessions([{
    source: "codex",
    sessionId: "session-new-turn",
    cwd: event.cwd,
    project: event.project,
    lastSeenAt: "2026-08-13T00:00:02.000Z",
    status: "completed",
    ownership: "external",
    completionEvidence: "discovered"
  }]);
  assert.equal((await registry.getSession("session-new-turn"))?.status, "progress");
});

test("migrates bot message routes when a managed CLI reveals its real session id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-migrate-"));
  const registry = new SessionRegistry(path.join(root, "registry.json"));
  const provisional = await registry.recordManagedSession({
    source: "claude-code",
    sessionId: "new:temporary",
    cwd: event.cwd,
    project: event.project,
    lastSeenAt: event.occurredAt,
    status: "progress",
    managedBackend: "claude-cli"
  });
  await registry.recordMessageRoute("bot-start", provisional);
  await registry.selectForChat("oc_chat", provisional);
  await registry.updateExecutionState(provisional, "completed", "claude-real-session");
  assert.equal((await registry.resolveMessage("bot-start"))?.sessionId, "claude-real-session");
  assert.equal((await registry.selectedForChat("oc_chat"))?.sessionId, "claude-real-session");
});

test("migrates a pre-0.13 quoted completion route as authoritative evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-v1-"));
  const file = path.join(root, "registry.json");
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    sessions: {
      "codex:legacy-complete": {
        source: "codex",
        sessionId: "legacy-complete",
        cwd: event.cwd,
        project: event.project,
        lastSeenAt: "2026-08-13T02:11:35.100Z",
        status: "completed"
      },
      "codex:disk-only": {
        source: "codex",
        sessionId: "disk-only",
        cwd: event.cwd,
        project: event.project,
        lastSeenAt: "2026-08-13T02:11:35.100Z",
        status: "completed"
      }
    },
    messages: {
      "om_legacy_completion": {
        sessionKey: "codex:legacy-complete",
        createdAt: "2026-08-13T02:11:35.800Z"
      }
    },
    chatSelections: {},
    processedInbound: {}
  }), "utf8");

  const registry = new SessionRegistry(file);
  assert.equal((await registry.resolveMessage("om_legacy_completion"))?.completionEvidence, "authoritative");
  assert.equal((await registry.getSession("disk-only"))?.completionEvidence, "discovered");
  await registry.cleanup();
  const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { version: number };
  assert.equal(persisted.version, 2);
});

test("does not upgrade a stale legacy progress route into completion evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-registry-v1-stale-"));
  const file = path.join(root, "registry.json");
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    sessions: {
      "codex:legacy-stale": {
        source: "codex",
        sessionId: "legacy-stale",
        cwd: event.cwd,
        project: event.project,
        lastSeenAt: "2026-08-13T02:15:00.000Z",
        status: "completed"
      }
    },
    messages: {
      "om_old_progress": {
        sessionKey: "codex:legacy-stale",
        createdAt: "2026-08-13T02:11:35.800Z"
      }
    },
    chatSelections: {},
    processedInbound: {}
  }), "utf8");

  const registry = new SessionRegistry(file);
  assert.equal((await registry.resolveMessage("om_old_progress"))?.completionEvidence, "discovered");
});
