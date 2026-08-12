import assert from "node:assert/strict";
import test from "node:test";
import { buildFeishuCard, markdownToCardElements } from "../src/card";
import { AgentEvent } from "../src/types";

const event: AgentEvent = {
  source: "codex",
  eventName: "agent-turn-complete",
  status: "completed",
  sessionId: "session",
  turnId: "turn",
  cwd: "C:\\work\\project",
  project: "project",
  sessionName: "修复飞书远程控制",
  message: "done",
  occurredAt: "2026-08-12T03:00:00.000Z"
};

test("builds a visual card header and Markdown body", () => {
  const card = buildFeishuCard(event, "## 结果\n\n**完成**", true) as any;
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.template, "green");
  assert.match(card.header.title.content, /Codex/);
  assert.match(card.header.subtitle.content, /project/);
  assert.match(card.header.subtitle.content, /修复飞书远程控制/);
  assert.match(card.header.subtitle.content, /session/);
  assert.equal(card.body.elements[0].tag, "markdown");
  assert.equal(card.body.elements[0].content, "## 结果\n\n**完成**");
});

test("turns a GitHub Markdown table into a native Feishu table", () => {
  const elements = markdownToCardElements([
    "前言",
    "",
    "| 实验 | 状态 | 说明 |",
    "|---|:---:|---|",
    "| A0 | ✅ | **必要** |",
    "| A1 | 🚫 | 可删除 |",
    "",
    "结论"
  ].join("\n")) as any[];

  assert.deepEqual(elements.map((element) => element.tag), ["markdown", "table", "markdown"]);
  assert.equal(elements[1].columns[0].display_name, "实验");
  assert.equal(elements[1].rows[0].column_3, "**必要**");
  assert.equal(elements[1].row_height, "auto");
});

test("renders realtime messages with a distinct blue header", () => {
  const card = buildFeishuCard({ ...event, status: "progress" }, "正在执行测试", true) as any;
  assert.equal(card.header.template, "blue");
  assert.match(card.header.title.content, /实时消息/);
});
