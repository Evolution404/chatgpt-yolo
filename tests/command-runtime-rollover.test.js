const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "command-runtime.js"), "utf8");

test("manual rollover is a first-class slash control", () => {
  assert.match(source, /if \(name === "rollover"\) return startRollover\(args\)/);
  assert.match(source, /type: "YOLO_ROLLOVER_START"/);
  assert.match(source, /baselineAssistantFingerprint: latestAssistantFingerprint\(\)/);
});

test("rollover source waits for exact queue completion before accepting a handoff", () => {
  const start = source.indexOf("async function handleRolloverHandoffQueue");
  const end = source.indexOf("async function handleRolloverHandoffResponse", start);
  const body = source.slice(start, end);
  assert.match(body, /completion\.itemId === transaction\.pendingItemId && completion\.sourceId === transaction\.id/);
  assert.match(body, /phase: "awaiting_handoff"/);
  assert.match(body, /rollover\.handoff_prompt_removed/);
});

test("bootstrap persists submitting intent before the only transient send", () => {
  const start = source.indexOf("async function handleRolloverBootstrap");
  const end = source.indexOf("async function handleRollover()", start);
  const body = source.slice(start, end);
  const persist = body.indexOf("await writeRollover(submitting)");
  const submit = body.indexOf("submitTransientBootstrap");
  assert.ok(persist >= 0 && submit > persist);
  assert.match(body, /rollover\.bootstrap_unknown/);
  assert.match(body, /rollover\.route_conflict/);
  assert.match(body, /rollover\.target_route_lost/);
});

test("rollover fails closed if the tab returns to the source after bootstrap starts", () => {
  const start = source.indexOf("async function handleRollover()");
  const end = source.indexOf("async function executeCommandUnlocked", start);
  const body = source.slice(start, end);
  assert.match(body, /\["bootstrap_submitting", "bootstrap_sent"\]\.includes\(transaction\.phase\)/);
  assert.match(body, /rollover\.source_route_returned/);
});

test("successor workflow adoption binds the bootstrap prompt as the owned user turn", () => {
  const start = source.indexOf("async function adoptRolloverWorkflow");
  const end = source.indexOf("async function handleRolloverBootstrap", start);
  const body = source.slice(start, end);
  assert.match(body, /awaitingResponse: true/);
  assert.match(body, /promptFingerprint: transaction\.bootstrapPromptFingerprint/);
  assert.match(body, /iteration: 0/);
  assert.match(body, /taskId: source\.taskId/);
  assert.match(body, /conversationIndex: source\.conversationIndex \+ 1/);
  assert.match(body, /totalIterations: source\.totalIterations/);
  assert.match(body, /phase: "bound"/);
  assert.match(body, /clearRolloverTokenFromLocation\(\)/);
});

test("rollover recovery token is removed only after successful durable binding", () => {
  assert.match(source, /function clearRolloverTokenFromLocation\(\)/);
  assert.match(source, /url\.searchParams\.delete\("yolo-rollover"\)/);
  assert.match(source, /if \(bound\) clearRolloverTokenFromLocation\(\)/);
});

test("new workflows snapshot rollover policy from settings", () => {
  const start = source.indexOf("async function startWorkflow(kind, args)");
  const end = source.indexOf("async function runOneShot", start);
  const body = source.slice(start, end);
  assert.match(body, /rolloverPolicy:/);
  assert.match(body, /enabled: settings\.autoRolloverEnabled/);
  assert.match(body, /afterTurns: settings\.autoRolloverAfterTurns/);
  assert.match(body, /maxConversations: settings\.autoRolloverMaxConversations/);
});

test("workflow response rollover replaces continuation enqueue at the safe boundary", () => {
  const start = source.indexOf("async function processResponse()");
  const end = source.indexOf("async function handlePendingWorkflowItem", start);
  const body = source.slice(start, end);
  const explicit = body.indexOf('decision.action === "rollover"');
  const threshold = body.indexOf("Rollover.autoRolloverBoundary(state.workflow)");
  const continuation = body.indexOf('Commands.workflowPrompt(state.workflow, "continue")');
  assert.ok(explicit >= 0 && explicit < continuation);
  assert.ok(threshold >= 0 && threshold < continuation);
  assert.match(body, /startAutomaticRollover/);
});

test("automatic rollover asks background to consume the response and enforces the conversation cap", () => {
  const start = source.indexOf("async function startAutomaticRollover");
  const end = source.indexOf("async function handleRolloverHandoffQueue", start);
  const body = source.slice(start, end);
  assert.match(body, /current\.conversationIndex >= current\.autoRolloverMaxConversations/);
  assert.match(body, /consumeWorkflowResponse: true/);
  assert.match(body, /workflowExpectedRevision: current\.revision/);
  assert.match(body, /sourceWorkflow: current/);
});
