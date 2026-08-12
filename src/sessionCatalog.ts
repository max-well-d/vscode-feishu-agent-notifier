import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "./types";

interface SessionCatalogOptions {
  codexRoot?: string;
  claudeRoot?: string;
  maximumFiles?: number;
  now?: () => Date;
}

interface FileCandidate {
  source: AgentSession["source"];
  filePath: string;
  modifiedAt: Date;
}

export async function discoverLocalSessions(options: SessionCatalogOptions = {}): Promise<AgentSession[]> {
  const codexRoot = options.codexRoot ?? path.join(os.homedir(), ".codex", "sessions");
  const claudeRoot = options.claudeRoot ?? path.join(os.homedir(), ".claude", "projects");
  const maximumFiles = options.maximumFiles ?? 300;
  const now = options.now?.() ?? new Date();
  const [codexFiles, claudeFiles] = await Promise.all([
    discoverJsonl(codexRoot, "codex"),
    discoverJsonl(claudeRoot, "claude-code")
  ]);
  const candidates = [...codexFiles, ...claudeFiles]
    .sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime())
    .slice(0, maximumFiles);
  const sessions = await Promise.all(candidates.map((candidate) => parseCandidate(candidate, now)));
  const unique = new Map<string, AgentSession>();
  for (const session of sessions) {
    if (!session) {
      continue;
    }
    const key = `${session.source}:${session.sessionId}`;
    const previous = unique.get(key);
    if (!previous || Date.parse(session.lastSeenAt) > Date.parse(previous.lastSeenAt)) {
      unique.set(key, session);
    }
  }
  return Array.from(unique.values())
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
}

async function discoverJsonl(root: string, source: AgentSession["source"]): Promise<FileCandidate[]> {
  const result: FileCandidate[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop() as string;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await fs.stat(entryPath);
        result.push({ source, filePath: entryPath, modifiedAt: stat.mtime });
      }
    }
  }
  return result;
}

async function parseCandidate(candidate: FileCandidate, now: Date): Promise<AgentSession | undefined> {
  const handle = await fs.open(candidate.filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    let sessionId = sessionIdFromFile(candidate.filePath);
    let cwd = "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const payload = recordValue(entry.payload);
        sessionId = stringValue(entry.sessionId)
          || stringValue(entry.session_id)
          || stringValue(payload?.id)
          || stringValue(payload?.session_id)
          || sessionId;
        cwd = stringValue(entry.cwd) || stringValue(payload?.cwd) || cwd;
        if (sessionId && cwd) {
          break;
        }
      } catch {
        // Ignore a partial final JSONL line or an entry from a newer schema.
      }
    }
    if (!sessionId) {
      return undefined;
    }
    const age = now.getTime() - candidate.modifiedAt.getTime();
    return {
      source: candidate.source,
      sessionId,
      cwd,
      project: cwd ? path.basename(cwd) : path.basename(path.dirname(candidate.filePath)),
      lastSeenAt: candidate.modifiedAt.toISOString(),
      status: age >= 0 && age < 10_000 ? "progress" : "completed"
    };
  } finally {
    await handle.close();
  }
}

function sessionIdFromFile(filePath: string): string {
  const name = path.basename(filePath, ".jsonl");
  return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? name;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
