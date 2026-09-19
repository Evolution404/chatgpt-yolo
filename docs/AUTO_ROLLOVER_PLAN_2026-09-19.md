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

**Status: implemented, opt-in by default.**

- Advanced settings expose `Automatic conversation rollover`, `Turns before rollover`, and `Conversation limit`.
- Default policy for a newly started workflow is disabled, with configured values of 12 chat-local turns and 10 conversations. Enabling the setting affects newly started Goal/Loop workflows; each workflow snapshots its policy so later per-conversation setting changes cannot silently alter a running task.
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

Current UI already exposes the three automatic-rollover settings in Advanced and `/status` reports the rollover phase, chat index, total turns, and policy. A richer task/history panel remains pending.

## Phase 6 - Hardening

**Status: automated hardening substantially implemented; live ChatGPT browser smoke test remains.**

Fault-injection coverage must include refresh/restart at every transaction phase, lost acknowledgements, network interruption, DOM selector drift, multiple ChatGPT tabs, composer drafts, route races, and source/target workflow ownership conflicts.

Current validation on 2026-09-19:

- rollover/config/runtime/UI targeted suite: 93/93 pass;
- full repository suite: 303/303 pass;
- `npm run validate:core` passes end-to-end;
- `npm run check` passes;
- `npm run verify:extension` passes and confirms the public extension boundary;
- `node scripts/package.mjs --check` passes with 39 packaged runtime files;
- `npm run package` successfully produces `dist/yolo`;
- `node scripts/no-bare-installs.mjs` passes;
- no new browser permission or host permission was added;
- browser-restart tests cover same-session tab isolation, restored source-route rebinding, and token-gated transient-route rebinding.

### Stuck-generation watchdog

Long-running unattended workflows must also survive a ChatGPT page that remains in a generating state without making useful output progress. The 1.2.0 candidate therefore includes a local watchdog with these defaults:

- soft warning after 5 minutes without assistant text fingerprint changes;
- request the visible `Stop generating` control after 10 minutes without progress;
- absolute generation cap of 30 minutes even if output continues changing;
- after requesting Stop, allow 30 seconds for the generation state to clear before a bounded same-chat refresh fallback;
- at most 4 watchdog recovery actions per rolling hour by default.

The watchdog never replays the interrupted user prompt. When an active Goal/Loop generation is successfully stopped, command-runtime atomically queues a dedicated recovery continuation that explicitly resumes from the partial response already visible in the conversation. For non-workflow chats, it may queue a plain `Continue` only after generation is confirmed idle. Watchdog state is kept in per-tab session storage so a refresh can finish the same recovery transaction instead of starting a duplicate one.

Before a release is marked production-ready, perform a real unpacked-extension smoke test against the current ChatGPT DOM for both `/rollover` and one automatic threshold rollover. DOM behavior is intentionally not inferred solely from unit tests.

## Current user flow

Manual cross-chat continuation:

1. Open a saved ChatGPT conversation.
2. Pause an active Goal/Loop if one is currently running.
3. Run `/rollover` or `/rollover <focus>`.
4. YOLO obtains a strict handoff, enters New Chat in the same tab, submits the persisted bootstrap prompt, binds the new `/c/<id>` conversation, and resumes the handed-off workflow when applicable.

Automatic cross-chat continuation:

1. In Advanced -> Safety & engine, enable `Automatic conversation rollover`.
2. Set `Turns before rollover` and `Conversation limit` as desired. Defaults are 12 and 10.
3. Start a new `/goal ...` or `/loop N ...` workflow. Existing workflows are not silently changed.
4. When a completed workflow response reaches the chat-local threshold, or explicitly returns `[YOLO:ROLLOVER]`, YOLO performs the same strict handoff/bootstrap/bind sequence automatically.
