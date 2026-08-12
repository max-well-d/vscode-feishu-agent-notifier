import fs from "node:fs/promises";
import path from "node:path";
import { AgentSession } from "./types";

export type ResumableAgentSource = Extract<AgentSession["source"], "codex" | "claude-code">;

export interface AgentExecutableCandidates {
  configuredPath?: string;
  extensionPath?: string;
  environmentPath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
}

export async function resolveAgentExecutable(
  source: ResumableAgentSource,
  options: AgentExecutableCandidates = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const executableName = source === "codex"
    ? platform === "win32" ? "codex.exe" : "codex"
    : platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    options.configuredPath?.trim(),
    ...extensionExecutableCandidates(source, options.extensionPath, platform, architecture),
    ...pathExecutableCandidates(executableName, options.environmentPath ?? process.env.PATH ?? process.env.Path ?? "", platform)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of Array.from(new Set(candidates))) {
    if (await isFile(candidate)) {
      return path.resolve(candidate);
    }
  }
  return undefined;
}

export function extensionExecutableCandidates(
  source: ResumableAgentSource,
  extensionPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): string[] {
  if (!extensionPath) {
    return [];
  }
  if (source === "claude-code") {
    return [path.join(extensionPath, "resources", "native-binary", platform === "win32" ? "claude.exe" : "claude")];
  }
  const platformName = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const architectureName = architecture === "arm64" ? "aarch64" : "x86_64";
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  return [path.join(extensionPath, "bin", `${platformName}-${architectureName}`, executableName)];
}

function pathExecutableCandidates(executable: string, environmentPath: string, platform: NodeJS.Platform): string[] {
  const separator = platform === "win32" ? ";" : ":";
  return environmentPath.split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => path.join(entry, executable));
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}
