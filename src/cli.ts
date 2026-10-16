#!/usr/bin/env node
import { readCompactions } from './compaction.js';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runReadTask, runCodingTask, compactContext, readRun, readQueue, checkQueue, decideQueue, TaskControl, readRecoveryDetail, inspectRecovery, checkRecovery, recoverRun, settleRecoveryOwners, type ToolEnvironmentConfig, type RecoveryAuthorization } from './runtime.js';
import { writeHeadlessResult, exitHostIfUnconfirmed } from './headless-lifecycle.js';
import { demoTransport } from './offline.js';
import { historyCommand } from './history-cli.js';
import { improveCommand } from './improve-cli.js';
import { evalCommand } from './eval/cli.js';
import { metricsCommand } from './metrics/cli.js';
import { storageCommand } from './storage-cli.js';
import { resolveDisplayInput, readDisplayIndex, DisplayInputError } from './display-number.js';
import { readSessionChains } from './session-chain.js';
import { readContinuation } from './continuation.js';
import { estimateRunRequests, costTotalsView } from './cost-estimate.js';

function lifecycleSignals() {
  const controller=new AbortController();let intent:'stop'|'exit'='exit';
  const stop=()=>{if(!controller.signal.aborted){intent='stop';controller.abort();}},exit=()=>{if(!controller.signal.aborted){intent='exit';controller.abort();}};
  process.on('SIGINT',stop);process.on('SIGTERM',exit);
  return {signal:controller.signal,get cancellation(){return intent;},close(){process.off('SIGINT',stop);process.off('SIGTERM',exit);}};
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    spec: { type: 'string' }, directory: { type: 'string' }, workspace: { type: 'string' }, 'data-root': { type: 'string' }, prompt: { type: 'string' },
    run: { type: 'string' }, trace: { type: 'boolean' }, 'context-run':{type:'string'}, 'offline-demo': { type: 'boolean' }, originals: { type: 'boolean' },
    after: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' },
    coding: { type: 'boolean' }, 'read-only': { type: 'boolean' }, 'tool-env-config': { type: 'string' }, 'cleanup-timeout-ms': { type: 'string' },
    filter: { type: 'string' }, cursor: { type: 'string' }, snapshot: { type: 'string' }, evidence: { type: 'string' },
    offset: { type: 'string' }, format: { type: 'string' }, decoded: { type: 'boolean' }, id: { type: 'string' },
    purpose: { type: 'string' }, dependencies: { type: 'string' }, destination: { type: 'string' }, price: { type: 'string' }, 'max-bytes': { type: 'string' },
    authorization: { type: 'string' }, decision: { type: 'string' }, inspect: { type: 'boolean' },
    units: {type:'string'}, reason:{type:'string'}, confirm:{type:'string'}, scope:{type:'string'}, objects:{type:'string'}, archive:{type:'string'}, backup:{type:'string'}
  } });
  const command = positionals[0];
  if (values.help) {
    console.log('pi-durio [--workspace PATH] [--read-only] [--data-root PATH] [--offline-demo] [--tool-env-config PATH]\nWithout a command, opens the TUI in the current directory (or --workspace). The interactive entry grants coding (read/write/edit/bash); --read-only narrows it to read. The writer lock is taken only when a task or recovery decision is accepted.\npi-durio resume [<s-号|session UUID>] [--data-root PATH] [--offline-demo] [--tool-env-config PATH]: opens the TUI at the session tail. A tail awaiting recovery opens the recovery panel without continuing; a completed tail continues on the next Enter (any execution version); otherwise the tail is shown read-only with the reason. The workspace comes from the session record and the authorization from the tail run (no --coding/--read-only). r- numbers are rejected with their session number. Without a number, lists the sessions of the current workspace. No lock is taken at startup.\npi-durio show <s-号|r-号> [--trace] [--format json|text] [--data-root PATH] [--originals] [--after SEQ] [--limit N]: without --format opens a read-only TUI (no lock, no scheduling; s- opens the session, r- the task); outside a terminal --format is required. --format prints the recorded run (s- takes the tail run); --trace --format equals history trace.\npi-durio run --workspace PATH --prompt TEXT [--data-root PATH] [--offline-demo] [--coding] [--tool-env-config PATH] [--cleanup-timeout-ms N]\n--run and --context-run accept a full run UUID or its display number (r-xxxx); eval run/report/grade --id accepts ep-xxxx, improve report --id accepts ir-xxxx and queue/control decision requestId accepts q-xxxx; an ambiguous display number is rejected with its candidates.\nrun defaults to DeepSeek/deepseek-flash at https://api.deepseek.com; DEEPSEEK_API_KEY is required.\n--offline-demo uses a deterministic README.md fixture transport, with no network or model inference.\nHeadless run grants read only by default; --coding explicitly grants read/write/edit/bash for the stated task. Trusted local bash is not an OS sandbox. File tools support files up to 256 KiB; at most 8 provider attempts.\n--tool-env-config supplies JSON {version,variables} for coding only; values are not added to configuration records. Model API keys are not inherited. Old pending work blocks new execution.\nSIGINT persists stop intent; SIGTERM exits and preserves unfinished work. The first intent is retained. Both show processing and await cleanup (default 10000 ms); timeout leaves unknown and owner evidence for recovery. Cancellation does not undo changes or refund costs.');
    console.log('pi-durio recover <r-号|s-号> [--data-root PATH] [--inspect] [--authorization FILE] [--decision FILE] [--offline-demo]\ns- takes the derived session tail; full run/session identities are also accepted. Legacy --run UUID|r-号 remains supported instead of the positional target.\n--inspect reads facts without changing source databases. Detail pages: --after OFFSET --limit N (max 32) --snapshot ID. Original entry JSON: --inspect --snapshot ID --evidence ENTRY_ID|task:TASK_ID [--offset N --limit N] (max 4096 UTF-16 code units). Default recover saves a separate report and exits 75 when input is needed. Authorization JSON declares {workspace,mode,tools,toolEnvironment?}; decision JSON binds {id,snapshotId,action,acceptAdditionalModelAttempts?,resolutions?}. Actions: continue, end, confirm-cleanup. A decision never changes the original unknown facts.\npi-durio control --workspace PATH --prompt TEXT [--coding] [--offline-demo]: NDJSON stdin controls; ready event supplies immutable target. Inputs {action:steer|follow-up|compact|improve,id,input,target}; withdrawal {action:withdraw,decision:{id,requestId,action:withdraw,target,receiptSeq}}; {action:stop|exit}.\npi-durio queue [--inspect] [--data-root PATH] [--run SOURCE_UUID --decision FILE --authorization FILE --offline-demo]: readonly inspect or saved recovery/queue decisions; unresolved queue exits 75.');
    console.log('pi-durio compact --run UUID --id REQUEST_ID --authorization FILE [--data-root PATH] [--offline-demo]; compact --inspect --run UUID is read-only. Compaction retains originals and records generation separately from application. run --context-run UUID imports a completed context into a new independent task; the new task runs on the current execution version.');
    console.log('Improve: improve analyze --spec FILE [--offline-demo]; improve list; improve report --id ID [--format text]. Spec explicitly declares workspace, targetRunId, mode and request {id,purpose,limits:{maxRequests,maxTokens,maxRequestTokens,maxDurationMs,maxOutputTokens},sources?}. Analysis only; no candidates selected or executed. Missing limits block before dispatch. Reports and lists are read-only. TUI /improve opens the improve view; /improve new opens an analysis confirmation; /improve history opens reports. Selection: improve preview|submit --spec FILE; improve decision --id ID; improve continue --spec FILE; improve suppressions; improve restore-suggestion --spec FILE. TUI /improve ir-号 opens selection; typed mode options only prefill the aggregate confirmation. Execute-declared-scope requires explicit formal writeback/activation scope; project/config/prompt/skill, registered self-source builds and independent eval assets are supported. improve defaults --workspace PATH reads current project defaults; improve rollback --spec FILE explicitly restores unchanged batch bytes and subsequent defaults. improve build-default --workspace PATH reads the selected future entry; improve launch --spec FILE explicitly starts a new build process. improve assets --id ID reads independent asset revisions; improve regrade --spec FILE applies a selected grader to saved outcomes on both sides.');
    console.log('Eval: eval plan --spec FILE; eval run <ep-号|PLAN> [--directory NEW_DIR]; eval report <ep-号|PLAN> [--format text|json]; eval grade <ep-号|PLAN> --spec REVISION [--directory NEW_DIR]; eval list. All accept --data-root. Plans fix runtime/fixtures/graders, ordering, deadline, request/token budgets and price before execution. Offline controlled provider is explicit; live plans require a paid authorization and proven request token bound.');
    console.log('History: history --filter JSON [--cursor JSON]; evidence --run ID or --evidence ID [--offset N --limit N --decoded]; trace --run ID; usage --run IDs; derive --run IDs --evidence IDs --purpose TEXT; export adds --destination FILE; fix --id ID --evidence IDs --purpose TEXT [--dependencies IDs]; fixed --evidence ID; estimate --id ID --run IDs --price JSON. All accept --data-root and --format json|text. Only fix/estimate write management facts; export requires an explicit new destination. Queries never execute.');
    console.log('Metrics: metrics --scope JSON [--snapshot SEQ --format json|text --destination NEW_FILE]; operations / feedback-report use the same scope/format/export options; acceptance / cost-estimate / feedback --spec JSON_FILE. TUI /stats: o costs/faults, f intervention/rework. Scope: {from,to,asOf,project,taskType,version,source}. Ordinary coding is the default; synthetic/diagnostic sources are explicit and separate. Reports are read-only. Acceptance inputs append requirements/results/judgments/withdrawals/disputes with original evidence and explicit human or actual-check sources; no required feedback or model grading.');
    console.log('Storage: storage usage; storage preview --id ID --units session:ID|s-NUMBER,object:SHA --reason TEXT (s-NUMBER selects every session store of that session); storage commit --id ID --confirm PREVIEW_IDENTITY; storage status --id ID; storage archive --scope whole-root|attachments [--objects SHAS] --destination NEW_PATH; storage restore --archive PATH --destination NEW_PATH; storage verify --archive PATH; storage migrate --backup NEW_ARCHIVE_PATH --destination NEW_ROOT; storage unfix --id ID --evidence FIXED_ID --reason TEXT. All accept --data-root and --format json|text. Whole-root archive includes every project. Archive/migrate retain the source; cleanup requires its own preview and explicit commit.');
    return;
  }
  const dataRoot = values['data-root'] ?? join(homedir(), 'Library', 'Application Support', 'pi-durio');
  // Resolve display numbers before any command opens storage, takes ownership or writes facts.
  for (const key of ['run', 'context-run'] as const) if (values[key]) values[key] = values[key].split(',').map(input => resolveDisplayInput(dataRoot, 'run', input)).join(',');
  const idKind = command === 'eval' && ['run', 'report', 'grade'].includes(positionals[1]) ? 'eval-plan' : command === 'improve' && positionals[1] === 'report' ? 'improve-report' : undefined;
  if (idKind && values.id) values.id = resolveDisplayInput(dataRoot, idKind, values.id);
  if (!command || command === 'resume') {
    // 交互入口（S3、U6）：无参数在当前目录（或 --workspace）打开 TUI，默认 coding，--read-only 收窄。
    // resume：工作区取会话记录、授权沿用链尾 run；启动时不取锁、不调度（R3）。
    if (values.prompt) throw Error('USAGE: enter requests in the TUI input area');
    let workspace = values.workspace ?? process.cwd(), coding = !values['read-only'], resume: string | undefined, sessions = false, elsewhere = false;
    if (command === 'resume') {
      if (values.coding || values['read-only']) throw Error('USAGE: resume keeps the tail run authorization; --coding/--read-only are not accepted');
      if (values.workspace) throw Error('USAGE: resume takes the workspace from the session record');
      const input = positionals[1], chains = readSessionChains(dataRoot);
      if (input === undefined) sessions = true;
      else {
        const runOf = (id: string) => { const session = chains.sessionOfRun(id); return Error(`USAGE: resume takes a session number; ${input} is a run${session ? ` of session ${readDisplayIndex(dataRoot).label('session', session.id)}` : ''}`); };
        if (/^r-/i.test(input)) throw runOf(resolveDisplayInput(dataRoot, 'run', input));
        const id = resolveDisplayInput(dataRoot, 'session', input), session = chains.session(id);
        if (!session) { if (chains.sessionOfRun(id)) throw runOf(id); throw Error(`DISPLAY_NOT_FOUND: no session matches ${input}`); }
        const continuation = readContinuation(dataRoot, id, { chains })!;
        if (!session.workspace) throw Error('SESSION_WORKSPACE_UNRECORDED: the session record has no workspace');
        workspace = session.workspace; coding = continuation.coding; resume = id;
        try { elsewhere = realpathSync(process.cwd()) !== workspace; } catch { elsewhere = true; }
      }
    }
    if (values['tool-env-config'] && !coding) throw Error('USAGE: --tool-env-config requires a coding session');
    const toolEnvironment = values['tool-env-config'] ? JSON.parse(await readFile(values['tool-env-config'], 'utf8')) : undefined;
    const { runTui } = await import('./tui/app.js');
    const { tuiExitCode,tuiCleanupStatus } = await import('./tui/exit-summary.js');
    const exit = await runTui({ dataRoot, workspace, mode: values['offline-demo'] ? 'offline' : 'live', transport: values['offline-demo'] ? demoTransport().fetch : undefined, coding, toolEnvironment, resume, sessions, elsewhere });
    const result = exit.result;
    console.log(exit.summary.join('\n'));
    process.exitCode = tuiExitCode(exit);
    exitHostIfUnconfirmed(tuiCleanupStatus(exit));
    return;
  }
  if(metricsCommand(command,dataRoot,values))return;
  if(command==='improve'){await improveCommand(positionals[1],dataRoot,values);return;}
  if(command==='eval'){await evalCommand(positionals[1],dataRoot,{...values,id:values.id??positionals[2]});return;}
  if (await storageCommand(command,positionals[1],dataRoot,values)) return;
  if (await historyCommand(command, dataRoot, values)) return;
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
    const decision=JSON.parse(await readFile(values.decision,'utf8'));if(typeof decision?.requestId==='string')decision.requestId=resolveDisplayInput(dataRoot,'queue-request',decision.requestId);
    const authorization=values.authorization?JSON.parse(await readFile(values.authorization,'utf8')):undefined;
    const lifecycle=lifecycleSignals();
    let result;try{result=await decideQueue({dataRoot,runId:values.run,decision,authorization,transport:values['offline-demo']?demoTransport().fetch:undefined,signal:lifecycle.signal,get cancellation(){return lifecycle.cancellation;}});}finally{lifecycle.close();}
    if('usage' in result)writeHeadlessResult(result);else {console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='frozen'||result.status==='dispatching'?75:0;}
    return;
  }
  if (command === 'show') {
    // `show <s-号|r-号>`（U6）：不带 --format 打开只读 TUI（不取锁、不调度）；带 --format 照首版打印，s- 号取链尾 run。
    const input = positionals[1];
    if (!input || values.run) throw Error('USAGE: show takes <s-号|r-号>');
    if (values.format !== undefined && values.format !== 'json' && values.format !== 'text') throw Error('USAGE: format is json or text');
    const chains = readSessionChains(dataRoot);
    let session: string | undefined;
    if (/^s-/i.test(input)) session = resolveDisplayInput(dataRoot, 'session', input);
    else if (!/^r-/i.test(input) && chains.session(input)) session = input;
    if (session) { const summary = chains.session(session); if (!summary) throw Error(`DISPLAY_NOT_FOUND: no session matches ${input}`); values.run = summary.tailRunId; }
    else values.run = resolveDisplayInput(dataRoot, 'run', input);
    if (!values.format) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('USAGE: show outside a terminal requires --format json');
      const { runTui } = await import('./tui/app.js');
      // 只读查看取 cwd 作工作区；--trace 打开 2a（s- 号取链尾 run）。
      const exit = await runTui({ dataRoot, workspace: process.cwd(), mode: 'live', show: { run: values.run, session }, ...(values.trace ? { trace: values.run } : {}) });
      console.log(exit.summary.join('\n'));
      if (exit.error) process.exitCode = 1;
      return;
    }
    // --trace --format json|text 与 history trace 相同。
    if (values.trace) { await historyCommand('trace', dataRoot, values); return; }
    const page = await readRun(dataRoot, values.run, { after: values.after ? Number(values.after) : undefined, limit: values.limit ? Number(values.limit) : undefined });
    // The estimate is a sibling of the recorded RunResult, which stays exactly as runtime returned it.
    const costEstimate = { scope: `run:${values.run}`, ...costTotalsView(estimateRunRequests(dataRoot, values.run).totals) };
    const output = JSON.stringify(values.originals ? { ...page, costEstimate } : { ...page, records: page.records.map(({ seq, kind, at }) => ({ seq, kind, at })), costEstimate }, null, 2);
    console.log(values.format === 'text' ? `pi-durio show\n${output}` : output);
    return;
  }
  if (command === 'recover') {
    const input = positionals[1];
    if (positionals.length > 2 || input !== undefined && values.run !== undefined || !input && !values.run) throw Error('USAGE: recover takes <r-号|s-号> or --run UUID');
    if (values.inspect && values.decision) throw Error('USAGE: --inspect cannot execute a decision');
    // U6: resolve the derived session tail before recovery can take ownership or write a report.
    const chains = readSessionChains(dataRoot);
    if (input !== undefined) {
      const sessionId = /^s-/i.test(input) ? resolveDisplayInput(dataRoot, 'session', input) : !/^r-/i.test(input) && chains.session(input) ? input : undefined;
      if (sessionId) {
        const session = chains.session(sessionId);
        if (!session) throw Error(`DISPLAY_NOT_FOUND: no session matches ${input}`);
        values.run = session.tailRunId;
      } else values.run = resolveDisplayInput(dataRoot, 'run', input);
    }
    if (!values.run || !chains.sessionOfRun(values.run)) throw Error(`RUN_NOT_FOUND: no run matches ${input ?? values.run}`);
    const authorization: RecoveryAuthorization|undefined = values.authorization ? JSON.parse(await readFile(values.authorization,'utf8')) : undefined;
    const decision = values.decision ? JSON.parse(await readFile(values.decision,'utf8')) : undefined;
    const options = {dataRoot,runId:values.run,authorization,...(values.after || values.limit || values.snapshot ? {page:{offset:values.after?Number(values.after):undefined,limit:values.limit?Number(values.limit):undefined,snapshotId:values.snapshot}} : {})};
    if (values.evidence) {
      if (!values.inspect || !values.snapshot || values.decision) throw Error('USAGE: recovery entry details require --inspect --snapshot ID --evidence ENTRY_ID');
      console.log(JSON.stringify(await readRecoveryDetail({...options,snapshotId:values.snapshot,...(values.evidence.startsWith('task:')?{taskId:Number(values.evidence.slice(5))}:{entryId:Number(values.evidence)}),offset:values.offset?Number(values.offset):undefined,limit:values.limit?Number(values.limit):undefined}),null,2)); return;
    }
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
      if(request.action==='withdraw'&&typeof request.decision?.requestId==='string')request.decision.requestId=resolveDisplayInput(dataRoot,'queue-request',request.decision.requestId);
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
  console.error(JSON.stringify({ error: { code, message, ...(error instanceof DisplayInputError ? { candidates: error.candidates } : {}) } }));
  process.exitCode = code === 'AUTH_MISSING' ? 78 : code === 'OWNER_CONFLICT' ? 73 : /RECOVERY|DECISION|OWNER_(STILL|CHANGED|IDENTITY|HOST)/.test(code) ? 75 : code === 'RUN_CANCELLED_BEFORE_ACCEPTANCE' ? 130 : 1;
});
