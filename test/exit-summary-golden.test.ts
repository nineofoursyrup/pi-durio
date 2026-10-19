import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { exitSummary } from '../src/tui/exit-summary.js';
import { captureSnapshot, snapshotText } from '../src/tui/snapshot.js';

test('1f exit summary golden occupies terminal columns at 132x38', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-exit-golden-')), workspace = join(root, 'project');
  const runId = '11111111-2222-4333-8444-555555555555', sessionId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const evidence = new Evidence(root, runId);
  evidence.append('task.accepted', { taskId: 'exit-task', sessionId, input: '完成中文与 emoji 😀 显示修正', workspace, authorization: { tools: ['read'] } });
  evidence.append('run.started', {});
  evidence.append('context.snapshot', { messages: evidence.blob('[]') });
  evidence.append('run.closed', { status: 'completed', cleanup: 'confirmed' });
  evidence.close();
  const lines = await exitSummary(root, { workspace, runId, elapsedMs: 848_000, draftLines: 3, terminalRestored: true }, 132);
  assert.ok(lines.length <= 8);
  assert.ok(lines.every(line => visibleWidth(line) <= 132));
  assert.match(lines.join('\n'), /完成中文与 emoji 😀 显示修正/);
  const grid = captureSnapshot(lines, 132, 38, 'truecolor'), text = snapshotText(grid);
  const value = `132x38 truecolor\n${grid.rows.map((row, index) => {
    const style = (cell: typeof row[number]) => `${cell.fg ?? '-'}/${cell.bg ?? '-'}${cell.bold ? '/b' : ''}`;
    const runs: string[] = []; let start = 0;
    for (let i = 1; i <= row.length; i++) if (i === row.length || style(row[i]) !== style(row[start])) { runs.push(`${start}-${i - 1} ${style(row[start])}`); start = i; }
    return `${String(index).padStart(2, '0')}|${text[index]}|\n   ${runs.join(' ; ')}`;
  }).join('\n')}\n`;
  const path = join(process.cwd(), 'test/fixtures/snapshots/1f-132x38.txt');
  if (!existsSync(path)) writeFileSync(path, value);
  else assert.equal(value, readFileSync(path, 'utf8'));
});
