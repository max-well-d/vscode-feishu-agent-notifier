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
