import {randomUUID} from 'node:crypto';

/** Process incarnation, not a PID: monotonic values are comparable only within it. */
const processId=randomUUID();
export interface FactClock {processId:string;monotonicMs:number;wallTime:string}
export function factClock():FactClock {return{processId,monotonicMs:performance.now(),wallTime:new Date().toISOString()};}
const timedKinds=new Set(['task.accepted','control.accepted','control.receipt','run.started','run.closed','recovery.started','recovery.closed','recovery.ended','recovery.report','model.intent','model.response','tool.dispatch','tool.result','tool.error','lifecycle.processing','lifecycle.close-started']);
/** Only host fact kinds receive acquisition clocks; supplied clock fields cannot spoof them. */
export function stampFact(kind:string,data:unknown):unknown {
  return timedKinds.has(kind)&&data!==null&&typeof data==='object'&&!Array.isArray(data)?{...data,clock:factClock()}:data;
}
export interface TaskOrigin {kind:'coding'|'eval'|'improve'|'maintenance';source:'ordinary'|'synthetic'|'diagnostic'|'eval';taskType?:string;parentTaskId?:string;trialId?:string}
