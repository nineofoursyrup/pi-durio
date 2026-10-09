// The only eval module mounted alongside the product runtime. No grader or answers.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createInterface} from 'node:readline';
import {execFileSync} from 'node:child_process';
import {runCodingTask} from '../runtime.js';
const input=JSON.parse(await readFile('/input/trial.json','utf8'));
await mkdir('/work/project',{recursive:true});
for(const [path,value]of Object.entries(input.files)as[string,string][]){const destination=join('/work/project',path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,value);}
const git=(args:string[])=>execFileSync('/usr/bin/git',['-C','/work/project',...args],{stdio:'pipe',env:{PATH:'/usr/bin:/bin',HOME:'/work/home',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Eval fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Eval fixture',GIT_COMMITTER_EMAIL:'fixture@localhost',GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}});
git(['init','--quiet','--template=']);git(['add','.']);git(['commit','--quiet','-m','fixed fixture initial state']);
for(const [path,value]of Object.entries(input.dirty??{})as[string,string][]){const destination=join('/work/project',path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,value);}
let ordinal=0;
const lines=createInterface({input:process.stdin});
const pending=new Map<number,{resolve:(value:Response)=>void;reject:(error:Error)=>void}>();
lines.on('line',line=>{try{const value=JSON.parse(line),request=pending.get(value.id);if(value.kind!=='model.response'||!request)return;pending.delete(value.id);const response=JSON.parse(value.output);request.resolve(new Response(response.body,{status:response.status,headers:{'content-type':response.contentType}}));}catch(error){for(const request of pending.values())request.reject(error as Error);pending.clear();}});
const transport:typeof fetch=async(_url,init)=>{if(typeof init?.body!=='string')throw Error('EVAL_EXPECTED_JSON_PAYLOAD');const payload=JSON.parse(init.body);payload.max_tokens=input.maxOutputTokens;const id=++ordinal;return new Promise<Response>((resolve,reject)=>{pending.set(id,{resolve,reject});init?.signal?.addEventListener('abort',()=>{pending.delete(id);reject(Error('EVAL_REQUEST_CANCELLED'));},{once:true});process.stdout.write(JSON.stringify({kind:'model.request',id,input:JSON.stringify(payload),maxOutputTokens:input.maxOutputTokens})+'\n');});};
// The product adapter requires an authentication field in live mode. This is a
// non-secret placeholder; only the trusted host supplies the actual credential.
if(input.mode==='live')process.env.DEEPSEEK_API_KEY='eval-mediated-no-credential';
try{
 const result=await runCodingTask({dataRoot:'/work/data',workspace:'/work/project',input:input.prompt,taskOrigin:{kind:'eval',source:'eval',trialId:input.trialId},mode:input.mode==='live'?'live':'offline',transport,providerBoundary:{purpose:'generation',operationId:input.trialId,transport},...(input.verificationCompaction?{verificationCompaction:input.verificationCompaction}:{}),...(input.originalFailure?{fault:(kind:string)=>{if(kind==='model.provider-event')throw Error('CONTROLLED_ORIGINAL_WRITE_FAILURE');}}:{})});
 await writeFile('/work/product-result.json',JSON.stringify(result));
 process.exitCode=result.status==='completed'?0:1;
}catch(error){await writeFile('/work/product-error.json',JSON.stringify({error:String(error)}));process.exitCode=1;}
finally{lines.close();process.stdin.destroy();}
