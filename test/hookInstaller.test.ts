import assert from "node:assert/strict";
import test from "node:test";
import { mergeClaudeHooks, mergeCodexHook, NOTIFIER_MARKER, removeNotifierHooks } from "../src/hookInstaller";

const options = {
  helperPath: "C:\\Users\\me\\global storage\\feishu-agent-notifier-hook.cjs",
  port: 37561,
  token: "abc123"
};

test("merges Codex Stop hook while preserving unrelated hooks", () => {
  const document: Record<string, any> = {
    description: "existing",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "existing-tool" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "session-tool" }] }]
    }
  };

  mergeCodexHook(document, options);
  assert.equal(document.hooks.Stop.length, 2);
  assert.equal(document.hooks.SessionStart.length, 1);
  const installed = document.hooks.Stop[1].hooks[0];
  assert.match(installed.command, new RegExp(NOTIFIER_MARKER));
  assert.match(installed.commandWindows, new RegExp(NOTIFIER_MARKER));
  assert.equal(installed.async, true);
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
