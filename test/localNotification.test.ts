import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLocalNotification,
  shouldShowLocalNotification,
  truncatePreview
} from "../src/localNotification";
import { AgentEvent } from "../src/types";

const event: AgentEvent = {
  source: "codex",
  eventName: "agent-turn-complete",
  status: "completed",
  sessionId: "session",
  turnId: "turn",
  cwd: "C:\\work\\project",
  project: "project",
  message: "第一行\n\n第二行 ✅",
  occurredAt: "2026-08-12T00:00:00.000Z"
};

test("selects local notifications from mode and focus state", () => {
  assert.equal(shouldShowLocalNotification("always", true), true);
  assert.equal(shouldShowLocalNotification("always", false), true);
  assert.equal(shouldShowLocalNotification("whenUnfocused", true), false);
  assert.equal(shouldShowLocalNotification("whenUnfocused", false), true);
  assert.equal(shouldShowLocalNotification("off", false), false);
});

test("formats a successful local notification with a compact preview", () => {
  const notification = formatLocalNotification(event, 100);
  assert.match(notification.title, /Codex 已完成 · project/);
  assert.equal(notification.preview, "第一行 第二行 ✅");
  assert.equal(notification.text, `${notification.title}\n${notification.preview}`);
});

test("formats failures and truncates Unicode without splitting code points", () => {
  const notification = formatLocalNotification({
    ...event,
    source: "claude-code",
    status: "failed",
    message: "🙂中文内容"
  }, 3);
  assert.match(notification.title, /Claude Code 执行失败/);
  assert.equal(notification.preview, "🙂中文…");
  assert.equal(Array.from(notification.preview.slice(0, -1)).length, 3);
});

test("can hide the local message preview", () => {
  assert.equal(truncatePreview(event.message, 0), "");
  assert.equal(formatLocalNotification(event, 0).text, formatLocalNotification(event, 0).title);
});
