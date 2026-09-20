"use strict";

importScripts("config.js", "shared.js", "coordinator.js", "portable-store.js", "queue.js", "commands.js", "rollover.js");

const Config = globalThis.YOLOConfig;
const Shared = globalThis.YOLOShared;
const Coordinator = globalThis.YOLOCoordinator;
const PortableStore = globalThis.YOLOPortableStore;
const Queue = globalThis.YOLOQueue;
const Commands = globalThis.YOLOCommands;
const Rollover = globalThis.YOLORollover;
const queueLock = Shared.createLock();
const workflowLock = Shared.createLock();
const actionLock = Shared.createLock();
const rolloverLock = Shared.createLock();
const heartbeatLock = Shared.createLock();
const MAX_CONVERSATION_QUEUES = 25;
const MAX_ACTIVE_WORKFLOWS = 25;
const MAX_RETAINED_COMPLETED_WORKFLOWS = 100;
const ACTIVE_WORKFLOW_STATUSES = new Set(["running", "paused", "blocked"]);
const WORKFLOW_LEASE_MS = 2 * 60 * 1000;
const WORKFLOW_RENEW_WINDOW_MS = 30 * 1000;
const MAX_ACTIVE_ROLLOVERS = 25;
const BROWSER_SESSION_KEY = "yoloBrowserSessionIdV1";
const HEARTBEAT_RETENTION_MS = 15 * 60 * 1000;
let browserSessionPromise = null;

const storageGet = Shared.storageGet;
const storageSet = Shared.storageSet;
const storageRemove = Shared.storageRemove;
const withLock = Shared.withLock;

function sessionAreaCall(method, ...args) {
  return new Promise((resolve, reject) => {
    const area = chrome.storage?.session;
    if (!area || typeof area[method] !== "function") {
      reject(new Error("chrome.storage.session is unavailable"));
      return;
    }
    area[method](...args, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || String(error)));
      else resolve(value);
    });
  });
}

async function browserSessionId() {
  if (!browserSessionPromise) {
    browserSessionPromise = (async () => {
      try {
        const stored = await sessionAreaCall("get", [BROWSER_SESSION_KEY]);
        const existing = String(stored?.[BROWSER_SESSION_KEY] || "").trim();
        if (existing) return existing;
        const created = Shared.makeId("browser-session");
        await sessionAreaCall("set", { [BROWSER_SESSION_KEY]: created });
        return created;
      } catch (error) {
        console.warn(`[YOLO] Browser-session recovery disabled: ${Shared.errorMessage(error)}`);
        return "session-recovery-unavailable";
      }
    })();
  }
  return browserSessionPromise;
}

async function handleTabHeartbeat(message, sender) {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, reason: "心跳缺少来源标签页", code: "heartbeat.tab_missing" };
  }
  const pageId = Config.pageId(message?.pageId || sender?.tab?.url || "");
  if (!Config.isSupportedUrl(sender?.tab?.url || pageId)) {
    return { ok: false, reason: "心跳来自不受支持的页面", code: "heartbeat.page_invalid" };
  }
  const timestamp = Date.now();
  return withLock(heartbeatLock, async () => {
    const stored = await sessionAreaCall("get", [Config.TAB_HEARTBEAT_SESSION_KEY]);
    const current = stored?.[Config.TAB_HEARTBEAT_SESSION_KEY];
    const map = current && typeof current === "object" ? { ...current } : {};
    for (const [key, value] of Object.entries(map)) {
      if (timestamp - (Number(value?.at) || 0) > HEARTBEAT_RETENTION_MS) delete map[key];
    }
    map[String(tabId)] = {
      pageId,
      at: timestamp,
      visible: Boolean(message?.visible),
      workflowActive: Boolean(message?.workflowActive)
    };
    await sessionAreaCall("set", { [Config.TAB_HEARTBEAT_SESSION_KEY]: map });
    return { ok: true, at: timestamp };
  });
}

async function readQueueMap() {
  const stored = await storageGet([Config.STORAGE_KEYS.queues]);
  const value = stored[Config.STORAGE_KEYS.queues];
  return value && typeof value === "object" ? value : {};
}

async function readQueueState(pageId) {
  return withLock(queueLock, async () => {
    const map = await readQueueMap();
    const state = Queue.normalizeState(map[pageId]);
    return { ok: true, state, summary: Queue.summary(state) };
  });
}

function ensureQueueCapacity(map, pageId, current) {
  if (Object.prototype.hasOwnProperty.call(map, pageId) || Object.keys(map).length < MAX_CONVERSATION_QUEUES) return null;
  const emptyQueues = Object.entries(map)
    .filter(([, value]) => Queue.normalizeState(value).items.length === 0)
    .sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
  while (Object.keys(map).length >= MAX_CONVERSATION_QUEUES && emptyQueues.length) {
    delete map[emptyQueues.shift()[0]];
  }
  if (Object.keys(map).length < MAX_CONVERSATION_QUEUES) return null;
  return {
    ok: false,
    reason: `已达到 ${MAX_CONVERSATION_QUEUES} 个活动对话队列上限；请先清理旧队列`,
    code: "queue.conversation_limit",
    state: current,
    summary: Queue.summary(current)
  };
}

async function mutateQueue(pageId, mutator) {
  return withLock(queueLock, async () => {
    const map = await readQueueMap();
    const current = Queue.normalizeState(map[pageId]);
    const result = await mutator(current);
    const state = Queue.normalizeState(result?.state || current);
    const capacityError = ensureQueueCapacity(map, pageId, current);
    if (capacityError) return capacityError;

    delete map[pageId];
    map[pageId] = state;
    await storageSet({ [Config.STORAGE_KEYS.queues]: map });
    return { ...result, state, summary: Queue.summary(state) };
  });
}

function validPageId(pageId) {
  return typeof pageId === "string" && pageId.length <= 1000 && Config.isDurablePageId(pageId);
}

function senderMatchesPageId(sender, pageId) {
  if (!sender?.tab?.url) return true;
  if (!Config.isSupportedUrl(sender.tab.url)) return false;
  return Config.pageId(sender.tab.url) === pageId;
}

function senderTabId(sender) {
  const value = Number(sender?.tab?.id);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

async function readRolloverMap() {
  const stored = await storageGet([Config.STORAGE_KEYS.rollovers]);
  const raw = stored[Config.STORAGE_KEYS.rollovers];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Rollover.normalizeTransaction(value)]));
}

async function handleRolloverMessage(message, sender) {
  const tabId = senderTabId(sender);
  if (tabId < 0) return { ok: false, reason: "切换对话需要有效的浏览器标签页", code: "rollover.tab_invalid" };
  const tabKey = String(tabId);

  if (message.type === "YOLO_ROLLOVER_START") {
    const pageId = message.pageId;
    if (!validPageId(pageId)) return { ok: false, reason: "需要一个已保存的 ChatGPT 对话", code: "rollover.page_invalid" };
    if (!senderMatchesPageId(sender, pageId)) {
      return { ok: false, reason: "对话标识与发送消息的标签页不一致", code: "rollover.page_mismatch" };
    }

    return withLock(workflowLock, () => withLock(rolloverLock, () => withLock(queueLock, async () => {
      const rollovers = await readRolloverMap();
      const existing = rollovers[tabKey];
      if (existing && existing.phase !== "bound") {
        return {
          ok: false,
          reason: existing.phase === "blocked"
            ? "The previous rollover is blocked and must be cleared before starting another"
            : "A rollover is already active in this tab",
          code: existing.phase === "blocked" ? "rollover.blocked" : "rollover.active",
          transaction: existing
        };
      }
      const activeCount = Object.values(rollovers).filter((entry) => entry.phase !== "bound").length;
      if (!existing && activeCount >= MAX_ACTIVE_ROLLOVERS) {
        return { ok: false, reason: `已达到 ${MAX_ACTIVE_ROLLOVERS} 个活动切换事务上限`, code: "rollover.capacity" };
      }

      let sourceWorkflow = Commands.normalizeWorkflow(message.sourceWorkflow);
      let workflowToPersist = null;
      let workflowKey = "";
      if (message.consumeWorkflowResponse) {
        workflowKey = Config.workflowKey(pageId);
        const stored = await storageGet([workflowKey]);
        const currentWorkflow = Commands.normalizeWorkflow(stored[workflowKey]);
        const expectedRevision = Math.max(0, Math.round(Number(message.workflowExpectedRevision) || 0));
        if (expectedRevision !== currentWorkflow.revision) {
          return { ok: false, reason: "切换流程处理回答前，工作流状态已发生变化", code: "rollover.workflow_conflict", workflow: currentWorkflow };
        }
        const identityMatches = currentWorkflow.status === "running"
          && currentWorkflow.awaitingResponse
          && sourceWorkflow.status === "running"
          && !sourceWorkflow.awaitingResponse
          && sourceWorkflow.id === currentWorkflow.id
          && sourceWorkflow.taskId === currentWorkflow.taskId
          && sourceWorkflow.kind === currentWorkflow.kind
          && sourceWorkflow.objective === currentWorkflow.objective
          && sourceWorkflow.iteration === currentWorkflow.iteration + 1
          && sourceWorkflow.totalIterations === currentWorkflow.totalIterations + 1;
        if (!identityMatches) {
          return { ok: false, reason: "当前工作流回答状态不是可安全切换的下一边界", code: "rollover.workflow_state_invalid", workflow: currentWorkflow };
        }
        workflowToPersist = Commands.normalizeWorkflow({
          ...Commands.setWorkflowStatus(sourceWorkflow, "paused", "Paused for conversation rollover", Date.now()),
          revision: currentWorkflow.revision + 1
        });
        sourceWorkflow = workflowToPersist;
      }
      const sessionId = await browserSessionId();

      let transaction = Rollover.createTransaction({
        sourcePageId: pageId,
        sourceWorkflow,
        focus: message.focus,
        tabId,
        ownerId: message.ownerId,
        browserSessionId: sessionId,
        baselineAssistantFingerprint: message.baselineAssistantFingerprint
      });
      const queueMap = await readQueueMap();
      const queueCurrent = Queue.normalizeState(queueMap[pageId]);
      const queueResult = Queue.addItem(queueCurrent, {
        text: transaction.handoffPrompt,
        source: "rollover:handoff",
        sourceId: transaction.id
      }, { front: true });
      if (!queueResult.ok) return { ...queueResult, transaction };
      const capacityError = ensureQueueCapacity(queueMap, pageId, queueCurrent);
      if (capacityError) return { ...capacityError, transaction };

      transaction = Rollover.withRevision(transaction, {
        pendingItemId: queueResult.item.id,
        reason: "交接提示已加入队列"
      });
      delete queueMap[pageId];
      queueMap[pageId] = queueResult.state;
      delete rollovers[tabKey];
      rollovers[tabKey] = transaction;
      const setItems = {
        [Config.STORAGE_KEYS.queues]: queueMap,
        [Config.STORAGE_KEYS.rollovers]: rollovers
      };
      if (workflowToPersist) setItems[workflowKey] = workflowToPersist;
      await storageSet(setItems);
      return {
        ok: true,
        transaction,
        ...(workflowToPersist ? { workflow: workflowToPersist } : {}),
        item: queueResult.item,
        state: queueResult.state,
        summary: Queue.summary(queueResult.state)
      };
    })));
  }

  return withLock(rolloverLock, async () => {
    const rollovers = await readRolloverMap();
    let current = rollovers[tabKey] || null;
    if (message.type === "YOLO_ROLLOVER_GET") {
      const sessionId = await browserSessionId();
      if (current && current.browserSessionId === sessionId) return { ok: true, transaction: current };

      const requestedId = String(message.rolloverId || "").trim().slice(0, 180);
      const senderPageId = sender?.tab?.url && Config.isSupportedUrl(sender.tab.url)
        ? Config.pageId(sender.tab.url)
        : "";
      const staleEntries = Object.entries(rollovers).filter(([, transaction]) => transaction.browserSessionId !== sessionId);
      const candidates = requestedId
        ? staleEntries.filter(([, transaction]) => transaction.id === requestedId)
        : validPageId(senderPageId)
          ? staleEntries.filter(([, transaction]) => transaction.sourcePageId === senderPageId || transaction.targetPageId === senderPageId)
          : [];

      if (!candidates.length) return { ok: true, transaction: null };
      if (candidates.length !== 1) {
        return { ok: false, reason: "有多个过期切换事务与恢复后的标签页匹配", code: "rollover.rebind_ambiguous" };
      }

      const [oldKey, stale] = candidates[0];
      const rebound = Rollover.normalizeTransaction({
        ...stale,
        revision: stale.revision + 1,
        tabId,
        ownerId: String(message.ownerId || stale.ownerId || "").trim().slice(0, 220),
        browserSessionId: sessionId,
        reason: "浏览器重启后已恢复切换事务",
        updatedAt: Date.now()
      });
      delete rollovers[oldKey];
      rollovers[tabKey] = rebound;
      await storageSet({ [Config.STORAGE_KEYS.rollovers]: rollovers });
      current = rebound;
      return { ok: true, transaction: current, rebound: true };
    }
    if (!current) return { ok: false, reason: "当前标签页没有活动的切换事务", code: "rollover.not_found" };

    if (message.type === "YOLO_ROLLOVER_UPDATE") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "切换事务已在其他上下文中发生变化", code: "rollover.conflict", transaction: current };
      }
      const requested = Rollover.normalizeTransaction(message.transaction);
      if (requested.id !== current.id
        || requested.sourcePageId !== current.sourcePageId
        || requested.tabId !== tabId
        || requested.browserSessionId !== current.browserSessionId) {
        return { ok: false, reason: "不能更改切换事务标识", code: "rollover.identity_mismatch", transaction: current };
      }
      if (requested.targetPageId) {
        if (!validPageId(requested.targetPageId) || !senderMatchesPageId(sender, requested.targetPageId)) {
          return { ok: false, reason: "目标对话与发送消息的标签页不一致", code: "rollover.target_mismatch", transaction: current };
        }
      }
      const transaction = Rollover.normalizeTransaction({ ...requested, revision: current.revision + 1, updatedAt: Date.now() });
      rollovers[tabKey] = transaction;
      await storageSet({ [Config.STORAGE_KEYS.rollovers]: rollovers });
      return { ok: true, transaction };
    }

    if (message.type === "YOLO_ROLLOVER_CLEAR") {
      delete rollovers[tabKey];
      if (Object.keys(rollovers).length) await storageSet({ [Config.STORAGE_KEYS.rollovers]: rollovers });
      else await storageRemove([Config.STORAGE_KEYS.rollovers]);
      return { ok: true, transaction: null };
    }

    return { ok: false, reason: "未知的切换对话操作", code: "rollover.unknown" };
  });
}

async function mutateActionGuards(mutator) {
  return withLock(actionLock, async () => {
    const stored = await storageGet([Config.STORAGE_KEYS.actionGuards]);
    const current = Coordinator.normalizeState(stored[Config.STORAGE_KEYS.actionGuards]);
    const result = await mutator(current);
    const state = Coordinator.normalizeState(result?.state || current);
    await storageSet({ [Config.STORAGE_KEYS.actionGuards]: state });
    return { ...result, state };
  });
}

async function handleActionMessage(message, sender) {
  const pageId = message.pageId;
  if (!validPageId(pageId)) return { ok: false, reason: "需要一个已保存的 ChatGPT 对话", code: "action.page_invalid" };
  if (!senderMatchesPageId(sender, pageId)) {
    return { ok: false, reason: "对话标识与发送消息的标签页不一致", code: "action.page_mismatch" };
  }
  const actionKey = String(message.actionKey || "").trim().slice(0, 240);
  if (message.type !== "YOLO_ACTION_RESET" && !actionKey) {
    return { ok: false, reason: "操作标识不能为空", code: "action.guard_invalid" };
  }
  const guardKey = `${pageId}::${actionKey}`;
  if (message.type === "YOLO_ACTION_CLAIM") {
    return mutateActionGuards((state) => Coordinator.claim(state, guardKey, message.ownerId, {
      leaseMs: message.leaseMs,
      cooldownMs: message.cooldownMs
    }));
  }
  if (message.type === "YOLO_ACTION_BEGIN") {
    return mutateActionGuards((state) => Coordinator.begin(state, guardKey, message.token));
  }
  if (message.type === "YOLO_ACTION_COMPLETE") {
    return mutateActionGuards((state) => Coordinator.complete(state, guardKey, message.token));
  }
  if (message.type === "YOLO_ACTION_RELEASE") {
    return mutateActionGuards((state) => Coordinator.release(state, guardKey, message.token));
  }
  if (message.type === "YOLO_ACTION_RESET") {
    return mutateActionGuards((state) => actionKey
      ? Coordinator.reset(state, guardKey)
      : Coordinator.resetPrefix(state, `${pageId}::`));
  }
  return { ok: false, reason: "未知的操作保护命令", code: "action.unknown" };
}

function normalizeTemplate(raw, fallbackId = "") {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim().slice(0, 80);
  const text = String(raw.text || "").trim().slice(0, Queue.MAX_TEXT_LENGTH);
  if (!name || !text) return null;
  const requestedId = String(raw.id || fallbackId || "").trim().slice(0, 180);
  return {
    id: requestedId || Queue.makeId("template"),
    name,
    text,
    builtIn: Boolean(raw.builtIn),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

function templatesFromStorage(stored) {
  const raw = Array.isArray(stored?.[Config.STORAGE_KEYS.templates])
    ? stored[Config.STORAGE_KEYS.templates]
    : Config.DEFAULT_TEMPLATES;
  const templates = [];
  const ids = new Set();
  for (const entry of raw) {
    if (templates.length >= 50) break;
    const template = normalizeTemplate(entry);
    if (!template || ids.has(template.id)) continue;
    ids.add(template.id);
    templates.push(template);
  }
  return templates;
}

function templateMutationPlan(message, stored) {
  let templates = templatesFromStorage(stored);
  const now = Date.now();
  if (message.type === "YOLO_TEMPLATES_RESET") {
    templates = Config.DEFAULT_TEMPLATES.map((template) => normalizeTemplate({ ...template, createdAt: now, updatedAt: now }));
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates } };
  }
  if (message.type === "YOLO_TEMPLATE_ADD") {
    const requestedId = String(message.template?.id || "").trim().slice(0, 180);
    if (!requestedId) return { ok: false, reason: "模板标识不能为空", code: "template.id_required" };
    const existing = templates.find((template) => template.id === requestedId);
    if (existing) return { mutate: false, result: { templates, template: existing, deduplicated: true } };
    if (templates.length >= 50) return { ok: false, reason: "已达到模板数量上限", code: "template.limit" };
    const template = normalizeTemplate({ ...message.template, id: requestedId, createdAt: now, updatedAt: now });
    if (!template) return { ok: false, reason: "模板名称和内容不能为空" };
    templates.push(template);
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates, template } };
  }
  if (message.type === "YOLO_TEMPLATE_UPDATE") {
    const requestedId = String(message.template?.id || "").trim().slice(0, 180);
    const index = templates.findIndex((template) => template.id === requestedId);
    if (index < 0) return { ok: false, reason: "未找到模板" };
    const template = normalizeTemplate({ ...templates[index], ...message.template, id: requestedId, builtIn: false, updatedAt: now });
    if (!template) return { ok: false, reason: "模板名称和内容不能为空" };
    templates[index] = template;
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates, template } };
  }
  if (message.type === "YOLO_TEMPLATE_REMOVE") {
    const requestedId = String(message.templateId || "").trim().slice(0, 180);
    if (!templates.some((entry) => entry.id === requestedId)) return { ok: false, reason: "未找到模板" };
    templates = templates.filter((entry) => entry.id !== requestedId);
    return { setItems: { [Config.STORAGE_KEYS.templates]: templates }, result: { templates } };
  }
  if (message.type === "YOLO_TEMPLATES_REORDER") {
    const order = Array.isArray(message.orderedIds) ? message.orderedIds.map((id) => String(id).trim().slice(0, 180)) : [];
    const byId = new Map(templates.map((template) => [template.id, template]));
    const ordered = [];
    for (const id of order) {
      if (!byId.has(id)) continue;
      ordered.push(byId.get(id));
      byId.delete(id);
    }
    for (const template of templates) if (byId.has(template.id)) ordered.push(template);
    return { setItems: { [Config.STORAGE_KEYS.templates]: ordered }, result: { templates: ordered } };
  }
  return { ok: false, reason: "未知模板操作" };
}

async function handleTemplateMessage(message) {
  if (message.type === "YOLO_TEMPLATES_GET") {
    return PortableStore.read(({ stored, revision }) => ({ ok: true, templates: templatesFromStorage(stored), revision }));
  }
  return PortableStore.mutate(({ stored }) => templateMutationPlan(message, stored));
}

async function activeWorkflowLimitError(key, current, workflow) {
  const startsActiveWorkflow = ACTIVE_WORKFLOW_STATUSES.has(workflow.status) && !ACTIVE_WORKFLOW_STATUSES.has(current.status);
  if (!startsActiveWorkflow) return null;

  const allStored = await storageGet(null);
  const workflowEntries = Object.entries(allStored)
    .filter(([storedKey]) => storedKey.startsWith("yoloWorkflow:") && storedKey !== key)
    .map(([storedKey, value]) => [storedKey, Commands.normalizeWorkflow(value)]);
  const activeCount = workflowEntries.filter(([, entry]) => ACTIVE_WORKFLOW_STATUSES.has(entry.status)).length;
  if (activeCount >= MAX_ACTIVE_WORKFLOWS) {
    return {
      ok: false,
      reason: `已达到 ${MAX_ACTIVE_WORKFLOWS} 个活动工作流上限；请先暂停或清理旧工作流`,
      code: "workflow.conversation_limit",
      workflow: current
    };
  }

  const completed = workflowEntries
    .filter(([, entry]) => entry.status === "completed")
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const excess = completed.slice(0, Math.max(0, completed.length - MAX_RETAINED_COMPLETED_WORKFLOWS));
  if (excess.length) await storageRemove(excess.map(([storedKey]) => storedKey));
  return null;
}

async function enqueueWorkflowPrompt(pageId, key, current, message) {
  return withLock(queueLock, async () => {
    const map = await readQueueMap();
    const queueCurrent = Queue.normalizeState(map[pageId]);
    const queueResult = Queue.addItem(queueCurrent, message.item, { front: true });
    if (!queueResult.ok) return { ...queueResult, workflow: current, summary: Queue.summary(queueCurrent) };
    const capacityError = ensureQueueCapacity(map, pageId, queueCurrent);
    if (capacityError) return { ...capacityError, workflow: current };

    const timestamp = Date.now();
    const ownerId = String(message.ownerId || "").trim().slice(0, 220);
    const workflow = Commands.normalizeWorkflow({
      ...message.workflow,
      revision: current.revision + 1,
      pendingItemId: queueResult.item.id,
      awaitingResponse: false,
      sawGeneration: false,
      responseCandidateFingerprint: "",
      responseCandidateSince: 0,
      runnerId: ownerId,
      runnerExpiresAt: ownerId ? timestamp + WORKFLOW_LEASE_MS : 0,
      updatedAt: timestamp
    });
    const limitError = await activeWorkflowLimitError(key, current, workflow);
    if (limitError) return limitError;

    delete map[pageId];
    map[pageId] = queueResult.state;
    await storageSet({
      [Config.STORAGE_KEYS.queues]: map,
      [key]: workflow
    });
    return {
      ok: true,
      workflow,
      item: queueResult.item,
      state: queueResult.state,
      summary: Queue.summary(queueResult.state)
    };
  });
}

async function completeQueueClaim(pageId, message) {
  // Workflow enqueue already uses workflow -> queue lock order. Keep the same order here.
  return withLock(workflowLock, () => withLock(queueLock, async () => {
    const map = await readQueueMap();
    const queueCurrent = Queue.normalizeState(map[pageId]);
    const queueResult = Queue.completeClaim(queueCurrent, message.itemId, message.claimToken);
    if (!queueResult.ok) return { ...queueResult, state: queueCurrent, summary: Queue.summary(queueCurrent) };

    const queueState = Queue.normalizeState(queueResult.state);
    const setItems = { [Config.STORAGE_KEYS.queues]: { ...map, [pageId]: queueState } };
    let workflow = null;
    const completedItem = queueResult.item;
    if (completedItem?.source?.startsWith("workflow:") && completedItem.sourceId) {
      const key = Config.workflowKey(pageId);
      const stored = await storageGet([key]);
      const current = Commands.normalizeWorkflow(stored[key]);
      if (current.status === "running"
        && current.id === completedItem.sourceId
        && current.pendingItemId === completedItem.id) {
        workflow = Commands.normalizeWorkflow({
          ...current,
          revision: current.revision + 1,
          pendingItemId: "",
          awaitingResponse: true,
          sawGeneration: false,
          responseCandidateFingerprint: "",
          responseCandidateSince: 0,
          responseStartRefreshAt: 0,
          lastPromptAt: Date.now(),
          reason: "正在等待 ChatGPT",
          updatedAt: Date.now()
        });
        setItems[key] = workflow;
      }
    }

    await storageSet(setItems);
    return {
      ...queueResult,
      state: queueState,
      summary: Queue.summary(queueState),
      ...(workflow ? { workflow } : {})
    };
  }));
}

async function handleWorkflowMessage(message, sender) {
  const pageId = message.pageId;
  if (!validPageId(pageId)) return { ok: false, reason: "无效的对话标识", code: "workflow.page_invalid" };
  if (!senderMatchesPageId(sender, pageId)) {
    return { ok: false, reason: "对话标识与发送消息的标签页不一致", code: "workflow.page_mismatch" };
  }

  return withLock(workflowLock, async () => {
    const key = Config.workflowKey(pageId);
    const stored = await storageGet([key]);
    const current = Commands.normalizeWorkflow(stored[key]);

    if (message.type === "YOLO_WORKFLOW_GET") return { ok: true, workflow: current };

    if (message.type === "YOLO_WORKFLOW_SET") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "工作流已在另一个标签页发生变化", code: "workflow.conflict", workflow: current };
      }
      const workflow = Commands.normalizeWorkflow({ ...message.workflow, revision: current.revision + 1 });
      const limitError = await activeWorkflowLimitError(key, current, workflow);
      if (limitError) return limitError;
      await storageSet({ [key]: workflow });
      return { ok: true, workflow };
    }

    if (message.type === "YOLO_WORKFLOW_QUEUE_ADD") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "工作流已在另一个标签页发生变化", code: "workflow.conflict", workflow: current };
      }
      return enqueueWorkflowPrompt(pageId, key, current, message);
    }

    if (message.type === "YOLO_WORKFLOW_CLEAR") {
      const expectedRevision = Math.max(0, Math.round(Number(message.expectedRevision) || 0));
      if (expectedRevision !== current.revision) {
        return { ok: false, reason: "工作流已在另一个标签页发生变化", code: "workflow.conflict", workflow: current };
      }
      await storageRemove([key]);
      return { ok: true, workflow: Commands.freshWorkflow() };
    }

    if (message.type === "YOLO_WORKFLOW_CLAIM") {
      if (current.status !== "running") return { ok: false, reason: "工作流当前未运行", code: "workflow.not_running", workflow: current };
      const ownerId = String(message.ownerId || "").trim().slice(0, 220);
      if (!ownerId) return { ok: false, reason: "工作流执行者标识不能为空", code: "workflow.owner_invalid", workflow: current };
      const timestamp = Date.now();
      if (current.runnerId && current.runnerId !== ownerId && current.runnerExpiresAt > timestamp) {
        return { ok: false, reason: "工作流正在另一个标签页运行", code: "workflow.busy", workflow: current };
      }
      if (current.runnerId === ownerId && current.runnerExpiresAt > timestamp + WORKFLOW_RENEW_WINDOW_MS) {
        return { ok: true, workflow: current, renewed: false };
      }
      const workflow = Commands.normalizeWorkflow({
        ...current,
        revision: current.revision + 1,
        runnerId: ownerId,
        runnerExpiresAt: timestamp + WORKFLOW_LEASE_MS,
        updatedAt: timestamp
      });
      await storageSet({ [key]: workflow });
      return { ok: true, workflow, renewed: true };
    }

    if (message.type === "YOLO_WORKFLOW_RELEASE") {
      const ownerId = String(message.ownerId || "").trim().slice(0, 220);
      if (current.runnerId !== ownerId) return { ok: true, workflow: current, released: false };
      const workflow = Commands.normalizeWorkflow({
        ...current,
        revision: current.revision + 1,
        runnerId: "",
        runnerExpiresAt: 0,
        updatedAt: Date.now()
      });
      await storageSet({ [key]: workflow });
      return { ok: true, workflow, released: true };
    }

    return { ok: false, reason: "未知工作流操作" };
  });
}

async function handleQueueMessage(message, sender) {
  const pageId = message.pageId;
  if (!validPageId(pageId)) return { ok: false, reason: "无效的对话标识", code: "queue.page_invalid" };
  if (!senderMatchesPageId(sender, pageId)) {
    return { ok: false, reason: "对话标识与发送消息的标签页不一致", code: "queue.page_mismatch" };
  }

  if (message.type === "YOLO_QUEUE_GET") {
    return readQueueState(pageId);
  }
  if (message.type === "YOLO_QUEUE_ADD") {
    return mutateQueue(pageId, async (state) => Queue.addItem(state, message.item, {
      front: Boolean(message.front),
      requireUnpaused: Boolean(message.requireUnpaused),
      dedupeWindowMs: message.dedupeWindowMs
    }));
  }
  if (message.type === "YOLO_QUEUE_UPDATE") {
    return mutateQueue(pageId, async (state) => Queue.updateItem(state, message.itemId, message.text));
  }
  if (message.type === "YOLO_QUEUE_REMOVE") {
    return mutateQueue(pageId, async (state) => Queue.removeItem(state, message.itemId));
  }
  if (message.type === "YOLO_QUEUE_REORDER") {
    return mutateQueue(pageId, async (state) => Queue.reorderItems(state, message.orderedIds));
  }
  if (message.type === "YOLO_QUEUE_PAUSE") {
    return mutateQueue(pageId, async (state) => Queue.setPaused(state, message.paused));
  }
  if (message.type === "YOLO_QUEUE_CLEAR") {
    return mutateQueue(pageId, async (state) => Queue.clearItems(state));
  }
  if (message.type === "YOLO_QUEUE_RETRY") {
    return mutateQueue(pageId, async (state) => Queue.retryItem(state, message.itemId));
  }
  if (message.type === "YOLO_QUEUE_CLAIM") {
    return mutateQueue(pageId, async (state) => Queue.claimNext(state, message.ownerId));
  }
  if (message.type === "YOLO_QUEUE_MARK_SUBMITTING") {
    return mutateQueue(pageId, async (state) => Queue.markSubmitting(state, message.itemId, message.claimToken));
  }
  if (message.type === "YOLO_QUEUE_RELEASE") {
    return mutateQueue(pageId, async (state) => Queue.releaseClaim(state, message.itemId, message.claimToken, { reason: message.reason }));
  }
  if (message.type === "YOLO_QUEUE_COMPLETE") {
    return completeQueueClaim(pageId, message);
  }
  if (message.type === "YOLO_QUEUE_FAIL") {
    return mutateQueue(pageId, async (state) => Queue.failClaim(state, message.itemId, message.claimToken, {
      error: message.error,
      errorCode: message.errorCode,
      maxRetries: message.maxRetries,
      backoffSec: message.backoffSec,
      pauseOnFailure: message.pauseOnFailure,
      deliveryAmbiguous: message.deliveryAmbiguous
    }));
  }
  if (message.type === "YOLO_EVENT_APPEND") {
    return mutateQueue(pageId, async (state) => ({ ok: true, state: Queue.appendEvent(state, message.event) }));
  }
  return { ok: false, reason: "未知队列操作" };
}

chrome.runtime.onInstalled.addListener((details) => {
  PortableStore.mutate(({ stored }) => Array.isArray(stored[Config.STORAGE_KEYS.templates])
    ? { mutate: false, result: { initialized: false } }
    : {
        setItems: {
          [Config.STORAGE_KEYS.templates]: Config.DEFAULT_TEMPLATES.map((template) => normalizeTemplate(template))
        },
        result: { initialized: true }
      }).catch(() => {});
  if (details?.reason === "install") {
    chrome.tabs?.create?.({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("YOLO_")) return false;
  const task = message.type === "YOLO_TAB_HEARTBEAT"
    ? handleTabHeartbeat(message, sender)
    : message.type.startsWith("YOLO_ACTION_")
    ? handleActionMessage(message, sender)
    : message.type.startsWith("YOLO_ROLLOVER_")
      ? handleRolloverMessage(message, sender)
    : message.type.includes("TEMPLATE")
      ? handleTemplateMessage(message)
      : message.type.includes("WORKFLOW")
        ? handleWorkflowMessage(message, sender)
        : handleQueueMessage(message, sender);
  Promise.resolve(task)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error) }));
  return true;
});
