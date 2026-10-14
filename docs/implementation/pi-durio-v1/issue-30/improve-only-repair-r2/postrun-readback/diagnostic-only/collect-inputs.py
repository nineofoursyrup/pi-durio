from pathlib import Path
import json, sqlite3, hashlib
run=Path('/Users/nineofour/pi-durio-v1-run')
batch=run/'evidence/issue-30/improve-only-repair-r2'
out=Path(__file__).resolve().parent
result=json.loads((batch/'live-improve-result.json').read_text())
root=batch/'improve-data'; database=root/'host.sqlite'
assert not Path(str(database)+'-wal').exists()
used=set(); excluded=[]
before=hashlib.sha256(database.read_bytes()).hexdigest()
with sqlite3.connect('file:'+str(database)+'?mode=ro&immutable=1',uri=True) as db:
    for seq,kind,body in db.execute("select seq,kind,body from records where run_id=? and kind in ('improve.summary','improve.derived') order by seq",(result['runId'],)):
        ref=json.loads(body); data=(root/'objects'/ref['sha256']).read_bytes()
        assert hashlib.sha256(data).hexdigest()==ref['sha256']
        value=json.loads(data)
        if kind=='improve.summary':
            used.add(f'e1:{seq}:{ref["sha256"]}'); continue
        source_id=value.get('sourceId') or value['source']['id']
        redaction=value.get('redaction')
        allowed=(isinstance(redaction,list) and not redaction) or (isinstance(redaction,dict) and not redaction.get('applied',True))
        if allowed: used.add(source_id)
        else: excluded.append({'sourceId':source_id,'reason':value.get('reason',redaction)})
assert before==hashlib.sha256(database.read_bytes()).hexdigest()
value={'runId':result['runId'],'request':result['improve']['request'],'targets':result['improve']['targets'],'usedEvidence':sorted(used),'excludedEvidence':excluded,'sourceResult':str(batch/'live-improve-result.json'),'hostDbSha256':before,'scope':'Read-only diagnosis inputs reconstructed from actual improve.summary/derived; no product import or report mutation'}
(out/'inputs.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'used':len(used),'excludedReads':len(excluded),'databaseUnchanged':True}))
