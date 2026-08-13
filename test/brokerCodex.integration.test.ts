import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerDescriptor } from "../src/brokerProtocol";

const codexExecutable = process.env.FEISHU_AGENT_CODEX_SMOKE;

test("real broker starts a persistent Codex App Server thread", { skip: !codexExecutable }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-agent-codex-smoke-"));
  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(path.join(directory, "broker-token"), token, "utf8");
  const child = spawn(process.execPath, [
    path.resolve(__dirname, "../src/brokerEntry.js"),
    "--data-dir", directory,
    "--codex", codexExecutable as string,
    "--version", "integration"
  ], { stdio: "ignore", windowsHide: true });
  try {
    const descriptor = await waitForDescriptor(path.join(directory, "broker.json"));
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/threads/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        cwd: process.cwd(),
        project: "vscode-feishu-agent-notifier",
        policy: "planOnly",
        name: "broker-codex-smoke"
      })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const session = JSON.parse(responseText) as { sessionId?: string; ownership?: string; managedBackend?: string };
    assert.ok(session.sessionId);
    assert.equal(session.ownership, "managed");
    assert.equal(session.managedBackend, "codex-app-server");
  } finally {
    await stopChild(child);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

async function waitForDescriptor(filePath: string): Promise<BrokerDescriptor> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as BrokerDescriptor;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Broker descriptor timeout");
}
