import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Evidence } from '../src/evidence.js';
import { watermark, records } from '../src/history.js';
import { runReadTask } from '../src/runtime.js';
import { demoTransport } from '../src/offline.js';
import { displayNumber, displayHex, readDisplayIndex, readRunOrdinals, modelRequestNumber, resolveDisplayInput, DisplayIndex, DisplayInputError } from '../src/display-number.js';

const A = 'abcde000-0000-4000-8000-000000000001', B = 'abcde111-0000-4000-8000-000000000002', C = '7f3a0000-0000-4000-8000-000000000003';
const SA = '5e550000-0000-4000-8000-00000000000a', SB = '5e551111-0000-4000-8000-00000000000b';
// First-version facts as written before display numbers existed: no migration, no stored display.
function legacyRun(root: string, runId: string, sessionId: string, workspace: string) {
  const e = new Evidence(root, runId);
  try { e.append('task.accepted', { taskId: `task-${runId}`, runId, sessionId, input: 'fixture', workspace, mode: 'offline' }); } finally { e.close(); }
}

test('display numbers are stable, typed, at least four hex digits, and lengthen only until unique', () => {
  assert.equal(displayNumber('run', C, []), 'r-7f3a');
  assert.equal(displayNumber('session', C.toUpperCase(), []), 's-7f3a');
  assert.equal(displayNumber('run', A, [A, B, C]), 'r-abcde0');
  assert.equal(displayNumber('run', B, [A, B, C]), 'r-abcde1');
  assert.equal(displayNumber('run', C, [A, B, C]), 'r-7f3a');
  assert.equal(displayNumber('run', A, [A, B, C]), displayNumber('run', A, [C, B, A]));
  const root = mkdtempSync(join(tmpdir(), 'durio-display-'));
  legacyRun(root, A, SA, '/p1'); legacyRun(root, B, SB, '/p2'); legacyRun(root, C, SA, '/p1');
  const index = readDisplayIndex(root);
  assert.deepEqual([A, B, C].map(id => index.label('run', id)), ['r-abcde0', 'r-abcde1', 'r-7f3a']);
  // Sessions collide only with sessions; the run namespace is separate.
  assert.deepEqual([SA, SB].map(id => index.label('session', id)), ['s-5e550', 's-5e551']);
  assert.equal(readDisplayIndex(join(root, 'missing')).label('run', A), 'r-abcd');
});

test('resolution is exact prefix matching: full identity, unique display, ambiguity with candidates, not found', () => {
  const index = new DisplayIndex([
    { kind: 'run', id: A, project: '/p1', at: '2026-10-13T01:00:00.000Z' },
    { kind: 'run', id: B, project: '/p2', at: '2026-10-13T02:00:00.000Z' },
    { kind: 'session', id: SA, project: '/p1', at: '2026-10-13T01:00:00.000Z' },
  ]);
  assert.deepEqual(index.resolve('run', A), { status: 'found', object: { kind: 'run', id: A, project: '/p1', at: '2026-10-13T01:00:00.000Z' } });
  assert.equal((index.resolve('run', 'r-abcde1') as any).object.id, B);
  assert.equal((index.resolve('run', 'R-ABCDE1') as any).object.id, B);
  assert.equal((index.resolve('session', 's-5e55') as any).object.id, SA);
  const ambiguous = index.resolve('run', 'r-abcd');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual((ambiguous as any).candidates.map((c: any) => [c.display, c.kind, c.id, c.project, c.at]), [
    ['r-abcde0', 'run', A, '/p1', '2026-10-13T01:00:00.000Z'],
    ['r-abcde1', 'run', B, '/p2', '2026-10-13T02:00:00.000Z'],
  ]);
  for (const input of ['r-ffff', 's-abcd', 'r-abc', 'abcde000', 'r-abcde0x']) assert.equal(index.resolve('run', input).status, 'not-found', input);
});

test('CLI --run accepts display numbers and full UUIDs; ambiguity exits nonzero before ownership or facts', async () => {
  const base = mkdtempSync(join(tmpdir(), 'durio-display-cli-')), dataRoot = join(base, 'data'), workspace = join(base, 'project');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'display fixture\n');
  const result = await runReadTask({ dataRoot, workspace, input: 'Read README.md', mode: 'offline', transport: demoTransport().fetch });
  assert.equal(result.status, 'completed');
  legacyRun(dataRoot, A, SA, '/p1'); legacyRun(dataRoot, B, SB, '/p2');
  const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/src/cli.js', ...args, '--data-root', dataRoot], { encoding: 'utf8' });
  const display = readDisplayIndex(dataRoot).label('run', result.runId);
  assert.match(display, /^r-[0-9a-f]{4,}$/);

  // Read-only command: display number and full UUID read the same run.
  const byDisplay = cli('show', '--run', display), byUuid = cli('show', '--run', result.runId);
  assert.equal(byDisplay.status, 0, byDisplay.stderr); assert.equal(byUuid.status, 0, byUuid.stderr);
  assert.deepEqual(JSON.parse(byDisplay.stdout), JSON.parse(byUuid.stdout));
  assert.ok(JSON.parse(byDisplay.stdout).records.length > 0);

  const sqlite = join(dataRoot, 'host.sqlite');
  for (const args of [['show', '--run', 'r-abcd'], ['recover', '--run', 'r-abcd']]) {
    const before = readFileSync(sqlite), seq = watermark(dataRoot);
    const child = cli(...args);
    assert.notEqual(child.status, 0, args.join(' '));
    const error = JSON.parse(child.stderr).error;
    assert.equal(error.code, 'DISPLAY_AMBIGUOUS');
    assert.deepEqual(error.candidates.map((c: any) => [c.display, c.kind, c.id, c.project]), [['r-abcde0', 'run', A, '/p1'], ['r-abcde1', 'run', B, '/p2']]);
    assert.ok(error.candidates.every((c: any) => typeof c.at === 'string'));
    assert.match(error.message, /r-abcde0 \(run · project \/p1 · /);
    assert.equal(child.stdout, '');
    assert.equal(existsSync(`${dataRoot}.lock`), false); assert.equal(existsSync(join(dataRoot, 'owner.json')), false);
    assert.equal(watermark(dataRoot), seq); assert.deepEqual(readFileSync(sqlite), before);
  }
  const missing = cli('recover', '--run', 'r-ffff');
  assert.notEqual(missing.status, 0); assert.equal(JSON.parse(missing.stderr).error.code, 'DISPLAY_NOT_FOUND');

  // Ownership-taking command: the display number reaches the command as the full identity.
  const recovered = cli('recover', '--run', display);
  assert.ok(!recovered.stderr.includes('DISPLAY_'), recovered.stderr);
  assert.equal([...records(dataRoot, { runId: result.runId, kinds: ['recovery.report'] })].length, 1);
  assert.equal(JSON.parse(recovered.stdout).runId, result.runId);
  assert.equal(resolveDisplayInput(dataRoot, 'run', result.runId), result.runId);
  assert.throws(() => resolveDisplayInput(dataRoot, 'run', 'r-abcd'), DisplayInputError);
});

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Two identities whose SHA-256 hex shares the first four digits, found deterministically.
function hashCollision(prefix: string) {
  const seen = new Map<string, string>();
  for (let i = 0; ; i++) { const id = `${prefix}${i}`, head = sha(id).slice(0, 4), other = seen.get(head); if (other) return [other, id]; seen.set(head, id); }
}

test('tasks, improve reports and eval plans: typed prefixes, SHA-256 for non-UUID identities, resolution with project "—" for plans', () => {
  assert.equal(displayHex('plan'), sha('plan'));
  assert.equal(displayHex('abcde0000000400080000000000000ff'), sha('abcde0000000400080000000000000ff'));
  assert.equal(displayNumber('eval-plan', 'plan', []), `ep-${sha('plan').slice(0, 4)}`);
  assert.equal(displayNumber('improve-report', C, []), 'ir-7f3a');
  assert.equal(displayNumber('task', C.toUpperCase(), []), 't-7f3a');
  const [P1, P2] = hashCollision('plan-'), [R1, R2] = hashCollision('report-');
  const root = mkdtempSync(join(tmpdir(), 'durio-display-kinds-'));
  legacyRun(root, A, SA, '/p1');
  const T = 'abcde222-0000-4000-8000-000000000004', F = 'abcde333-0000-4000-8000-000000000005';
  let e = new Evidence(root, B);
  try {
    e.append('task.accepted', { taskId: T, runId: B, sessionId: SB, input: 'fixture', workspace: '/p2', mode: 'offline' });
    e.append('control.accepted', { requestId: 'follow-1', kind: 'follow-up', input: 'next', taskId: F, target: { workspace: '/p2', sessionId: SB, taskId: T, runId: B } });
    e.append('control.accepted', { requestId: 'steer-1', kind: 'steer', input: 'more', taskId: T, target: { workspace: '/p2', sessionId: SB, taskId: T, runId: B } });
    e.append('improve.started', { request: { id: R1 }, target: { workspace: '/p2', runId: B } });
    e.append('improve.started', { request: { id: R2 }, target: { workspace: '/p3', runId: B } });
  } finally { e.close(); }
  for (const id of [P1, P2]) { e = new Evidence(root, id); try { e.append('eval.plan', { id }); } finally { e.close(); } }
  const index = readDisplayIndex(root);
  // The legacy fixture's task ID is not a UUID, so it is hashed; real task IDs are UUIDs.
  assert.equal(index.label('task', `task-${A}`), `t-${sha(`task-${A}`).slice(0, 4)}`);
  assert.deepEqual([T, F].map(id => index.label('task', id)), ['t-abcde2', 't-abcde3']);
  assert.equal(index.has('task', F), true);
  assert.equal(index.label('eval-plan', P1).length, 3 + 5);
  assert.equal((index.resolve('task', 't-abcde3') as any).object.id, F);
  assert.equal((index.resolve('eval-plan', index.label('eval-plan', P2)) as any).object.id, P2);
  assert.equal((index.resolve('improve-report', R1) as any).object.project, '/p2');
  assert.equal(index.resolve('eval-plan', 'r-abcd').status, 'not-found');
  const ambiguous = index.resolve('eval-plan', `ep-${sha(P1).slice(0, 4)}`);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual((ambiguous as any).candidates.map((c: any) => [c.kind, c.id, c.project]).sort(), [['eval-plan', P1, null], ['eval-plan', P2, null]].sort());
  assert.throws(() => resolveDisplayInput(root, 'eval-plan', `ep-${sha(P1).slice(0, 4)}`), (error: DisplayInputError) => error.code === 'DISPLAY_AMBIGUOUS' && / \(eval-plan · project — · /.test(error.message));
  assert.equal(resolveDisplayInput(root, 'improve-report', index.label('improve-report', R2)), R2);
  assert.throws(() => resolveDisplayInput(root, 'improve-report', `ir-${sha(R1).slice(0, 4)}`), /DISPLAY_AMBIGUOUS/);
});

test('hierarchical numbers: tool calls and model requests count in record order within their run', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-display-ordinals-'));
  legacyRun(root, A, SA, '/p1'); legacyRun(root, B, SB, '/p2');
  const a = new Evidence(root, A), b = new Evidence(root, B);
  try {
    a.append('model.intent', { attemptId: 'm1', ordinal: 1, context: { messages: ['x'.repeat(4096)] }, purpose: 'generation' });
    a.append('tool.intent', { attemptId: 't1', tool: 'read', args: { path: 'README.md' } });
    b.append('tool.intent', { attemptId: 'other', tool: 'read', args: {} });
    // A compaction request restarts the runtime's own ordinal field; display ordinals follow record order instead.
    a.append('model.intent', { attemptId: 'm2', ordinal: 1, context: {}, purpose: 'compaction' });
    a.append('tool.intent', { attemptId: 't2', tool: 'bash', args: { command: 'ls' } });
    a.append('model.intent', { attemptId: 'm3', ordinal: 2, context: {}, purpose: 'generation' });
  } finally { a.close(); b.close(); }
  const ordinals = readRunOrdinals(root, A);
  assert.deepEqual([...ordinals.tool], [['t1', 1], ['t2', 2]]);
  assert.deepEqual([...ordinals.model], [['m1', 1], ['m2', 2], ['m3', 3]]);
  assert.deepEqual([...readRunOrdinals(root, B).tool], [['other', 1]]);
  const index = readDisplayIndex(root);
  // The run hex part is exactly as long as the run's current r- number, lengthening with it.
  assert.equal(index.label('run', A), 'r-abcde0');
  assert.equal(index.toolCall(A, 2), 'tc-abcde0-02');
  assert.equal(new DisplayIndex([{ kind: 'run', id: A, project: null, at: null }]).toolCall(A, 7), 'tc-abcd-07');
  assert.equal(index.toolCall(A, 123), 'tc-abcde0-123');
  assert.equal(modelRequestNumber(3), 'llm #3');
  const trace = spawnSync(process.execPath, ['dist/src/cli.js', 'trace', '--run', 'r-abcde0', '--format', 'text', '--data-root', root], { encoding: 'utf8' });
  assert.equal(trace.status, 0, trace.stderr);
  assert.match(trace.stdout, /^pi-durio trace\nllm #1 model generation m1\ntc-abcde0-01 tool read t1\nllm #2 model compaction m2\ntc-abcde0-02 tool bash t2\nllm #3 model generation m3\n\{/);
  const json = JSON.parse(spawnSync(process.execPath, ['dist/src/cli.js', 'trace', '--run', A, '--data-root', root], { encoding: 'utf8' }).stdout);
  assert.deepEqual(json.items.map((item: any) => item.id), ['m1', 't1', 'm2', 't2', 'm3']);
  assert.doesNotMatch(JSON.stringify(json), /tc-abcde|llm #/);
});

test('candidates show C-NN@r<n> from the recorded R number and the revision ordinal; outside the report they carry the ir- number', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-display-candidates-'));
  const first = { id: 'candidate:one', revision: 'rev-a', display: 'R1' }, second = { id: 'candidate:two', revision: 'rev-b', display: 'R3' };
  const e = new Evidence(root, A);
  try {
    e.append('improve.started', { request: { id: 'my-report' }, target: { workspace: '/p1', runId: A } });
    e.append('improve.report', { id: 'my-report', candidates: [first, second], suppressed: [{ candidate: { id: 'candidate:three', revision: 'rev-c', display: 'R2' } }] });
    // A later revision of the same candidate ID is the second distinct revision; repeating one does not count again.
    e.append('improve.report', { id: 'my-report', candidates: [{ ...first, revision: 'rev-a2' }, first], suppressed: [] });
  } finally { e.close(); }
  const index = readDisplayIndex(root), report = `ir-${sha('my-report').slice(0, 4)}`;
  assert.equal(index.candidate(first), 'C-01@r1');
  assert.equal(index.candidate(second), 'C-03@r1');
  assert.equal(index.candidate({ ...first, revision: 'rev-a2' }), 'C-01@r2');
  assert.equal(index.candidate({ id: 'candidate:three', revision: 'rev-c', display: 'R2' }), 'C-02@r1');
  assert.equal(index.candidate({ id: 'candidate:new', revision: 'x', display: 'R12' }), 'C-12@r1');
  assert.equal(index.label('improve-report', 'my-report'), report);
  assert.equal(index.qualifiedCandidate('my-report', second), `${report}·C-03@r1`);
});
