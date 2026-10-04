/* Onboarding UI pieces (Phase 14): welcome dialog, "RELAI 시작하기" checklist, one-time coach marks, phase intro, help menu.
 * All of them are optional layers over the product: if onboarding state is unavailable they render nothing. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import { ob } from './state.js';
import { tour } from './tour.js';

/* ---------- Welcome (first login) ---------- */
export async function maybeWelcome() {
  const o = await ob.get(); if (!o || !o.welcome || o.welcome.status !== 'NOT_STARTED' || $('.scrim')) return;
  const owner = o.audience === 'OWNER_NEW';
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog welcome" role="dialog" aria-modal="true" aria-labelledby="wlT">
    <div class="welcome__mark">R</div>
    <h3 id="wlT">${owner ? 'RELAI에 오신 것을 환영합니다' : `${o.workspace.name} Workspace에 참여했습니다`}</h3>
    <p>${owner ? '프로젝트를 처음부터 끝까지 단계별로 진행할 수 있도록 안내해 드릴게요. 먼저 화면 구성을 짧게 둘러보고 첫 프로젝트를 만듭니다.' : o.workspace.project_count ? '참여 중인 프로젝트를 열어 현재 단계와 담당 업무를 확인할 수 있습니다. 화면 구성을 짧게 둘러볼까요?' : '아직 프로젝트가 없습니다. Workspace 관리자가 프로젝트를 만들면 여기에서 바로 볼 수 있습니다.'}</p>
    <div class="actions"><button type="button" class="btn btn--secondary" data-w="later">나중에 하기</button><button type="button" class="btn btn--primary" data-w="start">${owner || o.workspace.project_count ? '시작하기' : '확인'}</button></div></div>`;
  document.body.append(el); $('[data-w="start"]', el).focus();
  const close = async (start) => {
    el.remove(); await ob.update('WELCOME', start ? 'complete' : 'skip');
    if (start && (owner || o.workspace.project_count)) tour.start();
  };
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-w]'); if (b) close(b.dataset.w === 'start'); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); if (e.key === 'Tab') { const f = [...el.querySelectorAll('button')]; const first = f[0]; const last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } });
}

/* ---------- Checklist "RELAI 시작하기" (OWNER/ADMIN; hidden once complete or dismissed) ---------- */
export function checklistCard(o, { compact = false } = {}) {
  const c = o && o.checklist; if (!c || !c.visible) return '';
  return html`<section class="obcl ${compact ? 'obcl--compact' : ''}" aria-labelledby="obclT" data-tour-id="checklist">
    <div class="obcl__h"><b id="obclT">RELAI 시작하기</b><span class="obcl__n">${c.done} / ${c.total}</span><span class="pbar"><i style="width:${Math.round((c.done / c.total) * 100)}%"></i></span>
      <button type="button" class="link linkbtn obcl__x" data-obcl="dismiss" title="체크리스트 숨기기">숨기기</button></div>
    <ol class="obcl__list">${raw(c.steps.map((s) => html`<li class="${s.done ? 'is-done' : ''}"><i>${s.done ? '✓' : '○'}</i>${raw(s.done ? html`<span>${s.label}</span>` : html`<a href="${s.href}" data-link>${s.label}</a>`)}</li>`).join(''))}</ol>
    ${raw(compact ? '' : '<p class="obcl__hint">프로젝트 진행률과는 다른, 처음 설정을 위한 체크리스트입니다. 모두 완료되면 자동으로 사라집니다.</p>')}</section>`;
}
export function bindChecklist(root) {
  const b = root.querySelector('[data-obcl="dismiss"]'); if (!b) return;
  b.onclick = async () => { const card = b.closest('.obcl'); if (card) card.remove(); await ob.update('CHECKLIST', 'skip'); };
}

/* ---------- Coach marks: one-time, dismissible context banners (not popovers) ---------- */
export const COACH = {
  REQ_TRACE_INTRO: { title: '요구사항 ↔ WBS 연결', body: '요구사항을 열어 WBS 작업을 연결하면 어떤 작업이 어떤 요구사항을 수행하는지(Delivery Trace) 추적할 수 있습니다. 확정된 요구사항은 모두 WBS와 연결하는 것이 목표입니다.' },
  CHANGE_REQUEST_INTRO: { title: '변경 요청', body: '확정된 요구사항을 바꾸거나 추가하는 요청은 변경 요청으로 기록하고, 영향받는 요구사항·WBS와 일정 영향을 함께 관리합니다. 승인된 변경은 WBS에 반영한 뒤 "반영 완료"로 닫습니다.' },
  ISSUE_RISK_INTRO: { title: 'Issue와 Risk', body: 'Issue는 이미 발생해 진행을 막는 문제, Risk는 아직 발생하지 않았지만 영향을 줄 수 있는 위험입니다. 담당자·기한·심각도를 정해 두면 Overview의 확인 필요 목록에 자동으로 올라옵니다.' },
  TESTING_INTRO: { title: '테스트', body: '요구사항을 기준으로 테스트 항목을 만들고 실행 결과(Pass/Fail/Blocked)를 기록합니다. Fail은 바로 Issue로 등록할 수 있고, Coverage 탭에서 테스트가 없는 요구사항을 확인합니다.' },
  ACCEPTANCE_INTRO: { title: '검수', body: '검수는 고객이 결과물을 확인하는 절차입니다. 대상 요구사항과 테스트를 묶어 검수를 요청하고 승인·반려·보완 결과를 기록하세요.' },
  JIRA_OPTIONAL_INTRO: { title: 'Jira를 사용하고 있나요? (선택)', body: 'RELAI WBS와 Jira Issue를 연결하면 실행 상태를 자동으로 추적할 수 있습니다. 연결하지 않아도 프로젝트를 계속 진행할 수 있습니다.' },
  JIRA_EXECUTION_INTRO: { title: 'Jira 실행 연결 (선택)', body: '개발팀이 Jira를 쓴다면 WBS 작업에 Jira Issue를 연결해 실행 상태를 자동으로 가져올 수 있습니다. Jira 없이도 WBS 진행률만으로 프로젝트를 진행할 수 있습니다.' },
  WEEKLY_REPORT_INTRO: { title: '주간보고', body: '프로젝트가 어느 정도 진행되면 주간보고를 생성해 진행 현황·이슈·다음 계획을 고객과 공유할 수 있습니다. 보고서는 현재 데이터로 자동 작성되고 수정할 수 있습니다.' },
  AI_INTRO: { title: 'AI 기능 (보조)', body: 'AI는 요구사항 추출, WBS 초안, 변경 영향 분석을 돕는 보조 기능입니다. 결과는 초안이며 검토 후 반영합니다. AI 없이도 모든 기능을 쓸 수 있습니다.' },
};
export function coachMark(key, extra = {}) {
  const c = COACH[key]; if (!c || ob.guideSeen(key)) return '';
  return html`<div class="coach" role="note" data-coach="${key}"><div class="coach__i">i</div><div class="coach__b"><b>${extra.title || c.title}</b><p>${extra.body || c.body}</p>${raw(extra.cta ? html`<a class="link" href="${extra.cta.href}" data-link>${extra.cta.label}</a>` : '')}</div><button type="button" class="coach__x" data-coach-close="${key}" aria-label="닫기">×</button></div>`;
}
export function bindCoach(root) {
  root.querySelectorAll('[data-coach-close]').forEach((b) => { b.onclick = async () => { const box = b.closest('.coach'); if (box) box.remove(); await ob.markGuide(b.dataset.coachClose); }; });
}

/* ---------- Phase intro: "이 단계에서 하는 일" once per phase ---------- */
export const PHASE_INTRO = {
  INITIATION: { what: '프로젝트의 목표, 범위, 이해관계자, 상위 일정, 운영 방식을 정리해 출발 기준을 맞춥니다.', outputs: ['프로젝트 정의'] },
  REQUIREMENTS: { what: '무엇을 만들어야 하는지 수집·정리해 고객과 합의된 요구사항 기준선을 만듭니다.', outputs: ['요구사항 목록', '분류·우선순위·범위', '확정'] },
  ANALYSIS_DESIGN: { what: '요구사항을 실행 가능한 작업(WBS)으로 구체화하고 담당자·일정·선후관계를 설계합니다.', outputs: ['WBS', 'Requirements ↔ WBS 연결', '담당자·일정·마일스톤'] },
  DEVELOPMENT: { what: '실행 계획대로 진행하면서 진척, 지연, Issue, 변경 요청을 관리합니다.', outputs: ['진행 현황', 'Issue', '변경 요청'] },
  TESTING: { what: '요구사항이 실제 시스템에 올바르게 구현되었는지 테스트로 검증하고 결함을 조치합니다.', outputs: ['Test Case', '실행 결과', 'Fail → Issue'] },
  TRANSITION_GO_LIVE: { what: '검수로 인수 승인을 받고 전환·교육·오픈·안정화를 진행합니다.', outputs: ['검수 승인', '전환 계획', 'Go-Live'] },
  OPERATIONS: { what: '운영 조직에 이관하고 유지보수 체계와 종료 사항을 정리합니다.', outputs: ['운영 이관', '종료 정리'] },
};
export function phaseIntro(phaseKey, phaseName) {
  const key = `PHASE_INTRO_${phaseKey}`; const p = PHASE_INTRO[phaseKey]; if (!p || ob.guideSeen(key)) return '';
  return html`<div class="coach coach--phase" role="note" data-coach="${key}"><div class="coach__i">${phaseName ? phaseName[0] : '!'}</div><div class="coach__b"><b>${phaseName} 단계에서 하는 일</b><p>${p.what}</p><small>필요한 결과: ${p.outputs.join(' · ')}</small></div><button type="button" class="coach__x" data-coach-close="${key}" aria-label="닫기">×</button></div>`;
}

/* ---------- Help menu (global) ---------- */
const SCREEN_HELP = [
  [/^\/app\/?$/, 'Home', '참여 중인 프로젝트와 각 프로젝트의 현재 단계·다음 할 일을 봅니다. 프로젝트가 없으면 [프로젝트 만들기]로 시작합니다.'],
  [/^\/app\/projects\/new/, '새 프로젝트', '이름, 유형, 현재 상황, 기간만 입력하면 프로젝트가 만들어지고 착수 단계부터 안내가 시작됩니다.'],
  [/^\/app\/projects\/[\w-]+\/definition/, '프로젝트 정의', '착수 단계의 5개 항목(목표·범위·이해관계자·일정·운영 방식)을 작성하고 각 항목을 완료 처리합니다. 모두 완료되면 요구사항으로 넘어갑니다.'],
  [/^\/app\/projects\/[\w-]+\/requirements/, '요구사항', '프로젝트 범위와 검수 기준이 되는 요구사항을 등록·분류·확정합니다. 직접 추가, Excel 가져오기, AI 추출(사용 가능 시)을 쓸 수 있습니다.'],
  [/^\/app\/projects\/[\w-]+\/wbs/, 'WBS', '요구사항을 실제 작업 단위로 나누어 담당자·일정·진행률을 관리합니다. 트리/Gantt 보기, Excel Import, AI 초안을 지원하며 Jira 연결은 선택입니다.'],
  [/^\/app\/projects\/[\w-]+\/changes/, '변경 요청', '확정 이후의 추가·변경 요청을 기록하고 영향 요구사항·WBS·일정 영향을 관리합니다.'],
  [/^\/app\/projects\/[\w-]+\/issues/, 'Issues & Risks', '발생한 문제(Issue)와 잠재 위험(Risk)을 담당자·기한과 함께 관리합니다.'],
  [/^\/app\/projects\/[\w-]+\/tests/, 'Tests & Acceptance', '요구사항 기준으로 테스트를 만들고 실행 결과를 기록하며, 고객 검수를 요청·확정합니다.'],
  [/^\/app\/projects\/[\w-]+\/overview/, 'Overview', '계획 대비 실제 진척률과 편차, 일정 상태, 확인 필요 항목, Schedule·Scope·Quality 현황, 7일 내 일정, 최근 Activity를 봅니다.'],
  [/^\/app\/projects\/[\w-]+/, 'What’s Next?', '전체 진행률과 현재 단계, 지금 해야 할 Action을 봅니다. 현재 단계 체크리스트의 작업 버튼으로 실제 업무 화면에서 작업하고 완료 처리하세요.'],
  [/^\/app\/settings/, 'Settings', 'Workspace 이름, 멤버와 역할, 초대 대기, Jira 연결(선택)을 관리합니다.'],
  [/^\/app\/projects/, 'Projects', '이 Workspace의 모든 프로젝트 목록입니다. 프로젝트를 열면 현재 단계와 다음 할 일을 안내합니다.'],
];
export function helpButton() { return html`<button type="button" class="helpbtn" aria-haspopup="menu" aria-expanded="false" title="도움말" data-tour-id="help">?</button>`; }
export function wireHelp(root = document) {
  root.querySelectorAll('.helpbtn').forEach((b) => {
    if (b.dataset.wired) return; b.dataset.wired = '1';
    b.onclick = (e) => { e.stopPropagation(); const open = $('#helpmenu'); if (open) { open.remove(); b.setAttribute('aria-expanded', 'false'); return; } openMenu(b); };
  });
}
function openMenu(btn) {
  const o = ob.peek(); const support = (o && o.support_email) || '';
  const m = document.createElement('div'); m.id = 'helpmenu'; m.className = 'helpmenu'; m.setAttribute('role', 'menu');
  m.innerHTML = html`<button type="button" role="menuitem" data-h="tour">RELAI 가이드 다시 보기</button><button type="button" role="menuitem" data-h="screen">현재 화면 도움말</button><button type="button" role="menuitem" data-h="coach">기능 안내 다시 보기</button>${raw(support ? html`<a role="menuitem" href="mailto:${support}">문의하기</a>` : '')}`;
  const r = btn.getBoundingClientRect(); m.style.cssText = `position:fixed;left:${Math.min(r.left, window.innerWidth - 240)}px;top:${r.bottom + 6 > window.innerHeight - 160 ? r.top - 150 : r.bottom + 6}px`;
  document.body.append(m); btn.setAttribute('aria-expanded', 'true');
  const close = () => { m.remove(); btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
  m.querySelector('[data-h]').focus();
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-h]'); if (!b) return; close();
    if (b.dataset.h === 'tour') { if (!/^\/app/.test(location.pathname)) navigate('/app'); tour.start({ replay: true }); }
    else if (b.dataset.h === 'coach') { await ob.resetGuides(); navigate(location.pathname + location.search, { replace: true }); }
    else screenHelp();
  });
}
export function screenHelp() {
  const hit = SCREEN_HELP.find(([re]) => re.test(location.pathname)) || [null, '도움말', 'RELAI는 착수 → 요구사항 → 일정 → 실행 → 테스트 → 검수 → 오픈 순서로 프로젝트를 안내합니다. 각 화면 상단의 안내와 What’s Next?의 RELAI Guide를 따라가세요.'];
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="shT"><h3 id="shT">${hit[1]}</h3><div class="dialog__b">${hit[2]}</div>
    <div class="actions"><button type="button" class="btn btn--secondary" data-v="tour">전체 가이드 보기</button><button type="button" class="btn btn--primary" data-v="ok">확인</button></div></div>`;
  document.body.append(el); $('[data-v="ok"]', el).focus();
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { el.remove(); if (b.dataset.v === 'tour') tour.start({ replay: true }); } else if (e.target === el) el.remove(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.remove(); });
}
void state;
