import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { AgentSession, RemoteExecutionPolicy } from "./types";
import { agentSessionKey } from "./sessionRegistry";

export interface AgentReplyResult {
  exitCode: number;
  durationMs: number;
  outputTail: string;
}

export interface AgentReplyJob {
  id: string;
  chatId: string;
  inboundMessageId: string;
  session: AgentSession;
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
    private readonly executableResolver?: (source: "codex" | "claude-code") => Promise<string | undefined>
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
    const command = buildAgentCommand(job.session, job.policy);
    const resolvedExecutable = await this.executableResolver?.(job.session.source as "codex" | "claude-code");
    if (this.executableResolver && !resolvedExecutable) {
      const displayName = job.session.source === "codex" ? "Codex" : "Claude Code";
      throw new Error(`未找到 ${displayName} CLI；请在扩展设置中指定可执行文件路径`);
    }
    return runChildProcess(
      this.spawnImpl,
      resolvedExecutable ?? command.executable,
      command.args,
      job.session.cwd,
      job.prompt,
      signal,
      this.timeoutMs
    );
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

  public enqueue(input: Omit<AgentReplyJob, "id">): EnqueueResult {
    if (this.pending.length >= this.maximumPending) {
      throw new Error(`远程回复队列已满（最多 ${this.maximumPending} 条）`);
    }
    const job: AgentReplyJob = { ...input, id: crypto.randomUUID() };
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
        item.reject(new Error("任务已由飞书用户取消"));
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

  public dispose(): void {
    this.cancelAll();
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
    try {
      await this.callbacks.waitUntilReady?.(item.job, item.controller.signal);
      await this.callbacks.onStarted?.(item.job);
      const result = await this.runner.run(item.job, item.controller.signal);
      item.resolve(result);
      await this.callbacks.onFinished?.(item.job, result);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      item.reject(normalized);
      await this.callbacks.onFinished?.(item.job, normalized);
    }
  }
}

export function buildAgentCommand(
  session: AgentSession,
  policy: RemoteExecutionPolicy
): { executable: string; args: string[] } {
  if (session.source === "codex") {
    const args = ["exec"];
    if (policy === "planOnly") {
      args.push("--sandbox", "read-only");
    }
    args.push("--json");
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
    }
    if (policy === "planOnly") {
      args.push("--permission-mode", "plan");
    }
    return { executable: process.platform === "win32" ? "claude.exe" : "claude", args };
  }
  throw new Error(`不支持恢复 Agent：${session.source}`);
}

function sessionKey(session: AgentSession): string {
  return agentSessionKey(session.source, session.sessionId);
}

function runChildProcess(
  spawnImpl: typeof spawn,
  executable: string,
  args: string[],
  cwd: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number
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
        outputTail: compactOutput(output)
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

function compactOutput(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return Array.from(normalized).slice(-500).join("");
}
