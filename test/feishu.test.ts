import assert from "node:assert/strict";
import test from "node:test";
import { FeishuSender, createWebhookSignature, describeNetworkError, validateConfig } from "../src/feishu";
import { AgentEvent, NotifierConfig } from "../src/types";

const event: AgentEvent = {
  source: "codex",
  eventName: "Stop",
  status: "completed",
  sessionId: "s1",
  turnId: "t1",
  cwd: "/work/project",
  project: "project",
  message: "最终回复全部内容",
  occurredAt: "2026-08-12T00:00:00.000Z"
};

const webhookConfig: NotifierConfig = {
  deliveryMode: "webhook",
  webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  webhookSecret: "secret",
  appId: "",
  appSecret: "",
  receiveIdType: "chat_id",
  receiveId: "",
  messageFormat: "card",
  includeMetadata: false,
  maxChunkCharacters: 12000,
  notifyOnFailure: true,
  deliveryMaxAttempts: 3,
  retryBaseDelayMs: 10
};

test("creates deterministic Feishu webhook signatures", () => {
  assert.equal(
    createWebhookSignature("1700000000", "secret"),
    createWebhookSignature("1700000000", "secret")
  );
  assert.notEqual(
    createWebhookSignature("1700000000", "secret"),
    createWebhookSignature("1700000001", "secret")
  );
});

test("sends a webhook card with rendered Markdown", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body))
    });
    return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
  }) as typeof fetch;

  const sender = new FeishuSender(fakeFetch);
  const result = await sender.sendEvent(event, webhookConfig);
  assert.equal(result.count, 1);
  assert.deepEqual(result.receipts, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.msg_type, "interactive");
  assert.equal(requests[0].body.card.schema, "2.0");
  assert.equal(requests[0].body.card.body.elements[0].content, event.message);
  assert.ok(requests[0].body.timestamp);
  assert.ok(requests[0].body.sign);
});

test("app mode fetches a token and sends to the configured target", async () => {
  const urls: string[] = [];
  const bodies: any[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    bodies.push(JSON.parse(String(init?.body)));
    if (url.includes("tenant_access_token")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        tenant_access_token: "token",
        expire: 3600
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: { message_id: "om_reply_target", chat_id: "oc_target" }
    }), { status: 200 });
  }) as typeof fetch;

  const config: NotifierConfig = {
    ...webhookConfig,
    deliveryMode: "app",
    appId: "cli_test",
    appSecret: "app-secret",
    receiveIdType: "email",
    receiveId: "developer@example.com"
  };
  const sender = new FeishuSender(fakeFetch);
  const result = await sender.sendEvent(event, config);

  assert.equal(urls.length, 2);
  assert.match(urls[1], /receive_id_type=email/);
  assert.equal(bodies[1].receive_id, "developer@example.com");
  assert.equal(bodies[1].msg_type, "interactive");
  assert.equal(JSON.parse(bodies[1].content).schema, "2.0");
  assert.deepEqual(result.receipts, [{ messageId: "om_reply_target", chatId: "oc_target", chunkIndex: 1 }]);
});

test("updates an app-mode realtime card in place when the terminal event arrives", async () => {
  const requests: Array<{ url: string; method?: string; body: any }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    if (url.includes("tenant_access_token")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        tenant_access_token: "token",
        expire: 3600
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
  }) as typeof fetch;
  const config: NotifierConfig = {
    ...webhookConfig,
    deliveryMode: "app",
    appId: "cli_test",
    appSecret: "app-secret",
    receiveIdType: "chat_id",
    receiveId: "oc_target"
  };
  const sender = new FeishuSender(fakeFetch);
  const updated = await sender.updateEvent(event, [{ messageId: "om_progress", chunkIndex: 1 }], config);
  assert.equal(updated, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "PATCH");
  assert.match(requests[1].url, /\/im\/v1\/messages\/om_progress$/);
  const card = JSON.parse(requests[1].body.content);
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.template, "green");
  assert.equal(card.body.elements[0].content, event.message);
});

test("keeps a plain text compatibility mode", async () => {
  const bodies: any[] = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
  }) as typeof fetch;

  await new FeishuSender(fakeFetch).sendEvent(event, { ...webhookConfig, messageFormat: "text" });
  assert.equal(bodies[0].msg_type, "text");
  assert.equal(bodies[0].content.text, event.message);
});

test("rejects non-Feishu webhook hosts", () => {
  assert.throws(
    () => validateConfig({ ...webhookConfig, webhookUrl: "https://example.com/hook" }),
    /open\.feishu\.cn/
  );
});

test("retries transient Feishu responses before succeeding", async () => {
  let attempts = 0;
  const fakeFetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response(JSON.stringify({ code: 1, msg: "busy" }), { status: 503 });
    }
    return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
  }) as typeof fetch;

  await new FeishuSender(fakeFetch).sendEvent(event, webhookConfig);
  assert.equal(attempts, 3);
});

test("does not retry permanent Feishu errors", async () => {
  let attempts = 0;
  const fakeFetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ code: 19001, msg: "invalid webhook" }), { status: 400 });
  }) as typeof fetch;

  await assert.rejects(() => new FeishuSender(fakeFetch).sendEvent(event, webhookConfig), /飞书发送失败/);
  assert.equal(attempts, 1);
});

test("includes the underlying network code in fetch diagnostics", () => {
  const cause = Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
  const error = new TypeError("fetch failed", { cause });
  assert.match(describeNetworkError(error).message, /fetch failed（ECONNRESET: socket disconnected）/);
});
