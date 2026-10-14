import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFormalSelection} from '../src/improve-formal.js';
import {validateGroup} from '../src/improve-validation.js';
import type {ImproveCandidate} from '../src/improve.js';
import type {ImproveSelection} from '../src/improve-decisions.js';
const candidate=(kind:'self-source'|'eval-asset')=>({id:'candidate:one',target:{kind,id:'target',workspace:'/registered'},objective:'maintenance',scope:['src/example.ts'],activation:{writeback:true,enable:true}} as ImproveCandidate);
test('registered source execution declares a future process separately from project profile activation',()=>{
 const c=candidate('self-source');const selection={mode:'execute-declared-scope',formal:{writeback:true,activate:null,failureCompensation:'none'}} as ImproveSelection;
 assert.doesNotThrow(()=>validateFormalSelection(selection,c,'/project'));
 assert.throws(()=>validateGroup({id:'group',candidateIds:[c.id],changes:[{targetId:'target',path:'src/example.ts',content:'export const message="new";'}],checks:[{kind:'direct',timeoutMs:1000,program:'console.log("source only is insufficient")'}]},[c],new Date(Date.now()+10000).toISOString()),/SELF_BUILD_REQUIRED/);
});

import {mkdtemp,mkdir,copyFile,writeFile,realpath} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySelfSource} from '../src/improve-source.js';
const installation=fileURLToPath(new URL('../../',import.meta.url));
test('registration rejects a newly added build input even when all previously listed files still match',async()=>{
 const source=await realpath(await mkdtemp(join(tmpdir(),'durio-source-identity-'))),manifest=JSON.parse(readFileSync(join(installation,'dist/execution/source-build.json'),'utf8'));
 for(const file of [...manifest.inputs,...manifest.outputs,...manifest.compiler,{path:'dist/execution/source-build.json'}]){const to=join(source,file.path);await mkdir(dirname(to),{recursive:true});await copyFile(join(installation,file.path),to);}
 await cp(join(installation,'node_modules'),join(source,'node_modules'),{recursive:true});
 assert.doesNotThrow(()=>verifySelfSource(source));
 await writeFile(join(source,'src/unregistered.ts'),'export const stale = true;\n');
 assert.throws(()=>verifySelfSource(source),/SELF_SOURCE_INPUT_SET_MISMATCH/);
 await unlink(join(source,'src/unregistered.ts'));await writeFile(join(source,'dist/src/unregistered.js'),'export const extra=true;');assert.throws(()=>verifySelfSource(source),/SELF_SOURCE_OUTPUT_SET_MISMATCH/);
});

import {cp,readFile,chmod,unlink} from 'node:fs/promises';
import {Evidence} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {submitImproveDecision,readImproveBuildDefault,launchImproveBuild,rollbackImproveDecision} from '../src/improve-decisions.js';
async function sourceFixture(){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'durio-build-execution-'))),source=join(directory,'source'),workspace=join(directory,'project'),dataRoot=join(directory,'data');await mkdir(source);await mkdir(workspace);
 const manifest=JSON.parse(readFileSync(join(installation,'dist/execution/source-build.json'),'utf8'));
 for(const file of [...manifest.inputs,...manifest.outputs,{path:'dist/execution/source-build.json'}]){const to=join(source,file.path);await mkdir(dirname(to),{recursive:true});await copyFile(join(installation,file.path),to);}
 await cp(join(installation,'node_modules'),join(source,'node_modules'),{recursive:true});
 const e=new Evidence(dataRoot,'analysis-build'),target=captureImproveSources(e,workspace,[{id:'self',kind:'self-source',root:source,paths:['src/cli.ts']}],'fixture').targets[0];assert.equal(target.state,'verified',JSON.stringify(target.gaps));
 const original=await readFile(join(source,'src/cli.ts'),'utf8'),content=original.replace('Improve: improve analyze','Improve new-build: improve analyze');assert.notEqual(content,original);
 const c={...candidate('self-source'),target,id:'candidate:cli',revision:'candidate-r1',display:'R1',title:'Clarify CLI help',scope:['src/cli.ts'],steps:['Prepare explicit source bytes','Build and check executable help','Write source and select a future process'],dependencies:[],conflicts:[],suggestionOnly:false};
 const report={id:'source-report',revision:'report-r1',runId:e.runId,target:{workspace,runId:'task-1',taskId:'task-1',sessionId:'session-1'},candidates:[c],targets:[target],state:'complete',evidence:[]};e.append('improve.started',{request:{id:report.id},target:report.target});e.append('improve.report',report);e.close();
 // A new controlled happy-path plan: the preserved 300s first failure took
 // 350166ms overall, including nearly five minutes of content preparation.
 // This fixture grants 600s up front; production deadlines are never extended.
 const decision:any={id:'source-execution',reportId:report.id,reportRevision:report.revision,selections:[{candidateId:c.id,candidateRevision:c.revision,target,steps:c.steps,mode:'execute-declared-scope',formal:{writeback:true,activate:null,failureCompensation:'none',newProcess:{workspace,baseline:readImproveBuildDefault(dataRoot,workspace).revision}}}],directory:join(directory,'temporary'),groups:[{id:'build',candidateIds:[c.id],changes:[{targetId:'self',path:'src/cli.ts',content}],build:{targetId:'self',timeoutMs:180000},basis:{impact:'no-behavior',reason:'CLI help text only; actual startup and expected printed text are checked',checkIndices:[0]},checks:[{kind:'direct',timeoutMs:30000,program:"import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';const text=execFileSync(process.execPath,['/input/build/dist/src/cli.js','--help'],{encoding:'utf8'});assert.match(text,/Improve new-build:/);assert.match(text,/Eval:/);"}]}],limits:{deadline:new Date(Date.now()+600000).toISOString(),maxChecks:2,maxRequests:0,maxTokens:0}};
 return {directory,source,workspace,dataRoot,decision,original,content};
}
test('selected source produces a content-bound executable and only an explicit new process observes it',async()=>{
 const f=await sourceFixture(),result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});
 assert.equal(result.state,'completed',JSON.stringify({state:result.state,reason:result.reason,groups:result.groups.map((g:any)=>({state:g.state,reason:g.reason,formal:g.formal}))}));assert.equal(await readFile(join(f.source,'src/cli.ts'),'utf8'),f.content);
 const build=result.groups[0].build;assert.equal(build.state,'completed');assert.equal(result.groups[0].processes.length,0);assert.equal(readImproveBuildDefault(f.dataRoot,f.workspace).current?.buildId,build.candidate.id);
 const launched=await launchImproveBuild({dataRoot:f.dataRoot,id:'new-process',decisionId:f.decision.id,decisionSource:result.sourceId,groupId:'build',buildId:build.candidate.id,side:'candidate',authorization:{workspace:f.workspace,mode:'offline',tools:['read']},operation:{kind:'help'},timeoutMs:30000});
 assert.equal(launched.state,'completed',JSON.stringify(launched));assert.match(launched.stdout,/Improve new-build:/);assert.notEqual(launched.pid,process.pid);
 assert.deepEqual(await launchImproveBuild({dataRoot:f.dataRoot,id:'new-process',decisionId:f.decision.id,decisionSource:result.sourceId,groupId:'build',buildId:build.candidate.id,side:'candidate',authorization:{workspace:f.workspace,mode:'offline',tools:['read']},operation:{kind:'help'},timeoutMs:30000}),launched);
 const launch:any={dataRoot:f.dataRoot,id:'check-new',decisionId:f.decision.id,decisionSource:result.sourceId,groupId:'build',buildId:build.candidate.id,side:'candidate',authorization:{workspace:f.workspace,mode:'offline',tools:['read']},operation:{kind:'help'},timeoutMs:30000};
 await assert.rejects(launchImproveBuild({...launch,authorization:{...launch.authorization,tools:[]}}),/AUTHORIZATION_CHANGED/);
 await writeFile(join(f.source,'src/cli.ts'),f.content+'// user edit\n');
 await assert.rejects(launchImproveBuild(launch),/SOURCE_CHANGED/);
 await assert.rejects(rollbackImproveDecision({dataRoot:f.dataRoot,id:f.decision.id,decisionSource:result.sourceId,rollbackId:'user-edit-rollback',groupIds:['build'],reason:'exercise preserved edit'}),/USER_EDIT/);
 await writeFile(join(f.source,'src/cli.ts'),f.content);
 const entry=join(build.candidate.directory,build.candidate.entry),compiled=await readFile(entry);await chmod(entry,0o644);await writeFile(entry,'console.log("drift")');
 await assert.rejects(launchImproveBuild(launch),/CONTENT_CHANGED|MODE_CHANGED/);await writeFile(entry,compiled);await chmod(entry,0o444);
 const {runReadTask,readRun}=await import('../src/runtime.js'),controller=new AbortController();
 const pending=await runReadTask({dataRoot:f.dataRoot,workspace:f.workspace,input:'Read old pending work',mode:'offline',signal:controller.signal,cancellation:'exit',transport:async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('interrupted')));controller.abort();})});
 const old=await readRun(f.dataRoot,pending.runId);
 const denied=await launchImproveBuild({...launch,id:'old-pending-denied',operation:{kind:'run',taskType:'read',input:'Read README.md',dataRoot:f.dataRoot}});assert.equal(denied.state,'failed');assert.match(denied.stderr,/RECOVERY/);assert.deepEqual(await readRun(f.dataRoot,pending.runId),old);
 const rollback=await rollbackImproveDecision({dataRoot:f.dataRoot,id:f.decision.id,decisionSource:result.sourceId,rollbackId:'source-rollback',groupIds:['build'],reason:'Explicit controlled rollback'});
 assert.equal(rollback.groups[0].rollback?.state,'completed');assert.equal(readImproveBuildDefault(f.dataRoot,f.workspace).current,null);assert.equal(await readFile(join(f.source,'src/cli.ts'),'utf8'),f.original);
 await assert.rejects(launchImproveBuild({...launch,id:'after-rollback'}),/NOT_SELECTED/);
 const oldBuild=await launchImproveBuild({...launch,id:'baseline-after-rollback',buildId:build.baseline.id,side:'baseline'});assert.equal(oldBuild.state,'completed');assert.doesNotMatch(oldBuild.stdout,/Improve new-build:/);

});
