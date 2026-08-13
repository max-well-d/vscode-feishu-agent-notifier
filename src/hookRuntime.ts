import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface HookRuntimeOptions {
  dataDirectory: string;
  helperSourcePath: string;
  launcherSourcePath: string;
}

export interface HookRuntimeInstallation {
  root: string;
  helperPath: string;
  commandPath?: string;
}

export async function deployLegacyWindowMonitor(dataDirectory: string, sourcePath: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const root = path.join(dataDirectory, "process-bridge");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const hostId = await contentId(sourcePath, "hidden-console-host");
  const hostPath = path.join(root, `hidden-console-host-${hostId}.exe`);
  if (!(await fs.stat(hostPath).catch(() => undefined))?.isFile()) {
    await compileWindowsLauncher(sourcePath, hostPath);
  }
  await atomicWrite(path.join(root, "windows-console-host.json"), `${JSON.stringify({
    protocolVersion: 1,
    executable: hostPath
  }, null, 2)}\n`);
  const descriptor = await readSharedDescriptor(dataDirectory);
  if (descriptor && processIsAlive(descriptor.pid) && !descriptor.windowsConsoleHost) {
    const monitor = spawn(hostPath, ["--hide-tree", String(descriptor.pid)], {
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    monitor.unref();
  }
  return hostPath;
}

export async function deployHookRuntime(options: HookRuntimeOptions): Promise<HookRuntimeInstallation> {
  const root = path.join(options.dataDirectory, "hook-runtime");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const helperId = await contentId(options.helperSourcePath, "agent-hook");
  const helperPath = path.join(root, `agent-hook-${helperId}.cjs`);
  await copyFileIfMissing(options.helperSourcePath, helperPath);

  if (process.platform !== "win32") {
    return { root, helperPath };
  }

  const launcherId = await contentId(options.launcherSourcePath, "windows-hook-launcher");
  const commandPath = path.join(root, `agent-link-hook-${launcherId}.exe`);
  if (!(await fs.stat(commandPath).catch(() => undefined))?.isFile()) {
    await compileWindowsLauncher(options.launcherSourcePath, commandPath);
  }
  return { root, helperPath, commandPath };
}

async function compileWindowsLauncher(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp.exe`;
  const sourceCopy = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp.cs`;
  const command = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -Path $env:AGENT_LINK_HOOK_SOURCE -OutputAssembly $env:AGENT_LINK_HOOK_OUTPUT -OutputType WindowsApplication"
  ].join("; ");
  try {
    // Electron's fs layer can read files inside app.asar, while external PowerShell cannot.
    await fs.copyFile(source, sourceCopy);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AGENT_LINK_HOOK_SOURCE: sourceCopy,
          AGENT_LINK_HOOK_OUTPUT: temporary
        }
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`无法生成无窗口 Hook 启动器（${code ?? -1}）：${stderr.trim()}`)));
    });
    await fs.rename(temporary, destination).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } finally {
    await Promise.all([
      fs.rm(temporary, { force: true }).catch(() => undefined),
      fs.rm(sourceCopy, { force: true }).catch(() => undefined)
    ]);
  }
}

async function contentId(filePath: string, discriminator: string): Promise<string> {
  return crypto.createHash("sha256")
    .update(discriminator)
    .update("\0")
    .update(await fs.readFile(filePath))
    .digest("hex")
    .slice(0, 12);
}

async function copyFileIfMissing(source: string, destination: string): Promise<void> {
  if ((await fs.stat(destination).catch(() => undefined))?.isFile()) return;
  await fs.copyFile(source, destination);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function readSharedDescriptor(dataDirectory: string): Promise<{ pid: number; windowsConsoleHost?: string } | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDirectory, "codex-shared.json"), "utf8")) as {
      pid?: unknown;
      windowsConsoleHost?: unknown;
    };
    return typeof value.pid === "number"
      ? { pid: value.pid, ...(typeof value.windowsConsoleHost === "string" ? { windowsConsoleHost: value.windowsConsoleHost } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
