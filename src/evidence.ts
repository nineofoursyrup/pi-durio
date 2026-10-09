import {stampFact} from './fact-clock.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, existsSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface EvidenceRecord { seq: number; kind: string; at: string; data: unknown }
export interface BlobRef { sha256: string; bytes: number }
export type FaultInjector = (kind: string) => void;

export interface FactReceipt { seq:number; kind:string; at:string }
export interface ControlTarget { workspace:string; sessionId:string; taskId:string; runId:string }
export type ControlKind = 'steer'|'follow-up'|'compact'|'improve';
export type QueueStatus = 'pending'|'dispatching'|'applied'|'withdrawn'|'frozen';
export interface ControlAdmission {
  requestId:string; kind:ControlKind; input:string; taskId:string|null; target:ControlTarget;
  executionVersion:{artifactId:string;configSeq:number;artifactSeq:number}; authorization:unknown;
}
export interface ControlReceipt {
  requestId:string; status:QueueStatus; reason:string;
  execution?:{runId:string;sessionId:string}|null;
  upstream?:{submissionId:number;status:string;entry?:number}|null;
}
export interface QueueItemFact extends ControlAdmission {
  runId:string|null; execution:{runId:string;sessionId:string}|null;
  acceptedAt:string; acceptedSeq:number; updatedAt:string; status:QueueStatus; reason:string;
  receipt:FactReceipt; upstream:{submissionId:number;status:string;entry?:number}|null;
}
export interface AcceptedTaskFact {
  taskId:string; requestId:string; kind:'task'|'follow-up'; input:string; workspace:string;
  /** Immutable originating identity, separate from the later execution linkage. */
  target:ControlTarget|null; execution:{runId:string;sessionId:string}|null; runId:string|null;
  acceptedAt:string; acceptedSeq:number; updatedAt:string; status:string; reason:string|null;
  executionVersion:ControlAdmission['executionVersion']|null; authorization:unknown; receipt:FactReceipt;
}
export interface FactPageOptions { after?:number; limit?:number; through?:number }

function decodeRecord(root:string,row:any):EvidenceRecord & {runId:string} {
  return {seq:Number(row.seq),kind:String(row.kind),at:String(row.at),runId:String(row.run_id),data:JSON.parse(readObject(root,JSON.parse(String(row.body))).toString())};
}
function factPage(db:DatabaseSync,options:FactPageOptions) {
  const through=options.through??Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM records').get()!.seq);
  const after=options.after??0,limit=options.limit??50;
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(through)||through<after||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('INVALID_FACT_PAGE');
  return {through,after,limit};
}
function queueFact(root:string,db:DatabaseSync,record:EvidenceRecord,through:number):QueueItemFact {
  const admission=record.data as ControlAdmission;
  let last=record,status:QueueStatus='pending',reason='Accepted; not yet applied';
  let execution:QueueItemFact['execution']=admission.kind==='steer'?{runId:admission.target.runId,sessionId:admission.target.sessionId}:null;
  let upstream:QueueItemFact['upstream']=null;
  // Content-addressed originals remain authoritative; this scan holds one receipt at a time.
  for(const row of db.prepare("SELECT * FROM records WHERE run_id=? AND kind='control.receipt' AND seq>? AND seq<=? ORDER BY seq").iterate(admission.target.runId,record.seq,through)) {
    const fact=decodeRecord(root,row),value=fact.data as ControlReceipt;
    if(value.requestId!==admission.requestId)continue;
    last=fact;status=value.status;reason=value.reason;
    if(value.execution!==undefined)execution=value.execution;
    if(value.upstream!==undefined)upstream=value.upstream;
  }
  return {...admission,execution,runId:execution?.runId??null,acceptedAt:record.at,acceptedSeq:record.seq,updatedAt:last.at,status,reason,receipt:{seq:last.seq,kind:last.kind,at:last.at},upstream};
}

/** Strictly readonly. `through` bounds admissions AND all status/link/decision facts on every page. */
export function readQueue(root:string,options:FactPageOptions & {targetRunId?:string}={}) {
  const db=openHostReadonly(root);
  try {
    const {through,after,limit}=factPage(db,options);
    const rows=db.prepare(`SELECT * FROM records WHERE kind='control.accepted' AND seq>? AND seq<=? ${options.targetRunId?'AND run_id=?':''} ORDER BY seq LIMIT ?`).all(after,through,...(options.targetRunId?[options.targetRunId]:[]),limit+1);
    const items=rows.slice(0,limit).map(row=>queueFact(root,db,decodeRecord(root,row),through));
    return {items,through,next:rows.length>limit?items.at(-1)!.acceptedSeq:null};
  } finally {db.close();}
}

/** One member per independent acceptance; steer is never a member and a linked follow-up is never counted twice. */
export function readAcceptedTasks(root:string,options:FactPageOptions={}) {
  const db=openHostReadonly(root);
  try {
    const {through,after,limit}=factPage(db,options),tasks:AcceptedTaskFact[]=[];
    const statement=db.prepare("SELECT * FROM records WHERE kind IN ('task.accepted','control.accepted') AND seq>? AND seq<=? ORDER BY seq");
    for(const row of statement.iterate(after,through)) {
      const record=decodeRecord(root,row),data=record.data as any;
      if(record.kind==='control.accepted'&&data.kind!=='follow-up')continue;
      if(record.kind==='task.accepted'&&data.queueRequestId)continue;
      let fact:AcceptedTaskFact;
      if(record.kind==='control.accepted') {
        const item=queueFact(root,db,record,through);
        fact={taskId:item.taskId!,requestId:item.requestId,kind:'follow-up',input:item.input,workspace:item.target.workspace,target:item.target,execution:item.execution,runId:item.runId,acceptedAt:item.acceptedAt,acceptedSeq:item.acceptedSeq,updatedAt:item.updatedAt,status:item.status,reason:item.reason,executionVersion:item.executionVersion,authorization:item.authorization,receipt:item.receipt};
      } else {
        const get=(kind:string)=>{const found=db.prepare('SELECT * FROM records WHERE run_id=? AND kind=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(record.runId,kind,through);return found?decodeRecord(root,found):null;};
        const started=get('run.started'),artifact=get('execution.artifact'),config=get('execution.config');
        const execution=started?{runId:record.runId,sessionId:data.sessionId}:null;
        fact={taskId:data.taskId,requestId:data.requestId??data.taskId,kind:'task',input:data.input,workspace:data.workspace,target:null,execution,runId:execution?.runId??null,acceptedAt:record.at,acceptedSeq:record.seq,updatedAt:record.at,status:started?'running':'accepted',reason:null,executionVersion:artifact&&config?{artifactId:(artifact.data as any).id,artifactSeq:artifact.seq,configSeq:config.seq}:null,authorization:data.authorization??null,receipt:{seq:record.seq,kind:record.kind,at:record.at}};
      }
      const outcomeRunId=fact.runId??(record.kind==='task.accepted'?record.runId:null);
      if(outcomeRunId) {
        const closed=db.prepare("SELECT * FROM records WHERE run_id=? AND kind IN ('run.closed','recovery.closed','recovery.ended') AND seq<=? ORDER BY seq DESC LIMIT 1").get(outcomeRunId,through);
        if(closed){const receipt=decodeRecord(root,closed),result=(receipt.data as any).result??receipt.data as any;fact.status=receipt.kind==='recovery.ended'?'ended':result.status;fact.reason=result.reason??null;fact.updatedAt=receipt.at;fact.receipt={seq:receipt.seq,kind:receipt.kind,at:receipt.at};}
      }
      tasks.push(fact);if(tasks.length>limit)break;
    }
    const hasMore=tasks.length>limit;tasks.splice(limit);
    return {tasks,through,next:hasMore?tasks.at(-1)!.acceptedSeq:null};
  } finally {db.close();}
}

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
    const stamped=stampFact(kind,data);
    const body = JSON.stringify(stamped.data);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('EVIDENCE_RECORD_LIMIT');
    const ref = this.blob(body);
    const row = this.db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)').run(this.runId, kind, stamped.acquiredAt, JSON.stringify(ref));
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
    const original=resultRow?decode(resultRow).data as Record<string,unknown>:null;
    // Acquisition metadata belongs to the fact, not the public RunResult value.
    // Raw records retain it; the result projection preserves runtime/readback parity.
    const {clock:resultClock,...result}=original??{status:'unknown',reason:'No confirmed close receipt; recovery check required'};
    return { runId, result, ...(resultClock?{resultClock}:{}), ...(recoveryRow ? {recovery:decode(recoveryRow)} : {}), records: rows.slice(0, limit).map(decode), next: rows.length > limit ? Number(rows[limit - 1].seq) : null };
  } finally { db.close(); }
}
