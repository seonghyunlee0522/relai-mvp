/* 진행 여부 체크 — shared by 01 착수 결과 공유·확인 (프로젝트 정의 drawer), 02 요구사항 확정 내용 고객 확인 (요구사항 Drawer),
 * 04 변경 요청 고객 확인 (CR Drawer) and 06 검수 고객 확인 (검수 Drawer). Since 2026-10-21 (founder: "승인 받는 절차는 모두 제거") the old
 * approval record (승인자 · 승인일 · 방법 · 근거, all required) is a single optional checkbox + an optional one-line 메모; who/when are
 * recorded by the server. Nothing here is required and nothing blocks a save.
 *   approvalFields(a, { label, disabled, notePh })   the checkbox + 메모 (+ "✓ 홍길동 · 10/21" when checked, + the legacy record line)
 *   collectApproval(root, a)                          read the fields back into a working copy
 *   approvalBody(a)                                   working copy → API body { checked, note } */
import { html, raw } from '../core/dom.js';
import { todayKst } from './kst-date.js';

export const localYmd = () => todayKst();
const md = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`; };
/** "✓ 홍길동 · 10/21" for a checked record ('' when unchecked or unknown). */
export const checkedBy = (a) => (a && a.checked ? [a.checked_by_name, md(a.checked_at)].filter(Boolean).join(' · ') : '');
/** Legacy approval line kept for records made before the check ("이수진 차장 · 2026-10-14 · 이메일 회신"). */
const legacyLine = (a) => a && (a.legacy_summary || (a.approver && a.date ? [`${a.approver.name}${a.approver.title ? ` ${a.approver.title}` : ''}`, a.date, a.method_label].filter(Boolean).join(' · ') : ''));

export function approvalFields(a, { label = '진행했나요?', disabled = false, notePh = '예: 10/21 주간회의에서 고객 PM과 확인' } = {}) {
  const dis = disabled ? 'disabled' : ''; const by = checkedBy(a); const old = legacyLine(a);
  return html`<div class="field" data-field="approval.checked"><label class="toggle"><input type="checkbox" data-af="checked" ${a.checked ? 'checked' : ''} ${dis}> <b>${label}</b> <small class="dim">진행 여부 체크${by ? ` · ✓ ${by}` : ''}</small></label></div>
      <div class="field" data-field="approval.note"><label>메모 <small class="dim">선택 · 한 줄</small></label><input class="input input--sm" data-af="note" value="${a.note || ''}" maxlength="300" placeholder="${notePh}" ${dis}></div>
      ${raw(old ? html`<p class="hint">이전 승인 기록: ${old}</p>` : '')}`;
}
/** Footer status line. */
export const approvalStatusText = (a) => (a && a.checked ? '체크됨' : '체크 안 함 · 선택 사항');
/** Nothing is required any more; kept so callers keep one shape. */
export function approvalErrors() { return {}; }
export function showApprovalErrors(root) { root.querySelectorAll('.apv__err').forEach((x) => x.remove()); return 0; }
export function collectApproval(root, prev) {
  const a = { ...prev };
  root.querySelectorAll('[data-af]').forEach((x) => { if (x.type === 'checkbox') a[x.dataset.af] = x.checked; else a[x.dataset.af] = x.value; });
  return a;
}
export function approvalBody(prev) {
  return { checked: Boolean(prev && prev.checked), note: String((prev && prev.note) || '').trim() };
}
