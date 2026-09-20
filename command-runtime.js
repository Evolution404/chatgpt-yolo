(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  const Platforms = globalThis.YOLOPlatforms;
  const Commands = globalThis.YOLOCommands;
  const Rollover = globalThis.YOLORollover;
  const CommandUI = globalThis.YOLOCommandUI;
  if (!Config || !Shared || !Lifecycle || !Platforms || !Commands || !Rollover || !CommandUI) return;

  if (window.__YOLO_COMMAND_RUNTIME__?.version === Config.VERSION) return;
  window.__YOLO_COMMAND_RUNTIME__?.destroy?.();

  const POLL_MS = Lifecycle.VISIBLE_WORKFLOW_POLL_MS;
  const RESPONSE_SETTLE_MS = 1200;
  const state = {
    destroyed: false,
    pageId: "",
    workflow: Commands.freshWorkflow(),
    rollover: null,
    rolloverLoaded: false,
    ui: null,
    pollTimer: null,
    routeInFlight: false,
    tickInFlight: false,
    lastQueueAttemptAt: 0,
    unregisterEngineClient: null,
    lifecycleHandlers: [],
    mutationLock: Shared.createLock(),
    ownerId: Shared.makeId("command")
  };

  const now = () => Date.now();
  const engine = () => window.__YOLO_EXTENSION__?.commandApi || null;

  const withWorkflowLock = (task) => Shared.withLock(state.mutationLock, task);

  const backgroundSend = (message) => Shared.sendMessage(message, {
    soft: true,
    isDestroyed: () => state.destroyed
  });

  function applyRolloverResponse(response) {
    if (response?.ok) state.rollover = response.transaction ? Rollover.normalizeTransaction(response.transaction) : null;
    return response;
  }

  function rolloverIdFromLocation() {
    try {
      return String(new URL(location.href).searchParams.get("yolo-rollover") || "").trim().slice(0, 180);
    } catch {
      return "";
    }
  }

  function rolloverNewChatUrl(transaction) {
    const url = new URL(`${location.origin}/`);
    url.searchParams.set("yolo-rollover", transaction.id);
    return url.toString();
  }

  function clearRolloverTokenFromLocation() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has("yolo-rollover")) return;
      url.searchParams.delete("yolo-rollover");
      history.replaceState(history.state, "", url.toString());
    } catch {
      // URL cleanup is best-effort and never affects persisted rollover state.
    }
  }

  async function readRollover() {
    const response = applyRolloverResponse(await backgroundSend({
      type: "YOLO_ROLLOVER_GET",
      ownerId: state.ownerId,
      pageId: Config.pageId(location.href),
      rolloverId: rolloverIdFromLocation()
    }));
    state.rolloverLoaded = true;
    return response?.ok ? state.rollover : null;
  }

  async function ensureRolloverLoaded() {
    if (!state.rolloverLoaded) await readRollover();
    return state.rollover;
  }

  async function writeRollover(transaction) {
    const current = state.rollover;
    if (!current || !transaction || current.id !== transaction.id) return false;
    const response = applyRolloverResponse(await backgroundSend({
      type: "YOLO_ROLLOVER_UPDATE",
      expectedRevision: current.revision,
      transaction: Rollover.normalizeTransaction({ ...transaction, revision: current.revision, updatedAt: now() })
    }));
    return Boolean(response?.ok);
  }

  async function blockRollover(reason, code = "rollover.blocked") {
    const current = state.rollover;
    if (!current) return false;
    const next = Rollover.normalizeTransaction({ ...current, phase: "blocked", reason, updatedAt: now() });
    const saved = await writeRollover(next);
    if (saved) await record(`切换对话已阻塞：${reason}`, "warning", code);
    return saved;
  }


  function adapter() {
    return Platforms.adapterForLocation();
  }

  function composer() {
    return Platforms.findComposer(adapter());
  }

  function composerText() {
    return Platforms.composerText(composer());
  }

  function setComposerText(value) {
    const target = composer();
    if (!target) return false;
    Platforms.setComposerValue(target, value);
    return true;
  }

  function latestAssistantFingerprint() {
    return Commands.fingerprint(Platforms.latestAssistantText(adapter()));
  }

  function latestUserFingerprint() {
    return Commands.fingerprint(Platforms.latestUserText(adapter()));
  }

  async function record(message, level = "info", code = "command.status", log = true) {
    const api = engine();
    if (api?.recordStatus) await api.recordStatus(message, level, code, log);
  }

  function applyWorkflowResponse(response, targetPageId = state.pageId) {
    if (response?.workflow && state.pageId === targetPageId) {
      state.workflow = Commands.normalizeWorkflow(response.workflow);
      syncUI();
    }
  }

  async function readWorkflow(pageId = state.pageId) {
    const response = await backgroundSend({ type: "YOLO_WORKFLOW_GET", pageId });
    return response?.ok ? Commands.normalizeWorkflow(response.workflow) : Commands.freshWorkflow();
  }

  async function refreshWorkflow(pageId = state.pageId) {
    const workflow = await readWorkflow(pageId);
    if (state.pageId === pageId) {
      state.workflow = workflow;
      syncUI();
    }
    return workflow;
  }

  async function writeWorkflow(workflow = state.workflow, pageId = state.pageId) {
    const normalized = Commands.normalizeWorkflow(workflow);
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_SET",
      pageId,
      expectedRevision: normalized.revision,
      workflow: normalized
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function clearWorkflow(pageId = state.pageId) {
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_CLEAR",
      pageId,
      expectedRevision: state.workflow.revision
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function claimWorkflow() {
    const pageId = state.pageId;
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_CLAIM",
      pageId,
      ownerId: state.ownerId
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function releaseWorkflow() {
    if (!state.pageId || state.workflow.runnerId !== state.ownerId) return false;
    const pageId = state.pageId;
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_RELEASE",
      pageId,
      ownerId: state.ownerId
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok);
  }

  async function queueState(pageId = state.pageId) {
    return backgroundSend({ type: "YOLO_QUEUE_GET", pageId });
  }

  async function removeQueueItem(itemId, pageId = state.pageId) {
    if (!itemId) return true;
    const response = await backgroundSend({ type: "YOLO_QUEUE_REMOVE", pageId, itemId });
    return Boolean(response?.ok || response?.code === "queue.not_found");
  }

  async function queuePrompt(text, { workflow = null, source = "command" } = {}) {
    const prompt = String(text || "").trim();
    const pageId = state.pageId;
    if (!prompt) return { ok: false, reason: "命令生成了空提示词" };

    let response;
    if (workflow) {
      const next = Commands.normalizeWorkflow(workflow);
      next.awaitingResponse = false;
      next.sawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.recoveryRefreshCount = 0;
      next.recoveryRefreshAt = 0;
      next.baselineFingerprint = latestAssistantFingerprint();
      next.lastAssistantFingerprint = next.baselineFingerprint;
      next.promptFingerprint = Commands.fingerprint(prompt);
      next.lastPromptAt = now();
      next.reason = "工作流提示已加入队列";
      next.updatedAt = now();
      response = await backgroundSend({
        type: "YOLO_WORKFLOW_QUEUE_ADD",
        pageId,
        expectedRevision: next.revision,
        ownerId: state.ownerId,
        workflow: next,
        item: {
          text: prompt,
          source,
          sourceId: next.id
        }
      });
      applyWorkflowResponse(response, pageId);
    } else {
      response = await backgroundSend({
        type: "YOLO_QUEUE_ADD",
        pageId,
        front: true,
        item: { text: prompt, source, sourceId: "" }
      });
    }
    if (!response?.ok) return response || { ok: false, reason: "无法将命令提示词加入队列" };

    const api = engine();
    const sent = api ? await api.runAction("queue-next") : false;
    if (workflow && sent && state.pageId === pageId) await refreshWorkflow(pageId);
    return { ...response, sent };
  }

  async function cancelPendingWorkflowPrompt(workflow = state.workflow) {
    if (!workflow.pendingItemId) return { ok: true, removed: false };
    const response = await backgroundSend({
      type: "YOLO_QUEUE_REMOVE",
      pageId: state.pageId,
      itemId: workflow.pendingItemId
    });
    if (response?.ok || response?.code === "queue.not_found") return { ok: true, removed: true };
    if (response?.code === "queue.sending") {
      return { ok: true, removed: false, reason: "当前工作流提示词已在发送，无法撤回" };
    }
    return { ok: false, removed: false, reason: response?.reason || "Could not remove the pending workflow prompt" };
  }

  async function startWorkflow(kind, args) {
    await syncRoute();
    const latest = await readWorkflow(state.pageId);
    state.workflow = latest;
    syncUI();

    if (latest.status !== "idle") {
      if (latest.status === "running" && (latest.pendingItemId || latest.awaitingResponse || engine()?.getState?.().generating)) {
        return { ok: false, reason: "请等待当前回合结束后暂停或停止现有工作流，再进行替换", keepOpen: true };
      }
      if (!window.confirm(`确定替换当前 /${latest.kind} 工作流吗？`)) {
        return { ok: false, reason: "已保留现有工作流", keepOpen: true };
      }
      const cancelled = await cancelPendingWorkflowPrompt(latest);
      if (!cancelled.ok) return { ok: false, reason: cancelled.reason, keepOpen: true };
    }

    const settings = engine()?.getState?.().settings || Config.DEFAULT_SETTINGS;
    const current = Commands.startWorkflow(kind, args, {
      at: now(),
      baselineFingerprint: latestAssistantFingerprint(),
      rolloverPolicy: {
        enabled: settings.autoRolloverEnabled,
        afterTurns: settings.autoRolloverAfterTurns,
        maxConversations: settings.autoRolloverMaxConversations
      }
    });
    if (!current.ok) return { ...current, keepOpen: true };
    current.workflow.revision = latest.revision;
    current.workflow.runnerId = state.ownerId;
    state.workflow = current.workflow;
    const prompt = Commands.workflowPrompt(state.workflow, "initial");
    const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${kind}` });
    if (!queued.ok) {
      await markWorkflow("blocked", queued.reason || "Could not queue workflow prompt", `command.${kind}.blocked`);
      return { ...queued, keepOpen: true };
    }
    await record(`已启动 /${kind}：${state.workflow.objective}`, "success", `command.${kind}.started`);
    return { ok: true };
  }

  async function runOneShot(name, args) {
    if (state.workflow.status === "running") {
      return { ok: false, reason: "请先暂停当前 /goal 或 /loop，再运行其他提示命令", keepOpen: true };
    }
    const prompt = Commands.oneShotPrompt(name, args);
    if (!prompt) return { ok: false, reason: `/${name} 需要补充更多内容`, keepOpen: true };
    const queued = await queuePrompt(prompt, { source: `command:${name}` });
    if (!queued.ok) {
      await record(`/${name} 执行失败：${queued.reason || "队列不可用"}`, "error", `command.${name}.failed`);
      return { ...queued, keepOpen: true };
    }
    await record(queued.sent ? `Ran /${name}` : `Queued /${name}`, "success", `command.${name}`);
    return { ok: true };
  }

  async function setStatus(status, reason) {
    if (state.workflow.status === "idle") return { ok: false, reason: "当前没有运行中的 /goal 或 /loop", keepOpen: true };
    if (status === "paused") {
      const cancelled = await cancelPendingWorkflowPrompt(state.workflow);
      if (!cancelled.ok || (state.workflow.pendingItemId && !cancelled.removed)) {
        return { ok: false, reason: cancelled.reason || "The workflow prompt is already sending", keepOpen: true };
      }
      if (cancelled.reason) reason = `${reason}. ${cancelled.reason}`;
    }
    const next = Commands.setWorkflowStatus(state.workflow, status, reason, now());
    const ok = await writeWorkflow(next);
    if (ok) {
      const statusLabel = { running: "运行中", paused: "已暂停", completed: "已完成", blocked: "已阻塞" }[status] || status;
      await record(`/${state.workflow.kind} ${statusLabel}`, status === "blocked" ? "warning" : "info", `command.workflow.${status}`);
    }
    return { ok, reason: ok ? "" : "Workflow changed in another tab", keepOpen: !ok };
  }

  async function resumeWorkflow() {
    if (!["paused", "blocked"].includes(state.workflow.status)) return { ok: false, reason: "当前工作流未处于暂停状态", keepOpen: true };
    const next = Commands.normalizeWorkflow(state.workflow);
    next.status = "running";
    next.reason = "用户手动继续";
    next.updatedAt = now();
    const prompt = Commands.workflowPrompt(next, next.iteration === 0 ? "initial" : "continue");
    return queuePrompt(prompt, { workflow: next, source: `workflow:${next.kind}` });
  }

  function rolloverPhaseLabel(phase) {
    return {
      handoff_queued: "交接提示已入队",
      awaiting_handoff: "等待交接回答",
      bootstrap_pending: "等待启动新对话",
      bootstrap_submitting: "正在提交新对话启动提示",
      bootstrap_sent: "启动提示已发送",
      bound: "已绑定新对话",
      blocked: "已阻塞"
    }[phase] || String(phase || "无").replaceAll("_", " ");
  }

  function formatCountdown(ms) {
    const remaining = Math.max(0, Number(ms) || 0);
    if (remaining <= 0) return "已到期";
    const totalSeconds = Math.ceil(remaining / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0
      ? pad(hours) + ":" + pad(minutes) + ":" + pad(seconds)
      : pad(totalMinutes) + ":" + pad(seconds);
  }

  function workflowPhaseLabel(workflow, apiState, pageError = null) {
    if (workflow.status === "blocked") return "已阻塞" + (workflow.reason ? " · " + workflow.reason : "");
    if (workflow.status === "paused") return "已暂停" + (workflow.reason ? " · " + workflow.reason : "");
    if (workflow.status === "completed") return "已完成";
    if (workflow.status !== "running") return "空闲";
    if (workflow.pendingItemId) return "工作流提示词等待发送";
    if (!workflow.awaitingResponse) return "准备下一步";
    if (workflow.recoveryRefreshCount > 0) {
      const maxRefreshes = Number(apiState.settings?.workflowRefreshRetries) || 3;
      return `正在刷新恢复 ${workflow.recoveryRefreshCount}/${maxRefreshes}`;
    }
    if (pageError) {
      const errorText = Platforms.normalizedText(pageError).slice(0, 100);
      return "检测到 ChatGPT 错误 · " + errorText;
    }
    if (apiState.generating) return "等待 ChatGPT 最终回答";
    if (workflow.responseCandidateFingerprint) {
      const outcome = Commands.evaluateResponse(Platforms.latestAssistantText(adapter()));
      if (outcome === "missing") return "回答不完整，准备刷新页面";
      return "正在等待回答稳定";
    }
    return "等待 ChatGPT 最终回答";
  }

  function buildLiveStatus() {
    const apiState = engine()?.getState?.() || {};
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const pageError = Platforms.findErrorState(adapter());
    const timestamp = now();
    const timers = Lifecycle.liveCountdowns({
      settings: apiState.settings || {},
      workflow,
      now: timestamp
    });

    if (!pageError && workflow.responseCandidateFingerprint && !apiState.generating) {
      const assistantText = Platforms.latestAssistantText(adapter());
      const outcome = Commands.evaluateResponse(assistantText);
      const quietSince = Math.max(
        workflow.responseCandidateSince || 0,
        apiState.lastDomActivityAt || 0,
        apiState.lastGenerationAt || 0
      );
      const dueAt = quietSince + (outcome === "missing" ? Lifecycle.MISSING_MARKER_REFRESH_MS : Lifecycle.responseStableMs(outcome));
      if (!(outcome === "missing" && workflow.recoveryRefreshCount > 0)) timers.unshift({
        id: "response-stable",
        label: outcome === "missing" ? "回答恢复" : "回答稳定",
        phase: outcome === "missing" ? "回答不完整" : "检测控制标记",
        detail: outcome === "missing" ? "稳定后刷新页面读取完整回答" : "稳定后处理本回合回答",
        dueAt,
        remainingMs: Math.max(0, dueAt - timestamp)
      });
    }

    const criticalIds = new Set(["workflow-timeout", "workflow-recovery", "response-stable"]);
    const futureTimers = timers.filter((timer) => timer.remainingMs > 0);
    const nextTimer = [...futureTimers]
      .filter((timer) => criticalIds.has(timer.id))
      .sort((a, b) => a.dueAt - b.dueAt)[0]
      || [...futureTimers].sort((a, b) => a.dueAt - b.dueAt)[0]
      || null;
    const workflowStatus = {
      idle: "空闲",
      running: "运行中",
      paused: "已暂停",
      completed: "已完成",
      blocked: "已阻塞"
    }[workflow.status] || workflow.status;
    const automationEnabled = Boolean(apiState.settings?.enabled);
    const workflowRunning = workflow.status === "running";
    const refreshMax = Number(apiState.settings?.workflowRefreshRetries) || 3;
    const effectiveRolloverEnabled = workflow.status === "idle"
      ? Boolean(apiState.settings?.autoRolloverEnabled)
      : workflow.autoRolloverEnabled;
    const rolloverTurns = workflow.status === "idle"
      ? (Number(apiState.settings?.autoRolloverAfterTurns) || 6)
      : (Number(workflow.autoRolloverAfterTurns) || 6);

    return {
      headline: workflowRunning
        ? "工作流运行中"
        : (automationEnabled ? "常规自动化运行中" : "常规自动化已暂停"),
      nextAction: nextTimer ? nextTimer.label + " " + formatCountdown(nextTimer.remainingMs) : "当前无倒计时动作",
      rows: [
        ["工作流", workflow.status === "idle" ? "无" : "/" + workflow.kind + " · " + workflowStatus],
        ["当前阶段", workflowPhaseLabel(workflow, apiState, pageError)],
        ["回合", workflow.status === "idle" ? "—" : workflow.iteration + "/" + workflow.maxIterations + " · 总计 " + workflow.totalIterations],
        ["当前会话", workflow.status === "idle" ? "—" : `第 ${workflow.conversationIndex} 个 · ${workflow.iteration}/${rolloverTurns} 回合`],
        ["刷新恢复", workflow.status === "idle" ? "—" : `${workflow.recoveryRefreshCount}/${refreshMax}`],
        ["自动切换", effectiveRolloverEnabled ? `${rolloverTurns} 回合后切换` : "关闭"],
        ["最近操作", apiState.lastAction?.message || "空闲"]
      ],
      timers: timers.map((timer) => ({
        ...timer,
        countdown: formatCountdown(timer.remainingMs)
      }))
    };
  }

  async function showStatus() {
    state.ui?.showStatus(buildLiveStatus());
    return { ok: true, focusComposer: false };
  }

  async function startRollover(args = "") {
    await syncRoute();
    await ensureRolloverLoaded();
    if (!Config.isDurablePageId(state.pageId)) return { ok: false, reason: "请先打开一个已保存的 ChatGPT 对话，再执行切换对话", keepOpen: true };
    if (state.rollover && state.rollover.phase !== "bound") {
      return { ok: false, reason: `切换对话已在进行中：${rolloverPhaseLabel(state.rollover.phase)}`, keepOpen: true };
    }
    const api = engine();
    const apiState = api?.getState?.() || {};
    if (apiState.generating) return { ok: false, reason: "请等待当前 ChatGPT 回答完成后再切换对话", keepOpen: true };

    const latest = await readWorkflow(state.pageId);
    state.workflow = latest;
    syncUI();
    if (latest.status === "running") {
      return { ok: false, reason: "手动切换对话前请先暂停当前 /goal 或 /loop，避免工作流回合与交接发生竞争", keepOpen: true };
    }

    const response = applyRolloverResponse(await backgroundSend({
      type: "YOLO_ROLLOVER_START",
      pageId: state.pageId,
      focus: args,
      ownerId: state.ownerId,
      baselineAssistantFingerprint: latestAssistantFingerprint(),
      sourceWorkflow: latest
    }));
    if (!response?.ok) return { ...response, keepOpen: true };
    const sent = await api?.runAction?.("queue-next");
    await record(sent ? "已开始生成切换对话交接信息" : "切换对话交接提示已加入队列", "success", "command.rollover.started");
    return { ok: true };
  }

  async function startAutomaticRollover(workflow, reason) {
    const current = Commands.normalizeWorkflow(workflow);
    if (!current.autoRolloverEnabled) return false;
    if (current.conversationIndex >= current.autoRolloverMaxConversations) {
      state.workflow = current;
      await markWorkflow(
        "paused",
        `Reached the ${current.autoRolloverMaxConversations}-conversation rollover safety limit`,
        "command.workflow.rollover_cap"
      );
      return true;
    }

    await ensureRolloverLoaded();
    if (state.rollover && !["bound"].includes(state.rollover.phase)) {
      state.workflow = current;
      await markWorkflow("blocked", `已有切换对话事务正在进行：${rolloverPhaseLabel(state.rollover.phase)}`, "command.workflow.rollover_conflict");
      return true;
    }

    const response = applyRolloverResponse(await backgroundSend({
      type: "YOLO_ROLLOVER_START",
      pageId: state.pageId,
      consumeWorkflowResponse: true,
      workflowExpectedRevision: current.revision,
      sourceWorkflow: current,
      focus: reason,
      ownerId: state.ownerId,
      baselineAssistantFingerprint: current.lastAssistantFingerprint || latestAssistantFingerprint()
    }));
    if (!response?.ok) {
      state.workflow = await readWorkflow(state.pageId);
      syncUI();
      await record(`自动切换对话未启动：${response?.reason || "状态已变化"}`, "warning", response?.code || "command.workflow.rollover_start_failed");
      return true;
    }

    if (response.workflow) state.workflow = Commands.normalizeWorkflow(response.workflow);
    syncUI();
    const sent = await engine()?.runAction?.("queue-next");
    await record(
      sent ? `已从第 ${current.conversationIndex} 个对话启动自动交接` : `第 ${current.conversationIndex} 个对话的自动交接已加入队列`,
      "success",
      "command.workflow.rollover_started"
    );
    return true;
  }

  async function handleRolloverHandoffQueue(transaction, apiState) {
    const queue = await queueState(transaction.sourcePageId);
    if (!queue?.ok) return false;
    const item = queue.state.items.find((entry) => entry.id === transaction.pendingItemId);
    if (item?.state === "failed") {
      await removeQueueItem(item.id, transaction.sourcePageId);
      await blockRollover(item.error || "切换对话交接提示发送失败", "rollover.handoff_delivery_failed");
      return true;
    }
    if (item) {
      if (!apiState.generating && now() - state.lastQueueAttemptAt >= POLL_MS) {
        state.lastQueueAttemptAt = now();
        await engine()?.runAction?.("queue-next");
      }
      return false;
    }
    const completedExactly = queue.state.completions.some((completion) =>
      completion.itemId === transaction.pendingItemId && completion.sourceId === transaction.id);
    if (!completedExactly) {
      await blockRollover("切换对话交接提示在确认送达前消失", "rollover.handoff_prompt_removed");
      return true;
    }
    const next = Rollover.normalizeTransaction({
      ...transaction,
      phase: "awaiting_handoff",
      pendingItemId: "",
      reason: "等待严格格式的交接回答",
      updatedAt: now()
    });
    return writeRollover(next);
  }

  async function handleRolloverHandoffResponse(transaction, apiState) {
    if (apiState.generating || now() - transaction.lastPromptAt < RESPONSE_SETTLE_MS) return false;
    const assistantText = Platforms.latestAssistantText(adapter());
    const candidateFingerprint = Commands.fingerprint(assistantText);
    if (!assistantText || candidateFingerprint === transaction.baselineAssistantFingerprint) return false;
    if (transaction.responseCandidateFingerprint !== candidateFingerprint) {
      const next = Rollover.normalizeTransaction({
        ...transaction,
        responseCandidateFingerprint: candidateFingerprint,
        responseCandidateSince: now(),
        reason: "等待切换对话交接回答稳定",
        updatedAt: now()
      });
      await writeRollover(next);
      return false;
    }
    const quietSince = Math.max(transaction.responseCandidateSince, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
    if (now() - quietSince < Lifecycle.MARKER_RESPONSE_STABLE_MS) return false;
    const accepted = Rollover.acceptHandoff(transaction, assistantText, {
      userFingerprint: latestUserFingerprint(),
      at: now()
    });
    if (!accepted.ok) {
      await blockRollover(accepted.reason || "切换对话交接内容无效", accepted.code || "rollover.handoff_invalid");
      return true;
    }
    if (!await writeRollover(accepted.transaction)) return false;
    await record("已获取切换对话交接信息，正在打开新对话", "success", "rollover.handoff_captured");
    location.assign(rolloverNewChatUrl(state.rollover));
    return true;
  }

  async function adoptRolloverWorkflow(transaction) {
    if (!Config.isDurablePageId(state.pageId) || state.pageId !== transaction.targetPageId) return false;
    const source = transaction.sourceWorkflow;
    if (!source || source.status === "completed") {
      const bound = await writeRollover(Rollover.normalizeTransaction({ ...transaction, phase: "bound", reason: "已绑定后续对话", updatedAt: now() }));
      if (bound) clearRolloverTokenFromLocation();
      return bound;
    }

    const current = await readWorkflow(state.pageId);
    if (current.status !== "idle") {
      const alreadyAdopted = current.kind === source.kind
        && current.objective === source.objective
        && current.promptFingerprint === transaction.bootstrapPromptFingerprint;
      if (alreadyAdopted) {
        state.workflow = current;
        syncUI();
        const bound = await writeRollover(Rollover.normalizeTransaction({ ...transaction, phase: "bound", reason: "后续工作流已接管", updatedAt: now() }));
        if (bound) clearRolloverTokenFromLocation();
        return bound;
      }
      await blockRollover("后续对话中已存在不同的 YOLO 工作流", "rollover.target_workflow_conflict");
      return true;
    }

    const args = source.kind === "loop" ? `${source.maxIterations} ${source.objective}` : source.objective;
    const started = Commands.startWorkflow(source.kind, args, {
      at: now(),
      baselineFingerprint: latestAssistantFingerprint(),
      rolloverPolicy: {
        enabled: source.autoRolloverEnabled,
        afterTurns: source.autoRolloverAfterTurns,
        maxConversations: source.autoRolloverMaxConversations
      }
    });
    if (!started.ok) {
      await blockRollover(started.reason || "无法在后续对话中恢复工作流", "rollover.workflow_restore_failed");
      return true;
    }
    const workflow = Commands.normalizeWorkflow({
      ...started.workflow,
      iteration: 0,
      taskId: source.taskId,
      conversationIndex: source.conversationIndex + 1,
      totalIterations: source.totalIterations,
      autoRolloverEnabled: source.autoRolloverEnabled,
      autoRolloverAfterTurns: source.autoRolloverAfterTurns,
      autoRolloverMaxConversations: source.autoRolloverMaxConversations,
      pendingItemId: "",
      awaitingResponse: true,
      sawGeneration: Boolean(engine()?.getState?.().generating),
      promptFingerprint: transaction.bootstrapPromptFingerprint,
      lastPromptAt: transaction.bootstrapSubmittedAt || now(),
      runnerId: "",
      runnerExpiresAt: 0,
      reason: "切换对话后已继续",
      updatedAt: now()
    });
    state.workflow = workflow;
    const saved = await writeWorkflow(workflow, state.pageId);
    if (!saved) {
      await blockRollover("无法在后续对话中保存恢复后的工作流", "rollover.workflow_restore_conflict");
      return true;
    }
    const bound = await writeRollover(Rollover.normalizeTransaction({ ...state.rollover, phase: "bound", reason: "后续对话与工作流已绑定", updatedAt: now() }));
    if (bound) clearRolloverTokenFromLocation();
    return bound;
  }

  async function handleRolloverBootstrap(transaction) {
    const api = engine();
    const currentPageId = Config.pageId(location.href);
    if (transaction.phase === "bootstrap_submitting") {
      if (Config.isStableConversationPageId(currentPageId) && latestUserFingerprint() === transaction.bootstrapPromptFingerprint) {
        const recovered = Rollover.normalizeTransaction({
          ...transaction,
          phase: "bootstrap_sent",
          targetPageId: currentPageId,
          bootstrapSubmittedAt: transaction.bootstrapSubmittedAt || now(),
          reason: "路由切换后已恢复并确认启动提示",
          updatedAt: now()
        });
        if (await writeRollover(recovered)) {
          await syncRoute();
          return adoptRolloverWorkflow(state.rollover);
        }
        return false;
      }
      await blockRollover("临时路由上的启动提示提交结果不确定；已禁止自动重试", "rollover.bootstrap_unknown");
      return true;
    }
    if (transaction.phase === "bootstrap_sent") {
      await syncRoute();
      if (state.pageId !== transaction.targetPageId) {
        await blockRollover("工作流接管前，标签页已离开确认后的后续对话", "rollover.target_route_lost");
        return true;
      }
      return adoptRolloverWorkflow(state.rollover || transaction);
    }
    if (transaction.phase !== "bootstrap_pending") return false;
    if (Config.isDurablePageId(currentPageId)) {
      await blockRollover("新对话启动前，标签页已跳转到另一个已保存对话", "rollover.route_conflict");
      return true;
    }
    if (!api || !await api.ensureReady()) return false;

    const submitting = Rollover.normalizeTransaction({
      ...transaction,
      phase: "bootstrap_submitting",
      bootstrapSubmittedAt: now(),
      reason: "已保存启动提示提交意图",
      updatedAt: now()
    });
    if (!await writeRollover(submitting)) return false;
    const result = await api.submitTransientBootstrap(state.rollover.bootstrapPrompt);
    if (!result?.ok) {
      await blockRollover(result?.reason || "启动提示提交失败", result?.code || "rollover.bootstrap_failed");
      return true;
    }
    await syncRoute();
    const sent = Rollover.normalizeTransaction({
      ...state.rollover,
      phase: "bootstrap_sent",
      targetPageId: result.targetPageId,
      reason: "已在后续对话中确认完全匹配的启动消息",
      updatedAt: now()
    });
    if (!await writeRollover(sent)) return false;
    return adoptRolloverWorkflow(state.rollover);
  }

  async function handleRollover() {
    const transaction = await ensureRolloverLoaded();
    if (!transaction || ["bound", "blocked"].includes(transaction.phase)) return false;
    const currentPageId = Config.pageId(location.href);
    if (currentPageId === transaction.sourcePageId) {
      const apiState = engine()?.getState?.() || {};
      if (transaction.phase === "handoff_queued") return handleRolloverHandoffQueue(transaction, apiState);
      if (transaction.phase === "awaiting_handoff") return handleRolloverHandoffResponse(transaction, apiState);
      if (transaction.phase === "bootstrap_pending") {
        location.assign(rolloverNewChatUrl(transaction));
        return true;
      }
      if (["bootstrap_submitting", "bootstrap_sent"].includes(transaction.phase)) {
        await blockRollover("启动提示提交后标签页又返回源对话；自动恢复不安全，已停止", "rollover.source_route_returned");
        return true;
      }
      return false;
    }
    return handleRolloverBootstrap(transaction);
  }

  async function executeCommandUnlocked(name, args = "") {
    await syncRoute();
    const api = engine();
    if (!api || !await api.ensureReady()) return { ok: false, reason: "当前对话中的 YOLO 尚未就绪", keepOpen: true };
    await ensureRolloverLoaded();
    if (name === "rollover") return startRollover(args);
    if (["goal", "loop"].includes(name)) return startWorkflow(name, args);
    if (["plan", "review", "fix", "handoff", "continue"].includes(name)) return runOneShot(name, args);
    if (name === "status") return showStatus();
    if (name === "pause") return setStatus("paused", "用户手动暂停");
    if (name === "resume") return resumeWorkflow();
    if (name === "stop") {
      if (state.workflow.status === "idle") return { ok: false, reason: "当前没有运行中的 /goal 或 /loop", keepOpen: true };
      if (!window.confirm(`确定停止并清除当前 /${state.workflow.kind} 工作流吗？`)) return { ok: false, reason: "已保留工作流", keepOpen: true };
      const cancelled = await cancelPendingWorkflowPrompt(state.workflow);
      if (!cancelled.ok || (state.workflow.pendingItemId && !cancelled.removed)) {
        return { ok: false, reason: cancelled.reason || "工作流提示词已在发送", keepOpen: true };
      }
      const ok = await clearWorkflow();
      if (ok) await record(cancelled.reason || "已停止并清除命令工作流", "info", "command.workflow.stopped");
      return { ok, reason: ok ? "" : "工作流已在其他标签页发生变化", keepOpen: !ok };
    }
    if (name === "settings") {
      chrome.runtime.openOptionsPage?.();
      return { ok: true, focusComposer: false };
    }
    if (name === "help") {
      state.ui?.open();
      return { ok: true, keepOpen: true, focusComposer: false };
    }
    return { ok: false, reason: "未知命令", keepOpen: true };
  }

  function executeCommand(name, args = "") {
    return withWorkflowLock(() => executeCommandUnlocked(name, args));
  }

  function syncUI() {
    const status = buildLiveStatus();
    state.ui?.update({ workflow: state.workflow, status, nextAction: status.nextAction });
  }

  async function syncRoute() {
    const nextPageId = Config.pageId(location.href);
    if (!Config.isSupportedUrl(location.href) || nextPageId === state.pageId || state.routeInFlight) return;
    state.routeInFlight = true;
    try {
      state.pageId = nextPageId;
      state.workflow = await readWorkflow(nextPageId);
      syncUI();
    } finally {
      state.routeInFlight = false;
    }
  }

  async function markWorkflow(status, reason, code) {
    const next = Commands.setWorkflowStatus(state.workflow, status, reason, now());
    const saved = await writeWorkflow(next);
    if (saved) {
      const label = { running: "运行中", paused: "已暂停", completed: "已完成", blocked: "已阻塞" }[status] || status;
      await record(`/${state.workflow.kind} ${label}：${reason}`, status === "completed" ? "success" : "warning", code);
    }
    return saved;
  }

  async function processResponse() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const text = Platforms.latestAssistantText(adapter());
    const fingerprint = Commands.fingerprint(text);
    if (!text || fingerprint === workflow.baselineFingerprint || fingerprint === workflow.lastAssistantFingerprint) return false;

    const decision = Commands.decideWorkflowResponse(workflow, text, {
      userFingerprint: latestUserFingerprint(),
      at: now()
    });
    state.workflow = decision.workflow;
    if (decision.action === "ignore") return false;
    if (decision.action === "rollover") {
      return startAutomaticRollover(state.workflow, decision.reason);
    }
    if (decision.action !== "continue") {
      await markWorkflow(decision.action, decision.reason, decision.code);
      return true;
    }

    const rolloverBoundary = Rollover.autoRolloverBoundary(state.workflow);
    if (rolloverBoundary.action === "cap") {
      await markWorkflow("paused", rolloverBoundary.reason, "command.workflow.rollover_cap");
      return true;
    }
    if (rolloverBoundary.action === "rollover") {
      return startAutomaticRollover(state.workflow, rolloverBoundary.reason);
    }

    const prompt = Commands.workflowPrompt(state.workflow, "continue");
    const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
    if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not queue the next workflow iteration", "command.workflow.queue_failed");
    return true;
  }

  async function handlePendingWorkflowItem(apiState) {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const queue = await queueState();
    if (!queue?.ok) return false;
    const item = queue.state.items.find((entry) => entry.id === workflow.pendingItemId);
    if (item?.state === "failed") {
      const removed = await removeQueueItem(item.id);
      const reason = removed
        ? (item.error || "Workflow prompt failed")
        : `${item.error || "Workflow prompt failed"}. The failed queue item could not be removed.`;
      await markWorkflow("blocked", reason, "command.workflow.delivery_failed");
      return true;
    }
    if (item) {
      if (!apiState.generating && now() - state.lastQueueAttemptAt >= POLL_MS) {
        state.lastQueueAttemptAt = now();
        const sent = await engine()?.runAction?.("queue-next");
        if (sent) await refreshWorkflow();
      }
      return false;
    }

    const refreshed = await refreshWorkflow();
    if (refreshed.awaitingResponse || !refreshed.pendingItemId) return false;

    const completedExactly = queue.state.completions.some((completion) =>
      completion.itemId === workflow.pendingItemId && completion.sourceId === workflow.id);
    if (completedExactly) {
      const next = Commands.normalizeWorkflow(refreshed);
      next.pendingItemId = "";
      next.awaitingResponse = true;
      next.sawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.reason = "正在等待 ChatGPT";
      next.updatedAt = now();
      await writeWorkflow(next);
      return false;
    }

    await markWorkflow("blocked", "Workflow prompt was removed before confirmed delivery", "command.workflow.prompt_removed");
    return true;
  }

  async function refreshWorkflowResponse(workflow, api, reason) {
    const apiState = api?.getState?.() || {};
    const maxRefreshes = Math.max(1, Number(apiState.settings?.workflowRefreshRetries) || 3);
    if (workflow.recoveryRefreshCount >= maxRefreshes) return false;

    const next = Commands.normalizeWorkflow(workflow);
    const refreshAt = now();
    next.recoveryRefreshCount += 1;
    next.recoveryRefreshAt = refreshAt;
    next.reason = `正在刷新当前会话（${next.recoveryRefreshCount}/${maxRefreshes}）：${reason}`;
    next.updatedAt = refreshAt;
    if (!await writeWorkflow(next)) return false;
    await releaseWorkflow();

    const refreshed = await api.runAction("workflow-recovery-refresh");
    if (refreshed) return true;

    const latest = await readWorkflow(state.pageId);
    if (latest.status === "running"
      && latest.awaitingResponse
      && latest.recoveryRefreshAt === refreshAt) {
      latest.recoveryRefreshCount = Math.max(0, latest.recoveryRefreshCount - 1);
      latest.recoveryRefreshAt = 0;
      latest.reason = "等待安全的页面刷新条件";
      latest.updatedAt = now();
      await writeWorkflow(latest);
    }
    return false;
  }

  async function handleWorkflow() {
    if (Commands.normalizeWorkflow(state.workflow).status !== "running") return false;
    if (!await claimWorkflow()) return false;
    const workflow = Commands.normalizeWorkflow(state.workflow);
    if (workflow.runnerId !== state.ownerId) return false;
    const api = engine();
    if (!api || !await api.ensureReady()) return false;
    const apiState = api.getState();
    if (!apiState.hydrated) return false;

    if (workflow.pendingItemId) return handlePendingWorkflowItem(apiState);
    if (!workflow.awaitingResponse) return false;

    const pageError = Platforms.findErrorState(adapter());
    if (apiState.generating && !workflow.sawGeneration) {
      workflow.sawGeneration = true;
      workflow.reason = "等待 ChatGPT 最终回答";
      workflow.updatedAt = now();
      await writeWorkflow(workflow);
    }

    const assistantText = pageError ? "" : Platforms.latestAssistantText(adapter());
    const candidateFingerprint = Commands.fingerprint(assistantText);
    const noNewAssistant = !assistantText
      || candidateFingerprint === workflow.baselineFingerprint
      || candidateFingerprint === workflow.lastAssistantFingerprint;

    if (!apiState.generating && !noNewAssistant && workflow.responseCandidateFingerprint !== candidateFingerprint) {
      workflow.responseCandidateFingerprint = candidateFingerprint;
      workflow.responseCandidateSince = now();
      workflow.reason = "正在等待 ChatGPT 回答稳定";
      workflow.updatedAt = now();
      await writeWorkflow(workflow);
      return false;
    }

    if (!apiState.generating && !noNewAssistant && workflow.responseCandidateFingerprint === candidateFingerprint) {
      const outcome = Commands.evaluateResponse(assistantText);
      const quietSince = Math.max(
        workflow.responseCandidateSince || 0,
        apiState.lastDomActivityAt || 0,
        apiState.lastGenerationAt || 0
      );
      if (outcome !== "missing") {
        if (now() - quietSince < Lifecycle.MARKER_RESPONSE_STABLE_MS) return false;
        return processResponse();
      }
      if (workflow.recoveryRefreshCount === 0
        && now() - quietSince >= Lifecycle.MISSING_MARKER_REFRESH_MS) {
        return refreshWorkflowResponse(workflow, api, "回答不完整");
      }
    }

    const recovery = Lifecycle.workflowRecoveryDecision({
      settings: apiState.settings || {},
      workflow,
      now: now()
    });
    if (recovery.action === "refresh") {
      return refreshWorkflowResponse(workflow, api, recovery.reason);
    }
    if (recovery.action === "recover") {
      const recovered = await queueWorkflowRecovery(`${recovery.maxRefreshes} 次刷新后仍未取得完整回答`);
      return Boolean(recovered?.ok && (recovered.handled || recovered.alreadyRecovered));
    }
    return false;
  }

  async function tick() {
    if (state.destroyed || state.tickInFlight) return;
    state.tickInFlight = true;
    try {
      await withWorkflowLock(async () => {
        await syncRoute();
        await handleRollover();
        await handleWorkflow();
      });
      syncUI();
      if (!document.hidden) state.ui?.reposition?.();
    } finally {
      state.tickInFlight = false;
    }
  }

  function editWorkflow(workflow) {
    setComposerText(`/${workflow.kind} ${workflow.kind === "loop" ? `${workflow.maxIterations} ` : ""}${workflow.objective}`);
    composer()?.focus?.();
  }

  function mountUI() {
    state.ui = CommandUI.mount({
      execute: executeCommand,
      pause: () => executeCommand("pause"),
      resume: () => executeCommand("resume"),
      stop: () => executeCommand("stop"),
      edit: editWorkflow,
      getComposer: composer,
      getComposerText: composerText,
      setComposerText
    });
    syncUI();
  }

  function getHealth() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    return {
      status: workflow.status,
      active: workflow.status === "running",
      awaitingResponse: workflow.awaitingResponse,
      pendingItemId: workflow.pendingItemId,
      iteration: workflow.iteration,
      lastPromptAt: workflow.lastPromptAt
    };
  }

  async function queueWorkflowRecovery(reason) {
    await syncRoute();
    let workflow = await readWorkflow(state.pageId);
    state.workflow = workflow;
    syncUI();

    if (workflow.status !== "running") {
      return { ok: false, handled: false, reason: `工作流当前状态为 ${workflow.status}`, code: "workflow.not_running" };
    }
    if (workflow.pendingItemId || !workflow.awaitingResponse) {
      return { ok: true, handled: false, alreadyRecovered: true, reason: "工作流已离开待恢复状态" };
    }
    if (engine()?.getState?.().generating) Platforms.stopGeneration(adapter());
    if (!await claimWorkflow()) {
      return { ok: false, handled: false, reason: "无法取得工作流执行权", code: "workflow.claim_failed" };
    }
    workflow = Commands.normalizeWorkflow(state.workflow);
    const prompt = Commands.workflowRecoveryPrompt(workflow);
    if (!prompt) return { ok: false, handled: false, reason: "无法生成恢复提示词", code: "workflow.recovery_prompt_empty" };
    const queued = await queuePrompt(prompt, {
      workflow,
      source: `workflow:${workflow.kind}:response-recovery`
    });
    if (!queued.ok) return { ...queued, handled: false };
    await record(`已发送工作流恢复消息（${reason}）`, "warning", "command.workflow.response_recovered");
    return { ok: true, handled: true, sent: Boolean(queued.sent) };
  }

  function schedulePoll(immediate = false) {
    window.clearTimeout(state.pollTimer);
    if (state.destroyed) return;
    const apiState = engine()?.getState?.() || {};
    const delay = immediate ? 0 : Lifecycle.workflowPollDelay({
      hidden: document.hidden,
      workflowActive: getHealth().active,
      generating: Boolean(apiState.generating)
    });
    state.pollTimer = window.setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        await record(`工作流轮询失败：${Shared.errorMessage(error)}`, "error", "command.workflow.poll_failed").catch((recordError) => {
          console.error(`Workflow poll status record failed: ${Shared.errorMessage(recordError)}`);
        });
      } finally {
        schedulePoll();
      }
    }, delay);
  }

  function addLifecycleHandler(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    state.lifecycleHandlers.push({ target, eventName, handler });
  }

  function wakeRuntime() {
    if (!state.destroyed) schedulePoll(true);
  }

  function destroy() {
    if (state.destroyed) return;
    releaseWorkflow().catch(() => {});
    state.destroyed = true;
    window.clearTimeout(state.pollTimer);
    state.unregisterEngineClient?.();
    state.ui?.destroy?.();
    for (const { target, eventName, handler } of state.lifecycleHandlers) target.removeEventListener(eventName, handler);
    state.lifecycleHandlers = [];
  }

  window.__YOLO_COMMAND_RUNTIME__ = { version: Config.VERSION, destroy, getHealth };
  mountUI();
  const api = engine();
  state.unregisterEngineClient = api?.registerClient?.(destroy) || null;
  addLifecycleHandler(document, "visibilitychange", wakeRuntime);
  addLifecycleHandler(window, "pageshow", wakeRuntime);
  addLifecycleHandler(document, "resume", wakeRuntime);
  syncRoute().then(() => schedulePoll(true));
})();
