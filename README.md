# Feishu Agent Notifier

一个轻量 VS Code 扩展：Codex 或 Claude Code 的主 Agent 结束一次回复后，把最后一条 assistant 消息的**完整内容**发送到指定飞书目标。

## 特性

- 支持 Codex `Stop` Hook。
- 支持 Claude Code `Stop` 和 `StopFailure` Hooks。
- 使用 stdin 接收 Hook JSON，避免 Windows 命令行参数长度限制。
- 最终回复不截断；超过单条上限时按 Unicode 字符自动分片。
- 支持两种飞书模式：
  - 群自定义机器人 Webhook：目标是 Webhook 所属群聊。
  - 飞书自建应用机器人：通过 `open_id`、`user_id`、`email` 或 `chat_id` 指定目标。
- Hook 只连接 `127.0.0.1` 上的 VS Code 扩展，不向局域网开放端口。
- 可使用 VS Code SecretStorage 保存 Webhook、签名密钥和 App Secret。
- 安装 Hook 时保留已有配置，并创建一次性 `.feishu-agent-notifier.bak` 备份。

## 本地开发与安装

```powershell
cd vscode-feishu-agent-notifier
npm install
npm test
npm run package
code --install-extension .\feishu-agent-notifier-0.1.0.vsix
```

开发时也可以在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host。

## 配置

安装扩展后运行：

1. `飞书 Agent 通知：打开设置`
2. 选择 `webhook` 或 `app` 投递模式。
3. 运行 `飞书 Agent 通知：安全保存飞书凭据`。
4. 应用机器人模式还需在设置中填写 `Receive Id Type` 和 `Receive Id`。
5. 运行 `飞书 Agent 通知：发送测试消息`。
6. 运行 `飞书 Agent 通知：安装/更新 Codex 与 Claude Code Hooks`。

也可以直接在 VS Code 设置界面填写所有字段。需要注意，普通设置保存在 `settings.json`，敏感字段推荐通过安全保存命令写入 SecretStorage；安全存储值优先于普通设置。

### Webhook 模式

在目标飞书群中添加“自定义机器人”，将 Webhook URL 和可选的签名密钥保存到扩展。机器人只能向该 Webhook 所属群发送消息。

### 应用机器人模式

需要飞书自建应用开启机器人能力并申请消息发送权限。配置：

- App ID / App Secret
- Receive ID Type：`open_id`、`user_id`、`email` 或 `chat_id`
- Receive ID：对应用户或群聊 ID

机器人需要对目标用户可用，或者已加入目标群并拥有发言权限。

## Hook 工作方式

扩展启动后监听：

```text
127.0.0.1:<feishuAgentNotifier.port>/event
```

“安装 Hooks”命令会把扩展自带的转发脚本复制到稳定的 VS Code `globalStorage` 路径，并合并以下文件：

- `~/.codex/hooks.json`
- `~/.claude/settings.json`

Codex 的非托管 Hook 首次运行前需要审核。在 Codex CLI 中执行 `/hooks`，确认脚本路径后信任该 Hook。

扩展或 VS Code 没有运行时，本地接收器不可用，Hook 会安全退出，Codex/Claude Code 本身不会被阻塞。

## 完整内容与分片

扩展读取：

- Codex：`last_assistant_message`
- Claude Code：`last_assistant_message`

默认每 12,000 个 Unicode 字符分成一条飞书消息，并添加 `【1/N】` 标识。扩展不会主动摘要或删除最终回复内容。飞书服务端仍可能基于平台内容安全、权限或总请求限制拒绝消息。

## 安全说明

- 最终回复可能包含源码、内部地址、日志、令牌或其他敏感数据。
- 启用扩展等同于授权它把 Agent 最终回复发送到飞书。
- 建议使用专用私密群或权限最小化的自建应用。
- 不要把 Webhook、App Secret 或生成的 Hook Token 提交到代码仓库。
- 本扩展不会修改项目级 Hook；只在用户明确执行命令后修改用户级配置。
