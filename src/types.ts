export type DeliveryMode = "webhook" | "app";
export type ReceiveIdType = "open_id" | "user_id" | "email" | "chat_id";
export type MessageFormat = "card" | "text";
export type DeliveryTiming = "realtime" | "completion";
export type RemoteExecutionPolicy = "disabled" | "planOnly" | "inherit";
export type AgentSessionOwnership = "external" | "managed";
export type SessionCompletionEvidence = "authoritative" | "discovered";
export type InputOrigin = "local" | "feishu" | `channel:${string}`;

export interface AgentEvent {
  source: "codex" | "claude-code" | "unknown";
  eventName: string;
  status: "progress" | "completed" | "failed";
  eventId?: string;
  origin?: "transcript" | "hook" | "display-hook" | "notify";
  sessionId: string;
  turnId: string;
  cwd: string;
  project: string;
  sessionName?: string;
  inputOrigin?: InputOrigin;
  channelId?: string;
  managedBackend?: "codex-app-server" | "claude-channel";
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

export interface FeishuDeliveryReceipt {
  messageId: string;
  chatId?: string;
  chunkIndex: number;
}

export interface FeishuDeliveryResult {
  count: number;
  receipts: FeishuDeliveryReceipt[];
}

export interface AgentSession {
  source: AgentEvent["source"];
  sessionId: string;
  cwd: string;
  project: string;
  lastSeenAt: string;
  status: AgentEvent["status"];
  name?: string;
  alias?: string;
  ownership?: AgentSessionOwnership;
  completionEvidence?: SessionCompletionEvidence;
  managedBackend?: "codex-app-server" | "claude-cli" | "claude-channel";
  channelId?: string;
  lastCompletedTurnId?: string;
  forkedFromSessionId?: string;
  forkedFromTurnId?: string;
}

export interface InboundReplyContext {
  messageId: string;
  parentMessageId?: string;
  rootMessageId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  text: string;
  mentionedBot: boolean;
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
