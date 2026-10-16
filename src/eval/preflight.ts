/** Read-only fixed-content verification runs off the TUI event loop. Cancelling
 * this worker cannot abandon a writer, VM or execution directory. */
import {Worker} from 'node:worker_threads';
import type {EvalPlan} from './plan.js';

export function verifyEvalBeforeStart(root:string,id:string,signal?:AbortSignal):Promise<EvalPlan>{
  if(signal?.aborted)return Promise.reject(Error('EVAL_CONTENT_CHECK_CANCELLED'));
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./preflight-worker.js',import.meta.url),{workerData:{root,id}});
    let reply:{plan?:EvalPlan;error?:string}|undefined,failure:Error|undefined;
    const cancel=()=>{failure=Error('EVAL_CONTENT_CHECK_CANCELLED');void worker.terminate();};
    signal?.addEventListener('abort',cancel,{once:true});
    worker.once('message',value=>{reply=value;});
    worker.once('error',error=>{failure=error;});
    worker.once('exit',code=>{signal?.removeEventListener('abort',cancel);if(failure)reject(failure);else if(code!==0||!reply?.plan)reject(Error(reply?.error??`EVAL_CONTENT_CHECK_FAILED: ${code}`));else resolve(reply.plan);});
    if(signal?.aborted)cancel();
  });
}
