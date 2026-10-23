/** #93 PREP only. Built-ins, JSON and hashes only: no product imports, credential
 * lookup, child processes, terminal control, provider requests or VM dispatch. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,readdirSync,readlinkSync} from 'node:fs';
import {isAbsolute,join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const SCHEMA='pi-durio-redesign-live-v1';
export const PATHS=['coding','improve','eval'];
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string'&&value.trim().length>0&&!/[\u0000\u001b\u007f]/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value);
const equal=isDeepStrictEqual;
const emptyRef=()=>({path:null,sha256:null});
const directory=dirname(fileURLToPath(import.meta.url));
export const STATES=['PASS','FAIL','UNKNOWN','NOT_RUN','BLOCKED','EVIDENCE_INSUFFICIENT'];
export const EVIDENCE={
 coding:['native-1a','native-1b','task-result','requirements','exit-summary-1f','cleanup','readback','cost'],
 improve:['real-analysis','actual-candidate','selection','validation','writeback-or-effective-task','readback','cleanup','cost'],
 eval:['fixed-plan','tui-2b-confirmation','all-trials','host-budget','cleanup','readback','cost'],
};
// The final candidate carries this versioned data contract. Full source/output
// identity remains pinned by its source-build hash and installation inventory.
const INTERFACE_SCHEMA='pi-durio-redesign-live-interface-v1';

export function planTemplate(path){
 if(!PATHS.includes(path))throw Error('PATH_REQUIRED: coding|improve|eval');
 return {schema:SCHEMA,id:null,path,synthetic:false,candidateManifest:emptyRef(),cases:emptyRef(),
  version:{sourceBuildSha256:null,provider:'deepseek',model:'deepseek-flash',configuration:'default; no enabled improve overrides'},
  repetitions:null,execution:{workspace:null,dataRoot:null},
  price:{currency:'CNY',version:null,source:null,consultedAt:null,perMillionTokens:null},
  budget:{maxRequests:null,maxTokens:null,maxRequestTokens:null,maxOutputTokens:null,...(path==='eval'?{}:{maxDurationMs:null}),deadline:null,requestRetryLimit:0,cnyCeiling:null,enforcement:null},
  route:path==='improve'?{sessionId:null,targetRunId:null,scope:null,tier:null,focus:null,sources:[],selection:null}:path==='eval'?{planId:null,report:emptyRef(),runtimeManifest:emptyRef()}: {},
  stops:['401/403 or provider unavailable','budget/deadline/unknown usage without a proven bound','failure, cancellation, drift or cleanup unknown: keep remaining NOT_RUN; no automatic repeat'],
  observedRequirements:EVIDENCE[path],authorization:'Separate human grant bound to these exact plan bytes; this template grants nothing'};
}
export const grantTemplate=()=>({schema:`${SCHEMA}-grant`,paidApproved:false,planSha256:null,by:null,exactHumanReply:null,grantedAt:null,expiresAt:null,credentialEnvironment:'DEEPSEEK_API_KEY',manualBudgetAccepted:false});
export const caseTemplate=()=>({schema:`${SCHEMA}-cases`,cases:[{id:null,category:null,visibility:'public-development',input:null,files:{},dirty:{},writable:[],dependencyLock:null,grader:{version:null,program:null,expectedStdout:null,required:[]}}]});
export const observationTemplate=()=>({schema:`${SCHEMA}-observations`,candidateManifest:emptyRef(),plans:[],observations:[],
 rowTemplate:{id:null,planSha256:null,at:null,status:'NOT_RUN',conclusionBasis:null,evidence:[],cost:{scopeId:null,basis:null,through:null,knownCny:null,unknownRequests:null,complete:false,priceVersion:null},firstFailure:null},
 syntheticControls:{stop:{status:'NOT_RUN',evidence:[]},regrade:{status:'NOT_RUN',evidence:[]},exitStop:{status:'NOT_RUN',evidence:[]}},note:'Copy rowTemplate only for a supplied observation. Keep each unique id, original artifact and first failure; never replace an earlier observation.'});

function ordinary(path,allowCredentialSourceNames=false){
 if(!isAbsolute(path)||/(?:^|\/)(?:api\.env|\.env(?:\.[^/]*)?|auth\.json)$/i.test(path)||!allowCredentialSourceNames&&/(?:^|\/)credentials[^/]*$/i.test(path))throw Error('ORDINARY_NON_CREDENTIAL_FILE_REQUIRED');
 const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw Error('REGULAR_FILE_REQUIRED');
 return path;
}
export function json(path){
 ordinary(resolve(path));if(!path.endsWith('.json'))throw Error('JSON_FILE_REQUIRED');
 if(lstatSync(path).size>16*1024*1024)throw Error('JSON_TOO_LARGE');
 return JSON.parse(readFileSync(path,'utf8'));
}
export function fileRef(path){const absolute=ordinary(resolve(path));return{path:absolute,sha256:sha(readFileSync(absolute))};}
export function readRef(ref){
 if(!ref||!isAbsolute(ref.path??'')||!hex(ref.sha256))throw Error('FIXED_FILE_REFERENCE_REQUIRED');
 if(fileRef(ref.path).sha256!==ref.sha256)throw Error('FIXED_FILE_CHANGED');
 return json(ref.path);
}
export const save=(path,value)=>writeFileSync(resolve(path),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function relativeFile(path){return typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..');}
function inventory(root,prefix='',allowCredentialSourceNames=false){
 if(!isAbsolute(root)||lstatSync(root).isSymbolicLink())throw Error('MANIFEST_ROOT_REQUIRED');
 return readdirSync(join(root,prefix)).sort().flatMap(name=>{
  const path=prefix?`${prefix}/${name}`:name,full=join(root,path),info=lstatSync(full);
  if(info.isSymbolicLink())return[{path,sha256:`link:${readlinkSync(full)}`}];
  if(info.isDirectory())return inventory(root,path,allowCredentialSourceNames);
  if(!info.isFile())throw Error('MANIFEST_FILE_TYPE');
  return[{path,sha256:sha(readFileSync(ordinary(full,allowCredentialSourceNames)))}];
 });
}
function verifyTree(tree,allowCredentialSourceNames=false){
 if(!tree||!Array.isArray(tree.files)||!tree.files.length||!tree.files.every(f=>relativeFile(f.path)&&typeof f.sha256==='string'))throw Error('MANIFEST_FILES_REQUIRED');
 const sort=items=>[...items].sort((a,b)=>a.path.localeCompare(b.path));
 if(!equal(sort(inventory(tree.root,'',allowCredentialSourceNames)),sort(tree.files.map(({path,sha256})=>({path,sha256})))))throw Error('MANIFEST_FILES_CHANGED');
}
export function candidate(ref,synthetic){
 const value=readRef(ref);
 if(value.schema!=='pi-durio-redesign-terminal-v1'||value.synthetic!==synthetic||!/^([a-f0-9]{40})$/.test(value.candidate?.commit)||!/^([a-f0-9]{40})$/.test(value.candidate?.tree)||!hex(value.source?.sourceBuildSha256))throw Error('SHARED_CANDIDATE_REQUIRED');
 // SDK credentials* source names are allowed only during candidate tree hashing.
 verifyTree(value.installation,true);verifyTree(value.harness,true);
 const buildPath=join(value.installation.root,'dist/execution/source-build.json'),build=readRef({path:buildPath,sha256:value.source.sourceBuildSha256});
 if(build.redesignLive?.schema!==INTERFACE_SCHEMA||!build.redesignLive.price||!['standard','large'].every(tier=>build.redesignLive.improveLimits?.[tier]))throw Error('LIVE_INTERFACE_CONTRACT_REQUIRED: rebuild the candidate');
 if(!synthetic&&(value.runtime?.node!==process.version||value.runtime?.platform!==process.platform||value.runtime?.arch!==process.arch))throw Error('PREP_NODE_OR_PLATFORM_CHANGED');
 return {...value,liveInterface:build.redesignLive};
}
function casesValid(value){
 if(value?.schema!==`${SCHEMA}-cases`||!Array.isArray(value.cases)||value.cases.length<1||value.cases.length>16||new Set(value.cases.map(c=>c.id)).size!==value.cases.length)return false;
 return value.cases.every(c=>text(c.id)&&text(c.input)&&['local-fix','multi-file','regression','no-change'].includes(c.category)&&c.visibility==='public-development'&&c.files&&Object.keys(c.files).length>0&&Object.values(c.files).every(x=>typeof x==='string')&&c.dirty&&Object.values(c.dirty).every(x=>typeof x==='string')&&Array.isArray(c.writable)&&[...Object.keys(c.files),...Object.keys(c.dirty),...c.writable].every(relativeFile)&&text(c.dependencyLock)&&text(c.grader?.version)&&typeof c.grader.program==='string'&&c.grader.program.trim()&&typeof c.grader.expectedStdout==='string'&&Array.isArray(c.grader.required)&&c.grader.required.length>0&&c.grader.required.every(text));
}

/** The operator prepares this new directory. Validation only compares bytes:
 * retained dirty input overlays files; the fixed dependencyLock is package-lock.json. */
export function checkWorkspace(planPath){
 const plan=json(resolve(planPath)),document=readRef(plan.cases);
 if(!['coding','improve'].includes(plan.path)||!casesValid(document)||document.cases.length!==1)throw Error('ONE_NATIVE_CASE_REQUIRED');
 const c=document.cases[0],files={...c.files,...c.dirty,'package-lock.json':c.dependencyLock};
 if(c.files['package-lock.json']!==undefined&&c.files['package-lock.json']!==c.dependencyLock||c.dirty['package-lock.json']!==undefined&&c.dirty['package-lock.json']!==c.dependencyLock)throw Error('CASE_LOCK_CONFLICT');
 const expected=Object.entries(files).map(([path,content])=>({path,sha256:sha(content)}));
 verifyTree({root:plan.execution?.workspace,files:expected});
 return{status:'FIXTURE_BYTES_MATCH',workspace:plan.execution.workspace,cases:plan.cases,files:expected,productStarted:false};
}

/** Structured refusal is returned before command-card creation. Validation reads
 * only explicitly named metadata/artifacts and the shared installation manifest. */
export function validate(planPath,grantPath,{now=Date.now()}={}){
 const plan=json(resolve(planPath)),issues=[];
 const fail=(code,field,detail)=>issues.push({code,field,detail});
 const require=(condition,code,field,detail)=>{if(!condition)fail(code,field,detail);};
 require(plan.schema===SCHEMA&&PATHS.includes(plan.path),'PLAN_SCHEMA','schema/path','Use a new #93 template.');
 require(text(plan.id)&&/^[a-zA-Z0-9_-]{1,80}$/.test(plan.id),'PLAN_ID','id','Fix a unique one-run identity.');
 require(typeof plan.synthetic==='boolean','PROVENANCE_REQUIRED','synthetic','Explicit real or synthetic provenance required.');
 let manifest,caseDocument,grant,productReport;
 try{manifest=candidate(plan.candidateManifest,plan.synthetic);}catch(error){fail('CANDIDATE_INVALID','candidateManifest',String(error.message));}
 try{caseDocument=readRef(plan.cases);require(casesValid(caseDocument),'CASES_REQUIRED','cases','Fix input, complete fixture/dirty/lock, writable scope and independent required checks.');}catch(error){fail('CASES_REQUIRED','cases',String(error.message));}
 if(plan.path!=='eval'&&casesValid(caseDocument))try{checkWorkspace(planPath);}catch(error){fail('WORKSPACE_CASE_MISMATCH','execution.workspace',String(error.message));}
 require(positive(plan.repetitions),'REPETITIONS_REQUIRED','repetitions','Fix the count before execution.');
 if(plan.path!=='eval')require(plan.repetitions===1&&caseDocument?.cases?.length===1,'A1_ONE_PATH','repetitions/cases','One coding task or one improve analysis; no automatic replacement attempt.');
 require(isAbsolute(plan.execution?.workspace??'')&&isAbsolute(plan.execution?.dataRoot??'')&&plan.execution.workspace!==plan.execution.dataRoot,'EXECUTION_PATHS','execution','Fix distinct absolute workspace and data root.');
 require(hex(plan.version?.sourceBuildSha256)&&plan.version.sourceBuildSha256===manifest?.source.sourceBuildSha256&&plan.version.provider==='deepseek'&&plan.version.model==='deepseek-flash'&&plan.version.configuration==='default; no enabled improve overrides','VERSION_REQUIRED','version','Bind the final shared build/model/default configuration; retain the actual execution.config at runtime.');
 require(!!manifest&&equal(plan.price,manifest.liveInterface.price),'CNY_PRICE_REQUIRED','price','Use the pinned host CNY peak-output table, including source/version/consulted date; verify applicability before authorizing. Old USD grants do not apply.');
 const b=plan.budget??{};
 for(const key of ['maxRequests','maxTokens','maxRequestTokens','maxOutputTokens',...(plan.path==='eval'?[]:['maxDurationMs'])])require(positive(b[key]),'BUDGET_REQUIRED',`budget.${key}`,'A fixed positive integer is required.');
 require(b.requestRetryLimit===0,'RETRY_LIMIT','budget.requestRetryLimit','Current paths disable automatic request retries; do not add replacement trials.');
 require(b.maxRequestTokens<=b.maxTokens&&b.maxRequestTokens>=1048576+b.maxOutputTokens,'REQUEST_BOUND','budget.maxRequestTokens','Retain the context plus output upper bound within the total.');
 require(Number.isFinite(b.cnyCeiling)&&b.cnyCeiling>0&&Number.isFinite(plan.price?.perMillionTokens)&&b.cnyCeiling>=b.maxTokens*plan.price.perMillionTokens/1e6,'CNY_CEILING_REQUIRED','budget.cnyCeiling','Cover the token ceiling at the fixed peak output price; this is an estimate, not an account spend cap.');
 require(iso(b.deadline)&&Date.parse(b.deadline)>now,'DEADLINE_REQUIRED','budget.deadline','Fix an unexpired absolute cutoff; never restart its clock.');
 require(Array.isArray(plan.stops)&&plan.stops.length>0&&plan.stops.every(text)&&equal(plan.observedRequirements,EVIDENCE[plan.path]),'OBSERVATIONS_REQUIRED','stops/observedRequirements','Retain every planned observation and stop rule.');
 try{
  grant=grantPath?json(resolve(grantPath)):null;
  require(grant?.schema===`${SCHEMA}-grant`&&grant?.paidApproved===true&&grant.planSha256===fileRef(planPath).sha256&&text(grant.by)&&text(grant.exactHumanReply),'AUTHORIZATION_REQUIRED','grant','Exact direct human approval must bind this complete plan; PREP is not approval.');
  require(iso(grant?.grantedAt)&&Date.parse(grant.grantedAt)<=now&&iso(grant?.expiresAt)&&Date.parse(grant.expiresAt)>now&&Date.parse(grant.expiresAt)<=Date.parse(b.deadline),'GRANT_WINDOW','grant','Unexpired approval cannot extend the plan cutoff.');
  require(grant?.credentialEnvironment==='DEEPSEEK_API_KEY'&&!Object.keys(grant??{}).some(k=>!Object.keys(grantTemplate()).includes(k)),'CREDENTIAL_REFERENCE_ONLY','grant','Only the environment variable name is permitted; no key, path or credential contents.');
 }catch(error){fail('AUTHORIZATION_REQUIRED','grant',String(error.message));}
 if(plan.path==='coding'){
  require(b.enforcement==='operator-observed','CODING_TUI_BUDGET_NOT_EXPOSED','budget.enforcement','TuiOptions and the interactive CLI do not expose aggregate tokens/CNY/absolute cutoff. A product-hard-limit plan is blocked; an operator-observed plan requires explicit human acceptance.');
  require(grant?.manualBudgetAccepted===true,'MANUAL_BUDGET_AUTHORIZATION','grant.manualBudgetAccepted','Do not infer acceptance of manual supervision from a general paid grant.');
 }
 if(plan.path==='improve'){
  const r=plan.route??{},fixed=manifest?.liveInterface.improveLimits[r.tier];
  require(['session','7d','30d'].includes(r.scope)&&['standard','large'].includes(r.tier)&&text(r.sessionId)&&text(r.targetRunId)&&text(r.focus)&&!/[\r\n]/.test(r.focus),'IMPROVE_TARGET_REQUIRED','route','Fix the real session/run, scope, tier and single-line analysis focus.');
  require(Array.isArray(r.sources)&&r.sources.length===0&&r.selection===null,'ANALYSIS_ONLY','route.sources/selection','This minimal path uses recorded project sources only; no unknown future candidate can be selected.');
  require(b.enforcement==='product-analysis-tier'&&!!fixed&&Object.entries(fixed).every(([key,value])=>b[key]===value),'TUI_TIER_LIMIT_MISMATCH','budget','Use the exact standard/large stage limits; /improve new does not accept custom lower limits.');
  require(!!fixed&&iso(b.deadline)&&now+fixed.maxDurationMs<Date.parse(b.deadline),'ANALYSIS_START_WINDOW','budget.deadline','The TUI starts a relative stage timer; validate immediately before confirmation, never queue, and start before cutoff minus the full stage duration.');
 }
 if(plan.path==='eval'){
  try{
   productReport=readRef(plan.route?.report);const p=productReport.plan;
   require(!('maxDurationMs'in b),'EVAL_UNSUPPORTED_LIMIT','budget.maxDurationMs','The fixed eval interface enforces its absolute deadline plus trial/grading timeouts; it has no separate overall duration parameter.');
   require(!p?.comparison,'MINIMAL_DIAGNOSTIC_PLAN','route.report.plan.comparison','This A1 adapter prepares a minimal single-side diagnostic plan, not a fresh improvement comparison.');
   require(p?.mode==='live'&&p.authorization?.paid===true&&p.authorization.scope==='run-all-listed-trials'&&p.id===plan.route.planId&&text(productReport.planSource)&&productReport.batch?.startedAt===null&&productReport.counts?.started===0,'FIXED_UNSTARTED_EVAL','route.report','Export the real, fixed, not-started product eval report. A plan runs once; command cards cannot resume it.');
   require(equal(p?.cases,caseDocument?.cases)&&p?.model?.provider===plan.version?.provider&&p?.model?.id===plan.version?.model,'EVAL_CASE_VERSION_MISMATCH','route.report.plan','Frozen cases and configured model must match.');
   require(/^[a-zA-Z0-9_-]{1,80}$/.test(p?.id??'')&&Array.isArray(p?.trials)&&p.trials.length>0&&p.trials.length===p.cases.length*plan.repetitions&&p.trials.every(t=>p.cases.some(c=>c.id===t.caseId)&&t.side==='candidate'&&t.version===p.runtime?.id&&positive(t.repeat)&&t.repeat<=plan.repetitions&&!t.scenario)&&p.cases.every(c=>Array.from({length:plan.repetitions},(_,i)=>i+1).every(repeat=>p.trials.filter(t=>t.caseId===c.id&&t.repeat===repeat).length===1))&&new Set(p.trials.map(t=>t.id)).size===p.trials.length,'EVAL_ALL_TRIALS','route.report.plan.trials','Keep every case, version, repetition and planned order; no synthetic scenarios.');
   require(b.enforcement==='product-fixed-plan'&&p?.budget?.maxRequests===b.maxRequests&&p.budget.maxTokens===b.maxTokens&&p.budget.maxRequestTokens===b.maxRequestTokens&&p.budget.deadline===b.deadline&&p.maxOutputTokens===b.maxOutputTokens&&p.requestRetryLimit===b.requestRetryLimit&&p.budget.unknownUpperBound?.tokens>=b.maxRequestTokens&&/^https:\/\/api-docs\.deepseek\.com\//.test(p.budget.unknownUpperBound?.source??'')&&equal(p.price,plan.price),'EVAL_BUDGET_MISMATCH','route.report.plan','Product admission limits and CNY peak-price metadata must equal the authorized plan.');
   require(positive(p?.trialTimeoutMs)&&p.trialTimeoutMs<=300000&&positive(p?.gradingTimeoutMs)&&p.gradingTimeoutMs<=300000&&p.environment?.isolation&&p.environment?.cache&&p.environment?.writable,'EVAL_ENVIRONMENT_REQUIRED','route.report.plan','Fix isolation, writable/cache conditions and separate trial/grading timeouts.');
   const runtime=readRef(plan.route?.runtimeManifest);
   require(runtime.sourceBuildSha256===manifest?.source.sourceBuildSha256&&runtime.runtimeId===p?.runtime?.id&&runtime.image===p?.image&&runtime.node===p?.environment?.node&&runtime.platform==='linux'&&runtime.arch==='arm64'&&hex(runtime.installationManifestSha256),'EVAL_RUNTIME_REQUIRED','route.runtimeManifest','Bind the separately prepared real Linux runtime/installation and source build to the product plan. This check does not run or validate VM isolation.');
  }catch(error){fail('FIXED_EVAL_REQUIRED','route',String(error.message));}
 }
 return {schema:`${SCHEMA}-validation`,status:issues.length?'BLOCKED':plan.synthetic?'SYNTHETIC_VALID':'PREP_VALID',path:plan.path,plan:planPath,planSha256:fileRef(planPath).sha256,candidateManifest:plan.candidateManifest,issues,planValue:plan,manifest,grant,caseDocument,productReport,checkedAt:new Date(now).toISOString(),paidRun:'NOT_RUN',nativeAcceptance:'NOT_RUN'};
}

export function publicValidation(result){const {planValue,manifest,grant,caseDocument,productReport,...summary}=result;return summary;}
export function harness(){return ['core.mjs','cli.mjs','README.md'].map(name=>fileRef(join(directory,name)));}
export function freeze(planPath,grantPath,output){
 const checked=validate(planPath,grantPath);if(checked.issues.length)throw Error('PLAN_BLOCKED: run validate for exact missing fields');
 const frozen={schema:`${SCHEMA}-frozen`,plan:fileRef(planPath),grant:fileRef(grantPath),candidateManifest:checked.planValue.candidateManifest,harness:harness(),frozenAt:new Date().toISOString(),synthetic:checked.planValue.synthetic,status:'PREP_FROZEN_NOT_RUN'};
 save(output,frozen);return frozen;
}
export function verifyFrozen(path){
 const frozen=json(resolve(path));if(frozen.schema!==`${SCHEMA}-frozen`)throw Error('FROZEN_SCHEMA');
 readRef(frozen.plan);readRef(frozen.grant);
 if(!equal(frozen.harness,harness()))throw Error('PREP_HARNESS_CHANGED');
 const checked=validate(frozen.plan.path,frozen.grant.path);
 if(checked.issues.length)throw Error('PLAN_BLOCKED: revalidate current identity/window');
 if(!equal(frozen.candidateManifest,checked.planValue.candidateManifest)||frozen.synthetic!==checked.planValue.synthetic)throw Error('FROZEN_CANDIDATE_CHANGED');
 return{frozen,checked};
}
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
export function commands(path){
 const {frozen,checked}=verifyFrozen(path),p=checked.planValue;
 if(p.synthetic)throw Error('SYNTHETIC_CANNOT_AUTHORIZE_REAL_COMMANDS');
 const cli=`${quote(join(checked.manifest.installation.root,'dist/src/cli.js'))}`,base=`${quote(process.execPath)} ${cli}`,root=`--data-root ${quote(p.execution.dataRoot)}`;
 const common=[`仅供用户在 Terminal.app 中手动执行。先核对环境与冻结文件；本文件不会执行任何命令。`,
  `计划 ${p.id} · candidate ${checked.manifest.candidate.commit} · build ${p.version.sourceBuildSha256}`,
  `截止 ${p.budget.deadline} · 人民币高峰价 ${p.price.version} · 上限估算 ¥${p.budget.cnyCeiling}（非账单、非账号硬消费上限）`,
  '记录真实 input、execution.config、host usage/cost、首败、cleanup 与重开；unknown 不记零。不要在终端录制或证据中输入凭据。'];
 let steps;
 if(p.path==='coding')steps=[`监督方式：用户已明确接受 operator-observed；该入口没有总 token/CNY/绝对截止自动硬停保证。达到约定预算/截止或任何停止条件时用 Ctrl+C 请求中止并等清理；取消不证明退款或远端停止。`,`${base} --workspace ${quote(p.execution.workspace)} ${root}`,'在 1a 输入固定案例的原始 input，Enter 进入 1b；不新增任务、重试或临时扩大范围。','取得必要检查和实际结果后，空闲时 /exit，保留真实 1f exit.summary 与清理事实。',`${base} show '<实际 s-号或 r-号>' ${root} --format json`];
 if(p.path==='improve')steps=[`必须在 ${new Date(Date.parse(p.budget.deadline)-p.budget.maxDurationMs).toISOString()} 前确认，确认前重新 validate；若忙则退出确认框，禁止排队。`,`${base} resume ${quote(p.route.sessionId)} ${root}`,`/improve new --scope ${p.route.scope} --budget ${p.route.tier} --focus ${JSON.stringify(p.route.focus)}`,'核对启动框的真实 target、文件数、档位和金额；Enter 只授权这一次分析。','零候选合法，但执行链记证据不足；不再分析以凑候选。', '/improve <实际 ir-号>','在 1d 核对真实候选 revision、替换片段、结构化检查、目标/基线、保护项、依赖/冲突、写回/生效与回退。分析授权不选择候选。','将实际候选与汇总预算交用户决定，取得对应内容的选择授权后才确认；缺失或超原上限则停在 1d。不会生成预填 --execute 命令。','按真实结果保留验证、写回或适用的新任务生效事实；禁止把验证通过写成改善。','/improve history <实际 ir-号>'];
 if(p.path==='eval')steps=[`${base} --workspace ${quote(p.execution.workspace)} ${root}`,'/eval',`/eval run ${p.route.planId}`,'此命令只预填 2b 确认框。核对完整计划、版本/隔离、所有 trial、人民币峰值上限和截止时间后 Enter。','只执行这一份计划一次；停止后不续跑，保留全部未运行项。Ctrl+C、r 重评分、退出停止的回归另用 synthetic provider 证据，不额外做付费试次。',`${base} eval report ${quote(p.route.planId)} ${root} --format json`];
 return{schema:`${SCHEMA}-commands`,status:'MANUAL_CARD_NOT_EXECUTED',frozen:fileRef(path),path:p.path,validUntil:p.path==='improve'?new Date(Date.parse(p.budget.deadline)-p.budget.maxDurationMs).toISOString():p.budget.deadline,prerequisites:common,steps,remaining:EVIDENCE[p.path].map(slot=>({slot,status:'NOT_RUN'}))};
}

/** Consolidate supplied observations without rerunning, grading, or upgrading
 * them. Every planned path remains present; latest success never erases FAIL. */
export function report(inputPath){
 const input=json(resolve(inputPath));if(input.schema!==`${SCHEMA}-observations`||!Array.isArray(input.plans)||!Array.isArray(input.observations))throw Error('OBSERVATION_SCHEMA');
 const manifest=readRef(input.candidateManifest),plans=input.plans.map(ref=>({ref,value:readRef(ref)}));
 if(manifest.schema!=='pi-durio-redesign-terminal-v1'||typeof manifest.synthetic!=='boolean'||!/^([a-f0-9]{40})$/.test(manifest.candidate?.commit)||!/^([a-f0-9]{40})$/.test(manifest.candidate?.tree)||!hex(manifest.source?.sourceBuildSha256))throw Error('OBSERVATION_CANDIDATE_BINDING');
 if(!plans.length||plans.some(p=>p.value.schema!==SCHEMA||!PATHS.includes(p.value.path)||p.value.synthetic!==manifest.synthetic||!equal(p.value.candidateManifest,input.candidateManifest))||new Set(plans.map(p=>p.ref.sha256)).size!==plans.length)throw Error('OBSERVATION_PLAN_BINDING');
 const ids=new Set(),observations=input.observations.map(row=>{
  if(!text(row.id)||ids.has(row.id)||!iso(row.at)||!STATES.includes(row.status)||!plans.some(p=>p.ref.sha256===row.planSha256)||!Array.isArray(row.evidence))throw Error('OBSERVATION_ID_STATUS_OR_PLAN');ids.add(row.id);
  const plan=plans.find(p=>p.ref.sha256===row.planSha256).value;
  for(const entry of row.evidence){if(!EVIDENCE[plan.path].includes(entry.slot))throw Error('UNKNOWN_EVIDENCE_SLOT');readRef(entry.file);}
  if(row.status==='PASS'&&(!EVIDENCE[plan.path].every(slot=>row.evidence.some(e=>e.slot===slot))||!text(row.conclusionBasis)))throw Error('PASS_REQUIRES_EACH_OBSERVATION');
  const cost=row.cost??{};
  if(cost.knownCny!==null&&cost.knownCny!==undefined&&(!Number.isFinite(cost.knownCny)||cost.knownCny<0)||cost.unknownRequests!==null&&cost.unknownRequests!==undefined&&(!Number.isSafeInteger(cost.unknownRequests)||cost.unknownRequests<0))throw Error('COST_INVALID');
  if(cost.knownCny!==null&&cost.knownCny!==undefined&&(!text(cost.scopeId)||cost.basis!=='host-ledger'||!positive(cost.through)))throw Error('COST_HOST_SCOPE_REQUIRED');
  if(cost.complete===true&&(!Number.isFinite(cost.knownCny)||cost.unknownRequests!==0||cost.priceVersion!==plan.price.version))throw Error('COMPLETE_COST_REQUIRES_KNOWN_USAGE_AND_PRICE');
  return{...row,synthetic:plan.synthetic,cost:{scopeId:cost.scopeId??null,basis:cost.basis??null,through:cost.through??null,knownCny:cost.knownCny??null,unknownRequests:cost.unknownRequests??null,complete:cost.complete===true,priceVersion:cost.priceVersion??null},firstFailure:row.firstFailure??null};
 });
 const controls={};for(const key of ['stop','regrade','exitStop']){
  const row=input.syntheticControls?.[key];if(!row||!STATES.includes(row.status)||!Array.isArray(row.evidence))throw Error('SYNTHETIC_CONTROL_SLOT_REQUIRED');
  for(const ref of row.evidence)readRef(ref);if(row.status==='PASS'&&!row.evidence.length)throw Error('SYNTHETIC_PASS_REQUIRES_EVIDENCE');
  controls[key]={...row,provenance:'synthetic provider; not paid/native/model-quality evidence'};
 }
 const ordered=[...observations].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const byPath=PATHS.map(path=>{const planned=plans.filter(p=>p.value.path===path),items=ordered.filter(o=>planned.some(p=>p.ref.sha256===o.planSha256)),real=items.filter(o=>!o.synthetic),allObserved=planned.filter(p=>!p.value.synthetic).every(p=>real.some(o=>o.planSha256===p.ref.sha256));return{path,planned:planned.map(p=>p.ref),observations:items,realStatus:real.some(o=>o.status==='FAIL')?'FAIL':real.length&&allObserved&&real.every(o=>o.status==='PASS')?'PASS':real.length?'EVIDENCE_INSUFFICIENT':'NOT_RUN',firstFailure:real.find(o=>o.status==='FAIL'||o.firstFailure)?.id??null};});
 // Cost rows are cumulative snapshots of host scopes. Reopening the same run or
 // importing a newer report must not count that scope a second time.
 const real=ordered.filter(o=>!o.synthetic),scopes=new Map();
 for(const row of real)if(row.cost.scopeId){const old=scopes.get(row.cost.scopeId);if(!old||row.cost.through>old.through)scopes.set(row.cost.scopeId,row.cost);else if(row.cost.through===old.through&&!equal(row.cost,old))throw Error('COST_SAME_WATERMARK_CONFLICT');}
 const allPlannedObserved=plans.filter(p=>!p.value.synthetic).every(p=>real.some(o=>o.planSha256===p.ref.sha256));
 const costs=[...scopes.values()],complete=real.length>0&&allPlannedObserved&&real.every(o=>o.cost.scopeId)&&costs.every(c=>c.complete),known=costs.filter(c=>c.knownCny!==null);
 return{schema:`${SCHEMA}-report`,candidateManifest:input.candidateManifest,candidate:manifest.candidate,input:fileRef(inputPath),paths:byPath,syntheticControls:controls,cost:{kind:'CNY estimate, not bill; unique host scopes at latest supplied watermark',scopes:costs,knownPartCny:known.length?known.reduce((sum,c)=>sum+c.knownCny,0):null,totalCny:complete?costs.reduce((sum,c)=>sum+c.knownCny,0):null,complete,unknownRequests:costs.length&&allPlannedObserved&&real.every(o=>o.cost.scopeId)&&costs.every(c=>c.unknownRequests!==null)?costs.reduce((sum,c)=>sum+c.unknownRequests,0):null},claim:'Supplied evidence index only; no product execution, independent grading, terminal acceptance or daily-use acceptance performed by this tool.'};
}
