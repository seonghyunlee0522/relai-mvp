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
const isPath = (path, pid, suffix) => path === P(pid, suffix) || path === `${P(pid, suffix)}/`;
/** 06/07 activity without its own work screen → its checklist (public/app/project/checklist.js). */
const CL = (pid, key, label, activity) => ({ key, label, href: P(pid, `/checklist?activity=${activity}`), match: (path, qs) => isPath(path, pid, '/checklist') && q(qs, 'activity', activity) });

export const HOME_ITEMS = (pid) => [
  { key: 'next', label: '지금 할 일', href: P(pid), match: (path) => isPath(path, pid, '') },
  { key: 'overview', label: '현황', href: P(pid, '/overview'), match: (path, qs) => isPath(path, pid, '/overview') && !qs.get('ctx'),
    children: [
      { key: 'overview-main', label: '프로젝트 현황', href: P(pid, '/overview'), match: (path, qs) => isPath(path, pid, '/overview') && !location.hash.includes('health') },
      { key: 'overview-charter', label: '프로젝트 헌장', href: P(pid, '/charter'), match: (path) => isPath(path, pid, '/charter') },
      { key: 'overview-wbs', label: 'WBS', href: P(pid, '/wbs?ctx=monitor'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'ctx', 'monitor') && !q(qs, 'view', 'gantt') },
      { key: 'overview-reports', label: '주간보고', href: P(pid, '/reports'), match: (path) => path.startsWith(P(pid, '/reports')) },
      { key: 'overview-schedule', label: '일정 / 마일스톤', href: P(pid, '/wbs?ctx=monitor&view=gantt'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'ctx', 'monitor') && q(qs, 'view', 'gantt') },
      { key: 'overview-health', label: '프로젝트 건강도', href: P(pid, '/overview#health'), match: (path) => isPath(path, pid, '/overview') && location.hash === '#health' },
    ] },
];

/** Work screens per lifecycle phase. `enabled:false` = defined in the IA, no screen yet → not rendered. */
export const PHASE_ITEMS = {
  INITIATION: (pid) => [
    { key: 'definition', label: '프로젝트 정의', href: P(pid, '/definition'), match: (path, qs) => isPath(path, pid, '/definition') && !['STAKEHOLDERS', 'MILESTONES', 'OPERATIONS', 'KICKOFF', 'APPROVAL'].includes(qs.get('activity')) },
    { key: 'stakeholders', label: '이해관계자 / 조직', href: P(pid, '/definition?activity=STAKEHOLDERS'), match: (path, qs) => isPath(path, pid, '/definition') && q(qs, 'activity', 'STAKEHOLDERS') },
    { key: 'milestones', label: '상위 일정 / 마일스톤', href: P(pid, '/definition?activity=MILESTONES'), match: (path, qs) => isPath(path, pid, '/definition') && q(qs, 'activity', 'MILESTONES') },
    { key: 'operations', label: '프로젝트 운영 방식', href: P(pid, '/definition?activity=OPERATIONS'), match: (path, qs) => isPath(path, pid, '/definition') && q(qs, 'activity', 'OPERATIONS') },
    { key: 'kickoff', label: '착수보고회', href: P(pid, '/definition?activity=KICKOFF'), match: (path, qs) => isPath(path, pid, '/definition') && q(qs, 'activity', 'KICKOFF') },
    { key: 'approval', label: '착수 결과 승인', href: P(pid, '/definition?activity=APPROVAL'), match: (path, qs) => isPath(path, pid, '/definition') && q(qs, 'activity', 'APPROVAL') },
  ],
  REQUIREMENTS: (pid) => [
    { key: 'requirements', label: '요구사항', href: P(pid, '/requirements'), match: (path, qs) => isPath(path, pid, '/requirements') && !q(qs, 'view', 'trace') && !(qs.get('type') === 'UNSPECIFIED' || qs.get('priority') === 'UNSPECIFIED') },
    { key: 'req-classify', label: '요구사항 분류 / 우선순위', href: P(pid, '/requirements?type=UNSPECIFIED'), match: (path, qs) => isPath(path, pid, '/requirements') && (qs.get('type') === 'UNSPECIFIED' || qs.get('priority') === 'UNSPECIFIED') },
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
    { key: 'test-plan', label: '테스트 계획', href: P(pid, '/tests?tab=coverage'), match: (path, qs) => isPath(path, pid, '/tests') && q(qs, 'tab', 'coverage') },
    { key: 'tests', label: 'Tests', href: P(pid, '/tests'), match: (path, qs) => isPath(path, pid, '/tests') && !qs.get('tab') && !q(qs, 'last_result', 'FAIL') },
    { key: 'defects', label: 'Defects', href: P(pid, '/tests?last_result=FAIL'), match: (path, qs) => isPath(path, pid, '/tests') && q(qs, 'last_result', 'FAIL') },
  ],
  TRANSITION_GO_LIVE: (pid) => [
    { key: 'acceptance', label: '검수 / 인수 승인', href: P(pid, '/tests?tab=acceptance'), match: (path, qs) => isPath(path, pid, '/tests') && q(qs, 'tab', 'acceptance') },
    CL(pid, 'cutover', '전환 계획', 'CUTOVER_PLAN'),
    CL(pid, 'migration', '데이터 마이그레이션', 'DATA_MIGRATION'),
    CL(pid, 'training', '사용자 교육 / 매뉴얼', 'TRAINING'),
    CL(pid, 'go-live', 'Go-Live', 'GO_LIVE'),
    CL(pid, 'stabilize', '안정화', 'STABILIZE'),
  ],
  OPERATIONS: (pid) => [
    CL(pid, 'ops-handover', '운영 이관 / 인수인계', 'HANDOVER'),
    CL(pid, 'maintenance', '유지보수', 'MAINTENANCE'),
    CL(pid, 'sla', 'SLA', 'SLA'),
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
