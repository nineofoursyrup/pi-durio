#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runReadTask, runCodingTask, readRun, type ToolEnvironmentConfig } from './runtime.js';
import { demoTransport } from './offline.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: 'string' }, 'data-root': { type: 'string' }, prompt: { type: 'string' },
    run: { type: 'string' }, 'offline-demo': { type: 'boolean' }, originals: { type: 'boolean' },
    after: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' },
    coding: { type: 'boolean' }, 'tool-env-config': { type: 'string' }
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('pi-durio run --workspace PATH --prompt TEXT [--data-root PATH] [--offline-demo] [--coding] [--tool-env-config PATH]\npi-durio tui --workspace PATH [--data-root PATH] [--offline-demo] (read only)\npi-durio show --run UUID [--data-root PATH] [--originals] [--after SEQ] [--limit N]\nrun defaults to DeepSeek/deepseek-flash at https://api.deepseek.com; DEEPSEEK_API_KEY is required.\n--offline-demo uses a deterministic README.md fixture transport, with no network or model inference.\nDefault run grants read only; --coding explicitly grants read/write/edit/bash for the stated task. Trusted local bash is not an OS sandbox. File tools support files up to 256 KiB; at most 8 provider attempts.\n--tool-env-config supplies JSON {version,variables} for coding only; values are not added to configuration records. Model API keys are not inherited. Old pending work blocks new execution.');
    return;
  }
  const dataRoot = values['data-root'] ?? join(homedir(), 'Library', 'Application Support', 'pi-durio');
  if (command === 'tui') {
    if (values.coding || values['tool-env-config']) throw new Error('USAGE: tui currently grants read only; coding lifecycle is not connected to this entry');
    if (!values.workspace || values.prompt) throw new Error('USAGE: tui requires --workspace; enter requests in the input area');
    const { runTui } = await import('./tui/app.js');
    const exit = await runTui({ dataRoot, workspace: values.workspace, mode: values['offline-demo'] ? 'offline' : 'live', transport: values['offline-demo'] ? demoTransport().fetch : undefined });
    const result = exit.result;
    console.log(JSON.stringify({ tui: 'closed', runId: result?.runId, sessionId: result?.sessionId, status: result?.status ?? 'no-task', cleanup: result?.cleanup, usage: result?.usage.completeness ?? 'unknown', draftSaved: exit.draftSaved, error: exit.error?.slice(0,1024) }));
    if (result) console.log(`Read back: pi-durio show --data-root '${dataRoot.replaceAll("'", "'\\''")}' --run ${result.runId}`);
    process.exitCode = exit.error ? 1 : result?.status === 'unknown' ? 75 : result?.status === 'aborted' ? 130 : result?.status === 'failed' ? 1 : 0;
    return;
  }
  if (command === 'show') {
    if (!values.run) throw new Error('USAGE: show requires --run');
    const page = await readRun(dataRoot, values.run, { after: values.after ? Number(values.after) : undefined, limit: values.limit ? Number(values.limit) : undefined });
    console.log(JSON.stringify(values.originals ? page : { ...page, records: page.records.map(({ seq, kind, at }) => ({ seq, kind, at })) }, null, 2));
    return;
  }
  if (command !== 'run' || !values.prompt || !values.workspace) throw new Error('USAGE: run requires --workspace and --prompt');
  if (values['tool-env-config'] && !values.coding) throw new Error('USAGE: --tool-env-config requires --coding');
  const toolEnvironment: ToolEnvironmentConfig | undefined = values['tool-env-config'] ? JSON.parse(await readFile(values['tool-env-config'], 'utf8')) : undefined;
  const controller = new AbortController();
  let cancellation: 'stop' | 'exit' = 'exit';
  const stop = () => { cancellation = 'stop'; controller.abort(); };
  const exit = () => { cancellation = 'exit'; controller.abort(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', exit);
  try {
    const run = values.coding ? runCodingTask : runReadTask;
    const result = await run({ dataRoot, workspace: values.workspace, input: values.prompt, ...(toolEnvironment ? { toolEnvironment } : {}),
      mode: values['offline-demo'] ? 'offline' : 'live', transport: values['offline-demo'] ? demoTransport().fetch : undefined,
      signal: controller.signal, get cancellation() { return cancellation; } });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'aborted' ? 130 : result.status === 'unknown' ? 75 : 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', exit); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(':')[0].split(' ')[0];
  console.error(JSON.stringify({ error: { code, message } }));
  process.exitCode = code === 'AUTH_MISSING' ? 78 : code === 'OWNER_CONFLICT' ? 73 : code === 'RECOVERY_REQUIRED' ? 75 : 1;
});
