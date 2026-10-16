import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {matchesKey,wrapTextWithAnsi,visibleWidth} from '@earendil-works/pi-tui';
import {readImproveReport,type ImproveReport} from '../improve.js';
import {previewImproveDecision,deriveImproveDecision,checkImproveBaseline,type ImproveDecision,type ImproveMode} from '../improve-decisions.js';
import {improveCandidateDecisions,readImproveDecision,decisionBudgetAmount} from '../improve-history.js';
import {readDisplayIndex,type DisplayIndex} from '../display-number.js';
import {candidateExecutable,improveReportContract} from '../improve-contract.js';
import {estimateRunRequests,formatCostTotals,formatAmount,hostPlanPrice} from '../cost-estimate.js';
import type {ImproveDecisionState} from '../improve-batch.js';
import type {PlanSource} from '../eval/overview.js';
import {mayWrite,type WriteAccess} from './write-access.js';
import {clean,hintLine,ConfirmDialog,TOO_SMALL_TO_CONFIRM,wrapAuthorized} from './view-stack.js';
import {styledLine,type TokenName,fgSgr,bgSgr,resetSgr,COLOR_TIER} from './theme.js';
import {improveCandidateCard,IMPROVE_MODES,MODE_LABEL,suggestionReason} from './improve-card.js';
import {ImproveCheckOriginal,improveResultGroups,improveActualCost,elapsed} from './improve-result.js';
export {improveCandidateCard,improveCandidateRows,type CandidateCardOptions} from './improve-card.js';

export interface ImproveSelectionOptions {
 access?:WriteAccess;now?:()=>number;installation?:string;
 submitBlocked?:()=>string|undefined;
 openEval?:(source:PlanSource)=>void;
}
export type ImprovePrefill={candidateId:string;mode:ImproveMode}[];
/** Resolve all values before opening a view. Commands only prefill a summary. */
export function improveSelectionPrefill(report:ImproveReport,options:Record<string,string|true>):ImprovePrefill {
 const names:Record<string,ImproveMode>={execute:'execute-declared-scope',validate:'validate-only',defer:'defer','do-not-suggest':'do-not-suggest'},selected=new Map<string,ImproveMode>();
 for(const [name,mode]of Object.entries(names))if(options[name]!==undefined) {
  if(typeof options[name]!=='string')throw Error(`--${name} 需要 C-号`);
  for(const value of String(options[name]).split(',')) {
   const number=/^C-(\d+)$/i.exec(value),candidate=number?report.candidates.find(c=>Number(c.display.replace(/^R/,''))===Number(number[1])):report.candidates.find(c=>c.id===value);
   if(!candidate)throw Error(`候选号无效：${value}；请用本报告的 C-号或完整 id`);
   if(selected.has(candidate.id))throw Error(`${value} 重复选择；同一候选只能有一个模式`);
   if(['execute-declared-scope','validate-only'].includes(mode)&&!candidateExecutable(candidate))throw Error(`${value} 仅建议：${suggestionReason(candidate)}`);
   selected.set(candidate.id,mode);
  }
 }
 return [...selected].map(([candidateId,mode])=>({candidateId,mode}));
}
const errors:Record<string,string>={
 IMPROVE_SELECTION_CONFLICT:'候选同批互斥，只能保留一项',IMPROVE_DEPENDENCY_NOT_SELECTED:'依赖项未选，不会自动执行',IMPROVE_COMBINATION_MODE_CONFLICT:'同一组合的模式必须一致',IMPROVE_COMBINATION_CONTENT_CONFLICT:'组合对同一文件声明了不兼容的替换内容',
 IMPROVE_BASELINE_DRIFT:'基线已变化，旧选择失效；请重新分析',IMPROVE_DEFAULT_BASELINE_DRIFT:'默认配置基线已变化；请重新分析',IMPROVE_REPORT_REVISION_DRIFT:'报告已变化，旧选择失效；请重新分析',IMPROVE_CANDIDATE_REVISION_DRIFT:'候选内容已变化；请重新分析',IMPROVE_CANDIDATE_ALREADY_DECIDED:'该候选已有决定；只有验证通过后可以再选执行',
 IMPROVE_PROFILE_SCOPE_REQUIRED:'尚未声明配置或 prompt·skill 的生效任务类型',IMPROVE_SUGGESTION_ONLY:'仅建议的候选不能执行或仅验证',IMPROVE_FRESH_RUNTIME_NOT_PREPARED:'fresh 对照的宿主 runtime 尚未准备',IMPROVE_FRESH_CASE_BASELINE_DRIFT:'fresh 案例基线已变化；请重新分析',IMPROVE_FRESH_REGISTERED_CASES_REQUIRED:'fresh 案例必须来自仍有效的已登记 eval 资产',IMPROVE_DEPENDENCY_CYCLE:'候选依赖成环，不能推导执行顺序',IMPROVE_DEADLINE:'授权时限已过；返回调整后重新核对',
};
export function improveChoiceError(error:unknown) {const text=String(error instanceof Error?error.message:error),code=text.split(':')[0];return errors[code]?`${errors[code]}（${text}）`:text;}

/** One process-local draft per report. Navigation retains this instance; no
 * unsubmitted choice is written to the product record store. */
export class ImproveSelectionView {
 readonly report:ImproveReport;
 private index:DisplayIndex;private selected=0;private line=0;private reveal=false;private modes=new Map<string,ImproveMode>();
 private stage:'select'|'summary'|'result'|'original'='select';private shown=false;private busy=false;private feedback='';private problems:string[]=[];
 private prepared?:ImproveDecision;private result?:ImproveDecisionState;private raw?:ImproveCheckOriginal;private resultSelection=0;
 private id:string=randomUUID();private startedAt=0;private endedAt=0;private lastRead=0;private analysisCost='费用未知';private drift=false;
 private tooSmall=false;
 private decisions:ReturnType<typeof improveCandidateDecisions>;private legacyTemplate?:ImproveDecision;
 private readonly access:WriteAccess;private readonly now:()=>number;
 constructor(private root:string,reportOrTemplate:string|ImproveDecision,private submit:(d:ImproveDecision)=>Promise<unknown>,private changed:()=>void=()=>{},private options:ImproveSelectionOptions={}) {
  const id=typeof reportOrTemplate==='string'?reportOrTemplate:reportOrTemplate.reportId;
  const report=readImproveReport(root,id).report;if(!report||typeof reportOrTemplate!=='string'&&report.revision!==reportOrTemplate.reportRevision)throw Error('IMPROVE_REPORT_REVISION_DRIFT');
  this.report=report;this.index=readDisplayIndex(root);this.decisions=improveCandidateDecisions(root,id);this.now=options.now??Date.now;
  this.access={writeBlocked:()=>options.access?.writeBlocked(),feedback:text=>{this.feedback=text;options.access?.feedback(text);}};
  if(typeof reportOrTemplate!=='string'&&improveReportContract(report)==='legacy'){this.legacyTemplate=reportOrTemplate;this.id=reportOrTemplate.id;}
  try{this.analysisCost=formatCostTotals(estimateRunRequests(root,report.runId).totals).replace('≈ ','≈');}catch{/* Missing usage remains unknown. */}
 }
 get inProgress(){return this.busy;}
 get reportId(){return this.report.id;}
 get currentStage(){return this.stage;}
 /** On re-entry, retain choices only while the exact report is unchanged. */
 refresh() {
  const current=readImproveReport(this.root,this.report.id).report;
  if(!this.busy&&(!current||current.revision!==this.report.revision)){this.modes.clear();this.prepared=undefined;this.drift=true;this.feedback='报告已变化，旧选择失效；请重新分析';}
  this.decisions=improveCandidateDecisions(this.root,this.report.id);
 }
 showProgress(){this.stage='result';this.line=0;}
 /** Observe the host's existing continuation promise without submitting again. */
 observeContinuation(decision:ImproveDecision,done:Promise<unknown>) {
  if(decision.reportId!==this.report.id||decision.reportRevision!==this.report.revision)throw Error('IMPROVE_REPORT_REVISION_DRIFT');
  this.prepared=structuredClone(decision);this.problems=[];this.busy=true;this.startedAt=this.now();this.endedAt=0;this.lastRead=0;this.resultSelection=0;this.showProgress();this.readResult();this.changed();
  void done.then(()=>{},error=>{this.problems=[improveChoiceError(error)];}).finally(()=>{this.busy=false;this.endedAt=this.now();this.readResult();this.decisions=improveCandidateDecisions(this.root,this.report.id);this.changed();});
 }
 prefill(selections:ImprovePrefill) {
  if(this.busy)throw Error('提交批次进行中，不能覆盖已有选择');
  if(!mayWrite(this.access))return;
  const modes=new Map(selections.map(s=>[s.candidateId,s.mode]));
  if(modes.size!==selections.length||selections.some(s=>!this.report.candidates.some(c=>c.id===s.candidateId)))throw Error('候选号无效或重复');
  this.modes=modes;this.summary();
 }
 draft():ImproveDecision {
  const selections=this.report.candidates.filter(c=>this.modes.has(c.id)).map(c=>({candidateId:c.id,mode:this.modes.get(c.id)!}));
  if(this.legacyTemplate) {
   const selected=selections.map(s=>{const c=this.report.candidates.find(c=>c.id===s.candidateId)!;return {candidateId:c.id,candidateRevision:c.revision,target:c.target,mode:s.mode,steps:c.steps,...(s.mode==='execute-declared-scope'?{formal:structuredClone(this.legacyTemplate!.selections.find(t=>t.candidateId===c.id)?.formal)}:{})};});
   const active=new Set(selected.filter(s=>['validate-only','execute-declared-scope'].includes(s.mode)).map(s=>s.candidateId));
   return {...structuredClone(this.legacyTemplate),selections:selected,groups:this.legacyTemplate.groups.filter(g=>g.candidateIds.some(id=>active.has(id)))};
  }
  return deriveImproveDecision(this.root,this.report.id,selections,{id:this.id,directory:join(realpathSync(tmpdir()),`pi-durio-improve-${this.id}`),now:this.now(),installation:this.options.installation});
 }
 private invalidateOnDrift(error:unknown) {
  if(/DRIFT|IDENTITY|DEFAULT_CHANGED/.test(String(error))){this.modes.clear();this.prepared=undefined;this.drift=true;}
 }
 private summary() {
  if(!this.modes.size){this.feedback='尚未选择';this.changed();return;}
  if(!mayWrite(this.access))return;
  this.stage='summary';this.line=0;this.shown=false;this.problems=[];this.prepared=undefined;
  const active=this.report.candidates.filter(c=>['execute-declared-scope','validate-only'].includes(this.modes.get(c.id)??'')),label=(id:string)=>{const c=this.report.candidates.find(c=>c.id===id);return c?this.index.candidate(c):id;};
  for(const c of active){
   for(const id of c.dependencies)if(!active.some(a=>a.id===id))this.problems.push(`${label(c.id)} 需要 ${label(id)}；依赖项未选`);
   for(const id of c.conflicts)if(active.some(a=>a.id===id))this.problems.push(`${label(c.id)} 与 ${label(id)} 冲突，只能保留一项`);
  }
  if(this.drift)this.problems.push('报告已变化，旧选择失效；请重新分析');
  const blocked=this.options.submitBlocked?.();if(blocked)this.problems.push(blocked);
  for(const c of this.report.candidates.filter(c=>this.modes.has(c.id)))try{if(c.target.workspace)checkImproveBaseline(c.target);}catch(error){this.problems.push(improveChoiceError(error));this.invalidateOnDrift(error);}
  try {this.prepared=this.draft();if(this.prepared.reportRevision!==this.report.revision)throw Error('IMPROVE_REPORT_REVISION_DRIFT');previewImproveDecision(this.root,this.prepared);}catch(error){this.problems.push(improveChoiceError(error));this.invalidateOnDrift(error);}
  if(this.drift)this.prepared=undefined;
  this.problems=[...new Set(this.problems)];this.changed();
 }
 /** Esc returns inside 1d, then leaves it. It never cancels the batch. */
 back():boolean {
  if(this.stage==='original'){this.raw=undefined;this.stage='result';this.line=0;return true;}
  if(this.stage!=='select'){this.stage='select';this.line=0;this.shown=false;if(!this.busy)this.decisions=improveCandidateDecisions(this.root,this.report.id);return true;}
  return false;
 }
 scroll(delta:number){if(this.stage==='original')this.raw?.scroll(delta);else this.line=Math.max(0,this.line+delta);this.changed();}
 private readResult(){if(!this.prepared)return;if(this.busy&&this.now()-this.lastRead<250)return;this.lastRead=this.now();try{this.result=readImproveDecision(this.root,this.prepared.id);}catch{/* Receipt may not exist yet. */}}
 async handleInput(data:string) {
  this.feedback='';
  if(this.stage==='original'){this.raw?.handleInput(data);this.changed();return;}
  if(matchesKey(data,'escape')){this.back();this.changed();return;}
  if(matchesKey(data,'pageDown'))this.scroll(8);if(matchesKey(data,'pageUp'))this.scroll(-8);
  if(this.stage==='select') {
   if(matchesKey(data,'tab')||matchesKey(data,'shift+tab')){const n=this.report.candidates.length;if(n)this.selected=(this.selected+(matchesKey(data,'shift+tab')?-1:1)+n)%n;this.reveal=true;}
   if(matchesKey(data,'up'))this.scroll(-1);if(matchesKey(data,'down'))this.scroll(1);
   const mode=/^[1-4]$/.test(data)?IMPROVE_MODES[Number(data)-1]:undefined,candidate=this.report.candidates[this.selected];
   if(mode&&candidate&&!this.busy&&mayWrite(this.access)) {
    const prior=this.decisions.get(candidate.id);
    if(this.drift)this.feedback='基线或报告已变化；请重新分析';
    else if(prior&&!(prior.canExecute&&mode==='execute-declared-scope'))this.feedback='该候选已决定，只读查看决定和结果';
    else if(IMPROVE_MODES.indexOf(mode)<2&&!candidateExecutable(candidate)&&!this.legacyTemplate)this.feedback=`仅建议：${suggestionReason(candidate)}`;
    else{if(this.modes.get(candidate.id)===mode)this.modes.delete(candidate.id);else this.modes.set(candidate.id,mode);}
   }
   if(matchesKey(data,'enter')){if(this.busy)this.showProgress();else this.summary();}
  }else if(this.stage==='summary') {
   if(matchesKey(data,'up'))this.scroll(-1);if(matchesKey(data,'down'))this.scroll(1);
   if(matchesKey(data,'enter')&&this.shown&&!this.tooSmall&&this.prepared&&!this.problems.length&&!this.busy&&mayWrite(this.access)) {
    try{const blocked=this.options.submitBlocked?.();if(blocked)throw Error(blocked);previewImproveDecision(this.root,this.prepared);}catch(error){this.problems=[improveChoiceError(error)];this.invalidateOnDrift(error);this.changed();return;}
    this.busy=true;this.stage='result';this.line=0;this.startedAt=this.now();this.resultSelection=0;this.changed();
    try{await this.submit(this.prepared);}catch(error){this.problems=[improveChoiceError(error)];}
    finally{this.busy=false;this.endedAt=this.now();this.readResult();this.decisions=improveCandidateDecisions(this.root,this.report.id);this.modes.clear();this.id=randomUUID();this.changed();}
   }
  }else if(this.stage==='result') {
   const count=this.prepared?.groups.length??0;
   if(matchesKey(data,'up')){this.resultSelection=Math.max(0,this.resultSelection-1);this.reveal=true;}if(matchesKey(data,'down')){this.resultSelection=Math.min(Math.max(0,count-1),this.resultSelection+1);this.reveal=true;}
   if(matchesKey(data,'enter')&&this.prepared&&count) {
    const group=this.prepared.groups[this.resultSelection];this.raw=new ImproveCheckOriginal(this.root,this.prepared,group.id,source=>this.options.openEval?.(source));
    if(!this.raw.openSingleFresh()){this.stage='original';this.line=0;}
   }
  }
  this.changed();
 }
 private summaryRows():{text:string;fg?:TokenName;fixed?:boolean}[] {
  const counts=IMPROVE_MODES.map(mode=>`${MODE_LABEL[mode]} ${[...this.modes.values()].filter(m=>m===mode).length}`).join(' · '),d=this.prepared;
  const rows:{text:string;fg?:TokenName;fixed?:boolean}[]=[{text:'◆ improve 提交汇总',fg:'ac.improve'},{text:counts}];
  if(d?.groups.length) {
   rows.push({text:'执行计划',fg:'fg.label'});
   for(const [i,g]of d.groups.entries()) {
    const selections=d.selections.filter(s=>g.candidateIds.includes(s.candidateId)),mode=selections[0].mode,candidates=g.candidateIds.map(id=>this.report.candidates.find(c=>c.id===id)!);
    rows.push({text:`${i+1}. ${g.candidateIds.map(id=>this.index.candidate(this.report.candidates.find(c=>c.id===id)!)).join(' + ')}${g.candidateIds.length>1?' 组合':''} · ${MODE_LABEL[mode]} · ${mode==='validate-only'?'只在临时副本验证，正式目标不写回':`写回 ${candidates.flatMap(c=>(c.replacements??[]).map(r=>`${c.target.workspace}/${r.path}`)).join('、')}`} · ${candidates.map(c=>c.activation.timing).join('；')}`});
    for(const s of selections)if(s.formal?.activate)rows.push({text:`启用范围 ${s.formal.activate.workspace} · ${s.formal.activate.taskTypes.join('、')} 后续新任务默认`});
    for(const s of selections)if(s.formal?.newProcess)rows.push({text:`新 build 入口 ${s.formal.newProcess.workspace} · 仅后续显式启动的新进程`});
    for(const check of g.checks)if(check.kind==='fresh')rows.push({text:`fresh ${check.options.mode} · ${check.options.mode==='live'?'会调用真实模型并产生费用':'受控离线调用'} · ${check.options.cases!.map(c=>c.id).join('、')} · ${check.comparison.repetitions} 次配对重复 · runtime ${check.runtimeIdentity.slice(0,12)}`});
   }
   const budget=decisionBudgetAmount(d.limits.maxTokens,hostPlanPrice('deepseek','deepseek-flash')),time=new Date(d.limits.deadline);
   rows.push({fixed:true,text:`总预算 ≤ ${d.limits.maxRequests} 请求 · ${formatAmount(budget.amount!,'CNY').replace('≈ ','≈')}（在途请求按高峰价）· 检查 ${d.limits.maxChecks} 项 · 最晚 ${time.toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'})} 结束`},{fixed:true,text:`价目 ${budget.version} · 临时目录 ${d.directory}`,fg:'fg.muted'});
  }else if(![...this.modes.values()].some(m=>IMPROVE_MODES.indexOf(m)<2))rows.push({fixed:true,text:'本次只记录决定，不执行任何候选'});
  rows.push({fixed:true,text:`绑定 ${this.index.label('improve-report',this.report.id)} · 报告 revision ${this.report.revision}`,fg:'fg.label'});
  for(const c of this.report.candidates.filter(c=>this.modes.has(c.id)))rows.push({fixed:true,text:`${this.index.candidate(c)} · ${MODE_LABEL[this.modes.get(c.id)!]} · 基线 ${c.target.baseline.slice(0,12)} · ${c.target.workspace??'未核对目标'}`});
  if(this.problems.length)rows.push({text:'不能提交 · Enter 不可用',fg:'ac.err'},...this.problems.map(text=>({text,fg:'ac.warn' as const})));
  rows.push({fixed:true,text:'失败、取消或出现未知副作用时，剩余项不启动',fg:'ac.warn'},{fixed:true,text:'选择不包含提交、推送、发布或清理数据'},{fixed:true,text:'在会话里输入的文字不算选择'});
  return rows;
 }
 private dialog(width:number,height:number,rows:{text:string;fg?:TokenName;fixed?:boolean}[],summary:boolean,selectedStart=0) {
  const boxWidth=ConfirmDialog.width(width),inner=Math.max(1,boxWidth-4),padding=' '.repeat(Math.max(0,Math.floor((width-boxWidth)/2)));
  const wrap=(row:{text:string;fg?:TokenName})=>wrapAuthorized(row.text,inner).map(text=>({text,fg:row.fg}));
  const title=rows[0],allTitle=wrap(title),titles=allTitle.slice(0,1),body=[...allTitle.slice(1),...rows.slice(1).filter(row=>!row.fixed).flatMap(wrap)],fixed=rows.filter(row=>row.fixed).flatMap(wrap);
  selectedStart+=Math.max(0,allTitle.length-1);
  const normalFooter=summary?'↑↓ 核对 · Enter 提交 · Esc 返回调整':`↑↓ 选组 · Enter 检查原文${this.busy?' · Ctrl+C 停止':''} · Esc 返回选择`;
  const blockedFooter=summary&&this.problems.length?'Enter 不可用 · ↑↓ 查看原因 · Esc 返回调整':normalFooter;
  const footer=(reason?:string)=>wrapAuthorized(reason?`Enter ${reason} · Esc 返回调整`:this.feedback||blockedFooter,inner);
  const chrome=2+titles.length+Math.max(footer(TOO_SMALL_TO_CONFIRM).length,footer().length);
  this.tooSmall=summary&&height<chrome+fixed.length+1;this.shown=summary&&!this.tooSmall;
  const border=(text:string)=>(COLOR_TIER==='none'?'':bgSgr('bg.block')+fgSgr('border.input'))+text+resetSgr();
  const row=(text:string,fg:TokenName='fg.body',bold=false)=>padding+border('│ ')+styledLine([{text,fg,bold}],inner,'bg.block')+border(' │');
  const lines=[padding+border(`╭${'─'.repeat(Math.max(0,boxWidth-2))}╮`),...titles.map(title=>row(title.text,title.fg??'fg.primary',true))];
  if(!this.tooSmall) {
   const room=Math.max(0,height-chrome-fixed.length);
   if(this.reveal){this.line=selectedStart;this.reveal=false;}
   this.line=Math.max(0,Math.min(this.line,Math.max(0,body.length-room)));
   for(const item of body.slice(this.line,this.line+room))lines.push(row(item.text,item.fg));
   for(const item of fixed)lines.push(row(item.text,item.fg??'fg.label'));
  }
  for(const text of footer(this.tooSmall?TOO_SMALL_TO_CONFIRM:undefined))lines.push(row(text,this.tooSmall||summary&&this.problems.length?'fg.muted':'fg.label'));
  lines.push(padding+border(`╰${'─'.repeat(Math.max(0,boxWidth-2))}╯`));
  return lines.slice(0,Math.max(0,height));
 }
 render(width:number,height:number):string[] {
  if(this.stage==='original')return this.raw!.render(width,height);
  if(this.stage==='summary')return this.dialog(width,height,this.summaryRows(),true);
  const wrap=(text:string,fg:TokenName='fg.body')=>wrapTextWithAnsi(clean(text),Math.max(1,width)).map(text=>styledLine([{text,fg}],width));
  let lines:string[]=[],header:string[]=[],selectedStart=0;
  if(this.stage==='select') {
   const head=`◆ improve ${this.index.label('improve-report',this.report.id)}`,right=`${this.report.candidates.length} 个候选 · ${this.analysisCost}`;
   lines.push(...(width>=100&&visibleWidth(head+'  '+right)<=width?wrap(head+' '.repeat(width-visibleWidth(head+right))+right,'ac.improve'):[...wrap(head,'ac.improve'),...wrap(right,'fg.label')]));
   if(this.report.state==='incomplete')lines.push(...wrap(`报告不完整 · ${this.report.reason??'原因未知'}`,'ac.warn'));
   if(this.drift)lines.push(...wrap('旧选择失效；请重新分析','ac.warn'));
   header=lines;lines=[];const compact=height<20;
   this.report.candidates.forEach((c,i)=>{
    if(compact&&i!==this.selected)return;
    if(i===this.selected)selectedStart=lines.length;
    lines.push(...improveCandidateCard(this.root,this.report,c,width,{expanded:i===this.selected,selected:i===this.selected,mode:this.modes.get(c.id),decision:this.decisions.get(c.id),readOnly:!!this.access.writeBlocked()}));
   });
   if(!this.report.candidates.length)lines.push(...wrap('没有候选；没有可提交的选择','fg.muted'));
   if(compact&&this.report.candidates.length>1)lines.push(...wrap(`其他 ${this.report.candidates.length-1} 项 · Tab 切换`,'fg.label'));
   if(this.report.suppressed?.length)lines.push(...wrap(`另有 ${this.report.suppressed.length} 项已按“不再建议”隐藏`,'fg.muted'));
  }else if(this.prepared) {
   this.readResult();const stopped=!this.busy&&(this.result?.state!=='completed'||this.problems.length>0),reason=this.problems.join('；')||this.result?.reason||'执行结果未取得';
   const rows:{text:string;fg?:TokenName;fixed?:boolean}[]=[{text:this.busy?'◆ improve 执行进度':stopped?`◆ 已停止 · ${improveChoiceError(reason)}`:'◆ 已结束',fg:this.busy?'ac.improve':stopped?'ac.warn':'ac.ok'}];
   const groups=improveResultGroups(this.root,this.report,this.prepared,this.result,this.busy),inner=Math.max(1,ConfirmDialog.width(width)-4);let at=0;
   groups.forEach((group,i)=>{if(i===this.resultSelection)selectedStart=at;const text=`${i===this.resultSelection?'▸ ':'  '}${group.text}`;rows.push({text});at+=wrapAuthorized(text,inner).length;});
   for(const s of this.prepared.selections.filter(s=>IMPROVE_MODES.indexOf(s.mode)>=2))rows.push({text:`${this.result?'✓':'·'} ${this.index.candidate(this.report.candidates.find(c=>c.id===s.candidateId)!)} · ${MODE_LABEL[s.mode]} · ${this.result?'决定已记录':'等待可靠保存决定'}`});
   const max=decisionBudgetAmount(this.prepared.limits.maxTokens,this.result?.price??hostPlanPrice('deepseek','deepseek-flash'));
   rows.push({fixed:true,text:`实际 ${improveActualCost(this.root,this.prepared.id)} / 上限 ${max.currency==='CNY'?'¥':''}${max.amount?.toFixed(2)??'未知'} · 用时 ${elapsed((this.busy?this.now():this.endedAt)-this.startedAt)}`,fg:'fg.label'});
   if(stopped)rows.push({text:'到历史报告继续符合条件的未运行独立项',fg:'fg.muted'});
   return this.dialog(width,height,rows,false,selectedStart);
  }
  const count=Math.max(1,height-header.length-1);
  if(this.reveal&&(this.stage==='select'||this.stage==='result')){this.line=selectedStart;this.reveal=false;}
  this.line=Math.min(this.line,Math.max(0,lines.length-count));
  const hints=['1–4 选择 / 取消','Tab 切换候选','↑↓ 滚动',this.busy?'Enter 查看进度':'Enter 汇总'];
  return [...header,...lines.slice(this.line,this.line+count),hintLine(hints,width,{esc:'Esc 返回第一层',feedback:this.feedback||undefined})];
 }
}
export {ImproveView} from './improve.js';
