/**
 * improve 启动框（I1、U4、U12；#89）：U12 确认框版式，四行为取证范围、预算上限、附加来源、分析重点。
 * 顶部写“分析不执行任何候选 · 可看文件 N（省略 M）”，固定行写按最坏情况预留的人民币上限。
 * `/improve new …` 的参数只预填，仍须在框内按 Enter。
 */
import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { GLYPHS, COLOR_TIER, type ColorTier, type TextSegment, type TokenName } from './theme.js';
import { ConfirmDialog, SingleLineInput, TOO_SMALL_TO_CONFIRM, clean, hintSegments, truncateEnd, truncateMiddle, wrapAuthorized, type ConfirmResult } from './view-stack.js';
import { DEFAULT_FOCUS, REGISTER_HINT, improveBudgetAmount, improveLimits, sourceLabel, type ImproveBudget, type ImproveScope, type LaunchChoice, type VisibleFiles } from '../improve-entry.js';
import type { SourceRegistration } from '../improve-source.js';

export interface LaunchPrefill { scope?: ImproveScope; budget?: ImproveBudget; sources?: ('self' | 'eval')[]; focus?: string }
export interface LaunchHost {
  visible: VisibleFiles;
  registrations: SourceRegistration[];
  /** 本进程有任务在运行：确认后独立排队，任务结束后开始。 */
  queued: boolean;
  /** A replacement analysis keeps the withdrawn request's original session/workspace. */
  binding?: string[];
  register(input: string): SourceRegistration;
  remove(id:string):void;
  complete(input: string): { text: string; matches: number };
}
type Row = { kind: 'scope' } | { kind: 'budget' } | { kind: 'source'; registration: SourceRegistration } | { kind: 'register' } | { kind: 'focus' };
const SCOPES: [ImproveScope, string][] = [['session', '仅本会话'], ['7d', '本会话 + 近 7 天同类'], ['30d', '本会话 + 近 30 天同类']];
const BUDGETS: [ImproveBudget, string][] = [['standard', '标准'], ['large', '加大']];
const LABEL = 12;

export class ImproveLaunchDialog {
  scope: ImproveScope;
  budget: ImproveBudget;
  private focusInput:SingleLineInput;
  get focus(){return this.focusInput.getValue();}
  private readonly chosen = new Set<string>();
  private registrations: SourceRegistration[];
  private cursor = 0;
  private dialog:ConfirmDialog;
  private pathInput=new SingleLineInput();
  private notice?:string;
  private removal?:{registration:SourceRegistration;dialog:ConfirmDialog};
  private tooSmall = false;
  /** “登记新路径”展开的一行输入。 */
  private input?: { text: string; error?: string; note?: string };

  constructor(private readonly host: LaunchHost, prefill: LaunchPrefill = {}) {
    this.scope = prefill.scope ?? '7d'; this.budget = prefill.budget ?? 'standard'; this.focusInput = new SingleLineInput(prefill.focus??'',1000);
    this.registrations = [...host.registrations];
    this.dialog=new ConfirmDialog({title:'新建 improve 分析',action:host.queued?'排队分析':'开始分析',bodyRows:inner=>this.body(inner),footer:reason=>this.input?hintSegments('Enter 登记 · Tab 补全 · Esc 收起'):reason?[{text:'Enter ',fg:'fg.faint'},{text:reason,fg:'fg.muted'},{text:' · ',fg:'fg.label'},...hintSegments('Esc 取消')]:hintSegments(`Enter ${host.queued?'排队分析':'开始分析'} · Esc 取消`)});
    for (const r of this.registrations) if (prefill.sources?.includes(r.kind === 'self-source' ? 'self' : 'eval')) this.chosen.add(r.id);
  }
  get choice(): LaunchChoice {
    return { scope: this.scope, budget: this.budget, sources: this.registrations.filter(r => this.chosen.has(r.id)), focus: this.focus };
  }
  get editing() { return !!this.input; }
  private get rows(): Row[] {
    return [{ kind: 'scope' }, { kind: 'budget' }, ...this.registrations.map(registration => ({ kind: 'source' as const, registration })), { kind: 'register' }, { kind: 'focus' }];
  }
  /** 可看文件数：默认可看的文件加上勾选来源的文件。 */
  get files() { return this.host.visible.files + this.choice.sources.reduce((n, r) => n + r.paths.length, 0); }
  get disabledReason() { return this.tooSmall ? TOO_SMALL_TO_CONFIRM : undefined; }

  handleInput(data: string): ConfirmResult {
    if(this.removal){
      const removal=this.removal,result=removal.dialog.handleInput(data);
      if(result.type==='confirm'){
        try{this.host.remove(removal.registration.id);this.chosen.delete(removal.registration.id);this.registrations=this.registrations.filter(registration=>registration.id!==removal.registration.id);this.notice=undefined;}catch(error){this.notice=clean(String(error));}
        this.removal=undefined;
      }else if(result.type==='cancel')this.removal=undefined;
      return {type:'handled'};
    }
    if (this.input) return this.inputKey(data);
    const row = this.rows[this.cursor];
    if (matchesKey(data, 'escape')) return { type: 'cancel' };
    if (matchesKey(data, 'enter')) {
      if (row.kind === 'register') { this.pathInput.setValue('');this.input = { text: '' }; return { type: 'handled' }; }
      return this.disabledReason ? { type: 'noop' } : { type: 'confirm', selected: [] };
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'shift+tab')) { this.cursor = Math.max(0, this.cursor - 1); return { type: 'handled' }; }
    if (matchesKey(data, 'down') || matchesKey(data, 'tab')) { this.cursor = Math.min(this.rows.length - 1, this.cursor + 1); return { type: 'handled' }; }
    if (row.kind === 'scope' || row.kind === 'budget') {
      const options: string[] = (row.kind === 'scope' ? SCOPES : BUDGETS).map(([key]) => key), at = options.indexOf(row.kind === 'scope' ? this.scope : this.budget);
      const next = /^[1-9]$/.test(data) ? Number(data) - 1 : matchesKey(data, 'left') ? at - 1 : matchesKey(data, 'right') ? at + 1 : -1;
      if (next < 0 || next >= options.length) return { type: 'noop' };
      if (row.kind === 'scope') this.scope = options[next] as ImproveScope; else this.budget = options[next] as ImproveBudget;
      return { type: 'handled' };
    }
    if (row.kind === 'source' && data === ' ') {
      if (!this.chosen.delete(row.registration.id)) this.chosen.add(row.registration.id);
      return { type: 'handled' };
    }
    if(row.kind==='source'&&matchesKey(data,'delete')){
      const registration=row.registration;
      this.removal={registration,dialog:new ConfirmDialog({title:'移除来源登记',action:'移除',wrapBody:true,body:[`来源 ${sourceLabel(registration)}`,`目录 ${registration.root}`,...registration.paths.map(path=>`文件 ${path}`)],fixed:['仅移除来源登记，不删除目录或文件；已有分析报告保留。','不调用模型 · 费用 ¥0.00']})};
      return {type:'handled'};
    }
    if(row.kind==='focus'){this.focusInput.handleInput(data);return {type:'handled'};}
    return { type: 'noop' };
  }
  private inputKey(data: string): ConfirmResult {
    const input = this.input!;
    if (matchesKey(data, 'escape')) { this.input = undefined; return { type: 'handled' }; }
    if (matchesKey(data, 'tab')) {
      const done = this.host.complete(input.text);
      this.pathInput.setValue(done.text);this.pathInput.handleInput('\x1b[F');this.input = { text: done.text, note: done.matches > 1 ? `${done.matches} 个匹配` : done.matches ? undefined : '没有匹配' };
      return { type: 'handled' };
    }
    if (matchesKey(data, 'enter')) {
      try {
        const registration = this.host.register(input.text);
        if (!this.registrations.some(r => r.id === registration.id)) this.registrations.push(registration);
        this.chosen.add(registration.id); this.input = undefined;
        this.cursor = this.rows.findIndex(r => r.kind === 'source' && r.registration.id === registration.id);
      } catch (error) { this.input = { text: input.text, error: clean(String(error instanceof Error ? error.message : error)) }; }
      return { type: 'handled' };
    }
    this.pathInput.handleInput(data);this.input={text:this.pathInput.getValue()};return {type:'handled'};
  }

  /** 固定行：上限金额、请求数与时限（只换行、不截断）。 */
  fixedLines() {
    const limits = improveLimits(this.budget), amount = improveBudgetAmount(this.budget);
    return [`${amount ? `上限约 ¥${amount.amount.toFixed(2)}（按最坏情况预留）` : '上限金额未知 · 价目未覆盖'} · ≤${limits.maxRequests} 请求 · ≤${limits.maxDurationMs / 60000} 分钟`];
  }

  render(columns: number, rows: number, tier: ColorTier = COLOR_TIER): string[] {
    if(this.removal)return this.removal.dialog.render(columns,rows,tier);
    this.dialog.update({fixed:this.fixedLines()});this.dialog.revealCursor();
    const lines=this.dialog.render(columns,rows,tier);this.tooSmall=this.dialog.disabledReason===TOO_SMALL_TO_CONFIRM;return lines;
  }

  private body(inner: number) {
    const out: Array<{ segments: TextSegment[]; cursor?: boolean }> = [];
    const plain = (text: string, fg: TokenName = 'fg.body') => out.push({ segments: [{ text: truncateEnd(text, inner), fg }] });
    plain(`分析不执行任何候选 · 可看文件 ${this.files}（省略 ${this.host.visible.omitted}）`);
    for (const text of this.host.binding ?? []) for (const line of wrapAuthorized(text, inner)) plain(line, 'fg.label');
    if (this.host.queued) plain('当前任务运行中 · 确认后独立排队，任务结束后开始 · 取证截止点在开始时固定', 'fg.muted');
    plain('');
    const pad = ' '.repeat(LABEL), head = (label: string, at: number) => `${at === this.cursor ? '›' : ' '} ${label}${' '.repeat(Math.max(0, LABEL - 2 - visibleWidth(label)))}`;
    // 一行放不下时选项换到下一行（缩进对齐），不截断选项。
    const choices = (index: number, label: string, options: [string, string][], current: string) => {
      let segments: TextSegment[] = [{ text: head(label, index), fg: index === this.cursor ? 'fg.primary' : 'fg.label' }], used = LABEL;
      options.forEach(([key, name], i) => {
        const on = key === current, part = `${on ? '◉' : '○'} ${i + 1} ${name}`, gap = used > LABEL ? '  ' : '';
        if (gap && used + visibleWidth(gap + part) > inner) { out.push({ segments, cursor: index === this.cursor }); segments = [{ text: pad }]; used = LABEL; }
        const text = (used > LABEL ? gap : '') + part;
        segments.push({ text, fg: on ? 'fg.primary' : 'fg.body' }); used += visibleWidth(text);
      });
      out.push({ segments, cursor: index === this.cursor });
    };
    this.rows.forEach((row, index) => {
      const focused = index === this.cursor;
      if (row.kind === 'scope') choices(index, '取证范围', SCOPES, this.scope);
      else if (row.kind === 'budget') choices(index, '预算上限', BUDGETS, this.budget);
      else if (row.kind === 'source') {
        const label = index === 2 ? head('附加来源', index) : `${focused ? '›' : ' '}${pad.slice(1)}`, on = this.chosen.has(row.registration.id);
        out.push({ segments: [{ text: label, fg: focused ? 'fg.primary' : 'fg.label' }, { text: `${on ? `[${GLYPHS.ok}]` : '[ ]'} ${truncateMiddle(clean(sourceLabel(row.registration)), Math.max(1, inner - LABEL - 4))}`, fg: on ? 'fg.primary' : 'fg.body' }], cursor: focused });
      } else if (row.kind === 'register') {
        const label = index === 2 ? head('附加来源', index) : `${focused ? '›' : ' '}${pad.slice(1)}`;
        out.push({ segments: [{ text: label, fg: focused ? 'fg.primary' : 'fg.label' }, { text: '+ 登记新路径', fg: focused ? 'fg.primary' : 'fg.body' }, ...(focused && !this.input ? [{ text: ' · Enter 输入路径', fg: 'fg.muted' as const }] : [])], cursor: focused });
        if (this.input) {
          out.push({ segments: [{ text: pad }, { text: this.input.text?this.pathInput.render(Math.max(1,inner-LABEL))[0]:truncateEnd(REGISTER_HINT,inner-LABEL), fg: this.input.text ? 'fg.primary' : 'fg.faint' }], cursor: true });
          if (this.input.error) out.push({ segments: [{ text: pad }, { text: truncateEnd(`${GLYPHS.err} ${this.input.error}`, inner - LABEL), fg: 'ac.err' }], cursor: true });
          else if (this.input.note) out.push({ segments: [{ text: pad }, { text: this.input.note, fg: 'fg.muted' }], cursor: true });
        }
      } else {
        // 光标停在“分析重点”时直接输入；空时用默认重点。
        const text = clean(this.focus);
        out.push({ segments: [{ text: head('分析重点', index), fg: focused ? 'fg.primary' : 'fg.label' }, { text: focused&&text?this.focusInput.render(Math.max(1,inner-LABEL))[0]:truncateEnd(text || `${DEFAULT_FOCUS}（选填）`, inner-LABEL), fg: text ? 'fg.primary' : 'fg.faint' }], cursor: focused });
      }
    });
    plain('');
    plain('↑↓ 换行 · 数字键选择 · 空格勾选来源 · Delete 移除登记', 'fg.muted');
    if(this.notice)plain(this.notice,'ac.err');
    return out;
  }
}
