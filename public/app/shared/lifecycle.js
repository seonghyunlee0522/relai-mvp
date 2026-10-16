/* Lifecycle V2 information architecture — the one place that says which work screen each lifecycle activity lives in.
 *
 *   PROJECT HOME        What's Next · Overview (+ sub views: 프로젝트 현황 · Project Charter · WBS · 주간보고 · 일정/마일스톤 · Project Health)
 *   PROJECT LIFECYCLE   01 착수 … 07 운영 및 유지보수, each with its work screens
 *   PROJECT MANAGEMENT  Changes · Issues & Risks · Activity · Reports (cross-cutting, not phase-bound)
 *
 * Phase names/order come from the server (project_phases rows = templates/default-phases.js); this file only maps keys to
 * screens. Items with `enabled: false` are part of the IA but have no working screen yet — they are never rendered
 * (no Coming Soon, no dead links). `match(path, qs)` decides the active state; the first match wins. */

/** The 7 lifecycle phases in order, for screens that have no project yet (Home empty state). Same keys/order as
 * server/templates/default-phases.js — server/test/phase1.test.js keeps the two in sync. `label` = the one-line flow wording. */
export const LIFECYCLE_PHASES = [
  { key: 'INITIATION', short: '착수', long: '착수' }, { key: 'REQUIREMENTS', short: '요구사항', long: '요구사항 정의' },
  { key: 'ANALYSIS_DESIGN', short: '분석·설계', long: '분석·설계' }, { key: 'DEVELOPMENT', short: '구현', long: '구현' }, { key: 'TESTING', short: '시험', long: '시험' },
  { key: 'TRANSITION_GO_LIVE', short: '전환·오픈', long: '전환 및 오픈' }, { key: 'OPERATIONS', short: '운영', long: '운영 및 유지보수' },
].map((p) => ({ ...p, label: p.long }));
/** The one phase-name lookup: key → long name (LNB, stepper, Home, auth). `short` only where space requires. */
export const PHASE_NAME = Object.fromEntries(LIFECYCLE_PHASES.map((p) => [p.key, p.long]));
export const PHASE_SHORT = Object.fromEntries(LIFECYCLE_PHASES.map((p) => [p.key, p.short]));

const P = (pid, s = '') => `/app/projects/${pid}${s}`;
const q = (qs, k, v) => (v === undefined ? qs.has(k) : qs.get(k) === v);
/** 분류·우선순위 tab: `?view=classify` (all requirements, Jim B3) or the 미지정 filter that 지금 할 일 links to. */
export const isClassify = (qs) => q(qs, 'view', 'classify') || qs.get('type') === 'UNSPECIFIED' || qs.get('priority') === 'UNSPECIFIED';
const isPath = (path, pid, suffix) => path === P(pid, suffix) || path === `${P(pid, suffix)}/`;
/** 계획 › 프로젝트 정의: one tab (= one address) per 01 착수 task (UI/UX P1-1). 목표 and 범위 share the `goals` tab; the profile
 * (프로젝트 기본 특성) lives on the 개요 tab. Old links (`/definition?activity=KEY&field=F`, still sent by the server) are rewritten by
 * definition.js to `definitionHref(pid, KEY, F)`. */
export const DEFINITION_SLUG = { GOALS: 'goals', SCOPE: 'goals', STAKEHOLDERS: 'stakeholders', MILESTONES: 'milestones', OPERATIONS: 'operations', KICKOFF: 'kickoff', APPROVAL: 'approval' };
/** Tab order (개요 = ''); each slug's tasks in the order they are worked. */
export const DEFINITION_TABS = [['', []], ['goals', ['GOALS', 'SCOPE']], ['stakeholders', ['STAKEHOLDERS']], ['milestones', ['MILESTONES']], ['operations', ['OPERATIONS']], ['kickoff', ['KICKOFF']], ['approval', ['APPROVAL']]];
/** Address of a task's tab; `activity` in the query = the task whose work panel is open (two tasks share the goals tab). */
export const definitionHref = (pid, key = null, field = null) => {
  const slug = key && DEFINITION_SLUG[key];
  const qs = new URLSearchParams();
  if (key && (key === 'PROFILE' || key === 'SCOPE' || field)) qs.set('activity', key);
  if (field) qs.set('field', field);
  return `${P(pid, `/definition${slug ? `/${slug}` : ''}`)}${qs.toString() ? `?${qs}` : ''}`;
};
/** 06/07 activity without its own work screen → its checklist (public/app/project/checklist.js). */
const CL = (pid, key, label, activity) => ({ key, label, href: P(pid, `/checklist?activity=${activity}`), match: (path, qs) => isPath(path, pid, '/checklist') && q(qs, 'activity', activity) });

export const HOME_ITEMS = (pid) => [
  { key: 'next', label: '지금 할 일', href: P(pid), match: (path) => isPath(path, pid, '') },
  { key: 'overview', label: '현황', href: P(pid, '/overview'), match: (path, qs) => isPath(path, pid, '/overview') && !qs.get('ctx'),
    children: [
      { key: 'overview-main', label: '프로젝트 현황', href: P(pid, '/overview'), match: (path, qs) => isPath(path, pid, '/overview') && !location.hash.includes('health') },
      { key: 'overview-charter', label: '프로젝트 개요', href: P(pid, '/charter'), match: (path) => isPath(path, pid, '/charter') },
      { key: 'overview-wbs', label: 'WBS', href: P(pid, '/wbs?ctx=monitor'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'ctx', 'monitor') && !q(qs, 'view', 'gantt') },
      { key: 'overview-reports', label: '주간보고', href: P(pid, '/reports'), match: (path) => path.startsWith(P(pid, '/reports')) },
      { key: 'overview-schedule', label: '일정 / 마일스톤', href: P(pid, '/wbs?ctx=monitor&view=gantt'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'ctx', 'monitor') && q(qs, 'view', 'gantt') },
      { key: 'overview-health', label: '프로젝트 건강도', href: P(pid, '/overview#health'), match: (path) => isPath(path, pid, '/overview') && location.hash === '#health' },
    ] },
];

/** Work screens per lifecycle phase. `enabled:false` = defined in the IA, no screen yet → not rendered. */
export const PHASE_ITEMS = {
  INITIATION: (pid) => [
    { key: 'definition', label: '프로젝트 정의', href: P(pid, '/definition'), match: (path) => isPath(path, pid, '/definition') },
    { key: 'goals-scope', label: '목표 · 범위', href: definitionHref(pid, 'GOALS'), match: (path) => isPath(path, pid, '/definition/goals') },
    { key: 'stakeholders', label: '관계자 / 조직', href: definitionHref(pid, 'STAKEHOLDERS'), match: (path) => isPath(path, pid, '/definition/stakeholders') },
    { key: 'milestones', label: '상위 일정 / 마일스톤', href: definitionHref(pid, 'MILESTONES'), match: (path) => isPath(path, pid, '/definition/milestones') },
    { key: 'operations', label: '프로젝트 운영 방식', href: definitionHref(pid, 'OPERATIONS'), match: (path) => isPath(path, pid, '/definition/operations') },
    { key: 'kickoff', label: '착수보고회', href: definitionHref(pid, 'KICKOFF'), match: (path) => isPath(path, pid, '/definition/kickoff') },
    { key: 'approval', label: '착수 결과 승인', href: definitionHref(pid, 'APPROVAL'), match: (path) => isPath(path, pid, '/definition/approval') },
  ],
  REQUIREMENTS: (pid) => [
    { key: 'requirements', label: '요구사항', href: P(pid, '/requirements'), match: (path, qs) => isPath(path, pid, '/requirements') && !q(qs, 'view', 'trace') && !isClassify(qs) },
    { key: 'req-classify', label: '요구사항 분류 / 우선순위', href: P(pid, '/requirements?view=classify'), match: (path, qs) => isPath(path, pid, '/requirements') && isClassify(qs) },
    { key: 'req-trace', label: '요구사항 추적', href: P(pid, '/requirements?view=trace'), match: (path, qs) => isPath(path, pid, '/requirements') && q(qs, 'view', 'trace') },
  ],
  ANALYSIS_DESIGN: (pid) => [
    { key: 'design', label: '분석·설계', enabled: false },
    { key: 'wbs', label: 'WBS 작성', href: P(pid, '/wbs'), match: (path, qs) => isPath(path, pid, '/wbs') && !q(qs, 'ctx', 'monitor') && !qs.get('phase') },
    { key: 'wbs-trace', label: '요구사항–WBS 연결', href: P(pid, '/requirements?view=trace&scope=IN_SCOPE'), match: (path, qs) => isPath(path, pid, '/requirements') && q(qs, 'view', 'trace') && q(qs, 'scope', 'IN_SCOPE') },
  ],
  DEVELOPMENT: (pid) => [
    { key: 'dev-status', label: '구현 현황', href: P(pid, '/wbs?ctx=monitor&phase=DEVELOPMENT'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'phase', 'DEVELOPMENT') },
    { key: 'dev-tasks', label: '실행 작업', enabled: false },
  ],
  TESTING: (pid) => [
    { key: 'test-plan', label: '테스트 연결률', href: P(pid, '/tests?tab=coverage'), match: (path, qs) => isPath(path, pid, '/tests') && q(qs, 'tab', 'coverage') },
    { key: 'tests', label: '테스트', href: P(pid, '/tests'), match: (path, qs) => isPath(path, pid, '/tests') && !qs.get('tab') && !q(qs, 'last_result', 'FAIL') },
    { key: 'defects', label: '결함', href: P(pid, '/tests?last_result=FAIL'), match: (path, qs) => isPath(path, pid, '/tests') && q(qs, 'last_result', 'FAIL') },
  ],
  TRANSITION_GO_LIVE: (pid) => [
    { key: 'acceptance', label: '검수 / 인수 승인', href: P(pid, '/tests?tab=acceptance'), match: (path, qs) => isPath(path, pid, '/tests') && q(qs, 'tab', 'acceptance') },
    CL(pid, 'cutover', '전환 계획', 'CUTOVER_PLAN'),
    CL(pid, 'migration', '데이터 이관', 'DATA_MIGRATION'),
    CL(pid, 'training', '사용자 교육 / 매뉴얼', 'TRAINING'),
    CL(pid, 'go-live', '오픈', 'GO_LIVE'),
    CL(pid, 'stabilize', '안정화', 'STABILIZE'),
  ],
  OPERATIONS: (pid) => [
    CL(pid, 'ops-handover', '운영 이관 / 인수인계', 'HANDOVER'),
    CL(pid, 'maintenance', '유지보수', 'MAINTENANCE'),
    CL(pid, 'sla', '서비스 수준(SLA)', 'SLA'),
    CL(pid, 'release', '정기 배포', 'RELEASE_PLAN'),
    CL(pid, 'close', '종료 정리', 'CLOSE'),
  ],
};

export const PM_ITEMS = (pid) => [
  { key: 'changes', label: '변경 요청', href: P(pid, '/changes'), match: (path) => isPath(path, pid, '/changes') },
  { key: 'raid', label: '이슈·리스크', href: P(pid, '/issues'), match: (path) => isPath(path, pid, '/issues') },
  { key: 'activity', label: '활동 기록', action: 'activity' },
  { key: 'reports', label: '보고서', href: P(pid, '/reports'), match: (path) => path.startsWith(P(pid, '/reports')) },
];

/** Lifecycle phase (01…07) a work path belongs to — used to auto-expand the right accordion group. */
export function phaseOfPath(pid, path, qs) {
  for (const [key, items] of Object.entries(PHASE_ITEMS)) if (items(pid).some((it) => it.enabled !== false && it.match && it.match(path, qs))) return key;
  return null;
}
/** First usable screen of a phase (stepper click target). */
export const firstScreen = (pid, phaseKey) => (PHASE_ITEMS[phaseKey] ? PHASE_ITEMS[phaseKey](pid).find((it) => it.enabled !== false) : null);

/* ---- Redesign R1 (hive research/relai-redesign-spec.md §4.2): desktop = 7 doors in the rail, a door's sub-pages are tabs.
 * Every project route maps to exactly one door (+ tab) — doorOf() is the one place that decides; old URLs keep working
 * because the tabs link to the same routes. `phase` = the lifecycle phase a page belongs to (title chip); null = current phase.
 * The phone keeps the LNB above (HOME_ITEMS / PHASE_ITEMS / PM_ITEMS). */
const T = (key, label, href, purpose, phase = null) => ({ key, label, href, purpose, phase });
export const DOORS = (pid) => [
  { key: 'next', label: '지금 할 일', href: P(pid), purpose: '현재 단계에서 할 업무와 다음 단계를 안내합니다.', tabs: [] },
  { key: 'plan', label: '계획', href: P(pid, '/definition'), tabs: [
    T('definition', '개요', P(pid, '/definition'), '프로젝트의 목표·범위·기간을 정해 출발 기준을 맞춥니다.', 'INITIATION'),
    T('goals-scope', '목표·범위', definitionHref(pid, 'GOALS'), '프로젝트 목표와 성공 기준, 하는 일과 하지 않는 일을 정합니다.', 'INITIATION'),
    T('stakeholders', '관계자', definitionHref(pid, 'STAKEHOLDERS'), '고객사와 수행사의 역할과 담당자를 정리합니다.', 'INITIATION'),
    T('milestones', '상위 일정', definitionHref(pid, 'MILESTONES'), '오픈일 같은 주요 일정과 마일스톤을 정합니다.', 'INITIATION'),
    T('operations', '운영 방식', definitionHref(pid, 'OPERATIONS'), '보고 주기·회의·의사결정 방식을 정합니다.', 'INITIATION'),
    T('kickoff', '착수보고회', definitionHref(pid, 'KICKOFF'), '착수보고회 일정과 결과를 기록합니다.', 'INITIATION'),
    T('approval', '착수 승인', definitionHref(pid, 'APPROVAL'), '착수 결과에 대한 고객 승인을 기록합니다.', 'INITIATION'),
  ] },
  { key: 'requirements', label: '요구사항', href: P(pid, '/requirements'), tabs: [
    T('requirements', '목록', P(pid, '/requirements'), '고객이 원하는 기능과 조건을 모으고 확정합니다.', 'REQUIREMENTS'),
    T('req-classify', '분류·우선순위', P(pid, '/requirements?view=classify'), '요구사항의 유형과 우선순위를 정합니다.', 'REQUIREMENTS'),
    T('req-trace', '추적', P(pid, '/requirements?view=trace'), '요구사항이 작업과 시험까지 이어졌는지 확인합니다.', 'REQUIREMENTS'),
  ] },
  { key: 'schedule', label: '일정', href: P(pid, '/wbs'), tabs: [
    T('wbs', '작업 목록', P(pid, '/wbs'), '요구사항을 작업으로 나누고 담당자와 기간을 정합니다.', 'ANALYSIS_DESIGN'),
    T('gantt', '간트', P(pid, '/wbs?view=gantt'), '작업 기간과 마일스톤을 일정표로 봅니다.', 'ANALYSIS_DESIGN'),
    T('wbs-trace', '요구사항 연결', P(pid, '/requirements?view=trace&scope=IN_SCOPE'), '범위 내 요구사항을 어떤 작업으로 구현하는지 연결합니다.', 'ANALYSIS_DESIGN'),
    T('dev-status', '구현 현황', P(pid, '/wbs?phase=DEVELOPMENT'), '구현 단계 작업의 진행률과 지연을 확인합니다.', 'DEVELOPMENT'),
  ] },
  { key: 'tests', label: '시험', href: P(pid, '/tests'), tabs: [
    T('test-plan', '테스트 연결률', P(pid, '/tests?tab=coverage'), '확정된 요구사항마다 시험이 준비됐는지 확인합니다.', 'TESTING'),
    T('tests', '테스트', P(pid, '/tests'), '요구사항 기준으로 시험을 만들고 결과를 기록합니다.', 'TESTING'),
    T('defects', '결함', P(pid, '/tests?last_result=FAIL'), '실패한 시험을 모아 보고 조치합니다.', 'TESTING'),
    T('acceptance', '검수', P(pid, '/tests?tab=acceptance'), '고객 검수 결과와 인수 승인을 기록합니다.', 'TRANSITION_GO_LIVE'),
  ] },
  { key: 'issues', label: '이슈·변경', href: P(pid, '/issues'), tabs: [
    T('raid', '이슈', P(pid, '/issues'), '이미 발생해 프로젝트를 막는 문제를 기록하고 조치합니다.'),
    T('risks', '리스크', P(pid, '/issues?tab=risks'), '아직 발생하지 않은 위험을 미리 등록하고 대응 계획과 검토 일정을 관리합니다.'),
    T('changes', '변경 요청', P(pid, '/changes'), '범위·일정 변경 요청의 영향을 보고 승인 여부를 기록합니다.'),
  ] },
  { key: 'reports', label: '보고서', href: P(pid, '/reports'), tabs: [
    T('weekly', '주간보고', P(pid, '/reports'), '보고 기간의 진행 이력을 모아 주간보고 초안을 만들고 확정합니다.'),
    T('docs', '공식 문서', P(pid, '/charter'), '사업수행계획서와 완료보고서 같은 공식 문서를 봅니다.'),
    T('health', '건강도', P(pid, '/overview'), '일정·범위·품질 지표로 프로젝트 상태를 한눈에 봅니다.'),
    { key: 'activity', label: '활동 기록', action: 'activity' },
  ] },
];

/** Door + tab of a project path (desktop rail + section tabs). `hint` = the page's own key where the URL alone is not enough
 * (a completion report is a 공식 문서, a weekly report is 주간보고). Unknown sub-paths fall back to 지금 할 일 — never blank. */
export function doorOf(pid, path, qs, hint = null) {
  const sub = path.slice(P(pid).length).replace(/\/$/, '');
  const pick = (door, tab = null) => ({ door, tab });
  if (sub === '' || sub === '/checklist' || sub.startsWith('/phases')) return pick('next');
  if (sub === '/definition' || sub.startsWith('/definition/')) {   // the tab is the path's slug (old ?activity= links are rewritten by definition.js)
    const slug = sub.slice('/definition/'.length) || (DEFINITION_SLUG[qs.get('activity')] || '');
    return pick('plan', slug === 'goals' ? 'goals-scope' : DEFINITION_TABS.some(([s]) => s && s === slug) ? slug : 'definition');
  }
  if (sub === '/requirements') {
    if (q(qs, 'view', 'trace')) return q(qs, 'scope', 'IN_SCOPE') ? pick('schedule', 'wbs-trace') : pick('requirements', 'req-trace');
    return isClassify(qs) ? pick('requirements', 'req-classify') : pick('requirements', 'requirements');
  }
  if (sub === '/wbs') return q(qs, 'phase', 'DEVELOPMENT') ? pick('schedule', 'dev-status') : q(qs, 'view', 'gantt') ? pick('schedule', 'gantt') : pick('schedule', 'wbs');
  if (sub === '/tests') return pick('tests', q(qs, 'tab', 'coverage') ? 'test-plan' : q(qs, 'tab', 'acceptance') ? 'acceptance' : q(qs, 'last_result', 'FAIL') ? 'defects' : 'tests');
  if (sub === '/issues') return pick('issues', q(qs, 'tab', 'risks') ? 'risks' : 'raid');
  if (sub === '/changes') return pick('issues', 'changes');
  if (sub === '/charter') return pick('reports', 'docs');
  if (sub === '/edit') return pick('plan');   // ⋯ › 프로젝트 정보 수정: the project's 계획 door (Q22-3)
  if (sub === '/overview') return pick('reports', 'health');
  if (sub.startsWith('/reports')) return pick('reports', hint === 'close' ? 'docs' : 'weekly');
  return pick('next');
}
