import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { eventDeduplicationKey } from "./event";
import { FeishuSender, validateConfig } from "./feishu";
import { installHooks, uninstallHooks } from "./hookInstaller";
import { LocalHookServer } from "./server";
import { AgentEvent, DeliveryMode, NotifierConfig, ReceiveIdType } from "./types";

const SECRET_WEBHOOK_URL = "feishuAgentNotifier.webhookUrl";
const SECRET_WEBHOOK_SECRET = "feishuAgentNotifier.webhookSecret";
const SECRET_APP_ID = "feishuAgentNotifier.appId";
const SECRET_APP_SECRET = "feishuAgentNotifier.appSecret";
const SECRET_HOOK_TOKEN = "feishuAgentNotifier.hookToken";

let hookServer: LocalHookServer | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.LogOutputChannel | undefined;
let sendQueue: Promise<void> = Promise.resolve();
const recentEvents = new Map<string, number>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Feishu Agent Notifier", { log: true });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = "feishuAgentNotifier.showStatus";
  statusBar.show();
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("feishuAgentNotifier.installHooks", () => installHookFiles(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.uninstallHooks", removeHookFiles),
    vscode.commands.registerCommand("feishuAgentNotifier.testNotification", () => sendTestNotification(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.storeSecrets", () => storeSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.clearSecrets", () => clearSecrets(context)),
    vscode.commands.registerCommand("feishuAgentNotifier.openSettings", openSettings),
    vscode.commands.registerCommand("feishuAgentNotifier.showStatus", showStatus),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("feishuAgentNotifier")) {
        return;
      }
      await restartServer(context);
      updateStatusBar();
    })
  );

  await deployHelper(context);
  await restartServer(context);
  updateStatusBar();
}

export async function deactivate(): Promise<void> {
  await hookServer?.stop();
  hookServer = undefined;
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
  await hookServer?.stop();
  hookServer = undefined;
  if (!getSetting<boolean>("enabled", true)) {
    output?.info("通知接收器已禁用。 ");
    return;
  }

  const token = await getOrCreateHookToken(context);
  const port = getSetting<number>("port", 37561);
  const sender = new FeishuSender();
  hookServer = new LocalHookServer(token, async (event) => {
    enqueueEvent(context, sender, event);
  });

  try {
    await hookServer.start(port);
    output?.info(`本地 Hook 接收器正在监听 127.0.0.1:${port}`);
  } catch (error) {
    hookServer = undefined;
    const message = (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，可能是另一个 VS Code 窗口正在运行通知接收器。`
      : `无法启动本地 Hook 接收器：${(error as Error).message}`;
    output?.warn(message);
  }
}

function enqueueEvent(context: vscode.ExtensionContext, sender: FeishuSender, event: AgentEvent): void {
  const key = eventDeduplicationKey(event);
  const now = Date.now();
  cleanupRecentEvents(now);
  if (key !== "unknown:::Stop" && recentEvents.has(key)) {
    output?.info(`忽略重复事件：${key}`);
    return;
  }
  recentEvents.set(key, now);

  sendQueue = sendQueue
    .then(async () => {
      const config = await loadNotifierConfig(context);
      const count = await sender.sendEvent(event, config);
      if (count > 0) {
        output?.info(`已发送 ${event.source}/${event.project}，共 ${count} 条飞书消息。`);
      }
    })
    .catch((error) => {
      const message = `发送飞书通知失败：${(error as Error).message}`;
      output?.error(message);
      void vscode.window.showErrorMessage(message, "查看日志").then((selection) => {
        if (selection === "查看日志") {
          output?.show(true);
        }
      });
    });
}

async function installHookFiles(context: vscode.ExtensionContext): Promise<void> {
  try {
    await deployHelper(context);
    const token = await getOrCreateHookToken(context);
    const helperPath = helperDestination(context);
    const port = getSetting<number>("port", 37561);
    const result = await installHooks({ helperPath, port, token });
    output?.info(`Codex hooks: ${result.codexPath}`);
    output?.info(`Claude hooks: ${result.claudePath}`);
    const detail = [
      result.codexChanged ? "Codex 已更新" : "Codex 无变化",
      result.claudeChanged ? "Claude Code 已更新" : "Claude Code 无变化"
    ].join("；");
    await vscode.window.showInformationMessage(
      `Hooks 安装完成：${detail}。首次运行 Codex 时请用 /hooks 审核并信任新 Hook。`
    );
  } catch (error) {
    await showOperationError("安装 Hooks 失败", error);
  }
}

async function removeHookFiles(): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    "从用户级 Codex 与 Claude Code 配置中移除 Feishu Agent Notifier Hooks？",
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
  }
  await vscode.window.showInformationMessage("飞书凭据已保存到 VS Code SecretStorage。请继续填写目标设置并发送测试消息。 ");
}

async function clearSecrets(context: vscode.ExtensionContext): Promise<void> {
  for (const key of [SECRET_WEBHOOK_URL, SECRET_WEBHOOK_SECRET, SECRET_APP_ID, SECRET_APP_SECRET]) {
    await context.secrets.delete(key);
  }
  await vscode.window.showInformationMessage("Feishu Agent Notifier 安全凭据已清除；普通设置中的明文值未修改。 ");
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
    includeMetadata: getSetting<boolean>("includeMetadata", true),
    maxChunkCharacters: getSetting<number>("maxChunkCharacters", 12000),
    notifyOnFailure: getSetting<boolean>("notifyOnFailure", true)
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
  const receiver = hookServer?.port
    ? `运行中（127.0.0.1:${hookServer.port}）`
    : "未运行或由另一个 VS Code 窗口占用";
  const selection = await vscode.window.showInformationMessage(
    `Feishu Agent Notifier：${receiver}；投递模式：${mode}。`,
    "打开设置",
    "查看日志"
  );
  if (selection === "打开设置") {
    await openSettings();
  } else if (selection === "查看日志") {
    output?.show(true);
  }
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.feishu-agent-notifier");
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
