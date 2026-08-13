import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA_ENTRIES = ["remote-sessions.json", "paused-workspaces.json", "pending-events", "broker-state.json", "broker-completions.json"] as const;

export function resolveDataDirectory(
  configuredPath: string,
  defaultPath: string,
  homeDirectory = os.homedir()
): string {
  const configured = configuredPath.trim();
  if (!configured) {
    return path.resolve(defaultPath);
  }
  const expanded = configured === "~"
    ? homeDirectory
    : configured.startsWith(`~${path.sep}`) || configured.startsWith("~/") || configured.startsWith("~\\")
      ? path.join(homeDirectory, configured.slice(2))
      : configured;
  if (!path.isAbsolute(expanded)) {
    throw new Error("自定义数据目录必须是绝对路径，或使用 ~/ 开头");
  }
  const resolved = path.resolve(expanded);
  if (resolved === path.parse(resolved).root) {
    throw new Error("不能把磁盘或文件系统根目录直接用作数据目录");
  }
  return resolved;
}

export async function prepareDataDirectory(
  defaultPath: string,
  targetPath: string
): Promise<{ migrated: string[]; retained: string[] }> {
  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o700);
  }
  if (samePath(defaultPath, targetPath)) {
    return { migrated: [], retained: [] };
  }

  const migrated: string[] = [];
  const retained: string[] = [];
  for (const name of DATA_ENTRIES) {
    const source = path.join(defaultPath, name);
    const target = path.join(targetPath, name);
    if (!await exists(source)) {
      continue;
    }
    if (await exists(target)) {
      retained.push(name);
      continue;
    }
    await moveAcrossDevices(source, target);
    migrated.push(name);
  }
  return { migrated, retained };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function moveAcrossDevices(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    await fs.cp(source, target, { recursive: true, errorOnExist: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}
