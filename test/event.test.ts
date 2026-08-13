import assert from "node:assert/strict";
import test from "node:test";
import {
  isCrossOriginDuplicate,
  shouldSuppressCrossOriginDuplicate,
  eventBelongsToWorkspace,
  normalizeAgentEvent,
  projectNameFromCwd,
  splitMessage
} from "../src/event";

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
  assert.equal(event.origin, "hook");
  assert.equal(event.project, "project-a");
  assert.equal(event.message, fullMessage);
  assert.equal(event.status, "completed");
});

test("marks hook events emitted by a process bridge as managed sessions", () => {
  const event = normalizeAgentEvent({
    __notifier_source: "claude-code",
    __notifier_channel_id: "channel-1",
    __notifier_bridge_backend: "claude-channel",
    hook_event_name: "Stop",
    session_id: "claude-shared",
    cwd: "C:\\work\\project-a",
    last_assistant_message: "done"
  });
  assert.equal(event.channelId, "channel-1");
  assert.equal(event.managedBackend, "claude-channel");
});

test("distinguishes legacy Codex notify from official Stop hooks", () => {
  const event = normalizeAgentEvent({
    __notifier_source: "codex",
    type: "agent-turn-complete",
    "thread-id": "session-1",
    "turn-id": "turn-1",
    "last-assistant-message": "相同最终回复"
  });
  assert.equal(event.origin, "notify");
  assert.equal(isCrossOriginDuplicate("hook", event.origin), true);
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

test("extracts project names across Windows and POSIX path formats", () => {
  assert.equal(projectNameFromCwd("C:\\work\\project-a\\"), "project-a");
  assert.equal(projectNameFromCwd("/work/project-b/"), "project-b");
  assert.equal(projectNameFromCwd(""), "unknown-project");
});

test("matches event working directories to workspace roots safely", () => {
  assert.equal(eventBelongsToWorkspace("C:\\work\\project-a\\src", ["C:\\work\\project-a"]), true);
  assert.equal(eventBelongsToWorkspace("c:\\WORK\\project-a", ["C:\\work\\project-a"]), true);
  assert.equal(eventBelongsToWorkspace("C:\\work\\project-ab", ["C:\\work\\project-a"]), false);
  assert.equal(eventBelongsToWorkspace("/work/project-a/src", ["/work/project-a"]), true);
  assert.equal(eventBelongsToWorkspace("/work/project-b", ["/work/project-a"]), false);
  assert.equal(eventBelongsToWorkspace("", ["/work/project-a"]), false);
});

test("deduplicates matching bodies only across different capture origins", () => {
  assert.equal(isCrossOriginDuplicate("transcript", "hook"), true);
  assert.equal(isCrossOriginDuplicate("hook", "transcript"), true);
  assert.equal(isCrossOriginDuplicate("display-hook", "hook"), true);
  assert.equal(isCrossOriginDuplicate("display-hook", "transcript"), true);
  assert.equal(isCrossOriginDuplicate("transcript", "transcript"), false);
  assert.equal(isCrossOriginDuplicate("hook", "hook"), false);
  assert.equal(isCrossOriginDuplicate("display-hook", "display-hook"), false);
});

test("terminal Hook events upgrade realtime messages instead of being deduplicated", () => {
  assert.equal(shouldSuppressCrossOriginDuplicate(
    { origin: "display-hook", status: "progress" },
    { origin: "hook", status: "completed" }
  ), false);
  assert.equal(shouldSuppressCrossOriginDuplicate(
    { origin: "hook", status: "completed" },
    { origin: "transcript", status: "progress" }
  ), true);
  assert.equal(shouldSuppressCrossOriginDuplicate(
    { origin: "notify", status: "completed" },
    { origin: "hook", status: "completed" }
  ), true);
});
