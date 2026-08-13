import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { cleanupLegacyProcessBridgeFiles, validateProcessBridgeTargets } from "../src/processBridge";

test("rejects a bridge launcher as the real Agent executable", () => {
  const dataDirectory = path.join(os.tmpdir(), "feishu-bridge-validation");
  assert.throws(() => validateProcessBridgeTargets({
    dataDirectory,
    extensionPath: path.join(os.tmpdir(), "extension"),
    runtimePath: process.execPath,
    codexExecutable: path.join(dataDirectory, "process-bridge", "codex", "codex-feishu.exe"),
    claudeExecutable: path.join(os.tmpdir(), "claude.exe")
  }), /不能指向 Feishu Agent 进程桥接目录/);
});

test("uses the original executable when the bridge config cannot be read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-bridge-config-"));
  try {
    const echoScript = path.join(directory, "echo.js");
    await fs.writeFile(echoScript, "process.stdout.write(process.argv.slice(2).join(' '));\n", "utf8");
    const result = await runBridge([
      "codex",
      "--config", path.join(directory, "missing.json"),
      "--fallback-executable", process.execPath,
      "--",
      echoScript,
      "config-fallback-ok"
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "config-fallback-ok");
    assert.match(result.stderr, /starting the original Agent/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("uses the original Claude process when Channel injection setup fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-bridge-channel-"));
  try {
    const blockedDataPath = path.join(directory, "not-a-directory");
    const echoScript = path.join(directory, "echo.js");
    const configPath = path.join(directory, "bridge.json");
    await fs.writeFile(blockedDataPath, "file", "utf8");
    await fs.writeFile(echoScript, "process.stdout.write(process.argv.slice(2).join(' '));\n", "utf8");
    await fs.writeFile(configPath, JSON.stringify({
      protocolVersion: 1,
      dataDirectory: blockedDataPath,
      realExecutable: process.execPath,
      runtimePath: process.execPath,
      claudeChannelScript: echoScript
    }), "utf8");
    const result = await runBridge([
      "claude",
      "--config", configPath,
      "--fallback-executable", process.execPath,
      "--",
      process.execPath,
      echoScript,
      "channel-fallback-ok"
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "channel-fallback-ok");
    assert.match(result.stderr, /starting the original Agent/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cleans only unprotected legacy Windows bridge launchers", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-bridge-cleanup-"));
  try {
    const codex = path.join(directory, "process-bridge", "codex", "codex-feishu.exe");
    const claude = path.join(directory, "process-bridge", "claude", "claude-feishu.exe");
    await fs.mkdir(path.dirname(codex), { recursive: true });
    await fs.mkdir(path.dirname(claude), { recursive: true });
    await Promise.all([fs.writeFile(codex, "old"), fs.writeFile(claude, "active")]);
    const removed = await cleanupLegacyProcessBridgeFiles(directory, [claude]);
    assert.deepEqual(removed, [codex]);
    assert.equal(await fs.stat(codex).catch(() => undefined), undefined);
    assert.equal((await fs.stat(claude)).isFile(), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function runBridge(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bridgeEntry = path.resolve(__dirname, "../src/agentBridge.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgeEntry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
