import { DeliveryMode, DeliveryTiming } from "./types";

export interface StatusSnapshot {
  initializing: boolean;
  enabled: boolean;
  workspacePaused: boolean;
  receiverPort?: number;
  configurationOk: boolean;
  hooksOk?: boolean;
  deliveryTiming: DeliveryTiming;
  deliveryMode: DeliveryMode;
  pendingCount: number;
  activeDeliveries: number;
  codexHookOk?: boolean;
  claudeHookOk?: boolean;
  claudeSource?: "message-display" | "transcript" | "probing";
  lastDeliverySuccess?: string;
  lastDeliveryError?: string;
}

export interface StatusPresentation {
  text: string;
  severity: "normal" | "warning" | "error";
  summary: string;
  details: string[];
}

export function buildStatusPresentation(snapshot: StatusSnapshot): StatusPresentation {
  const details = buildDetails(snapshot);
  if (snapshot.initializing) {
    return presentation("$(loading~spin) 飞书 · 启动中", "normal", "正在启动通知接收器", details);
  }
  if (!snapshot.enabled) {
    return presentation("$(bell-slash) 飞书 · 已禁用", "normal", "通知功能已禁用", details);
  }
  if (snapshot.workspacePaused) {
    return presentation("$(debug-pause) 飞书 · 当前项目已暂停", "warning", "当前工作区不会发送 Agent 通知", details);
  }
  if (!snapshot.receiverPort) {
    return presentation("$(error) 飞书 · 接收器异常", "error", "本地通知接收器未运行", details);
  }
  if (snapshot.lastDeliveryError) {
    return presentation("$(error) 飞书 · 投递失败", "error", "最近一次飞书投递失败", details);
  }
  if (!snapshot.configurationOk) {
    return presentation("$(gear) 飞书 · 需要配置", "warning", "飞书凭据或目标配置不完整", details);
  }
  if (snapshot.activeDeliveries > 0) {
    return presentation("$(sync~spin) 飞书 · 发送中", "normal", "正在发送飞书通知", details);
  }
  if (snapshot.hooksOk === false) {
    return presentation("$(tools) 飞书 · 需要修复", "warning", "Codex 或 Claude Code 通知接入不完整", details);
  }
  if (snapshot.pendingCount > 0) {
    return presentation(
      `$(warning) 飞书 · 待处理 ${snapshot.pendingCount}`,
      "warning",
      `有 ${snapshot.pendingCount} 条通知等待重试`,
      details
    );
  }
  return snapshot.deliveryTiming === "realtime"
    ? presentation("$(radio-tower) 飞书 · 实时", "normal", "实时逐条通知已就绪", details)
    : presentation("$(bell) 飞书 · 仅结束", "normal", "任务结束通知已就绪", details);
}

function buildDetails(snapshot: StatusSnapshot): string[] {
  const details = [
    `投递时机：${snapshot.deliveryTiming === "realtime" ? "实时逐条" : "仅任务结束"}`,
    `飞书模式：${snapshot.deliveryMode === "webhook" ? "群机器人 Webhook" : "自建应用机器人"}`,
    `本地接收器：${snapshot.receiverPort ? `127.0.0.1:${snapshot.receiverPort}` : "未运行"}`,
    `Codex notify：${statusWord(snapshot.codexHookOk)}`,
    `Claude Code：${claudeDetail(snapshot)}`,
    `待处理通知：${snapshot.pendingCount}`
  ];
  if (snapshot.lastDeliverySuccess) {
    details.push(`最近成功：${formatTime(snapshot.lastDeliverySuccess)}`);
  }
  if (snapshot.lastDeliveryError) {
    details.push(`最近错误：${compact(snapshot.lastDeliveryError, 180)}`);
  }
  return details;
}

function presentation(
  text: string,
  severity: StatusPresentation["severity"],
  summary: string,
  details: string[]
): StatusPresentation {
  return { text, severity, summary, details };
}

function statusWord(value: boolean | undefined): string {
  return value === true ? "正常" : value === false ? "未安装" : "未检查";
}

function claudeDetail(snapshot: StatusSnapshot): string {
  if (snapshot.claudeSource === "message-display") {
    return "MessageDisplay";
  }
  if (snapshot.claudeSource === "probing") {
    return "MessageDisplay 等待首个事件，transcript 待命";
  }
  if (snapshot.claudeSource === "transcript") {
    return "transcript 兼容模式";
  }
  return statusWord(snapshot.claudeHookOk);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return Array.from(normalized).length <= limit
    ? normalized
    : `${Array.from(normalized).slice(0, limit - 1).join("")}…`;
}
