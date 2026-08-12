# Product readiness audit

This audit compares Feishu Agent Notifier with the baseline expected of a production-quality VS Code integration and notification product. It is intentionally stricter than “the happy path works.”

## Current readiness

| Area | 0.14.0 status | Mature open-source expectation |
| --- | --- | --- |
| Core message capture | Good | Capability-aware Claude MessageDisplay/transcript selection; Codex official Stop Hook plus notify and transcript fallbacks |
| Delivery reliability | Good | Unicode-safe chunking, timeouts, bounded retry/backoff, token caching, deduplication, and an offline queue |
| Credential security | Good | SecretStorage, automatic migration from legacy plaintext settings, loopback-only authenticated receiver |
| Onboarding | Good | Walkthrough, secure credential wizard, test commands, hook installer, and self-diagnostics |
| Diagnostics | Good | Version/capability-aware status center, receiver ownership, config/hook/queue checks, redacted report, logs, and repair commands |
| Automated quality | Good | Unit/process tests on Windows/Linux, Extension Host activation tests, package-content check, reproducible tag release workflow |
| Marketplace readiness | Partial | Repository metadata is present, but a verified VS Code Marketplace publisher, icon, screenshots, localization, and store listing are still required |
| Native background delivery | Partial | Every assistant text is near-realtime while VS Code runs; when it is closed only final Hook events can be queued, so a separate background watcher is required for always-on realtime delivery |
| Cross-environment support | Partial | Local multi-window ownership and takeover are supported; WSL, SSH, Dev Containers, and cross-profile routing need dedicated end-to-end coverage |
| Policy controls | Partial | Failure/local notification controls, workspace pause, and per-project destinations exist; project allow/deny rules, content redaction, and quiet hours are not yet implemented |
| Observability/history | Partial | Logs and last result exist; a searchable delivery history, per-message attempt details, and exportable support bundle are future work |
| Bidirectional control | Good | Exact quoted-turn routing including bot acknowledgements, persistent managed Codex App Server sessions and active-writer forks, deny-by-default allowlists, bounded execution, and no permission bypass |
| Remote session coverage | Partial | Managed Codex sessions support authoritative state, names, persistence, steering, and active-writer fork fallback; cloud sessions, WSL/SSH/containers, and multi-device routing remain out of scope |

## Release gates

A stable release should satisfy all of these gates:

1. Clean install, upgrade, hook repair, uninstall, and restoration are tested without losing unrelated user configuration.
2. A full final response survives Unicode, Markdown, tables, chunking, temporary Feishu failures, and a closed VS Code window.
3. Realtime mode forwards each persisted assistant text once without leaking thinking, tool calls, tool results, or user input.
4. No credential is present in settings UI, logs, diagnostics, VSIX contents, tests, or Git history.
5. Every automatic notification can be disabled or scoped, and repeated errors do not create an attention storm.
6. Windows and Linux CI pass; the built VSIX contains only runtime files and user documentation.
7. README, changelog, privacy/security notes, support links, version/tag, and downloadable artifact agree.
8. Remote replies reject unknown users/chats, deduplicate event IDs, never put prompts in argv, serialize per session, and cannot add bypass flags.

## Prioritized roadmap

### P0 — before broad distribution

- Validate upgrade behavior from 0.4/0.5 on real Windows and Linux profiles.
- Extend VS Code Extension Host coverage to SecretStorage migration and live configuration changes.
- Add real Codex and Claude Code smoke tests across the minimum and latest supported versions.
- Add Marketplace publisher identity, branded PNG icon, screenshots, and a privacy disclosure in the listing.

### P1 — mature open-source tool depth

- Project/source filters, quiet hours, and configurable redaction. Per-project application-bot destinations are available in 0.12.0.
- Delivery history with retry/discard actions and queue retention/size controls.
- WSL/SSH/Dev Container-aware hook installation and profile selection.
- English and Simplified Chinese package localization.
- Feishu card fallback when a Markdown structure is rejected by the platform.

### P2 — advanced architecture

- Optional signed, auto-start background companion for real-time delivery when VS Code is closed.
- Additional destinations behind a provider interface, without weakening the Feishu-first setup.
- Optional central relay for multiple computers, with device routing and end-to-end authenticated delivery.
- Move the Feishu receiver and managed Agent owner into an optional signed background companion so sessions survive VS Code reloads.
