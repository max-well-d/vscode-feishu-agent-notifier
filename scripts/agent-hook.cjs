#!/usr/bin/env node
"use strict";

const http = require("node:http");

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

  await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "X-Feishu-Agent-Token": args.token || ""
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

main()
  .catch((error) => {
    console.error(`[feishu-agent-notifier] ${error.message}`);
  })
  .finally(() => {
    // Codex/Claude Stop hooks expect valid JSON on stdout when a command exits 0.
    process.stdout.write("{}\n");
  });
