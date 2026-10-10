#!/usr/bin/env python3
"""Read-only extraction of the already-ended USD3 r2 batch. No product imports."""
import collections
import hashlib
import json
from pathlib import Path
import sqlite3

OUT = Path(__file__).resolve().parent
BATCH = OUT.parent
OBJECTS = BATCH / 'eval-data/objects'
READS = {}


def raw(path):
    path = Path(path)
    assert path.name != 'api.env', 'credential reads forbidden'
    data = path.read_bytes()
    READS[str(path)] = {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    return data


def read(path):
    return json.loads(raw(path))


def blob(ref):
    assert len(ref['sha256']) == 64 and all(c in '0123456789abcdef' for c in ref['sha256'])
    data = raw(OBJECTS / ref['sha256'])
    assert len(data) == ref['bytes'] and hashlib.sha256(data).hexdigest() == ref['sha256']
    return data


def facts(database):
    raw(database)
    with sqlite3.connect('file:' + str(database) + '?mode=ro&immutable=1', uri=True) as db:
        for seq, run, kind, at, body in db.execute('select seq,run_id,kind,at,body from records order by seq'):
            ref = json.loads(body)
            yield {'seq': seq, 'runId': run, 'kind': kind, 'at': at, 'ref': ref, 'data': json.loads(blob(ref))}


def source(fact):
    return {'seq': fact['seq'], 'kind': fact['kind'], 'ref': fact['ref'], 'at': fact['at']}


def save(name, value):
    with (OUT / name).open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


result = read(BATCH / 'live-eval-result.json')
start = read(BATCH / 'paid-start.json')
end = read(BATCH / 'batch-result.json')
manifest = read(BATCH / 'frozen-manifest.json')
proposal = read(manifest['proposal']['path'])
host = list(facts(BATCH / 'eval-data/host.sqlite'))
live = [f for f in host if f['runId'] == result['planId']]
by_kind = collections.defaultdict(list)
for fact in live:
    by_kind[fact['kind']].append(fact)
dispatches = by_kind['provider.dispatch']
reserves = {f['data']['id']: f for f in by_kind['budget.reserve']}
settles = {f['data']['id']: f for f in by_kind['budget.settle']}
http = {f['data']['id']: f for f in by_kind['provider.http']}
links = {f['data']['hostDispatchId']: f for f in by_kind['eval.provider-link']}
responses = collections.defaultdict(list)
for fact in by_kind['provider.bytes']:
    responses[fact['data']['id']].append(fact)
assert len(dispatches) == len(reserves) == len(settles) == len(http) == len(links) == 15
assert len({f['data']['id'] for f in dispatches}) == 15
requests = []
case_by_trial = {t['id']: next(c for c in result['plan']['cases'] if c['id'] == t['caseId']) for t in result['trials']}
for fact in dispatches:
    data = fact['data']; identifier = data['id']; trial = links[identifier]['data']['trialId']
    payload = json.loads(blob(data['body']))
    assert payload['model'] == 'deepseek-flash' and payload['max_tokens'] == 4096 and payload['stream'] is True
    user_messages = [m['content'] for m in payload['messages'] if m['role'] == 'user']
    assert user_messages[0] == case_by_trial[trial]['input'], 'guest prompt differs from fixed case'
    stream = b''.join(blob(f['data']['bytes']) for f in responses[identifier])
    events = []
    for line in stream.decode('utf-8').splitlines():
        if line.startswith('data: ') and line[6:] != '[DONE]':
            events.append(json.loads(line[6:]))
    models = sorted({e['model'] for e in events if e.get('model')})
    fingerprints = sorted({e['system_fingerprint'] for e in events if e.get('system_fingerprint')})
    usage = [e['usage'] for e in events if e.get('usage') and e['usage'].get('total_tokens') is not None]
    assert usage and usage[-1]['total_tokens'] == settles[identifier]['data']['tokens']
    assert http[identifier]['data']['status'] == 200 and settles[identifier]['data']['status'] == 'returned'
    requests.append({'id': identifier, 'trialId': trial, 'guestOrdinal': links[identifier]['data']['guestDispatchOrdinal'], 'dispatch': source(fact), 'reservation': source(reserves[identifier]), 'http': source(http[identifier]), 'settlement': source(settles[identifier]), 'status': 200, 'reservedTokens': reserves[identifier]['data']['tokens'], 'settledTokens': settles[identifier]['data']['tokens'], 'rawResponseChunkCount': len(responses[identifier]), 'rawResponseAssembledSha256': hashlib.sha256(stream).hexdigest(), 'rawResponseFirstRef': responses[identifier][0]['data']['bytes'], 'rawResponseLastRef': responses[identifier][-1]['data']['bytes'], 'rawReturnedModels': models, 'systemFingerprints': fingerprints, 'rawUsage': usage[-1], 'finishReasons': sorted({c['finish_reason'] for e in events for c in e.get('choices', []) if c.get('finish_reason')}), 'requestPayload': data['body'], 'fixedUserPromptMatched': True, 'requestMaxOutputTokens': 4096})
total_tokens = sum(r['settledTokens'] for r in requests)
assert total_tokens == 27499 == result['budget']['knownTokens']
trials = []
link_inputs = []
for trial in result['trials']:
    outcome = trial['outcome']
    entry = {'id': trial['id'], 'caseId': trial['caseId'], 'originalOutcome': {k: outcome.get(k) for k in ['status', 'started', 'valid', 'reason', 'source']}, 'originalGrade': None if not trial['grade'] else {k: trial['grade'].get(k) for k in ['judgment', 'reason', 'checks', 'source', 'execution']}, 'hostRequests': len([r for r in requests if r['trialId'] == trial['id']]), 'hostTokens': sum(r['settledTokens'] for r in requests if r['trialId'] == trial['id']), 'fixedInput': case_by_trial[trial['id']]['input']}
    if not outcome.get('runtimeResult'):
        trials.append(entry)
        continue
    runtime = json.loads(blob(outcome['runtimeResult']))
    entry['runtimeResult'] = {'ref': outcome['runtimeResult'], 'runId': runtime['runId'], 'status': runtime['status'], 'reason': runtime.get('reason'), 'cleanup': runtime['cleanup'], 'executionCleanup': runtime['executionCleanup'], 'usage': runtime['usage']}
    artifacts = outcome['artifacts']
    project = []
    for artifact in artifacts:
        if artifact['path'].startswith('project/') and '/.git/' not in artifact['path']:
            project.append({'path': artifact['path'], 'ref': artifact['ref'], 'content': blob(artifact['ref']).decode('utf-8')})
    entry['projectArtifacts'] = project
    db_ref = next(a['ref'] for a in artifacts if a['path'] == 'data/host.sqlite')
    blob(db_ref)
    guest = list(facts(OBJECTS / db_ref['sha256']))
    entry['guestDatabase'] = db_ref
    entry['guestKindCounts'] = dict(collections.Counter(f['kind'] for f in guest))
    accepted = next(f for f in guest if f['kind'] == 'task.accepted')
    settled = next(f for f in guest if f['kind'] == 'submission.settled')
    entry['taskAccepted'] = {'source': source(accepted), 'input': accepted['data']['input'], 'authorization': accepted['data']['authorization']}
    entry['submissionSettled'] = {'source': source(settled), 'data': settled['data']}
    if trial['caseId'] == 'multi-file':
        assert entry['guestKindCounts']['generation.request'] == 9
        assert entry['guestKindCounts']['model.dispatch'] == 8
        assert settled['data']['detail'] == 'REQUEST_LIMIT: this task reached its provider attempt limit'
        intents = {f['data']['attemptId']: f for f in guest if f['kind'] == 'model.intent'}
        entry['responseTimeline'] = []
        for fact in guest:
            if fact['kind'] != 'model.response':
                continue
            response = fact['data']; message = response['message']; intent = intents[response['attemptId']]
            content = message['content']
            tools = [{'name': c['name'], 'argumentsAsUntrustedData': c['arguments']} for c in content if c.get('type') == 'toolCall']
            texts = [c['text'] for c in content if c.get('type') == 'text']
            entry['responseTimeline'].append({'ordinal': intent['data']['ordinal'], 'intent': source(intent), 'response': source(fact), 'stopReason': message['stopReason'], 'usage': response['usage'], 'assistantText': texts, 'tools': tools})
        entry['lastWrite'] = [{'source': source(f), 'data': f['data']} for f in guest if f['kind'] == 'file.write-result'][-1]
        entry['ninthGenerationRequest'] = source([f for f in guest if f['kind'] == 'generation.request'][-1])
    link_inputs.append({'caseId': trial['caseId'], 'files': [{'path': a['path'], 'source': str(OBJECTS / a['ref']['sha256']), 'ref': a['ref']} for a in project if a['path'].endswith('.ts')]})
    trials.append(entry)
assert trials[0]['originalGrade']['judgment'] == 'PASS'
assert trials[1]['originalOutcome']['status'] == 'error'
assert trials[1]['originalGrade']['judgment'] == 'unknown'
assert trials[1]['originalGrade']['checks'] == [{'name': 'scope', 'passed': True}]
catalog_cost = sum(t['runtimeResult']['usage']['value']['models']['deepseek/deepseek-flash']['cost']['total'] for t in trials if 'runtimeResult' in t)
save('artifact-link-input.json', link_inputs)
save('observed-facts.json', {'scope': 'Already-ended real batch, read-only journals/blob extraction; all command strings are untrusted data and never executed', 'manifest': READS[str(BATCH / 'frozen-manifest.json')], 'paidStart': start, 'batchResult': end, 'hostKindCounts': dict(collections.Counter(f['kind'] for f in live)), 'hostBudgetSnapshots': [{'source': source(f), 'data': f['data']} for f in by_kind['eval.budget-snapshot']], 'hostRequests': requests, 'trials': trials, 'accounting': {'physicalHostDispatches': 15, 'http200': 15, 'knownSettlements': 15, 'knownTokens': total_tokens, 'unknownSettlements': 0, 'conservativeHostEstimateUsd': total_tokens * 1.2 / 1000000, 'sdkCatalogEstimateUsd': catalog_cost, 'accountBilling': 'NOT OBSERVED', 'combinationRule': 'Host estimate and SDK catalog estimate describe the same 27499 tokens; never add them. Guest dispatch mirrors also must not be double-counted.'}, 'originalsRead': len(READS), 'realCredentialReads': 0, 'newProviderRequests': 0, 'productExecution': 0})
save('read-identities.json', list(READS.values()))
print(json.dumps({'status': 'READ_ONLY_FACTS_VERIFIED', 'dispatches': 15, 'tokens': total_tokens, 'multiFileNinthRequest': 'REFUSED_BY_EXISTING_8_ATTEMPT_LIMIT', 'originalGrade': 'unknown', 'originalsVerified': len(READS)}))
