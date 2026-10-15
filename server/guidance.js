/**
 * RELAI Guide — "지금 가장 먼저 해야 할 일" for What's Next (Lifecycle V2).
 *
 * A deterministic, explainable rule ladder over data the app already computes (current phase, definition progress,
 * requirement / WBS / test / acceptance / issue stats). No workflow engine, no stored state, no AI: the same inputs
 * always give the same answer, and every answer says *why* and *what comes next*.
 *
 *   projectGuidance(ctx) → { current_phase, title, description, why, primary_action, secondary_action, warnings, next_preview, rule }
 *
 * CTA labels are task-centred ("요구사항 입력 시작 →"), never destination-centred ("Requirements로 이동"). An action whose
 * href ends in ?move=next is the phase transition; the client renders it as "NN 단계 시작 →".
 *
 * Copy rules for `description` (shown under the title on What's Next and the Home card): 1–2 sentences, keep the live
 * numbers (N건) first, then say *why this matters now* in PM terms — not a feature walkthrough, not marketing.
 * `why` stays a one-line rationale used by tests/reports; `title` is the imperative headline.
 */
import { DEFAULT_PHASES, PHASE_BY_KEY } from './templates/default-phases.js';
import { testPlanProgressText, defectIssuesText, accScopeText } from './activities.js';
import { josa } from '../public/app/shared/josa.js';

const n = (v) => Number(v) || 0;

/** One line per phase shown the first time a user enters it ("이 단계에서 하는 일"). */
export const PHASE_INTRO = Object.fromEntries(DEFAULT_PHASES.map((p) => [p.key, { what: p.description, outputs: p.steps.filter((s) => s.importance === 'REQUIRED').map((s) => s.title) }]));

/** "착수 때 제외하기로 한 것: A, B. 여기에 해당하는 요구사항은 '범위 외'로 두세요." (Charter 제외 범위; hidden when empty) */
export const scopeOutHint = (list) => (list && list.length ? `착수 때 제외하기로 한 것: ${list.join(', ')}. 여기에 해당하는 요구사항은 '범위 외'로 두세요.` : '');

/** Phase 5 C1 — 05 guide + 커버리지 탭 head (one text, one link: 요구사항 화면 미확정 필터). */
export const UNCONFIRMED_HREF = '/requirements?scope=IN_SCOPE&status=DRAFT,REVIEWING,ON_HOLD';   // K8: REJECTED is not 확정 대기
export const unconfirmedTestText = (k) => `확정되지 않은 범위 내 요구사항 ${k}건 — 확정하면 테스트 대상에 들어갑니다`;
/** 05 완료 가이드 제목 (US-1): real numbers, never "테스트가 모두 통과했습니다". */
export function testDoneTitle(t) {
  const total = n(t.total); const pass = n(t.last_pass);
  const tests = pass === total ? `테스트 ${total}건 모두 통과` : `테스트 ${total}건 중 ${pass}건 통과 · 막힘 ${n(t.last_blocked)}건`;
  return `요구사항 ${n(t.target)}건 검증 완료 · ${tests}${n(t.excluded) ? ` · 제외 ${n(t.excluded)}건` : ''}`;
}

/** 06: the GO_LIVE activity is recorded (오픈 완료). */
const goLiveDone = (phase) => Array.isArray(phase && phase.steps) && phase.steps.some((a) => a.step_key === 'GO_LIVE' && a.state === 'COMPLETED');

/** '2026-10-30' → '10/30'. */
const mdDate = (d) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${Number(m[1])}/${Number(m[2])}` : ''; };

export function projectGuidance(ctx) {
  const { project, phase, next_phase: nextPhase, definition, stats = {}, overdue_tasks = 0, go_live: goLive = null, completion_report: completion = null } = ctx;
  const u = (p = '') => `/app/projects/${project.id}${p}`;
  const req = stats.requirements || {}; const wbs = stats.wbs || {}; const tst = stats.tests || {}; const acc = stats.acceptances || {}; const iss = stats.issues || {}; const chg = stats.changes || {};
  const key = phase ? phase.phase_key || phase.key : project.current_phase;
  const warnings = []; const warningLinks = {};   // warning text → filter href (Phase 3: 03 완료 가이드 경고 목록)
  const warnLink = (text, href) => { warnings.push(text); warningLinks[text] = href; };
  const act = (label, href) => ({ label, href });
  const move = nextPhase ? act(`${nextPhase.name} 단계 시작 →`, u('?move=next')) : null;
  /** 06/07: the first open REQUIRED (then any) activity that carries a work-screen CTA — the checklist screen for manual ones. */
  const openActs = phase && Array.isArray(phase.steps) ? phase.steps.filter((a) => a.state !== 'COMPLETED' && a.state !== 'SKIPPED' && a.cta) : [];
  const nextAct = openActs.find((a) => a.importance === 'REQUIRED') || null;
  const actCta = nextAct ? act(nextAct.cta.label === '체크리스트 작성 →' ? `${nextAct.title} 체크리스트 →` : nextAct.cta.label, nextAct.cta.href) : null;
  const out = (rule, title, description, why, primary, secondary = null, next = null) => ({
    current_phase: { key, name: phase?.name || PHASE_BY_KEY[key]?.name || key, sequence: phase?.sequence || (DEFAULT_PHASES.findIndex((p) => p.key === key) + 1) },
    rule, title, description, why, primary_action: primary, secondary_action: secondary, warnings, warning_links: warningLinks, next_preview: next,
  });
  const nextPhaseText = nextPhase ? `다음 단계: ${nextPhase.name}` : null;

  // Phase 7 US-2: a closed project stops nudging — one quiet line + 완료보고서 보기 (the issue screens stay as they are)
  if (project.status === 'COMPLETED') {
    const wr = project.warranty_end_on ? ` · 하자보수 ${String(project.warranty_end_on).slice(0, 10).replace(/-/g, '/')}까지` : '';
    return out('CLOSED', '프로젝트가 종료되었습니다', `${mdDate(project.closed_on)} 종료${wr}. 기록은 그대로 남아 있고 필요하면 종료를 취소할 수 있습니다.`, '종료된 프로젝트는 할 일을 독촉하지 않습니다.',
      act('완료보고서 보기', completion && completion.report_id ? u(`/reports/${completion.report_id}`) : u('/reports')), null, null);
  }
  // Cross-phase warnings (guidance, never gates)
  if (n(req.total) && n(req.scope_undecided) && key !== 'REQUIREMENTS') warnLink(`범위가 결정되지 않은 요구사항 ${req.scope_undecided}건`, u('/requirements?scope=UNDECIDED'));   // Redesign R2 (Jim M2): opens the filtered list with the 범위 column shown
  if (n(req.in_scope) && n(req.in_scope_confirmed) < n(req.in_scope) && key !== 'INITIATION' && key !== 'REQUIREMENTS' && key !== 'TESTING') warnings.push(`미확정 요구사항 ${n(req.in_scope) - n(req.in_scope_confirmed)}건`);
  // Phase 5 C1: in 05 the unconfirmed in-scope requirements are named with what confirming does (never blocks)
  if (key === 'TESTING' && n(tst.in_scope_unconfirmed)) warnLink(unconfirmedTestText(tst.in_scope_unconfirmed), u(UNCONFIRMED_HREF));
  const critical = n(iss.critical);   // Phase 7 US-4/M2: stats already skip 운영 이관 issues (home.js lessCarried)
  if (critical > 0 && key !== 'DEVELOPMENT') warnings.push(`심각한 이슈 ${critical}건`);
  // Phase 6 US-7: in 06 the open issues stand next to the unapplied changes on one warn line (never blocks)
  if (key === 'TRANSITION_GO_LIVE') { const w = [n(iss.active) ? `열린 이슈 ${iss.active}건` : '', n(chg.approved_unimplemented) ? `승인 후 미반영 변경 ${chg.approved_unimplemented}건` : ''].filter(Boolean).join(' · '); if (w && !goLiveDone(phase)) warnings.push(w); }
  else if (n(chg.approved_unimplemented) > 0 && key !== 'DEVELOPMENT') warnings.push(`승인 후 미반영 변경 ${chg.approved_unimplemented}건`);   // CRs handed over at 오픈 are already out of stats

  switch (key) {
    case 'INITIATION': {
      const d = definition?.progress || { done: 0, total: 5 };
      const gate = definition?.initiation_gate || {}; const apv = gate.approval; const kick = gate.kickoff;
      const review = (definition?.needs_review || []).filter((k) => k !== 'APPROVAL');
      // K1: an approved definition that changed needs the customer's approval again — not a generic re-check
      if (review.length && apv && apv.status !== 'TODO') return out('INIT_REAPPROVE', '변경 내용을 고객에게 다시 승인받으세요', `승인 후 바뀐 항목 ${review.length}개가 있습니다. 바뀐 내용을 고객에게 다시 승인받으세요. 승인된 기준이 이후 요구사항·변경·검수의 판단 기준입니다.`, '승인 후 바뀐 기준은 다시 합의해야 이후 분쟁을 막을 수 있습니다.', act('승인 다시 기록 →', u('/definition?activity=APPROVAL')), act('프로젝트 정의 확인 →', u('/definition')), '다시 승인받으면 요구사항을 정리합니다.');
      if (review.length) return out('INIT_REVIEW', '수정된 정의 항목을 다시 확인하세요', `완료 후 내용이 바뀐 항목 ${review.length}개가 있습니다. 정의는 요구사항·일정·검수의 기준이므로 바뀐 내용을 다시 확인해야 이후 판단이 어긋나지 않습니다.`, '프로젝트 정의는 요구사항·일정의 기준이 되므로 변경 후 다시 확인해야 합니다.', act('프로젝트 정의 확인 →', u('/definition')), null, '정의가 확정되면 요구사항을 정리합니다.');
      // Jim P2-1: once every 필수 업무 is done the card is the gate (as in 03), not the optional 운영 방식
      if (d.done < d.total && !(phase && phase.summary && phase.summary.gate_met)) return out('INIT_DEFINE', d.done === 0 ? '프로젝트의 목표와 범위를 정의하세요' : `프로젝트 정의를 마저 완료하세요 (${d.done}/${d.total})`, '초기에 목표·성공 기준, 수행·제외 범위, 이해관계자, 주요 일정과 운영 방식을 확정해야 이후 단계에서 방향성이 흔들리지 않습니다.', '착수 단계에서 정한 기준이 이후 요구사항, 일정, 검수의 판단 기준이 됩니다.', act(d.done === 0 ? '프로젝트 정의 시작 →' : '프로젝트 정의 이어서 작성 →', u('/definition')), null, '정의가 완료되면 요구사항을 등록합니다.');
      // 착수 gate (Phase 1 v2): 정의 5개 → 착수보고회 → 승인. INIT_DONE only after 승인 (or a recorded 승인 전 진행 사유).
      const plan = act('사업수행계획서 내려받기', `/api/workspaces/${project.workspace_id}/projects/${project.id}/charter/export?format=pdf`);
      if (apv && apv.status === 'REAPPROVAL') return out('INIT_REAPPROVE', '변경 내용을 고객에게 다시 승인받으세요', '승인 후 목표·범위·일정이 바뀌었습니다. 바뀐 내용을 고객에게 다시 확인받으세요. 승인된 기준이 이후 요구사항·변경·검수의 판단 기준입니다.', '승인 후 바뀐 기준은 다시 합의해야 이후 분쟁을 막을 수 있습니다.', act('승인 다시 기록 →', u('/definition?activity=APPROVAL')), plan, '다시 승인받으면 요구사항을 정리합니다.');
      if (apv && apv.status === 'TODO' && !apv.bypass) {
        if (kick && kick.status === 'TODO') return out('INIT_KICKOFF', '착수보고회를 준비하고 진행하세요', '착수보고회는 고객과 수행팀이 같은 목표·범위·일정을 처음 공식적으로 확인하는 자리입니다. 순서: 사업수행계획서 초안을 내려받아 착수보고회 전에 고객에게 보내고 → 착수보고회에서 발표 → 승인을 받습니다.', '착수보고회에서 목표·범위·일정을 공식적으로 확인해야 이후 단계의 기준이 생깁니다.', act('착수보고회 준비 →', u('/definition?activity=KICKOFF')), plan, '착수보고회 후 착수 결과를 승인받습니다.');
        return out('INIT_APPROVE', '착수 결과를 고객에게 승인받으세요', '승인된 목표·범위가 이후 요구사항·변경·검수의 기준이 됩니다. 사업수행계획서를 보내고, 승인 회신을 받으면 기록하세요.', '고객이 승인한 착수 결과가 이후 요구사항·변경·검수의 기준이 됩니다.', act('승인 기록 →', u('/definition?activity=APPROVAL')), plan, '승인을 받으면 요구사항을 정리합니다.');
      }
      if (apv && apv.status === 'TODO' && apv.bypass) warnings.push('착수 결과 미승인 · 승인 전 진행 사유 기록됨');
      return out('INIT_DONE', '프로젝트 정의가 완료되었습니다', '출발 기준이 정리되었습니다. 요구사항을 초기에 명확히 정리하면 설계·개발 단계의 범위 변경과 재작업을 크게 줄일 수 있습니다.', '요구사항은 WBS, 테스트, 검수와 연결되는 프로젝트의 기준입니다.', move || act('요구사항 입력 시작 →', u('/requirements?new=1')), move ? act('요구사항 입력 시작 →', u('/requirements?new=1')) : null, nextPhaseText);
    }
    case 'REQUIREMENTS': {
      if (n(req.total) === 0) return out('REQ_EMPTY', '요구사항을 수집하고 정리하세요', '요구사항을 초기에 명확히 정리하면 설계·개발 단계의 범위 변경과 재작업을 크게 줄일 수 있습니다. 직접 입력, Excel 가져오기, AI 추출(사용 가능 시)을 Requirements 화면에서 선택할 수 있습니다.', '요구사항은 프로젝트 범위와 검수 기준이 되며 WBS·테스트와 연결됩니다.', act('요구사항 입력 시작 →', u('/requirements?new=1')), null, '요구사항이 준비되면 분류와 범위를 정리합니다.');
      if (n(req.type_unspecified)) return out('REQ_CLASSIFY', '요구사항을 분류하세요', `유형이 지정되지 않은 요구사항 ${req.type_unspecified}건이 있습니다. 기능·비기능·인터페이스·데이터 구분이 있어야 설계와 테스트 범위를 빠짐없이 잡을 수 있습니다.`, '기능·비기능·인터페이스·데이터 구분이 있어야 설계와 테스트 범위를 정할 수 있습니다.', act('요구사항 분류 →', u('/requirements?type=UNSPECIFIED')), n(req.priority_unspecified) ? act('우선순위 설정 →', u('/requirements?priority=UNSPECIFIED')) : null, '분류가 끝나면 범위를 확정합니다.');
      // Phase 2: 범위 확정 shows the Charter 제외 범위 (no auto matching); 확정 and 승인 both lead to the 승인 기록 Drawer
      const excl = (definition?.scope_out || []).length ? ` ${scopeOutHint(definition.scope_out)}` : '';
      const rb = definition?.req_baseline || null;
      const docLink = act('요구사항 정의서 내려받기', `/api/workspaces/${project.workspace_id}/projects/${project.id}/requirements/export-doc?format=pdf`);
      if (n(req.scope_undecided)) return out('REQ_SCOPE', '요구사항의 범위를 확정하세요', `범위가 결정되지 않은 요구사항 ${req.scope_undecided}건이 있습니다. 범위를 먼저 정해야 WBS와 테스트 범위를 흔들림 없이 세울 수 있습니다.${excl}`, '범위가 정해져야 실행 계획(WBS)과 테스트 범위를 정할 수 있습니다.', act('범위 결정 →', u('/requirements?scope=UNDECIDED')), n(req.priority_unspecified) ? act('우선순위 설정 →', u('/requirements?priority=UNSPECIFIED')) : null, '범위가 정해지면 요구사항을 확정합니다.');
      if (n(req.in_scope) && n(req.in_scope_confirmed) < n(req.in_scope)) return out('REQ_CONFIRM', '요구사항을 검토하고 확정하세요', `범위 내 요구사항 ${req.in_scope}건 중 ${req.in_scope_confirmed}건이 확정되었습니다. 요구사항 정의서를 고객에게 보내 검토받으세요. 승인 회신을 받으면 승인 기록에서 한 번에 확정됩니다.${n(req.priority_unspecified) ? ` 우선순위 미지정 ${req.priority_unspecified}건.` : ''}`, '확정된 요구사항이 기준선이 되어 이후 변경은 변경 요청으로 관리됩니다.', act('승인 기록하기', u('/requirements?approval=1')), docLink, '고객 승인을 기록하면 분석·설계 단계에서 WBS를 작성합니다.');
      if (n(req.priority_unspecified)) warnings.push(`우선순위 미지정 요구사항 ${req.priority_unspecified}건`);
      if (rb && rb.step_id && rb.status !== 'COMPLETED' && !rb.bypass) return out('REQ_APPROVE', '요구사항 기준선을 고객에게 승인받으세요', '고객이 승인한 요구사항이 설계·개발·테스트·검수의 기준(기준선)이 됩니다. 요구사항 정의서를 보내고, 승인 회신을 받으면 기록하세요.', '고객이 승인한 요구사항이 이후 설계·개발·검수의 기준선이 됩니다.', act('승인 기록하기', u('/requirements?approval=1')), docLink, '승인을 기록하면 분석·설계 단계에서 WBS를 작성합니다.');
      if (rb && rb.status !== 'COMPLETED' && rb.bypass) warnings.push('요구사항 기준선 미승인 · 승인 전 진행 사유 기록됨');
      return out('REQ_DONE', '요구사항 정의가 마무리되었습니다', '요구사항 기준선이 잡혔습니다. 요구사항을 실행 가능한 작업 단위로 구체화하면 일정과 책임을 명확하게 관리할 수 있습니다.', 'WBS는 요구사항을 실제 작업 단위로 나눈 실행 계획입니다.', move || act('WBS 작성 시작 →', u('/wbs?new=1')), move ? act('요구사항 보기 →', u('/requirements')) : null, nextPhaseText);
    }
    case 'ANALYSIS_DESIGN': {
      // Phase 3 US-2: an empty WBS starts from the rule-based skeleton (primary); 직접 추가 · Excel · AI stay on the WBS screen as secondary paths
      if (n(wbs.tasks) === 0 && n(wbs.total) === 0) return out('WBS_EMPTY', 'WBS를 작성하세요', `${n(req.in_scope_confirmed) ? `확정한 요구사항 ${req.in_scope_confirmed}건으로` : '확정한 요구사항이 없어도'} 시험·전환·오픈 작업까지 들어간 기본 작업 목록(WBS 뼈대)을 만들 수 있습니다. 만든 뒤 자유롭게 고치고, 일정과 담당자는 직접 채웁니다.`, '실행 작업이 있어야 담당자·일정·진척률을 관리할 수 있습니다.', act('WBS 뼈대 만들기', u('/wbs?skeleton=1')), act('직접 추가 · Excel · AI →', u('/wbs')), '작업이 준비되면 담당자와 일정을 정합니다.');
      if (n(wbs.tasks) === 0) return out('WBS_EMPTY', 'WBS를 작성하세요', '요구사항을 실행 가능한 작업 단위로 구체화해야 일정과 책임을 명확하게 관리할 수 있습니다. 직접 추가, Excel 가져오기, AI WBS 초안(사용 가능 시)을 WBS 화면에서 선택할 수 있습니다.', '실행 작업이 있어야 담당자·일정·진척률을 관리할 수 있습니다.', act('WBS 작성 시작 →', u('/wbs?new=1')), null, '작업이 준비되면 요구사항을 연결하고 담당자와 일정을 정합니다.');
      if (n(req.in_scope) && n(req.in_scope_unlinked)) return out('WBS_TRACE', '요구사항과 WBS를 연결하세요', `범위 내 요구사항 ${req.in_scope}건 중 ${req.in_scope_unlinked}건이 아직 어떤 작업과도 연결되지 않았습니다. 연결이 있어야 빠진 요구사항을 찾고 변경 영향을 추적할 수 있습니다.`, '연결이 있어야 빠진 요구사항을 찾고 변경 영향을 추적할 수 있습니다.', act('요구사항 연결 →', u('/requirements?view=trace&scope=IN_SCOPE&status=DRAFT,REVIEWING,CONFIRMED,ON_HOLD&link=unlinked')), act('WBS 보기 →', u('/wbs')), '연결이 끝나면 담당자와 일정을 정합니다.');
      if (n(wbs.tasks_without_owner)) return out('WBS_ASSIGN', '작업 담당자를 지정하세요', `담당자가 없는 작업 ${wbs.tasks_without_owner}건이 있습니다. 담당자가 정해져야 진행 상황과 지연을 사람 기준으로 추적할 수 있습니다.`, '담당자가 있어야 진행 상황과 지연을 추적할 수 있습니다.', act('담당자 지정 →', u('/wbs?f=no_owner&select=owner')), n(wbs.tasks_without_dates) ? act('일정 입력 →', u('/wbs?f=no_dates')) : null, '담당자 지정 후 일정을 입력합니다.');
      if (n(wbs.tasks_without_dates)) return out('WBS_PLAN', '작업 일정을 입력하세요', `일정이 없는 작업 ${wbs.tasks_without_dates}건이 있습니다. 작업별 계획 일정이 있어야 계획 대비 진척과 지연을 조기에 발견할 수 있습니다.`, '작업별 계획 일정이 있어야 계획 대비 진척과 지연을 계산할 수 있습니다.', act('일정 입력 →', u('/wbs?f=no_dates')), act('Gantt 보기 →', u('/wbs?view=gantt')), '일정이 준비되면 구현 단계로 이동합니다.');
      // 03 완료 가이드 경고 목록 (never blocks — the move to 04 stays primary): 시험 / 오픈 작업 없음 · 종료일 초과 · 구현 작업 미연결
      const bp = wbs.by_phase || {};
      if (n(bp.TESTING) === 0) warnLink('시험 작업이 없습니다', u('/wbs?phase=TESTING'));
      if (n(bp.TRANSITION_GO_LIVE) === 0) warnLink('오픈(전환) 작업이 없습니다', u('/wbs?phase=TRANSITION_GO_LIVE'));
      if (n(wbs.tasks_over_end)) warnLink(`종료일을 넘는 작업 ${wbs.tasks_over_end}건`, u('/wbs?f=over_end'));
      if (n(wbs.tasks_unlinked)) warnLink(wbs.tasks_unlinked_scope === 'DEVELOPMENT' ? `구현 작업 중 요구사항과 연결되지 않은 작업 ${wbs.tasks_unlinked}건` : `요구사항과 연결되지 않은 작업 ${wbs.tasks_unlinked}건`, u(wbs.tasks_unlinked_scope === 'DEVELOPMENT' ? '/wbs?f=unlinked&phase=DEVELOPMENT' : '/wbs?f=unlinked'));
      if (n(wbs.milestones) === 0) warnings.push('등록된 마일스톤 없음');
      return out('WBS_DONE', '실행 계획이 준비되었습니다', '실행 계획이 갖춰졌습니다. 구현 단계에서는 진척·지연·이슈·변경 요청을 꾸준히 기록해야 일정 영향을 미리 줄일 수 있습니다.', '구현 단계에서는 진척·지연·이슈·변경 요청을 중심으로 안내합니다.', move || act('WBS 보기 →', u('/wbs')), move ? act('WBS 보기 →', u('/wbs')) : null, nextPhaseText);
    }
    case 'DEVELOPMENT': {
      if (n(iss.blocked)) return out('DEV_BLOCKED', '차단된 이슈를 해결하세요', `차단된 이슈 ${iss.blocked}건이 진행을 막고 있습니다. 차단을 먼저 풀지 않으면 뒤따르는 작업까지 일정 전체가 밀립니다.`, '차단된 작업을 풀지 않으면 일정 전체가 밀립니다.', act('차단된 이슈 처리 →', u('/issues?status=BLOCKED')), act('WBS 보기 →', u('/wbs?ctx=monitor')), '진행 현황과 지연 작업을 확인합니다.');
      if (n(overdue_tasks)) return out('DEV_OVERDUE', '지연 작업을 확인하세요', `종료 예정일이 지난 작업 ${overdue_tasks}건이 있습니다. 지연 원인과 대응을 지금 정해야 일정 영향을 최소화할 수 있습니다.`, '지연 원인과 대응책을 정해야 일정 영향을 줄일 수 있습니다.', act('지연 작업 확인 →', u('/wbs?f=overdue')), act('이슈 등록 →', u('/issues?new=1')), '지연이 정리되면 진척률을 갱신합니다.');
      if (n(iss.critical)) return out('DEV_CRITICAL', '심각한 이슈를 처리하세요', `심각한 이슈 ${iss.critical}건이 열려 있습니다. 심각한 이슈는 범위·일정·품질에 직접 영향을 주므로 우선 처리해야 합니다.`, '심각한 이슈는 범위·일정·품질에 직접 영향을 줍니다.', act('심각한 이슈 처리 →', u('/issues?severity=CRITICAL')), null, '이슈가 정리되면 진행 현황을 확인합니다.');
      if (n(chg.under_review)) return out('DEV_CHANGE', '고객 결정을 받아 기록하세요', `검토 중 변경 요청 ${chg.under_review}건이 고객 결정을 기다립니다. 고객이 누가·언제·어떻게 승인했는지 기록해야 범위·일정·비용 변경의 근거가 남습니다.`, '승인·반려가 늦어지면 범위와 일정이 불명확해집니다.', act('승인 기록하기', u('/changes?status=UNDER_REVIEW&approve=1')), null, '변경이 결정되면 WBS 영향에 반영합니다.');   // Phase 4 US-2
      if (n(wbs.tasks) === 0) return out('DEV_NO_WBS', '실행 작업(WBS)이 없습니다', '구현 단계이지만 등록된 작업이 없습니다. 작업 단위가 있어야 진행률과 지연을 추적하고 팀과 같은 기준으로 이야기할 수 있습니다.', '작업이 있어야 진행률과 지연을 추적할 수 있습니다.', act('WBS 작성 시작 →', u('/wbs?new=1')), null, '작업이 준비되면 진행 현황을 갱신합니다.');
      const devTotal = wbs.by_phase && n(wbs.by_phase.DEVELOPMENT) ? n(wbs.by_phase.DEVELOPMENT) : n(wbs.tasks);
      const devDone = wbs.by_phase && n(wbs.by_phase.DEVELOPMENT) ? n(wbs.by_phase_completed && wbs.by_phase_completed.DEVELOPMENT) : n(wbs.tasks_completed);
      if (devDone >= devTotal && devTotal) return out('DEV_DONE', '구현 작업이 모두 완료되었습니다', '구현이 마무리되었습니다. 요구사항 기준으로 검증을 마쳐야 검수에서 되돌아오는 재작업을 줄일 수 있습니다.', '구현 결과는 테스트로 검증한 뒤 검수를 받습니다.', move || act('테스트 계획 작성 →', u('/tests?tab=coverage')), move ? act('테스트 계획 작성 →', u('/tests?tab=coverage')) : null, nextPhaseText);
      return out('DEV_STATUS', '작업 진행 상태를 갱신하세요', `완료 ${devDone}/${devTotal}건 · 진행 중 ${n(wbs.in_progress)}건 · 진척률 ${n(wbs.progress)}%. 계획 대비 실제 진행을 주기적으로 기록해야 지연을 조기에 발견할 수 있습니다.`, '계획 대비 실제 진행을 주기적으로 기록해야 지연을 조기에 발견할 수 있습니다.', act('진행 상태 갱신 →', u('/wbs?ctx=monitor')), null, nextPhase ? `구현이 마무리되면 ${nextPhase.name} 단계로 이동합니다.` : null);
    }
    case 'TESTING': {
      // Phase 5: every in-scope confirmed requirement gets a test or a 제외 사유 (US-1) · defects end only when test-born issues are closed (US-2)
      const gen = act('요구사항별 테스트 만들기', u('/tests?tab=coverage&generate=1'));
      if (n(tst.total) === 0) return out('TEST_EMPTY', '요구사항마다 테스트를 준비하세요', n(tst.in_scope_untested) ? `범위 내 요구사항 ${tst.in_scope_untested}건에 테스트를 1건씩 만들어 드립니다. 기대 결과는 요구사항의 완료 조건으로 채웁니다. 요구사항마다 검증해야 검수에서 빠진 기능이 나오지 않습니다.` : '범위 내 확정 요구사항을 기준으로 테스트를 만들어야 구현 결과가 요구사항을 충족하는지 근거 있게 판단할 수 있습니다.', '구현 결과가 요구사항을 충족하는지 요구사항마다 테스트로 확인해야 고객 검수 전에 빠진 검증이 없습니다.', n(tst.in_scope_untested) ? gen : act('테스트 케이스 작성 →', u('/tests?new=1')), n(tst.in_scope_untested) ? act('직접 추가 · Excel로 가져오기', u('/tests?new=1')) : null, '테스트를 실행하고 결과를 기록합니다.');
      if (n(tst.in_scope_untested)) return out('TEST_PLAN', '테스트가 없는 요구사항을 정리하세요', `${testPlanProgressText(tst)}. 테스트가 아직 없는 ${tst.in_scope_untested}건은 테스트를 만들거나, 다른 방법으로 확인한다면 제외 사유를 남기세요.`, '범위 내 요구사항마다 테스트 또는 제외 사유가 있어야 05가 끝납니다.', gen, act('커버리지 보기', u('/tests?tab=coverage')), '테스트를 실행하고 결과를 기록합니다.');
      if (n(tst.last_fail)) return out('TEST_FAIL', '실패한 테스트를 조치하세요', `최근 결과가 실패인 테스트 ${tst.last_fail}건이 있습니다. ${josa('실패', '를')} 이슈로 연결해 조치하고 재실행해야 검수 전에 품질을 확보할 수 있습니다.`, '실패는 이슈로 등록해 조치 담당자를 정하고, 조치 후 다시 실행해야 합니다.', act('결함 조치 →', u('/tests?last_result=FAIL')), act('이슈 보기 →', u('/issues?source=TEST')), '모든 테스트가 통과하면 검수를 준비합니다.');
      if (n(tst.fail_issues_open)) return out('TEST_DEFECT_OPEN', '결함 이슈를 해결로 바꾸세요', `실패 테스트 0건 · ${defectIssuesText(tst)}. 재시험에 통과했다면 이슈를 해결로 바꿔야 결함 조치가 끝납니다.`, '테스트에서 등록한 이슈가 닫혀야 결함 조치가 끝납니다.', act('결함 이슈 보기', u('/issues?source=TEST')), null, '결함이 정리되면 검수를 준비합니다.');
      if (n(tst.executed) < n(tst.total)) return out('TEST_RUN', '테스트를 실행하고 결과를 기록하세요', `테스트 ${tst.total}건 중 ${tst.executed}건이 실행되었습니다. 실행 결과가 쌓여야 품질 상태를 근거 있게 판단할 수 있습니다.`, '실행 결과가 있어야 품질 상태를 판단할 수 있습니다.', act('테스트 실행 →', u('/tests?last_result=NOT_RUN')), null, `실행이 끝나면 ${josa('실패', '를')} 정리합니다.`);
      return out('TEST_DONE', testDoneTitle(tst), '요구사항 기준 검증이 끝났습니다. 오픈 전에 완료 기준과 미해결 항목을 점검하면 예상치 못한 이슈를 줄이고 안정적으로 마무리할 수 있습니다.', '검수는 전환 및 오픈으로 넘어가는 첫 관문입니다.', move || act('검수 항목 작성 →', u('/tests?tab=acceptance&new=1')), move ? act('테스트 결과 보기 →', u('/tests')) : null, nextPhaseText);
    }
    case 'TRANSITION_GO_LIVE': {
      // 검수 rules apply until the ACCEPTANCE activity is complete (from data, or marked by hand when 검수 happened outside RELAI)
      const accDone = Array.isArray(phase && phase.steps) && phase.steps.some((a) => a.step_key === 'ACCEPTANCE' && a.state === 'COMPLETED');
      if (!accDone) {
        if (n(acc.total) === 0) return out('ACC_EMPTY', '검수 항목을 작성하고 인수 승인을 요청하세요', '오픈 전에 완료 기준과 미해결 항목을 점검하면 예상치 못한 이슈를 줄이고 안정적으로 프로젝트를 마무리할 수 있습니다. 검수 항목은 요구사항과 테스트를 묶어 만듭니다.', '검수 승인이 있어야 전환·오픈을 진행할 수 있습니다.', act('검수 항목 작성 →', u('/tests?tab=acceptance&new=1')), null, '검수가 승인되면 전환 계획과 오픈을 준비합니다.');
        if (n(acc.rework)) return out('ACC_REWORK', '보완 요청된 검수를 처리하세요', `보완 필요 ${acc.rework}건이 있습니다. 보완 후 재요청해야 검수를 확정하고 오픈 일정을 지킬 수 있습니다.`, '보완 후 재요청해야 검수를 확정할 수 있습니다.', act('보완 처리 →', u('/tests?tab=acceptance&status=REWORK_REQUIRED')), null, '모든 검수가 승인되면 전환을 준비합니다.');
        if (n(acc.requested)) return out('ACC_PENDING', '검수 결과를 기록하세요', `검수 요청 ${acc.requested}건이 고객 확인을 기다립니다. 승인·반려·보완 결과를 기록해야 미완료 항목을 빠짐없이 정리할 수 있습니다.`, '검수 결과(승인/반려/보완)를 기록해야 미완료 항목을 정리할 수 있습니다.', act('검수 결과 기록 →', u('/tests?tab=acceptance&status=REQUESTED')), null, '검수가 모두 승인되면 전환을 준비합니다.');
        if (n(acc.draft)) return out('ACC_DRAFT', '작성 중인 검수를 요청하세요', `작성 중 검수 ${acc.draft}건이 있습니다. 검수를 요청해야 고객 확인 절차가 시작되고 오픈 일정이 확정됩니다.`, '검수 요청이 있어야 고객 확인 절차가 시작됩니다.', act('검수 요청 →', u('/tests?tab=acceptance&status=DRAFT')), null, '검수 결과를 기록합니다.');
        // Phase 6 US-2: one approved 검수 is not the whole scope — 1차·2차 검수가 범위 내 요구사항을 모두 덮어야 끝납니다
        if (n(acc.scope_target) && n(acc.scope_accepted) < n(acc.scope_target)) return out('ACC_SCOPE', '검수가 범위 전체를 덮도록 나머지를 검수받으세요', `${accScopeText(acc)}. 나머지 ${n(acc.scope_target) - n(acc.scope_accepted)}건을 검수에 묶어 고객 승인을 받아야 검수가 끝납니다.`, '범위 내 요구사항이 모두 승인된 검수에 들어가야 잔금 청구의 근거가 됩니다.', act('검수 범위 보기', u('/tests?tab=acceptance&new=1')), null, '검수가 범위 전체를 덮으면 전환과 오픈을 진행합니다.');
      }
      const open = [];
      if (n(iss.active)) open.push(`열린 이슈 ${iss.active}건`);
      if (n(tst.last_fail)) open.push(`실패 테스트 ${tst.last_fail}건`);
      if (n(chg.approved_unimplemented)) open.push(`미반영 변경 ${chg.approved_unimplemented}건`);
      // US-3: before 오픈 the remaining items are decided in the 오픈 dialog (처리 or 운영 이관); after 오픈 they are recorded → no warning
      if (open.length && !goLiveDone(phase)) return out('GO_LIVE_OPEN', '오픈 전 남은 항목을 정리하세요', `${open.join(' · ')}. 오픈할 때 남은 항목을 하나씩 처리하거나 운영 이관으로 넘깁니다. 운영 이관한 항목은 07에서 이어서 볼 수 있습니다.`, '남은 항목은 처리하거나 운영 이관으로 넘겨야 오픈과 함께 사라지지 않습니다.', act(n(iss.active) ? '열린 이슈 처리 →' : n(tst.last_fail) ? '실패 테스트 조치 →' : '변경 반영 확인 →', u(n(iss.active) ? '/issues' : n(tst.last_fail) ? '/tests?last_result=FAIL' : '/changes?status=APPROVED')), act('오픈 완료 처리', u('?golive=1')), '정리가 끝나면 전환 계획·교육·오픈을 진행합니다.');
      // K25: after 오픈 the headline says so (with what was handed over) and points at 07
      if (goLiveDone(phase)) { const nc = goLive && Array.isArray(goLive.carryovers) ? goLive.carryovers.length : 0;
        return out('TRANSITION_RUN', `오픈 완료${nc ? ` · 운영 이관 ${nc}건` : ''}`, `오픈을 기록했습니다.${nc ? ` 운영 이관한 ${nc}건은 07 운영 단계에서 이어서 봅니다.` : ''} 남은 전환 업무를 정리하고 운영 및 유지보수 단계로 넘어가세요.`, '전환 및 오픈 단계의 필수 활동이 끝나면 운영 및 유지보수 단계로 이동합니다.', actCta || move || act('현황 보기 →', u('/overview')), actCta ? move : null, nextPhaseText); }
      return out('TRANSITION_RUN', '검수가 승인되었습니다 — 전환과 오픈을 진행하세요', '검수가 승인되었습니다. 전환 계획·데이터 마이그레이션·사용자 교육을 마치고 오픈 후 안정화까지 기록해 두면 운영 이관이 매끄러워집니다.', '전환 및 오픈 단계의 필수 활동이 끝나면 운영 및 유지보수 단계로 이동합니다.', actCta || move || act('현황 보기 →', u('/overview')), actCta ? null : move ? act('현황 보기 →', u('/overview')) : null, nextPhaseText);
    }
    case 'OPERATIONS': {
      // Phase 7 US-4: what 오픈 handed over is one warn line with its owner count (never red) — not 독촉 numbers
      if (goLive && goLive.carryovers && goLive.carryovers.length) { const o = goLive.owners || { assigned: 0 }; const t = `운영 이관 ${goLive.carryovers.length}건 · 담당 지정 ${n(o.assigned)}/${goLive.carryovers.length}`; warnings.unshift(t); warningLinks[t] = u('?handover=1'); }   // always the first line
      const fresh = n(iss.active);   // carried issues already out of stats
      if (fresh > 0) return out('OPS_ISSUES', '오픈 뒤 열린 이슈를 정리하세요', `${goLive ? '오픈 뒤 새로 열린' : '열린'} 이슈 ${fresh}건이 남아 있습니다. 해결하거나 담당을 정해 두어야 운영 단계에서 책임이 비지 않습니다.`, '남은 이슈는 해결하거나 운영 담당을 정해야 합니다.', act('이슈 처리 →', u('/issues')), act('현황 보기 →', u('/overview')), '운영 이관과 종료 정리를 진행합니다.');
      const stepOf = (k) => (Array.isArray(phase && phase.steps) ? phase.steps.find((a) => a.step_key === k) : null);
      const doneSt = (a) => !a || a.state === 'COMPLETED' || a.state === 'SKIPPED';
      const hand = stepOf('HANDOVER'); const close = stepOf('CLOSE');
      if (!doneSt(hand)) return out('OPS_HANDOVER', '운영 조직에 인수인계하세요', '운영 매뉴얼·계정·모니터링을 넘기고 누가 언제 인수했는지 기록하세요. 운영 이관 항목마다 운영 담당을 정해 두면 오픈 뒤 책임이 비지 않습니다.', '누가 운영을 인수했는지 남아야 프로젝트를 종료할 수 있습니다.', act('인수 완료 처리', u('?handover=1')), null, '인수 뒤 완료보고서를 정리하고 프로젝트를 종료합니다.');
      if (!doneSt(close)) {
        const draft = completion && completion.state === 'DRAFT';
        return out('OPS_CLOSE_REPORT', draft ? '완료보고서를 마무리해 확정하세요' : '완료보고서로 결과를 정리하세요', '목표·범위·일정·품질·검수·남은 일은 데이터로 채워집니다. 고쳐서 확정하면 고객과 회사에 보고할 결과물이 됩니다. 교훈은 직접 적습니다.', '완료보고서를 확정해야 프로젝트를 종료할 수 있습니다.',
          draft ? act('이어서 작성', u(`/reports/${completion.report_id}`)) : act('완료보고서 만들기', u('/reports?new=completion')), null, '확정하면 프로젝트를 종료합니다.');
      }
      if (!(phase && phase.summary && phase.summary.gate_met)) return out('OPS_HANDOVER', '운영 이관과 종료 정리를 진행하세요', '운영 인수인계·유지보수 체계를 정리해 두면 운영 단계와 다음 프로젝트에서 같은 기준을 재사용할 수 있습니다.', '07 필수 업무를 마쳐야 프로젝트를 종료할 수 있습니다.', actCta || act('현황 보기 →', u('/overview')), null, null);
      return out('OPS_CLOSE', '프로젝트를 종료하세요', '07 필수 업무를 모두 마쳤습니다. 종료하면 홈과 안내가 더 이상 할 일을 독촉하지 않습니다. 기록은 그대로 남고 언제든 종료를 취소할 수 있습니다.', '모든 업무를 마친 프로젝트는 완료로 닫아 진행 중 목록에서 뺍니다.', act('프로젝트 종료', u('?close=1')), completion && completion.report_id ? act('완료보고서 보기', u(`/reports/${completion.report_id}`)) : null, null);
    }
    default:
      return out('UNKNOWN', 'What’s Next?', '', '', act('What’s Next? →', u('')), null, null);
  }
}
