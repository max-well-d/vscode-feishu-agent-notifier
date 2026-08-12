import path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // VS Code launches extension hosts with this variable. If inherited by the
  // nested test instance, Code.exe starts as plain Node and rejects all CLI flags.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      FEISHU_AGENT_NOTIFIER_TEST: "1"
    },
    launchArgs: ["--disable-extensions"]
  });
}

void main().catch((error) => {
  console.error("VS Code Extension Host integration tests failed", error);
  process.exitCode = 1;
});
