import type {
  LarkChannel,
  LarkChannelOptions,
  Logger,
  NormalizedMessage,
  LoggerLevel,
  WSConnectionState
} from "@larksuiteoapi/node-sdk";
import { InboundReplyContext } from "./types";

export interface FeishuInboundConfig {
  appId: string;
  appSecret: string;
  allowedUserOpenIds: string[];
  allowedChatIds: string[];
  requireGroupMention: boolean;
}

export interface FeishuInboundHandlers {
  onMessage: (message: InboundReplyContext) => Promise<void> | void;
  onState?: (state: WSConnectionState, detail?: string) => Promise<void> | void;
  log?: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export class FeishuInboundClient {
  private channel: LarkChannel | undefined;

  public constructor(
    private readonly config: FeishuInboundConfig,
    private readonly handlers: FeishuInboundHandlers,
    private readonly createChannel: (options: LarkChannelOptions) => LarkChannel = createDefaultChannel
  ) {}

  public async connect(): Promise<void> {
    await this.disconnect();
    const logger = createLogger(this.handlers.log);
    const channel = this.createChannel({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      transport: "websocket",
      source: "feishu-agent-notifier",
      logger,
      loggerLevel: 2 as LoggerLevel,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 15 },
      safety: {
        dedup: { ttl: 7 * 24 * 60 * 60, maxEntries: 10_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 5 * 60 * 1000
      },
      policy: {
        dmMode: this.config.allowedUserOpenIds.length > 0 ? "allowlist" : "disabled",
        dmAllowlist: this.config.allowedUserOpenIds,
        groupAllowlist: this.config.allowedChatIds,
        requireMention: this.config.requireGroupMention,
        respondToMentionAll: false
      }
    });
    channel.on("message", async (message) => this.handleMessage(message));
    channel.on("reconnecting", () => void this.handlers.onState?.("reconnecting"));
    channel.on("reconnected", () => void this.handlers.onState?.("connected"));
    channel.on("error", (error) => {
      this.handlers.log?.error(`飞书入站连接错误：${error.message}`);
      void this.handlers.onState?.("failed", error.message);
    });
    this.channel = channel;
    await this.handlers.onState?.("connecting");
    await channel.connect();
    await this.handlers.onState?.("connected");
  }

  public async disconnect(): Promise<void> {
    const channel = this.channel;
    this.channel = undefined;
    if (channel) {
      await channel.disconnect();
    }
    await this.handlers.onState?.("idle");
  }

  public get state(): WSConnectionState {
    return this.channel?.getConnectionStatus()?.state ?? "idle";
  }

  public async reply(messageId: string, chatId: string, text: string): Promise<string> {
    const channel = this.channel;
    if (!channel || this.state !== "connected") {
      throw new Error("飞书入站长连接未连接");
    }
    const result = await channel.send(chatId, { text }, { replyTo: messageId });
    return result.messageId;
  }

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    if (message.rawContentType !== "text") {
      await this.reply(message.messageId, message.chatId, "当前只接受文本回复。");
      return;
    }
    const normalized = normalizeInboundMessage(message, this.config);
    if (!normalized) {
      this.handlers.log?.warn(`已拒绝不符合入站策略的飞书消息：${redactId(message.senderId)}`);
      return;
    }
    await this.handlers.onMessage(normalized);
  }
}

function createDefaultChannel(options: LarkChannelOptions): LarkChannel {
  // Keep the large Feishu SDK and its HTTP stack out of the default startup path.
  // It is loaded only after the user explicitly enables remote replies.
  const sdk = require("./larkSdk") as typeof import("./larkSdk");
  return sdk.createLarkChannel(options);
}

export function normalizeInboundMessage(
  message: NormalizedMessage,
  config: Pick<FeishuInboundConfig, "allowedUserOpenIds" | "allowedChatIds" | "requireGroupMention">
): InboundReplyContext | undefined {
  if (!config.allowedUserOpenIds.includes(message.senderId)) {
    return undefined;
  }
  if (message.chatType === "group"
    && (!config.allowedChatIds.includes(message.chatId)
      || (config.requireGroupMention && !message.mentionedBot))) {
    return undefined;
  }
  return {
      messageId: message.messageId,
      parentMessageId: message.replyToMessageId,
      rootMessageId: message.rootId,
      chatId: message.chatId,
      chatType: message.chatType,
      senderOpenId: message.senderId,
      text: stripBotMentions(message.content, message.mentions.map((mention) => mention.key)),
      mentionedBot: message.mentionedBot
  };
}

function createLogger(log: FeishuInboundHandlers["log"]): Logger {
  const render = (values: unknown[]): string => values.map((value) => {
    if (value instanceof Error) {
      return value.message;
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }).join(" ");
  return {
    debug: (...values) => log?.debug(render(values)),
    info: (...values) => log?.info(render(values)),
    warn: (...values) => log?.warn(render(values)),
    error: (...values) => log?.error(render(values)),
    trace: (...values) => log?.debug(render(values))
  };
}

function stripBotMentions(content: string, mentionKeys: string[]): string {
  let result = content;
  for (const key of mentionKeys) {
    result = result.replaceAll(key, "");
  }
  return result.trim();
}

function redactId(value: string): string {
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
