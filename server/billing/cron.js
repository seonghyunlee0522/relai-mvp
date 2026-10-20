/**
 * Daily billing jobs, run by GET /api/billing/cron/daily (Vercel Cron, `Authorization: Bearer $CRON_SECRET`).
 *   sendRenewalReminders — one-time Team purchases ending within 7 days: one e-mail per OWNER per period end.
 *   sendEarlyAccessNotices — early access ending in ≤ 30 days and in ≤ 7 days: one e-mail each per OWNER (AI-credits-only billing).
 *   chargeDueRenewals    — 정기결제 only (NICEPAY_RECURRING_ENABLED): charge billing keys whose next_billing_at has come.
 * Each row is claimed with a conditional UPDATE before any e-mail or charge, so overlapping runs never double-send or double-charge.
 * Provider calls run outside DB transactions.
 */
import { sendEmail } from '../email/service.js';
import { emailConfig } from '../email/config.js';
import { renewalReminderEmail, earlyAccessEndingEmail } from '../email/templates.js';
import { PLANS } from '../plans.js';
import { GRANTS_PLAN_SQL } from './subscriptions.js';
import { quote, createOrder, failOrder } from './orders.js';
import { processWebhookEvent } from './subscriptions.js';

export const REMINDER_DAYS = 7;

export async function sendRenewalReminders(db, env = process.env) {
  const due = await db.all(`SELECT s.id, s.workspace_id, s.current_period_end, s.seats, w.name AS workspace_name FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.status = 'ACTIVE' AND NOT s.auto_renew AND NOT s.cancel_at_period_end AND s.current_period_end > now()
      AND s.current_period_end <= now() + make_interval(days => ${REMINDER_DAYS}) AND s.renewal_reminded_for IS DISTINCT FROM s.current_period_end`);
  const cfg = emailConfig(env);
  let sent = 0;
  for (const s of due) {
    const claimed = await db.get(`UPDATE subscriptions SET renewal_reminded_for = current_period_end WHERE id = ? AND renewal_reminded_for IS DISTINCT FROM current_period_end RETURNING id`, [s.id]);
    if (!claimed) continue;
    const owners = await db.all(`SELECT u.id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'OWNER' AND u.status = 'ACTIVE'`, [s.workspace_id]);
    const mail = renewalReminderEmail({ workspaceName: s.workspace_name, periodEnd: s.current_period_end, seats: s.seats,
      link: cfg.appBaseUrl ? `${cfg.appBaseUrl}/app/settings#billing` : '', support: cfg.supportEmail });
    for (const o of owners) {
      const r = await sendEmail(db, { type: 'BILLING_RENEWAL_REMINDER', to: o.email, ...mail, relatedUserId: o.id, workspaceId: s.workspace_id }, env);
      if (r.status === 'SENT') sent += 1;
    }
  }
  return { due: due.length, sent };
}

export async function chargeDueRenewals(db, provider) {
  if (!provider?.recurringEnabled || typeof provider.chargeBillingKey !== 'function') return { skipped: 'recurring_disabled' };
  const due = await db.all(`SELECT s.* FROM subscriptions s WHERE s.provider = ? AND s.auto_renew AND s.billing_key_enc IS NOT NULL AND NOT s.cancel_at_period_end
    AND s.next_billing_at <= now() AND (s.status = 'ACTIVE' OR (s.status = 'PAST_DUE' AND s.grace_period_end > now()))`, [provider.name]);
  const out = { due: due.length, paid: 0, failed: 0 };
  for (const s of due) {
    // Claim: push next_billing_at a day out. Success replaces it with the new period end; a decline leaves it → retried tomorrow (within grace).
    const claimed = await db.get(`UPDATE subscriptions SET next_billing_at = now() + interval '1 day' WHERE id = ? AND next_billing_at <= now() RETURNING id`, [s.id]);
    if (!claimed) continue;
    let order;
    try {
      const q = quote({ plan: s.plan, cycle: s.billing_cycle || 'MONTHLY', seats: s.seats, founding: Boolean(s.founding_until && new Date(s.founding_until) > new Date()) });
      order = await createOrder(db, { workspaceId: s.workspace_id, userId: null, provider: provider.name, kind: 'RECURRING_RENEWAL', q });
      const ev = await provider.chargeBillingKey({ bidEnc: s.billing_key_enc, order });
      const r = await processWebhookEvent(db, provider.name, ev);
      if (ev.type === 'subscription.activated' && !r.ignored) out.paid += 1; else out.failed += 1;
    } catch (e) {
      out.failed += 1;
      console.error('[billing] renewal charge failed', s.id, e.message);
      if (order) await failOrder(db, order.id, e.code || 'charge_error', e.message);
    }
  }
  return out;
}

/**
 * Early access ending notices: each workspace gets the 30-day notice once and the 7-day notice once (claimed through
 * early_notice_30_at / early_notice_7_at before sending). A workspace that only enters the window at ≤ 7 days gets the 7-day
 * notice alone. Workspaces already on a paid plan are skipped.
 */
export async function sendEarlyAccessNotices(db, env = process.env) {
  const out = { d30: 0, d7: 0, sent: 0 };
  // Retired 2026-10-20: early access no longer grants unlimited use (every workspace is on FREE limits), so there is no
  // "early access ends" to announce. Kept callable (cron route + tests); sends nothing unless EARLY_ACCESS_NOTICES=on.
  if (env.EARLY_ACCESS_NOTICES !== 'on') return out;
  const cfg = emailConfig(env);
  for (const [days, col, other] of [[7, 'early_notice_7_at', 'early_notice_30_at'], [30, 'early_notice_30_at', null]]) {
    const due = await db.all(`SELECT w.id, w.name, w.early_access_until FROM workspaces w WHERE w.deleted_at IS NULL AND w.early_access_until > now()
      AND w.early_access_until <= now() + make_interval(days => ${days}) AND w.${col} IS NULL
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.workspace_id = w.id AND s.plan <> 'FREE' AND ${GRANTS_PLAN_SQL})`);
    for (const w of due) {
      const claimed = await db.get(`UPDATE workspaces SET ${col} = now()${other ? `, ${other} = COALESCE(${other}, now())` : ''} WHERE id = ? AND ${col} IS NULL RETURNING id`, [w.id]);
      if (!claimed) continue;
      out[days === 7 ? 'd7' : 'd30'] += 1;
      const owners = await db.all(`SELECT u.id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'OWNER' AND u.status = 'ACTIVE'`, [w.id]);
      const mail = earlyAccessEndingEmail({ workspaceName: w.name, until: w.early_access_until, days, teamMonthly: PLANS.TEAM.base_monthly,
        link: cfg.appBaseUrl ? `${cfg.appBaseUrl}/app/settings#billing` : '', support: cfg.supportEmail });
      for (const o of owners) if ((await sendEmail(db, { type: `EARLY_ACCESS_ENDING_${days}D`, to: o.email, ...mail, relatedUserId: o.id, workspaceId: w.id }, env)).status === 'SENT') out.sent += 1;
    }
  }
  return out;
}
