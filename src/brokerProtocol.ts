import { AgentSession } from "./types";
import { AgentEvent } from "./types";
import { HandoffState } from "./handoff";

export interface BrokerDescriptor {
  protocolVersion: 1;
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export interface BrokerSnapshot {
  state: "starting" | "ready" | "failed";
  codexState: "stopped" | "starting" | "ready" | "failed";
  codexError?: string;
  activeTurns: number;
  handoffs: HandoffState[];
  pendingApprovals: BrokerApproval[];
  startedAt: string;
  pid: number;
}

export interface BrokerApproval {
  approvalId: string;
  sessionId?: string;
  chatId?: string;
  inboundMessageId?: string;
  source?: "codex" | "claude-code";
  kind: "command" | "file-change";
  summary: string;
  createdAt: string;
}

export interface ClaudeChannelEvent {
  id: string;
  prompt: string;
  chatId: string;
  inboundMessageId: string;
  createdAt: string;
}

export interface ClaudeChannelOutbound {
  id: string;
  chatId: string;
  inboundMessageId?: string;
  text: string;
  createdAt: string;
}

export interface BrokerTurnRequest {
  session: AgentSession;
  prompt: string;
  policy: "planOnly" | "inherit";
  origin: "local" | "feishu";
  timeoutMs: number;
}

export interface BrokerTurnResult {
  exitCode: number;
  durationMs: number;
  outputTail: string;
  sessionId: string;
  turnId?: string;
  backend: "codex-app-server";
  handoff: HandoffState;
  completionId?: string;
}

export interface BrokerCompletion {
  id: string;
  event: AgentEvent;
  chatId?: string;
  inboundMessageId?: string;
  createdAt: string;
}
