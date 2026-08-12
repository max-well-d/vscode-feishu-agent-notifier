# Product readiness audit

This audit compares Feishu Agent Notifier with the baseline expected of a production-quality VS Code integration and notification product. It is intentionally stricter than “the happy path works.”

## Current readiness

| Area | 0.6.0 status | Production expectation |
| --- | --- | --- |
| Core completion capture | Good | Codex CLI official `notify`, Claude Code Stop/StopFailure, and a clearly labeled Codex IDE compatibility watcher |
| Delivery reliability | Good | Unicode-safe chunking, timeouts, bounded retry/backoff, token caching, deduplication, and an offline queue |
| Credential security | Good | SecretStorage, automatic migration from legacy plaintext settings, loopback-only authenticated receiver |
| Onboarding | Good | Walkthrough, secure credential wizard, test commands, hook installer, and self-diagnostics |
| Diagnostics | Good | Receiver/config/hook/queue checks and a redacted report; logs and actionable repair commands |
| Automated quality | Good | Unit and process-level tests on Windows/Linux, package-content check, reproducible tag release workflow |
| Marketplace readiness | Partial | Repository metadata is present, but a verified VS Code Marketplace publisher, icon, screenshots, localization, and store listing are still required |
| Native background delivery | Partial | Events are preserved while VS Code is closed, but real-time sending waits until VS Code starts; a separate background service would be required for true always-on delivery |
| Cross-environment support | Partial | Local UI extension behavior is explicit; WSL, SSH, Dev Containers, multiple profiles, and portable hook paths need dedicated end-to-end coverage |
| Policy controls | Partial | Failure/local notification controls exist; project allow/deny rules, content redaction, quiet hours, and destination routing are not yet implemented |
| Observability/history | Partial | Logs and last result exist; a searchable delivery history, per-message attempt details, and exportable support bundle are future work |

## Release gates

A stable release should satisfy all of these gates:

1. Clean install, upgrade, hook repair, uninstall, and restoration are tested without losing unrelated user configuration.
2. A full final response survives Unicode, Markdown, tables, chunking, temporary Feishu failures, and a closed VS Code window.
3. No credential is present in settings UI, logs, diagnostics, VSIX contents, tests, or Git history.
4. Every automatic notification can be disabled or scoped, and repeated errors do not create an attention storm.
5. Windows and Linux CI pass; the built VSIX contains only runtime files and user documentation.
6. README, changelog, privacy/security notes, support links, version/tag, and downloadable artifact agree.

## Prioritized roadmap

### P0 — before broad distribution

- Validate upgrade behavior from 0.4/0.5 on real Windows and Linux profiles.
- Add VS Code Extension Host integration tests for activation, commands, SecretStorage migration, and configuration changes.
- Add Marketplace publisher identity, branded PNG icon, screenshots, and a privacy disclosure in the listing.

### P1 — professional product depth

- Project/source filters, quiet hours, configurable redaction, and per-project destinations.
- Delivery history with retry/discard actions and queue retention/size controls.
- WSL/SSH/Dev Container-aware hook installation and profile selection.
- English and Simplified Chinese package localization.
- Feishu card fallback when a Markdown structure is rejected by the platform.

### P2 — advanced architecture

- Optional signed, auto-start background companion for real-time delivery when VS Code is closed.
- Additional destinations behind a provider interface, without weakening the Feishu-first setup.
- Optional inbound commands with explicit authentication, allowlists, confirmation, and audit logs.
