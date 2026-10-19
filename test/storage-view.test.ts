import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { storageGroups } from '../src/storage-groups.js';
import { StorageView, DELETE_NOTE } from '../src/tui/storage.js';
import type { ConfirmConfig } from '../src/tui/view-stack.js';
import { readDisplayIndex } from '../src/display-number.js';
import { records, decode, readEvidence, summarizeRun } from '../src/history.js';
import { blobReferences } from '../src/retention.js';
import { acquireOwner } from '../src/ownership.js';

import { dataRoot as v1DataRoot, names as v1Names } from './v1-runtime-fixture.js';
const fixtureDir = resolve('test/fixtures/v1-records');
const names = JSON.parse(readFileSync(join(fixtureDir, 'fixture-identity.json'), 'utf8')).names;
/** Cleanup writes management facts and deletes files, so every test works on its own copy of the #66 data root. */
function copy() { const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'durio-storage-view-'))), 'data'); cpSync(join(fixtureDir, 'data'), root, { recursive: true }); return root; }
function host(busy = false) {
  const state = { confirms: [] as { config: ConfirmConfig; confirm: () => Promise<void> }[], feedback: [] as string[], blocked: undefined as string | undefined };
  return { state, host: { writeBlocked: () => state.blocked, changed() {}, busy: () => busy, feedback: (text: string) => { state.feedback.push(text); }, confirm: (config: ConfirmConfig, confirm: () => Promise<void>) => { state.confirms.push({ config, confirm }); } } };
}
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trimEnd());
/** Moves the cursor to the row of group `key` (rows follow `storageGroups` order) and toggles it. */
async function choose(view: StorageView, root: string, key: string) {
  const at = (await storageGroups(root)).groups.findIndex(group => group.key === key);
  assert.ok(at >= 0, `no row ${key}`);
  for (let i = 0; i < 50; i++) view.handleInput('\x1b[A');
  for (let i = 0; i < at; i++) view.handleInput('\x1b[B');
  view.handleInput(' ');
}

test('#66 fixture: storage groups by session; a branch session is its own row and the original keeps both its stores', async () => {
  const root = v1DataRoot, names = v1Names, { groups, totals } = await storageGroups(root), index = readDisplayIndex(root);
  const original = groups.find(group => group.key === `session:${names['session.coding']}`)!, branch = groups.find(group => group.key === `session:${names['session.fork-2']}`)!;
  assert.deepEqual(original.units.filter(unit => unit.kind === 'session').map(unit => [unit.id, unit.task]).sort(), [[`session:${names['session.coding']}`, 1], [`session:${names['session.fork-1']}`, 2]]);
  assert.deepEqual(branch.units.filter(unit => unit.kind === 'session').map(unit => unit.id), [`session:${names['session.fork-2']}`]);
  assert.equal(groups.some(group => group.key === `session:${names['session.fork-1']}`), false, 'a non-head durable store is not a session row');
  // Attachments shared by several sessions (installation inventory) are not any one session's: one “未归属附件” row.
  const unowned = groups.at(-1)!;
  assert.equal(unowned.kind, 'unowned');
  assert.ok(unowned.units.length > 100);
  assert.equal(groups.reduce((n, group) => n + group.sessionBytes + group.attachmentBytes, 0), totals.sessions + totals.attachments);
  const view = new StorageView(root, host().host);await view.ready;
  const wide = plain(view.render(140, 40));
  assert.match(wide[0], /^◆ storage {2}.+ · 总量 [\d.]+ MB +不自动过期 · 压缩不删除原文$/);
  assert.match(wide[1], /^宿主记录 .+ · 会话存储 .+ · 附件 .+ · 未完成清理 0 B$/);
  const row = wide.find(line => line.includes(index.label('session', names['session.coding'])))!;
  assert.match(row, /^\[ \] s-[0-9a-f]+ · Read README\.md.* · 2 个任务 · 会话存储 \d+ KB \+ 附件 \d+ KB · \d\d-\d\d \d\d:\d\d$/);
  assert.ok(wide.some(line => /^\[ \] 未归属附件 · \d+ 个单元 · 附件 [\d.]+ MB$/.test(line)));
  assert.match(wide.at(-1)!, /↑↓ 选择 · 空格 多选 · Enter 预览 · n\/p 翻页 · Esc 返回会话/);
  // U12/U13: <100 drops last activity and the header note; <60 sums the two sizes.
  const medium = plain(view.render(80, 40));
  assert.doesNotMatch(medium.join('\n'), /不自动过期|\d\d-\d\d \d\d:\d\d/);
  assert.ok(medium.some(line => / · 会话存储 \d+ KB \+ 附件 \d+ KB$/.test(line)));
  const narrow = plain(view.render(50, 40)).filter(line => line.startsWith('['));
  assert.ok(narrow.length && narrow.every(line => !line.includes('会话存储') && !line.includes('+ 附件')));

});

test('storage CLI resolves session display numbers for deterministic preview inputs', () => {
  const root = copy(), index = readDisplayIndex(root);
  // CLI: `session:<s- number>` selects every durable store of that session, the branch's own only for the branch.
  let n = 0;
  const cli = (units: string) => JSON.parse(spawnSync(process.execPath, ['dist/src/cli.js', 'storage', 'preview', '--data-root', root, '--id', `cli-${++n}`, '--units', units, '--reason', 'fixture'], { cwd: resolve('.'), encoding: 'utf8' }).stdout).plan.request.units;
  assert.deepEqual(cli(`session:${index.label('session', names['session.coding'])}`).sort(), [`session:${names['session.coding']}`, `session:${names['session.fork-1']}`].sort());
  assert.deepEqual(cli(`session:${index.label('session', names['session.fork-2'])}`), [`session:${names['session.fork-2']}`]);
  assert.deepEqual(cli(`session:${names['session.fork-1']}`), [`session:${names['session.fork-1']}`], 'a full durable id stays one store');
});

test('storage write access blocks preview records and rechecks a retained cleanup confirmation', async () => {
  const root = copy(), { state, host: h } = host(), view = new StorageView(root, h);
  await view.ready;
  await choose(view, root, 'unowned');
  state.blocked = '只读查看 · 不能清理';
  const before = readFileSync(join(root, 'host.sqlite'));
  await view.handleInput('\r');
  assert.equal(state.confirms.length, 0);
  assert.equal(state.feedback.at(-1), state.blocked);
  assert.deepEqual(readFileSync(join(root, 'host.sqlite')), before);
  state.blocked = undefined;
  await view.handleInput('\r');
  assert.equal(state.confirms.length, 1);
  const previewed = readFileSync(join(root, 'host.sqlite'));
  state.blocked = '只读查看 · 不能清理';
  await state.confirms[0].confirm();
  assert.equal(state.feedback.at(-1), state.blocked);
  assert.deepEqual(readFileSync(join(root, 'host.sqlite')), previewed, 'confirm cannot start a cleanup after write access is withdrawn');
});

test('#66 fixture: a multi-select preview lists every unit with protected dependencies and their reasons', async () => {
  const root = copy(), { state, host: h } = host(), view = new StorageView(root, h), index = readDisplayIndex(root);await view.ready;
  await choose(view, root, `session:${names['session.frozen-source']}`);
  await choose(view, root, `session:${names['session.uncertain']}`);
  await choose(view, root, 'unowned');
  assert.equal(plain(view.render(140, 60)).filter(line => line.startsWith('[✓]')).length, 3);
  await view.handleInput('\r');
  assert.equal(state.confirms.length, 1);
  const { config } = state.confirms[0], body = config.body!.join('\n');
  assert.equal(config.title, '清理预览 · 3 个会话');
  // Frozen request, recovery and fixed evidence each protect, with the reason written on the unit.
  assert.match(body, new RegExp(`◈ 受保护 · 会话存储 · 任务 1 · \\d+ KB · 已冻结的排队请求 q-[0-9a-f]+、q-[0-9a-f]+、q-[0-9a-f]+`));
  assert.match(body, /◈ 受保护 · 会话存储 · 任务 1 · \d+ KB · 待恢复核对/);
  assert.match(body, /◈ 受保护 · 附件 [0-9a-f]{8} · .* · .*固定证据/);
  assert.match(body, /✓ 可删除 · 附件 [0-9a-f]{8}/);
  // Every chosen unit is listed once, across the 100-unit preview operations.
  const units = (await storageGroups(root)).groups.filter(group => [`session:${names['session.frozen-source']}`, `session:${names['session.uncertain']}`, 'unowned'].includes(group.key)).flatMap(group => group.units);
  assert.equal(config.body!.filter(line => /^ {2}[✓◈] /.test(line)).length, units.length);
  assert.ok(units.length > 100);
  assert.match(config.fixed![0], /^删除 \d+ 个单元 · .+ · 失效引用 \d+ 处 · 受保护 \d+ 个不删除$/);
  assert.equal(config.fixed![1], DELETE_NOTE);
  assert.equal([...records(root, { kinds: ['management.preview'] })].length, Math.ceil(units.length / 100));
});

test('preview with the writer lock held or a task running only hints; no preview box', async () => {
  const root = copy();
  const busy = host(true), view = new StorageView(root, busy.host);await view.ready;
  await view.handleInput('\r');
  assert.deepEqual([busy.state.confirms.length, busy.state.feedback], [0, ['有任务运行中，结束后再清理']]);
  const owner = await acquireOwner(root, () => {});
  try {
    const idle = host(), other = new StorageView(root, idle.host);await other.ready;
    await other.handleInput('\r');
    assert.equal(idle.state.confirms.length, 0);
    assert.match(idle.state.feedback[0], /^写入者锁被占用 · 有任务运行中，结束后再清理 · OWNER_/);
  } finally { await owner.release(); }
  assert.equal([...records(root, { kinds: ['management.preview'] })].length, 0);
});

test('#66 fixture: cleanup shows each unit result in place; host records stay and the originals read as cleaned', async () => {
  const root = copy(), { state, host: h } = host(), view = new StorageView(root, h), index = readDisplayIndex(root);await view.ready;
  const session = names['session.read'], run = names['run.read'], before = [...records(root)].length;
  const group = (await storageGroups(root)).groups.find(item => item.key === `session:${session}`)!;
  const attachment = group.units.find(unit => unit.kind === 'object')!.id.slice('object:'.length);
  const source = [...records(root, { runId: run })].find(ref => blobReferences(decode(root, ref)).some(blob => blob.sha256 === attachment))!;
  await choose(view, root, `session:${session}`);
  await view.handleInput('\r');
  assert.equal(state.confirms[0].config.disabled, undefined);
  await state.confirms[0].confirm();
  assert.equal(existsSync(join(root, 'sessions', session)), false);
  assert.equal(existsSync(join(root, 'objects', attachment)), false);
  const lines = plain(view.render(140, 60)), at = lines.findIndex(line => line.includes(index.label('session', session)));
  assert.match(lines[at + 1], /^ {4}✓ (会话存储 · 任务 1|附件 [0-9a-f]{8}) · 已删除 /);
  assert.equal(lines.slice(at + 1, at + 1 + group.units.length).filter(line => line.includes('已删除')).length, group.units.length);
  // Host records are retained (only management/availability facts are added); originals report 已清理 state.
  assert.ok([...records(root)].length > before);
  assert.equal([...records(root, { runId: run, kinds: ['task.accepted'] })].length, 1);
  assert.equal(readEvidence(root, source.id).state, 'cleaned');
  assert.equal(summarizeRun(root, run).completeness, 'cleaned');
});

test('Esc while counting discards the result', async () => {
  const root = copy(), view = new StorageView(root, host().host);
  assert.equal(view.inProgress, true);
  view.cancel();await view.ready;
  assert.equal(view.inProgress, false);
  assert.doesNotMatch(plain(view.render(140, 20)).join('\n'), /总量|\[ \]/);
});
