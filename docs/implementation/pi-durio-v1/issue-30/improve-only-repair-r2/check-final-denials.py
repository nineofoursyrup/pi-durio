#!/usr/bin/env python3
import hashlib,json,os,runpy,subprocess,sys
from pathlib import Path
r=Path(__file__).resolve().parent
node='/opt/homebrew/Cellar/node/26.8.2/bin/node'
manifest=r/'frozen-manifest.json'
results=[]
for name,grant in [('false-pinned-grant',r/'grant-template-FROZEN-NOT-EXECUTABLE.json'),('missing-real-grant',r/'explicit-human-grant.json')]:
 p=subprocess.run([node,str(r/'harness/preflight.mjs'),str(manifest),str(grant)],text=True,capture_output=True,env={'PATH':'/opt/homebrew/bin:/usr/bin:/bin'})
 assert p.returncode==1 and 'EXPLICIT_NEW_PAID_GRANT_REQUIRED' in p.stderr
 results.append({'name':name,'status':'DENIED_AS_REQUIRED','exit':p.returncode,'stderr':p.stderr})
module=runpy.run_path(str(r/'harness/launch.py'),run_name='final_denial_probe');effects=[]
def forbidden(*args):effects.append('FORBIDDEN');raise AssertionError('credential or exec forbidden')
main=module['main'];main.__globals__['load_key']=forbidden;main.__globals__['os'].execve=forbidden
os.environ.clear();os.environ['PATH']='/opt/homebrew/bin:/usr/bin:/bin';sys.argv=[str(r/'harness/launch.py')]
code=main();assert code==1 and not effects
results.append({'name':'exact-wrapper-missing-grant','status':'DENIED_AS_REQUIRED','exit':code,'credentialOrExecEffects':effects})
for name in ['explicit-human-grant.json','paid-start.json','authorized-plan.json']:assert not (r/name).exists()
value={'status':'PASS_ALL_REAL_ADMISSION_PATHS_DENIED','manifestSha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'checks':results,'actualAuthorization':False,'realCredentialReads':0,'newProviderRequests':0,'productExecutions':0,'newVmStarts':0}
with (r/'final-denials-r1.json').open('x') as f:json.dump(value,f,indent=2);f.write('\n')
print(json.dumps({'status':value['status'],'cases':len(results),'manifestSha256':value['manifestSha256']}))
