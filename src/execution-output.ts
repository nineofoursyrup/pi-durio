import {Evidence,type BlobRef} from './evidence.js';
import {StringDecoder} from 'node:string_decoder';

/** Persist bounded acquired output in ordinary Evidence objects. The fact has
 * direct block references so existing fixation/retention sees every dependency.
 * Mutation occurs only after the content and receipt are durable. */
export function retainExecutionOutput(evidence:Evidence,execution:any,identity:Record<string,unknown>) {
 const acquired=execution.output;if(!acquired)return; // An unavailable controller never acquired candidate output.
 if(acquired.encoding!=='base64')throw Error('EXECUTION_OUTPUT_ENCODING');
 const output:any={layer:acquired.layer,encoding:'bytes',blockBytes:65536};
 for(const stream of ['stdout','stderr']){
  const value=acquired[stream],chunks:BlobRef[]=[];let bytes=0;
  for(const chunk of value.chunks){const raw=Buffer.from(chunk,'base64');if(raw.length>65536||raw.toString('base64')!==chunk)throw Error('EXECUTION_OUTPUT_BLOCK');chunks.push(evidence.blob(raw));bytes+=raw.length;}
  if(bytes!==value.bytes)throw Error('EXECUTION_OUTPUT_BYTES');
  output[stream]={bytes,chunks,displayTruncated:value.displayTruncated};
 }
 evidence.append('execution.output',{...identity,sourceEnd:execution.sourceEnd,output,execution:{status:execution.status,terminated:execution.terminated,code:execution.code,reason:execution.reason},retention:'all acquired bytes; does not claim output after capture stopped'});
 execution.output=output;
}

/** Journal/UI projection only. Original text and original byte blocks remain in
 * the separately retained execution document and its output references. */
export function executionPreview(execution:any) {
 const preview:any={...execution,projection:'bounded UTF-8 preview; original bytes in output chunks'};
 if(execution.output)preview.output={...execution.output};
 for(const stream of ['stdout','stderr']){const text=Buffer.from(execution[stream]??'');preview[stream]=new StringDecoder('utf8').write(text.subarray(0,16384));if(preview.output)preview.output[stream]={...execution.output[stream],displayTruncated:execution.output[stream].bytes>16384||text.length>16384};}
 return preview;
}
