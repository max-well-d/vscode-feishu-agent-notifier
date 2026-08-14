import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSharedCodexServer, sharedAppServerArgs } from "../src/codexSharedServer";

test("builds a shared Codex App Server command from a plain broker launch", () => {
  assert.deepEqual(
    sharedAppServerArgs("ws://127.0.0.1:41000", []),
    ["app-server", "--listen", "ws://127.0.0.1:41000"]
  );
});

test("preserves official VS Code App Server flags while replacing stdio transport", () => {
  assert.deepEqual(
    sharedAppServerArgs("ws://127.0.0.1:41001", [
      "-c", "features.code_mode_host=true",
      "app-server", "--analytics-default-enabled", "--stdio"
    ]),
    [
      "-c", "features.code_mode_host=true",
      "app-server", "--analytics-default-enabled",
      "--listen", "ws://127.0.0.1:41001"
    ]
  );
});

test("recovers the oldest healthy shared server when the primary descriptor was replaced", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-link-codex-lease-"));
  const oldServer = await readyServer();
  const newServer = await readyServer();
  try {
    const oldDescriptor = descriptor(oldServer.port, "2026-08-13T00:00:00.000Z");
    const newDescriptor = descriptor(newServer.port, "2026-08-14T00:00:00.000Z");
    await fs.mkdir(path.join(directory, "codex-shared-servers"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(directory, "codex-shared.json"), JSON.stringify(newDescriptor), "utf8"),
      fs.writeFile(path.join(directory, "codex-shared-servers", "old.json"), JSON.stringify(oldDescriptor), "utf8")
    ]);

    const recovered = await ensureSharedCodexServer({
      dataDirectory: directory,
      executable: path.join(directory, "must-not-spawn.exe")
    });

    assert.equal(recovered.endpoint, oldDescriptor.endpoint);
    const primary = JSON.parse(await fs.readFile(path.join(directory, "codex-shared.json"), "utf8")) as { endpoint: string };
    assert.equal(primary.endpoint, oldDescriptor.endpoint);
  } finally {
    await Promise.all([oldServer.close(), newServer.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function descriptor(port: number, startedAt: string) {
  return {
    protocolVersion: 1 as const,
    pid: process.pid,
    port,
    endpoint: `ws://127.0.0.1:${port}`,
    executable: process.execPath,
    startedAt
  };
}

async function readyServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}
