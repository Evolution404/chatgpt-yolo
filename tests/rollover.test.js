const test = require("node:test");
const assert = require("node:assert/strict");
const Rollover = require("../rollover.js");
const Commands = require("../commands.js");

function validHandoff(overrides = {}) {
  const values = Object.fromEntries(Rollover.REQUIRED_FIELDS.map((field) => [field, overrides[field] || `${field.toLowerCase()} value`]));
  return [
    Rollover.HANDOFF_BEGIN,
    ...Rollover.REQUIRED_FIELDS.map((field) => `${field}: ${values[field]}`),
    Rollover.HANDOFF_END
  ].join("\n");
}

test("rollover handoff prompt requires a complete machine-readable envelope", () => {
  const workflow = Commands.startWorkflow("loop", "7 finish the audit").workflow;
  const prompt = Rollover.handoffPrompt({ sourceWorkflow: workflow, focus: "preserve exact git state" });
  assert.match(prompt, /Primary objective: finish the audit/);
  assert.match(prompt, /Rollover focus: preserve exact git state/);
  assert.match(prompt, /\[YOLO_ROLLOVER_HANDOFF_BEGIN\]/);
  for (const field of Rollover.REQUIRED_FIELDS) assert.match(prompt, new RegExp(`${field}:`));
});

test("handoff extraction rejects truncation, missing fields, and duplicate envelopes", () => {
  const complete = validHandoff();
  assert.equal(Rollover.extractHandoff(complete).ok, true);
  assert.equal(Rollover.extractHandoff(complete.replace("BLOCKERS: blockers value\n", "")).code, "rollover.handoff_incomplete");
  assert.equal(Rollover.extractHandoff(complete.replace(Rollover.HANDOFF_END, "")).code, "rollover.handoff_missing");
  assert.equal(Rollover.extractHandoff(`${complete}\n${complete}`).code, "rollover.handoff_ambiguous");
});

test("handoff acceptance is ownership-bound and stages a bootstrap prompt", () => {
  const workflow = Commands.startWorkflow("goal", "Ship reliable rollover").workflow;
  let transaction = Rollover.createTransaction({
    sourcePageId: "https://chatgpt.com/c/source",
    sourceWorkflow: workflow,
    tabId: 9,
    ownerId: "runner",
    baselineAssistantFingerprint: "old"
  }, 1000);
  transaction = Rollover.withRevision(transaction, { phase: "awaiting_handoff" }, 1100);

  const wrongOwner = Rollover.acceptHandoff(transaction, validHandoff(), { userFingerprint: "wrong", at: 1200 });
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.code, "rollover.ownership_lost");

  const accepted = Rollover.acceptHandoff(transaction, validHandoff(), {
    userFingerprint: transaction.handoffPromptFingerprint,
    at: 1300
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.transaction.phase, "bootstrap_pending");
  assert.match(accepted.transaction.bootstrapPrompt, /continuing a long-running task/i);
  assert.match(accepted.transaction.bootstrapPrompt, /verify the real current state/i);
  assert.match(accepted.transaction.bootstrapPrompt, /\[YOLO:CONTINUE\]/);
});

test("workflow snapshots retain objective and per-chat iteration policy without live lease state", () => {
  const workflow = Commands.normalizeWorkflow({
    kind: "loop",
    objective: "continue overnight",
    status: "paused",
    maxIterations: 12,
    iteration: 8,
    taskId: "task-1",
    conversationIndex: 3,
    totalIterations: 28,
    autoRolloverEnabled: true,
    autoRolloverAfterTurns: 10,
    autoRolloverMaxConversations: 8,
    runnerId: "tab-a",
    runnerExpiresAt: 9999
  }, 1000);
  assert.deepEqual(Rollover.workflowSnapshot(workflow), {
    id: workflow.id,
    kind: "loop",
    objective: "continue overnight",
    maxIterations: 12,
    iteration: 8,
    taskId: "task-1",
    conversationIndex: 3,
    totalIterations: 28,
    autoRolloverEnabled: true,
    autoRolloverAfterTurns: 10,
    autoRolloverMaxConversations: 8,
    status: "paused"
  });
});

test("automatic rollover boundary uses chat-local turns and a task conversation cap", () => {
  const base = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "long task",
    status: "running",
    iteration: 9,
    totalIterations: 29,
    conversationIndex: 3,
    autoRolloverEnabled: true,
    autoRolloverAfterTurns: 10,
    autoRolloverMaxConversations: 5
  }, 1000);
  assert.equal(Rollover.autoRolloverBoundary(base).action, "none");
  assert.equal(Rollover.autoRolloverBoundary({ ...base, iteration: 10 }).action, "rollover");
  assert.equal(Rollover.autoRolloverBoundary({ ...base, iteration: 10, conversationIndex: 5 }).action, "cap");
  assert.equal(Rollover.autoRolloverBoundary({ ...base, iteration: 10, autoRolloverEnabled: false }).action, "none");
});
