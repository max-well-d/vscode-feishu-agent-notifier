import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeishuConfig } from "../src/channels/feishuAdapter";

test("parseFeishuConfig normalizes untrusted plugin configuration", () => {
  const config = parseFeishuConfig({
    deliveryMode: "app",
    receiveIdType: "chat_id",
    allowedUserOpenIds: [" ou_user ", "ou_user", 42],
    maxChunkCharacters: 99_999,
    inboundEnabled: true
  });
  assert.equal(config.deliveryMode, "app");
  assert.deepEqual(config.allowedUserOpenIds, ["ou_user"]);
  assert.equal(config.maxChunkCharacters, 20_000);
  assert.equal(config.requireGroupMention, true);
});
