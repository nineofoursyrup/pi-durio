import {ImproveView} from './improve.js';
import {ImproveSelectionView,improveSelectionPrefill,improveChoiceError,type ImprovePrefill} from './improve-selection.js';
import type {ImproveDecision,ImproveResume,ImproveCleanupReceipt} from '../improve-decisions.js';
import {readImproveDecision} from '../improve-history.js';
import {ImproveManagement} from './improve-management.js';
import {ImproveBatchController} from '../improve-batch.js';
import {improveReportContract} from '../improve-contract.js';
import type {ImproveRequest} from '../improve.js';
import {ImproveHome,type HomeItem} from './improve-home.js';
import {ImproveLaunchDialog,type LaunchPrefill} from './improve-launch.js';
import {completePath,improveRequest,improveVisibleFiles,readReportRecord,registerFromInput} from '../improve-entry.js';
import {listRegisteredSources,unregisterImproveSource} from '../improve-source.js';
import {withOwnerSync} from '../ownership.js';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Container, Editor, MouseRegion, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, isKeyRelease, isKeyRepeat, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type Terminal } from '@earendil-works/pi-tui';
import { runReadTask, runCodingTask, analyzeImprove, compactContext, TaskControl, decideQueue, inspectRecoveryForDisplay, recoverRun, settleRecoveryOwners, estimateTaskPrefix, type ContextUsage, type CodingTaskOptions, type RunResult, type ToolEnvironmentConfig, type RecoveryReport, type RecoveryDecision, type RecoveryAuthorization, type QueueDecision } from '../runtime.js';
import { readObject, type QueueItemFact } from '../evidence.js';
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { readRunRecords, readObjectRange, type RecordReference } from '../query.js';
import { Drafts } from './drafts.js';
import { statsRequest } from './stats.js';
import { StatsBrowser } from './stats-browser.js';
import { processMeasurements } from '../self-measurement.js';
import { statsChoices, StatsChoicesLimitError } from './stats-filter.js';
import { resolveProjectFilter } from './project-filter.js';
import { AcceptanceDialog, AnnotationWriteError, ANNOTATION_RUNNING, annotationTarget, readAnnotation, saveAnnotation, type AnnotationTarget, type AnnotationPrefill } from './acceptance.js';
import { HistoryView, historyScope, historyProjects, type HistoryTarget } from './history.js';
import { EvalListView, EvalPlanView, type PlanViewHost } from './eval.js';
import { TrialTraceView } from './eval-trial.js';
import { evalBlocked,evalRunConfirmation,evalGradeConfirmation,executeEval,evalStoppedFact,readEvalProgress,samePlan,type EvalAction } from './eval-operation.js';
import type {EvalCleanupReceipt} from '../eval/cleanup.js';
import {evalReport} from '../eval/runner.js';
import { resolvePlanSource,readPlanReport,planState,listPlanSources,type PlanSource,type EvalReport } from '../eval/overview.js';
import { StorageView } from './storage.js';
import { TraceView, type TraceHost } from './trace.js';
import { TraceRawView, outputItem } from './trace-raw.js';
import type { TraceSpan } from '../trace.js';
import { HardwareCursorEditor, hideCursorDuringPaint } from './cursor.js';
import { TerminalWidthGate } from './width-gate.js';
import { fullScreenHeight, showFullScreen } from './fullscreen.js';
import { readDisplayIndex, resolveDisplayInput, type DisplayIndex, type DisplayKind } from '../display-number.js';
import { readSessionChains } from '../session-chain.js';
import { formatCostTotals } from '../cost-estimate.js';
import { exitSummary, ProcessCleanupReceipts, type EvalExitFact } from './exit-summary.js';
export { exitCostSummary } from './exit-summary.js';
import { SPINNER_INTERVAL_MS, styledLine, makeBorderColor, dimForOverlay } from './theme.js';
import { RunView, VISIBLE_KINDS, sumUsage } from './run-view.js';
import { assistantLines, headerLine, narrowing, plainLines, precedingText, statusLine, statusParts, tokenCount, toolLines, usageSegments, userLines, type Activity, type HeaderState, type RunStatus } from './session-screen.js';
import { ConfirmDialog, LoadingState, escHint, hintLine, viewKey, fixedFrame, footerLines, inset, sideMargin, bottomMargin, topMargin, rule, frameBox, composeOverlay, type ConfirmConfig, type ConfirmResult } from './view-stack.js';
import { CommandError, commandCompletion, helpBody, parseCommand, resolveArgument, type ParsedCommand } from './commands.js';
import { TIPS, WelcomeScreen, probeWelcomeLock, readWelcomeFacts, welcomeStatusSegments } from './welcome.js';
import { COMPACT_VERSION_CHANGED, CONTINUE_TAIL_UNFINISHED, VERSION_CHANGED_HINT, readContinuation, type Continuation } from '../continuation.js';
import { currentExecutionVersion } from '../execution-version.js';
import { RecoveryPanel, OWNER_RELEASE_RISK, disabledInputLines, readRecoveryFacts, recoveryPages, type RecoveryAction } from './recovery.js';
import { mayWrite, SHOW_READ_ONLY, type WriteAccess } from './write-access.js';
import { findQueueItem } from '../control.js';
import { readOpenQueue, readQueueReattachment, queueWithdrawalBlocked, latestPending, type QueueEntry, type QueueConfirmation } from '../queue.js';
import { QueueStrip, QueueView, queueConfirmation, queueContent } from './queue.js';

/** 全屏视图（视图栈条目）的种类。 */
type PanelKind='help'|'exit'|'trace-raw'|'queue'|'history'|'eval'|'eval-plan'|'eval-trial'|'storage'|'trace'|'improve-home'|'improve'|'improve-selection'|'metrics';
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
  /** `pi-durio resume s-…`：指向该会话（会话身份）的链尾，按链尾状态处理（U6）。 */
  resume?:string;
  /** `pi-durio resume` 不带号：打开当前工作区的会话列表。 */
  sessions?:boolean;
  /** `pi-durio show`：只读查看，不能提交、不取锁、不调度；`session` 时打开会话层，主区为 `run`。 */
  show?:{run:string;session?:string};
  /** 工作区取自会话记录且与当前目录不同：头部写明。 */
  elsewhere?:boolean;
  terminal?:Terminal; draftRoot?:string; copy?:(text:string)=>Promise<boolean|string>;
  /** Only deterministic injected-terminal tests may skip native measurement. */
  widthCalibration?:false;
  /** Host-prepared Linux eval runtime; default dataRoot/eval-runtime. No implicit install. */
  improveRuntime?:string;
}
export interface TuiExit { result?:RunResult; cleanupResult?:RunResult; error?:string; draftSaved:boolean; summary:string[]; eval?:EvalExitFact;evalCleanup?:EvalCleanupReceipt;batchCleanup?:ImproveCleanupReceipt; widthCalibration?:ReturnType<TerminalWidthGate['snapshot']>; }

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
  /** show is an entry-point capability, independent of coding tool authorization or busy state. */
  private readonly writeAccess:WriteAccess={writeBlocked:()=>this.options.show?SHOW_READ_ONLY:this.evalCleanupUnknown?'批次清理未确认 · 停止新工作，先核对资源':undefined,feedback:text=>{this.notice=text;this.feedback(text);}};
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
  private coding=false;
  private model='deepseek-flash';
  private result?:RunResult;
  /** 最近实际返回的 runtime 清理事实；独立 improve 分析不更换主会话，但仍须报告其清理结果。 */
  private cleanupResult?:RunResult;
  private cleanupAttempted=false;
  private readonly cleanupReceipts=new ProcessCleanupReceipts();
  /** #82：仅在本进程请求停止并等待 runner/VM 后填写；不从历史计划推断。 */
  private evalExit?:EvalExitFact;
  private evalCleanupUnknown=false;
  private evalCleanup?:EvalCleanupReceipt;
  private evaluation?:{source:PlanSource;action:EvalAction;stopRequested:boolean;receipt?:EvalCleanupReceipt;startedAt:number;preparing:boolean;loading?:LoadingState};
  private stoppingEval?:Promise<void>;
  private readonly trialClosures=new Set<Promise<void>>();
  private readonly startedAt=Date.now();
  private active?:Promise<void>;
  private controller?:AbortController;
  private cancellation:'stop'|'exit'='exit';
  private readonly control=new TaskControl();
  private queue:QueueItemFact[]=[];
  private queueEntries:QueueEntry[]=[];
  private readonly queueStrip=new QueueStrip();
  private lastBackspace=-Infinity;
  private queueView?:QueueView;
  private queueActing=false;
  private recovery?:RecoveryReport;
  private viewingRecovery=false;
  /** 1c 面板（U3）：会话屏内、状态行之上；Esc 关闭后状态行 `◈ 恢复核对` 保留，Enter 或点击重开。 */
  private recoveryPanel?:RecoveryPanel;
  private recoveryOpen=false;
  private recoveryChecking=false;
  private recoveryGeneration=0;
  private recoveryLoading?:LoadingState;
  private recoveryAbort?:AbortController;
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
  private metricsView?:StatsBrowser;
  private evalList?:EvalListView;
  private evalPlan?:EvalPlanView;
  private evalTrial?:TrialTraceView;
  /** 2b 计划层的宿主：Enter 在其上压入 trial trace 层。 */
  private readonly evalHost:PlanViewHost={openTrial:(source,report,trialId)=>{this.evalTrial=new TrialTraceView(source,report,trialId,()=>this.tui.requestRender(),this.copy);this.pushView('eval-trial');}};
  private improveView?:ImproveView;
  private improveHome?:ImproveHome;
  /** 进行中的 improve 分析：空闲时发起（主区与 runId 留在当前会话），或排队后在任务结束时开始（queued）。 */
  private analysis?:{requestId:string;runId?:string;queued:boolean};
  private improveSelectionView?:ImproveSelectionView;
  private readonly improveSelections=new Map<string,ImproveSelectionView>();
  /** #82 uses origin from PlanSource to stop this entire submission and await cleanup. */
  readonly improveBatch:ImproveBatchController;
  private storageView?:StorageView;
  private traceView?:TraceView;
  private traceRaw?:TraceRawView;
  private hidePanel?:()=>void;
  /** 即时反馈：临时替换底栏键位提示行（全屏视图保留最右边的 Esc），下一次按键后恢复（U12）。 */
  private hintFeedback?:string;
  /** 视图或会话屏之上的确认框；打开时消费全部按键。 */
  private dialog?:{box:{render(columns:number,rows:number):string[];handleInput(data:string):ConfirmResult};hide:()=>void;confirm:(selected:number[])=>void};
  private pendingRefresh=false;
  private timer?:ReturnType<typeof setInterval>;
  private started=false;
  private stopped=false;
  private exiting?:Promise<TuiExit>;
  private failure?:string;
  private historyWindow=false;
  private removeInput?:()=>void;
  private restoreTerminalWrite?:()=>void;
  private restoreMeasurementWrite?:()=>void;
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
  /** 下一次空闲 Enter 接续的会话里的一个 run（链尾按会话推导）；improve 分析的结果不改变它（T3）。 */
  private continueFrom?:string;
  private continuationMemo?:{key:string;value?:Continuation};
  /** resume 的链尾正在被其他进程执行：欢迎屏锁探测显示被占用，不能提交。 */
  private occupied=false;

  constructor(private readonly options:TuiOptions) {
    if(options.widthCalibration===false&&!options.terminal)throw Error('WIDTH_CALIBRATION_TEST_TERMINAL_REQUIRED');
    options.workspace=realpathSync(options.workspace);
    options.dataRoot=resolve(options.dataRoot);
    this.coding=!!options.coding;
    this.improveBatch=new ImproveBatchController(options.dataRoot);
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
    this.scroll=new class extends ScrollView {
      override updateLayout(contentHeight:number,viewportHeight:number,requestRender:()=>void) {
        const following=this.isFollowingEnd;
        super.updateLayout(contentHeight,viewportHeight,requestRender);
        // 菜单开关改变视口高度；回到末尾的同一行不等于用户重新开启了跟随。
        if(!following&&this.isFollowingEnd)this.scrollTo(this.scrollTop,{disableFollow:true});
      }
    }(this.transcript,{follow:'end',primary:true});
    // 1b（U2）：头部一行；主区；状态行；输入框；底栏用量与键位提示（状态反馈替换键位提示行）。
    // 窗口宽敞时（U10）头部下方、运行状态行上方各一条区块分隔线；矮窗口先收它们。
    const header:Component={invalidate(){},render:width=>{const state=this.headerState();return [headerLine(state,width,narrowing(width,state,this.statusParts()).headerRight),...(this.roomy()?[rule(width)]:[])];}};
    const status:Component={invalidate(){},render:width=>{const parts=this.statusParts();return [...(this.roomy()?[rule(width)]:[]),statusLine(parts,width,narrowing(width,this.headerState(),parts).statusHint)];}};
    // 底栏（U10）：左侧用量，右侧键位提示与即时反馈；放不下时退回两行。1c 收起用量时只剩提示。
    const footer:Component={invalidate(){},render:width=>footerLines(this.recoveryPlan(width).usage?this.footerLeft():[],this.sessionHints(),width,{feedback:this.hintFeedback??(this.notice||undefined),keepLast:'? 帮助'})};
    const bottomPad:Component={invalidate(){},render:width=>[styledLine([],width)]};
    const recoveryPanel:Component={invalidate(){},render:width=>{const lines=this.recoveryLoading?.isShowing?[this.recoveryLoading.renderLine(width),hintLine([],width,{esc:'Esc 返回查看'})]:this.recoveryPanel?.render(width,this.recoveryPlan(width).panel)??[];this.widths?.inspect(lines);return lines;}};
    // 1c 浮层（U3、U10）：恢复面板为居中圆角框，盖在变灰的主区上；只在宽敞窗口使用。
    const recoveryArea:Component={invalidate(){},render:width=>{
      const plan=this.recoveryPlan(width),boxWidth=this.recoveryBoxWidth(),inner=boxWidth-4;
      const content=this.recoveryLoading?.isShowing?[this.recoveryLoading.renderLine(inner),hintLine([],inner,{esc:'Esc 返回查看'})]:this.recoveryPanel?.render(inner,plan.panel,undefined,{wide:true,airy:plan.airy})??[];
      this.widths?.inspect(content);
      const transcript=this.transcript.render(width),base=transcript.slice(Math.max(0,transcript.length-plan.area));
      while(base.length<plan.area)base.unshift('');
      const lines=composeOverlay(base,frameBox(content,boxWidth),width);
      return this.dialog?lines.map(line=>dimForOverlay(line)):lines;
    }};
    const disabledInput:Component={invalidate(){},render:width=>disabledInputLines(this.editor.getExpandedText(),width)};
    const queue:Component={invalidate(){},render:width=>this.queueStrip.render(this.sessionQueue(),width,this.terminal.rows),handleMouse:event=>{
      if(event.type==='click'){const id=this.queueStrip.hit(event.x-sideMargin(this.terminal.columns),event.y);if(id){void this.queueDecision(id,'withdraw');return {handled:true};}}
      return undefined;
    }};
    // 点击状态栏的 `◈ 恢复核对` 重开面板（U3）。
    const statusRegion=new MouseRegion(status,event=>{
      if(event.type==='click'&&this.viewingRecovery&&!this.recoveryOpen&&this.runId){void this.openRecovery(this.runId);return {handled:true};}
      return undefined;
    });
    // 菜单只使用主区剩余行；窄屏不让默认 stack shrink 挤掉头部、状态或输入。
    const autocomplete=this.editor.separateAutocomplete(()=>{
      const width=this.terminal.columns,rows=this.terminal.rows;
      const fixed=topMargin(rows)+bottomMargin(rows)+footer.render(width).length+Math.min(6,Math.max(3,this.editor.render(width).length));
      return rows-fixed-(this.welcome?0:header.render(width).length+statusRegion.render(width).length+queue.render(width).length);
    });
    if(!options.runId&&!options.show){
      const tip=TIPS[Math.floor(Math.random()*TIPS.length)];
      this.welcome=new WelcomeScreen({coding:!!options.coding,
        read:()=>readWelcomeFacts({workspace:options.workspace,dataRoot:options.dataRoot,coding:!!options.coding,mode:options.mode,toolEnvironment:options.toolEnvironment},id=>this.shown('session',id),tip),
        height:width=>this.terminal.rows-topMargin(this.terminal.rows)-bottomMargin(this.terminal.rows)-this.footerRows(width)-Math.min(6,Math.max(3,this.editor.render(width).length))-autocomplete.render(width).length,
        open:session=>{try{this.command(parseCommand(`/history ${session}`));}catch(error){this.notice=error instanceof CommandError?error.line:safe(String(error));}this.tui.requestRender();},
        changed:()=>this.tui.requestRender(),inspect:lines=>this.widths?.inspect(lines)});
    }
    const welcome=this.welcome?[{component:this.welcome,basis:0,grow:1,visible:()=>!!this.welcome}]:[];
    // 1c 时：头部 → 主区 → 恢复面板 → 状态行 → 已禁用的输入框 → 底栏；高度不够时按 recoveryPlan 依次收起。
    const topPad:Component={invalidate(){},render:width=>[styledLine([],width)]};
    const layout=new VStack([{component:topPad,basis:1,visible:()=>topMargin(this.terminal.rows)>0},{component:header,basis:'auto',visible:()=>!this.welcome},...welcome,
      {component:this.scroll,basis:0,grow:1,visible:view=>!this.welcome&&!this.recoveryOverlay()&&this.recoveryPlan(view.width).main},
      {component:recoveryArea,basis:0,grow:1,minSize:1,visible:()=>this.recoveryOverlay()},
      {component:recoveryPanel,basis:'auto',visible:()=>!this.welcome&&!this.recoveryOverlay()&&this.viewingRecovery&&(!!this.recoveryLoading?.isShowing||this.recoveryOpen&&!!this.recoveryPanel)},
      {component:autocomplete,basis:'auto',visible:()=>!this.viewingRecovery},
      {component:statusRegion,basis:'auto',visible:()=>!this.welcome},
      {component:queue,basis:'auto',visible:()=>!this.welcome&&!this.viewingRecovery&&this.queueEntries.length>0},
      {component:this.editor,basis:'auto',shrink:1,minSize:3,maxSize:6,visible:()=>!this.viewingRecovery},
      {component:disabledInput,basis:3,visible:view=>this.viewingRecovery&&this.recoveryPlan(view.width).input},
      {component:footer,basis:'auto',visible:view=>this.recoveryPlan(view.width).hints},
      {component:bottomPad,basis:1,visible:()=>bottomMargin(this.terminal.rows)>0}]);
    const root:Component={invalidate:()=>layout.invalidate(),render:width=>{
      if(width<40 || this.terminal.rows<12) return new Text(`窗口过小：建议至少 40 × 12 字符格（待真实终端确认）\n当前 ${width} × ${this.terminal.rows}\n扩大窗口继续；${this.dialog?'Esc 关闭确认框':'Ctrl+C 中止/再次退出'}。草稿保留。`,0,0).render(width).slice(0,this.terminal.rows);
      return layout.render(width);
    }};
    // Viewport layout renders the leaf components directly, bypassing VStack.render.
    // Keep each component identity so focus, scrolling, mouse regions and sizing remain intact.
    // Side margins (U10) are painted here: each component renders at the inner width.
    for(const component of [header,this.transcript,recoveryPanel,statusRegion,queue,autocomplete,this.editor,disabledInput,footer,...welcome.map(entry=>entry.component)]){
      const render=component.render.bind(component);
      component.render=width=>{const margin=sideMargin(width),lines=inset(render(width-2*margin),width,margin);return this.dialog?lines.map(line=>dimForOverlay(line)):lines;};
      if(component===this.editor||component===autocomplete){
        const mouse=component.handleMouse!.bind(component);
        component.handleMouse=event=>{const margin=sideMargin(event.width);return mouse({...event,x:event.x-margin,width:event.width-2*margin});};
      }
    }
    // Preserve upstream layout-node behavior by selecting the appropriate layout on resize.
    const resizeLayout=()=>this.tui.setLayoutRoot(this.terminal.columns<40||this.terminal.rows<12?root:layout);
    const originalStart=this.terminal.start.bind(this.terminal);
    this.terminal.start=(input,resize)=>originalStart(data=>{
      // Query replies are not user actions and must not revoke the confirmation they helped paint.
      if(this.widths?.consumeTerminalReply(data))return;
      processMeasurements.input(data);
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
    // Observe the real write underneath the width gate: a blocked frame is not a written frame.
    const measuredWrite=this.terminal.write;
    this.terminal.write=data=>{measuredWrite.call(this.terminal,data);processMeasurements.paint(data);};
    this.restoreMeasurementWrite=()=>{this.terminal.write=measuredWrite;};
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
    // Route owner detail pages after the width gate, before pi-tui consumes page keys for its primary transcript.
    const gatedStart=this.terminal.start.bind(this.terminal);
    this.terminal.start=(input,resize)=>gatedStart(data=>{
      if(this.phase==='idle'&&this.viewingRecovery&&this.recoveryOpen&&this.recoveryPanel?.pageable&&!this.dialog&&!this.panel&&(matchesKey(data,'pageUp')||matchesKey(data,'pageDown'))&&this.input(data)?.consume)return;
      input(data);
    },resize);
    this.tui.start();
    // Display snapshots are asynchronous. Their synchronous execution-material read
    // claims a query hold only after any in-flight terminal measurement has settled.
    if(this.runId){this.pendingRefresh=true;void this.openRecovery(this.runId);}
    else if(this.options.trace)this.openTrace(this.options.trace);
    else if(this.options.resume)void this.resumeSession(this.options.resume);
    else if(this.options.show){this.welcome=undefined;this.runId=this.options.show.run;this.pendingRefresh=true;this.openHistory(this.options.show.session?{session:this.options.show.session}:{run:this.options.show.run});}
    else if(this.options.sessions)this.openHistory({project:this.options.workspace});
    this.widths?.inspect();
    this.terminal.write('\x1b[?1004h'); // Focus reports invalidate any pending exit confirmation.
    this.timer=setInterval(()=>{if(this.pendingRefresh)this.refresh();else if(this.phase!=='idle'||this.panel?.kind==='eval-plan'&&this.evalPlan?.live)this.tui.requestRender();},SPINNER_INTERVAL_MS);
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
    return {workspace:safe(workspace.startsWith(`${home}/`)?`~${workspace.slice(home.length)}`:workspace),readOnly:!this.coding||!!this.options.show,elsewhere:this.options.elsewhere,
      session:chain?this.shown('session',chain.id):undefined,run:this.runId?this.shown('run',this.runId):undefined,task:chain?.number,
      ...(this.phase==='running'&&!this.analysis&&!this.improveBatch.running?{round:round||undefined}:{status:this.runStatus()})};
  }
  private statusParts() {
    if(this.activity?.kind==='improve-execution')this.activity.progress=this.improveBatch.progress();
    if(this.activity?.kind==='eval'&&this.evaluation)try{this.activity.trial=readEvalProgress(this.evaluation.source);}catch{/* Keep last acquired progress. */}
    // improve 分析期间：第 M 轮与计时取分析 run（#59 第 5 节）。
    const run=this.analysis?this.analysis.runId:this.runId,progress=run?this.views.get(run)?.progress:undefined,start=progress?.segmentStart;
    // 计时从当前执行段开始（run.started，恢复后为 recovery.started），不计中断时间（T2）。
    return statusParts({phase:this.phase,recovery:this.viewingRecovery,status:this.runStatus(),activity:this.activity,round:progress?.round??0,retry:progress?.retry??false,
      elapsedMs:this.improveBatch.running?this.improveBatch.elapsedMs:this.phase==='running'&&start?Date.now()-Date.parse(start):undefined,frame:Math.floor(Date.now()/SPINNER_INTERVAL_MS)});
  }
  private prefix() {return estimateTaskPrefix({dataRoot:this.options.dataRoot,workspace:this.options.workspace,coding:!!this.coding,mode:this.options.mode,toolEnvironment:this.options.toolEnvironment});}
  private contextUsage() {return `ctx ${this.context.estimated?'≈':''}${tokenCount(this.context.tokens)} / ${tokenCount(this.context.contextWindow)}`;}
  /** 窗口宽敞（不矮于 30 行）：会话屏画区块分隔线与留白；更矮时先收它们（U10）。 */
  private roomy() {return bottomMargin(this.terminal.rows)>0;}
  /** 底栏左侧：1a 空闲时是欢迎屏的状态（#71），否则是 1b 的用量。 */
  private footerLeft() {
    if(this.welcome&&this.phase==='idle'&&!this.viewingRecovery)return welcomeStatusSegments(this.welcome.facts.model.id,this.contextUsage());
    const usage=this.usageText();
    return usageSegments(this.model,this.contextUsage(),usage.scope,usage.tokens,usage.cost);
  }
  /** 底栏占的行数：用量与键位提示合成一行，放不下时两行。 */
  private footerRows(width:number) {
    const inner=width-2*sideMargin(width);
    return footerLines(this.footerLeft(),this.sessionHints(),inner,{feedback:this.hintFeedback??(this.notice||undefined),keepLast:'? 帮助'}).length;
  }
  /**
   * 底栏用量：运行时为本任务（当前 run），空闲时为本会话（上下文链上各 run 之和）；tok = 输入（含缓存命中）+ 输出。
   * 每次刷新或状态变化后重算一次；只是显示，读取失败只让金额未知。
   */
  private usageText() {
    const scope=this.phase==='running'&&!this.analysis&&!this.improveBatch.running?'本任务' as const:'本会话' as const,key=`${scope}:${this.runId}:${this.refreshes}`;
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
    if(this.viewingRecovery&&this.phase==='idle'&&this.recoveryInput(data))return {consume:true};
    if(this.tui.hasOverlay()) return undefined;
    if(this.editor.isShowingAutocomplete()) {
      this.confirmation=undefined;
      // Candidate menus own Enter/Esc/Ctrl+C/D; no outer cancellation/exit can leak through.
      if(ctrlC||ctrlD) this.editor.handleInput('\x1b');
      else this.editor.handleInput(data);
      this.tui.requestRender(); return {consume:true};
    }
    // 1a（U1）：输入框为空时 ↑↓ 选择最近会话、Enter 打开、Esc 取消；其他键先取消选中再照常处理。
    if(this.welcome&&this.phase==='idle'&&this.editor.focused&&!this.editor.getExpandedText()&&this.welcome.key(data)){this.tui.requestRender();return {consume:true};}
    if(matchesKey(data,'backspace')){
      const now=Date.now(),previous=this.lastBackspace;this.lastBackspace=now;
      if(this.editor.focused&&!this.editor.getExpandedText()){
        if(now-previous>=500){const item=latestPending(this.sessionQueue());if(item)void this.queueDecision(item.requestId,'withdraw');}
        return {consume:true};
      }
    }
    if(this.followChord&&matchesKey(data,'enter')){this.followChord=false;this.submit(this.editor.getExpandedText(),true);return {consume:true};}
    if(matchesKey(data,'ctrl+l')) {if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return {consume:true};}
    if(matchesKey(data,'ctrl+r')) {this.command(parseCommand('/history'));return {consume:true};}
    if(data==='?'&&this.editor.focused&&!this.editor.getExpandedText()) {this.openPanel('help');return {consume:true};}
    // Ctrl+O 展开或折叠全部工具行（T1、#41）；单行由点击切换。
    if(matchesKey(data,'ctrl+o')) {this.expandAll=!this.expandAll;this.toggled.clear();this.tui.requestRender();return {consume:true};}
    // improve 分析期间 Ctrl+T 打开分析 run 的 trace（#59 第 5 节）。
    if(matchesKey(data,'ctrl+t')) {this.openTrace(this.analysis?.runId??this.runId);return {consume:true};}
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
        // 恢复期间草稿灰显保留在输入框里（U3）。
        if(text) {this.drafts.save(text);this.savedDraft=text;if(!this.viewingRecovery){this.editor.setText('');this.lastText='';}}
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
    if(!mayWrite(this.writeAccess)){this.editor.setText(text);this.lastText=text;return;}
    if(this.occupied){
      this.editor.setText(text);this.lastText=text;this.notice='工作区被其他进程占用 · 正在重新核对，不能提交';this.tui.requestRender();
      void probeWelcomeLock(this.options.workspace,this.coding).then(async lock=>{
        if(lock.state==='held'||lock.state==='unknown'||lock.state==='probing'){this.notice='工作区被其他进程占用或状态未确认 · 不能提交';this.tui.requestRender();return;}
        this.occupied=false;
        if(this.options.resume)await this.resumeSession(this.options.resume);
        if(!this.viewingRecovery&&!this.occupied)this.notice='写入者锁已释放 · 草稿保留，现在可以提交 · 再按 Enter 提交';
        this.tui.requestRender();
      });return;
    }
    if(this.historyWindow||this.viewingRecovery){this.editor.setText(text);this.lastText=text;this.notice='只读历史/恢复视图不能提交；/bottom 返回活动会话，恢复限制仍需显式处置';this.tui.requestRender();return;}
    // improve 分析期间 Enter 保留文字、不受理，也不作为 steer；结束后下一次 Enter 接续当前会话（T3）。
    if(this.analysis){this.editor.setText(text);this.lastText=text;this.notice='improve 分析进行中 · 文字保留，未受理；分析结束后 Enter 接续当前会话';this.tui.requestRender();return;}
    if(this.evaluation){this.editor.setText(text);this.lastText=text;this.notice='eval 批次运行中 · 文字保留，未受理';this.tui.requestRender();return;}
    if(this.improveBatch.running){this.editor.setText(text);this.lastText=text;this.notice='improve 执行进行中 · 文字保留，未受理；结束后 Enter 接续当前会话';this.tui.requestRender();return;}
    if(this.phase==='running') {this.enqueue(text,followUp?'follow-up':'steer');return;}
    if(this.phase!=='idle') {this.editor.setText(text);this.lastText=text;this.notice='当前正在清理；草稿保留，未受理';this.tui.requestRender();return;}
    if(followUp){this.editor.setText(text);this.lastText=text;this.notice='当前没有运行任务；文本保留，按普通 Enter 明确提交新任务';this.tui.requestRender();return;}
    if(this.result?.status==='unknown'||this.result?.cleanup==='unknown') {this.editor.setText(text);this.lastText=text;this.notice='旧工作存在未知；只读查看，不能由 TUI 绕过恢复核对';this.tui.requestRender();return;}
    // 空闲 Enter 接续链尾（U13）；不能接续时开启新会话，原因已写在前序任务行的位置。
    this.continuationMemo=undefined;
    const continuation=this.continuation();
    if(continuation?.state==='recovery'){this.editor.setText(text);this.lastText=text;this.coding=continuation.coding;void this.openRecovery(continuation.tailRunId);return;}
    const contextRunId=continuation?.state==='ready'?continuation.tailRunId:undefined;
    this.coding=continuation?.state==='ready'?continuation.coding:!!this.options.coding;
    this.editor.addToHistory(text);this.editor.setText('');this.lastText='';
    if(!contextRunId)this.context=this.prefix();
    this.welcome=undefined;this.phase='running';this.result=undefined;this.runId=undefined;this.records=[];this.toggled.clear();this.events=[];this.historyWindow=false;this.scroll.scrollToEnd();
    this.confirmation=undefined;this.controller=new AbortController();this.cancellation='exit';this.rebuild();
    const self=this;
    const options:CodingTaskOptions={contextRunId,workspace:this.options.workspace,dataRoot:this.options.dataRoot,input:text,mode:this.options.mode,toolEnvironment:this.options.toolEnvironment,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:this.observe,beforeArtifactCapture:this.widths?()=>this.widths!.holdQueries():undefined};
    const run=this.coding?runCodingTask:runReadTask;
    this.beginCleanupAttempt();
    this.active=run(options).then(result=>this.applyResult(result)).catch(error=>{this.failure=String(error);this.notice=`未完成：${safe(String(error))}`;}).finally(()=>this.finished());
    this.tui.requestRender();
  }
  /** 按命令表解析后的命令分派；写法见 commands.ts。resolveArgument 的 CommandError 交给 submit 写状态行。 */
  private command(parsed:ParsedCommand) {
    const root=this.options.dataRoot,{positional,options}=parsed;
    const planArgument=(input:string)=>{try{return resolvePlanSource(root,input);}catch(error){throw new CommandError(safe(error instanceof Error?error.message:String(error)));}};
    const fail=(prefix:string,error:unknown)=>{if(error instanceof CommandError)throw error;this.notice=`${prefix}${safe(String(error))}`;this.tui.requestRender();};
    // 只读能力在各宿主动作入口核对；纯查看命令不依赖命令名黑名单。
    switch(parsed.path.length?`${parsed.spec.name} ${parsed.path.join(' ')}`:parsed.spec.name){
    case 'help':this.openPanel('help');break;
    case 'exit':this.requestExit();break;
    case 'restore':this.editor.setText(this.savedDraft??this.drafts.latest()??'');this.lastText=this.editor.getExpandedText();this.notice='草稿已恢复；尚未提交';break;
    case 'bottom':this.bottom();break;
    case 'older':this.window('older');break;
    case 'newer':this.window('newer');break;
    case 'stats':
      try{
        if(options.self&&Object.keys(options).some(key=>key!=='self'))throw new CommandError('--self 固定近 7 天、全部项目、日常来源，不接受其他筛选');
        let projects:string[]=[];
        if(!options.self&&options.project&&options.project!=='all'&&options.project!=='current'&&!isAbsolute(String(options.project))){
          try{projects=statsChoices(root,this.options.workspace).projects;}
          catch(error){
            if(!(error instanceof StatsChoicesLimitError))throw error;
            try{resolveProjectFilter(String(options.project),this.options.workspace,[]);}catch{throw error;}
          }
        }
        this.metricsView?.cancel();this.metricsView=new StatsBrowser(root,this.options.workspace,statsRequest(options,this.options.workspace,new Date(),projects),{copy:this.copy,feedback:text=>this.feedback(text),changed:()=>this.tui.requestRender(),annotate:(task,saved)=>this.annotateTask(task,saved),open:target=>{if(target.kind==='run'){this.traceView=this.traceOf(target.runId,target.root);this.pushView('trace');}else{this.openEvalPlan(target.source);}}},{tab:options.self?'self':'metrics',self:{dimensions:()=>({columns:this.terminal.columns,rows:this.terminal.rows}),busy:()=>this.phase!=='idle'}});this.openPanel('metrics');}catch(error){fail('任务指标不可读取：',error);}
      break;
    case 'acceptance':
      if(!mayWrite(this.writeAccess))break;
      if(typeof options.note==='string'&&options.note.length>1000)throw new CommandError('补记说明最多 1000 字符');
      this.annotateTask(undefined,undefined,options as AnnotationPrefill,positional[0]?resolveArgument(root,positional[0],['task']).id:undefined);break;
    case 'eval':{
      const source=positional[0]===undefined?undefined:planArgument(positional[0]);
      try{
        if(source){this.openEvalPlan(source,true);}
        else{this.evalList=new EvalListView(root,{openPlan:source=>{this.openEvalPlan(source);if(planState(readPlanReport(source).report)==='not-started')this.confirmEval(source,'run');}});this.openPanel('eval');}
      }catch(error){fail('Eval记录不可读取：',error);}
      break;
    }
    case 'eval run':case 'eval grade':{
      const source=planArgument(positional[0]),action=parsed.path[0] as EvalAction;
      const cases=options.case===undefined?undefined:String(options.case).split(',');
      try{if(cases?.some(id=>!readPlanReport(source).report.plan.cases.some(c=>c.id===id)))throw new CommandError('未知 eval 案例',['--case 使用计划内案例 id']);this.confirmEval(source,action,cases,true);}catch(error){fail('eval 未启动：',error);}break;
    }
    case 'storage':this.storageView=new StorageView(root,{writeBlocked:this.writeAccess.writeBlocked,changed:()=>this.tui.requestRender(),busy:()=>this.phase!=='idle',feedback:text=>this.feedback(text),confirm:(config,confirm)=>this.openConfirm(config,()=>void confirm())});this.openPanel('storage');break;
    case 'history':{
      const filter:HistoryTarget=historyScope(options,this.options.workspace,historyProjects(root));
      if(positional[0]!==undefined){
        const target=resolveArgument(root,positional[0],['session','run']);
        if(target.kind==='session')filter.session=target.id;else filter.run=target.id;
      }
      this.openHistory(filter);break;
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
    case 'queue':this.openQueue();break;
    case 'follow-up':{if(!mayWrite(this.writeAccess))break;const draft=this.editor.getExpandedText();if(draft)this.submit(draft,true);else this.notice='输入后按 Ctrl+X → Enter，明确排到下一任务';break;}
    case 'withdraw':case 'reattach':
      // 撤回直接执行；重新接入只预填确认框（T1、T3、U13）。
      if(!positional.length){this.openQueue();break;}
      void this.queueDecision(resolveArgument(root,positional[0],['queue-request']).id,parsed.spec.name as 'withdraw'|'reattach');break;
    case 'compact':void this.compact();break;
    case 'improve history':{
      const id=positional[0]===undefined?undefined:resolveArgument(root,positional[0],['improve-report']).id;
      try{this.openImproveHistory(id);}catch(error){fail('improve 报告不可读取：',error);}
      break;
    }
    case 'improve suppressions':try{this.openImproveHistory(undefined,false,true);}catch(error){fail('',error);}break;
    case 'improve continue':case 'improve rollback':case 'improve restore':
      if(!mayWrite(this.writeAccess))break;
      this.improveManagement().command(parsed.path[0] as 'continue'|'rollback'|'restore',positional[0],{reason:options.reason as string|undefined,note:options.note as string|undefined});break;
    case 'improve register':case 'improve unregister':
      this.improveManagement().source(parsed.path[0] as 'register'|'unregister',positional[0],positional[1]);break;
    case 'improve':{
      if(!positional[0]){if(Object.keys(options).length)throw new CommandError('选择参数需要先写报告号',['/improve ir-号 --execute C-01']);this.openImproveHome();break;}
      const id=resolveArgument(root,positional[0],['improve-report']).id,report=readReportRecord(root,id);if(!report)throw new CommandError('报告不可读取');
      try {const prefill=improveSelectionPrefill(root,report,options);if(prefill.length&&!mayWrite(this.writeAccess))break;this.openImproveSelection(id,prefill,true);}
      catch(error){throw error instanceof CommandError?error:new CommandError(improveChoiceError(error),['本报告的 C-号或完整 id']);}break;
    }
    case 'improve new':{
      if(!mayWrite(this.writeAccess))break;
      const sources=typeof options.source==='string'?options.source.split(',') as ('self'|'eval')[]:undefined;
      for(const kind of sources??[])if(!listRegisteredSources(root,this.options.workspace).some(r=>r.kind===(kind==='self'?'self-source':'eval-asset')))throw new CommandError(`--source ${kind} 没有已登记的${kind==='self'?'自身源码':' eval 资产'}`,['/improve new 后在“附加来源”登记新路径']);
      this.openLaunch({scope:options.scope as LaunchPrefill['scope'],budget:options.budget as LaunchPrefill['budget'],sources,focus:typeof options.focus==='string'?options.focus:undefined});
      break;
    }
    }
  }
  /** improve 视图第一层（U13）：从会话屏打开，替换整个视图栈。 */
  private openImproveHome() {
    try{this.improveHome=new ImproveHome(this.options.dataRoot,{workspace:this.options.workspace,current:()=>this.improveCurrent()});this.openPanel('improve-home');}
    catch(error){this.notice=`improve 记录不可读取：${safe(String(error))}`;this.tui.requestRender();}
  }
  /** 第一层“进行中”一行：分析写轮次与计时，提交批次写 /improve 1d 的进度。 */
  private improveCurrent() {
    const activity=this.activity;
    if(activity?.kind!=='improve-analysis'&&activity?.kind!=='improve-execution')return undefined;
    return this.statusParts().left.map(s=>s.text).join('').replace(/ improve (分析|执行)/,' $1').replace(/ · \/improve 查看$/,'');
  }
  private openImproveItem(item:HomeItem) {
    const root=this.options.dataRoot;
    if(item.kind==='new'){this.openLaunch();return;}
    if(item.kind==='current'){const current=this.improveBatch.origin&&this.improveSelections.get(this.improveBatch.origin.reportId);if(current){this.improveSelectionView=current;current.showProgress();this.pushView('improve-selection');}else if(this.improveBatch.origin)this.openImproveHistory(this.improveBatch.origin.reportId,true);else this.feedback('分析进行中 · 结束后在会话主区插一行，报告出现在“待选择”');return;}
    if(item.kind==='report'){try{this.openImproveSelection(item.id);}catch(error){this.feedback(`improve 报告不可读取：${safe(String(error))}`);}return;}
    try{this.openImproveHistory(undefined,true,item.kind==='suppressions');}
    catch(error){this.feedback(`improve 报告不可读取：${safe(String(error))}`);}
  }
  private improveSubmitBlocked() {
    return this.writeAccess.writeBlocked()??(this.occupied?'工作区被其他进程占用':this.phase!=='idle'||this.activity||this.historyWindow||this.viewingRecovery||this.result?.status==='unknown'||this.result?.cleanup==='unknown'?'当前执行/恢复状态不允许新决定':undefined);
  }
  private improveManagement() {
    return new ImproveManagement(this.options.dataRoot,this.options.workspace,{...this.writeAccess,blocked:()=>this.improveSubmitBlocked(),
      confirm:(box,run)=>this.openDialog(box,run),run:(label,report,work)=>this.runImproveManagement(label,report,work),
      resume:(input,signal)=>this.resumeImproveBatch(input,signal),changed:()=>{this.improveView?.refresh();this.improveHome?.refresh();this.tui.requestRender();}});
  }
  private openImproveHistory(id?:string,nested=false,suppressions=false) {
    const management=this.improveManagement();
    const view=new ImproveView(this.options.dataRoot,id,suppressions,{workspace:this.options.workspace,action:a=>management.action(a),restore:id=>management.restore(id),feedback:text=>this.feedback(text),
      openEval:source=>this.openEvalPlan(source)});
    this.improveView=view;if(nested)this.pushView('improve');else this.openPanel('improve');
  }
  private async runImproveManagement(label:string,reportId:string|undefined,work:(signal:AbortSignal)=>Promise<unknown>) {
    if(!mayWrite(this.writeAccess))return;
    const blocked=this.improveSubmitBlocked();if(blocked){this.feedback(blocked);return;}
    this.phase='running';this.controller=new AbortController();this.cancellation='exit';
    if(label==='继续'){this.activity={kind:'improve-execution',report:this.shown('improve-report',reportId!)};this.improveBatch.resetCleanup();if(this.evalCleanup?.cleanup!=='unknown')this.evalCleanup=undefined;}
    this.active=work(this.controller.signal).then(()=>{this.notice=`✓ improve ${label}已结束 · /improve 查看`;this.event(this.notice);this.feedback(this.notice);})
      .catch(error=>{this.notice=`✗ improve ${label}未执行或未完成 · ${safe(String(error))}`;this.feedback(this.notice);})
      .finally(()=>this.finished());
    this.tui.requestRender();await this.active;
  }
  private resumeImproveBatch(input:ImproveResume,signal:AbortSignal) {
    const decision=readImproveDecision(this.options.dataRoot,input.id).decision as ImproveDecision;
    this.openImproveSelection(decision.reportId);
    if(this.improveSelectionView?.report.id!==decision.reportId||this.improveSelectionView.report.revision!==decision.reportRevision)throw Error('IMPROVE_REPORT_REVISION_DRIFT');
    const done=this.improveBatch.resume(input,signal);this.improveSelectionView.observeContinuation(decision,done);return done;
  }
  private openImproveSelection(id:string,prefill:ImprovePrefill=[],fromCommand=false) {
    const root=this.options.dataRoot,report=readReportRecord(root,id);if(!report)throw Error('IMPROVE_REPORT_NOT_FOUND');
    const contract=improveReportContract(report);
    if(contract==='legacy'||contract==='unknown'&&report.candidates.length>0){
      if(prefill.length)throw new CommandError('此报告只读，不能预填执行；请重新分析');
      if(fromCommand)this.openImproveHome();this.openImproveHistory(id,true);return;
    }
    let view=this.improveSelections.get(id);
    if(!view){view=new ImproveSelectionView(root,id,decision=>this.submitImproveChoice(decision),()=>this.tui.requestRender(),{
      access:this.writeAccess,installation:this.options.improveRuntime,submitBlocked:()=>this.improveSubmitBlocked(),
      openEval:source=>this.openEvalPlan(source),
    });this.improveSelections.set(id,view);}else view.refresh();
    if(prefill.length)view.prefill(prefill);
    if(fromCommand)this.openImproveHome();this.improveSelectionView=view;this.pushView('improve-selection');
  }
  /** 不能发起分析的原因（只读历史、恢复核对、清理中、已有分析、尚无任务）；可以时 undefined。 */
  private launchBlocked(targetRunId=this.runId) {
    const readOnly=this.writeAccess.writeBlocked();if(readOnly)return readOnly;
    if(this.historyWindow||this.viewingRecovery)return '只读历史/恢复视图不能发起分析 · /bottom 返回活动会话并完成核对';
    if(this.analysis)return '已有 improve 分析进行中 · 结束后再新建';
    if(this.activity)return '当前有后台工作进行中 · 结束后再新建分析';
    if(this.phase==='stopping'||this.phase==='exiting')return '正在清理 · 结束后再新建分析';
    if(this.phase==='running'&&!this.control.target())return '当前任务仍在受理或收尾 · 稍后再新建分析';
    if(this.phase==='idle'&&(this.result?.status==='unknown'||this.result?.cleanup==='unknown'))return '结果未知 · 先完成恢复核对';
    if(!targetRunId)return '尚无任务 · 先完成一个任务，再分析本会话';
    return undefined;
  }
  /**
   * 启动确认框（U4、U12）。“本会话”是当前任务所在的上下文链；忙时确认后独立排队（不作为 steer），
   * 绑定原会话与项目，取证截止点在分析开始时固定。
   */
  private openLaunch(prefill?:LaunchPrefill,binding?:{runId:string;sessionId:string}) {
    const blocked=this.launchBlocked(binding?.runId);
    if(blocked){if(this.panel)this.feedback(blocked);else{this.notice=blocked;this.tui.requestRender();}return;}
    const root=this.options.dataRoot,workspace=this.options.workspace,target=binding?.runId??(this.phase==='running'?this.control.target()!.runId:this.runId!);
    let dialog:ImproveLaunchDialog;
    try{dialog=new ImproveLaunchDialog({visible:improveVisibleFiles(root,workspace,target),registrations:listRegisteredSources(root,workspace),queued:this.phase==='running',
      ...(binding?{binding:[`原目标：${this.shown('session',binding.sessionId)} · ${this.shown('run',binding.runId)}`,`工作区：${workspace}`]}:{}),
      register:input=>{if(!mayWrite(this.writeAccess))throw Error('TUI_READ_ONLY');return withOwnerSync(root,()=>registerFromInput(root,workspace,input));},remove:id=>{if(!mayWrite(this.writeAccess))throw Error('TUI_READ_ONLY');withOwnerSync(root,()=>unregisterImproveSource(root,id));},complete:input=>completePath(workspace,input)},prefill);}
    catch(error){this.notice=`improve 启动框不可打开：${safe(String(error))}`;this.tui.requestRender();return;}
    this.openDialog(dialog,()=>{
      const blocked=this.launchBlocked(binding?.runId);if(blocked){this.notice=blocked;this.tui.requestRender();return;}
      if(binding&&this.phase!=='idle'){this.feedback('当前工作运行中 · 原分析未启动');return;}
      // 确认时绑定会话与登记选择；默认会话文件由宿主在分析开始时重新取得。
      const run=binding?.runId??(this.phase==='running'?this.control.target()!.runId:this.runId!);
      let request:ImproveRequest;try{request=improveRequest(randomUUID(),dialog.choice,improveVisibleFiles(root,workspace,run));}catch(error){this.notice=`尚未启动：${safe(String(error))}`;this.tui.requestRender();return;}
      this.closeViews();void this.startImprove(request,binding?.runId);
    });
  }
  private async startImprove(request:ImproveRequest,boundRunId?:string) {
    if(!mayWrite(this.writeAccess))return;
    if(this.phase==='running'){
      const target=this.control.target();if(!target){this.notice='当前任务仍在受理或收尾；分析未排队';this.tui.requestRender();return;}
      try{const item=await this.control.submit({id:request.id,kind:'improve',input:JSON.stringify(request),target});this.loadQueue();this.notice=`improve ${this.shown('improve-report',item.requestId)} 已排队 · 当前任务结束后开始 · ${this.shown('queue-request',item.requestId)} · /queue`;}
      catch(error){this.notice=`分析未排队：${safe(String(error))}`;}
      this.tui.requestRender();return;
    }
    const targetRunId=boundRunId??this.runId!;this.phase='running';this.controller=new AbortController();this.cancellation='exit';const self=this;
    this.analysis={requestId:request.id,queued:false};this.activity={kind:'improve-analysis',report:this.shown('improve-report',request.id)};
    // 主区、runId 与本进程的任务结果都留在当前会话；分析结果只插一行，不自动打开 1d（I1）。
    this.beginCleanupAttempt();
    this.active=analyzeImprove({dataRoot:this.options.dataRoot,workspace:this.options.workspace,targetRunId,request,mode:this.options.mode,transport:this.options.transport,signal:this.controller.signal,get cancellation(){return self.cancellation;},
      onObservation:event=>{this.cleanupReceipts.observe(this.options.dataRoot,event);if(this.analysis)this.analysis.runId=event.runId;this.pendingRefresh=true;}})
      .then(result=>{this.cleanupResult=result;this.analysisEnded(request.id,result.improve??null,result.status==='unknown'||result.cleanup==='unknown'?`清理未知 · pi-durio resume ${this.shown('session',result.sessionId)} 核对`:undefined);})
      .catch(error=>this.analysisEnded(request.id,readReportRecord(this.options.dataRoot,request.id),safe(String(error))))
      .finally(()=>this.finished());
    this.tui.requestRender();
  }
  /** 分析结束：主区插一行（完成写候选数，失败或达到上限写原因并说明不完整报告已保留）。 */
  private analysisEnded(requestId:string,report:{state:string;candidates:unknown[];reason:string|null}|null,problem?:string) {
    this.analysis=undefined;this.activity=undefined;
    const label=this.shown('improve-report',requestId);
    if(report?.state==='complete')this.event(`${report.candidates.length?`✓ improve ${label} 完成 · ${report.candidates.length} 个候选 · /improve 打开`:`✓ improve ${label} 完成 · 没有候选`}${problem?` · ${problem}`:''}`);
    else if(report)this.event(`✗ improve ${label} 未完成 · ${analysisReason(report.reason??problem??'未知')} · 不完整报告已保留`);
    else this.event(`✗ improve ${label} 未完成 · ${analysisReason(problem??'未知')}`);
  }
  /**
   * 任务 run 的观察回调。排队的 improve 分析在任务结束后由 runtime 在同一次执行里开始：它的 run 不进主区，
   * 只设状态行；之后的 follow-up run 照常成为主区的当前 run。
   */
  private readonly observe=(event:{kind:string;runId:string})=>{
    this.cleanupReceipts.observe(this.options.dataRoot,event);
    this.pendingRefresh=true;
    if(event.runId===this.runId||event.runId===this.analysis?.runId)return;
    let accepted:any;
    try{const ref=readRunRecords(this.options.dataRoot,event.runId,{limit:1,kinds:['task.accepted']}).records[0];accepted=ref&&JSON.parse(readObject(this.options.dataRoot,ref.ref).toString());}catch{/* Decided on a later observation. */}
    if(accepted?.kind==='improve'){this.analysis={requestId:accepted.improveRequestId,runId:event.runId,queued:true};this.activity={kind:'improve-analysis',report:this.shown('improve-report',accepted.improveRequestId)};return;}
    if(!accepted&&this.runId)return;
    if(this.analysis?.queued)this.analysisEnded(this.analysis.requestId,readReportRecord(this.options.dataRoot,this.analysis.requestId));
    this.runId=event.runId;
  };
  private openEvalPlan(source:PlanSource,direct=false) {
    this.evalPlan=new EvalPlanView(source,this.evalHost,{runningHere:()=>!!this.evaluation&&samePlan(source,this.evaluation.source)||this.improveBatch.canStop(source.origin),stoppingHere:()=>this.phase==='stopping'&&(!!this.evaluation&&samePlan(source,this.evaluation.source)||this.improveBatch.canStop(source.origin)),depth:direct?1:undefined});
    if(direct)this.openPanel('eval-plan');else this.pushView('eval-plan');
  }
  private confirmEval(source:PlanSource,action:EvalAction,cases?:string[],direct=false) {
    const blocked=()=>evalBlocked(source,action,{writeBlocked:this.writeAccess.writeBlocked(),busy:this.phase!=='idle'||this.viewingRecovery||this.historyWindow});
    const reason=evalBlocked(source,action,{writeBlocked:this.writeAccess.writeBlocked(),busy:this.phase!=='idle'||this.viewingRecovery||this.historyWindow,ignoreDeadline:true});if(reason){this.feedback(reason);return;}
    const config=action==='run'?evalRunConfirmation(source,blocked):evalGradeConfirmation(source,cases,blocked);
    if(direct)this.openEvalPlan(source,true);
    this.openConfirm(config,selected=>{const reason=blocked();if(reason){this.feedback(reason);return;}const chosen=action==='grade'?readPlanReport(source).report.plan.cases.filter((_c,i)=>selected.includes(i)).map(c=>c.id):undefined;this.startEval(source,action,chosen);});
  }
  private startEval(source:PlanSource,action:EvalAction,cases?:string[]) {
    const reason=evalBlocked(source,action,{writeBlocked:this.writeAccess.writeBlocked(),busy:this.phase!=='idle'});if(reason){this.feedback(reason);return;}
    this.phase='running';this.controller=new AbortController();this.cancellation='exit';this.welcome=undefined;
    const operation={source,action,stopRequested:false,startedAt:Date.now(),preparing:action==='run'} as NonNullable<typeof this.evaluation>;this.evaluation=operation;
    if(operation.preparing)operation.loading=new LoadingState('核对内容',source.label,()=>this.tui.requestRender());
    this.activity={kind:'eval',plan:source.label};
    this.active=executeEval(source,action,cases,this.controller.signal,receipt=>{operation.receipt=receipt;if(this.evalCleanup?.cleanup!=='unknown'||receipt.cleanup==='unknown')this.evalCleanup=receipt;},()=>{operation.preparing=false;operation.loading?.complete();this.tui.requestRender();}).then(report=>{
      this.evalCleanupUnknown ||= operation.receipt?.cleanup==='unknown';
      if(operation.stopRequested)this.evalExit=evalStoppedFact(source,report,operation.receipt);
      this.event(`${planState(report)==='stopped'?'◇':'✓'} eval ${source.label} ${action==='grade'?'评分修订已追加':planState(report)==='stopped'?'已停止':'已结束'} · ${report.plan.comparison?report.improvement:'不判改善'} · /eval ${source.label} 查看`);
    }).catch(error=>{if(operation.stopRequested){let report:EvalReport|undefined;try{report=evalReport(source.root,source.id);}catch{}this.evalExit=evalStoppedFact(source,report,operation.receipt);}this.evalCleanupUnknown ||= operation.receipt?.cleanup==='unknown'||this.evalExit?.cleanup==='unknown';this.event(`✗ eval ${source.label} ${operation.preparing?'未启动':'未完成'}：${safe(String(error))}`);}).finally(()=>{operation.loading?.complete();this.evaluation=undefined;this.evalPlan?.refresh();this.finished();});
    this.tui.requestRender();
  }
  private stopEval(source?:PlanSource):Promise<void> {
    if(this.stoppingEval)return this.stoppingEval;
    const own=this.evaluation;
    if(own&&(!source||samePlan(source,own.source))){own.stopRequested=true;this.controller?.abort();if(this.phase!=='exiting')this.phase='stopping';this.feedback(`请求停止 eval ${own.source.label} · 等待 VM 和写入者清理`);return this.active??Promise.resolve();}
    const origin=source?source.origin:this.improveBatch.origin;
    if(!origin||!this.improveBatch.canStop(origin))return Promise.resolve();
    const sources=listPlanSources(this.options.dataRoot).filter(s=>this.improveBatch.canStop(s.origin));
    if(!sources.length)return Promise.resolve();
    if(this.phase!=='exiting')this.phase='stopping';this.feedback('请求停止整个 improve 提交批次 · 等待 VM 和清理，剩余项不启动');
    return this.stoppingEval=(async()=>{
      await this.improveBatch.stop(origin);await this.active;
      for(const item of sources){let report:EvalReport|undefined;try{report=evalReport(item.root,item.id);}catch{}const receipt=this.improveBatch.evalCleanup.findLast(r=>r.dataRoot===item.root&&r.planId===item.id);if(receipt&&(this.evalCleanup?.cleanup!=='unknown'||receipt.cleanup==='unknown'))this.evalCleanup=receipt;const fact=evalStoppedFact(item,report,receipt);if(!this.evalExit||fact.cleanup==='unknown'||this.evalExit.cleanup!=='unknown')this.evalExit=fact;this.evalCleanupUnknown ||= fact.cleanup==='unknown';}
      const cleanup=this.improveBatch.cleanup;if(!cleanup||cleanup.owner!=='released'||cleanup.storage==='unknown'||cleanup.workspaces.some(w=>!w.released))this.evalCleanupUnknown=true;
      this.evalPlan?.refresh();this.tui.requestRender();
    })().finally(()=>{this.stoppingEval=undefined;});
  }
  private closeTrial() {
    if(!this.evalTrial)return;const closing=this.evalTrial.close();this.trialClosures.add(closing);void closing.then(()=>this.trialClosures.delete(closing),error=>{this.failure??=`trial 原文副本清理失败：${String(error)}`;});
  }
  private async submitImproveChoice(decision:ImproveDecision){
    if(!mayWrite(this.writeAccess))throw Error('TUI_READ_ONLY');
    const blocked=this.improveSubmitBlocked();if(blocked)throw Error(blocked);
    this.phase='running';this.controller=new AbortController();this.cancellation='exit';this.activity={kind:'improve-execution',report:this.shown('improve-report',decision.reportId)};
    if(this.evalCleanup?.cleanup!=='unknown')this.evalCleanup=undefined;
    const promise=this.improveBatch.start(decision,this.controller.signal);
    this.active=promise.then(value=>{const passed=value.groups.filter((g:any)=>g.state==='completed').length,total=value.groups.length;this.event(`${value.state==='completed'?'✓':'✗'} improve ${this.shown('improve-report',decision.reportId)} ${value.state==='completed'?'已结束':'已停止'} · ${total?`${passed}/${total} 组通过`:`${decision.selections.length} 项决定已记录`}${value.reason?' · '+safe(value.reason):''} · /improve 查看`);}).catch(error=>{this.event(`✗ improve ${this.shown('improve-report',decision.reportId)} 未完成：${safe(String(error))}`);}).finally(()=>this.finished());
    return promise;
  }
  private async compact() {
    if(!mayWrite(this.writeAccess))return;
    if(this.historyWindow||this.viewingRecovery){this.notice='只读历史/恢复视图不能压缩；先返回活动会话并完成恢复核对';this.tui.requestRender();return;}
    if(this.phase==='running'){this.enqueue('compact','compact');return;}
    // 空闲手动压缩针对可接续的链尾；链尾执行版本与当前不同时不可用（E8）。
    const continuation=this.phase==='idle'?this.continuation():undefined;
    if(continuation?.state!=='ready'){this.notice='压缩需要已完成且清理确认的活动会话';this.tui.requestRender();return;}
    if(continuation.versionChanged!==false){this.notice=COMPACT_VERSION_CHANGED;this.tui.requestRender();return;}
    const runId=continuation.tailRunId;this.controller=new AbortController();this.cancellation='exit';this.phase='running';this.notice='正在压缩当前上下文；原文保留，摘要生成与接入分别记录';const self=this;
    this.beginCleanupAttempt();
    this.active=compactContext({dataRoot:this.options.dataRoot,runId,requestId:randomUUID(),authorization:this.authorization(),transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:event=>{this.cleanupReceipts.observe(this.options.dataRoot,event);this.pendingRefresh=true;}}).then(result=>{
      this.result=result;this.cleanupResult=result;this.viewingRecovery=result.status!=='completed'||result.cleanup!=='confirmed';this.notice=`上下文压缩 ${result.compaction?.state??result.status}；Ctrl+T 在 trace 中查看源范围、摘要与接入事实；磁盘原文保留`;
    }).catch(error=>{this.notice=`压缩未执行：${safe(String(error))}`;}).finally(()=>this.finished());
    this.tui.requestRender();await this.active;
  }
  private beginCleanupAttempt() {this.cleanupAttempted=true;this.cleanupResult=undefined;}
  private applyResult(result:RunResult) {
    this.result=result;this.cleanupResult=result;this.runId=result.runId;
    if(result.improve?.runId!==result.runId)this.continueFrom=result.runId;
    this.viewingRecovery=result.status==='unknown'||result.cleanup==='unknown';
    // 终态在状态行与头部；这里只留需要处理的事。
    this.notice=result.controls?'队列已冻结；/queue 查看目标与原因，普通输入不会接入旧项':result.cleanup!=='confirmed'?'清理未知；原工作保留 · Enter 打开恢复核对':'';
  }
  /** 后台完成事件：在主区末尾插一行。 */
  private event(text:string) {this.events.push(text);this.rebuild();}
  private finished() {
    if(this.analysis?.queued)this.analysisEnded(this.analysis.requestId,readReportRecord(this.options.dataRoot,this.analysis.requestId));
    for(const receipt of this.improveBatch.evalCleanup){if(this.evalCleanup?.cleanup!=='unknown'||receipt.cleanup==='unknown')this.evalCleanup=receipt;this.evalCleanupUnknown ||= receipt.cleanup==='unknown';}
    const batchCleanup=this.improveBatch.cleanup;this.evalCleanupUnknown ||= !!batchCleanup&&(batchCleanup.owner!=='released'||batchCleanup.storage==='unknown'||batchCleanup.workspaces.some(w=>!w.released));
    this.analysis=undefined;this.activity=undefined;if(this.phase!=='exiting')this.phase='idle';this.pendingRefresh=true;this.refresh();if(this.phase!=='exiting'){void this.welcome?.refresh().catch(error=>{this.notice=`欢迎屏事实不可读取：${safe(String(error))}`;});}this.confirmation=undefined;this.followChord=false;this.tui.requestRender();
  }
  private enqueue(text:string,kind:'steer'|'follow-up'|'compact'|'improve') {
    if(!mayWrite(this.writeAccess))return;
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
    try {this.queueEntries=readOpenQueue(this.options.dataRoot,this.options.workspace,this.runId);this.queue=this.queueEntries.map(entry=>entry.item);this.queueView?.setEntries(this.queueEntries);}
    catch(error){if(!String(error).includes('ENOENT'))this.notice=`队列事实不可取得：${safe(String(error))}`;}
  }
  private sessionQueue(){const session=this.runId&&this.chainOf(this.runId)?.id;return session?this.queueEntries.filter(entry=>entry.sessionId===session):[];}
  private prepareQueue(id?:string) {
    this.queueView??=new QueueView(this.options.dataRoot,this.options.workspace,{...this.writeAccess,copy:this.copy,changed:()=>this.tui.requestRender(),
      withdraw:requestId=>void this.queueDecision(requestId,'withdraw'),reattach:requestId=>void this.queueDecision(requestId,'reattach')});
    this.loadQueue();if(id)this.queueView.select(id);
  }
  private openQueue(id?:string) {
    this.prepareQueue(id);if(this.panel?.kind!=='queue')this.openPanel('queue');
  }
  private authorization():RecoveryAuthorization {return {workspace:this.options.workspace,mode:this.options.mode,tools:this.coding?['read','write','edit','bash']:['read'],toolEnvironment:this.options.toolEnvironment};}
  private queueBusy() {
    return this.occupied?'工作区被其他进程占用':this.phase!=='idle'?'当前工作运行或清理中':this.activity?'当前有后台工作进行中':
      this.historyWindow?'只读历史视图不能重新接入':this.viewingRecovery||this.recoveryChecking||this.result?.status==='unknown'||this.result?.cleanup==='unknown'?'会话待恢复核对':undefined;
  }
  private async queueDecision(input:string,action:'withdraw'|'reattach') {
    if(!mayWrite(this.writeAccess))return;
    if(this.queueActing){this.feedback('队列决定正在提交 · 请稍候');return;}
    let requestId:string;try{requestId=resolveDisplayInput(this.options.dataRoot,'queue-request',input);}catch(error){this.feedback(`队列决定未执行：${safe(String(error))}`);return;}
    this.loadQueue();const item=findQueueItem(this.options.dataRoot,requestId);
    if(!item){this.feedback('没有该请求；/queue 核对 q- 号');return;}
    if(action==='withdraw'){const blocked=queueWithdrawalBlocked(this.options.dataRoot,item);if(blocked){this.feedback(blocked);return;}}
    const decision:QueueDecision={id:randomUUID(),requestId,action,target:item.target,receiptSeq:item.receipt.seq};
    if(action==='reattach'){
      this.openQueue(requestId);
      try{
        const plan=readQueueReattachment(this.options.dataRoot,item,{...this.authorization(),busy:this.queueBusy()});
        if(plan.state==='blocked'){this.queueView!.reason(requestId,plan.reason);return;}
        const lock=await probeWelcomeLock(this.options.workspace,plan.coding);
        if(lock.state==='held'||lock.state==='unknown'){this.queueView!.reason(requestId,lock.state==='held'?'工作区被其他进程占用':'工作区所有权待核对');return;}
        if(this.stopped||this.panel?.kind!=='queue'||this.queueView?.selected?.item.requestId!==requestId||!mayWrite(this.writeAccess))return;
        const busy=this.queueBusy();if(busy){this.queueView!.reason(requestId,busy);return;}
        const entry=this.queueEntries.find(entry=>entry.item.requestId===requestId);
        if(!entry){this.feedback('队列已变化 · 请重新选择');return;}
        this.openConfirm(queueConfirmation(entry,plan,readDisplayIndex(this.options.dataRoot)),()=>void this.reattachQueue(item,decision,plan.confirmation));
      }catch(error){this.queueView?.reason(requestId,safe(String(error)));}
      return;
    }
    this.queueActing=true;
    try {
      let result:QueueItemFact|RunResult;
      if(this.phase==='running'&&this.control.target())result=await this.control.withdraw(decision);
      else {if(this.phase!=='idle')throw Error('正在清理，暂不接受决定');result=await decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision});}
      this.feedback(result.status==='withdrawn'?'已撤回':result.status==='applied'?'已接入，未撤回':`未撤回：${result.status}`);
    }catch(error){
      const current=findQueueItem(this.options.dataRoot,requestId);
      this.feedback(current?.status==='applied'?'已接入，未撤回':`队列决定未执行：${safe(String(error))}`);
    }finally{this.queueActing=false;this.loadQueue();this.tui.requestRender();}
  }
  /** Confirmation is rechecked under the writer lock, binding the receipt, tail and execution version. */
  private async reattachQueue(item:QueueItemFact,decision:QueueDecision,confirmation:QueueConfirmation) {
    if(!mayWrite(this.writeAccess)||this.queueActing)return;
    const busy=this.queueBusy();if(busy){this.queueView?.reason(item.requestId,busy);return;}
    if(confirmation.route==='relaunch-improve'){
      this.queueActing=true;
      try{
        const result=await decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision,confirmation,authorization:confirmation.authorization});
        if(result.status==='withdrawn'&&!this.stopped)this.openLaunch({focus:queueContent(item)},{runId:item.target.runId,sessionId:confirmation.sessionId});
      }catch(error){this.queueView?.reason(item.requestId,safe(String(error)));}
      finally{this.queueActing=false;this.loadQueue();this.tui.requestRender();}
      return;
    }
    this.closeViews();this.welcome=undefined;this.phase='running';this.controller=new AbortController();this.cancellation='exit';
    const self=this,analysis=item.kind==='improve';
    if(analysis){this.analysis={requestId:item.requestId,queued:false};this.activity={kind:'improve-analysis',report:this.shown('improve-report',item.requestId)};}
    this.beginCleanupAttempt();
    this.active=decideQueue({dataRoot:this.options.dataRoot,runId:item.target.runId,decision,confirmation,authorization:confirmation.authorization,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:analysis?undefined:this.showContext,
      onObservation:analysis?event=>{this.cleanupReceipts.observe(this.options.dataRoot,event);if(this.analysis)this.analysis.runId=event.runId;this.pendingRefresh=true;}:this.observe})
      .then(result=>{if('usage' in result){if(analysis){this.cleanupResult=result;this.analysisEnded(item.requestId,result.improve??null);}else this.applyResult(result);}else this.notice=`已保存状态 ${result.status}`;})
      .catch(error=>{this.notice=`重新接入受阻：${safe(String(error))}`;if(analysis)this.analysisEnded(item.requestId,null,this.notice);})
      .finally(()=>{this.loadQueue();this.finished();});
    this.tui.requestRender();
  }
  /** 打开 1c：每次打开先只读核对一次（全部分页、同一快照），再显示面板（U3）。 */
  private async openRecovery(runId:string) {
    if(!mayWrite(this.writeAccess))return;
    if(this.phase!=='idle'){const running=this.control.target()?.runId??this.runId;this.notice=`正在执行 ${running?this.shown('run',running):'受理中'}；先停止或退出后核对`;this.tui.requestRender();return;}
    if(this.recoveryChecking)return;
    this.welcome=undefined;this.viewingRecovery=true;this.runId=runId;this.recoveryChecking=true;
    const generation=++this.recoveryGeneration,controller=new AbortController();this.recoveryAbort=controller;
    const current=()=>generation===this.recoveryGeneration&&!this.stopped&&!this.exiting;
    const loading=new LoadingState('恢复核对',this.shown('run',runId),()=>{if(current())this.tui.requestRender();});this.recoveryLoading=loading;
    const dataRoot=this.options.dataRoot,authorization=this.authorization();
    const inspect=(page?:{offset:number;snapshotId:string})=>inspectRecoveryForDisplay({dataRoot,runId,authorization,page,signal:controller.signal,beforeExecutionRead:this.widths?()=>this.widths!.holdQueries():undefined});
    try {
      const first=await inspect();
      if(!current())return;
      const pages=await recoveryPages(first,offset=>inspect({offset,snapshotId:first.snapshotId}));
      if(!current())return;
      this.loadQueue();
      const facts=readRecoveryFacts(dataRoot,pages,{round:this.view(runId).updateProgress().round,task:this.chainOf(runId)?.number,queue:this.queue});
      loading.complete();this.recoveryLoading=undefined;this.recoveryAbort=undefined;this.recoveryChecking=false;
      this.recovery=first;this.pendingRefresh=true;this.refresh();
      if(first.status==='completed'||first.status==='ended'){this.viewingRecovery=false;this.recoveryPanel=undefined;this.recoveryOpen=false;this.tui.requestRender();return;}
      this.closeViews();this.recoveryPanel=new RecoveryPanel(facts);this.recoveryOpen=true;
      // 0 项未知（如退出时中断、清理已确认）：直接给出“继续旧工作”确认。
      if(this.recoveryPanel.zeroUnknown)this.recoveryAction({type:'continue'});
    }
    catch(error){if(current())this.notice=`恢复核对受阻：${safe(String(error))}`;}
    finally{loading.complete();if(current()){this.recoveryChecking=false;this.recoveryLoading=undefined;this.recoveryAbort=undefined;this.tui.requestRender();}}
  }
  /** A new view or Esc owns the screen immediately; a superseded read cannot change any UI state. */
  private cancelRecoveryCheck() {
    if(!this.recoveryAbort)return;
    this.recoveryGeneration++;this.recoveryAbort.abort();this.recoveryAbort=undefined;
    this.recoveryLoading?.cancel();this.recoveryLoading=undefined;this.recoveryChecking=false;this.recoveryOpen=false;
    this.tui.requestRender();
  }
  /** 恢复期间的按键（U3）：面板打开时交给面板；关闭时输入框禁用，只有 Enter 重开与少数全局键。返回 true 表示已消费。 */
  private recoveryInput(data:string) {
    const global=(['ctrl+c','ctrl+d','ctrl+r','ctrl+t','ctrl+o','ctrl+l'] as const).some(key=>matchesKey(data,key));
    const panel=this.recoveryOpen?this.recoveryPanel:undefined;
    if(this.recoveryChecking&&matchesKey(data,'escape')){this.cancelRecoveryCheck();return true;}
    // 所有者的完整锁路径在面板内翻页；其他情况下鼠标与翻页留给主区。
    if(data.startsWith('\x1b[<')||data.startsWith('\x1b[M')||(!panel?.pageable&&(matchesKey(data,'pageUp')||matchesKey(data,'pageDown'))))return false;
    if(global&&!(panel?.note!==undefined&&!matchesKey(data,'ctrl+c')&&!matchesKey(data,'ctrl+l')))return false;
    if(data==='?'&&panel?.note===undefined){this.openPanel('help');return true;}
    if(panel){this.recoveryAction(panel.handleInput(data));this.tui.requestRender();return true;}
    if(matchesKey(data,'enter')&&this.runId)void this.openRecovery(this.runId);
    return true;
  }
  private recoveryAction(action:RecoveryAction) {
    if(action.type==='close'){this.cancelRecoveryCheck();this.recoveryOpen=false;this.tui.requestRender();return;}
    if(this.recoveryChecking)return;
    const panel=this.recoveryPanel,report=this.recovery;if(!panel||!report)return;
    const snapshotId=panel.facts.snapshotId,unknown=panel.facts.unknownModelAttempts;
    const cost=['续跑按原授权进行；视为已完成的操作不重做，宿主拦截工具与参数完全相同的新调用',`续跑可能新增模型请求费用${unknown?`；此前 ${unknown} 次模型请求的用量未知，仍记为未知`:''}`,'原 interrupted/unknown 记录不会被改写'];
    if(action.type==='recheck')void this.openRecovery(report.runId);
    else if(action.type==='release-owner'){
      if(!mayWrite(this.writeAccess)||this.recoveryChecking||panel.disabled(1))return;
      const holders=[...new Set((panel.facts.ownerCleanup?.holders??[]).map(holder=>`pid ${holder.pid??'未记录'} · ${holder.host||'主机未记录'} · ${holder.started||'起始时间未记录'}`))];
      this.openConfirm({title:'释放上次进程留下的写入者锁',action:'释放写入者锁',body:holders,fixed:[OWNER_RELEASE_RISK,'宿主将再次核实持有者与清理记录；成功后自动重新核对']},()=>void this.releaseRecoveryOwners(report.runId,snapshotId));
    }
    else if(action.type==='continue')this.openConfirm({title:'继续旧工作',action:'继续',body:['没有结果未提交的操作；从中断处继续旧工作'],fixed:cost},()=>void this.recoveryDecision({id:randomUUID(),snapshotId,action:'continue',acceptAdditionalModelAttempts:true}));
    else if(action.type==='summary'){
      const resolutions=action.resolutions;
      this.openConfirm({title:`确认 ${resolutions.length} 项处置`,action:'提交并继续',body:panel.summaryBody(),fixed:cost},()=>void this.recoveryDecision({id:randomUUID(),snapshotId,action:'continue',acceptAdditionalModelAttempts:true,resolutions}));
      // Esc 返回调整：回到最后一项，已选处置保留。
      panel.adjust();
    }
    else if(action.type==='end')this.openConfirm({title:'结束旧工作，开新任务',action:'结束旧工作',fixed:['旧 run 标记已结束，原事实保留；不回滚，不表示外部影响未发生','此后新任务开启新会话，不接续旧上下文',`冻结项只能查看和复制，需重新提交${panel.facts.frozen.count?`（${panel.facts.frozen.count} 项）`:''}`]},()=>void this.recoveryDecision({id:randomUUID(),snapshotId,action:'end'}));
  }
  private async releaseRecoveryOwners(runId:string,snapshotId:string) {
    if(!mayWrite(this.writeAccess))return;
    if(this.phase!=='idle'||this.recoveryChecking)return;
    this.recoveryChecking=true;this.recoveryOpen=false;this.recoveryPanel=undefined;
    const decision={id:randomUUID(),snapshotId,action:'confirm-cleanup' as const,acceptUnknownExternalEffects:true};
    this.active=settleRecoveryOwners({dataRoot:this.options.dataRoot,runId,authorization:this.authorization(),decision}).then(async report=>{
      if(report.decisionId!==decision.id){this.notice=`未释放写入者锁 · ${safe(report.reasons.at(-1)??'清理条件不满足')} · Enter 重新核对`;return;}
      this.notice=`写入者锁已释放 · ${OWNER_RELEASE_RISK}`;
      this.recoveryChecking=false;
      if(!this.stopped&&!this.exiting)await this.openRecovery(runId);
    }).catch(error=>{this.notice=`释放受阻：${safe(String(error))} · Enter 重新核对`;}).finally(()=>{this.recoveryChecking=false;this.tui.requestRender();});
    await this.active;
  }
  private async recoveryDecision(decision:RecoveryDecision) {
    if(!mayWrite(this.writeAccess))return;
    if(this.phase!=='idle'||!this.recovery){this.notice='先打开恢复核对获取当前事实';return;}
    const runId=this.recovery.runId;this.closeViews();this.recoveryOpen=false;this.recoveryPanel=undefined;this.viewingRecovery=false;this.phase='running';this.controller=new AbortController();this.cancellation='exit';const self=this;
    this.beginCleanupAttempt();
    this.active=recoverRun({dataRoot:this.options.dataRoot,runId,authorization:this.authorization(),decision,transport:this.options.transport,control:this.control,signal:this.controller.signal,get cancellation(){return self.cancellation;},onContextUsage:this.showContext,onObservation:this.observe}).then(result=>{
      if('usage' in result){this.recovery=undefined;this.applyResult(result);}
      else if(result.status==='ended'){this.recovery=result;this.result=undefined;this.notice='旧工作已结束 · 新任务开启新会话，不接续旧上下文';}
      else if(result.status==='completed'){this.recovery=result;this.result=undefined;}
      else {this.recovery=result;this.viewingRecovery=true;this.notice=`恢复决定未执行 · ${safe(result.reasons[0]??result.status)} · Enter 重新核对`;}
    }).catch(error=>{this.notice=`决定受阻：${safe(String(error))}`;this.viewingRecovery=true;}).finally(()=>this.finished());
  }
  /**
   * 1c 的高度分配（U3）：面板放不下时依次收起主区、已禁用的输入框、底栏用量行，最后才收底栏键位行（面板底栏已有键位）；
   * 仍放不下时面板内部收起。头部与状态行始终保留。
   */
  /** 1c 用浮层：窗口宽敞（不窄于 100 列、不矮于 30 行）且恢复面板打开（或正在核对）时。 */
  private recoveryOverlay() {
    return !this.welcome&&this.viewingRecovery&&(!!this.recoveryLoading?.isShowing||this.recoveryOpen&&!!this.recoveryPanel)&&this.roomy()&&this.terminal.columns>=100;
  }
  /** 浮层框宽：内宽减 8，至多 100 列。 */
  private recoveryBoxWidth() {return Math.min(this.terminal.columns-2*sideMargin(this.terminal.columns)-8,100);}
  /**
   * 1c 的高度分配（U3）。浮层时框内空行先收（U10），再依次收起已禁用的输入框、底栏用量行与面板内部；
   * 主区是浮层背后的区域（`area` 行），框画在它中间。贴底面板时按原顺序先收主区。
   */
  private recoveryPlan(width:number):{main:boolean;input:boolean;usage:boolean;hints:boolean;panel:number;airy:boolean;area:number} {
    const rows=this.terminal.rows-(this.roomy()?4:2)-topMargin(this.terminal.rows)-bottomMargin(this.terminal.rows),foot=this.footerRows(width);
    if(this.recoveryOverlay()){
      const inner=this.recoveryBoxWidth()-4,panel=this.recoveryLoading?.isShowing?undefined:this.recoveryPanel;
      const airy=panel?panel.fullHeight(inner,{wide:true,airy:true})+2:4,full=panel?panel.fullHeight(inner,{wide:true})+2:4;
      const plan=(input:boolean,usage:boolean,hints:boolean,box:number,airyBox:boolean)=>{const area=rows-(input?3:0)-(hints?(usage?foot:1):0);return {main:false,input,usage,hints,airy:airyBox,area,panel:Math.max(1,Math.min(area,box)-2)};};
      if(rows>=airy+3+foot)return plan(true,true,true,airy,true);
      if(rows>=full+3+foot)return plan(true,true,true,full,false);
      if(rows>=full+foot)return plan(false,true,true,full,false);
      if(rows>=full+1)return plan(false,false,true,full,false);
      return plan(false,false,false,full,false);
    }
    const all={main:true,input:true,usage:true,hints:true,airy:false,area:0};
    if(this.recoveryLoading?.isShowing)return {...all,panel:2};
    if(!this.viewingRecovery||!this.recoveryOpen||!this.recoveryPanel)return {...all,panel:0};
    const full=this.recoveryPanel.fullHeight(width);
    if(rows>=full+3+foot+1)return {...all,panel:full};
    if(rows>=full+3+foot)return {...all,main:false,panel:full};
    if(rows>=full+foot)return {...all,main:false,input:false,panel:full};
    if(rows>=full+1)return {...all,main:false,input:false,usage:false,panel:full};
    return {...all,main:false,input:false,usage:false,hints:false,panel:rows};
  }
  private stop() {
    if(!mayWrite(this.writeAccess))return;
    this.confirmation=undefined;
    if(this.phase!=='running')return;
    if(this.evaluation){void this.stopEval();return;}
    if(this.improveBatch.running&&listPlanSources(this.options.dataRoot).some(s=>this.improveBatch.canStop(s.origin))){void this.stopEval();return;}
    this.widths?.retainPending('stop-preserve-unapplied-input');
    this.cancellation='stop';this.phase='stopping';this.notice=this.analysis?`请求停止 improve 分析 ${this.shown('improve-report',this.analysis.requestId)}；等待 runtime 确认`:this.improveBatch.origin?`请求停止 improve 提交批次 ${this.shown('improve-report',this.improveBatch.origin.reportId)}；等待清理，剩余项不启动`:`请求中止 run ${this.runId?this.shown('run',this.runId):'受理中'}；等待 runtime 确认`;this.controller?.abort();this.tui.requestRender();
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
      this.view(this.runId).updateProgress();if(this.analysis?.runId)this.view(this.analysis.runId).updateProgress();this.refreshes++;
      if(this.phase==='idle'&&!this.viewingRecovery&&this.continuation()?.state==='blocked')this.coding=!!this.options.coding;
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
    // 主区顶部与头部分隔线之间留一行（U10），随主区滚动。
    if(this.roomy())block(width=>[styledLine([],width)]);
    if(preceding){this.displaySources.push(preceding.text);block(width=>plainLines(preceding.text,width,'fg.faint'),()=>this.command(parseCommand(preceding.command)));}
    // 前序任务行之后：跨执行版本接续的提示，或不能接续的原因（U2、U13）。
    const continuation=this.phase==='idle'&&!this.viewingRecovery?this.continuation():undefined;
    const line=continuation?.state==='blocked'?(this.options.resume===continuation.sessionId&&!this.result&&continuation.reason===CONTINUE_TAIL_UNFINISHED?'该会话不能接续，新任务将开启新会话':continuation.reason):continuation?.state==='recovery'?'◈ 链尾待恢复核对 · Enter 打开恢复核对':continuation?.state==='ready'&&continuation.versionChanged?VERSION_CHANGED_HINT:undefined;
    if(line){this.displaySources.push(line);block(width=>plainLines(line,width,continuation?.state==='blocked'?'ac.warn':'fg.muted'));}
    if(!this.records.length) {
      const text=`在输入区发起一个${this.coding?'coding':'只读'}项目请求。\n${this.options.mode==='offline'?'offline-demo：真实 runtime + 固定传输；没有模型推理。':'DeepSeek 凭据从环境读取；没有自动 fallback。'}\nCtrl+J / Shift+Enter / 反斜杠后 Enter 换行。\n忙时 Enter 补充当前任务；Ctrl+X → Enter 后续请求。\n/queue 队列；拖选复制。`;
      this.displaySources.push(text);block(width=>plainLines(text,width,'fg.muted'));
    }
    if(this.records.length&&this.records[0].kind!=='task.accepted')block(width=>plainLines('当前内容窗口 · /older 查看更早内容',width,'fg.faint'));
    const entries=this.runId?this.view(this.runId).project(this.records,{active:this.phase!=='idle'&&!this.analysis,answer:this.result?.answer&&!this.historyWindow?this.result.answer:undefined}):[];
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
        entry.args=safe(entry.args);if(entry.output)entry.output.lines=entry.output.lines.map(safe);if(entry.diff)entry.diff=entry.diff.map(safe);if(entry.error)entry.error=safe(entry.error);
        this.displaySources.push(`${entry.tool} ${entry.args} ${entry.summary}`,...(entry.output?.lines??[]),...(entry.diff??[]),...(entry.error?[entry.error]:[]));
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
    this.confirmation=undefined;this.historyWindow=false;if(!this.recovery||this.recovery.status==='completed'||this.recovery.status==='ended')this.viewingRecovery=false;this.scroll.scrollToEnd();this.pendingRefresh=true;this.refresh();this.scroll.scrollToEnd();this.notice=this.viewingRecovery?'恢复限制仍生效 · Enter 打开恢复核对':'已回到活动会话，跟随新输出';this.tui.requestRender();
  }
  private window(direction:'older'|'newer') {
    if(!this.runId)return;
    this.historyWindow=true;
    const page=readRunRecords(this.options.dataRoot,this.runId,direction==='older'?{before:this.records[0]?.seq,limit:WINDOW,kinds:VISIBLE_KINDS}:{after:this.records.at(-1)?.seq,limit:WINDOW,kinds:VISIBLE_KINDS});
    if(!page.records.length){this.notice='已到记录边界（只读历史）；/bottom 返回活动会话';this.tui.requestRender();return;}
    this.historyWindow=true;this.records=page.records;this.rebuild();this.scroll.scrollTo(0,{disableFollow:true});this.notice='只读历史窗口；/older /newer 翻页，/bottom 跟随最新';
  }
  /**
   * `pi-durio resume`（U6）：按链尾状态打开。待恢复核对时打开恢复面板（没有关闭记录且工作区被占用时
   * 留在欢迎屏、显示被占用、不能提交）；其余为 1b 空闲布局，可以接续时下一次 Enter 接续链尾，
   * 不能接续时在前序任务行的位置写原因。不取锁、不调度。
   */
  private async resumeSession(id:string) {
    if(!mayWrite(this.writeAccess))return;
    let continuation:Continuation|null;
    try{continuation=readContinuation(this.options.dataRoot,id,{workspace:this.options.workspace});}
    catch(error){this.notice=`会话不可读取：${safe(String(error))}`;this.tui.requestRender();return;}
    if(!continuation){this.notice='会话没有记录';this.tui.requestRender();return;}
    this.coding=continuation.coding;this.occupied=false;
    if(continuation.state==='recovery'){
      if(continuation.status==='running'||continuation.status==='accepted'){
        // 欢迎屏自己也在探测（它显示持有者）；这里单独探测一次，不依赖其先后。
        const lock=await probeWelcomeLock(this.options.workspace,!!this.coding).catch(()=>undefined);
        if(lock?.state==='held'){this.occupied=true;this.notice=`会话 ${this.shown('session',id)} 正在被其他进程执行 · 不能提交`;this.tui.requestRender();return;}
      }
      await this.openRecovery(continuation.tailRunId);return;
    }
    this.welcome=undefined;this.runId=continuation.tailRunId;this.continueFrom=continuation.tailRunId;this.pendingRefresh=true;this.refresh();
  }
  /** 空闲 Enter 的接续条件（U13）；按刷新与队列变化重算，只读。 */
  private continuation() {
    if(!this.continueFrom||this.options.show)return undefined;
    const key=`${this.continueFrom}:${this.refreshes}:${this.queue.map(item=>item.status).join()}`;
    if(this.continuationMemo?.key!==key){
      let value:Continuation|undefined;
      try{
        const root=this.options.dataRoot,chains=readSessionChains(root),of=chains.sessionOfRun(this.continueFrom);
        const current=()=>{try{return currentExecutionVersion({dataRoot:root,workspace:this.options.workspace,coding:!!this.coding,mode:this.options.mode,toolEnvironment:this.options.toolEnvironment});}catch{return null;}};
        value=(of&&readContinuation(root,of.id,{workspace:this.options.workspace,chains,current}))||undefined;
      }catch{value=undefined;}
      this.continuationMemo={key,value};
    }
    return this.continuationMemo.value;
  }
  private openHistory(filter:HistoryTarget) {
    try{
      this.historyView=new HistoryView(this.options.dataRoot,filter,{workspace:this.options.workspace,changed:()=>this.tui.requestRender(),feedback:text=>this.feedback(text),
        continue:id=>void this.continueHistory(id),
        annotate:(task,saved)=>this.annotateTask(task,saved),
        trace:runId=>this.historyTrace(runId),
        details:(runId,attemptId)=>this.historyTrace(runId,attemptId),
      });this.openPanel('history');
    }catch(error){this.notice=`历史查询失败（当前工作未改变）：${safe(String(error))}`;this.tui.requestRender();}
  }
  private annotationBlocked() {
    return this.writeAccess.writeBlocked()??(this.stopped||this.exiting?'当前界面正在退出，不能补记':this.phase!=='idle'||this.analysis||this.improveBatch.running?ANNOTATION_RUNNING:this.recoveryChecking||this.viewingRecovery||this.result?.status==='unknown'||this.result?.cleanup==='unknown'?'先完成恢复核对，再补记':undefined);
  }
  private annotateTask(target?:AnnotationTarget,saved?:()=>void,prefill:AnnotationPrefill={},taskId?:string) {
    const feedback=(message:string)=>{this.notice=message;this.feedback(message);};
    const blocked=this.annotationBlocked();if(blocked){feedback(blocked);return;}
    try{
      const snapshot=readAnnotation(target??annotationTarget(this.options.dataRoot,taskId,this.runId??this.continueFrom)),box=new AcceptanceDialog(snapshot,prefill);
      this.openDialog(box,()=>{
        let written=0;
        try{written=saveAnnotation(snapshot,box.submission,()=>this.annotationBlocked()).sources.length;}
        catch(error){if(error instanceof AnnotationWriteError&&error.sources.length){try{saved?.();}catch(refreshError){feedback(`补记已追加部分记录，视图刷新失败：${safe(String(refreshError))}`);return;}feedback(`补记已追加部分记录，请核对后重开：${safe(String(error))}`);}else feedback(`补记未写入：${safe(String(error))}`);return;}
        if(written){try{saved?.();}catch(error){feedback(`补记已写入，视图刷新失败：${safe(String(error))}`);return;}}
        feedback(written?'补记已追加 · 原记录保留':'没有需要写入的改动');
      });
    }catch(error){feedback(`不能补记：${safe(String(error))}`);}
  }
  private historyTrace(runId:string,attemptId?:string) {
    try{
      const view=this.traceOf(runId);
      if(attemptId){const span=view.trace.spans.find(item=>item.key===attemptId);if(span)this.openDetails(view,span,true);else this.feedback('该工具调用尚未写入 trace');}
      else{this.traceView=view;this.pushView('trace');}
    }catch(error){this.feedback(`trace 不可读取：${safe(String(error))}`);}
  }
  /** c only selects a continuable tail. Probe and recheck before changing the active session; never submit. */
  private async continueHistory(id:string) {
    if(!mayWrite(this.writeAccess))return;
    const view=this.historyView,revision=view?.revision;
    const read=()=>readContinuation(this.options.dataRoot,id,{workspace:this.options.workspace,busy:this.phase!=='idle'?'不能接续 · 当前任务运行中':this.viewingRecovery||this.result?.status==='unknown'||this.result?.cleanup==='unknown'?'不能接续 · 有待处理的恢复核对':undefined});
    try{
      let target=read();if(!target){this.feedback('会话没有记录');return;}
      if(target.state==='blocked'){this.feedback(target.reason);return;}
      const lock=await probeWelcomeLock(this.options.workspace,target.coding);
      // Esc, another view, new runtime activity or show capability must win over an outstanding probe.
      if(this.panel?.kind!=='history'||this.historyView!==view||view?.revision!==revision||!mayWrite(this.writeAccess))return;
      target=read();if(!target){this.feedback('会话没有记录');return;}
      if(target.state==='blocked'){this.feedback(target.reason);return;}
      if(lock.state==='held'){this.feedback('不能接续 · 工作区被其他进程占用');return;}
      if(lock.state==='unknown'||lock.state==='probing'){this.feedback('不能接续 · 工作区锁状态未确认');return;}
      this.coding=target.coding;this.closeViews();this.occupied=false;this.historyWindow=false;
      this.result=undefined;this.context=this.prefix();this.continuationMemo=undefined;
      if(target.state==='recovery'){void this.openRecovery(target.tailRunId);return;}
      this.welcome=undefined;this.runId=target.tailRunId;this.continueFrom=target.tailRunId;this.pendingRefresh=true;this.refresh();this.scroll.scrollToEnd();
    }catch(error){this.feedback(`不能接续 · ${safe(String(error))}`);}
  }
  /** 2a：指定 run，或当前会话正在运行 / 最近一次的 run；尚无 run 时只提示（U7）。 */
  private openTrace(runId=this.runId) {
    if(!runId){this.feedback('尚无 run · 完成或开始一个任务后再按 Ctrl+T');return;}
    try{this.traceView=this.traceOf(runId);this.openPanel('trace');}
    catch(error){this.notice=`trace 不可读取：${safe(String(error))}`;this.tui.requestRender();}
  }
  /** 2a 列表层；Enter 进原文层、`p` 固定为证据经 TraceHost 回到这里。 */
  private traceOf(runId:string,root=this.options.dataRoot) {
    const host:TraceHost={writeBlocked:this.writeAccess.writeBlocked,busy:()=>this.phase!=='idle',feedback:text=>this.feedback(text),confirm:(config,run)=>this.openConfirm(config,()=>void run()),changed:()=>this.tui.requestRender(),openRaw:span=>this.openRaw(span)};
    return new TraceView(root,runId,()=>root===this.options.dataRoot&&this.phase==='running'&&this.runId===runId,host);
  }
  /** 在 2a 列表层之上压入原文层（Esc 回到列表层，仍选中该 span）。 */
  private openRaw(span:TraceSpan,item?:string) {
    if(!this.traceView)return;
    this.traceRaw=new TraceRawView(this.traceView.root,this.traceView,span.key,{copy:this.copy,feedback:text=>this.feedback(text),changed:()=>this.tui.requestRender()},item);
    this.pushView('trace-raw');
  }
  /** `/details` 与“分页查看”：打开 2a 并选中该 span，直接进入原文层（先显示输出）；Esc 先回列表层，再回会话。 */
  private openDetails(view:TraceView,span:TraceSpan,nested=false) {
    this.scroll.scrollTo(this.scroll.scrollTop,{disableFollow:true});
    this.traceView=view;if(nested)this.pushView('trace');else this.openPanel('trace');view.select(span.key);this.openRaw(span,outputItem(span));
  }
  private openPanel(kind:PanelKind) {
    // 从会话屏（或菜单）打开：替换整个视图栈，新视图为最上层。视图内进入下一层用 pushView。
    this.closeViews();this.confirmation=undefined;
    this.viewStack.push({kind,offset:0,line:0});
    const component:Component={invalidate(){},render:width=>this.panelLines(width),handleInput:data=>this.panelInput(data),handleMouse:event=>{
      const panel=this.panel;if(!panel)return;
      if(event.type==='wheel'&&panel.kind==='trace-raw'){this.traceRaw?.scroll(event.wheelDelta??0);return {handled:true};}
      if(event.type==='click'&&panel.kind==='history'){this.historyView?.click(event.y);this.tui.requestRender();return {handled:true};}
      if(event.type==='click'&&panel.kind==='eval-trial'){this.evalTrial?.click(event.y);this.tui.requestRender();return {handled:true};}
      if(event.type==='click'&&panel.kind==='trace'){this.traceView?.click(event.y);this.tui.requestRender();return {handled:true};}
      if(event.type==='click'&&panel.kind==='queue'){this.queueView?.click(event.y);return {handled:true};}
      if(event.type==='wheel'&&panel.kind==='queue'){this.queueView?.scroll(event.wheelDelta??0);return {handled:true};}
      if(event.type==='wheel'){if(panel.kind==='improve-selection')this.improveSelectionView?.scroll(event.wheelDelta??0);else if(panel.kind==='metrics')this.metricsView?.scroll(event.wheelDelta??0);else if(panel.kind==='improve')this.improveView?.scroll(event.wheelDelta??0);else if(panel.kind==='improve-home')this.improveHome?.scroll(event.wheelDelta??0);else if(panel.kind==='history')this.historyView?.scroll(event.wheelDelta??0);else if(panel.kind==='storage')this.storageView?.scroll(event.wheelDelta??0);else if(panel.kind==='eval')this.evalList?.scroll(event.wheelDelta??0);else if(panel.kind==='eval-plan')this.evalPlan?.scroll(event.wheelDelta??0);else if(panel.kind==='eval-trial')this.evalTrial?.scroll(event.wheelDelta??0);else if(panel.kind==='trace')this.traceView?.scroll(event.wheelDelta??0);else panel.line=Math.max(0,panel.line+(event.wheelDelta??0));return {handled:true};}
    }};
    const overlay=kind==='exit'?this.tui.showOverlay(component,{width:'96%',maxHeight:'90%',anchor:'center',visible:(width,height)=>width>=40&&height>=12}):showFullScreen(this.tui,this.terminal,component,()=>!!this.dialog);this.hidePanel=()=>overlay.hide();this.tui.requestRender();
  }
  /**
   * 在当前视图之上压入下一层：共用同一个全屏浮层，Esc 回到当前层（closePanel）。
   * 没有打开的视图时等同 openPanel。首版面板都是单层，尚无调用方。
   */
  private pushView(kind:PanelKind) {
    if(kind==='queue')this.prepareQueue();
    if(!this.viewStack.length){this.openPanel(kind);return;}
    this.viewStack.push({kind,offset:0,line:0});
    this.tui.requestRender();
  }
  /** 视图各行；有即时反馈时替换末行（视图的键位提示行），保留最右边的 Esc。 */
  private panelLines(width:number) {
    const lines=this.panelBody(width);
    if(this.hintFeedback!==undefined&&lines.length)lines[lines.length-1]=hintLine([],width,{feedback:this.hintFeedback,esc:escHint(this.panel?.kind==='metrics'?this.metricsView?.depth??1:this.panel?.kind==='history'?this.historyView?.depth??1:this.viewStack.length)});
    return this.dialog&&this.viewStack[0]?.kind==='exit'?lines.map(line=>dimForOverlay(line)):lines;
  }
  private overlayHeight(){return this.viewStack[0]?.kind==='exit'?Math.max(3,Math.floor(this.terminal.rows*0.9)-1):fullScreenHeight(this.terminal.rows);}
  /** 帮助视图：会话屏键位与命令清单（同一张命令表），正文在固定头尾之间滚动。 */
  private helpLines(width:number) {
    const panel=this.panel!;
    const frame=fixedFrame([styledLine([{text:'帮助',fg:'fg.primary',bold:true}],width)],helpBody(width).map(text=>styledLine([{text}],width)),[hintLine(['↑↓ 滚动','n/p 翻页'],width,{esc:escHint(this.viewStack.length)})],this.overlayHeight(),panel.line);
    panel.line=frame.offset;this.widths?.inspect(frame.lines);
    return frame.lines;
  }
  /** 会话屏底栏键位提示（#42 第 4 节）；宽度不够时从右往左去掉，空闲时 `? 帮助` 最后去掉。 */
  private sessionHints():string[] {
    if(this.phase==='stopping'||this.phase==='exiting')return [];
    if(this.viewingRecovery)return this.recoveryOpen?['Ctrl+R 历史','Ctrl+T trace','? 帮助']:['Enter 打开恢复核对','Ctrl+C 退出（保留可恢复工作）'];
    if(this.analysis)return ['Ctrl+C 停止分析','Ctrl+T 分析 trace','/improve 查看','? 帮助'];
    if(this.evaluation)return ['Ctrl+C 停止批次','/eval 查看','? 帮助'];
    if(this.improveBatch.running)return ['Ctrl+C 停止执行','/improve 查看','? 帮助'];
    if(this.phase==='running')return ['Enter steer','Ctrl+X Enter follow-up','Ctrl+C 中止','Ctrl+O 展开'];
    return ['Enter 提交','/ 命令','Ctrl+R 历史','? 帮助'];
  }
  /** 输入为空时的占位文案（#42 第 4 节）。 */
  private placeholder() {
    if(this.phase==='stopping'||this.phase==='exiting')return '正在清理 · 输入保留为草稿，不会受理';
    if(this.viewingRecovery)return '恢复核对进行中 · 输入不会提交';
    if(this.analysis)return 'improve 分析进行中 · 输入照常编辑，结束后 Enter 接续当前会话';
    if(this.evaluation)return 'eval 批次运行中 · 输入保留，结束后 Enter 接续当前会话';
    if(this.improveBatch.running)return 'improve 执行进行中 · 输入保留，结束后 Enter 接续当前会话';
    if(this.phase==='running')return '补充当前任务…   Ctrl+X Enter 排到下一任务';
    return `${this.coding?'描述要完成的修改…':'描述要查看或分析的内容…'}   / 命令  @ 文件  Shift+Enter 换行`;
  }
  private panelBody(width:number):string[] {
    const panel=this.panel;if(!panel)return[];
    if(panel.kind==='improve-selection'){const lines=this.improveSelectionView?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='improve'){const lines=this.improveView?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='improve-home'){const lines=this.improveHome?.render(width,this.overlayHeight(),this.viewStack.length)??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='eval'){const lines=this.evalList?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='eval-plan'){const loading=this.evaluation?.preparing&&this.evalPlan&&samePlan(this.evalPlan.source,this.evaluation.source)?this.evaluation.loading:undefined;const lines=loading?.isShowing?fixedFrame([styledLine([{text:` ◆ eval ${this.evaluation!.source.label}`}],width)],[loading.renderLine(width)],[hintLine([],width,{esc:escHint(this.viewStack.length)})],this.overlayHeight(),0).lines:this.evalPlan?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='eval-trial'){const lines=this.evalTrial?.render(width,this.overlayHeight(),escHint(this.viewStack.length))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='storage') {const lines=this.storageView?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='metrics') {const lines=this.metricsView?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='history') {const lines=this.historyView?.render(width,this.overlayHeight())??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='trace') {const lines=this.traceView?.render(width,this.overlayHeight(),escHint(this.viewStack.length))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='trace-raw') {const lines=this.traceRaw?.render(width,this.overlayHeight(),escHint(this.viewStack.length))??[];this.widths?.inspect(lines);return lines;}
    if(panel.kind==='queue') {const lines=this.queueView?.render(width,this.overlayHeight(),escHint(this.viewStack.length))??[];this.widths?.inspect(lines);return lines;}
    let text:string;
    if(panel.kind==='help')return this.helpLines(width);
    text='退出并保留草稿？\nEnter：保存文本，取消在途请求并等待清理\nEsc：返回；不改变任务状态';
    this.widths?.inspect([text]);
    const lines=wrapTextWithAnsi(text,Math.max(1,width-2));
    const height=Math.max(2,Math.floor(this.terminal.rows*0.9)-2);
    const maxLine=Math.max(0,lines.length-height);panel.line=Math.min(panel.line,maxLine);
    return [...lines.slice(panel.line,panel.line+height),truncateToWidth('↑↓滚动 Esc返回',width)].map(text=>styledLine([{text}],width));
  }
  private panelInput(data:string) {
    const panel=this.panel;if(!panel)return;
    this.confirmation=undefined;
    // 全屏视图层的全局键（T6）：Esc 返回上一层；Ctrl+C 只停本视图的操作，不传给会话屏；Ctrl+D/O/T/R、? 不起作用。
    if(panel.kind==='history'&&(this.historyView?.acceptsInput||this.historyView?.isBody&&matchesKey(data,'ctrl+o'))){this.historyView.handleInput(data);this.tui.requestRender();return;}
    const key=viewKey(data);
    if(key==='back'&&panel.kind==='history'&&this.historyView?.back())return;
    if(key==='back'&&panel.kind==='improve'&&this.improveView?.back()){this.tui.requestRender();return;}
    if(panel.kind==='metrics'&&this.metricsView?.acceptsInput&&(key===undefined||key==='back'||data==='?')){this.metricsView.handleInput(data);this.tui.requestRender();return;}
    if(key==='back'&&panel.kind==='metrics'&&this.metricsView?.back())return;
    if(key==='back') {if(panel.kind==='storage')this.storageView?.cancel();if(panel.kind==='eval-plan'&&this.evaluation?.preparing&&this.evalPlan&&samePlan(this.evalPlan.source,this.evaluation.source)){this.evaluation.loading?.cancel();this.controller?.abort();}if(panel.kind==='eval-trial'){if(this.evalTrial?.back())return;this.closeTrial();}if(panel.kind==='improve-selection'&&this.improveSelectionView?.back()){this.tui.requestRender();return;}this.closePanel();return;}
    if(key==='redraw'){if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return;}
    if(key==='stop'){if(panel.kind==='eval-plan'&&this.evalPlan){void this.stopEval(this.evalPlan.source);return;}if(panel.kind==='improve-selection'&&this.improveSelectionView?.inProgress)this.stop();return;}
    if(key==='inert')return;
    if(panel.kind==='improve-selection'){void this.improveSelectionView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='improve'){this.improveView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='improve-home'){const item=this.improveHome?.handleInput(data);if(item)this.openImproveItem(item);this.tui.requestRender();return;}
    if(panel.kind==='eval'){this.evalList?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='eval-plan'){if(data==='r'&&this.evalPlan){this.confirmEval(this.evalPlan.source,'grade');return;}this.evalPlan?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='eval-trial'){this.evalTrial?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='storage') {void this.storageView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='trace'){this.traceView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='trace-raw'){this.traceRaw?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='metrics') {this.metricsView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='history') {this.historyView?.handleInput(data);this.tui.requestRender();return;}
    if(panel.kind==='queue') {this.queueView?.handleInput(data);this.tui.requestRender();return;}
    if(matchesKey(data,'up'))panel.line=Math.max(0,panel.line-1);
    if(matchesKey(data,'down'))panel.line++;
    if(panel.kind==='help'){const page=Math.max(1,this.overlayHeight()-2);if(data==='n')panel.line+=page;if(data==='p')panel.line=Math.max(0,panel.line-page);}
    if(panel.kind==='exit'&&matchesKey(data,'enter')){this.closeViews();void this.exit();return;}
    this.tui.requestRender();
  }
  /** Esc：弹出最上层视图；栈空时关闭浮层、焦点还给输入框（回到会话屏）。 */
  private closePanel() {
    this.viewStack.pop();
    // 回到第一层时重新读取：分析或决定可能已经结束。
    if(this.panel?.kind==='improve-home')this.improveHome?.refresh();
    if(!this.viewStack.length){this.hidePanel?.();this.hidePanel=undefined;this.tui.setFocus(this.editor);}
    this.confirmation=undefined;this.tui.requestRender();
  }
  /** 离开全部视图回到会话屏（开始执行、退出、从菜单换到另一视图）。 */
  private closeViews() {
    this.cancelRecoveryCheck();this.closeConfirm();
    if(this.viewStack.some(view=>view.kind==='eval-trial'))this.closeTrial();
    this.viewStack.length=0;this.hidePanel?.();this.hidePanel=undefined;this.tui.setFocus(this.editor);
    this.confirmation=undefined;this.tui.requestRender();
  }
  /** 按键的即时反馈：替换底栏键位提示行，下一次按键后恢复。 */
  private feedback(text:string) {this.hintFeedback=text;this.tui.requestRender();}
  /**
   * 在当前层（视图或会话屏）之上打开确认框（U12 版式）。Enter 可用时调用 confirm 并关闭；Esc 只关闭。
   * 打开期间消费全部按键，不穿透到视图或会话屏。
   */
  private openConfirm(config:ConfirmConfig,confirm:(selected:number[])=>void) {this.openDialog(new ConfirmDialog(config),confirm);}
  /** 任意确认框组件（U12 版式；如 improve 启动框）居中打开。 */
  private openDialog(box:NonNullable<typeof this.dialog>['box'],confirm:(selected:number[])=>void) {
    this.closeConfirm();
    const terminal=this.terminal;
    const component:Component={invalidate(){},render:()=>box.render(terminal.columns,terminal.rows),handleInput:data=>this.dialogInput(data)};
    const overlay=this.tui.showOverlay(component,{get width(){return ConfirmDialog.width(terminal.columns);},anchor:'center',visible:(_width,height)=>terminal.columns>=40&&height>=12});
    this.dialog={box,confirm,hide:()=>overlay.hide()};this.tui.requestRender();
  }
  private closeConfirm() {this.dialog?.hide();this.dialog=undefined;this.tui.requestRender();}
  private dialogInput(data:string) {
    const dialog=this.dialog;if(!dialog)return;
    if(matchesKey(data,'ctrl+l')){if(this.widths)this.widths.retry(true);else this.tui.requestRender(true);return;}
    // Hidden overlays are not rendered by pi-tui. Do not let their previous
    // size authorize an action, including actions handled inside a nested box.
    if((this.terminal.columns<40||this.terminal.rows<12)&&!matchesKey(data,'escape')){this.tui.requestRender();return;}
    // A resize can precede its next paint; refresh fixed-row constraints now.
    dialog.box.render(this.terminal.columns,this.terminal.rows);
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
    this.cancelRecoveryCheck();
    this.phase='exiting';this.confirmation=undefined;this.notice='退出中；等待 runtime 清理与 storage 关闭';this.tui.requestRender();
    try {this.widths?.beginClose();}catch(error){this.failure=`待处理输入保存失败：${String(error)}`;}
    const evalStopping=this.evaluation||this.improveBatch.running?this.stopEval():undefined;
    if(!this.controller?.signal.aborted)this.cancellation='exit';this.controller?.abort();
    let draftSaved=false,draftLines=0,terminalRestored=true;
    try {const draft=this.editor.getExpandedText()||this.savedDraft;if(draft){this.drafts.save(draft);draftSaved=true;draftLines=draft.split(/\r\n|\r|\n/).length;}}catch(error){this.failure=`草稿保存失败：${String(error)}`;}
    try {await evalStopping;await this.active;} finally {
      this.closeTrial();this.metricsView?.cancel();await Promise.allSettled(this.trialClosures);
      this.stopped=true;if(this.timer)clearInterval(this.timer);this.removeInput?.();for(const remove of this.removeSignals)remove();
      if(this.started) {
        try {if(this.widths&&!await this.widths.settle()){terminalRestored=false;this.failure??='WIDTH_QUERY_BOUNDARY_UNKNOWN: terminal drain is bounded';}}catch(error){terminalRestored=false;this.failure??=`字宽清理失败：${String(error)}`;}
        try {await this.terminal.drainInput(150,30);} catch(error){terminalRestored=false;this.failure??=`终端 drain 失败：${String(error)}`;}
        try {this.terminal.write('\x1b[?1004l');this.tui.stop({preserveScreen:true});}
        catch(error){terminalRestored=false;this.failure??=`终端清理失败：${String(error)}`;try{this.terminal.stop();}catch{/* Preserve the cleanup failure. */}}
        finally {try{this.terminal.showCursor();}catch(error){terminalRestored=false;this.failure??=`光标恢复失败：${String(error)}`;}this.widths?.dispose();this.restoreMeasurementWrite?.();this.restoreTerminalWrite?.();}
      }
    }
    const cleanupResult=this.cleanupReceipts.result(this.cleanupResult);
    const summary=await exitSummary(this.options.dataRoot,{workspace:this.options.workspace,runId:this.runId??this.options.show?.run??this.options.trace,cleanup:cleanupResult,cleanupAttempted:this.cleanupAttempted,elapsedMs:Date.now()-this.startedAt,draftLines,terminalRestored,eval:this.evalExit,evalCleanup:this.evalCleanup,batchCleanup:this.improveBatch.cleanup,error:this.failure},this.terminal.columns);
    const result={result:this.result,cleanupResult,error:this.failure,draftSaved,summary,eval:this.evalExit,evalCleanup:this.evalCleanup,batchCleanup:this.improveBatch.cleanup,widthCalibration:this.widths?.snapshot()};
    this.resolveClosed(result);return result;
  }
}

/** improve 分析未完成的原因：达到预算或时限、停止，其余写原因码。 */
function analysisReason(reason:string) {
  const code=/[A-Z][A-Z0-9_]{3,}/.exec(reason)?.[0];
  if(code==='BUDGET_DEADLINE')return `达到时限 · ${code}`;
  if(code&&/^BUDGET_(REQUEST|TOKEN)_LIMIT|^BUDGET_PROVIDER_BOUND/.test(code))return `达到预算上限 · ${code}`;
  if(/Analysis stop/.test(reason))return '已停止';
  if(/Analysis exit/.test(reason))return '退出时中止';
  return safe(code??reason.slice(0,120));
}

export async function runTui(options:TuiOptions) {
  const app=new ReadOnlyTui(options);
  try {app.start();return await app.closed;} finally {await app.exit();}
}
