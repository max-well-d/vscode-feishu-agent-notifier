import type { ChannelConfiguration } from "../../channels/types";
import type { DesktopSnapshot, EditableChannel, SchemaProperty } from "./global";
import { matchesVisibility } from "../uiModel";

type View = "overview" | "sessions" | "channels" | "system";
type ConfigSectionId = "connection" | "target" | "inbound" | "message" | "advanced";

interface FormDraftField { value: string; checked?: boolean }

const root = document.querySelector<HTMLElement>("#app")!;
const formDrafts = new Map<string, Record<string, FormDraftField>>();
let snapshot: DesktopSnapshot;
let currentView: View = "overview";
let editingChannel: string | undefined;
let editableChannel: EditableChannel | undefined;

void window.agentLink.snapshot().then((value) => {
  snapshot = value;
  renderShell();
  renderCurrentView();
});

window.agentLink.onSnapshot((value) => {
  snapshot = value;
  patchLiveUi();
});

window.agentLink.onNavigate((view) => navigate(view));
window.agentLink.onLog((entry) => {
  snapshot.logs = [...snapshot.logs.slice(-199), entry];
  if (currentView === "system") patchSystem();
});

function renderShell(): void {
  root.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">AL</span><div><strong>Agent Link</strong><small>本地 Agent 中间件</small></div></div>
      <nav aria-label="主导航">
        ${navButton("overview", "总览", "01")}
        ${navButton("sessions", "会话", "02")}
        ${navButton("channels", "消息通道", "03")}
        ${navButton("system", "系统设置", "04")}
      </nav>
      <div class="sidebar-foot">
        <span class="pulse" id="sidebar-state-dot"></span>
        <div><strong id="sidebar-state">正在连接</strong><small id="sidebar-version">Agent Link</small></div>
      </div>
    </aside>
    <main class="content" id="view-root"></main>`;
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => {
    navigate(element.dataset.view as View);
  }));
}

function navigate(view: View): void {
  currentView = view;
  editingChannel = undefined;
  editableChannel = undefined;
  renderCurrentView();
}

function renderCurrentView(): void {
  const viewRoot = document.querySelector<HTMLElement>("#view-root");
  if (!viewRoot) return;
  viewRoot.innerHTML = renderView();
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === currentView));
  bindView();
  restoreFormDraft();
  syncConditionalFields();
  patchLiveUi();
}

function navButton(view: View, label: string, index: string): string {
  return `<button class="nav-item" data-view="${view}"><span>${index}</span>${label}</button>`;
}

function renderView(): string {
  if (currentView === "sessions") return renderSessions();
  if (currentView === "channels") return renderChannels();
  if (currentView === "system") return renderSystem();
  return renderOverview();
}

function renderOverview(): string {
  return `
    ${pageHeader("运行总览", "检查本机 Agent、远程通道和当前任务。", `<button class="button secondary" id="refresh-broker">刷新状态</button>`)}
    <section class="health-banner" id="health-banner">
      <div class="health-icon"><span class="big-dot" id="health-dot"></span></div>
      <div class="health-copy"><strong id="health-title">正在检查服务</strong><p id="health-detail">连接本地 Broker 和消息通道…</p></div>
      <button class="button secondary" data-view="system">查看系统</button>
    </section>
    <section class="stat-grid" aria-label="运行指标">
      ${statCard("正在执行", "live-active", "0", "Agent turn")}
      ${statCard("通道在线", "live-channels", "0/0", "可用消息出口")}
      ${statCard("已发现会话", "live-sessions", "0", "Codex 与 Claude Code")}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-title"><div><h2>本机 Agent</h2><p>复用官方客户端和历史记录</p></div><span id="agent-count">0 可用</span></div><div id="agent-list"></div></article>
      <article class="panel"><div class="panel-title"><div><h2>消息通道</h2><p>通知和远程输入的连接状态</p></div><button class="text-button" data-view="channels">管理通道</button></div><div id="channel-summary-list"></div></article>
    </section>
    <div class="notice error" id="broker-error" hidden></div>`;
}

function renderSessions(): string {
  return `
    ${pageHeader("会话", "所有已发现并可被精确路由的本地 Agent 会话。")}
    <section class="panel table-panel">
      <div class="table-head"><span>名称与 Session ID</span><span>Agent</span><span>状态</span><span>控制端</span><span>最后活动</span></div>
      <div id="session-list"></div>
    </section>`;
}

function renderChannels(): string {
  if (editingChannel && editableChannel) {
    const channel = snapshot.channels.find((item) => item.manifest.id === editingChannel);
    return channel ? renderChannelEditor(channel) : "";
  }
  return `
    ${pageHeader("消息通道", "每个通道独立配置、启停和测试；凭据只保存在本机加密存储。")}
    <section class="channel-grid">
      ${snapshot.channels.map(channelCard).join("")}
      <article class="channel-card add-card"><div class="channel-icon muted">+</div><div class="channel-main"><h2>第三方 Channel</h2><p>将兼容 Channel API v1 的适配器放入数据目录，接入 Telegram、Slack、企业微信或自建服务。</p></div><span class="tag">API v1</span></article>
    </section>`;
}

function channelCard(channel: DesktopSnapshot["channels"][number]): string {
  return `<article class="channel-card" data-channel-card="${escapeHtml(channel.manifest.id)}">
    <div class="channel-icon">${escapeHtml(channel.manifest.name.slice(0, 1))}</div>
    <div class="channel-main"><div class="panel-title"><div><h2>${escapeHtml(channel.manifest.name)}</h2><p>${escapeHtml(channel.manifest.description)}</p></div><span>v${escapeHtml(channel.manifest.version)}</span></div>
      <div class="chips">${channel.manifest.capabilities.map((capability) => `<span>${capabilityLabel(capability)}</span>`).join("")}</div>
    </div>
    <div class="channel-actions"><span class="state" data-channel-state>${stateLabel(channel.state)}</span><button class="button secondary channel-edit" data-channel="${escapeHtml(channel.manifest.id)}">配置</button></div>
  </article>`;
}

function renderChannelEditor(channel: DesktopSnapshot["channels"][number]): string {
  const schema = channel.manifest.configSchema?.properties ?? {};
  const configuration = editableChannel!.configuration;
  return `
    <div class="breadcrumb"><button class="text-button" id="channel-back">消息通道</button><span>/</span><span>${escapeHtml(channel.manifest.name)}</span></div>
    ${pageHeader(`${channel.manifest.name} 设置`, "选择连接方式后，只显示该模式真正需要的配置。")}
    <form class="configuration-layout" id="channel-form" data-draft-key="channel:${escapeHtml(channel.manifest.id)}">
      <aside class="configuration-aside panel">
        <div class="channel-identity"><div class="channel-icon">${escapeHtml(channel.manifest.name.slice(0, 1))}</div><div><strong>${escapeHtml(channel.manifest.name)}</strong><small data-channel-editor-state>${stateLabel(channel.state)}</small></div></div>
        <label class="toggle-line compact"><div><strong>启用通道</strong><small>关闭后停止收发消息</small></div><input type="checkbox" name="enabled" ${configuration.enabled ? "checked" : ""}><span class="toggle"></span></label>
        <div class="aside-note"><strong>凭据安全</strong><p>Secret 字段通过操作系统安全存储加密。留空会保留已有值。</p></div>
      </aside>
      <div class="configuration-main">
        ${renderConfigSections(schema, configuration.config, editableChannel!.secretConfigured)}
        <div class="sticky-actions"><p class="form-status" id="form-status"></p><button type="button" class="button secondary" id="channel-test" ${configuration.enabled ? "" : "disabled"}>发送测试</button><button type="submit" class="button primary">保存更改</button></div>
      </div>
    </form>`;
}

function renderConfigSections(schema: Record<string, SchemaProperty>, values: Record<string, unknown>, configuredSecrets: string[]): string {
  const entries = Object.entries(schema).sort(([, a], [, b]) => (a.ui?.order ?? 999) - (b.ui?.order ?? 999));
  const sections: Array<[ConfigSectionId, string, string]> = [
    ["connection", "连接方式", "选择飞书接入类型并填写对应凭据。"],
    ["target", "默认通知目标", "自建应用主动发送消息时使用。"],
    ["inbound", "双向消息与白名单", "决定谁可以从飞书向本机 Agent 发送指令。"],
    ["message", "消息显示", "控制通知内容和渲染格式。"]
  ];
  const rendered = sections.map(([id, title, description]) => configSection(id, title, description, entries, values, configuredSecrets)).join("");
  const advanced = configSection("advanced", "高级投递", "仅在需要调整分片或重试策略时修改。", entries, values, configuredSecrets, true);
  const ungrouped = entries.filter(([, property]) => !property.ui?.section);
  return `${rendered}${ungrouped.length ? configSection(undefined, "其他设置", "由 Channel 适配器提供。", ungrouped, values, configuredSecrets) : ""}${advanced}`;
}

function configSection(
  id: ConfigSectionId | undefined,
  title: string,
  description: string,
  entries: Array<[string, SchemaProperty]>,
  values: Record<string, unknown>,
  configuredSecrets: string[],
  collapsible = false
): string {
  const fields = entries.filter(([, property]) => property.ui?.section === id || (id === undefined && !property.ui?.section));
  if (fields.length === 0) return "";
  const body = `<div class="section-fields">${fields.map(([key, property]) => field(key, property, values[key], configuredSecrets.includes(key))).join("")}</div>`;
  if (collapsible) {
    return `<details class="config-section advanced-section" data-config-section><summary><span><strong>${title}</strong><small>${description}</small></span></summary>${body}</details>`;
  }
  return `<section class="config-section panel" data-config-section><div class="section-heading"><h2>${title}</h2><p>${description}</p></div>${body}</section>`;
}

function renderSystem(): string {
  return `
    ${pageHeader("系统设置", "管理远程权限、本地服务和数据位置。")}
    <section class="system-grid">
      <form class="panel form system-form" id="system-form" data-draft-key="system">
        <div class="panel-title"><div><h2>远程执行权限</h2><p>此设置同时受 Channel 白名单约束</p></div><span>核心策略</span></div>
        <label class="field"><span>执行策略</span><select name="remoteExecutionPolicy">
          <option value="disabled" ${snapshot.settings.remoteExecutionPolicy === "disabled" ? "selected" : ""}>关闭远程执行</option>
          <option value="planOnly" ${snapshot.settings.remoteExecutionPolicy === "planOnly" ? "selected" : ""}>只读模式</option>
          <option value="inherit" ${snapshot.settings.remoteExecutionPolicy === "inherit" ? "selected" : ""}>跟随当前会话</option>
          <option value="fullAccess" ${snapshot.settings.remoteExecutionPolicy === "fullAccess" ? "selected" : ""}>完全访问</option>
        </select><small>推荐“跟随当前会话”。完全访问会跳过 Agent 审批和沙箱。</small></label>
        <label class="field"><span>新会话默认工作目录</span><input name="defaultWorkspace" value="${escapeHtml(snapshot.settings.defaultWorkspace)}" placeholder="D:\\code\\project"><small>只用于从消息端创建的新会话。</small></label>
        <label class="field"><span>Hook Receiver 端口</span><input name="receiverPort" data-type="number" type="number" min="1024" max="65535" value="${snapshot.settings.receiverPort}"><small>仅监听 127.0.0.1；修改后请更新 Agent 接入。</small></label>
        <label class="field"><span>消息投递时机</span><select name="deliveryTiming">
          <option value="realtime" ${snapshot.settings.deliveryTiming === "realtime" ? "selected" : ""}>实时逐条</option>
          <option value="completion" ${snapshot.settings.deliveryTiming === "completion" ? "selected" : ""}>仅任务结束</option>
        </select><small>仅任务结束在 Agent 完成或失败时发送最后一条消息；保存后即时生效，也可在托盘「通知模式」切换。</small></label>
        <div class="form-actions"><button class="button primary" type="submit">保存权限设置</button></div><p class="form-status" id="form-status"></p>
      </form>
      <section class="panel service-panel"><div class="panel-title"><div><h2>本地服务</h2><p>只监听本机回环地址</p></div><span id="system-broker-state">检查中</span></div>
        <dl class="service-list"><div><dt>Session Broker</dt><dd id="system-broker-detail">-</dd></div><div><dt>Hook Receiver</dt><dd id="system-receiver">127.0.0.1:${snapshot.settings.receiverPort}</dd></div><div><dt>活动 Turn</dt><dd id="system-active-turns">0</dd></div></dl>
        <div class="button-row"><button class="button secondary" id="refresh-broker">重新检查</button><button class="button secondary" id="install-hooks">更新 Agent 接入</button></div>
      </section>
      <section class="panel data-panel"><div class="panel-title"><div><h2>数据目录</h2><p>会话索引、普通配置和本地日志</p></div></div><code>${escapeHtml(snapshot.dataDirectory)}</code><div class="button-row"><button class="button secondary" id="open-data">打开目录</button><button class="button secondary" id="choose-data">更改位置</button></div></section>
    </section>
    <details class="panel logs" id="log-details"><summary><span><strong>运行日志</strong><small>用于诊断连接和任务状态</small></span><span id="log-count">0 条</span></summary><div class="log-list" id="log-list"></div></details>`;
}

function field(key: string, property: SchemaProperty, value: unknown, configured: boolean): string {
  const title = LABELS[key] ?? key;
  const hint = property.secret && configured ? "已安全保存；留空保持不变" : property.description ?? "";
  const visibility = property.ui?.visibleWhen ? ` data-visible-when="${encodeURIComponent(JSON.stringify(property.ui.visibleWhen))}"` : "";
  const description = property.description ? `<small>${escapeHtml(property.description)}</small>` : property.secret ? `<small>${escapeHtml(hint)}</small>` : "";
  if (property.ui?.control === "segmented" && property.enum) {
    return `<fieldset class="field wide segmented-field"${visibility}><legend>${escapeHtml(title)}</legend><div class="segmented">${property.enum.map((entry, index) => `<label><input type="radio" name="${escapeHtml(key)}" value="${escapeHtml(entry)}" ${value === entry || (value === undefined && property.default === entry) ? "checked" : ""}><span>${escapeHtml(property.enumLabels?.[index] ?? entry)}</span></label>`).join("")}</div>${description}</fieldset>`;
  }
  if (property.type === "boolean") {
    const checked = typeof value === "boolean" ? value : property.default === true;
    return `<label class="field checkbox wide"${visibility}><div><span>${escapeHtml(title)}</span>${description}</div><input name="${escapeHtml(key)}" data-type="boolean" type="checkbox" ${checked ? "checked" : ""}></label>`;
  }
  if (property.enum) {
    return `<label class="field"${visibility}><span>${escapeHtml(title)}</span><select name="${escapeHtml(key)}">${property.enum.map((entry, index) => `<option value="${escapeHtml(entry)}" ${value === entry || (value === undefined && property.default === entry) ? "selected" : ""}>${escapeHtml(property.enumLabels?.[index] ?? entry)}</option>`).join("")}</select>${description}</label>`;
  }
  if (property.type === "array") {
    const text = Array.isArray(value) ? value.join("\n") : "";
    return `<label class="field wide"${visibility}><span>${escapeHtml(title)}</span><textarea name="${escapeHtml(key)}" data-type="array" rows="3">${escapeHtml(text)}</textarea>${description}</label>`;
  }
  if (property.type === "integer" || property.type === "number") {
    return `<label class="field"${visibility}><span>${escapeHtml(title)}</span><input name="${escapeHtml(key)}" data-type="number" type="number" min="${property.minimum ?? ""}" max="${property.maximum ?? ""}" value="${escapeHtml(String(value ?? property.default ?? ""))}">${description}</label>`;
  }
  return `<label class="field"${visibility}><span>${escapeHtml(title)}</span><input name="${escapeHtml(key)}" type="${property.secret ? "password" : "text"}" value="${property.secret ? "" : escapeHtml(String(value ?? property.default ?? ""))}" placeholder="${escapeHtml(property.secret ? hint : "")}">${description}</label>`;
}

function bindView(): void {
  document.querySelectorAll<HTMLElement>("#view-root [data-view]").forEach((element) => element.addEventListener("click", () => navigate(element.dataset.view as View)));
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
      renderCurrentView();
    });
  }));
  document.querySelector("#channel-back")?.addEventListener("click", () => {
    if (editingChannel) formDrafts.delete(`channel:${editingChannel}`);
    editingChannel = undefined;
    editableChannel = undefined;
    renderCurrentView();
  });
  document.querySelector("#channel-test")?.addEventListener("click", () => {
    if (editingChannel) void run(window.agentLink.testChannel(editingChannel), "测试消息已发送");
  });
  bindChannelForm();
  bindSystemForm();
  document.querySelector("#install-hooks")?.addEventListener("click", () => {
    setFormStatus("正在更新 Agent 接入…");
    void window.agentLink.installHooks().then((inspection) => {
      setFormStatus(inspection.codexInstalled && inspection.claudeStopInstalled && inspection.claudePermissionRequestInstalled
        ? "Codex 与 Claude Code 接入已更新"
        : "接入已写入，但部分 Hook 尚未就绪");
    }).catch((error) => setFormStatus(error instanceof Error ? error.message : String(error), true));
  });
}

function bindChannelForm(): void {
  const form = document.querySelector<HTMLFormElement>("#channel-form");
  bindFormDraft(form);
  form?.addEventListener("change", () => {
    syncConditionalFields();
    const enabled = form.elements.namedItem("enabled");
    const testButton = document.querySelector<HTMLButtonElement>("#channel-test");
    if (enabled instanceof HTMLInputElement && testButton) testButton.disabled = !enabled.checked;
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editingChannel) return;
    const next: ChannelConfiguration = { enabled: new FormData(form).has("enabled"), config: {} };
    const radioNames = new Set<string>();
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]:not([name=enabled])").forEach((input) => {
      if (input instanceof HTMLInputElement && input.type === "radio") {
        if (radioNames.has(input.name) || !input.checked) return;
        radioNames.add(input.name);
      }
      if (input.dataset.type === "boolean") next.config[input.name] = (input as HTMLInputElement).checked;
      else if (input.dataset.type === "array") next.config[input.name] = input.value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      else if (input.dataset.type === "number") next.config[input.name] = Number(input.value);
      else next.config[input.name] = input.value;
    });
    const channelId = editingChannel;
    setFormStatus("正在保存…");
    void window.agentLink.saveChannel(channelId, next).then(async (nextSnapshot) => {
      snapshot = nextSnapshot;
      formDrafts.delete(`channel:${channelId}`);
      editableChannel = await window.agentLink.channelConfiguration(channelId);
      renderCurrentView();
      setFormStatus("配置已保存并应用");
    }).catch((error) => setFormStatus(error instanceof Error ? error.message : String(error), true));
  });
}

function bindSystemForm(): void {
  const form = document.querySelector<HTMLFormElement>("#system-form");
  bindFormDraft(form);
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const policy = data.get("remoteExecutionPolicy") as DesktopSnapshot["settings"]["remoteExecutionPolicy"];
    if (policy === "fullAccess" && snapshot.settings.remoteExecutionPolicy !== "fullAccess"
      && !confirm("完全访问会跳过 Agent 审批和沙箱。只应对完全可信的白名单用户启用。继续吗？")) return;
    void run(window.agentLink.saveSettings({
      remoteExecutionPolicy: policy,
      defaultWorkspace: String(data.get("defaultWorkspace") ?? ""),
      receiverPort: Number(data.get("receiverPort")),
      deliveryTiming: String(data.get("deliveryTiming") ?? "realtime") as DesktopSnapshot["settings"]["deliveryTiming"]
    }), "系统策略已保存").then((saved) => { if (saved) formDrafts.delete("system"); });
  });
}

function patchLiveUi(): void {
  if (!snapshot) return;
  const ready = snapshot.broker.state === "ready";
  setText("sidebar-state", ready ? "服务正常" : "需要检查");
  setText("sidebar-version", `Broker · v${snapshot.version}`);
  document.querySelector("#sidebar-state-dot")?.classList.toggle("ok", ready);
  if (currentView === "overview") patchOverview();
  if (currentView === "sessions") patchSessions();
  if (currentView === "channels") patchChannels();
  if (currentView === "system") patchSystem();
}

function patchOverview(): void {
  const connected = snapshot.channels.filter((item) => item.enabled && item.state === "connected").length;
  const ready = snapshot.broker.state === "ready";
  setText("health-title", ready ? "本地服务运行正常" : "本地服务需要处理");
  setText("health-detail", ready ? `Broker 已连接，Codex 服务 ${stateLabel(snapshot.broker.codexState)}。` : snapshot.broker.error || "Broker 尚未就绪，请打开系统设置检查。" );
  document.querySelector("#health-dot")?.classList.toggle("ok", ready);
  document.querySelector("#health-banner")?.classList.toggle("warning", !ready);
  setText("live-active", String(snapshot.remoteQueue.active));
  setText("live-channels", `${connected}/${snapshot.channels.length}`);
  setText("live-sessions", String(snapshot.sessions.length));
  setText("agent-count", `${snapshot.agents.filter((agent) => agent.available).length} 可用`);
  setHtml("agent-list", snapshot.agents.map(agentRow).join(""));
  setHtml("channel-summary-list", snapshot.channels.map(channelRow).join("") || empty("尚未安装消息通道"));
  const error = document.querySelector<HTMLElement>("#broker-error");
  if (error) { error.hidden = !snapshot.broker.error; error.textContent = snapshot.broker.error ? `Broker 错误：${snapshot.broker.error}` : ""; }
}

function patchSessions(): void {
  setHtml("session-list", snapshot.sessions.map((session) => `<div class="table-row">
    <div><strong>${escapeHtml(session.alias || session.name || session.project)}</strong><small>${escapeHtml(session.sessionId)}</small></div>
    <span>${escapeHtml(agentName(session.source))}</span><span><i class="status-dot ${escapeHtml(session.status)}"></i>${stateLabel(session.status)}</span>
    <span>${session.ownership === "managed" ? "Agent Link" : "外部客户端"}</span><time>${formatTime(session.lastSeenAt)}</time>
  </div>`).join("") || empty("还没有发现会话。启动一次 Codex 或 Claude Code 后会自动出现。"));
}

function patchChannels(): void {
  if (editingChannel) {
    const channel = snapshot.channels.find((item) => item.manifest.id === editingChannel);
    const state = document.querySelector<HTMLElement>("[data-channel-editor-state]");
    if (channel && state) state.textContent = stateLabel(channel.state);
    const form = document.querySelector<HTMLFormElement>("#channel-form");
    if (channel && form && !formDrafts.has(`channel:${editingChannel}`)) {
      const enabled = form.elements.namedItem("enabled");
      if (enabled instanceof HTMLInputElement) enabled.checked = channel.enabled;
    }
    return;
  }
  for (const channel of snapshot.channels) {
    const card = document.querySelector<HTMLElement>(`[data-channel-card="${cssEscape(channel.manifest.id)}"]`);
    const state = card?.querySelector<HTMLElement>("[data-channel-state]");
    if (state) { state.textContent = stateLabel(channel.state); state.className = `state ${escapeHtml(channel.state)}`; }
  }
}

function patchSystem(): void {
  setText("system-broker-state", stateLabel(snapshot.broker.state));
  setText("system-broker-detail", `${stateLabel(snapshot.broker.state)} · Codex ${stateLabel(snapshot.broker.codexState)}`);
  setText("system-active-turns", `${snapshot.remoteQueue.active}（排队 ${snapshot.remoteQueue.pending}）`);
  setText("system-receiver", `127.0.0.1:${snapshot.settings.receiverPort}`);
  setText("log-count", `${snapshot.logs.length} 条`);
  setHtml("log-list", snapshot.logs.slice().reverse().map((entry) => `<div><time>${formatTime(entry.at)}</time><span class="log-level ${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span><p>${escapeHtml(entry.message)}</p></div>`).join("") || empty("暂无日志"));
  const form = document.querySelector<HTMLFormElement>("#system-form");
  if (form && !formDrafts.has("system")) {
    const policy = form.elements.namedItem("remoteExecutionPolicy");
    const workspace = form.elements.namedItem("defaultWorkspace");
    const port = form.elements.namedItem("receiverPort");
    const timing = form.elements.namedItem("deliveryTiming");
    if (policy instanceof HTMLSelectElement) policy.value = snapshot.settings.remoteExecutionPolicy;
    if (workspace instanceof HTMLInputElement) workspace.value = snapshot.settings.defaultWorkspace;
    if (port instanceof HTMLInputElement) port.value = String(snapshot.settings.receiverPort);
    if (timing instanceof HTMLSelectElement) timing.value = snapshot.settings.deliveryTiming;
  }
}

function syncConditionalFields(): void {
  const form = document.querySelector<HTMLFormElement>("#channel-form");
  if (!form) return;
  const values: Record<string, string | number | boolean> = {};
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name]").forEach((control) => {
    if (control instanceof HTMLInputElement && control.type === "radio") {
      if (control.checked) values[control.name] = control.value;
    } else if (control instanceof HTMLInputElement && control.type === "checkbox") {
      values[control.name] = control.checked;
    } else {
      values[control.name] = control.value;
    }
  });
  form.querySelectorAll<HTMLElement>("[data-visible-when]").forEach((fieldElement) => {
    let conditions: Record<string, string | number | boolean> = {};
    try { conditions = JSON.parse(decodeURIComponent(fieldElement.dataset.visibleWhen ?? "")) as typeof conditions; } catch { /* visible by default */ }
    fieldElement.hidden = !matchesVisibility(conditions, values);
  });
  form.querySelectorAll<HTMLElement>("[data-config-section]").forEach((section) => {
    const fields = Array.from(section.querySelectorAll<HTMLElement>(".field"));
    if (!section.classList.contains("advanced-section")) section.hidden = fields.length > 0 && fields.every((item) => item.hidden);
  });
}

async function run(action: Promise<DesktopSnapshot>, success?: string): Promise<boolean> {
  try {
    snapshot = await action;
    patchLiveUi();
    if (success) setFormStatus(success);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (document.querySelector("#form-status")) setFormStatus(message, true); else alert(message);
    return false;
  }
}

function bindFormDraft(form: HTMLFormElement | null): void {
  if (!form) return;
  const capture = () => captureFormDraft(form);
  form.addEventListener("input", capture);
  form.addEventListener("change", capture);
}

function captureFormDraft(form: HTMLFormElement): void {
  const key = form.dataset.draftKey;
  if (!key) return;
  const fields: Record<string, FormDraftField> = {};
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]").forEach((input) => {
    if (input instanceof HTMLInputElement && input.type === "radio" && !input.checked) return;
    fields[input.name] = { value: input.value, ...(input instanceof HTMLInputElement ? { checked: input.checked } : {}) };
  });
  formDrafts.set(key, fields);
}

function restoreFormDraft(): void {
  const form = document.querySelector<HTMLFormElement>("form[data-draft-key]");
  const fields = form?.dataset.draftKey ? formDrafts.get(form.dataset.draftKey) : undefined;
  if (!form || !fields) return;
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]").forEach((input) => {
    const draft = fields[input.name];
    if (!draft) return;
    if (input instanceof HTMLInputElement && input.type === "radio") input.checked = input.value === draft.value;
    else input.value = draft.value;
    if (input instanceof HTMLInputElement && input.type !== "radio" && draft.checked !== undefined) input.checked = draft.checked;
  });
}

function setFormStatus(message: string, error = false): void {
  const status = document.querySelector<HTMLElement>("#form-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error-text", error);
}

function pageHeader(title: string, subtitle: string, action = ""): string {
  return `<header class="page-header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${action}</header>`;
}

function statCard(label: string, id: string, value: string, detail: string): string {
  return `<article class="stat-card"><span>${label}</span><strong id="${id}">${value}</strong><small>${detail}</small></article>`;
}

function agentRow(agent: DesktopSnapshot["agents"][number]): string {
  return `<div class="list-row"><span class="agent-logo ${escapeHtml(agent.id)}">${agent.id === "codex" ? "C" : "AI"}</span><div><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.executable || "未发现可执行文件")}</small></div><span class="state ${agent.available ? "connected" : "failed"}">${agent.available ? "可用" : "未发现"}</span></div>`;
}

function channelRow(channel: DesktopSnapshot["channels"][number]): string {
  return `<div class="list-row"><span class="channel-mini">${escapeHtml(channel.manifest.name.slice(0, 1))}</span><div><strong>${escapeHtml(channel.manifest.name)}</strong><small>${escapeHtml(channel.detail || channel.manifest.description)}</small></div><span class="state ${escapeHtml(channel.state)}">${stateLabel(channel.state)}</span></div>`;
}

function setText(id: string, value: string): void { const element = document.getElementById(id); if (element && element.textContent !== value) element.textContent = value; }
function setHtml(id: string, value: string): void { const element = document.getElementById(id); if (element && element.innerHTML !== value) element.innerHTML = value; }
function empty(message: string): string { return `<div class="empty">${escapeHtml(message)}</div>`; }
function agentName(source: string): string { return source === "claude-code" ? "Claude Code" : source === "codex" ? "Codex" : source; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false }); }
function stateLabel(value: string): string { return ({ ready: "正常", stopped: "按需启动", starting: "启动中", connected: "已连接", connecting: "连接中", disabled: "已关闭", idle: "待机", degraded: "连接不稳定", failed: "失败", progress: "执行中", completed: "已完成", active: "活动" } as Record<string, string>)[value] ?? value; }
function capabilityLabel(value: string): string { return ({ outbound: "发送", inbound: "接收", reply: "回复", interactive: "交互" } as Record<string, string>)[value] ?? value; }
function cssEscape(value: string): string { return CSS.escape(value); }
function escapeHtml(value: string): string { return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!); }

const LABELS: Record<string, string> = {
  deliveryMode: "接入方式", webhookUrl: "Webhook URL", webhookSecret: "签名密钥",
  appId: "App ID", appSecret: "App Secret", receiveIdType: "目标类型", receiveId: "目标 ID",
  messageFormat: "消息格式", inboundEnabled: "接收飞书回复与命令", allowedUserOpenIds: "允许的用户",
  allowedChatIds: "允许的群聊", requireGroupMention: "群聊必须 @机器人",
  includeMetadata: "显示会话信息", maxChunkCharacters: "单条消息字符上限", notifyOnFailure: "失败时通知",
  deliveryMaxAttempts: "最大重试次数", retryBaseDelayMs: "重试基础延迟（ms）"
};
