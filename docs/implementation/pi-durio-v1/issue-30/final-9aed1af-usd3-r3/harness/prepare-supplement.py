#!/usr/bin/env python3
"""Create an unsigned supplemental proposal from closed snapshots; never run product/provider."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

NEW = Path(__file__).resolve().parent.parent
OLD = NEW.with_name('final-9aed1af-usd3-r2')
SEED = NEW.with_name('final-9aed1af')


def file(path):
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def read(path):
    assert path.name != 'api.env'
    return json.loads(path.read_text())


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    path.chmod(0o600)


assert not (NEW / 'proposed-batch-reviewed.json').exists(), 'Do not overwrite preparation'
assert file(OLD / 'frozen-manifest.json')['sha256'] == '51ff05f19a55cd14653f1f00dc7a07d4bc5f9931b7107091ad5207ce0e269486'
old = read(OLD / 'frozen-manifest.json')
original = read(Path(old['proposal']['path']))
facts = read(OLD / 'postrun-diagnosis/observed-facts.json')
assert facts['accounting']['physicalHostDispatches'] == 15
assert facts['accounting']['knownTokens'] == 27499
assert facts['accounting']['unknownSettlements'] == 0
assert facts['batchResult']['status'] == 'STOPPED'
preserved = read(OLD / 'postrun-diagnosis/read-identities.json')
for entry in preserved:
    assert file(Path(entry['path'])) == entry

# Only unopened original seed roots are cloned. The paid r2 database is never copied as a new run.
initial = []
for name in ['eval-data', 'improve-data']:
    root = SEED / name
    assert not list(root.rglob('*-wal')) and not list(root.rglob('*-shm'))
    with sqlite3.connect('file:' + str(root / 'host.sqlite') + '?mode=ro&immutable=1', uri=True) as db:
        kinds = dict(db.execute('select kind,count(*) from records group by kind'))
        if name == 'eval-data':
            assert set(kinds) == {'eval.content', 'eval.plan', 'evidence.fixed'}
        else:
            assert not any(k.startswith('improve.') for k in kinds)
    subprocess.run(['/bin/cp', '-cR', str(root), str(NEW / name)], check=True)
    assert os.stat(root / 'host.sqlite').st_ino != os.stat(NEW / name / 'host.sqlite').st_ino
    assert file(root / 'host.sqlite')['sha256'] == file(NEW / name / 'host.sqlite')['sha256']
    initial.append(file(NEW / name / 'host.sqlite'))

prior_budget = {'requests': 15, 'knownTokens': 27499, 'reservedTokens': 0, 'unknown': 0, 'conservativeEstimateUsd': 0.0329988}
local, failed = facts['trials'][:2]
ledger = {'prior': prior_budget, 'originalStatus': 'STOPPED', 'localFixTrialId': local['id'], 'localFixOutcome': local['originalOutcome']['source'], 'localFixGrade': local['originalGrade']['source'], 'failedTrialId': failed['id'], 'failedOutcome': failed['originalOutcome']['source'], 'failedGrade': failed['originalGrade']['source'], 'originalGrade': 'unknown', 'basis': '15 distinct host requests; retained raw usage matched every settlement; guest/SDK usage mirrors are not added; account billing not observed'}
save(NEW / 'prior-budget-ledger.json', ledger)
prior = {'manifest': file(OLD / 'frozen-manifest.json'), 'proposal': file(Path(old['proposal']['path'])), 'paidStart': file(OLD / 'paid-start.json'), 'batchResult': file(OLD / 'batch-result.json'), 'liveResult': file(OLD / 'live-eval-result.json'), 'readIndex': file(OLD / 'postrun-diagnosis/read-identities.json'), 'diagnosis': file(OLD / 'postrun-diagnosis/report.json'), 'ledger': file(NEW / 'prior-budget-ledger.json')}
shutil.copy2(OLD / 'provider-observation.json', NEW / 'provider-observation.json')
observation = file(NEW / 'provider-observation.json')
p = json.loads(json.dumps(original))
p['batchId'] = p['evalPlan']['id'] = 'pi-durio-v1-live-r2-usd3-supplement'
p['evalPlan']['purpose'] = 'One supplemental real-provider batch: three unchanged single trials after retained first failure; prior local-fix PASS reused; no first-attempt 4/4 or population claim'
cases = ['multi-file', 'regression', 'no-change']
p['evalPlan']['cases'] = [c for c in p['evalPlan']['cases'] if c['id'] in cases]
p['evalPlan']['trials'] = [{**t, 'id': 'v1-live-r2-' + t['caseId']} for t in p['evalPlan']['trials'] if t['caseId'] in cases]
p['evalPlan']['budget'].update(maxRequests=24, maxTokens=1172501)
p['evalDataRoot'] = str(NEW / 'eval-data')
p['evalDirectory'] = str(NEW / 'live-eval')
p['improve']['dataRoot'] = str(NEW / 'improve-data')
p['improve']['request']['id'] = 'v1-live-r2-improve'
p['aggregate'].update(maxRequests=32, maxTokens=2372501, conservativePriceEstimateUsd=2.8470012)
p['aggregate']['cumulative'] = {'prior': prior_budget, 'maxRequests': 47, 'maxTokens': 2400000, 'conservativePriceEstimateUsd': 2.88, 'requestedUsdCeiling': 3}
p['credential']['readiness'] = 'PENDING_NEW_EXPLICIT_ONE_START; no credential read during preparation'
p['providerRecheck'] = observation
p['supplement'] = {'priorEvidence': prior, 'reusedCase': 'local-fix', 'retryOf': {'v1-live-r2-multi-file': 'v1-live-r1-multi-file'}, 'reporting': 'Original STOPPED and first failure remain unchanged; supplemental coverage is reported separately'}
save(NEW / 'proposed-batch-reviewed.json', p)
limits = {'maxRequests': 32, 'maxTokens': 2372501, 'cumulativeMaxRequests': 47, 'cumulativeMaxTokens': 2400000, 'usdCeiling': 3, 'grantToStartMs': 86400000, 'activeMs': 3600000, 'starts': 1}
stages = {'eval': {'maxRequests': 24, 'maxTokens': 1172501, 'maxRequestTokens': 1052672, 'maxOutputTokens': 4096}, 'improve': {'maxRequests': 8, 'maxTokens': 1200000, 'maxRequestTokens': 1056768, 'maxOutputTokens': 8192}}
manifest = {'version': 3, 'batchId': p['batchId'], 'status': 'FROZEN_SUPPLEMENT_PENDING_NEW_EXPLICIT_ONE_START', 'proposal': file(NEW / 'proposed-batch-reviewed.json'), 'artifact': old['artifact'], 'output': str(NEW), 'harness': [file(path) for path in sorted((NEW / 'harness').iterdir()) if path.is_file()], 'fixture': old['fixture'], 'caseSource': old['caseSource'], 'providerObservation': observation, 'limits': limits, 'stages': stages, 'prior': prior, 'initialDataRoots': initial, 'supportingEvidence': old['supportingEvidence'], 'futureDecision': old['futureDecision'], 'seedProvenance': 'Original synthetic seed, original read-only fixture workspace and product unchanged; cloned closed seed roots only; failed paid r2 run never copied or overwritten', 'derivation': {'previousFrozenManifest': prior['manifest'], 'productChanged': False, 'supplementalCaseDisposition': 'Retain first failure; reuse prior local-fix PASS and execute three fresh trials only; this is not a first-attempt four-of-four batch'}}
# This is a checked draft identity until source tests succeed. Final freezing copies these exact bytes.
save(NEW / 'checked-manifest.json', manifest)
save(NEW / 'grant-template-NOT-EXECUTABLE.json', {'paidApproved': False, 'manifestSha256': file(NEW / 'checked-manifest.json')['sha256'], 'batchId': p['batchId'], 'humanAuthorization': None, 'authorizationSource': None, 'credentialSource': '/Users/nineofour/Durio/api.env', 'grantedAt': None, 'limits': limits, 'note': 'Not executable. After independent review the coordinator must obtain a NEW explicit one-start human grant bound to this exact manifest and cumulative ledger. Original authorization is consumed. No actual credential reads or starts during preparation.'})
save(NEW / 'authorization-source-template-NOT-EXECUTABLE.json', {'kind': 'supplemental-one-start', 'manifestSha256': file(NEW / 'checked-manifest.json')['sha256'], 'batchId': p['batchId'], 'priorManifestSha256': prior['manifest']['sha256'], 'receivedAt': None, 'exactHumanReply': None, 'limits': limits, 'note': 'Template only; no user authorization has been received for this supplemental start.'})
for entry in preserved:
    assert file(Path(entry['path'])) == entry
save(NEW / 'derivation.json', {'status': 'PREPARED_NOT_STARTED_PENDING_CHECK_AND_REVIEW', 'product': '9aed1af6ee3b156bb7354961496217aa5e64843e', 'previousManifest': prior['manifest'], 'checkedManifest': file(NEW / 'checked-manifest.json'), 'initialDataRoots': initial, 'originalFilesPreserved': len(preserved), 'originalChanges': 0, 'realCredentialReads': 0, 'providerRequests': 0, 'restrictedVmStarts': 0, 'productBuilds': 0, 'clones': 'Independent APFS inodes; only original closed seed roots; existing synthetic seed provenance unchanged'})
print(json.dumps(file(NEW / 'checked-manifest.json')))
