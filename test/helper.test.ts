import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-helper-token-test-"));
  const tokenFile = path.join(root, "receiver-token");
  await fs.writeFile(tokenFile, "test-token\n", { encoding: "utf8", mode: 0o600 });
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
    "--token-file", tokenFile,
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
  await fs.rm(root, { recursive: true, force: true });

  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), "{}");
  assert.equal(received?.__notifier_source, "claude-code");
  assert.equal(received?.last_assistant_message, "Claude Code 完整回复");
});

test("helper queues the complete event while VS Code is offline", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-helper-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const spool = path.join(root, "pending-events");
  const helper = path.resolve(__dirname, "../../scripts/agent-hook.cjs");
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "last-assistant-message": "离线时也不能丢失的完整回复"
  });
  const child = spawn(process.execPath, [
    helper,
    "--port", "1",
    "--token", "test-token",
    "--source", "codex",
    "--spool", spool,
    payload
  ]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), "{}");
  const files = await fs.readdir(spool);
  assert.equal(files.length, 1);
  const queued = JSON.parse(await fs.readFile(path.join(spool, files[0]), "utf8"));
  assert.equal(queued.event.__notifier_source, "codex");
  assert.equal(queued.event["last-assistant-message"], "离线时也不能丢失的完整回复");
  assert.ok(queued.queuedAt);
});

test("helper does not queue MessageDisplay fragments while VS Code is offline", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-helper-display-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const spool = path.join(root, "pending-events");
  const helper = path.resolve(__dirname, "../../scripts/agent-hook.cjs");
  const child = spawn(process.execPath, [
    helper,
    "--port", "1",
    "--token", "test-token",
    "--source", "claude-code",
    "--spool", spool,
    "--queue-offline", "false"
  ]);
  child.stdin.end(JSON.stringify({
    hook_event_name: "MessageDisplay",
    session_id: "session-1",
    message_id: "message-1",
    index: 0,
    final: false,
    delta: "过程分片"
  }));
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

  assert.equal(exitCode, 0);
  await assert.rejects(fs.access(spool), { code: "ENOENT" });
});
