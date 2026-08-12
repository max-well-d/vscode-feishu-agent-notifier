import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAgentEvent } from "./event";
import { AgentEvent } from "./types";

interface PendingEventEnvelope {
  event?: unknown;
  queuedAt?: unknown;
  lastError?: unknown;
}

export interface PendingEventEntry {
  filePath: string;
  event: AgentEvent;
  queuedAt: string;
  lastError: string;
}

export interface PendingDrainResult {
  delivered: number;
  invalid: number;
  remaining: number;
}

const MAX_PENDING_FILE_BYTES = 21 * 1024 * 1024;
const MAX_PENDING_EVENTS = 100;

export async function queuePendingEvent(
  directory: string,
  event: AgentEvent,
  lastError: string
): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const fileName = [
    String(Date.now()).padStart(13, "0"),
    process.pid,
    crypto.randomBytes(6).toString("hex")
  ].join("-") + ".json";
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, `${JSON.stringify({
    event,
    queuedAt: new Date().toISOString(),
    lastError: lastError.slice(0, 500)
  })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

  const files = await pendingFileNames(directory);
  const obsolete = files.slice(0, Math.max(0, files.length - MAX_PENDING_EVENTS));
  await Promise.all(obsolete.map((name) => fs.rm(path.join(directory, name), { force: true })));
  return filePath;
}

export async function listPendingEvents(directory: string): Promise<PendingEventEntry[]> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const pending: PendingEventEntry[] = [];
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_PENDING_FILE_BYTES) {
      throw new Error(`待处理事件文件超过大小限制：${fileName}`);
    }
    const envelope = JSON.parse(await fs.readFile(filePath, "utf8")) as PendingEventEnvelope;
    if (!isObject(envelope) || !isObject(envelope.event)) {
      throw new Error(`待处理事件文件格式无效：${fileName}`);
    }
    pending.push({
      filePath,
      event: parsePendingEvent(envelope.event),
      queuedAt: typeof envelope.queuedAt === "string" ? envelope.queuedAt : "",
      lastError: typeof envelope.lastError === "string" ? envelope.lastError : ""
    });
  }
  return pending;
}

export async function drainPendingEvents(
  directory: string,
  deliver: (event: AgentEvent) => Promise<void>,
  onInvalid: (filePath: string, error: Error) => void = () => undefined,
  shouldDefer: (event: AgentEvent) => boolean = () => false
): Promise<PendingDrainResult> {
  let delivered = 0;
  let invalid = 0;
  const fileNames = await pendingFileNames(directory);

  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    let entry: PendingEventEntry;
    try {
      entry = await readPendingEvent(filePath);
    } catch (error) {
      invalid += 1;
      onInvalid(filePath, error as Error);
      await quarantineInvalidFile(filePath);
      continue;
    }

    if (shouldDefer(entry.event)) {
      continue;
    }

    try {
      await deliver(entry.event);
      await fs.rm(filePath, { force: true });
      delivered += 1;
    } catch {
      break;
    }
  }

  return {
    delivered,
    invalid,
    remaining: (await pendingFileNames(directory)).length
  };
}

export async function pendingEventCount(directory: string): Promise<number> {
  return (await pendingFileNames(directory)).length;
}

async function readPendingEvent(filePath: string): Promise<PendingEventEntry> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PENDING_FILE_BYTES) {
    throw new Error(`文件超过 ${MAX_PENDING_FILE_BYTES} 字节限制`);
  }
  const envelope = JSON.parse(await fs.readFile(filePath, "utf8")) as PendingEventEnvelope;
  if (!isObject(envelope) || !isObject(envelope.event)) {
    throw new Error("事件文件格式无效");
  }
  return {
    filePath,
    event: parsePendingEvent(envelope.event),
    queuedAt: typeof envelope.queuedAt === "string" ? envelope.queuedAt : "",
    lastError: typeof envelope.lastError === "string" ? envelope.lastError : ""
  };
}

async function pendingFileNames(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function quarantineInvalidFile(filePath: string): Promise<void> {
  const invalidPath = `${filePath}.invalid`;
  try {
    await fs.rename(filePath, invalidPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePendingEvent(value: Record<string, unknown>): AgentEvent {
  if ((value.source === "codex" || value.source === "claude-code" || value.source === "unknown")
    && (value.status === "progress" || value.status === "completed" || value.status === "failed")
    && typeof value.eventName === "string"
    && typeof value.message === "string") {
    return {
      source: value.source,
      eventName: value.eventName,
      status: value.status,
      origin: value.origin === "transcript" || value.origin === "hook" || value.origin === "display-hook" || value.origin === "notify"
        ? value.origin
        : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
      turnId: typeof value.turnId === "string" ? value.turnId : "",
      cwd: typeof value.cwd === "string" ? value.cwd : "",
      project: typeof value.project === "string" ? value.project : "unknown-project",
      message: value.message,
      occurredAt: typeof value.occurredAt === "string" ? value.occurredAt : new Date().toISOString()
    };
  }
  return normalizeAgentEvent(value);
}
