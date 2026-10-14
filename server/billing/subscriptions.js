/**
 * Subscription state (Phase 10 Billing). Provider-neutral: providers translate their webhooks into the normalized events
 * below (see provider.js) and every state change goes through `applyEvent` → `transition` here, never anywhere else.
 *
 * Status       Effective plan
 *   ACTIVE     subscription plan (FREE once cancel_at_period_end is set and current_period_end has passed)
 *   PAST_DUE   subscription plan until grace_period_end, FREE after
 *   CANCELED   FREE (ended immediately)        EXPIRED  FREE (period ended)
 * Time comparisons run in SQL against now() — never the client clock (docs/production-readiness.md §8).
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { PLANS, DEFAULT_PLAN } from '../plans.js';

export const STATUSES = ['ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'];
export const GRACE_DAYS = 7;
export const EVENT_TYPES = ['subscription.activated', 'payment.succeeded', 'payment.failed', 'subscription.canceled', 'subscription.expired'];

/** SQL predicate (alias `s`): the subscription currently grants its plan. Shared with usage.js. */
export const GRANTS_PLAN_SQL = `(
  (s.status = 'ACTIVE' AND NOT (s.cancel_at_period_end AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()))
  OR (s.status = 'PAST_DUE' AND s.grace_period_end > now()))`;

/** The plan a workspace is on right now ('FREE' without a granting subscription). */
export async function effectivePlan(db, workspaceId) {
  const r = await db.get(`SELECT s.plan FROM subscriptions s WHERE s.workspace_id = ? AND ${GRANTS_PLAN_SQL}`, [workspaceId]);
  return r && PLANS[r.plan] ? r.plan : DEFAULT_PLAN;
}

const PUBLIC_COLS = 's.id, s.workspace_id, s.plan, s.status, s.provider, s.current_period_start, s.current_period_end, s.next_billing_at, s.cancel_at_period_end, s.grace_period_end, s.payment_method_summary, s.canceled_at, s.created_at, s.updated_at';
/** Customer-facing subscription (no provider ids). */
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
};

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
  if (ev.period_start) put('current_period_start', ev.period_start);
  if (ev.period_end) { put('current_period_end', ev.period_end); put('next_billing_at', ev.period_end); }
  if (ev.payment_method_summary) put('payment_method_summary', ev.payment_method_summary);
  if (ev.provider_subscription_id) put('provider_subscription_id', ev.provider_subscription_id);
  if (ev.provider_customer_id) put('provider_customer_id', ev.provider_customer_id);
  let to = rule.to;
  switch (type) {
    case 'subscription.activated':
      put('plan', ev.plan && PLANS[ev.plan] ? ev.plan : 'TEAM'); if (ev.provider) put('provider', ev.provider);
      set.push('cancel_at_period_end = false', 'grace_period_end = NULL', 'canceled_at = NULL'); break;
    case 'payment.succeeded': set.push('grace_period_end = NULL'); break;
    case 'payment.failed': set.push(`grace_period_end = COALESCE(grace_period_end, now() + interval '${GRACE_DAYS} days')`); break;
    case 'subscription.canceled':
      if (ev.immediate) { to = 'CANCELED'; set.push('canceled_at = now()', 'next_billing_at = NULL'); } else set.push('cancel_at_period_end = true', 'next_billing_at = NULL');
      break;
    case 'cancel.requested': set.push('cancel_at_period_end = true', 'next_billing_at = NULL'); break;
    case 'subscription.expired': set.push('next_billing_at = NULL'); break;
    default: break;
  }
  if (to) put('status', to);
  await db.run(`UPDATE subscriptions SET ${set.join(', ')} WHERE id = ?`, [...params, id]);
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
      let sub = await lockSubscription(db, provider, ev);
      if (!sub) {
        if (ev.type !== 'subscription.activated') return finish({ ignored: true, reason: 'no_subscription' });
        if (!ev.workspace_id || !(await db.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [ev.workspace_id]))) return finish({ ignored: true, reason: 'unknown_workspace' });
        // A concurrent activation for the same workspace may have created the row since lockSubscription ran.
        sub = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [ev.workspace_id]);
      }
      const t = await transition(db, sub, ev.type, { ...ev, provider }, { billingEventId: ins.id });
      if (!t) return finish({ ignored: true, reason: `transition_from_${sub?.status}` }, sub);
      const fresh = await db.get('SELECT * FROM subscriptions WHERE id = ?', [t.id]);
      const paymentId = await recordPayment(db, provider, fresh, ev, ins.id);
      return finish({ subscription_id: t.id, status: t.status, payment_id: paymentId }, fresh);
    });
  } catch (e) {
    if (e.code === '23505') return { duplicate: true };   // same event delivered twice concurrently: the other request owns it
    throw e;
  }
}

/** OWNER cancel: tells the provider, then marks cancel_at_period_end locally (plan stays until the period ends). */
export async function requestCancel(db, provider, workspaceId) {
  return tx(db, async (db) => {
    const sub = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    if (!sub || !['ACTIVE', 'PAST_DUE'].includes(sub.status)) return { error: 'no_active_subscription' };
    if (sub.cancel_at_period_end) return { error: 'already_canceled' };
    await provider.cancel({ subscription: sub });
    await transition(db, sub, 'cancel.requested', {});
    return { ok: true };
  });
}
