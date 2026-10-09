import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, existsSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface EvidenceRecord { seq: number; kind: string; at: string; data: unknown }
export interface BlobRef { sha256: string; bytes: number }
export type FaultInjector = (kind: string) => void;

/** Host-owned facts, separate from upstream durable state. Appends and blobs are synchronous backpressure. */
export class Evidence {
  readonly db: DatabaseSync;
  constructor(readonly root: string, readonly runId: string, private readonly fault?: FaultInjector) {
    mkdirSync(join(root, 'objects'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'host.sqlite'));
    chmodSync(join(root, 'host.sqlite'), 0o600);
    // Public readonly viewers can briefly hold a shared lock. Wait only for that
    // SQLite lock; this never retries a tool/model or masks a lasting write failure.
    this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_run ON records(run_id, seq)');
  }
  blob(bytes: string | Uint8Array): BlobRef {
    const value = Buffer.from(bytes);
    const sha256 = digest(value);
    const path = join(this.root, 'objects', sha256);
    if (!existsSync(path)) {
      const temporary = `${path}.${randomUUID()}`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const dir = openSync(join(this.root, 'objects'), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } else if (digest(readFileSync(path)) !== sha256) { throw new Error('EVIDENCE_CORRUPT'); }
    return { sha256, bytes: value.byteLength };
  }
  append(kind: string, data: unknown): number {
    this.fault?.(kind);
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('EVIDENCE_RECORD_LIMIT');
    const ref = this.blob(body);
    const row = this.db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)').run(this.runId, kind, new Date().toISOString(), JSON.stringify(ref));
    return Number(row.lastInsertRowid);
  }
  close() { this.db.close(); }
}

export function readObject(root: string, ref: BlobRef): Buffer {
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('INVALID_EVIDENCE_REFERENCE');
  const value = readFileSync(join(root, 'objects', ref.sha256));
  if (value.length !== ref.bytes || digest(value) !== ref.sha256) throw new Error('EVIDENCE_CORRUPT');
  return value;
}

/** No Harness or writable storage is opened. Paginated host facts reference durable content-addressed originals. */
export function openHostReadonly(root: string) {
  const path = join(root, 'host.sqlite');
  const fd = openSync(path, 'r');
  const bytes = Buffer.alloc(20);
  try { readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
  if (bytes[18] !== 1 || bytes[19] !== 1) throw new Error('RECOVERY_REQUIRED: unsupported host journal; no read-side migration');
  return new DatabaseSync(path, { readOnly: true });
}

export async function readRun(root: string, runId: string, options: { after?: number; limit?: number } = {}) {
  const db = openHostReadonly(root);
  try {
    const limit = Math.max(1, Math.min(200, options.limit ?? 200));
    const rows = db.prepare('SELECT seq,kind,at,body FROM records WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, options.after ?? 0, limit + 1);
    const decode = (row: typeof rows[number]): EvidenceRecord => ({ seq: Number(row.seq), kind: String(row.kind), at: String(row.at), data: JSON.parse(readObject(root, JSON.parse(String(row.body))).toString()) });
    const resultRow = db.prepare("SELECT seq,kind,at,body FROM records WHERE run_id=? AND kind='run.closed' ORDER BY seq DESC LIMIT 1").get(runId);
    const recoveryRow = db.prepare("SELECT seq,kind,at,body FROM records WHERE run_id=? AND kind IN ('recovery.closed','recovery.ended','recovery.report') ORDER BY seq DESC LIMIT 1").get(runId);
    return { runId, result: resultRow ? decode(resultRow).data : { status: 'unknown', reason: 'No confirmed close receipt; recovery check required' }, ...(recoveryRow ? {recovery:decode(recoveryRow)} : {}), records: rows.slice(0, limit).map(decode), next: rows.length > limit ? Number(rows[limit - 1].seq) : null };
  } finally { db.close(); }
}
