import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Evidence } from '../src/evidence.js';
import { COMMANDS, CommandError, commandCompletion, commandNames, helpBody, parseCommand, parseDate, resolveArgument, walkFileSuggestions } from '../src/tui/commands.js';

const signal = new AbortController().signal;
async function suggest(text: string, workspace = tmpdir()) {
  const provider = commandCompletion(workspace, COMMANDS, null);
  return provider.getSuggestions([text], 0, text.length, { signal });
}
function rejects(text: string, pattern: RegExp, available?: string[]) {
  assert.throws(() => parseCommand(text, COMMANDS, new Date(2026, 9, 15)), (error: unknown) => {
    assert.ok(error instanceof CommandError, String(error));
    assert.match(error.line, pattern);
    if (available) for (const value of available) assert.ok(error.available.includes(value), `${value} in ${error.available.join(' ')}`);
    return true;
  });
}

test('slash completion and the help view list the same commands from one table', async () => {
  const all = (await suggest('/'))!.items.map(item => item.value);
  assert.deepEqual(all, COMMANDS.map(spec => `/${spec.name}`));
  const help = helpBody(400).join('\n');
  for (const name of commandNames()) assert.ok(help.includes(`  ${name}`), `${name} in help`);
  // Subcommands come from the same table entries the help view lists.
  const subs = (await suggest('/improve '))!.items.map(item => item.value);
  assert.deepEqual(subs.map(sub => `/improve ${sub}`), commandNames().filter(name => name.startsWith('/improve ')));
  assert.ok(help.includes('会话屏键位') && help.indexOf('会话屏键位') < help.indexOf('命令'));
});

test('completion fills subcommands, option names and option values; /metrics is gone', async () => {
  assert.deepEqual((await suggest('/improve h'))!.items.map(i => i.value), ['history']);
  assert.deepEqual((await suggest('/history --st'))!.items.map(i => i.value), ['--status']);
  assert.deepEqual((await suggest('/history --status '))!.items.map(i => i.value), ['completed', 'failed', 'aborted', 'recovery']);
  assert.deepEqual((await suggest('/history --status a'))!.items.map(i => i.value), ['aborted']);
  assert.deepEqual((await suggest('/stats --source s'))!.items.map(i => i.value), ['synthetic']);
  assert.deepEqual((await suggest('/history --project '))!.items.map(i => i.value), ['all']);
  // Options already given are not offered again.
  assert.ok(!(await suggest('/history --from 10-01 --'))!.items.some(i => i.value === '--from'));
  assert.equal(await suggest('/me'), null);
  assert.ok(!(await suggest('/'))!.items.some(i => i.value === '/metrics'));
  rejects('/metrics', /未知命令 \/metrics/);
  // Applying an argument completion replaces only the current word.
  const provider = commandCompletion(tmpdir(), COMMANDS, null);
  const applied = provider.applyCompletion(['/history --status a'], 0, 19, { value: 'aborted', label: 'aborted' }, 'a');
  assert.deepEqual(applied, { lines: ['/history --status aborted '], cursorLine: 0, cursorCol: 26 });
});

test('@ completion inserts only the path, from a bounded walk when fd is absent', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'durio-at-'));
  mkdirSync(join(workspace, 'src')); mkdirSync(join(workspace, '.git'));
  writeFileSync(join(workspace, 'src', 'main.ts'), 'secret content');
  writeFileSync(join(workspace, 'my notes.md'), 'x'); writeFileSync(join(workspace, '.git', 'main.ts'), 'x');
  const result = (await suggest('look at @mai', workspace))!;
  assert.equal(result.prefix, '@mai');
  assert.deepEqual(result.items.map(i => i.value), ['@src/main.ts']);
  const provider = commandCompletion(workspace, COMMANDS, null);
  const applied = provider.applyCompletion(['look at @mai'], 0, 12, result.items[0], '@mai');
  assert.deepEqual(applied.lines, ['look at @src/main.ts ']);
  assert.ok(!applied.lines[0].includes('secret'));
  assert.deepEqual(walkFileSuggestions(workspace, 'notes').map(i => i.value), ['@"my notes.md"']);
  // Directories keep the list open (no trailing space).
  const dir = walkFileSuggestions(workspace, 'src').find(i => i.value === '@src/')!;
  assert.deepEqual(provider.applyCompletion(['@sr'], 0, 3, dir, '@sr').lines, ['@src/']);
});

test('arguments: display numbers, --name value options, MM-DD dates as [from,to)', () => {
  const now = new Date(2026, 9, 15);
  const parsed = parseCommand('/history s-1a2b --from 10-01 --to 2026-10-08 --status recovery', COMMANDS, now);
  assert.deepEqual(parsed.positional, ['s-1a2b']);
  assert.equal(parsed.options.from, new Date(2026, 9, 1).toISOString());
  assert.equal(parsed.options.to, new Date(2026, 9, 8).toISOString());
  assert.equal(parsed.options.status, 'recovery');
  assert.equal(parseDate('02-30', now), undefined);
  assert.equal(parseDate('2025-02-28', now), new Date(2025, 1, 28).toISOString());
  const sub = parseCommand('/improve history ir-12ab', COMMANDS, now);
  assert.deepEqual([sub.leaf.name, sub.path, sub.positional], ['history', ['history'], ['ir-12ab']]);
  // /improve new only prefills the launch box; --source repeats.
  const launch = parseCommand('/improve new --scope 30d --budget large --source self --source eval --focus "x y"', COMMANDS, now);
  assert.deepEqual([launch.path, launch.options], [['new'], { scope: '30d', budget: 'large', source: 'self,eval', focus: 'x y' }]);
  rejects('/improve new --scope 1d', /不接受 1d/, ['session', '7d', '30d']);
  rejects('/improve {"purpose":"x"}', /\/improve 不接受参数/, ['new', 'history', 'suppressions']);
  assert.equal(parseCommand('/acceptance --note "两 个 字"').raw, '--note "两 个 字"');
  rejects('/history --foo 1', /未知选项 --foo/, ['--from', '--to', '--project', '--status']);
  rejects('/history --from 2026/10/01', /日期写 MM-DD 或 YYYY-MM-DD/);
  rejects('/history --status done', /不接受 done/, ['completed', 'failed', 'aborted', 'recovery']);
  rejects('/history --status', /缺少状态/, ['completed']);
  rejects('/history --from 10-08 --to 10-01', /\[from,to\)/);
  rejects('/history q-1234', /s-号\|r-号/);
  rejects('/withdraw', /需要 q-号/);
  rejects('/bottom now', /不接受参数/);
  rejects('/histroy', /未知命令/, ['/history']);
});

test('ambiguous display numbers are rejected with candidates; full ids pass through', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-cmd-display-'));
  const A = 'abcde000-0000-4000-8000-000000000001', B = 'abcde111-0000-4000-8000-000000000002', S = '5e550000-0000-4000-8000-00000000000a';
  for (const runId of [A, B]) { const e = new Evidence(root, runId); try { e.append('task.accepted', { taskId: `task-${runId}`, runId, sessionId: S, input: 'fixture', workspace: '/p', mode: 'offline' }); } finally { e.close(); } }
  assert.throws(() => resolveArgument(root, 'r-abcd', ['session', 'run']), (error: unknown) => {
    assert.ok(error instanceof CommandError);
    assert.match(error.line, /r-abcd 有 2 个候选 · 可用 r-abcde0（\/p · .*） r-abcde1/);
    return true;
  });
  assert.deepEqual(resolveArgument(root, 'r-abcde1', ['session', 'run']), { kind: 'run', id: B });
  assert.deepEqual(resolveArgument(root, A, ['session', 'run']), { kind: 'run', id: A });
  assert.throws(() => resolveArgument(root, 'r-9999', ['run']), /没有找到 r-9999/);
});

test('help body never exceeds the view width, wide or narrow', () => {
  for (const width of [132, 80, 59, 38, 20]) for (const line of helpBody(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
});
