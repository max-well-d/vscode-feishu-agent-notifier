import { ChannelConfiguration, ChannelInboundMessage } from "../../channels/types";

declare global {
  interface Window {
    agentLink: {
      snapshot(): Promise<DesktopSnapshot>;
      channelConfiguration(id: string): Promise<EditableChannel>;
      saveChannel(id: string, configuration: ChannelConfiguration): Promise<DesktopSnapshot>;
      testChannel(id: string): Promise<DesktopSnapshot>;
      chooseDataDirectory(): Promise<string | undefined>;
      openDataDirectory(): Promise<string>;
      refreshBroker(): Promise<DesktopSnapshot>;
      saveSettings(settings: DesktopSnapshot["settings"]): Promise<DesktopSnapshot>;
      installHooks(): Promise<HookInspection>;
      inspectHooks(): Promise<HookInspection>;
      onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
      onMessage(listener: (message: ChannelInboundMessage) => void): () => void;
      onNavigate(listener: (view: "overview" | "sessions" | "channels" | "system") => void): () => void;
      onLog(listener: (entry: DesktopSnapshot["logs"][number]) => void): () => void;
    };
  }
}

export interface EditableChannel {
  configuration: ChannelConfiguration;
  secretConfigured: string[];
}

export interface DesktopSnapshot {
  product: string;
  version: string;
  dataDirectory: string;
  broker: { state: string; codexState: string; activeTurns: number; error?: string };
  remoteQueue: { active: number; pending: number };
  agents: Array<{ id: string; name: string; executable?: string; available: boolean }>;
  channels: Array<{
    manifest: {
      id: string;
      name: string;
      version: string;
      description: string;
      capabilities: string[];
      configSchema?: { properties?: Record<string, SchemaProperty> };
    };
    enabled: boolean;
    state: string;
    detail?: string;
  }>;
  sessions: Array<{
    source: string;
    sessionId: string;
    project: string;
    name?: string;
    alias?: string;
    status: string;
    lastSeenAt: string;
    ownership?: string;
  }>;
  logs: Array<{ at: string; level: string; message: string }>;
  settings: { remoteExecutionPolicy: "disabled" | "planOnly" | "inherit" | "fullAccess"; defaultWorkspace: string; receiverPort: number; deliveryTiming: "realtime" | "completion" };
}

export interface HookInspection {
  codexInstalled: boolean;
  codexStopInstalled: boolean;
  claudeStopInstalled: boolean;
  claudeStopFailureInstalled: boolean;
  claudeMessageDisplayInstalled: boolean;
  claudePermissionRequestInstalled: boolean;
}

export interface SchemaProperty {
  type?: string;
  enum?: string[];
  default?: unknown;
  secret?: boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
  enumLabels?: string[];
  ui?: {
    section?: "connection" | "target" | "inbound" | "message" | "advanced";
    order?: number;
    control?: "segmented";
    visibleWhen?: Record<string, string | number | boolean>;
  };
}
