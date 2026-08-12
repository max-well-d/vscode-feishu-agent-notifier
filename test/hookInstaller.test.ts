import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeClaudeHooks,
  mergeCodexNotify,
  NOTIFIER_MARKER,
  removeCodexNotify,
  removeNotifierHooks
} from "../src/hookInstaller";

const options = {
  helperPath: "C:\\Users\\me\\global storage\\feishu-agent-notifier-hook.cjs",
  port: 37561,
  token: "abc123"
};

test("merges Codex notify before TOML tables", () => {
  const original = 'model = "gpt-5"\n\n[features]\nmemories = true\n';
  const result = mergeCodexNotify(original, options);

  assert.equal(result.changed, true);
  assert.equal(result.previousNotify, null);
  assert.match(result.text, new RegExp(`notify = .*${NOTIFIER_MARKER}`));
  assert.ok(result.text.indexOf("notify =") < result.text.indexOf("[features]"));
});

test("replaces and restores an existing multiline Codex notify", () => {
  const original = [
    'model = "gpt-5"',
    "notify = [",
    '  "python",',
    '  "C:\\\\tools\\\\old.py"',
    "]",
    "",
    "[features]",
    "hooks = true",
    ""
  ].join("\n");
  const merged = mergeCodexNotify(original, options);

  assert.equal(merged.previousNotify, 'notify = [\n  "python",\n  "C:\\\\tools\\\\old.py"\n]');
  assert.equal((merged.text.match(/^notify\s*=/gm) ?? []).length, 1);

  const removed = removeCodexNotify(merged.text, merged.previousNotify ?? null);
  assert.equal(removed.changed, true);
  assert.match(removed.text, /notify = \[\n  "python",/);
  assert.doesNotMatch(removed.text, new RegExp(NOTIFIER_MARKER));
});

test("updates its own Codex notify idempotently without losing saved state", () => {
  const first = mergeCodexNotify("", options);
  const second = mergeCodexNotify(first.text, options);
  assert.equal(second.changed, false);
  assert.equal(second.previousNotify, undefined);
});

test("merges Claude Stop and StopFailure hooks idempotently", () => {
  const document: Record<string, any> = { hooks: {} };
  mergeClaudeHooks(document, options);
  mergeClaudeHooks(document, options);

  assert.equal(document.hooks.Stop.length, 1);
  assert.equal(document.hooks.StopFailure.length, 1);
  assert.ok(document.hooks.Stop[0].hooks[0].args.includes(NOTIFIER_MARKER));
});

test("removes only notifier hook groups", () => {
  const document: Record<string, any> = { hooks: {} };
  mergeClaudeHooks(document, options);
  document.hooks.Stop.push({ hooks: [{ type: "command", command: "keep-me" }] });

  assert.equal(removeNotifierHooks(document), true);
  assert.equal(document.hooks.Stop.length, 1);
  assert.equal(document.hooks.Stop[0].hooks[0].command, "keep-me");
  assert.equal(document.hooks.StopFailure, undefined);
});
