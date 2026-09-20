const test = require("node:test");
const assert = require("node:assert/strict");
const Commands = require("../commands.js");

test("browser bootstrap fails closed when shared dependency is missing", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "..", "commands.js"), "utf8");
  const context = { globalThis: undefined };
  context.globalThis = context;
  vm.createContext(context);
  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: "commands.js" }));
  assert.equal(context.YOLOCommands, undefined);
});

test("filters and parses the truthful slash-action catalog", () => {
  assert.equal(Commands.filterCommands("rev")[0].name, "review");
  assert.equal(Commands.parseInvocation("/goal ship the extension").command.name, "goal");
  assert.equal(Commands.parseInvocation("/goal ship the extension").args, "ship the extension");
  assert.equal(Commands.parseInvocation("hello"), null);
  assert.equal(Commands.parseInvocation("/unknown"), null);
  assert.equal(Commands.parseInvocation("/compact"), null);
  assert.equal(Commands.parseInvocation("/queue"), null);
  assert.equal(Commands.parseInvocation("/clear"), null);

  assert.deepEqual(Commands.COMMANDS.map(({ name, kind }) => [name, kind]), [
    ["goal", "workflow"], ["loop", "workflow"],
    ["plan", "prompt"], ["review", "prompt"], ["fix", "prompt"], ["handoff", "prompt"], ["continue", "prompt"],
    ["rollover", "control"],
    ["status", "control"], ["pause", "control"], ["resume", "control"], ["stop", "control"], ["settings", "control"], ["help", "control"]
  ]);
});

test("parses bounded loop iteration counts", () => {
  assert.deepEqual(Commands.parseLoopArgs("7 review and fix"), {
    objective: "review and fix",
    maxIterations: 7
  });
  assert.equal(Commands.parseLoopArgs("99 finish it").maxIterations, Commands.MAX_ITERATIONS);
  assert.equal(Commands.parseLoopArgs("0 finish it").maxIterations, 1);
  assert.equal(Commands.parseLoopArgs("finish it").maxIterations, Commands.DEFAULT_MAX_ITERATIONS);
});

test("creates normalized persistent goal and loop workflows", () => {
  const goal = Commands.startWorkflow("goal", "Ship production", { at: 1000, baselineFingerprint: "old" });
  assert.equal(goal.ok, true);
  assert.equal(goal.workflow.kind, "goal");
  assert.equal(goal.workflow.status, "running");
  assert.equal(goal.workflow.lastAssistantFingerprint, "old");
  assert.equal(goal.workflow.maxIterations, Commands.MAX_ITERATIONS);
  assert.equal(goal.workflow.revision, 0);
  assert.equal(goal.workflow.autoRolloverEnabled, false);
  assert.equal(goal.workflow.conversationIndex, 1);
  assert.ok(goal.workflow.taskId);
  assert.match(Commands.workflowPrompt(goal.workflow, "initial"), /\[YOLO:CONTINUE\]/);

  const loop = Commands.startWorkflow("loop", "4 review again", { at: 1000 });
  assert.equal(loop.workflow.maxIterations, 4);
  assert.equal(loop.workflow.objective, "review again");
  assert.match(Commands.workflowPrompt(loop.workflow, "continue"), /Task iteration 1 of 4/);
});

test("workflow rollover policy is normalized and rollover markers are opt-in", () => {
  const started = Commands.startWorkflow("goal", "Long audit", {
    at: 1000,
    rolloverPolicy: { enabled: true, afterTurns: 9, maxConversations: 6 }
  });
  assert.equal(started.workflow.autoRolloverEnabled, true);
  assert.equal(started.workflow.autoRolloverAfterTurns, 9);
  assert.equal(started.workflow.autoRolloverMaxConversations, 6);
  assert.match(Commands.workflowPrompt(started.workflow, "initial"), /\[YOLO:ROLLOVER\]/);

  const legacy = Commands.startWorkflow("goal", "Short audit", { at: 1000 }).workflow;
  assert.doesNotMatch(Commands.workflowPrompt(legacy, "initial"), /\[YOLO:ROLLOVER\]/);
});

test("workflow response markers are unique, terminal, and case-insensitive", () => {
  assert.equal(Commands.evaluateResponse("done\n[YOLO:DONE]"), "done");
  assert.equal(Commands.evaluateResponse("  [yolo:blocked]  "), "blocked");
  assert.equal(Commands.evaluateResponse("[YOLO:DONE]\nbut actually keep going"), "malformed");
  assert.equal(Commands.evaluateResponse("inline [YOLO:DONE]"), "missing");
  assert.equal(Commands.evaluateResponse("prefix\n[YOLO:DONE]"), "done");
  assert.equal(Commands.evaluateResponse("handoff now\n[YOLO:ROLLOVER]"), "rollover");
  assert.equal(Commands.evaluateResponse("work\n[YOLO:BLOCKED]\nmore\n[YOLO:DONE]"), "malformed");
  assert.equal(Commands.evaluateResponse("no marker"), "missing");
});

test("one-shot commands build concrete prompts", () => {
  assert.match(Commands.oneShotPrompt("plan", "ship it"), /Plan this objective/);
  assert.match(Commands.oneShotPrompt("review", "security"), /adversarial/i);
  assert.match(Commands.oneShotPrompt("fix"), /repair/i);
  assert.match(Commands.oneShotPrompt("handoff", "release state"), /Handoff focus: release state/);
  assert.match(Commands.oneShotPrompt("handoff"), /do not claim that ChatGPT context was compacted/i);
  assert.match(Commands.oneShotPrompt("continue", "fix the tests"), /Continue with this direction: fix the tests/);
  assert.equal(Commands.oneShotPrompt("compact"), "");
  assert.equal(Commands.oneShotPrompt("plan", ""), "");
});

test("workflow normalization fails closed for malformed state", () => {
  assert.equal(Commands.normalizeWorkflow({ kind: "goal", objective: "", status: "running" }).status, "idle");
  const paused = Commands.setWorkflowStatus(Commands.startWorkflow("goal", "test").workflow, "paused", "manual");
  assert.equal(paused.status, "paused");
  assert.equal(paused.pendingItemId, "");
  assert.equal(paused.reason, "manual");
});

test("fingerprints are stable and content-sensitive", () => {
  assert.equal(Commands.fingerprint("hello   world"), Commands.fingerprint("hello world"));
  assert.notEqual(Commands.fingerprint("hello"), Commands.fingerprint("world"));
});

test("workflow revisions and runner leases normalize safely", () => {
  const workflow = Commands.normalizeWorkflow({
    revision: 7,
    kind: "goal",
    objective: "ship",
    status: "running",
    runnerId: "tab-a",
    runnerExpiresAt: 5000,
    promptFingerprint: "prompt"
  }, 1000);
  assert.equal(workflow.revision, 7);
  assert.equal(workflow.runnerId, "tab-a");
  assert.equal(workflow.promptFingerprint, "prompt");

  const paused = Commands.setWorkflowStatus(workflow, "paused", "manual", 2000);
  assert.equal(paused.runnerId, "");
  assert.equal(paused.runnerExpiresAt, 0);
});

test("workflow response decisions enforce ownership, markers, and caps", () => {
  const base = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "ship",
    status: "running",
    maxIterations: 2,
    iteration: 0,
    awaitingResponse: true,
    promptFingerprint: "owned"
  }, 1000);

  assert.equal(Commands.decideWorkflowResponse(base, "work\n[YOLO:CONTINUE]", {
    userFingerprint: "manual",
    at: 1100
  }).action, "paused");

  const continued = Commands.decideWorkflowResponse(base, "work\n[YOLO:CONTINUE]", {
    userFingerprint: "owned",
    at: 1100
  });
  assert.equal(continued.action, "continue");
  assert.equal(continued.workflow.iteration, 1);
  assert.equal(continued.workflow.totalIterations, 1);

  const capped = Commands.decideWorkflowResponse({ ...continued.workflow, awaitingResponse: true }, "more\n[YOLO:CONTINUE]", {
    userFingerprint: "owned",
    at: 1200
  });
  assert.equal(capped.action, "paused");
  assert.match(capped.reason, /安全上限/);

  const done = Commands.decideWorkflowResponse(base, "complete\n[YOLO:DONE]", {
    userFingerprint: "owned",
    at: 1300
  });
  assert.equal(done.action, "completed");
});

test("rollover response requires the workflow rollover policy", () => {
  const disabled = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "ship",
    status: "running",
    awaitingResponse: true,
    promptFingerprint: "owned"
  }, 1000);
  assert.equal(Commands.decideWorkflowResponse(disabled, "handoff\n[YOLO:ROLLOVER]", {
    userFingerprint: "owned",
    at: 1100
  }).action, "paused");

  const enabled = Commands.normalizeWorkflow({ ...disabled, autoRolloverEnabled: true }, 1000);
  assert.equal(Commands.decideWorkflowResponse(enabled, "handoff\n[YOLO:ROLLOVER]", {
    userFingerprint: "owned",
    at: 1100
  }).action, "rollover");
});

test("iteration safety cap remains task-wide across conversation rollover", () => {
  const workflow = Commands.normalizeWorkflow({
    kind: "loop",
    objective: "bounded work",
    status: "running",
    maxIterations: 4,
    iteration: 0,
    totalIterations: 3,
    conversationIndex: 2,
    awaitingResponse: true,
    promptFingerprint: "owned",
    autoRolloverEnabled: true
  }, 1000);
  const result = Commands.decideWorkflowResponse(workflow, "one more\n[YOLO:CONTINUE]", {
    userFingerprint: "owned",
    at: 1100
  });
  assert.equal(result.action, "paused");
  assert.equal(result.code, "command.workflow.cap_reached");
  assert.equal(result.workflow.iteration, 1);
  assert.equal(result.workflow.totalIterations, 4);

  const rolloverAtCap = Commands.decideWorkflowResponse({
    ...workflow,
    totalIterations: 3,
    iteration: 0,
    awaitingResponse: true,
    promptFingerprint: "owned"
  }, "handoff instead\n[YOLO:ROLLOVER]", {
    userFingerprint: "owned",
    at: 1200
  });
  assert.equal(rolloverAtCap.action, "paused");
  assert.equal(rolloverAtCap.code, "command.workflow.cap_reached");
});

test("watchdog recovery prompt continues partial work without replaying the interrupted user prompt", () => {
  const workflow = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "finish the audit",
    status: "running",
    maxIterations: 12,
    iteration: 4,
    totalIterations: 7,
    autoRolloverEnabled: true
  }, 1000);
  const prompt = Commands.workflowRecoveryPrompt(workflow);
  assert.match(prompt, /previous assistant generation was stopped/i);
  assert.match(prompt, /Continue from whatever partial work is already visible/i);
  assert.match(prompt, /Do not repeat completed work/i);
  assert.match(prompt, /task iteration 8 of at most 12/i);
  assert.match(prompt, /\[YOLO:ROLLOVER\]/);
});

test("awaiting workflows retain and clear response stability candidates safely", () => {
  const waiting = Commands.normalizeWorkflow({
    kind: "loop",
    objective: "iterate",
    status: "running",
    awaitingResponse: true,
    responseCandidateFingerprint: "candidate",
    responseCandidateSince: 1234
  }, 2000);
  assert.equal(waiting.responseCandidateFingerprint, "candidate");
  assert.equal(waiting.responseCandidateSince, 1234);

  const paused = Commands.setWorkflowStatus(waiting, "paused", "manual", 3000);
  assert.equal(paused.responseCandidateFingerprint, "");
  assert.equal(paused.responseCandidateSince, 0);
});

test("awaiting workflows persist response activity progress across reloads", () => {
  const waiting = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "finish",
    status: "running",
    awaitingResponse: true,
    responseActivityFingerprint: "activity",
    responseActivityAt: 12345
  }, 13000);
  assert.equal(waiting.responseActivityFingerprint, "activity");
  assert.equal(waiting.responseActivityAt, 12345);

  const paused = Commands.setWorkflowStatus(waiting, "paused", "manual", 14000);
  assert.equal(paused.responseActivityFingerprint, "");
  assert.equal(paused.responseActivityAt, 0);
});

test("both automated workflows pause when the terminal marker is missing", () => {
  for (const kind of ["goal", "loop"]) {
    const workflow = Commands.normalizeWorkflow({
      kind,
      objective: "ship",
      status: "running",
      awaitingResponse: true,
      promptFingerprint: "owned"
    }, 1000);
    const decision = Commands.decideWorkflowResponse(workflow, "work without a terminal marker", {
      userFingerprint: "owned",
      at: 1100
    });
    assert.equal(decision.action, "paused");
    assert.equal(decision.code, "command.workflow.marker_missing");
  }
});

test("both automated workflows pause on multiple or misplaced markers", () => {
  for (const kind of ["goal", "loop"]) {
    const workflow = Commands.normalizeWorkflow({
      kind,
      objective: "ship",
      status: "running",
      awaitingResponse: true,
      promptFingerprint: "owned"
    }, 1000);
    const decision = Commands.decideWorkflowResponse(workflow, "first\n[YOLO:CONTINUE]\nthen\n[YOLO:DONE]", {
      userFingerprint: "owned",
      at: 1100
    });
    assert.equal(decision.action, "paused");
    assert.equal(decision.code, "command.workflow.marker_malformed");
    assert.match(decision.reason, /多个终止控制标记|标记位置错误/);
  }
});
