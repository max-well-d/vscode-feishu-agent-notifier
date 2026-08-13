import { FeishuSender, validateConfig } from "../feishu";
import { FeishuInboundClient } from "../feishuInbound";
import { AgentEvent, NotifierConfig } from "../types";
import {
  CHANNEL_API_VERSION,
  ChannelAdapter,
  ChannelDeliveryResult,
  ChannelInboundMessage,
  ChannelManifest,
  ChannelReceipt,
  ChannelRuntimeContext,
  ChannelTarget
} from "./types";

export interface FeishuChannelConfig extends NotifierConfig {
  inboundEnabled: boolean;
  allowedUserOpenIds: string[];
  allowedChatIds: string[];
  requireGroupMention: boolean;
}

export class FeishuChannelAdapter implements ChannelAdapter {
  public readonly manifest: ChannelManifest = {
    apiVersion: CHANNEL_API_VERSION,
    id: "feishu",
    name: "飞书",
    version: "1.0.0",
    description: "通过飞书 Webhook 或自建应用收发 Agent 消息。",
    capabilities: ["outbound", "inbound", "reply", "interactive"],
    configSchema: FEISHU_CONFIG_SCHEMA
  };

  private inbound: FeishuInboundClient | undefined;

  public constructor(private readonly sender = new FeishuSender()) {}

  public validate(raw: Record<string, unknown>): void {
    const config = parseFeishuConfig(raw);
    validateConfig(config);
    if (config.inboundEnabled) {
      if (config.deliveryMode !== "app") {
        throw new Error("飞书入站消息要求使用自建应用模式");
      }
      if (config.allowedUserOpenIds.length === 0) {
        throw new Error("启用飞书入站消息前必须配置用户 Open ID 白名单");
      }
    }
  }

  public async start(raw: Record<string, unknown>, context: ChannelRuntimeContext): Promise<void> {
    await this.stop();
    const config = parseFeishuConfig(raw);
    this.validate(raw);
    if (!config.inboundEnabled) {
      await context.onState("connected", "仅出站");
      return;
    }
    this.inbound = new FeishuInboundClient({
      appId: config.appId,
      appSecret: config.appSecret,
      allowedUserOpenIds: config.allowedUserOpenIds,
      allowedChatIds: config.allowedChatIds,
      requireGroupMention: config.requireGroupMention
    }, {
      onMessage: async (message) => context.onMessage({
        channelId: this.manifest.id,
        messageId: message.messageId,
        conversationId: message.chatId,
        conversationType: message.chatType === "p2p" ? "direct" : "group",
        senderId: message.senderOpenId,
        text: message.text,
        mentionedAdapter: message.mentionedBot,
        parentMessageId: message.parentMessageId,
        rootMessageId: message.rootMessageId,
        receivedAt: new Date().toISOString()
      }),
      onState: (state, detail) => context.onState(state === "reconnecting" ? "connecting" : state, detail),
      log: context.log
    });
    await this.inbound.connect();
  }

  public async stop(): Promise<void> {
    const inbound = this.inbound;
    this.inbound = undefined;
    await inbound?.disconnect();
  }

  public async send(
    event: AgentEvent,
    target: ChannelTarget | undefined,
    raw: Record<string, unknown>
  ): Promise<ChannelDeliveryResult> {
    const config = parseFeishuConfig(raw);
    const targeted = target
      ? { ...config, receiveId: target.conversationId, receiveIdType: parseReceiveIdType(target.addressType) }
      : config;
    const result = await this.sender.sendEvent(event, targeted);
    return {
      count: result.count,
      receipts: result.receipts.map((receipt) => ({
        channelId: this.manifest.id,
        messageId: receipt.messageId,
        conversationId: receipt.chatId,
        chunkIndex: receipt.chunkIndex
      }))
    };
  }

  public async reply(message: ChannelInboundMessage, text: string): Promise<ChannelReceipt> {
    if (!this.inbound) {
      throw new Error("飞书入站连接未启动");
    }
    const messageId = await this.inbound.reply(message.messageId, message.conversationId, text);
    return {
      channelId: this.manifest.id,
      messageId,
      conversationId: message.conversationId
    };
  }
}

export function createChannelAdapter(): ChannelAdapter {
  return new FeishuChannelAdapter();
}

export function parseFeishuConfig(raw: Record<string, unknown>): FeishuChannelConfig {
  return {
    deliveryMode: raw.deliveryMode === "app" ? "app" : "webhook",
    webhookUrl: stringValue(raw.webhookUrl),
    webhookSecret: stringValue(raw.webhookSecret),
    appId: stringValue(raw.appId),
    appSecret: stringValue(raw.appSecret),
    receiveIdType: parseReceiveIdType(raw.receiveIdType),
    receiveId: stringValue(raw.receiveId),
    messageFormat: raw.messageFormat === "text" ? "text" : "card",
    includeMetadata: booleanValue(raw.includeMetadata, true),
    maxChunkCharacters: numberValue(raw.maxChunkCharacters, 3000, 1000, 20_000),
    notifyOnFailure: booleanValue(raw.notifyOnFailure, true),
    deliveryMaxAttempts: numberValue(raw.deliveryMaxAttempts, 3, 1, 5),
    retryBaseDelayMs: numberValue(raw.retryBaseDelayMs, 500, 100, 5000),
    inboundEnabled: booleanValue(raw.inboundEnabled, false),
    allowedUserOpenIds: stringArray(raw.allowedUserOpenIds),
    allowedChatIds: stringArray(raw.allowedChatIds),
    requireGroupMention: booleanValue(raw.requireGroupMention, true)
  };
}

const FEISHU_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    deliveryMode: { type: "string", enum: ["webhook", "app"], default: "webhook" },
    webhookUrl: { type: "string", format: "uri", secret: true },
    webhookSecret: { type: "string", secret: true },
    appId: { type: "string" },
    appSecret: { type: "string", secret: true },
    receiveIdType: { type: "string", enum: ["open_id", "user_id", "email", "chat_id"] },
    receiveId: { type: "string" },
    messageFormat: { type: "string", enum: ["card", "text"], default: "card" },
    includeMetadata: { type: "boolean", default: true },
    maxChunkCharacters: { type: "integer", minimum: 1000, maximum: 20000, default: 3000 },
    notifyOnFailure: { type: "boolean", default: true },
    deliveryMaxAttempts: { type: "integer", minimum: 1, maximum: 5, default: 3 },
    retryBaseDelayMs: { type: "integer", minimum: 100, maximum: 5000, default: 500 },
    inboundEnabled: { type: "boolean", default: false },
    allowedUserOpenIds: { type: "array", items: { type: "string" } },
    allowedChatIds: { type: "array", items: { type: "string" } },
    requireGroupMention: { type: "boolean", default: true }
  },
  required: ["deliveryMode"]
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)))
    : [];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value)))
    : fallback;
}

function parseReceiveIdType(value: unknown): FeishuChannelConfig["receiveIdType"] {
  return value === "open_id" || value === "user_id" || value === "email" || value === "chat_id"
    ? value
    : "chat_id";
}
