import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectNameFromCwd } from "./event";
import { AgentEvent } from "./types";

interface FileState {
  offset: number;
  pending: Buffer;
}

interface ClaudeTranscriptEntry {
  type?: unknown;
  uuid?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  isSidechain?: unknown;
  message?: Record<string, unknown>;
}

export type ClaudeTranscriptEventHandler = (event: AgentEvent) => Promise<void> | void;

export class ClaudeTranscriptWatcher {
  private readonly states = new Map<string, FileState>();
  private readonly processing = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    private readonly onEvent: ClaudeTranscriptEventHandler,
    private readonly fallbackCwd: string,
    private readonly projectsRoot = path.join(os.homedir(), ".claude", "projects"),
    private readonly onError: (error: Error) => void = () => undefined,
    private readonly pollIntervalMs = 1_500
  ) {}

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.discover(true);
    this.timer = setInterval(() => void this.discover(false), this.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.states.clear();
  }

  private async discover(initial: boolean): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      const files = new Set(this.states.keys());
      let projectDirectories: Array<{ name: string; isDirectory(): boolean }> = [];
      try {
        projectDirectories = await fs.readdir(this.projectsRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      for (const directory of projectDirectories) {
        if (!directory.isDirectory()) {
          continue;
        }
        const directoryPath = path.join(this.projectsRoot, directory.name);
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files.add(path.join(directoryPath, entry.name));
          }
        }
      }
      await Promise.all(Array.from(files, (filePath) => this.processFile(filePath, initial)));
    } catch (error) {
      this.onError(error as Error);
    }
  }

  private async processFile(filePath: string, baselineOnly: boolean): Promise<void> {
    if (!this.running || this.processing.has(filePath)) {
      return;
    }
    this.processing.add(filePath);
    try {
      const stat = await fs.stat(filePath);
      let state = this.states.get(filePath);
      if (!state) {
        state = { offset: baselineOnly ? stat.size : 0, pending: Buffer.alloc(0) };
        this.states.set(filePath, state);
        if (baselineOnly) {
          return;
        }
      }
      if (stat.size < state.offset) {
        state.offset = 0;
        state.pending = Buffer.alloc(0);
      }
      if (stat.size === state.offset) {
        return;
      }

      const handle = await fs.open(filePath, "r");
      try {
        while (state.offset < stat.size) {
          const length = Math.min(1024 * 1024, stat.size - state.offset);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
          if (bytesRead === 0) {
            break;
          }
          state.offset += bytesRead;
          await this.consumeBuffer(filePath, state, buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onError(error as Error);
      }
    } finally {
      this.processing.delete(filePath);
    }
  }

  private async consumeBuffer(filePath: string, state: FileState, next: Buffer): Promise<void> {
    const combined = state.pending.length ? Buffer.concat([state.pending, next]) : next;
    let start = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) {
        continue;
      }
      const line = combined.subarray(start, index).toString("utf8").replace(/\r$/, "");
      start = index + 1;
      const event = parseClaudeTranscriptLine(line, filePath, this.fallbackCwd);
      if (event) {
        await this.onEvent(event);
      }
    }
    state.pending = combined.subarray(start);
  }
}

export function parseClaudeTranscriptLine(
  line: string,
  filePath: string,
  fallbackCwd: string
): AgentEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }
  let entry: ClaudeTranscriptEntry;
  try {
    entry = JSON.parse(line) as ClaudeTranscriptEntry;
  } catch {
    return undefined;
  }
  if (entry.type !== "assistant"
    || entry.isSidechain === true
    || !isObject(entry.message)
    || entry.message.role !== "assistant") {
    return undefined;
  }
  const message = textContent(entry.message.content);
  if (!message) {
    return undefined;
  }
  const cwd = stringValue(entry.cwd) || fallbackCwd;
  return {
    source: "claude-code",
    eventName: "assistant-message",
    status: "progress",
    origin: "transcript",
    eventId: stringValue(entry.uuid) || `${filePath}:${entry.timestamp ?? ""}`,
    sessionId: stringValue(entry.sessionId) || sessionIdFromPath(filePath),
    turnId: stringValue(entry.uuid),
    cwd,
    project: projectNameFromCwd(cwd),
    message,
    occurredAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString()
  };
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const text = value
    .map((item) => isObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
  return text.trim() ? text : "";
}

function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
