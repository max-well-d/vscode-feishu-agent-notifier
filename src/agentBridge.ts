import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { ensureSharedCodexServer } from "./codexSharedServer";

interface BridgeConfig {
  protocolVersion: 1;
  dataDirectory: string;
  realExecutable: string;
  runtimePath: string;
  claudeChannelScript: string;
}

void main().catch((error) => {
  process.stderr.write(`Feishu Agent bridge failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const separator = process.argv.indexOf("--");
  const controlArgs = process.argv.slice(2, separator < 0 ? undefined : separator);
  const forwarded = separator < 0 ? [] : process.argv.slice(separator + 1);
  const mode = controlArgs[0];
  const configIndex = controlArgs.indexOf("--config");
  const configPath = configIndex >= 0 ? controlArgs[configIndex + 1] : undefined;
  const fallbackIndex = controlArgs.indexOf("--fallback-executable");
  const fallbackExecutable = fallbackIndex >= 0 ? controlArgs[fallbackIndex + 1] : undefined;
  if ((mode !== "codex" && mode !== "claude") || !configPath) {
    throw new Error("用法：agent-bridge <codex|claude> --config <bridge.json> -- <Agent 参数>");
  }
  let config: BridgeConfig;
  try {
    config = await readConfig(configPath);
  } catch (error) {
    if (!fallbackExecutable) {
      throw error;
    }
    await runFallback(mode, fallbackExecutable, forwarded, error, true);
    return;
  }
  if (mode === "codex") {
    await runCodexBridge(config, forwarded);
  } else {
    await runClaudeBridge(config, forwarded);
  }
}

async function runCodexBridge(config: BridgeConfig, args: string[]): Promise<void> {
  if (codexCommand(args) === "app-server") {
    let socket: WebSocket;
    try {
      const descriptor = await ensureSharedCodexServer({
        dataDirectory: config.dataDirectory,
        executable: config.realExecutable,
        appServerArgs: args
      });
      socket = await connectWebSocket(descriptor.endpoint);
    } catch (error) {
      await runFallback("codex", config.realExecutable, args, error);
      return;
    }
    await proxyJsonLines(socket, config.dataDirectory);
    return;
  }
  if (!isInteractiveCodexInvocation(args) || hasOption(args, "--remote")) {
    process.exitCode = await runInherited(config.realExecutable, args, process.env);
    return;
  }
  let endpoint: string;
  try {
    const descriptor = await ensureSharedCodexServer({
      dataDirectory: config.dataDirectory,
      executable: config.realExecutable,
      appServerArgs: ["-c", "features.code_mode_host=true", "app-server"]
    });
    endpoint = descriptor.endpoint;
  } catch (error) {
    await runFallback("codex", config.realExecutable, args, error);
    return;
  }
  process.exitCode = await runInherited(
    config.realExecutable,
    ["--remote", endpoint, ...args],
    { ...process.env, FEISHU_AGENT_BRIDGE_BACKEND: "codex-app-server" }
  );
}

async function runClaudeBridge(config: BridgeConfig, forwarded: string[]): Promise<void> {
  const first = forwarded[0];
  const wrapperExecutable = first && !first.startsWith("-") && await isFile(first) ? first : undefined;
  const executable = wrapperExecutable ?? config.realExecutable;
  const args = wrapperExecutable ? forwarded.slice(1) : forwarded;
  if (!isClaudeSessionInvocation(args)) {
    process.exitCode = await runInherited(executable, args, process.env);
    return;
  }
  let channelId: string;
  let mcpPath: string;
  let injected: string[];
  try {
    channelId = crypto.randomUUID();
    const channelDirectory = path.join(config.dataDirectory, "claude-channels");
    await fs.mkdir(channelDirectory, { recursive: true, mode: 0o700 });
    mcpPath = path.join(channelDirectory, `${channelId}.json`);
    const mcpConfig = {
      mcpServers: {
        "feishu-agent-notifier": {
          command: config.runtimePath,
          args: [
            config.claudeChannelScript,
            "--data-dir", config.dataDirectory,
            "--channel-id", channelId
          ],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            FEISHU_AGENT_CHANNEL_ID: channelId,
            FEISHU_AGENT_DATA_DIRECTORY: config.dataDirectory
          }
        }
      }
    };
    await fs.writeFile(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    injected = [...args];
    if (!hasOptionValue(injected, "--mcp-config", mcpPath)) {
      injected.push("--mcp-config", mcpPath);
    }
    if (!hasOptionValue(injected, "--dangerously-load-development-channels", "server:feishu-agent-notifier")) {
      injected.push("--dangerously-load-development-channels", "server:feishu-agent-notifier");
    }
  } catch (error) {
    await runFallback("claude", executable, args, error);
    return;
  }
  try {
    process.exitCode = await runInherited(executable, injected, {
      ...process.env,
      FEISHU_AGENT_CHANNEL_ID: channelId,
      FEISHU_AGENT_DATA_DIRECTORY: config.dataDirectory,
      FEISHU_AGENT_BRIDGE_BACKEND: "claude-channel"
    });
  } finally {
    await fs.rm(mcpPath, { force: true }).catch(() => undefined);
  }
}

async function connectWebSocket(endpoint: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    const onError = (): void => reject(new Error(`无法连接 Codex 共享 App Server：${endpoint}`));
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
  return socket;
}

async function proxyJsonLines(socket: WebSocket, dataDirectory: string): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.on("line", (line) => {
    if (line.trim() && socket.readyState === WebSocket.OPEN) {
      void noteLocalCodexInput(dataDirectory, line);
      socket.send(line);
    }
  });
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    process.stdout.write(data.endsWith("\n") ? data : `${data}\n`);
  });
  let closing = false;
  const finish = new Promise<void>((resolve, reject) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.addEventListener("error", () => closing
      ? resolve()
      : reject(new Error("Codex 共享 App Server WebSocket 已断开")), { once: true });
    input.once("close", () => {
      if (socket.readyState === WebSocket.OPEN) {
        closing = true;
        socket.close();
      }
    });
  });
  await finish;
}

async function noteLocalCodexInput(dataDirectory: string, line: string): Promise<void> {
  let request: { method?: unknown; params?: { threadId?: unknown } };
  try {
    request = JSON.parse(line) as typeof request;
  } catch {
    return;
  }
  if (request.method !== "turn/start" || typeof request.params?.threadId !== "string") return;
  try {
    const [descriptorText, token] = await Promise.all([
      fs.readFile(path.join(dataDirectory, "broker.json"), "utf8"),
      fs.readFile(path.join(dataDirectory, "broker-token"), "utf8")
    ]);
    const descriptor = JSON.parse(descriptorText) as { port?: unknown };
    if (typeof descriptor.port !== "number") return;
    await fetch(`http://127.0.0.1:${descriptor.port}/local-activity`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: request.params.threadId, leaseMs: 30_000 }),
      signal: AbortSignal.timeout(1_000)
    });
  } catch {
    // The bridge remains fail-open when Agent Link is not running.
  }
}

async function runFallback(
  mode: "codex" | "claude",
  executable: string,
  args: string[],
  error: unknown,
  detectClaudeWrapper = false
): Promise<void> {
  const wrappedClaudeExecutable = detectClaudeWrapper
    && mode === "claude"
    && args[0]
    && !args[0].startsWith("-")
    && await isFile(args[0])
    ? args[0]
    : undefined;
  const fallbackExecutable = wrappedClaudeExecutable ?? executable;
  const fallbackArgs = wrappedClaudeExecutable ? args.slice(1) : args;
  process.stderr.write(
    `Feishu Agent ${mode} bridge unavailable; starting the original Agent without remote injection: ${errorMessage(error)}\n`
  );
  process.exitCode = await runInherited(fallbackExecutable, fallbackArgs, process.env);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInteractiveCodexInvocation(args: string[]): boolean {
  if (args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-V")) {
    return false;
  }
  const commands = new Set([
    "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
    "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "apply",
    "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help"
  ]);
  const command = codexCommand(args);
  return !command || !commands.has(command);
}

function codexCommand(args: string[]): string | undefined {
  const optionsWithValues = new Set([
    "-c", "--config", "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
    "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval", "--remote",
    "--remote-auth-token-env"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      return args[index + 1];
    }
    if (value.startsWith("-")) {
      if (!value.includes("=") && optionsWithValues.has(value)) {
        index += 1;
      }
      continue;
    }
    return value;
  }
  return undefined;
}

function isClaudeSessionInvocation(args: string[]): boolean {
  if (args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v")) {
    return false;
  }
  const commands = new Set([
    "agents", "auth", "auto-mode", "doctor", "gateway", "import", "install", "mcp",
    "plugin", "plugins", "project", "setup-token", "ultrareview", "update", "upgrade"
  ]);
  return !args.some((value) => !value.startsWith("-") && commands.has(value));
}

function hasOption(args: string[], option: string): boolean {
  return args.some((value) => value === option || value.startsWith(`${option}=`));
}

function hasOptionValue(args: string[], option: string, expected: string): boolean {
  return args.some((value, index) => (value === option && args[index + 1] === expected) || value === `${option}=${expected}`);
}

async function runInherited(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      env,
      windowsHide: process.platform === "win32" && env.FEISHU_AGENT_BRIDGE_HIDE_WINDOW === "1"
    });
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const forwardInterrupt = (): void => forwardSignal("SIGINT");
    const forwardTerminate = (): void => forwardSignal("SIGTERM");
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTerminate);
    child.once("error", reject);
    child.once("close", (code) => {
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardTerminate);
      resolve(code ?? 1);
    });
  });
}

async function readConfig(filePath: string): Promise<BridgeConfig> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<BridgeConfig>;
  if (value.protocolVersion !== 1
    || typeof value.dataDirectory !== "string"
    || typeof value.realExecutable !== "string"
    || typeof value.runtimePath !== "string"
    || typeof value.claudeChannelScript !== "string") {
    throw new Error(`进程桥接配置无效：${filePath}`);
  }
  return value as BridgeConfig;
}

async function isFile(filePath: string): Promise<boolean> {
  return (await fs.stat(filePath).catch(() => undefined))?.isFile() === true;
}
