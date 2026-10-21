import { CURSOR_MARKER, Editor, truncateToWidth, visibleWidth, type Component, type EditorOptions, type EditorTheme, type Terminal, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { GLYPHS, fgSgr, bgSgr, resetSgr } from './theme.js';

/**
 * pi-tui 1.1.0 paints a software caret even when hardware cursor display is on.
 * 输入框左右各留 2 列，首行左侧的 2 列画 `ac.brand` 的提示符 `❯`（U10）。
 */
export class HardwareCursorEditor extends Editor {
  private frameBottomBorder='';
  private inputRows=0;
  private autocompleteHitRows:Array<number|undefined>=[];
  private readonly menuRender:{selected?:string;counter?:string};
  /** 输入为空时显示在插入点之后的占位文案（fg.faint）；pi-tui 1.1.0 的 Editor 没有占位。 */
  placeholder?:()=>string;
  constructor(tui:TUI,theme:EditorTheme,options:EditorOptions={}) {
    // Theme hooks identify the exact rendered rows without reading pi-tui's private selection state.
    const menuRender:{selected?:string;counter?:string}={};
    super(tui,{...theme,selectList:{...theme.selectList,
      selectedText:text=>menuRender.selected=theme.selectList.selectedText(text),
      scrollInfo:text=>menuRender.counter=theme.selectList.scrollInfo(text),
    }},{paddingX:2,...options});
    this.menuRender=menuRender;
  }
  protected override renderTopBorder(width:number,hidden:number):string {
    return this.borderColor('╭')+super.renderTopBorder(width,hidden)+this.borderColor('╮');
  }
  protected override renderBottomBorder(width:number,hidden:number):string {
    return this.frameBottomBorder=this.borderColor('╰')+super.renderBottomBorder(width,hidden)+this.borderColor('╯');
  }
  /** 会话屏把菜单放在状态/队列区之前，输入框本身仍作为焦点与鼠标目标。 */
  separateAutocomplete(availableRows:()=>number):Component {
    return {invalidate:()=>this.invalidate(),render:width=>this.renderAutocomplete(width,availableRows()),handleMouse:event=>{
      const row=event.type==='wheel'?this.autocompleteHitRows.find(row=>row!==undefined):this.autocompleteHitRows[event.y];
      if(row===undefined)return {handled:true};
      const result=this.handleEditorMouse({...event,y:row+this.inputRows});
      if(result?.focus)this.tui.setFocus(this);
      return result?{...result,focus:false}:undefined;
    }};
  }
  private renderAutocomplete(width:number,availableRows:number):string[] {
    const {autocomplete,selected,counter}=this.renderParts(width),height=Math.max(0,Math.floor(availableRows));
    this.autocompleteHitRows=[];
    if(!autocomplete.length||height===0)return [];
    if(height<2){
      const pad=Math.min(this.getPaddingX(),Math.max(0,Math.floor((width-3)/2))),left=1+pad;
      const line=' '.repeat(left)+truncateToWidth(fgSgr('ac.warn')+'补全空间不足 · 请扩大窗口'+resetSgr(),Math.max(0,width-left),'');
      return [this.baseLine(line+' '.repeat(Math.max(0,width-visibleWidth(line))))];
    }
    if(autocomplete.length<=height){
      this.autocompleteHitRows=autocomplete.map((_,row)=>row===counter?undefined:row);
      return autocomplete;
    }
    const items=autocomplete.map((_,row)=>row).filter(row=>row!==counter),chosen=Math.max(0,items.indexOf(selected));
    const count=height-1,start=Math.max(0,Math.min(chosen-Math.floor(count/2),items.length-count));
    this.autocompleteHitRows=[...items.slice(start,start+count),undefined];
    return [...items.slice(start,start+count).map(row=>autocomplete[row]),autocomplete[counter]];
  }
  private baseLine(line:string) {const base=bgSgr('bg.base');return base+line.replaceAll(resetSgr(),resetSgr()+base)+resetSgr();}
  private handleEditorMouse(event:TuiMouseEvent) {return super.handleMouse({...event,x:event.x-1,width:Math.max(1,event.width-2)});}
  override handleMouse(event:TuiMouseEvent) {
    return this.handleEditorMouse(event);
  }
  override render(width:number):string[] {
    return this.renderParts(width).input;
  }
  private renderParts(width:number) {
    const inner=Math.max(1,width-2);
    const focused=this.focused;
    let lines:string[];
    // Request the public marker even when blurred so only the caret's style can
    // be removed. Do not strip reverse-video styles from menus or selections.
    this.menuRender.selected=undefined;this.menuRender.counter=undefined;
    this.focused=true;
    try {lines=super.render(inner);} finally {this.focused=focused;}
    // Locate the line emitted by our protected hook before adapting its contents.
    // Upstream appends autocomplete after it; no private render state or width guessing is needed.
    const bottomBorder=lines.indexOf(this.frameBottomBorder);
    this.inputRows=bottomBorder+1;
    const menu=lines.slice(this.inputRows),selected=this.menuRender.selected?menu.findIndex(line=>line.includes(this.menuRender.selected!)):-1,counter=this.menuRender.counter?menu.findIndex(line=>line.includes(this.menuRender.counter!)):-1;
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
    lines=lines.map((line,row)=>{
      let boxed=line;
      if(row>0&&row<bottomBorder)boxed=this.borderColor('│')+line+this.borderColor('│');
      else if(row>bottomBorder)boxed=' '+line+' '.repeat(Math.max(0,width-1-visibleWidth(line)));
      return this.baseLine(boxed);
    });
    return {input:lines.slice(0,this.inputRows),autocomplete:lines.slice(this.inputRows),selected,counter};
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
