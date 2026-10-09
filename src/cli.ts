#!/usr/bin/env node
import { readCompactions } from './compaction.js';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { runReadTask, runCodingTask, compactContext, readRun, readQueue, checkQueue, decideQueue, TaskControl, inspectRecovery, checkRecovery, recoverRun, settleRecoveryOwners, type ToolEnvironmentConfig, type RecoveryAuthorization } from './runtime.js';
import { writeHeadlessResult, exitHostIfUnconfirmed } from './headless-lifecycle.js';
import { demoTransport } from './offline.js';
import { historyCommand } from './history-cli.js';
import { improveCommand } from './improve-cli.js';
import { evalCommand } from './eval/cli.js';
import { metricsCommand } from './metrics/cli.js';
import { storageCommand } from './storage-cli.js';

function lifecycleSignals() {
  const controller=new AbortController();let intent:'stop'|'exit'='exit';
  const stop=()=>{if(!controller.signal.aborted){intent='stop';controller.abort();}},exit=()=>{if(!controller.signal.aborted){intent='exit';controller.abort();}};
  process.on('SIGINT',stop);process.on('SIGTERM',exit);
  return {signal:controller.signal,get cancellation(){return intent;},close(){process.off('SIGINT',stop);process.off('SIGTERM',exit);}};
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    spec: { type: 'string' }, directory: { type: 'string' }, workspace: { type: 'string' }, 'data-root': { type: 'string' }, prompt: { type: 'string' },
    run: { type: 'string' }, 'context-run':{type:'string'}, 'offline-demo': { type: 'boolean' }, originals: { type: 'boolean' },
    after: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' },
    coding: { type: 'boolean' }, 'tool-env-config': { type: 'string' }, 'cleanup-timeout-ms': { type: 'string' },
    filter: { type: 'string' }, cursor: { type: 'string' }, snapshot: { type: 'string' }, evidence: { type: 'string' },
    offset: { type: 'string' }, format: { type: 'string' }, decoded: { type: 'boolean' }, id: { type: 'string' },
    purpose: { type: 'string' }, dependencies: { type: 'string' }, destination: { type: 'string' }, price: { type: 'string' }, 'max-bytes': { type: 'string' },
    authorization: { type: 'string' }, decision: { type: 'string' }, inspect: { type: 'boolean' },
    units: {type:'string'}, reason:{type:'string'}, confirm:{type:'string'}, scope:{type:'string'}, objects:{type:'string'}, archive:{type:'string'}, backup:{type:'string'}
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('pi-durio run --workspace PATH --prompt TEXT [--data-root PATH] [--offline-demo] [--coding] [--tool-env-config PATH] [--cleanup-timeout-ms N]\npi-durio tui --workspace PATH [--data-root PATH] [--offline-demo] [--coding] [--run UUID]\npi-durio show --run UUID [--data-root PATH] [--originals] [--after SEQ] [--limit N]\nrun defaults to DeepSeek/deepseek-flash at https://api.deepseek.com; DEEPSEEK_API_KEY is required.\n--offline-demo uses a deterministic README.md fixture transport, with no network or model inference.\nDefault run grants read only; --coding explicitly grants read/write/edit/bash for the stated task. Trusted local bash is not an OS sandbox. File tools support files up to 256 KiB; at most 8 provider attempts.\n--tool-env-config supplies JSON {version,variables} for coding only; values are not added to configuration records. Model API keys are not inherited. Old pending work blocks new execution.\nSIGINT persists stop intent; SIGTERM exits and preserves unfinished work. The first intent is retained. Both show processing and await cleanup (default 10000 ms); timeout leaves unknown and owner evidence for recovery. Cancellation does not undo changes or refund costs.');
    console.log('pi-durio recover --run UUID [--data-root PATH] [--inspect] [--authorization FILE] [--decision FILE] [--offline-demo]\n--inspect reads facts without changing source databases. Default recover saves a separate report and exits 75 when input is needed. Authorization JSON declares {workspace,mode,tools,toolEnvironment?}; decision JSON binds {id,snapshotId,action,acceptAdditionalModelAttempts?,resolutions?}. Actions: continue, end, confirm-cleanup. A decision never changes the original unknown facts.\npi-durio control --workspace PATH --prompt TEXT [--coding] [--offline-demo]: NDJSON stdin controls; ready event supplies immutable target. Inputs {action:steer|follow-up|compact|improve,id,input,target}; withdrawal {action:withdraw,decision:{id,requestId,action:withdraw,target,receiptSeq}}; {action:stop|exit}.\npi-durio queue [--inspect] [--data-root PATH] [--run SOURCE_UUID --decision FILE --authorization FILE --offline-demo]: readonly inspect or saved recovery/queue decisions; unresolved queue exits 75.\npi-durio tui --workspace PATH [--coding] [--run UUID]: coding uses the same runtime; --run opens recovery facts without auto continuation.');
    console.log('pi-durio compact --run UUID --id REQUEST_ID --authorization FILE [--data-root PATH] [--offline-demo]; compact --inspect --run UUID is read-only. Compaction retains originals and records generation separately from application. run --context-run UUID imports a verified completed context into a new independent task.');
    console.log('Improve: improve analyze --spec FILE [--offline-demo]; improve list; improve report --id ID [--format text]. Spec explicitly declares workspace, targetRunId, mode and request {id,purpose,limits:{maxRequests,maxTokens,maxRequestTokens,maxDurationMs,maxOutputTokens},sources?}. Analysis only; no candidates selected or executed. Missing limits block before dispatch. Reports and lists are read-only. TUI /improve JSON uses the same request; /improves opens reports. Selection: improve preview|submit --spec FILE; improve decision --id ID; improve continue --spec FILE; improve suppressions; improve restore-suggestion --spec FILE. TUI /improve-select JSON starts unselected and requires aggregate submission. Execute-declared-scope requires explicit formal writeback/activation scope; project/config/prompt/skill are supported. improve defaults --workspace PATH reads current project defaults; improve rollback --spec FILE explicitly restores unchanged batch bytes and subsequent defaults.');
    console.log('Eval: eval plan --spec FILE; eval run --id PLAN --directory NEW_DIR; eval report --id PLAN [--format text|json]; eval grade --id PLAN --spec REVISION --directory NEW_DIR; eval list. All accept --data-root. Plans fix runtime/fixtures/graders, ordering, deadline, request/token budgets and price before execution. Offline controlled provider is explicit; live plans require a paid authorization and proven request token bound.');
    console.log('History: history --filter JSON [--cursor JSON]; evidence --run ID or --evidence ID [--offset N --limit N --decoded]; trace --run ID; usage --run IDs; derive --run IDs --evidence IDs --purpose TEXT; export adds --destination FILE; fix --id ID --evidence IDs --purpose TEXT [--dependencies IDs]; fixed --evidence ID; estimate --id ID --run IDs --price JSON. All accept --data-root and --format json|text. Only fix/estimate write management facts; export requires an explicit new destination. Queries never execute.');
    console.log('Metrics: metrics --scope JSON [--snapshot SEQ --format json|text --destination NEW_FILE]; acceptance --spec JSON_FILE. Scope: {from,to,asOf,project,taskType,version,source}. Ordinary coding is the default; synthetic/diagnostic sources are explicit and separate. Reports are read-only. Acceptance inputs append requirements/results/judgments/withdrawals/disputes with original evidence and explicit human or actual-check sources; no required feedback or model grading.');
    console.log('Storage: storage usage; storage preview --id ID --units session:ID,object:SHA --reason TEXT; storage commit --id ID --confirm PREVIEW_IDENTITY; storage status --id ID; storage archive --scope whole-root|attachments [--objects SHAS] --destination NEW_PATH; storage restore --archive PATH --destination NEW_PATH; storage verify --archive PATH; storage migrate --backup NEW_ARCHIVE_PATH --destination NEW_ROOT; storage unfix --id ID --evidence FIXED_ID --reason TEXT. All accept --data-root and --format json|text. Whole-root archive includes every project. Archive/migrate retain the source; cleanup requires its own preview and explicit commit.');
    return;
  }
  const dataRoot = values['data-root'] ?? join(homedir(), 'Library', 'Application Support', 'pi-durio');
  if(metricsCommand(command,dataRoot,values))return;
  if(command==='improve'){await improveCommand(positionals[1],dataRoot,values);return;}
  if(command==='eval'){await evalCommand(positionals[1],dataRoot,values);return;}
  if (await storageCommand(command,positionals[1],dataRoot,values)) return;
  if (await historyCommand(command, dataRoot, values)) return;
  if (command === 'tui') {
    if (!values.workspace || values.prompt) throw new Error('USAGE: tui requires --workspace; enter requests in the input area');
    if(values['tool-env-config']&&!values.coding)throw Error('USAGE: --tool-env-config requires --coding');
    const toolEnvironment=values['tool-env-config']?JSON.parse(await readFile(values['tool-env-config'],'utf8')):undefined;
    const { runTui } = await import('./tui/app.js');
    const exit = await runTui({ dataRoot, workspace: values.workspace, mode: values['offline-demo'] ? 'offline' : 'live', transport: values['offline-demo'] ? demoTransport().fetch : undefined,coding:values.coding,toolEnvironment,runId:values.run });
    const result = exit.result;
    console.log(JSON.stringify({ tui: 'closed', runId: result?.runId, sessionId: result?.sessionId, status: result?.status ?? 'no-task', cleanup: result?.cleanup, usage: result?.usage.completeness ?? 'unknown', draftSaved: exit.draftSaved, error: exit.error?.slice(0,1024) }));
    if (result) console.log(`Read back: pi-durio show --data-root '${dataRoot.replaceAll("'", "'\\''")}' --run ${result.runId}`);
    process.exitCode = exit.error ? 1 : result?.status === 'unknown' ? 75 : result?.status === 'aborted' ? 130 : result?.status === 'failed' ? 1 : result?.controls?.exitCode??0;
    exitHostIfUnconfirmed(result);
    return;
  }
  if(command==='compact'){
    if(!values.run)throw Error('USAGE: compact requires --run');
    if(values.inspect){console.log(JSON.stringify(readCompactions(dataRoot,values.run,{after:values.after?Number(values.after):undefined,limit:values.limit?Number(values.limit):undefined}),null,2));return;}
    if(!values.id||!values.authorization)throw Error('USAGE: compact requires --id and --authorization');
    const authorization=JSON.parse(await readFile(values.authorization,'utf8')),lifecycle=lifecycleSignals();
    let result;try{result=await compactContext({dataRoot,runId:values.run,requestId:values.id,authorization,transport:values['offline-demo']?demoTransport().fetch:undefined,signal:lifecycle.signal,get cancellation(){return lifecycle.cancellation;}});}finally{lifecycle.close();}
    console.log(JSON.stringify({compaction:result.compaction??null,runId:result.runId,status:result.status,cleanup:result.cleanup,usage:result.usage}));process.exitCode=result.status==='completed'?0:result.status==='unknown'?75:result.status==='aborted'?130:1;exitHostIfUnconfirmed(result);return;
  }
  if(command==='queue') {
    if(values.inspect&&values.decision)throw Error('USAGE: --inspect cannot execute a decision');
    if(values.inspect){console.log(JSON.stringify(readQueue(dataRoot,{after:values.after?Number(values.after):undefined,limit:values.limit?Number(values.limit):undefined,targetRunId:values.run}),null,2));return;}
    if(!values.decision){const report=await checkQueue(dataRoot);console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode;return;}
    if(!values.run)throw Error('USAGE: queue decision requires original --run');
    const decision=JSON.parse(await readFile(values.decision,'utf8'));
    const authorization=values.authorization?JSON.parse(await readFile(values.authorization,'utf8')):undefined;
    const lifecycle=lifecycleSignals();
    let result;try{result=await decideQueue({dataRoot,runId:values.run,decision,authorization,transport:values['offline-demo']?demoTransport().fetch:undefined,signal:lifecycle.signal,get cancellation(){return lifecycle.cancellation;}});}finally{lifecycle.close();}
    if('usage' in result)writeHeadlessResult(result);else {console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='frozen'||result.status==='dispatching'?75:0;}
    return;
  }
  if (command === 'show') {
    if (!values.run) throw new Error('USAGE: show requires --run');
    const page = await readRun(dataRoot, values.run, { after: values.after ? Number(values.after) : undefined, limit: values.limit ? Number(values.limit) : undefined });
    console.log(JSON.stringify(values.originals ? page : { ...page, records: page.records.map(({ seq, kind, at }) => ({ seq, kind, at })) }, null, 2));
    return;
  }
  if (command === 'recover') {
    if (!values.run || values.inspect && values.decision) throw new Error('USAGE: recover requires --run; --inspect cannot execute a decision');
    const authorization: RecoveryAuthorization|undefined = values.authorization ? JSON.parse(await readFile(values.authorization,'utf8')) : undefined;
    const decision = values.decision ? JSON.parse(await readFile(values.decision,'utf8')) : undefined;
    const options = {dataRoot,runId:values.run,authorization};
    if (decision && decision.action !== 'confirm-cleanup' && decision.action !== 'end' && authorization?.mode === 'offline' && !values['offline-demo']) throw new Error('OFFLINE_TRANSPORT_REQUIRED: --offline-demo is an explicit fixture, not a live model');
    const lifecycle=lifecycleSignals();let result;
    try {result = values.inspect ? await inspectRecovery(options) : !decision ? await checkRecovery(options) : decision.action === 'confirm-cleanup' ? await settleRecoveryOwners({...options,decision}) : await recoverRun({...options,decision,transport:values['offline-demo']?demoTransport().fetch:undefined,signal:lifecycle.signal,get cancellation(){return lifecycle.cancellation;}});}
    finally{lifecycle.close();}
    if ('exitCode' in result) { console.log(JSON.stringify(result,null,2)); process.exitCode=result.exitCode; }
    else writeHeadlessResult(result);
    return;
  }
  if (!['run','control'].includes(command) || !values.prompt || !values.workspace) throw new Error('USAGE: run/control requires --workspace and --prompt');
  if (values['tool-env-config'] && !values.coding) throw new Error('USAGE: --tool-env-config requires --coding');
  const toolEnvironment: ToolEnvironmentConfig | undefined = values['tool-env-config'] ? JSON.parse(await readFile(values['tool-env-config'], 'utf8')) : undefined;
  const controller = new AbortController();
  let cancellation: 'stop' | 'exit' = 'exit';
  const stop = () => { if (!controller.signal.aborted) { cancellation = 'stop'; controller.abort(); } };
  const exit = () => { if (!controller.signal.aborted) { cancellation = 'exit'; controller.abort(); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', exit);
  const control=command==='control'?new TaskControl():undefined;
  const input=control?createInterface({input:process.stdin,terminal:false}):undefined;
  let controlLine=Promise.resolve();
  input?.on('line',line=>{controlLine=controlLine.then(async()=>{
    try {
      const request=JSON.parse(line);
      if(request.action==='stop'){stop();return;}
      if(request.action==='exit'){exit();return;}
      const receipt=request.action==='cancel-compact'?await control!.cancelCompaction(request.decision):request.action==='withdraw'?await control!.withdraw(request.decision):await control!.submit({id:request.id,kind:request.action,input:request.input,target:request.target});
      console.log(JSON.stringify({control:receipt}));
    }catch(error){console.log(JSON.stringify({controlError:String(error)}));}
  });});
  try {
    const run = values.coding ? runCodingTask : runReadTask;
    const result = await run({ dataRoot, contextRunId:values['context-run'],workspace: values.workspace, input: values.prompt, ...(toolEnvironment ? { toolEnvironment } : {}),
      mode: values['offline-demo'] ? 'offline' : 'live', transport: values['offline-demo'] ? demoTransport().fetch : undefined,control,
      signal: controller.signal, get cancellation() { return cancellation; },
      cleanupTimeoutMs: values['cleanup-timeout-ms'] === undefined ? undefined : Number(values['cleanup-timeout-ms']),
      onObservation: event => { if (event.kind === 'lifecycle.processing') console.error(JSON.stringify({ runId: event.runId, state: 'processing', action: cancellation }));if(event.kind==='control.ready')console.log(JSON.stringify({ready:control?.target()})); } });
    if(control){await controlLine;console.log(JSON.stringify({result}));process.exitCode=result.status==='completed'?result.controls?.exitCode??0:result.status==='aborted'?130:result.status==='unknown'?75:1;exitHostIfUnconfirmed(result);}else writeHeadlessResult(result);
  } finally {input?.close();process.off('SIGINT', stop); process.off('SIGTERM', exit); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(':')[0].split(' ')[0];
  console.error(JSON.stringify({ error: { code, message } }));
  process.exitCode = code === 'AUTH_MISSING' ? 78 : code === 'OWNER_CONFLICT' ? 73 : /RECOVERY|DECISION|OWNER_(STILL|CHANGED|IDENTITY|HOST)/.test(code) ? 75 : code === 'RUN_CANCELLED_BEFORE_ACCEPTANCE' ? 130 : 1;
});
