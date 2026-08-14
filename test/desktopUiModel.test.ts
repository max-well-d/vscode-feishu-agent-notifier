import assert from "node:assert/strict";
import test from "node:test";
import { FEISHU_CONFIG_SCHEMA } from "../src/channels/feishuAdapter";
import { visibleConfigurationKeys } from "../src/desktop/uiModel";

test("Feishu Channel exposes only fields relevant to the selected connection mode", () => {
  const properties = (FEISHU_CONFIG_SCHEMA.properties ?? {}) as Parameters<typeof visibleConfigurationKeys>[0];
  const webhook = visibleConfigurationKeys(properties, { deliveryMode: "webhook", inboundEnabled: false });
  assert.ok(webhook.includes("webhookUrl"));
  assert.ok(webhook.includes("webhookSecret"));
  assert.ok(!webhook.includes("appId"));
  assert.ok(!webhook.includes("receiveId"));
  assert.ok(!webhook.includes("allowedUserOpenIds"));

  const appOutbound = visibleConfigurationKeys(properties, { deliveryMode: "app", inboundEnabled: false });
  assert.ok(appOutbound.includes("appId"));
  assert.ok(appOutbound.includes("appSecret"));
  assert.ok(appOutbound.includes("receiveId"));
  assert.ok(appOutbound.includes("inboundEnabled"));
  assert.ok(!appOutbound.includes("webhookUrl"));
  assert.ok(!appOutbound.includes("allowedUserOpenIds"));

  const appBidirectional = visibleConfigurationKeys(properties, { deliveryMode: "app", inboundEnabled: true });
  assert.ok(appBidirectional.includes("allowedUserOpenIds"));
  assert.ok(appBidirectional.includes("allowedChatIds"));
  assert.ok(appBidirectional.includes("requireGroupMention"));
});
