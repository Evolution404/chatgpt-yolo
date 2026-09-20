# Changelog

All notable changes are documented here.

## Unreleased

- Fixed a response-recovery live-lock where an active Goal/Loop could reach an expired recovery timer while the general automation switch was off, repeatedly flip recovery state, and never refresh. Workflow-critical watchdog refresh now remains available for an explicitly running Goal/Loop, the refresh marker is committed only after a reload is actually scheduled, and the live status window updates existing DOM nodes instead of rebuilding itself every poll.
- Fixed unattended Goal/Loop recovery when ChatGPT briefly enters generation and then surfaces a localized send-timeout error without a usable assistant response: Chinese timeout/retry alerts are now recognized, and the 3-minute response recovery timer still applies after generation has already started once.
- Added an in-page live YOLO status window for active Goal/Loop workflows. It shows the current execution phase plus live countdowns for response recovery, response stabilization, 5-minute/10-minute/30-minute generation watchdog thresholds, Stop grace refresh, content heartbeat/stale-heartbeat recovery, queue scheduling, periodic refresh, and runner lease renewal; the workflow bar also shows the next timed action at a glance.

## 1.2.0 - 2026-09-20

- Added durable `/rollover` handoff into a fresh ChatGPT conversation with strict envelope validation, exact bootstrap receipt, and successor binding.
- Hardened rollover bootstrap on the live ChatGPT New Chat route: the transient sender waits for a real enabled send button instead of treating form submission fallback as delivery, and final binding waits past `/c/WEB:*` transition routes for the canonical successor conversation ID.
- Added opt-in automatic rollover for newly started Goal/Loop workflows with chat-local turn thresholds, task-wide turn accounting, explicit conversation caps, and `[YOLO:ROLLOVER]`.
- Added browser-restart recovery for rollover transactions using a browser-session epoch and opaque transient-route recovery token while preserving fail-closed behavior.
- Added Advanced settings and `/status` visibility for automatic rollover policy and task-level counters.
- Added a stuck-generation watchdog: assistant output progress tracking, soft-stall warning, hard-stall Stop recovery, bounded refresh fallback, and workflow-aware continuation that never replays the interrupted user prompt.
- Added response-start timeout recovery for Goal/Loop prompts that were delivered but never begin generating: refresh once, then fail closed as blocked instead of waiting forever.
- Added persistent content heartbeats and protected-workflow supervision for renderer hangs.
- Added strong frozen-renderer recovery: at a safe awaiting-response boundary, YOLO releases the stale runner lease, opens the same durable conversation in a replacement tab, closes the unresponsive tab, and lets the new runtime adopt the existing workflow without replaying the original prompt.
- Localized the popup, Advanced settings, onboarding, slash-command palette, workflow status, templates, diagnostics, queue states, and user-facing recovery messages into Chinese while preserving protocol markers and command names.
- Fixed tab-supervisor recovery injection to load the exact manifest content-script stack, including `shared.js` before `commands.js` and `rollover.js` before command runtime; `commands.js` now also fails closed if its shared dependency is unavailable.
- Fixed refresh recovery cooldown logic that could reference an undefined action value.
- Fixed macOS asset-validator test fixtures to use canonical temporary roots without relaxing production path-safety checks.

- Reaffirmed YOLO as a browser-only ChatGPT extension and documented the product boundary, non-goals, roadmap, and success measures.
- Rebuilt README information architecture with a clearer hook, primary actions, GitHub-to-ChatGPT setup guidance, and sponsorship presentation.
- Added launch visual assets, video storyboard, and distribution copy under `marketing/` and `docs/assets/`.
- Removed public-facing third-party coding-assistant wording from the manifest and onboarding to preserve the independent-project boundary.
- Added automated release verification for narrow permissions/hosts, local-only packaged files, no remote or dynamic code, and no CLI/agent/server/native-messaging surfaces.
- Stabilized CI, CodeQL, package artifacts, and tagged GitHub releases on maintained GitHub Actions versions with timeouts and concurrency controls.
- Improved public issue forms, pull-request review guidance, code ownership, contribution rules, README disclosures, and the manual release smoke checklist.

## 1.1.0 - overnight reliability

- Added adaptive visible/hidden/generating tab scheduling for large multi-tab ChatGPT sessions.
- Added hydration and long-turn quiet-state guards before automation, response interpretation, or refresh.
- Added an alarm-driven tab supervisor with bounded packaged-script restoration and optional active-workflow discard protection.
- Added lifecycle recovery for page visibility, freeze/resume, extension updates, and same-route React rehydration.
- Reduced extension CPU and storage churn across long-running hidden conversations.

## 1.0.0 - release candidate

- Added a persistent, queue-backed slash-action palette with explicit workflow, prompt-shortcut, and YOLO-control categories.
- Added bounded `/goal` and `/loop` workflows with per-conversation state, CAS revisions, runner leases, exact delivery identity, response stabilization, and required terminal control markers.
- Replaced misleading `/compact`, `/queue`, and `/clear` actions with truthful `/handoff`, `/status`, and `/stop` semantics.
- Redesigned the popup and Advanced settings around a task-first, ChatGPT-native interface.
- Added searchable settings navigation, accessible queue actions, explicit template states, destructive confirmations, and reduced-motion behavior.
- Added first-run onboarding, MIT licensing, privacy/security/contribution policy, reproducible packaging, and release automation.
- Added safe settings/template backups and privacy-safe diagnostics; active automation state is deliberately excluded.
- Preserved local-only operation and ChatGPT-only host access.

## 0.7.0

- Added command workflows and reliability hardening.

## 0.6.0

- Replaced the original hard-coded extension with the persistent queue-first architecture.
