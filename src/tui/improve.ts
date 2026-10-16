import {matchesKey} from '@earendil-works/pi-tui';
import {listImproveReports} from '../improve.js';
import {readImproveHistory,readSuppressionHistory,type ImproveHistoryAction} from '../improve-report-history.js';
import {readDisplayIndex,isUserChosenId} from '../display-number.js';
import {improveCandidateCard,MODE_LABEL} from './improve-card.js';
import type {ImproveDecision,ImproveMode} from '../improve-decisions.js';
import type {PlanSource} from '../eval/overview.js';
import {ImproveCheckOriginal} from './improve-result.js';
import {clean,fixedFrame,hintLine,wrapAuthorized} from './view-stack.js';
import {styledLine} from './theme.js';

export interface ImproveHistoryHost {
 workspace?:string;
 action?(action:ImproveHistoryAction):string|void;
 restore?(id:string):void;
 openEval?(source:PlanSource):void;
 feedback?(text:string):void;
}
/** History navigation itself is read-only. The host owns explicit confirmations. */
export class ImproveView {
 private page:ReturnType<typeof listImproveReports>;private after=0;private previous:number[]=[];private selected=0;private line=0;
 private detail?:ReturnType<typeof readImproveHistory>;private suppressions:ReturnType<typeof readSuppressionHistory>=[];
 private entries:ReturnType<typeof readImproveHistory>[]=[];private cursor=0;private anchors:number[]=[];private reveal=false;
 private original?:ImproveCheckOriginal;
 constructor(private root:string,id?:string,private suppressionList=false,private host:ImproveHistoryHost={}) {
  this.page=listImproveReports(root,{limit:10});this.load();if(id)this.open(id);
 }
 get reportId(){return this.detail?.report.id;}
 get current(){return this.detail;}
 get depth(){return this.original?3:this.detail?2:1;}
 private get checks(){return this.detail?.decisions.flatMap(({state})=>state.decision.groups.filter((g:any)=>g.checks.length).map((group:any)=>({state,group})))??[];}
 refresh(){const id=this.reportId;this.load();if(id)this.detail=readImproveHistory(this.root,id);}
 private load() {
  if(this.suppressionList){this.suppressions=readSuppressionHistory(this.root,this.host.workspace);return;}
  // Filtering never hides the next page. Cursors retain the journal order.
  this.entries=this.page.items.filter(item=>!this.host.workspace||item.target.workspace===this.host.workspace).flatMap(item=>{
   try{return [readImproveHistory(this.root,item.id)];}catch{return [];}
  });
 }
 open(id:string){const detail=readImproveHistory(this.root,id);this.detail=detail;this.line=0;this.cursor=0;this.reveal=true;}
 back(){if(this.original){this.original=undefined;return true;}if(!this.detail)return false;this.detail=undefined;this.line=0;this.cursor=0;return true;}
 scroll(delta:number){if(this.original){this.original.scroll(delta);return;}this.line=Math.max(0,this.line+delta);this.reveal=false;}
 handleInput(data:string) {
  if(this.original){this.original.handleInput(data);return;}
  if(this.detail) {
   const checks=this.checks,count=this.detail.candidates.length+checks.length+this.detail.actions.length;
   if(matchesKey(data,'tab')||matchesKey(data,'shift+tab')){this.cursor=(this.cursor+(matchesKey(data,'shift+tab')?-1:1)+count)%Math.max(1,count);this.reveal=true;}
   if(matchesKey(data,'up'))this.scroll(-1);if(matchesKey(data,'down'))this.scroll(1);
   if(matchesKey(data,'pageDown')||data==='n')this.scroll(10);if(matchesKey(data,'pageUp')||data==='p')this.scroll(-10);
   if(matchesKey(data,'enter')){
    const check=checks[this.cursor-this.detail.candidates.length];
    if(check){this.original=new ImproveCheckOriginal(this.root,check.state.decision as ImproveDecision,check.group.id,source=>this.host.openEval?.(source));return;}
    const action=this.detail.actions[this.cursor-this.detail.candidates.length-checks.length];
    if(action){if(action.disabled)this.host.feedback?.(action.disabled);else{const reason=this.host.action?.(action);if(reason)action.disabled=reason;}}
   }
   return;
  }
  const count=this.suppressionList?this.suppressions.length:this.entries.length;
  if(matchesKey(data,'up')||matchesKey(data,'shift+tab'))this.selected=Math.max(0,this.selected-1);
  if(matchesKey(data,'down')||matchesKey(data,'tab'))this.selected=Math.min(Math.max(0,count-1),this.selected+1);
  if(!this.suppressionList&&data==='n'&&this.page.next!==null){this.previous.push(this.after);this.after=this.page.next;this.page=listImproveReports(this.root,{after:this.after,limit:10});this.selected=0;this.line=0;this.load();}
  if(!this.suppressionList&&data==='p'&&this.previous.length){this.after=this.previous.pop()!;this.page=listImproveReports(this.root,{after:this.after,limit:10});this.selected=0;this.line=0;this.load();}
  if(matchesKey(data,'enter')){if(this.suppressionList){const item=this.suppressions[this.selected];if(item)this.host.restore?.(item.id);}else{const item=this.entries[this.selected];if(item)this.open(item.report.id);}}
 }
 render(width:number,height:number) {
  if(this.original)return this.original.render(width,height);
  const index=readDisplayIndex(this.root),detail=this.detail,body:string[]=[],header:string[]=[];
  const text=(s:string)=>wrapAuthorized(s,width).map(line=>styledLine([{text:line,fg:'fg.body'}],width));
  if(detail) {
   const r=detail.report;
   header.push(...text(`◆ improve 历史 · ${index.label('improve-report',r.id)} · 只读报告 · ${detail.contract==='legacy'?'首版报告':detail.contract==='unknown'?'报告格式未确认':'已保存报告'}`));
   if(isUserChosenId(r.id))header.push(...text(`原 id ${r.id}`));
   body.push(...text(`${r.startedAt??'时间未记录'} · ${r.state==='complete'?'完整':'不完整'}${r.reason?' · '+r.reason:''} · ${detail.cost}`),...text(`Target ${detail.sessionId?index.label('session',detail.sessionId):'会话未记录'} · ${index.label('run',r.target.runId)} · ${r.target.workspace}`));
   this.anchors=[];
   detail.candidates.forEach((item,i)=>{
    this.anchors.push(body.length);
    const latest=item.latest,expanded=i===this.cursor;
    body.push(...improveCandidateCard(this.root,r,item.candidate,width,{expanded,selected:expanded,readOnly:true,label:item.label,decision:latest?{mode:latest.mode,state:latest.result,extraDecisions:detail.contract==='legacy'?item.history.length-1:undefined}:undefined}));
    if(expanded)for(const event of item.history)body.push(...text(`${event.at??'时间未记录'} · ${MODE_LABEL[event.mode as ImproveMode]??event.mode} · ${event.result}`));
    body.push('');
   });
   if(r.suppressed?.length)body.push(...text(`另有 ${r.suppressed.length} 项已按“不再建议”隐藏`));
   const checks=this.checks;
   if(checks.length)body.push(...text('已保存的检查原文'));
   checks.forEach(({state,group},i)=>{this.anchors.push(body.length);body.push(...text(`${this.cursor===detail.candidates.length+i?'▸':' '} 查看 ${group.candidateIds.map((id:string)=>detail.candidates.find(c=>c.candidate.id===id)?.label??id).join(' + ')} · 批次 ${state.id} · ${group.id}`));});
   body.push(...text('可执行的操作'));
   detail.actions.forEach((action,i)=>{this.anchors.push(body.length);body.push(...text(`${this.cursor===detail.candidates.length+checks.length+i?'▸':' '} ${action.label}${action.disabled?' · 不可用 · '+action.disabled:''}`));});
   if(!detail.actions.length)body.push(...text('没有可执行的历史操作'));
   if(this.reveal){this.line=this.anchors[this.cursor]??0;this.reveal=false;}
  } else {
   header.push(...text(`◆ improve ${this.suppressionList?'建议抑制':'历史报告'} · ${this.host.workspace??'全部项目'}`));
   if(this.suppressionList) {
    for(const [i,item]of this.suppressions.entries())body.push(styledLine([{text:clean(`${i===this.selected?'▸':' '} ${item.label} · ${item.title}${width>=60?' · 抑制于 '+item.at.slice(0,10):''}`),fg:i===this.selected?'fg.primary':'fg.body'}],width,i===this.selected?'bg.selected':undefined));
   } else for(const [i,item]of this.entries.entries()) {
    const r=item.report,c=item.counts,decided=Object.values(c).reduce((a,b)=>a+b,0);
    const row=`${i===this.selected?'▸':' '} ${index.label('improve-report',r.id)}${width>=60?' · '+(r.startedAt?.slice(0,16)??'时间未记录'):''}${width>=100?' · '+(item.sessionId?index.label('session',item.sessionId):'会话未记录'):''} · 候选 ${r.candidates.length} · ${width>=100?`执行 ${c['execute-declared-scope']} 验证 ${c['validate-only']} 暂缓 ${c.defer} 不再建议 ${c['do-not-suggest']}`:`已决 ${decided}/${r.candidates.length}`}${width>=100?' · '+item.cost:''} · ${r.state==='complete'?'完整':'不完整'}`;
    body.push(styledLine([{text:clean(row),fg:i===this.selected?'fg.primary':'fg.body'}],width,i===this.selected?'bg.selected':undefined));
   }
   if(!body.length)body.push(...text(this.suppressionList?'当前范围内没有建议抑制':'当前页没有历史报告 · n/p 翻页'));
   const available=Math.max(1,height-header.length-1);if(this.selected<this.line)this.line=this.selected;if(this.selected>=this.line+available)this.line=this.selected-available+1;
  }
  const footer=hintLine(detail?['↑↓ 滚动','Tab 下一项','Enter 操作']:['↑↓ 选择',this.suppressionList?'Enter 恢复':'Enter 详情','n/p 翻页'],width,{esc:detail?'Esc 返回列表':'Esc 返回'});
  const frame=fixedFrame(header,body,[footer],height,this.line);this.line=frame.offset;return frame.lines;
 }
}
