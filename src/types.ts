export type DeliveryMode = "webhook" | "app";
export type ReceiveIdType = "open_id" | "user_id" | "email" | "chat_id";
export type MessageFormat = "card" | "text";
export type DeliveryTiming = "realtime" | "completion";

export interface AgentEvent {
  source: "codex" | "claude-code" | "unknown";
  eventName: string;
  status: "progress" | "completed" | "failed";
  eventId?: string;
  origin?: "transcript" | "hook" | "display-hook";
  sessionId: string;
  turnId: string;
  cwd: string;
  project: string;
  message: string;
  occurredAt: string;
}

export interface NotifierConfig {
  deliveryMode: DeliveryMode;
  webhookUrl: string;
  webhookSecret: string;
  appId: string;
  appSecret: string;
  receiveIdType: ReceiveIdType;
  receiveId: string;
  messageFormat: MessageFormat;
  includeMetadata: boolean;
  maxChunkCharacters: number;
  notifyOnFailure: boolean;
  deliveryMaxAttempts: number;
  retryBaseDelayMs: number;
}

export interface HookCommand {
  type: "command";
  command: string;
  commandWindows?: string;
  args?: string[];
  async: boolean;
  timeout: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksDocument {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}
