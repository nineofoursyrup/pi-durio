#!/usr/bin/env python3
"""Unsigned improve-only preparation. Reads closed evidence, clones original seed, never imports product."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

NEW=Path(__file__).resolve().parent.parent
R3=NEW.with_name('final-9aed1af-usd3-r3')
R2=NEW.with_name('final-9aed1af-usd3-r2')
SEED=NEW.with_name('final-9aed1af')
BATCH='pi-durio-v1-live-r3-improve-repair'
LIMITS={'maxRequests':8,'maxTokens':1200000,'cumulativeMaxRequests':42,'cumulativeMaxTokens':2318328,'usdCeiling':3,'grantToStartMs':86400000,'activeMs':3600000,'starts':1}
STAGES={'improve':{'maxRequests':8,'maxTokens':1200000,'maxRequestTokens':1056768,'maxOutputTokens':8192}}

def read(path):
 assert path.name!='api.env';return json.loads(path.read_text())
def file(path):
 assert path.name!='api.env';data=path.read_bytes();return {'path':str(path),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def save(path,value):
 with path.open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
 path.chmod(0o600)

assert not (NEW/'preparation.json').exists(),'Do not overwrite preparation'
old=read(R3/'frozen-manifest.json');ledger=read(R3/'cumulative-budget.json')
assert file(R3/'cumulative-budget.json')['sha256']=='07e58fa36dc54441da52658e2eed29a0ad35eff233b8b2817bc28b2fe1e3b997'
assert ledger['knownRequests']==34 and ledger['knownTokens']==61560 and ledger['reservedTokens']==1056768
roots=[str(R2),str(R3)]
protected=[entry for entry in read(R3/'postrun-readback/read-identities.json') if any(entry['path'].startswith(root+'/') for root in roots)]
for entry in protected:assert file(Path(entry['path']))==entry
save(NEW/'protected-prior-originals.json',{'scope':'Immutable closed r2 and r3 batch roots only. Live worktree source snapshots are retained as historical identities without constraining repaired source.','roots':roots,'entries':protected})
source=SEED/'improve-data'
assert not list(source.rglob('*-wal')) and not list(source.rglob('*-shm'))
with sqlite3.connect('file:'+str(source/'host.sqlite')+'?mode=ro&immutable=1',uri=True) as db:
 kinds=dict(db.execute('select kind,count(*) from records group by kind'))
 assert not any(k.startswith('improve.') or k=='provider.dispatch' for k in kinds)
subprocess.run(['/bin/cp','-cR',str(source),str(NEW/'improve-data')],check=True)
assert os.stat(source/'host.sqlite').st_ino!=os.stat(NEW/'improve-data/host.sqlite').st_ino
initial=[]
for path in sorted((NEW/'improve-data').rglob('*')):
 if path.is_file():
  entry=file(path);initial.append({'path':str(path.relative_to(NEW/'improve-data')),'bytes':entry['bytes'],'sha256':entry['sha256']})
  original=source/path.relative_to(NEW/'improve-data');assert file(original)['sha256']==entry['sha256']
prior={'manifest':file(R3/'frozen-manifest.json'),'proposal':file(Path(old['proposal']['path'])),'paidStart':file(R3/'paid-start.json'),'batchResult':file(R3/'batch-result.json'),'evalResult':file(R3/'live-eval-result.json'),'improveResult':file(R3/'live-improve-result.json'),'cumulativeBudget':file(R3/'cumulative-budget.json'),'postrunReport':file(R3/'postrun-readback/report.json'),'protectedIndex':file(NEW/'protected-prior-originals.json'),'protectedRoots':roots,'firstBatchResult':file(R2/'batch-result.json'),'firstEvalResult':file(R2/'live-eval-result.json')}
shutil.copyfile(R3/'provider-observation.json',NEW/'provider-observation.json')
eval_result=read(R3/'live-eval-result.json');first=read(R2/'live-eval-result.json')
passes=[next(t for t in first['trials'] if t['id']=='v1-live-r1-local-fix'),*eval_result['trials']]
coding=[{'trialId':t['id'],'outcome':t['outcome']['source'],'grade':t['grade']['source'],'candidate':'9aed1af6ee3b156bb7354961496217aa5e64843e'} for t in passes]
save(NEW/'candidate-gate-template-NOT-FROZEN.json',{'status':'PENDING','finding':'LIVE-USD3-R3-01','candidate':None,'previousCandidate':'9aed1af6ee3b156bb7354961496217aa5e64843e','repairReview':{'status':'PENDING','evidence':[]},'applicability':{'status':'PENDING','codingPasses':coding,'nativeDisposition':'RETAIN_ORIGINAL_EXECUTION_IDENTITY_WITH_BOUNDED_APPLICABILITY','evidence':[]},'note':'Coordinator supplies real independent repair review/checks and bounded applicability evidence. This template is not acceptance.'})
save(NEW/'grant-template-NOT-EXECUTABLE.json',{'paidApproved':False,'manifestSha256':None,'batchId':BATCH,'humanAuthorization':None,'authorizationSource':None,'credentialSource':'/Users/nineofour/Durio/api.env','grantedAt':None,'limits':LIMITS,'note':'No authorization received. Fill only after new frozen manifest, independent review and explicit fresh human one-start approval.'})
save(NEW/'authorization-source-template-NOT-EXECUTABLE.json',{'kind':'improve-repair-one-start','author':'human-user','source':{'kind':'codex-user-reply','requestToolCallId':None},'manifestSha256':None,'batchId':BATCH,'priorManifestSha256':prior['manifest']['sha256'],'priorBudgetSha256':prior['cumulativeBudget']['sha256'],'receivedAt':None,'exactHumanReply':None,'limits':LIMITS,'note':'Template only. Old USD3 reply is consumed and cannot be reused.'})
# Retain old immutable installed code and replace only live worktree paths by
# exact old-commit source snapshots. Historical 7280-file postrun result is unchanged.
report=read(R3/'postrun-readback/report.json')
(NEW/'prior-source-9aed1af').mkdir()
source_snapshots=[]
for row in report['codeBindings']:
 if row['relative'].startswith('src/'):
  data=subprocess.run(['git','show','9aed1af6ee3b156bb7354961496217aa5e64843e:'+row['relative']],cwd='/Users/nineofour/.codex/worktrees/issue-30-usd3/Durio',capture_output=True,check=True).stdout
  assert hashlib.sha256(data).hexdigest()==row['identity']['sha256']
  target=NEW/'prior-source-9aed1af'/Path(row['relative']).name
  with target.open('xb') as stream:stream.write(data)
  source_snapshots.append({'originalObservedPath':row['path'],'gitCandidate':'9aed1af6ee3b156bb7354961496217aa5e64843e','gitPath':row['relative'],'retained':file(target)})
not_closed=[entry for entry in read(R3/'postrun-readback/read-identities.json') if not any(entry['path'].startswith(root+'/') for root in roots)]
immutable=[entry for entry in not_closed if ('/src/' not in entry['path'] or '/dist/src/' in entry['path']) and '/improve-project/' not in entry['path']]
assert len(immutable)==9 and len(source_snapshots)==3
for entry in immutable:assert file(Path(entry['path']))==entry
save(NEW/'retained-prior-code.json',{'previousCandidate':'9aed1af6ee3b156bb7354961496217aa5e64843e','status':'ORIGINAL_CODE_IDENTITY_RETAINED','immutableBindings':immutable,'sourceSnapshots':source_snapshots,'exclusionExplanation':{'from7280':16,'mutableWorktreeSourcesReplacedByExactGitSnapshots':3,'immutableExternalProductBindingsCheckedHere':9,'fixtureFilesCheckedByExistingFrozenFixtureGate':4},'historicalCheckUnchanged':'r3 postrun verified all 7280 inputs unchanged at that observation time; this derivative does not edit or reinterpret that historical result.'})
prior['codeBindings']=file(NEW/'retained-prior-code.json')
preparation={'status':'PREPARATION_ONLY_AWAITING_REPAIRED_CANDIDATE_AND_GATES','batchId':BATCH,'artifact':None,'candidateGate':None,'output':str(NEW),'fixture':old['fixture'],'providerObservation':file(NEW/'provider-observation.json'),'limits':LIMITS,'stages':STAGES,'prior':prior,'initialDataRoots':[file(NEW/'improve-data/host.sqlite')],'initialSeedTree':initial,'supportingEvidence':old['supportingEvidence'],'seedProvenance':'Independent APFS copy of original synthetic seed. No paid failed run copied; original seed identity remains explicit.','futureDecision':old['futureDecision'],'productImports':0,'credentialReads':0,'providerRequests':0,'vmStarts':0,'protectedPriorFiles':len(protected)}
save(NEW/'preparation.json',preparation)
for entry in protected:assert file(Path(entry['path']))==entry
print(json.dumps({'status':preparation['status'],'protectedPriorFiles':len(protected),'initialSeedFiles':len(initial),'newGrant':False}))
