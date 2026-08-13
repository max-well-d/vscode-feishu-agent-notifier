# Channel API v1

Channel 是消息传输适配器，不是 Agent 执行器。它不得自行打开 Codex/Claude session。

## 目录

```text
<data>/channels/example/
  channel.json
  index.cjs
```

`channel.json`：

```json
{
  "apiVersion": 1,
  "id": "example",
  "entry": "index.cjs"
}
```

入口导出：

```js
exports.createChannelAdapter = function () {
  return {
    manifest: {
      apiVersion: 1,
      id: "example",
      name: "Example",
      version: "1.0.0",
      description: "Example transport",
      capabilities: ["outbound", "inbound", "reply"],
      configSchema: { type: "object", properties: {} }
    },
    validate(config) {},
    async start(config, context) {},
    async stop() {},
    async send(event, target, config) { return { count: 0, receipts: [] }; },
    async reply(message, text, config) { return { channelId: "example", messageId: "..." }; }
  };
};
```

## 约束

- `id` 只能使用小写字母、数字和连字符，且必须与 manifest 一致。
- `entry` 必须位于插件目录内；路径穿越会被拒绝。
- `secret: true` 的 schema 字段由 Core 加密保存，Renderer 不会读回明文。
- `start` 只能在 Channel 被启用时建立连接，`stop` 必须释放 socket、timer 和子进程。
- 入站消息必须提供稳定 `messageId`、`conversationId`、`senderId` 和接收时间。
- 收到的 AgentEvent 只包含用户可见 Agent 文本；Channel 不应请求 thinking 或工具内部输出。
