import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep, resolve, dirname, basename } from 'node:path';

export const BUILD_INPUT_PATHS = ['src', 'test', 'scripts', 'vendor', 'package.json', 'package-lock.json', 'tsconfig.json'];
/** Shared build/verification inventory; neither caller executes source files. */
export function buildInventory(root, paths, lines = false) {
  const entries = [];
  function visit(path) {
    const full = join(root, path), info = lstatSync(full);
    if (info.isSymbolicLink()) throw Error(`BUILD_INPUT_ALIAS:${path}`);
    if (info.isDirectory()) { for (const name of readdirSync(full).sort()) visit(join(path, name)); }
    else if (info.isFile()) {
      const bytes = readFileSync(full);
      entries.push({ path, sha256: sha256(bytes), bytes: bytes.length, ...(lines ? { physicalLines: bytes.reduce((n, b) => n + (b === 10 ? 1 : 0), 0) + (bytes.length && bytes.at(-1) !== 10 ? 1 : 0) } : {}) });
    } else throw Error(`BUILD_INPUT_TYPE:${path}`);
  }
  for (const path of paths) visit(path);
  return entries;
}
export const schema = 'pi-durio-redesign-terminal-v1';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const within = (root, path) => { const r = relative(root, path); return !r || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
export function newOutputPath(path, protectedRoots) {
  const requested = resolve(path), output = join(realpathSync(dirname(requested)), basename(requested));
  if (protectedRoots.some(root => within(realpathSync(root), output))) throw Error('OUTPUT_MUST_BE_OUTSIDE_CANDIDATE');
  return output;
}
export function inventory(root, relative = '') {
  return readdirSync(join(root, relative)).sort().flatMap(name => {
    const path = join(relative, name), full = join(root, path), stat = lstatSync(full);
    if (stat.isSymbolicLink()) { if (!within(realpathSync(root), realpathSync(full))) throw Error(`EXTERNAL_FILE_ALIAS:${path}`); return [{ path, sha256: `link:${readlinkSync(full)}` }]; }
    if (stat.isDirectory()) return inventory(root, path);
    if (stat.isFile()) return [{ path, sha256: sha256(readFileSync(full)) }];
    throw Error(`UNSUPPORTED_FILE_TYPE:${path}`);
  });
}
export function verifyInventory(root, entries, label) {
  if (!isAbsolute(root) || !Array.isArray(entries) || !entries.length) throw Error(`${label}_INVALID_INVENTORY`);
  for (const e of entries) if (typeof e.path !== 'string' || isAbsolute(e.path) || normalize(e.path) !== e.path || e.path.split('/').includes('..')) throw Error(`${label}_INVALID_PATH`);
  const actual = inventory(root), expected = new Map(entries.map(e => [e.path, e.sha256]));
  if (expected.size !== entries.length || actual.length !== entries.length || actual.some(e => !expected.has(e.path))) throw Error(`${label}_FILE_SET_CHANGED`);
  for (const e of actual) if (expected.get(e.path) !== e.sha256) throw Error(`${label}_FILE_CHANGED:${e.path}`);
}
export const dimensions = [{ columns: 132, rows: 38 }, { columns: 80, rows: 24 }, { columns: 40, rows: 12 }];
export const screens = ['1a', '1b', '1c', '1d', '1e', '1f', '2a', '2b', '2c'];
export const machineItems = [
  ['terminal', 'macOS arm64 / Apple_Terminal / stdin+stdout TTY'],
  ['dimensions', '132×38、80×24、40×12 实际窗口尺寸'],
  ['color', '本次启动色档与实际颜色 SGR'],
  ['page-up', 'PgUp 实际键码送达程序'], ['page-down', 'PgDn 实际键码送达程序'],
  ['backspace', '空输入撤回最新一项；第二次间隔 <500ms 时没有再次撤回'],
  ['help-empty', '空输入 ? 打开帮助'], ['help-nonempty', '非空输入 ? 保留文本，不打开帮助'],
  ['width', '真实 CPR / 宽度门成功校准'], ['raw', '退出 raw mode 与进入前一致'],
  ['stty', '退出 stty 与进入前一致'], ['modes', '输出光标/鼠标/粘贴/原缓冲区恢复序列'],
];
export const operatorItems = [
  ['ime', '中文 IME 组合、候选 Enter、持续输出期间候选窗位置'],
  ['glyphs', '48 个设计字形与光标/复制布局'], ['color', '三档字形与颜色；1e 覆盖条和值配色'],
  ['ambiguous-narrow', '关闭东亚歧义字符宽字符设置，Ctrl+L 重测并核对'],
  ['ambiguous-wide', '开启东亚歧义字符宽字符设置，Ctrl+L 重测并核对'],
  ['mouse', '滚动、选文、工具行展开、欢迎/历史/队列命中区域'],
  ['stats-tabs', '/stats 顶层 Tab/Shift+Tab 切页签；子层不切'],
  ['self-keys', '2c 按键样本累积；b 不清空累计值'],
  ['restore', '退出后光标、输入、原缓冲区与终端背景恢复'],
];
const pending = ([id, label]) => ({ id, label, status: 'NOT_RUN', evidence: [], observation: null });
export function templates() {
  return {
    'machine-checklist.json': { scope: 'native-terminal', items: machineItems.map(pending) },
    'operator-checklist.json': { scope: 'human-terminal-observation', items: operatorItems.map(pending) },
    'golden-index.json': { scope: 'offline-character-grid', screens: screens.map(id => ({ id, columns: 132, rows: 38, generated: 'NOT_RUN', regression: 'NOT_RUN', userConfirmation: { status: 'NOT_RUN', at: null, statement: null, acceptedDeviation: null }, artifacts: [] })) },
    'screenshots.json': { scope: 'native-terminal-screenshot', slots: [...screens.map(id => [id, 'truecolor']), ...['1b', '1e'].flatMap(id => ['256color', 'none'].map(tier => [id, tier]))].map(([screen, tier]) => ({ screen, tier, columns: 132, rows: 38, status: 'NOT_RUN', path: null, sha256: null, executionVersion: null, candidate: null, at: null })) },
  };
}
