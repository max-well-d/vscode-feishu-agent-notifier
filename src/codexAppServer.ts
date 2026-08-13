import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { AgentReplyResult } from "./agentReply";
import { ensureSharedCodexServer } from "./codexSharedServer";
import { AgentSession, RemoteExecutionPolicy } from "./types";

type JsonObject = Record<string, unknown>;
export type AppServerState = "stopped" | "starting" | "ready" | "failed";

export type CodexApprovalDecision = "accept" | "decline";

export interface CodexApprovalRequest {
  id: number;
  method: string;
  params: JsonObject;
}

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve(turn: JsonObject): void;
  reject(error: Error): void;
}

export interface CodexAppServerOptions {
  executable: () => Promise<string | undefined>;
  version: () => string;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
  sharedDataDirectory?: string;
  log?: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  onState?: (state: AppServerState, detail?: string) => void;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
}

export interface CodexThreadMetadata {
  id: string;
  name?: string;
  preview?: string;
  forkedFromId?: string;
}

/**
 * A single-owner stdio client for Codex App Server. It intentionally does not
 * expose a network listener: Feishu and VS Code submit work through this one
 * process, so two independent `codex exec resume` processes cannot race.
 */
export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private reader: readline.Interface | undefined;
  private starting: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completedTurns = new Map<string, JsonObject>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnMessages = new Map<string, string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly ownedTurns = new Map<string, string>();
  private readonly loadedThreads = new Set<string>();
  private readonly metadataCache = new Map<string, { value: CodexThreadMetadata; cachedAt: number }>();
  private disposed = false;
  private _state: AppServerState = "stopped";
  private _lastError: string | undefined;

  public constructor(private readonly options: CodexAppServerOptions) {}

  public get state(): AppServerState {
    return this._state;
  }

  public get lastError(): string | undefined {
    return this._lastError;
  }

  public get activeCount(): number {
    return this.activeTurns.size;
  }

  public ensureReady(): Promise<void> {
    return this.ensureStarted();
  }

  public async threadStatus(threadId: string): Promise<string> {
    await this.ensureStarted();
    return this.readThreadStatus(threadId);
  }

  public async startThread(
    cwd: string,
    project: string,
    policy: RemoteExecutionPolicy,
    name?: string
  ): Promise<AgentSession> {
    await this.ensureStarted();
    const result = await this.request("thread/start", {
      cwd,
      approvalPolicy: policy === "inherit" ? "on-request" : "never",
      ...(policy === "planOnly" ? { sandbox: "read-only" } : {}),
      serviceName: "feishu_agent_notifier"
    });
    const thread = objectValue(result.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) {
      throw new Error("Codex App Server 未返回 thread.id");
    }
    const persistedName = cleanThreadName(name) || stringValue(thread?.name) || undefined;
    if (persistedName && persistedName !== stringValue(thread?.name)) {
      await this.request("thread/name/set", { threadId, name: persistedName });
    }
    this.loadedThreads.add(threadId);
    this.metadataCache.set(threadId, {
      value: { id: threadId, name: persistedName, preview: stringValue(thread?.preview) || undefined },
      cachedAt: Date.now()
    });
    return {
      source: "codex",
      sessionId: threadId,
      cwd,
      project,
      lastSeenAt: new Date().toISOString(),
      status: "completed",
      name: persistedName,
      ownership: "managed",
      completionEvidence: "authoritative",
      managedBackend: "codex-app-server"
    };
  }

  public async forkThread(
    source: AgentSession,
    sourceTurnId: string,
    policy: RemoteExecutionPolicy
  ): Promise<AgentSession> {
    await this.ensureStarted();
    if (!sourceTurnId) {
      throw new Error("缺少被引用完成消息的 turnId");
    }
    const metadata = await this.readThreadMetadata(source.sessionId).catch(() => undefined);
    const result = await this.request("thread/fork", {
      threadId: source.sessionId,
      lastTurnId: sourceTurnId,
      cwd: source.cwd,
      approvalPolicy: policy === "inherit" ? "on-request" : "never",
      ...(policy === "planOnly" ? { sandbox: "read-only" } : {}),
      ephemeral: false,
      excludeTurns: true,
      deferGoalContinuation: true
    });
    const thread = objectValue(result.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) {
      throw new Error("Codex App Server 未返回分支 thread.id");
    }
    const sourceName = source.alias || source.name || metadata?.name || stringValue(thread?.name) || source.project;
    const name = remoteForkName(sourceName, threadId);
    try {
      await this.request("thread/name/set", { threadId, name });
    } catch (error) {
      this.options.log?.warn(`持久化 Codex 分支名称失败：${(error as Error).message}`);
    }
    this.loadedThreads.add(threadId);
    this.metadataCache.set(threadId, {
      value: {
        id: threadId,
        name,
        preview: stringValue(thread?.preview) || metadata?.preview,
        forkedFromId: source.sessionId
      },
      cachedAt: Date.now()
    });
    return {
      source: "codex",
      sessionId: threadId,
      cwd: source.cwd,
      project: source.project,
      lastSeenAt: new Date().toISOString(),
      status: "completed",
      name,
      ownership: "managed",
      completionEvidence: "authoritative",
      managedBackend: "codex-app-server",
      lastCompletedTurnId: sourceTurnId,
      forkedFromSessionId: source.sessionId,
      forkedFromTurnId: sourceTurnId
    };
  }

  public async adoptThread(source: AgentSession, policy: RemoteExecutionPolicy): Promise<AgentSession> {
    await this.ensureStarted();
    const thread = await this.attachOrResumeThread(source, policy);
    const threadId = stringValue(thread?.id);
    if (!threadId || threadId !== source.sessionId) {
      throw new Error("Codex App Server 无法无损接管原会话");
    }
    this.loadedThreads.add(threadId);
    const name = source.alias || source.name || stringValue(thread?.name) || source.project;
    this.metadataCache.set(threadId, {
      value: { id: threadId, name, preview: stringValue(thread?.preview) || undefined },
      cachedAt: Date.now()
    });
    return {
      ...source,
      sessionId: threadId,
      name,
      lastSeenAt: new Date().toISOString(),
      ownership: "managed",
      completionEvidence: "authoritative",
      managedBackend: "codex-app-server"
    };
  }

  public async readThreadMetadata(threadId: string): Promise<CodexThreadMetadata> {
    const cached = this.metadataCache.get(threadId);
    if (cached && Date.now() - cached.cachedAt < 30_000) {
      return cached.value;
    }
    await this.ensureStarted();
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = objectValue(result.thread);
    const id = stringValue(thread?.id);
    if (!id) {
      throw new Error("Codex App Server 未返回 thread 元数据");
    }
    const value: CodexThreadMetadata = {
      id,
      name: stringValue(thread?.name) || undefined,
      preview: stringValue(thread?.preview) || undefined,
      forkedFromId: stringValue(thread?.forkedFromId) || undefined
    };
    this.metadataCache.set(id, { value, cachedAt: Date.now() });
    return value;
  }

  public async runTurn(
    session: AgentSession,
    prompt: string,
    policy: RemoteExecutionPolicy,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<AgentReplyResult> {
    if (session.ownership !== "managed" || session.managedBackend !== "codex-app-server") {
      throw new Error("拒绝直接执行未接管的外部 Codex 会话；请先无损接入共享服务，或创建安全分支");
    }
    const startedAt = Date.now();
    await this.ensureThread(session, policy);
    const status = await this.readThreadStatus(session.sessionId);
    if (status === "active") {
      throw new Error("托管 Codex 会话仍在运行；请等待完成，或使用 /steer 追加指令");
    }
    if (signal.aborted) {
      throw new Error("远程 Agent 回复已取消");
    }

    const start = await this.request("turn/start", {
      threadId: session.sessionId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: policy === "inherit" ? "on-request" : "never",
      ...(policy === "planOnly"
        ? { sandboxPolicy: { type: "readOnly", networkAccess: false } }
        : {})
    });
    const turn = objectValue(start.turn);
    const turnId = stringValue(turn?.id);
    if (!turnId) {
      throw new Error("Codex App Server 未返回 turn.id");
    }
    this.activeTurns.set(session.sessionId, turnId);
    this.ownedTurns.set(session.sessionId, turnId);

    let timeout: NodeJS.Timeout | undefined;
    const polling = new AbortController();
    const onAbort = (): void => {
      void this.interrupt(session.sessionId, turnId);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const completion = this.waitForTurn(turnId);
      const recoveredCompletion = this.pollTurnUntilTerminal(session.sessionId, turnId, polling.signal);
      const timed = new Promise<JsonObject>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void this.interrupt(session.sessionId, turnId);
          reject(new Error(`远程 Agent 回复超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已终止`));
        }, timeoutMs);
        timeout.unref();
      });
      const finished = await Promise.race([completion, recoveredCompletion, timed]);
      const statusValue = stringValue(finished.status);
      if (signal.aborted || statusValue === "interrupted") {
        throw new Error("远程 Agent 回复已取消");
      }
      if (statusValue !== "completed") {
        const error = objectValue(finished.error);
        throw new Error(stringValue(error?.message) || `Codex turn 状态：${statusValue || "unknown"}`);
      }
      return {
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        outputTail: this.turnMessages.get(turnId) ?? "",
        sessionId: session.sessionId,
        turnId,
        backend: "codex-app-server"
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      polling.abort();
      signal.removeEventListener("abort", onAbort);
      if (this.activeTurns.get(session.sessionId) === turnId) {
        this.activeTurns.delete(session.sessionId);
      }
      if (this.ownedTurns.get(session.sessionId) === turnId) {
        this.ownedTurns.delete(session.sessionId);
      }
      this.turnWaiters.delete(turnId);
      this.completedTurns.delete(turnId);
      this.turnMessages.delete(turnId);
    }
  }

  public async steer(session: AgentSession, prompt: string): Promise<string> {
    await this.ensureStarted();
    const turnId = this.ownedTurns.get(session.sessionId);
    if (!turnId) {
      throw new Error("该托管 Codex 会话当前没有运行中的 turn");
    }
    await this.request("turn/steer", {
      threadId: session.sessionId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: prompt }]
    });
    return turnId;
  }

  public async interruptSession(sessionId: string): Promise<boolean> {
    const turnId = this.ownedTurns.get(sessionId);
    if (!turnId) {
      return false;
    }
    await this.interrupt(sessionId, turnId);
    return true;
  }

  public dispose(): void {
    this.disposed = true;
    this.reader?.close();
    this.reader = undefined;
    this.process?.kill();
    this.process = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.rejectAll(new Error("Codex App Server 已停止"));
    this.loadedThreads.clear();
    this.activeTurns.clear();
    this.ownedTurns.clear();
    this.metadataCache.clear();
    this.setState("stopped");
  }

  private async ensureThread(session: AgentSession, policy: RemoteExecutionPolicy): Promise<void> {
    await this.ensureStarted();
    if (this.loadedThreads.has(session.sessionId)) {
      return;
    }
    await this.attachOrResumeThread(session, policy);
  }

  /**
   * Reuse a thread already loaded by the shared App Server. `thread/resume` is
   * only valid for a persisted thread that is not currently loaded; issuing it
   * for the live VS Code thread attempts to create a second writer.
   */
  private async attachOrResumeThread(
    session: Pick<AgentSession, "sessionId" | "cwd">,
    policy: RemoteExecutionPolicy
  ): Promise<JsonObject> {
    const read = await this.request("thread/read", {
      threadId: session.sessionId,
      includeTurns: false
    });
    const existing = objectValue(read.thread);
    const status = stringValue(objectValue(existing?.status)?.type);
    if (stringValue(existing?.id) === session.sessionId && status && status !== "notLoaded") {
      this.loadedThreads.add(session.sessionId);
      return existing as JsonObject;
    }

    const resumed = await this.request("thread/resume", {
      threadId: session.sessionId,
      cwd: session.cwd,
      approvalPolicy: policy === "inherit" ? "on-request" : "never",
      ...(policy === "planOnly" ? { sandbox: "read-only" } : {})
    });
    const thread = objectValue(resumed.thread);
    if (stringValue(thread?.id) !== session.sessionId) {
      throw new Error("Codex App Server returned a different thread while attaching the shared session");
    }
    this.loadedThreads.add(session.sessionId);
    return thread as JsonObject;
  }

  private async readThreadStatus(threadId: string): Promise<string> {
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = objectValue(result.thread);
    const status = objectValue(thread?.status);
    return stringValue(status?.type) || "unknown";
  }

  private async pollTurnUntilTerminal(
    threadId: string,
    turnId: string,
    signal: AbortSignal
  ): Promise<JsonObject> {
    while (!signal.aborted) {
      await delay(750, signal);
      if (signal.aborted) {
        break;
      }
      const result = await this.request("thread/read", { threadId, includeTurns: true });
      const thread = objectValue(result.thread);
      const turns = arrayValue(thread?.turns);
      const turn = turns.map(objectValue).find((candidate) => stringValue(candidate?.id) === turnId);
      if (!turn) {
        continue;
      }
      const status = stringValue(turn.status);
      if (status === "inProgress" || status === "pending" || status === "running") {
        continue;
      }
      const message = lastAgentMessage(turn);
      if (message) {
        this.turnMessages.set(turnId, message);
      }
      this.options.log?.warn(`Recovered terminal Codex turn ${turnId} from thread/read after a missed notification.`);
      return turn;
    }
    return new Promise<JsonObject>(() => undefined);
  }

  private async interrupt(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch (error) {
      this.options.log?.warn(`Codex turn 取消失败：${(error as Error).message}`);
    }
  }

  private waitForTurn(turnId: string): Promise<JsonObject> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      return Promise.resolve(completed);
    }
    return new Promise<JsonObject>((resolve, reject) => {
      this.turnWaiters.set(turnId, { resolve, reject });
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex App Server 客户端已释放"));
    }
    if ((this.process || this.socket?.readyState === WebSocket.OPEN) && this._state === "ready") {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startProcess().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    this.setState("starting");
    const executable = await this.options.executable();
    if (!executable) {
      this.setState("failed", "未找到 Codex CLI");
      throw new Error("未找到 Codex CLI；请在扩展设置中指定可执行文件路径");
    }
    if (this.options.sharedDataDirectory) {
      await this.startSharedConnection(executable);
      return;
    }
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(executable, ["app-server", "--stdio"], {
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.setState("failed", (error as Error).message);
      throw error;
    }
    this.process = child;
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.options.log?.debug(`Codex App Server: ${message}`);
      }
    });
    child.once("error", (error) => this.handleProcessEnd(new Error(`无法启动 Codex App Server：${error.message}`)));
    child.once("close", (code) => this.handleProcessEnd(new Error(`Codex App Server 已退出（${code ?? -1}）`)));

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "feishu_agent_notifier",
          title: "Feishu Agent Notifier",
          version: this.options.version()
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      });
      this.notify("initialized", {});
      this.setState("ready");
      this.options.log?.info("Codex App Server 托管执行器已就绪。");
    } catch (error) {
      child.kill();
      this.setState("failed", (error as Error).message);
      throw error;
    }
  }

  private async startSharedConnection(executable: string): Promise<void> {
    const descriptor = await ensureSharedCodexServer({
      dataDirectory: this.options.sharedDataDirectory as string,
      executable,
      appServerArgs: ["-c", "features.code_mode_host=true", "app-server"],
      startTimeoutMs: this.options.requestTimeoutMs,
      log: this.options.log
    });
    const socket = new WebSocket(descriptor.endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Codex 共享 App Server 超时")), this.options.requestTimeoutMs ?? 20_000);
      timer.unref();
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`无法连接 Codex 共享 App Server：${descriptor.endpoint}`));
      }, { once: true });
    });
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.handleLine(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleLine(Buffer.from(event.data).toString("utf8"));
      }
    });
    socket.addEventListener("close", () => this.handleProcessEnd(new Error("Codex 共享 App Server 连接已关闭")));
    socket.addEventListener("error", () => this.handleProcessEnd(new Error("Codex 共享 App Server 连接错误")));
    try {
      await this.initializeConnection();
      this.options.log?.info("Codex 共享 App Server 托管执行器已就绪。");
    } catch (error) {
      socket.close();
      this.socket = undefined;
      this.setState("failed", (error as Error).message);
      throw error;
    }
  }

  private async initializeConnection(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "feishu_agent_notifier",
        title: "Feishu Agent Notifier",
        version: this.options.version()
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify("initialized", {});
    this.setState("ready");
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 20_000;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  private send(message: JsonObject): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    const child = this.process;
    if (!child?.stdin.writable) {
      throw new Error("Codex App Server 未运行");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.options.log?.warn("忽略无法解析的 Codex App Server 输出。");
      return;
    }
    const id = numberValue(message.id);
    const method = stringValue(message.method);
    if (id !== undefined && !method) {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = objectValue(message.error);
      if (error) {
        pending.reject(new Error(stringValue(error.message) || "Codex App Server 请求失败"));
      } else {
        pending.resolve(objectValue(message.result) ?? {});
      }
      return;
    }
    if (id !== undefined && method) {
      void this.handleServerRequest(id, method, objectValue(message.params) ?? {});
      return;
    }
    if (method) {
      this.handleNotification(method, objectValue(message.params) ?? {});
    }
  }

  private async handleServerRequest(id: number, method: string, params: JsonObject): Promise<void> {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      let decision: CodexApprovalDecision = "decline";
      if (this.options.onApprovalRequest) {
        try {
          decision = await this.options.onApprovalRequest({ id, method, params });
        } catch (error) {
          this.options.log?.warn(`Codex 权限审批失败，已拒绝：${(error as Error).message}`);
        }
      }
      this.send({ id, result: { decision } });
      return;
    }
    this.send({ id, error: { code: -32601, message: `客户端不支持服务端请求：${method}` } });
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === "turn/started") {
      const turn = objectValue(params.turn);
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(turn?.id);
      if (threadId && turnId) {
        this.activeTurns.set(threadId, turnId);
      }
      return;
    }
    if (method === "item/completed") {
      const item = objectValue(params.item);
      const turnId = stringValue(params.turnId);
      if (turnId && item?.type === "agentMessage") {
        this.turnMessages.set(turnId, stringValue(item.text));
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = objectValue(params.turn) ?? {};
      const turnId = stringValue(turn.id);
      const threadId = stringValue(params.threadId);
      if (threadId && this.activeTurns.get(threadId) === turnId) {
        this.activeTurns.delete(threadId);
      }
      if (!turnId) {
        return;
      }
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        waiter.resolve(turn);
      } else {
        this.completedTurns.set(turnId, turn);
      }
    }
  }

  private handleProcessEnd(error: Error): void {
    if (this.process || this.socket) {
      this.process = undefined;
      this.socket = undefined;
      this.reader?.close();
      this.reader = undefined;
      this.loadedThreads.clear();
      this.activeTurns.clear();
      this.ownedTurns.clear();
      this.rejectAll(error);
    }
    if (!this.disposed) {
      this.setState("failed", error.message);
      this.options.log?.error(error.message);
    }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(error);
    }
    this.turnWaiters.clear();
    this.completedTurns.clear();
    this.turnMessages.clear();
  }

  private setState(state: AppServerState, detail?: string): void {
    this._state = state;
    this._lastError = state === "failed" ? detail : undefined;
    this.options.onState?.(state, detail);
  }
}

function cleanThreadName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? Array.from(trimmed).slice(0, 80).join("") : undefined;
}

function remoteForkName(value: string, threadId: string): string {
  const suffix = " · 飞书";
  const fallback = `远程会话 ${threadId.slice(0, 8)}`;
  const base = cleanThreadName(value) || fallback;
  return `${Array.from(base).slice(0, Math.max(1, 80 - Array.from(suffix).length)).join("")}${suffix}`;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function lastAgentMessage(turn: JsonObject): string {
  const items = arrayValue(turn.items).map(objectValue).filter((item): item is JsonObject => Boolean(item));
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].type === "agentMessage") {
      return stringValue(items[index].text);
    }
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
