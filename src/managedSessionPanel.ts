import * as vscode from "vscode";
import { SessionBrokerClient } from "./brokerClient";
import { AgentSession, RemoteExecutionPolicy } from "./types";

export class ManagedSessionPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private running: AbortController | undefined;

  public constructor(
    private readonly client: SessionBrokerClient,
    private readonly session: AgentSession,
    private readonly policy: () => RemoteExecutionPolicy,
    onDispose?: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "feishuAgentNotifier.managedSession",
      `Codex · ${session.alias || session.name || session.project}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = panelHtml(this.panel.webview, session);
    this.panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      void this.handleMessage(message);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      onDispose?.();
    });
    this.pollTimer = setInterval(() => void this.publishState(), 1_000);
    this.pollTimer.unref();
    void this.publishState();
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "typing") {
      await this.client.noteLocalActivity(this.session.sessionId);
      return;
    }
    if (type === "send" || type === "steer") {
      const prompt = typeof message.prompt === "string" ? message.prompt.trim() : "";
      if (!prompt) {
        return;
      }
      if (type === "steer") {
        try {
          const turnId = await this.client.steer(this.session, prompt);
          this.post({ type: "notice", text: `已从 VS Code 本地追加到 turn ${turnId.slice(0, 8)}` });
        } catch (error) {
          this.post({ type: "error", text: (error as Error).message });
        }
        return;
      }
      if (this.running) {
        this.post({ type: "error", text: "当前本地 turn 尚未完成；请使用“追加”或等待结束。" });
        return;
      }
      const configuredPolicy = this.policy();
      if (configuredPolicy === "disabled") {
        this.post({ type: "error", text: "远程执行策略已禁用；请先在扩展设置中启用 planOnly 或 inherit。" });
        return;
      }
      this.running = new AbortController();
      this.post({ type: "user", text: prompt, origin: "VS Code 本地" });
      this.post({ type: "running", value: true });
      try {
        const result = await this.client.runTurn(
          this.session,
          prompt,
          configuredPolicy,
          this.running.signal,
          30 * 60_000,
          "local"
        );
        this.post({ type: "assistant", text: result.outputTail || "（本轮已完成，无文本输出）", origin: "Codex" });
      } catch (error) {
        this.post({ type: "error", text: (error as Error).message });
      } finally {
        this.running = undefined;
        this.post({ type: "running", value: false });
        await this.publishState();
      }
      return;
    }
    if (type === "cancel") {
      this.running?.abort();
      await this.client.interruptSession(this.session.sessionId).catch(() => false);
      return;
    }
    if (type === "takeover") {
      await this.client.releaseUnknownTurn(this.session.sessionId);
      this.post({ type: "notice", text: "已确认旧 turn 不再运行；会话已恢复为空闲，可重新输入。" });
      await this.publishState();
      return;
    }
    if (type === "approval") {
      const approvalId = typeof message.approvalId === "string" ? message.approvalId : "";
      const decision = message.decision === "accept" ? "accept" : "decline";
      try {
        await this.client.resolveApproval(approvalId, decision, "local");
        this.post({ type: "notice", text: `审批已由 VS Code 本地${decision === "accept" ? "允许" : "拒绝"}。` });
      } catch (error) {
        this.post({ type: "error", text: (error as Error).message });
      }
    }
  }

  private async publishState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const snapshot = await this.client.refresh();
      const handoff = snapshot.handoffs.find((item) => item.sessionId === this.session.sessionId);
      this.post({
        type: "state",
        handoff,
        approvals: snapshot.pendingApprovals.filter((item) => !item.sessionId || item.sessionId === this.session.sessionId)
      });
    } catch (error) {
      this.post({ type: "brokerError", text: (error as Error).message });
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }
}

function panelHtml(webview: vscode.Webview, session: AgentSession): string {
  const nonce = Math.random().toString(36).slice(2);
  const escapedName = escapeHtml(session.alias || session.name || session.project || "未命名会话");
  const escapedId = escapeHtml(session.sessionId);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;max-width:980px;margin:auto}.top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{border:1px solid var(--vscode-widget-border);border-radius:99px;padding:3px 9px}.muted{color:var(--vscode-descriptionForeground)}#log{margin:16px 0;min-height:220px}.msg{border-left:3px solid var(--vscode-textLink-foreground);padding:8px 12px;margin:9px 0;white-space:pre-wrap}.user{border-color:var(--vscode-testing-iconPassed)}.error{border-color:var(--vscode-errorForeground)}textarea{box-sizing:border-box;width:100%;min-height:110px;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}button{margin:8px 8px 0 0;padding:6px 13px}.approval{border:1px solid var(--vscode-widget-border);padding:10px;margin:8px 0}
</style></head><body>
<h2>${escapedName}</h2><div class="muted">Session ID：<code>${escapedId}</code></div>
<div class="top"><span id="broker" class="pill">Broker 连接中</span><span id="handoff" class="pill">交接状态未知</span><span id="origin" class="pill">输入来源：未标记</span></div>
<div id="approvals"></div><div id="log"></div>
<textarea id="prompt" placeholder="在这里输入；飞书与本面板共同使用同一个 Broker 会话。Ctrl+Enter 发送。"></textarea>
<div><button id="send">发送</button><button id="steer">追加到当前 turn</button><button id="cancel">中断</button><button id="takeover" hidden>确认旧 turn 已终止并接管</button></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), prompt=document.getElementById('prompt'), log=document.getElementById('log');let typingTimer;
function post(type,extra={}){vscode.postMessage({type,...extra})}function add(kind,text,origin){const el=document.createElement('div');el.className='msg '+kind;const head=document.createElement('strong');head.textContent=(origin||kind)+'\n';el.append(head,document.createTextNode(text));log.append(el);el.scrollIntoView();}
prompt.addEventListener('input',()=>{clearTimeout(typingTimer);typingTimer=setTimeout(()=>post('typing'),150)});
document.getElementById('send').onclick=()=>{post('send',{prompt:prompt.value});prompt.value=''};document.getElementById('steer').onclick=()=>{post('steer',{prompt:prompt.value});prompt.value=''};document.getElementById('cancel').onclick=()=>post('cancel');document.getElementById('takeover').onclick=()=>post('takeover');prompt.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();document.getElementById('send').click()}});
window.addEventListener('message',({data:m})=>{if(m.type==='state'){document.getElementById('broker').textContent='Broker 已连接';const h=m.handoff;document.getElementById('handoff').textContent=!h?'空闲':h.turnState==='unknown'?'状态需核验':h.authority==='local'?'本地优先':h.authority==='remote'?'远程接管':'空闲';document.getElementById('takeover').hidden=h?.turnState!=='unknown';document.getElementById('origin').textContent='输入来源：'+(!h?.inputOrigin?'未标记':h.inputOrigin==='local'?'VS Code 本地':'飞书远程');const box=document.getElementById('approvals');box.replaceChildren();for(const a of m.approvals||[]){const el=document.createElement('div');el.className='approval';const t=document.createElement('div');t.textContent='权限审批 '+a.approvalId+'：'+a.summary;const yes=document.createElement('button');yes.textContent='允许';yes.onclick=()=>post('approval',{approvalId:a.approvalId,decision:'accept'});const no=document.createElement('button');no.textContent='拒绝';no.onclick=()=>post('approval',{approvalId:a.approvalId,decision:'decline'});el.append(t,yes,no);box.append(el)}}else if(m.type==='user'||m.type==='assistant')add(m.type,m.text,m.origin);else if(m.type==='error'||m.type==='brokerError')add('error',m.text,'错误');else if(m.type==='notice')add('notice',m.text,'状态')});
</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] as string);
}
