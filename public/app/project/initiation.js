/* 01 착수 helpers shared by 프로젝트 정의, Project Charter, What's Next and the phase-move dialogs (Phase 1 v2).
 *   planMenu / bindPlanMenu   "사업수행계획서 내려받기 ▾" (PDF / Word) — GET …/charter/export?format=pdf|docx
 *   approvalGateDialog        05→06 without 요구사항별 테스트 준비: 준비하러 가기 / 이유 남기고 진행 (soft gate, never a server block)
 *   isMeasurable              성공 기준 quality hint rule (numbers · % · dates · 이내/이상/이하) — rule-based, not AI */
import { $, html, raw } from '../core/dom.js';
import { wsApi } from '../core/api.js';
import { download } from '../core/ui.js';
import { toast } from '../shared/dialogs.js';
import { state } from '../core/state.js';
import { definitionHref } from '../shared/lifecycle.js';
import { wireDetailsMenus } from '../core/outside.js';

export const planUrl = (pid, fmt) => wsApi(`/${pid}/charter/export?format=${fmt}`);
export const planMenu = (label = '사업수행계획서 내려받기') => html`<details class="pmenu"><summary class="btn btn--secondary btn--sm">${label} ▾</summary>
  <div class="pmenu__list" role="menu"><button type="button" role="menuitem" data-plan="pdf">PDF (.pdf)</button><button type="button" role="menuitem" data-plan="docx">Word (.docx)</button><button type="button" role="menuitem" data-plan="example">작성 예시 보기 (PDF)</button></div></details>`;
export function bindPlanMenu(root, pid) {
  wireDetailsMenus();   // Jim mobile 10-21 #2: closes on an outside tap like the report's .rmenu
  root.querySelectorAll('[data-plan]').forEach((b) => { b.onclick = async () => {
    const d = b.closest('details'); if (d) d.open = false;
    // 작성 예시 (batch7 #4): the sample-built plan opens in a new tab (served inline)
    if (b.dataset.plan === 'example') { window.open(wsApi(`/${pid}/charter/example?format=pdf`), '_blank', 'noopener'); return; }
    try { await download(planUrl(pid, b.dataset.plan)); toast('사업수행계획서를 내려받았습니다.'); } catch (e) { toast(e.message); }
  }; });
}

/** "요구사항 정의서 ▾" (PDF / Word) — GET …/requirements/export-doc?format=pdf|docx (Phase 2 US-2). */
export const reqDocUrl = (pid, fmt) => wsApi(`/${pid}/requirements/export-doc?format=${fmt}`);
export const reqDocMenu = (label = '요구사항 정의서') => html`<details class="pmenu" data-reqdoc-menu><summary class="btn btn--secondary btn--sm">${label} ▾</summary>
  <div class="pmenu__list" role="menu"><button type="button" role="menuitem" data-reqdoc="pdf">PDF (.pdf)</button><button type="button" role="menuitem" data-reqdoc="docx">Word (.docx)</button></div></details>`;
export function bindReqDocMenu(root, pid) {
  wireDetailsMenus();
  root.querySelectorAll('[data-reqdoc]').forEach((b) => { b.onclick = async () => {
    const d = b.closest('details'); if (d) d.open = false;
    try { await download(reqDocUrl(pid, b.dataset.reqdoc)); toast('요구사항 정의서를 내려받았습니다.'); } catch (e) { toast(e.message); }
  }; });
}

export { isMeasurable } from '../shared/criteria.js';

/**
 * Soft phase-leaving gates (never a server block). Only 05→06 (테스트 준비) is left; the 01→02 / 02→03 approval gates were removed 2026-10-21.
 */
export const APPROVAL_GATES = {
  // 2026-10-21 (승인 절차 제거): 01→02 and 02→03 ask nothing any more — 착수 결과 확인 / 요구사항 확정 확인 are 진행 여부 체크 only.
  // Phase 5 US-1: 05 → 06 with 요구사항별 테스트 준비 open — same dialog, test wording
  TESTING: { step: 'TEST_PLAN', record: (pid) => `/app/projects/${pid}/tests?tab=coverage`,
    title: '테스트가 없는 요구사항이 있는 채로 전환 및 오픈 단계로 넘어가려 합니다',
    body: '범위 내 요구사항 중 테스트도 제외 사유도 없는 것이 있습니다. 검증하지 않은 요구사항은 고객 검수에서 빠진 기능으로 드러나기 쉽습니다. 테스트를 만들거나, 다른 방법으로 확인한다면 제외 사유를 남기세요.',
    recordLabel: '테스트 준비하러 가기', reasonLabel: '테스트 준비 없이 진행하는 이유', placeholder: '예: 고객 일정상 06 검수에서 남은 요구사항을 함께 확인', tag: '[테스트 준비 전 진행]' },
};
const gateTag = (gate) => gate.tag || '[승인 전 진행]';
export const NO_REASON = '승인 없이 진행';
/**
 * The phase-leaving soft gate dialog. Resolves 'record' (go to 승인 기록), { reason } (proceed, reason required) or null (cancel).
 * The caller writes the reason to the gate step note as "[승인 전 진행] 사유 · 날짜 · 이름".
 */
export function approvalGateDialog(gate = APPROVAL_GATES.INITIATION) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="agT" data-dialog="approval-gate"><h3 id="agT">${gate.title}</h3>
      <div class="dialog__b">${gate.body}</div>
      ${raw(gate.noReason ? '' : html`<div class="field"><label for="ag-in">${gate.reasonLabel || '승인 없이 진행하는 이유'} <span class="req">*</span></label><input class="input" id="ag-in" maxlength="200" placeholder="${gate.placeholder || '예: 고객 PM 휴가로 승인 회신이 다음 주 예정'}"><div class="err" id="ag-err"></div></div>`)}
      <div class="actions"><button class="btn btn--ghost" data-v="cancel">취소</button><span style="flex:1"></span><button class="btn btn--secondary" data-v="proceed">${gate.proceedLabel || '이유 남기고 진행'}</button><button class="btn btn--primary" data-v="record">${gate.recordLabel || '승인 기록하러 가기'}</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; }
      if (b.dataset.v === 'cancel') return done(null);
      if (b.dataset.v === 'record') return done('record');
      if (gate.noReason) return done({ reason: NO_REASON });
      const v = $('#ag-in', el).value.trim();
      if (!v) { $('#ag-err', el).textContent = `${gate.reasonLabel || '승인 없이 진행하는 이유'}를 입력해 주세요.`; $('#ag-in', el).focus(); return; }
      done({ reason: v });
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && e.target.id === 'ag-in') { e.preventDefault(); el.querySelector('[data-v="proceed"]').click(); } });
    document.body.append(el); ($('#ag-in', el) || el.querySelector('[data-v="record"]')).focus();
  });
}
/** "[승인 전 진행] 사유 · 2026-10-15 · 홍길동" appended to the existing note. */
export const bypassNote = (prev, reason, gate = null) => {
  const d = new Date(); const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const line = `${gate ? gateTag(gate) : '[승인 전 진행]'} ${reason.replace(/\s*·\s*/g, ', ')} · ${ymd} · ${(state.user && state.user.name) || ''}`;
  return prev ? `${prev}\n${line}` : line;
};
export const gateStep = (g, phaseKey, stepKey) => { const ph = (g.phases || []).find((x) => x.phase_key === phaseKey); return ph ? (ph.steps || []).find((s) => s.step_key === stepKey) || null : null; };
export const approvalStep = (g) => gateStep(g, 'INITIATION', 'APPROVAL');
/** Pre-31 / already-advanced projects: "착수 승인 기록 없음" once, on the 01 screen and the 01 area of What's Next only (spec D3). */
const NO_APPROVAL = { TESTING: '테스트 준비 미완료 — 범위 내 요구사항에 테스트를 연결하거나 제외 사유를 남겨 두세요.' };   // Phase 5: 05를 이미 지난 프로젝트 (05 영역에만)
/** 02 (Phase 2): the same line once, in the 02 area of What's Next, for projects already past 02 without a baseline approval. */
export const noApprovalLine = (g, phaseKey = 'INITIATION') => {
  const ph = (g.phases || []).find((x) => x.phase_key === phaseKey); const cfg = APPROVAL_GATES[phaseKey]; const st = cfg ? gateStep(g, phaseKey, cfg.step) : null;
  if (!ph || ph.is_current || !ph.is_passed || !st || st.state === 'COMPLETED' || (st.note || '').includes(gateTag(cfg))) return '';
  return `<p class="np__noapv"><i class="st st--warn" aria-hidden="true">!</i>${NO_APPROVAL[phaseKey]}</p>`;
};
export { raw };
