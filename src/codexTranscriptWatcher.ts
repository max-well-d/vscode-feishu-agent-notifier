import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentEvent, DeliveryTiming } from "./types";
import { projectNameFromCwd } from "./event";

interface FileState {
  offset: number;
  pending: Buffer;
  cwdByTurnId: Map<string, string>;
  finalMessageByTurnId: Map<string, string>;
}

interface TranscriptEntry {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

export type TranscriptEventHandler = (event: AgentEvent) => Promise<void> | void;

export class CodexTranscriptWatcher {
  private readonly states = new Map<string, FileState>();
  private readonly processing = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    private readonly onEvent: TranscriptEventHandler,
    private readonly fallbackCwd: string,
    private readonly sessionsRoot = path.join(os.homedir(), ".codex", "sessions"),
    private readonly onError: (error: Error) => void = () => undefined,
    private readonly pollIntervalMs = 1_500,
    private readonly deliveryTiming: DeliveryTiming = "completion"
  ) {}

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.discover(true);
    this.timer = setInterval(() => {
      void this.discover(false);
    }, this.pollIntervalMs);
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
      const filePaths = new Set(this.states.keys());
      for (const directory of recentDateDirectories(this.sessionsRoot)) {
        try {
          const entries = await fs.readdir(directory, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              filePaths.add(path.join(directory, entry.name));
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }

      await Promise.all(Array.from(filePaths, (filePath) => this.processFile(filePath, initial)));
    } catch (error) {
      this.onError(error as Error);
    }
  }

  private async processFile(filePath: string, baselineOnly: boolean): Promise<void> {
    if (this.processing.has(filePath) || !this.running) {
      return;
    }
    this.processing.add(filePath);
    try {
      const stat = await fs.stat(filePath);
      let state = this.states.get(filePath);
      if (!state) {
        state = {
          offset: baselineOnly ? stat.size : 0,
          pending: Buffer.alloc(0),
          cwdByTurnId: new Map(),
          finalMessageByTurnId: new Map()
        };
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
      const event = parseCodexTranscriptLine(
        line,
        filePath,
        state,
        this.fallbackCwd,
        this.deliveryTiming
      );
      if (event) {
        await this.onEvent(event);
      }
    }
    state.pending = combined.subarray(start);
  }
}

export function parseCodexTranscriptLine(
  line: string,
  filePath: string,
  state: Pick<FileState, "cwdByTurnId" | "finalMessageByTurnId">,
  fallbackCwd: string,
  deliveryTiming: DeliveryTiming = "completion"
): AgentEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }

  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(line) as TranscriptEntry;
  } catch {
    return undefined;
  }
  const payload = entry.payload;
  if (!payload) {
    return undefined;
  }

  if (entry.type === "turn_context") {
    const turnId = stringValue(payload.turn_id);
    const cwd = stringValue(payload.cwd);
    if (turnId && cwd) {
      state.cwdByTurnId.set(turnId, cwd);
    }
    return undefined;
  }

  if (entry.type === "response_item"
    && payload.type === "message"
    && payload.role === "assistant") {
    const metadata = isObject(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : {};
    const turnId = stringValue(metadata.turn_id);
    const message = messageContent(payload.content);
    const phase = stringValue(payload.phase);
    if (phase === "final_answer" && turnId && message) {
      state.finalMessageByTurnId.set(turnId, message);
    }
    if (deliveryTiming === "realtime"
      && (phase === "commentary" || phase === "final_answer")
      && message) {
      const cwd = state.cwdByTurnId.get(turnId) || fallbackCwd;
      return {
        source: "codex",
        eventName: `assistant-message:${phase}`,
        status: phase === "final_answer" ? "completed" : "progress",
        origin: "transcript",
        eventId: messageEventId(entry.timestamp, phase, turnId, message),
        sessionId: sessionIdFromPath(filePath),
        turnId,
        cwd,
        project: projectNameFromCwd(cwd),
        message,
        occurredAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString()
      };
    }
    return undefined;
  }

  if (entry.type !== "event_msg" || payload.type !== "task_complete") {
    return undefined;
  }

  const turnId = stringValue(payload.turn_id);
  const message = stringValue(payload.last_agent_message)
    || state.finalMessageByTurnId.get(turnId)
    || "Codex IDE 已完成，但 transcript 没有提供最终回复内容。";
  const cwd = state.cwdByTurnId.get(turnId) || fallbackCwd;
  state.cwdByTurnId.delete(turnId);
  state.finalMessageByTurnId.delete(turnId);

  if (deliveryTiming === "realtime") {
    return undefined;
  }

  return {
    source: "codex",
    eventName: "agent-turn-complete",
    status: "completed",
    origin: "transcript",
    sessionId: sessionIdFromPath(filePath),
    turnId,
    cwd,
    project: projectNameFromCwd(cwd),
    message,
    occurredAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString()
  };
}

function recentDateDirectories(root: string): string[] {
  const directories: string[] = [];
  for (let daysAgo = 0; daysAgo <= 1; daysAgo += 1) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    directories.push(path.join(
      root,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ));
  }
  return directories;
}

function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? filePath;
}

function messageContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => isObject(item) && typeof item.text === "string" ? item.text : "")
    .join("");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageEventId(timestamp: unknown, phase: string, turnId: string, message: string): string {
  return crypto.createHash("sha256")
    .update(`${typeof timestamp === "string" ? timestamp : ""}\0${phase}\0${turnId}\0${message}`)
    .digest("hex");
}
