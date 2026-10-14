import {matchesKey,stripTerminalSequences,wrapTextWithAnsi,truncateToWidth} from '@earendil-works/pi-tui';
import {evalReport,formatEvalReport,listEvalPlans} from '../eval/runner.js';
import {queryEvidence,readEvidence,type EvidenceReference} from '../history.js';
/** Readonly report/source viewer. No runner, write operation or current-session capability. */
export class EvalView{
 private plans:ReturnType<typeof listEvalPlans>;private selected=0;private line=0;private followSelection=true;private content:string|null=null;private planId?:string;
 private revisions:(number|undefined)[]=[undefined];private revisionIndex=0;
 private records?:ReturnType<typeof queryEvidence>;private after=0;private afters:number[]=[];private detail?:EvidenceReference;private offset=0;private offsets:number[]=[];private next:number|null=null;
 constructor(private root:string,id?:string){this.plans=listEvalPlans(root);if(id)this.report(id);}
 private report(id:string){this.planId=id;const report=evalReport(this.root,id);this.revisions=[undefined,...report.gradingRevisions.toReversed().map(r=>Number(r.source.split(':')[1])-1)];this.revisionIndex=0;this.content=formatEvalReport(report);this.line=0;this.records=undefined;this.detail=undefined;}
 private load(){const page=readEvidence(this.root,this.detail!.id,{offset:this.offset,limit:2048});this.content=JSON.stringify(page,null,2);this.next='next'in page?page.next??null:null;this.line=0;}
 handleInput(data:string){
  if(data==='r'&&this.planId&&!this.records&&!this.detail){this.revisionIndex=(this.revisionIndex+1)%this.revisions.length;this.content=formatEvalReport(evalReport(this.root,this.planId,{asOf:this.revisions[this.revisionIndex]}));this.line=0;return;}
  if(data==='b'){if(this.detail){this.detail=undefined;this.content=null;}else if(this.records&&this.planId)this.report(this.planId);else{this.content=null;this.planId=undefined;}this.line=0;return;}
  if(data==='e'&&this.planId){this.after=0;this.afters=[];this.records=queryEvidence(this.root,this.planId,{limit:8});this.detail=undefined;this.content=null;this.selected=0;this.line=0;return;}
  if(matchesKey(data,'up')){this.followSelection=true;if(this.content)this.line=Math.max(0,this.line-1);else this.selected=Math.max(0,this.selected-1);}
  if(matchesKey(data,'down')){this.followSelection=true;if(this.content)this.line++;else this.selected=Math.min((this.records?.items.length??this.plans.length)-1,this.selected+1);}
  if(matchesKey(data,'pageDown'))this.line+=5;if(matchesKey(data,'pageUp'))this.line=Math.max(0,this.line-5);
  if(this.detail){if(data==='n'&&this.next!==null){this.offsets.push(this.offset);this.offset=this.next;this.load();}if(data==='p'&&this.offsets.length){this.offset=this.offsets.pop()!;this.load();}return;}
  if(this.records){
   if(data==='n'&&this.records.next!==null){this.afters.push(this.after);this.after=this.records.next;this.records=queryEvidence(this.root,this.planId!,{snapshot:this.records.snapshot,after:this.after,limit:8});this.selected=0;}
   if(data==='p'&&this.afters.length){this.after=this.afters.pop()!;this.records=queryEvidence(this.root,this.planId!,{snapshot:this.records.snapshot,after:this.after,limit:8});this.selected=0;}
   if(matchesKey(data,'enter')&&this.records.items[this.selected]){this.detail=this.records.items[this.selected];this.offset=0;this.offsets=[];this.load();}return;
  }
  if(matchesKey(data,'enter')&&!this.content&&this.plans[this.selected]){try{this.report(this.plans[this.selected].id);}catch(error){this.content=`证据不可读取：${String(error)}`;}this.line=0;}
 }
 scroll(delta:number){this.line=Math.max(0,this.line+delta);this.followSelection=false;}
 render(width:number,height:number){
  const rows=this.records?this.records.items.map((item,i)=>`${i===this.selected?'›':' '} #${item.seq} ${item.kind}\n${item.id}`):this.plans.map((p,i)=>`${i===this.selected?'›':' '} ${p.id} · ${p.mode}\n${p.purpose}`);
  const wrap=(text:string)=>wrapTextWithAnsi(stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'),Math.max(1,width-2));
  const lines=wrap('Eval · 只读固定报告与原文'),starts:number[]=[];
  if(this.content)lines.push(...wrap(this.content));else for(const row of rows){starts.push(lines.length);lines.push(...wrap(row));}
  if(!this.content&&!rows.length)lines.push('暂无记录');const bodyHeight=Math.max(1,height-1),selected=starts[this.selected];
  if(!this.content&&this.followSelection&&selected!==undefined){if(selected<this.line)this.line=selected;else if(selected>=this.line+bodyHeight)this.line=selected-bodyHeight+1;}
  this.line=Math.min(this.line,Math.max(0,lines.length-bodyHeight));return[...lines.slice(this.line,this.line+bodyHeight),truncateToWidth('↑↓选择/滚动 Enter查看 e来源 r报告修订 n/p翻页 b上层 Esc返回',width)];
 }
}
