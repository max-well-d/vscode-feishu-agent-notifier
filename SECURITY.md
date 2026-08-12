# Security policy

## Data handled by the extension

Feishu Agent Notifier can transmit the complete final response produced by Codex or Claude Code. That response may contain source code, file paths, internal URLs, logs, tokens, or other sensitive information.

In realtime mode, the extension incrementally reads local Codex and Claude Code transcript files and sends each newly persisted main-agent assistant text message. It excludes known thinking, tool, user, and Claude sidechain records, but assistant text itself may still contain sensitive information.

- Feishu credentials are stored in VS Code `SecretStorage`. Version 0.6.0 migrates legacy plaintext credential settings into `SecretStorage` and removes those settings from the public configuration UI.
- The local receiver binds only to `127.0.0.1` and requires a random per-installation token.
- When offline queuing is enabled, complete Agent events are temporarily stored in the extension's private `globalStorage` directory. Disable `feishuAgentNotifier.queueWhenOffline` if replies must never be written to disk.
- Diagnostic reports omit credentials, receiver tokens, and Agent response content.

Use a dedicated private Feishu group or a least-privilege application bot. Do not commit VS Code user settings, hook state, local queue files, Webhooks, or app secrets.

## Reporting a vulnerability

Please report security-sensitive issues privately through [GitHub Security Advisories](https://github.com/max-well-d/vscode-feishu-agent-notifier/security/advisories/new). Do not include live credentials or private Agent output in a public issue.
