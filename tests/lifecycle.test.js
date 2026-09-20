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

test("missing workflow markers require a long quiet window", () => {
  assert.equal(Lifecycle.responseStableMs("continue"), 15000);
  assert.equal(Lifecycle.responseStableMs("done"), 15000);
  assert.equal(Lifecycle.responseStableMs("missing"), 3 * 60 * 60 * 1000);
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

test("generation watchdog distinguishes progress, soft stall, hard stall, stop grace, and recovery", () => {
  const base = {
    enabled: true,
    generating: true,
    startedAt: 1_000,
    lastProgressAt: 9_000,
    now: 10_000,
    softStallMs: 5_000,
    hardStallMs: 10_000,
    absoluteLimitMs: 30_000,
    stopGraceMs: 3_000,
    recoverySettleMs: 2_000
  };
  assert.equal(Lifecycle.generationWatchdogDecision(base).action, "none");
  assert.equal(Lifecycle.generationWatchdogDecision({ ...base, lastProgressAt: 4_000 }).action, "warn");
  assert.equal(Lifecycle.generationWatchdogDecision({ ...base, lastProgressAt: 0, now: 12_000 }).action, "stop");
  assert.equal(Lifecycle.generationWatchdogDecision({ ...base, startedAt: 1_000, lastProgressAt: 11_000, now: 31_000 }).action, "stop");

  const stopping = { ...base, stopRequestedAt: 10_000, now: 12_000 };
  assert.equal(Lifecycle.generationWatchdogDecision(stopping).action, "wait-stop");
  assert.equal(Lifecycle.generationWatchdogDecision({ ...stopping, now: 14_000 }).action, "refresh");
  assert.equal(Lifecycle.generationWatchdogDecision({ ...stopping, generating: false, stoppedAt: 13_000, now: 14_000 }).action, "wait-recovery");
  assert.equal(Lifecycle.generationWatchdogDecision({ ...stopping, generating: false, stoppedAt: 13_000, now: 16_000 }).action, "resume");
});

test("generation watchdog is inert when disabled or idle", () => {
  assert.equal(Lifecycle.generationWatchdogDecision({ enabled: false, generating: true, startedAt: 1, lastProgressAt: 1, now: 999999 }).action, "none");
  assert.equal(Lifecycle.generationWatchdogDecision({ enabled: true, generating: false, startedAt: 1, lastProgressAt: 1, now: 999999 }).action, "none");
});

test("live status countdowns expose response recovery and watchdog deadlines", () => {
  const settings = {
    generationWatchdogEnabled: true,
    generationWatchdogResponseStartMin: 3,
    generationWatchdogSoftStallMin: 5,
    generationWatchdogHardStallMin: 10,
    generationWatchdogAbsoluteLimitMin: 30,
    generationWatchdogStopGraceSec: 30,
    queueAutoRunEnabled: true,
    autoRefreshEnabled: true
  };
  const workflow = {
    status: "running",
    awaitingResponse: true,
    sawGeneration: true,
    responseCandidateFingerprint: "",
    responseStartRefreshAt: 0,
    responseActivityAt: 45_000,
    lastPromptAt: 1_000,
    runnerExpiresAt: 90_000
  };
  const runtime = {
    generationWatchdog: {
      startedAt: 10_000,
      lastProgressAt: 20_000,
      stopRequestedAt: 0,
      stoppedAt: 0
    },
    nextQueueAt: 70_000,
    nextRefreshAt: 80_000
  };

  const idle = Lifecycle.liveCountdowns({
    settings,
    workflow,
    runtime,
    generating: false,
    lastGenerationAt: 40_000,
    lastHeartbeatAt: 45_000,
    hidden: false,
    now: 50_000
  });
  const response = idle.find((entry) => entry.id === "response-start");
  assert.equal(response.dueAt, 225_000);
  assert.equal(response.remainingMs, 175_000);
  assert.equal(response.label, "回答恢复");
  assert.equal(idle.find((entry) => entry.id === "queue").remainingMs, 20_000);
  assert.equal(idle.find((entry) => entry.id === "refresh").remainingMs, 30_000);
  assert.equal(idle.find((entry) => entry.id === "runner-lease").remainingMs, 40_000);
  assert.equal(idle.find((entry) => entry.id === "heartbeat").remainingMs, 15_000);
  assert.equal(idle.find((entry) => entry.id === "heartbeat-stale").remainingMs, 55_000);

  const generating = Lifecycle.liveCountdowns({
    settings,
    workflow,
    runtime,
    generating: true,
    lastGenerationAt: 40_000,
    now: 50_000
  });
  assert.equal(generating.find((entry) => entry.id === "watchdog-soft").dueAt, 320_000);
  assert.equal(generating.find((entry) => entry.id === "watchdog-hard").dueAt, 620_000);
  assert.equal(generating.find((entry) => entry.id === "watchdog-absolute").dueAt, 1_810_000);
  assert.equal(generating.some((entry) => entry.id === "response-start"), false);
});

test("response recovery anchor follows the latest real response progress", () => {
  const workflow = {
    lastPromptAt: 10_000,
    sawGeneration: true,
    responseActivityAt: 45_000,
    responseStartRefreshAt: 0
  };
  assert.equal(
    Lifecycle.responseRecoveryAnchor({ workflow, lastGenerationAt: 40_000 }),
    45_000
  );
  assert.equal(
    Lifecycle.responseRecoveryAnchor({
      workflow: { ...workflow, responseStartRefreshAt: 60_000 },
      lastGenerationAt: 70_000
    }),
    70_000
  );
});

test("live status countdowns show stop grace and second response timeout phase", () => {
  const settings = {
    generationWatchdogEnabled: true,
    generationWatchdogResponseStartMin: 3,
    generationWatchdogSoftStallMin: 5,
    generationWatchdogHardStallMin: 10,
    generationWatchdogAbsoluteLimitMin: 30,
    generationWatchdogStopGraceSec: 30,
    queueAutoRunEnabled: false,
    autoRefreshEnabled: false
  };
  const workflow = {
    status: "running",
    awaitingResponse: true,
    sawGeneration: true,
    responseCandidateFingerprint: "",
    responseStartRefreshAt: 100_000,
    responseActivityAt: 125_000,
    lastPromptAt: 1_000,
    runnerExpiresAt: 0
  };
  const runtime = {
    generationWatchdog: {
      startedAt: 1_000,
      lastProgressAt: 1_000,
      stopRequestedAt: 120_000,
      stoppedAt: 0
    }
  };

  const timers = Lifecycle.liveCountdowns({
    settings,
    workflow,
    runtime,
    generating: true,
    lastGenerationAt: 90_000,
    now: 130_000
  });
  assert.equal(timers.find((entry) => entry.id === "watchdog-stop-grace").remainingMs, 20_000);
  assert.equal(timers.some((entry) => entry.id === "watchdog-soft"), false);

  const postRefresh = Lifecycle.liveCountdowns({
    settings,
    workflow,
    runtime: { generationWatchdog: {} },
    generating: false,
    lastGenerationAt: 90_000,
    now: 130_000
  });
  const response = postRefresh.find((entry) => entry.id === "response-start");
  assert.equal(response.phase, "刷新后");
  assert.equal(response.dueAt, 305_000);
  assert.match(response.detail, /恢复提示/);
});
