import { setGraphemeWidthOverrides, stripTerminalSequences, type Terminal, type TuiAltScreen } from '@earendil-works/pi-tui';
import { TerminalWidthProbe } from './width-probe.js';

const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
let owner:TerminalWidthGate|undefined;
export interface UnappliedInput {data:string;context:string;}
export interface WidthGateOptions {
  terminal:Terminal; tui:TuiAltScreen;
  sources:()=>string[];
  priorityInput:(data:string)=>boolean;
  context:()=>string;
  ready:()=>void;
  retain:(inputs:UnappliedInput[],reason:string)=>void;
  timeoutMs?:number;
}

/** Serializes actual-terminal measurements, geometry-dependent input and complete redraws. */
export class TerminalWidthGate {
  private readonly originalWrite:Terminal['write'];
  private readonly originalStart:Terminal['start'];
  private readonly probe:TerminalWidthProbe;
  private profile=new Map<string,number>();
  private pendingInputs:UnappliedInput[]=[];
  private inputBytes=0;
  private wanted=new Set<string>();
  private lastFrame='';
  private acceptInput?:(data:string)=>void;
  private busy=false;
  private queryHolds=0;
  private calibration?:Promise<void>;
  private error?:string;
  private closing=false;
  private epoch=0;
  private controller?:AbortController;
  private blockedFrames=0;
  private retainedInputs=0;
  private cursorVisible=false;
  constructor(private readonly options:WidthGateOptions) {
    if(owner)throw Error('WIDTH_PROFILE_IN_USE');
    owner=this;
    setGraphemeWidthOverrides();
    const terminal=options.terminal;
    this.originalWrite=terminal.write;this.originalStart=terminal.start;
    this.probe=new TerminalWidthProbe({get columns(){return terminal.columns;},get rows(){return terminal.rows;},write:data=>this.originalWrite.call(terminal,data)},options.timeoutMs,()=>this.cursorVisible);
    terminal.write=data=>{
      const paint=data.startsWith('\x1b[?2026h')&&/\x1b\[\d*;?\d*H/.test(data);
      if(paint) {
        this.lastFrame=stripTerminalSequences(data.replace(/\x1b\[\d*;?\d*H/g,'\n'));
        this.inspect([this.lastFrame]);
        if(this.blocked||this.closing){this.blockedFrames++;return;}
      }
      const visibility=[...data.matchAll(/\x1b\[\?25([hl])/g)].at(-1);
      if(visibility)this.cursorVisible=visibility[1]==='h';
      this.originalWrite.call(terminal,data);
    };
    terminal.start=(input,resize)=>{
      this.acceptInput=input;
      this.originalStart.call(terminal,data=>{
        if(this.consumeTerminalReply(data))return;
        const event={data,context:options.context()};
        if(this.closing){this.retain([event],'arrived-during-exit');return;}
        if(this.blocked) {
          if(options.priorityInput(data))return;
          if(this.inputBytes+Buffer.byteLength(data)>65536) {
            this.retainPending('width-input-buffer-full');
            this.retain([event],'width-input-buffer-full');
            this.fail('INPUT_BUFFER_FULL; input saved, not applied');
          } else {this.pendingInputs.push(event);this.inputBytes+=Buffer.byteLength(data);}
          return;
        }
        input(data);this.inspect();
      },()=>{
        resize();
        if(this.error?.includes('WINDOW')&&this.probe.canRetry)this.retry();
      });
    };
  }
  /** Outer input observers must consume these before treating an event as a user action. */
  consumeTerminalReply(data:string){return this.probe.consume(data);}
  get blocked(){return this.busy||this.queryHolds>0||this.error!==undefined;}
  /** Keep synchronous host checks out of a timed CPR exchange, including any already in flight. */
  async withoutQueries<T>(work:()=>Promise<T>):Promise<T> {
    this.queryHolds++;
    try {
      await this.calibration;
      if(this.closing)throw Error('WIDTH_GATE_CLOSED');
      if(!this.error)this.message('Checking recovery; input retained. Ctrl+C / Esc available.');
      return await work();
    } finally {
      this.queryHolds--;
      if(!this.closing&&!this.queryHolds) {
        this.inspect();
        if(!this.blocked){this.options.ready();this.options.tui.renderNow(true);this.drain();}
      }
    }
  }
  inspect(extra:string[]=[]):void {
    if(this.closing)return;
    for(const source of [...this.options.sources(),...extra]) {
      for(const {segment} of segmenter.segment(stripTerminalSequences(source))) {
        if(/[^\x00-\x7f]/.test(segment)&&!/[\x00-\x1f\x7f-\x9f]/.test(segment)&&!this.profile.has(segment))this.wanted.add(segment);
      }
    }
    if(this.busy||this.queryHolds||this.error||!this.wanted.size)return;
    if(this.profile.size+this.wanted.size>4096){this.fail('WIDTH_SESSION_LIMIT');return;}
    this.busy=true;
    const epoch=++this.epoch,controller=new AbortController();this.controller=controller;
    // The frame may be inside Pi's render method. Never recursively render from terminal.write.
    this.calibration=Promise.resolve().then(()=>this.calibrate(epoch,controller));
  }
  private async calibrate(epoch:number,controller:AbortController) {
    const next=new Map(this.profile);
    try {
      this.message('Measuring display widths; input retained. Ctrl+C / Esc available.');
      while(this.wanted.size) {
        const grapheme=this.wanted.values().next().value!;this.wanted.delete(grapheme);
        if(!next.has(grapheme))next.set(grapheme,await this.probe.measure(grapheme,controller.signal));
        if(this.closing||epoch!==this.epoch)return;
      }
      setGraphemeWidthOverrides(next);this.profile=next;this.busy=false;
      this.options.tui.resetTextSelection();this.options.tui.invalidate();
      this.options.ready();this.options.tui.renderNow(true);
      this.drain();
    }catch(error){if(!this.closing&&epoch===this.epoch)this.fail(String(error));}
  }
  private fail(error:string) {this.epoch++;this.error=error;this.busy=false;this.controller?.abort();this.message(`Display unverified: ${error}. Ctrl+L retry; Ctrl+C twice exit.`);}
  private message(message:string) {
    const line=message.replace(/[^\x20-\x7e]/g,'?').slice(0,Math.max(1,this.options.terminal.columns-1));
    this.originalWrite.call(this.options.terminal,`\x1b[?2026h\x1b7\x1b[?25l\x1b[1;1H\x1b[2K${line}\x1b8\x1b[?25${this.cursorVisible?'h':'l'}\x1b[?2026l`);
  }
  private drain() {
    while(!this.closing&&!this.blocked&&this.pendingInputs.length) {
      const event=this.pendingInputs.shift()!;this.inputBytes-=Buffer.byteLength(event.data);
      const text=/^[^\x00-\x1f\x7f-\x9f]+$/.test(event.data)||(event.data.startsWith('\x1b[200~')&&event.data.endsWith('\x1b[201~'));
      if(event.context!==this.options.context())this.retain([event],'interaction-context-changed');
      else if(!text)this.retain([event],'action-needs-current-frame');
      else this.acceptInput?.(event.data);
      this.inspect();
    }
    if(!this.closing&&!this.blocked)this.options.tui.renderNow(true);
  }
  /** Explicit Ctrl+L also remeasures after a font/settings change; no cross-session cache. */
  retry(reset=false) {
    if(this.closing)return;
    if(this.busy){this.message('Display measurement in progress; Ctrl+C / Esc remain available.');return;}
    if(!this.probe.canRetry){this.message('Prior terminal reply incomplete. Exit and reopen; inputs retained.');return;}
    this.error=undefined;this.wanted.clear();
    if(reset)this.profile.clear();
    this.inspect([this.lastFrame]);
    if(!this.blocked){this.options.tui.invalidate();this.options.tui.renderNow(true);this.drain();}
  }
  private retain(inputs:UnappliedInput[],reason:string) {
    if(!inputs.length)return;
    this.options.retain(inputs,reason);this.retainedInputs+=inputs.length;
  }
  retainPending(reason:string) {
    this.retain(this.pendingInputs,reason);this.pendingInputs=[];this.inputBytes=0;
  }
  beginClose() {
    if(this.closing)return;
    this.closing=true;this.epoch++;this.controller?.abort();this.probe.close();
    this.retainPending('exit-before-width-confirmed');
  }
  async settle(){return this.probe.waitForBoundary();}
  snapshot(){return {status:this.error?'unverified':this.closing&&this.busy?'cancelled':'measured',error:this.error??null,profile:[...this.profile],observations:this.probe.observations,blockedFrames:this.blockedFrames,retainedInputs:this.retainedInputs,pendingInputs:this.pendingInputs.length};}
  dispose() {
    this.beginClose();
    this.options.terminal.write=this.originalWrite;this.options.terminal.start=this.originalStart;
    setGraphemeWidthOverrides();if(owner===this)owner=undefined;
  }
}
