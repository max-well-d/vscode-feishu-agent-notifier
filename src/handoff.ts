import { InputOrigin } from "./types";
export type SessionAuthority = "idle" | "local" | "remote";
export type BrokerTurnState = "idle" | "running" | "unknown";

export interface HandoffState {
  sessionId: string;
  authority: SessionAuthority;
  turnState: BrokerTurnState;
  inputOrigin?: InputOrigin;
  localLeaseUntil?: string;
  activeTurnId?: string;
  queuedRemoteCount: number;
  updatedAt: string;
}

export interface HandoffDecision {
  action: "start" | "queue";
  label: "远程接管" | "本地优先";
  state: HandoffState;
}

export function initialHandoffState(sessionId: string, now = new Date()): HandoffState {
  return {
    sessionId,
    authority: "idle",
    turnState: "idle",
    queuedRemoteCount: 0,
    updatedAt: now.toISOString()
  };
}

export function restoreHandoffState(state: HandoffState, now = new Date()): HandoffState {
  return {
    ...state,
    authority: state.turnState === "running" ? "idle" : state.authority,
    turnState: state.turnState === "running" ? "unknown" : state.turnState,
    activeTurnId: state.turnState === "running" ? undefined : state.activeTurnId,
    localLeaseUntil: activeLease(state, now) ? state.localLeaseUntil : undefined,
    updatedAt: now.toISOString()
  };
}

export function markLocalActivity(
  state: HandoffState,
  leaseMs = 15_000,
  now = new Date()
): HandoffState {
  return {
    ...state,
    authority: "local",
    inputOrigin: "local",
    localLeaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)).toISOString(),
    updatedAt: now.toISOString()
  };
}

export function requestRemoteTurn(state: HandoffState, now = new Date(), origin: InputOrigin = "feishu"): HandoffDecision {
  const localHasPriority = state.authority === "local"
    && (state.turnState === "running" || activeLease(state, now));
  if (localHasPriority || state.turnState === "running" || state.turnState === "unknown") {
    const queued = {
      ...state,
      queuedRemoteCount: state.queuedRemoteCount + 1,
      updatedAt: now.toISOString()
    };
    return { action: "queue", label: localHasPriority || state.turnState === "unknown" ? "本地优先" : "远程接管", state: queued };
  }
  return {
    action: "start",
    label: "远程接管",
    state: {
      ...state,
      authority: "remote",
      turnState: "running",
      inputOrigin: origin,
      localLeaseUntil: undefined,
      updatedAt: now.toISOString()
    }
  };
}

export function startTurn(
  state: HandoffState,
  origin: InputOrigin,
  turnId: string,
  now = new Date()
): HandoffState {
  return {
    ...state,
    authority: origin === "local" ? "local" : "remote",
    turnState: "running",
    inputOrigin: origin,
    activeTurnId: turnId,
    localLeaseUntil: origin === "local" ? state.localLeaseUntil : undefined,
    queuedRemoteCount: origin !== "local" ? Math.max(0, state.queuedRemoteCount - 1) : state.queuedRemoteCount,
    updatedAt: now.toISOString()
  };
}

export function completeTurn(state: HandoffState, now = new Date()): HandoffState {
  return {
    ...state,
    authority: "idle",
    turnState: "idle",
    activeTurnId: undefined,
    localLeaseUntil: undefined,
    updatedAt: now.toISOString()
  };
}

function activeLease(state: HandoffState, now: Date): boolean {
  const expiresAt = state.localLeaseUntil ? Date.parse(state.localLeaseUntil) : 0;
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}
