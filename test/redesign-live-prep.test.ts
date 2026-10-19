import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

// Tiny JSON/file fixtures only. No product API, real credential, original
// acceptance fixture, Terminal, VM, network or provider is used by these tests.
const prep=await import(pathToFileURL(resolve('scripts/redesign-live/core.mjs')).href);
const write=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
function fixture(path:'coding'|'improve'|'eval'='coding'){
 const root=mkdtempSync(join(tmpdir(),'durio-redesign-live-prep-')),installation=join(root,'installation'),terminal=join(root,'terminal-harness'),workspace=join(root,'workspace');
 mkdirSync(join(installation,'dist/execution'),{recursive:true});mkdirSync(join(installation,'dist/src'),{recursive:true});mkdirSync(terminal);mkdirSync(workspace);
 const poison=`throw new Error('PRODUCT_IMPORT_FORBIDDEN_IN_PREP');\n`;
 writeFileSync(join(installation,'dist/src/cli.js'),poison);writeFileSync(join(terminal,'verify.mjs'),poison);
 const build=join(installation,'dist/execution/source-build.json');write(build,JSON.parse(readFileSync(resolve('dist/execution/source-build.json'),'utf8')));
 const buildSha=prep.fileRef(build).sha256,manifestPath=join(root,'manifest.json');
 write(manifestPath,{schema:'pi-durio-redesign-terminal-v1',candidate:{commit:'a'.repeat(40),tree:'b'.repeat(40)},source:{root,sourceBuildSha256:buildSha},
  installation:{root:installation,files:['dist/execution/source-build.json','dist/src/cli.js'].map(path=>({path,sha256:prep.fileRef(join(installation,path)).sha256}))},
  harness:{root:terminal,files:[{path:'verify.mjs',sha256:prep.fileRef(join(terminal,'verify.mjs')).sha256}]},runtime:{node:process.version,platform:process.platform,arch:process.arch},synthetic:true,nativeAcceptance:'NOT_RUN'});
 const cases=prep.caseTemplate();cases.cases=[{id:'synthetic-counter',category:'no-change',visibility:'public-development',input:'Synthetic fixture only: read counter and preserve the note.',files:{'counter.ts':'export const count = 3;\n','note.txt':'initial\n'},dirty:{'note.txt':'user draft\n'},writable:[],dependencyLock:'{"lockfileVersion":3,"packages":{}}',grader:{version:'synthetic-g1',program:'console.log(3)',expectedStdout:'3\n',required:['counter stays 3','dirty note remains exact']}}];
 const casesPath=join(root,'cases.json');write(casesPath,cases);
 for(const [name,content]of Object.entries({...cases.cases[0].files,...cases.cases[0].dirty,'package-lock.json':cases.cases[0].dependencyLock}))writeFileSync(join(workspace,name),String(content));
 const plan=prep.planTemplate(path),planPath=join(root,'plan.json'),grantPath=join(root,'grant.json'),now=Date.now();
 Object.assign(plan,{id:`synthetic-${path}`,synthetic:true,candidateManifest:prep.fileRef(manifestPath),cases:prep.fileRef(casesPath),repetitions:1,execution:{workspace,dataRoot:join(root,'data')}});
 plan.version.sourceBuildSha256=buildSha;plan.price={...JSON.parse(readFileSync(build,'utf8')).redesignLive.price};
 Object.assign(plan.budget,{maxRequests:16,maxTokens:2162688,maxRequestTokens:1081344,maxOutputTokens:32768,deadline:new Date(now+7200000).toISOString(),cnyCeiling:20,enforcement:'operator-observed'});
 if(path!=='eval')plan.budget.maxDurationMs=600000;
 if(path==='improve'){
  Object.assign(plan.route,{sessionId:'s-synthetic',targetRunId:'synthetic-run',scope:'session',tier:'standard',focus:'Synthetic plan validation only'});plan.budget.enforcement='product-analysis-tier';
 }
 if(path==='eval'){
  Object.assign(plan.budget,{maxOutputTokens:4096,maxRequestTokens:1052672,enforcement:'product-fixed-plan'});
  const reportPath=join(root,'eval-report.json'),runtimePath=join(root,'runtime.json');
  const product={id:'synthetic-eval-plan',purpose:'Synthetic metadata for PREP test',mode:'live',runtime:{id:'synthetic-runtime'},image:`synthetic@sha256:${'c'.repeat(64)}`,model:{provider:'deepseek',id:'deepseek-flash'},cases:cases.cases,trials:[{id:'synthetic-trial',caseId:cases.cases[0].id,version:'synthetic-runtime',side:'candidate',repeat:1,pair:null}],budget:{maxRequests:plan.budget.maxRequests,maxTokens:plan.budget.maxTokens,maxRequestTokens:plan.budget.maxRequestTokens,deadline:plan.budget.deadline,unknownUpperBound:{tokens:1052672,source:'https://api-docs.deepseek.com/api/list-models/'}},maxOutputTokens:4096,requestRetryLimit:0,trialTimeoutMs:30000,gradingTimeoutMs:10000,price:plan.price,authorization:{paid:true,scope:'run-all-listed-trials'},environment:{node:'v24.8.0',isolation:'synthetic metadata; no VM',cache:'read-only',writable:'fresh'}};
  write(reportPath,{plan:product,planSource:'synthetic-e1',batch:{startedAt:null},counts:{started:0}});
  write(runtimePath,{sourceBuildSha256:buildSha,runtimeId:product.runtime.id,image:product.image,node:product.environment.node,platform:'linux',arch:'arm64',installationManifestSha256:'d'.repeat(64)});
  Object.assign(plan.route,{planId:product.id,report:prep.fileRef(reportPath),runtimeManifest:prep.fileRef(runtimePath)});
 }
 const grant={...prep.grantTemplate(),paidApproved:true,by:'SYNTHETIC test fixture',exactHumanReply:'SYNTHETIC ONLY; no real approval or payment',grantedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),manualBudgetAccepted:true};
 const persist=()=>{write(planPath,plan);grant.planSha256=prep.fileRef(planPath).sha256;write(grantPath,grant);};persist();
 return{root,installation,workspace,plan,planPath,grant,grantPath,manifestPath,casesPath,persist};
}
function codes(result:any){return result.issues.map((i:any)=>i.code);}

test('PREP templates refuse before imports, credentials, dispatch or output cards',()=>{
 const root=mkdtempSync(join(tmpdir(),'durio-redesign-live-cli-')),planPath=join(root,'plan.json'),grantPath=join(root,'grant.json');
 const cli=resolve('scripts/redesign-live/cli.mjs');
 const run=(args:string[])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{PATH:process.env.PATH??''}});
 assert.equal(run(['template','--kind','plan','--path','coding','--out',planPath]).status,0);
 assert.equal(run(['template','--kind','grant','--out',grantPath]).status,0);
 const grant=JSON.parse(readFileSync(grantPath,'utf8'));assert.equal(grant.paidApproved,false);assert.equal(grant.manualBudgetAccepted,false);
 const checked=run(['validate','--plan',planPath,'--grant',grantPath]);assert.equal(checked.status,2,checked.stderr);
 const body=JSON.parse(checked.stdout);for(const code of ['CASES_REQUIRED','REPETITIONS_REQUIRED','VERSION_REQUIRED','CNY_PRICE_REQUIRED','BUDGET_REQUIRED','DEADLINE_REQUIRED','AUTHORIZATION_REQUIRED'])assert.ok(codes(body).includes(code),code);
 const output=join(root,'never-created.json');assert.equal(run(['freeze','--plan',planPath,'--grant',grantPath,'--out',output]).status,2);assert.equal(existsSync(output),false);
 assert.equal(run(['template','--kind','grant','--out',grantPath]).status,2,'old output is immutable');
 assert.equal(existsSync(join(root,'data')),false);
});

test('coding manual supervision is explicit; fixture, identity, price, grant and cutoff fail closed',()=>{
 const f=fixture();assert.equal(prep.validate(f.planPath,f.grantPath).status,'SYNTHETIC_VALID');
 assert.equal(prep.checkWorkspace(f.planPath).status,'FIXTURE_BYTES_MATCH');
 f.plan.budget.enforcement='product-hard-limit';f.persist();assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('CODING_TUI_BUDGET_NOT_EXPOSED'));
 f.plan.budget.enforcement='operator-observed';f.grant.manualBudgetAccepted=false;f.persist();assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('MANUAL_BUDGET_AUTHORIZATION'));
 f.grant.manualBudgetAccepted=true;f.persist();writeFileSync(join(f.workspace,'note.txt'),'lost user draft\n');assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('WORKSPACE_CASE_MISMATCH'));
 writeFileSync(join(f.workspace,'note.txt'),'user draft\n');
 f.plan.price.currency='USD';f.persist();assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('CNY_PRICE_REQUIRED'));
 f.plan.price.currency='CNY';f.plan.budget.deadline='2000-01-01T00:00:00Z';f.persist();assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('DEADLINE_REQUIRED'));
 f.plan.budget.deadline=new Date(Date.now()+7200000).toISOString();f.persist();f.grant.planSha256='0'.repeat(64);write(f.grantPath,f.grant);assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('AUTHORIZATION_REQUIRED'));
 f.persist();writeFileSync(join(f.installation,'extra.js'),'unlisted');assert.ok(codes(prep.validate(f.planPath,f.grantPath)).includes('CANDIDATE_INVALID'));
 assert.equal(existsSync(f.plan.execution.dataRoot),false,'only synthetic metadata/fixture reads occurred');
});

test('improve uses exact product tiers and leaves unknown candidates unselected; eval binds every trial and budget',()=>{
 const improve=fixture('improve');assert.equal(prep.validate(improve.planPath,improve.grantPath).status,'SYNTHETIC_VALID');
 improve.plan.budget.maxRequests=1;improve.persist();assert.ok(codes(prep.validate(improve.planPath,improve.grantPath)).includes('TUI_TIER_LIMIT_MISMATCH'));
 improve.plan.budget.maxRequests=16;improve.plan.route.selection={candidateId:'invented'};improve.persist();assert.ok(codes(prep.validate(improve.planPath,improve.grantPath)).includes('ANALYSIS_ONLY'));
 const evaluation=fixture('eval');assert.equal(prep.validate(evaluation.planPath,evaluation.grantPath).status,'SYNTHETIC_VALID');
 const reportPath=evaluation.plan.route.report.path,report=JSON.parse(readFileSync(reportPath,'utf8'));
 report.plan.trials=[];write(reportPath,report);evaluation.plan.route.report=prep.fileRef(reportPath);evaluation.persist();assert.ok(codes(prep.validate(evaluation.planPath,evaluation.grantPath)).includes('EVAL_ALL_TRIALS'));
 report.batch.startedAt=new Date().toISOString();write(reportPath,report);evaluation.plan.route.report=prep.fileRef(reportPath);evaluation.persist();assert.ok(codes(prep.validate(evaluation.planPath,evaluation.grantPath)).includes('FIXED_UNSTARTED_EVAL'));
});

test('frozen PREP refuses changed referenced content, overwrite and synthetic real-command promotion',()=>{
 const f=fixture('improve'),frozen=join(f.root,'frozen.json');prep.freeze(f.planPath,f.grantPath,frozen);
 assert.equal(prep.verifyFrozen(frozen).checked.status,'SYNTHETIC_VALID');
 assert.throws(()=>prep.commands(frozen),/SYNTHETIC_CANNOT_AUTHORIZE_REAL_COMMANDS/);
 assert.throws(()=>prep.freeze(f.planPath,f.grantPath,frozen),/EEXIST/);
 f.plan.route.focus='Changed after freeze';f.persist();assert.throws(()=>prep.verifyFrozen(frozen),/FIXED_FILE_CHANGED/);
});

test('evidence processing keeps all paths, first failure, unknown costs and synthetic provenance',()=>{
 const f=fixture(),input=prep.observationTemplate(),inputPath=join(f.root,'observations.json'),evidencePath=join(f.root,'synthetic-evidence.json');write(evidencePath,{synthetic:true,claim:'evidence processing only'});
 input.candidateManifest=f.plan.candidateManifest;input.plans=[prep.fileRef(f.planPath)];
 const evidence=prep.EVIDENCE.coding.map((slot:string)=>({slot,file:prep.fileRef(evidencePath)}));
 input.observations=[{id:'synthetic-pass',planSha256:input.plans[0].sha256,at:'2026-10-17T00:00:00Z',status:'PASS',conclusionBasis:'Synthetic metadata only',evidence,cost:{}}];write(inputPath,input);
 let result=prep.report(inputPath);assert.deepEqual(result.paths.map((p:any)=>p.realStatus),['NOT_RUN','NOT_RUN','NOT_RUN']);assert.equal(result.cost.totalCny,null);assert.equal(result.cost.knownPartCny,null);assert.equal(result.cost.unknownRequests,null);
 // Explicitly exercise the real-observation projection with fixture JSON; this
 // does not run any path or claim this metadata is authentic provider evidence.
 f.plan.synthetic=false;f.persist();input.plans=[prep.fileRef(f.planPath)];write(inputPath,input);
 assert.throws(()=>prep.report(inputPath),/OBSERVATION_PLAN_BINDING/,'a plan cannot relabel a synthetic manifest as real');
 const projectionManifest=JSON.parse(readFileSync(f.manifestPath,'utf8'));projectionManifest.synthetic=false;write(f.manifestPath,projectionManifest);
 f.plan.candidateManifest=prep.fileRef(f.manifestPath);f.persist();input.candidateManifest=f.plan.candidateManifest;input.plans=[prep.fileRef(f.planPath)];
 const base={planSha256:input.plans[0].sha256,conclusionBasis:'Projection fixture',evidence,cost:{scopeId:'synthetic-host-scope',basis:'host-ledger',through:10,knownCny:1,unknownRequests:1,complete:false,priceVersion:f.plan.price.version}};
 input.observations=[{...base,id:'first-failure',at:'2026-10-17T00:00:00Z',status:'FAIL'}, {...base,id:'later-readback',at:'2026-10-17T00:01:00Z',status:'PASS'}];write(inputPath,input);
 result=prep.report(inputPath);assert.equal(result.paths[0].realStatus,'FAIL');assert.equal(result.paths[0].firstFailure,'first-failure');assert.equal(result.paths[0].observations.length,2);assert.equal(result.cost.knownPartCny,1,'same host scope is not charged twice');assert.equal(result.cost.totalCny,null);assert.equal(result.cost.unknownRequests,1);
 input.observations[1].cost={...base.cost,knownCny:2};write(inputPath,input);assert.throws(()=>prep.report(inputPath),/COST_SAME_WATERMARK_CONFLICT/);
 input.observations[1].cost=base.cost;input.observations[1].evidence=[];write(inputPath,input);assert.throws(()=>prep.report(inputPath),/PASS_REQUIRES_EACH_OBSERVATION/);
 input.observations[1].evidence=evidence;
 for(const row of input.observations)row.cost={...base.cost,unknownRequests:0,complete:true};
 write(inputPath,input);assert.equal(prep.report(inputPath).cost.totalCny,1,'complete cumulative scope is counted once');
 const pendingPlanPath=join(f.root,'unobserved-plan.json');write(pendingPlanPath,{...f.plan,id:'synthetic-unobserved-plan'});input.plans.push(prep.fileRef(pendingPlanPath));write(inputPath,input);
 result=prep.report(inputPath);assert.equal(result.cost.complete,false);assert.equal(result.cost.totalCny,null);assert.equal(result.cost.unknownRequests,null,'an unobserved plan is not zero cost or zero unknown requests');
});
