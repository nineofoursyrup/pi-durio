import { matchesKey, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { readSelfSnapshot, selfStorage, processMeasurements, type ProcessMeasurements, type SelfSnapshot, type SelfValue } from '../self-measurement.js';
import { spendRows } from './stats.js';
import { statsDate } from './stats-filter.js';
import { formatBytes } from './storage.js';
import { COLOR_TIER, styledLine, type ColorTier, type TextSegment } from './theme.js';
import { LoadingState, clean, fixedFrame, hintLine, truncateEnd } from './view-stack.js';

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
const unmeasured = '产品内不测 · 见 A2 报告';
const ms = (value: number) => `${value.toFixed(1).replace(/\.0$/, '')} ms`;
const bytes = (value: number | null | undefined) => value === null || value === undefined ? '未记录' : formatBytes(value);
const absent = (value: SelfValue<unknown>) => value.reason ? `未取得 · ${clean(value.reason).split(':')[0]}` : '未记录';

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
  private dimensions() { return this.options.dimensions?.() ?? { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }; }
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
    const line = (text: string, w = width, heading = false) => styledLine([{ text: clean(text), fg: heading ? 'fg.primary' : 'fg.body', bold: heading }], w, undefined, tier);
    const tabs = styledLine([{ text: ' 指标', fg: 'fg.label' }, { text: ' · ', fg: 'fg.faint' }, { text: '本机实测', fg: 'fg.primary', bold: true }], width, undefined, tier);
    const header = `◆ self ${env.build?.slice(0, 7) ?? '未知'} · ${env.chip} · macOS ${env.system} · Node ${env.node} · ${env.terminal} · 本进程 ${Math.floor(env.uptimeMs / 60000)}m`;
    const note = '无预设硬阈值 · 只报告实测';
    const headerLine = wide ? `${truncateEnd(clean(header), width - visibleWidth(note) - 3)}${' '.repeat(Math.max(1, width - visibleWidth(truncateEnd(clean(header), width - visibleWidth(note) - 3)) - visibleWidth(note)))}${note}` : truncateEnd(clean(header), width);
    const section = (title: string, w: number) => [line(` ${title}`, w, true)];
    // Labels keep 20 cells below 60 columns. Values wrap instead of losing their units or unknown qualifiers.
    const row = (label: string, value: string, w: number, color: TextSegment['fg'] = 'fg.body') => {
      const labelText = truncateEnd(clean(label), 20), prefix = ` ${labelText}${' '.repeat(Math.max(0, 20 - visibleWidth(labelText)))} `;
      const available = Math.max(1, w - 22), chunks = wrapTextWithAnsi(clean(value), available);
      return (chunks.length ? chunks : ['']).map((chunk, i) => styledLine([{ text: i ? ' '.repeat(22) : prefix, fg: 'fg.label' }, { text: chunk, fg: color }], w, undefined, tier));
    };
    const code = (w: number) => {
      const own = snapshot.code.product, body = section('自有维护代码', w), max = Math.max(1, ...(own.value?.groups.map(g => g.lines) ?? []));
      if (own.value) for (const group of own.value.groups) {
        const count = `${group.lines.toLocaleString('en-US')} 行`, bar = w >= 60 ? `${'━'.repeat(Math.max(1, Math.round(group.lines / max * 10)))} ` : '';
        body.push(...row(group.directory, `${bar}${count}`, w, 'ac.info'));
      } else body.push(...row('产品源码', absent(own), w));
      if (own.value) body.push(...row('产品源码合计', `${own.value.files} 文件 · ${own.value.lines.toLocaleString('en-US')} 行`, w));
      const deps = snapshot.code.dependencies.value;
      body.push(...row('直接依赖', deps ? `${deps.count} · ${deps.exact ? '精确固定' : '非全部精确固定'}` : '未记录', w));
      for (const [label, item] of [['随包脚本', snapshot.code.scripts], ['pi-tui 宽度补丁', snapshot.code.patch], ['测试（不随包）', snapshot.code.tests]] as const) body.push(...row(label, item.value ? `${item.value.lines.toLocaleString('en-US')} 行` : '未记录', w));
      return body;
    };
    const volume = (w: number) => [...section('体积', w), ...row('生产安装', snapshot.installation.value === null ? absent(snapshot.installation) : `${bytes(snapshot.installation.value)} · 含 provider SDK`, w), ...row('分发', unmeasured, w)];
    const running = (w: number) => {
      const keys = this.samples.snapshot().keys, memory = snapshot.memory.value, peak = snapshot.peak.value;
      return [...section('运行开销', w),
        ...row('本次启动到首帧', snapshot.firstFrame.value === null ? '尚未取得首帧' : `${ms(snapshot.firstFrame.value)} · 1 样本`, w),
        ...row('冷启动 p50/p95', unmeasured, w),
        ...row('当前 RSS', memory ? `${bytes(memory.bytes)} · ${memory.state}` : absent(snapshot.memory), w),
        ...row('本进程峰值 RSS', peak ? `${bytes(peak.bytes)} · ${peak.tasks ?? '未记录'} 个任务 · ${bytes(peak.toolOutputBytes)} 工具输出` : absent(snapshot.peak), w),
        ...row('受控空闲 / 长会话', unmeasured, w),
        ...row('按键到重绘', keys.samples ? `p50 ${ms(keys.p50!)}${keys.p95 === null ? '' : ` / p95 ${ms(keys.p95)}`} · ${keys.samples} 样本` : '尚无样本', w, 'ac.info'),
        ...row('', keys.samples < 20 && keys.samples > 0 ? '样本不足 20，不计 p95 · 不含终端绘制' : '进程内 · 不含终端绘制', w),
      ];
    };
    const observation = (w: number) => {
      const storage = this.storageResult, value = storage?.value, query = snapshot.query.value;
      const summary = this.loading ? this.loading.isShowing ? '⠋ 统计中' : '' : !storage || !value ? storage ? absent(storage) : '未取得' : value.tasks === 0 ? `尚无任务 · 数据根总量 ${bytes(value.total)}` : `每任务均值 ${bytes(value.perTask)} · 数据根总量 ${bytes(value.total)}`;
      return [...section('观测开销', w), ...row('记录增长', summary, w),
        ...value && value.tasks !== 0 ? row('完整原文（现存）', bytes(value.originals), w) : [],
        ...row('查询摘要', query ? `${ms(query.ms)} · ${query.runs} run${query.more ? ' · 仅首 50 项' : ''}${query.coverage.missing ? ' · 来源有缺失' : ''}` : absent(snapshot.query), w),
        ...row('输出取得写入耗时', unmeasured, w), ...row('导出队列', '外部导出 无 · 观测仅本机', w),
      ];
    };
    let body: string[];
    if (wide) {
      const leftWidth = Math.floor((width - 3) / 2), rightWidth = width - leftWidth - 3;
      const left = [...code(leftWidth), '', ...volume(leftWidth)], right = [...running(rightWidth), '', ...observation(rightWidth)];
      body = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `${left[i] || line('', leftWidth)}${line(' │ ', 3)}${right[i] || line('', rightWidth)}`);
    } else body = [...code(width), '', ...volume(width), '', ...running(width), '', ...observation(width)];
    body.push('', ...section('模型成本 · 近 7 天整日 · 全部项目 · 日常 · 估算非账单', width));
    if (snapshot.cost.value) {
      const { scope, spend } = snapshot.cost.value;
      body.push(line(` [${statsDate(scope.from)}, ${statsDate(scope.to)}) · 按请求发生时间去重`));
      const values = spendRows({ spend });
      if (wide) {
        const w = Math.floor(width / 2);
        for (let i = 0; i < values.length; i += 2) {
          const a = row(values[i].label, values[i].text.map(s => s.text).join(''), w), b = values[i + 1] ? row(values[i + 1].label, values[i + 1].text.map(s => s.text).join(''), width - w) : [];
          for (let j = 0; j < Math.max(a.length, b.length); j++) body.push(`${a[j] ?? line('', w)}${b[j] ?? line('', width - w)}`);
        }
      } else for (const value of values) body.push(...row(value.label, value.text.map(s => s.text).join(''), width));
    } else body.push(...row('期间开销', absent(snapshot.cost), width));
    const footer = [hintLine(['b 重新测量', 'e 导出', 'Tab 页签', '↑↓ 滚动'], width, { esc: 'Esc 返回会话', tier })];
    if (body.length + 4 <= height) footer.unshift(line(' 本地时间与网络/模型时间分开 · 磁盘增长不等于上下文变短'));
    const frame = fixedFrame([tabs, line(headerLine)], body, footer, height, this.offset); this.offset = frame.offset;
    return frame.lines;
  }
}
