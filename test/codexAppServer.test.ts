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

interface FakeAppServerOptions {
  omitCompletionNotification?: boolean;
  pollCompletedTurn?: boolean;
  emitForeignTurn?: boolean;
}

function fakeAppServer(requests: ProtocolMessage[], options: FakeAppServerOptions = {}): typeof spawn {
  return (() => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let buffer = "";
    let turnStarted = false;
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
          const includeTurns = request.params?.includeTurns === true;
          send({
            id: request.id,
            result: {
              thread: {
                id: request.params?.threadId,
                name: request.params?.threadId === "thread-external" ? "External title" : null,
                status: { type: turnStarted && !options.pollCompletedTurn ? "active" : "idle" },
                ...(includeTurns && options.pollCompletedTurn && turnStarted
                  ? {
                      turns: [{
                        id: "turn-managed",
                        status: "completed",
                        error: null,
                        items: [{ type: "agentMessage", text: "recovered result" }]
                      }]
                    }
                  : {})
              }
            }
          });
        } else if (request.method === "turn/start") {
          const threadId = request.params?.threadId;
          turnStarted = true;
          send({ id: request.id, result: { turn: { id: "turn-managed", status: "inProgress" } } });
          if (options.emitForeignTurn) {
            setImmediate(() => send({
              method: "turn/started",
              params: { threadId, turn: { id: "turn-local", status: "inProgress" } }
            }));
          }
          if (options.omitCompletionNotification) {
            continue;
          }
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

test("attaches to an already loaded VS Code thread without resuming a second writer", async () => {
  const requests: ProtocolMessage[] = [];
  const client = new CodexAppServerClient({
    executable: async () => "codex",
    version: () => "shared-test",
    spawnImpl: fakeAppServer(requests)
  });
  const source = {
    source: "codex" as const,
    sessionId: "thread-external",
    cwd: "D:\\work\\repo",
    project: "repo",
    lastSeenAt: new Date().toISOString(),
    status: "completed" as const,
    ownership: "external" as const,
    completionEvidence: "authoritative" as const
  };

  const adopted = await client.adoptThread(source, "inherit");

  assert.equal(adopted.sessionId, source.sessionId);
  assert.equal(adopted.ownership, "managed");
  assert.equal(requests.some((request) => request.method === "thread/read"), true);
  assert.equal(requests.some((request) => request.method === "thread/resume"), false);
  client.dispose();
});

test("recovers a completed turn by polling when the websocket completion is missed", async () => {
  const requests: ProtocolMessage[] = [];
  const client = new CodexAppServerClient({
    executable: async () => "codex",
    version: () => "poll-test",
    spawnImpl: fakeAppServer(requests, {
      omitCompletionNotification: true,
      pollCompletedTurn: true
    })
  });
  const session = await client.startThread("D:\\work\\repo", "repo", "inherit");

  const result = await client.runTurn(session, "continue", "inherit", new AbortController().signal, 5_000);

  assert.equal(result.turnId, "turn-managed");
  assert.equal(result.outputTail, "recovered result");
  assert.equal(requests.some((request) => request.method === "thread/read" && request.params?.includeTurns === true), true);
  client.dispose();
});

test("cancel targets only the broker-owned turn when a local turn is observed", async () => {
  const requests: ProtocolMessage[] = [];
  const client = new CodexAppServerClient({
    executable: async () => "codex",
    version: () => "ownership-test",
    spawnImpl: fakeAppServer(requests, {
      omitCompletionNotification: true,
      pollCompletedTurn: true,
      emitForeignTurn: true
    })
  });
  const session = await client.startThread("D:\\work\\repo", "repo", "inherit");
  const running = client.runTurn(session, "continue", "inherit", new AbortController().signal, 5_000);
  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await client.interruptSession(session.sessionId), true);
  const interrupt = requests.find((request) => request.method === "turn/interrupt");
  assert.equal(interrupt?.params?.turnId, "turn-managed");
  await running;
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

test("refuses to resume an externally owned thread before starting App Server", async () => {
  let spawned = false;
  const client = new CodexAppServerClient({
    executable: async () => "codex",
    version: () => "test",
    spawnImpl: (() => {
      spawned = true;
      throw new Error("must not spawn");
    }) as unknown as typeof spawn
  });

  await assert.rejects(client.runTurn({
    source: "codex",
    sessionId: "thread-external",
    cwd: "D:\\work\\repo",
    project: "repo",
    lastSeenAt: new Date().toISOString(),
    status: "completed",
    ownership: "external",
    completionEvidence: "authoritative"
  }, "continue", "planOnly", new AbortController().signal, 10_000), /拒绝直接执行未接管的外部 Codex 会话/);
  assert.equal(spawned, false);
});
