import { openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openHostReadonly, type BlobRef } from './evidence.js';

export interface RecordReference { seq: number; kind: string; at: string; ref: BlobRef }
function integer(value: number, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('INVALID_QUERY_RANGE');
  return value;
}
/** Host schema only; no Harness, writable connection, migration, or original decoding. */
export function readRunRecords(root: string, runId: string, options: { after?: number; before?: number; limit?: number; tail?: boolean; kinds?: readonly string[] } = {}) {
  const limit = Math.min(50, integer(options.limit ?? 24, 1));
  const after = integer(options.after ?? 0, 0);
  const before = integer(options.before ?? Number.MAX_SAFE_INTEGER, 1);
  const reverse = options.tail || options.before !== undefined;
  const kinds=options.kinds;
  if(kinds&&(!kinds.length||kinds.length>32||kinds.some(kind=>typeof kind!=='string'))) throw new Error('INVALID_QUERY_KINDS');
  const db = openHostReadonly(root);
  try {
    const rows = db.prepare(`SELECT seq,kind,at,body FROM records WHERE run_id=? AND seq>? AND seq<? ${kinds?`AND kind IN (${kinds.map(()=>'?').join(',')})`:''} ORDER BY seq ${reverse ? 'DESC' : 'ASC'} LIMIT ?`).all(runId, after, before, ...(kinds??[]), limit + 1);
    const records: RecordReference[] = rows.slice(0, limit).map(row => ({ seq: Number(row.seq), kind: String(row.kind), at: String(row.at), ref: JSON.parse(String(row.body)) }));
    if (reverse) records.reverse();
    return { runId, records, more: rows.length > limit };
  } finally { db.close(); }
}
/** Verify all acquired bytes while retaining only one bounded slice from that same read. */
export function readObjectRange(root: string, ref: BlobRef, options: { offset?: number; limit?: number } = {}) {
  if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('INVALID_EVIDENCE_REFERENCE');
  const offset = integer(options.offset ?? 0, 0);
  const limit = Math.min(16384, integer(options.limit ?? 4096, 1));
  const result = Buffer.alloc(Math.min(limit, Math.max(0, ref.bytes - offset)));
  const fd = openSync(join(root, 'objects', ref.sha256), 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(65536);
  let total = 0;
  try {
    for (;;) {
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      hash.update(chunk.subarray(0, length));
      const start = Math.max(offset, total), end = Math.min(offset + result.length, total + length);
      if (end > start) chunk.copy(result, start - offset, start - total, end - total);
      total += length;
    }
  } finally { closeSync(fd); }
  if (total !== ref.bytes || hash.digest('hex') !== ref.sha256) throw new Error('EVIDENCE_CORRUPT');
  return { bytes: result, offset, total, next: offset + result.length < total ? offset + result.length : null };
}

/** Text pages keep ordinary Unicode graphemes intact without retaining an entire original. */
export function readTextPage(root:string, ref:BlobRef, offset=0, limit=2048) {
  const page=readObjectRange(root,ref,{offset,limit});
  let bytes=page.bytes;
  if(page.next!==null) {
    let start=bytes.length-1;
    while(start>0&&(bytes[start]&0xc0)===0x80)start--;
    const lead=bytes[start],size=lead<0x80?1:lead<0xe0?2:lead<0xf0?3:4;
    if(start+size>bytes.length)bytes=bytes.subarray(0,start);
  }
  let text=bytes.toString('utf8');
  if(page.next!==null) {
    const segments=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)];
    // Keep the final cluster for the following page in case a combining sequence continues.
    const last=segments.at(-1);
    if(last&&last.index>0)text=text.slice(0,last.index);
  }
  const next=offset+Buffer.byteLength(text);
  if(next===offset&&offset<ref.bytes)throw new Error('TEXT_PAGE_TOO_SMALL');
  return {text,offset,total:page.total,next:next<page.total?next:null};
}

export { queryHistory, queryEvidence, queryAttempts, readEvidence, watermark } from './history.js';
export { queryUsage } from './usage-query.js';
export { scopedEvidence } from './derived-evidence.js';
export { fixEvidence, verifyFixed, fixedDependencies, iterateFixedDependencies, estimateUsage } from './fixed-evidence.js';
