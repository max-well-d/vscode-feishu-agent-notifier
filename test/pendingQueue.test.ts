import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drainPendingEvents, listPendingEvents, pendingEventCount } from "../src/pendingQueue";

test("lists and drains queued Agent events in file-name order", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-pending-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const event = {
    __notifier_source: "codex",
    type: "agent-turn-complete",
    "thread-id": "session-1",
    "turn-id": "turn-1",
    cwd: root,
    "last-assistant-message": "完整离线回复"
  };
  await fs.writeFile(path.join(root, "001.json"), JSON.stringify({
    event,
    queuedAt: "2026-08-12T00:00:00.000Z",
    lastError: "ECONNREFUSED"
  }), "utf8");

  const listed = await listPendingEvents(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].event.message, "完整离线回复");
  assert.equal(listed[0].event.source, "codex");

  const delivered: string[] = [];
  const result = await drainPendingEvents(root, async (queued) => {
    delivered.push(queued.message);
  });
  assert.deepEqual(delivered, ["完整离线回复"]);
  assert.deepEqual(result, { delivered: 1, invalid: 0, remaining: 0 });
  assert.equal(await pendingEventCount(root), 0);
});

test("keeps queued events when delivery fails", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-pending-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "001.json"), JSON.stringify({
    event: {
      __notifier_source: "claude-code",
      hook_event_name: "Stop",
      last_assistant_message: "稍后重试"
    }
  }), "utf8");

  const result = await drainPendingEvents(root, async () => {
    throw new Error("temporary failure");
  });
  assert.equal(result.delivered, 0);
  assert.equal(result.remaining, 1);
});

test("defers paused-workspace events without blocking other queued projects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-pending-defer-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  for (const [name, cwd, message] of [
    ["001.json", "/work/paused", "保留"],
    ["002.json", "/work/active", "发送"]
  ]) {
    await fs.writeFile(path.join(root, name), JSON.stringify({
      event: {
        __notifier_source: "codex",
        type: "agent-turn-complete",
        cwd,
        "last-assistant-message": message
      }
    }), "utf8");
  }

  const delivered: string[] = [];
  const result = await drainPendingEvents(
    root,
    async (event) => { delivered.push(event.message); },
    () => undefined,
    (event) => event.cwd === "/work/paused"
  );
  assert.deepEqual(delivered, ["发送"]);
  assert.equal(result.delivered, 1);
  assert.equal(result.remaining, 1);
});
