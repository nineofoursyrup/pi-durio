import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const scripts = join(process.cwd(), 'scripts/redesign-terminal');
function command(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' },
  });
}
test('PREP freezes synthetic identity without importing products; verification detects drift and never overwrites evidence', t => {
  for (const file of readdirSync(scripts).filter(name => name.endsWith('.mjs'))) {
    const parsed = spawnSync(process.execPath, ['--check', join(scripts, file)], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
  }
  const root = mkdtempSync(join(tmpdir(), 'durio-redesign-terminal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'package'), output = join(root, 'prepared');
  mkdirSync(join(installed, 'dist/execution'), { recursive: true });
  mkdirSync(join(installed, 'dist/src/tui'), { recursive: true });
  writeFileSync(join(installed, 'dist/execution/source-build.json'), '{"synthetic":true}\n');
  writeFileSync(join(installed, 'dist/src/tui/app.js'), 'throw Error("PRODUCT_IMPORTED_DURING_VERIFY");\n');
  const args = ['--source', process.cwd(), '--package', installed, '--out', output, '--synthetic'];
  const prepared = command('prepare.mjs', args);
  assert.equal(prepared.status, 0, prepared.stderr);
  const path = join(output, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.nativeAcceptance, 'NOT_RUN');
  const verified = command('verify.mjs', ['--manifest', path]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(command('native.mjs', ['--manifest', path, '--verify-only']).status, 0);
  assert.match(command('native.mjs', ['--manifest', path, '--output', join(root, 'native')]).stderr, /SYNTHETIC_MANIFEST_NOT_NATIVE/);
  assert.match(command('capture.mjs', ['--manifest', path, '--run', root, '--image', 'absent.png', '--output', join(root, 'capture')]).stderr, /SYNTHETIC_MANIFEST_NOT_NATIVE/);
  const before = readFileSync(path);
  assert.notEqual(command('prepare.mjs', args).status, 0);
  assert.deepEqual(readFileSync(path), before);
  assert.match(command('prepare.mjs', ['--source', process.cwd(), '--package', installed, '--out', join(installed, '..prep'), '--synthetic']).stderr, /OUTPUT_MUST_BE_OUTSIDE_CANDIDATE/);
  symlinkSync(installed, join(root, 'alias'));
  assert.match(command('prepare.mjs', ['--source', process.cwd(), '--package', installed, '--out', join(root, 'alias/new'), '--synthetic']).stderr, /OUTPUT_MUST_BE_OUTSIDE_CANDIDATE/);
  writeFileSync(join(installed, 'extra'), 'changed');
  assert.match(command('verify.mjs', ['--manifest', path]).stderr, /FILE_SET_CHANGED/);
  rmSync(join(installed, 'extra'));
  writeFileSync(join(installed, 'dist/src/tui/app.js'), 'changed');
  assert.match(command('verify.mjs', ['--manifest', path]).stderr, /FILE_CHANGED/);
  writeFileSync(join(root, 'outside'), 'mutable executable'); symlinkSync(join(root, 'outside'), join(installed, 'escape'));
  assert.match(command('prepare.mjs', [...args.slice(0, -2), join(root, 'escaped'), '--synthetic']).stderr, /EXTERNAL_FILE_ALIAS/);
});

test('offline grids render all nine screens, complete 1a/1f and the stats states without claiming human acceptance', t => {
  const root = mkdtempSync(join(tmpdir(), 'durio-redesign-grids-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'grids');
  const rendered = command('goldens.mjs', ['--development', '--package', process.cwd(), '--output', output]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const index = JSON.parse(readFileSync(join(output, 'golden-index.json'), 'utf8'));
  assert.equal(index.candidate, null);
  assert.equal(index.nativeAcceptance, 'NOT_RUN');
  for (const screen of ['1a', '1b', '1c', '1d', '1e', '1f', '2a', '2b', '2c']) {
    for (const [columns, rows] of [[132, 38], [80, 24], [40, 12]]) assert.ok(index.artifacts.some((a: any) => a.screen === screen && a.columns === columns && a.rows === rows));
  }
  assert.ok(index.artifacts.every((a: any) => a.userConfirmation.status === 'NOT_RUN' && a.regression === 'NOT_RUN'));
  assert.ok(index.artifacts.some((a: any) => a.screen === '1e' && a.state === 'unknown'));
  assert.match(readFileSync(join(output, '1a-132x38-truecolor-default.txt'), 'utf8'), /132x38 truecolor[\s\S]*描述要完成的修改[\s\S]*37\|/);
  assert.match(readFileSync(join(output, '1f-132x38-truecolor-default.txt'), 'utf8'), /pi-durio 已退出[\s\S]*任务 1 完成/);
  const expected = { '1d': /improve/, '1e': /指标/, '2a': /trace/, '2b': /eval/, '2c': /self/ };
  for (const [screen, title] of Object.entries(expected)) for (const size of ['132x38', '80x24', '40x12']) {
    const path = `${screen}-${size}-truecolor-${screen === '1e' && size === '132x38' ? 'six-oracles' : 'default'}.txt`;
    const text = readFileSync(join(output, path), 'utf8');
    assert.match(text, title, `${path} keeps its header`);
    assert.match(text, /Esc/, `${path} keeps its exit hint`);
    assert.match(text, new RegExp((size === '132x38' ? '01' : '00') + '\\|[^\\n]*' + (screen === '2c' ? '指标 · 本机实测' : title.source)), `${path} keeps the header after the collapsible top margin`);
    assert.doesNotMatch(text, /◆ pi-durio|Enter steer|Ctrl\+X Enter follow-up|检查已保留的合成事实/, `${path} covers the underlying session`);
  }
  const stats = readFileSync(join(output, '1e-132x38-truecolor-six-oracles.txt'), 'utf8');
  assert.match(stats, /80\.0%/); assert.match(stats, /25\.0%/); assert.match(stats, /1\/3/); assert.match(stats, /62\.5%/);
  assert.match(stats, /只读 · 不调用模型 · 不重记费用/, 'six-oracle header keeps its read-only note at the product inner width');
  assert.match(stats, /› 任务验收/, '1e opens with the product default row selected');
  assert.match(stats, /↑↓ 选行 · Enter 成员 · \/ 筛选 · e 导出 · Tab 页签 · Esc 返回会话/, '1e shows the product browser hints');
  assert.match(stats, /❯ \/stats --from \S+ --to \S+ --as-of 2026-10-17T02:00:00\.000Z --project \/synthetic\/shop-api --snapshot 1/, '1e shows the command for the read scope');
  const trace = readFileSync(join(output, '2a-132x38-truecolor-default.txt'), 'utf8');
  assert.match(trace, /Enter 原文/);
  assert.match(trace, /p 固定为证据/);
  const rerun = command('goldens.mjs', ['--development', '--package', process.cwd(), '--output', join(root, 'repeat'), '--baseline', output]);
  assert.equal(rerun.status, 0, rerun.stderr);
  const repeated = JSON.parse(readFileSync(join(root, 'repeat/golden-index.json'), 'utf8'));
  const differences = repeated.artifacts.filter((a: any) => a.regression !== 'MATCH').map((a: any) => {
    const first = readFileSync(join(output, a.path), 'utf8').split('\n'), second = readFileSync(join(root, 'repeat', a.path), 'utf8').split('\n');
    return a.path + '\n' + first.flatMap((line, i) => line === second[i] ? [] : ['- ' + line, '+ ' + second[i]]).join('\n');
  });
  assert.equal(differences.join('\n'), '');
});

test('native assessment keeps missing facts unrun, the first failure and the real sub-500ms withdrawal evidence', async () => {
  const { assessNative } = await import(pathToFileURL(join(scripts, 'assess.mjs')).href);
  const item = (record: any, id: string) => assessNative(record).items.find((i: any) => i.id === id);
  assert.ok(assessNative({ before: {}, after: {} }).items.every((i: any) => i.status === 'NOT_RUN'));
  assert.equal(item({events:[{kind:'key-attempt',key:'page-up',completed:true,received:false}]},'page-up').status,'FAIL');
  assert.equal(item({events:[{kind:'key-attempt',key:'page-up',completed:false,received:false}]},'page-up').status,'NOT_RUN');
  assert.equal(item({events:[{kind:'key-attempt',key:'page-down',completed:true,received:true}]},'page-down').status,'PASS');
  assert.equal(item({events:[{kind:'key-attempt',key:'page-up',completed:true,received:false},{kind:'received',data:'\x1b[5~'}]},'page-up').status,'FAIL');
  const { screens } = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/redesign-terminal/native-input-screens.json'), 'utf8'));
  const before = { screen: screens.running, queue: ['q-first', 'q-last'] }, after = { screen: screens.running, queue: ['q-first'] };
  const pair = [{ kind: 'input', data: '\x7f', ms: 1000, settled: true, before, after }, { kind: 'input', data: '\x7f', ms: 1300, settled: true, before: after, after }];
  assert.equal(item({ events: pair }, 'backspace').status, 'PASS');
  assert.equal(item({ events: [pair[0], { ...pair[1], ms: 1500 }] }, 'backspace').status, 'NOT_RUN');
  assert.equal(item({ events: [{ ...pair[0], settled: false }, pair[1]] }, 'backspace').status, 'NOT_RUN');
  assert.equal(item({ events: [pair[0], { ...pair[1], settled: false }] }, 'backspace').status, 'NOT_RUN');
  const failed = { ...pair[1], after: { ...after, queue: [] } };
  assert.equal(item({ events: [pair[0], failed, ...pair.map(e => ({ ...e, ms: e.ms + 2000 }))] }, 'backspace').status, 'FAIL');
  const help = { kind: 'input', data: '?', settled: true, before: { screen: screens.idle }, after: { screen: screens.help } };
  assert.equal(item({ events: [help] }, 'help-empty').status, 'PASS');
  assert.equal(item({ events: [{ ...help, settled: false }] }, 'help-empty').status, 'NOT_RUN');
  assert.equal(item({ events: [{ ...help, after: { screen: [] } }, help] }, 'help-empty').status, 'FAIL');
  assert.equal(item({ events: [{ ...help, before: { screen: screens.probe }, after: { screen: screens.probeQuestion } }] }, 'help-nonempty').status, 'PASS');
  assert.equal(item({ expectedTier: 'none', environment: { tier: 'none' }, output: '\x1b[1;31mwrong color' }, 'color').status, 'FAIL');
  assert.equal(item({ expectedTier: '256color', environment: { tier: '256color' }, output: '\x1b[1;38;5;233mtest' }, 'color').status, 'PASS');
  assert.equal(item({ result: { widthCalibration: { status: 'measured', observations: [] } } }, 'width').status, 'FAIL');
});

test('native assessment locates the closed input frame around menus and keeps incomplete input observations unrun', async () => {
  const { assessNative } = await import(pathToFileURL(join(scripts, 'assess.mjs')).href);
  const { screens } = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/redesign-terminal/native-input-screens.json'), 'utf8'));
  const status = (before: string[], after: string[], id = 'help-nonempty') => assessNative({ events: [{
    kind: 'input', data: '?', settled: true, before: { screen: before }, after: { screen: after },
  }] }).items.find((item: any) => item.id === id).status;
  // Structural variants of captured screens exercise both the r3 menu location
  // and the historical location. They are not new native acceptance evidence.
  const menu = ['     → /help        打开帮助', '       /exit        退出并保留草稿'];
  for (const side of ['above', 'below']) {
    const withMenu = (screen: string[]) => {
      const edge = screen.findIndex(line => line.trim().startsWith(side === 'above' ? '╭' : '╰')) + (side === 'below' ? 1 : 0);
      return [...screen.slice(0, edge), ...menu, ...screen.slice(edge)];
    };
    assert.equal(status(withMenu(screens.probe), withMenu(screens.probeQuestion)), 'PASS', side);
  }
  const withoutTop = screens.probe.filter((line: string) => !line.trim().startsWith('╭'));
  const withoutBottom = screens.probe.filter((line: string) => !line.trim().startsWith('╰'));
  assert.equal(status(withoutTop, screens.probeQuestion), 'NOT_RUN');
  assert.equal(status(withoutBottom, screens.probeQuestion), 'NOT_RUN');
  assert.equal(status(['probe'], screens.probeQuestion), 'NOT_RUN');
  const moreInput = [...screens.probe];
  moreInput.splice(moreInput.findIndex(line => line.trim().startsWith('╰')), 0, '  │  second line                                                                                                                 │  ');
  assert.equal(status(moreInput, screens.probeQuestion), 'NOT_RUN', 'a probe prefix in multiline input is not the single probe');
  assert.equal(status(screens.probe, screens.help), 'FAIL');
  assert.equal(status(screens.idle.map((line: string) => line.replace('描述要查看或分析的内容…', '描述要完成的修改…')), screens.help, 'help-empty'), 'PASS');
});

test('native assessment recognizes horizontal input rules without accepting missing rules or multiline input as empty', async () => {
  const { assessNative } = await import(pathToFileURL(join(scripts, 'assess.mjs')).href);
  const captured = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/redesign-terminal/native-input-screens.json'), 'utf8')).screens;
  // Derived structural fixtures, not native observations; retain the historical captured originals.
  const rules = (screen: string[]) => screen.map(line => line.replace(/[╭╮╰╯]/g, '─').replace(/│/g, ' '));
  const screens = Object.fromEntries(Object.entries(captured).map(([key, lines]) => [key, rules(lines as string[])]));
  const status = (before: string[], after: string[], id = 'help-nonempty') => assessNative({ events: [{
    kind: 'input', data: '?', settled: true, before: { screen: before }, after: { screen: after },
  }] }).items.find((item: any) => item.id === id).status;
  assert.equal(status(screens.probe, screens.probeQuestion), 'PASS');
  assert.equal(status(screens.idle, screens.help, 'help-empty'), 'PASS');
  const input = screens.probe.findIndex(line => line.trim().startsWith('❯ '));
  for (const row of [input - 1, input + 1]) {
    const incomplete = [...screens.probe]; incomplete[row] = '';
    assert.equal(status(incomplete, screens.probeQuestion), 'NOT_RUN', 'both complete rules are required');
  }
  const multiline = [...screens.probe]; multiline.splice(input + 1, 0, '   second line   ');
  assert.equal(status(multiline, screens.probeQuestion), 'NOT_RUN');
  const menu = ['     → /help        打开帮助', '       /exit        退出并保留草稿'];
  const withMenu = (screen: string[]) => [...screen.slice(0, input - 1), ...menu, ...screen.slice(input - 1)];
  assert.equal(status(withMenu(screens.probe), withMenu(screens.probeQuestion)), 'PASS');
});

test('offline grid retains wide Chinese and emoji graphemes with token coordinates', async () => {
  const { characterGrid } = await import(pathToFileURL(join(scripts, 'grid.mjs')).href);
  const theme = await import('../src/tui/theme.js'), { visibleWidth } = await import('@earendil-works/pi-tui');
  const grid = characterGrid([theme.fgSgr('ac.ok', 'truecolor') + '中👩‍💻é' + '\x1b[0;1m!'], 7, 1, 'truecolor', theme, visibleWidth);
  assert.equal(grid.rows[0].length, 7);
  assert.deepEqual(grid.rows[0].slice(0, 6).map((cell: any) => cell.char), ['中', '', '👩‍💻', '', 'é', '!']);
  assert.equal(grid.rows[0][4].fg, 'ac.ok');
  assert.equal(grid.rows[0][5].fg, undefined);
  assert.equal(grid.rows[0][5].bold, true);
});

test('candidate freeze rejects incomplete build input and output sets before creating evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'durio-redesign-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), installed = join(root, 'installed'); mkdirSync(source); mkdirSync(installed);
  for (const directory of ['src', 'test', 'scripts', 'vendor']) { mkdirSync(join(source, directory)); writeFileSync(join(source, directory, 'fixture'), directory + '\n'); }
  for (const name of ['package.json', 'tsconfig.json']) writeFileSync(join(source, name), '{}\n');
  writeFileSync(join(source, 'package-lock.json'), '{"packages":{}}\n');
  mkdirSync(join(installed, 'dist/src/tui'), { recursive: true }); mkdirSync(join(installed, 'dist/execution/isolation'), { recursive: true });
  writeFileSync(join(installed, 'dist/src/tui/app.js'), 'throw Error("PRODUCT_IMPORTED");\n');
  writeFileSync(join(installed, 'dist/execution/isolation/probe'), 'synthetic\n'); writeFileSync(join(installed, 'dist/execution/package-lock.json'), '{}\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=PREP synthetic test', '-c', 'user.email=prep@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic source']]) assert.equal(spawnSync('git', ['-C', source, ...args]).status, 0);
  const collect = (base: string, paths: string[], lines = false): any[] => paths.flatMap(path => lstatSync(join(base, path)).isDirectory() ? collect(base, readdirSync(join(base, path)).sort().map(name => join(path, name)), lines) : (() => { const bytes = readFileSync(join(base, path)); return [{ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ...(lines ? { physicalLines: bytes.toString().split('\n').length - Number(bytes.at(-1) === 10) } : {}) }]; })());
  const build = { version: 1, inputs: collect(source, ['src', 'test', 'scripts', 'vendor', 'package.json', 'package-lock.json', 'tsconfig.json'], true), compiler: [], outputs: collect(installed, ['dist/src', 'dist/execution/package-lock.json', 'dist/execution/isolation']) };
  const path = join(installed, 'dist/execution/source-build.json'), args = ['--source', source, '--package', installed, '--out'];
  writeFileSync(path, JSON.stringify(build));
  assert.equal(command('prepare.mjs', [...args, join(root, 'valid')]).status, 0);
  writeFileSync(path, JSON.stringify({ ...build, inputs: build.inputs.slice(1) }));
  assert.match(command('prepare.mjs', [...args, join(root, 'missing-input')]).stderr, /SOURCE_BUILD_INPUTS_CHANGED/);
  writeFileSync(path, JSON.stringify({ ...build, outputs: build.outputs.slice(1) }));
  assert.match(command('prepare.mjs', [...args, join(root, 'missing-output')]).stderr, /SOURCE_BUILD_OUTPUTS_CHANGED/);
  writeFileSync(path, JSON.stringify(build)); writeFileSync(join(installed, 'dist/src/stale.js'), 'stale');
  assert.match(command('prepare.mjs', [...args, join(root, 'extra-output')]).stderr, /SOURCE_BUILD_OUTPUTS_CHANGED/);
});
