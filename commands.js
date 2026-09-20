((root, factory) => {
  const Shared = typeof module === "object" && module.exports ? require("./shared.js") : root.YOLOShared;
  if (!Shared || typeof Shared.makeId !== "function") return;
  const api = factory(Shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLOCommands = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Shared) => {
  "use strict";

  const MAX_OBJECTIVE_LENGTH = 4000;
  const MAX_ITERATIONS = 50;
  const DEFAULT_MAX_ITERATIONS = 12;
  const DEFAULT_AUTO_ROLLOVER_TURNS = 12;
  const DEFAULT_AUTO_ROLLOVER_MAX_CONVERSATIONS = 10;
  const WORKFLOW_STATUSES = new Set(["idle", "running", "paused", "completed", "blocked"]);
  const WORKFLOW_KINDS = new Set(["goal", "loop"]);
  const STANDALONE_MARKER_RE = /(?:^|\n)[ \t]*\[YOLO:(CONTINUE|DONE|BLOCKED|ROLLOVER)\][ \t]*(?=\n|$)/gi;
  const TERMINAL_MARKER_RE = /(?:^|\n)[ \t]*\[YOLO:(CONTINUE|DONE|BLOCKED|ROLLOVER)\][ \t]*$/i;

  const COMMANDS = Object.freeze([
    Object.freeze({ name: "goal", title: "持续目标", description: "启动由控制标记驱动、具有安全回合上限的持续目标。", args: "目标", group: "自动工作流", kind: "workflow" }),
    Object.freeze({ name: "loop", title: "循环任务", description: "围绕同一目标执行有边界的多轮迭代。", args: "[回合数] 目标", group: "自动工作流", kind: "workflow" }),
    Object.freeze({ name: "plan", title: "制定计划", description: "将“生成执行计划”的指令加入队列。", args: "目标", group: "快捷指令", kind: "prompt" }),
    Object.freeze({ name: "review", title: "审查", description: "对当前工作或指定范围进行严格审查。", args: "[范围]", group: "快捷指令", kind: "prompt" }),
    Object.freeze({ name: "fix", title: "修复", description: "让 ChatGPT 诊断、修复并验证当前工作。", args: "[范围]", group: "快捷指令", kind: "prompt" }),
    Object.freeze({ name: "handoff", title: "交接", description: "生成供下一轮继续工作的交接摘要；不会压缩当前 ChatGPT 上下文。", args: "[重点]", group: "快捷指令", kind: "prompt" }),
    Object.freeze({ name: "continue", title: "继续", description: "将继续当前任务的指令加入队列，可附带方向。", args: "[方向]", group: "快捷指令", kind: "prompt" }),
    Object.freeze({ name: "rollover", title: "切换对话", description: "生成严格交接信息，创建新对话并继续当前工作。", args: "[重点]", group: "自动工作流", kind: "control" }),
    Object.freeze({ name: "status", title: "状态", description: "查看 YOLO 工作流、队列、生成状态、限制和最近操作。", args: "", group: "YOLO 控制", kind: "control" }),
    Object.freeze({ name: "pause", title: "暂停", description: "暂停当前持续目标或循环任务，但不删除。", args: "", group: "YOLO 控制", kind: "control" }),
    Object.freeze({ name: "resume", title: "继续", description: "继续已暂停或已阻塞的 YOLO 工作流。", args: "", group: "YOLO 控制", kind: "control" }),
    Object.freeze({ name: "stop", title: "停止", description: "确认后停止并清除当前持续目标或循环任务。", args: "", group: "YOLO 控制", kind: "control" }),
    Object.freeze({ name: "settings", title: "设置", description: "打开 YOLO 高级设置。", args: "", group: "YOLO 控制", kind: "control" }),
    Object.freeze({ name: "help", title: "帮助", description: "打开 YOLO 命令面板和命令说明。", args: "", group: "YOLO 控制", kind: "control" })
  ]);

  const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

  const cleanText = (value, max = MAX_OBJECTIVE_LENGTH) => String(value ?? "").trim().slice(0, max);
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const makeId = Shared.makeId;

  function command(name) {
    return COMMAND_BY_NAME.get(String(name || "").toLowerCase()) || null;
  }

  function filterCommands(query = "") {
    const needle = cleanText(query, 120).replace(/^\//, "").toLowerCase();
    if (!needle) return [...COMMANDS];
    return COMMANDS
      .map((entry) => {
        const name = entry.name.toLowerCase();
        const title = entry.title.toLowerCase();
        const description = entry.description.toLowerCase();
        let score = 0;
        if (name === needle) score += 100;
        if (name.startsWith(needle)) score += 60;
        if (title.startsWith(needle)) score += 40;
        if (name.includes(needle)) score += 25;
        if (description.includes(needle)) score += 10;
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .map(({ entry }) => entry);
  }

  function parseInvocation(input) {
    const text = String(input || "").trim();
    const match = text.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const entry = command(match[1]);
    if (!entry) return null;
    return { command: entry, args: cleanText(match[2] || "") };
  }

  function parseLoopArgs(input) {
    const text = cleanText(input);
    const match = text.match(/^(\d{1,3})\s+([\s\S]+)$/);
    if (!match) return { objective: text, maxIterations: DEFAULT_MAX_ITERATIONS };
    return {
      objective: cleanText(match[2]),
      maxIterations: clamp(Math.round(Number(match[1])), 1, MAX_ITERATIONS)
    };
  }

  function fingerprint(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(36)}`;
  }

  function freshWorkflow(at = Date.now()) {
    return {
      version: 1,
      revision: 0,
      id: "",
      kind: "",
      objective: "",
      status: "idle",
      maxIterations: DEFAULT_MAX_ITERATIONS,
      iteration: 0,
      taskId: "",
      conversationIndex: 1,
      totalIterations: 0,
      autoRolloverEnabled: false,
      autoRolloverAfterTurns: DEFAULT_AUTO_ROLLOVER_TURNS,
      autoRolloverMaxConversations: DEFAULT_AUTO_ROLLOVER_MAX_CONVERSATIONS,
      pendingItemId: "",
      awaitingResponse: false,
      sawGeneration: false,
      baselineFingerprint: "",
      lastAssistantFingerprint: "",
      promptFingerprint: "",
      responseCandidateFingerprint: "",
      responseCandidateSince: 0,
      responseActivityFingerprint: "",
      responseActivityAt: 0,
      responseStartRefreshAt: 0,
      runnerId: "",
      runnerExpiresAt: 0,
      lastPromptAt: 0,
      lastResponseAt: 0,
      reason: "",
      createdAt: at,
      updatedAt: at
    };
  }

  function normalizeWorkflow(raw, at = Date.now()) {
    const fallback = freshWorkflow(at);
    if (!raw || typeof raw !== "object") return fallback;
    const kind = WORKFLOW_KINDS.has(raw.kind) ? raw.kind : "";
    const objective = cleanText(raw.objective);
    const status = WORKFLOW_STATUSES.has(raw.status) ? raw.status : (kind && objective ? "paused" : "idle");
    const revision = Math.max(0, Math.round(finite(raw.revision, 0)));
    if (!kind || !objective || status === "idle") {
      return {
        ...fallback,
        revision,
        createdAt: finite(raw.createdAt, fallback.createdAt),
        updatedAt: finite(raw.updatedAt, at)
      };
    }
    return {
      version: 1,
      revision,
      id: cleanText(raw.id, 180) || makeId(kind),
      kind,
      objective,
      status,
      maxIterations: clamp(Math.round(finite(raw.maxIterations, DEFAULT_MAX_ITERATIONS)), 1, MAX_ITERATIONS),
      iteration: clamp(Math.round(finite(raw.iteration, 0)), 0, MAX_ITERATIONS),
      taskId: cleanText(raw.taskId, 180) || cleanText(raw.id, 180) || makeId("task"),
      conversationIndex: clamp(Math.round(finite(raw.conversationIndex, 1)), 1, 25),
      totalIterations: Math.max(0, Math.round(finite(raw.totalIterations, finite(raw.iteration, 0)))),
      autoRolloverEnabled: Boolean(raw.autoRolloverEnabled),
      autoRolloverAfterTurns: clamp(Math.round(finite(raw.autoRolloverAfterTurns, DEFAULT_AUTO_ROLLOVER_TURNS)), 2, 40),
      autoRolloverMaxConversations: clamp(Math.round(finite(raw.autoRolloverMaxConversations, DEFAULT_AUTO_ROLLOVER_MAX_CONVERSATIONS)), 2, 25),
      pendingItemId: cleanText(raw.pendingItemId, 180),
      awaitingResponse: Boolean(raw.awaitingResponse),
      sawGeneration: Boolean(raw.sawGeneration),
      baselineFingerprint: cleanText(raw.baselineFingerprint, 180),
      lastAssistantFingerprint: cleanText(raw.lastAssistantFingerprint, 180),
      promptFingerprint: cleanText(raw.promptFingerprint, 180),
      responseCandidateFingerprint: Boolean(raw.awaitingResponse) ? cleanText(raw.responseCandidateFingerprint, 180) : "",
      responseCandidateSince: Boolean(raw.awaitingResponse) ? Math.max(0, finite(raw.responseCandidateSince, 0)) : 0,
      responseActivityFingerprint: (Boolean(raw.awaitingResponse) || Boolean(raw.pendingItemId))
        ? cleanText(raw.responseActivityFingerprint, 180)
        : "",
      responseActivityAt: (Boolean(raw.awaitingResponse) || Boolean(raw.pendingItemId))
        ? Math.max(0, finite(raw.responseActivityAt, 0))
        : 0,
      responseStartRefreshAt: Boolean(raw.awaitingResponse) ? Math.max(0, finite(raw.responseStartRefreshAt, 0)) : 0,
      runnerId: status === "running" ? cleanText(raw.runnerId, 220) : "",
      runnerExpiresAt: status === "running" ? Math.max(0, finite(raw.runnerExpiresAt, 0)) : 0,
      lastPromptAt: Math.max(0, finite(raw.lastPromptAt, 0)),
      lastResponseAt: Math.max(0, finite(raw.lastResponseAt, 0)),
      reason: cleanText(raw.reason, 500),
      createdAt: finite(raw.createdAt, at),
      updatedAt: finite(raw.updatedAt, at)
    };
  }

  function startWorkflow(kind, input, { at = Date.now(), baselineFingerprint = "", rolloverPolicy = null } = {}) {
    if (!WORKFLOW_KINDS.has(kind)) return { ok: false, reason: "不支持的工作流类型" };
    const parsed = kind === "loop" ? parseLoopArgs(input) : { objective: cleanText(input), maxIterations: MAX_ITERATIONS };
    if (!parsed.objective) return { ok: false, reason: `/${kind} 需要填写目标` };
    return {
      ok: true,
      workflow: normalizeWorkflow({
        id: makeId(kind),
        kind,
        objective: parsed.objective,
        status: "running",
        maxIterations: parsed.maxIterations,
        iteration: 0,
        taskId: makeId("task"),
        conversationIndex: 1,
        totalIterations: 0,
        autoRolloverEnabled: Boolean(rolloverPolicy?.enabled),
        autoRolloverAfterTurns: rolloverPolicy?.afterTurns,
        autoRolloverMaxConversations: rolloverPolicy?.maxConversations,
        baselineFingerprint,
        lastAssistantFingerprint: baselineFingerprint,
        createdAt: at,
        updatedAt: at
      }, at)
    };
  }

  function setWorkflowStatus(raw, status, reason = "", at = Date.now()) {
    const workflow = normalizeWorkflow(raw, at);
    if (workflow.status === "idle") return workflow;
    workflow.status = WORKFLOW_STATUSES.has(status) ? status : workflow.status;
    workflow.reason = cleanText(reason, 500);
    workflow.updatedAt = at;
    if (workflow.status !== "running") {
      workflow.pendingItemId = "";
      workflow.awaitingResponse = false;
      workflow.sawGeneration = false;
      workflow.responseCandidateFingerprint = "";
      workflow.responseCandidateSince = 0;
      workflow.responseActivityFingerprint = "";
      workflow.responseActivityAt = 0;
      workflow.responseStartRefreshAt = 0;
      workflow.runnerId = "";
      workflow.runnerExpiresAt = 0;
    }
    return workflow;
  }

  function markerNames(workflow) {
    return workflow.autoRolloverEnabled
      ? "[YOLO:CONTINUE], [YOLO:DONE], [YOLO:BLOCKED], or [YOLO:ROLLOVER]"
      : "[YOLO:CONTINUE], [YOLO:DONE], or [YOLO:BLOCKED]";
  }

  function goalInitialPrompt(workflow) {
    return [
      "You are now working in YOLO Goal mode.",
      `Persistent objective: ${workflow.objective}`,
      "Work toward the objective concretely. Inspect the current conversation and continue from the actual state instead of restarting or repeating prior commentary.",
      "At the very end of every response, emit exactly one control marker on its own line:",
      workflow.autoRolloverEnabled
        ? "[YOLO:CONTINUE] when more work remains; [YOLO:DONE] only when complete; [YOLO:BLOCKED] when user input or unavailable access is required; [YOLO:ROLLOVER] only when this conversation should be handed off early because its context is becoming too long or unreliable."
        : "[YOLO:CONTINUE] when more work remains toward the objective; [YOLO:DONE] only when the objective is genuinely complete; [YOLO:BLOCKED] when specific user input or unavailable access is required.",
      "Do not emit more than one marker. Begin now."
    ].join("\n\n");
  }

  function goalContinuationPrompt(workflow) {
    return [
      `Continue YOLO Goal mode for this persistent objective: ${workflow.objective}`,
      `This is task iteration ${workflow.totalIterations + 1} of at most ${workflow.maxIterations} (chat-local turn ${workflow.iteration + 1}).`,
      "Continue from the latest completed work. Critically inspect assumptions, close gaps, execute the next concrete steps, and validate what you change. Do not repeat the previous answer.",
      `End with exactly one marker on its own line: ${markerNames(workflow)}.`
    ].join("\n\n");
  }

  function loopInitialPrompt(workflow) {
    return [
      "You are now working in YOLO Loop mode.",
      `Loop objective: ${workflow.objective}`,
      `Maximum iterations: ${workflow.maxIterations}.`,
      "Perform one meaningful iteration now. Build on the current conversation, make concrete progress, inspect your own work, and avoid repeating prior commentary.",
      `At the very end, emit exactly one marker on its own line: ${markerNames(workflow)}. Use DONE only if complete, BLOCKED only if user input is required, CONTINUE when another iteration would help, and ROLLOVER only when it is available and this conversation should be handed off early. Missing or malformed markers pause the loop.`
    ].join("\n\n");
  }

  function loopContinuationPrompt(workflow) {
    return [
      `Run the next YOLO Loop iteration for: ${workflow.objective}`,
      `Task iteration ${workflow.totalIterations + 1} of ${workflow.maxIterations} (chat-local turn ${workflow.iteration + 1}).`,
      "Continue from the latest work, find the highest-value unfinished step, execute it, and validate the result. Do not restate the objective or repeat the prior response.",
      `At the very end, emit exactly one marker on its own line: ${markerNames(workflow)}. Missing or malformed markers pause the loop.`
    ].join("\n\n");
  }

  function workflowRecoveryPrompt(rawWorkflow, { cause = "watchdog" } = {}) {
    const workflow = normalizeWorkflow(rawWorkflow);
    if (workflow.status === "idle" || !workflow.kind || !workflow.objective) return "";
    const interruption = cause === "response-timeout"
      ? "The previous assistant turn did not produce a usable final response even after the conversation was refreshed."
      : "The previous assistant generation was stopped by a local stuck-generation watchdog because the page stopped making reliable progress.";
    return [
      `Resume the interrupted YOLO ${workflow.kind === "goal" ? "Goal" : "Loop"} workflow for: ${workflow.objective}`,
      interruption,
      "Continue from whatever partial work is already visible in this conversation. Do not repeat completed work and do not resend or reinterpret the previous user prompt from scratch. Do not wait for the previous turn to resume.",
      `This is task iteration ${workflow.totalIterations + 1} of at most ${workflow.maxIterations} (chat-local turn ${workflow.iteration + 1}).`,
      `At the very end, emit exactly one marker on its own line: ${markerNames(workflow)}. Missing or malformed markers pause the workflow.`
    ].join("\n\n");
  }

  function workflowPrompt(raw, phase = "initial") {
    const workflow = normalizeWorkflow(raw);
    if (workflow.status === "idle") return "";
    if (workflow.kind === "goal") return phase === "initial" ? goalInitialPrompt(workflow) : goalContinuationPrompt(workflow);
    return phase === "initial" ? loopInitialPrompt(workflow) : loopContinuationPrompt(workflow);
  }

  function evaluateResponse(text) {
    const source = String(text || "");
    const markers = [...source.matchAll(STANDALONE_MARKER_RE)].map((match) => match[1].toLowerCase());
    if (!markers.length) return "missing";
    const terminal = source.match(TERMINAL_MARKER_RE);
    if (!terminal || markers.length !== 1) return "malformed";
    return terminal[1].toLowerCase();
  }

  function decideWorkflowResponse(raw, responseText, { userFingerprint = "", at = Date.now() } = {}) {
    const workflow = normalizeWorkflow(raw, at);
    if (workflow.status !== "running" || !workflow.awaitingResponse) {
      return { workflow, action: "ignore", reason: "当前工作流并未等待回答", code: "workflow.not_waiting" };
    }
    if (!workflow.promptFingerprint || userFingerprint !== workflow.promptFingerprint) {
      return {
        workflow,
        action: "paused",
        reason: "对话已在当前工作流之外发生变化",
        code: "command.workflow.ownership_lost"
      };
    }

    const text = String(responseText || "").trim();
    if (!text) return { workflow, action: "ignore", reason: "当前没有可用的助手回答", code: "workflow.response_missing" };

    workflow.awaitingResponse = false;
    workflow.sawGeneration = false;
    workflow.responseCandidateFingerprint = "";
    workflow.responseCandidateSince = 0;
    workflow.responseActivityFingerprint = "";
    workflow.responseActivityAt = 0;
    workflow.lastAssistantFingerprint = fingerprint(text);
    workflow.lastResponseAt = at;
    workflow.iteration += 1;
    workflow.totalIterations += 1;
    workflow.updatedAt = at;
    const outcome = evaluateResponse(text);

    if (outcome === "done") {
      return { workflow, action: "completed", reason: "ChatGPT 已报告目标完成", code: "command.workflow.completed" };
    }
    if (outcome === "blocked") {
      return { workflow, action: "blocked", reason: "ChatGPT 需要用户输入或缺少必要访问权限", code: "command.workflow.blocked" };
    }
    if (outcome === "missing") {
      const label = workflow.kind === "goal" ? "目标任务" : "循环任务";
      return {
        workflow,
        action: "paused",
        reason: `${label} 的回答缺少必需的终止控制标记`,
        code: "command.workflow.marker_missing"
      };
    }
    if (outcome === "malformed") {
      const label = workflow.kind === "goal" ? "目标任务" : "循环任务";
      return {
        workflow,
        action: "paused",
        reason: `${label} 的回答包含多个终止控制标记或标记位置错误`,
        code: "command.workflow.marker_malformed"
      };
    }
    if (workflow.totalIterations >= workflow.maxIterations) {
      return {
        workflow,
        action: "paused",
        reason: `已达到 ${workflow.maxIterations} 回合的安全上限`,
        code: "command.workflow.cap_reached"
      };
    }
    if (outcome === "rollover") {
      if (!workflow.autoRolloverEnabled) {
        return { workflow, action: "paused", reason: "ChatGPT 请求切换对话，但当前工作流未启用自动切换", code: "command.workflow.rollover_disabled" };
      }
      return { workflow, action: "rollover", reason: "ChatGPT 请求提前切换到新对话", code: "command.workflow.rollover" };
    }
    return { workflow, action: "continue", reason: "继续工作流", code: "command.workflow.continue" };
  }

  function oneShotPrompt(name, args = "") {
    const scope = cleanText(args);
    if (name === "plan") {
      if (!scope) return "";
      return [
        `Plan this objective before implementation: ${scope}`,
        "Inspect the current conversation first. Produce a concrete, ordered plan with assumptions, dependencies, risks, validation criteria, and the smallest sensible execution sequence. Ask only for input that is genuinely required. Do not begin implementation yet."
      ].join("\n\n");
    }
    if (name === "review") {
      return [
        scope ? `Review scope: ${scope}` : "Review the work completed so far in this conversation.",
        "Perform an adversarial, evidence-based review. Find concrete correctness, reliability, security, UX, maintainability, and completeness issues. Prioritize findings by severity, avoid generic praise, verify assumptions against the actual work, and distinguish blockers from optional improvements."
      ].join("\n\n");
    }
    if (name === "fix") {
      return [
        scope ? `Fix scope: ${scope}` : "Fix the current work from the latest known state.",
        "Identify concrete defects and unfinished parts, repair them directly, validate the result, and continue until the scoped work is complete or a real blocker remains. Do not stop at a plan and do not repeat prior commentary."
      ].join("\n\n");
    }
    if (name === "handoff") {
      return [
        scope ? `Handoff focus: ${scope}` : "Write a continuation handoff for the current work.",
        "Summarize the objective, decisions, constraints, completed work, exact current state, unresolved defects, risks, relevant identifiers, validation evidence, and next actions. Remove incidental repetition. This is a written handoff only; do not claim that ChatGPT context was compacted, truncated, or changed."
      ].join("\n\n");
    }
    if (name === "continue") {
      return [
        scope ? `Continue with this direction: ${scope}` : "Continue from the current state and keep going deeper.",
        "Do not repeat the previous answer. Critically inspect assumptions, close gaps, execute the next concrete steps toward the original objective, and validate the result."
      ].join("\n\n");
    }
    return "";
  }

  function requiresArgs(name) {
    return ["goal", "loop", "plan"].includes(String(name || ""));
  }

  return Object.freeze({
    COMMANDS,
    MAX_OBJECTIVE_LENGTH,
    MAX_ITERATIONS,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_AUTO_ROLLOVER_TURNS,
    DEFAULT_AUTO_ROLLOVER_MAX_CONVERSATIONS,
    command,
    filterCommands,
    parseInvocation,
    parseLoopArgs,
    fingerprint,
    freshWorkflow,
    normalizeWorkflow,
    startWorkflow,
    setWorkflowStatus,
    workflowPrompt,
    workflowRecoveryPrompt,
    evaluateResponse,
    decideWorkflowResponse,
    oneShotPrompt,
    requiresArgs
  });
});
