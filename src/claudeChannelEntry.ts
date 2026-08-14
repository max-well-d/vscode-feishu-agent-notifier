import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrokerDescriptor, ClaudeChannelEvent } from "./brokerProtocol";

type ChannelNotification = {
  method: "notifications/claude/channel" | "notifications/claude/channel/permission";
  params: Record<string, unknown>;
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1] ?? "");
}
const configuredDataDirectory = args.get("--data-dir") ?? process.env.FEISHU_AGENT_DATA_DIRECTORY;
const configuredChannelId = args.get("--channel-id") ?? process.env.FEISHU_AGENT_CHANNEL_ID;
if (!configuredDataDirectory || !configuredChannelId) {
  process.stderr.write("Claude Channel 缺少 --data-dir 或 --channel-id\n");
  process.exit(2);
}
const dataDirectory = configuredDataDirectory as string;
const channelId = configuredChannelId as string;

/** Consecutive control-plane failures after which the channel exits on its own. */
const CONTROL_PLANE_FAILURE_LIMIT = 30;
let controlPlaneFailures = 0;

let activeEvent: ClaudeChannelEvent | undefined;
const server = new Server<any, ChannelNotification, any>(
  { name: "feishu-agent-notifier", version: "1.0.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {}
      },
      tools: {}
    } as any,
    instructions: "飞书消息会作为 channel 事件进入本会话。处理后必须调用 feishu_reply，把完整回复发回事件 meta 中的 chat_id。"
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "feishu_reply",
    description: "把 Claude 的完整回复发送回当前飞书对话",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "channel 事件中的 chat_id" },
        text: { type: "string", description: "要发送的完整回复" }
      },
      required: ["chat_id", "text"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "feishu_reply") {
    throw new Error(`未知工具：${request.params.name}`);
  }
  const values = request.params.arguments as { chat_id?: unknown; text?: unknown } | undefined;
  const chatId = typeof values?.chat_id === "string" ? values.chat_id : activeEvent?.chatId;
  const text = typeof values?.text === "string" ? values.text : "";
  if (!chatId || !text.trim()) {
    throw new Error("feishu_reply 缺少 chat_id 或 text");
  }
  await brokerFetch("POST", `/claude/channels/${encodeURIComponent(channelId)}/outbound`, {
    chatId,
    inboundMessageId: activeEvent?.inboundMessageId,
    text
  });
  return { content: [{ type: "text", text: "已发送到飞书" }] };
});

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string()
  })
});
server.setNotificationHandler(PermissionRequestSchema as any, async ({ params }: any) => {
  await brokerFetch("POST", `/claude/channels/${encodeURIComponent(channelId)}/approval`, {
    mode: "request",
    requestId: params.request_id,
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
    chatId: activeEvent?.chatId,
    inboundMessageId: activeEvent?.inboundMessageId
  });
  if (activeEvent) {
    await brokerFetch("POST", `/claude/channels/${encodeURIComponent(channelId)}/outbound`, {
      chatId: activeEvent.chatId,
      inboundMessageId: activeEvent.inboundMessageId,
      text: `Claude Code 请求权限：${params.tool_name}\n${params.description}\n审批 ID：${params.request_id}\n发送 /approve ${params.request_id} 或 /deny ${params.request_id}`
    });
  }
});

void main();

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  void pollInbound();
  void pollVerdicts();
}

async function pollInbound(): Promise<void> {
  for (;;) {
    try {
      const event = await brokerFetch<ClaudeChannelEvent & { empty?: boolean }>(
        "GET",
        `/claude/channels/${encodeURIComponent(channelId)}/next`
      );
      if (!event.empty && event.prompt) {
        activeEvent = event;
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: event.prompt,
            meta: {
              chat_id: event.chatId,
              inbound_message_id: event.inboundMessageId,
              input_origin: "feishu"
            }
          }
        });
      }
    } catch (error) {
      process.stderr.write(`Claude Channel 入站轮询失败：${(error as Error).message}\n`);
      await delay(1_000);
    }
  }
}

async function pollVerdicts(): Promise<void> {
  for (;;) {
    try {
      const verdict = await brokerFetch<{ empty?: boolean; requestId?: string; behavior?: "allow" | "deny" }>(
        "GET",
        `/claude/channels/${encodeURIComponent(channelId)}/verdict/next`
      );
      if (!verdict.empty && verdict.requestId && verdict.behavior) {
        await server.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id: verdict.requestId, behavior: verdict.behavior }
        });
      }
    } catch (error) {
      process.stderr.write(`Claude Channel 审批轮询失败：${(error as Error).message}\n`);
      await delay(1_000);
    }
  }
}

async function brokerFetch<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  try {
    const descriptor = JSON.parse(await fs.readFile(path.join(dataDirectory, "broker.json"), "utf8")) as BrokerDescriptor;
    const token = (await fs.readFile(path.join(dataDirectory, "broker-token"), "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:${descriptor.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) {
      throw new Error(typeof value.error === "string" ? value.error : `Broker HTTP ${response.status}`);
    }
    controlPlaneFailures = 0;
    return value as T;
  } catch (error) {
    controlPlaneFailures += 1;
    if (controlPlaneFailures >= CONTROL_PLANE_FAILURE_LIMIT) {
      process.stderr.write("Agent Link 控制面已关闭；Claude Channel 自动结束。\n");
      process.exit(0);
    }
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
