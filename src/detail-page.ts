import { createHash } from 'node:crypto';

/** A bounded display page plus a count/digest over the complete deterministic projection. */
export interface DetailSummary { count: number; sha256: string; offset: number; next: number | null }
export class DetailPage<T> {
  readonly items: T[] = [];
  count = 0;
  private readonly hash = createHash('sha256');
  constructor(readonly offset = 0, readonly limit = 32) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw Error('INVALID_DETAIL_PAGE');
  }
  add(value: T) {
    this.hash.update(JSON.stringify(value)).update('\n');
    if (this.count >= this.offset && this.items.length < this.limit) this.items.push(value);
    this.count++;
  }
  summary(): DetailSummary { return { count: this.count, sha256: this.hash.copy().digest('hex'), offset: this.offset, next: this.count > this.offset + this.limit ? this.offset + this.limit : null }; }
}
