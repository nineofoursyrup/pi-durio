/** Read-only report projection. It never opens any recorded target workspace. */
import {readReportRecord} from './improve-entry.js';
import {improveReportContract} from './improve-contract.js';
import {improveFacts,readImproveDecision,listImproveSuppressions,type ImproveFact} from './improve-history.js';
import {currentImproveVersion} from './improve-decisions.js';
import type {ImproveCandidate,ImproveReport} from './improve.js';
import {readDisplayIndex} from './display-number.js';
import {readSessionChains} from './session-chain.js';
import {estimateRunRequests,formatCostTotals} from './cost-estimate.js';

export type HistoryDecision=ReturnType<typeof readImproveDecision>;
export interface ImproveHistoryAction {
 kind:'continue'|'rollback';reportId:string;decisionId:string;decisionSource:string;groupIds:string[];candidateIds:string[];label:string;disabled?:string;
}
export function historyCandidateLabel(root:string,report:ImproveReport,c:ImproveCandidate) {
 const position=[...report.candidates,...(report.suppressed??[]).map(s=>s.candidate)].findIndex(item=>item.id===c.id);
 return improveReportContract(report)==='legacy'?`C-${String(position+1).padStart(2,'0')}@r1`:readDisplayIndex(root).candidate(c);
}
export function historyResult(state:HistoryDecision,groupId?:string) {
 const g=state.groups.find((g:any)=>g.id===groupId),status=g?.state??state.state;
 const label:Record<string,string>={completed:'已完成',failed:'失败',cancelled:'已取消','not-run':'未运行',frozen:'已冻结',unknown:'未知','completed-with-failures':'已结束 · 有失败'};
 const parts=[label[status]??status];
 if(g?.result?.checks)parts.push(`检查 ${g.result.checks.filter((c:any)=>c.state==='completed').length}/${g.result.checks.length} 通过`);
 if(g?.rollback?.state==='completed')parts.push('写回已回退');
 else if(g?.formal?.writeback==='written')parts.push('已写回');
 else if(g?.formal&&['unknown','frozen'].includes(g.formal.state))parts.push('写回状态未知');
 if(g?.result?.effect)parts.push(`效果：${g.result.effect}`);
 return parts.join(' · ');
}
export function continuationBlocked(state:HistoryDecision,contract:ReturnType<typeof improveReportContract>,version:string|null) {
 if(contract==='legacy')return '首版冻结批次不能继续 · 请重新分析';
 if(contract==='unknown')return '报告格式未确认 · 请重新分析';
 if(version===null)return '当前执行版本无法核对';
 if(state.executionVersion!==version)return '执行版本已变';
 if(state.state!=='frozen')return '批次没有冻结的未运行项';
 if(state.groups.some((g:any)=>g.state==='unknown'||['unknown','frozen'].includes(g.formal?.state)))return '已有操作结果未知 · 需恢复核对';
 if(!state.groups.some((g:any)=>g.state==='not-run'))return '没有未运行的独立项';
 if(Date.parse(state.decision.limits.deadline)<=Date.now())return '原授权截止时间已过 · 请重新分析';
 return undefined;
}
export function readImproveHistory(root:string,id:string,facts:ImproveFact[]=improveFacts(root)) {
 const report=readReportRecord(root,id);if(!report)throw Error('IMPROVE_REPORT_NOT_FOUND');
 const contract=improveReportContract(report),decisions=facts.filter(f=>f.kind==='improve.decision'&&f.data.decision.reportId===id)
  .map(fact=>({fact,state:readImproveDecision(root,fact.data.id)}));
 const candidates=report.candidates.map(candidate=>{
  const history=decisions.flatMap(({fact,state})=>{
   const selection=(state.decision.selections??fact.data.decisions??[]).find((s:any)=>s.candidateId===candidate.id);
   if(!selection)return [];
   const group=state.groups.find((g:any)=>g.candidateIds.includes(candidate.id));
   return [{at:fact.at,mode:selection.mode as string,decisionId:state.id,groupId:group?.id as string|undefined,result:historyResult(state,group?.id),state}];
  });
  return {candidate,label:historyCandidateLabel(root,report,candidate),history,latest:history.at(-1)};
 });
 const counts={'execute-declared-scope':0,'validate-only':0,defer:0,'do-not-suggest':0};
 for(const c of candidates)if(c.latest&&c.latest.mode in counts)counts[c.latest.mode as keyof typeof counts]++;
 let version:string|null=null;
 if(decisions.some(d=>d.state.groups.some((g:any)=>g.state==='not-run'))&&contract==='declared')try{version=currentImproveVersion(root,report.target.workspace);}catch{/* Explicit unavailable reason. */}
 const actions:ImproveHistoryAction[]=[];
 for(const {state}of decisions) {
  const groups=state.groups.filter((g:any)=>g.state==='not-run');
  if(groups.length)actions.push({kind:'continue',reportId:id,decisionId:state.id,decisionSource:state.sourceId,groupIds:groups.map((g:any)=>g.id),candidateIds:groups.flatMap((g:any)=>g.candidateIds),label:'继续未运行的独立项',disabled:continuationBlocked(state,contract,version)});
  for(const group of state.groups) {
   // Keep every effective writeback, including an earlier decision. Merely
   // validating or planning formal work never grants an undo operation.
   if(group.rollback?.state==='completed'||!(group.formal?.writeback==='written'||group.writes.some((w:any)=>w.state==='written')))continue;
   const c=report.candidates.find(c=>group.candidateIds.includes(c.id));if(!c)continue;
   actions.push({kind:'rollback',reportId:id,decisionId:state.id,decisionSource:state.sourceId,groupIds:[group.id],candidateIds:group.candidateIds,label:`回退 ${historyCandidateLabel(root,report,c)} 所在组合的写回`});
  }
 }
 const cost=formatCostTotals(estimateRunRequests(root,report.runId).totals);
 const sessionId=readSessionChains(root).sessionOfRun(report.target.runId)?.id??null;
 return {report,contract,candidates,counts,decisions,actions,cost,sessionId};
}
export function readSuppressionHistory(root:string,workspace?:string) {
 return listImproveSuppressions(root,workspace).filter(item=>item.active).map(item=>{
  const report=readReportRecord(root,item.reportId),candidate=report?.candidates.find(c=>c.id===item.candidateId)??report?.suppressed?.find(s=>s.candidate.id===item.candidateId)?.candidate;
  const label=`${readDisplayIndex(root).label('improve-report',item.reportId)}·${candidate&&report?historyCandidateLabel(root,report,candidate):'候选未记录'}`;
  return {...item,label,title:candidate?.title??'标题未记录',candidate};
 });
}
