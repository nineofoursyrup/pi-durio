import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence,digest} from '../src/evidence.js';
import {captureImproveSources,registerImproveSource,unregisterImproveSource} from '../src/improve-source.js';
import {deriveImproveDecision,previewImproveDecision,submitImproveDecision,currentImproveVersion,type ImproveDecision} from '../src/improve-decisions.js';
import {readImproveReport,type ImproveCandidate,type ImproveReport} from '../src/improve.js';
import {ImproveSelectionView,improveSelectionPrefill} from '../src/tui/improve-selection.js';
import {ImproveView} from '../src/tui/improve.js';
import type {PlanSource} from '../src/eval/overview.js';
import {ImproveCheckOriginal} from '../src/tui/improve-result.js';
import {ImproveBatchController} from '../src/improve-batch.js';
import {improveReportContract} from '../src/improve-contract.js';
import {improveFacts,readImproveDecision} from '../src/improve-history.js';
import {candidateValidation,improveCandidateRows} from '../src/tui/improve-card.js';
import {validateCandidateChecks,bindCandidateCheck,type CandidateFreshCheck} from '../src/improve-check-plan.js';
import {representativeCases} from '../src/eval/fixtures.js';
import {verifiedImage,type EvalPlan} from '../src/eval/plan.js';
import {COLOR_TIER,overrideColorTierForTest} from '../src/tui/theme.js';
import {captureSnapshot} from '../src/tui/snapshot.js';
import {acquireOwner} from '../src/ownership.js';
import {ReadOnlyTui} from '../src/tui/app.js';
import {scriptedTransport} from '../src/offline.js';
import {readAcceptedTasks,readQueue,runReadTask} from '../src/runtime.js';
import {stripTerminalSequences,visibleWidth,type Terminal} from '@earendil-works/pi-tui';
const plain=(lines:string[])=>lines.map(stripTerminalSequences).join('\n');
function allPages(view:{render:(w:number,h:number)=>string[];scroll:(n:number)=>void},width:number,height=24) {
 const seen:string[]=[];
 for(let i=0;i<250;i++){const lines=view.render(width,height);for(const line of lines)assert.ok(visibleWidth(line)<=width,stripTerminalSequences(line));const text=plain(lines);if(seen.at(-1)===text)break;seen.push(text);view.scroll(1);}
 return seen.join('\n').replace(/[│╭╮╰╯─]/g,'').replace(/\s+/g,'');
}


function fixture(base=tmpdir()) {
 const root=realpathSync(mkdtempSync(join(base,'durio-selection-'))),workspace=join(root,'project'),dataRoot=join(root,'data');
 mkdirSync(workspace);writeFileSync(join(workspace,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 const e=new Evidence(dataRoot,'analysis-1'),target={workspace,sessionId:'s1',taskId:'t1',runId:'coding-1'};
 const sources=captureImproveSources(e,workspace,[{id:'project',kind:'project',paths:['math.mjs']}],'fixture-version');
 const candidate:ImproveCandidate={id:'candidate:one',display:'R1',revision:'candidate-rev-1',title:'修复加法',problem:'加法用了减法',objective:'bug',target:sources.targets[0],
  facts:[{claim:'2 + 3 返回 -1',evidence:[sources.targets[0].files[0].sourceId]}],hypotheses:['运算符误写'],successCounterexamples:[],gaps:['还没有成功反例'],mechanismsReviewed:['math.mjs'],steps:['把减法改为加法'],scope:['math.mjs'],
  validation:{method:'regression',checks:['正数和负数加法'],budget:'一次检查',protections:['不更改其他文件']},risks:['只覆盖数值输入'],rollback:'恢复所保留的原文件',activation:{writeback:true,enable:false,conditions:['回归通过'],timing:'后续任务读取新文件'},dependencies:[],conflicts:[],
  replacements:[{path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}],structuredChecks:[{kind:'regression',program:'console.log("regression")',timeoutMs:30000}],execution:'not-started',effect:'unverified',selection:'unselected',suggestionOnly:false};
 const report:ImproveReport={id:'selection-report',revision:'report-rev-1',kind:'improve',runId:e.runId,target,request:{id:'selection-report',purpose:'查明问题',limits:{maxRequests:16,maxTokens:2162688,maxRequestTokens:1081344,maxDurationMs:600000,maxOutputTokens:32768}},state:'complete',startedAt:'2026-10-17T01:00:00.000Z',cutoff:0,deadline:'2026-10-17T01:10:00.000Z',summary:'一项有证据的修复',candidates:[candidate],selected:[],gaps:[],evidence:[],targets:sources.targets,queryBounds:{maxRuns:1,maxRecords:40,maxEvidenceBytes:32768,maxSourceBytes:32768},budget:{requests:0,knownTokens:0,reservedTokens:0,unknown:0,violation:false} as ImproveReport['budget'],reason:null};
 e.append('improve.started',{request:{id:report.id},target});e.append('improve.report',report);e.close();
 const save=()=>{const e=new Evidence(dataRoot,report.runId);report.revision=digest(JSON.stringify(report));e.append('improve.report',report);e.close();};
 return {root,workspace,dataRoot,candidate,report,save};
}

test('host derives exact writeback authority and declared check budget before a selection can execute',()=>{
 const f=fixture(),d=deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode:'execute-declared-scope'}],{id:'execute-1',directory:join(f.root,'validation'),deadline:new Date(Date.now()+30000).toISOString()});
 assert.deepEqual(d.selections[0].formal,{writeback:true,activate:null,failureCompensation:'none'});
 assert.deepEqual(d.groups[0].changes,[{targetId:'project',path:'math.mjs',content:'export const add=(a,b)=>a+b;\n'}]);
 assert.deepEqual([d.limits.maxRequests,d.limits.maxTokens,d.limits.maxChecks],[0,0,1]);
 assert.doesNotThrow(()=>previewImproveDecision(f.dataRoot,d));
 const substituted=structuredClone(d);substituted.groups[0].changes[0].content='user did not select these bytes';
 assert.throws(()=>previewImproveDecision(f.dataRoot,substituted),/DECLARED_CONTENT_CHANGED/);
 const reclassified=structuredClone(d);reclassified.groups[0].basis={impact:'no-behavior',reason:'unselected classification',checkIndices:[0]};assert.throws(()=>previewImproveDecision(f.dataRoot,reclassified),/DECLARED_BASIS_CHANGED/);
});

test('a modern candidate can be decided once; only passed validation permits a later execute',async()=>{
 const f=fixture();
 const d=deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode:'defer'}],{id:'defer-1',deadline:new Date(Date.now()+30000).toISOString()});
 await submitImproveDecision({dataRoot:f.dataRoot,decision:d});
 const validate=deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode:'validate-only'}],{id:'validate-2',directory:join(f.root,'validation'),deadline:new Date(Date.now()+30000).toISOString()});
 assert.throws(()=>previewImproveDecision(f.dataRoot,validate),/CANDIDATE_ALREADY_DECIDED/);
});

test('host keeps a declared resource benefit and derives the summed deadline instead of a freeform budget',()=>{
 const f=fixture();f.candidate.objective='performance';
 f.candidate.structuredChecks=[{kind:'resource',program:'console.log(JSON.stringify({baseline:20,candidate:15,protectionsPassed:true}))',timeoutMs:10000,resource:{direction:'lower',delta:4,unit:'ms',basis:'fixed deterministic workload'}},{kind:'direct',program:'console.log("guard")',timeoutMs:5000}];f.save();
 const now=Date.now(),d=deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode:'validate-only'}],{id:'resource-1',directory:join(f.root,'validation'),deadline:new Date(now+15000).toISOString()});
 assert.deepEqual(d.groups[0].checks[0],f.candidate.structuredChecks[0]);
 assert.doesNotThrow(()=>previewImproveDecision(f.dataRoot,d));
});

test('numeric modes toggle independently, Tab reveals the next card, and a process-local draft writes no facts',async()=>{
 const f=fixture();f.report.candidates.push({...structuredClone(f.candidate),id:'candidate:two',display:'R2',title:'第二项',revision:'candidate-rev-2'});f.save();
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{throw Error('no submission')});
 const before=digest(readFileSync(join(f.dataRoot,'host.sqlite')));
 await view.handleInput('free text is not authorization');await view.handleInput('\r');assert.equal(view.currentStage,'select');assert.match(plain(view.render(132,38)),/尚未选择/);
 await view.handleInput('1');await view.handleInput('1');assert.equal(view.draft().selections.length,0);
 await view.handleInput('2');await view.handleInput('\t');await view.handleInput('3');assert.deepEqual(view.draft().selections.map(s=>s.mode),['validate-only','defer']);
 const next=plain(view.render(56,12));assert.match(next,/第二项/);assert.match(next,/暂缓/);
 await view.handleInput('\x1b[Z');assert.match(plain(view.render(56,12)),/修复加法/);
 assert.equal(view.back(),false);view.refresh();assert.equal(view.draft().selections.length,2);
 assert.equal(digest(readFileSync(join(f.dataRoot,'host.sqlite'))),before);
 assert.equal(new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{}).draft().selections.length,0);
});

test('suggestions cannot execute; command prefill validates all candidates before a summary and never submits',async()=>{
 const f=fixture();f.candidate.suggestionOnly=true;f.candidate.structuredChecks=[];f.save();let submissions=0;
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{submissions++;});
 for(const n of ['1','2']){await view.handleInput(n);assert.equal(view.draft().selections.length,0);assert.match(plain(view.render(132,38)),/仅建议/);}
 assert.throws(()=>improveSelectionPrefill(f.dataRoot,f.report,{execute:'C-01'}),/仅建议/);
 assert.throws(()=>improveSelectionPrefill(f.dataRoot,f.report,{defer:'C-99'}),/候选号无效/);
 assert.throws(()=>improveSelectionPrefill(f.dataRoot,f.report,{defer:'C-01','do-not-suggest':'candidate:one'}),/重复/);
 view.prefill(improveSelectionPrefill(f.dataRoot,f.report,{defer:'C-01'}));assert.equal(view.currentStage,'summary');assert.equal(submissions,0);
 assert.match(plain(view.render(132,38)),/本次只记录决定，不执行任何候选/);
});

test('conflicts, missing dependencies and mixed combination modes show a reason and cannot submit',async()=>{
 for(const failure of ['dependency','conflict','mixed']) {
  const f=fixture(),other={...structuredClone(f.candidate),id:'candidate:two',display:'R2',revision:'candidate-rev-2'};f.report.candidates.push(other);
  if(failure==='dependency')f.candidate.dependencies=[other.id];if(failure==='conflict')f.candidate.conflicts=[other.id];f.save();let submissions=0;
  const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{submissions++;});
  view.prefill([{candidateId:f.candidate.id,mode:'validate-only'},...(failure==='dependency'?[]:[{candidateId:other.id,mode:failure==='mixed'?'execute-declared-scope' as const:'validate-only' as const}])]);
  const text=allPages(view,88,30);assert.match(text,/不能提交/);assert.match(text,failure==='dependency'?/依赖项未选/:failure==='conflict'?/冲突/:/模式必须一致/);
  await view.handleInput('\r');assert.equal(submissions,0);
 }
});

test('baseline/report drift invalidates old choices both before summary and at the final action boundary',async()=>{
 for(const point of ['before','after','report']) {
  const f=fixture();let submissions=0;const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{submissions++;});await view.handleInput('1');
  if(point==='before')writeFileSync(join(f.workspace,'math.mjs'),'user content');
  await view.handleInput('\r');view.render(132,38);
  if(point==='after')writeFileSync(join(f.workspace,'math.mjs'),'user content');
  if(point==='report'){f.report.summary='changed';f.save();}
  await view.handleInput('\r');assert.equal(submissions,0);assert.match(allPages(view,88,30),/重新分析/);
  assert.equal(view.draft().selections.length,0,'drift discards the stale draft');
 }
});

test('read-only capability is checked at choice, summary, and the final submit boundary',async()=>{
 const f=fixture();let blocked=true,submissions=0;
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{submissions++;},()=>{},{access:{writeBlocked:()=>blocked?'只读查看':undefined,feedback:()=>{}}});
 await view.handleInput('3');assert.equal(view.draft().selections.length,0);
 blocked=false;await view.handleInput('3');await view.handleInput('\r');view.render(132,38);blocked=true;await view.handleInput('\r');assert.equal(submissions,0);assert.match(plain(view.render(132,38)),/只读查看/);
});

test('narrow cards and summaries retain every authorization byte; undersized summary cannot confirm',async()=>{
 const f=fixture();f.candidate.facts.push({claim:'额外事实TAIL_FACT',evidence:['retained-source-TAIL_REF']});f.candidate.structuredChecks![0]={kind:'regression',timeoutMs:30000,program:'console.log("'+('long-check-'.repeat(35))+'TAIL_COMMAND")'};f.candidate.rollback+='TAIL_ROLLBACK';f.save();
 for(const width of [99,56,40]) {
  let submitted=0;const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{submitted++;});const card=allPages(view,width);
  for(const token of ['TAIL_FACT','TAIL_REF','TAIL_COMMAND','TAIL_ROLLBACK','+exportconstadd=(a,b)=>a+b;'])assert.ok(card.includes(token),token);
  await view.handleInput('1');await view.handleInput('\r');const summary=allPages(view,width,34);
  for(const token of [f.workspace+'/math.mjs','报告revision','选择不包含提交、推送、发布或清理数据','在会话里输入的文字不算选择'])assert.ok(summary.includes(token.replace(/\s+/g,'')),token);
  const previousTier=COLOR_TIER;
  try {
   for(const tier of ['truecolor','256color','none'] as const) {
    overrideColorTierForTest(tier);
    const lines=view.render(width,6);await view.handleInput('\r');assert.equal(submitted,0);assert.match(plain(lines),/窗口过小/);
    const footer=captureSnapshot(lines,width,lines.length,tier).rows.find(row=>row.map(cell=>cell.char).join('').includes('Enter'))!;
    const enter=footer.find(cell=>cell.char==='E')!;
    assert.ok(tier==='none'?enter.dim:enter.fg==='fg.faint'&&!enter.dim,`${tier}: disabled summary Enter remains readable`);
   }
  }finally{overrideColorTierForTest(previousTier);}
 }
});

test('improve summary paints its centering space without adding color in the plain tier',async()=>{
 const f=fixture(),previousTier=COLOR_TIER;
 try {
  for(const tier of ['truecolor','256color','none'] as const)for(const [width,height]of [[132,38],[80,24],[40,12]]) {
   overrideColorTierForTest(tier);
   const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{throw Error('rendering cannot submit');});
   await view.handleInput('3');await view.handleInput('\r');
   const lines=view.render(width,height);
   assert.match(plain(lines),/improve 提交汇总/);
   const left=stripTerminalSequences(lines[0]).indexOf('╭');assert.ok(left>0,'the dialog is horizontally centered');
   for(const [y,line]of lines.entries())for(const [x,cell]of captureSnapshot([line],visibleWidth(line),1,tier).rows[0].entries())
    assert.equal(cell.bg,tier==='none'?undefined:x<left?undefined:'bg.block',`${tier} ${width}×${height} cell ${x},${y}`);
   if(tier==='none')assert.doesNotMatch(lines.join(''),/\x1b\[(?:38|48);/);
  }
 }finally{overrideColorTierForTest(previousTier);}
});

test('1d code blocks keep wrapped diff and commands inside the content column in every color tier',async()=>{
 const f=fixture(),program='console.log("'+('LONG_COMMAND_'.repeat(24))+'TAIL_COMMAND")',addition='//'+('LONG_DIFF_'.repeat(18))+'TAIL_DIFF';
 f.candidate.structuredChecks![0]={kind:'regression',timeoutMs:30000,program};
 f.candidate.replacements![0].content='export const add=(a,b)=>a+b;\n'+addition+'\n';f.save();
 const previousTier=COLOR_TIER;
 try {
  for(const tier of ['truecolor','256color','none'] as const)for(const width of [132,80,40]) {
   overrideColorTierForTest(tier);
   const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{throw Error('rendering cannot submit');});
   await view.handleInput('2');
   const lines=view.render(width,160),rows=captureSnapshot(lines,width,160,tier).rows,text=rows.map(row=>row.map(cell=>cell.char).join(''));
   assert.ok(lines.every(line=>visibleWidth(line)<=width));
   const diffStart=text.findIndex(line=>line.startsWith(' --- math.mjs')),checkHeader=text.findIndex(line=>line.startsWith('检查 1  regression'));
   const commandStart=text.findIndex(line=>line.startsWith(' console.log(')),commandEnd=text.findIndex(line=>line.includes('TAIL_COMMAND'));
   assert.ok(diffStart>=0&&checkHeader>diffStart&&commandStart>checkHeader&&commandEnd>commandStart);
   const contentWidth=width===132?106:width,codeRows=[...rows.slice(diffStart,checkHeader),...rows.slice(commandStart,commandEnd+1)];
   for(const row of codeRows) {
    assert.equal(row[0].char,' ','code and continuation lines have one padding column');
    assert.ok(row.slice(0,contentWidth).every(cell=>cell.bg===(tier==='none'?undefined:'bg.block')));
    assert.ok(row.slice(contentWidth).every(cell=>cell.bg!=='bg.block'),'gray block must stop before the options column');
   }
   assert.ok(rows[checkHeader].slice(0,contentWidth).every(cell=>cell.bg===(undefined)),'check explanation stays on the body background');
   assert.equal(text.slice(commandStart,commandEnd+1).map(line=>line.slice(1,contentWidth).trimEnd()).join(''),program,'wrapped command remains complete');
   assert.ok(text.slice(diffStart,checkHeader).map(line=>line.slice(1,contentWidth).trimEnd()).join('').includes('+'+addition),'wrapped diff remains complete');
   const removed=rows[text.findIndex(line=>line.startsWith(' -export const add='))],added=rows[text.findIndex(line=>line.startsWith(' +export const add='))];
   assert.equal(removed[1].char,'-');assert.equal(added[1].char,'+');
   if(tier==='none') {
    assert.doesNotMatch(lines.join(''),/\x1b\[(?:38|48);/);
    const selected=rows[text.findIndex(line=>line.includes('◉ 2 仅验证'))];
    assert.ok(selected.some(cell=>cell.reverse),'selected mode retains reverse video');
   } else {assert.equal(removed[1].fg,'ac.err');assert.equal(added[1].fg,'ac.ok');}
  }
 }finally{overrideColorTierForTest(previousTier);}
});

test('running view can leave without cancellation; prefill cannot replace the submitted batch',async()=>{
 const f=fixture();let finish!:()=>void,started=false;
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{started=true;await new Promise<void>(r=>finish=r);});
 view.prefill([{candidateId:f.candidate.id,mode:'validate-only'}]);view.render(132,38);const submit=view.handleInput('\r');assert.equal(started,true);assert.equal(view.inProgress,true);
 assert.equal(view.back(),true);assert.equal(view.back(),false);assert.equal(view.inProgress,true);
 assert.throws(()=>view.prefill([{candidateId:f.candidate.id,mode:'defer'}]),/进行中/);
 finish();await submit;assert.equal(view.inProgress,false);
});

test('unmarked zero-candidate reports are legacy while partial declarations stay unknown',()=>{
 assert.equal(improveReportContract({candidates:[]}), 'legacy');
 const f=fixture();delete f.candidate.structuredChecks;assert.equal(improveReportContract(f.report),'unknown');
 f.report.selectionContract='declared-v1';assert.equal(improveReportContract(f.report),'declared');
});

test('fresh declarations keep relative thresholds and require still-registered exact case assets and a prepared runtime',()=>{
 const f=fixture(),assets=join(f.root,'assets');mkdirSync(assets);writeFileSync(join(assets,'cases.json'),JSON.stringify({schema:1,id:'cases',version:'v1',kind:'cases',value:[representativeCases[0]]}));
 const reg=registerImproveSource(f.dataRoot,f.workspace,{kind:'eval-asset',root:assets,paths:['cases.json']}),e=new Evidence(f.dataRoot,f.report.runId);
 f.report.targets.push(...captureImproveSources(e,f.workspace,[{id:'cases',kind:'eval-asset',root:assets,paths:['cases.json']}],'fixture-version').targets);e.close();
 const caseId=representativeCases[0].id,check:CandidateFreshCheck={kind:'fresh',assets:[{targetId:'cases',path:'cases.json',caseIds:[caseId]}],mode:'offline',comparison:{kind:'deterministic',repetitions:1,repetitionBasis:'fixed input',change:'one arithmetic operator',hypothesis:'fewer requests',roles:{[caseId]:'objective'},objective:{metric:'requests',direction:'lower',delta:0.1,basis:'one tenth fewer'},protections:[{id:'correct',kind:'hard',check:'requirements',cases:[caseId]}],trialBudget:{maxRequests:2,maxTokens:1000}},budget:{maxRequests:4,maxTokens:2000,maxRequestTokens:1000,maxDurationMs:60000},trialTimeoutMs:10000,gradingTimeoutMs:10000,maxOutputTokens:32};
 assert.doesNotThrow(()=>validateCandidateChecks([check],f.report.targets));f.candidate.objective='performance';f.candidate.structuredChecks=[check];f.save();assert.match(candidateValidation(f.candidate),/δ ≥ 10%/);
 const previousTier=COLOR_TIER;overrideColorTierForTest('truecolor');
 try {
  const lines=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>{}).render(132,160),rows=captureSnapshot(lines,132,160,'truecolor').rows;
  for(const marker of ['"kind": "fresh"','"maxOutputTokens": 32']) {
   const row=rows.find(row=>row.map(cell=>cell.char).join('').includes(marker));assert.ok(row,marker);
   assert.equal(row[0].char,' ');assert.ok(row.slice(0,106).every(cell=>cell.bg==='bg.block'));assert.ok(row.slice(106).every(cell=>cell.bg!=='bg.block'));
  }
 }finally{overrideColorTierForTest(previousTier);}
 const bind=()=>bindCandidateCheck(f.dataRoot,f.report,[f.candidate],check,new Date(Date.now()+60000).toISOString());
 assert.throws(bind,/FRESH_RUNTIME_NOT_PREPARED/);unregisterImproveSource(f.dataRoot,reg.id);assert.throws(bind,/REGISTERED_CASES_REQUIRED/);
 registerImproveSource(f.dataRoot,f.workspace,{kind:'eval-asset',root:assets,paths:['cases.json']});writeFileSync(join(assets,'cases.json'),'changed cases');assert.throws(bind,/CASE_BASELINE_DRIFT/);
});

test('check originals show retained full stdout bytes and route fresh by child root plus plan identity',()=>{
 const f=fixture(),decision=deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode:'validate-only'}],{id:'originals',directory:join(f.root,'originals')}),e=new Evidence(f.dataRoot,f.report.runId);
 const output='retained-START '+('x'.repeat(20000))+' retained-END',chunk=e.blob(output),execution=e.blob(JSON.stringify({stdout:'preview only',stderr:'',output:{stdout:{bytes:Buffer.byteLength(output),chunks:[chunk]},stderr:{bytes:0,chunks:[]}},status:'completed',code:0,terminated:true,sourceEnd:'eof'}));
 e.append('improve.check',{id:decision.id,groupId:'g1',index:0,state:'completed',executionRef:execution});e.close();
 const before=digest(readFileSync(join(f.dataRoot,'host.sqlite'))),original=new ImproveCheckOriginal(f.dataRoot,decision,'g1',()=>{throw Error('direct check never routes to eval')});
 const shown=plain(original.render(80,400)).replace(/\s+/g,'');assert.ok(shown.includes('retained-START'));assert.ok(shown.includes('retained-END'));assert.ok(!shown.includes('previewonly'));
 const child=join(f.root,'nested-eval'),fresh={...decision,groups:[{...decision.groups[0],checks:[{kind:'fresh'} as never]}]};let routed:{root:string;id:string}|undefined;
 const facts=new Evidence(f.dataRoot,f.report.runId);facts.append('eval.plan',{id:'shared-id'});facts.append('improve.decision',{id:fresh.id,decision:fresh,decisions:[]});facts.append('improve.eval',{id:fresh.id,groupId:'g1',index:0,dataRoot:child,planId:'shared-id',parent:{decisionId:fresh.id}});facts.append('improve.eval',{id:fresh.id,groupId:'other-group',index:0,dataRoot:child,planId:'shared-id',parent:{decisionId:fresh.id}});facts.close();
 const readonlyBefore=digest(readFileSync(join(f.dataRoot,'host.sqlite'))),freshOriginal=new ImproveCheckOriginal(f.dataRoot,fresh,'g1',source=>{routed=source;});assert.equal(freshOriginal.openSingleFresh(),true);assert.deepEqual([routed?.root,routed?.id],[child,'shared-id']);assert.equal(digest(readFileSync(join(f.dataRoot,'host.sqlite'))),readonlyBefore);assert.notEqual(before,readonlyBefore);
 let historySource:PlanSource|undefined;
 const history=new ImproveView(f.dataRoot,f.report.id,false,{openEval:source=>{historySource=source;}});history.handleInput('\t');history.handleInput('\r');assert.equal(history.depth,3);history.handleInput('\r');
 assert.deepEqual([historySource?.root,historySource?.id,historySource?.origin?.reportId,historySource?.origin?.decisionId,historySource?.origin?.groupId],[child,'shared-id',f.report.id,fresh.id,'g1']);assert.equal(history.back(),true);assert.equal(history.depth,2);assert.equal(digest(readFileSync(join(f.dataRoot,'host.sqlite'))),readonlyBefore);
});

// Actual isolated process, no model/network: proves stop waits for VM cleanup and
// applies to the enclosing submission, not just the currently selected check.
test('host batch stop matches its origin, waits for cleanup, and leaves the independent remainder not-run',async()=>{
 const f=fixture(),other=join(f.root,'other');mkdirSync(other);writeFileSync(join(other,'math.mjs'),'export const add=(a,b)=>a-b;\n');
 registerImproveSource(f.dataRoot,f.workspace,{kind:'eval-asset',root:other,paths:['math.mjs']});
 const e=new Evidence(f.dataRoot,f.report.runId),target=captureImproveSources(e,f.workspace,[{id:'asset',kind:'eval-asset',root:other,paths:['math.mjs']}],'fixture-version').targets[0];e.close();
 f.candidate.structuredChecks=[{kind:'regression',program:"import {writeFileSync} from 'node:fs';writeFileSync('/work/started','yes');setInterval(()=>{},1000)",timeoutMs:30000}];
 f.report.candidates.push({...structuredClone(f.candidate),id:'candidate:two',display:'R2',revision:'candidate-rev-2',target,structuredChecks:[{kind:'regression',program:'throw Error("must never start")',timeoutMs:30000}]});f.save();
 const decision=deriveImproveDecision(f.dataRoot,f.report.id,f.report.candidates.map(c=>({candidateId:c.id,mode:'validate-only'})),{id:'stoppable',directory:join(f.root,'stoppable')}),batch=new ImproveBatchController(f.dataRoot),running=batch.start(decision),origin={reportId:f.report.id,decisionId:decision.id};
 try {
  assert.equal(batch.canStop({...origin,reportId:'foreign'}),false);assert.deepEqual(await batch.stop({...origin,decisionId:'other'}),{stopped:false});
  const marker=join(decision.directory!,'g1/check-0/execution/work/started'),until=Date.now()+15000;
  while(!existsSync(marker)&&Date.now()<until){if(!batch.running)break;await new Promise(r=>setTimeout(r,25));}
  assert.ok(existsSync(marker),JSON.stringify(batch.running?improveFacts(f.dataRoot).slice(-2):await running));assert.deepEqual(batch.progress(),[1,2]);
  const first=batch.stop(origin),second=batch.stop(origin),[stopped,repeated]=await Promise.all([first,second]);assert.equal(stopped.stopped,true);assert.equal(repeated.stopped,true);
  assert.equal(batch.running,false);assert.deepEqual(stopped.state!.groups.map((g:any)=>g.state),['cancelled','not-run']);
  const execution=JSON.parse(readFileSync(join(decision.directory!,'g1/check-0/execution/outcome.json'),'utf8'));assert.equal(execution.started,true);assert.equal(execution.terminated,true);assert.equal(execution.reason,'cancelled');
  assert.equal(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.group-started').length,1);assert.equal(existsSync(join(decision.directory!,'g2')),false);const lease=await acquireOwner(f.dataRoot,()=>{});await lease.release();
 }finally {if(batch.running)await batch.stop(origin);await running;}
});

function golden(lines:string[],name:string,masks:{value:string;replace:string}[]) {
 const grid=captureSnapshot(lines,132,38,'truecolor'),cells=grid.rows.flat(),significant=cells.map((cell,index)=>({cell,index})).filter(({cell})=>cell.char&&!/[\s│╭╮╰╯─]/.test(cell.char));
 // Mask known fixture roots/identities in the character grid across soft wraps;
 // keep every cell's colors and spacing, so layout remains observable.
 for(const {value,replace}of masks) {
  const source=[...value].filter(c=>!/[\s│╭╮╰╯─]/.test(c)),target=[...replace].filter(c=>!/[\s│╭╮╰╯─]/.test(c));assert.equal(source.length,target.length);
  const text=significant.map(({cell})=>cell.char).join('');let at=text.indexOf(source.join(''));
  while(at>=0){for(let i=0;i<source.length;i++)significant[at+i].cell.char=target[i];at=text.indexOf(source.join(''),at+source.length);}
 }
 const rows=grid.rows.map((row,index)=>{const runs:string[]=[];let start=0;const style=(cell:typeof row[number])=>`${cell.fg??'-'}/${cell.bg??'-'}${cell.bold?'/b':''}`;
  for(let i=1;i<=row.length;i++)if(i===row.length||style(row[i])!==style(row[start])){runs.push(`${start}-${i-1} ${style(row[start])}`);start=i;}
  return `${String(index).padStart(2,'0')}|${row.map(cell=>cell.char).join('')}|\n   ${runs.join(' ; ')}`;
 });
 const text=`132x38 truecolor\n${rows.join('\n')}\n`,path=join(process.cwd(),'test/fixtures/snapshots',`${name}.txt`);
 if(process.env.UPDATE_IMPROVE_GOLDENS==='1'||!existsSync(path)){writeFileSync(path,text);return;}assert.equal(text,readFileSync(path,'utf8'),`snapshot ${name} changed`);
}

test('132x38 card, summary and result golden preserve layout and authorization content',async()=>{
 const previousTier=COLOR_TIER;overrideColorTierForTest('truecolor');try {
 const f=fixture('/tmp');let tick=Date.parse('2099-01-01T01:00:00Z');
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async decision=>{
  // A retained result fixture exercises presentation without pretending it ran.
  const e=new Evidence(f.dataRoot,f.report.runId);e.append('improve.decision',{id:decision.id,decision,decisions:[],price:{version:'test-cny',currency:'CNY',perMillionTokens:8}});
  e.append('improve.validation',{id:decision.id,groupId:'g1',state:'completed',result:{checks:[{kind:'regression',state:'completed'}],effect:'direct-checks-passed',conclusion:{allChecksPassed:true,allRequiredBenefitsMet:true}}});
  e.append('improve.formal',{id:decision.id,groupId:'g1',state:'completed',writeback:'written',activation:'not-enabled',files:[{root:f.workspace,path:'math.mjs'}]});e.append('improve.batch',{id:decision.id,state:'completed'});e.close();tick+=3000;
 },()=>{},{now:()=>tick});
 const mask=(value:string,pattern:RegExp)=>({value,replace:value.replace(pattern,'x')}),masks=[mask(f.root,/[^/]/g),mask(f.candidate.target.baseline.slice(0,12),/[a-f0-9]/g),...f.candidate.facts.flatMap(f=>f.evidence.map(ref=>mask(ref,/[a-f0-9]/g)))];
 golden(view.render(132,38),'improve-selection-132x38',masks);
 await view.handleInput('1');await view.handleInput('\r');const draft=view.draft();masks.push(mask(draft.directory!,/[^/]/g));
 golden(view.render(132,38),'improve-summary-132x38',masks);await view.handleInput('\r');assert.equal(view.currentStage,'result');
 golden(view.render(132,38),'improve-result-132x38',masks);
 assert.ok(allPages(view,56,12).includes(f.workspace+'/math.mjs'));assert.ok(allPages(view,40,12).includes('上限¥0.00'));
 }finally{overrideColorTierForTest(previousTier);}
});

class SelectionTerminal implements Terminal {
 columns=132;rows=38;kittyProtocolActive=false;input:(text:string)=>void=()=>{};resize:()=>void=()=>{};
 start(input:(text:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}stop(){}async drainInput(){}write(){}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
async function untilSelection(predicate:()=>boolean){const deadline=Date.now()+15000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error('selection state timed out');}
test('app commands validate before opening, preserve draft on reopen, and background execution keeps session input while reporting completion',async()=>{
 const f=fixture(),terminal=new SelectionTerminal(),transport=scriptedTransport([{name:'read',args:{path:'math.mjs'}}]);
 f.candidate.structuredChecks=[{kind:'regression',program:'setInterval(()=>{},1000)',timeoutMs:30000}];f.save();
 // Wait for the public runtime lifecycle to prepare the completed session before exercising improve navigation.
 const original=await runReadTask({workspace:f.workspace,dataRoot:f.dataRoot,input:'原会话任务',mode:'offline',transport:transport.fetch});
 assert.equal(original.status,'completed');assert.equal(original.cleanup,'confirmed');
 const app=new ReadOnlyTui({workspace:f.workspace,dataRoot:f.dataRoot,draftRoot:join(f.root,'drafts'),mode:'offline',transport:transport.fetch,resume:original.sessionId,terminal,widthCalibration:false}),screen=()=>plain(app.screen()),key=(text:string)=>terminal.input(text);
 let batchDone:Promise<unknown>|undefined,batchSignal:AbortSignal|undefined;const start=app.improveBatch.start.bind(app.improveBatch);
 app.improveBatch.start=(decision,signal)=>{batchSignal=signal;return batchDone=start(decision,signal);};
 app.start();try {
  assert.match(screen(),/✓ 完成/);assert.match(screen(),/原会话任务/);
  const accepted=readAcceptedTasks(f.dataRoot).tasks.length;
  key('/improve selection-report --execute C-99');assert.doesNotThrow(()=>key('\r'));assert.match(screen(),/候选号无效/);assert.doesNotMatch(screen(),/提交汇总/);assert.equal(app.improveBatch.running,false);
  key('\x15');key('/improve selection-report --validate C-01');key('\r');assert.match(screen(),/提交汇总/);assert.equal(improveFacts(f.dataRoot).filter(f=>f.kind==='improve.decision').length,0);
  key('\x1b');key('\x1b');key('\x1b');key('/improve selection-report');key('\r');assert.match(screen(),/修复加法/);assert.match(screen(),/◉ 2 仅验证/);
  key('\r');assert.match(screen(),/提交汇总/);key('\r');await untilSelection(()=>app.improveBatch.running);assert.match(screen(),/执行进度/);
  key('\x1b');key('\x1b');key('\x1b');assert.match(screen(),/improve 执行/);assert.match(screen(),/原会话任务/);
  key('/improve history');key('\r');assert.match(screen(),/improve 历史/);key('\x03');await new Promise<void>(resolve=>setImmediate(resolve));if(batchSignal?.aborted)await batchDone;
  assert.equal(app.improveBatch.running,true,'history Ctrl+C must not stop an unrelated active batch after asynchronous cleanup');
  assert.equal(improveFacts(f.dataRoot).some(fact=>fact.kind==='improve.batch'&&fact.data.state==='frozen'),false,'history Ctrl+C writes no stop record');key('\x1b');
  key('执行中保留此输入');key('\r');assert.match(screen(),/执行中保留此输入/);assert.equal(readAcceptedTasks(f.dataRoot).tasks.length,accepted);assert.equal(readQueue(f.dataRoot).items.length,0);
  key('\x03');await untilSelection(()=>!app.improveBatch.running&&/improve.*已停止/.test(screen()));assert.match(screen(),/原会话任务/);assert.match(screen(),/执行中保留此输入/);
 }finally{await app.exit();}
});


test('reading a submission summary does not consume its declared execution allowance',async()=>{
 const f=fixture();let now=Date.now(),submitted:ImproveDecision|undefined;
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async decision=>{submitted=decision;},()=>{},{now:()=>now});
 await view.handleInput('2');await view.handleInput('\r');view.render(132,38);
 now+=120000;
 await view.handleInput('\r');
 assert.ok(submitted,'an expired preview is still submittable after explicit confirmation');
 assert.equal(Date.parse(submitted.limits.deadline)-now,30000,'all 30 seconds belong to execution after confirmation');
 assert.equal(submitted.groups[0].changes[0].content,'export const add=(a,b)=>a+b;\n');
});

test('replacement fragments preserve the rest of the captured file and reject ambiguous original text',()=>{
 const f=fixture();f.candidate.replacements=[{path:'math.mjs',before:'a-b',content:'a+b'}];f.save();
 const derive=()=>deriveImproveDecision(f.dataRoot,f.report.id,[{candidateId:f.candidate.id,mode:'execute-declared-scope'}],{id:'fragment',directory:join(f.root,'fragment')});
 const d=derive();assert.equal(d.groups[0].changes[0].content,'export const add=(a,b)=>a+b;\n');
 assert.doesNotThrow(()=>previewImproveDecision(f.dataRoot,d));
 f.candidate.replacements[0].before='missing fragment';f.save();assert.throws(derive,/REPLACEMENT_BASELINE_MISMATCH/);
 f.candidate.replacements[0].before='a';f.save();assert.throws(derive,/REPLACEMENT_BASELINE_MISMATCH/);
 const view=new ImproveSelectionView(f.dataRoot,f.report.id,async()=>assert.fail('ambiguous saved report cannot execute'));
 view.prefill([{candidateId:f.candidate.id,mode:'validate-only'}]);const summary=plain(view.render(132,38));
 assert.match(summary,/替换片段与取证基线不唯一匹配/);assert.match(summary,/IMPROVE_REPLACEMENT_BASELINE_MISMATCH/);
 assert.equal(readFileSync(join(f.workspace,'math.mjs'),'utf8'),'export const add=(a,b)=>a-b;\n','declaring or rejecting fragments never changes the source');
});

test('saved reports without suggestionReason distinguish ambiguous fragments from unreadable originals on the card',()=>{
 const f=fixture();f.candidate.replacements=[{path:'math.mjs',before:'a',content:'b'}];f.save();
 const saved=readImproveReport(f.dataRoot,f.report.id).report!,candidate=saved.candidates[0];
 assert.equal('suggestionReason' in candidate,false,'the persisted report predates suggestionReason');
 const card=()=>improveCandidateRows(f.dataRoot,saved,candidate,{expanded:true,readOnly:true}).map(row=>row.text).join('\n');
 assert.match(card(),/diff math\.mjs · 替换片段与取证基线不唯一匹配/);assert.doesNotMatch(card(),/原文不可读取/);
 candidate.target.files=[];
 assert.match(card(),/diff math\.mjs · 原文不可读取，不能证明替换内容/);
});

test('improve execution versions include enabled instructions and model settings',()=>{
 const f=fixture(),before=currentImproveVersion(f.dataRoot,f.workspace),e=new Evidence(f.dataRoot,'config-change');
 const content=e.blob(JSON.stringify({instructions:'Answer concisely',stream:{timeoutMs:1000}}));
 e.append('improve.activation',{defaults:[{current:{workspace:f.workspace,taskType:'read',files:[{targetId:'config',root:f.workspace,path:'config.json',kind:'agent-config',content}]}}]});e.close();
 assert.notEqual(currentImproveVersion(f.dataRoot,f.workspace),before,'same build with a changed instruction/configuration is a different execution version');
});


test('manual eval plan Ctrl+C preserves an unrelated improve batch and still stops its own pending operation',async()=>{
 const f=fixture(),terminal=new SelectionTerminal(),transport=scriptedTransport([]);
 f.candidate.structuredChecks=[{kind:'regression',program:'setInterval(()=>{},1000)',timeoutMs:30000}];f.save();
 const original=await runReadTask({workspace:f.workspace,dataRoot:f.dataRoot,input:'原会话',mode:'offline',transport:transport.fetch});
 const e=new Evidence(f.dataRoot,'manual-plan');
 const plan:EvalPlan={id:e.runId,purpose:'手动计划取消接缝',mode:'offline',model:{provider:'deepseek',id:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'},image:verifiedImage,runtime:{id:'fixed-runtime',manifest:e.blob('[]'),bytes:2},cases:structuredClone(representativeCases.slice(0,1)),trials:representativeCases.slice(0,1).map(c=>({id:c.id,caseId:c.id,version:'fixed-runtime',side:'candidate',repeat:1,pair:null})),budget:{maxRequests:12,maxTokens:12000,maxRequestTokens:1000,deadline:'2099-01-01T00:00:00Z',unknownUpperBound:null},trialTimeoutMs:90000,gradingTimeoutMs:30000,maxOutputTokens:512,requestRetryLimit:0,price:{version:'cny-test',currency:'CNY',source:'fixed fixture',perMillionTokens:10,consultedAt:'2026-10-17T00:00:00Z'},authorization:{paid:false,scope:'run-all-listed-trials'},environment:{node:'v24.8.0',isolation:'fixture only',cache:'fixed read-only',writable:'new trial'},mainObjective:'diagnostic',protection:['scope'],improvementConclusion:'not-evaluated'};
 e.append('eval.plan',plan);e.close();
 const app=new ReadOnlyTui({workspace:f.workspace,dataRoot:f.dataRoot,draftRoot:join(f.root,'drafts'),mode:'offline',transport:transport.fetch,resume:original.sessionId,terminal,widthCalibration:false}),screen=()=>plain(app.screen()),key=(text:string)=>terminal.input(text);
 let stopped:Promise<unknown>|undefined;const stop=app.improveBatch.stop.bind(app.improveBatch);app.improveBatch.stop=origin=>{const pending=stop(origin);stopped=pending;return pending;};
 app.start();try{
  key('/improve selection-report --validate C-01');key('\r');assert.match(screen(),/提交汇总/);key('\r');await untilSelection(()=>app.improveBatch.running&&improveFacts(f.dataRoot).some(fact=>fact.kind==='improve.decision'));
  const origin=app.improveBatch.origin!,link=new Evidence(f.dataRoot,f.report.runId);
  link.append('improve.eval',{id:origin.decisionId,parent:{decisionId:origin.decisionId},groupId:'g1',planId:'child-plan',dataRoot:join(f.root,'unopened-child-plan')});link.close();
  key('\x1b');key('\x1b');key('\x1b');key('/eval manual-plan');key('\r');assert.match(screen(),/手动计划取消接缝/);
  key('\x03');await new Promise<void>(resolve=>setImmediate(resolve));if(stopped)await stopped;
  assert.equal(app.improveBatch.running,true,'manual plan Ctrl+C must not stop a different improve origin after asynchronous cleanup');
  assert.equal(improveFacts(f.dataRoot).some(fact=>fact.kind==='improve.batch'&&fact.data.state==='frozen'),false,'manual plan Ctrl+C writes no improve stop record');
  key('\x1b');await stop(origin);await untilSelection(()=>!app.improveBatch.running&&/improve.*已停止/.test(screen()));
  key('/eval run manual-plan');key('\r');assert.match(screen(),/启动 eval/);key('\r');key('\x03');key('\x1b');
  await untilSelection(()=>/eval.*未启动/.test(screen()));
  const exit=await app.exit();assert.equal(exit.eval?.planId,'manual-plan');assert.equal(exit.evalCleanup?.owner,'not-acquired');
 }finally{await app.exit();}
});
