import test from "node:test";
import assert from "node:assert/strict";
import { parseIdList, validateIdListInput, validateReceiveIdInput } from "../src/remoteConfiguration";

test("parses, trims, and deduplicates visual allowlist input", () => {
  assert.deepEqual(parseIdList("ou_one, ou_two；ou_one\nou_three"), ["ou_one", "ou_two", "ou_three"]);
});

test("validates remote user and group identifier lists", () => {
  assert.match(validateIdListInput("", "ou_", "用户 open_id", true) ?? "", /至少填写/);
  assert.match(validateIdListInput("user-one", "ou_", "用户 open_id", true) ?? "", /ou_/);
  assert.equal(validateIdListInput("ou_one,ou_two", "ou_", "用户 open_id", true), undefined);
  assert.equal(validateIdListInput("", "oc_", "群聊 chat_id", false), undefined);
});

test("validates notification target types used by the wizard", () => {
  assert.equal(validateReceiveIdInput("oc_group", "chat_id"), undefined);
  assert.equal(validateReceiveIdInput("ou_user", "open_id"), undefined);
  assert.equal(validateReceiveIdInput("person@example.com", "email"), undefined);
  assert.match(validateReceiveIdInput("ou_user", "chat_id") ?? "", /oc_/);
  assert.match(validateReceiveIdInput("not-an-email", "email") ?? "", /邮箱/);
});
