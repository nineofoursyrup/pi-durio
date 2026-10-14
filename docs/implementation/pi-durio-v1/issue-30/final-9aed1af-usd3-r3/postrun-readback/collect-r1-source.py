#!/usr/bin/env python3
"""Read retained, closed r3 journals only. No product import, execution, or network."""
import collections
import hashlib
import json
from pathlib import Path
import sqlite3

OUT = Path(__file__).resolve().parent
BATCH = OUT.parent
WORKTREE = Path('/Users/nineofour/.codex/worktrees/issue-30-usd3/Durio')
READS = {}


def raw(path):
    path = Path(path)
    assert path.name != 'api.env', 'credential reads forbidden'
    data = path.read_bytes()
    identity = {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if str(path) in READS:
        assert READS[str(path)] == identity, f'original changed: {path}'
    READS[str(path)] = identity
    return data


def read(path):
    return json.loads(raw(path))


def checked(identity):
    data = raw(identity['path'])
    assert len(data) == identity['bytes'] and hashlib.sha256(data).hexdigest() == identity['sha256'], identity
    return data


def blob(objects, ref):
    assert len(ref['sha256']) == 64 and all(c in '0123456789abcdef' for c in ref['sha256'])
    return checked({'path': str(objects / ref['sha256']), **ref})


def facts(database, objects):
    assert not Path(str(database) + '-wal').exists(), 'only closed original databases allowed'
    raw(database)
    with sqlite3.connect('file:' + str(database) + '?mode=ro&immutable=1', uri=True) as db:
        return [{'seq': seq, 'runId': run, 'kind': kind, 'at': at, 'ref': json.loads(body), 'data': json.loads(blob(objects, json.loads(body)))}
                for seq, run, kind, at, body in db.execute('select seq,run_id,kind,at,body from records order by seq')]


def source(f):
    return {k: f[k] for k in ['seq', 'runId', 'kind', 'at', 'ref']}


def save(name, value):
    with (OUT / name).open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def by_kind(records):
    result = collections.defaultdict(list)
    for fact in records:
        result[fact['kind']].append(fact)
    return result


def requests(records, objects, stage):
    kinds = by_kind(records)
    lookup = {name: {f['data']['id']: f for f in kinds[name]} for name in ['budget.reserve', 'budget.settle', 'provider.http']}
    links = {f['data']['hostDispatchId']: f for f in kinds['eval.provider-link']}
    result = []
    for dispatch in kinds['provider.dispatch']:
        identifier = dispatch['data']['id']
        reserve, settle, http = [lookup[name][identifier] for name in ['budget.reserve', 'budget.settle', 'provider.http']]
        payload = json.loads(blob(objects, dispatch['data']['body']))
        chunks = [f for f in kinds['provider.bytes'] if f['data']['id'] == identifier]
        response = b''.join(blob(objects, f['data']['bytes']) for f in chunks)
        lines = [line[5:].strip() for line in response.decode().splitlines() if line.startswith('data:')]
        events = [json.loads(line) for line in lines if line and line != '[DONE]']
        usage = [e['usage'] for e in events if e.get('usage') and e['usage'].get('total_tokens') is not None]
        assert usage and usage[-1]['prompt_tokens'] + usage[-1]['completion_tokens'] == usage[-1]['total_tokens']
        assert payload['model'] == 'deepseek-flash' and payload['stream'] is True
        assert payload['max_tokens'] == (4096 if stage == 'eval' else 8192)
        assert http['data']['status'] == 200
        assert '[DONE]' in lines
        if stage == 'eval':
            assert settle['data']['status'] == 'returned' and settle['data']['tokens'] == usage[-1]['total_tokens']
        else:
            assert settle['data'] == {'budgetId': 'improve:v1-live-r2-improve', 'id': identifier, 'tokens': None, 'status': 'cancelled', 'reason': 'undefined'}
            with (OUT / 'improve-response-derived.sse').open('xb') as stream:
                stream.write(response)
        entry = {'stage': stage, 'id': identifier, 'dispatch': source(dispatch), 'reservation': source(reserve), 'reservationData': reserve['data'],
                 'http': source(http), 'status': http['data']['status'], 'settlement': source(settle), 'settlementData': settle['data'],
                 'payloadRef': dispatch['data']['body'], 'requestModel': payload['model'], 'maxOutputTokens': payload['max_tokens'],
                 'rawChunkCount': len(chunks), 'rawChunkSources': [source(f) | {'bytes': f['data']['bytes']} for f in chunks],
                 'rawAssembledSha256': hashlib.sha256(response).hexdigest(), 'rawUsage': usage[-1], 'doneSentinelObserved': True,
                 'rawModels': sorted({e['model'] for e in events if e.get('model')}),
                 'rawSystemFingerprints': sorted({e['system_fingerprint'] for e in events if e.get('system_fingerprint')}),
                 'finishReasons': sorted({c['finish_reason'] for e in events for c in e.get('choices', []) if c.get('finish_reason')})}
        if stage == 'eval':
            trial_id = links[identifier]['data']['trialId']
            case = next(t for t in EVAL['trials'] if t['id'] == trial_id)['caseId']
            fixed_input = next(c for c in EVAL['plan']['cases'] if c['id'] == case)['input']
            assert next(m['content'] for m in payload['messages'] if m['role'] == 'user') == fixed_input
            entry.update({'trialId': trial_id, 'guestOrdinal': links[identifier]['data']['guestDispatchOrdinal'], 'fixedInputMatched': True, 'link': source(links[identifier])})
        result.append(entry)
    assert len(result) == len(lookup['budget.reserve']) == len(lookup['budget.settle']) == len(lookup['provider.http'])
    assert len({r['id'] for r in result}) == len(result)
    return result


MANIFEST = read(BATCH / 'frozen-manifest.json')
START = read(BATCH / 'paid-start.json')
assert checked(START['manifest']) == raw(BATCH / 'frozen-manifest.json')
checked(START['grant'])
END = read(BATCH / 'batch-result.json')
EVAL = read(BATCH / 'live-eval-result.json')
IMPROVE = read(BATCH / 'live-improve-result.json')
REOPENED = read(BATCH / 'reopened-improve-report.json')
LEDGER = read(BATCH / 'cumulative-budget.json')
PROPOSAL = json.loads(checked(MANIFEST['proposal']))
ARTIFACT = json.loads(checked(MANIFEST['artifact']))
IDENTITY = json.loads(checked(ARTIFACT['producerIdentity']))
BUILD = json.loads(checked(ARTIFACT['sourceBuild']))
assert MANIFEST['batchId'] == START['batchId'] == EVAL['planId']
assert END['status'] == 'STOPPED_NO_EXECUTABLE_CHAIN' and END['stage'] == 'improve'
assert IMPROVE['improve'] == REOPENED['report'] and REOPENED['result'] == IMPROVE
assert len(IMPROVE['improve']['candidates']) == len(IMPROVE['improve']['selected']) == 0

old_index = read(BATCH.parent / 'final-9aed1af-usd3-r2/postrun-diagnosis/read-identities.json')
for identity in old_index:
    checked(identity)
old_result = read(BATCH.parent / 'final-9aed1af-usd3-r2/live-eval-result.json')
assert old_result['trials'][0]['grade']['judgment'] == 'PASS'
assert old_result['trials'][1]['outcome']['status'] == 'error' and old_result['trials'][1]['grade']['judgment'] == 'unknown'

EO = BATCH / 'eval-data/objects'
IO = BATCH / 'improve-data/objects'
eh = [f for f in facts(BATCH / 'eval-data/host.sqlite', EO) if f['runId'] == EVAL['planId']]
ih = [f for f in facts(BATCH / 'improve-data/host.sqlite', IO) if f['runId'] == IMPROVE['runId']]
er = requests(eh, EO, 'eval')
ir = requests(ih, IO, 'improve')
assert len(er) == 18 and sum(r['settlementData']['tokens'] for r in er) == 34061
assert len(ir) == 1 and ir[0]['rawUsage']['total_tokens'] == 952
assert ir[0]['rawAssembledSha256'] == '32104d7dc8f7ef436b2f65544a3ec748e1c4a282f6c7a318dc970a1889421555'
assert len(by_kind(ih)['model.dispatch']) == 1 and len(by_kind(ih)['model.dispatch-failed']) == 1
failed = by_kind(ih)['model.dispatch-failed'][0]
assert failed['data']['dispatched'] is False and failed['data']['attemptDispatched'] is False and failed['data']['reason'] == 'BUDGET_UNKNOWN_USAGE'
assert len(by_kind(ih)['tool.result']) == 1 and len(by_kind(ih)['improve.summary']) == 1
assert not by_kind(ih)['improve.decision'] and not by_kind(ih)['improve.writeback']
assert LEDGER['knownRequests'] == 15 + len(er) + len(ir) == 34
assert LEDGER['knownTokens'] == 27499 + 34061 == 61560
assert LEDGER['reservedTokens'] == 1056768 and LEDGER['chargedUpperTokens'] == 1118328 and LEDGER['boundExceeded'] is False

trials = []
for t in EVAL['trials']:
    outcome, grade = t['outcome'], t['grade']
    assert outcome['status'] == 'completed' and outcome['started'] and outcome['valid'] and grade['judgment'] == 'PASS'
    assert grade['checks'] == [{'name': 'scope', 'passed': True}, {'name': 'task', 'passed': True}]
    runtime = json.loads(blob(EO, outcome['runtimeResult']))
    guest_ref = next(a['ref'] for a in outcome['artifacts'] if a['path'] == 'data/host.sqlite')
    blob(EO, guest_ref)
    guest = facts(EO / guest_ref['sha256'], EO)
    # Keep project artifact content as data. Never execute captured code or commands.
    project = [{'path': a['path'], 'ref': a['ref'], 'content': blob(EO, a['ref']).decode()} for a in outcome['artifacts'] if a['path'].startswith('project/') and '/.git/' not in a['path']]
    cases = [r for r in er if r['trialId'] == t['id']]
    trials.append({'id': t['id'], 'caseId': t['caseId'], 'outcome': {k: outcome.get(k) for k in ['source', 'status', 'started', 'valid', 'reason']},
                   'grade': grade, 'hostRequests': len(cases), 'hostTokens': sum(r['settlementData']['tokens'] for r in cases),
                   'runtimeResult': {'ref': outcome['runtimeResult'], **{k: runtime.get(k) for k in ['runId', 'status', 'reason', 'cleanup', 'executionCleanup', 'usage']}},
                   'guestDatabase': guest_ref, 'guestKindCounts': dict(collections.Counter(f['kind'] for f in guest)), 'projectArtifacts': project})
assert [(t['caseId'],t['hostRequests'],t['hostTokens']) for t in trials] == [('multi-file',8,15574),('regression',7,15142),('no-change',3,3345)]

code = []
for relative in ['src/provider-boundary.ts', 'src/improve.ts', 'src/runtime.ts']:
    identity = next(i for i in BUILD['inputs'] if i['path'] == relative)
    checked({'path': str(WORKTREE / relative), 'bytes': identity['bytes'], 'sha256': identity['sha256']})
    code.append({'relative': relative, 'path': str(WORKTREE / relative), 'identity': identity, 'binding': 'matches frozen accepted source-build inputs'})
installed = Path(ARTIFACT['installation']) / 'node_modules/pi-durio'
for relative in ['dist/src/provider-boundary.js', 'dist/src/improve.js', 'node_modules/openai/core/streaming.mjs', 'node_modules/openai/package.json', 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js', 'node_modules/@earendil-works/pi-ai/package.json']:
    identity = next(i for i in IDENTITY['installed'] if i['path'] == relative)
    checked({'path': str(installed / relative), 'bytes': identity['bytes'], 'sha256': identity['sha256']})
    code.append({'relative': relative, 'path': str(installed / relative), 'identity': identity, 'binding': 'matches frozen accepted installed candidate identity'})
fixture = []
for relative, sha in MANIFEST['fixture']['fileHashes'].items():
    data = raw(Path(PROPOSAL['improve']['workspace']) / relative)
    assert hashlib.sha256(data).hexdigest() == sha
    fixture.append({'path': relative, 'sha256': sha, 'bytes': len(data), 'unchanged': True})

selected_timeline = []
for f in ih:
    if f['seq'] < 65:
        continue
    if f['kind'] in ['provider.bytes','budget.reserve','provider.dispatch','provider.http','model.http','model.provider-event','budget.settle','model.response','tool.dispatch','improve.summary','tool.result','generation.request','model.intent','model.fetch-intent','model.dispatch-failed','submission.settled','improve.report','run.closed']:
        data = f['data']
        if f['kind'] in ['model.intent','model.fetch-intent','model.dispatch-failed']:
            data = {k:v for k,v in data.items() if k not in ['body','messages','system','tools','options']}
        selected_timeline.append({'source': source(f), 'data': data})

for identity in list(READS.values()):
    checked(identity)
output = {'scope': 'Read-only postrun extraction from closed original databases; no product import, provider, VM, credential read, or code execution from evidence',
          'failureId': 'LIVE-USD3-R3-01', 'manifest': READS[str(BATCH / 'frozen-manifest.json')], 'product': ARTIFACT['producer'],
          'paidStart': START, 'batchResult': END, 'originalCumulativeLedger': LEDGER, 'eval': {'kindCounts': dict(collections.Counter(f['kind'] for f in eh)), 'requests': er, 'trials': trials},
          'improve': {'runId': IMPROVE['runId'], 'kindCounts': dict(collections.Counter(f['kind'] for f in ih)), 'requests': ir, 'originalResult': IMPROVE,
                      'reopenedReportMatchesExactly': True, 'timeline': selected_timeline, 'fixtureFiles': fixture,
                      'candidateSelection': 'UNAVAILABLE: zero candidates; no user selection, deterministic candidate check, activation or writeback performed'},
          'accounting': {'oldPhysicalDispatches':15, 'newEvalPhysicalDispatches':18, 'newImprovePhysicalDispatches':1, 'cumulativePhysicalDispatches':34,
                         'newRawHttp200':19, 'hostKnownTokens':61560, 'hostReservedTokens':1056768, 'hostUnknown':1, 'hostChargedUpperTokens':1118328,
                         'conservativeKnownUsd':0.073872, 'conservativeChargedUpperUsd':1.3419936,
                         'posthocImproveRawUsageTokens':952, 'posthocAllRawTokens':62512, 'posthocRawEstimateUsd':0.0750144,
                         'rule':'952 is separately observed raw response usage. Original UNKNOWN settlement/reservation and cumulative ledger remain unchanged; do not add SDK/guest mirrors.', 'accountBill':'NOT OBSERVED'},
          'originalFailurePreserved': {'priorReadIdentitiesVerified':len(old_index), 'localFix':'PASS', 'multiFileOutcome':'error', 'multiFileGrade':'unknown', 'originalBatch':'STOPPED'},
          'currentAcceptanceGap':'LIVE-USD3-R3-01 affects actual #23 improve, discovered by #30. Historical offline PASS remains scoped to its candidate/time; current real path is failed with zero candidates.',
          'codeBindings':code, 'originalsVerifiedUnchanged':len(READS), 'realCredentialReads':0, 'newProviderCallsByDiagnosis':0, 'newVmStartsByDiagnosis':0, 'productExecutionsByDiagnosis':0}
save('observed-facts.json', output)
save('read-identities.json', list(READS.values()))
save('originals-unchanged.json', {'status':'PASS','scope':'Hash and byte count reread of every collector input after extraction; original r2 identities also verified','count':len(READS),'priorCount':len(old_index),'identitiesFile':'read-identities.json'})
print(json.dumps({'status':'READ_ONLY_FACTS_VERIFIED','newDispatches':19,'newEvalPass':3,'hostKnownTokens':61560,'hostReservedTokens':1056768,'improveRawTokens':952,'improveCandidates':0,'failureId':'LIVE-USD3-R3-01','originalsVerifiedUnchanged':len(READS)}))
