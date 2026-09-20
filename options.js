(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  if (!Config || !Shared) return;

  const controls = Array.from(document.querySelectorAll("[data-setting]"));
  const els = {
    scope: document.querySelector("#scope"),
    saveStatus: document.querySelector("#saveStatus"),
    resetDefaults: document.querySelector("#resetDefaults"),
    resetRuntime: document.querySelector("#resetRuntime"),
    profile: document.querySelector("#profile"),
    templateName: document.querySelector("#templateName"),
    templateText: document.querySelector("#templateText"),
    saveTemplate: document.querySelector("#saveTemplate"),
    cancelTemplate: document.querySelector("#cancelTemplate"),
    resetTemplates: document.querySelector("#resetTemplates"),
    templateStatus: document.querySelector("#templateStatus"),
    templateList: document.querySelector("#templateList")
  };

  const params = new URLSearchParams(location.search);
  let sourceTabId = Number(params.get("tabId")) || 0;
  let contentState = null;
  let settings = { ...Config.DEFAULT_SETTINGS };
  let templates = [];
  let editingTemplateId = "";
  let pendingTemplateId = "";
  let saveTimer = null;
  let saveRevision = 0;
  let busy = false;
  const saveLock = Shared.createLock();

  const sendBackground = (message) => Shared.sendMessage(message, { soft: true });

  const sendContent = (message) => new Promise((resolve) => {
    if (!sourceTabId) return resolve(null);
    chrome.tabs.sendMessage(sourceTabId, message, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response || null);
    });
  });

  const injectContent = () => new Promise((resolve) => {
    if (!sourceTabId) return resolve(false);
    try {
      chrome.scripting.executeScript({
        target: { tabId: sourceTabId },
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

  function durableContentState(value) {
    return value?.pageId && Config.isDurablePageId(value.pageId) ? value : null;
  }

  async function resolveSourceTab() {
    if (sourceTabId) {
      const state = durableContentState(await sendContentWithInject({ type: "YOLO_GET_STATE" }));
      if (state) return state;
      sourceTabId = 0;
    }
    const tabs = await new Promise((resolve) => chrome.tabs.query({
      url: ["https://chatgpt.com/*", "https://*.chatgpt.com/*"]
    }, resolve));
    const candidates = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    for (const candidate of candidates) {
      if (!candidate?.id) continue;
      sourceTabId = candidate.id;
      const state = durableContentState(await sendContentWithInject({ type: "YOLO_GET_STATE" }));
      if (state) return state;
    }
    sourceTabId = 0;
    return null;
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    for (const control of controls) control.disabled = nextBusy || !contentState;
    for (const button of document.querySelectorAll("button:not([data-section-link]):not(#clearSearch)")) {
      button.disabled = nextBusy;
    }
    els.resetDefaults.disabled = nextBusy || !contentState;
    els.resetRuntime.disabled = nextBusy || !contentState;
  }

  function valueFromControl(control) {
    if (control.dataset.kind === "boolean") return control.checked;
    if (control.dataset.kind === "number") return control.value === "" ? undefined : Number(control.value);
    return control.value;
  }

  function collectSettings() {
    const next = { ...settings };
    for (const control of controls) {
      const value = valueFromControl(control);
      if (value !== undefined) next[control.dataset.setting] = value;
    }
    return Config.normalizeSettings(next);
  }

  function renderControls(nextSettings) {
    settings = Config.normalizeSettings(nextSettings);
    for (const control of controls) {
      if (document.activeElement === control) continue;
      const value = settings[control.dataset.setting];
      if (control.dataset.kind === "boolean") control.checked = Boolean(value);
      else control.value = String(value ?? "");
    }
  }

  function saveSettings(nextSettings = collectSettings()) {
    if (!sourceTabId || !contentState) return Promise.resolve(false);
    const requested = Config.normalizeSettings(nextSettings);
    const revision = ++saveRevision;
    settings = requested;
    els.saveStatus.textContent = "正在保存…";

    const task = async () => {
      const response = await sendContentWithInject({ type: "YOLO_SET_SETTINGS", settings: requested });
      if (!response?.ok) {
        if (revision === saveRevision) els.saveStatus.textContent = "无法保存设置。";
        return false;
      }
      contentState = durableContentState(response.state);
      if (!contentState) {
        if (revision === saveRevision) els.saveStatus.textContent = "所选对话已不再是可用的已保存对话。";
        return false;
      }
      if (revision === saveRevision) {
        renderControls(response.settings);
        els.scope.textContent = `${contentState.platform} · ${contentState.pageId}`;
        els.saveStatus.textContent = "已保存";
      }
      return true;
    };

    return Shared.withLock(saveLock, task);
  }

  function scheduleSave(event) {
    const setting = event.target?.dataset?.setting;
    if (event.target !== els.profile && setting !== "enabled") {
      settings = { ...collectSettings(), profile: "custom" };
      els.profile.value = "custom";
    }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      saveSettings();
    }, event.type === "input" ? 350 : 0);
  }

  async function flushScheduledSave() {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      await saveSettings().catch((error) => {
        console.error(`[YOLO options] settings save failed: ${Shared.errorMessage(error)}`);
        els.saveStatus.textContent = "保存失败";
      });
    }
    await saveLock.current.catch(() => {});
  }

  function setTemplateStatus(message = "", error = false) {
    els.templateStatus.textContent = message;
    els.templateStatus.dataset.level = error ? "error" : "info";
  }

  function compact(text, max = 180) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
  }

  function renderTemplates() {
    els.templateList.replaceChildren();
    if (!templates.length) {
      const empty = document.createElement("li");
      empty.className = "template-empty";
      empty.textContent = "暂无模板，请在左侧创建。";
      els.templateList.append(empty);
      return;
    }
    for (const template of templates) {
      const li = document.createElement("li");
      const copy = document.createElement("div");
      copy.className = "template-copy";
      const name = document.createElement("strong");
      name.textContent = template.name;
      const text = document.createElement("p");
      text.textContent = compact(template.text);
      copy.append(name, text);
      const actions = document.createElement("div");
      actions.className = "template-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => beginTemplateEdit(template));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除";
      remove.className = "danger";
      remove.addEventListener("click", () => removeTemplate(template.id));
      actions.append(edit, remove);
      li.append(copy, actions);
      els.templateList.append(li);
    }
  }

  function beginTemplateEdit(template) {
    editingTemplateId = template.id;
    pendingTemplateId = "";
    els.templateName.value = template.name;
    els.templateText.value = template.text;
    els.saveTemplate.textContent = "保存模板";
    els.cancelTemplate.hidden = false;
    els.templateName.focus();
    setTemplateStatus("正在编辑模板。");
  }

  function cancelTemplateEdit() {
    editingTemplateId = "";
    pendingTemplateId = "";
    els.templateName.value = "";
    els.templateText.value = "";
    els.saveTemplate.textContent = "添加模板";
    els.cancelTemplate.hidden = true;
    setTemplateStatus("");
  }

  async function saveTemplate() {
    const name = els.templateName.value.trim();
    const text = els.templateText.value.trim();
    if (!name || !text) {
      setTemplateStatus("请填写模板名称和消息内容。", true);
      return;
    }
    const adding = !editingTemplateId;
    if (adding && !pendingTemplateId) pendingTemplateId = crypto.randomUUID();
    setBusy(true);
    try {
      let response = await sendBackground(adding
        ? { type: "YOLO_TEMPLATE_ADD", template: { id: pendingTemplateId, name, text } }
        : { type: "YOLO_TEMPLATE_UPDATE", template: { id: editingTemplateId, name, text } });
      if (response?.ok && adding && response.deduplicated
        && (response.template?.name !== name || response.template?.text !== text)) {
        response = await sendBackground({
          type: "YOLO_TEMPLATE_UPDATE",
          template: { id: pendingTemplateId, name, text }
        });
      }
      if (!response?.ok) {
        setTemplateStatus(response?.reason || "无法保存模板。", true);
        return;
      }
      templates = response.templates;
      cancelTemplateEdit();
      renderTemplates();
      setTemplateStatus("模板已保存。");
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(templateId) {
    if (!window.confirm("确定删除此模板吗？此操作无法撤销。")) return;
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_TEMPLATE_REMOVE", templateId });
      if (response?.ok) {
        templates = response.templates;
        if (editingTemplateId === templateId) cancelTemplateEdit();
        renderTemplates();
        setTemplateStatus("模板已删除。");
      } else setTemplateStatus(response?.reason || "无法删除模板。", true);
    } finally {
      setBusy(false);
    }
  }

  async function resetTemplates() {
    if (!window.confirm("要用内置默认模板替换全部现有模板吗？")) return;
    setBusy(true);
    try {
      const response = await sendBackground({ type: "YOLO_TEMPLATES_RESET" });
      if (response?.ok) {
        templates = response.templates;
        cancelTemplateEdit();
        renderTemplates();
        setTemplateStatus("已恢复默认模板。");
      } else {
        setTemplateStatus(response?.reason || "无法恢复默认模板。", true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    setBusy(true);
    contentState = await resolveSourceTab();
    if (!contentState) {
      els.scope.textContent = "请打开一个已保存的 ChatGPT 对话（/c/...）以配置自动化。下方模板功能仍可使用。";
      els.saveStatus.textContent = "未选择已保存的对话";
    } else {
      settings = contentState.settings;
      renderControls(settings);
      els.scope.textContent = `${contentState.platform} · ${contentState.pageId}`;
      els.saveStatus.textContent = "已保存";
    }

    const templateResponse = await sendBackground({ type: "YOLO_TEMPLATES_GET" });
    if (templateResponse?.ok) templates = templateResponse.templates;
    renderTemplates();

    const section = params.get("section");
    if (section) document.getElementById(section)?.scrollIntoView({ block: "start" });
    setBusy(false);
  }

  for (const control of controls) {
    control.addEventListener("change", (event) => {
      if (control === els.profile && ["safe", "balanced", "fast"].includes(control.value)) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
        const next = Config.applyPreset(collectSettings(), control.value);
        renderControls(next);
        saveSettings(next);
      } else scheduleSave(event);
    });
    if (control.matches("input[type='number'], textarea")) control.addEventListener("input", scheduleSave);
  }

  els.resetDefaults.addEventListener("click", () => {
    if (!window.confirm("确定将所有自动化设置恢复为默认值吗？")) return;
    const next = Config.normalizeSettings({ ...Config.DEFAULT_SETTINGS, enabled: settings.enabled });
    renderControls(next);
    saveSettings(next);
  });
  els.resetRuntime.addEventListener("click", async () => {
    await flushScheduledSave();
    setBusy(true);
    const response = await sendContentWithInject({ type: "YOLO_RESET_RUNTIME" });
    els.saveStatus.textContent = response?.ok ? "会话历史已重置" : "无法重置会话历史";
    setBusy(false);
  });
  els.saveTemplate.addEventListener("click", saveTemplate);
  els.cancelTemplate.addEventListener("click", cancelTemplateEdit);
  els.resetTemplates.addEventListener("click", resetTemplates);

  globalThis.YOLOOptionsController = Object.freeze({
    async beginExternalMutation() {
      setBusy(true);
      await flushScheduledSave();
      return true;
    },
    endExternalMutation() {
      setBusy(false);
    },
    getContext() {
      return {
        sourceTabId: contentState ? sourceTabId : 0,
        pageId: contentState?.pageId || ""
      };
    }
  });

  window.addEventListener("pagehide", () => window.clearTimeout(saveTimer));
  init().catch((error) => {
    sourceTabId = 0;
    contentState = null;
    els.scope.textContent = `启动失败：${Shared.errorMessage(error)}`;
    els.saveStatus.textContent = "不可用";
    setBusy(true);
  });
})();
