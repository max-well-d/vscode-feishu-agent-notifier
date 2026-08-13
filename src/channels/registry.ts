import { AgentEvent } from "../types";
import {
  CHANNEL_API_VERSION,
  ChannelAdapter,
  ChannelConfiguration,
  ChannelDeliveryResult,
  ChannelInboundMessage,
  ChannelLogger,
  ChannelReceipt,
  ChannelSnapshot,
  ChannelState,
  ChannelTarget
} from "./types";

interface RegisteredChannel {
  adapter: ChannelAdapter;
  configuration: ChannelConfiguration;
  state: ChannelState;
  detail?: string;
}

export interface ChannelRegistryOptions {
  onMessage(message: ChannelInboundMessage): Promise<void> | void;
  onStateChange?(snapshot: ChannelSnapshot): Promise<void> | void;
  log?: ChannelLogger;
}

const silentLogger: ChannelLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export class ChannelRegistry {
  private readonly channels = new Map<string, RegisteredChannel>();
  private readonly log: ChannelLogger;

  public constructor(private readonly options: ChannelRegistryOptions) {
    this.log = options.log ?? silentLogger;
  }

  public register(adapter: ChannelAdapter, configuration?: Partial<ChannelConfiguration>): void {
    const { manifest } = adapter;
    if (manifest.apiVersion !== CHANNEL_API_VERSION) {
      throw new Error(`Channel ${manifest.id} 使用不兼容的 API ${manifest.apiVersion}`);
    }
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(manifest.id)) {
      throw new Error(`Channel ID 无效：${manifest.id}`);
    }
    if (this.channels.has(manifest.id)) {
      throw new Error(`Channel 已注册：${manifest.id}`);
    }
    this.channels.set(manifest.id, {
      adapter,
      configuration: {
        enabled: configuration?.enabled ?? false,
        config: configuration?.config ?? {},
        defaultTarget: configuration?.defaultTarget
      },
      state: "disabled"
    });
  }

  public async configure(id: string, configuration: ChannelConfiguration): Promise<void> {
    const channel = this.require(id);
    if (configuration.enabled) {
      channel.adapter.validate(configuration.config);
    }
    const wasEnabled = channel.configuration.enabled;
    if (wasEnabled) {
      await this.stopChannel(channel);
    }
    channel.configuration = structuredClone(configuration);
    if (configuration.enabled) {
      await this.startChannel(channel);
    } else {
      await this.setState(channel, "disabled");
    }
  }

  public async start(): Promise<void> {
    for (const channel of this.channels.values()) {
      if (channel.configuration.enabled) {
        await this.startChannel(channel);
      }
    }
  }

  public async stop(): Promise<void> {
    await Promise.all(Array.from(this.channels.values(), (channel) => this.stopChannel(channel)));
  }

  public snapshots(): ChannelSnapshot[] {
    return Array.from(this.channels.values(), (channel) => this.snapshot(channel));
  }

  public configuration(id: string): ChannelConfiguration {
    return structuredClone(this.require(id).configuration);
  }

  public async send(
    id: string,
    event: AgentEvent,
    target?: ChannelTarget
  ): Promise<ChannelDeliveryResult> {
    const channel = this.require(id);
    if (!channel.configuration.enabled) {
      throw new Error(`Channel 未启用：${id}`);
    }
    return channel.adapter.send(
      event,
      target ?? channel.configuration.defaultTarget,
      structuredClone(channel.configuration.config)
    );
  }

  public async broadcast(event: AgentEvent): Promise<Record<string, ChannelDeliveryResult | Error>> {
    const result: Record<string, ChannelDeliveryResult | Error> = {};
    await Promise.all(Array.from(this.channels.entries(), async ([id, channel]) => {
      if (!channel.configuration.enabled || !channel.adapter.manifest.capabilities.includes("outbound")) {
        return;
      }
      try {
        result[id] = await this.send(id, event);
      } catch (error) {
        result[id] = error instanceof Error ? error : new Error(String(error));
      }
    }));
    return result;
  }

  public async reply(message: ChannelInboundMessage, text: string): Promise<ChannelReceipt> {
    const channel = this.require(message.channelId);
    if (!channel.configuration.enabled || !channel.adapter.reply) {
      throw new Error(`Channel 不支持回复：${message.channelId}`);
    }
    return channel.adapter.reply(message, text, structuredClone(channel.configuration.config));
  }

  private async startChannel(channel: RegisteredChannel): Promise<void> {
    channel.adapter.validate(channel.configuration.config);
    await this.setState(channel, "connecting");
    try {
      await channel.adapter.start(channel.configuration.config, {
        onMessage: this.options.onMessage,
        onState: async (state, detail) => this.setState(channel, state, detail),
        log: this.log
      });
      if (channel.state === "connecting") {
        await this.setState(channel, "connected");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.setState(channel, "failed", detail);
      throw error;
    }
  }

  private async stopChannel(channel: RegisteredChannel): Promise<void> {
    if (channel.state !== "disabled" && channel.state !== "idle") {
      await channel.adapter.stop();
    }
    await this.setState(channel, channel.configuration.enabled ? "idle" : "disabled");
  }

  private async setState(channel: RegisteredChannel, state: ChannelState, detail?: string): Promise<void> {
    channel.state = state;
    channel.detail = detail;
    await this.options.onStateChange?.(this.snapshot(channel));
  }

  private require(id: string): RegisteredChannel {
    const channel = this.channels.get(id);
    if (!channel) {
      throw new Error(`未知 Channel：${id}`);
    }
    return channel;
  }

  private snapshot(channel: RegisteredChannel): ChannelSnapshot {
    return {
      manifest: structuredClone(channel.adapter.manifest),
      enabled: channel.configuration.enabled,
      state: channel.state,
      detail: channel.detail,
      defaultTarget: structuredClone(channel.configuration.defaultTarget)
    };
  }
}
