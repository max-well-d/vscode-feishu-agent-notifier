import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from "electron";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveAgentExecutable } from "../agentExecutable";
import { AgentReplyJob, AgentReplyQueue, AgentReplyRunner } from "../agentReply";
import { SessionBrokerClient } from "../brokerClient";
import { FeishuChannelAdapter } from "../channels/feishuAdapter";
import { loadExternalChannel } from "../channels/pluginLoader";
import { ChannelRegistry } from "../channels/registry";
import { ChannelConfiguration, ChannelInboundMessage, ChannelSnapshot } from "../channels/types";
import { AgentSession } from "../types";
import { RemoteExecutionPolicy } from "../types";
import { ReplyRouter } from "../replyRouter";
import { discoverLocalSessions } from "../sessionCatalog";
import { SessionRegistry } from "../sessionRegistry";
import { installHooks, inspectHooks } from "../hookInstaller";
import { LocalHookServer } from "../server";
import { HookEventNormalizer } from "../hookEventNormalizer";
import { deployHookRuntime, deployLegacyWindowMonitor, HookRuntimeInstallation } from "../hookRuntime";
import { CodexTranscriptWatcher } from "../codexTranscriptWatcher";
import { ClaudeTranscriptWatcher } from "../claudeTranscriptWatcher";
import { eventDeduplicationKey, isCrossOriginDuplicate } from "../event";
import { DesktopConfigStore } from "./configStore";

interface DesktopSnapshot {
  product: string;
  version: string;
  dataDirectory: string;
  broker: { state: string; codexState: string; activeTurns: number; error?: string };
  agents: Array<{ id: string; name: string; executable?: string; available: boolean }>;
  channels: ChannelSnapshot[];
  sessions: AgentSession[];
  logs: LogRecord[];
  settings: DesktopSettings;
}

interface LogRecord {
  at: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

interface DesktopSettings {
  remoteExecutionPolicy: RemoteExecutionPolicy;
  defaultWorkspace: string;
  receiverPort: number;
}

const PRODUCT_NAME = "Agent Link";
const removedInsecureTlsOverride = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
if (removedInsecureTlsOverride) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const SYSTEM_BOOTSTRAP_PATH = path.join(app.getPath("appData"), PRODUCT_NAME, "location.json");
applyConfiguredRuntimePath();
const logs: LogRecord[] = [];
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let registry: ChannelRegistry;
let configStore: DesktopConfigStore;
let broker: SessionBrokerClient;
let sessionRegistry: SessionRegistry;
let replyQueue: AgentReplyQueue;
let replyRouter: ReplyRouter;
let settings: DesktopSettings = { remoteExecutionPolicy: "planOnly", defaultWorkspace: "", receiverPort: 37562 };
let hookServer: LocalHookServer;
let codexWatcher: CodexTranscriptWatcher | undefined;
let claudeWatcher: ClaudeTranscriptWatcher | undefined;
let approvalTimer: NodeJS.Timeout | undefined;
const announcedApprovals = new Set<string>();
const inboundMessages = new Map<string, ChannelInboundMessage>();
const recentEvents = new Map<string, number>();
const recentBodies = new Map<string, { at: number; origin: import("../types").AgentEvent["origin"] }>();
let dataDirectory = "";
let quitting = false;
let installedHookRuntime: HookRuntimeInstallation | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(boot).catch((error) => {
    void dialog.showErrorBox(`${PRODUCT_NAME} 启动失败`, error instanceof Error ? error.stack ?? error.message : String(error));
    app.quit();
  });
}

async function boot(): Promise<void> {
  app.setName(PRODUCT_NAME);
  if (removedInsecureTlsOverride) {
    log("warn", "已忽略系统环境中的 NODE_TLS_REJECT_UNAUTHORIZED=0；Agent Link 始终验证远程 TLS 证书");
  }
  dataDirectory = await resolveDataDirectory();
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await deployLegacyWindowMonitor(
    dataDirectory,
    path.join(__dirname, "assets", "windows", "HiddenConsoleHost.cs")
  );
  settings = await loadDesktopSettings();
  createRuntime();
  await loadExternalChannels();
  await loadChannels();
  await startHookReceiver();
  await refreshInstalledHookRuntime();
  await startTranscriptWatchers();
  await writeDesktopDescriptor();
  createWindow();
  createTray();
  registerIpc();
  await broker.refresh().then(
    () => log("info", "Session Broker 已连接"),
    (error) => log("warn", `Session Broker 暂不可用：${error instanceof Error ? error.message : String(error)}`)
  );
  startApprovalMonitor();
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    tray?.destroy();
    quitting = true;
    if (approvalTimer) clearInterval(approvalTimer);
    void registry.stop();
    void hookServer.stop();
    codexWatcher?.stop();
    claudeWatcher?.stop();
    void removeDesktopDescriptor();
    broker.dispose();
  });
}

async function loadExternalChannels(): Promise<void> {
  const directory = path.join(dataDirectory, "channels");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      registry.register(await loadExternalChannel(path.join(directory, entry.name)));
      log("info", `已加载外部 Channel：${entry.name}`);
    } catch (error) {
      log("error", `外部 Channel ${entry.name} 加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function createRuntime(): void {
  const logger = {
    debug: (message: string) => log("debug", message),
    info: (message: string) => log("info", message),
    warn: (message: string) => log("warn", message),
    error: (message: string) => log("error", message)
  };
  registry = new ChannelRegistry({
    onMessage: handleInboundMessage,
    onStateChange: () => pushSnapshot(),
    log: logger
  });
  registry.register(new FeishuChannelAdapter());
  configStore = new DesktopConfigStore(dataDirectory, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  });
  broker = new SessionBrokerClient({
    dataDirectory,
    brokerScript: path.join(__dirname, "broker.js"),
    executable: () => findAgentExecutable("codex"),
    version: () => app.getVersion(),
    onState: pushSnapshot,
    log: logger
  });
  sessionRegistry = new SessionRegistry(path.join(dataDirectory, "remote-sessions.json"));
  replyQueue = new AgentReplyQueue(
    new AgentReplyRunner(
      30 * 60_000,
      undefined,
      findAgentExecutable,
      broker,
      async (job, forked) => persistRemoteBranch(job, forked),
      async (_job, adopted) => { await sessionRegistry.recordManagedSession(adopted); }
    ),
    1,
    {
      onStarted: async (job) => {
        if (job.session.source === "codex") {
          await broker.setRemoteContext(job.session.sessionId, job.chatId, job.inboundMessageId);
        }
        await sessionRegistry.updateExecutionState(job.session, "progress");
        await replyToJob(job, `开始执行：${formatSession(job.session)}`);
        pushSnapshot();
      },
      onFinished: async (job, result) => {
        if (result instanceof Error) {
          await sessionRegistry.updateExecutionState(job.session, "failed");
          await replyToJob(job, `执行失败：${result.message}`);
        } else {
          await sessionRegistry.updateExecutionState(job.session, "completed", result.sessionId, result.turnId);
          await replyToJob(job, result.outputTail || `执行完成：${formatSession(job.session)}`);
        }
        pushSnapshot();
      }
    }
  );
  replyRouter = new ReplyRouter({
    registry: sessionRegistry,
    queue: replyQueue,
    policy: () => settings.remoteExecutionPolicy,
    refreshSessions,
    reply: async (message, text) => {
      const inbound = inboundMessages.get(message.messageId);
      if (!inbound) {
        throw new Error(`找不到入站消息上下文：${message.messageId}`);
      }
      const receipt = await registry.reply(inbound, text);
      return receipt.messageId;
    },
    status: () => `Agent Link：${broker.brokerState}\nCodex App Server：${broker.state}\n执行中：${replyQueue.activeCount}\n排队：${replyQueue.pendingCount}`,
    defaultWorkspace: () => settings.defaultWorkspace
      ? { cwd: settings.defaultWorkspace, project: path.basename(settings.defaultWorkspace) }
      : undefined,
    createManagedCodexSession: (cwd, project, policy, name) => broker.startThread(cwd, project, policy, name),
    steerManagedCodex: (session, prompt) => broker.steer(session, prompt),
    resolveApproval: (approvalId, decision) => broker.resolveApproval(approvalId, decision, "feishu")
  });
}

function startApprovalMonitor(): void {
  approvalTimer = setInterval(() => {
    if (broker.brokerState !== "ready") return;
    void broker.refresh().then(async (brokerSnapshot) => {
      const active = new Set(brokerSnapshot.pendingApprovals.map((item) => item.approvalId));
      for (const approvalId of announcedApprovals) {
        if (!active.has(approvalId)) announcedApprovals.delete(approvalId);
      }
      for (const approval of brokerSnapshot.pendingApprovals) {
        if (announcedApprovals.has(approval.approvalId) || !approval.inboundMessageId) continue;
        const inbound = inboundMessages.get(approval.inboundMessageId);
        if (!inbound) continue;
        announcedApprovals.add(approval.approvalId);
        await registry.reply(inbound,
          `${approval.source === "claude-code" ? "Claude Code" : "Codex"} 请求权限：${approval.summary}\n`
          + `审批 ID：${approval.approvalId}\n发送 /approve ${approval.approvalId} 或 /deny ${approval.approvalId}；本地与远程先响应者生效。`
        );
      }
    }).catch((error) => log("debug", `Broker 审批轮询失败：${error instanceof Error ? error.message : String(error)}`));
  }, 1_500);
  approvalTimer.unref();
}

async function writeDesktopDescriptor(): Promise<void> {
  const filePath = path.join(dataDirectory, "agent-link.json");
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({
    protocolVersion: 1,
    pid: process.pid,
    receiverPort: hookServer.port,
    version: app.getVersion(),
    startedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function removeDesktopDescriptor(): Promise<void> {
  const filePath = path.join(dataDirectory, "agent-link.json");
  try {
    const descriptor = JSON.parse(await fs.readFile(filePath, "utf8")) as { pid?: number };
    if (descriptor.pid === process.pid) await fs.rm(filePath, { force: true });
  } catch {
    // Another desktop instance may already own the descriptor.
  }
}

async function startHookReceiver(): Promise<void> {
  const tokenPath = path.join(dataDirectory, "desktop-hook-token");
  let token = "";
  try {
    token = (await fs.readFile(tokenPath, "utf8")).trim();
  } catch {
    token = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  }
  const normalizer = new HookEventNormalizer("realtime");
  hookServer = new LocalHookServer(token, handleAgentEvent, (input) => normalizer.normalize(input), "agent-link");
  await hookServer.start(settings.receiverPort).then(
    () => log("info", `Agent Hook Receiver 正在监听 127.0.0.1:${settings.receiverPort}`),
    (error) => log("error", `Agent Hook Receiver 启动失败：${error instanceof Error ? error.message : String(error)}`)
  );
}

async function startTranscriptWatchers(): Promise<void> {
  const fallback = settings.defaultWorkspace || process.cwd();
  codexWatcher = new CodexTranscriptWatcher(
    handleAgentEvent,
    fallback,
    undefined,
    (error) => log("warn", `Codex transcript 监听失败：${error.message}`),
    1_500,
    "realtime"
  );
  claudeWatcher = new ClaudeTranscriptWatcher(
    handleAgentEvent,
    fallback,
    undefined,
    (error) => log("warn", `Claude transcript 监听失败：${error.message}`)
  );
  await Promise.all([codexWatcher.start(), claudeWatcher.start()]);
  log("info", "Codex 与 Claude Code 实时 transcript 监听已启动");
}

async function handleAgentEvent(event: import("../types").AgentEvent): Promise<void> {
  const duplicate = duplicateEventKind(event);
  if (duplicate === "exact") return;
  const session = await sessionRegistry.recordEvent(event);
  if (duplicate === "cross-origin") {
    pushSnapshot();
    return;
  }
  const deliveries = await registry.broadcast(event);
  for (const [channelId, result] of Object.entries(deliveries)) {
    if (result instanceof Error) {
      log("error", `[${channelId}] 事件投递失败：${result.message}`);
      continue;
    }
    for (const receipt of result.receipts) {
      await sessionRegistry.recordMessageRoute(receipt.messageId, session, event.turnId);
    }
  }
  pushSnapshot();
}

function duplicateEventKind(event: import("../types").AgentEvent): "exact" | "cross-origin" | undefined {
  const now = Date.now();
  const expiry = now - 10 * 60_000;
  for (const [key, at] of recentEvents) if (at < expiry) recentEvents.delete(key);
  for (const [key, value] of recentBodies) if (value.at < expiry) recentBodies.delete(key);
  const eventKey = eventDeduplicationKey(event);
  if (recentEvents.has(eventKey)) return "exact";
  recentEvents.set(eventKey, now);
  const bodyKey = `${event.source}:${event.sessionId}:${event.message}`;
  const previous = recentBodies.get(bodyKey);
  recentBodies.set(bodyKey, { at: now, origin: event.origin });
  return previous && now - previous.at < 30_000 && isCrossOriginDuplicate(previous.origin, event.origin)
    ? "cross-origin"
    : undefined;
}

async function loadChannels(): Promise<void> {
  const configurations = await configStore.load(registry.snapshots().map((item) => item.manifest));
  for (const snapshot of registry.snapshots()) {
    const configuration = configurations[snapshot.manifest.id];
    if (configuration) {
      await registry.configure(snapshot.manifest.id, configuration).catch((error) => {
        log("error", `${snapshot.manifest.name} 启动失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}

function createWindow(): void {
  const icon = loadApplicationIcon();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#0d1117",
    title: PRODUCT_NAME,
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

function createTray(): void {
  const icon = loadApplicationIcon();
  if (icon.isEmpty()) {
    log("error", "托盘图标加载失败");
    return;
  }
  tray = new Tray(icon.resize({ width: 20, height: 20, quality: "best" }));
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Agent Link", click: showWindow },
    { label: "打开数据目录", click: () => void shell.openPath(dataDirectory) },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("double-click", showWindow);
}

function loadApplicationIcon(): Electron.NativeImage {
  const packagedIcon = nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png"));
  if (!packagedIcon.isEmpty()) return packagedIcon;
  return nativeImage.createFromDataURL(TRAY_ICON);
}

function registerIpc(): void {
  ipcMain.handle("snapshot:get", () => buildSnapshot());
  ipcMain.handle("channel:get", (_event, id: string) => editableChannelConfiguration(id));
  ipcMain.handle("channel:save", async (_event, id: string, configuration: ChannelConfiguration) => {
    const snapshot = registry.snapshots().find((item) => item.manifest.id === id);
    if (!snapshot) {
      throw new Error(`未知 Channel：${id}`);
    }
    const merged = mergeExistingSecrets(snapshot.manifest, registry.configuration(id), configuration);
    await registry.configure(id, merged);
    await configStore.save(snapshot.manifest, merged);
    return buildSnapshot();
  });
  ipcMain.handle("channel:test", async (_event, id: string) => {
    await registry.send(id, {
      source: "unknown",
      eventName: "desktop-test",
      status: "completed",
      sessionId: "agent-link-test",
      turnId: crypto.randomUUID(),
      cwd: process.cwd(),
      project: "Agent Link",
      sessionName: "Channel 测试",
      message: "Agent Link Channel 双向链路的出站测试消息。",
      occurredAt: new Date().toISOString()
    });
    return buildSnapshot();
  });
  ipcMain.handle("data-directory:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) {
      return undefined;
    }
    const selected = path.resolve(result.filePaths[0]);
    if (selected === path.parse(selected).root) {
      throw new Error("不能把磁盘根目录设为数据目录");
    }
    await persistDataDirectory(selected);
    return selected;
  });
  ipcMain.handle("data-directory:open", () => shell.openPath(dataDirectory));
  ipcMain.handle("broker:refresh", async () => {
    await broker.refresh();
    return buildSnapshot();
  });
  ipcMain.handle("settings:save", async (_event, next: DesktopSettings) => {
    settings = validateDesktopSettings(next);
    await saveDesktopSettings(settings);
    return buildSnapshot();
  });
  ipcMain.handle("hooks:install", async () => {
    const runtime = await prepareHookRuntime();
    const result = await installHooks({
      helperPath: runtime.helperPath,
      commandPath: runtime.commandPath,
      tokenFilePath: path.join(dataDirectory, "desktop-hook-token"),
      spoolDirectory: path.join(dataDirectory, "pending-events"),
      port: settings.receiverPort
    });
    log("info", `Agent Hooks 已安装：Codex=${result.codexChanged} Claude=${result.claudeChanged}`);
    return inspectHooks();
  });
  ipcMain.handle("hooks:inspect", () => inspectHooks());
}

async function prepareHookRuntime(): Promise<HookRuntimeInstallation> {
  installedHookRuntime = await deployHookRuntime({
    dataDirectory,
    helperSourcePath: path.join(__dirname, "agent-hook.cjs"),
    launcherSourcePath: path.join(__dirname, "assets", "windows", "HookLauncher.cs")
  });
  return installedHookRuntime;
}

async function refreshInstalledHookRuntime(): Promise<void> {
  const inspection = await inspectHooks();
  if (!inspection.codexInstalled
    && !inspection.claudeStopInstalled
    && !inspection.claudeStopFailureInstalled
    && !inspection.claudeMessageDisplayInstalled) {
    return;
  }
  const runtime = installedHookRuntime ?? await prepareHookRuntime();
  const result = await installHooks({
    helperPath: runtime.helperPath,
    commandPath: runtime.commandPath,
    tokenFilePath: path.join(dataDirectory, "desktop-hook-token"),
    spoolDirectory: path.join(dataDirectory, "pending-events"),
    port: settings.receiverPort
  });
  log("info", `Agent Hooks 已切换到无窗口运行时：Codex=${result.codexChanged} Claude=${result.claudeChanged}`);
}

function editableChannelConfiguration(id: string): { configuration: ChannelConfiguration; secretConfigured: string[] } {
  const snapshot = registry.snapshots().find((item) => item.manifest.id === id);
  if (!snapshot) {
    throw new Error(`未知 Channel：${id}`);
  }
  const configuration = registry.configuration(id);
  const secretConfigured: string[] = [];
  for (const key of manifestSecretKeys(snapshot.manifest)) {
    if (typeof configuration.config[key] === "string" && configuration.config[key]) {
      secretConfigured.push(key);
    }
    configuration.config[key] = "";
  }
  return { configuration, secretConfigured };
}

function mergeExistingSecrets(
  manifest: ChannelSnapshot["manifest"],
  existing: ChannelConfiguration,
  incoming: ChannelConfiguration
): ChannelConfiguration {
  const merged = structuredClone(incoming);
  for (const key of manifestSecretKeys(manifest)) {
    if (typeof merged.config[key] !== "string" || !merged.config[key]) {
      merged.config[key] = existing.config[key];
    }
  }
  return merged;
}

function manifestSecretKeys(manifest: ChannelSnapshot["manifest"]): string[] {
  const schema = manifest.configSchema as { properties?: Record<string, { secret?: boolean }> } | undefined;
  return Object.entries(schema?.properties ?? {}).filter(([, value]) => value.secret).map(([key]) => key);
}

async function handleInboundMessage(message: ChannelInboundMessage): Promise<void> {
  log("info", `[${message.channelId}] 收到 ${message.senderId} 的消息：${message.text.slice(0, 120)}`);
  inboundMessages.set(message.messageId, message);
  if (inboundMessages.size > 1_000) {
    inboundMessages.delete(inboundMessages.keys().next().value as string);
  }
  mainWindow?.webContents.send("channel:message", message);
  await replyRouter.handle({
    messageId: message.messageId,
    parentMessageId: message.parentMessageId,
    rootMessageId: message.rootMessageId,
    chatId: `${message.channelId}:${message.conversationId}`,
    chatType: message.conversationType === "group" ? "group" : "p2p",
    senderOpenId: `${message.channelId}:${message.senderId}`,
    text: message.text,
    mentionedBot: message.mentionedAdapter
  });
}

async function buildSnapshot(): Promise<DesktopSnapshot> {
  const [codex, claude, sessions] = await Promise.all([
    findAgentExecutable("codex"),
    findAgentExecutable("claude-code"),
    loadSessions()
  ]);
  return {
    product: PRODUCT_NAME,
    version: app.getVersion(),
    dataDirectory,
    broker: {
      state: broker.brokerState,
      codexState: broker.state,
      activeTurns: broker.activeCount,
      error: broker.lastError
    },
    agents: [
      { id: "codex", name: "Codex", executable: codex, available: Boolean(codex) },
      { id: "claude-code", name: "Claude Code", executable: claude, available: Boolean(claude) }
    ],
    channels: registry.snapshots(),
    sessions,
    logs: logs.slice(-200),
    settings: structuredClone(settings)
  };
}

async function loadSessions(): Promise<AgentSession[]> {
  await refreshSessions();
  return sessionRegistry.listSessions(200);
}

async function refreshSessions(): Promise<void> {
  const sessions = await discoverLocalSessions();
  await sessionRegistry.recordDiscoveredSessions(sessions);
}

async function persistRemoteBranch(job: AgentReplyJob, forked: AgentSession): Promise<void> {
  if (!job.anchorTurnId) {
    throw new Error("远程分支缺少完成 turn 锚点");
  }
  await sessionRegistry.recordRemoteBranch(job.originalSession, job.anchorTurnId, forked, job.chatId);
}

async function replyToJob(job: AgentReplyJob, text: string): Promise<void> {
  const inbound = inboundMessages.get(job.inboundMessageId);
  if (!inbound) {
    throw new Error(`找不到执行任务的 Channel 上下文：${job.inboundMessageId}`);
  }
  const receipt = await registry.reply(inbound, text);
  await sessionRegistry.recordMessageRoute(receipt.messageId, job.session, job.anchorTurnId);
}

function formatSession(session: AgentSession): string {
  const source = session.source === "claude-code" ? "Claude Code" : "Codex";
  return `${source}/${session.alias || session.name || session.project} (${session.sessionId})`;
}

async function findAgentExecutable(source: "codex" | "claude-code"): Promise<string | undefined> {
  const extensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  let extensionPath: string | undefined;
  try {
    const prefix = source === "codex" ? "openai.chatgpt-" : "anthropic.claude-code-";
    const candidates = (await fs.readdir(extensionsRoot)).filter((name) => name.startsWith(prefix)).sort().reverse();
    extensionPath = candidates[0] ? path.join(extensionsRoot, candidates[0]) : undefined;
  } catch {
    // PATH lookup remains available.
  }
  return resolveAgentExecutable(source, { extensionPath });
}

function showWindow(): void {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function log(level: LogRecord["level"], message: string): void {
  logs.push({ at: new Date().toISOString(), level, message });
  if (logs.length > 500) {
    logs.splice(0, logs.length - 500);
  }
  mainWindow?.webContents.send("log:append", logs.at(-1));
}

function pushSnapshot(): void {
  void buildSnapshot().then((snapshot) => mainWindow?.webContents.send("snapshot:update", snapshot));
}

async function resolveDataDirectory(): Promise<string> {
  try {
    const value = JSON.parse(await fs.readFile(SYSTEM_BOOTSTRAP_PATH, "utf8")) as { dataDirectory?: string };
    if (value.dataDirectory && path.isAbsolute(value.dataDirectory)) {
      return path.resolve(value.dataDirectory);
    }
  } catch {
    // Default below.
  }
  const legacy = await legacyConfiguredDataDirectory();
  if (legacy) {
    await persistDataDirectory(legacy);
    return legacy;
  }
  return path.join(app.getPath("userData"), "data");
}

async function legacyConfiguredDataDirectory(): Promise<string | undefined> {
  const candidates = [
    path.join(app.getPath("appData"), "Code", "User", "settings.json"),
    path.join(app.getPath("appData"), "Code - Insiders", "User", "settings.json")
  ];
  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      const match = text.match(/["']feishuAgentNotifier\.dataDirectory["']\s*:\s*["']([^"']+)["']/);
      if (match?.[1]) {
        const decoded = match[1].replace(/\\\\/g, "\\");
        if (path.isAbsolute(decoded) && decoded !== path.parse(decoded).root) {
          return path.resolve(decoded);
        }
      }
    } catch {
      // Try the next VS Code profile.
    }
  }
  return undefined;
}

async function loadDesktopSettings(): Promise<DesktopSettings> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDirectory, "desktop-settings.json"), "utf8")) as DesktopSettings;
    return validateDesktopSettings(value);
  } catch {
    return { remoteExecutionPolicy: "planOnly", defaultWorkspace: "", receiverPort: 37562 };
  }
}

function validateDesktopSettings(value: DesktopSettings): DesktopSettings {
  const policy = value?.remoteExecutionPolicy;
  const remoteExecutionPolicy: RemoteExecutionPolicy = policy === "disabled" || policy === "inherit" ? policy : "planOnly";
  const defaultWorkspace = typeof value?.defaultWorkspace === "string" ? value.defaultWorkspace.trim() : "";
  if (defaultWorkspace && !path.isAbsolute(defaultWorkspace)) {
    throw new Error("默认工作目录必须是绝对路径");
  }
  const receiverPort = Number.isInteger(value?.receiverPort) && value.receiverPort >= 1024 && value.receiverPort <= 65535
    ? value.receiverPort
    : 37562;
  return { remoteExecutionPolicy, defaultWorkspace: defaultWorkspace ? path.resolve(defaultWorkspace) : "", receiverPort };
}

async function saveDesktopSettings(value: DesktopSettings): Promise<void> {
  const filePath = path.join(dataDirectory, "desktop-settings.json");
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function persistDataDirectory(selected: string): Promise<void> {
  const bootstrap = SYSTEM_BOOTSTRAP_PATH;
  await fs.mkdir(path.dirname(bootstrap), { recursive: true });
  const temporary = `${bootstrap}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ dataDirectory: selected }, null, 2)}\n`, "utf8");
  await fs.rename(temporary, bootstrap);
  log("info", `数据目录将在重启后切换到 ${selected}`);
}

function applyConfiguredRuntimePath(): void {
  try {
    const value = JSON.parse(fsSync.readFileSync(SYSTEM_BOOTSTRAP_PATH, "utf8")) as { dataDirectory?: string };
    if (!value.dataDirectory || !path.isAbsolute(value.dataDirectory)) return;
    const runtimeRoot = path.join(path.resolve(value.dataDirectory), "runtime");
    const sessionRoot = path.join(runtimeRoot, "session");
    const logsRoot = path.join(runtimeRoot, "logs");
    const crashesRoot = path.join(runtimeRoot, "crashes");
    for (const directory of [sessionRoot, logsRoot, crashesRoot]) fsSync.mkdirSync(directory, { recursive: true });
    app.setPath("userData", runtimeRoot);
    app.setPath("sessionData", sessionRoot);
    app.setPath("logs", logsRoot);
    app.setPath("crashDumps", crashesRoot);
  } catch {
    // First run: discover legacy configuration after app readiness and use it next launch.
  }
}

const TRAY_ICON = "data:image/svg+xml;base64," + Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#5b8cff"/>
  <path d="M18 21h18a10 10 0 0 1 0 20H28l-9 7 3-9a10 10 0 0 1-4-18Z" fill="white"/>
  <circle cx="29" cy="31" r="3" fill="#5b8cff"/><circle cx="38" cy="31" r="3" fill="#5b8cff"/>
</svg>`).toString("base64");
