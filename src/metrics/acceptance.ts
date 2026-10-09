import {Evidence,digest,readAcceptedTasks} from '../evidence.js';
import {factClock,type FactClock} from '../fact-clock.js';
import {records,decode,resolveEvidence,watermark,type EvidenceReference} from '../history.js';

export type Verdict='PASS'|'FAIL'|'unknown';
export interface JudgmentSource {kind:'human'|'checks'|'unverified';actor:string;statement:string;refs:string[]}
interface Base {id:string;taskId:string;occurredAt?:string;source:JudgmentSource;reason?:string}
export interface Requirement {id:string;description:string;check?:{command:string;passExitCodes:number[];failExitCodes:number[]}}
export type AcceptanceInput=
 | Base&{type:'requirements';ruleVersion:string;necessary:Requirement[];revisionOf?:string}
 | Base&{type:'result';requirementsId:string;evidence:string[];revisionOf?:string}
 | Base&{type:'judgment';requirementsId:string;resultId:string;findings:{requirementId:string;outcome:Verdict;evidence:string[]}[];validity:'valid'|'faulty'|'contaminated'|'insufficient';supersedes?:string[]}
 | Base&{type:'withdraw'|'dispute';targets:string[];reason:string};
export interface AcceptanceFact {ref:EvidenceReference;data:AcceptanceInput&{requestIdentity:string;occurredAt:string;receivedAt:string;clock:FactClock;timeSource:'host-receipt'|'reported-occurrence';assessment?:{method:string;ruleVersion:string;requirementsSource:string;resultSource:string;basisThrough:number;sourceRefs:string[];outcome:Verdict;findings:Assessed['findings'];reasons:string[];reliableFailures:string[]}}}
export const acceptanceKinds=['acceptance.requirements','acceptance.result','acceptance.judgment','acceptance.withdraw','acceptance.dispute'] as const;
const nonempty=(value:unknown,max=4096):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max;
function ensure(condition:unknown,message:string):asserts condition {if(!condition)throw Error(`INVALID_ACCEPTANCE: ${message}`);}
export function readAcceptance(root:string,taskId:string,through=watermark(root)):AcceptanceFact[] {
 const facts:AcceptanceFact[]=[];
 for(const ref of records(root,{through,kinds:acceptanceKinds})){const data=decode(root,ref);if(data.taskId===taskId)facts.push({ref,data});}
 return facts;
}
function task(root:string,taskId:string) {
 let after:number|undefined,through:number|undefined;
 do{const page=readAcceptedTasks(root,{after,through,limit:200});const found=page.tasks.find(t=>t.taskId===taskId);if(found)return found;through=page.through;after=page.next??undefined;}while(after);
 throw Error('ACCEPTANCE_TASK_NOT_FOUND');
}
/** Explicit host/user management input, never registered as a candidate tool.
 * Only appends to the original Evidence store. A short SQLite transaction makes
 * duplicate IDs/revisions atomic even while the execution owner writes facts. */
export function recordAcceptance(root:string,input:AcceptanceInput) {
 ensure(input&&nonempty(input.id,128)&&nonempty(input.taskId,128),'identity required');
 ensure(['requirements','result','judgment','withdraw','dispute'].includes(input.type),'unsupported operation');
 ensure(input.source&&['human','checks','unverified'].includes(input.source.kind)&&nonempty(input.source.actor,256)&&nonempty(input.source.statement)&&Array.isArray(input.source.refs),'explicit source required');
 ensure(!input.occurredAt||Number.isFinite(Date.parse(input.occurredAt)),'invalid occurrence time');
 const admitted=task(root,input.taskId),admission=[...records(root,{after:admitted.acceptedSeq-1,through:admitted.acceptedSeq})][0];
 const evidence=new Evidence(root,admission.runId);
 evidence.db.exec('BEGIN IMMEDIATE');
 try {
  const identity=digest(JSON.stringify(input)),history=readAcceptance(root,input.taskId);
  const repeated=history.find(f=>f.data.id===input.id);
  if(repeated){ensure(repeated.data.requestIdentity===identity,'ID conflicts with retained input');evidence.db.exec('COMMIT');return{source:repeated.ref.id,repeated:true};}
  const byId=new Map(history.map(f=>[f.data.id,f]));
  const referenceIds=[...input.source.refs];
  const get=(id:string,type:AcceptanceInput['type'])=>{const fact=byId.get(id);ensure(fact?.data.type===type,`${type} reference missing`);return fact;};
  if(input.type==='requirements') {
   ensure(nonempty(input.ruleVersion,256)&&Array.isArray(input.necessary)&&input.necessary.length>0&&input.necessary.length<=100,'nonempty necessary requirements required');
   ensure(new Set(input.necessary.map(r=>r.id)).size===input.necessary.length,'duplicate requirement');
   for(const r of input.necessary){ensure(nonempty(r.id,128)&&nonempty(r.description),'requirement identity and content');if(r.check)ensure(nonempty(r.check.command,32768)&&Array.isArray(r.check.passExitCodes)&&r.check.passExitCodes.length>0&&Array.isArray(r.check.failExitCodes)&&[...r.check.passExitCodes,...r.check.failExitCodes].every(n=>Number.isInteger(n)&&n>=0&&n<256)&&!r.check.passExitCodes.some(n=>r.check!.failExitCodes.includes(n)),'fixed check exit rules required');}
   if(input.revisionOf){get(input.revisionOf,'requirements');ensure(nonempty(input.reason),'revision reason required');}
   else ensure(!history.some(f=>f.data.type==='requirements'),'new requirements must explicitly revise the prior requirements');
  }else if(input.type==='result') {
   get(input.requirementsId,'requirements');ensure(Array.isArray(input.evidence)&&input.evidence.length>0,'immutable result evidence required');referenceIds.push(...input.evidence);
   if(input.revisionOf){get(input.revisionOf,'result');ensure(nonempty(input.reason),'result revision reason required');}
   else ensure(!history.some(f=>f.data.type==='result'),'new result must explicitly revise the prior result');
  }else if(input.type==='judgment') {
   const requirements=get(input.requirementsId,'requirements').data as Extract<AcceptanceInput,{type:'requirements'}>;
   const result=get(input.resultId,'result').data as Extract<AcceptanceInput,{type:'result'}>;
   ensure(result.requirementsId===input.requirementsId,'result and rule scope differ');
   ensure(['valid','faulty','contaminated','insufficient'].includes(input.validity)&&Array.isArray(input.findings)&&input.findings.length<=100,'validity and findings required');
   ensure(new Set(input.findings.map(f=>f.requirementId)).size===input.findings.length,'duplicate finding');
   for(const f of input.findings){ensure(requirements.necessary.some(r=>r.id===f.requirementId)&&['PASS','FAIL','unknown'].includes(f.outcome)&&Array.isArray(f.evidence),'finding scope invalid');referenceIds.push(...f.evidence);}
   for(const id of input.supersedes??[]){const old=get(id,'judgment').data as Extract<AcceptanceInput,{type:'judgment'}>;ensure(old.resultId===input.resultId&&old.requirementsId===input.requirementsId,'judgment revision changed result/rule');ensure(nonempty(input.reason),'revision reason required');}
  }else {ensure(Array.isArray(input.targets)&&input.targets.length>0&&nonempty(input.reason),'withdrawal/dispute requires targets and reason');for(const id of input.targets)ensure(byId.has(id)&&['requirements','result','judgment'].includes(byId.get(id)!.data.type),'target missing or not withdrawable');}
  ensure(referenceIds.length<=500&&referenceIds.every(id=>typeof id==='string'),'evidence scope too large/invalid');
  for(const id of referenceIds)decode(root,resolveEvidence(root,id));
  const clock=factClock();
  if(input.type==='judgment'||input.type==='result')ensure(!input.occurredAt||Date.parse(input.occurredAt)>=Date.parse(admitted.acceptedAt),'result/judgment predates the task admission');
  ensure(!input.occurredAt||Date.parse(input.occurredAt)<=Date.parse(clock.wallTime),'future judgment occurrence is not evidence');
  const {assessment:_ignoredAssessment,...validatedInput}=input as AcceptanceInput&{assessment?:unknown};
  const data={...validatedInput,submitted:input,requestIdentity:identity,occurredAt:input.occurredAt??clock.wallTime,receivedAt:clock.wallTime,clock,timeSource:input.occurredAt?'reported-occurrence' as const:'host-receipt' as const};
  let stored:typeof data&{assessment?:AcceptanceFact['data']['assessment']}=data;
  if(input.type==='judgment'){
   const prospective={ref:{id:'uncommitted',runId:admission.runId,seq:0,kind:'acceptance.judgment',at:clock.wallTime,ref:{sha256:'',bytes:0}},data} as AcceptanceFact;
   const assessed=assess(root,prospective,get(input.requirementsId,'requirements'),get(input.resultId,'result'),admitted.runId??admission.runId,watermark(root),true);
   stored={...data,assessment:{method:'necessary-requirements-v1/fixed-shell-exit-v1',ruleVersion:(get(input.requirementsId,'requirements').data as Extract<AcceptanceInput,{type:'requirements'}>).ruleVersion,requirementsSource:get(input.requirementsId,'requirements').ref.id,resultSource:get(input.resultId,'result').ref.id,basisThrough:watermark(root),sourceRefs:[...new Set([...input.source.refs,...input.findings.flatMap(f=>f.evidence)])],outcome:assessed.outcome,findings:assessed.findings,reasons:assessed.reasons,reliableFailures:assessed.reliableFailures}};
  }
  const seq=evidence.append(`acceptance.${input.type}`,stored);evidence.db.exec('COMMIT');
  return{source:[...records(root,{after:seq-1,through:seq})][0].id,repeated:false};
 }catch(error){evidence.db.exec('ROLLBACK');throw error;}finally{evidence.close();}
}

export interface Assessed {id:string;source:string;outcome:Verdict;reasons:string[];reliableFailures:string[];occurredAt:string;receivedAt:string;clock:FactClock|null;findings:{requirementId:string;outcome:Verdict;evidence:string[];reason:string|null}[]}
function available(root:string,id:string,through:number) {
 try {const ref=resolveEvidence(root,id);if(ref.seq>through)return null;decode(root,ref);return ref;}catch{return null;}
}
function assess(root:string,fact:AcceptanceFact,requirements:AcceptanceFact,result:AcceptanceFact,runId:string|null,through:number,evaluateChecks=false):Assessed {
 const judgment=fact.data as AcceptanceFact['data']&Extract<AcceptanceInput,{type:'judgment'}>,rule=requirements.data as AcceptanceFact['data']&Extract<AcceptanceInput,{type:'requirements'}>,product=result.data as AcceptanceFact['data']&Extract<AcceptanceInput,{type:'result'}>;
 const findings:Assessed['findings']=[],reasons:string[]=[];
 const sourceValid=judgment.source.kind==='human'||judgment.source.kind==='checks';
 for(const finding of judgment.findings) {
  const supported=judgment.assessment?.method==='necessary-requirements-v1/fixed-shell-exit-v1';
  const retained=(supported?judgment.assessment:undefined)?.findings.find(f=>f.requirementId===finding.requirementId);
  let outcome=retained?.outcome??finding.outcome,reason:string|null=retained?.reason??null;
  const requirement=rule.necessary.find(r=>r.id===finding.requirementId)!;
  if(judgment.assessment&&!supported&&!evaluateChecks){outcome='unknown';reason='unsupported retained assessment method';}
  else if(judgment.validity!=='valid'||!sourceValid){outcome='unknown';reason=judgment.validity==='valid'?'unverified source':judgment.validity;}
  else if(!finding.evidence.length||finding.evidence.some(id=>!available(root,id,through))||judgment.source.refs.some(id=>!available(root,id,through))){outcome='unknown';reason='missing judgment evidence';}
  else if(judgment.source.kind==='checks'&&!evaluateChecks) {
   if(!retained){outcome='unknown';reason='actual-check judgment has no retained assessment; explicit grading required';}
  }
  else if(judgment.source.kind==='checks') {
   outcome='unknown';reason='no sufficient bound actual check';
   // A check must follow the fixed rule, run in this task, and be one of the
   // selected result's immutable evidence records. Arbitrary exit status is not a grader.
   for(const id of finding.evidence) {
    const end=available(root,id,through);if(!end||end.kind!=='shell.completed'||end.runId!==runId||!product.evidence.includes(id)||!requirement.check)continue;
    const data=decode(root,end),acquired=data.acquired??data;
    const start=[...records(root,{runId:end.runId,through:end.seq-1,kinds:['shell.started']})].findLast(ref=>{const d=decode(root,ref);return typeof data.toolAttempt?.attemptId==='string'&&d.toolAttempt?.attemptId===data.toolAttempt.attemptId&&d.toolAttempt?.durableTaskId===data.toolAttempt.durableTaskId;});
    if(!start||start.seq<=requirements.ref.seq)continue;
    const started=decode(root,start).acquired??decode(root,start);
    if(started.command!==requirement.check.command||acquired.managedCommand!=='settled'||acquired.completeness!=='complete'||!Number.isInteger(acquired.exitCode))continue;
    if(requirement.check.failExitCodes.includes(acquired.exitCode)){outcome='FAIL';reason=null;break;}
    if(requirement.check.passExitCodes.includes(acquired.exitCode)){outcome='PASS';reason=null;}
   }
  }
  findings.push({...finding,outcome,reason});if(reason)reasons.push(`${finding.requirementId}: ${reason}`);
 }
 const failures=findings.filter(f=>f.outcome==='FAIL').map(f=>f.requirementId);
 const complete=rule.necessary.every(r=>findings.some(f=>f.requirementId===r.id&&f.outcome==='PASS'));
 if(!complete&&!failures.length)reasons.push('necessary requirements incompletely verified');
 return{id:judgment.id,source:fact.ref.id,outcome:failures.length?'FAIL':complete?'PASS':'unknown',reasons,reliableFailures:failures,occurredAt:judgment.occurredAt,receivedAt:judgment.receivedAt,clock:judgment.timeSource==='host-receipt'?judgment.clock:null,findings};
}

/** Recompute from retained revisions; never select a favorable judgment. */
export function selectAcceptance(root:string,taskId:string,runId:string|null,through:number,asOf:string) {
 const history=readAcceptance(root,taskId,through).filter(f=>Date.parse(f.data.receivedAt)<=Date.parse(asOf)&&Date.parse(f.data.occurredAt)<=Date.parse(asOf));
 const withdrawn=new Set<string>(),disputed=new Set<string>();
 for(const f of history){if(f.data.type==='withdraw')for(const id of f.data.targets)withdrawn.add(id);if(f.data.type==='dispute')for(const id of f.data.targets)disputed.add(id);}
 const active=history.filter(f=>!withdrawn.has(f.data.id));
 const terminal=(type:'requirements'|'result')=>{const facts=active.filter(f=>f.data.type===type);const replaced=new Set(history.filter(f=>f.data.type===type).flatMap(f=>'revisionOf'in f.data&&f.data.revisionOf?[f.data.revisionOf]:[]));return facts.filter(f=>!replaced.has(f.data.id));};
 const rules=terminal('requirements'),results=terminal('result'),reasons:string[]=[];
 const historyView=history.map(f=>({id:f.data.id,type:f.data.type,source:f.ref.id,occurredAt:f.data.occurredAt,receivedAt:f.data.receivedAt,withdrawn:withdrawn.has(f.data.id),disputed:disputed.has(f.data.id),revisionOf:'revisionOf'in f.data?f.data.revisionOf??null:null,supersedes:'supersedes'in f.data?f.data.supersedes??[]:[],reason:f.data.reason??null}));
 const base={history:historyView,requirements:rules.map(f=>({id:f.data.id,source:f.ref.id,ruleVersion:(f.data as any).ruleVersion})),results:results.map(f=>({id:f.data.id,source:f.ref.id,evidence:(f.data as any).evidence})),judgments:[] as Assessed[],firstValid:null as Assessed|null,conflict:false,requirementsChanged:history.some(f=>f.data.type==='requirements'&&!!f.data.revisionOf),outcome:'unknown' as Verdict,reasons};
 if(rules.length!==1||results.length!==1){reasons.push(rules.length>1||results.length>1?'unresolved requirement/result revision branches':'missing or withdrawn requirements/final result');return base;}
 const rule=rules[0],result=results[0];
 if((result.data as any).requirementsId!==rule.data.id){reasons.push('final result belongs to replaced requirements; incomparable');return base;}
 if(disputed.has(rule.data.id)||disputed.has(result.data.id)||rule.data.source.kind==='unverified'||result.data.source.kind==='unverified'){reasons.push('requirement/result validity disputed');return base;}
 const product=result.data as Extract<AcceptanceInput,{type:'result'}>;
 if(product.evidence.some(id=>!available(root,id,through))){reasons.push('final result evidence unavailable');return base;}
 const judgments=active.filter(f=>f.data.type==='judgment'&&(f.data as any).requirementsId===rule.data.id&&(f.data as any).resultId===result.data.id);
 const superseded=new Set(history.filter(f=>f.data.type==='judgment').flatMap(f=>(f.data as Extract<AcceptanceInput,{type:'judgment'}>).supersedes??[]));
 base.judgments=judgments.map(f=>assess(root,f,rule,result,runId,through));
 const current=base.judgments.filter(j=>!superseded.has(j.id));
 const determinate=current.filter(j=>j.outcome!=='unknown');
 base.conflict=new Set(determinate.map(j=>j.outcome)).size>1;
 if(current.some(j=>disputed.has(j.id))){reasons.push('judgment evidence/fact validity disputed; observed failures retained');return base;}
 const failures=determinate.filter(j=>j.outcome==='FAIL');
 base.outcome=failures.length?'FAIL':determinate.length?'PASS':'unknown';
 if(base.outcome==='unknown')reasons.push(...new Set(current.flatMap(j=>j.reasons)),current.length?'no valid determinate judgment':'pending acceptance');
 if(base.conflict)reasons.push('conflicting determinate judgments; reliable necessary failure retained');
 // Earliest still-valid determinate judgment of the selected product/rule, not
 // the first eventual PASS. Revisions/withdrawals may remove its current validity.
 base.firstValid=determinate.toSorted((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||Number(a.source.split(':')[1])-Number(b.source.split(':')[1]))[0]??null;
 return base;
}
