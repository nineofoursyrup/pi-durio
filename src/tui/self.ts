import { matchesKey, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { readSelfSnapshot, selfStorage, processMeasurements, type ProcessMeasurements, type SelfSnapshot, type SelfValue } from '../self-measurement.js';
import { spendRows } from './stats.js';
import { statsDate } from './stats-filter.js';
import { formatBytes } from './storage.js';
import { COLOR_TIER, styledLine, type ColorTier, type TextSegment } from './theme.js';
import { LoadingState, SPACER, clean, fitSegments, fixedFrame, footerLines, hintLine, rule, truncateEnd } from './view-stack.js';

export interface SelfHost { changed(): void; feedback(text: string): void; export(value: unknown): void }
export interface SelfOptions {
  samples?: ProcessMeasurements;
  dimensions?: () => { columns: number; rows: number };
  busy?: () => boolean;
  now?: () => Date;
  read?: typeof readSelfSnapshot;
  storage?: typeof selfStorage;
}
type Storage = Awaited<ReturnType<typeof selfStorage>>;
const unmeasured = ['产品内不测', ' · 见 A2 报告'] as const;
const ms = (value: number) => `${value.toFixed(1).replace(/\.0$/, '')} ms`;
const bytes = (value: number | null | undefined) => value === null || value === undefined ? '未记录' : formatBytes(value);
/** 主值与说明（含分隔符）。 */
const absent = (value: SelfValue<unknown>): [string, string] => value.reason ? ['未取得', ` · ${clean(value.reason).split(':')[0]}`] : ['未记录', ''];

/** 2c owns a read-only snapshot; b refreshes facts but never resets the process's in-memory input samples. */
export class SelfView {
  snapshot!: SelfSnapshot;
  storageResult?: Storage;
  ready: Promise<void>;
  private loading?: LoadingState;
  private cancelled = false;
  private offset = 0;
  private readonly samples: ProcessMeasurements;
  constructor(private readonly root: string, private readonly host: SelfHost, private readonly options: SelfOptions = {}) {
    this.samples = options.samples ?? processMeasurements;
    this.ready = this.refresh();
  }
  get inProgress() { return !!this.loading; }
  cancel() { this.cancelled = true; this.loading?.cancel(); this.loading = undefined; }
  private dimensions() { return this.options.dimensions?.() ?? { columns: process.stdout.columns ?? null, rows: process.stdout.rows ?? null }; }
  private async refresh() {
    const loading = this.loading = new LoadingState('统计', undefined, () => this.host.changed());
    this.snapshot = (this.options.read ?? readSelfSnapshot)(this.root, this.dimensions(), this.samples, this.options.busy?.() ?? false, this.options.now?.());
    this.storageResult = undefined;
    this.host.changed();
    try { const value = await loading.track((this.options.storage ?? selfStorage)(this.root, this.snapshot.facts)); if (value) this.storageResult = value; }
    catch (error) { this.storageResult = { value: null, source: 'records', samples: null, basis: '只读存储统计', reason: String(error) }; }
    finally { if (!this.cancelled && this.loading === loading) { this.loading = undefined; this.host.changed(); } }
  }
  handleInput(data: string): Promise<void> | undefined {
    if (data === 'b') {
      if (this.loading) this.host.feedback('统计进行中');
      else this.ready = this.refresh();
      return this.ready;
    }
    if (data === 'e') {
      if (this.loading) this.host.feedback('统计完成后再导出');
      else this.host.export(this.exportValue());
    } else if (matchesKey(data, 'up')) this.scroll(-1);
    else if (matchesKey(data, 'down')) this.scroll(1);
    else if (matchesKey(data, 'pageUp')) this.scroll(-5);
    else if (matchesKey(data, 'pageDown')) this.scroll(5);
  }
  exportValue() {
    const keys = this.samples.snapshot().keys;
    return { ...this.snapshot, environment: { ...this.snapshot.environment, ...this.dimensions() },
      keys: { ...this.snapshot.keys, value: keys, samples: keys.samples }, storage: this.storageResult,
      exportedAt: (this.options.now?.() ?? new Date()).toISOString(), exportQueue: { value: '无', source: 'process', samples: null, basis: '外部导出 无 · 观测仅本机' },
      limitation: '本机日常快照，只读；不能替代 A2 受控测量。时间仅覆盖进程内，不包含终端绘制或未观察到的网络/模型边界。' };
  }
  scroll(delta: number) { this.offset = Math.max(0, this.offset + delta); this.host.changed(); }

  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const snapshot = this.snapshot, env = snapshot.environment, wide = width >= 100;
    // 节标题保持粗体、颜色 fg.label（视觉修正 r1）。
    const line = (text: string, w = width, heading = false) => styledLine([{ text: clean(text), fg: heading ? 'fg.label' : 'fg.body', bold: heading }], w, undefined, tier);
    const tabs = styledLine([{ text: '指标', fg: 'fg.label' }, { text: ' · ', fg: 'fg.faint' }, { text: '本机实测', fg: 'fg.primary', bold: true }], width, undefined, tier);
    const facts = ` ${env.build?.slice(0, 7) ?? '未知'} · ${env.chip} · macOS ${env.system} · Node ${env.node} · ${env.terminal} · 本进程 ${Math.floor(env.uptimeMs / 60000)}m`;
    const note = '无预设硬阈值 · 只报告实测', brand: TextSegment[] = [{ text: '◆ ', fg: 'ac.model' }, { text: 'self', fg: 'fg.primary', bold: true }];
    const room = width - 6 - (wide ? visibleWidth(note) + 2 : 0), shown = truncateEnd(clean(facts), Math.max(0, room));
    const headerLine = styledLine([...brand, { text: shown, fg: 'fg.faint' }, ...wide ? [{ text: ' '.repeat(Math.max(2, room - visibleWidth(shown) + 2)) }, { text: note, fg: 'fg.faint' as const }] : []], width, undefined, tier);
    const section = (title: string, w: number) => [line(title, w, true)];
    // Labels keep 20 cells below 60 columns. Values wrap instead of losing their units or unknown qualifiers.
    // As in the design, labels are fg.body, the value fg.primary and its note (with separator) fg.faint.
    // `shown` is [value, note] or pre-styled segments; a value that wraps keeps each segment's color.
    const row = (label: string, shown: readonly [string, string] | TextSegment[], w: number, color: TextSegment['fg'] = 'fg.primary') => {
      const labelText = truncateEnd(clean(label), 20), prefix = `${labelText}${' '.repeat(Math.max(0, 20 - visibleWidth(labelText)))} `;
      const segments: TextSegment[] = typeof shown[0] === 'string' ? [{ text: clean(shown[0]), fg: color }, { text: clean(shown[1] as string), fg: 'fg.faint' }] : shown as TextSegment[];
      const available = Math.max(1, w - 21), chunks = wrapTextWithAnsi(segments.map(s => s.text).join(''), available);
      // 按词折行只会去掉断行处的空格，逐字对回原片段即可还原各段样式。
      const chars = segments.flatMap(s => Array.from(s.text, char => ({ char, s })));
      let at = 0;
      const wrapped = chunks.map(chunk => Array.from(chunk).reduce<TextSegment[]>((parts, char) => {
        while (chars[at].char !== char) at++;
        const { s } = chars[at++], last = parts.at(-1);
        if (last && last.fg === s.fg && last.bold === s.bold) last.text += char; else parts.push({ ...s, text: char });
        return parts;
      }, []));
      return (chunks.length > 1 ? wrapped : [segments]).map((parts, i) => styledLine([{ text: i ? ' '.repeat(21) : prefix, fg: 'fg.body' }, ...parts], w, undefined, tier));
    };
    const code = (w: number) => {
      const own = snapshot.code.product, body = section('自有维护代码', w), max = Math.max(1, ...(own.value?.groups.map(g => g.lines) ?? []));
      // 路径 ac.path；行数之后是 ac.brand 的实心条（设计稿为紫色 #bb9af7）。
      if (own.value) for (const group of own.value.groups) {
        const count = `${group.lines.toLocaleString('en-US')} 行`.padStart(9), cells = w >= 60 ? Math.min(16, w - 33) : 0, bar = cells >= 4 ? '█'.repeat(Math.max(1, Math.round(group.lines / max * cells))) : '';
        const path = truncateEnd(clean(group.directory), 20);
        body.push(styledLine(fitSegments([{ text: `${path}${' '.repeat(Math.max(0, 20 - visibleWidth(path)))} `, fg: 'ac.path' }, { text: count, fg: 'fg.body' }, { text: bar ? '  ' : '' }, { text: bar, fg: 'ac.brand' }], w), w, undefined, tier));
      } else body.push(...row('产品源码', absent(own), w));
      // 合计行上方一条 line.inner 分隔线；文件数与行数 fg.primary，行数粗体（设计稿 2c）。
      if (own.value) body.push(rule(w, 'line.inner', tier), ...row('产品源码合计', [{ text: `${own.value.files} 文件 · `, fg: 'fg.primary' }, { text: `${own.value.lines.toLocaleString('en-US')} 行`, fg: 'fg.primary', bold: true }], w));
      const deps = snapshot.code.dependencies.value;
      body.push(...row('直接依赖', deps ? [`${deps.count}`, ` · ${deps.exact ? '精确固定' : '非全部精确固定'}`] : ['未记录', ''], w));
      for (const [label, item] of [['随包脚本', snapshot.code.scripts], ['pi-tui 宽度补丁', snapshot.code.patch], ['测试（不随包）', snapshot.code.tests]] as const) body.push(...row(label, [item.value ? `${item.value.lines.toLocaleString('en-US')} 行` : '未记录', ''], w));
      return body;
    };
    const volume = (w: number) => [...section('体积', w), ...row('生产安装', snapshot.installation.value === null ? absent(snapshot.installation) : [bytes(snapshot.installation.value), ' · 含 provider SDK'] as const, w), ...row('分发', unmeasured, w)];
    const running = (w: number) => {
      const keys = this.samples.snapshot().keys, memory = snapshot.memory.value, peak = snapshot.peak.value;
      return [...section('运行开销', w),
        ...row('本次启动到首帧', snapshot.firstFrame.value === null ? ['尚未取得首帧', ''] as const : [ms(snapshot.firstFrame.value), ' · 1 样本'] as const, w),
        ...row('冷启动 p50/p95', unmeasured, w),
        ...row('当前 RSS', memory ? [bytes(memory.bytes), ` · ${memory.state}`] as const : absent(snapshot.memory), w),
        ...row('本进程峰值 RSS', peak ? [bytes(peak.bytes), ` · ${peak.tasks ?? '未记录'} 个任务 · ${bytes(peak.toolOutputBytes)} 工具输出`] as const : absent(snapshot.peak), w),
        ...row('受控空闲 / 长会话', unmeasured, w),
        ...row('按键到重绘', keys.samples ? [`p50 ${ms(keys.p50!)}`, `${keys.p95 === null ? '' : ` / p95 ${ms(keys.p95)}`} · ${keys.samples} 样本`] : ['尚无样本', ''], w),
        ...row('', [keys.samples < 20 && keys.samples > 0 ? '样本不足 20，不计 p95' : '进程内', ' · 不含终端绘制'], w),
      ];
    };
    const observation = (w: number) => {
      const storage = this.storageResult, value = storage?.value, query = snapshot.query.value;
      const summary: readonly [string, string] = this.loading ? ['', ''] : !storage || !value ? storage ? absent(storage) : ['未取得', ''] : value.tasks === 0 ? ['尚无任务', ` · 数据根总量 ${bytes(value.total)}`] : [`每任务均值 ${bytes(value.perTask)}`, ` · 数据根总量 ${bytes(value.total)}`];
      return [...section('观测开销', w), ...row('记录增长', summary, w), ...this.loading?.isShowing ? [this.loading.renderLine(w, tier)] : [],
        ...value && value.tasks !== 0 ? row('完整原文（现存）', [bytes(value.originals), ''], w) : [],
        ...row('查询摘要', query ? [ms(query.ms), ` · ${query.runs} run${query.more ? ' · 仅首 50 项' : ''}${query.coverage.missing ? ' · 来源有缺失' : ''}`] as const : absent(snapshot.query), w),
        ...(snapshot.facts.value?.gaps ?? []).flatMap(gap => row('统计范围', [gap, ''], w, 'ac.warn')),
        ...row('输出取得写入耗时', unmeasured, w), ...row('导出队列', ['外部导出 无', ' · 观测仅本机'], w),
      ];
    };
    let body: string[];
    const leftWidth = Math.floor((width - 3) / 2), rightWidth = width - leftWidth - 3;
    if (wide) {
      const left = [...code(leftWidth), '', ...volume(leftWidth)], right = [...running(rightWidth), '', ...observation(rightWidth)];
      body = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `${left[i] || line('', leftWidth)}${line('', 3)}${right[i] || line('', rightWidth)}`);
    } else body = [...code(width), '', ...volume(width), '', ...running(width), '', ...observation(width)];
    body.push('', ...section('模型成本 · 近 7 天整日 · 全部项目 · 日常 · 估算非账单', width));
    if (snapshot.cost.value) {
      const { scope, spend } = snapshot.cost.value;
      body.push(line(`[${statsDate(scope.from)}, ${statsDate(scope.to)}) · 按请求发生时间去重`));
      // 金额 fg.primary，没有已知金额时的 unknown 为 ac.warn；其余段保留自带颜色（unknown / partial 为 ac.warn），无色的补 fg.faint。
      const values = spendRows({ spend }).map(value => ({ label: value.label, text: value.text.map((s, i): TextSegment => ({ ...s, text: clean(s.text), fg: i ? s.fg ?? 'fg.faint' : s.text === 'unknown' ? 'ac.warn' : 'fg.primary' })) }));
      if (wide) {
        // 第二列与上方右栏对齐。
        const w = leftWidth + 3;
        for (let i = 0; i < values.length; i += 2) {
          const a = row(values[i].label, values[i].text, w), b = values[i + 1] ? row(values[i + 1].label, values[i + 1].text, width - w) : [];
          for (let j = 0; j < Math.max(a.length, b.length); j++) body.push(`${a[j] ?? line('', w)}${b[j] ?? line('', width - w)}`);
        }
      } else for (const value of values) body.push(...row(value.label, value.text, width));
    } else body.push(...row('期间开销', absent(snapshot.cost), width));
    // 头部下方与底栏上方各一条分隔线、头部后空一行（U10）；放不下时先收它们，再收底栏说明。
    const hints = ['b 重新测量', 'e 导出', 'Tab 页签', '↑↓ 滚动'], esc = 'Esc 返回会话';
    const footer = footerLines([{ text: '本地时间与网络/模型时间分开 · 磁盘增长不等于上下文变短', fg: 'fg.label' }], hints, width, { esc, tier });
    const airy = 2 + 2 + body.length + 1 + footer.length <= height;
    const frame = airy ? fixedFrame([tabs, headerLine, rule(width, 'line.subtle', tier), SPACER], body, [rule(width, 'line.subtle', tier), ...footer], height, this.offset)
      : fixedFrame([tabs, headerLine], body, body.length + 2 + footer.length <= height ? footer : [hintLine(hints, width, { esc, tier })], height, this.offset);
    this.offset = frame.offset;
    return frame.lines;
  }
}
