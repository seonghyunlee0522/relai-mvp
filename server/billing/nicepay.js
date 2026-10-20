/**
 * NicePay adapter (BILLING_PROVIDER=nicepay), NicePay "start" API v1 — https://github.com/nicepayments/nicepay-manual
 *
 * Default path — one-time payment (일반결제, server approval):
 *   1. checkout creates a billing_orders row (server-side price) → the OWNER is sent to /api/billing/nicepay/pay/:orderId,
 *      a small page that opens the NicePay payment window (AUTHNICE.requestPay) for exactly order.amount.
 *   2. NicePay POSTs the authentication result to /api/billing/nicepay/return (form-urlencoded). completeReturn() checks
 *      authResultCode, the window signature sha256(authToken + clientId + amount + secretKey) and amount === order.amount,
 *      then approves: POST /v1/payments/{tid} { amount: order.amount }. The approval response must be status 'paid' with the
 *      same amount, orderId and signature sha256(tid + amount + ediDate + secretKey). Nothing is charged before approval.
 *   3. The approval becomes a normalized `subscription.activated` event (id `paid:<tid>`) carrying order_id;
 *      processWebhookEvent re-checks the amount against the order and extends current_period_end by the months bought.
 *      The NicePay webhook for the same payment has the same event id → recorded once.
 * Recurring (정기결제, billing key / bid) is implemented but off until NICEPAY_RECURRING_ENABLED=true (NicePay review pending):
 *   registerBillingKey (POST /v1/subscribe/regist, card data AES-encrypted in encData, never stored or logged),
 *   chargeBillingKey (POST /v1/subscribe/{bid}/payments; takes the bid or its stored ciphertext), expireBillingKey (POST /v1/subscribe/{bid}/expire).
 * Webhook: JSON payment object, signature sha256(tid + amount + ediDate + secretKey); NicePay expects a 200 text/html "OK".
 * Refund: POST /v1/payments/{tid}/cancel { reason, orderId } (full cancel); refundPartial adds cancelAmt (AI credit packs, partial cancel).
 *
 * Keys: NICEPAY_CLIENT_KEY (clientId) and NICEPAY_SECRET_KEY from the environment only. NICEPAY_MODE=live selects
 * api.nicepay.co.kr; anything else is the sandbox. A key/mode mismatch (live key in sandbox mode or the reverse) disables
 * the provider instead of sending a request. `fetch` is injectable: tests never reach NicePay.
 */
import { createHash, createCipheriv, timingSafeEqual } from 'node:crypto';
import { BillingError, assertProvider } from './provider.js';
import { newOrderId } from './orders.js';
import { encrypt, decrypt } from '../integrations/crypto.js';

export const NICEPAY_API = { sandbox: 'https://sandbox-api.nicepay.co.kr', live: 'https://api.nicepay.co.kr' };
export const NICEPAY_SDK = 'https://pay.nicepay.co.kr/v1/js/';
const TIMEOUT_MS = 30_000;

export const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
/** Payment window (returnUrl) signature. */
export const windowSignature = ({ authToken, clientId, amount }, secretKey) => sha256hex(`${authToken}${clientId}${amount}${secretKey}`);
/** Signature on every payment object NicePay returns or posts (approve, cancel, lookup, billing charge, webhook). */
export const paymentSignature = ({ tid, amount, ediDate }, secretKey) => sha256hex(`${tid}${amount}${ediDate}${secretKey}`);
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
/** Amount equality for NicePay values (the window posts a string, the API answers a number). */
export const sameAmount = (a, b) => /^\d+$/.test(String(a ?? '')) && Number(a) === Number(b);

/** Card data → encData. encMode A2 (AES-256-CBC, key = secretKey, iv = first 16 chars) when the key is 32 bytes, else AES-128-ECB (key = first 16). */
export function encryptCardData(plain, secretKey) {
  const key = Buffer.from(String(secretKey), 'utf8');
  if (key.length === 32) {
    const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    return { encData: Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex'), encMode: 'A2' };
  }
  const c = createCipheriv('aes-128-ecb', key.subarray(0, 16), null);
  return { encData: Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex') };
}

export function nicepayConfig(env = process.env) {
  const clientKey = String(env.NICEPAY_CLIENT_KEY || '').trim();
  const secretKey = String(env.NICEPAY_SECRET_KEY || '').trim();
  const mode = env.NICEPAY_MODE === 'live' ? 'live' : 'sandbox';
  const problems = [];
  if (!clientKey || !secretKey) problems.push('NICEPAY_CLIENT_KEY / NICEPAY_SECRET_KEY are not set');
  else if (mode === 'live' && /^S/i.test(clientKey)) problems.push('NICEPAY_MODE=live but NICEPAY_CLIENT_KEY is a sandbox key (S…)');
  else if (mode === 'sandbox' && /^R/i.test(clientKey)) problems.push('NICEPAY_CLIENT_KEY is a live key (R…) but NICEPAY_MODE is not "live"');
  return { clientKey, secretKey, mode, apiBase: NICEPAY_API[mode], sdkUrl: env.NICEPAY_SDK_URL || NICEPAY_SDK,
    recurringEnabled: env.NICEPAY_RECURRING_ENABLED === 'true', problems };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
/** What billing_events.payload keeps of a NicePay payment object: no card number, no bid, no buyer data. */
export const safePayload = (p) => ({ ...pick(p, ['resultCode', 'resultMsg', 'tid', 'cancelledTid', 'orderId', 'status', 'amount', 'balanceAmt', 'paidAt', 'failedAt', 'cancelledAt', 'payMethod', 'ediDate', 'goodsName']),
  ...(p?.card ? { card: pick(p.card, ['cardCode', 'cardName', 'cardQuota']) } : {}) });
const methodSummary = (p) => {
  if (!p?.card) return p?.payMethod ? String(p.payMethod) : undefined;
  const last4 = String(p.card.cardNum || '').replace(/\D/g, '').slice(-4);
  return `${p.card.cardName || '카드'}${last4 ? ` ****${last4}` : ''}`;
};
/** Case-insensitive field read (the billing-key docs show both camelCase and PascalCase). */
const field = (o, name) => { if (!o) return undefined; const k = Object.keys(o).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? o[k] : undefined; };

export function createNicepayProvider({ env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const cfg = nicepayConfig(env);
  if (cfg.problems.length) throw new BillingError(503, 'provider_misconfigured', cfg.problems.join('; '));
  const auth = `Basic ${Buffer.from(`${cfg.clientKey}:${cfg.secretKey}`).toString('base64')}`;
  const ediDate = () => new Date().toISOString();
  const verifyPayment = (p) => p?.signature && safeEqual(p.signature, paymentSignature(p, cfg.secretKey));

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(cfg.apiBase + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json;charset=utf-8' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) { const err = new BillingError(502, 'provider_unavailable', '결제사 응답이 없습니다. 잠시 후 다시 시도해 주세요.'); err.network = true; err.cause = e; throw err; }
    let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
    if (!json) throw new BillingError(502, 'provider_bad_response', '결제사 응답을 해석할 수 없습니다.');
    return json;
  }

  /** Normalized event for a NicePay payment object tied to one of our orders. */
  const eventFromPayment = (p, extra = {}) => {
    const status = String(p.status || '');
    const payment = { amount: Number(p.amount), currency: p.currency || 'KRW', provider_tid: p.tid, moid: p.orderId, provider_result_code: p.resultCode,
      ...(p.receiptUrl ? { receipt_url: String(p.receiptUrl).slice(0, 500) } : {}) };
    if (status === 'paid') return { id: `paid:${p.tid}`, type: 'subscription.activated', order_id: p.orderId, payment_method_summary: methodSummary(p),
      payment: { ...payment, status: 'PAID' }, payload: safePayload(p), ...extra };
    if (status === 'failed') return { id: `failed:${p.tid}`, type: 'payment.failed', order_id: p.orderId,
      payment: { ...payment, status: 'FAILED', failure_code: p.resultCode, failure_message: p.resultMsg }, payload: safePayload(p), ...extra };
    if (status === 'cancelled') return { id: `cancelled:${p.tid}`, type: 'payment.refunded', order_id: p.orderId, refund_tid: p.cancelledTid || p.tid, payload: safePayload(p), ...extra };
    return { id: `${status || 'unknown'}:${p.cancelledTid || p.tid}`, type: `nicepay.${status || 'unknown'}`, order_id: p.orderId, payload: safePayload(p), ...extra };
  };

  return assertProvider({
    name: 'nicepay',
    mode: cfg.mode,
    recurringEnabled: cfg.recurringEnabled,
    sdkUrl: cfg.sdkUrl,

    async createCheckout({ order }) {
      if (!order) throw new BillingError(500, 'order_required', '주문 정보가 없습니다.');
      return { session_id: order.id, checkout_url: `/api/billing/nicepay/pay/${encodeURIComponent(order.id)}` };
    },

    /** Parameters for AUTHNICE.requestPay — the amount and goods name come from the order, never from the client. */
    payWindowParams(order, { returnUrl, customer = {} }) {
      return { clientId: cfg.clientKey, method: 'card', orderId: order.id, amount: Number(order.amount), goodsName: order.goods_name.slice(0, 40), returnUrl,
        ...(customer.name ? { buyerName: String(customer.name).slice(0, 30) } : {}), ...(customer.email ? { buyerEmail: String(customer.email).slice(0, 60) } : {}) };
    },

    /** Checks the payment window POST against the order. Returns the tid to approve. */
    verifyReturn(form, order) {
      if (!form || form.orderId !== order.id) throw new BillingError(400, 'order_mismatch', '주문 정보가 일치하지 않습니다.');
      if (form.authResultCode !== '0000') throw new BillingError(402, 'auth_failed', String(form.authResultMsg || '결제가 취소되었거나 인증에 실패했습니다.').slice(0, 200));
      if (form.clientId !== cfg.clientKey) throw new BillingError(400, 'client_mismatch', '결제 요청 정보가 올바르지 않습니다.');
      if (!sameAmount(form.amount, order.amount)) throw new BillingError(400, 'amount_mismatch', '결제 금액이 주문 금액과 다릅니다.');
      if (!safeEqual(form.signature, windowSignature(form, cfg.secretKey))) throw new BillingError(400, 'invalid_signature', '결제 응답 서명이 올바르지 않습니다.');
      if (!form.tid) throw new BillingError(400, 'bad_payload', '잘못된 결제 응답입니다.');
      return { tid: String(form.tid) };
    },

    /** Server approval for exactly order.amount. A lost response (timeout) is net-cancelled so the card is never left charged. */
    async approve({ tid, order }) {
      const edi = ediDate();
      let p;
      try { p = await call('POST', `/v1/payments/${encodeURIComponent(tid)}`, { amount: Number(order.amount), ediDate: edi, signData: sha256hex(`${tid}${order.amount}${edi}${cfg.secretKey}`) }); }
      catch (e) { if (e.network) await this.netCancel(order.id).catch(() => {}); throw e; }
      if (p.resultCode !== '0000' || p.status !== 'paid') throw new BillingError(402, 'payment_failed', String(p.resultMsg || '결제 승인에 실패했습니다.').slice(0, 200));
      if (!verifyPayment(p) || p.orderId !== order.id || !sameAmount(p.amount, order.amount) || p.tid !== tid) {
        await this.refundTid({ tid, orderId: order.id, reason: '승인 응답 검증 실패' }).catch(() => {});
        throw new BillingError(502, 'approval_unverified', '결제 승인 응답을 확인할 수 없어 결제를 취소했습니다.');
      }
      return p;
    },

    /**
     * returnUrl handler core: verify the window result, approve, return the normalized paid event.
     * `claim` (optional) runs after verification and before approval; when it returns false nothing is approved and null is returned.
     */
    async completeReturn({ form, order, claim = null }) {
      const { tid } = this.verifyReturn(form, order);
      if (claim && !(await claim(tid))) return null;
      return eventFromPayment(await this.approve({ tid, order }));
    },

    async handleWebhook({ rawBody }) {
      let p;
      try { p = JSON.parse(rawBody.toString('utf8')); } catch { throw new BillingError(400, 'bad_payload', '잘못된 요청입니다.'); }
      if (!p?.tid || !p?.status) throw new BillingError(400, 'bad_payload', '잘못된 요청입니다.');
      if (!verifyPayment(p)) throw new BillingError(400, 'invalid_signature', '서명이 올바르지 않습니다.');
      return eventFromPayment(p);
    },
    /** NicePay counts a notification as delivered only on 200 text/html "OK". */
    webhookAck(res) { res.status(200).type('text/html').send('OK'); },

    /** OWNER cancel: one-time purchases have nothing to cancel at NicePay; a billing key is expired. */
    async cancel({ subscription }) {
      if (subscription?.billing_key_enc) await this.expireBillingKey(decrypt(subscription.billing_key_enc, env));
      return { ok: true };
    },

    async refundTid({ tid, orderId, reason, cancelAmt }) {
      const edi = ediDate();
      const p = await call('POST', `/v1/payments/${encodeURIComponent(tid)}/cancel`, { reason: String(reason || '환불').slice(0, 100), orderId, ediDate: edi,
        ...(cancelAmt ? { cancelAmt: Number(cancelAmt) } : {}), signData: sha256hex(`${tid}${edi}${cfg.secretKey}`) });
      if (p.resultCode !== '0000' || !['cancelled', 'partialCancelled'].includes(p.status)) throw new BillingError(402, 'refund_failed', String(p.resultMsg || '환불에 실패했습니다.').slice(0, 200));
      if (!verifyPayment(p)) throw new BillingError(502, 'refund_unverified', '환불 응답 서명을 확인할 수 없습니다. 결제사 관리자에서 상태를 확인해 주세요.');
      return p;
    },
    /** Full refund of a paid order → normalized payment.refunded event. */
    async refund({ order, reason }) {
      if (!order?.provider_tid) throw new BillingError(409, 'not_refundable', '환불할 결제가 없습니다.');
      return eventFromPayment(await this.refundTid({ tid: order.provider_tid, orderId: order.id, reason }));
    },
    /** Partial cancel of `amount` on a paid order (AI credit pack refund). Returns { cancelled_tid, balance_amount }. */
    async refundPartial({ order, amount, reason }) {
      if (!order?.provider_tid) throw new BillingError(409, 'not_refundable', '환불할 결제가 없습니다.');
      if (!(Number.isInteger(amount) && amount > 0 && amount <= Number(order.amount))) throw new BillingError(400, 'bad_amount', '환불 금액이 올바르지 않습니다.');
      const p = await this.refundTid({ tid: order.provider_tid, orderId: order.id, reason, cancelAmt: amount });
      return { cancelled_tid: p.cancelledTid || null, balance_amount: p.balanceAmt ?? null };
    },
    async netCancel(orderId) {
      const edi = ediDate();
      return call('POST', '/v1/payments/netcancel', { orderId, ediDate: edi, signData: sha256hex(`${orderId}${edi}${cfg.secretKey}`) });
    },

    /* ---------- recurring (정기결제), behind NICEPAY_RECURRING_ENABLED ---------- */
    async registerBillingKey({ order, card, customer = {} }) {
      if (!cfg.recurringEnabled) throw new BillingError(404, 'recurring_disabled', '정기결제가 아직 열리지 않았습니다.');
      const plain = `cardNo=${card.number}&expYear=${card.exp_year}&expMonth=${card.exp_month}&idNo=${card.id_no}&cardPw=${card.password2}`;
      const edi = ediDate();
      const r = await call('POST', '/v1/subscribe/regist', { ...encryptCardData(plain, cfg.secretKey), orderId: order.id, ediDate: edi,
        signData: sha256hex(`${order.id}${edi}${cfg.secretKey}`), ...(customer.name ? { buyerName: String(customer.name).slice(0, 30) } : {}), ...(customer.email ? { buyerEmail: customer.email } : {}) });
      const bid = field(r, 'bid');
      if (field(r, 'resultCode') !== '0000' || !bid) throw new BillingError(402, 'card_registration_failed', String(field(r, 'resultMsg') || '카드 등록에 실패했습니다.').slice(0, 200));
      return { bid: String(bid), card_name: field(r, 'cardName') || null };
    },
    /** Charges order.amount on a billing key. Returns the normalized event (paid → activated, failure → payment.failed); never throws on a decline. */
    async chargeBillingKey({ bid, bidEnc, order }) {
      if (!cfg.recurringEnabled) throw new BillingError(404, 'recurring_disabled', '정기결제가 아직 열리지 않았습니다.');
      if (!bid && bidEnc) bid = decrypt(bidEnc, env);
      const edi = ediDate();
      const p = await call('POST', `/v1/subscribe/${encodeURIComponent(bid)}/payments`, { orderId: order.id, amount: Number(order.amount), goodsName: order.goods_name.slice(0, 40),
        cardQuota: '0', useShopInterest: false, ediDate: edi, signData: sha256hex(`${order.id}${bid}${edi}${cfg.secretKey}`) });
      if (p.resultCode === '0000' && p.status === 'paid') {
        if (!verifyPayment(p) || p.orderId !== order.id || !sameAmount(p.amount, order.amount)) {
          if (p.tid) await this.refundTid({ tid: p.tid, orderId: order.id, reason: '승인 응답 검증 실패' }).catch(() => {});
          throw new BillingError(502, 'approval_unverified', '결제 승인 응답을 확인할 수 없어 결제를 취소했습니다.');
        }
        return eventFromPayment(p, { billing_key_enc: encrypt(bid, env) });
      }
      const tid = p.tid || `none-${order.id}`;
      return { id: `failed:${tid}`, type: 'payment.failed', order_id: order.id, payload: safePayload(p),
        payment: { amount: Number(order.amount), currency: 'KRW', status: 'FAILED', provider_tid: tid, moid: order.id, provider_result_code: p.resultCode, failure_code: p.resultCode, failure_message: String(p.resultMsg || '').slice(0, 200) } };
    },
    async expireBillingKey(bid) {
      const orderId = newOrderId(); const edi = ediDate();
      const r = await call('POST', `/v1/subscribe/${encodeURIComponent(bid)}/expire`, { orderId, ediDate: edi, signData: sha256hex(`${orderId}${bid}${edi}${cfg.secretKey}`) });
      if (field(r, 'resultCode') !== '0000') throw new BillingError(502, 'billing_key_expire_failed', String(field(r, 'resultMsg') || '빌키 삭제에 실패했습니다.').slice(0, 200));
      return { ok: true };
    },
  });
}

/** Parses the 정기결제 card form. Throws BillingError(400) with field errors; the values are never logged or stored. */
export function parseCard(body = {}) {
  const digits = (v) => String(v ?? '').replace(/[\s-]/g, '');
  const number = digits(body.number); const [mm, yy] = String(body.expiry || '').split('/').map((x) => x.trim());
  const idNo = digits(body.id_no); const pw = String(body.password2 ?? '').trim();
  const fields = {};
  if (!/^\d{14,16}$/.test(number)) fields.number = '카드번호를 확인해 주세요.';
  if (!/^(0[1-9]|1[0-2])$/.test(mm || '') || !/^\d{2}$/.test(yy || '')) fields.expiry = '유효기간을 MM/YY 형식으로 입력해 주세요.';
  if (!/^(\d{6}|\d{10})$/.test(idNo)) fields.id_no = '생년월일 6자리 또는 사업자등록번호 10자리를 입력해 주세요.';
  if (!/^\d{2}$/.test(pw)) fields.password2 = '카드 비밀번호 앞 2자리를 입력해 주세요.';
  if (Object.keys(fields).length) { const e = new BillingError(400, 'validation_error', '입력값을 확인해 주세요.'); e.fields = fields; throw e; }
  return { number, exp_month: mm, exp_year: yy, id_no: idNo, password2: pw };
}
