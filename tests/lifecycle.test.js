const test = require("node:test");
const assert = require("node:assert/strict");
const Lifecycle = require("../lifecycle.js");

test("hidden tabs back off scans and workflow polling", () => {
  assert.equal(Lifecycle.scanDelay({ hidden: false, configuredSec: 3 }), 3000);
  assert.equal(Lifecycle.scanDelay({ hidden: true, generating: false, configuredSec: 3 }), 5000);
  assert.equal(Lifecycle.scanDelay({ hidden: true, generating: true, configuredSec: 3 }), 10000);
  assert.equal(Lifecycle.workflowPollDelay({ hidden: false, workflowActive: true }), 750);
  assert.equal(Lifecycle.workflowPollDelay({ hidden: true, workflowActive: true }), 5000);
  assert.equal(Lifecycle.workflowPollDelay({ hidden: true, workflowActive: false }), 15000);
});

test("heartbeat cadence and stale thresholds match foreground/background supervision", () => {
  assert.equal(Lifecycle.heartbeatIntervalMs({ hidden: false }), 20_000);
  assert.equal(Lifecycle.heartbeatIntervalMs({ hidden: true }), 45_000);
  assert.equal(Lifecycle.heartbeatStaleMs({ hidden: false }), 60_000);
  assert.equal(Lifecycle.heartbeatStaleMs({ hidden: true }), 150_000);
});

test("hydration waits for a real composer and a quiet DOM", () => {
  assert.equal(Lifecycle.hydrationCandidate({ documentReadyState: "loading", composerPresent: true, lastDomActivityAt: 0, now: 5000 }), false);
  assert.equal(Lifecycle.hydrationCandidate({ documentReadyState: "complete", composerPresent: false, lastDomActivityAt: 0, now: 5000 }), false);
  assert.equal(Lifecycle.hydrationCandidate({ documentReadyState: "complete", composerPresent: true, lastDomActivityAt: 4500, now: 5000 }), false);
  assert.equal(Lifecycle.hydrationCandidate({ documentReadyState: "complete", composerPresent: true, lastDomActivityAt: 3000, now: 5000 }), true);
});

test("missing workflow markers use the short refresh window", () => {
  assert.equal(Lifecycle.responseStableMs("continue"), 15000);
  assert.equal(Lifecycle.responseStableMs("done"), 15000);
  assert.equal(Lifecycle.responseStableMs("missing"), 15000);
});

test("scheduled refresh fails closed around work and recent activity", () => {
  const base = { hydrated: true, workflowActive: false, generating: false, composerBusy: false, lastDomActivityAt: 0, now: 120000 };
  assert.equal(Lifecycle.canAutomaticRefresh(base), true);
  assert.equal(Lifecycle.canAutomaticRefresh({ ...base, workflowActive: true }), false);
  assert.equal(Lifecycle.canAutomaticRefresh({ ...base, generating: true }), false);
  assert.equal(Lifecycle.canAutomaticRefresh({ ...base, composerBusy: true }), false);
  assert.equal(Lifecycle.canAutomaticRefresh({ ...base, lastDomActivityAt: 90000 }), false);
});

test("only explicitly enabled running workflows are protected from discard", () => {
  assert.equal(Lifecycle.shouldProtectTab({ enabled: true, workflowStatus: "running" }), true);
  assert.equal(Lifecycle.shouldProtectTab({ enabled: false, workflowStatus: "running" }), false);
  assert.equal(Lifecycle.shouldProtectTab({ enabled: true, workflowStatus: "completed" }), false);
});


test("input safety reports the actual blocker instead of a generic draft error", () => {
  const base = {
    routeCurrent: true,
    durablePage: true,
    composerPresent: true,
    hydrated: true,
    workflowAwaitingResponse: false,
    generating: false,
    generationHoldUntil: 0,
    lastDomActivityAt: 0,
    composerBusy: false,
    now: 10_000
  };

  assert.equal(Lifecycle.inputSafety({ ...base, routeCurrent: false }).code, "route.not_current");
  assert.equal(Lifecycle.inputSafety({ ...base, durablePage: false }).code, "route.invalid");
  assert.equal(Lifecycle.inputSafety({ ...base, composerPresent: false }).code, "queue.composer_missing");
  assert.deepEqual(
    Lifecycle.inputSafety({ ...base, hydrated: false, hydrationRetryAfterMs: 700 }),
    {
      safe: false,
      code: "hydration.pending",
      reason: "Page elements are still loading",
      retryAfterMs: 700
    }
  );
  assert.equal(Lifecycle.inputSafety({ ...base, workflowAwaitingResponse: true }).code, "workflow.waiting");
  assert.equal(Lifecycle.inputSafety({ ...base, generating: true }).code, "queue.generating");
  assert.equal(Lifecycle.inputSafety({ ...base, composerBusy: true }).code, "queue.composer_busy");
  assert.deepEqual(Lifecycle.inputSafety(base), {
    safe: true,
    code: "",
    reason: "",
    retryAfterMs: 0
  });
});

test("input safety returns exact retry delays for timed blockers", () => {
  const base = {
    routeCurrent: true,
    durablePage: true,
    composerPresent: true,
    hydrated: true,
    workflowAwaitingResponse: false,
    generating: false,
    composerBusy: false,
    now: 10_000
  };

  const generation = Lifecycle.inputSafety({
    ...base,
    generationHoldUntil: 12_500,
    lastDomActivityAt: 0
  });
  assert.equal(generation.code, "queue.generating_cooldown");
  assert.equal(generation.retryAfterMs, 2_500);
  assert.match(generation.reason, /3s remaining/);

  const dom = Lifecycle.inputSafety({
    ...base,
    generationHoldUntil: 0,
    lastDomActivityAt: 9_500
  });
  assert.equal(dom.code, "queue.dom_cooldown");
  assert.equal(dom.retryAfterMs, 1_000);
});

test("post-generation hold starts on the active-to-idle transition only", () => {
  assert.equal(
    Lifecycle.nextGenerationHoldUntil({
      wasGenerating: false,
      generating: true,
      currentHoldUntil: 0,
      now: 10_000
    }),
    0
  );
  assert.equal(
    Lifecycle.nextGenerationHoldUntil({
      wasGenerating: true,
      generating: false,
      currentHoldUntil: 0,
      now: 10_000
    }),
    25_000
  );
});

test("live status countdown shows the absolute workflow request deadline", () => {
  const settings = {
    workflowRequestTimeoutMin: 27,
    workflowRefreshRetries: 3,
    workflowRefreshWaitSec: 15
  };
  const workflow = {
    status: "running",
    awaitingResponse: true,
    lastPromptAt: 1_000,
    recoveryRefreshCount: 0,
    recoveryRefreshAt: 0
  };
  const timers = Lifecycle.liveCountdowns({ settings, workflow, now: 61_000 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].id, "workflow-timeout");
  assert.equal(timers[0].dueAt, 1_621_000);
  assert.equal(timers[0].remainingMs, 1_560_000);
  assert.match(timers[0].detail, /刷新页面/);
});

test("live status countdown shows bounded refresh recovery", () => {
  const settings = {
    workflowRequestTimeoutMin: 27,
    workflowRefreshRetries: 3,
    workflowRefreshWaitSec: 15
  };
  const workflow = {
    status: "running",
    awaitingResponse: true,
    lastPromptAt: 1_000,
    recoveryRefreshCount: 2,
    recoveryRefreshAt: 100_000
  };
  const timers = Lifecycle.liveCountdowns({ settings, workflow, now: 105_000 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].id, "workflow-recovery");
  assert.equal(timers[0].remainingMs, 10_000);
  assert.equal(timers[0].phase, "2/3");
  assert.match(timers[0].detail, /再次刷新/);

  const exhausted = Lifecycle.liveCountdowns({
    settings,
    workflow: { ...workflow, recoveryRefreshCount: 3 },
    now: 105_000
  });
  assert.match(exhausted[0].detail, /恢复消息/);
});

test("workflow recovery decision follows one timeout-refresh-recover state machine", () => {
  const settings = {
    workflowRequestTimeoutMin: 27,
    workflowRefreshRetries: 3,
    workflowRefreshWaitSec: 15
  };
  const base = {
    status: "running",
    awaitingResponse: true,
    lastPromptAt: 1_000,
    recoveryRefreshCount: 0,
    recoveryRefreshAt: 0
  };

  assert.deepEqual(
    Lifecycle.workflowRecoveryDecision({ settings, workflow: base, now: 1_620_999 }),
    { action: "wait", reason: "等待请求绝对超时", remainingMs: 1 }
  );
  assert.equal(
    Lifecycle.workflowRecoveryDecision({ settings, workflow: base, now: 1_621_000 }).action,
    "refresh"
  );

  const refreshing = { ...base, recoveryRefreshCount: 2, recoveryRefreshAt: 2_000_000 };
  assert.deepEqual(
    Lifecycle.workflowRecoveryDecision({ settings, workflow: refreshing, now: 2_010_000 }),
    { action: "wait", reason: "等待刷新后的页面重新加载", remainingMs: 5_000 }
  );
  assert.equal(
    Lifecycle.workflowRecoveryDecision({ settings, workflow: refreshing, now: 2_015_000 }).action,
    "refresh"
  );
  assert.equal(
    Lifecycle.workflowRecoveryDecision({
      settings,
      workflow: { ...refreshing, recoveryRefreshCount: 3 },
      now: 2_015_000
    }).action,
    "recover"
  );
  assert.equal(
    Lifecycle.workflowRecoveryDecision({
      settings,
      workflow: { ...base, status: "paused" },
      now: 9_999_999
    }).action,
    "none"
  );
});

test("missing marker refresh delay is short enough to reload a settled partial answer", () => {
  assert.equal(Lifecycle.MISSING_MARKER_REFRESH_MS, 15_000);
});
