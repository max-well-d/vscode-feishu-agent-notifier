import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexTranscriptWatcher, parseCodexTranscriptLine } from "../src/codexTranscriptWatcher";

function state() {
  return {
    cwdByTurnId: new Map<string, string>(),
    finalMessageByTurnId: new Map<string, string>()
  };
}

test("parses a Codex IDE task_complete event with the full final message", () => {
  const parserState = state();
  const turnId = "019ff3d7-8893-7291-9178-1c50cb90686f";
  parseCodexTranscriptLine(JSON.stringify({
    type: "turn_context",
    payload: { turn_id: turnId, cwd: "D:\\code\\project" }
  }), "ignored.jsonl", parserState, "D:\\fallback");

  const event = parseCodexTranscriptLine(JSON.stringify({
    timestamp: "2026-08-12T02:49:45.854Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: "完整的 IDE 最终回复 🚀"
    }
  }), `rollout-${turnId}.jsonl`, parserState, "D:\\fallback");

  assert.ok(event);
  assert.equal(event.source, "codex");
  assert.equal(event.eventName, "agent-turn-complete");
  assert.equal(event.sessionId, turnId);
  assert.equal(event.turnId, turnId);
  assert.equal(event.cwd, "D:\\code\\project");
  assert.equal(event.message, "完整的 IDE 最终回复 🚀");
});

test("falls back to the final response item when task_complete omits its message", () => {
  const parserState = state();
  const turnId = "019ff3d7-8893-7291-9178-1c50cb90686f";
  parseCodexTranscriptLine(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "分段" }, { type: "output_text", text: "完整内容" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId }
    }
  }), "ignored.jsonl", parserState, "D:\\fallback");

  const event = parseCodexTranscriptLine(JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId }
  }), `rollout-${turnId}.jsonl`, parserState, "D:\\fallback");

  assert.equal(event?.message, "分段完整内容");
  assert.equal(event?.cwd, "D:\\fallback");
});

test("ignores commentary and malformed transcript lines", () => {
  const parserState = state();
  assert.equal(parseCodexTranscriptLine("not-json", "x.jsonl", parserState, ""), undefined);
  assert.equal(parseCodexTranscriptLine(JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "处理中" }
  }), "x.jsonl", parserState, ""), undefined);
});

test("watcher baselines existing history and emits only newly appended completions", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-watcher-"));
  const now = new Date();
  const dateDirectory = path.join(
    temporaryRoot,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  await fs.mkdir(dateDirectory, { recursive: true });
  const sessionId = "019ff3d7-8893-7291-9178-1c50cb90686f";
  const filePath = path.join(dateDirectory, `rollout-${sessionId}.jsonl`);
  await fs.writeFile(filePath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "old", last_agent_message: "旧消息" }
  })}\n`, "utf8");

  const events: string[] = [];
  const watcher = new CodexTranscriptWatcher(
    (event) => { events.push(event.message); },
    "D:\\fallback",
    temporaryRoot,
    (error) => { throw error; },
    20
  );
  try {
    await watcher.start();
    await fs.appendFile(filePath, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "new", last_agent_message: "新消息" }
    })}\n`, "utf8");
    await waitFor(() => events.length === 1, 1_000);
    assert.deepEqual(events, ["新消息"]);
  } finally {
    watcher.stop();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("等待 watcher 事件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
