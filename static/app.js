const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  ideas: [],
  members: [],
  selectedIdea: null,
  liveIdeaId: null,
  activePage: "write",
  activeTab: "text",
  stream: {
    ideaId: null,
    active: false,
    status: "",
    startedAt: null,
    elapsed: 0,
    sections: [],
    questions: [],
    doneReceived: false,
    finalData: null,
    typing: false,
    intent: "initial",
    helper: "",
  },
};

let streamClock = null;
let streamTypeTimer = null;

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

function mergeIdea(idea) {
  state.selectedIdea = idea;
  const index = state.ideas.findIndex((item) => item.id === idea.id);
  if (index >= 0) {
    state.ideas[index] = { ...state.ideas[index], ...idea };
  } else {
    state.ideas.unshift(idea);
  }
}

function currentLiveIdea() {
  if (!state.liveIdeaId) return null;
  if (state.selectedIdea?.id === state.liveIdeaId) return state.selectedIdea;
  return state.ideas.find((idea) => idea.id === state.liveIdeaId) || null;
}

function clearLiveAnalysis() {
  state.liveIdeaId = null;
}

function parseSseBlock(block) {
  const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!eventLine || !dataLines.length) return null;
  return {
    event: eventLine.slice(6).trim(),
    data: JSON.parse(dataLines.join("\n")),
  };
}

function initialStreamState(overrides = {}) {
  return {
    ideaId: null,
    active: false,
    status: "",
    startedAt: null,
    elapsed: 0,
    sections: [],
    questions: [],
    doneReceived: false,
    finalData: null,
    typing: false,
    intent: "initial",
    helper: "",
    ...overrides,
  };
}

function formatElapsed(seconds = 0) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function updateStreamTimer() {
  document
    .querySelectorAll("[data-stream-elapsed]")
    .forEach((timer) => {
      timer.textContent = formatElapsed(state.stream.elapsed);
    });
}

function updateStreamStatus() {
  document
    .querySelectorAll("[data-stream-status]")
    .forEach((status) => {
      status.textContent = state.stream.status || "正在分析想法";
    });
}

function startStreamClock() {
  window.clearInterval(streamClock);
  streamClock = window.setInterval(() => {
    if (!state.stream.active || !state.stream.startedAt) {
      window.clearInterval(streamClock);
      return;
    }
    state.stream.elapsed = Math.floor((Date.now() - state.stream.startedAt) / 1000);
    updateStreamTimer();
  }, 1000);
}

function stopStreamClock() {
  window.clearInterval(streamClock);
  streamClock = null;
}

function stopStreamTypewriter() {
  window.clearTimeout(streamTypeTimer);
  streamTypeTimer = null;
  state.stream.typing = false;
}

function streamStatusMessage(message = "") {
  if (state.stream.intent !== "clarification") return message;
  const clean = message || "";
  if (clean.includes("阅读想法")) return "正在读取补充答案和已有分析摘要";
  if (clean.includes("组织结构化分析")) return "LLM 正在基于问题答案继续分析";
  if (clean.includes("写到右侧")) return "正在把更新后的分析写回页面";
  if (clean.includes("补充问题")) return "新的补充调研已在后台准备";
  return clean || "正在基于问题的答案继续分析";
}

function scrollAnalysisDetailToTop() {
  const panel = document.querySelector("#analysisPage .detail-panel");
  const target = $("ideaDetail") || $("analysisPage");
  if (panel) panel.scrollTop = 0;
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  document.body.scrollTop = 0;
  if (target && !$("analysisPage")?.hidden) {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function scheduleAnalysisDetailTop() {
  window.requestAnimationFrame(() => {
    scrollAnalysisDetailToTop();
    window.requestAnimationFrame(scrollAnalysisDetailToTop);
  });
}

async function streamAnalysis(ideaId, options = {}) {
  stopStreamTypewriter();
  state.stream = initialStreamState({
    ideaId,
    active: true,
    status: options.status || "正在阅读想法",
    startedAt: Date.now(),
    intent: options.intent || "initial",
    helper: options.helper || "",
  });
  startStreamClock();
  renderWorkspace();
  if (options.scrollToAnalysisTop) {
    scheduleAnalysisDetailTop();
  }

  try {
    const response = await fetch(`/api/ideas/${ideaId}/analysis-stream`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "分析没有成功启动。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      let streamFinished = false;
      for (const block of blocks) {
        if (!block.trim()) continue;
        const message = parseSseBlock(block);
        if (!message) continue;
        handleStreamEvent(message.event, message.data);
        if (message.event === "done" || message.event === "error") {
          streamFinished = true;
        }
      }
      if (streamFinished) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (error) {
    state.stream.active = false;
    stopStreamClock();
    stopStreamTypewriter();
    renderInlineAnalysisPanel();
    throw error;
  }
}

function handleStreamEvent(event, data) {
  if (event === "status" || event === "pulse") {
    state.stream.status = streamStatusMessage(data.message || "正在分析");
    updateStreamStatus();
    return;
  }
  if (event === "section") {
    enqueueStreamSection(data);
    return;
  }
  if (event === "reset_sections") {
    state.stream.sections = [];
    state.stream.status = data.message || "正在切换为正式分析";
    renderInlineAnalysisPanel();
    return;
  }
  if (event === "questions") {
    state.stream.questions = data.questions || [];
    state.stream.status = streamStatusMessage(data.message || "补充问题已在后台准备");
    updateStreamStatus();
    return;
  }
  if (event === "done") {
    state.stream.doneReceived = true;
    state.stream.finalData = data;
    state.stream.status = state.stream.intent === "clarification"
      ? "补充分析已完成，正在整理版面"
      : "分析已完成，正在整理版面";
    updateStreamStatus();
    finishStreamIfReady();
    return;
  }
  if (event === "error") {
    state.stream.active = false;
    stopStreamClock();
    stopStreamTypewriter();
    renderWorkspace();
    throw new Error(data.error || "分析失败。");
  }
}

function streamThought(section) {
  const title = section.title || "这一部分";
  const thoughts = {
    内容提取: "先把原始想法压缩成共识文本，避免后面的判断偏题。",
    竞品线索: "再看用户今天可能用什么替代方案，这会影响切入角度。",
    核心用户群体: "接着缩小第一批用户，不把所有人都当成目标用户。",
    业务流程: "然后检查从提出想法到获得价值，中间是不是有清晰动作。",
    建议运营模式: "这里要判断冷启动和持续复用靠什么驱动。",
    抓手分析: "这一段专门找最容易让用户愿意试一次的切入点。",
    资本视角的业务故事: "把它翻译成增长叙事，看看是否能讲成可持续业务。",
    产品核心能力: "再拆产品必须具备的能力，区分核心和锦上添花。",
    技术选型: "最后看技术复杂度是否和当前阶段匹配。",
    风险与验证建议: "把最可能误判的地方提前摊开，方便下一步验证。",
    当前假设: "这里记录暂时成立、但还需要被验证的前提。",
    待补充信息: "最后列出信息缺口，方便你决定要不要继续补充。",
  };
  return thoughts[title] || `我先检查${title}，再把判断写成可讨论的版本。`;
}

function streamItemText(item) {
  if (typeof item === "object" && item) {
    const name = item.name || item.title || item.label || "线索";
    const reason = item.reason || item.description || item.answer || "";
    return reason ? `${name}：${reason}` : String(name);
  }
  return String(item || "");
}

function streamScoreText(score) {
  if (!score || !Array.isArray(score.dimensions) || !score.dimensions.length) return "";
  const total = Math.max(0, Math.min(100, Number(score.score) || 0));
  const lines = score.dimensions
    .map((item) => {
      const itemScore = Math.max(0, Math.min(100, Number(item.score) || 0));
      const reason = item.reason ? `，${item.reason}` : "";
      return `- ${item.label || "维度"}：${itemScore} 分${reason}`;
    })
    .join("\n");
  return `评分：${total} 分\n${lines}`;
}

function streamSectionText(section) {
  const parts = [`思考：${streamThought(section)}`];
  if (section.summary) parts.push(section.summary);
  const items = Array.isArray(section.items) ? section.items.map(streamItemText).filter(Boolean) : [];
  if (items.length) {
    parts.push(items.map((item) => `- ${item}`).join("\n"));
  }
  const score = section.key === "content_extract" ? "" : streamScoreText(section.score);
  if (score) parts.push(score);
  return parts.join("\n\n");
}

function enqueueStreamSection(section) {
  const entry = {
    ...section,
    fullText: streamSectionText(section),
    typedText: "",
    complete: false,
  };
  state.stream.sections.push(entry);
  appendStreamSection(entry, state.stream.sections.length - 1);
  runStreamTypewriter();
}

function appendStreamSection(section, index) {
  document.querySelectorAll("[data-stream-sections]").forEach((container) => {
    const placeholder = container.querySelector(".stream-placeholder");
    if (placeholder) placeholder.remove();
    container.insertAdjacentHTML("beforeend", renderStreamSection(section, index));
  });
}

function updateTypedSection(index) {
  const section = state.stream.sections[index];
  document.querySelectorAll(`[data-stream-text="${index}"]`).forEach((body) => {
    if (section) body.textContent = section.typedText || "";
  });
  document.querySelectorAll(`[data-stream-cursor="${index}"]`).forEach((cursor) => {
    if (section) cursor.hidden = Boolean(section.complete);
  });
}

function runStreamTypewriter() {
  if (streamTypeTimer) return;
  const tick = () => {
    if (!state.stream.active) {
      streamTypeTimer = null;
      return;
    }
    const index = state.stream.sections.findIndex((section) => !section.complete);
    if (index < 0) {
      state.stream.typing = false;
      streamTypeTimer = null;
      finishStreamIfReady();
      return;
    }
    state.stream.typing = true;
    const section = state.stream.sections[index];
    const nextLength = Math.min(
      section.fullText.length,
      section.typedText.length + (section.fullText.length - section.typedText.length > 240 ? 7 : 4)
    );
    section.typedText = section.fullText.slice(0, nextLength);
    section.complete = section.typedText.length >= section.fullText.length;
    updateTypedSection(index);
    streamTypeTimer = window.setTimeout(tick, section.complete ? 140 : 18);
  };
  streamTypeTimer = window.setTimeout(tick, 0);
}

function finishStreamIfReady() {
  if (!state.stream.doneReceived || state.stream.typing) return;
  if (state.stream.sections.some((section) => !section.complete)) {
    runStreamTypewriter();
    return;
  }
  const finalData = state.stream.finalData || {};
  state.stream.active = false;
  stopStreamClock();
  stopStreamTypewriter();
  if (finalData.idea) {
    mergeIdea(finalData.idea);
  }
  renderWorkspace();
  showNotice(
    state.stream.intent === "clarification"
      ? "已基于补充答案更新分析。"
      : "分析已更新，补充问题已准备好，不需要现在就回答。"
  );
}

async function saveClarification(question, answer, isFallback = false) {
  if (!state.selectedIdea) return;
  const data = await api(`/api/ideas/${state.selectedIdea.id}/clarifications`, {
    method: "POST",
    body: {
      question,
      answer,
      is_fallback: isFallback,
    },
  });
  mergeIdea(data.idea);
  renderWorkspace();
  showNotice(isFallback ? "已采用推荐答案，并标记为还没想好。" : "已保存回答。");
}

function currentQuestionById(questionId) {
  const contentQuestions = state.selectedIdea?.analysis?.content?.clarifying_questions || [];
  const streamQuestions = state.stream.ideaId === state.selectedIdea?.id ? state.stream.questions || [] : [];
  return [...contentQuestions, ...streamQuestions].find((item) => item.id === questionId);
}

async function handleClarificationAction(event) {
  const button = event.target.closest("[data-clarification-action]");
  if (!button || !state.selectedIdea) return;
  const action = button.dataset.clarificationAction;
  if (action === "update") {
    setButtonBusy(button, "继续分析中", true);
    try {
      const ideaId = state.selectedIdea.id;
      await streamAnalysis(ideaId, {
        intent: "clarification",
        status: "正在基于问题的答案继续分析",
        helper: "正在把你选择的补充答案、原始想法和已有分析摘要一起交给 LLM，再用当前 Skill 继续分析。",
        scrollToAnalysisTop: true,
      });
      await loadIdeas();
      await selectIdea(ideaId, false);
      renderWorkspace();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, "", false);
    }
    return;
  }

  const questionId = button.dataset.questionId;
  const question = currentQuestionById(questionId);
  if (!question) return;
  const card = button.closest(".question-card");
  if (action === "other") {
    const box = card?.querySelector(".other-answer");
    if (box) {
      box.hidden = false;
      box.querySelector("textarea")?.focus();
    }
    return;
  }

  const optionId = button.dataset.optionId;
  const option = (question.options || []).find((item) => item.id === optionId);
  const textarea = card?.querySelector(`[data-question-answer="${CSS.escape(questionId)}"]`);
  const isFallback = action === "fallback";
  let answer = "";
  if (action === "option" && option) {
    answer = option.answer || option.label || "";
  } else if (isFallback) {
    answer = question.recommended_answer || question.options?.[0]?.answer || question.fallback_answer || "我还没想好";
  } else if (action === "save-other") {
    answer = (textarea?.value || "").trim();
  }
  if (!answer) {
    showNotice("先写一点其他答案，或者选择一个已有选项。", "error");
    return;
  }
  button.disabled = true;
  try {
    await saveClarification(question, answer, isFallback);
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
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
  if (state.liveIdeaId && !ideas.some((idea) => idea.id === state.liveIdeaId)) {
    clearLiveAnalysis();
  }
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
  renderInlineAnalysisPanel();
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
  const idea = currentLiveIdea();
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
  const source = idea.analysis
    ? idea.analysis.source === "local"
      ? "本地示例"
      : "AI"
    : "待分析";
  mini.innerHTML = `
    <div class="mini-card">
      <span class="avatar" style="background:${escapeHtml(idea.author.avatar_color)}">${escapeHtml(initials(idea.author.name))}</span>
      <div>
        <strong>${escapeHtml(idea.title)}</strong>
        <span>${escapeHtml(source)} · 更新于 ${escapeHtml(formatDate(idea.updated_at))}</span>
      </div>
    </div>
  `;
}

function clarificationAnswerMap(idea) {
  const answers = {};
  for (const item of idea?.clarification_answers || []) {
    answers[item.question_id] = item;
  }
  return answers;
}

function renderInlineAnalysisPanel() {
  const view = $("inlineAnalysisView");
  const questions = $("inlineQuestions");
  const updateButton = $("updateAnalysisButton");
  if (!view || !questions || !updateButton) return;

  const idea = currentLiveIdea();
  if (!idea) {
    view.innerHTML = `
      <div class="analysis-waiting">
        <span class="empty-symbol">✦</span>
        <h3>等待一个想法</h3>
        <p>左侧提交后，分析会在这里开始流式展开。</p>
      </div>
    `;
    questions.innerHTML = "";
    updateButton.hidden = true;
    return;
  }

  const stream = state.stream;
  if (stream.active && stream.ideaId === idea.id) {
    view.innerHTML = renderStreamingAnalysis(stream);
    questions.innerHTML = "";
    updateButton.hidden = true;
    return;
  }

  const content = idea.analysis?.content;
  if (!content) {
    view.innerHTML = `
      <div class="analysis-waiting">
        <span class="empty-symbol">↻</span>
        <h3>准备开始分析</h3>
        <p>提交完成后，右侧会按模块展开初版分析，并生成需要确认的问题。</p>
      </div>
    `;
    questions.innerHTML = "";
    updateButton.hidden = true;
    return;
  }

  view.innerHTML = renderAnalysisMarkup(content, idea.analysis, true) + renderKeepIdeaAction(idea);
  questions.innerHTML = renderQuestionCards(idea, content.clarifying_questions || []);
  updateButton.hidden = !idea.can_edit || !(idea.clarification_answers || []).length;
}

function renderKeepIdeaAction(idea) {
  if (!idea?.can_edit) return "";
  return `
    <div class="live-actions">
      <button class="primary-button full" type="button" data-keep-idea>保留想法</button>
      <span>已经保存到灵感墙，保留后这里会回到初始状态。</span>
    </div>
  `;
}

function handleInlineAnalysisAction(event) {
  const button = event.target.closest("[data-keep-idea]");
  if (!button) return;
  stopStreamClock();
  stopStreamTypewriter();
  state.stream = initialStreamState();
  clearLiveAnalysis();
  state.activePage = "write";
  state.activeTab = "text";
  const form = $("ideaForm");
  if (form) form.reset();
  const fileCount = $("newFileCount");
  if (fileCount) fileCount.textContent = "可多选";
  renderWorkspace();
  showNotice("已保留这个想法，可以继续录入下一个。");
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
  const idea = state.selectedIdea;
  if (idea && state.stream.active && state.stream.ideaId === idea.id) {
    view.innerHTML = renderStreamingAnalysis(state.stream);
    $("clarificationPanel").innerHTML = renderAnalysisUpdatingNotice();
    return;
  }
  if (!content) {
    view.innerHTML = `<div class="empty-state"><p>还没有分析结果。</p></div>`;
    $("clarificationPanel").innerHTML = "";
    return;
  }
  view.innerHTML = renderAnalysisMarkup(content, meta);
  $("clarificationPanel").innerHTML = renderQuestionCards(state.selectedIdea, content.clarifying_questions || [], true);
}

function renderAnalysisUpdatingNotice() {
  return `
    <section class="question-stack">
      <article class="question-card">
        <div class="question-title">
          <span>继续分析中</span>
          <small>Answer based</small>
        </div>
        <h4>正在基于问题的答案继续分析</h4>
        <p>系统会把你刚刚选择的补充答案、原始想法和已有分析摘要一起交给 LLM，再用当前 Skill 重新生成分析结果。</p>
      </article>
    </section>
  `;
}

function renderAnalysisMarkup(content, meta, compact = false) {
  const sourceLabel = meta && meta.source === "local" ? "本地示例分析" : "AI 分析";
  const fallbackReason = meta && meta.source === "local"
    ? content._fallback_reason || "真实 AI 分析没有成功返回，当前展示本地示例分析。"
    : "";
  return `
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
      ${renderSectionScore(content.section_scores?.competitors)}
    </section>
    ${renderAnalysisSection("核心用户群体", content.user_segments)}
    ${renderAnalysisSection("业务流程", content.business_flow, true)}
    ${renderAnalysisSection("建议运营模式", content.operation_model)}
    ${renderHookAnalysis(content.hook_analysis, content.section_scores?.hook_analysis)}
    <section class="analysis-section">
      <h3>资本视角的业务故事</h3>
      <p>${escapeHtml(content.capital_story || "")}</p>
      ${renderSectionScore(content.section_scores?.capital_story)}
    </section>
    ${renderAnalysisSection("产品核心能力", content.product_capabilities)}
    ${renderAnalysisSection("技术选型", content.tech_stack)}
    ${renderAnalysisSection("风险与验证建议", content.risks)}
    ${renderAnalysisSection("当前假设", content.assumptions)}
    ${renderAnalysisSection("待补充信息", content.missing_info)}
  `;
}

function renderStreamingAnalysis(stream) {
  const elapsed = stream.elapsed || 0;
  const helper = stream.helper || "补充调研会在后台准备好，你可以稍后选择，也可以直接保留这个想法。";
  const sections = stream.sections
    .map((section, index) => renderStreamSection(section, index))
    .join("");
  return `
    <div class="thinking-card" aria-live="polite" data-stream-shell="true">
      <div class="thinking-main">
        <span class="thinking-dot"></span>
        <div>
          <strong>正在逐步写出分析</strong>
          <small data-stream-status>${escapeHtml(stream.status || "正在分析想法")}</small>
        </div>
        <time data-stream-elapsed>${escapeHtml(formatElapsed(elapsed))}</time>
      </div>
      <p class="stream-helper">${escapeHtml(helper)}</p>
    </div>
    <div class="stream-sections" data-stream-sections>
      ${sections || `<div class="stream-placeholder">正在打开分析框架...</div>`}
    </div>
  `;
}

function renderStreamSection(section, index = 0) {
  return `
    <section class="analysis-section stream-section ${section.preview ? "preview" : ""}" data-stream-section="${index}">
      <h3>${section.preview ? `<span class="preview-label">快速草稿</span>` : ""}${escapeHtml(section.title || "分析片段")}</h3>
      <div class="stream-type-body" data-stream-text="${index}">${escapeHtml(section.typedText || "")}</div>
      <span class="typing-cursor" data-stream-cursor="${index}" ${section.complete ? "hidden" : ""}></span>
    </section>
  `;
}

function renderStreamItems(items) {
  return `
    <ul>
      ${items
        .filter(Boolean)
        .map((item) => {
          if (typeof item === "object") {
            const name = item.name || item.title || "线索";
            const reason = item.reason || item.description || "";
            return `<li><strong>${escapeHtml(name)}</strong>${reason ? `：${escapeHtml(reason)}` : ""}</li>`;
          }
          return `<li>${escapeHtml(item)}</li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderQuestionCards(idea, questions = [], includeUpdate = false) {
  if (!idea || !Array.isArray(questions) || !questions.length) return "";
  const answers = clarificationAnswerMap(idea);
  return `
    <section class="question-stack">
      <div class="question-heading">
        <p class="eyebrow">Optional research</p>
        <h3>可选补充调研</h3>
        <small>这些问题不是必答项；想继续打磨时再选，暂时没想好也可以跳过。</small>
      </div>
      ${questions
        .map((question) => {
          const answer = answers[question.id];
          const options = Array.isArray(question.options) ? question.options : [];
          const answerText = answer?.answer || "";
          const selectedOptionId = options.find((option) => option.answer === answerText)?.id || "";
          const selectedFallback = answer && answer.is_fallback;
          const selectedOther = answer && !selectedFallback && !selectedOptionId;
          return `
            <article class="question-card" data-question-id="${escapeHtml(question.id)}">
              <div class="question-title">
                <span>${escapeHtml(question.label || question.type || "问题")}</span>
                <small>#${escapeHtml(question.type || question.id)}</small>
              </div>
              <h4>${escapeHtml(question.question)}</h4>
              ${question.why_it_matters ? `<p>${escapeHtml(question.why_it_matters)}</p>` : ""}
              <div class="choice-list">
                ${options
                  .map(
                    (option) => `
                      <button class="choice-option ${selectedOptionId === option.id ? "selected" : ""}" type="button" data-clarification-action="option" data-question-id="${escapeHtml(question.id)}" data-option-id="${escapeHtml(option.id)}" aria-pressed="${selectedOptionId === option.id ? "true" : "false"}">
                        <strong>${escapeHtml(option.label)}</strong>
                        <span>${escapeHtml(option.answer)}</span>
                        ${option.reason ? `<small>${escapeHtml(option.reason)}</small>` : ""}
                      </button>
                    `
                  )
                  .join("")}
                <button class="choice-option fallback-option ${selectedFallback ? "selected" : ""}" type="button" data-clarification-action="fallback" data-question-id="${escapeHtml(question.id)}" aria-pressed="${selectedFallback ? "true" : "false"}">
                  <strong>${escapeHtml(question.fallback_answer || "我还没想好")}</strong>
                  <span>${escapeHtml(question.recommended_answer || "先采用系统推荐答案。")}</span>
                  <small>${escapeHtml(question.fallback_effect || "系统会先采用推荐答案，并标记为待验证。")}</small>
                </button>
                <button class="choice-option other-trigger ${selectedOther ? "selected" : ""}" type="button" data-clarification-action="other" data-question-id="${escapeHtml(question.id)}" aria-pressed="${selectedOther ? "true" : "false"}">
                  <strong>其他答案</strong>
                  <span>我想自己补充一个更准确的回答。</span>
                </button>
              </div>
              <div class="other-answer" ${selectedOther ? "" : "hidden"}>
                <textarea data-question-answer="${escapeHtml(question.id)}" rows="3" placeholder="${escapeHtml(question.placeholder || "写下你的其他答案。")}">${selectedOther ? escapeHtml(answerText) : ""}</textarea>
                <button class="ghost-button" type="button" data-clarification-action="save-other" data-question-id="${escapeHtml(question.id)}">保存其他答案</button>
              </div>
              ${
                answer
                  ? `<div class="answer-chip">${answer.is_fallback ? "已采用推荐" : "已选择"}：${escapeHtml(answer.answer)}</div>`
                  : `<small class="fallback-effect">选择一个答案后，可以基于回答更新分析。</small>`
              }
            </article>
          `;
        })
        .join("")}
      ${
        includeUpdate && idea.can_edit && (idea.clarification_answers || []).length
          ? `<button class="primary-button" type="button" data-clarification-action="update">用补充答案更新分析</button>`
          : ""
      }
    </section>
  `;
}

function sectionKeyFromTitle(title) {
  const map = {
    竞品线索: "competitors",
    核心用户群体: "user_segments",
    业务流程: "business_flow",
    建议运营模式: "operation_model",
    产品核心能力: "product_capabilities",
    技术选型: "tech_stack",
    风险与验证建议: "risks",
    当前假设: "assumptions",
    待补充信息: "missing_info",
  };
  return map[title] || "";
}

function currentScores() {
  return state.selectedIdea?.analysis?.content?.section_scores || {};
}

function renderAnalysisSection(title, items, ordered = false) {
  const score = currentScores()[sectionKeyFromTitle(title)];
  return `
    <section class="analysis-section">
      <h3>${escapeHtml(title)}</h3>
      ${renderList(items, ordered)}
      ${renderSectionScore(score)}
    </section>
  `;
}

function renderHookAnalysis(value = {}, score) {
  const summary = value?.summary || "";
  const hooks = Array.isArray(value?.hooks) ? value.hooks : [];
  if (!summary && !hooks.length) return "";
  return `
    <section class="analysis-section">
      <h3>抓手分析</h3>
      ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}
      ${renderList(hooks)}
      ${renderSectionScore(score)}
    </section>
  `;
}

function renderSectionScore(score) {
  if (!score || !Array.isArray(score.dimensions) || !score.dimensions.length) return "";
  const total = Math.max(0, Math.min(100, Number(score.score) || 0));
  return `
    <div class="score-card">
      <div class="score-head">
        <span>评分</span>
        <strong>${total}</strong>
      </div>
      <div class="score-bars">
        ${score.dimensions
          .map((item) => {
            const itemScore = Math.max(0, Math.min(100, Number(item.score) || 0));
            return `
              <div class="score-row">
                <div>
                  <strong>${escapeHtml(item.label || "维度")}</strong>
                  ${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ""}
                </div>
                <span>${itemScore}</span>
                <i style="--score:${itemScore}%"></i>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
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
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
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
    clearLiveAnalysis();
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
    setButtonBusy(button, "提交中", true);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      delete payload.files;
      let { idea } = await api("/api/ideas", { method: "POST", body: payload });
      const uploaded = await uploadFiles(idea.id, files);
      if (uploaded) idea = uploaded;
      form.reset();
      $("newFileCount").textContent = "可多选";
      mergeIdea(idea);
      state.liveIdeaId = idea.id;
      state.activePage = "write";
      state.activeTab = "text";
      renderWorkspace();
      showNotice("已提交，右侧开始分析。");
      setButtonBusy(button, "分析中", true);
      await streamAnalysis(idea.id);
      await loadIdeas();
      await selectIdea(idea.id, false);
      renderWorkspace();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, "", false);
    }
  });

  $("ideaBoard").addEventListener("click", async (event) => {
    const card = event.target.closest(".idea-card");
    if (!card) return;
    clearLiveAnalysis();
    await selectIdea(Number(card.dataset.id), false);
    state.activePage = "analysis";
    renderWorkspace();
  });

  $("analysisIdeaList").addEventListener("click", async (event) => {
    const item = event.target.closest("[data-id]");
    if (!item) return;
    clearLiveAnalysis();
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
      mergeIdea(idea);
      renderWorkspace();
      showNotice("已保存，正在更新分析。");
      await streamAnalysis(idea.id);
      await loadIdeas();
      await selectIdea(idea.id, false);
      renderWorkspace();
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
        mergeIdea(uploaded);
        renderWorkspace();
        showNotice("附件已上传，正在更新分析。");
        await streamAnalysis(uploaded.id);
        await loadIdeas();
        await selectIdea(uploaded.id, false);
        renderWorkspace();
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
      mergeIdea(idea);
      renderWorkspace();
      showNotice("附件已删除，正在更新分析。");
      await streamAnalysis(idea.id);
      await loadIdeas();
      await selectIdea(idea.id, false);
      renderWorkspace();
    } catch (error) {
      showNotice(error.message, "error");
    }
  });

  $("reanalyzeButton").addEventListener("click", async () => {
    if (!state.selectedIdea) return;
    const button = $("reanalyzeButton");
    setButtonBusy(button, "分析中", true);
    try {
      const ideaId = state.selectedIdea.id;
      await streamAnalysis(ideaId);
      await loadIdeas();
      await selectIdea(ideaId, false);
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
  $("inlineAnalysisView").addEventListener("click", handleInlineAnalysisAction);
  $("inlineQuestions").addEventListener("click", handleClarificationAction);
  $("clarificationPanel").addEventListener("click", handleClarificationAction);
  $("updateAnalysisButton").addEventListener("click", async (event) => {
    if (!state.selectedIdea) return;
    const button = event.currentTarget;
    setButtonBusy(button, "继续分析中", true);
    try {
      const ideaId = state.selectedIdea.id;
      await streamAnalysis(ideaId, {
        intent: "clarification",
        status: "正在基于问题的答案继续分析",
        helper: "正在把你选择的补充答案、原始想法和已有分析摘要一起交给 LLM，再用当前 Skill 继续分析。",
        scrollToAnalysisTop: true,
      });
      await loadIdeas();
      await selectIdea(ideaId, false);
      renderWorkspace();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setButtonBusy(button, "", false);
    }
  });
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.page));
  });
}

bootstrap();
