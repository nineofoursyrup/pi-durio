# #26 registered source builds and independent eval assets

This extends the existing improve selection, restricted validation, exact writeback, defaults and rollback interfaces. The registered source must match the current installed product's retained source/build correspondence. No search for another checkout, updater, installer, Git operation, release, hot replacement, automatic restart or pending migration is performed.

Use `pi-durio/improve-decisions` or the equivalent CLI. A source candidate uses `kind:'self-source'`, an explicit canonical `root`, and existing `src/**/*.ts` paths. Complete source inputs, existing outputs, dependency lock, local compiler/dependencies, configuration and entry are retained as content objects. Dependency/configuration/build-recipe changes require separately prepared conditions; this path never installs packages or executes npm hooks. Missing conditions keep analysis suggestions unavailable for execution.

An execution group adds `build:{targetId:'self',timeoutMs:180000}` alongside its explicit content changes and checks. The build costs one reserved check in the existing batch budget. It runs the registered, unmodified `scripts/build-artifact.mjs` inside the fixed 1 GiB restricted build VM, with a build-only 768 MiB Node heap (ordinary eval/task defaults remain 512 MiB) and read-only compiler/dependencies. It verifies the emitted correspondence, actual output files and executable `--help` startup. Necessary direct/regression checks can execute `/input/build/dist/src/cli.js` and inspect `/input/targets/TARGET/PATH`; both are frozen copies. Candidate code and checks receive no formal source root or host credentials. Native dependency bytes are retained from the registered macOS installation, and launch checks the original host Node/platform/architecture again.

Formal selection still declares `writeback:true`, `activate:null`, and `failureCompensation:'none'`. An optional `newProcess:{workspace,baseline}` uses `readImproveBuildDefault(dataRoot,workspace).revision` and explicitly sets a future entry. Source write success, build receipt, future entry and actual child process observation are distinct journal facts. `improve decision --id ID` shows them separately. `improve build-default --workspace PATH` only reads the entry.

`improve launch --spec FILE` calls `launchImproveBuild` with:

```js
{ id:'explicit-process-1', decisionId, decisionSource, groupId,
  buildId, side:'candidate',
  authorization:{workspace,mode:'offline',tools:['read']},
  operation:{kind:'help'}, timeoutMs:30000 }
```

The API additionally accepts `dataRoot` and optional `signal`. A new task operation is `{kind:'run',taskType:'read'|'coding',input,dataRoot}`; its data root must be the same selected root. Coding explicitly needs `['read','write','edit','bash']`. These exact choices are saved before spawn. Launch rechecks source edits, retained executable/dependency bytes, host compatibility, selected entry, workspace fences and authorization. No run ID, recovery request, context transfer or arbitrary command is accepted. Normal runtime startup retains existing pending-work checks. Repeating a launch ID is read-only; an interrupted request remains unknown and is never retried. A child process exit is not task acceptance or improvement evidence.

`side:'baseline'` explicitly chooses the retained old build under the same authorization and compatibility checks. Source rollback uses the existing `improve rollback --spec FILE` and exact original decision/group scope, protects later edits and changed defaults, restores original source and future entry only, and rechecks retained build contents. Existing processes and external effects remain unchanged.

Eval asset execution is an independent decision with ordinary predeclared direct/regression checks. An existing JSON file uses this envelope:

```js
{schema:1,id:'addition-grader',version:'addition-v2',kind:'grader',
 value:{version:'addition-v2',program:'...',expectedStdout:'...',required:['signed addition']}}
```

`kind:'cases'` instead carries an array of existing `EvalCase` values. The envelope ID/kind stay fixed; changed content requires a new version. Prior contents/versions and necessary checks remain retained. Case changes configure future explicit `prepareEval({cases:asset.value,...})` plans; they cannot rescore old tasks. `improve assets --id DECISION` or `readImproveEvalAssets` reads the exact recorded revisions.

`improve regrade --spec FILE` calls `regradeImproveAsset` with `{decisionId,decisionSource,groupId,targetId,path,assetVersion,assetDigest,evalDataRoot,planId,revisionId,caseIds,directory}` plus API `dataRoot`. The exact retained, formally written grader is applied through the existing `regradeEval` engine to every saved eligible trial in each selected case, across both sides. No inference is rerun. Both `improve regrade` and `eval grade` handle SIGINT/SIGTERM through the existing VM cancellation path: pre-cancellation starts no grader; in-flight cancellation confirms VM termination, records ungraded remainder and exits nonzero. Old grades never fill the missing side of a new revision. Original outcomes, grades, first failure, previous report and affected conclusions remain visible; a corrected grade is not retroactive proof that a simultaneously changed candidate improved.

Actual checks and installed acceptance identity are recorded in `validation.json` and the coordinator's external evidence directory. No paid inference or performance winner is claimed.

Restricted checks, builds, startup and explicit new processes retain the exact bytes delivered by stdout/stderr data events, including the complete event that crosses the output limit. At that point both pipes stop being read; output never delivered after stop is not claimed. Acquisition is bounded by each stream's configured byte cap plus its first over-limit event, stored in 64 KiB blocks. Text fields are UTF-8 projections, separately marked when display is truncated; invalid binary and split UTF-8 remain available in the original blocks.

Before product results are recorded, `execution.output` receipts retain these blocks as ordinary Evidence objects with ordered hash/byte references. Existing object-range reads page the bytes, and fixation/cleanup dependency checks see every block directly. `improve.check` embeds at most 16 KiB per text stream and retains the original execution document separately in `executionRef`. New-process output waits for child close and reacquires the data-root owner before saving blocks. A persistence failure leaves the operation failed/unknown and never publishes a complete-retention receipt; it does not rerun the process or weaken VM termination checks.
