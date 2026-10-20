import { CURSOR_MARKER, Editor, truncateToWidth, visibleWidth, type EditorOptions, type EditorTheme, type Terminal, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { GLYPHS, fgSgr, bgSgr, resetSgr } from './theme.js';

/**
 * pi-tui 1.1.0 paints a software caret even when hardware cursor display is on.
 * 输入框左右各留 2 列，首行左侧的 2 列画 `ac.brand` 的提示符 `❯`（U10）。
 */
export class HardwareCursorEditor extends Editor {
  private frameBottomBorder='';
  /** 输入为空时显示在插入点之后的占位文案（fg.faint）；pi-tui 1.1.0 的 Editor 没有占位。 */
  placeholder?:()=>string;
  constructor(tui:TUI,theme:EditorTheme,options:EditorOptions={}) {super(tui,theme,{paddingX:2,...options});}
  protected override renderTopBorder(width:number,hidden:number):string {
    return this.borderColor('╭')+super.renderTopBorder(width,hidden)+this.borderColor('╮');
  }
  protected override renderBottomBorder(width:number,hidden:number):string {
    return this.frameBottomBorder=this.borderColor('╰')+super.renderBottomBorder(width,hidden)+this.borderColor('╯');
  }
  override handleMouse(event:TuiMouseEvent) { return super.handleMouse({...event,x:event.x-1,width:Math.max(1,event.width-2)}); }
  override render(width:number):string[] {
    const inner=Math.max(1,width-2);
    const focused=this.focused;
    let lines:string[];
    // Request the public marker even when blurred so only the caret's style can
    // be removed. Do not strip reverse-video styles from menus or selections.
    this.focused=true;
    try {lines=super.render(inner);} finally {this.focused=focused;}
    // Locate the line emitted by our protected hook before adapting its contents.
    // Upstream appends autocomplete after it; no private render state or width guessing is needed.
    const bottomBorder=lines.indexOf(this.frameBottomBorder);
    lines=lines.map(line=>{
      const unpainted=line.replace(CURSOR_MARKER+'\x1b[7m',CURSOR_MARKER);
      return focused?unpainted:unpainted.replaceAll(CURSOR_MARKER,'');
    });
    const pad=Math.min(this.getPaddingX(),Math.max(0,Math.floor((inner-1)/2)));
    const placeholder=this.getText()?'':this.placeholder?.()??'';
    if(placeholder&&lines.length>=3){
      // 空输入只有一行内容（第 2 行）；插入点保持在内容起点，占位跟在后面。
      const text=truncateToWidth(placeholder,Math.max(0,inner-1-2*pad),'…');
      lines[1]=`${' '.repeat(pad)}${focused?CURSOR_MARKER:''}${fgSgr('fg.faint')}${text}${resetSgr()}${' '.repeat(Math.max(0,inner-pad-visibleWidth(text)))}`;
    }
    if(pad>=2&&lines.length>=3)lines[1]=`${fgSgr('ac.brand')}${GLYPHS.prompt}${resetSgr()} ${lines[1].slice(2)}`;
    // Only input rows gain side borders; menus retain the same one-column left inset.
    // The upstream scroll borders keep their ↑/↓ counts.
    // Editor resets must restore bg.base so cursor and padding never expose the terminal background.
    const base=bgSgr('bg.base');
    return lines.map((line,row)=>{
      let boxed=line;
      if(row>0&&row<bottomBorder)boxed=this.borderColor('│')+line+this.borderColor('│');
      else if(row>bottomBorder)boxed=' '+line+' '.repeat(Math.max(0,width-1-visibleWidth(line)));
      return base+boxed.replaceAll(resetSgr(),resetSgr()+base)+resetSgr();
    });
  }
}

/** Keep a visible hardware caret out of intermediate paint positions. */
export function hideCursorDuringPaint(terminal:Terminal):()=>void {
  const original=terminal.write;
  terminal.write=function(data:string) {
    // Pi restores the final caret visibility after positioning it. Preserve
    // that decision, including overlay hiding and shell restoration on stop.
    original.call(terminal,data.replaceAll('\x1b[?2026h','\x1b[?2026h\x1b[?25l'));
  };
  return ()=>{terminal.write=original;};
}
