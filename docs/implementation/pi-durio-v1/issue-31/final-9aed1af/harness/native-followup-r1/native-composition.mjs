#!/usr/bin/env node
// Targeted final native composition. Explicit automated operator, synthetic model.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const [installArg,outArg]=process.argv.slice(2);
if(!installArg||!outArg)throw Error('Usage: node native-composition.mjs INSTALL_ROOT NEW_OUTPUT');
if(process.platform!=='darwin'||!process.stdin.isTTY||!process.stdout.isTTY||process.env.TERM_PROGRAM!=='Apple_Terminal')throw Error('ACTUAL_MACOS_TERMINAL_REQUIRED');
const install=resolve(installArg),out=resolve(outArg);if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');
mkdirSync(out);const workspace=join(out,'workspace'),dataRoot=join(out,'data');mkdirSync(workspace);
const original='export const add=(a,b)=>a-b;\n',fixed='export const add=(a,b)=>a+b;\n';
writeFileSync(join(workspace,'math.mjs'),original);writeFileSync(join(workspace,'README.md'),'Native composition fixture. Preserve this file.\n');
const sha=b=>createHash('sha256').update(b).digest('hex'),ref=p=>{const b=readFileSync(p);return{path:p,bytes:b.length,sha256:sha(b)};};
const save=(name,v)=>writeFileSync(join(out,name+'.json'),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const event=v=>appendFileSync(join(out,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),performanceMs:performance.now(),...v})+'\n',{mode:0o600});
const require=createRequire(join(install,'package.json')),product=require.resolve('pi-durio/tui'),productRequire=createRequire(product),load=async id=>import(pathToFileURL(require.resolve(id)).href);
const analysisRequest={id:'native-composition-analysis',purpose:'Controlled final native improve composition; no real model inference',sources:[{id:'project',kind:'project',paths:['math.mjs']}],limits:{maxRequests:8,maxTokens:16384,maxRequestTokens:2048,maxDurationMs:90000,maxOutputTokens:1024}};
const initialPrompt='Create the declared long controlled response for native context maintenance.';
const finalPrompt='Read math.mjs after the explicitly selected local fixture correction.';
save('plan',{at:new Date().toISOString(),harness:ref(fileURLToPath(import.meta.url)),product:ref(product),sourceBuild:ref(join(install,'node_modules/pi-durio/dist/execution/source-build.json')),node:process.execPath,nodeVersion:process.version,
 terminal:{program:process.env.TERM_PROGRAM,version:process.env.TERM_PROGRAM_VERSION??null,columns:process.stdout.columns,rows:process.stdout.rows},
 phases:['One synthetic coding response with 90,000 z characters','Native /compact, applied summary and /compactions view','Native /improve with fixed source-view tools and scripted evidence-grounded candidate','Native /improve-select begins unselected, explicit e, s, rendered summary, Enter once','Actual restricted regression and formal write of this test fixture only','Reports, metrics, history, return-to-current and subsequent ordinary read','Graceful native exit with measured width calibration'],
 initialPrompt,initialResponsePrefix:'ORIGINAL LONG RESPONSE ',initialResponseCharacters:90000,analysisRequest,finalPrompt,
 formalTarget:{path:join(workspace,'math.mjs'),before:original,after:fixed,activate:null},
 check:{kind:'regression',program:"import assert from 'node:assert/strict';const {add}=await import('/work/targets/project/math.mjs');assert.equal(add(2,3),5);assert.equal(add(-2,3),1);",timeoutMs:30000},
 operator:'Automated explicit fixture-only keystrokes through the native ProcessTerminal input callback; not a human response or #32 daily-use acceptance.',
 limits:['No provider network call or hidden paid fallback','No arbitrary user workspace is edited','No new subjective IME/mouse/copy acceptance is inferred; existing native evidence requires a separate final applicability decision','Frames emitted and visible app text are retained; external native screenshot observations are separate'],overallTimeoutMs:600000});
const {ReadOnlyTui}=await load('pi-durio/tui'),{scriptedTransport}=await load('pi-durio/offline'),{readAcceptedTasks,readRun}=await load('pi-durio');
const {readCompactions}=await load('pi-durio/compaction'),{readImproveReport}=await load('pi-durio/improve'),{readImproveDecision}=await load('pi-durio/improve-decisions');
const {ProcessTerminal,stripTerminalSequences}=await import(pathToFileURL(productRequire.resolve('@earendil-works/pi-tui')).href);
let active,app,firstFrame=false,closed=false,phase='startup',requests=0;const payloads=[];
const terminal=new ProcessTerminal(),start=terminal.start.bind(terminal);let inject;
terminal.start=(input,resize)=>{inject=data=>{event({kind:'automated-input',data});input(data);};return start(input,resize);};
const originalWrite=process.stdout.write;process.stdout.write=function(chunk,...args){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));if(b.toString().includes('pi-durio ·'))firstFrame=true;return originalWrite.call(this,chunk,...args);};
const screen=()=>app.screen().map(stripTerminalSequences).join('\n');
const frame=name=>{const lines=app.screen().map(stripTerminalSequences);save(name,{phase,columns:process.stdout.columns,rows:process.stdout.rows,lines,bytes:Buffer.byteLength(lines.join('\n'))});};
async function until(fn,ms=90000){const end=performance.now()+ms;while(performance.now()<end){if(closed)throw Error('APP_CLOSED_EARLY');const value=fn();if(value)return value;await delay(100);}throw Error('NATIVE_COMPOSITION_TIMEOUT:'+phase);}
async function enter(text){inject(text);await delay(750);inject('\r');}
const task=prompt=>existsSync(join(dataRoot,'host.sqlite'))?readAcceptedTasks(dataRoot,{limit:50}).tasks.find(t=>t.input===prompt&&t.status==='completed'):null;
const deadline=setTimeout(()=>{event({kind:'overall-timeout',phase});void app?.exit();},600000);
let source,analysis,decision,exit;
try{
 app=new ReadOnlyTui({workspace,dataRoot,draftRoot:join(out,'drafts'),mode:'offline',coding:true,terminal,transport:async(url,init)=>{if(!active)throw Error('UNPLANNED_SYNTHETIC_REQUEST');requests++;payloads.push({phase,payload:JSON.parse(String(init.body))});return active(url,init);}});
 void app.closed.then(()=>{closed=true;});app.start();await until(()=>firstFrame);await delay(1500);frame('initial-frame');
 phase='long-source';const long=scriptedTransport([]);active=async(url,init)=>new Response((await (await long.fetch(url,init)).text()).replace('Controlled response: inspect actual tool evidence for acceptance.','ORIGINAL LONG RESPONSE '+'z'.repeat(90000)),{headers:{'content-type':'text/event-stream'}});
 await enter(initialPrompt);source=await until(()=>task(initialPrompt));await until(()=>screen().includes('已完成'));frame('long-source-frame');
 phase='compact';const summary=scriptedTransport([]);active=summary.fetch;await enter('/compact');await until(()=>readCompactions(dataRoot,source.runId).items.some(i=>i.kind==='compaction.finished'&&i.data.state==='applied'));await until(()=>screen().includes('applied'));assert.equal(summary.calls.length,1);frame('compaction-applied-frame');
 await enter('/compactions');await delay(1000);assert.match(screen(),/上下文压缩/);frame('compactions-panel');inject('\x1b');await delay(750);
 phase='analysis';const scripted=scriptedTransport([{name:'evidence_summary',args:{}},{name:'source_view',args:{targetId:'project',path:'math.mjs'}}]);
 active=async(url,init)=>{const p=JSON.parse(String(init.body)),response=await scripted.fetch(url,init),views=p.messages.filter(m=>m.role==='tool').flatMap(m=>{try{return[JSON.parse(m.content)];}catch{return[];}}),view=views.find(v=>v.targetId==='project'&&v.path==='math.mjs');
  const answer={summary:'Controlled proposal from acquired fixture source',candidates:[{title:'Correct the declared local addition fixture',problem:'The acquired add source subtracts',problemKey:'math.add.operator',objective:'bug',targetId:'project',facts:[{claim:'Acquired math.mjs',evidence:[view?.sourceId??'not-acquired']}],hypotheses:['Fixed addition passes independent signed-input checks'],successCounterexamples:[],gaps:['Controlled transport; no model inference claim'],mechanismsReviewed:['math.mjs'],steps:['Prepare fixed selected content','Run all declared checks','Write only after explicit selection'],scope:['math.mjs'],validation:{method:'regression',checks:['Signed addition checks'],budget:'Explicit decision aggregate',protections:['README remains unchanged']},risks:['Formal source write changes future local reads'],rollback:'Explicit retained-byte rollback protects later user edits',activation:{writeback:true,enable:false,conditions:['All necessary checks and required predeclared benefit thresholds pass'],timing:'Only after explicit aggregate submission'},dependencies:[],conflicts:[]}],gaps:['Synthetic native composition only']};
  return new Response((await response.text()).replace('Controlled response: inspect actual tool evidence for acceptance.',JSON.stringify(JSON.stringify(answer)).slice(1,-1)),{headers:{'content-type':'text/event-stream'}});};
 await enter('/improve '+JSON.stringify(analysisRequest));analysis=await until(()=>{let r;try{r=readImproveReport(dataRoot,analysisRequest.id);}catch(error){if(error instanceof Error&&error.message==='IMPROVE_REPORT_NOT_FOUND')return null;throw error;}return r.report?.state==='complete'?r.report:null;});assert.equal(analysis.candidates.length,1);await until(()=>screen().includes('improve complete'));frame('analysis-complete');
 const c=analysis.candidates[0],d={id:'native-composition-choice',reportId:analysis.id,reportRevision:analysis.revision,selections:[{candidateId:c.id,candidateRevision:c.revision,target:c.target,steps:c.steps,mode:'execute-declared-scope',formal:{writeback:true,activate:null,failureCompensation:'none'}}],directory:join(out,'validation'),groups:[{id:'group',candidateIds:[c.id],changes:[{targetId:c.target.id,path:'math.mjs',content:fixed}],checks:[JSON.parse(readFileSync(join(out,'plan.json'),'utf8')).check]}],limits:{deadline:new Date(Date.now()+180000).toISOString(),maxChecks:1,maxRequests:0,maxTokens:0}};
 save('exact-decision-template',d);phase='selection';active=null;await enter('/improve-select '+JSON.stringify(d));await delay(1000);assert.match(screen(),/unselected/);assert.equal(readFileSync(join(workspace,'math.mjs'),'utf8'),original);frame('selection-unselected');
 inject('e');await delay(1000);assert.match(screen(),/execute-declared-scope/);frame('selection-execute');inject('s');await delay(1000);assert.match(screen(),/Enter 一次明确提交/);frame('selection-summary');inject('\r');
 decision=await until(()=>{let x;try{x=readImproveDecision(dataRoot,d.id);}catch(error){if(String(error).includes('IMPROVE_DECISION_NOT_FOUND'))return null;throw error;}return x.state==='completed'?x:null;},180000);assert.equal(readFileSync(join(workspace,'math.mjs'),'utf8'),fixed);assert.equal(readFileSync(join(workspace,'README.md'),'utf8'),'Native composition fixture. Preserve this file.\n');await delay(1000);frame('selection-result');inject('\x1b');await delay(1000);assert.doesNotMatch(screen(),/正式目标未写回、未启用/);frame('post-write-status');
 phase='views';for(const [command,name,pattern]of [['/improves','improve-reports',/improve/],['/metrics','metrics-panel',/验收|metrics|任务/],['/history','history-panel',/历史|任务/]]){const before=requests;await enter(command);await delay(1000);assert.match(screen(),pattern);frame(name);assert.equal(requests,before);inject('\x1b');await delay(750);}await enter('/bottom');await delay(750);
 phase='subsequent-task';const read=scriptedTransport([{name:'read',args:{path:'math.mjs'}}]);active=read.fetch;await enter(finalPrompt);const later=await until(()=>task(finalPrompt));await until(()=>screen().includes('已完成'));assert.match(JSON.stringify(read.calls),/a\+b/);frame('subsequent-task');
 let after,originalRetained=false;do{const p=await readRun(dataRoot,source.runId,{after,limit:100});if(p.records.some(r=>r.kind==='model.response'&&JSON.stringify(r).includes('z'.repeat(90000))))originalRetained=true;after=p.next??undefined;}while(after);assert.ok(originalRetained);
 phase='exit';exit=await app.exit();assert.equal(exit.error,undefined);assert.equal(exit.widthCalibration?.status,'measured');save('result',{at:new Date().toISOString(),status:'PASS',source,analysis,decision,later,exit,requests,realProviderRequests:0,originalRetained,operator:'Automated native fixture execution, not human daily-use acceptance',plan:ref(join(out,'plan.json'))});
}catch(error){save('failure',{at:new Date().toISOString(),phase,error:String(error),source,analysis,decision,exit,requests,screen:app?screen():null});process.exitCode=1;}
finally{clearTimeout(deadline);if(app)await app.exit();process.stdout.write=originalWrite;save('synthetic-provider-payloads',payloads);}
console.log('Native composition evidence retained: '+out);
