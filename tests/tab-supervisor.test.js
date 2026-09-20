const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "tab-supervisor.js"), "utf8");
const sharedSource = fs.readFileSync(path.join(root, "shared.js"), "utf8");

function makeHarness({ fail = "query", protectedWorkflow = false, frozen = false, active = true, heartbeatAgeMs = null, healthResponse = { ok: true }, activeRollover = false } = {}) {
  const errors = [];
  const warnings = [];
  const reloads = [];
  const creates = [];
  const removes = [];
  const pageId = "https://chatgpt.com/c/test";
  const localData = protectedWorkflow ? {
    globalSettings: { protectActiveWorkflowTabs: true },
    [`workflow:${pageId}`]: {
      status: "running",
      awaitingResponse: true,
      pendingItemId: "",
      runnerId: "runner-a",
      runnerExpiresAt: Date.now() + 60_000,
      revision: 2
    },
    ...(activeRollover ? { rollovers: { "11": { phase: "awaiting_handoff" } } } : {})
  } : {};
  let alarmCallback = null;
  const listeners = {
    alarm: null,
    startup: null,
    installed: null,
    updated: null,
    activated: null,
    removed: null
  };

  const chrome = {
    runtime: {
      get lastError() { return null; },
      onStartup: { addListener(handler) { listeners.startup = handler; } },
      onInstalled: { addListener(handler) { listeners.installed = handler; } }
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) if (Object.prototype.hasOwnProperty.call(localData, key)) result[key] = localData[key];
          callback?.(result);
        },
        set(items, callback) {
          Object.assign(localData, items);
          callback?.();
        }
      },
      session: {
        get(keys, callback) {
          const result = {};
          if (heartbeatAgeMs !== null) {
            result.yoloTabHeartbeatsV1 = {
              "11": {
                pageId: "https://chatgpt.com/c/test",
                at: Date.now() - heartbeatAgeMs,
                visible: active,
                workflowActive: protectedWorkflow
              }
            };
          }
          callback?.(result);
        }
      }
    },
    alarms: {
      create(name, options) {
        if (name === "yolo-tab-supervisor" && options?.periodInMinutes === 1) alarmCallback = options;
      },
      get(name, callback) { callback?.(null); },
      onAlarm: {
        addListener(handler) { listeners.alarm = handler; }
      }
    },
    tabs: {
      query(queryInfo, callback) {
        if (fail === "query") throw new Error("tabs.query rejected");
        callback?.([]);
      },
      get(tabId, callback) {
        if (fail === "get") throw new Error(`tabs.get(${tabId}) rejected`);
        callback?.({ id: tabId, url: "https://chatgpt.com/c/test", status: "complete", frozen, active, discarded: false, autoDiscardable: true });
      },
      update(tabId, updateProperties, callback) {
        callback?.({ id: tabId });
      },
      sendMessage(tabId, message, callback) {
        callback?.(healthResponse);
      },
      reload(tabId, _options, callback) {
        reloads.push(tabId);
        callback?.();
      },
      create(createProperties, callback) {
        creates.push(createProperties);
        callback?.({ id: 99, url: createProperties.url, status: "loading" });
      },
      remove(tabId, callback) {
        removes.push(tabId);
        callback?.();
      },
      onUpdated: { addListener(handler) { listeners.updated = handler; } },
      onActivated: { addListener(handler) { listeners.activated = handler; } },
      onRemoved: { addListener(handler) { listeners.removed = handler; } }
    },
    scripting: {
      executeScript(target, options, callback) {
        callback?.();
      }
    }
  };

  const context = {
    console: {
      error: (message) => errors.push(message),
      warn: (message) => warnings.push(message)
    },
    Date,
    Promise,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    chrome,
    globalThis: undefined,
    YOLOConfig: {
      VERSION: "test",
      TAB_HEARTBEAT_SESSION_KEY: "yoloTabHeartbeatsV1",
      STORAGE_KEYS: { global: "globalSettings", pages: "pages", pageWorkflows: "pageWorkflows" },
      DEFAULT_SETTINGS: { protectActiveWorkflowTabs: false },
      isSupportedUrl(url) { return /^https:\/\/[^/]*chatgpt\.com/.test(String(url)); },
      pageId(url) { return String(url); },
      isDurablePageId(pageId) { return /\/c\/[^/]+$/.test(String(pageId)); },
      mergeSettings(...sources) { return Object.assign({}, ...sources); },
      pageSettingsKey(pageId) { return `pageSettings:${pageId}`; },
      workflowKey(pageId) { return `workflow:${pageId}`; }
    },
    YOLOLifecycle: {
      shouldProtectTab({ enabled, workflowStatus }) { return Boolean(enabled && workflowStatus === "running"); }
    }
  };

  vm.runInNewContext(sharedSource, context, { filename: "shared.js" });
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "tab-supervisor.js" });

  context.YOLOConfig.STORAGE_KEYS.rollovers = "rollovers";
  return { listeners, errors, warnings, reloads, creates, removes, localData };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("listener catches and logs alarm sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.alarm?.({ name: "yolo-tab-supervisor" });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor sweep failed:/);
});

test("listener catches and logs startup sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.startup?.();
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor startup sweep failed:/);
});

test("listener catches and logs install sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.installed?.();
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor install sweep failed:/);
});

test("listener catches and logs onUpdated tab inspection rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "get" });
  listeners.updated?.(42, { status: "complete" });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor updated-tab inspection failed:/);
});

test("listener catches and logs onActivated tab inspection rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "get" });
  listeners.activated?.({ tabId: 7 });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor activated-tab inspection failed:/);
});

test("frozen running workflow tabs are reloaded without activating the tab", async () => {
  const { listeners, reloads, warnings } = makeHarness({ fail: "none", protectedWorkflow: true, frozen: true });
  listeners.activated?.({ tabId: 11 });
  await flushMicrotasks();
  assert.deepEqual(reloads, [11]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reloaded protected workflow tab 11/);
});

test("frozen non-workflow tabs are never reloaded by the supervisor", async () => {
  const { listeners, reloads } = makeHarness({ fail: "none", protectedWorkflow: false, frozen: true });
  listeners.activated?.({ tabId: 12 });
  await flushMicrotasks();
  assert.deepEqual(reloads, []);
});

test("stale heartbeat reloads a protected running workflow without waiting on the renderer", async () => {
  const { listeners, reloads, warnings, creates, removes, localData } = makeHarness({
    fail: "none",
    protectedWorkflow: true,
    active: true,
    heartbeatAgeMs: 90_000,
    healthResponse: null
  });
  listeners.activated?.({ tabId: 11 });
  await flushMicrotasks();
  assert.deepEqual(reloads, []);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].url, "https://chatgpt.com/c/test");
  assert.deepEqual(removes, [11]);
  assert.equal(localData["workflow:https://chatgpt.com/c/test"].runnerId, "");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /replaced protected workflow tab 11 with 99/);
});

test("fresh heartbeat never causes a protected workflow reload", async () => {
  const { listeners, reloads } = makeHarness({
    fail: "none",
    protectedWorkflow: true,
    active: true,
    heartbeatAgeMs: 10_000,
    healthResponse: { ok: true }
  });
  listeners.activated?.({ tabId: 11 });
  await flushMicrotasks();
  assert.deepEqual(reloads, []);
});

test("stale heartbeat on a non-workflow tab never reloads it", async () => {
  const { listeners, reloads, creates } = makeHarness({
    fail: "none",
    protectedWorkflow: false,
    active: true,
    heartbeatAgeMs: 90_000,
    healthResponse: null
  });
  listeners.activated?.({ tabId: 11 });
  await flushMicrotasks();
  assert.deepEqual(reloads, []);
  assert.deepEqual(creates, []);
});

test("active rollover blocks strong tab replacement and falls back to reload", async () => {
  const { listeners, reloads, creates, removes } = makeHarness({
    fail: "none",
    protectedWorkflow: true,
    active: true,
    activeRollover: true,
    heartbeatAgeMs: 90_000,
    healthResponse: null
  });
  listeners.activated?.({ tabId: 11 });
  await flushMicrotasks();
  assert.deepEqual(creates, []);
  assert.deepEqual(removes, []);
  assert.deepEqual(reloads, [11]);
});
