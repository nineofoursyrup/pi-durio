# #17 busy queue, stop and recovery interaction

Status: **IMPLEMENTED / OFFLINE VERIFIED; NATIVE TERMINAL NOT RUN**. Not accepted for downstream dependencies until the coordinator binds all applicable evidence. No paid provider use, main merge, release, push, or Issue closure.

`TaskControl` is a host admission boundary shared by TUI and headless. Steer uses exact public Pi 1.1.0 `Conversation.submit({whenBusy:'steer'})`, committed submission observations, `Submission.status/abort/wait`. Independent follow-up and compact/improve admissions are persisted in existing host records before dispatch. The host never replaces Pi's agent loop, inbox placement, recovery, or usage aggregation.

- `control.accepted` binds stable request/task identity, original workspace/session/task/run, original execution artifact/config and authorization. Receipt/decision/report facts are append-only. Duplicate admission returns the existing member; reused identities with changed content/target are rejected.
- A follow-up is a task at acceptance with `execution/runId:null`. It gets a new run/session only after actual dispatch. Source `conversation.context()` messages are saved as a content-addressed snapshot and imported through public passive `Conversation.commit` before its own input. Old tool outputs/assistant messages remain context; their tools and usage are not rerun or recounted.
- Pending independent requests dispatch in acceptance order after normal, confirmed completion. Steer still uses Pi's tool boundary. Compact/improve use this same queue but freeze at their handler barrier until their implementing tickets connect the execution handler. A later frozen follow-up cannot bypass an unresolved earlier management/independent request.
- Stop/exit/failure/recovery freezes unapplied inputs and managed requests. Explicit reattachment checks original target, available exact artifact, current permissions/configuration, completed source, source context, preflight of every residual session, and earlier queue order. A stopped source cannot revive; old steer text requires explicit submission as new work. Withdrawal returns committed placement facts when too late.
- Recovery recognizes source-bound committed steer submissions as the same product task. Known queued steers are passively withdrawn before resumed scheduling and stay frozen. Foreign pending work remains blocked by #15. Closing the recovery view does not release restrictions.

The readonly API and as-of pagination are in [interfaces.md](interfaces.md). `through` bounds all relevant receipt/link/outcome records. Accepted-task enumeration preserves initial identity/time across follow-up linkage and does not assign a run to pre-start admission failure.

## Entrypoints

```
pi-durio tui --workspace PATH --coding [--run UUID]
pi-durio control --workspace PATH --prompt TEXT --coding [--offline-demo]
pi-durio queue --data-root PATH --inspect [--run SOURCE_UUID]
pi-durio queue --data-root PATH --run SOURCE_UUID --decision FILE --authorization FILE
pi-durio recover --data-root PATH --run UUID --authorization FILE [--decision FILE]
```

`control` emits a `ready.target`; stdin is NDJSON `{action:"steer"|"follow-up"|"compact"|"improve",id,input,target}`, `{action:"withdraw",decision:{id,requestId,action:"withdraw",target,receiptSeq}}`, or `{action:"stop"|"exit"}`. Follow-up target never follows UI context. Queue decisions use `{id,requestId,action:"withdraw"|"reattach",target,receiptSeq}`. Reusing the same decision returns existing state rather than executing it again. Headless saved needs-input reports have reasons/options and exit status 75.

TUI busy Enter steers; Ctrl+X then Enter explicitly queues follow-up. `/queue` shows source/actual execution identity, text, state and reason; arrows/Tab select, `w` withdraws, `r` explicitly reattaches applicable frozen follow-up, `n/p` page. `/recover [runId]` saves a recovery check and shows the same report as headless. `e` explicitly ends old work; `c` continues only when no unresolved tool choice is required. `/decide JSON` accepts the shared structured recovery decision. Readonly history requires `/bottom` before task input; an unresolved recovery restriction remains until explicit disposition.

The existing Terminal width protocol, arrival phase/run/focus/modal binding, refusal to replay old Enter/mouse actions, and controlled raw/stty cleanup are preserved. Readonly `ReadOnlyTui` export remains compatible; `coding:true` or CLI `--coding` selects the existing coding runtime. The queue does not grant capabilities.

## Validation

- Initial project `npm run check`: 79/79 PASS in external `evidence/issue-17/check-02.log`.
- Real Pi offline behavior covers steer/follow-up identity and context, early/late withdrawal, duplicate delivery, changed target, stop/failure freeze, no implicit old-queue dispatch, explicit reattachment and revoked permission, ordered management barrier, and recovery with committed steers.
- TUI tests exercise coding, busy Enter, Ctrl+X Enter, withdrawal, readonly history, recovery panel closure, explicit end, and new work. Existing native-width/stop/exit tests remain meaningful protocol checks, not native acceptance.
- `scripts/demo-control.mjs` runs the actual CLI through child stdin/stdout; first demonstration passed with two task members and a separate follow-up run. It accepts an independent installed package root for installation validation.
- `scripts/control-terminal-validation.mjs` is a human-run, exact-manifest-verified native card. A real local tool waits for committed queue/withdrawal facts, giving the operator time without sleep races. It records coding/tool facts, control key bytes, queue receipts, raw/stty and separate operator observations. The second phase reopens the original stopped run. Human P without required machine facts cannot satisfy the first stage.

Combined source `66c7fcafb34e722eafd738140f9305e5a235db80` includes accepted #18 integration `1558066370085ca63ab7b6eede8e2cd8713d1e5d`. The 18 affected combination checks passed; the independent installed CLI and five query routes passed with the source data unchanged. Exact artifact binding is in [candidate-r1.json](candidate-r1.json), validation/applicability in [validation.json](validation.json), and the complete human-run steps in [operator-card.md](operator-card.md). #16 accepted unchanged native rendering/IME/copy/40x12 behaviors remain inherited only within their recorded applicability; #17 new native Ctrl+X/queue/coding/recovery observations remain NOT RUN. Fixture provider streams are offline, never evidence of DeepSeek inference.

Recovery startup follow-up: [reopen-width-repair.md](reopen-width-repair.md) records the native `WIDTH_CPR_TIMEOUT`, actual-call-path red/green reproduction, minimal query/recovery serialization, unchanged deadline and the short new-candidate cold-reopen/new-task recheck. r1 originals and its missing actual new-task execution remain preserved.
