import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence,digest} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {submitImproveDecision,readImproveDecision,readImproveDefaults,rollbackImproveDecision} from '../src/improve-decisions.js';
import {runReadTask,readRun,inspectRecovery,recoverRun} from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';
import {profileFromContent} from '../src/task-profile.js';

async function fixture(kind:'project'|'prompt-skill'|'agent-config'='project',files:Record<string,string>={'math.mjs':'export const add=(a,b)=>a-b;\n'}){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'durio-formal-'))),workspace=join(directory,'project'),dataRoot=join(directory,'data');await mkdir(workspace);
 for(const [name,text]of Object.entries(files))await writeFile(join(workspace,name),text);
 const e=new Evidence(dataRoot,'analysis-1'),target=captureImproveSources(e,workspace,[{id:'target',kind,paths:Object.keys(files)}],'fixture-version').targets[0];
 const candidate={id:'candidate:fix',revision:'candidate-r1',display:'R1',title:'Correct deterministic defect',problem:'Wrong operation',problemKey:'operator.defect',objective:'bug',target,facts:[],hypotheses:[],successCounterexamples:[],gaps:[],mechanismsReviewed:Object.keys(files),steps:['Prepare exact corrected bytes','Run regression','Write the selected files'],scope:Object.keys(files),validation:{method:'regression',checks:['fixed expected output'],budget:'one check',protections:['preserve unrelated files']},risks:['local change'],rollback:'Restore retained original bytes only while current content still matches this batch',activation:{writeback:true,enable:kind!=='project',conditions:['all declared regression and protection checks pass'],timing:'subsequent new tasks'},dependencies:[],conflicts:[],suggestionOnly:false};
 const report={id:'report-1',revision:'report-r1',runId:e.runId,target:{workspace,runId:'coding-1',taskId:'task-1',sessionId:'session-1'},candidates:[candidate],selected:[],targets:[target],state:'complete',evidence:[]};e.append('improve.started',{request:{id:report.id},target:report.target});e.append('improve.report',report);e.close();
 const decision:any={id:'execute-1',reportId:report.id,reportRevision:report.revision,selections:[{candidateId:candidate.id,candidateRevision:candidate.revision,target,steps:candidate.steps,mode:'execute-declared-scope',formal:{writeback:true,activate:null,failureCompensation:'none'}}],directory:join(directory,'temporary'),groups:[{id:'fix',candidateIds:[candidate.id],changes:[{targetId:'target',path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],checks:[{kind:'regression',program:"import assert from 'node:assert/strict';const {add}=await import('/work/targets/target/math.mjs');assert.equal(add(2,3),5);assert.equal(add(2,-3),-1);",timeoutMs:30000}]}],limits:{deadline:new Date(Date.now()+120000).toISOString(),maxChecks:1,maxRequests:0,maxTokens:0}};
 return {directory,workspace,dataRoot,candidate,report,decision};
}
test('exact explicit formal decision validates then writes real project bytes; replay and reopen are read-only',async()=>{
 const f=await fixture();const result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});
 assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(result.writeback,'written');assert.equal(result.activation,'not-enabled');
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a+b;\n');
 const before=digest(await readFile(join(f.dataRoot,'host.sqlite')));assert.deepEqual(readImproveDecision(f.dataRoot,f.decision.id),result);assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision}),result);assert.equal(digest(await readFile(join(f.dataRoot,'host.sqlite'))),before);
});
test('postvalidation external edits block formal bytes and remain visible without replay',async()=>{
 const f=await fixture();await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision,fault:kind=>{if(kind==='improve.validation')requireWrite(join(f.workspace,'math.mjs'),'later user edit\n');}}),/BASELINE_DRIFT/);
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'later user edit\n');assert.equal(readImproveDecision(f.dataRoot,f.decision.id).state,'frozen');
});
import {writeFileSync as requireWrite} from 'node:fs';
test('partial multi-file application retains known and unknown facts and fences a new task even in another data root',async()=>{
 const f=await fixture('project',{'math.mjs':'old one','second.mjs':'old two'});f.decision.groups[0].changes=[{targetId:'target',path:'math.mjs',content:'new one'},{targetId:'target',path:'second.mjs',content:'new two'}];f.decision.groups[0].checks[0].program="import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync('/work/targets/target/math.mjs','utf8'),'new one');assert.equal(readFileSync('/work/targets/target/second.mjs','utf8'),'new two');";let writes=0;
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision,fault:kind=>{if(kind==='improve.write-intent'&&++writes===2)throw Error('injected-second-write-record-failure');}}),/injected-second/);
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'new one');assert.equal(await readFile(join(f.workspace,'second.mjs'),'utf8'),'old two');const state=readImproveDecision(f.dataRoot,f.decision.id);assert.equal(state.state,'frozen');assert.equal(state.writeback,'partial-or-unknown');
 const transport=scriptedTransport([]);await assert.rejects(runReadTask({dataRoot:join(f.directory,'other-data'),workspace:f.workspace,input:'Read project',mode:'offline',transport:transport.fetch}),/IMPROVE_RECOVERY_REQUIRED/);assert.equal(transport.calls.length,0);
 const rollback={dataRoot:f.dataRoot,id:f.decision.id,rollbackId:'partial-revert',decisionSource:state.sourceId,groupIds:['fix'],reason:'Explicitly restore this interrupted file batch'};
 const restored=await rollbackImproveDecision(rollback);assert.equal(restored.groups[0].rollback?.state,'completed');assert.equal(restored.groups[0].formal?.state,'frozen','original failure remains');assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'old one');
 assert.deepEqual(await rollbackImproveDecision(rollback),restored);const next=await runReadTask({dataRoot:join(f.directory,'other-data'),workspace:f.workspace,input:'Read after explicit compensation',mode:'offline',transport:transport.fetch});assert.equal(next.status,'completed');
});
test('rollback preserves later user edits and can restore the exact selected bytes on an explicit later decision',async()=>{
 const f=await fixture(),done=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});const rollback={dataRoot:f.dataRoot,id:f.decision.id,rollbackId:'restore-protected',decisionSource:done.sourceId,groupIds:['fix'],reason:'Undo this exact repair'};
 await writeFile(join(f.workspace,'math.mjs'),'export const add=(a,b)=>a+b; // user addition\n');await assert.rejects(rollbackImproveDecision(rollback),/ROLLBACK_USER_EDIT/);assert.match(await readFile(join(f.workspace,'math.mjs'),'utf8'),/user addition/);
 await writeFile(join(f.workspace,'math.mjs'),'export const add=(a,b)=>a+b;\n');const restored=await rollbackImproveDecision({...rollback,rollbackId:'restore-after-user-resolution'});assert.equal(restored.groups[0].rollback?.state,'completed');assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
});
test('functional pass with a predeclared performance no-gain comparison cannot write or enable',async()=>{
 const f=await fixture();f.candidate.objective='performance';const e=new Evidence(f.dataRoot,'analysis-1');e.append('improve.report',f.report);e.close();
 f.decision.groups[0].checks.push({kind:'resource',timeoutMs:30000,program:"console.log(JSON.stringify({baseline:10,candidate:10,protectionsPassed:true}))",resource:{direction:'lower',delta:1,unit:'controlled operation count',basis:'This fixed resource experiment must save at least one operation'}});f.decision.limits.maxChecks=2;
 const result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});assert.equal(result.state,'frozen');assert.equal(result.groups[0].result.conclusion.allChecksPassed,true);assert.equal(result.groups[0].result.conclusion.allDeclaredBenefitsMet,false);assert.equal(result.groups[0].result.effect,'无明显差异');assert.equal(result.writeback,'not-written');assert.equal(result.activation,'not-enabled');assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
});
test('config loader refuses credentials, authority, output limits and conflicting merged settings',()=>{
 const config=(text:string)=>({kind:'agent-config' as const,targetId:'config',path:'agent.json',text});
 for(const input of ['{"tools":["bash"]}','{"provider":"different"}','{"apiKey":"secret"}','{"stream":{"maxTokens":99999}}','{"retry":{"enabled":true}}'])assert.throws(()=>profileFromContent([config(input)]),/UNSUPPORTED|INVALID/);
 assert.throws(()=>profileFromContent([config('{"stream":{"timeoutMs":2000}}'),{...config('{"stream":{"timeoutMs":3000}}'),targetId:'other'}]),/COMBINATION_CONFLICT/);
});
test('an activated prompt version does not replace an older pending task and explicit rollback only changes future defaults',async()=>{
 const f=await fixture('prompt-skill',{'skill.md':'Use acquired evidence.\n\n'}),controller=new AbortController();
 const old=await runReadTask({dataRoot:f.dataRoot,workspace:f.workspace,input:'Old pending task',mode:'offline',signal:controller.signal,cancellation:'exit',transport:async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('controlled interruption')));controller.abort();})});
 const original=(await readRun(f.dataRoot,old.runId)).records.find(r=>r.kind==='execution.config')!.data as any;
 f.decision.selections[0].formal.activate={scope:'project-default',workspace:f.workspace,taskTypes:['read'],baseline:{read:readImproveDefaults(f.dataRoot,f.workspace,'read').revision}};
 f.decision.groups[0].basis={impact:'no-behavior',reason:'Exact trailing whitespace cleanup preserves existing instruction text',checkIndices:[0]};f.decision.groups[0].checks[0].kind='direct';f.decision.groups[0].checks[0].program="import assert from'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync('/input/baseline/target/skill.md','utf8').trim(),readFileSync('/work/targets/target/skill.md','utf8').trim());";f.decision.groups[0].changes=[{targetId:'target',path:'skill.md',content:'Use acquired evidence.\n'}];f.candidate.objective='maintenance';const e=new Evidence(f.dataRoot,'analysis-1');e.append('improve.report',f.report);e.close();
 const activated=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});assert.equal(activated.activation,'new-default');const auth={workspace:f.workspace,mode:'offline' as const,tools:['read'] as const};const inspection=await inspectRecovery({dataRoot:f.dataRoot,runId:old.runId,authorization:auth});assert.equal(inspection.reasons.includes('EXECUTION_CONFIGURATION_CHANGED'),false);assert.equal(inspection.reasons.includes('DURABLE_AGENT_CHANGED'),false);
 const current=(await readRun(f.dataRoot,old.runId)).records.find(r=>r.kind==='execution.config')!.data;assert.deepEqual(current,original);assert.equal(readImproveDefaults(f.dataRoot,f.workspace,'read').files.length,1);
 await rollbackImproveDecision({dataRoot:f.dataRoot,id:f.decision.id,rollbackId:'default-rollback',decisionSource:activated.sourceId,groupIds:['fix'],reason:'Explicitly select original defaults'});assert.equal(readImproveDefaults(f.dataRoot,f.workspace,'read').files.length,0);assert.deepEqual((await readRun(f.dataRoot,old.runId)).records.find(r=>r.kind==='execution.config')!.data,original);
});
test('explicit config activation fixes new-task effective profile while file writeback and actual observation stay distinct',async()=>{
 const f=await fixture('agent-config',{'config.json':'{"instructions":"Use accurate evidence.","compaction":{"reserveTokens":16384}}\n'});
 const next='{"instructions":"Use accurate evidence.","compaction":{"reserveTokens":20000}}\n';
 f.decision.selections[0].formal.activate={scope:'project-default',workspace:f.workspace,taskTypes:['read'],baseline:{read:readImproveDefaults(f.dataRoot,f.workspace,'read').revision}};
 f.decision.groups[0].basis={impact:'deterministic-fix',reason:'Known reserve threshold is wrong; exact field regression and preserved instruction equivalence',checkIndices:[0]};f.decision.groups[0].changes=[{targetId:'target',path:'config.json',content:next}];f.decision.groups[0].checks[0].program="import assert from'node:assert/strict';import{readFileSync}from'node:fs';const c=JSON.parse(readFileSync('/work/targets/target/config.json'));assert.equal(c.compaction.reserveTokens,20000);assert.equal(c.instructions,'Use accurate evidence.');";
 const result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});assert.equal(result.activation,'new-default');assert.equal(result.facts.some(f=>f.kind==='improve.default-observed'),false);
 const transport=scriptedTransport([]);const run=await runReadTask({dataRoot:f.dataRoot,workspace:f.workspace,input:'Observe selected defaults',mode:'offline',transport:transport.fetch});assert.equal(run.status,'completed');
 const config=(await readRun(f.dataRoot,run.runId)).records.find(r=>r.kind==='execution.config')!.data as any;assert.equal(config.settings.compaction.reserveTokens,20000);assert.match(config.instructions,/Use accurate evidence/);assert.equal(config.improveDefaults.profileId,readImproveDefaults(f.dataRoot,f.workspace,'read').profileId);assert.equal(readImproveDecision(f.dataRoot,f.decision.id).facts.some(f=>f.kind==='improve.default-observed'),true);
});
