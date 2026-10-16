/** Capability supplied by the host of a view that can write records or schedule work. */
export interface WriteAccess {
  /** Undefined permits writing; a reason keeps the host and its data read-only. */
  writeBlocked(): string | undefined;
  feedback(text: string): void;
}

export const SHOW_READ_ONLY = '只读查看 · 不能提交、写入记录或启动工作 · 接续用 pi-durio resume s-…';

/** Check before opening a write flow and again at its actual action boundary. */
export function mayWrite(host: WriteAccess): boolean {
  const reason = host.writeBlocked();
  if (!reason) return true;
  host.feedback(reason);
  return false;
}
