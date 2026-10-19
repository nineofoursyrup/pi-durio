#!/usr/bin/env node
/**
 * Rebuild authentic f26ae8f compatibility records into a NEW directory.
 * node scripts/fixtures/generate-v1-records.mjs NEW_OUTPUT FROZEN_CANDIDATE
 * FROZEN_CANDIDATE contains candidate-identity.json, install/node_modules/pi-durio and linux-runtime.
 * Offline transport only. Validation uses the existing local container boundary;
 * no model/provider requests. Original fixtures and installation remain immutable.
 */
import assert from 'node:assert/strict';
import { inventory, sha256 } from '../redesign-terminal/common.mjs';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const [outputArg, installArg] = process.argv.slice(2);
if (!outputArg || !installArg) {
  console.error('Usage: node generate-v1-records.mjs NEW_OUTPUT FROZEN_CANDIDATE');
  process.exit(1);
}
const frozenDir = resolve(installArg), installDir = join(frozenDir, 'install/node_modules/pi-durio');
const outputDir = resolve(outputArg);
assert.equal(existsSync(outputDir), false, 'Refuse to replace an existing fixture');
const identityPath = join(frozenDir, 'candidate-identity.json');
assert.equal(sha256(readFileSync(identityPath)), '7cd21af10280ae331aa3b77df06588d398a2d343d6f2aed71725d39b84b05546');
const frozen = JSON.parse(readFileSync(identityPath, 'utf8'));
assert.equal(frozen.candidate, 'f26ae8f4b8039608a1fa796e1c69da4d8173d112');
const sorted = rows => [...rows].sort((a,b) => a.path.localeCompare(b.path));
const expectedInstallation = sorted(inventory(installDir));
assert.equal(sha256(JSON.stringify(expectedInstallation)), frozen.installedInventorySha256, 'Frozen installation must match every file and link');
globalThis.fetch = async () => { throw Error('FIXTURE_NETWORK_FORBIDDEN'); };

// ── dynamic imports from v1 build ──────────────────────────────────────────

const {
  runCodingTask, runReadTask, analyzeImprove, recoverRun,
  inspectRecovery, checkRecovery, readRun, readQueue, TaskControl,
} = await import(join(installDir, 'dist/src/runtime.js'));

const { demoTransport, scriptedTransport } = await import(join(installDir, 'dist/src/offline.js'));

const { submitImproveDecision, listImproveSuppressions } =
  await import(join(installDir, 'dist/src/improve-decisions.js'));

const { prepareEval } = await import(join(installDir, 'dist/src/eval/plan.js'));
const { runEval } = await import(join(installDir, 'dist/src/eval/runner.js'));
const linuxRuntime = join(frozenDir, 'linux-runtime');
const linuxInventory = inventory(linuxRuntime);
assert.equal(sha256(JSON.stringify(sorted(linuxInventory))), frozen.linuxInventorySha256, 'Frozen Linux runtime must match every file and link');
const { representativeCases } = await import(join(installDir, 'dist/src/eval/fixtures.js'));

// ── workspace + data root setup ────────────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'durio-v1-fixture-'));
const workspace = join(tmpRoot, 'project');
const dataRoot  = join(tmpRoot, 'data');

await mkdir(workspace);
await writeFile(join(workspace, 'README.md'),  'Fixture project for pi-durio redesign tests.\n');
await writeFile(join(workspace, 'math.mjs'),   'export const add = (a, b) => a - b;\n');

console.log('workspace:', workspace);
console.log('dataRoot: ', dataRoot);

const identity = { names: {}, unavailable: {}, provenance: 'runtime-generated', frozenIdentitySha256: sha256(readFileSync(identityPath)) };
function record(label, id) { identity.names[label] = id; console.log(`  ${label}: ${id}`); }

// ── helper: improve transport that returns a scripted report ───────────────
// Sequences: evidence_summary → source_view(math.mjs) → final answer.
// On the third call, extracts the source_view evidence ID from the request body
// and injects it into each candidate's facts so validation passes.

function improveTransportWith(reportTemplate) {
  let callCount = 0;
  const calls = [];
  const frame = (choices, usage) =>
    'data: ' + JSON.stringify({ id: `offline-imp-${callCount}`, model: 'offline', choices, ...(usage ? { usage } : {}) }) + '\n\n';
  const sse = (delta, stop) =>
    frame([{ index: 0, delta, finish_reason: null }]) +
    frame([{ index: 0, delta: {}, finish_reason: stop ? 'stop' : 'tool_calls' }]) +
    frame([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) +
    'data: [DONE]\n\n';

  const fetcher = async (_url, init) => {
    callCount++;
    calls.push(JSON.parse(String(init?.body)));
    if (callCount === 1) {
      // Step 1: request evidence_summary
      return new Response(sse({ tool_calls: [{ index: 0, id: 'imp-1', type: 'function', function: { name: 'evidence_summary', arguments: '{}' } }] }, false),
        { headers: { 'content-type': 'text/event-stream' } });
    } else if (callCount === 2) {
      // Step 2: request source_view for math.mjs
      return new Response(sse({ tool_calls: [{ index: 0, id: 'imp-2', type: 'function', function: { name: 'source_view', arguments: JSON.stringify({ targetId: 'project', path: 'math.mjs' }) } }] }, false),
        { headers: { 'content-type': 'text/event-stream' } });
    } else {
      // Step 3: return final answer; extract source_view ID from tool result in request
      const payload = calls[calls.length - 1];
      let evidenceId = null;
      for (const msg of (payload.messages ?? [])) {
        if (msg.role === 'tool' && msg.tool_call_id === 'imp-2') {
          try {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            const parsed = JSON.parse(content);
            evidenceId = parsed?.sourceId ?? parsed?.id ?? null;
          } catch {}
          break;
        }
      }
      // Inject the real evidence ID into all facts; fall back to empty if not found
      console.log('  [improve transport] captured evidenceId:', evidenceId ?? '(none – will fail)');
      const injectId = (facts) => facts.map(f => ({ ...f, evidence: evidenceId ? [evidenceId] : f.evidence }));
      const report = {
        summary: reportTemplate.summary,
        candidates: reportTemplate.candidates.map(c => ({ ...c, facts: injectId(c.facts) })),
        gaps: reportTemplate.gaps,
      };
      const answer = JSON.stringify(JSON.stringify(report)).slice(1, -1);
      const text = sse({ content: 'Controlled response: inspect actual tool evidence for acceptance.' }, true);
      return new Response(
        text.replace('Controlled response: inspect actual tool evidence for acceptance.', answer),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
  };
  return { calls, fetch: fetcher };
}

// ── scenario 1: coding task ────────────────────────────────────────────────

console.log('\n[1] coding task');
const codingResult = await runCodingTask({
  workspace, dataRoot,
  input: 'Read README.md and describe the project.',
  mode: 'offline',
  transport: demoTransport().fetch,
});
if (codingResult.status !== 'completed') throw Error(`coding: ${codingResult.status} – ${codingResult.reason}`);
record('run.coding', codingResult.runId);
record('session.coding', codingResult.sessionId);

// ── scenario 2: read task ──────────────────────────────────────────────────

console.log('\n[2] read task');
const readResult = await runReadTask({
  workspace, dataRoot,
  input: 'Summarize the workspace contents.',
  mode: 'offline',
  transport: scriptedTransport([]).fetch,
});
if (readResult.status !== 'completed') throw Error(`read: ${readResult.status}`);
record('run.read', readResult.runId);
record('session.read', readResult.sessionId);

// ── scenario 3: fork – completed run resumed twice ─────────────────────────

console.log('\n[3a] fork continuation 1');
const fork1 = await runCodingTask({
  workspace, dataRoot,
  input: 'Continue from the first coding session.',
  mode: 'offline',
  transport: demoTransport().fetch,
  contextRunId: codingResult.runId,
});
if (fork1.status !== 'completed') throw Error(`fork1: ${fork1.status}`);
record('run.fork-1', fork1.runId);
record('session.fork-1', fork1.sessionId);

console.log('\n[3b] fork continuation 2 (same source → fork)');
const fork2 = await runCodingTask({
  workspace, dataRoot,
  input: 'Alternative continuation of the first coding session.',
  mode: 'offline',
  transport: demoTransport().fetch,
  contextRunId: codingResult.runId,
});
if (fork2.status !== 'completed') throw Error(`fork2: ${fork2.status}`);
record('run.fork-2', fork2.runId);
record('session.fork-2', fork2.sessionId);

// ── scenario 4: run aborted before context.imported ───────────────────────

console.log('\n[4] run aborted before context.imported');
const earlyAbort = await runCodingTask({
  workspace, dataRoot,
  input: 'Should not reach context.imported.',
  mode: 'offline',
  transport: scriptedTransport([]).fetch,
  contextRunId: codingResult.runId,
  fault: kind => {
    if (kind === 'context.imported') throw Error('FIXTURE_ABORT_BEFORE_IMPORT');
  },
});
// status may be 'unknown' because the fault prevented clean session close.
// Record the identity, then resolve recovery so subsequent runs are unblocked.
record('run.early-abort', earlyAbort.runId);
console.log('  status:', earlyAbort.status, '– context.imported not written');

// Resolve recovery of the early-abort run so the data root is usable again.
const auth4 = { workspace, mode: 'offline', tools: ['read', 'write', 'edit', 'bash'] };
const report4 = await checkRecovery({ dataRoot, runId: earlyAbort.runId, authorization: auth4 });
console.log('  recovery4 status:', report4.status);
if (report4.status !== 'completed') {
  const ended4 = await recoverRun({
    dataRoot, runId: earlyAbort.runId, authorization: auth4,
    decision: { id: 'end-early-abort-recovery', snapshotId: report4.snapshotId, action: 'end' },
    transport: scriptedTransport([]).fetch,
  });
  console.log('  ended recovery4:', ended4.status);
}

// ── scenario 5: actual unsafe dispatch with retained-result fault, then skip ──
// The public v1 fault seam refuses result/error recording after a real write.
// No private durable task, checkpoint, LiveDoc or host fact is manufactured.
console.log('\n[5] actual uncertain write and legacy skip');
const uncertainResult = await runCodingTask({
 workspace, dataRoot, input:'Write uncertain.txt once.', mode:'offline',
 transport:scriptedTransport([{name:'write',args:{path:'uncertain.txt',content:'real side effect\n'}}]).fetch,
 fault:kind=>{if(['tool.result','tool.error'].includes(kind))throw Error('FIXTURE_RESULT_UNAVAILABLE');},
});
assert.equal(uncertainResult.status,'unknown');
assert.equal(readFileSync(join(workspace,'uncertain.txt'),'utf8'),'real side effect\n');
record('run.uncertain-source',uncertainResult.runId);record('session.uncertain',uncertainResult.sessionId);
const authorization5={workspace,mode:'offline',tools:['read','write','edit','bash']};
const report5=await checkRecovery({dataRoot,runId:uncertainResult.runId,authorization:authorization5});
assert.equal(report5.status,'needs-decision');assert.ok(report5.tools.some(tool=>tool.fact==='unknown'));
record('recovery.snapshot-uncertain',report5.snapshotId);
const recovered5=await recoverRun({dataRoot,runId:uncertainResult.runId,authorization:authorization5,
 decision:{id:'skip-actual-uncertain',snapshotId:report5.snapshotId,action:'continue',acceptAdditionalModelAttempts:true,
  resolutions:report5.tools.filter(tool=>tool.fact==='unknown').map(tool=>({taskId:tool.taskId,choice:'skip',reason:'Fixture skip decision after an actual unsafe write with unavailable result'}))},
 transport:scriptedTransport([]).fetch});
assert.equal(recovered5.status,'completed');record('run.recovery-skip',recovered5.runId);

console.log('\n[5d] ordinary read-only follow-up (actual write denial is a separate fixture)');
// A write attempt is rejected because authorization only allows read
const readonlyResult = await runReadTask({
  workspace, dataRoot,
  input: 'Read README.md only.',
  mode: 'offline',
  transport: scriptedTransport([
    { name: 'read', args: { path: 'README.md' } },
    // This write is denied by read-only authorization, but the task still runs
  ]).fetch,
  // read-only: coding=false → only read tool available, write would be rejected by harness
});
record('run.readonly-followup', readonlyResult.runId);
console.log('  readonly result:', readonlyResult.status);

// ── scenario 6: improve report with multiple decisions ─────────────────────

console.log('\n[6] improve analysis');

// The improve report transport returns two candidates
const improveCandidate1 = {
  title: 'Correct addition operator',
  problem: 'Subtraction operator used where addition is required',
  problemKey: 'math.add.operator',
  conditionKey: 'initial',
  objective: 'bug',
  targetId: 'project',
  facts: [{ claim: 'The source file contains a - b where a + b is required', evidence: [] }],
  hypotheses: ['Replacing - with + restores correct signed addition'],
  successCounterexamples: [],
  gaps: ['No automated regression in fixture context'],
  mechanismsReviewed: ['math.mjs'],
  steps: ['Replace a - b with a + b in math.mjs'],
  scope: ['math.mjs'],
  validation: { method: 'regression', checks: ['add(2,3)===5 and add(-2,3)===1'], budget: 'one regression check', protections: ['No other files change'] },
  risks: ['Downstream callers expecting subtraction behavior'],
  rollback: 'Restore retained original bytes only while current content still matches this batch',
  activation: { writeback: true, enable: false, conditions: ['regression check passes'], timing: 'subsequent new tasks' },
  dependencies: [], conflicts: [],
};

const improveCandidate2 = {
  title: 'Clarify README purpose',
  problem: 'README does not describe the math module',
  problemKey: 'readme.math-description',
  conditionKey: 'initial',
  objective: 'maintenance',
  targetId: 'project',
  facts: [{ claim: 'README says fixture project but does not mention math.mjs', evidence: [] }],
  hypotheses: ['Adding a line improves discoverability'],
  successCounterexamples: [],
  gaps: ['Pure documentation change; no behavioral test possible'],
  mechanismsReviewed: ['README.md'],
  steps: ['Add math module description to README'],
  scope: ['README.md'],
  validation: { method: 'direct', checks: ['Verify README.md contains math description'], budget: 'one direct check', protections: ['No code files change'] },
  risks: ['README change may not match project tone without review'],
  rollback: 'Restore original README bytes',
  activation: { writeback: true, enable: false, conditions: ['direct check passes'], timing: 'subsequent new tasks' },
  dependencies: [], conflicts: [],
};

const improveReport = {
  summary: 'Controlled fixture improve report with two candidates.',
  candidates: [improveCandidate1, improveCandidate2],
  gaps: ['Offline fixture only; no model inference performed.'],
};

const improveTransport = improveTransportWith(improveReport);
const improveRun = await analyzeImprove({
  dataRoot, workspace,
  targetRunId: codingResult.runId,
  request: { id: 'fixture-improve-1', purpose: 'Controlled fixture improve analysis', limits: { maxRequests: 8, maxTokens: 2048, maxRequestTokens: 256, maxDurationMs: 30000, maxOutputTokens: 128 }, sources: [{ id: 'project', kind: 'project', paths: ['math.mjs', 'README.md'] }] },
  mode: 'offline',
  transport: improveTransport.fetch,
});
if (improveRun.status !== 'completed') throw Error(`improve run: ${improveRun.status} – ${improveRun.reason}`);
record('run.improve', improveRun.runId);
console.log('  improve candidates:', improveRun.improve?.candidates?.length);
if (!improveRun.improve?.candidates?.length) throw Error(`improve: 0 candidates (state: ${improveRun.improve?.state}, reason: ${improveRun.improve?.reason})`);

// Read the processed report to get proper candidate objects with target/source refs
const { readImproveReport } = await import(join(installDir, 'dist/src/improve.js'));
const savedReport = readImproveReport(dataRoot, 'fixture-improve-1');
const candidate1 = savedReport.report.candidates[0];
const candidate2 = savedReport.report.candidates[1];
console.log('  candidate-1 id:', candidate1.id);
console.log('  candidate-2 id:', candidate2.id);
record('improve.report', 'fixture-improve-1');

// Decision 1: defer on candidate-1 (multiple decisions on same candidate)
console.log('\n[6a] decision: defer candidate-1');
const decision1 = await submitImproveDecision({
  dataRoot,
  decision: {
    id: 'improve-decision-defer-1',
    reportId: savedReport.report.id,
    reportRevision: savedReport.report.revision,
    selections: [{ candidateId: candidate1.id, candidateRevision: candidate1.revision, target: candidate1.target, mode: 'defer', steps: candidate1.steps }],
    groups: [],
    limits: { deadline: new Date(Date.now() + 120000).toISOString(), maxChecks: 0, maxRequests: 0, maxTokens: 0 },
  },
});
record('improve.decision-defer', 'improve-decision-defer-1');
console.log('  state:', decision1.state);

// Decision 2: validate-only on candidate-1 (same candidate, different decision)
console.log('\n[6b] decision: validate-only candidate-1 (runs regression check in container)');
const checkProgram = `
import { readFileSync } from 'node:fs';
const content = readFileSync('/work/targets/project/math.mjs', 'utf8');
if (!content.includes('a + b')) throw new Error('Expected a + b but got: ' + content.trim());
`;
const decision2 = await submitImproveDecision({
  dataRoot,
  decision: {
    id: 'improve-decision-validate-1',
    reportId: savedReport.report.id,
    reportRevision: savedReport.report.revision,
    selections: [{ candidateId: candidate1.id, candidateRevision: candidate1.revision, target: candidate1.target, mode: 'validate-only', steps: candidate1.steps }],
    groups: [{
      id: 'fix-math',
      candidateIds: [candidate1.id],
      changes: [{ targetId: 'project', path: 'math.mjs', content: 'export const add = (a, b) => a + b;\n' }],
      checks: [{ kind: 'regression', program: checkProgram, timeoutMs: 30000 }],
    }],
    directory: join(realpathSync(tmpRoot), 'validate-dir'),
    limits: { deadline: new Date(Date.now() + 120000).toISOString(), maxChecks: 1, maxRequests: 0, maxTokens: 0 },
  },
});
record('improve.decision-validate', 'improve-decision-validate-1');
console.log('  state:', decision2.state, '– writeback:', decision2.writeback ?? decision2.groups?.[0]?.state);

// Decision 3: do-not-suggest on candidate-2 → suppression (before writeback so revision is still current)
console.log('\n[6c] decision: do-not-suggest candidate-2 → suppression');
const decision3 = await submitImproveDecision({
  dataRoot,
  decision: {
    id: 'improve-decision-suppress-1',
    reportId: savedReport.report.id,
    reportRevision: savedReport.report.revision,
    selections: [{ candidateId: candidate2.id, candidateRevision: candidate2.revision, target: candidate2.target, mode: 'do-not-suggest', steps: candidate2.steps }],
    groups: [],
    limits: { deadline: new Date(Date.now() + 120000).toISOString(), maxChecks: 0, maxRequests: 0, maxTokens: 0 },
  },
});
record('improve.decision-suppress', 'improve-decision-suppress-1');
console.log('  state:', decision3.state);

const suppressions = listImproveSuppressions(dataRoot);
console.log('  suppression count:', suppressions.length);
const suppressed = suppressions.find(item => item.mode === 'do-not-suggest');
assert.ok(suppressed);record('improve.suppression', suppressed.id);

// A real frozen submission batch: admitted by v1, cancelled before its group.
// This is separate from a queued improve analysis request.
const cancelled = AbortSignal.abort('offline fixture: stop before first group');
const frozenDecision = await submitImproveDecision({dataRoot,signal:cancelled,decision:{
 id:'improve-decision-frozen-1',reportId:savedReport.report.id,reportRevision:savedReport.report.revision,
 selections:[{candidateId:candidate1.id,candidateRevision:candidate1.revision,target:candidate1.target,mode:'validate-only',steps:candidate1.steps}],
 groups:[{id:'frozen-fix-math',candidateIds:[candidate1.id],changes:[{targetId:'project',path:'math.mjs',content:'export const add = (a, b) => a + b;\n'}],checks:[{kind:'regression',program:checkProgram,timeoutMs:30000}]}],
 directory:join(realpathSync(tmpRoot),'frozen-batch-dir'),limits:{deadline:new Date(Date.now()+120000).toISOString(),maxChecks:1,maxRequests:0,maxTokens:0}
}});
assert.equal(frozenDecision.state,'frozen');record('improve.decision-frozen','improve-decision-frozen-1');

// Decision 4: execute-declared-scope on candidate-1 (writes back; done last so baseline drift doesn't affect earlier decisions)
console.log('\n[6d] decision: execute candidate-1 → write back math.mjs');
const decision4 = await submitImproveDecision({
  dataRoot,
  decision: {
    id: 'improve-decision-execute-1',
    reportId: savedReport.report.id,
    reportRevision: savedReport.report.revision,
    selections: [{ candidateId: candidate1.id, candidateRevision: candidate1.revision, target: candidate1.target, mode: 'execute-declared-scope', steps: candidate1.steps, formal: { writeback: true, activate: null, failureCompensation: 'none' } }],
    groups: [{
      id: 'fix-math',
      candidateIds: [candidate1.id],
      changes: [{ targetId: 'project', path: 'math.mjs', content: 'export const add = (a, b) => a + b;\n' }],
      checks: [{ kind: 'regression', program: checkProgram, timeoutMs: 30000 }],
    }],
    directory: join(realpathSync(tmpRoot), 'execute-dir'),
    limits: { deadline: new Date(Date.now() + 120000).toISOString(), maxChecks: 1, maxRequests: 0, maxTokens: 0 },
  },
});
record('improve.decision-execute', 'improve-decision-execute-1');
console.log('  state:', decision4.state, '– writeback:', decision4.writeback);

// ── scenario 7: frozen follow-up, frozen compact, frozen improve ───────────

console.log('\n[7] frozen queue items');

const frozenControl = new TaskControl();
const frozenController = new AbortController();
let frozenActions;

const frozenTransport = scriptedTransport([
  { name: 'bash', args: { command: `'${process.execPath}' -e "setTimeout(()=>{},300);console.log('ok')"` } }
]);

const frozenResult = await runCodingTask({
  workspace, dataRoot,
  input: 'Run a fixture task so queue items can be submitted before stop.',
  mode: 'offline',
  transport: frozenTransport.fetch,
  control: frozenControl,
  signal: frozenController.signal,
  cancellation: 'stop',
  onObservation: event => {
    if (event.kind !== 'tool.output' || frozenActions) return;
    frozenActions = (async () => {
      const target = frozenControl.target();
      await frozenControl.submit({ id: 'frozen-follow', kind: 'follow-up', input: 'Queued follow-up – to be frozen by stop', target });
      await frozenControl.submit({ id: 'frozen-compact', kind: 'compact', input: 'Fixture compact directive – to be frozen by stop', target });
      await frozenControl.submit({ id: 'frozen-improve', kind: 'improve',
        input: JSON.stringify({ id: 'frozen-improve', purpose: 'Queued improve analysis – to be frozen by stop',
          limits: { maxRequests: 4, maxTokens: 1024, maxRequestTokens: 512, maxDurationMs: 30000, maxOutputTokens: 64 } }),
        target });
      frozenController.abort();
    })();
  },
});
await frozenActions;
record('run.frozen-source', frozenResult.runId);
record('session.frozen-source', frozenResult.sessionId);
console.log('  status:', frozenResult.status);

const queueItems = readQueue(dataRoot).items;
console.log('  frozen queue items:', queueItems.filter(i => i.status === 'frozen').map(i => i.requestId).join(', '));

// ── scenario 8: eval plan with USD budget + absolute delta ─────────────────

console.log('\n[8] eval plan: USD budget + absolute δ comparison');

const evalBudget = {
  maxRequests: 8,
  maxTokens: 2048,
  maxRequestTokens: 256,
  deadline: new Date(Date.now() + 3600000).toISOString(),
  unknownUpperBound: null,
};

const usdPrice = {
  version: 'v1-fixture-usd',
  source: 'Fixture only; first-version plan stays USD and is never repriced',
  currency: 'USD',
  perMillionTokens: 2,
};

const evalPlan = await prepareEval({
  dataRoot,
  id: 'fixture-eval-plan-1',
  purpose: 'v1 fixture eval plan with USD price and absolute delta comparison',
  mode: 'offline',
  installation: linuxRuntime,
  price: usdPrice,
  budget: evalBudget,
  cases: [representativeCases[0]],
  comparison: {
    kind: 'deterministic',
    repetitions: 1,
    change: 'Fixed addition operator in math.mjs',
    hypothesis: 'Correcting the operator improves pass rate',
    objective: { metric: 'task-pass', direction: 'higher', delta: 1, basis: 'local-fix case should pass after the operator fix' },
    roles: { 'local-fix': 'objective' },
    trialBudget: { maxRequests: 4, maxTokens: 1024 },
    protections: [{ id: 'baseline-task-pass', cases: ['local-fix'], kind: 'hard', check: 'task', basis: 'Baseline task must pass to confirm the comparison is valid' }],
    sides: {
      baseline: { installation: linuxRuntime, instructions: '' },
      candidate: { installation: linuxRuntime, instructions: '' },
    },
  },
});
record('eval.plan', 'fixture-eval-plan-1');
console.log('  plan mode:', evalPlan.plan.mode, '– price currency:', evalPlan.plan.price.currency);

assert.equal(evalPlan.plan.runtime.id, frozen.linuxRuntimeIdentity, 'Verify frozen Linux runtime content and file modes before any dispatch');
const evaluated = await runEval({dataRoot,id:evalPlan.plan.id,directory:join(realpathSync(tmpRoot),'eval-trials')});
console.log('  eval counts:',JSON.stringify(evaluated.counts));
for(const trial of evaluated.trials)console.log('  trial:',trial.id,trial.outcome.status,trial.grade?.judgment,trial.outcome.reason);
assert.equal(evaluated.counts.started,2,'Both actual trials must dispatch');
assert.equal(evaluated.counts.completed,2,'Both actual offline runtime trials must complete');
assert.equal(evaluated.counts.gradable,2,'Both actual trials must be graded');
identity.linuxRuntimeIdentity=evalPlan.plan.runtime.id;
identity.unavailable['readonly-write-denial'] = 'Provided by the separately preserved v1-readonly-denial fixture, generated through the same frozen runtime.';

// ── copy to output directory ───────────────────────────────────────────────

console.log('\nCopying fixture to', outputDir, '...');
assert.deepEqual(sorted(inventory(installDir)), expectedInstallation, 'Generation must leave v1 installation unchanged');
assert.deepEqual(inventory(linuxRuntime), linuxInventory, 'Generation must leave frozen Linux runtime unchanged');
await mkdir(outputDir);
await cp(dataRoot, join(outputDir, 'data'), { recursive: true });
await cp(workspace, join(outputDir, 'workspace'), { recursive: true });

// Write the identity manifest
identity.generatedBy = 'f26ae8f';
identity.generatedAt = new Date().toISOString();
identity.note = 'All records written through the verified f26ae8f runtime public entry points, with offline transport and the public fault seam. No direct Evidence append, durable mutation, provider request or paid call. Unavailable scenarios are explicit.';
const files=inventory(outputDir);identity.size={files:files.length,bytes:files.reduce((n,file)=>n+statSync(join(outputDir,file.path)).size,0),scope:'data and workspace files; metadata and README excluded'};
await writeFile(
  join(outputDir, 'fixture-identity.json'),
  JSON.stringify(identity, null, 2) + '\n'
);

const rows=Object.entries(identity.names).map(([name,id])=>`| ${name} | ${id} |`).join('\n');
await writeFile(join(outputDir,'README.md'),`# 首版 runtime 记录夹具\n\n来源：${frozen.candidate}，冻结安装清单逐文件核验。所有记录由首版公开 runtime 入口写出，transport 为离线合成输入。真实 provider、原生 Terminal、日用接受均 NOT_RUN。\n\n生成：\n\n\`\`\`sh\nnode scripts/fixtures/generate-v1-records.mjs NEW_OUTPUT FROZEN_CANDIDATE\n\`\`\`\n\nNEW_OUTPUT 必须不存在。生成过程不修改原夹具、冻结安装；独立临时项目和数据根路径见记录。工具结果故障使用公开 fault 接缝：真实 write 已发生、结果记录失败，经首版恢复接口显式 skip，不制造 durable 状态。improve.decision-frozen 是已受理但首组前取消的提交批次，与 frozen-improve 排队分析不同。\n\n数据/工作区体积：${identity.size.bytes} bytes，${identity.size.files} files（不含此说明和身份清单）。\n\n| 场景身份 | 完整 ID |\n|---|---|\n${rows}\n\n缺口：\n${Object.entries(identity.unavailable).map(([name,reason])=>`- ${name}: ${reason}`).join('\n')}\n`);

console.log('\nFixture written to', outputDir);
console.log('Identity:', JSON.stringify(identity.names, null, 2));
