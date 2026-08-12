import { DeliveryMode, DeliveryTiming } from "./types";

export interface StatusSnapshot {
  initializing: boolean;
  enabled: boolean;
  workspacePaused: boolean;
  receiverPort?: number;
  receiverStandby?: boolean;
  receiverConflict?: boolean;
  configurationOk: boolean;
  hooksOk?: boolean;
  deliveryTiming: DeliveryTiming;
  deliveryMode: DeliveryMode;
  pendingCount: number;
  activeDeliveries: number;
  codexHookOk?: boolean;
  codexNotifyOk?: boolean;
  codexStopHookOk?: boolean;
  codexVersion?: string;
  codexStopHookSupported?: boolean;
  claudeHookOk?: boolean;
  claudeVersion?: string;
  claudeMessageDisplaySupported?: boolean;
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
  if (snapshot.receiverConflict) {
    return presentation("$(error) 飞书 · 端口冲突", "error", "本地端口被其他配置或进程占用", details);
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
    `本地接收器：${receiverDetail(snapshot)}`,
    `Codex：${codexDetail(snapshot)}`,
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

function receiverDetail(snapshot: StatusSnapshot): string {
  if (!snapshot.receiverPort) {
    return snapshot.receiverConflict ? "端口冲突" : "未运行";
  }
  return snapshot.receiverStandby
    ? `127.0.0.1:${snapshot.receiverPort}（其他窗口接收，本窗口待命）`
    : `127.0.0.1:${snapshot.receiverPort}（本窗口接收）`;
}

function codexDetail(snapshot: StatusSnapshot): string {
  const version = snapshot.codexVersion ? ` ${snapshot.codexVersion}` : "";
  const stop = snapshot.codexStopHookOk
    ? "Stop Hook 已配置"
    : snapshot.codexStopHookSupported === false
      ? "Stop Hook 不受支持"
      : "Stop Hook 未配置";
  const notify = snapshot.codexNotifyOk ? "notify 回退已配置" : "notify 回退未配置";
  return `${version.trim() || "版本未知"}，${stop}，${notify}`;
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
  const version = snapshot.claudeVersion ? ` ${snapshot.claudeVersion}` : "";
  if (snapshot.claudeSource === "message-display") {
    return `${version.trim() || "版本未知"}，MessageDisplay`;
  }
  if (snapshot.claudeSource === "probing") {
    return `${version.trim() || "版本未知"}，MessageDisplay 等待首个事件，transcript 待命`;
  }
  if (snapshot.claudeSource === "transcript") {
    const reason = snapshot.claudeMessageDisplaySupported === false ? "版本暂不支持 MessageDisplay" : "兼容模式";
    return `${version.trim() || "版本未知"}，transcript（${reason}）`;
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
