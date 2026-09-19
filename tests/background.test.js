const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Commands = require("../commands.js");
const Config = require("../config.js");

function loadBackground({ storage = {}, sessionStorage = {} } = {}) {
  let listener = null;
  let failNextSet = false;
  const context = {
    console, Date, Promise, Math, JSON, URL, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `id-${Math.random()}` },
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: { addListener() {} },
        onMessage: { addListener(value) { listener = value; } }
      },
      storage: {
        local: {
          get(keys, callback) {
            if (keys === null) {
              callback({ ...storage });
              return;
            }
            const list = Array.isArray(keys) ? keys : [keys];
            callback(Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]])));
          },
          set(items, callback) {
            if (failNextSet) {
              failNextSet = false;
              context.chrome.runtime.lastError = { message: "quota exceeded" };
              callback?.();
              context.chrome.runtime.lastError = null;
              return;
            }
            Object.assign(storage, items);
            callback?.();
          },
          remove(keys, callback) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) delete storage[key];
            callback?.();
          }
        },
        session: {
          get(keys, callback) {
            const list = Array.isArray(keys) ? keys : [keys];
            callback(Object.fromEntries(list.filter((key) => key in sessionStorage).map((key) => [key, sessionStorage[key]])));
          },
          set(items, callback) {
            Object.assign(sessionStorage, items);
            callback?.();
          },
          remove(keys, callback) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) delete sessionStorage[key];
            callback?.();
          }
        }
      }
    },
    importScripts() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["config.js", "shared.js", "coordinator.js", "portable-store.js", "queue.js", "commands.js", "rollover.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  const invoke = (message, sender = {}) => new Promise((resolve) => {
    const async = listener(message, sender, resolve);
    assert.equal(async, true);
  });
  return { invoke, storage, sessionStorage, failStorageWrite() { failNextSet = true; } };
}

test("rollover start atomically persists a tab-bound transaction and its handoff queue item", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/rollover-source";
  const sender = { tab: { id: 41, url: pageId } };
  const started = await invoke({
    type: "YOLO_ROLLOVER_START",
    pageId,
    focus: "preserve exact repository state",
    ownerId: "runner-a",
    baselineAssistantFingerprint: "assistant-old",
    sourceWorkflow: {
      kind: "loop",
      objective: "finish the audit",
      status: "paused",
      maxIterations: 12,
      iteration: 7
    }
  }, sender);

  assert.equal(started.ok, true);
  assert.equal(started.transaction.tabId, 41);
  assert.equal(started.transaction.phase, "handoff_queued");
  assert.equal(started.state.items.length, 1);
  assert.equal(started.state.items[0].source, "rollover:handoff");
  assert.equal(started.state.items[0].sourceId, started.transaction.id);
  assert.equal(storage.yoloQueuesV1[pageId].items[0].id, started.transaction.pendingItemId);
  assert.equal(storage.yoloRolloversV1["41"].id, started.transaction.id);

  const read = await invoke({ type: "YOLO_ROLLOVER_GET" }, sender);
  assert.equal(read.ok, true);
  assert.equal(read.transaction.id, started.transaction.id);
});

test("rollover state updates use CAS and remain bound to the originating tab", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/rollover-cas";
  const sender = { tab: { id: 7, url: pageId } };
  const started = await invoke({ type: "YOLO_ROLLOVER_START", pageId, ownerId: "runner" }, sender);
  const next = { ...started.transaction, phase: "awaiting_handoff", reason: "Waiting for handoff" };

  const updated = await invoke({
    type: "YOLO_ROLLOVER_UPDATE",
    expectedRevision: started.transaction.revision,
    transaction: next
  }, sender);
  assert.equal(updated.ok, true);
  assert.equal(updated.transaction.phase, "awaiting_handoff");

  const stale = await invoke({
    type: "YOLO_ROLLOVER_UPDATE",
    expectedRevision: started.transaction.revision,
    transaction: next
  }, sender);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "rollover.conflict");

  const otherTab = await invoke({ type: "YOLO_ROLLOVER_GET" }, { tab: { id: 8, url: pageId } });
  assert.equal(otherTab.ok, true);
  assert.equal(otherTab.transaction, null);
});

test("rollover does not rebind to another tab during the same browser session", async () => {
  const sharedStorage = {};
  const sharedSession = {};
  const first = loadBackground({ storage: sharedStorage, sessionStorage: sharedSession });
  const pageId = "https://chatgpt.com/c/same-session-source";
  const started = await first.invoke({ type: "YOLO_ROLLOVER_START", pageId, ownerId: "runner-a" }, { tab: { id: 70, url: pageId } });
  assert.equal(started.ok, true);

  const second = loadBackground({ storage: sharedStorage, sessionStorage: sharedSession });
  const attempted = await second.invoke({
    type: "YOLO_ROLLOVER_GET",
    ownerId: "runner-b"
  }, { tab: { id: 71, url: pageId } });
  assert.equal(attempted.ok, true);
  assert.equal(attempted.transaction, null);
  assert.equal(sharedStorage.yoloRolloversV1["70"].tabId, 70);
});

test("browser restart safely rebinds a source-route rollover to the restored tab", async () => {
  const sharedStorage = {};
  const first = loadBackground({ storage: sharedStorage, sessionStorage: {} });
  const pageId = "https://chatgpt.com/c/restart-source";
  const started = await first.invoke({ type: "YOLO_ROLLOVER_START", pageId, ownerId: "runner-old" }, { tab: { id: 80, url: pageId } });
  assert.equal(started.ok, true);

  const restarted = loadBackground({ storage: sharedStorage, sessionStorage: {} });
  const rebound = await restarted.invoke({
    type: "YOLO_ROLLOVER_GET",
    ownerId: "runner-new"
  }, { tab: { id: 81, url: pageId } });
  assert.equal(rebound.ok, true);
  assert.equal(rebound.rebound, true);
  assert.equal(rebound.transaction.id, started.transaction.id);
  assert.equal(rebound.transaction.tabId, 81);
  assert.equal(rebound.transaction.ownerId, "runner-new");
  assert.equal(sharedStorage.yoloRolloversV1["80"], undefined);
  assert.equal(sharedStorage.yoloRolloversV1["81"].id, started.transaction.id);
});

test("browser restart rebinds a transient new-chat rollover only by its persisted token", async () => {
  const sharedStorage = {};
  const first = loadBackground({ storage: sharedStorage, sessionStorage: {} });
  const sourcePageId = "https://chatgpt.com/c/restart-transient";
  const started = await first.invoke({ type: "YOLO_ROLLOVER_START", pageId: sourcePageId, ownerId: "runner-old" }, { tab: { id: 90, url: sourcePageId } });
  assert.equal(started.ok, true);
  const staged = { ...started.transaction, phase: "bootstrap_pending", reason: "ready" };
  const updated = await first.invoke({
    type: "YOLO_ROLLOVER_UPDATE",
    expectedRevision: started.transaction.revision,
    transaction: staged
  }, { tab: { id: 90, url: sourcePageId } });
  assert.equal(updated.ok, true);

  const restarted = loadBackground({ storage: sharedStorage, sessionStorage: {} });
  const withoutToken = await restarted.invoke({
    type: "YOLO_ROLLOVER_GET",
    ownerId: "runner-new"
  }, { tab: { id: 91, url: "https://chatgpt.com/" } });
  assert.equal(withoutToken.ok, true);
  assert.equal(withoutToken.transaction, null);

  const withToken = await restarted.invoke({
    type: "YOLO_ROLLOVER_GET",
    ownerId: "runner-new",
    rolloverId: started.transaction.id
  }, { tab: { id: 91, url: `https://chatgpt.com/?yolo-rollover=${encodeURIComponent(started.transaction.id)}` } });
  assert.equal(withToken.ok, true);
  assert.equal(withToken.rebound, true);
  assert.equal(withToken.transaction.phase, "bootstrap_pending");
  assert.equal(withToken.transaction.tabId, 91);
});

test("rollover start does not persist half a transaction when the atomic storage write fails", async () => {
  const { invoke, storage, failStorageWrite } = loadBackground();
  const pageId = "https://chatgpt.com/c/rollover-storage-failure";
  failStorageWrite();
  const response = await invoke({ type: "YOLO_ROLLOVER_START", pageId }, { tab: { id: 52, url: pageId } });
  assert.equal(response.ok, false);
  assert.match(response.reason, /quota exceeded/i);
  assert.equal(storage.yoloRolloversV1, undefined);
  assert.equal(storage.yoloQueuesV1, undefined);
});

test("automatic rollover atomically consumes exactly one workflow response and pauses the source workflow", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/auto-rollover-source";
  const sender = { tab: { id: 61, url: pageId } };
  const started = Commands.startWorkflow("goal", "finish long audit", {
    at: 1000,
    rolloverPolicy: { enabled: true, afterTurns: 2, maxConversations: 5 }
  }).workflow;
  const waiting = Commands.normalizeWorkflow({
    ...started,
    awaitingResponse: true,
    promptFingerprint: "owned",
    lastPromptAt: 1100
  }, 1100);
  const stored = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: waiting
  }, sender);
  assert.equal(stored.ok, true);

  const progressed = Commands.normalizeWorkflow({
    ...stored.workflow,
    awaitingResponse: false,
    iteration: stored.workflow.iteration + 1,
    totalIterations: stored.workflow.totalIterations + 1,
    lastAssistantFingerprint: "assistant-new",
    lastResponseAt: 1200
  }, 1200);
  const rollover = await invoke({
    type: "YOLO_ROLLOVER_START",
    pageId,
    consumeWorkflowResponse: true,
    workflowExpectedRevision: stored.workflow.revision,
    sourceWorkflow: progressed,
    ownerId: "runner"
  }, sender);

  assert.equal(rollover.ok, true);
  assert.equal(rollover.workflow.status, "paused");
  assert.equal(rollover.workflow.iteration, 1);
  assert.equal(rollover.workflow.totalIterations, 1);
  assert.equal(rollover.transaction.sourceWorkflow.taskId, waiting.taskId);
  assert.equal(storage[Config.workflowKey(pageId)].status, "paused");
  assert.equal(storage.yoloQueuesV1[pageId].items.length, 1);
  assert.equal(storage.yoloRolloversV1["61"].sourceWorkflow.iteration, 1);
});

test("automatic rollover rejects stale workflow boundaries without enqueueing a handoff", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/auto-rollover-stale";
  const sender = { tab: { id: 62, url: pageId } };
  const workflow = Commands.normalizeWorkflow({
    kind: "goal",
    objective: "audit",
    status: "running",
    awaitingResponse: true,
    promptFingerprint: "owned",
    autoRolloverEnabled: true
  }, 1000);
  const stored = await invoke({ type: "YOLO_WORKFLOW_SET", pageId, expectedRevision: 0, workflow }, sender);
  const progressed = Commands.normalizeWorkflow({
    ...stored.workflow,
    awaitingResponse: false,
    iteration: 1,
    totalIterations: 1
  }, 1100);
  const rejected = await invoke({
    type: "YOLO_ROLLOVER_START",
    pageId,
    consumeWorkflowResponse: true,
    workflowExpectedRevision: stored.workflow.revision + 1,
    sourceWorkflow: progressed
  }, sender);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "rollover.workflow_conflict");
  assert.equal(storage.yoloRolloversV1, undefined);
  assert.equal(storage.yoloQueuesV1, undefined);
});

test("background serializes queue mutations and claim lifecycle", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/test";
  let response = await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "one" } });
  assert.equal(response.ok, true);
  response = await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "two" } });
  assert.equal(response.state.items.length, 2);
  const claim = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "tab" });
  assert.equal(claim.ok, true);
  const submitting = await invoke({
    type: "YOLO_QUEUE_MARK_SUBMITTING",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken
  });
  assert.equal(submitting.ok, true);
  assert.equal(submitting.item.claimPhase, "submitting");
  const completed = await invoke({
    type: "YOLO_QUEUE_COMPLETE",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.state.items.length, 1);
});


test("background reports storage write failures instead of acknowledging lost queue data", async () => {
  const { invoke, failStorageWrite } = loadBackground();
  failStorageWrite();
  const response = await invoke({
    type: "YOLO_QUEUE_ADD",
    pageId: "https://chatgpt.com/c/storage-failure",
    item: { text: "must not be acknowledged" }
  });
  assert.equal(response.ok, false);
  assert.match(response.reason, /quota exceeded/i);
});

test("background bounds active conversation queues and does not persist read-only visits", async () => {
  const { invoke, storage } = loadBackground();
  for (let index = 0; index < 40; index += 1) {
    const response = await invoke({ type: "YOLO_QUEUE_GET", pageId: `https://chatgpt.com/c/read-${index}` });
    assert.equal(response.ok, true);
  }
  assert.equal(storage.yoloQueuesV1, undefined);

  for (let index = 0; index < 25; index += 1) {
    const response = await invoke({
      type: "YOLO_QUEUE_ADD",
      pageId: `https://chatgpt.com/c/active-${index}`,
      item: { text: `message ${index}` }
    });
    assert.equal(response.ok, true);
  }
  const rejected = await invoke({
    type: "YOLO_QUEUE_ADD",
    pageId: "https://chatgpt.com/c/active-overflow",
    item: { text: "overflow" }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "queue.conversation_limit");
});


test("background persists ambiguous delivery as terminal manual recovery", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/ambiguous-delivery";
  await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "send once" } });
  const claim = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "tab" });
  await invoke({
    type: "YOLO_QUEUE_MARK_SUBMITTING",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken
  });
  const failed = await invoke({
    type: "YOLO_QUEUE_FAIL",
    pageId,
    itemId: claim.item.id,
    claimToken: claim.item.claimToken,
    error: "submission could not be observed",
    errorCode: "composer.unconfirmed",
    maxRetries: 5,
    backoffSec: 1,
    pauseOnFailure: false,
    deliveryAmbiguous: true
  });

  assert.equal(failed.ok, true);
  assert.equal(failed.state.items[0].state, "failed");
  assert.equal(failed.state.items[0].errorCode, "queue.delivery_unknown");
  assert.equal(failed.state.paused, true);
  const nextClaim = await invoke({ type: "YOLO_QUEUE_CLAIM", pageId, ownerId: "other-tab" });
  assert.equal(nextClaim.ok, false);
  assert.equal(nextClaim.code, "queue.paused");
});

test("tab-backed queue messages must match the sender conversation", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/sender-bound";
  await invoke({ type: "YOLO_QUEUE_ADD", pageId, item: { text: "bound" } });

  const matching = await invoke(
    { type: "YOLO_QUEUE_GET", pageId },
    { tab: { url: "https://chatgpt.com/c/sender-bound?temporary-chat=true" } }
  );
  assert.equal(matching.ok, true);

  const mismatched = await invoke(
    { type: "YOLO_QUEUE_GET", pageId },
    { tab: { url: "https://chatgpt.com/c/other" } }
  );
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "queue.page_mismatch");
});

test("install-time template initialization uses the shared portable transaction", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(source, /onInstalled[\s\S]*PortableStore\.mutate/);
  assert.doesNotMatch(source, /templateLock/);
});

test("background persists sender-bound command workflow state", async () => {
  const { invoke } = loadBackground();
  const pageId = "https://chatgpt.com/c/workflow";
  const sender = { tab: { url: `${pageId}?temporary-chat=true` } };
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "Ship it", status: "running", maxIterations: 5 }
  }, sender);
  assert.equal(started.ok, true);
  assert.equal(started.workflow.kind, "goal");

  const loaded = await invoke({ type: "YOLO_WORKFLOW_GET", pageId }, sender);
  assert.equal(loaded.workflow.objective, "Ship it");
  assert.equal(loaded.workflow.maxIterations, 5);

  const mismatch = await invoke(
    { type: "YOLO_WORKFLOW_GET", pageId },
    { tab: { url: "https://chatgpt.com/c/other" } }
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "workflow.page_mismatch");

  const stale = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "stale overwrite", status: "running" }
  }, sender);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "workflow.conflict");

  const claimed = await invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "tab-a" }, sender);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.workflow.runnerId, "tab-a");
  const competing = await invoke({ type: "YOLO_WORKFLOW_CLAIM", pageId, ownerId: "tab-b" }, sender);
  assert.equal(competing.ok, false);
  assert.equal(competing.code, "workflow.busy");

  const cleared = await invoke({
    type: "YOLO_WORKFLOW_CLEAR",
    pageId,
    expectedRevision: claimed.workflow.revision
  }, sender);
  assert.equal(cleared.workflow.status, "idle");
  assert.equal(cleared.workflow.revision, 0);
  const afterClear = await invoke({ type: "YOLO_WORKFLOW_GET", pageId }, sender);
  assert.equal(afterClear.workflow.status, "idle");
  assert.equal(afterClear.workflow.revision, 0);
});

test("background bounds active command workflows", async () => {
  const { invoke } = loadBackground();
  for (let index = 0; index < 25; index += 1) {
    const pageId = `https://chatgpt.com/c/workflow-${index}`;
    const response = await invoke({
      type: "YOLO_WORKFLOW_SET",
      pageId,
      expectedRevision: 0,
      workflow: { kind: "loop", objective: `work ${index}`, status: "running" }
    });
    assert.equal(response.ok, true);
  }
  const rejected = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId: "https://chatgpt.com/c/workflow-overflow",
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "overflow", status: "running" }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "workflow.conversation_limit");
});

test("workflow prompt enqueue commits queue and workflow together", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/atomic-workflow";
  const response = await invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-a",
    workflow: { kind: "goal", objective: "atomic", status: "running", promptFingerprint: "prompt" },
    item: { text: "workflow prompt", source: "workflow:goal", sourceId: "goal-a" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.workflow.pendingItemId, response.item.id);
  assert.equal(response.workflow.runnerId, "tab-a");
  assert.equal(storage.yoloQueuesV1[pageId].items[0].id, response.item.id);
  const workflowKey = Object.keys(storage).find((key) => key.startsWith("yoloWorkflow:"));
  assert.equal(storage[workflowKey].pendingItemId, response.item.id);

  const stale = await invoke({
    type: "YOLO_WORKFLOW_QUEUE_ADD",
    pageId,
    expectedRevision: 0,
    ownerId: "tab-b",
    workflow: { kind: "goal", objective: "stale", status: "running" },
    item: { text: "must not queue" }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "workflow.conflict");
  assert.equal(storage.yoloQueuesV1[pageId].items.length, 1);
});

test("clearing a workflow removes its per-conversation storage key", async () => {
  const { invoke, storage } = loadBackground();
  const pageId = "https://chatgpt.com/c/removable-workflow";
  const started = await invoke({
    type: "YOLO_WORKFLOW_SET",
    pageId,
    expectedRevision: 0,
    workflow: { kind: "goal", objective: "remove me", status: "paused" }
  });
  assert.equal(started.ok, true);
  assert.equal(Object.keys(storage).some((key) => key.startsWith("yoloWorkflow:")), true);
  const cleared = await invoke({
    type: "YOLO_WORKFLOW_CLEAR",
    pageId,
    expectedRevision: started.workflow.revision
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.workflow.status, "idle");
  assert.equal(Object.keys(storage).some((key) => key.startsWith("yoloWorkflow:")), false);
});

test("fresh installs open only the local onboarding page", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(source, /details\?\.reason === "install"/);
  assert.match(source, /chrome\.runtime\.getURL\("onboarding\.html"\)/);
  assert.doesNotMatch(source, /reason === "update"[^\n]*tabs/);
});

test("an intentionally empty template library remains empty", async () => {
  const { invoke, storage } = loadBackground();
  storage.yoloTemplatesV1 = [];
  const response = await invoke({ type: "YOLO_TEMPLATES_GET" });
  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.templates), true);
  assert.equal(response.templates.length, 0);
});

test("template additions are idempotent and share the portable revision", async () => {
  const { invoke, storage } = loadBackground();
  const message = {
    type: "YOLO_TEMPLATE_ADD",
    template: { id: "client-template-id", name: "Stable", text: "same mutation" }
  };
  const first = await invoke(message);
  assert.equal(first.ok, true);
  assert.equal(storage.yoloPortableRevisionV1, 1);
  const second = await invoke(message);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.templates.filter((template) => template.id === "client-template-id").length, 1);
  assert.equal(storage.yoloPortableRevisionV1, 1);
});

test("template additions require a stable client mutation id", async () => {
  const { invoke, storage } = loadBackground();
  const response = await invoke({
    type: "YOLO_TEMPLATE_ADD",
    template: { name: "Missing id", text: "must not mutate" }
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, "template.id_required");
  assert.equal(storage.yoloPortableRevisionV1, undefined);
  assert.equal(storage.yoloTemplatesV1, undefined);
});
