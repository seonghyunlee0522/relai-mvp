/* "확정된 요구사항을 바꾸려 합니다" — asking once before a confirmed requirement changes (Phase 2 US-3).
 *
 * Trigger (UI only — the API still accepts the edit, the prompt builds a habit, it is not a lock):
 *   - 확정(CONFIRMED) requirement: 제목 · 설명 · 완료 조건 · 범위 changed (detail, list cell, bulk edit), or archiving a confirmed 범위 내 one
 *   - after 요구사항 기준선 승인: adding a new requirement as 범위 내
 * Skipped when the requirement already has an APPROVED change request (approved_cr_count, one read with the row).
 * [변경 요청 만들기] leaves the requirement untouched and creates one DRAFT change request through the existing CR API, linked to the
 * requirement(s), with the proposal (필드별 변경 전 → 후) as its description. [단순 수정으로 저장] (adding: [그냥 추가]) saves as before; [취소] saves nothing. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toastAction } from '../shared/dialogs.js';
import { navigate } from '../core/router.js';

export { GUARDED_FIELDS, FIELD_LABEL, needsPrompt, needsAddPrompt, proposalLine } from './change-rules.js';
import { needsPrompt, proposalLine } from './change-rules.js';

const short = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** The grey one-line summary of what changes (L-D4): "완료 조건: 3개 → 4개", "제목: A → B". */
export function diffLine(r, field, before, after) {
  if (field === 'criteria') {
    const n = (r.criteria && r.criteria.length) ?? Number(r.criteria_count || 0);
    return before ? `완료 조건: ${short(String(before), 40)} → ${short(String(after), 40)}` : `완료 조건: ${n}개 → ${n + 1}개`;
  }
  if (field === 'archive') return `보관: ${r.display_id} ${short(r.title, 60)} (범위에서 제외)`;
  return short(proposalLine(field, before, after).replace(/^- /, ''), 120);
}
/** Resolves 'cr' | 'save' | null (취소). `diff` = one grey line under the body. */
export function changePromptDialog({ adding = false, diff = '' } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cgT" data-dialog="req-change" tabindex="-1"><h3 id="cgT">${adding ? '승인된 기준선에 요구사항을 추가하려 합니다' : '확정된 요구사항을 바꾸려 합니다'}</h3>
      <div class="dialog__b">${adding ? '고객이 새로 요청한 요구사항이면 변경 요청으로 등록해 영향(일정·공수)을 검토하고 승인받으세요. 원래 승인 범위에 있었는데 빠뜨린 것이면 그냥 추가해도 됩니다.' : '고객 요청으로 내용이 바뀌는 것이면 변경 요청으로 등록해 영향(일정·공수)을 검토하고 승인받으세요. 오타·표현 수정이면 그냥 저장해도 됩니다.'}</div>${raw(diff ? html`<p class="dialog__diff" data-diff>${diff}</p>` : '')}
      <div class="actions actions--stack"><button class="btn btn--ghost" data-v="cancel">취소</button><span class="actions__sp"></span><button class="btn btn--secondary" data-v="save">${adding ? '그냥 추가' : '단순 수정으로 저장'}</button><button class="btn btn--primary" data-v="cr">변경 요청 만들기</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; } done(b.dataset.v === 'cancel' ? null : b.dataset.v); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    // focus the dialog, not a button: the Enter that committed the edit (blur → this dialog) must not press one
    document.body.append(el); $('.dialog', el).focus();
  });
}

/** Create the DRAFT change request (existing API, 영향 WBS pre-filled from the requirements' WBS links) and open it (R3b F8 · F9). */
export async function createChangeDraft(pid, { title, lines, requirementIds = [], relation = 'MODIFIES', open = true }) {
  const description = ['제안 내용 (변경 전 → 후)', ...lines].join('\n');
  const res = await api('POST', wsApi(`/${pid}/changes`), { title: title.slice(0, 200), description, requirements: requirementIds.map((id) => ({ requirement_id: id, relation_type: relation })), impacts_from_requirements: true });   // R3b F8
  const c = res.change;
  // R3b F9: open the new CR's drawer right away (after the caller's synchronous clean-up); bulk edits that keep working pass open:false → toast link
  const go = () => navigate(`/app/projects/${pid}/changes?sel=${c.id}`);
  if (!open) { toastAction(`변경 요청 ${c.display_id} 초안을 만들었습니다. 승인되면 요구사항을 수정하세요.`, { label: '변경 요청 열기', ms: 12000, onAction: go }); return c; }
  const back = location.pathname + location.search;
  setTimeout(() => { go(); toastAction(`변경 요청 ${c.display_id} 초안을 만들었습니다. 승인되면 요구사항을 수정하세요.`, { label: '요구사항으로 돌아가기', ms: 8000, onAction: () => navigate(back) }); }, 0);
  return c;
}

/**
 * Guard one edit. `apply()` performs the save. Returns true when the save ran, false when a CR was made or the user cancelled.
 * opts = { r (requirement row), field, before, after, title? }
 */
export async function guardEdit(pid, { r, field, before, after }, apply) {
  if (!needsPrompt(r, field)) { await apply(); return true; }
  const v = await changePromptDialog({ diff: diffLine(r, field, before, after) });
  if (v === 'save') { await apply(); return true; }
  if (v === 'cr') await createChangeDraft(pid, { title: `${r.display_id} 변경: ${r.title}`, lines: [field === 'archive' ? `- 보관(범위에서 제외): ${r.display_id} ${r.title}` : proposalLine(field, before, after)], requirementIds: [r.id], relation: field === 'archive' ? 'REMOVES' : 'MODIFIES' });
  return false;
}
