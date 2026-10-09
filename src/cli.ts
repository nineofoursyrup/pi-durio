#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runReadTask, runCodingTask, readRun, type ToolEnvironmentConfig } from './runtime.js';
import { writeHeadlessResult } from './headless-lifecycle.js';
import { demoTransport } from './offline.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: 'string' }, 'data-root': { type: 'string' }, prompt: { type: 'string' },
    run: { type: 'string' }, 'offline-demo': { type: 'boolean' }, originals: { type: 'boolean' },
    after: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' },
    coding: { type: 'boolean' }, 'tool-env-config': { type: 'string' }, 'cleanup-timeout-ms': { type: 'string' }
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('pi-durio run --workspace PATH --prompt TEXT [--data-root PATH] [--offline-demo] [--coding] [--tool-env-config PATH] [--cleanup-timeout-ms N]\npi-durio show --run UUID [--data-root PATH] [--originals] [--after SEQ] [--limit N]\nrun defaults to DeepSeek/deepseek-flash at https://api.deepseek.com; DEEPSEEK_API_KEY is required.\n--offline-demo uses a deterministic README.md fixture transport, with no network or model inference.\nDefault run grants read only; --coding explicitly grants read/write/edit/bash for the stated task. Trusted local bash is not an OS sandbox. File tools support files up to 256 KiB; at most 8 provider attempts.\n--tool-env-config supplies JSON {version,variables} for coding only; values are not added to configuration records. Model API keys are not inherited. Old pending work blocks new execution.\nSIGINT persists stop intent; SIGTERM exits and preserves unfinished work. The first intent is retained. Both show processing and await cleanup (default 10000 ms); timeout leaves unknown and owner evidence for recovery. Cancellation does not undo changes or refund costs.');
    return;
  }
  const dataRoot = values['data-root'] ?? join(homedir(), 'Library', 'Application Support', 'pi-durio');
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
  const stop = () => { if (!controller.signal.aborted) { cancellation = 'stop'; controller.abort(); } };
  const exit = () => { if (!controller.signal.aborted) { cancellation = 'exit'; controller.abort(); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', exit);
  try {
    const run = values.coding ? runCodingTask : runReadTask;
    const result = await run({ dataRoot, workspace: values.workspace, input: values.prompt, ...(toolEnvironment ? { toolEnvironment } : {}),
      mode: values['offline-demo'] ? 'offline' : 'live', transport: values['offline-demo'] ? demoTransport().fetch : undefined,
      signal: controller.signal, get cancellation() { return cancellation; },
      cleanupTimeoutMs: values['cleanup-timeout-ms'] === undefined ? undefined : Number(values['cleanup-timeout-ms']),
      onObservation: event => { if (event.kind === 'lifecycle.processing') console.error(JSON.stringify({ runId: event.runId, state: 'processing', action: cancellation })); } });
    writeHeadlessResult(result);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', exit); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(':')[0].split(' ')[0];
  console.error(JSON.stringify({ error: { code, message } }));
  process.exitCode = code === 'AUTH_MISSING' ? 78 : code === 'OWNER_CONFLICT' ? 73 : code === 'RECOVERY_REQUIRED' ? 75 : code === 'RUN_CANCELLED_BEFORE_ACCEPTANCE' ? 130 : 1;
});
