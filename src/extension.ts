import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { AgentCapabilities, detectAgentCapabilities } from "./agentCapabilities";
import { resolveAgentExecutable, ResumableAgentSource } from "./agentExecutable";
import { ClaudeTranscriptWatcher } from "./claudeTranscriptWatcher";
import { CodexTranscriptWatcher } from "./codexTranscriptWatcher";
import { eventDeduplicationKey, isCrossOriginDuplicate } from "./event";
import { FeishuSender, validateConfig } from "./feishu";
import { FeishuInboundClient } from "./feishuInbound";
import { inspectHooks, installHooks, uninstallHooks } from "./hookInstaller";
import { HookEventNormalizer } from "./hookEventNormalizer";
import {
  formatLocalNotification,
  LocalNotificationMode,
  shouldShowLocalNotification
} from "./localNotification";
import { LocalHookServer } from "./server";
import { buildStatusPresentation, StatusSnapshot } from "./statusUi";
import { AgentReplyJob, AgentReplyQueue, AgentReplyRunner, shouldForkClaudeSession } from "./agentReply";
import { CodexAppServerClient } from "./codexAppServer";
import { ReplyRouter } from "./replyRouter";
import { discoverLocalSessions } from "./sessionCatalog";
import { SessionRegistry } from "./sessionRegistry";
import { ProjectDestinations, resolveProjectDestination } from "./projectRouting";
import {
  eventIsPaused,
  readPausedWorkspaceRoots,
  setWorkspacePaused,
  workspaceIsPaused
} from "./workspacePause";
import { drainPendingEvents, pendingEventCount, queuePendingEvent } from "./pendingQueue";
import {
  AgentEvent,
  AgentSession,
  DeliveryMode,
  DeliveryTiming,
  MessageFormat,
  NotifierConfig,
  ReceiveIdType,
  RemoteExecutionPolicy
} from "./types";
import { parseIdList, validateIdListInput, validateReceiveIdInput } from "./remoteConfiguration";
import { prepareDataDirectory, resolveDataDirectory } from "./dataDirectory";

const SECRET_WEBHOOK_URL = "feishuAgentNotifier.webhookUrl";
const SECRET_WEBHOOK_SECRET = "feishuAgentNotifier.webhookSecret";
const SECRET_APP_ID = "feishuAgentNotifier.appId";
const SECRET_APP_SECRET = "feishuAgentNotifier.appSecret";
const SECRET_HOOK_TOKEN = "feishuAgentNotifier.hookToken";
const WORKSPACE_PAUSED_KEY = "feishuAgentNotifier.workspacePaused";

let hookServer: LocalHookServer | undefined;
let feishuInboundClient: FeishuInboundClient | undefined;
let feishuInboundState: "idle" | "connecting" | "connected" | "reconnecting" | "failed" = "idle";
let feishuInboundError: string | undefined;
let sessionRegistry: SessionRegistry | undefined;
let agentReplyQueue: AgentReplyQueue | undefined;
let replyRouter: ReplyRouter | undefined;
let codexAppServerClient: CodexAppServerClient | undefined;
let codexTranscriptWatcher: CodexTranscriptWatcher | undefined;
let claudeTranscriptWatcher: ClaudeTranscriptWatcher | undefined;
let claudeRealtimeSource: "message-display" | "transcript" | "probing" | undefined;
let agentCapabilities: AgentCapabilities = {};
let agentExecutablePaths: Partial<Record<ResumableAgentSource, string>> = {};
let receiverStandbyPort: number | undefined;
let receiverConflictPort: number | undefined;
let receiverTakeoverTimer: NodeJS.Timeout | undefined;
let receiverProbeRunning = false;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.LogOutputChannel | undefined;
let sendQueue: Promise<void> = Promise.resolve();
let pendingDrain: Promise<void> | undefined;
let lastDeliverySuccess: string | undefined;
let lastDeliveryError: string | undefined;
let lastDeliveryErrorNotificationAt = 0;
let extensionStoragePath = "";
let activeExtensionId = "local.feishu-agent-notifier";
let activeDeliveries = 0;
let statusRefreshId = 0;
let configurationWizardSaving = false;
let statusSnapshot: StatusSnapshot = {
  initializing: true,
  enabled: true,
  workspacePaused: false,
  configurationOk: false,
  deliveryTiming: "realtime",
  deliveryMode: "webhook",
  pendingCount: 0,
  activeDeliveries: 0
};
const recentEvents = new Map<string, number>();
const recentMessageBodies = new Map<string, { timestamp: number; origin: AgentEvent["origin"] }>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activeExtensionId = context.extension.id;
  output = vscode.window.createOutputChannel("Feishu Agent Notifier", { log: true });
  extensionStoragePath = await initializeDataDirectory(context);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.name = "Feishu Agent Notifier 状态";
  statusBar.command = "feishuAgentNotifier.showStatus";
  renderStatusBar();
  statusBar.show();
  context.subscriptions.push(output, statusBar);
  sessionRegistry = new SessionRegistry(path.join(extensionStoragePath, "remote-sessions.json"));
  await migrateLegacySecrets(context);
  await migrateWorkspacePause(context);
  await refreshAgentExecutables();
  agentCapabilities = await detectAgentCapabilities(undefined, {
    codex: agentExecutablePaths.codex,
    claude: agentExecutablePaths["claude-code"]
  });
  logAgentCapabilities();
  codexAppServerClient = createCodexAppServerClient(context);
  agentReplyQueue = createAgentReplyQueue(context);
  replyRouter = createReplyRouter(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("feishuAgentNotifier.installHooks", () => installHookFiles(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.uninstallHooks", () => removeHookFiles(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.testNotification", () => sendTestNotification(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.testLocalNotification", sendLocalTestNotification),
    vscode.commands.registerCommand("feishuAgentNotifier.storeSecrets", () => storeSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearSecrets", () => clearSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.openSettings", openSettings),
    vscode.commands.registerCommand("feishuAgentNotifier.configureDataDirectory", () => configureDataDirectory(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.configureRemoteControl", () => configureRemoteControl(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.showStatus", () => showStatus(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.toggleWorkspacePause", () => toggleWorkspacePause(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.runDiagnostics", () => runDiagnostics(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.retryPending", () => retryPendingEvents(context, true)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearPending", () => clearPendingEvents(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.showRemoteSessions", () => showRemoteSessions(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.cancelRemoteReplies", () => cancelRemoteReplies()),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (configurationWizardSaving || !event.affectsConfiguration("feishuAgentNotifier")) {
        return;
      }
      if (event.affectsConfiguration("feishuAgentNotifier.dataDirectory")) {
        const selection = await vscode.window.showInformationMessage(
          "本地数据目录已修改。重载窗口后迁移会话索引、暂停状态和离线队列。",
          "立即重载"
        );
        if (selection === "立即重载") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
        return;
      }
      await deployHelper(context);
      await restartServer(context);
    })
  );

  await deployHelper(context);
  await refreshInstalledHookPaths(context);
  await restartServer(context);
}

export async function deactivate(): Promise<void> {
  stopReceiverTakeoverMonitor();
  agentReplyQueue?.dispose();
  agentReplyQueue = undefined;
  codexAppServerClient?.dispose();
  codexAppServerClient = undefined;
  replyRouter = undefined;
  sessionRegistry = undefined;
  await feishuInboundClient?.disconnect();
  feishuInboundClient = undefined;
  codexTranscriptWatcher?.stop();
  codexTranscriptWatcher = undefined;
  claudeTranscriptWatcher?.stop();
  claudeTranscriptWatcher = undefined;
  claudeRealtimeSource = undefined;
  await hookServer?.stop();
  hookServer = undefined;
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
  stopReceiverTakeoverMonitor();
  await feishuInboundClient?.disconnect();
  feishuInboundClient = undefined;
  feishuInboundState = "idle";
  feishuInboundError = undefined;
  receiverStandbyPort = undefined;
  receiverConflictPort = undefined;
  statusSnapshot = { ...statusSnapshot, initializing: true };
  renderStatusBar();
  codexTranscriptWatcher?.stop();
  codexTranscriptWatcher = undefined;
  claudeTranscriptWatcher?.stop();
  claudeTranscriptWatcher = undefined;
  claudeRealtimeSource = undefined;
  await hookServer?.stop();
  hookServer = undefined;
  if (!getSetting<boolean>("enabled", true)) {
    output?.info("通知接收器已禁用。 ");
    await refreshStatusBar(context);
    return;
  }

  const token = await getOrCreateHookToken(context);
  await writeHookTokenFile(context, token);
  const integrationTest = process.env.FEISHU_AGENT_NOTIFIER_TEST === "1";
  const deliveryTiming = getSetting<DeliveryTiming>("deliveryTiming", "realtime");
  const port = integrationTest ? 0 : getSetting<number>("port", 37561);
  const sender = new FeishuSender();
  let messageDisplayObserved = false;
  const hookEventNormalizer = new HookEventNormalizer(deliveryTiming, 150, () => {
    if (messageDisplayObserved) {
      return;
    }
    messageDisplayObserved = true;
    claudeTranscriptWatcher?.stop();
    claudeTranscriptWatcher = undefined;
    claudeRealtimeSource = "message-display";
    output?.info("已收到 Claude Code MessageDisplay；transcript 兼容监听已关闭。");
    void refreshStatusBar(context);
  });
  hookServer = new LocalHookServer(token, async (event) => {
    enqueueEvent(context, sender, event);
  }, (input) => hookEventNormalizer.normalize(input));

  try {
    await hookServer.start(port);
    output?.info(`本地 Hook 接收器正在监听 127.0.0.1:${port}`);
    void retryPendingEvents(context, false);
    if (!integrationTest && (deliveryTiming === "realtime" || getSetting<boolean>("watchCodexIde", true))) {
      codexTranscriptWatcher = new CodexTranscriptWatcher(
        async (event) => enqueueEvent(context, sender, event),
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        undefined,
        (error) => output?.warn(`Codex transcript 监听失败：${error.message}`),
        1_500,
        deliveryTiming
      );
      await codexTranscriptWatcher.start();
      output?.info(`Codex transcript ${deliveryTiming === "realtime" ? "实时消息" : "完成事件"}监听已启动。`);
    }
    if (!integrationTest && deliveryTiming === "realtime") {
      let messageDisplayInstalled = false;
      try {
        messageDisplayInstalled = (await inspectHooks()).claudeMessageDisplayInstalled;
      } catch (error) {
        output?.warn(`无法检查 Claude Code MessageDisplay Hook：${(error as Error).message}`);
      }
      claudeTranscriptWatcher = new ClaudeTranscriptWatcher(
        async (event) => enqueueEvent(context, sender, event),
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        undefined,
        (error) => output?.warn(`Claude Code transcript 监听失败：${error.message}`)
      );
      await claudeTranscriptWatcher.start();
      if (messageDisplayObserved) {
        claudeTranscriptWatcher.stop();
        claudeTranscriptWatcher = undefined;
        claudeRealtimeSource = "message-display";
      } else if (messageDisplayInstalled && agentCapabilities.claudeMessageDisplay !== false) {
        claudeRealtimeSource = "probing";
        output?.info("Claude Code MessageDisplay 已配置；transcript 兼容监听将在首次 Hook 事件后关闭。");
      } else {
        claudeRealtimeSource = "transcript";
        const reason = agentCapabilities.claudeMessageDisplay === false
          ? `Claude Code ${agentCapabilities.claudeVersion ?? "当前版本"} 不支持 MessageDisplay`
          : "Claude Code MessageDisplay Hook 未安装";
        output?.warn(`${reason}，暂用 transcript 兼容监听。`);
      }
    }
    if (!integrationTest) {
      await startFeishuInbound(context);
    }
  } catch (error) {
    await hookServer?.stop();
    hookServer = undefined;
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const receiverState = await probeReceiver(port, token);
      if (receiverState === "compatible") {
        receiverStandbyPort = port;
        output?.info(`端口 ${port} 由另一个 VS Code 窗口接收；本窗口进入自动接管待命。`);
      } else {
        receiverConflictPort = port;
        output?.warn(`端口 ${port} 被不兼容的进程或其他 VS Code Profile 占用。`);
      }
      feishuInboundState = "idle";
      startReceiverTakeoverMonitor(context, port, token);
      await refreshStatusBar(context);
      return;
    }
    const message = `无法启动本地 Hook 接收器：${(error as Error).message}`;
    output?.warn(message);
  }
  await refreshStatusBar(context);
}

type ReceiverProbe = "compatible" | "occupied" | "unavailable";

async function probeReceiver(port: number, token: string): Promise<ReceiverProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-Feishu-Agent-Token": token },
      signal: AbortSignal.timeout(1_500)
    });
    if (!response.ok) {
      return "occupied";
    }
    const body = await response.json() as { status?: unknown; service?: unknown };
    return body.status === "ok" && body.service === "feishu-agent-notifier"
      ? "compatible"
      : "occupied";
  } catch {
    return "unavailable";
  }
}

function startReceiverTakeoverMonitor(
  context: vscode.ExtensionContext,
  port: number,
  token: string
): void {
  stopReceiverTakeoverMonitor();
  const timer = setInterval(() => {
    if (receiverProbeRunning) {
      return;
    }
    receiverProbeRunning = true;
    void probeReceiver(port, token).then(async (state) => {
      if (receiverTakeoverTimer !== timer) {
        return;
      }
      if (state === "unavailable") {
        stopReceiverTakeoverMonitor();
        output?.info(`端口 ${port} 已释放，本窗口正在接管通知接收器。`);
        await restartServer(context);
        return;
      }
      const standby = state === "compatible" ? port : undefined;
      const conflict = state === "occupied" ? port : undefined;
      if (standby !== receiverStandbyPort || conflict !== receiverConflictPort) {
        receiverStandbyPort = standby;
        receiverConflictPort = conflict;
        await refreshStatusBar(context);
      }
    }).catch((error) => {
      output?.warn(`接收器接管检查失败：${(error as Error).message}`);
    }).finally(() => {
      receiverProbeRunning = false;
    });
  }, 5_000);
  receiverTakeoverTimer = timer;
  timer.unref();
}

function stopReceiverTakeoverMonitor(): void {
  if (receiverTakeoverTimer) {
    clearInterval(receiverTakeoverTimer);
    receiverTakeoverTimer = undefined;
  }
}

function createAgentReplyQueue(context: vscode.ExtensionContext): AgentReplyQueue {
  const timeoutMinutes = getSetting<number>("remoteReplyTimeoutMinutes", 30);
  return new AgentReplyQueue(
    new AgentReplyRunner(
      Math.max(1, timeoutMinutes) * 60_000,
      undefined,
      async (source) => {
        await refreshAgentExecutables();
        return agentExecutablePaths[source];
      },
      codexAppServerClient,
      async (job, forked) => {
        if (!sessionRegistry || !job.anchorTurnId) {
          throw new Error("会话注册表或分支 turnId 不可用");
        }
        const persisted = await sessionRegistry.recordRemoteBranch(
          job.originalSession,
          job.anchorTurnId,
          forked,
          job.chatId
        );
        Object.assign(forked, persisted);
        const replyId = await replyToInbound(
          job.inboundMessageId,
          job.chatId,
          `${forked.source === "claude-code" ? "原 Claude Code 会话仍在本机使用" : "原会话正在本机 Codex 中打开"}`
          + `，已创建持久化远程分支：${formatAgentSession(forked)}\n后续飞书回复将继续绑定该分支。`
        );
        if (replyId) {
          await sessionRegistry.recordMessageRoute(replyId, forked);
        }
      }
    ),
    1,
    {
      waitUntilReady: (job, signal) => waitUntilAgentSessionIdle(job, signal),
      onStarted: async (job) => {
        const updated = await sessionRegistry?.updateExecutionState(job.session, "progress");
        if (updated) {
          Object.assign(job.session, updated);
        }
        const replyId = await replyToInbound(job.inboundMessageId, job.chatId,
          `开始执行：${formatAgentSession(job.session)}`);
        if (replyId) {
          await sessionRegistry?.recordMessageRoute(replyId, job.session, job.anchorTurnId);
        }
        void refreshStatusBar(context);
      },
      onFinished: async (job, result) => {
        if (result instanceof Error) {
          const updated = await sessionRegistry?.updateExecutionState(job.session, "failed");
          if (updated) {
            Object.assign(job.session, updated);
          }
          output?.error(`飞书远程回复失败 ${job.session.source}/${job.session.sessionId}：${result.message}`);
          const replyId = await replyToInbound(job.inboundMessageId, job.chatId, `执行失败：${result.message}`);
          if (replyId) {
            await sessionRegistry?.recordMessageRoute(replyId, job.session, job.anchorTurnId);
          }
        } else {
          const updated = await sessionRegistry?.updateExecutionState(
            job.session,
            "completed",
            result.sessionId,
            result.turnId
          );
          if (updated) {
            Object.assign(job.session, updated);
          }
          output?.info(`飞书远程回复完成 ${job.session.source}/${job.session.sessionId}，耗时 ${result.durationMs}ms。`);
          const replyId = await replyToInbound(job.inboundMessageId, job.chatId,
            `执行完成：${formatAgentSession(job.session)}\nAgent 输出将通过正常通知通道发送。`);
          if (replyId) {
            await sessionRegistry?.recordMessageRoute(replyId, job.session, result.turnId ?? job.anchorTurnId);
          }
        }
        void refreshStatusBar(context);
      }
    }
  );
}

function createCodexAppServerClient(context: vscode.ExtensionContext): CodexAppServerClient {
  return new CodexAppServerClient({
    executable: async () => {
      await refreshAgentExecutables();
      return agentExecutablePaths.codex;
    },
    version: () => context.extension.packageJSON.version as string,
    log: {
      debug: (message) => output?.debug(message),
      info: (message) => output?.info(message),
      warn: (message) => output?.warn(message),
      error: (message) => output?.error(message)
    },
    onState: () => void refreshStatusBar(context)
  });
}

function createReplyRouter(context: vscode.ExtensionContext): ReplyRouter {
  if (!sessionRegistry || !agentReplyQueue) {
    throw new Error("远程回复组件尚未初始化");
  }
  return new ReplyRouter({
    registry: sessionRegistry,
    queue: agentReplyQueue,
    policy: () => getSetting<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled"),
    refreshSessions: refreshLocalSessionCatalog,
    reply: async (message, text) => replyToInbound(message.messageId, message.chatId, text),
    status: () => remoteStatusText(context),
    defaultWorkspace: () => vscode.workspace.workspaceFolders?.[0]
      ? { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath, project: vscode.workspace.workspaceFolders[0].name }
      : undefined,
    createManagedCodexSession: async (cwd, project, policy, name) => {
      if (!codexAppServerClient || !sessionRegistry) {
        throw new Error("Codex App Server 托管执行器尚未初始化");
      }
      const session = await codexAppServerClient.startThread(cwd, project, policy, name);
      return sessionRegistry.recordManagedSession(session);
    },
    steerManagedCodex: async (session, prompt) => {
      if (!codexAppServerClient) {
        throw new Error("Codex App Server 托管执行器尚未初始化");
      }
      return codexAppServerClient.steer(session, prompt);
    }
  });
}

async function startFeishuInbound(context: vscode.ExtensionContext): Promise<void> {
  const policy = getSetting<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled");
  if (policy === "disabled") {
    feishuInboundState = "idle";
    return;
  }
  const config = await loadNotifierConfig(context);
  if (config.deliveryMode !== "app") {
    feishuInboundState = "failed";
    feishuInboundError = "远程回复仅支持飞书自建应用机器人模式";
    output?.warn(feishuInboundError);
    return;
  }
  const allowedUserOpenIds = normalizedStringArray(getSetting<string[]>("remoteAllowedUserOpenIds", []));
  if (allowedUserOpenIds.length === 0) {
    feishuInboundState = "failed";
    feishuInboundError = "未配置允许远程回复的飞书用户 open_id";
    output?.warn(feishuInboundError);
    return;
  }
  if (!config.appId || !config.appSecret) {
    feishuInboundState = "failed";
    feishuInboundError = "飞书 App ID 或 App Secret 未配置";
    return;
  }
  const client = new FeishuInboundClient({
    appId: config.appId,
    appSecret: config.appSecret,
    allowedUserOpenIds,
    allowedChatIds: normalizedStringArray(getSetting<string[]>("remoteAllowedChatIds", [])),
    requireGroupMention: getSetting<boolean>("remoteRequireGroupMention", true)
  }, {
    onMessage: async (message) => {
      try {
        await replyRouter?.handle(message);
      } catch (error) {
        output?.error(`处理飞书远程回复失败：${(error as Error).message}`);
        await replyToInbound(message.messageId, message.chatId, `处理失败：${(error as Error).message}`);
      }
    },
    onState: async (state, detail) => {
      feishuInboundState = state;
      feishuInboundError = state === "failed" ? detail : undefined;
      output?.info(`飞书远程回复连接：${state}${detail ? `（${detail}）` : ""}`);
      await refreshStatusBar(context);
    },
    log: {
      debug: (message) => output?.debug(message),
      info: (message) => output?.info(message),
      warn: (message) => output?.warn(message),
      error: (message) => output?.error(message)
    }
  });
  feishuInboundClient = client;
  try {
    await client.connect();
    await refreshLocalSessionCatalog();
  } catch (error) {
    feishuInboundState = "failed";
    feishuInboundError = (error as Error).message;
    output?.error(`无法连接飞书远程回复：${feishuInboundError}`);
  }
}

async function waitUntilAgentSessionIdle(job: AgentReplyJob, signal: AbortSignal): Promise<void> {
  if (job.anchorTurnId && job.session.ownership !== "managed") {
    const existingBranch = await sessionRegistry?.resolveRemoteBranch(job.originalSession, job.anchorTurnId);
    if (existingBranch) {
      Object.assign(job.session, existingBranch);
      return;
    }
  }
  if (shouldForkClaudeSession(job)) {
    return;
  }
  const maximumWait = Math.max(1, getSetting<number>("remoteActiveWaitMinutes", 120)) * 60_000;
  const startedAt = Date.now();
  while (!signal.aborted) {
    const latest = await sessionRegistry?.getSession(`${job.session.source}:${job.session.sessionId}`);
    if (!latest || latest.status !== "progress") {
      return;
    }
    if (Date.now() - startedAt >= maximumWait) {
      throw new Error("等待当前 Agent 任务结束超时");
    }
    await abortableDelay(5_000, signal);
  }
  throw new Error("远程 Agent 回复已取消");
}

async function refreshLocalSessionCatalog(): Promise<void> {
  if (!sessionRegistry) {
    return;
  }
  const sessions = await discoverLocalSessions({ maximumFiles: 300 });
  const changed = await sessionRegistry.recordDiscoveredSessions(sessions);
  output?.debug(`本地会话目录已刷新：发现 ${sessions.length}，更新 ${changed}。`);
}

async function enrichAgentEventSessionName(event: AgentEvent): Promise<void> {
  if (!event.sessionId) {
    return;
  }
  const existing = await sessionRegistry?.getSession(`${event.source}:${event.sessionId}`);
  if (existing?.alias) {
    event.sessionName = existing.alias;
    return;
  }
  if (event.source === "codex" && codexAppServerClient) {
    try {
      const metadata = await codexAppServerClient.readThreadMetadata(event.sessionId);
      event.sessionName = metadata.name || event.sessionName || existing?.name;
      return;
    } catch (error) {
      output?.debug(`读取 Codex 会话名称失败 ${event.sessionId.slice(0, 8)}：${(error as Error).message}`);
    }
  }
  event.sessionName ||= existing?.name || existing?.project || event.project;
}

function formatAgentSession(session: AgentSession): string {
  const source = session.source === "claude-code" ? "Claude Code" : "Codex";
  const name = session.alias || session.name || session.project || path.basename(session.cwd) || "未命名";
  return `${source}/${name} (${session.sessionId})`;
}

async function replyToInbound(messageId: string, chatId: string, text: string): Promise<string | undefined> {
  if (!feishuInboundClient || feishuInboundState !== "connected") {
    output?.warn(`飞书入站未连接，无法回复消息 ${messageId.slice(0, 8)}。`);
    return undefined;
  }
  try {
    return await feishuInboundClient.reply(messageId, chatId, Array.from(text).slice(0, 3000).join(""));
  } catch (error) {
    output?.error(`发送飞书入站确认失败：${(error as Error).message}`);
    return undefined;
  }
}

function remoteStatusText(context: vscode.ExtensionContext): string {
  const policy = getSetting<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled");
  return [
    `Feishu Agent Notifier ${context.extension.packageJSON.version as string}`,
    `远程策略：${policy === "disabled" ? "禁用" : policy === "planOnly" ? "只读规划" : "继承本机权限"}`,
    `长连接：${feishuInboundState}${feishuInboundError ? `（${feishuInboundError}）` : ""}`,
    `运行中：${agentReplyQueue?.activeCount ?? 0}`,
    `排队：${agentReplyQueue?.pendingCount ?? 0}`,
    `Codex 托管器：${codexAppServerClient?.state ?? "stopped"}${codexAppServerClient?.lastError ? `（${codexAppServerClient.lastError}）` : ""}`
  ].join("\n");
}

async function showRemoteSessions(context: vscode.ExtensionContext): Promise<void> {
  await refreshLocalSessionCatalog();
  const sessions = await sessionRegistry?.listSessions(50) ?? [];
  const content = [
    "# Feishu Agent Notifier 本地会话",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `远程状态：${remoteStatusText(context).replace(/\n/g, "；")}`,
    "",
    ...sessions.map((session, index) =>
      `${index + 1}. **${session.alias || session.name || session.project || session.sessionId}** — ${session.source} — ${session.ownership === "managed" ? "飞书托管" : "外部"}/${session.status === "progress" ? "运行中" : session.completionEvidence === "authoritative" ? "已确认完成" : "未确认完成"} — ${session.sessionId} — ${session.cwd || "无工作目录"}`),
    ""
  ].join("\n");
  const document = await vscode.workspace.openTextDocument({ content, language: "markdown" });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function cancelRemoteReplies(): Promise<void> {
  const count = agentReplyQueue?.cancelAll() ?? 0;
  await vscode.window.showInformationMessage(count > 0 ? `已取消 ${count} 个远程回复任务。` : "当前没有远程回复任务。 ");
}

function normalizedStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("远程 Agent 回复已取消"));
    }, { once: true });
  });
}

function logAgentCapabilities(): void {
  const codex = agentCapabilities.codexVersion
    ? `${agentCapabilities.codexVersion}，Stop Hook ${agentCapabilities.codexStopHook === true ? "可用" : agentCapabilities.codexStopHook === false ? "未启用" : "未知"}`
    : "未检测到";
  const claude = agentCapabilities.claudeVersion
    ? `${agentCapabilities.claudeVersion}，MessageDisplay ${agentCapabilities.claudeMessageDisplay === true ? "可用" : agentCapabilities.claudeMessageDisplay === false ? "不可用" : "未知"}`
    : "未检测到";
  output?.info(`Agent 能力：Codex ${codex}；Claude Code ${claude}。`);
  output?.info(`Agent CLI：Codex ${agentExecutablePaths.codex ?? "未解析"}；Claude Code ${agentExecutablePaths["claude-code"] ?? "未解析"}。`);
}

async function refreshAgentExecutables(): Promise<void> {
  const codexExtension = vscode.extensions.getExtension("openai.chatgpt");
  const claudeExtension = vscode.extensions.getExtension("anthropic.claude-code");
  const [codex, claude] = await Promise.all([
    resolveAgentExecutable("codex", {
      configuredPath: getSetting<string>("codexExecutablePath", ""),
      extensionPath: codexExtension?.extensionPath
    }),
    resolveAgentExecutable("claude-code", {
      configuredPath: getSetting<string>("claudeExecutablePath", ""),
      extensionPath: claudeExtension?.extensionPath
    })
  ]);
  agentExecutablePaths = { codex, "claude-code": claude };
}

function enqueueEvent(
  context: vscode.ExtensionContext,
  sender: FeishuSender,
  event: AgentEvent,
  queueOnFailure = true
): Promise<void> {
  return enqueueEventAsync(context, sender, event, queueOnFailure);
}

async function enqueueEventAsync(
  context: vscode.ExtensionContext,
  sender: FeishuSender,
  event: AgentEvent,
  queueOnFailure: boolean
): Promise<void> {
  await enrichAgentEventSessionName(event);
  await sessionRegistry?.recordEvent(event);
  if (eventIsPaused(await readPausedWorkspaceRoots(workspacePauseFile()), event.cwd)) {
    output?.info(`当前工作区已暂停，跳过 ${event.source}/${event.project} 通知。`);
    return;
  }
  const key = eventDeduplicationKey(event);
  let messageKey: string | undefined;
  const now = Date.now();
  cleanupRecentEvents(now);
  if (key !== "unknown:::Stop" && recentEvents.has(key)) {
    output?.info(`忽略重复事件：${key}`);
    return Promise.resolve();
  }
  recentEvents.set(key, now);
  if (queueOnFailure && getSetting<DeliveryTiming>("deliveryTiming", "realtime") === "realtime") {
    messageKey = realtimeMessageKey(event);
    const observed = recentMessageBodies.get(messageKey);
    if (observed && isCrossOriginDuplicate(observed.origin, event.origin)) {
      output?.info(`忽略 transcript/Hook 重复消息：${event.source}/${event.sessionId}`);
      return Promise.resolve();
    }
    recentMessageBodies.set(messageKey, { timestamp: now, origin: event.origin });
  }
  void showLocalNotification(event).catch((error) => {
    output?.warn(`本地提醒失败：${(error as Error).message}`);
  });

  const delivery = sendQueue
    .then(async () => {
      activeDeliveries += 1;
      renderStatusBar();
      try {
        const baseConfig = await loadNotifierConfig(context);
        const config = resolveProjectDestination(
          baseConfig,
          event,
          getSetting<ProjectDestinations>("projectDestinations", {})
        );
        const result = await sender.sendEvent(event, config);
        if (result.count > 0) {
          await sessionRegistry?.recordDelivery(event, result.receipts);
          lastDeliverySuccess = new Date().toISOString();
          lastDeliveryError = undefined;
          output?.info(`已发送 ${event.source}/${event.project}，共 ${result.count} 条飞书消息。`);
        }
      } finally {
        activeDeliveries = Math.max(0, activeDeliveries - 1);
        renderStatusBar();
      }
    });
  sendQueue = delivery.catch(async (error) => {
      if (recentEvents.get(key) === now) {
        recentEvents.delete(key);
      }
      if (messageKey && recentMessageBodies.get(messageKey)?.timestamp === now) {
        recentMessageBodies.delete(messageKey);
      }
      const message = `发送飞书通知失败：${(error as Error).message}`;
      lastDeliveryError = message;
      output?.error(message);
      if (queueOnFailure && getSetting<boolean>("queueWhenOffline", true)) {
        try {
          const queuedPath = await queuePendingEvent(pendingDirectory(), event, message);
          output?.warn(`投递失败事件已保存，稍后重试：${queuedPath}`);
        } catch (queueError) {
          output?.error(`无法保存投递失败事件：${(queueError as Error).message}`);
        }
      }
      const cooldownMs = getSetting<number>("deliveryErrorNotificationCooldownMinutes", 5) * 60_000;
      if (Date.now() - lastDeliveryErrorNotificationAt >= cooldownMs) {
        lastDeliveryErrorNotificationAt = Date.now();
        void vscode.window.showErrorMessage(message, "查看日志", "运行自检").then((selection) => {
          if (selection === "查看日志") {
            output?.show(true);
          } else if (selection === "运行自检") {
            void vscode.commands.executeCommand("feishuAgentNotifier.runDiagnostics");
          }
        });
      }
    }).finally(() => {
      void refreshStatusBar(context);
    });
  return delivery;
}

async function showLocalNotification(event: AgentEvent, force = false): Promise<void> {
  if (!force && event.status === "progress" && !getSetting<boolean>("localNotificationRealtime", false)) {
    return;
  }
  const mode = getSetting<LocalNotificationMode>("localNotificationMode", "always");
  if (!force && !shouldShowLocalNotification(mode, vscode.window.state.focused)) {
    return;
  }

  const maximumPreviewCharacters = getSetting<number>("localNotificationPreviewCharacters", 160);
  const notification = formatLocalNotification(event, maximumPreviewCharacters);
  const action = "查看完整回复";
  const selection = event.status === "failed"
    ? await vscode.window.showErrorMessage(notification.text, action)
    : await vscode.window.showInformationMessage(notification.text, action);
  if (selection === action) {
    const document = await vscode.workspace.openTextDocument({
      content: event.message,
      language: "markdown"
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

async function sendLocalTestNotification(): Promise<void> {
  await showLocalNotification({
    source: "codex",
    eventName: "local-test",
    status: "completed",
    sessionId: "local-test",
    turnId: crypto.randomUUID(),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    project: vscode.workspace.name ?? "VS Code",
    message: "本地提醒工作正常。点击“查看完整回复”可在 Markdown 编辑器中查看完整内容。",
    occurredAt: new Date().toISOString()
  }, true);
}

async function installHookFiles(context: vscode.ExtensionContext): Promise<void> {
  try {
    await deployHelper(context);
    const token = await getOrCreateHookToken(context);
    await writeHookTokenFile(context, token);
    const helperPath = helperDestination(context);
    const tokenFilePath = hookTokenDestination(context);
    const port = getSetting<number>("port", 37561);
    const result = await installHooks({
      helperPath,
      tokenFilePath,
      spoolDirectory: pendingDirectory(),
      port
    });
    await restartServer(context);
    output?.info(`Codex notify: ${result.codexPath}`);
    output?.info(`Codex Stop Hook: ${result.codexHooksPath}`);
    output?.info(`Claude hooks: ${result.claudePath}`);
    const detail = [
      result.codexChanged ? "Codex 已更新" : "Codex 无变化",
      result.claudeChanged ? "Claude Code 已更新" : "Claude Code 无变化"
    ].join("；");
    await vscode.window.showInformationMessage(
      `通知接入安装完成：${detail}。Codex 已配置官方 Stop Hook 和 notify 回退；首次使用 Stop Hook 请在 Codex 中运行 /hooks 完成信任。`
    );
  } catch (error) {
    await showOperationError("安装 Hooks 失败", error);
  }
}

async function removeHookFiles(context: vscode.ExtensionContext): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    "从用户级 Codex 与 Claude Code 配置中移除 Feishu Agent Notifier 通知接入？",
    { modal: true },
    "移除"
  );
  if (answer !== "移除") {
    return;
  }
  try {
    const result = await uninstallHooks();
    await refreshStatusBar(context);
    await vscode.window.showInformationMessage(
      `Hooks 已移除。Codex：${result.codexChanged ? "已修改" : "未找到"}；Claude Code：${result.claudeChanged ? "已修改" : "未找到"}。`
    );
  } catch (error) {
    await showOperationError("卸载 Hooks 失败", error);
  }
}

async function sendTestNotification(context: vscode.ExtensionContext): Promise<void> {
  try {
    const config = await loadNotifierConfig(context);
    validateConfig(config);
    const sender = new FeishuSender();
    const result = await sender.sendEvent({
      source: "codex",
      eventName: "test",
      status: "completed",
      sessionId: "test-session",
      turnId: crypto.randomUUID(),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      project: vscode.workspace.name ?? "VS Code",
      message: "这是一条 Feishu Agent Notifier 测试消息。完整回复分片、Webhook 或应用机器人配置工作正常。",
      occurredAt: new Date().toISOString()
    }, config);
    lastDeliverySuccess = new Date().toISOString();
    lastDeliveryError = undefined;
    await refreshStatusBar(context);
    await vscode.window.showInformationMessage(`测试成功，已发送 ${result.count} 条飞书消息。`);
  } catch (error) {
    lastDeliveryError = `测试飞书通知失败：${(error as Error).message}`;
    await refreshStatusBar(context);
    await showOperationError("测试通知失败", error);
  }
}

async function storeSecrets(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showQuickPick([
    { label: "群自定义机器人 Webhook", value: "webhook" as DeliveryMode },
    { label: "自建应用机器人（指定用户/群聊）", value: "app" as DeliveryMode }
  ], { title: "选择飞书投递模式" });
  if (!selected) {
    return;
  }

  const configuration = vscode.workspace.getConfiguration("feishuAgentNotifier");
  await configuration.update("deliveryMode", selected.value, vscode.ConfigurationTarget.Global);

  if (selected.value === "webhook") {
    const webhookUrl = await vscode.window.showInputBox({
      title: "飞书自定义机器人 Webhook URL",
      password: true,
      ignoreFocusOut: true,
      validateInput: validateWebhookInput
    });
    if (!webhookUrl) {
      return;
    }
    const webhookSecret = await vscode.window.showInputBox({
      title: "飞书机器人签名密钥（未开启签名可留空）",
      password: true,
      ignoreFocusOut: true
    });
    await context.secrets.store(SECRET_WEBHOOK_URL, webhookUrl.trim());
    if (webhookSecret) {
      await context.secrets.store(SECRET_WEBHOOK_SECRET, webhookSecret);
    } else {
      await context.secrets.delete(SECRET_WEBHOOK_SECRET);
    }
    await clearLegacySecretSettings(["webhookUrl", "webhookSecret"]);
  } else {
    const appId = await vscode.window.showInputBox({
      title: "飞书自建应用 App ID",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "App ID 不能为空"
    });
    if (!appId) {
      return;
    }
    const appSecret = await vscode.window.showInputBox({
      title: "飞书自建应用 App Secret",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value ? undefined : "App Secret 不能为空"
    });
    if (!appSecret) {
      return;
    }
    await context.secrets.store(SECRET_APP_ID, appId.trim());
    await context.secrets.store(SECRET_APP_SECRET, appSecret);
    await clearLegacySecretSettings(["appId", "appSecret"]);
  }
  await restartServer(context);
  await refreshStatusBar(context);
  await vscode.window.showInformationMessage("飞书凭据已保存到 VS Code SecretStorage。请继续填写目标设置并发送测试消息。 ");
}

async function clearSecrets(context: vscode.ExtensionContext): Promise<void> {
  for (const key of [SECRET_WEBHOOK_URL, SECRET_WEBHOOK_SECRET, SECRET_APP_ID, SECRET_APP_SECRET]) {
    await context.secrets.delete(key);
  }
  await clearLegacySecretSettings(["webhookUrl", "webhookSecret", "appId", "appSecret"]);
  await restartServer(context);
  await refreshStatusBar(context);
  await vscode.window.showInformationMessage("Feishu Agent Notifier 安全凭据已清除。 ");
}

async function migrateLegacySecrets(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("feishuAgentNotifier");
  const legacy = [
    { setting: "webhookUrl", secret: SECRET_WEBHOOK_URL },
    { setting: "webhookSecret", secret: SECRET_WEBHOOK_SECRET },
    { setting: "appId", secret: SECRET_APP_ID },
    { setting: "appSecret", secret: SECRET_APP_SECRET }
  ];
  let migrated = 0;
  for (const item of legacy) {
    const value = configuration.inspect<string>(item.setting)?.globalValue?.trim();
    if (!value) {
      continue;
    }
    if (!await context.secrets.get(item.secret)) {
      await context.secrets.store(item.secret, value);
    }
    await configuration.update(item.setting, undefined, vscode.ConfigurationTarget.Global);
    migrated += 1;
  }
  if (migrated > 0) {
    output?.info(`已将 ${migrated} 个旧版明文凭据迁移到 VS Code SecretStorage。`);
  }
}

async function clearLegacySecretSettings(keys: string[]): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("feishuAgentNotifier");
  for (const key of keys) {
    if (configuration.inspect<string>(key)?.globalValue !== undefined) {
      await configuration.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
}

async function loadNotifierConfig(context: vscode.ExtensionContext): Promise<NotifierConfig> {
  const deliveryMode = getSetting<DeliveryMode>("deliveryMode", "webhook");
  return {
    deliveryMode,
    webhookUrl: await secretOrSetting(context, SECRET_WEBHOOK_URL, "webhookUrl"),
    webhookSecret: await secretOrSetting(context, SECRET_WEBHOOK_SECRET, "webhookSecret"),
    appId: await secretOrSetting(context, SECRET_APP_ID, "appId"),
    appSecret: await secretOrSetting(context, SECRET_APP_SECRET, "appSecret"),
    receiveIdType: getSetting<ReceiveIdType>("receiveIdType", "chat_id"),
    receiveId: getSetting<string>("receiveId", "").trim(),
    messageFormat: getSetting<MessageFormat>("messageFormat", "card"),
    includeMetadata: getSetting<boolean>("includeMetadata", true),
    maxChunkCharacters: getSetting<number>("maxChunkCharacters", 3000),
    notifyOnFailure: getSetting<boolean>("notifyOnFailure", true),
    deliveryMaxAttempts: getSetting<number>("deliveryMaxAttempts", 3),
    retryBaseDelayMs: getSetting<number>("retryBaseDelayMs", 500)
  };
}

async function secretOrSetting(
  context: vscode.ExtensionContext,
  secretKey: string,
  settingKey: string
): Promise<string> {
  const secret = await context.secrets.get(secretKey);
  return (secret ?? getSetting<string>(settingKey, "")).trim();
}

async function deployHelper(context: vscode.ExtensionContext): Promise<void> {
  const destination = helperDestination(context);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(context.asAbsolutePath(path.join("scripts", "agent-hook.cjs")), destination);
  const disabledMarker = path.join(extensionStoragePath, "offline-queue-disabled");
  await fs.mkdir(extensionStoragePath, { recursive: true });
  if (getSetting<boolean>("queueWhenOffline", true)) {
    await fs.rm(disabledMarker, { force: true });
  } else {
    await fs.writeFile(disabledMarker, "disabled\n", "utf8");
  }
}

async function refreshInstalledHookPaths(context: vscode.ExtensionContext): Promise<void> {
  if (process.env.FEISHU_AGENT_NOTIFIER_TEST === "1") {
    return;
  }
  try {
    const inspection = await inspectHooks();
    if (!inspection.codexInstalled
      && !inspection.claudeStopInstalled
      && !inspection.claudeStopFailureInstalled
      && !inspection.claudeMessageDisplayInstalled) {
      return;
    }
    await installHooks({
      helperPath: helperDestination(context),
      tokenFilePath: hookTokenDestination(context),
      spoolDirectory: pendingDirectory(),
      port: getSetting<number>("port", 37561)
    });
  } catch (error) {
    output?.warn(`更新 Hook 数据目录失败：${(error as Error).message}`);
  }
}

function helperDestination(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "feishu-agent-notifier-hook.cjs");
}

function hookTokenDestination(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "receiver-token");
}

async function writeHookTokenFile(context: vscode.ExtensionContext, token: string): Promise<void> {
  const destination = hookTokenDestination(context);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(destination, 0o600);
  }
}

async function getOrCreateHookToken(context: vscode.ExtensionContext): Promise<string> {
  const existing = await context.secrets.get(SECRET_HOOK_TOKEN);
  if (existing) {
    return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");
  await context.secrets.store(SECRET_HOOK_TOKEN, token);
  return token;
}

function getSetting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("feishuAgentNotifier").get<T>(key, fallback);
}

async function initializeDataDirectory(context: vscode.ExtensionContext): Promise<string> {
  const defaultPath = context.globalStorageUri.fsPath;
  const markerPath = path.join(defaultPath, "data-directory");
  await fs.mkdir(defaultPath, { recursive: true });
  try {
    const targetPath = resolveDataDirectory(getSetting<string>("dataDirectory", ""), defaultPath);
    const previousPath = await fs.readFile(markerPath, "utf8")
      .then((value) => value.trim() || defaultPath)
      .catch(() => defaultPath);
    const first = await prepareDataDirectory(previousPath, targetPath);
    const second = path.resolve(previousPath) === path.resolve(defaultPath)
      ? { migrated: [], retained: [] }
      : await prepareDataDirectory(defaultPath, targetPath);
    const migrated = [...first.migrated, ...second.migrated];
    const retained = [...first.retained, ...second.retained];
    await fs.writeFile(markerPath, `${targetPath}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.chmod(markerPath, 0o600);
    }
    output?.info(`本地数据目录：${targetPath}`);
    if (migrated.length > 0) {
      output?.info(`已迁移本地数据：${[...new Set(migrated)].join("、")}`);
    }
    if (retained.length > 0) {
      output?.warn(`目标目录已有同名数据，未覆盖：${[...new Set(retained)].join("、")}`);
    }
    return targetPath;
  } catch (error) {
    output?.error(`自定义数据目录不可用，已回退到 VS Code 扩展私有目录：${(error as Error).message}`);
    void vscode.window.showErrorMessage(`Feishu Agent Notifier 自定义数据目录不可用：${(error as Error).message}`);
    await prepareDataDirectory(defaultPath, defaultPath);
    return defaultPath;
  }
}

async function configureDataDirectory(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    title: "选择 Feishu Agent Notifier 本地数据目录",
    defaultUri: vscode.Uri.file(extensionStoragePath),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "使用此目录"
  });
  if (!selected?.[0]) {
    return;
  }
  const targetPath = resolveDataDirectory(selected[0].fsPath, context.globalStorageUri.fsPath);
  await fs.mkdir(targetPath, { recursive: true });
  configurationWizardSaving = true;
  try {
    await vscode.workspace.getConfiguration("feishuAgentNotifier")
      .update("dataDirectory", targetPath, vscode.ConfigurationTarget.Global);
  } finally {
    configurationWizardSaving = false;
  }
  await vscode.window.showInformationMessage(
    `本地数据目录已设为 ${targetPath}。窗口将重载并迁移现有数据；凭据仍保存在 SecretStorage。`
  );
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function refreshStatusBar(context: vscode.ExtensionContext): Promise<void> {
  const refreshId = ++statusRefreshId;
  const enabled = getSetting<boolean>("enabled", true);
  const deliveryTiming = getSetting<DeliveryTiming>("deliveryTiming", "realtime");
  const deliveryMode = getSetting<DeliveryMode>("deliveryMode", "webhook");
  const pendingCount = await pendingEventCount(pendingDirectory());
  let configurationOk = false;
  let hooksOk: boolean | undefined;
  let codexHookOk: boolean | undefined;
  let codexNotifyOk: boolean | undefined;
  let codexStopHookOk: boolean | undefined;
  let claudeHookOk: boolean | undefined;

  if (enabled) {
    try {
      validateConfig(await loadNotifierConfig(context));
      configurationOk = true;
    } catch {
      configurationOk = false;
    }
    try {
      const hooks = await inspectHooks();
      codexHookOk = hooks.codexInstalled;
      codexNotifyOk = hooks.codexNotifyInstalled;
      codexStopHookOk = hooks.codexStopInstalled;
      claudeHookOk = hooks.claudeStopInstalled
        && hooks.claudeStopFailureInstalled
        && (deliveryTiming === "completion" || hooks.claudeMessageDisplayInstalled);
      hooksOk = codexHookOk && claudeHookOk;
    } catch {
      hooksOk = false;
    }
  }

  if (refreshId !== statusRefreshId) {
    return;
  }
  statusSnapshot = {
    initializing: false,
    enabled,
    workspacePaused: await isWorkspacePaused(),
    receiverPort: hookServer?.port ?? receiverStandbyPort,
    receiverStandby: Boolean(receiverStandbyPort),
    receiverConflict: Boolean(receiverConflictPort),
    configurationOk,
    hooksOk,
    deliveryTiming,
    deliveryMode,
    pendingCount,
    activeDeliveries,
    codexHookOk,
    codexNotifyOk,
    codexStopHookOk,
    codexVersion: agentCapabilities.codexVersion,
    codexStopHookSupported: agentCapabilities.codexStopHook,
    claudeHookOk,
    claudeVersion: agentCapabilities.claudeVersion,
    claudeMessageDisplaySupported: agentCapabilities.claudeMessageDisplay,
    claudeSource: claudeRealtimeSource,
    lastDeliverySuccess,
    lastDeliveryError,
    remoteExecutionPolicy: getSetting<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled"),
    inboundState: feishuInboundState,
    inboundError: feishuInboundError,
    remoteActive: agentReplyQueue?.activeCount ?? 0,
    remotePending: agentReplyQueue?.pendingCount ?? 0,
    codexManagedState: codexAppServerClient?.state,
    codexManagedError: codexAppServerClient?.lastError
  };
  renderStatusBar();
}

function renderStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const presentation = buildStatusPresentation({
    ...statusSnapshot,
    activeDeliveries,
    claudeSource: claudeRealtimeSource,
    lastDeliverySuccess,
    lastDeliveryError,
    remoteExecutionPolicy: getSetting<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled"),
    inboundState: feishuInboundState,
    inboundError: feishuInboundError,
    remoteActive: agentReplyQueue?.activeCount ?? 0,
    remotePending: agentReplyQueue?.pendingCount ?? 0,
    codexManagedState: codexAppServerClient?.state,
    codexManagedError: codexAppServerClient?.lastError
  });
  statusBar.text = presentation.text;
  statusBar.backgroundColor = presentation.severity === "error"
    ? new vscode.ThemeColor("statusBarItem.errorBackground")
    : presentation.severity === "warning"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  statusBar.accessibilityInformation = {
    label: `Feishu Agent Notifier：${presentation.summary}`
  };
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown("**Feishu Agent Notifier**\n\n");
  tooltip.appendMarkdown(`${escapeMarkdown(presentation.summary)}\n\n`);
  for (const detail of presentation.details) {
    tooltip.appendMarkdown(`- ${escapeMarkdown(detail)}\n`);
  }
  tooltip.appendMarkdown("\n点击打开通知操作菜单。");
  statusBar.tooltip = tooltip;
}

interface StatusActionItem extends vscode.QuickPickItem {
  action: "pause" | "test" | "retry" | "repair" | "diagnostics" | "remoteConfig" | "dataDirectory" | "sessions" | "cancelRemote" | "settings" | "logs";
}

async function showStatus(context: vscode.ExtensionContext): Promise<void> {
  await refreshStatusBar(context);
  const presentation = buildStatusPresentation(statusSnapshot);
  const items: Array<StatusActionItem | vscode.QuickPickItem> = [];
  if (workspaceRoots().length > 0) {
    items.push({
      label: statusSnapshot.workspacePaused ? "$(play) 恢复当前工作区通知" : "$(debug-pause) 暂停当前工作区通知",
      description: "只影响当前 VS Code 工作区",
      action: "pause"
    });
  }
  items.push(
    { label: "$(send) 发送飞书测试消息", action: "test" },
    ...(statusSnapshot.pendingCount > 0
      ? [{ label: `$(sync) 重试 ${statusSnapshot.pendingCount} 条待处理通知`, action: "retry" as const }]
      : []),
    { label: "$(remote) 配置飞书远程操控", description: "权限、目标和白名单向导", action: "remoteConfig" },
    { label: "$(folder) 选择本地数据目录", description: extensionStoragePath, action: "dataDirectory" },
    { label: "$(list-tree) 查看本地 Agent 会话", action: "sessions" },
    ...((agentReplyQueue?.activeCount ?? 0) + (agentReplyQueue?.pendingCount ?? 0) > 0
      ? [{ label: "$(stop-circle) 取消远程回复任务", action: "cancelRemote" as const }]
      : []),
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(tools) 安装/修复 Agent 通知接入", action: "repair" },
    { label: "$(checklist) 运行完整自检", action: "diagnostics" },
    { label: "$(gear) 打开扩展设置", action: "settings" },
    { label: "$(output) 查看运行日志", action: "logs" }
  );
  const selection = await vscode.window.showQuickPick(items, {
    title: "Feishu Agent Notifier",
    placeHolder: presentation.summary,
    matchOnDescription: true
  }) as StatusActionItem | undefined;
  if (!selection?.action) {
    return;
  }
  switch (selection.action) {
    case "pause":
      await toggleWorkspacePause(context);
      break;
    case "test":
      await sendTestNotification(context);
      break;
    case "retry":
      await retryPendingEvents(context, true);
      break;
    case "repair":
      await installHookFiles(context);
      break;
    case "diagnostics":
      await runDiagnostics(context);
      break;
    case "remoteConfig":
      await configureRemoteControl(context);
      break;
    case "dataDirectory":
      await configureDataDirectory(context);
      break;
    case "sessions":
      await showRemoteSessions(context);
      break;
    case "cancelRemote":
      await cancelRemoteReplies();
      break;
    case "settings":
      await openSettings();
      break;
    case "logs":
      output?.show(true);
      break;
  }
}

async function toggleWorkspacePause(context: vscode.ExtensionContext): Promise<void> {
  if (workspaceRoots().length === 0) {
    await vscode.window.showWarningMessage("请先打开一个文件夹或工作区，再暂停项目通知。");
    return;
  }
  const paused = !await isWorkspacePaused();
  await setWorkspacePaused(workspacePauseFile(), workspaceRoots(), paused);
  await context.workspaceState.update(WORKSPACE_PAUSED_KEY, undefined);
  output?.info(`当前工作区通知已${paused ? "暂停" : "恢复"}。`);
  await refreshStatusBar(context);
  await vscode.window.showInformationMessage(`当前工作区的飞书 Agent 通知已${paused ? "暂停" : "恢复"}。`);
}

async function retryPendingEvents(context: vscode.ExtensionContext, userInitiated: boolean): Promise<void> {
  if (pendingDrain) {
    if (userInitiated) {
      await vscode.window.showInformationMessage("待处理通知正在投递中。 ");
    }
    return pendingDrain;
  }
  if (!hookServer?.port) {
    if (userInitiated) {
      const message = receiverStandbyPort
        ? "待处理队列由接收器所有者窗口管理；请在状态显示“本窗口接收”的窗口中重试。"
        : "本地通知接收器未运行，暂时无法重试。请先运行自检。";
      await vscode.window.showWarningMessage(message);
    }
    return;
  }

  const sender = new FeishuSender();
  pendingDrain = (async () => {
    const pausedRoots = await readPausedWorkspaceRoots(workspacePauseFile());
    const result = await drainPendingEvents(
      pendingDirectory(),
      async (event) => enqueueEvent(context, sender, event, false),
      (filePath, error) => output?.warn(`已隔离无效待处理文件 ${filePath}：${error.message}`),
      (event) => eventIsPaused(pausedRoots, event.cwd)
    );
    if (result.delivered > 0) {
      output?.info(`已补投 ${result.delivered} 条待处理 Agent 通知。`);
    }
    await refreshStatusBar(context);
    if (userInitiated) {
      const summary = result.remaining === 0
        ? `待处理通知重试完成：成功 ${result.delivered} 条。`
        : `已补投 ${result.delivered} 条，仍有 ${result.remaining} 条待处理；请查看日志。`;
      await vscode.window.showInformationMessage(summary);
    }
  })().finally(() => {
    pendingDrain = undefined;
  });
  return pendingDrain;
}

async function clearPendingEvents(context: vscode.ExtensionContext): Promise<void> {
  const count = await pendingEventCount(pendingDirectory());
  if (count === 0) {
    await vscode.window.showInformationMessage("没有待处理的 Agent 通知。 ");
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `永久删除 ${count} 条待处理 Agent 通知？这些文件可能包含完整回复，删除后无法恢复。`,
    { modal: true },
    "永久删除"
  );
  if (answer !== "永久删除") {
    return;
  }
  const entries = await fs.readdir(pendingDirectory(), { withFileTypes: true });
  const targets = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(pendingDirectory(), entry.name));
  await Promise.all(targets.map((filePath) => fs.rm(filePath, { force: true })));
  output?.info(`已永久删除 ${targets.length} 条待处理 Agent 通知。`);
  await refreshStatusBar(context);
  await vscode.window.showInformationMessage(`已删除 ${targets.length} 条待处理 Agent 通知。`);
}

async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  await refreshAgentExecutables();
  agentCapabilities = await detectAgentCapabilities(undefined, {
    codex: agentExecutablePaths.codex,
    claude: agentExecutablePaths["claude-code"]
  });
  logAgentCapabilities();
  const checks: string[] = [];
  checks.push(checkLine("本地数据目录", true, extensionStoragePath));
  checks.push(checkLine("扩展已启用", getSetting<boolean>("enabled", true)));
  checks.push(checkLine("消息投递时机", true,
    getSetting<DeliveryTiming>("deliveryTiming", "realtime") === "realtime"
      ? "实时逐条 assistant 文本"
      : "仅任务结束"));
  if (getSetting<DeliveryTiming>("deliveryTiming", "realtime") === "realtime") {
    checks.push(checkLine("Codex 实时监听", Boolean(codexTranscriptWatcher), "~/.codex/sessions"));
    checks.push(checkLine("Claude Code 实时监听", Boolean(claudeRealtimeSource),
      claudeRealtimeSource === "message-display"
        ? "官方 MessageDisplay Hook"
        : claudeRealtimeSource === "probing"
          ? "MessageDisplay 等待首个事件，transcript 兼容待命"
          : "transcript 兼容层"));
  }
  checks.push(checkLine("本地接收器", Boolean(hookServer?.port || receiverStandbyPort), hookServer?.port
    ? `127.0.0.1:${hookServer.port}，本窗口接收`
    : receiverStandbyPort
      ? `127.0.0.1:${receiverStandbyPort}，其他窗口接收，本窗口自动接管待命`
      : receiverConflictPort
        ? `端口 ${receiverConflictPort} 被不兼容进程或其他 Profile 占用`
        : "未运行"));

  try {
    validateConfig(await loadNotifierConfig(context));
    checks.push(checkLine("飞书配置", true, getSetting<DeliveryMode>("deliveryMode", "webhook")));
  } catch (error) {
    checks.push(checkLine("飞书配置", false, (error as Error).message));
  }

  const remotePolicy = getSetting<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled");
  checks.push(checkLine("飞书远程回复策略", true,
    remotePolicy === "disabled" ? "已禁用" : remotePolicy === "planOnly" ? "只读规划" : "继承本机权限"));
  if (remotePolicy !== "disabled") {
    checks.push(checkLine("Codex CLI", Boolean(agentExecutablePaths.codex),
      agentExecutablePaths.codex ?? "未找到；可在扩展设置中指定路径"));
    checks.push(checkLine("Claude Code CLI", Boolean(agentExecutablePaths["claude-code"]),
      agentExecutablePaths["claude-code"] ?? "未找到；可在扩展设置中指定路径"));
    checks.push(checkLine("飞书入站长连接", feishuInboundState === "connected",
      `${feishuInboundState}${feishuInboundError ? `，${feishuInboundError}` : ""}`));
    checks.push(checkLine("远程用户白名单",
      normalizedStringArray(getSetting<string[]>("remoteAllowedUserOpenIds", [])).length > 0,
      `${normalizedStringArray(getSetting<string[]>("remoteAllowedUserOpenIds", [])).length} 个 open_id`));
    checks.push(checkLine("远程回复队列", true,
      `运行 ${agentReplyQueue?.activeCount ?? 0}，排队 ${agentReplyQueue?.pendingCount ?? 0}`));
    checks.push(checkLine("Codex App Server 托管器", codexAppServerClient?.state !== "failed",
      `${codexAppServerClient?.state ?? "stopped"}${codexAppServerClient?.lastError ? `，${codexAppServerClient.lastError}` : ""}；首次 /new codex 时按需启动`));
  }

  try {
    const hooks = await inspectHooks();
    checks.push(checkLine("Codex 版本", Boolean(agentCapabilities.codexVersion),
      agentCapabilities.codexVersion ?? "未检测到"));
    checks.push(checkLine("Codex 官方 Stop Hook", hooks.codexStopInstalled,
      `${hooks.codexHooksPath}${agentCapabilities.codexStopHook === false ? "，当前版本未启用 Hooks" : ""}`));
    checks.push(checkLine("Codex notify 回退", hooks.codexNotifyInstalled, hooks.codexPath));
    checks.push(checkLine("Claude Code 版本", Boolean(agentCapabilities.claudeVersion),
      agentCapabilities.claudeVersion ?? "未检测到"));
    checks.push(checkLine("Claude Code Stop", hooks.claudeStopInstalled, hooks.claudePath));
    checks.push(checkLine("Claude Code StopFailure", hooks.claudeStopFailureInstalled, hooks.claudePath));
    checks.push(checkLine("Claude Code MessageDisplay", hooks.claudeMessageDisplayInstalled, hooks.claudePath));
  } catch (error) {
    checks.push(checkLine("Hook 配置解析", false, (error as Error).message));
  }

  const pending = await pendingEventCount(pendingDirectory());
  checks.push(checkLine("离线待处理队列", true,
    `${getSetting<boolean>("queueWhenOffline", true) ? "已启用" : "已关闭"}，${pending} 条待处理`));
  if (lastDeliverySuccess) {
    checks.push(checkLine("最近投递成功", true, formatDiagnosticTime(lastDeliverySuccess)));
  }
  if (lastDeliveryError) {
    checks.push(checkLine("最近投递错误", false, lastDeliveryError));
  }

  const report = [
    "# Feishu Agent Notifier 自检报告",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `扩展版本：${context.extension.packageJSON.version as string}`,
    `VS Code：${vscode.version}`,
    `平台：${process.platform} ${process.arch}`,
    "",
    "## 检查结果",
    "",
    ...checks,
    "",
    "> 报告不包含 Webhook、App Secret、本地接收 Token 或 Agent 回复正文。",
    ""
  ].join("\n");
  const document = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
  await vscode.window.showTextDocument(document, { preview: true });

  const selection = await vscode.window.showInformationMessage(
    "自检完成。 ",
    "安装/修复 Hooks",
    pending > 0 ? "重试待处理通知" : "打开设置",
    "查看日志"
  );
  if (selection === "安装/修复 Hooks") {
    await installHookFiles(context);
  } else if (selection === "重试待处理通知") {
    await retryPendingEvents(context, true);
  } else if (selection === "打开设置") {
    await openSettings();
  } else if (selection === "查看日志") {
    output?.show(true);
  }
}

function pendingDirectory(): string {
  return path.join(extensionStoragePath, "pending-events");
}

function checkLine(name: string, ok: boolean, detail = ""): string {
  const suffix = detail ? ` — ${detail.replace(/[\r\n]+/g, " ")}` : "";
  return `- ${ok ? "✅" : "❌"} **${name}**${suffix}`;
}

function formatDiagnosticTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

async function isWorkspacePaused(): Promise<boolean> {
  return workspaceIsPaused(await readPausedWorkspaceRoots(workspacePauseFile()), workspaceRoots());
}

function workspaceRoots(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function workspacePauseFile(): string {
  return path.join(extensionStoragePath, "paused-workspaces.json");
}

async function migrateWorkspacePause(context: vscode.ExtensionContext): Promise<void> {
  if (context.workspaceState.get<boolean>(WORKSPACE_PAUSED_KEY, false) && workspaceRoots().length > 0) {
    await setWorkspacePaused(workspacePauseFile(), workspaceRoots(), true);
    await context.workspaceState.update(WORKSPACE_PAUSED_KEY, undefined);
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${activeExtensionId}`);
}

interface RemotePolicyPick extends vscode.QuickPickItem {
  policy: RemoteExecutionPolicy;
}

interface ReceiveTypePick extends vscode.QuickPickItem {
  receiveIdType: ReceiveIdType;
}

async function configureRemoteControl(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("feishuAgentNotifier");
  const currentPolicy = configuration.get<RemoteExecutionPolicy>("remoteExecutionPolicy", "disabled");
  const policy = await vscode.window.showQuickPick<RemotePolicyPick>([
    {
      label: "$(lock) 只读规划（推荐）",
      description: "Codex 使用只读沙箱；Claude Code 使用 Plan 模式",
      detail: "可从飞书继续会话，但不允许 Agent 修改文件。",
      policy: "planOnly",
      picked: currentPolicy === "planOnly"
    },
    {
      label: "$(circle-slash) 关闭远程操控",
      description: "停止飞书入站长连接并拒绝所有远程指令",
      policy: "disabled",
      picked: currentPolicy === "disabled"
    },
    {
      label: "$(warning) 继承本机权限",
      description: "可能修改文件、执行命令并消耗 Agent 配额",
      detail: "仅在完全信任白名单用户和目标群时启用。",
      policy: "inherit",
      picked: currentPolicy === "inherit"
    }
  ], {
    title: "飞书远程操控 · 1/6 执行权限",
    placeHolder: "建议先使用只读规划模式",
    ignoreFocusOut: true
  });
  if (!policy) {
    return;
  }
  if (policy.policy === "disabled") {
    await saveRemoteControlSettings(context, { remoteExecutionPolicy: "disabled" });
    await vscode.window.showInformationMessage("飞书远程操控已关闭；原白名单已保留，重新启用时可继续使用。 ");
    return;
  }

  const currentReceiveType = configuration.get<ReceiveIdType>("receiveIdType", "chat_id");
  const receiveType = await vscode.window.showQuickPick<ReceiveTypePick>([
    { label: "$(organization) 群聊 Chat ID", description: "以 oc_ 开头；机器人必须已加入该群", receiveIdType: "chat_id", picked: currentReceiveType === "chat_id" },
    { label: "$(account) 用户 Open ID", description: "以 ou_ 开头", receiveIdType: "open_id", picked: currentReceiveType === "open_id" },
    { label: "$(person) 用户 ID", description: "企业内部 user_id", receiveIdType: "user_id", picked: currentReceiveType === "user_id" },
    { label: "$(mail) 用户邮箱", description: "飞书企业成员邮箱", receiveIdType: "email", picked: currentReceiveType === "email" }
  ], {
    title: "飞书远程操控 · 2/6 通知发送目标",
    placeHolder: "选择机器人主动发送 Agent 通知的目标类型",
    ignoreFocusOut: true
  });
  if (!receiveType) {
    return;
  }
  const receiveId = await vscode.window.showInputBox({
    title: "飞书远程操控 · 3/6 通知目标 ID",
    prompt: receiveType.receiveIdType === "chat_id"
      ? "填写目标群 chat_id；请先确保当前应用机器人已经加入该群"
      : "填写与上一步类型对应的飞书用户标识",
    value: configuration.get<string>("receiveId", ""),
    placeHolder: receiveType.receiveIdType === "chat_id" ? "oc_xxxxxxxxxxxxxxxx" : receiveType.receiveIdType === "open_id" ? "ou_xxxxxxxxxxxxxxxx" : "目标标识",
    ignoreFocusOut: true,
    validateInput: (value) => validateReceiveIdInput(value, receiveType.receiveIdType)
  });
  if (receiveId === undefined) {
    return;
  }

  const allowedUsersInput = await vscode.window.showInputBox({
    title: "飞书远程操控 · 4/6 用户白名单",
    prompt: "只有这些飞书用户可以操控本机 Agent；多个 open_id 用逗号、空格或换行分隔",
    value: normalizedStringArray(configuration.get<string[]>("remoteAllowedUserOpenIds", [])).join(", "),
    placeHolder: "ou_xxxxxxxxxxxxxxxx",
    ignoreFocusOut: true,
    validateInput: (value) => validateIdListInput(value, "ou_", "用户 open_id", true)
  });
  if (allowedUsersInput === undefined) {
    return;
  }
  const allowedUsers = parseIdList(allowedUsersInput);

  const currentChats = normalizedStringArray(configuration.get<string[]>("remoteAllowedChatIds", []));
  const groupMode = await vscode.window.showQuickPick([
    {
      label: "$(organization) 同时允许群聊操控",
      description: "群聊还需要单独填写 chat_id 白名单",
      enabled: true,
      picked: currentChats.length > 0
    },
    {
      label: "$(account) 只允许白名单用户单聊操控",
      description: "不接受任何群聊指令",
      enabled: false,
      picked: currentChats.length === 0
    }
  ], {
    title: "飞书远程操控 · 5/6 使用范围",
    placeHolder: "选择是否允许群聊中的 @机器人 指令",
    ignoreFocusOut: true
  });
  if (!groupMode) {
    return;
  }

  let allowedChats: string[] = [];
  let requireMention = true;
  if (groupMode.enabled) {
    const suggestedChats = currentChats.length > 0
      ? currentChats
      : receiveType.receiveIdType === "chat_id" ? [receiveId.trim()] : [];
    const allowedChatsInput = await vscode.window.showInputBox({
      title: "飞书远程操控 · 6/6 群聊白名单",
      prompt: "只有这些群可以提交指令；多个 chat_id 用逗号、空格或换行分隔",
      value: suggestedChats.join(", "),
      placeHolder: "oc_xxxxxxxxxxxxxxxx",
      ignoreFocusOut: true,
      validateInput: (value) => validateIdListInput(value, "oc_", "群聊 chat_id", true)
    });
    if (allowedChatsInput === undefined) {
      return;
    }
    allowedChats = parseIdList(allowedChatsInput);
    const mentionChoice = await vscode.window.showQuickPick([
      { label: "$(verified) 必须 @机器人（推荐）", description: "降低群内普通对话被误执行的风险", required: true },
      { label: "$(warning) 不要求 @机器人", description: "白名单群里的文本事件可能被当作指令", required: false }
    ], {
      title: "飞书远程操控 · 群聊触发保护",
      placeHolder: "建议始终要求 @机器人",
      ignoreFocusOut: true
    });
    if (!mentionChoice) {
      return;
    }
    requireMention = mentionChoice.required;
  }

  if (policy.policy === "inherit") {
    const confirmation = await vscode.window.showWarningMessage(
      "继承本机权限后，飞书白名单用户可以让 Codex/Claude Code 修改文件、执行命令并消耗配额。确定启用吗？",
      { modal: true },
      "我理解风险并启用"
    );
    if (confirmation !== "我理解风险并启用") {
      return;
    }
  }

  await saveRemoteControlSettings(context, {
    deliveryMode: "app",
    receiveIdType: receiveType.receiveIdType,
    receiveId: receiveId.trim(),
    remoteExecutionPolicy: policy.policy,
    remoteAllowedUserOpenIds: allowedUsers,
    remoteAllowedChatIds: allowedChats,
    remoteRequireGroupMention: requireMention
  });
  const groupSummary = allowedChats.length > 0 ? `，群聊 ${allowedChats.length} 个` : "，仅单聊";
  await vscode.window.showInformationMessage(
    `远程操控配置已保存：${policy.policy === "planOnly" ? "只读规划" : "继承本机权限"}，用户 ${allowedUsers.length} 个${groupSummary}。`
  );
}

async function saveRemoteControlSettings(
  context: vscode.ExtensionContext,
  values: Record<string, unknown>
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("feishuAgentNotifier");
  configurationWizardSaving = true;
  try {
    for (const [key, value] of Object.entries(values)) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
  } finally {
    configurationWizardSaving = false;
  }
  await deployHelper(context);
  await restartServer(context);
}


function validateWebhookInput(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn") {
      return "必须是 https://open.feishu.cn 的机器人 Webhook";
    }
    return undefined;
  } catch {
    return "Webhook URL 格式无效";
  }
}

function cleanupRecentEvents(now: number): void {
  for (const [key, timestamp] of recentEvents) {
    if (now - timestamp > 10 * 60 * 1000) {
      recentEvents.delete(key);
    }
  }
  for (const [key, observed] of recentMessageBodies) {
    if (now - observed.timestamp > 10 * 60 * 1000) {
      recentMessageBodies.delete(key);
    }
  }
}

function realtimeMessageKey(event: AgentEvent): string {
  return crypto.createHash("sha256")
    .update(`${event.source}\0${event.sessionId}\0${event.message}`)
    .digest("hex");
}

async function showOperationError(prefix: string, error: unknown): Promise<void> {
  const message = `${prefix}：${(error as Error).message}`;
  output?.error(message);
  const selection = await vscode.window.showErrorMessage(message, "查看日志");
  if (selection === "查看日志") {
    output?.show(true);
  }
}
