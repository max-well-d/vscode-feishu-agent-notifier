# Feishu Agent Notifier

一个轻量开源 VS Code 开发扩展：实时把 Codex 或 Claude Code 主 Agent 的每条 assistant 文本消息发送到指定飞书目标，也可切换为只在任务结束时发送最后一条完整回复。

## 特性

- 默认实时逐条转发：Codex 的每条 `commentary` / `final_answer`，以及 Claude Code 官方 `MessageDisplay` Hook 提供的每条 assistant 文本消息。
- 实时模式只发送主 Agent 的 assistant 可见文本，不发送 thinking、工具参数、工具输出、用户输入或 Claude Code sidechain/subagent 内部消息。
- 可通过 `deliveryTiming=completion` 切回仅结束通知；实时通道与 Stop/notify 的相同最终正文会自动去重。
- 支持 Codex CLI 官方 `notify` 回调，无需在 CLI 中执行 `/hooks` 信任。
- 支持 Codex VS Code IDE：监听新增的本地 transcript `task_complete` 事件，弥补当前 app-server 不调用 `notify` 的差异。
- 支持 Claude Code `MessageDisplay`、`Stop` 和 `StopFailure` Hooks；transcript 只在等待首个 `MessageDisplay` 或未安装该 Hook 时作为兼容监听。
- Codex CLI 与 Claude Code CLI 均支持；通知内容是最终 assistant 回复，不包含终端中全部工具 stdout/stderr。
- 支持 VS Code 本地完成/失败提醒，可选择始终显示、仅窗口失焦时显示或关闭。
- 在右下角实时显示通知状态，包括实时、发送中、待处理、暂停、需配置、需修复和异常；悬停可查看完整健康信息。
- 点击状态栏可直接测试、暂停当前工作区、重试队列、修复 Hook、运行自检、打开设置或日志。
- 本地提醒包含可配置的回复预览，并可一键打开完整 Markdown 回复。
- Codex 从命令行参数接收 `agent-turn-complete` JSON；Claude Code 从 stdin 接收 Hook JSON。
- 最终回复不截断；超过单条上限时按 Unicode 字符自动分片。
- 默认使用飞书 JSON 2.0 消息卡片渲染 Markdown；Markdown 表格会转换为卡片原生表格。
- 可通过 `messageFormat=text` 切换回纯文本兼容模式。
- 支持两种飞书模式：
  - 群自定义机器人 Webhook：目标是 Webhook 所属群聊。
  - 飞书自建应用机器人：通过 `open_id`、`user_id`、`email` 或 `chat_id` 指定目标。
- 转发脚本只连接 `127.0.0.1` 上的 VS Code 扩展，不向局域网开放端口。
- 可使用 VS Code SecretStorage 保存 Webhook、签名密钥和 App Secret。
- 安装时保留已有配置，并创建一次性 `.feishu-agent-notifier.bak` 备份；已有 Codex `notify` 会在卸载时恢复。
- VS Code 未运行时把事件暂存到扩展私有目录，下次启动自动补投，最多保留 100 条。
- 飞书限流、网络错误和服务端错误会按指数退避自动重试。
- 提供首次使用 Walkthrough、完整自检、Hook 修复、待处理队列重试和脱敏诊断报告。

## 本地开发与安装

```powershell
cd vscode-feishu-agent-notifier
npm install
npm test
npm run test:integration
npm run package
code --install-extension .\feishu-agent-notifier-0.9.1.vsix
```

开发时也可以在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host。

## 配置

安装扩展后，打开 VS Code 的“欢迎使用”页面并选择“配置 Feishu Agent Notifier”，或依次运行：

1. `飞书 Agent 通知：打开设置`
2. 选择 `webhook` 或 `app` 投递模式。
3. 运行 `飞书 Agent 通知：安全保存飞书凭据`。
4. 应用机器人模式还需在设置中填写 `Receive Id Type` 和 `Receive Id`。
5. 运行 `飞书 Agent 通知：发送测试消息`。
6. 运行 `飞书 Agent 通知：安装/更新 Codex 与 Claude Code 通知接入`。
7. 运行 `飞书 Agent 通知：运行自检与修复`。

本地提醒默认开启。可运行 `飞书 Agent 通知：发送本地测试提醒` 单独测试；通过 `localNotificationMode` 选择 `always`、`whenUnfocused` 或 `off`。实时过程消息默认只发飞书，不逐条弹出 VS Code 提醒；如需要可开启 `localNotificationRealtime`。

### 状态中心

扩展在 VS Code 右下角显示当前通知状态。飞书 Webhook/API 是按次请求，因此“实时”表示本地接收器、配置和 Agent 接入已经就绪，不代表维持了永久网络连接。

将鼠标悬停在状态栏上，可查看投递模式、本地端口、Codex notify、Claude Code 消息来源、待处理数量以及最近一次成功或错误。点击状态栏会打开轻量操作菜单。

“暂停当前工作区通知”只过滤工作目录属于当前工作区的 Agent 事件，不会关闭全局接收器，也不会影响其他项目。暂停期间匹配的实时事件会跳过；已经进入离线队列的消息会保留到恢复后再投递。

非敏感选项可直接在 VS Code 设置界面填写。Webhook、签名密钥、App ID 和 App Secret 只通过“安全保存飞书凭据”命令写入 SecretStorage；从旧版本升级时，遗留的明文凭据会自动迁移并清除。

### Webhook 模式

在目标飞书群中添加“自定义机器人”，将 Webhook URL 和可选的签名密钥保存到扩展。机器人只能向该 Webhook 所属群发送消息。

### 应用机器人模式

需要飞书自建应用开启机器人能力并申请消息发送权限。配置：

- App ID / App Secret
- Receive ID Type：`open_id`、`user_id`、`email` 或 `chat_id`
- Receive ID：对应用户或群聊 ID

机器人需要对目标用户可用，或者已加入目标群并拥有发言权限。

## 通知接入方式

扩展启动后监听：

```text
127.0.0.1:<feishuAgentNotifier.port>/event
```

“安装/更新通知接入”命令会把扩展自带的转发脚本复制到稳定的 VS Code `globalStorage` 路径，并合并以下文件：

- `~/.codex/config.toml`：写入 Codex `notify` 命令
- `~/.claude/settings.json`

安装器会删除本扩展旧版本写入 `~/.codex/hooks.json` 的 Codex `Stop` Hook，避免重复发送。Codex CLI 的 `notify` 不经过非托管 Hook 信任流程，因此无需 `/hooks`。Codex IDE 当前使用 app-server，不会稳定调用该 `notify`；扩展因此只监听启动以后新增到 `~/.codex/sessions` 的 `task_complete`，不会补发历史回复。CLI 与 IDE 事件通过 session/turn ID 去重。

`deliveryTiming` 默认是 `realtime`。Claude Code 优先通过官方 `MessageDisplay` Hook 接收 assistant 文本分片，按 `message_id`、`index` 和 `final` 在内存中还原为一条完整消息；transcript 兼容监听会在收到首个有效 Hook 事件后关闭，旧版仍可继续使用 `~/.claude/projects`。Codex 仍增量监听 `~/.codex/sessions`，只处理扩展启动后新增的 assistant 文本，不补发历史记录。Codex 官方 Hooks 当前没有稳定的“每条 assistant 文本”事件，并明确说明 transcript 格式不是稳定接口，因此 `notify` 和完成事件会继续作为兜底。

`watchCodexIde` 控制 completion 模式下的 Codex IDE transcript 完成监听；实时模式必须启用 Codex transcript 监听，因此该模式下此开关不会关闭实时消息。

扩展或 VS Code 没有运行时，本地接收器不可用。默认情况下，转发脚本会把完整事件写入扩展的私有 `globalStorage/pending-events` 目录，VS Code 下次启动后自动补投并显示本地提醒；Codex/Claude Code 本身不会被阻塞。可关闭 `queueWhenOffline`，关闭后离线事件会被丢弃且不会把回复正文暂存到磁盘。

离线队列解决的是“不丢最终消息”，不是 VS Code 关闭后的实时逐条发送。Claude `MessageDisplay` 分片不会离线落盘，避免保存无法独立还原的碎片；`Stop` 仍会保存完整最终消息。若必须在 VS Code 完全退出时仍逐条推送，需要单独运行受保护的后台服务；本扩展当前不安装常驻系统服务。

## 完整内容与分片

扩展读取：

- Codex：`last_assistant_message`
- Claude Code：实时模式聚合 `MessageDisplay.delta`；完成兜底读取 `last_assistant_message`

默认每 3,000 个 Unicode 字符分成一条飞书消息，并添加 `【1/N】` 标识。扩展不会主动摘要或删除最终回复内容。飞书服务端仍可能基于平台内容安全、权限或总请求限制拒绝消息。

## 安全说明

- 最终回复可能包含源码、内部地址、日志、令牌或其他敏感数据。
- 启用扩展等同于授权它把 Agent 最终回复发送到飞书。
- 建议使用专用私密群或权限最小化的自建应用。
- 不要把 Webhook、App Secret 或生成的本地接收 Token 提交到代码仓库。
- 离线队列可能暂存完整回复；对落盘敏感的环境请关闭 `queueWhenOffline`。
- 本扩展不会修改项目级配置；只在用户明确执行命令后修改用户级配置。

完整威胁模型与漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 自检与故障排除

运行 `飞书 Agent 通知：运行自检与修复`，报告会检查：

- 本地接收器和端口
- 飞书投递配置
- Codex CLI `notify`
- Claude Code `MessageDisplay` / `Stop` / `StopFailure`
- 离线队列和最近一次投递结果

报告不会包含飞书凭据、本地接收 Token 或 Agent 回复正文。若状态栏显示警告，先运行自检，再使用“安装/修复 Hooks”或“重试待处理通知”。

如需删除磁盘上尚未投递的完整回复，运行 `飞书 Agent 通知：清除待处理通知`；该操作会在确认后永久删除队列文件。

## 产品成熟度

当前能力、正式发布门槛以及作为成熟开源开发工具仍缺少的部分，持续记录在 [产品就绪审计](docs/PRODUCT_AUDIT.md)。主要后续方向是后台实时服务、远程环境支持、内容策略与可查询投递历史。
