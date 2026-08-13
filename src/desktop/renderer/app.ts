import type { ChannelConfiguration } from "../../channels/types";
import type { DesktopSnapshot, EditableChannel, SchemaProperty } from "./global";

type View = "overview" | "sessions" | "channels" | "system";

let snapshot: DesktopSnapshot;
let currentView: View = "overview";
let editingChannel: string | undefined;
let editableChannel: EditableChannel | undefined;
let pendingSnapshotRender = false;

interface FormDraftField {
  value: string;
  checked?: boolean;
}

const formDrafts = new Map<string, Record<string, FormDraftField>>();

const root = document.querySelector<HTMLElement>("#app")!;

void window.agentLink.snapshot().then((value) => {
  snapshot = value;
  render();
});
window.agentLink.onSnapshot((value) => {
  snapshot = value;
  if (formHasFocus()) {
    pendingSnapshotRender = true;
    return;
  }
  render();
});

function render(): void {
  root.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">A</span><div><strong>Agent Link</strong><small>Local middleware</small></div></div>
      <nav>
        ${navButton("overview", "总览", "⌁")}
        ${navButton("sessions", "会话", "◫")}
        ${navButton("channels", "Channels", "↗")}
        ${navButton("system", "系统", "⚙")}
      </nav>
      <div class="sidebar-foot"><span class="pulse ${snapshot.broker.state === "ready" ? "ok" : "warn"}"></span><div><strong>${escapeHtml(snapshot.broker.state)}</strong><small>Broker · v${escapeHtml(snapshot.version)}</small></div></div>
    </aside>
    <main class="content">
      ${renderView()}
    </main>`;
  bindCommon();
  bindView();
  restoreFormDraft();
}

function navButton(view: View, label: string, icon: string): string {
  return `<button class="nav-item ${currentView === view ? "active" : ""}" data-view="${view}"><span>${icon}</span>${label}</button>`;
}

function renderView(): string {
  if (currentView === "sessions") return renderSessions();
  if (currentView === "channels") return renderChannels();
  if (currentView === "system") return renderSystem();
  return renderOverview();
}

function renderOverview(): string {
  const connectedChannels = snapshot.channels.filter((item) => item.enabled && item.state === "connected").length;
  const ready = snapshot.broker.state === "ready";
  return `
    ${pageHeader("总览", "Agent、会话与远程通道。", `<button class="button secondary" id="refresh-broker">刷新</button>`)}
    <section class="status-summary ${ready ? "ready" : "warn"}">
      <span class="big-dot ${ready ? "ok" : "warn"}"></span>
      <div><strong>${ready ? "服务正常" : "服务未就绪"}</strong><small>Broker ${escapeHtml(snapshot.broker.state)} · Codex ${escapeHtml(snapshot.broker.codexState)}</small></div>
      <div class="summary-count"><strong>${snapshot.broker.activeTurns}</strong><small>执行中</small></div>
      <div class="summary-count"><strong>${connectedChannels}/${snapshot.channels.length}</strong><small>通道在线</small></div>
      <div class="summary-count"><strong>${snapshot.sessions.length}</strong><small>会话</small></div>
    </section>
    <section class="grid two">
      <article class="panel"><div class="panel-title"><h3>Agent</h3><span>${snapshot.agents.filter((agent) => agent.available).length} 可用</span></div>${snapshot.agents.map(agentRow).join("")}</article>
      <article class="panel"><div class="panel-title"><h3>Channel 状态</h3><button class="text-button" data-view="channels">管理</button></div>${snapshot.channels.map(channelRow).join("") || empty("尚未安装 Channel")}</article>
    </section>
    ${snapshot.broker.error ? `<div class="notice error"><strong>Broker 错误</strong>${escapeHtml(snapshot.broker.error)}</div>` : ""}`;
}

function renderSessions(): string {
  return `
    ${pageHeader("会话", "由 Agent Link 统一发现并持久化的 Codex / Claude Code 会话。")}
    <section class="panel table-panel">
      <div class="table-head"><span>会话</span><span>Agent</span><span>状态</span><span>归属</span><span>最后活动</span></div>
      ${snapshot.sessions.map((session) => `<div class="table-row">
        <div><strong>${escapeHtml(session.alias || session.name || session.project)}</strong><small>${escapeHtml(session.sessionId)}</small></div>
        <span>${escapeHtml(agentName(session.source))}</span>
        <span><i class="status-dot ${session.status}"></i>${escapeHtml(session.status)}</span>
        <span>${escapeHtml(session.ownership || "external")}</span>
        <time>${formatTime(session.lastSeenAt)}</time>
      </div>`).join("") || empty("还没有发现会话。启动一次 Codex 或 Claude Code 后会自动出现。")}
    </section>`;
}

function renderChannels(): string {
  if (editingChannel && editableChannel) {
    const channel = snapshot.channels.find((item) => item.manifest.id === editingChannel);
    return channel ? renderChannelEditor(channel) : "";
  }
  return `
    ${pageHeader("Channels", "消息平台只是可插拔传输层；可以独立启停、测试和替换。")}
    <section class="channel-grid">
      ${snapshot.channels.map((channel) => `<article class="channel-card">
        <div class="channel-icon">${escapeHtml(channel.manifest.name.slice(0, 1))}</div>
        <div class="channel-main"><div class="panel-title"><h3>${escapeHtml(channel.manifest.name)}</h3><span>v${escapeHtml(channel.manifest.version)}</span></div>
          <p>${escapeHtml(channel.manifest.description)}</p>
          <div class="chips">${channel.manifest.capabilities.map((capability) => `<span>${escapeHtml(capability)}</span>`).join("")}</div>
        </div>
        <div class="channel-actions"><span class="state ${escapeHtml(channel.state)}">${escapeHtml(channel.state)}</span><button class="button secondary channel-edit" data-channel="${escapeHtml(channel.manifest.id)}">配置</button></div>
      </article>`).join("")}
      <article class="channel-card add-card"><div class="channel-icon muted">+</div><div class="channel-main"><h3>安装第三方 Channel</h3><p>把符合 Channel API v1 的插件放入数据目录即可接入 Telegram、企业微信、Slack 或自定义服务。</p></div><span class="tag">API v1</span></article>
    </section>`;
}

function renderChannelEditor(channel: DesktopSnapshot["channels"][number]): string {
  const schema = channel.manifest.configSchema?.properties ?? {};
  const configuration = editableChannel!.configuration;
  return `
    ${pageHeader(`${channel.manifest.name} 配置`, "配置由 Channel 自己声明；密钥使用操作系统安全存储加密。", `<button class="button secondary" id="channel-back">返回</button>`)}
    <form class="panel form" id="channel-form" data-draft-key="channel:${escapeHtml(channel.manifest.id)}">
      <label class="toggle-line"><div><strong>启用 Channel</strong><small>关闭后不会建立连接或投递消息</small></div><input type="checkbox" name="enabled" ${configuration.enabled ? "checked" : ""}><span class="toggle"></span></label>
      <div class="form-grid">${Object.entries(schema).map(([key, property]) => field(key, property, configuration.config[key], editableChannel!.secretConfigured.includes(key))).join("")}</div>
      <div class="form-actions"><button type="button" class="button secondary" id="channel-test" ${configuration.enabled ? "" : "disabled"}>发送测试</button><button type="submit" class="button primary">保存并应用</button></div>
      <p class="form-status" id="form-status"></p>
    </form>`;
}

function renderSystem(): string {
  return `
    ${pageHeader("系统", "运行策略与本地数据。")}
    <section class="grid two">
      <article class="panel setting"><div><h3>数据目录</h3><p>普通配置、会话索引和日志保存在这里；系统目录只保存这一位置指针。</p><code>${escapeHtml(snapshot.dataDirectory)}</code></div><div class="button-row"><button class="button secondary" id="open-data">打开</button><button class="button primary" id="choose-data">更改</button></div></article>
      <article class="panel setting"><div><h3>Session Broker</h3><p>状态：${escapeHtml(snapshot.broker.state)} · Codex App Server：${escapeHtml(snapshot.broker.codexState)}</p><code>${snapshot.broker.activeTurns} active turns</code></div><button class="button secondary" id="refresh-broker">重新检查</button></article>
    </section>
    <form class="panel form system-form" id="system-form" data-draft-key="system">
      <div class="panel-title"><h3>远程执行</h3><span>白名单生效</span></div>
      <div class="form-grid">
        <label class="field"><span>执行策略</span><select name="remoteExecutionPolicy">
          <option value="disabled" ${snapshot.settings.remoteExecutionPolicy === "disabled" ? "selected" : ""}>关闭</option>
          <option value="planOnly" ${snapshot.settings.remoteExecutionPolicy === "planOnly" ? "selected" : ""}>只读</option>
          <option value="inherit" ${snapshot.settings.remoteExecutionPolicy === "inherit" ? "selected" : ""}>跟随当前会话</option>
          <option value="fullAccess" ${snapshot.settings.remoteExecutionPolicy === "fullAccess" ? "selected" : ""}>完全访问</option>
        </select><small>跟随会话不覆盖权限；完全访问会跳过审批和沙箱。</small></label>
        <label class="field"><span>新会话默认工作目录</span><input name="defaultWorkspace" value="${escapeHtml(snapshot.settings.defaultWorkspace)}" placeholder="D:\\code\\project"><small>仅用于 /new；历史会话使用自身目录</small></label>
        <label class="field"><span>Hook Receiver 端口</span><input name="receiverPort" type="number" min="1024" max="65535" value="${snapshot.settings.receiverPort}"><small>修改后需重启并重新安装 Agent 接入</small></label>
      </div>
      <div class="form-actions"><button class="button secondary" type="button" id="install-hooks">安装 / 更新 Agent 接入</button><button class="button primary" type="submit">保存系统策略</button></div>
      <p class="form-status" id="form-status"></p>
    </form>
    <details class="panel logs"><summary>最近日志 <span>仅本机</span></summary><div class="log-list">${snapshot.logs.slice().reverse().map((entry) => `<div><time>${formatTime(entry.at)}</time><span class="log-level ${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span><p>${escapeHtml(entry.message)}</p></div>`).join("") || empty("暂无日志")}</div></details>`;
}

function field(key: string, property: SchemaProperty, value: unknown, configured: boolean): string {
  const title = LABELS[key] ?? key;
  const hint = property.secret && configured ? "已安全保存；留空保持不变" : "";
  if (property.type === "boolean") {
    const checked = typeof value === "boolean" ? value : property.default === true;
    return `<label class="field checkbox"><span>${escapeHtml(title)}</span><input name="${escapeHtml(key)}" data-type="boolean" type="checkbox" ${checked ? "checked" : ""}></label>`;
  }
  if (property.enum) {
    return `<label class="field"><span>${escapeHtml(title)}</span><select name="${escapeHtml(key)}">${property.enum.map((entry) => `<option value="${escapeHtml(entry)}" ${value === entry ? "selected" : ""}>${escapeHtml(entry)}</option>`).join("")}</select></label>`;
  }
  if (property.type === "array") {
    const text = Array.isArray(value) ? value.join("\n") : "";
    return `<label class="field wide"><span>${escapeHtml(title)}</span><textarea name="${escapeHtml(key)}" data-type="array" rows="3">${escapeHtml(text)}</textarea></label>`;
  }
  if (property.type === "integer" || property.type === "number") {
    return `<label class="field"><span>${escapeHtml(title)}</span><input name="${escapeHtml(key)}" data-type="number" type="number" min="${property.minimum ?? ""}" max="${property.maximum ?? ""}" value="${escapeHtml(String(value ?? property.default ?? ""))}"><small></small></label>`;
  }
  return `<label class="field"><span>${escapeHtml(title)}</span><input name="${escapeHtml(key)}" type="${property.secret ? "password" : "text"}" value="${property.secret ? "" : escapeHtml(String(value ?? property.default ?? ""))}" placeholder="${escapeHtml(hint)}"><small>${escapeHtml(hint)}</small></label>`;
}

function bindCommon(): void {
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => {
    currentView = element.dataset.view as View;
    editingChannel = undefined;
    editableChannel = undefined;
    render();
  }));
}

function bindView(): void {
  document.querySelector("#refresh-broker")?.addEventListener("click", () => run(window.agentLink.refreshBroker()));
  document.querySelector("#open-data")?.addEventListener("click", () => void window.agentLink.openDataDirectory());
  document.querySelector("#choose-data")?.addEventListener("click", () => void window.agentLink.chooseDataDirectory().then((selected) => {
    if (selected) alert(`已保存新目录，重启 Agent Link 后生效：\n${selected}`);
  }));
  document.querySelectorAll<HTMLElement>(".channel-edit").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.channel!;
    void window.agentLink.channelConfiguration(id).then((configuration) => {
      editingChannel = id;
      editableChannel = configuration;
      render();
    });
  }));
  document.querySelector("#channel-back")?.addEventListener("click", () => {
    if (editingChannel) formDrafts.delete(`channel:${editingChannel}`);
    editingChannel = undefined;
    editableChannel = undefined;
    render();
  });
  document.querySelector("#channel-test")?.addEventListener("click", () => {
    if (editingChannel) run(window.agentLink.testChannel(editingChannel), "测试消息已发送");
  });
  const channelForm = document.querySelector<HTMLFormElement>("#channel-form");
  bindFormDraft(channelForm);
  channelForm?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | null;
    if (input?.name === "enabled") {
      const testButton = document.querySelector<HTMLButtonElement>("#channel-test");
      if (testButton) testButton.disabled = !input.checked;
    }
  });
  channelForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editingChannel || !editableChannel) return;
    const form = event.currentTarget as HTMLFormElement;
    const next: ChannelConfiguration = { enabled: new FormData(form).has("enabled"), config: {} };
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]:not([name=enabled])").forEach((input) => {
      if (input.dataset.type === "boolean") next.config[input.name] = (input as HTMLInputElement).checked;
      else if (input.dataset.type === "array") next.config[input.name] = input.value.split(/\r?\n|,/).map((value: string) => value.trim()).filter(Boolean);
      else if (input.dataset.type === "number") next.config[input.name] = Number(input.value);
      else next.config[input.name] = input.value;
    });
    const channelId = editingChannel;
    void run(window.agentLink.saveChannel(channelId, next), "配置已应用").then((saved) => {
      if (!saved) return;
      formDrafts.delete(`channel:${channelId}`);
      editableChannel = undefined;
      editingChannel = undefined;
      currentView = "channels";
      render();
    });
  });
  const systemForm = document.querySelector<HTMLFormElement>("#system-form");
  bindFormDraft(systemForm);
  systemForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const policy = data.get("remoteExecutionPolicy") as DesktopSnapshot["settings"]["remoteExecutionPolicy"];
    if (policy === "fullAccess"
      && snapshot.settings.remoteExecutionPolicy !== "fullAccess"
      && !confirm("完全访问会跳过 Agent 审批和沙箱。只应对完全可信的白名单用户启用。继续吗？")) {
      return;
    }
    void run(window.agentLink.saveSettings({
      remoteExecutionPolicy: policy,
      defaultWorkspace: String(data.get("defaultWorkspace") ?? ""),
      receiverPort: Number(data.get("receiverPort"))
    }), "系统策略已保存").then((saved) => {
      if (saved) formDrafts.delete("system");
    });
  });
  document.querySelector("#install-hooks")?.addEventListener("click", () => {
    const status = document.querySelector<HTMLElement>("#form-status");
    void window.agentLink.installHooks().then((inspection) => {
      if (status) status.textContent = inspection.codexInstalled && inspection.claudeStopInstalled
        ? "Codex 与 Claude Code 接入已安装"
        : "接入已写入，但部分 Agent 版本未报告完整 hook";
    }).catch((error) => {
      if (status) { status.textContent = error instanceof Error ? error.message : String(error); status.classList.add("error-text"); }
    });
  });
}

async function run(action: Promise<DesktopSnapshot>, success?: string): Promise<boolean> {
  const status = document.querySelector<HTMLElement>("#form-status");
  try {
    snapshot = await action;
    if (status && success) status.textContent = success;
    else render();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (status) { status.textContent = message; status.classList.add("error-text"); }
    else alert(message);
    return false;
  }
}

function bindFormDraft(form: HTMLFormElement | null): void {
  if (!form) return;
  const capture = () => captureFormDraft(form);
  form.addEventListener("input", capture);
  form.addEventListener("change", capture);
  form.addEventListener("focusout", () => queueMicrotask(() => {
    if (!pendingSnapshotRender || formHasFocus()) return;
    pendingSnapshotRender = false;
    render();
  }));
}

function captureFormDraft(form: HTMLFormElement): void {
  const key = form.dataset.draftKey;
  if (!key) return;
  const fields: Record<string, FormDraftField> = {};
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]").forEach((input) => {
    fields[input.name] = {
      value: input.value,
      ...("checked" in input ? { checked: input.checked } : {})
    };
  });
  formDrafts.set(key, fields);
}

function restoreFormDraft(): void {
  const form = document.querySelector<HTMLFormElement>("form[data-draft-key]");
  const key = form?.dataset.draftKey;
  if (!form || !key) return;
  const fields = formDrafts.get(key);
  if (!fields) return;
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]").forEach((input) => {
    const field = fields[input.name];
    if (!field) return;
    input.value = field.value;
    if ("checked" in input && field.checked !== undefined) input.checked = field.checked;
  });
  const enabled = form.elements.namedItem("enabled");
  const testButton = document.querySelector<HTMLButtonElement>("#channel-test");
  if (enabled instanceof HTMLInputElement && testButton) testButton.disabled = !enabled.checked;
}

function formHasFocus(): boolean {
  return document.activeElement instanceof HTMLElement
    && Boolean(document.activeElement.closest("form[data-draft-key]"));
}

function pageHeader(title: string, subtitle: string, action = ""): string {
  return `<header class="page-header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${action}</header>`;
}

function agentRow(agent: DesktopSnapshot["agents"][number]): string {
  return `<div class="list-row"><span class="agent-logo ${agent.id}">${agent.id === "codex" ? "C" : "AI"}</span><div><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.executable || "未发现")}</small></div><span class="state ${agent.available ? "connected" : "failed"}">${agent.available ? "可用" : "未发现"}</span></div>`;
}

function channelRow(channel: DesktopSnapshot["channels"][number]): string {
  return `<div class="list-row"><span class="channel-mini">${escapeHtml(channel.manifest.name.slice(0, 1))}</span><div><strong>${escapeHtml(channel.manifest.name)}</strong><small>${escapeHtml(channel.detail || channel.manifest.description)}</small></div><span class="state ${escapeHtml(channel.state)}">${escapeHtml(channel.state)}</span></div>`;
}

function empty(message: string): string { return `<div class="empty">${escapeHtml(message)}</div>`; }
function agentName(source: string): string { return source === "claude-code" ? "Claude Code" : source === "codex" ? "Codex" : source; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false }); }
function escapeHtml(value: string): string { return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!); }

const LABELS: Record<string, string> = {
  deliveryMode: "发送模式", webhookUrl: "Webhook URL", webhookSecret: "Webhook Secret",
  appId: "App ID", appSecret: "App Secret", receiveIdType: "目标 ID 类型", receiveId: "目标 ID",
  messageFormat: "消息格式", inboundEnabled: "启用双向消息", allowedUserOpenIds: "用户 Open ID 白名单",
  allowedChatIds: "群聊 Chat ID 白名单", requireGroupMention: "群聊必须 @机器人",
  includeMetadata: "包含会话元数据", maxChunkCharacters: "单条消息字符上限", notifyOnFailure: "失败时通知",
  deliveryMaxAttempts: "最大重试次数", retryBaseDelayMs: "重试基础延迟（ms）"
};
