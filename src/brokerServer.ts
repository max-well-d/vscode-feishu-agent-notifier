import crypto from "node:crypto";
import fs from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { CodexAppServerClient, CodexApprovalRequest } from "./codexAppServer";
import {
  BrokerApproval,
  BrokerCompletion,
  BrokerDescriptor,
  BROKER_PROTOCOL_VERSION,
  BrokerSnapshot,
  BrokerTurnRequest,
  ClaudeChannelEvent,
  ClaudeChannelOutbound
} from "./brokerProtocol";
import {
  completeTurn,
  HandoffState,
  initialHandoffState,
  markLocalActivity,
  requestRemoteTurn,
  restoreHandoffState,
  startTurn
} from "./handoff";
import { AgentSession, RemoteExecutionPolicy } from "./types";

interface BrokerOptions {
  dataDirectory: string;
  codexExecutable?: string;
  version: string;
}

interface PendingApproval {
  public: BrokerApproval;
  channelId?: string;
  settle(decision: "accept" | "decline"): void;
}

export async function runBroker(options: BrokerOptions): Promise<void> {
  const tokenPath = path.join(options.dataDirectory, "broker-token");
  const descriptorPath = path.join(options.dataDirectory, "broker.json");
  const statePath = path.join(options.dataDirectory, "broker-state.json");
  const completionsPath = path.join(options.dataDirectory, "broker-completions.json");
  const lockPath = path.join(options.dataDirectory, "broker.lock");
  await fs.mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireProcessLock(lockPath);
  const token = (await fs.readFile(tokenPath, "utf8")).trim();
  if (!token) {
    throw new Error("Broker token 为空");
  }
  const startedAt = new Date().toISOString();
  const handoffs = await loadHandoffs(statePath);
  const pendingApprovals = new Map<string, PendingApproval>();
  const completions = await loadCompletions(completionsPath);
  const claudeInbound = new Map<string, ClaudeChannelEvent[]>();
  const claudeOutbound = new Map<string, ClaudeChannelOutbound[]>();
  const claudeVerdicts = new Map<string, Array<{ requestId: string; behavior: "allow" | "deny" }>>();
  const claudeInputOrigins = new Map<string, "local" | "feishu">();
  const claudeSessions = new Map<string, AgentSession>();
  const remoteContexts = new Map<string, { chatId: string; inboundMessageId: string }>();
  let codexState: BrokerSnapshot["codexState"] = "stopped";
  let codexError: string | undefined;
  const codex = new CodexAppServerClient({
    executable: async () => options.codexExecutable,
    version: () => options.version,
    sharedDataDirectory: options.dataDirectory,
    onState: (state, detail) => {
      codexState = state;
      codexError = detail;
    },
    onApprovalRequest: (request) => waitForApproval(request, pendingApprovals, remoteContexts),
    onTurnStarted: (threadId, turnId, owned) => {
      if (owned) return;
      const state = startTurn(handoffs.get(threadId) ?? initialHandoffState(threadId), "local", turnId);
      handoffs.set(threadId, state);
      void persistHandoffs(statePath, handoffs);
    },
    onTurnCompleted: (threadId, turnId, owned) => {
      if (owned) return;
      const current = handoffs.get(threadId);
      if (!current || current.activeTurnId !== turnId) return;
      handoffs.set(threadId, completeTurn(current));
      void persistHandoffs(statePath, handoffs);
    }
  });

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      sendJson(response, 500, { error: (error as Error).message });
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Broker 未获得 TCP 端口");
  }
  const descriptor: BrokerDescriptor = {
    protocolVersion: BROKER_PROTOCOL_VERSION,
    pid: process.pid,
    port: address.port,
    startedAt,
    version: options.version
  };
  await atomicWriteJson(descriptorPath, descriptor);

  const shutdown = async (): Promise<void> => {
    server.close();
    codex.dispose();
    await fs.rm(descriptorPath, { force: true }).catch(() => undefined);
    await releaseLock();
  };
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, snapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      sendJson(response, 200, { ok: true });
      void shutdown().finally(() => process.exit(0));
      return;
    }
    if (request.method === "POST" && url.pathname === "/codex/reconnect") {
      await codex.ensureReady();
      sendJson(response, 200, { ready: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/threads/start") {
      const body = await readJson(request);
      const session = await codex.startThread(
        stringField(body, "cwd"),
        stringField(body, "project"),
        policyField(body),
        optionalString(body.name)
      );
      handoffs.set(session.sessionId, initialHandoffState(session.sessionId));
      await persistHandoffs(statePath, handoffs);
      sendJson(response, 200, session);
      return;
    }
    if (request.method === "POST" && url.pathname === "/threads/fork") {
      const body = await readJson(request);
      const session = await codex.forkThread(
        objectField(body, "source") as unknown as AgentSession,
        stringField(body, "sourceTurnId"),
        policyField(body)
      );
      handoffs.set(session.sessionId, initialHandoffState(session.sessionId));
      await persistHandoffs(statePath, handoffs);
      sendJson(response, 200, session);
      return;
    }
    if (request.method === "POST" && url.pathname === "/threads/adopt") {
      const body = await readJson(request);
      const session = await codex.adoptThread(
        objectField(body, "source") as unknown as AgentSession,
        policyField(body)
      );
      handoffs.set(session.sessionId, handoffs.get(session.sessionId) ?? initialHandoffState(session.sessionId));
      await persistHandoffs(statePath, handoffs);
      sendJson(response, 200, session);
      return;
    }
    const metadataMatch = /^\/threads\/([^/]+)\/metadata$/.exec(url.pathname);
    if (request.method === "GET" && metadataMatch) {
      const metadata = await codex.readThreadMetadata(decodeURIComponent(metadataMatch[1]));
      sendJson(response, 200, metadata);
      return;
    }
    if (request.method === "POST" && url.pathname === "/turn") {
      const body = await readJson(request) as unknown as BrokerTurnRequest;
      const session = body.session;
      if (session.ownership !== "managed" || session.managedBackend !== "codex-app-server") {
        sendJson(response, 409, {
          code: "EXTERNAL_SESSION_REQUIRES_FORK",
          error: "拒绝直接执行未接管的外部 Codex 会话；请先无损接入共享服务，或创建安全分支"
        });
        return;
      }
      let state = handoffs.get(session.sessionId) ?? initialHandoffState(session.sessionId);
      state = await reconcileHandoffState(session.sessionId, state, codex);
      handoffs.set(session.sessionId, state);
      if (body.origin !== "local") {
        const decision = requestRemoteTurn(state, new Date(), body.origin);
        state = decision.state;
        handoffs.set(session.sessionId, state);
        await persistHandoffs(statePath, handoffs);
        if (decision.action === "queue") {
          state = await waitForRemoteAuthority(session.sessionId, handoffs, statePath, request, codex);
        }
      } else if (state.authority === "remote" && state.turnState === "running") {
        sendJson(response, 409, { code: "REMOTE_ACTIVE", error: "远程 turn 正在运行，本地输入已暂停" });
        return;
      }
      const controller = new AbortController();
      state = startTurn(state, body.origin, `pending:${crypto.randomUUID()}`);
      handoffs.set(session.sessionId, state);
      await persistHandoffs(statePath, handoffs);
      try {
        const result = await codex.runTurn(
          session,
          body.prompt,
          body.policy,
          controller.signal,
          body.timeoutMs
        );
        state = completeTurn(handoffs.get(session.sessionId) ?? state);
        handoffs.set(session.sessionId, state);
        await persistHandoffs(statePath, handoffs);
        const context = remoteContexts.get(session.sessionId);
        const completionId = crypto.randomUUID();
        completions.push({
          id: completionId,
          event: {
            source: "codex",
            eventName: "turn/completed",
            status: "completed",
            eventId: result.turnId,
            origin: "hook",
            inputOrigin: body.origin,
            sessionId: session.sessionId,
            turnId: result.turnId ?? "",
            cwd: session.cwd,
            project: session.project,
            sessionName: session.alias || session.name,
            message: result.outputTail || "Codex turn 已完成，但没有文本输出。",
            occurredAt: new Date().toISOString()
          },
          chatId: context?.chatId,
          inboundMessageId: context?.inboundMessageId,
          createdAt: new Date().toISOString()
        });
        await persistCompletions(completionsPath, completions);
        sendJson(response, 200, { ...result, handoff: state, completionId });
      } catch (error) {
        state = completeTurn(handoffs.get(session.sessionId) ?? state);
        handoffs.set(session.sessionId, state);
        await persistHandoffs(statePath, handoffs);
        throw error;
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/completions/next") {
      sendJson(response, 200, completions[0] ?? { empty: true });
      return;
    }
    const completionAck = /^\/completions\/([^/]+)\/ack$/.exec(url.pathname);
    if (request.method === "POST" && completionAck) {
      const id = decodeURIComponent(completionAck[1]);
      const index = completions.findIndex((item) => item.id === id);
      if (index >= 0) {
        completions.splice(index, 1);
        await persistCompletions(completionsPath, completions);
      }
      sendJson(response, 200, { acknowledged: index >= 0 });
      return;
    }
    if (request.method === "POST" && url.pathname === "/steer") {
      const body = await readJson(request);
      const turnId = await codex.steer(objectField(body, "session") as unknown as AgentSession, stringField(body, "prompt"));
      sendJson(response, 200, { turnId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/interrupt") {
      const body = await readJson(request);
      const interrupted = await codex.interruptSession(stringField(body, "sessionId"));
      sendJson(response, 200, { interrupted });
      return;
    }
    if (request.method === "POST" && url.pathname === "/local-activity") {
      const body = await readJson(request);
      const sessionId = stringField(body, "sessionId");
      const current = handoffs.get(sessionId) ?? initialHandoffState(sessionId);
      const state = markLocalActivity(current, numberField(body, "leaseMs", 15_000));
      handoffs.set(sessionId, state);
      await persistHandoffs(statePath, handoffs);
      sendJson(response, 200, state);
      return;
    }
    if (request.method === "POST" && url.pathname === "/remote-context") {
      const body = await readJson(request);
      remoteContexts.set(stringField(body, "sessionId"), {
        chatId: stringField(body, "chatId"),
        inboundMessageId: stringField(body, "inboundMessageId")
      });
      sendJson(response, 200, { accepted: true });
      return;
    }
    const channelEnqueue = /^\/claude\/channels\/([^/]+)\/enqueue$/.exec(url.pathname);
    if (request.method === "POST" && channelEnqueue) {
      const channelId = decodeURIComponent(channelEnqueue[1]);
      const body = await readJson(request);
      const event: ClaudeChannelEvent = {
        id: crypto.randomUUID(),
        prompt: stringField(body, "prompt"),
        chatId: stringField(body, "chatId"),
        inboundMessageId: stringField(body, "inboundMessageId"),
        createdAt: new Date().toISOString()
      };
      const sessionValue = body.session;
      if (sessionValue && typeof sessionValue === "object" && !Array.isArray(sessionValue)) {
        claudeSessions.set(channelId, sessionValue as unknown as AgentSession);
      }
      const queue = claudeInbound.get(channelId) ?? [];
      queue.push(event);
      claudeInbound.set(channelId, queue);
      claudeInputOrigins.set(channelId, "feishu");
      sendJson(response, 200, event);
      return;
    }
    const channelNext = /^\/claude\/channels\/([^/]+)\/next$/.exec(url.pathname);
    if (request.method === "GET" && channelNext) {
      const channelId = decodeURIComponent(channelNext[1]);
      const event = await waitForClaudeInbound(channelId, claudeInbound, request);
      sendJson(response, 200, event ?? { empty: true });
      return;
    }
    const channelOutboundRoute = /^\/claude\/channels\/([^/]+)\/outbound$/.exec(url.pathname);
    if (request.method === "POST" && channelOutboundRoute) {
      const channelId = decodeURIComponent(channelOutboundRoute[1]);
      const body = await readJson(request);
      const event: ClaudeChannelOutbound = {
        id: crypto.randomUUID(),
        chatId: stringField(body, "chatId"),
        inboundMessageId: optionalString(body.inboundMessageId),
        text: stringField(body, "text"),
        createdAt: new Date().toISOString()
      };
      const queue = claudeOutbound.get(channelId) ?? [];
      queue.push(event);
      claudeOutbound.set(channelId, queue);
      const session = claudeSessions.get(channelId);
      if (session) {
        completions.push({
          id: crypto.randomUUID(),
          event: {
            source: "claude-code",
            eventName: "channel/reply",
            status: "completed",
            eventId: event.id,
            origin: "hook",
            inputOrigin: "feishu",
            channelId,
            sessionId: session.sessionId,
            turnId: event.inboundMessageId ?? event.id,
            cwd: session.cwd,
            project: session.project,
            sessionName: session.alias || session.name,
            message: event.text,
            occurredAt: event.createdAt
          },
          chatId: event.chatId,
          inboundMessageId: event.inboundMessageId,
          createdAt: event.createdAt
        });
        await persistCompletions(completionsPath, completions);
      }
      sendJson(response, 200, event);
      return;
    }
    const channelOutboundNext = /^\/claude\/channels\/([^/]+)\/outbound\/next$/.exec(url.pathname);
    if (request.method === "GET" && channelOutboundNext) {
      const channelId = decodeURIComponent(channelOutboundNext[1]);
      const event = await waitForClaudeOutbound(channelId, claudeOutbound, request);
      sendJson(response, 200, event ?? { empty: true });
      return;
    }
    const channelState = /^\/claude\/channels\/([^/]+)\/state$/.exec(url.pathname);
    if (request.method === "GET" && channelState) {
      const channelId = decodeURIComponent(channelState[1]);
      sendJson(response, 200, { inputOrigin: claudeInputOrigins.get(channelId) ?? "local" });
      return;
    }
    const channelApproval = /^\/claude\/channels\/([^/]+)\/approval$/.exec(url.pathname);
    if (request.method === "POST" && channelApproval) {
      const channelId = decodeURIComponent(channelApproval[1]);
      const body = await readJson(request);
      const approvalId = stringField(body, "requestId");
      if (body.mode === "request") {
        const existing = pendingApprovals.get(approvalId);
        if (!existing) {
          const expiry = setTimeout(() => pendingApprovals.delete(approvalId), 5 * 60_000);
          expiry.unref();
          pendingApprovals.set(approvalId, {
            channelId,
            public: {
              approvalId,
              sessionId: `channel:${channelId}`,
              chatId: optionalString(body.chatId),
              inboundMessageId: optionalString(body.inboundMessageId),
              source: "claude-code",
              kind: optionalString(body.toolName) === "Write" ? "file-change" : "command",
              summary: `${optionalString(body.toolName) ?? "Tool"}: ${optionalString(body.description) ?? optionalString(body.inputPreview) ?? "请求权限"}`.slice(0, 500),
              createdAt: new Date().toISOString()
            },
            settle: () => clearTimeout(expiry)
          });
        }
        sendJson(response, 200, { accepted: true });
      } else {
        pendingApprovals.delete(approvalId);
        sendJson(response, 200, { accepted: true });
      }
      return;
    }
    const channelVerdict = /^\/claude\/channels\/([^/]+)\/verdict\/next$/.exec(url.pathname);
    if (request.method === "GET" && channelVerdict) {
      const channelId = decodeURIComponent(channelVerdict[1]);
      const verdict = await waitForClaudeVerdict(channelId, claudeVerdicts, request);
      sendJson(response, 200, verdict ?? { empty: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/takeover") {
      const body = await readJson(request);
      const sessionId = stringField(body, "sessionId");
      const state = completeTurn(handoffs.get(sessionId) ?? initialHandoffState(sessionId));
      handoffs.set(sessionId, state);
      await persistHandoffs(statePath, handoffs);
      sendJson(response, 200, state);
      return;
    }
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && approvalMatch) {
      const approval = pendingApprovals.get(decodeURIComponent(approvalMatch[1]));
      if (!approval) {
        sendJson(response, 409, { code: "ALREADY_ANSWERED", error: "审批已由另一端处理" });
        return;
      }
      const body = await readJson(request);
      const decision = body.decision === "accept" ? "accept" : "decline";
      pendingApprovals.delete(approval.public.approvalId);
      if (approval.channelId) {
        const queue = claudeVerdicts.get(approval.channelId) ?? [];
        queue.push({ requestId: approval.public.approvalId, behavior: decision === "accept" ? "allow" : "deny" });
        claudeVerdicts.set(approval.channelId, queue);
      }
      approval.settle(decision);
      sendJson(response, 200, { accepted: true, winner: optionalString(body.origin) ?? "unknown" });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }

  function snapshot(): BrokerSnapshot {
    return {
      protocolVersion: BROKER_PROTOCOL_VERSION,
      version: options.version,
      capabilities: {
        sameServerThreadAttach: true,
        exactTurnRecovery: true,
        ownedTurnCancellation: true,
        explicitFullAccess: true,
        unlimitedTurns: true
      },
      state: codexState === "failed" ? "failed" : "ready",
      codexState,
      codexError,
      activeTurns: codex.activeCount,
      handoffs: [...handoffs.values()],
      pendingApprovals: [...pendingApprovals.values()].map((item) => item.public),
      startedAt,
      pid: process.pid
    };
  }
}

async function waitForApproval(
  request: CodexApprovalRequest,
  pending: Map<string, PendingApproval>,
  contexts: Map<string, { chatId: string; inboundMessageId: string }>
): Promise<"accept" | "decline"> {
  const approvalId = crypto.randomUUID();
  const params = request.params;
  const command = optionalString(params.command)
    ?? optionalString((params.item as Record<string, unknown> | undefined)?.command)
    ?? (request.method.includes("fileChange") ? "文件修改" : "命令执行");
  const sessionId = optionalString(params.threadId);
  const context = sessionId ? contexts.get(sessionId) : undefined;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(approvalId);
      resolve("decline");
    }, 5 * 60_000);
    timer.unref();
    pending.set(approvalId, {
      public: {
        approvalId,
        sessionId,
        chatId: context?.chatId,
        inboundMessageId: context?.inboundMessageId,
        kind: request.method.includes("fileChange") ? "file-change" : "command",
        source: "codex",
        summary: command.slice(0, 500),
        createdAt: new Date().toISOString()
      },
      settle: (decision) => {
        clearTimeout(timer);
        resolve(decision);
      }
    });
  });
}

async function waitForClaudeInbound(
  channelId: string,
  queues: Map<string, ClaudeChannelEvent[]>,
  request: IncomingMessage
): Promise<ClaudeChannelEvent | undefined> {
  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const item = queues.get(channelId)?.shift();
    if (item) {
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

async function waitForClaudeOutbound(
  channelId: string,
  queues: Map<string, ClaudeChannelOutbound[]>,
  request: IncomingMessage
): Promise<ClaudeChannelOutbound | undefined> {
  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const item = queues.get(channelId)?.shift();
    if (item) {
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

async function waitForClaudeVerdict(
  channelId: string,
  queues: Map<string, Array<{ requestId: string; behavior: "allow" | "deny" }>>,
  request: IncomingMessage
): Promise<{ requestId: string; behavior: "allow" | "deny" } | undefined> {
  const deadline = Date.now() + 25_000;
  while (!request.destroyed && Date.now() < deadline) {
    const item = queues.get(channelId)?.shift();
    if (item) {
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

async function waitForRemoteAuthority(
  sessionId: string,
  handoffs: Map<string, HandoffState>,
  statePath: string,
  request: IncomingMessage,
  codex: CodexAppServerClient
): Promise<HandoffState> {
  while (!request.destroyed) {
    const persisted = handoffs.get(sessionId) ?? initialHandoffState(sessionId);
    const current = await reconcileHandoffState(sessionId, persisted, codex);
    const decision = requestRemoteTurn({ ...current, queuedRemoteCount: Math.max(0, current.queuedRemoteCount - 1) });
    if (decision.action === "start") {
      handoffs.set(sessionId, decision.state);
      await persistHandoffs(statePath, handoffs);
      return decision.state;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("远程请求连接已关闭");
}

async function reconcileHandoffState(
  sessionId: string,
  state: HandoffState,
  codex: CodexAppServerClient
): Promise<HandoffState> {
  if (state.turnState !== "running" && state.turnState !== "unknown") {
    return state;
  }
  const status = await codex.threadStatus(sessionId).catch(() => "unknown");
  return status === "idle" || status === "notLoaded" ? completeTurn(state) : state;
}

async function loadHandoffs(filePath: string): Promise<Map<string, HandoffState>> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as HandoffState[];
    return new Map(parsed.map((item) => [item.sessionId, restoreHandoffState(item)]));
  } catch {
    return new Map();
  }
}

async function persistHandoffs(filePath: string, states: Map<string, HandoffState>): Promise<void> {
  await atomicWriteJson(filePath, [...states.values()]);
}

async function loadCompletions(filePath: string): Promise<BrokerCompletion[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as BrokerCompletion[];
    return Array.isArray(parsed) ? parsed.slice(-100) : [];
  } catch {
    return [];
  }
}

async function persistCompletions(filePath: string, completions: BrokerCompletion[]): Promise<void> {
  await atomicWriteJson(filePath, completions.slice(-100));
}

async function acquireProcessLock(lockPath: string): Promise<() => Promise<void>> {
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    return async () => {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const stalePid = Number((await fs.readFile(lockPath, "utf8").catch(() => "0")).trim());
      if (!stalePid || !processIsAlive(stalePid)) {
        await fs.rm(lockPath, { force: true });
        return acquireProcessLock(lockPath);
      }
      throw new Error(`已有 Session Broker 正在运行（PID ${stalePid}）`);
    }
    throw error;
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

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("请求正文过大");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = optionalString(value[key]);
  if (!field) {
    throw new Error(`缺少字段 ${key}`);
  }
  return field;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`缺少对象字段 ${key}`);
  }
  return field as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: Record<string, unknown>, key: string, fallback: number): number {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : fallback;
}

function policyField(value: Record<string, unknown>): RemoteExecutionPolicy {
  return value.policy === "inherit" || value.policy === "fullAccess" ? value.policy : "planOnly";
}
