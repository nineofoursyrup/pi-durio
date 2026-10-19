import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readonlyDenialDir as fixture } from './v1-runtime-fixture.js';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { records, decode, type EvidenceReference } from '../src/history.js';
import { readTrace } from '../src/trace.js';
import { TraceView } from '../src/tui/trace.js';
import { COLOR_TIER, overrideColorTierForTest } from '../src/tui/theme.js';

const dataRoot = join(fixture, 'data');
interface FileIdentity { path: string; bytes: number; sha256: string }
const identity = JSON.parse(readFileSync(join(fixture, 'fixture-identity.json'), 'utf8')) as {
  generatedBy: string; tree: string;
  names: { run: string; session: string; decision: string; snapshot: string };
  scenario: { target: string; before: string; attempted: string; after: string; targetSha256: string };
  originalRecords: EvidenceReference[];
  files: FileIdentity[];
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function inventory(directory: string, prefix = ''): FileIdentity[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
    const path = join(directory, item.name), label = prefix + item.name;
    if (item.isDirectory()) return inventory(path, `${label}/`);
    const bytes = readFileSync(path);
    return [{ path: label, bytes: bytes.length, sha256: hash(bytes) }];
  });
}
const beforeReading = inventory(fixture);
// The shared archive loader checks every unpacked byte after all read-only tests.

test('frozen v1 runtime denied a different write during readonly recovery and retained the original bytes and facts', () => {
  assert.equal(identity.generatedBy, 'f26ae8f4b8039608a1fa796e1c69da4d8173d112');
  assert.equal(identity.tree, 'ceebaeb3805dd8f2eeab948792f88e6f9a0ba2e0');
  const byPath = (a: FileIdentity, b: FileIdentity) => a.path.localeCompare(b.path);
  assert.deepEqual(beforeReading.filter(file => file.path !== 'fixture-identity.json').sort(byPath), [...identity.files].sort(byPath), 'Frozen fixture file inventory');
  const refs = [...records(dataRoot, { runId: identity.names.run })];
  assert.deepEqual(refs.slice(0, identity.originalRecords.length), identity.originalRecords, 'The prefix captured before recovery is still readable verbatim');
  const facts = refs.map(ref => ({ ...ref, data: decode(dataRoot, ref) }));
  const artifact = facts.find(fact => fact.kind === 'execution.artifact')!.data;
  // Hashes come from the independently frozen installation manifest, not the reader.
  const frozenFiles = {
    'dist/src/runtime.js': '36e1439f09a08043627a47c656cc92e201a9b228d2bcca698eda530426220378',
    'dist/src/recovery.js': 'eea33333e604ef2df1b3eec4758aabad978cb229c7c1b8332ae60c7e7de18124',
    'dist/execution/source-build.json': '8f4ce2a273559d871b76c1cf14971a0df048d7f86b8216ff45b3d8dd2a710821',
  };
  for (const [path, sha256] of Object.entries(frozenFiles)) {
    assert.equal(artifact.files.find((file: FileIdentity) => file.path === path)?.sha256, sha256, `${path} is the frozen v1 producer`);
  }
  const accepted = facts.find(fact => fact.kind === 'task.accepted')!.data;
  assert.deepEqual(accepted.authorization.tools, ['read', 'write', 'edit', 'bash'], 'The original task was authorized to write');
  const start = facts.find(fact => fact.kind === 'recovery.started')!;
  assert.deepEqual(start.data.capabilities, ['read']);
  assert.ok(facts.some(fact => fact.kind === 'recovery.report' && fact.data.tools.some((tool: { fact: string }) => tool.fact === 'completed-uncommitted')));
  const denied = facts.filter(fact => fact.kind === 'recovery.capability-denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].data.tool, 'write');
  assert.equal(denied[0].data.reason, 'completed or skipped uncertain effect; this continuation permits scoped reads only');
  assert.equal(denied[0].data.decisionId, identity.names.decision);
  assert.equal(denied[0].data.duplicate, undefined, 'This is v1 readonly refusal, not current duplicate-call protection');
  assert.ok(denied[0].seq > start.seq);
  const originalWrite = facts.find(fact => fact.kind === 'tool.intent' && fact.data.tool === 'write')!;
  assert.equal(originalWrite.data.args.content, 'first authorized effect\n');
  assert.equal(identity.scenario.before, 'first authorized effect\n');
  assert.equal(identity.scenario.attempted, 'forbidden replacement during readonly recovery\n');
  const request = facts.find(fact => fact.kind === 'model.provider-event' && fact.seq > start.seq && JSON.stringify(fact.data).includes(identity.scenario.attempted.trim()));
  assert.ok(request, 'The real recorded provider response requested different replacement bytes');
  assert.deepEqual(facts.filter(fact => fact.kind === 'tool.dispatch' && fact.seq > start.seq).map(fact => fact.data.tool), ['read'], 'The denied write never dispatched; scoped read still did');
  const readIntent = facts.find(fact => fact.kind === 'tool.intent' && fact.seq > start.seq && fact.data.tool === 'read')!;
  const readResult = facts.find(fact => fact.kind === 'tool.result' && fact.data.attemptId === readIntent.data.attemptId)!;
  assert.match(JSON.stringify(readResult.data.result), /first authorized effect/);
  assert.doesNotMatch(JSON.stringify(readResult.data.result), /forbidden replacement/);
  const target = readFileSync(join(fixture, 'workspace', identity.scenario.target));
  assert.equal(target.toString(), 'first authorized effect\n');
  assert.equal(hash(target), identity.scenario.targetSha256);
  assert.equal(facts.find(fact => fact.kind === 'run.closed')!.data.status, 'unknown', 'Recovery does not rewrite the original unknown result');
  assert.equal(facts.find(fact => fact.kind === 'recovery.closed')!.data.result.status, 'completed');
});

test('current trace reader and TUI display the v1 readonly segment and its refused write from retained facts', () => {
  const trace = readTrace(dataRoot, identity.names.run);
  assert.equal(trace.status, 'completed');
  assert.deepEqual(trace.segments.map(segment => [segment.kind, segment.readOnly]), [['run', false], ['recovery', true]]);
  const refused = trace.spans.filter(span => span.tool?.denied);
  assert.equal(refused.length, 1);
  const span = refused[0];
  assert.equal(span.outcome, 'denied');
  assert.equal(span.segment, 1);
  assert.equal(span.tool!.name, 'write');
  assert.equal(span.tool!.duplicate, false);
  assert.equal(span.tool!.target, null, 'v1 refusal did not record a path; do not invent one');
  assert.equal(span.tool!.call, null, 'v1 refusal did not record a call ordinal');
  assert.equal(span.tool!.error, 'completed or skipped uncertain effect; this continuation permits scoped reads only');
  const tier = COLOR_TIER;
  overrideColorTierForTest('none');
  try {
    const view = new TraceView(dataRoot, identity.names.run);
    view.select(span.key);
    for (const [width, height] of [[132, 38], [80, 24]] as const) {
      const lines = view.render(width, height, 'Esc 返回会话').map(stripTerminalSequences);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      const text = lines.join('\n');
      assert.match(text, /只读续跑（首版）/);
      assert.match(text, /✗ 被拒 · 只读续跑不允许 write/);
      assert.doesNotMatch(text, /该操作已完成，不重做/);
      if (width >= 100) assert.match(text, /tc 未记录/);
    }
  } finally { overrideColorTierForTest(tier); }
});
