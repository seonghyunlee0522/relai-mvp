/**
 * Payment provider interface (Phase 10 Billing). The product talks to this interface only; adapters are registered in
 * `PROVIDERS` (fake for tests/dev, nicepay.js for production). No provider SDK or key lives in this repository.
 *
 *   createCheckout({ workspace, plan, order, customer, successUrl, cancelUrl }) → { session_id, checkout_url }
 *     order = the billing_orders row (orders.js) holding the server-side amount to charge
 *   handleWebhook({ rawBody: Buffer, headers })                         → normalized event (below); throws BillingError(400) on a bad signature
 *   cancel({ subscription })                                            → { ok: true } (cancellation at period end on the provider side)
 *   refund({ order, reason }) → payment.refunded event · refundPartial({ order, amount, reason }) → { cancelled_tid } (AI credit packs)
 *
 * Normalized event (what subscriptions.processWebhookEvent consumes):
 *   { id: provider event id (idempotency key), type: one of EVENT_TYPES, workspace_id?, provider_subscription_id?,
 *     provider_customer_id?, plan?, period_start?, period_end?, payment_method_summary?, immediate? (cancel),
     order_id? (billing_orders.id: amount verified against it, and it supplies workspace, plan, seats and the months bought),
 *     payment?: { amount, currency, status: 'PAID'|'FAILED', provider_tid, moid, provider_result_code, failure_code, failure_message },
 *     payload: the provider's body as stored in billing_events.payload (strip card data / billing keys before returning it) }
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createNicepayProvider } from './nicepay.js';

/** Payments are out of v1 (founder): PAYMENTS_ENABLED=true turns credit-pack and plan checkout on; anything else keeps them off.
 *  Read per call so tests and a redeploy can flip it. Starter credits, the dashboard and the ledger never depend on it. */
export const paymentsEnabled = () => /^(1|true|yes|on)$/i.test(String(process.env.PAYMENTS_ENABLED || '').trim());
export const PAYMENTS_OFF_MESSAGE = '초기 고객은 무료로 이용합니다. 지금은 결제를 받지 않습니다.';

export class BillingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const REQUIRED = ['createCheckout', 'handleWebhook', 'cancel'];
/** Throws if `p` does not implement the interface. */
export function assertProvider(p) {
  for (const m of REQUIRED) if (typeof p?.[m] !== 'function') throw new Error(`billing provider "${p?.name}" is missing ${m}()`);
  return p;
}

/**
 * Fake provider for tests and local development. Checkout returns a local URL; webhooks are JSON signed with
 * HMAC-SHA256(secret, rawBody) in `x-fake-signature`. `signedEvent()` builds such a delivery for tests.
 */
export function createFakeProvider({ secret = process.env.FAKE_BILLING_SECRET || 'fake-billing-secret' } = {}) {
  const sign = (raw) => createHmac('sha256', secret).update(raw).digest('hex');
  const calls = { checkout: [], cancel: [], refund: [] };
  return assertProvider({
    name: 'fake',
    calls,
    async createCheckout({ workspace, plan, successUrl }) {
      const session_id = `fake_cs_${randomUUID()}`;
      calls.checkout.push({ session_id, workspace_id: workspace.id, plan });
      const url = new URL(successUrl || '/app/settings', 'http://local');
      url.searchParams.set('checkout', 'fake'); url.searchParams.set('session', session_id);
      return { session_id, checkout_url: `${url.pathname}${url.search}#billing` };
    },
    async handleWebhook({ rawBody, headers }) {
      const got = Buffer.from(String(headers['x-fake-signature'] || ''), 'utf8');
      const want = Buffer.from(sign(rawBody), 'utf8');
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new BillingError(400, 'invalid_signature', '서명이 올바르지 않습니다.');
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new BillingError(400, 'bad_payload', '잘못된 요청입니다.'); }
      if (!body?.id || !body?.type) throw new BillingError(400, 'bad_payload', '잘못된 요청입니다.');
      const d = body.data || {};
      return { id: body.id, type: body.type, workspace_id: d.workspace_id, provider_subscription_id: d.subscription_id, provider_customer_id: d.customer_id,
        plan: d.plan, period_start: d.period_start, period_end: d.period_end, payment_method_summary: d.payment_method_summary, immediate: Boolean(d.immediate), order_id: d.order_id,
        payment: d.payment || undefined, payload: body };
    },
    async cancel({ subscription }) { calls.cancel.push(subscription.id); return { ok: true }; },
    /** Full refund → normalized payment.refunded (same shape as NicePay's). */
    async refund({ order, reason }) { calls.refund.push({ order_id: order.id, amount: Number(order.amount), reason }); return { id: `cancelled:${order.provider_tid}`, type: 'payment.refunded', order_id: order.id, refund_tid: order.provider_tid, payload: {} }; },
    /** Partial cancel (AI credit pack refund). `failNextRefund` makes the next call throw (tests). */
    async refundPartial({ order, amount, reason, cancelOrderId = null }) {
      if (this.failNextRefund) { const m = this.failNextRefund; this.failNextRefund = null; throw new BillingError(402, 'refund_failed', m); }
      calls.refund.push({ order_id: order.id, amount, reason, partial: true, cancel_order_id: cancelOrderId }); return { cancelled_tid: `fake_cancel_${randomUUID()}`, balance_amount: Number(order.amount) - amount };
    },
    /** Test helper: a signed webhook delivery { body (string), headers }. */
    signedEvent(type, data = {}, id = `evt_${randomUUID()}`) {
      const body = JSON.stringify({ id, type, data });
      return { id, body, headers: { 'Content-Type': 'application/json', 'x-fake-signature': sign(Buffer.from(body)) } };
    },
  });
}

/**
 * Provider registry. `BILLING_PROVIDER` picks one; unset means "fake" outside production and "no billing" in production
 * (checkout answers 503 billing_unavailable). A misconfigured real provider (missing keys, live key in sandbox mode, …)
 * is logged and treated as "no billing" so the site still boots.
 */
const PROVIDERS = { fake: () => createFakeProvider(), nicepay: (env) => createNicepayProvider({ env }) };
export function providerFromEnv(env = process.env) {
  const name = env.BILLING_PROVIDER || (env.NODE_ENV === 'production' ? '' : 'fake');
  if (!name) return null;
  if (name === 'fake' && env.NODE_ENV === 'production' && env.BILLING_ALLOW_FAKE !== '1') return null;
  const make = PROVIDERS[name];
  if (!make) throw new Error(`unknown BILLING_PROVIDER "${name}"`);
  try { return assertProvider(make(env)); }
  catch (e) { if (e instanceof BillingError) { console.warn(`[billing] ${name} disabled: ${e.message}`); return null; } throw e; }
}
