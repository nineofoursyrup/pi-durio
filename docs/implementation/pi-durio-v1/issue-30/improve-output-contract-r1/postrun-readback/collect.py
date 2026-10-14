#!/usr/bin/env python3
"""Read closed evidence only. Never import product code, credentials, or execute captured text."""
import collections
import hashlib
import json
from pathlib import Path
import re
import sqlite3

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent
DATA = ROOT / 'improve-data'
OBJECTS = DATA / 'objects'
READS = {}


def raw(path):
    path = Path(path).resolve()
    assert str(path).startswith('/Users/nineofour/pi-durio-v1-run/')
    assert path.name != 'api.env', 'CREDENTIAL_READ_FORBIDDEN'
    data = path.read_bytes()
    identity = {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if str(path) in READS:
        assert READS[str(path)] == identity, 'ORIGINAL_CHANGED_DURING_READ:' + str(path)
    READS[str(path)] = identity
    return data


def read(path):
    return json.loads(raw(path))


def identity(path):
    raw(path)
    return READS[str(Path(path).resolve())]


def checked(entry):
    assert identity(entry['path']) == entry
    return entry


def blob(ref):
    data = raw(OBJECTS / ref['sha256'])
    assert len(data) == ref['bytes'] and hashlib.sha256(data).hexdigest() == ref['sha256']
    return data


def save(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode() if not isinstance(value, bytes) else value
    with path.open('xb') as stream:
        stream.write(data)
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


# Snapshot only preexisting originals, excluding this new derived-report directory.
original_paths = [p for p in sorted(ROOT.rglob('*')) if p.is_file() and OUT not in p.parents]
for path in original_paths:
    data = raw(path)
    if path.parent.name == 'objects':
        assert hashlib.sha256(data).hexdigest() == path.name
assert not list(DATA.rglob('*-wal')) and not list(DATA.rglob('*-shm')), 'CLOSED_DB_REQUIRED'

manifest = read(ROOT / 'frozen-manifest.json')
assert identity(ROOT / 'frozen-manifest.json')['sha256'] == '809aa5350c2d1d3cd3fac9281210ce41e2ff643e889a565bd15f25ae02e30856'
for entry in [manifest['proposal'], manifest['artifact'], manifest['candidateGate'], manifest['providerObservation'], *manifest['harness'], *manifest['supportingEvidence']]:
    checked(entry)
artifact = read(manifest['artifact']['path'])
for entry in [artifact['producerIdentity'], artifact['sourceBuild']]:
    checked(entry)
prior_originals = read(checked(manifest['previousImprove']['protectedIndex'])['path'])
for entry in prior_originals:
    checked(entry)
for entry in manifest['previousImprove'].values():
    checked(entry)

batch = read(ROOT / 'batch-result.json')
live = read(ROOT / 'live-improve-result.json')
reopened = read(ROOT / 'reopened-improve-report.json')
ledger = read(ROOT / 'cumulative-budget.json')
paid = read(ROOT / 'paid-start.json')
grant = read(checked(paid['grant'])['path'])
authorization = read(checked(grant['authorizationSource'])['path'])
checked(paid['manifest'])
assert grant['manifestSha256'] == paid['manifest']['sha256'] == authorization['manifestSha256']
assert authorization['author'] == 'human-user' and authorization['source']['kind'] == 'codex-user-reply'
assert authorization['source']['requestToolCallId'] and authorization['exactHumanReply'] == grant['humanAuthorization']
assert authorization['receivedAt'] == grant['grantedAt']
run_id = live['runId']
assert batch['runId'] == run_id

with sqlite3.connect('file:' + str(DATA / 'host.sqlite') + '?mode=ro&immutable=1', uri=True) as db:
    journal = []
    for seq, owner, kind, at, body in db.execute('select seq,run_id,kind,at,body from records order by seq'):
        ref = json.loads(body)
        journal.append({'seq': seq, 'runId': owner, 'kind': kind, 'at': at, 'ref': ref, 'data': json.loads(blob(ref))})
records = [row for row in journal if row['runId'] == run_id]
kinds = collections.defaultdict(list)
for row in records:
    kinds[row['kind']].append(row)


def event(row):
    return {'seq': row['seq'], 'kind': row['kind'], 'at': row['at'], 'sourceId': 'e1:' + str(row['seq']) + ':' + row['ref']['sha256'], 'body': {'path': str(OBJECTS / row['ref']['sha256']), **row['ref']}}


for name in ['generation.request', 'model.intent', 'model.payload', 'model.fetch-intent', 'model.dispatch', 'model.http', 'model.response', 'budget.reserve', 'provider.dispatch', 'provider.http', 'budget.settle']:
    assert len(kinds[name]) == 4, (name, len(kinds[name]))
assert not kinds['model.dispatch-failed'] and not kinds['tool.error']
assert not [row for row in records if row['kind'].startswith(('validation.', 'activation.', 'selection.', 'candidate.'))]

requests = []
raw_chunks = []
for index, dispatch in enumerate(kinds['provider.dispatch'], 1):
    request_id = dispatch['data']['id']
    related = [row for row in records if row['data'].get('id') == request_id]
    settlement = next(row for row in related if row['kind'] == 'budget.settle')
    reservation = next(row for row in related if row['kind'] == 'budget.reserve')
    http = next(row for row in related if row['kind'] == 'provider.http')
    chunks = [row for row in related if row['kind'] == 'provider.bytes']
    body = blob(dispatch['data']['body'])
    payload = json.loads(body)
    assert payload['model'] == 'deepseek-flash' and payload['stream'] is True and payload['max_tokens'] == 8192
    assert payload['messages'] == kinds['model.payload'][index - 1]['data']['payload']['messages']
    request_copy = save('raw/request-%02d.json' % index, body)
    response = b''.join(blob(row['data']['bytes']) for row in chunks)
    response_copy = save('raw/response-%02d.sse' % index, response)
    lines = response.decode().splitlines()
    assert sum(line == 'data: [DONE]' for line in lines) == 1
    assert response.endswith(b'data: [DONE]\n\n')
    frames = [json.loads(line[6:]) for line in lines if line.startswith('data: ') and line != 'data: [DONE]']
    usage_frames = [frame['usage'] for frame in frames if frame.get('usage')]
    assert len(usage_frames) == 1
    usage = usage_frames[0]
    assert usage['prompt_tokens'] + usage['completion_tokens'] == usage['total_tokens'] == settlement['data']['tokens']
    assert settlement['data']['status'] == 'returned' and http['data']['status'] == 200
    assert settlement['seq'] > chunks[-1]['seq']
    models = sorted({frame['model'] for frame in frames if frame.get('model')})
    fingerprints = sorted({frame['system_fingerprint'] for frame in frames if frame.get('system_fingerprint')})
    finish = sorted({choice['finish_reason'] for frame in frames for choice in frame.get('choices', []) if choice.get('finish_reason')})
    content = ''.join(choice.get('delta', {}).get('content') or '' for frame in frames for choice in frame.get('choices', []))
    tools = collections.defaultdict(lambda: {'name': '', 'arguments': ''})
    for frame in frames:
        for choice in frame.get('choices', []):
            for call in choice.get('delta', {}).get('tool_calls', []):
                function = call.get('function', {})
                tools[call['index']]['name'] += function.get('name') or ''
                tools[call['index']]['arguments'] += function.get('arguments') or ''
    if index == 4:
        assert content == live['answer'], 'RAW_FINAL_ANSWER_MUST_MATCH_LIVE_RESULT'
    requests.append({'index': index, 'requestId': request_id, 'dispatch': event(dispatch), 'reservation': {**event(reservation), 'value': reservation['data']}, 'http': {**event(http), 'status': http['data']['status']}, 'settlement': {**event(settlement), 'value': settlement['data']}, 'requestBodySource': {'path': str(OBJECTS / dispatch['data']['body']['sha256']), **dispatch['data']['body']}, 'requestCopy': request_copy, 'rawResponseCopy': response_copy, 'rawChunks': len(chunks), 'rawUsage': usage, 'rawDoneSentinels': 1, 'terminalThenSettlement': True, 'responseModels': models, 'systemFingerprints': fingerprints, 'finishReasons': finish, 'requestedModel': payload['model'], 'maxOutputTokens': payload['max_tokens'], 'toolNamesAvailable': [tool.get('function', {}).get('name') for tool in payload.get('tools', [])], 'responseToolCalls': list(tools.values()), 'textBytes': len(content.encode()), 'textSha256': hashlib.sha256(content.encode()).hexdigest()})
    raw_chunks.append({'index': index, 'requestId': request_id, 'requestCopy': request_copy, 'assembledResponse': response_copy, 'chunks': [{**event(row), 'rawBytes': {'path': str(OBJECTS / row['data']['bytes']['sha256']), **row['data']['bytes']}} for row in chunks]})

assert sum(row['rawUsage']['total_tokens'] for row in requests) == 24585
assert ledger['stages'][0]['requests'] == 4 and ledger['stages'][0]['knownTokens'] == 24585 and ledger['stages'][0]['unknown'] == 0 and ledger['stages'][0]['reservedTokens'] == 0
assert ledger['knownRequests'] == 45 and ledger['knownTokens'] == 130611 and ledger['reservedTokens'] == 1056768 and ledger['chargedUpperTokens'] == 1187379
assert ledger['conservativeChargedUpperUsd'] == 1.4248548 and ledger['boundExceeded'] is False
assert live['usage']['value']['models']['deepseek/deepseek-flash']['totalTokens'] == 24585
report = live['improve']
assert report == reopened['report'] and report == kinds['improve.report'][0]['data']
assert report['state'] == 'complete' and len(report['candidates']) == 1 and report['selected'] == []
candidate = report['candidates'][0]
assert candidate['execution'] == 'not-started' and candidate['effect'] == 'unverified' and candidate['selection'] == 'unselected'
assert batch['status'] == 'AWAITING_ACTUAL_CANDIDATE_SELECTION' and live['status'] == 'completed' and live['cleanup'] == 'confirmed' and live['lifecycle']['storage'] == 'closed'
assert kinds['model.response'][-1]['data']['message']['content'][0]['text'] == live['answer']
assert kinds['submission.settled'][0]['data']['status'] == 'done'

# Only index the captured text for factual readback. No product parser/validator runs.
answer = live['answer']
text_object = json.loads(answer)
assert len(text_object['candidates']) == 1
assert not answer.strip().startswith('```')
answer_copy = save('raw-analysis-answer.txt', answer.encode())
candidate_copy = save('canonical-candidate-copy.json', candidate)
raw_index = {'status': 'SINGLE_JSON_FORMAL_REPORT_COMPLETE_NOT_SELECTED_OR_EXECUTED', 'answer': answer_copy, 'objectKeys': list(text_object), 'rawProposedDraftCount': 1, 'rawSummaryText': text_object['summary'], 'rawGapsText': text_object['gaps'], 'formalReportState': report['state'], 'formalCandidateCount': 1, 'selectedCandidateCount': 0, 'formalReason': report['reason'], 'canonicalCandidate': candidate_copy, 'warning': 'A structurally complete report does not verify model claims or authorize selection, validation, writeback, activation or execution. Candidate source and revisions are unchanged.'}

fixture_checks = []
proposal = read(manifest['proposal']['path'])
for relative, sha in manifest['fixture']['fileHashes'].items():
    item = identity(Path(proposal['improve']['workspace']) / relative)
    assert item['sha256'] == sha
    fixture_checks.append(item)
timeline_kinds = {'budget.reserve', 'provider.dispatch', 'provider.http', 'budget.settle', 'model.response', 'tool.intent', 'tool.dispatch', 'tool.result', 'improve.derived', 'improve.summary', 'submission.settled', 'usage.projection', 'lifecycle.close-started', 'lifecycle.storage-closing', 'lifecycle.storage-closed', 'improve.report', 'run.closed'}
timeline = []
for row in records:
    if row['kind'] not in timeline_kinds:
        continue
    value = row['data']
    if row['kind'] == 'model.response':
        message = value['message']
        summary = {'attemptId': value['attemptId'], 'stopReason': message.get('stopReason'), 'usage': message.get('usage'), 'contentTypes': [part['type'] for part in message.get('content', [])], 'tools': [part.get('name') for part in message.get('content', []) if part['type'] == 'toolCall']}
    elif row['kind'] in ['improve.report', 'run.closed']:
        summary = {key: value.get(key) for key in ['status', 'state', 'reason', 'cleanup', 'lifecycle', 'revision'] if key in value}
        if 'candidates' in value:
            summary['candidateCount'] = len(value['candidates'])
    elif row['kind'] in ['tool.result', 'improve.derived', 'improve.summary']:
        summary = {key: value.get(key) for key in ['attemptId', 'tool', 'status', 'isError', 'sourceId', 'reason', 'state'] if key in value}
    else:
        summary = value
    timeline.append({**event(row), 'summary': summary})

request_file = save('requests.json', requests)
chunk_file = save('raw-chunk-index.json', raw_chunks)
timeline_file = save('timeline.json', timeline)
raw_index_file = save('raw-answer-index.json', raw_index)
summary_files = [save('evidence-summary-%d.json' % row['seq'], row['data']) for row in kinds['improve.summary']]
fixture_file = save('fixture-readback.json', {'status': 'ALL_FOUR_MATCH_FROZEN_BASELINE', 'files': fixture_checks})

diagnosis_root = Path('/Users/nineofour/pi-durio-v1-run/review/improve-output-contract-r1-candidate')
diagnosis_files = [identity(diagnosis_root / name) for name in ['STATIC-ANALYSIS.md', 'static-analysis.json']]
diagnosis = read(diagnosis_root / 'static-analysis.json')
assert identity(diagnosis_root / 'static-analysis.json')['sha256'] == 'f1eca720d5005ba5c90908ba87b7876bd96fe486cabf3dda9c55ba46e86dcf77'
assert diagnosis['status'] == 'STATIC_CANDIDATE_REVIEW_ONLY_NO_EXECUTION'
assert diagnosis['reportRevision'] == report['revision'] and diagnosis['candidateRevision'] == candidate['revision']
checked(diagnosis['reportSource'])
for entry in diagnosis['protected']:
    checked(entry)

# Repeat the exact observed identities after all data inspection and derived writes.
original_identities = list(READS.values())
for entry in original_identities:
    checked(entry)
read_index_file = save('read-identities.json', original_identities)
facts = {
    'status': 'READ_ONLY_POSTRUN_VERIFIED',
    'manifest': identity(ROOT / 'frozen-manifest.json'),
    'candidate': artifact['integratedSource'], 'producer': artifact['producer'], 'sourceBuild': artifact['sourceBuild'],
    'authorization': {'source': identity(ROOT / 'authorization-source.json'), 'author': authorization['author'], 'origin': authorization['source'], 'receivedAt': authorization['receivedAt'], 'paidStart': identity(ROOT / 'paid-start.json'), 'consumed': True, 'newAuthorizationCreatedByReadback': False},
    'startedAt': paid['startedAt'], 'endedAt': batch['at'], 'launchExit': read(ROOT / 'launch-exit.json'),
    'batchStatus': batch['status'], 'runId': run_id, 'taskId': live['taskId'], 'sessionId': live['sessionId'],
    'runtime': {'status': live['status'], 'observation': live['observation'], 'cleanup': live['cleanup'], 'lifecycle': live['lifecycle']},
    'formalReport': {'id': report['id'], 'revision': report['revision'], 'state': report['state'], 'candidateCount': 1, 'selectedCount': 0, 'reason': report['reason'], 'summary': report['summary'], 'gaps': report['gaps'], 'record': event(kinds['improve.report'][0]), 'liveEqualsReopenedAndPersistedReport': True},
    'newHostAccounting': {'requests': 4, 'http200': 4, 'completeRawSse': 4, 'terminalUsageEqualSettlements': 4, 'knownTokens': 24585, 'unknown': 0, 'reservedTokens': 0, 'conservativeKnownUsd': 24585 * 12 / 10000000},
    'cumulativeHostAccounting': {'requests': 45, 'knownTokens': 130611, 'retainedOldUnknownTokens': 1056768, 'chargedUpperTokens': 1187379, 'conservativeChargedUpperUsd': 1.4248548, 'boundExceeded': False, 'ledger': identity(ROOT / 'cumulative-budget.json'), 'accountBill': 'Not observed'},
    'sdkMirror': {'tokens': 24585, 'catalogEstimateUsd': live['usage']['value']['models']['deepseek/deepseek-flash']['cost']['total'], 'addedToHostAccounting': False},
    'rawProviderIdentity': {'models': sorted({model for item in requests for model in item['responseModels']}), 'fingerprints': sorted({fp for item in requests for fp in item['systemFingerprints']}), 'immutableModelVersionOrWeightsProven': False},
    'rawText': {'proposedDraftCount': 1, 'formallyRegisteredCandidateCount': 1, 'answer': answer_copy, 'index': raw_index_file, 'notSelectedOrExecuted': True},
    'eventCountsForActualRunOnly': dict(collections.Counter(row['kind'] for row in records)),
    'toolsObserved': dict(collections.Counter(row['data']['tool'] for row in kinds['tool.dispatch'])),
    'noNewToolErrors': len(kinds['tool.error']) == 0,
    'canonicalCandidate': {'id': candidate['id'], 'display': candidate['display'], 'revision': candidate['revision'], 'conditionKey': candidate['conditionKey'], 'target': candidate['target'], 'scope': candidate['scope'], 'execution': candidate['execution'], 'effect': candidate['effect'], 'selection': candidate['selection'], 'copy': candidate_copy},
    'coordinatorStaticReviewOnly': {'files': diagnosis_files, 'conclusion': diagnosis['reasoningError'], 'proposalAssessment': diagnosis['proposalAssessment'], 'rawTransportAndSettlement': 'PASS_FOR_THIS_FOUR_REQUEST_RUN', 'formalOutputShape': 'COMPLETE_CANDIDATE_REGISTERED', 'semanticAcceptance': 'NOT_CLAIMED', 'originalReportOrCandidateModified': False},
    'artifacts': {'requests': request_file, 'rawChunkIndex': chunk_file, 'timeline': timeline_file, 'evidenceSummaries': summary_files, 'fixtureReadback': fixture_file, 'originalReadIdentities': read_index_file},
    'preservation': {'beforeAfterIdentities': len(original_identities), 'currentBatchOriginalFiles': len(original_paths), 'closedPriorFilesChecked': len(prior_originals), 'allMatched': True, 'priorUnknownRewritten': False},
    'limitations': ['Static algebra review identifies an incorrect original hypothesis and contradictory summary; both remain preserved in canonical report.', 'Formal candidate identity and complete report state are structural results, not semantic acceptance or execution authorization.', 'No candidate or protected check was executed; effect remains unverified.', 'Provider alias/fingerprint are observed response metadata, not immutable model version or weights proof.', 'Remote termination remains unknown as recorded; local storage closed and cleanup confirmed.'],
    'readbackEffects': {'credentialReads': 0, 'newProviderCalls': 0, 'newVmStarts': 0, 'productImportsOrExecutions': 0, 'originalWrites': 0, 'candidateActions': 0, 'rootOrStatusWrites': 0}
}
report_file = save('report.json', facts)
print(json.dumps({'status': facts['status'], 'report': report_file, 'hostRequests': 4, 'knownTokens': 24585, 'formalCandidates': 1, 'rawDrafts': 1, 'originalsUnchanged': len(original_identities)}))
