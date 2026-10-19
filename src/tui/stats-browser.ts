/** 1e navigation: the table and every child retain their own position. Only leaf routes enter the app stack. */
import { matchesKey, stripTerminalSequences, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { StatsView, readStats, statsCommand, metricRows, type StatsRequest, type StatsSnapshot, type StatsTab } from './stats.js';
import { StatsFilter, StatsChoicesLimitError, statsChoices, statsDate, type StatsChoices } from './stats-filter.js';
import { statsRows, statsMembers, statsExport, type StatsRow, type StatsTarget, type StatsTaskTarget, type StatsMember, type StatsEvidence } from './stats-drilldown.js';
import { ExportDialog } from './export-dialog.js';
import { SelfView, type SelfOptions } from './self.js';
import { EvidenceRawView } from './evidence-raw.js';
import { COLOR_TIER, styledLine, type ColorTier } from './theme.js';
import { clean, fixedFrame, hintLine } from './view-stack.js';

export interface StatsHost {
  open(target: Extract<StatsTarget, { kind: 'run' | 'plan' }>): void;
  copy(text: string): Promise<boolean | string>;
  feedback(text: string): void;
  changed(): void;
  /** #86 supplies the write capability and its guards; call saved only after an appended revision. */
  annotate?(task: StatsTaskTarget, saved: () => void): void;
}
type Level =
  | { kind: 'members'; row: StatsRow; selected: number; offset: number }
  | { kind: 'evidence'; row: StatsRow; memberKey: string; selected: number; offset: number }
  | { kind: 'raw'; view: EvidenceRawView }
  | { kind: 'filter'; view: StatsFilter; offset: number; notice?: string }
  | { kind: 'export'; view: ExportDialog };
const PAGE = 20;

export class StatsBrowser {
  private table!: StatsView;
  private value?: StatsSnapshot;
  private levels: Level[] = [];
  private memberCache = new Map<StatsRow, StatsMember[]>();
  private evidenceCache = new Map<string, StatsEvidence[]>();
  private revisions: number[] = [];
  private revision = 0;
  private readonly read: typeof readStats;
  private readonly choices: () => StatsChoices;
  private activeTab: StatsTab = 'metrics';
  private selfView?: SelfView;
  private readonly initialRequest: StatsRequest;
  private readonly selfOptions: SelfOptions;
  private tableError?: string;

  constructor(readonly root: string, readonly workspace: string, request: StatsRequest, private readonly host: StatsHost, options: { tab?: StatsTab; read?: typeof readStats; choices?: () => StatsChoices; self?: SelfOptions } = {}) {
    this.read = options.read ?? readStats;
    this.choices = options.choices ?? (() => statsChoices(root, workspace));
    this.initialRequest = request; this.selfOptions = options.self ?? {};
    if (options.tab !== 'self') this.load(request, true);
    this.tab = options.tab ?? 'metrics';
  }
  get request() { return this.table?.request ?? this.initialRequest; }
  get stats() { return this.value; }
  get limit() { return this.table?.limit; }
  get exportable() { return this.tab === 'self' ? !!this.selfView && !this.selfView.inProgress : this.table?.exportable && !!this.value; }
  get tab() { return this.activeTab; }
  set tab(value: StatsTab) {
    if (value === 'metrics' && !this.table) {
      try { this.load(this.initialRequest, true); }
      catch (error) { this.tableError = clean(String(error)).split(':')[0]; }
    }
    this.activeTab = value;
    if (value === 'self') this.selfView ??= new SelfView(this.root, { ...this.host, export: value => this.openExport(value) }, this.selfOptions);
    else { this.selfView?.cancel(); this.selfView = undefined; }
  }
  get self() { return this.selfView; }
  cancel() { this.selfView?.cancel(); for (const level of this.levels) if (level.kind === 'export') level.view.cancel(); }
  get depth() { return 1 + this.levels.length; }
  get layer() { return this.levels.at(-1)?.kind ?? 'table'; }
  /** Only text entry bypasses global view keys; Escape in a filter editor cancels that editor first. */
  get acceptsInput() {
    const level = this.levels.at(-1);
    return level?.kind === 'filter' && level.view.preset.isEditing || level?.kind === 'export' && level.view.isEditing;
  }
  private members(row: StatsRow) {
    if (!this.memberCache.has(row)) this.memberCache.set(row, this.value ? statsMembers(this.value, row) : []);
    return this.memberCache.get(row)!;
  }
  private evidence(row: StatsRow, key: string) {
    const cacheKey = `${row}:${key}`;
    if (!this.evidenceCache.has(cacheKey)) this.evidenceCache.set(cacheKey, this.members(row).find(m => m.key === key)?.evidence() ?? []);
    return this.evidenceCache.get(cacheKey)!;
  }
  get selectedTask(): StatsTaskTarget | undefined {
    const level = this.levels.at(-1);
    return level?.kind === 'members' ? this.members(level.row)[level.selected]?.task : undefined;
  }
  private load(input: StatsRequest, resetRevisions: boolean) {
    const selected = this.table?.selectedRow ?? 0;
    const request = { scope: { ...input.scope }, command: input.command };
    let value: StatsSnapshot | undefined;
    const table = new StatsView(request, scope => {
      value = this.read(this.root, scope);
      request.scope = value.scope; request.command = statsCommand(value.scope);
      return value;
    });
    this.table = table; this.value = value; this.tableError = undefined;
    this.memberCache.clear(); this.evidenceCache.clear();
    if (resetRevisions) { this.revisions = value?.revisions ?? []; this.revision = 0; }
    this.table.selectedRow = Math.min(selected, Math.max(0, value ? statsRows(value).length - 1 : 0));
    this.table.hints = this.table.limit ? ['/ 筛选', 'Tab 页签'] : ['↑↓ 选行', 'Enter 成员', '/ 筛选', 'e 导出', ...this.revisions.length > 1 ? ['v 旧修订'] : [], 'Tab 页签'];
    this.table.revisionLabel = this.revision ? `旧修订 #${value?.scope.through}` : undefined;
  }
  /** #86: requery after a successful append, advance as_of, discard the old sequence, preserve task/row selection. */
  refresh(now = new Date()) {
    const selections = this.levels.map(level => level.kind === 'members' ? this.members(level.row)[level.selected]?.key : undefined);
    const scope = { ...this.request.scope, asOf: now.toISOString() }; delete scope.through; delete scope.revisionOf;
    this.load({ scope, command: statsCommand(scope) }, true);
    this.levels.forEach((level, i) => {
      if (level.kind !== 'members') return;
      const members = this.members(level.row), same = members.findIndex(m => m.key === selections[i]);
      level.selected = same >= 0 ? same : Math.min(level.selected, Math.max(0, members.length - 1));
    });
    this.host.changed();
  }
  back(): boolean {
    if (!this.levels.length) { this.cancel(); return false; }
    const level = this.levels.pop(); if (level?.kind === 'export') level.view.cancel(); this.host.changed(); return true;
  }
  handleInput(data: string): boolean {
    const level = this.levels.at(-1);
    try {
      if (level?.kind === 'filter') {
        const result = level.view.preset.handleInput(data);
        if (result === 'cancel') this.back();
        if (result === 'apply') {
          const request = level.view.request;
          if (request) { this.load(request, true); this.levels.pop(); }
        }
        this.host.changed(); return true;
      }
      if (matchesKey(data, 'escape')) return this.back();
      if (level?.kind === 'export') { void level.view.handleInput(data); return true; }
      if (level?.kind === 'raw') { level.view.handleInput(data); this.host.changed(); return true; }
      if (level) {
        const items = level.kind === 'members' ? this.members(level.row) : this.evidence(level.row, level.memberKey);
        const delta = matchesKey(data, 'up') || matchesKey(data, 'shift+tab') ? -1 : matchesKey(data, 'down') || matchesKey(data, 'tab') ? 1 : data === 'n' || matchesKey(data, 'pageDown') ? PAGE : data === 'p' || matchesKey(data, 'pageUp') ? -PAGE : 0;
        if (delta) { level.selected = Math.max(0, Math.min(items.length - 1, level.selected + delta)); level.offset = 0; }
        else if (matchesKey(data, 'enter') && items[level.selected]) {
          if (level.kind === 'members') this.levels.push({ kind: 'evidence', row: level.row, memberKey: (items[level.selected] as StatsMember).key, selected: 0, offset: 0 });
          else this.open((items[level.selected] as StatsEvidence).target);
        } else if (data === 'a' && this.selectedTask && this.host.annotate) this.host.annotate(this.selectedTask, () => this.refresh());
        this.host.changed(); return true;
      }
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) { this.tab = this.tab === 'metrics' ? 'self' : 'metrics'; this.host.changed(); return true; }
      if (this.tab === 'self') { void this.selfView?.handleInput(data); this.host.changed(); return true; }
      if (data === '/') {
        let choices: StatsChoices, notice: string | undefined;
        try { choices = this.choices(); }
        catch (error) {
          if (!(error instanceof StatsChoicesLimitError)) throw error;
          choices = { projects: [this.workspace], types: [], versions: [] };
          notice = '选项列表超出上限 · 仅保留当前项目与已选条件；较小的数据根可读取完整列表';
        }
        this.levels.push({ kind: 'filter', view: new StatsFilter(this.request, this.workspace, choices), offset: 0, notice });
      }
      else if (data === 'e') {
        if (!this.exportable) this.host.feedback('范围过大 · 缩小范围后再导出');
        else this.openExport();
      } else if (data === 'v' && this.revisions.length > 1) {
        this.revision = (this.revision + 1) % this.revisions.length;
        const scope = { ...this.request.scope, through: this.revisions[this.revision] };
        this.load({ scope, command: statsCommand(scope) }, false);
      } else if (matchesKey(data, 'enter') && this.value) {
        const row = statsRows(this.value)[this.table.selectedRow ?? 0];
        if (row) this.levels.push({ kind: 'members', row: row.key, selected: 0, offset: 0 });
      } else if (matchesKey(data, 'up')) this.scroll(-1);
      else if (matchesKey(data, 'down')) this.scroll(1);
      else if (matchesKey(data, 'pageUp')) this.scroll(-5);
      else if (matchesKey(data, 'pageDown')) this.scroll(5);
      else { const handled = this.table?.handleInput(data) ?? false; this.host.changed(); return handled; }
      this.host.changed(); return true;
    } catch (error) { this.host.feedback(`统计视图不可读取 · ${clean(String(error))}`); this.host.changed(); return true; }
  }
  private open(target: StatsTarget) {
    if (target.kind === 'run' || target.kind === 'plan') this.host.open(target);
    else this.levels.push({ kind: 'raw', view: new EvidenceRawView(target, this.host) });
  }
  private openExport(self?: unknown) {
    const name = self ? 'stats-self' : 'stats', date = self ? statsDate(this.selfView!.snapshot.at) : statsDate(this.request.scope.asOf);
    const level: Extract<Level, { kind: 'export' }> = { kind: 'export', view: new ExportDialog({ title: name, value: self ?? statsExport(this.value!), suggestedPath: `./${name}-${date}.json`, cwd: this.workspace }, {
      ...this.host, done: () => { if (this.levels.at(-1) === level) this.back(); },
    }) };
    this.levels.push(level);
  }
  scroll(delta: number) {
    const level = this.levels.at(-1);
    if (level?.kind === 'raw') level.view.scroll(delta);
    else if (level?.kind === 'members' || level?.kind === 'evidence') {
      const items = level.kind === 'members' ? this.members(level.row) : this.evidence(level.row, level.memberKey);
      level.selected = Math.max(0, Math.min(items.length - 1, level.selected + delta)); level.offset = 0;
    } else if (level?.kind === 'filter') level.offset = Math.max(0, level.offset + delta);
    else if (!level && this.tab === 'self') this.selfView?.scroll(delta);
    else if (!level && this.value) this.table.selectedRow = Math.max(0, Math.min(statsRows(this.value).length - 1, (this.table.selectedRow ?? 0) + delta));
    this.host.changed();
  }
  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const level = this.levels.at(-1);
    if (!level && this.tab === 'metrics' && !this.table) return fixedFrame(
      [styledLine([{ text: ' 指标 · 本机实测', fg: 'fg.primary' }], width, undefined, tier)],
      [styledLine([{ text: `✗ 统计不可读取 · ${this.tableError ?? '未取得记录'}`, fg: 'ac.warn' }], width, undefined, tier)],
      [hintLine(['Tab 本机实测'], width, { esc: 'Esc 返回会话', tier })], height, 0).lines;
    if (!level) return this.tab === 'self' ? this.selfView!.render(width, height, tier) : this.table.render(width, height, tier);
    const tabs = styledLine([{ text: ' 指标', fg: this.tab === 'metrics' ? 'fg.primary' : 'fg.label', bold: this.tab === 'metrics' }, { text: ' · 本机实测', fg: this.tab === 'self' ? 'fg.primary' : 'fg.label', bold: this.tab === 'self' }], width, undefined, tier);
    if (level.kind === 'raw' || level.kind === 'export') return [tabs, ...level.view.render(width, height - 1, tier)];
    const line = (text: string, selected = false) => styledLine([{ text: clean(text), fg: selected ? 'fg.primary' : 'fg.body' }], width, selected ? 'bg.selected' : undefined, tier);
    if (level.kind === 'filter') {
      const body = level.view.preset.render(width, tier), command = level.view.request?.command;
      const focus = body.findLastIndex(l => /^\s*›/.test(stripTerminalSequences(l)));
      const head = [tabs, line('◆ stats · 筛选'), ...level.notice ? [line(level.notice)] : []], foot = [...command ? [line(command)] : [], hintLine(level.view.preset.hints(), width, { esc: 'Esc 返回上层', tier })];
      const available = Math.max(1, height - head.length - foot.length);
      if (focus < level.offset) level.offset = Math.max(0, focus);
      if (focus >= level.offset + available) level.offset = focus - available + 1;
      const frame = fixedFrame(head, body, foot, height, level.offset); level.offset = frame.offset; return frame.lines;
    }
    const row = this.value && statsRows(this.value).find(row => row.key === level.row);
    const items = level.kind === 'members' ? this.members(level.row) : this.evidence(level.row, level.memberKey);
    const start = Math.floor(level.selected / PAGE) * PAGE;
    const body: string[] = [], starts: number[] = [];
    for (const [i, item] of items.slice(start, start + PAGE).entries()) {
      const selected = start + i === level.selected; starts.push(body.length);
      const heading = 'classification' in item ? `${item.label} · ${item.classification}` : item.label;
      const detail = 'classification' in item ? item.reasons.join(' · ') : item.detail;
      body.push(...wrapTextWithAnsi(clean(heading), Math.max(1, width - 2)).map((s, n) => line(`${selected && n === 0 ? '› ' : '  '}${s}`, selected)));
      if (detail) body.push(...wrapTextWithAnsi(clean(detail), Math.max(1, width - 4)).map(s => line(`    ${s}`, selected)));
    }
    if (!items.length) body.push(line('没有可下钻的成员 · 缺失不表示没有发生'));
    const reports = this.value!.reports;
    const rule = level.row === 'regression'
      ? `计划内 grader ${[...new Set(this.value!.plans.flatMap(p => p.report.plan.cases.map(c => c.grader.version)))].join(', ') || '未取得'}`
      : ['intervention', 'rework'].includes(level.row) ? reports.feedback.ruleVersion : ['acceptance', 'clocks'].includes(level.row) ? reports.task.ruleVersion : reports.operations.ruleVersion;
    const unknown = reports.task.unknown;
    const head = [tabs, line(`◆ stats · ${row?.label ?? ''} · ${level.kind === 'members' ? '成员' : '证据'} ${items.length ? level.selected + 1 : 0}/${items.length}`), line(`规则 ${rule} · 截止 #${this.value!.scope.through}`)];
    if (level.kind === 'members') {
      const metric = statsRows(this.value!).findIndex(r => r.key === level.row), coverage = metricRows(this.value!.figures)[metric]?.coverage.map(s => s.text).join('');
      head.push(line(`未知身份：类型 ${unknown.taskTypes} · 执行版本 ${unknown.executionVersions}${coverage ? ` · 覆盖 ${coverage.trim()}` : ''}`));
    }
    const hints = ['↑↓ 选择', level.kind === 'members' ? 'Enter 证据' : 'Enter 打开', 'n/p 翻页', ...this.selectedTask && this.host.annotate ? ['a 补记'] : []];
    const foot = [hintLine(hints, width, { esc: 'Esc 返回上层', tier })], available = Math.max(1, height - head.length - foot.length), selected = starts[level.selected - start] ?? 0;
    if (selected < level.offset) level.offset = selected;
    if (selected >= level.offset + available) level.offset = selected - available + 1;
    const frame = fixedFrame(head, body, foot, height, level.offset); level.offset = frame.offset; return frame.lines;
  }
}
