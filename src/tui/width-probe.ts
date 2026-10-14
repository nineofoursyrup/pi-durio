import type { Terminal } from '@earendil-works/pi-tui';

type ProbeTerminal=Pick<Terminal,'write'|'columns'|'rows'>;
type Query={column?:number;error?:string;expired:boolean;timer:ReturnType<typeof setTimeout>;complete:(error?:Error)=>void};
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});

/** One ordered CPR + DA1 exchange at a time. A timed-out exchange retains its tombstone until DA1. */
export class TerminalWidthProbe {
  private pending?:Query;
  private closed=false;
  private boundaryWaiters:Array<()=>void>=[];
  readonly observations:Array<{grapheme:string;width:number;elapsedMs:number}>=[];
  constructor(private readonly terminal:ProbeTerminal,private readonly timeoutMs=1200,private readonly cursorVisible:()=>boolean=()=>false) {}
  get canRetry(){return !this.pending&&!this.closed;}

  /** Receives complete events from ProcessTerminal's public StdinBuffer path. Paste stays opaque. */
  consume(data:string):boolean {
    if(data.startsWith('\x1b[200~'))return false;
    const cpr=/^\x1b\[(\d+);(\d+)R$/.exec(data);
    // Row 1 is also the modified F3 key encoding; our reserved measuring row is 2.
    if(cpr&&Number(cpr[1])!==1) {
      if(this.pending&&!this.pending.expired) {
        if(this.pending.column!==undefined)this.pending.error='DUPLICATE_CPR';
        if(Number(cpr[1])!==2)this.pending.error='CPR_WRAPPED_OR_WRONG_ROW';
        this.pending.column=Number(cpr[2]);
      }
      return true;
    }
    if(/^\x1b\[\?[\d;]*c$/.test(data)) {
      const pending=this.pending;
      if(pending) {
        this.pending=undefined;clearTimeout(pending.timer);
        if(!pending.expired)pending.complete(pending.error?new Error(pending.error):undefined);
        for(const resolve of this.boundaryWaiters.splice(0))resolve();
      }
      return true;
    }
    return false;
  }
  private query(text:string,signal:AbortSignal):Promise<number> {
    if(this.pending)return Promise.reject(new Error('PRIOR_QUERY_BOUNDARY_UNKNOWN'));
    if(this.closed||signal.aborted)return Promise.reject(new Error('WIDTH_PROBE_CANCELLED'));
    if(this.terminal.rows<3||this.terminal.columns<12)return Promise.reject(new Error('WIDTH_PROBE_WINDOW_TOO_SMALL'));
    const columns=this.terminal.columns,rows=this.terminal.rows;
    return new Promise((resolve,reject)=>{
      const fail=(message:string)=>{pending.expired=true;clearTimeout(pending.timer);signal.removeEventListener('abort',abort);reject(new Error(message));};
      const abort=()=>fail('WIDTH_PROBE_CANCELLED');
      const pending:Query={expired:false,timer:setTimeout(()=>fail('WIDTH_CPR_TIMEOUT'),this.timeoutMs),complete:error=>{
        signal.removeEventListener('abort',abort);
        if(error)return reject(error);
        if(columns!==this.terminal.columns||rows!==this.terminal.rows)return reject(new Error('WIDTH_WINDOW_CHANGED'));
        const column=pending.column;
        if(column===undefined||column<1||column>=this.terminal.columns-1)return reject(new Error('WIDTH_CPR_MISSING_OR_OUT_OF_BOUNDS'));
        resolve(column);
      }};
      this.pending=pending;
      signal.addEventListener('abort',abort,{once:true});
      try {
        // Pi's startup DA1 is sent earlier and consumed by ProcessTerminal before this sentinel.
        // Restore the prior caret in this same write, before waiting for CPR. Native IME acceptance
        // must still establish whether the brief measuring move affects a live candidate window.
        this.terminal.write(`\x1b[?2026h\x1b7\x1b[?25l\x1b[2;1H\x1b[2K${text}\x1b[6n\x1b8\x1b[?25${this.cursorVisible()?'h':'l'}\x1b[c`);
      }catch(error){fail(`WIDTH_WRITE_FAILED: ${String(error)}`);}
    });
  }
  async measure(grapheme:string,signal:AbortSignal):Promise<number> {
    if([...segmenter.segment(grapheme)].length!==1||/[\x00-\x1f\x7f-\x9f]/.test(grapheme)||Buffer.byteLength(grapheme)>256)throw Error('WIDTH_GRAPHEME_NOT_MEASURABLE');
    const started=performance.now();
    const bare=await this.query(grapheme,signal),context=await this.query(`A${grapheme}B`,signal);
    if(context!==bare+2)throw Error('WIDTH_CONTEXT_MISMATCH');
    const width=bare-1;
    this.observations.push({grapheme,width,elapsedMs:Math.round((performance.now()-started)*1000)/1000});
    return width;
  }
  close(){this.closed=true;}
  async waitForBoundary(maxMs=250):Promise<boolean> {
    if(!this.pending)return true;
    await new Promise<void>(resolve=>{
      const complete=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{const index=this.boundaryWaiters.indexOf(complete);if(index>=0)this.boundaryWaiters.splice(index,1);resolve();},maxMs);
      this.boundaryWaiters.push(complete);
    });
    return !this.pending;
  }
}
