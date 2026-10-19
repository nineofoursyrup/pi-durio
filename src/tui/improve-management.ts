import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {isAbsolute,relative,resolve} from 'node:path';
import {matchesKey} from '@earendil-works/pi-tui';
import {acquireOwner} from '../ownership.js';
import {decisionDigest,previewImproveResume,restoreImproveSuggestion,type ImproveResume} from '../improve-decisions.js';
import {previewImproveRollback,rollbackImproveDecision} from '../improve-rollback.js';
import {listRegisteredSources,unregisterImproveSource,type SourceRegistration} from '../improve-source.js';
import {previewRegisterFromInput,registerFromInput,expandPath} from '../improve-entry.js';
import {readImproveHistory,readSuppressionHistory,historyCandidateLabel,type ImproveHistoryAction} from '../improve-report-history.js';
import {decisionBudgetAmount} from '../improve-history.js';
import {CommandError,resolveArgument} from './commands.js';
import {ConfirmDialog,SingleLineInput,clean,type ConfirmConfig,type ConfirmResult} from './view-stack.js';
import {mayWrite,type WriteAccess} from './write-access.js';

export const ROLLBACK_REASONS=[['effect','效果不如预期'],['regression','引入了新问题'],['unneeded','不再需要']] as const;
export const RESTORE_REASONS=[['changed','条件已变化'],['mistaken','当时判断有误'],['reassess','想重新评估']] as const;
type Dialog={render(columns:number,rows:number):string[];handleInput(data:string):ConfirmResult};
export interface ImproveManagementHost extends WriteAccess {
 blocked():string|undefined;
 confirm(box:Dialog,run:()=>void):void;
 run(label:string,reportId:string|undefined,work:(signal:AbortSignal)=>Promise<unknown>):Promise<void>;
 resume(input:ImproveResume,signal:AbortSignal):Promise<unknown>;
 changed():void;
}
export type ReasonPrefill={reason?:string;note?:string};

/** Preset reason plus optional note; the underlying U12 dialog retains wrapping,
 * fixed impact/fee rows and the small-window confirmation guard. */
export class ImproveReasonDialog {
 private config:ConfirmConfig;private dialog:ConfirmDialog;private editing=false;
 private input:SingleLineInput;
 get note(){return this.input.getValue();}
 constructor(config:ConfirmConfig,private reasons:readonly (readonly [string,string])[],prefill:ReasonPrefill={}) {
  this.input=new SingleLineInput(prefill.note??'',1000);
  const at=Math.max(0,reasons.findIndex(([key])=>key===prefill.reason));
  this.config={...config,wrapBody:true,fixedRows:width=>this.editing?[this.input.render(width)[0]]:[],choice:{mode:'single',options:reasons.map(([,label])=>({label})),selected:[at]}};
  this.dialog=new ConfirmDialog(this.config);
 }
 get reason(){return `${this.reasons[this.dialog.selected[0]??0][1]}${this.note.trim()?' · '+this.note.trim():''}`;}
 handleInput(data:string):ConfirmResult {
  if(matchesKey(data,'tab')||matchesKey(data,'shift+tab')){this.editing=!this.editing;return {type:'handled'};}
  if(this.editing&&!matchesKey(data,'enter')&&!matchesKey(data,'escape')) {
   this.input.handleInput(data);
   return {type:'handled'};
  }
  return this.dialog.handleInput(data);
 }
 render(columns:number,rows:number) {
  const previous=this.config.fixed;
  this.config.fixed=[...(previous??[]),`补充说明（选填${this.editing?'，正在输入':''}） · Tab ${this.editing?'返回原因':'编辑说明'}`,...(!this.editing?[this.note||'未填']:[])];
  const lines=this.dialog.render(columns,rows);this.config.fixed=previous;return lines;
 }
}
const sameAction=(a:ImproveHistoryAction,b:ImproveHistoryAction)=>a.kind===b.kind&&a.decisionId===b.decisionId&&a.decisionSource===b.decisionSource&&decisionDigest(a.groupIds)===decisionDigest(b.groupIds);
function qualified(root:string,input:string) {
 const at=input.lastIndexOf('·');if(at<1)throw new CommandError('请写 ir-号·C-号',['ir-号·C-01']);
 const reportId=resolveArgument(root,input.slice(0,at),['improve-report']).id;
 let history:ReturnType<typeof readImproveHistory>;try{history=readImproveHistory(root,reportId);}catch{throw new CommandError(`没有找到报告 ${input.slice(0,at)}`);}
 const local=input.slice(at+1),candidate=history.report.candidates.find(c=>{
  const label=historyCandidateLabel(root,history.report,c);return c.id===local||label===local||label.split('@')[0]===local;
 });
 if(!candidate)throw new CommandError(`没有找到候选 ${local}`,history.candidates.map(c=>c.label));
 return {reportId,candidateId:candidate.id,history};
}
function sourceToRemove(root:string,workspace:string,kind:string,path:string) {
 let target=expandPath(workspace,path);try{target=realpathSync(target);}catch{/* Removing a missing registration need not resurrect its source. */}
 const found=listRegisteredSources(root,workspace).filter(reg=>reg.kind===(kind==='self'?'self-source':'eval-asset')&&
  (reg.root===target||reg.paths.length===1&&resolve(reg.root,reg.paths[0])===target||(()=>{const child=relative(reg.root,target);return !!child&&!isAbsolute(child)&&child!=='..'&&!child.startsWith('../')&&reg.paths.every(path=>path.startsWith(child+'/'));})()));
 if(found.length!==1)throw Error(found.length?'IMPROVE_SOURCE_REGISTRATION_AMBIGUOUS: 请指定精确登记路径':'IMPROVE_SOURCE_REGISTRATION_NOT_FOUND');
 return found[0];
}
/** Only this adapter opens write confirmations. Reading a browser never calls it. */
export class ImproveManagement {
 constructor(private root:string,private workspace:string,private host:ImproveManagementHost){}
 private allowed() {if(!mayWrite(this.host))return false;const reason=this.host.blocked();if(reason){this.host.feedback(reason);return false;}return true;}
 private unavailable(title:string,error:unknown) {
  const reason=clean(String(error));this.host.confirm(new ConfirmDialog({title,action:'确认',body:[`✗ 核对未通过 · ${reason}`,'返回后核对目标与当前状态'],wrapBody:true,disabled:reason}),()=>{});
 }
 private perform(label:string,reportId:string|undefined,work:(signal:AbortSignal)=>Promise<unknown>) {
  if(!this.allowed())return;
  void this.host.run(label,reportId,work).finally(()=>this.host.changed());
 }
 command(kind:'continue'|'rollback'|'restore',input:string,prefill:ReasonPrefill={}) {
  if(kind==='continue') {
   const reportId=resolveArgument(this.root,input,['improve-report']).id;
   let history:ReturnType<typeof readImproveHistory>;try{history=readImproveHistory(this.root,reportId);}catch{throw new CommandError(`没有找到报告 ${input}`);}
   const actions=history.actions.filter(a=>a.kind==='continue');
   if(!actions.length)throw new CommandError('没有未运行的独立项');
   this.chooseAction(actions,prefill);return;
  }
  const {reportId,candidateId,history}=qualified(this.root,input);
  if(kind==='rollback') {
   const actions=history.actions.filter(a=>a.kind==='rollback'&&a.candidateIds.includes(candidateId));
   if(!actions.length)throw new CommandError('该候选没有仍有效的已写回组合',history.actions.filter(a=>a.kind==='rollback').map(a=>a.label));
   this.chooseAction(actions,prefill);return;
  }
  const items=readSuppressionHistory(this.root).filter(item=>item.reportId===reportId&&item.candidateId===candidateId);
  if(!items.length)throw new CommandError('该候选没有生效中的建议抑制');
  if(items.length===1){this.restore(items[0].id,prefill);return;}
  if(!this.allowed())return;
  // The host never guesses an ambiguous suppression.
  const box=new ConfirmDialog({title:'选择要恢复的抑制',action:'查看确认',choice:{mode:'single',options:items.map(item=>({label:`${item.label} · ${item.at}`})),selected:[0]},fixed:['本步只选择记录，下一步确认恢复'],disabled:()=>this.host.blocked()});
  this.host.confirm(box,()=>this.restore(items[box.selected[0]??0].id,prefill));
 }
 private chooseAction(actions:ImproveHistoryAction[],prefill:ReasonPrefill) {
  if(actions.length===1){this.action(actions[0],prefill);return;}
  if(!this.allowed())return;
  const box=new ConfirmDialog({title:'选择历史提交批次',action:'查看确认',body:actions.map((a,i)=>`${i+1}. ${a.label} · 批次 ${a.decisionId} · ${a.groupIds.join('、')}`),wrapBody:true,choice:{mode:'single',options:actions.map(a=>({label:a.label,disabled:a.disabled})),selected:[Math.max(0,actions.findIndex(a=>!a.disabled))]},fixed:['只选择一个原提交批次；下一步核对精确范围'],disabled:()=>this.host.blocked()});
  this.host.confirm(box,()=>this.action(actions[box.selected[0]??0],prefill));
 }
 action(original:ImproveHistoryAction,prefill:ReasonPrefill={}) {
  if(!this.allowed())return;
  const find=()=>{const h=readImproveHistory(this.root,original.reportId),action=h.actions.find(a=>sameAction(a,original));if(!action)throw Error('IMPROVE_HISTORY_ACTION_CHANGED');if(action.disabled)throw Error(action.disabled);return {h,action};};
  let current:ReturnType<typeof find>;try{current=find();}catch(error){const reason=clean(String(error));this.host.feedback(reason);return reason;}
  const {action,h}=current,names=action.candidateIds.map(id=>h.candidates.find(c=>c.candidate.id===id)?.label??id);
  try {
   if(action.kind==='continue') {
    const request={id:action.decisionId,decisionSource:action.decisionSource,groupIds:action.groupIds},preview=previewImproveResume(this.root,request);
    const amount=decisionBudgetAmount(preview.reserved.tokens,preview.state.price);
    const box=new ConfirmDialog({title:'继续未运行的独立项',action:'继续',wrapBody:true,body:[`报告 ${h.report.id} · 候选 ${names.join(' + ')}`,`原批次 ${action.decisionId}`,`组合 ${action.groupIds.join('、')}`,...preview.pendingDecision.selections.map(s=>`${s.target.workspace} · ${s.target.files.map(f=>f.path).join('、')} · 基线 ${s.target.baseline}`)],fixed:[`≤ ${preview.reserved.requests} 请求 · ${amount.display} · 检查 ${preview.reserved.checks} 项 · 最晚 ${preview.decision.limits.deadline}`,'沿用原授权；失败、取消或未知时，剩余项不启动'],disabled:()=>this.host.blocked()});
    this.host.confirm(box,()=>this.perform('继续',action.reportId,async signal=>{find();previewImproveResume(this.root,request);return this.host.resume({...request,resumeId:randomUUID()},signal);}));return;
   }
   const preview=previewImproveRollback(this.root,action.decisionId,action.decisionSource,action.groupIds),bound=decisionDigest(preview);
   const box=new ImproveReasonDialog({title:'回退组合写回',action:'回退',body:[`报告 ${h.report.id} · ${names.join(' + ')} · 批次 ${action.decisionId}`,...preview.flatMap(g=>g.files.map(f=>`恢复 ${f.root}/${f.path}\n${f.after.sha256} → ${f.before.sha256}`))],fixed:['只恢复本组合的精确文件与相应默认项 · 不调用模型 · 不逆转既有外部副作用','执行前再次核对当前内容；后续用户编辑会阻止回退'],disabled:()=>this.host.blocked()},ROLLBACK_REASONS,prefill);
   this.host.confirm(box,()=>this.perform('回退',action.reportId,async signal=>{find();if(bound!==decisionDigest(previewImproveRollback(this.root,action.decisionId,action.decisionSource,action.groupIds)))throw Error('IMPROVE_ROLLBACK_PREVIEW_CHANGED');return rollbackImproveDecision({dataRoot:this.root,id:action.decisionId,decisionSource:action.decisionSource,groupIds:action.groupIds,rollbackId:randomUUID(),reason:box.reason,signal});}));
  }catch(error){const reason=clean(String(error));this.host.feedback(reason);return reason;}
 }
 restore(id:string,prefill:ReasonPrefill={}) {
  if(!this.allowed())return;
  const item=readSuppressionHistory(this.root).find(item=>item.id===id);if(!item){this.host.feedback('建议抑制已变化 · 请重新选择');return;}
  const box=new ImproveReasonDialog({title:'恢复建议',action:'恢复',body:[`${item.label} · ${item.title}`,`范围 ${item.problem.target.workspace} · ${item.problem.target.kind}`,...item.problem.paths.map((p:string)=>`文件 ${p}`),`抑制于 ${item.at}`],fixed:['写入恢复记录 · 不调用模型 · 此范围内同一问题可以再次被建议'],disabled:()=>this.host.blocked()},RESTORE_REASONS,prefill);
  this.host.confirm(box,()=>this.perform('恢复建议',item.reportId,async()=>{
   const current=readSuppressionHistory(this.root).find(current=>current.id===id);if(!current||current.sourceId!==item.sourceId)throw Error('IMPROVE_SUPPRESSION_CHANGED');
   return restoreImproveSuggestion({dataRoot:this.root,id:randomUUID(),suppressionId:id,reason:box.reason});
  }));
 }
 source(action:'register'|'unregister',kind:string,path:string) {
  if(!this.allowed())return;
  const title=action==='register'?'登记来源':'移除来源',input=`${kind} ${path}`;
  try {
   const preview=action==='register'?previewRegisterFromInput(this.workspace,input):sourceToRemove(this.root,this.workspace,kind,path),bound=decisionDigest(preview);
   const box=new ConfirmDialog({title,action:action==='register'?'登记':'移除',wrapBody:true,body:[`已核对 ${kind==='self'?'自身源码':'eval 资产'} · ${preview.root}`,...preview.fingerprints.map(f=>`${preview.root}/${f.path} · ${f.bytes} bytes · ${f.sha256}`)],fixed:[action==='register'?'保存来源登记 · 不调用模型 · 不执行分析':'只移除来源登记 · 不删除文件、历史记录或建议抑制'],disabled:()=>this.host.blocked()});
   this.host.confirm(box,()=>this.perform(title,undefined,async()=>{
    const owner=await acquireOwner(this.root,()=>{});
    try {owner.assertHeld();const current=action==='register'?previewRegisterFromInput(this.workspace,input):sourceToRemove(this.root,this.workspace,kind,path);if(decisionDigest(current)!==bound)throw Error('IMPROVE_SOURCE_PREVIEW_CHANGED');
     if(action==='register')return registerFromInput(this.root,this.workspace,input);
     unregisterImproveSource(this.root,(current as SourceRegistration).id);
    }finally{await owner.release();}
   }));
  }catch(error){this.unavailable(title,error);}
 }
}
