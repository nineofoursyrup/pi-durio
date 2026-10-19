import { dimensions, machineItems } from './common.mjs';
import { colorModes } from './grid.mjs';

/** Pure assessment of acquired native observations. Missing facts are never a PASS. */
export function assessNative(record) {
  const items = machineItems.map(([id, label]) => ({ id, label, status: 'NOT_RUN', evidence: [] }));
  const set = (id, ok, evidence) => { const item = items.find(i => i.id === id); if (item.status === 'FAIL') return; Object.assign(item, { status: ok ? 'PASS' : 'FAIL', evidence }); };
  const env = record.environment;
  if (env) set('terminal', env.platform === 'darwin' && env.arch === 'arm64' && env.TERM_PROGRAM === 'Apple_Terminal' && env.stdinTTY && env.stdoutTTY, ['environment.json']);
  const events = record.events ?? [], output = record.output ?? '';
  const sizes = [record.before, ...events.filter(e => e.kind === 'resize')].filter(Boolean);
  const seen = dimensions.filter(want => sizes.some(got => got.columns === want.columns && got.rows === want.rows));
  const geometry = items.find(i => i.id === 'dimensions'); geometry.sizes = dimensions.map(want => ({ ...want, status: seen.includes(want) ? 'PASS' : 'NOT_RUN' }));
  if (seen.length === dimensions.length) set('dimensions', true, ['events.jsonl', 'before.json']);
  if (output.length && env?.tier && record.expectedTier) {
    const colors = colorModes(output);
    set('color', env.tier === record.expectedTier && (env.tier === 'none' ? colors.length === 0 : colors.length === 1 && colors[0] === env.tier), ['environment.json', 'terminal-output.ansi']);
  }
  for (const [id, key] of [['page-up', '\x1b[5~'], ['page-down', '\x1b[6~']]) {
    // An explicit completed physical-key attempt distinguishes not delivered
    // from not attempted. Keep the first failed attempt even after a success.
    const attempts = events.filter(e => e.kind === 'key-attempt' && e.key === id && e.completed === true);
    for (const attempt of attempts) set(id, attempt.received === true, ['events.jsonl']);
    if (events.some(e => ['received', 'input'].includes(e.kind) && e.data === key)) set(id, true, ['events.jsonl']);
  }
  const help = screen => screen?.some(line => line.trim() === '帮助');
  const editor = screen => screen?.at(-4)?.trim() ?? '';
  for (const e of events.filter(e => e.kind === 'input' && e.data === '?' && e.settled && !help(e.before?.screen))) {
    const text = editor(e.before?.screen);
    if (/^描述要(完成的修改|查看或分析的内容)…/.test(text)) set('help-empty', help(e.after?.screen), ['events.jsonl']);
    else if (text === 'probe') set('help-nonempty', !help(e.after?.screen) && editor(e.after?.screen) === 'probe?', ['events.jsonl']);
  }
  const backs = events.filter(e => e.kind === 'input' && ['\x7f', '\x08'].includes(e.data));
  for (let i = 1; i < backs.length; i++) {
    const first = backs[i - 1], second = backs[i], interval = second.ms - first.ms;
    if (!first.settled || !second.settled || interval <= 0 || interval >= 500 || !Array.isArray(first.before?.queue) || first.before.queue.length < 2 || !Array.isArray(first.after?.queue) || !Array.isArray(second.before?.queue) || !Array.isArray(second.after?.queue)) continue;
    const a = first.before.queue, b = first.after.queue, c = second.after.queue;
    if (!/^补充当前任务…/.test(editor(first.before.screen)) || !/^补充当前任务…/.test(editor(second.before.screen))) continue;
    set('backspace', b.length === a.length - 1 && !b.includes(a.at(-1)) && a.slice(0, -1).every(id => b.includes(id)) && JSON.stringify(second.before.queue) === JSON.stringify(b) && JSON.stringify(c) === JSON.stringify(b), ['events.jsonl']);
    break; // The first eligible pair stays the evidence, even if a later pair succeeds.
  }
  if (record.result?.widthCalibration) { const w = record.result.widthCalibration; set('width', w.status === 'measured' && !w.error && w.observations?.length > 0, ['result.json']); }
  if (record.before && record.after) {
    if (typeof record.before.raw === 'boolean' && typeof record.after.raw === 'boolean' && typeof record.during?.raw === 'boolean') set('raw', record.during.raw && record.before.raw === record.after.raw, ['before.json', 'result.json', 'after.json']);
    if (record.before.stty && record.after.stty) set('stty', record.before.stty === record.after.stty, ['before.json', 'after.json']);
  }
  if (output) {
    const last = mode => [...output.matchAll(new RegExp(`\\x1b\\[\\?${mode}([hl])`, 'g'))].at(-1)?.[1];
    const mouse = [1000, 1002, 1003, 1006].filter(mode => last(mode) !== undefined);
    set('modes', last(25) === 'h' && last(1049) === 'l' && last(2004) === 'l' && mouse.length > 0 && mouse.every(mode => last(mode) === 'l'), ['terminal-output.ansi']);
  }
  return { scope: 'native-machine-observations-only', nativeHumanAcceptance: 'NOT_RUN', items };
}
