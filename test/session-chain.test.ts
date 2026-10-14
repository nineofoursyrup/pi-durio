import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readSessionChains } from '../src/session-chain.js';
import { readDisplayIndex, resolveDisplayInput, DisplayIndex, DisplayInputError } from '../src/display-number.js';
import { queryHistory } from '../src/history.js';
import { taskTypeOf } from '../src/task-type.js';
import { formatImproveReport, readImproveReport } from '../src/improve.js';
import { Evidence, readQueue } from '../src/evidence.js';

const fixtureDir = fileURLToPath(new URL('../../test/fixtures/v1-records', import.meta.url));
const dataRoot = join(fixtureDir, 'data');
const names = (JSON.parse(readFileSync(join(fixtureDir, 'fixture-identity.json'), 'utf8')) as { names: Record<string, string> }).names;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every file under the data root with its size, mtime and content hash. */
function treeState(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name), s = statSync(path); if (s.isDirectory()) walk(path); else out.push(`${path} ${s.size} ${s.mtimeMs} ${sha(readFileSync(path).toString('base64'))}`); } };
  walk(root);
  return out;
}

test('v1 fixture: a run continued twice yields the original session and one branch session', () => {
  const chains = readSessionChains(dataRoot), index = readDisplayIndex(dataRoot);
  const original = chains.session(names['session.coding'])!, branch = chains.session(names['session.fork-2'])!;
  // Original keeps the earliest-accepted continuation; its tail is fork-1 at task 2.
  assert.equal(original.headRunId, names['run.coding']);
  assert.equal(original.tailRunId, names['run.fork-1']);
  assert.equal(original.tail.number, 2);
  assert.equal(original.tasks, 2);
  assert.equal(original.forkedFrom, null);
  assert.deepEqual(chains.tasks(original.id).items.map(t => [t.runId, t.number]), [[names['run.coding'], 1], [names['run.fork-1'], 2]]);
  // The branch is named by its own first task's sessionId and continues the depth from the fork point.
  assert.equal(branch.id, names['session.fork-2']);
  assert.equal(branch.headRunId, names['run.fork-2']);
  assert.equal(branch.tailRunId, names['run.fork-2']);
  assert.equal(branch.tail.number, 2);
  assert.equal(branch.tasks, 1);
  assert.deepEqual(branch.forkedFrom, { sessionId: names['session.coding'], runId: names['run.coding'], number: 1 });
  assert.deepEqual(chains.contextRunIds(names['run.fork-2']), [names['run.coding'], names['run.fork-2']]);
  // Each run belongs to exactly one session; fork-1's durable sessionId is not a session.
  assert.deepEqual(chains.sessionOfRun(names['run.fork-1']), { id: names['session.coding'], headRunId: names['run.coding'], number: 2 });
  assert.equal(chains.session(names['session.fork-1']), null);
  assert.equal(index.has('session', names['session.fork-1']), false);
  assert.match(index.label('session', branch.id), /^s-fb21/);
  assert.equal(resolveDisplayInput(dataRoot, 'session', index.label('session', branch.id)), branch.id);
  // Paging is bounded and stable.
  const first = chains.tasks(original.id, { limit: 1 });
  assert.deepEqual([first.items.map(t => t.number), first.next], [[1], 1]);
  assert.deepEqual(chains.tasks(original.id, { after: first.next! }).items.map(t => t.number), [2]);
});

test('v1 fixture: a run aborted before context.imported is its own session; the original tail is unchanged', () => {
  const chains = readSessionChains(dataRoot), aborted = chains.sessionOfRun(names['run.early-abort'])!;
  assert.equal(aborted.headRunId, names['run.early-abort']);
  assert.equal(aborted.number, 1);
  const session = chains.session(aborted.id)!;
  assert.equal(session.tasks, 1);
  assert.equal(session.forkedFrom, null);
  assert.equal(session.tail.status, 'ended');
  assert.equal(chains.session(names['session.coding'])!.tailRunId, names['run.fork-1']);
  assert.equal(chains.session(names['session.coding'])!.tail.status, 'completed');
});

test('v1 fixture: sessions list newest activity first per workspace, bounded by limit and cursor', () => {
  const chains = readSessionChains(dataRoot), all = chains.list({ limit: 50 });
  assert.equal(all.next, null);
  assert.equal(new Set(all.items.map(s => s.id)).size, all.items.length);
  for (let i = 1; i < all.items.length; i++) assert.ok(all.items[i - 1].lastSeq > all.items[i].lastSeq);
  // Improve analysis is its own session.
  assert.equal(chains.session(chains.sessionOfRun(names['run.improve'])!.id)!.kind, 'improve');
  const workspace = chains.session(names['session.coding'])!.workspace!;
  const page = chains.list({ workspace, limit: 3 });
  assert.equal(page.items.length, 3);
  assert.ok(page.items.every(s => s.workspace === workspace));
  const rest = chains.list({ workspace, limit: 50, before: page.next!.before });
  assert.deepEqual([...page.items, ...rest.items].map(s => s.id), all.items.filter(s => s.workspace === workspace).map(s => s.id));
  assert.equal(chains.list({ workspace: '/nowhere' }).items.length, 0);
});

test('v1 fixture: user-chosen report, plan and queue request IDs get stable SHA-256 display numbers and still resolve', () => {
  const index = readDisplayIndex(dataRoot);
  const cases: [Parameters<DisplayIndex['label']>[0], string, string][] = [
    ['improve-report', names['improve.report'], 'ir-'], ['eval-plan', names['eval.plan'], 'ep-'],
    ['queue-request', 'frozen-follow', 'q-'], ['queue-request', 'frozen-compact', 'q-'], ['queue-request', 'frozen-improve', 'q-'],
  ];
  for (const [kind, id, prefix] of cases) {
    const label = index.label(kind, id);
    assert.equal(label, `${prefix}${sha(id).slice(0, label.length - prefix.length)}`);
    assert.ok(label.length - prefix.length >= 4);
    assert.equal(readDisplayIndex(dataRoot).label(kind, id), label, 'stable across reads');
    assert.equal(resolveDisplayInput(dataRoot, kind, label), id);
    assert.equal(resolveDisplayInput(dataRoot, kind, id), id, 'original id remains an input');
  }
  const text = formatImproveReport(readImproveReport(dataRoot, names['improve.report']), dataRoot);
  assert.match(text, new RegExp(`原 id ${names['improve.report']}`));
  assert.match(text, /Target \S+ \/ session s-[0-9a-f]{4,} \/ run r-[0-9a-f]{4,}\n/);
});

test('q- numbers: ambiguity is rejected with candidates; CLI queue decisions accept q- before any write', () => {
  const index = new DisplayIndex([
    { kind: 'queue-request', id: 'abcd0000-0000-4000-8000-000000000001', project: '/p', at: '2026-01-01T00:00:00Z' },
    { kind: 'queue-request', id: 'abcd1111-0000-4000-8000-000000000002', project: '/p', at: '2026-01-02T00:00:00Z' },
  ]);
  const ambiguous = index.resolve('queue-request', 'q-abcd');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual((ambiguous as { candidates: { display: string }[] }).candidates.map(c => c.display), ['q-abcd0', 'q-abcd1']);
  assert.match(new DisplayInputError(ambiguous as Exclude<typeof ambiguous, { status: 'found' }>).message, /DISPLAY_AMBIGUOUS: q-abcd matches 2 queue-requests/);

  const root = mkdtempSync(join(tmpdir(), 'durio-chain-q-')), copy = join(root, 'data');
  cpSync(dataRoot, copy, { recursive: true });
  const item = readQueue(copy).items.find(i => i.requestId === 'frozen-follow')!;
  const decision = join(root, 'decision.json');
  writeFileSync(decision, JSON.stringify({ id: 'withdraw-by-q', requestId: readDisplayIndex(copy).label('queue-request', 'frozen-follow'), action: 'withdraw', target: item.target, receiptSeq: item.receipt.seq }));
  const child = spawnSync(process.execPath, ['dist/src/cli.js', 'queue', '--data-root', copy, '--run', item.target.runId, '--decision', decision], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readQueue(copy).items.find(i => i.requestId === 'frozen-follow')!.status, 'withdrawn');
  // An ambiguous q- input exits non-zero with candidates and writes nothing: two user-chosen IDs whose SHA-256 share 4 hex digits.
  const seen = new Map<string, string>();let pair: [string, string] | undefined;
  for (let n = 0; !pair; n++) { const id = `amb-${n}`, key = sha(id).slice(0, 4); if (seen.has(key)) pair = [seen.get(key)!, id]; else seen.set(key, id); }
  const e = new Evidence(copy, item.target.runId);
  try { for (const id of pair) e.append('control.accepted', { ...item, requestId: id }); } finally { e.close(); }
  writeFileSync(decision, JSON.stringify({ id: 'never', requestId: `q-${sha(pair[0]).slice(0, 4)}`, action: 'withdraw', target: item.target, receiptSeq: item.receipt.seq }));
  const records = treeState(copy).find(line => line.includes('host.sqlite '));
  const rejected = spawnSync(process.execPath, ['dist/src/cli.js', 'queue', '--data-root', copy, '--run', item.target.runId, '--decision', decision], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  const error = JSON.parse(rejected.stderr).error;
  assert.equal(error.code, 'DISPLAY_AMBIGUOUS');
  assert.deepEqual(error.candidates.map((c: { id: string }) => c.id).sort(), [...pair].sort());
  assert.equal(treeState(copy).find(line => line.includes('host.sqlite ')), records);
});

test('task type derives from authorization.execution; an eval trial origin.taskType wins; history filters by it', () => {
  assert.equal(taskTypeOf({ authorization: { execution: 'trusted-local-coding' } }), 'coding');
  assert.equal(taskTypeOf({ authorization: { execution: 'trusted-local-read-only' } }), 'read');
  assert.equal(taskTypeOf({ authorization: { execution: 'scoped-improve-analysis' } }), null);
  assert.equal(taskTypeOf({ origin: { taskType: 'read' }, authorization: { execution: 'trusted-local-coding' } }), 'read');
  assert.equal(taskTypeOf(undefined), null);
  const all = (filter: Record<string, string>) => { const ids: (string | null)[] = [];let cursor;do { const page = queryHistory(dataRoot, filter, { limit: 50, cursor }); ids.push(...page.items.map(i => i.runId)); cursor = page.next ?? undefined; } while (cursor); return ids; };
  const coding = all({ taskType: 'coding' }), read = all({ taskType: 'read' });
  for (const id of [names['run.coding'], names['run.fork-1'], names['run.fork-2']]) assert.ok(coding.includes(id), id);
  for (const id of [names['run.read'], names['run.readonly-followup']]) assert.ok(read.includes(id), id);
  assert.ok(!coding.includes(names['run.improve']) && !read.includes(names['run.improve']));
  assert.equal(queryHistory(dataRoot, {}, { limit: 50 }).items.find(i => i.runId === names['run.improve'])!.taskType, null);
  // The session filter is the derived session: the original session holds tasks 1 and 2, not the branch.
  const rows = queryHistory(dataRoot, { session: names['session.coding'] }, { limit: 50 }).items;
  assert.deepEqual(rows.map(r => [r.runId, r.chain?.task]), [[names['run.coding'], 1], [names['run.fork-1'], 2]]);
});

test('derivation is readonly: no record, file or lock changes in the data root', () => {
  const before = treeState(dataRoot);
  const chains = readSessionChains(dataRoot);
  for (const s of chains.list({ limit: 50 }).items) { chains.tasks(s.id); chains.contextRunIds(s.tailRunId); }
  readDisplayIndex(dataRoot);queryHistory(dataRoot, { taskType: 'coding' });
  assert.deepEqual(treeState(dataRoot), before);
});
