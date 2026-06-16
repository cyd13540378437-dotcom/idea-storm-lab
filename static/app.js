const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  ideas: [],
  members: [],
  selectedIdea: null,
  activePage: "write",
  activeTab: "text",
};

const cardColors = ["#fff4ba", "#fffaf0", "#e7edf1", "#dfe9e4", "#f7e5da"];

const canvasLabels = {
  customer_segments: "客户细分",
  value_propositions: "价值主张",
  channels: "渠道通路",
  customer_relationships: "客户关系",
  revenue_streams: "收入来源",
  key_resources: "核心资源",
  key_activities: "关键业务",
  key_partners: "重要合作",
  cost_structure: "成本结构",
};

const canvasClasses = {
  customer_segments: "users",
  value_propositions: "value",
  revenue_streams: "money",
  cost_structure: "cost",
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name = "") {
  const clean = name.trim();
  return clean ? clean.slice(0, 2).toUpperCase() : "?";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function fileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showNotice(message, tone = "info") {
  const notice = $("notice");
  notice.textContent = message;
  notice.hidden = !message;
  notice.dataset.tone = tone;
  if (message) {
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => {
      notice.hidden = true;
    }, 5200);
  }
}

function setAuthMessage(message) {
  $("authMessage").textContent = message || "";
}

async function api(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(path, {
    method: options.method || "GET",
    body,
    headers,
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求没有成功。");
  }
  return data;
}

function setAuthMode(mode) {
  const isLogin = mode === "login";
  $("loginTab").classList.toggle("active", isLogin);
  $("registerTab").classList.toggle("active", !isLogin);
  $("loginForm").hidden = !isLogin;
  $("registerForm").hidden = isLogin;
  setAuthMessage("");
}

async function bootstrap() {
  bindEvents();
  try {
    const { user } = await api("/api/me");
    state.user = user;
    if (user) {
      await enterWorkspace();
    } else {
      showAuth();
    }
  } catch (error) {
    showAuth();
  }
}

function showAuth() {
  $("authView").hidden = false;
  $("workspaceView").hidden = true;
}

async function enterWorkspace() {
  $("authView").hidden = true;
  $("workspaceView").hidden = false;
  await Promise.all([loadIdeas(), loadMembers()]);
  renderWorkspace();
}

async function loadIdeas() {
  const { ideas } = await api("/api/ideas");
  state.ideas = ideas;
  if (state.selectedIdea) {
    const selected = ideas.find((item) => item.id === state.selectedIdea.id);
    if (selected) {
      await selectIdea(selected.id, false);
    } else {
      state.selectedIdea = null;
    }
  } else if (ideas.length) {
    await selectIdea(ideas[0].id, false);
  }
}

async function loadMembers() {
  const { members } = await api("/api/members");
  state.members = members;
}

function renderWorkspace() {
  const memberLine = state.user
    ? `${state.members.length} 位成员 · 当前身份：${state.user.name}`
    : "脑暴空间";
  $("memberLine").textContent = memberLine;
  renderNav();
  renderSelectedMini();
  renderAnalysisIdeaList();
  renderBoard();
  renderDetail();
  renderPage();
}

function renderNav() {
  for (const page of ["write", "analysis", "wall"]) {
    const button = $(`nav${page[0].toUpperCase()}${page.slice(1)}`);
    if (button) {
      button.classList.toggle("active", state.activePage === page);
    }
  }
}

function renderPage() {
  $("writePage").hidden = state.activePage !== "write";
  $("analysisPage").hidden = state.activePage !== "analysis";
  $("wallPage").hidden = state.activePage !== "wall";
}

function setPage(page) {
  state.activePage = page;
  renderWorkspace();
}

function renderSelectedMini() {
  const mini = $("selectedMini");
  if (!mini) return;
  const idea = state.selectedIdea;
  if (!idea) {
    mini.innerHTML = `
      <div class="empty-mini">
        <strong>还没有想法</strong>
        <span>先提交一条，分析会自动出现。</span>
      </div>
    `;
    $("goAnalysisButton").disabled = true;
    return;
  }
  $("goAnalysisButton").disabled = false;
  const source = idea.analysis?.source === "local" ? "本地示例" : "AI";
  mini.innerHTML = `
    <div class="mini-card">
      <span class="avatar" style="background:${escapeHtml(idea.author.avatar_color)}">${escapeHtml(initials(idea.author.name))}</span>
      <div>
        <strong>${escapeHtml(idea.title)}</strong>
        <span>${escapeHtml(source)}分析 · 更新于 ${escapeHtml(formatDate(idea.updated_at))}</span>
      </div>
    </div>
  `;
}

function renderAnalysisIdeaList() {
  const list = $("analysisIdeaList");
  if (!list) return;
  if (!state.ideas.length) {
    list.innerHTML = `<div class="empty-state compact"><p>暂无想法。</p></div>`;
    return;
  }
  list.innerHTML = state.ideas
    .map((idea) => {
      const active = state.selectedIdea && state.selectedIdea.id === idea.id ? "active" : "";
      const source = idea.analysis?.source === "local" ? "本地示例" : "AI";
      return `
        <button class="analysis-idea-button ${active}" type="button" data-id="${idea.id}">
          <span class="avatar" style="background:${escapeHtml(idea.author.avatar_color)}">${escapeHtml(initials(idea.author.name))}</span>
          <span>
            <strong>${escapeHtml(idea.title)}</strong>
            <small>${escapeHtml(idea.author.name)} · ${escapeHtml(source)} · ${escapeHtml(formatDate(idea.updated_at))}</small>
          </span>
        </button>
      `;
    })
    .join("");
}

function renderBoard() {
  $("ideaCount").textContent = state.ideas.length;
  const board = $("ideaBoard");
  if (!state.ideas.length) {
    board.innerHTML = `
      <div class="empty-state">
        <span class="empty-symbol">＋</span>
        <h3>第一张便利贴还没贴上来</h3>
        <p>左侧提交一个想法，AI 会立刻整理它。</p>
      </div>
    `;
    return;
  }
  board.innerHTML = state.ideas
    .map((idea, index) => {
      const active = state.selectedIdea && state.selectedIdea.id === idea.id ? "active" : "";
      const color = cardColors[index % cardColors.length];
      const tilt = `${(index % 5) - 2}deg`;
      const summary = idea.summary || idea.body || "分析生成后会出现摘要。";
      const attachmentText = idea.attachment_count ? `${idea.attachment_count} 个附件` : "无附件";
      return `
        <button class="idea-card ${active}" type="button" data-id="${idea.id}" style="background:${color}; --tilt:${tilt}">
          <h3>${escapeHtml(idea.title)}</h3>
          <p>${escapeHtml(summary)}</p>
          <div class="card-meta">
            <span class="author-chip">
              <span class="avatar" style="background:${escapeHtml(idea.author.avatar_color)}">${escapeHtml(initials(idea.author.name))}</span>
              <span class="author-name">${escapeHtml(idea.author.name)}</span>
            </span>
            <span>${escapeHtml(attachmentText)}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

async function selectIdea(id, rerender = true) {
  const { idea } = await api(`/api/ideas/${id}`);
  state.selectedIdea = idea;
  if (rerender) {
    renderWorkspace();
  }
}

function renderDetail() {
  const idea = state.selectedIdea;
  $("emptyDetail").hidden = Boolean(idea);
  $("ideaDetail").hidden = !idea;
  if (!idea) return;

  $("detailAuthor").textContent = `${idea.author.name} · 更新于 ${formatDate(idea.updated_at)} · 版本 ${idea.content_version}`;
  $("detailTitle").textContent = idea.title;
  $("reanalyzeButton").hidden = !idea.can_edit;

  const editForm = $("editForm");
  editForm.hidden = !idea.can_edit;
  $("readOnlyBody").hidden = idea.can_edit;
  $("detailUploadLabel").hidden = !idea.can_edit;
  if (idea.can_edit) {
    editForm.elements.title.value = idea.title;
    editForm.elements.body.value = idea.body;
  } else {
    $("readOnlyBody").textContent = idea.body;
  }

  renderAttachments(idea);
  renderAnalysis(idea.analysis && idea.analysis.content, idea.analysis);
  renderCanvas(idea.analysis && idea.analysis.content && idea.analysis.content.canvas);
  setActiveTab(state.activeTab);
}

function renderAttachments(idea) {
  const list = $("attachmentList");
  if (!idea.attachments.length) {
    list.innerHTML = `<div class="attachment"><small>还没有附件</small></div>`;
    return;
  }
  list.innerHTML = idea.attachments
    .map((file) => {
      const url = `/uploads/${encodeURIComponent(file.stored_name)}`;
      const isImage = (file.content_type || "").startsWith("image/");
      const preview = isImage
        ? `<img src="${url}" alt="${escapeHtml(file.filename)}" loading="lazy" />`
        : `<small>文档</small>`;
      const deleteButton = idea.can_edit
        ? `<button class="delete-attachment" type="button" data-attachment-id="${file.id}">删除</button>`
        : "";
      return `
        <div class="attachment">
          ${preview}
          <a href="${url}" target="_blank" rel="noopener">${escapeHtml(file.filename)}</a>
          <small>${escapeHtml(file.content_type || "文件")} · ${fileSize(file.size)}</small>
          ${deleteButton}
        </div>
      `;
    })
    .join("");
}

function renderAnalysis(content, meta) {
  const view = $("analysisView");
  if (!content) {
    view.innerHTML = `<div class="empty-state"><p>还没有分析结果。</p></div>`;
    return;
  }
  const sourceLabel = meta && meta.source === "local" ? "本地示例分析" : "AI 分析";
  const fallbackReason = meta && meta.source === "local"
    ? content._fallback_reason || "真实 AI 分析没有成功返回，当前展示本地示例分析。"
    : "";
  view.innerHTML = `
    <div class="analysis-meta">${escapeHtml(sourceLabel)} · v${escapeHtml(meta ? meta.version : "")} · ${escapeHtml(formatDate(meta ? meta.created_at : ""))}</div>
    ${fallbackReason ? `<div class="analysis-warning"><strong>真实 AI 分析未生成</strong><span>${escapeHtml(fallbackReason)}</span></div>` : ""}
    <section class="analysis-section">
      <h3>内容提取</h3>
      <p>${escapeHtml(content.content_extract?.summary || "")}</p>
      ${renderList(content.content_extract?.key_points)}
    </section>
    <section class="analysis-section">
      <h3>竞品线索</h3>
      ${renderCompetitors(content.competitors)}
    </section>
    ${renderAnalysisSection("核心用户群体", content.user_segments)}
    ${renderAnalysisSection("业务流程", content.business_flow, true)}
    ${renderAnalysisSection("建议运营模式", content.operation_model)}
    <section class="analysis-section">
      <h3>资本视角的业务故事</h3>
      <p>${escapeHtml(content.capital_story || "")}</p>
    </section>
    ${renderAnalysisSection("产品核心能力", content.product_capabilities)}
    ${renderAnalysisSection("技术选型", content.tech_stack)}
    ${renderAnalysisSection("风险与验证建议", content.risks)}
  `;
}

function renderAnalysisSection(title, items, ordered = false) {
  return `
    <section class="analysis-section">
      <h3>${escapeHtml(title)}</h3>
      ${renderList(items, ordered)}
    </section>
  `;
}

function renderList(items, ordered = false) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return `<p>待补充。</p>`;
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
}

function renderCompetitors(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return `<p>暂未发现明确竞品。</p>`;
  return `
    <div class="competitor-list">
      ${values
        .map(
          (item) => `
          <div class="competitor-item">
            <strong>${escapeHtml(item.name || "竞品线索")}</strong>
            <span>${escapeHtml(item.reason || "")}</span>
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

function renderCanvas(canvas = {}) {
  canvas = canvas || {};
  const order = [
    "key_partners",
    "key_activities",
    "value_propositions",
    "customer_relationships",
    "customer_segments",
    "key_resources",
    "channels",
    "revenue_streams",
    "cost_structure",
  ];
  $("canvasView").innerHTML = order
    .map((key) => {
      const values = Array.isArray(canvas[key]) ? canvas[key] : [];
      const cls = canvasClasses[key] || "";
      return `
        <section class="canvas-cell ${cls}">
          <h3>${escapeHtml(canvasLabels[key])}</h3>
          ${renderList(values)}
        </section>
      `;
    })
    .join("");
}

function setActiveTab(tab) {
  state.activeTab = tab;
  $("textTab").classList.toggle("active", tab === "text");
  $("canvasTab").classList.toggle("active", tab === "canvas");
  $("analysisView").hidden = tab !== "text";
  $("canvasView").hidden = tab !== "canvas";
}

async function uploadFiles(ideaId, files) {
  let latest = null;
  for (const file of Array.from(files || [])) {
    const form = new FormData();
    form.append("file", file);
    const data = await api(`/api/ideas/${ideaId}/attachments`, {
      method: "POST",
      body: form,
    });
    latest = data.idea;
  }
  return latest;
}

function setButtonBusy(button, busyText, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function bindEvents() {
  $("loginTab").addEventListener("click", () => setAuthMode("login"));
  $("registerTab").addEventListener("click", () => setAuthMode("register"));

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    setAuthMessage("");
    const form = event.currentTarget;
    const button = form.querySelector("button");
    setButtonBusy(button, "进入中", true);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const { user } = await api("/api/auth/login", { method: "POST", body: payload });
      state.user = user;
      await enterWorkspace();
    } catch (error) {
      setAuthMessage(error.message);
    } finally {
      setButtonBusy(button, "", false);
    }
  });

  $("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    setAuthMessage("");
    const form = event.currentTarget;
    const button = form.querySelector("button");
    setButtonBusy(button, "创建中", true);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const { user } = await api("/api/auth/register", { method: "POST", body: payload });
      state.user = user;
      await enterWorkspace();
    } catch (error) {
      setAuthMessage(error.message);
    } finally {
      setButtonBusy(button, "", false);
    }
  });

  $("logoutButton").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.ideas = [];
    state.selectedIdea = null;
    showAuth();
  });

  $("refreshButton").addEventListener("click", async () => {
    await loadIdeas();
    await loadMembers();
    renderWorkspace();
    showNotice("已刷新灵感墙。");
  });

  $("inviteButton").addEventListener("click", async () => {
    try {
      const { invite } = await api("/api/invites", { method: "POST" });
      const text = `新邀请码：${invite.code}`;
      showNotice(text);
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(invite.code).catch(() => {});
      }
    } catch (error) {
      showNotice(error.message, "error");
    }
  });

  $("newFiles").addEventListener("change", (event) => {
    const count = event.currentTarget.files.length;
    $("newFileCount").textContent = count ? `${count} 个文件已选择` : "可多选";
  });

  $("ideaForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("submitIdeaButton");
    const files = $("newFiles").files;
    setButtonBusy(button, "分析中", true);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      delete payload.files;
      let { idea } = await api("/api/ideas", { method: "POST", body: payload });
      const uploaded = await uploadFiles(idea.id, files);
      if (uploaded) idea = uploaded;
      form.reset();
      $("newFileCount").textContent = "可多选";
      await loadIdeas();
      await selectIdea(idea.id, false);
      state.activePage = "analysis";
      state.activeTab = "text";
      renderWorkspace();
      showNotice("已生成分析，正在展示分析结果。");
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, "", false);
    }
  });

  $("ideaBoard").addEventListener("click", async (event) => {
    const card = event.target.closest(".idea-card");
    if (!card) return;
    await selectIdea(Number(card.dataset.id), false);
    state.activePage = "analysis";
    renderWorkspace();
  });

  $("analysisIdeaList").addEventListener("click", async (event) => {
    const item = event.target.closest("[data-id]");
    if (!item) return;
    await selectIdea(Number(item.dataset.id));
  });

  $("editForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selectedIdea) return;
    const form = event.currentTarget;
    const button = form.querySelector("button");
    setButtonBusy(button, "更新中", true);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const { idea } = await api(`/api/ideas/${state.selectedIdea.id}`, {
        method: "PUT",
        body: payload,
      });
      state.selectedIdea = idea;
      await loadIdeas();
      await selectIdea(idea.id, false);
      state.activePage = "analysis";
      renderWorkspace();
      showNotice("已保存，并重新生成分析。");
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, "", false);
    }
  });

  $("detailFiles").addEventListener("change", async (event) => {
    if (!state.selectedIdea || !event.currentTarget.files.length) return;
    showNotice("正在上传附件并更新分析。");
    try {
      const uploaded = await uploadFiles(state.selectedIdea.id, event.currentTarget.files);
      if (uploaded) {
        state.selectedIdea = uploaded;
        await loadIdeas();
        await selectIdea(uploaded.id, false);
        renderWorkspace();
        showNotice("附件已上传，分析已更新。");
      }
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      event.currentTarget.value = "";
    }
  });

  $("attachmentList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-attachment-id]");
    if (!button || !state.selectedIdea) return;
    button.disabled = true;
    try {
      const { idea } = await api(
        `/api/ideas/${state.selectedIdea.id}/attachments/${button.dataset.attachmentId}`,
        { method: "DELETE" }
      );
      state.selectedIdea = idea;
      await loadIdeas();
      await selectIdea(idea.id, false);
      renderWorkspace();
      showNotice("附件已删除，分析已更新。");
    } catch (error) {
      showNotice(error.message, "error");
    }
  });

  $("reanalyzeButton").addEventListener("click", async () => {
    if (!state.selectedIdea) return;
    const button = $("reanalyzeButton");
    setButtonBusy(button, "分析中", true);
    try {
      const { idea } = await api(`/api/ideas/${state.selectedIdea.id}/reanalyze`, {
        method: "POST",
      });
      state.selectedIdea = idea;
      await loadIdeas();
      await selectIdea(idea.id, false);
      renderWorkspace();
      showNotice("分析已重新生成。");
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, "", false);
    }
  });

  $("textTab").addEventListener("click", () => setActiveTab("text"));
  $("canvasTab").addEventListener("click", () => setActiveTab("canvas"));
  $("goAnalysisButton").addEventListener("click", () => setPage("analysis"));
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.page));
  });
}

bootstrap();
