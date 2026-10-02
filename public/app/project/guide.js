import { api, wsApi } from '../core/api.js';
import { html, no2, raw } from '../core/dom.js';
import { FEATURE_ROUTES, STATUS, STATUS_CHIP } from '../shared/constants.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { revealAskButton, wireAssistant } from '../ai/assistant.js';
import { headerActions, wireProjectActions } from './actions.js';

export function wbsStepInfo(stepKey, st, pid) {
  if (!st) return null;
  const go = (qs, label = 'WBS에서 확인') => ({ label, href: FEATURE_ROUTES.wbs(pid, qs) });
  const none = { text: '아직 등록된 WBS가 없습니다.', ok: false, cta: go('?new=1', 'WBS 만들기') };
  switch (stepKey) {
    case 'TASKS': return st.total === 0 ? none : { text: `현재 ${st.total}개의 WBS가 등록되어 있습니다.`, ok: true, cta: go(''),
      trace: st.tasks && st.tasks_unlinked ? { text: `현재 ${st.tasks}개의 실행 Task 중 ${st.tasks_unlinked}개가 요구사항과 연결되지 않았습니다.`, cta: go('?f=unlinked', '미연결 Task 보기') } : null };
    case 'ORDER': return st.total === 0 ? none : st.dependencies === 0
      ? { text: '아직 작업 간 선후관계가 설정되지 않았습니다.', ok: false, cta: go('') }
      : { text: `${st.dependencies}개의 작업 선후관계가 설정되어 있습니다.`, ok: true, cta: go('') };
    case 'ASSIGN': return st.tasks === 0 ? none : st.tasks_without_owner
      ? { text: `${st.tasks}개 작업 중 ${st.tasks_without_owner}개에 담당자가 지정되지 않았습니다.`, ok: false, cta: go('?f=no_owner') }
      : { text: '모든 작업에 담당자가 지정되었습니다.', ok: true, cta: go('') };
    case 'PLAN': return st.tasks === 0 ? none : st.tasks_without_dates
      ? { text: `${st.tasks_without_dates}개의 작업 일정이 아직 설정되지 않았습니다.`, ok: false, cta: go('?f=no_dates') }
      : { text: '모든 작업에 일정이 설정되었습니다.', ok: true, cta: go('?view=gantt') };
    case 'MILESTONES': return st.milestones === 0
      ? { text: '아직 등록된 주요 마일스톤이 없습니다.', ok: false, cta: go('?new=1&type=MILESTONE', '마일스톤 추가') }
      : { text: `${st.milestones}개의 마일스톤이 등록되어 있습니다.`, ok: true, cta: go('?view=gantt') };
    default: return null;
  }
}
export function changeStepInfo(stepKey, st, pid) {
  if (!st || stepKey !== 'CHANGES') return null;
  const go = (qs, label = '변경 요청 확인') => ({ label, href: FEATURE_ROUTES.changes(pid, qs) });
  if (st.total === 0) return { text: '아직 등록된 변경 요청이 없습니다. 추가·변경 요청이 들어오면 변경 요청으로 기록하세요.', ok: true, cta: go('?new=1', '변경 요청 등록') };
  const parts = [];
  if (st.under_review) parts.push(`검토 중 ${st.under_review}건`);
  if (st.approved_unimplemented) parts.push(`승인 후 미반영 ${st.approved_unimplemented}건`);
  if (!parts.length) return { text: `변경 요청 ${st.total}건이 모두 처리되었습니다.`, ok: true, cta: go('') };
  return { text: `변경 요청: ${parts.join(', ')}`, ok: false, cta: go(st.under_review ? '?status=UNDER_REVIEW' : '?status=APPROVED') };
}
export function raidStepInfo(stepKey, is, rs, pid) {
  if (!is || !rs) return null;
  const go = (qs, label = 'Issues & Risks 확인') => ({ label, href: FEATURE_ROUTES.raid(pid, qs) });
  if (stepKey === 'ISSUES') {
    const riskNote = rs.high_or_critical ? { text: `High 이상 Risk ${rs.high_or_critical}건이 모니터링 중입니다.`, cta: { label: 'Risk 보기', href: `/app/projects/${pid}/issues?tab=risks&risk_level=HIGH,CRITICAL` } } : null;
    if (is.active === 0) return { text: rs.total ? '현재 Open Issue가 없습니다.' : '현재 Open Issue가 없습니다. 문제가 생기면 Issue로 기록하세요.', ok: true, cta: go(is.total ? '' : '?new=1', is.total ? 'Issues & Risks 확인' : 'Issue 등록'), trace: riskNote };
    const parts = [`현재 Open Issue ${is.active}건`]; if (is.critical) parts.push(`Critical ${is.critical}건`); if (is.overdue) parts.push(`Overdue ${is.overdue}건`);
    return { text: parts.join(' · '), ok: false, cta: go(is.critical ? '?severity=CRITICAL' : is.overdue ? '?overdue=1' : ''), trace: riskNote };
  }
  if (stepKey === 'DELAYS' && is.overdue) return { text: `기한이 지난 Issue ${is.overdue}건이 있습니다.`, ok: false, cta: go('?overdue=1', 'Overdue Issue 보기') };
  return null;
}
export const stepInfo = (phaseKey, stepKey, g, pid) =>
  phaseKey === 'REQUIREMENTS' ? reqStepInfo(stepKey, g.requirements, pid) : phaseKey === 'SCHEDULE' ? wbsStepInfo(stepKey, g.wbs, pid)
  : phaseKey === 'EXECUTION' ? (changeStepInfo(stepKey, g.changes, pid) || raidStepInfo(stepKey, g.issues, g.risks, pid))
  : phaseKey === 'TESTING' ? testStepInfo(stepKey, g.tests, pid) : phaseKey === 'ACCEPTANCE' ? acceptanceStepInfo(stepKey, g.acceptances, g.tests, pid) : null;
export function reqStepInfo(stepKey, st, pid) {
  if (!st) return null;
  const go = (qs, label = '요구사항 관리') => ({ label, href: FEATURE_ROUTES.requirements(pid, qs) });
  switch (stepKey) {
    case 'COLLECT': return st.total === 0
      ? { text: '아직 등록된 요구사항이 없습니다.', ok: false, cta: go('?new=1', '요구사항 추가') }
      : { text: `현재 ${st.total}건의 요구사항이 등록되어 있습니다.`, ok: true, cta: go('') };
    case 'CLASSIFY': return st.total === 0 ? { text: '먼저 요구사항을 등록하세요.', ok: false, cta: go('?new=1', '요구사항 추가') }
      : st.type_unspecified ? { text: `${st.total}건 중 ${st.type_unspecified}건의 요구사항 유형이 아직 지정되지 않았습니다.`, ok: false, cta: go('?type=UNSPECIFIED') }
      : { text: '모든 요구사항이 분류되었습니다.', ok: true, cta: go('') };
    case 'PRIORITIZE': return st.total === 0 ? { text: '먼저 요구사항을 등록하세요.', ok: false, cta: go('?new=1', '요구사항 추가') }
      : st.priority_unspecified ? { text: `${st.priority_unspecified}건의 요구사항 우선순위가 아직 지정되지 않았습니다.`, ok: false, cta: go('?priority=UNSPECIFIED') }
      : { text: '모든 요구사항의 우선순위가 지정되었습니다.', ok: true, cta: go('') };
    case 'SCOPE_CHECK': return st.total === 0 ? { text: '먼저 요구사항을 등록하세요.', ok: false, cta: go('?new=1', '요구사항 추가') }
      : st.scope_undecided ? { text: `${st.scope_undecided}건의 요구사항 범위가 아직 결정되지 않았습니다.`, ok: false, cta: go('?scope=UNDECIDED') }
      : { text: '모든 요구사항의 범위가 결정되었습니다.', ok: true, cta: go('') };
    case 'CONFIRM': {
      const trace = st.confirmed_unlinked ? { text: `확정된 범위 내 요구사항 중 ${st.confirmed_unlinked}건이 아직 WBS와 연결되지 않았습니다.`, cta: go('?scope=IN_SCOPE&status=CONFIRMED&link=unlinked', '미연결 요구사항 보기') } : null;
      return st.in_scope === 0 ? { text: '범위 내 요구사항이 아직 없습니다.', ok: false, cta: go('?scope=UNDECIDED') }
      : st.in_scope_confirmed < st.in_scope ? { text: `범위 내 요구사항 ${st.in_scope}건 중 ${st.in_scope_confirmed}건이 확정되었습니다.`, ok: false, cta: go('?scope=IN_SCOPE&status=DRAFT,REVIEWING,ON_HOLD,REJECTED'), trace }
      : { text: '범위 내 요구사항이 모두 확정되었습니다.', ok: true, cta: go(''), trace };
    }
    default: return null;
  }
}
export function testStepInfo(stepKey, ts, pid) {
  if (!ts) return null;
  const go = (qs, label = 'Tests에서 확인') => ({ label, href: FEATURE_ROUTES.tests(pid, qs) });
  const none = { text: '아직 등록된 테스트가 없습니다.', ok: false, cta: go('?new=1', '첫 테스트 추가') };
  switch (stepKey) {
    case 'SCOPE': return ts.in_scope === 0 ? { text: '범위 내 요구사항이 아직 없습니다. 요구사항의 범위를 먼저 정리하세요.', ok: false, cta: { label: '요구사항 관리', href: FEATURE_ROUTES.requirements(pid, '?scope=UNDECIDED') } }
      : ts.total === 0 ? { text: `범위 내 요구사항 ${ts.in_scope}건이 테스트 대상입니다. 아직 등록된 테스트가 없습니다.`, ok: false, cta: go('?tab=coverage', 'Coverage 보기') }
      : { text: `범위 내 요구사항 ${ts.in_scope}건 중 ${ts.in_scope_tested}건에 테스트가 연결되어 있습니다. (Coverage ${ts.coverage}%)`, ok: ts.in_scope_untested === 0, cta: go('?tab=coverage', 'Coverage 보기') };
    case 'CASES': return ts.total === 0 ? none : ts.in_scope_untested
      ? { text: `테스트 ${ts.total}건이 등록되어 있습니다. 요구사항 ${ts.in_scope_untested}건에는 아직 연결된 테스트가 없습니다.`, ok: false, cta: go('?tab=coverage', '미연결 요구사항 보기') }
      : { text: `테스트 ${ts.total}건이 등록되어 있고 범위 내 요구사항이 모두 테스트와 연결되었습니다.`, ok: true, cta: go('') };
    case 'RUN': return ts.total === 0 ? none : ts.executed < ts.total
      ? { text: `테스트 ${ts.total}건 중 ${ts.executed}건이 실행되었습니다. ${ts.total - ts.executed}건은 아직 실행 전입니다.`, ok: false, cta: go('?last_result=NOT_RUN', '미실행 테스트 보기') }
      : { text: `테스트 ${ts.total}건이 모두 실행되었습니다. (Pass ${ts.last_pass} · Fail ${ts.last_fail} · Blocked ${ts.last_blocked})`, ok: true, cta: go('') };
    case 'DEFECTS': return ts.executed === 0 ? { text: '먼저 테스트를 실행하세요.', ok: false, cta: go('') } : ts.last_fail
      ? { text: `최근 결과가 Fail인 테스트 ${ts.last_fail}건이 있습니다. ${ts.fail_issues_open ? `이 중 Issue로 등록되어 처리 중인 건: ${ts.fail_issues_open}건.` : 'Issue로 등록해 조치 담당자를 정하세요.'}`, ok: false, cta: go('?last_result=FAIL', 'Fail 테스트 보기') }
      : { text: '최근 결과가 Fail인 테스트가 없습니다.', ok: true, cta: go('') };
    case 'FIXES': return ts.last_fail || ts.fail_issues_open
      ? { text: `${ts.last_fail ? `Fail 테스트 ${ts.last_fail}건` : ''}${ts.last_fail && ts.fail_issues_open ? ' · ' : ''}${ts.fail_issues_open ? `처리 중인 테스트 Issue ${ts.fail_issues_open}건` : ''}이 남아 있습니다. 조치 후 다시 실행해 Pass로 바꾸세요.`, ok: false, cta: ts.fail_issues_open ? { label: 'Issue 보기', href: FEATURE_ROUTES.raid(pid, '?status=OPEN,IN_PROGRESS,BLOCKED') } : go('?last_result=FAIL') }
      : ts.executed ? { text: '조치가 필요한 Fail 테스트나 처리 중인 테스트 Issue가 없습니다.', ok: true, cta: go('') } : { text: '먼저 테스트를 실행하세요.', ok: false, cta: go('') };
    default: return null;
  }
}
export function acceptanceStepInfo(stepKey, ac, ts, pid) {
  if (!ac) return null;
  const go = (qs, label = 'Acceptance 확인') => ({ label, href: FEATURE_ROUTES.tests(pid, `?tab=acceptance${qs ? '&' + qs.replace(/^\?/, '') : ''}`) });
  const none = { text: '아직 등록된 검수가 없습니다.', ok: false, cta: go('?new=1', '첫 검수 만들기') };
  switch (stepKey) {
    case 'SCOPE': return ac.total === 0 ? none : ac.target_requirements || ac.accepted
      ? { text: `검수 ${ac.total}건이 등록되어 있습니다.${ac.target_requirements ? ` 진행 중인 검수의 대상 요구사항은 ${ac.target_requirements}건입니다.` : ''}`, ok: true, cta: go('') }
      : { text: `검수 ${ac.total}건에 아직 대상 요구사항이 연결되지 않았습니다.`, ok: false, cta: go('') };
    case 'RUN': return ac.total === 0 ? none : ac.draft && !ac.requested && !ac.accepted
      ? { text: `작성 중인 검수 ${ac.draft}건이 있습니다. 준비가 되면 고객에게 검수를 요청하세요.`, ok: false, cta: go('?status=DRAFT', '작성 중 검수 보기') }
      : { text: `검수 요청 ${ac.requested}건 · 승인 ${ac.accepted}건${ac.target_fail_tests ? ` · 진행 중 검수의 Fail 테스트 ${ac.target_fail_tests}건` : ''}`, ok: ac.requested + ac.accepted > 0, cta: go(ac.requested ? '?status=REQUESTED' : '') };
    case 'OPEN_ITEMS': return ac.rework || ac.rejected || ac.target_fail_tests
      ? { text: `${ac.rework ? `보완 필요 ${ac.rework}건` : ''}${ac.rework && ac.rejected ? ' · ' : ''}${ac.rejected ? `반려 ${ac.rejected}건` : ''}${(ac.rework || ac.rejected) && ac.target_fail_tests ? ' · ' : ''}${ac.target_fail_tests ? `Fail 테스트 ${ac.target_fail_tests}건` : ''}이 미완료 항목입니다.`, ok: false, cta: go(ac.rework ? '?status=REWORK_REQUIRED' : ac.rejected ? '?status=REJECTED' : '') }
      : ac.total ? { text: '검수에서 지적된 미완료 항목이 없습니다.', ok: true, cta: go('') } : none;
    case 'FIXES': return ac.rework
      ? { text: `보완 요청된 검수 ${ac.rework}건이 있습니다. 보완 후 재요청하세요.`, ok: false, cta: go('?status=REWORK_REQUIRED', '보완 필요 검수 보기') }
      : ac.total ? { text: '보완 처리 대기 중인 검수가 없습니다.', ok: true, cta: go('') } : none;
    case 'SIGN_OFF': return ac.total === 0 ? none : ac.accepted && !ac.in_progress && !ac.draft
      ? { text: `검수 ${ac.accepted}건이 모두 승인되었습니다.`, ok: true, cta: go('?status=ACCEPTED') }
      : { text: `승인 ${ac.accepted}건 · 진행 중 ${ac.in_progress}건${ac.draft ? ` · 작성 중 ${ac.draft}건` : ''}. 모든 검수가 승인되면 검수 결과를 확정하세요.`, ok: false, cta: go('') };
    default: return null;
  }
}

export const phaseStrip = (g, pid) => html`<nav class="flow" aria-label="프로젝트 진행 단계">${raw(g.phases.map((ph) => {
  const cls = ph.is_current ? 'is-current' : ph.status === 'COMPLETED' ? 'is-done' : ph.status === 'IN_PROGRESS' ? 'is-open' : '';
  return html`<a class="flow__item ${cls}" href="/app/projects/${pid}/phases/${ph.phase_key}" data-link title="${ph.name} · ${ph.progress.done}/${ph.progress.total}">
    <i>${ph.status === 'COMPLETED' ? '✓' : ph.sequence}</i><span>${ph.name}</span></a>`;
}).join(''))}</nav>`;

/** Project Workspace header: one 44px row (menu · name · status · phase stepper · progress · creator · KPIs · actions) + one tab row. */
const NAV_TABS = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'phase', label: '프로세스', path: null },
  { key: 'requirements', label: 'Requirements', path: '/requirements' },
  { key: 'wbs', label: 'WBS', path: '/wbs' },
  { key: 'changes', label: 'Changes', path: '/changes' },
  { key: 'raid', label: 'Issues & Risks', path: '/issues' },
  { key: 'tests', label: 'Tests & Acceptance', path: '/tests' },
];
const navBadge = (key, g) => {
  switch (key) {
    case 'requirements': return g.requirements && g.requirements.total ? { n: g.requirements.total } : null;
    case 'wbs': return g.wbs && g.wbs.total ? { n: g.wbs.total } : null;
    case 'changes': return g.changes && (g.changes.under_review || g.changes.approved_unimplemented) ? { n: g.changes.under_review + g.changes.approved_unimplemented, warn: true } : null;
    case 'raid': { const n = (g.issues ? g.issues.active : 0) + (g.risks ? g.risks.high_or_critical : 0); return n ? { n, crit: Boolean((g.issues && g.issues.critical) || (g.risks && g.risks.critical)) } : null; }
    case 'tests': return g.tests && g.tests.last_fail ? { n: g.tests.last_fail, crit: true } : g.acceptances && g.acceptances.in_progress ? { n: g.acceptances.in_progress } : null;
    default: return null;
  }
};
const pv = (v) => (v === null || v === undefined ? '-' : v + '%');
/** Project Workspace header (sticky). `tab` = overview | phase | requirements | wbs | changes | raid | tests. crumb args are accepted for old call sites. */
export const projectHead = (p, g, { tab = 'overview' } = {}) => {
  wireProjectActions();
  wireAssistant(); queueMicrotask(() => revealAskButton(p.id));   // CTA appears only when /ai/status says AI is on
  const k = g.kpis || { guided_progress: g.progress, wbs_progress: g.wbs ? g.wbs.progress : 0, requirement_coverage: null, test_coverage: null };
  const cur = g.current_phase;
  const prog = k.guided_progress ?? g.progress ?? 0;
  const phaseHref = cur ? `/app/projects/${p.id}/phases/${cur.phase_key}` : `/app/projects/${p.id}`;
  return html`<header class="wsh">
    <div class="wsh__row">
      <button type="button" class="wsh__menu" data-ws-menu aria-label="전체 메뉴 열기" title="전체 메뉴 (Projects · Settings)">☰</button>
      <a class="wsh__back" href="/app/projects" data-link>프로젝트</a><span class="wsh__sep">/</span>
      <a class="wsh__name" href="/app/projects/${p.id}" data-link title="${p.name}">${p.name}</a>
      <span class="chip ${STATUS_CHIP[p.status] || ''}">${STATUS[p.status]}</span>
      ${raw(cur ? html`<a class="wsh__phase" href="${phaseHref}" data-link title="현재 단계">${no2(cur.sequence)} ${cur.name}</a>` : '')}
      <span class="wsh__steps" aria-label="단계 진행">${raw((g.phases || []).map((ph) => html`<a class="ps ${ph.is_current ? 'is-cur' : ph.status === 'COMPLETED' ? 'is-done' : ph.status === 'IN_PROGRESS' ? 'is-open' : ''}" href="/app/projects/${p.id}/phases/${ph.phase_key}" data-link title="${no2(ph.sequence)} ${ph.name} · ${ph.progress.done}/${ph.progress.total}"></a>`).join(''))}</span>
      <span class="wsh__prog" title="Guided 진행률"><span class="pbar"><i style="width:${prog}%"></i></span><b>${prog}%</b></span>
      <span class="wsh__owner" data-owner-id="${p.created_by || ''}" title="프로젝트 등록자"></span>
      <span class="wsh__sp"></span>
      <a class="wsh__kpi" href="/app/projects/${p.id}" data-link title="Overview에서 자세히 보기"><span>WBS <b>${pv(k.wbs_progress)}</b></span><span>Req.Cov <b>${pv(k.requirement_coverage)}</b></span><span>Test.Cov <b>${pv(k.test_coverage)}</b></span></a>
      <button type="button" class="btn btn--secondary btn--sm wsh__ask" data-ai-ask="${p.id}" hidden title="프로젝트 데이터를 근거로 답하는 읽기 전용 AI 보조">RELAI에게 물어보기</button>
      ${raw(headerActions(p))}
    </div>
    <nav class="wsh__tabs" aria-label="프로젝트 메뉴">${raw(NAV_TABS.map((it) => {
      const b = navBadge(it.key, g);
      const href = it.key === 'phase' ? phaseHref : `/app/projects/${p.id}${it.path}`;
      return html`<a class="${tab === it.key ? 'is-active' : ''}" href="${href}" data-link data-tab="${it.key}">${it.label}${raw(b ? html`<em class="${b.crit ? 'is-crit' : b.warn ? 'is-warn' : ''}">${b.n}</em>` : '')}</a>`;
    }).join(''))}</nav></header>`;
};

/** Dialogs for changing the current phase. Resolves true when the transition went through. */
export async function moveToPhase(pid, g, target, { next = false } = {}) {
  const cur = g.current_phase;
  const open = cur ? cur.steps.filter((s) => s.status !== 'COMPLETED') : [];
  let ok;
  if (next && !open.length) {
    ok = await confirmDialog({ title: `${cur.name} 단계를 완료했습니다.`, body: `다음 단계인 ${target.name}(으)로 이동하시겠습니까?`, confirm: '다음 단계로 이동' });
  } else if (next) {
    ok = await confirmDialog({ title: '아직 완료되지 않은 항목이 있습니다.',
      body: raw(html`<ul class="dlist">${raw(open.map((s) => html`<li>${s.title}</li>`).join(''))}</ul>완료하지 않고 다음 단계로 이동할 수 있지만, 프로젝트 진행 중 다시 확인하는 것을 권장합니다.`),
      confirm: '계속 진행' });
  } else {
    ok = await confirmDialog({ title: `${target.name} 단계를 현재 단계로 변경할까요?`,
      body: `현재 단계가 ${cur ? cur.name : '-'}에서 ${target.name}(으)로 바뀝니다. 각 단계의 할 일과 메모는 그대로 유지됩니다.`, confirm: '현재 단계로 변경' });
  }
  if (!ok) return false;
  try { await api('POST', wsApi(`/${pid}/phases/${target.id}/activate`), { reason: next ? 'NEXT' : 'MANUAL' }); toast(`현재 단계가 ${target.name}(으)로 변경되었습니다.`); return true; }
  catch (e) { toast(e.message); return false; }
}
