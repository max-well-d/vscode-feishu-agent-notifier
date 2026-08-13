import { runBroker } from "./brokerServer";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1] ?? "");
}

const dataDirectory = args.get("--data-dir");
const codexExecutable = args.get("--codex");
if (!dataDirectory) {
  process.stderr.write("用法：broker --data-dir <path> [--codex <path>] --version <version>\n");
  process.exit(2);
}

void runBroker({
  dataDirectory,
  codexExecutable: codexExecutable || undefined,
  version: args.get("--version") || "development"
}).catch((error) => {
  process.stderr.write(`Session Broker 启动失败：${(error as Error).stack ?? (error as Error).message}\n`);
  process.exit(1);
});
