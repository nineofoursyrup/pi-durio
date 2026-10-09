import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Evidence, openHostReadonly, readObject, digest } from '../src/evidence.js';
import { records } from '../src/history.js';
import { recoveryRecords, recoverySnapshotId, ownerSnapshotId } from '../src/recovery-facts.js';

test('streamed recovery and owner snapshot IDs equal the original array JSON digest, with a fixed watermark', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'durio-recovery-facts-'))), runId = 'snapshot-fixture';
  const evidence = new Evidence(root, runId);
  evidence.append('task.accepted', { sessionId: 'fixture', input: 'Unicode 中文 and \\ quoting "' });
  evidence.append('tool.output', { acquired: { encoding: 'base64', bytes: 'YWJj' }, optional: undefined });
  evidence.append('recovery.report', { snapshotId: 'excluded-from-content-hash' });
  evidence.append('recovery.decision', { decision: { id: 'preserved-in-content-hash' } });
  const view = recoveryRecords(root, runId), db = openHostReadonly(root);
  const oldRecords = db.prepare('SELECT seq,kind,at,body FROM records WHERE run_id=? ORDER BY seq').all(runId).map(row => ({ seq: Number(row.seq), kind: String(row.kind), at: String(row.at), data: JSON.parse(readObject(root, JSON.parse(String(row.body))).toString()) }));
  db.close();
  evidence.append('run.closed', { cleanup: 'confirmed', status: 'completed' });
  evidence.close();
  assert.equal(view.length, 4);
  assert.equal(view.find(record => record.kind === 'run.closed'), undefined);
  const source = [{ path: '/fixture/durable.sqlite', sha256: 'f'.repeat(64) }], reasons = ['an acquired unknown remains unknown'], claims = [{ path: '/fixture', markerSha256: 'a'.repeat(64) }];
  for (const authorization of [undefined, { workspace: '/fixture', tools: ['read'], mode: 'offline' }]) {
    const legacy = digest(JSON.stringify({ source, facts: oldRecords.filter(record => !record.kind.startsWith('recovery.') || record.kind === 'recovery.decision').map(record => [record.seq, record.kind, record.data]), authorization, reasons }));
    assert.equal(recoverySnapshotId(source, view, authorization, reasons), legacy);
  }
  assert.equal(ownerSnapshotId(view, claims), digest(JSON.stringify({ facts: oldRecords.map(record => [record.seq, record.kind]), claims })));
  assert.equal(view.filter(record => record.kind === 'recovery.decision').findLast(() => true)?.seq, 4);
});

test('recovery snapshot validation rejects missing or tampered original bodies, including hash-excluded recovery reports', async () => {
  for (const kind of ['task.accepted', 'tool.output', 'recovery.report']) for (const fault of ['missing', 'corrupt']) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'durio-recovery-integrity-')));
    const evidence = new Evidence(root, 'fixture'); evidence.append(kind, { acquired: 'original fact' }); evidence.close();
    const view = recoveryRecords(root, 'fixture'), ref = [...records(root)][0], path = join(root, 'objects', ref.ref.sha256);
    if (fault === 'missing') await unlink(path); else await writeFile(path, 'tampered');
    assert.throws(() => recoverySnapshotId([], view, undefined, []), /ENOENT|EVIDENCE_CORRUPT/);
    assert.throws(() => ownerSnapshotId(view, []), /ENOENT|EVIDENCE_CORRUPT/);
    assert.throws(() => view.find(record => record.kind === kind)!.data, /ENOENT|EVIDENCE_CORRUPT/);
  }
});
