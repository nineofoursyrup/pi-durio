import { readCompactions } from '../compaction.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Container, Editor, MouseRegion, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, isKeyRelease, isKeyRepeat, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type AutocompleteProvider, type Terminal } from '@earendil-works/pi-tui';
import { runReadTask, runCodingTask, compactContext, TaskControl, readQueue, decideQueue, checkRecovery, recoverRun, type CodingTaskOptions, type RunResult, type ToolEnvironmentConfig, type RecoveryReport, type RecoveryDecision, type RecoveryAuthorization, type QueueDecision } from '../runtime.js';
import type { QueueItemFact } from '../evidence.js';
import { readRunRecords, readObjectRange, readTextPage, type RecordReference } from '../query.js';
import { Drafts } from './drafts.js';
import { MetricsView } from './metrics.js';
import { recordAcceptance } from '../metrics/index.js';
import { HistoryView } from './history.js';
import { EvalView } from './eval.js';
import { StorageView } from './storage.js';
import { HardwareCursorEditor, hideCursorDuringPaint } from './cursor.js';
import { TerminalWidthGate } from './width-gate.js';

const identity=(s:string)=>s;
const theme={borderColor:identity, selectList:{selectedPrefix:identity,selectedText:identity,description:identity,scrollInfo:identity,noMatch:identity}};
const commands=[['help','帮助'],['exit','退出并保留草稿'],['restore','恢复草稿（不执行）'],['bottom','回到底部'],['older','上一窗口'],['newer','下一窗口'],['details','查看原文详情'],['history','查询历史（只读）'],['metrics','任务验收与双时钟（只读）'],['storage','存储占用与显式清理'],['copy','复制选文或最新可见输出'],['stop','中止实际运行任务'],['queue','队列与原目标'],['recover','恢复核对当前任务'],['follow-up','将输入排到下一任务'],['compact','压缩当前上下文（原文保留）'],['compactions','查看摘要生成与接入事实']] as const;
const visibleKinds=['task.accepted','tool.intent','tool.result','tool.error','tool.summary','model.provider-event','model.response','run.abort-intent','run.exit-intent','run.closed','compaction.generated','compaction.finished'];
const completion:AutocompleteProvider={
  triggerCharacters:['/'],
  async getSuggestions(lines,line,col) {
    const prefix=lines[line]?.slice(0,col)??'';
    if(!/^\/[a-z]*$/.test(prefix)) return null;
    return {prefix,items:commands.filter(([name])=>`/${name}`.startsWith(prefix)).map(([name,description])=>({value:`/${name}`,label:`/${name}`,description}))};
  },
  applyCompletion(lines,line,col,item,prefix) { const next=[...lines]; next[line]=`${lines[line].slice(0,col-prefix.length)}${item.value}${lines[line].slice(col)}`; return {lines:next,cursorLine:line,cursorCol:col-prefix.length+item.value.length}; }
};
function safe(text:string) { return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'); }
function label(result?:RunResult) { return result ? ({completed:'已完成',failed:'失败',aborted:'已中止',unknown:'结果未知；需恢复核对'}[result.status]) : '等待输入'; }
export interface TuiOptions {
  workspace:string; dataRoot:string; mode:'live'|'offline'; transport?:typeof fetch;
  coding?:boolean;toolEnvironment?:ToolEnvironmentConfig;runId?:string;
  terminal?:Terminal; draftRoot?:string; copy?:(text:string)=>Promise<boolean|string>;
  /** Only deterministic injected-terminal tests may skip native measurement. */
  widthCalibration?:false;
}
export interface TuiExit { result?:RunResult; error?:string; draftSaved:boolean; widthCalibration?:ReturnType<TerminalWidthGate['snapshot']>; }

/** macOS clipboard adapter: exit code acknowledges the actual clipboard write. No shell or OSC 52 fallback. */
export async function copyToMacClipboard(text:string):Promise<boolean|string> {
  if(process.platform!=='darwin') return '复制只支持已声明的 macOS 目标';
  return new Promise(resolveCopy=>{
    const child=spawn('/usr/bin/pbcopy',[],{stdio:['pipe','ignore','ignore'],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
    child.once('error',error=>resolveCopy(`复制失败：${error.message}`));
    child.once('close',code=>resolveCopy(code===0 ? true : `pbcopy 退出 ${code}`));
    child.stdin.on('error',()=>{}); child.stdin.end(text);
  });
}

/** Product UI owns presentation/drafts. Execution and decisions use the shared checked host boundary. */
export class ReadOnlyTui {
  readonly closed:Promise<TuiExit>;
  private resolveClosed!:(result:TuiExit)=>void;
  private readonly terminal:Terminal;
  private readonly tui:TuiAltScreen;
  private readonly editor:Editor;
  private readonly transcript=new Container();
  private readonly scroll:ScrollView;
  private readonly drafts:Drafts;
  private readonly copy:(text:string)=>Promise<boolean|string>;
  private records:RecordReference[]=[];
  private summaries=new Map<number,string>();
  private latestText='';
  private runId?:string;
  private sessionId?:string;
  private model='DeepSeek / deepseek-flash（尚未受理）';
  private result?:RunResult;
  private active?:Promise<void>;
  private controller?:AbortController;
  private cancellation:'stop'|'exit'='exit';
  private readonly control=new TaskControl();
  private queue:QueueItemFact[]=[];
  private queueAfter?:number;
  private queuePrevious:Array<number|undefined>=[];
  private queueNext:number|null=null;
  private recovery?:RecoveryReport;
  private viewingRecovery=false;
  private phase:'idle'|'running'|'stopping'|'exiting'='idle';
  private notice='Enter 新任务；忙时 Enter 补充当前任务；Ctrl+X → Enter 排后续请求';
  private savedDraft?:string;
  private lastText='';
  private confirmation?:{key:string;at:number};
  private followChord=false;
  private panel?:{kind:'help'|'exit'|'detail'|'actions'|'queue'|'recovery'|'history'|'eval'|'storage'|'compaction'|'metrics';ref?:RecordReference;offset:number;previous:number[];line:number;raw:string;next:number|null;error?:string};
  private historyView?:HistoryView;
  private metricsView?:MetricsView;
  private evalView?:EvalView;
  private storageView?:StorageView;
  private hidePanel?:()=>void;
  private pendingRefresh=false;
  private timer?:ReturnType<typeof setInterval>;
  private started=false;
  private stopped=false;
  private exiting?:Promise<TuiExit>;
  private failure?:string;
  private historyWindow=false;
  private removeInput?:()=>void;
  private restoreTerminalWrite?:()=>void;
  private removeSignals:Array<()=>void>=[];
  private widths?:TerminalWidthGate;
  private displaySources:string[]=[];

  constructor(private readonly options:TuiOptions) {
    if(options.widthCalibration===false&&!options.terminal)throw Error('WIDTH_CALIBRATION_TEST_TERMINAL_REQUIRED');
    options.workspace=realpathSync(options.workspace);
    options.dataRoot=resolve(options.dataRoot);
    this.runId=options.runId;this.viewingRecovery=!!options.runId;
    this.terminal=options.terminal??new ProcessTerminal();
    this.copy=options.copy??copyToMacClipboard;
    this.drafts=new Drafts(options.draftRoot??join(homedir(),'Library','Application Support','pi-durio','ui-drafts'),options.workspace,options.dataRoot);
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve;});
    this.tui=new TuiAltScreen(this.terminal,true,undefined,{copySelection:this.copy,copyOnSelect:true,scrollToEndIndicator:()=> ' ↓ 回到底部 · /bottom '});
    this.editor=new HardwareCursorEditor(this.tui,theme,{autocompleteMaxVisible:2});
    this.editor.setAutocompleteProvider(completion);
    this.editor.onChange=()=>{
      const text=this.editor.getExpandedText();
      this.confirmation=undefined;
      if(Buffer.byteLength(text)>32768) { this.editor.setText(this.lastText); this.notice='输入超过 32 KiB；本次编辑未接入'; }
      else this.lastText=text;
      this.tui.requestRender();
    };
    this.editor.onSubmit=text=>this.submit(text);
    this.scroll=new ScrollView(this.transcript,{follow:'end',primary:true});
    const header:Component={invalidate(){},render:width=>[
      truncateToWidth(`pi-durio · [F2 菜单] · ${options.coding?'coding':'只读'} · ${safe(options.workspace)}`,width),
      truncateToWidth(`session ${this.sessionId?this.sessionId.slice(0,8)+'…':'未受理'} · ${this.model}`,width)
    ]};
    const status:Component={invalidate(){},render:width=>[
      truncateToWidth(`${this.status()} · usage ${this.usage()}`,width),
      truncateToWidth(this.notice,width),
      truncateToWidth(`${this.scroll.isFollowingEnd&&!this.historyWindow?'跟随':'已暂停跟随 /bottom'} · /help · Ctrl+O 详情 · Ctrl+C 中止/退出`,width)
    ]};
    const footer=new MouseRegion(status,event=>{if(event.type==='click'&&event.y===2) {this.bottom();return {handled:true};}});
    const menuHeader=new MouseRegion(header,event=>{if(event.type==='click'&&event.y===0){this.openPanel('actions');return {handled:true};}});
    const layout=new VStack([{component:menuHeader,basis:2},{component:this.scroll,basis:0,grow:1,minSize:1},{component:this.editor,basis:'auto',shrink:1,minSize:3,maxSize:6},{component:footer,basis:3}]);
    const root:Component={invalidate:()=>layout.invalidate(),render:width=>{
      if(width<40 || this.terminal.rows<12) return new Text(`窗口过小：建议至少 40 × 12 字符格（待真实终端确认）\n当前 ${width} × ${this.terminal.rows}\n扩大窗口继续；Ctrl+C 中止/再次退出。草稿保留。`,0,0).render(width).slice(0,this.terminal.rows);
      return layout.render(width);
    }};
    // Preserve upstream layout-node behavior by selecting the appropriate layout on resize.
    const resizeLayout=()=>this.tui.setLayoutRoot(this.terminal.columns<40||this.terminal.rows<12?root:layout);
    const originalStart=this.terminal.start.bind(this.terminal);
    this.terminal.start=(input,resize)=>originalStart(data=>{
      // Query replies are not user actions and must not revoke the confirmation they helped paint.
      if(this.widths?.consumeTerminalReply(data))return;
      // Runs before pi-tui's own viewport listener, which consumes mouse/focus/page keys.
      if(!isKeyRelease(data)&&!matchesKey(data,'ctrl+c')&&!matchesKey(data,'ctrl+d')) this.confirmation=undefined;
      if(!isKeyRelease(data)&&!matchesKey(data,'ctrl+x')&&!matchesKey(data,'enter'))this.followChord=false;
      input(data);
    },()=>{this.confirmation=undefined;resizeLayout();resize();});
    resizeLayout();
    this.rebuild();
    this.tui.setFocus(this.editor);
  }
  start() {
    if(this.started) return;
    if(!this.options.terminal && (!process.stdin.isTTY||!process.stdout.isTTY)) throw new Error('TUI_REQUIRES_TERMINAL: use pi-durio show for headless viewing');
    this.started=true;
    this.removeInput=this.tui.addInputListener(data=>{try{return this.input(data);}catch(error){this.notice=`操作失败：${safe(String(error))}`;this.tui.requestRender();return {consume:true};}});
    for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const) {
      const handler=()=>signal==='SIGINT'&&this.phase==='running'?this.stop():void this.exit();
      process.on(signal,handler); this.removeSignals.push(()=>process.off(signal,handler));
    }
    const fault=(error:Error)=>{this.failure=String(error);void this.exit();};
    process.on('uncaughtException',fault); this.removeSignals.push(()=>process.off('uncaughtException',fault));
    const rejection=(reason:unknown)=>fault(reason instanceof Error?reason:new Error(String(reason)));
    process.on('unhandledRejection',rejection); this.removeSignals.push(()=>process.off('unhandledRejection',rejection));
    this.restoreTerminalWrite=hideCursorDuringPaint(this.terminal);
    if(this.options.widthCalibration!==false)this.widths=new TerminalWidthGate({terminal:this.terminal,tui:this.tui,
      sources:()=>[this.editor.getExpandedText(),this.options.workspace,this.model,this.notice,...this.displaySources],
      priorityInput:data=>{
        // Preserve the normal modal/focus order. A nonempty Ctrl+D is still editor deletion.
        if(!isKeyRelease(data)&&!matchesKey(data,'ctrl+c')&&!matchesKey(data,'ctrl+d')&&!matchesKey(data,'escape')&&!matchesKey(data,'ctrl+l')&&data!=='\x1b[I'&&data!=='\x1b[O')return false;
        return this.input(data)?.consume===true;
      },
      context:()=>JSON.stringify({phase:this.phase,run:this.runId??null,panel:this.panel?.kind??null,editorFocused:this.editor.focused,overlay:this.tui.hasOverlay(),completion:this.editor.isShowingAutocomplete()}),
      ready:()=>{if(this.pendingRefresh)this.refresh();},
      retain:(inputs,reason)=>{this.drafts.savePending(inputs,reason);this.notice='显示更新期间的部分输入未应用，已保留；请确认当前画面后重新操作';}
    });
    this.tui.start();
    // Claim the query hold before the first calibration can start. Recovery verifies
    // installed bytes synchronously; a valid terminal reply must not queue behind it.
    if(this.runId){this.pendingRefresh=true;void this.openRecovery(this.runId);}
    this.widths?.inspect();
    this.terminal.write('\x1b[?1004h'); // Focus reports invalidate any pending exit confirmation.
    this.timer=setInterval(()=>{if(this.pendingRefresh) this.refresh();},75);
    this.loadQueue();
    this.tui.requestRender();
  }
  /** Visible frame for diagnostics/tests; no runtime internals or writable handles. */
  screen() { this.tui.renderNow(); return this.tui.getScreenLines(); }
  private status() {return this.phase==='running'?`运行中 ${this.control.target()?.runId.slice(0,8)??'受理中'}`:this.phase==='stopping'?'中止中（等待实际清理）':this.phase==='exiting'?'退出中（等待实际清理）':this.viewingRecovery?'恢复核对（只读）':label(this.result);}
  private usage() {
    if(!this.result) return 'unknown';
    const usage=this.result.usage;
    const model=usage.value?.models['deepseek/deepseek-flash'];
    return `${usage.completeness}${model?` · in ${model.input} out ${model.output} · $${model.cost.total.toFixed(6)}估算`:''}`;
  }
  private input(data:string) {
    const ctrlC=matchesKey(data,'ctrl+c'),ctrlD=matchesKey(data,'ctrl+d');
    if(isKeyRelease(data)||((ctrlC||ctrlD)&&isKeyRepeat(data)))return {consume:true};
    if(!ctrlC&&!ctrlD) this.confirmation=undefined;
    if(data==='\x1b[I'||data==='\x1b[O') {this.confirmation=undefined;return {consume:true};}
    if(this.panel) {this.panelInput(data);return {consume:true};}
    if(this.tui.hasOverlay()) return undefined;
    if(this.editor.isShowingAutocomplete()) {
      this.confirmation=undefined;
      // Candidate menus own Enter/Esc/Ctrl+C/D; no outer cancellation/exit can leak through.
      if(ctrlC||ctrlD) this.editor.handleInput('\x1b');
      else this.editor.handleInput(data);
      this.tui.requestRender(); return {consume:true};
    }
    if(this.followChord&&matchesKey(data,'enter')){this.followChord=false;this.submit(this.editor.getExpandedText(),true);return {consume:true};}
    if(matchesKey(data,'ctrl+l')) {if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return {consume:true};}
    if(matchesKey(data,'f2')) {this.openPanel('actions');return {consume:true};}
    if(matchesKey(data,'ctrl+o')) {this.openDetail(this.records.at(-1));return {consume:true};}
    if(matchesKey(data,'ctrl+x')) {this.followChord=this.editor.focused;this.notice='按 Enter 明确排到下一任务；普通 Enter 默认补充当前任务';this.tui.requestRender();return {consume:true};}
    if(matchesKey(data,'escape')) {if(this.phase==='running')this.stop();return {consume:true};}
    if(ctrlC||ctrlD) {
      const key=ctrlC?'ctrl+c':'ctrl+d';
      if(this.phase==='stopping'||this.phase==='exiting') return {consume:true};
      if(ctrlC&&this.phase==='running') {this.stop();return {consume:true};}
      if(!this.editor.focused) {this.confirmation=undefined;return {consume:true};}
      if(ctrlD&&this.editor.getExpandedText()) {this.confirmation=undefined;return;}
      // Ctrl+D during a request still asks for controlled exit; it never drops the runtime.
      if(this.confirmation?.key===key && Date.now()-this.confirmation.at<=800) {this.confirmation=undefined;void this.exit();return {consume:true};}
      if(ctrlC) {
        this.widths?.retainPending('ctrl-c-preserve-unapplied-input');
        const text=this.editor.getExpandedText();
        if(text) {this.drafts.save(text);this.savedDraft=text;this.editor.setText('');this.lastText='';}
        this.notice='草稿已保留；/restore 恢复。800ms 内再按 Ctrl+C 退出';
      } else this.notice='800ms 内再按 Ctrl+D 退出；其他按键取消确认';
      this.confirmation={key,at:Date.now()};this.tui.requestRender();return {consume:true};
    }
    return undefined;
  }
  private submit(text:string,followUp=false) {
    this.confirmation=undefined;
    const command=text.trim();
    if(command.startsWith('/')) {
      // Editor clears on submit; restore previous draft for command actions where available.
      this.editor.setText('');this.lastText='';
      if(!this.command(command)) {this.editor.setText(text);this.lastText=text;this.notice='未知或尚未接入的命令；没有调用模型。/help 查看当前入口';}
      this.tui.requestRender(); return;
    }
    if(!text.trim())return;
    if(this.historyWindow||this.viewingRecovery){this.editor.setText(text);this.lastText=text;this.notice='只读历史/恢复视图不能提交；/bottom 返回活动会话，恢复限制仍需显式处置';this.tui.requestRender();return;}
    if(this.phase==='running') {this.enqueue(text,followUp?'follow-up':'steer');return;}
    if(this.phase!=='idle') {this.editor.setText(text);this.lastText=text;this.notice='当前正在清理；草稿保留，未受理';this.tui.requestRender();return;}
    if(followUp){this.editor.setText(text);this.lastText=text;this.notice='当前没有运行任务；文本保留，按普通 Enter 明确提交新任务';this.tui.requestRender();return;}
    if(this.result?.status==='unknown'||this.result?.cleanup==='unknown') {this.editor.setText(text);this.lastText=text;this.notice='旧工作存在未知；只读查看，不能由 TUI 绕过恢复核对';this.tui.requestRender();return;}
    const contextRunId=this.result?.status==='completed'&&this.result.cleanup==='confirmed'?this.result.runId:undefined;
    this.editor.addToHistory(text);this.editor.setText('');this.lastText='';
    this.phase='running';this.result=undefined;this.runId=undefined;this.sessionId=undefined;this.records=[];this.summaries.clear();this.historyWindow=false;this.scroll.scrollToEnd();
    this.confirmation=undefined;this.controller=new AbortController();this.cancellation='exit';this.notice='任务正在受理；忙时 Enter 补充当前任务，Ctrl+X → Enter 后续请求';this.rebuild();
    const self=this;
    const options:CodingTaskOptions={contextRunId,workspace:this.options.workspace,dataRoot:this.options.dataRoot,input:text,mode:this.options.mode,toolEnvironment:this.options.toolEnvironment,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}};
    const run=this.options.coding?runCodingTask:runReadTask;
    this.active=run(options).then(result=>this.applyResult(result)).catch(error=>{this.failure=String(error);this.notice=`未完成：${safe(String(error))}`;}).finally(()=>this.finished());
    this.tui.requestRender();
  }
  private command(command:string) {
    if(command==='/help') this.openPanel('help');
    else if(command==='/exit') this.requestExit();
    else if(command==='/restore') {this.editor.setText(this.savedDraft??this.drafts.latest()??'');this.lastText=this.editor.getExpandedText();this.notice='草稿已恢复；尚未提交';}
    else if(command==='/bottom')this.bottom();
    else if(command==='/older')this.window('older');
    else if(command==='/newer')this.window('newer');
    else if(command==='/metrics'||command.startsWith('/metrics ')){
      try{this.metricsView=new MetricsView(this.options.dataRoot,command==='/metrics'?{}:JSON.parse(command.slice(9)));this.openPanel('metrics');}catch(error){this.notice=`任务指标不可读取：${String(error)}`;this.tui.requestRender();}
    }
    else if(command.startsWith('/acceptance ')){
      try{const receipt=recordAcceptance(this.options.dataRoot,JSON.parse(command.slice(12)));this.notice=`验收记录已追加：${receipt.source}`;}catch(error){this.notice=`验收输入未记录：${String(error)}`;}this.tui.requestRender();
    }
    else if(command==='/eval'||command.startsWith('/eval ')){
      try{this.evalView=new EvalView(this.options.dataRoot,command.slice(6).trim()||undefined);this.openPanel('eval');}catch(error){this.notice=`Eval记录不可读取：${String(error)}`;this.tui.requestRender();}
    }
    else if(command==='/storage') {this.storageView=new StorageView(this.options.dataRoot,()=>this.tui.requestRender());this.openPanel('storage');}
    else if(command==='/history'||command.startsWith('/history ')) {
      try{this.historyView=new HistoryView(this.options.dataRoot,command==='/history'?{}:JSON.parse(command.slice(9)));this.openPanel('history');}
      catch(error){this.notice=`历史查询失败（当前工作未改变）：${safe(String(error))}`;this.tui.requestRender();}
    }
    else if(command==='/details')this.openDetail(this.records.at(-1));
    else if(command==='/copy')void this.copyOutput();
    else if(command==='/stop')this.stop();
    else if(command==='/queue'){this.loadQueue();this.openPanel('queue');}
    else if(command==='/recover'||command.startsWith('/recover ')){const run=command.slice(9).trim()||this.runId;if(run)void this.openRecovery(run);else this.notice='暂无需核对的 run';}
    else if(command==='/follow-up'){const draft=this.editor.getExpandedText();if(draft)this.submit(draft,true);else this.notice='输入后按 Ctrl+X → Enter，明确排到下一任务';}
    else if(command.startsWith('/withdraw '))void this.queueDecision(command.slice(10).trim(),'withdraw');
    else if(command.startsWith('/reattach '))void this.queueDecision(command.slice(10).trim(),'reattach');
    else if(command.startsWith('/decide ')){try{void this.recoveryDecision(JSON.parse(command.slice(8)));}catch(error){this.notice=`决定 JSON 无效：${String(error)}`;}}
    else if(command==='/compact')void this.compact();
    else if(command==='/compactions')this.openPanel('compaction');
    else if(command==='/improve'){if(this.phase==='running'&&!this.historyWindow&&!this.viewingRecovery)this.enqueue(command.slice(1),command.slice(1) as 'compact'|'improve');else this.notice='管理请求须绑定活动任务；历史或恢复视图不能执行';}
    else return false;
    return true;
  }
  private async compact() {
    if(this.historyWindow||this.viewingRecovery){this.notice='只读历史/恢复视图不能压缩；先返回活动会话并完成恢复核对';this.tui.requestRender();return;}
    if(this.phase==='running'){this.enqueue('compact','compact');return;}
    if(this.phase!=='idle'||this.result?.status!=='completed'||this.result.cleanup!=='confirmed'){this.notice='压缩需要已完成且清理确认的活动会话';this.tui.requestRender();return;}
    const runId=this.result.runId;this.controller=new AbortController();this.cancellation='exit';this.phase='running';this.notice='正在压缩当前上下文；原文保留，摘要生成与接入分别记录';const self=this;
    this.active=compactContext({dataRoot:this.options.dataRoot,runId,requestId:randomUUID(),authorization:this.authorization(),transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onObservation:()=>{this.pendingRefresh=true;}}).then(result=>{
      this.result=result;this.viewingRecovery=result.status!=='completed'||result.cleanup!=='confirmed';this.notice=`上下文压缩 ${result.compaction?.state??result.status}；/compactions 查看源范围、摘要与接入事实；磁盘原文保留`;
    }).catch(error=>{this.notice=`压缩未执行：${safe(String(error))}`;}).finally(()=>this.finished());
    this.tui.requestRender();await this.active;
  }
  private compactionText() {
    if(!this.runId)return '暂无活动会话；未调用模型';
    try {const page=readCompactions(this.options.dataRoot,this.runId,{after:this.panel?.offset,limit:20});if(this.panel)this.panel.next=page.next;
      return `上下文压缩 · run ${this.runId}\n原文始终保留；token 变化不代表磁盘释放\n`+page.items.map(item=>{const d=item.data as any;return `${item.seq} ${item.kind}\n${safe(JSON.stringify(item.kind==='compaction.source'?{taskId:d.taskId,trigger:d.trigger,firstKept:d.firstKept,sourceEntryIds:d.entries?.map((e:any)=>e.id)}:d).slice(0,3000))}`;}).join('\n')+'\n/queue 可撤回手动请求；c 取消最新压缩任务（已接入不能回滚）\nn/p 分页；摘要全文及请求/用量来源见原文详情';
    }catch(error){return `压缩事实不可取得：${safe(String(error))}`;}
  }
  private async cancelLatestCompaction(){
    const target=this.control.target();if(!target||!this.runId){this.notice='当前没有可取消的活动压缩；重开先恢复核对';return;}
    try{let after:number|undefined,taskId:number|undefined;do{const page=readCompactions(this.options.dataRoot,this.runId,{after,limit:200});for(const item of page.items)if(item.kind==='compaction.task')taskId=(item.data as any).taskId;after=page.next??undefined;}while(after);if(taskId===undefined)throw Error('尚无压缩任务；排队项请在 /queue 撤回');const result=await this.control.cancelCompaction({id:randomUUID(),taskId,target});this.notice=`取消结果 ${safe(JSON.stringify(result))}`;}catch(error){this.notice=`取消未执行：${safe(String(error))}`;}this.tui.requestRender();
  }
  private applyResult(result:RunResult) {
    this.result=result;this.sessionId=result.sessionId;this.runId=result.runId;
    this.viewingRecovery=result.status==='unknown'||result.cleanup==='unknown';
    this.notice=result.controls?'队列已冻结；/queue 查看目标与原因，普通输入不会接入旧项':result.cleanup==='confirmed'?`清理已确认；run ${result.runId}`:'清理未知；原工作保留，/recover 核对';
  }
  private finished() {
    this.pendingRefresh=true;this.refresh();if(this.phase!=='exiting')this.phase='idle';this.confirmation=undefined;this.followChord=false;this.tui.requestRender();
  }
  private enqueue(text:string,kind:'steer'|'follow-up'|'compact'|'improve') {
    const target=this.control.target();
    if(!target){this.editor.setText(text);this.lastText=text;this.notice='当前仍在受理或收尾；文字保留，未受理';this.tui.requestRender();return;}
    this.editor.addToHistory(text);this.editor.setText('');this.lastText='';
    void this.control.submit({id:randomUUID(),kind,input:text,target}).then(item=>{
      this.loadQueue();this.notice=`${kind} ${item.status==='applied'?'已接入':'已受理、待接入'} · ${item.requestId.slice(0,8)} → ${item.target.taskId.slice(0,8)} · /queue`;
    }).catch(error=>{
      this.drafts.save(text);this.savedDraft=text;if(!this.editor.getExpandedText()){this.editor.setText(text);this.lastText=text;}
      this.notice=`未接入，文本已保留：${safe(String(error))}`;
    }).finally(()=>this.tui.requestRender());
  }
  private loadQueue() {
    try {const page=readQueue(this.options.dataRoot,{after:this.queueAfter,limit:50});this.queue=page.items;this.queueNext=page.next;}
    catch(error){if(!String(error).includes('ENOENT'))this.notice=`队列事实不可取得：${safe(String(error))}`;}
  }
  private queueText() {
    const item=this.queue[this.panel?.offset??0];
    if(!item)return '队列：当前窗口没有受理项\nEsc 返回；不改变执行限制';
    const status={pending:'已受理、待接入',dispatching:'接入意图已保存、结果待核对',applied:'已接入，不能撤回已发生的操作',withdrawn:'已撤回',frozen:'已冻结，普通输入不会执行'}[item.status];
    return `队列 ${this.panel!.offset+1}/${this.queue.length} · ${item.kind}\n${item.requestId}\n${status}\n目标 ${item.target.workspace}\n原 session ${item.target.sessionId}\n原 task ${item.target.taskId}\n原 run ${item.target.runId}\n新 run ${item.kind==='follow-up'?(item.runId??'尚未开始'):item.runId??'无'}\n内容：${safe(item.input.slice(0,4096))}${item.input.length>4096?' [显示截断]':''}\n原因：${safe(item.reason)}\n←→/Tab 选项 n/p 窗口；w 撤回未接入项\nr 明确重新接入：仅已完成源的冻结 follow-up / 未执行 compact；重新执行可能收费\n旧 steer 或停止任务的文本需明确重新提交新任务\nEsc 返回，不解除冻结`;
  }
  private authorization():RecoveryAuthorization {return {workspace:this.options.workspace,mode:this.options.mode,tools:this.options.coding?['read','write','edit','bash']:['read'],toolEnvironment:this.options.toolEnvironment};}
  private async queueDecision(requestId:string,action:'withdraw'|'reattach') {
    this.loadQueue();const item=this.queue.find(item=>item.requestId===requestId);
    if(!item){this.notice='当前窗口没有该请求；/queue 核对完整 ID';return;}
    const decision:QueueDecision={id:randomUUID(),requestId,action,target:item.target,receiptSeq:item.receipt.seq};
    try {
      if(this.phase==='running') {
        if(action==='reattach')throw Error('当前工作运行中；不能重新接入冻结请求');
        const result=await this.control.withdraw(decision);this.notice=result.status==='withdrawn'?'撤回已提交':`未撤回：${result.status} · ${result.reason}`;
      } else {
        if(this.phase!=='idle')throw Error('正在清理，暂不接受决定');
        if(action==='reattach') {
          this.closePanel();this.phase='running';this.controller=new AbortController();this.cancellation='exit';
          const self=this;
          this.active=decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision,authorization:this.authorization(),transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}}).then(result=>{if('usage' in result)this.applyResult(result);else this.notice=`已保存状态 ${result.status}`;}).catch(error=>{this.notice=`重新接入受阻：${safe(String(error))}`;}).finally(()=>this.finished());
          return;
        }
        const result=await decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision});this.notice=result.status==='withdrawn'?'撤回已提交':`未撤回：${result.status}`;
      }
    }catch(error){this.notice=`队列决定未执行：${safe(String(error))}`;}
    finally{this.loadQueue();this.tui.requestRender();}
  }
  private async openRecovery(runId:string) {
    if(this.phase!=='idle'){this.notice=`正在执行 ${this.control.target()?.runId??this.runId}；先停止或退出后核对`;this.tui.requestRender();return;}
    this.viewingRecovery=true;this.runId=runId;
    const inspect=()=>checkRecovery({dataRoot:this.options.dataRoot,runId,authorization:this.authorization()});
    try {this.recovery=await (this.widths?this.widths.withoutQueries(inspect):inspect());if(this.stopped||this.exiting)return;this.pendingRefresh=true;this.refresh();this.openPanel('recovery');}
    catch(error){this.notice=`恢复核对受阻：${safe(String(error))}`;this.tui.requestRender();}
  }
  private recoveryText() {
    const report=this.recovery;if(!report)return '恢复事实暂不可取得；关闭面板不解除限制';
    const original=report.original as Partial<RunResult>;
    const template={id:'choose-a-new-decision-id',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true,resolutions:report.tools.filter(tool=>tool.fact==='unknown'&&!tool.resolution).map(tool=>({taskId:tool.taskId,choice:'CHOOSE retry/skip/completed',reason:'提供依据'}))};
    return `恢复核对 · ${report.status}\n工作 ${report.runId}\n原状态 ${original.status??'unknown'}；清理 ${original.cleanup??'unknown'}\n最后确认：${report.tools.filter(tool=>tool.fact==='committed').map(tool=>`tool ${tool.taskId}`).join(', ')||'无已确认工具结果'}\n未知模型 attempts：${report.unknownModelAttempts.length}\n${report.tools.map(tool=>`tool ${tool.taskId} ${tool.tool}: ${tool.fact}，证据 #${tool.evidence.join(',')||'缺失'}`).join('\n')}\n原因：${report.reasons.join('; ')||'需明确决定'}\n影响：${report.needsInput?.risks.join('\n')||'原事实保留，不重计量'}\n动作：${report.options.join(', ')}\ne 明确结束旧工作：不回滚、不宣称外部副作用未发生\nc 继续：仅全部工具无需未知处置时；可能新增模型费用\n有未知时 Esc 后 /decide ${JSON.stringify(template)}\n恢复与 headless 使用同一 snapshot/decision；Esc 仅返回查看`;
  }
  private async recoveryDecision(decision:RecoveryDecision) {
    if(this.phase!=='idle'||!this.recovery){this.notice='先 /recover 获取当前核对事实';return;}
    const runId=this.recovery.runId;this.closePanel();this.phase='running';this.controller=new AbortController();this.cancellation='exit';const self=this;
    this.active=recoverRun({dataRoot:this.options.dataRoot,runId,authorization:this.authorization(),decision,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}}).then(result=>{
      if('usage' in result){this.recovery=undefined;this.applyResult(result);}
      else {this.recovery=result;this.viewingRecovery=result.status!=='completed'&&result.status!=='ended';this.notice=`恢复决定：${result.status}；原未知和队列冻结仍保留`;if(this.viewingRecovery)this.openPanel('recovery');else this.result=undefined;}
    }).catch(error=>{this.notice=`决定受阻：${safe(String(error))}`;this.viewingRecovery=true;}).finally(()=>this.finished());
  }
  private stop() {
    this.confirmation=undefined;
    if(this.phase!=='running')return;
    this.widths?.retainPending('stop-preserve-unapplied-input');
    this.cancellation='stop';this.phase='stopping';this.notice=`请求中止 run ${this.runId??'受理中'}；等待 runtime 确认`;this.controller?.abort();this.tui.requestRender();
  }
  private refresh() {
    if(this.widths?.blocked){this.pendingRefresh=true;return;}
    this.pendingRefresh=false;
    this.loadQueue();
    if(!this.runId||this.stopped)return;
    try {
      const current=readRunRecords(this.options.dataRoot,this.runId,{tail:true,limit:24,kinds:visibleKinds});
      // Read only bounded small identity/result records; authoritative RunResult arrives from runtime.
      const identityRecords=readRunRecords(this.options.dataRoot,this.runId,{limit:8}).records;
      for(const record of identityRecords) {
        if(record.kind==='task.accepted'||record.kind==='run.started') {
          const bytes=readObjectRange(this.options.dataRoot,record.ref,{limit:16384});
          if(bytes.next===null) {const data=JSON.parse(bytes.bytes.toString());this.sessionId=data.sessionId??this.sessionId;}
        }
        if(record.kind==='execution.config') {
          const bytes=readObjectRange(this.options.dataRoot,record.ref,{limit:16384});
          if(bytes.next===null) {const data=JSON.parse(bytes.bytes.toString());this.model=`${data.model.provider} / ${data.model.id}${data.mode==='offline'?' · offline fixture':''}`;}
        }
      }
      if(!this.historyWindow&&this.scroll.isFollowingEnd&&!this.panel) {this.records=current.records;this.rebuild();}
      else this.notice='新事实已持久保存；当前阅读位置保留。/bottom 回到最新';
      this.tui.requestRender();
    } catch(error) {this.notice=`原文不可取得：${safe(String(error))}；执行结果不会由显示猜测`;this.tui.requestRender();}
  }
  private projectConversation() {
    type Entry={ref:RecordReference;role:'user'|'assistant'|'tool'|'notice';title:string;text:string;attempt?:string;limited?:boolean};
    const entries:Entry[]=[];
    const decoded=new Map<number,{value?:any;error?:string}>();
    for(const ref of this.records) {
      try {
        const page=readObjectRange(this.options.dataRoot,ref.ref,{limit:4096});
        decoded.set(ref.seq,page.next===null?{value:JSON.parse(page.bytes.toString())}:{});
      }catch(error){decoded.set(ref.seq,{error:String(error)});}
    }
    const summaries=new Map<number,any>();
    for(const ref of this.records) {const value=decoded.get(ref.seq)?.value;if(ref.kind==='tool.summary'&&value?.resultSeq)summaries.set(value.resultSeq,value);}
    const tool=(ref:RecordReference,value:any)=>{
      const attempt=value?.attemptId;
      let entry=entries.find(row=>row.role==='tool'&&attempt&&row.attempt===attempt);
      if(!entry){entry={ref,role:'tool',title:'读取',text:'',attempt};entries.push(entry);}
      entry.ref=ref;return entry;
    };
    const assistant=(ref:RecordReference,value:any)=>{
      const attempt=value?.attemptId;
      let entry=entries.find(row=>row.role==='assistant'&&attempt&&row.attempt===attempt);
      if(!entry){entry={ref,role:'assistant',title:'助手（当前窗口）',text:'',attempt};entries.push(entry);}
      entry.ref=ref;return entry;
    };
    const toolState=(entry:Entry,value:any)=>{
      const truncated=value.truncation?.truncated||value.diagnostics?.some((d:{code?:string})=>d.code==='truncated');
      entry.title=`${value.tool&&value.tool!=='read'?value.tool:'读取'} · ${value.isError===true?'失败':value.isError===false?'已返回':'状态未知'}${truncated?' · 源输出截断':''}`;
      const diagnostics=(value.diagnostics??[]).map((d:{message?:string})=>d.message??'').join('\n');
      entry.text=[entry.text,diagnostics].filter(Boolean).join('\n').slice(0,500);
      if(value.diagnosticsOmitted)entry.text+='\n[更多诊断见详情]';
    };
    for(const ref of this.records) {
      const data=decoded.get(ref.seq)!,value=data.value;
      if(data.error){entries.push({ref,role:'notice',title:'原文暂不可取得',text:safe(data.error)});continue;}
      if(ref.kind==='task.accepted')entries.push({ref,role:'user',title:'你',text:value?.input??'已受理的长请求（内容见详情）'});
      else if(ref.kind==='tool.intent'){
        const entry=tool(ref,value);entry.title=`${value?.tool&&value.tool!=='read'?value.tool:'读取'} · 进行中`;entry.text=typeof value?.args?.path==='string'?value.args.path:value?.args?.command??'项目文件';
      } else if(ref.kind==='tool.result'){
        if(summaries.has(ref.seq))continue;
        const entry=tool(ref,value);entry.title='读取 · 结果已保存';
        if(value?.result){const text=value.result.content?.filter((item:{type?:string})=>item.type==='text').map((item:{text:string})=>item.text).join('\n')??'';entry.text=text.slice(0,180);entry.limited=text.length>180;toolState(entry,{isError:typeof value.result.isError==='boolean'?value.result.isError:null,diagnostics:value.result.diagnostics,truncation:value.result.details?.truncation});}
        else entry.text='输出较长；状态摘要暂不可取得，查看详情核对。';
      } else if(ref.kind==='tool.summary'){
        if(!value){entries.push({ref,role:'tool',title:'读取 · 状态未知',text:'摘要不可取得；查看原文。'});continue;}
        const entry=tool(ref,value);toolState(entry,value);
        if(value.resultSeq)entry.ref=this.records.find(record=>record.seq===value.resultSeq)??readRunRecords(this.options.dataRoot,this.runId!,{after:value.resultSeq-1,limit:1}).records.find(record=>record.seq===value.resultSeq)??ref;
        if(!entry.text)entry.text='输出已保存；点击或 Ctrl+O 查看详情。';
      } else if(ref.kind==='tool.error'){
        const entry=tool(ref,value);entry.title='读取 · 失败';entry.text=value?.error??'错误详情不可取得';
      } else if(ref.kind==='model.provider-event'){
        const text=value?.event?.choices?.map((choice:{delta?:{content?:string}})=>choice.delta?.content??'').join('')??'';
        if(text&&value.purpose!=='compaction'){const entry=assistant(ref,value);const combined=entry.text+text;entry.limited=entry.limited||combined.length>4000;entry.text=combined.slice(-4000);}
        // A large event is kept as a reference; it is never printed as transport JSON.
      } else if(ref.kind==='model.response'){
        const text=value?.message?.content?.filter((item:{type?:string})=>item.type==='text').map((item:{text:string})=>item.text).join('\n');
        if(text&&value.purpose==='compaction'){entries.push({ref,role:'notice',title:'压缩摘要（生成记录；接入见 /compactions）',text:text.slice(0,800),limited:text.length>800});continue;}
        if(text){const entry=assistant(ref,value);entry.text=text.slice(0,4000);entry.limited=text.length>4000;entry.title=value.completeness==='partial'?'助手（未完成的响应）':'助手';}
      } else if(ref.kind==='compaction.generated'||ref.kind==='compaction.finished')entries.push({ref,role:'notice',title:ref.kind==='compaction.generated'?'压缩摘要已生成':`上下文压缩 ${value?.state??'未知'}`,text:'原文保留；/compactions 查看覆盖范围、摘要与接入事实'});
      else if(ref.kind==='run.abort-intent'&&!this.result)entries.push({ref,role:'notice',title:'正在中止',text:'等待 runtime 确认清理；当前未接入草稿不会执行。'});
      else if(ref.kind==='run.exit-intent'&&!this.result)entries.push({ref,role:'notice',title:'正在退出',text:'等待执行清理和存储关闭。'});
    }
    if(this.result?.answer&&!this.historyWindow) {
      const ref=this.records.findLast(record=>record.kind==='run.closed')??this.records.at(-1);
      if(ref){const entry:Entry=entries.findLast(row=>row.role==='assistant')??{ref,role:'assistant',title:'助手',text:''};if(!entries.includes(entry))entries.push(entry);entry.ref=ref;entry.title='助手';entry.text=this.result.answer.slice(0,4000);entry.limited=this.result.answer.length>4000;}
    }
    return entries;
  }
  private rebuild() {
    this.transcript.clear();this.summaries.clear();
    this.displaySources=[];
    if(!this.records.length) {
      const text=`在输入区发起一个${this.options.coding?'coding':'只读'}项目请求。\n${this.options.mode==='offline'?'offline-demo：真实 runtime + 固定传输；没有模型推理。':'DeepSeek 凭据从环境读取；没有自动 fallback。'}\nCtrl+J / Shift+Enter / 反斜杠后 Enter 换行。\n忙时 Enter 补充当前任务；Ctrl+X → Enter 后续请求。\n/queue 队列；/recover 恢复；拖选复制。`;
      this.displaySources.push(text);this.transcript.addChild(new Text(text,0,0));
    }
    if(this.records.length&&this.records[0].kind!=='task.accepted')this.transcript.addChild(new Text('当前内容窗口 · /older 查看更早内容\n',0,0));
    for(const entry of this.projectConversation()) {
      const clipped=entry.limited||(entry.role!=='assistant'&&entry.text.length>500);
      const text=safe(entry.role==='assistant'?entry.text:entry.text.slice(0,500));
      const summary=`${entry.title}\n${text}${clipped?'… [显示截断，详情可继续阅读]':''}\n`;
      this.displaySources.push(summary);
      this.summaries.set(entry.ref.seq,summary);this.latestText=text;
      this.transcript.addChild(new MouseRegion(new Text(summary,0,0),event=>{if(event.type==='press'||event.type==='drag')this.scroll.scrollTo(this.scroll.scrollTop,{disableFollow:true});if(event.type==='click'){this.openDetail(entry.ref);return {handled:true};}}));
    }
    this.widths?.inspect(this.displaySources);
    this.tui.requestRender();
  }
  private bottom() {
    this.confirmation=undefined;this.historyWindow=false;if(!this.recovery||this.recovery.status==='completed'||this.recovery.status==='ended')this.viewingRecovery=false;this.scroll.scrollToEnd();this.pendingRefresh=true;this.refresh();this.scroll.scrollToEnd();this.notice=this.viewingRecovery?'恢复限制仍生效；显式提交核对决定':'已回到活动会话，跟随新输出';this.tui.requestRender();
  }
  private window(direction:'older'|'newer') {
    if(!this.runId)return;
    this.historyWindow=true;
    const page=readRunRecords(this.options.dataRoot,this.runId,direction==='older'?{before:this.records[0]?.seq,limit:24,kinds:visibleKinds}:{after:this.records.at(-1)?.seq,limit:24,kinds:visibleKinds});
    if(!page.records.length){this.notice='已到记录边界（只读历史）；/bottom 返回活动会话';this.tui.requestRender();return;}
    this.historyWindow=true;this.records=page.records;this.rebuild();this.scroll.scrollTo(0,{disableFollow:true});this.notice='只读历史窗口；/older /newer 翻页，/bottom 跟随最新';
  }
  private openDetail(record?:RecordReference) {
    if(!record){this.notice='暂无持久记录';return;}
    this.scroll.scrollTo(this.scroll.scrollTop,{disableFollow:true});
    this.openPanel('detail',record);
  }
  private openPanel(kind:'help'|'exit'|'detail'|'actions'|'queue'|'recovery'|'history'|'eval'|'storage'|'compaction'|'metrics',ref?:RecordReference) {
    this.closePanel();this.confirmation=undefined;
    this.panel={kind,ref,offset:0,previous:[],line:0,raw:'',next:null};
    if(kind==='detail')this.loadDetail();
    const component:Component={invalidate(){},render:width=>this.panelLines(width),handleInput:data=>this.panelInput(data),handleMouse:event=>{
      if(!this.panel)return;
      if(event.type==='wheel'){if(this.panel.kind==='metrics')this.metricsView?.scroll(event.wheelDelta??0);else if(this.panel.kind==='history')this.historyView?.scroll(event.wheelDelta??0);else if(this.panel.kind==='storage')this.storageView?.scroll(event.wheelDelta??0);else if(this.panel.kind==='eval')this.evalView?.scroll(event.wheelDelta??0);else this.panel.line=Math.max(0,this.panel.line+(event.wheelDelta??0));return {handled:true};}
      if(event.type==='click'&&this.panel.kind==='actions'){
        const index=event.y+this.panel.line-1;
        if(commands[index]){const command=commands[index][0];this.closePanel();this.command(`/${command}`);return {handled:true};}
      }
    }};
    const overlay=this.tui.showOverlay(component,{width:'96%',maxHeight:'90%',anchor:'center'});this.hidePanel=()=>overlay.hide();this.tui.requestRender();
  }
  private panelLines(width:number) {
    const panel=this.panel;if(!panel)return[];
    if(panel.kind==='eval'){const lines=this.evalView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='storage') {const lines=this.storageView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='metrics') {const lines=this.metricsView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='history') {const lines=this.historyView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    let text:string;
    if(panel.kind==='actions')text='操作菜单（保留输入草稿）\n'+commands.map(([name,description],index)=>`${panel.offset===index?'›':' '} /${name}  ${description}`).join('\n');
    else if(panel.kind==='help')text='帮助\nEnter 新任务；忙时 Enter 补充当前任务\nCtrl+X → Enter 后续请求\nCtrl+J / Shift+Enter / \\ 后 Enter 换行\nCtrl+C 中止；空闲清输入，再按退出\n空输入 Ctrl+D 两次退出（800ms）\nCtrl+D 非空：删除光标后字符簇\nF2 菜单；Ctrl+O 详情；Ctrl+L 重绘\nPageUp/PageDown 滚动；/bottom 活动会话\n/older /newer 只读窗口；/restore 草稿\n/eval 固定评估报告（只读）\n/history 历史查询（只读）\n/metrics [JSON] 三率与双时钟（只读）\n/acceptance JSON 可选明确补记/纠正\n/compact 压缩当前上下文；/compactions 查看结果\n/queue 队列，w 撤回，r 明确重新接入\n/recover [runId] 恢复面板，e 结束旧工作\n/decide JSON 与 headless 同一结构化决定\n/stop 中止；/exit 退出；Esc 关闭弹层';
    else if(panel.kind==='compaction')text=this.compactionText();
    else if(panel.kind==='queue')text=this.queueText();
    else if(panel.kind==='recovery')text=this.recoveryText();
    else if(panel.kind==='exit')text='退出并保留草稿？\nEnter：保存文本，取消在途请求并等待清理\nEsc：返回；不改变任务状态';
    else text=`原文 #${panel.ref?.seq} ${panel.ref?.kind}\n字节 ${panel.offset} / ${panel.ref?.ref.bytes}；源 JSON，显示有界\n${panel.error??safe(panel.raw)}\n${panel.next===null?'本原文已到末尾':'还有下一片（n）'}`;
    this.widths?.inspect([text]);
    const lines=wrapTextWithAnsi(text,Math.max(1,width-2));
    const height=Math.max(2,Math.floor(this.terminal.rows*0.9)-2);
    const maxLine=Math.max(0,lines.length-height);panel.line=Math.min(panel.line,maxLine);
    return [...lines.slice(panel.line,panel.line+height),truncateToWidth(panel.kind==='detail'?'↑↓滚动 ←→记录 n/p片 y复制当前片 Esc返回':'↑↓滚动 Esc返回',width)];
  }
  private panelInput(data:string) {
    const panel=this.panel;if(!panel)return;
    this.confirmation=undefined;
    if(matchesKey(data,'escape')||matchesKey(data,'ctrl+o')) {if(panel.kind==='storage'&&this.storageView?.inProgress)return;this.closePanel();return;}
    if(matchesKey(data,'ctrl+l')){if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return;}
    if(matchesKey(data,'ctrl+c')||matchesKey(data,'ctrl+d'))return;
    if(panel.kind==='eval'){this.evalView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='storage') {void this.storageView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='compaction'){if(data==='n'&&panel.next!==null){panel.previous.push(panel.offset);panel.offset=panel.next;panel.line=0;}else if(data==='p'&&panel.previous.length){panel.offset=panel.previous.pop()!;panel.line=0;}else if(data==='c')void this.cancelLatestCompaction();}
    if(panel.kind==='metrics') {this.metricsView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='history') {this.historyView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='actions') {
      if(matchesKey(data,'up')) panel.offset=(panel.offset+commands.length-1)%commands.length;
      if(matchesKey(data,'down')||matchesKey(data,'tab')) panel.offset=(panel.offset+1)%commands.length;
      if(matchesKey(data,'enter')) {const command=commands[panel.offset][0];this.closePanel();this.command(`/${command}`);return;}
      panel.line=Math.max(0,panel.offset-Math.floor(this.terminal.rows*0.9)+4);
    } else {
      if(matchesKey(data,'up'))panel.line=Math.max(0,panel.line-1);
      if(matchesKey(data,'down'))panel.line++;
    }
    if(panel.kind==='exit'&&matchesKey(data,'enter')){this.closePanel();void this.exit();return;}
    if(panel.kind==='queue') {
      if(matchesKey(data,'left'))panel.offset=Math.max(0,panel.offset-1);
      if(matchesKey(data,'right')||matchesKey(data,'tab'))panel.offset=Math.min(this.queue.length-1,panel.offset+1);
      const item=this.queue[panel.offset];
      if(item&&(data==='w'||data==='r'))void this.queueDecision(item.requestId,data==='w'?'withdraw':'reattach');
      if(data==='n'&&this.queueNext!==null){this.queuePrevious.push(this.queueAfter);this.queueAfter=this.queueNext;panel.offset=0;panel.line=0;this.loadQueue();}
      if(data==='p'&&this.queuePrevious.length){this.queueAfter=this.queuePrevious.pop();panel.offset=0;panel.line=0;this.loadQueue();}
    }
    if(panel.kind==='recovery'&&data==='e'&&this.recovery?.options.includes('end'))void this.recoveryDecision({id:randomUUID(),snapshotId:this.recovery.snapshotId,action:'end'});
    if(panel.kind==='recovery'&&data==='c'&&this.recovery?.options.includes('continue')&&!this.recovery.tools.some(tool=>tool.fact==='unknown'&&!tool.resolution))void this.recoveryDecision({id:randomUUID(),snapshotId:this.recovery.snapshotId,action:'continue',acceptAdditionalModelAttempts:true});
    if(panel.kind==='detail') {
      if(data==='n'&&panel.next!==null){panel.previous.push(panel.offset);panel.offset=panel.next;panel.line=0;this.loadDetail();}
      if(data==='p'){panel.offset=panel.previous.pop()??0;panel.line=0;this.loadDetail();}
      if(matchesKey(data,'left')||matchesKey(data,'right')||matchesKey(data,'tab')){
        const index=this.records.findIndex(r=>r.seq===panel.ref?.seq),delta=matchesKey(data,'left')?-1:1;
        const ref=this.records[Math.max(0,Math.min(this.records.length-1,index+delta))];
        panel.ref=ref;panel.offset=0;panel.previous=[];panel.line=0;this.loadDetail();
      }
      if(data==='y')void this.copy(panel.raw).then(result=>{this.notice=result===true?'已复制当前原文片段':String(result);this.tui.requestRender();}).catch(error=>{this.notice=`复制失败：${String(error)}`;});
    }
    this.tui.requestRender();
  }
  private loadDetail() {
    const panel=this.panel;if(!panel?.ref)return;
    try {const page=readTextPage(this.options.dataRoot,panel.ref.ref,panel.offset);panel.raw=page.text;panel.next=page.next;panel.error=undefined;}
    catch(error){panel.raw='';panel.next=null;panel.error=`原文不可取得：${String(error)}`;}
  }
  private closePanel() {this.hidePanel?.();this.hidePanel=undefined;this.panel=undefined;this.confirmation=undefined;this.tui.setFocus(this.editor);this.tui.requestRender();}
  private requestExit() {
    if(this.editor.getExpandedText()||this.savedDraft)this.openPanel('exit');
    else void this.exit();
  }
  private async copyOutput() {
    try {
      if(this.tui.hasActiveSelection()){await this.tui.copyActiveSelectionToClipboard();return;}
      const result=await this.copy(this.latestText||'尚无输出');
      this.notice=result===true?'已复制最新可见摘要（可能显示截断；详情按片复制）':String(result);this.tui.requestRender();
    }catch(error){this.notice=`复制失败：${String(error)}`;this.tui.requestRender();}
  }
  /** Controlled exit is shared by explicit UI exits and catchable process faults/signals. */
  exit():Promise<TuiExit> {
    return this.exiting??=this.finishExit();
  }
  private async finishExit():Promise<TuiExit> {
    this.phase='exiting';this.confirmation=undefined;this.notice='退出中；等待 runtime 清理与 storage 关闭';this.tui.requestRender();
    try {this.widths?.beginClose();}catch(error){this.failure=`待处理输入保存失败：${String(error)}`;}
    if(!this.controller?.signal.aborted)this.cancellation='exit';this.controller?.abort();
    let draftSaved=false;
    try {const draft=this.editor.getExpandedText()||this.savedDraft;if(draft){this.drafts.save(draft);draftSaved=true;}}catch(error){this.failure=`草稿保存失败：${String(error)}`;}
    try {await this.active;} finally {
      this.stopped=true;if(this.timer)clearInterval(this.timer);this.removeInput?.();for(const remove of this.removeSignals)remove();
      if(this.started) {
        try {if(this.widths&&!await this.widths.settle())this.failure??='WIDTH_QUERY_BOUNDARY_UNKNOWN: terminal drain is bounded';}catch(error){this.failure??=`字宽清理失败：${String(error)}`;}
        try {await this.terminal.drainInput(150,30);} catch(error){this.failure??=`终端 drain 失败：${String(error)}`;}
        try {this.terminal.write('\x1b[?1004l');this.tui.stop({preserveScreen:true});}
        catch(error){this.failure??=`终端清理失败：${String(error)}`;try{this.terminal.stop();}catch{/* Preserve the cleanup failure. */}}
        finally {try{this.terminal.showCursor();}catch{/* Earlier failure remains visible in the exit result. */}this.widths?.dispose();this.restoreTerminalWrite?.();}
      }
    }
    const result={result:this.result,error:this.failure,draftSaved,widthCalibration:this.widths?.snapshot()};
    this.resolveClosed(result);return result;
  }
}

export async function runTui(options:TuiOptions) {
  const app=new ReadOnlyTui(options);
  try {app.start();return await app.closed;} finally {await app.exit();}
}
