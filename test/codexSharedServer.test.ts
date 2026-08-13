import assert from "node:assert/strict";
import test from "node:test";
import { sharedAppServerArgs } from "../src/codexSharedServer";

test("builds a shared Codex App Server command from a plain broker launch", () => {
  assert.deepEqual(
    sharedAppServerArgs("ws://127.0.0.1:41000", []),
    ["app-server", "--listen", "ws://127.0.0.1:41000"]
  );
});

test("preserves official VS Code App Server flags while replacing stdio transport", () => {
  assert.deepEqual(
    sharedAppServerArgs("ws://127.0.0.1:41001", [
      "-c", "features.code_mode_host=true",
      "app-server", "--analytics-default-enabled", "--stdio"
    ]),
    [
      "-c", "features.code_mode_host=true",
      "app-server", "--analytics-default-enabled",
      "--listen", "ws://127.0.0.1:41001"
    ]
  );
});
