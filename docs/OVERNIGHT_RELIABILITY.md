# Overnight and multi-tab reliability

YOLO is designed to survive many long-running ChatGPT conversations without treating every tab as a foreground page.

## Operating model

- Visible tabs use the normal configured scan cadence.
- Hidden tabs back off automation scans, route checks, workflow polling, and mutation-triggered work.
- A page is not considered ready until the document is loaded, the composer exists, and the DOM has been quiet long enough to indicate hydration has settled.
- Goal and Loop responses with a valid terminal marker require fifteen quiet seconds. Responses without a marker are not declared malformed until three quiet hours have passed, so long reasoning/tool turns are not mistaken for finished answers.
- Scheduled idle refresh is blocked whenever a workflow is running, ChatGPT appears to be generating, the composer contains a draft, the page is not hydrated, or the DOM changed within the last minute.
- A one-minute background alarm checks loaded ChatGPT tabs, restores missing versioned packaged content scripts at a bounded rate, and updates the tab discard hint from durable settings/workflow state. It never activates or reloads a tab.

## Memory behavior

YOLO does not delete old ChatGPT messages, replace React nodes, inject CSS that merely hides history, or attempt to garbage-collect ChatGPT internals. Those approaches are brittle and do not reliably release the application’s retained memory.

When **Protect active workflows** is enabled, tabs with a running Goal or Loop are marked `autoDiscardable: false`. Once the workflow is no longer running, YOLO restores `autoDiscardable: true` so Chrome Memory Saver can reclaim the tab normally.

For live diagnosis, the active Goal/Loop bar includes a **状态** button. The status window refreshes with the workflow runtime and exposes the current phase and remaining time for applicable recovery and safety timers, including response-start recovery, response stabilization, generation soft/hard/absolute watchdog deadlines, Stop grace refresh, queue scheduling, periodic refresh, and the workflow runner lease. The bar itself shows the next timed action so a user can tell whether YOLO is actively waiting, recovering, or stalled without opening DevTools.

Protecting many huge conversations can consume substantial memory. Disable the setting when browser stability is more important than uninterrupted parallel work. Even a protected tab may still be terminated by the browser or operating system under extreme pressure; YOLO’s durable queues and workflows resume from persisted state when the page returns.

## Frozen and discarded tabs

A frozen tab cannot run timers or event handlers. A discarded tab has no loaded page at all. YOLO deliberately does not activate or force-reload these tabs because doing so can interrupt work and cause a reload storm. When the browser resumes or reloads the tab, lifecycle listeners immediately resynchronize the route, settings, queue, and workflow state.
