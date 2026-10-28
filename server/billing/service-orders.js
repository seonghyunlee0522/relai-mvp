/**
 * RELAI service payments (standalone /pricing page, founder 2026-10-20): orders from buyers without a RELAI account.
 * The catalogue below is the only source of a price: the client sends a product key, never an amount. Approvals and the
 * NicePay webhook both end in applyServiceEvent, which records the event once (billing_events, same idempotency key as the
 * in-app path) and re-checks the paid amount against the order. A paid order sends the buyer one receipt e-mail.
 * Status: PENDING → APPROVING (the return handler's claim, one approval per order) → PAID | FAILED; PAID → REFUNDED.
 * Money that cannot be put right automatically (a failed refund, a webhook for the wrong amount, an approval left
 * unconfirmed) raises alertOperator: an e-mail to SUPPORT_EMAIL and a failure_code shown in 관리자 › 결제.
 */
import { randomBytes } from 'node:crypto';
import { tx } from '../db.js';
import { sendEmail } from '../email/service.js';
import { emailConfig } from '../email/config.js';
import { LEGAL } from '../../public/app/shared/legal-info.js';

const VAT_INCLUDED = (amount) => { const supply = Math.round(amount / 1.1); return { amount, supply_amount: supply, vat_amount: amount - supply }; };

/** Products on sale (founder 2026-10-20): exactly two. Prices are VAT included. */
export const SERVICE_PRODUCTS = {
  'agent-once': { key: 'agent-once', plan: 'once', product: 'agent', kind: 'ONE_TIME', title: 'AI Agent 개발 및 운영', months: 1,
    goods_name: 'AI Agent 개발 및 운영 (1개월)', ...VAT_INCLUDED(400000) },
  'agent-monthly': { key: 'agent-monthly', plan: 'monthly', product: 'agent', kind: 'RECURRING', title: 'AI Agent 개발 및 운영 월 구독', months: 1,
    goods_name: 'AI Agent 개발 및 운영 월 구독', ...VAT_INCLUDED(400000) },
};
export const productFor = (plan, product = 'agent') => Object.values(SERVICE_PRODUCTS).find((p) => p.plan === plan && p.product === product) || null;
export const RECURRING_SOON = '월 구독은 준비 중입니다.';

export class ServiceOrderError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; }
}

const yes = (v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Buyer + consent validation. Returns the clean buyer; throws ServiceOrderError(400) with field messages. */
export function parseBuyer(body = {}) {
  const b = body.buyer || body;
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const buyer = { name: s(b.name, 40), company: s(b.company, 80), email: s(b.email, 120).toLowerCase(), phone: s(b.phone, 20).replace(/[^\d+-]/g, '') };
  const fields = {};
  if (!buyer.name) fields.name = '이름을 입력해 주세요.';
  if (!EMAIL_RE.test(buyer.email)) fields.email = '이메일 주소를 확인해 주세요.';
  if (!/^\+?[\d-]{9,16}$/.test(buyer.phone) || buyer.phone.replace(/\D/g, '').length < 9) fields.phone = '연락처를 확인해 주세요.';
  if (!yes(body.agree_terms)) fields.agree_terms = '이용약관에 동의해 주세요.';
  if (!yes(body.agree_privacy)) fields.agree_privacy = '개인정보 수집·이용에 동의해 주세요.';
  if (!yes(body.agree_payment)) fields.agree_payment = '결제 진행에 동의해 주세요.';
  if (Object.keys(fields).length) throw new ServiceOrderError(400, 'validation_error', '입력값을 확인해 주세요.', fields);
  return buyer;
}

export const newServiceOrderId = () => `RELAIS${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(9).toString('hex')}`;

export async function createServiceOrder(db, { product, buyer, provider }) {
  const id = newServiceOrderId();
  await db.run(`INSERT INTO service_orders (id, product, kind, provider, goods_name, amount, supply_amount, vat_amount, months, buyer_name, buyer_company, buyer_email, buyer_phone,
      terms_version, privacy_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, product.key, product.kind, provider, product.goods_name, product.amount, product.supply_amount, product.vat_amount, product.months,
    buyer.name, buyer.company, buyer.email, buyer.phone, LEGAL.termsVersion, LEGAL.privacyVersion]);
  return getServiceOrder(db, id);
}
export const getServiceOrder = (db, id) => db.get('SELECT * FROM service_orders WHERE id = ?', [String(id || '')]);
/** Closes an open order (PENDING or APPROVING) as FAILED. */
export async function failServiceOrder(db, id, code, message) {
  await db.run(`UPDATE service_orders SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = now() WHERE id = ? AND status IN ('PENDING','APPROVING')`,
    [String(code || 'failed').slice(0, 60), String(message || '').slice(0, 300), id]);
}
/** An approved charge could not be refunded: flag the order for an operator whatever closed it (never a PAID order). */
export async function markRefundFailed(db, id, message) {
  await db.run(`UPDATE service_orders SET status = 'FAILED', failure_code = 'refund_failed', failure_message = ?, updated_at = now() WHERE id = ? AND status IN ('PENDING','APPROVING','FAILED')`,
    [String(message || '').slice(0, 300), id]);
}
/** The return handler's claim: exactly one request moves PENDING → APPROVING and may approve. Returns the claimed row or null. */
export const claimServiceOrder = (db, id) => db.get(`UPDATE service_orders SET status = 'APPROVING', updated_at = now() WHERE id = ? AND status = 'PENDING' RETURNING *`, [id]);
/** An approval nobody could confirm (stale APPROVING closed by the daily job). A later paid webhook may still record it. */
export const APPROVAL_UNKNOWN = 'approval_unknown';
const isOpen = (o) => o.status === 'PENDING' || o.status === 'APPROVING' || (o.status === 'FAILED' && o.failure_code === APPROVAL_UNKNOWN);

/** Failure codes that mean money may still be held and an operator must act (관리자 › 결제 shows them). */
export const OPERATOR_CODES = { refund_failed: '환불 실패 — 확인 필요', amount_mismatch: '금액 불일치', [APPROVAL_UNKNOWN]: '승인 확인 필요' };
/**
 * Operator alert for money that needs a person: console.error + an e-mail to SUPPORT_EMAIL (LEGAL.contactEmail when unset),
 * recorded in email_deliveries. Never throws; never includes card data.
 */
export async function alertOperator(db, { orderId, code, detail = '', tid = null }, env = process.env) {
  console.error(`[service-pay] OPERATOR ALERT ${code}`, orderId, detail);
  try {
    const to = emailConfig(env).supportEmail || LEGAL.contactEmail;
    const o = await getServiceOrder(db, orderId);
    const rows = [['주문번호', orderId], ['상태', o ? `${o.status} / ${o.failure_code || '-'}` : '-'], ['금액', o ? won(o.amount) : '-'], ['TID', tid || o?.provider_tid || '-'], ['내용', detail]];
    const subject = `[RELAI 결제 확인 필요] ${OPERATOR_CODES[code] || code} · ${orderId}`;
    const text = `서비스 결제 주문에 운영자 확인이 필요합니다. NICEPAY 관리자에서 거래 상태를 확인하고, 필요하면 환불한 뒤 구매자에게 연락해 주세요.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
    const html = `<p>서비스 결제 주문에 운영자 확인이 필요합니다. NICEPAY 관리자에서 거래 상태를 확인하고, 필요하면 환불한 뒤 구매자에게 연락해 주세요.</p><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    return await sendEmail(db, { type: 'SERVICE_PAY_ALERT', to, subject, html, text, tags: ['service-pay'] }, env);
  } catch (e) { console.error('[service-pay] operator alert e-mail failed', orderId, e.message); return null; }
}

/** What the public done page may show: no buyer contact data beyond a masked e-mail. */
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}` : ''; };
export const publicServiceOrder = (o) => o && ({ id: o.id, product: o.product, goods_name: o.goods_name, amount: o.amount, supply_amount: o.supply_amount, vat_amount: o.vat_amount,
  status: o.status, created_at: o.created_at, paid_at: o.paid_at, buyer_email_masked: maskEmail(o.buyer_email) });

/**
 * Applies a normalized provider event to a service order. Returns null when ev.order_id is not a service order (the caller
 * then hands the event to the in-app billing path). Idempotent: the same provider event id is applied once.
 * `refunder` (the webhook passes the provider): a paid event for another amount is refunded at once and the operator alerted.
 */
export async function applyServiceEvent(db, provider, ev, { refunder = null } = {}) {
  if (!ev?.order_id) return null;
  const known = await getServiceOrder(db, ev.order_id);
  if (!known) return null;
  let out;
  try {
    out = await tx(db, async (db) => {
      const ins = await db.get(`INSERT INTO billing_events (id, provider, provider_event_id, event_type, workspace_id, payload) VALUES (?,?,?,?,NULL,?)
        ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`, [`svc_${randomBytes(12).toString('hex')}`, provider, String(ev.id), ev.type, JSON.stringify(ev.payload ?? {})]);
      if (!ins) return { duplicate: true, service_order_id: known.id };
      const order = await db.get('SELECT * FROM service_orders WHERE id = ? FOR UPDATE', [known.id]);
      const finish = async (o) => { await db.run('UPDATE billing_events SET processed_at = now(), result = ? WHERE id = ?', [o.ignored ? `IGNORED:${o.reason}` : 'APPLIED', ins.id]); return { service_order_id: order.id, ...o }; };
      if (ev.type === 'subscription.activated') {
        if (ev.payment?.status !== 'PAID' || Number(ev.payment?.amount) !== Number(order.amount)) {
          await db.run(`UPDATE service_orders SET status = 'FAILED', failure_code = 'amount_mismatch', updated_at = now() WHERE id = ? AND status IN ('PENDING','APPROVING')`, [order.id]);
          return finish({ ignored: true, reason: 'amount_mismatch', mismatch_tid: ev.payment?.status === 'PAID' ? ev.payment?.provider_tid || null : null });
        }
        if (!isOpen(order)) return finish({ ignored: true, reason: `already_${order.status.toLowerCase()}`, status: order.status });
        await db.run(`UPDATE service_orders SET status = 'PAID', failure_code = NULL, failure_message = NULL, provider_tid = ?, payment_method_summary = ?, receipt_url = ?, paid_at = now(), updated_at = now() WHERE id = ?`,
          [ev.payment.provider_tid || null, ev.payment_method_summary || null, ev.payment.receipt_url || null, order.id]);
        return finish({ status: 'PAID', newly_paid: true });
      }
      if (ev.type === 'payment.failed') {
        if (order.status !== 'PENDING' && order.status !== 'APPROVING') return finish({ ignored: true, reason: 'not_pending', status: order.status });
        await db.run(`UPDATE service_orders SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = now() WHERE id = ?`,
          [String(ev.payment?.failure_code || 'failed').slice(0, 60), String(ev.payment?.failure_message || '').slice(0, 300), order.id]);
        return finish({ status: 'FAILED' });
      }
      if (ev.type === 'payment.refunded') {
        if (order.status !== 'PAID') return finish({ ignored: true, reason: 'not_paid', status: order.status });
        await db.run(`UPDATE service_orders SET status = 'REFUNDED', updated_at = now() WHERE id = ?`, [order.id]);
        return finish({ status: 'REFUNDED' });
      }
      return finish({ ignored: true, reason: 'unknown_type' });
    });
  } catch (e) {
    if (e.code === '23505') return { duplicate: true, service_order_id: known.id };
    throw e;
  }
  if (out.mismatch_tid && refunder?.refundTid) await refundMismatch(db, refunder, known.id, out.mismatch_tid, ev.payment?.amount);
  if (out.newly_paid) await sendServiceReceipt(db, known.id).catch((e) => console.error('[service-pay] receipt e-mail failed', known.id, e.message));
  return out;
}

/** A paid notification whose amount differs from the order: refund that tid in full, then tell the operator either way. */
async function refundMismatch(db, refunder, orderId, tid, amount) {
  try {
    await refunder.refundTid({ tid, orderId, reason: '주문 금액과 다른 결제 자동 취소' });
    await alertOperator(db, { orderId, tid, code: 'amount_mismatch', detail: `웹훅 결제 금액 ${won(amount)}이 주문 금액과 달라 자동 환불했습니다.` });
  } catch (e) {
    await markRefundFailed(db, orderId, e.message);
    await alertOperator(db, { orderId, tid, code: 'refund_failed', detail: `웹훅 결제 금액 ${won(amount)}이 주문 금액과 달라 환불을 시도했지만 실패했습니다: ${e.message}` });
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const kday = (d) => new Date(d).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
export function serviceReceiptEmail(o, L = LEGAL, { sub = null, manage = null } = {}) {
  const subject = `[RELAI] 결제가 완료되었습니다 (주문번호 ${o.id})`;
  const rows = [['상품', o.goods_name], ['주문번호', o.id], ['결제 금액', `${won(o.amount)} (부가세 포함)`], ['공급가액', won(o.supply_amount)], ['부가세', won(o.vat_amount)],
    ['결제 수단', o.payment_method_summary || '신용카드'], ['결제 일시', new Date(o.paid_at || Date.now()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })]];
  const html = `<!doctype html><html lang="ko"><body style="margin:0;background:#F4F6FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#101828">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #E4E8EF;border-radius:12px" cellspacing="0" cellpadding="0">
<tr><td style="padding:28px 32px 8px;font-size:18px;font-weight:800;color:#1B4FD8">RELAI</td></tr>
<tr><td style="padding:4px 32px 20px;font-size:15px;line-height:1.6"><h1 style="margin:0 0 12px;font-size:20px">결제가 완료되었습니다</h1>
<p>${esc(o.buyer_name)}님, RELAI 서비스를 결제해 주셔서 감사합니다. 서비스 범위와 시작일은 담당자가 연락드려 확정합니다.</p>
<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#667085">${esc(k)}</td><td style="padding:6px 0;text-align:right">${esc(v)}</td></tr>`).join('')}</table>
${o.receipt_url ? `<p style="margin-top:16px"><a href="${esc(o.receipt_url)}" style="color:#1B4FD8">카드 매출전표 보기</a></p>` : ''}
${sub ? `<p style="font-size:13px;color:#667085">월 구독입니다. 다음 결제일(${esc(kday(sub.next_billing_at || sub.current_period_end))})에 같은 카드로 ${esc(won(sub.amount))}이 자동 결제됩니다. 해지하면 결제한 달까지 이용하고 이후 결제되지 않으며, 이미 결제한 금액은 환불되지 않습니다.</p>${manage ? `<p style="margin-top:8px"><a href="${esc(manage)}" style="color:#1B4FD8">구독 확인 · 해지</a></p>` : ''}`
  : '<p style="font-size:13px;color:#667085">자동 갱신되지 않습니다. 취소·환불은 서비스 제공 여부와 계약 내용, 관련 법령에 따라 처리합니다.</p>'}</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #EEF1F6;font-size:12px;color:#667085;line-height:1.6">${esc(L.company)} · 대표 ${esc(L.ceo)} · 사업자등록번호 ${esc(L.bizNo)} · 통신판매업 신고번호 ${esc(L.mailOrderNo)}<br>${esc(L.address)}<br>문의: ${esc(L.contactEmail)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `결제가 완료되었습니다.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${o.receipt_url ? `매출전표: ${o.receipt_url}\n` : ''}${sub ? `\n월 구독: 다음 결제일 ${kday(sub.next_billing_at || sub.current_period_end)}, 해지하면 결제한 달까지 이용(환불 없음).${manage ? `\n구독 확인 · 해지: ${manage}` : ''}\n` : ''}\n서비스 범위와 시작일은 담당자가 연락드려 확정합니다.\n문의: ${L.contactEmail}\n`;
  return { subject, html, text };
}

/**
 * Sends the receipt once per order. receipt_email_sent_at is claimed first (a second webhook or approval sends nothing) and
 * released when the send fails, so the daily job retries it and the done page never claims a mail that did not go out.
 */
export async function sendServiceReceipt(db, id, env = process.env) {
  const claimed = await db.get(`UPDATE service_orders SET receipt_email_sent_at = now() WHERE id = ? AND status = 'PAID' AND receipt_email_sent_at IS NULL RETURNING *`, [id]);
  if (!claimed) return null;
  let r;
  try {
    let extra = {};
    if (claimed.subscription_id) {   // 월 구독: next payment + the manage (해지) link
      const { getServiceSubscription, manageUrl } = await import('./service-subscriptions.js');
      const sub = await getServiceSubscription(db, claimed.subscription_id);
      const base = emailConfig(env).appBaseUrl;
      extra = { sub, manage: sub && base ? manageUrl(base, sub.id, env) : null };
    }
    r = await sendEmail(db, { type: 'SERVICE_RECEIPT', to: claimed.buyer_email, ...serviceReceiptEmail(claimed, LEGAL, extra), tags: ['service-pay'] }, env);
  }
  finally { if (r?.status !== 'SENT') await db.run('UPDATE service_orders SET receipt_email_sent_at = NULL WHERE id = ?', [id]); }
  return r;
}

export const PENDING_PURGE_HOURS = 24;
export const APPROVING_STALE_MINUTES = 30;
export const RECEIPT_RETRY_DAYS = 7;
/**
 * Daily (GET /api/billing/cron/daily):
 *   - deletes PENDING orders older than 24h (never paid; the buyer's name, e-mail and phone go with them);
 *   - closes APPROVING orders left for 30+ minutes (the approving request died) as FAILED approval_unknown and alerts the
 *     operator to check NICEPAY; a paid webhook arriving later still records the payment;
 *   - retries receipts that failed to send (paid within 7 days).
 */
export async function serviceOrdersDaily(db, env = process.env) {
  const purged = await db.all(`DELETE FROM service_orders WHERE status = 'PENDING' AND created_at < now() - make_interval(hours => ${PENDING_PURGE_HOURS}) RETURNING id`);
  const stale = await db.all(`UPDATE service_orders SET status = 'FAILED', failure_code = '${APPROVAL_UNKNOWN}', failure_message = '승인 결과를 확인하지 못했습니다.', updated_at = now()
    WHERE status = 'APPROVING' AND updated_at < now() - make_interval(mins => ${APPROVING_STALE_MINUTES}) RETURNING id`);
  for (const o of stale) await alertOperator(db, { orderId: o.id, code: APPROVAL_UNKNOWN, detail: '승인 요청 뒤 결과가 기록되지 않았습니다. NICEPAY 관리자에서 승인 여부를 확인해 주세요.' }, env);
  const unsent = await db.all(`SELECT id FROM service_orders WHERE status = 'PAID' AND receipt_email_sent_at IS NULL AND paid_at > now() - make_interval(days => ${RECEIPT_RETRY_DAYS})`);
  let receipts = 0;
  for (const o of unsent) { const r = await sendServiceReceipt(db, o.id, env).catch(() => null); if (r?.status === 'SENT') receipts += 1; }
  return { purged_pending: purged.length, stale_approving: stale.length, receipts_sent: receipts };
}

/** 관리자 › 결제: service orders, read-only. TIDs are masked like the in-app payments. */
export async function listServiceOrders(db, { q = '', status = '', page = 1, size = 50 } = {}) {
  const where = []; const params = [];
  if (q) { where.push('(buyer_name ILIKE ? OR buyer_email ILIKE ? OR buyer_company ILIKE ? OR id ILIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('status = ?'); params.push(String(status)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM service_orders ${w}`, params)).n);
  const rows = await db.all(`SELECT id, product, kind, goods_name, amount, status, buyer_name, buyer_company, buyer_email, buyer_phone, provider, provider_tid, payment_method_summary,
      failure_code, created_at, paid_at FROM service_orders ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  const mask = (t) => (t ? `${'*'.repeat(Math.max(0, String(t).length - 4))}${String(t).slice(-4)}` : null);
  return { total, page, size, items: rows.map((r) => ({ ...r, provider_tid: undefined, provider_tid_masked: mask(r.provider_tid) })) };
}

export const serviceBaseUrl = (req) => emailConfig().appBaseUrl || `${req.protocol}://${req.get('host')}`;
