import { AgentEvent } from "../types";

export const CHANNEL_API_VERSION = 1;

export type ChannelCapability = "outbound" | "inbound" | "reply" | "interactive";
export type ChannelState = "disabled" | "idle" | "connecting" | "connected" | "degraded" | "failed";

export interface ChannelManifest {
  apiVersion: typeof CHANNEL_API_VERSION;
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: ChannelCapability[];
  configSchema?: Record<string, unknown>;
}

export interface ChannelTarget {
  conversationId: string;
  addressType?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelInboundMessage {
  channelId: string;
  messageId: string;
  conversationId: string;
  conversationType: "direct" | "group" | "unknown";
  senderId: string;
  text: string;
  mentionedAdapter: boolean;
  parentMessageId?: string;
  rootMessageId?: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelReceipt {
  channelId: string;
  messageId: string;
  conversationId?: string;
  chunkIndex?: number;
}

export interface ChannelDeliveryResult {
  count: number;
  receipts: ChannelReceipt[];
}

export interface ChannelLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ChannelRuntimeContext {
  onMessage(message: ChannelInboundMessage): Promise<void> | void;
  onState(state: ChannelState, detail?: string): Promise<void> | void;
  log: ChannelLogger;
}

export interface ChannelAdapter {
  readonly manifest: ChannelManifest;
  validate(config: Record<string, unknown>): void;
  start(config: Record<string, unknown>, context: ChannelRuntimeContext): Promise<void>;
  stop(): Promise<void>;
  send(
    event: AgentEvent,
    target: ChannelTarget | undefined,
    config: Record<string, unknown>
  ): Promise<ChannelDeliveryResult>;
  update?(
    receipts: ChannelReceipt[],
    event: AgentEvent,
    config: Record<string, unknown>
  ): Promise<boolean>;
  reply?(
    message: ChannelInboundMessage,
    text: string,
    config: Record<string, unknown>
  ): Promise<ChannelReceipt>;
}

export interface ChannelConfiguration {
  enabled: boolean;
  config: Record<string, unknown>;
  defaultTarget?: ChannelTarget;
}

export interface ChannelSnapshot {
  manifest: ChannelManifest;
  enabled: boolean;
  state: ChannelState;
  detail?: string;
  defaultTarget?: ChannelTarget;
}

export interface ChannelPluginModule {
  createChannelAdapter(): ChannelAdapter;
}
