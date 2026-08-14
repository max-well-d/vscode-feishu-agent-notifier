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

  public async update(receipts: ChannelReceipt[], event: AgentEvent, raw: Record<string, unknown>): Promise<boolean> {
    const config = parseFeishuConfig(raw);
    return this.sender.updateEvent(event, receipts.map((receipt) => ({
      messageId: receipt.messageId,
      chunkIndex: receipt.chunkIndex ?? 1
    })), config);
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

export const FEISHU_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    deliveryMode: {
      type: "string",
      enum: ["webhook", "app"],
      enumLabels: ["群机器人 Webhook", "自建应用"],
      default: "webhook",
      description: "Webhook 仅支持向一个群发送；自建应用支持指定目标和双向远程操控。",
      ui: { control: "segmented", section: "connection", order: 0 }
    },
    webhookUrl: { type: "string", format: "uri", secret: true, description: "飞书群机器人设置中的 Webhook 地址。", ui: { section: "connection", order: 10, visibleWhen: { deliveryMode: "webhook" } } },
    webhookSecret: { type: "string", secret: true, description: "机器人启用签名校验后填写。", ui: { section: "connection", order: 11, visibleWhen: { deliveryMode: "webhook" } } },
    appId: { type: "string", description: "飞书开放平台自建应用的 App ID。", ui: { section: "connection", order: 20, visibleWhen: { deliveryMode: "app" } } },
    appSecret: { type: "string", secret: true, description: "自建应用的 App Secret。", ui: { section: "connection", order: 21, visibleWhen: { deliveryMode: "app" } } },
    receiveIdType: { type: "string", enum: ["chat_id", "open_id", "user_id", "email"], enumLabels: ["群聊 Chat ID", "用户 Open ID", "用户 ID", "邮箱"], default: "chat_id", ui: { section: "target", order: 30, visibleWhen: { deliveryMode: "app" } } },
    receiveId: { type: "string", description: "默认通知目标；群聊通常以 oc_ 开头，用户 Open ID 以 ou_ 开头。", ui: { section: "target", order: 31, visibleWhen: { deliveryMode: "app" } } },
    inboundEnabled: { type: "boolean", default: false, description: "通过飞书 WebSocket 接收引用回复和远程命令。", ui: { section: "inbound", order: 40, visibleWhen: { deliveryMode: "app" } } },
    allowedUserOpenIds: { type: "array", items: { type: "string" }, description: "每行一个 ou_ 开头的用户 Open ID。", ui: { section: "inbound", order: 41, visibleWhen: { deliveryMode: "app", inboundEnabled: true } } },
    allowedChatIds: { type: "array", items: { type: "string" }, description: "可留空表示仅允许私聊；每行一个 oc_ 开头的群聊 ID。", ui: { section: "inbound", order: 42, visibleWhen: { deliveryMode: "app", inboundEnabled: true } } },
    requireGroupMention: { type: "boolean", default: true, description: "群聊中仅处理明确 @机器人的消息。", ui: { section: "inbound", order: 43, visibleWhen: { deliveryMode: "app", inboundEnabled: true } } },
    messageFormat: { type: "string", enum: ["card", "text"], enumLabels: ["消息卡片", "纯文本"], default: "card", ui: { section: "message", order: 50 } },
    includeMetadata: { type: "boolean", default: true, description: "显示 Agent、项目、Session ID、输入来源和时间。", ui: { section: "message", order: 51 } },
    maxChunkCharacters: { type: "integer", minimum: 1000, maximum: 20000, default: 3000, ui: { section: "advanced", order: 60 } },
    notifyOnFailure: { type: "boolean", default: true, ui: { section: "advanced", order: 61 } },
    deliveryMaxAttempts: { type: "integer", minimum: 1, maximum: 5, default: 3, ui: { section: "advanced", order: 62 } },
    retryBaseDelayMs: { type: "integer", minimum: 100, maximum: 5000, default: 500, ui: { section: "advanced", order: 63 } }
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
