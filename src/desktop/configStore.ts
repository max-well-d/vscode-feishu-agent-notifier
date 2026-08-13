import fs from "node:fs/promises";
import path from "node:path";
import { ChannelConfiguration, ChannelManifest } from "../channels/types";

export interface SecretProtector {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface StoredDocument {
  version: 1;
  channels: Record<string, ChannelConfiguration>;
}

interface SecretDocument {
  version: 1;
  channels: Record<string, Record<string, string>>;
}

const EMPTY_CONFIG: StoredDocument = { version: 1, channels: {} };
const EMPTY_SECRETS: SecretDocument = { version: 1, channels: {} };

export class DesktopConfigStore {
  public constructor(
    private readonly dataDirectory: string,
    private readonly protector: SecretProtector
  ) {}

  public async load(manifests: ChannelManifest[]): Promise<Record<string, ChannelConfiguration>> {
    const document = await readJson<StoredDocument>(this.configPath(), EMPTY_CONFIG);
    const secrets = await readJson<SecretDocument>(this.secretPath(), EMPTY_SECRETS);
    const result: Record<string, ChannelConfiguration> = {};
    for (const manifest of manifests) {
      const stored = document.channels[manifest.id];
      if (!stored) {
        continue;
      }
      const config = structuredClone(stored.config);
      for (const key of secretKeys(manifest)) {
        const encrypted = secrets.channels[manifest.id]?.[key];
        if (!encrypted) {
          continue;
        }
        if (!this.protector.isAvailable()) {
          throw new Error(`系统安全存储不可用，无法解密 ${manifest.name} 的 ${key}`);
        }
        config[key] = this.protector.decrypt(Buffer.from(encrypted, "base64"));
      }
      result[manifest.id] = { ...stored, config };
    }
    return result;
  }

  public async save(manifest: ChannelManifest, configuration: ChannelConfiguration): Promise<void> {
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const document = await readJson<StoredDocument>(this.configPath(), EMPTY_CONFIG);
    const secrets = await readJson<SecretDocument>(this.secretPath(), EMPTY_SECRETS);
    const config = structuredClone(configuration.config);
    const channelSecrets = { ...(secrets.channels[manifest.id] ?? {}) };
    for (const key of secretKeys(manifest)) {
      const value = config[key];
      delete config[key];
      if (typeof value !== "string" || !value) {
        delete channelSecrets[key];
        continue;
      }
      if (!this.protector.isAvailable()) {
        throw new Error("系统安全存储不可用，拒绝明文保存 Channel 密钥");
      }
      channelSecrets[key] = this.protector.encrypt(value).toString("base64");
    }
    document.channels[manifest.id] = { ...configuration, config };
    secrets.channels[manifest.id] = channelSecrets;
    await atomicWriteJson(this.configPath(), document);
    await atomicWriteJson(this.secretPath(), secrets);
  }

  private configPath(): string {
    return path.join(this.dataDirectory, "channels.json");
  }

  private secretPath(): string {
    return path.join(this.dataDirectory, "channel-secrets.json");
  }
}

function secretKeys(manifest: ChannelManifest): string[] {
  const schema = manifest.configSchema as { properties?: Record<string, { secret?: boolean }> } | undefined;
  return Object.entries(schema?.properties ?? {})
    .filter(([, property]) => property.secret === true)
    .map(([key]) => key);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(fallback);
    }
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
