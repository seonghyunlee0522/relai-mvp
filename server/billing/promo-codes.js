/**
 * 프로모션 코드 (founder 2026-10-26; separate from the display-only 프로모션 banners in server/promotions.js).
 *
 * Four kinds, one benefit per code:
 *   PERCENT      n% off a Pro / Team plan purchase (1개월 이용권 checkout)           → entered in the purchase dialog
 *   AMOUNT       n원 off a Pro / Team plan purchase                                   → entered in the purchase dialog
 *   FREE_MONTHS  plan (Pro / Team) for n months, no payment, no auto renewal          → 설정 › 요금제 › 코드 등록
 *   CREDITS      n AI credits into the promo bucket (무상, never refunded)            → 설정 › 요금제 › 코드 등록
 * Rules: active, within starts_on..ends_on (KST days), used_count < max_uses (NULL = no limit), once per workspace AND once per
 * e-mail (hash, as the Free starter credits). OWNER with a verified e-mail only (the routes' payer guard). A discount never takes a
 * payment under MIN_CARD_KRW. A discount is counted (promo_redemptions + used_count) when its order is PAID, not when the dialog
 * shows it; an abandoned window uses nothing. Codes are case-insensitive (stored upper case). A used code's benefit cannot change:
 * the operator only stops / restarts it (no delete).
 *
 *   GET  /api/billing/admin/promo-codes                          SYSTEM_ADMIN: every code + use count
 *   POST /api/billing/admin/promo-codes                          SYSTEM_ADMIN: { code, kind, value, plan?, starts_on?, ends_on?, max_uses? }
 *   POST /api/billing/admin/promo-codes/:id/stop | /start        SYSTEM_ADMIN (audited)
 *   POST /api/workspaces/:wid/promo-codes/redeem         OWNER: { code } → CREDITS / FREE_MONTHS applied now
 *   GET  /api/workspaces/:wid/promo-codes                any member: codes this workspace used
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { writeAudit } from '../admin.js';
import { requireAction } from '../authz.js';
import { requireVerifiedEmail } from '../auth/account-security.js';
import { rateLimiter } from '../security.js';
import { PLANS, PAID_PLANS, MIN_CARD_KRW, planPrice, splitVat } from '../plans.js';
import { applyCredits, emailHash } from '../ai/credits.js';
import { todayKst } from '../../public/app/shared/kst-date.js';
import { newOrderId } from './orders.js';

export const KINDS = { PERCENT: '할인율', AMOUNT: '정액 할인', FREE_MONTHS: '무료 기간', CREDITS: '크레딧 지급' };
export const DISCOUNT_KINDS = ['PERCENT', 'AMOUNT'];
export const REDEEM_KINDS = ['FREE_MONTHS', 'CREDITS'];
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,29}$/;
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
/** Generic refusal: an unknown, stopped, expired or used-up code all read the same (no probing which codes exist). */
const UNUSABLE = '사용할 수 없는 코드예요.';

export class PromoCodeError extends Error { constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; } }
export const normalizeCode = (c) => String(c ?? '').trim().toUpperCase().replace(/\s+/g, '');

/** '20% 할인' · '10,000원 할인' · 'Pro 1개월 무료' · '크레딧 500' */
export function benefitLabel(c) {
  if (c.kind === 'PERCENT') return `${c.value}% 할인`;
  if (c.kind === 'AMOUNT') return `${won(c.value)} 할인`;
  if (c.kind === 'FREE_MONTHS') return `${PLANS[c.plan]?.label || c.plan} ${c.value}개월 무료`;
  return `크레딧 ${Number(c.value).toLocaleString('ko-KR')}`;
}
/** 진행 · 예정 · 종료 · 중지 · 소진 */
export function statusOf(c, today = todayKst()) {
  if (!c.active) return 'STOPPED';
  if (c.starts_on && String(c.starts_on).slice(0, 10) > today) return 'SCHEDULED';
  if (c.ends_on && String(c.ends_on).slice(0, 10) < today) return 'ENDED';
  if (c.max_uses !== null && c.max_uses !== undefined && Number(c.used_count) >= Number(c.max_uses)) return 'USED_UP';
  return 'ACTIVE';
}
const dayStr = (d) => (d ? (d instanceof Date ? todayKst(d) : String(d).slice(0, 10)) : null);
const publicCode = (c) => ({ id: c.id, code: c.code, kind: c.kind, kind_label: KINDS[c.kind], value: Number(c.value), plan: c.plan || null, benefit: benefitLabel(c),
  starts_on: dayStr(c.starts_on), ends_on: dayStr(c.ends_on), max_uses: c.max_uses === null ? null : Number(c.max_uses), used_count: Number(c.used_count),
  active: Boolean(c.active), status: statusOf({ ...c, starts_on: dayStr(c.starts_on), ends_on: dayStr(c.ends_on) }), created_at: c.created_at });

/** Validates an operator's new code. Throws PromoCodeError(400) with field messages. */
export function parseNewCode(body = {}) {
  const f = {};
  const code = normalizeCode(body.code);
  const kind = String(body.kind || '').toUpperCase();
  const value = Number(body.value);
  const plan = String(body.plan || 'PRO').toUpperCase();
  const day = (v) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 10));
  const startsOn = day(body.starts_on); const endsOn = day(body.ends_on);
  const maxUses = body.max_uses === undefined || body.max_uses === null || body.max_uses === '' ? null : Number(body.max_uses);
  if (!CODE_RE.test(code)) f.code = '코드는 영문 대문자·숫자·하이픈 3~30자로 입력해 주세요.';
  if (!KINDS[kind]) f.kind = '혜택 유형을 선택해 주세요.';
  else if (!Number.isInteger(value) || value <= 0) f.value = '혜택 값을 1 이상의 정수로 입력해 주세요.';
  else if (kind === 'PERCENT' && value > 100) f.value = '할인율은 1~100% 사이로 입력해 주세요.';
  else if (kind === 'FREE_MONTHS' && value > 12) f.value = '무료 기간은 1~12개월로 입력해 주세요.';
  else if (kind === 'CREDITS' && value > 1_000_000) f.value = '크레딧은 1,000,000 이하로 입력해 주세요.';
  if (kind === 'FREE_MONTHS' && !PAID_PLANS.includes(plan)) f.plan = '무료 기간을 줄 요금제(Pro 또는 Team)를 선택해 주세요.';
  for (const [k, v] of [['starts_on', startsOn], ['ends_on', endsOn]]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) f[k] = '날짜를 YYYY-MM-DD로 입력해 주세요.';
  if (startsOn && endsOn && endsOn < startsOn) f.ends_on = '종료일이 시작일보다 빠릅니다.';
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) f.max_uses = '사용 한도는 1 이상의 정수로 입력하거나 비워 두세요.';
  if (Object.keys(f).length) throw new PromoCodeError(400, 'validation_error', '입력값을 확인해 주세요.', f);
  return { code, kind, value, plan: kind === 'FREE_MONTHS' ? plan : null, starts_on: startsOn, ends_on: endsOn, max_uses: maxUses };
}

export async function createCode(db, input, adminUserId) {
  const c = parseNewCode(input);
  const id = randomUUID();
  const row = await db.get(`INSERT INTO promo_codes (id, code, kind, value, plan, starts_on, ends_on, max_uses, created_by) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT (code) DO NOTHING RETURNING *`, [id, c.code, c.kind, c.value, c.plan, c.starts_on, c.ends_on, c.max_uses, adminUserId]);
  if (!row) throw new PromoCodeError(409, 'duplicate_code', '이미 있는 코드예요.', { code: '이미 있는 코드예요.' });
  return publicCode(row);
}
export const listCodes = async (db) => (await db.all('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 500')).map(publicCode);

/**
 * The code row when `wid` (owned by `email`) may use `raw` for one of `kinds` right now, else PromoCodeError(400/409).
 * `t` may be a transaction (FOR UPDATE keeps used_count honest while the redemption is written).
 */
export async function usableCode(t, { raw, wid, email, kinds, lock = false }) {
  const code = normalizeCode(raw);
  if (!code) throw new PromoCodeError(400, 'validation_error', '코드를 입력해 주세요.', { promo_code: '코드를 입력해 주세요.' });
  const c = await t.get(`SELECT * FROM promo_codes WHERE code = ?${lock ? ' FOR UPDATE' : ''}`, [code]);
  if (!c || statusOf({ ...c, starts_on: dayStr(c.starts_on), ends_on: dayStr(c.ends_on) }) !== 'ACTIVE') throw new PromoCodeError(400, 'promo_unusable', UNUSABLE, { promo_code: UNUSABLE });
  if (!kinds.includes(c.kind)) {
    const m = DISCOUNT_KINDS.includes(c.kind) ? '결제할 때 쓰는 할인 코드예요. 요금제 구매 창에 입력해 주세요.' : '결제 할인 코드가 아니에요. 설정 › 요금제 › 코드 등록에서 입력해 주세요.';
    throw new PromoCodeError(400, 'promo_wrong_place', m, { promo_code: m });
  }
  const used = await t.get(`SELECT 1 FROM promo_redemptions WHERE code_id = ? AND (workspace_id = ? OR (email_hash IS NOT NULL AND email_hash = ?)) LIMIT 1`, [c.id, wid, email ? emailHash(email) : null]);
  if (used) throw new PromoCodeError(409, 'promo_used', '이미 사용한 코드예요.', { promo_code: '이미 사용한 코드예요.' });
  return c;
}

/** Discount of `c` on a plan payment of `amount` (VAT incl.). Throws when what is left would be under MIN_CARD_KRW. */
export function discountOf(c, amount) {
  const a = Number(amount);
  const d = c.kind === 'PERCENT' ? Math.floor((a * Number(c.value)) / 100) : Math.min(a, Number(c.value));
  if (a - d < MIN_CARD_KRW) throw new PromoCodeError(400, 'promo_too_large', '이 상품에는 쓸 수 없는 코드예요.', { promo_code: '이 상품에는 쓸 수 없는 코드예요.' });
  return d;
}
/** A plan quote (orders.js quote shape) with the discount applied: amount, supply / VAT and discount_amount follow; promo carried along. */
export function applyDiscount(q, c) {
  const discount = discountOf(c, q.total);
  const total = Number(q.total) - discount;
  const { supply, vat } = splitVat(total);
  return { ...q, total, amount: total, supply, vat, supply_amount: supply, vat_amount: vat, discount_amount: Number(q.discount_amount || 0) + discount,
    promo: { id: c.id, code: c.code, benefit: benefitLabel(c), discount, list_total: Number(q.total) } };
}

/** Records one use (same transaction as the paid order or the grant). Idempotent per (code, workspace). */
export async function recordRedemption(t, { codeId, wid, userId = null, email = null, orderId = null, discount = 0, credits = 0, months = 0 }) {
  const ins = await t.get(`INSERT INTO promo_redemptions (id, code_id, workspace_id, user_id, email_hash, order_id, discount_amount, credits, months)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (code_id, workspace_id) DO NOTHING RETURNING id`,
  [randomUUID(), codeId, wid, userId, email ? emailHash(email) : null, orderId, discount, credits, months]);
  if (ins) await t.run('UPDATE promo_codes SET used_count = used_count + 1, updated_at = now() WHERE id = ?', [codeId]);
  return Boolean(ins);
}

/**
 * 설정 › 코드 등록: CREDITS → promo bucket now; FREE_MONTHS → a PAID 0원 ONE_TIME order of the plan for n months, applied like any
 * one-time pass (current period extended, no auto renewal). Returns { kind, benefit, credits?, plan?, months?, period_end? }.
 */
export async function redeemCode(db, { raw, wid, user }) {
  const pre = await usableCode(db, { raw, wid, email: user.email, kinds: REDEEM_KINDS });
  if (pre.kind === 'CREDITS') {
    await tx(db, async (t) => {
      const c = await usableCode(t, { raw, wid, email: user.email, kinds: REDEEM_KINDS, lock: true });
      if (!(await recordRedemption(t, { codeId: c.id, wid, userId: user.id, email: user.email, credits: Number(c.value) }))) throw new PromoCodeError(409, 'promo_used', '이미 사용한 코드예요.');
      await applyCredits(t, { wid, amount: Number(c.value), type: 'PROMOTION', reason: `프로모션 코드 ${c.code}`, createdBy: user.id, referenceType: 'PROMO_CODE', referenceId: c.id });
    });
    return { kind: 'CREDITS', benefit: benefitLabel(pre), credits: Number(pre.value) };
  }
  // FREE_MONTHS: refuse while a renewing (정기결제) subscription runs — it would be charged on top of the free months
  const sub = await db.get('SELECT plan, status, auto_renew, cancel_at_period_end FROM subscriptions WHERE workspace_id = ?', [wid]);
  if (sub && sub.status === 'ACTIVE' && sub.auto_renew && !sub.cancel_at_period_end) throw new PromoCodeError(409, 'promo_subscribed', '정기결제 중에는 무료 기간 코드를 쓸 수 없어요.');
  if (sub && sub.status === 'ACTIVE' && PAID_PLANS.includes(sub.plan) && sub.plan !== pre.plan) throw new PromoCodeError(409, 'promo_other_plan', `지금 ${PLANS[sub.plan].label} 이용 중이라 ${PLANS[pre.plan].label} 무료 기간 코드를 쓸 수 없어요.`);
  const months = Number(pre.value);
  const list = planPrice(pre.plan, 'MONTHLY') * months;
  const orderId = newOrderId();
  await tx(db, async (t) => {
    const c = await usableCode(t, { raw, wid, email: user.email, kinds: REDEEM_KINDS, lock: true });
    if (!(await recordRedemption(t, { codeId: c.id, wid, userId: user.id, email: user.email, orderId, months }))) throw new PromoCodeError(409, 'promo_used', '이미 사용한 코드예요.');
    await t.run(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, plan, cycle, seats, months, unit_price, list_amount, discount_amount, supply_amount, vat_amount, amount,
        founding, goods_name, promo_code_id, promo_discount, buyer_name, buyer_email) VALUES (?,?,?,'promo','ONE_TIME',?,'MONTHLY',?,?,0,?,?,0,0,0,false,?,?,?,(SELECT name FROM users WHERE id = ?),(SELECT email FROM users WHERE id = ?))`,
    [orderId, wid, user.id, c.plan, PLANS[c.plan].included.users, months, list, list, `RELAI ${PLANS[c.plan].label} ${months}개월 무료 (${c.code})`, c.id, list, user.id, user.id]);
  });
  const { processWebhookEvent } = await import('./subscriptions.js');
  const out = await processWebhookEvent(db, 'promo', { id: `promo:${orderId}`, type: 'subscription.activated', order_id: orderId,
    payment: { amount: 0, currency: 'KRW', status: 'PAID', provider_tid: `promo:${orderId}`, moid: orderId }, payload: { promo: true } });
  if (out?.ignored) throw new PromoCodeError(409, 'apply_failed', '무료 기간을 반영하지 못했어요. 운영자에게 문의해 주세요.');
  const s = await db.get('SELECT current_period_end FROM subscriptions WHERE workspace_id = ?', [wid]);
  return { kind: 'FREE_MONTHS', benefit: benefitLabel(pre), plan: pre.plan, months, period_end: s?.current_period_end || null };
}

export function mountPromoCodeRoutes({ app, db, guard, wrap, fail, requireAuth }) {
  const sendErr = (res, e) => fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {});
  const admin = (req, res) => { if (req.user?.system_role !== 'SYSTEM_ADMIN') { fail(res, 403, 'forbidden', '운영자 권한이 필요합니다.'); return false; } return true; };
  const A = '/api/billing/admin/promo-codes';
  app.get(A, requireAuth, wrap(async (req, res) => { if (!admin(req, res)) return; res.json({ codes: await listCodes(db), kinds: KINDS }); }));
  app.post(A, requireAuth, wrap(async (req, res) => {
    if (!admin(req, res)) return;
    let c; try { c = await createCode(db, req.body || {}, req.user.id); } catch (e) { if (e instanceof PromoCodeError) return sendErr(res, e); throw e; }
    await writeAudit(db, { adminUserId: req.user.id, action: 'PROMO_CODE_CREATE', targetType: 'PROMO_CODE', targetId: c.id, metadata: { code: c.code, kind: c.kind, value: c.value, plan: c.plan, starts_on: c.starts_on, ends_on: c.ends_on, max_uses: c.max_uses } });
    res.status(201).json({ code: c });
  }));
  app.post(`${A}/:id/:action`, requireAuth, wrap(async (req, res) => {
    if (!admin(req, res)) return;
    if (!['stop', 'start'].includes(req.params.action)) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    const row = await db.get('UPDATE promo_codes SET active = ?, updated_at = now() WHERE id = ? RETURNING *', [req.params.action === 'start', req.params.id]);
    if (!row) return fail(res, 404, 'not_found', '코드를 찾을 수 없습니다.');
    await writeAudit(db, { adminUserId: req.user.id, action: `PROMO_CODE_${req.params.action.toUpperCase()}`, targetType: 'PROMO_CODE', targetId: row.id, metadata: { code: row.code } });
    res.json({ code: publicCode(row) });
  }));

  const W = '/api/workspaces/:wid/promo-codes';
  app.get(W, guard, wrap(async (req, res) => {
    const rows = await db.all(`SELECT r.created_at, c.code, c.kind, c.value, c.plan, r.discount_amount, r.credits, r.months, u.name AS user_name FROM promo_redemptions r
      JOIN promo_codes c ON c.id = r.code_id LEFT JOIN users u ON u.id = r.user_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 50`, [req.params.wid]);
    res.json({ redemptions: rows.map((r) => ({ at: r.created_at, code: r.code, benefit: r.discount_amount ? `${won(r.discount_amount)} 할인` : benefitLabel(r), user_name: r.user_name })) });
  }));
  const limiter = rateLimiter(db, { name: 'promo-redeem', max: 10, windowMs: 60 * 60 * 1000 });   // 10 tries / hour / user
  app.post(`${W}/redeem`, [...guard, requireAction('billing'), requireVerifiedEmail(fail)], wrap(async (req, res) => {
    const key = `u:${req.user.id}`;
    if (await limiter.blocked(key)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    await limiter.hit(key);
    try { res.json({ redeemed: await redeemCode(db, { raw: req.body?.code, wid: req.params.wid, user: req.user }) }); }
    catch (e) { if (e instanceof PromoCodeError) return sendErr(res, e); throw e; }
  }));
}
