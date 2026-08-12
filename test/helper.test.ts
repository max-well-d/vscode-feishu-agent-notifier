import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";

test("helper accepts Codex notify JSON as the final argv value", async () => {
  let received: Record<string, unknown> | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "last-assistant-message": "完整通知内容"
  });
  const helper = path.resolve(__dirname, "../../scripts/agent-hook.cjs");
  const child = spawn(process.execPath, [
    helper,
    "--port", String(address.port),
    "--token", "test-token",
    "--source", "codex",
    "--notifier-id", "feishu-agent-notifier-v1",
    payload
  ]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), "{}");
  assert.equal(received?.__notifier_source, "codex");
  assert.equal(received?.["last-assistant-message"], "完整通知内容");
});

test("helper accepts Claude Code hook JSON from stdin", async () => {
  let received: Record<string, unknown> | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const helper = path.resolve(__dirname, "../../scripts/agent-hook.cjs");
  const child = spawn(process.execPath, [
    helper,
    "--port", String(address.port),
    "--token", "test-token",
    "--source", "claude-code",
    "--notifier-id", "feishu-agent-notifier-v1"
  ]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stdin.end(JSON.stringify({
    hook_event_name: "Stop",
    last_assistant_message: "Claude Code 完整回复"
  }));
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), "{}");
  assert.equal(received?.__notifier_source, "claude-code");
  assert.equal(received?.last_assistant_message, "Claude Code 完整回复");
});
