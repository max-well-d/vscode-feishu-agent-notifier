import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { AgentSession, InputOrigin, RemoteExecutionPolicy } from "./types";
import { agentSessionKey } from "./sessionRegistry";

export interface AgentReplyResult {
  exitCode: number;
  durationMs: number;
  outputTail: string;
  sessionId?: string;
  turnId?: string;
  backend?: "codex-app-server" | "cli";
  completionId?: string;
}

export interface ManagedCodexExecutor {
  adoptThread?(
    source: AgentSession,
    policy: RemoteExecutionPolicy
  ): Promise<AgentSession>;
  forkThread(
    source: AgentSession,
    sourceTurnId: string,
    policy: RemoteExecutionPolicy
  ): Promise<AgentSession>;
  runTurn(
    session: AgentSession,
    prompt: string,
    policy: RemoteExecutionPolicy,
    signal: AbortSignal,
    timeoutMs: number,
    origin?: InputOrigin
  ): Promise<AgentReplyResult>;
  runClaudeChannelTurn?(
    session: AgentSession,
    prompt: string,
    chatId: string,
    inboundMessageId: string,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<AgentReplyResult>;
}

export interface AgentReplyJob {
  id: string;
  chatId: string;
  inboundMessageId: string;
  session: AgentSession;
  originalSession: AgentSession;
  anchorTurnId?: string;
  prompt: string;
  policy: RemoteExecutionPolicy;
}

export interface QueueCallbacks {
  waitUntilReady?: (job: AgentReplyJob, signal: AbortSignal) => Promise<void>;
  onStarted?: (job: AgentReplyJob) => Promise<void> | void;
  onFinished?: (job: AgentReplyJob, result: AgentReplyResult | Error) => Promise<void> | void;
}

export interface EnqueueResult {
  job: AgentReplyJob;
  position: number;
  completion: Promise<AgentReplyResult>;
}

interface PendingJob {
  job: AgentReplyJob;
  resolve: (result: AgentReplyResult) => void;
  reject: (error: Error) => void;
  controller: AbortController;
}

export class AgentReplyRunner {
  public constructor(
    private readonly timeoutMs = 30 * 60 * 1000,
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly executableResolver?: (source: "codex" | "claude-code") => Promise<string | undefined>,
    private readonly managedCodex?: ManagedCodexExecutor,
    private readonly onRemoteBranchCreated?: (job: AgentReplyJob, session: AgentSession) => Promise<void>,
    private readonly onSessionAdopted?: (job: AgentReplyJob, session: AgentSession) => Promise<void>
  ) {}

  public async run(job: AgentReplyJob, signal: AbortSignal): Promise<AgentReplyResult> {
    if (job.policy === "disabled") {
      throw new Error("远程回复已禁用");
    }
    if (!job.prompt.trim()) {
      throw new Error("回复内容不能为空");
    }
    if (Array.from(job.prompt).length > 8_000) {
      throw new Error("回复内容超过 8000 字符限制");
    }
    const stat = await fs.stat(job.session.cwd).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(`会话工作目录不可用：${job.session.cwd || "未记录"}`);
    }
    if (job.session.source === "codex"
      && job.session.ownership === "managed"
      && job.session.managedBackend === "codex-app-server") {
      if (!this.managedCodex) {
        throw new Error("Codex App Server 托管执行器未初始化");
      }
      // This session is already owned by the App Server shared with VS Code.
      // Never open a second CLI writer or silently fork it after a delivery error.
      return this.managedCodex.runTurn(job.session, job.prompt, job.policy, signal, this.timeoutMs, remoteOrigin(job.chatId));
    }
    if (job.session.source === "claude-code"
      && job.session.ownership === "managed"
      && job.session.managedBackend === "claude-channel") {
      if (!this.managedCodex?.runClaudeChannelTurn) {
        throw new Error("Claude Channel 执行器未初始化");
      }
      return this.managedCodex.runClaudeChannelTurn(
        job.session,
        job.prompt,
        job.chatId,
        job.inboundMessageId,
        signal,
        this.timeoutMs
      );
    }
    if (job.session.source === "codex" && job.session.ownership !== "managed") {
      return this.runExternalCodexBranch(job, signal);
    }
    const allowNonGitWorkspace = job.session.source === "codex"
      && job.session.ownership === "external"
      && job.session.completionEvidence === "authoritative"
      && !job.session.sessionId.startsWith("new:")
      && !await hasGitMetadataAncestor(job.session.cwd);
    const forkClaudeSession = shouldForkClaudeSession(job);
    const command = buildAgentCommand(job.session, job.policy, { allowNonGitWorkspace, forkClaudeSession });
    const resolvedExecutable = await this.executableResolver?.(job.session.source as "codex" | "claude-code");
    if (this.executableResolver && !resolvedExecutable) {
      const displayName = job.session.source === "codex" ? "Codex" : "Claude Code";
      throw new Error(`未找到 ${displayName} CLI；请在扩展设置中指定可执行文件路径`);
    }
    try {
      const result = await runChildProcess(
        this.spawnImpl,
        resolvedExecutable ?? command.executable,
        command.args,
        job.session.cwd,
        job.prompt,
        signal,
        this.timeoutMs,
        job.session.source
      );
      if (forkClaudeSession
        && result.sessionId
        && result.sessionId !== job.session.sessionId) {
        const forked = claudeRemoteBranch(job.originalSession, result.sessionId, job.anchorTurnId as string);
        await this.onRemoteBranchCreated?.(job, forked);
        Object.assign(job.session, forked);
      }
      return result;
    } catch (error) {
      return this.runForkFallback(job, normalizeError(error), signal);
    }
  }

  /**
   * Prefer adopting the exact thread in the shared App Server. Older clients
   * that still own a private writer fail adoption and fall back to an exact,
   * persistent fork anchored to the quoted completed turn.
   */
  private async runExternalCodexBranch(
    job: AgentReplyJob,
    signal: AbortSignal
  ): Promise<AgentReplyResult> {
    if (!this.managedCodex) {
      throw new Error("外部 Codex 会话需要共享 App Server 接管或安全分支；当前托管执行器不可用");
    }
    if (this.managedCodex.adoptThread) {
      let adopted: AgentSession | undefined;
      try {
        adopted = await this.managedCodex.adoptThread(job.originalSession, job.policy);
      } catch (error) {
        if (!job.anchorTurnId) {
          throw new Error(`无法无损接管原 Codex 会话，且完成通知没有精确 turnId：${normalizeError(error).message}`);
        }
      }
      if (adopted) {
        await this.onSessionAdopted?.(job, adopted);
        Object.assign(job.session, adopted);
        return this.managedCodex.runTurn(job.session, job.prompt, job.policy, signal, this.timeoutMs, remoteOrigin(job.chatId));
      }
    }
    if (!job.anchorTurnId) {
      throw new Error("为保护原 Codex 会话，远程续写必须引用包含精确 turnId 的完成通知");
    }
    let forked: AgentSession;
    try {
      forked = await this.managedCodex.forkThread(job.originalSession, job.anchorTurnId, job.policy);
      await this.onRemoteBranchCreated?.(job, forked);
    } catch (forkError) {
      throw new Error(`无法创建安全的 Codex 远程分支；原会话未被打开或占用：${normalizeError(forkError).message}`);
    }
    Object.assign(job.session, forked);
    return this.managedCodex.runTurn(job.session, job.prompt, job.policy, signal, this.timeoutMs, remoteOrigin(job.chatId));
  }

  private async runForkFallback(
    job: AgentReplyJob,
    error: Error,
    signal: AbortSignal
  ): Promise<AgentReplyResult> {
    if (job.session.source !== "codex" || !isCodexActiveWriterConflict(error)) {
      throw error;
    }
    if (!this.managedCodex) {
      throw new Error(`原 Codex 会话正被本机占用，且托管执行器不可用：${error.message}`);
    }
    if (!job.anchorTurnId) {
      throw new Error("原 Codex 会话正被本机占用；当前消息没有精确 turnId，无法安全创建远程分支。请引用 v0.14.0 之后的“已完成”卡片。");
    }
    let forked: AgentSession;
    try {
      forked = await this.managedCodex.forkThread(job.originalSession, job.anchorTurnId, job.policy);
      await this.onRemoteBranchCreated?.(job, forked);
    } catch (forkError) {
      throw new Error(`原 Codex 会话正被本机占用，创建持久化远程分支失败：${normalizeError(forkError).message}`);
    }
    Object.assign(job.session, forked);
    return this.managedCodex.runTurn(job.session, job.prompt, job.policy, signal, this.timeoutMs, remoteOrigin(job.chatId));
  }
}

export class AgentReplyQueue {
  private readonly pending: PendingJob[] = [];
  private readonly active = new Map<string, { pending: PendingJob; process: Promise<void> }>();

  public constructor(
    private readonly runner: AgentReplyRunner,
    private readonly maximumConcurrent = 1,
    private readonly callbacks: QueueCallbacks = {},
    private readonly maximumPending = 20
  ) {}

  public enqueue(input: Omit<AgentReplyJob, "id" | "originalSession">): EnqueueResult {
    if (this.pending.length >= this.maximumPending) {
      throw new Error(`远程回复队列已满（最多 ${this.maximumPending} 条）`);
    }
    const job: AgentReplyJob = {
      ...input,
      id: crypto.randomUUID(),
      originalSession: { ...input.session }
    };
    let resolve!: (result: AgentReplyResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<AgentReplyResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: PendingJob = { job, resolve, reject, controller: new AbortController() };
    this.pending.push(pending);
    const position = this.pending.length + this.active.size;
    this.pump();
    return { job, position, completion };
  }

  public cancelForChat(chatId: string): number {
    let cancelled = 0;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const item = this.pending[index];
      if (item.job.chatId === chatId) {
        this.pending.splice(index, 1);
        item.controller.abort();
        item.reject(new Error("任务已由远程 Channel 用户取消"));
        cancelled += 1;
      }
    }
    for (const { pending } of this.active.values()) {
      if (pending.job.chatId === chatId) {
        pending.controller.abort();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  public cancelAll(): number {
    let cancelled = 0;
    for (const item of this.pending.splice(0)) {
      item.controller.abort();
      item.reject(new Error("任务已取消"));
      cancelled += 1;
    }
    for (const { pending } of this.active.values()) {
      pending.controller.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  public get activeCount(): number {
    return this.active.size;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  public dispose(preserveBrokerTurns = false): void {
    for (const item of this.pending.splice(0)) {
      item.controller.abort();
      item.reject(new Error("任务已取消"));
    }
    for (const { pending } of this.active.values()) {
      const backend = pending.job.session.managedBackend;
      if (!preserveBrokerTurns || (backend !== "codex-app-server" && backend !== "claude-channel")) {
        pending.controller.abort();
      }
    }
  }

  private pump(): void {
    while (this.active.size < Math.max(1, this.maximumConcurrent)) {
      const index = this.pending.findIndex((candidate) => !this.active.has(sessionKey(candidate.job.session)));
      if (index < 0) {
        return;
      }
      const [item] = this.pending.splice(index, 1);
      const key = sessionKey(item.job.session);
      const process = this.execute(item).finally(() => {
        this.active.delete(key);
        this.pump();
      });
      this.active.set(key, { pending: item, process });
    }
  }

  private async execute(item: PendingJob): Promise<void> {
    let outcome: AgentReplyResult | Error;
    try {
      await this.callbacks.waitUntilReady?.(item.job, item.controller.signal);
      await this.callbacks.onStarted?.(item.job);
      const result = await this.runner.run(item.job, item.controller.signal);
      item.resolve(result);
      outcome = result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      item.reject(normalized);
      outcome = normalized;
    }
    try {
      await settleWithin(
        Promise.resolve(this.callbacks.onFinished?.(item.job, outcome)),
        15_000
      );
    } catch {
      // Completion delivery must never hold the execution queue indefinitely.
    }
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timeout = timer as unknown as NodeJS.Timeout;
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function buildAgentCommand(
  session: AgentSession,
  policy: RemoteExecutionPolicy,
  options: { allowNonGitWorkspace?: boolean; forkClaudeSession?: boolean } = {}
): { executable: string; args: string[] } {
  if (session.source === "codex") {
    const args = ["exec"];
    if (policy === "planOnly") {
      args.push("--sandbox", "read-only");
    }
    args.push("--json");
    if (options.allowNonGitWorkspace
      && session.ownership === "external"
      && session.completionEvidence === "authoritative"
      && !session.sessionId.startsWith("new:")) {
      args.push("--skip-git-repo-check");
    }
    if (session.sessionId.startsWith("new:")) {
      args.push("-");
    } else {
      args.push("resume", session.sessionId, "-");
    }
    return { executable: process.platform === "win32" ? "codex.exe" : "codex", args };
  }
  if (session.source === "claude-code") {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose"
    ];
    if (!session.sessionId.startsWith("new:")) {
      args.unshift("--resume", session.sessionId);
      if (options.forkClaudeSession) {
        args.push("--fork-session");
      }
    }
    if (policy === "planOnly") {
      args.push("--permission-mode", "plan");
    }
    return { executable: process.platform === "win32" ? "claude.exe" : "claude", args };
  }
  throw new Error(`不支持恢复 Agent：${session.source}`);
}

export function shouldForkClaudeSession(job: AgentReplyJob): boolean {
  return job.session.source === "claude-code"
    && job.session.ownership !== "managed"
    && job.session.completionEvidence === "authoritative"
    && Boolean(job.anchorTurnId);
}

function claudeRemoteBranch(source: AgentSession, sessionId: string, sourceTurnId: string): AgentSession {
  const sourceName = source.alias || source.name || source.project || "Claude Code";
  const suffix = " · 远程";
  const name = sourceName.endsWith(suffix) ? sourceName : `${sourceName}${suffix}`;
  return {
    ...source,
    sessionId,
    name,
    alias: undefined,
    lastSeenAt: new Date().toISOString(),
    status: "completed",
    ownership: "managed",
    completionEvidence: "authoritative",
    managedBackend: "claude-cli",
    forkedFromSessionId: source.sessionId,
    forkedFromTurnId: sourceTurnId
  };
}

export async function hasGitMetadataAncestor(cwd: string): Promise<boolean> {
  let current = path.resolve(cwd);
  while (true) {
    const gitMetadata = await fs.stat(path.join(current, ".git")).catch(() => undefined);
    if (gitMetadata) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function sessionKey(session: AgentSession): string {
  return agentSessionKey(session.source, session.sessionId);
}

function remoteOrigin(chatId: string): InputOrigin {
  const separator = chatId.indexOf(":");
  const channelId = separator > 0 ? chatId.slice(0, separator) : "feishu";
  return channelId === "feishu" ? "feishu" : `channel:${channelId}`;
}

function runChildProcess(
  spawnImpl: typeof spawn,
  executable: string,
  args: string[],
  cwd: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
  source: AgentSession["source"]
): Promise<AgentReplyResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let output = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(executable, args, {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 256_000) {
        output = output.slice(-256_000);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const terminate = (reason: string): void => {
      if (settled) {
        return;
      }
      child.kill();
      settled = true;
      reject(new Error(reason));
    };
    const timeout = setTimeout(() => terminate(`远程 Agent 回复超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已终止`), timeoutMs);
    timeout.unref();
    const onAbort = (): void => terminate("远程 Agent 回复已取消");
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`无法启动 ${executable}：${error.message}`));
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      const result: AgentReplyResult = {
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        outputTail: compactOutput(output),
        sessionId: source === "claude-code" ? extractClaudeSessionId(output) : undefined,
        turnId: source === "codex" ? extractCodexTurnId(output) : undefined,
        backend: "cli"
      };
      if (result.exitCode === 0) {
        resolve(result);
      } else {
        reject(new Error(`${executable} 退出码 ${result.exitCode}${result.outputTail ? `：${result.outputTail}` : ""}`));
      }
    });
    child.stdin.end(prompt, "utf8");
  });
}

export function extractClaudeSessionId(output: string): string | undefined {
  let sessionId: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const candidate = value.session_id ?? value.sessionId;
      if (typeof candidate === "string" && candidate.trim()) {
        sessionId = candidate.trim();
      }
    } catch {
      // Ignore non-JSON diagnostic lines emitted alongside stream-json.
    }
  }
  return sessionId;
}

export function extractCodexTurnId(output: string): string | undefined {
  let turnId: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const turn = typeof value.turn === "object" && value.turn !== null
        ? value.turn as Record<string, unknown>
        : undefined;
      const candidate = value.turn_id ?? value.turnId ?? turn?.id;
      if (typeof candidate === "string" && candidate.trim()) {
        turnId = candidate.trim();
      }
    } catch {
      // Ignore non-JSON diagnostics emitted alongside JSONL.
    }
  }
  return turnId;
}

export function isCodexActiveWriterConflict(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return /thread-store conflict/i.test(message)
    && /already has an active writer/i.test(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function compactOutput(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return Array.from(normalized).slice(-500).join("");
}
