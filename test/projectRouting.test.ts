import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectDestination } from "../src/projectRouting";
import { AgentEvent, NotifierConfig } from "../src/types";

const config: NotifierConfig = {
  deliveryMode: "app",
  webhookUrl: "",
  webhookSecret: "",
  appId: "cli_test",
  appSecret: "secret",
  receiveIdType: "chat_id",
  receiveId: "oc_default",
  messageFormat: "card",
  includeMetadata: true,
  maxChunkCharacters: 3000,
  notifyOnFailure: true,
  deliveryMaxAttempts: 3,
  retryBaseDelayMs: 500
};
const event: AgentEvent = {
  source: "codex",
  eventName: "Stop",
  status: "completed",
  sessionId: "s",
  turnId: "t",
  cwd: "D:\\code\\LEADER",
  project: "LEADER",
  message: "done",
  occurredAt: new Date().toISOString()
};

test("routes app notifications by project name while preserving defaults", () => {
  assert.equal(resolveProjectDestination(config, event, { LEADER: "oc_leader" }).receiveId, "oc_leader");
  assert.equal(resolveProjectDestination(config, event, { OTHER: "oc_other" }).receiveId, "oc_default");
  assert.equal(resolveProjectDestination({ ...config, deliveryMode: "webhook" }, event, { LEADER: "oc_leader" }).receiveId, "oc_default");
});
