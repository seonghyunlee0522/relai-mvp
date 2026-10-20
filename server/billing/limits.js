/**
 * Plan limit enforcement (Phase 10 Billing). `server/plans.js` stays the single source of truth for the numbers; this
 * module only counts and refuses. Every create path calls `assertWithinLimit` from the service function that inserts the
 * row (createRequirement, createWbs, generateReport, addMember, invitation accept, project create/unarchive), so the
 * Excel import, AI commits, duplicate/restore and the plain API are all covered by one check.
 *
 * Inside a transaction the workspace row is locked (`FOR UPDATE`) before counting, so two concurrent creates cannot both
 * pass the last free slot. Unlimited plans skip the lock and the count entirely.
 *
 * Downgrades never delete data: a workspace above its limits keeps everything and only new rows are refused.
 * `PLAN_LIMITS=off` disables enforcement (legacy test fixtures build more rows than FREE allows); production leaves it unset.
 */
import { PLANS, USAGE_DIMS } from '../plans.js';
import { effectivePlan } from './subscriptions.js';

export const limitsEnforced = () => process.env.PLAN_LIMITS !== 'off';

/** Same definitions as usage.js (active projects, non-archived requirements/WBS, weekly reports this calendar month). */
const COUNT_SQL = {
  projects: `SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND status != 'ARCHIVED' AND sample_key IS NULL`,
  members: `SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?`,
  requirements: `SELECT COUNT(*) AS n FROM requirements r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = ? AND p.sample_key IS NULL AND r.archived_at IS NULL`,
  wbs: `SELECT COUNT(*) AS n FROM wbs_items i JOIN projects p ON p.id = i.project_id WHERE p.workspace_id = ? AND p.sample_key IS NULL AND i.archived_at IS NULL AND i.system_key IS NULL`,   // batch7: fixed phase nodes are free
  weekly_reports: `SELECT COUNT(*) AS n FROM weekly_reports wr JOIN projects p ON p.id = wr.project_id WHERE p.workspace_id = ? AND p.sample_key IS NULL AND wr.created_at >= date_trunc('month', now())`,
};

/** 402 Payment Required: the workspace's plan does not allow another row of `dimension`. Rendered by app.js's error handler. */
export class PlanLimitError extends Error {
  constructor({ dimension, used, limit, plan, adding = 1, seats = false }) {
    const label = USAGE_DIMS.find((d) => d.key === dimension)?.label || dimension;
    super(seats ? `구매한 사용자 수(${limit}명)를 모두 사용 중입니다. 사용자를 늘리려면 이용 기간 연장 시 사용자 수를 늘려 구매하거나(1명당 월 ₩${PLANS.TEAM.extra_user_monthly.toLocaleString('ko-KR')}) 운영자에게 문의해 주세요.`
      : `${PLANS[plan]?.label || plan} 플랜의 ${label} 한도(${limit})에 도달했습니다. Team 플랜으로 업그레이드하면 계속 추가할 수 있습니다.`);
    this.status = 402; this.code = 'plan_limit_reached';
    this.extra = { limit: { dimension, label, used, limit, plan, adding, ...(seats ? { seats: true } : {}) }, upgrade: { plan: 'TEAM', url: '/app/settings#billing' } };
  }
}

/** Throws PlanLimitError when `adding` more rows of `dimension` would exceed the workspace's effective plan. */
export async function assertWithinLimit(db, workspaceId, dimension, adding = 1) {
  if (!limitsEnforced() || adding <= 0) return;
  const plan = await effectivePlan(db, workspaceId);
  let limit = PLANS[plan].limits[dimension];
  // Per-seat plans: the member limit is the purchased user count, owner included (NULL seats = legacy row, unlimited).
  const seats = dimension === 'members' && PLANS[plan].per_seat ? (await db.get('SELECT seats FROM subscriptions WHERE workspace_id = ?', [workspaceId]))?.seats : null;
  if (seats) limit = Number(seats);
  if (limit === null || limit === undefined) return;
  if (db.isTx) await db.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
  const used = Number((await db.get(COUNT_SQL[dimension], [workspaceId])).n);
  if (used + adding > limit) throw new PlanLimitError({ dimension, used, limit, plan, adding, seats: Boolean(seats) });
}
