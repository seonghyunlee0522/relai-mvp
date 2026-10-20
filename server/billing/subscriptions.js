/**
 * Subscription state (Phase 10 Billing). Provider-neutral: providers translate their webhooks into the normalized events
 * below (see provider.js) and every state change goes through `applyEvent` → `transition` here, never anywhere else.
 *
 * Status       Effective plan
 *   ACTIVE     subscription plan (FREE once current_period_end has passed and the subscription will not renew:
 *              cancel_at_period_end, or auto_renew = false for one-time purchases)
 *   PAST_DUE   subscription plan until grace_period_end, FREE after
 *   CANCELED   FREE (ended immediately)        EXPIRED  FREE (period ended)
 * Time comparisons run in SQL against now() — never the client clock (docs/production-readiness.md §8).
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { PLANS, DEFAULT_PLAN, FOUNDING_OFFER, EARLY_ACCESS } from '../plans.js';
import { grantMonthlyCredits, grantUpgradeCredits } from './ai-grants.js';
import { applyPackEvent, isCreditOrder } from './credit-packs.js';

export const STATUSES = ['ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'];
export const GRACE_DAYS = 7;
/**
 * subscriptions.data_retention_until = ended_at + RETENTION_DAYS. Founder policy 2026-10-21 supersedes the 30-day window: ending a plan
 * never deletes project data and 조회 · 내보내기 stays open with no end date (projects over the Free limit are read-only — limits.js
 * projectReadOnly). Nothing reads this column to delete or hide anything; it is kept as a marker only.
 * TODO(retention-legal): personal-data retention / destruction periods (개인정보 보호법 §21, incl. personal data inside projects;
 * payment / contract records kept separately) are set only after the legal review in hive research/relai-retention-legal.md — hook
 * them here and in maintenance.js, never by guessing a number.
 */
export const RETENTION_DAYS = 30;
/** Order kinds that change an existing period without extending it (T3). */
export const IN_PERIOD_KINDS = ['ADDON', 'UPGRADE'];
export const EVENT_TYPES = ['subscription.activated', 'payment.succeeded', 'payment.failed', 'subscription.canceled', 'subscription.expired', 'payment.refunded'];

/** SQL predicate (alias `s`): the subscription currently grants its plan. Shared with usage.js. */
export const GRANTS_PLAN_SQL = `(
  (s.status = 'ACTIVE' AND NOT ((s.cancel_at_period_end OR NOT s.auto_renew) AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()))
  OR (s.status = 'PAST_DUE' AND s.grace_period_end > now()))`;

/**
 * SQL expression (workspace alias `w`): the plan key the workspace is on right now — the same rule as effectivePlan().
 * Early access no longer grants a plan (retired 2026-10-20): early-access workspaces are FREE; workspaces.early_access_until is kept as history.
 */
export const EFFECTIVE_PLAN_SQL = `COALESCE((SELECT s.plan FROM subscriptions s WHERE s.workspace_id = w.id AND ${GRANTS_PLAN_SQL}), '${DEFAULT_PLAN}')`;

/**
 * The plan a workspace is on right now: a granting subscription's plan (an existing TEAM keeps working until its period ends),
 * else FREE — early access is retired as an unlimited plan (founder decision 2026-10-20). Time is compared in SQL (never the client clock).
 */
export async function effectivePlan(db, workspaceId) {
  const r = await db.get(`SELECT (SELECT s.plan FROM subscriptions s WHERE s.workspace_id = w.id AND ${GRANTS_PLAN_SQL}) AS plan FROM workspaces w WHERE w.id = ?`, [workspaceId]);
  return r?.plan && PLANS[r.plan] ? r.plan : DEFAULT_PLAN;
}

/**
 * Early access (AI-credits-only billing): workspaces created on or before EARLY_ACCESS.cutoff get
 * early_access_until = max(created_at, launch) + EARLY_ACCESS.months. `workspaceId` null = every workspace still without it
 * (the v41 backfill; re-running changes nothing). Returns the number of workspaces set.
 */
export async function grantEarlyAccess(db, workspaceId = null) {
  const r = await db.run(`UPDATE workspaces SET early_access_until = GREATEST(created_at, ?::timestamptz) + make_interval(months => ${Number(EARLY_ACCESS.months)})
    WHERE early_access_until IS NULL AND created_at <= ?::timestamptz${workspaceId ? ' AND id = ?' : ''}`, [EARLY_ACCESS.launch, EARLY_ACCESS.cutoff, ...(workspaceId ? [workspaceId] : [])]);
  return r.changes;
}

const PUBLIC_COLS = 's.id, s.workspace_id, s.plan, s.status, s.provider, s.current_period_start, s.current_period_end, s.next_billing_at, s.cancel_at_period_end, s.grace_period_end, s.payment_method_summary, s.canceled_at, s.created_at, s.updated_at, s.seats, s.billing_cycle, s.auto_renew, s.founding_until, s.extra_users, s.extra_projects, s.renewal_amount, s.retry_count, s.ended_at, s.data_retention_until';
/** Customer-facing subscription (no provider ids, no billing key). */
export const getSubscription = (db, workspaceId) => db.get(`SELECT ${PUBLIC_COLS} FROM subscriptions s WHERE s.workspace_id = ?`, [workspaceId]);

/**
 * Allowed transitions per event. `from: null` = no subscription row yet. Anything not listed is recorded and ignored
 * (e.g. a late payment.failed after the subscription expired).
 */
const RULES = {
  'subscription.activated': { from: [null, 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'], to: 'ACTIVE' },
  'payment.succeeded': { from: ['ACTIVE', 'PAST_DUE'], to: 'ACTIVE' },
  'payment.failed': { from: ['ACTIVE', 'PAST_DUE'], to: 'PAST_DUE' },
  'subscription.canceled': { from: ['ACTIVE', 'PAST_DUE'], to: null },   // to: CANCELED when immediate, else stays (cancel_at_period_end)
  'subscription.expired': { from: ['ACTIVE', 'PAST_DUE', 'CANCELED'], to: 'EXPIRED' },
  'cancel.requested': { from: ['ACTIVE', 'PAST_DUE'], to: null },        // local: OWNER pressed "해지"; the provider confirms later
  'payment.refunded': { from: ['ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'], to: null },   // period shortened by the refunded order; CANCELED if nothing is left
};

/** SQL: where an extension starts — the current end while the plan still runs (or a renewing subscription's end), else now. */
const EXTEND_BASE = `CASE WHEN status IN ('ACTIVE','PAST_DUE') AND current_period_end IS NOT NULL AND (auto_renew OR current_period_end > now()) THEN current_period_end ELSE now() END`;

/** The one place subscription rows change. `sub` must be locked (FOR UPDATE) by the caller's transaction. Returns the new status or null if ignored. */
export async function transition(db, sub, type, ev = {}, { billingEventId = null } = {}) {
  const rule = RULES[type];
  const from = sub ? sub.status : null;
  if (!rule || !rule.from.includes(from)) {
    if (sub) await addSubEvent(db, sub.id, `IGNORED:${type}`, { from, billing_event_id: billingEventId });
    return null;
  }
  let id = sub?.id;
  if (!sub) {
    id = randomUUID();
    await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider) VALUES (?,?,?,'ACTIVE',?)`, [id, ev.workspace_id, ev.plan || 'TEAM', ev.provider || null]);
  }
  const set = ['updated_at = now()']; const params = [];
  const put = (col, v) => { set.push(`${col} = ?`); params.push(v); };
  const months = Number(ev.extend_months) || 0;
  const autoRenew = ev.auto_renew === undefined ? null : Boolean(ev.auto_renew);
  if (months > 0) {
    // Purchase of `months`: extends from the current end (no time lost when renewing early), else from now. RHS sees the old row.
    set.push(`current_period_start = CASE WHEN status IN ('ACTIVE','PAST_DUE') AND current_period_end > now() THEN COALESCE(current_period_start, now()) ELSE now() END`,
      `current_period_end = ${EXTEND_BASE} + make_interval(months => ${months})`,
      `next_billing_at = ${autoRenew === false ? 'NULL' : `${EXTEND_BASE} + make_interval(months => ${months})`}`);
  } else {
    if (ev.period_start) put('current_period_start', ev.period_start);
    if (ev.period_end) { put('current_period_end', ev.period_end); put('next_billing_at', ev.period_end); }
  }
  if (autoRenew !== null) put('auto_renew', autoRenew);
  if (ev.seats) put('seats', Number(ev.seats));
  if (ev.billing_cycle) put('billing_cycle', ev.billing_cycle);
  if (ev.billing_key_enc) put('billing_key_enc', ev.billing_key_enc);
  if (ev.payment_method_summary) put('payment_method_summary', ev.payment_method_summary);
  if (ev.provider_subscription_id) put('provider_subscription_id', ev.provider_subscription_id);
  if (ev.provider_customer_id) put('provider_customer_id', ev.provider_customer_id);
  let to = rule.to;
  switch (type) {
    case 'subscription.activated':
      put('plan', ev.plan && PLANS[ev.plan] ? ev.plan : 'TEAM'); if (ev.provider) put('provider', ev.provider);
      set.push('cancel_at_period_end = false', 'grace_period_end = NULL', 'canceled_at = NULL');
      if (!ev.keep_period) set.push('retry_count = 0', 'last_failed_at = NULL', 'ended_at = NULL', 'data_retention_until = NULL');
      break;
    case 'payment.succeeded': set.push('grace_period_end = NULL', 'retry_count = 0', 'last_failed_at = NULL'); break;
    case 'payment.failed': set.push(`grace_period_end = COALESCE(grace_period_end, now() + interval '${GRACE_DAYS} days')`, 'retry_count = retry_count + 1', 'last_failed_at = now()'); break;
    case 'subscription.canceled':
      if (ev.immediate) { to = 'CANCELED'; set.push('canceled_at = now()', 'next_billing_at = NULL', 'ended_at = now()', `data_retention_until = now() + interval '${RETENTION_DAYS} days'`); } else set.push('cancel_at_period_end = true', 'next_billing_at = NULL');
      break;
    case 'cancel.requested': set.push('cancel_at_period_end = true', 'auto_renew = false', 'next_billing_at = NULL'); break;
    case 'subscription.expired': set.push('next_billing_at = NULL', 'ended_at = COALESCE(ended_at, LEAST(now(), COALESCE(current_period_end, now())))',
      `data_retention_until = COALESCE(data_retention_until, LEAST(now(), COALESCE(current_period_end, now())) + interval '${RETENTION_DAYS} days')`); break;
    case 'payment.refunded': {
      const back = Number(ev.revoke_months) || 0;
      if (back > 0) set.push(`current_period_end = current_period_end - make_interval(months => ${back})`);
      break;
    }
    default: break;
  }
  if (to) put('status', to);
  await db.run(`UPDATE subscriptions SET ${set.join(', ')} WHERE id = ?`, [...params, id]);
  if (type === 'payment.refunded') {
    // Nothing paid is left: the plan ends now.
    const ended = await db.get(`UPDATE subscriptions SET status = 'CANCELED', canceled_at = now(), next_billing_at = NULL, updated_at = now()
      WHERE id = ? AND status IN ('ACTIVE','PAST_DUE') AND (current_period_end IS NULL OR current_period_end <= now()) RETURNING status`, [id]);
    if (ended) to = 'CANCELED';
  }
  await addSubEvent(db, id, type, { from, to: to || from, billing_event_id: billingEventId });
  return { id, status: to || from };
}

const addSubEvent = (db, subscriptionId, eventType, metadata) =>
  db.run('INSERT INTO subscription_events (id, subscription_id, event_type, metadata) VALUES (?,?,?,?)', [randomUUID(), subscriptionId, eventType, JSON.stringify(metadata)]);

/** Lock the subscription an event refers to: provider subscription id first, then workspace. */
async function lockSubscription(db, provider, ev) {
  if (ev.provider_subscription_id) {
    const s = await db.get('SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ? FOR UPDATE', [provider, ev.provider_subscription_id]);
    if (s) return s;
  }
  if (ev.workspace_id) return db.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [ev.workspace_id]);
  return null;
}

async function recordPayment(db, provider, sub, ev, billingEventId) {
  const p = ev.payment; if (!p) return null;
  const id = randomUUID();
  const paid = p.status === 'PAID';
  const r = await db.get(`INSERT INTO payments (id, workspace_id, subscription_id, plan, amount, currency, status, provider, provider_result_code, provider_tid, moid,
      paid_at, failed_at, failure_code, failure_message, billing_event_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ${paid ? 'now()' : 'NULL'}, ${paid ? 'NULL' : 'now()'}, ?,?,?)
    ON CONFLICT (provider, provider_tid) DO NOTHING RETURNING id`,
  [id, sub.workspace_id, sub.id, sub.plan, p.amount ?? null, p.currency || 'KRW', p.status, provider, p.provider_result_code || null, p.provider_tid || null, p.moid || null,
    p.failure_code || null, p.failure_message || null, billingEventId]);
  return r ? r.id : null;
}

/**
 * Idempotent webhook processing (docs/production-readiness.md §8): insert the billing_event (UNIQUE provider + event id);
 * no row back → duplicate, done. Otherwise, in the same transaction: lock the subscription, transition, record the payment,
 * stamp processed_at. A failure rolls the event row back too, so the provider's retry reprocesses it.
 * Returns { duplicate } | { ignored, reason } | { subscription_id, status, payment_id }.
 */
export async function processWebhookEvent(db, provider, ev) {
  try {
    return await tx(db, async (db) => {
      const ins = await db.get(`INSERT INTO billing_events (id, provider, provider_event_id, event_type, workspace_id, payload) VALUES (?,?,?,?,?,?)
        ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`, [randomUUID(), provider, String(ev.id), ev.type, null, JSON.stringify(ev.payload ?? {})]);
      if (!ins) return { duplicate: true };
      const finish = async (out, sub = null) => {
        await db.run('UPDATE billing_events SET processed_at = now(), workspace_id = ?, subscription_id = ?, result = ? WHERE id = ?',
          [sub?.workspace_id || null, sub?.id || null, out.ignored ? `IGNORED:${out.reason}` : 'APPLIED', ins.id]);
        return out;
      };
      if (!EVENT_TYPES.includes(ev.type)) return finish({ ignored: true, reason: 'unknown_type' });
      let order = null;
      if (ev.order_id) {
        order = await db.get('SELECT * FROM billing_orders WHERE id = ? FOR UPDATE', [String(ev.order_id)]);
        // AI credit packs never touch the subscription: amount check → PURCHASE ledger row (billing/credit-packs.js).
        if (isCreditOrder(order)) return finish(await applyPackEvent(db, provider, order, ev, ins.id), { workspace_id: order.workspace_id, id: null });
        const checked = checkOrder(order, ev);
        if (checked.ignore) {
          if (checked.fail) await db.run(`UPDATE billing_orders SET status = 'FAILED', failure_code = ?, updated_at = now() WHERE id = ? AND status = 'PENDING'`, [checked.ignore, order.id]);
          return finish({ ignored: true, reason: checked.ignore });
        }
        ev = { ...ev, ...checked.ev };
      }
      let sub = await lockSubscription(db, provider, ev);
      if (!sub) {
        if (ev.type !== 'subscription.activated') return finish({ ignored: true, reason: 'no_subscription' });
        if (!ev.workspace_id || !(await db.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [ev.workspace_id]))) return finish({ ignored: true, reason: 'unknown_workspace' });
        // A concurrent activation for the same workspace may have created the row since lockSubscription ran.
        sub = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [ev.workspace_id]);
      }
      const t = await transition(db, sub, ev.type, { ...ev, provider }, { billingEventId: ins.id });
      if (!t) return finish({ ignored: true, reason: `transition_from_${sub?.status}` }, sub);
      if (order) await settleOrder(db, provider, order, ev, t.id, sub?.plan || null);
      const fresh = await db.get('SELECT * FROM subscriptions WHERE id = ?', [t.id]);
      const paymentId = ev.type === 'payment.refunded' ? null : await recordPayment(db, provider, fresh, ev, ins.id);
      if (PAID_TYPES.includes(ev.type) && fresh.status === 'ACTIVE') await grantMonthlyCredits(db, fresh.workspace_id);   // same transaction: paid ⇔ granted
      return finish({ subscription_id: t.id, status: t.status, payment_id: paymentId, ...(order ? { order_id: order.id } : {}) }, fresh);
    });
  } catch (e) {
    if (e.code === '23505') return { duplicate: true };   // same event delivered twice concurrently: the other request owns it
    throw e;
  }
}

const PAID_TYPES = ['subscription.activated', 'payment.succeeded'];
/**
 * Amount verification + order context for an event that names an order (ev.order_id). A paid event must carry exactly
 * order.amount; the order — not the provider — decides workspace, plan, seats and the months bought.
 * Returns { ev: extra fields } or { ignore: reason, fail?: true (mark the order FAILED) }.
 */
export function checkOrder(order, ev) {
  if (!order) return { ignore: 'unknown_order' };
  const base = { workspace_id: order.workspace_id, plan: order.plan };
  if (PAID_TYPES.includes(ev.type)) {
    if (order.status !== 'PENDING') return { ignore: `order_${order.status.toLowerCase()}` };
    if (!ev.payment || ev.payment.status !== 'PAID' || Number(ev.payment.amount) !== Number(order.amount)) return { ignore: 'amount_mismatch', fail: true };
    // ADDON / UPGRADE: same period, same renewal settings; only the plan (upgrade) and the add-ons change (settleOrder).
    if (IN_PERIOD_KINDS.includes(order.kind)) return { ev: { ...base, billing_cycle: order.cycle, keep_period: true, period_start: null, period_end: null } };
    return { ev: { ...base, seats: order.seats, billing_cycle: order.cycle, extend_months: order.months, auto_renew: order.kind !== 'ONE_TIME', period_start: null, period_end: null } };
  }
  if (ev.type === 'payment.failed') return order.status === 'PENDING' ? { ev: base } : { ignore: `order_${order.status.toLowerCase()}` };
  if (ev.type === 'payment.refunded') return order.status === 'PAID' ? { ev: { ...base, revoke_months: order.months } } : { ignore: `order_${order.status.toLowerCase()}` };
  return { ev: base };
}

/**
 * What a paid order changes on the subscription row (pricing v3, T3) — inside the webhook transaction, under the row lock, once per
 * order (the order is PENDING → PAID exactly once, so a duplicate approval never adds twice):
 *   period orders (ONE_TIME / RECURRING_FIRST / RECURRING_RENEWAL) of a v3 order: extra_users / extra_projects = what the order bought
 *     (absolute), renewal_amount = the order amount (the amount the customer agreed each renewal charges), price_version v3;
 *     a renewal also starts the new period at the order's period_start and closes the scheduled changes it applied.
 *   ADDON: extra_* += the units bought; renewal_amount = the renewal with them (shown and consented on the add-on screen).
 *   UPGRADE: plan = the new plan, extra_* = the carried add-ons, seats cleared, renewal_amount recomputed, scheduled downgrade
 *     dropped, and the monthly-credit difference for the current credit cycle (T2 grantUpgradeCredits).
 * A v2 order (bought before v3) changes nothing here: the legacy row keeps its seats until the period ends.
 */
async function applyOrderToSubscription(db, order, subscriptionId, prevPlan) {
  if (order.price_version === 'v2') return;
  const { renewalAmount } = await import('./orders.js');
  if (order.kind === 'ADDON') {
    await db.run(`UPDATE subscriptions SET extra_users = extra_users + ?, extra_projects = extra_projects + ?, updated_at = now() WHERE id = ?`,
      [Number(order.addon_users || 0), Number(order.addon_projects || 0), subscriptionId]);
  } else if (order.kind === 'UPGRADE') {
    await db.run(`UPDATE subscriptions SET plan = ?, extra_users = ?, extra_projects = ?, seats = NULL, updated_at = now() WHERE id = ?`,
      [order.plan, Number(order.addon_users || 0), Number(order.addon_projects || 0), subscriptionId]);
    await db.run(`UPDATE subscription_changes SET status = 'CANCELED', closed_at = now() WHERE subscription_id = ? AND status = 'SCHEDULED' AND kind IN ('DOWNGRADE','ADDON_REDUCE')`, [subscriptionId]);
    if (prevPlan && prevPlan !== order.plan) await grantUpgradeCredits(db, order.workspace_id, { from: prevPlan, to: order.plan, reference: order.id });
  } else if (['ONE_TIME', 'RECURRING_FIRST', 'RECURRING_RENEWAL'].includes(order.kind)) {
    await db.run(`UPDATE subscriptions SET extra_users = ?, extra_projects = ?, price_version = NULL, updated_at = now()${order.kind === 'RECURRING_RENEWAL' && order.period_start ? ', current_period_start = ?' : ''} WHERE id = ?`,
      [Number(order.addon_users || 0), Number(order.addon_projects || 0), ...(order.kind === 'RECURRING_RENEWAL' && order.period_start ? [order.period_start] : []), subscriptionId]);
    if (order.kind === 'RECURRING_RENEWAL') await db.run(`UPDATE subscription_changes SET status = 'APPLIED', closed_at = now() WHERE subscription_id = ? AND status = 'SCHEDULED'`, [subscriptionId]);
    // The slice this order paid for (refunds of unused days are computed per order, lifecycle.js).
    await db.run(`UPDATE billing_orders o SET period_end = s.current_period_end, period_start = s.current_period_end - make_interval(months => COALESCE(o.months, 1))
      FROM subscriptions s WHERE o.id = ? AND s.id = ? AND o.period_start IS NULL AND s.current_period_end IS NOT NULL`, [order.id, subscriptionId]);
  } else return;
  const s = await db.get('SELECT plan, billing_cycle, extra_users, extra_projects FROM subscriptions WHERE id = ?', [subscriptionId]);
  const next = renewalAmount(s.plan, s.billing_cycle || 'MONTHLY', Number(s.extra_users || 0), Number(s.extra_projects || 0));
  if (next !== null) await db.run('UPDATE subscriptions SET renewal_amount = ? WHERE id = ?', [next, subscriptionId]);
}

async function settleOrder(db, provider, order, ev, subscriptionId, prevPlan = null) {
  const tid = ev.payment?.provider_tid || ev.refund_tid || null;
  if (PAID_TYPES.includes(ev.type)) {
    await db.run(`UPDATE billing_orders SET status = 'PAID', provider_tid = ?, paid_at = now(), updated_at = now() WHERE id = ?`, [tid, order.id]);
    if (order.founding) await db.run(`UPDATE subscriptions SET founding_until = COALESCE(founding_until, now() + make_interval(months => ${FOUNDING_OFFER.months})) WHERE id = ?`, [subscriptionId]);
    await applyOrderToSubscription(db, order, subscriptionId, prevPlan);
  } else if (ev.type === 'payment.failed') {
    await db.run(`UPDATE billing_orders SET status = 'FAILED', provider_tid = COALESCE(?, provider_tid), failure_code = ?, failure_message = ?, updated_at = now() WHERE id = ?`,
      [tid, ev.payment?.failure_code || null, ev.payment?.failure_message || null, order.id]);
  } else if (ev.type === 'payment.refunded') {
    await db.run(`UPDATE billing_orders SET status = 'REFUNDED', updated_at = now() WHERE id = ?`, [order.id]);
    await db.run(`UPDATE payments SET status = 'REFUNDED' WHERE provider = ? AND provider_tid = ?`, [provider, order.provider_tid]);
  }
}

/**
 * OWNER cancel: marks cancel_at_period_end locally (plan stays until the period ends) and tells the provider.
 * The provider call (a network request) runs outside any DB transaction so a slow provider never holds the row lock:
 * check → provider.cancel → lock, re-check and transition. The provider cancel is idempotent, so a lost race is harmless.
 */
export async function requestCancel(db, provider, workspaceId) {
  const check = (sub) => (!sub || !['ACTIVE', 'PAST_DUE'].includes(sub.status) ? 'no_active_subscription' : sub.cancel_at_period_end ? 'already_canceled'
    : !sub.auto_renew ? 'not_recurring' : null);
  const before = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [workspaceId]);
  const err = check(before); if (err) return { error: err };
  await provider.cancel({ subscription: before });
  return tx(db, async (db) => {
    const sub = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    const e = check(sub); if (e) return { error: e };
    await transition(db, sub, 'cancel.requested', {});
    if (sub.billing_key_enc) await db.run('UPDATE subscriptions SET billing_key_enc = NULL, auto_renew = false WHERE id = ?', [sub.id]);   // billing key expired at the provider
    return { ok: true };
  });
}
