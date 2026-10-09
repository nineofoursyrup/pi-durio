// Explicit offline acceptance demo. Runs the installed product in fresh VMs;
// its deterministic provider is an execution oracle, never model inference.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const [productArg,linuxArg,destinationArg]=process.argv.slice(2);
if(!productArg||!linuxArg||!destinationArg)throw Error('Usage: node compare-demo.mjs INSTALLED_PRODUCT LINUX_RUNTIME NEW_EVIDENCE_DIRECTORY');
const product=resolve(productArg),installation=resolve(linuxArg),directory=resolve(destinationArg);
const fromProduct=path=>import(pathToFileURL(join(product,'dist/src',path)).href);
const {prepareEval,runEval,regradeEval,evalReport,formatEvalReport}=await fromProduct('eval/runner.js');
const {representativeCases}=await fromProduct('eval/fixtures.js');
const {EvalView}=await fromProduct('tui/eval.js');
const {readObject}=await fromProduct('evidence.js');
const {evalFacts}=await fromProduct('eval/store.js');
await mkdir(directory,{recursive:false});
const root=join(directory,'data'),id='fresh-paired-01';
const save=(name,value)=>writeFile(join(directory,name),typeof value==='string'?value:JSON.stringify(value,null,2));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cases=structuredClone(representativeCases.filter(c=>['local-fix','regression'].includes(c.id)));
cases[0].grader={...cases[0].grader,version:'paired-add-v1',observations:[{name:'positive-add',path:[0],expected:5},{name:'signed-add',path:[1],expected:1}]};
cases[1].grader={...cases[1].grader,version:'paired-mean-v1',observations:[{name:'empty-mean',path:[0],expected:null}]};
const prepared=await prepareEval({dataRoot:root,id,installation,purpose:'Fresh paired product execution, fixed controlled provider; candidate adds a concise-output instruction. This exact provider ignores it, so the independent oracle is no request difference. No model-effect claim.',cases,maxOutputTokens:512,
 budget:{maxRequests:48,maxTokens:49152,maxRequestTokens:1024,deadline:new Date(Date.now()+20*60*1000).toISOString(),unknownUpperBound:null},
 trialTimeoutMs:90000,gradingTimeoutMs:30000,
 comparison:{kind:'deterministic',repetitions:2,repetitionBasis:'Two fixed pairs exercise both AB and BA execution order; exact controlled script, no stochastic stability claim.',change:'Candidate adds one concise-output instruction to the same installed runtime; the combination is evaluated as fixed.',hypothesis:'An additional concise-output instruction may affect request count; this controlled script is a no-difference execution oracle.',
  roles:{'local-fix':'objective',regression:'protection'},objective:{metric:'requests',direction:'lower',delta:1,basis:'One complete host provider dispatch is the smallest meaningful request difference for this exact script.'},
  protections:[{id:'scope',kind:'hard',check:'scope',cases:['local-fix','regression']},{id:'signed-add',kind:'hard',check:'signed-add',cases:['local-fix']},{id:'empty-mean',kind:'hard',check:'empty-mean',cases:['regression']},{id:'tokens',kind:'soft',metric:'tokens',direction:'lower',tolerance:0,basis:'Exact scripted usage is fixed at 14 tokens per request; zero token increase allowed for this deterministic wiring demonstration.',cases:['local-fix','regression']}],
  trialBudget:{maxRequests:6,maxTokens:6144},sides:{baseline:{instructions:''},candidate:{instructions:'Keep your final response concise while meeting every task requirement.'}}}});
await save('displayed-plan.json',prepared);
const report=await runEval({dataRoot:root,id,directory:join(directory,'execution')});
await save('report.json',report);await save('report.txt',formatEvalReport(report));
assert.equal(report.improvement,'无明显差异');assert.equal(report.counts.planned,8);assert.equal(report.counts.passed,8);assert.equal(report.comparison.validPairs,4);
assert.equal(report.cost.requests,28);assert.equal(report.cost.knownTokens,392);assert.equal(report.cost.missing,0);
assert.deepEqual(report.trials.map(t=>t.side),['baseline','candidate','candidate','baseline','baseline','candidate','candidate','baseline']);
assert.equal(new Set(report.trials.map(t=>t.outcome.source)).size,8);
const starts=evalFacts(root,id).filter(f=>f.kind==='eval.trial-started'),sessions=report.trials.map(t=>JSON.parse(readObject(root,t.outcome.runtimeResult).toString())),vms=report.trials.map(t=>JSON.parse(readObject(root,t.outcome.isolation).toString()));
assert.deepEqual(starts.map(f=>f.data.trialId),prepared.plan.trials.map(t=>t.id));
assert.equal(new Set(sessions.map(r=>r.runId)).size,8);assert.equal(new Set(sessions.map(r=>r.sessionId)).size,8);assert.equal(new Set(vms.map(r=>r.id)).size,8);assert.ok(vms.every(r=>r.terminated));
const initialStates=starts.map(f=>{const input=JSON.parse(readObject(root,f.data.input).toString());return{trialId:f.data.trialId,initialSha256:hash(JSON.stringify({files:input.files,dirty:input.dirty,maxOutputTokens:input.maxOutputTokens}))};});
for(let i=0;i<initialStates.length;i+=2)assert.equal(initialStates[i].initialSha256,initialStates[i+1].initialSha256);

// Only trusted grader expectations change. Deliberately wrong known-result
// material makes both add trials FAIL; this is not a product regression claim.
const grader={...cases[0].grader,version:'paired-add-deliberate-oracle-failure-v2',expectedStdout:'[6,1,0]\n'};
const revised=await regradeEval({dataRoot:root,id,directory:join(directory,'regrade'),revisionId:'deliberate-oracle-revision',graders:{'local-fix':grader}});
await save('regraded-report.json',revised);await save('regraded-report.txt',formatEvalReport(revised));
assert.equal(revised.improvement,'证据不足');assert.equal(revised.cost.requests,28);assert.equal(revised.cost.knownTokens,392);
assert.deepEqual(revised.trials.map(t=>t.outcome.source),report.trials.map(t=>t.outcome.source));
assert.equal(revised.trials.filter(t=>t.caseId==='local-fix'&&t.grade.judgment==='FAIL').length,4);
assert.ok(revised.timing.gradingMs>report.timing.gradingMs);
const preserved=JSON.parse(readObject(root,revised.gradingRevisions[0].previousReport).toString());assert.equal(preserved.improvement,'无明显差异');
await save('original-preserved-report.json',preserved);
const db=join(root,'host.sqlite'),before=hash(await readFile(db));
const reopened=evalReport(root,id),historical=evalReport(root,id,{asOf:report.asOf}),view=new EvalView(root,id);
for(const [name,args]of [['installed-report.json',[]],['installed-report.txt',['--format','text']],['installed-original-report.json',['--snapshot',String(report.asOf)]]]){
 const result=spawnSync(process.execPath,[join(product,'dist/src/cli.js'),'eval','report','--data-root',root,'--id',id,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
 await save(name,result.stdout);await save(name+'.stderr',result.stderr);assert.equal(result.status,0);
 if(name.endsWith('.json'))assert.equal(JSON.parse(result.stdout).improvement,name.includes('original')?'无明显差异':'证据不足');
}
await save('tui-current.txt',view.render(180,120).join('\n'));view.handleInput('r');await save('tui-original.txt',view.render(180,120).join('\n'));
await save('reopened-report.json',reopened);await save('historical-report.json',historical);
assert.equal(historical.improvement,'无明显差异');assert.equal(historical.ruleImpact.length,1);assert.equal(hash(await readFile(db)),before);
await assert.rejects(runEval({dataRoot:root,id,directory:join(directory,'must-not-restart')}),/EVAL_ALREADY_STARTED/);
const result={kind:'actual fresh restricted installed product with controlled provider; not model inference',product,installation,planId:id,counts:report.counts,conclusion:report.improvement,regression:report.comparison.regression.counts,requests:report.cost.requests,tokens:report.cost.knownTokens,freshness:{runIds:sessions.map(r=>r.runId),sessionIds:sessions.map(r=>r.sessionId),vmIds:vms.map(r=>r.id),allTerminated:true,initialStates,actualOrder:starts.map(f=>f.data.trialId)},regrade:{conclusion:revised.improvement,outcomesUnchanged:true,providerRequestsUnchanged:true,oldConclusion:preserved.improvement,affectedRules:revised.gradingRevisions[0].affectedRules},readonly:{sqliteSha256:before,reopen:true,tui:true,installedCli:true,oldSnapshot:true},automaticRerun:'denied',paidCalls:0};
await save('verification.json',result);console.log(JSON.stringify(result,null,2));
