import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Evidence } from '../src/evidence.js';
import { readRunRecords, readObjectRange, readTextPage } from '../src/query.js';

test('metadata windows and bounded originals preserve readonly identity, ordering and corruption errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'durio-query-'));
  const evidence = new Evidence(root, 'run');
  for (let n = 0; n < 9; n++) evidence.append('large-output', { n, text: '中文👩‍💻'.repeat(20000) });
  evidence.close();
  const before = readdirSync(root).map(name => [name, statSync(join(root,name)).mtimeMs]);
  const first = readRunRecords(root, 'run', { limit: 3 });
  assert.deepEqual(first.records.map(r => r.seq), [1,2,3]);
  assert.equal('data' in first.records[0], false);
  assert.deepEqual(readRunRecords(root, 'run', { after: first.records.at(-1)!.seq, limit: 3 }).records.map(r => r.seq), [4,5,6]);
  assert.deepEqual(readRunRecords(root, 'run', { tail: true, limit: 2 }).records.map(r => r.seq), [8,9]);
  assert.deepEqual(readRunRecords(root, 'run', { before: 8, limit: 2 }).records.map(r => r.seq), [6,7]);
  const ref = first.records[0].ref;
  const part = readObjectRange(root, ref, { offset: 30, limit: 128 });
  const original = readFileSync(join(root, 'objects', ref.sha256));
  assert.deepEqual(part.bytes, original.subarray(30,158));
  assert.equal(part.next,158);
  assert.equal(part.total,original.length);
  let offset=0, reconstructed='';
  for (;;) {const page=readTextPage(root,ref,offset,2048);assert.doesNotMatch(page.text,/�/);reconstructed+=page.text;if(page.next===null)break;offset=page.next;}
  assert.equal(reconstructed,original.toString());
  assert.deepEqual(readdirSync(root).map(name => [name, statSync(join(root,name)).mtimeMs]), before);
  assert.throws(() => readObjectRange(root, ref, { offset: -1 }), /INVALID/);
  assert.throws(() => readObjectRange(root, ref, { limit: Infinity }), /INVALID/);
  writeFileSync(join(root,'objects',ref.sha256), Buffer.alloc(ref.bytes));
  assert.throws(() => readObjectRange(root, ref, { offset: 0, limit: 1 }), /CORRUPT/);
});
