import { visibleWidth, type Component, type Terminal, type TuiAltScreen } from '@earendil-works/pi-tui';
import { dimForOverlay, styledLine } from './theme.js';

/** T1 full views cover every terminal cell, including when their body is short. */
export function showFullScreen(tui: TuiAltScreen, terminal: Pick<Terminal,'rows'>, component: Component, dimmed: () => boolean = () => false) {
  const frame: Component = {...component, render: width => {
    const lines = component.render(width).slice(0, terminal.rows);
    const filled = [...lines.map(line => line + styledLine([],Math.max(0,width-visibleWidth(line)))),
      ...Array.from({length:Math.max(0,terminal.rows-lines.length)},()=>styledLine([],width))];
    return dimmed() ? filled.map(line => dimForOverlay(line)) : filled;
  }};
  return tui.showOverlay(frame,{width:'100%',maxHeight:'100%',anchor:'center',visible:(width,height)=>width>=40&&height>=12});
}
