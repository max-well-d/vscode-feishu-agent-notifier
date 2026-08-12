import assert from "node:assert/strict";
import test from "node:test";
import {
  detectAgentCapabilities,
  parseCodexHookFeature,
  parseVersion,
  versionAtLeast
} from "../src/agentCapabilities";

test("parses agent versions and Codex hook feature output", () => {
  assert.equal(parseVersion("codex-cli 0.147.0-alpha.6.5"), "0.147.0-alpha.6.5");
  assert.equal(parseVersion("2.1.165 (Claude Code)"), "2.1.165");
  assert.equal(parseCodexHookFeature("hooks  stable  true\nother experimental false"), true);
  assert.equal(parseCodexHookFeature("hooks stable false"), false);
});

test("compares semantic version cores for MessageDisplay support", () => {
  assert.equal(versionAtLeast("2.1.165", "2.1.166"), false);
  assert.equal(versionAtLeast("2.1.166", "2.1.166"), true);
  assert.equal(versionAtLeast("3.0.0-alpha.1", "2.1.166"), true);
});

test("detects supported and degraded agent channels", async () => {
  const output = new Map([
    ["codex --version", "codex-cli 0.147.0-alpha.6.5"],
    ["codex features list", "hooks stable true"],
    ["claude --version", "2.1.165 (Claude Code)"]
  ]);
  const capabilities = await detectAgentCapabilities(async (command, args) => {
    return output.get(`${command} ${args.join(" ")}`);
  });
  assert.equal(capabilities.codexStopHook, true);
  assert.equal(capabilities.claudeMessageDisplay, false);
  assert.equal(capabilities.claudeVersion, "2.1.165");
});
