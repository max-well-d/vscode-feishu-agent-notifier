import crypto from "node:crypto";
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
  validateProcessBridgeTargets(options, root);
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
    const source = path.join(options.extensionPath, "assets", "windows", "BridgeLauncher.cs");
    const compiled = path.join(root, "BridgeLauncher.exe");
    const compiledWindow = path.join(root, "BridgeLauncherWindow.exe");
    await Promise.all([
      compileWindowsLauncher(source, compiled, false),
      compileWindowsLauncher(source, compiledWindow, true)
    ]);
    const [consoleId, windowId] = await Promise.all([
      fileContentId(source, "console"),
      fileContentId(source, "window"),
    ]);
    const codexLauncher = path.join(codexDirectory, `codex-feishu-${consoleId}.exe`);
    const claudeLauncher = path.join(claudeDirectory, `claude-feishu-wrapper-${windowId}.exe`);
    const claudeCliLauncher = path.join(claudeDirectory, `claude-feishu-${consoleId}.exe`);
    await Promise.all([
      copyFileIfMissing(compiled, codexLauncher),
      copyFileIfMissing(compiledWindow, claudeLauncher),
      copyFileIfMissing(compiled, claudeCliLauncher),
      fs.writeFile(path.join(codexDirectory, "launcher.conf"), launcherConfig(options.runtimePath, bridgeScript, "codex", codexConfig, options.codexExecutable, false), { encoding: "utf8", mode: 0o600 }),
      fs.writeFile(path.join(claudeDirectory, "launcher.conf"), launcherConfig(options.runtimePath, bridgeScript, "claude", claudeConfig, options.claudeExecutable, true), { encoding: "utf8", mode: 0o600 }),
      fs.writeFile(path.join(claudeDirectory, "launcher-cli.conf"), launcherConfig(options.runtimePath, bridgeScript, "claude", claudeConfig, options.claudeExecutable, false), { encoding: "utf8", mode: 0o600 })
    ]);
    return {
      root,
      codexLauncher,
      claudeLauncher,
      codexCliCommand: codexLauncher,
      claudeCliCommand: claudeCliLauncher
    };
  }

  const codexLauncher = path.join(codexDirectory, "codex-feishu");
  const claudeLauncher = path.join(claudeDirectory, "claude-feishu");
  await Promise.all([
    writeUnixLauncher(codexLauncher, options.runtimePath, bridgeScript, "codex", codexConfig, options.codexExecutable),
    writeUnixLauncher(claudeLauncher, options.runtimePath, bridgeScript, "claude", claudeConfig, options.claudeExecutable)
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
  const backup = await readProcessBridgeBackup(dataDirectory);
  const codexLauncher = backup?.codexLauncher
    ?? path.join(root, "codex", `codex-feishu${executableExtension}`);
  const claudeLauncher = backup?.claudeLauncher
    ?? path.join(root, "claude", process.platform === "win32"
      ? "claude-feishu-wrapper.exe"
      : `claude-feishu${executableExtension}`);
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

export async function cleanupLegacyProcessBridgeFiles(
  dataDirectory: string,
  protectedPaths: Array<string | undefined> = []
): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const root = path.join(dataDirectory, "process-bridge");
  const protectedSet = new Set(protectedPaths.filter((value): value is string => Boolean(value)).map((value) => path.resolve(value).toLowerCase()));
  for (const protectedPath of [...protectedSet]) {
    const match = path.basename(protectedPath).match(/^codex-feishu-([0-9a-f]{12})\.exe$/i);
    if (match) {
      protectedSet.add(path.resolve(root, "claude", `claude-feishu-${match[1]}.exe`).toLowerCase());
    }
  }
  const candidates = [
    path.join(root, "BridgeLauncher.exe"),
    path.join(root, "BridgeLauncherWindow.exe"),
    ...await matchingFiles(path.join(root, "codex"), /^codex-feishu(?:-[0-9a-f]{12})?\.exe$/i),
    ...await matchingFiles(path.join(root, "claude"), /^claude-feishu(?:-wrapper)?(?:-[0-9a-f]{12})?\.exe$/i)
  ];
  const removed: string[] = [];
  for (const candidate of candidates) {
    if (protectedSet.has(path.resolve(candidate).toLowerCase())) {
      continue;
    }
    if (!(await fs.stat(candidate).catch(() => undefined))?.isFile()) {
      continue;
    }
    try {
      await fs.rm(candidate, { force: true });
      removed.push(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
    }
  }
  return removed;
}

async function matchingFiles(directory: string, pattern: RegExp): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
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

function launcherConfig(
  runtime: string,
  script: string,
  mode: "codex" | "claude",
  config: string,
  fallbackExecutable: string,
  hideWindow = false
): string {
  return `${runtime}\n${script}\n${mode}\n${config}\n${fallbackExecutable}\n${hideWindow ? "1" : "0"}\n`;
}

export function validateProcessBridgeTargets(options: ProcessBridgeOptions, bridgeRoot?: string): void {
  const root = path.resolve(bridgeRoot ?? path.join(options.dataDirectory, "process-bridge"));
  for (const [name, executable] of [
    ["Codex", options.codexExecutable],
    ["Claude Code", options.claudeExecutable]
  ] as const) {
    const resolved = path.resolve(executable);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`${name} 真实可执行文件不能指向 Feishu Agent 进程桥接目录：${resolved}`);
    }
  }
}

async function compileWindowsLauncher(source: string, output: string, windowApplication: boolean): Promise<void> {
  await fs.rm(output, { force: true });
  const command = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -Path $env:FEISHU_BRIDGE_SOURCE -OutputAssembly $env:FEISHU_BRIDGE_OUTPUT -OutputType $env:FEISHU_BRIDGE_OUTPUT_TYPE"
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
        FEISHU_BRIDGE_OUTPUT: output,
        FEISHU_BRIDGE_OUTPUT_TYPE: windowApplication ? "WindowsApplication" : "ConsoleApplication"
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
  config: string,
  fallbackExecutable: string
): Promise<void> {
  const content = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(runtime)} ${shellQuote(script)} ${mode} --config ${shellQuote(config)} --fallback-executable ${shellQuote(fallbackExecutable)} -- "$@"\n`;
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

async function fileContentId(filePath: string, discriminator: string): Promise<string> {
  return crypto.createHash("sha256")
    .update(discriminator)
    .update("\0")
    .update(await fs.readFile(filePath))
    .digest("hex")
    .slice(0, 12);
}

async function copyFileIfMissing(source: string, destination: string): Promise<void> {
  if ((await fs.stat(destination).catch(() => undefined))?.isFile()) {
    return;
  }
  try {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}
