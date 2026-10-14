# Preserved first failures

External root: `/Users/nineofour/pi-durio-v1-run/evidence/issue-17`.

- `control-first-build.log`: TypeScript narrowed the item state across a public submission observation; the implementation now re-reads its committed receipt after the observation.
- `affected-first.log`: 36/39 passed. One expected transitional CLI assertion still required the removed readonly-only rejection. Two genuine STOP regressions returned unknown/exit instead of aborted/stop. Cause: a TUI options spread evaluated the dynamic `cancellation` getter before Ctrl+C arrived. Fixed by passing the options object intact and preserving getters for queued/recovery dispatch. `cancel-getter-fixed.log` preserves two affected PASS results.
- `tui-build-02.log`: new test attempted to inspect an unknown typed result; the assertion now narrows it explicitly.
- `tui-first.log`: original STOP regression remained in that earlier candidate. New history protection test also exposed that asking for the earlier window at its boundary left input in the active session. The explicit history action now enters readonly mode even at the oldest boundary; `/bottom` restores the active view.
- `check-first.log`: TypeScript held an idle-phase narrowing across asynchronous recovery inspection. The check now uses the actual exiting promise rather than the narrowed enum. `check-02.log` records 79/79 PASS after repairs.

Original log files are retained. No native failure, UNKNOWN or old #16 evidence was rewritten. Additional close/admission concurrency and follow-up-stop checks are separately recorded under `queue-close-*`; later candidate checks do not erase first failures.

- Recovery-start native failure is preserved in candidate-r1's second manual attempt. Independent `reopen-repair/first-red.log` reproduces the same `WIDTH_CPR_TIMEOUT` through real startup/recovery and a real CPR reply pipe while execution-material verification blocks the event loop. `first-green.log` and `affected-checks.log` record the serialised lifecycle repair; no timeout extension or rewritten native result. Details and remaining native scope: [reopen-width-repair.md](reopen-width-repair.md).
