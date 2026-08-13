# Feishu Agent Notifier

一个开源 VS Code 开发扩展：实时把 Codex 或 Claude Code 主 Agent 的每条 assistant 文本消息发送到指定飞书目标，也可通过飞书安全回复、恢复对应的本地 Agent 会话。

## 特性

- 默认实时逐条转发：Codex 的每条 `commentary` / `final_answer`，以及 Claude Code 官方 `MessageDisplay` Hook 提供的每条 assistant 文本消息。
- 实时模式只发送主 Agent 的 assistant 可见文本，不发送 thinking、工具参数、工具输出、用户输入或 Claude Code sidechain/subagent 内部消息。
- 可通过 `deliveryTiming=completion` 切回仅结束通知；实时通道与 Stop/notify 的相同最终正文会自动去重。
- 支持 Codex 官方 `Stop` Hook，直接读取 `last_assistant_message`；同时保留 `notify` 作为旧版本和未信任 Hook 时的回退。
- 支持 Codex VS Code IDE 和 CLI；实时过程通过 transcript 增量监听，Stop/notify 负责最终回复兜底并跨来源去重。
- 自动检测 Codex 与 Claude Code 版本和能力；Claude Code 支持时使用 `MessageDisplay`，旧版自动降级为 transcript 兼容监听。
- Codex CLI 与 Claude Code CLI 均支持；通知内容是最终 assistant 回复，不包含终端中全部工具 stdout/stderr。
- 支持 VS Code 本地完成/失败提醒，可选择始终显示、仅窗口失焦时显示或关闭。
- 在右下角实时显示通知状态，包括实时、发送中、待处理、暂停、需配置、需修复和异常；悬停可查看完整健康信息。
- 点击状态栏可直接测试、暂停当前工作区、重试队列、修复 Hook、运行自检、打开设置或日志。
- 多个 VS Code 窗口共享一个接收端口；非所有者窗口进入待命，所有者关闭后自动接管。
- 本地提醒包含可配置的回复预览，并可一键打开完整 Markdown 回复。
- Codex 从命令行参数接收 `agent-turn-complete` JSON；Claude Code 从 stdin 接收 Hook JSON。
- 最终回复不截断；超过单条上限时按 Unicode 字符自动分片。
- 默认使用飞书 JSON 2.0 消息卡片渲染 Markdown；Markdown 表格会转换为卡片原生表格。
- 可通过 `messageFormat=text` 切换回纯文本兼容模式。
- 支持两种飞书模式：
  - 群自定义机器人 Webhook：目标是 Webhook 所属群聊。
  - 飞书自建应用机器人：通过 `open_id`、`user_id`、`email` 或 `chat_id` 指定目标。
- 应用机器人模式支持飞书 WebSocket 长连接入站，不需要公网服务器或内网穿透。
- 引用一条插件通知即可精确恢复其 Codex/Claude Code 会话；也可列出、选择、命名历史本地会话或创建新会话。
- `/new codex` 使用官方 Codex App Server 协议创建持久化会话，支持权威运行状态、完成事件、取消和显式 `/steer`。
- Codex App Server 现在由独立 Session Broker 持有，不再属于 Extension Host；VS Code 窗口重载后会重连同一 Broker，并补取重载期间的真实完成结果。
- 状态中心只负责打开官方 Codex/Claude Code 界面，不再维护一套功能不完整的自制对话面板；本地历史、diff、审批和模型功能继续由官方客户端呈现。
- `/new cc` 会启动原版 Claude Code CLI，并通过官方 Channel 协议把飞书输入注入这个正在运行的本地会话；Hook 会把临时 Channel 路由迁移到真实 Claude session ID。
- Codex 与 Claude Code 权限请求可同步到本地和飞书；飞书使用 `/approve <ID>` 或 `/deny <ID>` 回答，先到的有效回答生效。
- 外部 VS Code/CLI 会话只有在收到权威完成事件后才能续写；不再根据 transcript 文件静默时间猜测任务结束。
- 可选进程桥接让官方 Codex VS Code、独立 Codex TUI、Claude Code VS Code、独立 Claude Code CLI 与飞书使用相同后端；VS Code 不再是会话所有者，只是客户端之一。
- 历史 Codex session 会先按原 Session ID 无损接入共享 App Server；旧私有 App Server 仍持有 writer 时才从被引用的精确 turn 创建安全分支。
- 卡片副标题显示真实 session 名称、短 session ID、项目和时间；`/alias` 设置的本地别名优先显示。
- 远程回复按会话串行执行，支持超时、取消、重复事件去重和最多 20 条排队保护。
- 远程执行默认关闭；可选择只读规划，或显式继承本机 Agent 权限。用户、群聊和群聊 @ 均有独立白名单策略。
- 应用机器人模式可按项目名或绝对路径把通知路由到不同群聊。
- 转发脚本只连接 `127.0.0.1` 上的 VS Code 扩展，不向局域网开放端口。
- 可使用 VS Code SecretStorage 保存 Webhook、签名密钥和 App Secret。
- 安装时保留已有配置，并创建一次性 `.feishu-agent-notifier.bak` 备份；已有 Codex `notify` 会在卸载时恢复，其他 Hook 不会被删除。
- 本地接收 Token 存放在扩展私有目录中，不写入 Hook 命令参数；POSIX 系统使用 `0600` 文件权限。
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
code --install-extension .\feishu-agent-notifier-0.17.0.vsix
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

需要让官方 VS Code Agent 与独立 CLI 也成为同一飞书会话的本地客户端时，再显式运行 `飞书 Agent 通知：安装 Codex/Claude Code 进程桥接`。该操作不会在扩展升级时自动执行。

本地提醒默认开启。可运行 `飞书 Agent 通知：发送本地测试提醒` 单独测试；通过 `localNotificationMode` 选择 `always`、`whenUnfocused` 或 `off`。实时过程消息默认只发飞书，不逐条弹出 VS Code 提醒；如需要可开启 `localNotificationRealtime`。

### 状态中心

扩展在 VS Code 右下角显示当前通知状态。Webhook 模式按次请求；启用远程回复后，应用机器人模式会额外保持飞书 WebSocket 长连接，状态显示为“双向”。

将鼠标悬停在状态栏上，可查看投递模式、本地端口和窗口所有权、Codex/Claude Code 版本、官方通道与兼容通道、待处理数量以及最近一次成功或错误。点击状态栏会打开轻量操作菜单。

“暂停当前工作区通知”只过滤工作目录属于当前工作区的 Agent 事件，不会关闭全局接收器，也不会影响其他项目。暂停列表在同一 VS Code Profile 的窗口之间共享，因此接收器所有者也会执行其他窗口发出的暂停操作。暂停期间匹配的实时事件会跳过；已经进入离线队列的消息会保留到恢复后再投递。

非敏感选项可直接在 VS Code 设置界面填写。Webhook、签名密钥、App ID 和 App Secret 只通过“安全保存飞书凭据”命令写入 SecretStorage；从旧版本升级时，遗留的明文凭据会自动迁移并清除。

### 本地数据目录

扩展不访问 Windows 注册表。代码中的 `SessionRegistry` 只是受容量和有效期限制的 JSON 会话路由索引。

在设置页填写 `feishuAgentNotifier.dataDirectory`，或从右下角状态菜单选择“选择本地数据目录”，可以把以下普通文件迁移到自定义位置：

- `remote-sessions.json`：会话 ID、名称、工作目录、消息路由和远程分支映射；不保存对话 transcript 或完整远程指令正文。
- `paused-workspaces.json`：暂停通知的工作区列表。
- `broker-state.json` / `broker-completions.json`：交接状态和最多 100 条尚未由 Extension Host 确认的托管完成事件。
- `codex-shared.json` / `process-bridge/`：共享 Codex 服务描述、启动器、原 Agent 路径和可恢复的设置备份；不包含飞书凭据。
- `pending-events/`：仅在离线队列启用时暂存完整待投递事件；不希望回复正文落盘时可关闭 `queueWhenOffline`。

路径必须是绝对路径或以 `~/` 开头。修改后窗口会重载；跨磁盘迁移也受支持，并且不会覆盖目标目录已有的同名数据。Hook 运行脚本、随机接收令牌和一个最小的数据目录定位文件仍位于 VS Code 私有目录，飞书凭据继续只存入 `SecretStorage`。

### 跨 VS Code/CLI 进程桥接

运行“安装 Codex/Claude Code 进程桥接”后，扩展会在当前 `dataDirectory/process-bridge` 生成两个本地启动器，并备份以下用户设置：

- OpenAI Codex：`chatgpt.cliExecutable`
- Claude Code：`claudeCode.claudeProcessWrapper`

设置备份是普通 JSON 文件，只保存在自定义数据目录，不使用 Windows 注册表。运行“恢复进程桥接前的 Agent 设置”只会在设置仍指向本插件启动器时恢复旧值，不会覆盖用户后来手动填写的新路径。安装和卸载都不会强制终止正在运行的 Agent。

Codex 启动器把官方 VS Code App Server 的 stdio 数据代理到一个独立的官方 App Server WebSocket；该服务只监听随机的 `127.0.0.1` 端口。独立 Codex TUI 通过官方 `--remote` 参数连接同一服务。Claude Code 启动器保留原版二进制和全部参数，仅为会话进程注入本插件的官方 Channel 配置与随机 Channel ID。

Windows 上的 Claude 启动器分为两个：写入 `claudeCode.claudeProcessWrapper` 的 `claude-feishu-wrapper-<hash>.exe` 使用 GUI 子系统，不会在打开官方 Claude 面板时额外弹出 `claude.exe` 控制台窗口；日志中给出的 `claude-feishu-<hash>.exe` 保留控制台子系统，供普通终端交互使用。

Windows 原生启动器带有内容哈希文件名。升级时会生成新文件并切换设置，不会覆盖正在被 Agent 进程锁定的旧 EXE；旧进程可自然完成，未再使用的旧启动器会在后续激活时清理。

桥接采用 fail-open：共享 App Server 未能启动、配置损坏或 Claude Channel 注入准备失败时，会输出一条本地警告并立即以原参数启动原版 Codex/Claude Code。安装器也会拒绝把“真实 Agent 路径”配置为桥接启动器本身，避免递归启动。桥接失败最多使该次飞书注入不可用，不应阻止官方 Agent 启动。

命令执行后，输出日志会给出可直接在普通终端运行的 `codex-feishu` / `claude-feishu` 启动器绝对路径。因此桥接不依赖 VS Code 终端；VS Code 关闭后本地 Agent 仍可运行，但飞书长连接目前仍需要至少一个扩展窗口在线。

兼容边界：Codex 的共享 App Server、`--remote` 与 App Server JSON-RPC 是公开接口；OpenAI VS Code 的 `chatgpt.cliExecutable` 当前标注为开发设置，未来扩展升级可能改变启动参数，完整自检会报告桥接状态。Claude Code 使用公开的 `claudeProcessWrapper` 和 Channel 参数。已经在桥接安装前启动的进程不能热注入：空闲的历史 Codex 可保持原 ID 接管；正在被旧 App Server 写入的 Codex 使用安全分支；历史 Claude Code 应在 turn 结束后通过 `claude-feishu --resume <完整 Session ID>` 重开，正在执行的 Claude turn 不会被冒险迁移。

### Webhook 模式

在目标飞书群中添加“自定义机器人”，将 Webhook URL 和可选的签名密钥保存到扩展。机器人只能向该 Webhook 所属群发送消息。

### 应用机器人模式

需要飞书自建应用开启机器人能力并申请消息发送权限。配置：

- App ID / App Secret
- Receive ID Type：`open_id`、`user_id`、`email` 或 `chat_id`
- Receive ID：对应用户或群聊 ID

机器人需要对目标用户可用，或者已加入目标群并拥有发言权限。

### 飞书远程回复

远程回复只支持自建应用机器人，且默认关闭。配置步骤：

1. 在飞书开放平台为自建应用开启机器人能力。
2. 开通“以应用身份发送消息”，以及所需的单聊消息或群聊 @机器人消息读取权限。不要为了方便申请读取群内全部消息。
3. 在“事件与回调”中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`，然后发布应用版本。
4. 在扩展中运行“安全保存飞书凭据”，保存 App ID / App Secret。
5. 运行“飞书 Agent 通知：配置远程操控”，通过可视化向导选择通知目标、填写用户 `open_id` 和可选群 `chat_id` 白名单。
6. 在向导中先选择“只读规划”；确认风险后才考虑“继承本机权限”。
7. 运行完整自检；右下角显示“飞书 · 双向”后即可使用。

远程操控所需选项都可以通过命令面板或右下角状态菜单中的“配置飞书远程操控”完成，不需要手动编辑 `settings.json`。向导会自动切换到应用机器人模式；选择继承本机权限时必须再次确认风险。

单聊可直接引用机器人通知并回复。群聊必须位于白名单中，默认还必须引用通知并 @机器人。可用命令：

```text
/sessions                         列出最近的本地 Codex/Claude Code 会话
/use <序号|别名|session-id>       选择当前飞书聊天的默认会话
/send <目标> <内容>               直接向指定历史会话提交一轮
/new <codex|cc> <内容>            在当前 VS Code 工作区创建新会话
/steer <内容>                     追加到正在运行的托管 Codex turn
/alias <名称>                     为引用或已选择的会话设置别名
/status                           查看连接与队列状态
/cancel                           取消当前飞书聊天提交的任务
/approve <审批ID>                允许当前权限请求
/deny <审批ID>                   拒绝当前权限请求
/help                             显示帮助
```

普通文本按“引用消息 → 当前聊天已选择会话”的顺序解析目标，不使用“最近会话”猜测。Agent 通知以及机器人返回的“已接收/开始执行/执行完成”消息都会绑定到同一个准确会话。飞书消息 ID、会话 ID、工作目录、别名和选择状态保存在扩展私有目录，默认最多保留 500 个会话和 5,000 条消息映射；消息映射 30 天后过期。

会话分为两类：

- **共享托管**：`/new codex` 和已桥接的官方 Codex 客户端连接同一个 App Server；每轮使用 `turn/start`，完成以 `turn/completed` 为准。`/new cc` 和已桥接的 Claude Code 进程使用官方 Channel 将本机与飞书输入送入同一个真实 Session ID。两者都不会为每条飞书消息另开一个 resume 进程，本地操作继续使用官方界面或原版 CLI/TUI。
- **外部会话**：由桥接安装前的官方 VS Code 插件或普通 CLI 创建。插件只会在 Stop/task-complete 等权威事件确认结束后处理回复。外部 Codex 先尝试原 ID 接入共享 App Server，检测到旧 writer 冲突才创建精确 turn 分支；外部 Claude Code 仍使用官方 `--fork-session` 兼容路径。仅从磁盘发现、没有完成证据的会话会被拒绝。

要让之后启动的官方 VS Code/CLI 会话天然共享，安装进程桥接。插件状态菜单中的 Codex/Claude Code 入口只打开相应官方界面，不创建替代 UI。插件不会向已经运行的终端发送按键，也不会事后夺取已有进程的 stdio；迁移只发生在安全的 turn 边界。

Session Broker 仅监听 `127.0.0.1`，使用随机 bearer token，并把普通状态写入 `dataDirectory`。它独立于 Extension Host，因此窗口重载不会停止已托管的 Codex turn；重载期间完成的结果进入本地收件箱，新 Host 连接后才确认和投递。Broker 重启时，遗留的 `running` 只能恢复为“状态未知”，不会伪造仍在执行或已经完成。

外部 Codex 会话会先通过共享 App Server 的 `thread/resume` 接管同一个 Session ID；成功后本地和飞书继续同一历史。若旧版/未桥接 App Server 仍持有唯一 writer，远程分支会严格沿用通知中记录的原始工作目录，不会切换到某个子仓库，也不会改变 `planOnly` / `inherit` 权限策略。

扩展不会终止旧 IDE App Server，也不会强占外部 Codex writer。只有原 ID 接管失败时，才使用卡片保存的 `turnId` 调用 `thread/fork`，创建磁盘持久化、由插件独占的远程分支，并把“源 session + 源 turn → 分支 session”写入私有 JSON 会话索引。以后再次引用原卡片也会回到该分支。分支与原 session 共享工作目录，因此同时运行两个 Agent 仍可能产生文件级冲突；旧卡片没有精确 `turnId` 时会安全失败。

外部 Claude Code session 即使仍在 VS Code Claude 进程中打开，也不再等待原进程退出。扩展会对卡片中的完整 session ID 执行公开的 `--resume <session-id> --fork-session`，保留原 IDE session，并把 CLI 返回的新 session ID 持久化为飞书独占分支；后续继续引用原卡片时会进入同一个分支。每张带元数据的飞书卡片正文顶部都会明确显示完整的 `Claude Code Session ID` 或 `Codex Session ID`。

扩展不向已有终端发送按键，也不修改 Codex 或 Claude Code 程序文件。共享 Codex 使用公开 App Server；共享 Claude Code 使用官方 Channel（当前为 research preview，启动时会显式使用 development-channel 参数）。无持久化、已删除、其他电脑、Codex/Claude 云端及首版 WSL/SSH/Dev Container 会话无法恢复。VS Code 关闭时飞书长连接也会关闭；已经交给 Broker 的 Codex turn 可以继续并保存完成结果，但关闭期间不能接收新的飞书指令。同一个飞书 App ID 应只在一台电脑上启用入站连接。

扩展会自动查找 OpenAI 与 Claude Code 官方 VS Code 扩展内置的 CLI，因此不要求扩展宿主和终端拥有相同的 `PATH`。若使用独立安装或定制 CLI，可在可视化设置中填写 `Codex Executable Path` / `Claude Executable Path`；完整自检会显示最终解析到的路径。

`projectDestinations` 可为应用机器人配置项目路由，例如：

```json
{
  "LEADER": "oc_group_for_leader",
  "D:\\code\\another-project": "oc_group_for_another_project"
}
```

## 通知接入方式

扩展启动后监听：

```text
127.0.0.1:<feishuAgentNotifier.port>/event
```

“安装/更新通知接入”命令会把扩展自带的转发脚本复制到稳定的 VS Code `globalStorage` 路径，并合并以下文件：

- `~/.codex/hooks.json`：合并 Codex 官方 `Stop` Hook
- `~/.codex/config.toml`：保留 Codex `notify` 兼容回退
- `~/.claude/settings.json`

Codex 官方 `Stop` Hook 会直接提供最后一条 assistant 回复。非托管 Hook 首次安装或内容变化后需要在支持该功能的 Codex 中运行 `/hooks` 检查并信任；旧版没有 `/hooks` 时，`notify` 与 transcript 回退仍可工作。安装器只更新带本扩展标记的配置组，不删除其他 Hook；卸载时恢复此前的 `notify`。

`deliveryTiming` 默认是 `realtime`。Claude Code 在版本支持时通过 `MessageDisplay` 接收 assistant 文本分片，按 `message_id`、`index` 和 `final` 在内存中还原为完整消息；旧版直接使用 `~/.claude/projects` transcript。Codex 对启动时已有的全部 session 文件建立位置基线，因此恢复较早创建的会话也能继续读取新消息，但不会补发旧内容。Codex 当前没有稳定的“每条 assistant 文本”Hook，实时过程仍使用 transcript；官方 `Stop` 和 `notify` 负责最终回复兜底。

多个 VS Code 窗口使用相同端口时，只有一个窗口运行接收器和 transcript watcher。其他同一 Profile 窗口通过带 Token 的健康检查进入待命；所有者退出后，待命窗口会自动竞争接管。不同 Profile 使用不同 Token，如果配置到同一端口，状态中心会明确显示端口冲突。

`watchCodexIde` 控制 completion 模式下的 Codex IDE transcript 完成监听；实时模式必须启用 Codex transcript 监听，因此该模式下此开关不会关闭实时消息。

扩展或 VS Code 没有运行时，本地接收器不可用。默认情况下，转发脚本会把完整事件写入当前 `<dataDirectory>/pending-events`，VS Code 下次启动后自动补投并显示本地提醒；未配置自定义目录时才使用扩展私有 `globalStorage`。Codex/Claude Code 本身不会被阻塞。可关闭 `queueWhenOffline`，关闭后离线事件会被丢弃且不会把回复正文暂存到磁盘。

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
- 不要把 Webhook、App Secret 或扩展私有目录中的 `receiver-token` 提交到代码仓库。
- 离线队列可能暂存完整回复；对落盘敏感的环境请关闭 `queueWhenOffline`。
- 本扩展不会修改项目级配置；只在用户明确执行命令后修改用户级配置。
- 飞书远程回复相当于给白名单用户提供本机 Agent 输入能力。`planOnly` 使用 Codex 只读沙箱和 Claude Code plan 模式；`inherit` 可能修改文件、执行命令并消耗 Agent 配额。自动远程分支继承当前策略，不会提升权限。
- 远程回复正文通过 Codex App Server JSON-RPC 或 Agent 子进程 stdin 传递，不放入命令行参数；扩展不会自动添加任何 `dangerously-bypass-*` 参数。非 Git 目录兼容仅跳过仓库存在性检查，不会跳过沙箱或审批策略。
- 群聊建议只授予“@机器人消息”权限，并保持 `remoteRequireGroupMention=true`。

完整威胁模型与漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 自检与故障排除

运行 `飞书 Agent 通知：运行自检与修复`，报告会检查：

- 本地接收器和端口
- 飞书投递配置
- Codex 版本、官方 `Stop` Hook 与 `notify` 回退
- Claude Code `MessageDisplay` / `Stop` / `StopFailure`
- 离线队列和最近一次投递结果
- 飞书入站长连接、远程用户白名单、远程回复队列和 Codex App Server 托管器

报告不会包含飞书凭据、本地接收 Token 或 Agent 回复正文。若状态栏显示警告，先运行自检，再使用“安装/修复 Hooks”或“重试待处理通知”。

如需删除磁盘上尚未投递的完整回复，运行 `飞书 Agent 通知：清除待处理通知`；该操作会在确认后永久删除队列文件。

## 后续开发计划

项目的近期、中期和长期方向记录在 [后续开发计划](docs/DEVELOPMENT_PLAN.md)。当前重点包括 Claude/Codex 会话管理、内容控制、投递记录、远程开发环境支持，以及可选的后台实时组件。
