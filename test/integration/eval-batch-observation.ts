/** Test observation only: it never supplies or extends an execution budget. */
export type PhaseObservation<T>=
 | {state:'ready';value:T}
 | {state:'pending';detail?:unknown}
 | {state:'ended';receipt:unknown};

/** The feedback footer can retain an earlier notice after the status is idle. */
export function completedAndIdle(text:string,completion:RegExp){return completion.test(text)&&/^ *○ 空闲 *$/m.test(text);}

export async function waitForPhase<T>(phase:string,deadline:string,inspect:()=>PhaseObservation<T>,clock={now:()=>Date.now(),pause:(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}):Promise<T>{
 const end=Date.parse(deadline);if(!Number.isFinite(end))throw Error(`EVAL82_OBSERVATION_DEADLINE_INVALID: ${deadline}`);
 for(;;){
  const observed=inspect();
  if(observed.state==='ended')throw Error(`EVAL82_PHASE_ENDED: ${JSON.stringify({phase,deadline,receipt:observed.receipt})}`);
  const remaining=end-clock.now();
  if(remaining<=0)throw Error(`EVAL82_OBSERVATION_DEADLINE: ${JSON.stringify({phase,deadline,observed})}`);
  if(observed.state==='ready')return observed.value;
  await clock.pause(Math.min(250,remaining));
 }
}
