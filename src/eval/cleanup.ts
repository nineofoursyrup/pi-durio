/** Process-local receipts from actual runner finally paths, never reconstructed
 * from a closed report or a cancellation request. */
export interface EvalCleanupReceipt {
  dataRoot: string;
  planId: string;
  operation: 'run' | 'grade';
  storage: 'not-opened' | 'closed' | 'unknown';
  owner: 'not-acquired' | 'released' | 'unknown';
  executions: { id: string | null; started: boolean | null; terminated: boolean; status: string; reason: string | null }[];
  cleanup: 'confirmed' | 'unknown';
}

export class EvalCleanupTracker {
  readonly receipt: EvalCleanupReceipt;
  constructor(dataRoot:string, planId:string, operation:'run'|'grade') {
    this.receipt={dataRoot,planId,operation,storage:'not-opened',owner:'not-acquired',executions:[],cleanup:'confirmed'};
  }
  async execute<T extends {id:string;started:boolean;terminated:boolean;status:string;reason:string|null}>(run:()=>Promise<T>):Promise<T> {
    const item:EvalCleanupReceipt['executions'][number]={id:null,started:null,terminated:false,status:'unknown',reason:'execution result unavailable'};
    this.receipt.executions.push(item);
    const result=await run();
    Object.assign(item,{id:result.id,started:result.started,terminated:result.terminated,status:result.status,reason:result.reason});
    return result;
  }
  finish() {
    const r=this.receipt;
    r.cleanup=r.owner!=='unknown'&&r.storage!=='unknown'&&r.executions.every(e=>e.terminated||e.started===false&&e.status==='not-started')?'confirmed':'unknown';
    return structuredClone(r);
  }
}
