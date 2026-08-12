import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { CodexAppServerClient } from "../src/codexAppServer";

interface ProtocolMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function fakeAppServer(requests: ProtocolMessage[]): typeof spawn {
  return (() => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let buffer = "";
    const send = (value: unknown): void => {
      stdout.write(`${JSON.stringify(value)}\n`);
    };
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const request = JSON.parse(line) as ProtocolMessage;
        requests.push(request);
        if (request.method === "initialize") {
          send({ id: request.id, result: { userAgent: "test" } });
        } else if (request.method === "thread/start") {
          send({ id: request.id, result: { thread: { id: "thread-managed", sessionId: "thread-managed", name: null } } });
        } else if (request.method === "thread/fork") {
          send({
            id: request.id,
            result: {
              thread: {
                id: "thread-forked",
                sessionId: "thread-forked",
                name: "Source title",
                preview: "source prompt",
                forkedFromId: request.params?.threadId
              }
            }
          });
        } else if (request.method === "thread/name/set") {
          send({ id: request.id, result: {} });
        } else if (request.method === "thread/resume") {
          send({ id: request.id, result: { thread: { id: request.params?.threadId, sessionId: request.params?.threadId } } });
        } else if (request.method === "thread/read") {
          send({
            id: request.id,
            result: {
              thread: {
                id: request.params?.threadId,
                name: request.params?.threadId === "thread-external" ? "External title" : null,
                status: { type: "idle" }
              }
            }
          });
        } else if (request.method === "turn/start") {
          const threadId = request.params?.threadId;
          send({ id: request.id, result: { turn: { id: "turn-managed", status: "inProgress" } } });
          setImmediate(() => {
            send({
              method: "item/completed",
              params: {
                threadId,
                turnId: "turn-managed",
                item: { type: "agentMessage", id: "item-1", text: "managed result" }
              }
            });
            send({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: "turn-managed", status: "completed", error: null }
              }
            });
          });
        } else if (request.method === "turn/steer" || request.method === "turn/interrupt") {
          send({ id: request.id, result: {} });
        }
      }
    });
    return Object.assign(events, {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      pid: 1234
    }) as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
}

test("owns a Codex App Server thread and waits for authoritative turn completion", async () => {
  const requests: ProtocolMessage[] = [];
  const client = new CodexAppServerClient({
    executable: async () => "codex",
    version: () => "0.13.0",
    spawnImpl: fakeAppServer(requests)
  });
  const session = await client.startThread("D:\\work\\repo", "repo", "planOnly", "Remote test");
  const result = await client.runTurn(session, "run tests", "planOnly", new AbortController().signal, 10_000);

  assert.equal(session.ownership, "managed");
  assert.equal(session.managedBackend, "codex-app-server");
  assert.equal(result.outputTail, "managed result");
  assert.equal(result.turnId, "turn-managed");
  assert.equal(result.backend, "codex-app-server");
  assert.equal(requests[0].method, "initialize");
  assert.deepEqual(requests[0].params?.capabilities, {
    experimentalApi: true,
    requestAttestation: false
  });
  assert.equal(requests[1].method, "initialized");
  assert.equal(requests.find((request) => request.method === "thread/start")?.params?.sandbox, "read-only");
  assert.deepEqual(
    requests.find((request) => request.method === "turn/start")?.params?.sandboxPolicy,
    { type: "readOnly", networkAccess: false }
  );
  client.dispose();
});

test("creates a named persistent fork at the exact completed turn", async () => {
  const requests: ProtocolMessage[] = [];
  const client = new CodexAppServerClient({
    executable: async () => "codex",
    version: () => "0.14.0",
    spawnImpl: fakeAppServer(requests)
  });
  const forked = await client.forkThread({
    source: "codex",
    sessionId: "thread-external",
    cwd: "D:\\work\\repo",
    project: "repo",
    lastSeenAt: new Date().toISOString(),
    status: "completed",
    name: "External title",
    ownership: "external",
    completionEvidence: "authoritative"
  }, "turn-source", "planOnly");
  const result = await client.runTurn(forked, "continue", "planOnly", new AbortController().signal, 10_000);

  assert.equal(forked.sessionId, "thread-forked");
  assert.equal(forked.name, "External title · 飞书");
  assert.equal(forked.forkedFromSessionId, "thread-external");
  assert.equal(result.sessionId, "thread-forked");
  const forkRequest = requests.find((request) => request.method === "thread/fork");
  assert.equal(forkRequest?.params?.lastTurnId, "turn-source");
  assert.equal(forkRequest?.params?.ephemeral, false);
  assert.equal(forkRequest?.params?.excludeTurns, true);
  assert.equal(forkRequest?.params?.sandbox, "read-only");
  assert.equal(requests.find((request) => request.method === "thread/name/set")?.params?.name, "External title · 飞书");
  client.dispose();
});
