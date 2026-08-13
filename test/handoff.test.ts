import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTurn,
  initialHandoffState,
  markLocalActivity,
  requestRemoteTurn,
  restoreHandoffState,
  startTurn
} from "../src/handoff";

test("local typing pauses remote input and exposes local priority", () => {
  const now = new Date("2026-08-13T00:00:00.000Z");
  const local = markLocalActivity(initialHandoffState("thread-1", now), 15_000, now);
  const decision = requestRemoteTurn(local, new Date(now.getTime() + 2_000));
  assert.equal(decision.action, "queue");
  assert.equal(decision.label, "本地优先");
  assert.equal(decision.state.queuedRemoteCount, 1);
});

test("idle session can be taken over remotely and records input origin", () => {
  const state = initialHandoffState("thread-1");
  const decision = requestRemoteTurn(state);
  assert.equal(decision.action, "start");
  assert.equal(decision.label, "远程接管");
  const running = startTurn(decision.state, "feishu", "turn-1");
  assert.equal(running.inputOrigin, "feishu");
  assert.equal(running.authority, "remote");
  assert.equal(completeTurn(running).turnState, "idle");
});

test("broker restart never claims a persisted running turn is still live", () => {
  const running = startTurn(initialHandoffState("thread-1"), "local", "turn-1");
  const restored = restoreHandoffState(running);
  assert.equal(restored.turnState, "unknown");
  assert.equal(restored.activeTurnId, undefined);
  assert.equal(requestRemoteTurn(restored).action, "queue");
});

test("a second remote turn queues behind the active remote turn", () => {
  const first = startTurn(initialHandoffState("thread-1"), "feishu", "turn-1");
  const second = requestRemoteTurn(first);
  assert.equal(second.action, "queue");
  assert.equal(second.label, "远程接管");
  assert.equal(second.state.queuedRemoteCount, 1);
});
