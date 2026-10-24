import {readFile} from 'node:fs/promises';
import {analyzeImprove} from './runtime.js';
import {listImproveReports,readImproveReport,formatImproveReport,offlineImproveTransport} from './improve.js';
import {exitHostIfUnconfirmed} from './headless-lifecycle.js';
import {resolveDisplayInput} from './display-number.js';
import {HostReadonlySnapshot,isSqliteBusy} from './evidence.js';
import {previewImproveDecision,submitImproveDecision,readImproveDecision,resumeImproveDecision,listImproveSuppressions,restoreImproveSuggestion,rollbackImproveDecision,readImproveDefaults,readImproveBuildDefault,launchImproveBuild,readImproveEvalAssets,regradeImproveAsset} from './improve-decisions.js';

export async function improveCommand(action:string|undefined,dataRoot:string,values:Record<string,string|boolean|undefined>) {
 if(action==='decision'){if(typeof values.id!=='string')throw Error('USAGE: improve decision --id ID');console.log(JSON.stringify(readImproveDecision(dataRoot,values.id),null,2));return;}
 if(action==='suppressions'){console.log(JSON.stringify(listImproveSuppressions(dataRoot,typeof values.workspace==='string'?values.workspace:undefined),null,2));return;}
 if(action==='build-default'){if(typeof values.workspace!=='string')throw Error('USAGE: improve build-default --workspace PATH');console.log(JSON.stringify(readImproveBuildDefault(dataRoot,values.workspace),null,2));return;}
 if(action==='assets'){if(typeof values.id!=='string')throw Error('USAGE: improve assets --id ID');console.log(JSON.stringify(readImproveEvalAssets(dataRoot,values.id),null,2));return;}
 if(action==='defaults'){if(typeof values.workspace!=='string')throw Error('USAGE: improve defaults --workspace ABSOLUTE_PATH');console.log(JSON.stringify(['read','coding'].map(t=>readImproveDefaults(dataRoot,values.workspace as string,t as 'read'|'coding')),null,2));return;}
 if(['preview','submit','continue','restore-suggestion','rollback','launch','regrade'].includes(action??'')){
  if(typeof values.spec!=='string')throw Error('USAGE: improve preview|submit|continue|restore-suggestion --spec FILE');
  const spec=JSON.parse(await readFile(values.spec,'utf8'));
  // Display numbers in the spec are resolved before anything is recorded; a regrade plan belongs to its own eval data root.
  if((action==='preview'||action==='submit')&&typeof spec?.reportId==='string')spec.reportId=resolveDisplayInput(dataRoot,'improve-report',spec.reportId);
  if(action==='regrade'&&typeof spec?.planId==='string'&&typeof spec.evalDataRoot==='string')spec.planId=resolveDisplayInput(spec.evalDataRoot,'eval-plan',spec.planId);
  if(action==='preview'){console.log(JSON.stringify(previewImproveDecision(dataRoot,spec),null,2));return;}
  const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{const result=action==='launch'?await launchImproveBuild({...spec,dataRoot,signal:controller.signal}):action==='regrade'?await regradeImproveAsset({...spec,dataRoot,signal:controller.signal}):action==='submit'?await submitImproveDecision({dataRoot,decision:spec,signal:controller.signal}):action==='continue'?await resumeImproveDecision({...spec,dataRoot,signal:controller.signal}):action==='rollback'?await rollbackImproveDecision({...spec,dataRoot,signal:controller.signal}):await restoreImproveSuggestion({...spec,dataRoot});console.log(JSON.stringify(result,null,2));if('regrading'in result&&result.regrading?.state!=='completed')process.exitCode=result.regrading?.state==='cancelled'?130:75;if('state'in result&&result.state!=='completed'&&!(action==='rollback'&&'groups'in result&&result.groups.filter((g:any)=>spec.groupIds.includes(g.id)).every((g:any)=>g.rollback?.state==='completed')))process.exitCode=result.state==='frozen'?75:1;}
  finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}return;
 }
 if(action==='list'){const result=listImproveReports(dataRoot,{after:values.after?Number(values.after):undefined,limit:values.limit?Number(values.limit):undefined});console.log(JSON.stringify(result,null,2));return;}
 if(action==='report'){
  if(typeof values.id!=='string')throw Error('USAGE: improve report requires --id');
  const waitMs=1000,snapshot=new HostReadonlySnapshot(dataRoot,{snapshotWaitMs:waitMs});let output:string;
  try{const id=resolveDisplayInput(dataRoot,'improve-report',values.id,snapshot),result=readImproveReport(dataRoot,id,snapshot);output=values.format==='text'?formatImproveReport(result,dataRoot,snapshot):JSON.stringify(result,null,2);}
  catch(error){if(isSqliteBusy(error))throw Error(`IMPROVE_REPORT_TEMPORARILY_UNREADABLE: Report is temporarily unreadable; retry improve report after the writer releases the database lock (wait budget ${waitMs}ms).`,{cause:error});throw error;}
  finally{snapshot.close();}
  console.log(output);return;
 }
 if(action!=='analyze'||typeof values.spec!=='string')throw Error('USAGE: improve analyze --spec FILE; improve list; improve report --id ID [--format text]');
 const spec=JSON.parse(await readFile(values.spec,'utf8'));
 if(!['live','offline'].includes(spec.mode)||typeof spec.workspace!=='string'||typeof spec.targetRunId!=='string')throw Error('IMPROVE_SPEC_REQUIRED: explicit workspace, targetRunId, mode and request');
 spec.targetRunId=resolveDisplayInput(dataRoot,'run',spec.targetRunId);
 if(spec.mode==='offline'&&!values['offline-demo'])throw Error('OFFLINE_TRANSPORT_REQUIRED: --offline-demo is an explicit controlled zero-candidate fixture');
 if(spec.mode==='live'&&values['offline-demo'])throw Error('IMPROVE_MODE_CONFLICT');
 const controller=new AbortController();let cancellation:'stop'|'exit'='exit';
 const stop=()=>{if(!controller.signal.aborted){cancellation='stop';controller.abort();}},exit=()=>{if(!controller.signal.aborted){cancellation='exit';controller.abort();}};
 process.on('SIGINT',stop);process.on('SIGTERM',exit);
 try{const result=await analyzeImprove({dataRoot,workspace:spec.workspace,targetRunId:spec.targetRunId,request:spec.request,mode:spec.mode,transport:spec.mode==='offline'?offlineImproveTransport().fetch:undefined,signal:controller.signal,get cancellation(){return cancellation;}});const report=readImproveReport(dataRoot,spec.request.id);console.log(values.format==='text'?formatImproveReport(report,dataRoot):JSON.stringify(report,null,2));process.exitCode=result.improve?.state==='complete'?0:result.status==='unknown'?75:result.status==='aborted'?130:1;exitHostIfUnconfirmed(result);}
 finally{process.off('SIGINT',stop);process.off('SIGTERM',exit);}
}
