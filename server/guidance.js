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

const n = (v) => Number(v) || 0;

/** One line per phase shown the first time a user enters it ("이 단계에서 하는 일"). */
export const PHASE_INTRO = Object.fromEntries(DEFAULT_PHASES.map((p) => [p.key, { what: p.description, outputs: p.steps.filter((s) => s.importance === 'REQUIRED').map((s) => s.title) }]));

export function projectGuidance(ctx) {
  const { project, phase, next_phase: nextPhase, definition, stats = {}, overdue_tasks = 0 } = ctx;
  const u = (p = '') => `/app/projects/${project.id}${p}`;
  const req = stats.requirements || {}; const wbs = stats.wbs || {}; const tst = stats.tests || {}; const acc = stats.acceptances || {}; const iss = stats.issues || {}; const chg = stats.changes || {};
  const key = phase ? phase.phase_key || phase.key : project.current_phase;
  const warnings = [];
  const act = (label, href) => ({ label, href });
  const move = nextPhase ? act(`${nextPhase.name} 단계 시작 →`, u('?move=next')) : null;
  const out = (rule, title, description, why, primary, secondary = null, next = null) => ({
    current_phase: { key, name: phase?.name || PHASE_BY_KEY[key]?.name || key, sequence: phase?.sequence || (DEFAULT_PHASES.findIndex((p) => p.key === key) + 1) },
    rule, title, description, why, primary_action: primary, secondary_action: secondary, warnings, next_preview: next,
  });
  const nextPhaseText = nextPhase ? `다음 단계: ${nextPhase.name}` : null;

  // Cross-phase warnings (guidance, never gates)
  if (n(req.total) && n(req.scope_undecided) && key !== 'REQUIREMENTS') warnings.push(`범위가 결정되지 않은 요구사항 ${req.scope_undecided}건`);
  if (n(req.in_scope) && n(req.in_scope_confirmed) < n(req.in_scope) && key !== 'INITIATION' && key !== 'REQUIREMENTS') warnings.push(`미확정 요구사항 ${n(req.in_scope) - n(req.in_scope_confirmed)}건`);
  if (n(iss.critical) && key !== 'DEVELOPMENT') warnings.push(`Critical Issue ${iss.critical}건`);
  if (n(chg.approved_unimplemented) && key !== 'DEVELOPMENT') warnings.push(`승인 후 미반영 변경 ${chg.approved_unimplemented}건`);

  switch (key) {
    case 'INITIATION': {
      const d = definition?.progress || { done: 0, total: 5 };
      if (definition?.needs_review?.length) return out('INIT_REVIEW', '수정된 정의 항목을 다시 확인하세요', `완료 후 내용이 바뀐 항목 ${definition.needs_review.length}개가 있습니다. 정의는 요구사항·일정·검수의 기준이므로 바뀐 내용을 다시 확인해야 이후 판단이 어긋나지 않습니다.`, '프로젝트 정의는 요구사항·일정의 기준이 되므로 변경 후 다시 확인해야 합니다.', act('프로젝트 정의 확인 →', u('/definition')), null, '정의가 확정되면 요구사항을 정리합니다.');
      if (d.done < d.total) return out('INIT_DEFINE', d.done === 0 ? '프로젝트의 목표와 범위를 정의하세요' : `프로젝트 정의를 마저 완료하세요 (${d.done}/${d.total})`, '초기에 목표·성공 기준, 수행·제외 범위, 이해관계자, 주요 일정과 운영 방식을 확정해야 이후 단계에서 방향성이 흔들리지 않습니다.', '착수 단계에서 정한 기준이 이후 요구사항, 일정, 검수의 판단 기준이 됩니다.', act(d.done === 0 ? '프로젝트 정의 시작 →' : '프로젝트 정의 이어서 작성 →', u('/definition')), null, '정의가 완료되면 요구사항을 등록합니다.');
      return out('INIT_DONE', '프로젝트 정의가 완료되었습니다', '출발 기준이 정리되었습니다. 요구사항을 초기에 명확히 정리하면 설계·개발 단계의 범위 변경과 재작업을 크게 줄일 수 있습니다.', '요구사항은 WBS, 테스트, 검수와 연결되는 프로젝트의 기준입니다.', move || act('요구사항 입력 시작 →', u('/requirements?new=1')), move ? act('요구사항 입력 시작 →', u('/requirements?new=1')) : null, nextPhaseText);
    }
    case 'REQUIREMENTS': {
      if (n(req.total) === 0) return out('REQ_EMPTY', '요구사항을 수집하고 정리하세요', '요구사항을 초기에 명확히 정리하면 설계·개발 단계의 범위 변경과 재작업을 크게 줄일 수 있습니다. 직접 입력, Excel 가져오기, AI 추출(사용 가능 시)을 Requirements 화면에서 선택할 수 있습니다.', '요구사항은 프로젝트 범위와 검수 기준이 되며 WBS·테스트와 연결됩니다.', act('요구사항 입력 시작 →', u('/requirements?new=1')), null, '요구사항이 준비되면 분류와 범위를 정리합니다.');
      if (n(req.type_unspecified)) return out('REQ_CLASSIFY', '요구사항을 분류하세요', `유형이 지정되지 않은 요구사항 ${req.type_unspecified}건이 있습니다. 기능·비기능·인터페이스·데이터 구분이 있어야 설계와 테스트 범위를 빠짐없이 잡을 수 있습니다.`, '기능·비기능·인터페이스·데이터 구분이 있어야 설계와 테스트 범위를 정할 수 있습니다.', act('요구사항 분류 →', u('/requirements?type=UNSPECIFIED')), n(req.priority_unspecified) ? act('우선순위 설정 →', u('/requirements?priority=UNSPECIFIED')) : null, '분류가 끝나면 범위를 확정합니다.');
      if (n(req.scope_undecided)) return out('REQ_SCOPE', '요구사항의 범위를 확정하세요', `범위가 결정되지 않은 요구사항 ${req.scope_undecided}건이 있습니다. 범위를 먼저 정해야 WBS와 테스트 범위를 흔들림 없이 세울 수 있습니다.`, '범위가 정해져야 실행 계획(WBS)과 테스트 범위를 정할 수 있습니다.', act('범위 결정 →', u('/requirements?scope=UNDECIDED')), n(req.priority_unspecified) ? act('우선순위 설정 →', u('/requirements?priority=UNSPECIFIED')) : null, '범위가 정해지면 요구사항을 확정합니다.');
      if (n(req.in_scope) && n(req.in_scope_confirmed) < n(req.in_scope)) return out('REQ_CONFIRM', '요구사항을 검토하고 확정하세요', `범위 내 요구사항 ${req.in_scope}건 중 ${req.in_scope_confirmed}건이 확정되었습니다. 확정된 기준선이 있어야 이후 변경을 변경 요청으로 통제할 수 있습니다.${n(req.priority_unspecified) ? ` 우선순위 미지정 ${req.priority_unspecified}건.` : ''}`, '확정된 요구사항이 기준선이 되어 이후 변경은 변경 요청으로 관리됩니다.', act('요구사항 확정 →', u('/requirements?scope=IN_SCOPE&status=DRAFT,REVIEWING,ON_HOLD,REJECTED')), n(req.priority_unspecified) ? act('우선순위 설정 →', u('/requirements?priority=UNSPECIFIED')) : null, '확정 후 분석·설계 단계에서 WBS를 작성합니다.');
      if (n(req.priority_unspecified)) warnings.push(`우선순위 미지정 요구사항 ${req.priority_unspecified}건`);
      return out('REQ_DONE', '요구사항 정의가 마무리되었습니다', '요구사항 기준선이 잡혔습니다. 요구사항을 실행 가능한 작업 단위로 구체화하면 일정과 책임을 명확하게 관리할 수 있습니다.', 'WBS는 요구사항을 실제 작업 단위로 나눈 실행 계획입니다.', move || act('WBS 작성 시작 →', u('/wbs?new=1')), move ? act('요구사항 보기 →', u('/requirements')) : null, nextPhaseText);
    }
    case 'ANALYSIS_DESIGN': {
      if (n(wbs.tasks) === 0) return out('WBS_EMPTY', 'WBS를 작성하세요', '요구사항을 실행 가능한 작업 단위로 구체화해야 일정과 책임을 명확하게 관리할 수 있습니다. 직접 추가, Excel Import, AI WBS 초안(사용 가능 시)을 WBS 화면에서 선택할 수 있습니다.', '실행 작업이 있어야 담당자·일정·진척률을 관리할 수 있습니다.', act('WBS 작성 시작 →', u('/wbs?new=1')), null, '작업이 준비되면 요구사항을 연결하고 담당자와 일정을 정합니다.');
      if (n(req.in_scope) && n(req.in_scope_unlinked)) return out('WBS_TRACE', '요구사항과 WBS를 연결하세요', `범위 내 요구사항 ${req.in_scope}건 중 ${req.in_scope_unlinked}건이 아직 어떤 작업과도 연결되지 않았습니다. 연결이 있어야 빠진 요구사항을 찾고 변경 영향을 추적할 수 있습니다.`, '연결이 있어야 빠진 요구사항을 찾고 변경 영향을 추적할 수 있습니다.', act('요구사항 연결 →', u('/requirements?view=trace&scope=IN_SCOPE&link=unlinked')), act('WBS 보기 →', u('/wbs')), '연결이 끝나면 담당자와 일정을 정합니다.');
      if (n(wbs.tasks_without_owner)) return out('WBS_ASSIGN', '작업 담당자를 지정하세요', `담당자가 없는 작업 ${wbs.tasks_without_owner}건이 있습니다. 담당자가 정해져야 진행 상황과 지연을 사람 기준으로 추적할 수 있습니다.`, '담당자가 있어야 진행 상황과 지연을 추적할 수 있습니다.', act('담당자 지정 →', u('/wbs?f=no_owner')), n(wbs.tasks_without_dates) ? act('일정 입력 →', u('/wbs?f=no_dates')) : null, '담당자 지정 후 일정을 입력합니다.');
      if (n(wbs.tasks_without_dates)) return out('WBS_PLAN', '작업 일정을 입력하세요', `일정이 없는 작업 ${wbs.tasks_without_dates}건이 있습니다. 작업별 계획 일정이 있어야 계획 대비 진척과 지연을 조기에 발견할 수 있습니다.`, '작업별 계획 일정이 있어야 계획 대비 진척과 지연을 계산할 수 있습니다.', act('일정 입력 →', u('/wbs?f=no_dates')), act('Gantt 보기 →', u('/wbs?view=gantt')), '일정이 준비되면 구현 단계로 이동합니다.');
      if (n(wbs.tasks_unlinked)) warnings.push(`요구사항과 연결되지 않은 작업 ${wbs.tasks_unlinked}건`);
      if (n(wbs.milestones) === 0) warnings.push('등록된 마일스톤 없음');
      return out('WBS_DONE', '실행 계획이 준비되었습니다', '실행 계획이 갖춰졌습니다. 구현 단계에서는 진척·지연·Issue·변경 요청을 꾸준히 기록해야 일정 영향을 미리 줄일 수 있습니다.', '구현 단계에서는 진척·지연·Issue·변경 요청을 중심으로 안내합니다.', move || act('WBS 보기 →', u('/wbs')), move ? act('WBS 보기 →', u('/wbs')) : null, nextPhaseText);
    }
    case 'DEVELOPMENT': {
      if (n(iss.blocked)) return out('DEV_BLOCKED', 'Blocker를 해결하세요', `차단 상태 Issue ${iss.blocked}건이 진행을 막고 있습니다. 차단을 먼저 풀지 않으면 뒤따르는 작업까지 일정 전체가 밀립니다.`, '차단된 작업을 풀지 않으면 일정 전체가 밀립니다.', act('Blocked Issue 처리 →', u('/issues?status=BLOCKED')), act('WBS 보기 →', u('/wbs?ctx=monitor')), '진행 현황과 지연 작업을 확인합니다.');
      if (n(overdue_tasks)) return out('DEV_OVERDUE', '지연 작업을 확인하세요', `종료 예정일이 지난 작업 ${overdue_tasks}건이 있습니다. 지연 원인과 대응을 지금 정해야 일정 영향을 최소화할 수 있습니다.`, '지연 원인과 대응책을 정해야 일정 영향을 줄일 수 있습니다.', act('지연 작업 확인 →', u('/wbs?f=overdue')), act('Issue 등록 →', u('/issues?new=1')), '지연이 정리되면 진척률을 갱신합니다.');
      if (n(iss.critical)) return out('DEV_CRITICAL', 'Critical Issue를 처리하세요', `Critical Issue ${iss.critical}건이 열려 있습니다. Critical Issue는 범위·일정·품질에 직접 영향을 주므로 우선 처리해야 합니다.`, 'Critical Issue는 범위·일정·품질에 직접 영향을 줍니다.', act('Critical Issue 처리 →', u('/issues?severity=CRITICAL')), null, '이슈가 정리되면 진행 현황을 확인합니다.');
      if (n(chg.under_review)) return out('DEV_CHANGE', '검토 중인 변경 요청을 결정하세요', `검토 중 변경 요청 ${chg.under_review}건이 결정을 기다립니다. 승인·반려가 늦어질수록 범위와 일정이 불명확해집니다.`, '승인·반려가 늦어지면 범위와 일정이 불명확해집니다.', act('변경 요청 결정 →', u('/changes?status=UNDER_REVIEW')), null, '변경이 결정되면 WBS 영향에 반영합니다.');
      if (n(wbs.tasks) === 0) return out('DEV_NO_WBS', '실행 작업(WBS)이 없습니다', '구현 단계이지만 등록된 작업이 없습니다. 작업 단위가 있어야 진행률과 지연을 추적하고 팀과 같은 기준으로 이야기할 수 있습니다.', '작업이 있어야 진행률과 지연을 추적할 수 있습니다.', act('WBS 작성 시작 →', u('/wbs?new=1')), null, '작업이 준비되면 진행 현황을 갱신합니다.');
      const devTotal = wbs.by_phase && n(wbs.by_phase.DEVELOPMENT) ? n(wbs.by_phase.DEVELOPMENT) : n(wbs.tasks);
      const devDone = wbs.by_phase && n(wbs.by_phase.DEVELOPMENT) ? n(wbs.by_phase_completed && wbs.by_phase_completed.DEVELOPMENT) : n(wbs.tasks_completed);
      if (devDone >= devTotal && devTotal) return out('DEV_DONE', '구현 작업이 모두 완료되었습니다', '구현이 마무리되었습니다. 요구사항 기준으로 검증을 마쳐야 검수에서 되돌아오는 재작업을 줄일 수 있습니다.', '구현 결과는 테스트로 검증한 뒤 검수를 받습니다.', move || act('테스트 계획 작성 →', u('/tests?tab=coverage')), move ? act('테스트 계획 작성 →', u('/tests?tab=coverage')) : null, nextPhaseText);
      return out('DEV_STATUS', '작업 진행 상태를 갱신하세요', `완료 ${devDone}/${devTotal}건 · 진행 중 ${n(wbs.in_progress)}건 · 진척률 ${n(wbs.progress)}%. 계획 대비 실제 진행을 주기적으로 기록해야 지연을 조기에 발견할 수 있습니다.`, '계획 대비 실제 진행을 주기적으로 기록해야 지연을 조기에 발견할 수 있습니다.', act('진행 상태 갱신 →', u('/wbs?ctx=monitor')), null, nextPhase ? `구현이 마무리되면 ${nextPhase.name} 단계로 이동합니다.` : null);
    }
    case 'TESTING': {
      if (n(tst.total) === 0) return out('TEST_EMPTY', '테스트 계획을 세우고 케이스를 작성하세요', '범위 내 요구사항을 기준으로 검증 항목을 정해 두면 구현 결과가 요구사항을 충족하는지 객관적으로 판단하고 검수를 요청할 수 있습니다.', '구현 결과가 요구사항을 충족하는지 검증해야 검수를 요청할 수 있습니다.', act('테스트 케이스 작성 →', u('/tests?new=1')), act('Coverage 보기 →', u('/tests?tab=coverage')), '테스트를 실행하고 결과를 기록합니다.');
      if (n(tst.last_fail)) return out('TEST_FAIL', '실패한 테스트를 조치하세요', `최근 결과가 Fail인 테스트 ${tst.last_fail}건이 있습니다. Fail을 Issue로 연결해 조치하고 재실행해야 검수 전에 품질을 확보할 수 있습니다.`, 'Fail은 Issue로 등록해 조치 담당자를 정하고, 조치 후 다시 실행해야 합니다.', act('결함 조치 →', u('/tests?last_result=FAIL')), act('Issue 보기 →', u('/issues')), '모든 테스트가 Pass하면 검수를 준비합니다.');
      if (n(tst.executed) < n(tst.total)) return out('TEST_RUN', '테스트를 실행하고 결과를 기록하세요', `테스트 ${tst.total}건 중 ${tst.executed}건이 실행되었습니다. 실행 결과가 쌓여야 품질 상태를 근거 있게 판단할 수 있습니다.`, '실행 결과가 있어야 품질 상태를 판단할 수 있습니다.', act('테스트 실행 →', u('/tests?last_result=NOT_RUN')), null, '실행이 끝나면 Fail을 정리합니다.');
      if (n(tst.in_scope_untested)) warnings.push(`테스트가 연결되지 않은 범위 내 요구사항 ${tst.in_scope_untested}건`);
      return out('TEST_DONE', '테스트가 모두 통과했습니다', '테스트가 모두 통과했습니다. 오픈 전에 완료 기준과 미해결 항목을 점검하면 예상치 못한 이슈를 줄이고 안정적으로 마무리할 수 있습니다.', '검수는 전환 및 오픈으로 넘어가는 첫 관문입니다.', move || act('검수 항목 작성 →', u('/tests?tab=acceptance&new=1')), move ? act('테스트 결과 보기 →', u('/tests')) : null, nextPhaseText);
    }
    case 'TRANSITION_GO_LIVE': {
      if (n(acc.total) === 0) return out('ACC_EMPTY', '검수 항목을 작성하고 인수 승인을 요청하세요', '오픈 전에 완료 기준과 미해결 항목을 점검하면 예상치 못한 이슈를 줄이고 안정적으로 프로젝트를 마무리할 수 있습니다. 검수 항목은 요구사항과 테스트를 묶어 만듭니다.', '검수 승인이 있어야 전환·오픈을 진행할 수 있습니다.', act('검수 항목 작성 →', u('/tests?tab=acceptance&new=1')), null, '검수가 승인되면 전환 계획과 오픈을 준비합니다.');
      if (n(acc.rework)) return out('ACC_REWORK', '보완 요청된 검수를 처리하세요', `보완 필요 ${acc.rework}건이 있습니다. 보완 후 재요청해야 검수를 확정하고 오픈 일정을 지킬 수 있습니다.`, '보완 후 재요청해야 검수를 확정할 수 있습니다.', act('보완 처리 →', u('/tests?tab=acceptance&status=REWORK_REQUIRED')), null, '모든 검수가 승인되면 전환을 준비합니다.');
      if (n(acc.requested)) return out('ACC_PENDING', '검수 결과를 기록하세요', `검수 요청 ${acc.requested}건이 고객 확인을 기다립니다. 승인·반려·보완 결과를 기록해야 미완료 항목을 빠짐없이 정리할 수 있습니다.`, '검수 결과(승인/반려/보완)를 기록해야 미완료 항목을 정리할 수 있습니다.', act('검수 결과 기록 →', u('/tests?tab=acceptance&status=REQUESTED')), null, '검수가 모두 승인되면 전환을 준비합니다.');
      if (n(acc.draft)) return out('ACC_DRAFT', '작성 중인 검수를 요청하세요', `작성 중 검수 ${acc.draft}건이 있습니다. 검수를 요청해야 고객 확인 절차가 시작되고 오픈 일정이 확정됩니다.`, '검수 요청이 있어야 고객 확인 절차가 시작됩니다.', act('검수 요청 →', u('/tests?tab=acceptance&status=DRAFT')), null, '검수 결과를 기록합니다.');
      const open = [];
      if (n(iss.active)) open.push(`Open Issue ${iss.active}건`);
      if (n(tst.last_fail)) open.push(`Fail 테스트 ${tst.last_fail}건`);
      if (n(chg.approved_unimplemented)) open.push(`미반영 변경 ${chg.approved_unimplemented}건`);
      if (open.length) return out('GO_LIVE_OPEN', '오픈 전 미완료 항목을 정리하세요', `${open.join(' · ')}. 남은 항목을 정리하거나 운영 이관 항목으로 기록해야 안정적으로 오픈할 수 있습니다.`, '남은 항목을 정리하거나 운영 이관 항목으로 기록해야 안정적으로 오픈할 수 있습니다.', act(n(iss.active) ? 'Open Issue 처리 →' : n(tst.last_fail) ? 'Fail 테스트 조치 →' : '변경 반영 확인 →', u(n(iss.active) ? '/issues' : n(tst.last_fail) ? '/tests?last_result=FAIL' : '/changes?status=APPROVED')), null, '정리가 끝나면 전환 계획·교육·Go-Live를 진행합니다.');
      return out('TRANSITION_RUN', '검수가 승인되었습니다 — 전환과 오픈을 진행하세요', '검수가 승인되었습니다. 전환 계획·데이터 마이그레이션·사용자 교육을 마치고 Go-Live 후 안정화까지 기록해 두면 운영 이관이 매끄러워집니다.', '전환 및 오픈 단계의 필수 활동이 끝나면 운영 및 유지보수 단계로 이동합니다.', move || act('Overview 보기 →', u('/overview')), move ? act('Overview 보기 →', u('/overview')) : null, nextPhaseText);
    }
    case 'OPERATIONS': {
      if (n(iss.active)) return out('OPS_ISSUES', '운영 이관 전 Open Issue를 정리하세요', `Open Issue ${iss.active}건이 남아 있습니다. 해결하거나 운영 이관 대상으로 기록해 두어야 운영 단계에서 책임이 비지 않습니다.`, '남은 이슈는 해결하거나 운영 이관 대상으로 기록해야 합니다.', act('Issue 처리 →', u('/issues')), act('Overview 보기 →', u('/overview')), '운영 이관과 종료 정리를 진행합니다.');
      return out('OPS_HANDOVER', '운영 이관과 종료 정리를 진행하세요', '운영 인수인계·유지보수 체계·SLA·정기 배포 계획을 정리해 두면 운영 단계와 다음 프로젝트에서 같은 기준을 재사용할 수 있습니다.', '종료 정리(결과 공유, 운영 이관)를 남겨야 운영 단계와 다음 프로젝트에서 재사용할 수 있습니다.', act('Overview 보기 →', u('/overview')), act('주간보고 보기 →', u('/reports')), null);
    }
    default:
      return out('UNKNOWN', 'What’s Next?', '', '', act('What’s Next? →', u('')), null, null);
  }
}
