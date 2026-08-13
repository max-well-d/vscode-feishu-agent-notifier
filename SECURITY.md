# Security policy

## Data handled by the extension

Feishu Agent Notifier can transmit the complete final response produced by Codex or Claude Code. That response may contain source code, file paths, internal URLs, logs, tokens, or other sensitive information.

In realtime mode, the extension reads local Codex transcripts and receives Claude Code assistant text through the official `MessageDisplay` Hook. Claude transcript watching remains active only until the first valid display event, or as a compatibility fallback when that Hook is unavailable. Known thinking, tool, user, and Claude sidechain records are excluded, but assistant text itself may still contain sensitive information.

- Feishu credentials are stored in VS Code `SecretStorage`. Upgrades automatically migrate legacy plaintext credential settings into `SecretStorage` and remove those settings from the public configuration UI.
- The local receiver binds only to `127.0.0.1` and requires a random per-installation token. Hook configuration contains only the path to a token file under the extension's private storage; the token is not embedded in command arguments, and POSIX systems use file mode `0600`.
- The extension does not read or write the Windows Registry. `SessionRegistry` is only the internal name of a bounded JSON routing index.
- Session routing metadata, pause state, and the offline queue use `feishuAgentNotifier.dataDirectory` when configured. VS Code private storage retains only the Hook runtime, receiver token, and a small data-directory locator; credentials remain in `SecretStorage`.
- The optional process bridge and its settings backup are stored under `<dataDirectory>/process-bridge`. Installation is explicit; extension upgrades never enable it automatically. Uninstall restores a setting only while it still points to the recorded notifier launcher.
- When offline queuing is enabled, complete Agent events are temporarily stored under `<dataDirectory>/pending-events`. Disable `feishuAgentNotifier.queueWhenOffline` if replies must never be written to disk.
- Diagnostic reports omit credentials, receiver tokens, and Agent response content.

## Remote reply threat model

Feishu remote replies are disabled by default. Enabling them creates an authenticated remote input path to local Codex or Claude Code sessions:

- Only application-bot mode is supported. The inbound WebSocket is authenticated with App ID / App Secret stored in VS Code `SecretStorage`.
- `remoteAllowedUserOpenIds` is deny-by-default. Group messages also require an allowed `chat_id` and, by default, an explicit bot mention.
- Quoted replies are resolved through a private, bounded `message_id` to session index. Duplicate inbound message IDs are processed once.
- Remote text is written through Codex App Server JSON-RPC or Agent process stdin and is never embedded in shell command strings or process arguments.
- Bridged Codex clients share one official App Server that binds a random `127.0.0.1` WebSocket endpoint. It is not exposed to the LAN or Feishu. Like most local developer tools, loopback access assumes other processes running as the same OS user are trusted.
- External IDE/CLI sessions require an authoritative completion event before the extension can resume them; transcript modification time is not treated as completion evidence. The shared server first adopts the original Session ID and falls back to `thread/fork` only on a writer conflict.
- The extension never enables `dangerously-bypass-*`. `planOnly` selects the Codex read-only sandbox and Claude Code plan permission mode. `inherit` is explicitly opt-in and can modify files or execute commands according to the user's existing Agent configuration.
- For an external Codex session with authoritative completion evidence, the extension may add the public `--skip-git-repo-check` flag when the exact persisted working directory has no `.git` ancestor. This only bypasses repository presence validation; it does not change the sandbox or approval policy and is never used for discovered, managed, or new sessions.
- If an exact completed Codex turn cannot be resumed because another App Server owns the writer lock, the extension may create a persistent managed `thread/fork` at that exact turn. It never kills the existing owner, never forks a route without a persisted `turnId`, and preserves the selected `planOnly` or `inherit` policy.
- External Claude Code sessions are continued with the public `--resume` plus `--fork-session` path. This preserves the IDE-owned source session, gives the remote branch a distinct persisted session ID, and prevents a remote reply from waiting indefinitely on an open local Claude process.
- Session-index schema v3 persists the source-session/source-turn to managed-branch mapping and the user-facing session name. Quoting the original completion card after a reload resolves to the same managed branch instead of creating another fork.
- Jobs are serialized per session, globally limited, capped at 20 queued requests, cancellable, and terminated after the configured timeout.
- Managed Codex and Claude Channel approval requests may be relayed to the allowlisted Feishu chat. `/approve <ID>` and `/deny <ID>` are scoped to pending Broker requests; the first valid local or Feishu answer wins. The bridge never turns a chat message such as “授权” into an implicit tool approval.
- Session routing metadata is stored in `remote-sessions.json` under the selected data directory with private POSIX permissions. It contains local paths, session IDs, bounded message routes, and branch mappings, but not Feishu credentials, conversation transcripts, or full remote prompt bodies.

Use a dedicated application and minimum Feishu permissions. Prefer single-user chat or the group @bot event permission; do not grant full group-message read access. Use one inbound-enabled computer per App ID because Feishu distributes a long-connection event to one client rather than broadcasting it.

Use a dedicated private Feishu group or a least-privilege application bot. Do not commit VS Code user settings, hook state, local queue files, Webhooks, or app secrets.

## Reporting a vulnerability

Please report security-sensitive issues privately through [GitHub Security Advisories](https://github.com/max-well-d/vscode-feishu-agent-notifier/security/advisories/new). Do not include live credentials or private Agent output in a public issue.
