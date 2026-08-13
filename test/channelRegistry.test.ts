import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelRegistry } from "../src/channels/registry";
import {
  CHANNEL_API_VERSION,
  ChannelAdapter,
  ChannelInboundMessage,
  ChannelManifest,
  ChannelRuntimeContext
} from "../src/channels/types";
import { AgentEvent } from "../src/types";

test("ChannelRegistry starts, broadcasts and stops adapters independently", async () => {
  const adapter = new FakeAdapter();
  const inbound: ChannelInboundMessage[] = [];
  const registry = new ChannelRegistry({ onMessage: (message) => { inbound.push(message); } });
  registry.register(adapter);
  await registry.configure("test-channel", {
    enabled: true,
    config: { token: "secret" },
    defaultTarget: { conversationId: "room-1" }
  });

  assert.equal(adapter.starts, 1);
  assert.equal(registry.snapshots()[0].state, "connected");
  const result = await registry.broadcast(agentEvent());
  assert.equal((result["test-channel"] as { count: number }).count, 1);
  assert.equal(adapter.lastTarget, "room-1");

  await adapter.context!.onMessage({
    channelId: "test-channel",
    messageId: "message-1",
    conversationId: "room-1",
    conversationType: "direct",
    senderId: "user-1",
    text: "continue",
    mentionedAdapter: false,
    receivedAt: new Date().toISOString()
  });
  assert.equal(inbound[0].text, "continue");

  await registry.configure("test-channel", { enabled: false, config: { token: "secret" } });
  assert.equal(adapter.stops, 1);
  assert.equal(registry.snapshots()[0].state, "disabled");
});

test("ChannelRegistry rejects duplicate and incompatible adapters", () => {
  const registry = new ChannelRegistry({ onMessage: () => undefined });
  registry.register(new FakeAdapter());
  assert.throws(() => registry.register(new FakeAdapter()), /已注册/);
  const incompatible = new FakeAdapter();
  incompatible.manifest.apiVersion = 2 as 1;
  assert.throws(() => new ChannelRegistry({ onMessage: () => undefined }).register(incompatible), /不兼容/);
});

test("ChannelRegistry can persist an incomplete disabled channel", async () => {
  const registry = new ChannelRegistry({ onMessage: () => undefined });
  registry.register(new FakeAdapter());
  await registry.configure("test-channel", { enabled: false, config: {} });
  assert.equal(registry.snapshots()[0].state, "disabled");
});

class FakeAdapter implements ChannelAdapter {
  public readonly manifest: ChannelManifest = {
    apiVersion: CHANNEL_API_VERSION,
    id: "test-channel",
    name: "Test",
    version: "1.0.0",
    description: "test",
    capabilities: ["outbound", "inbound"] as Array<"outbound" | "inbound">
  };
  public starts = 0;
  public stops = 0;
  public lastTarget: string | undefined;
  public context: ChannelRuntimeContext | undefined;

  public validate(config: Record<string, unknown>): void {
    if (!config.token) throw new Error("missing token");
  }
  public async start(_config: Record<string, unknown>, context: ChannelRuntimeContext): Promise<void> {
    this.starts += 1;
    this.context = context;
    await context.onState("connected");
  }
  public async stop(): Promise<void> { this.stops += 1; }
  public async send(_event: AgentEvent, target: { conversationId: string } | undefined): Promise<{ count: number; receipts: [] }> {
    this.lastTarget = target?.conversationId;
    return { count: 1, receipts: [] };
  }
}

function agentEvent(): AgentEvent {
  return {
    source: "codex",
    eventName: "turn/completed",
    status: "completed",
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "C:\\repo",
    project: "repo",
    message: "done",
    occurredAt: new Date().toISOString()
  };
}
