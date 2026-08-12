#!/usr/bin/env node
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_PENDING_EVENTS = 100;

function parseArguments(argv) {
  const result = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      result[value.slice(2)] = argv[index + 1] || "";
      index += 1;
    } else {
      result.positional.push(value);
    }
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const argvJson = args.positional.find((value) => value.trim().startsWith("{"));
  const raw = argvJson || await readStdin();
  if (!raw.trim()) {
    throw new Error("通知脚本没有收到 stdin 或命令行 JSON");
  }

  const event = JSON.parse(raw);
  event.__notifier_source = args.source || "unknown";
  const body = Buffer.from(JSON.stringify(event), "utf8");
  const port = Number(args.port || 37561);

  try {
    await postEvent(body, port, args.token || "");
  } catch (error) {
    const queued = await queueOfflineEvent(event, error, args.spool);
    if (queued) {
      console.error(`[feishu-agent-notifier] 本地接收器不可用，事件已加入待处理队列：${error.message}`);
    } else {
      console.error(`[feishu-agent-notifier] ${error.message}`);
    }
  }
}

async function postEvent(body, port, token) {
  await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "X-Feishu-Agent-Token": token
      },
      timeout: 5000
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`本地通知接收器返回 HTTP ${response.statusCode || "unknown"}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("连接本地通知接收器超时")));
    request.on("error", reject);
    request.end(body);
  });
}

async function queueOfflineEvent(event, error, overrideDirectory) {
  const directory = overrideDirectory || path.join(__dirname, "pending-events");
  const disabledMarker = path.join(path.dirname(directory), "offline-queue-disabled");
  try {
    await fs.access(disabledMarker);
    return false;
  } catch (accessError) {
    if (accessError.code !== "ENOENT") {
      return false;
    }
  }

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const fileName = [
      String(Date.now()).padStart(13, "0"),
      process.pid,
      crypto.randomBytes(6).toString("hex")
    ].join("-") + ".json";
    const envelope = {
      event,
      queuedAt: new Date().toISOString(),
      lastError: String(error && error.message || error).slice(0, 500)
    };
    await fs.writeFile(
      path.join(directory, fileName),
      `${JSON.stringify(envelope)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    await prunePendingEvents(directory);
    return true;
  } catch (queueError) {
    console.error(`[feishu-agent-notifier] 无法保存待处理事件：${queueError.message}`);
    return false;
  }
}

async function prunePendingEvents(directory) {
  const files = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const obsolete = files.slice(0, Math.max(0, files.length - MAX_PENDING_EVENTS));
  await Promise.all(obsolete.map((fileName) => fs.rm(path.join(directory, fileName), { force: true })));
}

main()
  .catch((error) => {
    console.error(`[feishu-agent-notifier] ${error.message}`);
  })
  .finally(() => {
    // Codex/Claude Stop hooks expect valid JSON on stdout when a command exits 0.
    process.stdout.write("{}\n");
  });
