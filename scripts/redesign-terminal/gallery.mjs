import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createFixtures, renderers, load } from './fixtures.mjs';
import { save, screens } from './common.mjs';

/** Human-run native display of the same synthetic renderer inputs as the grids. */
export async function gallery(root, output, screen, tier) {
  if (!screens.includes(screen)) throw Error('UNKNOWN_SCREEN');
  if (process.stdout.columns !== 132 || process.stdout.rows !== 38) throw Error('SCREENSHOT_REQUIRES_132x38');
  const fixture = await createFixtures(root, join(output, 'synthetic-fixture')), renderer = await renderers(root, fixture);
  let lines = await renderer.render(screen, 132, 38, tier);
  writeFileSync(join(output, 'frame.ansi'), lines.join('\n') + '\n', { flag: 'wx' });
  if (screen === '1f') {
    // T7: actual exitSummary output, no painted bg.base or alternate-screen substitution.
    while (lines.at(-1) === '') lines.pop();
    process.stdout.write(lines.join('\n') + '\n'); renderer.close();
    save(join(output, 'gallery.json'), { screen, tier, columns: 132, rows: 38, displayed: true, nativeHumanAcceptance: 'NOT_RUN', widthCalibration: 'NOT_RUN', instruction: 'Capture this original-buffer exit summary with macOS screenshot, then attach it; display is not user acceptance.' });
    return;
  }
  const { ProcessTerminal, TuiAltScreen } = renderer.pi;
  const { TerminalWidthGate } = await load(root, 'dist/src/tui/width-gate.js');
  const terminal = new ProcessTerminal(), tui = new TuiAltScreen(terminal, true);
  let done, failure; const closed = new Promise(resolve => { done = resolve; });
  const key = data => { if (data === '\x03' || data === '\x1b') done(); else if (data === '\x0c') gate.retry(true); else return false; return true; };
  const gate = new TerminalWidthGate({ terminal, tui, sources: () => lines, context: () => `${screen}:${terminal.columns}x${terminal.rows}`, ready: () => { void refresh(); }, priorityInput: key, retain: inputs => { if (inputs.length) failure ??= 'unapplied native input'; } });
  async function refresh() { lines = await renderer.render(screen, terminal.columns, terminal.rows, tier); tui.requestRender(true); }
  tui.setLayoutRoot({ invalidate() {}, render: () => lines });
  tui.addInputListener(data => { key(data); return { consume: true }; });
  const resizeStart = terminal.start.bind(terminal); terminal.start = (input, resize) => resizeStart(input, () => { void refresh(); resize(); });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => { const handler = () => { failure ??= signal; done(); }; process.on(signal, handler); return () => process.off(signal, handler); });
  try { tui.start(); await closed; }
  catch (error) { failure ??= String(error); throw error; }
  finally { for (const remove of signals) remove(); gate.beginClose(); await gate.settle(); tui.stop(); const widthCalibration = gate.snapshot(); gate.dispose(); renderer.close(); save(join(output, 'gallery.json'), { screen, tier, columns: terminal.columns, rows: terminal.rows, displayed: true, failure: failure ?? null, nativeHumanAcceptance: 'NOT_RUN', widthCalibration }); }
}
