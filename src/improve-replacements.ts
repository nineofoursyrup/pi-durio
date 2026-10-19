import {isUtf8} from 'node:buffer';
import {readObject} from './evidence.js';
import type {ImproveCandidate} from './improve.js';

export class ReplacementMismatchError extends Error {
 constructor(){super('IMPROVE_REPLACEMENT_BASELINE_MISMATCH: original fragment must occur exactly once');}
}
export const REPLACEMENT_MISMATCH_REASON='替换片段与取证基线不唯一匹配';

/** Pre-fix saved reports declared complete file contents. New analyses must give
 * an exact original fragment; absence is retained only for immutable old reports. */
export interface Replacement {path:string;before?:string;content:string}
export function applyReplacement(baseline:string,replacement:Replacement):string {
 if(replacement.before===undefined)return replacement.content;
 const at=baseline.indexOf(replacement.before);
 if(!replacement.before||at<0||baseline.indexOf(replacement.before,at+1)>=0)throw new ReplacementMismatchError();
 return baseline.slice(0,at)+replacement.content+baseline.slice(at+replacement.before.length);
}
export function replacementContent(root:string,candidate:ImproveCandidate,replacement:Replacement):string {
 if(replacement.before===undefined)return replacement.content;
 const file=candidate.target.files.find(file=>file.path===replacement.path);
 if(!file)throw Error('IMPROVE_REPLACEMENT_SCOPE_DENIED');
 const bytes=readObject(root,file.content);
 if(!isUtf8(bytes))throw Error('IMPROVE_REPLACEMENT_ENCODING_UNSUPPORTED: replacement baseline must be UTF-8 text');
 return applyReplacement(bytes.toString('utf8'),replacement);
}
