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

test("content engine no longer owns a separate generation-watchdog state machine", () => {
  assert.doesNotMatch(source, /handleGenerationWatchdog|generationWatchdogDecision|generationWatchdogSoftStallMin/);
});

test("workflow recovery refresh may reload even while ChatGPT still appears to be generating", () => {
  const start = source.indexOf("async function refreshPage");
  const end = source.indexOf("function errorSignature", start);
  const handler = source.slice(start, end);
  assert.match(handler, /workflowRecoveryRefresh/);
  assert.match(handler, /generating && !workflowRecoveryRefresh/);
  assert.match(source, /action === "workflow-recovery-refresh"/);
});
