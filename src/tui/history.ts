import { matchesKey,stripTerminalSequences,wrapTextWithAnsi,truncateToWidth } from '@earendil-works/pi-tui';
import { queryHistory,queryEvidence,queryAttempts,readEvidence,resolveEvidence,type HistoryFilter,type HistoryCursor,type EvidenceReference } from '../history.js';
import { queryUsage } from '../usage-query.js';
import { scopedEvidence } from '../derived-evidence.js';

/** Presentation-only: it has no execution handle, active-session setter or management writer. */
export class HistoryView {
  private history:ReturnType<typeof queryHistory>;
  private cursor?:HistoryCursor;
  private previous:(HistoryCursor|undefined)[]=[];
  private selected=0;
  private evidence?:ReturnType<typeof queryEvidence>;
  private evidencePrevious:number[]=[];
  private detail?:EvidenceReference;
  private offset=0;
  private offsets:number[]=[];
  private next:number|null=null;
  private content='';
  private traceAfter=0;
  private traceNext:number|null=null;
  private tracePrevious:number[]=[];
  private line=0;
  private followSelection=true;
  private mode:'runs'|'records'|'detail'|'trace'|'usage'|'derived'='runs';
  constructor(private root:string,private filter:HistoryFilter={}){this.history=queryHistory(root,filter,{limit:8});}
  handleInput(data:string) {
    this.line=Math.max(0,this.line);
    if(matchesKey(data,'up')){if(this.mode==='runs'||this.mode==='records'){this.selected=Math.max(0,this.selected-1);this.followSelection=true;}else this.line=Math.max(0,this.line-1);}
    if(matchesKey(data,'down')){if(this.mode==='runs'||this.mode==='records'){this.selected++;this.followSelection=true;}else this.line++;}
    if(matchesKey(data,'pageUp'))this.line=Math.max(0,this.line-5);
    if(matchesKey(data,'pageDown'))this.line+=5;
    if(data==='b'){this.mode=this.mode==='records'||this.mode==='runs'||!this.evidence?'runs':'records';this.selected=0;this.line=0;this.followSelection=true;return;}
    if(this.mode==='runs'){
      this.selected=Math.min(this.selected,this.history.items.length-1);
      if(data==='n'&&this.history.next){this.previous.push(this.cursor);if(this.previous.length>64)this.previous.shift();this.cursor=this.history.next;this.history=queryHistory(this.root,this.filter,{limit:8,cursor:this.cursor});this.selected=0;}
      if(data==='p'&&this.previous.length){this.cursor=this.previous.pop();this.history=queryHistory(this.root,this.filter,{limit:8,cursor:this.cursor});this.selected=0;}
      const run=this.history.items[this.selected];
      if(matchesKey(data,'enter')&&run?.runId){this.evidence=queryEvidence(this.root,run.runId,{snapshot:this.history.coverage.snapshot,limit:8});this.mode='records';this.selected=0;this.line=0;}
      else if(matchesKey(data,'enter')&&run?.source){this.evidence=undefined;this.detail=resolveEvidence(this.root,run.source);this.offset=0;this.offsets=[];this.line=0;this.mode='detail';this.load();}
      return;
    }
    if(this.mode==='records'&&this.evidence){
      this.selected=Math.min(this.selected,this.evidence.items.length-1);
      if(data==='n'&&this.evidence.next){this.evidencePrevious.push(this.evidence.items[0]?.seq?this.evidence.items[0].seq-1:0);if(this.evidencePrevious.length>64)this.evidencePrevious.shift();this.evidence=queryEvidence(this.root,this.evidence.runId,{snapshot:this.evidence.snapshot,after:this.evidence.next,limit:8});this.selected=0;}
      if(data==='p'&&this.evidencePrevious.length){this.evidence=queryEvidence(this.root,this.evidence.runId,{snapshot:this.evidence.snapshot,after:this.evidencePrevious.pop(),limit:8});this.selected=0;}
      if(data==='t'){this.traceAfter=0;this.tracePrevious=[];this.line=0;this.mode='trace';this.loadTrace();}
      if(data==='u'){this.content=JSON.stringify(queryUsage(this.root,[this.evidence.runId],this.evidence.snapshot),null,2);this.line=0;this.mode='usage';}
      if(matchesKey(data,'enter')&&this.evidence.items[this.selected]){this.detail=this.evidence.items[this.selected];this.offset=0;this.offsets=[];this.line=0;this.mode='detail';this.load();}
      return;
    }
    if(this.mode==='detail'&&this.detail){
      if(data==='n'&&this.next!==null){this.offsets.push(this.offset);if(this.offsets.length>64)this.offsets.shift();this.offset=this.next;this.line=0;this.load();}
      if(data==='p'&&this.offsets.length){this.offset=this.offsets.pop()!;this.line=0;this.load();}
      if(data==='d'){const reader=scopedEvidence(this.root,{runIds:[this.detail.runId],through:this.history.coverage.snapshot,maxBytes:4096,purpose:'local historical inspection',destination:{kind:'local'}});this.content=JSON.stringify(reader.read(this.detail.id),null,2);this.mode='derived';this.line=0;}
    }
    if(this.mode==='trace'){
      if(data==='n'&&this.traceNext!==null){this.tracePrevious.push(this.traceAfter);if(this.tracePrevious.length>64)this.tracePrevious.shift();this.traceAfter=this.traceNext;this.line=0;this.loadTrace();}
      if(data==='p'&&this.tracePrevious.length){this.traceAfter=this.tracePrevious.pop()!;this.line=0;this.loadTrace();}
    }
  }
  private loadTrace(){const page=queryAttempts(this.root,this.evidence!.runId,{snapshot:this.evidence!.snapshot,after:this.traceAfter,limit:4});this.traceNext=page.next;this.content=JSON.stringify(page,null,2);}
  private load(){const page=readEvidence(this.root,this.detail!.id,{offset:this.offset,limit:2048});this.content=JSON.stringify(page,null,2);this.next='next'in page?page.next??null:null;}
  scroll(delta:number){this.line=Math.max(0,this.line+delta);this.followSelection=false;}
  render(width:number,height:number) {
    const wrap=(text:string)=>wrapTextWithAnsi(stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'),Math.max(1,width-2));
    const lines=wrap('历史 · 只读；不会改变当前执行目标');const starts:number[]=[];
    if(this.mode==='runs'){
      lines.push(...wrap(`筛选 ${JSON.stringify(this.filter)}\n截至 ${this.history.coverage.snapshot} / 当前 ${this.history.coverage.current}${this.history.coverage.stale?' · 陈旧快照':''}`));
      this.history.items.forEach((row,i)=>{starts.push(lines.length);lines.push(...wrap(`${i===this.selected?'›':' '} ${row.status} ${row.runId??`未运行 task ${row.taskId}`}\n  ${row.project} · ${row.completeness} · usage ${row.usage}`));});
      if(!this.history.items.length)lines.push(...wrap('没有匹配的已取得事实；不证明没有发生'));
    }else if(this.mode==='records'){
      lines.push(...wrap(`run ${this.evidence?.runId}`));this.evidence?.items.forEach((row,i)=>{starts.push(lines.length);lines.push(...wrap(`${i===this.selected?'›':' '} #${row.seq} ${row.kind}\n  ${row.id}`));});
    }else lines.push(...wrap(this.content));
    const chosen=starts[this.selected];if(this.followSelection&&chosen!==undefined){if(chosen<this.line)this.line=chosen;else if(chosen>=this.line+height-2)this.line=Math.max(0,chosen-height+3);}this.followSelection=false;
    this.line=Math.min(this.line,Math.max(0,lines.length-height+1));
    return [...lines.slice(this.line,this.line+Math.max(1,height-1)),truncateToWidth(this.mode==='runs'?'↑↓选择 Enter记录 n/p翻页 Esc关闭':this.mode==='records'?'Enter原文 t尝试 u用量 n/p翻页 b上层 Esc关闭':'PgUp/PgDn滚动 n/p原文片 d脱敏 b记录 Esc关闭',width)];
  }
}
