import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const NOTIFIER_MARKER = "feishu-agent-notifier-v1";

export interface InstallHooksOptions {
  helperPath: string;
  commandPath?: string;
  tokenFilePath: string;
  spoolDirectory?: string;
  port: number;
  homeDirectory?: string;
}

export interface HookInstallResult {
  codexPath: string;
  codexHooksPath: string;
  claudePath: string;
  codexChanged: boolean;
  claudeChanged: boolean;
}

export interface HookInspectionResult {
  codexPath: string;
  codexHooksPath: string;
  claudePath: string;
  codexInstalled: boolean;
  codexNotifyInstalled: boolean;
  codexStopInstalled: boolean;
  claudeStopInstalled: boolean;
  claudeStopFailureInstalled: boolean;
  claudeMessageDisplayInstalled: boolean;
  claudePermissionRequestInstalled: boolean;
}

interface CodexNotifyMergeResult {
  text: string;
  changed: boolean;
  previousNotify: string | null | undefined;
}

type JsonObject = Record<string, any>;

export async function installHooks(options: InstallHooksOptions): Promise<HookInstallResult> {
  const home = options.homeDirectory ?? os.homedir();
  const codexPath = path.join(home, ".codex", "config.toml");
  const codexHooksPath = path.join(home, ".codex", "hooks.json");
  const codexStatePath = path.join(home, ".codex", "feishu-agent-notifier-state.json");
  const claudePath = path.join(home, ".claude", "settings.json");

  const codexConfig = await readText(codexPath);
  const codexMerge = mergeCodexNotify(codexConfig, options);
  const codexHooksDocument = await readJsonObject(codexHooksPath);
  const claudeDocument = await readJsonObject(claudePath);
  const codexHooksChanged = mergeCodexHooks(codexHooksDocument, options);
  const claudeChanged = mergeClaudeHooks(claudeDocument, options);

  if (codexMerge.previousNotify !== undefined) {
    await writeJsonFile(codexStatePath, { previousNotify: codexMerge.previousNotify });
  }
  if (codexMerge.changed) {
    await writeTextWithBackup(codexPath, codexMerge.text);
  }
  if (codexHooksChanged) {
    await writeJsonWithBackup(codexHooksPath, codexHooksDocument);
  }
  if (claudeChanged) {
    await writeJsonWithBackup(claudePath, claudeDocument);
  }

  return {
    codexPath,
    codexHooksPath,
    claudePath,
    codexChanged: codexMerge.changed || codexHooksChanged,
    claudeChanged
  };
}

export async function uninstallHooks(homeDirectory?: string): Promise<HookInstallResult> {
  const home = homeDirectory ?? os.homedir();
  const codexPath = path.join(home, ".codex", "config.toml");
  const codexHooksPath = path.join(home, ".codex", "hooks.json");
  const codexStatePath = path.join(home, ".codex", "feishu-agent-notifier-state.json");
  const claudePath = path.join(home, ".claude", "settings.json");
  const previousNotify = await readPreviousNotify(codexStatePath);
  const codexRemoval = removeCodexNotify(await readText(codexPath), previousNotify);
  const codexHooksDocument = await readJsonObject(codexHooksPath);
  const claudeDocument = await readJsonObject(claudePath);
  const codexHooksChanged = removeNotifierHooks(codexHooksDocument);
  const claudeChanged = removeNotifierHooks(claudeDocument);

  if (codexRemoval.changed) {
    await writeTextWithBackup(codexPath, codexRemoval.text);
  }
  if (codexHooksChanged) {
    await writeJsonWithBackup(codexHooksPath, codexHooksDocument);
  }
  if (claudeChanged) {
    await writeJsonWithBackup(claudePath, claudeDocument);
  }
  await fs.rm(codexStatePath, { force: true });

  return {
    codexPath,
    codexHooksPath,
    claudePath,
    codexChanged: codexRemoval.changed || codexHooksChanged,
    claudeChanged
  };
}

export async function inspectHooks(homeDirectory?: string): Promise<HookInspectionResult> {
  const home = homeDirectory ?? os.homedir();
  const codexPath = path.join(home, ".codex", "config.toml");
  const codexHooksPath = path.join(home, ".codex", "hooks.json");
  const claudePath = path.join(home, ".claude", "settings.json");
  const codexNotify = findRootNotifyAssignment(await readText(codexPath));
  const codexHooksDocument = await readJsonObject(codexHooksPath);
  const codexHooks = isObject(codexHooksDocument.hooks) ? codexHooksDocument.hooks : {};
  const claudeDocument = await readJsonObject(claudePath);
  const hooks = isObject(claudeDocument.hooks) ? claudeDocument.hooks : {};
  const codexNotifyInstalled = codexNotify?.text.includes(NOTIFIER_MARKER) ?? false;
  const codexStopInstalled = eventHasNotifier(codexHooks.Stop);

  return {
    codexPath,
    codexHooksPath,
    claudePath,
    codexInstalled: codexNotifyInstalled || codexStopInstalled,
    codexNotifyInstalled,
    codexStopInstalled,
    claudeStopInstalled: eventHasNotifier(hooks.Stop),
    claudeStopFailureInstalled: eventHasNotifier(hooks.StopFailure),
    claudeMessageDisplayInstalled: eventHasNotifier(hooks.MessageDisplay),
    claudePermissionRequestInstalled: eventHasNotifier(hooks.PermissionRequest)
  };
}

export function mergeCodexNotify(configText: string, options: InstallHooksOptions): CodexNotifyMergeResult {
  const command = [
    ...hookCommand(options),
    "--port", String(options.port),
    "--token-file", options.tokenFilePath,
    "--source", "codex",
    "--notifier-id", NOTIFIER_MARKER
  ];
  if (options.spoolDirectory) {
    command.push("--spool", options.spoolDirectory);
  }
  const assignment = `notify = ${JSON.stringify(command)}`;
  const existing = findRootNotifyAssignment(configText);

  if (existing?.text === assignment) {
    return { text: normalizeFinalNewline(configText), changed: false, previousNotify: undefined };
  }

  const lines = normalizedLines(configText);
  let previousNotify: string | null | undefined;
  if (existing) {
    lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, assignment);
    previousNotify = existing.text.includes(NOTIFIER_MARKER) ? undefined : existing.text;
  } else {
    const firstTable = findFirstTableLine(lines);
    lines.splice(firstTable, 0, assignment, "");
    previousNotify = null;
  }

  return { text: joinLines(lines), changed: true, previousNotify };
}

export function mergeCodexHooks(document: JsonObject, options: InstallHooksOptions): boolean {
  const before = JSON.stringify(document);
  const hooks = ensureHooks(document);
  const groups = ensureEventGroups(hooks, "Stop");
  removeMatchingGroups(groups);
  groups.push({
    hooks: [{
      type: "command",
      command: buildCodexHookCommand(options, false),
      commandWindows: buildCodexHookCommand(options, true),
      async: true,
      timeout: 10
    }]
  });
  return JSON.stringify(document) !== before;
}

export function removeCodexNotify(
  configText: string,
  previousNotify: string | null
): { text: string; changed: boolean } {
  const existing = findRootNotifyAssignment(configText);
  if (!existing || !existing.text.includes(NOTIFIER_MARKER)) {
    return { text: normalizeFinalNewline(configText), changed: false };
  }

  const lines = normalizedLines(configText);
  const replacement = previousNotify ? previousNotify.split("\n") : [];
  lines.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...replacement);
  return { text: joinLines(collapseExtraLeadingBlankLines(lines)), changed: true };
}

export function mergeClaudeHooks(document: JsonObject, options: InstallHooksOptions): boolean {
  const before = JSON.stringify(document);
  const hooks = ensureHooks(document);
  for (const eventName of ["Stop", "StopFailure", "MessageDisplay", "PermissionRequest"]) {
    const groups = ensureEventGroups(hooks, eventName);
    removeMatchingGroups(groups);
    const command = hookCommand(options);
    const args = [
      ...command.slice(1),
      "--port", String(options.port),
      "--token-file", options.tokenFilePath,
      "--source", "claude-code",
      "--notifier-id", NOTIFIER_MARKER
    ];
    if (options.spoolDirectory) {
      args.push("--spool", options.spoolDirectory);
    }
    if (eventName === "MessageDisplay") {
      args.push("--queue-offline", "false");
    }
    // PermissionRequest 必须同步执行并等待决策（最长 600 秒），Claude 才
    // 会暂停当前工具调用等待远程 /approve /deny；超时后回退本地交互式确认。
    const blocking = eventName === "PermissionRequest";
    groups.push({
      hooks: [{
        type: "command",
        command: command[0],
        args,
        async: !blocking,
        timeout: blocking ? 600 : 10
      }]
    });
  }
  return JSON.stringify(document) !== before;
}

function buildCodexHookCommand(options: InstallHooksOptions, windows: boolean): string {
  const quote = windows ? quoteWindowsArgument : quotePosixArgument;
  const command = [
    ...hookCommand(options).map(quote),
    "--port", String(options.port),
    "--token-file", quote(options.tokenFilePath),
    "--source", "codex",
    "--notifier-id", NOTIFIER_MARKER
  ];
  if (options.spoolDirectory) {
    command.push("--spool", quote(options.spoolDirectory));
  }
  return command.join(" ");
}

function hookCommand(options: InstallHooksOptions): string[] {
  return options.commandPath ? [options.commandPath] : ["node", options.helperPath];
}

function quotePosixArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
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

function eventHasNotifier(value: unknown): boolean {
  return Array.isArray(value) && value.some((group) => groupContainsNotifier(group));
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

async function readText(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readPreviousNotify(filePath: string): Promise<string | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (isObject(value) && (typeof value.previousNotify === "string" || value.previousNotify === null)) {
      return value.previousNotify;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return null;
}

async function writeJsonWithBackup(filePath: string, document: JsonObject): Promise<void> {
  await writeTextWithBackup(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

async function writeJsonFile(filePath: string, document: JsonObject): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

async function writeTextWithBackup(filePath: string, text: string): Promise<void> {
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

  await fs.writeFile(filePath, text, "utf8");
}

interface NotifyAssignment {
  startLine: number;
  endLine: number;
  text: string;
}

function findRootNotifyAssignment(text: string): NotifyAssignment | undefined {
  const lines = normalizedLines(text);
  const firstTable = findFirstTableLine(lines);
  for (let index = 0; index < firstTable; index += 1) {
    if (!/^\s*notify\s*=/.test(lines[index])) {
      continue;
    }
    let endLine = index;
    while (endLine + 1 < firstTable && !tomlArrayAssignmentComplete(lines.slice(index, endLine + 1).join("\n"))) {
      endLine += 1;
    }
    return { startLine: index, endLine, text: lines.slice(index, endLine + 1).join("\n") };
  }
  return undefined;
}

function tomlArrayAssignmentComplete(text: string): boolean {
  const value = text.slice(text.indexOf("=") + 1);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;
  let sawArray = false;

  for (const character of value) {
    if (inComment) {
      if (character === "\n") {
        inComment = false;
      }
      continue;
    }
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "#") {
      inComment = true;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
      sawArray = true;
    } else if (character === "]") {
      depth -= 1;
    }
  }
  return sawArray && depth <= 0 && !quote;
}

function normalizedLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function findFirstTableLine(lines: string[]): number {
  const index = lines.findIndex((line) => /^\s*\[\[?[^#]/.test(line));
  return index === -1 ? lines.length : index;
}

function collapseExtraLeadingBlankLines(lines: string[]): string[] {
  while (lines.length > 1 && lines[0] === "" && lines[1] === "") {
    lines.shift();
  }
  return lines;
}

function joinLines(lines: string[]): string {
  const joined = lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return joined ? `${joined}\n` : "";
}

function normalizeFinalNewline(text: string): string {
  return text ? `${text.replace(/\s+$/, "")}\n` : "";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
