import {ImproveView} from './improve.js';
import {ImproveSelectionView} from './improve-selection.js';
import {submitImproveDecision,resumeImproveDecision,restoreImproveSuggestion,rollbackImproveDecision,type ImproveDecision} from '../improve-decisions.js';
import {validateImproveRequest,type ImproveRequest} from '../improve.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Container, Editor, MouseRegion, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, isKeyRelease, isKeyRepeat, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type Terminal } from '@earendil-works/pi-tui';
import { runReadTask, runCodingTask, analyzeImprove, compactContext, TaskControl, readQueue, decideQueue, inspectRecovery, checkRecovery, recoverRun, estimateTaskPrefix, type ContextUsage, type CodingTaskOptions, type RunResult, type ToolEnvironmentConfig, type RecoveryReport, type RecoveryDecision, type RecoveryAuthorization, type QueueDecision } from '../runtime.js';
import { readObject, type QueueItemFact } from '../evidence.js';
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { readRunRecords, readObjectRange, type RecordReference } from '../query.js';
import { Drafts } from './drafts.js';
import { StatsView, readStats, statsRequest } from './stats.js';
import { recordAcceptance } from '../metrics/index.js';
import type { HistoryFilter } from '../history.js';
import { HistoryView } from './history.js';
import { EvalView } from './eval.js';
import { StorageView } from './storage.js';
import { TraceView, type TraceHost } from './trace.js';
import { TraceRawView, outputItem } from './trace-raw.js';
import type { TraceSpan } from '../trace.js';
import { HardwareCursorEditor, hideCursorDuringPaint } from './cursor.js';
import { TerminalWidthGate } from './width-gate.js';
import { readDisplayIndex, resolveDisplayInput, isUserChosenId, type DisplayIndex, type DisplayKind } from '../display-number.js';
import { readSessionChains } from '../session-chain.js';
import { estimateSessionRequests, formatCostTotals, COST_ESTIMATE_NOTICE } from '../cost-estimate.js';
import { SPINNER_INTERVAL_MS, styledLine, makeBorderColor } from './theme.js';
import { RunView, VISIBLE_KINDS, sumUsage } from './run-view.js';
import { assistantLines, headerLine, narrowing, plainLines, precedingText, statusLine, statusParts, tokenCount, toolLines, usageLine, userLines, type Activity, type HeaderState, type RunStatus } from './session-screen.js';
import { ConfirmDialog, escHint, hintLine, viewKey, fixedFrame, type ConfirmConfig } from './view-stack.js';
import { CommandError, commandCompletion, helpBody, parseCommand, resolveArgument, type ParsedCommand } from './commands.js';
import { TIPS, WelcomeScreen, readWelcomeFacts, welcomeStatus } from './welcome.js';

/** 全屏视图（视图栈条目）的种类。 */
type PanelKind='help'|'exit'|'trace-raw'|'queue'|'recovery'|'history'|'eval'|'storage'|'trace'|'improve'|'improve-selection'|'metrics';
type ViewEntry={kind:PanelKind;offset:number;line:number};
/** 主区窗口：每次读取当前任务最近的记录条数（查询上限）。 */
const WINDOW=50;
const identity=(s:string)=>s;
const theme={borderColor:makeBorderColor('border.input'), selectList:{selectedPrefix:identity,selectedText:identity,description:identity,scrollInfo:identity,noMatch:identity}};
function safe(text:string) { return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�'); }
export interface TuiOptions {
  workspace:string; dataRoot:string; mode:'live'|'offline'; transport?:typeof fetch;
  coding?:boolean;toolEnvironment?:ToolEnvironmentConfig;runId?:string;
  /** 启动后直接打开该 run 的 2a（`pi-durio show … --trace`）。 */
  trace?:string;
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
  private readonly editor:HardwareCursorEditor;
  private readonly transcript=new Container();
  private readonly scroll:ScrollView;
  private readonly drafts:Drafts;
  private readonly copy:(text:string)=>Promise<boolean|string>;
  private records:RecordReference[]=[];
  private latestText='';
  private runId?:string;
  private sessionId?:string;
  private model='deepseek-flash';
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
  /** 状态反馈：与即时反馈一样替换会话屏底部键位提示行，下一次按键后恢复（U12）。 */
  private notice='';
  private savedDraft?:string;
  private lastText='';
  private confirmation?:{key:string;at:number};
  private followChord=false;
  /** 视图栈：全屏视图逐层压入，栈顶 = 当前视图；Esc 逐层弹出，空时回到会话（T1、T6）。 */
  private viewStack:ViewEntry[]=[];
  private get panel(){return this.viewStack.at(-1);}
  private historyView?:HistoryView;
  private metricsView?:StatsView;
  private evalView?:EvalView;
  private improveView?:ImproveView;
  private improveSelectionView?:ImproveSelectionView;
  private storageView?:StorageView;
  private traceView?:TraceView;
  private traceRaw?:TraceRawView;
  private hidePanel?:()=>void;
  /** 即时反馈：临时替换底栏键位提示行（全屏视图保留最右边的 Esc），下一次按键后恢复（U12）。 */
  private hintFeedback?:string;
  /** 视图或会话屏之上的确认框；打开时消费全部按键。 */
  private dialog?:{box:ConfirmDialog;hide:()=>void;confirm:(selected:number[])=>void};
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
  private displayIndex?:DisplayIndex;
  private displayMisses=new Set<string>();
  /** Live values come from the runtime; without one, the fixed-prefix estimate or the run's latest reported total. */
  private context:Omit<ContextUsage,'runId'>&{runId?:string};
  private readonly showContext=(usage:ContextUsage)=>{this.context=usage;this.tui.requestRender();};
  /** 各 run 的主区取数缓存（第 M 轮、工具调用、用量）。 */
  private readonly views=new Map<string,RunView>();
  /** Ctrl+O 展开全部；点击单行切换，记在 toggled 里（与 expandAll 相反）。 */
  private expandAll=false;
  private readonly toggled=new Set<string>();
  /** 状态行的后台工作（improve 分析/执行、eval 批次）。 */
  private activity?:Activity;
  /** 后台完成事件：在主区末尾各插一行（U2、U12）；新任务开始时清空。 */
  private events:string[]=[];
  private refreshes=0;
  private usageMemo?:{key:string;scope:'本会话'|'本任务';tokens:number;cost:string};
  /** 1a 欢迎屏：本进程受理第一个任务前显示，之后为 1b 布局（U1）。 */
  private welcome?:WelcomeScreen;

  constructor(private readonly options:TuiOptions) {
    if(options.widthCalibration===false&&!options.terminal)throw Error('WIDTH_CALIBRATION_TEST_TERMINAL_REQUIRED');
    options.workspace=realpathSync(options.workspace);
    options.dataRoot=resolve(options.dataRoot);
    this.runId=options.runId;this.viewingRecovery=!!options.runId;
    this.context=this.prefix();
    this.terminal=options.terminal??new ProcessTerminal();
    this.copy=options.copy??copyToMacClipboard;
    this.drafts=new Drafts(options.draftRoot??join(homedir(),'Library','Application Support','pi-durio','ui-drafts'),options.workspace,options.dataRoot);
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve;});
    this.tui=new TuiAltScreen(this.terminal,true,undefined,{copySelection:this.copy,copyOnSelect:true,scrollToEndIndicator:()=> ' ↓ 回到底部 · /bottom '});
    this.editor=new HardwareCursorEditor(this.tui,theme,{autocompleteMaxVisible:2});
    this.editor.setAutocompleteProvider(commandCompletion(options.workspace));
    this.editor.placeholder=()=>this.placeholder();
    this.editor.onChange=()=>{
      const text=this.editor.getExpandedText();
      this.confirmation=undefined;
      if(Buffer.byteLength(text)>32768) { this.editor.setText(this.lastText); this.notice='输入超过 32 KiB；本次编辑未接入'; }
      else this.lastText=text;
      this.tui.requestRender();
    };
    this.editor.onSubmit=text=>this.submit(text);
    this.scroll=new ScrollView(this.transcript,{follow:'end',primary:true});
    // 1b（U2）：头部一行；主区；状态行；输入框；底栏用量与键位提示（状态反馈替换键位提示行）。
    const header:Component={invalidate(){},render:width=>{const state=this.headerState();return [headerLine(state,width,narrowing(width,state,this.statusParts()).headerRight)];}};
    const status:Component={invalidate(){},render:width=>{const parts=this.statusParts();return [statusLine(parts,width,narrowing(width,this.headerState(),parts).statusHint)];}};
    const footer:Component={invalidate(){},render:width=>{
      const usage=this.usageText(),feedback=this.hintFeedback??(this.notice||undefined);
      // 1a 空闲时第一行是欢迎屏的状态行（#71），否则是 1b 底栏用量。
      return [this.welcome&&this.phase==='idle'&&!this.viewingRecovery?welcomeStatus(this.welcome.facts.model.id,this.contextUsage(),width):usageLine(this.model,this.contextUsage(),usage.scope,usage.tokens,usage.cost,width),feedback!==undefined?hintLine([],width,{feedback}):hintLine(this.sessionHints(),width,{keepLast:'? 帮助'})];
    }};
    if(!options.runId){
      const tip=TIPS[Math.floor(Math.random()*TIPS.length)];
      this.welcome=new WelcomeScreen({coding:!!options.coding,
        read:()=>readWelcomeFacts({workspace:options.workspace,dataRoot:options.dataRoot,coding:!!options.coding,mode:options.mode,toolEnvironment:options.toolEnvironment},id=>this.shown('session',id),tip),
        height:width=>this.terminal.rows-2-Math.min(6,Math.max(3,this.editor.render(width).length)),
        open:session=>{try{this.command(parseCommand(`/history ${session}`));}catch(error){this.notice=error instanceof CommandError?error.line:safe(String(error));}this.tui.requestRender();},
        changed:()=>this.tui.requestRender(),inspect:lines=>this.widths?.inspect(lines)});
    }
    const welcome=this.welcome?[{component:this.welcome,basis:0,grow:1,visible:()=>!!this.welcome}]:[];
    const layout=new VStack([{component:header,basis:1,visible:()=>!this.welcome},...welcome,{component:this.scroll,basis:0,grow:1,minSize:1,visible:()=>!this.welcome},{component:status,basis:1,visible:()=>!this.welcome},{component:this.editor,basis:'auto',shrink:1,minSize:3,maxSize:6},{component:footer,basis:2}]);
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
      sources:()=>[this.editor.getExpandedText(),this.options.workspace,this.model,this.notice,this.contextUsage(),this.usageText().cost,...this.displaySources],
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
    else if(this.options.trace)this.openTrace(this.options.trace);
    this.widths?.inspect();
    this.terminal.write('\x1b[?1004h'); // Focus reports invalidate any pending exit confirmation.
    this.timer=setInterval(()=>{if(this.pendingRefresh)this.refresh();else if(this.phase!=='idle')this.tui.requestRender();},SPINNER_INTERVAL_MS);
    this.loadQueue();
    void this.welcome?.probeLock();
    this.tui.requestRender();
  }
  /** Visible frame for diagnostics/tests; no runtime internals or writable handles. */
  screen() { this.tui.renderNow(); return this.tui.getScreenLines(); }
  /** Display numbers are computed at render time; the index is reread only when an identity is new to it. */
  private indexed(kind:DisplayKind,id:string) {
    const key=`${kind}:${id}`;
    if(!this.displayIndex||!this.displayIndex.has(kind,id)&&!this.displayMisses.has(key)){this.displayIndex=readDisplayIndex(this.options.dataRoot);if(!this.displayIndex.has(kind,id))this.displayMisses.add(key);}
    return this.displayIndex;
  }
  private shown(kind:DisplayKind,id:string) {return this.indexed(kind,id).label(kind,id);}
  /** 当前 run 在会话链中的位置；只在 run 变化时重新推导（受理记录可见之前不缓存）。 */
  private chainSession?:{runId:string;id:string;number:number;first:number;status?:string;forkedFrom:{sessionId:string;number:number}|null;contextRunIds:string[]};
  private chainOf(runId:string) {
    if(this.chainSession?.runId!==runId){
      const chains=readSessionChains(this.options.dataRoot),of=chains.sessionOfRun(runId),summary=of&&chains.session(of.id);
      if(!of||!summary)return undefined;
      // context.imported 在 run.started 之前写下；执行段开始前推导的深度可能还不含接续，不缓存。
      const chain={runId,id:of.id,number:of.number,first:summary.first.number,status:chains.tasks(of.id,{after:of.number-1,limit:1}).items[0]?.status,forkedFrom:summary.forkedFrom,contextRunIds:chains.contextRunIds(runId)};
      if(this.phase==='running'&&!this.views.get(runId)?.progress.segmentStart)return chain;
      this.chainSession=chain;
    }
    return this.chainSession;
  }
  /** `s-` number of the derived session a run belongs to. */
  private sessionOf(runId:string) {const chain=this.chainOf(runId);return chain?this.shown('session',chain.id):'未记录';}
  private view(runId:string) {let view=this.views.get(runId);if(!view){view=new RunView(this.options.dataRoot,runId);this.views.set(runId,view);}return view;}
  /** 当前任务的终态：本进程的运行结果，否则取会话链中记录的状态。 */
  private runStatus():RunStatus|undefined {
    if(this.result)return this.result.status;
    const status=this.runId?this.chainOf(this.runId)?.status:undefined;
    return status==='completed'||status==='failed'||status==='aborted'||status==='unknown'?status:undefined;
  }
  private headerState():HeaderState {
    const chain=this.runId?this.chainOf(this.runId):undefined,home=homedir(),workspace=this.options.workspace;
    const round=this.runId?this.views.get(this.runId)?.progress.round:undefined;
    return {workspace:safe(workspace.startsWith(`${home}/`)?`~${workspace.slice(home.length)}`:workspace),readOnly:!this.options.coding,
      session:chain?this.shown('session',chain.id):undefined,run:this.runId?this.shown('run',this.runId):undefined,task:chain?.number,
      ...(this.phase==='running'?{round:round||undefined}:{status:this.runStatus()})};
  }
  private statusParts() {
    const progress=this.runId?this.views.get(this.runId)?.progress:undefined,start=progress?.segmentStart;
    // 计时从当前执行段开始（run.started，恢复后为 recovery.started），不计中断时间（T2）。
    return statusParts({phase:this.phase,recovery:this.viewingRecovery,status:this.runStatus(),activity:this.activity,round:progress?.round??0,retry:progress?.retry??false,
      elapsedMs:this.phase==='running'&&start?Date.now()-Date.parse(start):undefined,frame:Math.floor(Date.now()/SPINNER_INTERVAL_MS)});
  }
  private prefix() {return estimateTaskPrefix({dataRoot:this.options.dataRoot,workspace:this.options.workspace,coding:!!this.options.coding,mode:this.options.mode,toolEnvironment:this.options.toolEnvironment});}
  private contextUsage() {return `ctx ${this.context.estimated?'≈':''}${tokenCount(this.context.tokens)} / ${tokenCount(this.context.contextWindow)}`;}
  /**
   * 底栏用量：运行时为本任务（当前 run），空闲时为本会话（上下文链上各 run 之和）；tok = 输入（含缓存命中）+ 输出。
   * 每次刷新或状态变化后重算一次；只是显示，读取失败只让金额未知。
   */
  private usageText() {
    const scope=this.phase==='running'?'本任务' as const:'本会话' as const,key=`${scope}:${this.runId}:${this.refreshes}`;
    if(this.usageMemo?.key!==key){
      let tokens=0,cost:string;
      try{
        const runIds=!this.runId?[]:scope==='本任务'?[this.runId]:this.chainOf(this.runId)?.contextRunIds??[this.runId];
        const total=sumUsage(runIds.map(id=>this.view(id).usage()));tokens=total.tokens;cost=formatCostTotals(total.totals);
      }catch{cost='unknown';}
      this.usageMemo={key,scope,tokens,cost};
    }
    return this.usageMemo;
  }
  private input(data:string) {
    const ctrlC=matchesKey(data,'ctrl+c'),ctrlD=matchesKey(data,'ctrl+d');
    if(isKeyRelease(data)||((ctrlC||ctrlD)&&isKeyRepeat(data)))return {consume:true};
    if(!ctrlC&&!ctrlD) this.confirmation=undefined;
    if(this.hintFeedback!==undefined||this.notice){this.hintFeedback=undefined;this.notice='';this.tui.requestRender();}
    if(data==='\x1b[I'||data==='\x1b[O') {this.confirmation=undefined;return {consume:true};}
    if(this.dialog) {this.dialogInput(data);return {consume:true};}
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
    if(matchesKey(data,'ctrl+r')) {this.command(parseCommand('/history'));return {consume:true};}
    if(data==='?'&&this.editor.focused&&!this.editor.getExpandedText()) {this.openPanel('help');return {consume:true};}
    // Ctrl+O 展开或折叠全部工具行（T1、#41）；单行由点击切换。
    if(matchesKey(data,'ctrl+o')) {this.expandAll=!this.expandAll;this.toggled.clear();this.tui.requestRender();return {consume:true};}
    if(matchesKey(data,'ctrl+t')) {this.openTrace();return {consume:true};}
    if(matchesKey(data,'ctrl+x')) {this.followChord=this.editor.focused;this.feedback('按 Enter 明确排到下一任务；普通 Enter 默认补充当前任务');return {consume:true};}
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
      // 参数有误时不打开视图：文本放回输入框，状态行写原因与可用值。
      try {this.command(parseCommand(command));}
      catch(error){if(!(error instanceof CommandError))throw error;this.editor.setText(text);this.lastText=text;this.notice=error.line;}
      this.tui.requestRender(); return;
    }
    if(!text.trim())return;
    if(this.historyWindow||this.viewingRecovery){this.editor.setText(text);this.lastText=text;this.notice='只读历史/恢复视图不能提交；/bottom 返回活动会话，恢复限制仍需显式处置';this.tui.requestRender();return;}
    if(this.phase==='running') {this.enqueue(text,followUp?'follow-up':'steer');return;}
    if(this.phase!=='idle') {this.editor.setText(text);this.lastText=text;this.notice='当前正在清理；草稿保留，未受理';this.tui.requestRender();return;}
    if(followUp){this.editor.setText(text);this.lastText=text;this.notice='当前没有运行任务；文本保留，按普通 Enter 明确提交新任务';this.tui.requestRender();return;}
    if(this.result?.status==='unknown'||this.result?.cleanup==='unknown') {this.editor.setText(text);this.lastText=text;this.notice='旧工作存在未知；只读查看，不能由 TUI 绕过恢复核对';this.tui.requestRender();return;}
    const contextRunId=this.result?.status==='completed'&&this.result.improve?.runId!==this.result.runId&&this.result.cleanup==='confirmed'?this.result.runId:undefined;
    this.editor.addToHistory(text);this.editor.setText('');this.lastText='';
    if(!contextRunId)this.context=this.prefix();
    this.welcome=undefined;this.phase='running';this.result=undefined;this.runId=undefined;this.sessionId=undefined;this.records=[];this.toggled.clear();this.events=[];this.historyWindow=false;this.scroll.scrollToEnd();
    this.confirmation=undefined;this.controller=new AbortController();this.cancellation='exit';this.rebuild();
    const self=this;
    const options:CodingTaskOptions={contextRunId,workspace:this.options.workspace,dataRoot:this.options.dataRoot,input:text,mode:this.options.mode,toolEnvironment:this.options.toolEnvironment,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}};
    const run=this.options.coding?runCodingTask:runReadTask;
    this.active=run(options).then(result=>this.applyResult(result)).catch(error=>{this.failure=String(error);this.notice=`未完成：${safe(String(error))}`;}).finally(()=>this.finished());
    this.tui.requestRender();
  }
  /** 按命令表解析后的命令分派；写法见 commands.ts。resolveArgument 的 CommandError 交给 submit 写状态行。 */
  private command(parsed:ParsedCommand) {
    const root=this.options.dataRoot,{positional,options,raw}=parsed;
    const fail=(prefix:string,error:unknown)=>{if(error instanceof CommandError)throw error;this.notice=`${prefix}${safe(String(error))}`;this.tui.requestRender();};
    switch(parsed.path.length?`${parsed.spec.name} ${parsed.path.join(' ')}`:parsed.spec.name){
    case 'help':this.openPanel('help');break;
    case 'exit':this.requestExit();break;
    case 'restore':this.editor.setText(this.savedDraft??this.drafts.latest()??'');this.lastText=this.editor.getExpandedText();this.notice='草稿已恢复；尚未提交';break;
    case 'bottom':this.bottom();break;
    case 'older':this.window('older');break;
    case 'newer':this.window('newer');break;
    case 'stats':
      try{this.metricsView=new StatsView(statsRequest(options,this.options.workspace),scope=>readStats(root,scope));this.openPanel('metrics');}catch(error){fail('任务指标不可读取：',error);}
      break;
    case 'acceptance':
      try{const input=JSON.parse(raw);if(typeof input?.taskId==='string')input.taskId=resolveDisplayInput(root,'task',input.taskId);const receipt=recordAcceptance(root,input);this.notice=`验收记录已追加：${receipt.source}`;}catch(error){this.notice=`验收输入未记录：${String(error)}`;}this.tui.requestRender();break;
    case 'eval':{
      const id=positional[0]===undefined?undefined:resolveArgument(root,positional[0],['eval-plan']).id;
      try{this.evalView=new EvalView(root,id);this.openPanel('eval');}catch(error){fail('Eval记录不可读取：',error);}
      break;
    }
    case 'storage':this.storageView=new StorageView(root,{changed:()=>this.tui.requestRender(),busy:()=>this.phase!=='idle',feedback:text=>this.feedback(text),confirm:(config,confirm)=>this.openConfirm(config,()=>void confirm())});this.openPanel('storage');break;
    case 'history':{
      const filter:HistoryFilter={};
      if(positional[0]!==undefined){
        const target=resolveArgument(root,positional[0],['session','run']);
        if(target.kind==='session')filter.session=target.id;
        else {const session=readSessionChains(root).sessionOfRun(target.id);if(!session)throw new CommandError(`${positional[0]} 没有会话记录`);filter.session=session.id;}
      }
      if(options.from)filter.from=options.from as string;
      if(options.to)filter.to=options.to as string;
      if(options.project&&options.project!=='all')filter.project=options.project as string;
      // recovery = 结果未知、需恢复核对的任务。
      if(options.status)filter.status=options.status==='recovery'?'unknown':options.status as string;
      try{this.historyView=new HistoryView(root,filter);this.openPanel('history');}catch(error){fail('历史查询失败（当前工作未改变）：',error);}
      break;
    }
    case 'trace':this.openTrace(positional[0]===undefined?undefined:resolveArgument(root,positional[0],['run']).id);break;
    case 'details':{
      // 不带号取当前 run 最近一次工具调用；tc-<run>-<序位> 指定调用（同一调用多次 attempt 时取最后一次）。
      let runId=this.runId,call:number|undefined;
      if(positional[0]!==undefined){
        const match=/^tc-([0-9a-f]+)-([0-9]+)$/i.exec(positional[0]);if(!match)throw new CommandError(`这里要 tc-号，收到 ${positional[0]}`);
        runId=resolveArgument(root,`r-${match[1]}`,['run']).id;call=Number(match[2]);
      }
      if(!runId){this.feedback('尚无 run · 完成或开始一个任务后再用 /details');break;}
      const view=this.traceOf(runId),tools=view.trace.spans.filter(span=>span.kind==='tool'&&!span.tool!.denied);
      const span=call===undefined?tools.at(-1):tools.findLast(item=>item.tool!.call===call);
      if(!span){
        if(call===undefined){this.feedback(`run ${this.shown('run',runId)} 没有工具调用`);break;}
        const index=readDisplayIndex(root);throw new CommandError(`没有找到 ${positional[0]}`,[...new Set(tools.flatMap(item=>item.tool!.call===null?[]:[index.toolCall(runId!,item.tool!.call)]))]);
      }
      this.openDetails(view,span);break;
    }
    case 'copy':void this.copyOutput();break;
    case 'stop':this.stop();break;
    case 'queue':this.loadQueue();this.openPanel('queue');break;
    case 'recover':{const [requested,offset,snapshotId]=raw.split(/\s+/).filter(Boolean);let run=this.runId;try{if(requested)run=resolveDisplayInput(root,'run',requested);}catch(error){this.notice=safe(String(error));break;}if(run)void this.openRecovery(run,offset?Number(offset):undefined,snapshotId);else this.notice='暂无需核对的 run';break;}
    case 'follow-up':{const draft=this.editor.getExpandedText();if(draft)this.submit(draft,true);else this.notice='输入后按 Ctrl+X → Enter，明确排到下一任务';break;}
    case 'withdraw':case 'reattach':
      // 不带参数打开队列视图（T1）；带 q- 号时 /withdraw 直接撤回。/reattach 的确认框由 #77 接入。
      if(!positional.length){this.loadQueue();this.openPanel('queue');break;}
      void this.queueDecision(resolveArgument(root,positional[0],['queue-request']).id,parsed.spec.name as 'withdraw'|'reattach');break;
    case 'decide':try{void this.recoveryDecision(JSON.parse(raw));}catch(error){this.notice=`决定 JSON 无效：${String(error)}`;}break;
    case 'compact':void this.compact();break;
    case 'improves':case 'improve history':{
      const id=positional[0]===undefined?undefined:resolveArgument(root,positional[0],['improve-report']).id;
      try{this.improveView=new ImproveView(root,id);this.openPanel('improve');}catch(error){fail('improve 报告不可读取：',error);}
      break;
    }
    case 'improve-suppressions':case 'improve suppressions':try{this.improveView=new ImproveView(root,undefined,true);this.openPanel('improve');}catch(error){fail('',error);}break;
    case 'improve-restore':case 'improve-continue':case 'improve-rollback':{
      if(this.phase!=='idle'||this.historyWindow||this.viewingRecovery||this.result?.status==='unknown'||this.result?.cleanup==='unknown'){this.notice='当前执行/恢复状态不允许新决定';break;}
      try{const action=parsed.spec.name.slice(8) as 'restore'|'continue'|'rollback',spec=JSON.parse(raw);this.phase='running';this.controller=new AbortController();this.cancellation='exit';const operation=action==='restore'?restoreImproveSuggestion({...spec,dataRoot:root}):action==='rollback'?rollbackImproveDecision({...spec,dataRoot:root,signal:this.controller.signal}):resumeImproveDecision({...spec,dataRoot:root,signal:this.controller.signal});this.active=operation.then(value=>{this.notice=`improve ${action}: ${JSON.stringify(value)}`;}).catch(error=>{this.notice=String(error);}).finally(()=>this.finished());}catch(error){this.notice=String(error);}
      break;
    }
    case 'improve-select':
      if(this.phase!=='idle'||this.historyWindow||this.viewingRecovery||this.result?.status==='unknown'||this.result?.cleanup==='unknown'){this.notice='当前执行/恢复状态不允许选择；只读报告仍可查看';break;}
      try{const template=JSON.parse(raw) as ImproveDecision;if(typeof template?.reportId==='string')template.reportId=resolveDisplayInput(root,'improve-report',template.reportId);this.improveSelectionView=new ImproveSelectionView(root,template,decision=>this.submitImproveChoice(decision),()=>this.tui.requestRender());this.openPanel('improve-selection');}catch(error){this.notice=`尚未选择：/improve-select JSON 需要报告身份及声明的候选内容/验证计划；${String(error)}`;}
      break;
    case 'improve':void this.improve(raw);break;
    }
  }
  private async improve(input:string) {
    if(this.historyWindow||this.viewingRecovery){this.notice='只读历史/恢复视图不能发起分析；返回活动目标并完成核对';this.tui.requestRender();return;}
    if(!input){this.notice='尚未启动。使用 /improve JSON 明确 purpose、limits（maxRequests/maxTokens/maxRequestTokens/maxDurationMs/maxOutputTokens）及 sources；/improves 只读查看报告';this.tui.requestRender();return;}
    let request:ImproveRequest;try{const parsed=JSON.parse(input);request=validateImproveRequest({...parsed,id:parsed.id??randomUUID()},this.options.mode);}catch(error){this.notice=`尚未启动：${String(error)}`;this.tui.requestRender();return;}
    if(this.phase==='running'){const target=this.control.target();if(!target){this.notice='当前在收尾或分析中；未受理新的管理请求';this.tui.requestRender();return;}try{const item=await this.control.submit({id:request.id,kind:'improve',input:JSON.stringify(request),target});this.notice=`improve ${item.status} · ${this.shown('improve-report',item.requestId)} → 原 run ${this.shown('run',target.runId)}`;this.loadQueue();}catch(error){this.notice=`未接入：${String(error)}`;}this.tui.requestRender();return;}
    if(this.phase!=='idle'||this.result?.status==='unknown'||this.result?.cleanup==='unknown'){this.notice='当前仍在清理或结果未知；尚未启动分析，先完成恢复核对';this.tui.requestRender();return;}
    if(!this.runId){this.notice='尚无活动任务；先完成一项工作再针对其证据分析';this.tui.requestRender();return;}
    const targetRunId=this.result?.improve?.runId===this.runId?this.result.improve.target.runId:this.runId;this.phase='running';this.controller=new AbortController();this.cancellation='exit';const self=this;
    this.activity={kind:'improve-analysis',report:this.shown('improve-report',request.id)};
    this.active=analyzeImprove({dataRoot:this.options.dataRoot,workspace:this.options.workspace,targetRunId,request,mode:this.options.mode,transport:this.options.transport,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}}).then(result=>{this.applyResult(result);const state=result.improve?.state??result.status;this.event(`${state==='complete'?'✓':'✗'} improve ${this.shown('improve-report',request.id)} 分析${state==='complete'?'完成':`未完成 · ${state}`} · /improves 查看；没有执行候选`);}).catch(error=>{this.event(`✗ improve 分析未完成 · ${safe(String(error))}`);}).finally(()=>this.finished());this.tui.requestRender();
  }
  private async submitImproveChoice(decision:ImproveDecision){
    if(this.phase!=='idle'||this.historyWindow||this.viewingRecovery)throw Error('IMPROVE_SELECTION_CURRENT_STATE_BLOCKED');
    this.phase='running';this.controller=new AbortController();this.cancellation='exit';this.activity={kind:'improve-execution',report:this.shown('improve-report',decision.reportId)};
    const promise=submitImproveDecision({dataRoot:this.options.dataRoot,decision,signal:this.controller.signal});
    this.active=promise.then(value=>{this.event(`${value.state==='completed'?'✓':'✗'} 决定 ${value.id} · ${value.state}；具体写回/启用见结果`);}).catch(error=>{this.event(`✗ 决定未完成：${safe(String(error))}`);}).finally(()=>this.finished());
    return promise;
  }
  private async compact() {
    if(this.historyWindow||this.viewingRecovery){this.notice='只读历史/恢复视图不能压缩；先返回活动会话并完成恢复核对';this.tui.requestRender();return;}
    if(this.phase==='running'){this.enqueue('compact','compact');return;}
    if(this.phase!=='idle'||this.result?.status!=='completed'||this.result.cleanup!=='confirmed'){this.notice='压缩需要已完成且清理确认的活动会话';this.tui.requestRender();return;}
    const runId=this.result.runId;this.controller=new AbortController();this.cancellation='exit';this.phase='running';this.notice='正在压缩当前上下文；原文保留，摘要生成与接入分别记录';const self=this;
    this.active=compactContext({dataRoot:this.options.dataRoot,runId,requestId:randomUUID(),authorization:this.authorization(),transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:()=>{this.pendingRefresh=true;}}).then(result=>{
      this.result=result;this.viewingRecovery=result.status!=='completed'||result.cleanup!=='confirmed';this.notice=`上下文压缩 ${result.compaction?.state??result.status}；Ctrl+T 在 trace 中查看源范围、摘要与接入事实；磁盘原文保留`;
    }).catch(error=>{this.notice=`压缩未执行：${safe(String(error))}`;}).finally(()=>this.finished());
    this.tui.requestRender();await this.active;
  }
  private applyResult(result:RunResult) {
    this.result=result;this.sessionId=result.sessionId;this.runId=result.runId;
    this.viewingRecovery=result.status==='unknown'||result.cleanup==='unknown';
    // 终态在状态行与头部；这里只留需要处理的事。
    this.notice=result.controls?'队列已冻结；/queue 查看目标与原因，普通输入不会接入旧项':result.cleanup!=='confirmed'?'清理未知；原工作保留，/recover 核对':'';
  }
  /** 后台完成事件：在主区末尾插一行。 */
  private event(text:string) {this.events.push(text);this.rebuild();}
  private finished() {
    this.activity=undefined;this.pendingRefresh=true;this.refresh();if(this.phase!=='exiting'){this.phase='idle';void this.welcome?.refresh().catch(error=>{this.notice=`欢迎屏事实不可读取：${safe(String(error))}`;});}this.confirmation=undefined;this.followChord=false;this.tui.requestRender();
  }
  private enqueue(text:string,kind:'steer'|'follow-up'|'compact'|'improve') {
    const target=this.control.target();
    if(!target){this.editor.setText(text);this.lastText=text;this.notice='当前仍在受理或收尾；文字保留，未受理';this.tui.requestRender();return;}
    this.editor.addToHistory(text);this.editor.setText('');this.lastText='';
    void this.control.submit({id:randomUUID(),kind,input:text,target}).then(item=>{
      this.loadQueue();this.notice=`${kind} ${item.status==='applied'?'已接入':'已受理、待接入'} · ${this.shown('queue-request',item.requestId)} → ${this.shown('task',item.target.taskId)} · /queue`;
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
    return `队列 ${this.panel!.offset+1}/${this.queue.length} · ${item.kind}\n${this.shown('queue-request',item.requestId)}${isUserChosenId(item.requestId)?` · 原 id ${safe(item.requestId)}`:''}\n${status}\n目标 ${item.target.workspace}\n原 session ${this.sessionOf(item.target.runId)}\n原 task ${this.shown('task',item.target.taskId)}\n原 run ${this.shown('run',item.target.runId)}\n新 run ${item.runId?this.shown('run',item.runId):item.kind==='follow-up'?'尚未开始':'无'}\n内容：${safe(item.input.slice(0,4096))}${item.input.length>4096?' [显示截断]':''}\n原因：${safe(item.reason)}\n←→/Tab 选项 n/p 窗口；w 撤回未接入项\nr 明确重新接入：仅已完成源的冻结 follow-up / 未执行 compact；重新执行可能收费\n旧 steer 或停止任务的文本需明确重新提交新任务\nEsc 返回，不解除冻结`;
  }
  private authorization():RecoveryAuthorization {return {workspace:this.options.workspace,mode:this.options.mode,tools:this.options.coding?['read','write','edit','bash']:['read'],toolEnvironment:this.options.toolEnvironment};}
  private async queueDecision(input:string,action:'withdraw'|'reattach') {
    let requestId:string;try{requestId=resolveDisplayInput(this.options.dataRoot,'queue-request',input);}catch(error){this.notice=`队列决定未执行：${safe(String(error))}`;this.tui.requestRender();return;}
    this.loadQueue();const item=this.queue.find(item=>item.requestId===requestId);
    if(!item){this.notice='当前窗口没有该请求；/queue 核对 q- 号';return;}
    const decision:QueueDecision={id:randomUUID(),requestId,action,target:item.target,receiptSeq:item.receipt.seq};
    try {
      if(this.phase==='running') {
        if(action==='reattach')throw Error('当前工作运行中；不能重新接入冻结请求');
        const result=await this.control.withdraw(decision);this.notice=result.status==='withdrawn'?'撤回已提交':`未撤回：${result.status} · ${result.reason}`;
      } else {
        if(this.phase!=='idle')throw Error('正在清理，暂不接受决定');
        if(action==='reattach') {
          this.closeViews();this.welcome=undefined;this.phase='running';this.controller=new AbortController();this.cancellation='exit';
          const self=this;
          this.active=decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision,authorization:this.authorization(),transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}}).then(result=>{if('usage' in result)this.applyResult(result);else this.notice=`已保存状态 ${result.status}`;}).catch(error=>{this.notice=`重新接入受阻：${safe(String(error))}`;}).finally(()=>this.finished());
          return;
        }
        const result=await decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision});this.notice=result.status==='withdrawn'?'撤回已提交':`未撤回：${result.status}`;
      }
    }catch(error){this.notice=`队列决定未执行：${safe(String(error))}`;}
    finally{this.loadQueue();this.tui.requestRender();}
  }
  private async openRecovery(runId:string,offset?:number,snapshotId?:string) {
    if(this.phase!=='idle'){const running=this.control.target()?.runId??this.runId;this.notice=`正在执行 ${running?this.shown('run',running):'受理中'}；先停止或退出后核对`;this.tui.requestRender();return;}
    this.welcome=undefined;this.viewingRecovery=true;this.runId=runId;
    const inspect=()=>offset!==undefined?inspectRecovery({dataRoot:this.options.dataRoot,runId,authorization:this.authorization(),page:{offset,snapshotId}}):checkRecovery({dataRoot:this.options.dataRoot,runId,authorization:this.authorization()});
    try {this.recovery=await (this.widths?this.widths.withoutQueries(inspect):inspect());if(this.stopped||this.exiting)return;this.pendingRefresh=true;this.refresh();this.openPanel('recovery');}
    catch(error){this.notice=`恢复核对受阻：${safe(String(error))}`;this.tui.requestRender();}
  }
  private recoveryText() {
    const report=this.recovery;if(!report)return '恢复事实暂不可取得；关闭面板不解除限制';
    const original=report.original as Partial<RunResult>;
    const details=report.details;const next=details?Object.values({tools:details.tools,compactions:details.compactions,reasons:details.reasons,pending:details.pending,unknown:details.unknownModelAttempts}).find(detail=>detail.next!==null)?.next:undefined;
    const pageText=details?`全部工具 ${details.tools.count}，未处置未知 ${details.unresolvedTools}；本页起点 ${details.tools.offset}\nn 下一页 / p 上一页；${next!==undefined?`Esc 后 /recover ${this.shown('run',report.runId)} ${next} ${report.snapshotId}`:'已到最后一页'}\n本页决定模板仅包含可见工具；继续前仍核对全部未知。`:'';
    const template={id:'choose-a-new-decision-id',snapshotId:report.snapshotId,action:'continue',acceptAdditionalModelAttempts:true,resolutions:report.tools.filter(tool=>tool.fact==='unknown'&&!tool.resolution).map(tool=>({taskId:tool.taskId,choice:'CHOOSE retry/skip/completed',reason:'提供依据'}))};
    return `恢复核对 · ${report.status}\n工作 ${this.shown('run',report.runId)}\n原状态 ${original.status??'unknown'}；清理 ${original.cleanup??'unknown'}\n最后确认：${report.tools.filter(tool=>tool.fact==='committed').map(tool=>`tool ${tool.taskId}`).join(', ')||'无已确认工具结果'}\n未知模型 attempts：${details?.unknownModelAttempts.count??report.unknownModelAttempts.length}\n${pageText}\n${report.tools.map(tool=>`tool ${tool.taskId} ${tool.tool}: ${tool.fact}，证据 #${tool.evidence.join(',')||'缺失'}`).join('\n')}\n原因：${report.reasons.join('; ')||'需明确决定'}\n影响：${report.needsInput?.risks.join('\n')||'原事实保留，不重计量'}\n动作：${report.options.join(', ')}\ne 明确结束旧工作：不回滚、不宣称外部副作用未发生\nc 继续：仅全部工具无需未知处置时；可能新增模型费用\n有未知时 Esc 后 /decide ${JSON.stringify(template)}\n恢复与 headless 使用同一 snapshot/decision；Esc 仅返回查看`;
  }
  private async recoveryDecision(decision:RecoveryDecision) {
    if(this.phase!=='idle'||!this.recovery){this.notice='先 /recover 获取当前核对事实';return;}
    const runId=this.recovery.runId;this.closeViews();this.phase='running';this.controller=new AbortController();this.cancellation='exit';const self=this;
    this.active=recoverRun({dataRoot:this.options.dataRoot,runId,authorization:this.authorization(),decision,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}}).then(result=>{
      if('usage' in result){this.recovery=undefined;this.applyResult(result);}
      else {this.recovery=result;this.viewingRecovery=result.status!=='completed'&&result.status!=='ended';this.notice=`恢复决定：${result.status}；原未知和队列冻结仍保留`;if(this.viewingRecovery)this.openPanel('recovery');else this.result=undefined;}
    }).catch(error=>{this.notice=`决定受阻：${safe(String(error))}`;this.viewingRecovery=true;}).finally(()=>this.finished());
  }
  private stop() {
    this.confirmation=undefined;
    if(this.phase!=='running')return;
    this.widths?.retainPending('stop-preserve-unapplied-input');
    this.cancellation='stop';this.phase='stopping';this.notice=`请求中止 run ${this.runId?this.shown('run',this.runId):'受理中'}；等待 runtime 确认`;this.controller?.abort();this.tui.requestRender();
  }
  private refresh() {
    if(this.widths?.blocked){this.pendingRefresh=true;return;}
    this.pendingRefresh=false;
    this.loadQueue();
    if(!this.runId||this.stopped)return;
    try {
      const current=readRunRecords(this.options.dataRoot,this.runId,{tail:true,limit:WINDOW,kinds:VISIBLE_KINDS});
      // Read only bounded small identity/result records; authoritative RunResult arrives from runtime.
      const identityRecords=readRunRecords(this.options.dataRoot,this.runId,{limit:8}).records;
      let contextWindow:number|undefined;
      for(const record of identityRecords) {
        if(record.kind==='task.accepted'||record.kind==='run.started') {
          const bytes=readObjectRange(this.options.dataRoot,record.ref,{limit:16384});
          if(bytes.next===null) {const data=JSON.parse(bytes.bytes.toString());this.sessionId=data.sessionId??this.sessionId;}
        }
        if(record.kind==='execution.config') {
          const bytes=readObjectRange(this.options.dataRoot,record.ref,{limit:16384});
          if(bytes.next===null) {const data=JSON.parse(bytes.bytes.toString());this.model=`${data.model.id}${data.mode==='offline'?' · offline':''}`;contextWindow=data.model.contextWindow;}
        }
      }
      if(this.phase==='idle'&&this.context.runId!==this.runId) {
        // No live runtime for this run: show its latest provider-reported total; later content is not estimated.
        const reported=readRunRecords(this.options.dataRoot,this.runId,{tail:true,limit:8,kinds:['model.response']}).records.map(record=>JSON.parse(readObject(this.options.dataRoot,record.ref).toString())).findLast(data=>data.usage==='reported'&&calculateContextTokens(data.message.usage)>0);
        this.context=reported?{runId:this.runId,tokens:calculateContextTokens(reported.message.usage),estimated:true,contextWindow:contextWindow??this.context.contextWindow}:{...this.prefix(),runId:this.runId};
      }
      this.view(this.runId).updateProgress();this.refreshes++;
      // 上滚或打开视图时保留阅读位置；“↓ 回到底部”提示由滚动区给出。
      if(!this.historyWindow&&this.scroll.isFollowingEnd&&!this.panel) {this.records=current.records;this.rebuild();}
      this.tui.requestRender();
    } catch(error) {this.notice=`原文不可取得：${safe(String(error))}；执行结果不会由显示猜测`;this.tui.requestRender();}
  }
  /** 主区（U2）：前序任务行、当前任务的窗口投影、后台事件行；工具行按渲染时的展开态与时钟绘制。 */
  private rebuild() {
    this.transcript.clear();
    this.displaySources=[];
    const block=(render:(width:number)=>string[],click?:()=>void)=>this.transcript.addChild(new MouseRegion({invalidate(){},render},event=>{
      if(event.type==='press'||event.type==='drag')this.scroll.scrollTo(this.scroll.scrollTop,{disableFollow:true});
      if(event.type==='click'&&click){click();this.tui.requestRender();return {handled:true};}
      return undefined;
    }));
    const chain=this.runId?this.chainOf(this.runId):undefined;
    const preceding=chain&&precedingText({session:this.shown('session',chain.id),preceding:chain.number-chain.first,forkedFrom:chain.forkedFrom?{session:this.shown('session',chain.forkedFrom.sessionId),number:chain.forkedFrom.number}:undefined});
    if(preceding){this.displaySources.push(preceding.text);block(width=>plainLines(preceding.text,width,'fg.faint'),()=>this.command(parseCommand(preceding.command)));}
    if(!this.records.length) {
      const text=`在输入区发起一个${this.options.coding?'coding':'只读'}项目请求。\n${this.options.mode==='offline'?'offline-demo：真实 runtime + 固定传输；没有模型推理。':'DeepSeek 凭据从环境读取；没有自动 fallback。'}\nCtrl+J / Shift+Enter / 反斜杠后 Enter 换行。\n忙时 Enter 补充当前任务；Ctrl+X → Enter 后续请求。\n/queue 队列；/recover 恢复；拖选复制。`;
      this.displaySources.push(text);block(width=>plainLines(text,width,'fg.muted'));
    }
    if(this.records.length&&this.records[0].kind!=='task.accepted')block(width=>plainLines('当前内容窗口 · /older 查看更早内容',width,'fg.faint'));
    const entries=this.runId?this.view(this.runId).project(this.records,{active:this.phase!=='idle',answer:this.result?.answer&&!this.historyWindow?this.result.answer:undefined}):[];
    let previous:string|undefined;
    for(const entry of entries) {
      // 区块之间空一行；相邻工具行连成一组。
      if(previous&&!(previous==='tool'&&entry.kind==='tool'))block(width=>[styledLine([],width)]);
      previous=entry.kind;
      if(entry.kind==='user'){const text=safe(entry.text);this.displaySources.push(text);block(width=>userLines(text,width,entry.steer));}
      else if(entry.kind==='assistant'){const text=safe(entry.text)+(entry.limited?' … [显示截断，Ctrl+T 在 trace 原文中继续阅读]':'');this.latestText=text;this.displaySources.push(text);block(width=>assistantLines(text,width));}
      else if(entry.kind==='notice'){const text=`${entry.title}\n${safe(entry.text)}`;this.displaySources.push(text);block(width=>plainLines(text,width,'fg.muted'));}
      else {
        const id=entry.attemptId,expanded=()=>this.expandAll!==this.toggled.has(id),frame=()=>Math.floor(Date.now()/SPINNER_INTERVAL_MS);
        entry.args=safe(entry.args);if(entry.output)entry.output.lines=entry.output.lines.map(safe);if(entry.diff)entry.diff=entry.diff.map(safe);
        this.displaySources.push(`${entry.tool} ${entry.args} ${entry.summary}`,...(entry.output?.lines??[]),...(entry.diff??[]));
        const lines=(width:number)=>toolLines(entry,width,expanded(),Date.now(),frame());
        block(width=>{const tool=lines(width);return [tool.row,...tool.body];},()=>{if(!this.toggled.delete(id))this.toggled.add(id);});
        // “分页查看”进入 2a 原文层。
        block(width=>{const paging=lines(width).paging;return paging?[paging]:[];},()=>{
          const runId=this.runId;if(!runId)return;
          const view=this.traceOf(runId),span=view.trace.spans.find(item=>item.key===id);
          if(span)this.openDetails(view,span);else this.feedback('该工具调用尚未写入 trace');
        });
      }
    }
    for(const text of this.events){this.displaySources.push(text);block(width=>[styledLine([],width),...plainLines(safe(text),width,'fg.label')]);}
    this.widths?.inspect(this.displaySources);
    this.tui.requestRender();
  }
  private bottom() {
    this.confirmation=undefined;this.historyWindow=false;if(!this.recovery||this.recovery.status==='completed'||this.recovery.status==='ended')this.viewingRecovery=false;this.scroll.scrollToEnd();this.pendingRefresh=true;this.refresh();this.scroll.scrollToEnd();this.notice=this.viewingRecovery?'恢复限制仍生效；显式提交核对决定':'已回到活动会话，跟随新输出';this.tui.requestRender();
  }
  private window(direction:'older'|'newer') {
    if(!this.runId)return;
    this.historyWindow=true;
    const page=readRunRecords(this.options.dataRoot,this.runId,direction==='older'?{before:this.records[0]?.seq,limit:WINDOW,kinds:VISIBLE_KINDS}:{after:this.records.at(-1)?.seq,limit:WINDOW,kinds:VISIBLE_KINDS});
    if(!page.records.length){this.notice='已到记录边界（只读历史）；/bottom 返回活动会话';this.tui.requestRender();return;}
    this.historyWindow=true;this.records=page.records;this.rebuild();this.scroll.scrollTo(0,{disableFollow:true});this.notice='只读历史窗口；/older /newer 翻页，/bottom 跟随最新';
  }
  /** 2a：指定 run，或当前会话正在运行 / 最近一次的 run；尚无 run 时只提示（U7）。 */
  private openTrace(runId=this.runId) {
    if(!runId){this.feedback('尚无 run · 完成或开始一个任务后再按 Ctrl+T');return;}
    try{this.traceView=this.traceOf(runId);this.openPanel('trace');}
    catch(error){this.notice=`trace 不可读取：${safe(String(error))}`;this.tui.requestRender();}
  }
  /** 2a 列表层；Enter 进原文层、`p` 固定为证据经 TraceHost 回到这里。 */
  private traceOf(runId:string) {
    const host:TraceHost={busy:()=>this.phase!=='idle',feedback:text=>this.feedback(text),confirm:(config,run)=>this.openConfirm(config,()=>void run()),changed:()=>this.tui.requestRender(),openRaw:span=>this.openRaw(span)};
    return new TraceView(this.options.dataRoot,runId,()=>this.phase==='running'&&this.runId===runId,host);
  }
  /** 在 2a 列表层之上压入原文层（Esc 回到列表层，仍选中该 span）。 */
  private openRaw(span:TraceSpan,item?:string) {
    if(!this.traceView)return;
    this.traceRaw=new TraceRawView(this.options.dataRoot,this.traceView,span.key,{copy:this.copy,feedback:text=>this.feedback(text),changed:()=>this.tui.requestRender()},item);
    this.pushView('trace-raw');
  }
  /** `/details` 与“分页查看”：打开 2a 并选中该 span，直接进入原文层（先显示输出）；Esc 先回列表层，再回会话。 */
  private openDetails(view:TraceView,span:TraceSpan) {
    this.scroll.scrollTo(this.scroll.scrollTop,{disableFollow:true});
    this.traceView=view;this.openPanel('trace');view.select(span.key);this.openRaw(span,outputItem(span));
  }
  private openPanel(kind:PanelKind) {
    // 从会话屏（或菜单）打开：替换整个视图栈，新视图为最上层。视图内进入下一层用 pushView。
    this.closeViews();this.confirmation=undefined;
    this.viewStack.push({kind,offset:0,line:0});
    const component:Component={invalidate(){},render:width=>this.panelLines(width),handleInput:data=>this.panelInput(data),handleMouse:event=>{
      const panel=this.panel;if(!panel)return;
      if(event.type==='wheel'&&panel.kind==='trace-raw'){this.traceRaw?.scroll(event.wheelDelta??0);return {handled:true};}
      if(event.type==='click'&&panel.kind==='trace'){this.traceView?.click(event.y);this.tui.requestRender();return {handled:true};}
      if(event.type==='wheel'){if(panel.kind==='improve-selection')this.improveSelectionView?.scroll(event.wheelDelta??0);else if(panel.kind==='metrics')this.metricsView?.scroll(event.wheelDelta??0);else if(panel.kind==='improve')this.improveView?.scroll(event.wheelDelta??0);else if(panel.kind==='history')this.historyView?.scroll(event.wheelDelta??0);else if(panel.kind==='storage')this.storageView?.scroll(event.wheelDelta??0);else if(panel.kind==='eval')this.evalView?.scroll(event.wheelDelta??0);else if(panel.kind==='trace')this.traceView?.scroll(event.wheelDelta??0);else panel.line=Math.max(0,panel.line+(event.wheelDelta??0));return {handled:true};}
    }};
    const overlay=this.tui.showOverlay(component,{width:'96%',maxHeight:'90%',anchor:'center'});this.hidePanel=()=>overlay.hide();this.tui.requestRender();
  }
  /**
   * 在当前视图之上压入下一层：共用同一个全屏浮层，Esc 回到当前层（closePanel）。
   * 没有打开的视图时等同 openPanel。首版面板都是单层，尚无调用方。
   */
  private pushView(kind:PanelKind) {
    if(!this.viewStack.length){this.openPanel(kind);return;}
    this.viewStack.push({kind,offset:0,line:0});
    this.tui.requestRender();
  }
  /** 视图各行；有即时反馈时替换末行（视图的键位提示行），保留最右边的 Esc。 */
  private panelLines(width:number) {
    const lines=this.panelBody(width);
    if(this.hintFeedback!==undefined&&lines.length)lines[lines.length-1]=hintLine([],width,{feedback:this.hintFeedback,esc:escHint(this.viewStack.length)});
    return lines;
  }
  private overlayHeight(){return Math.max(3,Math.floor(this.terminal.rows*0.9)-1);}
  /** 帮助视图：会话屏键位与命令清单（同一张命令表），正文在固定头尾之间滚动。 */
  private helpLines(width:number) {
    const panel=this.panel!;
    const frame=fixedFrame([styledLine([{text:'帮助',fg:'fg.primary',bold:true}],width)],helpBody(width),[hintLine(['↑↓ 滚动','n/p 翻页'],width,{esc:escHint(this.viewStack.length)})],this.overlayHeight(),panel.line);
    panel.line=frame.offset;this.widths?.inspect(frame.lines);
    return frame.lines;
  }
  /** 会话屏底栏键位提示（#42 第 4 节）；宽度不够时从右往左去掉，空闲时 `? 帮助` 最后去掉。 */
  private sessionHints():string[] {
    if(this.phase==='stopping'||this.phase==='exiting')return [];
    if(this.viewingRecovery)return ['/recover 打开核对','Ctrl+C 退出（保留可恢复工作）'];
    if(this.phase==='running')return ['Enter steer','Ctrl+X Enter follow-up','Ctrl+C 中止','Ctrl+O 展开'];
    return ['Enter 提交','/ 命令','Ctrl+R 历史','? 帮助'];
  }
  /** 输入为空时的占位文案（#42 第 4 节）。 */
  private placeholder() {
    if(this.phase==='stopping'||this.phase==='exiting')return '正在清理 · 输入保留为草稿，不会受理';
    if(this.viewingRecovery)return '恢复核对进行中 · 输入已保存为草稿，不会提交';
    if(this.phase==='running')return '补充当前任务…   Ctrl+X Enter 排到下一任务';
    return `${this.options.coding?'描述要完成的修改…':'描述要查看或分析的内容…'}   / 命令  @ 文件  Shift+Enter 换行`;
  }
  private panelBody(width:number):string[] {
    const panel=this.panel;if(!panel)return[];
    if(panel.kind==='improve-selection'){const lines=this.improveSelectionView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='improve'){const lines=this.improveView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='eval'){const lines=this.evalView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='storage') {const lines=this.storageView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='metrics') {const lines=this.metricsView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='history') {const lines=this.historyView?.render(width,Math.max(2,Math.floor(this.terminal.rows*0.9)-2))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='trace') {const lines=this.traceView?.render(width,this.overlayHeight(),escHint(this.viewStack.length))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='trace-raw') {const lines=this.traceRaw?.render(width,this.overlayHeight(),escHint(this.viewStack.length))??[];this.widths?.inspect(lines);return lines;}
    let text:string;
    if(panel.kind==='help')return this.helpLines(width);
    if(panel.kind==='queue')text=this.queueText();
    else if(panel.kind==='recovery')text=this.recoveryText();
    else text='退出并保留草稿？\nEnter：保存文本，取消在途请求并等待清理\nEsc：返回；不改变任务状态';
    this.widths?.inspect([text]);
    const lines=wrapTextWithAnsi(text,Math.max(1,width-2));
    const height=Math.max(2,Math.floor(this.terminal.rows*0.9)-2);
    const maxLine=Math.max(0,lines.length-height);panel.line=Math.min(panel.line,maxLine);
    return [...lines.slice(panel.line,panel.line+height),truncateToWidth('↑↓滚动 Esc返回',width)];
  }
  private panelInput(data:string) {
    const panel=this.panel;if(!panel)return;
    this.confirmation=undefined;
    // 全屏视图层的全局键（T6）：Esc 返回上一层；Ctrl+C 只停本视图的操作，不传给会话屏；Ctrl+D/O/T/R、? 不起作用。
    const key=viewKey(data);
    if(key==='back') {if(panel.kind==='storage')this.storageView?.cancel();if(panel.kind==='improve-selection'&&this.improveSelectionView?.inProgress){this.stop();return;}this.closePanel();return;}
    if(key==='redraw'){if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return;}
    if(key==='stop'){if(panel.kind==='improve-selection'&&this.improveSelectionView?.inProgress)this.stop();return;}
    if(key==='inert')return;
    if(panel.kind==='improve-selection'){void this.improveSelectionView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='improve'){this.improveView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='eval'){this.evalView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='storage') {void this.storageView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='trace'){this.traceView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='trace-raw'){this.traceRaw?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='metrics') {this.metricsView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='history') {this.historyView?.handleInput(data);this.tui.requestRender();return;}
    if(matchesKey(data,'up'))panel.line=Math.max(0,panel.line-1);
    if(matchesKey(data,'down'))panel.line++;
    if(panel.kind==='help'){const page=Math.max(1,this.overlayHeight()-2);if(data==='n')panel.line+=page;if(data==='p')panel.line=Math.max(0,panel.line-page);}
    if(panel.kind==='exit'&&matchesKey(data,'enter')){this.closeViews();void this.exit();return;}
    if(panel.kind==='queue') {
      if(matchesKey(data,'left'))panel.offset=Math.max(0,panel.offset-1);
      if(matchesKey(data,'right')||matchesKey(data,'tab'))panel.offset=Math.min(this.queue.length-1,panel.offset+1);
      const item=this.queue[panel.offset];
      if(item&&(data==='w'||data==='r'))void this.queueDecision(item.requestId,data==='w'?'withdraw':'reattach');
      if(data==='n'&&this.queueNext!==null){this.queuePrevious.push(this.queueAfter);this.queueAfter=this.queueNext;panel.offset=0;panel.line=0;this.loadQueue();}
      if(data==='p'&&this.queuePrevious.length){this.queueAfter=this.queuePrevious.pop();panel.offset=0;panel.line=0;this.loadQueue();}
    }
    if(panel.kind==='recovery'&&this.recovery?.details&&(data==='n'||data==='p')) {
      const details=this.recovery.details;
      const next=[details.tools,details.compactions,details.reasons,details.pending,details.unknownModelAttempts].find(detail=>detail.next!==null)?.next;
      if(data==='p'&&details.tools.offset>0)void this.openRecovery(this.recovery.runId,Math.max(0,details.tools.offset-32),this.recovery.snapshotId);
      if(data==='n'&&next!==undefined&&next!==null)void this.openRecovery(this.recovery.runId,next,this.recovery.snapshotId);
    }
    if(panel.kind==='recovery'&&data==='e'&&this.recovery?.options.includes('end'))void this.recoveryDecision({id:randomUUID(),snapshotId:this.recovery.snapshotId,action:'end'});
    if(panel.kind==='recovery'&&data==='c'&&this.recovery?.options.includes('continue')&&(this.recovery.details?this.recovery.details.unresolvedTools===0:!this.recovery.tools.some(tool=>tool.fact==='unknown'&&!tool.resolution)))void this.recoveryDecision({id:randomUUID(),snapshotId:this.recovery.snapshotId,action:'continue',acceptAdditionalModelAttempts:true});
    this.tui.requestRender();
  }
  /** Esc：弹出最上层视图；栈空时关闭浮层、焦点还给输入框（回到会话屏）。 */
  private closePanel() {
    this.viewStack.pop();
    if(!this.viewStack.length){this.hidePanel?.();this.hidePanel=undefined;this.tui.setFocus(this.editor);}
    this.confirmation=undefined;this.tui.requestRender();
  }
  /** 离开全部视图回到会话屏（开始执行、退出、从菜单换到另一视图）。 */
  private closeViews() {
    this.closeConfirm();
    this.viewStack.length=0;this.hidePanel?.();this.hidePanel=undefined;this.tui.setFocus(this.editor);
    this.confirmation=undefined;this.tui.requestRender();
  }
  /** 按键的即时反馈：替换底栏键位提示行，下一次按键后恢复。 */
  private feedback(text:string) {this.hintFeedback=text;this.tui.requestRender();}
  /**
   * 在当前层（视图或会话屏）之上打开确认框（U12 版式）。Enter 可用时调用 confirm 并关闭；Esc 只关闭。
   * 打开期间消费全部按键，不穿透到视图或会话屏。
   */
  private openConfirm(config:ConfirmConfig,confirm:(selected:number[])=>void) {
    this.closeConfirm();
    const box=new ConfirmDialog(config),terminal=this.terminal;
    const component:Component={invalidate(){},render:()=>box.render(terminal.columns,terminal.rows),handleInput:data=>this.dialogInput(data)};
    const overlay=this.tui.showOverlay(component,{get width(){return ConfirmDialog.width(terminal.columns);},anchor:'center'});
    this.dialog={box,confirm,hide:()=>overlay.hide()};this.tui.requestRender();
  }
  private closeConfirm() {this.dialog?.hide();this.dialog=undefined;this.tui.requestRender();}
  private dialogInput(data:string) {
    const dialog=this.dialog;if(!dialog)return;
    if(matchesKey(data,'ctrl+l')){if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return;}
    const result=dialog.box.handleInput(data);
    if(result.type==='cancel')this.closeConfirm();
    else if(result.type==='confirm'){this.closeConfirm();dialog.confirm(result.selected);}
    this.tui.requestRender();
  }
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

/** Exit summary line for "本次会话": every run of the session the summary reports, estimated in CNY. */
export function exitCostSummary(dataRoot:string,result:RunResult) {
  // The exit status reflects the run; an unreadable cost source only leaves the amount unknown.
  let amount:string;try{amount=formatCostTotals(estimateSessionRequests(dataRoot,[result.sessionId]).totals);}catch{amount='unknown';}
  return `本次会话 ${readDisplayIndex(dataRoot).label('session',result.sessionId)} 费用 ${amount}（${COST_ESTIMATE_NOTICE}）`;
}

export async function runTui(options:TuiOptions) {
  const app=new ReadOnlyTui(options);
  try {app.start();return await app.closed;} finally {await app.exit();}
}
