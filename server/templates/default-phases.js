/**
 * RELAI Project Lifecycle V2 — 7 phases, each with its activities.
 *
 *   Project → Lifecycle Phase → Activities
 *
 * Phase keys are the `projects.current_phase` / `project_phases.phase_key` values. Activity rows are copied into
 * `project_steps` per project (step_key, importance, texts); their *state* is mostly derived from live project data
 * (server/activities.js) — the stored status only records a manual 완료 처리 / 제외.
 *
 * importance: REQUIRED (gate for moving on) · RECOMMENDED · OPTIONAL
 * feature:    which work screen the activity is done in (requirements | wbs | tests | acceptance | issues | changes | definition)
 */
/** 05 TEST_PLAN (Phase 5 US-1): 필수 — every in-scope confirmed requirement has a test or a 테스트 제외 사유. Migration 36 copies these into existing projects. */
export const TEST_PLAN_TITLE = '요구사항별 테스트 준비';
export const TEST_PLAN_DESCRIPTION = '범위 내 확정 요구사항마다 테스트를 연결합니다. 테스트 대신 다른 방법으로 확인한다면 제외 사유를 남깁니다.';
export const TEST_PLAN_CRITERIA = '범위 내 요구사항이 모두 테스트와 연결되었거나 제외 사유가 있습니다.';
/** 06 ACCEPTANCE (Phase 6 US-2): 완료 = 범위 내 확정 요구사항이 모두 승인된 검수에 들어 있음. Migration 37 copies these into existing projects. */
export const ACCEPTANCE_DESCRIPTION = '범위 내 확정 요구사항을 검수에 묶어 고객 검수를 요청하고, 고객 승인(누가·언제·어떻게)을 기록합니다. 1차·2차로 나눠도 합계로 판단합니다.';
export const ACCEPTANCE_CRITERIA = '범위 내 확정 요구사항이 모두 승인된 검수에 들어 있습니다.';
/* Phase 7 (migration 38): 07 운영 및 유지보수 copy */
export const OPERATIONS_DESCRIPTION = '운영 조직에 인수인계하고, 완료보고서로 결과를 정리한 뒤 프로젝트를 종료합니다.';
export const HANDOVER_CRITERIA = '인수자와 인수일이 기록되어 있습니다.';
export const MAINTENANCE_DESCRIPTION = '장애·요청 접수 경로와 처리 절차를 정합니다. 하자보수 기간의 요청 접수 경로도 함께 정합니다.';
export const SLA_DESCRIPTION = '운영 계약이 있으면 — 응답·복구 시간 등 서비스 수준 기준을 확인합니다.';
export const RELEASE_PLAN_DESCRIPTION = '운영 계약이 있으면 — 개선 요청을 모아 배포하는 주기와 절차를 정합니다.';
export const CLOSE_DESCRIPTION = '결과·계획 대비 차이·남은 일·교훈을 완료보고서로 정리해 고객과 회사에 보고합니다.';
export const CLOSE_CRITERIA = '완료보고서가 확정되어 있습니다.';
export const LESSONS_ITEM_V1 = '교훈(Lessons Learned) 정리';
export const LESSONS_ITEM = '교훈 정리';
export const DEFAULT_TEMPLATE_KEY = 'LIFECYCLE_V2';

export const IMPORTANCE = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
export const IMPORTANCE_LABEL = { REQUIRED: '필수', RECOMMENDED: '권장', OPTIONAL: '선택' };
/** 착수보고회(KICKOFF) importance — one constant so it can flip to REQUIRED (spec Phase 1 D1/Q1). Migration 31 copies it into existing projects. */
export const KICKOFF_IMPORTANCE = 'RECOMMENDED';
/** 착수 결과 승인(APPROVAL) importance (batch7 #5): 권장 — RELAI is not a customer-shared tool, so an internal project or a startup is never
 * held at 01 waiting for a signature. Migration 49 copies it into existing projects' open APPROVAL steps. 02 요구사항 확정 승인 stays 필수. */
export const APPROVAL_IMPORTANCE = 'RECOMMENDED';

/** 03 분석·설계 phase description; the last sentence is Phase 3 US-6 (migration 33 copies it into existing projects). */
export const ANALYSIS_DESIGN_DESCRIPTION_V1 = '요구사항의 “무엇”을 실행 가능한 “어떻게”로 구체화하고, 요구사항 기반 WBS와 실행 계획을 세웁니다.';
export const ANALYSIS_DESIGN_DESCRIPTION = `${ANALYSIS_DESIGN_DESCRIPTION_V1} 화면·DB·인터페이스 설계도 WBS 작업으로 넣어 관리하세요.`;

const A = (key, title, description, criteria, importance = 'REQUIRED', feature = null) =>
  ({ key, title, description, completion_criteria: criteria, importance, is_required: importance === 'REQUIRED' ? 1 : 0, linked_feature_type: feature });

export const DEFAULT_PHASES = [
  {
    key: 'INITIATION', name: '착수', short: '착수', en: 'Initiation',
    description: '프로젝트의 목표, 범위, 관계자, 상위 일정, 운영 방식을 정리해 출발 기준을 맞춥니다.',
    steps: [
      A('GOALS', '프로젝트 목표 정의', '프로젝트를 통해 달성해야 할 목표와 성공 기준을 정리합니다.', '목표 또는 성공 기준이 1개 이상 작성되어 있습니다.', 'REQUIRED', 'definition'),
      A('SCOPE', '수행 범위 · 적용 환경 정리', '결과물이 돌아가야 할 기기·브라우저·OS 같은 적용 환경과 환경·조건을 정리합니다. 기능 범위는 요구사항에서 관리합니다.', '지원 환경이 1개 이상 선택되어 있습니다.', 'REQUIRED', 'definition'),
      A('STAKEHOLDERS', '관계자 / 조직 확인', '고객사, 수행사, 협력사의 주요 담당자와 역할을 정리합니다.', '관계자가 1명 이상 등록되어 있습니다.', 'REQUIRED', 'definition'),
      A('MILESTONES', '상위 일정 / 마일스톤 확인', '프로젝트 시작일·종료 예정일과 반드시 지켜야 하는 주요 시점을 정리합니다. WBS의 세부 일정과는 구분되는 프로젝트 수준의 개략 일정입니다.', '주요 일정 또는 마일스톤이 1개 이상 작성되어 있습니다.', 'REQUIRED', 'definition'),
      A('OPERATIONS', '프로젝트 운영 방식 확인', '회의, 보고, 의사결정, 커뮤니케이션 방식을 정합니다.', '운영 방식 항목이 작성되어 있습니다.', 'RECOMMENDED', 'definition'),
      A('KICKOFF', '착수보고회 준비·개최', '고객과 수행팀이 목표·범위·일정을 처음 공식적으로 확인하는 착수보고회를 준비하고 결과를 기록합니다.', '착수보고회가 열렸고 회의록 요약 또는 결정사항이 기록되어 있습니다.', KICKOFF_IMPORTANCE, 'definition'),
      A('APPROVAL', '착수 결과 승인(고객·스폰서)', '정리한 목표·범위·일정·추진 조직을 고객이나 스폰서에게 승인받고 그 근거를 남깁니다.', '승인자·승인일·승인 방법·근거가 기록되어 있습니다.', APPROVAL_IMPORTANCE, 'definition'),
    ],
  },
  {
    key: 'REQUIREMENTS', name: '요구사항 정의', short: '요구사항', en: 'Requirements Definition',
    description: '무엇을 만들어야 하는지 수집하고 정리해 고객과 합의한 요구사항을 확정합니다.',
    steps: [
      A('COLLECT', '요구사항 수집', '계약서, 제안서, 현업·고객 요청에서 요구사항을 모아 등록합니다. 직접 입력, Excel 가져오기, AI 추출을 사용할 수 있습니다.', '요구사항이 1건 이상 등록되어 있습니다.', 'REQUIRED', 'requirements'),
      A('CLASSIFY', '요구사항 분류', '기능, 비기능, 인터페이스, 데이터, 보안 등 성격에 따라 요구사항 유형을 지정합니다.', '모든 요구사항에 유형이 지정되어 있습니다.', 'REQUIRED', 'requirements'),
      A('PRIORITIZE', '우선순위 설정', '반드시 필요한 것과 있으면 좋은 것을 구분해 우선순위를 정합니다.', '모든 요구사항에 우선순위가 지정되어 있습니다.', 'RECOMMENDED', 'requirements'),
      A('SCOPE_CHECK', '범위 확정', '각 요구사항이 이번 범위 안에 있는지 결정하고, 범위 밖 항목은 별도로 표시합니다.', '범위가 결정되지 않은 요구사항이 없습니다.', 'REQUIRED', 'requirements'),
      A('CONFIRM', '요구사항 확정', '정리된 요구사항을 고객과 확인하고 확정합니다. 확정 이후의 변경은 변경 요청으로 관리합니다.', '범위 내 요구사항이 모두 확정 상태입니다.', 'REQUIRED', 'requirements'),
      A('BASELINE_APPROVAL', '요구사항 확정 승인(고객)', '확정한 요구사항을 고객에게 보내 승인받고 그 근거를 남깁니다. 승인된 요구사항이 이후 설계·개발·검수의 기준이 됩니다.', '승인자·승인일·방법·근거가 기록되어 있습니다.', 'REQUIRED', 'requirements'),
      A('INTERFACE', '인터페이스 · 데이터 · 보안 요구사항 정리', '외부 연계, 데이터, 보안, 인프라 등 비기능 영역의 요구사항을 별도로 확인합니다.', '인터페이스·데이터·보안 유형의 요구사항이 정리되어 있습니다.', 'OPTIONAL', 'requirements'),
    ],
  },
  {
    key: 'ANALYSIS_DESIGN', name: '분석·설계', short: '분석·설계', en: 'Analysis & Design',
    description: ANALYSIS_DESIGN_DESCRIPTION,
    steps: [
      A('WBS_BUILD', 'WBS 작성', '확정된 요구사항을 실제 작업 단위로 나눕니다. 직접 추가, Excel 가져오기, AI WBS 초안 생성을 사용할 수 있습니다.', '실행 작업(WBS)이 1건 이상 등록되어 있습니다.', 'REQUIRED', 'wbs'),
      A('REQ_TRACE', '요구사항–WBS 연결', '범위 내 요구사항마다 이를 구현하는 작업을 연결해 누락된 요구사항이 없는지 확인합니다.', '범위 내 요구사항이 모두 WBS와 연결되어 있습니다.', 'REQUIRED', 'wbs'),
      A('ASSIGN', '담당자 지정', '각 작업을 누가 맡을지 정합니다.', '모든 실행 작업에 담당자가 지정되어 있습니다.', 'REQUIRED', 'wbs'),
      A('PLAN', '일정 입력', '작업별 시작일과 종료일을 정해 작업 수준의 세부 일정을 만듭니다.', '모든 실행 작업에 계획 일정이 입력되어 있습니다.', 'REQUIRED', 'wbs'),
      A('ORDER', '선후관계 설정', '먼저 끝나야 하는 작업과 동시에 할 수 있는 작업을 구분합니다.', '작업 간 선후관계가 1건 이상 설정되어 있습니다.', 'RECOMMENDED', 'wbs'),
      A('MILESTONES', '마일스톤 등록', '중간 점검, 테스트 시작, 검수, 오픈 등 고객과 공유할 주요 시점을 마일스톤으로 등록합니다.', '마일스톤이 1건 이상 등록되어 있습니다.', 'RECOMMENDED', 'wbs'),
      A('NON_DEV_TASKS', '기능 개발 외 작업 확인', '인프라, 데이터 이관, 교육, 전환, 테스트처럼 기능 개발이 아닌 작업이 WBS에 포함되어 있는지 확인합니다.', '시험·전환·운영 단계에 해당하는 작업이 WBS에 포함되어 있습니다.', 'RECOMMENDED', 'wbs'),   // Phase 3 US-2: 선택 → 권장 (migration 33)
    ],
  },
  {
    key: 'DEVELOPMENT', name: '구현', short: '구현', en: 'Development',
    description: '실행 계획에 따라 작업을 진행하면서 진척, 지연, 이슈, 변경을 놓치지 않고 관리합니다.',
    steps: [
      A('PROGRESS', '구현 작업 진행 관리', '구현 작업의 상태와 진척률을 주기적으로 갱신합니다.', '구현 작업이 모두 완료되었습니다.', 'REQUIRED', 'wbs'),
      A('DELAYS', '지연 작업 대응', '종료 예정일이 지난 작업을 찾아 원인과 대응책을 정합니다.', '종료 예정일이 지난 미완료 작업이 없습니다.', 'REQUIRED', 'wbs'),
      A('ISSUES', '이슈 관리', '진행을 막거나 늦추는 문제를 이슈로 기록하고 처리합니다.', '열려 있는 이슈가 없습니다.', 'REQUIRED', 'issues'),
      A('CHANGES', '변경 요청 관리', '요구사항·범위 변경 요청을 기록하고 영향도를 정리해 결정합니다.', '검토 중이거나 승인 후 미반영된 변경 요청이 없습니다.', 'RECOMMENDED', 'changes'),
      A('WEEKLY_REPORT', '주간보고 작성·공유', '매주 진행·지연·이슈·변경을 정리해 고객에게 보냅니다. 데이터로 초안이 만들어집니다.', '이번 주 주간보고가 확정되어 있습니다.', 'RECOMMENDED', 'reports'),   // Phase 4 US-3 (migration 35)
      A('DECISIONS', '주요 의사결정 기록', '프로젝트 방향에 영향을 주는 결정을 기록해 둡니다.', '주요 의사결정이 1건 이상 기록되어 있습니다.', 'OPTIONAL', null),
    ],
  },
  {
    key: 'TESTING', name: '시험', short: '시험', en: 'Testing',
    description: '요구사항이 실제 시스템에 올바르게 구현되었는지 테스트로 검증하고 결함을 조치합니다.',
    steps: [
      A('TEST_PLAN', TEST_PLAN_TITLE, TEST_PLAN_DESCRIPTION, TEST_PLAN_CRITERIA, 'REQUIRED', 'tests'),   // Phase 5 US-1 (migration 36)
      A('CASES', '테스트 케이스 작성', '요구사항을 기준으로 테스트 케이스를 준비합니다.', '테스트 케이스가 1건 이상 등록되어 있습니다.', 'REQUIRED', 'tests'),
      A('RUN', '테스트 수행', '준비한 케이스대로 테스트를 실행하고 결과(통과/실패/막힘)를 기록합니다.', '모든 테스트 케이스가 실행되었습니다.', 'REQUIRED', 'tests'),
      A('DEFECTS', '결함 조치', '실패한 테스트를 이슈로 등록해 조치하고, 조치 후 다시 실행해 통과로 바꿉니다.', '최근 결과가 실패인 테스트가 없고, 테스트에서 등록한 이슈가 모두 해결되었습니다.', 'REQUIRED', 'tests'),   // Phase 5 US-2
      A('WEEKLY_REPORT', '주간보고 작성·공유', '매주 진행·지연·이슈·변경을 정리해 고객에게 보냅니다. 데이터로 초안이 만들어집니다.', '이번 주 주간보고가 확정되어 있습니다.', 'RECOMMENDED', 'reports'),   // Phase 5 US-6 (migration 36)
      A('NON_FUNCTIONAL', '성능 · 보안 테스트', '성능, 보안, 데이터 이관 검증 등 비기능 테스트를 수행합니다.', '비기능 테스트 결과가 기록되어 있습니다.', 'OPTIONAL', 'tests'),
    ],
  },
  {
    key: 'TRANSITION_GO_LIVE', name: '전환 및 오픈', short: '전환·오픈', en: 'Transition & Go-Live',
    description: '검수로 인수 승인을 받고, 전환 계획·데이터 이관·교육을 거쳐 서비스를 오픈하고 안정화합니다.',
    steps: [
      A('ACCEPTANCE', '검수 / 인수 승인', ACCEPTANCE_DESCRIPTION, ACCEPTANCE_CRITERIA, 'REQUIRED', 'acceptance'),   // Phase 6 US-2 (migration 37)
      A('CUTOVER_PLAN', '전환 계획 수립', '운영 환경 전환 순서, 일정, 담당, 롤백 기준을 정리합니다.', '전환 계획이 정리되어 있습니다.', 'REQUIRED', null),
      A('DATA_MIGRATION', '데이터 이관', '이관 대상 데이터의 매핑, 리허설, 본 이관과 검증을 수행합니다.', '데이터 이관과 검증이 완료되어 있습니다.', 'OPTIONAL', null),
      A('TRAINING', '사용자 교육 / 매뉴얼', '사용자와 운영자에게 안내 자료를 전달하고 필요한 교육을 진행합니다.', '교육 또는 매뉴얼 전달이 완료되어 있습니다.', 'RECOMMENDED', null),
      A('WEEKLY_REPORT', '주간보고 작성·공유', '매주 진행·지연·이슈·변경을 정리해 고객에게 보냅니다. 데이터로 초안이 만들어집니다.', '이번 주 주간보고가 확정되어 있습니다.', 'RECOMMENDED', 'reports'),   // Phase 6 US-5 (migration 37)
      A('GO_LIVE', '오픈', '계획한 시점에 서비스를 오픈합니다. 오픈 전 열린 이슈, 실패 테스트, 미반영 변경을 확인합니다.', '서비스가 오픈되어 사용자가 접근할 수 있습니다.', 'REQUIRED', null),
      A('STABILIZE', '안정화', '오픈 후 문제를 모니터링하고 긴급 조치 사항을 정리합니다.', '안정화 기간의 이슈가 정리되어 있습니다.', 'RECOMMENDED', 'issues'),
    ],
  },
  {
    key: 'OPERATIONS', name: '운영 및 유지보수', short: '운영', en: 'Operations & Maintenance',
    description: OPERATIONS_DESCRIPTION,
    steps: [
      A('HANDOVER', '운영 이관 / 인수인계', '운영 매뉴얼, 계정, 모니터링, 담당자를 운영 조직에 인수인계합니다.', HANDOVER_CRITERIA, 'REQUIRED', null),   // Phase 7 US-3: 인수자·인수일 (migration 38)
      A('MAINTENANCE', '유지보수 체계 확인', MAINTENANCE_DESCRIPTION, '유지보수 접수·처리 절차가 정리되어 있습니다.', 'RECOMMENDED', null),
      A('SLA', 'SLA 확인', SLA_DESCRIPTION, 'SLA 기준이 정리되어 있습니다.', 'OPTIONAL', null),
      A('RELEASE_PLAN', '정기 배포 계획', RELEASE_PLAN_DESCRIPTION, '정기 배포 계획이 정리되어 있습니다.', 'OPTIONAL', null),
      A('CLOSE', '프로젝트 종료 정리', CLOSE_DESCRIPTION, CLOSE_CRITERIA, 'REQUIRED', null),   // Phase 7 US-1: 완료 = 완료보고서 확정 (migration 38)
    ],
  },
];

export const PHASE_KEYS = DEFAULT_PHASES.map((p) => p.key);
export const PHASE_BY_KEY = Object.fromEntries(DEFAULT_PHASES.map((p) => [p.key, p]));

/**
 * Checklist activities (06 전환·오픈 · 07 운영): activities with no dedicated work screen are worked through a per-activity
 * checklist (activity_checklist_items: item · 담당 · 기한 · 완료 · 메모). Their state derives from it (activities.js):
 * no items → stored mark/memo only · some open → 진행 중 · all done → 완료. Keys are the suggested starter items
 * ("기본 항목 추가"); the team edits, adds or deletes freely.
 */
export const CHECKLIST_TEMPLATES = {
  CUTOVER_PLAN: ['전환 대상 시스템·범위 확정', '전환 일정과 작업 순서 작성', '전환 담당자와 연락 체계 지정', '롤백 기준과 절차 정의', '전환 리허설 수행'],
  DATA_MIGRATION: ['이관 대상 데이터와 매핑 정의', '이관 리허설과 결과 검증', '본 이관 수행', '이관 데이터 건수·정합성 검증'],
  TRAINING: ['사용자 매뉴얼 작성·전달', '운영자 매뉴얼 작성·전달', '사용자 교육 실시', '교육 참석·질의 결과 정리'],
  GO_LIVE: ['오픈 전 열린 이슈·실패 테스트 확인', '운영 환경 배포 완료', '오픈 공지 발송', '오픈 후 주요 기능 점검'],
  STABILIZE: ['안정화 기간과 모니터링 담당 지정', '오픈 후 장애·문의 접수 및 조치', '긴급 조치 사항 정리'],
  HANDOVER: ['운영 매뉴얼 인계', '계정·권한 인계', '모니터링·알림 체계 인계', '운영 담당자 지정 및 인수 확인'],
  MAINTENANCE: ['장애·요청 접수 경로 확정', '처리 절차와 에스컬레이션 정의', '유지보수 계약·범위 확인'],
  SLA: ['응답 시간 기준 합의', '복구 시간 기준 합의', 'SLA 측정·보고 방식 정의'],
  RELEASE_PLAN: ['정기 배포 주기 확정', '개선 요청 수집·우선순위 절차 정의', '배포 승인·공지 절차 정의'],
  DECISIONS: [],   // F6: 04 의사결정 기록 = a decision log on the same screen (결정일 · 결정 내용 · 결정자 · 메모); no starter items
  CLOSE: ['프로젝트 결과 공유(완료 보고)', '미결 사항과 후속 조치 정리', LESSONS_ITEM, '산출물 최종본 전달'],
};
export const CHECKLIST_STEP_KEYS = new Set(Object.keys(CHECKLIST_TEMPLATES));
