/**
 * Guided Project Execution (Phase 14) — "지금 해야 할 일" for the project home.
 *
 * A deterministic, explainable rule ladder over data the app already computes (current phase, definition progress,
 * requirement / WBS / test / acceptance / issue stats). No workflow engine, no stored state, no AI: the same inputs
 * always give the same answer, and every answer says *why* and *what comes next*.
 *
 *   projectGuidance(ctx) → { current_phase, title, description, why, primary_action, secondary_action, warnings, next_preview, rule }
 *
 * ctx = { project, phase: {key,name,sequence}, next_phase, definition: {progress:{done,total}, needs_review:[]}, stats, overdue_tasks }
 */
import { DEFAULT_PHASES } from './templates/default-phases.js';

const n = (v) => Number(v) || 0;
const PH = Object.fromEntries(DEFAULT_PHASES.map((p) => [p.key, p]));

/** One line per phase shown the first time a user enters it ("이 단계에서 하는 일"). */
export const PHASE_INTRO = {
  INITIATION: { what: '프로젝트의 목표, 범위, 관계자, 일정, 운영 방식을 정리해 출발 기준을 맞춥니다.', outputs: ['프로젝트 정의 5개 항목'] },
  REQUIREMENTS: { what: '무엇을 만들어야 하는지 수집·정리해 고객과 합의된 요구사항 목록을 만듭니다.', outputs: ['요구사항 목록', '분류·우선순위·범위', '확정'] },
  SCHEDULE: { what: '요구사항을 실행 작업(WBS)으로 나누고 담당자와 일정을 정해 실행 계획을 만듭니다.', outputs: ['WBS', '담당자·일정', '마일스톤'] },
  EXECUTION: { what: '계획대로 진행하면서 지연, 이슈, 변경 요청을 놓치지 않고 관리합니다.', outputs: ['진행 현황', 'Issue', '변경 요청'] },
  TESTING: { what: '구현된 기능이 요구사항을 충족하는지 검증합니다.', outputs: ['Test Case', 'Execution 결과', 'Fail → Issue'] },
  ACCEPTANCE: { what: '고객이 결과물을 직접 확인하고 보완사항을 처리해 검수 결과를 확정합니다.', outputs: ['검수 항목', '검수 결과', '보완 처리'] },
  LAUNCH: { what: '운영 환경에서 서비스를 열고 안정화와 종료 사항을 마무리합니다.', outputs: ['오픈 체크', '안정화', '종료 정리'] },
};

export function projectGuidance(ctx) {
  const { project, phase, next_phase: nextPhase, definition, stats = {}, overdue_tasks = 0 } = ctx;
  const u = (p = '') => `/app/projects/${project.id}${p}`;
  const req = stats.requirements || {}; const wbs = stats.wbs || {}; const tst = stats.tests || {}; const acc = stats.acceptances || {}; const iss = stats.issues || {}; const chg = stats.changes || {};
  const key = phase ? phase.phase_key || phase.key : project.current_phase;
  const warnings = [];
  const act = (label, href) => ({ label, href });
  const out = (rule, title, description, why, primary, secondary = null, next = null) => ({
    current_phase: { key, name: phase?.name || PH[key]?.name || key, sequence: phase?.sequence || (DEFAULT_PHASES.findIndex((p) => p.key === key) + 1) },
    rule, title, description, why, primary_action: primary, secondary_action: secondary, warnings, next_preview: next,
  });
  const nextPhaseText = nextPhase ? `${nextPhase.name} 단계로 이동합니다.` : null;

  // Cross-phase warnings (guidance, never gates)
  if (n(req.total) && n(req.scope_undecided)) warnings.push(`범위가 결정되지 않은 요구사항 ${req.scope_undecided}건`);
  if (n(req.in_scope) && n(req.in_scope_confirmed) < n(req.in_scope) && key !== 'INITIATION' && key !== 'REQUIREMENTS') warnings.push(`미확정 요구사항 ${n(req.in_scope) - n(req.in_scope_confirmed)}건`);
  if (n(iss.critical)) warnings.push(`Critical Issue ${iss.critical}건`);
  if (n(chg.approved_unimplemented)) warnings.push(`승인 후 미반영 변경 ${chg.approved_unimplemented}건`);

  switch (key) {
    case 'INITIATION': {
      const d = definition?.progress || { done: 0, total: 5 };
      if (definition?.needs_review?.length) return out('INIT_REVIEW', '수정된 정의 항목을 다시 확인하세요', `완료 후 내용이 바뀐 항목 ${definition.needs_review.length}개가 있습니다.`, '프로젝트 정의는 요구사항·일정의 기준이 되므로 변경 후 다시 확인해야 합니다.', act('프로젝트 정의 확인', u('/definition')), null, '정의가 확정되면 요구사항을 정리합니다.');
      if (d.done < d.total) return out('INIT_DEFINE', d.done === 0 ? '프로젝트의 목표와 범위를 정의하세요' : `프로젝트 정의를 마저 완료하세요 (${d.done}/${d.total})`, '목표·성공 기준, 수행·제외 범위, 이해관계자, 주요 일정, 운영 방식을 작성하고 각 항목을 완료 처리합니다.', '착수 단계에서 정한 기준이 이후 요구사항, 일정, 검수의 판단 기준이 됩니다.', act(d.done === 0 ? '프로젝트 정의 시작' : '프로젝트 정의 이어서 작성', u('/definition')), null, '정의가 완료되면 요구사항을 등록합니다.');
      return out('INIT_DONE', '프로젝트 정의가 완료되었습니다', '이제 요구사항을 정리할 차례입니다. 요구사항 단계로 이동해 등록을 시작하세요.', '요구사항은 WBS, 테스트, 검수와 연결되는 프로젝트의 기준입니다.', act(n(req.total) ? '요구사항 관리' : '요구사항 등록', u('/requirements?new=1')), nextPhase ? act(`${nextPhase.name} 단계로 이동`, u('?move=next')) : null, nextPhaseText);
    }
    case 'REQUIREMENTS': {
      if (n(req.total) === 0) return out('REQ_EMPTY', '요구사항을 1건 이상 등록하세요', '직접 입력, Excel 가져오기, 또는 AI 추출(사용 가능 시)로 요구사항을 등록합니다.', '요구사항은 프로젝트 범위와 검수 기준이 되며 WBS·테스트와 연결됩니다.', act('요구사항 추가', u('/requirements?new=1')), act('Excel 가져오기', u('/requirements?import=1')), '요구사항이 준비되면 WBS를 작성합니다.');
      if (n(req.type_unspecified) || n(req.priority_unspecified) || n(req.scope_undecided)) return out('REQ_CLASSIFY', '요구사항의 분류·우선순위·범위를 정리하세요', `유형 미지정 ${n(req.type_unspecified)}건 · 우선순위 미지정 ${n(req.priority_unspecified)}건 · 범위 미결정 ${n(req.scope_undecided)}건`, '범위와 우선순위가 정해져야 실행 계획(WBS)과 테스트 범위를 정할 수 있습니다.', act('요구사항 정리', u(n(req.scope_undecided) ? '/requirements?scope=UNDECIDED' : n(req.priority_unspecified) ? '/requirements?priority=UNSPECIFIED' : '/requirements?type=UNSPECIFIED')), act('WBS 만들기', u('/wbs')), '정리가 끝나면 요구사항을 확정하고 WBS를 작성합니다.');
      if (n(req.in_scope) && n(req.in_scope_confirmed) < n(req.in_scope)) return out('REQ_CONFIRM', '요구사항을 검토하고 확정하세요', `범위 내 요구사항 ${req.in_scope}건 중 ${req.in_scope_confirmed}건이 확정되었습니다.`, '확정된 요구사항이 기준선이 되어 이후 변경은 변경 요청으로 관리됩니다.', act('미확정 요구사항 보기', u('/requirements?scope=IN_SCOPE&status=DRAFT,REVIEWING,ON_HOLD')), act('WBS 만들기', u('/wbs')), '확정 후 일정 단계에서 WBS를 작성합니다.');
      return out('REQ_DONE', '요구사항이 정리되었습니다', '요구사항을 기준으로 실행 계획(WBS)을 구성하세요.', 'WBS는 요구사항을 실제 작업 단위로 나눈 실행 계획입니다.', act(n(wbs.tasks) ? 'WBS 보기' : 'WBS 만들기', u('/wbs')), nextPhase ? act(`${nextPhase.name} 단계로 이동`, u('?move=next')) : null, nextPhaseText);
    }
    case 'SCHEDULE': {
      if (n(wbs.tasks) === 0) return out('WBS_EMPTY', '실행 작업(WBS)을 만드세요', '요구사항을 실제 작업 단위로 나누어 계획합니다. 직접 추가, Excel Import, AI 생성(사용 가능 시)을 쓸 수 있습니다.', '실행 작업이 있어야 담당자·일정·진척률을 관리할 수 있습니다.', act('WBS 추가', u('/wbs?new=1')), act('Excel Import', u('/wbs?import=1')), '작업이 준비되면 담당자와 일정을 확인합니다.');
      if (n(wbs.tasks_without_owner) || n(wbs.tasks_without_dates)) return out('WBS_PLAN', '실행 준비를 위해 담당자와 일정을 확인하세요', `담당자 미지정 ${n(wbs.tasks_without_owner)}건 · 일정 미입력 ${n(wbs.tasks_without_dates)}건`, '담당자와 일정이 있어야 지연과 진행 상황을 추적할 수 있습니다.', act(n(wbs.tasks_without_dates) ? '일정 미입력 작업 보기' : '담당자 미지정 작업 보기', u(n(wbs.tasks_without_dates) ? '/wbs?f=no_dates' : '/wbs?f=no_owner')), act('Gantt 보기', u('/wbs?view=gantt')), '준비가 끝나면 실행 단계로 이동합니다.');
      if (n(wbs.tasks_unlinked)) warnings.push(`요구사항과 연결되지 않은 작업 ${wbs.tasks_unlinked}건`);
      if (n(wbs.milestones) === 0) return out('WBS_MILESTONE', '주요 마일스톤을 등록하세요', '중간 점검, 테스트, 검수, 오픈 등 고객과 공유할 주요 시점을 마일스톤으로 추가합니다.', '마일스톤은 일정 상태를 판단하는 기준점입니다.', act('마일스톤 추가', u('/wbs?new=1&type=MILESTONE')), nextPhase ? act(`${nextPhase.name} 단계로 이동`, u('?move=next')) : null, nextPhaseText);
      return out('WBS_DONE', '실행 계획이 준비되었습니다', '실행 단계로 이동해 진행 현황과 이슈를 관리하세요.', '실행 단계에서는 지연 작업, Issue, 변경 요청을 중심으로 안내합니다.', nextPhase ? act(`${nextPhase.name} 단계로 이동`, u('?move=next')) : act('WBS 보기', u('/wbs')), act('WBS 보기', u('/wbs')), nextPhaseText);
    }
    case 'EXECUTION': {
      if (n(iss.blocked)) return out('EXEC_BLOCKED', 'Blocker를 확인하세요', `차단 상태 Issue ${iss.blocked}건이 진행을 막고 있습니다.`, '차단된 작업을 풀지 않으면 일정 전체가 밀립니다.', act('Blocked Issue 보기', u('/issues?status=BLOCKED')), act('WBS 보기', u('/wbs')), '진행 현황과 지연 작업을 확인합니다.');
      if (n(overdue_tasks)) return out('EXEC_OVERDUE', '지연 작업을 확인하세요', `종료 예정일이 지난 작업 ${overdue_tasks}건이 있습니다.`, '지연 원인과 대응책을 정해야 일정 영향을 줄일 수 있습니다.', act('지연 작업 보기', u('/wbs?f=overdue')), act('Issue 등록', u('/issues?new=1')), '지연이 정리되면 진행률을 갱신합니다.');
      if (n(iss.critical)) return out('EXEC_CRITICAL', 'Critical Issue를 처리하세요', `Critical Issue ${iss.critical}건이 열려 있습니다.`, 'Critical Issue는 범위·일정·품질에 직접 영향을 줍니다.', act('Critical Issue 보기', u('/issues?severity=CRITICAL')), null, '이슈가 정리되면 진행 현황을 확인합니다.');
      if (n(chg.under_review)) return out('EXEC_CHANGE', '검토 중인 변경 요청을 결정하세요', `검토 중 변경 요청 ${chg.under_review}건이 결정을 기다립니다.`, '승인·반려가 늦어지면 범위와 일정이 불명확해집니다.', act('변경 요청 보기', u('/changes?status=UNDER_REVIEW')), null, '변경이 결정되면 WBS 영향에 반영합니다.');
      if (n(wbs.tasks) === 0) return out('EXEC_NO_WBS', '실행 작업(WBS)이 없습니다', '실행 단계이지만 등록된 작업이 없습니다. WBS를 만들어 진행 현황을 관리하세요.', '작업이 있어야 진행률과 지연을 추적할 수 있습니다.', act('WBS 만들기', u('/wbs?new=1')), null, '작업이 준비되면 진행 현황을 갱신합니다.');
      return out('EXEC_STATUS', '작업 진행 현황을 갱신하세요', `진행 중 ${n(wbs.in_progress)}건 · 완료 ${n(wbs.completed)}건 · 진척률 ${n(wbs.progress)}%`, '계획 대비 실제 진행을 주기적으로 기록해야 지연을 조기에 발견할 수 있습니다.', act('WBS 진행률 갱신', u('/wbs')), null, nextPhase ? `구현이 마무리되면 ${nextPhase.name} 단계로 이동합니다.` : null);
    }
    case 'TESTING': {
      if (n(tst.total) === 0) return out('TEST_EMPTY', '테스트 케이스를 작성하세요', '요구사항을 기준으로 무엇을 어떤 기준으로 검증할지 테스트 항목을 만듭니다.', '구현 결과가 요구사항을 충족하는지 검증해야 합니다.', act('테스트 케이스 작성', u('/tests?new=1')), act('Coverage 보기', u('/tests?tab=coverage')), '테스트 실행 결과를 기록합니다.');
      if (n(tst.last_fail)) return out('TEST_FAIL', '실패한 테스트를 확인하세요', `최근 결과가 Fail인 테스트 ${tst.last_fail}건이 있습니다.`, 'Fail은 Issue로 등록해 조치 담당자를 정하고, 조치 후 다시 실행해야 합니다.', act('Fail 테스트 보기', u('/tests?last_result=FAIL')), act('Issue 보기', u('/issues')), '모든 테스트가 Pass하면 검수를 준비합니다.');
      if (n(tst.executed) < n(tst.total)) return out('TEST_RUN', '테스트를 실행하고 결과를 기록하세요', `테스트 ${tst.total}건 중 ${tst.executed}건이 실행되었습니다.`, '실행 결과가 있어야 품질 상태를 판단할 수 있습니다.', act('미실행 테스트 보기', u('/tests?last_result=NOT_RUN')), null, '실행이 끝나면 Fail을 정리합니다.');
      if (n(tst.in_scope_untested)) warnings.push(`테스트가 연결되지 않은 범위 내 요구사항 ${tst.in_scope_untested}건`);
      return out('TEST_DONE', '테스트가 모두 통과했습니다', '검수 단계로 이동해 고객 검수를 준비하세요.', '검수는 고객이 요구사항 충족 여부를 직접 확인하는 절차입니다.', nextPhase ? act(`${nextPhase.name} 단계로 이동`, u('?move=next')) : act('Tests 보기', u('/tests')), act('Tests 보기', u('/tests')), nextPhaseText);
    }
    case 'ACCEPTANCE': {
      if (n(acc.total) === 0) return out('ACC_EMPTY', '검수 항목을 작성하세요', '검수 대상 요구사항과 테스트를 묶어 고객에게 검수를 요청할 항목을 만듭니다.', '검수 범위와 기준을 고객과 먼저 합의해야 결과를 확정할 수 있습니다.', act('검수 항목 작성', u('/tests?tab=acceptance&new=1')), null, '검수를 요청하고 결과를 기록합니다.');
      if (n(acc.rework)) return out('ACC_REWORK', '보완 요청된 검수를 처리하세요', `보완 필요 ${acc.rework}건이 있습니다.`, '보완 후 재요청해야 검수를 확정할 수 있습니다.', act('보완 필요 검수 보기', u('/tests?tab=acceptance&status=REWORK_REQUIRED')), null, '모든 검수가 승인되면 검수 결과를 확정합니다.');
      if (n(acc.requested)) return out('ACC_PENDING', '검수를 진행하세요', `검수 요청 ${acc.requested}건이 고객 확인을 기다립니다.`, '검수 결과(승인/반려/보완)를 기록해야 미완료 항목을 정리할 수 있습니다.', act('진행 중 검수 보기', u('/tests?tab=acceptance&status=REQUESTED')), null, '검수가 모두 승인되면 오픈을 준비합니다.');
      if (n(acc.draft)) return out('ACC_DRAFT', '작성 중인 검수를 요청하세요', `작성 중 검수 ${acc.draft}건이 있습니다. 준비가 되면 고객에게 검수를 요청하세요.`, '검수 요청이 있어야 고객 확인 절차가 시작됩니다.', act('작성 중 검수 보기', u('/tests?tab=acceptance&status=DRAFT')), null, '검수 결과를 기록합니다.');
      return out('ACC_DONE', '검수가 완료되었습니다', '오픈 단계로 이동해 서비스 오픈과 안정화를 준비하세요.', '검수 확정 후 오픈 준비(운영 이관, 사용자 안내)를 진행합니다.', nextPhase ? act(`${nextPhase.name} 단계로 이동`, u('?move=next')) : act('검수 보기', u('/tests?tab=acceptance')), act('검수 보기', u('/tests?tab=acceptance')), nextPhaseText);
    }
    case 'LAUNCH': {
      const open = [];
      if (n(iss.active)) open.push(`Open Issue ${iss.active}건`);
      if (n(tst.last_fail)) open.push(`Fail 테스트 ${tst.last_fail}건`);
      if (n(acc.requested) + n(acc.rework)) open.push(`미완료 검수 ${n(acc.requested) + n(acc.rework)}건`);
      if (n(chg.approved_unimplemented)) open.push(`미반영 변경 ${chg.approved_unimplemented}건`);
      if (open.length) return out('LAUNCH_OPEN', '오픈 전 미완료 항목을 확인하세요', open.join(' · '), '남은 항목을 정리하거나 운영 이관 항목으로 기록해야 안정적으로 종료할 수 있습니다.', act(n(iss.active) ? 'Open Issue 보기' : n(acc.requested) + n(acc.rework) ? '검수 보기' : '확인하기', u(n(iss.active) ? '/issues' : n(acc.requested) + n(acc.rework) ? '/tests?tab=acceptance' : '')), act('오픈 단계 기록', u('/phases/LAUNCH')), '정리가 끝나면 프로젝트를 마무리합니다.');
      return out('LAUNCH_DONE', '프로젝트를 마무리하세요', '오픈 단계의 할 일을 기록하고 종료 사항을 정리합니다.', '종료 정리(결과 공유, 운영 이관)를 남겨야 다음 프로젝트에서 재사용할 수 있습니다.', act('오픈 단계 기록', u('/phases/LAUNCH')), null, null);
    }
    default:
      return out('UNKNOWN', 'What’s Next?', '', '', act('What’s Next?', u('')), null, null);
  }
}
