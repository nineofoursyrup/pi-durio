import { readdirSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { CombinedAutocompleteProvider, visibleWidth, wrapTextWithAnsi, type AutocompleteItem, type AutocompleteProvider } from '@earendil-works/pi-tui';
import { DISPLAY_PREFIXES, readDisplayIndex, resolveDisplayInput, DisplayInputError, type DisplayKind } from '../display-number.js';

/**
 * 命令表（U11、T1）：`/` 补全、帮助视图和参数解析都只从这张表取。
 *
 * T1 标注：`bare` 是不带参数时的行为（打开视图 / 直接执行）；`withArgs` 是带参数时的行为：
 * `open` 只读操作直接打开对应层；`confirm` 计费、写记录或改变保留状态的操作只预填确认框；
 * `direct` 规格明确允许直接执行（`/withdraw`）。各屏票按标注接入，标注不等于当前处理函数已经照做。
 */
export interface OptionSpec {
  name: string;
  /** 值的写法，如 `日期`、`名称`；没有则是开关 */
  value?: string;
  /** 可选值；`free` 时它们只是补全建议，其他值也接受 */
  values?: readonly string[];
  free?: true;
  /** 可重复给出；各次的值按出现顺序用逗号连接 */
  repeat?: true;
  /** Several values until the next option, joined with commas for the handler. */
  many?: true;
  /** 值按 `MM-DD`（默认当年）或 `YYYY-MM-DD` 解析，转成本地零点的 ISO 时间 */
  date?: true;
}
export interface PositionalSpec {
  /** 帮助里的写法，如 `s-号|r-号` */
  label: string;
  /** 显示号种类；也接受完整 id */
  kinds?: readonly DisplayKind[];
  values?: readonly string[];
  required?: true;
}
export interface CommandSpec {
  name: string;
  summary: string;
  bare: 'view' | 'action';
  /** 不填 = 不接受参数 */
  withArgs?: 'open' | 'confirm' | 'direct';
  positional?: readonly PositionalSpec[];
  options?: readonly OptionSpec[];
  subcommands?: readonly CommandSpec[];
  /**
   * 首版写法（JSON 等）：参数整段原样交给处理函数，不做解析。由对应屏票换成表里的写法或删除。
   * 有 subcommands 时，第一个词不是子命令才按 raw 处理。
   */
  raw?: string;
}

const date = (name: string): OptionSpec => ({ name, value: '日期', date: true });
const project: OptionSpec = { name: 'project', value: '名称', values: ['all'], free: true };

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', summary: '打开帮助', bare: 'view' },
  { name: 'exit', summary: '退出并保留草稿', bare: 'action' },
  { name: 'restore', summary: '恢复草稿（不执行）', bare: 'action' },
  { name: 'bottom', summary: '回到底部，跟随最新输出', bare: 'action' },
  { name: 'older', summary: '上一窗口（只读）', bare: 'action' },
  { name: 'newer', summary: '下一窗口（只读）', bare: 'action' },
  { name: 'copy', summary: '复制选文或最新可见输出', bare: 'action' },
  { name: 'stop', summary: '中止运行中的任务', bare: 'action' },
  { name: 'follow-up', summary: '把输入排到下一任务', bare: 'action' },
  { name: 'compact', summary: '压缩当前上下文（原文保留）', bare: 'action' },
  {
    name: 'history', summary: '查询历史（只读）', bare: 'view', withArgs: 'open',
    positional: [{ label: 's-号|r-号', kinds: ['session', 'run'] }],
    options: [date('from'), date('to'), project, { name: 'status', value: '状态', values: ['completed', 'failed', 'aborted', 'recovery'] }],
  },
  { name: 'trace', summary: 'run 的 span 瀑布（只读）', bare: 'view', withArgs: 'open', positional: [{ label: 'r-号', kinds: ['run'] }] },
  { name: 'details', summary: '打开 2a 原文层（不带号取当前 run 最近一次工具调用）', bare: 'view', withArgs: 'open', positional: [{ label: 'tc-号' }] },
  { name: 'queue', summary: '队列与原目标', bare: 'view' },
  { name: 'withdraw', summary: '撤回待接入的请求', bare: 'view', withArgs: 'direct', positional: [{ label: 'q-号', kinds: ['queue-request'], required: true }] },
  { name: 'reattach', summary: '重新接入冻结的请求', bare: 'view', withArgs: 'confirm', positional: [{ label: 'q-号', kinds: ['queue-request'], required: true }] },
  { name: 'storage', summary: '存储占用与显式清理', bare: 'view' },
  {
    name: 'stats', summary: '任务指标（只读）', bare: 'view', withArgs: 'open',
    options: [{ name: 'self' }, date('from'), date('to'), { name: 'as-of', value: '时间' }, project, { name: 'type', value: '任务类型' }, { name: 'version', value: '执行版本' },
      { name: 'source', value: '来源', values: ['ordinary', 'synthetic', 'diagnostic'] }, { name: 'snapshot', value: '序号' }],
  },
  { name: 'eval', summary: '评估报告；run/grade 仅预填确认', bare: 'view', withArgs: 'open', positional: [{ label: 'ep-号', kinds: ['eval-plan'] }], subcommands:[
    {name:'run',summary:'启动固定计划（只预填确认）',bare:'view',withArgs:'confirm',positional:[{label:'ep-号',kinds:['eval-plan'],required:true}]},
    {name:'grade',summary:'同版本重评分（只预填确认）',bare:'view',withArgs:'confirm',positional:[{label:'ep-号',kinds:['eval-plan'],required:true}],options:[{name:'case',value:'id',repeat:true}]},
  ] },
  { name: 'acceptance', summary: '补记或纠正验收', bare: 'view', withArgs: 'confirm', raw: 'JSON' },
  {
    name: 'improve', summary: 'improve 视图；报告参数只预填选择与汇总', bare: 'view', withArgs:'confirm',
    positional:[{label:'ir-号',kinds:['improve-report']}],
    options:['execute','validate','defer','do-not-suggest'].map(name=>({name,value:'C-号…',many:true as const})),
    subcommands: [
      {
        name: 'new', summary: '新建分析（参数只预填启动框，Enter 确认后开始）', bare: 'view', withArgs: 'confirm',
        options: [{ name: 'scope', value: '范围', values: ['session', '7d', '30d'] }, { name: 'budget', value: '档位', values: ['standard', 'large'] },
          { name: 'source', value: '来源', values: ['self', 'eval'], repeat: true }, { name: 'focus', value: '文本' }],
      },
      { name: 'history', summary: '查看 improve 报告（只读）', bare: 'view', withArgs: 'open', positional: [{ label: 'ir-号', kinds: ['improve-report'] }] },
      { name: 'suppressions', summary: '查看建议抑制（只读）', bare: 'view' },
    ],
  },
  { name: 'improves', summary: '查看 improve 报告（只读）', bare: 'view', withArgs: 'open', positional: [{ label: 'ir-号', kinds: ['improve-report'] }] },
  { name: 'improve-select', summary: '结构化逐项选择与汇总提交', bare: 'view', withArgs: 'confirm', raw: 'JSON' },
  { name: 'improve-suppressions', summary: '查看建议抑制', bare: 'view' },
  { name: 'improve-restore', summary: '明确恢复建议', bare: 'action', withArgs: 'confirm', raw: 'JSON' },
  { name: 'improve-continue', summary: '明确继续独立未跑项', bare: 'action', withArgs: 'confirm', raw: 'JSON' },
  { name: 'improve-rollback', summary: '明确回退本批精确产物', bare: 'action', withArgs: 'confirm', raw: 'JSON' },
];

/** 会话屏键位（帮助视图第一段）。键位改了的屏票同时改这里。 */
export const SESSION_KEYS: readonly (readonly [string, string])[] = [
  ['Enter', '提交任务；运行中补充当前任务；恢复核对时重开面板'],
  ['Ctrl+X Enter', '排到下一任务'],
  ['Shift+Enter / Ctrl+J', '换行；行尾 \\ 后 Enter 也换行'],
  ['Esc', '关闭补全；运行中请求中止'],
  ['Ctrl+C', '运行中中止；空闲时清输入并保留草稿，再按退出'],
  ['Ctrl+D', '非空时向前删除；空输入 800ms 内再按退出'],
  ['Ctrl+O', '展开或折叠全部工具行'],
  ['Ctrl+R', '打开历史'],
  ['Ctrl+T', '打开当前或最近一次 run 的 trace'],
  ['Ctrl+L', '重绘并重新测量字宽'],
  ['?', '输入为空时打开帮助'],
  ['/', '命令补全；Tab 补子命令与选项值'],
  ['@', '文件补全，只插入路径'],
  ['PgUp / PgDn', '滚动'],
];

export const ARGUMENT_RULES = '位置参数写显示号或完整 id；选项写 --名称 值；日期写 MM-DD（默认当年）或 YYYY-MM-DD，区间按 [from,to)';

/** 帮助与补全里的参数写法。 */
export function usage(spec: CommandSpec): string {
  const parts: string[] = [];
  if (spec.subcommands) parts.push(spec.subcommands.map(s => s.name).join('|'));
  if (spec.raw) parts.push(spec.raw);
  for (const p of spec.positional ?? []) parts.push(p.required ? p.label : `[${p.label}]`);
  for (const o of spec.options ?? []) {
    const value = o.values ? (o.free ? [o.value, ...o.values] : o.values).join('|') : o.value;
    parts.push(`[--${o.name}${value ? ` ${value}` : ''}]${o.repeat ? '…' : ''}`);
  }
  return parts.join(' ');
}

export interface ParsedCommand {
  /** 顶层命令 */
  spec: CommandSpec;
  /** 实际匹配的层（子命令或顶层） */
  leaf: CommandSpec;
  /** 子命令名路径 */
  path: string[];
  positional: string[];
  /** 日期选项已转成 ISO 时间；开关为 true */
  options: Record<string, string | true>;
  /** 命令名之后的原文（raw 命令用） */
  raw: string;
}
export class CommandError extends Error {
  constructor(message: string, readonly available: readonly string[] = []) { super(message); }
  /** 状态行文案：一句原因，加可用值或候选。 */
  get line() { return `参数有误：${this.message}${this.available.length ? ` · 可用 ${this.available.join(' ')}` : ''}`; }
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]);
  return tokens;
}

/** `MM-DD`（默认当年）或 `YYYY-MM-DD` → 本地零点的 ISO 时间；格式或日期不成立时返回 undefined。 */
export function parseDate(text: string, now = new Date()): string | undefined {
  const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const year = match[1] ? Number(match[1]) : now.getFullYear(), month = Number(match[2]), day = Number(match[3]);
  const value = new Date(year, month - 1, day);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) return undefined;
  return value.toISOString();
}

const prefixOf = (kind: DisplayKind) => `${DISPLAY_PREFIXES[kind]}-`;

/**
 * 解析一行斜杠命令。只按表检查写法，不读数据；显示号到完整 id 由 resolveArgument 处理。
 * 参数有误时抛 CommandError，带可用值。
 */
export function parseCommand(text: string, table: readonly CommandSpec[] = COMMANDS, now = new Date()): ParsedCommand {
  const trimmed = text.trim(), space = trimmed.search(/\s/);
  const name = (space < 0 ? trimmed : trimmed.slice(0, space)).slice(1), rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  const spec = table.find(s => s.name === name);
  if (!spec) {
    const near = name ? table.filter(s => s.name.startsWith(name.slice(0, 2))) : [];
    throw new CommandError(`未知命令 /${name}`, (near.length ? near : table).map(s => `/${s.name}`));
  }
  const tokens = tokenize(rest), path: string[] = [];
  let leaf = spec;
  const sub = spec.subcommands?.find(s => s.name === tokens[0]);
  if (sub) { leaf = sub; path.push(sub.name); tokens.shift(); }
  else if (spec.raw) return { spec, leaf, path, positional: [], options: {}, raw: rest };
  if (tokens.length && !leaf.withArgs) throw new CommandError(`/${[spec.name, ...path].join(' ')} 不接受参数`, path.length ? [] : (spec.subcommands ?? []).map(s => s.name));
  const positional: string[] = [], options: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const option = leaf.options?.find(o => o.name === token.slice(2));
      if (!option) throw new CommandError(`未知选项 ${token}`, (leaf.options ?? []).map(o => `--${o.name}`));
      if (options[option.name] !== undefined && !option.repeat) throw new CommandError(`选项 ${token} 重复`);
      if (!option.value) { options[option.name] = true; continue; }
      let value = tokens[++i];
      if (value === undefined || value.startsWith('--')) throw new CommandError(`${token} 缺少${option.value}`, option.values ?? []);
      if(option.many){const values=[value];while(tokens[i+1]&&!tokens[i+1].startsWith('--'))values.push(tokens[++i]);value=values.join(',');}
      if (option.values && !option.free && !option.values.includes(value)) throw new CommandError(`${token} 不接受 ${value}`, option.values);
      if (option.date) {
        const iso = parseDate(value, now);
        if (!iso) throw new CommandError(`${token} 日期写 MM-DD 或 YYYY-MM-DD，收到 ${value}`);
        options[option.name] = iso;
      } else options[option.name] = option.repeat && options[option.name] !== undefined ? `${options[option.name]},${value}` : value;
      continue;
    }
    const slot = leaf.positional?.[positional.length];
    if (!slot) throw new CommandError(`多余的参数 ${token}`, (leaf.options ?? []).map(o => `--${o.name}`));
    if (slot.values && !slot.values.includes(token)) throw new CommandError(`不接受 ${token}`, slot.values);
    if (slot.kinds) {
      if(!/^[-\w.:]{1,128}$/.test(token))throw new CommandError(`这里要 ${slot.label} 或完整 id，收到 ${token}`);
      const prefixed = /^([a-z]+)-[0-9a-f]+$/i.exec(token)?.[1]?.toLowerCase();
      const kind = (Object.keys(DISPLAY_PREFIXES) as DisplayKind[]).find(k => DISPLAY_PREFIXES[k] === prefixed);
      if (kind && !slot.kinds.includes(kind)) throw new CommandError(`这里要 ${slot.label} 或完整 id，收到 ${token}`);
    }
    positional.push(token);
  }
  const missing = leaf.positional?.slice(positional.length).find(p => p.required);
  if (missing) throw new CommandError(`/${[spec.name, ...path].join(' ')} 需要 ${missing.label}`);
  if (typeof options.from === 'string' && typeof options.to === 'string' && Date.parse(options.from) >= Date.parse(options.to))
    throw new CommandError('区间按 [from,to)，--from 须早于 --to');
  return { spec, leaf, path, positional, options, raw: rest };
}

/**
 * 位置参数 → 完整 id 与种类。显示号按前缀定种类；其他输入当作完整 id，种类多于一个时按记录判断。
 * 未找到或显示号歧义时抛 CommandError，歧义时列出候选。
 */
export function resolveArgument(root: string, input: string, kinds: readonly DisplayKind[]): { kind: DisplayKind; id: string } {
  const prefixed = kinds.find(k => input.toLowerCase().startsWith(prefixOf(k)) && /^[a-z]+-[0-9a-f]+$/i.test(input));
  try {
    if (prefixed) return { kind: prefixed, id: resolveDisplayInput(root, prefixed, input) };
    if (kinds.length === 1) return { kind: kinds[0], id: input };
    const index = readDisplayIndex(root), found = kinds.filter(k => index.has(k, input));
    if (found.length === 1) return { kind: found[0], id: input };
    throw new CommandError(found.length ? `${input} 同时对应 ${found.join('、')}` : `没有找到 ${input}`, found.length ? [] : kinds.map(k => `${prefixOf(k)}号`));
  } catch (error) {
    if (!(error instanceof DisplayInputError)) throw error;
    if (error.code === 'DISPLAY_AMBIGUOUS') throw new CommandError(`${input} 有 ${error.candidates.length} 个候选`, error.candidates.map(c => `${c.display}（${c.project ?? '—'} · ${c.at ?? '时间未知'}）`));
    throw new CommandError(`没有找到 ${input}`);
  }
}

// ─── 补全 ────────────────────────────────────────────────────────────────

/** 工作区内的有界目录遍历（没有 fd 时）：最多看 MAX_WALK 个条目，跳过 .git。 */
const MAX_WALK = 5000;
function walkFiles(base: string): { path: string; directory: boolean }[] {
  const found: { path: string; directory: boolean }[] = [], queue = [base];
  while (queue.length && found.length < MAX_WALK) {
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name), directory = entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return statSync(full).isDirectory(); } catch { return false; } })());
      found.push({ path: relative(base, full), directory });
      if (entry.isDirectory()) queue.push(full);
      if (found.length >= MAX_WALK) break;
    }
  }
  return found;
}
function subsequence(text: string, query: string) {
  let at = 0;
  for (const char of text) if (char === query[at]) at++;
  return at === query.length;
}
/** `@` 后的模糊匹配：先比文件名，再比路径；值只是 `@路径`（有空白时加引号）。 */
export function walkFileSuggestions(base: string, query: string): AutocompleteItem[] {
  const q = query.toLowerCase();
  return walkFiles(base)
    .map(entry => {
      const path = entry.path.toLowerCase(), name = path.slice(path.lastIndexOf('/') + 1);
      const score = !q ? 1 : name.startsWith(q) ? 4 : name.includes(q) ? 3 : path.includes(q) ? 2 : subsequence(path, q) ? 1 : 0;
      return { ...entry, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, 20)
    .map(({ path, directory }) => {
      const shown = directory ? `${path}/` : path;
      return { value: /\s/.test(shown) ? `@"${shown}"` : `@${shown}`, label: shown.slice(shown.replace(/\/$/, '').lastIndexOf('/') + 1), description: shown };
    });
}
function findFd(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, 'fd'), constants.X_OK); return join(dir, 'fd'); } catch { /* next */ }
  }
  return null;
}

/** 当前词的补全候选：子命令、选项名、选项值或位置参数的可选值。 */
function argumentItems(spec: CommandSpec, before: string[], current: string): AutocompleteItem[] {
  let leaf = spec;
  const sub = spec.subcommands?.find(s => s.name === before[0]);
  if (sub) { leaf = sub; before = before.slice(1); }
  const previous = before.at(-1), option = previous?.startsWith('--') ? leaf.options?.find(o => o.name === previous.slice(2)) : undefined;
  let items: AutocompleteItem[];
  if (option?.value) items = (option.values ?? []).map(v => ({ value: v, label: v, description: `--${option.name}` }));
  else {
    const used = new Set(before.filter(t => t.startsWith('--')));
    const options = (leaf.options ?? []).filter(o => o.repeat || !used.has(`--${o.name}`)).map(o => ({ value: `--${o.name}`, label: `--${o.name}`, description: o.values && !o.free ? o.values.join('|') : o.value ?? '开关' }));
    const takesValue = (t?: string) => !!t?.startsWith('--') && !!leaf.options?.find(o => o.name === t.slice(2))?.value;
    const slot = leaf.positional?.[before.filter((t, i) => !t.startsWith('--') && !takesValue(before[i - 1])).length];
    const subs = !sub && !before.length ? (spec.subcommands ?? []).map(s => ({ value: s.name, label: s.name, description: s.summary })) : [];
    items = [...subs, ...(slot?.values ?? []).map(v => ({ value: v, label: v, description: slot!.label })), ...(current.startsWith('-') || !subs.length ? options : [])];
  }
  return items.filter(item => item.value.startsWith(current));
}

/**
 * `/` 命令补全（命令名、子命令、选项名与选项值，均取自命令表）与 `@` 文件补全（只插入路径）。
 * 装有 fd 时文件补全交给 pi-tui 的 CombinedAutocompleteProvider（遵守 .gitignore），否则做有界遍历。
 */
export function commandCompletion(workspace: string, table: readonly CommandSpec[] = COMMANDS, fdPath: string | null = findFd()): AutocompleteProvider {
  const files = fdPath ? new CombinedAutocompleteProvider([], workspace, fdPath) : undefined;
  return {
    triggerCharacters: ['/', '@'],
    async getSuggestions(lines, line, col, options) {
      const before = lines[line]?.slice(0, col) ?? '';
      const at = /(?:^|\s)(@(?:"[^"]*|\S*))$/.exec(before)?.[1];
      if (at !== undefined) {
        if (files) return files.getSuggestions(lines, line, col, options);
        const items = walkFileSuggestions(workspace, at.slice(1).replace(/^"/, ''));
        return items.length ? { prefix: at, items } : null;
      }
      if (line !== 0 || !before.startsWith('/')) return null;
      const space = before.search(/\s/);
      if (space < 0) {
        const items = table.filter(s => s.name.startsWith(before.slice(1))).map(s => ({ value: `/${s.name}`, label: `/${s.name}`, description: s.summary }));
        return items.length ? { prefix: before, items } : null;
      }
      const spec = table.find(s => s.name === before.slice(1, space));
      if (!spec) return null;
      const words = before.slice(space + 1).split(/\s+/), current = words.pop() ?? '';
      const items = argumentItems(spec, words.filter(Boolean), current);
      return items.length ? { prefix: current, items } : null;
    },
    applyCompletion(lines, line, col, item, prefix) {
      const text = lines[line] ?? '', start = col - prefix.length, suffix = item.value.endsWith('/') || item.value.endsWith('/"') ? '' : ' ';
      const next = [...lines];
      next[line] = `${text.slice(0, start)}${item.value}${suffix}${text.slice(col).replace(/^ /, '')}`;
      return { lines: next, cursorLine: line, cursorCol: start + item.value.length + suffix.length };
    },
  };
}

// ─── 帮助视图 ────────────────────────────────────────────────────────────

/** 帮助视图正文：会话屏键位表，然后是命令清单（名称、参数写法、一句说明）。每行不超过 width。 */
export function helpBody(width: number, table: readonly CommandSpec[] = COMMANDS): string[] {
  const w = Math.max(1, width), lines: string[] = [];
  const wrap = (text: string, indent: number) => wrapTextWithAnsi(text, Math.max(1, w - indent)).map(l => ' '.repeat(indent) + l);
  const keyColumn = Math.max(...SESSION_KEYS.map(([key]) => visibleWidth(key))) + 2;
  lines.push('会话屏键位');
  for (const [key, text] of SESSION_KEYS) {
    if (w >= 60) {
      const rows = wrapTextWithAnsi(text, Math.max(1, w - 2 - keyColumn));
      lines.push(`  ${key}${' '.repeat(keyColumn - visibleWidth(key))}${rows[0] ?? ''}`, ...rows.slice(1).map(r => ' '.repeat(2 + keyColumn) + r));
    } else lines.push(...wrap(key, 2), ...wrap(text, 4));
  }
  lines.push('', '命令', ...wrap(ARGUMENT_RULES, 2));
  const entry = (spec: CommandSpec, name: string) => {
    const written = usage(spec);
    lines.push(...wrap(`${name}${written ? ` ${written}` : ''}`, 2), ...wrap(spec.summary, 4));
  };
  for (const spec of table) {
    entry(spec, `/${spec.name}`);
    for (const sub of spec.subcommands ?? []) entry(sub, `/${spec.name} ${sub.name}`);
  }
  return lines;
}

/** 补全与帮助共用的命令名清单（含子命令），用于同源检查。 */
export function commandNames(table: readonly CommandSpec[] = COMMANDS): string[] {
  return table.flatMap(s => [`/${s.name}`, ...(s.subcommands ?? []).map(sub => `/${s.name} ${sub.name}`)]);
}
