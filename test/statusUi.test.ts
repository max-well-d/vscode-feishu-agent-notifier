import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusPresentation, StatusSnapshot } from "../src/statusUi";

const ready: StatusSnapshot = {
  initializing: false,
  enabled: true,
  workspacePaused: false,
  receiverPort: 37561,
  configurationOk: true,
  hooksOk: true,
  deliveryTiming: "realtime",
  deliveryMode: "webhook",
  pendingCount: 0,
  activeDeliveries: 0,
  codexHookOk: true,
  codexNotifyOk: true,
  codexStopHookOk: true,
  codexVersion: "0.147.0",
  codexStopHookSupported: true,
  claudeHookOk: true,
  claudeVersion: "2.1.166",
  claudeMessageDisplaySupported: true,
  claudeSource: "message-display"
};

test("renders a compact realtime-ready state", () => {
  const status = buildStatusPresentation(ready);
  assert.equal(status.text, "$(radio-tower) 飞书 · 实时");
  assert.equal(status.severity, "normal");
  assert.ok(status.details.includes("Claude Code：2.1.166，MessageDisplay"));
  assert.ok(status.details.includes("Codex：0.147.0，Stop Hook 已配置，notify 回退已配置"));
});

test("prioritizes pause, receiver, delivery, configuration, and queue problems", () => {
  assert.match(buildStatusPresentation({ ...ready, workspacePaused: true }).text, /已暂停/);
  assert.equal(buildStatusPresentation({ ...ready, receiverPort: undefined }).severity, "error");
  assert.match(buildStatusPresentation({ ...ready, lastDeliveryError: "HTTP 500" }).text, /投递失败/);
  assert.match(buildStatusPresentation({ ...ready, configurationOk: false }).text, /需要配置/);
  assert.match(buildStatusPresentation({ ...ready, hooksOk: false }).text, /需要修复/);
  assert.match(buildStatusPresentation({ ...ready, pendingCount: 3 }).text, /待处理 3/);
  assert.equal(buildStatusPresentation({ ...ready, receiverConflict: true }).severity, "error");
  assert.match(
    buildStatusPresentation({ ...ready, receiverStandby: true }).details.join("\n"),
    /其他窗口接收/
  );
});

test("shows transient sending and completion-only states", () => {
  assert.match(buildStatusPresentation({ ...ready, activeDeliveries: 1 }).text, /发送中/);
  assert.match(buildStatusPresentation({ ...ready, hooksOk: false, activeDeliveries: 1 }).text, /发送中/);
  assert.match(buildStatusPresentation({ ...ready, deliveryTiming: "completion" }).text, /仅结束/);
});
