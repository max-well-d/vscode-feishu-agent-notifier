import path from "node:path";
import { AgentEvent, NotifierConfig } from "./types";

export type ProjectDestinations = Record<string, string>;

export function resolveProjectDestination(
  config: NotifierConfig,
  event: AgentEvent,
  destinations: ProjectDestinations
): NotifierConfig {
  if (config.deliveryMode !== "app") {
    return config;
  }
  const normalizedCwd = normalizePath(event.cwd);
  for (const [selector, receiveId] of Object.entries(destinations)) {
    if (!receiveId.trim()) {
      continue;
    }
    const normalizedSelector = normalizePath(selector);
    if (selector.toLocaleLowerCase() === event.project.toLocaleLowerCase()
      || normalizedSelector === normalizedCwd
      || path.basename(normalizedCwd).toLocaleLowerCase() === selector.toLocaleLowerCase()) {
      return { ...config, receiveIdType: "chat_id", receiveId: receiveId.trim() };
    }
  }
  return config;
}

function normalizePath(value: string): string {
  return path.resolve(value || ".").replace(/[\\/]+$/, "").toLocaleLowerCase();
}
