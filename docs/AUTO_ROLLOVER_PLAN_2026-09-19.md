# Auto Rollover Implementation Plan

## Objective

Allow one long-running YOLO task to continue across multiple ChatGPT conversations without relying on a single conversation reaching its hard context limit.

The implementation must preserve YOLO's existing at-most-once/fail-closed reliability model. A rollover may stop for manual recovery; it must not silently duplicate a handoff, bootstrap prompt, or successor conversation.

## Baseline

- Fork: `Evolution404/chatgpt-yolo`
- Upstream baseline: `kartikkabadi/chatgpt-yolo` `main` at `d018c6a`
- Branch: `feat/auto-rollover-20260919`
- Initial `npm run validate:core` baseline: 265/269 tests passed in the current DevSpace/macOS checkout. The four failures were all in `tests/validate-asset-manifest.test.js` and reported `unsafe path after realpath` for temporary media paths.
- Root cause: on macOS the temporary directory may be addressed through `/var/...` while `realpathSync()` canonicalizes it to `/private/var/...`. The production validator was correctly comparing against the supplied root; the test fixture supplied a non-canonical root.
- Resolution: the test-only `tmpDir()` helper now canonicalizes the created directory with `fs.realpathSync(...)`. The production path-safety validator was not relaxed or changed.

## Phase 0 - Preserve reliability boundaries

**Status: complete.**

- Reuse the background-owned durable queue for the source-chat handoff prompt.
- Keep all existing durable `/c/<id>` route checks.
- Add only one narrow transient-route exception: the first bootstrap prompt in a persisted rollover transaction.
- Persist the transaction before every side effect.
- Treat an uncertain post-submit bootstrap as blocked/unknown; never retry automatically.

## Phase 1 - Rollover state and protocol

**Status: complete.**

Add a pure `rollover.js` state/protocol module with:

- strict handoff envelope markers;
- required machine-readable fields;
- transaction normalization and revisioning;
- source workflow snapshot;
- bootstrap prompt generation;
- exact handoff ownership check using the source prompt fingerprint.

No token estimation is used. Rollover is triggered only from bounded, observable workflow counters or the explicit `[YOLO:ROLLOVER]` control marker.

## Phase 2 - Manual rollover MVP

**Status: complete at `931ec97`.**

Implement `/rollover [focus]`:

1. Require a stable saved source conversation.
2. Persist a rollover transaction and atomically enqueue its handoff prompt.
3. Wait for exact queue completion and a stable assistant response.
4. Reject truncated, duplicated, or incomplete handoff envelopes.
5. Persist the complete handoff and bootstrap prompt.
6. Navigate the same tab to ChatGPT New Chat.
7. On the transient route, permit exactly the persisted bootstrap prompt to be submitted.
8. Confirm the exact user message and require a new durable `/c/<id>` route.
9. Bind the target conversation to the transaction.
10. If a goal/loop was handed off, adopt it into the target conversation and resume marker-driven execution.

## Phase 3 - Durable recovery

**Status: core recovery implemented; bounded history remains for later UX work.**

Implemented recovery invariants:

- `handoff_queued -> awaiting_handoff -> bootstrap_pending -> bootstrap_submitting -> bootstrap_sent -> bound` is persisted in `chrome.storage.local`.
- Bootstrap submission intent is persisted before touching the transient new-chat composer.
- An uncertain post-submit outcome becomes `blocked`; it is never retried automatically.
- Each browser lifetime receives a `chrome.storage.session` epoch. A normal second tab in the same browser session cannot take ownership of another tab's rollover.
- After a real browser restart, a restored source or target `/c/<id>` route can rebind exactly one stale rollover transaction.
- A restored transient New Chat may rebind only with the opaque `yolo-rollover=<transaction-id>` token created by YOLO itself.
- The recovery token contains no handoff text or user-authored content and is removed from the URL after durable target binding.
- Ambiguous matches fail closed rather than choosing one transaction.

Rollover history is intentionally not required for correctness. A bounded user-facing history can be added with the Phase 5 task UI without expanding the execution surface.

## Phase 4 - Automatic rollover policy

**Status: implemented, enabled by default for new workflows.**

- Advanced settings expose the automatic rollover toggle and the chat-local turn threshold; the conversation cap remains an internal safety bound.
- Default policy for a newly started workflow is enabled at 6 completed chat-local turns, with an internal 10-conversation safety cap. Each workflow snapshots its policy so later settings changes cannot silently alter a running task.
- `iteration` is the number of completed workflow turns in the current ChatGPT conversation.
- `totalIterations` is the task-wide count across all rollover conversations.
- `maxIterations` remains a task-wide safety cap. `/loop 20` can never gain another 20 iterations merely by rolling into a fresh chat.
- `conversationIndex` and `taskId` survive rollover and are restored into the successor workflow.
- At the configured chat-local threshold, the runtime does not enqueue a continuation. The background atomically consumes the just-finished workflow response, pauses the source workflow, creates the rollover transaction, and enqueues the handoff.
- `[YOLO:ROLLOVER]` is available only to workflows that started with automatic rollover enabled. It cannot bypass the task-wide iteration cap or conversation cap.
- Reaching the conversation cap pauses the workflow instead of creating another chat.

## Phase 5 - UX

**Status: partial.**

Expose current task, conversation count, current-chat turns, total turns, last rollover, pause/stop, and `Rollover now` controls. Keep the default popup compact; advanced controls belong in the existing advanced surface.

Current UI exposes the rollover toggle and turn threshold in the simplified Goal / Loop settings. `/status` reports the current conversation index, chat-local turns, total turns, and active rollover policy without exposing internal transaction or ownership timers. A richer task/history panel remains pending.

## Phase 6 - Hardening

**Status: automated hardening substantially implemented; live ChatGPT browser smoke test remains.**

Fault-injection coverage must include refresh/restart at every transaction phase, lost acknowledgements, network interruption, DOM selector drift, multiple ChatGPT tabs, composer drafts, route races, and source/target workflow ownership conflicts.

Current validation on 2026-09-19:

- rollover/config/runtime/UI targeted suite: 93/93 pass;
- full repository suite: 316/316 pass;
- `npm run validate:core` passes end-to-end;
- `npm run check` passes;
- `npm run verify:extension` passes and confirms the public extension boundary;
- `node scripts/package.mjs --check` passes with 39 packaged runtime files;
- `npm run package` successfully produces `dist/yolo`;
- `node scripts/no-bare-installs.mjs` passes;
- no new browser permission or host permission was added;
- browser-restart tests cover same-session tab isolation, restored source-route rebinding, and token-gated transient-route rebinding.

### Simple request recovery

Goal/Loop no longer uses separate response-start and 5/10/30-minute generation-watchdog state machines. The request lifecycle is deliberately bounded and easy to reason about:

- the workflow prompt has an absolute 27-minute deadline from confirmed delivery;
- visible tool/reasoning/page activity does not move that deadline;
- on timeout, YOLO reloads the same durable conversation and waits 15 seconds for the server-side response to rehydrate;
- it performs at most 3 refresh attempts by default;
- if no usable final response is recovered, YOLO queues a dedicated continuation that resumes from already-visible partial work without replaying the original task;
- a settled answer missing its YOLO control marker enters the same bounded refresh path after a short stability check.

Renderer liveness remains a separate internal safeguard. Content scripts persist heartbeats so the background supervisor can recover a truly frozen tab, but heartbeat cadence and workflow ownership are not task timers and are not exposed as Goal/Loop recovery policy.
Final real-browser acceptance on 2026-09-20 used a Chrome profile cloned from an authenticated ChatGPT environment and the packaged unpacked extension. The normal two-turn Goal smoke completed automatically (`TEST_STEP_1` -> `[YOLO:CONTINUE]` -> `TEST_STEP_2` -> `[YOLO:DONE]`). A second smoke deliberately locked the ChatGPT renderer after the Goal prompt reached `running + awaitingResponse`; the replacement tab reloaded the same `/c/...` conversation, recovered `TEST_FREEZE_RECOVERED\n[YOLO:DONE]`, and advanced the durable workflow to `completed` without replaying the original prompt. Manual `/rollover smoke` then completed from a canonical source `/c/<id>` through strict handoff, transient bootstrap, and a distinct canonical target `/c/<id>` with `phase=bound`. Finally, an automatic-rollover Goal with a 2-turn threshold completed turn 1 and turn 2 in the source conversation, automatically rolled over, restored the workflow with `conversationIndex=2`, completed turn 3 in the successor conversation, and ended with `totalIterations=3` and `status=completed`.

Before a release is marked production-ready, perform a real unpacked-extension smoke test against the current ChatGPT DOM for both `/rollover` and one automatic threshold rollover. DOM behavior is intentionally not inferred solely from unit tests.

## Current user flow

Manual cross-chat continuation:

1. Open a saved ChatGPT conversation.
2. Pause an active Goal/Loop if one is currently running.
3. Run `/rollover` or `/rollover <focus>`.
4. YOLO obtains a strict handoff, enters New Chat in the same tab, submits the persisted bootstrap prompt, binds the new `/c/<id>` conversation, and resumes the handed-off workflow when applicable.

Automatic cross-chat continuation:

1. In Advanced -> Safety & engine, enable `Automatic conversation rollover`.
2. Set `Turns before rollover` as desired. The default is 6 completed chat-local turns; the internal conversation safety cap defaults to 10.
3. Start a new `/goal ...` or `/loop N ...` workflow. Existing workflows are not silently changed.
4. When a completed workflow response reaches the chat-local threshold, or explicitly returns `[YOLO:ROLLOVER]`, YOLO performs the same strict handoff/bootstrap/bind sequence automatically.
