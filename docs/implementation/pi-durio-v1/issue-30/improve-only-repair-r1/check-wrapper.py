#!/usr/bin/env python3
"""Only denial paths of exact wrapper/new preflight; secret reader and exec replacement are prohibited."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

root=Path(__file__).resolve().parent
output=root/(sys.argv[1] if len(sys.argv)>1 else 'wrapper-check-r1.json')
assert output.parent==root
assert not output.exists()
node='/opt/homebrew/Cellar/node/26.8.2/bin/node'
result=[]
# Invoke exact new preflight with actual false template. It rejects before candidate/product access.
p=subprocess.run([node,str(root/'harness/preflight.mjs'),str(root/'preparation.json'),str(root/'grant-template-NOT-EXECUTABLE.json')],env={'PATH':os.environ.get('PATH','')},text=True,capture_output=True)
assert p.returncode==1 and 'EXPLICIT_NEW_PAID_GRANT_REQUIRED' in p.stderr
result.append({'name':'actual-preflight-false-grant','status':'PASS','exit':p.returncode,'stderr':p.stderr})
# Invoke exact launch main; any credential read or process replacement is a hard check failure.
module=runpy.run_path(str(root/'harness/launch.py'),run_name='offline_denial_probe');main=module['main'];effects=[]
def forbidden_key():
 effects.append('credential-read');raise AssertionError('FORBIDDEN')
def forbidden_exec(*args):
 effects.append('exec-replacement');raise AssertionError('FORBIDDEN')
main.__globals__['load_key']=forbidden_key
main.__globals__['os'].execve=forbidden_exec
os.environ.clear();os.environ['PATH']='/opt/homebrew/bin:/usr/bin:/bin'
sys.argv=[str(root/'harness/launch.py')]
code=main()
assert code==1 and effects==[]
result.append({'name':'actual-fixed-wrapper-missing-grant','status':'PASS','exit':code,'credentialAndExecEffects':effects})
assert not (root/'paid-start.json').exists() and not (root/'explicit-human-grant.json').exists()
value={'status':'PASS','cases':2,'results':result,'wrapperSha256':hashlib.sha256((root/'harness/launch.py').read_bytes()).hexdigest(),'preflightSha256':hashlib.sha256((root/'harness/preflight.mjs').read_bytes()).hexdigest(),'realCredentialReads':0,'newProviderRequests':0,'productExecutions':0}
with output.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
print(json.dumps({'status':'PASS','cases':2,'realCredentialReads':0}))
