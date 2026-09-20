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
  const MISSING_MARKER_REFRESH_MS = 15_000;
  const MISSING_MARKER_RESPONSE_STABLE_MS = MISSING_MARKER_REFRESH_MS;
  const REFRESH_QUIET_MS = 60_000;
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

  function workflowRecoveryDecision({ settings = {}, workflow = {}, now = Date.now() } = {}) {
    if (workflow?.status !== "running" || !workflow?.awaitingResponse) {
      return { action: "none", reason: "当前工作流不在等待回答" };
    }

    const timestamp = finite(now, Date.now());
    const maxRefreshes = Math.max(1, Math.round(finite(settings.workflowRefreshRetries, 3)));
    const refreshCount = Math.max(0, Math.round(finite(workflow.recoveryRefreshCount, 0)));

    if (refreshCount > 0) {
      const refreshAt = Math.max(0, finite(workflow.recoveryRefreshAt, 0));
      const waitMs = Math.max(5, finite(settings.workflowRefreshWaitSec, 15)) * 1000;
      const remainingMs = Math.max(0, refreshAt + waitMs - timestamp);
      if (remainingMs > 0) {
        return { action: "wait", reason: "等待刷新后的页面重新加载", remainingMs };
      }
      if (refreshCount < maxRefreshes) {
        return { action: "refresh", reason: "刷新后仍未取得完整回答", refreshCount, maxRefreshes };
      }
      return { action: "recover", reason: "刷新重试已用尽", refreshCount, maxRefreshes };
    }

    const lastPromptAt = Math.max(0, finite(workflow.lastPromptAt, 0));
    if (!lastPromptAt) return { action: "wait", reason: "等待工作流请求发送", remainingMs: 0 };
    const timeoutMs = Math.max(1, finite(settings.workflowRequestTimeoutMin, 27)) * 60 * 1000;
    const remainingMs = Math.max(0, lastPromptAt + timeoutMs - timestamp);
    if (remainingMs > 0) return { action: "wait", reason: "等待请求绝对超时", remainingMs };
    return { action: "refresh", reason: "单次请求已达到最长等待时间", refreshCount: 0, maxRefreshes };
  }


  function liveCountdowns({
    settings = {},
    workflow = {},
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

    if (workflow?.status === "running" && workflow?.awaitingResponse) {
      const refreshCount = Math.max(0, Math.round(finite(workflow?.recoveryRefreshCount, 0)));
      const maxRefreshes = Math.max(1, Math.round(finite(settings.workflowRefreshRetries, 3)));
      if (refreshCount > 0 && finite(workflow?.recoveryRefreshAt, 0) > 0) {
        add(
          "workflow-recovery",
          "刷新后检查",
          finite(workflow.recoveryRefreshAt, 0) + Math.max(5, finite(settings.workflowRefreshWaitSec, 15)) * 1000,
          `${Math.min(refreshCount, maxRefreshes)}/${maxRefreshes}`,
          refreshCount >= maxRefreshes ? "仍无结果则发送恢复消息" : "仍无结果则再次刷新"
        );
      } else if (finite(workflow?.lastPromptAt, 0) > 0) {
        add(
          "workflow-timeout",
          "请求超时",
          finite(workflow.lastPromptAt, 0) + Math.max(1, finite(settings.workflowRequestTimeoutMin, 27)) * 60 * 1000,
          "等待最终回答",
          "到期仍没有可用最终回答则刷新页面"
        );
      }
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
    MISSING_MARKER_REFRESH_MS,
    MISSING_MARKER_RESPONSE_STABLE_MS,
    REFRESH_QUIET_MS,
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
    workflowRecoveryDecision,
    liveCountdowns
  });
});
