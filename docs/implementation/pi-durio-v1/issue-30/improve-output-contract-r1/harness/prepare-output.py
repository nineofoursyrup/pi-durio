#!/usr/bin/env python3
"""Prepare a fresh input revision from closed evidence; never import product or credentials."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PREVIOUS = ROOT.with_name('improve-only-repair-r2')
SEED = ROOT.with_name('final-9aed1af') / 'improve-data'
LIMITS = {'maxRequests': 8, 'maxTokens': 1200000, 'cumulativeMaxRequests': 49, 'cumulativeMaxTokens': 2362794, 'usdCeiling': 3, 'grantToStartMs': 86400000, 'activeMs': 3600000, 'starts': 1}
BATCH = 'pi-durio-v1-live-r4-improve-report'


def identity(path):
    assert path.name != 'api.env'
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def read(path):
    assert path.name != 'api.env'
    return json.loads(path.read_text())


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


assert not (ROOT / 'preparation.json').exists()
prior = read(PREVIOUS / 'frozen-manifest.json')
assert identity(PREVIOUS / 'frozen-manifest.json')['sha256'] == 'c1a3904f047ff3c19b16ba7c7e66dc57316f2ff9ad08a7080791ee5babe5fb2a'
assert identity(PREVIOUS / 'cumulative-budget.json')['sha256'] == '70ed19f4d827abdc020eada8fddeca2316ece0fee3617381d96b0eb7a6eadc28'
protected = read(PREVIOUS / 'postrun-readback/read-identities.json')
for entry in protected:
    assert identity(Path(entry['path'])) == entry
assert not list(SEED.rglob('*-wal')) and not list(SEED.rglob('*-shm'))
with sqlite3.connect('file:' + str(SEED / 'host.sqlite') + '?mode=ro&immutable=1', uri=True) as db:
    kinds = [row[0] for row in db.execute('select distinct kind from records')]
    assert not any(kind == 'provider.dispatch' or kind.startswith('improve.') for kind in kinds)
subprocess.run(['/bin/cp', '-cR', str(SEED), str(ROOT / 'improve-data')], check=True)
assert os.stat(SEED / 'host.sqlite').st_ino != os.stat(ROOT / 'improve-data/host.sqlite').st_ino
tree = []
for path in sorted((ROOT / 'improve-data').rglob('*')):
    if path.is_file():
        item = identity(path)
        relative = str(path.relative_to(ROOT / 'improve-data'))
        assert identity(SEED / relative)['sha256'] == item['sha256']
        tree.append({'path': relative, 'bytes': item['bytes'], 'sha256': item['sha256']})

previous = {key: identity(PREVIOUS / name) for key, name in {
    'manifest': 'frozen-manifest.json', 'proposal': 'proposed-batch-reviewed.json', 'paidStart': 'paid-start.json',
    'grant': 'explicit-human-grant.json', 'authorizationSource': 'authorization-source.json', 'batchResult': 'batch-result.json',
    'improveResult': 'live-improve-result.json', 'reopenedReport': 'reopened-improve-report.json', 'cumulativeBudget': 'cumulative-budget.json',
    'postrunReport': 'postrun-readback/report.json', 'protectedIndex': 'postrun-readback/read-identities.json'
}.items()}
shutil.copyfile(PREVIOUS / 'provider-observation.json', ROOT / 'provider-observation.json')
diagnosis = Path('/Users/nineofour/pi-durio-v1-run/review/improve-only-repair-r2-output')
support = [identity(diagnosis / name) for name in ['DIAGNOSIS.md', 'probe-result.json', 'inputs.json', 'probe.mjs', 'collect-inputs.py', 'first-collector-failure.json']]
support.extend([identity(PREVIOUS / 'postrun-readback/REPORT.md'), identity(Path('/Users/nineofour/pi-durio-v1-run/review/improve-only-repair-r2/independent-review.json'))])
preparation = {
    'status': 'PREPARATION_ONLY_INPUT_REVISION_NOT_PAID', 'batchId': BATCH, 'output': str(ROOT),
    'artifact': prior['artifact'], 'candidateGate': prior['candidateGate'], 'fixture': prior['fixture'],
    'purpose': identity(ROOT / 'purpose.txt'), 'prior': prior['prior'], 'previousImprove': previous,
    'providerObservation': identity(ROOT / 'provider-observation.json'), 'limits': LIMITS, 'stages': prior['stages'],
    'initialDataRoots': [identity(ROOT / 'improve-data/host.sqlite')], 'initialSeedTree': tree,
    'supportingEvidence': support, 'seedProvenance': 'Independent APFS copy of original synthetic seed; no failed paid run copied.',
    'futureDecision': 'One analysis only. No future candidate is selected, executed, validated or written by this preparation or its future paid grant.',
    'changes': 'Same f26ae8f product, installation, validator and protected target; exact confirmed purpose, new IDs/dataRoot and cumulative prior accounting only.',
    'protectedOriginalsChecked': len(protected), 'credentialReads': 0, 'productExecutions': 0, 'providerRequests': 0, 'vmStarts': 0
}
save(ROOT / 'preparation.json', preparation)
save(ROOT / 'grant-template-NOT-EXECUTABLE.json', {'paidApproved': False, 'manifestSha256': None, 'batchId': BATCH, 'humanAuthorization': None, 'authorizationSource': None, 'credentialSource': '/Users/nineofour/Durio/api.env', 'grantedAt': None, 'limits': LIMITS, 'note': 'No fresh human paid-start approval exists. New frozen manifest and independent review must precede a new direct human one-start approval.'})
save(ROOT / 'authorization-source-template-NOT-EXECUTABLE.json', {'kind': 'improve-output-contract-one-start', 'author': 'human-user', 'source': {'kind': 'codex-user-reply', 'requestToolCallId': None}, 'manifestSha256': None, 'batchId': BATCH, 'priorManifestSha256': previous['manifest']['sha256'], 'priorBudgetSha256': previous['cumulativeBudget']['sha256'], 'receivedAt': None, 'exactHumanReply': None, 'limits': LIMITS, 'note': 'Template only. Coordinator must capture a new actual human reply to this revision; previous r2 approval is consumed.'})
for entry in protected:
    assert identity(Path(entry['path'])) == entry
print(json.dumps({'status': preparation['status'], 'seedFiles': len(tree), 'priorOriginalsUnchanged': len(protected), 'newGrant': False}))
