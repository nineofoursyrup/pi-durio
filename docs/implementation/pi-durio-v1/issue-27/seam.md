# #27 host facts and downstream query seam

`Evidence.append` stamps an explicit list of host admission, lifecycle, recovery,
model and tool boundary kinds with `clock: {processId, monotonicMs, wallTime}`.
`processId` is a random process incarnation UUID, never a reusable PID. `at` is
that same wall-time acquisition timestamp. Raw values are retained; old records
are not migrated. A caller-provided clock is overwritten for these host kinds.
No runtime/recovery/control algorithm changes.

`task.accepted.origin` and independent follow-up `control.accepted.origin` come
from trusted `ReadTaskOptions.taskOrigin`, never model/tool payloads. Ordinary
runtime defaults to `{kind: coding, source: ordinary}` in live mode and source
`synthetic` in explicit offline mode. Eval guest explicitly uses kind/source
`eval` and its trial ID. Improve/maintenance hosts must declare their actual
kind/source. Management queue items are never independent coding tasks.

Legacy records remain interpretable from their explicit `kind`, `taskKind`,
`mode`, and source fields. Absent identity stays unknown. A queued admission's
`executionVersion` is expected configuration, not actual execution evidence.
Actual report version comes only from its own started run's artifact fact.

The forthcoming `pi-durio/metrics` read-only query consumes these original
facts; #28/#29 can reuse its stable task membership, selected acceptance,
counts, clocks and source references. No separate metrics ledger is created.

`stampFact` returns `{data, acquiredAt}`; unlisted payloads with their own
`clock` fields never control the host's acquisition timestamp. Explicit host
`task.phase` boundaries are also stamped. Live mode with an injected transport
defaults to `diagnostic` unless its trusted host explicitly declares origin.
Ordinary live mode with the standard transport defaults to `ordinary`.

The final `pi-durio/metrics` export provides `recordAcceptance`, `readAcceptance`,
`selectAcceptance`, `queryTaskMetrics`, `formatTaskMetrics`, and their schema
interfaces. Writing a judgment persists host-derived `assessment` in that same
Evidence fact alongside the exact submitted input and request identity. There
is no report-side grader execution. Package/source-build and improve ownership
remain with #23; merges must retain both origin metadata and improve context.

`readRun` keeps its established `result` shape; the appended raw result clock
is exposed separately as `resultClock`. Raw Evidence still retains the clock.
