import {readFile} from 'node:fs/promises';
import {prepareEval,loadEvalPlan} from './plan.js';
import {runEval,regradeEval,evalReport,formatEvalReport,listEvalPlans} from './runner.js';
export async function evalCommand(action:string|undefined,root:string,values:Record<string,string|boolean|undefined>){
 const id=typeof values.id==='string'?values.id:undefined;
 if(action==='plan'){
  if(typeof values.spec!=='string')throw Error('eval plan requires --spec FILE containing fixed cases/trials/limits/runtime installation');
  const options=JSON.parse(await readFile(values.spec,'utf8'));const prepared=await prepareEval({...options,dataRoot:root});console.log(JSON.stringify(prepared,null,2));return;
 }
 if(action==='list'||!action){console.log(JSON.stringify(listEvalPlans(root),null,2));return;}
 if(!id)throw Error('eval requires --id PLAN_ID');
 let report;
 if(action==='report'){
  const asOf=typeof values.snapshot==='string'?Number(values.snapshot):undefined;
  if(asOf!==undefined&&(!Number.isSafeInteger(asOf)||asOf<1))throw Error('eval report --snapshot requires a positive fact sequence');
  report=evalReport(root,id,{asOf});
 }
 else if(action==='run'){
  if(typeof values.directory!=='string')throw Error('eval run requires --directory NEW_OWNED_DIRECTORY');
  console.error(JSON.stringify({fixedPlan:loadEvalPlan(root,id),authorization:'Explicit eval run --id authorizes all listed trials and fixed limits'},null,2));
  const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{report=await runEval({dataRoot:root,id,directory:values.directory,signal:controller.signal});}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
 }else if(action==='grade'){
  if(typeof values.spec!=='string'||typeof values.directory!=='string')throw Error('eval grade requires --spec FILE and --directory NEW_DIRECTORY');
  const revision=JSON.parse(await readFile(values.spec,'utf8')),controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{report=await regradeEval({...revision,dataRoot:root,id,directory:values.directory,signal:controller.signal});}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
 }else throw Error('eval supports plan, list, run, report, grade');
 console.log(values.format==='text'?formatEvalReport(report):JSON.stringify(report,null,2));
 if(action==='grade'&&report.regrading?.state!=='completed')process.exitCode=report.regrading?.state==='cancelled'?130:75;
 if(action==='run')process.exitCode=report.trials.some(t=>['invalid','unknown'].includes(t.outcome.status))?75:report.counts.passed===report.counts.planned?0:1;
}
