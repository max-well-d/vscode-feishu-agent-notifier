import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { ClaudeTranscriptWatcher } from "./claudeTranscriptWatcher";
import { CodexTranscriptWatcher } from "./codexTranscriptWatcher";
import { eventBelongsToWorkspace, eventDeduplicationKey, isCrossOriginDuplicate } from "./event";
import { FeishuSender, validateConfig } from "./feishu";
import { inspectHooks, installHooks, uninstallHooks } from "./hookInstaller";
import { HookEventNormalizer } from "./hookEventNormalizer";
import {
  formatLocalNotification,
  LocalNotificationMode,
  shouldShowLocalNotification
} from "./localNotification";
import { LocalHookServer } from "./server";
import { buildStatusPresentation, StatusSnapshot } from "./statusUi";
import { drainPendingEvents, pendingEventCount, queuePendingEvent } from "./pendingQueue";
import {
  AgentEvent,
  DeliveryMode,
  DeliveryTiming,
  MessageFormat,
  NotifierConfig,
  ReceiveIdType
} from "./types";

const SECRET_WEBHOOK_URL = "feishuAgentNotifier.webhookUrl";
const SECRET_WEBHOOK_SECRET = "feishuAgentNotifier.webhookSecret";
const SECRET_APP_ID = "feishuAgentNotifier.appId";
const SECRET_APP_SECRET = "feishuAgentNotifier.appSecret";
const SECRET_HOOK_TOKEN = "feishuAgentNotifier.hookToken";
const WORKSPACE_PAUSED_KEY = "feishuAgentNotifier.workspacePaused";

let hookServer: LocalHookServer | undefined;
let codexTranscriptWatcher: CodexTranscriptWatcher | undefined;
let claudeTranscriptWatcher: ClaudeTranscriptWatcher | undefined;
let claudeRealtimeSource: "message-display" | "transcript" | "probing" | undefined;
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
  extensionStoragePath = context.globalStorageUri.fsPath;
  activeExtensionId = context.extension.id;
  output = vscode.window.createOutputChannel("Feishu Agent Notifier", { log: true });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.name = "Feishu Agent Notifier 状态";
  statusBar.command = "feishuAgentNotifier.showStatus";
  renderStatusBar();
  statusBar.show();
  context.subscriptions.push(output, statusBar);
  await migrateLegacySecrets(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("feishuAgentNotifier.installHooks", () => installHookFiles(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.uninstallHooks", () => removeHookFiles(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.testNotification", () => sendTestNotification(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.testLocalNotification", sendLocalTestNotification),
    vscode.commands.registerCommand("feishuAgentNotifier.storeSecrets", () => storeSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearSecrets", () => clearSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.openSettings", openSettings),
    vscode.commands.registerCommand("feishuAgentNotifier.showStatus", () => showStatus(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.toggleWorkspacePause", () => toggleWorkspacePause(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.runDiagnostics", () => runDiagnostics(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.retryPending", () => retryPendingEvents(context, true)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearPending", () => clearPendingEvents(context)),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("feishuAgentNotifier")) {
        return;
      }
      await deployHelper(context);
      await restartServer(context);
    })
  );

  await deployHelper(context);
  await restartServer(context);
}

export async function deactivate(): Promise<void> {
  codexTranscriptWatcher?.stop();
  codexTranscriptWatcher = undefined;
  claudeTranscriptWatcher?.stop();
  claudeTranscriptWatcher = undefined;
  claudeRealtimeSource = undefined;
  await hookServer?.stop();
  hookServer = undefined;
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
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
      } else if (messageDisplayInstalled) {
        claudeRealtimeSource = "probing";
        output?.info("Claude Code MessageDisplay 已配置；transcript 兼容监听将在首次 Hook 事件后关闭。");
      } else {
        claudeRealtimeSource = "transcript";
        output?.warn("Claude Code MessageDisplay Hook 未安装，暂用 transcript 兼容监听；请运行安装/修复 Hooks。");
      }
    }
  } catch (error) {
    hookServer = undefined;
    const message = (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，可能是另一个 VS Code 窗口正在运行通知接收器。`
      : `无法启动本地 Hook 接收器：${(error as Error).message}`;
    output?.warn(message);
  }
  await refreshStatusBar(context);
}

function enqueueEvent(
  context: vscode.ExtensionContext,
  sender: FeishuSender,
  event: AgentEvent,
  queueOnFailure = true
): Promise<void> {
  if (isWorkspacePaused(context) && eventBelongsToWorkspace(event.cwd, workspaceRoots())) {
    output?.info(`当前工作区已暂停，跳过 ${event.source}/${event.project} 通知。`);
    return Promise.resolve();
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
        const config = await loadNotifierConfig(context);
        const count = await sender.sendEvent(event, config);
        if (count > 0) {
          lastDeliverySuccess = new Date().toISOString();
          lastDeliveryError = undefined;
          output?.info(`已发送 ${event.source}/${event.project}，共 ${count} 条飞书消息。`);
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
    const helperPath = helperDestination(context);
    const port = getSetting<number>("port", 37561);
    const result = await installHooks({ helperPath, port, token });
    await restartServer(context);
    output?.info(`Codex notify: ${result.codexPath}`);
    output?.info(`Claude hooks: ${result.claudePath}`);
    const detail = [
      result.codexChanged ? "Codex 已更新" : "Codex 无变化",
      result.claudeChanged ? "Claude Code 已更新" : "Claude Code 无变化"
    ].join("；");
    await vscode.window.showInformationMessage(
      `通知接入安装完成：${detail}。Claude Code 实时消息使用 MessageDisplay；Codex 使用 notify，无需 /hooks 审核。`
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
    const count = await sender.sendEvent({
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
    await vscode.window.showInformationMessage(`测试成功，已发送 ${count} 条飞书消息。`);
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
  await refreshStatusBar(context);
  await vscode.window.showInformationMessage("飞书凭据已保存到 VS Code SecretStorage。请继续填写目标设置并发送测试消息。 ");
}

async function clearSecrets(context: vscode.ExtensionContext): Promise<void> {
  for (const key of [SECRET_WEBHOOK_URL, SECRET_WEBHOOK_SECRET, SECRET_APP_ID, SECRET_APP_SECRET]) {
    await context.secrets.delete(key);
  }
  await clearLegacySecretSettings(["webhookUrl", "webhookSecret", "appId", "appSecret"]);
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
  const disabledMarker = path.join(context.globalStorageUri.fsPath, "offline-queue-disabled");
  if (getSetting<boolean>("queueWhenOffline", true)) {
    await fs.rm(disabledMarker, { force: true });
  } else {
    await fs.writeFile(disabledMarker, "disabled\n", "utf8");
  }
}

function helperDestination(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "feishu-agent-notifier-hook.cjs");
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

async function refreshStatusBar(context: vscode.ExtensionContext): Promise<void> {
  const refreshId = ++statusRefreshId;
  const enabled = getSetting<boolean>("enabled", true);
  const deliveryTiming = getSetting<DeliveryTiming>("deliveryTiming", "realtime");
  const deliveryMode = getSetting<DeliveryMode>("deliveryMode", "webhook");
  const pendingCount = await pendingEventCount(pendingDirectory());
  let configurationOk = false;
  let hooksOk: boolean | undefined;
  let codexHookOk: boolean | undefined;
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
    workspacePaused: isWorkspacePaused(context),
    receiverPort: hookServer?.port,
    configurationOk,
    hooksOk,
    deliveryTiming,
    deliveryMode,
    pendingCount,
    activeDeliveries,
    codexHookOk,
    claudeHookOk,
    claudeSource: claudeRealtimeSource,
    lastDeliverySuccess,
    lastDeliveryError
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
    lastDeliveryError
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
  action: "pause" | "test" | "retry" | "repair" | "diagnostics" | "settings" | "logs";
}

async function showStatus(context: vscode.ExtensionContext): Promise<void> {
  await refreshStatusBar(context);
  const presentation = buildStatusPresentation(statusSnapshot);
  const items: Array<StatusActionItem | vscode.QuickPickItem> = [];
  if (workspaceRoots().length > 0) {
    items.push({
      label: isWorkspacePaused(context) ? "$(play) 恢复当前工作区通知" : "$(debug-pause) 暂停当前工作区通知",
      description: "只影响当前 VS Code 工作区",
      action: "pause"
    });
  }
  items.push(
    { label: "$(send) 发送飞书测试消息", action: "test" },
    ...(statusSnapshot.pendingCount > 0
      ? [{ label: `$(sync) 重试 ${statusSnapshot.pendingCount} 条待处理通知`, action: "retry" as const }]
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
  const paused = !isWorkspacePaused(context);
  await context.workspaceState.update(WORKSPACE_PAUSED_KEY, paused);
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
      await vscode.window.showWarningMessage("本地通知接收器未运行，暂时无法重试。请先运行自检。 ");
    }
    return;
  }

  const sender = new FeishuSender();
  pendingDrain = (async () => {
    const result = await drainPendingEvents(
      pendingDirectory(),
      async (event) => enqueueEvent(context, sender, event, false),
      (filePath, error) => output?.warn(`已隔离无效待处理文件 ${filePath}：${error.message}`),
      (event) => isWorkspacePaused(context) && eventBelongsToWorkspace(event.cwd, workspaceRoots())
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
  const checks: string[] = [];
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
  checks.push(checkLine("本地接收器", Boolean(hookServer?.port), hookServer?.port
    ? `127.0.0.1:${hookServer.port}`
    : "未运行或端口被其他窗口占用"));

  try {
    validateConfig(await loadNotifierConfig(context));
    checks.push(checkLine("飞书配置", true, getSetting<DeliveryMode>("deliveryMode", "webhook")));
  } catch (error) {
    checks.push(checkLine("飞书配置", false, (error as Error).message));
  }

  try {
    const hooks = await inspectHooks();
    checks.push(checkLine("Codex CLI notify", hooks.codexInstalled, hooks.codexPath));
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

function isWorkspacePaused(context: vscode.ExtensionContext): boolean {
  return context.workspaceState.get<boolean>(WORKSPACE_PAUSED_KEY, false);
}

function workspaceRoots(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${activeExtensionId}`);
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
