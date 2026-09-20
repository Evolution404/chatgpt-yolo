((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOLifecycle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const VISIBLE_WORKFLOW_POLL_MS = 750;
  const HIDDEN_ACTIVE_WORKFLOW_POLL_MS = 5_000;
  const HIDDEN_IDLE_WORKFLOW_POLL_MS = 15_000;
  const MIN_HIDDEN_SCAN_MS = 5_000;
  const MIN_HIDDEN_GENERATING_SCAN_MS = 10_000;
  const VISIBLE_MUTATION_DEBOUNCE_MS = 350;
  const HIDDEN_MUTATION_DEBOUNCE_MS = 1_500;
  const HIDDEN_GENERATING_MUTATION_DEBOUNCE_MS = 5_000;
  const HYDRATION_QUIET_MS = 1_500;
  const INPUT_SETTLE_MS = 1_500;
  const POST_GENERATION_HOLD_MS = 15_000;
  const MARKER_RESPONSE_STABLE_MS = 15_000;
  const MISSING_MARKER_RESPONSE_STABLE_MS = 3 * 60 * 60 * 1_000;
  const REFRESH_QUIET_MS = 60_000;
  const WATCHDOG_RECOVERY_SETTLE_MS = 15_000;
  const HEARTBEAT_VISIBLE_MS = 20_000;
  const HEARTBEAT_HIDDEN_MS = 45_000;
  const HEARTBEAT_ACTIVE_STALE_MS = 60_000;
  const HEARTBEAT_BACKGROUND_STALE_MS = 150_000;

  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  function scanDelay({ hidden = false, generating = false, configuredSec = 3 } = {}) {
    const configured = Math.max(1_000, finite(configuredSec, 3) * 1_000);
    if (!hidden) return configured;
    return Math.max(configured, generating ? MIN_HIDDEN_GENERATING_SCAN_MS : MIN_HIDDEN_SCAN_MS);
  }

  function routeDelay({ hidden = false } = {}) {
    return hidden ? 3_000 : 750;
  }

  function mutationDelay({ hidden = false, generating = false } = {}) {
    if (!hidden) return VISIBLE_MUTATION_DEBOUNCE_MS;
    return generating ? HIDDEN_GENERATING_MUTATION_DEBOUNCE_MS : HIDDEN_MUTATION_DEBOUNCE_MS;
  }

  function workflowPollDelay({ hidden = false, workflowActive = false, generating = false } = {}) {
    if (!hidden) return VISIBLE_WORKFLOW_POLL_MS;
    return workflowActive || generating ? HIDDEN_ACTIVE_WORKFLOW_POLL_MS : HIDDEN_IDLE_WORKFLOW_POLL_MS;
  }

  function heartbeatIntervalMs({ hidden = false } = {}) {
    return hidden ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_VISIBLE_MS;
  }

  function heartbeatStaleMs({ hidden = false } = {}) {
    return hidden ? HEARTBEAT_BACKGROUND_STALE_MS : HEARTBEAT_ACTIVE_STALE_MS;
  }

  function responseStableMs(outcome) {
    return outcome === "missing" ? MISSING_MARKER_RESPONSE_STABLE_MS : MARKER_RESPONSE_STABLE_MS;
  }

  function hydrationCandidate({ documentReadyState = "loading", composerPresent = false, lastDomActivityAt = 0, now = Date.now() } = {}) {
    if (documentReadyState === "loading" || !composerPresent) return false;
    return now - Math.max(0, finite(lastDomActivityAt, 0)) >= HYDRATION_QUIET_MS;
  }

  function inputSafety({
    routeCurrent = false,
    durablePage = false,
    composerPresent = false,
    hydrated = false,
    hydrationRetryAfterMs = 0,
    workflowAwaitingResponse = false,
    generating = false,
    generationHoldUntil = 0,
    lastDomActivityAt = 0,
    composerBusy = false,
    now = Date.now(),
    settleMs = INPUT_SETTLE_MS
  } = {}) {
    const timestamp = finite(now, Date.now());
    const blocked = (code, reason, retryAfterMs = 0) => ({
      safe: false,
      code,
      reason,
      retryAfterMs: Math.max(0, finite(retryAfterMs, 0))
    });

    if (!routeCurrent) {
      return blocked("route.not_current", "Conversation navigation is in progress");
    }
    if (!durablePage) {
      return blocked("route.invalid", "Open a saved ChatGPT conversation before sending queued prompts");
    }
    if (!composerPresent) {
      return blocked("queue.composer_missing", "The message composer is not available yet");
    }
    if (!hydrated) {
      return blocked("hydration.pending", "Page elements are still loading", hydrationRetryAfterMs);
    }
    if (workflowAwaitingResponse) {
      return blocked("workflow.waiting", "Workflow is waiting for ChatGPT to respond");
    }
    if (generating) {
      return blocked("queue.generating", "The chat is still generating");
    }

    const holdRemaining = Math.max(0, finite(generationHoldUntil, 0) - timestamp);
    if (holdRemaining > 0) {
      return blocked(
        "queue.generating_cooldown",
        `Waiting for post-generation cooldown (${Math.ceil(holdRemaining / 1000)}s remaining)`,
        holdRemaining
      );
    }

    const settleRemaining = Math.max(
      0,
      Math.max(0, finite(lastDomActivityAt, 0))
        + Math.max(0, finite(settleMs, INPUT_SETTLE_MS))
        - timestamp
    );
    if (settleRemaining > 0) {
      return blocked("queue.dom_cooldown", "Waiting for page layout to settle", settleRemaining);
    }
    if (composerBusy) {
      return blocked("queue.composer_busy", "The composer contains a draft");
    }
    return { safe: true, code: "", reason: "", retryAfterMs: 0 };
  }

  function nextGenerationHoldUntil({
    wasGenerating = false,
    generating = false,
    currentHoldUntil = 0,
    now = Date.now(),
    holdMs = POST_GENERATION_HOLD_MS
  } = {}) {
    const timestamp = finite(now, Date.now());
    const current = Math.max(0, finite(currentHoldUntil, 0));
    if (wasGenerating && !generating) {
      return Math.max(current, timestamp + Math.max(0, finite(holdMs, POST_GENERATION_HOLD_MS)));
    }
    return current;
  }

  function canAutomaticRefresh({
    hydrated = false,
    workflowActive = false,
    generating = false,
    composerBusy = false,
    lastDomActivityAt = 0,
    now = Date.now(),
    quietMs = REFRESH_QUIET_MS
  } = {}) {
    if (!hydrated || workflowActive || generating || composerBusy) return false;
    return now - Math.max(0, finite(lastDomActivityAt, 0)) >= Math.max(0, finite(quietMs, REFRESH_QUIET_MS));
  }

  function shouldProtectTab({ enabled = false, workflowStatus = "idle" } = {}) {
    return Boolean(enabled && workflowStatus === "running");
  }

  function generationWatchdogDecision({
    enabled = false,
    generating = false,
    startedAt = 0,
    lastProgressAt = 0,
    stopRequestedAt = 0,
    stoppedAt = 0,
    now = Date.now(),
    softStallMs = 5 * 60 * 1000,
    hardStallMs = 10 * 60 * 1000,
    absoluteLimitMs = 30 * 60 * 1000,
    stopGraceMs = 30 * 1000,
    recoverySettleMs = WATCHDOG_RECOVERY_SETTLE_MS
  } = {}) {
    if (!enabled) return { action: "none", reason: "生成卡死监控已关闭" };
    const timestamp = finite(now, Date.now());
    const started = Math.max(0, finite(startedAt, 0));
    const progress = Math.max(started, finite(lastProgressAt, started));
    const stopAt = Math.max(0, finite(stopRequestedAt, 0));
    const stopped = Math.max(0, finite(stoppedAt, 0));

    if (stopAt > 0) {
      if (!generating && stopped > 0) {
        const settleRemaining = Math.max(0, stopped + Math.max(0, finite(recoverySettleMs, WATCHDOG_RECOVERY_SETTLE_MS)) - timestamp);
        if (settleRemaining > 0) return { action: "wait-recovery", reason: "正在等待被中断的回答稳定", retryAfterMs: settleRemaining };
        return { action: "resume", reason: "被中断的生成已停止，可从已有部分回答继续" };
      }
      if (generating) {
        const graceRemaining = Math.max(0, stopAt + Math.max(0, finite(stopGraceMs, 30_000)) - timestamp);
        if (graceRemaining > 0) return { action: "wait-stop", reason: "正在等待停止生成操作生效", retryAfterMs: graceRemaining };
        return { action: "refresh", reason: "请求停止后仍处于生成状态" };
      }
    }

    if (!generating || started <= 0) return { action: "none", reason: "当前没有活动的生成任务" };
    if (timestamp - started >= Math.max(0, finite(absoluteLimitMs, 30 * 60 * 1000))) {
      return { action: "stop", reason: "单次生成已超过绝对时间上限", absolute: true };
    }
    if (timestamp - progress >= Math.max(0, finite(hardStallMs, 10 * 60 * 1000))) {
      return { action: "stop", reason: "生成在硬卡顿时限内没有可观察进展", absolute: false };
    }
    if (timestamp - progress >= Math.max(0, finite(softStallMs, 5 * 60 * 1000))) {
      return { action: "warn", reason: "生成长时间没有可观察进展" };
    }
    return { action: "none", reason: "生成状态仍在监控允许范围内" };
  }

  function responseRecoveryAnchor({ workflow = {}, lastGenerationAt = 0 } = {}) {
    const refreshAt = Math.max(0, finite(workflow?.responseStartRefreshAt, 0));
    const generationEndedAt = workflow?.sawGeneration ? Math.max(0, finite(lastGenerationAt, 0)) : 0;
    return Math.max(
      0,
      finite(workflow?.lastPromptAt, 0),
      generationEndedAt,
      finite(workflow?.responseActivityAt, 0),
      refreshAt
    );
  }

  function liveCountdowns({
    settings = {},
    workflow = {},
    runtime = {},
    generating = false,
    lastGenerationAt = 0,
    lastHeartbeatAt = 0,
    hidden = false,
    now = Date.now()
  } = {}) {
    const timestamp = finite(now, Date.now());
    const timers = [];
    const add = (id, label, dueAt, phase = "", detail = "") => {
      const due = Math.max(0, finite(dueAt, 0));
      if (!due) return;
      timers.push({
        id,
        label,
        phase,
        detail,
        dueAt: due,
        remainingMs: Math.max(0, due - timestamp)
      });
    };

    const watchdog = runtime?.generationWatchdog || {};
    const watchdogEnabled = Boolean(settings.generationWatchdogEnabled);
    if (watchdogEnabled
      && workflow?.status === "running"
      && workflow?.awaitingResponse
      && !generating
      && !workflow?.responseCandidateFingerprint
      && finite(workflow?.lastPromptAt, 0) > 0) {
      const timeoutMs = Math.max(0, finite(settings.generationWatchdogResponseStartMin, 3)) * 60 * 1000;
      const responseActivityAt = Math.max(0, finite(workflow?.responseActivityAt, 0));
      const refreshAt = Math.max(0, finite(workflow?.responseStartRefreshAt, 0));
      const anchor = responseRecoveryAnchor({ workflow, lastGenerationAt });
      add(
        "response-start",
        "回答恢复",
        anchor + timeoutMs,
        refreshAt ? "刷新后" : "首次等待",
        refreshAt
          ? "从刷新后的最近页面进展重新计时，到期后仍无有效回答则发送恢复提示"
          : (responseActivityAt > 0 ? "从最近页面进展重新计时，到期后仍无有效回答则刷新一次" : "到期后仍无有效回答则刷新一次")
      );
    }

    const stopRequestedAt = Math.max(0, finite(watchdog.stopRequestedAt, 0));
    if (generating && stopRequestedAt > 0) {
      add(
        "watchdog-stop-grace",
        "停止生效",
        stopRequestedAt + Math.max(0, finite(settings.generationWatchdogStopGraceSec, 30)) * 1000,
        "等待 Stop",
        "到期后仍在生成则刷新当前对话"
      );
    } else if (generating && watchdogEnabled) {
      const startedAt = Math.max(0, finite(watchdog.startedAt, 0));
      const progressAt = Math.max(startedAt, finite(watchdog.lastProgressAt, startedAt));
      if (progressAt > 0) {
        add(
          "watchdog-soft",
          "无进展告警",
          progressAt + Math.max(0, finite(settings.generationWatchdogSoftStallMin, 5)) * 60 * 1000,
          "生成监控",
          "到期后记录卡顿告警"
        );
        add(
          "watchdog-hard",
          "自动停止",
          progressAt + Math.max(0, finite(settings.generationWatchdogHardStallMin, 10)) * 60 * 1000,
          "生成监控",
          "到期后请求 Stop"
        );
      }
      if (startedAt > 0) {
        add(
          "watchdog-absolute",
          "生成上限",
          startedAt + Math.max(0, finite(settings.generationWatchdogAbsoluteLimitMin, 30)) * 60 * 1000,
          "绝对上限",
          "达到上限后请求 Stop"
        );
      }
    }

    if (settings.queueAutoRunEnabled) {
      add("queue", "队列检查", runtime?.nextQueueAt, "自动队列", "下一次允许自动发送的时间点");
    }
    if (settings.autoRefreshEnabled) {
      add("refresh", "定时刷新", runtime?.nextRefreshAt, "空闲刷新", "仅在安全且空闲时执行");
    }
    if (workflow?.status === "running") {
      add("runner-lease", "执行租约", workflow?.runnerExpiresAt, "自动续租", "当前标签页的工作流执行权");
    }
    const heartbeatAt = Math.max(0, finite(lastHeartbeatAt, 0));
    if (heartbeatAt > 0) {
      add("heartbeat", "下次心跳", heartbeatAt + heartbeatIntervalMs({ hidden }), "标签页存活", "正常运行时会定期刷新");
      add("heartbeat-stale", "心跳失联恢复", heartbeatAt + heartbeatStaleMs({ hidden }), "强恢复阈值", "超过阈值后后台监督器会尝试恢复标签页");
    }
    return timers;
  }

  return Object.freeze({
    VISIBLE_WORKFLOW_POLL_MS,
    HIDDEN_ACTIVE_WORKFLOW_POLL_MS,
    HIDDEN_IDLE_WORKFLOW_POLL_MS,
    HYDRATION_QUIET_MS,
    INPUT_SETTLE_MS,
    POST_GENERATION_HOLD_MS,
    MARKER_RESPONSE_STABLE_MS,
    MISSING_MARKER_RESPONSE_STABLE_MS,
    REFRESH_QUIET_MS,
    WATCHDOG_RECOVERY_SETTLE_MS,
    scanDelay,
    routeDelay,
    mutationDelay,
    workflowPollDelay,
    heartbeatIntervalMs,
    heartbeatStaleMs,
    responseStableMs,
    hydrationCandidate,
    inputSafety,
    nextGenerationHoldUntil,
    canAutomaticRefresh,
    shouldProtectTab,
    generationWatchdogDecision,
    responseRecoveryAnchor,
    liveCountdowns
  });
});
