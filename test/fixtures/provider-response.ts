// #124's offline i3-shaped regression. No real response text or credentials.
export const issue124JSON=JSON.stringify({candidates:[{replacements:[{path:'cases.json',content:'x'.repeat(19920)}]}]});
export function fragmentedResponse(text=issue124JSON,{completionTokens=6000,usage=true,tool=false}:{completionTokens?:number;usage?:boolean;tool?:boolean}={}){
 const frames:string[]=[];
 const frame=(delta:unknown,finish:string|null=null,reported:unknown=null)=>`data: ${JSON.stringify({id:'offline-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',object:'chat.completion.chunk',created:1792773982,model:'offline-xxxxxx',system_fingerprint:'e72d3c7f663d3e1383b00b3884cb4501',choices:[{index:0,delta,logprobs:null,finish_reason:finish}],usage:reported})}\n\n`;
 for(let i=0;i<text.length;i+=4){const content=text.slice(i,i+4);frames.push(frame(tool?{tool_calls:[{index:0,id:i===0?'offline-tool':null,type:i===0?'function':null,function:{name:i===0?'read':null,arguments:content}}]}:{content}));}
 frames.push(frame({},tool?'tool_calls':'stop',usage?{prompt_tokens:500,completion_tokens:completionTokens,total_tokens:500+completionTokens}:null),'data: [DONE]\n\n');
 return {bytes:Buffer.from(frames.join('')),events:frames.length};
}
export function chunkedResponse(bytes:Uint8Array,width:number,onCancel:()=>void=()=>{}){
 let offset=0;
 return new Response(new ReadableStream<Uint8Array>({
  pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(offset+width,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;},
  cancel(){onCancel();}
 },{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
}
export function responseText(raw:string){return raw.split('\n\n').filter(frame=>frame.startsWith('data: ')&&frame!=='data: [DONE]').map(frame=>JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content??'').join('');}
