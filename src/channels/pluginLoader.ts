import fs from "node:fs/promises";
import path from "node:path";
import { CHANNEL_API_VERSION, ChannelAdapter, ChannelPluginModule } from "./types";

interface ExternalChannelManifest {
  apiVersion: number;
  id: string;
  entry: string;
}

export async function loadExternalChannel(pluginDirectory: string): Promise<ChannelAdapter> {
  const root = path.resolve(pluginDirectory);
  const manifestPath = path.join(root, "channel.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<ExternalChannelManifest>;
  if (manifest.apiVersion !== CHANNEL_API_VERSION || typeof manifest.id !== "string" || typeof manifest.entry !== "string") {
    throw new Error(`Channel manifest 无效：${manifestPath}`);
  }
  const entry = path.resolve(root, manifest.entry);
  if (!isWithin(root, entry)) {
    throw new Error(`Channel entry 不能离开插件目录：${manifest.entry}`);
  }
  const stat = await fs.stat(entry);
  if (!stat.isFile()) {
    throw new Error(`Channel entry 不是文件：${entry}`);
  }
  delete require.cache[require.resolve(entry)];
  const loaded = require(entry) as Partial<ChannelPluginModule>;
  if (typeof loaded.createChannelAdapter !== "function") {
    throw new Error(`Channel 必须导出 createChannelAdapter()：${entry}`);
  }
  const adapter = loaded.createChannelAdapter();
  if (adapter.manifest.id !== manifest.id || adapter.manifest.apiVersion !== CHANNEL_API_VERSION) {
    throw new Error(`Channel 代码与 manifest 不匹配：${manifest.id}`);
  }
  return adapter;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
