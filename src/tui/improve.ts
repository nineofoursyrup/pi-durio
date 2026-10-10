import {matchesKey,stripTerminalSequences,wrapTextWithAnsi,truncateToWidth} from '@earendil-works/pi-tui';
import {listImproveReports,readImproveReport,formatImproveReport} from '../improve.js';
import {listImproveSuppressions} from '../improve-history.js';
/** Report viewer has no runtime, provider, selection or write capability. */
export class ImproveView {
 private page:ReturnType<typeof listImproveReports>;private after=0;private previous:number[]=[];private selected=0;private line=0;private content:string|null=null;
 constructor(private root:string,id?:string,suppressions=false){this.page=listImproveReports(root,{limit:10});if(suppressions)this.content=JSON.stringify(listImproveSuppressions(root),null,2);else if(id)this.content=formatImproveReport(readImproveReport(root,id));}
 scroll(delta:number){this.line=Math.max(0,this.line+delta);}
 handleInput(data:string){if(data==='b'){this.content=null;this.line=0;return;}if(this.content){if(matchesKey(data,'down'))this.line++;if(matchesKey(data,'up'))this.line=Math.max(0,this.line-1);if(matchesKey(data,'pageDown'))this.line+=10;if(matchesKey(data,'pageUp'))this.line=Math.max(0,this.line-10);return;}
  if(matchesKey(data,'up'))this.selected=Math.max(0,this.selected-1);if(matchesKey(data,'down'))this.selected=Math.min(this.page.items.length-1,this.selected+1);
  if(data==='n'&&this.page.next!==null){this.previous.push(this.after);this.after=this.page.next;this.page=listImproveReports(this.root,{after:this.after,limit:10});this.selected=0;this.line=0;}
  if(data==='p'&&this.previous.length){this.after=this.previous.pop()!;this.page=listImproveReports(this.root,{after:this.after,limit:10});this.selected=0;this.line=0;}
  if(matchesKey(data,'enter')&&this.page.items[this.selected]){this.content=formatImproveReport(readImproveReport(this.root,this.page.items[this.selected].id));this.line=0;}
 }
 render(width:number,height:number){const text=this.content??(this.page.items.map((item,i)=>`${i===this.selected?'›':' '} ${item.id}\n${item.target.workspace}\nrun ${item.runId}`).join('\n')||'暂无分析报告；/queue 查看待执行、冻结或撤回的请求');
  const lines=wrapTextWithAnsi(stripTerminalSequences(`improve · 只读报告 · 默认未选择\n${text}`).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'),Math.max(1,width-2));const count=Math.max(1,height-1);if(!this.content)this.line=Math.max(0,this.selected*3-count+4);this.line=Math.min(this.line,Math.max(0,lines.length-count));return [...lines.slice(this.line,this.line+count),truncateToWidth('↑↓选择/滚动 Enter查看 n/p分页 b上层 Esc返回；查看不执行/调用/计量',width)];}
}
