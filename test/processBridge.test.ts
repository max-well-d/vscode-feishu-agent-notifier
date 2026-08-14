import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { cleanupLegacyProcessBridgeFiles, deployProcessBridge, refreshProcessBridgeRuntime, validateProcessBridgeTargets } from "../src/processBridge";

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

test("refreshes an installed process bridge from desktop bundled scripts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-link-bridge-refresh-"));
  try {
    const dist = path.join(directory, "dist");
    const bridgeRoot = path.join(directory, "data", "process-bridge");
    await Promise.all([
      fs.mkdir(dist, { recursive: true }),
      fs.mkdir(path.join(bridgeRoot, "codex"), { recursive: true })
    ]);
    await Promise.all([
      fs.writeFile(path.join(dist, "agent-bridge.js"), "new-agent", "utf8"),
      fs.writeFile(path.join(dist, "claude-channel.js"), "new-claude", "utf8"),
      fs.writeFile(path.join(bridgeRoot, "codex", "bridge.json"), "{}", "utf8"),
      fs.writeFile(path.join(bridgeRoot, "agent-bridge.js"), "old-agent", "utf8")
    ]);

    assert.equal(await refreshProcessBridgeRuntime(path.join(directory, "data"), dist), true);
    assert.equal(await fs.readFile(path.join(bridgeRoot, "agent-bridge.js"), "utf8"), "new-agent");
    assert.equal(await fs.readFile(path.join(bridgeRoot, "claude-channel.js"), "utf8"), "new-claude");
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

test("deploys a content-addressed hidden console host for shared Codex descendants", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-hidden-console-host-"));
  try {
    const extensionPath = path.join(directory, "extension");
    await fs.mkdir(path.join(extensionPath, "assets", "windows"), { recursive: true });
    await fs.mkdir(path.join(extensionPath, "dist"), { recursive: true });
    await Promise.all([
      fs.copyFile(path.resolve(__dirname, "../../assets/windows/BridgeLauncher.cs"), path.join(extensionPath, "assets", "windows", "BridgeLauncher.cs")),
      fs.copyFile(path.resolve(__dirname, "../../assets/windows/HiddenConsoleHost.cs"), path.join(extensionPath, "assets", "windows", "HiddenConsoleHost.cs")),
      fs.writeFile(path.join(extensionPath, "dist", "agent-bridge.js"), "", "utf8"),
      fs.writeFile(path.join(extensionPath, "dist", "claude-channel.js"), "", "utf8")
    ]);
    const dataDirectory = path.join(directory, "data");
    const installation = await deployProcessBridge({
      dataDirectory,
      extensionPath,
      runtimePath: process.execPath,
      codexExecutable: process.execPath,
      claudeExecutable: process.execPath
    });
    assert.match(path.basename(installation.windowsConsoleHost ?? ""), /^hidden-console-host-[0-9a-f]{12}\.exe$/);
    assert.equal((await fs.stat(installation.windowsConsoleHost as string)).isFile(), true);
    const config = JSON.parse(await fs.readFile(path.join(installation.root, "windows-console-host.json"), "utf8")) as {
      protocolVersion: number;
      executable: string;
    };
    assert.deepEqual(config, {
      protocolVersion: 1,
      executable: installation.windowsConsoleHost
    });

    const treeRoot = spawn(process.execPath, [
      "-e",
      "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((resolve, reject) => {
      treeRoot.stdout.once("data", (chunk) => resolve(Number(chunk.toString("utf8").trim())));
      treeRoot.once("error", reject);
    });
    const terminator = spawn(installation.windowsConsoleHost as string, ["--terminate-tree", String(treeRoot.pid)], {
      windowsHide: true,
      stdio: "ignore"
    });
    const terminateCode = await new Promise<number | null>((resolve, reject) => {
      terminator.once("error", reject);
      terminator.once("close", resolve);
    });
    assert.equal(terminateCode, 0);
    assert.equal(processAlive(treeRoot.pid as number), false);
    assert.equal(processAlive(childPid), false);

    const stale = path.join(installation.root, "hidden-console-host-000000000000.exe");
    await fs.writeFile(stale, "stale", "utf8");
    const removed = await cleanupLegacyProcessBridgeFiles(dataDirectory, [
      installation.codexLauncher,
      installation.claudeLauncher
    ]);
    assert.equal(removed.includes(stale), true);
    assert.equal((await fs.stat(installation.windowsConsoleHost as string)).isFile(), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
