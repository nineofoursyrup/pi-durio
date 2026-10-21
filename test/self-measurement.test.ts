import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessMeasurements, sourceCodeTotals, readSelfRecords, selfCostScope } from '../src/self-measurement.js';
import { Evidence, digest } from '../src/evidence.js';
import { factClock } from '../src/fact-clock.js';

test('self source counts use physical src lines, separate shipped scripts/patch/tests, and leave old builds unknown', () => {
  const inputs = [
    { path: 'src/main.ts', physicalLines: 3 }, { path: 'src/eval/run.ts', physicalLines: 7 },
    { path: 'src/tui/view.ts', physicalLines: 5 }, { path: 'scripts/eval/run.mjs', physicalLines: 4 },
    { path: 'scripts/isolation/run.py', physicalLines: 6 }, { path: 'scripts/development.mjs', physicalLines: 400 },
    { path: 'vendor/pi-tui/width-overrides.patch', physicalLines: 53 },
    { path: 'vendor/pi-tui/autocomplete-min-visible.patch', physicalLines: 8 },
    { path: 'vendor/other/ignored.patch', physicalLines: 900 },
    { path: 'test/example.test.ts', physicalLines: 9 }, { path: 'test/fixtures/raw.json', physicalLines: 1000 },
    { path: 'vendor/pi-tui/pinned.tgz', physicalLines: 99, sha256: 'fixed' },
  ];
  const totals = sourceCodeTotals({ inputs }, { dependencies: { a: '1.2.3', tui: 'file:vendor/pi-tui/pinned.tgz' } });
  assert.deepEqual(totals.product.value, { files: 3, lines: 15, groups: [{ directory: 'src/eval/', files: 1, lines: 7 }, { directory: 'src/tui/', files: 1, lines: 5 }, { directory: 'src/', files: 1, lines: 3 }] });
  assert.deepEqual(totals.scripts.value, { files: 2, lines: 10 });
  assert.deepEqual(totals.patch.value, { files: 2, lines: 61 });
  assert.equal(totals.patch.basis, 'pi-tui 补丁文件（宽度、补全最小值）的物理行（含 diff 上下文）');
  assert.equal(totals.tests.value?.lines, 9);
  assert.deepEqual(totals.dependencies.value, { count: 2, exact: true });
  assert.equal(sourceCodeTotals({ inputs: [{ path: 'src/old.ts' }] }, {}).product.value, null);
  assert.equal(sourceCodeTotals({ inputs }, { dependencies: { a: '^1.2.3' } }).dependencies.value?.exact, false);
});

test('input latency ends at a completed frame write, accumulates for the process, and needs twenty samples for p95', () => {
  let now = 10;
  const samples = new ProcessMeasurements(() => now);
  samples.input('a'); now = 14; samples.paint('\x1b[?2026h\x1b[1;1Hframe\x1b[?2026l');
  assert.deepEqual(samples.snapshot(), { firstFrameMs: 14, keys: { samples: 1, p50: 4, p95: null } });
  samples.input('b');
  samples.paint('\x1b[?2026h\x1b7\x1b[1;1HMeasuring display widths\x1b8\x1b[?2026l');
  assert.equal(samples.snapshot().keys.samples, 1, 'a width-gate status line is not the application redraw');
  now = 16; samples.paint('\x1b[?2026h\x1b[1;1Hframe\x1b[?2026l');
  samples.input('\x1b[20;10R'); samples.input('\x1b[I'); samples.input('\x1b[<0;1;1M');
  now = 17; samples.paint('\x1b[?2026h\x1b[1;1Hframe\x1b[?2026l');
  assert.equal(samples.snapshot().keys.samples, 2);
  for (let i = 0; i < 18; i++) { samples.input(i === 0 ? 'b' : 'x'); now += 2; samples.paint('\x1b[?2026h\x1b[1;1Hframe\x1b[?2026l'); }
  assert.deepEqual(samples.snapshot(), { firstFrameMs: 14, keys: { samples: 20, p50: 2, p95: 2 } });
});

function tree(root: string, relative = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(join(root, relative))) {
    const path = join(relative, name);
    if (lstatSync(join(root, path)).isDirectory()) Object.assign(result, tree(root, path));
    else result[path] = digest(readFileSync(join(root, path)));
  }
  return result;
}

test('self records keep process scope and current build identity while reading no writable store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-records-'));
  const e = new Evidence(root, 'current');
  e.append('task.accepted', { taskId: 't', sessionId: 's', input: 'fixture', workspace: '/a' });
  e.append('tool.dispatch', { attemptId: 'tool' });
  e.append('tool.output', { toolAttempt: { attemptId: 'tool' }, acquired: { stream: 'stdout', bytes: Buffer.from('hello').toString('base64') } });
  e.append('tool.result', { attemptId: 'tool', result: { content: [{ type: 'text', text: 'duplicate display' }] } });
  const installation = e.blob(JSON.stringify([{ path: 'node_modules/sdk/a', bytes: 42 }, { path: 'node_modules/native/b', bytes: 58 }]));
  e.append('execution.artifact', { node: process.version, platform: process.platform, arch: process.arch, files: [{ path: 'dist/execution/source-build.json', sha256: 'current-build' }], installation });
  e.append('execution.artifact', { node: process.version, platform: process.platform, arch: process.arch, files: [{ path: 'dist/execution/source-build.json', sha256: 'other-build' }], installation: e.blob('[]') });
  e.close();
  const before = tree(root), value = readSelfRecords(root, 'current-build', factClock().processId);
  assert.equal(value.tasks, 1); assert.equal(value.processTasks, 1); assert.equal(value.toolOutputBytes, 5);
  assert.equal(value.installation.value, 100);
  assert.equal(readSelfRecords(root, 'current-build', 'different-process').processTasks, 0);
  assert.equal(readSelfRecords(root, 'current-build', 'different-process').installation.value, null, 'the same source build in another process does not establish this installed dependency tree');
  assert.equal(readSelfRecords(root, 'absent-build', factClock().processId).installation.value, null);
  assert.deepEqual(tree(root), before);
  const scope = selfCostScope(new Date(2026, 9, 17, 10));
  assert.equal(new Date(scope.from!).getDate(), 11); assert.equal(new Date(scope.to!).getDate(), 18);
  assert.equal(new Date(scope.from!).getHours(), 0); assert.equal(scope.project, undefined);
});


test('a synchronized no-change frame completes its key sample before an unrelated later repaint', () => {
  let now = 1;
  const samples = new ProcessMeasurements(() => now);
  samples.input('\x1b[A'); now = 3; samples.paint('\x1b[?2026h\x1b[?25l\x1b[?2026l');
  now = 1000; samples.paint('\x1b[?2026h\x1b[1;1Hchanged\x1b[?2026l');
  assert.deepEqual(samples.snapshot().keys, { samples: 1, p50: 2, p95: null });
});

test('large retained outputs do not erase independent self facts at 32 MiB or 50000 records', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-large-')), e = new Evidence(root, 'current');
  e.append('task.accepted', { taskId: 'task', sessionId: 's', input: 'fixture', workspace: '/a' });
  e.append('tool.dispatch', { attemptId: 'large-output' });
  const chunk = Buffer.alloc(800000, 'x');
  for (let i = 0; i < 34; i++) e.append('tool.output', { toolAttempt: { attemptId: 'large-output' }, acquired: { bytes: chunk.toString('base64') } });
  e.append('execution.artifact', { node: process.version, platform: process.platform, arch: process.arch, files: [{ path: 'dist/execution/source-build.json', sha256: 'build' }], installation: e.blob('[{"bytes":100}]') });
  const payload = e.blob('{"chunk":"retained"}'); e.close();
  const first = readSelfRecords(root, 'build');
  assert.equal(first.tasks, 1); assert.equal(first.toolOutputBytes, 27200000); assert.equal(first.installation.value, 100);
  const db = new DatabaseSync(join(root, 'host.sqlite'));
  try {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)');
    for (let i = 0; i < 50001; i++) insert.run('historical', 'model.provider-event', '2000-01-01T00:00:00Z', JSON.stringify(payload));
    db.exec('COMMIT');
  } finally { db.close(); }
  const before = readFileSync(join(root, 'host.sqlite')), large = readSelfRecords(root, 'build');
  assert.equal(large.tasks, 1); assert.equal(large.processTasks, 1); assert.equal(large.toolOutputBytes, 27200000);
  assert.equal(large.installation.value, 100); assert.equal(large.rawBodyBytes, first.rawBodyBytes + payload.bytes); assert.deepEqual(large.gaps, []);
  assert.deepEqual(readFileSync(join(root, 'host.sqlite')), before);
});
