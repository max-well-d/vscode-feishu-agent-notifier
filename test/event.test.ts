import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentEvent, splitMessage } from "../src/event";

test("normalizes a Codex Stop event without truncating the final message", () => {
  const fullMessage = "第一行\n" + "完整内容🙂".repeat(5000);
  const event = normalizeAgentEvent({
    __notifier_source: "codex",
    hook_event_name: "Stop",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "C:\\work\\project-a",
    last_assistant_message: fullMessage
  });

  assert.equal(event.source, "codex");
  assert.equal(event.project, "project-a");
  assert.equal(event.message, fullMessage);
  assert.equal(event.status, "completed");
});

test("normalizes Claude Code StopFailure", () => {
  const event = normalizeAgentEvent({
    __notifier_source: "claude-code",
    hook_event_name: "StopFailure",
    session_id: "claude-session",
    error: "rate_limit",
    last_assistant_message: "API Error: rate limit"
  });

  assert.equal(event.source, "claude-code");
  assert.equal(event.status, "failed");
  assert.equal(event.message, "API Error: rate limit");
});

test("splits Unicode text and preserves every code point", () => {
  const message = "A🙂中".repeat(7000);
  const chunks = splitMessage(message, 12000);
  assert.equal(chunks.join(""), message);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 12000));
});
