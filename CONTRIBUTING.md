# Contributing

Requirements: Node.js 22 or newer and a VS Code version matching `engines.vscode`.

```powershell
npm ci
npm test
npm run test:integration
npm run check-package
npm run package
```

Changes that touch hook installation must preserve unrelated Codex and Claude Code configuration and include idempotency/removal tests. Network changes must test transient retry and permanent failure behavior. Remote-reply changes must preserve deny-by-default allowlists, JSON-RPC/stdin-only prompt transport, single-owner session serialization, authoritative external-session completion, bounded queues, and the absence of bypass flags. Never add real Feishu credentials or captured Agent transcripts to fixtures.
