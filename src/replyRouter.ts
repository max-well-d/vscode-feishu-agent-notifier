import path from "node:path";
import crypto from "node:crypto";
import { AgentReplyQueue } from "./agentReply";
import { SessionRegistry } from "./sessionRegistry";
import { AgentSession, InboundReplyContext, RemoteExecutionPolicy } from "./types";

export interface ReplyRouterOptions {
  registry: SessionRegistry;
  queue: AgentReplyQueue;
  policy: () => RemoteExecutionPolicy;
  refreshSessions: () => Promise<void>;
  reply: (message: InboundReplyContext, text: string) => Promise<string | undefined | void>;
  status: () => string;
  defaultWorkspace: () => { cwd: string; project: string } | undefined;
  createManagedCodexSession?: (
    cwd: string,
    project: string,
    policy: RemoteExecutionPolicy
  ) => Promise<AgentSession>;
  steerManagedCodex?: (session: AgentSession, prompt: string) => Promise<string>;
}

export class ReplyRouter {
  public constructor(private readonly options: ReplyRouterOptions) {}

  public async handle(message: InboundReplyContext): Promise<void> {
    if (!await this.options.registry.claimInbound(message.messageId)) {
      return;
    }
    const text = message.text.trim();
    if (!text) {
      await this.options.reply(message, "回复内容不能为空。发送 /help 查看用法。");
      return;
    }
    if (text.startsWith("/")) {
      await this.handleCommand(message, text);
      return;
    }
    const session = await this.resolveContextSession(message);
    if (!session) {
      await this.options.reply(message, "无法确定目标会话。请引用一条 Agent 通知，或先发送 /sessions 和 /use。 ");
      return;
    }
    await this.enqueue(message, session, text);
  }

  private async handleCommand(message: InboundReplyContext, text: string): Promise<void> {
    const [command, ...rest] = text.split(/\s+/);
    switch (command.toLocaleLowerCase()) {
      case "/help":
        await this.options.reply(message, helpText());
        return;
      case "/status":
        await this.options.reply(message, this.options.status());
        return;
      case "/sessions":
        await this.options.refreshSessions();
        await this.options.reply(message, formatSessions(await this.options.registry.listSessions(10)));
        return;
      case "/use": {
        await this.options.refreshSessions();
        const session = await this.resolveSelector(rest.join(" "));
        if (!session) {
          await this.options.reply(message, "未找到该会话。发送 /sessions 查看最近会话。 ");
          return;
        }
        await this.options.registry.selectForChat(message.chatId, session);
        await this.options.reply(message, `已选择 ${formatSession(session)}。后续普通文本将发送到该会话。`);
        return;
      }
      case "/alias": {
        const session = await this.resolveContextSession(message);
        if (!session) {
          await this.options.reply(message, "请引用一条 Agent 通知，或先用 /use 选择会话。 ");
          return;
        }
        const alias = rest.join(" ").trim();
        if (!alias) {
          await this.options.reply(message, "用法：/alias <名称>");
          return;
        }
        try {
          await this.options.registry.setAlias(session, alias);
          await this.options.reply(message, `会话别名已设置为：${alias}`);
        } catch (error) {
          await this.options.reply(message, `设置别名失败：${(error as Error).message}`);
        }
        return;
      }
      case "/send": {
        await this.options.refreshSessions();
        const joined = rest.join(" ").trim();
        const separator = joined.indexOf(" ");
        if (separator < 1) {
          await this.options.reply(message, "用法：/send <序号|别名|session-id> <内容>");
          return;
        }
        const session = await this.resolveSelector(joined.slice(0, separator));
        if (!session) {
          await this.options.reply(message, "未找到目标会话。发送 /sessions 查看最近会话。 ");
          return;
        }
        await this.enqueue(message, session, joined.slice(separator + 1));
        return;
      }
      case "/new": {
        const sourceName = rest.shift()?.toLocaleLowerCase();
        const prompt = rest.join(" ").trim();
        const workspace = this.options.defaultWorkspace();
        if (!workspace || !prompt || !["codex", "claude", "claude-code", "cc"].includes(sourceName ?? "")) {
          await this.options.reply(message, "用法：/new <codex|cc> <内容>。需要先在 VS Code 打开目标工作区。 ");
          return;
        }
        const policy = this.options.policy();
        if (policy === "disabled") {
          await this.options.reply(message, "飞书远程回复已禁用。请在 VS Code 设置中启用后重试。 ");
          return;
        }
        let session: AgentSession;
        if (sourceName === "codex") {
          if (!this.options.createManagedCodexSession) {
            await this.options.reply(message, "Codex App Server 托管执行器不可用。请运行插件自检。 ");
            return;
          }
          try {
            session = await this.options.createManagedCodexSession(workspace.cwd, workspace.project, policy);
          } catch (error) {
            await this.options.reply(message, `创建托管 Codex 会话失败：${(error as Error).message}`);
            return;
          }
        } else {
          session = {
            source: "claude-code",
            sessionId: `new:${crypto.randomUUID()}`,
            cwd: workspace.cwd,
            project: workspace.project,
            lastSeenAt: new Date().toISOString(),
            status: "completed",
            ownership: "managed",
            completionEvidence: "authoritative",
            managedBackend: "claude-cli"
          };
          await this.options.registry.recordManagedSession(session);
        }
        await this.options.registry.selectForChat(message.chatId, session);
        await this.enqueue(message, session, prompt);
        return;
      }
      case "/steer": {
        const session = await this.resolveContextSession(message);
        const prompt = rest.join(" ").trim();
        if (!session || !prompt) {
          await this.options.reply(message, "用法：引用正在运行的托管 Codex 消息并发送 /steer <追加指令>");
          return;
        }
        if (session.source !== "codex"
          || session.ownership !== "managed"
          || session.managedBackend !== "codex-app-server"
          || !this.options.steerManagedCodex) {
          await this.options.reply(message, "/steer 仅支持由飞书 /new 创建且正在运行的托管 Codex 会话。 ");
          return;
        }
        try {
          const turnId = await this.options.steerManagedCodex(session, prompt);
          const replyId = await this.options.reply(message, `已追加到当前 Codex turn（${turnId.slice(0, 8)}）。`);
          if (replyId) {
            await this.options.registry.recordMessageRoute(replyId, session);
          }
        } catch (error) {
          await this.options.reply(message, `追加失败：${(error as Error).message}`);
        }
        return;
      }
      case "/cancel": {
        const count = this.options.queue.cancelForChat(message.chatId);
        await this.options.reply(message, count > 0 ? `已取消 ${count} 个运行中或排队任务。` : "当前会话没有可取消任务。 ");
        return;
      }
      default:
        await this.options.reply(message, `未知命令：${command}\n\n${helpText()}`);
    }
  }

  private async enqueue(message: InboundReplyContext, session: AgentSession, prompt: string): Promise<void> {
    const policy = this.options.policy();
    if (policy === "disabled") {
      await this.options.reply(message, "飞书远程回复已禁用。请在 VS Code 设置中启用后重试。 ");
      return;
    }
    if (!session.cwd) {
      await this.options.reply(message, "该历史会话没有可用的工作目录，无法安全恢复。 ");
      return;
    }
    const ownership = session.ownership ?? "external";
    if (ownership === "external" && session.completionEvidence !== "authoritative") {
      await this.options.reply(message,
        "该会话仅由本地文件发现，尚无权威完成事件。为避免与 VS Code/CLI 同时续写，请引用一条“已完成”通知后再回复。"
      );
      return;
    }
    if (!session.sessionId.startsWith("new:")) {
      await this.options.registry.selectForChat(message.chatId, session);
    }
    let result;
    try {
      result = this.options.queue.enqueue({
        chatId: message.chatId,
        inboundMessageId: message.messageId,
        session,
        prompt,
        policy
      });
    } catch (error) {
      await this.options.reply(message, `无法加入队列：${(error as Error).message}`);
      return;
    }
    void result.completion.catch(() => undefined);
    const waiting = session.status === "progress" || result.position > 1;
    const replyId = await this.options.reply(message,
      `${waiting ? "已排队" : "已接收"}：${formatSession(session)}\n`
      + `策略：${policy === "planOnly" ? "只读规划" : "继承本机权限"}`
      + `\n会话：${ownership === "managed" ? "飞书托管" : "外部完成后续写"}`
      + `${waiting ? `\n队列位置：${result.position}` : ""}`
    );
    if (replyId) {
      await this.options.registry.recordMessageRoute(replyId, session);
    }
  }

  private async resolveContextSession(message: InboundReplyContext): Promise<AgentSession | undefined> {
    return await this.options.registry.resolveMessage(message.parentMessageId)
      ?? await this.options.registry.resolveMessage(message.rootMessageId)
      ?? await this.options.registry.selectedForChat(message.chatId);
  }

  private async resolveSelector(selector: string): Promise<AgentSession | undefined> {
    const trimmed = selector.trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    if (Number.isInteger(numeric) && numeric > 0) {
      return (await this.options.registry.listSessions(50))[numeric - 1];
    }
    return this.options.registry.getSession(trimmed);
  }
}

function formatSessions(sessions: AgentSession[]): string {
  if (sessions.length === 0) {
    return "尚未发现可恢复的本地 Codex 或 Claude Code 会话。";
  }
  return [
    "最近会话：",
    ...sessions.map((session, index) => {
      const ownership = session.ownership === "managed" ? "托管" : "外部";
      const state = session.status === "progress"
        ? "运行中"
        : session.completionEvidence === "authoritative" ? "已确认完成" : "未确认完成";
      return `${index + 1}. ${formatSession(session)} · ${ownership}/${state} · ${formatTime(session.lastSeenAt)}`;
    }),
    "",
    "使用 /use <序号|别名|session-id> 选择，或 /send <目标> <内容> 直接发送。"
  ].join("\n");
}

function formatSession(session: AgentSession): string {
  const name = session.alias || session.project || path.basename(session.cwd) || session.sessionId.slice(0, 8);
  const source = session.source === "claude-code" ? "Claude Code" : "Codex";
  return `${source}/${name} (${session.sessionId.slice(0, 8)})`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function helpText(): string {
  return [
    "飞书远程 Agent 回复：",
    "- 引用一条 Agent 通知并发送文本：继续对应会话",
    "- /sessions：列出最近本地会话",
    "- /use <目标>：选择当前聊天使用的会话",
    "- /send <目标> <内容>：直接发送到指定会话",
    "- /new <codex|cc> <内容>：在当前 VS Code 工作区创建新会话",
    "- /steer <内容>：追加到正在运行的托管 Codex turn",
    "- /alias <名称>：给当前会话设置别名",
    "- /status：查看连接和队列",
    "- /cancel：取消当前飞书聊天提交的任务",
    "- /help：显示此帮助"
  ].join("\n");
}
