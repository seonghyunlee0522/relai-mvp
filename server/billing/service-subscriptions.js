/**
 * 서비스 월 구독 (/pay/agent, founder 2026-10-28) — the same NicePay 정기결제 the app uses (billing key, nicepay.js), for buyers without
 * a RELAI account:
 *   start    card → registerBillingKey → first charge (amount from the catalogue) → the service order is PAID through applyServiceEvent
 *            (same idempotency and amount check as the 1회 결제) → service_subscriptions row (billing key encrypted, 1-month period).
 *   renew    daily cron: due rows are claimed (next_billing_at pushed out), a new service order is charged on the stored key; paid →
 *            next period; declined → PAST_DUE, retried every RETRY_DAYS up to MAX_RETRIES, then ENDED (key expired, buyer + operator mailed).
 *   cancel   from the manage link in every receipt (HMAC of the id — nothing to store or leak): auto-renew off, billing key expired,
 *            service until the end of the paid month, no refund (해지 = 그 달까지 이용).
 * Card data never reaches the DB or a log (only NicePay's encData); the stored value is the billing key, encrypted.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BillingError } from './provider.js';
import { RECURRING_SOON, createServiceOrder, getServiceOrder, failServiceOrder, claimServiceOrder, applyServiceEvent, alertOperator, markRefundFailed } from './service-orders.js';
import { sendEmail } from '../email/service.js';
import { emailConfig } from '../email/config.js';
import { LEGAL } from '../../public/app/shared/legal-info.js';

export const RETRY_DAYS = 2;
export const MAX_RETRIES = 3;
const DAY = 86400e3;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const kday = (d) => new Date(d).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
const addMonth = (d) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + 1); return x; };

const secret = (env = process.env) => String(env.SESSION_SECRET || env.ENCRYPTION_KEY || 'relai-dev-secret');
/** Manage-link token: HMAC(id). Anyone holding the e-mail link can see and cancel that one subscription — nothing else. */
export const manageToken = (id, env = process.env) => createHmac('sha256', secret(env)).update(`service-sub:${id}`).digest('base64url').slice(0, 32);
export function validToken(id, t, env = process.env) {
  const a = Buffer.from(String(t || '')); const b = Buffer.from(manageToken(id, env));
  return a.length === b.length && timingSafeEqual(a, b);
}
export const manageUrl = (base, id, env = process.env) => `${base}/pay/agent/subscription?id=${encodeURIComponent(id)}&t=${manageToken(id, env)}`;
export const getServiceSubscription = (db, id) => db.get('SELECT * FROM service_subscriptions WHERE id = ?', [String(id || '')]);
const newId = () => `SSUB${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(8).toString('hex')}`;

/** Expire the billing key at NicePay (best effort; the row's key is cleared either way). */
async function expireKey(provider, sub) {
  if (!sub?.billing_key_enc || !provider?.cancel) return;
  await provider.cancel({ subscription: { id: sub.id, billing_key_enc: sub.billing_key_enc } }).catch((e) => console.error('[service-sub] billing key expiry failed', sub.id, e.message));
}

/**
 * First payment. → { order, subscription }. Throws BillingError (402 declined / card_registration_failed, 502 apply failed …);
 * nothing is left charged on failure (the charge is refunded, the key expired).
 */
export async function startServiceSubscription(db, provider, { product, buyer, card, now = new Date() }) {
  if (!provider?.recurringEnabled || !provider.registerBillingKey) throw new BillingError(409, 'recurring_unavailable', RECURRING_SOON);
  const order = await createServiceOrder(db, { product, buyer, provider: provider.name });
  if (!(await claimServiceOrder(db, order.id))) throw new BillingError(409, 'order_closed', '이미 처리된 주문입니다.');
  let bid = null;
  try {
    ({ bid } = await provider.registerBillingKey({ order, card, customer: { name: buyer.name, email: buyer.email } }));
    const ev = await provider.chargeBillingKey({ bid, order });
    if (ev.type !== 'subscription.activated') {
      await failServiceOrder(db, order.id, ev.payment?.failure_code || 'declined', ev.payment?.failure_message);
      await provider.expireBillingKey(bid).catch(() => {});
      throw new BillingError(402, 'payment_failed', ev.payment?.failure_message || '카드사에서 결제를 승인하지 않았습니다.');
    }
    // The subscription exists before the order turns PAID, so the receipt mail (sent by applyServiceEvent) carries the manage link.
    const id = newId(); const end = addMonth(now);
    await db.run(`INSERT INTO service_subscriptions (id, product, provider, goods_name, amount, buyer_name, buyer_company, buyer_email, buyer_phone, billing_key_enc, card_summary,
        current_period_start, current_period_end, next_billing_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, product.key, provider.name, product.goods_name, product.amount, buyer.name, buyer.company, buyer.email, buyer.phone, ev.billing_key_enc || null,
      ev.payment_method_summary || null, now.toISOString(), end.toISOString(), end.toISOString()]);
    await db.run('UPDATE service_orders SET subscription_id = ? WHERE id = ?', [id, order.id]);
    await applyServiceEvent(db, provider.name, ev).catch((e) => console.error('[service-sub] apply failed', order.id, e.message));
    const after = await getServiceOrder(db, order.id);
    if (after?.status !== 'PAID') {
      await db.run(`UPDATE service_subscriptions SET status = 'ENDED', auto_renew = false, billing_key_enc = NULL, ended_at = now(), next_billing_at = NULL, updated_at = now() WHERE id = ?`, [id]);
      try { await provider.refundTid({ tid: ev.payment?.provider_tid, orderId: order.id, reason: '결제 반영 오류로 자동 취소' }); await failServiceOrder(db, order.id, 'apply_failed', '결제를 반영하지 못했습니다.'); }
      catch (err) {
        await markRefundFailed(db, order.id, `반영 실패 후 자동 환불 실패: ${err.message}`);
        await alertOperator(db, { orderId: order.id, tid: ev.payment?.provider_tid, code: 'refund_failed', detail: `월 구독 첫 결제를 반영하지 못했고 자동 환불도 실패했습니다: ${err.message}` });
      }
      await provider.expireBillingKey(bid).catch(() => {});
      throw new BillingError(502, 'apply_failed', '결제를 반영하지 못해 자동으로 취소했습니다.');
    }
    return { order: after, subscription: await getServiceSubscription(db, id) };
  } catch (e) {
    if (e instanceof BillingError && ['payment_failed', 'apply_failed'].includes(e.code)) throw e;
    await failServiceOrder(db, order.id, e.code || 'error', e.message);
    if (bid) await provider.expireBillingKey(bid).catch(() => {});
    throw e;
  }
}

/** 해지: auto-renew off, billing key expired; service runs to current_period_end. Idempotent. */
export async function cancelServiceSubscription(db, provider, id, env = process.env) {
  const sub = await db.get(`UPDATE service_subscriptions SET auto_renew = false, canceled_at = COALESCE(canceled_at, now()), next_billing_at = NULL, updated_at = now()
    WHERE id = ? AND status <> 'ENDED' AND auto_renew RETURNING *`, [id]);
  if (!sub) return { changed: false, subscription: await getServiceSubscription(db, id) };
  await expireKey(provider, sub);
  await db.run('UPDATE service_subscriptions SET billing_key_enc = NULL WHERE id = ?', [id]);
  await mailBuyer(db, sub, 'SERVICE_SUB_CANCELED', `[RELAI] 월 구독 해지가 완료되었습니다`,
    [`${sub.goods_name} 월 구독을 해지했습니다.`, `${kday(sub.current_period_end)}까지 이용하며 이후 자동 결제되지 않습니다. 이미 결제한 금액은 환불되지 않습니다.`], env);
  return { changed: true, subscription: await getServiceSubscription(db, id) };
}

async function mailBuyer(db, sub, type, subject, lines, env = process.env) {
  const L = LEGAL;
  const html = `<!doctype html><html lang="ko"><body style="font-family:-apple-system,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#101828;background:#F4F6FA;margin:0;padding:32px 16px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E4E8EF;border-radius:12px;padding:28px 32px"><p style="font-weight:800;color:#1B4FD8">RELAI</p>
${lines.map((l) => `<p style="font-size:15px;line-height:1.6">${esc(l)}</p>`).join('')}
<p style="font-size:12px;color:#667085;border-top:1px solid #EEF1F6;padding-top:12px">${esc(L.company)} · 사업자등록번호 ${esc(L.bizNo)} · 문의 ${esc(L.contactEmail)}</p></div></body></html>`;
  return sendEmail(db, { type, to: sub.buyer_email, subject, html, text: `${lines.join('\n')}\n\n문의: ${L.contactEmail}\n`, tags: ['service-pay'] }, env)
    .catch((e) => { console.error('[service-sub] mail failed', sub.id, e.message); return null; });
}

/** Daily: renew due subscriptions, end the cancelled ones whose month is over. */
export async function serviceSubscriptionsDaily(db, provider, env = process.env, { now = new Date() } = {}) {
  const ended = await db.all(`UPDATE service_subscriptions SET status = 'ENDED', ended_at = now(), updated_at = now() WHERE status <> 'ENDED' AND NOT auto_renew AND current_period_end <= ? RETURNING id`, [now.toISOString()]);
  const out = { due: 0, paid: 0, failed: 0, ended: ended.length };
  if (!provider?.recurringEnabled || typeof provider.chargeBillingKey !== 'function') return { ...out, skipped: 'recurring_disabled' };
  const due = await db.all(`SELECT * FROM service_subscriptions WHERE provider = ? AND auto_renew AND billing_key_enc IS NOT NULL AND status IN ('ACTIVE','PAST_DUE')
    AND next_billing_at <= ? ORDER BY next_billing_at`, [provider.name, now.toISOString()]);
  out.due = due.length;
  for (const s of due) {
    const claimed = await db.get(`UPDATE service_subscriptions SET next_billing_at = ?, updated_at = now() WHERE id = ? AND next_billing_at <= ? RETURNING id`,
      [new Date(now.getTime() + RETRY_DAYS * DAY).toISOString(), s.id, now.toISOString()]);
    if (!claimed) continue;
    let order = null;
    try {
      const product = { key: s.product, kind: 'RECURRING', goods_name: s.goods_name, amount: s.amount, supply_amount: Math.round(s.amount / 1.1), vat_amount: s.amount - Math.round(s.amount / 1.1), months: 1 };
      order = await createServiceOrder(db, { product, buyer: { name: s.buyer_name, company: s.buyer_company, email: s.buyer_email, phone: s.buyer_phone }, provider: provider.name });
      await db.run('UPDATE service_orders SET subscription_id = ? WHERE id = ?', [s.id, order.id]);
      await claimServiceOrder(db, order.id);
      const ev = await provider.chargeBillingKey({ bidEnc: s.billing_key_enc, order });
      if (ev.type === 'subscription.activated') {
        const start = new Date(s.current_period_end); const end = addMonth(start);
        await db.run(`UPDATE service_subscriptions SET status = 'ACTIVE', retry_count = 0, current_period_start = ?, current_period_end = ?, next_billing_at = ?, updated_at = now() WHERE id = ?`,
          [start.toISOString(), end.toISOString(), end.toISOString(), s.id]);
        await applyServiceEvent(db, provider.name, ev);
        if ((await getServiceOrder(db, order.id))?.status !== 'PAID') await alertOperator(db, { orderId: order.id, tid: ev.payment?.provider_tid, code: 'renewal_unrecorded', detail: '월 구독 갱신 결제가 승인됐지만 주문에 반영되지 않았습니다. NICEPAY 관리자에서 확인해 주세요.' }, env);
        out.paid += 1; continue;
      }
      await failServiceOrder(db, order.id, ev.payment?.failure_code || 'declined', ev.payment?.failure_message);
      await declined(db, provider, s, ev.payment?.failure_message, env);
      out.failed += 1;
    } catch (e) {
      console.error('[service-sub] renewal failed', s.id, e.message);
      if (order) await failServiceOrder(db, order.id, e.code || 'charge_error', e.message);
      await declined(db, provider, s, e.message, env);
      out.failed += 1;
    }
  }
  return out;
}

async function declined(db, provider, s, reason, env) {
  const tries = Number(s.retry_count || 0) + 1;
  if (tries > MAX_RETRIES) {
    await db.run(`UPDATE service_subscriptions SET status = 'ENDED', auto_renew = false, retry_count = ?, next_billing_at = NULL, ended_at = now(), updated_at = now() WHERE id = ?`, [tries, s.id]);
    await expireKey(provider, s);
    await db.run('UPDATE service_subscriptions SET billing_key_enc = NULL WHERE id = ?', [s.id]);
    await mailBuyer(db, s, 'SERVICE_SUB_ENDED', '[RELAI] 월 구독 결제 실패로 구독이 종료되었습니다', [`${s.goods_name} 월 구독 결제가 ${MAX_RETRIES + 1}번 승인되지 않아 구독을 종료했습니다.`, '다시 이용하려면 결제 페이지에서 새로 구독해 주세요.'], env);
    await alertOperator(db, { orderId: s.id, code: 'subscription_ended', detail: `서비스 월 구독 결제 실패로 종료: ${s.buyer_name} (${s.buyer_email}) — ${reason || ''}` }, env);
    return;
  }
  await db.run(`UPDATE service_subscriptions SET status = 'PAST_DUE', retry_count = ?, updated_at = now() WHERE id = ?`, [tries, s.id]);
  await mailBuyer(db, s, 'SERVICE_SUB_PAYMENT_FAILED', '[RELAI] 월 구독 결제가 승인되지 않았습니다',
    [`${s.goods_name} 월 구독 ${won(s.amount)} 결제가 승인되지 않았습니다${reason ? ` (${reason})` : ''}.`, `${RETRY_DAYS}일 뒤 같은 카드로 다시 결제합니다. 카드 상태를 확인해 주세요.`], env);
}

/** What the manage page shows (no card data, no key). */
export const publicServiceSubscription = (s) => s && ({ id: s.id, goods_name: s.goods_name, amount: s.amount, status: s.status, auto_renew: s.auto_renew,
  current_period_end: s.current_period_end, next_billing_at: s.next_billing_at, canceled_at: s.canceled_at, card_summary: s.card_summary, buyer_name: s.buyer_name });
export const serviceSubBase = (req) => emailConfig().appBaseUrl || `${req.protocol}://${req.get('host')}`;
