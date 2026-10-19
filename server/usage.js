/**
 * Workspace usage counts against plan limits. One aggregate query per call — never per-row counting.
 * Counts are live (no counter cache; see docs/production-readiness.md §10 for the supporting indexes).
 */
import { PLANS, DEFAULT_PLAN, USAGE_DIMS, pctOf, tierOf } from './plans.js';
import { GRANTS_PLAN_SQL, EFFECTIVE_PLAN_SQL, effectivePlan } from './billing/subscriptions.js';

const USAGE_SQL = `
  SELECT w.id AS workspace_id, w.name, w.status, w.created_at,
    (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.sample_key IS NULL AND p.status != 'ARCHIVED') AS projects,
    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
    (SELECT COUNT(*) FROM requirements r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = w.id AND p.sample_key IS NULL AND r.archived_at IS NULL) AS requirements,
    (SELECT COUNT(*) FROM wbs_items i JOIN projects p ON p.id = i.project_id WHERE p.workspace_id = w.id AND p.sample_key IS NULL AND i.archived_at IS NULL) AS wbs,
    (SELECT COUNT(*) FROM weekly_reports wr JOIN projects p ON p.id = wr.project_id WHERE p.workspace_id = w.id AND p.sample_key IS NULL AND wr.created_at >= date_trunc('month', now())) AS weekly_reports,
    GREATEST(w.created_at,
      COALESCE((SELECT MAX(p.updated_at) FROM projects p WHERE p.workspace_id = w.id AND p.sample_key IS NULL), w.created_at),
      COALESCE((SELECT MAX(m.created_at) FROM workspace_members m WHERE m.workspace_id = w.id), w.created_at)) AS last_activity_at,
    ${EFFECTIVE_PLAN_SQL} AS plan_key,
    (SELECT s.seats FROM subscriptions s WHERE s.workspace_id = w.id AND ${GRANTS_PLAN_SQL}) AS seats,
    (SELECT COUNT(*) FROM ai_runs r WHERE r.workspace_id = w.id AND r.created_at >= now() - interval '30 days') AS ai_runs_30d,
    (SELECT COUNT(*) FROM ai_runs r WHERE r.workspace_id = w.id AND r.created_at >= now() - interval '30 days' AND r.status = 'FAILED') AS ai_failed_30d,
    (SELECT COALESCE(SUM(r.credit_cost), 0) FROM ai_runs r WHERE r.workspace_id = w.id AND r.created_at >= now() - interval '30 days' AND r.credit_status = 'CHARGED') AS ai_credits_30d,
    (SELECT MAX(r.created_at) FROM ai_runs r WHERE r.workspace_id = w.id) AS ai_last_run_at,
    (SELECT a.balance FROM workspace_credit_accounts a WHERE a.workspace_id = w.id) AS ai_balance
  FROM workspaces w`;

/** Shape one usage row: { plan, dims: [{key,label,used,limit,pct}], max_pct, tier }. */
export function shapeUsage(row, planKey = DEFAULT_PLAN) {
  const plan = PLANS[planKey] || PLANS[DEFAULT_PLAN];
  const seatLimit = plan.per_seat && row.seats ? Number(row.seats) : null;   // per-seat plans: members limited to purchased seats
  const dims = USAGE_DIMS.map((d) => { const used = Number(row[d.key] || 0); const limit = d.key === 'members' && seatLimit ? seatLimit : plan.limits[d.key]; return { key: d.key, label: d.label, used, limit: limit ?? null, pct: pctOf(used, limit) }; });
  const pcts = dims.map((d) => d.pct).filter((p) => p !== null);
  const max_pct = pcts.length ? Math.max(...pcts) : null;
  return { plan: plan.key, plan_label: plan.label, dims, max_pct, tier: tierOf(max_pct) };
}

/** Usage of one workspace against its effective plan (subscription-aware; pass `planKey` to override). */
export async function workspaceUsage(db, workspaceId, planKey = null) {
  const row = await db.get(`${USAGE_SQL} WHERE w.id = ?`, [workspaceId]);
  return row ? shapeUsage(row, planKey || row.plan_key || (await effectivePlan(db, workspaceId))) : null;
}

const SORTS = {
  ai: 'ai_runs_30d DESC, ai_credits_30d DESC, ai_last_run_at DESC NULLS LAST',
  projects: 'pct_projects DESC NULLS LAST, projects DESC',
  requirements: 'pct_requirements DESC NULLS LAST, requirements DESC',
  wbs: 'pct_wbs DESC NULLS LAST, wbs DESC',
  activity: 'last_activity_at DESC',
};
export const USAGE_SORTS = Object.keys(SORTS);

/** AI use of one usage row over the last 30 days (Admin Console "AI 사용량"). */
const shapeAi = (r) => ({ runs_30d: Number(r.ai_runs_30d || 0), failed_30d: Number(r.ai_failed_30d || 0), credits_30d: Number(r.ai_credits_30d || 0),
  last_run_at: r.ai_last_run_at || null, balance: r.ai_balance === null || r.ai_balance === undefined ? null : Number(r.ai_balance) });

/**
 * Paged usage of every workspace: AI use over the last 30 days (`ai`) plus plan-limit use. Each row carries its effective plan (`plan_key`); percentages exist only for limited plans
 * (FREE), so the percentage sort is done in SQL against the FREE limits and unlimited workspaces sort last.
 */
export async function allWorkspacesUsage(db, { sort = 'ai', page = 1, size = 50, q = '' } = {}) {
  const limits = PLANS[DEFAULT_PLAN].limits;
  const pctExpr = (k) => (limits[k] === null ? 'NULL' : `CASE WHEN u.plan_key = '${DEFAULT_PLAN}' THEN ROUND(u.${k} * 100.0 / ${limits[k]}) END`);
  const where = q ? `WHERE u.name ILIKE ?` : '';
  const params = q ? [`%${q}%`] : [];
  const total = (await db.get(`SELECT COUNT(*) AS n FROM (${USAGE_SQL}) u ${where}`, params)).n;
  const rows = await db.all(`SELECT u.*, ${pctExpr('projects')} AS pct_projects, ${pctExpr('requirements')} AS pct_requirements, ${pctExpr('wbs')} AS pct_wbs
    FROM (${USAGE_SQL}) u ${where} ORDER BY ${SORTS[sort] || SORTS.projects}, u.name LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  return { total, items: rows.map((r) => ({ workspace_id: r.workspace_id, name: r.name, status: r.status, last_activity_at: r.last_activity_at, ai: shapeAi(r), ...shapeUsage(r, r.plan_key) })) };
}

/** FREE workspaces at ≥ `minPct` of any FREE limit (dashboard attention). */
export async function workspacesNearLimit(db, minPct = 90, limit = 10) {
  const l = PLANS[DEFAULT_PLAN].limits;
  const conds = Object.entries(l).filter(([, v]) => v !== null).map(([k, v]) => `u.${k} * 100.0 / ${v} >= ${minPct}`);
  if (!conds.length) return [];
  const rows = await db.all(`SELECT u.* FROM (${USAGE_SQL}) u WHERE u.status = 'ACTIVE' AND u.plan_key = '${DEFAULT_PLAN}' AND (${conds.join(' OR ')}) ORDER BY u.name LIMIT ${limit}`);
  return rows.map((r) => ({ workspace_id: r.workspace_id, name: r.name, ...shapeUsage(r) }));
}
