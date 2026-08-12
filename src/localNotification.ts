import { AgentEvent } from "./types";

export type LocalNotificationMode = "always" | "whenUnfocused" | "off";

export interface LocalNotificationContent {
  title: string;
  preview: string;
  text: string;
}

export function shouldShowLocalNotification(
  mode: LocalNotificationMode,
  windowFocused: boolean
): boolean {
  return mode === "always" || (mode === "whenUnfocused" && !windowFocused);
}

export function formatLocalNotification(
  event: AgentEvent,
  maximumPreviewCharacters: number
): LocalNotificationContent {
  const source = event.source === "claude-code"
    ? "Claude Code"
    : event.source === "codex"
      ? "Codex"
      : "Agent";
  const status = event.status === "failed" ? "执行失败" : "已完成";
  const icon = event.status === "failed" ? "❌" : "✅";
  const title = `${icon} ${source} ${status} · ${event.project}`;
  const preview = truncatePreview(event.message, maximumPreviewCharacters);
  return {
    title,
    preview,
    text: preview ? `${title}\n${preview}` : title
  };
}

export function truncatePreview(message: string, maximumCharacters: number): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const limit = Math.max(0, maximumCharacters);
  if (limit === 0) {
    return "";
  }
  const codePoints = Array.from(normalized);
  return codePoints.length <= limit
    ? normalized
    : `${codePoints.slice(0, limit).join("")}…`;
}
