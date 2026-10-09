import {matchesKey,stripTerminalSequences,wrapTextWithAnsi,truncateToWidth} from '@earendil-works/pi-tui';
import {readImproveReport,type ImproveReport} from '../improve.js';
import {previewImproveDecision,type ImproveDecision,type ImproveMode} from '../improve-decisions.js';

/** A local unselected draft. Only a rendered aggregate followed by Enter calls
 * the shared host submission API supplied by the application's lifecycle. */
export class ImproveSelectionView {
 private report:ImproveReport;private selected=0;private line=0;private modes=new Map<string,ImproveMode>();
 private stage:'select'|'summary'|'result'='select';private shown=false;private busy=false;private message='';private prepared?:ImproveDecision;
 constructor(private root:string,private template:ImproveDecision,private submit:(d:ImproveDecision)=>Promise<unknown>,private changed:()=>void=()=>{}){
  const report=readImproveReport(root,template.reportId).report;if(!report||report.revision!==template.reportRevision)throw Error('IMPROVE_REPORT_REVISION_DRIFT');this.report=report;
  // template supplies declared content/checks, never preselects its candidates.
 }
 get inProgress(){return this.busy;}
 draft():ImproveDecision {
  const selections=this.report!.candidates.filter(c=>this.modes.has(c.id)).map(c=>({candidateId:c.id,candidateRevision:c.revision,target:c.target,mode:this.modes.get(c.id)!,steps:c.steps}));
  const active=new Set(selections.filter(s=>s.mode==='validate-only').map(s=>s.candidateId));
  return {id:this.template.id,reportId:this.report!.id,reportRevision:this.report!.revision,selections,groups:this.template.groups.filter(g=>g.candidateIds.some(id=>active.has(id))),limits:structuredClone(this.template.limits),...(this.template.directory?{directory:this.template.directory}:{})};
 }
 scroll(delta:number){this.line=Math.max(0,this.line+delta);this.changed();}
 async handleInput(data:string){
  if(this.busy)return;
  if(matchesKey(data,'pageDown'))this.line+=8;if(matchesKey(data,'pageUp'))this.line=Math.max(0,this.line-8);
  if(data==='b'&&this.stage==='summary'){this.stage='select';this.shown=false;this.prepared=undefined;this.message='';this.line=0;}
  if(this.stage==='select'){
   if(matchesKey(data,'up'))this.selected=Math.max(0,this.selected-1);if(matchesKey(data,'down'))this.selected=Math.min(this.report!.candidates.length-1,this.selected+1);
   const c=this.report!.candidates[this.selected],mode=({v:'validate-only',d:'defer',n:'do-not-suggest',e:'execute-declared-scope'} as const)[data as 'v'|'d'|'n'|'e'];
   if(c&&mode){this.modes.set(c.id,mode);this.message='';}if(c&&data==='0')this.modes.delete(c.id);
   if(data==='s')try{const d=this.draft(),preview=previewImproveDecision(this.root,d);this.prepared=d;this.message=JSON.stringify(preview,null,2);this.stage='summary';this.shown=false;this.line=0;}catch(error){this.message=String(error);}
  }else if(this.stage==='summary'&&this.shown&&matchesKey(data,'enter')&&this.prepared){
   const d=this.prepared;this.busy=true;this.stage='result';this.message='正在保存明确决定并执行其受限验证…';this.changed();
   try{this.message=JSON.stringify(await this.submit(d),null,2);}catch(error){this.message=String(error);}finally{this.busy=false;this.line=0;}
  }
  this.changed();
 }
 render(width:number,height:number){
  if(this.stage==='summary')this.shown=true;
  const head=`improve 结构化选择 · ${this.report!.id}\n默认不选；正式执行未支持；查看/普通文本不会提交`;
  const body=this.stage==='select'?this.report!.candidates.map((c,i)=>`${i===this.selected?'›':' '} ${c.display} [${this.modes.get(c.id)??'unselected'}] ${c.title}\n目标 ${c.target.workspace}; scope ${c.scope.join(', ')}\n依赖 ${c.dependencies.join(', ')||'none'} / 冲突 ${c.conflicts.join(', ')||'none'}\n${c.validation.method}: ${c.validation.checks.join('; ')}`).join('\n'):'';
  const lines=wrapTextWithAnsi(stripTerminalSequences(`${head}\n${body}\n${this.message}`).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'),Math.max(1,width-2));
  this.line=Math.min(this.line,Math.max(0,lines.length-height+1));
  return [...lines.slice(this.line,this.line+Math.max(1,height-1)),truncateToWidth(this.stage==='summary'?'Enter 一次明确提交 / b调整 / PgUp/PgDn核对完整计划':this.stage==='select'?'↑↓逐项 v仅验证 d暂缓 n不再建议 0取消 e执行未支持 s汇总':'PgUp/PgDn结果；Esc返回；重开不会再次执行',width)];
 }
}
