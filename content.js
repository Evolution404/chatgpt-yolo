(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  const Commands = globalThis.YOLOCommands;
  const Platforms = globalThis.YOLOPlatforms;
  const ContentState = globalThis.YOLOContentState;
  if (!Config || !Shared || !Lifecycle || !Commands || !Platforms || !ContentState) return;

  if (window.__YOLO_EXTENSION__?.version === Config.VERSION) return;
  window.__YOLO_EXTENSION__?.destroy?.();

  const COUNTER_BY_ACTION = Object.freeze({
    approval: "approvalsClicked",
    recovery: "continuesSent",
    nudge: "deepNudgesSent",
    refresh: "refreshesTriggered",
    queue: "queuedMessagesSent",
    watchdog: "generationRecoveries"
  });

  const LIMIT_FIELD_BY_ACTION = Object.freeze({
    approval: "approvalLimitPerHour",
    recovery: "errorLimitPerHour",
    nudge: "deepNudgeLimitPerHour",
    refresh: "refreshLimitPerHour",
    queue: "queueLimitPerHour",
    watchdog: "generationWatchdogLimitPerHour"
  });

  const FAILED_RECOVERY_RETRY_MS = 15 * 1000;

  const state = ContentState.state;
  const randomMs = ContentState.randomMs;

  const now = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const currentPageId = () => Config.pageId(location.href);
  const routeIsCurrent = () => currentPageId() === state.pageId;
  const workflowHealth = () => window.__YOLO_COMMAND_RUNTIME__?.getHealth?.() || {
    status: "idle",
    active: false,
    awaitingResponse: false,
    pendingItemId: ""
  };
  const isContextInvalidated = (error) => /context invalidated|extension context/i.test(Shared.errorMessage(error));

  function disableStaleContext(error) {
    if (!isContextInvalidated(error)) return false;
    destroy();
    return true;
  }

  const storageGet = (keys) => Shared.storageGet(keys, {
    soft: true,
    isDestroyed: () => state.destroyed,
    onContextInvalidated: disableStaleContext
  });

  const storageSet = (items) => Shared.storageSet(items, {
    soft: true,
    isDestroyed: () => state.destroyed,
    onContextInvalidated: disableStaleContext
  });

  const backgroundSend = (message) => Shared.sendMessage(message, {
    soft: true,
    isDestroyed: () => state.destroyed,
    onContextInvalidated: disableStaleContext
  });

  async function backgroundSendWithRetry(message, attempts = 3) {
    for (let index = 0; index < attempts; index += 1) {
      const response = await backgroundSend(message);
      if (response) return response;
      if (index < attempts - 1) await sleep(150 * (index + 1));
    }
    return null;
  }

  async function claimActionGuard(actionKey, cooldownMs = 0, leaseMs = 20 * 1000) {
    return backgroundSendWithRetry({
      type: "YOLO_ACTION_CLAIM",
      pageId: state.pageId,
      actionKey,
      ownerId: state.ownerId,
      cooldownMs,
      leaseMs
    });
  }

  async function beginActionGuard(actionKey, token) {
    return backgroundSendWithRetry({ type: "YOLO_ACTION_BEGIN", pageId: state.pageId, actionKey, token });
  }

  async function completeActionGuard(actionKey, token) {
    return backgroundSendWithRetry({ type: "YOLO_ACTION_COMPLETE", pageId: state.pageId, actionKey, token });
  }

  async function releaseActionGuard(actionKey, token) {
    return backgroundSendWithRetry({ type: "YOLO_ACTION_RELEASE", pageId: state.pageId, actionKey, token });
  }

  async function appendEvent(code, message, level = "info") {
    if (!state.pageId || state.destroyed) return;
    await backgroundSend({
      type: "YOLO_EVENT_APPEND",
      pageId: state.pageId,
      event: { code, message, level, at: now() }
    });
  }

  async function setLastAction(message, level = "info", code = "status", logEvent = false) {
    state.lastAction = { message, at: now(), level, code };
    const value = { ...state.lastAction, url: location.href, pageId: state.pageId };
    await storageSet({
      [Config.lastActionKey(state.pageId)]: value,
      [Config.STORAGE_KEYS.lastAction]: value
    });
    if (logEvent) await appendEvent(code, message, level);
  }

  async function setBlocked(code, message, { log = false } = {}) {
    const changed = state.blockedCode !== code || state.blockedReason !== message;
    state.blockedCode = code;
    state.blockedReason = message;
    if (log && changed) await appendEvent(code, message, "warning");
  }

  function clearBlocked(prefix = "") {
    if (!prefix || state.blockedCode.startsWith(prefix)) {
      state.blockedCode = "";
      state.blockedReason = "";
    }
  }

  async function incrementCounter(key) {
    if (!key) return;
    const stored = await storageGet([Config.STORAGE_KEYS.counters]);
    const counters = { ...(stored[Config.STORAGE_KEYS.counters] || {}) };
    counters[key] = (Number(counters[key]) || 0) + 1;
    counters.updatedAt = now();
    state.counters = { ...state.counters, ...counters };
    await storageSet({ [Config.STORAGE_KEYS.counters]: counters });
  }

  async function loadSettings() {
    const pageKey = Config.pageSettingsKey(state.pageId);
    const actionKey = Config.lastActionKey(state.pageId);
    const stored = await storageGet([
      Config.STORAGE_KEYS.global,
      Config.STORAGE_KEYS.pages,
      Config.STORAGE_KEYS.counters,
      Config.STORAGE_KEYS.lastAction,
      pageKey,
      actionKey
    ]);

    const globalSettings = stored[Config.STORAGE_KEYS.global] || {};
    const legacyPageSettings = stored[Config.STORAGE_KEYS.pages]?.[state.pageId] || {};
    const pageSettings = stored[pageKey] || legacyPageSettings;
    state.settings = Config.mergeSettings(Config.DEFAULT_SETTINGS, globalSettings, pageSettings);
    state.counters = { ...state.counters, ...(stored[Config.STORAGE_KEYS.counters] || {}) };

    const storedLastAction = stored[actionKey] || stored[Config.STORAGE_KEYS.lastAction];
    if (storedLastAction?.pageId === state.pageId && storedLastAction?.message) state.lastAction = storedLastAction;
    else state.lastAction = { message: "Idle", at: now(), level: "info", code: "idle" };

    state.runtime = ContentState.loadRuntime();
    ContentState.scheduleNextRefresh();
    ContentState.scheduleNextQueue();
    state.loaded = true;
  }

  async function ensureCurrentRoute() {
    if (!routeIsCurrent()) await handleRouteChange();
    for (let attempt = 0; attempt < 40 && state.routeInFlight; attempt += 1) await sleep(25);
    return routeIsCurrent() && !state.routeInFlight && state.loaded;
  }

  async function persistSettings(nextSettings) {
    if (!await ensureCurrentRoute()) throw new Error("对话页面仍在跳转中");
    const normalized = Config.mergeSettings(state.settings, nextSettings);
    const response = await backgroundSendWithRetry({
      type: "YOLODATA_SETTINGS_SET",
      pageId: state.pageId,
      settings: normalized
    });
    if (!response?.ok) throw new Error(response?.reason || "Could not persist conversation settings");

    state.settings = Config.normalizeSettings(response.settings || normalized);
    ContentState.scheduleNextRefresh(true);
    ContentState.scheduleNextQueue(true);
    restartScanTimer();
    return state.settings;
  }

  function actionLimit(action) {
    return Number(state.settings[LIMIT_FIELD_BY_ACTION[action]]) || 0;
  }

  function checkActionLimit(action) {
    const status = Config.limitStatus(
      state.runtime?.history?.[action],
      actionLimit(action),
      state.runtime?.sessionActionCount || 0,
      state.settings.maxActionsPerSession,
      now()
    );
    if (state.runtime) state.runtime.history[action] = status.recent;
    if (!status.allowed) {
      state.blockedCode = status.code;
      state.blockedReason = status.reason;
    }
    return status;
  }

  async function recordAction(action, counterKey = COUNTER_BY_ACTION[action], { incrementSession = true } = {}) {
    const timestamp = now();
    state.runtime.history[action] = Config.pruneHistory([...(state.runtime.history[action] || []), timestamp], timestamp);
    if (incrementSession) state.runtime.sessionActionCount += 1;
    state.runtime.lastActionAt = timestamp;
    clearBlocked();
    ContentState.saveRuntime();
    await incrementCounter(counterKey);
  }

  function composerHasText(composer = Platforms.findComposer(state.platform)) {
    return Boolean(Platforms.composerText(composer).trim());
  }

  function probeHydration() {
    const composerPresent = Boolean(Platforms.findComposer(state.platform));
    if (document.readyState === "loading" || !composerPresent) {
      state.hydrated = false;
      state.hydratedAt = 0;
      state.hydrationCandidateSince = 0;
      return false;
    }
    if (state.hydrated) return true;
    const candidate = Lifecycle.hydrationCandidate({
      documentReadyState: document.readyState,
      composerPresent,
      lastDomActivityAt: state.lastDomActivityAt,
      now: now()
    });
    if (!candidate) {
      state.hydrationCandidateSince = 0;
      return false;
    }
    if (!state.hydrationCandidateSince) state.hydrationCandidateSince = now();
    if (now() - state.hydrationCandidateSince < Lifecycle.HYDRATION_QUIET_MS) return false;
    state.hydrated = true;
    state.hydratedAt = now();
    return true;
  }

  function automationReady({ allowDisabled = false } = {}) {
    if (!state.loaded || state.destroyed || !state.platform || !routeIsCurrent()) return false;
    if (!allowDisabled && !state.settings.enabled) return false;
    if (!Config.isDurablePageId(state.pageId) || !probeHydration()) return false;
    return now() - Math.max(state.pageLoadedAt, state.hydratedAt) >= state.settings.loadGraceSec * 1000;
  }

  function hydrationRetryAfterMs(timestamp = now()) {
    if (state.hydrated || document.readyState === "loading") return 0;
    const anchor = state.hydrationCandidateSince || state.lastDomActivityAt;
    return Math.max(0, anchor + Lifecycle.HYDRATION_QUIET_MS - timestamp);
  }

  function checkSafeForInput(workflow = workflowHealth()) {
    const timestamp = now();
    const routeCurrent = routeIsCurrent();
    const durablePage = Config.isDurablePageId(state.pageId);
    const composer = routeCurrent && durablePage ? Platforms.findComposer(state.platform) : null;
    const hydrated = Boolean(composer) && probeHydration();
    return Lifecycle.inputSafety({
      routeCurrent,
      durablePage,
      composerPresent: Boolean(composer),
      hydrated,
      hydrationRetryAfterMs: hydrationRetryAfterMs(timestamp),
      workflowAwaitingResponse: Boolean(workflow.awaitingResponse),
      generating: state.generationActive || Platforms.isGenerating(state.platform),
      generationHoldUntil: state.generationHoldUntil,
      lastDomActivityAt: state.lastDomActivityAt,
      composerBusy: Boolean(composer && Platforms.composerText(composer).trim()),
      now: timestamp
    });
  }

  function safeForInput() {
    const workflow = workflowHealth();
    if (workflow.awaitingResponse) return false;
    return checkSafeForInput(workflow).safe;
  }

  function scheduleInputRetry(safety, automatic) {
    const retryAfterMs = Math.max(0, Number(safety?.retryAfterMs) || 0);
    if (retryAfterMs <= 0) return;
    if (!automatic) state.pendingManualQueueRetry = true;
    queueCycle(retryAfterMs + 25);
  }

  function updateGenerationState() {
    const active = Platforms.isGenerating(state.platform);
    const timestamp = now();
    const wasGenerating = state.generationActive;
    const transitioned = wasGenerating !== active;
    state.generationHoldUntil = Lifecycle.nextGenerationHoldUntil({
      wasGenerating,
      generating: active,
      currentHoldUntil: state.generationHoldUntil,
      now: timestamp
    });
    if (state.runtime) {
      const watchdog = state.runtime.generationWatchdog || (state.runtime.generationWatchdog = {
        startedAt: 0,
        lastProgressAt: 0,
        lastAssistantFingerprint: "",
        softWarnedAt: 0,
        stopRequestedAt: 0,
        stoppedAt: 0,
        refreshRequestedAt: 0
      });
      const assistantFingerprint = Commands.fingerprint(Platforms.latestResponseActivityText(state.platform));
      if (active && !wasGenerating) {
        watchdog.startedAt = timestamp;
        watchdog.lastProgressAt = timestamp;
        watchdog.lastAssistantFingerprint = assistantFingerprint;
        watchdog.softWarnedAt = 0;
        watchdog.stopRequestedAt = 0;
        watchdog.stoppedAt = 0;
        watchdog.refreshRequestedAt = 0;
      } else if (active) {
        if (assistantFingerprint && assistantFingerprint !== watchdog.lastAssistantFingerprint) {
          watchdog.lastAssistantFingerprint = assistantFingerprint;
          watchdog.lastProgressAt = timestamp;
          watchdog.softWarnedAt = 0;
        }
        if (!watchdog.startedAt) watchdog.startedAt = timestamp;
        if (!watchdog.lastProgressAt) watchdog.lastProgressAt = timestamp;
      } else if (wasGenerating && watchdog.stopRequestedAt) {
        watchdog.stoppedAt = timestamp;
      } else if (!watchdog.stopRequestedAt) {
        watchdog.startedAt = 0;
        watchdog.lastProgressAt = 0;
        watchdog.lastAssistantFingerprint = "";
        watchdog.softWarnedAt = 0;
        watchdog.stoppedAt = 0;
        watchdog.refreshRequestedAt = 0;
      } else if (!active && watchdog.stopRequestedAt && !watchdog.stoppedAt) {
        watchdog.stoppedAt = timestamp;
      }
      if (active || (wasGenerating && !active)) state.runtime.lastGenerationAt = timestamp;
      if (transitioned || (active && timestamp - state.lastGenerationPersistAt >= 30_000)) {
        state.lastGenerationPersistAt = timestamp;
        ContentState.saveRuntime();
      }
    }
    state.generationActive = active;
    return active;
  }

  function inputActionCooldownPassed(action) {
    const lastAt = state.runtime?.history?.[action]?.at(-1) || 0;
    const cooldownSec = action === "recovery" ? state.settings.errorCooldownSec : state.settings.deepNudgeCooldownSec;
    return now() - lastAt >= cooldownSec * 1000;
  }

  function resetGenerationWatchdog() {
    if (!state.runtime?.generationWatchdog) return;
    state.runtime.generationWatchdog = {
      startedAt: 0,
      lastProgressAt: 0,
      lastAssistantFingerprint: "",
      softWarnedAt: 0,
      stopRequestedAt: 0,
      stoppedAt: 0,
      refreshRequestedAt: 0
    };
    ContentState.saveRuntime();
  }

  async function writeAndSubmit(prompt, actionPageId) {
    let submissionAttempted = false;
    try {
      let composer = Platforms.findComposer(state.platform);
      if (!composer) {
        return { ok: false, code: "composer.missing", reason: "未找到消息输入框", deliveryAmbiguous: false };
      }
      if (Platforms.composerText(composer).trim()) {
        return { ok: false, code: "composer.busy", reason: "消息输入框中已有草稿", deliveryAmbiguous: false };
      }

      const previousSnapshot = Platforms.userMessageSnapshot(state.platform);
      const expectedFingerprint = Commands.fingerprint(prompt);
      Platforms.setComposerValue(composer, prompt);
      await sleep(120);
      if (state.destroyed || state.pageId !== actionPageId || currentPageId() !== actionPageId) {
        return { ok: false, code: "route.changed", reason: "消息提交前对话已发生变化", deliveryAmbiguous: false };
      }
      composer = Platforms.findComposer(state.platform) || composer;
      if (Commands.fingerprint(Platforms.composerText(composer)) !== expectedFingerprint) {
        return { ok: false, code: "composer.write_unconfirmed", reason: "输入框未保留队列消息", deliveryAmbiguous: false };
      }

      submissionAttempted = true;
      if (!Platforms.submitComposer(state.platform, composer)) {
        return { ok: false, code: "composer.submit_failed", reason: "消息无法提交", deliveryAmbiguous: true };
      }

      const confirmationDeadline = now() + 15_000;
      while (now() < confirmationDeadline) {
        if (state.destroyed || state.pageId !== actionPageId || currentPageId() !== actionPageId) {
          return { ok: false, code: "route.changed", reason: "确认送达前对话已发生变化", deliveryAmbiguous: true };
        }
        if (Platforms.submissionObserved(state.platform, { expectedText: prompt, previousSnapshot })) {
          return { ok: true, deliveryAmbiguous: true };
        }
        await sleep(150);
      }
      return {
        ok: false,
        code: "composer.unconfirmed",
        reason: "对话中没有出现完全匹配的用户消息",
        deliveryAmbiguous: true
      };
    } catch (error) {
      return {
        ok: false,
        code: "queue.exception",
        reason: Shared.errorMessage(error),
        deliveryAmbiguous: submissionAttempted
      };
    }
  }

  async function submitTransientBootstrap(prompt) {
    const expectedText = String(prompt || "").trim();
    if (!expectedText) return { ok: false, code: "rollover.bootstrap_empty", reason: "新对话启动提示词为空", deliveryAmbiguous: false };
    if (!await ensureCurrentRoute()) {
      return { ok: false, code: "route.changed", reason: "ChatGPT 页面仍在跳转中", deliveryAmbiguous: false };
    }
    const startPageId = currentPageId();
    if (!Config.isSupportedUrl(location.href) || Config.isDurablePageId(startPageId)) {
      return { ok: false, code: "rollover.bootstrap_route_invalid", reason: "只有 ChatGPT 临时新对话页面允许发送启动提示", deliveryAmbiguous: false };
    }
    if (updateGenerationState()) {
      return { ok: false, code: "rollover.bootstrap_generating", reason: "ChatGPT 正在生成回答", deliveryAmbiguous: false };
    }

    let submissionAttempted = false;
    try {
      let composer = Platforms.findComposer(state.platform);
      if (!composer) return { ok: false, code: "composer.missing", reason: "未找到消息输入框", deliveryAmbiguous: false };
      if (Platforms.composerText(composer).trim()) {
        return { ok: false, code: "composer.busy", reason: "新对话输入框中已有草稿", deliveryAmbiguous: false };
      }

      const previousSnapshot = Platforms.userMessageSnapshot(state.platform);
      const expectedFingerprint = Commands.fingerprint(expectedText);
      Platforms.setComposerValue(composer, expectedText);
      const sendReadyDeadline = now() + 5_000;
      let sendButton = null;
      while (now() < sendReadyDeadline) {
        if (state.destroyed || currentPageId() !== startPageId) {
          return { ok: false, code: "route.changed", reason: "提交启动提示前，新对话页面已发生跳转", deliveryAmbiguous: false };
        }
        composer = Platforms.findComposer(state.platform) || composer;
        if (Commands.fingerprint(Platforms.composerText(composer)) !== expectedFingerprint) {
          return { ok: false, code: "composer.write_unconfirmed", reason: "输入框未保留新对话启动提示", deliveryAmbiguous: false };
        }
        sendButton = Platforms.findSendButton(state.platform, composer);
        if (sendButton) break;
        await sleep(100);
      }
      if (!sendButton) {
        return { ok: false, code: "composer.send_not_ready", reason: "新对话发送按钮尚未就绪", deliveryAmbiguous: false };
      }

      submissionAttempted = true;
      sendButton.click();

      const confirmationDeadline = now() + 15_000;
      let observed = false;
      while (now() < confirmationDeadline) {
        if (state.destroyed || !Config.isSupportedUrl(location.href)) {
          return { ok: false, code: "route.changed", reason: "发送启动提示期间 ChatGPT 离开了受支持页面", deliveryAmbiguous: true };
        }
        if (Platforms.submissionObserved(state.platform, { expectedText, previousSnapshot })) observed = true;
        const targetPageId = currentPageId();
        if (observed && Config.isStableConversationPageId(targetPageId)) {
          return { ok: true, targetPageId, deliveryAmbiguous: false };
        }
        await sleep(150);
      }
      return {
        ok: false,
        code: "rollover.bootstrap_unconfirmed",
        reason: "无法同时确认完全匹配的启动消息和后续对话",
        deliveryAmbiguous: true
      };
    } catch (error) {
      return {
        ok: false,
        code: "rollover.bootstrap_exception",
        reason: Shared.errorMessage(error),
        deliveryAmbiguous: submissionAttempted
      };
    }
  }

  function actionDedupeKey(action, prompt, reason) {
    return `auto:${action}:${Commands.fingerprint(`${prompt}\n${reason}`)}`;
  }

  async function sendPrompt({ action, prompt, label, reason, delayMinSec = 0, delayMaxSec = 0, automatic = true }) {
    if (state.actionInFlight || !state.platform) return false;
    const actionPageId = state.pageId;
    if (automatic && !automationReady()) return false;
    if (!automatic && (!state.loaded || !routeIsCurrent() || !Config.isDurablePageId(state.pageId))) return false;
    if (!safeForInput()) return false;
    if ((action === "recovery" || action === "nudge") && !inputActionCooldownPassed(action)) return false;

    const limit = checkActionLimit(action);
    if (!limit.allowed) {
      await setLastAction(`${label} blocked: ${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const delayMs = automatic ? randomMs(delayMinSec, delayMaxSec) : 150;
    if (delayMs > 0) await sleep(delayMs);
    if (state.destroyed || state.pageId !== actionPageId || currentPageId() !== actionPageId || !safeForInput()) return false;

    const queued = await backgroundSend({
      type: "YOLO_QUEUE_ADD",
      pageId: actionPageId,
      front: true,
      requireUnpaused: automatic,
      dedupeWindowMs: automatic
        ? Math.max(1000, (action === "recovery" ? state.settings.errorCooldownSec : state.settings.deepNudgeCooldownSec) * 1000)
        : 0,
      item: {
        text: prompt,
        source: `action:${action}`,
        sourceId: reason,
        dedupeKey: automatic ? actionDedupeKey(action, prompt, reason) : ""
      }
    });
    if (!queued?.ok) {
      await setBlocked(queued?.code || `action.${action}.queue_failed`, queued?.reason || `Could not queue ${label}`);
      return false;
    }
    if (queued.alreadyCompleted) return true;

    const sent = await handleQueue(false);
    if (!sent && !queued.deduplicated) {
      await setLastAction(`已加入队列：${label}（${reason}）`, "info", `action.${action}.queued`, true);
    }
    return sent;
  }

  async function sendContinue(reason, automatic = true) {
    return sendPrompt({ action: "recovery", prompt: "Continue", label: "Continue", reason, automatic });
  }

  async function sendDeepNudge(reason, automatic = true) {
    return sendPrompt({ action: "nudge", prompt: state.settings.deepNudgePrompt, label: "deep nudge", reason, automatic });
  }

  function refreshCooldownPassed(action = "refresh") {
    const cooldownMs = action === "watchdog"
      ? Math.max(30_000, state.settings.generationWatchdogStopGraceSec * 1000)
      : state.settings.refreshCooldownMin * 60 * 1000;
    return now() - (state.runtime.lastRefreshAt || 0) >= cooldownMs;
  }

  async function refreshPage(reason, automatic = true, action = "refresh", { allowDisabled = false } = {}) {
    if (state.actionInFlight || !state.platform || state.reloadScheduled) return false;
    const actionPageId = state.pageId;
    if (automatic && !automationReady({ allowDisabled })) return false;
    if (!automatic && (!state.loaded || !routeIsCurrent() || !Config.isDurablePageId(state.pageId))) return false;
    const workflow = workflowHealth();
    const generating = updateGenerationState();
    const watchdogForceRefresh = action === "watchdog"
      && Boolean(state.runtime?.generationWatchdog?.stopRequestedAt)
      && now() - state.runtime.generationWatchdog.stopRequestedAt >= state.settings.generationWatchdogStopGraceSec * 1000;
    if (action === "refresh" && automatic && !Lifecycle.canAutomaticRefresh({
      hydrated: state.hydrated,
      workflowActive: workflow.active,
      generating: generating || now() < state.generationHoldUntil,
      composerBusy: composerHasText(),
      lastDomActivityAt: state.lastDomActivityAt,
      now: now()
    })) return false;
    if ((generating && !watchdogForceRefresh) || composerHasText()) return false;
    if (!refreshCooldownPassed(action)) return false;

    const limit = checkActionLimit(action);
    if (!limit.allowed) {
      await setLastAction(`刷新已阻止：${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const cooldownMs = action === "watchdog"
      ? Math.max(30_000, state.settings.generationWatchdogStopGraceSec * 1000)
      : state.settings.refreshCooldownMin * 60 * 1000;
    const guard = await claimActionGuard("refresh", cooldownMs, Math.max(2 * 60 * 1000, cooldownMs));
    if (!guard?.ok) return false;

    state.actionInFlight = true;
    let completedGuard = false;
    try {
      if (state.pageId !== actionPageId || currentPageId() !== actionPageId || composerHasText()) return false;
      state.runtime.lastRefreshAt = now();
      ContentState.scheduleNextRefresh(true);
      const completed = await completeActionGuard("refresh", guard.token);
      completedGuard = Boolean(completed?.ok);
      if (!completedGuard) {
        await setLastAction("刷新已阻止：无法保存跨标签页冷却状态", "error", "refresh.guard_unconfirmed", true);
        return false;
      }
      await recordAction(action);
      await setLastAction(`正在刷新（${reason}）`, "success", `action.${action}.refresh`, true);
      state.reloadScheduled = true;
      window.setTimeout(() => {
        if (currentPageId() === actionPageId) location.reload();
        else {
          state.reloadScheduled = false;
          state.actionInFlight = false;
          queueCycle();
        }
      }, automatic ? 500 : 150);
      return true;
    } finally {
      if (!completedGuard) await releaseActionGuard("refresh", guard.token);
      if (!state.reloadScheduled) state.actionInFlight = false;
    }
  }

  function errorSignature(element) {
    const text = Platforms.normalizedText(element).replace(/\s+/g, " ").trim().slice(0, 320);
    return `${state.platform?.id || "unknown"}:${text}`;
  }

  async function handleErrorState() {
    if (!automationReady() || !state.settings.errorRecoveryEnabled || state.actionInFlight) return false;
    const error = Platforms.findErrorState(state.platform);
    if (!error) return false;

    const signature = errorSignature(error);
    const cooldownMs = state.settings.errorCooldownSec * 1000;
    if (signature === state.runtime.lastErrorSignature && now() - state.runtime.lastErrorHandledAt < cooldownMs) return false;

    const limit = checkActionLimit("recovery");
    if (!limit.allowed) {
      await setLastAction(`恢复已阻止：${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const errorPageId = state.pageId;
    state.runtime.lastErrorSignature = signature;
    state.runtime.lastErrorHandledAt = now();
    ContentState.saveRuntime();
    await setLastAction("检测到错误，正在尝试恢复", "warning", "recovery.detected", true);

    const delayMs = randomMs(state.settings.errorDelayMinSec, state.settings.errorDelayMaxSec);
    if (delayMs > 0) await sleep(delayMs);
    if (state.destroyed || state.pageId !== errorPageId || currentPageId() !== errorPageId) return false;

    const strategy = state.settings.errorRecoveryStrategy;
    let handled = false;
    if (strategy === "continue-only") handled = await sendContinue("error recovery");
    else if (strategy === "refresh-only") handled = await refreshPage("error recovery", true, "recovery");
    else if (strategy === "refresh-first") handled = (await refreshPage("error recovery", true, "recovery")) || await sendContinue("error recovery fallback");
    else handled = (await sendContinue("error recovery")) || await refreshPage("error recovery fallback", true, "recovery");

    if (!handled && state.runtime) {
      state.runtime.lastErrorHandledAt = now() - Math.max(0, cooldownMs - FAILED_RECOVERY_RETRY_MS);
      ContentState.saveRuntime();
    }
    return handled;
  }

  async function handleGenerationWatchdog() {
    if (!state.runtime?.generationWatchdog) return false;
    const watchdog = state.runtime.generationWatchdog;
    const generating = updateGenerationState();
    const decision = Lifecycle.generationWatchdogDecision({
      enabled: state.settings.generationWatchdogEnabled || Boolean(watchdog.stopRequestedAt),
      generating,
      startedAt: watchdog.startedAt,
      lastProgressAt: watchdog.lastProgressAt,
      stopRequestedAt: watchdog.stopRequestedAt,
      stoppedAt: watchdog.stoppedAt,
      now: now(),
      softStallMs: state.settings.generationWatchdogSoftStallMin * 60 * 1000,
      hardStallMs: state.settings.generationWatchdogHardStallMin * 60 * 1000,
      absoluteLimitMs: state.settings.generationWatchdogAbsoluteLimitMin * 60 * 1000,
      stopGraceMs: state.settings.generationWatchdogStopGraceSec * 1000
    });

    if (decision.action === "none" || decision.action === "wait-stop" || decision.action === "wait-recovery") return false;
    if (decision.action === "warn") {
      if (watchdog.softWarnedAt) return false;
      watchdog.softWarnedAt = now();
      ContentState.saveRuntime();
      await setLastAction(`生成卡死监控告警：${decision.reason}`, "warning", "watchdog.soft_stall", true);
      return false;
    }
    if (decision.action === "stop") {
      if (state.actionInFlight || watchdog.stopRequestedAt) return false;
      const limit = checkActionLimit("watchdog");
      if (!limit.allowed) {
        await setLastAction(`生成卡死监控已阻止：${limit.reason}`, "warning", limit.code, true);
        return false;
      }
      const clicked = Platforms.stopGeneration(state.platform);
      watchdog.stopRequestedAt = now();
      watchdog.stoppedAt = 0;
      watchdog.refreshRequestedAt = 0;
      ContentState.saveRuntime();
      await recordAction("watchdog");
      await setLastAction(
        clicked
          ? `Generation watchdog requested Stop: ${decision.reason}`
          : `Generation watchdog could not find Stop; refresh fallback armed: ${decision.reason}`,
        "warning",
        clicked ? "watchdog.stop_requested" : "watchdog.stop_missing",
        true
      );
      return true;
    }
    if (decision.action === "refresh") {
      if (state.actionInFlight || state.reloadScheduled) return false;
      watchdog.refreshRequestedAt = now();
      ContentState.saveRuntime();
      const refreshed = await refreshPage(
        "stuck generation watchdog fallback",
        true,
        "watchdog",
        { allowDisabled: workflowHealth().active }
      );
      if (!refreshed) {
        await setLastAction("生成卡死监控正在等待安全的刷新时机", "warning", "watchdog.refresh_waiting");
      }
      return refreshed;
    }
    if (decision.action === "resume") {
      if (state.actionInFlight) return false;
      const workflow = workflowHealth();
      if (workflow.pendingItemId || (workflow.active && !workflow.awaitingResponse)) {
        resetGenerationWatchdog();
        return false;
      }

      let recovered = false;
      if (workflow.active) {
        const result = await window.__YOLO_COMMAND_RUNTIME__?.recoverStalledGeneration?.(decision.reason);
        recovered = Boolean(result?.ok && (result.handled || result.alreadyRecovered));
        if (!result?.ok && result?.code && result.code !== "watchdog.generation_active") {
          await setLastAction(`生成卡死监控正在等待工作流恢复：${result.reason || result.code}`, "warning", result.code);
        }
      } else {
        recovered = await sendContinue("stuck generation watchdog", true);
      }

      if (recovered) {
        resetGenerationWatchdog();
        await setLastAction("生成卡死监控已从被中断的回答继续", "success", "watchdog.recovered", true);
      }
      return recovered;
    }
    return false;
  }

  function pruneApprovalSignatures() {
    state.runtime.approvalSignatures = ContentState.normalizeApprovalSignatures(state.runtime.approvalSignatures, state.runtime.lastActionAt);
  }

  function recentlyApproved(signature) {
    pruneApprovalSignatures();
    return state.runtime.approvalSignatures.some((entry) => entry.signature === signature);
  }

  async function handleApprovalCards() {
    if (!automationReady() || !state.settings.approvalsEnabled || state.actionInFlight || !state.platform?.supportsApprovals) return false;
    if (updateGenerationState()) return false;

    const cooldownMs = state.settings.approvalCooldownSec * 1000;
    const lastApprovalAt = state.runtime.history.approval.at(-1) || 0;
    if (now() - lastApprovalAt < cooldownMs) return false;

    const limit = checkActionLimit("approval");
    if (!limit.allowed) return false;

    const approvalPageId = state.pageId;
    const candidates = Platforms.findApprovalCards(state.platform, state.settings.approvalPolicy);
    for (const candidate of candidates) {
      if (recentlyApproved(candidate.signature)) continue;

      state.actionInFlight = true;
      let guard = null;
      let clicked = false;
      try {
        await setLastAction(`发现授权确认：${Platforms.buttonText(candidate.button) || "确认操作"}`, "info", "approval.detected");
        await sleep(randomMs(state.settings.approvalDelayMinSec, state.settings.approvalDelayMaxSec));
        if (state.destroyed || state.pageId !== approvalPageId || currentPageId() !== approvalPageId) return false;
        updateGenerationState();
        if (state.generationActive || composerHasText()) return false;

        guard = await claimActionGuard("approval", cooldownMs, 10 * 60 * 1000);
        if (!guard?.ok) return false;
        const refreshedCandidate = Platforms.findApprovalCards(state.platform, state.settings.approvalPolicy)
          .find((entry) => entry.signature === candidate.signature);
        if (!refreshedCandidate || recentlyApproved(refreshedCandidate.signature)) return false;
        if (!refreshedCandidate.button.isConnected || !Platforms.visible(refreshedCandidate.button) || Platforms.isDisabled(refreshedCandidate.button)) return false;

        const begun = await beginActionGuard("approval", guard.token);
        if (!begun?.ok) return false;
        refreshedCandidate.button.click();
        clicked = true;
        const completed = await completeActionGuard("approval", guard.token);
        if (!completed?.ok) {
          await setLastAction("已点击授权确认，但无法确认跨标签页操作完成", "error", "approval.completion_unconfirmed", true);
          return true;
        }
        state.runtime.approvalSignatures = [
          ...state.runtime.approvalSignatures,
          { signature: refreshedCandidate.signature, at: now() }
        ].slice(-100);
        await recordAction("approval");
        await setLastAction(`已点击授权确认：${Platforms.buttonText(refreshedCandidate.button) || "确认操作"}`, "success", `approval.${refreshedCandidate.risk}`, true);
        return true;
      } finally {
        if (guard?.ok && !clicked) await releaseActionGuard("approval", guard.token);
        state.actionInFlight = false;
      }
    }
    return false;
  }

  async function releaseQueueClaim(pageId, item, reason) {
    return backgroundSendWithRetry({
      type: "YOLO_QUEUE_RELEASE",
      pageId,
      itemId: item.id,
      claimToken: item.claimToken,
      reason
    });
  }

  async function failQueueClaim(pageId, item, error, options, errorCode = "queue.send_failed", deliveryAmbiguous = false) {
    return backgroundSendWithRetry({
      type: "YOLO_QUEUE_FAIL",
      pageId,
      itemId: item.id,
      claimToken: item.claimToken,
      error,
      errorCode,
      maxRetries: options.maxRetries,
      backoffSec: options.backoffSec,
      pauseOnFailure: options.pauseOnFailure,
      deliveryAmbiguous
    });
  }

  async function handleQueue(automatic = true) {
    if (state.actionInFlight || !state.platform) return false;
    if (automatic && (!automationReady() || !state.settings.queueAutoRunEnabled)) return false;
    if (!automatic) state.pendingManualQueueRetry = false;

    updateGenerationState();
    const safety = checkSafeForInput();
    if (!safety.safe) {
      if (!automatic) await setBlocked(safety.code, safety.reason);
      scheduleInputRetry(safety, automatic);
      return false;
    }
    if (!automatic && !state.loaded) return false;
    if (!automatic) clearBlocked();
    if (automatic && now() < (state.runtime.nextQueueAt || 0)) return false;

    if (automatic) {
      const idleBaseline = Math.max(state.pageLoadedAt, state.runtime.lastUserActivityAt, state.runtime.lastGenerationAt);
      if (now() - idleBaseline < state.settings.queueIdleSec * 1000) return false;
    }

    const limit = checkActionLimit("queue");
    if (!limit.allowed) {
      await setLastAction(`队列已阻止：${limit.reason}`, "warning", limit.code, true);
      return false;
    }

    const queuePageId = state.pageId;
    const queueFailureOptions = {
      maxRetries: state.settings.queueMaxRetries,
      backoffSec: state.settings.queueRetryBackoffSec,
      pauseOnFailure: state.settings.queuePauseOnFailure
    };
    const claim = await backgroundSend({
      type: "YOLO_QUEUE_CLAIM",
      pageId: queuePageId,
      ownerId: state.ownerId
    });
    if (!claim?.ok || !claim.item) {
      if (claim?.code === "queue.paused") await setBlocked("queue.paused", "队列已暂停");
      else if (state.blockedCode.startsWith("queue.")) clearBlocked("queue.");
      return false;
    }

    const item = claim.item;
    let deliveryAmbiguous = false;
    state.actionInFlight = true;
    try {
      if (state.destroyed || state.pageId !== queuePageId || currentPageId() !== queuePageId) {
        await releaseQueueClaim(queuePageId, item, "Conversation changed before the queued message could send");
        return false;
      }
      updateGenerationState();
      const sendSafety = checkSafeForInput();
      if (!sendSafety.safe) {
        await releaseQueueClaim(queuePageId, item, `Queue paused before send: ${sendSafety.reason}`);
        if (!automatic) await setBlocked(sendSafety.code, sendSafety.reason);
        scheduleInputRetry(sendSafety, automatic);
        return false;
      }

      const markedSubmitting = await backgroundSendWithRetry({
        type: "YOLO_QUEUE_MARK_SUBMITTING",
        pageId: queuePageId,
        itemId: item.id,
        claimToken: item.claimToken
      });
      if (!markedSubmitting?.ok) {
        await releaseQueueClaim(queuePageId, item, "Could not persist the queue submission phase");
        await setLastAction("队列发送已阻止：无法保存发送意图", "error", "queue.submit_intent_failed", true);
        return false;
      }

      await setLastAction("正在发送队列消息", "info", "queue.sending");
      const submitted = await writeAndSubmit(item.text, queuePageId);
      deliveryAmbiguous = Boolean(submitted.deliveryAmbiguous);
      if (!submitted.ok) {
        await failQueueClaim(queuePageId, item, submitted.reason, queueFailureOptions, submitted.code, deliveryAmbiguous);
        await setLastAction(`队列发送失败：${submitted.reason}`, "error", submitted.code, true);
        return false;
      }
      deliveryAmbiguous = true;

      const completed = await backgroundSendWithRetry({
        type: "YOLO_QUEUE_COMPLETE",
        pageId: queuePageId,
        itemId: item.id,
        claimToken: item.claimToken
      });
      if (!completed?.ok) {
        await setLastAction("消息已发送，但无法确认队列完成状态", "warning", "queue.completion_unconfirmed", true);
        return true;
      }

      await recordAction("queue");
      const sourceAction = item.source?.startsWith("action:") ? item.source.slice("action:".length) : "";
      if (["recovery", "nudge"].includes(sourceAction)) {
        await recordAction(sourceAction, COUNTER_BY_ACTION[sourceAction], { incrementSession: false });
      }
      ContentState.scheduleNextQueue(true);
      await setLastAction(sourceAction ? `Sent ${sourceAction} prompt` : "Sent queued message", "success", sourceAction ? `action.${sourceAction}` : "queue.sent", true);
      return true;
    } catch (error) {
      await failQueueClaim(queuePageId, item, Shared.errorMessage(error), queueFailureOptions, "queue.exception", deliveryAmbiguous);
      await setLastAction(`队列发送失败：${Shared.errorMessage(error)}`, "error", "queue.failed", true);
      return false;
    } finally {
      state.actionInFlight = false;
    }
  }

  async function handleDeepNudge() {
    if (!automationReady() || !state.settings.deepNudgesEnabled || state.actionInFlight) return false;
    if (updateGenerationState() || !safeForInput()) return false;

    const lastNudgeAt = state.runtime.history.nudge.at(-1) || 0;
    if (now() - lastNudgeAt < state.settings.deepNudgeCooldownSec * 1000) return false;

    const idleBaseline = Math.max(state.pageLoadedAt, state.runtime.lastUserActivityAt, state.runtime.lastGenerationAt, state.runtime.lastActionAt);
    if (now() - idleBaseline < state.settings.deepNudgeIdleSec * 1000) return false;
    return sendDeepNudge("idle");
  }

  async function handlePeriodicRefresh() {
    if (!automationReady() || !state.settings.autoRefreshEnabled || state.actionInFlight) return false;
    ContentState.scheduleNextRefresh();
    if (now() < state.runtime.nextRefreshAt) return false;
    if (updateGenerationState() || !safeForInput()) return false;

    const idleBaseline = Math.max(state.pageLoadedAt, state.runtime.lastUserActivityAt, state.runtime.lastGenerationAt, state.runtime.lastActionAt);
    if (now() - idleBaseline < state.settings.refreshIdleMin * 60 * 1000) return false;
    return refreshPage("scheduled idle refresh");
  }

  async function runCycle() {
    if (state.destroyed || state.cycleInFlight || !state.loaded || state.reloadScheduled) return;
    state.cycleInFlight = true;
    try {
      if (!routeIsCurrent()) {
        await handleRouteChange();
        return;
      }
      updateGenerationState();
      if (!probeHydration()) return;
      if (await handleErrorState()) return;
      if (await handleGenerationWatchdog()) return;
      if (await handleApprovalCards()) return;
      if (state.pendingManualQueueRetry && await handleQueue(false)) return;
      if (await handleQueue(true)) return;
      if (await handleDeepNudge()) return;
      await handlePeriodicRefresh();
    } catch (error) {
      if (!disableStaleContext(error)) await setLastAction(`自动化错误：${Shared.errorMessage(error)}`, "error", "engine.error", true);
    } finally {
      state.cycleInFlight = false;
    }
  }

  function queueCycle(delayMs = null) {
    if (state.destroyed || state.reloadScheduled) return;
    const requested = delayMs == null
      ? Lifecycle.mutationDelay({ hidden: document.hidden, generating: state.generationActive })
      : delayMs;
    const delay = Math.max(0, Number.isFinite(Number(requested)) ? Number(requested) : 0);
    const wakeAt = now() + delay;
    if (state.scanQueued && state.scanWakeAt <= wakeAt) return;

    window.clearTimeout(state.scanWakeTimer);
    state.scanQueued = true;
    state.scanWakeAt = wakeAt;
    state.scanWakeTimer = window.setTimeout(() => {
      state.scanQueued = false;
      state.scanWakeTimer = null;
      state.scanWakeAt = 0;
      if (state.cycleInFlight) {
        queueCycle(50);
        return;
      }
      runCycle();
    }, Math.max(0, wakeAt - now()));
  }

  function restartScanTimer() {
    window.clearTimeout(state.scanTimer);
    if (state.destroyed || state.reloadScheduled) return;
    const delay = Lifecycle.scanDelay({
      hidden: document.hidden,
      generating: state.generationActive,
      configuredSec: state.settings.scanIntervalSec
    });
    state.scanTimer = window.setTimeout(async () => {
      try {
        await runCycle();
      } finally {
        restartScanTimer();
      }
    }, delay);
  }

  function restartRouteTimer() {
    window.clearTimeout(state.routeTimer);
    if (state.destroyed || state.reloadScheduled) return;
    state.routeTimer = window.setTimeout(async () => {
      try {
        await handleRouteChange();
      } catch (error) {
        if (!disableStaleContext(error)) await setLastAction(`对话路由同步失败：${Shared.errorMessage(error)}`, "error", "route.sync_failed", true);
      } finally {
        restartRouteTimer();
      }
    }, Lifecycle.routeDelay({ hidden: document.hidden }));
  }

  async function sendHeartbeat() {
    if (state.destroyed || !Config.isSupportedUrl(location.href)) return false;
    const workflow = workflowHealth();
    const response = await backgroundSend({
      type: "YOLO_TAB_HEARTBEAT",
      pageId: state.pageId || currentPageId(),
      visible: !document.hidden,
      workflowActive: workflow.active
    });
    if (response?.ok) state.lastHeartbeatAt = Number(response.at) || now();
    return Boolean(response?.ok);
  }

  function restartHeartbeatTimer({ immediate = false } = {}) {
    window.clearTimeout(state.heartbeatTimer);
    if (state.destroyed || state.reloadScheduled) return;
    const delay = immediate ? 0 : Lifecycle.heartbeatIntervalMs({ hidden: document.hidden });
    state.heartbeatTimer = window.setTimeout(async () => {
      try {
        await sendHeartbeat();
      } finally {
        restartHeartbeatTimer();
      }
    }, delay);
  }

  async function handleRouteChange() {
    const nextPageId = currentPageId();
    if (nextPageId === state.pageId || state.routeInFlight || state.reloadScheduled) return;

    state.routeInFlight = true;
    try {
      ContentState.saveRuntime();
      state.pageId = nextPageId;
      state.platform = Platforms.adapterForLocation();
      state.pageLoadedAt = now();
      state.loaded = false;
      state.hydrated = false;
      state.hydratedAt = 0;
      state.hydrationCandidateSince = 0;
      state.lastDomActivityAt = now();
      state.generationHoldUntil = 0;
      state.lastGenerationPersistAt = 0;
      state.pendingManualQueueRetry = false;
      clearBlocked();
      state.generationActive = false;
      await loadSettings();
      restartScanTimer();
      restartHeartbeatTimer({ immediate: true });
      await setLastAction("已加载当前对话设置", "info", "route.loaded");
      queueCycle();
    } finally {
      state.routeInFlight = false;
    }
  }

  function markUserActivity(event) {
    if (!state.runtime || event?.isTrusted === false) return;
    state.runtime.lastUserActivityAt = now();
    window.clearTimeout(state.activitySaveTimer);
    state.activitySaveTimer = window.setTimeout(ContentState.saveRuntime, 500);
  }


  function installStorageListener() {
    state.storageListener = (changes, areaName) => {
      if (state.destroyed || areaName !== "local") return;
      const settingsPageId = state.pageId;
      const pageKey = Config.pageSettingsKey(settingsPageId);
      const settingsChanged = Object.prototype.hasOwnProperty.call(changes, Config.STORAGE_KEYS.global)
        || Object.prototype.hasOwnProperty.call(changes, Config.STORAGE_KEYS.pages)
        || Object.prototype.hasOwnProperty.call(changes, pageKey);
      if (settingsChanged) {
        storageGet([Config.STORAGE_KEYS.global, Config.STORAGE_KEYS.pages, pageKey]).then((stored) => {
          if (state.destroyed || state.pageId !== settingsPageId || currentPageId() !== settingsPageId) return;
          const globalSettings = stored[Config.STORAGE_KEYS.global] || {};
          const legacyPageSettings = stored[Config.STORAGE_KEYS.pages]?.[settingsPageId] || {};
          const pageSettings = stored[pageKey] || legacyPageSettings;
          state.settings = Config.mergeSettings(Config.DEFAULT_SETTINGS, globalSettings, pageSettings);
          ContentState.scheduleNextRefresh(true);
          ContentState.scheduleNextQueue(true);
          restartScanTimer();
          queueCycle();
        });
      }
      const actionChange = changes[Config.lastActionKey(state.pageId)];
      if (actionChange?.newValue?.message) state.lastAction = actionChange.newValue;
    };
    chrome.storage.onChanged.addListener(state.storageListener);
  }

  function handleDomMutation() {
    state.lastDomActivityAt = now();
    queueCycle();
  }

  function addLifecycleHandler(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    state.lifecycleHandlers.push({ target, eventName, handler });
  }

  function handleLifecycleWake() {
    if (state.destroyed) return;
    probeHydration();
    restartScanTimer();
    restartRouteTimer();
    restartHeartbeatTimer({ immediate: true });
    queueCycle(0);
  }

  function handleLifecycleSuspend() {
    ContentState.saveRuntime();
  }

  function installObservers() {
    state.observer = new MutationObserver(handleDomMutation);
    state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    for (const eventName of ["pointerdown", "keydown", "input", "focusin"]) {
      document.addEventListener(eventName, markUserActivity, true);
    }
    addLifecycleHandler(document, "visibilitychange", handleLifecycleWake);
    addLifecycleHandler(window, "pageshow", handleLifecycleWake);
    addLifecycleHandler(window, "pagehide", handleLifecycleSuspend);
    addLifecycleHandler(document, "freeze", handleLifecycleSuspend);
    addLifecycleHandler(document, "resume", handleLifecycleWake);

    restartScanTimer();
    restartRouteTimer();
    restartHeartbeatTimer({ immediate: true });
  }


  async function runManualAction(action) {
    if (!await ensureCurrentRoute()) return false;
    if (action === "nudge") return sendDeepNudge("manual", false);
    if (action === "continue") return sendContinue("manual", false);
    if (action === "refresh") return refreshPage("manual", false);
    if (action === "watchdog-response-refresh") {
      return refreshPage(
        "工作流等待 ChatGPT 回答启动超时",
        true,
        "watchdog",
        { allowDisabled: true }
      );
    }
    if (action === "queue-next") return handleQueue(false);
    if (action === "scan") {
      await runCycle();
      return true;
    }
    return false;
  }

  async function resetRuntime() {
    if (!await ensureCurrentRoute()) throw new Error("对话页面仍在跳转中");
    const guardReset = await backgroundSendWithRetry({ type: "YOLO_ACTION_RESET", pageId: state.pageId, actionKey: "" });
    if (!guardReset?.ok) throw new Error(guardReset?.reason || "Could not reset the conversation action guards");
    state.runtime = ContentState.freshRuntime();
    ContentState.scheduleNextRefresh(true);
    ContentState.scheduleNextQueue(false);
    ContentState.saveRuntime();
    clearBlocked();
    await setLastAction("已重置会话限制和操作历史", "info", "runtime.reset", true);
  }

  function registerClient(destroyClient) {
    if (typeof destroyClient !== "function" || state.destroyed) return () => {};
    state.clients.add(destroyClient);
    return () => state.clients.delete(destroyClient);
  }

  const commandApi = Object.freeze({
    getState: ContentState.responseState,
    ensureReady: ensureCurrentRoute,
    runAction: runManualAction,
    submitTransientBootstrap,
    recordStatus: setLastAction,
    registerClient
  });

  function installMessages() {
    state.messageListener = (message, _sender, sendResponse) => {
      if (state.destroyed) return false;

      if (message?.type === "YOLOTAB_HEALTH_CHECK") {
        updateGenerationState();
        probeHydration();
        const workflow = workflowHealth();
        sendResponse({
          ok: true,
          pageId: state.pageId,
          hydrated: state.hydrated,
          generating: state.generationActive,
          visible: !document.hidden,
          lastDomActivityAt: state.lastDomActivityAt,
          workflow,
          settings: { protectActiveWorkflowTabs: state.settings.protectActiveWorkflowTabs }
        });
        return false;
      }

      if (message?.type === "YOLO_GET_STATE") {
        ensureCurrentRoute()
          .then((ready) => {
            if (ready) updateGenerationState();
            sendResponse(ready ? ContentState.responseState() : null);
          })
          .catch((error) => {
            console.error(`YOLO_GET_STATE failed: ${Shared.errorMessage(error)}`);
            sendResponse(null);
          });
        return true;
      }

      if (message?.type === "YOLO_SET_SETTINGS" || message?.type === "YOLO_SET_TAB_SETTINGS") {
        persistSettings(message.settings || {})
          .then((settings) => {
            sendResponse({ ok: true, settings, state: ContentState.responseState() });
            queueCycle();
          })
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      if (message?.type === "YOLO_APPLY_IMPORTED_SETTINGS") {
        ensureCurrentRoute()
          .then((ready) => {
            if (!ready) throw new Error("对话页面仍在跳转中");
            state.settings = Config.normalizeSettings(message.settings || {});
            ContentState.scheduleNextRefresh(true);
            ContentState.scheduleNextQueue(true);
            restartScanTimer();
            queueCycle();
            sendResponse({ ok: true, settings: state.settings, state: ContentState.responseState() });
          })
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      if (message?.type === "YOLO_RUN_ACTION") {
        runManualAction(message.action)
          .then((ok) => sendResponse({ ok, state: ContentState.responseState() }))
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      if (message?.type === "YOLO_RESET_RUNTIME") {
        resetRuntime()
          .then(() => sendResponse({ ok: true, state: ContentState.responseState() }))
          .catch((error) => sendResponse({ ok: false, reason: Shared.errorMessage(error), state: ContentState.responseState() }));
        return true;
      }

      return false;
    };
    chrome.runtime.onMessage.addListener(state.messageListener);
  }

  function destroy() {
    state.destroyed = true;
    state.observer?.disconnect();
    window.clearTimeout(state.scanTimer);
    window.clearTimeout(state.scanWakeTimer);
    window.clearTimeout(state.routeTimer);
    window.clearTimeout(state.heartbeatTimer);
    window.clearTimeout(state.activitySaveTimer);
    if (state.messageListener) chrome.runtime.onMessage.removeListener(state.messageListener);
    if (state.storageListener) chrome.storage.onChanged.removeListener(state.storageListener);
    for (const destroyClient of state.clients) {
      try { destroyClient(); } catch { /* Client cleanup is best-effort. */ }
    }
    state.clients.clear();
    for (const eventName of ["pointerdown", "keydown", "input", "focusin"]) {
      document.removeEventListener(eventName, markUserActivity, true);
    }
    for (const { target, eventName, handler } of state.lifecycleHandlers) target.removeEventListener(eventName, handler);
    state.lifecycleHandlers = [];
  }

  window.__YOLO_EXTENSION__ = { version: Config.VERSION, destroy, commandApi };

  installMessages();
  loadSettings().then(() => {
    if (state.destroyed) return;
    installStorageListener();
    installObservers();
    runCycle();
  }).catch((error) => {
    if (!disableStaleContext(error)) setLastAction(`启动失败：${Shared.errorMessage(error)}`, "error", "startup.failed", true);
  });
})();
