import {readFileSync,writeFileSync} from 'node:fs';
import {queryOperationsMetrics,formatOperationsMetrics} from './operations.js';
import {recordCostEstimate} from './costs.js';
import {recordFeedback} from './feedback.js';
import {queryFeedbackMetrics,formatFeedbackMetrics} from './feedback-report.js';
import {recordAcceptance} from './acceptance.js';
import {queryTaskMetrics,formatTaskMetrics} from './report.js';
import {resolveDisplayInput} from '../display-number.js';
export function metricsCommand(command:string|undefined,root:string,values:Record<string,unknown>) {
 if(!command||!['metrics','acceptance','operations','cost-estimate','feedback-report','feedback'].includes(command))return false;
 if(values.format!==undefined&&values.format!=='json'&&values.format!=='text')throw Error('USAGE: format is json or text');
 if(command==='acceptance'||command==='cost-estimate'||command==='feedback'){
  if(typeof values.spec!=='string')throw Error(`USAGE: ${command} requires --spec JSON_FILE`);
  const input=JSON.parse(readFileSync(values.spec,'utf8'));
  // Acceptance and feedback name accepted tasks; t- numbers are resolved before the input is digested.
  if(command!=='cost-estimate')for(const key of ['taskId','repairTaskId'])if(typeof input?.[key]==='string')input[key]=resolveDisplayInput(root,'task',input[key]);
  console.log(JSON.stringify((command==='acceptance'?recordAcceptance:command==='feedback'?recordFeedback:recordCostEstimate)(root,input),null,2));return true;
 }
 const scope=typeof values.scope==='string'?JSON.parse(values.scope):{};
 if(values.snapshot!==undefined)scope.through=Number(values.snapshot);
 const report=command==='operations'?queryOperationsMetrics(root,scope):command==='feedback-report'?queryFeedbackMetrics(root,scope):queryTaskMetrics(root,scope);
 if(values.destination!==undefined){if(typeof values.destination!=='string')throw Error('USAGE: destination is a new file');writeFileSync(values.destination,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});}
 console.log(values.format==='text'?('costs'in report?formatOperationsMetrics(report):'intervention'in report?formatFeedbackMetrics(report):formatTaskMetrics(report)):JSON.stringify(report,null,2));return true;
}
