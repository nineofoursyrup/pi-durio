import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Evidence,readObject,openHostReadonly,type BlobRef} from '../evidence.js';
import {acquireOwner} from '../ownership.js';
import {fixEvidence,verifyFixed} from '../fixed-evidence.js';
import {PersistentBudget} from '../provider-boundary.js';
import {scriptedTransport} from '../offline.js';
import {loadEvalPlan,runtimeContent,type EvalPlan,type EvalTrial} from './plan.js';
import {evalFacts,appendFact,materialize,regularFiles,captureFiles,type ContentFile} from './store.js';
import {controlledSteps,type EvalCase} from './fixtures.js';
import {evalMediator} from './mediator.js';
import {prepareProbe} from './probes.js';
// Fixed single isolation implementation, also shipped with the installed artifact.
const boundaryPath=new URL('../../execution/isolation/boundary.mjs',import.meta.url);
interface RestrictedResult {id:string;status:string;started:boolean;terminated:boolean;reason:string|null;stdout:string;stderr:string;code?:number;control:any[];modelRequests:any[]}
interface Boundary {runRestricted:(options:any)=>Promise<RestrictedResult>;exportStopped:(execution:RestrictedResult,names:string[],destination:string,limits?:{maxFiles:number;maxBytes:number})=>Promise<{name:string;bytes:number;sha256:string}[]>}
const boundary=()=>import(boundaryPath.href) as Promise<Boundary>;
const protocolLimits={inputBytes:262144,responseBytes:1048576,lineBytes:1048576,totalBytes:8388608};
const exportLimits={maxFiles:20000,maxBytes:134217728};
export type TrialStatus='completed'|'preparation-error'|'error'|'timeout'|'cancelled'|'budget-stopped'|'service-error'|'original-error'|'invalid'|'not-run'|'unknown';
export interface TrialOutcome {trialId:string;status:TrialStatus;started:boolean;valid:boolean;reason:string|null;runtimeResult:BlobRef|null;artifacts:ContentFile[];isolation:BlobRef|null;timing:{preparationMs:number;taskMs:number;gradingMs:number};source?:string}
export interface Grade {id:string;trialId:string;outcome:string;graderVersion:string;judgment:'PASS'|'FAIL'|'unknown';reason:string;checks:{name:string;passed:boolean}[];execution:BlobRef|null;at:string;source?:string}
function planFix(root:string,id:string){const db=openHostReadonly(root);try{for(const row of db.prepare("SELECT seq,body FROM records WHERE run_id=? AND kind='evidence.fixed'").iterate(id)){const ref=JSON.parse(String(row.body)),fact=JSON.parse(readObject(root,ref).toString());if(fact.id===`eval-plan:${id}`){const result=verifyFixed(root,`e1:${row.seq}:${ref.sha256}`);if(result.state!=='protected')throw Error('EVAL_PLAN_CONTENT_UNAVAILABLE');return;}}throw Error('EVAL_PLAN_NOT_FIXED');}finally{db.close();}}
function verifyBoundaryContent(root:string,plan:EvalPlan){if(!plan.environment.hostFiles?.length)throw Error('EVAL_HOST_CONTENT_MISSING');for(const file of plan.environment.hostFiles){if(file.path.split('/').some(part=>part==='..')||!readFileSync(new URL('../'+file.path,import.meta.url)).equals(readObject(root,file.ref)))throw Error('EVAL_HOST_CONTENT_CHANGED');}if(!plan.environment.boundaryFiles?.length)throw Error('EVAL_BOUNDARY_CONTENT_MISSING');for(const file of plan.environment.boundaryFiles){if(!['boundary.mjs','export.mjs','restrict.py'].includes(file.path)||!readFileSync(new URL('../../execution/isolation/'+file.path,import.meta.url)).equals(readObject(root,file.ref)))throw Error('EVAL_BOUNDARY_CONTENT_CHANGED');}}
function outcomeProtection(root:string,id:string,through:number){if(!through)return 'no-outcomes';const db=openHostReadonly(root);let failure='not-fixed';try{for(const row of db.prepare("SELECT seq,body FROM records WHERE run_id=? AND kind='evidence.fixed' ORDER BY seq DESC").iterate(id)){const ref=JSON.parse(String(row.body)),fact=JSON.parse(readObject(root,ref).toString());if(fact.snapshot<through)continue;const result=verifyFixed(root,`e1:${row.seq}:${ref.sha256}`);if(result.state==='protected')return 'protected';failure=result.state;}return failure;}finally{db.close();}}
function snapshot(e:Evidence,budget:PersistentBudget,trialId:string){const result=budget.snapshot();e.append('eval.budget-snapshot',{trialId,...result});return result;}
function classify(result:RestrictedResult,error:string|null,guest:any):TrialStatus{
 if(result.status==='invalid'||!result.terminated)return 'invalid';if(result.reason==='cancelled')return'cancelled';if(error?.includes('BUDGET_'))return'budget-stopped';if(result.reason==='timeout')return'timeout';if(error)return'service-error';if(guest?.reason?.includes('CONTROLLED_ORIGINAL_WRITE_FAILURE'))return'original-error';return result.code===0&&guest?.status==='completed'?'completed':'error';
}
function initial(fixture:EvalCase):Record<string,string>{return {...fixture.files,...fixture.dirty,'package-lock.json':fixture.dependencyLock};}
function controlled(plan:EvalPlan,trial:EvalTrial){
 if(plan.mode!=='offline')return undefined;
 const steps=trial.scenario==='necessary-fail'?[]:controlledSteps(trial.caseId);
 if(trial.scenario==='boundary')steps.unshift({name:'bash',args:{command:'node /input/runtime-probe.mjs'}});
 if(trial.scenario==='export-link')steps.splice(0,steps.length,{name:'bash',args:{command:'rm math.ts && ln -s /etc/passwd math.ts'}});
 if(trial.scenario==='timeout')steps.splice(0,steps.length,{name:'bash',args:{command:'sleep 30'}});
 const script=scriptedTransport(steps),summary=scriptedTransport([]);
 return (async(url,init)=>{
  if(trial.scenario==='service-error')return new Response(JSON.stringify({error:{message:'Controlled provider outage',type:'server_error'}}),{status:503,headers:{'content-type':'application/json'}});
  const payload=JSON.parse(String(init?.body));
  const response=trial.scenario==='auto-compaction'&&!payload.tools?.length?await summary.fetch(url,init):await script.fetch(url,init);
  if(trial.scenario==='unknown-usage'){const body=(await response.text()).replace(/^data: .*"usage".*\n/gm,'');return new Response(body,{headers:response.headers});}
  if(trial.caseId==='no-change'){const body=(await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',JSON.stringify({operator:'subtraction',examples:[3,-5],changeNeeded:false}).replaceAll('\"','\\\"'));return new Response(body,{headers:response.headers});}
  return response;
 })as typeof fetch;
}
export interface RunEvalOptions {dataRoot:string;id:string;directory:string;signal?:AbortSignal;transportForTrial?:(trial:EvalTrial)=>typeof fetch|undefined;fault?:(kind:string)=>void}
/** No runtime, task, or outcome is resumed. Reopening an interrupted plan is report-only. */
export async function runEval(options:RunEvalOptions){
 const preparationAt=performance.now();
 const plan=loadEvalPlan(options.dataRoot,options.id);planFix(options.dataRoot,plan.id);
 verifyBoundaryContent(options.dataRoot,plan);
 if(plan.mode==='live'&&!process.env.DEEPSEEK_API_KEY?.trim())throw Error('AUTH_MISSING');
 if(plan.mode==='live'&&options.transportForTrial)throw Error('LIVE_TRANSPORT_OVERRIDE_DENIED');
 if(evalFacts(options.dataRoot,plan.id).some(f=>f.kind==='eval.started'))throw Error('EVAL_ALREADY_STARTED: inspect preserved facts; a supplementary run requires a new plan/trial identity');
 await mkdir(options.directory,{recursive:false,mode:0o700});
 const abort=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal;
 const owner=await acquireOwner(options.dataRoot,error=>abort.abort(error));let evidence:Evidence|undefined,finalSource:string|undefined;
 try{
  owner.assertHeld();evidence=new Evidence(options.dataRoot,plan.id,kind=>{owner.assertHeld();options.fault?.(kind);});const e=evidence;
  if(evalFacts(options.dataRoot,plan.id).some(f=>f.kind==='eval.started'))throw Error('EVAL_ALREADY_STARTED');
  appendFact(e,'eval.started',{planId:plan.id,directory:options.directory,at:new Date().toISOString()});
  const budget=new PersistentBudget(e,plan.id,plan.budget),engine=await boundary();
  const deps=join(options.directory,'dependencies');materialize(options.dataRoot,runtimeContent(options.dataRoot,plan),deps);
  appendFact(e,'eval.preparation',{phase:'fixed plan verification and dependency staging',elapsedMs:performance.now()-preparationAt});
  let stopReason:string|null=null;
  for(const trial of plan.trials){
   owner.assertHeld();const fixture=plan.cases.find(c=>c.id===trial.caseId)!;
   const preparedAt=performance.now(),outcome:TrialOutcome={trialId:trial.id,status:'not-run',started:false,valid:false,reason:null,runtimeResult:null,artifacts:[],isolation:null,timing:{preparationMs:0,taskMs:0,gradingMs:0}};
   if(signal.aborted)stopReason??='cancelled';
   if(!stopReason){try{budget.check();}catch(error){stopReason=String(error);}}
   if(stopReason){outcome.reason=stopReason;appendFact(e,'eval.outcome',outcome);continue;}
   const inputDir=join(options.directory,`${trial.id}-input`);await mkdir(inputDir);
   const guest={trialId:trial.id,mode:plan.mode,prompt:fixture.input,files:{...fixture.files,'package-lock.json':fixture.dependencyLock},dirty:fixture.dirty,maxOutputTokens:plan.maxOutputTokens,...(trial.scenario==='original-error'?{originalFailure:true}:{}),...(trial.scenario==='auto-compaction'?{verificationCompaction:{reserveTokens:999999,keepRecentTokens:1}}:{})};
   await writeFile(join(inputDir,'trial.json'),JSON.stringify(guest));
   const probe=trial.scenario==='boundary'?await prepareProbe(inputDir):undefined;
   const mediator=evalMediator(plan,trial,budget,options.transportForTrial?.(trial)??controlled(plan,trial),()=>owner.assertHeld());
   const runDir=join(options.directory,`${trial.id}-execution`);
   appendFact(e,'eval.trial-started',{trialId:trial.id,at:new Date().toISOString(),input:e.blob(JSON.stringify(guest))});
   outcome.started=true;outcome.timing.preparationMs=performance.now()-preparedAt;
   const taskAt=performance.now();let execution:RestrictedResult|undefined;
   try{
    execution=await engine.runRestricted({image:plan.image,inputDir,runDir,dependenciesDir:deps,command:['node','/deps/dist/src/eval/guest.js'],timeoutMs:Math.max(100,Math.min(plan.trialTimeoutMs,Date.parse(plan.budget.deadline)-Date.now())),model:mediator,signal,protocolLimits});
    owner.assertHeld();outcome.started=execution.started;outcome.timing.taskMs=performance.now()-taskAt;outcome.isolation=e.blob(JSON.stringify(execution));
    if(probe&&execution.terminated){const verification=await probe.verify(join(runDir,'work'),e);appendFact(e,'eval.boundary-check',{trialId:trial.id,...verification});if(!verification.valid){execution.status='invalid';execution.reason='actual_boundary_probe_failed';}}
    if(execution.terminated&&execution.status!=='invalid'){
     const work=join(runDir,'work'),names:string[]=[];
     // These are the fixed export scopes; filenames are inspected by the trusted host after VM teardown.
     for(const prefix of ['project','data'])if(existsSync(join(work,prefix)))names.push(...regularFiles(join(work,prefix)).map(name=>`${prefix}/${name}`));
     for(const path of ['product-result.json','product-error.json','probes.json','descendant.json','heartbeat.txt'])if(existsSync(join(work,path)))names.push(path);
     const exported=join(options.directory,`${trial.id}-export`);await engine.exportStopped(execution,names,exported,exportLimits);
     const retained=captureFiles(e,exported,names);outcome.artifacts=retained.files;
     const result=retained.files.find(f=>f.path==='product-result.json');outcome.runtimeResult=result?.ref??null;
     const guestResult=result?JSON.parse(readObject(options.dataRoot,result.ref).toString()):null;
     const boundaryError=mediator.lastError??(execution.reason==='timeout'&&Date.now()>=Date.parse(plan.budget.deadline)?'BUDGET_DEADLINE':null);
     outcome.status=classify(execution,boundaryError,guestResult);if(boundaryError)outcome.reason=boundaryError;outcome.valid=outcome.status!=='original-error';
     if(!guestResult&&(retained.files.some(f=>f.path==='product-error.json')||!retained.files.some(f=>f.path==='data/host.sqlite'))){outcome.status='preparation-error';outcome.valid=false;outcome.reason='Product failed before returning an accepted runtime result; infrastructure excluded from formal evaluation';}
    }else{outcome.status='invalid';outcome.reason=execution.reason;}
    outcome.reason??=mediator.lastError??execution.reason;
   }catch(error){outcome.status=execution?.terminated?'original-error':'invalid';outcome.reason=String(error);outcome.timing.taskMs=performance.now()-taskAt;outcome.valid=false;}finally{await probe?.close();}
   const outcomeSource=appendFact(e,'eval.outcome',outcome);
   snapshot(e,budget,trial.id);
   if(outcome.status==='invalid'||outcome.status==='original-error'||outcome.status==='preparation-error')stopReason=outcome.reason??outcome.status;
   if(outcome.status==='budget-stopped'||outcome.status==='cancelled')stopReason=outcome.reason??outcome.status;
   if(outcome.valid){const gradeAt=performance.now();const grade=await gradeOutcome(e,plan,trial,fixture,{...outcome,source:outcomeSource},engine,options.directory,signal,plan.budget.deadline);outcome.timing.gradingMs=performance.now()-gradeAt;appendFact(e,'eval.grade',grade);appendFact(e,'eval.timing',{trialId:trial.id,gradingMs:outcome.timing.gradingMs});if(grade.reason.startsWith('isolation:'))stopReason=grade.reason;}
  }
  finalSource=appendFact(e,'eval.closed',{at:new Date().toISOString(),budget:budget.snapshot(),stopReason});
 }finally{evidence?.close();await owner.release();}
 if(finalSource)await fixEvidence(options.dataRoot,{id:`eval-outcomes:${plan.id}`,sources:[finalSource],purpose:'retain every trial outcome, provider original, grade and dependency; no outcome overwrite'});
 return evalReport(options.dataRoot,plan.id);
}
async function gradeOutcome(e:Evidence,plan:EvalPlan,trial:EvalTrial,fixture:EvalCase,outcome:TrialOutcome,engine:Boundary,directory:string,signal?:AbortSignal,deadline?:string):Promise<Grade>{
 let gradingProbe:Awaited<ReturnType<typeof prepareProbe>>|undefined;
 const grade:Grade={id:randomUUID(),trialId:trial.id,outcome:outcome.source!,graderVersion:fixture.grader.version,judgment:'unknown',reason:'not graded',checks:[],execution:null,at:new Date().toISOString()};
 try{
  const remaining=deadline?Date.parse(deadline)-Date.now():plan.gradingTimeoutMs;
  if(remaining<100){grade.reason='budget deadline before grading; no deterministic judgment';return grade;}
  // Read verified fixed bytes only. Candidate result strings have no grading authority.
  const actual=new Map(outcome.artifacts.filter(f=>f.path.startsWith('project/')&&!f.path.startsWith('project/.git/')).map(f=>[f.path.slice(8),readObject(e.root,f.ref)]));
  const before=initial(fixture),scopeOkay=[...new Set([...Object.keys(before),...actual.keys()])].every(path=>fixture.writable.includes(path)||actual.get(path)?.equals(Buffer.from(before[path]??''))===true);
  grade.checks.push({name:'declared writable scope and dirty inputs preserved',passed:scopeOkay});
  if(!scopeOkay){grade.judgment='FAIL';grade.reason='Necessary scope requirement failed';return grade;}
  if(trial.scenario==='grader-crash')throw Error('CONTROLLED_GRADER_CRASH');
  const input=join(directory,`${trial.id}-grade-${grade.id}`);await mkdir(input);await mkdir(join(input,'project'));
  for(const [path,bytes]of actual){await mkdir(dirname(join(input,'project',path)),{recursive:true});await writeFile(join(input,'project',path),bytes);}
  if(outcome.runtimeResult)await writeFile(join(input,'product-result.json'),readObject(e.root,outcome.runtimeResult));
  gradingProbe=trial.scenario==='boundary'?await prepareProbe(input,false):undefined;
  await writeFile(join(input,'check.mjs'),(gradingProbe?"import '/input/runtime-probe.mjs';\n":'')+fixture.grader.program);
  const execution=await engine.runRestricted({image:plan.image,inputDir:input,runDir:join(directory,`${trial.id}-grading-${grade.id}`),command:['node','/input/check.mjs'],timeoutMs:Math.min(plan.gradingTimeoutMs,Math.floor(remaining)),signal});
  grade.execution=e.blob(JSON.stringify(execution));
  let checkOutput=execution.stdout;
  if(gradingProbe){if(!execution.terminated)throw Error('grading termination unknown');const verification=await gradingProbe.verify(join(directory,`${trial.id}-grading-${grade.id}`,'work'),e);appendFact(e,'eval.grading-boundary-check',{trialId:trial.id,...verification});if(!verification.valid){grade.reason='isolation: grading boundary invalid';return grade;}checkOutput=checkOutput.split('\n').slice(1).join('\n');}
  if(!execution.terminated||execution.status==='invalid'){grade.reason=`isolation: ${execution.reason}`;return grade;}
  if(execution.reason==='timeout'||execution.reason==='cancelled'){grade.reason=`grader ${execution.reason}; no deterministic judgment`;return grade;}
  if(execution.code!==0){grade.reason='grader execution failed; no deterministic judgment';return grade;}
  const passed=execution.code===0&&checkOutput===fixture.grader.expectedStdout;
  grade.checks.push({name:'fixed independent Node checks',passed});grade.judgment=passed?(outcome.status==='completed'?'PASS':'unknown'):'FAIL';grade.reason=passed?(outcome.status==='completed'?'All fixed necessary requirements verified':'Artifact checks pass but task result is incomplete; cannot assert PASS'):'Fixed necessary Node check failed';
 }catch(error){grade.reason=String(error);}finally{await gradingProbe?.close();}
 return grade;
}
export function evalReport(root:string,id:string){
 const plan=loadEvalPlan(root,id),facts=evalFacts(root,id);
 const outcomeAvailability=outcomeProtection(root,id,Math.max(0,...facts.filter(f=>['eval.outcome','eval.grade','eval.applicability'].includes(f.kind)).map(f=>f.seq)));
 let planAvailability='protected';try{planFix(root,id);}catch(error){planAvailability=String(error);}
 const trials=plan.trials.map(trial=>{
  const saved=facts.find(f=>f.kind==='eval.outcome'&&f.data.trialId===trial.id);
  const applicability=facts.findLast(f=>f.kind==='eval.applicability'&&f.data.trialId===trial.id);
  const outcome:any=saved?{...saved.data,source:saved.source}:{trialId:trial.id,status:facts.some(f=>f.kind==='eval.trial-started'&&f.data.trialId===trial.id)?'unknown':'not-run',started:facts.some(f=>f.kind==='eval.trial-started'&&f.data.trialId===trial.id),valid:false,reason:'No final outcome acquired; never restart this identity automatically'};
  if(applicability){outcome.valid=applicability.data.valid;outcome.applicability={...applicability.data,source:applicability.source};}
  if(planAvailability!=='protected'||outcomeAvailability!=='protected'){outcome.valid=false;outcome.evidenceAvailability=planAvailability!=='protected'?planAvailability:outcomeAvailability;}
  if(saved)try{for(const file of saved.data.artifacts??[])readObject(root,file.ref);if(saved.data.isolation)readObject(root,saved.data.isolation);}catch(error){outcome.valid=false;outcome.evidenceAvailability=String(error);}
  const grades=facts.filter(f=>f.kind==='eval.grade'&&f.data.trialId===trial.id),grade=grades.at(-1);
  const timing=facts.findLast(f=>f.kind==='eval.timing'&&f.data.trialId===trial.id);
  return {...trial,outcome,grade:grade?{...grade.data,source:grade.source}:null,gradingMs:timing?.data.gradingMs??null,gradeHistory:grades.map(f=>({source:f.source,...f.data}))};
 });
 const count=(items:typeof trials)=>{const N=items.length,B=items.filter(t=>t.outcome.started).length,C=items.filter(t=>t.outcome.status==='completed').length,G=items.filter(t=>t.outcome.valid&&['PASS','FAIL'].includes(t.grade?.judgment)).length,S=items.filter(t=>t.outcome.valid&&t.grade?.judgment==='PASS').length;return{planned:N,started:B,completed:C,gradable:G,passed:S,passRate:G?S/G:null,completionRate:N?C/N:null,coverageRate:N?G/N:null};};
 const db=openHostReadonly(root);let requests:any[]=[];
 try{
  const budgetFacts=db.prepare("SELECT kind,body FROM records WHERE run_id=? AND kind IN ('budget.reserve','budget.settle') ORDER BY seq").all(id).map(row=>({kind:String(row.kind),...JSON.parse(readObject(root,JSON.parse(String(row.body))).toString())}));
  requests=budgetFacts.filter(f=>f.kind==='budget.reserve').map(reservation=>{const settled=budgetFacts.find(f=>f.kind==='budget.settle'&&f.id===reservation.id);return{...reservation,settled:settled??null};});
 }finally{db.close();}
 const costs=(items:typeof requests)=>{const knownTokens=items.reduce((sum,request)=>sum+(request.settled?.tokens??0),0),missing=items.filter(request=>request.settled?.tokens===null||request.settled?.tokens===undefined).length;return{requests:items.length,knownTokens,knownValue:knownTokens*plan.price.perMillionTokens/1e6,missing,completeness:missing?(knownTokens?'partial':'unknown'):'known'};};
 const all=costs(requests),sides=[...new Set(trials.map(t=>t.side))];
 return{planId:id,purpose:plan.purpose,mode:plan.mode,scope:'Only these public cases, fixed execution version and restricted environment; no model quality or improvement claim for offline transport',counts:count(trials),sides:Object.fromEntries(sides.map(side=>[side,count(trials.filter(t=>t.side===side))])),trials,budget:{...all,deadline:plan.budget.deadline,limits:plan.budget},cost:{kind:'estimate',price:plan.price,...all,bySide:Object.fromEntries(sides.map(side=>[side,costs(requests.filter(request=>trials.find(t=>t.id===request.operationId)?.side===side))])),failed:costs(requests.filter(request=>{const trial=trials.find(t=>t.id===request.operationId);return trial?.outcome.status!=='completed'||trial?.grade?.judgment==='FAIL';})),scope:'all plan sides, failed/cancelled requests, SDK retries and automatic compaction; deterministic grading makes no provider requests'},timing:{preparationMs:facts.filter(f=>f.kind==='eval.preparation').reduce((n,f)=>n+f.data.elapsedMs,0)+trials.reduce((n,t)=>n+(t.outcome.timing?.preparationMs??0),0),taskMs:trials.reduce((n,t)=>n+(t.outcome.timing?.taskMs??0),0),gradingMs:trials.reduce((n,t)=>n+(t.gradingMs??0),0),clock:'host monotonic elapsed per stage; plan absolute deadline persists across restarts',externalSetup:'explicit image/Linux dependency preparation is separately logged and excluded from eval execution time'},improvement:'not-evaluated',planSource:facts.find(f=>f.kind==='eval.plan')!.source,planAvailability,outcomeAvailability};
}
export function formatEvalReport(report:ReturnType<typeof evalReport>){return [`Eval ${report.planId} · ${report.mode}`,report.scope,`固定证据：plan ${report.planAvailability} / outcomes ${report.outcomeAvailability}`,`计划 ${report.counts.planned} / 启动 ${report.counts.started} / 完成 ${report.counts.completed} / 可评分 ${report.counts.gradable} / 通过 ${report.counts.passed}`,`通过率 ${report.counts.passRate??'N/A'} · 完成率 ${report.counts.completionRate??'N/A'} · 覆盖率 ${report.counts.coverageRate??'N/A'}`,...report.trials.map(t=>`${t.id} ${t.side} ${t.caseId}: ${t.outcome.status}, ${t.grade?.judgment??'ungraded'}${t.outcome.valid?'':' [正式评分排除: '+(t.outcome.evidenceAvailability??t.outcome.status)+']'} · ${t.outcome.reason??t.grade?.reason??''}`),`费用 ${JSON.stringify(report.cost)}`,`时间 ${JSON.stringify(report.timing)}`].join('\n');}

/** Explicit append-only rescoring; a new grader never rewrites an outcome or the first failure. */
export async function regradeEval(options:{dataRoot:string;id:string;directory:string;revisionId:string;graders:Record<string,EvalCase['grader']>}){
 const plan=loadEvalPlan(options.dataRoot,options.id);planFix(options.dataRoot,plan.id);
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(options.revisionId)||!Object.keys(options.graders).length)throw Error('INVALID_GRADER_REVISION');
 const previous=evalFacts(options.dataRoot,plan.id);if(previous.some(f=>f.kind==='eval.grader-revision'&&f.data.id===options.revisionId))throw Error('GRADER_REVISION_EXISTS');
 for(const [caseId,grader]of Object.entries(options.graders))if(!plan.cases.some(c=>c.id===caseId)||!grader.version||!grader.program||!grader.required.length)throw Error('INVALID_GRADER_REVISION');
 await mkdir(options.directory,{recursive:false,mode:0o700});const abort=new AbortController(),owner=await acquireOwner(options.dataRoot,error=>abort.abort(error));let evidence:Evidence|undefined,source:string|undefined;
 try{owner.assertHeld();evidence=new Evidence(options.dataRoot,plan.id,()=>owner.assertHeld());const hostDirectory=fileURLToPath(new URL('../',import.meta.url)),hostFiles=captureFiles(evidence,hostDirectory,regularFiles(hostDirectory)).files;const boundaryFiles=captureFiles(evidence,fileURLToPath(new URL('../../execution/isolation/',import.meta.url)),['boundary.mjs','export.mjs','restrict.py']).files;const revision=appendFact(evidence,'eval.grader-revision',{id:options.revisionId,graders:options.graders,boundaryFiles,hostFiles,at:new Date().toISOString(),scope:'same immutable outcomes; new deterministic grading only'});const engine=await boundary();
  for(const trial of plan.trials){if(!options.graders[trial.caseId])continue;const original=previous.find(f=>f.kind==='eval.outcome'&&f.data.trialId===trial.id);if(!original?.data.valid)continue;const fixture={...plan.cases.find(c=>c.id===trial.caseId)!,grader:options.graders[trial.caseId]};const grade=await gradeOutcome(evidence,plan,{...trial,scenario:undefined},fixture,{...original.data,source:original.source},engine,options.directory,abort.signal);source=appendFact(evidence,'eval.grade',{...grade,revision});if(grade.reason.startsWith('isolation:'))break;}
  source??=revision;
 }finally{evidence?.close();await owner.release();}
 await fixEvidence(options.dataRoot,{id:`eval-grade:${plan.id}:${options.revisionId}`,sources:[source!],purpose:'retain new grader content and additive judgment over unchanged outcomes'});
 return evalReport(options.dataRoot,plan.id);
}
export function listEvalPlans(root:string){const db=openHostReadonly(root);try{return db.prepare("SELECT run_id,at,body FROM records WHERE kind='eval.plan' ORDER BY seq DESC LIMIT 50").all().map(row=>{const plan=JSON.parse(readObject(root,JSON.parse(String(row.body))).toString())as EvalPlan;return{id:String(row.run_id),at:String(row.at),purpose:plan.purpose,mode:plan.mode};});}finally{db.close();}}

export {prepareEval,validatePlan,verifiedImage} from './plan.js';
export type {EvalPlan,EvalTrial,PrepareEvalOptions} from './plan.js';
