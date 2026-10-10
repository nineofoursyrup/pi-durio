#!/usr/bin/env python3
"""One-time USD 3 derivative: no prepare/build/product/provider execution."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

OLD = Path('/Users/nineofour/pi-durio-v1-run/evidence/issue-30/final-9aed1af')
NEW = OLD.with_name('final-9aed1af-usd3')
SOURCE = Path(__file__).resolve().parent
AUTH = Path('/Users/nineofour/pi-durio-v1-run/preparation/issue-30/user-budget-20261010.json')
OBS = AUTH.parent / 'provider-usd3-20261010'


def file(path):
    raw = path.read_bytes()
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    path.chmod(0o600)


def diff(a, b, path=''):
    if isinstance(a, dict) and isinstance(b, dict):
        return [d for k in sorted(a.keys() | b.keys()) for d in diff(a.get(k), b.get(k), f'{path}.{k}'.lstrip('.'))]
    if a != b:
        return [{'path': path, 'before': a, 'after': b}]
    return []


assert not NEW.exists(), 'New output already exists; do not overwrite or resume preparation'
for name in ['paid-start.json', 'authorized-plan.json']:
    assert not (OLD / name).exists(), 'Original batch already started'
old_manifest = json.loads((OLD / 'frozen-manifest.json').read_text())
assert file(OLD / 'frozen-manifest.json')['sha256'] == 'd5272b244660c2a54a2fc70d1f5c50785ed20edf92a3dfb78a7e24ef7dfb3a22'
original = json.loads(Path(old_manifest['proposal']['path']).read_text())
assert file(Path(old_manifest['proposal']['path'])) == old_manifest['proposal']
preserved = [file(p) for p in sorted(OLD.iterdir()) if p.is_file()]
preserved += [file(OLD / root / 'host.sqlite') for root in ['eval-data', 'improve-data']]
preserved += [file(p) for p in sorted((OLD / 'improve-project').iterdir())]
with sqlite3.connect('file:' + str(OLD / 'eval-data/host.sqlite') + '?mode=ro', uri=True) as db:
    kinds = dict(db.execute('select kind,count(*) from records group by kind').fetchall())
    assert set(kinds) == {'eval.content', 'eval.plan', 'evidence.fixed'}, 'Original eval has execution records'
with sqlite3.connect('file:' + str(OLD / 'improve-data/host.sqlite') + '?mode=ro', uri=True) as db:
    assert db.execute("select count(*) from records where kind like 'improve.%'").fetchone()[0] == 0, 'Original improve started'
NEW.mkdir(mode=0o700)
(NEW / 'harness').mkdir(mode=0o700)
for path in sorted(SOURCE.iterdir()):
    if path.is_file():
        shutil.copy2(path, NEW / 'harness' / path.name)

# APFS clone gives new inodes and independent writes without rebuilding 12k blobs.
# Databases are closed snapshots; no WAL/SHM or ownership lease is copied.
for root in ['eval-data', 'improve-data']:
    assert not list((OLD / root).rglob('*-wal'))
    assert not list((OLD / root).rglob('*-shm'))
    subprocess.run(['/bin/cp', '-cR', str(OLD / root), str(NEW / root)], check=True)
    assert os.stat(OLD / root / 'host.sqlite').st_ino != os.stat(NEW / root / 'host.sqlite').st_ino
    assert file(OLD / root / 'host.sqlite')['sha256'] == file(NEW / root / 'host.sqlite')['sha256']

observation = {
    'observedAt': json.loads((OBS / 'retrieval.json').read_text())['at'],
    'method': 'Coordinator unauthenticated direct HTTP 200 official documentation snapshot; no authenticated model or account observation',
    'retrieval': file(OBS / 'retrieval.json'),
    'sources': [file(OBS / name) for name in ['pricing.html', 'models.html']],
    'pricingSource': 'https://api-docs.deepseek.com/quick_start/pricing/',
    'modelSource': 'https://api-docs.deepseek.com/api/list-models/',
    'model': 'deepseek-flash', 'documentedVersion': 'DeepSeek-V4.1-Flash',
    'contextTokens': 1048576, 'maximumDocumentedOutputTokens': 393216,
    'currency': 'USD', 'maximumListedUsdPerMillionAnyClass': 1.2,
    'aggregateTokens': 2400000, 'conservativeTokenPriceEstimateUsd': 2.88, 'usdCeiling': 3,
    'credentialAccess': 'NOT RUN', 'authenticatedAvailability': 'NOT RUN',
    'limit': 'Public observed tariff, not an invoice, account hard cap, or proof of immutable served model. A known tariff change must stop dispatch.'
}
save(NEW / 'provider-observation.json', observation)
proposal = json.loads(json.dumps(original))
proposal['batchId'] = proposal['evalPlan']['id'] = 'pi-durio-v1-live-r1-usd3'
proposal['evalPlan']['budget']['maxTokens'] = 1200000
proposal['improve']['request']['limits']['maxTokens'] = 1200000
proposal['evalDataRoot'] = str(NEW / 'eval-data')
proposal['evalDirectory'] = str(NEW / 'live-eval')
proposal['improve']['dataRoot'] = str(NEW / 'improve-data')
proposal['aggregate'].update(maxTokens=2400000, conservativePriceEstimateUsd=2.88, requestedUsdCeiling=3)
proposal['credential']['source'] = '/Users/nineofour/Durio/api.env'
proposal['credential']['readiness'] = 'USER_SOURCE_AUTHORIZED; contents not read during preparation; readiness confirmation required before execution'
proposal['providerRecheck'] = file(NEW / 'provider-observation.json')
save(NEW / 'proposed-batch-reviewed.json', proposal)
limits = dict(maxRequests=40, maxTokens=2400000, usdCeiling=3, grantToStartMs=86400000, activeMs=3600000, starts=1)
stages = {'eval': dict(maxRequests=32, maxTokens=1200000, maxRequestTokens=1052672, maxOutputTokens=4096), 'improve': dict(maxRequests=8, maxTokens=1200000, maxRequestTokens=1056768, maxOutputTokens=8192)}
manifest = {**old_manifest, 'version': 2, 'batchId': proposal['batchId'], 'status': 'FROZEN_USD3_PENDING_COORDINATOR_GRANT_AND_CREDENTIAL_READINESS', 'proposal': file(NEW / 'proposed-batch-reviewed.json'), 'output': str(NEW), 'harness': [file(p) for p in sorted((NEW / 'harness').iterdir()) if p.is_file()], 'limits': limits, 'stages': stages, 'providerObservation': file(NEW / 'provider-observation.json'), 'authorizationEvidence': file(AUTH), 'derivation': {'originalManifest': file(OLD / 'frozen-manifest.json'), 'productChanged': False, 'generator': 'derive.py external one-time derivative; original product prepare.mjs retained as historical generator'}, 'supportingEvidence': [file(OBS / name) for name in ['retrieval.json', 'pricing.html', 'models.html']], 'seedProvenance': 'Original synthetic seed facts retained unchanged; original workspace identity retained for read-only analysis; copied closed data root; new output independent'}
save(NEW / 'frozen-manifest.json', manifest)
save(NEW / 'grant-template-NOT-EXECUTABLE.json', {'paidApproved': False, 'manifestSha256': file(NEW / 'frozen-manifest.json')['sha256'], 'batchId': proposal['batchId'], 'humanAuthorization': json.loads(AUTH.read_text())['budgetAuthorization']['exactHumanReply'], 'authorizationSource': file(AUTH), 'credentialSource': '/Users/nineofour/Durio/api.env', 'grantedAt': json.loads(AUTH.read_text())['receivedAt'], 'limits': limits, 'note': 'Template only. Coordinator must review, confirm credential readiness and workload isolation, then create explicit-human-grant.json without changing the original grant time. This task creates no executable grant.'})
for entry in preserved:
    assert file(Path(entry['path'])) == entry, 'Original evidence changed'
save(NEW / 'derivation.json', {'status': 'PREPARED_NOT_STARTED', 'base': '14787f0dfaadf69b6c235e5bb650d9f923a5d5a1', 'product': '9aed1af6ee3b156bb7354961496217aa5e64843e', 'original': file(OLD / 'frozen-manifest.json'), 'manifest': file(NEW / 'frozen-manifest.json'), 'proposalDelta': diff(original, proposal), 'originalEvalKinds': kinds, 'preservedOriginals': preserved, 'dataRootDerivation': 'APFS clone of closed existing data roots; separate inode/writes; no generator, new seed, VM or provider; original fixture workspace used read-only to retain source identity', 'reusedBodies': {'common': 'byte-identical', 'run': 'identity/API/materialization/cancel/retry/cleanup body byte-identical from const identity onward; only preflight replaced'}, 'credentialRead': False, 'paidRequests': 0})
print(json.dumps(file(NEW / 'frozen-manifest.json')))
