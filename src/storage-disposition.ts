import { digest, readObject } from './evidence.js';
import { records, decode, watermark } from './history.js';

/** Admission-only evidence for a completed whole-session cleanup. It cannot authorize recovery.
 * The immutable preview, explicit commit, whole-session inspection, and final result must agree.
 * Scan only the needed facts, retaining at most the existing bounded cleanup plan.
 */
export function sessionRemovalVerified(root: string, sessionId: string, through = watermark(root)) {
  const scan = (kinds: string[], runId?: string) => records(root, { kinds, runId, through });
  const find = (kinds: string[], runId: string | undefined, matches: (data: any) => boolean, latest = false) => {
    let found: { seq: number; data: any } | undefined;
    for (const ref of scan(kinds, runId)) {
      const data = decode(root, ref);
      if (matches(data)) { found = { seq: ref.seq, data }; if (!latest) return found; }
    }
    return found;
  };
  const removed = find(['management.session-removed'], undefined, data => data.sessionId === sessionId, true);
  if (!removed) return false;
  const marker = removed.data, id = marker.operationId, management = `management:${id}`;
  const preview = find(['management.preview'], management, () => true), commit = find(['management.commit'], management, () => true);
  const complete = find(['management.part-result'], management, data => data.unitId === `session:${sessionId}`, true);
  if (marker.version !== 1 || marker.state !== 'cleaned' || marker.complete !== true || !preview || !commit || complete?.data.status !== 'completed' || preview.data.identity !== marker.previewIdentity || commit.data.identity !== marker.previewIdentity || complete.data.identity !== marker.previewIdentity) return false;
  try {
    if (preview.data.plan.bytes > 16 * 1024 * 1024) return false;
    const bytes = readObject(root, preview.data.plan); if (digest(bytes) !== marker.previewIdentity) return false;
    const plan = JSON.parse(bytes.toString()), unit = plan.units?.find((u: any) => u.id === `session:${sessionId}`);
    // Exact copied facts remain valid after whole-root relocation; they authorize no old execution.
    if (plan.id !== id || plan.version !== 1 || !unit || unit.kind !== 'session' || unit.protectedBy.length || !unit.inspection?.conversations?.length || unit.inspection.pending !== 0 || JSON.stringify(unit.files) !== JSON.stringify(marker.files) || JSON.stringify(unit.inspection) !== JSON.stringify(marker.inspection)) return false;
    const expected = new Set<string>(unit.runIds), runs = new Set<string>();
    for (const ref of scan(['task.accepted'])) {
      if (decode(root, ref).sessionId !== sessionId) continue;
      if (!expected.has(ref.runId)) return false;
      runs.add(ref.runId);
    }
    const sorted = [...runs].sort();
    if (!runs.size || JSON.stringify(sorted) !== JSON.stringify([...unit.runIds].sort()) || JSON.stringify(sorted) !== JSON.stringify([...marker.runIds].sort())) return false;
    for (const runId of runs) {
      const close = find(['run.closed', 'recovery.closed'], runId, () => true, true);
      const result = close?.data.result ?? close?.data;
      if (!close || close.seq > removed.seq || result.cleanup !== 'confirmed' || !['completed', 'failed', 'aborted'].includes(result.status)) return false;
      // Every later kind matters here, but its body is unnecessary to invalidate the exception.
      for (const ref of records(root, { runId, after: removed.seq, through })) {
        if (!['evidence.availability', 'evidence.fixed', 'evidence.unfixed', 'usage.estimate'].includes(ref.kind)) return false;
      }
    }
    return unit.files.every((file: any) => Boolean(find(['management.file-result'], management, data => data.unitId === unit.id && data.path === file.path && data.sha256 === file.sha256 && data.bytes === file.bytes && ['deleted', 'absent-after-recorded-intent'].includes(data.state))));
  } catch { return false; }
}
