/**
 * Monthly AI credit grant for paid plans (PLANS[plan].ai_credits_monthly, TEAM = 1,000 by default).
 *
 * A workspace whose subscription is ACTIVE and still grants its plan receives one PLAN_GRANT per monthly cycle, counted
 * from subscriptions.current_period_start (an annual prepay gets 12 grants, one at the start of each month it covers).
 * Grants are added to the existing ledger (ai/credits.js) and carry over; they are never revoked by a refund.
 * Triggers: the payment that activates or renews the plan (processWebhookEvent) and the daily cron, which catches each
 * new cycle start. Idempotent: the cycle key is the ledger reference (PLAN_MONTHLY / "<subscription id>:<cycle start>"),
 * checked under the credit-account row lock, so a payment and the cron racing for the same cycle grant once.
 */
import { tx } from '../db.js';
import { planOf } from '../plans.js';
import { ensureAccount, applyCredits } from '../ai/credits.js';
import { GRANTS_PLAN_SQL } from './subscriptions.js';

export const GRANT_REF = 'PLAN_MONTHLY';

/** Start of the monthly cycle `now` falls in, anchored on current_period_start (SQL so month lengths match Postgres). */
const CYCLE_START_SQL = `COALESCE(s.current_period_start, s.created_at) + make_interval(months => (
  EXTRACT(YEAR FROM age(now(), COALESCE(s.current_period_start, s.created_at))) * 12 + EXTRACT(MONTH FROM age(now(), COALESCE(s.current_period_start, s.created_at))))::int)`;

/** Grants this cycle's credits if due. Returns { amount, balance, cycle_start } when granted, else null. */
export async function grantMonthlyCredits(db, workspaceId) {
  return tx(db, async (t) => {
    const s = await t.get(`SELECT s.id, s.plan, ${CYCLE_START_SQL} AS cycle_start FROM subscriptions s
      WHERE s.workspace_id = ? AND s.status = 'ACTIVE' AND ${GRANTS_PLAN_SQL}`, [workspaceId]);
    const amount = s ? planOf(s.plan).ai_credits_monthly : 0;
    if (!s || !(amount > 0)) return null;
    const cycle = new Date(s.cycle_start).toISOString().slice(0, 10);
    const ref = `${s.id}:${cycle}`;
    await ensureAccount(t, workspaceId);
    await t.get('SELECT workspace_id FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    if (await t.get('SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND reference_type = ? AND reference_id = ?', [workspaceId, GRANT_REF, ref])) return null;
    const out = await applyCredits(t, { wid: workspaceId, amount, type: 'PLAN_GRANT', reason: `${planOf(s.plan).label} 플랜 월간 AI 크레딧 (${cycle}~)`, referenceType: GRANT_REF, referenceId: ref });
    return { amount, balance: out.balance, cycle_start: cycle };
  });
}

/** Daily cron step: every ACTIVE paid workspace whose plan grants credits. */
export async function grantDueMonthlyCredits(db) {
  const plans = ['TEAM', 'ENTERPRISE'].filter((p) => planOf(p).ai_credits_monthly > 0);
  if (!plans.length) return { due: 0, granted: 0 };
  const rows = await db.all(`SELECT s.workspace_id FROM subscriptions s WHERE s.status = 'ACTIVE' AND s.plan IN (${plans.map(() => '?').join(',')}) AND ${GRANTS_PLAN_SQL}`, plans);
  let granted = 0;
  for (const r of rows) {
    try { if (await grantMonthlyCredits(db, r.workspace_id)) granted += 1; } catch (e) { console.error('[billing] monthly AI credit grant failed', r.workspace_id, e.message); }
  }
  return { due: rows.length, granted };
}
