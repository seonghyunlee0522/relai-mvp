/* 01 착수 helpers shared by 프로젝트 정의, Project Charter, What's Next and the phase-move dialogs (Phase 1 v2).
 *   planMenu / bindPlanMenu   "사업수행계획서 내려받기 ▾" (PDF / Word) — GET …/charter/export?format=pdf|docx
 *   term                      one-line term explanation (?) for 01 착수 and the Charter only
 *   approvalGateDialog        01→02 without 착수 승인: record it first, or leave a reason (soft gate, never a server block)
 *   isMeasurable              성공 기준 quality hint rule (numbers · % · dates · 이내/이상/이하) — rule-based, not AI */
import { $, html, raw } from '../core/dom.js';
import { wsApi } from '../core/api.js';
import { download } from '../core/ui.js';
import { toast } from '../shared/dialogs.js';
import { state } from '../core/state.js';

export const TERMS = {
  charter: ['Project Charter', '프로젝트의 목적·범위·조직·일정을 한 장으로 정리한 기준 문서'],
  kickoff: ['착수보고회(킥오프)', '고객과 수행팀이 목표·범위·일정을 처음 공식적으로 확인하는 회의'],
  plan: ['사업수행계획서', '수행사가 고객에게 제출하는 프로젝트 수행 계획 문서. 착수 단계에서 승인받습니다'],
  milestone: ['마일스톤', '착수보고·중간보고·검수·오픈처럼 반드시 지켜야 하는 프로젝트의 주요 시점'],
  stakeholder: ['이해관계자', '프로젝트에 영향을 주거나 받는 사람(고객·수행사·협력사 담당자)'],
  sponsor: ['스폰서', '비용·결정 권한을 가진 고객 측 책임자'],
  baseline: ['승인 / 기준선', '승인된 목표·범위·일정이 이후 변경관리·검수의 기준이 됩니다'],
};
/** Small "?" with a tooltip (hover / focus). */
export const term = (key) => { const t = TERMS[key]; return t ? html`<span class="term" tabindex="0" role="note" aria-label="${t[0]}: ${t[1]}" data-tip="${t[1]}">?</span>` : ''; };

export const planUrl = (pid, fmt) => wsApi(`/${pid}/charter/export?format=${fmt}`);
export const planMenu = (label = '사업수행계획서 내려받기') => html`<details class="pmenu"><summary class="btn btn--secondary btn--sm">${label} ▾</summary>
  <div class="pmenu__list" role="menu"><button type="button" role="menuitem" data-plan="pdf">PDF (.pdf)</button><button type="button" role="menuitem" data-plan="docx">Word (.docx)</button></div></details>`;
export function bindPlanMenu(root, pid) {
  root.querySelectorAll('[data-plan]').forEach((b) => { b.onclick = async () => {
    const d = b.closest('details'); if (d) d.open = false;
    try { await download(planUrl(pid, b.dataset.plan)); toast('사업수행계획서를 내려받았습니다.'); } catch (e) { toast(e.message); }
  }; });
}

export { isMeasurable } from '../shared/criteria.js';

/**
 * The 01→02 soft gate (spec US-2). Resolves 'record' (go to 승인 기록), { reason } (proceed, reason required) or null (cancel).
 * The caller writes the reason to the APPROVAL step note as "[승인 전 진행] 사유 · 날짜 · 이름".
 */
export function approvalGateDialog() {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="agT" data-dialog="approval-gate"><h3 id="agT">고객 승인 없이 요구사항 단계로 넘어가려 합니다</h3>
      <div class="dialog__b">착수 결과(목표·범위·일정)를 고객이나 스폰서가 승인하지 않은 채 진행하면, 이후 요구사항과 검수 기준을 두고 다툼이 생기기 쉽습니다. 가능하면 사업수행계획서를 보내 승인을 먼저 받으세요.</div>
      <div class="field"><label for="ag-in">승인 없이 진행하는 이유 <span class="req">*</span></label><input class="input" id="ag-in" maxlength="200" placeholder="예: 고객 PM 휴가로 승인 회신이 다음 주 예정"><div class="err" id="ag-err"></div></div>
      <div class="actions"><button class="btn btn--ghost" data-v="cancel">취소</button><span style="flex:1"></span><button class="btn btn--secondary" data-v="proceed">이유 남기고 진행</button><button class="btn btn--primary" data-v="record">승인 기록하러 가기</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; }
      if (b.dataset.v === 'cancel') return done(null);
      if (b.dataset.v === 'record') return done('record');
      const v = $('#ag-in', el).value.trim();
      if (!v) { $('#ag-err', el).textContent = '승인 없이 진행하는 이유를 입력해 주세요.'; $('#ag-in', el).focus(); return; }
      done({ reason: v });
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && e.target.id === 'ag-in') { e.preventDefault(); el.querySelector('[data-v="proceed"]').click(); } });
    document.body.append(el); $('#ag-in', el).focus();
  });
}
/** "[승인 전 진행] 사유 · 2026-10-15 · 홍길동" appended to the existing note. */
export const bypassNote = (prev, reason) => {
  const d = new Date(); const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const line = `[승인 전 진행] ${reason.replace(/\s*·\s*/g, ', ')} · ${ymd} · ${(state.user && state.user.name) || ''}`;
  return prev ? `${prev}\n${line}` : line;
};
export const approvalStep = (g) => { const ini = (g.phases || []).find((x) => x.phase_key === 'INITIATION'); return ini ? (ini.steps || []).find((s) => s.step_key === 'APPROVAL') || null : null; };
/** Pre-31 / already-advanced projects: "착수 승인 기록 없음" once, on the 01 screen and the 01 area of What's Next only (spec D3). */
export const noApprovalLine = (g) => {
  const ini = (g.phases || []).find((x) => x.phase_key === 'INITIATION'); const st = approvalStep(g);
  if (!ini || ini.is_current || !st || st.state === 'COMPLETED' || /\[승인 전 진행\]/.test(st.note || '')) return '';
  return '<p class="np__noapv"><i class="st st--warn" aria-hidden="true">!</i>착수 승인 기록 없음 — 고객 승인을 받았다면 착수 결과 승인에 기록해 두세요.</p>';
};
export { raw };
