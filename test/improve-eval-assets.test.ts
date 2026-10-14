import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Evidence,readObject} from '../src/evidence.js';
import {captureImproveSources} from '../src/improve-source.js';
import {readImproveReport} from '../src/improve.js';
import {parseEvalAsset} from '../src/improve-eval-assets.js';
import {previewImproveDecision,submitImproveDecision,readImproveEvalAssets,regradeImproveAsset} from '../src/improve-decisions.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {verifiedImage,type EvalPlan} from '../src/eval/plan.js';
import {appendFact,evalFacts} from '../src/eval/store.js';
import {fixEvidence} from '../src/fixed-evidence.js';
import {evalReport,regradeEval} from '../src/eval/runner.js';
async function fixture(){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'durio-assets-'))),workspace=join(directory,'project'),assets=join(directory,'assets'),dataRoot=join(directory,'data');await mkdir(workspace);await mkdir(assets);
 const before={schema:1,id:'addition-check',kind:'grader',version:'wrong-v1',value:{...representativeCases[0].grader,version:'wrong-v1',expectedStdout:'[6,1,0]\n'}},after={...before,version:'corrected-v2',value:{...representativeCases[0].grader,version:'corrected-v2'}};
 await writeFile(join(assets,'grader.json'),JSON.stringify(before));
 const e=new Evidence(dataRoot,'asset-analysis'),target=captureImproveSources(e,workspace,[{id:'asset',kind:'eval-asset',root:assets,paths:['grader.json']}],'fixture').targets[0];
 const c:any={id:'candidate:asset',revision:'asset-r1',target,objective:'bug',scope:['grader.json'],steps:['Check corrected arithmetic grader on saved output','Write independent version'],activation:{writeback:true,enable:false},dependencies:[],conflicts:[],suggestionOnly:false};
 const report={id:'asset-report',revision:'report-r1',runId:e.runId,target:{workspace},targets:[target],candidates:[c],state:'complete',evidence:[]};e.append('improve.started',{request:{id:report.id},target:report.target});e.append('improve.report',report);e.close();
 const decision:any={id:'asset-execution',reportId:report.id,reportRevision:report.revision,selections:[{candidateId:c.id,candidateRevision:c.revision,target,steps:c.steps,mode:'execute-declared-scope',formal:{writeback:true,activate:null,failureCompensation:'none'}}],directory:join(directory,'validation'),groups:[{id:'asset',candidateIds:[c.id],changes:[{targetId:'asset',path:'grader.json',content:JSON.stringify(after)}],checks:[{kind:'regression',timeoutMs:30000,program:"import assert from'node:assert/strict';import{readFileSync}from'node:fs';const before=JSON.parse(readFileSync('/input/baseline/asset/grader.json')),after=JSON.parse(readFileSync('/input/targets/asset/grader.json'));assert.notEqual(before.version,after.version);assert.equal(after.value.expectedStdout,JSON.stringify([2+3,-2+3,0+0])+'\\n');assert.notEqual(before.value.expectedStdout,after.value.expectedStdout);"}]}],limits:{deadline:new Date(Date.now()+120000).toISOString(),maxChecks:1,maxRequests:0,maxTokens:0}};
 return {directory,workspace,assets,dataRoot,before,after,decision};
}
test('formal eval revisions require a new independent version; cases retain explicit identities',async()=>{
 const f=await fixture(),d=structuredClone(f.decision);d.groups[0].changes[0].content=JSON.stringify({...f.after,version:f.before.version,value:{...f.after.value,version:f.before.version}});assert.throws(()=>previewImproveDecision(f.dataRoot,d),/NEW_VERSION_REQUIRED/);
 const cases=parseEvalAsset(JSON.stringify({schema:1,id:'public-cases',version:'cases-v1',kind:'cases',value:[representativeCases[0]]}));assert.equal(cases.kind,'cases');
 assert.throws(()=>parseEvalAsset(JSON.stringify({...f.after,value:{...f.after.value,version:'unrelated'}})),/VERSION_MISMATCH/);
});


test('a formal grader change cannot accompany the evaluated project candidate in another group',async()=>{
 const f=await fixture();await writeFile(join(f.workspace,'math.mjs'),'export const add=(a,b)=>a-b;');
 const e=new Evidence(f.dataRoot,'asset-analysis'),target=captureImproveSources(e,f.workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'fixture').targets[0],report=readImproveReport(f.dataRoot,f.decision.reportId).report!;
 const c:any={...report.candidates[0],id:'candidate:project',target,scope:['math.mjs']};report.candidates.push(c);report.targets.push(target);e.append('improve.report',report);e.close();
 f.decision.selections.push({candidateId:c.id,candidateRevision:c.revision,target,steps:c.steps,mode:'validate-only'});f.decision.groups.push({id:'project',candidateIds:[c.id],changes:[{targetId:'project',path:'math.mjs',content:'export const add=(a,b)=>a+b;'}],checks:[{kind:'regression',program:'console.log(5)',timeoutMs:1000}]});f.decision.limits.maxChecks=2;
 assert.throws(()=>previewImproveDecision(f.dataRoot,f.decision),/EVAL_ASSET_INDEPENDENT_DECISION_REQUIRED/);
});

test('independent grader write and explicit regrade keep original judgments and rescore both saved sides',async()=>{
 const f=await fixture(),result=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});assert.equal(result.state,'completed',JSON.stringify(result.groups.map((g:any)=>({state:g.state,reason:g.reason,formal:g.formal}))));assert.deepEqual(JSON.parse(await readFile(join(f.assets,'grader.json'),'utf8')),f.after);
 const asset=readImproveEvalAssets(f.dataRoot,f.decision.id)[0].revisions[0];assert.equal(asset.before.version,'wrong-v1');assert.equal(asset.after.version,'corrected-v2');
 const root=join(f.directory,'eval'),e=new Evidence(root,'saved-pair'),evalCase={...representativeCases[0],grader:f.before.value};
 const plan:EvalPlan={id:'saved-pair',purpose:'Synthetic saved artifacts, actual isolated deterministic grading; no runtime execution or performance claim',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:{id:'synthetic-runtime',manifest:e.blob('[]'),bytes:2},cases:[evalCase],trials:['baseline','candidate'].map(side=>({id:side,caseId:evalCase.id,side,version:'synthetic-runtime',repeat:1,pair:'one'})),budget:{maxRequests:1,maxTokens:100,maxRequestTokens:100,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null},trialTimeoutMs:1000,gradingTimeoutMs:30000,maxOutputTokens:32,requestRetryLimit:0,price:{version:'controlled',source:'synthetic',currency:'USD',perMillionTokens:0},authorization:{scope:'run-all-listed-trials',paid:false},environment:{node:'v24.8.0',isolation:'Synthetic artifacts; regrade executes real VM',writable:'fixture',cache:'none'},mainObjective:'task',protection:['scope'],improvementConclusion:'not-evaluated'};
 const p=appendFact(e,'eval.plan',plan);e.close();await fixEvidence(root,{id:'eval-plan:saved-pair',sources:[p],purpose:'fixed synthetic plan'});
 const outcomes=new Evidence(root,plan.id);for(const t of plan.trials)appendFact(outcomes,'eval.outcome',{trialId:t.id,status:'completed',started:true,valid:true,artifacts:Object.entries({...evalCase.files,...evalCase.dirty,'math.ts':'export const add = (a: number, b: number) => a + b;\n','package-lock.json':evalCase.dependencyLock}).map(([path,content])=>({path:'project/'+path,ref:outcomes.blob(content)})),isolation:null,timing:{preparationMs:1,taskMs:1}});const last=appendFact(outcomes,'eval.closed',{synthetic:true});outcomes.close();await fixEvidence(root,{id:'eval-outcomes:saved-pair',sources:[last],purpose:'retain immutable artifacts on both sides'});
 const original=await regradeEval({dataRoot:root,id:plan.id,directory:join(f.directory,'original-grade'),revisionId:'original-check',graders:{[evalCase.id]:evalCase.grader}});assert.deepEqual(original.trials.map(t=>t.grade?.judgment),['FAIL','FAIL']);
 const revised=await regradeImproveAsset({dataRoot:f.dataRoot,decisionId:f.decision.id,decisionSource:result.sourceId,groupId:'asset',targetId:'asset',path:'grader.json',assetVersion:asset.after.version,assetDigest:asset.afterContent.sha256,evalDataRoot:root,planId:plan.id,revisionId:'corrected-asset',caseIds:[evalCase.id],directory:join(f.directory,'corrected-grade')});
 assert.deepEqual(revised.trials.map(t=>t.grade?.judgment),['PASS','PASS']);assert.deepEqual(revised.trials.map(t=>t.outcome.source),original.trials.map(t=>t.outcome.source));assert.ok(revised.trials.every(t=>t.gradeHistory[0].judgment==='FAIL'&&t.gradeHistory.length===2));assert.equal(evalFacts(root,plan.id).filter(f=>f.kind==='eval.outcome').length,2);
 const old=evalReport(root,plan.id,{asOf:original.asOf});assert.deepEqual(old.trials.map(t=>t.grade?.judgment),['FAIL','FAIL']);assert.ok(old.ruleImpact.some(i=>i.revision==='corrected-asset'));
 assert.equal(revised.regrading?.state,'completed');
 const pre=new AbortController();pre.abort();const beforeCancel=evalFacts(root,plan.id).length;
 await assert.rejects(regradeEval({dataRoot:root,id:plan.id,directory:join(f.directory,'pre-cancelled'),revisionId:'pre-cancelled',graders:{[evalCase.id]:evalCase.grader},signal:pre.signal}),/CANCELLED_BEFORE_START/);assert.equal(evalFacts(root,plan.id).length,beforeCancel);assert.equal(existsSync(join(f.directory,'pre-cancelled')),false);
 const controller=new AbortController(),cancelDirectory=join(f.directory,'cancelled-grading');
 const timer=setInterval(()=>{if(existsSync(cancelDirectory)&&readdirSync(cancelDirectory).some(name=>name.includes('-grading-')&&existsSync(join(cancelDirectory,name,'configuration.json'))))controller.abort();},10);
 let cancelled;try{cancelled=await regradeEval({dataRoot:root,id:plan.id,directory:cancelDirectory,revisionId:'cancelled-rule',graders:{[evalCase.id]:{...evalCase.grader,version:'slow-v3',program:'await new Promise(resolve=>setTimeout(resolve,30000));console.log("finished");'}},signal:controller.signal});}finally{clearInterval(timer);}
 assert.equal(cancelled.regrading?.state,'cancelled');assert.deepEqual(cancelled.regrading?.remaining,['candidate']);assert.equal(cancelled.trials[1].grade,null);assert.equal(cancelled.trials[0].grade?.judgment,'unknown');assert.equal(cancelled.trials[1].gradeHistory.length,2,'prior PASS is retained but never mixed into the cancelled revision');
 const execution=JSON.parse(readObject(root,cancelled.trials[0].grade!.execution).toString());assert.equal(execution.terminated,true);assert.equal(execution.reason,'cancelled');assert.equal(execution.observedResources.memoryBytes,536870912);
 assert.deepEqual(cancelled.trials.map(t=>t.outcome.source),original.trials.map(t=>t.outcome.source));

});
