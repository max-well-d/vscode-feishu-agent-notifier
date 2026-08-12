import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeTranscriptWatcher, parseClaudeTranscriptLine } from "../src/claudeTranscriptWatcher";
import { AgentEvent } from "../src/types";

test("parses only Claude assistant text blocks", () => {
  const event = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    uuid: "message-1",
    sessionId: "session-1",
    timestamp: "2026-08-12T06:00:00.000Z",
    cwd: "C:\\work\\claude-project",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "第一条实时消息" },
        { type: "tool_use", name: "Bash", input: { command: "secret" } }
      ]
    }
  }), "C:\\transcripts\\session-1.jsonl", "C:\\fallback");

  assert.equal(event?.source, "claude-code");
  assert.equal(event?.status, "progress");
  assert.equal(event?.eventId, "message-1");
  assert.equal(event?.project, "claude-project");
  assert.equal(event?.message, "第一条实时消息");
  assert.doesNotMatch(event?.message ?? "", /private reasoning|secret/);
});

test("ignores Claude thinking and tool-only entries", () => {
  const event = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }
  }), "session.jsonl", "/work");
  assert.equal(event, undefined);
});

test("ignores Claude Code sidechain/subagent text", () => {
  const event = parseClaudeTranscriptLine(JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text: "子代理内部消息" }] }
  }), "session.jsonl", "/work");
  assert.equal(event, undefined);
});

test("Claude watcher baselines history and emits newly appended text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-watcher-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "d--work--project");
  await fs.mkdir(project);
  const transcript = path.join(project, "session-live.jsonl");
  await fs.writeFile(transcript, `${claudeLine("old", "历史消息")}\n`, "utf8");

  const events: AgentEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher(
    (event) => { events.push(event); },
    "/fallback",
    root,
    (error) => { throw error; },
    20
  );
  await watcher.start();
  t.after(() => watcher.stop());
  await fs.appendFile(transcript, `${claudeLine("new", "新增实时消息")}\n`, "utf8");
  await waitFor(() => events.length === 1);

  assert.equal(events[0].eventId, "new");
  assert.equal(events[0].message, "新增实时消息");
});

function claudeLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    sessionId: "session-live",
    timestamp: "2026-08-12T06:00:00.000Z",
    cwd: "/work/project",
    message: { role: "assistant", content: [{ type: "text", text }] }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for Claude transcript event");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
