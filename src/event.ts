import path from "node:path";
import { AgentEvent } from "./types";

type UnknownRecord = Record<string, unknown>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeAgentEvent(input: UnknownRecord): AgentEvent {
  const codexNotify = input.type === "agent-turn-complete";
  const sourceHint = stringValue(input.__notifier_source);
  const source = codexNotify || sourceHint === "codex"
    ? "codex"
    : sourceHint === "claude-code" || typeof input.hook_event_name === "string"
      ? "claude-code"
      : "unknown";

  const eventName = stringValue(input.type)
    || stringValue(input.hook_event_name)
    || "Stop";
  const failed = eventName === "StopFailure"
    || stringValue(input.error).length > 0;
  const cwd = stringValue(input.cwd);

  const message = stringValue(input["last-assistant-message"])
    || stringValue(input.last_assistant_message)
    || stringValue(input.message)
    || (failed ? "Agent 在完成回复前失败。" : "Agent 已结束，但没有提供最终回复内容。");

  return {
    source,
    eventName,
    status: failed ? "failed" : "completed",
    origin: codexNotify ? "notify" : "hook",
    channelId: stringValue(input.__notifier_channel_id) || undefined,
    managedBackend: managedBackend(input.__notifier_bridge_backend),
    sessionId: stringValue(input["thread-id"]) || stringValue(input.session_id),
    turnId: stringValue(input["turn-id"]) || stringValue(input.turn_id) || stringValue(input.prompt_id),
    cwd,
    project: projectNameFromCwd(cwd),
    message,
    occurredAt: new Date().toISOString()
  };
}

function managedBackend(value: unknown): AgentEvent["managedBackend"] {
  return value === "codex-app-server" || value === "claude-channel" ? value : undefined;
}

export function projectNameFromCwd(cwd: string): string {
  if (!cwd) {
    return "unknown-project";
  }
  const withoutTrailingSeparators = cwd.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators.includes("\\")
    ? path.win32.basename(withoutTrailingSeparators)
    : path.posix.basename(withoutTrailingSeparators);
}

export function eventBelongsToWorkspace(cwd: string, workspaceRoots: string[]): boolean {
  if (!cwd) {
    return false;
  }
  return workspaceRoots.some((root) => isPathInside(cwd, root));
}

export function eventDeduplicationKey(event: AgentEvent): string {
  return event.eventId
    ? [event.source, event.sessionId, event.eventId].join(":")
    : [event.source, event.sessionId, event.turnId, event.eventName].join(":");
}

export function isCrossOriginDuplicate(
  previousOrigin: AgentEvent["origin"],
  currentOrigin: AgentEvent["origin"]
): boolean {
  return Boolean(previousOrigin && currentOrigin && previousOrigin !== currentOrigin);
}

export function formatEventMessage(event: AgentEvent, includeMetadata: boolean): string {
  if (!includeMetadata) {
    return event.message;
  }

  const source = event.source === "claude-code"
    ? "Claude Code"
    : event.source === "codex"
      ? "Codex"
      : "Agent";
  const status = event.status === "failed"
    ? "❌ 执行失败"
    : event.status === "progress"
      ? "💬 实时消息"
      : "✅ 已完成";
  const metadata = [
    `工具：${source}`,
    `会话：${event.sessionName || event.project}`,
    `Session ID：${event.sessionId || "未知"}`,
    `项目：${event.project}`,
    `状态：${status}`,
    `输入来源：${event.inputOrigin === "local" ? "本机客户端" : event.inputOrigin === "feishu" ? "飞书远程" : event.inputOrigin?.startsWith("channel:") ? `远程 ${event.inputOrigin.slice(8)}` : "未标记"}`,
    `时间：${new Date(event.occurredAt).toLocaleString("zh-CN", { hour12: false })}`
  ];

  return `${metadata.join("\n")}\n\n${event.message}`;
}

export function splitMessage(message: string, maximumCharacters: number): string[] {
  const limit = Math.max(1, maximumCharacters);
  const codePoints = Array.from(message);
  if (codePoints.length <= limit) {
    return [message];
  }

  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += limit) {
    chunks.push(codePoints.slice(index, index + limit).join(""));
  }
  return chunks;
}

export function addChunkLabels(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }
  return chunks.map((chunk, index) => `【${index + 1}/${chunks.length}】\n${chunk}`);
}

function isPathInside(candidate: string, root: string): boolean {
  const windows = /^[a-zA-Z]:[\\/]/.test(candidate) || /^[a-zA-Z]:[\\/]/.test(root);
  const pathApi = windows ? path.win32 : path.posix;
  const resolvedCandidate = pathApi.resolve(candidate);
  const resolvedRoot = pathApi.resolve(root);
  const normalizedCandidate = windows ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const normalizedRoot = windows ? resolvedRoot.toLowerCase() : resolvedRoot;
  const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}
