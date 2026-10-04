/**
 * Project-level metrics service (read-only aggregation).
 * Single entry point for Overview today and for Phase 9 Dashboard / Weekly Report later.
 * Everything here is computed from source tables at request time — nothing is persisted.
 */
import * as R from './requirements.js';
import * as W from './wbs.js';
import * as T from './trace.js';
import * as C from './changes.js';
import * as X from './raid.js';
import * as Q from './testing.js';
import { projectHealth } from './health.js';
import { LEAF_SQL } from './wbs.js';

const TODAY = 'CURRENT_DATE';
const LAST = `(SELECT result FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1)`;

/** All domain stats in one object (same shape the guide endpoint already returns). */
export async function projectStats(db, project) {
  return {
    requirements: (await R.requirementStats(db, project.id)), wbs: (await W.wbsStats(db, project.id)), trace: (await T.traceStats(db, project.id)),
    changes: (await C.changeStats(db, project.id)), issues: (await X.issueStats(db, project.id)), risks: (await X.riskStats(db, project.id)),
    tests: (await Q.testStats(db, project.id)), acceptances: (await Q.acceptanceStats(db, project.id)),
  };
}

/** The 4 headline KPIs (0–100 or null when not applicable). */
export async function headlineKpis(db, project, stats = null) {
  stats = stats || (await projectStats(db, project));
  return {
    wbs_progress: stats.wbs.progress,
    requirement_coverage: stats.trace.coverage,
    test_coverage: stats.tests.coverage,
  };
}

/**
 * Attention items (Phase 9 §11–12): concrete rows that need a look right now.
 * Each item: { kind, type, priority (1 = most urgent), severity:'crit'|'warn', id, display_id, title, meta, href, decision:boolean }.
 * `decision` marks items that need a human decision (used by the weekly report "확인 및 의사결정 필요" section).
 * Ordering is a fixed priority ladder (spec §12) — no scoring engine. Each kind is one aggregate query; nothing per row.
 */
export const ATTENTION_PRIORITY = {
  CRITICAL_ISSUE: 1, CRITICAL_RISK: 2, OVERDUE_HIGH_ISSUE: 3, FAIL_TEST: 4, REWORK_ACCEPTANCE: 5, APPROVED_UNIMPLEMENTED_CHANGE: 6,
  OVERDUE_WBS: 7, OVERDUE_MILESTONE: 7, CONFIRMED_UNLINKED_REQUIREMENT: 8, REVIEW_OVERDUE_RISK: 9,
  HIGH_ISSUE: 10, OVERDUE_ISSUE: 10, HIGH_RISK: 10, UNDER_REVIEW_CHANGE: 10, OVERDUE_ACCEPTANCE: 10,
};
const CRIT_KINDS = new Set(['CRITICAL_ISSUE', 'CRITICAL_RISK', 'OVERDUE_HIGH_ISSUE', 'FAIL_TEST']);
const DECISION_KINDS = new Set(['CRITICAL_ISSUE', 'CRITICAL_RISK', 'HIGH_RISK', 'REWORK_ACCEPTANCE', 'UNDER_REVIEW_CHANGE', 'APPROVED_UNIMPLEMENTED_CHANGE']);

export async function attentionAll(db, projectId) {
  const items = [];
  const push = (kind, type, href, rows, meta) => {
    for (const r of rows) items.push({ kind, type, priority: ATTENTION_PRIORITY[kind], severity: CRIT_KINDS.has(kind) ? 'crit' : 'warn', decision: DECISION_KINDS.has(kind),
      id: r.id, display_id: r.display_id, title: r.title, meta: typeof meta === 'function' ? meta(r) : meta, href: href(r) });
  };
  const ihref = (r) => `issues?sel=${r.id}`; const rhref = (r) => `issues?tab=risks&sel=${r.id}`;
  const ISSUE_OPEN = `project_id = ? AND archived_at IS NULL AND status NOT IN ('RESOLVED','CLOSED')`;
  const issues = (await db.all(`SELECT id, display_id, title, severity, due_date, (due_date IS NOT NULL AND due_date < ${TODAY})::int AS overdue FROM issues WHERE ${ISSUE_OPEN} AND (severity IN ('CRITICAL','HIGH') OR (due_date IS NOT NULL AND due_date < ${TODAY})) ORDER BY due_date, updated_at DESC`, [projectId]));
  push('CRITICAL_ISSUE', 'ISSUE', ihref, issues.filter((i) => i.severity === 'CRITICAL'), (i) => `Critical Issue${i.overdue ? ` · 기한 ${i.due_date} 초과` : ''}`);
  push('OVERDUE_HIGH_ISSUE', 'ISSUE', ihref, issues.filter((i) => i.severity === 'HIGH' && i.overdue), (i) => `High Issue · 기한 ${i.due_date} 초과`);
  push('HIGH_ISSUE', 'ISSUE', ihref, issues.filter((i) => i.severity === 'HIGH' && !i.overdue), 'High Issue');
  push('OVERDUE_ISSUE', 'ISSUE', ihref, issues.filter((i) => !['CRITICAL', 'HIGH'].includes(i.severity) && i.overdue), (i) => `Overdue Issue · 기한 ${i.due_date}`);
  const risks = (await db.all(`SELECT id, display_id, title, risk_level, review_date, (review_date IS NOT NULL AND review_date < ${TODAY})::int AS review_overdue FROM risks WHERE project_id = ? AND archived_at IS NULL AND status IN ('OPEN','MONITORING') AND (risk_level IN ('CRITICAL','HIGH') OR (review_date IS NOT NULL AND review_date < ${TODAY})) ORDER BY updated_at DESC`, [projectId]));
  push('CRITICAL_RISK', 'RISK', rhref, risks.filter((r) => r.risk_level === 'CRITICAL'), 'Critical Risk');
  push('HIGH_RISK', 'RISK', rhref, risks.filter((r) => r.risk_level === 'HIGH'), 'High Risk');
  push('REVIEW_OVERDUE_RISK', 'RISK', rhref, risks.filter((r) => r.review_overdue && !['CRITICAL', 'HIGH'].includes(r.risk_level)), (r) => `리스크 검토일 ${r.review_date} 초과`);
  push('FAIL_TEST', 'TEST', (r) => `tests?sel=${r.id}`, (await db.all(`SELECT t.id, t.display_id, t.title FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL AND ${LAST} = 'FAIL' ORDER BY t.updated_at DESC`, [projectId])), 'Latest Fail Test');
  const accs = (await db.all(`SELECT id, display_id, title, status, due_date FROM acceptances WHERE project_id = ? AND archived_at IS NULL AND (status = 'REWORK_REQUIRED' OR (status = 'REQUESTED' AND due_date IS NOT NULL AND due_date < ${TODAY})) ORDER BY updated_at DESC`, [projectId]));
  push('REWORK_ACCEPTANCE', 'ACCEPTANCE', (r) => `tests?tab=acceptance&sel=${r.id}`, accs.filter((a) => a.status === 'REWORK_REQUIRED'), '보완 필요 검수');
  push('OVERDUE_ACCEPTANCE', 'ACCEPTANCE', (r) => `tests?tab=acceptance&sel=${r.id}`, accs.filter((a) => a.status !== 'REWORK_REQUIRED'), (a) => `검수 기한 ${a.due_date} 초과`);
  const chg = (await db.all(`SELECT id, display_id, title, status FROM change_requests WHERE project_id = ? AND archived_at IS NULL AND status IN ('APPROVED','UNDER_REVIEW') ORDER BY approved_at, updated_at`, [projectId]));
  push('APPROVED_UNIMPLEMENTED_CHANGE', 'CHANGE', (r) => `changes?sel=${r.id}`, chg.filter((c) => c.status === 'APPROVED'), '승인 후 미반영 변경');
  push('UNDER_REVIEW_CHANGE', 'CHANGE', (r) => `changes?sel=${r.id}`, chg.filter((c) => c.status === 'UNDER_REVIEW'), '검토 중 변경 (결정 필요)');
  const wbs = (await db.all(`SELECT w.id, w.wbs_code AS display_id, w.title, w.item_type, w.planned_end_date, w.milestone_date FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.status != 'COMPLETED'
      AND ((w.item_type = 'TASK' AND ${LEAF_SQL('w')} AND w.planned_end_date IS NOT NULL AND w.planned_end_date < ${TODAY}) OR (w.item_type = 'MILESTONE' AND w.milestone_date IS NOT NULL AND w.milestone_date < ${TODAY})) ORDER BY COALESCE(w.planned_end_date, w.milestone_date)`, [projectId]));
  push('OVERDUE_MILESTONE', 'WBS', (r) => `wbs?sel=${r.id}`, wbs.filter((w) => w.item_type === 'MILESTONE'), (w) => `지난 마일스톤 · ${w.milestone_date}`);
  push('OVERDUE_WBS', 'WBS', (r) => `wbs?sel=${r.id}`, wbs.filter((w) => w.item_type === 'TASK'), (w) => `Overdue WBS · 종료 예정 ${w.planned_end_date}`);
  push('CONFIRMED_UNLINKED_REQUIREMENT', 'REQUIREMENT', (r) => `requirements?sel=${r.id}`, (await db.all(`SELECT r.id, r.display_id, r.title FROM requirements r WHERE r.project_id = ? AND r.archived_at IS NULL AND r.scope = 'IN_SCOPE' AND r.status = 'CONFIRMED'
      AND NOT EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.requirement_id = r.id AND w.archived_at IS NULL) ORDER BY r.sequence_number`, [projectId])), '확정 요구사항 · WBS 미연결');
  return items.sort((a, b) => a.priority - b.priority);
}

export async function attentionItems(db, projectId, { limit = 7 } = {}) {
  return (await attentionAll(db, projectId)).slice(0, limit);
}

/** Dated events in [today, today+days] (§13): WBS start/end, milestone, issue due, risk review, acceptance due. Undated rows are never included. */
export async function upcomingDates(db, projectId, { days = 7, limit = 20, from = null, to = null } = {}) {
  const lo = from ? '?' : TODAY; const hi = to ? '?' : `(CURRENT_DATE + ${Number(days)})`;
  const range = (col) => `${col} IS NOT NULL AND ${col} BETWEEN ${lo} AND ${hi}`;
  const args = []; const bind = () => { if (from) args.push(from); if (to) args.push(to); };
  const parts = [
    [`SELECT 'WBS' AS type, 'WBS_START' AS kind, w.id, w.wbs_code AS display_id, w.title, w.planned_start_date AS date, '시작 예정' AS label FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND ${LEAF_SQL('w')} AND w.status = 'NOT_STARTED' AND ${range('w.planned_start_date')}`],
    [`SELECT 'WBS', 'WBS_END', w.id, w.wbs_code, w.title, w.planned_end_date, '종료 예정' FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND ${LEAF_SQL('w')} AND w.status != 'COMPLETED' AND ${range('w.planned_end_date')}`],
    [`SELECT 'WBS', 'MILESTONE', id, wbs_code, title, milestone_date, '마일스톤' FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND item_type = 'MILESTONE' AND status != 'COMPLETED' AND ${range('milestone_date')}`],
    [`SELECT 'ISSUE', 'ISSUE_DUE', id, display_id, title, due_date, '이슈 기한' FROM issues WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('RESOLVED','CLOSED') AND ${range('due_date')}`],
    [`SELECT 'RISK', 'RISK_REVIEW', id, display_id, title, review_date, 'Risk Review' FROM risks WHERE project_id = ? AND archived_at IS NULL AND status IN ('OPEN','MONITORING') AND ${range('review_date')}`],
    [`SELECT 'ACCEPTANCE', 'ACCEPTANCE_DUE', id, display_id, title, due_date, '검수 기한' FROM acceptances WHERE project_id = ? AND archived_at IS NULL AND status IN ('DRAFT','REQUESTED','REWORK_REQUIRED') AND ${range('due_date')}`],
    // BUG-003: 프로젝트 정의 > 주요 일정 (JSON array on project_definitions.key_dates) and the project's own planned end.
    [`SELECT 'DEFINITION', 'KEY_DATE', kd.id, NULL, kd.title, kd.d, '주요 일정' FROM (
        SELECT kd->>'id' AS id, kd->>'title' AS title, (kd->>'date')::date AS d FROM project_definitions d, jsonb_array_elements(COALESCE(NULLIF(d.key_dates, '')::jsonb, '[]'::jsonb)) kd
        WHERE d.project_id = ? AND jsonb_typeof(kd) = 'object' AND (kd->>'date') ~ '^\\d{4}-\\d{2}-\\d{2}$' OFFSET 0) kd WHERE ${range('kd.d')}`],
    [`SELECT 'PROJECT', 'PROJECT_END', p.id, NULL, p.name, p.planned_end_date, '프로젝트 종료 예정' FROM projects p WHERE p.id = ? AND ${range('p.planned_end_date')}`],
  ];
  for (const _ of parts) { args.push(projectId); bind(); }
  const HREF = { WBS: (r) => `wbs?sel=${r.id}`, ISSUE: (r) => `issues?sel=${r.id}`, RISK: (r) => `issues?tab=risks&sel=${r.id}`, ACCEPTANCE: (r) => `tests?tab=acceptance&sel=${r.id}`, DEFINITION: () => 'definition#sec-MILESTONES', PROJECT: () => 'edit' };
  return (await db.all(`SELECT * FROM (${parts.map((p) => p[0]).join(' UNION ALL ')}) up ORDER BY date, type, display_id LIMIT ?`, [...args, limit])).map((r) => ({ ...r, href: HREF[r.type](r) }));
}

/** Everything Phase 9 needs in one call. */
export async function projectSnapshot(db, project) {
  const stats = (await projectStats(db, project));
  const attention = (await attentionAll(db, project.id));
  return { stats, kpis: (await headlineKpis(db, project, stats)), health: (await projectHealth(db, project)),
    attention: attention.slice(0, 7), attention_total: attention.length, upcoming: (await upcomingDates(db, project.id, { days: 7 })) };
}
