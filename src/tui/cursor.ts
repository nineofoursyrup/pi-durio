import { CURSOR_MARKER, Editor, type Terminal } from '@earendil-works/pi-tui';

/** pi-tui 1.1.0 paints a software caret even when hardware cursor display is on. */
export class HardwareCursorEditor extends Editor {
  override render(width:number):string[] {
    const focused=this.focused;
    let lines:string[];
    // Request the public marker even when blurred so only the caret's style can
    // be removed. Do not strip reverse-video styles from menus or selections.
    this.focused=true;
    try {lines=super.render(width);} finally {this.focused=focused;}
    return lines.map(line=>{
      const unpainted=line.replace(CURSOR_MARKER+'\x1b[7m',CURSOR_MARKER);
      return focused?unpainted:unpainted.replaceAll(CURSOR_MARKER,'');
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
