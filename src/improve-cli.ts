import {readFile} from 'node:fs/promises';
import {analyzeImprove} from './runtime.js';
import {listImproveReports,readImproveReport,formatImproveReport,offlineImproveTransport} from './improve.js';
import {exitHostIfUnconfirmed} from './headless-lifecycle.js';
import {previewImproveDecision,submitImproveDecision,readImproveDecision,resumeImproveDecision,listImproveSuppressions,restoreImproveSuggestion} from './improve-decisions.js';

export async function improveCommand(action:string|undefined,dataRoot:string,values:Record<string,string|boolean|undefined>) {
 if(action==='decision'){if(typeof values.id!=='string')throw Error('USAGE: improve decision --id ID');console.log(JSON.stringify(readImproveDecision(dataRoot,values.id),null,2));return;}
 if(action==='suppressions'){console.log(JSON.stringify(listImproveSuppressions(dataRoot,typeof values.workspace==='string'?values.workspace:undefined),null,2));return;}
 if(['preview','submit','continue','restore-suggestion'].includes(action??'')){
  if(typeof values.spec!=='string')throw Error('USAGE: improve preview|submit|continue|restore-suggestion --spec FILE');
  const spec=JSON.parse(await readFile(values.spec,'utf8'));
  if(action==='preview'){console.log(JSON.stringify(previewImproveDecision(dataRoot,spec),null,2));return;}
  const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{const result=action==='submit'?await submitImproveDecision({dataRoot,decision:spec,signal:controller.signal}):action==='continue'?await resumeImproveDecision({...spec,dataRoot,signal:controller.signal}):await restoreImproveSuggestion({...spec,dataRoot});console.log(JSON.stringify(result,null,2));if('state'in result&&result.state!=='completed')process.exitCode=result.state==='frozen'?75:1;}
  finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}return;
 }
 if(action==='list'){const result=listImproveReports(dataRoot,{after:values.after?Number(values.after):undefined,limit:values.limit?Number(values.limit):undefined});console.log(JSON.stringify(result,null,2));return;}
 if(action==='report'){if(typeof values.id!=='string')throw Error('USAGE: improve report requires --id');const result=readImproveReport(dataRoot,values.id);console.log(values.format==='text'?formatImproveReport(result):JSON.stringify(result,null,2));return;}
 if(action!=='analyze'||typeof values.spec!=='string')throw Error('USAGE: improve analyze --spec FILE; improve list; improve report --id ID [--format text]');
 const spec=JSON.parse(await readFile(values.spec,'utf8'));
 if(!['live','offline'].includes(spec.mode)||typeof spec.workspace!=='string'||typeof spec.targetRunId!=='string')throw Error('IMPROVE_SPEC_REQUIRED: explicit workspace, targetRunId, mode and request');
 if(spec.mode==='offline'&&!values['offline-demo'])throw Error('OFFLINE_TRANSPORT_REQUIRED: --offline-demo is an explicit controlled zero-candidate fixture');
 if(spec.mode==='live'&&values['offline-demo'])throw Error('IMPROVE_MODE_CONFLICT');
 const controller=new AbortController();let cancellation:'stop'|'exit'='exit';
 const stop=()=>{if(!controller.signal.aborted){cancellation='stop';controller.abort();}},exit=()=>{if(!controller.signal.aborted){cancellation='exit';controller.abort();}};
 process.on('SIGINT',stop);process.on('SIGTERM',exit);
 try{const result=await analyzeImprove({dataRoot,workspace:spec.workspace,targetRunId:spec.targetRunId,request:spec.request,mode:spec.mode,transport:spec.mode==='offline'?offlineImproveTransport().fetch:undefined,signal:controller.signal,get cancellation(){return cancellation;}});const report=readImproveReport(dataRoot,spec.request.id);console.log(values.format==='text'?formatImproveReport(report):JSON.stringify(report,null,2));process.exitCode=result.improve?.state==='complete'?0:result.status==='unknown'?75:result.status==='aborted'?130:1;exitHostIfUnconfirmed(result);}
 finally{process.off('SIGINT',stop);process.off('SIGTERM',exit);}
}
