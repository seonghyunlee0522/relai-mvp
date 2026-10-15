/* 01 착수 helpers shared by 프로젝트 정의, Project Charter, What's Next and the phase-move dialogs (Phase 1 v2).
 *   planMenu / bindPlanMenu   "사업수행계획서 내려받기 ▾" (PDF / Word) — GET …/charter/export?format=pdf|docx
 *   term                      one-line term explanation (?) for 01 착수, the Charter, 02 and 03 (WBS)
 *   approvalGateDialog        01→02 without 착수 승인: record it first, or leave a reason (soft gate, never a server block)
 *   isMeasurable              성공 기준 quality hint rule (numbers · % · dates · 이내/이상/이하) — rule-based, not AI */
import { $, html, raw } from '../core/dom.js';
import { wsApi } from '../core/api.js';
import { download } from '../core/ui.js';
import { toast } from '../shared/dialogs.js';
import { state } from '../core/state.js';

export const TERMS = {
  charter: ['프로젝트 헌장', '프로젝트의 목적·범위·조직·일정을 한 장으로 정리한 기준 문서'],
  change_request: ['변경 요청', '확정한 범위·일정·비용을 바꾸자는 요청. 고객 승인 후 반영합니다'],   // Phase 4 US-7
  original_plan: ['최초 계획일', '04 시작 때 잡혀 있던 종료일. 미룬 만큼 +일로 보입니다'],
  kickoff: ['착수보고회(킥오프)', '고객과 수행팀이 목표·범위·일정을 처음 공식적으로 확인하는 회의'],
  plan: ['사업수행계획서', '수행사가 고객에게 제출하는 프로젝트 수행 계획 문서. 착수 단계에서 승인받습니다'],
  milestone: ['마일스톤', '착수보고·중간보고·검수·오픈처럼 반드시 지켜야 하는 프로젝트의 주요 시점'],
  stakeholder: ['이해관계자', '프로젝트에 영향을 주거나 받는 사람(고객·수행사·협력사 담당자)'],
  sponsor: ['스폰서', '비용·결정 권한을 가진 고객 측 책임자'],
  baseline: ['승인 / 기준선', '승인된 목표·범위·일정이 이후 변경관리·검수의 기준이 됩니다'],
  // 02 요구사항 정의 only (Phase 2 US-5)
  req_baseline: ['기준선', '고객이 승인한 요구사항 목록. 이후 바뀌는 것은 변경 요청으로 관리합니다'],
  nonfunctional: ['비기능 요구사항', '기능이 아니라 성능·보안·가용성·운영처럼 시스템이 갖춰야 할 품질 조건에 대한 요구사항. 예: 화면 응답 3초 이내'],
  criteria: ['완료 조건', '이 요구사항이 다 됐다고 판단하는 기준. 검수 기준이 됩니다'],
  // 03 분석·설계 only (Phase 3 US-6)
  wbs: ['WBS', '프로젝트에서 해야 할 일을 잘게 나눈 작업 목록'],
  dependency: ['선행관계', '앞 작업이 끝나야 시작할 수 있는 관계'],
  wbs_milestone: ['마일스톤', '고객과 공유할 주요 시점. 01 주요 일정을 가져올 수 있습니다'],
  gantt: ['간트', '작업의 시작일·종료일을 막대로 그린 일정표'],
  skeleton: ['WBS 뼈대', '요구사항과 꼭 필요한 시험·오픈 작업을 넣은 기본 작업 목록'],
  // 05 시험 only (Phase 5 US-7)
  coverage: ['커버리지', '범위 내 요구사항 중 테스트가 연결된 비율'],
  uat: ['UAT', '고객 현업이 직접 확인하는 인수 테스트'],
  // 06 전환 및 오픈 only (Phase 6 US-8)
  acceptance: ['검수', '고객이 결과물을 범위대로 받았다고 확인하는 절차. 보통 검수확인서 서명으로 끝납니다'],
  carryover: ['운영 이관', '오픈 뒤 운영 단계에서 처리하기로 넘긴 문제'],
  // 07 운영 및 유지보수 only (Phase 7 US-6)
  completion_report: ['완료보고서', '프로젝트 결과·계획 대비 차이·남은 일·교훈을 정리해 고객과 회사에 보고하는 문서'],
  warranty: ['하자보수', '오픈 후 일정 기간 결함을 무상으로 고치는 기간. 보통 계약서에 12개월'],
  scope: ['범위 내 / 범위 외', '범위 내는 이번 계약에서 만드는 것, 범위 외는 이번에는 하지 않기로 한 것. 범위 외를 나중에 하려면 변경 요청으로 추가합니다'],
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

/** "요구사항 정의서 ▾" (PDF / Word) — GET …/requirements/export-doc?format=pdf|docx (Phase 2 US-2). */
export const reqDocUrl = (pid, fmt) => wsApi(`/${pid}/requirements/export-doc?format=${fmt}`);
export const reqDocMenu = (label = '요구사항 정의서') => html`<details class="pmenu" data-reqdoc-menu><summary class="btn btn--secondary btn--sm">${label} ▾</summary>
  <div class="pmenu__list" role="menu"><button type="button" role="menuitem" data-reqdoc="pdf">PDF (.pdf)</button><button type="button" role="menuitem" data-reqdoc="docx">Word (.docx)</button></div></details>`;
export function bindReqDocMenu(root, pid) {
  root.querySelectorAll('[data-reqdoc]').forEach((b) => { b.onclick = async () => {
    const d = b.closest('details'); if (d) d.open = false;
    try { await download(reqDocUrl(pid, b.dataset.reqdoc)); toast('요구사항 정의서를 내려받았습니다.'); } catch (e) { toast(e.message); }
  }; });
}

export { isMeasurable } from '../shared/criteria.js';

/**
 * Approval gates (soft, never a server block): leaving a phase whose customer approval is not recorded asks to record it first,
 * or to leave a reason. 01→02 (착수 결과 승인, Phase 1 US-2) and 02→03 (요구사항 기준선 승인, Phase 2 US-1) share the dialog.
 */
export const APPROVAL_GATES = {
  INITIATION: { step: 'APPROVAL', record: (pid) => `/app/projects/${pid}/definition?activity=APPROVAL`,
    title: '고객 승인 없이 요구사항 단계로 넘어가려 합니다',
    body: '착수 결과(목표·범위·일정)를 고객이나 스폰서가 승인하지 않은 채 진행하면, 이후 요구사항과 검수 기준을 두고 다툼이 생기기 쉽습니다. 가능하면 사업수행계획서를 보내 승인을 먼저 받으세요.' },
  REQUIREMENTS: { step: 'BASELINE_APPROVAL', record: (pid) => `/app/projects/${pid}/requirements?approval=1`,
    title: '고객 승인 없이 분석·설계 단계로 넘어가려 합니다',
    body: "요구사항 기준선을 고객이 승인하지 않은 채 진행하면, 설계·개발 중 '이건 요청한 적 없다/빠졌다'는 다툼이 생기기 쉽습니다. 요구사항 정의서를 보내 승인을 먼저 받으세요." },
  // Phase 5 US-1: 05 → 06 with 요구사항별 테스트 준비 open — same dialog, test wording
  TESTING: { step: 'TEST_PLAN', record: (pid) => `/app/projects/${pid}/tests?tab=coverage`,
    title: '테스트가 없는 요구사항이 있는 채로 전환 및 오픈 단계로 넘어가려 합니다',
    body: '범위 내 요구사항 중 테스트도 제외 사유도 없는 것이 있습니다. 검증하지 않은 요구사항은 고객 검수에서 빠진 기능으로 드러나기 쉽습니다. 테스트를 만들거나, 다른 방법으로 확인한다면 제외 사유를 남기세요.',
    recordLabel: '테스트 준비하러 가기', reasonLabel: '테스트 준비 없이 진행하는 이유', placeholder: '예: 고객 일정상 06 검수에서 남은 요구사항을 함께 확인', tag: '[테스트 준비 전 진행]' },
};
const gateTag = (gate) => gate.tag || '[승인 전 진행]';
/**
 * The phase-leaving soft gate dialog. Resolves 'record' (go to 승인 기록), { reason } (proceed, reason required) or null (cancel).
 * The caller writes the reason to the gate step note as "[승인 전 진행] 사유 · 날짜 · 이름".
 */
export function approvalGateDialog(gate = APPROVAL_GATES.INITIATION) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="agT" data-dialog="approval-gate"><h3 id="agT">${gate.title}</h3>
      <div class="dialog__b">${gate.body}</div>
      <div class="field"><label for="ag-in">${gate.reasonLabel || '승인 없이 진행하는 이유'} <span class="req">*</span></label><input class="input" id="ag-in" maxlength="200" placeholder="${gate.placeholder || '예: 고객 PM 휴가로 승인 회신이 다음 주 예정'}"><div class="err" id="ag-err"></div></div>
      <div class="actions"><button class="btn btn--ghost" data-v="cancel">취소</button><span style="flex:1"></span><button class="btn btn--secondary" data-v="proceed">이유 남기고 진행</button><button class="btn btn--primary" data-v="record">${gate.recordLabel || '승인 기록하러 가기'}</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; }
      if (b.dataset.v === 'cancel') return done(null);
      if (b.dataset.v === 'record') return done('record');
      const v = $('#ag-in', el).value.trim();
      if (!v) { $('#ag-err', el).textContent = `${gate.reasonLabel || '승인 없이 진행하는 이유'}를 입력해 주세요.`; $('#ag-in', el).focus(); return; }
      done({ reason: v });
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && e.target.id === 'ag-in') { e.preventDefault(); el.querySelector('[data-v="proceed"]').click(); } });
    document.body.append(el); $('#ag-in', el).focus();
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
const NO_APPROVAL = { INITIATION: '착수 승인 기록 없음 — 고객 승인을 받았다면 착수 결과 승인에 기록해 두세요.', REQUIREMENTS: '기준선 승인 기록 없음 — 고객 승인을 받았다면 요구사항 기준선 승인에 기록해 두세요.',
  TESTING: '테스트 준비 미완료 — 범위 내 요구사항에 테스트를 연결하거나 제외 사유를 남겨 두세요.' };   // Phase 5: 05를 이미 지난 프로젝트 (05 영역에만)
/** 02 (Phase 2): the same line once, in the 02 area of What's Next, for projects already past 02 without a baseline approval. */
export const noApprovalLine = (g, phaseKey = 'INITIATION') => {
  const ph = (g.phases || []).find((x) => x.phase_key === phaseKey); const cfg = APPROVAL_GATES[phaseKey]; const st = cfg ? gateStep(g, phaseKey, cfg.step) : null;
  if (!ph || ph.is_current || !ph.is_passed || !st || st.state === 'COMPLETED' || (st.note || '').includes(gateTag(cfg))) return '';
  return `<p class="np__noapv"><i class="st st--warn" aria-hidden="true">!</i>${NO_APPROVAL[phaseKey]}</p>`;
};
export { raw };
