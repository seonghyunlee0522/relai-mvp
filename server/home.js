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
import { projectGuidance } from './guidance.js';

const n = (v) => Number(v) || 0;

/** Everything projectGuidance() needs, loaded once. Shared by the project GET (What's Next) and the Home cards. */
export async function guidanceContext(db, project) {
  const stats = (await M.projectStats(db, project));
  const def = (await D.loadDefinition(db, project));
  const overdue = n((await db.get(`SELECT COUNT(*) n FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND ${LEAF_SQL('w')} AND w.status <> 'COMPLETED' AND w.planned_end_date IS NOT NULL AND w.planned_end_date < CURRENT_DATE`, [project.id])).n);
  const guide = (await loadGuide(db, project, { stats, definition: { sections: def.sections }, overdue_tasks: overdue }));
  const guidance = projectGuidance({ project, phase: guide.current_phase, next_phase: guide.next_phase, definition: { progress: def.progress, needs_review: def.needs_review }, stats, overdue_tasks: overdue });
  return { stats, def, overdue, guide, guidance };
}

/**
 * Guidance rules that describe steady-state monitoring rather than a task the user must do now.
 * Home renders these without a primary CTA ("정상 진행 중 · 다음 확인 …") — the rule text itself is untouched (guidance.js).
 */
export const MONITOR_RULES = new Set(['DEV_STATUS', 'TRANSITION_RUN', 'OPS_HANDOVER']);
export const guidanceKind = (g) => (g && MONITOR_RULES.has(g.rule) ? 'MONITOR' : 'ACTION');

export const PRIORITY = { BLOCKER: 1, ATTENTION: 2, ACTION: 3, NORMAL: 4, WAITING: 5 };
export const PRIORITY_LABEL = { BLOCKER: 'Blocker', ATTENTION: '확인 필요', ACTION: 'Action 필요', NORMAL: '정상', WAITING: '대기' };
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

/** One card payload. `row` is the project-list row (with current_phase_name / sequence); nothing in the project is modified. */
export async function homeCard(db, row, { today } = {}) {
  const project = row;
  const [ctx, health, attentionAll, upcomingAll] = await Promise.all([
    guidanceContext(db, project), H.projectHealth(db, project), M.attentionAll(db, project.id),
    M.upcomingDates(db, project.id, { days: 120, limit: 30 }),
  ]);
  const w = ctx.stats.wbs || {}; const iss = ctx.stats.issues || {};
  const attention = { total: attentionAll.length, crit: attentionAll.filter((i) => i.severity === 'crit').length,
    items: attentionAll.slice(0, 3).map(({ kind, type, severity, display_id, title, meta, href }) => ({ kind, type, severity, display_id, title, meta, href })) };
  const upcoming = upcomingAll.filter((u) => MILESTONE_KINDS.has(u.kind)).slice(0, 3).map(({ kind, type, title, date, label, href }) => ({ kind, type, title, date, label, href }));
  const nextDate = upcoming[0] || null;   // "다음 확인" = the nearest milestone-type date, never an arbitrary task start
  const g = ctx.guidance;
  const card = {
    id: project.id, name: project.name, client_name: project.client_name, status: project.status,
    planned_start_date: project.planned_start_date, planned_end_date: project.planned_end_date,
    current_phase: project.current_phase, current_phase_name: project.current_phase_name, current_phase_sequence: project.current_phase_sequence,
    guidance: g ? { rule: g.rule, kind: guidanceKind(g), title: g.title, description: g.description, primary_action: g.primary_action, secondary_action: g.secondary_action, warnings: g.warnings } : null,
    next_phase: ctx.guide.next_phase ? { key: ctx.guide.next_phase.phase_key, name: ctx.guide.next_phase.name, sequence: ctx.guide.next_phase.sequence } : null,
    wbs: { tasks: n(w.tasks), progress: w.progress ?? 0, planned_progress: w.planned_progress ?? null, variance: w.variance ?? null,
      overdue_tasks: n(w.overdue_tasks), overdue_milestones: n(w.overdue_milestones), max_overdue_days: n(w.max_overdue_days), tasks_without_dates: n(w.tasks_without_dates) },
    health: { status: health.status, status_label: health.status_label, partial_unknown: health.partial_unknown },
    attention,
    upcoming,
    next_date: nextDate ? { kind: nextDate.kind, title: nextDate.title, date: nextDate.date, label: nextDate.label, href: nextDate.href } : null,
    next_date_days: nextDate && today ? daysFromToday(nextDate.date, today) : null,
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
  cards.sort(comparePriority);
  const counts = {}; for (const c of cards) counts[c.priority] = (counts[c.priority] || 0) + 1;
  return { projects: cards, completed: completed.map(({ id, name, client_name, status, current_phase_name, current_phase_sequence, planned_end_date }) => ({ id, name, client_name, status, current_phase_name, current_phase_sequence, planned_end_date })), counts, today };
}
