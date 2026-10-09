import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,readObject} from '../src/evidence.js';
import {fixEvidence} from '../src/fixed-evidence.js';
import {appendFact,evalFacts} from '../src/eval/store.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {verifiedImage,trialVersion,validatePlan,type EvalPlan} from '../src/eval/plan.js';
import {evalReport,formatEvalReport,regradeEval} from '../src/eval/runner.js';
import {EvalView} from '../src/tui/eval.js';
import {compareTrials,pairedTrials,validateComparison,type ComparisonPlan,type ComparisonTrial} from '../src/eval/comparison.js';

function specification():ComparisonPlan{return {
 kind:'deterministic',repetitions:2,repetitionBasis:'exact controlled regression, not stochastic stability',
 change:'combined instructions and runtime candidate',hypothesis:'fewer requests with identical requirements',
 roles:{fix:'objective',guard:'protection'},objective:{metric:'requests',direction:'lower',delta:1,basis:'one complete provider request'},
 protections:[{id:'scope',kind:'hard',check:'scope',cases:['fix','guard']}],
 trialBudget:{maxRequests:8,maxTokens:8000},sides:{baseline:{runtime:{id:'a',manifest:{sha256:'a',bytes:1},bytes:1},instructions:''},candidate:{runtime:{id:'b',manifest:{sha256:'b',bytes:1},bytes:1},instructions:''}}
};}
function trial(caseId:string,repeat:number,side:'baseline'|'candidate',requests=side==='baseline'?4:2):ComparisonTrial{return {
 id:`${caseId}-${repeat}-${side}`,caseId,repeat,side,pair:`${caseId}-${repeat}`,version:side==='baseline'?'a':'b',
 outcome:{source:`outcome-${caseId}-${repeat}-${side}`,valid:true,status:'completed',timing:{taskMs:100}},
 grade:{judgment:'PASS',graderVersion:'v1',outcome:`outcome-${caseId}-${repeat}-${side}`,checks:[{name:'scope',passed:true}]},
 metrics:{requests,tokens:requests*10,cost:0,taskMs:100},metricReasons:{}
};}
function trials(){return ['fix','guard'].flatMap(c=>[1,2].flatMap(r=>[trial(c,r,'baseline'),trial(c,r,'candidate')]));}

test('fixed objective pairs improve only when every objective reaches delta and protection-only cases pass',()=>{
 const p=specification(),items=trials();
 const report=compareTrials(p,items);
 assert.equal(report.conclusion,'改善');assert.equal(report.validPairs,4);
 assert.deepEqual(report.regression.counts,{planned:4,valid:4,regressed:0,regressionRate:0,coverageRate:1});
 items.find(t=>t.id==='fix-2-candidate')!.metrics.requests=4;
 assert.equal(compareTrials(p,items).conclusion,'证据不足');
});

test('hard protection regression survives baseline task failure, incomplete pairs, cheap candidate and unrelated grader failure',()=>{
 const p=specification(),items=trials();items[0].grade!.judgment='FAIL';items[1].grade!.judgment='FAIL';items[1].grade!.checks[0].passed=false;
 items[1].metrics.requests=0;items[6].grade!.judgment='unknown';items.pop();
 const result=compareTrials(p,items);assert.equal(result.conclusion,'退化');
 assert.deepEqual(result.regression.counts,{planned:4,valid:3,regressed:1,regressionRate:1/3,coverageRate:0.75});
 const contaminated=structuredClone(items);contaminated[1].outcome.valid=false;
 assert.equal(compareTrials(p,contaminated).conclusion,'证据不足');
});

test('four conclusions retain mixed repeats, missing usage, single stochastic trial, failed-but-cheaper and missing thresholds',()=>{
 const p=specification();
 for(const [requests,expected]of [[2,'改善'],[4,'无明显差异'],[6,'退化']] as const){const items=trials();for(const t of items.filter(t=>t.side==='candidate'))t.metrics.requests=requests;assert.equal(compareTrials(p,items).conclusion,expected);}
 const failed=trials();for(const t of failed)t.grade!.judgment='FAIL';assert.equal(compareTrials(p,failed).conclusion,'证据不足');
 const missing=trials();missing[1].metrics.requests=null;assert.equal(compareTrials(p,missing).conclusion,'证据不足');
 const mixed=trials();mixed[3].metrics.requests=7;assert.equal(compareTrials(p,mixed).conclusion,'证据不足');
 assert.equal(compareTrials({...p,objective:{...p.objective,delta:null}},trials()).conclusion,'证据不足');
 assert.equal(compareTrials({...p,kind:'stochastic',repetitions:1},trials().filter(t=>t.repeat===1)).conclusion,'证据不足');
 const grader=trials();grader[1].grade!.graderVersion='new';assert.equal(compareTrials(p,grader).conclusion,'证据不足');
});

test('a soft protection needs consistent degradation within each case; a mean cannot hide a mixed repeat',()=>{
 const p=specification();p.protections.push({id:'latency',kind:'soft',metric:'taskMs',direction:'lower',tolerance:10,basis:'known-result timing tolerance, not a calibrated performance claim',cases:['guard']});
 const items=trials();for(const t of items.filter(t=>t.caseId==='guard'&&t.side==='candidate'))t.metrics.taskMs=120;
 assert.equal(compareTrials(p,items).conclusion,'退化');
 items.at(-1)!.metrics.taskMs=90;assert.equal(compareTrials(p,items).conclusion,'证据不足');
 items.at(-1)!.metrics.taskMs=110;assert.equal(compareTrials(p,items).conclusion,'证据不足');
 items[5].metrics.taskMs=110;assert.equal(compareTrials(p,items).conclusion,'改善');
});

test('a fixed plan rejects unequal pair order and a global budget that starves the later side',()=>{
 const p=specification(),schedule=pairedTrials('compare',['fix','guard'],2),budget={maxRequests:64,maxTokens:64000};
 validateComparison(p,['fix','guard'],schedule,budget);
 assert.deepEqual(schedule.slice(0,4).map(t=>t.side),['baseline','candidate','candidate','baseline']);
 assert.throws(()=>validateComparison(p,['fix','guard'],schedule,{...budget,maxRequests:63}),/FULL_PER_TRIAL/);
 const bad=structuredClone(schedule);[bad[2],bad[3]]=[bad[3],bad[2]];
 assert.throws(()=>validateComparison(p,['fix','guard'],bad,budget),/ORDER/);
 const duplicated=structuredClone(schedule);duplicated[2].pair=duplicated[0].pair;duplicated[3].pair=duplicated[0].pair;
 assert.throws(()=>validateComparison(p,['fix','guard'],duplicated,budget),/PAIR/);
});

test('known request or latency gains cannot upgrade a batch with missing price or usage; hard regressions still lead',()=>{
 for(const objective of ['requests','taskMs'] as const)for(const missing of ['cost','tokens'] as const){
  const p=specification();p.objective.metric=objective;
  const items=trials();for(const t of items.filter(t=>t.side==='candidate'))t.metrics.taskMs=90;
  items[1].metrics[missing]=null;items[1].metricReasons[missing]='unknown usage or missing fixed price';
  const result=compareTrials(p,items);assert.equal(result.conclusion,'证据不足');assert.match(JSON.stringify(result),/unknown usage or missing fixed price/);
  items[1].grade!.checks[0].passed=false;assert.equal(compareTrials(p,items).conclusion,'退化');
 }
});

async function syntheticReport(options:{missingPrice?:boolean;missingUsage?:boolean;unattributed?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'durio-paired-report-')),e=new Evidence(root,'paired');
 const c=specification();c.roles={'local-fix':'objective'};c.protections=[{id:'scope',kind:'hard',check:'scope',cases:['local-fix']}];
 c.sides.baseline.runtime=c.sides.candidate.runtime={id:'fixed-runtime',manifest:e.blob('[]'),bytes:2};
 const p:EvalPlan={id:'paired',purpose:'Known-result synthetic reporting only, no product runtime execution',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:c.sides.candidate.runtime,cases:[representativeCases[0]],trials:[],comparison:c,budget:{maxRequests:32,maxTokens:32000,maxRequestTokens:100,deadline:new Date(Date.now()+60000).toISOString(),unknownUpperBound:null},trialTimeoutMs:1000,gradingTimeoutMs:1000,maxOutputTokens:32,requestRetryLimit:0,price:{version:'known-price-v1',source:'synthetic arithmetic oracle',currency:'USD',perMillionTokens:1000},authorization:{scope:'run-all-listed-trials',paid:false},environment:{node:'v24.8.0',isolation:'synthetic facts, not actual execution',writable:'fixed',cache:'none'},mainObjective:'requests',protection:['scope'],improvementConclusion:'not-evaluated'};
 p.trials=pairedTrials(p.id,['local-fix'],2).map(t=>({...t,version:trialVersion(p,t.side)}));validatePlan(p);
 if(options.missingPrice)p.price=null;
 const source=appendFact(e,'eval.plan',p);e.close();await fixEvidence(root,{id:'eval-plan:paired',sources:[source],purpose:'synthetic comparison plan'});
 const facts=new Evidence(root,'paired');
 for(const t of p.trials){
  const outcome=appendFact(facts,'eval.outcome',{trialId:t.id,status:'completed',started:true,valid:true,artifacts:[],isolation:null,timing:{preparationMs:1,taskMs:100,gradingMs:1},runtimeResult:facts.blob(JSON.stringify({claimedTokens:0,claimedRequests:0,claimedCost:0}))});
  appendFact(facts,'eval.grade',{id:t.id,trialId:t.id,outcome,graderVersion:'node-check-v1',judgment:'PASS',reason:'synthetic known result',checks:[{name:'scope',passed:true}],at:new Date().toISOString()});
  for(let i=0;i<(t.side==='baseline'?4:2);i++){
   const id=t.id+'-'+i;facts.append('budget.reserve',{id,budgetId:p.id,operationId:t.id,purpose:'eval-runtime',tokens:100});facts.append('provider.dispatch',{id,operationId:t.id});facts.append('provider.bytes',{id,bytes:facts.blob('data: {"model":"controlled-v1"}\n\n')});facts.append('budget.settle',{id,budgetId:p.id,tokens:options.missingUsage&&t.side==='candidate'&&i===0?null:10,status:'returned'});
  }
 }
 if(options.unattributed){facts.append('budget.reserve',{id:'unknown-owner',budgetId:p.id,operationId:'unattributed',purpose:'eval-runtime',tokens:100});facts.append('provider.dispatch',{id:'unknown-owner'});facts.append('budget.settle',{id:'unknown-owner',budgetId:p.id,tokens:20,status:'returned'});}
 const closed=appendFact(facts,'eval.closed',{synthetic:true});facts.close();await fixEvidence(root,{id:'eval-outcomes:paired',sources:[closed],purpose:'known-result synthetic report arithmetic'});
 return {root,plan:p};
}

test('machine/text/TUI use host costs, keep both sides and reopen without writes; partial regrading cannot mix rules',async()=>{
 const {root,plan}=await syntheticReport(),before=readFileSync(join(root,'host.sqlite')),original=evalReport(root,plan.id);
 assert.equal(original.improvement,'改善');assert.equal(original.cost.totalValue,0.12);assert.equal(original.cost.bySide.baseline.knownTokens,80);assert.equal(original.cost.bySide.candidate.knownTokens,40);
 assert.deepEqual(original.comparison!.pairs.map(p=>p.delta),[2,2]);assert.match(formatEvalReport(original),/改善/);
 const view=new EvalView(root,plan.id);assert.match(view.render(200,200).join('\n'),/改善/);assert.deepEqual(readFileSync(join(root,'host.sqlite')),before);
 const e=new Evidence(root,plan.id),revision=appendFact(e,'eval.grader-revision',{id:'corrected-rule',graders:{'local-fix':{...plan.cases[0].grader,version:'v2'}},previousReport:e.blob(JSON.stringify(original))});
 const t=original.trials[0];const last=appendFact(e,'eval.grade',{...t.grade,source:undefined,graderVersion:'v2',revision});e.close();await fixEvidence(root,{id:'eval-grade:paired:partial',sources:[last],purpose:'preserve interrupted revision'});
 const report=evalReport(root,plan.id);assert.equal(report.improvement,'证据不足');assert.equal(report.counts.gradable,1);assert.equal(report.trials[1].grade,null);assert.equal(report.trials[1].gradeHistory.length,1);
 const prior=JSON.parse(readObject(root,report.gradingRevisions[0].previousReport).toString());assert.equal(prior.improvement,'改善');assert.equal(evalReport(root,plan.id,{asOf:original.asOf}).improvement,'改善');assert.equal(evalReport(root,plan.id,{asOf:original.asOf}).ruleImpact[0].revision,'corrected-rule');
 const revisedBytes=readFileSync(join(root,'host.sqlite')),revisedView=new EvalView(root,plan.id);assert.match(revisedView.render(200,200).join('\n'),/证据不足/);revisedView.handleInput('r');assert.match(revisedView.render(200,200).join('\n'),/效果：改善/);assert.deepEqual(readFileSync(join(root,'host.sqlite')),revisedBytes);
 assert.deepEqual(report.trials.map(t=>t.outcome.source),original.trials.map(t=>t.outcome.source));
 await assert.rejects(regradeEval({dataRoot:root,id:plan.id,directory:join(root,'bad-regrade'),revisionId:'bad-version-reuse',graders:{'local-fix':{...plan.cases[0].grader,expectedStdout:'changed rule'}}}),/GRADER_VERSION_CONTENT_CHANGED/);
 assert.equal(evalFacts(root,plan.id).filter(f=>f.kind==='eval.outcome').length,4);
});

test('the shared report retains missing prices, unknown usage and unassigned costs instead of assigning zeros or a winning side',async()=>{
 for(const options of [{missingPrice:true},{missingUsage:true},{unattributed:true}]){
  const {root}=await syntheticReport(options),report=evalReport(root,'paired');assert.equal(report.improvement,'证据不足');assert.ok(report.comparison!.evidenceGaps.length);
  if('missingPrice'in options){assert.equal(report.cost.totalValue,null);assert.equal(report.cost.priceMissing,true);assert.equal(report.cost.knownTokens,120);}
  if('missingUsage'in options){assert.equal(report.cost.totalValue,null);assert.equal(report.cost.missing,2);assert.equal(report.cost.knownTokens,100);assert.equal(report.cost.bySide.candidate.knownValue,0.02);}
  if('unattributed'in options){assert.equal(report.cost.totalValue,0.14);assert.equal(report.cost.unattributed.knownValue,0.02);assert.equal(report.cost.bySide.candidate.knownValue,0.04);}
 }
});
