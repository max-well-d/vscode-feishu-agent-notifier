import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  eventIsPaused,
  readPausedWorkspaceRoots,
  setWorkspacePaused,
  workspaceIsPaused
} from "../src/workspacePause";

test("shares paused workspace roots across windows and resumes selectively", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-pause-test-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "paused-workspaces.json");

  await setWorkspacePaused(filePath, ["C:\\work\\A"], true);
  await setWorkspacePaused(filePath, ["C:\\work\\B"], true);
  let paused = await readPausedWorkspaceRoots(filePath);
  assert.equal(workspaceIsPaused(paused, ["c:\\work\\a"]), true);
  assert.equal(eventIsPaused(paused, "C:\\work\\B\\src"), true);

  await setWorkspacePaused(filePath, ["C:\\work\\A"], false);
  paused = await readPausedWorkspaceRoots(filePath);
  assert.equal(workspaceIsPaused(paused, ["C:\\work\\A"]), false);
  assert.equal(eventIsPaused(paused, "C:\\work\\B\\src"), true);
});

test("fails open when the pause registry is malformed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-pause-invalid-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "paused-workspaces.json");
  await fs.writeFile(filePath, "not-json", "utf8");
  assert.deepEqual(await readPausedWorkspaceRoots(filePath), []);
});
