import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {matchesKey,wrapTextWithAnsi,visibleWidth} from '@earendil-works/pi-tui';
import {readImproveReport,type ImproveCandidate,type ImproveReport} from '../improve.js';
import {previewImproveDecision,deriveImproveDecision,startImproveDecisionClock,improveDecisionDuration,checkImproveBaseline,type ImproveDecision,type ImproveMode} from '../improve-decisions.js';
import {improveCandidateDecisions,readImproveDecision,decisionBudgetAmount} from '../improve-history.js';
import {readDisplayIndex,type DisplayIndex} from '../display-number.js';
import {candidateExecutable} from '../improve-contract.js';
import {REPLACEMENT_MISMATCH_REASON} from '../improve-replacements.js';
import {estimateRunRequests,formatCostTotals,formatAmount,hostPlanPrice,upperBoundAmount} from '../cost-estimate.js';
import type {ImproveDecisionState} from '../improve-batch.js';
import type {PlanSource} from '../eval/overview.js';
import {mayWrite,type WriteAccess} from './write-access.js';
import {clean,hintLine,footerLines,fitSegments,frameBox,rule,ConfirmDialog,TOO_SMALL_TO_CONFIRM,wrapAuthorized} from './view-stack.js';
import {styledLine,type TextSegment,type TokenName} from './theme.js';
import {improveCandidateRows,IMPROVE_MODES,MODE_LABEL,suggestionReason} from './improve-card.js';
import {reportTime} from './improve-home.js';
import {ImproveCheckOriginal,improveResultGroups,improveActualCost,elapsed} from './improve-result.js';
export {improveCandidateCard,improveCandidateRows,type CandidateCardOptions} from './improve-card.js';

export interface ImproveSelectionOptions {
 access?:WriteAccess;now?:()=>number;installation?:string;
 submitBlocked?:()=>string|undefined;
 openEval?:(source:PlanSource)=>void;
}
export type ImprovePrefill={candidateId:string;mode:ImproveMode}[];
/** Resolve all values before opening a view. Commands only prefill a summary. */
export function improveSelectionPrefill(root:string,report:ImproveReport,options:Record<string,string|true>):ImprovePrefill {
 const index=readDisplayIndex(root);
 const names:Record<string,ImproveMode>={execute:'execute-declared-scope',validate:'validate-only',defer:'defer','do-not-suggest':'do-not-suggest'},selected=new Map<string,ImproveMode>();
 for(const [name,mode]of Object.entries(names))if(options[name]!==undefined) {
  if(typeof options[name]!=='string')throw Error(`--${name} 需要 C-号`);
  for(const value of String(options[name]).split(',')) {
   const number=/^C-(\d+)(?:@r(\d+))?$/i.exec(value),candidate=number?report.candidates.find(c=>Number(c.display.replace(/^R/,''))===Number(number[1])&&(!number[2]||index.candidate(c).toLowerCase()===value.toLowerCase())):report.candidates.find(c=>c.id===value);
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
 IMPROVE_REPLACEMENT_BASELINE_MISMATCH:REPLACEMENT_MISMATCH_REASON,IMPROVE_REPLACEMENT_ENCODING_UNSUPPORTED:'取证基线不是 UTF-8 文本，不能安全替换',
};
export function improveChoiceError(error:unknown) {const text=String(error instanceof Error?error.message:error),code=text.split(':')[0];return errors[code]?`${errors[code]}（${text}）`:text;}
/** 1d 右侧选项列的宽度与选中项字形颜色（视觉修正 r1）。 */
const OPTION_WIDTH=24;
const MODE_COLOR:Record<ImproveMode,TokenName>={'execute-declared-scope':'ac.ok','validate-only':'ac.info',defer:'ac.warn','do-not-suggest':'fg.muted'};

/** One process-local draft per report. Navigation retains this instance; no
 * unsubmitted choice is written to the product record store. */
export class ImproveSelectionView {
 readonly report:ImproveReport;
 private index:DisplayIndex;private selected=0;private line=0;private reveal=false;private modes=new Map<string,ImproveMode>();
 private stage:'select'|'summary'|'result'|'original'='select';private shown=false;private busy=false;private feedback='';private problems:string[]=[];
 private prepared?:ImproveDecision;private result?:ImproveDecisionState;private raw?:ImproveCheckOriginal;private resultSelection=0;
 private id:string=randomUUID();private startedAt=0;private endedAt=0;private lastRead=0;private analysisCost='费用未知';private drift=false;
 private tooSmall=false;private confirmation?:ConfirmDialog;private confirmationSummary?:boolean;
 private decisions:ReturnType<typeof improveCandidateDecisions>;
 private readonly access:WriteAccess;private readonly now:()=>number;
 constructor(private root:string,reportId:string,private submit:(d:ImproveDecision)=>Promise<unknown>,private changed:()=>void=()=>{},private options:ImproveSelectionOptions={}) {
  const report=readImproveReport(root,reportId).report;if(!report)throw Error('IMPROVE_REPORT_REVISION_DRIFT');
  this.report=report;this.index=readDisplayIndex(root);this.decisions=improveCandidateDecisions(root,reportId);this.now=options.now??Date.now;
  this.access={writeBlocked:()=>options.access?.writeBlocked(),feedback:text=>{this.feedback=text;options.access?.feedback(text);}};
  this.analysisCost=formatCostTotals(estimateRunRequests(root,report.runId).totals).replace('≈ ','≈');
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
  return deriveImproveDecision(this.root,this.report.id,selections,{id:this.id,directory:join(realpathSync(tmpdir()),`pi-durio-improve-${this.id}`),now:this.now(),installation:this.options.installation});
 }
 private invalidateOnDrift(error:unknown) {
  if(/DRIFT|IDENTITY|DEFAULT_CHANGED/.test(String(error))){this.modes.clear();this.prepared=undefined;this.drift=true;}
 }
 private summary() {
  if(!this.modes.size){this.feedback='尚未选择';this.changed();return;}
  if(!mayWrite(this.access))return;
  this.stage='summary';this.confirmation=undefined;this.line=0;this.shown=false;this.problems=[];this.prepared=undefined;
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
 scroll(delta:number){if(this.stage==='original')this.raw?.scroll(delta);else if(this.stage==='summary'||this.stage==='result')this.confirmation?.scrollBy(delta);else this.line=Math.max(0,this.line+delta);this.changed();}
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
    else if(IMPROVE_MODES.indexOf(mode)<2&&!candidateExecutable(candidate))this.feedback=`仅建议：${suggestionReason(candidate)}`;
    else{if(this.modes.get(candidate.id)===mode)this.modes.delete(candidate.id);else this.modes.set(candidate.id,mode);}
   }
   if(matchesKey(data,'enter')){if(this.busy)this.showProgress();else this.summary();}
  }else if(this.stage==='summary') {
   if(matchesKey(data,'up'))this.scroll(-1);if(matchesKey(data,'down'))this.scroll(1);
   if(matchesKey(data,'enter')&&this.shown&&!this.tooSmall&&this.prepared&&!this.problems.length&&!this.busy&&mayWrite(this.access)) {
    try{const blocked=this.options.submitBlocked?.();if(blocked)throw Error(blocked);this.prepared=startImproveDecisionClock(this.root,this.prepared,this.now());previewImproveDecision(this.root,this.prepared);}catch(error){this.problems=[improveChoiceError(error)];this.invalidateOnDrift(error);this.changed();return;}
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
 /**
  * 1d 卡片（U4，视觉修正 r1）：卡头与摘要行分色；当前卡原地展开全部细节。宽度不小于 100 时四个选项
  * 竖排在右侧，选中项整行 `bg.selected`；更窄时在卡片下方一行，小于 60 时分两行。只读时不显示选项。
  */
 private card(c:ImproveCandidate,current:boolean,width:number):string[] {
  const decision=this.decisions.get(c.id),mode=this.modes.get(c.id),readOnly=!!this.access.writeBlocked(),side=!readOnly&&width>=100,textWidth=side?width-OPTION_WIDTH-2:width;
  // 选项列已显示所选模式时，卡头不再重复写它。
  const rows=improveCandidateRows(this.root,this.report,c,{expanded:current,summary:true,selected:current,mode:side?undefined:mode,decision,readOnly});
  // 分色行按词换行（与整行文字相同的断点），再把每个字符的样式放回去。
  const wrapStyled=(segments:TextSegment[])=>{
   const chars=segments.flatMap(s=>Array.from(clean(s.text),char=>({char,style:s})));let at=0;
   return wrapTextWithAnsi(chars.map(c=>c.char).join(''),Math.max(1,textWidth)).map(line=>Array.from(line).reduce<TextSegment[]>((row,char)=>{
    while(at<chars.length&&chars[at].char!==char)at++;
    const style=chars[at++]?.style??{text:''},last=row.at(-1);
    if(last&&last.fg===style.fg&&last.bold===style.bold)last.text+=char;else row.push({...style,text:char});
    return row;
   },[]));
  };
  const text=rows.flatMap(row=>row.segments?wrapStyled(row.segments).map(segments=>styledLine(segments,textWidth)):wrapTextWithAnsi(clean(row.text),Math.max(1,textWidth)).map(line=>styledLine([{text:line,fg:row.fg??'fg.body'}],textWidth)));
  if(readOnly)return text;
  const choices=IMPROVE_MODES.map((m,i)=>{const on=mode===m,off=i<2&&!candidateExecutable(c)||!!decision&&!(i===0&&decision.canExecute);return {on,segments:[{text:on?'◉':'○',fg:on?MODE_COLOR[m]:'fg.faint'},{text:` ${i+1} ${MODE_LABEL[m]}`,fg:off?'fg.faint':on?'fg.primary':'fg.label'}] as TextSegment[]};});
  if(side) {
   const options=choices.map(choice=>styledLine([{text:' '},...choice.segments],OPTION_WIDTH,choice.on?'bg.selected':undefined));
   return Array.from({length:Math.max(text.length,options.length)},(_,r)=>(text[r]??styledLine([],textWidth))+styledLine([],2)+(options[r]??styledLine([],OPTION_WIDTH)));
  }
  return [...text,...(width<60?[choices.slice(0,2),choices.slice(2)]:[choices]).map(items=>styledLine(items.flatMap((item,i)=>[...(i?[{text:'  '}]:[]),...item.segments.map(s=>item.on?{...s,bg:'bg.selected' as const}:s)]),width))];
 }
 /**
  * 底部常驻的“提交批次”框（视觉修正 r1）：计数、绑定报告与基线、顺序、总预算预估与停止规则。
  * 只是预览，提交以 Enter 进入的汇总框为准；放不下的部分截断。
  */
 private batch(width:number):string[] {
  const inner=width-4,modes=[...this.modes.values()],count=(mode:ImproveMode)=>modes.filter(m=>m===mode).length;
  const checks=this.report.candidates.filter(c=>IMPROVE_MODES.indexOf(this.modes.get(c.id)??'defer')<2).flatMap(c=>c.structuredChecks??[]);
  const requests=checks.reduce((n,ch)=>n+(ch.kind==='fresh'?ch.budget.maxRequests:0),0),tokens=checks.reduce((n,ch)=>n+(ch.kind==='fresh'?ch.budget.maxTokens:0),0);
  const counts=`提交批次 执行 ${count('execute-declared-scope')} · 仅验证 ${count('validate-only')} · 暂缓 ${count('defer')} · 不再建议 ${count('do-not-suggest')} · 未选 ${this.report.candidates.length-this.modes.size}`;
  // 短号取 7 位；完整 revision 与基线在汇总框里。
  const baselines=[...new Set(this.report.candidates.filter(c=>this.modes.has(c.id)).map(c=>c.target.baseline.slice(0,7)))];
  const binding=`绑定 ${this.index.label('improve-report',this.report.id)} · revision ${this.report.revision.slice(0,7)}${baselines.length?` · 基线 ${baselines.join('、')}`:''}`;
  const first:TextSegment[]=[{text:'提交批次',fg:'ac.improve',bold:true},{text:counts.slice(4),fg:'fg.body'}],gap=inner-visibleWidth(counts)-visibleWidth(binding);
  const second:TextSegment[]=[{text:`顺序 按依赖与候选号 · 总预算预估 ≤ ${requests} 请求 / ${formatAmount(upperBoundAmount(tokens,'deepseek','deepseek-flash')?.amount??0,'CNY').replace('≈ ','≈')} · 失败、取消或出现未知副作用时剩余项不启动`,fg:'fg.muted'}];
  return frameBox([gap>=2?[...first,{text:' '.repeat(gap)},{text:binding,fg:'fg.faint' as const}]:first,second].map(segments=>styledLine(fitSegments(segments,inner),inner)),width);
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
   const selected=new Set(d.groups.flatMap(group=>group.candidateIds)),duration=improveDecisionDuration(this.report.candidates.filter(candidate=>selected.has(candidate.id)));
   const budget=decisionBudgetAmount(d.limits.maxTokens,hostPlanPrice('deepseek','deepseek-flash')),time=new Date(this.now()+duration);
   rows.push({fixed:true,text:`总预算 ≤ ${d.limits.maxRequests} 请求 · ${formatAmount(budget.amount!,'CNY').replace('≈ ','≈')}（在途请求按高峰价）· 检查 ${d.limits.maxChecks} 项 · 提交后开始计时，预计最晚 ${time.toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'})} 结束`},{fixed:true,text:`价目 ${budget.version} · 临时目录 ${d.directory}`,fg:'fg.muted'});
  }else if(![...this.modes.values()].some(m=>IMPROVE_MODES.indexOf(m)<2))rows.push({fixed:true,text:'本次只记录决定，不执行任何候选'});
  rows.push({fixed:true,text:`绑定 ${this.index.label('improve-report',this.report.id)} · 报告 revision ${this.report.revision}`,fg:'fg.label'});
  for(const c of this.report.candidates.filter(c=>this.modes.has(c.id)))rows.push({fixed:true,text:`${this.index.candidate(c)} · ${MODE_LABEL[this.modes.get(c.id)!]} · 基线 ${c.target.baseline.slice(0,12)} · ${c.target.workspace??'未核对目标'}`});
  if(this.problems.length)rows.push({text:'不能提交 · Enter 不可用',fg:'ac.err'},...this.problems.map(text=>({text,fg:'ac.warn' as const})));
  rows.push({fixed:true,text:'失败、取消或出现未知副作用时，剩余项不启动',fg:'ac.warn'},{fixed:true,text:'选择不包含提交、推送、发布或清理数据'},{fixed:true,text:'在会话里输入的文字不算选择'});
  return rows;
 }
 private dialog(width:number,height:number,rows:{text:string;fg?:TokenName;fixed?:boolean}[],summary:boolean,selectedStart=0) {
  const bodyRows=(inner:number)=>[...wrapAuthorized(rows[0].text,inner).slice(1).map(text=>({text,fg:rows[0].fg})),...rows.slice(1).filter(row=>!row.fixed)].flatMap(row=>wrapAuthorized(row.text,inner).map(text=>({segments:[{text,fg:row.fg??'fg.body'}],cursor:!summary&&text.startsWith('▸ ')})));
  const config={title:rows[0].text,action:summary?'提交':'检查原文',bodyRows,fixed:rows.filter(row=>row.fixed).map(row=>row.text),disabled:summary&&this.problems.length?'不可用 · ↑↓ 查看原因':undefined,
   footer:(reason:string|undefined)=>[{text:reason?`Enter ${reason} · Esc 返回调整`:this.feedback||(summary?'↑↓ 核对 · Enter 提交 · Esc 返回调整':`↑↓ 选组 · Enter 检查原文${this.busy?' · Ctrl+C 停止':''} · Esc 返回选择`),fg:'fg.label' as const}]};
  if(!this.confirmation||this.confirmationSummary!==summary){this.confirmation=new ConfirmDialog(config);this.confirmationSummary=summary;}
  else this.confirmation.update(config);
  if(this.reveal){this.confirmation.revealCursor();this.reveal=false;}
  const lines=this.confirmation.render(width,height),padding=' '.repeat(Math.max(0,Math.floor((width-ConfirmDialog.width(width))/2)));
  this.tooSmall=this.confirmation.disabledReason===TOO_SMALL_TO_CONFIRM;this.shown=summary&&!this.tooSmall;
  return lines.map(line=>padding+line);
 }
 render(width:number,height:number):string[] {
  if(this.stage==='original')return this.raw!.render(width,height);
  if(this.stage==='summary')return this.dialog(width,height,this.summaryRows(),true);
  const wrap=(text:string,fg:TokenName='fg.body')=>wrapTextWithAnsi(clean(text),Math.max(1,width)).map(text=>styledLine([{text,fg}],width));
  const hints=['1–4 选择 / 取消','Tab 切换候选','↑↓ 滚动',this.busy?'Enter 查看进度':'Enter 汇总'];
  let lines:string[]=[],header:string[]=[],footer=[hintLine(hints,width,{esc:'Esc 返回第一层',feedback:this.feedback||undefined})],selectedStart=0;
  if(this.stage==='select') {
   // 报告头（U4，视觉修正 r1）：报告号、取证截止、范围，右侧候选数与分析费用；宽度小于 100 时右侧移到第二行，左侧放不下时截断。
   const compact=height<20,session=this.report.target.sessionId?this.index.label('session',this.report.target.sessionId):'会话未记录',window=this.report.request.window;
   const head:TextSegment[]=[{text:'◆ ',fg:'ac.improve'},{text:'improve',fg:'fg.primary',bold:true},{text:` 报告 ${this.index.label('improve-report',this.report.id)} · 取证截止 ${reportTime(this.report.startedAt)} · 范围 会话 ${session}${window?` + 近 ${window} 天同类`:''}`,fg:'fg.label'}];
   const right=`${this.report.candidates.length} 个候选 · 分析 ${this.analysisCost}`,used=visibleWidth(head.map(s=>s.text).join(''));
   lines.push(...(width>=100&&used+2+visibleWidth(right)<=width?[styledLine([...head,{text:' '.repeat(width-used-visibleWidth(right))},{text:right,fg:'fg.label'}],width)]:[styledLine(fitSegments(head,width),width),...wrap(right,'fg.label')]));
   if(this.report.state==='incomplete')lines.push(...wrap(`报告不完整 · ${this.report.reason??'原因未知'}`,'ac.warn'));
   if(this.drift)lines.push(...wrap('旧选择失效；请重新分析','ac.warn'));
   // 头部下方与卡片之间的分隔线和空行（U10）；矮窗口只显示当前卡片，不画它们。
   header=compact?lines:[...lines,rule(width),styledLine([],width)];lines=[];
   this.report.candidates.forEach((c,i)=>{
    if(compact&&i!==this.selected)return;
    if(!compact&&i)lines.push(styledLine([],width),rule(width),styledLine([],width));
    if(i===this.selected)selectedStart=lines.length;
    lines.push(...this.card(c,i===this.selected,width));
   });
   if(!this.report.candidates.length)lines.push(...wrap('没有候选；没有可提交的选择','fg.muted'));
   if(compact&&this.report.candidates.length>1)lines.push(...wrap(`其他 ${this.report.candidates.length-1} 项 · Tab 切换`,'fg.label'));
   const hidden=(this.report.suppressed??[]).filter(s=>s.matches.some(m=>m.mode==='do-not-suggest')).length,deferred=(this.report.suppressed??[]).length-hidden;
   if(hidden)lines.push(...wrap(`另有 ${hidden} 项已按“不再建议”隐藏`,'fg.muted'));
   if(deferred)lines.push(...wrap(`另有 ${deferred} 项因暂缓未重提`,'fg.muted'));
   // 底部常驻提交批次框与底栏（左侧说明、右侧键位）；矮于 24 行时只留键位提示。
   if(height>=24)footer=[...this.batch(width),...footerLines([{text:'选择不包含提交、推送、发布或清理数据',fg:'fg.label'}],hints,width,{esc:'Esc 返回第一层',feedback:this.feedback||undefined})];
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
  const count=Math.max(1,height-header.length-footer.length);
  if(this.reveal&&(this.stage==='select'||this.stage==='result')){this.line=selectedStart;this.reveal=false;}
  this.line=Math.min(this.line,Math.max(0,lines.length-count));
  const body=lines.slice(this.line,this.line+count);
  return [...header,...body,...(this.stage==='select'?Array.from({length:count-body.length},()=>styledLine([],width)):[]),...footer];
 }
}
export {ImproveView} from './improve.js';
