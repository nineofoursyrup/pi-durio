import { digest, readObject } from './evidence.js';

/** Admission-only evidence for a completed whole-session cleanup. It cannot authorize recovery.
 * The immutable preview, explicit commit, whole-session inspection, and final result must agree.
 */
export function sessionRemovalVerified(root:string,sessionId:string,facts:{seq:number;runId:string;kind:string;data:any}[]) {
  const removed=facts.findLast(f=>f.kind==='management.session-removed'&&f.data.sessionId===sessionId);
  if(!removed)return false;
  const marker=removed.data,id=marker.operationId,management=facts.filter(f=>f.runId===`management:${id}`);
  const preview=management.find(f=>f.kind==='management.preview'),commit=management.find(f=>f.kind==='management.commit');
  const complete=management.findLast(f=>f.kind==='management.part-result'&&f.data.unitId===`session:${sessionId}`);
  if(marker.version!==1||marker.state!=='cleaned'||marker.complete!==true||!preview||!commit||complete?.data.status!=='completed'||preview.data.identity!==marker.previewIdentity||commit.data.identity!==marker.previewIdentity||complete.data.identity!==marker.previewIdentity)return false;
  try {
    if(preview.data.plan.bytes>16*1024*1024)return false;
    const bytes=readObject(root,preview.data.plan);if(digest(bytes)!==marker.previewIdentity)return false;
    const plan=JSON.parse(bytes.toString()),unit=plan.units?.find((u:any)=>u.id===`session:${sessionId}`);
    // Exact copied facts remain valid after whole-root relocation; they authorize no old execution.
    if(plan.id!==id||plan.version!==1||!unit||unit.kind!=='session'||unit.protectedBy.length||!unit.inspection?.conversations?.length||unit.inspection.pending!==0||JSON.stringify(unit.files)!==JSON.stringify(marker.files)||JSON.stringify(unit.inspection)!==JSON.stringify(marker.inspection))return false;
    const runs=[...new Set(facts.filter(f=>f.kind==='task.accepted'&&f.data.sessionId===sessionId).map(f=>f.runId))].sort();
    if(!runs.length||JSON.stringify(runs)!==JSON.stringify([...unit.runIds].sort())||JSON.stringify(runs)!==JSON.stringify([...marker.runIds].sort()))return false;
    for(const runId of runs) {
      const close=facts.findLast(f=>f.runId===runId&&['run.closed','recovery.closed'].includes(f.kind));
      const result=close?.data.result??close?.data;
      if(!close||close.seq>removed.seq||result.cleanup!=='confirmed'||!['completed','failed','aborted'].includes(result.status))return false;
      // Any later execution/control/recovery fact invalidates this admission exception.
      if(facts.some(f=>f.runId===runId&&f.seq>removed.seq&&!['evidence.availability','evidence.fixed','evidence.unfixed','usage.estimate'].includes(f.kind)))return false;
    }
    const results=management.filter(f=>f.kind==='management.file-result'&&f.data.unitId===unit.id);
    return unit.files.every((file:any)=>results.some(f=>f.data.path===file.path&&f.data.sha256===file.sha256&&f.data.bytes===file.bytes&&['deleted','absent-after-recorded-intent'].includes(f.data.state)));
  }catch{return false;}
}
