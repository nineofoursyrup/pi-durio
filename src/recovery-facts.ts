import { createHash } from 'node:crypto';
import type { EvidenceRecord } from './evidence.js';
import { records, decode, watermark } from './history.js';

/** A fixed-watermark view, not an array or body cache. Predicates can select by kind/seq
 * before touching data; each selected body still goes through content-address validation.
 */
export class RecoveryRecords implements Iterable<EvidenceRecord> {
  constructor(private readonly scan: () => Iterable<EvidenceRecord>) {}
  [Symbol.iterator]() { return this.scan()[Symbol.iterator](); }
  filter(predicate: (record: EvidenceRecord) => boolean): RecoveryRecords {
    const source = this;
    return new RecoveryRecords(function* () { for (const record of source) if (predicate(record)) yield record; });
  }
  find(predicate: (record: EvidenceRecord) => boolean): EvidenceRecord | undefined {
    for (const record of this) if (predicate(record)) return record;
    return undefined;
  }
  findLast(predicate: (record: EvidenceRecord) => boolean): EvidenceRecord | undefined {
    let found: EvidenceRecord | undefined;
    for (const record of this) if (predicate(record)) found = record;
    return found;
  }
  some(predicate: (record: EvidenceRecord) => boolean) { return this.find(predicate) !== undefined; }
  get length() { let count = 0; for (const _ of this) count++; return count; }
  /** Explicit result projection for the selected report fields; filters never materialize bodies. */
  map<T>(project: (record: EvidenceRecord) => T): T[] {
    const result: T[] = [];
    for (const record of this) result.push(project(record));
    return result;
  }
}

export function recoveryRecords(root: string, runId?: string): RecoveryRecords {
  const through = watermark(root);
  return new RecoveryRecords(function* () {
    for (const ref of records(root, { runId, through })) {
      let loaded = false, value: unknown;
      yield { seq: ref.seq, kind: ref.kind, at: ref.at, get data() {
        if (!loaded) { value = decode(root, ref); loaded = true; }
        return value;
      } };
    }
  });
}

/** Same JSON bytes as the previous array snapshot, streamed one bounded fact at a time.
 * Reading data here is intentional: recovery identities must validate/bind every original body.
 */
export function recoverySnapshotId(source: unknown, facts: RecoveryRecords, authorization: unknown, reasons: string[]) {
  const hash = createHash('sha256');
  hash.update(`{"source":${JSON.stringify(source)},"facts":[`);
  let first = true;
  for (const record of facts) {
    const data = record.data;
    if (record.kind.startsWith('recovery.') && record.kind !== 'recovery.decision') continue;
    if (!first) hash.update(',');
    hash.update(JSON.stringify([record.seq, record.kind, data]));
    first = false;
  }
  hash.update(`]${authorization === undefined ? '' : `,"authorization":${JSON.stringify(authorization)}`},"reasons":${JSON.stringify(reasons)}}`);
  return hash.digest('hex');
}

export function ownerSnapshotId(facts: RecoveryRecords, claims: unknown) {
  const hash = createHash('sha256');
  hash.update('{"facts":[');
  let first = true;
  for (const record of facts) {
    // The previous eager read validated these bodies even though owner identity uses only metadata.
    void record.data;
    if (!first) hash.update(',');
    hash.update(JSON.stringify([record.seq, record.kind]));
    first = false;
  }
  hash.update(`],"claims":${JSON.stringify(claims)}}`);
  return hash.digest('hex');
}
