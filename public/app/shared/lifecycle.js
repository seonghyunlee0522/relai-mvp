/* Lifecycle V2 information architecture — the one place that says which work screen each lifecycle activity lives in.
 *
 *   PROJECT HOME        What's Next · Overview (+ sub views)
 *   PROJECT LIFECYCLE   01 착수 … 07 운영 및 유지보수, each with its work screens
 *   PROJECT MANAGEMENT  Changes · Issues & Risks · Activity · Reports (cross-cutting, not phase-bound)
 *
 * Phase names/order come from the server (project_phases rows = templates/default-phases.js); this file only maps keys to
 * screens. Items with `enabled: false` are part of the IA but have no working screen yet — they are never rendered
 * (no Coming Soon, no dead links). `match(path, qs)` decides the active state; the first match wins. */

const P = (pid, s = '') => `/app/projects/${pid}${s}`;
const q = (qs, k, v) => (v === undefined ? qs.has(k) : qs.get(k) === v);
const isPath = (path, pid, suffix) => path === P(pid, suffix) || path === `${P(pid, suffix)}/`;

export const HOME_ITEMS = (pid) => [
  { key: 'next', label: 'What’s Next', href: P(pid), match: (path) => isPath(path, pid, '') },
  { key: 'overview', label: 'Overview', href: P(pid, '/overview'), match: (path, qs) => isPath(path, pid, '/overview') && !qs.get('ctx'),
    children: [
      { key: 'overview-main', label: '프로젝트 현황', href: P(pid, '/overview'), match: (path, qs) => isPath(path, pid, '/overview') && !location.hash.includes('health') },
      { key: 'overview-wbs', label: 'WBS', href: P(pid, '/wbs?ctx=monitor'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'ctx', 'monitor') && !q(qs, 'view', 'gantt') },
      { key: 'overview-reports', label: '주간보고', href: P(pid, '/reports'), match: (path) => path.startsWith(P(pid, '/reports')) },
      { key: 'overview-schedule', label: '일정 / 마일스톤', href: P(pid, '/wbs?ctx=monitor&view=gantt'), match: (path, qs) => isPath(path, pid, '/wbs') && q(qs, 'ctx', 'monitor') && q(qs, 'view', 'gantt') },
      { key: 'overview-health', label: 'Project Health', href: P(pid, '/overview#health'), match: (path) => isPath(path, pid, '/overview') && location.hash === '#health' },
    ] },
];

/** Work screens per lifecycle phase. `enabled:false` = defined in the IA, no screen yet → not rendered. */
export const PHASE_ITEMS = {
  INITIATION: (pid) => [
    { key: 'definition', label: '프로젝트 정의', href: P(pid, '/definition'), match: (path) => isPath(path, pid, '/definition') && !['#sec-STAKEHOLDERS', '#sec-MILESTONES', '#sec-OPERATIONS'].includes(location.hash) },
    { key: 'stakeholders', label: '이해관계자 / 조직', href: P(pid, '/definition#sec-STAKEHOLDERS'), match: (path) => isPath(path, pid, '/definition') && location.hash === '#sec-STAKEHOLDERS' },
    { key: 'milestones', label: '상위 일정 / 마일스톤', href: P(pid, '/definition#sec-MILESTONES'), match: (path) => isPath(path, pid, '/definition') && location.hash === '#sec-MILESTONES' },
    { key: 'operations', label: '프로젝트 운영 방식', href: P(pid, '/definition#sec-OPERATIONS'), match: (path) => isPath(path, pid, '/definition') && location.hash === '#sec-OPERATIONS' },
  ],
  REQUIREMENTS: (pid) => [
    { key: 'requirements', label: '요구사항', href: P(pid, '/requirements'), match: (path, qs) => isPath(path, pid, '/requirements') && !q(qs, 'view', 'trace') && !(qs.get('type') === 'UNSPECIFIED' || qs.get('priority') === 'UNSPECIFIED') },
    { key: 'req-classify', label: '요구사항 분류 / 우선순위', href: P(pid, '/requirements?type=UNSPECIFIED'), match: (path, qs) => isPath(path, pid, '/requirements') && (qs.get('type') === 'UNSPECIFIED' || qs.get('priority') === 'UNSPECIFIED') },
    { key: 'req-trace', label: 'Requirement Trace', href: P(pid, '/requirements?view=trace'), match: (path, qs) => isPath(path, pid, '/requirements') && q(qs, 'view', 'trace') },
  ],
  ANALYSIS_DESIGN: (pid) => [
    { key: 'design', label: '분석·설계', enabled: false },
    { key: 'wbs', label: 'WBS 작성', href: P(pid, '/wbs'), match: (path, qs) => isPath(path, pid, '/wbs') && !q(qs, 'ctx', 'monitor') && !qs.get('phase') },
    { key: 'wbs-trace', label: 'Requirements ↔ WBS Trace', href: P(pid, '/requirements?view=trace&scope=IN_SCOPE'), match: (path, qs) => isPath(path, pid, '/requirements') && q(qs, 'view', 'trace') && q(qs, 'scope', 'IN_SCOPE') },
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
    { key: 'cutover', label: '전환 계획', enabled: false },
    { key: 'migration', label: '데이터 마이그레이션', enabled: false },
    { key: 'training', label: '사용자 교육 / 매뉴얼', enabled: false },
    { key: 'go-live', label: 'Go-Live', enabled: false },
    { key: 'stabilize', label: '안정화', enabled: false },
  ],
  OPERATIONS: (pid) => [
    { key: 'ops-status', label: '운영 현황', enabled: false },
    { key: 'maintenance', label: '유지보수', enabled: false },
    { key: 'sla', label: 'SLA', enabled: false },
    { key: 'release', label: '정기 배포', enabled: false },
  ],
};

export const PM_ITEMS = (pid) => [
  { key: 'changes', label: 'Changes', href: P(pid, '/changes'), match: (path) => isPath(path, pid, '/changes') },
  { key: 'raid', label: 'Issues & Risks', href: P(pid, '/issues'), match: (path) => isPath(path, pid, '/issues') },
  { key: 'activity', label: 'Activity', action: 'activity' },
  { key: 'reports', label: 'Reports', href: P(pid, '/reports'), match: (path) => path.startsWith(P(pid, '/reports')) },
];

/** Lifecycle phase (01…07) a work path belongs to — used to auto-expand the right accordion group. */
export function phaseOfPath(pid, path, qs) {
  for (const [key, items] of Object.entries(PHASE_ITEMS)) if (items(pid).some((it) => it.enabled !== false && it.match && it.match(path, qs))) return key;
  return null;
}
/** First usable screen of a phase (stepper click target). */
export const firstScreen = (pid, phaseKey) => (PHASE_ITEMS[phaseKey] ? PHASE_ITEMS[phaseKey](pid).find((it) => it.enabled !== false) : null);
