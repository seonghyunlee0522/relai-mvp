/**
 * Workspace Home (GET /api/workspaces/:wid/projects/home) — one compact "status card" per live project.
 *
 * Nothing new is stored and no new rule engine exists: every field is assembled from what the app already computes.
 *   - Next Action  → projectGuidance() through the SAME guidanceContext() What's Next uses, so Home and Project Home never disagree
 *   - Health       → health.js projectHealth()           (overall status only)
 *   - Attention    → metrics.js attentionAll()           (count by severity + top 3 rows)
 *   - Milestones   → metrics.js upcomingDates()          (MILESTONE / KEY_DATE / PROJECT_END, today onward, max 3)
 *   - Progress     → stats.wbs (scheduleFigures)         (progress · planned · variance · overdue)
 *   - Priority     → a fixed ladder over the above (Blocker > 확인 필요 > Action 필요 > 정상 > 대기) — ordering + badge only
 */
import { loadGuide } from './guide.js';
import * as D from './definition.js';
import * as M from './metrics.js';
import * as H from './health.js';
import { LEAF_SQL, todayStr } from './wbs.js';
import { pendingKeyDates } from './wbs-skeleton.js';
import { projectGuidance } from './guidance.js';
import { loadBaseline } from './req-baseline.js';
import { weeklyReportState, completionState } from './reports.js';
import { PHASE_BY_KEY } from './templates/default-phases.js';
import { goLiveOf } from './golive.js';
import { handoverOf, ownerCounts } from './closing.js';
import { projectActivity } from './dashboard.js';

const n = (v) => Number(v) || 0;

/** Everything projectGuidance() needs, loaded once. Shared by the project GET (What's Next) and the Home cards. */
export async function guidanceContext(db, project) {
  const stats = (await M.projectStats(db, project));
  const def = (await D.loadDefinition(db, project));
  const overdue = n((await db.get(`SELECT COUNT(*) n FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND ${LEAF_SQL('w')} AND w.status <> 'COMPLETED' AND w.planned_end_date IS NOT NULL AND w.planned_end_date < ?`, [project.id, todayStr()])).n);   // C1: '오늘' = Korea time
  const reqBaseline = (await loadBaseline(db, project, { stats: stats.requirements }));   // 02 요구사항 기준선 승인 (Phase 2)
  const traits = { data_migration: project.data_migration, has_external_integration: project.has_external_integration };
  const keyDatesPending = project.current_phase === 'ANALYSIS_DESIGN' ? (await pendingKeyDates(db, project)) : [];   // 03 MILESTONES: 01 주요 일정 가져오기 suggestion (US-4)
  const goLive = (await goLiveOf(db, project.id));   // Phase 6 US-3: 오픈 기록 (오픈일 · 운영 이관)
  const later = ['TRANSITION_GO_LIVE', 'OPERATIONS'].includes(project.current_phase);
  const dataReqs = later && project.data_migration === 'YES' ? (await db.all(`SELECT id, display_id, title FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND type = 'DATA' ORDER BY sequence_number LIMIT 5`, [project.id])) : [];   // US-4
  const carried = goLive ? (await carriedStillOpen(db, project.id, goLive)) : { critical_issues_carried: 0, open_issues_carried: 0, blocked_issues_carried: 0, approved_crs_carried: 0 };
  const gStats = lessCarried(stats, carried);   // Phase 7 M2: 운영 이관 items are recorded, not open work — every activity / guidance count skips them
  // Phase 7: 운영 인수 (HANDOVER) · 완료보고서 (CLOSE) · 이관 뒤 독촉 제외 (US-4)
  const ops = project.current_phase === 'OPERATIONS' || project.status === 'COMPLETED';
  const handover = ops ? (await handoverOf(db, project.id)) : null;
  const completionReport = ops ? (await completionState(db, project.id)) : { state: 'NONE', report_id: null, finalized_at: null };
  const guide = (await loadGuide(db, project, { stats: gStats, definition: { sections: def.sections, req_baseline: reqBaseline }, traits, overdue_tasks: overdue, key_dates_pending: keyDatesPending,
    weekly_report: (await weeklyReportState(db, project.id)), go_live: goLive, data_requirements: dataReqs,   // 04 WEEKLY_REPORT (US-3)
    handover, completion_report: completionReport }));
  const scopeOut = (def.definition.scope_out || []).map((x) => x.text).filter(Boolean);   // Charter 제외 범위 → 02 범위 확정 hint
  const goLiveCtx = later && goLive ? { ...goLive, ...carried, owners: ownerCounts(goLive.carryovers) } : null;
  const guidance = projectGuidance({ project, phase: guide.current_phase, next_phase: guide.next_phase, definition: { progress: def.progress, needs_review: def.needs_review, initiation_gate: def.initiation_gate, req_baseline: reqBaseline, scope_out: scopeOut }, stats: gStats, overdue_tasks: overdue, go_live: goLiveCtx, completion_report: completionReport });
  return { stats, def, overdue, guide, guidance, reqBaseline, goLive, handover, completionReport, carriedIds: carriedIdSet(goLive) };
}

/** 'ISSUE:<id>' · 'CR:<id>' … of every 운영 이관 item (Phase 7 US-4: Home 확인 필요 rows skip them). */
const ATT_TYPE = { ISSUE: 'ISSUE', CHANGE: 'CR', TEST: 'TEST', ACCEPTANCE: 'ACCEPTANCE' };
export const carriedIdSet = (gl) => new Set((gl ? gl.carryovers : []).map((c) => `${c.type}:${c.id}`));
export const notCarried = (items, ids) => (ids && ids.size ? items.filter((i) => !ids.has(`${ATT_TYPE[i.type] || i.type}:${i.id}`)) : items);

/** stats with the still-open 운영 이관 issues / approved CRs taken out (issues.carried keeps how many). Pure. */
export function lessCarried(stats, c) {
  const is = stats.issues || {}; const ch = stats.changes || {}; const sub = (a, b) => Math.max(0, n(a) - n(b));
  if (!n(c.open_issues_carried) && !n(c.approved_crs_carried)) return stats;
  return { ...stats, issues: { ...is, active: sub(is.active, c.open_issues_carried), critical: sub(is.critical, c.critical_issues_carried), blocked: sub(is.blocked, c.blocked_issues_carried), carried: n(c.open_issues_carried) },
    changes: { ...ch, approved_unimplemented: sub(ch.approved_unimplemented, c.approved_crs_carried), carried: n(c.approved_crs_carried) } };
}

/** Issues / approved CRs carried into 07 at 오픈 that are still open — they are recorded already, not a new warning. */
async function carriedStillOpen(db, projectId, gl) {
  const ids = (t) => gl.carryovers.filter((c) => c.type === t).map((c) => c.id);
  const cnt = async (sql, list) => (list.length ? n((await db.get(`${sql} AND id IN (${list.map(() => '?').join(',')})`, [projectId, ...list])).n) : 0);
  return { critical_issues_carried: await cnt(`SELECT COUNT(*) n FROM issues WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('RESOLVED','CLOSED') AND severity = 'CRITICAL'`, ids('ISSUE')),
    open_issues_carried: await cnt(`SELECT COUNT(*) n FROM issues WHERE project_id = ? AND archived_at IS NULL AND status NOT IN ('RESOLVED','CLOSED')`, ids('ISSUE')),
    blocked_issues_carried: await cnt(`SELECT COUNT(*) n FROM issues WHERE project_id = ? AND archived_at IS NULL AND status = 'BLOCKED'`, ids('ISSUE')),
    approved_crs_carried: await cnt(`SELECT COUNT(*) n FROM change_requests WHERE project_id = ? AND archived_at IS NULL AND status = 'APPROVED'`, ids('CR')) };
}

/**
 * Guidance rules that describe steady-state monitoring rather than a task the user must do now.
 * Home renders these without a primary CTA ("정상 진행 중 · 다음 확인 …") — the rule text itself is untouched (guidance.js).
 */
export const MONITOR_RULES = new Set(['DEV_STATUS', 'TRANSITION_RUN', 'CLOSED']);   // Phase 7: OPS_HANDOVER is a task now (인수 완료 처리)
export const guidanceKind = (g) => (g && MONITOR_RULES.has(g.rule) ? 'MONITOR' : 'ACTION');

export const PRIORITY = { BLOCKER: 1, ATTENTION: 2, ACTION: 3, NORMAL: 4, WAITING: 5 };
export const PRIORITY_LABEL = { BLOCKER: '막힘', ATTENTION: '확인 필요', ACTION: '조치 필요', NORMAL: '정상', WAITING: '대기' };
const MILESTONE_KINDS = new Set(['MILESTONE', 'KEY_DATE', 'PROJECT_END']);
const SOON_DAYS = 7;

/** Pure: priority key from already-computed parts (unit-testable without a db). */
export function homePriority({ project, health, attention, guidance, issues, upcoming }) {
  if (project.status === 'DRAFT' || project.status === 'ON_HOLD') return 'WAITING';
  if ((health && health.status === H.STATUS.CRITICAL) || n(attention && attention.crit) || n(issues && issues.blocked)) return 'BLOCKER';
  if (n(attention && attention.total)) return 'ATTENTION';   // concrete rows to look at; a WARNING health with no rows is handled by the guidance CTA (ACTION)
  if (guidanceKind(guidance) === 'ACTION') return 'ACTION';
  return 'NORMAL';
}

/** Sort: priority ladder → nearest milestone (D-7 first) → name. */
export const comparePriority = (a, b) => (PRIORITY[a.priority] - PRIORITY[b.priority])
  || ((a.next_date_days ?? 99999) - (b.next_date_days ?? 99999))
  || String(a.name).localeCompare(String(b.name), 'ko');

const daysFromToday = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

/** 01·02 (before 분석·설계): requirement↔WBS links are not expected yet, so 'WBS 미연결' is neither a 확인 필요 row nor a Blocker (Phase 2 US-4). */
export const wbsExpected = (phaseKey) => (PHASE_BY_KEY[phaseKey] ? !['INITIATION', 'REQUIREMENTS'].includes(phaseKey) : true);

/** One card payload. `row` is the project-list row (with current_phase_name / sequence); nothing in the project is modified. */
export async function homeCard(db, row, { today } = {}) {
  const project = row;
  const early = !wbsExpected(project.current_phase);
  const [ctx, health, attentionRaw, upcomingAll, activity] = await Promise.all([
    guidanceContext(db, project),
    early ? H.healthFacts(db, project).then((f) => H.evaluateHealth({ ...f, req: { ...f.req, confirmed_unlinked: 0 } })) : H.projectHealth(db, project),
    M.attentionAll(db, project.id),
    M.upcomingDates(db, project.id, { days: 120, limit: 30 }),
    projectActivity(db, project.id, { limit: 3 }),   // Redesign R2: Home 최근 활동 (newest 3 per project, merged on the client)
  ]);
  const attentionAll = notCarried(early ? attentionRaw.filter((i) => i.kind !== 'CONFIRMED_UNLINKED_REQUIREMENT') : attentionRaw, project.current_phase === 'OPERATIONS' ? ctx.carriedIds : null);
  const w = ctx.stats.wbs || {}; const iss = ctx.stats.issues || {};
  const attention = { total: attentionAll.length, crit: attentionAll.filter((i) => i.severity === 'crit').length,
    unlinked: attentionAll.filter((i) => i.kind === 'CONFIRMED_UNLINKED_REQUIREMENT').length,   // Home shows this once, as the 다음 할 일 (design §4 #2)
    items: attentionAll.slice(0, 3).map(({ kind, type, severity, display_id, title, meta, href }) => ({ kind, type, severity, display_id, title, meta, href })) };
  const upcoming = upcomingAll.filter((u) => MILESTONE_KINDS.has(u.kind)).slice(0, 3).map(({ kind, type, title, date, label, href }) => ({ kind, type, title, date, label, href }));
  const nextDate = upcoming[0] || null;   // "다음 확인" = the nearest milestone-type date, never an arbitrary task start
  const g = ctx.guidance;
  const card = {
    id: project.id, name: project.name, client_name: project.client_name, status: project.status, sample_key: project.sample_key || null, read_only: Boolean(project.read_only),
    planned_start_date: project.planned_start_date, planned_end_date: project.planned_end_date,
    current_phase: project.current_phase, current_phase_name: project.current_phase_name, current_phase_sequence: project.current_phase_sequence,
    guidance: g ? { rule: g.rule, kind: guidanceKind(g), title: g.title, description: g.description, primary_action: g.primary_action, secondary_action: g.secondary_action, warnings: g.warnings } : null,
    phase_states: ctx.guide.phases.map((p) => (project.status === 'COMPLETED' && p.display_state === 'gap' ? 'quiet' : p.display_state)),   // Q16-1: a closed project's bar has no amber   // B-1: the lifecycle bar uses the same gate-based ✓ as the LNB / stepper
    next_phase: ctx.guide.next_phase ? { key: ctx.guide.next_phase.phase_key, name: ctx.guide.next_phase.name, sequence: ctx.guide.next_phase.sequence } : null,
    wbs: { tasks: n(w.tasks), progress: w.progress ?? 0, planned_progress: w.planned_progress ?? null, variance: w.variance ?? null,
      overdue_tasks: n(w.overdue_tasks), overdue_milestones: n(w.overdue_milestones), max_overdue_days: n(w.max_overdue_days), tasks_without_dates: n(w.tasks_without_dates) },
    health: { status: health.status, status_label: health.status_label, partial_unknown: health.partial_unknown },
    attention,
    upcoming,
    next_date: nextDate ? { kind: nextDate.kind, title: nextDate.title, date: nextDate.date, label: nextDate.label, href: nextDate.href } : null,
    next_date_days: nextDate && today ? daysFromToday(nextDate.date, today) : null,
    recent: (activity.items || []).slice(0, 3).map(({ at, actor_name, display_id, title, summary, href, kind }) => ({ at, actor_name, display_id, title, summary, href, kind })),
  };
  card.priority = homePriority({ project, health, attention, guidance: g, issues: iss, upcoming });
  card.priority_label = PRIORITY_LABEL[card.priority];
  card.soon = card.next_date_days !== null && card.next_date_days <= SOON_DAYS;
  return card;
}

/** Live projects → cards (priority-sorted); COMPLETED projects → bare rows (no per-project computation). ARCHIVED never appears. */
export async function workspaceHome(db, rows, { ensure = null, today = todayStr(), concurrency = 4 } = {}) {
  const live = rows.filter((r) => r.status !== 'ARCHIVED' && r.status !== 'COMPLETED');
  const completed = rows.filter((r) => r.status === 'COMPLETED');
  const cards = new Array(live.length);
  let i = 0;
  const worker = async () => { while (i < live.length) { const k = i++; const row = ensure ? await ensure(live[k]) : live[k]; cards[k] = await homeCard(db, row, { today }); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, live.length) }, worker));
  cards.sort((a, b) => Number(Boolean(a.sample_key)) - Number(Boolean(b.sample_key)) || comparePriority(a, b));   // 샘플 프로젝트 after real work
  const counts = {}; for (const c of cards) counts[c.priority] = (counts[c.priority] || 0) + 1;
  // Phase 7 US-2: 완료된 프로젝트 = name · 완료일 · 완료보고서 link (no progress, no 다음 할 일)
  const reports = completed.length ? new Map((await db.all(`SELECT project_id, id FROM weekly_reports WHERE report_type = 'COMPLETION' AND project_id IN (${completed.map(() => '?').join(',')})`, completed.map((r) => r.id))).map((r) => [r.project_id, r.id])) : new Map();
  return { projects: cards, completed: completed.map(({ id, name, client_name, status, current_phase_name, current_phase_sequence, planned_end_date, closed_on, sample_key }) => ({ id, name, client_name, status, sample_key: sample_key || null, current_phase_name, current_phase_sequence, planned_end_date, closed_on: closed_on || null, completion_report_id: reports.get(id) || null })), counts, today };
}
