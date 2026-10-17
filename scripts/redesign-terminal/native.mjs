#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyManifest } from './verify.mjs';
import { save, sha256, templates, newOutputPath } from './common.mjs';
import { load } from './fixtures.mjs';
import { assessNative } from './assess.mjs';
const { values } = parseArgs({ options: { manifest: { type: 'string' }, output: { type: 'string' }, 'verify-only': { type: 'boolean' }, tier: { type: 'string' }, screen: { type: 'string' } } });
if (!values.manifest) throw Error('MANIFEST_REQUIRED');
const manifest = verifyManifest(values.manifest);
if (values['verify-only']) { console.log(JSON.stringify({ verified: true, candidate: manifest.candidate, nativeAcceptance: 'NOT_RUN' })); process.exit(0); }
if (manifest.synthetic) throw Error('SYNTHETIC_MANIFEST_NOT_NATIVE');
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.TERM_PROGRAM !== 'Apple_Terminal' || !process.stdin.isTTY || !process.stdout.isTTY) throw Error('REAL_MACOS_TERMINAL_REQUIRED');
if (!values.output) throw Error('NEW_OUTPUT_REQUIRED');
if (manifest.runtime.node !== process.version || manifest.runtime.platform !== process.platform || manifest.runtime.arch !== process.arch) throw Error('FROZEN_RUNTIME_CHANGED');
if (!['truecolor', '256color', 'none'].includes(values.tier)) throw Error('EXPECTED_COLOR_TIER_REQUIRED');
const root = manifest.installation.root, output = newOutputPath(values.output, [manifest.source.root, root, manifest.harness.root]);
const { detectColorTier } = await load(root, 'dist/src/tui/theme.js');
const tier = detectColorTier();
if (tier !== values.tier) throw Error('COLOR_ENVIRONMENT_MISMATCH');
mkdirSync(output, { mode: 0o700 });
const binding = { candidate: manifest.candidate, manifestSha256: sha256(readFileSync(values.manifest)), executionVersion: { sourceBuildSha256: manifest.source.sourceBuildSha256, node: process.version, installationManifestSha256: sha256(JSON.stringify(manifest.installation.files)) } };
const environment = { at: new Date().toISOString(), ...binding, platform: process.platform, arch: process.arch, node: process.version, TERM: process.env.TERM ?? null, TERM_PROGRAM: process.env.TERM_PROGRAM, TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION ?? null, COLORTERM: process.env.COLORTERM ?? null, NO_COLOR: process.env.NO_COLOR ?? null, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows, tier, scope: values.screen ? 'native-synthetic-gallery' : 'native-offline-product-interaction', screen: values.screen ?? null };
save(join(output, 'environment.json'), environment);
save(join(output, 'operator-checklist.json'), { ...templates()['operator-checklist.json'], ...binding });
if (values.screen) {
  const { gallery } = await import('./gallery.mjs');
  await gallery(root, output, values.screen, tier);
  process.exit(0);
}
console.log('本次仅 offline transport，不调用模型/VM。按 README 的顺序测试空输入 ?、probe?、PgUp/PgDn；提交一个任意测试请求，排队两项 follow-up，然后两次 Backspace（间隔 200–400ms）。缩放到 132×38、80×24、40×12。最后 /exit 或空闲 Ctrl+C 两次退出。不要输入私人资料。');
const { ReadOnlyTui } = await load(root, 'dist/src/tui/app.js');
const { ProcessTerminal, stripTerminalSequences } = await load(root, 'node_modules/@earendil-works/pi-tui/dist/index.js');
const { readOpenQueue } = await load(root, 'dist/src/queue.js');
const workspace = join(output, 'project'), dataRoot = join(output, 'data'); mkdirSync(workspace);
writeFileSync(join(workspace, 'README.md'), 'Synthetic native interaction fixture\n', { flag: 'wx' });
const stty = () => { const result = spawnSync('/bin/stty', ['-g'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null; };
const before = { raw: !!process.stdin.isRaw, stty: stty(), columns: process.stdout.columns, rows: process.stdout.rows };
save(join(output, 'before.json'), before);
writeFileSync(join(output, 'events.jsonl'), '', { flag: 'wx', mode: 0o600 });
writeFileSync(join(output, 'terminal-output.ansi'), '', { flag: 'wx', mode: 0o600 });
const events = [], timers = new Set(); let app, sequence = 0, terminalOutput = '', result, failure, during;
const append = event => { events.push(event); appendFileSync(join(output, 'events.jsonl'), JSON.stringify(event) + '\n'); };
const snapshot = () => {
  let screen = [], queue = null; const errors = [];
  try { screen = app.screen().map(stripTerminalSequences); } catch (error) { errors.push(`screen: ${String(error)}`); }
  try { queue = readOpenQueue(dataRoot, workspace).filter(q => q.item.status === 'pending').map(q => q.item.requestId); } catch (error) { errors.push(`queue: ${String(error)}`); }
  // An unopened queue store on the welcome screen must not erase a valid help observation.
  return { screen, queue, errors };
};
const terminal = new ProcessTerminal(), originalStart = terminal.start.bind(terminal);
terminal.start = (input, resize) => originalStart(data => {
  const ordinal = ++sequence, event = { kind: 'input', ordinal, at: new Date().toISOString(), ms: performance.now(), data, before: snapshot(), settled: false };
  append({ kind: 'received', ordinal, at: event.at, ms: event.ms, data });
  input(data);
  const timer = setTimeout(() => { timers.delete(timer); event.settled = ordinal === sequence; event.after = snapshot(); append(event); }, 120); timers.add(timer);
}, () => { sequence++; append({ kind: 'resize', columns: terminal.columns, rows: terminal.rows, at: new Date().toISOString() }); resize(); });
const transport = async (_url, init) => new Response(new ReadableStream({ start(stream) {
  let counter = 0, ended = false;
  const finish = () => { if (ended) return; ended = true; clearInterval(timer); timers.delete(timer); stream.error(Error('synthetic native stream cancelled')); };
  const timer = setInterval(() => { if (ended) return; stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'native-synthetic', model: 'deepseek-flash-offline-fixture', choices: [{ index: 0, delta: { content: `合成输出 ${++counter} · 中文 👩‍💻 é\n` }, finish_reason: null }] })}\n\n`)); }, 1000); timers.add(timer);
  init.signal.addEventListener('abort', finish, { once: true }); if (init.signal.aborted) finish();
} }), { headers: { 'content-type': 'text/event-stream' } });
const originalWrite = process.stdout.write;
process.stdout.write = function (...args) { const bytes = typeof args[0] === 'string' ? args[0] : Buffer.from(args[0]).toString('utf8'); terminalOutput += bytes; appendFileSync(join(output, 'terminal-output.ansi'), bytes); return originalWrite.apply(this, args); };
try { app = new ReadOnlyTui({ workspace, dataRoot, mode: 'offline', coding: false, transport, terminal, draftRoot: join(output, 'drafts') }); app.start(); during = { raw: !!process.stdin.isRaw }; result = await app.closed; failure = result?.error; if (result?.summary) process.stdout.write(result.summary.join('\n') + '\n'); }
catch (error) { failure = String(error); }
finally { try { if (app) await app.exit(); } catch (error) { failure ??= String(error); } for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } process.stdout.write = originalWrite; }
const after = { raw: !!process.stdin.isRaw, stty: stty(), columns: process.stdout.columns, rows: process.stdout.rows };
save(join(output, 'after.json'), after); save(join(output, 'result.json'), { ...binding, result: result ?? null, during: during ?? null, failure: failure ?? null, paidProvider: 'NOT_RUN' });
save(join(output, 'machine-checklist.json'), { ...binding, firstFailure: failure ?? null, ...assessNative({ environment, expectedTier: values.tier, events: events.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)), before, during, after, result, output: terminalOutput }) });
console.log(`证据：${output}\n机器结果与人工观察分别记录；没有观察的项目保持 NOT_RUN。`);
if (failure) process.exitCode = 1;
