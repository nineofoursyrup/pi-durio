import {openHostReadonly,readObject,digest} from './evidence.js';
import type {ImproveCandidate} from './improve.js';

export interface ImproveFact {sourceId:string;runId:string;seq:number;kind:string;data:any}
/** Facts remain in the existing host journal; no separate decision database. */
export function improveFacts(root:string,through=Number.MAX_SAFE_INTEGER):ImproveFact[]{
 const db=openHostReadonly(root);
 try{return db.prepare("SELECT * FROM records WHERE kind IN ('improve.decision','improve.group-started','improve.validation','improve.batch','improve.resume','improve.restore','improve.prepared','improve.check','improve.check-started','improve.eval','improve.batch-started','improve.formal-started','improve.formal','improve.write-intent','improve.write-result','improve.activation','improve.rollback','improve.rollback-request','improve.rollback-intent','improve.rollback-result','improve.default-observed') AND seq<=? ORDER BY seq").all(through).map(row=>{
  const ref=JSON.parse(String(row.body));return {sourceId:`e1:${row.seq}:${ref.sha256}`,runId:String(row.run_id),seq:Number(row.seq),kind:String(row.kind),data:JSON.parse(readObject(root,ref).toString())};
 });}finally{db.close();}
}
export function problemIdentity(candidate:ImproveCandidate){
 const paths=[...candidate.scope].sort();
 // Address and explicit file scope are reviewable and stable across reports and
 // package upgrades. Prose is never the identity. Legacy reports stay readable.
 return {target:{workspace:candidate.target.workspace,kind:candidate.target.kind},paths,
  key:candidate.problemKey??`unclassified:${candidate.objective}`,basis:candidate.problemKey?'declared problem key and exact target/file scope':'legacy unclassified problem; overlapping scope remains ambiguous'};
}
export function conditionIdentity(candidate:ImproveCandidate){
 return digest(JSON.stringify(conditionFiles(candidate)));
}
export function conditionFiles(candidate:ImproveCandidate){return candidate.target.files.filter(f=>candidate.scope.includes(f.path)).map(f=>({path:f.path,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path));}
export function listImproveSuppressions(root:string,workspace?:string,through=Number.MAX_SAFE_INTEGER){
 const facts=improveFacts(root,through),restored=new Set(facts.filter(f=>f.kind==='improve.restore').map(f=>f.data.suppressionId));
 return facts.filter(f=>f.kind==='improve.decision').flatMap(f=>(f.data.decisions??[]).filter((item:any)=>['defer','do-not-suggest'].includes(item.mode)&&(!workspace||item.problem.target.workspace===workspace)).map((item:any)=>{
  const id=`${f.sourceId}:${digest(JSON.stringify(item.problem))}`;
  return {id,sourceId:f.sourceId,runId:f.runId,decisionId:f.data.id,...item,active:!restored.has(id)};
 }));
}
function sameTarget(a:ReturnType<typeof problemIdentity>,b:ReturnType<typeof problemIdentity>){return a.target.workspace===b.target.workspace&&a.target.kind===b.target.kind;}
export function suppressionMatch(root:string,candidate:ImproveCandidate,through=Number.MAX_SAFE_INTEGER){
 const identity=problemIdentity(candidate),condition=conditionIdentity(candidate),matches:any[]=[];
 for(const item of listImproveSuppressions(root,undefined,through)){if(!item.active||!sameTarget(identity,item.problem))continue;
   const exact=item.problem.key===identity.key;
   const overlap=identity.paths.some(p=>item.problem.paths.includes(p))||!identity.paths.length||!item.problem.paths.length;
   if(!exact&&!overlap)continue;
   const changed=item.condition!==condition;
   const explained=candidate.reconsideration?.sourceId===item.sourceId&&!!candidate.reconsideration?.reason.trim()&&!!candidate.reconsideration.evidence.length;
   const blocked=item.mode==='do-not-suggest'||!changed||!exact||!explained;
   matches.push({sourceId:item.sourceId,suppressionId:item.id,decisionId:item.decisionId,mode:item.mode,identity:item.problem,match:exact?'explicit-problem':'overlapping-scope-identity-unknown',blocked,
    reason:!exact?'Overlapping target/file scope has an unresolved problem identity; changing a key does not establish a new problem. Restore or explicitly identify a distinct scope.':item.mode==='do-not-suggest'?'Explicit suppression remains until user restore.':changed?explained?`Relevant target content changed since deferral. Declared reconsideration: ${candidate.reconsideration!.reason}`:'Relevant target content changed, but no evidence-backed substantive reconsideration explanation was supplied; byte changes alone do not lift deferral.':'Relevant target content is unchanged since deferral; new wording, upgrades and same-kind observations do not lift it.',
    changedFiles:conditionFiles(candidate).filter(f=>!(item.conditionFiles??[]).some((old:any)=>old.path===f.path&&old.sha256===f.sha256)).map(f=>({path:f.path,before:(item.conditionFiles??[]).find((old:any)=>old.path===f.path)?.sha256??null,after:f.sha256})),
    previousCondition:item.condition,currentCondition:condition});
 }
 return {blocked:matches.some(m=>m.blocked),matches};
}
export function scopedImproveDecisions(root:string,workspace:string,through=Number.MAX_SAFE_INTEGER,limit=20){
 const facts=improveFacts(root,through),decisions=facts.filter(f=>f.kind==='improve.decision'&&f.data.workspace===workspace).slice(-limit);
 return decisions.map(f=>({id:f.data.id,runId:f.runId,sourceId:f.sourceId,kind:f.kind,reportId:f.data.decision.reportId,reportRevision:f.data.decision.reportRevision,
  decisions:f.data.decisions,results:facts.filter(x=>x.data.id===f.data.id&&x.kind!=='improve.decision').map(x=>({sourceId:x.sourceId,runId:x.runId,kind:x.kind,state:x.data.state??null,reason:x.data.reason??null})).slice(-20)}));
}
function validationView(root:string,result:any){
 if(!result)return null;
 return {...result,checks:result.checks?.map((check:any)=>{
  if(!check.reportDocument)return check;
  try{return {...check,report:JSON.parse(readObject(root,check.reportDocument).toString()),reportAvailability:'retained parent snapshot; child attachment availability requires reading the declared child root'};}
  catch(error){return {...check,report:null,reportAvailability:'unavailable',reportReason:String(error)};}
 })};
}
export function readImproveDecision(root:string,id:string){
 const facts=improveFacts(root),accepted=facts.find(f=>f.kind==='improve.decision'&&f.data.id===id);
 if(!accepted)throw Error('IMPROVE_DECISION_NOT_FOUND');
 const related=facts.filter(f=>f.data.id===id&&f.seq>=accepted.seq),last=related.filter(f=>f.kind==='improve.batch').at(-1);
 const groups=accepted.data.decision.groups.map((g:any)=>{
  const starts=related.filter(f=>f.kind==='improve.group-started'&&f.data.groupId===g.id),result=related.filter(f=>f.kind==='improve.validation'&&f.data.groupId===g.id).at(-1);
  const formal=related.filter(f=>f.kind==='improve.formal'&&f.data.groupId===g.id).at(-1),formalStart=related.find(f=>f.kind==='improve.formal-started'&&f.data.groupId===g.id),rollback=related.filter(f=>f.kind==='improve.rollback'&&f.data.groupId===g.id).at(-1);
  return {id:g.id,candidateIds:g.candidateIds,state:result?.data.state??(starts.length?'unknown':'not-run'),result:validationView(root,result?.data.result),reason:result?(result.data.reason??null):(starts.length?'Interrupted group has no committed result; never replayed.':null),sourceId:result?.sourceId??starts.at(-1)?.sourceId??null,formal:formal?.data??(formalStart?{state:'unknown',writeback:'partial-or-unknown',activation:'unknown'}:null),formalSource:formal?.sourceId??formalStart?.sourceId??null,rollback:rollback?.data??null};
 });
 const unresolved=groups.some((g:any)=>g.state==='unknown'),notRun=groups.some((g:any)=>g.state==='not-run'),failed=groups.some((g:any)=>['failed','cancelled'].includes(g.state));
 return {id,decision:accepted.data.decision,requestDigest:accepted.data.requestDigest,executionVersion:accepted.data.executionVersion,sourceId:accepted.sourceId,runId:accepted.runId,
  state:unresolved||notRun?'frozen':last?.data.state==='completed'&&failed?'completed-with-failures':last?.data.state??(groups.length?'frozen':'completed'),reason:unresolved?'A started group has no certain recorded outcome.':last?.data.reason??(notRun?'Independent not-run groups remain frozen until an explicit valid continuation.':null),groups,
  activation:groups.some((g:any)=>g.rollback?.state==='completed')?'see-groups':groups.some((g:any)=>g.formal?.activation==='new-default')?'new-default':'not-enabled',writeback:groups.some((g:any)=>g.rollback?.state==='completed')?'see-groups':groups.some((g:any)=>['frozen','unknown'].includes(g.formal?.state))?'partial-or-unknown':groups.some((g:any)=>g.formal?.writeback==='written')?'written':'not-written',effect:groups.length?'see combination results; no separate causal credit':'unverified',
  facts:related.map(f=>({sourceId:f.sourceId,kind:f.kind,runId:f.runId,state:f.data.state??null,reason:f.data.reason??null})),
  reserved:related.filter(f=>f.kind==='improve.group-started').reduce((n,f)=>({checks:n.checks+f.data.reserved.checks,requests:n.requests+f.data.reserved.requests,tokens:n.tokens+f.data.reserved.tokens}),{checks:0,requests:0,tokens:0})};
}
