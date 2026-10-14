# Standards static evidence appendix

This appendix describes only the fixed candidate, not another reviewer or repair. All line references are candidate lines. No dynamic reproduction was performed.

## STD-01

preflight SELECTs every host row using all(), decodes every body into records, and accumulates complete inspectSession reports for all sessions. inspectSession paginates the upstream reads but pushes every task, submission and entry into retained arrays. runtime serializes all reports into one preflight record before task.accepted. Evidence.append rejects that record above 2 MiB. recoveryRecords likewise materializes all requested originals and has whole-root callers.

Peak memory grows with all retained original content, including repeated historical preflight snapshots. Once the aggregate preflight body exceeds 2 MiB, starting unrelated new work fails with EVIDENCE_RECORD_LIMIT even when prior sessions are completed and valid. No empirical session-count threshold is claimed.

## STD-02

runRestricted appends delivered chunks to stdout/stderr, detects output_limit and stops the client; on close it slices stdout to limits.totalBytes and stderr to 1,048,576 characters. Only the sliced result enters outcome.json and the product Evidence blob. launchImproveBuild slices stdout/stderr immediately after appending each over-cap chunk, requests SIGTERM then SIGKILL after 5 seconds, and records only the sliced process-result. There is no persistent raw-output stream or reference preserving discarded tails.

Reopening the saved failed/cancelled operation cannot recover all acquired original output, violating the raw-retention guarantee even though the limit failure is visible.

scripts/isolation/boundary.mjs is the shipped product isolation engine called by eval/runner and improve-validation/build. A declared direct/regression check, build, startup or explicit selected-build process can emit these streams. This finding does not concern external acceptance scripts or require shell output from ordinary coding to be affected.

The retained reason output_limit/output-limit correctly reports the deliberate stop. It does not preserve the tail already appended before the check. No claim is made that output produced after destroyed pipes was acquired. Existing unknown termination states remain separate.

## STD-03

metricsCommand calls the exported synchronous record functions directly. Each opens new Evidence, whose constructor opens writable host.sqlite and creates/chmods objects before BEGIN IMMEDIATE. None obtains acquireOwner, accepts/asserts an existing lease, or checks owner markers. SQLite serializes its transaction, not the application ownership interval.

A second writer can modify host evidence under another process's exclusive owner, contradicting the contract and permitting avoidable interference with execution writes and owner-fenced stable archive capture.

issue-27/README.md:91-92 allows recording requirements from an in-process observation callback and says the short transaction does not take over execution owner. That can justify reuse of an already-held same-process owner; it does not establish a documented exception allowing a second process to bypass the explicit data-root rule. No claim of actual corruption is made.

For STD-02, choose ASCII chunks so character/byte ambiguity is irrelevant: a delivered event taking stdout from cap - 1 to cap + 1 is already acquired before halt. The saved slice has cap characters, so one acquired character is absent. The same applies to stderr and launchImproveBuild. The finding does not depend on output produced after stop, provider output not returned, or artifacts remaining in an external test harness. Product persistence paths are quoted below. A visible output-limit reason is not an original-content reference.

## src/preflight.ts:46-80

```text
46:       const pending: { kind: string; id: number; status: string }[] = [];
47:       const tasks: TaskRecord<any, any, any>[] = [];
48:       const submissions: SubmissionRecord[] = [];
49:       const entries: EntryRecord[] = [];
50:       const conversations: ConversationRecord[] = [];
51:       const agents: { conversationId: number; value: JsonObject }[] = [];
52:       const live: { conversationId: number; value: LiveState }[] = [];
53:       let cursor: Cursor | undefined;
54:       do {
55:         const page = await storage.scanTasks({}, 100, cursor, BACKGROUND_CONTEXT);
56:         for (const task of page.items) {
57:           tasks.push(task);
58:           if (task.state.status !== 'terminal') pending.push({ kind: task.kind, id: task.id, status: task.state.status });
59:         }
60:         cursor = page.next;
61:       } while (cursor);
62:       do {
63:         const page = await storage.scanSubmissions({}, 100, cursor, BACKGROUND_CONTEXT);
64:         for (const item of page.items) {
65:           submissions.push(item);
66:           if (item.status === 'queued' || item.status === 'placed') pending.push({ kind: 'submission', id: item.id, status: item.status });
67:         }
68:         cursor = page.next;
69:       } while (cursor);
70:       const usage = [];
71:       do {
72:         const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
73:         for (const conversation of page.items) {
74:           conversations.push(conversation);
75:           let entryCursor: Cursor | undefined;
76:           do {
77:             const entriesPage = await storage.scanEntries({ conversationId: conversation.id }, 100, entryCursor, BACKGROUND_CONTEXT);
78:             entries.push(...entriesPage.items);
79:             entryCursor = entriesPage.next;
80:           } while (entryCursor);
```

## src/preflight.ts:107-127

```text
107: export async function preflight(owner: OwnerLease) {
108:   const root = owner.path;
109:   owner.assertHeld();
110:   const reports: Awaited<ReturnType<typeof inspectSession>>[] = [];
111:   const sessions = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
112:   let records: {seq:number;runId:string;kind:string;data:any}[] = [];
113:   try { await access(join(root,'host.sqlite')); }
114:   catch { if (sessions.length) throw new Error('RECOVERY_REQUIRED: missing host facts'); return reports; }
115:   const db = openHostReadonly(root);
116:   try { records = db.prepare('SELECT seq,run_id,kind,body FROM records ORDER BY seq').all().map(row => ({seq:Number(row.seq),runId:String(row.run_id),kind:String(row.kind),data:JSON.parse(readObject(root,JSON.parse(String(row.body)) as BlobRef).toString())})); }
117:   finally { db.close(); }
118:   const accepted = records.filter(record => record.kind === 'task.accepted');
119:   const resolved = new Set<string>();
120:   for (const dir of sessions) {
121:     if (!dir.isDirectory()) throw new Error('RECOVERY_REQUIRED: unexpected session storage alias');
122:     const path = join(root,'sessions',dir.name,'durable.sqlite');
123:     for (const marker of [join(root,'sessions',dir.name,'owner.json'),join(root,'sessions',`${dir.name}.lock`)]) {
124:       try { await access(marker); throw new Error('RECOVERY_REQUIRED: unresolved session owner'); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
125:     }
126:     const report = await inspectSession(path,owner);
127:     reports.push(report);
```

## src/runtime.ts:475-483

```text
475:     guard();
476:     evidence = new Evidence(dataRoot, runId, options.fault);
477:     if (!recovery) record('preflight', { sessions: inspected });
478:     else record('recovery.started', { decisionId: recovery.decision.id, snapshotId: recovery.report.snapshotId, capabilities: recovery.readOnly ? ['read'] : recovery.accepted.authorization.tools, previousRequests: requests, previousUsageUnknown: recovery.previousUsageUnknown, originalStatus: (recovery.report.original as {status:string}).status });
479:     guard();
480:     accepted = true;
481:     if(improve){analysis=prepareImprove(evidence,improve.request,improve.target,guard);providerBoundary={budget:analysis.budget,purpose:'improve',operationId:`improve:${improve.request.id}`};analysisTimer=setTimeout(()=>fatal(Error('BUDGET_DEADLINE')),Math.max(1,Date.parse(analysis.deadline)-Date.now()));}
482:     const authorization={ tools: improve ? ['evidence_summary','evidence_read','source_view'] : coding ? ['read', 'write', 'edit', 'bash'] : ['read'], execution: improve ? 'scoped-improve-analysis' : coding ? 'trusted-local-coding' : 'trusted-local-read-only', requestLimit: improve?improve.request.limits.maxRequests:8, fileLimitBytes: 256 * 1024, replay: 'unsafe' };
483:     if (!recovery&&!maintenance) record('task.accepted', { taskId, runId, sessionId, ...(improve?{kind:'improve',improveRequestId:improve.request.id,sourceTarget:improve.target}:{}), input: options.input, workspace, mode: options.mode, origin: improve ? {kind:'improve',source:options.mode==='offline'?'synthetic':options.transport?'diagnostic':'ordinary'} : options.taskOrigin ?? {kind:'coding',source:options.mode==='offline'?'synthetic':options.transport?'diagnostic':'ordinary'}, ...(queued?{queueRequestId:queued.item.requestId,sourceTarget:queued.item.target}:{}), authorization, credentials: { source: options.mode === 'offline' ? 'offline-placeholder' : 'DEEPSEEK_API_KEY', present: true } });
```

## src/evidence.ts:107-116

```text
107: /** Host-owned facts, separate from upstream durable state. Appends and blobs are synchronous backpressure. */
108: export class Evidence {
109:   readonly db: DatabaseSync;
110:   constructor(readonly root: string, readonly runId: string, private readonly fault?: FaultInjector) {
111:     mkdirSync(join(root, 'objects'), { recursive: true, mode: 0o700 });
112:     this.db = new DatabaseSync(join(root, 'host.sqlite'));
113:     chmodSync(join(root, 'host.sqlite'), 0o600);
114:     // Public readonly viewers can briefly hold a shared lock. Wait only for that
115:     // SQLite lock; this never retries a tool/model or masks a lasting write failure.
116:     this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_run ON records(run_id, seq)');
```

## src/evidence.ts:132-139

```text
132:   append(kind: string, data: unknown): number {
133:     this.fault?.(kind);
134:     const stamped=stampFact(kind,data);
135:     const body = JSON.stringify(stamped.data);
136:     if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('EVIDENCE_RECORD_LIMIT');
137:     const ref = this.blob(body);
138:     const row = this.db.prepare('INSERT INTO records(run_id,kind,at,body) VALUES(?,?,?,?)').run(this.runId, kind, stamped.acquiredAt, JSON.stringify(ref));
139:     return Number(row.lastInsertRowid);
```

## src/recovery.ts:44-48

```text
44:   try { return db.prepare(`SELECT seq,kind,at,body FROM records ${runId ? 'WHERE run_id=?' : ''} ORDER BY seq`).all(...(runId ? [runId] : [])).map(row => ({ seq: Number(row.seq), kind: String(row.kind), at: String(row.at), data: JSON.parse(readObject(root, JSON.parse(String(row.body)) as BlobRef).toString()) })); }
45:   finally { db.close(); }
46: }
47: function freezePendingControls(evidence:Evidence,records:EvidenceRecord[]) {
48:   for(const record of records.filter(record=>record.kind==='control.accepted')) {
```

## scripts/isolation/boundary.mjs:110-141

```text
110:     const execution = await new Promise(resolve => {
111:       const child = spawn(containerExecutable, ['start', '--attach', '--interactive', id], {
112:         env: cleanHostEnv(), stdio: ['pipe', 'pipe', 'pipe'],
113:       });
114:       let reason = null, stdout = '', stderr = '', pending = '', chain = Promise.resolve();
115:       let accepted = 0, closed = false;
116:       const abort = new AbortController();
117:       const halt = value => {
118:         if (reason) return;
119:         reason = value;
120:         abort.abort(value);
121:         child.stdin.destroy();
122:         // A failed controller may leave a helper holding inherited pipe FDs.
123:         // Do not let pipe EOF delay the independent VM stop/delete path.
124:         child.stdout.destroy();
125:         child.stderr.destroy();
126:         // Killing the client is not termination confirmation; stop/delete below is mandatory.
127:         child.kill('SIGKILL');
128:       };
129:       const timer = setTimeout(() => halt('timeout'), timeoutMs);
130:       const onAbort = () => halt('cancelled');
131:       signal?.addEventListener('abort',onAbort,{once:true});
132:       if(signal?.aborted)onAbort();
133:       child.stdin.on('error', () => {});
134:       child.on('error', () => halt('execution_start_failed'));
135:       child.stderr.on('data', chunk => {
136:         stderr += chunk;
137:         if (stderr.length > 1_048_576) halt('output_limit');
138:       });
139:       child.stdout.on('data', chunk => {
140:         stdout += chunk; pending += chunk;
141:         if (Buffer.byteLength(stdout) > limits.totalBytes || Buffer.byteLength(pending) > limits.lineBytes) return halt('output_limit');
```

## scripts/isolation/boundary.mjs:171-181

```text
171:       child.on('close', code => {
172:         closed = true; clearTimeout(timer); signal?.removeEventListener('abort',onAbort);
173:         abort.abort('execution_ended');
174:         for (const attempt of result.modelRequests) if (attempt.status === 'started') attempt.status = 'unknown';
175:         // A stuck provider must not prevent the boundary from terminating the VM.
176:         resolve({ code, reason, stdout: stdout.slice(0, limits.totalBytes), stderr: stderr.slice(0, 1_048_576) });
177:       });
178:     });
179:     Object.assign(result, execution);
180:     result.status = execution.reason ? 'failed' : execution.code === 0 ? 'completed' : 'failed';
181:     result.reason = execution.reason ?? (execution.code === 0 ? null : 'execution_error');
```

## scripts/isolation/boundary.mjs:185-200

```text
185:     if (result.control.some(entry => entry.name === 'create')) {
186:       try {
187:         const stop = await record('stop', ['stop', '--time', '1', id]);
188:         const inspected = await record('stopped', ['inspect', id]);
189:         const state = inspected.code === 0 ? JSON.parse(inspected.stdout)[0]?.status?.state : null;
190:         const deleted = await record('delete', ['delete', id]);
191:         const listed = await record('absence', ['list', '--all', '--format', 'json']);
192:         const absent = listed.code === 0 && !JSON.parse(listed.stdout).some(item => item.id === id);
193:         result.terminated = stop.code === 0 && state === 'stopped' && deleted.code === 0 && absent;
194:       } catch { result.terminated = false; }
195:       if (!result.terminated) { result.status = 'invalid'; result.reason = 'termination_unconfirmed'; }
196:     }
197:     await writeFile(join(runDir, 'outcome.json'), json(result), { flag: 'wx' });
198:     if (result.terminated) stopped.set(result, workDir);
199:   }
200:   return result;
```

## src/improve-process.ts:60-69

```text
60:  const child=spawn(process.execPath,[join(build!.directory,build!.entry),...args],{cwd:auth.workspace,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,...(auth.mode==='live'&&process.env.DEEPSEEK_API_KEY?{DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY}:{})}});
61:  const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
62:  let stdout='',stderr='',error:string|null=null,reason:string|null=null,killTimer:NodeJS.Timeout|undefined;
63:  const signalGroup=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch(err){if((err as NodeJS.ErrnoException).code!=='ESRCH')error=String(err);}};
64:  const stop=(why:string)=>{if(reason)return;reason=why;signalGroup('SIGTERM');killTimer=setTimeout(()=>signalGroup('SIGKILL'),5000);};const abort=()=>stop('cancelled');o.signal?.addEventListener('abort',abort,{once:true});if(o.signal?.aborted)abort();const timer=setTimeout(()=>stop('timeout'),o.timeoutMs);
65:  child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>1048576){stdout=stdout.slice(0,1048576);stop('output-limit');}});child.stderr.on('data',chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>1048576){stderr=stderr.slice(0,1048576);stop('output-limit');}});child.on('error',err=>{error=String(err);});
66:  let spawned:string|null=null;try{spawned=child.pid?await record('improve.process-started',{buildId:build!.id,pid:child.pid,parentPid:process.pid,entry:join(build!.directory,build!.entry),args,observation:'OS child spawn with immediately verified executable/dependency bytes; task outcome is a separate result'}):null;}catch(err){error=String(err);stop('journal-failure');}
67:  const code=await closed;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);o.signal?.removeEventListener('abort',abort);
68:  const result={state:error||reason||code!==0?'failed':'completed',pid:child.pid??null,parentPid:process.pid,buildId:build!.id,entry:join(build!.directory,build!.entry),started:spawned,code,reason,error,stdout,stderr,scope:'New process invocation and its exit observed. Process completion alone does not establish task acceptance or improvement; prior pending runs were not opened.'};
69:  await record('improve.process-result',{result});return result;
```

## src/improve-build.ts:68-71

```text
68:  const engine=await import(new URL('../execution/isolation/boundary.mjs',import.meta.url).href);
69:  const execution=await engine.runRestricted({image:verifiedImage,inputDir:input,runDir:join(o.directory,'execution'),command:['node','/input/bootstrap.mjs'],resourceProfile:'typescript-build',timeoutMs:Math.max(100,Math.min(o.timeoutMs,Date.parse(o.deadline)-Date.now())),signal:o.signal});guard();
70:  const executionRef=e.blob(JSON.stringify(execution));record('improve.build-execution',{groupId:o.groupId,execution:executionRef,state:!execution.terminated||execution.status==='invalid'?'unknown':execution.code===0?'completed':'failed'});
71:  if(!execution.terminated||execution.status==='invalid'||execution.code!==0)throw new ImproveBuildFailure(!execution.terminated||execution.status==='invalid'?'unknown':'failed',`IMPROVE_BUILD_FAILED:${execution.reason??execution.stderr??execution.code}`);
```

## src/improve-build.ts:84-86

```text
84:  const startup=await engine.runRestricted({image:verifiedImage,inputDir:smokeInput,runDir:join(o.directory,'startup'),command:['node','/input/build/dist/src/cli.js','--help'],timeoutMs:Math.max(100,Math.min(o.timeoutMs,Date.parse(o.deadline)-Date.now())),signal:o.signal});guard();
85:  const startupRef=e.blob(JSON.stringify(startup));record('improve.build-startup',{groupId:o.groupId,buildId:candidate.id,execution:startupRef,state:!startup.terminated||startup.status==='invalid'?'unknown':startup.code===0?'completed':'failed'});
86:  if(!startup.terminated||startup.status==='invalid'||startup.code!==0)throw new ImproveBuildFailure(!startup.terminated||startup.status==='invalid'?'unknown':'failed',`IMPROVE_BUILD_STARTUP_FAILED:${startup.reason??startup.stderr??startup.code}`);
```

## src/improve-validation.ts:133-150

```text
133:     const execution=await engine.runRestricted({image:verifiedImage,inputDir:input,runDir:join(checkDirectory,'execution'),command:['node','/input/bootstrap.mjs'],timeoutMs:Math.max(100,Math.min(check.timeoutMs,Date.parse(options.deadline)-Date.now())),signal:options.signal});
134:     guard();let artifacts:any[]=[];
135:     if(execution.terminated&&execution.status!=='invalid'){
136:      const names=regularFiles(join(checkDirectory,'execution/work/targets')).map(p=>`targets/${p}`),destination=join(checkDirectory,'export');
137:      await engine.exportStopped(execution,names,destination,{maxFiles:200,maxBytes:4194304});artifacts=captureFiles(e,destination,names).files;
138:      for(const [key,bytes]of content)if(!artifacts.some(f=>f.path===`targets/${key}`&&f.ref.sha256===digest(bytes)))throw Error('IMPROVE_CHECK_CHANGED_CANDIDATE: checks may not replace the fixed content under validation');
139:     }
140:     state=!execution.terminated||execution.status==='invalid'?'unknown':execution.reason==='cancelled'?'cancelled':execution.code===0?'completed':'failed';reason=execution.reason;
141:     let resource:any=null;
142:     if(check.kind==='resource'&&state==='completed'){
143:      resource=JSON.parse(execution.stdout.trim());
144:      if(![resource.baseline,resource.candidate].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)||typeof resource.protectionsPassed!=='boolean')throw Error('IMPROVE_RESOURCE_EVIDENCE_INVALID');
145:      const delta=check.resource!.direction==='lower'?resource.baseline-resource.candidate:resource.candidate-resource.baseline;
146:      effect=!resource.protectionsPassed||delta<=-check.resource!.delta?'退化':delta>=check.resource!.delta?'改善':'无明显差异';
147:      if(!resource.protectionsPassed){state='failed';reason='Declared resource protection failed';}
148:     }
149:     if(build)verifyImproveBuild(root,build.candidate);
150:     checks.push({index,kind:check.kind,state,reason,effect:check.kind==='resource'?effect:state==='completed'?'direct-checks-passed':'direct-checks-failed',execution,executionRef:e.blob(JSON.stringify(execution)),artifacts,resource,...(build?{buildId:build.candidate.id}:{}),...(profiles.length?{profileInput:construction.effectiveProfiles,fullProfileAssertions:checkedProfiles}:{} )});
```

## src/eval/runner.ts:82-89

```text
82:    if(effectiveTask&&trial.scenario==='auto-compaction')throw Error('EVAL_PROFILE_OVERRIDE_DENIED');
83:    const guest={...(effectiveTask?{effectiveTask}:{}),trialId:trial.id,mode:plan.mode,prompt:[plan.comparison?.sides[trial.side as 'baseline'|'candidate'].instructions,fixture.input].filter(Boolean).join('\n\n'),files:{...fixture.files,'package-lock.json':fixture.dependencyLock},dirty:fixture.dirty,maxOutputTokens:plan.maxOutputTokens,...(trial.scenario==='original-error'?{originalFailure:true}:{}),...(trial.scenario==='auto-compaction'?{verificationCompaction:{reserveTokens:999999,keepRecentTokens:1}}:{})};
84:    await writeFile(join(inputDir,'trial.json'),JSON.stringify(guest));
85:    const probe=trial.scenario==='boundary'?await prepareProbe(inputDir):undefined;
86:    const mediator=evalMediator(plan,trial,budget,options.transportForTrial?.(trial)??controlled(plan,trial),()=>owner.assertHeld());
87:    const runDir=join(options.directory,`${trial.id}-execution`);
88:    appendFact(e,'eval.trial-started',{trialId:trial.id,at:new Date().toISOString(),input:e.blob(JSON.stringify(guest))});
89:    outcome.started=true;outcome.timing.preparationMs=performance.now()-preparedAt;
```

## src/metrics/acceptance.ts:37-48

```text
37: /** Explicit host/user management input, never registered as a candidate tool.
38:  * Only appends to the original Evidence store. A short SQLite transaction makes
39:  * duplicate IDs/revisions atomic even while the execution owner writes facts. */
40: export function recordAcceptance(root:string,input:AcceptanceInput) {
41:  ensure(input&&nonempty(input.id,128)&&nonempty(input.taskId,128),'identity required');
42:  ensure(['requirements','result','judgment','withdraw','dispute'].includes(input.type),'unsupported operation');
43:  ensure(input.source&&['human','checks','unverified'].includes(input.source.kind)&&nonempty(input.source.actor,256)&&nonempty(input.source.statement)&&Array.isArray(input.source.refs),'explicit source required');
44:  ensure(input.occurredAt===undefined||typeof input.occurredAt==='string'&&Number.isFinite(Date.parse(input.occurredAt)),'invalid occurrence time');
45:  const admitted=task(root,input.taskId),admission=[...records(root,{after:admitted.acceptedSeq-1,through:admitted.acceptedSeq})][0];
46:  const evidence=new Evidence(root,admission.runId);
47:  evidence.db.exec('BEGIN IMMEDIATE');
48:  try {
```

## src/metrics/feedback.ts:16-22

```text
16: export function recordFeedback(root:string,input:FeedbackInput){
17:  ensure(input&&text(input.id,128)&&text(input.taskId,128),'identity required');ensure(['observation','withdraw'].includes(input.type),'operation required');
18:  ensure(input.source&&['human','action','unverified'].includes(input.source.kind)&&text(input.source.actor,256)&&text(input.source.statement)&&Array.isArray(input.source.refs),'original statement/action required');
19:  const admitted=task(root,input.taskId),admission=[...records(root,{after:admitted.acceptedSeq-1,through:admitted.acceptedSeq})][0],e=new Evidence(root,admission.runId);
20:  e.db.exec('BEGIN IMMEDIATE');try{
21:   const through=watermark(root),history=feedbackHistory(root,admission.runId,input.taskId,through);ensure(!history.missing.length,'original feedback unavailable; cannot append a revision');
22:   const identity=digest(JSON.stringify(input)),repeated=history.facts.find(f=>f.data.id===input.id);if(repeated){ensure(repeated.data.requestIdentity===identity,'ID conflicts with retained input');e.db.exec('COMMIT');return{source:repeated.ref.id,repeated:true};}
```

## src/metrics/costs.ts:9-19

```text
9: export function recordCostEstimate(root:string,input:CostEstimateInput){
10:  if(!input||!input.id||input.id.length>256||!input.reason||input.reason.length>4096||!Number.isFinite(input.amount)||input.amount<0||!/^\w{3,12}$/.test(input.currency)||!input.price?.source||!input.price.version||!Number.isFinite(Date.parse(input.price.effectiveAt))||!input.price.provider||!input.price.model||!Array.isArray(input.usageSources)||!input.usageSources.length||input.usageSources.length>500)throw Error('INVALID_COST_ESTIMATE');
11:  const request=resolveEvidence(root,input.requestSource),data=decode(root,request);
12:  if(Date.parse(input.price.effectiveAt)>Date.parse(request.at))throw Error('PRICE_NOT_EFFECTIVE_AT_REQUEST');
13:  const model=request.kind==='provider.dispatch'?[...records(root,{runId:request.runId,through:request.seq,kinds:['eval.plan']})].map(ref=>decode(root,ref)).at(-1)?.model:data.model;
14:  if(model&&(model.provider!==input.price.provider||model.id!==input.price.model))throw Error('PRICE_MODEL_SCOPE_CHANGED');
15:  if(!['model.intent','provider.dispatch','tool.intent'].includes(request.kind))throw Error('COST_REQUEST_REQUIRED');
16:  for(const id of input.usageSources){const ref=resolveEvidence(root,id),value=decode(root,ref);if(ref.runId!==request.runId||request.kind==='model.intent'&&(ref.kind!=='model.response'||value.attemptId!==data.attemptId||value.usage!=='reported')||request.kind==='provider.dispatch'&&(!['provider.bytes','budget.settle'].includes(ref.kind)||value.id!==data.id)||request.kind==='tool.intent'&&(ref.kind!=='tool.result'||value.attemptId!==data.attemptId))throw Error('COST_USAGE_LINK_REQUIRED');}
17:  const e=new Evidence(root,request.runId);try{e.db.exec('BEGIN IMMEDIATE');const previous=[...records(root,{runId:request.runId,kinds:['cost.estimate']})].map(ref=>({ref,data:decode(root,ref)}));const same=previous.find(p=>p.data.id===input.id);if(same){if(JSON.stringify(same.data.input)!==JSON.stringify(input))throw Error('COST_ESTIMATE_ID_CONFLICT');e.db.exec('ROLLBACK');return{source:same.ref.id,repeated:true};}
18:  if(input.revisionOf&&!previous.some(p=>p.data.id===input.revisionOf&&p.data.requestSource===input.requestSource))throw Error('COST_ESTIMATE_REVISION_REQUIRED');
19:  const value={...input,input,kind:'estimate',method:'explicit-sourced-estimate-v1',receivedAt:new Date().toISOString()};const seq=e.append('cost.estimate',value);e.db.exec('COMMIT');return{source:`e1:${seq}:${digest(JSON.stringify(value))}`,repeated:false};}catch(error){try{e.db.exec('ROLLBACK');}catch{}throw error;}finally{e.close();}
```

## src/metrics/cli.ts:8-14

```text
8: export function metricsCommand(command:string|undefined,root:string,values:Record<string,unknown>) {
9:  if(!command||!['metrics','acceptance','operations','cost-estimate','feedback-report','feedback'].includes(command))return false;
10:  if(values.format!==undefined&&values.format!=='json'&&values.format!=='text')throw Error('USAGE: format is json or text');
11:  if(command==='acceptance'||command==='cost-estimate'||command==='feedback'){
12:   if(typeof values.spec!=='string')throw Error(`USAGE: ${command} requires --spec JSON_FILE`);
13:   console.log(JSON.stringify((command==='acceptance'?recordAcceptance:command==='feedback'?recordFeedback:recordCostEstimate)(root,JSON.parse(readFileSync(values.spec,'utf8'))),null,2));return true;
14:  }
```

## src/derived-evidence.ts:18-30

```text
18:       const value=decode(root,source);const acquired=value.acquired??value;
19:       // Decode acquired bytes before scanning. Opaque binary, encoded transport and
20:       // secret-looking content are withheld as a whole, not regex-substituted across page edges.
21:       if(acquired.encoding==='base64'&&typeof acquired.bytes==='string') {
22:         text=Buffer.from(acquired.bytes,'base64').toString('utf8');
23:         if(source.kind==='tool.output'||source.kind==='read.bytes')reasons.push('raw acquired chunk has incomplete boundary context; use a complete textual result for derived analysis');
24:       }
25:       else text=JSON.stringify(value);
26:       if(/(?:api[_-]?key|authorization|bearer\s|password|secret|private[ _-]?key|sk-[A-Za-z0-9]|AKIA[A-Z0-9]|BEGIN.*KEY|token["'\s]*[:=])/i.test(text))reasons.push('credential-like material; entire source withheld');
27:       if(/(?:ignore (?:all |previous |prior )*instructions|system prompt|<\/?(?:system|developer)>|执行.{0,12}(?:命令|指令)|忽略.{0,12}指令)/i.test(text))reasons.push('instruction-like historical material withheld; never authority');
28:       if(/\u0000|�/.test(text))reasons.push('binary or undecodable source withheld');
29:     }catch{ text='';reasons.push('source unavailable; no fallback or wider access'); }
30:     if(reasons.length)text='[WITHHELD]';
```

## src/improve-source.ts:11-17

```text
11: export function redactAnalysisText(text:string) {
12:  const reasons:string[]=[];
13:  if(/(?:api[_-]?key|authorization|bearer\s|password|secret|private[ _-]?key|sk-[A-Za-z0-9]|AKIA[A-Z0-9]|BEGIN.*KEY|token["'\s]*[:=])/i.test(text))reasons.push('credential-like material withheld');
14:  if(/(?:ignore (?:all |previous |prior )*instructions|system prompt|<\/?(?:system|developer)>|执行.{0,12}(?:命令|指令)|忽略.{0,12}指令)/i.test(text))reasons.push('instruction-like material withheld; never authority');
15:  if(/\u0000|�/.test(text))reasons.push('binary or undecodable material withheld');
16:  return {text:reasons.length?'[WITHHELD]':text,reasons,coverage:'conservative known patterns; not universal secret detection'};
17: }
```

## docs/adr/0002-full-original-records-and-user-controlled-reduction.md:7-9

```text
7: 2026-10-09，用户在 [#5 运行证据与长期记录合同](https://github.com/nineofoursyrup/pi-durio/issues/5) 的设计访谈中明确选择“保留所有原文，除非使用者主动压缩”，并确认清理由使用者主动发起。pi-durio 默认完整保留运行原文，不因期限、展示窗口或模型上下文限制自动丢弃；内存、显示和送模内容保持有界，不应以这些上限替代磁盘原文保留。
8: 
9: 用户随后确认自动上下文压缩，并追加“用户可主动进行上下文压缩”。这两种上下文压缩只改变后续模型请求使用的上下文，保留原文、追加摘要并记录用量；它们都不构成删除磁盘历史的授权。
```

## docs/design/runtime-evidence-and-retention.md:143-147

```text
143: 1. durable SQLite 保留上游权威执行状态与已提交消息。宿主库保存产品身份、用户决定、版本与证据关系，以及可重建的查询投影；其中用户决定等独有事实不是缓存，不能把删除整个宿主库称为重建索引。大原文只保存必要的一份完整内容，复用可靠引用，避免逐 span 复制。
144: 2. 沿用单宿主写入者起点，对宿主数据根目录与每个可写 session storage 落实所有权；工作区写入者另按 #3 检查。第二个争用同一数据根的写入进程在写入前被挡住，可只读查看。读取/分页不借机打开会触发协调或调度的 Harness。
145: 3. 需要恢复或控制执行的请求、授权和意图先保存，再放行对应操作；如果无法保存，就不能假装已受理或已授权。引用大原文前先确认内容已持久取得，再提交其完整性/身份。中途崩溃可能留下待核对的记录或附件，不能为了修索引重做模型/工具调用。
146: 4. 两个库与外部副作用之间不承诺跨库原子事务或 exactly-once。通过稳定关联、记录阶段和启动核对发现空隙；无法证明某个请求是否已交给上游时保留不确定，不盲目再次提交。投影落后可由 durable 已提交记录重建，宿主独有事实与未提交原文缺失则如实标记。
147: 5. UI/遥测队列有界，派生 span 可降级并计遗漏；原文采集也有界但采用分块落盘和背压，不能通过丢弃内容满足队列上限。保存失败按前述受控停止处理；检测不出精确丢失量时记录未知缺口，不宣称原文完整。
```

## docs/implementation/pi-durio-v1/issue-27/README.md:90-94

```text
90: 自动证明命令未检查的需求，也不把任意非零退出泛化为验收 FAIL。
91: 宿主可在 `task.accepted` 的 observation 回调中预先保存要求；此路径
92: 已用公开 runtime 验证。验收输入只写短 SQLite 事务，不接管执行 owner。
93: 
94: 宿主在写入 judgment 时生成 `assessment`，保留规则版本、方法版本、
```
