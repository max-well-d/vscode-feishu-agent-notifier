import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLocalSessions } from "../src/sessionCatalog";

test("discovers Codex and Claude Code sessions with cwd metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-catalog-"));
  const codexRoot = path.join(root, "codex", "2026", "08", "13");
  const claudeRoot = path.join(root, "claude", "project");
  await fs.mkdir(codexRoot, { recursive: true });
  await fs.mkdir(claudeRoot, { recursive: true });
  const codexId = "11111111-1111-4111-8111-111111111111";
  const claudeId = "22222222-2222-4222-8222-222222222222";
  await fs.writeFile(path.join(codexRoot, `rollout-test-${codexId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd: "/repo/codex" } })}\n`);
  await fs.writeFile(path.join(claudeRoot, `${claudeId}.jsonl`),
    `${JSON.stringify({ type: "user", sessionId: claudeId, cwd: "/repo/claude" })}\n`);

  const sessions = await discoverLocalSessions({
    codexRoot: path.join(root, "codex"),
    claudeRoot: path.join(root, "claude"),
    now: () => new Date(Date.now() + 20_000)
  });
  assert.deepEqual(new Set(sessions.map((session) => session.sessionId)), new Set([codexId, claudeId]));
  assert.equal(sessions.find((session) => session.source === "codex")?.cwd, "/repo/codex");
  assert.equal(sessions.find((session) => session.source === "claude-code")?.cwd, "/repo/claude");
});
