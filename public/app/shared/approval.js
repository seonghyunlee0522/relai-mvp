/* Approval record form — shared by 01 착수 결과 승인 (프로젝트 정의 drawer) and 02 요구사항 기준선 승인 (요구사항 Drawer).
 *   approvalFields(a, { people, methods, disabled, approverHint })   승인자(이해관계자 선택 / 직접 입력 + 이해관계자에도 추가) · 승인일(≤ 오늘) · 방법 · 근거 · 조건/보완
 *   collectApproval(root, a)                                          read the fields back into a working copy
 *   approvalBody(a)                                                   working copy → API body ('__direct' → '', no baseline)
 * Same markup and data-af attributes on both screens; the caller wires `[data-af="approver_id"]` change → redraw (shows the direct-entry inputs). */
import { html, raw } from '../core/dom.js';

const ORG = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
const ORDER = { CLIENT: 0, OTHER: 1, PARTNER: 2, OWN: 3 };
export const localYmd = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

/** methods = [[key, label], …]; people = stakeholder rows; approverHint = raw HTML after the 승인자 label. */
export function approvalFields(a, { people = [], methods = [], disabled = false, approverHint = '', evidencePh = '' } = {}) {
  const dis = disabled ? 'disabled' : '';
  const list = [...people].filter((x) => x.name).sort((x, y) => (ORDER[x.org_type] ?? 9) - (ORDER[y.org_type] ?? 9));
  const direct = !a.approver_id || a.approver_id === '__direct';
  return html`<div class="def__grid2">
        <div class="field" data-field="approval.approver"><label>승인자 <span class="req">*</span> ${raw(approverHint)}</label>
          <select class="select select--sm" data-af="approver_id" ${dis}><option value="">선택</option>${raw(list.map((x) => html`<option value="${x.id}" ${a.approver_id === x.id ? 'selected' : ''}>${ORG[x.org_type] || '기타'} · ${x.name}${x.role ? ` (${x.role})` : ''}</option>`).join(''))}<option value="__direct" ${a.approver_id === '__direct' || (!a.approver_id && a.approver_name) ? 'selected' : ''}>직접 입력</option></select>
          ${raw(direct && (a.approver_id === '__direct' || a.approver_name) ? html`<div class="apv__direct"><input class="input input--sm" data-af="approver_name" value="${a.approver_name}" maxlength="100" placeholder="이름" ${dis}><input class="input input--sm" data-af="approver_title" value="${a.approver_title}" maxlength="100" placeholder="직위 (예: 상무)" ${dis}>
            <label class="toggle"><input type="checkbox" data-af="add_to_stakeholders" ${a.add_to_stakeholders !== false ? 'checked' : ''} ${dis}> 이해관계자에도 추가</label></div>` : '')}</div>
        <div class="field" data-field="approval.date"><label>승인일 <span class="req">*</span></label><input class="input input--sm" type="date" data-af="date" value="${a.date}" max="${localYmd()}" ${dis}></div>
      </div>
      <div class="field" data-field="approval.method"><label>승인 방법 <span class="req">*</span></label><div class="apv__methods">${raw(methods.map(([k, l]) => html`<label class="toggle"><input type="radio" name="apv-method" data-af="method" value="${k}" ${a.method === k ? 'checked' : ''} ${dis}> ${l}</label>`).join(''))}</div></div>
      <div class="field" data-field="approval.evidence"><label>근거 <span class="req">*</span> <small class="dim">문서번호·메일 제목·보관 위치 등</small></label><input class="input input--sm" data-af="evidence" value="${a.evidence}" maxlength="300" placeholder="${evidencePh}" ${dis}></div>
      <div class="field" data-field="approval.conditions"><label>조건 / 보완 요청 <small class="dim">선택</small></label><textarea class="textarea" data-af="conditions" rows="2" maxlength="2000" placeholder="예: 3주차까지 화면 목록 보완 후 재확인" ${dis}>${a.conditions}</textarea></div>`;
}
export function collectApproval(root, prev) {
  const a = { ...prev };
  root.querySelectorAll('[data-af]').forEach((x) => { if (x.type === 'radio') { if (x.checked) a.method = x.value; } else if (x.type === 'checkbox') a[x.dataset.af] = x.checked; else a[x.dataset.af] = x.value; });
  return a;
}
export function approvalBody(prev) {
  const a = { ...prev }; if (a.approver_id === '__direct') a.approver_id = ''; delete a.baseline; return a;
}
