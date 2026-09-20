const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

test("popup visibly marks and disables workflow-owned queue mutations", () => {
  assert.match(source, /function workflowOwned\(item\)/);
  assert.match(source, /由工作流管理/);
  assert.match(source, /moveUp\.disabled = hasWorkflowItem \|\| managed/);
  assert.match(source, /moveDown\.disabled = hasWorkflowItem \|\| managed/);
  assert.match(source, /li\.draggable = !hasWorkflowItem/);
  assert.match(source, /edit\.disabled = managed/);
  assert.match(source, /remove\.disabled = managed/);
  assert.match(source, /els\.clearQueue\.disabled = busy \|\| items\.length === 0 \|\| hasWorkflowItem/);
  assert.match(source, /if \(item\.state === "failed" && !managed\)/);
});

test("busy-state release re-renders durable queue restrictions", () => {
  assert.match(source, /if \(!nextBusy && contentState\) \{\s*renderQueue\(\);\s*return;/);
});

test("queue management failures are surfaced to users", () => {
  assert.match(source, /无法调整队列顺序/);
  assert.match(source, /无法重试消息/);
  assert.match(source, /无法更改队列状态/);
  assert.match(source, /无法清空队列/);
});
