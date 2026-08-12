import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectHooks,
  installHooks,
  mergeClaudeHooks,
  mergeCodexHooks,
  mergeCodexNotify,
  NOTIFIER_MARKER,
  removeCodexNotify,
  removeNotifierHooks,
  uninstallHooks
} from "../src/hookInstaller";

const options = {
  helperPath: "C:\\Users\\me\\global storage\\feishu-agent-notifier-hook.cjs",
  tokenFilePath: "C:\\Users\\me\\global storage\\receiver-token",
  port: 37561,
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

test("merges an official Codex Stop hook without removing unrelated hooks", () => {
  const document: Record<string, any> = {
    description: "existing hooks",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }]
    }
  };
  assert.equal(mergeCodexHooks(document, options), true);
  assert.equal(mergeCodexHooks(document, options), false);
  assert.equal(document.hooks.Stop.length, 2);
  assert.equal(document.hooks.Stop[0].hooks[0].command, "keep-me");
  assert.match(document.hooks.Stop[1].hooks[0].command, /--token-file/);
  assert.doesNotMatch(document.hooks.Stop[1].hooks[0].command, /abc123/);
  assert.match(document.hooks.Stop[1].hooks[0].commandWindows, new RegExp(NOTIFIER_MARKER));
});

test("merges Claude completion and MessageDisplay hooks idempotently", () => {
  const document: Record<string, any> = { hooks: {} };
  mergeClaudeHooks(document, options);
  assert.equal(mergeClaudeHooks(document, options), false);

  assert.equal(document.hooks.Stop.length, 1);
  assert.equal(document.hooks.StopFailure.length, 1);
  assert.equal(document.hooks.MessageDisplay.length, 1);
  assert.ok(document.hooks.Stop[0].hooks[0].args.includes(NOTIFIER_MARKER));
  assert.deepEqual(
    document.hooks.MessageDisplay[0].hooks[0].args.slice(-2),
    ["--queue-offline", "false"]
  );
});

test("removes only notifier hook groups", () => {
  const document: Record<string, any> = { hooks: {} };
  mergeClaudeHooks(document, options);
  document.hooks.Stop.push({ hooks: [{ type: "command", command: "keep-me" }] });

  assert.equal(removeNotifierHooks(document), true);
  assert.equal(document.hooks.Stop.length, 1);
  assert.equal(document.hooks.Stop[0].hooks[0].command, "keep-me");
  assert.equal(document.hooks.StopFailure, undefined);
  assert.equal(document.hooks.MessageDisplay, undefined);
});

test("installs inspectable hooks and restores unrelated Codex notify", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-hooks-test-"));
  t.after(async () => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".codex", "config.toml"),
    'notify = ["python", "old-notify.py"]\n[features]\nexample = true\n',
    "utf8"
  );

  await installHooks({ ...options, homeDirectory: home });
  const inspection = await inspectHooks(home);
  assert.equal(inspection.codexInstalled, true);
  assert.equal(inspection.codexNotifyInstalled, true);
  assert.equal(inspection.codexStopInstalled, true);
  assert.equal(inspection.claudeStopInstalled, true);
  assert.equal(inspection.claudeStopFailureInstalled, true);
  assert.equal(inspection.claudeMessageDisplayInstalled, true);

  await uninstallHooks(home);
  const restored = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(restored, /notify = \["python", "old-notify\.py"\]/);
  assert.doesNotMatch(restored, new RegExp(NOTIFIER_MARKER));
  const hooks = JSON.parse(await fs.readFile(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.deepEqual(hooks.hooks, {});
});
