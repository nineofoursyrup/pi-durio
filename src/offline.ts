/** Deterministic transport fixture: real Pi DeepSeek adapter + Harness, no network/model inference. */
export function demoTransport() {
  const calls: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    calls.push(payload);
    const tool = payload.messages.findLast((m: { role: string }) => m.role === 'tool');
    const summarizing=!payload.tools?.length&&payload.messages.some((m:{role:string;content:unknown})=>m.role==='system'&&JSON.stringify(m.content).includes('context summarization assistant'));
    const delta = summarizing?{content:'Offline fixture context summary (no model inference); original source is retained.'}:tool
      ? { content: `Offline fixture readback (no model inference):\n${tool.content}` }
      : { tool_calls: [{ index: 0, id: 'offline-read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] };
    const frame = (choices: unknown[], usage?: unknown) => ({ id: `offline-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash-offline-fixture', system_fingerprint: 'offline-fixture-v1', choices, ...(usage ? { usage } : {}) });
    const events = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: tool||summarizing ? 'stop' : 'tool_calls' }]), frame([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 })];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetch: fetcher };
}

/** Explicit scripted tool calls for wiring tests/demos. This is neither inference nor a correctness oracle. */
export function scriptedTransport(steps: readonly ({ name: string; args: unknown } | readonly { name: string; args: unknown }[])[]) {
  const calls: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    const step = steps[calls.length - 1];
    const batch: readonly { name: string; args: unknown }[] = step ? (Array.isArray(step) ? step : [step as { name: string; args: unknown }]) : [];
    const delta = step ? { tool_calls: batch.map((call, index) => ({ index, id: `step-${calls.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Controlled response: inspect actual tool evidence for acceptance.' };
    const frame = (choices: unknown[], usage?: unknown) => ({ id: `coding-${calls.length}`, model: 'deepseek-flash-offline-fixture', choices, ...(usage ? { usage } : {}) });
    const frames = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }]), frame([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })];
    return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetch: fetcher };
}
