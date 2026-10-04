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
export const DEFAULT_TEMPLATE_KEY = 'LIFECYCLE_V2';

export const IMPORTANCE = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
export const IMPORTANCE_LABEL = { REQUIRED: '필수', RECOMMENDED: '권장', OPTIONAL: '선택' };

const A = (key, title, description, criteria, importance = 'REQUIRED', feature = null) =>
  ({ key, title, description, completion_criteria: criteria, importance, is_required: importance === 'REQUIRED' ? 1 : 0, linked_feature_type: feature });

export const DEFAULT_PHASES = [
  {
    key: 'INITIATION', name: '착수', short: '착수', en: 'Initiation',
    description: '프로젝트의 목표, 범위, 이해관계자, 상위 일정, 운영 방식을 정리해 출발 기준을 맞춥니다.',
    steps: [
      A('GOALS', '프로젝트 목표 정의', '프로젝트를 통해 달성해야 할 목표와 성공 기준을 정리합니다.', '목표 또는 성공 기준이 1개 이상 작성되어 있습니다.', 'REQUIRED', 'definition'),
      A('SCOPE', '프로젝트 범위 정리', '이번 프로젝트에서 수행할 범위와 수행하지 않을 범위를 구분합니다.', '수행 범위가 1개 이상 작성되어 있습니다.', 'REQUIRED', 'definition'),
      A('STAKEHOLDERS', '이해관계자 / 조직 확인', '고객사, 수행사, 협력사의 주요 담당자와 역할을 정리합니다.', '이해관계자가 1명 이상 등록되어 있습니다.', 'REQUIRED', 'definition'),
      A('MILESTONES', '상위 일정 / 마일스톤 확인', '프로젝트 시작일·종료 예정일과 반드시 지켜야 하는 주요 시점을 정리합니다. WBS의 세부 일정과는 구분되는 프로젝트 수준의 개략 일정입니다.', '주요 일정 또는 마일스톤이 1개 이상 작성되어 있습니다.', 'REQUIRED', 'definition'),
      A('OPERATIONS', '프로젝트 운영 방식 확인', '회의, 보고, 의사결정, 커뮤니케이션 방식을 정합니다.', '운영 방식 항목이 작성되어 있습니다.', 'RECOMMENDED', 'definition'),
    ],
  },
  {
    key: 'REQUIREMENTS', name: '요구사항 정의', short: '요구사항', en: 'Requirements Definition',
    description: '무엇을 만들어야 하는지 수집하고 정리해 고객과 합의된 요구사항 기준선을 만듭니다.',
    steps: [
      A('COLLECT', '요구사항 수집', '계약서, 제안서, 현업·고객 요청에서 요구사항을 모아 등록합니다. 직접 입력, Excel Import, AI 추출을 사용할 수 있습니다.', '요구사항이 1건 이상 등록되어 있습니다.', 'REQUIRED', 'requirements'),
      A('CLASSIFY', '요구사항 분류', '기능, 비기능, 인터페이스, 데이터, 보안 등 성격에 따라 요구사항 유형을 지정합니다.', '모든 요구사항에 유형이 지정되어 있습니다.', 'REQUIRED', 'requirements'),
      A('PRIORITIZE', '우선순위 설정', '반드시 필요한 것과 있으면 좋은 것을 구분해 우선순위를 정합니다.', '모든 요구사항에 우선순위가 지정되어 있습니다.', 'RECOMMENDED', 'requirements'),
      A('SCOPE_CHECK', '범위 확정', '각 요구사항이 이번 범위 안에 있는지 결정하고, 범위 밖 항목은 별도로 표시합니다.', '범위가 결정되지 않은 요구사항이 없습니다.', 'REQUIRED', 'requirements'),
      A('CONFIRM', '요구사항 확정', '정리된 요구사항을 고객과 확인하고 기준선으로 확정합니다. 확정 이후의 변경은 변경 요청으로 관리합니다.', '범위 내 요구사항이 모두 확정 상태입니다.', 'REQUIRED', 'requirements'),
      A('INTERFACE', '인터페이스 · 데이터 · 보안 요구사항 정리', '외부 연계, 데이터, 보안, 인프라 등 비기능 영역의 요구사항을 별도로 확인합니다.', '인터페이스·데이터·보안 유형의 요구사항이 정리되어 있습니다.', 'OPTIONAL', 'requirements'),
    ],
  },
  {
    key: 'ANALYSIS_DESIGN', name: '분석·설계', short: '분석·설계', en: 'Analysis & Design',
    description: '요구사항의 “무엇”을 실행 가능한 “어떻게”로 구체화하고, 요구사항 기반 WBS와 실행 계획을 세웁니다.',
    steps: [
      A('WBS_BUILD', 'WBS 작성', '확정된 요구사항을 실제 작업 단위로 나눕니다. 직접 추가, Excel Import, AI WBS 초안 생성을 사용할 수 있습니다.', '실행 작업(WBS Task)이 1건 이상 등록되어 있습니다.', 'REQUIRED', 'wbs'),
      A('REQ_TRACE', 'Requirements ↔ WBS 연결', '범위 내 요구사항마다 이를 구현하는 작업을 연결해 누락된 요구사항이 없는지 확인합니다.', '범위 내 요구사항이 모두 WBS와 연결되어 있습니다.', 'REQUIRED', 'wbs'),
      A('ASSIGN', '담당자 지정', '각 작업을 누가 맡을지 정합니다.', '모든 실행 작업에 담당자가 지정되어 있습니다.', 'REQUIRED', 'wbs'),
      A('PLAN', '일정 입력', '작업별 시작일과 종료일을 정해 Task 수준의 세부 일정을 만듭니다.', '모든 실행 작업에 계획 일정이 입력되어 있습니다.', 'REQUIRED', 'wbs'),
      A('ORDER', '선후관계 설정', '먼저 끝나야 하는 작업과 동시에 할 수 있는 작업을 구분합니다.', '작업 간 선후관계가 1건 이상 설정되어 있습니다.', 'RECOMMENDED', 'wbs'),
      A('MILESTONES', '마일스톤 등록', '중간 점검, 테스트 시작, 검수, 오픈 등 고객과 공유할 주요 시점을 마일스톤으로 등록합니다.', '마일스톤이 1건 이상 등록되어 있습니다.', 'RECOMMENDED', 'wbs'),
      A('NON_DEV_TASKS', '기능 개발 외 작업 확인', '인프라, 데이터 마이그레이션, 교육, 전환, 테스트처럼 기능 개발이 아닌 작업이 WBS에 포함되어 있는지 확인합니다.', '시험·전환·운영 단계에 해당하는 작업이 WBS에 포함되어 있습니다.', 'OPTIONAL', 'wbs'),
    ],
  },
  {
    key: 'DEVELOPMENT', name: '구현', short: '구현', en: 'Development',
    description: '실행 계획에 따라 작업을 진행하면서 진척, 지연, 이슈, 변경을 놓치지 않고 관리합니다.',
    steps: [
      A('PROGRESS', '구현 작업 진행 관리', '구현 작업의 상태와 진척률을 주기적으로 갱신합니다.', '구현 작업이 모두 완료되었습니다.', 'REQUIRED', 'wbs'),
      A('DELAYS', '지연 작업 대응', '종료 예정일이 지난 작업을 찾아 원인과 대응책을 정합니다.', '종료 예정일이 지난 미완료 작업이 없습니다.', 'REQUIRED', 'wbs'),
      A('ISSUES', '이슈 관리', '진행을 막거나 늦추는 문제를 Issue로 기록하고 처리합니다.', '열려 있는 Issue가 없습니다.', 'REQUIRED', 'issues'),
      A('CHANGES', '변경 요청 관리', '요구사항·범위 변경 요청을 기록하고 영향도를 정리해 결정합니다.', '검토 중이거나 승인 후 미반영된 변경 요청이 없습니다.', 'RECOMMENDED', 'changes'),
      A('DECISIONS', '주요 의사결정 기록', '프로젝트 방향에 영향을 주는 결정을 기록해 둡니다.', '주요 의사결정이 메모로 기록되어 있습니다.', 'OPTIONAL', null),
    ],
  },
  {
    key: 'TESTING', name: '시험', short: '시험', en: 'Testing',
    description: '요구사항이 실제 시스템에 올바르게 구현되었는지 테스트로 검증하고 결함을 조치합니다.',
    steps: [
      A('TEST_PLAN', '테스트 범위 정의', '범위 내 요구사항을 기준으로 무엇을 어떤 기준으로 검증할지 정합니다.', '범위 내 요구사항이 모두 테스트와 연결되어 있습니다.', 'RECOMMENDED', 'tests'),
      A('CASES', '테스트 케이스 작성', '요구사항을 기준으로 테스트 케이스를 준비합니다.', '테스트 케이스가 1건 이상 등록되어 있습니다.', 'REQUIRED', 'tests'),
      A('RUN', '테스트 수행', '준비한 케이스대로 테스트를 실행하고 결과(Pass/Fail/Blocked)를 기록합니다.', '모든 테스트 케이스가 실행되었습니다.', 'REQUIRED', 'tests'),
      A('DEFECTS', '결함 조치', 'Fail 테스트를 Issue로 등록해 조치하고, 조치 후 다시 실행해 Pass로 바꿉니다.', '최근 결과가 Fail인 테스트가 없습니다.', 'REQUIRED', 'tests'),
      A('NON_FUNCTIONAL', '성능 · 보안 테스트', '성능, 보안, 마이그레이션 검증 등 비기능 테스트를 수행합니다.', '비기능 테스트 결과가 기록되어 있습니다.', 'OPTIONAL', 'tests'),
    ],
  },
  {
    key: 'TRANSITION_GO_LIVE', name: '전환 및 오픈', short: '전환·오픈', en: 'Transition & Go-Live',
    description: '검수로 인수 승인을 받고, 전환 계획·데이터 마이그레이션·교육을 거쳐 서비스를 오픈하고 안정화합니다.',
    steps: [
      A('ACCEPTANCE', '검수 / 인수 승인', '검수 대상 요구사항과 테스트를 묶어 고객 검수를 요청하고 승인·보완 결과를 확정합니다. 전환 및 오픈으로 넘어가는 첫 관문입니다.', '검수 항목이 모두 승인되었습니다.', 'REQUIRED', 'acceptance'),
      A('CUTOVER_PLAN', '전환 계획 수립', '운영 환경 전환 순서, 일정, 담당, 롤백 기준을 정리합니다.', '전환 계획이 정리되어 있습니다.', 'REQUIRED', null),
      A('DATA_MIGRATION', '데이터 마이그레이션', '이관 대상 데이터의 매핑, 리허설, 본 이관과 검증을 수행합니다.', '데이터 이관과 검증이 완료되어 있습니다.', 'OPTIONAL', null),
      A('TRAINING', '사용자 교육 / 매뉴얼', '사용자와 운영자에게 안내 자료를 전달하고 필요한 교육을 진행합니다.', '교육 또는 매뉴얼 전달이 완료되어 있습니다.', 'RECOMMENDED', null),
      A('GO_LIVE', 'Go-Live', '계획한 시점에 서비스를 오픈합니다. 오픈 전 열려 있는 Issue, Fail 테스트, 미반영 변경을 확인합니다.', '서비스가 오픈되어 사용자가 접근할 수 있습니다.', 'REQUIRED', null),
      A('STABILIZE', '안정화', '오픈 후 문제를 모니터링하고 긴급 조치 사항을 정리합니다.', '안정화 기간의 이슈가 정리되어 있습니다.', 'RECOMMENDED', 'issues'),
    ],
  },
  {
    key: 'OPERATIONS', name: '운영 및 유지보수', short: '운영', en: 'Operations & Maintenance',
    description: '운영 조직에 이관하고 유지보수 체계, SLA, 정기 배포 계획을 정리해 프로젝트를 마무리합니다.',
    steps: [
      A('HANDOVER', '운영 이관 / 인수인계', '운영 매뉴얼, 계정, 모니터링, 담당자를 운영 조직에 인수인계합니다.', '운영 인수인계가 완료되어 있습니다.', 'REQUIRED', null),
      A('MAINTENANCE', '유지보수 체계 확인', '장애·요청 접수 경로와 처리 절차를 정합니다.', '유지보수 접수·처리 절차가 정리되어 있습니다.', 'RECOMMENDED', null),
      A('SLA', 'SLA 확인', '응답·복구 시간 등 서비스 수준 기준을 확인합니다.', 'SLA 기준이 정리되어 있습니다.', 'OPTIONAL', null),
      A('RELEASE_PLAN', '정기 배포 계획', '개선 요청을 모아 배포하는 주기와 절차를 정합니다.', '정기 배포 계획이 정리되어 있습니다.', 'OPTIONAL', null),
      A('CLOSE', '프로젝트 종료 정리', '결과 공유, 미결 사항, 교훈을 정리하고 프로젝트를 종료합니다.', '종료 정리가 기록되어 있습니다.', 'REQUIRED', null),
    ],
  },
];

export const PHASE_KEYS = DEFAULT_PHASES.map((p) => p.key);
export const PHASE_BY_KEY = Object.fromEntries(DEFAULT_PHASES.map((p) => [p.key, p]));
