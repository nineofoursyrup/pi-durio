/** Preset filters shared by the 1e command and keyboard entry points. */
import { decode, records } from '../history.js';
import { taskTypeOf } from '../task-type.js';
import { CommandError, parseDate } from './commands.js';
import { PresetFilter, type FilterValues } from './view-stack.js';
import { statsCommand, statsRequest, type StatsRequest, type StatsSource } from './stats.js';

export interface StatsChoices { projects: string[]; types: string[]; versions: string[] }
export class StatsChoicesLimitError extends CommandError {
  constructor() { super('筛选选项范围过大 · STATS_CHOICES_TOO_LARGE · 使用较小的数据根读取选项，或用绝对项目路径直接打开统计'); }
}
/** Only selection metadata is read, so shrinking a rejected metrics query remains possible. */
export function statsChoices(root: string, workspace: string): StatsChoices {
  const projects = new Set([workspace]), types = new Set<string>(), versions = new Set<string>();
  let count = 0, bytes = 0;
  for (const ref of records(root, { kinds: ['task.accepted', 'control.accepted', 'execution.artifact'] })) {
    bytes += ref.ref.bytes;
    if (++count > 10000 || bytes > 32 * 1024 * 1024) throw new StatsChoicesLimitError();
    try {
      const data = decode(root, ref);
      if (ref.kind === 'execution.artifact') { if (typeof data.id === 'string') versions.add(data.id); continue; }
      const project = data.projectId ?? data.workspace ?? data.target?.workspace;
      if (typeof project === 'string') projects.add(project);
      const type = taskTypeOf(data);
      if (type) types.add(type);
    } catch { /* unreadable metadata cannot establish a selectable identity */ }
  }
  const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
  return { projects: sorted(projects), types: sorted(types), versions: sorted(versions) };
}

export const statsDate = (iso: string) => {
  const d = new Date(iso), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const day = (iso: string, delta = 0) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).toISOString(); };
const SOURCES: StatsSource[] = ['ordinary', 'synthetic', 'diagnostic'];

export class StatsFilter {
  readonly preset: PresetFilter;
  constructor(private readonly initial: StatsRequest, private readonly workspace: string, private readonly choices: StatsChoices) {
    const scope = initial.scope, days = [7, 30, 90];
    const retain = (items: string[], active?: string) => [...new Set([...items, ...active ? [active] : []])];
    this.choices = choices = { projects: retain(choices.projects, scope.project), types: retain(choices.types, scope.taskType), versions: retain(choices.versions, scope.version) };
    const match = days.findIndex(n => scope.from === day(scope.asOf, 1 - n) && scope.to === day(scope.asOf, 1));
    const all = scope.from === new Date(1970, 0, 1).toISOString() && scope.to === day(scope.asOf, 1);
    const values: FilterValues = {
      time: match >= 0 ? { option: match } : all ? { option: 3 } : { option: 4, value: `${statsDate(scope.from)} ${statsDate(scope.to)}` },
      project: scope.project === undefined ? { option: 1 } : scope.project === statsRequest({}, workspace).scope.project ? { option: 0 } : { option: 2, value: scope.project },
      source: { option: SOURCES.indexOf(scope.source) },
      type: scope.taskType ? { option: 1, value: scope.taskType } : { option: 0 },
      version: scope.version ? { option: 1, value: scope.version } : { option: 0 },
    };
    this.preset = new PresetFilter([
      { key: 'time', label: '时间', options: [...days.map(n => ({ label: `近 ${n} 天` })), { label: '全部' }, { label: '自定义', custom: { kind: 'input', placeholder: 'YYYY-MM-DD YYYY-MM-DD', validate: text => { try { this.dates(text); } catch (error) { return (error as Error).message; } } } }] },
      { key: 'project', label: '项目', options: [{ label: '当前' }, { label: '全部' }, { label: '列表', custom: { kind: 'list', items: choices.projects } }] },
      { key: 'source', label: '来源', options: [{ label: '日常' }, { label: '合成' }, { label: '诊断' }] },
      { key: 'type', label: '任务类型', options: [{ label: '全部' }, ...choices.types.length ? [{ label: '列表', custom: { kind: 'list' as const, items: choices.types } }] : []] },
      { key: 'version', label: '执行版本', options: [{ label: '全部' }, ...choices.versions.length ? [{ label: '列表', custom: { kind: 'list' as const, items: choices.versions } }] : []] },
    ], values);
  }
  private dates(text: string): [string, string] {
    const [a, b, extra] = text.trim().split(/\s+/), now = new Date(this.initial.scope.asOf);
    const from = a && parseDate(a, now), to = b && parseDate(b, now);
    if (!from || !to || extra || from >= to) throw new CommandError('日期写 MM-DD 或 YYYY-MM-DD，用空格分隔，结束日期须晚于开始日期');
    return [from, to];
  }
  get request(): StatsRequest | undefined {
    const v = this.preset.result;
    if (v.time.option === 4 && !v.time.value || v.project.option === 2 && !v.project.value || v.type.option === 1 && !v.type.value || v.version.option === 1 && !v.version.value) return undefined;
    const base = this.initial.scope;
    const [from, to] = v.time.option === 4 ? this.dates(v.time.value!) : [v.time.option === 3 ? new Date(1970, 0, 1).toISOString() : day(base.asOf, 1 - [7, 30, 90][v.time.option]), day(base.asOf, 1)];
    const scope = statsRequest({
      from, to, 'as-of': base.asOf, project: v.project.option === 0 ? undefined : v.project.option === 1 ? 'all' : v.project.value,
      source: SOURCES[v.source.option], type: v.type.option === 1 ? v.type.value : undefined, version: v.version.option === 1 ? v.version.value : undefined,
      snapshot: base.through === undefined ? undefined : String(base.through),
    }, this.workspace, new Date(base.asOf), this.choices.projects).scope;
    return { scope, command: statsCommand(scope) };
  }
}
