(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  if (!Config || !Shared || !Lifecycle || !chrome.alarms || !chrome.tabs || !chrome.scripting) return;

  const ALARM_NAME = "yolo-tab-supervisor";
  const INJECTION_COOLDOWN_MS = 5 * 60 * 1_000;
  const HEALTH_TIMEOUT_MS = 4_000;
  const INJECTION_TIMEOUT_MS = 5_000;
  const RECOVERY_RELOAD_COOLDOWN_MS = 10 * 60 * 1_000;
  const ACTIVE_HEARTBEAT_STALE_MS = 60 * 1_000;
  const BACKGROUND_HEARTBEAT_STALE_MS = 150 * 1_000;
  const MAX_INJECTIONS_PER_SWEEP = 2;
  const SCRIPT_FILES = Object.freeze([
    "config.js",
    "lifecycle.js",
    "platforms.js",
    "shared.js",
    "commands.js",
    "rollover.js",
    "command-ui.js",
    "content-state.js",
    "content.js",
    "command-runtime.js"
  ]);
  const lastInjectionAt = new Map();
  const lastRecoveryReloadAt = new Map();

  const tabsQuery = (queryInfo) => new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(chrome.runtime.lastError ? [] : tabs || []));
  });

  const tabsGet = (tabId) => new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab || null));
  });

  const storageGet = (keys) => Shared.storageGet(keys, { soft: true });
  const storageSet = (items) => Shared.storageSet(items, { soft: true });

  const sessionGet = (keys) => new Promise((resolve) => {
    const area = chrome.storage?.session;
    if (!area?.get) return resolve({});
    try {
      area.get(keys, (value) => resolve(chrome.runtime.lastError ? {} : value || {}));
    } catch {
      resolve({});
    }
  });

  const tabsUpdate = (tabId, updateProperties) => new Promise((resolve) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => resolve(chrome.runtime.lastError ? null : tab || null));
  });

  const tabsCreate = (createProperties) => new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab) => resolve(chrome.runtime.lastError ? null : tab || null));
  });

  const sendHealth = (tabId) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), HEALTH_TIMEOUT_MS);
    try {
      chrome.tabs.sendMessage(tabId, { type: "YOLOTAB_HEALTH_CHECK" }, (response) => {
        finish(chrome.runtime.lastError ? null : response || null);
      });
    } catch {
      finish(null);
    }
  });

  const injectScripts = (tabId) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), INJECTION_TIMEOUT_MS);
    try {
      chrome.scripting.executeScript({ target: { tabId }, files: SCRIPT_FILES }, () => {
        finish(!chrome.runtime.lastError);
      });
    } catch {
      finish(false);
    }
  });

  const reloadTab = (tabId) => new Promise((resolve) => {
    try {
      chrome.tabs.reload(tabId, {}, () => resolve(!chrome.runtime.lastError));
    } catch {
      resolve(false);
    }
  });

  function ensureAlarm() {
    chrome.alarms.get(ALARM_NAME, (alarm) => {
      if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    });
  }

  function canInspect(tab) {
    return Boolean(tab?.id
      && Config.isSupportedUrl(tab.url || tab.pendingUrl || "")
      && !tab.discarded
      && tab.status !== "loading");
  }

  async function recoverProtectedTab(tab, reason) {
    const previous = lastRecoveryReloadAt.get(tab.id) || 0;
    if (Date.now() - previous < RECOVERY_RELOAD_COOLDOWN_MS) return false;
    lastRecoveryReloadAt.set(tab.id, Date.now());
    const reloaded = await reloadTab(tab.id);
    if (!reloaded) lastRecoveryReloadAt.delete(tab.id);
    if (reloaded) console.warn(`YOLO reloaded protected workflow tab ${tab.id}: ${reason}`);
    return reloaded;
  }

  async function readProtection(tab) {
    const pageId = Config.pageId(tab.url || tab.pendingUrl || "");
    if (!Config.isDurablePageId(pageId)) return { protect: false, pageId, workflow: null };
    const pageKey = Config.pageSettingsKey(pageId);
    const workflowKey = Config.workflowKey(pageId);
    const stored = await storageGet([Config.STORAGE_KEYS.global, Config.STORAGE_KEYS.pages, pageKey, workflowKey]);
    const settings = Config.mergeSettings(
      Config.DEFAULT_SETTINGS,
      stored[Config.STORAGE_KEYS.global] || {},
      stored[pageKey] || stored[Config.STORAGE_KEYS.pages]?.[pageId] || {}
    );
    const workflow = stored[workflowKey] && typeof stored[workflowKey] === "object" ? stored[workflowKey] : null;
    return {
      protect: Lifecycle.shouldProtectTab({
      enabled: settings.protectActiveWorkflowTabs,
        workflowStatus: workflow?.status
      }),
      pageId,
      workflow
    };
  }

  async function readHeartbeat(tab) {
    const pageId = Config.pageId(tab.url || tab.pendingUrl || "");
    const stored = await sessionGet([Config.TAB_HEARTBEAT_SESSION_KEY]);
    const map = stored?.[Config.TAB_HEARTBEAT_SESSION_KEY];
    const heartbeat = map && typeof map === "object" ? map[String(tab.id)] : null;
    if (!heartbeat || heartbeat.pageId !== pageId) return null;
    return heartbeat;
  }

  function heartbeatIsStale(tab, heartbeat, timestamp = Date.now()) {
    if (!heartbeat?.at) return false;
    const staleAfter = tab.active ? ACTIVE_HEARTBEAT_STALE_MS : BACKGROUND_HEARTBEAT_STALE_MS;
    return timestamp - heartbeat.at >= staleAfter;
  }

  function canReplaceFrozenWorkflow(workflow) {
    return Boolean(workflow
      && workflow.status === "running"
      && workflow.awaitingResponse
      && !workflow.pendingItemId);
  }

  async function hasActiveRollover(tabId) {
    const stored = await storageGet([Config.STORAGE_KEYS.rollovers]);
    const transaction = stored?.[Config.STORAGE_KEYS.rollovers]?.[String(tabId)];
    return Boolean(transaction && !["bound", "blocked"].includes(transaction.phase));
  }

  async function releaseWorkflowRunner(pageId, workflow) {
    if (!canReplaceFrozenWorkflow(workflow)) return false;
    const key = Config.workflowKey(pageId);
    const next = {
      ...workflow,
      revision: (Number(workflow.revision) || 0) + 1,
      runnerId: "",
      runnerExpiresAt: 0,
      reason: "正在恢复卡死的 ChatGPT 页面",
      updatedAt: Date.now()
    };
    return storageSet({ [key]: next });
  }

  async function replaceProtectedTab(tab, protection, reason) {
    if (!canReplaceFrozenWorkflow(protection?.workflow)) return false;
    if (await hasActiveRollover(tab.id)) return false;
    if (!await releaseWorkflowRunner(protection.pageId, protection.workflow)) return false;

    const createProperties = {
      url: tab.url || protection.pageId,
      active: Boolean(tab.active),
      windowId: tab.windowId
    };
    if (Number.isInteger(tab.index)) createProperties.index = tab.index + 1;
    if (typeof tab.pinned === "boolean") createProperties.pinned = tab.pinned;
    const replacement = await tabsCreate(createProperties);
    if (!replacement?.id) return false;

    try {
      chrome.tabs.remove(tab.id, () => { void chrome.runtime.lastError; });
    } catch {
      // The replacement tab already owns the durable workflow. Old-tab cleanup is best effort.
    }
    console.warn(`YOLO replaced protected workflow tab ${tab.id} with ${replacement.id}: ${reason}`);
    return true;
  }

  async function inspect(tab, { allowInjection = true } = {}) {
    if (!canInspect(tab)) return { inspected: false, injected: false };
    const protection = await readProtection(tab);
    const protect = protection.protect;
    const desiredAutoDiscardable = !protect;
    if (tab.autoDiscardable !== desiredAutoDiscardable) {
      await tabsUpdate(tab.id, { autoDiscardable: desiredAutoDiscardable });
    }

    if (protect) {
      const heartbeat = await readHeartbeat(tab);
      if (heartbeatIsStale(tab, heartbeat)) {
        const replaced = await replaceProtectedTab(tab, protection, "content heartbeat is stale");
        if (replaced) {
          return { inspected: true, injected: false, healthy: false, replaced: true, staleHeartbeat: true };
        }
        const reloaded = await recoverProtectedTab(tab, "content heartbeat is stale");
        return { inspected: true, injected: false, healthy: false, reloaded, staleHeartbeat: true };
      }
    }

    if (tab.frozen) {
      const reloaded = protect ? await recoverProtectedTab(tab, "tab is frozen") : false;
      return { inspected: true, injected: false, healthy: false, reloaded };
    }

    let health = await sendHealth(tab.id);
    let injected = false;

    if (!health?.ok && allowInjection) {
      const previous = lastInjectionAt.get(tab.id) || 0;
      if (Date.now() - previous >= INJECTION_COOLDOWN_MS) {
        lastInjectionAt.set(tab.id, Date.now());
        injected = await injectScripts(tab.id);
        if (injected) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          health = await sendHealth(tab.id);
        }
      }
    }

    let reloaded = false;
    if (!health?.ok && protect) {
      reloaded = await recoverProtectedTab(tab, "content runtime did not answer health checks");
    }

    return { inspected: true, injected, healthy: Boolean(health?.ok), reloaded };
  }

  async function sweep() {
    const tabs = await tabsQuery({ url: ["https://chatgpt.com/*", "https://*.chatgpt.com/*"] });
    tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    let injections = 0;
    for (const tab of tabs) {
      const result = await inspect(tab, { allowInjection: injections < MAX_INJECTIONS_PER_SWEEP });
      if (result.injected) injections += 1;
    }
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const tabId of lastInjectionAt.keys()) if (!liveIds.has(tabId)) lastInjectionAt.delete(tabId);
    for (const tabId of lastRecoveryReloadAt.keys()) if (!liveIds.has(tabId)) lastRecoveryReloadAt.delete(tabId);
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === ALARM_NAME) sweep().catch((error) => console.error(`Tab supervisor sweep failed: ${Shared.errorMessage(error)}`));
  });
  chrome.runtime.onStartup?.addListener(() => {
    ensureAlarm();
    sweep().catch((error) => console.error(`Tab supervisor startup sweep failed: ${Shared.errorMessage(error)}`));
  });
  chrome.runtime.onInstalled?.addListener(() => {
    ensureAlarm();
    sweep().catch((error) => console.error(`Tab supervisor install sweep failed: ${Shared.errorMessage(error)}`));
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete") return;
    tabsGet(tabId).then((tab) => tab && inspect(tab)).catch((error) => console.error(`Tab supervisor updated-tab inspection failed: ${Shared.errorMessage(error)}`));
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    tabsGet(tabId).then((tab) => tab && inspect(tab)).catch((error) => console.error(`Tab supervisor activated-tab inspection failed: ${Shared.errorMessage(error)}`));
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    lastInjectionAt.delete(tabId);
    lastRecoveryReloadAt.delete(tabId);
  });

  ensureAlarm();
})();
