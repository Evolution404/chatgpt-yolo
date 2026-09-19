(() => {
  "use strict";

  const Config = globalThis.YOLOConfig;
  const Shared = globalThis.YOLOShared;
  const Lifecycle = globalThis.YOLOLifecycle;
  const Platforms = globalThis.YOLOPlatforms;
  const Commands = globalThis.YOLOCommands;
  const Rollover = globalThis.YOLORollover;
  const CommandUI = globalThis.YOLOCommandUI;
  if (!Config || !Shared || !Lifecycle || !Platforms || !Commands || !Rollover || !CommandUI) return;

  if (window.__YOLO_COMMAND_RUNTIME__?.version === Config.VERSION) return;
  window.__YOLO_COMMAND_RUNTIME__?.destroy?.();

  const POLL_MS = Lifecycle.VISIBLE_WORKFLOW_POLL_MS;
  const RESPONSE_SETTLE_MS = 1200;
  const state = {
    destroyed: false,
    pageId: "",
    workflow: Commands.freshWorkflow(),
    rollover: null,
    rolloverLoaded: false,
    ui: null,
    pollTimer: null,
    routeInFlight: false,
    tickInFlight: false,
    lastQueueAttemptAt: 0,
    unregisterEngineClient: null,
    lifecycleHandlers: [],
    mutationLock: Shared.createLock(),
    ownerId: Shared.makeId("command")
  };

  const now = () => Date.now();
  const engine = () => window.__YOLO_EXTENSION__?.commandApi || null;

  const withWorkflowLock = (task) => Shared.withLock(state.mutationLock, task);

  const backgroundSend = (message) => Shared.sendMessage(message, {
    soft: true,
    isDestroyed: () => state.destroyed
  });

  function applyRolloverResponse(response) {
    if (response?.ok) state.rollover = response.transaction ? Rollover.normalizeTransaction(response.transaction) : null;
    return response;
  }

  async function readRollover() {
    const response = applyRolloverResponse(await backgroundSend({ type: "YOLO_ROLLOVER_GET" }));
    state.rolloverLoaded = true;
    return response?.ok ? state.rollover : null;
  }

  async function ensureRolloverLoaded() {
    if (!state.rolloverLoaded) await readRollover();
    return state.rollover;
  }

  async function writeRollover(transaction) {
    const current = state.rollover;
    if (!current || !transaction || current.id !== transaction.id) return false;
    const response = applyRolloverResponse(await backgroundSend({
      type: "YOLO_ROLLOVER_UPDATE",
      expectedRevision: current.revision,
      transaction: Rollover.normalizeTransaction({ ...transaction, revision: current.revision, updatedAt: now() })
    }));
    return Boolean(response?.ok);
  }

  async function blockRollover(reason, code = "rollover.blocked") {
    const current = state.rollover;
    if (!current) return false;
    const next = Rollover.normalizeTransaction({ ...current, phase: "blocked", reason, updatedAt: now() });
    const saved = await writeRollover(next);
    if (saved) await record(`Rollover blocked: ${reason}`, "warning", code);
    return saved;
  }


  function adapter() {
    return Platforms.adapterForLocation();
  }

  function composer() {
    return Platforms.findComposer(adapter());
  }

  function composerText() {
    return Platforms.composerText(composer());
  }

  function setComposerText(value) {
    const target = composer();
    if (!target) return false;
    Platforms.setComposerValue(target, value);
    return true;
  }

  function latestAssistantFingerprint() {
    return Commands.fingerprint(Platforms.latestAssistantText(adapter()));
  }

  function latestUserFingerprint() {
    return Commands.fingerprint(Platforms.latestUserText(adapter()));
  }

  async function record(message, level = "info", code = "command.status", log = true) {
    const api = engine();
    if (api?.recordStatus) await api.recordStatus(message, level, code, log);
  }

  function applyWorkflowResponse(response, targetPageId = state.pageId) {
    if (response?.workflow && state.pageId === targetPageId) {
      state.workflow = Commands.normalizeWorkflow(response.workflow);
      syncUI();
    }
  }

  async function readWorkflow(pageId = state.pageId) {
    const response = await backgroundSend({ type: "YOLO_WORKFLOW_GET", pageId });
    return response?.ok ? Commands.normalizeWorkflow(response.workflow) : Commands.freshWorkflow();
  }

  async function refreshWorkflow(pageId = state.pageId) {
    const workflow = await readWorkflow(pageId);
    if (state.pageId === pageId) {
      state.workflow = workflow;
      syncUI();
    }
    return workflow;
  }

  async function writeWorkflow(workflow = state.workflow, pageId = state.pageId) {
    const normalized = Commands.normalizeWorkflow(workflow);
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_SET",
      pageId,
      expectedRevision: normalized.revision,
      workflow: normalized
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function clearWorkflow(pageId = state.pageId) {
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_CLEAR",
      pageId,
      expectedRevision: state.workflow.revision
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  async function claimWorkflow() {
    const pageId = state.pageId;
    const response = await backgroundSend({
      type: "YOLO_WORKFLOW_CLAIM",
      pageId,
      ownerId: state.ownerId
    });
    applyWorkflowResponse(response, pageId);
    return Boolean(response?.ok && state.pageId === pageId);
  }

  function releaseWorkflow() {
    if (!state.pageId || state.workflow.runnerId !== state.ownerId) return;
    backgroundSend({
      type: "YOLO_WORKFLOW_RELEASE",
      pageId: state.pageId,
      ownerId: state.ownerId
    });
  }

  async function queueState(pageId = state.pageId) {
    return backgroundSend({ type: "YOLO_QUEUE_GET", pageId });
  }

  async function removeQueueItem(itemId, pageId = state.pageId) {
    if (!itemId) return true;
    const response = await backgroundSend({ type: "YOLO_QUEUE_REMOVE", pageId, itemId });
    return Boolean(response?.ok || response?.code === "queue.not_found");
  }

  async function queuePrompt(text, { workflow = null, source = "command" } = {}) {
    const prompt = String(text || "").trim();
    const pageId = state.pageId;
    if (!prompt) return { ok: false, reason: "Command produced an empty prompt" };

    let response;
    if (workflow) {
      const next = Commands.normalizeWorkflow(workflow);
      next.awaitingResponse = false;
      next.sawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.baselineFingerprint = latestAssistantFingerprint();
      next.lastAssistantFingerprint = next.baselineFingerprint;
      next.promptFingerprint = Commands.fingerprint(prompt);
      next.lastPromptAt = now();
      next.reason = "Queued command prompt";
      next.updatedAt = now();
      response = await backgroundSend({
        type: "YOLO_WORKFLOW_QUEUE_ADD",
        pageId,
        expectedRevision: next.revision,
        ownerId: state.ownerId,
        workflow: next,
        item: {
          text: prompt,
          source,
          sourceId: next.id
        }
      });
      applyWorkflowResponse(response, pageId);
    } else {
      response = await backgroundSend({
        type: "YOLO_QUEUE_ADD",
        pageId,
        front: true,
        item: { text: prompt, source, sourceId: "" }
      });
    }
    if (!response?.ok) return response || { ok: false, reason: "Could not add the command prompt to the queue" };

    const api = engine();
    const sent = api ? await api.runAction("queue-next") : false;
    if (workflow && sent && state.pageId === pageId) await refreshWorkflow(pageId);
    return { ...response, sent };
  }

  async function cancelPendingWorkflowPrompt(workflow = state.workflow) {
    if (!workflow.pendingItemId) return { ok: true, removed: false };
    const response = await backgroundSend({
      type: "YOLO_QUEUE_REMOVE",
      pageId: state.pageId,
      itemId: workflow.pendingItemId
    });
    if (response?.ok || response?.code === "queue.not_found") return { ok: true, removed: true };
    if (response?.code === "queue.sending") {
      return { ok: true, removed: false, reason: "The current workflow prompt is already sending and cannot be unsent" };
    }
    return { ok: false, removed: false, reason: response?.reason || "Could not remove the pending workflow prompt" };
  }

  async function startWorkflow(kind, args) {
    await syncRoute();
    const latest = await readWorkflow(state.pageId);
    state.workflow = latest;
    syncUI();

    if (latest.status !== "idle") {
      if (latest.status === "running" && (latest.pendingItemId || latest.awaitingResponse || engine()?.getState?.().generating)) {
        return { ok: false, reason: "Pause or stop the active workflow after its current turn finishes before replacing it", keepOpen: true };
      }
      if (!window.confirm(`Replace the active ${latest.kind} workflow?`)) {
        return { ok: false, reason: "Existing workflow kept", keepOpen: true };
      }
      const cancelled = await cancelPendingWorkflowPrompt(latest);
      if (!cancelled.ok) return { ok: false, reason: cancelled.reason, keepOpen: true };
    }

    const current = Commands.startWorkflow(kind, args, {
      at: now(),
      baselineFingerprint: latestAssistantFingerprint()
    });
    if (!current.ok) return { ...current, keepOpen: true };
    current.workflow.revision = latest.revision;
    current.workflow.runnerId = state.ownerId;
    state.workflow = current.workflow;
    const prompt = Commands.workflowPrompt(state.workflow, "initial");
    const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${kind}` });
    if (!queued.ok) {
      await markWorkflow("blocked", queued.reason || "Could not queue workflow prompt", `command.${kind}.blocked`);
      return { ...queued, keepOpen: true };
    }
    await record(`Started /${kind}: ${state.workflow.objective}`, "success", `command.${kind}.started`);
    return { ok: true };
  }

  async function runOneShot(name, args) {
    if (state.workflow.status === "running") {
      return { ok: false, reason: "Pause the active goal or loop before running another prompt command", keepOpen: true };
    }
    const prompt = Commands.oneShotPrompt(name, args);
    if (!prompt) return { ok: false, reason: `/${name} requires more detail`, keepOpen: true };
    const queued = await queuePrompt(prompt, { source: `command:${name}` });
    if (!queued.ok) {
      await record(`/${name} failed: ${queued.reason || "queue unavailable"}`, "error", `command.${name}.failed`);
      return { ...queued, keepOpen: true };
    }
    await record(queued.sent ? `Ran /${name}` : `Queued /${name}`, "success", `command.${name}`);
    return { ok: true };
  }

  async function setStatus(status, reason) {
    if (state.workflow.status === "idle") return { ok: false, reason: "No active goal or loop", keepOpen: true };
    if (status === "paused") {
      const cancelled = await cancelPendingWorkflowPrompt(state.workflow);
      if (!cancelled.ok || (state.workflow.pendingItemId && !cancelled.removed)) {
        return { ok: false, reason: cancelled.reason || "The workflow prompt is already sending", keepOpen: true };
      }
      if (cancelled.reason) reason = `${reason}. ${cancelled.reason}`;
    }
    const next = Commands.setWorkflowStatus(state.workflow, status, reason, now());
    const ok = await writeWorkflow(next);
    if (ok) await record(`${state.workflow.kind} ${status}`, status === "blocked" ? "warning" : "info", `command.workflow.${status}`);
    return { ok, reason: ok ? "" : "Workflow changed in another tab", keepOpen: !ok };
  }

  async function resumeWorkflow() {
    if (!["paused", "blocked"].includes(state.workflow.status)) return { ok: false, reason: "Workflow is not paused", keepOpen: true };
    const next = Commands.normalizeWorkflow(state.workflow);
    next.status = "running";
    next.reason = "Resumed by user";
    next.updatedAt = now();
    const prompt = Commands.workflowPrompt(next, next.iteration === 0 ? "initial" : "continue");
    return queuePrompt(prompt, { workflow: next, source: `workflow:${next.kind}` });
  }

  async function showStatus() {
    const apiState = engine()?.getState?.() || {};
    const queue = await queueState();
    const workflow = Commands.normalizeWorkflow(state.workflow);
    state.ui?.showStatus({
      Conversation: state.pageId || "Unavailable",
      Workflow: workflow.status === "idle" ? "None" : `/${workflow.kind} · ${workflow.status}`,
      Rollover: state.rollover ? state.rollover.phase : "None",
      Objective: workflow.status === "idle" ? "—" : workflow.objective,
      Iteration: workflow.status === "idle" ? "—" : `${workflow.iteration}/${workflow.maxIterations}`,
      Queue: queue?.ok ? `${queue.state.items.length} item${queue.state.items.length === 1 ? "" : "s"}${queue.state.paused ? " · paused" : ""}` : "Unavailable",
      Runner: workflow.status === "running" ? (workflow.runnerId === state.ownerId ? "This tab" : (workflow.runnerId ? "Another tab" : "Acquiring")) : "—",
      Generation: apiState.generating ? "Active" : "Idle",
      Profile: apiState.settings?.profile || "Unknown",
      "Session actions": apiState.runtime?.sessionActionCount ?? 0,
      "Last action": apiState.lastAction?.message || "Idle"
    });
    return { ok: true, focusComposer: false };
  }

  async function startRollover(args = "") {
    await syncRoute();
    await ensureRolloverLoaded();
    if (!Config.isDurablePageId(state.pageId)) return { ok: false, reason: "Open a saved ChatGPT conversation before starting rollover", keepOpen: true };
    if (state.rollover && state.rollover.phase !== "bound") {
      return { ok: false, reason: `Rollover is already ${state.rollover.phase.replaceAll("_", " ")}`, keepOpen: true };
    }
    const api = engine();
    const apiState = api?.getState?.() || {};
    if (apiState.generating) return { ok: false, reason: "Wait for the current ChatGPT response to finish before rollover", keepOpen: true };

    const latest = await readWorkflow(state.pageId);
    state.workflow = latest;
    syncUI();
    if (latest.status === "running") {
      return { ok: false, reason: "Pause the active goal or loop before manual rollover so no workflow turn can race the handoff", keepOpen: true };
    }

    const response = applyRolloverResponse(await backgroundSend({
      type: "YOLO_ROLLOVER_START",
      pageId: state.pageId,
      focus: args,
      ownerId: state.ownerId,
      baselineAssistantFingerprint: latestAssistantFingerprint(),
      sourceWorkflow: latest
    }));
    if (!response?.ok) return { ...response, keepOpen: true };
    const sent = await api?.runAction?.("queue-next");
    await record(sent ? "Started rollover handoff" : "Queued rollover handoff", "success", "command.rollover.started");
    return { ok: true };
  }

  async function handleRolloverHandoffQueue(transaction, apiState) {
    const queue = await queueState(transaction.sourcePageId);
    if (!queue?.ok) return false;
    const item = queue.state.items.find((entry) => entry.id === transaction.pendingItemId);
    if (item?.state === "failed") {
      await removeQueueItem(item.id, transaction.sourcePageId);
      await blockRollover(item.error || "Rollover handoff prompt failed", "rollover.handoff_delivery_failed");
      return true;
    }
    if (item) {
      if (!apiState.generating && now() - state.lastQueueAttemptAt >= POLL_MS) {
        state.lastQueueAttemptAt = now();
        await engine()?.runAction?.("queue-next");
      }
      return false;
    }
    const completedExactly = queue.state.completions.some((completion) =>
      completion.itemId === transaction.pendingItemId && completion.sourceId === transaction.id);
    if (!completedExactly) {
      await blockRollover("Rollover handoff prompt disappeared before confirmed delivery", "rollover.handoff_prompt_removed");
      return true;
    }
    const next = Rollover.normalizeTransaction({
      ...transaction,
      phase: "awaiting_handoff",
      pendingItemId: "",
      reason: "Waiting for strict handoff response",
      updatedAt: now()
    });
    return writeRollover(next);
  }

  async function handleRolloverHandoffResponse(transaction, apiState) {
    if (apiState.generating || now() - transaction.lastPromptAt < RESPONSE_SETTLE_MS) return false;
    const assistantText = Platforms.latestAssistantText(adapter());
    const candidateFingerprint = Commands.fingerprint(assistantText);
    if (!assistantText || candidateFingerprint === transaction.baselineAssistantFingerprint) return false;
    if (transaction.responseCandidateFingerprint !== candidateFingerprint) {
      const next = Rollover.normalizeTransaction({
        ...transaction,
        responseCandidateFingerprint: candidateFingerprint,
        responseCandidateSince: now(),
        reason: "Waiting for rollover handoff response to settle",
        updatedAt: now()
      });
      await writeRollover(next);
      return false;
    }
    const quietSince = Math.max(transaction.responseCandidateSince, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
    if (now() - quietSince < Lifecycle.MARKER_RESPONSE_STABLE_MS) return false;
    const accepted = Rollover.acceptHandoff(transaction, assistantText, {
      userFingerprint: latestUserFingerprint(),
      at: now()
    });
    if (!accepted.ok) {
      await blockRollover(accepted.reason || "Rollover handoff was invalid", accepted.code || "rollover.handoff_invalid");
      return true;
    }
    if (!await writeRollover(accepted.transaction)) return false;
    await record("Captured rollover handoff; opening a new chat", "success", "rollover.handoff_captured");
    location.assign(`${location.origin}/`);
    return true;
  }

  async function adoptRolloverWorkflow(transaction) {
    if (!Config.isDurablePageId(state.pageId) || state.pageId !== transaction.targetPageId) return false;
    const source = transaction.sourceWorkflow;
    if (!source || source.status === "completed") {
      return writeRollover(Rollover.normalizeTransaction({ ...transaction, phase: "bound", reason: "Successor conversation bound", updatedAt: now() }));
    }

    const current = await readWorkflow(state.pageId);
    if (current.status !== "idle") {
      const alreadyAdopted = current.kind === source.kind
        && current.objective === source.objective
        && current.promptFingerprint === transaction.bootstrapPromptFingerprint;
      if (alreadyAdopted) {
        state.workflow = current;
        syncUI();
        return writeRollover(Rollover.normalizeTransaction({ ...transaction, phase: "bound", reason: "Successor workflow already adopted", updatedAt: now() }));
      }
      await blockRollover("The successor conversation already contains a different YOLO workflow", "rollover.target_workflow_conflict");
      return true;
    }

    const args = source.kind === "loop" ? `${source.maxIterations} ${source.objective}` : source.objective;
    const started = Commands.startWorkflow(source.kind, args, {
      at: now(),
      baselineFingerprint: latestAssistantFingerprint()
    });
    if (!started.ok) {
      await blockRollover(started.reason || "Could not restore the workflow in the successor conversation", "rollover.workflow_restore_failed");
      return true;
    }
    const workflow = Commands.normalizeWorkflow({
      ...started.workflow,
      iteration: 0,
      pendingItemId: "",
      awaitingResponse: true,
      sawGeneration: Boolean(engine()?.getState?.().generating),
      promptFingerprint: transaction.bootstrapPromptFingerprint,
      lastPromptAt: transaction.bootstrapSubmittedAt || now(),
      runnerId: "",
      runnerExpiresAt: 0,
      reason: "Resumed after conversation rollover",
      updatedAt: now()
    });
    state.workflow = workflow;
    const saved = await writeWorkflow(workflow, state.pageId);
    if (!saved) {
      await blockRollover("Could not persist the restored workflow in the successor conversation", "rollover.workflow_restore_conflict");
      return true;
    }
    return writeRollover(Rollover.normalizeTransaction({ ...state.rollover, phase: "bound", reason: "Successor conversation and workflow bound", updatedAt: now() }));
  }

  async function handleRolloverBootstrap(transaction) {
    const api = engine();
    const currentPageId = Config.pageId(location.href);
    if (transaction.phase === "bootstrap_submitting") {
      if (Config.isDurablePageId(currentPageId) && latestUserFingerprint() === transaction.bootstrapPromptFingerprint) {
        const recovered = Rollover.normalizeTransaction({
          ...transaction,
          phase: "bootstrap_sent",
          targetPageId: currentPageId,
          bootstrapSubmittedAt: transaction.bootstrapSubmittedAt || now(),
          reason: "Recovered confirmed bootstrap after route transition",
          updatedAt: now()
        });
        if (await writeRollover(recovered)) {
          await syncRoute();
          return adoptRolloverWorkflow(state.rollover);
        }
        return false;
      }
      await blockRollover("Bootstrap submission outcome is unknown on the transient route; automatic retry is disabled", "rollover.bootstrap_unknown");
      return true;
    }
    if (transaction.phase === "bootstrap_sent") {
      await syncRoute();
      if (state.pageId !== transaction.targetPageId) {
        await blockRollover("The tab left the confirmed successor conversation before workflow adoption", "rollover.target_route_lost");
        return true;
      }
      return adoptRolloverWorkflow(state.rollover || transaction);
    }
    if (transaction.phase !== "bootstrap_pending") return false;
    if (Config.isDurablePageId(currentPageId)) {
      await blockRollover("The tab navigated to another saved conversation before the new-chat bootstrap started", "rollover.route_conflict");
      return true;
    }
    if (!api || !await api.ensureReady()) return false;

    const submitting = Rollover.normalizeTransaction({
      ...transaction,
      phase: "bootstrap_submitting",
      bootstrapSubmittedAt: now(),
      reason: "Bootstrap submission intent persisted",
      updatedAt: now()
    });
    if (!await writeRollover(submitting)) return false;
    const result = await api.submitTransientBootstrap(state.rollover.bootstrapPrompt);
    if (!result?.ok) {
      await blockRollover(result?.reason || "Bootstrap submission failed", result?.code || "rollover.bootstrap_failed");
      return true;
    }
    await syncRoute();
    const sent = Rollover.normalizeTransaction({
      ...state.rollover,
      phase: "bootstrap_sent",
      targetPageId: result.targetPageId,
      reason: "Exact bootstrap message confirmed in successor conversation",
      updatedAt: now()
    });
    if (!await writeRollover(sent)) return false;
    return adoptRolloverWorkflow(state.rollover);
  }

  async function handleRollover() {
    const transaction = await ensureRolloverLoaded();
    if (!transaction || ["bound", "blocked"].includes(transaction.phase)) return false;
    const currentPageId = Config.pageId(location.href);
    if (currentPageId === transaction.sourcePageId) {
      const apiState = engine()?.getState?.() || {};
      if (transaction.phase === "handoff_queued") return handleRolloverHandoffQueue(transaction, apiState);
      if (transaction.phase === "awaiting_handoff") return handleRolloverHandoffResponse(transaction, apiState);
      if (transaction.phase === "bootstrap_pending") {
        location.assign(`${location.origin}/`);
        return true;
      }
      if (["bootstrap_submitting", "bootstrap_sent"].includes(transaction.phase)) {
        await blockRollover("The tab returned to the source conversation after bootstrap submission began; automatic recovery is unsafe", "rollover.source_route_returned");
        return true;
      }
      return false;
    }
    return handleRolloverBootstrap(transaction);
  }

  async function executeCommandUnlocked(name, args = "") {
    await syncRoute();
    const api = engine();
    if (!api || !await api.ensureReady()) return { ok: false, reason: "YOLO is not ready in this conversation", keepOpen: true };
    await ensureRolloverLoaded();
    if (name === "rollover") return startRollover(args);
    if (["goal", "loop"].includes(name)) return startWorkflow(name, args);
    if (["plan", "review", "fix", "handoff", "continue"].includes(name)) return runOneShot(name, args);
    if (name === "status") return showStatus();
    if (name === "pause") return setStatus("paused", "Paused by user");
    if (name === "resume") return resumeWorkflow();
    if (name === "stop") {
      if (state.workflow.status === "idle") return { ok: false, reason: "No active goal or loop", keepOpen: true };
      if (!window.confirm(`Stop and clear the active ${state.workflow.kind} workflow?`)) return { ok: false, reason: "Workflow kept", keepOpen: true };
      const cancelled = await cancelPendingWorkflowPrompt(state.workflow);
      if (!cancelled.ok || (state.workflow.pendingItemId && !cancelled.removed)) {
        return { ok: false, reason: cancelled.reason || "The workflow prompt is already sending", keepOpen: true };
      }
      const ok = await clearWorkflow();
      if (ok) await record(cancelled.reason || "Stopped and cleared command workflow", "info", "command.workflow.stopped");
      return { ok, reason: ok ? "" : "Workflow changed in another tab", keepOpen: !ok };
    }
    if (name === "settings") {
      chrome.runtime.openOptionsPage?.();
      return { ok: true, focusComposer: false };
    }
    if (name === "help") {
      state.ui?.open();
      return { ok: true, keepOpen: true, focusComposer: false };
    }
    return { ok: false, reason: "Unknown command", keepOpen: true };
  }

  function executeCommand(name, args = "") {
    return withWorkflowLock(() => executeCommandUnlocked(name, args));
  }

  function syncUI() {
    state.ui?.update({ workflow: state.workflow });
  }

  async function syncRoute() {
    const nextPageId = Config.pageId(location.href);
    if (!Config.isSupportedUrl(location.href) || nextPageId === state.pageId || state.routeInFlight) return;
    state.routeInFlight = true;
    try {
      state.pageId = nextPageId;
      state.workflow = await readWorkflow(nextPageId);
      syncUI();
    } finally {
      state.routeInFlight = false;
    }
  }

  async function markWorkflow(status, reason, code) {
    const next = Commands.setWorkflowStatus(state.workflow, status, reason, now());
    const saved = await writeWorkflow(next);
    if (saved) await record(`${state.workflow.kind} ${status}: ${reason}`, status === "completed" ? "success" : "warning", code);
    return saved;
  }

  async function processResponse() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const text = Platforms.latestAssistantText(adapter());
    const fingerprint = Commands.fingerprint(text);
    if (!text || fingerprint === workflow.baselineFingerprint || fingerprint === workflow.lastAssistantFingerprint) return false;

    const decision = Commands.decideWorkflowResponse(workflow, text, {
      userFingerprint: latestUserFingerprint(),
      at: now()
    });
    state.workflow = decision.workflow;
    if (decision.action === "ignore") return false;
    if (decision.action !== "continue") {
      await markWorkflow(decision.action, decision.reason, decision.code);
      return true;
    }

    const prompt = Commands.workflowPrompt(state.workflow, "continue");
    const queued = await queuePrompt(prompt, { workflow: state.workflow, source: `workflow:${state.workflow.kind}` });
    if (!queued.ok) await markWorkflow("blocked", queued.reason || "Could not queue the next workflow iteration", "command.workflow.queue_failed");
    return true;
  }

  async function handlePendingWorkflowItem(apiState) {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    const queue = await queueState();
    if (!queue?.ok) return false;
    const item = queue.state.items.find((entry) => entry.id === workflow.pendingItemId);
    if (item?.state === "failed") {
      const removed = await removeQueueItem(item.id);
      const reason = removed
        ? (item.error || "Workflow prompt failed")
        : `${item.error || "Workflow prompt failed"}. The failed queue item could not be removed.`;
      await markWorkflow("blocked", reason, "command.workflow.delivery_failed");
      return true;
    }
    if (item) {
      if (!apiState.generating && now() - state.lastQueueAttemptAt >= POLL_MS) {
        state.lastQueueAttemptAt = now();
        const sent = await engine()?.runAction?.("queue-next");
        if (sent) await refreshWorkflow();
      }
      return false;
    }

    const refreshed = await refreshWorkflow();
    if (refreshed.awaitingResponse || !refreshed.pendingItemId) return false;

    const completedExactly = queue.state.completions.some((completion) =>
      completion.itemId === workflow.pendingItemId && completion.sourceId === workflow.id);
    if (completedExactly) {
      const next = Commands.normalizeWorkflow(refreshed);
      next.pendingItemId = "";
      next.awaitingResponse = true;
      next.sawGeneration = false;
      next.responseCandidateFingerprint = "";
      next.responseCandidateSince = 0;
      next.reason = "Waiting for ChatGPT";
      next.updatedAt = now();
      await writeWorkflow(next);
      return false;
    }

    await markWorkflow("blocked", "Workflow prompt was removed before confirmed delivery", "command.workflow.prompt_removed");
    return true;
  }

  async function handleWorkflow() {
    if (Commands.normalizeWorkflow(state.workflow).status !== "running") return false;
    if (!await claimWorkflow()) return false;
    const workflow = Commands.normalizeWorkflow(state.workflow);
    if (workflow.runnerId !== state.ownerId) return false;
    const api = engine();
    if (!api || !await api.ensureReady()) return false;
    const apiState = api.getState();
    if (!apiState.hydrated) return false;

    if (workflow.pendingItemId) return handlePendingWorkflowItem(apiState);
    if (!workflow.awaitingResponse) return false;

    if (apiState.generating) {
      if (!workflow.sawGeneration || workflow.responseCandidateFingerprint) {
        workflow.sawGeneration = true;
        workflow.responseCandidateFingerprint = "";
        workflow.responseCandidateSince = 0;
        workflow.reason = "ChatGPT is working";
        workflow.updatedAt = now();
        await writeWorkflow(workflow);
      }
      return false;
    }

    if (now() - workflow.lastPromptAt < RESPONSE_SETTLE_MS) return false;
    const assistantText = Platforms.latestAssistantText(adapter());
    const candidateFingerprint = Commands.fingerprint(assistantText);
    if (!assistantText || candidateFingerprint === workflow.baselineFingerprint || candidateFingerprint === workflow.lastAssistantFingerprint) return false;
    if (workflow.responseCandidateFingerprint !== candidateFingerprint) {
      workflow.responseCandidateFingerprint = candidateFingerprint;
      workflow.responseCandidateSince = now();
      workflow.reason = "Waiting for ChatGPT response to settle";
      workflow.updatedAt = now();
      await writeWorkflow(workflow);
      return false;
    }
    const outcome = Commands.evaluateResponse(assistantText);
    const quietSince = Math.max(workflow.responseCandidateSince, apiState.lastDomActivityAt || 0, apiState.lastGenerationAt || 0);
    if (now() - quietSince < Lifecycle.responseStableMs(outcome)) return false;
    return processResponse();
  }

  async function tick() {
    if (state.destroyed || state.tickInFlight) return;
    state.tickInFlight = true;
    try {
      await withWorkflowLock(async () => {
        await syncRoute();
        await handleRollover();
        await handleWorkflow();
      });
      syncUI();
      if (!document.hidden) state.ui?.reposition?.();
    } finally {
      state.tickInFlight = false;
    }
  }

  function editWorkflow(workflow) {
    setComposerText(`/${workflow.kind} ${workflow.kind === "loop" ? `${workflow.maxIterations} ` : ""}${workflow.objective}`);
    composer()?.focus?.();
  }

  function mountUI() {
    state.ui = CommandUI.mount({
      execute: executeCommand,
      pause: () => executeCommand("pause"),
      resume: () => executeCommand("resume"),
      stop: () => executeCommand("stop"),
      edit: editWorkflow,
      getComposer: composer,
      getComposerText: composerText,
      setComposerText
    });
    syncUI();
  }

  function getHealth() {
    const workflow = Commands.normalizeWorkflow(state.workflow);
    return {
      status: workflow.status,
      active: workflow.status === "running",
      awaitingResponse: workflow.awaitingResponse,
      pendingItemId: workflow.pendingItemId,
      iteration: workflow.iteration,
      lastPromptAt: workflow.lastPromptAt
    };
  }

  function schedulePoll(immediate = false) {
    window.clearTimeout(state.pollTimer);
    if (state.destroyed) return;
    const apiState = engine()?.getState?.() || {};
    const delay = immediate ? 0 : Lifecycle.workflowPollDelay({
      hidden: document.hidden,
      workflowActive: getHealth().active,
      generating: Boolean(apiState.generating)
    });
    state.pollTimer = window.setTimeout(async () => {
      try {
        await tick();
      } catch (error) {
        await record(`Workflow poll failed: ${Shared.errorMessage(error)}`, "error", "command.workflow.poll_failed").catch((recordError) => {
          console.error(`Workflow poll status record failed: ${Shared.errorMessage(recordError)}`);
        });
      } finally {
        schedulePoll();
      }
    }, delay);
  }

  function addLifecycleHandler(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    state.lifecycleHandlers.push({ target, eventName, handler });
  }

  function wakeRuntime() {
    if (!state.destroyed) schedulePoll(true);
  }

  function destroy() {
    if (state.destroyed) return;
    releaseWorkflow();
    state.destroyed = true;
    window.clearTimeout(state.pollTimer);
    state.unregisterEngineClient?.();
    state.ui?.destroy?.();
    for (const { target, eventName, handler } of state.lifecycleHandlers) target.removeEventListener(eventName, handler);
    state.lifecycleHandlers = [];
  }

  window.__YOLO_COMMAND_RUNTIME__ = { version: Config.VERSION, destroy, getHealth };
  mountUI();
  const api = engine();
  state.unregisterEngineClient = api?.registerClient?.(destroy) || null;
  addLifecycleHandler(document, "visibilitychange", wakeRuntime);
  addLifecycleHandler(window, "pageshow", wakeRuntime);
  addLifecycleHandler(document, "resume", wakeRuntime);
  syncRoute().then(() => schedulePoll(true));
})();
