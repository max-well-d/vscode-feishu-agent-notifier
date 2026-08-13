# 后续开发计划

开发目标是完善 Agent Link 这一独立本地中间件，不按人为版本切割功能，也不再以飞书或 VS Code 扩展作为架构中心。

## 必须保持的边界

- 原版 Codex 与 Claude Code 负责对话 UI、历史、diff、模型和审批展示。
- Agent Link 负责 Agent 接入、权威会话状态、单写入者协调、路由、权限和 Channel 生命周期。
- Channel 只负责传输；不得直接读取 Agent 私有文件或自行恢复 session。
- 核心只监听回环地址；不默认提供公网端口、端口转发或云中继。
- Renderer 保持沙箱隔离；密钥不得进入普通配置、日志或 Channel manifest。
- 不通过注入官方扩展进程、改写私有前端状态或模拟键盘来实现“无缝”。

## 当前继续完善

- 让 VS Code 薄适配层只连接桌面 Broker，移除扩展内重复的飞书长连接和会话执行生命周期。
- 给 Broker 增加显式协议协商和升级迁移，拒绝不兼容的旧守护进程静默复用。
- 完善 Codex `--remote` 客户端接入与 Claude Channel 启动器，使新启动的官方客户端从一开始就共享 Broker。
- 增加 Channel 安装、签名、权限声明、升级、禁用和卸载界面。
- 增加投递记录、敏感内容规则、安静时段、失败重试和可脱敏诊断导出。
- 增加 WSL、Remote SSH、Dev Container 和多设备来源标识，避免跨环境误路由。
- 为外部历史会话、当前活动 writer、远程安全分支与重启恢复提供更清晰的 UI 状态。
- 增加真实 Codex App Server、Claude Code Channel、飞书 WebSocket 和 Windows 安装器的端到端测试。

## 不做

- 不自制 Codex/Claude Code 的完整替代聊天界面。
- 不承诺把两个已经独立启动并持有 writer 的进程无损合并成一个可并发写 session。
- 不依赖官方扩展私有 DOM、私有数据库或未公开 IPC。
- 不自动继承高权限；`inherit` 必须由用户明确启用。
