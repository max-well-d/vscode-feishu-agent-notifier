import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentReplyResult, ManagedCodexExecutor } from "./agentReply";
import { BrokerCompletion, BrokerDescriptor, BrokerSnapshot, BrokerTurnResult } from "./brokerProtocol";
import { ClaudeChannelEvent, ClaudeChannelOutbound } from "./brokerProtocol";
import { AppServerState } from "./codexAppServer";
import { CodexThreadMetadata } from "./codexAppServer";
import { AgentSession, RemoteExecutionPolicy } from "./types";

export interface SessionBrokerClientOptions {
  dataDirectory: string;
  brokerScript: string;
  executable: () => Promise<string | undefined>;
  version: () => string;
  startTimeoutMs?: number;
  onState?: () => void;
  log?: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export class SessionBrokerClient implements ManagedCodexExecutor {
  private token: string | undefined;
  private descriptor: BrokerDescriptor | undefined;
  private snapshot: BrokerSnapshot | undefined;
  private starting: Promise<void> | undefined;
  private _lastError: string | undefined;

  public constructor(private readonly options: SessionBrokerClientOptions) {}

  public get state(): AppServerState {
    if (this._lastError) {
      return "failed";
    }
    return this.snapshot?.codexState ?? (this.descriptor ? "stopped" : "stopped");
  }

  public get brokerState(): "stopped" | "starting" | "ready" | "failed" {
    if (this.starting) {
      return "starting";
    }
    if (this._lastError) {
      return "failed";
    }
    return this.descriptor ? "ready" : "stopped";
  }

  public get lastError(): string | undefined {
    return this._lastError ?? this.snapshot?.codexError;
  }

  public get activeCount(): number {
    return this.snapshot?.activeTurns ?? 0;
  }

  public get lastSnapshot(): BrokerSnapshot | undefined {
    return this.snapshot;
  }

  public async refresh(): Promise<BrokerSnapshot> {
    await this.ensureStarted();
    const snapshot = await this.call<BrokerSnapshot>("GET", "/health");
    this.snapshot = snapshot;
    this._lastError = undefined;
    return snapshot;
  }

  public async startThread(
    cwd: string,
    project: string,
    policy: RemoteExecutionPolicy,
    name?: string
  ): Promise<AgentSession> {
    return this.call("POST", "/threads/start", { cwd, project, policy, name });
  }

  public async forkThread(
    source: AgentSession,
    sourceTurnId: string,
    policy: RemoteExecutionPolicy
  ): Promise<AgentSession> {
    return this.call("POST", "/threads/fork", { source, sourceTurnId, policy });
  }

  public async adoptThread(source: AgentSession, policy: RemoteExecutionPolicy): Promise<AgentSession> {
    return this.call("POST", "/threads/adopt", { source, policy });
  }

  public async readThreadMetadata(threadId: string): Promise<CodexThreadMetadata> {
    return this.call("GET", `/threads/${encodeURIComponent(threadId)}/metadata`);
  }

  public async runTurn(
    session: AgentSession,
    prompt: string,
    policy: RemoteExecutionPolicy,
    signal: AbortSignal,
    timeoutMs: number,
    origin: "local" | "feishu" = "feishu"
  ): Promise<AgentReplyResult> {
    const onAbort = (): void => {
      void this.interruptSession(session.sessionId).catch(() => false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.call<BrokerTurnResult>("POST", "/turn", {
      session,
      prompt,
      policy,
      origin,
      timeoutMs
      }, signal, timeoutMs + 30_000);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  public async steer(session: AgentSession, prompt: string): Promise<string> {
    const result = await this.call<{ turnId: string }>("POST", "/steer", { session, prompt });
    return result.turnId;
  }

  public async interruptSession(sessionId: string): Promise<boolean> {
    const result = await this.call<{ interrupted: boolean }>("POST", "/interrupt", { sessionId });
    return result.interrupted;
  }

  public async noteLocalActivity(sessionId: string, leaseMs = 15_000): Promise<void> {
    await this.call("POST", "/local-activity", { sessionId, leaseMs });
  }

  public async setRemoteContext(sessionId: string, chatId: string, inboundMessageId: string): Promise<void> {
    await this.call("POST", "/remote-context", { sessionId, chatId, inboundMessageId });
  }

  public async runClaudeChannelTurn(
    session: AgentSession,
    prompt: string,
    chatId: string,
    inboundMessageId: string,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<AgentReplyResult> {
    const startedAt = Date.now();
    const channelId = session.channelId ?? session.sessionId;
    await this.call<ClaudeChannelEvent>("POST", `/claude/channels/${encodeURIComponent(channelId)}/enqueue`, {
      prompt,
      chatId,
      inboundMessageId,
      session
    });
    while (!signal.aborted && Date.now() - startedAt < timeoutMs) {
      const outbound = await this.call<ClaudeChannelOutbound & { empty?: boolean }>(
        "GET",
        `/claude/channels/${encodeURIComponent(channelId)}/outbound/next`,
        undefined,
        signal,
        30_000
      );
      if (!outbound.empty && outbound.text && outbound.chatId === chatId) {
        return {
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          outputTail: outbound.text,
          backend: "cli"
        };
      }
    }
    throw new Error(signal.aborted ? "Claude Channel 任务已取消" : "等待 Claude Channel 回复超时");
  }

  public async claudeInputOrigin(channelId: string): Promise<"local" | "feishu"> {
    const result = await this.call<{ inputOrigin: "local" | "feishu" }>(
      "GET",
      `/claude/channels/${encodeURIComponent(channelId)}/state`
    );
    return result.inputOrigin;
  }

  public async takeCompletion(): Promise<BrokerCompletion | undefined> {
    const result = await this.call<BrokerCompletion & { empty?: boolean }>("GET", "/completions/next");
    return result.empty ? undefined : result;
  }

  public async acknowledgeCompletion(completionId: string): Promise<void> {
    await this.call("POST", `/completions/${encodeURIComponent(completionId)}/ack`, {});
  }

  public async releaseUnknownTurn(sessionId: string): Promise<void> {
    await this.call("POST", "/takeover", { sessionId });
  }

  public async resolveApproval(
    approvalId: string,
    decision: "accept" | "decline",
    origin: "local" | "feishu"
  ): Promise<void> {
    await this.call("POST", `/approvals/${encodeURIComponent(approvalId)}`, { decision, origin });
  }

  /** Disconnect only. The daemon and its Codex subprocess deliberately survive. */
  public dispose(): void {
    this.descriptor = undefined;
    this.snapshot = undefined;
  }

  private ensureStarted(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.connectOrStart().finally(() => {
      this.starting = undefined;
      this.options.onState?.();
    });
    return this.starting;
  }

  private async connectOrStart(): Promise<void> {
    await fs.mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
    this.token = await readOrCreateToken(path.join(this.options.dataDirectory, "broker-token"));
    const descriptorPath = path.join(this.options.dataDirectory, "broker.json");
    const existing = await readDescriptor(descriptorPath);
    if (existing) {
      this.descriptor = existing;
      try {
        this.snapshot = await this.call<BrokerSnapshot>("GET", "/health", undefined, undefined, 2_000, false);
        this._lastError = undefined;
        return;
      } catch {
        if (processIsAlive(existing.pid)) {
          throw new Error(`Session Broker 进程 ${existing.pid} 存在，但健康检查失败`);
        }
        this.descriptor = undefined;
        await fs.rm(descriptorPath, { force: true });
        await fs.rm(path.join(this.options.dataDirectory, "broker.lock"), { force: true });
      }
    }
    const executable = await this.options.executable();
    const child = spawn(process.execPath, [
      this.options.brokerScript,
      "--data-dir", this.options.dataDirectory,
      "--codex", executable ?? "",
      "--version", this.options.version()
    ], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    child.unref();
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 10_000);
    let lastError: Error | undefined;
    while (Date.now() < deadline) {
      await delay(100);
      const descriptor = await readDescriptor(descriptorPath);
      if (!descriptor) {
        continue;
      }
      this.descriptor = descriptor;
      try {
        this.snapshot = await this.call<BrokerSnapshot>("GET", "/health", undefined, undefined, 1_000, false);
        this._lastError = undefined;
        this.options.log?.info(`Session Broker 已就绪（PID ${descriptor.pid}）。`);
        return;
      } catch (error) {
        lastError = error as Error;
      }
    }
    this._lastError = lastError?.message ?? "Session Broker 启动超时";
    throw new Error(this._lastError);
  }

  private async call<T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs = 20_000,
    start = true
  ): Promise<T> {
    if (start) {
      await this.ensureStarted();
    }
    if (!this.descriptor || !this.token) {
      throw new Error("Session Broker 未连接");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`http://127.0.0.1:${this.descriptor.port}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const value = text ? JSON.parse(text) as Record<string, unknown> : {};
      if (!response.ok) {
        throw new Error(typeof value.error === "string" ? value.error : `Broker HTTP ${response.status}`);
      }
      return value as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function readOrCreateToken(filePath: string): Promise<string> {
  try {
    const existing = (await fs.readFile(filePath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Create below.
  }
  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  return token;
}

async function readDescriptor(filePath: string): Promise<BrokerDescriptor | undefined> {
  try {
    const descriptor = JSON.parse(await fs.readFile(filePath, "utf8")) as BrokerDescriptor;
    return descriptor.protocolVersion === 1 && descriptor.port > 0 ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
