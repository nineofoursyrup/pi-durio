#!/usr/bin/env python3
"""Read existing JSON, blobs and closed SQLite only. Never import product code or execute retained commands."""
from pathlib import Path
from datetime import datetime
import hashlib
import json
import sqlite3

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent
READS = {}


def raw(path):
    path = Path(path).resolve()
    assert str(path).startswith('/Users/nineofour/pi-durio-v1-run/') and path.name != 'api.env'
    data = path.read_bytes()
    item = {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if str(path) in READS:
        assert READS[str(path)] == item, 'INPUT_CHANGED:' + str(path)
    READS[str(path)] = item
    return data


def read(path):
    return json.loads(raw(path))


def identity(path):
    raw(path)
    return READS[str(Path(path).resolve())]


def checked(entry):
    assert identity(entry['path']) == entry, entry['path']


def save(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    with path.open('xb') as output:
        output.write(data)
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def rows(root):
    assert not list(root.glob('*-wal')) and not list(root.glob('*-shm'))
    identity(root / 'host.sqlite')
    with sqlite3.connect('file:' + str(root / 'host.sqlite') + '?mode=ro&immutable=1', uri=True) as db:
        return list(db.execute('select seq,run_id,kind,at,body from records order by seq'))


manifest = read(ROOT / 'frozen-plan-manifest.json')
assert identity(ROOT / 'frozen-plan-manifest.json')['sha256'] == '686b5c023020444104cd711b809dfd01442b0568a79fa36e42484716c8f1f3fe'
for entry in manifest['inputs']:
    checked(entry)
# The historic 15558-entry pre-execution index is hash-bound only, not replayed.
# Its old formal clamp.ts entry is a historical before state, now lawfully changed.
plan = read(manifest['plan']['path'])
seed = read(manifest['closedSeed']['path'])
source = Path(seed['root'])
source_files = [p for p in sorted(source.rglob('*')) if p.is_file()]
assert len(source_files) == len(seed['files']) == 3427
assert [str(p.relative_to(source)) for p in source_files] == [e['path'] for e in seed['files']]
for entry in seed['files']:
    item = identity(source / entry['path'])
    assert item['sha256'] == entry['sha256'] and item['bytes'] == entry['bytes']

names = ['actual-selection.json', 'execution-start.json', 'execution-exit.json', 'clone-receipt.json', 'authorized-decision.json', 'public-preview.json', 'submitted-result.json', 'reopened-decision.json', 'reopened-report.json', 'formal-file-readback.json', 'new-records-index.json', 'execution-result.json']
receipt = {name: read(ROOT / name) for name in names}
for name in ['execution-r1.stdout', 'execution-r1.stderr']:
    identity(ROOT / name)
authorization, start, exit_receipt = (receipt[name] for name in ['actual-selection.json', 'execution-start.json', 'execution-exit.json'])
assert identity(ROOT / 'actual-selection.json')['sha256'] == '48a40d980bed8f81ccbc9c06888e432bffdce084bcf3320150c58a4bd507317e'
assert authorization['authorized'] is True and authorization['choice'] == 'execute-declared-scope'
assert authorization['author'] == 'human-user' and authorization['source']['kind'] == 'codex-user-reply'
assert authorization['source']['requestToolCallId'] == 'call_591912f6d1fc4caa82875122834a1df1'
assert authorization['exactHumanReply'] == '选择 R1，验证通过后仅写回 clamp.ts'
assert authorization['manifestSha256'] == start['manifest']['sha256'] == identity(ROOT / 'frozen-plan-manifest.json')['sha256']
checked(start['authorization']); checked(start['manifest']); checked(start['clonedBaseline'])
parse_time = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
assert 0 <= (parse_time(start['startedAt']) - parse_time(authorization['grantedAt'])).total_seconds() <= 86400
assert (parse_time(start['deadline']) - parse_time(start['startedAt'])).total_seconds() == 300
result = receipt['execution-result.json']
assert result['status'] == 'COMPLETED_EXACT_PROJECT_WRITEBACK'
assert start['startedAt'] <= result['at'] < start['deadline']
assert exit_receipt['attempts'] == 1 and exit_receipt['exitCode'] == 0

clone = Path(plan['data']['clone'])
original_rows, clone_rows = rows(source), rows(clone)
cutoff = seed['globalCutoff']
assert cutoff == 4298 and original_rows[-1][0] == cutoff
assert [row for row in clone_rows if row[0] <= cutoff] == original_rows
new_rows = [row for row in clone_rows if row[0] > cutoff]
assert [row[0] for row in new_rows] == list(range(4299, 4313))
assert not any(row[2].startswith(('provider.', 'budget.')) or row[2] == 'model.dispatch' for row in new_rows)
assert sum(row[2] == 'provider.dispatch' for row in clone_rows) == sum(row[2] == 'provider.dispatch' for row in original_rows) == 4
objects = clone / 'objects'


def blob(ref):
    data = raw(objects / ref['sha256'])
    assert len(data) == ref['bytes'] and hashlib.sha256(data).hexdigest() == ref['sha256']
    return data


def nested_refs(value):
    if isinstance(value, dict):
        if set(['sha256', 'bytes']) <= set(value) and isinstance(value['sha256'], str):
            blob(value)
        for child in value.values():
            nested_refs(child)
    elif isinstance(value, list):
        for child in value:
            nested_refs(child)


events = []
for seq, run_id, kind, at, body in new_rows:
    ref = json.loads(body)
    data = json.loads(blob(ref))
    nested_refs(data)
    events.append({'seq': seq, 'runId': run_id, 'kind': kind, 'at': at, 'sourceId': f'e1:{seq}:{ref["sha256"]}', 'body': {'path': str(objects / ref['sha256']), **ref}, 'data': data})
by_kind = {row['kind']: row for row in events}
assert len(by_kind) == len(events) == 14
assert receipt['new-records-index.json']['records'] == [{'seq': row['seq'], 'kind': row['kind'], 'at': row['at'], 'ref': {'sha256': row['body']['sha256'], 'bytes': row['body']['bytes']}} for row in events]
decision = receipt['authorized-decision.json']
draft = read(manifest['decisionDraft']['path'])['draftDecision']
assert decision == {**draft, 'limits': {**draft['limits'], 'deadline': start['deadline']}}
assert by_kind['improve.decision']['data']['decision'] == decision
assert by_kind['improve.group-started']['data']['reserved'] == {'checks': 1, 'requests': 0, 'tokens': 0}
submitted, reopened = receipt['submitted-result.json'], receipt['reopened-decision.json']
assert submitted == reopened and raw(ROOT / 'submitted-result.json') == raw(ROOT / 'reopened-decision.json')
assert reopened['state'] == 'completed' and reopened['writeback'] == 'written' and reopened['activation'] == 'not-enabled'
assert reopened['reserved'] == {'checks': 1, 'requests': 0, 'tokens': 0}
assert len(reopened['groups']) == 1
group = reopened['groups'][0]
assert group['state'] == 'completed' and len(group['result']['checks']) == 1
check = group['result']['checks'][0]
assert check['kind'] == 'regression' and check['state'] == 'completed'
execution = json.loads(blob(check['executionRef']))
nested_refs(execution)
assert execution['status'] == 'completed' and execution['code'] == 0 and execution['terminated'] is True
assert execution['stdout'] == 'All declared clamp requirements pass\n' and execution['stderr'] == ''
assert execution['modelRequests'] == [] and execution['output']['stdout']['bytes'] == 37
stdout = b''.join(blob(ref) for ref in execution['output']['stdout']['chunks'])
assert stdout == execution['stdout'].encode()
controls = {row['name']: row for row in execution['control']}
assert all(controls[name]['code'] == 0 for name in ['stop', 'stopped', 'delete', 'absence'])
stopped = json.loads(controls['stopped']['stdout'])
assert any(row['id'] == execution['id'] and row['status']['state'] == 'stopped' for row in stopped)
assert not any(row.get('id') == execution['id'] for row in json.loads(controls['absence']['stdout']))
assert group['result']['conclusion']['effect'] == 'direct-checks-passed' and group['result']['conclusion']['allChecksPassed'] is True
assert group['result']['conclusion']['allDeclaredBenefitsMet'] is False
assert by_kind['improve.validation']['seq'] < by_kind['improve.formal-started']['seq'] < by_kind['improve.write-intent']['seq'] < by_kind['improve.write-result']['seq'] < by_kind['improve.formal']['seq']
assert by_kind['improve.write-result']['data']['state'] == 'written'
assert by_kind['improve.formal']['data']['state'] == 'completed' and by_kind['improve.formal']['data']['activation'] == 'not-enabled'
assert len(group['writes']) == 1 and group['writes'][0]['state'] == 'written' and group['writes'][0]['file']['path'] == 'clamp.ts'

canonical = read(plan['report']['canonicalSource']['path'])['improve']
assert receipt['reopened-report.json']['report'] == canonical
assert len(receipt['reopened-report.json']['decisions']) == 1
assert all(row['runId'] == canonical['runId'] for row in events)
assert reopened['decision']['selections'][0]['candidateRevision'] == canonical['candidates'][0]['revision']
formal_files = receipt['formal-file-readback.json']['files']
for item in formal_files:
    checked(item)
expected_after = {**plan['writeback']['protected'], 'clamp.ts': plan['writeback']['after']}
workspace = Path(plan['candidate']['target']['workspace'])
assert sorted(p.name for p in workspace.iterdir()) == sorted(expected_after)
for name, expected_sha in expected_after.items():
    assert identity(workspace / name)['sha256'] == expected_sha
    artifact = next(item for item in check['artifacts'] if item['path'] == 'targets/clamp-project/' + name)
    assert artifact['ref']['sha256'] == expected_sha
assert identity(plan['rollback']['beforeBytesRetained'])['sha256'] == plan['writeback']['before']
input_root = ROOT / 'validation-work/clamp-regression/check-0/input'
assert raw(input_root / 'check.mjs') == raw(ROOT / 'protected-regression.mjs')
for item in plan['candidate']['target']['files']:
    assert identity(input_root / 'baseline/clamp-project' / item['path'])['sha256'] == item['sha256']
    assert identity(input_root / 'targets/clamp-project' / item['path'])['sha256'] == expected_after[item['path']]

ledger = read(plan['budget']['cumulativeHostLedger']['path'])
checked(plan['budget']['cumulativeHostLedger'])
assert (ledger['knownRequests'], ledger['knownTokens'], ledger['reservedTokens'], ledger['chargedUpperTokens'], ledger['conservativeChargedUpperUsd']) == (45, 130611, 1056768, 1187379, 1.4248548)
review_root = Path('/Users/nineofour/pi-durio-v1-run/review/improve-output-contract-r1-candidate')
review = read(review_root / 'independent-review.json')
assert review['standards']['status'] == review['spec']['status'] == 'PASS'
assert review['manifest']['sha256'] == identity(ROOT / 'frozen-plan-manifest.json')['sha256']
review_ids = [identity(review_root / name) for name in ['independent-review.json', 'selection-request.md', 'static-analysis.json']]
gate = read(plan['candidateGate']['path'])

mirrors = [save('receipts/' + name, raw(ROOT / name)) for name in ['actual-selection.json', 'execution-start.json', 'execution-result.json', 'execution-exit.json', 'formal-file-readback.json', 'new-records-index.json']]
mirrors += [save('receipts/' + kind + '.json', raw(by_kind[kind]['body']['path'])) for kind in ['improve.decision', 'improve.write-result', 'improve.formal']]
mirrors += [save('receipts/protected-check-execution.json', blob(check['executionRef']))]
read_identities = list(READS.values())
for item in read_identities:
    checked(item)
read_index = save('read-identities.json', read_identities)
report = {
    'status': 'ISSUE_30_REAL_IMPROVE_CHAIN_OBSERVED_COMPLETE',
    'scope': 'Read-only receipt verification of the one already authorized/executed R1 decision; no acceptance/merge/release/issue-close action.',
    'manifest': identity(ROOT / 'frozen-plan-manifest.json'),
    'humanSelection': {'receipt': identity(ROOT / 'actual-selection.json'), 'reply': authorization['exactHumanReply'], 'source': authorization['source'], 'grantedAt': authorization['grantedAt'], 'consumed': True},
    'execution': {'start': start['startedAt'], 'end': result['at'], 'deadline': start['deadline'], 'exitCode': 0, 'attempts': 1, 'result': identity(ROOT / 'execution-result.json')},
    'reportIdentity': {'id': canonical['id'], 'revision': canonical['revision'], 'canonicalUnchanged': True, 'originalReasoningErrorPreserved': True},
    'candidate': {'id': plan['candidate']['id'], 'revision': plan['candidate']['revision'], 'baseline': plan['candidate']['baseline'], 'scope': ['clamp.ts'], 'afterSha256': plan['writeback']['after']},
    'publicDecision': {'id': decision['id'], 'dataRoot': str(clone), 'sourceId': reopened['sourceId'], 'formalSourceId': group['formalSource'], 'submittedEqualsReopened': True, 'state': reopened['state'], 'writeback': reopened['writeback'], 'activation': reopened['activation']},
    'protectedValidation': {'kind': 'regression', 'checks': 1, 'state': 'completed', 'existingProtectedCases': 6, 'stdout': execution['stdout'], 'stdoutBytes': 37, 'exitCode': 0, 'checkProgramIdenticalToFrozenPlan': True, 'baselineAndCandidateConstructionHashesMatched': True, 'executionObject': {'path': str(objects / check['executionRef']['sha256']), **check['executionRef']}, 'effect': 'direct-checks-passed', 'performanceOrModelQualityClaim': False, 'allDeclaredBenefitsMet': False},
    'vmTermination': {'executionId': execution['id'], 'image': execution['image'], 'terminated': True, 'retainedStoppedReceipt': True, 'retainedDeleteReceipt': True, 'retainedAbsenceReceipt': True, 'freshControlCommandRunByReadback': False},
    'sequence': {'cloneGlobalCutoff': cutoff, 'newFrom': 4299, 'newThrough': 4312, 'newRecords': 14, 'orderedEvents': [{key: row[key] for key in ['seq', 'kind', 'at', 'sourceId', 'body']} for row in events], 'newProviderOrBudgetRecords': 0},
    'accounting': {'newProviderRequests': 0, 'newTokens': 0, 'clonedProviderDispatches': 4, 'inheritedEventsRecounted': False, 'cumulativeRequests': 45, 'knownTokens': 130611, 'retainedUnknownTokens': 1056768, 'chargedUpperTokens': 1187379, 'conservativeChargedUpperUsd': 1.4248548, 'billObserved': False},
    'preservation': {'originalAnalysisFiles': 3427, 'originalAnalysisAllMatchedFrozenSeed': True, 'cloneHistoryThroughCutoffExact': True, 'authorizedTargetChangeOnly': 'clamp.ts', 'beforeObjectRetained': identity(plan['rollback']['beforeBytesRetained']), 'afterFormalFiles': formal_files, 'old15558IndexRescanned': False, 'historicalBeforeIndexRewritten': False, 'manifestInputsMatched': len(manifest['inputs']), 'thisReadbackInputsUnchanged': len(read_identities), 'readIdentityIndex': read_index},
    'review': review_ids,
    'priorCodingEvidenceReused': {'source': plan['candidateGate'], 'passes': gate['applicability']['codingPasses'], 'rerun': False, 'originalExecutionIdentityRetained': True},
    'limitations': ['Original four coding task evidence and first failures retain their original execution identities; this decision does not replace them.', 'Original model reasoning error and the prior UNKNOWN reservation remain unchanged.', 'Deterministic project repair and protected check PASS do not prove performance, model quality or per-candidate causal improvement.', 'This #30 chain observation does not replace #31 full technical acceptance, #32 daily-use acceptance, product main merge/release or issue close.'],
    'receiptMirrors': mirrors,
    'readbackEffects': {'newProviderCalls': 0, 'productApiCalls': 0, 'vmStarts': 0, 'candidateOrCheckExecutions': 0, 'originalOrFixtureWrites': 0, 'rootOrRemoteWrites': 0}
}
report_file = save('report.json', report)
print(json.dumps({'status': report['status'], 'report': report_file, 'newRecords': 14, 'originalSeedFilesUnchanged': 3427, 'newProviderRequests': 0, 'allReadbackInputsUnchanged': len(read_identities)}))
