# Overnight and multi-tab reliability

YOLO is designed to survive many long-running ChatGPT conversations without treating every tab as a foreground page.

## Operating model

- Visible tabs use the normal configured scan cadence.
- Hidden tabs back off automation scans, route checks, workflow polling, and mutation-triggered work.
- A page is not considered ready until the document is loaded, the composer exists, and the DOM has been quiet long enough to indicate hydration has settled.
- Goal and Loop use one request-recovery policy. A delivered workflow prompt has an absolute 27-minute deadline. If no usable final response is available at that point, YOLO refreshes the same conversation up to 3 times, waiting 15 seconds after each refresh for the server-side answer to rehydrate. If the answer is still unavailable, YOLO queues a dedicated continuation and starts a fresh request cycle. A settled answer that is missing its terminal marker enters this same refresh path immediately after a short stability check.
- Scheduled idle refresh is blocked whenever a workflow is running, ChatGPT appears to be generating, the composer contains a draft, the page is not hydrated, or the DOM changed within the last minute.
- A one-minute background alarm checks loaded ChatGPT tabs, restores missing versioned packaged content scripts at a bounded rate, and updates the tab discard hint from durable settings/workflow state. It never activates or reloads a tab.

## Memory behavior

YOLO does not delete old ChatGPT messages, replace React nodes, inject CSS that merely hides history, or attempt to garbage-collect ChatGPT internals. Those approaches are brittle and do not reliably release the application’s retained memory.

When **Protect active workflows** is enabled, tabs with a running Goal or Loop are marked `autoDiscardable: false`. Once the workflow is no longer running, YOLO restores `autoDiscardable: true` so Chrome Memory Saver can reclaim the tab normally.

For live diagnosis, the active Goal/Loop bar includes a **状态** button. The status window intentionally shows only user-relevant workflow state: current phase, current/total turns, current conversation index, refresh recovery count, automatic rollover policy, and the next request/recovery deadline. Internal tab heartbeats and cross-tab ownership are not presented as task timers.

The request deadline is absolute. Visible tool calls, reasoning text, DOM activity, or a page that still appears to be generating do not extend the 27-minute limit. The recovery sequence is always the same: wait for the final answer, refresh up to the configured retry count, then send a continuation that resumes from already-visible work without replaying the original task.

The popup/Advanced **常规自动化** switch controls ordinary background automation such as approvals, ordinary error recovery, automatic queue sending, nudges, and scheduled refresh. An explicitly running Goal/Loop is controlled by its own Pause/Resume/Stop state, and its request-recovery refreshes remain available even when ordinary automation is paused.

Protecting many huge conversations can consume substantial memory. Disable the setting when browser stability is more important than uninterrupted parallel work. Even a protected tab may still be terminated by the browser or operating system under extreme pressure; YOLO’s durable queues and workflows resume from persisted state when the page returns.

## Frozen and discarded tabs

A frozen tab cannot run timers or event handlers. A discarded tab has no loaded page at all. YOLO deliberately does not activate or force-reload these tabs because doing so can interrupt work and cause a reload storm. When the browser resumes or reloads the tab, lifecycle listeners immediately resynchronize the route, settings, queue, and workflow state.
