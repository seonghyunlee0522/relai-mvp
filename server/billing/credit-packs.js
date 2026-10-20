/**
 * AI credit packs (AI-credits-only billing, model A): prepaid packs bought through the existing NicePay one-time checkout.
 *
 *   order    createPackOrder → billing_orders kind CREDIT_PACK, server-side price (VAT included: ₩10,000 = 9,091 + 909), credits
 *   paid     applyPackEvent (called by processWebhookEvent inside its transaction, idempotent on the event id): amount verified
 *            against the order → order PAID (+ receipt_url) → ledger PURCHASE +credits (reference ORDER:<id>) → payments row
 *   refund   refundCredits (operator, Admin console): unused purchased credits only = min(available, purchased − refunded);
 *            newest pack first; 100% when that pack was bought ≤ REFUND_FULL_DAYS ago and is untouched, else less REFUND_FEE_PCT;
 *            the ledger REFUND row is written first (credits cannot be spent meanwhile), then NicePay partial cancel (cancelAmt)
 *            per pack; a failed cancel is restored with a +REFUND row. Packs older than the card cancel window → bank transfer by hand.
 * Spending order: free credits first, then purchased (credits.js balanceSplit) — so no per-pack buckets are stored.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { CREDIT_PACKS, CREDIT_PRICE_KRW, REFUND_FULL_DAYS, REFUND_FEE_PCT, splitVat } from '../plans.js';
import { applyCredits, ensureAccount, getBalance, balanceSplit } from '../ai/credits.js';
import { newOrderId, OrderError } from './orders.js';

/** Card companies accept a cancel for about a year; older packs are refunded by bank transfer (by hand). */
export const CARD_CANCEL_DAYS = 365;
const DAY = 86400e3;

/** Pure: price of a pack. Throws OrderError(400) for an unknown key. */
export function packQuote(key) {
  const p = CREDIT_PACKS.find((x) => x.key === String(key || ''));
  if (!p) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { pack: '충전할 크레딧 상품을 선택해 주세요.' });
  const { supply, vat } = splitVat(p.amount);
  return { pack: p.key, credits: p.credits, amount: p.amount, supply_amount: supply, vat_amount: vat, currency: 'KRW', unit_price_krw: CREDIT_PRICE_KRW,
    goods_name: `RELAI AI 크레딧 ${p.credits.toLocaleString('ko-KR')}` };
}

export async function createPackOrder(db, { workspaceId, userId, provider, pack }) {
  const q = packQuote(pack);
  const id = newOrderId();
  await db.run(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, plan, cycle, seats, months, unit_price, list_amount, discount_amount,
      supply_amount, vat_amount, amount, founding, goods_name, credits, buyer_name, buyer_email) VALUES (?,?,?,?,'CREDIT_PACK',NULL,NULL,NULL,NULL,?,?,0,?,?,?,false,?,?, (SELECT name FROM users WHERE id = ?), (SELECT email FROM users WHERE id = ?))`,
  [id, workspaceId, userId, provider, q.amount, q.amount, q.supply_amount, q.vat_amount, q.amount, q.goods_name, q.credits, userId, userId]);
  return db.get('SELECT * FROM billing_orders WHERE id = ?', [id]);
}

const PAID_TYPES = ['subscription.activated', 'payment.succeeded'];
/**
 * A provider event about a CREDIT_PACK order, inside processWebhookEvent's transaction (the billing_events row already makes
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

/** Paid packs with credits not yet refunded, newest first. */
const refundablePacks = (db, wid) => db.all(`SELECT * FROM billing_orders WHERE workspace_id = ? AND kind = 'CREDIT_PACK' AND status = 'PAID' AND credits > refunded_credits
  ORDER BY paid_at DESC, created_at DESC`, [wid]);

/** Unused purchased credits that can be refunded now: min(available, purchased − refunded). Free credits never count. */
export async function refundableCredits(db, wid) {
  const split = await balanceSplit(db, wid);
  const { available } = await getBalance(db, wid);
  return Math.max(0, Math.min(available, split.purchased - split.refunded));
}

/**
 * Pure refund calculation. `packs` newest first ({ id, credits, refunded_credits, paid_at, amount }); `unused` = unused purchased
 * credits of the workspace (they belong to the newest packs, because purchased credits are spent oldest first after free ones).
 * Returns { allocations: [{ order_id, credits, amount, full, manual }], credits, amount } or throws OrderError.
 */
export function refundQuote({ credits, packs, unused, now = new Date() }) {
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
    const full = age <= REFUND_FULL_DAYS * DAY && !Number(p.refunded_credits) && packUnused === Number(p.credits);   // 청약철회: within 7 days, none of the pack used
    const gross = take * CREDIT_PRICE_KRW;
    allocations.push({ order_id: p.id, credits: take, amount: full ? gross : Math.floor((gross * (100 - REFUND_FEE_PCT)) / 100), full, manual: age > CARD_CANCEL_DAYS * DAY });
    left -= take;
  }
  if (left > 0) throw new OrderError(409, 'exceeds_refundable', '환불할 수 있는 구매 내역이 부족합니다.');
  return { allocations, credits: n, amount: allocations.reduce((s, a) => s + a.amount, 0) };
}

/** Quote for a workspace (reads packs + unused purchased credits). */
export async function refundQuoteFor(db, wid, credits) {
  return refundQuote({ credits, packs: await refundablePacks(db, wid), unused: await refundableCredits(db, wid) });
}

/**
 * Operator refund. Ledger first, provider second, restore on failure. Returns { credits, amount, allocations[], failed[] }.
 */
export async function refundCredits(db, provider, { wid, credits, reason, adminUserId }) {
  // 1. Re-quote and take the credits out of the wallet atomically (account row locked by applyCredits).
  const plan = await tx(db, async (t) => {
    await ensureAccount(t, wid);
    await t.get('SELECT workspace_id FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [wid]);
    const q = await refundQuoteFor(t, wid, credits);
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
    const order = await db.get('SELECT * FROM billing_orders WHERE id = ?', [a.order_id]);
    try {
      const r = await provider.refundPartial({ order, amount: a.amount, reason: reason || '미사용 크레딧 환불' });
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
