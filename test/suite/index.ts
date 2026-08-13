import assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("local.feishu-agent-notifier");
  assert.ok(extension, "extension should be discoverable in the Extension Host");
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "feishuAgentNotifier.installHooks",
    "feishuAgentNotifier.testNotification",
    "feishuAgentNotifier.toggleWorkspacePause",
    "feishuAgentNotifier.runDiagnostics",
    "feishuAgentNotifier.retryPending",
    "feishuAgentNotifier.clearPending",
    "feishuAgentNotifier.configureRemoteControl",
    "feishuAgentNotifier.showRemoteSessions",
    "feishuAgentNotifier.cancelRemoteReplies",
    "feishuAgentNotifier.installProcessBridge",
    "feishuAgentNotifier.uninstallProcessBridge"
  ]) {
    assert.ok(commands.includes(command), `missing registered command: ${command}`);
  }

  const config = vscode.workspace.getConfiguration("feishuAgentNotifier");
  assert.equal(config.get("enabled"), true);
  assert.equal(config.get("deliveryTiming"), "realtime");
  assert.equal(config.get("queueWhenOffline"), true);
  assert.equal(config.get("deliveryMaxAttempts"), 3);
  assert.equal(config.get("deliveryErrorNotificationCooldownMinutes"), 5);
  assert.equal(config.get("remoteExecutionPolicy"), "disabled");
  assert.deepEqual(config.get("remoteAllowedUserOpenIds"), []);
  assert.equal(config.get("remoteRequireGroupMention"), true);
  assert.equal(config.has("appSecret"), false);
  assert.equal(config.has("webhookUrl"), false);

  console.log("Extension Host integration assertions passed: activation, commands, and safe defaults");
}
