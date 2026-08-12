import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDataDirectory, resolveDataDirectory } from "../src/dataDirectory";

test("resolves an explicit data directory and expands the home prefix", () => {
  const home = path.resolve("D:\\users\\tester");
  assert.equal(resolveDataDirectory("", "D:\\default", home), path.resolve("D:\\default"));
  assert.equal(resolveDataDirectory("~\\notifier", "D:\\default", home), path.join(home, "notifier"));
  assert.throws(() => resolveDataDirectory("relative\\path", "D:\\default", home), /绝对路径/);
  assert.throws(() => resolveDataDirectory(path.parse(process.cwd()).root, "D:\\default", home), /根目录/);
});

test("moves persisted user data without overwriting an existing target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-data-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.mkdir(path.join(source, "pending-events"), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(source, "remote-sessions.json"), "source", "utf8");
  await fs.writeFile(path.join(source, "paused-workspaces.json"), "source", "utf8");
  await fs.writeFile(path.join(source, "pending-events", "one.json"), "queued", "utf8");
  await fs.writeFile(path.join(target, "paused-workspaces.json"), "target", "utf8");

  const result = await prepareDataDirectory(source, target);

  assert.deepEqual(result.migrated.sort(), ["pending-events", "remote-sessions.json"]);
  assert.deepEqual(result.retained, ["paused-workspaces.json"]);
  assert.equal(await fs.readFile(path.join(target, "remote-sessions.json"), "utf8"), "source");
  assert.equal(await fs.readFile(path.join(target, "paused-workspaces.json"), "utf8"), "target");
  assert.equal(await fs.readFile(path.join(target, "pending-events", "one.json"), "utf8"), "queued");
  assert.equal(await fs.access(path.join(source, "remote-sessions.json")).then(() => true, () => false), false);
});
