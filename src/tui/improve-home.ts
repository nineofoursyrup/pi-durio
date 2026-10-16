/**
 * improve 视图第一层（U13、#60 第 7 节；#89）。条目自上而下：进行中的分析或提交批次、待选择的报告、新建分析、
 * 历史报告 · N 份、建议抑制 · M 项。只读；各条目的去处由宿主（app.ts）决定。
 */
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { styledLine, type TextSegment } from './theme.js';
import { clean, escHint, fixedFrame, hintLine, statusError, truncateEnd, truncateMiddle, widthTier } from './view-stack.js';
import { improveHome, type ImproveHomeFacts } from '../improve-entry.js';
import { readDisplayIndex, type DisplayIndex } from '../display-number.js';
import { homedir } from 'node:os';

export type HomeItem =
  | { kind: 'current'; text: string }
  | { kind: 'report'; id: string }
  | { kind: 'new' }
  | { kind: 'history' }
  | { kind: 'suppressions' };
export interface HomeHost {
  workspace: string;
  /** 进行中的分析或提交批次的一行（如 `⠹ 分析 ir-… · 第 M 轮 · mm:ss`），渲染时取；没有时 undefined。 */
  current(): string | undefined;
}

function at(iso: string) {
  const date = new Date(iso), pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class ImproveHome {
  private facts?: ImproveHomeFacts;
  private error?: string;
  private index?: DisplayIndex;
  private cursor = 0;
  private offset = 0;

  constructor(private readonly root: string, private readonly host: HomeHost) { this.refresh(true); }

  /** 重新读取条目事实；`select` 时按规则重设默认选中项（有待选择的报告选第一份，否则“新建分析”）。 */
  refresh(select = false) {
    try { this.facts = improveHome(this.root, this.host.workspace); this.index = readDisplayIndex(this.root); this.error = undefined; }
    catch (error) { this.error = clean(String(error instanceof Error ? error.message : error)); }
    const items = this.items();
    if (select) this.cursor = Math.max(0, items.findIndex(i => i.kind === 'report' || i.kind === 'new'));
    this.cursor = Math.min(this.cursor, items.length - 1);
  }
  items(): HomeItem[] {
    const current = this.host.current();
    return [...(current ? [{ kind: 'current' as const, text: current }] : []), ...(this.facts?.pending ?? []).map(p => ({ kind: 'report' as const, id: p.id })), { kind: 'new' }, { kind: 'history' }, { kind: 'suppressions' }];
  }
  get selected(): HomeItem { return this.items()[this.cursor]; }

  /** Enter 返回选中条目，交给宿主打开；其余按键在本层处理。 */
  handleInput(data: string): HomeItem | undefined {
    const items = this.items();
    if (matchesKey(data, 'up')) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, 'down')) this.cursor = Math.min(items.length - 1, this.cursor + 1);
    else if (matchesKey(data, 'enter')) return items[this.cursor];
    return undefined;
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); }

  render(width: number, height: number, depth = 1): string[] {
    const brand: TextSegment[] = [{ text: '◆ ', fg: 'ac.brand' }, { text: 'improve', fg: 'fg.primary', bold: true }];
    // 头部右侧是说明文字，宽度小于 100 时收起（#60 第 7 节）。
    const note = widthTier(width) === 'wide' ? '分析不执行候选' : '', room = width - visibleWidth('◆ improve  ') - (note ? visibleWidth(note) + 2 : 0);
    const home = homedir(), workspace = this.host.workspace.startsWith(`${home}/`) ? `~${this.host.workspace.slice(home.length)}` : this.host.workspace;
    const left = `  ${truncateMiddle(clean(workspace), Math.max(1, room))}`, used = visibleWidth('◆ improve') + visibleWidth(left);
    const header = [styledLine([...brand, { text: left, fg: 'fg.body' }, ...(note ? [{ text: ' '.repeat(Math.max(2, width - used - visibleWidth(note))) }, { text: note, fg: 'fg.muted' as const }] : [])], width), styledLine([], width)];
    const body: string[] = [];
    if (this.error) body.push(...statusError('improve 记录不可读取', this.error.split(/[\s:]/)[0] || 'IMPROVE_READ_FAILED', '/improve 重新打开', width), styledLine([], width));
    const facts = this.facts, pending = new Map((facts?.pending ?? []).map(p => [p.id, p]));
    let cursorLine = -1;
    this.items().forEach((item, i) => {
      const focused = i === this.cursor, mark = focused ? '› ' : '  ';
      let segments: TextSegment[];
      if (item.kind === 'current') segments = [{ text: truncateEnd(`${mark}${clean(item.text)}`, width), fg: 'fg.body' }];
      else if (item.kind === 'report') {
        const p = pending.get(item.id)!, session = p.sessionId ? this.index!.label('session', p.sessionId) : '会话未记录';
        segments = [{ text: truncateEnd(`${mark}${this.index!.label('improve-report', p.id)} · ${at(p.startedAt)} · 来自 ${session} · 候选 ${p.candidates} · 未决 ${p.undecided}`, width), fg: 'fg.body' }];
      } else if (item.kind === 'new') segments = [{ text: `${mark}新建分析`, fg: 'fg.primary' }];
      else if (item.kind === 'history') segments = facts?.reports ? [{ text: `${mark}历史报告 · ${facts.reports} 份`, fg: 'fg.body' }] : [{ text: `${mark}历史报告 · `, fg: 'fg.body' }, { text: '本工作区还没有报告', fg: 'fg.muted' }];
      else segments = facts?.suppressions ? [{ text: `${mark}建议抑制 · ${facts.suppressions} 项`, fg: 'fg.body' }] : [{ text: `${mark}建议抑制 · `, fg: 'fg.body' }, { text: '没有生效的抑制', fg: 'fg.muted' }];
      // 进行中与待选择的条目之后各空一行，与固定入口分开。
      if (item.kind === 'new' && i > 0) body.push(styledLine([], width));
      if (focused) cursorLine = body.length;
      body.push(styledLine(segments, width, focused ? 'bg.selected' : undefined));
    });
    const footer = [hintLine(['↑↓ 选择', 'Enter 打开'], width, { esc: escHint(depth) })];
    const bodyHeight = Math.max(0, height - header.length - footer.length);
    if (cursorLine >= 0) { if (cursorLine < this.offset) this.offset = cursorLine; else if (cursorLine >= this.offset + bodyHeight) this.offset = cursorLine - bodyHeight + 1; }
    const frame = fixedFrame(header, body, footer, height, this.offset);
    this.offset = frame.offset;
    // 主体不足时用底色补满，浮层下的会话屏不透出。
    return frame.lines.map(line => line || styledLine([], width));
  }
}
