import { contextBridge, ipcRenderer } from "electron";
import { ChannelConfiguration, ChannelInboundMessage } from "../channels/types";

contextBridge.exposeInMainWorld("agentLink", {
  snapshot: () => ipcRenderer.invoke("snapshot:get"),
  channelConfiguration: (id: string) => ipcRenderer.invoke("channel:get", id),
  saveChannel: (id: string, configuration: ChannelConfiguration) => ipcRenderer.invoke("channel:save", id, configuration),
  testChannel: (id: string) => ipcRenderer.invoke("channel:test", id),
  chooseDataDirectory: () => ipcRenderer.invoke("data-directory:choose"),
  openDataDirectory: () => ipcRenderer.invoke("data-directory:open"),
  refreshBroker: () => ipcRenderer.invoke("broker:refresh"),
  saveSettings: (settings: { remoteExecutionPolicy: string; defaultWorkspace: string; receiverPort: number; deliveryTiming: string }) => ipcRenderer.invoke("settings:save", settings),
  installHooks: () => ipcRenderer.invoke("hooks:install"),
  inspectHooks: () => ipcRenderer.invoke("hooks:inspect"),
  onSnapshot: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => listener(snapshot);
    ipcRenderer.on("snapshot:update", handler);
    return () => ipcRenderer.removeListener("snapshot:update", handler);
  },
  onMessage: (listener: (message: ChannelInboundMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: ChannelInboundMessage): void => listener(message);
    ipcRenderer.on("channel:message", handler);
    return () => ipcRenderer.removeListener("channel:message", handler);
  },
  onNavigate: (listener: (view: "overview" | "sessions" | "channels" | "system") => void) => {
    const handler = (_event: Electron.IpcRendererEvent, view: "overview" | "sessions" | "channels" | "system"): void => listener(view);
    ipcRenderer.on("navigation:show", handler);
    return () => ipcRenderer.removeListener("navigation:show", handler);
  },
  onLog: (listener: (entry: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: unknown): void => listener(entry);
    ipcRenderer.on("log:append", handler);
    return () => ipcRenderer.removeListener("log:append", handler);
  }
});
