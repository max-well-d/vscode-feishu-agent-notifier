#!/usr/bin/env node
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_PENDING_EVENTS = 100;
// Claude Code 同步 hook 超时上限为 600 秒；留 10 秒余量用于本地回退。
const PERMISSION_MAX_WAIT_MS = 590_000;
// 单次长轮询时长：本地接收器最长等待 60 秒。
const PERMISSION_POLL_MS = 65_000;

let decisionWritten = false;

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
  if (event.hook_event_name === "PermissionRequest") {
    await handlePermissionRequest(event, args);
    return;
  }
  event.__notifier_source = args.source || "unknown";
  event.__notifier_channel_id = process.env.FEISHU_AGENT_CHANNEL_ID || "";
  event.__notifier_bridge_backend = process.env.FEISHU_AGENT_BRIDGE_BACKEND || "";
  const body = Buffer.from(JSON.stringify(event), "utf8");
  const port = Number(args.port || 37561);
  try {
    const token = await readToken(args);
    await postEvent(body, port, token);
  } catch (error) {
    const queued = args["queue-offline"] !== "false"
      && await queueOfflineEvent(event, error, args.spool);
    if (queued) {
      console.error(`[feishu-agent-notifier] 本地接收器不可用，事件已加入待处理队列：${error.message}`);
    } else {
      console.error(`[feishu-agent-notifier] ${error.message}`);
    }
  }
}

/**
 * Claude Code PermissionRequest hook：把权限请求转发给本地接收器并长轮询等待
 * 远程决定（飞书 /approve /deny），把结果作为 permissionDecision 写回 stdout。
 * 任何失败或超时都回退为 "ask"，恢复 Claude 的本地交互式确认。
 */
async function handlePermissionRequest(event, args) {
  const port = Number(args.port || 37561);
  try {
    const token = await readToken(args);
    const registered = await httpJsonRequest("POST", "/permission-request", port, token,
      Buffer.from(JSON.stringify({ request: event }), "utf8"));
    if (!registered || !registered.approvalId) {
      throw new Error("本地接收器未返回审批 ID");
    }
    const approvalId = registered.approvalId;
    const deadline = Date.now() + PERMISSION_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const verdict = await httpJsonRequest("GET", `/permission-verdict/${encodeURIComponent(approvalId)}`, port, token, null);
      if (verdict && typeof verdict.decision === "string") {
        writeDecision(verdict.decision, verdict.decision === "allow"
          ? "Agent Link 远程已允许"
          : verdict.decision === "deny" ? "Agent Link 远程已拒绝" : "Agent Link 要求恢复本地确认");
        return;
      }
      // 接收器返回空（无裁决）：等待后重试；单轮在接收器侧已等待至多 60 秒。
      await delay(1_000);
    }
    writeDecision("ask", "10 分钟内未收到远程决定，恢复本地确认");
  } catch (error) {
    writeDecision("ask", `Agent Link 无法转发权限请求：${error.message}`);
  }
}

function writeDecision(decision, reason) {
  decisionWritten = true;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  })}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readToken(args) {
  if (args["token-file"]) {
    return (await fs.readFile(args["token-file"], "utf8")).trim();
  }
  return args.token || "";
}

function httpJsonRequest(method, requestPath, port, token, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Feishu-Agent-Token": token,
        "Content-Length": body ? body.length : 0
      },
      timeout: PERMISSION_POLL_MS
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value = {};
        if (text) {
          try {
            value = JSON.parse(text);
          } catch {
            value = {};
          }
        }
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(value);
        } else {
          reject(new Error(`本地通知接收器返回 HTTP ${response.statusCode || "unknown"}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("连接本地通知接收器超时")));
    request.on("error", reject);
    if (body) {
      request.end(body);
    } else {
      request.end();
    }
  });
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
    if (!decisionWritten) {
      process.stdout.write("{}\n");
    }
  });
