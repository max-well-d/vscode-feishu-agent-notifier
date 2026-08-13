import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

export interface SharedCodexDescriptor {
  protocolVersion: 1;
  pid: number;
  port: number;
  endpoint: string;
  executable: string;
  startedAt: string;
  windowsConsoleHost?: string;
}

export interface SharedCodexServerOptions {
  dataDirectory: string;
  executable: string;
  appServerArgs?: string[];
  startTimeoutMs?: number;
  log?: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
  };
}

export interface LegacySharedCodexMigrationOptions extends SharedCodexServerOptions {
  idlePollMs?: number;
  migrationTimeoutMs?: number;
}

const DESCRIPTOR_NAME = "codex-shared.json";
const LOCK_NAME = "codex-shared.lock";

export async function ensureSharedCodexServer(
  options: SharedCodexServerOptions
): Promise<SharedCodexDescriptor> {
  await fs.mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const existing = await readHealthyDescriptor(options.dataDirectory);
  if (existing) {
    await startLegacyWindowMonitor(options.dataDirectory, existing);
    return existing;
  }

  const release = await acquireLock(options.dataDirectory, options.startTimeoutMs ?? 10_000);
  try {
    const afterLock = await readHealthyDescriptor(options.dataDirectory);
    if (afterLock) {
      await startLegacyWindowMonitor(options.dataDirectory, afterLock);
      return afterLock;
    }
    const stale = await readDescriptor(options.dataDirectory);
    if (stale && processIsAlive(stale.pid)) {
      throw new Error(`Codex 共享 App Server 进程 ${stale.pid} 存在，但健康检查失败；未自动终止该进程`);
    }
    await fs.rm(path.join(options.dataDirectory, DESCRIPTOR_NAME), { force: true });

    const port = await findFreeLoopbackPort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const args = sharedAppServerArgs(endpoint, options.appServerArgs ?? []);
    const windowsConsoleHost = await resolveWindowsConsoleHost(options.dataDirectory);
    const child = spawn(windowsConsoleHost ?? options.executable, windowsConsoleHost
      ? ["--", options.executable, ...args]
      : args, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        FEISHU_AGENT_BRIDGE_BACKEND: "codex-app-server"
      }
    });
    child.unref();
    try {
      await waitUntilReady(endpoint, child.pid, options.startTimeoutMs ?? 10_000);
    } catch (error) {
      if (child.pid && processIsAlive(child.pid)) {
        child.kill();
      }
      throw error;
    }
    if (!child.pid) {
      throw new Error("Codex 共享 App Server 未返回进程 ID");
    }
    const descriptor: SharedCodexDescriptor = {
      protocolVersion: 1,
      pid: child.pid,
      port,
      endpoint,
      executable: options.executable,
      startedAt: new Date().toISOString(),
      ...(windowsConsoleHost ? { windowsConsoleHost } : {})
    };
    await atomicWriteJson(path.join(options.dataDirectory, DESCRIPTOR_NAME), descriptor);
    options.log?.info(`Codex 共享 App Server 已就绪（PID ${child.pid}，${endpoint}）。`);
    return descriptor;
  } finally {
    await release();
  }
}

/**
 * Replaces a pre-host shared server only after every loaded thread is idle.
 * The replacement keeps persisted thread ids while moving all future command
 * descendants into the native hidden-console job.
 */
export async function migrateLegacySharedCodexServer(
  options: LegacySharedCodexMigrationOptions
): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }
  const descriptor = await readHealthyDescriptor(options.dataDirectory);
  if (!descriptor || descriptor.windowsConsoleHost) {
    return false;
  }
  const host = await resolveWindowsConsoleHost(options.dataDirectory);
  if (!host) {
    return false;
  }
  const deadline = Date.now() + (options.migrationTimeoutMs ?? 60 * 60_000);
  const pollMs = Math.max(500, options.idlePollMs ?? 2_000);
  let idleSamples = 0;
  while (Date.now() < deadline && processIsAlive(descriptor.pid)) {
    const idle = await allLoadedThreadsIdle(descriptor.endpoint).catch(() => false);
    idleSamples = idle ? idleSamples + 1 : 0;
    if (idleSamples >= 2) {
      options.log?.info(`Migrating legacy Codex App Server ${descriptor.pid} to the hidden console host.`);
      await terminateProcessTree(host, descriptor.pid);
      await fs.rm(path.join(options.dataDirectory, DESCRIPTOR_NAME), { force: true });
      await fs.rm(path.join(options.dataDirectory, LOCK_NAME), { force: true });
      const replacement = await ensureSharedCodexServer(options);
      if (!replacement.windowsConsoleHost) {
        throw new Error("Codex App Server migration did not activate the hidden console host");
      }
      return true;
    }
    await delay(pollMs);
  }
  return false;
}

async function startLegacyWindowMonitor(
  dataDirectory: string,
  descriptor: SharedCodexDescriptor
): Promise<void> {
  if (descriptor.windowsConsoleHost || process.platform !== "win32") {
    return;
  }
  const host = await resolveWindowsConsoleHost(dataDirectory);
  if (!host) {
    return;
  }
  const monitor = spawn(host, ["--hide-tree", String(descriptor.pid)], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  monitor.unref();
}

async function resolveWindowsConsoleHost(dataDirectory: string): Promise<string | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDirectory, "process-bridge", "windows-console-host.json"), "utf8")) as {
      protocolVersion?: unknown;
      executable?: unknown;
    };
    if (value.protocolVersion !== 1 || typeof value.executable !== "string") {
      return undefined;
    }
    const stat = await fs.stat(value.executable);
    return stat.isFile() ? value.executable : undefined;
  } catch {
    return undefined;
  }
}

async function terminateProcessTree(host: string, pid: number): Promise<void> {
  const child = spawn(host, ["--terminate-tree", String(pid)], {
    windowsHide: true,
    stdio: "ignore"
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? -1));
  });
  if (code !== 0 || processIsAlive(pid)) {
    throw new Error(`Unable to terminate legacy Codex App Server process tree ${pid}`);
  }
}

async function allLoadedThreadsIdle(endpoint: string): Promise<boolean> {
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, {
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex migration probe timed out: ${method}`));
      }, 5_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  socket.addEventListener("message", (event) => {
    void messageText(event.data).then((text) => {
      const value = JSON.parse(text) as Record<string, unknown>;
      const id = typeof value.id === "number" ? value.id : undefined;
      if (id === undefined) return;
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      const error = recordValue(value.error);
      error
        ? item.reject(new Error(stringValue(error.message) || "Codex migration probe failed"))
        : item.resolve(recordValue(value.result) ?? {});
    }).catch(() => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex migration probe connection timed out")), 5_000);
      timer.unref();
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Codex migration probe connection failed"));
      }, { once: true });
    });
    await request("initialize", {
      clientInfo: { name: "agent_link_migration", title: "Agent Link Migration", version: "1" },
      capabilities: { experimentalApi: true }
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    const loaded = await request("thread/loaded/list", {});
    const ids = Array.isArray(loaded.data)
      ? loaded.data.filter((value): value is string => typeof value === "string")
      : [];
    for (const threadId of ids) {
      const result = await request("thread/read", { threadId, includeTurns: false });
      const thread = recordValue(result.thread);
      const status = recordValue(thread?.status);
      if (stringValue(status?.type) === "active") {
        return false;
      }
    }
    return true;
  } finally {
    socket.close();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Codex migration probe closed"));
    }
    pending.clear();
  }
}

async function messageText(value: string | ArrayBuffer | Blob): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  return value.text();
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function inspectSharedCodexServer(
  dataDirectory: string
): Promise<{ state: "ready" | "stale" | "stopped"; descriptor?: SharedCodexDescriptor }> {
  const descriptor = await readDescriptor(dataDirectory);
  if (!descriptor) {
    return { state: "stopped" };
  }
  return await isHealthy(descriptor.endpoint)
    ? { state: "ready", descriptor }
    : { state: "stale", descriptor };
}

export function sharedAppServerArgs(endpoint: string, requested: string[]): string[] {
  const appServerIndex = requested.indexOf("app-server");
  if (appServerIndex < 0) {
    return ["app-server", "--listen", endpoint];
  }
  const before = requested.slice(0, appServerIndex);
  const after: string[] = [];
  for (let index = appServerIndex + 1; index < requested.length; index += 1) {
    const value = requested[index];
    if (value === "--stdio") {
      continue;
    }
    if (value === "--listen") {
      index += 1;
      continue;
    }
    if (value.startsWith("--listen=")) {
      continue;
    }
    after.push(value);
  }
  return [...before, "app-server", ...after, "--listen", endpoint];
}

async function readHealthyDescriptor(dataDirectory: string): Promise<SharedCodexDescriptor | undefined> {
  const descriptor = await readDescriptor(dataDirectory);
  if (!descriptor || !processIsAlive(descriptor.pid)) {
    return undefined;
  }
  return await isHealthy(descriptor.endpoint) ? descriptor : undefined;
}

async function readDescriptor(dataDirectory: string): Promise<SharedCodexDescriptor | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDirectory, DESCRIPTOR_NAME), "utf8")) as Partial<SharedCodexDescriptor>;
    if (value.protocolVersion !== 1
      || typeof value.pid !== "number"
      || typeof value.port !== "number"
      || typeof value.endpoint !== "string"
      || typeof value.executable !== "string"
      || typeof value.startedAt !== "string") {
      return undefined;
    }
    return value as SharedCodexDescriptor;
  } catch {
    return undefined;
  }
}

async function acquireLock(dataDirectory: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lockPath = path.join(dataDirectory, LOCK_NAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return async () => {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("等待 Codex 共享 App Server 启动锁超时");
      }
      await delay(100);
    }
  }
}

async function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 Codex 共享 App Server 端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(endpoint: string, pid: number | undefined, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pid && !processIsAlive(pid)) {
      throw new Error("Codex 共享 App Server 在就绪前退出");
    }
    if (await isHealthy(endpoint)) {
      return;
    }
    await delay(100);
  }
  throw new Error("Codex 共享 App Server 启动超时");
}

async function isHealthy(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint.replace(/^ws:/, "http:") + "/readyz", {
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok;
  } catch {
    return false;
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

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
