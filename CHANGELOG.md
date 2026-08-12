# Changelog

## 0.1.0

- Receive Codex and Claude Code `Stop`/`StopFailure` hook events.
- Send the complete final assistant response to a Feishu custom webhook or app bot.
- Split long responses across multiple Feishu messages without truncation.
- Install and remove user-level hooks while preserving unrelated hook entries.
- Store Feishu credentials securely with VS Code SecretStorage.
