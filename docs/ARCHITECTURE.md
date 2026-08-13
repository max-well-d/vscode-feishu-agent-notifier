# Agent Link 架构

## 组件

### Desktop Control Plane

Electron 主进程持有托盘、窗口、配置、安全存储、Hook Receiver 和 Channel Registry。Renderer 是沙箱化的本地静态页面，只能调用 preload 暴露的窄 IPC。

### Session Broker

Broker 是唯一允许持有托管 Codex App Server writer 的进程。桌面端、VS Code 薄适配层和以后加入的 CLI 客户端都应连接它，不应各自启动第二个 writer。

Broker 只监听随机回环端口，描述文件和 256-bit token 放在用户选择的数据目录。窗口关闭不会终止 Broker；显式退出桌面程序只断开客户端，正在运行的托管 turn 可继续。

### Agent Adapters

- Codex：公开 App Server JSON-RPC、Hook 与 transcript 兼容发现。
- Claude Code：公开 Hook、CLI resume/fork 与 Channel 协议。

文件发现只提供候选 session，不能充当权威完成事件。外部 session 只有收到权威完成通知后才允许远程续写；桥接安装前的外部活动 writer 冲突时使用精确 turn 的持久化安全分支。已桥接的共享 session 始终复用同一 App Server 中的已加载线程，投递失败时不会退回第二 writer 或分支。

### Channel Registry

每个 Channel 实现同一接口：manifest、配置校验、start/stop、send、可选 reply。核心将入站消息规范化为 `ChannelInboundMessage`，并用 `channelId:conversationId` 作为路由作用域。

飞书实现与任何第三方 Channel 使用相同接口。内置不代表特殊：关闭后不会连接飞书，也不会影响其他 Channel。

## 数据

- `remote-sessions.json`：受容量限制的会话、消息引用和聊天选择索引。
- `broker*.json`：Broker 描述、handoff 和完成队列。
- `channels.json`：不含密钥的 Channel 普通配置。
- `channel-secrets.json`：仅保存 safeStorage 密文。
- `desktop-settings.json`：执行策略、默认工作目录和 Receiver 端口。
- `%APPDATA%/Agent Link/location.json`：仅保存用户自定义数据目录指针。

不使用 Windows 注册表保存业务配置或会话正文。

## 安全模型

- 默认 `planOnly`，`inherit` 需要用户显式选择。
- Hook Receiver 与 Broker 仅绑定 `127.0.0.1`，并使用独立随机 token。
- Channel 入站先经过平台白名单，再经过 Agent Link 会话与权限策略。
- 外部插件是本机受信代码，拥有主进程权限；安装界面必须在后续加入签名与权限提示。在此之前只应加载用户手动放入数据目录的插件。
