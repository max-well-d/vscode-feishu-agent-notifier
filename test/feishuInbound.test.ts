import assert from "node:assert/strict";
import test from "node:test";
import { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { normalizeInboundMessage } from "../src/feishuInbound";

const message: NormalizedMessage = {
  messageId: "om_in",
  chatId: "oc_allowed",
  chatType: "group",
  senderId: "ou_allowed",
  content: "@_user_1 continue",
  rawContentType: "text",
  resources: [],
  mentions: [{ key: "@_user_1", openId: "ou_bot", isBot: true }],
  mentionAll: false,
  mentionedBot: true,
  replyToMessageId: "om_parent",
  rootId: "om_root",
  createTime: Date.now()
};

test("accepts only allowlisted users and groups and strips bot mentions", () => {
  const config = {
    allowedUserOpenIds: ["ou_allowed"],
    allowedChatIds: ["oc_allowed"],
    requireGroupMention: true
  };
  const normalized = normalizeInboundMessage(message, config);
  assert.equal(normalized?.text, "continue");
  assert.equal(normalized?.parentMessageId, "om_parent");
  assert.equal(normalizeInboundMessage({ ...message, senderId: "ou_other" }, config), undefined);
  assert.equal(normalizeInboundMessage({ ...message, mentionedBot: false }, config), undefined);
  assert.equal(normalizeInboundMessage({ ...message, chatId: "oc_other" }, config), undefined);
});
