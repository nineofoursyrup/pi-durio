import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Evidence } from '../src/evidence.js';
import { watermark, records } from '../src/history.js';
import { runReadTask } from '../src/runtime.js';
import { demoTransport } from '../src/offline.js';
import { displayNumber, displayHex, readDisplayIndex, resolveDisplayInput, DisplayIndex, DisplayInputError } from '../src/display-number.js';

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
  assert.throws(() => displayHex('management:cleanup'), /DISPLAY_IDENTITY_UNSUPPORTED/);
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
