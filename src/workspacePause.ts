import fs from "node:fs/promises";
import path from "node:path";
import { eventBelongsToWorkspace } from "./event";

interface PauseDocument {
  roots?: unknown;
}

export async function readPausedWorkspaceRoots(filePath: string): Promise<string[]> {
  try {
    const document = JSON.parse(await fs.readFile(filePath, "utf8")) as PauseDocument;
    return Array.isArray(document.roots)
      ? document.roots.filter((value): value is string => typeof value === "string")
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

export async function setWorkspacePaused(
  filePath: string,
  workspaceRoots: string[],
  paused: boolean
): Promise<void> {
  const existing = await readPausedWorkspaceRoots(filePath);
  const next = new Map(existing.map((root) => [normalizeWorkspacePath(root), root]));
  for (const root of workspaceRoots) {
    const key = normalizeWorkspacePath(root);
    if (paused) {
      next.set(key, root);
    } else {
      next.delete(key);
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ roots: Array.from(next.values()) }, null, 2)}\n`, "utf8");
}

export function workspaceIsPaused(pausedRoots: string[], workspaceRoots: string[]): boolean {
  if (workspaceRoots.length === 0) {
    return false;
  }
  const paused = new Set(pausedRoots.map(normalizeWorkspacePath));
  return workspaceRoots.every((root) => paused.has(normalizeWorkspacePath(root)));
}

export function eventIsPaused(pausedRoots: string[], eventCwd: string): boolean {
  return eventBelongsToWorkspace(eventCwd, pausedRoots);
}

function normalizeWorkspacePath(value: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(value);
  const api = windows ? path.win32 : path.posix;
  const normalized = api.resolve(value);
  return windows ? normalized.toLowerCase() : normalized;
}
