import {parentPort,workerData} from 'node:worker_threads';
import {verifyEvalRunContent} from './runner.js';

try{parentPort!.postMessage({plan:verifyEvalRunContent(workerData.root,workerData.id)});}
catch(error){parentPort!.postMessage({error:String((error as Error)?.message??error)});}
