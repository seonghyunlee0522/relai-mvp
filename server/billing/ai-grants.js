/**
 * Monthly AI credit grant for paid plans (pricing v3: PLANS[plan].credits.monthly — PRO 1,000, TEAM 3,000; FREE / ENTERPRISE 0).
 *
 * A workspace whose subscription still grants its plan receives one PLAN_GRANT per monthly credit cycle, counted from
 * subscriptions.current_period_start (an annual pass gets 12 grants, one at the start of each month it covers). The grant goes into
 * the PLAN bucket (ai/credits.js) and expires at the end of its cycle: when the next cycle's grant runs, whatever is left of the
 * previous one is written off first (EXPIRY), so base credits never carry over (spec §2.3, design.md §4).
 * Triggers: the payment that activates or renews the plan (processWebhookEvent) and the daily cron, which catches each new cycle
 * start and expires lapsed PLAN buckets. Idempotent: the cycle key is the ledger reference (PLAN_MONTHLY /
 * "<subscription id>:<cycle start>"), checked under the credit-account row lock, so a payment and the cron racing for the same
 * cycle grant once.
 *
 * Contracts for T3 (subscription lifecycle):
 *   grantMonthlyCredits(db, workspaceId)                          → { amount, balance, cycle_start, expires_at, expired } | null
 *   grantUpgradeCredits(db, workspaceId, { from, to, reference })  → { amount, balance } | null   (PRO→TEAM: +2,000 for the current cycle)
 *   expirePlanCredits(db, workspaceId, { reason, referenceId })    → { expired }   (re-exported from ai/credits.js; subscription ended / 즉시해지)
 *   expireDuePlanCredits(db)                                       → { due, expired } (daily sweep, also run by grantDueMonthlyCredits)
 */
import { tx } from '../db.js';
import { PLANS, planOf } from '../plans.js';
import { ensureAccount, applyCredits, expirePlanCredits } from '../ai/credits.js';
import { GRANTS_PLAN_SQL, EFFECTIVE_PLAN_SQL } from './subscriptions.js';

export { expirePlanCredits };
export const GRANT_REF = 'PLAN_MONTHLY';
export const UPGRADE_REF = 'PLAN_UPGRADE';

/** Monthly base credits of a plan (0 = none). */
export const monthlyCreditsOf = (plan) => Number(planOf(plan).credits?.monthly ?? planOf(plan).ai_credits_monthly ?? 0);
/** Plans whose subscription earns a monthly grant. */
export const grantingPlans = () => Object.keys(PLANS).filter((p) => p !== 'EARLY' && monthlyCreditsOf(p) > 0);

/** Start of the monthly cycle `now` falls in, anchored on current_period_start (SQL so month lengths match Postgres). */
const CYCLE_START_SQL = `COALESCE(s.current_period_start, s.created_at) + make_interval(months => (
  EXTRACT(YEAR FROM age(now(), COALESCE(s.current_period_start, s.created_at))) * 12 + EXTRACT(MONTH FROM age(now(), COALESCE(s.current_period_start, s.created_at))))::int)`;
/** End of that cycle = when its PLAN credits expire: one month later, or the paid period's end when the plan will not renew. */
const CYCLE_END_SQL = `CASE WHEN (s.cancel_at_period_end OR NOT s.auto_renew) AND s.current_period_end IS NOT NULL
  THEN LEAST(${CYCLE_START_SQL} + interval '1 month', s.current_period_end) ELSE ${CYCLE_START_SQL} + interval '1 month' END`;

/** The subscription's current credit cycle (null when the workspace's plan grants no monthly credits). */
async function currentCycle(t, workspaceId) {
  const s = await t.get(`SELECT s.id, s.plan, ${CYCLE_START_SQL} AS cycle_start, ${CYCLE_END_SQL} AS cycle_end FROM subscriptions s
    WHERE s.workspace_id = ? AND s.status = 'ACTIVE' AND ${GRANTS_PLAN_SQL}`, [workspaceId]);
  if (!s || !(monthlyCreditsOf(s.plan) > 0)) return null;
  const cycle = new Date(s.cycle_start).toISOString().slice(0, 10);
  return { plan: s.plan, amount: monthlyCreditsOf(s.plan), cycle, ref: `${s.id}:${cycle}`, expiresAt: new Date(s.cycle_end).toISOString() };
}
const hasRef = (t, wid, type, id) => t.get('SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND reference_type = ? AND reference_id = ?', [wid, type, id]);

/** Grants this cycle's credits if due (expiring the previous cycle's rest first). Returns the grant, else null. */
export async function grantMonthlyCredits(db, workspaceId) {
  return tx(db, async (t) => {
    const c = await currentCycle(t, workspaceId);
    if (!c) return null;
    await ensureAccount(t, workspaceId);
    await t.get('SELECT workspace_id FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    if (await hasRef(t, workspaceId, GRANT_REF, c.ref)) return null;
    // A new cycle has started: the previous cycle's base credits do not carry over.
    const { expired } = await expirePlanCredits(t, workspaceId, { reason: '기본 크레딧 소멸 (지급 주기 종료)', referenceId: c.ref });
    const out = await applyCredits(t, { wid: workspaceId, amount: c.amount, type: 'PLAN_GRANT', reason: `${planOf(c.plan).label} 플랜 월간 AI 크레딧 (${c.cycle}~)`,
      referenceType: GRANT_REF, referenceId: c.ref, bucket: 'plan', expiresAt: c.expiresAt });
    return { amount: c.amount, balance: out.balance, cycle_start: c.cycle, expires_at: c.expiresAt, expired };
  });
}

/**
 * Upgrade inside a credit cycle (T3, PRO→TEAM, called after the subscription row carries the new plan): the difference of the
 * monthly grants goes into the PLAN bucket with the current cycle's expiry. Idempotent per `reference` (the upgrade order id).
 * No grant for the current cycle yet → the normal monthly grant (already at the new plan's amount) runs instead.
 */
export async function grantUpgradeCredits(db, workspaceId, { from, to, reference }) {
  const diff = monthlyCreditsOf(to) - monthlyCreditsOf(from);
  if (!(diff > 0) || !reference) return null;
  return tx(db, async (t) => {
    const c = await currentCycle(t, workspaceId);
    if (!c) return null;
    await ensureAccount(t, workspaceId);
    await t.get('SELECT workspace_id FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    if (await hasRef(t, workspaceId, UPGRADE_REF, String(reference))) return null;
    if (!(await hasRef(t, workspaceId, GRANT_REF, c.ref))) {
      const g = await grantMonthlyCredits(t, workspaceId);
      return g ? { amount: g.amount, balance: g.balance } : null;
    }
    const out = await applyCredits(t, { wid: workspaceId, amount: diff, type: 'PLAN_GRANT', reason: `${planOf(from).label} → ${planOf(to).label} 업그레이드 추가 AI 크레딧`,
      referenceType: UPGRADE_REF, referenceId: String(reference), bucket: 'plan', expiresAt: c.expiresAt });
    return { amount: diff, balance: out.balance };
  });
}

/** Daily sweep: PLAN buckets past their expiry, or of workspaces whose plan no longer grants credits (ended → FREE), expire now. */
export async function expireDuePlanCredits(db) {
  const plans = grantingPlans();
  const rows = await db.all(`SELECT a.workspace_id FROM workspace_credit_accounts a JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.plan_balance > 0 AND (a.plan_expires_at <= now() OR ${EFFECTIVE_PLAN_SQL} NOT IN (${plans.map(() => '?').join(',') || "''"}))`, plans);
  let expired = 0;
  for (const r of rows) {
    try { if ((await expirePlanCredits(db, r.workspace_id)).expired > 0) expired += 1; } catch (e) { console.error('[billing] plan credit expiry failed', r.workspace_id, e.message); }
  }
  return { due: rows.length, expired };
}

/** Daily cron step: expire lapsed PLAN buckets, then grant every ACTIVE paid workspace whose plan grants credits. */
export async function grantDueMonthlyCredits(db) {
  const expiry = await expireDuePlanCredits(db);
  const plans = grantingPlans();
  if (!plans.length) return { due: 0, granted: 0, expired: expiry.expired };
  const rows = await db.all(`SELECT s.workspace_id FROM subscriptions s WHERE s.status = 'ACTIVE' AND s.plan IN (${plans.map(() => '?').join(',')}) AND ${GRANTS_PLAN_SQL}`, plans);
  let granted = 0;
  for (const r of rows) {
    try { if (await grantMonthlyCredits(db, r.workspace_id)) granted += 1; } catch (e) { console.error('[billing] monthly AI credit grant failed', r.workspace_id, e.message); }
  }
  return { due: rows.length, granted, expired: expiry.expired };
}
