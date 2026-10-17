/**
 * What the TUI needs to start an improve analysis and to list the improve view's first layer (I1, U4, U13; #89).
 * Reads only; the one write is an explicit source registration from the launch box.
 */
import { lstatSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { records, decode } from './history.js';
import { readSessionChains } from './session-chain.js';
import { taskTypeOf } from './task-type.js';
import { readImproveDefaults, type TaskType } from './improve-defaults.js';
import { listRegisteredSources, registerImproveSource, sourceBytes, verifySelfSource, type ImproveSource, type SourceRegistration } from './improve-source.js';
import { listImproveReports, priorImprove, type ImproveReport, type ImproveRequest } from './improve.js';
import { improveCandidateDecisions, listImproveSuppressions } from './improve-history.js';
import { upperBoundAmount } from './cost-estimate.js';
import { digest } from './evidence.js';
import { improveReportContract } from './improve-contract.js';

// ─── 档位 ──────────────────────────────────────────────────────────────────

export type ImproveScope = 'session' | '7d' | '30d';
export type ImproveBudget = 'standard' | 'large';
export const SCOPE_DAYS: Record<ImproveScope, 0 | 7 | 30> = { session: 0, '7d': 7, '30d': 30 };
/** Every request reserves the provider context bound plus the output maximum; the standard total is two such requests. */
const CONTEXT_TOKENS = 1048576;
/** 标准：≤16 请求、单次输出 ≤32k tok、总计 ≤2.16M tok、≤10 分钟；加大各项翻倍（I1）。 */
export function improveLimits(budget: ImproveBudget) {
  const k = budget === 'large' ? 2 : 1, maxOutputTokens = 32768 * k;
  return { maxRequests: 16 * k, maxOutputTokens, maxRequestTokens: CONTEXT_TOKENS + maxOutputTokens, maxTokens: 2 * (CONTEXT_TOKENS + 32768) * k, maxDurationMs: 600000 * k };
}
/** 按最坏情况预留折算的人民币上限（宿主价目的高峰输出价）；价目未覆盖时 null。 */
export function improveBudgetAmount(budget: ImproveBudget) {
  return upperBoundAmount(improveLimits(budget).maxTokens, 'deepseek', 'deepseek-flash');
}
export const DEFAULT_FOCUS = '找出本会话中可改进之处';
/** Source views stay at the first-version bounds: ≤40 paths per source, ≤256 KiB per file, ≤1 MiB in all. */
const MAX_PATHS = 40, MAX_FILE = 262144, MAX_TOTAL = 1048576;
const QUERY = { maxRuns: 10, maxRecords: 200, maxEvidenceBytes: 32768, maxSourceBytes: 32768 };

// ─── 默认可看的文件 ────────────────────────────────────────────────────────

export interface VisibleFiles {
  /** Project files the chain's runs read or changed, most recently used first, within the bounds. */
  project: string[];
  /** Files enabled by improve for this project and task type (prompt, skill, config). */
  enabled: ImproveSource[];
  files: number;
  /** Existing used files left out by the bounds. */
  omitted: number;
  taskType: TaskType | null;
}
/**
 * 默认可看：本会话（上下文链）各 run 实际读过或改过的项目文件，加上本项目当前由 improve 启用的 prompt、skill 与配置；
 * 超出首版上限时保留最近用过的，其余计入省略数。已不存在或不能作为源视图读取的文件不计入。
 */
export function improveVisibleFiles(root: string, workspace: string, runId: string): VisibleFiles {
  const chain = readSessionChains(root).contextRunIds(runId), runs = chain.length ? chain : [runId];
  const used = new Map<string, number>();
  let taskType: TaskType | null = null;
  for (const id of runs) for (const ref of records(root, { runId: id, kinds: ['task.accepted', 'tool.intent'] })) {
    const data = decode(root, ref);
    if (ref.kind === 'task.accepted') { if (id === runId) { const type = taskTypeOf(data); taskType = type === 'coding' || type === 'read' ? type : null; } continue; }
    if (!['read', 'edit', 'write'].includes(data.tool) || typeof data.args?.path !== 'string') continue;
    const path = projectPath(workspace, data.args.path);
    if (path) { used.delete(path); used.set(path, ref.seq); }
  }
  const enabled: ImproveSource[] = [];
  let total = 0;
  if (taskType) {
    const groups = new Map<string, ImproveSource>();
    for (const file of readImproveDefaults(root, workspace, taskType).files) {
      const key = `${file.kind}\0${file.root}`;
      if (!groups.has(key)) groups.set(key, { id: `enabled-${groups.size + 1}`, kind: file.kind, root: file.root, paths: [] });
      groups.get(key)!.paths.push(file.path); total += file.content.bytes;
    }
    enabled.push(...groups.values());
  }
  const project: string[] = [];let omitted = 0;
  for (const path of [...used.keys()].reverse()) {
    let bytes: number;
    try { bytes = sourceBytes(workspace, path, MAX_FILE).length; } catch { continue; }
    if (project.length < MAX_PATHS && total + bytes <= MAX_TOTAL) { project.push(path); total += bytes; } else omitted++;
  }
  return { project, enabled, files: project.length + enabled.reduce((n, s) => n + s.paths.length, 0), omitted, taskType };
}
function projectPath(workspace: string, input: string) {
  const absolute = isAbsolute(input) ? normalize(input) : resolve(workspace, input), path = relative(workspace, absolute);
  return !path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) ? undefined : path.split(sep).join('/');
}

// ─── 来源登记 ──────────────────────────────────────────────────────────────

export const REGISTER_HINT = 'self|eval <路径>';
/**
 * 启动框“登记新路径”：`self <路径>` 或 `eval <路径>`。路径是文件或目录（目录内至多 40 个文件）。
 * 自身源码须位于一个 build 与当前安装对应的 pi-durio checkout 内（向上找到 dist/execution/source-build.json 后由宿主核对）；
 * 只凭名称或目录名不登记。已有相同登记时返回原登记。
 */
export function registerFromInput(dataRoot: string, workspace: string, input: string): SourceRegistration {
  const {kind,root,paths}=previewRegisterFromInput(workspace,input);
  const existing = listRegisteredSources(dataRoot, realpathSync(workspace)).find(r => r.kind === kind && r.root === root && JSON.stringify(r.paths) === JSON.stringify(paths));
  return existing ?? registerImproveSource(dataRoot, workspace, { kind, root, paths });
}
/** Read-only confirmation input. Recompute and compare it before registration. */
export function previewRegisterFromInput(workspace:string,input:string) {
  const match = /^(self|eval)\s+(.+)$/.exec(input.trim());
  if (!match) throw Error(`IMPROVE_REGISTER_INPUT: 写 ${REGISTER_HINT}`);
  const kind = match[1] === 'self' ? 'self-source' as const : 'eval-asset' as const;
  const target = realpathSync(expandPath(workspace, match[2]));
  let root = statSync(target).isDirectory() ? target : dirname(target);
  if (kind === 'self-source') {
    let checkout = target;
    while (!existsSync(join(checkout, 'dist/execution/source-build.json'))) { const parent = dirname(checkout); if (parent === checkout) throw Error('SELF_SOURCE_CHECKOUT_NOT_FOUND'); checkout = parent; }
    verifySelfSource(checkout); root = checkout;
  }
  const paths = statSync(target).isDirectory() ? listFiles(target).map(p => relative(root, join(target, p)).split(sep).join('/')) : [relative(root, target).split(sep).join('/')];
  if (!paths.length) throw Error('IMPROVE_REGISTER_EMPTY');
  if (paths.length > MAX_PATHS) throw Error(`IMPROVE_REGISTER_PATH_LIMIT: ${paths.length} 个文件，至多 ${MAX_PATHS}`);
  const fingerprints=paths.map(path=>{const bytes=sourceBytes(root,path);return {path,sha256:digest(bytes),bytes:bytes.length};});
  return {kind,root,paths,fingerprints};
}
export function expandPath(workspace: string, input: string) {
  return input === '~' || input.startsWith('~/') ? join(homedir(), input.slice(1)) : resolve(workspace, input);
}
function listFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name, stat = lstatSync(join(dir, path));
    if (stat.isDirectory()) found.push(...listFiles(dir, path)); else if (stat.isFile()) found.push(path);
    if (found.length > MAX_PATHS) break;
  }
  return found;
}
/** Tab 补全路径：唯一匹配时补全（目录加 `/`），多个时补到共同前缀。返回新文本与匹配数。 */
export function completePath(workspace: string, text: string): { text: string; matches: number } {
  const match = /^(self|eval)(\s+)(.*)$/.exec(text);
  if (!match) return { text, matches: 0 };
  const typed = match[3], slash = typed.lastIndexOf('/'), head = slash >= 0 ? typed.slice(0, slash + 1) : '', prefix = typed.slice(slash + 1);
  let names: string[];
  try { names = readdirSync(expandPath(workspace, head || '.'), { withFileTypes: true }).filter(e => e.name !== '.git' && e.name.startsWith(prefix)).map(e => e.isDirectory() ? `${e.name}/` : e.name); } catch { return { text, matches: 0 }; }
  if (!names.length) return { text, matches: 0 };
  let common = names[0];
  for (const name of names) while (!name.startsWith(common)) common = common.slice(0, -1);
  return { text: `${match[1]}${match[2]}${head}${common}`, matches: names.length };
}

// ─── 请求 ──────────────────────────────────────────────────────────────────

export interface LaunchChoice { scope: ImproveScope; budget: ImproveBudget; sources: SourceRegistration[]; focus: string }
/** 启动框的档位 → 分析请求：取证范围、预算上限、默认可看的文件与勾选的已登记来源。 */
export function improveRequest(id: string, choice: LaunchChoice, visible: VisibleFiles): ImproveRequest {
  const sources: ImproveSource[] = [{ id: 'project', kind: 'project', paths: visible.project }, ...visible.enabled,
    ...choice.sources.map(r => ({ id: `registered-${r.id.slice(0, 8)}`, kind: r.kind, root: r.root, paths: r.paths }))];
  return { id, purpose: choice.focus.trim() || DEFAULT_FOCUS, limits: improveLimits(choice.budget), sources, query: QUERY, window: SCOPE_DAYS[choice.scope] };
}

// ─── 第一层 ────────────────────────────────────────────────────────────────

/** 首版报告按已知完整格式识别；零候选不能证明报告版本。 */
export function isFirstVersionReport(report: Pick<ImproveReport, 'candidates' | 'suppressed' | 'selectionContract'>) { return improveReportContract(report)==='legacy'; }
/** 该报告的 improve.report 记录；分析未结束或没有报告时 null。 */
export function readReportRecord(root: string, id: string): ImproveReport | null {
  const start = priorImprove(root, id);
  if (!start) return null;
  let report: ImproveReport | null = null;
  for (const ref of records(root, { runId: start.source.runId, kinds: ['improve.report'] })) report = decode(root, ref);
  return report;
}
export interface PendingReport { id: string; startedAt: string; sessionId: string | null; candidates: number; undecided: number }
export interface ImproveHomeFacts { pending: PendingReport[]; reports: number; suppressions: number }
/**
 * 第一层的条目事实：本工作区待选择的报告（新版报告中还有未决候选的，新的在前；首版报告不列入）、历史报告数、生效的建议抑制数。
 * “未决”= 尚无决定，或最后一次仅验证已通过、还可选执行（I4）。至多看最近 200 份报告。
 */
export function improveHome(root: string, workspace: string): ImproveHomeFacts {
  const items: ReturnType<typeof listImproveReports>['items'] = [];
  for (let after: number | undefined, pages = 0; pages < 4; pages++) {
    const page = listImproveReports(root, { after, limit: 50 });
    items.push(...page.items.filter(i => i.target.workspace === workspace));
    if (page.next === null) break;
    after = page.next;
  }
  const chains = readSessionChains(root), pending: PendingReport[] = [];
  for (const item of [...items].reverse()) {
    let report: ImproveReport | null = null;
    for (const ref of records(root, { runId: item.runId, kinds: ['improve.report'] })) report = decode(root, ref);
    if (!report || isFirstVersionReport(report)) continue;
    const latest = improveCandidateDecisions(root, report.id);
    const undecided = report.candidates.filter(c => { const prior = latest.get(c.id); return !prior || prior.canExecute; }).length;
    if (undecided) pending.push({ id: report.id, startedAt: report.startedAt, sessionId: chains.sessionOfRun(report.target.runId)?.id ?? null, candidates: report.candidates.length, undecided });
  }
  let suppressions = 0;
  try { suppressions = listImproveSuppressions(root, workspace).filter(s => s.active).length; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { pending, reports: items.length, suppressions };
}
/** 登记来源在启动框里的名字。 */
export function sourceLabel(registration: SourceRegistration) {
  const home = homedir(), root = registration.root.startsWith(`${home}/`) ? `~${registration.root.slice(home.length)}` : registration.root;
  return `${registration.kind === 'self-source' ? '自身源码' : 'eval 资产'} ${root}${registration.paths.length === 1 ? `/${registration.paths[0]}` : ` · ${registration.paths.length} 个文件`}`;
}
