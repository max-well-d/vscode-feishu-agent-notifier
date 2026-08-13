import fs from "node:fs/promises";
import path from "node:path";
import { AgentEvent, AgentSession, FeishuDeliveryReceipt } from "./types";

interface MessageRoute {
  sessionKey: string;
  createdAt: string;
  kind?: "agent-event" | "bot-reply";
  eventStatus?: AgentSession["status"];
  turnId?: string;
}

interface RemoteBranch {
  sourceSessionKey: string;
  sourceTurnId: string;
  managedSessionKey: string;
  createdAt: string;
}

interface ChatSelection {
  sessionKey: string;
  updatedAt: string;
}

interface RegistryDocument {
  version: 3;
  sessions: Record<string, AgentSession>;
  messages: Record<string, MessageRoute>;
  remoteBranches: Record<string, RemoteBranch>;
  chatSelections: Record<string, ChatSelection>;
  processedInbound: Record<string, string>;
}

const EMPTY_DOCUMENT: RegistryDocument = {
  version: 3,
  sessions: {},
  messages: {},
  remoteBranches: {},
  chatSelections: {},
  processedInbound: {}
};

export interface RegistryOptions {
  messageTtlMs?: number;
  inboundTtlMs?: number;
  maxSessions?: number;
  maxMessages?: number;
  now?: () => Date;
}

export class SessionRegistry {
  private readonly messageTtlMs: number;
  private readonly inboundTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxMessages: number;
  private readonly now: () => Date;
  private operation: Promise<unknown> = Promise.resolve();

  public constructor(private readonly filePath: string, options: RegistryOptions = {}) {
    this.messageTtlMs = options.messageTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.inboundTtlMs = options.inboundTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 500;
    this.maxMessages = options.maxMessages ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  public recordEvent(event: AgentEvent): Promise<AgentSession> {
    return this.mutate((document) => {
      const key = agentSessionKey(event.source, event.sessionId);
      const previous = document.sessions[key];
      const session: AgentSession = {
        source: event.source,
        sessionId: event.sessionId,
        cwd: event.cwd || previous?.cwd || "",
        project: event.project || previous?.project || path.basename(event.cwd) || "unknown",
        lastSeenAt: event.occurredAt || this.now().toISOString(),
        status: event.status,
        name: event.sessionName || previous?.name,
        alias: previous?.alias,
        ownership: previous?.ownership ?? "external",
        completionEvidence: "authoritative",
        managedBackend: previous?.managedBackend,
        lastCompletedTurnId: terminalTurnId(event) || previous?.lastCompletedTurnId,
        forkedFromSessionId: previous?.forkedFromSessionId,
        forkedFromTurnId: previous?.forkedFromTurnId
      };
      document.sessions[key] = session;
      return session;
    });
  }

  public recordDiscoveredSessions(sessions: AgentSession[]): Promise<number> {
    return this.mutate((document) => {
      let changed = 0;
      for (const session of sessions) {
        if (!session.sessionId || session.source === "unknown") {
          continue;
        }
        const key = agentSessionKey(session.source, session.sessionId);
        const previous = document.sessions[key];
        if (!previous) {
          document.sessions[key] = {
            ...session,
            ownership: session.ownership ?? "external",
            completionEvidence: session.completionEvidence ?? "discovered"
          };
          changed += 1;
          continue;
        }
        if (Date.parse(session.lastSeenAt) > Date.parse(previous.lastSeenAt)
          || (session.lastSeenAt === previous.lastSeenAt && session.status !== previous.status)) {
          const authoritative = previous.completionEvidence === "authoritative";
          const newerExternalActivity = authoritative
            && previous.ownership !== "managed"
            && Date.parse(session.lastSeenAt) > Date.parse(previous.lastSeenAt) + 1_000;
          document.sessions[key] = {
            ...previous,
            ...session,
            status: authoritative
              ? previous.status === "progress" || newerExternalActivity ? "progress" : previous.status
              : session.status,
            alias: previous.alias ?? session.alias,
            name: previous.name ?? session.name,
            ownership: previous.ownership ?? session.ownership ?? "external",
            completionEvidence: previous.completionEvidence ?? session.completionEvidence ?? "discovered",
            managedBackend: previous.managedBackend ?? session.managedBackend,
            lastCompletedTurnId: previous.lastCompletedTurnId ?? session.lastCompletedTurnId,
            forkedFromSessionId: previous.forkedFromSessionId ?? session.forkedFromSessionId,
            forkedFromTurnId: previous.forkedFromTurnId ?? session.forkedFromTurnId
          };
          changed += 1;
        }
      }
      return changed;
    });
  }

  public recordDelivery(event: AgentEvent, receipts: FeishuDeliveryReceipt[]): Promise<void> {
    return this.mutate((document) => {
      const key = agentSessionKey(event.source, event.sessionId);
      const previous = document.sessions[key];
      document.sessions[key] = {
        source: event.source,
        sessionId: event.sessionId,
        cwd: event.cwd || previous?.cwd || "",
        project: event.project || previous?.project || path.basename(event.cwd) || "unknown",
        lastSeenAt: event.occurredAt || this.now().toISOString(),
        status: event.status,
        name: event.sessionName || previous?.name,
        alias: previous?.alias,
        ownership: previous?.ownership ?? "external",
        completionEvidence: "authoritative",
        managedBackend: previous?.managedBackend,
        lastCompletedTurnId: terminalTurnId(event) || previous?.lastCompletedTurnId,
        forkedFromSessionId: previous?.forkedFromSessionId,
        forkedFromTurnId: previous?.forkedFromTurnId
      };
      const createdAt = this.now().toISOString();
      for (const receipt of receipts) {
        if (receipt.messageId) {
          document.messages[receipt.messageId] = {
            sessionKey: key,
            createdAt,
            kind: "agent-event",
            eventStatus: event.status,
            turnId: event.turnId || undefined
          };
        }
      }
    });
  }

  public resolveMessage(messageId: string | undefined): Promise<AgentSession | undefined> {
    return this.resolveMessageContext(messageId).then((context) => context?.session);
  }

  public resolveMessageContext(messageId: string | undefined): Promise<ResolvedSessionContext | undefined> {
    return this.read((document) => {
      if (!messageId) {
        return undefined;
      }
      const route = document.messages[messageId];
      const branch = route?.turnId
        ? document.remoteBranches[remoteBranchKey(route.sessionKey, route.turnId)]
        : undefined;
      const resolvedKey = branch?.managedSessionKey ?? route?.sessionKey;
      const session = resolvedKey ? document.sessions[resolvedKey] : undefined;
      if (!session) {
        return undefined;
      }
      const resolved: AgentSession = route.kind === "agent-event"
        && (route.eventStatus === "completed" || route.eventStatus === "failed")
        ? { ...session, completionEvidence: "authoritative" }
        : session;
      return {
        session: resolved,
        turnId: branch ? resolved.lastCompletedTurnId || route.turnId : route.turnId
      };
    });
  }

  public recordManagedSession(session: AgentSession): Promise<AgentSession> {
    return this.mutate((document) => {
      const managed: AgentSession = {
        ...session,
        ownership: "managed",
        completionEvidence: "authoritative"
      };
      const key = agentSessionKey(managed.source, managed.sessionId);
      const previous = document.sessions[key];
      document.sessions[key] = { ...managed, alias: previous?.alias ?? managed.alias };
      return document.sessions[key];
    });
  }

  public recordMessageRoute(messageId: string, session: AgentSession, turnId?: string): Promise<void> {
    return this.mutate((document) => {
      const key = agentSessionKey(session.source, session.sessionId);
      document.sessions[key] = document.sessions[key] ?? session;
      document.messages[messageId] = {
        sessionKey: key,
        createdAt: this.now().toISOString(),
        kind: "bot-reply",
        turnId: turnId || undefined
      };
    });
  }

  public recordRemoteBranch(
    source: AgentSession,
    sourceTurnId: string,
    managed: AgentSession,
    chatId: string
  ): Promise<AgentSession> {
    return this.mutate((document) => {
      const sourceKey = agentSessionKey(source.source, source.sessionId);
      const managedKey = agentSessionKey(managed.source, managed.sessionId);
      const previousSource = document.sessions[sourceKey] ?? source;
      document.sessions[sourceKey] = {
        ...previousSource,
        status: source.status,
        completionEvidence: source.completionEvidence ?? "authoritative"
      };
      const persisted: AgentSession = {
        ...managed,
        ownership: "managed",
        completionEvidence: "authoritative",
        forkedFromSessionId: source.sessionId,
        forkedFromTurnId: sourceTurnId
      };
      document.sessions[managedKey] = persisted;
      document.remoteBranches[remoteBranchKey(sourceKey, sourceTurnId)] = {
        sourceSessionKey: sourceKey,
        sourceTurnId,
        managedSessionKey: managedKey,
        createdAt: this.now().toISOString()
      };
      document.chatSelections[chatId] = {
        sessionKey: managedKey,
        updatedAt: this.now().toISOString()
      };
      return persisted;
    });
  }

  public resolveRemoteBranch(source: AgentSession, sourceTurnId: string): Promise<AgentSession | undefined> {
    return this.read((document) => {
      const sourceKey = agentSessionKey(source.source, source.sessionId);
      const branch = document.remoteBranches[remoteBranchKey(sourceKey, sourceTurnId)];
      return branch ? document.sessions[branch.managedSessionKey] : undefined;
    });
  }

  public updateExecutionState(
    original: AgentSession,
    status: AgentSession["status"],
    actualSessionId?: string,
    actualTurnId?: string
  ): Promise<AgentSession> {
    return this.mutate((document) => {
      const oldKey = agentSessionKey(original.source, original.sessionId);
      const previous = document.sessions[oldKey] ?? original;
      const updated: AgentSession = {
        ...previous,
        sessionId: actualSessionId || previous.sessionId,
        lastSeenAt: this.now().toISOString(),
        status,
        ownership: previous.ownership ?? original.ownership ?? "external",
        completionEvidence: "authoritative",
        managedBackend: previous.managedBackend ?? original.managedBackend,
        lastCompletedTurnId: actualTurnId || previous.lastCompletedTurnId
      };
      const newKey = agentSessionKey(updated.source, updated.sessionId);
      document.sessions[newKey] = updated;
      if (newKey !== oldKey) {
        delete document.sessions[oldKey];
        for (const route of Object.values(document.messages)) {
          if (route.sessionKey === oldKey) {
            route.sessionKey = newKey;
          }
        }
        for (const selection of Object.values(document.chatSelections)) {
          if (selection.sessionKey === oldKey) {
            selection.sessionKey = newKey;
          }
        }
      }
      return updated;
    });
  }

  public getSession(keyOrAlias: string): Promise<AgentSession | undefined> {
    return this.read((document) => {
      const exact = document.sessions[keyOrAlias];
      if (exact) {
        return exact;
      }
      const normalized = normalizeAlias(keyOrAlias);
      return Object.values(document.sessions).find((session) =>
        normalizeAlias(session.alias ?? "") === normalized
        || session.sessionId === keyOrAlias
      );
    });
  }

  public listSessions(limit = 10): Promise<AgentSession[]> {
    return this.read((document) => Object.values(document.sessions)
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
      .slice(0, Math.max(1, limit)));
  }

  public setAlias(session: AgentSession, alias: string): Promise<void> {
    return this.mutate((document) => {
      const normalized = normalizeAlias(alias);
      if (!normalized || normalized.length > 40 || /\s/.test(alias)) {
        throw new Error("会话别名必须为 1 到 40 个不含空格的字符");
      }
      for (const [key, candidate] of Object.entries(document.sessions)) {
        if (key !== agentSessionKey(session.source, session.sessionId)
          && normalizeAlias(candidate.alias ?? "") === normalized) {
          throw new Error(`会话别名已被使用：${alias}`);
        }
      }
      const key = agentSessionKey(session.source, session.sessionId);
      const current = document.sessions[key] ?? session;
      document.sessions[key] = { ...current, alias: alias.trim() };
    });
  }

  public selectForChat(chatId: string, session: AgentSession): Promise<void> {
    return this.mutate((document) => {
      const key = agentSessionKey(session.source, session.sessionId);
      document.sessions[key] = document.sessions[key] ?? session;
      document.chatSelections[chatId] = { sessionKey: key, updatedAt: this.now().toISOString() };
    });
  }

  public selectedForChat(chatId: string): Promise<AgentSession | undefined> {
    return this.read((document) => {
      const selected = document.chatSelections[chatId];
      return selected ? document.sessions[selected.sessionKey] : undefined;
    });
  }

  public claimInbound(messageId: string): Promise<boolean> {
    return this.mutate((document) => {
      if (document.processedInbound[messageId]) {
        return false;
      }
      document.processedInbound[messageId] = this.now().toISOString();
      return true;
    });
  }

  public cleanup(): Promise<void> {
    return this.mutate(() => undefined);
  }

  private read<T>(reader: (document: RegistryDocument) => T): Promise<T> {
    const next = this.operation.then(async () => reader(await this.load()));
    this.operation = next.catch(() => undefined);
    return next;
  }

  private mutate<T>(mutation: (document: RegistryDocument) => T): Promise<T> {
    const next = this.operation.then(async () => {
      const document = await this.load();
      const result = mutation(document);
      this.prune(document);
      await this.save(document);
      return result;
    });
    this.operation = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<RegistryDocument> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<RegistryDocument>;
      const document: RegistryDocument = {
        version: 3,
        sessions: isRecord(parsed.sessions) ? parsed.sessions as Record<string, AgentSession> : {},
        messages: isRecord(parsed.messages) ? parsed.messages as Record<string, MessageRoute> : {},
        remoteBranches: isRecord(parsed.remoteBranches) ? parsed.remoteBranches as Record<string, RemoteBranch> : {},
        chatSelections: isRecord(parsed.chatSelections) ? parsed.chatSelections as Record<string, ChatSelection> : {},
        processedInbound: isRecord(parsed.processedInbound) ? parsed.processedInbound as Record<string, string> : {}
      };
      migrateLegacyEvidence(document);
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_DOCUMENT);
      }
      if (error instanceof SyntaxError) {
        const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
        await fs.rename(this.filePath, quarantine).catch(() => undefined);
        return structuredClone(EMPTY_DOCUMENT);
      }
      throw error;
    }
  }

  private async save(document: RegistryDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    if (process.platform !== "win32") {
      await fs.chmod(this.filePath, 0o600);
    }
  }

  private prune(document: RegistryDocument): void {
    const now = this.now().getTime();
    for (const [messageId, route] of Object.entries(document.messages)) {
      if (!document.sessions[route.sessionKey] || now - Date.parse(route.createdAt) > this.messageTtlMs) {
        delete document.messages[messageId];
      }
    }
    for (const [messageId, occurredAt] of Object.entries(document.processedInbound)) {
      if (now - Date.parse(occurredAt) > this.inboundTtlMs) {
        delete document.processedInbound[messageId];
      }
    }
    keepNewest(document.messages, this.maxMessages, (value) => Date.parse(value.createdAt));
    keepNewest(document.sessions, this.maxSessions, (value) => Date.parse(value.lastSeenAt));
    for (const [chatId, selection] of Object.entries(document.chatSelections)) {
      if (!document.sessions[selection.sessionKey]) {
        delete document.chatSelections[chatId];
      }
    }
    for (const [key, branch] of Object.entries(document.remoteBranches)) {
      if (!document.sessions[branch.sourceSessionKey] || !document.sessions[branch.managedSessionKey]) {
        delete document.remoteBranches[key];
      }
    }
  }
}

/**
 * Before registry v2, every persisted message route came from recordDelivery,
 * so a terminal session with a route written at the same time as lastSeenAt is
 * evidence of a real completed/failed Agent event. Disk-only discoveries have
 * no such route. This keeps quoted completion cards usable after upgrading
 * without treating an unrelated, stale progress card as completion evidence.
 */
function migrateLegacyEvidence(document: RegistryDocument): void {
  const newestLegacyRouteBySession = new Map<string, number>();
  for (const route of Object.values(document.messages)) {
    if (route.kind || route.eventStatus) {
      continue;
    }
    const createdAt = Date.parse(route.createdAt);
    if (Number.isFinite(createdAt)) {
      newestLegacyRouteBySession.set(
        route.sessionKey,
        Math.max(newestLegacyRouteBySession.get(route.sessionKey) ?? 0, createdAt)
      );
    }
  }
  for (const [key, session] of Object.entries(document.sessions)) {
    session.ownership ??= "external";
    if (session.completionEvidence === "authoritative") {
      continue;
    }
    const routeTime = newestLegacyRouteBySession.get(key);
    const lastSeenAt = Date.parse(session.lastSeenAt);
    const terminal = session.status === "completed" || session.status === "failed";
    session.completionEvidence = terminal
      && routeTime !== undefined
      && Number.isFinite(lastSeenAt)
      && routeTime >= lastSeenAt - 5_000
      ? "authoritative"
      : "discovered";
  }
}

export function agentSessionKey(source: AgentSession["source"], sessionId: string): string {
  return `${source}:${sessionId}`;
}

export interface ResolvedSessionContext {
  session: AgentSession;
  turnId?: string;
}

function remoteBranchKey(sourceSessionKey: string, sourceTurnId: string): string {
  return `${sourceSessionKey}::${sourceTurnId}`;
}

function terminalTurnId(event: AgentEvent): string | undefined {
  return event.turnId && (event.status === "completed" || event.status === "failed")
    ? event.turnId
    : undefined;
}

function normalizeAlias(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keepNewest<T>(record: Record<string, T>, limit: number, timestamp: (value: T) => number): void {
  const entries = Object.entries(record);
  if (entries.length <= limit) {
    return;
  }
  entries.sort((left, right) => timestamp(right[1]) - timestamp(left[1]));
  for (const [key] of entries.slice(limit)) {
    delete record[key];
  }
}
