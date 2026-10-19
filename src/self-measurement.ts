/** U9: observations of this process, retained records and its build; never a benchmark or a writer. */
import { readFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKeyRelease } from '@earendil-works/pi-tui';
import { digest, readObject, openHostReadonly } from './evidence.js';
import { records, decode, queryHistory, watermark } from './history.js';
import { factClock } from './fact-clock.js';
import { storageGroups } from './storage-groups.js';
import { queryOperationsMetrics, type MetricsScope } from './metrics/index.js';
import { periodSpend } from './tui/stats.js';

export interface SelfValue<T> { value: T | null; source: 'process' | 'records' | 'build-manifest'; basis: string; samples: number | null; reason?: string }
const measured = <T>(value: T | null, source: SelfValue<T>['source'], basis: string, samples: number | null = null, reason?: string): SelfValue<T> => ({ value, source, basis, samples, ...reason ? { reason } : {} });
export interface SourceInput { path: string; physicalLines?: number; sha256?: string; bytes?: number }
const validLines = (file: SourceInput) => Number.isSafeInteger(file.physicalLines) && file.physicalLines! >= 0;

export function sourceCodeTotals(manifest: { inputs?: SourceInput[] }, metadata: { dependencies?: Record<string, string> }) {
  const inputs = manifest.inputs ?? [];
  const count = (files: SourceInput[], basis: string) => files.length && files.every(validLines)
    ? measured({ files: files.length, lines: files.reduce((n, f) => n + f.physicalLines!, 0) }, 'build-manifest', basis)
    : measured<{ files: number; lines: number }>(null, 'build-manifest', basis, null, '未记录 · 当前构建清单缺少完整物理行数');
  const own = inputs.filter(f => f.path.startsWith('src/'));
  const product = count(own, '首版 A2：src/** 物理行，含空行、注释与 src/eval；不含案例/fixture');
  const directories = [...new Set(own.map(f => `${dirname(f.path)}/`))];
  const groups = directories.map(directory => ({ directory, ...count(own.filter(f => `${dirname(f.path)}/` === directory), product.basis).value! })).sort((a, b) => b.lines - a.lines || a.directory.localeCompare(b.directory));
  const dependencies = Object.entries(metadata.dependencies ?? {});
  return {
    product: { ...product, value: product.value ? { ...product.value, groups } : null },
    scripts: count(inputs.filter(f => /^scripts\/(eval|isolation)\//.test(f.path)), '随包 scripts/eval/** 与 scripts/isolation/**；与产品源码分开'),
    patch: count(inputs.filter(f => f.path === 'vendor/pi-tui/width-overrides.patch'), 'pi-tui 宽度补丁文件的物理行（含 diff 上下文）'),
    tests: count(inputs.filter(f => f.path.startsWith('test/') && !f.path.startsWith('test/fixtures/') && /\.[cm]?[jt]sx?$/.test(f.path)), '测试维护代码；不含 fixture、快照；不随包'),
    dependencies: measured(metadata.dependencies ? { count: dependencies.length, exact: dependencies.every(([, version]) => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || version.startsWith('file:') && inputs.some(f => f.path === version.slice(5) && !!f.sha256)) } : null, 'build-manifest', 'package.json 直接生产依赖：精确版本或已绑定内容的本地包；不含 devDependencies'),
  };
}

export function readSelfBuild(root = fileURLToPath(new URL('../../', import.meta.url))) {
  try {
    const raw = readFileSync(join(root, 'dist/execution/source-build.json')), manifest = JSON.parse(raw.toString());
    const packageBytes = readFileSync(join(root, 'package.json'));
    const packageInput = manifest.inputs?.find((f: SourceInput) => f.path === 'package.json');
    if (manifest.version !== 1 || packageInput?.sha256 !== digest(packageBytes)) throw Error('SELF_BUILD_CONTENT_CHANGED');
    return { id: digest(raw), code: sourceCodeTotals(manifest, JSON.parse(packageBytes.toString())) };
  } catch (error) { return { id: null, code: sourceCodeTotals({}, {}), error: String(error) }; }
}
// Capture only these small build files once, before user work. Later rebuilding a checkout cannot relabel this process.
const installedBuild = readSelfBuild();

export class ProcessMeasurements {
  private firstFrameMs: number | null = null;
  private pending: number[] = [];
  private samples: number[] = [];
  constructor(private readonly now = () => performance.now()) {}
  input(data: string) {
    // Terminal query replies, focus/mouse events and key releases are not key-to-redraw samples.
    if (!data || isKeyRelease(data) || /^\x1b(?:\[(?:[?\d;]+[Rucn]|[IO]|<)|\]|P)/.test(data)) return;
    this.pending.push(this.now());
  }
  /** Called after Terminal.write returns, only for a complete synchronized frame, not cursor/query traffic. */
  paint(data: string) {
    // Width calibration saves/restores the cursor for its temporary status line and CPR probes.
    if (!data.includes('\x1b[?2026h') || !data.includes('\x1b[?2026l') || data.includes('\x1b7')) return;
    const end = this.now(); this.firstFrameMs ??= end;
    for (const start of this.pending) this.samples.push(Math.max(0, end - start));
    this.pending = [];
  }
  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b), n = sorted.length;
    return { firstFrameMs: this.firstFrameMs, keys: { samples: n, p50: n ? sorted[Math.ceil(n * .5) - 1] : null, p95: n >= 20 ? sorted[Math.ceil(n * .95) - 1] : null } };
  }
}
export const processMeasurements = new ProcessMeasurements();

export function selfCostScope(now = new Date()): MetricsScope & { from: string; to: string; asOf: string } {
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString(), to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(), asOf: now.toISOString(), source: 'ordinary' };
}
const originalKinds = ['model.payload', 'model.provider-event', 'model.response', 'tool.output', 'tool.result', 'tool.error', 'read.bytes', 'read.text', 'shell.stdout', 'shell.stderr', 'generation.request', 'generation.response'];
const installationBasis = '本进程任务记录的当前执行版本 lockfile 生产安装清单字节合计，含 provider SDK/原生依赖；不含 Node、开发依赖；非文件系统 allocated bytes';

/** No writable Evidence is opened. Every selected artifact must bind this process build and platform. */
export function readSelfRecords(root: string, build: string | null, processId = factClock().processId) {
  const tasks = new Set<string>(), processTasks = new Set<string>(), ownAttempts = new Set<string>();
  const outputs = new Map<string, { raw: number; text: number; hasRaw: boolean }>();
  const gaps: string[] = [];
  let tasksComplete = true, processComplete = true, outputsComplete = true;
  let installation = measured<number>(null, 'records', installationBasis, null, '未记录 · 当前执行版本尚无安装清单');
  if (!existsSync(join(root, 'host.sqlite'))) return { tasks: 0, processTasks: 0, toolOutputBytes: 0, rawBodyBytes: 0, installation, through: 0, gaps };
  const through = watermark(root);
  // Aggregate content-addressed original sizes in SQLite; chunk count does not become JS heap or
  // a shared failure gate for unrelated installation/process measurements.
  const db = openHostReadonly(root);
  let rawBodyBytes: number;
  try {
    rawBodyBytes = Number(db.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes FROM
      (SELECT json_extract(body,'$.sha256') AS sha, MAX(json_extract(body,'$.bytes')) AS bytes
       FROM records WHERE seq<=? AND kind IN (${originalKinds.map(() => '?').join(',')}) GROUP BY sha)`).get(through, ...originalKinds)!.bytes);
  } finally { db.close(); }
  const keep = (set: Set<string>, id: string) => { if (set.has(id)) return true; if (set.size >= 50000) return false; set.add(id); return true; };
  for (const ref of records(root, { through, kinds: ['task.accepted', 'control.accepted', 'run.started', 'recovery.started', 'tool.dispatch', 'tool.output', 'tool.result', 'execution.artifact'] })) {
    const d = decode(root, ref), sameProcess = d.clock?.processId === processId;
    if (ref.kind === 'task.accepted') tasksComplete = keep(tasks, d.taskId ?? ref.runId) && tasksComplete;
    if (ref.kind === 'control.accepted' && d.kind === 'follow-up' && d.taskId) tasksComplete = keep(tasks, d.taskId) && tasksComplete;
    if (sameProcess && ['task.accepted', 'run.started', 'recovery.started'].includes(ref.kind)) processComplete = keep(processTasks, ref.runId) && processComplete;
    const attempt = d.attemptId ?? d.toolAttempt?.attemptId, key = `${ref.runId}:${attempt}`;
    if (ref.kind === 'tool.dispatch' && sameProcess && typeof attempt === 'string') outputsComplete = keep(ownAttempts, key) && outputsComplete;
    if (outputsComplete && typeof attempt === 'string' && (ownAttempts.has(key) || ref.kind === 'tool.result' && sameProcess)) {
      const item = outputs.get(key) ?? { raw: 0, text: 0, hasRaw: false };
      if (ref.kind === 'tool.output' && typeof d.acquired?.bytes === 'string') { item.raw += Buffer.from(d.acquired.bytes, 'base64').length; item.hasRaw = true; }
      if (ref.kind === 'tool.result') item.text = (d.result?.content ?? []).reduce((n: number, c: any) => n + (c.type === 'text' && typeof c.text === 'string' ? Buffer.byteLength(c.text) : 0), 0);
      if (outputs.has(key) || outputs.size < 50000) outputs.set(key, item); else outputsComplete = false;
    }
    if (ref.kind === 'execution.artifact' && processTasks.has(ref.runId) && build && d.node === process.version && d.platform === process.platform && d.arch === process.arch && d.files?.some((f: any) => f.path === 'dist/execution/source-build.json' && f.sha256 === build)) {
      try {
        if (!d.installation || d.installation.bytes > 8 * 1024 * 1024) throw Error('INSTALLATION_INVENTORY_UNAVAILABLE');
        const files = JSON.parse(readObject(root, d.installation).toString());
        if (!Array.isArray(files) || files.length > 20000 || files.some(f => !Number.isSafeInteger(f.bytes) || f.bytes < 0)) throw Error('INSTALLATION_INVENTORY_INVALID');
        installation = measured(files.reduce((n, f) => n + f.bytes, 0), 'records', `${installationBasis}；来源 ${ref.id}`, files.length);
      } catch (error) { installation = measured<number>(null, 'records', installationBasis, null, String(error)); }
    }
  }
  if (!tasksComplete) gaps.push('SELF_TASK_IDENTITIES_LIMIT: 超过 50000 个独立任务，任务均值未取得');
  if (!processComplete) gaps.push('SELF_PROCESS_TASKS_LIMIT: 本进程超过 50000 个任务，峰值附带任务数未取得');
  if (!outputsComplete) gaps.push('SELF_PROCESS_OUTPUTS_LIMIT: 本进程超过 50000 次工具尝试，输出量未取得');
  return { tasks: tasksComplete ? tasks.size : null, processTasks: processComplete ? processTasks.size : null,
    toolOutputBytes: outputsComplete ? [...outputs.values()].reduce((n, o) => n + (o.hasRaw ? o.raw : o.text), 0) : null,
    rawBodyBytes, installation, through, gaps };
}

export interface SelfEnvironment { build: string | null; chip: string; system: string; node: string; terminal: string; terminalVersion: string | null; columns: number | null; rows: number | null; dataRoot: string; uptimeMs: number }
export function selfEnvironment(root: string, dimensions: { columns: number | null; rows: number | null }, build: string | null): SelfEnvironment {
  let system = '未知';
  if (process.platform === 'darwin') try { system = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8').match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? '未知'; } catch {}
  else system = `${process.platform}（macOS 版本未知）`;
  return { build, chip: cpus()[0]?.model ?? '未知', system, node: process.version, terminal: process.env.TERM_PROGRAM === 'Apple_Terminal' ? 'Terminal.app' : process.env.TERM_PROGRAM || '未知', terminalVersion: process.env.TERM_PROGRAM_VERSION ?? null, columns: dimensions.columns, rows: dimensions.rows, dataRoot: root, uptimeMs: performance.now() };
}

export const NOT_MEASURED = [
  { name: '分发体积', reason: '产品无法得知自身打包后的分发体积' },
  { name: '冷启动 p50/p95', reason: '需要在产品外重复启动' },
  { name: '受控空闲 / 长会话 RSS', reason: '需要固定的受控负载；当前进程 RSS 不能代替' },
  { name: '输出取得写入耗时 / 大输出', reason: '需要产品外固定负载与采集边界' },
] as const;

export function readSelfSnapshot(root: string, dimensions: { columns: number | null; rows: number | null }, samples = processMeasurements, busy = false, now = new Date()) {
  const build = installedBuild, environment = selfEnvironment(root, dimensions, build.id), scope = selfCostScope(now);
  const attempt = <T>(source: SelfValue<T>['source'], basis: string, fn: () => T) => { try { return measured(fn(), source, basis, 1); } catch (error) { return measured<T>(null, source, basis, null, String(error)); } };
  const facts = attempt('records', '宿主记录：按任务身份去重；本进程仅取 acquisition clock.processId', () => readSelfRecords(root, build.id));
  const query = attempt('records', 'queryHistory 全项目第一页（最多 50 个已受理任务），run 数按返回的非空 run 身份去重', () => { const start = performance.now(), page = queryHistory(root, {}, { limit: 50 }); return { ms: performance.now() - start, runs: new Set(page.items.flatMap(i => i.runId ? [i.runId] : [])).size, more: page.next !== null, coverage: page.coverage }; });
  const cost = attempt('records', '复用 1e 期间开销：近 7 天整日、全部项目、日常来源；按请求发生时间去重，估算非账单；保留原币种和 unknown', () => { const ops = queryOperationsMetrics(root, scope); return { scope: ops.sample.scope, spend: periodSpend(ops), gaps: ops.costs.period.gaps }; });
  const memory = attempt('process', 'process.memoryUsage().rss；取样时状态', () => ({ bytes: process.memoryUsage().rss, state: busy ? '任务运行中' : '空闲' }));
  const peak = attempt('process', 'process.resourceUsage().maxRSS × 1024（KiB → B）；任务/输出取本进程已有事实，工具文本与 shell 原始字节不重复', () => ({ bytes: process.resourceUsage().maxRSS * 1024, tasks: facts.value?.processTasks ?? null, toolOutputBytes: facts.value?.toolOutputBytes ?? null }));
  const timing = samples.snapshot();
  return { schema: 'pi-durio-self-v1', at: now.toISOString(), environment, code: build.code, buildError: build.error,
    installation: facts.value?.installation ?? measured<number>(null, 'records', installationBasis, null, facts.reason),
    firstFrame: measured(timing.firstFrameMs, 'process', 'performance.now()：本次进程启动到首个同步帧写出；不含终端绘制；只有一个样本', timing.firstFrameMs === null ? 0 : 1),
    keys: measured(timing.keys, 'process', '每个用户输入事件收到至下一同步重绘写出，nearest-rank p50/p95；不含终端绘制；仅内存，少于 20 个不计 p95', timing.keys.samples),
    memory, peak, query, cost, facts, notMeasured: NOT_MEASURED.map(item => ({ ...item, value: null, samples: 0, source: 'external', status: '产品内不测 · 见 A2 报告' })),
  };
}
export type SelfSnapshot = ReturnType<typeof readSelfSnapshot>;
export async function selfStorage(root: string, facts: SelfSnapshot['facts']) {
  const { totals } = await storageGroups(root);
  return measured({ total: totals.total, tasks: facts.value?.tasks ?? null,
    perTask: facts.value?.tasks ? totals.total / facts.value.tasks : null,
    originals: facts.value ? totals.sessions + totals.attachments + facts.value.rawBodyBytes : null,
    breakdown: totals, gaps: facts.value?.gaps ?? [],
  }, 'records', '当前数据根现存字节 ÷ 已受理任务；完整原文单列会话、附件和原文事实正文（保留表示副本，不做内容去重）；清理后的现存量不代表历史累计增长；异步扫描期间活跃写入可能改变结果', 1);
}
