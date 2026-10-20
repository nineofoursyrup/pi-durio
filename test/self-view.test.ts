import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { Evidence, digest } from '../src/evidence.js';
import { readSelfSnapshot, ProcessMeasurements, processMeasurements, selfStorage } from '../src/self-measurement.js';
import { SelfView } from '../src/tui/self.js';
import { StatsBrowser } from '../src/tui/stats-browser.js';
import { statsRequest } from '../src/tui/stats.js';
import { parseCommand } from '../src/tui/commands.js';
import { captureSnapshot, snapshotText } from '../src/tui/snapshot.js';
import { ReadOnlyTui } from '../src/tui/app.js';

const text = (lines: string[]) => lines.map(stripTerminalSequences).join('\n');
const now = new Date(2026, 9, 17, 10);
const host = { changed() {}, feedback(_text: string) {}, export(_value: unknown) {} };
function contents(root: string, relative = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(join(root, relative))) {
    const path = join(relative, name);
    if (lstatSync(join(root, path)).isDirectory()) Object.assign(result, contents(root, path));
    else result[path] = digest(readFileSync(join(root, path)));
  }
  return result;
}

test('opening self and b read existing records only; b retains process samples and export contains hidden environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-view-')), e = new Evidence(root, 'run');
  e.append('task.accepted', { taskId: 't', sessionId: 's', workspace: '/fixture', input: 'existing', origin: { kind: 'coding', source: 'ordinary' } }); e.append('run.closed', { status: 'completed', cleanup: 'confirmed' }); e.close();
  const before = contents(root), samples = new ProcessMeasurements(() => 4);
  samples.input('x'); samples.paint('\x1b[?2026h\x1b[1;1Hframe\x1b[?2026l');
  let exported: any;
  const view = new SelfView(root, { ...host, export: value => { exported = value; } }, { samples, dimensions: () => ({ columns: 132, rows: 38 }), now: () => now });
  await view.ready;
  assert.match(text(view.render(132, 38)), /p50.*1 样本/);
  assert.match(text(view.render(132, 38)), /样本不足 20，不计 p95/);
  samples.input('b'); samples.paint('\x1b[?2026h\x1b[1;1Hframe\x1b[?2026l');
  await view.handleInput('b'); view.handleInput('e');
  assert.equal(exported.keys.samples, 2); assert.equal(exported.environment.dataRoot, root);
  assert.equal(exported.environment.columns, 132); assert.equal(exported.environment.rows, 38);
  assert.equal(exported.cost.value.scope.project, undefined);
  assert.ok(exported.notMeasured.every((item: any) => item.value === null && item.reason));
  assert.doesNotMatch(text(view.render(132, 38)), new RegExp(root));
  assert.deepEqual(contents(root), before);
});

test('storage in progress blocks remeasurement/export and Escape discards the pending result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-pending-'));
  let resolve!: (value: Awaited<ReturnType<typeof selfStorage>>) => void, queries = 0, feedback = '', exports = 0, changes = 0;
  const read = (...args: Parameters<typeof readSelfSnapshot>) => { queries++; return readSelfSnapshot(...args); };
  const pending = new Promise<Awaited<ReturnType<typeof selfStorage>>>(done => { resolve = done; });
  const view = new SelfView(root, { changed() { changes++; }, feedback(text) { feedback = text; }, export() { exports++; } }, { read, storage: () => pending });
  await new Promise(done => setTimeout(done, 220));
  assert.match(text(view.render(132, 38)), /⠋ 统计中/);
  view.handleInput('b'); assert.equal(feedback, '统计进行中'); assert.equal(queries, 1);
  view.handleInput('e'); assert.equal(feedback, '统计完成后再导出'); assert.equal(exports, 0);
  view.cancel(); const afterCancel = changes;
  resolve(await selfStorage(root, view.snapshot.facts)); await view.ready;
  assert.equal(view.storageResult, undefined); assert.equal(changes, afterCancel);
});

test('/stats --self opens the self tab; only table-level Tab switches, and self export uses the shared dialog', async () => {
  assert.equal(parseCommand('/stats --self').options.self, true);
  const root = mkdtempSync(join(tmpdir(), 'durio-self-tabs-'));
  const existing = new Evidence(root, 'empty'); existing.close();
  const view = new StatsBrowser(root, root, statsRequest({}, root, now), { open() {}, changed() {}, feedback() {}, copy: async () => true }, { tab: 'self' });
  assert.equal(view.tab, 'self');
  await view.self!.ready;
  assert.match(text(view.render(80, 24)), /◆ self/);
  view.handleInput('e'); assert.equal(view.layer, 'export');
  view.handleInput('\t'); assert.equal(view.tab, 'self');
  assert.match(text(view.render(80, 24)), /stats-self/);
  view.back(); view.handleInput('\x1b[Z'); assert.equal(view.tab, 'metrics');
  view.handleInput('/'); view.handleInput('\t'); assert.equal(view.tab, 'metrics');
  view.back(); view.handleInput('\t'); assert.equal(view.tab, 'self'); await view.self!.ready; view.cancel();
});

test('2c layout golden has two columns at 132x38 and wraps the fixed label column on narrow screens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-layout-'));
  const existing = new Evidence(root, 'empty'); existing.close();
  const samples = new ProcessMeasurements(() => 12);
  const view = new SelfView(root, host, { samples, now: () => now });
  await view.ready;
  const snapshot = view.snapshot;
  snapshot.environment = { build: '0123456789', chip: 'Example CPU', system: '27.2', node: 'v26.8.2', terminal: 'Terminal.app', terminalVersion: 'hidden-version', columns: 132, rows: 38, dataRoot: '/hidden-root', uptimeMs: 240000 };
  snapshot.code.product.value = { files: 12, lines: 600, groups: [{ directory: 'src/tui/', files: 5, lines: 300 }, { directory: 'src/', files: 4, lines: 150 }, { directory: 'src/eval/', files: 2, lines: 100 }, { directory: 'src/metrics/', files: 1, lines: 50 }] };
  snapshot.code.scripts.value = { files: 3, lines: 100 }; snapshot.code.patch.value = { files: 1, lines: 53 }; snapshot.code.tests.value = { files: 10, lines: 200 };
  snapshot.installation.value = 10485760; snapshot.memory.value = { bytes: 10485760, state: '空闲' }; snapshot.peak.value = { bytes: 20971520, tasks: 2, toolOutputBytes: 1024 };
  if (snapshot.query.value) snapshot.query.value.ms = 3;
  const lines = view.render(132, 38, 'truecolor');
  const grid = captureSnapshot(lines, 132, 38, 'truecolor');
  for (const tier of ['truecolor', '256color', 'none'] as const) {
    const rendered = view.render(132, 38, tier), cells = captureSnapshot(rendered, 132, 38, tier).rows.flat().filter(cell => cell.char === '█');
    assert.ok(cells.length > 0, 'own-code bars retain their solid glyph');
    if (tier === 'none') assert.doesNotMatch(rendered.join(''), /\x1b\[(?:38|48);/);
    else assert.ok(cells.every(cell => cell.fg === 'ac.brand'), `${tier} own-code bars use the brand color`);
  }
  // Mask numerical values: only layout and color-token positions are contractual for 2c.
  const value = grid.rows.map((row, index) => {
    const style = (c: typeof row[number]) => `${c.fg ?? '-'}/${c.bg ?? '-'}${c.bold ? '/b' : ''}`;
    const runs: string[] = []; let start = 0;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${snapshotText(grid)[index].replace(/[0-9]/g, '#')}|\n   ${runs.join(' ; ')}`;
  }).join('\n') + '\n';
  const path = join(process.cwd(), 'test/fixtures/snapshots/self-2c-132x38.txt');
  if (!existsSync(path)) writeFileSync(path, value);
  else assert.equal(value, readFileSync(path, 'utf8'));
  assert.doesNotMatch(text(lines), /hidden-version|hidden-root|写盘频率/);
  for (const [width, height] of [[80, 24], [40, 12]]) {
    let all = '';
    for (let i = 0; i < 100; i++) { const frame = view.render(width, height); assert.equal(frame.length, height); assert.ok(frame.every(line => visibleWidth(line) <= width)); assert.match(frame.map(stripTerminalSequences)[0], /指标.*本机实测/); assert.match(frame.map(stripTerminalSequences).at(-1)!, /Esc/); all += text(frame); view.scroll(4); }
    assert.match(all, /产品内不测/); assert.match(all, /模型成本/); assert.match(all, /尚无任务/);
  }
});

test('2c model cost keeps the amount fg.primary and unknown ac.warn in both layouts and when wrapped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-cost-'));
  const existing = new Evidence(root, 'empty'); existing.close();
  const view = new SelfView(root, host, { samples: new ProcessMeasurements(() => 12), now: () => now });
  await view.ready;
  const cost = view.snapshot.cost.value!;
  for (const [amounts, amount, amountColor] of [[{ CNY: 1.2 }, '≈ ¥1.20', 'fg.primary'], [{}, 'unknown', 'ac.warn']] as const) {
    cost.spend = { ...cost.spend, total: { totals: { amounts, unknownRequests: 3, partial: false }, tokens: 500 } };
    // 40 columns wrap the 合计 value onto continuation rows.
    for (const width of [132, 80, 40]) {
      const grid = captureSnapshot(view.render(width, 80, 'truecolor'), width, 80, 'truecolor');
      // Foreground tokens of the visible cells under `needle` in the 合计 row and its continuation rows.
      const colors = (needle: string) => {
        const first = grid.rows.findIndex(cells => cells.map(c => c.char).join('').startsWith('合计'));
        let end = first + 1;
        while (grid.rows[end]?.map(c => c.char).join('').startsWith(' '.repeat(21))) end++;
        const row = grid.rows.slice(first, end).flat();
        let shown = ''; const starts = row.map(c => { const at = shown.length; shown += c.char; return at; });
        const at = shown.indexOf(needle);
        assert.ok(at >= 0, `${needle} at ${width}`);
        return [...new Set(row.filter((c, i) => starts[i] >= at && starts[i] < at + needle.length && c.char.trim()).map(c => c.fg))];
      };
      assert.deepEqual(colors(amount), [amountColor], `amount at ${width}`);
      assert.deepEqual(colors('+3 unknown'), ['ac.warn'], `unknown at ${width}`);
      assert.deepEqual(colors('500 tok'), ['fg.faint'], `tokens at ${width}`);
    }
  }
});

class SelfTerminal implements Terminal {
  columns = 132; rows = 38; kittyProtocolActive = false; writes: string[] = [];
  input: (data: string) => void = () => {}; resize = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(data: string) { this.writes.push(data); }
  moveBy() {} hideCursor() { this.write('\x1b[?25l'); } showCursor() { this.write('\x1b[?25h'); } clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(done => setTimeout(done, 10)); } throw Error('self view did not settle'); };

test('the app opens --self on a fresh data root, measures actual frames and exports without a provider or record write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-self-app-')), dataRoot = join(root, 'data'); mkdirSync(dataRoot);
  const terminal = new SelfTerminal(); let copied = '', requests = 0;
  const app = new ReadOnlyTui({ workspace: root, dataRoot, draftRoot: join(root, 'drafts'), terminal, mode: 'offline', widthCalibration: false,
    transport: async () => { requests++; throw Error('unexpected provider request'); }, copy: async value => { copied = value; return true; } });
  const screen = () => text(app.screen()), key = (data: string) => terminal.input(data);
  const before = contents(dataRoot);
  try {
    app.start(); screen();
    assert.ok(processMeasurements.snapshot().firstFrameMs !== null);
    key('/stats --self'); key('\r');
    await until(() => screen().includes('尚无任务'));
    assert.match(screen(), /◆ self/); assert.doesNotMatch(screen(), new RegExp(dataRoot));
    key('e'); key('\r'); await until(() => !!copied);
    const first = JSON.parse(copied); assert.equal(first.environment.columns, 132); assert.equal(first.environment.rows, 38); assert.equal(first.environment.dataRoot, dataRoot);
    assert.ok(first.keys.samples > 0); assert.ok(terminal.writes.some(value => value.includes('\x1b[?2026l')));
    key('b'); await until(() => screen().includes('尚无任务'));
    copied = ''; key('e'); key('\r'); await until(() => !!copied);
    assert.ok(JSON.parse(copied).keys.samples > first.keys.samples, 'remeasurement keeps and advances the current process samples');
    key('\t'); assert.match(screen(), /统计不可读取/);
    key('\x1b[Z'); await until(() => screen().includes('尚无任务'));
    key('\x1b'); key('/stats --self --source diagnostic'); key('\r');
    assert.match(screen(), /--self 固定近 7 天/);
    assert.equal(requests, 0); assert.deepEqual(contents(dataRoot), before);
  } finally { await app.exit(); }
});
