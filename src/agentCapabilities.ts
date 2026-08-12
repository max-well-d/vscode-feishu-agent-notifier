import { execFile } from "node:child_process";

export interface AgentCapabilities {
  codexVersion?: string;
  codexStopHook?: boolean;
  claudeVersion?: string;
  claudeMessageDisplay?: boolean;
}

type CommandRunner = (command: string, args: string[]) => Promise<string | undefined>;

export async function detectAgentCapabilities(
  run: CommandRunner = runCommand
): Promise<AgentCapabilities> {
  const [codexVersionOutput, codexFeaturesOutput, claudeVersionOutput] = await Promise.all([
    run("codex", ["--version"]),
    run("codex", ["features", "list"]),
    run("claude", ["--version"])
  ]);
  const codexVersion = parseVersion(codexVersionOutput);
  const claudeVersion = parseVersion(claudeVersionOutput);
  return {
    codexVersion,
    codexStopHook: parseCodexHookFeature(codexFeaturesOutput),
    claudeVersion,
    claudeMessageDisplay: claudeVersion ? versionAtLeast(claudeVersion, "2.1.166") : undefined
  };
}

export function parseVersion(output: string | undefined): string | undefined {
  return output?.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function parseCodexHookFeature(output: string | undefined): boolean | undefined {
  if (!output) {
    return undefined;
  }
  const match = output.match(/^hooks\s+\S+\s+(true|false)\s*$/m);
  return match ? match[1] === "true" : undefined;
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = numericVersion(actual);
  const minimumParts = numericVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index] > minimumParts[index];
    }
  }
  return true;
}

function numericVersion(value: string): [number, number, number] {
  const parts = value.split(/[.+-]/, 3).map((part) => Number(part));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function runCommand(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const executable = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : command;
    const executableArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", command, ...args]
      : args;
    execFile(executable, executableArgs, {
      timeout: 3_000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(`${stdout}\n${stderr}`.trim());
    });
  });
}
