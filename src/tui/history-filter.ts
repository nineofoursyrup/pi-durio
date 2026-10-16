/** U13: one scope for the /history command and its three preset dimensions. */
import { CommandError, parseDate } from './commands.js';
import { resolveProjectFilter } from './project-filter.js';
import { PresetFilter, type FilterValues } from './view-stack.js';

export interface HistoryScope { project?: string; from?: string; to?: string; status?: string }
export interface HistoryTarget extends HistoryScope { session?: string; run?: string }
const states = [undefined, 'completed', 'failed', 'aborted', 'unknown'];
const day = (now: Date, offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).toISOString();
const date = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export function historyScope(options: Record<string, string | boolean | undefined>, workspace: string, projects: readonly string[] = [], now = new Date()): HistoryScope {
  const get = (key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
  const parse = (key: string) => { const value = get(key); if (value === undefined) return undefined; const parsed = /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : parseDate(value, now); if (!parsed) throw new CommandError('日期写 MM-DD 或 YYYY-MM-DD'); return parsed; };
  const from = parse('from'), to = parse('to'), status = get('status') === 'recovery' ? 'unknown' : get('status');
  if (from && to && from >= to) throw new CommandError('结束日期须晚于开始日期');
  if (!states.includes(status)) throw new CommandError('状态无效', ['completed', 'failed', 'aborted', 'recovery']);
  return { project: resolveProjectFilter(get('project'), workspace, projects), from, to, status };
}
export function historyCommand(scope: HistoryScope) {
  const quote = (s: string) => /^[^\s"'\\]+$/.test(s) ? s : JSON.stringify(s);
  return ['/history', '--project', quote(scope.project ?? 'all'), ...(scope.from ? ['--from', date(scope.from)] : []), ...(scope.to ? ['--to', date(scope.to)] : []), ...(scope.status ? ['--status', scope.status === 'unknown' ? 'recovery' : scope.status] : [])].join(' ');
}
export class HistoryFilter {
  readonly preset: PresetFilter;
  constructor(private readonly initial: HistoryScope, private readonly workspace: string, private readonly projects: string[], private readonly now = new Date()) {
    const days = [7, 30, 90], match = days.findIndex(n => initial.from === day(now, 1 - n) && initial.to === day(now, 1));
    const values: FilterValues = {
      time: !initial.from && !initial.to ? { option: 3 } : match >= 0 ? { option: match } : { option: 4, value: `${initial.from ? date(initial.from) : '-'} ${initial.to ? date(initial.to) : '-'}` },
      project: { option: initial.project === undefined ? 1 : initial.project === resolveProjectFilter(undefined, workspace) ? 0 : 2, ...(initial.project ? { value: initial.project } : {}) },
      status: { option: Math.max(0, states.indexOf(initial.status)) },
    };
    this.preset = new PresetFilter([
      { key: 'time', label: '时间', options: [...days.map(n => ({ label: `近 ${n} 天` })), { label: '全部' }, { label: '自定义', custom: { kind: 'input', placeholder: '开始 结束（YYYY-MM-DD；- 不限）', validate: text => { try { this.dates(text); } catch (error) { return (error as Error).message; } } } }] },
      { key: 'project', label: '项目', options: [{ label: '当前' }, { label: '全部' }, { label: '列表', custom: { kind: 'list', items: [...new Set([workspace, ...projects, ...initial.project ? [initial.project] : []])] } }] },
      { key: 'status', label: '状态', options: ['全部', '完成', '失败', '已中止', '待恢复核对'].map(label => ({ label })) },
    ], values);
  }
  private dates(text: string) {
    const [from, to, extra] = text.trim().split(/\s+/);
    if (!from || !to || extra) throw new CommandError('输入开始和结束日期，用空格分隔');
    return historyScope({ from: from === '-' ? undefined : from, to: to === '-' ? undefined : to, project: 'all' }, this.workspace, this.projects, this.now);
  }
  get scope(): HistoryScope | undefined {
    const v = this.preset.result;
    if (v.time.option === 4 && !v.time.value || v.project.option === 2 && !v.project.value) return undefined;
    const dates = v.time.option === 3 ? {} : v.time.option === 4 ? this.dates(v.time.value!) : { from: day(this.now, 1 - [7, 30, 90][v.time.option]), to: day(this.now, 1) };
    return historyScope({ ...dates, project: v.project.option === 0 ? undefined : v.project.option === 1 ? 'all' : v.project.value, status: states[v.status.option] }, this.workspace, this.projects, this.now);
  }
}
