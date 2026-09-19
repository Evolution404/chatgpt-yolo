# Auto Rollover Implementation Plan

## Objective

Allow one long-running YOLO task to continue across multiple ChatGPT conversations without relying on a single conversation reaching its hard context limit.

The implementation must preserve YOLO's existing at-most-once/fail-closed reliability model. A rollover may stop for manual recovery; it must not silently duplicate a handoff, bootstrap prompt, or successor conversation.

## Baseline

- Fork: `Evolution404/chatgpt-yolo`
- Upstream baseline: `kartikkabadi/chatgpt-yolo` `main` at `d018c6a`
- Branch: `feat/auto-rollover-20260919`
- Existing `npm run validate:core`: 265/269 tests pass in the current DevSpace/macOS checkout.
- The four pre-existing failures are all in `tests/validate-asset-manifest.test.js` and report `unsafe path after realpath` for temporary media paths. They were present before rollover changes and must not be hidden by weakening the path-safety checks.

## Phase 0 - Preserve reliability boundaries

- Reuse the background-owned durable queue for the source-chat handoff prompt.
- Keep all existing durable `/c/<id>` route checks.
- Add only one narrow transient-route exception: the first bootstrap prompt in a persisted rollover transaction.
- Persist the transaction before every side effect.
- Treat an uncertain post-submit bootstrap as blocked/unknown; never retry automatically.

## Phase 1 - Rollover state and protocol

Add a pure `rollover.js` state/protocol module with:

- strict handoff envelope markers;
- required machine-readable fields;
- transaction normalization and revisioning;
- source workflow snapshot;
- bootstrap prompt generation;
- exact handoff ownership check using the source prompt fingerprint.

No token estimation is used. The implementation will later trigger rollover from bounded, observable counters and explicit control markers.

## Phase 2 - Manual rollover MVP

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

Add explicit bootstrap outcome states, browser/service-worker restart recovery, lease/idempotency keys, unknown-outcome handling, and rollover history. Recovery must never create a second successor chat when the first outcome is uncertain.

## Phase 4 - Automatic rollover policy

Add task-level counters and policy controls. Initial default target: warn around 10 automated turns and rollover around 12, rather than waiting for the ChatGPT conversation hard limit. Add `[YOLO:ROLLOVER]` as an explicit workflow control marker.

## Phase 5 - UX

Expose current task, conversation count, current-chat turns, total turns, last rollover, pause/stop, and `Rollover now` controls. Keep the default popup compact; advanced controls belong in the existing advanced surface.

## Phase 6 - Hardening

Fault-injection coverage must include refresh/restart at every transaction phase, lost acknowledgements, network interruption, DOM selector drift, multiple ChatGPT tabs, composer drafts, route races, and source/target workflow ownership conflicts.
