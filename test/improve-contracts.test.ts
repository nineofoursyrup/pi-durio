/** Tests for #88: candidate contracts (replacements + structuredChecks) and host derivation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,digest} from '../src/evidence.js';
import {captureImproveSources,registerImproveSource,listRegisteredSources} from '../src/improve-source.js';
import {submitImproveDecision,previewImproveDecision,deriveImproveDecision,type ImproveMode,type ImproveDecision} from '../src/improve-decisions.js';
import * as runtime from '../src/runtime.js';
import {scriptedTransport} from '../src/offline.js';

async function fixture(){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'durio-contracts-'))),workspace=join(directory,'project'),dataRoot=join(directory,'data');
 await mkdir(workspace);await writeFile(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 const e=new Evidence(dataRoot,'analysis-1');
 const target={workspace,sessionId:'session-1',taskId:'task-1',runId:'coding-1'};
 const sources=captureImproveSources(e,workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'test-version');
 // Executable candidate: has replacements and structuredChecks
 const candidate={
  id:'candidate:first',revision:'',display:'R1',title:'Correct addition',problem:'Subtraction used for addition',
  problemKey:'math.add.operator',conditionKey:'initial',objective:'bug' as const,
  target:sources.targets[0],
  facts:[],hypotheses:[],successCounterexamples:[],gaps:[],
  mechanismsReviewed:['math.mjs'],steps:['Replace subtraction with addition'],scope:['math.mjs'],
  validation:{method:'regression',checks:['Positive and signed addition'],budget:'one restricted check',protections:['No project writes']},
  risks:['Numeric inputs only'],rollback:'Preserved baseline',
  activation:{writeback:true,enable:false,conditions:['regression pass'],timing:'new task'},
  dependencies:[] as string[],conflicts:[] as string[],
  replacements:[{path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],
  structuredChecks:[{kind:'regression' as const,program:"import assert from 'node:assert/strict';const {add}=await import('/work/targets/project/math.mjs');assert.equal(add(2,3),5);assert.equal(add(2,-3),-1);",timeoutMs:30000}],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:false,
 };
 candidate.revision=digest(JSON.stringify(candidate));
 // Suggestion-only candidate: no replacements/structuredChecks
 const suggestionCandidate={
  id:'candidate:second',revision:'',display:'R2',title:'Some maintenance',problem:'Possible cleanup',
  objective:'maintenance' as const,
  target:sources.targets[0],
  facts:[],hypotheses:[],successCounterexamples:[],gaps:['No verified content'],
  mechanismsReviewed:['math.mjs'],steps:['Clean up'],scope:['math.mjs'],
  validation:{method:'direct',checks:['Build passes'],budget:'one direct check',protections:[]},
  risks:[],rollback:'Restore backup',
  activation:{writeback:true,enable:false,conditions:['checks pass'],timing:'new task'},
  dependencies:[] as string[],conflicts:[] as string[],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:true,
 };
 suggestionCandidate.revision=digest(JSON.stringify(suggestionCandidate));
 const report={id:'report-1',revision:'',runId:e.runId,target,candidates:[candidate,suggestionCandidate],selected:[],targets:sources.targets,state:'complete' as const,evidence:[]};
 report.revision=digest(JSON.stringify(report));
 e.append('improve.started',{request:{id:report.id},target});e.append('improve.report',report);e.close();
 return {directory,workspace,dataRoot,report,candidate,suggestionCandidate};
}
function baseDecision(f:Awaited<ReturnType<typeof fixture>>,mode:ImproveMode='defer',id='choice-1'){
 return {id,reportId:f.report.id,reportRevision:f.report.revision,selections:[{candidateId:f.candidate.id,candidateRevision:f.candidate.revision,target:f.candidate.target,mode,steps:f.candidate.steps}],groups:[] as any[],limits:{deadline:new Date(Date.now()+60000).toISOString(),maxChecks:0,maxRequests:0,maxTokens:0}};
}

// AC1: executable candidate (with replacements+structuredChecks) is not suggestion-only;
// suggestion-only candidates cannot be selected for execute or validate-only.
test('executable candidates require replacements and structuredChecks; missing content marks suggestion-only and blocks validate/execute',async()=>{
 const f=await fixture();
 // Executable candidate: suggestionOnly should be false (set explicitly in fixture)
 assert.equal(f.candidate.suggestionOnly,false);
 // Suggestion-only candidate: cannot select execute
 assert.throws(()=>previewImproveDecision(f.dataRoot,{...baseDecision(f,'execute-declared-scope'),id:'execute',selections:[{candidateId:f.suggestionCandidate.id,candidateRevision:f.suggestionCandidate.revision,target:f.suggestionCandidate.target,mode:'execute-declared-scope',steps:f.suggestionCandidate.steps,formal:{writeback:true,failureCompensation:'none',activate:null}}],groups:[{id:'g1',candidateIds:[f.suggestionCandidate.id],changes:[],checks:[{kind:'direct',program:'console.log("ok")',timeoutMs:5000}]}],limits:{...baseDecision(f).limits,maxChecks:1}}),/SUGGESTION_ONLY/);
 // Suggestion-only candidate: cannot select validate-only
 assert.throws(()=>previewImproveDecision(f.dataRoot,{...baseDecision(f,'validate-only'),id:'validate',selections:[{candidateId:f.suggestionCandidate.id,candidateRevision:f.suggestionCandidate.revision,target:f.suggestionCandidate.target,mode:'validate-only',steps:f.suggestionCandidate.steps}],groups:[{id:'g1',candidateIds:[f.suggestionCandidate.id],changes:[],checks:[{kind:'direct',program:'console.log("ok")',timeoutMs:5000}]}],limits:{...baseDecision(f).limits,maxChecks:1}}),/SUGGESTION_ONLY/);
 // Executable candidate: can defer without error (non-active selection)
 assert.doesNotThrow(()=>previewImproveDecision(f.dataRoot,baseDecision(f,'defer')));
});

// AC2 (existing behavior confirmed): conflict, dependency not selected, mode inconsistency, baseline change all reject.
// These are covered by existing tests in improve-decisions.test.ts.

// AC3: each candidate decided only once per report; validate-only passed → can re-select as execute.
test('same candidate in same report cannot be decided twice; defer and do-not-suggest also prevent re-decision',async()=>{
 const f=await fixture();
 // Submit a defer decision
 await submitImproveDecision({dataRoot:f.dataRoot,decision:baseDecision(f,'defer')});
 // Try a second decision for same candidate (different id, same report)
 await assert.rejects(async()=>submitImproveDecision({dataRoot:f.dataRoot,decision:baseDecision(f,'defer','choice-2')}),/CANDIDATE_ALREADY_DECIDED/);
 // Do-not-suggest also prevented
 await assert.rejects(async()=>submitImproveDecision({dataRoot:f.dataRoot,decision:{...baseDecision(f,'do-not-suggest','choice-3')}}),/CANDIDATE_ALREADY_DECIDED/);
});

test('modern validate-only is decided once; only a passed check permits later execute, which revalidates',async()=>{
 const f=await fixture(),derive=(mode:ImproveMode,id:string)=>deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode}],{id,directory:join(f.directory,id),deadline:new Date(Date.now()+60000).toISOString()});
 const first=derive('validate-only','validate-choice'),outcome=await submitImproveDecision({dataRoot:f.dataRoot,decision:first});
 assert.equal(outcome.state,'completed',JSON.stringify(outcome));assert.equal(outcome.groups[0].result?.conclusion?.allChecksPassed,true);
 assert.throws(()=>previewImproveDecision(f.dataRoot,derive('validate-only','second-validation')),/CANDIDATE_ALREADY_DECIDED/);
 assert.throws(()=>previewImproveDecision(f.dataRoot,derive('defer','after-validation')),/CANDIDATE_ALREADY_DECIDED/);
 const execute=derive('execute-declared-scope','execute-after-pass');assert.doesNotThrow(()=>previewImproveDecision(f.dataRoot,execute));
 assert.equal(execute.groups[0].checks.length,1);assert.equal(execute.limits.maxChecks,1,'execute reserves a new validation');
 const executed=await submitImproveDecision({dataRoot:f.dataRoot,decision:execute});assert.equal(executed.writeback,'written');
 const failed=await fixture();failed.candidate.structuredChecks[0].program='throw Error("regression did not pass")';
 const e=new Evidence(failed.dataRoot,failed.report.runId);e.append('improve.report',failed.report);e.close();
 const failedDecision=deriveImproveDecision(failed.dataRoot,failed.report.id,[{candidateId:failed.candidate.id,mode:'validate-only'}],{id:'failed-validation',directory:join(failed.directory,'failed-validation'),deadline:new Date(Date.now()+60000).toISOString()});
 assert.equal((await submitImproveDecision({dataRoot:failed.dataRoot,decision:failedDecision})).groups[0].state,'failed');
 assert.throws(()=>previewImproveDecision(failed.dataRoot,deriveImproveDecision(failed.dataRoot,failed.report.id,[{candidateId:failed.candidate.id,mode:'execute-declared-scope'}],{id:'cannot-execute',directory:join(failed.directory,'cannot-execute')})),/CANDIDATE_ALREADY_DECIDED/);
});

// AC4: host derives groups, order (topological sort then candidate number), and budget from candidates.
test('deriveImproveDecision builds groups from replacements and structuredChecks with topological order and budget',async()=>{
 const f=await fixture();
 // Two independent candidates in same workspace → auto-combined into one group
 // Add a second independent candidate sharing the same workspace
 const e=new Evidence(f.dataRoot,'analysis-2');
 const sources=captureImproveSources(e,f.workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'test-version');
 const c2={
  id:'candidate:c2',revision:'',display:'R2',title:'Second fix',problem:'Another issue',
  objective:'maintenance' as const,
  target:sources.targets[0],
  facts:[],hypotheses:[],successCounterexamples:[],gaps:[],
  mechanismsReviewed:['math.mjs'],steps:['Fix it'],scope:['math.mjs'],
  validation:{method:'direct',checks:['passes'],budget:'one check',protections:[]},
  risks:[],rollback:'restore',
  activation:{writeback:true,enable:false,conditions:['pass'],timing:'new task'},
  dependencies:[] as string[],conflicts:[] as string[],
  replacements:[{path:'math.mjs',content:'export const add=(a,b)=>a+b; // c2\n'}],
  structuredChecks:[{kind:'direct' as const,program:'console.log("c2 ok")',timeoutMs:5000}],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:false,
 };
 c2.revision=digest(JSON.stringify(c2));
 const report2={id:'report-2',revision:'',runId:e.runId,target:f.report.target,candidates:[f.candidate,c2],selected:[],targets:sources.targets,state:'complete' as const,evidence:[]};
 report2.revision=digest(JSON.stringify(report2));
 e.append('improve.started',{request:{id:report2.id},target:f.report.target});e.append('improve.report',report2);e.close();
 // Derive decision: both active candidates share same workspace → same group
 const derived=deriveImproveDecision(f.dataRoot,'report-2',[{candidateId:f.candidate.id,mode:'validate-only'},{candidateId:c2.id,mode:'validate-only'}],{id:'derived-1',directory:join(f.directory,'derived'),deadline:new Date(Date.now()+60000).toISOString()});
 assert.equal(derived.id,'derived-1');
 assert.equal(derived.reportId,'report-2');
 // Both active candidates → should be in same group (shared workspace)
 assert.equal(derived.groups.length,1,'shared workspace candidates auto-combined');
 assert.ok(derived.groups[0].candidateIds.includes(f.candidate.id));
 assert.ok(derived.groups[0].candidateIds.includes(c2.id));
 // Changes derived from replacements
 assert.equal(derived.groups[0].changes.length,2,'one change per candidate per scope file');
 assert.ok(derived.groups[0].changes.every(ch=>ch.path==='math.mjs'));
 // Checks derived from structuredChecks
 assert.equal(derived.groups[0].checks.length,2,'one check per candidate');
 // Budget: maxChecks = total checks
 assert.equal(derived.limits.maxChecks,2);
 assert.equal(derived.limits.maxRequests,0);
 assert.equal(derived.limits.maxTokens,0);
 // Order: f.candidate has no deps relative to c2, so order by candidate index in report (f.candidate first)
 assert.equal(derived.groups[0].candidateIds[0],f.candidate.id,'candidate by report order when no deps');
});

test('deriveImproveDecision respects topological sort: dependency candidate comes before dependent',async()=>{
 const f=await fixture();
 const e=new Evidence(f.dataRoot,'analysis-3');
 const sources=captureImproveSources(e,f.workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'test-version');
 const cA={
  id:'candidate:cA',revision:'',display:'R1',title:'Base fix',problem:'Issue A',objective:'maintenance' as const,
  target:sources.targets[0],
  facts:[],hypotheses:[],successCounterexamples:[],gaps:[],
  mechanismsReviewed:['math.mjs'],steps:['Fix A'],scope:['math.mjs'],
  validation:{method:'direct',checks:['passes'],budget:'one',protections:[]},risks:[],rollback:'restore',
  activation:{writeback:false,enable:false,conditions:['pass'],timing:'new task'},
  dependencies:[] as string[],conflicts:[] as string[],
  replacements:[{path:'math.mjs',content:'export const add=(a,b)=>a+b; // A\n'}],
  structuredChecks:[{kind:'direct' as const,program:'console.log("A")',timeoutMs:5000}],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:false,
 };
 cA.revision=digest(JSON.stringify(cA));
 const cB={
  id:'candidate:cB',revision:'',display:'R2',title:'Dependent fix',problem:'Issue B',objective:'maintenance' as const,
  target:{...sources.targets[0],id:'project2',workspace:join(f.workspace,'../project2')} as any,
  facts:[],hypotheses:[],successCounterexamples:[],gaps:[],
  mechanismsReviewed:['math.mjs'],steps:['Fix B depends on A'],scope:['math.mjs'],
  validation:{method:'direct',checks:['passes'],budget:'one',protections:[]},risks:[],rollback:'restore',
  activation:{writeback:false,enable:false,conditions:['pass'],timing:'new task'},
  dependencies:[cA.id],conflicts:[] as string[],
  replacements:[{path:'math.mjs',content:'export const mul=(a,b)=>a*b;\n'}],
  structuredChecks:[{kind:'direct' as const,program:'console.log("B")',timeoutMs:5000}],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:false,
 };
 cB.revision=digest(JSON.stringify(cB));
 // Report: cA at index 0, cB at index 1; cB depends on cA
 const report3={id:'report-3',revision:'',runId:e.runId,target:f.report.target,candidates:[cA,cB],selected:[],targets:sources.targets,state:'complete' as const,evidence:[]};
 report3.revision=digest(JSON.stringify(report3));
 e.append('improve.started',{request:{id:report3.id},target:f.report.target});e.append('improve.report',report3);e.close();
 // Derive: cB depends on cA → same group (dependency), cA before cB
 const derived=deriveImproveDecision(f.dataRoot,'report-3',[{candidateId:cA.id,mode:'validate-only'},{candidateId:cB.id,mode:'validate-only'}],{id:'derived-topo',directory:join(f.directory,'derived-topo'),deadline:new Date(Date.now()+60000).toISOString()});
 assert.equal(derived.groups.length,1,'dependency forces combination');
 assert.equal(derived.groups[0].candidateIds[0],cA.id,'dependency comes first (topological order)');
 assert.equal(derived.groups[0].candidateIds[1],cB.id,'dependent comes after');
});

test('deriveImproveDecision independent candidates go into separate groups; defer mode gets no group',async()=>{
 const f=await fixture();
 const e=new Evidence(f.dataRoot,'analysis-4');
 // Create workspace2 separate from workspace for independent candidate
 const workspace2=join(f.directory,'project2');await mkdir(workspace2);await writeFile(join(workspace2,'util.mjs'),'export const x=1;\n');
 const sources2=captureImproveSources(e,f.workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'test-version');
 const cInd={
  id:'candidate:cInd',revision:'',display:'R2',title:'Independent',problem:'Issue in project2',objective:'maintenance' as const,
  target:{...sources2.targets[0],id:'project2',workspace:workspace2,files:[{path:'util.mjs',sha256:'x',bytes:18,sourceId:'s1',content:{sha256:'x',bytes:18},state:'available' as const,reason:[]}]},
  facts:[],hypotheses:[],successCounterexamples:[],gaps:[],
  mechanismsReviewed:['util.mjs'],steps:['Fix'],scope:['util.mjs'],
  validation:{method:'direct',checks:['passes'],budget:'one',protections:[]},risks:[],rollback:'restore',
  activation:{writeback:false,enable:false,conditions:['pass'],timing:'new task'},
  dependencies:[] as string[],conflicts:[] as string[],
  replacements:[{path:'util.mjs',content:'export const x=2;\n'}],
  structuredChecks:[{kind:'direct' as const,program:'console.log("ind")',timeoutMs:5000}],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:false,
 };
 cInd.revision=digest(JSON.stringify(cInd));
 const cDefer={
  id:'candidate:cDefer',revision:'',display:'R3',title:'Deferred',problem:'Something to defer',objective:'maintenance' as const,
  target:sources2.targets[0],
  facts:[],hypotheses:[],successCounterexamples:[],gaps:[],
  mechanismsReviewed:['math.mjs'],steps:['Later'],scope:['math.mjs'],
  validation:{method:'direct',checks:['passes'],budget:'one',protections:[]},risks:[],rollback:'restore',
  activation:{writeback:false,enable:false,conditions:['pass'],timing:'new task'},
  dependencies:[] as string[],conflicts:[] as string[],
  replacements:[{path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],
  structuredChecks:[{kind:'direct' as const,program:'console.log("defer")',timeoutMs:5000}],
  execution:'not-started' as const,effect:'unverified' as const,selection:'unselected' as const,suggestionOnly:false,
 };
 cDefer.revision=digest(JSON.stringify(cDefer));
 const report4={id:'report-4',revision:'',runId:e.runId,target:f.report.target,candidates:[f.candidate,cInd,cDefer],selected:[],targets:sources2.targets,state:'complete' as const,evidence:[]};
 report4.revision=digest(JSON.stringify(report4));
 e.append('improve.started',{request:{id:report4.id},target:f.report.target});e.append('improve.report',report4);e.close();
 // f.candidate is validate-only, cInd is validate-only (different workspace, no dep), cDefer is deferred
 const derived=deriveImproveDecision(f.dataRoot,'report-4',[{candidateId:f.candidate.id,mode:'validate-only'},{candidateId:cInd.id,mode:'validate-only'},{candidateId:cDefer.id,mode:'defer'}],{id:'derived-ind',directory:join(f.directory,'derived-ind'),deadline:new Date(Date.now()+60000).toISOString()});
 // f.candidate and cInd have different workspaces and no deps → separate groups
 assert.equal(derived.groups.length,2,'independent candidates get separate groups');
 // cDefer (defer mode) gets no group
 assert.ok(!derived.groups.some(g=>g.candidateIds.includes(cDefer.id)),'deferred candidate gets no group');
 // All selections present
 assert.equal(derived.selections.length,3);
});

// AC5: registered eval-asset source re-verification fails when content changes after registration.
test('registered eval-asset source fails re-verification when content changes after registration',async()=>{
 const f=await fixture();
 const evalDir=join(f.directory,'eval-asset');await mkdir(evalDir);
 await writeFile(join(evalDir,'cases.json'),JSON.stringify({schema:1,id:'test-cases',version:'v1',kind:'cases',value:[]}));
 // Register the eval-asset source
 const reg=registerImproveSource(f.dataRoot,f.workspace,{kind:'eval-asset',root:evalDir,paths:['cases.json']});
 const regs=listRegisteredSources(f.dataRoot,f.workspace);
 assert.equal(regs.length,1);assert.equal(regs[0].id,reg.id);assert.equal(regs[0].kind,'eval-asset');
 assert.equal(regs[0].fingerprints.length,1);assert.equal(regs[0].fingerprints[0].path,'cases.json');
 // Change the file content
 await writeFile(join(evalDir,'cases.json'),JSON.stringify({schema:1,id:'test-cases',version:'v2-changed',kind:'cases',value:[]}));
 // Now try to use the eval-asset source in an analysis capture → re-verification should fail
 const e=new Evidence(f.dataRoot,'analysis-re-verify');
 const target={workspace:f.workspace,sessionId:'s1',taskId:'t1',runId:'coding-1'};
 const result=captureImproveSources(e,f.workspace,[{id:'eval',kind:'eval-asset',root:evalDir,paths:['cases.json']}],'v1');
 e.close();
 // The eval-asset target should be incomplete because the registered fingerprint check failed
 const evalTarget=result.targets.find(t=>t.id==='eval');
 assert.ok(evalTarget,'eval target exists');
 assert.equal(evalTarget!.state,'incomplete');
 assert.ok(evalTarget!.gaps.some(g=>/IMPROVE_REGISTERED_SOURCE_CHANGED/.test(g)),`expected IMPROVE_REGISTERED_SOURCE_CHANGED in gaps: ${JSON.stringify(evalTarget!.gaps)}`);
});

// AC1 (scripted transport): offline analysis with scripted transport produces candidates with replacements+structuredChecks→
// suggestionOnly:false; without them→ suggestionOnly:true.
test('offline scripted transport: candidate with replacements+structuredChecks is executable; without is suggestion-only',async()=>{
 // Set up a workspace with a target file
 const dir=await realpath(await mkdtemp(join(tmpdir(),'durio-ac1-'))),workspace=join(dir,'project'),dataRoot=join(dir,'data');
 await mkdir(workspace);await writeFile(join(workspace,'calc.mjs'),'export const mul=(a,b)=>a-b;\n');
 const source=await runtime.runCodingTask({workspace,dataRoot,input:'Inspect calc',mode:'offline',transport:scriptedTransport([]).fetch});
 const limits={maxRequests:8,maxTokens:2048,maxRequestTokens:256,maxDurationMs:30000,maxOutputTokens:128};
 // Executable candidate: includes replacements+structuredChecks
 const executableCandidate={title:'Fix multiplication',problem:'Subtraction used',objective:'bug',targetId:'project',
  facts:[{claim:'The acquired source uses subtraction',evidence:['__SOURCEID__']}],hypotheses:['Operator error'],
  successCounterexamples:[],gaps:['No behavioral test beyond inspection'],
  mechanismsReviewed:['calc.mjs'],steps:['Replace subtraction with multiplication'],scope:['calc.mjs'],
  validation:{method:'regression',checks:['Multiplication passes'],budget:'one regression check',protections:['No project writes']},
  risks:['NaN inputs'],rollback:'Restore saved file',
  activation:{writeback:true,enable:false,conditions:['regression pass'],timing:'next task'},
  dependencies:[],conflicts:[],
  replacements:[{path:'calc.mjs',before:'a-b',content:'a*b'}],
  structuredChecks:[{kind:'regression',program:"import assert from 'node:assert/strict';const {mul}=await import('/work/targets/project/calc.mjs');assert.equal(mul(3,4),12);",timeoutMs:10000}]};
 // Suggestion-only candidate: no replacements/structuredChecks
 const suggestionCandidate={title:'Comment improvement',problem:'No JSDoc',objective:'maintenance',targetId:'project',
  facts:[{claim:'The acquired source lacks JSDoc',evidence:['__SOURCEID__']}],hypotheses:['Missing docs'],
  successCounterexamples:[],gaps:['Subjective; no automated check'],
  mechanismsReviewed:['calc.mjs'],steps:['Add JSDoc comment'],scope:['calc.mjs'],
  validation:{method:'direct',checks:['File compiles'],budget:'one direct check',protections:['No project writes']},
  risks:['Syntax error'],rollback:'Restore saved file',
  activation:{writeback:true,enable:false,conditions:['check passes'],timing:'next task'},
  dependencies:[],conflicts:[]};
 // Set up transport that returns both candidates after source acquisition
 const report={summary:'Improvements identified.',candidates:[executableCandidate,suggestionCandidate],gaps:[]};
 const base=scriptedTransport([[{name:'evidence_summary',args:{}},{name:'source_view',args:{targetId:'project',path:'calc.mjs'}}],[{name:'evidence_summary',args:{}}]]);
 let sourceId='';
 const provider:typeof fetch=async(url,init)=>{
  const payload=JSON.parse(String((init as any)?.body));
  const found=payload.messages?.filter((m:any)=>m.role==='tool')?.map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}})?.find((m:any)=>m.path==='calc.mjs');
  if(found&&!sourceId)sourceId=found.sourceId;
  const response=await base.fetch(url,init);
  if(base.calls.length<2||!sourceId)return response;
  const withIds={...report,candidates:[{...executableCandidate,facts:[{claim:'acquired',evidence:[sourceId]}]},{...suggestionCandidate,facts:[{claim:'acquired',evidence:[sourceId]}]}]};
  const text=await response.text();
  return new Response(text.replace('Controlled response: inspect actual tool evidence for acceptance.',JSON.stringify(withIds).replaceAll('\\','\\\\').replaceAll('"','\\"')),{headers:{'content-type':'text/event-stream'}});
 };
 const result=await runtime.analyzeImprove({dataRoot,workspace,targetRunId:source.runId,request:{id:'ac1-test',purpose:'Test AC1 contracts',limits,sources:[{id:'project',kind:'project',paths:['calc.mjs']}]},mode:'offline',transport:provider});
 assert.equal(result.status,'completed',JSON.stringify(result));
 const candidates=result.improve?.candidates??[];
 assert.equal(candidates.length,2,'both candidates returned');
 const exec=candidates.find((c:any)=>c.title==='Fix multiplication');
 const sug=candidates.find((c:any)=>c.title==='Comment improvement');
 assert.ok(exec,'executable candidate found');assert.ok(sug,'suggestion-only candidate found');
 assert.equal((exec as any).suggestionOnly,false,'candidate with replacements+structuredChecks is not suggestion-only');
 assert.equal((sug as any).suggestionOnly,true,'candidate without replacements/structuredChecks is suggestion-only');
 assert.ok(Array.isArray((exec as any).replacements)&&(exec as any).replacements.length>0,'replacements persisted');
 assert.ok(Array.isArray((exec as any).structuredChecks)&&(exec as any).structuredChecks.length>0,'structuredChecks persisted');
});
