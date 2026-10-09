/** Deterministic transport fixture: real Pi DeepSeek adapter + Harness, no network/model inference. */
export function demoTransport() {
  const calls: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    calls.push(payload);
    const tool = payload.messages.findLast((m: { role: string }) => m.role === 'tool');
    const delta = tool
      ? { content: `Offline fixture readback (no model inference):\n${tool.content}` }
      : { tool_calls: [{ index: 0, id: 'offline-read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] };
    const frame = (choices: unknown[], usage?: unknown) => ({ id: `offline-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash-offline-fixture', system_fingerprint: 'offline-fixture-v1', choices, ...(usage ? { usage } : {}) });
    const events = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }]), frame([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 })];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetch: fetcher };
}
