# Changelog

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
