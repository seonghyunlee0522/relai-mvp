/**
 * Daily billing jobs, run by GET /api/billing/cron/daily (Vercel Cron, `Authorization: Bearer $CRON_SECRET`).
 *   sendRenewalReminders — one-time Team purchases ending within 7 days: one e-mail per OWNER per period end.
 *   sendEarlyAccessNotices — retired 2026-10-20 (no early access any more): a no-op.
 *   chargeDueRenewals    — 정기결제 only (NICEPAY_RECURRING_ENABLED): charge billing keys whose next_billing_at has come, at the
 *                          renewal target (scheduled changes applied), behind the price-increase gate; declines retried ×3.
 *   notifyPriceIncreases — 30-day 증액 고지 + consent request (§13⑥).
 *   expireEndedSubscriptions — ended plans → EXPIRED, 30-day 조회 · 내보내기 window, PLAN credits expire.
 * Each row is claimed with a conditional UPDATE before any e-mail or charge, so overlapping runs never double-send or double-charge.
 * Provider calls run outside DB transactions.
 */
import { sendEmail } from '../email/service.js';
import { emailConfig } from '../email/config.js';
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { PLANS } from '../plans.js';
import { renewalReminderEmail, paymentFailedEmail, priceIncreaseEmail, renewalBlockedEmail, cancelEmail } from '../email/templates.js';
import { quote, createOrder, failOrder } from './orders.js';
import { processWebhookEvent, transition } from './subscriptions.js';

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

/** Owners (active accounts) of a workspace, for billing mail. */
const ownersOf = (db, wid) => db.all(`SELECT u.id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'OWNER' AND u.status = 'ACTIVE'`, [wid]);
async function mailOwners(db, wid, type, mail, env = process.env) {
  let sent = 0;
  for (const o of await ownersOf(db, wid)) { const r = await sendEmail(db, { type, to: o.email, ...mail, relatedUserId: o.id, workspaceId: wid }, env); if (r.status === 'SENT') sent += 1; }
  return sent;
}
const billingLink = (cfg) => (cfg.appBaseUrl ? `${cfg.appBaseUrl}/app/settings#billing` : '');

/** Retries after a declined renewal (founder spec: ×3), RETRY_EVERY_DAYS apart, inside the GRACE_DAYS PAST_DUE window. */
export const MAX_RETRIES = 3;
export const RETRY_EVERY_DAYS = 2;
export const PRICE_NOTICE_DAYS = 30;

/** The renewal amount the customer agreed to: renewal_amount, else (pre-v3 rows) the last paid period order. */
export async function agreedAmount(db, s) {
  if (s.renewal_amount !== null && s.renewal_amount !== undefined) return Number(s.renewal_amount);
  const o = await db.get(`SELECT amount FROM billing_orders WHERE workspace_id = ? AND status = 'PAID' AND kind IN ('ONE_TIME','RECURRING_FIRST','RECURRING_RENEWAL') ORDER BY paid_at DESC LIMIT 1`, [s.workspace_id]);
  return o ? Number(o.amount) : 0;
}
/**
 * Price-increase gate (전자상거래법 §13⑥, legal-review §1, design.md §10 PRICE_INCREASE_RENEWAL): a renewal may charge `amount` only when
 * it is ≤ the agreed renewal amount, or the owner consented to at least `amount` during the current period (PRICE_INCREASE on a
 * notice, or RECURRING when they scheduled the change themselves, e.g. 월간 → 연간). Closing the dialog is not consent.
 */
export async function renewalAllowed(db, s, amount) {
  if (amount <= (await agreedAmount(db, s))) return true;
  const c = await db.get(`SELECT id FROM billing_consents WHERE workspace_id = ? AND kind IN ('PRICE_INCREASE','RECURRING') AND renewal_amount >= ?
    AND created_at >= COALESCE(?::timestamptz, now() - interval '400 days') AND created_at >= now() - interval '400 days' LIMIT 1`, [s.workspace_id, amount, s.current_period_start]);
  return Boolean(c);
}

/**
 * 정기결제 renewals (NICEPAY_RECURRING_ENABLED only): charge billing keys whose next_billing_at has come, at the renewal target
 * (plan / cycle / add-ons with the scheduled changes applied, lifecycle.js). A renewal above the agreed amount without consent is
 * not charged: auto-renewal stops, the plan runs to its end, the owner gets a mail. A decline → PAST_DUE (7-day grace), retried
 * every RETRY_EVERY_DAYS up to MAX_RETRIES times, a mail each time. Rows are claimed by a conditional UPDATE (no double charge).
 */
export async function chargeDueRenewals(db, provider, env = process.env) {
  if (!provider?.recurringEnabled || typeof provider.chargeBillingKey !== 'function') return { skipped: 'recurring_disabled' };
  const due = await db.all(`SELECT s.* FROM subscriptions s WHERE s.provider = ? AND s.auto_renew AND s.billing_key_enc IS NOT NULL AND NOT s.cancel_at_period_end
    AND s.next_billing_at <= now() AND s.retry_count <= ${MAX_RETRIES} AND (s.status = 'ACTIVE' OR (s.status = 'PAST_DUE' AND s.grace_period_end > now()))`, [provider.name]);
  const out = { due: due.length, paid: 0, failed: 0, blocked: 0 };
  const cfg = emailConfig(env);
  const { renewalTarget } = await import('./lifecycle.js');
  for (const s of due) {
    // Claim: push next_billing_at out by the retry spacing. Success replaces it with the new period end; a decline leaves it (= the next retry).
    const claimed = await db.get(`UPDATE subscriptions SET next_billing_at = now() + make_interval(days => ${RETRY_EVERY_DAYS}) WHERE id = ? AND next_billing_at <= now() RETURNING id`, [s.id]);
    if (!claimed) continue;
    let order;
    try {
      const t = await renewalTarget(db, s);
      const ws = await db.get('SELECT name FROM workspaces WHERE id = ?', [s.workspace_id]);
      if (t.amount === null || !(await renewalAllowed(db, s, t.amount))) {
        const agreed = await agreedAmount(db, s);
        await db.run(`UPDATE subscriptions SET auto_renew = false, cancel_at_period_end = true, next_billing_at = NULL, updated_at = now() WHERE id = ?`, [s.id]);
        await db.run(`UPDATE price_change_notices SET declined_at = now() WHERE subscription_id = ? AND consented_at IS NULL AND declined_at IS NULL`, [s.id]);
        await db.run('INSERT INTO subscription_events (id, subscription_id, event_type, metadata) VALUES (?,?,?,?)', [randomUUID(), s.id, 'renewal.blocked:price_increase', JSON.stringify({ amount: t.amount, agreed })]);
        if (provider.cancel) await provider.cancel({ subscription: s }).catch((e) => console.error('[billing] billing key expiry failed', s.id, e.message));
        await db.run('UPDATE subscriptions SET billing_key_enc = NULL WHERE id = ?', [s.id]);
        await mailOwners(db, s.workspace_id, 'BILLING_RENEWAL_BLOCKED', renewalBlockedEmail({ workspaceName: ws?.name || '', planLabel: PLANS[s.plan]?.label || s.plan, amount: t.amount || 0, agreed,
          periodEnd: s.current_period_end, link: billingLink(cfg), support: cfg.supportEmail }), env);
        out.blocked += 1; continue;
      }
      const start = new Date(s.current_period_end || Date.now()); const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + t.months);
      const q = { ...quote({ plan: t.plan, cycle: t.cycle, extra_users: t.extra_users, extra_projects: t.extra_projects }), period_start: start.toISOString(), period_end: end.toISOString() };
      order = await createOrder(db, { workspaceId: s.workspace_id, userId: null, provider: provider.name, kind: 'RECURRING_RENEWAL', q });
      const ev = await provider.chargeBillingKey({ bidEnc: s.billing_key_enc, order });
      const r = await processWebhookEvent(db, provider.name, ev);
      if (ev.type === 'subscription.activated' && !r.ignored) { out.paid += 1; continue; }
      out.failed += 1;
      const now = await db.get('SELECT retry_count, grace_period_end, next_billing_at FROM subscriptions WHERE id = ?', [s.id]);
      const final = Number(now?.retry_count || 0) > MAX_RETRIES;
      await mailOwners(db, s.workspace_id, 'BILLING_PAYMENT_FAILED', paymentFailedEmail({ workspaceName: ws?.name || '', planLabel: PLANS[t.plan]?.label || t.plan, amount: q.total,
        attempt: Number(now?.retry_count || 1), max: MAX_RETRIES, nextAttemptAt: final ? null : now?.next_billing_at, graceEnd: now?.grace_period_end, final, link: billingLink(cfg), support: cfg.supportEmail }), env);
    } catch (e) {
      out.failed += 1;
      console.error('[billing] renewal charge failed', s.id, e.message);
      if (order) await failOrder(db, order.id, e.code || 'charge_error', e.message);
    }
  }
  return out;
}

/**
 * 증액 사전 고지: renewing subscriptions due within PRICE_NOTICE_DAYS whose renewal target is above the agreed amount and not yet
 * consented get one price_change_notices row (per renewal date) and a mail to the owners. The renewal gate does the rest.
 */
export async function notifyPriceIncreases(db, env = process.env) {
  const rows = await db.all(`SELECT s.* FROM subscriptions s WHERE s.status = 'ACTIVE' AND s.auto_renew AND NOT s.cancel_at_period_end AND s.billing_key_enc IS NOT NULL
    AND s.next_billing_at > now() AND s.next_billing_at <= now() + make_interval(days => ${PRICE_NOTICE_DAYS})`);
  const cfg = emailConfig(env);
  const { renewalTarget } = await import('./lifecycle.js');
  let notified = 0;
  for (const s of rows) {
    const t = await renewalTarget(db, s);
    if (t.amount === null || (await renewalAllowed(db, s, t.amount))) continue;
    const old = await agreedAmount(db, s);
    const n = await db.get(`INSERT INTO price_change_notices (id, subscription_id, workspace_id, old_amount, new_amount, effective_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT (subscription_id, effective_at) DO NOTHING RETURNING id`, [randomUUID(), s.id, s.workspace_id, old, t.amount, s.next_billing_at]);
    if (!n) continue;
    const ws = await db.get('SELECT name FROM workspaces WHERE id = ?', [s.workspace_id]);
    await mailOwners(db, s.workspace_id, 'BILLING_PRICE_INCREASE', priceIncreaseEmail({ workspaceName: ws?.name || '', planLabel: PLANS[t.plan]?.label || t.plan, oldAmount: old, newAmount: t.amount,
      effectiveAt: s.next_billing_at, link: billingLink(cfg), support: cfg.supportEmail }), env);
    notified += 1;
  }
  return { due: rows.length, notified };
}

/**
 * Status hygiene after the end: ACTIVE subscriptions that will not renew and whose period has passed, and PAST_DUE ones whose grace
 * is over, become EXPIRED (ended_at, 30-day data_retention_until), their billing key is expired, scheduled changes lapse and PLAN
 * credits expire. The effective plan is already FREE at that moment (GRANTS_PLAN_SQL); this only records it.
 */
export async function expireEndedSubscriptions(db, provider) {
  const rows = await db.all(`SELECT * FROM subscriptions WHERE (status = 'ACTIVE' AND (cancel_at_period_end OR NOT auto_renew) AND current_period_end IS NOT NULL AND current_period_end <= now())
    OR (status = 'PAST_DUE' AND grace_period_end IS NOT NULL AND grace_period_end <= now())`);
  let expired = 0;
  const { expirePlanCredits } = await import('./ai-grants.js');
  for (const s of rows) {
    try {
      if (s.billing_key_enc && provider?.cancel) await provider.cancel({ subscription: s }).catch((e) => console.error('[billing] billing key expiry failed', s.id, e.message));
      const done = await tx(db, async (t) => {
        const cur = await t.get('SELECT * FROM subscriptions WHERE id = ? FOR UPDATE', [s.id]);
        const ended = cur && ((cur.status === 'ACTIVE' && (cur.cancel_at_period_end || !cur.auto_renew) && cur.current_period_end && new Date(cur.current_period_end) <= new Date())
          || (cur.status === 'PAST_DUE' && cur.grace_period_end && new Date(cur.grace_period_end) <= new Date()));
        if (!ended) return false;
        await transition(t, cur, 'subscription.expired', {});
        await t.run('UPDATE subscriptions SET billing_key_enc = NULL, auto_renew = false WHERE id = ?', [cur.id]);
        await t.run(`UPDATE subscription_changes SET status = 'CANCELED', closed_at = now() WHERE subscription_id = ? AND status = 'SCHEDULED'`, [cur.id]);
        await expirePlanCredits(t, cur.workspace_id, { reason: '기본 크레딧 소멸 (구독 종료)', referenceId: `expired:${cur.id}:${new Date(cur.current_period_end || Date.now()).toISOString().slice(0, 10)}` });
        return true;
      });
      if (done) expired += 1;
    } catch (e) { console.error('[billing] expiry failed', s.id, e.message); }
  }
  return { due: rows.length, expired };
}

/** 해지 확인 mail to the owners (period-end cancel, or immediate cancel with its refund lines). */
export async function sendCancelNotice(db, wid, { immediate, refunds = [], total = 0, executed = false } = {}, env = process.env) {
  const s = await db.get('SELECT s.plan, s.current_period_end, s.data_retention_until, w.name FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ?', [wid]);
  if (!s) return 0;
  const cfg = emailConfig(env);
  return mailOwners(db, wid, 'BILLING_CANCELED', cancelEmail({ workspaceName: s.name, planLabel: PLANS[s.plan]?.label || s.plan, immediate, periodEnd: s.current_period_end,
    refundTotal: total, refundLines: refunds, executed, retentionUntil: immediate ? s.data_retention_until : null, link: billingLink(cfg), support: cfg.supportEmail }), env);
}

/**
 * Early access ending notices — RETIRED (founder decision 2026-10-20: early access is gone, every workspace is on the Free
 * plan). Kept as a no-op so the cron route's response shape stays the same; it never sends.
 */
export async function sendEarlyAccessNotices() {
  return { d30: 0, d7: 0, sent: 0 };
}
