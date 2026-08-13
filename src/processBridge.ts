import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectSharedCodexServer } from "./codexSharedServer";

export interface ProcessBridgeOptions {
  dataDirectory: string;
  extensionPath: string;
  runtimePath: string;
  codexExecutable: string;
  claudeExecutable: string;
}

export interface ProcessBridgeInstallation {
  root: string;
  codexLauncher: string;
  claudeLauncher: string;
  codexCliCommand: string;
  claudeCliCommand: string;
}

export interface ProcessBridgeBackup {
  protocolVersion: 1;
  installedAt: string;
  codexPrevious?: string;
  claudePrevious?: string;
  codexLauncher: string;
  claudeLauncher: string;
}

export interface ProcessBridgeInspection {
  installed: boolean;
  codexLauncher: string;
  claudeLauncher: string;
  codexLauncherExists: boolean;
  claudeLauncherExists: boolean;
  sharedCodexState: "ready" | "stale" | "stopped";
  sharedCodexPid?: number;
  sharedCodexEndpoint?: string;
}

export async function deployProcessBridge(options: ProcessBridgeOptions): Promise<ProcessBridgeInstallation> {
  const root = path.join(options.dataDirectory, "process-bridge");
  const codexDirectory = path.join(root, "codex");
  const claudeDirectory = path.join(root, "claude");
  await Promise.all([
    fs.mkdir(codexDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(claudeDirectory, { recursive: true, mode: 0o700 })
  ]);

  const bridgeScript = path.join(root, "agent-bridge.js");
  const claudeChannelScript = path.join(root, "claude-channel.js");
  await Promise.all([
    fs.copyFile(path.join(options.extensionPath, "dist", "agent-bridge.js"), bridgeScript),
    fs.copyFile(path.join(options.extensionPath, "dist", "claude-channel.js"), claudeChannelScript)
  ]);

  const codexConfig = path.join(codexDirectory, "bridge.json");
  const claudeConfig = path.join(claudeDirectory, "bridge.json");
  await Promise.all([
    writeJson(codexConfig, bridgeConfig(options, options.codexExecutable, claudeChannelScript)),
    writeJson(claudeConfig, bridgeConfig(options, options.claudeExecutable, claudeChannelScript))
  ]);

  if (process.platform === "win32") {
    const compiled = path.join(root, "BridgeLauncher.exe");
    await compileWindowsLauncher(
      path.join(options.extensionPath, "assets", "windows", "BridgeLauncher.cs"),
      compiled
    );
    const codexLauncher = path.join(codexDirectory, "codex-feishu.exe");
    const claudeLauncher = path.join(claudeDirectory, "claude-feishu.exe");
    await Promise.all([
      fs.copyFile(compiled, codexLauncher),
      fs.copyFile(compiled, claudeLauncher),
      fs.writeFile(path.join(codexDirectory, "launcher.conf"), launcherConfig(options.runtimePath, bridgeScript, "codex", codexConfig), { encoding: "utf8", mode: 0o600 }),
      fs.writeFile(path.join(claudeDirectory, "launcher.conf"), launcherConfig(options.runtimePath, bridgeScript, "claude", claudeConfig), { encoding: "utf8", mode: 0o600 })
    ]);
    return {
      root,
      codexLauncher,
      claudeLauncher,
      codexCliCommand: codexLauncher,
      claudeCliCommand: claudeLauncher
    };
  }

  const codexLauncher = path.join(codexDirectory, "codex-feishu");
  const claudeLauncher = path.join(claudeDirectory, "claude-feishu");
  await Promise.all([
    writeUnixLauncher(codexLauncher, options.runtimePath, bridgeScript, "codex", codexConfig),
    writeUnixLauncher(claudeLauncher, options.runtimePath, bridgeScript, "claude", claudeConfig)
  ]);
  return {
    root,
    codexLauncher,
    claudeLauncher,
    codexCliCommand: codexLauncher,
    claudeCliCommand: claudeLauncher
  };
}

export async function inspectProcessBridge(dataDirectory: string): Promise<ProcessBridgeInspection> {
  const root = path.join(dataDirectory, "process-bridge");
  const executableExtension = process.platform === "win32" ? ".exe" : "";
  const codexLauncher = path.join(root, "codex", `codex-feishu${executableExtension}`);
  const claudeLauncher = path.join(root, "claude", `claude-feishu${executableExtension}`);
  const [codexStat, claudeStat, shared] = await Promise.all([
    fs.stat(codexLauncher).catch(() => undefined),
    fs.stat(claudeLauncher).catch(() => undefined),
    inspectSharedCodexServer(dataDirectory)
  ]);
  return {
    installed: Boolean(codexStat?.isFile() && claudeStat?.isFile()),
    codexLauncher,
    claudeLauncher,
    codexLauncherExists: codexStat?.isFile() === true,
    claudeLauncherExists: claudeStat?.isFile() === true,
    sharedCodexState: shared.state,
    sharedCodexPid: shared.descriptor?.pid,
    sharedCodexEndpoint: shared.descriptor?.endpoint
  };
}

export async function writeProcessBridgeBackup(dataDirectory: string, value: ProcessBridgeBackup): Promise<void> {
  await writeJson(path.join(dataDirectory, "process-bridge", "settings-backup.json"), value);
}

export async function readProcessBridgeBackup(dataDirectory: string): Promise<ProcessBridgeBackup | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDirectory, "process-bridge", "settings-backup.json"), "utf8")) as Partial<ProcessBridgeBackup>;
    if (value.protocolVersion !== 1
      || typeof value.installedAt !== "string"
      || typeof value.codexLauncher !== "string"
      || typeof value.claudeLauncher !== "string") {
      return undefined;
    }
    return value as ProcessBridgeBackup;
  } catch {
    return undefined;
  }
}

function bridgeConfig(options: ProcessBridgeOptions, realExecutable: string, claudeChannelScript: string): object {
  return {
    protocolVersion: 1,
    dataDirectory: options.dataDirectory,
    realExecutable,
    runtimePath: options.runtimePath,
    claudeChannelScript
  };
}

function launcherConfig(runtime: string, script: string, mode: "codex" | "claude", config: string): string {
  return `${runtime}\n${script}\n${mode}\n${config}\n`;
}

async function compileWindowsLauncher(source: string, output: string): Promise<void> {
  await fs.rm(output, { force: true });
  const command = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -Path $env:FEISHU_BRIDGE_SOURCE -OutputAssembly $env:FEISHU_BRIDGE_OUTPUT -OutputType ConsoleApplication"
  ].join("; ");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FEISHU_BRIDGE_SOURCE: source,
        FEISHU_BRIDGE_OUTPUT: output
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`无法生成 Windows 进程桥接启动器（${code ?? -1}）：${stderr.trim()}`)));
  });
}

async function writeUnixLauncher(
  destination: string,
  runtime: string,
  script: string,
  mode: "codex" | "claude",
  config: string
): Promise<void> {
  const content = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(runtime)} ${shellQuote(script)} ${mode} --config ${shellQuote(config)} -- "$@"\n`;
  await fs.writeFile(destination, content, { encoding: "utf8", mode: 0o700 });
  await fs.chmod(destination, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
