import crypto from "node:crypto";
import { AgentEvent, FeishuDeliveryReceipt, FeishuDeliveryResult, NotifierConfig } from "./types";
import { addChunkLabels, formatEventMessage, splitMessage } from "./event";
import { buildFeishuCard, FeishuCard } from "./card";

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
  cacheKey: string;
}

interface FeishuResponse {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: {
    message_id?: string;
    chat_id?: string;
  };
}

export type FetchLike = typeof fetch;

export class FeishuSender {
  private tokenCache: TokenCacheEntry | undefined;

  public constructor(private readonly fetchImpl: FetchLike = fetch) {}

  public async sendEvent(event: AgentEvent, config: NotifierConfig): Promise<FeishuDeliveryResult> {
    if (event.status === "failed" && !config.notifyOnFailure) {
      return { count: 0, receipts: [] };
    }

    validateConfig(config);
    const textMode = config.messageFormat === "text";
    const message = textMode
      ? formatEventMessage(event, config.includeMetadata)
      : event.message;
    const plainChunks = splitMessage(message, config.maxChunkCharacters);
    const chunks = textMode ? addChunkLabels(plainChunks) : plainChunks;

    const receipts: FeishuDeliveryReceipt[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const card = textMode
        ? undefined
        : buildFeishuCard(event, chunk, config.includeMetadata, {
          index: index + 1,
          total: chunks.length
        });
      if (config.deliveryMode === "webhook") {
        await this.sendWebhook(chunk, card, config);
      } else {
        const receipt = await this.sendApp(chunk, card, config);
        if (receipt) {
          receipts.push({ ...receipt, chunkIndex: index + 1 });
        }
      }
      if (chunks.length > 1) {
        await delay(250);
      }
    }
    return { count: chunks.length, receipts };
  }

  private async sendWebhook(
    text: string,
    card: FeishuCard | undefined,
    config: NotifierConfig
  ): Promise<void> {
    const payload: Record<string, unknown> = card
      ? { msg_type: "interactive", card }
      : { msg_type: "text", content: { text } };

    if (config.webhookSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = createWebhookSignature(timestamp, config.webhookSecret);
    }

    const response = await this.fetchWithRetry(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    }, config);
    await ensureFeishuSuccess(response);
  }

  private async sendApp(
    text: string,
    card: FeishuCard | undefined,
    config: NotifierConfig
  ): Promise<Omit<FeishuDeliveryReceipt, "chunkIndex"> | undefined> {
    const token = await this.getTenantAccessToken(config);
    const endpoint = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
    endpoint.searchParams.set("receive_id_type", config.receiveIdType);

    const response = await this.fetchWithRetry(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: config.receiveId,
        msg_type: card ? "interactive" : "text",
        content: JSON.stringify(card ?? { text })
      })
    }, config);
    const result = await ensureFeishuSuccess(response);
    return result.data?.message_id
      ? { messageId: result.data.message_id, chatId: result.data.chat_id }
      : undefined;
  }

  private async getTenantAccessToken(config: NotifierConfig): Promise<string> {
    const cacheKey = crypto.createHash("sha256").update(`${config.appId}\0${config.appSecret}`).digest("hex");
    if (this.tokenCache
      && this.tokenCache.cacheKey === cacheKey
      && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }

    const response = await this.fetchWithRetry(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
      },
      config
    );
    const result = await parseFeishuResponse(response);
    if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
      throw new Error(feishuError("获取 tenant_access_token 失败", response.status, result));
    }

    const expiresIn = Math.max(60, result.expire ?? 3600);
    this.tokenCache = {
      token: result.tenant_access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      cacheKey
    };
    return result.tenant_access_token;
  }

  private async fetchWithRetry(
    input: string | URL,
    init: RequestInit,
    config: Pick<NotifierConfig, "deliveryMaxAttempts" | "retryBaseDelayMs">
  ): Promise<Response> {
    const attempts = Math.min(5, Math.max(1, Math.trunc(config.deliveryMaxAttempts || 1)));
    const baseDelayMs = Math.min(5_000, Math.max(10, Math.trunc(config.retryBaseDelayMs || 500)));
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(input, {
          ...init,
          signal: AbortSignal.timeout(15_000)
        });
        if (!isTransientStatus(response.status) || attempt === attempts) {
          return response;
        }
        await response.arrayBuffer();
        await delay(retryDelayMilliseconds(response, attempt, baseDelayMs));
      } catch (error) {
        lastError = error;
        if (!isRetryableNetworkError(error) || attempt === attempts) {
          throw error;
        }
        await delay(exponentialDelay(attempt, baseDelayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("飞书请求重试失败");
  }
}

export function createWebhookSignature(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

export function validateConfig(config: NotifierConfig): void {
  if (config.deliveryMode === "webhook") {
    if (!config.webhookUrl) {
      throw new Error("未配置飞书机器人 Webhook URL。");
    }
    let parsed: URL;
    try {
      parsed = new URL(config.webhookUrl);
    } catch {
      throw new Error("飞书机器人 Webhook URL 格式无效。");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "open.feishu.cn") {
      throw new Error("Webhook 必须是 https://open.feishu.cn 地址。");
    }
    return;
  }

  if (!config.appId || !config.appSecret || !config.receiveId) {
    throw new Error("应用机器人模式需要 App ID、App Secret 和 Receive ID。");
  }
}

async function ensureFeishuSuccess(response: Response): Promise<FeishuResponse> {
  const result = await parseFeishuResponse(response);
  const webhookOk = result.StatusCode === undefined || result.StatusCode === 0;
  const apiOk = result.code === undefined || result.code === 0;
  if (!response.ok || !webhookOk || !apiOk) {
    throw new Error(feishuError("飞书发送失败", response.status, result));
  }
  return result;
}

async function parseFeishuResponse(response: Response): Promise<FeishuResponse> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as FeishuResponse;
  } catch {
    throw new Error(`飞书返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
}

function feishuError(prefix: string, status: number, result: FeishuResponse): string {
  const code = result.code ?? result.StatusCode ?? "unknown";
  const message = result.msg ?? result.StatusMessage ?? "unknown error";
  return `${prefix}（HTTP ${status}, code ${code}）：${message}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

function retryDelayMilliseconds(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30_000, seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(30_000, Math.max(0, date - Date.now()));
    }
  }
  return exponentialDelay(attempt, baseDelayMs);
}

function exponentialDelay(attempt: number, baseDelayMs: number): number {
  return Math.min(30_000, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}
