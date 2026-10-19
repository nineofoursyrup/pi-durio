/** Shared read-only candidate presentation for 1d and improve history (#91).
 * It reads retained report bytes only; it has no action or runtime capability. */
import {wrapTextWithAnsi,visibleWidth} from '@earendil-works/pi-tui';
import type {ImproveCandidate,ImproveReport} from '../improve.js';
import type {ImproveMode} from '../improve-decisions.js';
import {readObject} from '../evidence.js';
import {applyReplacement,ReplacementMismatchError,REPLACEMENT_MISMATCH_REASON} from '../improve-replacements.js';
import {readDisplayIndex} from '../display-number.js';
import {candidateExecutable,improveReportContract} from '../improve-contract.js';
import {upperBoundAmount,formatAmount} from '../cost-estimate.js';
import {clean} from './view-stack.js';
import {styledLine,type TokenName,type ColorTier,COLOR_TIER} from './theme.js';

export const IMPROVE_MODES:readonly ImproveMode[]=['execute-declared-scope','validate-only','defer','do-not-suggest'];
export const MODE_LABEL:Record<ImproveMode,string>={'execute-declared-scope':'执行声明范围','validate-only':'仅验证',defer:'暂缓','do-not-suggest':'不再建议'};
const targetKind:Record<string,string>={'agent-config':'配置','prompt-skill':'prompt·skill','self-source':'自身源码','eval-asset':'eval 资产'};
export interface CandidateDecisionLabel {mode:string;state:string;canExecute?:boolean;extraDecisions?:number}
export interface CandidateCardOptions {expanded:boolean;selected?:boolean;mode?:ImproveMode;decision?:CandidateDecisionLabel;readOnly?:boolean;label?:string;tier?:ColorTier}
export interface CandidateCardRow {text:string;fg?:TokenName}
export function suggestionReason(c:ImproveCandidate) {
 if(c.suggestionReason)return c.suggestionReason;
 if(c.target.state!=='verified')return c.target.gaps.join('；')||'目标未经核对';
 if(!c.replacements?.length)return '缺少声明范围的替换内容';
 if(!c.structuredChecks?.length)return '缺少结构化检查与数值预算';
 return c.gaps.join('；')||'分析将此项标为仅建议';
}
export function candidateValidation(c:ImproveCandidate) {
 if(!candidateExecutable(c))return `不能执行：${suggestionReason(c)}`;
 const checks=c.structuredChecks!,requests=checks.reduce((n,ch)=>n+(ch.kind==='fresh'?ch.budget.maxRequests:0),0),tokens=checks.reduce((n,ch)=>n+(ch.kind==='fresh'?ch.budget.maxTokens:0),0);
 const methods=[...new Set(checks.map(ch=>({direct:'直接检查',regression:'真实回归',resource:'基准',fresh:'fresh 对照'})[ch.kind]))].join(' + ');
 const count=checks.reduce((n,ch)=>n+(ch.kind==='fresh'?ch.assets.reduce((m,a)=>m+a.caseIds.length,0)*ch.comparison.repetitions*2:1),0)+(c.buildTimeoutMs?1:0);
 const benefits=c.objective==='performance'?checks.flatMap(ch=>ch.kind==='resource'?[`δ ≥ ${ch.resource!.delta} ${ch.resource!.unit}（${ch.resource!.basis}）`]:ch.kind==='fresh'?[`δ ≥ ${ch.comparison.objective.delta===null?'未固定':ch.comparison.objective.metric==='task-pass'?ch.comparison.objective.delta:`${ch.comparison.objective.delta*100}%`}（${ch.comparison.objective.metric}；相对 baseline，baseline 为 0 不可比）`]:[]):[];
 return `${methods} · ${count} 次${benefits.length?' · '+benefits.join('；'):''} · ≤ ${requests} 请求 / ${formatAmount(upperBoundAmount(tokens,'deepseek','deepseek-flash')?.amount??0,'CNY').replace('≈ ','≈')}`;
}
/** Line diff with retained context; all replacement bytes are visible. Long
 * command/diff continuations wrap without manufactured line numbers. */
function replacementDiff(root:string,c:ImproveCandidate) {
 return (c.replacements??[]).flatMap(r=>{
  if(c.suggestionReason)return [{text:`diff ${r.path} · ${c.suggestionReason}`,fg:'ac.warn' as const},{text:r.content,fg:'ac.code' as const}];
  const file=c.target.files.find(f=>f.path===r.path);
  let before:string,after:string;try{if(!file)throw Error('missing');before=readObject(root,file.content).toString('utf8');after=applyReplacement(before,r);}catch(error){
   const reason=error instanceof ReplacementMismatchError?REPLACEMENT_MISMATCH_REASON:'原文不可读取，不能证明替换内容';
   return [{text:`diff ${r.path} · ${reason}`,fg:'ac.warn' as const},{text:r.content,fg:'ac.code' as const}];
  }
  const a=before.split('\n'),b=after.split('\n');let start=0,end=0;
  while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  if(start===a.length&&start===b.length)return [{text:`diff ${r.path} · 内容未变`,fg:'fg.muted' as const}];
  const contextStart=Math.max(0,start-3),contextEnd=Math.min(end,3);
  return [{text:`--- ${r.path}（基线 ${file!.sha256.slice(0,12)}）`,fg:'ac.path' as const},{text:`+++ ${r.path}（候选）`,fg:'ac.path' as const},
   ...a.slice(contextStart,start).map(line=>({text:` ${line}`})),...a.slice(start,a.length-end).map(line=>({text:`-${line}`,fg:'ac.err' as const})),...b.slice(start,b.length-end).map(line=>({text:`+${line}`,fg:'ac.ok' as const})),...a.slice(a.length-end,a.length-end+contextEnd).map(line=>({text:` ${line}`}))];
 });
}

export function improveCandidateRows(root:string,report:ImproveReport,c:ImproveCandidate,options:CandidateCardOptions):CandidateCardRow[] {
 const index=readDisplayIndex(root),kind=targetKind[c.target.kind],decision=options.decision,legacy=improveReportContract(report)==='legacy';
 const label=(candidate:ImproveCandidate)=>legacy?`C-${String([...report.candidates,...(report.suppressed??[]).map(s=>s.candidate)].findIndex(item=>item.id===candidate.id)+1).padStart(2,'0')}@r1`:index.candidate(candidate),name=options.label??label(c);
 const chosen=options.mode?` · ${MODE_LABEL[options.mode]}`:decision?` · 已决定：${MODE_LABEL[decision.mode as ImproveMode]??decision.mode} · ${decision.state}${decision.canExecute&&!options.readOnly?' · 验证已通过，可再选执行（重新验证，预算另算）':''}`:options.readOnly?` · 未决${legacy?' · 首版报告不能选择':''}`:'';
 const head=`${options.selected?'▸':' '} ${name} ${c.title}${kind?' · '+kind:''}${!legacy&&!candidateExecutable(c)?' · 仅建议':''}${decision?.extraDecisions?` · 首版另有 ${decision.extraDecisions} 次决定`:''}${chosen}`;
 if(!options.expanded)return [{text:head,fg:'fg.muted'}];
 const references=new Set(c.facts.flatMap(f=>f.evidence)),counter=c.successCounterexamples.length?`反例 ${c.successCounterexamples.length} 条`:`无反例：${c.gaps[0]??'未说明缺口'}`;
 const links=(ids:string[])=>ids.map(id=>{const other=report.candidates.find(c=>c.id===id);return other?label(other):id;}).join('、');
 const rows:CandidateCardRow[]=[{text:head,fg:'ac.improve'},{text:`证据  ${c.facts[0]?.claim??'没有事实陈述'} · 共 ${c.facts.length} 条 · 引用 ${references.size} 段原文 · ${counter}${c.hypotheses.length?' · 原因假设未证实':''}${c.gaps.length?` · 缺口 ${c.gaps.length} 项`:''}`},
  {text:`动作  ${c.steps[0]??'未声明'} · 范围 ${c.scope[0]??'未声明'}${c.scope.length>1?` 等 ${c.scope.length} 个路径`:''}`},
  {text:`验证  ${legacy?`${c.validation.method} · ${c.validation.checks.join('；')} · ${c.validation.budget}`:candidateValidation(c)}`,fg:candidateExecutable(c)?'fg.body':'fg.muted'},
  {text:`回退  ${c.rollback} · ${c.activation.timing}`},
  ...(c.dependencies.length||c.conflicts.length?[{text:`依赖 / 冲突  ${c.dependencies.length?'依赖 '+links(c.dependencies):''}${c.dependencies.length&&c.conflicts.length?'；':''}${c.conflicts.length?'冲突 '+links(c.conflicts):''}`}]:[]),
  ...(c.reconsideration?[{text:`重提：${c.reconsideration.reason} · ${c.reconsideration.evidence.join('、')}`}]:[]),
  {text:'事实是分析给出的陈述；宿主只核对了引用的原文确实读过。',fg:'fg.muted'},
  ...c.facts.flatMap((f,i)=>[{text:`事实 ${i+1}  ${f.claim}`},...f.evidence.map(ref=>({text:`引用  ${ref}`,fg:'ac.path' as const}))]),
  ...c.successCounterexamples.flatMap((f,i)=>[{text:`反例 ${i+1}  ${f.claim}`},...f.evidence.map(ref=>({text:`引用  ${ref}`,fg:'ac.path' as const}))]),
  ...c.hypotheses.map(h=>({text:`原因假设（未证实）  ${h}`})),...c.gaps.map(g=>({text:`缺口  ${g}`,fg:'fg.muted' as const})),
  ...c.steps.map((s,i)=>({text:`声明步骤 ${i+1}  ${s}`})),...c.scope.map(path=>({text:`完整范围  ${c.target.workspace??'未经核对'}/${path}`,fg:'ac.path' as const})),
  ...replacementDiff(root,c),
  ...(c.structuredChecks??[]).flatMap((ch,i):CandidateCardRow[]=>ch.kind==='fresh'?[{text:`检查 ${i+1}  fresh ${ch.mode} · ${ch.comparison.repetitions} 次配对重复 · ≤ ${ch.budget.maxRequests} 请求 / ${ch.budget.maxTokens} tok / ${ch.budget.maxDurationMs} ms`},{text:JSON.stringify(ch,null,2),fg:'ac.code'}]:[{text:`检查 ${i+1}  ${ch.kind} · ≤ ${ch.timeoutMs} ms`},{text:ch.program,fg:'ac.code'},...(ch.kind==='resource'?[{text:`收益门槛  ${JSON.stringify(ch.resource)} · ${ch.benefit??'required'}`}]:[])]),
  ...(c.validationBasis?[{text:`验证依据  ${JSON.stringify(c.validationBasis)}`}]:[]),...(c.buildTimeoutMs?[{text:`构建与启动检查  ≤ ${c.buildTimeoutMs} ms`}]:[]),
  ...c.validation.protections.map(p=>({text:`必要保护  ${p}`})),...c.risks.map(r=>({text:`风险  ${r}`})),{text:`回退方法  ${c.rollback}`},
  {text:`生效条件  ${c.activation.conditions.join('；')}`},{text:`生效时机  ${c.activation.timing}${c.activation.taskTypes?.length?' · '+c.activation.taskTypes.join('、')+' 后续新任务':''}`}];
 return rows;
}

/** Full wrapped read-only card, suitable for embedding in history. Callers own
 * scrolling; this renderer never truncates an expanded card or authorization. */
export function improveCandidateCard(root:string,report:ImproveReport,candidate:ImproveCandidate,width:number,options:CandidateCardOptions):string[] {
 const rows=improveCandidateRows(root,report,candidate,options),tier=options.tier??COLOR_TIER;
 const lines=rows.flatMap(row=>wrapTextWithAnsi(clean(row.text),Math.max(1,width)).map(text=>styledLine([{text,fg:row.fg??'fg.body'}],width,options.selected?'bg.block':undefined,tier)));
 if(!options.expanded||options.readOnly)return lines;
 const choices=IMPROVE_MODES.map((mode,i)=>({text:`${options.mode===mode?'[✓]':'[ ]'} ${i+1} ${MODE_LABEL[mode]}`,fg:((i<2&&!candidateExecutable(candidate)||options.decision&&!(i===0&&options.decision.canExecute))?'fg.faint':'fg.label') as TokenName}));
 const optionRows=width<60?[choices.slice(0,2),choices.slice(2)]:[choices];
 const optionsLines=optionRows.flatMap(items=>{
  const text=items.map(item=>item.text).join('  ');
  if(visibleWidth(text)<=width)return [styledLine(items.flatMap((item,i)=>i?[{text:'  '},item]:[item]),width,undefined,tier)];
  return items.flatMap(item=>wrapTextWithAnsi(item.text,width).map(text=>styledLine([{...item,text}],width,undefined,tier)));
 });
 // The options sit beside the card when there is room; narrower cards put them
 // below the content. The complete current title is wrapped separately.
 if(width>=100&&optionsLines.length===1) {
  const optionWidth=visibleWidth(choices.map(item=>item.text).join('  ')),head=rows[0].text,left=width-optionWidth-2;
  const title=wrapTextWithAnsi(clean(head),Math.max(1,left));
  const first=styledLine([{text:title[0],fg:'ac.improve'},{text:' '.repeat(Math.max(2,width-visibleWidth(title[0])-optionWidth))},...choices.flatMap((item,i)=>i?[{text:'  '},item]:[item])],width,'bg.block',tier);
  const oldHead=wrapTextWithAnsi(clean(head),width).length;
  return [first,...title.slice(1).map(text=>styledLine([{text,fg:'ac.improve'}],width,'bg.block',tier)),...lines.slice(oldHead)];
 }
 return [...lines,...optionsLines];
}
