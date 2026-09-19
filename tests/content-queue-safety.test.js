const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

test("queue handling uses granular readiness reasons and timed wakeups", () => {
  assert.match(source, /function checkSafeForInput\(workflow = workflowHealth\(\)\)/);
  assert.match(source, /Lifecycle\.inputSafety\(/);
  assert.match(source, /scheduleInputRetry\(safety, automatic\)/);
  assert.match(source, /pendingManualQueueRetry && await handleQueue\(false\)/);
  assert.doesNotMatch(source, /if \(!automatic && \(!state\.loaded \|\| !routeIsCurrent\(\)\)\) return false/);
  assert.match(source, /if \(!automatic && !state\.loaded\) return false/);
  assert.doesNotMatch(
    source,
    /if \(!safeForInput\(\)\) \{\s*if \(!automatic\) await setBlocked\("queue\.composer_busy"/
  );
});

test("generation activity does not create a rolling sixty-second input hold", () => {
  assert.match(source, /Lifecycle\.nextGenerationHoldUntil\(/);
  assert.doesNotMatch(source, /generationHoldUntil\s*=.*60_000/);
  assert.doesNotMatch(source, /generationActive\).*generationHoldUntil.*60_000/);
});

test("queue wake scheduling keeps the earliest requested wake", () => {
  assert.match(source, /state\.scanQueued && state\.scanWakeAt <= wakeAt/);
  assert.match(source, /window\.clearTimeout\(state\.scanWakeTimer\)/);
});

test("stuck generation watchdog never replays the original prompt", () => {
  const start = source.indexOf("async function handleGenerationWatchdog");
  const end = source.indexOf("function pruneApprovalSignatures", start);
  const handler = source.slice(start, end);
  assert.match(handler, /Lifecycle\.generationWatchdogDecision/);
  assert.match(handler, /Platforms\.stopGeneration/);
  assert.match(handler, /recoverStalledGeneration/);
  assert.match(handler, /sendContinue\("stuck generation watchdog"/);
  assert.doesNotMatch(handler, /writeAndSubmit/);
  assert.doesNotMatch(handler, /lastUserText/);
});

test("watchdog refresh may override generation only after a persisted Stop request grace", () => {
  const start = source.indexOf("async function refreshPage");
  const end = source.indexOf("function errorSignature", start);
  const handler = source.slice(start, end);
  assert.match(handler, /watchdogForceRefresh/);
  assert.match(handler, /generationWatchdog\.stopRequestedAt/);
  assert.match(handler, /generationWatchdogStopGraceSec/);
  assert.match(handler, /generating && !watchdogForceRefresh/);
  assert.match(handler, /action === "watchdog"[\s\S]{0,180}generationWatchdogStopGraceSec/);
});
