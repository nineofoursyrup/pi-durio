import {matchesKey,stripTerminalSequences,wrapTextWithAnsi,truncateToWidth} from '@earendil-works/pi-tui';
import {queryFeedbackMetrics,formatFeedbackMetrics,type FeedbackMetricsReport,queryOperationsMetrics,formatOperationsMetrics,type OperationsMetricsReport,queryTaskMetrics,formatTaskMetrics,type MetricsScope,type TaskMetricsReport} from '../metrics/index.js';
import {readEvidence} from '../history.js';

/** Presentation only: report revisions and immutable sources never open execution. */
export class MetricsView {
 private value:TaskMetricsReport;private operations?:OperationsMetricsReport;private operationsVisible=false;private feedback?:FeedbackMetricsReport;private feedbackVisible=false;private line=0;private selected=0;private mode:'report'|'sources'|'detail'='report';
 private sources:{id:string;root:string}[]=[];private content='';private offset=0;private offsets:number[]=[];private next:number|null=null;
 private revisions:number[]=[];private revisionIndex=0;
 constructor(private root:string,private scope:MetricsScope={}) {this.value=queryTaskMetrics(root,scope);this.scope={...this.value.scope};this.revisions=[this.value.scope.through,...new Set(this.value.tasks.flatMap(t=>t.acceptance.history.map(h=>Number(h.source.split(':')[1])-1)).sort((a,b)=>b-a))];this.loadReport();}
 get report(){return this.value;}
 get operationsReport(){return this.operations;}
 get feedbackReport(){return this.feedback;}

 private loadReport(){
  this.content=this.feedbackVisible&&this.feedback?formatFeedbackMetrics(this.feedback):this.operationsVisible&&this.operations?formatOperationsMetrics(this.operations):formatTaskMetrics(this.value);
  const sources=this.value.tasks.flatMap(t=>[t.acceptedSource,...t.sources,...t.acceptance.history.map(h=>h.source),...t.acceptance.results.flatMap(r=>r.evidence)]).map(id=>({id,root:this.root}));
  if(this.operationsVisible&&this.operations){for(const request of this.operations.costs.requests)for(const id of [request.source,...request.usageSources,...request.history.map(h=>h.source)])sources.push({id,root:request.dataRoot});for(const e of this.operations.faults.events)sources.push({id:e.source,root:e.dataRoot});}
  if(this.feedbackVisible&&this.feedback){for(const task of [...this.feedback.intervention.tasks,...this.feedback.rework.tasks]){const ids=[task.acceptedSource,...task.start?[task.start.source]:[],...task.end?[task.end.source]:[],...task.delivery?[task.delivery.source]:[],...task.redeliveries.map(d=>d.source),...task.feedback.history.map(h=>h.source),...task.feedback.items.flatMap(e=>e.sourceRefs),...task.feedback.missing.map(m=>m.source)];for(const id of ids)sources.push({id,root:this.root});}}
  this.sources=[...new Map(sources.map(s=>[`${s.root}#${s.id}`,s])).values()];this.mode='report';this.line=0;
 }
 private loadDetail(){const source=this.sources[this.selected],page=readEvidence(source.root,source.id,{offset:this.offset,limit:2048});this.content=JSON.stringify({dataRoot:source.root,...page},null,2);this.next='next'in page?page.next??null:null;this.line=0;}

 handleInput(data:string){
  if(data==='o'&&this.mode==='report'){this.feedbackVisible=false;this.operationsVisible=!this.operationsVisible;if(this.operationsVisible){this.operations=queryOperationsMetrics(this.root,{...this.scope,through:this.value.scope.through});this.revisions=[...new Set([...this.revisions,...this.operations.costs.requests.filter(r=>r.dataRoot===this.root).flatMap(r=>r.history.filter(h=>h.id).map(h=>Number(h.source.split(':')[1])-1))])].sort((a,b)=>b-a);}this.loadReport();return;}
  if(data==='f'&&this.mode==='report'){this.operationsVisible=false;this.feedbackVisible=!this.feedbackVisible;if(this.feedbackVisible){this.feedback=queryFeedbackMetrics(this.root,{...this.scope,through:this.value.scope.through});this.revisions=[...new Set([...this.revisions,...[...this.feedback.intervention.tasks,...this.feedback.rework.tasks].flatMap(t=>t.feedback.history.map(h=>Number(h.source.split(':')[1])-1))])].sort((a,b)=>b-a);}this.loadReport();return;}
  if(data==='b'){if(this.mode==='detail'){this.mode='sources';this.line=0;}else this.loadReport();return;}
  if(data==='e'&&this.mode==='report'){this.mode='sources';this.selected=0;this.line=0;return;}
  if(data==='r'&&this.mode==='report'){this.revisionIndex=(this.revisionIndex+1)%this.revisions.length;this.value=queryTaskMetrics(this.root,{...this.scope,through:this.revisions[this.revisionIndex]});if(this.operationsVisible)this.operations=queryOperationsMetrics(this.root,{...this.scope,through:this.revisions[this.revisionIndex]});if(this.feedbackVisible)this.feedback=queryFeedbackMetrics(this.root,{...this.scope,through:this.revisions[this.revisionIndex]});this.loadReport();return;}
  if(matchesKey(data,'up')){if(this.mode==='sources')this.selected=Math.max(0,this.selected-1);else this.line=Math.max(0,this.line-1);}
  if(matchesKey(data,'down')){if(this.mode==='sources')this.selected=Math.min(this.sources.length-1,this.selected+1);else this.line++;}
  if(matchesKey(data,'pageUp'))this.line=Math.max(0,this.line-5);if(matchesKey(data,'pageDown'))this.line+=5;
  if(this.mode==='sources'&&matchesKey(data,'enter')&&this.sources[this.selected]){this.mode='detail';this.offset=0;this.offsets=[];this.loadDetail();}
  if(this.mode==='detail'){if(data==='n'&&this.next!==null){this.offsets.push(this.offset);this.offset=this.next;this.loadDetail();}if(data==='p'&&this.offsets.length){this.offset=this.offsets.pop()!;this.loadDetail();}}
 }
 scroll(delta:number){this.line=Math.max(0,this.line+delta);}
 render(width:number,height:number){
  const wrap=(text:string)=>wrapTextWithAnsi(stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'),Math.max(1,width-2));
  const lines=wrap('任务指标 · 只读；/metrics JSON 与 headless scope 相同'),starts:number[]=[];
  if(this.mode==='sources')for(const [i,source]of this.sources.entries()){starts.push(lines.length);lines.push(...wrap(`${i===this.selected?'›':' '} ${source.id}${source.root!==this.root?' @ '+source.root:''}`));}else lines.push(...wrap(this.content));
  const h=Math.max(1,height-1),chosen=starts[this.selected];if(chosen!==undefined){if(chosen<this.line)this.line=chosen;else if(chosen>=this.line+h)this.line=chosen-h+1;}
  this.line=Math.min(this.line,Math.max(0,lines.length-h));return[...lines.slice(this.line,this.line+h),truncateToWidth('f介入/返工 o成本/故障 ↑↓滚动 e来源 Enter原文 r旧修订 n/p分页 b返回 Esc关闭',width)];
 }
}
