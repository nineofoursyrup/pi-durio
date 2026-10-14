import { randomUUID } from 'node:crypto';
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { storageUsage, previewCleanup, commitCleanup, type CleanupPlan } from '../storage.js';

/** An independent management view. It cannot submit work, change execution targets, or compact. */
export class StorageView {
  private usage?:Awaited<ReturnType<typeof storageUsage>>;
  private selected=0;
  private after=0;
  private previous:number[]=[];
  private line=0;
  private busy=false;
  private text='读取占用…';
  private mode:'usage'|'preview'|'result'='usage';
  private preview?:{plan:CleanupPlan;identity:string};
  private previewShown=false;
  readonly ready:Promise<void>;
  get inProgress(){return this.busy;}
  constructor(private root:string,private changed:()=>void=()=>{}){this.ready=this.refresh();}
  private async refresh(){this.busy=true;try{this.usage=await storageUsage(this.root,{after:this.after,limit:8});this.mode='usage';this.text='';this.selected=0;this.line=0;}catch(error){this.text=String(error);}finally{this.busy=false;this.changed();}}
  async handleInput(data:string) {
    if(this.busy)return;
    if(matchesKey(data,'pageUp'))this.line=Math.max(0,this.line-5);
    if(matchesKey(data,'pageDown'))this.line+=5;
    if(data==='b'){this.preview=undefined;await this.refresh();return;}
    if(this.mode==='usage') {
      if(matchesKey(data,'up'))this.selected=Math.max(0,this.selected-1);
      if(matchesKey(data,'down'))this.selected=Math.min((this.usage?.units.length??1)-1,this.selected+1);
      if(data==='n'&&this.usage?.next!==null&&this.usage?.next!==undefined){this.previous.push(this.after);this.after=this.usage.next;await this.refresh();return;}
      if(data==='p'&&this.previous.length){this.after=this.previous.pop()!;await this.refresh();return;}
      if(data==='c'&&this.usage?.units[this.selected]) {
        this.busy=true;try{this.preview=await previewCleanup(this.root,{id:`tui-${randomUUID()}`,units:[this.usage.units[this.selected].id],reason:'explicit TUI selection'});this.mode='preview';this.previewShown=false;this.line=0;this.text=JSON.stringify({operationId:this.preview.plan.id,bytes:this.preview.plan.bytes,loss:this.preview.plan.loss,eligible:this.preview.plan.units,protected:this.preview.plan.blocked},null,2);}
        catch(error){this.text=String(error);this.mode='result';}finally{this.busy=false;}
      }
    } else if(this.mode==='preview'&&this.previewShown&&matchesKey(data,'enter')&&this.preview?.plan.units.length) {
      // Enter has an effect only after a separately rendered immutable cleanup preview.
      this.busy=true;const confirmation=this.preview;this.mode='result';this.text='清理提交中；保留各部分结果…';this.changed();
      try {this.text=JSON.stringify(await commitCleanup(this.root,{id:confirmation.plan.id,identity:confirmation.identity}),null,2);}
      catch(error){this.text=String(error);}finally{this.busy=false;this.line=0;}
    }
    this.changed();
  }
  scroll(delta:number){this.line=Math.max(0,this.line+delta);}
  render(width:number,height:number) {
    if(this.mode==='preview')this.previewShown=true;
    const wrap=(text:string)=>wrapTextWithAnsi(stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'),Math.max(1,width-2));
    const header=wrap(`存储管理 · ${this.busy?'处理中':'独立显式操作'}\n不自动过期；上下文压缩不删除历史`),lines:string[]=[];const starts:number[]=[];
    if(this.mode==='usage'&&this.usage){lines.push(...wrap(JSON.stringify(this.usage.totals)));this.usage.units.forEach((unit,index)=>{starts.push(lines.length);lines.push(...wrap(`${index===this.selected?'›':' '} ${unit.id}\n  ${unit.bytes} bytes · c 预览实际保护与范围`));});if(!this.usage.units.length)lines.push(...wrap('没有可列出的单元。宿主事实正文永久保留。'));}
    lines.push(...wrap(this.text));
    const bodyHeight=Math.max(1,height-3),selected=starts[this.selected];if(this.mode==='usage'&&selected!==undefined){if(selected<this.line)this.line=selected;else if(selected>=this.line+bodyHeight)this.line=Math.max(0,selected-bodyHeight+1);}
    this.line=Math.min(this.line,Math.max(0,lines.length-bodyHeight));
    return [...header.slice(0,2),...lines.slice(this.line,this.line+bodyHeight),truncateToWidth(this.mode==='preview'?'Enter 明确提交删除 / b取消 / PgDn范围 / Esc关闭':this.mode==='usage'?'↑↓选单元 c预览 n/p翻页 Esc关闭':'PgUp/PgDn结果 b占用 Esc关闭',width)];
  }
}
