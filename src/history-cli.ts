import { writeFileSync } from 'node:fs';
import { queryHistory,queryEvidence,queryAttempts,readEvidence,watermark } from './history.js';
import { queryUsage } from './usage-query.js';
import { scopedEvidence } from './derived-evidence.js';
import { fixEvidence,verifyFixed,estimateUsage } from './fixed-evidence.js';

export async function historyCommand(command:string|undefined,root:string,values:Record<string,unknown>) {
  if(!command||!['history','evidence','trace','usage','derive','fix','fixed','estimate','export'].includes(command))return false;
  if(values.format!==undefined&&values.format!=='json'&&values.format!=='text')throw Error('USAGE: format is json or text');
  const str=(key:string)=>typeof values[key]==='string'?values[key] as string:undefined;
  const required=(key:string)=>{const value=str(key);if(!value)throw Error(`USAGE: ${command} requires --${key}`);return value;};
  const number=(key:string)=>str(key)===undefined?undefined:Number(str(key));
  const options={after:number('after'),limit:number('limit'),snapshot:number('snapshot')};
  let result:unknown;
  if(command==='history')result=queryHistory(root,str('filter')?JSON.parse(str('filter')!):{}, {limit:options.limit,cursor:str('cursor')?JSON.parse(str('cursor')!):undefined});
  else if(command==='trace')result=queryAttempts(root,required('run'),options);
  else if(command==='usage')result=queryUsage(root,required('run').split(','),options.snapshot);
  else if(command==='fix')result=await fixEvidence(root,{id:required('id'),sources:required('evidence').split(','),dependencies:str('dependencies')?.split(','),purpose:required('purpose')});
  else if(command==='fixed')result=verifyFixed(root,required('evidence'));
  else if(command==='estimate')result=await estimateUsage(root,{id:required('id'),runIds:required('run').split(','),through:options.snapshot??watermark(root),price:JSON.parse(required('price'))});
  else if(command==='derive'||command==='export'){
    const scope={runIds:required('run').split(','),through:options.snapshot??watermark(root),maxBytes:number('max-bytes')??8192,purpose:required('purpose'),destination:{kind:'local' as const}};
    const reader=scopedEvidence(root,scope);result={scope,fragments:required('evidence').split(',').map(id=>reader.read(id,{offset:number('offset'),limit:options.limit}))};
    if(command==='export'){const destination=required('destination');writeFileSync(destination,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});result={destination,scope,exported:true};}
  }else result=str('evidence')?readEvidence(root,str('evidence')!,{offset:number('offset'),limit:options.limit,decodedOutput:values.decoded===true}):queryEvidence(root,required('run'),options);
  // Human and machine output serialize the same result, never independently compute facts.
  console.log(str('format')==='text'?`pi-durio ${command}\n${JSON.stringify(result,null,2)}`:JSON.stringify(result,null,2));return true;
}
