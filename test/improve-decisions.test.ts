import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,digest} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {submitImproveDecision,readImproveDecision,previewImproveDecision,resumeImproveDecision,suppressionMatch,listImproveSuppressions,restoreImproveSuggestion,type ImproveMode,type ImproveDecision} from '../src/improve-decisions.js';
import {scopedImproveDecisions} from '../src/improve-history.js';
import {ImproveSelectionView} from '../src/tui/improve-selection.js';

async function fixture(){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'durio-decisions-'))),workspace=join(directory,'project'),dataRoot=join(directory,'data');
 await mkdir(workspace);await writeFile(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 const e=new Evidence(dataRoot,'analysis-1');
 const target={workspace,sessionId:'session-1',taskId:'task-1',runId:'coding-1'};
 const sources=captureImproveSources(e,workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'test-version');
 const candidate={id:'candidate:first',revision:'candidate-rev-1',display:'R1',title:'Correct addition',problem:'Subtraction used for addition',problemKey:'math.add.operator',conditionKey:'initial',objective:'bug',target:sources.targets[0],facts:[],hypotheses:[],successCounterexamples:[],gaps:[],mechanismsReviewed:['math.mjs'],steps:['Replace subtraction with addition'],scope:['math.mjs'],validation:{method:'regression',checks:['Positive and signed addition'],budget:'one restricted check',protections:['No project writes']},risks:['Numeric inputs only'],rollback:'Preserved baseline',activation:{writeback:true,enable:false,conditions:['regression pass'],timing:'new task'},dependencies:[],conflicts:[],suggestionOnly:false};
 const report={id:'report-1',revision:'report-rev-1',runId:e.runId,target,candidates:[candidate],selected:[],targets:sources.targets,state:'complete',evidence:[]};
 e.append('improve.started',{request:{id:report.id},target});e.append('improve.report',report);e.close();
 return {directory,workspace,dataRoot,report,candidate};
}
function decision(f:Awaited<ReturnType<typeof fixture>>,mode:ImproveMode='defer'){
 return {id:'choice-1',reportId:f.report.id,reportRevision:f.report.revision,selections:[{candidateId:f.candidate.id,candidateRevision:f.candidate.revision,target:f.candidate.target,mode,steps:f.candidate.steps}],groups:[],limits:{deadline:new Date(Date.now()+60000).toISOString(),maxChecks:0,maxRequests:0,maxTokens:0}};
}
test('explicit non-executing decision persists exact identities and duplicate returns state without writes',async()=>{
 const f=await fixture(),d=decision(f);
 assert.deepEqual(previewImproveDecision(f.dataRoot,{...d,selections:[]}).selections,[]);
 const first=await submitImproveDecision({dataRoot:f.dataRoot,decision:d});
 assert.equal(first.state,'completed');assert.equal(first.decision.reportRevision,'report-rev-1');assert.equal(first.activation,'not-enabled');
 const before=digest(await readFile(join(f.dataRoot,'host.sqlite')));
 assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:d}),first);
 assert.deepEqual(readImproveDecision(f.dataRoot,d.id),first);assert.equal(digest(await readFile(join(f.dataRoot,'host.sqlite'))),before);
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:{...d,selections:[{...d.selections[0],mode:'do-not-suggest'}]}}),/DECISION_ID_REUSED/);
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:{...decision(f,'execute-declared-scope'),id:'execute'}}),/EXECUTE_UNSUPPORTED/);
});
test('validate-only constructs and checks real restricted content while preserving the formal non-Git target',async()=>{
 const f=await fixture(),d={...decision(f,'validate-only'),directory:join(f.directory,'validation'),groups:[{id:'math',candidateIds:[f.candidate.id],changes:[{targetId:'project',path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],checks:[{kind:'regression',program:"import assert from 'node:assert/strict'; const {add}=await import('/work/targets/project/math.mjs'); assert.equal(add(2,3),5); assert.equal(add(2,-3),-1); console.log('addition passed');",timeoutMs:30000}]}],limits:{...decision(f).limits,maxChecks:1}};
 const submitted=structuredClone(d);
 const outcome=await submitImproveDecision({dataRoot:f.dataRoot,decision:d as any,fault:kind=>{if(kind==='improve.decision'){d.groups[0].changes[0].content='caller mutated after dispatch';d.groups[0].checks[0].program='throw Error("must not execute changed input")';}}});
 assert.equal(outcome.state,'completed',JSON.stringify(outcome));assert.equal(outcome.groups[0].state,'completed');
 assert.equal(outcome.groups[0].result.checks[0].execution.terminated,true);
 assert.equal(outcome.groups[0].result.effect,'direct-checks-passed');
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
 const before=digest(await readFile(join(f.dataRoot,'host.sqlite')));
 assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:submitted as any}),outcome);assert.equal(digest(await readFile(join(f.dataRoot,'host.sqlite'))),before);
});
test('scope/problem suppression survives rewording, new IDs and versions; ambiguous overlapping keys are withheld until explicit restore',async()=>{
 const f=await fixture();await submitImproveDecision({dataRoot:f.dataRoot,decision:decision(f,'do-not-suggest')});
 const changed={...f.candidate,id:'other-id',revision:'r20',title:'Faster clearer math',problem:'Reworded proposal',target:{...f.candidate.target,applicableVersion:'new-version'}};
 assert.equal(suppressionMatch(f.dataRoot,changed as any).blocked,true);
 const ambiguity=suppressionMatch(f.dataRoot,{...changed,problemKey:'new-looking-key'} as any);assert.equal(ambiguity.blocked,true);assert.equal(ambiguity.matches[0].match,'overlapping-scope-identity-unknown');
 assert.equal(suppressionMatch(f.dataRoot,{...changed,target:{...changed.target,workspace:'/another/project'}} as any).blocked,false);
 const history=scopedImproveDecisions(f.dataRoot,f.workspace);assert.equal(history.length,1);assert.equal(history[0].runId,'analysis-1');assert.equal(history[0].decisions[0].mode,'do-not-suggest');
 const suppression=listImproveSuppressions(f.dataRoot)[0];await restoreImproveSuggestion({dataRoot:f.dataRoot,id:'restore-1',suppressionId:suppression.id,reason:'Explicitly allow this project problem again'});
 assert.equal(suppressionMatch(f.dataRoot,changed as any).blocked,false);assert.equal(listImproveSuppressions(f.dataRoot)[0].active,false);
 assert.equal(readImproveDecision(f.dataRoot,'choice-1').decision.selections[0].mode,'do-not-suggest','restore never rewrites original choice');
});
test('deferral needs relevant content change; revision, baseline, dependencies, conflicts and missing budgets reject before work',async()=>{
 const f=await fixture(),d=decision(f);await submitImproveDecision({dataRoot:f.dataRoot,decision:d});
 assert.equal(suppressionMatch(f.dataRoot,f.candidate as any).blocked,true);
 const changed={...f.candidate,target:{...f.candidate.target,files:f.candidate.target.files.map(x=>({...x,sha256:'changed-content'}))}};
 const renewed=suppressionMatch(f.dataRoot,changed as any);assert.equal(renewed.blocked,false);assert.match(renewed.matches[0].reason,/target content changed/);
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:{...d,id:'old-report',reportRevision:'old'}}),/REPORT_REVISION_DRIFT/);
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:{...d,id:'old-candidate',selections:[{...d.selections[0],candidateRevision:'old'}]}}),/CANDIDATE_REVISION_DRIFT/);
 await writeFile(join(f.workspace,'math.mjs'),'user edit\n');
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:{...d,id:'drift'}}),/BASELINE_DRIFT/);
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'user edit\n');
});
test('decision record failure prevents candidate construction',async()=>{
 const f=await fixture(),d=decision(f);
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:d,fault:kind=>{if(kind==='improve.decision')throw Error('disk-full');}}),/disk-full/);
 assert.throws(()=>readImproveDecision(f.dataRoot,d.id),/NOT_FOUND/);
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
});
test('TUI starts unselected, shows each mode and aggregate, and only submits after rendered summary plus explicit Enter',async()=>{
 const f=await fixture(),template=decision(f);let submits=0;
 const view=new ImproveSelectionView(f.dataRoot,template,async d=>{submits++;return submitImproveDecision({dataRoot:f.dataRoot,decision:d});});
 assert.deepEqual(view.draft().selections,[]);await view.handleInput('thanks, do everything');await view.handleInput('\r');assert.equal(submits,0);
 await view.handleInput('d');assert.equal(view.draft().selections[0].mode,'defer');await view.handleInput('s');await view.handleInput('\r');assert.equal(submits,0,'unrendered summary cannot be submitted');
 const shown=view.render(160,100).join('\n');assert.match(shown,/report-rev-1/);assert.match(shown,/totalBudget/);assert.match(shown,/dependencies/);
 await view.handleInput('\r');assert.equal(submits,1);assert.equal(readImproveDecision(f.dataRoot,template.id).state,'completed');
 await view.handleInput('\r');assert.equal(submits,1);
 const again=new ImproveSelectionView(f.dataRoot,template,async()=>{throw Error('view must not submit')});assert.deepEqual(again.draft().selections,[]);
});
async function twoGroups(){
 const f=await fixture(),other=join(f.directory,'independent-eval-asset');await mkdir(other);await writeFile(join(other,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 const e=new Evidence(f.dataRoot,'analysis-1'),target=captureImproveSources(e,f.workspace,[{id:'asset',kind:'eval-asset',root:other,paths:['math.mjs']}],'test-version').targets[0];
 const second={...f.candidate,id:'candidate:second',revision:'candidate-rev-2',target};f.report.candidates.push(second);f.report.revision='report-rev-two';e.append('improve.report',f.report);e.close();
 const selections=f.report.candidates.map(c=>({candidateId:c.id,candidateRevision:c.revision,target:c.target,mode:'validate-only' as const,steps:c.steps}));
 const group=(id:string,c:typeof f.candidate,fail:boolean)=>({id,candidateIds:[c.id],changes:[{targetId:c.target.id,path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],checks:[{kind:'regression' as const,program:`import assert from 'node:assert/strict'; const {add}=await import('/work/targets/${c.target.id}/math.mjs'); assert.equal(add(2,3),${fail?6:5});`,timeoutMs:30000}]});
 const d:ImproveDecision={...decision(f,'validate-only'),id:'two-groups',selections,directory:join(f.directory,'validation'),groups:[group('first',f.candidate,true),group('second',second,false)],limits:{...decision(f).limits,maxChecks:2}};
 return {...f,d,second};
}
test('a necessary failure freezes independent remaining work; explicit continuation preserves failure and spends only remaining original authorization',async()=>{
 const f=await twoGroups(),result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.d});
 assert.equal(result.state,'frozen');assert.deepEqual(result.groups.map((g:any)=>g.state),['failed','not-run']);assert.equal(result.reserved.checks,1);
 const originalFailure=result.groups[0].sourceId;
 assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:f.d}),result);
 await assert.rejects(resumeImproveDecision({dataRoot:f.dataRoot,id:f.d.id,resumeId:'bad-replay',decisionSource:result.sourceId,groupIds:['first']}),/ONLY_INDEPENDENT_NOT_RUN/);
 const resumed=await resumeImproveDecision({dataRoot:f.dataRoot,id:f.d.id,resumeId:'continue-second',decisionSource:result.sourceId,groupIds:['second']});
 assert.equal(resumed.state,'completed-with-failures');assert.deepEqual(resumed.groups.map((g:any)=>g.state),['failed','completed']);assert.equal(resumed.groups[0].sourceId,originalFailure);assert.equal(resumed.reserved.checks,2);
 assert.equal(await readFile(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');
});
test('cancelled batch and record failure never dispatch the remainder or replay an uncertain started group',async()=>{
 const cancelled=await twoGroups(),c=await submitImproveDecision({dataRoot:cancelled.dataRoot,decision:cancelled.d,signal:AbortSignal.abort()});
 assert.equal(c.state,'frozen');assert.deepEqual(c.groups.map((g:any)=>g.state),['not-run','not-run']);assert.equal(c.reserved.checks,0);
 const f=await twoGroups();
 await assert.rejects(submitImproveDecision({dataRoot:f.dataRoot,decision:f.d,fault:kind=>{if(kind==='improve.validation')throw Error('record-write-failure');}}),/record-write-failure/);
 const unknown=readImproveDecision(f.dataRoot,f.d.id);assert.deepEqual(unknown.groups.map((g:any)=>g.state),['unknown','not-run']);assert.equal(unknown.reserved.checks,1);
 assert.deepEqual(await submitImproveDecision({dataRoot:f.dataRoot,decision:f.d}),unknown);
 await assert.rejects(resumeImproveDecision({dataRoot:f.dataRoot,id:f.d.id,resumeId:'unsafe',decisionSource:unknown.sourceId,groupIds:['second']}),/PRECONDITIONS_CHANGED/);
});
test('unselected dependencies, explicit conflicts, shared-target split and insufficient total limits cannot start work',async()=>{
 const f=await twoGroups();f.candidate.dependencies.push(f.second.id as never);let e=new Evidence(f.dataRoot,'analysis-1');e.append('improve.report',f.report);e.close();
 assert.throws(()=>previewImproveDecision(f.dataRoot,{...f.d,selections:f.d.selections.slice(0,1),groups:f.d.groups.slice(0,1)}),/DEPENDENCY_NOT_SELECTED/);
 f.candidate.dependencies=[];f.candidate.conflicts.push(f.second.id as never);e=new Evidence(f.dataRoot,'analysis-1');e.append('improve.report',f.report);e.close();
 assert.throws(()=>previewImproveDecision(f.dataRoot,f.d),/SELECTION_CONFLICT/);
 f.candidate.conflicts=[];f.second.target=f.candidate.target;f.d.selections[1].target=f.candidate.target;e=new Evidence(f.dataRoot,'analysis-1');e.append('improve.report',f.report);e.close();
 assert.throws(()=>previewImproveDecision(f.dataRoot,f.d),/COMBINATION_REQUIRED/);
 const only={...f.d,selections:f.d.selections.slice(0,1),groups:f.d.groups.slice(0,1),limits:{...f.d.limits,maxChecks:0}};
 assert.throws(()=>previewImproveDecision(f.dataRoot,only),/TOTAL_BUDGET_EXCEEDED/);
});
