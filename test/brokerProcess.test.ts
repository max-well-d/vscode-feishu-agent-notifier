import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerDescriptor, BrokerSnapshot } from "../src/brokerProtocol";

test("broker survives client disconnect and remains reconnectable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-agent-broker-test-"));
  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(path.join(directory, "broker-token"), token, "utf8");
  const entry = path.resolve(__dirname, "../src/brokerEntry.js");
  const child = spawn(process.execPath, [
    entry,
    "--data-dir", directory,
    "--codex", process.execPath,
    "--version", "test"
  ], { stdio: "ignore", windowsHide: true });
  try {
    const descriptor = await waitForDescriptor(path.join(directory, "broker.json"));
    const first = await health(descriptor, token);
    assert.equal(first.state, "ready");

    // A request ending is the same lifecycle boundary as an Extension Host
    // connection disappearing. The broker must remain the process owner.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await health(descriptor, token);
    assert.equal(second.pid, descriptor.pid);
    assert.equal(second.state, "ready");
    assert.equal(child.exitCode, null);
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as BrokerDescriptor;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Broker descriptor timeout");
}

async function health(descriptor: BrokerDescriptor, token: string): Promise<BrokerSnapshot> {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/health`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<BrokerSnapshot>;
}
