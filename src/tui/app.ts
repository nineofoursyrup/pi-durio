import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Container, Editor, MouseRegion, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, isKeyRelease, isKeyRepeat, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type AutocompleteProvider, type Terminal } from '@earendil-works/pi-tui';
import { runReadTask, type ReadTaskOptions, type RunResult } from '../runtime.js';
import { readRunRecords, readObjectRange, readTextPage, type RecordReference } from '../query.js';
import { Drafts } from './drafts.js';

const identity=(s:string)=>s;
const theme={borderColor:identity, selectList:{selectedPrefix:identity,selectedText:identity,description:identity,scrollInfo:identity,noMatch:identity}};
const commands=[['help','帮助'],['exit','退出并保留草稿'],['restore','恢复草稿（不执行）'],['bottom','回到底部'],['older','上一窗口'],['newer','下一窗口'],['details','查看原文详情'],['copy','复制选文或最新可见输出'],['stop','中止当前只读任务']] as const;
const visibleKinds=['task.accepted','tool.intent','tool.result','tool.error','tool.summary','model.provider-event','model.response','run.abort-intent','run.exit-intent','run.closed'];
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
  terminal?:Terminal; draftRoot?:string; copy?:(text:string)=>Promise<boolean|string>;
}
export interface TuiExit { result?:RunResult; error?:string; draftSaved:boolean; }

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

/** Product UI owns only presentation and drafts. All execution goes through runReadTask. */
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
  private phase:'idle'|'running'|'stopping'|'exiting'='idle';
  private notice='只读任务；/help 帮助；忙时输入保留为草稿，队列尚未接入';
  private savedDraft?:string;
  private lastText='';
  private confirmation?:{key:string;at:number};
  private panel?:{kind:'help'|'exit'|'detail'|'actions';ref?:RecordReference;offset:number;previous:number[];line:number;raw:string;next:number|null;error?:string};
  private hidePanel?:()=>void;
  private pendingRefresh=false;
  private timer?:ReturnType<typeof setInterval>;
  private started=false;
  private stopped=false;
  private exiting?:Promise<TuiExit>;
  private failure?:string;
  private historyWindow=false;
  private removeInput?:()=>void;
  private removeSignals:Array<()=>void>=[];

  constructor(private readonly options:TuiOptions) {
    options.workspace=realpathSync(options.workspace);
    options.dataRoot=resolve(options.dataRoot);
    this.terminal=options.terminal??new ProcessTerminal();
    this.copy=options.copy??copyToMacClipboard;
    this.drafts=new Drafts(options.draftRoot??join(homedir(),'Library','Application Support','pi-durio','ui-drafts'),options.workspace,options.dataRoot);
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve;});
    this.tui=new TuiAltScreen(this.terminal,true,undefined,{copySelection:this.copy,copyOnSelect:true,scrollToEndIndicator:()=> ' ↓ 回到底部 · /bottom '});
    this.editor=new Editor(this.tui,theme,{autocompleteMaxVisible:2});
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
      truncateToWidth(`pi-durio · [F2 菜单] · 只读 · ${safe(options.workspace)}`,width),
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
      // Runs before pi-tui's own viewport listener, which consumes mouse/focus/page keys.
      if(!isKeyRelease(data)&&!matchesKey(data,'ctrl+c')&&!matchesKey(data,'ctrl+d')) this.confirmation=undefined;
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
    this.tui.start();
    this.terminal.write('\x1b[?1004h'); // Focus reports invalidate any pending exit confirmation.
    this.timer=setInterval(()=>{if(this.pendingRefresh) this.refresh();},75);
    this.tui.requestRender();
  }
  /** Visible frame for diagnostics/tests; no runtime internals or writable handles. */
  screen() { this.tui.renderNow(); return this.tui.getScreenLines(); }
  private status() {return this.phase==='running'?'运行中':this.phase==='stopping'?'中止中（等待实际清理）':this.phase==='exiting'?'退出中（等待实际清理）':label(this.result);}
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
    if(matchesKey(data,'ctrl+l')) {this.tui.requestRender(true);return {consume:true};}
    if(matchesKey(data,'f2')) {this.openPanel('actions');return {consume:true};}
    if(matchesKey(data,'ctrl+o')) {this.openDetail(this.records.at(-1));return {consume:true};}
    if(matchesKey(data,'ctrl+x')) {this.notice='follow-up 尚未接入；文本保留为草稿，不会执行';this.tui.requestRender();return {consume:true};}
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
        const text=this.editor.getExpandedText();
        if(text) {this.drafts.save(text);this.savedDraft=text;this.editor.setText('');this.lastText='';}
        this.notice='草稿已保留；/restore 恢复。800ms 内再按 Ctrl+C 退出';
      } else this.notice='800ms 内再按 Ctrl+D 退出；其他按键取消确认';
      this.confirmation={key,at:Date.now()};this.tui.requestRender();return {consume:true};
    }
    return undefined;
  }
  private submit(text:string) {
    this.confirmation=undefined;
    const command=text.trim();
    if(command.startsWith('/')) {
      // Editor clears on submit; restore previous draft for command actions where available.
      this.editor.setText('');this.lastText='';
      if(!this.command(command)) {this.editor.setText(text);this.lastText=text;this.notice='未知或尚未接入的命令；没有调用模型。/help 查看当前入口';}
      this.tui.requestRender(); return;
    }
    if(!text.trim())return;
    if(this.phase!=='idle') {this.editor.setText(text);this.lastText=text;this.notice='任务尚在处理；本阶段未接入忙时队列。文本保留为草稿，未受理';this.tui.requestRender();return;}
    if(this.result?.status==='unknown'||this.result?.cleanup==='unknown') {this.editor.setText(text);this.lastText=text;this.notice='旧工作存在未知；只读查看，不能由 TUI 绕过恢复核对';this.tui.requestRender();return;}
    this.editor.addToHistory(text);this.editor.setText('');this.lastText='';
    this.phase='running';this.result=undefined;this.runId=undefined;this.sessionId=undefined;this.records=[];this.summaries.clear();this.historyWindow=false;this.scroll.scrollToEnd();
    this.confirmation=undefined;this.controller=new AbortController();this.cancellation='exit';this.notice='只读任务正在受理；尚未受理的草稿不执行';this.rebuild();
    const self=this;
    const options:ReadTaskOptions={workspace:this.options.workspace,dataRoot:this.options.dataRoot,input:text,mode:this.options.mode,transport:this.options.transport,signal:this.controller.signal,get cancellation(){return self.cancellation;},onObservation:event=>{this.runId=event.runId;this.pendingRefresh=true;}};
    this.active=runReadTask(options).then(result=>{this.result=result;this.sessionId=result.sessionId;this.runId=result.runId;this.notice=result.cleanup==='confirmed'?`清理已确认；run ${result.runId}`:'清理未知；原工作保留，需恢复核对';}).catch(error=>{this.failure=String(error);this.notice=`未完成：${safe(String(error))}`;}).finally(()=>{this.pendingRefresh=true;this.refresh();if(this.phase!=='exiting')this.phase='idle';this.confirmation=undefined;this.tui.requestRender();});
    this.tui.requestRender();
  }
  private command(command:string) {
    if(command==='/help') this.openPanel('help');
    else if(command==='/exit') this.requestExit();
    else if(command==='/restore') {this.editor.setText(this.savedDraft??this.drafts.latest()??'');this.lastText=this.editor.getExpandedText();this.notice='草稿已恢复；尚未提交';}
    else if(command==='/bottom')this.bottom();
    else if(command==='/older')this.window('older');
    else if(command==='/newer')this.window('newer');
    else if(command==='/details')this.openDetail(this.records.at(-1));
    else if(command==='/copy')void this.copyOutput();
    else if(command==='/stop')this.stop();
    else return false;
    return true;
  }
  private stop() {
    this.confirmation=undefined;
    if(this.phase!=='running')return;
    this.cancellation='stop';this.phase='stopping';this.notice=`请求中止 run ${this.runId??'受理中'}；等待 runtime 确认`;this.controller?.abort();this.tui.requestRender();
  }
  private refresh() {
    this.pendingRefresh=false;
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
  private summary(record:RecordReference) {
    try {
      const page=readObjectRange(this.options.dataRoot,record.ref,{limit:4096});
      let preview=page.bytes.toString('utf8');
      let source='';
      if(page.next===null) {
        const value=JSON.parse(preview);
        if(record.kind==='model.provider-event') preview=value.event?.choices?.map((c:{delta?:{content?:string}})=>c.delta?.content??'').join('')||'provider event 已保存';
        else if(record.kind==='model.response') preview=value.message?.content?.map((c:{text?:string})=>c.text??'').join('\n')||JSON.stringify(value);
        else if(record.kind==='tool.result')preview=JSON.stringify(value.result);
        else if(record.kind==='tool.summary') {
          source=` · ${value.isError===true?'失败':value.isError===false?'工具返回':'错误状态 unknown'}${value.truncation?.truncated||value.diagnostics?.some((d:{code?:string})=>d.code==='truncated')?' · 工具源输出截断':' · 未报告源截断'}`;
          preview=`${value.tool} · attempt ${value.attemptId}\n${JSON.stringify(value.diagnostics??[])}${value.diagnosticsOmitted?` · 另有 ${value.diagnosticsOmitted} 条诊断，见原文`:''}`;
        }
        else if(record.kind==='task.accepted')preview=value.input;
        else if(record.kind==='run.closed')preview=`${value.status} · cleanup ${value.cleanup} · usage ${value.usage?.completeness??'unknown'}`;
        else preview=JSON.stringify(value);
        if(record.kind==='model.response'&&value.completeness==='partial')source+=' · 源响应 partial';
      }
      const clipped=preview.length>500||page.next!==null;
      if(record.kind==='tool.result')source+=' · 状态/源截断见相邻 tool.summary（缺失为 unknown）';
      return `[${record.seq}] ${record.kind}${/error|failure/.test(record.kind)?' · 失败':''}${clipped?' · 显示截断':''}${source}\n${safe(preview.slice(0,500))}${clipped?'…（点击/Ctrl+O 查看原文分页）':''}`;
    } catch(error) {return `[${record.seq}] ${record.kind} · 原文不可取得：${safe(String(error))}`;}
  }
  private rebuild() {
    this.transcript.clear();this.summaries.clear();
    if(!this.records.length) this.transcript.addChild(new Text(`在输入区发起一个只读项目请求。\n${this.options.mode==='offline'?'offline-demo：真实 runtime + README.md 固定传输；没有模型推理。':'DeepSeek 凭据从环境读取；没有自动 fallback。'}\nCtrl+J / Shift+Enter / 反斜杠后 Enter 换行。\n拖选自动复制；/copy 提供键盘入口。`,0,0));
    for(const record of this.records) {
      const summary=this.summary(record);this.summaries.set(record.seq,summary);this.latestText=summary;
      this.transcript.addChild(new MouseRegion(new Text(summary,0,0),event=>{if(event.type==='click'){this.openDetail(record);return {handled:true};}}));
    }
    if(this.result?.answer&&!this.historyWindow) {
      const preview=safe(this.result.answer.slice(0,4000));
      this.latestText=preview;
      this.transcript.addChild(new Text(`助手\n${preview}${this.result.answer.length>4000?'\n[显示截断；Ctrl+O 原文分页]':''}`,0,0));
    }
    this.tui.requestRender();
  }
  private bottom() {
    this.confirmation=undefined;this.historyWindow=false;this.scroll.scrollToEnd();this.pendingRefresh=true;this.refresh();this.scroll.scrollToEnd();this.notice='已回到底部，跟随新输出';this.tui.requestRender();
  }
  private window(direction:'older'|'newer') {
    if(!this.runId)return;
    const page=readRunRecords(this.options.dataRoot,this.runId,direction==='older'?{before:this.records[0]?.seq,limit:24,kinds:visibleKinds}:{after:this.records.at(-1)?.seq,limit:24,kinds:visibleKinds});
    if(!page.records.length){this.notice='已到记录边界；/bottom 返回最新';return;}
    this.historyWindow=true;this.records=page.records;this.rebuild();this.scroll.scrollTo(0,{disableFollow:true});this.notice='只读历史窗口；/older /newer 翻页，/bottom 跟随最新';
  }
  private openDetail(record?:RecordReference) {
    if(!record){this.notice='暂无持久记录';return;}
    this.openPanel('detail',record);
  }
  private openPanel(kind:'help'|'exit'|'detail'|'actions',ref?:RecordReference) {
    this.closePanel();this.confirmation=undefined;
    this.panel={kind,ref,offset:0,previous:[],line:0,raw:'',next:null};
    if(kind==='detail')this.loadDetail();
    const component:Component={invalidate(){},render:width=>this.panelLines(width),handleInput:data=>this.panelInput(data),handleMouse:event=>{
      if(!this.panel)return;
      if(event.type==='wheel'){this.panel.line=Math.max(0,this.panel.line+(event.wheelDelta??0));return {handled:true};}
      if(event.type==='click'&&this.panel.kind==='actions'){
        const index=event.y+this.panel.line-1;
        if(commands[index]){const command=commands[index][0];this.closePanel();this.command(`/${command}`);return {handled:true};}
      }
    }};
    const overlay=this.tui.showOverlay(component,{width:'96%',maxHeight:'90%',anchor:'center'});this.hidePanel=()=>overlay.hide();this.tui.requestRender();
  }
  private panelLines(width:number) {
    const panel=this.panel;if(!panel)return[];
    let text:string;
    if(panel.kind==='actions')text='操作菜单（保留输入草稿）\n'+commands.map(([name,description],index)=>`${panel.offset===index?'›':' '} /${name}  ${description}`).join('\n');
    else if(panel.kind==='help')text='帮助（本阶段只读）\nEnter 新任务；忙时文本保留为草稿\nCtrl+J / Shift+Enter / \\ 后 Enter 换行\nCtrl+C 中止；空闲清输入，再按退出\n空输入 Ctrl+D 两次退出（800ms）\nCtrl+D 非空：删除光标后字符簇\nF2 操作菜单；Ctrl+O 详情；Ctrl+L 重绘\nPageUp/PageDown 滚动；/bottom 跟随\n/older /newer 持久记录窗口\n/restore 恢复草稿；/copy 复制输出\n/stop 中止；/exit 退出\n菜单 Tab/方向键/Enter 选择；Esc 关闭\n队列、恢复执行、可写工具尚未接入。';
    else if(panel.kind==='exit')text='退出并保留草稿？\nEnter：保存文本，取消在途请求并等待清理\nEsc：返回；不改变任务状态';
    else text=`原文 #${panel.ref?.seq} ${panel.ref?.kind}\n字节 ${panel.offset} / ${panel.ref?.ref.bytes}；源 JSON，显示有界\n${panel.error??safe(panel.raw)}\n${panel.next===null?'本原文已到末尾':'还有下一片（n）'}`;
    const lines=wrapTextWithAnsi(text,Math.max(1,width-2));
    const height=Math.max(2,Math.floor(this.terminal.rows*0.9)-2);
    const maxLine=Math.max(0,lines.length-height);panel.line=Math.min(panel.line,maxLine);
    return [...lines.slice(panel.line,panel.line+height),truncateToWidth(panel.kind==='detail'?'↑↓滚动 ←→记录 n/p片 y复制当前片 Esc返回':'↑↓滚动 Esc返回',width)];
  }
  private panelInput(data:string) {
    const panel=this.panel;if(!panel)return;
    this.confirmation=undefined;
    if(matchesKey(data,'escape')||matchesKey(data,'ctrl+o')) {this.closePanel();return;}
    if(matchesKey(data,'ctrl+l')){this.tui.requestRender(true);return;}
    if(matchesKey(data,'ctrl+c')||matchesKey(data,'ctrl+d'))return;
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
    if(!this.controller?.signal.aborted)this.cancellation='exit';this.controller?.abort();
    let draftSaved=false;
    try {const draft=this.editor.getExpandedText()||this.savedDraft;if(draft){this.drafts.save(draft);draftSaved=true;}}catch(error){this.failure=`草稿保存失败：${String(error)}`;}
    try {await this.active;} finally {
      this.stopped=true;if(this.timer)clearInterval(this.timer);this.removeInput?.();for(const remove of this.removeSignals)remove();
      try {await this.terminal.drainInput(150,30);} catch(error){this.failure??=`终端 drain 失败：${String(error)}`;}
      try {this.terminal.write('\x1b[?1004l');this.tui.stop({preserveScreen:true});}
      catch(error){this.failure??=`终端清理失败：${String(error)}`;try{this.terminal.stop();}catch{/* Preserve the cleanup failure. */}}
      finally {try{this.terminal.showCursor();}catch{/* Earlier failure remains visible in the exit result. */}}
    }
    const result={result:this.result,error:this.failure,draftSaved};
    this.resolveClosed(result);return result;
  }
}

export async function runTui(options:TuiOptions) {
  const app=new ReadOnlyTui(options);
  try {app.start();return await app.closed;} finally {await app.exit();}
}
