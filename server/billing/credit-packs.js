/**
 * AI credit top-ups (pricing v3 T2; the v2 fixed packs map onto it): prepaid credits bought through the existing NicePay one-time checkout.
 *
 *   gate     topupEligibility: effective plan PRO / TEAM (PLANS[p].topup === true), ENTERPRISE only with workspaces.enterprise_topup
 *            (contract); FREE never (spec §2.2, legal-review §8.4④) — checked by credit-routes.js before any order row exists
 *   order    createTopupOrder → billing_orders kind CREDIT_TOPUP, amount = any multiple of TOPUP_STEP_KRW in [TOPUP_STEP_KRW, TOPUP_MAX_KRW],
 *            credits = amount / CREDIT_PRICE_KRW, server-side VAT split (₩10,000 = 9,091 + 909). Old CREDIT_PACK rows are read the same way.
 *   paid     applyPackEvent (called by processWebhookEvent inside its transaction, idempotent on the event id): amount verified
 *            against the order → order PAID (+ receipt_url) → ledger PURCHASE +credits into the PURCHASED bucket (reference ORDER:<id>)
 *            → payments row. A failed or mismatched payment writes no PURCHASE row.
 *   refund   refundCredits (operator, Admin console): unused purchased credits only = min(available, PURCHASED bucket); newest order
 *            first; rule 'v3' (D5, default): 100% for credits of a top-up paid ≤ REFUND_FULL_DAYS ago even when the workspace used
 *            some, else less REFUND_FEE_PCT (rule 'v2' = the old "untouched pack only"); no fee when RELAI is at fault (noFee).
 *            The ledger REFUND row is written first (credits cannot be spent meanwhile), then one NicePay partial cancel (cancelAmt)
 *            per order, each with its own orderId (<order id>C<n>, billing_orders.refund_tid_seq — nicepay-capabilities #5); a failed
 *            cancel is restored with a +REFUND row. Orders older than the card cancel window → bank transfer by hand.
 * Spending order: PLAN → PROMO → PURCHASED (ai/credits.js buckets); purchased credits are spent oldest top-up first, so the unused
 * ones belong to the newest orders.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { CREDIT_PACKS, CREDIT_PRICE_KRW, REFUND_FULL_DAYS, REFUND_FEE_PCT, TOPUP_STEP_KRW, TOPUP_MAX_KRW, PLANS, splitVat } from '../plans.js';
import { applyCredits, ensureAccount, bucketBalances } from '../ai/credits.js';
import { effectivePlan } from './subscriptions.js';
import { newOrderId, OrderError } from './orders.js';

/** Card companies accept a cancel for about a year; older packs are refunded by bank transfer (by hand). */
export const CARD_CANCEL_DAYS = 365;
const DAY = 86400e3;

/** billing_orders kinds that buy AI credits (CREDIT_PACK = v2 rows, CREDIT_TOPUP = v3). */
export const CREDIT_ORDER_KINDS = ['CREDIT_PACK', 'CREDIT_TOPUP'];
export const isCreditOrder = (order) => CREDIT_ORDER_KINDS.includes(order?.kind);
/** Amount chips of the 충전 screen (any multiple of TOPUP_STEP_KRW up to TOPUP_MAX_KRW is accepted). */
export const TOPUP_PRESETS = [10000, 20000, 30000, 50000, 100000];
/** D5 switch: 'v3' (default) = full refund within REFUND_FULL_DAYS even when partly used; 'v2' = only an untouched pack. */
export const refundRule = () => (process.env.CREDIT_REFUND_RULE === 'v2' ? 'v2' : 'v3');

/** Pure: price of a top-up of `amount` won (VAT included). Throws OrderError(400) outside [STEP, MAX] or off the STEP grid. */
export function topupQuote(amount) {
  const a = Number(amount);
  if (!Number.isInteger(a) || a < TOPUP_STEP_KRW || a > TOPUP_MAX_KRW || a % TOPUP_STEP_KRW !== 0) {
    throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { amount: `충전 금액은 ${TOPUP_STEP_KRW.toLocaleString('ko-KR')}원 단위로 ${TOPUP_STEP_KRW.toLocaleString('ko-KR')}원~${TOPUP_MAX_KRW.toLocaleString('ko-KR')}원입니다.` });
  }
  const credits = a / CREDIT_PRICE_KRW;
  const { supply, vat } = splitVat(a);
  return { amount: a, credits, supply_amount: supply, vat_amount: vat, currency: 'KRW', unit_price_krw: CREDIT_PRICE_KRW, goods_name: `RELAI AI 크레딧 ${credits.toLocaleString('ko-KR')}` };
}

/**
 * May this workspace top up? { allowed, plan, reason } — reason 'plan_required' (FREE) | 'contract_required' (ENTERPRISE without
 * workspaces.enterprise_topup). Credits already held stay usable either way; only buying is gated (spec §2.2).
 */
export async function topupEligibility(db, wid) {
  const plan = await effectivePlan(db, wid);
  const t = PLANS[plan]?.topup;
  if (t === true) return { allowed: true, plan, reason: null };
  if (t === 'contract') {
    const w = await db.get('SELECT enterprise_topup FROM workspaces WHERE id = ?', [wid]);
    return w?.enterprise_topup ? { allowed: true, plan, reason: null } : { allowed: false, plan, reason: 'contract_required' };
  }
  return { allowed: false, plan, reason: 'plan_required' };
}

export async function createTopupOrder(db, { workspaceId, userId, provider, amount }) {
  const q = topupQuote(amount);
  const id = newOrderId();
  await db.run(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, plan, cycle, seats, months, unit_price, list_amount, discount_amount,
      supply_amount, vat_amount, amount, founding, goods_name, credits, buyer_name, buyer_email) VALUES (?,?,?,?,'CREDIT_TOPUP',NULL,NULL,NULL,NULL,?,?,0,?,?,?,false,?,?, (SELECT name FROM users WHERE id = ?), (SELECT email FROM users WHERE id = ?))`,
  [id, workspaceId, userId, provider, CREDIT_PRICE_KRW, q.amount, q.supply_amount, q.vat_amount, q.amount, q.goods_name, q.credits, userId, userId]);
  return db.get('SELECT * FROM billing_orders WHERE id = ?', [id]);
}

/** Pure: price of a v2 pack. Throws OrderError(400) for an unknown key. */
export function packQuote(key) {
  const p = CREDIT_PACKS.find((x) => x.key === String(key || ''));
  if (!p) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { pack: '충전할 크레딧 상품을 선택해 주세요.' });
  const { supply, vat } = splitVat(p.amount);
  return { pack: p.key, credits: p.credits, amount: p.amount, supply_amount: supply, vat_amount: vat, currency: 'KRW', unit_price_krw: CREDIT_PRICE_KRW,
    goods_name: `RELAI AI 크레딧 ${p.credits.toLocaleString('ko-KR')}` };
}

/** v2 callers ({ pack }) buy the same amount as a CREDIT_TOPUP order. */
export const createPackOrder = (db, { workspaceId, userId, provider, pack }) => createTopupOrder(db, { workspaceId, userId, provider, amount: packQuote(pack).amount });

const PAID_TYPES = ['subscription.activated', 'payment.succeeded'];
/**
 * A provider event about a credit order (CREDIT_TOPUP / CREDIT_PACK), inside processWebhookEvent's transaction (the billing_events row already makes
 * it idempotent per event id; a second paid event for an order that is no longer PENDING is ignored). Never touches subscriptions.
 */
export async function applyPackEvent(db, provider, order, ev, billingEventId) {
  if (PAID_TYPES.includes(ev.type)) {
    if (order.status !== 'PENDING') return { ignored: true, reason: `order_${order.status.toLowerCase()}` };
    if (!ev.payment || ev.payment.status !== 'PAID' || Number(ev.payment.amount) !== Number(order.amount)) {
      await db.run(`UPDATE billing_orders SET status = 'FAILED', failure_code = 'amount_mismatch', updated_at = now() WHERE id = ? AND status = 'PENDING'`, [order.id]);
      return { ignored: true, reason: 'amount_mismatch' };
    }
    const tid = ev.payment.provider_tid || null;
    await db.run(`UPDATE billing_orders SET status = 'PAID', provider_tid = ?, receipt_url = ?, paid_at = now(), updated_at = now() WHERE id = ?`, [tid, ev.payment.receipt_url || null, order.id]);
    const out = await applyCredits(db, { wid: order.workspace_id, amount: Number(order.credits), type: 'PURCHASE', reason: `크레딧 충전 ₩${Number(order.amount).toLocaleString('ko-KR')}`,
      createdBy: order.user_id, referenceType: 'ORDER', referenceId: order.id });
    const pay = await db.get(`INSERT INTO payments (id, workspace_id, subscription_id, plan, amount, currency, status, provider, provider_result_code, provider_tid, moid, paid_at, billing_event_id)
      VALUES (?,?,NULL,'CREDITS',?,?,'PAID',?,?,?,?,now(),?) ON CONFLICT (provider, provider_tid) DO NOTHING RETURNING id`,
    [randomUUID(), order.workspace_id, order.amount, ev.payment.currency || 'KRW', provider, ev.payment.provider_result_code || null, tid, order.id, billingEventId]);
    return { order_id: order.id, credits: Number(order.credits), balance: out.balance, payment_id: pay?.id || null };
  }
  if (ev.type === 'payment.failed') {
    if (order.status !== 'PENDING') return { ignored: true, reason: `order_${order.status.toLowerCase()}` };
    await db.run(`UPDATE billing_orders SET status = 'FAILED', provider_tid = COALESCE(?, provider_tid), failure_code = ?, failure_message = ?, updated_at = now() WHERE id = ?`,
      [ev.payment?.provider_tid || null, ev.payment?.failure_code || null, ev.payment?.failure_message || null, order.id]);
    return { order_id: order.id, status: 'FAILED' };
  }
  // A cancel notice: refunds of packs are recorded by refundCredits itself (ledger first), so the echo is only stored.
  return { ignored: true, reason: 'credit_pack_refund_recorded_by_admin' };
}

/** Paid credit orders with credits not yet refunded, newest first. */
const refundablePacks = (db, wid) => db.all(`SELECT * FROM billing_orders WHERE workspace_id = ? AND kind IN ('CREDIT_PACK','CREDIT_TOPUP') AND status = 'PAID' AND credits > refunded_credits
  ORDER BY paid_at DESC, created_at DESC`, [wid]);

/** Unused purchased credits that can be refunded now: min(available, PURCHASED bucket). Free / plan credits never count. */
export async function refundableCredits(db, wid) {
  const b = await bucketBalances(db, wid);
  return Math.max(0, Math.min(b.available, b.purchased));
}

/**
 * Pure refund calculation. `packs` newest first ({ id, credits, refunded_credits, paid_at, amount }); `unused` = unused purchased
 * credits of the workspace (they belong to the newest packs, because purchased credits are spent oldest first after free ones).
 * `rule` 'v3' (D5): within REFUND_FULL_DAYS of payment the refunded credits are paid back in full, used or not; 'v2': only an untouched
 * pack. `noFee` (RELAI at fault: outage, service end) waives the fee. Refund amounts round up to the won.
 * Returns { allocations: [{ order_id, credits, amount, full, manual }], credits, amount } or throws OrderError.
 */
export function refundQuote({ credits, packs, unused, now = new Date(), rule = refundRule(), noFee = false }) {
  const n = Number(credits);
  if (!Number.isInteger(n) || n <= 0) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { credits: '환불할 크레딧 수를 입력해 주세요.' });
  if (n > unused) throw new OrderError(409, 'exceeds_refundable', `환불할 수 있는 미사용 구매 크레딧은 ${unused.toLocaleString('ko-KR')}입니다. 무료 크레딧은 환불되지 않습니다.`, { credits: `최대 ${unused}` });
  let left = n; let unusedLeft = unused; const allocations = [];
  for (const p of packs) {
    if (left <= 0) break;
    const open = Number(p.credits) - Number(p.refunded_credits || 0);
    const packUnused = Math.min(open, unusedLeft); unusedLeft -= packUnused;
    const take = Math.min(left, packUnused);
    if (take <= 0) continue;
    const age = now.getTime() - new Date(p.paid_at).getTime();
    const fresh = age <= REFUND_FULL_DAYS * DAY;   // 청약철회 window
    const full = noFee || (rule === 'v2' ? fresh && !Number(p.refunded_credits) && packUnused === Number(p.credits) : fresh);
    const gross = take * CREDIT_PRICE_KRW;
    allocations.push({ order_id: p.id, credits: take, amount: full ? gross : Math.ceil((gross * (100 - REFUND_FEE_PCT)) / 100), full, manual: age > CARD_CANCEL_DAYS * DAY });
    left -= take;
  }
  if (left > 0) throw new OrderError(409, 'exceeds_refundable', '환불할 수 있는 구매 내역이 부족합니다.');
  return { allocations, credits: n, amount: allocations.reduce((s, a) => s + a.amount, 0) };
}

/** Quote for a workspace (reads packs + unused purchased credits). */
export async function refundQuoteFor(db, wid, credits, { noFee = false } = {}) {
  return refundQuote({ credits, packs: await refundablePacks(db, wid), unused: await refundableCredits(db, wid), noFee });
}

/**
 * Operator refund. Ledger first, provider second, restore on failure. Returns { credits, amount, allocations[], failed[] }.
 */
export async function refundCredits(db, provider, { wid, credits, reason, adminUserId, noFee = false }) {
  // 1. Re-quote and take the credits out of the wallet atomically (account row locked by applyCredits).
  const plan = await tx(db, async (t) => {
    await ensureAccount(t, wid);
    await t.get('SELECT workspace_id FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [wid]);
    const q = await refundQuoteFor(t, wid, credits, { noFee });
    await applyCredits(t, { wid, amount: -q.credits, type: 'REFUND', reason: `구매 크레딧 환불 ₩${q.amount.toLocaleString('ko-KR')}${reason ? ` — ${reason}` : ''}`, createdBy: adminUserId,
      referenceType: 'ORDER', referenceId: q.allocations.map((a) => a.order_id).join(',') });
    for (const a of q.allocations) {
      await t.run('UPDATE billing_orders SET refunded_credits = refunded_credits + ?, refunded_amount = refunded_amount + ?, updated_at = now() WHERE id = ?', [a.credits, a.amount, a.order_id]);
    }
    return q;
  });
  // 2. Provider partial cancel per pack (outside any transaction). Manual (old) packs are left for a bank transfer.
  const failed = [];
  for (const a of plan.allocations) {
    if (a.manual || a.amount === 0) continue;
    // Each partial cancel needs its own orderId at NicePay (nicepay-capabilities #5): <order id>C<n>, n from refund_tid_seq.
    const order = await db.get('UPDATE billing_orders SET refund_tid_seq = refund_tid_seq + 1, updated_at = now() WHERE id = ? RETURNING *', [a.order_id]);
    a.cancel_order_id = `${order.id}C${order.refund_tid_seq}`;
    try {
      const r = await provider.refundPartial({ order, amount: a.amount, reason: reason || '미사용 크레딧 환불', cancelOrderId: a.cancel_order_id });
      a.cancel_tid = r?.cancelled_tid || null;
      await db.run(`UPDATE billing_orders SET status = CASE WHEN refunded_credits >= credits THEN 'REFUNDED' ELSE status END, updated_at = now() WHERE id = ?`, [a.order_id]);
    } catch (e) {
      // 3. Restore what could not be cancelled: the credits come back as purchased credits (a positive REFUND row nets out).
      failed.push({ order_id: a.order_id, credits: a.credits, amount: a.amount, error: e.message });
      await tx(db, async (t) => {
        await applyCredits(t, { wid, amount: a.credits, type: 'REFUND', reason: `환불 실패 — 크레딧 복원 (${String(e.message).slice(0, 80)})`, createdBy: adminUserId, referenceType: 'ORDER', referenceId: a.order_id });
        await t.run('UPDATE billing_orders SET refunded_credits = refunded_credits - ?, refunded_amount = refunded_amount - ?, updated_at = now() WHERE id = ?', [a.credits, a.amount, a.order_id]);
      });
    }
  }
  const done = plan.allocations.filter((a) => !failed.some((f) => f.order_id === a.order_id));
  return { credits: done.reduce((s, a) => s + a.credits, 0), amount: done.reduce((s, a) => s + a.amount, 0), allocations: done, failed,
    manual: done.filter((a) => a.manual) };
}
