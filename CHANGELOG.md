# Changelog

## 0.20.0

- Replace whole-page snapshot rendering with a persistent desktop shell and targeted live-region updates. Background Broker, Channel and log refreshes no longer recreate forms, collapse expanded diagnostics, move focus or reset scroll positions.
- Redesign the Agent Link information architecture around a health banner, readable operating metrics, standard navigation, clear service states, accessible controls and sectioned settings.
- Add schema-driven conditional Channel configuration. Feishu Webhook and App modes now expose only their relevant credentials and options; App inbound allowlists appear only when bidirectional input is enabled.
- Turn the system tray into a live control surface with Broker/turn/queue/channel/session monitoring, direct navigation, remote permission switching, per-Channel enable/disable controls and connection refresh.
- Stream new log records into the existing diagnostics DOM without rebuilding its `<details>` element, preserving the user's explicit expanded/collapsed choice indefinitely.

## 0.19.0

- Deliver authoritative Claude Code `Stop` / `StopFailure` events even when the same body was already sent by `MessageDisplay` or transcript realtime capture, so the final card and quoted-reply route are marked completed.
- Make `inherit` a true no-override mode for shared Codex threads instead of forcing `on-request`; add an explicit, separately confirmed `fullAccess` mode for Codex and Claude Code.
- Remove the fixed 30-minute remote-turn deadline by default. Long Codex, Claude CLI, and Claude Channel work now waits for authoritative completion, failure, or `/cancel`; the compatibility extension can still opt into a finite timeout.
- Simplify the Agent Link desktop UI with a compact status summary, flat panels, smaller navigation, clearer permission names, and collapsed diagnostics.
- Bump Broker protocol capabilities to v4 for explicit full access and unlimited turns.

## 0.18.4

- Recover exact Codex turn completion with `thread/read` polling when a shared App Server websocket notification is missed, so the remote queue advances promptly after the real turn finishes.
- Separate observed local turns from Broker-owned remote turns; `/cancel` and `/steer` can no longer target a newer local VS Code turn by mistake.
- Bound completion callback delivery so a messaging-channel timeout cannot hold the Agent execution queue indefinitely.
- Migrate a legacy visible-console shared Codex service only after every loaded thread is idle, then relaunch it under the native hidden-console job while preserving persisted Session IDs and history.
- Add native process-tree termination for the one-time Windows migration and bump Broker capabilities to protocol v3.

## 0.18.3

- Attach remote replies to a thread already loaded by the same shared Codex App Server instead of issuing a second `thread/resume` writer.
- Never fall back to a CLI writer or silent branch when a shared VS Code Codex session reports a delivery error.
- Add Broker protocol capability negotiation and safely replace an idle incompatible Broker during upgrades, preventing old routing logic from surviving a new Agent Link install.
- Cover exact same-session attachment and no-second-writer behavior with regression tests.

## 0.18.2

- Windows Agent Hooks 改为通过 GUI 子系统的原生启动器静默执行，避免每条 Codex/Claude Code 消息触发控制台或 PowerShell 窗口闪烁。
- Hook Helper 改为部署到自定义数据目录中的内容寻址路径，不再引用 Electron 便携版的临时解压目录。
- 旧版共享 Codex 服务的窗口兼容监视器改为监听 Windows 窗口显示事件，不再以 250ms 轮询造成短暂闪现；新服务仍从创建时隐藏整个进程树。
- Agent Link 和兼容 VS Code 扩展会在启动时自动修复已安装 Hook 的运行路径。

## 0.18.1

- 修复 Broker 状态更新导致 Channel 与系统设置表单被反复重置的问题；控件聚焦期间不再重建页面，未保存草稿会跨状态刷新保留。
- 修复 Agent Link 托盘图标为空的问题；窗口和托盘统一加载打包内的 PNG 资源，并保留内嵌图标作为降级路径。

## 0.18.0

- Add Agent Link as an independent Electron desktop middleware with a tray, sandboxed control plane, session overview, Agent discovery, system policy settings, Hook Receiver, and Windows installer/portable targets.
- Introduce Channel API v1, a lifecycle-aware Channel Registry, schema-driven configuration, external adapter loading, generic channel-scoped routing, and a built-in Feishu adapter that no longer defines the core boundary.
- Move Channel credentials out of ordinary JSON and encrypt them with the operating-system-backed Electron `safeStorage`; keep only the selected data-directory pointer in the system app-data folder.
- Reuse the existing Session Broker, Session Registry, Reply Router, Codex App Server, Claude Channel, hook and transcript implementations from the independent control plane instead of recreating Agent chat UIs.
- Add a desktop control-plane lease so the VS Code extension automatically becomes a thin standby client while Agent Link is online, preventing duplicate Feishu WebSockets, transcript watchers, and notifications.
- Add generic `channel:<id>` input origins, channel-and-conversation namespacing, real-time Codex/Claude transcript forwarding, approval relay, authoritative completion routing, and per-channel enable/disable/test controls.
- Add architecture, Channel API and goal-oriented development documentation, eight new automated checks, secure TLS override handling, and reproducible Windows packaging assets.

## 0.17.1

- Run the shared Codex App Server inside a dedicated Windows GUI-subsystem host that creates one hidden console for Codex, Code Mode Host, and command-safety PowerShell descendants, preventing forwarded sessions from opening visible console windows.
- Keep the hidden host content-addressed for safe upgrades and place the complete process tree in a kill-on-close Job Object so failed starts and service restarts do not leave orphaned Agent processes.
- Hide console windows from an already-running pre-upgrade shared service without interrupting its active local session; the compatibility monitor exits with that legacy service.
- Preserve the full official Code Mode capability instead of disabling its host process, and fall back to the previous direct launch path when the native host is unavailable.

## 0.17.0

- Remove the custom managed Codex webview and its deprecated commands; status actions now open the official Codex and Claude Code interfaces so history, diffs, approvals, and new upstream features remain native.
- Make bridge setup fail open: unreadable bridge configuration, unavailable shared Codex App Server startup, or failed Claude Channel preparation launches the original Agent with the original arguments.
- Add a native-launcher fallback path for runtime startup failures on Windows and pass the same fallback executable through Unix launchers.
- Split the Windows Claude launchers: VS Code receives a GUI-subsystem wrapper that never opens a console window, while terminals retain a console-subsystem `claude-feishu.exe` with interactive stdio.
- Name native launchers by content hash so an upgrade never overwrites an executable locked by an active Codex/Claude process; switch settings to the new path and remove unlocked legacy launchers on later activation.
- Reject recursive installations whose recorded real Codex or Claude executable points back into the process-bridge directory, while preserving the pre-bridge setting backup for repair and uninstall.
- Add fault-injection tests for missing configuration, failed Channel preparation, and recursive bridge targets.

## 0.16.0

- Add an opt-in process bridge that works with the official VS Code extensions and standalone Codex/Claude Code CLIs; VS Code is now one client rather than the required session owner.
- Run one persistent official Codex App Server on a random loopback WebSocket endpoint and proxy the official VS Code stdio protocol to it; standalone Codex TUI sessions use the public `--remote` transport.
- Prefer adopting an authoritative external Codex thread with the original Session ID, and retain exact-turn persistent forking only as the active-writer compatibility fallback.
- Wrap the original Claude Code executable without patching it, inject an isolated official Channel per process, and migrate the Channel route to the real Claude Session ID through Hook metadata.
- Add native Windows launchers that preserve interactive terminals and relay redirected stdio for VS Code clients; add standalone launcher paths for use outside VS Code.
- Back up and restore `chatgpt.cliExecutable` and `claudeCode.claudeProcessWrapper` in the configurable local data directory. Installation is explicit and upgrades never enable the bridge automatically.
- Add bridge and shared-server diagnostics, argument transformation tests, same-ID adoption tests, and real Windows launcher/App Server multi-client smoke coverage.

## 0.15.0

- Fix a critical single-writer regression: quoted replies to externally owned Codex sessions now always create a persistent fork at the exact completed turn and never resume or retain the original thread in the notifier App Server.
- Reject external Codex threads at the reply runner, Broker HTTP boundary, and App Server client boundary before a process can claim the source session.
- Fix Broker process-test teardown so an already-exited child cannot leave the test runner and its helper processes orphaned.
- Include the underlying network error code and cause in Feishu delivery logs instead of reporting only `fetch failed`.
- Move managed Codex App Server ownership into an authenticated loopback Session Broker that survives Extension Host reloads.
- Add durable handoff state, local-input leases, explicit local-priority/remote-takeover status, input-origin labels, and a completion inbox that never fabricates a running turn after restart.
- Add a VS Code managed Codex panel so local and Feishu prompts share one Broker-owned thread.
- Start original Claude Code CLI sessions with the official Channel protocol for same-session Feishu injection, reply tools, permission relay, and real-session-ID migration.
- Relay Codex and Claude Code approval requests to both local UI and Feishu; the first valid response wins.
- Add real-process Broker reconnect and Codex App Server integration tests; the suite now contains 105 tests when the optional real Codex smoke test is enabled.

## 0.14.2

- Fix quoted replies to an external Claude Code session waiting indefinitely while the same session remains open in the VS Code Claude process.
- Resume the exact Claude session context with `--fork-session`, preserve the original IDE session, and persist the returned remote branch ID for later Feishu replies.
- Reuse the existing source-session/source-turn branch mapping so replies to the original Claude card continue in one managed remote branch across reloads.
- Show the complete Codex or Claude Code session ID in every metadata card body and header instead of only the first eight characters.
- Show complete session IDs in text notifications, acknowledgements, completion receipts, and session-selection output.
- Extend automated coverage to 94 unit/process tests.

## 0.14.1

- Add a visual local data-directory picker and the `feishuAgentNotifier.dataDirectory` setting for session routing metadata, pause state, and the offline queue.
- Migrate bounded user data across directories and volumes without overwriting an existing destination; keep only a minimal location pointer in VS Code private storage.
- Keep Feishu credentials in VS Code `SecretStorage`, and keep the Hook runtime plus receiver token separate from the configurable data directory.
- Update installed Codex and Claude Code Hooks to send offline events directly to the selected queue directory.
- Clarify that the internal `SessionRegistry` is a private JSON index and never accesses the Windows Registry.
- Extend automated coverage to 93 unit/process tests.

## 0.14.0

- Automatically fall back from an active-writer conflict to a persistent Codex App Server `thread/fork` anchored at the exact quoted completed turn.
- Persist source-session plus source-turn to managed-branch bindings in registry v3, so reloads and repeated replies return to the same remote branch.
- Preserve the original IDE session, keep the fork on disk, and route all later Feishu acknowledgements and completion cards to the managed branch without killing another Codex process.
- Read the real Codex thread title through `thread/read`, persist it with the session, and show the title plus short session ID on Feishu cards and session listings.
- Name `/new codex`, `/new cc`, and automatic Codex forks for immediate visual identification; automatic forks receive a visible `· 飞书` suffix.
- Require an exact `turnId` before automatic forking; older cards without one fail safely instead of guessing a conversation snapshot.
- Extend automated coverage to 91 unit/process tests and add a real active-writer persistent-fork protocol smoke test.

## 0.13.2

- Resume an authoritative completed Codex session from its exact original non-Git working directory by using the public `--skip-git-repo-check` compatibility flag.
- Scope the non-Git compatibility path to external, authoritative, existing Codex sessions; discovered sessions, new sessions, managed sessions, and Claude Code never receive the flag.
- Keep the selected remote execution policy unchanged: this compatibility flag does not bypass the Codex sandbox or approval policy.

## 0.13.1

- Fix quoted completion cards created before the 0.13.0 reload being rejected as disk-only sessions after upgrade.
- Upgrade the private session registry to v2 and persist route kind plus Agent event status for future exact-message safety checks.
- Migrate legacy completion evidence only when a terminal session has a contemporaneous delivered-message route; stale progress routes remain blocked.
- Extend automated coverage to 85 unit/process tests, including both safe legacy migration paths.

## 0.13.0

- Add single-owner Codex managed sessions backed by the official stdio App Server protocol, with persistent `thread/start` / `thread/resume`, streamed completion events, and no per-message `codex exec resume` process.
- Add `/steer` for explicitly appending input to the active turn of a Feishu-managed Codex session; `/cancel` now interrupts that App Server turn.
- Separate managed sessions from external IDE/CLI sessions. External sessions can run a remote follow-up only after an authoritative Hook/transcript completion event.
- Remove the unsafe transcript-mtime idle heuristic, so a long-running silent tool call can no longer be mistaken for a completed turn.
- Persist routes for bot acknowledgements and migrate provisional Claude session mappings after stream-json reveals the real session ID.
- Add App Server lifecycle diagnostics and extend automated coverage to 83 unit/process tests.

## 0.12.2

- Resolve Codex and Claude Code executables from their installed official VS Code extensions before falling back to `PATH`.
- Add optional explicit CLI path settings and include resolved paths in diagnostics.
- Fix Feishu remote replies failing with `spawn codex.exe ENOENT` when the VS Code extension host has a narrower `PATH` than the integrated terminal.

## 0.12.1

- Add a guided visual remote-control setup wizard for execution policy, app notification target, user allowlist, group allowlist, and group mention protection.
- Add explicit risk confirmation before enabling inherited local Agent permissions.
- Expose the wizard from the Command Palette, status menu, and onboarding walkthrough so remote control no longer requires editing `settings.json`.

## 0.12.0

- Add opt-in bidirectional Feishu application-bot support over the official WebSocket long connection, without requiring a public callback server.
- Persist Feishu `message_id` to Codex/Claude Code session mappings so quoted replies resume the exact local conversation instead of guessing the latest session.
- Discover recent local Codex and Claude Code history and add `/sessions`, `/use`, `/send`, `/new`, `/alias`, `/status`, `/cancel`, and `/help` commands.
- Resume Codex through `codex exec resume` and Claude Code through `claude --resume --print`, passing remote text over stdin rather than process arguments.
- Add per-session serialization, active-session waiting, bounded queue size, cancellation, execution timeout, and status replies.
- Keep remote execution disabled by default; add read-only planning and explicit inherited-permission policies with user/chat allowlists and required group mentions.
- Reuse multi-window receiver ownership so only the active VS Code window owns the Feishu long connection and automatically reconnects after takeover.
- Add per-project application-bot destinations, persistent aliases/chat selections, message-map expiry, inbound idempotency, and local session diagnostics.
- Bundle the official Feishu Node SDK into the extension while excluding source maps, development files, and transitive `node_modules` from the VSIX.
- Extend automated coverage to 71 unit/process tests plus Extension Host activation and package-content verification.

## 0.10.0

- Add the official Codex `Stop` Hook with `last_assistant_message`, while retaining `notify` as a backward-compatible and untrusted-hook fallback.
- Detect installed Codex and Claude Code capabilities and show the active or degraded capture channel in the status center and diagnostics.
- Keep Claude Code 2.1.165 and older on transcript compatibility mode instead of indefinitely reporting a pending `MessageDisplay` probe.
- Add authenticated multi-window receiver standby and automatic takeover after the owning VS Code window closes.
- Share paused-workspace filtering across windows so the receiver owner honors pause actions from any window in the same profile.
- Baseline historical Codex session files so sessions resumed from older date directories continue to emit new messages.
- Move the local receiver token out of Hook command arguments into the extension's private storage, using mode `0600` on POSIX systems.
- Deduplicate Codex final messages across transcript, official Stop Hook, and legacy notify sources.

## 0.9.1

- Move the live Feishu status center from the left side to the right side of the VS Code status bar.

## 0.9.0

- Add a live Feishu status center to the left side of the VS Code status bar.
- Show initializing, realtime, completion-only, sending, paused, configuration, Hook, queue, receiver, and delivery-error states.
- Add a Markdown hover summary for receiver, Codex, Claude Code, queue, and recent delivery health.
- Replace the status popup with a compact action menu for testing, pausing, retrying, repairing, diagnostics, settings, and logs.
- Add a workspace-scoped pause that filters matching live events while retaining paused queued events for later delivery.
- Remove obsolete local VSIX build artifacts from the development workspace.
- Make credential-migration documentation version-independent.
- Update official GitHub Actions from v4 to v7.

## 0.8.0

- Prefer Claude Code's official `MessageDisplay` Hook for realtime assistant text.
- Reassemble streamed display batches by message ID and index, emitting once when the message is final.
- Keep Claude transcript watching only until the first valid display event, or as a compatibility fallback when `MessageDisplay` is unavailable.
- Keep `Stop` and `StopFailure` as complete-message and failure fallbacks without duplicating realtime delivery.
- Avoid persisting incomplete `MessageDisplay` fragments while VS Code is offline.
- Add Hook installation, inspection, aggregation, ordering, and offline-behavior coverage.

## 0.7.0

- Add realtime delivery for every persisted main-agent assistant text message, enabled by default.
- Forward Codex `commentary` and `final_answer` transcript messages individually.
- Forward every Claude Code assistant text transcript entry while excluding thinking, tool use, tool results, and user input.
- Deduplicate the same final message when transcript monitoring and Codex notify or Claude Stop observe it together.
- Keep `completion` delivery timing as a compatibility option.
- Add an optional setting for showing VS Code local popups for realtime progress messages; it is off by default.
- Render realtime Feishu cards with a distinct blue “实时消息” header.
- Add transcript parser, watcher, privacy-filter, card, and local-notification coverage.

## 0.6.0

- Preserve up to 100 complete Agent events while VS Code is offline and deliver them after the extension starts again.
- Retry transient Feishu network, rate-limit, and server failures with bounded exponential backoff.
- Rate-limit repeated delivery-error popups while retaining every error in the output log.
- Add redacted diagnostics for receiver, Feishu configuration, Codex/Claude hooks, pending events, and recent delivery state.
- Add commands to repair hooks and retry pending events, plus a four-step VS Code onboarding walkthrough.
- Add a confirmed command for permanently clearing sensitive pending-event files.
- Migrate legacy plaintext Feishu credentials into VS Code SecretStorage and remove secret fields from the Settings UI.
- Declare local UI extension behavior and trusted/untrusted and virtual workspace capabilities.
- Add repository, support, security, contribution, and follow-up development-plan documentation.
- Add Windows/Linux CI, VSIX content checks, and tag-based GitHub Release automation.
- Add an isolated VS Code Extension Host integration test for activation, commands, and safe defaults.
- Normalize Windows and POSIX project paths consistently across host platforms.

## 0.5.0

- Add VS Code local completion and failure notifications for Codex and Claude Code.
- Let users show notifications always, only while the window is unfocused, or never.
- Include a configurable final-response preview and a button that opens the complete reply as Markdown.
- Add a dedicated command for testing local notifications.
- Add explicit coverage for Claude Code CLI hook input through stdin.

## 0.4.0

- Send notifications as Feishu JSON 2.0 message cards by default.
- Render headings, emphasis, lists, links, code blocks, and other standard Markdown.
- Convert GitHub-style Markdown tables into native Feishu table components.
- Show agent, status, project, time, and multipart progress in the card header.
- Add a `messageFormat` setting with a plain-text compatibility mode.

## 0.3.0

- Detect Codex IDE/app-server completion by watching newly appended local transcript `task_complete` events.
- Read the complete `last_agent_message` from the completion event.
- Baseline existing transcript files on startup so historical messages are never replayed.
- Deduplicate IDE transcript events against Codex CLI `notify` events by session and turn ID.
- Add `watchCodexIde` to disable the compatibility watcher when desired.

## 0.2.0

- Use Codex's official `notify` callback so Codex IDE notifications do not require CLI `/hooks` trust.
- Continue using Claude Code `Stop` and `StopFailure` hooks.
- Preserve and restore an existing Codex `notify` command during install/uninstall.
- Accept Codex notification JSON from the command-line argument as well as hook JSON from stdin.
- Reduce the default message chunk size to 3,000 characters for the Feishu webhook request limit.

## 0.1.0

- Receive Codex and Claude Code `Stop`/`StopFailure` hook events.
- Send the complete final assistant response to a Feishu custom webhook or app bot.
- Split long responses across multiple Feishu messages without truncation.
- Install and remove user-level hooks while preserving unrelated hook entries.
- Store Feishu credentials securely with VS Code SecretStorage.
