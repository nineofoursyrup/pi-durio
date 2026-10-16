import {matchesKey,wrapTextWithAnsi} from '@earendil-works/pi-tui';
import {readObject} from '../evidence.js';
import {improveFacts,type ImproveFact} from '../improve-history.js';
import {listPlanSources,readPlanReport,type PlanSource} from '../eval/overview.js';
import {readDisplayIndex} from '../display-number.js';
import {formatAmount} from '../cost-estimate.js';
import type {ImproveDecisionState} from '../improve-batch.js';
import type {ImproveDecision} from '../improve-decisions.js';
import type {ImproveReport} from '../improve.js';
import {clean,hintLine} from './view-stack.js';
import {styledLine} from './theme.js';
import {MODE_LABEL} from './improve-card.js';

export const elapsed=(ms:number)=>`${Math.floor(Math.max(0,ms)/60000).toString().padStart(2,'0')}:${Math.floor(Math.max(0,ms)/1000)%60<10?'0':''}${Math.floor(Math.max(0,ms)/1000)%60}`;
const checkState=(state:string)=>({completed:'通过',failed:'失败',cancelled:'已取消','not-run':'未运行',unknown:'未知'}[state]??state);
export function improveResultGroups(root:string,report:ImproveReport,decision:ImproveDecision,state:ImproveDecisionState|undefined,busy:boolean) {
 const index=readDisplayIndex(root);
 return decision.groups.map(group=>{
  const result=state?.groups.find((g:any)=>g.id===group.id),running=busy&&result?.state==='unknown'&&!result.result;
  const name=group.candidateIds.map(id=>index.candidate(report.candidates.find(c=>c.id===id)!)).join(' + '),mode=decision.selections.find(s=>group.candidateIds.includes(s.candidateId))!.mode;
  const status=running?'运行中':!result||result.state==='not-run'?busy?'待运行':'未运行':checkState(result.state);
  const checks=result?.result?.checks??[],passed=checks.filter((c:any)=>c.state==='completed').length;
  const formal=result?.formal,write=formal?.writeback==='written'?`已写回 ${[...new Set((formal.files??[]).map((f:any)=>`${f.root}/${f.path}`))].join('、')}`:formal?.writeback?.includes('unknown')?'写回状态未知 · 需要恢复核对':mode==='validate-only'?'正式目标未写回':'尚未写回';
  const activation=formal?.activation==='new-default'?'下个任务生效':formal?.activation==='new-process-entry'?'后续显式启动的新进程生效':formal?.state==='completed'?group.candidateIds.map(id=>report.candidates.find(c=>c.id===id)!.activation.timing).join('；'):'';
  const stopped=!busy&&(!result||result.state==='not-run')?'前项停止或失败，剩余项不启动':'';
  const effect=group.candidateIds.some(id=>report.candidates.find(c=>c.id===id)!.objective==='performance')?`效果：${result?.result?.effect??'证据不足'}`:'';
  return {id:group.id,text:[`${running?'⠹':status==='通过'?'✓':status==='失败'?'✗':'·'} ${name}${group.candidateIds.length>1?' 组合':''} ${mode==='execute-declared-scope'?'执行':MODE_LABEL[mode]} · ${status}`,checks.length?`检查 ${passed}/${checks.length} 通过`:'',write,activation,stopped,effect,result?.reason??'',formal?.reason??''].filter(Boolean).join(' · ')};
 });
}
export function improveActualCost(root:string,decisionId:string) {
 const sources=listPlanSources(root).filter(s=>s.origin?.decisionId===decisionId),amounts=new Map<string,number>();let unknown=0;
 for(const source of sources)try{const c=readPlanReport(source).report.cost;if(c.currency&&c.knownValue!==null)amounts.set(c.currency,(amounts.get(c.currency)??0)+c.knownValue);unknown+=c.missing+(c.priceMissing?1:0);}catch{unknown++;}
 if(!sources.length)return '≈¥0.00';
 return [...amounts].map(([currency,n])=>formatAmount(n,currency).replace('≈ ','≈')).join(' + ')+(unknown?` + ${unknown} 项费用未知`:'');
}

/** Check originals remain a read-only child of the result. A fresh check routes
 * using both its child root and plan identity, never the display number alone. */
export class ImproveCheckOriginal {
 private line=0;private selected=0;
 private facts:ImproveFact[];
 constructor(private root:string,private decision:ImproveDecision,private groupId:string,private openEval:(source:PlanSource)=>void) {
  this.facts=improveFacts(root).filter(f=>f.data.id===decision.id&&f.data.groupId===groupId);
 }
 private get checks(){return this.decision.groups.find(g=>g.id===this.groupId)!.checks;}
 private source(index:number) {
  const link=this.facts.find(f=>f.kind==='improve.eval'&&f.data.index===index);
  return link&&listPlanSources(this.root).find(s=>s.id===link.data.planId&&s.root===link.data.dataRoot&&s.origin?.decisionId===this.decision.id&&s.origin.reportId===this.decision.reportId&&s.origin.groupId===this.groupId);
 }
 openSingleFresh(){if(this.checks.length===1&&this.checks[0].kind==='fresh'){const source=this.source(0);if(source){this.openEval(source);return true;}}return false;}
 handleInput(data:string) {
  if(matchesKey(data,'tab')||matchesKey(data,'shift+tab')){this.selected=(this.selected+(matchesKey(data,'shift+tab')?-1:1)+this.checks.length)%Math.max(1,this.checks.length);this.line=0;}
  if(matchesKey(data,'up'))this.scroll(-1);if(matchesKey(data,'down'))this.scroll(1);
  if(matchesKey(data,'pageUp'))this.scroll(-8);if(matchesKey(data,'pageDown'))this.scroll(8);
  if(matchesKey(data,'enter')&&this.checks[this.selected]?.kind==='fresh'){const source=this.source(this.selected);if(source)this.openEval(source);}
 }
 scroll(delta:number){this.line=Math.max(0,this.line+delta);}
 private text() {
  const check=this.checks[this.selected],fact=this.facts.findLast(f=>f.kind==='improve.check'&&f.data.index===this.selected),result=fact?.data;
  if(!check)return ['没有检查原文 · 本次只记录决定'];
  const header=[`◆ improve 检查原文 · ${this.selected+1}/${this.checks.length} · ${check.kind} · 只读`,`状态 ${result?checkState(result.state):'没有已保存结果'}`];
  if(check.kind==='fresh'){const source=this.source(this.selected);return [...header,source?`${source.label} · ${source.origin?.label} · Enter 打开 2b`:'尚无 fresh 计划或计划引用不可取得',JSON.stringify(check,null,2)];}
  const lines=[...header,`检查程序（全文） · ≤ ${check.timeoutMs} ms`,check.program];
  if(!result)return [...lines,'检查尚未产生原文；不把缺失视为通过'];
  try {
   const execution=result.executionRef?JSON.parse(readObject(this.root,result.executionRef).toString()):result.execution;
   if(!execution)return [...lines,`没有取得执行原文 · ${result.reason??'原因未知'}`];
   for(const stream of ['stdout','stderr']) {
    const acquired=execution.output?.[stream];
    if(acquired?.chunks)lines.push(`${stream} · 已取得 ${acquired.bytes} bytes`,Buffer.concat(acquired.chunks.map((ref:any)=>readObject(this.root,ref))).toString('utf8'));
    else lines.push(`${stream} · 没有保留完整字节块（仅已有文本）`,execution[stream]??'');
   }
   lines.push(`执行事实 ${JSON.stringify({status:execution.status,code:execution.code,terminated:execution.terminated,reason:execution.reason,sourceEnd:execution.sourceEnd})}`);
  }catch(error){lines.push(`原文不可读取 · ${String(error)}`);}
  return lines;
 }
 render(width:number,height:number) {
  const lines=this.text().flatMap(text=>wrapTextWithAnsi(clean(text),width)),count=Math.max(1,height-1);
  this.line=Math.min(this.line,Math.max(0,lines.length-count));
  return [...lines.slice(this.line,this.line+count).map(text=>styledLine([{text,fg:'fg.body'}],width)),hintLine(['↑↓ 滚动','Tab 切换检查','Enter fresh 对照'],width,{esc:'Esc 返回结果'})];
 }
}
