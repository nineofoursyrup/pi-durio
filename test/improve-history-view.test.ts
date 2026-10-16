import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,cpSync,mkdtempSync,realpathSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {stripTerminalSequences,visibleWidth,type Terminal} from '@earendil-works/pi-tui';
import {Evidence,digest} from '../src/evidence.js';
import {readReportRecord,improveHome} from '../src/improve-entry.js';
import {ImproveView} from '../src/tui/improve.js';
import {ImproveSelectionView} from '../src/tui/improve-selection.js';
import {parseCommand,commandCompletion,helpBody} from '../src/tui/commands.js';
import {ReadOnlyTui} from '../src/tui/app.js';
import {improveFacts,listImproveSuppressions,suppressionMatch,readImproveDecision} from '../src/improve-history.js';
import {captureImproveSources,listRegisteredSources} from '../src/improve-source.js';
import {submitImproveDecision,type ImproveDecision} from '../src/improve-decisions.js';
import {readImproveHistory,continuationBlocked} from '../src/improve-report-history.js';
import {ImproveManagement,type ImproveManagementHost} from '../src/tui/improve-management.js';
import {ImproveBatchController} from '../src/improve-batch.js';
import {acquireOwner} from '../src/ownership.js';
import {tuiCleanupStatus,tuiExitCode} from '../src/tui/exit-summary.js';

const fixture=resolve('test/fixtures/v1-records/data'),id='fixture-improve-1';
const plain=(lines:string[])=>lines.map(stripTerminalSequences).join('\n');
function contents(root:string):[string,string][] {
 return readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
  const path=join(e.parentPath,e.name);return [path.slice(root.length),digest(readFileSync(path))] as [string,string];
 }).sort(([a],[b])=>a.localeCompare(b));
}
function all(view:ImproveView,width=132,height=38) {
 const pages:string[]=[];
 for(let n=0;n<600;n++) {const lines=view.render(width,height);for(const line of lines)assert.ok(visibleWidth(line)<=width);const text=plain(lines);if(text===pages.at(-1))break;pages.push(text);view.scroll(1);}
 return pages.join('\n');
}
test('v1 fixture history uses latest decisions and shared read-only cards without touching any recorded workspace',()=>{
 const before=contents(fixture),report=readReportRecord(fixture,id)!;
 assert.equal(improveHome(fixture,report.target.workspace).pending.some(r=>r.id===id),false);
 const list=plain(new ImproveView(fixture).render(132,38));
 assert.match(list,/执行 1 验证 0 暂缓 0 不再建议 1/);
 const detail=all(new ImproveView(fixture,id));
 assert.match(detail,/C-01@r1.*首版另有 2 次决定/);
 assert.match(detail,/C-02@r1.*不再建议/);
 assert.match(detail,/回退 C-01@r1 所在组合的写回/);
 assert.match(detail,/原 id fixture-improve-1/);
 assert.doesNotMatch(detail,/验证已通过，可再选执行/);
 assert.deepEqual(contents(fixture),before);
});
test('unified improve commands validate typed parameters and remove every obsolete alias from parser, help and completion',async()=>{
 const valid=['/improve continue fixture-improve-1','/improve rollback fixture-improve-1·C-01 --reason regression --note "保持用户编辑"','/improve restore fixture-improve-1·C-02 --reason reassess','/improve register eval "cases with spaces"','/improve unregister self ./src'];
 for(const command of valid)assert.doesNotThrow(()=>parseCommand(command),command);
 for(const alias of ['improves','improve-select','improve-suppressions','improve-restore','improve-continue','improve-rollback']) {
  assert.throws(()=>parseCommand('/'+alias),/未知命令/);
  assert.doesNotMatch(helpBody(132).join('\n'),new RegExp('/'+alias));
  const result=await commandCompletion('.',undefined,null).getSuggestions(['/'+alias],0,alias.length+1,{signal:new AbortController().signal});
  assert.equal(result,null);
 }
 assert.throws(()=>parseCommand('/improve rollback fixture-improve-1·C-01 --reason changed'),/不接受 changed/);
});

class TestTerminal implements Terminal {
 columns=132;rows=38;kittyProtocolActive=false;input:(s:string)=>void=()=>{};
 start(input:(s:string)=>void){this.input=input;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
function appFixture() {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'durio-history-view-'))),dataRoot=join(root,'data'),workspace=join(root,'project');
 cpSync(fixture,dataRoot,{recursive:true});mkdirSync(workspace);
 const terminal=new TestTerminal();let calls=0;
 const app=new ReadOnlyTui({dataRoot,workspace,draftRoot:join(root,'drafts'),mode:'offline',terminal,widthCalibration:false,transport:async()=>{calls++;throw Error('not allowed');}});
 app.start();return {root,dataRoot,workspace,terminal,app,key:(s:string)=>terminal.input(s),screen:()=>plain(app.screen()),calls:()=>calls};
}
async function until(predicate:()=>boolean) {for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('history operation did not settle');}
test('legacy command opens history, restore only prefills a reason dialog and confirmed restore makes the problem suggestible again',async()=>{
 const f=appFixture(),before=contents(f.dataRoot),report=readReportRecord(f.dataRoot,id)!,candidate=report.candidates[1];
 try {
  f.key('/improve '+id);f.key('\r');assert.match(f.screen(),/首版报告/);assert.match(f.screen(),/只读报告/);
  f.key('1');f.key('\r');assert.deepEqual(contents(f.dataRoot),before);
  f.key('\x1b');f.key('\x1b');f.key('\x1b');
  f.key('/improve restore '+id+'·C-02 --reason reassess --note "重新核验"');f.key('\r');
  assert.match(f.screen(),/恢复建议/);assert.match(f.screen(),/想重新评估/);assert.match(f.screen(),/重新核验/);
  assert.deepEqual(contents(f.dataRoot),before,'prefill opens a confirmation without writing');
  f.key('\x1b');assert.deepEqual(contents(f.dataRoot),before);
  f.key('/improve restore '+id+'·C-02 --reason reassess');f.key('\r');f.key('\r');
  await until(()=>!listImproveSuppressions(f.dataRoot).find(s=>s.candidateId===candidate.id)?.active);
  assert.equal(suppressionMatch(f.dataRoot,candidate).blocked,false);
  assert.equal(f.calls(),0);
 }finally{await f.app.exit();}
});
test('register and unregister commands only confirm exact inspected sources; drift after preview preserves the old registration',async()=>{
 const f=appFixture(),path=join(f.workspace,'cases.json');writeFileSync(path,'[]\n');
 const idle=()=>/○ 空闲/.test(f.screen());
 try {
  f.key('/improve register eval cases.json');f.key('\r');assert.match(f.screen(),/登记来源/);assert.match(f.screen(),/cases.json/);
  assert.equal(listRegisteredSources(f.dataRoot).length,0);
  writeFileSync(path,'[1]\n');f.key('\r');await until(()=>/IMPROVE_SOURCE_PREVIEW_CHANGED/.test(f.screen())&&idle());
  assert.equal(listRegisteredSources(f.dataRoot).length,0,'changed source is not silently re-authorized');
  // Registration becomes visible before its writer lease and host operation finish.
  f.key('/improve register eval cases.json');f.key('\r');f.key('\r');await until(()=>listRegisteredSources(f.dataRoot).length===1&&idle());
  f.key('/improve unregister eval cases.json');f.key('\r');assert.match(f.screen(),/移除来源/);assert.equal(listRegisteredSources(f.dataRoot).length,1);
  f.key('\r');await until(()=>listRegisteredSources(f.dataRoot).length===0&&idle());assert.equal(f.calls(),0);
 }finally{await f.app.exit();}
});

/** Synthetic first-version/declared reports are generated in this test's own new
 * workspace. They never relocate, rewrite or execute the immutable #66 fixture. */
function ownReport(declared:boolean) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'durio-history-actions-'))),dataRoot=join(root,'data'),workspace=join(root,'project');mkdirSync(workspace);
 writeFileSync(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');writeFileSync(join(workspace,'untouched.txt'),'keep user bytes\n');
 const e=new Evidence(dataRoot,'analysis-synthetic'),target=captureImproveSources(e,workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'synthetic-source').targets[0];
 const content='export const add=(a,b)=>a+b;\n',check={kind:'regression' as const,program:"import assert from 'node:assert/strict';const {add}=await import('/work/targets/project/math.mjs');assert.equal(add(2,3),5);console.log('history original retained');",timeoutMs:30000};
 const candidate={id:'candidate:synthetic',revision:'synthetic-r1',display:'R1',title:'Synthetic addition repair',problem:'Wrong arithmetic',problemKey:'synthetic.add',objective:'bug',target,facts:[],hypotheses:[],successCounterexamples:[],gaps:[],mechanismsReviewed:['math.mjs'],steps:['Replace subtraction with addition'],scope:['math.mjs'],validation:{method:'regression',checks:['positive addition'],budget:'one check',protections:['untouched file']},risks:['local change'],rollback:'Restore exact original file',activation:{writeback:true,enable:false,conditions:['regression pass'],timing:'new task'},dependencies:[],conflicts:[],suggestionOnly:false,...(declared?{replacements:[{path:'math.mjs',content}],structuredChecks:[check]}:{})};
 const report={id:declared?'synthetic-declared':'synthetic-legacy',revision:'synthetic-report-r1',runId:e.runId,target:{workspace,runId:'synthetic-coding'},candidates:[candidate],selected:[],targets:[target],state:'complete',evidence:[],...(declared?{selectionContract:'declared-v1'}:{})};
 e.append('improve.started',{request:{id:report.id},target:report.target});e.append('improve.report',report);e.close();
 const decision:ImproveDecision={id:'synthetic-decision',reportId:report.id,reportRevision:report.revision,selections:[{candidateId:candidate.id,candidateRevision:candidate.revision,target,steps:candidate.steps,mode:declared?'validate-only':'execute-declared-scope',...(!declared?{formal:{writeback:true as const,activate:null,failureCompensation:'none' as const}}:{})}],directory:join(root,'validation'),groups:[{id:'math',candidateIds:[candidate.id],changes:[{targetId:target.id,path:'math.mjs',content}],checks:[check]}],limits:{deadline:new Date(Date.now()+120000).toISOString(),maxChecks:1,maxRequests:0,maxTokens:0}};
 return {root,dataRoot,workspace,report,decision,content};
}
function management(f:ReturnType<typeof ownReport>) {
 let box:Parameters<ImproveManagementHost['confirm']>[0]|undefined,confirm:()=>void=()=>{},pending=Promise.resolve(),error:unknown,blocked:string|undefined;
 const messages:string[]=[],batch=new ImproveBatchController(f.dataRoot);
 const host:ImproveManagementHost={writeBlocked:()=>blocked,feedback:s=>messages.push(s),blocked:()=>blocked,confirm:(b,fn)=>{box=b;confirm=fn;},run:async(_label,_id,work)=>{pending=work(new AbortController().signal).then(()=>{},e=>{error=e;});await pending;},resume:(input,signal)=>batch.resume(input,signal),changed:()=>{}};
 return {host,batch,manager:new ImproveManagement(f.dataRoot,f.workspace,host),messages,dialog:()=>box,error:()=>error,pending:()=>pending,block:(reason?:string)=>{blocked=reason;},reset:()=>{box=undefined;error=undefined;},enter:()=>{if(box?.handleInput('\r').type==='confirm')confirm();}};
}
test('synthetic legacy rollback confirms exact files, rechecks capabilities and preserves later edits before any rollback fact',async()=>{
 const f=ownReport(false),state=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision});assert.equal(state.writeback,'written');
 const m=management(f),history=readImproveHistory(f.dataRoot,f.report.id);assert.equal(history.contract,'legacy');assert.equal(history.actions.length,1);
 const before=contents(f.dataRoot);m.manager.command('rollback',`${f.report.id}·C-01`,{reason:'regression',note:'keep other files'});
 assert.ok(m.dialog()!);assert.match(plain(m.dialog()!.render(132,38)),/math.mjs/);assert.match(plain(m.dialog()!.render(132,38)),/引入了新问题/);assert.match(plain(m.dialog()!.render(132,38)),/keep other files/);assert.deepEqual(contents(f.dataRoot),before);
 m.dialog()!.render(39,11);m.enter();await m.pending();assert.deepEqual(contents(f.dataRoot),before,'tiny confirmation cannot authorize rollback');
 m.dialog()!.render(132,38);m.block('只读查看');m.enter();await m.pending();assert.deepEqual(contents(f.dataRoot),before,'capability is checked again after preview');m.block();
 writeFileSync(join(f.workspace,'math.mjs'),'later user edit\n');m.enter();await m.pending();assert.match(String(m.error()),/ROLLBACK_USER_EDIT/);assert.equal(readFileSync(join(f.workspace,'math.mjs'),'utf8'),'later user edit\n');assert.equal(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.rollback-request').length,0);
 m.reset();const unavailable=m.manager.action(history.actions[0]);assert.match(unavailable!,/ROLLBACK_USER_EDIT/);assert.equal(m.dialog()!,undefined,'unavailable history action does not open a confirmation');
 writeFileSync(join(f.workspace,'math.mjs'),f.content);m.manager.command('rollback',`${f.report.id}·C-01`,{reason:'unneeded'});m.dialog()!.render(132,38);m.enter();await m.pending();assert.equal(m.error(),undefined);
 assert.equal(readFileSync(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n');assert.equal(readFileSync(join(f.workspace,'untouched.txt'),'utf8'),'keep user bytes\n');
 const restored=readImproveDecision(f.dataRoot,f.decision.id);assert.equal(restored.groups[0].rollback?.state,'completed');assert.equal(restored.groups[0].formal?.writeback,'written','original success is retained');assert.match(restored.groups[0].rollback!.reason,/不再需要/);
 assert.equal(readImproveHistory(f.dataRoot,f.report.id).actions.filter(a=>a.kind==='rollback').length,0);
 const view=new ImproveView(f.dataRoot,f.report.id);view.handleInput('\t');view.handleInput('\r');assert.match(all(view),/history original retained/);assert.equal(view.back(),true);assert.equal(view.depth,2);
});
test('continuation confirms only original untouched work, rejects changed baseline and exposes legacy/version reasons without opening a dialog',async()=>{
 const f=ownReport(true),state=await submitImproveDecision({dataRoot:f.dataRoot,decision:f.decision,signal:AbortSignal.abort()});assert.equal(state.state,'frozen');assert.equal(state.groups[0].state,'not-run');
 assert.equal(continuationBlocked(state,'declared',state.executionVersion),undefined);assert.match(continuationBlocked(state,'declared','other-build')!,/执行版本已变/);assert.match(continuationBlocked(state,'legacy',state.executionVersion)!,/首版冻结批次不能继续/);
 const legacy=ownReport(false);await submitImproveDecision({dataRoot:legacy.dataRoot,decision:legacy.decision,signal:AbortSignal.abort()});
 const legacyHistory=readImproveHistory(legacy.dataRoot,legacy.report.id),legacyManager=management(legacy);assert.match(legacyHistory.actions[0].disabled!,/执行版本已变/);
 legacyManager.manager.command('continue',legacy.report.id);assert.equal(legacyManager.dialog(),undefined);assert.match(legacyManager.messages.join('\n'),/首版冻结批次不能继续/);
 const m=management(f),history=readImproveHistory(f.dataRoot,f.report.id);assert.equal(history.actions[0].disabled,undefined);
 const blocked=management(f);blocked.block('有任务运行中');blocked.manager.command('continue',f.report.id);assert.equal(blocked.dialog(),undefined);assert.match(blocked.messages.join('\n'),/有任务运行中/);
 m.manager.command('continue',f.report.id);assert.match(plain(m.dialog()!.render(132,38)),/检查 1 项/);assert.equal(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.resume').length,0);
 writeFileSync(join(f.workspace,'math.mjs'),'edited since preview\n');m.enter();await m.pending();assert.match(String(m.error()),/BASELINE_DRIFT/);assert.equal(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.resume').length,0);
 const follow=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{throw Error('continuation observer must never submit a new batch');}),resume=m.host.resume;
 m.host.resume=(input,signal)=>{const done=resume(input,signal);follow.observeContinuation(f.decision,done);return done;};
 writeFileSync(join(f.workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');m.reset();m.manager.command('continue',f.report.id);m.dialog()!.render(132,38);m.enter();assert.equal(follow.inProgress,true);assert.match(plain(follow.render(132,38)),/improve 执行进度/);await m.pending();assert.equal(m.error(),undefined);assert.equal(follow.inProgress,false);assert.match(plain(follow.render(132,38)),/已结束/);
 const result=readImproveDecision(f.dataRoot,f.decision.id);assert.equal(result.state,'completed');assert.equal(result.sourceId,state.sourceId);assert.equal(result.groups[0].state,'completed');assert.equal(result.reserved.checks,1);assert.equal(result.writeback,'not-written');
 assert.equal(m.batch.cleanup?.storage,'closed');assert.equal(m.batch.cleanup?.owner,'released');assert.ok(m.batch.cleanup?.workspaces.length);assert.ok(m.batch.cleanup?.workspaces.every(w=>w.released));
 const owner=await acquireOwner(f.dataRoot,()=>{});await owner.release();
});

test('late continuation refusal clears the prior batch receipt before preflight and does not invent cleanup work',async()=>{
 const f=ownReport(true),terminal=new TestTerminal(),app=new ReadOnlyTui({dataRoot:f.dataRoot,workspace:f.workspace,draftRoot:join(f.root,'drafts'),mode:'offline',terminal,widthCalibration:false});
 const first=await app.improveBatch.start(f.decision,AbortSignal.abort());assert.equal(first.state,'frozen');assert.equal(app.improveBatch.cleanup?.owner,'released');
 try{
  app.start();terminal.input(`/improve continue ${f.report.id}`);terminal.input('\r');assert.match(plain(app.screen()),/继续未运行的独立项/);
  writeFileSync(join(f.workspace,'math.mjs'),'user edit after confirmation opened\n');terminal.input('\r');await until(()=>/BASELINE_DRIFT/.test(plain(app.screen())));
  assert.equal(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.resume'||f.kind==='improve.group-started').length,0);assert.equal(app.improveBatch.running,false);
  assert.equal(app.improveBatch.cleanup,undefined,'the earlier submission receipt cannot describe a refused continuation');assert.deepEqual(app.improveBatch.evalCleanup,[]);
  const exit=await app.exit();assert.equal(exit.batchCleanup,undefined);assert.equal(exit.evalCleanup,undefined);assert.equal(exit.eval,undefined);assert.equal(tuiCleanupStatus(exit)?.cleanup,'confirmed');assert.equal(tuiExitCode(exit),0);assert.doesNotMatch(exit.summary.join('\n'),/状态未知|写入者锁保留/);
  const owner=await acquireOwner(f.dataRoot,()=>{});await owner.release();
 }finally{await app.exit();}
});
