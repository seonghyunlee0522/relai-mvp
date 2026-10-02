/**
 * Workspace usage counts against plan limits. One aggregate query per call — never per-row counting.
 * Counts are live (no counter cache; see docs/production-readiness.md §10 for the supporting indexes).
 */
import { PLANS, DEFAULT_PLAN, USAGE_DIMS, pctOf, tierOf } from './plans.js';

const USAGE_SQL = `
  SELECT w.id AS workspace_id, w.name, w.status, w.created_at,
    (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status != 'ARCHIVED') AS projects,
    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
    (SELECT COUNT(*) FROM requirements r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = w.id AND r.archived_at IS NULL) AS requirements,
    (SELECT COUNT(*) FROM wbs_items i JOIN projects p ON p.id = i.project_id WHERE p.workspace_id = w.id AND i.archived_at IS NULL) AS wbs,
    (SELECT COUNT(*) FROM weekly_reports wr JOIN projects p ON p.id = wr.project_id WHERE p.workspace_id = w.id AND wr.created_at >= date_trunc('month', now())) AS weekly_reports,
    GREATEST(w.created_at,
      COALESCE((SELECT MAX(p.updated_at) FROM projects p WHERE p.workspace_id = w.id), w.created_at),
      COALESCE((SELECT MAX(m.created_at) FROM workspace_members m WHERE m.workspace_id = w.id), w.created_at)) AS last_activity_at
  FROM workspaces w`;

/** Shape one usage row: { plan, dims: [{key,label,used,limit,pct}], max_pct, tier }. */
export function shapeUsage(row, planKey = DEFAULT_PLAN) {
  const plan = PLANS[planKey] || PLANS[DEFAULT_PLAN];
  const dims = USAGE_DIMS.map((d) => { const used = Number(row[d.key] || 0); const limit = plan.limits[d.key]; return { key: d.key, label: d.label, used, limit: limit ?? null, pct: pctOf(used, limit) }; });
  const pcts = dims.map((d) => d.pct).filter((p) => p !== null);
  const max_pct = pcts.length ? Math.max(...pcts) : null;
  return { plan: plan.key, plan_label: plan.label, dims, max_pct, tier: tierOf(max_pct) };
}

/** Usage of one workspace (plan is FREE until Billing provides a subscription). */
export async function workspaceUsage(db, workspaceId, planKey = DEFAULT_PLAN) {
  const row = await db.get(`${USAGE_SQL} WHERE w.id = ?`, [workspaceId]);
  return row ? shapeUsage(row, planKey) : null;
}

const SORTS = {
  projects: 'pct_projects DESC NULLS LAST, projects DESC',
  requirements: 'pct_requirements DESC NULLS LAST, requirements DESC',
  wbs: 'pct_wbs DESC NULLS LAST, wbs DESC',
  activity: 'last_activity_at DESC',
};
export const USAGE_SORTS = Object.keys(SORTS);

/**
 * Paged usage of every workspace. `planOf(workspaceId)` lets Billing plug subscriptions in later; today everything is FREE,
 * so the percentage sort can be done in SQL against the FREE limits.
 */
export async function allWorkspacesUsage(db, { sort = 'projects', page = 1, size = 50, q = '' } = {}) {
  const limits = PLANS[DEFAULT_PLAN].limits;
  const pctExpr = (k) => (limits[k] === null ? 'NULL' : `ROUND(u.${k} * 100.0 / ${limits[k]})`);
  const where = q ? `WHERE u.name ILIKE ?` : '';
  const params = q ? [`%${q}%`] : [];
  const total = (await db.get(`SELECT COUNT(*) AS n FROM (${USAGE_SQL}) u ${where}`, params)).n;
  const rows = await db.all(`SELECT u.*, ${pctExpr('projects')} AS pct_projects, ${pctExpr('requirements')} AS pct_requirements, ${pctExpr('wbs')} AS pct_wbs
    FROM (${USAGE_SQL}) u ${where} ORDER BY ${SORTS[sort] || SORTS.projects}, u.name LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  return { total, items: rows.map((r) => ({ workspace_id: r.workspace_id, name: r.name, status: r.status, last_activity_at: r.last_activity_at, ...shapeUsage(r) })) };
}

/** Workspaces at ≥ `minPct` of any FREE limit (dashboard attention). */
export async function workspacesNearLimit(db, minPct = 90, limit = 10) {
  const l = PLANS[DEFAULT_PLAN].limits;
  const conds = Object.entries(l).filter(([, v]) => v !== null).map(([k, v]) => `u.${k} * 100.0 / ${v} >= ${minPct}`);
  if (!conds.length) return [];
  const rows = await db.all(`SELECT u.* FROM (${USAGE_SQL}) u WHERE u.status = 'ACTIVE' AND (${conds.join(' OR ')}) ORDER BY u.name LIMIT ${limit}`);
  return rows.map((r) => ({ workspace_id: r.workspace_id, name: r.name, ...shapeUsage(r) }));
}
