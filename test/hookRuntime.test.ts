import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deployHookRuntime } from "../src/hookRuntime";

test("deploys a persistent content-addressed hook runtime", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-link-hook-runtime-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const installation = await deployHookRuntime({
    dataDirectory: root,
    helperSourcePath: path.resolve("scripts", "agent-hook.cjs"),
    launcherSourcePath: path.resolve("assets", "windows", "HookLauncher.cs")
  });

  assert.equal(path.dirname(installation.root), root);
  assert.match(path.basename(installation.helperPath), /^agent-hook-[0-9a-f]{12}\.cjs$/);
  assert.equal((await fs.stat(installation.helperPath)).isFile(), true);
  if (process.platform === "win32") {
    assert.match(path.basename(installation.commandPath ?? ""), /^agent-link-hook-[0-9a-f]{12}\.exe$/);
    assert.equal((await fs.stat(installation.commandPath!)).isFile(), true);
    const tokenPath = path.join(root, "token");
    await fs.writeFile(tokenPath, "test-token\n", "utf8");
    let received: Record<string, unknown> | undefined;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        assert.equal(request.headers["x-feishu-agent-token"], "test-token");
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const output = await runNativeHook(installation.commandPath!, [
      "--port", String(address.port), "--token-file", tokenPath, "--source", "codex"
    ], JSON.stringify({ type: "agent-turn-complete", message: "ok" }));
    assert.equal(output, "{}\n");
    assert.equal(received?.message, "ok");
    assert.equal(received?.__notifier_source, "codex");
  } else {
    assert.equal(installation.commandPath, undefined);
  }
});

async function runNativeHook(executable: string, args: string[], stdin: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(Buffer.concat(output).toString("utf8"))
      : reject(new Error(`native hook exited ${code}: ${error}`)));
    child.stdin.end(stdin);
  });
}
