#!/usr/bin/env python3
"""Static JSON/identity/syntax and actual unauthorized-entry checks only; never run candidate/check/API."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
checks = []


def read(path):
    path = Path(path)
    assert path.name != 'api.env'
    return json.loads(path.read_text())


def identity(path):
    path = Path(path)
    assert path.name != 'api.env'
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def checked(entry):
    assert identity(entry['path']) == entry, entry['path']


def save(name, value):
    with (ROOT / name).open('x') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')


manifest = read(ROOT / 'frozen-plan-manifest.json')
for entry in manifest['inputs']:
    checked(entry)
checks.append('all frozen input identities match')
plan = read(manifest['plan']['path'])
draft = read(manifest['decisionDraft']['path'])
decision = draft['draftDecision']
authorization = read(ROOT / 'authorization-template-NOT-EXECUTABLE.json')
assert draft['authorized'] is False and draft['actualChoice'] is None
assert plan['authorized'] is False and plan['actualChoice'] is None
assert authorization['authorized'] is False and authorization['choice'] is None and authorization['grantedAt'] is None
assert decision['limits'] == {'deadline': None, 'maxChecks': 1, 'maxRequests': 0, 'maxTokens': 0}
checks.append('all actual authorization fields false/null; public deadline null; no executable public decision file')
canonical = read(plan['report']['canonicalSource']['path'])['improve']
candidate = canonical['candidates'][0]
assert len(canonical['candidates']) == 1 and canonical['selected'] == []
assert decision['reportId'] == canonical['id'] and decision['reportRevision'] == canonical['revision']
assert len(decision['selections']) == 1
selection = decision['selections'][0]
assert selection == {'candidateId': candidate['id'], 'candidateRevision': candidate['revision'], 'target': candidate['target'], 'steps': candidate['steps'], 'mode': 'execute-declared-scope', 'formal': {'writeback': True, 'activate': None, 'failureCompensation': 'none'}}
assert candidate['execution'] == 'not-started' and candidate['selection'] == 'unselected' and candidate['effect'] == 'unverified'
checks.append('exact original candidate/report/target/steps/revisions bound without canonical edits')
assert len(decision['groups']) == 1
group = decision['groups'][0]
assert group['candidateIds'] == [candidate['id']] and len(group['changes']) == len(group['checks']) == 1
change = group['changes'][0]
assert change == {'targetId': 'clamp-project', 'path': 'clamp.ts', 'content': (ROOT / 'proposed-clamp.txt').read_text()}
assert hashlib.sha256(change['content'].encode()).hexdigest() == plan['writeback']['after']
assert group['checks'][0] == {'kind': 'regression', 'program': (ROOT / 'protected-regression.mjs').read_text(), 'timeoutMs': 30000}
assert candidate['scope'] == ['clamp.ts'] and not candidate['dependencies'] and not candidate['conflicts']
assert 'Math.min(upper, Math.max(lower, value))' in change['content']
checks.append('one fixed scope/content/regression with unchanged protected check; zero provider budget')
assert plan['time']['grantToStartMs'] == 86400000 and plan['time']['activeMs'] == 300000 and plan['time']['starts'] == 1
assert Path(plan['data']['clone']).parent == ROOT and Path(decision['directory']).parent == ROOT
assert not ROOT.is_relative_to(Path(candidate['target']['workspace']))
for forbidden in ['decision-data', 'validation-work', 'execution-start.json', 'authorized-decision.json', 'actual-selection.json']:
    assert not (ROOT / forbidden).exists(), forbidden
checks.append('new non-overlapping paths remain absent; approval-relative one-start timing fixed')
for entry in candidate['target']['files']:
    actual = identity(Path(candidate['target']['workspace']) / entry['path'])
    assert actual['sha256'] == entry['sha256'] and actual['bytes'] == entry['bytes']
assert identity(plan['rollback']['beforeBytesRetained'])['sha256'] == plan['writeback']['before']
checks.append('four original target files and immutable rollback before bytes match baseline')
seed = read(manifest['closedSeed']['path'])
assert seed['globalCutoff'] == 4298 and seed['recordCounts']['provider.dispatch'] == 4
seed_files = [p for p in sorted(Path(seed['root']).rglob('*')) if p.is_file()]
assert len(seed_files) == len(seed['files']) == 3427
for entry in seed['files']:
    actual = identity(Path(seed['root']) / entry['path'])
    assert actual['sha256'] == entry['sha256'] and actual['bytes'] == entry['bytes']
assert plan['budget']['priorCumulativeRequests'] == 45 and plan['budget']['priorChargedUpperUsd'] == 1.4248548
assert plan['data']['cloneOriginalProviderDispatches'] == 4 and plan['data']['cloneGlobalCutoff'] == 4298
checks.append('closed clone seed and global cutoff fixed; inherited four requests excluded from new accounting')
originals = read(ROOT.parent / 'postrun-readback/read-identities.json')
for entry in originals:
    checked(entry)
checks.append('all 15558 postrun original identities unchanged')
source = (ROOT / 'execute-selected.mjs').read_text()
assert source.index("authorization.authorized,true") < source.index('cpSync(seed.root') < source.index("api=await load('pi-durio/improve-decisions')")
assert 'runtime.open' not in source and 'analyzeImprove' not in source and 'DEEPSEEK_API_KEY' not in source
assert "deadline=new Date(startedAt.getTime()+plan.time.activeMs)" in source
assert "process.exitCode=1;throw error" in source
checks.append('source order denies before effects; no analysis/provider setup; final receipt failure exits nonzero')
syntax = []
for name in ['common.mjs', 'execute-selected.mjs', 'protected-regression.mjs']:
    result = subprocess.run(['/opt/homebrew/bin/node', '--check', str(ROOT / name)], capture_output=True, text=True, env={'PATH': '/opt/homebrew/bin:/usr/bin:/bin'})
    assert result.returncode == 0, result.stderr
    syntax.append({'file': name, 'exitCode': result.returncode, 'execution': 'syntax-only'})
checks.append('three JavaScript files parse; candidate and regression were not executed')
denials = []
for name, argument, expected in [('false-template', ROOT / 'authorization-template-NOT-EXECUTABLE.json', 'EXPLICIT_CANDIDATE_CHOICE_REQUIRED'), ('missing-actual-selection', ROOT / 'actual-selection.json', 'ENOENT')]:
    result = subprocess.run(['/opt/homebrew/bin/node', str(ROOT / 'execute-selected.mjs'), str(argument)], capture_output=True, text=True, env={'PATH': '/opt/homebrew/bin:/usr/bin:/bin'})
    assert result.returncode != 0 and expected in result.stderr and result.stdout == '', name
    denials.append({'name': name, 'exitCode': result.returncode, 'expectedError': expected, 'status': 'DENIED_BEFORE_PRODUCT_IMPORT_OR_WRITES', 'stderr': result.stderr})
for forbidden in ['decision-data', 'validation-work', 'execution-start.json', 'authorized-decision.json', 'actual-selection.json']:
    assert not (ROOT / forbidden).exists(), forbidden
for entry in manifest['inputs']:
    checked(entry)
for entry in originals:
    checked(entry)
save('preparation-checks.json', {'status': 'PASS_STATIC_AND_UNAUTHORIZED_ENTRY_ONLY', 'manifest': identity(ROOT / 'frozen-plan-manifest.json'), 'staticChecks': checks, 'syntax': syntax, 'actualEntryDenials': denials, 'postrunOriginalsUnchangedBeforeAfter': len(originals), 'seedFiles': len(seed_files), 'publicPreviewCalled': False, 'candidateValidated': False, 'productApiCalls': 0, 'providerCalls': 0, 'vmStarts': 0, 'formalWrites': 0, 'decisionDataClones': 0, 'testsReused': 'Existing #24/#25 behavior checks remain applicable to unchanged installed product; no product tests rerun. This is plan preparation, not a product execution PASS.'})
print(json.dumps({'status': 'PASS_STATIC_AND_UNAUTHORIZED_ENTRY_ONLY', 'staticChecks': len(checks), 'entryDenials': len(denials), 'originalsUnchanged': len(originals), 'candidateValidated': False}))
