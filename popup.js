(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  if (!Config || !Shared) return;

  const els = {
    enabled: document.querySelector("#enabled"),
    profile: document.querySelector("#profile"),
    status: document.querySelector("#status"),
    scope: document.querySelector("#scope"),
    queueCount: document.querySelector("#queueCount"),
    message: document.querySelector("#message"),
    templateSelect: document.querySelector("#templateSelect"),
    manageTemplates: document.querySelector("#manageTemplates"),
    addQueue: document.querySelector("#addQueue"),
    addAndSend: document.querySelector("#addAndSend"),
    cancelEdit: document.querySelector("#cancelEdit"),
    composeStatus: document.querySelector("#composeStatus"),
    togglePause: document.querySelector("#togglePause"),
    sendNext: document.querySelector("#sendNext"),
    clearQueue: document.querySelector("#clearQueue"),
    emptyQueue: document.querySelector("#emptyQueue"),
    queueList: document.querySelector("#queueList"),
    lastAction: document.querySelector("#lastAction"),
    blockedReason: document.querySelector("#blockedReason"),
    blockedText: document.querySelector("#blockedText"),
    sessionActions: document.querySelector("#sessionActions"),
    hourlyActions: document.querySelector("#hourlyActions"),
    nextSend: document.querySelector("#nextSend"),
    eventList: document.querySelector("#eventList"),
    advanced: document.querySelector("#advanced"),
    version: document.querySelector("#version")
  };

  let activeTab = null;
  let contentState = null;
  let queueState = { paused: false, items: [], events: [] };
  let templates = [];
  let editingId = "";
  let busy = false;
  let pollTimer = null;
  let clearArmedUntil = 0;
  let draggedId = "";

  const queryActiveTab = () => new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => resolve(tab || null));
  });

  const sendContent = (message) => new Promise((resolve) => {
    if (!activeTab?.id) return resolve(null);
    chrome.tabs.sendMessage(activeTab.id, message, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response || null);
    });
  });

  const injectContent = () => new Promise((resolve) => {
    if (!activeTab?.id) return resolve(false);
    try {
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["config.js", "lifecycle.js", "platforms.js", "shared.js", "commands.js", "rollover.js", "command-ui.js", "content-state.js", "content.js", "command-runtime.js"]
      }, () => resolve(!chrome.runtime.lastError));
    } catch {
      resolve(false);
    }
  });

  async function sendContentWithInject(message) {
    const first = await sendContent(message);
    if (first) return first;
    if (!await injectContent()) return null;
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    return sendContent(message);
  }

  const sendBackground = (message) => Shared.sendMessage(message, { soft: true });

  function workflowOwned(item) {
    return Boolean(item && String(item.source || "").startsWith("workflow:") && item.sourceId);
  }

  function setComposeStatus(message = "", level = "info") {
    els.composeStatus.textContent = message;
    els.composeStatus.dataset.level = level;
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    for (const element of [
      els.enabled, els.profile, els.message, els.templateSelect, els.manageTemplates,
      els.addQueue, els.addAndSend, els.cancelEdit, els.togglePause, els.sendNext,
      els.clearQueue, els.advanced
    ]) element.disabled = nextBusy;
    if (!nextBusy && contentState) {
      renderQueue();
      return;
    }
    for (const button of els.queueList.querySelectorAll("button")) button.disabled = true;
  }

  function setUnavailable(scopeMessage) {
    setBusy(true);
    els.status.textContent = "不可用";
    els.status.dataset.on = "false";
    els.scope.textContent = scopeMessage;
    els.scope.title = scopeMessage;
    // Settings and templates are extension-owned and remain usable without a ChatGPT tab.
    els.manageTemplates.disabled = false;
    els.advanced.disabled = false;
  }

  function formatRelative(timestamp) {
    if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return "—";
    const delta = Number(timestamp) - Date.now();
    return delta <= 0 ? "就绪" : Config.formatDuration(delta);
  }

  function formatAgo(timestamp) {
    if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return "";
    const delta = Date.now() - Number(timestamp);
    if (delta < 5000) return "刚刚";
    return `${Config.formatDuration(delta)}前`;
  }

  function compactText(text, max = 180) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
  }

  function renderTemplates() {
    const selected = els.templateSelect.value;
    els.templateSelect.replaceChildren(new Option("选择模板…", ""));
    for (const template of templates) els.templateSelect.add(new Option(template.name, template.id));
    if (templates.some((template) => template.id === selected)) els.templateSelect.value = selected;
  }

  function renderEvents() {
    els.eventList.replaceChildren();
    const events = Array.isArray(queueState.events) ? queueState.events.slice(-8).reverse() : [];
    for (const event of events) {
      const li = document.createElement("li");
      li.dataset.level = event.level || "info";
      const message = document.createElement("span");
      message.textContent = event.message;
      const time = document.createElement("time");
      time.textContent = formatAgo(event.at);
      li.append(message, time);
      els.eventList.append(li);
    }
    if (!events.length) {
      const li = document.createElement("li");
      const message = document.createElement("span");
      message.textContent = "暂无队列活动。";
      const time = document.createElement("time");
      li.append(message, time);
      els.eventList.append(li);
    }
  }

  function moveOrder(itemId, direction) {
    const ids = queueState.items.map((item) => item.id);
    const index = ids.indexOf(itemId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return null;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    return ids;
  }

  async function reorderQueue(orderedIds) {
    if (!orderedIds || busy) return;
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_QUEUE_REORDER", pageId: contentState.pageId, orderedIds });
      if (response?.ok) {
        queueState = response.state;
        renderQueue();
      } else setComposeStatus(response?.reason || "无法调整队列顺序。", "error");
    } finally {
      setBusy(false);
    }
  }

  function itemButton(label, title, handler, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.className = className;
    button.addEventListener("click", handler);
    return button;
  }

  function renderQueue() {
    const items = Array.isArray(queueState.items) ? queueState.items : [];
    const hasWorkflowItem = items.some(workflowOwned);
    els.queueCount.textContent = `队列 ${items.length} 条`;
    els.emptyQueue.hidden = items.length > 0;
    els.queueList.replaceChildren();
    els.togglePause.textContent = queueState.paused ? "继续" : "暂停";
    els.togglePause.classList.toggle("danger", queueState.paused);
    els.clearQueue.disabled = busy || items.length === 0 || hasWorkflowItem;
    els.clearQueue.title = hasWorkflowItem
      ? "请先停止当前工作流，再清空其托管提示词"
      : "清空待发送队列消息";

    items.forEach((item, index) => {
      const managed = workflowOwned(item);
      const li = document.createElement("li");
      li.className = "queue-item";
      li.dataset.id = item.id;
      li.dataset.state = item.state;
      li.dataset.workflowOwned = String(managed);
      li.draggable = !hasWorkflowItem && !managed && item.state !== "sending" && !busy;

      const drag = itemButton("⋮⋮", managed ? "工作流托管消息" : "拖动排序", () => {}, "drag-handle");
      drag.setAttribute("aria-label", managed ? "工作流托管的队列消息" : "拖动队列消息");

      const copy = document.createElement("div");
      copy.className = "queue-copy";
      const strong = document.createElement("strong");
      strong.textContent = compactText(item.text);
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      const position = document.createElement("span");
      position.textContent = `#${index + 1}`;
      const status = document.createElement("span");
      const stateLabel = {
        pending: "等待中",
        claimed: "已领取",
        submitting: "提交中",
        sending: "发送中",
        failed: "失败"
      }[item.state] || item.state;
      status.textContent = item.state === "failed"
        ? `失败${item.attempts ? ` · 已尝试 ${item.attempts} 次` : ""}`
        : stateLabel;
      status.className = item.state;
      meta.append(position, status);
      if (managed) {
        const owner = document.createElement("span");
        owner.textContent = "由工作流管理";
        owner.title = "暂停、编辑或停止工作流后才能修改此提示词";
        meta.append(owner);
      }
      if (item.nextAttemptAt > Date.now()) {
        const retry = document.createElement("span");
        retry.textContent = `重试：${formatRelative(item.nextAttemptAt)}`;
        meta.append(retry);
      }
      copy.append(strong, meta);
      if (item.error) {
        const error = document.createElement("small");
        error.className = "queue-error";
        error.textContent = compactText(item.error, 140);
        error.title = item.error;
        copy.append(error);
      }

      const actions = document.createElement("div");
      actions.className = "item-actions";
      if (item.state === "failed" && !managed) {
        actions.append(itemButton("↻", "重试消息", () => retryItem(item.id)));
      }
      const moveUp = itemButton("↑", "上移", () => reorderQueue(moveOrder(item.id, -1)));
      const moveDown = itemButton("↓", "下移", () => reorderQueue(moveOrder(item.id, 1)));
      const edit = itemButton("编辑", managed ? "请改为编辑当前工作流" : "编辑消息", () => beginEdit(item));
      const remove = itemButton("×", managed ? "请改为停止当前工作流" : "删除消息", () => removeItem(item.id), "danger");
      moveUp.disabled = hasWorkflowItem || managed || index === 0;
      moveDown.disabled = hasWorkflowItem || managed || index === items.length - 1;
      edit.disabled = managed;
      remove.disabled = managed;
      actions.append(moveUp, moveDown, edit, remove);
      if (busy || item.state === "sending") {
        for (const button of actions.querySelectorAll("button")) button.disabled = true;
        drag.disabled = true;
      } else if (managed || hasWorkflowItem) drag.disabled = true;

      li.append(drag, copy, actions);
      if (!managed && !hasWorkflowItem) {
        li.addEventListener("dragstart", (event) => {
          draggedId = item.id;
          li.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", item.id);
        });
        li.addEventListener("dragend", () => {
          draggedId = "";
          for (const entry of els.queueList.children) entry.classList.remove("dragging", "drop-target");
        });
        li.addEventListener("dragover", (event) => {
          if (!draggedId || draggedId === item.id || hasWorkflowItem) return;
          event.preventDefault();
          li.classList.add("drop-target");
        });
        li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
        li.addEventListener("drop", (event) => {
          event.preventDefault();
          li.classList.remove("drop-target");
          const sourceId = event.dataTransfer.getData("text/plain") || draggedId;
          const ids = items.map((entry) => entry.id).filter((id) => id !== sourceId);
          const targetIndex = ids.indexOf(item.id);
          const rect = li.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          ids.splice(targetIndex + (after ? 1 : 0), 0, sourceId);
          reorderQueue(ids);
        });
      }
      els.queueList.append(li);
    });
    renderEvents();
  }

  function renderContentState() {
    const settings = contentState?.settings || Config.DEFAULT_SETTINGS;
    const runtime = contentState?.runtime || {};
    els.enabled.checked = Boolean(settings.enabled);
    els.profile.value = settings.profile || "custom";
    els.status.textContent = settings.enabled ? "常规运行" : "常规暂停";
    els.status.dataset.on = String(Boolean(settings.enabled));
    els.scope.textContent = `${contentState?.platform || "聊天"} · 当前对话`;
    els.scope.title = els.scope.textContent;
    els.lastAction.textContent = contentState?.lastAction?.message || "暂无活动";
    els.lastAction.title = els.lastAction.textContent;
    els.sessionActions.textContent = String(runtime.sessionActionCount || 0);
    els.hourlyActions.textContent = String(
      (runtime.approvalCountLastHour || 0)
      + (runtime.recoveryCountLastHour || 0)
      + (runtime.nudgeCountLastHour || 0)
      + (runtime.refreshCountLastHour || 0)
      + (runtime.queueCountLastHour || 0)
    );
    els.nextSend.textContent = settings.queueAutoRunEnabled ? formatRelative(runtime.nextQueueAt) : "关闭";
    els.blockedReason.hidden = !runtime.blockedReason;
    els.blockedText.hidden = !runtime.blockedReason;
    els.blockedText.textContent = runtime.blockedReason || "";
    els.version.textContent = `v${contentState?.version || Config.VERSION}`;
  }

  async function refreshAll({ includeTemplates = false, force = false } = {}) {
    if (!activeTab?.id || (busy && !force)) return false;
    const nextContent = await sendContentWithInject({ type: "YOLO_GET_STATE" });
    if (!nextContent?.pageId) return false;
    const tasks = [sendBackground({ type: "YOLO_QUEUE_GET", pageId: nextContent.pageId })];
    if (includeTemplates) tasks.push(sendBackground({ type: "YOLO_TEMPLATES_GET" }));
    const [queueResponse, templateResponse] = await Promise.all(tasks);
    if (!queueResponse?.ok) return false;
    contentState = nextContent;
    queueState = queueResponse.state;
    if (templateResponse?.ok) templates = templateResponse.templates;
    renderContentState();
    renderQueue();
    if (includeTemplates) renderTemplates();
    return true;
  }

  async function saveCoreSettings(next) {
    if (!contentState || busy) return false;
    const previousState = contentState;
    const requested = Config.mergeSettings(contentState.settings, next);
    contentState = { ...contentState, settings: requested };
    renderContentState();
    setBusy(true);
    try {
      const response = await sendContentWithInject({ type: "YOLO_SET_SETTINGS", settings: requested });
      if (!response?.ok) {
        contentState = previousState;
        renderContentState();
        setComposeStatus("无法保存设置。", "error");
        return false;
      }
      contentState = response.state;
      renderContentState();
      setComposeStatus("设置已保存。", "success");
      return true;
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(item) {
    if (workflowOwned(item)) return;
    editingId = item.id;
    els.message.value = item.text;
    els.addQueue.textContent = "保存消息";
    els.addAndSend.hidden = true;
    els.cancelEdit.hidden = false;
    els.message.focus();
    setComposeStatus("正在编辑队列消息。");
  }

  function cancelEdit() {
    editingId = "";
    els.message.value = "";
    els.addQueue.textContent = "加入队列";
    els.addAndSend.hidden = false;
    els.cancelEdit.hidden = true;
    setComposeStatus("");
  }

  async function addOrUpdate({ send = false } = {}) {
    const text = els.message.value.trim();
    if (!text) {
      setComposeStatus("请先输入消息。", "error");
      return;
    }
    setBusy(true);
    try {
      const response = editingId
        ? await sendBackground({ type: "YOLO_QUEUE_UPDATE", pageId: contentState.pageId, itemId: editingId, text })
        : await sendBackground({ type: "YOLO_QUEUE_ADD", pageId: contentState.pageId, item: { text, templateId: els.templateSelect.value }, front: send });
      if (!response?.ok) {
        setComposeStatus(response?.reason || "无法更新队列。", "error");
        return;
      }
      const wasEditing = Boolean(editingId);
      queueState = response.state;
      cancelEdit();
      renderQueue();
      setComposeStatus(wasEditing ? "消息已更新。" : "消息已加入队列。", "success");
      if (send) {
        const result = await sendContentWithInject({ type: "YOLO_RUN_ACTION", action: "queue-next" });
        if (result?.state) contentState = result.state;
        await refreshAll({ force: true });
        setComposeStatus(result?.ok ? "消息已发送。" : "消息已加入队列；当前对话尚未满足发送条件。", result?.ok ? "success" : "info");
      } else {
        sendContentWithInject({ type: "YOLO_RUN_ACTION", action: "scan" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(itemId) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_QUEUE_REMOVE", pageId: contentState.pageId, itemId });
      if (response?.ok) {
        queueState = response.state;
        if (editingId === itemId) cancelEdit();
        renderQueue();
      } else setComposeStatus(response?.reason || "无法删除消息。", "error");
    } finally {
      setBusy(false);
    }
  }

  async function retryItem(itemId) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_QUEUE_RETRY", pageId: contentState.pageId, itemId });
      if (response?.ok) {
        queueState = response.state;
        renderQueue();
        sendContentWithInject({ type: "YOLO_RUN_ACTION", action: "scan" });
      } else setComposeStatus(response?.reason || "无法重试消息。", "error");
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_QUEUE_PAUSE", pageId: contentState.pageId, paused: !queueState.paused });
      if (response?.ok) {
        queueState = response.state;
        renderQueue();
        if (!queueState.paused) sendContentWithInject({ type: "YOLO_RUN_ACTION", action: "scan" });
      } else setComposeStatus(response?.reason || "无法更改队列状态。", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendNext() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await sendContentWithInject({ type: "YOLO_RUN_ACTION", action: "queue-next" });
      if (response?.state) contentState = response.state;
      await refreshAll({ force: true });
      setComposeStatus(response?.ok ? "下一条消息已发送。" : "当前对话正忙、已暂停或达到限制。", response?.ok ? "success" : "info");
    } finally {
      setBusy(false);
    }
  }

  async function clearQueue() {
    if (busy) return;
    if (Date.now() > clearArmedUntil) {
      clearArmedUntil = Date.now() + 3000;
      els.clearQueue.textContent = "确认清空";
      window.setTimeout(() => {
        if (Date.now() > clearArmedUntil) els.clearQueue.textContent = "清空";
      }, 3100);
      return;
    }
    clearArmedUntil = 0;
    els.clearQueue.textContent = "清空";
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_QUEUE_CLEAR", pageId: contentState.pageId });
      if (response?.ok) {
        queueState = response.state;
        cancelEdit();
        renderQueue();
      } else setComposeStatus(response?.reason || "无法清空队列。", "error");
    } finally {
      setBusy(false);
    }
  }

  function openAdvanced(section = "") {
    const params = new URLSearchParams({ tabId: String(activeTab?.id || ""), pageId: contentState?.pageId || "" });
    if (section) params.set("section", section);
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?${params}`) });
  }

  async function init() {
    setBusy(true);
    els.version.textContent = `v${Config.VERSION}`;
    activeTab = await queryActiveTab();
    if (!Config.isSupportedUrl(activeTab?.url)) {
      setUnavailable("请打开 ChatGPT 以使用对话自动化。设置和模板仍可使用。");
      return;
    }
    if (!await refreshAll({ includeTemplates: true, force: true })) {
      setUnavailable("无法在当前标签页启动 YOLO。设置和模板仍可使用。");
      return;
    }
    pollTimer = window.setInterval(() => refreshAll(), 1800);
    setBusy(false);
  }

  els.enabled.addEventListener("change", () => saveCoreSettings({ enabled: els.enabled.checked, profile: contentState.settings.profile }));
  els.profile.addEventListener("change", () => {
    const next = Config.applyPreset(contentState.settings, els.profile.value);
    saveCoreSettings(next);
  });
  els.templateSelect.addEventListener("change", () => {
    const template = templates.find((entry) => entry.id === els.templateSelect.value);
    if (!template) return;
    els.message.value = Config.renderTemplate(template.text, {
      platform: contentState?.platform,
      conversation: contentState?.pageId
    });
    els.message.focus();
  });
  els.manageTemplates.addEventListener("click", () => openAdvanced("templates"));
  els.addQueue.addEventListener("click", () => addOrUpdate());
  els.addAndSend.addEventListener("click", () => addOrUpdate({ send: true }));
  els.cancelEdit.addEventListener("click", cancelEdit);
  els.togglePause.addEventListener("click", togglePause);
  els.sendNext.addEventListener("click", sendNext);
  els.clearQueue.addEventListener("click", clearQueue);
  els.advanced.addEventListener("click", () => openAdvanced());
  els.message.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      addOrUpdate({ send: event.shiftKey && !editingId });
    }
  });

  window.addEventListener("pagehide", () => window.clearInterval(pollTimer));
  init().catch((error) => {
    setUnavailable(`Startup failed: ${Shared.errorMessage(error)} Settings and templates remain available.`);
  });
})();
