/** A single source's original, paginated without treating retained text as terminal instructions. */
import { matchesKey, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { readEvidence } from '../history.js';
import { RawContent, plainText } from '../trace-raw.js';
import { RAW_STATE_LABEL, type TraceRawState } from '../trace.js';
import { visibleControls } from './trace-raw.js';
import { fixedFrame, hintLine } from './view-stack.js';
import { COLOR_TIER, styledLine, type ColorTier } from './theme.js';
import { type StatsTarget } from './stats-drilldown.js';

export class EvidenceRawView {
  private readonly content?: RawContent;
  private readonly report?: string;
  private error?: string;
  private page = 0;
  private offset = 0;
  constructor(readonly target: Extract<StatsTarget, { kind: 'raw' | 'report' }>, private readonly host: { copy(text: string): Promise<boolean | string>; feedback(text: string): void; changed(): void }) {
    if (target.kind === 'report') this.report = plainText(target.value).join('\n');
    else {
      try {
        const state: TraceRawState = readEvidence(target.root, target.id, { limit: 1 }).state;
        this.content = new RawContent(target.root, { label: '记录原文', sources: [target.id], state });
      } catch (error) { this.error = String(error); }
    }
  }
  private current() { return this.content?.page(this.page); }
  handleInput(data: string) {
    if (matchesKey(data, 'up')) this.scroll(-1);
    else if (matchesKey(data, 'down')) this.scroll(1);
    else if (matchesKey(data, 'pageUp')) this.scroll(-8);
    else if (matchesKey(data, 'pageDown')) this.scroll(8);
    else if (data === 'n' || data === 'p') { const pages = this.current()?.pages ?? 1; this.page = Math.max(0, Math.min(pages - 1, this.page + (data === 'n' ? 1 : -1))); this.offset = 0; }
    else if (data === 'y') {
      const current = this.current(), text = this.report ?? current?.text;
      if (text === undefined || this.error || current?.error) this.host.feedback('当前页没有可复制的原文');
      else void this.host.copy(text).then(result => this.host.feedback(result === true ? '已复制当前页' : `复制失败 · ${String(result)}`), error => this.host.feedback(`复制失败 · ${String(error)}`)).finally(() => this.host.changed());
    }
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); }
  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const page = this.current(), raw = this.target.kind === 'raw';
    const title = raw ? `◆ 记录原文 · ${this.target.id}` : `◆ ${this.target.title}`;
    const status = page ? `${RAW_STATE_LABEL[page.state]} · 第 ${page.page + 1}/${page.pages} 页${page.note ? ` · ${page.note}` : ''}` : raw ? '原文不可取得' : '派生报告 · 不替代原文';
    const text = this.error ?? page?.error ?? this.report ?? page?.text ?? '';
    const body = visibleControls(text).split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 1))).map(text => styledLine([{ text: ' ' + text, fg: 'fg.body' }], width, undefined, tier));
    const frame = fixedFrame([styledLine([{ text: title, fg: 'fg.primary' }], width, undefined, tier), styledLine([{ text: status, fg: 'fg.label' }], width, undefined, tier)], body, [hintLine(['↑↓ 滚动', ...raw ? ['n/p 翻页'] : [], 'y 复制'], width, { esc: 'Esc 返回上层', tier })], height, this.offset);
    this.offset = frame.offset;
    return frame.lines;
  }
}
