/* Pure rules of the US-3 change-request prompt (change-guard.js) — no DOM, unit-tested in server/test/phase2.test.js. */
import { REQ_SCOPE } from '../shared/constants.js';

export const GUARDED_FIELDS = ['title', 'description', 'scope'];   // + 완료 조건 (criteria endpoints)
export const FIELD_LABEL = { title: '제목', description: '설명', scope: '범위', criteria: '완료 조건', archive: '보관' };
const isConfirmed = (r) => r && r.status === 'CONFIRMED' && !r.archived_at;
const approvedCr = (r) => Number(r && r.approved_cr_count) > 0;
/** Does changing `field` of `r` need the prompt? field ∈ title · description · scope · criteria · archive. */
export function needsPrompt(r, field) {
  if (!isConfirmed(r) || approvedCr(r)) return false;
  if (field === 'archive') return r.scope === 'IN_SCOPE';
  return GUARDED_FIELDS.includes(field) || field === 'criteria';
}
const show = (field, v) => { const s = field === 'scope' ? REQ_SCOPE[v] || v : String(v ?? '').trim(); return s ? (s.length > 300 ? `${s.slice(0, 300)}…` : s) : '(없음)'; };
/** One proposal line: "- 제목: A → B". */
export const proposalLine = (field, before, after) => `- ${FIELD_LABEL[field] || field}: ${show(field, before)} → ${show(field, after)}`;
/** After 요구사항 기준선 승인, a new requirement added as 범위 내 changes the approved baseline → the same prompt. */
export const needsAddPrompt = (baseline, scope) => scope === 'IN_SCOPE' && Boolean(baseline && baseline.status === 'COMPLETED');
