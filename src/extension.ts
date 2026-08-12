import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { CodexTranscriptWatcher } from "./codexTranscriptWatcher";
import { eventDeduplicationKey } from "./event";
import { FeishuSender, validateConfig } from "./feishu";
import { inspectHooks, installHooks, uninstallHooks } from "./hookInstaller";
import {
  formatLocalNotification,
  LocalNotificationMode,
  shouldShowLocalNotification
} from "./localNotification";
import { LocalHookServer } from "./server";
import { drainPendingEvents, pendingEventCount, queuePendingEvent } from "./pendingQueue";
import { AgentEvent, DeliveryMode, MessageFormat, NotifierConfig, ReceiveIdType } from "./types";

const SECRET_WEBHOOK_URL = "feishuAgentNotifier.webhookUrl";
const SECRET_WEBHOOK_SECRET = "feishuAgentNotifier.webhookSecret";
const SECRET_APP_ID = "feishuAgentNotifier.appId";
const SECRET_APP_SECRET = "feishuAgentNotifier.appSecret";
const SECRET_HOOK_TOKEN = "feishuAgentNotifier.hookToken";

let hookServer: LocalHookServer | undefined;
let codexTranscriptWatcher: CodexTranscriptWatcher | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.LogOutputChannel | undefined;
let sendQueue: Promise<void> = Promise.resolve();
let pendingDrain: Promise<void> | undefined;
let lastDeliverySuccess: string | undefined;
let lastDeliveryError: string | undefined;
let lastDeliveryErrorNotificationAt = 0;
let extensionStoragePath = "";
let activeExtensionId = "local.feishu-agent-notifier";
const recentEvents = new Map<string, number>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionStoragePath = context.globalStorageUri.fsPath;
  activeExtensionId = context.extension.id;
  output = vscode.window.createOutputChannel("Feishu Agent Notifier", { log: true });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = "feishuAgentNotifier.showStatus";
  statusBar.show();
  context.subscriptions.push(output, statusBar);
  await migrateLegacySecrets(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("feishuAgentNotifier.installHooks", () => installHookFiles(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.uninstallHooks", removeHookFiles),
    vscode.commands.registerCommand("feishuAgentNotifier.testNotification", () => sendTestNotification(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.testLocalNotification", sendLocalTestNotification),
    vscode.commands.registerCommand("feishuAgentNotifier.storeSecrets", () => storeSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearSecrets", () => clearSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.openSettings", openSettings),
    vscode.commands.registerCommand("feishuAgentNotifier.showStatus", showStatus),
    vscode.commands.registerCommand("feishuAgentNotifier.runDiagnostics", () => runDiagnostics(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.retryPending", () => retryPendingEvents(context, true)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearPending", clearPendingEvents),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("feishuAgentNotifier")) {
        return;
      }
      await deployHelper(context);
      await restartServer(context);
      updateStatusBar();
    })
  );

  await deployHelper(context);
  await restartServer(context);
  updateStatusBar();
}

export async function deactivate(): Promise<void> {
  codexTranscriptWatcher?.stop();
  codexTranscriptWatcher = undefined;
  await hookServer?.stop();
  hookServer = undefined;
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
  codexTranscriptWatcher?.stop();
  codexTranscriptWatcher = undefined;
  await hookServer?.stop();
  hookServer = undefined;
  if (!getSetting<boolean>("enabled", true)) {
    output?.info("通知接收器已禁用。 ");
    return;
  }

  const token = await getOrCreateHookToken(context);
  const integrationTest = process.env.FEISHU_AGENT_NOTIFIER_TEST === "1";
  const port = integrationTest ? 0 : getSetting<number>("port", 37561);
  const sender = new FeishuSender();
  hookServer = new LocalHookServer(token, async (event) => {
    enqueueEvent(context, sender, event);
  });

  try {
    await hookServer.start(port);
    output?.info(`本地 Hook 接收器正在监听 127.0.0.1:${port}`);
    void retryPendingEvents(context, false);
    if (!integrationTest && getSetting<boolean>("watchCodexIde", true)) {
      codexTranscriptWatcher = new CodexTranscriptWatcher(
        async (event) => enqueueEvent(context, sender, event),
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        undefined,
        (error) => output?.warn(`Codex IDE transcript 监听失败：${error.message}`)
      );
      await codexTranscriptWatcher.start();
      output?.info("Codex IDE transcript 完成事件监听已启动。");
    }
  } catch (error) {
    hookServer = undefined;
    const message = (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，可能是另一个 VS Code 窗口正在运行通知接收器。`
      : `无法启动本地 Hook 接收器：${(error as Error).message}`;
    output?.warn(message);
  }
}

function enqueueEvent(
  context: vscode.ExtensionContext,
  sender: FeishuSender,
  event: AgentEvent,
  queueOnFailure = true
): Promise<void> {
  const key = eventDeduplicationKey(event);
  const now = Date.now();
  cleanupRecentEvents(now);
  if (key !== "unknown:::Stop" && recentEvents.has(key)) {
    output?.info(`忽略重复事件：${key}`);
    return Promise.resolve();
  }
  recentEvents.set(key, now);
  void showLocalNotification(event).catch((error) => {
    output?.warn(`本地提醒失败：${(error as Error).message}`);
  });

  const delivery = sendQueue
    .then(async () => {
      const config = await loadNotifierConfig(context);
      const count = await sender.sendEvent(event, config);
      if (count > 0) {
        lastDeliverySuccess = new Date().toISOString();
        lastDeliveryError = undefined;
        output?.info(`已发送 ${event.source}/${event.project}，共 ${count} 条飞书消息。`);
      }
    });
  sendQueue = delivery.catch(async (error) => {
      if (recentEvents.get(key) === now) {
        recentEvents.delete(key);
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
    });
  return delivery;
}

async function showLocalNotification(event: AgentEvent, force = false): Promise<void> {
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
    output?.info(`Codex notify: ${result.codexPath}`);
    output?.info(`Claude hooks: ${result.claudePath}`);
    const detail = [
      result.codexChanged ? "Codex 已更新" : "Codex 无变化",
      result.claudeChanged ? "Claude Code 已更新" : "Claude Code 无变化"
    ].join("；");
    await vscode.window.showInformationMessage(
      `通知接入安装完成：${detail}。Codex 使用 notify，无需 /hooks 审核。`
    );
  } catch (error) {
    await showOperationError("安装 Hooks 失败", error);
  }
}

async function removeHookFiles(): Promise<void> {
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
    await vscode.window.showInformationMessage(`测试成功，已发送 ${count} 条飞书消息。`);
  } catch (error) {
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
  await vscode.window.showInformationMessage("飞书凭据已保存到 VS Code SecretStorage。请继续填写目标设置并发送测试消息。 ");
}

async function clearSecrets(context: vscode.ExtensionContext): Promise<void> {
  for (const key of [SECRET_WEBHOOK_URL, SECRET_WEBHOOK_SECRET, SECRET_APP_ID, SECRET_APP_SECRET]) {
    await context.secrets.delete(key);
  }
  await clearLegacySecretSettings(["webhookUrl", "webhookSecret", "appId", "appSecret"]);
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

function updateStatusBar(): void {
  if (!statusBar) {
    return;
  }
  if (!getSetting<boolean>("enabled", true)) {
    statusBar.text = "$(bell-slash) 飞书 Agent";
    statusBar.tooltip = "Feishu Agent Notifier 已禁用";
    return;
  }
  if (hookServer?.port) {
    statusBar.text = "$(bell) 飞书 Agent";
    statusBar.tooltip = `正在监听 127.0.0.1:${hookServer.port}`;
  } else {
    statusBar.text = "$(warning) 飞书 Agent";
    statusBar.tooltip = "本地 Hook 接收器未运行；点击查看状态";
  }
}

async function showStatus(): Promise<void> {
  const mode = getSetting<DeliveryMode>("deliveryMode", "webhook");
  const pending = await pendingEventCount(pendingDirectory());
  const receiver = hookServer?.port
    ? `运行中（127.0.0.1:${hookServer.port}）`
    : "未运行或由另一个 VS Code 窗口占用";
  const selection = await vscode.window.showInformationMessage(
    `Feishu Agent Notifier：${receiver}；投递模式：${mode}；待处理：${pending}。`,
    "打开设置",
    "运行自检",
    "查看日志"
  );
  if (selection === "打开设置") {
    await openSettings();
  } else if (selection === "运行自检") {
    await vscode.commands.executeCommand("feishuAgentNotifier.runDiagnostics");
  } else if (selection === "查看日志") {
    output?.show(true);
  }
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
      (filePath, error) => output?.warn(`已隔离无效待处理文件 ${filePath}：${error.message}`)
    );
    if (result.delivered > 0) {
      output?.info(`已补投 ${result.delivered} 条待处理 Agent 通知。`);
    }
    updateStatusBar();
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

async function clearPendingEvents(): Promise<void> {
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
  await vscode.window.showInformationMessage(`已删除 ${targets.length} 条待处理 Agent 通知。`);
}

async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const checks: string[] = [];
  checks.push(checkLine("扩展已启用", getSetting<boolean>("enabled", true)));
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
}

async function showOperationError(prefix: string, error: unknown): Promise<void> {
  const message = `${prefix}：${(error as Error).message}`;
  output?.error(message);
  const selection = await vscode.window.showErrorMessage(message, "查看日志");
  if (selection === "查看日志") {
    output?.show(true);
  }
}
