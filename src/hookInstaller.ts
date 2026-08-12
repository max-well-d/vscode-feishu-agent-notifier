import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const NOTIFIER_MARKER = "feishu-agent-notifier-v1";

export interface InstallHooksOptions {
  helperPath: string;
  port: number;
  token: string;
  homeDirectory?: string;
}

export interface HookInstallResult {
  codexPath: string;
  claudePath: string;
  codexChanged: boolean;
  claudeChanged: boolean;
}

type JsonObject = Record<string, any>;

export async function installHooks(options: InstallHooksOptions): Promise<HookInstallResult> {
  const home = options.homeDirectory ?? os.homedir();
  const codexPath = path.join(home, ".codex", "hooks.json");
  const claudePath = path.join(home, ".claude", "settings.json");

  const codexDocument = await readJsonObject(codexPath);
  const claudeDocument = await readJsonObject(claudePath);
  const codexChanged = mergeCodexHook(codexDocument, options);
  const claudeChanged = mergeClaudeHooks(claudeDocument, options);

  if (codexChanged) {
    await writeJsonWithBackup(codexPath, codexDocument);
  }
  if (claudeChanged) {
    await writeJsonWithBackup(claudePath, claudeDocument);
  }

  return { codexPath, claudePath, codexChanged, claudeChanged };
}

export async function uninstallHooks(homeDirectory?: string): Promise<HookInstallResult> {
  const home = homeDirectory ?? os.homedir();
  const codexPath = path.join(home, ".codex", "hooks.json");
  const claudePath = path.join(home, ".claude", "settings.json");
  const codexDocument = await readJsonObject(codexPath);
  const claudeDocument = await readJsonObject(claudePath);
  const codexChanged = removeNotifierHooks(codexDocument);
  const claudeChanged = removeNotifierHooks(claudeDocument);

  if (codexChanged) {
    await writeJsonWithBackup(codexPath, codexDocument);
  }
  if (claudeChanged) {
    await writeJsonWithBackup(claudePath, claudeDocument);
  }

  return { codexPath, claudePath, codexChanged, claudeChanged };
}

export function mergeCodexHook(document: JsonObject, options: InstallHooksOptions): boolean {
  const hooks = ensureHooks(document);
  const stopGroups = ensureEventGroups(hooks, "Stop");
  removeMatchingGroups(stopGroups);

  const argumentsText = [
    shellQuotePosix(options.helperPath),
    "--port", String(options.port),
    "--token", shellQuotePosix(options.token),
    "--source", "codex",
    "--notifier-id", NOTIFIER_MARKER
  ].join(" ");
  const windowsArguments = [
    shellQuotePowerShell(options.helperPath),
    "--port", String(options.port),
    "--token", shellQuotePowerShell(options.token),
    "--source", "codex",
    "--notifier-id", NOTIFIER_MARKER
  ].join(" ");

  stopGroups.push({
    hooks: [{
      type: "command",
      command: `node ${argumentsText}`,
      commandWindows: `node ${windowsArguments}`,
      async: true,
      timeout: 10
    }]
  });
  return true;
}

export function mergeClaudeHooks(document: JsonObject, options: InstallHooksOptions): boolean {
  const hooks = ensureHooks(document);
  for (const eventName of ["Stop", "StopFailure"]) {
    const groups = ensureEventGroups(hooks, eventName);
    removeMatchingGroups(groups);
    groups.push({
      hooks: [{
        type: "command",
        command: "node",
        args: [
          options.helperPath,
          "--port", String(options.port),
          "--token", options.token,
          "--source", "claude-code",
          "--notifier-id", NOTIFIER_MARKER
        ],
        async: true,
        timeout: 10
      }]
    });
  }
  return true;
}

export function removeNotifierHooks(document: JsonObject): boolean {
  if (!isObject(document.hooks)) {
    return false;
  }

  let changed = false;
  for (const [eventName, value] of Object.entries(document.hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const before = value.length;
    removeMatchingGroups(value);
    if (value.length !== before) {
      changed = true;
    }
    if (value.length === 0) {
      delete document.hooks[eventName];
    }
  }
  return changed;
}

function ensureHooks(document: JsonObject): JsonObject {
  if (!isObject(document.hooks)) {
    document.hooks = {};
  }
  return document.hooks;
}

function ensureEventGroups(hooks: JsonObject, eventName: string): any[] {
  if (!Array.isArray(hooks[eventName])) {
    hooks[eventName] = [];
  }
  return hooks[eventName];
}

function removeMatchingGroups(groups: any[]): void {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groupContainsNotifier(groups[index])) {
      groups.splice(index, 1);
    }
  }
}

function groupContainsNotifier(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) {
    return false;
  }
  return group.hooks.some((handler: unknown) => {
    if (!isObject(handler)) {
      return false;
    }
    const command = typeof handler.command === "string" ? handler.command : "";
    const commandWindows = typeof handler.commandWindows === "string" ? handler.commandWindows : "";
    const args = Array.isArray(handler.args) ? handler.args.join(" ") : "";
    return `${command} ${commandWindows} ${args}`.includes(NOTIFIER_MARKER);
  });
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const value = JSON.parse(text) as unknown;
    if (!isObject(value)) {
      throw new Error("顶层必须是 JSON 对象");
    }
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`无法解析 ${filePath}：${error.message}`);
    }
    throw error;
  }
}

async function writeJsonWithBackup(filePath: string, document: JsonObject): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const backupPath = `${filePath}.feishu-agent-notifier.bak`;
  try {
    await fs.access(filePath);
    try {
      await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellQuotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
