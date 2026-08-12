# Security policy

## Data handled by the extension

Feishu Agent Notifier can transmit the complete final response produced by Codex or Claude Code. That response may contain source code, file paths, internal URLs, logs, tokens, or other sensitive information.

In realtime mode, the extension reads local Codex transcripts and receives Claude Code assistant text through the official `MessageDisplay` Hook. Claude transcript watching remains active only until the first valid display event, or as a compatibility fallback when that Hook is unavailable. Known thinking, tool, user, and Claude sidechain records are excluded, but assistant text itself may still contain sensitive information.

- Feishu credentials are stored in VS Code `SecretStorage`. Upgrades automatically migrate legacy plaintext credential settings into `SecretStorage` and remove those settings from the public configuration UI.
- The local receiver binds only to `127.0.0.1` and requires a random per-installation token. Hook configuration contains only the path to a token file under the extension's private storage; the token is not embedded in command arguments, and POSIX systems use file mode `0600`.
- When offline queuing is enabled, complete Agent events are temporarily stored in the extension's private `globalStorage` directory. Disable `feishuAgentNotifier.queueWhenOffline` if replies must never be written to disk.
- Diagnostic reports omit credentials, receiver tokens, and Agent response content.

## Remote reply threat model

Feishu remote replies are disabled by default. Enabling them creates an authenticated remote input path to local Codex or Claude Code sessions:

- Only application-bot mode is supported. The inbound WebSocket is authenticated with App ID / App Secret stored in VS Code `SecretStorage`.
- `remoteAllowedUserOpenIds` is deny-by-default. Group messages also require an allowed `chat_id` and, by default, an explicit bot mention.
- Quoted replies are resolved through a private, bounded `message_id` to session registry. Duplicate inbound message IDs are processed once.
- Remote text is written through Codex App Server JSON-RPC or Agent process stdin and is never embedded in shell command strings or process arguments.
- Codex sessions created with `/new codex` have one App Server owner. External IDE/CLI sessions require an authoritative completion event before the extension can resume them; transcript modification time is not treated as completion evidence.
- The extension never enables `dangerously-bypass-*`. `planOnly` selects the Codex read-only sandbox and Claude Code plan permission mode. `inherit` is explicitly opt-in and can modify files or execute commands according to the user's existing Agent configuration.
- Jobs are serialized per session, globally limited, capped at 20 queued requests, cancellable, and terminated after the configured timeout.
- Native approval prompts are not bridged to Feishu. A remote task that requires unavailable local approval must fail instead of silently escalating.
- Session routing metadata is stored under extension `globalStorage` with private POSIX permissions. It contains local paths and session IDs but not Feishu credentials or full remote prompt bodies.

Use a dedicated application and minimum Feishu permissions. Prefer single-user chat or the group @bot event permission; do not grant full group-message read access. Use one inbound-enabled computer per App ID because Feishu distributes a long-connection event to one client rather than broadcasting it.

Use a dedicated private Feishu group or a least-privilege application bot. Do not commit VS Code user settings, hook state, local queue files, Webhooks, or app secrets.

## Reporting a vulnerability

Please report security-sensitive issues privately through [GitHub Security Advisories](https://github.com/max-well-d/vscode-feishu-agent-notifier/security/advisories/new). Do not include live credentials or private Agent output in a public issue.
