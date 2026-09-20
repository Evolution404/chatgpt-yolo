const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("the tab supervisor is alarm-driven, staggered, and may reload only protected workflow tabs without activating them", () => {
  const source = read("tab-supervisor.js");
  assert.match(source, /periodInMinutes: 1/);
  assert.match(source, /MAX_INJECTIONS_PER_SWEEP = 2/);
  assert.match(source, /tab\.discarded/);
  assert.match(source, /tab\.frozen/);
  assert.match(source, /tab\.status !== "loading"/);
  assert.match(source, /recoverProtectedTab/);
  assert.match(source, /chrome\.tabs\.reload/);
  assert.match(source, /if \(!health\?\.ok && protect\)/);
  assert.doesNotMatch(source, /tabs\.discard|active: true/);
});

test("tab supervisor reinjection uses the exact manifest content-script stack and order", () => {
  const supervisor = read("tab-supervisor.js");
  const manifest = JSON.parse(read("manifest.json"));
  const match = supervisor.match(/const SCRIPT_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "tab-supervisor SCRIPT_FILES must be statically inspectable");
  const injected = JSON.parse(`[${match[1]}]`);
  assert.deepEqual(injected, manifest.content_scripts[0].js);
  assert.ok(injected.indexOf("shared.js") < injected.indexOf("commands.js"));
  assert.ok(injected.indexOf("commands.js") < injected.indexOf("rollover.js"));
});

test("active workflow protection stays internal instead of cluttering the settings page", () => {
  const source = read("tab-supervisor.js");
  assert.match(source, /protectActiveWorkflowTabs/);
  assert.match(source, /autoDiscardable: desiredAutoDiscardable/);
  assert.doesNotMatch(read("options.html"), /data-setting="protectActiveWorkflowTabs"/);
});

test("workflow request recovery uses one absolute deadline and bounded refresh retries", () => {
  const runtime = read("command-runtime.js");
  const handleStart = runtime.indexOf("async function handleWorkflow");
  const handleEnd = runtime.indexOf("async function tick", handleStart);
  const body = runtime.slice(handleStart, handleEnd);
  assert.match(body, /Lifecycle\.workflowRecoveryDecision/);
  assert.match(body, /refreshWorkflowResponse/);
  assert.match(body, /queueWorkflowRecovery/);
  assert.doesNotMatch(body, /responseActivityAt|responseStartRefreshAt|generationWatchdogResponseStartMin/);
});

test("workflow refresh is independent of normal automation and may reload a still-generating request", () => {
  const content = read("content.js");
  const manualAction = content.slice(
    content.indexOf("async function runManualAction"),
    content.indexOf("async function resetRuntime")
  );
  assert.match(manualAction, /action === "workflow-recovery-refresh"/);
  assert.match(manualAction, /allowDisabled: true/);
  const refresh = content.slice(
    content.indexOf("async function refreshPage"),
    content.indexOf("function errorSignature")
  );
  assert.match(refresh, /workflowRecoveryRefresh/);
  assert.match(refresh, /generating && !workflowRecoveryRefresh/);
});

test("workflow refresh releases internal ownership before reloading the page", () => {
  const runtime = read("command-runtime.js");
  const start = runtime.indexOf("async function refreshWorkflowResponse");
  const end = runtime.indexOf("async function handleWorkflow", start);
  const body = runtime.slice(start, end);
  const release = body.indexOf("await releaseWorkflow()");
  const refresh = body.indexOf('api.runAction("workflow-recovery-refresh")');
  assert.ok(release >= 0 && refresh > release);
});

test("settled answers without a marker enter the same simple refresh recovery path", () => {
  const runtime = read("command-runtime.js");
  const handleStart = runtime.indexOf("async function handleWorkflow");
  const handleEnd = runtime.indexOf("async function tick", handleStart);
  const body = runtime.slice(handleStart, handleEnd);
  assert.match(body, /outcome !== "missing"/);
  assert.match(body, /Lifecycle.MISSING_MARKER_REFRESH_MS/);
  assert.match(body, /refreshWorkflowResponse\(workflow, api, "回答不完整"\)/);
  assert.doesNotMatch(body, /3 * 60 * 60/);
});

test("renderer freeze recovery uses persisted heartbeats instead of waiting only on renderer replies", () => {
  const content = read("content.js");
  const background = read("background.js");
  const supervisor = read("tab-supervisor.js");
  assert.match(content, /YOLO_TAB_HEARTBEAT/);
  assert.match(content, /restartHeartbeatTimer/);
  assert.match(background, /TAB_HEARTBEAT_SESSION_KEY/);
  assert.match(background, /chrome\.storage\?\.session|sessionAreaCall/);
  assert.match(supervisor, /readHeartbeat/);
  assert.match(supervisor, /heartbeatIsStale/);
  assert.match(supervisor, /content heartbeat is stale/);
  assert.doesNotMatch(content, /setInterval\([^\n]*Heartbeat/i);
});

test("content and command runtimes use adaptive one-shot timers instead of hot intervals", () => {
  const content = read("content.js");
  const runtime = read("command-runtime.js");
  assert.match(content, /Lifecycle\.scanDelay/);
  assert.match(content, /Lifecycle\.mutationDelay/);
  assert.match(content, /Lifecycle\.routeDelay/);
  assert.doesNotMatch(content, /setInterval\(runCycle|setInterval\(handleRouteChange/);
  assert.match(runtime, /Lifecycle\.workflowPollDelay/);
  assert.doesNotMatch(runtime, /setInterval\(tick/);
});

test("long turns cannot be refreshed or interpreted before hydration and quiet completion", () => {
  const content = read("content.js");
  const runtime = read("command-runtime.js");
  assert.match(content, /probeHydration/);
  assert.match(content, /Lifecycle\.canAutomaticRefresh/);
  assert.match(content, /workflowActive: workflow\.active/);
  assert.match(runtime, /if \(!apiState\.hydrated\) return false/);
  assert.match(runtime, /Lifecycle\.responseStableMs\(outcome\)/);
  assert.match(runtime, /apiState\.lastDomActivityAt/);
});

test("background supervision adds only the narrow alarms permission", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["alarms", "scripting", "storage"]);
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.permissions.includes("activeTab"), false);
});

test("workflow ownership survives hidden-tab timer throttling", () => {
  const background = read("background.js");
  assert.match(background, /WORKFLOW_LEASE_MS = 2 \* 60 \* 1000/);
  assert.match(background, /WORKFLOW_RENEW_WINDOW_MS = 30 \* 1000/);
});

test("the workflow queue can send its own pending prompt while awaiting responses still block input", () => {
  const content = read("content.js");
  const safeStart = content.indexOf("function safeForInput");
  const safeEnd = content.indexOf("function updateGenerationState", safeStart);
  const block = content.slice(safeStart, safeEnd);
  assert.match(block, /workflow\.awaitingResponse/);
  assert.doesNotMatch(block, /workflow\.pendingItemId/);
});

test("same-route hydration loss fails closed and long generation persistence is throttled", () => {
  const content = read("content.js");
  assert.match(content, /document\.readyState === "loading" \|\| !composerPresent/);
  assert.match(content, /state\.hydrated = false/);
  assert.match(content, /timestamp - state\.lastGenerationPersistAt >= 30_000/);
});

test("adaptive loops self-heal and the command UI has no independent position interval", () => {
  const content = read("content.js");
  const runtime = read("command-runtime.js");
  const ui = read("command-ui.js");
  assert.match(content, /finally \{\s*restartScanTimer\(\)/);
  assert.match(content, /finally \{\s*restartRouteTimer\(\)/);
  assert.match(runtime, /finally \{\s*schedulePoll\(\)/);
  assert.doesNotMatch(ui, /setInterval\(position/);
});

test("tab discard protection is derived from durable settings and workflow state", () => {
  const supervisor = read("tab-supervisor.js");
  assert.match(supervisor, /async function readProtection/);
  assert.match(supervisor, /Config\.workflowKey\(pageId\)/);
  assert.match(supervisor, /Config\.mergeSettings/);
  assert.doesNotMatch(supervisor, /health\.workflow\?\.status/);
});

test("the lifecycle release increments the content-script version", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const pkg = JSON.parse(read("package.json"));
  assert.equal(manifest.version, "1.2.0");
  assert.equal(pkg.version, "1.2.0");
  assert.match(read("config.js"), /const VERSION = "1\.2\.0"/);
});
