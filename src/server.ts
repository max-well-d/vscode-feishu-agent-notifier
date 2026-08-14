import http from "node:http";
import { normalizeAgentEvent } from "./event";
import { AgentEvent } from "./types";

export type EventHandler = (event: AgentEvent) => Promise<void>;
export type EventNormalizer = (input: Record<string, unknown>) => AgentEvent | undefined | Promise<AgentEvent | undefined>;

export interface PermissionVerdict {
  decision: "allow" | "deny" | "ask";
  reason?: string;
}

/**
 * Permission-prompt support for local agents (Claude Code PermissionPrompt hook).
 * The hook posts the permission request and long-polls for a remote decision.
 */
export interface HookServerPermissions {
  register(request: unknown): Promise<{ approvalId: string }> | { approvalId: string };
  waitForVerdict(approvalId: string, timeoutMs: number): Promise<PermissionVerdict | undefined>;
}

export class LocalHookServer {
  private server: http.Server | undefined;
  private activePort: number | undefined;

  public constructor(
    private readonly token: string,
    private readonly onEvent: EventHandler,
    private readonly normalizeEvent: EventNormalizer = normalizeAgentEvent,
    private readonly serviceName = "feishu-agent-notifier",
    private readonly permissions?: HookServerPermissions
  ) {}

  public get port(): number | undefined {
    return this.activePort;
  }

  public async start(port: number): Promise<void> {
    await this.stop();
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });

    this.server = server;
    const address = server.address();
    this.activePort = address && typeof address === "object" ? address.port : port;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (request.headers["x-feishu-agent-token"] !== this.token) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: this.serviceName }));
      return;
    }

    if (request.method === "GET") {
      const verdictMatch = /^\/permission-verdict\/([^/]+)$/.exec(pathname);
      if (verdictMatch && this.permissions) {
        const approvalId = decodeURIComponent(verdictMatch[1]);
        try {
          const verdict = await this.permissions.waitForVerdict(approvalId, 60_000);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(verdict ?? { empty: true }));
        } catch (error) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }
      response.writeHead(404).end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }

    if (pathname === "/permission-request" && this.permissions) {
      try {
        const body = await readRequestBody(request, 2 * 1024 * 1024);
        const parsed = JSON.parse(body) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("权限请求必须是 JSON 对象");
        }
        const { approvalId } = await this.permissions.register(parsed);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ accepted: true, approvalId }));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    if (pathname !== "/event") {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await readRequestBody(request, 20 * 1024 * 1024);
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("事件必须是 JSON 对象");
      }
      const event = await this.normalizeEvent(parsed as Record<string, unknown>);
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
      if (event) {
        void this.onEvent(event);
      }
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
  }
}

function readRequestBody(request: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Hook 事件超过 20 MiB 限制"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
