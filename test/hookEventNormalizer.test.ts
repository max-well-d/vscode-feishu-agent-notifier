import assert from "node:assert/strict";
import test from "node:test";
import { HookEventNormalizer } from "../src/hookEventNormalizer";

test("assembles Claude MessageDisplay batches into one assistant message", async () => {
  let observed = 0;
  const normalizer = new HookEventNormalizer("realtime", 0, () => { observed += 1; });
  const first = await normalizer.normalize({
    hook_event_name: "MessageDisplay",
    session_id: "session-1",
    turn_id: "turn-1",
    message_id: "message-1",
    cwd: "C:\\work\\project-a",
    index: 0,
    final: false,
    delta: "第一行\n"
  });
  const completed = await normalizer.normalize({
    hook_event_name: "MessageDisplay",
    session_id: "session-1",
    turn_id: "turn-1",
    message_id: "message-1",
    cwd: "C:\\work\\project-a",
    index: 1,
    final: true,
    delta: "第二行"
  });

  assert.equal(first, undefined);
  assert.equal(completed?.message, "第一行\n第二行");
  assert.equal(completed?.eventId, "message-1");
  assert.equal(completed?.origin, "display-hook");
  assert.equal(completed?.status, "progress");
  assert.equal(completed?.project, "project-a");
  assert.equal(observed, 1);
});

test("waits briefly for out-of-order MessageDisplay batches", async () => {
  const normalizer = new HookEventNormalizer("realtime", 20);
  const finalEvent = normalizer.normalize({
    hook_event_name: "MessageDisplay",
    session_id: "session-2",
    turn_id: "turn-2",
    message_id: "message-2",
    index: 1,
    final: true,
    delta: "后"
  });
  await normalizer.normalize({
    hook_event_name: "MessageDisplay",
    session_id: "session-2",
    turn_id: "turn-2",
    message_id: "message-2",
    index: 0,
    final: false,
    delta: "前"
  });

  assert.equal((await finalEvent)?.message, "前后");
});

test("ignores MessageDisplay in completion mode", async () => {
  const normalizer = new HookEventNormalizer("completion", 0);
  const event = await normalizer.normalize({
    hook_event_name: "MessageDisplay",
    session_id: "session-3",
    message_id: "message-3",
    index: 0,
    final: true,
    delta: "不应发送"
  });
  assert.equal(event, undefined);
});

test("keeps Stop normalization as the completion fallback", async () => {
  const normalizer = new HookEventNormalizer("realtime", 0);
  const event = await normalizer.normalize({
    __notifier_source: "claude-code",
    hook_event_name: "Stop",
    session_id: "session-4",
    last_assistant_message: "最终消息"
  });
  assert.equal(event?.status, "completed");
  assert.equal(event?.origin, "hook");
  assert.equal(event?.message, "最终消息");
});
