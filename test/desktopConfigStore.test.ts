import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHANNEL_API_VERSION, ChannelManifest } from "../src/channels/types";
import { DesktopConfigStore } from "../src/desktop/configStore";

const manifest: ChannelManifest = {
  apiVersion: CHANNEL_API_VERSION,
  id: "sample-channel",
  name: "Sample",
  version: "1.0.0",
  description: "sample",
  capabilities: ["outbound"],
  configSchema: {
    type: "object",
    properties: {
      endpoint: { type: "string" },
      token: { type: "string", secret: true }
    }
  }
};

test("DesktopConfigStore keeps secrets out of plain configuration", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-link-store-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const protector = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`protected:${value}`, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8").replace(/^protected:/, "")
  };
  const store = new DesktopConfigStore(directory, protector);
  await store.save(manifest, {
    enabled: true,
    config: { endpoint: "https://example.test", token: "top-secret" }
  });

  const plain = await fs.readFile(path.join(directory, "channels.json"), "utf8");
  const encrypted = await fs.readFile(path.join(directory, "channel-secrets.json"), "utf8");
  assert.doesNotMatch(plain, /top-secret/);
  assert.doesNotMatch(encrypted, /top-secret/);
  assert.equal((await store.load([manifest]))[manifest.id].config.token, "top-secret");
});

test("DesktopConfigStore refuses to save secrets without secure storage", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-link-store-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DesktopConfigStore(directory, {
    isAvailable: () => false,
    encrypt: () => Buffer.alloc(0),
    decrypt: () => ""
  });
  await assert.rejects(
    store.save(manifest, { enabled: true, config: { token: "unsafe" } }),
    /拒绝明文保存/
  );
});
