import { CURSOR_MARKER, Editor, truncateToWidth, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { fgSgr, resetSgr } from './theme.js';

/** pi-tui 1.1.0 paints a software caret even when hardware cursor display is on. */
export class HardwareCursorEditor extends Editor {
  /** 输入为空时显示在插入点之后的占位文案（fg.faint）；pi-tui 1.1.0 的 Editor 没有占位。 */
  placeholder?:()=>string;
  override render(width:number):string[] {
    const focused=this.focused;
    let lines:string[];
    // Request the public marker even when blurred so only the caret's style can
    // be removed. Do not strip reverse-video styles from menus or selections.
    this.focused=true;
    try {lines=super.render(width);} finally {this.focused=focused;}
    lines=lines.map(line=>{
      const unpainted=line.replace(CURSOR_MARKER+'\x1b[7m',CURSOR_MARKER);
      return focused?unpainted:unpainted.replaceAll(CURSOR_MARKER,'');
    });
    const placeholder=this.getText()?'':this.placeholder?.()??'';
    if(placeholder&&lines.length>=3){
      // 空输入只有一行内容（第 2 行）；插入点保持在行首，占位跟在后面。
      const text=truncateToWidth(placeholder,Math.max(0,width-1),'…');
      lines[1]=`${focused?CURSOR_MARKER:''}${fgSgr('fg.faint')}${text}${resetSgr()}${' '.repeat(Math.max(0,width-visibleWidth(text)))}`;
    }
    return lines;
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
