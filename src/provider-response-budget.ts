export const RESPONSE_BASE_BYTES = 65_536;
export const RESPONSE_BYTES_PER_OUTPUT_TOKEN = 512;
export const MAX_OUTPUT_TOKENS = 65_536;
export const RESPONSE_HARD_CAP_BYTES = 33_619_968;

/** Transport protection, never a token allowance or evidence of actual usage.
 * Supported DeepSeek SSE shape: at most one content/tool_calls event per output
 * token, plus terminal events covered by the base. #124 measured content events
 * averaging 289.32 bytes (max 304); #93 e3 tool_calls averaged ~335 (max 464),
 * with event counts <= completion_tokens + 2. A new provider/event shape needs
 * measurement again. This is not a bound on arbitrary provider metadata.
 * The hard cap is the legal improve large configuration, not a silent clamp.
 */
export function providerResponseBytes(maxOutputTokens:number):number {
 if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>MAX_OUTPUT_TOKENS)throw Error('INVALID_PROVIDER_OUTPUT_LIMIT: expected 1–65536 output tokens');
 return RESPONSE_BASE_BYTES+maxOutputTokens*RESPONSE_BYTES_PER_OUTPUT_TOKEN;
}
