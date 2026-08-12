import assert from "node:assert/strict";
import test from "node:test";
import { HookEventNormalizer } from "../src/hookEventNormalizer";
import { LocalHookServer } from "../src/server";
import { AgentEvent } from "../src/types";

test("local receiver emits one event for a complete MessageDisplay sequence", async (t) => {
  const events: AgentEvent[] = [];
  const normalizer = new HookEventNormalizer("realtime", 0);
  const server = new LocalHookServer(
    "test-token",
    async (event) => { events.push(event); },
    (input) => normalizer.normalize(input)
  );
  await server.start(0);
  t.after(() => server.stop());
  assert.ok(server.port);

  const send = (index: number, final: boolean, delta: string): Promise<Response> => fetch(
    `http://127.0.0.1:${server.port}/event`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Feishu-Agent-Token": "test-token"
      },
      body: JSON.stringify({
        __notifier_source: "claude-code",
        hook_event_name: "MessageDisplay",
        session_id: "session-http",
        turn_id: "turn-http",
        message_id: "message-http",
        cwd: "/work/project-http",
        index,
        final,
        delta
      })
    }
  );

  assert.equal((await send(0, false, "第一段\n")).status, 202);
  assert.equal(events.length, 0);
  assert.equal((await send(1, true, "第二段")).status, 202);
  await waitFor(() => events.length === 1);
  assert.equal(events[0].message, "第一段\n第二段");
  assert.equal(events[0].origin, "display-hook");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for local hook event");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
