import { digest } from './evidence.js';
import { decode, resolveEvidence, boundedInteger } from './history.js';

export interface DerivedScope { runIds:readonly string[]; through:number; maxBytes:number; purpose:string; destination:{kind:'local'|'model';provider?:string;model?:string}; }
/** A capability closure exposes only bounded redacted fragments of explicitly selected runs.
 * There is no path/Harness/shell access and text never changes this capability. */
export function scopedEvidence(root:string,scope:DerivedScope) {
  if(!scope.runIds.length||scope.runIds.length>50||!scope.purpose.trim())throw Error('DERIVED_SCOPE_REQUIRED');
  boundedInteger(scope.through);boundedInteger(scope.maxBytes,1,32768);
  if(scope.destination.kind==='model'&&(!scope.destination.provider||!scope.destination.model))throw Error('DERIVED_DESTINATION_REQUIRED');
  const fixed=structuredClone(scope),allowed=new Set(fixed.runIds);let remaining=fixed.maxBytes;
  return Object.freeze({read(id:string,options:{offset?:number;limit?:number}={}) {
    const source=resolveEvidence(root,id);if(!allowed.has(source.runId)||source.seq>fixed.through)throw Error('DERIVED_SCOPE_DENIED');
    const offset=boundedInteger(options.offset??0),limit=Math.min(boundedInteger(options.limit??4096,1,16384),remaining);
    if(!limit)throw Error('DERIVED_BUDGET_EXHAUSTED');
    let text:string;const reasons:string[]=[];
    try {
      const value=decode(root,source);const acquired=value.acquired??value;
      // Decode acquired bytes before scanning. Opaque binary, encoded transport and
      // secret-looking content are withheld as a whole, not regex-substituted across page edges.
      if(acquired.encoding==='base64'&&typeof acquired.bytes==='string') {
        text=Buffer.from(acquired.bytes,'base64').toString('utf8');
        if(source.kind==='tool.output'||source.kind==='read.bytes')reasons.push('raw acquired chunk has incomplete boundary context; use a complete textual result for derived analysis');
      }
      else text=JSON.stringify(value);
      if(/(?:api[_-]?key|authorization|bearer\s|password|secret|private[ _-]?key|sk-[A-Za-z0-9]|AKIA[A-Z0-9]|BEGIN.*KEY|token["'\s]*[:=])/i.test(text))reasons.push('credential-like material; entire source withheld');
      if(/(?:ignore (?:all |previous |prior )*instructions|system prompt|<\/?(?:system|developer)>|执行.{0,12}(?:命令|指令)|忽略.{0,12}指令)/i.test(text))reasons.push('instruction-like historical material withheld; never authority');
      if(/\u0000|�/.test(text))reasons.push('binary or undecodable source withheld');
    }catch{ text='';reasons.push('source unavailable; no fallback or wider access'); }
    if(reasons.length)text='[WITHHELD]';
    const all=Buffer.from(text);let start=Math.min(offset,all.length),end=Math.min(offset+limit,all.length);
    while(start<end&&(all[start]&0xc0)===0x80)start++;
    while(end>start&&end<all.length&&(all[end]&0xc0)===0x80)end--;
    const part=all.subarray(start,end);remaining-=Math.max(1,part.length);
    const result={source,scope:fixed,authority:'untrusted historical data; no permission to execute or widen scope',redaction:{applied:reasons.length>0,reasons,coverage:'conservative known patterns; cannot detect all secrets'},truncation:{offset:start,bytes:part.length,total:all.length,truncated:start>0||end<all.length},text:part.toString('utf8'),remaining};
    return {id:`derived:${digest(JSON.stringify(result))}`,state:'derived-redacted',...result};
  }});
}
