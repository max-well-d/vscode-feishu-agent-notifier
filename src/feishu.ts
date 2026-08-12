import crypto from "node:crypto";
import { AgentEvent, NotifierConfig } from "./types";
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
}

export type FetchLike = typeof fetch;

export class FeishuSender {
  private tokenCache: TokenCacheEntry | undefined;

  public constructor(private readonly fetchImpl: FetchLike = fetch) {}

  public async sendEvent(event: AgentEvent, config: NotifierConfig): Promise<number> {
    if (event.status === "failed" && !config.notifyOnFailure) {
      return 0;
    }

    validateConfig(config);
    const textMode = config.messageFormat === "text";
    const message = textMode
      ? formatEventMessage(event, config.includeMetadata)
      : event.message;
    const plainChunks = splitMessage(message, config.maxChunkCharacters);
    const chunks = textMode ? addChunkLabels(plainChunks) : plainChunks;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const card = textMode
        ? undefined
        : buildFeishuCard(event, chunk, config.includeMetadata, {
          index: index + 1,
          total: chunks.length
        });
      if (config.deliveryMode === "webhook") {
        await this.sendWebhook(chunk, card, config.webhookUrl, config.webhookSecret);
      } else {
        await this.sendApp(chunk, card, config);
      }
      if (chunks.length > 1) {
        await delay(250);
      }
    }
    return chunks.length;
  }

  private async sendWebhook(
    text: string,
    card: FeishuCard | undefined,
    webhookUrl: string,
    secret: string
  ): Promise<void> {
    const payload: Record<string, unknown> = card
      ? { msg_type: "interactive", card }
      : { msg_type: "text", content: { text } };

    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = createWebhookSignature(timestamp, secret);
    }

    const response = await this.fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    await ensureFeishuSuccess(response);
  }

  private async sendApp(text: string, card: FeishuCard | undefined, config: NotifierConfig): Promise<void> {
    const token = await this.getTenantAccessToken(config.appId, config.appSecret);
    const endpoint = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
    endpoint.searchParams.set("receive_id_type", config.receiveIdType);

    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: config.receiveId,
        msg_type: card ? "interactive" : "text",
        content: JSON.stringify(card ?? { text })
      }),
      signal: AbortSignal.timeout(15_000)
    });
    await ensureFeishuSuccess(response);
  }

  private async getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
    const cacheKey = crypto.createHash("sha256").update(`${appId}\0${appSecret}`).digest("hex");
    if (this.tokenCache
      && this.tokenCache.cacheKey === cacheKey
      && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }

    const response = await this.fetchImpl(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(15_000)
      }
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

async function ensureFeishuSuccess(response: Response): Promise<void> {
  const result = await parseFeishuResponse(response);
  const webhookOk = result.StatusCode === undefined || result.StatusCode === 0;
  const apiOk = result.code === undefined || result.code === 0;
  if (!response.ok || !webhookOk || !apiOk) {
    throw new Error(feishuError("飞书发送失败", response.status, result));
  }
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
