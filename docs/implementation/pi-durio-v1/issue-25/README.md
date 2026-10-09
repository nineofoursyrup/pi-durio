# #25 exact improve execution, task defaults and explicit rollback

This ticket extends the accepted #24 API. `execute-declared-scope` now supports registered project, agent-config and prompt-skill ordinary files. The old #24 README and acceptance describe their original candidate and remain historical evidence. New tools/runtime builds and independent eval-asset execution are still explicitly unsupported here and belong to #26.

## Exact selection and commands

Use `pi-durio/improve-decisions` exports `previewImproveDecision`, `submitImproveDecision`, `readImproveDecision`, `readImproveDefaults`, `readImproveEffectiveConfig`, `resumeImproveDecision` and `rollbackImproveDecision`. The existing headless `improve preview|submit --spec FILE` and TUI `/improve-select JSON` use the same checked host boundary. The TUI starts unselected; `e` selects execute, `v` selects validation only, `s` renders the complete aggregate and Enter submits it once. The template never preselects candidates. Repeating an ID returns the original state, with no retries or writes.

An execution selection extends the existing report/revision/target/steps binding:

```js
{
  candidateId, candidateRevision, target, steps,
  mode: 'execute-declared-scope',
  formal: {
    writeback: true,
    activate: null, // exact file writeback only
    failureCompensation: 'none'
  }
}
```

Writing configuration or skill content does not make this product autoload it. Only a non-null explicit `activate` selects the retained content as a subsequent task default. The activation scope is:

```js
const scope = {
  scope: 'project-default',
  workspace: canonicalProjectPath,
  taskTypes: ['coding'], // read and coding are separately selected
  baseline: {
    coding: readImproveDefaults(dataRoot, canonicalProjectPath, 'coding').revision
  }
};
```

`formal.activate = scope` is bound by the decision digest. It must be allowed by the candidate's declared activation contract. The actual formal file root remains visible and may be a separately registered shared/user configuration directory. File writeback changes that exact shared file; the product's default selection is restricted to the specified project and task type in this data root. It is never described as a project-only file write, nor does it create a global default or silently switch another project. External applications that load that same file retain their own behavior; this product cannot undo their effects.

Groups still declare exact `changes`, ordered checks, explicit total limits and a new temporary directory outside formal targets. Dependencies/shared targets/shared behavior require a single combination. Mixing validate-only and execute inside one combination is rejected. All necessary checks/protections must pass; all declared benefit comparisons must also demonstrate the predeclared benefit for a performance candidate. No difference, insufficient evidence or degradation cannot write/enable a performance candidate. Results never authorize extra samples, relabeling or budget growth. Unchanged bytes may be confirmed but are not claimed as a new benefit.

`improve decision --id ID`, `improve report --id ID` and `improve defaults --workspace PATH` are read-only. Rollback uses `improve rollback --spec FILE` or `/improve-rollback JSON` with:

```js
{ id: decisionId, rollbackId: 'explicit-rollback-1', decisionSource,
  groupIds: ['the-completed-or-partial-group'],
  reason: 'Explicitly restore this batch while preserving later user edits' }
```

The API takes the same fields plus `dataRoot`. There is no automatic compensation or background rollback service. `failureCompensation:'none'` makes that limit explicit; a different value is rejected.

## Actual task profile and validation

Prompt/skill contents are retained as exact bytes and appended under a stable `[targetId/path]` label. Agent configuration is strict JSON with only these optional fields:

- `instructions`: string, loaded under the same stable label.
- `compaction`: `enabled`, `reserveTokens`, `keepRecentTokens`, using the existing Pi settings and bounded positive integers.
- `stream`: only a bounded `timeoutMs` integer.

Unknown fields, credentials, tools, provider/model selection, retry, authorization, budget and `maxTokens` are rejected. These contents cannot expand capabilities. `maxTokens` remains the common trusted eval output policy; no candidate value is silently overwritten. Multiple configured values for the same setting must agree, otherwise the combination is rejected. Model settings and instructions use the same `task-profile` loader for validation and actual new work.

A validation group may declare `profileScope: scope` independently of any formal selection. A fresh check adds `effectiveTask:'coding'` (or `read`). Both fixed comparison sides then carry their actual effective profiles: the current default snapshot versus the proposed combined snapshot. This works in validate-only mode without `formal`, and cannot grant writeback or activation. With formal activation, every affected behavior selection must exactly match this experiment scope; applying only a different subset is rejected.

The comparison identity includes the effective task type/profile. The existing restricted eval guest sends the fixed profile to the common runtime via its existing trusted provider capability. The runtime applies it to actual system instructions and Harness settings; it is not appended to the user request as a description of hypothetical settings. An auto-compaction verification scenario cannot override a selected profile. Necessary resource/fresh comparisons and protections retain every result and original failure.

Legacy #24 fresh checks retain their original instruction-in-user-prompt semantics and remain valid as their stated experiments. They do not alone authorize actual profile activation. File equivalence alone also does not establish loading equivalence: introducing a previously unused skill changes the actual instructions even when its file was only trimmed.

For an effective profile, `basis.impact:'no-behavior'` additionally requires the explicit rule `equivalence:'exact'` or `'trim-instructions-end'`. The host uses the same runtime loader to compare actual before/after instructions and every setting. The latter rule only ignores trailing whitespace at the end of the final instruction string; settings must remain exactly equal. A first mapping of already-effective setting values can pass; a first introduction of nonempty instructions or changed settings cannot use this classification.

A real deterministic configuration repair can use direct regression without model A/B. Its basis must bind complete expected actual before/after profiles for every selected workspace/task type, for example:

```js
const before = readImproveEffectiveConfig(dataRoot, workspace, 'coding');
const after = structuredClone(before);
after.settings.stream.timeoutMs = 90000; // the declared known defect
group.basis = {
  impact: 'deterministic-fix',
  reason: 'Correct the known timeout; preserve every other setting and instruction',
  checkIndices: [0],
  expectedProfiles: [{ workspace, taskType: 'coding', before, after }]
};
```

These literal expectations are part of the user's exact selected plan. Missing fields, extra fields and incomplete task coverage are rejected. Actual before values come from the selected current default and runtime loader, never from an unused candidate file. Direct/regression checks can read `/input/effective-profiles.json`. Before each named regression program, the existing restricted check automatically compares this actual complete profile to `/input/expected-profiles.json`; a mismatch retains a failed check and prevents writeback/default selection. Both inputs are retained in the construction evidence. A passing deterministic regression is limited to its declared correction and protections, and is not a model improvement claim. First introduction of model-facing instructions instead uses applicable effective-profile fresh validation.

## File identity, partial writes and recovery

Before validation the host captures canonical directory/file identities. It retains original and candidate bytes in the existing evidence object store. Immediately before formal work it rechecks ownership, all relevant original bytes, directory/file identities, default baseline and current executable content. Each write uses the retained validated bytes, a no-follow ordinary-file descriptor and exact before/after readback. Symlinks, hard-linked files, path replacements and changed modes/inodes are rejected; each formal file remains within the existing 256 KiB product bound. User Git edits and unrelated files are never reset or cleaned. This is a local exact-file operation, not a claim of atomic filesystem transactions or exclusion of external editors.

The existing host journal stores formal start, per-file intent/result, default activation, actual new-task observation and explicit rollback. Before the first file write, a durable workspace admission marker points at the original decision in that journal. A partial/unknown outcome keeps the marker after owner release and prevents new tasks (including another data root and overlapping workspace), ordinary recovery execution and subsequent formal batches from silently proceeding. Read-only reports remain available. A missing write result is `unknown`, even if bytes later appear correct. Remaining files/groups do not start; prior successful independent groups remain intact.

Explicit rollback first acquires the same ownership and checks every selected file/default. It restores only exact batch bytes or confirms already-original bytes. Later user edits or later selected defaults block the affected rollback and remain untouched. Actual known/unknown write facts remain in the original history; reconciliation records only the newly observed exact content. The marker is cleared only after complete rollback receipts and default restoration. It never reverses remote/process/tool/Git effects or migrates running/pending tasks.

New tasks fix their retained effective snapshot in `execution.config`. Current tasks and old pending/queued work keep their original available configuration and authorization through the existing recovery path. A current default change neither updates their original config nor supplies missing authorization. `improve.default-observed` records a new task's actual configured-transport entry, with run/task/config/attempt references; it proves use of the fixed profile, not improvement or provider wire delivery. Written files, selected future defaults, observed use, rollback and effect remain distinct in reopened results.

Ordinary cleanup derives additional protection from these same facts: unresolved formal batches and completed batches still available for explicit rollback keep their retained before/after/default bytes; the current project/task default keeps its actual content. Completed rollback releases that batch's protection while the restored current default remains protected. Preview explains these reasons as `improve-formal` and `improve-active-default`; no new cleanup ledger or implicit deletion is added.

The eval guest supplies a mediated live transport only through its existing trusted `providerBoundary`. Its explicit top-level controlled transport remains offline-only. The host and runtime continue to deny live transport overrides. A diagnostic restricted-VM regression can exercise the live guest with a local controlled mediator and its existing non-secret placeholder; it does not make a provider call, grant the guest network access, or claim real provider quality.

## Evidence and remaining gates

`test/improve-execution.test.ts` covers exact execution/reopen, validation drift, partial and unknown result receipts, cross-root admission, edited-file/default protection, performance no-gain, strict configuration, future defaults and old pending content. Existing decision, lifecycle, queue, recovery and eval suites remain required.

`scripts/demo-improve-execution.mjs INSTALL_ROOT LINUX_RUNTIME NEW_EVIDENCE_DIRECTORY` uses independently installed public exports, an actual Pi analysis loop with explicit synthetic transport, structured TUI submission, real restricted VM checks and effective-profile fresh pairs. An optional `--activation-only` repeats only the changed profile/activation paths when unchanged original checks remain applicable. It preserves the wrong-profile first failure, rejects file-only first-activation shortcuts, proves first skill activation with fresh actual profiles and then permits declared equivalent cleanup of the already-loaded skill. Cold CLI readbacks remain byte-identical. `scripts/demo-live-guest.mjs` supplies the separately labelled no-paid-provider diagnostic described above. This is implementation evidence only. Real DeepSeek generation/effect belongs to #30; native final composition/day-to-day acceptance remains #31/#32. No main merge, release, issue closure or paid provider use is authorized by this ticket.
