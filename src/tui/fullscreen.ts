import { visibleWidth, type Component, type Terminal, type TuiAltScreen } from '@earendil-works/pi-tui';
import { styledLine } from './theme.js';

/** T1 full views cover every terminal cell, including when their body is short. */
export function showFullScreen(tui: TuiAltScreen, terminal: Pick<Terminal,'rows'>, component: Component) {
  const frame: Component = {...component, render: width => {
    const lines = component.render(width).slice(0, terminal.rows);
    return [...lines.map(line => line + styledLine([],Math.max(0,width-visibleWidth(line)))),
      ...Array.from({length:Math.max(0,terminal.rows-lines.length)},()=>styledLine([],width))];
  }};
  return tui.showOverlay(frame,{width:'100%',maxHeight:'100%',anchor:'center'});
}
