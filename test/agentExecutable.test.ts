import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extensionExecutableCandidates, resolveAgentExecutable } from "../src/agentExecutable";

test("builds official VS Code extension CLI candidates", () => {
  assert.equal(
    extensionExecutableCandidates("codex", "C:\\extensions\\openai", "win32", "x64")[0],
    path.join("C:\\extensions\\openai", "bin", "windows-x86_64", "codex.exe")
  );
  assert.equal(
    extensionExecutableCandidates("claude-code", "C:\\extensions\\claude", "win32", "x64")[0],
    path.join("C:\\extensions\\claude", "resources", "native-binary", "claude.exe")
  );
});

test("prefers an explicit CLI and discovers an extension-bundled fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-agent-executable-"));
  try {
    const configured = path.join(root, "configured-codex.exe");
    await fs.writeFile(configured, "test");
    assert.equal(await resolveAgentExecutable("codex", {
      configuredPath: configured,
      platform: "win32",
      environmentPath: ""
    }), path.resolve(configured));

    const extensionRoot = path.join(root, "openai");
    const bundled = path.join(extensionRoot, "bin", "windows-x86_64", "codex.exe");
    await fs.mkdir(path.dirname(bundled), { recursive: true });
    await fs.writeFile(bundled, "test");
    assert.equal(await resolveAgentExecutable("codex", {
      extensionPath: extensionRoot,
      platform: "win32",
      architecture: "x64",
      environmentPath: ""
    }), path.resolve(bundled));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
