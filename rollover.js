((root, factory) => {
  const Commands = typeof module === "object" && module.exports ? require("./commands.js") : root.YOLOCommands;
  const api = factory(Commands);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YOLORollover = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (Commands) => {
  "use strict";

  const HANDOFF_BEGIN = "[YOLO_ROLLOVER_HANDOFF_BEGIN]";
  const HANDOFF_END = "[YOLO_ROLLOVER_HANDOFF_END]";
  const MAX_HANDOFF_LENGTH = 60_000;
  const MAX_FOCUS_LENGTH = 2_000;
  const PHASES = new Set([
    "handoff_queued",
    "awaiting_handoff",
    "bootstrap_pending",
    "bootstrap_submitting",
    "bootstrap_sent",
    "bound",
    "blocked"
  ]);
  const REQUIRED_FIELDS = Object.freeze([
    "TASK",
    "OBJECTIVE",
    "NON_NEGOTIABLE_CONSTRAINTS",
    "REPOSITORY",
    "BRANCH",
    "HEAD",
    "WORKTREE_STATE",
    "COMPLETED",
    "VERIFIED_FACTS",
    "CURRENT_WORK",
    "NEXT_ACTIONS",
    "DO_NOT_REPEAT",
    "OPEN_QUESTIONS",
    "USER_DECISIONS",
    "TEST_STATUS",
    "IMPORTANT_FILES",
    "BLOCKERS"
  ]);

  const clean = (value, max = MAX_HANDOFF_LENGTH) => String(value ?? "").trim().slice(0, max);
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  function freshTransaction(at = Date.now()) {
    return {
      version: 1,
      revision: 0,
      id: "",
      phase: "blocked",
      sourcePageId: "",
      targetPageId: "",
      sourceWorkflow: null,
      focus: "",
      tabId: -1,
      ownerId: "",
      pendingItemId: "",
      handoffPrompt: "",
      handoffPromptFingerprint: "",
      baselineAssistantFingerprint: "",
      responseCandidateFingerprint: "",
      responseCandidateSince: 0,
      lastPromptAt: 0,
      handoff: "",
      handoffFingerprint: "",
      bootstrapPrompt: "",
      bootstrapPromptFingerprint: "",
      bootstrapSubmittedAt: 0,
      reason: "",
      createdAt: at,
      updatedAt: at
    };
  }

  function workflowSnapshot(raw) {
    const workflow = Commands.normalizeWorkflow(raw);
    if (workflow.status === "idle" || !workflow.kind || !workflow.objective) return null;
    return {
      kind: workflow.kind,
      objective: clean(workflow.objective, Commands.MAX_OBJECTIVE_LENGTH),
      maxIterations: workflow.maxIterations,
      iteration: workflow.iteration,
      status: workflow.status
    };
  }

  function normalizeTransaction(raw, at = Date.now()) {
    const fallback = freshTransaction(at);
    if (!raw || typeof raw !== "object") return fallback;
    const phase = PHASES.has(raw.phase) ? raw.phase : "blocked";
    return {
      ...fallback,
      version: 1,
      revision: Math.max(0, Math.round(finite(raw.revision, 0))),
      id: clean(raw.id, 180),
      phase,
      sourcePageId: clean(raw.sourcePageId, 1_000),
      targetPageId: clean(raw.targetPageId, 1_000),
      sourceWorkflow: workflowSnapshot(raw.sourceWorkflow),
      focus: clean(raw.focus, MAX_FOCUS_LENGTH),
      tabId: Math.round(finite(raw.tabId, -1)),
      ownerId: clean(raw.ownerId, 220),
      pendingItemId: clean(raw.pendingItemId, 180),
      handoffPrompt: clean(raw.handoffPrompt),
      handoffPromptFingerprint: clean(raw.handoffPromptFingerprint, 180),
      baselineAssistantFingerprint: clean(raw.baselineAssistantFingerprint, 180),
      responseCandidateFingerprint: clean(raw.responseCandidateFingerprint, 180),
      responseCandidateSince: Math.max(0, finite(raw.responseCandidateSince, 0)),
      lastPromptAt: Math.max(0, finite(raw.lastPromptAt, 0)),
      handoff: clean(raw.handoff),
      handoffFingerprint: clean(raw.handoffFingerprint, 180),
      bootstrapPrompt: clean(raw.bootstrapPrompt),
      bootstrapPromptFingerprint: clean(raw.bootstrapPromptFingerprint, 180),
      bootstrapSubmittedAt: Math.max(0, finite(raw.bootstrapSubmittedAt, 0)),
      reason: clean(raw.reason, 500),
      createdAt: finite(raw.createdAt, at),
      updatedAt: finite(raw.updatedAt, at)
    };
  }

  function handoffPrompt({ focus = "", sourceWorkflow = null } = {}) {
    const workflow = workflowSnapshot(sourceWorkflow);
    const objective = workflow?.objective || "Continue the current work from the exact state reached in this conversation.";
    const focusText = clean(focus, MAX_FOCUS_LENGTH);
    return [
      "Prepare a machine-readable rollover handoff for a new ChatGPT conversation.",
      `Primary objective: ${objective}`,
      focusText ? `Rollover focus: ${focusText}` : "Preserve all material constraints and the exact unfinished execution state.",
      "Do not continue implementation in this response. Produce only one complete handoff envelope using the exact markers and field labels below.",
      "Every field is required. Use NONE when a field genuinely has no content. Do not omit fields and do not emit a second envelope.",
      [
        HANDOFF_BEGIN,
        "TASK:",
        "OBJECTIVE:",
        "NON_NEGOTIABLE_CONSTRAINTS:",
        "REPOSITORY:",
        "BRANCH:",
        "HEAD:",
        "WORKTREE_STATE:",
        "COMPLETED:",
        "VERIFIED_FACTS:",
        "CURRENT_WORK:",
        "NEXT_ACTIONS:",
        "DO_NOT_REPEAT:",
        "OPEN_QUESTIONS:",
        "USER_DECISIONS:",
        "TEST_STATUS:",
        "IMPORTANT_FILES:",
        "BLOCKERS:",
        HANDOFF_END
      ].join("\n")
    ].join("\n\n");
  }

  function extractHandoff(text) {
    const source = String(text || "");
    const firstBegin = source.indexOf(HANDOFF_BEGIN);
    const lastBegin = source.lastIndexOf(HANDOFF_BEGIN);
    const firstEnd = source.indexOf(HANDOFF_END);
    const lastEnd = source.lastIndexOf(HANDOFF_END);
    if (firstBegin < 0 || firstEnd < 0) return { ok: false, code: "rollover.handoff_missing", reason: "Rollover handoff markers are missing" };
    if (firstBegin !== lastBegin || firstEnd !== lastEnd || firstEnd <= firstBegin) {
      return { ok: false, code: "rollover.handoff_ambiguous", reason: "Rollover handoff must contain exactly one complete envelope" };
    }
    const handoff = source.slice(firstBegin, firstEnd + HANDOFF_END.length).trim();
    if (handoff.length > MAX_HANDOFF_LENGTH) return { ok: false, code: "rollover.handoff_too_large", reason: "Rollover handoff exceeds the local safety limit" };
    const missing = REQUIRED_FIELDS.filter((field) => !new RegExp(`(?:^|\\n)${field}:`, "m").test(handoff));
    if (missing.length) {
      return { ok: false, code: "rollover.handoff_incomplete", reason: `Rollover handoff is missing required fields: ${missing.join(", ")}`, missing };
    }
    return { ok: true, handoff, fingerprint: Commands.fingerprint(handoff) };
  }

  function bootstrapPrompt(rawTransaction) {
    const transaction = normalizeTransaction(rawTransaction);
    if (!transaction.handoff) return "";
    const workflow = transaction.sourceWorkflow;
    const markerInstruction = workflow
      ? "At the very end of your response, emit exactly one marker on its own line: [YOLO:CONTINUE] if more work remains, [YOLO:DONE] only when the objective is genuinely complete, or [YOLO:BLOCKED] only when specific user input or unavailable access is required."
      : "Continue the unfinished work directly; do not merely restate the handoff.";
    return [
      "You are continuing a long-running task from a previous ChatGPT conversation.",
      "The handoff below is a locator, not a substitute for external truth. Before changing anything, verify the real current state when tools are available: repository, branch, HEAD, worktree, relevant handoff/docs, CI, tests, and any other external state named below. If reality conflicts with the handoff, trust reality and report the discrepancy.",
      "Do not restart completed work. Preserve the user's explicit constraints and decisions. Resume from CURRENT_WORK / NEXT_ACTIONS and make concrete progress now.",
      transaction.handoff,
      markerInstruction
    ].join("\n\n");
  }

  function createTransaction({ sourcePageId = "", sourceWorkflow = null, focus = "", tabId = -1, ownerId = "", baselineAssistantFingerprint = "" } = {}, at = Date.now()) {
    const prompt = handoffPrompt({ focus, sourceWorkflow });
    return normalizeTransaction({
      ...freshTransaction(at),
      id: `rollover-${Commands.fingerprint(`${sourcePageId}:${at}:${ownerId}`)}-${at}`,
      phase: "handoff_queued",
      sourcePageId,
      sourceWorkflow,
      focus,
      tabId,
      ownerId,
      handoffPrompt: prompt,
      handoffPromptFingerprint: Commands.fingerprint(prompt),
      baselineAssistantFingerprint,
      lastPromptAt: at,
      reason: "Handoff prompt queued",
      createdAt: at,
      updatedAt: at
    }, at);
  }

  function withRevision(rawTransaction, patch, at = Date.now()) {
    const current = normalizeTransaction(rawTransaction, at);
    return normalizeTransaction({ ...current, ...patch, revision: current.revision + 1, updatedAt: at }, at);
  }

  function acceptHandoff(rawTransaction, responseText, { userFingerprint = "", at = Date.now() } = {}) {
    const current = normalizeTransaction(rawTransaction, at);
    if (current.phase !== "awaiting_handoff") {
      return { ok: false, transaction: current, code: "rollover.not_waiting", reason: "Rollover is not awaiting a handoff response" };
    }
    if (!current.handoffPromptFingerprint || userFingerprint !== current.handoffPromptFingerprint) {
      return { ok: false, transaction: current, code: "rollover.ownership_lost", reason: "Conversation advanced outside the rollover handoff" };
    }
    const extracted = extractHandoff(responseText);
    if (!extracted.ok) return { ...extracted, transaction: current };
    const staged = withRevision(current, {
      phase: "bootstrap_pending",
      pendingItemId: "",
      handoff: extracted.handoff,
      handoffFingerprint: extracted.fingerprint,
      responseCandidateFingerprint: "",
      responseCandidateSince: 0,
      reason: "Handoff captured; new-chat bootstrap pending"
    }, at);
    const prompt = bootstrapPrompt(staged);
    return {
      ok: true,
      transaction: normalizeTransaction({
        ...staged,
        bootstrapPrompt: prompt,
        bootstrapPromptFingerprint: Commands.fingerprint(prompt)
      }, at)
    };
  }

  return Object.freeze({
    HANDOFF_BEGIN,
    HANDOFF_END,
    REQUIRED_FIELDS,
    PHASES,
    MAX_HANDOFF_LENGTH,
    freshTransaction,
    workflowSnapshot,
    normalizeTransaction,
    handoffPrompt,
    extractHandoff,
    bootstrapPrompt,
    createTransaction,
    withRevision,
    acceptHandoff
  });
});
