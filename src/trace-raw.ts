/**
 * 2a 原文层的取数（U7、E2）：按 `span.raws` 的来源记录读原文、解码成文本并分页。
 * 只读：不取锁、不写记录、不调用模型。显示前的控制字符处理在视图层（原文照原样复制）。
 */
import { decode, resolveEvidence, type EvidenceReference } from './history.js';
import { readObjectRange } from './query.js';
import type { TraceRaw, TraceRawState } from './trace.js';

/** 一页的上限（字节），与 tool.output 的分块同为 16 KiB。 */
export const RAW_PAGE_BYTES = 16 * 1024;
/** decode 的单条记录上限；更大的记录按记录原文（JSON）逐页读取。 */
const DECODE_LIMIT = 2 * 1024 * 1024;

export interface RawPage {
  /** 声明的取得状态；读取失败时为实际核对到的状态（损坏、采集缺口、暂不可读）。 */
  state: TraceRawState;
  /** 本页原文（未处理控制字符）。不可取得时为空。 */
  text: string;
  /** 0 起。 */
  page: number;
  pages: number;
  /** 不可取得的原因：一句中文加原因码。 */
  error?: string;
  /** 本页的读法说明，如超过显示上限的记录按 JSON 原文分页。 */
  note?: string;
}

const failureState = (error: unknown): TraceRawState => {
  const text = String(error);
  return text.includes('CORRUPT') ? 'corrupt' : (error as NodeJS.ErrnoException).code === 'ENOENT' || text.includes('NOT_FOUND') ? 'collection-gap' : 'temporarily-unreadable';
};
const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error instanceof Error ? error.message : error).split(/[\s:]/)[0];

/** 把一页字节解码为 UTF-8：开头跳过属于上一页的续字节，结尾用下一页开头的续字节补全最后一个字符。 */
function utf8Page(bytes: Buffer, first: boolean, nextHead: Buffer | undefined) {
  let start = 0;
  if (!first) while (start < Math.min(3, bytes.length) && (bytes[start] & 0xc0) === 0x80) start++;
  let tail = 0;
  if (nextHead) while (tail < Math.min(3, nextHead.length) && (nextHead[tail] & 0xc0) === 0x80) tail++;
  return Buffer.concat([bytes.subarray(start), nextHead ? nextHead.subarray(0, tail) : Buffer.alloc(0)]).toString('utf8');
}

/** 按行切页，单行超过上限时按码点切。 */
function splitPages(text: string): string[] {
  const pages: string[] = [];
  let current = '', size = 0;
  const flush = () => { pages.push(current); current = ''; size = 0; };
  for (const line of text.split(/(?<=\n)/)) {
    const bytes = Buffer.byteLength(line);
    if (size + bytes <= RAW_PAGE_BYTES) { current += line; size += bytes; continue; }
    if (size) flush();
    if (bytes <= RAW_PAGE_BYTES) { current = line; size = bytes; continue; }
    for (const char of line) {
      const w = Buffer.byteLength(char);
      if (size + w > RAW_PAGE_BYTES) flush();
      current += char; size += w;
    }
  }
  if (size || !pages.length) flush();
  return pages;
}

/** 解码后的值按原文显示：字符串照原样（含换行），对象写 `键: 值`，数组写 `- 项`，不包在 JSON 里。 */
export function plainText(value: unknown, indent = ''): string[] {
  if (typeof value === 'string') return value.split('\n').map(line => indent + line);
  if (value === null || typeof value !== 'object') return [indent + String(value)];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}[]`];
    return value.flatMap(item => { const lines = plainText(item, `${indent}  `); lines[0] = `${indent}- ${lines[0].slice(indent.length + 2)}`; return lines; });
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return [`${indent}{}`];
  return entries.flatMap(([key, v]) => {
    if (v === null || typeof v !== 'object' && !(typeof v === 'string' && v.includes('\n'))) return [`${indent}${key}: ${String(v)}`];
    if (typeof v === 'object' && (Array.isArray(v) ? !v.length : !Object.keys(v).length)) return [`${indent}${key}: ${Array.isArray(v) ? '[]' : '{}'}`];
    return [`${indent}${key}:`, ...plainText(v, `${indent}  `)];
  });
}

/** 内容块（工具结果、模型响应）：文本照原样，其余写类型与要点。 */
function blocks(content: unknown): string[] {
  if (!Array.isArray(content)) return plainText(content);
  return content.flatMap((block: any) => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text.split('\n');
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return ['[thinking]', ...block.thinking.split('\n')];
    if (block?.type === 'toolCall') return [`[toolCall ${block.name ?? ''} ${block.id ?? ''}]`.trimEnd(), ...plainText(block.arguments ?? {}, '  ')];
    if (block?.type === 'image') return [`[image ${block.mimeType ?? ''} · ${typeof block.data === 'string' ? Buffer.byteLength(block.data, 'base64') : 0} B]`];
    return plainText(block);
  });
}

/** 一条记录在该原文项中的文本。 */
function recordText(ref: EvidenceReference, data: any): string[] {
  switch (ref.kind) {
    case 'tool.intent': return plainText(data.args ?? {});
    case 'tool.result': return data.result && Array.isArray(data.result.content) ? blocks(data.result.content) : plainText(data.result);
    case 'tool.error': return plainText(data.error);
    case 'model.payload': return plainText(data.payload);
    case 'model.response': {
      const { content, ...rest } = data.message ?? {};
      return [...blocks(content ?? []), '', ...plainText(rest)];
    }
    case 'model.provider-event': return [JSON.stringify(data.event)];
    case 'compaction.summary': {
      const entry = data.entry ?? data.entryDraft;
      return typeof entry?.summary === 'string' ? entry.summary.split('\n') : plainText(data);
    }
    default: return plainText(data);
  }
}

type Part = { count: number; read(index: number): { text: string; note?: string } };

/**
 * 一项原文的分页读取。页在第一次访问时读，之后缓存；读取失败的页给出实际状态。
 * stdout/stderr 把相邻的 tool.output 分块合成不超过 16 KiB 的页；其他项把来源记录解码成文本后按 16 KiB 切页；
 * 超过 2 MiB 的单条记录（如长上下文的请求 payload）按记录原文逐页读，注明是 JSON 原文。
 */
export class RawContent {
  private parts?: Part[];
  private failure?: { state: TraceRawState; error: string };
  private readonly cache = new Map<number, RawPage>();
  constructor(private readonly root: string, readonly raw: TraceRaw) {}

  get pages() { this.load(); return this.parts ? Math.max(1, this.parts.reduce((n, p) => n + p.count, 0)) : 1; }

  page(index: number): RawPage {
    const pages = this.pages, page = Math.max(0, Math.min(pages - 1, index));
    const declared = this.raw.state;
    if (declared === 'cleaned') return { state: declared, text: '', page, pages, error: '已清理 · 显式清理后原文不可取得，宿主记录保留' };
    if (declared === 'archived') return { state: declared, text: '', page, pages, error: '已归档 · 需从归档恢复后才能读取' };
    // 没有来源记录：完整取得表示该项本来就是空的（如没有输出的 stderr）。
    if (!this.raw.sources.length) return declared === 'complete' ? { state: declared, text: '', page, pages } : { state: declared, text: '', page, pages, error: declared === 'source-not-returned' ? '源未返回 · 没有这一项的记录' : '没有这一项的记录' };
    if (this.failure) return { state: this.failure.state, text: '', page, pages, error: this.failure.error };
    const cached = this.cache.get(page);
    if (cached) return cached;
    let at = page, result: RawPage;
    try {
      const part = this.parts!.find(p => at < p.count || (at -= p.count, false))!;
      const { text, note } = part.read(at);
      result = { state: declared, text, page, pages, ...(note ? { note } : {}) };
    } catch (error) {
      result = { state: failureState(error), text: '', page, pages, error: `原文不可读取 · ${code(error)}` };
    }
    this.cache.set(page, result);
    return result;
  }

  private load() {
    if (this.parts || this.failure || !this.raw.sources.length || this.raw.state === 'cleaned' || this.raw.state === 'archived') return;
    try {
      const refs = this.raw.sources.map(id => resolveEvidence(this.root, id));
      if (this.raw.label === 'stdout' || this.raw.label === 'stderr') {
        const chunk = (ref: EvidenceReference) => { const data = decode(this.root, ref); return Buffer.from((data.acquired ?? data).bytes ?? '', 'base64'); };
        // 相邻分块合成一页：按记录大小估计解码后的字节（base64 的 3/4，偏大），不先读内容。
        const groups: EvidenceReference[][] = [];
        let size = 0;
        for (const ref of refs) {
          const estimate = Math.ceil(ref.ref.bytes * 3 / 4);
          if (!groups.length || size + estimate > RAW_PAGE_BYTES) { groups.push([]); size = 0; }
          groups.at(-1)!.push(ref); size += estimate;
        }
        this.parts = [{ count: groups.length, read: i => ({ text: utf8Page(Buffer.concat(groups[i].map(chunk)), i === 0, i + 1 < groups.length ? chunk(groups[i + 1][0]).subarray(0, 3) : undefined) }) }];
        return;
      }
      const parts: Part[] = [];
      let text: string[] = [];
      const flush = () => { if (!text.length) return; const pages = splitPages(text.join('\n')); parts.push({ count: pages.length, read: i => ({ text: pages[i] }) }); text = []; };
      const events = refs.filter(r => r.kind === 'model.provider-event').length, records = refs.length - events;
      let eventHeader = false;
      for (const ref of refs) {
        if (ref.ref.bytes > DECODE_LIMIT) {
          flush();
          const count = Math.ceil(ref.ref.bytes / RAW_PAGE_BYTES), note = `记录 #${ref.seq} 超过 2 MiB 显示上限 · 按记录原文（JSON）分页`;
          parts.push({ count, read: i => {
            const range = readObjectRange(this.root, ref.ref, { offset: i * RAW_PAGE_BYTES, limit: RAW_PAGE_BYTES + 3 });
            const body = range.bytes.subarray(0, RAW_PAGE_BYTES), head = range.bytes.length > RAW_PAGE_BYTES ? range.bytes.subarray(RAW_PAGE_BYTES) : undefined;
            return { text: utf8Page(body, i === 0, head), note };
          } });
          continue;
        }
        if (ref.kind === 'model.provider-event' && !eventHeader) { eventHeader = true; text.push('', `── provider events · ${events} 条 ──`); }
        else if (records > 1 && ref.kind !== 'model.provider-event') text.push(...(text.length ? [''] : []), `── 记录 #${ref.seq} ${ref.kind} ──`);
        text.push(...recordText(ref, decode(this.root, ref)));
      }
      flush();
      this.parts = parts;
    } catch (error) {
      this.failure = { state: failureState(error), error: `原文不可读取 · ${code(error)}` };
    }
  }
}
