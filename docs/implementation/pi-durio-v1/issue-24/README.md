# #24 improve structured decisions and restricted validation

`pi-durio/improve-decisions` implements report/candidate-bound `validate-only`, `defer` and `do-not-suggest`, explicit independent continuation and suppression restoration. `execute-declared-scope` returns `IMPROVE_EXECUTE_UNSUPPORTED`; it neither runs a lesser mode nor queues future execution. Formal writeback/activation belongs to #25. Every report and selection view starts empty.

## Public entry points

Headless: `improve preview --spec FILE`, `improve submit --spec FILE`, `improve decision --id ID`, `improve continue --spec FILE`, `improve suppressions`, `improve restore-suggestion --spec FILE`; specify the existing `--data-root`. `submit` and `continue` use SIGINT/SIGTERM cancellation. Reopening a decision/report or repeating an identical submission never dispatches anything. A reused ID with different content fails. `preview` checks the same contract as `submit` without writes.

TUI: `/improve-select JSON` opens an unselected draft. Arrow keys move and keep the selected title/mode visible across wrapped narrow viewports, `v` selects validate-only, `d` defers, `n` suppresses, `0` clears, `e` displays the unsupported execution mode. `s` produces the exact aggregate; after it has rendered, Enter explicitly submits. The aggregate contains all revisions, targets, dependencies, combined groups, content, checks and limits. `/improves ID` remains read-only. `/improve-continue JSON`, `/improve-suppressions`, `/improve-restore JSON` share the host functions and lifecycle.

A minimal API example, after an existing actual analysis report is read:

```js
import {readImproveReport} from 'pi-durio/improve';
import {previewImproveDecision,submitImproveDecision} from 'pi-durio/improve-decisions';
const report = readImproveReport(dataRoot, reportId).report;
const candidate = report.candidates[0]; // explicit caller choice, never a default
const decision = {
  id: 'my-explicit-choice', reportId, reportRevision: report.revision,
  selections: [{candidateId: candidate.id, candidateRevision: candidate.revision,
    target: candidate.target, steps: candidate.steps, mode: 'defer'}],
  groups: [],
  limits: {deadline: new Date(Date.now()+60000).toISOString(),
    maxChecks: 0, maxRequests: 0, maxTokens: 0}
};
previewImproveDecision(dataRoot, decision);
await submitImproveDecision({dataRoot, decision});
```

`ImproveDecision`, `ValidationGroup` and `ImproveCheck` types are the precise authoring contracts. Validation selections must each appear in exactly one ordered group. Groups supply one final `changes:[{targetId,path,content}]` per changed path and explicit `checks`. The decision supplies a new absolute `directory` outside every formal target; the recording root must also be outside them. All limits are total maxima, reserved by complete group before starting. Each fresh check additionally reserves the existing eval plan's request/token allowance and has a fixed registered runtime identity. No dependency or conflicting choice is selected silently.

The host snapshots caller inputs, validates the report/candidate revisions and complete target identity, obtains existing host/workspace ownership, then saves the decision before creating temporary content. It checks target bytes and execution content again before each group and after validation. Targets need not be Git repositories. Self-source identity reuses #23's explicit registered source/build correspondence.

## Validation and failure semantics

The exact submitted group may additionally declare `basis:{impact,reason,checkIndices}`. `impact` is `no-behavior`, `deterministic-fix`, `model-behavior` or `unknown`; its reason and referenced checks are shown in the aggregate and bound by `decisionDigest`. A no-behavior basis must point to actual direct/regression checks (for example, baseline/candidate JSON parse equivalence). A deterministic-fix basis must include regression. Without this explicit plan basis, agent behavior defaults to fresh; a model-written maintenance label or Markdown filename never bypasses that requirement. A falsely declared formatting cleanup whose contents change semantics fails its equivalence check and freezes the remainder. This is a reviewable declared-check contract, not an automatic semantic proof engine.

Declared candidate bytes are constructed from retained original source blobs. Candidate/check programs execute in the existing #12/#21 restricted VM boundary; formal paths and host credentials are not mounted. Artifacts are exported only after termination. Checks cannot mutate the fixed candidate content. Direct/regression checks must exit successfully. Resource checks return measured `{baseline,candidate,protectionsPassed}` JSON against predeclared direction, delta, unit and basis. For prompt/skill and agent-config, unknown/model behavior requires fresh comparisons using #22; every changed part of the selected combination is included in the baseline/candidate instructions. Grader candidates cannot grade another selected candidate's comparison.

Project/self-source/eval-asset changes support actual direct, regression and resource programs. Fresh instruction binding is provided for prompt/config content. There is no generic arbitrary-source build/deploy recipe: fresh runtime-code replacement must not be inferred from an instruction-only comparison. Unsupported binding fails before work. Product-wide fresh runtime integration, ordinary host performance, model quality and native Terminal acceptance are not implied by controlled evidence.

Shared targets, dependencies and shared agent behavior must be one combination. Results give combination credit only. Every necessary check and protection remains required. The aggregate keeps every comparison: degradation or failed protection dominates; a mix of improvement and no difference is insufficient for the full declared benefit; only all completed checks and all improved benefit comparisons set `allDeclaredBenefitsMet`. This flag alone does not authorize #25 writeback or activation. Baseline drift invalidates both check-pass and benefit flags.

Failure, cancellation, missing/unknown outcome, record failure or baseline/version drift freezes remaining work. Completed/failed/not-run facts remain distinct. A started group without a committed outcome is unknown and cannot replay. Continuation requires `{id,resumeId,decisionSource,groupIds}` and can spend only untouched independent groups in original order with original targets, versions, deadline and limits. It never reruns the failed group. Continuing the remainder can finish as `completed-with-failures`; original failure facts remain.

## History, scope and child eval provenance

The existing host journal records `improve.decision`, preparation/check/group/validation/batch facts, explicit resumes and restores. Subsequent analysis receives bounded same-project decision summaries and source IDs, including decisions recorded under an analysis run. Shared-config suppression can appear as a scoped summary without broadening raw project access.

Suppression keys combine canonical target root/kind, explicit `problemKey` and file scope; presentation ID and prose are excluded. Ambiguous changed keys on overlapping scope remain suppressed. `defer` needs changed scoped content plus an explicit `reconsideration:{sourceId,reason,evidence}` referring to the original decision and actually acquired evidence. New words, IDs, records, version labels or byte changes without an explained relevant change do not lift it. `do-not-suggest` lasts until `restoreImproveSuggestion({dataRoot,id,suppressionId,reason})`; the restore is append-only and does not modify old reports/decisions.

A fresh child eval keeps its original data root, eval kind, plan, run/trial/attempt and provider facts. Parent `improve.eval` links it by:

```js
{
  id: decisionId, groupId, index, kind: 'eval', dataRoot, planId,
  planSource: {scope:'child-data-root', dataRoot, sequence, digest},
  parent: {dataRoot: parentRoot, decisionSource, decisionId},
  attribution: 'improve validation; ... do not count as daily coding'
}
```

`sequence` and `digest` identify the child plan record, not a parent sequence or an end watermark. Only after verifying the child path against the declared decision/group/check directory may a reader construct `e1:${sequence}:${digest}` within that child root. The structured source deliberately has no bare `e1` value or `{sha256,bytes}` shape: #18 cannot recursively interpret it as a local dependency.

Parent `improve.check` and `improve.validation` retain `reportDocument` as a **parent-owned opaque JSON blob** plus `reportOrigin:{dataRoot,planId,asOf,scope}`. `asOf` is the acquired child report's sequence cutoff. The JSON contains original child refs, all meaningful only in the declared child root. `readImproveDecision` decodes that retained snapshot into `.report` and labels its availability boundary; it never reads child attachments or performs an eval. Missing/corrupt parent snapshot reports unavailable. Fixing the parent protects its snapshot, not the child's attachments. The child eval's own fixed plan/outcomes, direct `evalReport`/`readEvidence` and independent availability checks remain authoritative; later child grading revisions cannot silently rewrite the saved parent snapshot.

## Verification

`test/improve-decisions.test.ts` covers immutable inputs, duplicate/mismatched decisions, source/revision drift, real restricted checks, dependencies/conflicts/combination constraints, total budgets, cancellation, unknown record failures, explicit continuation, suppression/restoration, TUI aggregate submission and all-check benefit aggregation. Existing improve and TUI tests cover read-only reports and command integration.

`scripts/demo-improve-decisions.mjs INSTALL_ROOT LINUX_RUNTIME NEW_EVIDENCE_DIRECTORY` uses independently installed public exports, an actual upstream durable analysis loop with controlled transport, actual restricted checks/fresh trials and cold CLI views. It retains individual passes and the first combined failure, verifies resumed independent work, original target bytes, parent fix/retention and child evidence availability, subsequent analysis history, suppression and restore. Source/build/pack/install identity and the final result are recorded in `acceptance.json` after execution. Controlled transport is explicitly not paid model quality evidence. Native aggregate #31/#32 and paid #30 remain separate.
