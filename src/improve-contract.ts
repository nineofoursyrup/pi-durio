import type {ImproveReport,ImproveCandidate} from './improve.js';

/** New writers carry an explicit marker. Pre-marker #88 reports are identifiable
 * by the complete pair of declared-content keys. Empty/partial data proves no version. */
export function improveReportContract(report:Pick<ImproveReport,'candidates'|'suppressed'|'selectionContract'>):'declared'|'legacy'|'unknown' {
 if(report.selectionContract==='declared-v1')return 'declared';
 const candidates=[...report.candidates,...(report.suppressed??[]).map(s=>s.candidate)];
 if(!candidates.length)return 'unknown';
 if(candidates.some(c=>('replacements' in c)!==('structuredChecks' in c)))return 'unknown';
 return candidates.some(c=>Array.isArray(c.replacements)&&Array.isArray(c.structuredChecks))?'declared':'legacy';
}
export function candidateExecutable(candidate:ImproveCandidate) {
 return !candidate.suggestionOnly&&candidate.target.state==='verified'&&!!candidate.replacements?.length&&!!candidate.structuredChecks?.length;
}
