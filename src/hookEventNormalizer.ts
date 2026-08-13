import { normalizeAgentEvent, projectNameFromCwd } from "./event";
import { AgentEvent, DeliveryTiming } from "./types";

type UnknownRecord = Record<string, unknown>;

interface DisplayMessageState {
  chunks: Map<number, string>;
  finalIndex?: number;
  sessionId: string;
  turnId: string;
  messageId: string;
  cwd: string;
  updatedAt: number;
}

export class HookEventNormalizer {
  private readonly displayMessages = new Map<string, DisplayMessageState>();
  private messageDisplayObserved = false;

  public constructor(
    private readonly deliveryTiming: DeliveryTiming,
    private readonly finalizationDelayMs = 150,
    private readonly onMessageDisplay?: () => void
  ) {}

  public async normalize(input: UnknownRecord): Promise<AgentEvent | undefined> {
    if (input.hook_event_name !== "MessageDisplay") {
      return normalizeAgentEvent(input);
    }
    if (this.deliveryTiming !== "realtime") {
      return undefined;
    }
    return this.normalizeClaudeDisplayMessage(input);
  }

  private async normalizeClaudeDisplayMessage(input: UnknownRecord): Promise<AgentEvent | undefined> {
    const sessionId = stringValue(input.session_id);
    const turnId = stringValue(input.turn_id);
    const messageId = stringValue(input.message_id);
    const cwd = stringValue(input.cwd);
    const delta = stringValue(input.delta);
    const index = input.index;
    const final = input.final;

    if (!sessionId || !messageId || !Number.isInteger(index) || (index as number) < 0 || typeof final !== "boolean") {
      throw new Error("Claude MessageDisplay 事件字段无效");
    }

    if (!this.messageDisplayObserved) {
      this.messageDisplayObserved = true;
      this.onMessageDisplay?.();
    }
    this.pruneDisplayMessages();
    const key = `${sessionId}:${messageId}`;
    const state = this.displayMessages.get(key) ?? {
      chunks: new Map<number, string>(),
      sessionId,
      turnId,
      messageId,
      cwd,
      updatedAt: Date.now()
    };
    state.chunks.set(index as number, delta);
    state.updatedAt = Date.now();
    if (final) {
      state.finalIndex = index as number;
    }
    this.displayMessages.set(key, state);

    if (!final) {
      return undefined;
    }

    if (this.finalizationDelayMs > 0) {
      await delay(this.finalizationDelayMs);
    }
    this.displayMessages.delete(key);

    const finalIndex = state.finalIndex as number;
    const missingIndex = firstMissingIndex(state.chunks, finalIndex);
    if (missingIndex !== undefined) {
      throw new Error(`Claude MessageDisplay 缺少分片 ${missingIndex}/${finalIndex}`);
    }
    const message = Array.from({ length: finalIndex + 1 }, (_, chunkIndex) => state.chunks.get(chunkIndex) ?? "").join("");
    if (!message) {
      return undefined;
    }

    return {
      source: "claude-code",
      eventName: "assistant-message:display",
      status: "progress",
      eventId: messageId,
      origin: "display-hook",
      channelId: stringValue(input.__notifier_channel_id) || undefined,
      sessionId,
      turnId,
      cwd,
      project: projectNameFromCwd(cwd),
      message,
      occurredAt: new Date().toISOString()
    };
  }

  private pruneDisplayMessages(): void {
    const expiry = Date.now() - 5 * 60_000;
    for (const [key, state] of this.displayMessages) {
      if (state.updatedAt < expiry) {
        this.displayMessages.delete(key);
      }
    }
    while (this.displayMessages.size >= 200) {
      const oldestKey = this.displayMessages.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.displayMessages.delete(oldestKey);
    }
  }
}

function firstMissingIndex(chunks: Map<number, string>, finalIndex: number): number | undefined {
  for (let index = 0; index <= finalIndex; index += 1) {
    if (!chunks.has(index)) {
      return index;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
