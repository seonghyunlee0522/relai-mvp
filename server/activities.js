/**
 * Lifecycle Activities (V2) — derived state for every activity of every phase.
 *
 * The stored project_steps.status only records a manual mark (COMPLETED / SKIPPED). The *live* state comes from the
 * project's own data (requirements, WBS, tests, acceptances, issues, changes, definition), so What's Next reads the real
 * project instead of a checkbox list:
 *
 *   NOT_STARTED  nothing recorded for this activity yet
 *   IN_PROGRESS  data exists but the completion criterion is not met
 *   COMPLETED    criterion met by data, or marked complete by hand
 *   SKIPPED      marked 제외 by hand
 *
 * Each activity also gets one contextual CTA ("요구사항 입력 시작 →") that leads straight to the work screen — no
 * intermediate phase/activity pages. Pure function; every rule is explainable and unit-testable.
 *
 *   activityStates(phaseKey, steps, ctx) → [{ ...step, state, derived, text, cta, crit }]
 *   ctx = { pid, stats, definition: { sections }, overdue_tasks, checklists: { [step_id]: { total, done } } }
 */
import { IMPORTANCE_LABEL, CHECKLIST_STEP_KEYS } from './templates/default-phases.js';
import { LEGACY_RESET_NOTE } from './migrations.js';

const n = (v) => Number(v) || 0;

/** derived result helpers: ok = criterion met · prog = data exists · none = nothing yet */
const ok = (text, cta, extra = {}) => ({ derived: 'COMPLETED', text, cta, ...extra });
const prog = (text, cta, extra = {}) => ({ derived: 'IN_PROGRESS', text, cta, ...extra });
const none = (text, cta, extra = {}) => ({ derived: 'NOT_STARTED', text, cta, ...extra });
/** manual = no data signal; state comes only from the stored mark (note counts as "in progress"). */
const manual = (text, cta = null) => ({ derived: null, text, cta });

const act = (label, href) => ({ label, href });
/** 06/07 checklist screen for one activity (public/app/project/checklist.js). */
const cl = (ctx, key, label = '체크리스트 작성 →') => act(label, `/app/projects/${ctx.pid}/checklist?activity=${key}`);

export const REAPPROVAL_TEXT = '승인 후 목표·범위·일정이 바뀌었습니다. 바뀐 내용을 고객에게 다시 확인받으세요.';

/* ---------- per-phase rules ---------- */
function initiation(key, ctx) {
  const u = `/app/projects/${ctx.pid}/definition?activity=${key}`;
  const sec = ctx.definition && ctx.definition.sections ? ctx.definition.sections.find((x) => x.key === key) : null;
  const go = (label) => act(label, u);
  if (!sec) return none('프로젝트 정의에서 작성합니다.', go('입력하기 →'));
  if (sec.status === 'SKIPPED') return { derived: 'SKIPPED', text: '이번 프로젝트에서는 수행하지 않음', cta: null };
  if (sec.status === 'COMPLETED' && sec.reapproval) return prog(REAPPROVAL_TEXT, go('다시 승인받기 →'), { crit: true, reopen: true });   // red 확인 필요 (spec US-2)
  if (sec.status === 'COMPLETED' && sec.changed_after_completion) return prog(`${sec.summary || '작성됨'} · 완료 후 수정되어 다시 확인이 필요합니다.`, go('다시 확인 →'));
  if (sec.status === 'COMPLETED') return ok(sec.summary || '작성 완료', null);
  if (sec.has_data || sec.ready) return prog(sec.summary || '작성 중', go('계속 작성 →'));
  return none('아직 작성되지 않았습니다.', go('입력하기 →'));
}

function requirements(key, ctx) {
  const r = ctx.stats.requirements || {};
  const u = (qs = '') => `/app/projects/${ctx.pid}/requirements${qs}`;
  const empty = none('아직 등록된 요구사항이 없습니다.', act('요구사항 입력 시작 →', u('?new=1')));
  const dep = none('먼저 요구사항을 등록하세요.', null);   // prerequisite unmet: the first activity already carries the CTA
  switch (key) {
    case 'COLLECT': return n(r.total) === 0 ? empty : ok(`요구사항 ${r.total}건이 등록되어 있습니다.`, act('요구사항 추가 →', u('?new=1')), { hint: COLLECT_HINT });
    case 'CLASSIFY': return n(r.total) === 0 ? dep
      : n(r.type_unspecified) ? prog(`${r.total}건 중 ${r.type_unspecified}건의 유형이 지정되지 않았습니다.`, act('요구사항 분류 →', u('?type=UNSPECIFIED')))
      : ok('모든 요구사항에 유형이 지정되었습니다.', act('요구사항 보기 →', u()));
    case 'PRIORITIZE': return n(r.total) === 0 ? dep
      : n(r.priority_unspecified) ? prog(`${r.priority_unspecified}건의 우선순위가 지정되지 않았습니다.`, act('우선순위 설정 →', u('?priority=UNSPECIFIED')))
      : ok('모든 요구사항에 우선순위가 지정되었습니다.', act('요구사항 보기 →', u()));
    case 'SCOPE_CHECK': return n(r.total) === 0 ? dep
      : n(r.scope_undecided) ? prog(`${r.scope_undecided}건의 범위가 결정되지 않았습니다.`, act('범위 결정 →', u('?scope=UNDECIDED')))
      : ok(`범위 내 ${n(r.in_scope)}건 · 범위 외 ${n(r.out_of_scope)}건으로 정리되었습니다.`, act('요구사항 보기 →', u()));
    case 'CONFIRM': {
      if (n(r.total) === 0) return dep;
      if (n(r.in_scope) === 0) return none('범위 내 요구사항이 아직 없습니다.', act('범위 결정 →', u('?scope=UNDECIDED')));
      // Phase 2 US-4(7): no separate bulk-confirm — 승인 기록 confirms the rest in the same save (BASELINE_APPROVAL Drawer)
      if (n(r.in_scope_confirmed) < n(r.in_scope)) return prog(`범위 내 ${r.in_scope}건 중 ${r.in_scope_confirmed}건이 확정되었습니다.`, act('승인 기록하기', u('?approval=1')));
      return ok('범위 내 요구사항이 모두 확정되었습니다.', act('확정 요구사항 보기 →', u('?scope=IN_SCOPE&status=CONFIRMED')));
    }
    case 'BASELINE_APPROVAL': {   // 요구사항 기준선 승인 (Phase 2 US-1): completes only from the Drawer (승인 기록), never by hand on What's Next
      const b = ctx.definition && ctx.definition.req_baseline; const go = act('승인 기록하기', u('?approval=1'));
      if (n(r.total) === 0) return dep;
      if (b && b.status === 'COMPLETED') return ok(b.summary || '고객 승인이 기록되었습니다.', null);
      if (b && b.bypass) return prog('승인 전 진행 · 사유 있음', go);
      if (b && b.summary) return prog(`작성 중 · ${b.summary}`, go);
      return none('확정한 요구사항을 고객에게 보내 승인받고 기록합니다.', go);
    }
    case 'INTERFACE': return n(r.total) === 0 ? dep
      : n(r.non_functional) ? ok(`인터페이스·데이터·보안 유형 요구사항 ${r.non_functional}건이 정리되어 있습니다.`, act('비기능 요구사항 보기 →', u('?type=INTERFACE,DATA,SECURITY')))
      : none('인터페이스·데이터·보안 유형의 요구사항이 아직 없습니다. 해당 사항이 없으면 제외할 수 있습니다.', act('요구사항 추가 →', u('?new=1')));
    default: return manual('');
  }
}

function analysisDesign(key, ctx) {
  const w = ctx.stats.wbs || {}; const r = ctx.stats.requirements || {};
  const u = (qs = '') => `/app/projects/${ctx.pid}/wbs${qs}`;
  const empty = n(w.tasks) === 0 && n(w.total) === 0 ? none('아직 등록된 WBS가 없습니다. 기본 작업 목록(WBS 뼈대)으로 시작할 수 있습니다.', act('WBS 뼈대 만들기', u('?skeleton=1'))) : none('아직 등록된 WBS가 없습니다.', act('WBS 작성 시작 →', u('?new=1')));
  const dep = none('먼저 WBS를 작성하세요.', null);
  switch (key) {
    case 'WBS_BUILD': return n(w.tasks) === 0 ? empty : ok(`실행 작업 ${w.tasks}건이 등록되어 있습니다.`, act('WBS 보기 →', u()));
    case 'REQ_TRACE': {
      if (n(w.tasks) === 0) return dep;
      if (n(r.in_scope) === 0) return none('범위 내 요구사항이 없어 연결할 대상이 없습니다.', act('요구사항 보기 →', `/app/projects/${ctx.pid}/requirements`));
      if (n(r.in_scope_unlinked)) return prog(`범위 내 요구사항 ${r.in_scope}건 중 ${r.in_scope_unlinked}건이 WBS와 연결되지 않았습니다.`, act('요구사항 연결 →', `/app/projects/${ctx.pid}/requirements?view=trace&scope=IN_SCOPE&status=DRAFT,REVIEWING,CONFIRMED,ON_HOLD&link=unlinked`));
      return ok(`범위 내 요구사항 ${r.in_scope}건이 모두 WBS와 연결되었습니다.`, act('Trace 보기 →', `/app/projects/${ctx.pid}/requirements?view=trace`), { trace: n(w.tasks_unlinked) ? `${w.tasks_unlinked_scope === 'DEVELOPMENT' ? '구현 작업 중 ' : ''}요구사항과 연결되지 않은 작업 ${w.tasks_unlinked}건` : null });   // US-5: only 구현 tasks once tasks are tagged
    }
    case 'ASSIGN': return n(w.tasks) === 0 ? dep
      : n(w.tasks_without_owner) ? prog(`${w.tasks}건 중 ${w.tasks_without_owner}건에 담당자가 없습니다.`, act('담당자 지정 →', u('?f=no_owner&select=owner')))
      : ok('모든 작업에 담당자가 지정되었습니다.', act('WBS 보기 →', u()));
    case 'PLAN': return n(w.tasks) === 0 ? dep
      : n(w.tasks_without_dates) ? prog(`${w.tasks_without_dates}건의 작업에 일정이 없습니다.`, act('일정 입력 →', u('?f=no_dates')))
      : ok('모든 작업에 계획 일정이 입력되었습니다.', act('Gantt 보기 →', u('?view=gantt')));
    case 'ORDER': return n(w.tasks) === 0 ? dep
      : n(w.dependencies) ? ok(`선후관계 ${w.dependencies}건이 설정되어 있습니다.`, act('WBS 보기 →', u()))
      : none('아직 작업 간 선후관계가 없습니다.', act('선후관계 설정 →', u()));
    case 'MILESTONES': {
      if (n(w.milestones)) return ok(`마일스톤 ${w.milestones}건이 등록되어 있습니다.`, act('Gantt 보기 →', u('?view=gantt')));
      // US-4: the 01 주요 일정 not yet in the WBS are offered once, inline (What's Next row + the WBS screen) — one click imports them
      const kd = ctx.key_dates_pending || [];
      if (kd.length) return none(`착수 때 정한 주요 일정 ${kd.length}건(${kd.slice(0, 3).map((k) => k.title).join('·')}${kd.length > 3 ? '…' : ''})을 마일스톤으로 가져올까요?`, act('마일스톤 등록 →', u('?new=1&type=MILESTONE')), { import_ms: kd.length });
      return none('아직 등록된 마일스톤이 없습니다.', act('마일스톤 등록 →', u('?new=1&type=MILESTONE')));
    }
    case 'NON_DEV_TASKS': {
      const bp = w.by_phase || {}; const nondev = n(bp.TESTING) + n(bp.TRANSITION_GO_LIVE) + n(bp.OPERATIONS);
      if (n(w.tasks) === 0) return dep;
      return nondev ? ok(`시험·전환·운영 단계 작업 ${nondev}건이 WBS에 포함되어 있습니다.`, act('WBS 보기 →', u()))
        : none('작업의 Lifecycle 단계를 지정하면 기능 개발 외 작업(테스트·이관·교육·전환)이 빠졌는지 확인할 수 있습니다.', act('작업 추가 →', u('?new=1')));
    }
    default: return manual('');
  }
}

function development(key, ctx) {
  const w = ctx.stats.wbs || {}; let is = ctx.stats.issues || {}; const c = ctx.stats.changes || {};
  const u = (qs = '') => `/app/projects/${ctx.pid}/wbs${qs}`; const iu = (qs = '') => `/app/projects/${ctx.pid}/issues${qs}`;
  switch (key) {
    case 'PROGRESS': {
      if (n(w.tasks) === 0) return none('실행 작업이 없습니다. WBS를 먼저 작성하세요.', act('WBS 작성 시작 →', u('?new=1')));
      const dev = w.by_phase && n(w.by_phase.DEVELOPMENT) ? { total: n(w.by_phase.DEVELOPMENT), done: n(w.by_phase_completed && w.by_phase_completed.DEVELOPMENT) } : { total: n(w.tasks), done: n(w.tasks_completed) };
      if (dev.done >= dev.total) return ok(`구현 작업 ${dev.total}건이 모두 완료되었습니다.`, act('WBS 보기 →', u('?ctx=monitor')));
      if (n(w.in_progress) + dev.done === 0) return none(`구현 작업 ${dev.total}건이 아직 시작되지 않았습니다.`, act('진행 상태 갱신 →', u('?ctx=monitor')));
      return prog(`구현 작업 ${dev.total}건 중 ${dev.done}건 완료 · 진척률 ${n(w.progress)}%`, act('진행 상태 갱신 →', u('?ctx=monitor')));
    }
    case 'DELAYS': return n(w.tasks) === 0 ? none('실행 작업이 없습니다.', null)
      : n(ctx.overdue_tasks) ? prog(`종료 예정일이 지난 작업 ${ctx.overdue_tasks}건이 있습니다.`, act('지연 작업 확인 →', u('?f=overdue')), { crit: true })
      : ok('종료 예정일이 지난 미완료 작업이 없습니다.', act('WBS 보기 →', u('?ctx=monitor')));
    case 'ISSUES': {
      // Issues raised from a failed test belong to 05 결함 조치 (DEFECTS), not to 04 — a finished 04 stays ✓ while a test defect is open.
      if (n(is.test_total)) { const d = (k) => Math.max(0, n(is[k]) - n(is[`test_${k}`])); is = { ...is, total: d('total'), active: d('active'), critical: d('critical'), blocked: d('blocked') }; }
      // US-5: no issue at all → the manual 완료 처리 button (a project without problems must still be able to close this required activity)
      if (n(is.total) === 0) return { ...manual('아직 기록된 이슈가 없습니다. 문제가 없었다면 완료 처리하세요.', act('이슈 등록 →', iu('?new=1'))), row_text: true };
      if (n(is.active)) { const parts = [`열린 이슈 ${is.active}건`]; if (n(is.critical)) parts.push(`심각 ${is.critical}건`); if (n(is.blocked)) parts.push(`차단됨 ${is.blocked}건`);
        return prog(parts.join(' · '), act('이슈 처리 →', iu(n(is.critical) ? '?severity=CRITICAL' : n(is.blocked) ? '?status=BLOCKED' : '')), { crit: Boolean(n(is.critical) || n(is.blocked)) }); }
      return ok(n(is.carried) ? `이슈 ${is.total}건 중 ${n(is.total) - n(is.carried)}건 해결 · ${is.carried}건 운영 이관` : `이슈 ${is.total}건이 모두 해결되었습니다.`, act('이슈 보기 →', iu()));
    }
    case 'CHANGES': {
      const cu = (qs = '') => `/app/projects/${ctx.pid}/changes${qs}`;
      if (n(c.total) === 0) return none('아직 변경 요청이 없습니다. 추가·변경 요청이 들어오면 변경 요청으로 기록하세요.', act('변경 요청 등록 →', cu('?new=1')));
      const parts = []; if (n(c.under_review)) parts.push(`검토 중 ${c.under_review}건 · 고객 결정을 받아 기록하세요`); if (n(c.approved_unimplemented)) parts.push(`승인 후 미반영 ${c.approved_unimplemented}건`);
      return parts.length ? prog(parts.join(' · '), n(c.under_review) ? act('승인 기록하기', cu('?status=UNDER_REVIEW&approve=1')) : act('변경 요청 결정 →', cu('?status=APPROVED')), { row_text: Boolean(n(c.under_review)) })   // US-2: the approval Drawer
        : ok(`변경 요청 ${c.total}건이 모두 처리되었습니다.`, act('변경 요청 보기 →', cu()));
    }
    case 'WEEKLY_REPORT': return weeklyReport(ctx);
    case 'DECISIONS': return manual('결정일, 결정 내용, 결정자를 기록합니다. 1건 이상 기록하면 완료로 표시됩니다.', cl(ctx, 'DECISIONS', '의사결정 기록 →'));
    default: return manual('');
  }
}
/** 04 + 05 WEEKLY_REPORT (Phase 4 US-3, Phase 5 US-6): this week (Mon–Sun, Korea time), computed on every read — next week it is open again. */
function weeklyReport(ctx) {
  const wr = ctx.weekly_report || { state: 'NONE' }; const ru = `/app/projects/${ctx.pid}/reports`;
  if (wr.state === 'FINAL') return ok(`✓ 이번 주 보고 확정 · ${mdOf(wr.finalized_at)}`, null, { row_text: true });
  if (wr.state === 'DRAFT') return prog('초안 작성 중', act('이어서 작성', `${ru}/${wr.report_id}`), { row_action: true, row_text: true });
  return none('이번 주 주간보고를 만드세요', act('주간보고 만들기', `${ru}?new=week`), { row_action: true, row_text: true });
}
/** 06 ACCEPTANCE progress line (US-2). */
export const accScopeText = (a) => `범위 내 요구사항 ${n(a.scope_target)}건 중 ${n(a.scope_accepted)}건이 승인된 검수에 들어 있습니다`;
/** '10/20' from a YYYY-MM-DD date. */
const mdYmd = (d) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${Number(m[1])}/${Number(m[2])}` : ''; };
/** '10/14' (Korea time) from an ISO timestamp. */
const mdOf = (iso) => { if (!iso) return ''; const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' }).format(new Date(iso)); const [m, dd] = d.split('-'); return `${Number(m)}/${Number(dd)}`; };

/** 05 시험 (Phase 5): TEST_PLAN = 범위 내 확정 요구사항마다 테스트 또는 제외 사유 (US-1) · DEFECTS = 실패 0 AND 테스트에서 만든 열린 이슈 0 (US-2). */
export const testPlanProgressText = (t) => `범위 내 요구사항 ${n(t.target)}건 중 ${n(t.target_tested)}건에 테스트가 있습니다 (제외 ${n(t.excluded)}건)`;
export const defectIssuesText = (t) => `처리 중 결함 이슈 ${n(t.fail_issues_open)}건${(t.fail_issue_ids || []).length ? `(${t.fail_issue_ids.slice(0, 3).join(', ')}${t.fail_issue_ids.length > 3 ? '…' : ''})` : ''}`;
function testing(key, ctx) {
  const t = ctx.stats.tests || {};
  const u = (qs = '') => `/app/projects/${ctx.pid}/tests${qs}`;
  const empty = none('아직 등록된 테스트 케이스가 없습니다.', act('테스트 케이스 작성 →', u('?new=1')));
  const dep = none('먼저 테스트 케이스를 작성하세요.', null);
  switch (key) {
    case 'TEST_PLAN': {
      if (n(t.target) === 0) return none(n(t.in_scope) ? '범위 내 확정 요구사항이 아직 없습니다. 요구사항을 확정하면 테스트 대상이 됩니다.' : '범위 내 요구사항이 아직 없습니다.', act('요구사항 보기 →', `/app/projects/${ctx.pid}/requirements?scope=IN_SCOPE`));
      if (n(t.in_scope_untested)) return (n(t.target_tested) + n(t.excluded) ? prog : none)(testPlanProgressText(t), act('요구사항별 테스트 만들기', u('?tab=coverage&generate=1')), { row_text: true });
      return ok(`범위 내 요구사항 ${n(t.target)}건이 모두 테스트와 연결되었거나 제외 사유가 있습니다.${n(t.excluded) ? ` (제외 ${n(t.excluded)}건)` : ''}`, act('커버리지 보기', u('?tab=coverage')), { row_text: true });
    }
    case 'CASES': return n(t.total) === 0 ? empty : ok(`테스트 케이스 ${t.total}건이 등록되어 있습니다.`, act('테스트 케이스 추가 →', u('?new=1')));
    case 'RUN': return n(t.total) === 0 ? dep
      : n(t.executed) < n(t.total) ? (n(t.executed) ? prog(`${t.total}건 중 ${t.executed}건이 실행되었습니다.`, act('테스트 실행 →', u('?last_result=NOT_RUN'))) : none(`테스트 ${t.total}건이 아직 실행되지 않았습니다.`, act('테스트 실행 →', u('?last_result=NOT_RUN'))))
      : ok(`테스트 ${t.total}건이 모두 실행되었습니다. (통과 ${n(t.last_pass)} · 실패 ${n(t.last_fail)} · 막힘 ${n(t.last_blocked)})`, act('결과 보기 →', u()));
    case 'DEFECTS': {
      if (n(t.executed) === 0 && n(t.fail_issues_open) === 0) return none('먼저 테스트를 실행하세요.', null);
      if (n(t.last_fail) || n(t.fail_issues_open)) return prog(`실패 테스트 ${n(t.last_fail)}건 · ${defectIssuesText(t)}`,
        n(t.last_fail) ? act('결함 조치 →', u('?last_result=FAIL')) : act('결함 이슈 보기', `/app/projects/${ctx.pid}/issues?source=TEST`), { crit: true, row_text: true, row_action: !n(t.last_fail) });   // the open-issue case gets its own row button (결함 이슈 보기)
      return ok('최근 결과가 실패인 테스트가 없고, 테스트에서 등록한 이슈가 모두 해결되었습니다.', act('결과 보기 →', u()));
    }
    case 'WEEKLY_REPORT': return weeklyReport(ctx);
    case 'NON_FUNCTIONAL': return manual('성능·보안·마이그레이션 검증 결과를 테스트 케이스로 기록하거나 메모로 남깁니다.', act('테스트 케이스 추가 →', u('?new=1')));
    default: return manual('');
  }
}

function transition(key, ctx) {
  const a = ctx.stats.acceptances || {}; const is = ctx.stats.issues || {}; const t = ctx.stats.tests || {}; const c = ctx.stats.changes || {};
  const u = (qs = '') => `/app/projects/${ctx.pid}/tests?tab=acceptance${qs ? '&' + qs.replace(/^\?/, '') : ''}`;
  switch (key) {
    case 'ACCEPTANCE': {
      // Phase 6 US-2: 완료 = 범위 내 확정 요구사항이 모두 승인된 검수에 들어 있음 (1차·2차 검수는 합계). No such requirement → every 검수 approved (as before).
      const tgt = n(a.scope_target); const scope = tgt ? ` ${accScopeText(a)}.` : '';
      if (tgt && n(a.scope_accepted) >= tgt) return ok(`범위 내 요구사항 ${tgt}건이 모두 승인된 검수에 들어 있습니다.`, act('검수 결과 보기 →', u('?status=ACCEPTED')));
      if (n(a.total) === 0) return none('아직 검수 항목이 없습니다. 검수 대상 요구사항과 테스트를 묶어 검수를 요청하세요.', act('검수 항목 작성 →', u('?new=1')));
      if (n(a.rework)) return prog(`보완 필요 ${a.rework}건이 있습니다.${scope}`, act('보완 처리 →', u('?status=REWORK_REQUIRED')), { crit: true });
      if (n(a.requested)) return prog(`검수 요청 ${a.requested}건이 고객 확인을 기다립니다.${scope}`, act('검수 결과 기록 →', u('?status=REQUESTED')));
      if (n(a.draft)) return prog(`작성 중 검수 ${a.draft}건이 있습니다.${scope}`, act('검수 요청 →', u('?status=DRAFT')));
      if (tgt) return prog(`${accScopeText(a)}.`, act('검수 범위 보기', u('?new=1')), { row_text: true });
      if (n(a.rejected) && !n(a.accepted)) return prog(`반려된 검수 ${a.rejected}건이 있습니다.`, act('검수 보기 →', u('?status=REJECTED')));
      return ok(`검수 ${a.accepted}건이 모두 승인되었습니다.`, act('검수 결과 보기 →', u('?status=ACCEPTED')));
    }
    case 'WEEKLY_REPORT': return weeklyReport(ctx);   // Phase 6 US-5
    case 'GO_LIVE': {
      // Phase 6 US-3: 오픈 completes only through the 오픈 dialog (오픈일 + 남은 항목 처리 / 운영 이관); the stored record wins
      const gl = ctx.go_live;
      if (gl && gl.date) return ok(`오픈 ${mdYmd(gl.date)}${gl.carryovers.length ? ` · 운영 이관 ${gl.carryovers.length}건` : ''}`, null, { row_text: true });
      const open = [];
      if (n(is.active)) open.push(`열린 이슈 ${is.active}건`);
      if (n(t.last_fail)) open.push(`실패 테스트 ${t.last_fail}건`);
      if (n(a.requested) + n(a.rework)) open.push(`미완료 검수 ${n(a.requested) + n(a.rework)}건`);
      if (n(c.approved_unimplemented)) open.push(`미반영 변경 ${c.approved_unimplemented}건`);
      return open.length ? manual(`오픈 전에 정할 항목: ${open.join(' · ')} — 오픈할 때 처리하거나 운영 이관으로 넘깁니다.`, act(n(is.active) ? '열린 이슈 확인 →' : n(t.last_fail) ? '실패 테스트 확인' : '확인 →', n(is.active) ? `/app/projects/${ctx.pid}/issues` : n(t.last_fail) ? `/app/projects/${ctx.pid}/tests?last_result=FAIL` : `/app/projects/${ctx.pid}/overview`))
        : manual('오픈을 막는 미완료 항목이 없습니다. 오픈하면 완료 처리에서 오픈일을 기록하세요.', act('오픈 완료 처리', `/app/projects/${ctx.pid}?golive=1`));
    }
    case 'STABILIZE': return n(is.active) ? manual(`열린 이슈 ${is.active}건을 모니터링 중입니다.`, act('이슈 처리 →', `/app/projects/${ctx.pid}/issues`)) : manual('오픈 후 발생하는 문제를 이슈로 기록하고 처리합니다.', cl(ctx, key));
    case 'CUTOVER_PLAN': return manual('전환 순서, 일정, 담당, 롤백 기준을 체크리스트로 정리합니다.', cl(ctx, key));
    case 'DATA_MIGRATION': return manual(ctx.traits && ctx.traits.data_migration === 'YES' ? '이관 대상 분석, 매핑, 리허설, 본 이관과 검증을 수행합니다. 프로젝트 특성이 데이터 이관 있음이라 필수입니다.' : '이관 대상 분석, 매핑, 리허설, 본 이관과 검증을 수행합니다. 해당 사항이 없으면 제외할 수 있습니다.', cl(ctx, key));
    case 'TRAINING': return manual('사용자·운영자 교육과 매뉴얼 전달을 체크리스트로 관리합니다.', cl(ctx, key));
    default: return manual('');
  }
}

function operations(key, ctx) {
  const is = ctx.stats.issues || {};
  const fresh = n(is.active);   // Phase 7 US-4: issues handed over at 오픈 are already out of stats (home.js lessCarried)
  switch (key) {
    case 'HANDOVER': {   // Phase 7 US-3: 완료 = 인수자 · 인수일 (the HANDOVER dialog); the checklist alone never completes it
      const h = ctx.handover;
      if (h && h.date) return ok(`✓ 인수 · ${mdYmd(h.date)} · ${h.receiver_name}`, null, { row_text: true });
      return manual('운영 매뉴얼, 계정, 모니터링, 담당자를 운영 조직에 인수인계합니다.', act('인수 완료 처리', `/app/projects/${ctx.pid}?handover=1`));
    }
    case 'MAINTENANCE': return manual(fresh ? `오픈 뒤 열린 이슈 ${fresh}건이 남아 있습니다. 하자보수로 처리할지 확인하세요.` : '장애·요청 접수 경로와 처리 절차를 정합니다.', fresh ? act('이슈 보기 →', `/app/projects/${ctx.pid}/issues`) : cl(ctx, key));
    case 'SLA': return manual('운영 계약이 있으면 — 응답·복구 시간 등 서비스 수준 기준을 확인합니다. 해당 사항이 없으면 제외할 수 있습니다.', cl(ctx, key));
    case 'RELEASE_PLAN': return manual('운영 계약이 있으면 — 개선 요청을 모아 배포하는 주기와 절차를 정합니다. 해당 사항이 없으면 제외할 수 있습니다.', cl(ctx, key));
    case 'CLOSE': {   // Phase 7 US-1: 완료 = 완료보고서 확정 (or 완료 처리 + 사유 when it was written outside RELAI)
      const cr = ctx.completion_report || { state: 'NONE' }; const ru = `/app/projects/${ctx.pid}/reports`;
      if (cr.state === 'FINAL') return ok(`✓ 완료보고서 확정 · ${mdOf(cr.finalized_at)}`, act('완료보고서 보기', `${ru}/${cr.report_id}`), { row_text: true, manual_close: true });
      if (cr.state === 'DRAFT') return prog('완료보고서 초안 작성 중', act('이어서 작성', `${ru}/${cr.report_id}`), { row_action: true, row_text: true, manual_close: true });
      return none('결과·차이·남은 일·교훈을 완료보고서로 정리하세요', act('완료보고서 만들기', `${ru}?new=completion`), { row_action: true, row_text: true, manual_close: true });
    }
    default: return manual('');
  }
}

export const COLLECT_HINT = '계약서·제안요청서(RFP)·인터뷰 등 출처를 빠짐없이 확인했나요?';
/** 02 INTERFACE: shown as 권장 when 데이터 이관 / 외부 시스템 연계 is '있음' (display only — stored importance and the gate never change). */
export function interfaceEmphasis(traits) {
  const t = traits || {}; const parts = [];
  if (t.data_migration === 'YES') parts.push('데이터 이관'); if (t.has_external_integration === 'YES') parts.push('외부 연계');
  return parts.length ? `(프로젝트 특성: ${parts.join('·')} 있음)` : null;
}

/** Phase 6 US-4: 06 DATA_MIGRATION importance is computed from the project trait on every read (stored value untouched):
 * 데이터 이관 있음 → 필수 · 미정 → 권장 · 없음 → 선택. The REQUIRED gate (gate_met) and the 건너뛰기 check use the same value. */
const DM_IMPORTANCE = { YES: 'REQUIRED', TBD: 'RECOMMENDED', NO: 'OPTIONAL' };
export function effectiveImportance(phaseKey, stepKey, stored, traits) {
  if (phaseKey === 'TRANSITION_GO_LIVE' && stepKey === 'DATA_MIGRATION' && traits && DM_IMPORTANCE[traits.data_migration]) return DM_IMPORTANCE[traits.data_migration];
  return stored;
}

const RULES = { INITIATION: initiation, REQUIREMENTS: requirements, ANALYSIS_DESIGN: analysisDesign, DEVELOPMENT: development, TESTING: testing, TRANSITION_GO_LIVE: transition, OPERATIONS: operations };

/** Live state of one stored step: a manual mark wins; otherwise the derived state; a note on a manual activity means it is in progress. */
export function resolveState(step, derived) {
  if (step.status === 'COMPLETED') return 'COMPLETED';
  if (step.status === 'SKIPPED') return 'SKIPPED';
  if (derived) return derived;
  return step.note ? 'IN_PROGRESS' : 'NOT_STARTED';
}

/** A manual activity with checklist items derives from them: all done → 완료, otherwise → 진행 중. Data-driven activities are untouched. */
export function checklistDerived(r, list) {
  if (r.derived || !list || !list.total) return r;
  const tail = `체크리스트 ${list.done}/${list.total} 완료`;
  return { ...r, derived: list.done >= list.total ? 'COMPLETED' : 'IN_PROGRESS', text: r.text ? `${tail} · ${r.text}` : tail };
}

export function activityStates(phaseKey, steps, ctx) {
  const rule = RULES[phaseKey];
  return steps.map((s) => {
    const r0 = rule ? rule(s.step_key, ctx) : manual(s.completion_criteria);
    const hasList = CHECKLIST_STEP_KEYS.has(s.step_key);
    const list = hasList && ctx.checklists ? ctx.checklists[s.id] || { total: 0, done: 0 } : null;
    let r = hasList ? checklistDerived(r0, list) : r0;
    // 오픈 never completes from its checklist alone — only the 오픈 dialog records it (US-3)
    if (s.step_key === 'GO_LIVE' && phaseKey === 'TRANSITION_GO_LIVE' && r.derived === 'COMPLETED' && r0.derived === null) r = { ...r, derived: 'IN_PROGRESS', text: `${r.text} · 오픈 완료 처리가 남았습니다` };
    // Phase 7 US-3: 운영 인수 likewise — only the HANDOVER dialog (인수자 · 인수일) records it
    if (s.step_key === 'HANDOVER' && phaseKey === 'OPERATIONS' && r.derived === 'COMPLETED' && r0.derived === null) r = { ...r, derived: 'IN_PROGRESS', text: `${r.text} · 인수 완료 처리가 남았습니다` };
    const state = r.reopen ? 'IN_PROGRESS' : resolveState(s, r.derived);   // reopen: stored 완료 no longer holds (승인 후 변경 → 다시 승인 필요)
    let importance = effectiveImportance(phaseKey, s.step_key, s.importance || (s.is_required ? 'REQUIRED' : 'OPTIONAL'), ctx.traits); let description = s.description;
    // US-4: 이관 있음 → the in-scope DATA requirements as links at the end of the row
    const links = phaseKey === 'TRANSITION_GO_LIVE' && s.step_key === 'DATA_MIGRATION' && importance === 'REQUIRED' && Array.isArray(ctx.data_requirements)
      ? ctx.data_requirements.map((q) => ({ label: `${q.display_id} ${q.title}`, href: `/app/projects/${ctx.pid}/requirements?sel=${q.id}` })) : null;
    const emph = phaseKey === 'REQUIREMENTS' && s.step_key === 'INTERFACE' && importance === 'OPTIONAL' ? interfaceEmphasis(ctx.traits) : null;
    if (emph) { importance = 'RECOMMENDED'; description = `${description} ${emph}`; }
    return { ...s, description, importance, importance_label: IMPORTANCE_LABEL[importance],
      state, derived: r.derived, text: state === 'COMPLETED' && s.status === 'COMPLETED' && r.derived !== 'COMPLETED' ? (r.text ? `완료 처리됨 · ${r.text}` : '완료 처리됨') : (r.text || s.completion_criteria),
      hint: state === 'COMPLETED' && r.hint ? r.hint : null, import_ms: state === 'NOT_STARTED' && r.import_ms ? { count: r.import_ms, text: r.text } : null,
      cta: state === 'COMPLETED' || state === 'SKIPPED' ? null : r.cta || null, row_action: Boolean(r.row_action) && state !== 'COMPLETED' && state !== 'SKIPPED', row_text: Boolean(r.row_text), crit: Boolean(r.crit) && state !== 'COMPLETED' && state !== 'SKIPPED', trace: r.trace || null,
      // manual = no data signal decides this activity: What's Next offers 완료 처리 for it (checklist ones too — a hand mark wins)
      manual: r0.derived === null || Boolean(r0.manual_close), checklist: list, links: links && links.length ? links : null, go_live: s.step_key === 'GO_LIVE' && phaseKey === 'TRANSITION_GO_LIVE',
      handover: s.step_key === 'HANDOVER' && phaseKey === 'OPERATIONS', close: s.step_key === 'CLOSE' && phaseKey === 'OPERATIONS',
      reopen_note: state !== 'COMPLETED' && state !== 'SKIPPED' && (s.note || '').includes(LEGACY_RESET_NOTE) ? LEGACY_RESET_NOTE : null };   // Q17-3: why migration 39 reopened a legacy hand-✓ step
  });
}

/** Phase-level summary from resolved activities: REQUIRED completion is the gate; nothing is a percentage. */
export function activitySummary(acts) {
  const req = acts.filter((a) => a.importance === 'REQUIRED');
  const reqDone = req.filter((a) => a.state === 'COMPLETED' || a.state === 'SKIPPED');
  return { total: acts.length, completed: acts.filter((a) => a.state === 'COMPLETED').length, skipped: acts.filter((a) => a.state === 'SKIPPED').length,
    required_total: req.length, required_done: reqDone.length, required_open: req.length - reqDone.length, gate_met: req.length === reqDone.length };
}
