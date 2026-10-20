/**
 * Billing API (Phase 10). Two mounts:
 *   mountBillingWebhook — registered BEFORE the global JSON parser, CSRF/Origin check and auth:
 *     POST /api/billing/webhook/:provider   raw body → signature verification (docs/production-readiness.md §6, §8). Own IP rate limiter.
 *     POST /api/billing/nicepay/return      NicePay payment window result (form-urlencoded, cross-site, no session cookie):
 *                                           verify → approve → apply → 303 to /app/settings?checkout=success|failed|canceled#billing
 *   mountBillingRoutes  — workspace-scoped: GET …/billing (any member), GET …/billing/quote, POST …/billing/checkout|cancel|recurring
 *     (OWNER: POLICY.billing); GET /api/billing/nicepay/pay/:orderId (the order's buyer); POST /api/billing/admin/payments/:id/refund
 *     (SYSTEM_ADMIN); GET /api/billing/cron/daily (CRON_SECRET: renewal reminders, renewal charges, monthly AI credit grants).
 */
import express from 'express';
import { rateLimiter } from '../security.js';
import { requireAction, can } from '../authz.js';
import { PLANS, USAGE_DIMS, CYCLES, FOUNDING_OFFER, VAT_RATE, CREDIT_PRICE_KRW, PURCHASED_VALID_YEARS } from '../plans.js';
import { workspaceUsage } from '../usage.js';
import { writeAudit } from '../admin.js';
import { emailConfig } from '../email/config.js';
import { requireVerifiedEmail } from '../auth/account-security.js';
import { BillingError, paymentsEnabled, PAYMENTS_OFF_MESSAGE } from './provider.js';
import { parseCard, safeEqual } from './nicepay.js';
import { OrderError, quoteFor, createOrder, getOrder, isExpired, failOrder, foundingEligible, minUsers, MAX_USERS, publicOrder } from './orders.js';
import { effectivePlan, getSubscription, processWebhookEvent, requestCancel } from './subscriptions.js';
import { sendRenewalReminders, chargeDueRenewals, sendEarlyAccessNotices } from './cron.js';
import { grantDueMonthlyCredits } from './ai-grants.js';

const catalogue = () => Object.values(PLANS).filter((p) => p.key !== 'EARLY').map((p) => ({ key: p.key, label: p.label, base_monthly: p.contact_sales ? null : (p.base_monthly ?? 0),
  included_users: p.included_users ?? null, extra_user_monthly: p.extra_user_monthly ?? null, contact_sales: Boolean(p.contact_sales), limits: p.limits }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `₩${Number(n).toLocaleString('ko-KR')}`;
const settingsUrl = (status, reason, order = null) => (order?.kind === 'CREDIT_PACK'
  ? `/app/settings/credits?checkout=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`
  : `/app/settings?checkout=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}#billing`);

/** Applies an approved payment; if it cannot be applied, the payment is refunded so no customer is charged for nothing. */
async function applyOrRefund(db, provider, order, ev) {
  try {
    const out = await processWebhookEvent(db, provider.name, ev);
    if (out.ignored) throw new Error(`ignored:${out.reason}`);
    return out;
  } catch (e) {
    console.error('[billing] approved payment not applied — refunding', order.id, e.message);
    await provider.refund({ order: { ...order, provider_tid: ev.payment?.provider_tid }, reason: '결제 반영 오류로 자동 취소' })
      .catch((err) => console.error('[billing] AUTO-REFUND FAILED — refund by hand in the NicePay console', order.id, err.message));
    await failOrder(db, order.id, 'apply_failed', e.message);
    return null;
  }
}

export function mountBillingWebhook(app, db, { provider, fail }) {
  const limiter = rateLimiter(db, { name: 'billing-webhook', max: 300, windowMs: 60 * 1000 });   // per source IP; never shared with the login/signup limiters
  const limited = async (req, res) => { if (await limiter.blocked(req.ip)) { fail(res, 429, 'rate_limited', '요청이 너무 많습니다.'); return true; } await limiter.hit(req.ip); return false; };
  app.post('/api/billing/webhook/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    try {
      if (!provider || req.params.provider !== provider.name) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
      if (await limited(req, res)) return;
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let ev;
      try { ev = await provider.handleWebhook({ rawBody, headers: req.headers }); }
      catch (e) { if (e instanceof BillingError) return fail(res, e.status, e.code, e.message); throw e; }
      const out = await processWebhookEvent(db, provider.name, ev);
      if (provider.webhookAck) return provider.webhookAck(res, out);
      res.json({ received: true, ...out });
    } catch (e) { next(e); }
  });

  if (!provider?.completeReturn) return;
  app.post(`/api/billing/${provider.name}/return`, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res, next) => {
    try {
      if (await limited(req, res)) return;
      const form = req.body || {};
      const order = await getOrder(db, form.orderId);
      if (!order || order.provider !== provider.name) return res.redirect(303, settingsUrl('failed', 'unknown_order'));
      if (order.status === 'PAID') return res.redirect(303, settingsUrl('success', '', order));
      if (order.status !== 'PENDING') return res.redirect(303, settingsUrl('failed', order.failure_code || 'order_closed', order));
      if (isExpired(order)) { await failOrder(db, order.id, 'expired', '결제 시간이 초과되었습니다.'); return res.redirect(303, settingsUrl('failed', 'expired', order)); }
      let ev;
      try { ev = await provider.completeReturn({ form, order }); }
      catch (e) {
        if (!(e instanceof BillingError)) throw e;
        await failOrder(db, order.id, e.code, e.message);
        return res.redirect(303, settingsUrl(e.code === 'auth_failed' ? 'canceled' : 'failed', e.code, order));
      }
      const out = await applyOrRefund(db, provider, order, ev);
      res.redirect(303, settingsUrl(out ? 'success' : 'failed', out ? '' : 'apply_failed', order));
    } catch (e) { next(e); }
  });
}

/** The NicePay payment window page: order summary + AUTHNICE.requestPay with server-side parameters. */
function payPage({ order, params, sdkUrl, sandbox }) {
  const json = JSON.stringify(params).replace(/</g, '\\u003c');
  const row = (k, v, strong) => `<tr><th>${esc(k)}</th><td>${strong ? `<b>${esc(v)}</b>` : esc(v)}</td></tr>`;
  const pack = order.kind === 'CREDIT_PACK';
  const back = pack ? '/app/settings/credits' : '/app/settings#billing';
  const rows = pack ? `${row('AI 크레딧', `${Number(order.credits).toLocaleString('ko-KR')} 크레딧 (1 크레딧 = ₩${CREDIT_PRICE_KRW})`)}${row('공급가액', won(order.supply_amount))}${row('부가세 (10%)', won(order.vat_amount))}`
    : `${row('사용자', `${order.seats}명 (소유자 포함)`)}${row('월 이용료', `${won(order.unit_price)} / 월`)}${row('이용 기간', order.months === 12 ? '12개월 (연간 선결제)' : '1개월')}${row('정가', won(order.list_amount))}
${order.discount_amount ? row(order.founding ? `할인 (파운딩 고객 ${FOUNDING_OFFER.pct}% 포함)` : '할인', `−${won(order.discount_amount)}`) : ''}${row('공급가액', won(order.supply_amount))}${row('부가세 (10%)', won(order.vat_amount))}`;
  const note = pack ? `충전한 크레딧은 구매일로부터 ${PURCHASED_VALID_YEARS}년간 쓸 수 있습니다. 미사용 크레딧은 환불 규정에 따라 환불받을 수 있습니다. 자동 결제되지 않습니다.`
    : '자동 결제되지 않습니다. 이용 기간이 끝나기 7일 전에 연장 안내 메일을 보내 드립니다.';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RELAI 결제</title>
<style>body{margin:0;background:#F4F6FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#101828}
main{max-width:460px;margin:48px auto;padding:0 16px}.card{background:#fff;border:1px solid #E4E8EF;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 16px}table{width:100%;border-collapse:collapse;font-size:14.5px}th{text-align:left;color:#667085;font-weight:500;padding:6px 0}td{text-align:right;padding:6px 0}
.total td,.total th{border-top:1px solid #EEF1F6;padding-top:12px;font-size:16px;color:#101828}button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:8px;background:#2E51C4;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
.note{font-size:12.5px;color:#667085;margin-top:14px;line-height:1.5}.err{color:#B42318;font-size:14px;margin-top:12px;min-height:1em}a{color:#2E51C4}</style></head>
<body><main><div class="card"><h1>${esc(order.goods_name)}</h1>${sandbox ? '<p class="note">테스트(샌드박스) 결제입니다. 실제 청구되지 않습니다.</p>' : ''}<table>
${rows}
<tr class="total"><th>결제 금액</th><td><b>${esc(won(order.amount))}</b></td></tr></table>
<button id="pay" type="button">${esc(won(order.amount))} 결제하기</button><p class="err" id="err" role="alert"></p>
<p class="note">${esc(note)} <a href="${back}">결제 취소하고 돌아가기</a></p></div></main>
<script src="${esc(sdkUrl)}"></script>
<script>(function(){var P=${json};var err=document.getElementById('err');
function pay(){if(!window.AUTHNICE){err.textContent='결제창을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';return;}
var o={};for(var k in P)o[k]=P[k];o.fnError=function(r){err.textContent=(r&&(r.errorMsg||r.msg))||'결제가 취소되었습니다.';};AUTHNICE.requestPay(o);}
document.getElementById('pay').onclick=pay;window.addEventListener('load',pay);})();</script></body></html>`;
}

export function mountBillingRoutes({ app, db, guard, wrap, fail, provider, requireAuth }) {
  const b = '/api/workspaces/:wid/billing';
  const owner = [...guard, requireAction('billing')];
  const payer = [...owner, requireVerifiedEmail(fail)];   // paying or changing a subscription needs a verified e-mail (auth/account-security.js)
  const unavailable = (res) => fail(res, 503, 'billing_unavailable', '지금은 결제할 수 없습니다. 운영자에게 문의해 주세요.');
  const orderFail = (res, e) => fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {});

  const paymentsOff = (res) => fail(res, 409, 'payments_disabled', PAYMENTS_OFF_MESSAGE);
  const summary = async (wid, role) => {
    const plan = await effectivePlan(db, wid);
    const subscription = (await getSubscription(db, wid)) || null;
    // One-time purchases can be extended at any time; a renewing (recurring) subscription cannot be bought twice.
    // Early access: TEAM checkout is hidden (code kept) — the app is free and AI is paid with credit packs.
    const canPurchase = paymentsEnabled() && plan !== 'EARLY' && (plan === 'FREE' || (subscription && !subscription.auto_renew));
    const early = await db.get('SELECT early_access_until FROM workspaces WHERE id = ?', [wid]);
    return { billing: { plan, plan_label: PLANS[plan].label, subscription, early_access_until: early?.early_access_until || null, usage: await workspaceUsage(db, wid, plan),
      plans: catalogue(), dims: USAGE_DIMS, provider_available: Boolean(provider), payments_enabled: paymentsEnabled(), can_manage: can(role, 'billing'),
      checkout: { can_purchase: Boolean(canPurchase), cycles: Object.values(CYCLES).map((c) => ({ key: c.key, label: c.label, months: c.months, discount_pct: c.discount_pct })),
        base_monthly: PLANS.TEAM.base_monthly, included_users: PLANS.TEAM.included_users, extra_user_monthly: PLANS.TEAM.extra_user_monthly,
        min_users: await minUsers(db, wid), max_users: MAX_USERS, founding_eligible: await foundingEligible(db, wid), founding: FOUNDING_OFFER, vat_rate: VAT_RATE, prices_exclude_vat: true,
        recurring_available: Boolean(provider?.recurringEnabled), sandbox: provider?.mode === 'sandbox' } } };
  };
  app.get(b, guard, wrap(async (req, res) => res.json(await summary(req.params.wid, req.role))));

  app.get(`${b}/quote`, guard, wrap(async (req, res) => {
    try { res.json({ quote: await quoteFor(db, req.params.wid, { plan: 'TEAM', cycle: String(req.query.cycle || 'ANNUAL'), users: req.query.users ?? req.query.seats }) }); }
    catch (e) { if (e instanceof OrderError) return orderFail(res, e); throw e; }
  }));

  /** Shared checkout validation: TEAM only, purchasable, provider present. Returns the quote or null after answering. */
  const prepare = async (req, res) => {
    if (!paymentsEnabled()) { paymentsOff(res); return null; }
    const plan = String(req.body?.plan || 'TEAM');
    if (plan !== 'TEAM') { fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { plan: PLANS[plan]?.contact_sales ? 'Enterprise는 영업 문의로 계약합니다.' : '선택할 수 없는 플랜입니다.' } }); return null; }
    if (!provider) { unavailable(res); return null; }
    const sub = await getSubscription(db, req.params.wid);
    if ((await effectivePlan(db, req.params.wid)) === plan && sub?.auto_renew) { fail(res, 409, 'already_subscribed', '이미 Team 플랜을 사용 중입니다.'); return null; }
    try { return await quoteFor(db, req.params.wid, { plan, cycle: String(req.body?.cycle || 'ANNUAL'), users: req.body?.users ?? req.body?.seats }); }
    catch (e) { if (e instanceof OrderError) { orderFail(res, e); return null; } throw e; }
  };

  app.post(`${b}/checkout`, payer, wrap(async (req, res) => {
    const q = await prepare(req, res); if (!q) return;
    const workspace = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [req.params.wid]);
    const order = await createOrder(db, { workspaceId: workspace.id, userId: req.user.id, provider: provider.name, kind: 'ONE_TIME', q });
    const out = await provider.createCheckout({ workspace, plan: q.plan, order, customer: { id: req.user.id, email: req.user.email, name: req.user.name },
      successUrl: '/app/settings', cancelUrl: '/app/settings' });
    res.status(201).json({ checkout_url: out.checkout_url, session_id: out.session_id, provider: provider.name, order: publicOrder(order) });
  }));

  app.post(`${b}/cancel`, payer, wrap(async (req, res) => {
    if (!provider) return unavailable(res);
    const out = await requestCancel(db, provider, req.params.wid);
    if (out.error === 'no_active_subscription') return fail(res, 409, out.error, '해지할 구독이 없습니다.');
    if (out.error === 'already_canceled') return fail(res, 409, out.error, '이미 해지 예약된 구독입니다.');
    if (out.error === 'not_recurring') return fail(res, 409, out.error, '자동 결제되지 않는 이용권입니다. 이용 기간이 끝나면 Free 플랜으로 전환됩니다.');
    res.json(await summary(req.params.wid, req.role));
  }));

  /** 정기결제: register a card (billing key) and charge the first period. Off until NICEPAY_RECURRING_ENABLED=true. */
  app.post(`${b}/recurring`, payer, wrap(async (req, res) => {
    if (!provider?.recurringEnabled || !provider.registerBillingKey) return fail(res, 404, 'recurring_disabled', '정기결제는 아직 제공되지 않습니다.');
    let card;
    try { card = parseCard(req.body?.card); } catch (e) { if (e instanceof BillingError) return fail(res, e.status, e.code, e.message, { fields: e.fields }); throw e; }
    const q = await prepare(req, res); if (!q) return;
    const order = await createOrder(db, { workspaceId: req.params.wid, userId: req.user.id, provider: provider.name, kind: 'RECURRING_FIRST', q });
    const customer = { email: req.user.email, name: req.user.name };
    let bid;
    try {
      ({ bid } = await provider.registerBillingKey({ order, card, customer }));
      const ev = await provider.chargeBillingKey({ bid, order });
      if (ev.type !== 'subscription.activated') {
        await failOrder(db, order.id, ev.payment?.failure_code || 'declined', ev.payment?.failure_message);
        await provider.expireBillingKey(bid).catch(() => {});
        return fail(res, 402, 'payment_failed', ev.payment?.failure_message || '결제가 승인되지 않았습니다.');
      }
      if (!(await applyOrRefund(db, provider, order, ev))) { await provider.expireBillingKey(bid).catch(() => {}); return fail(res, 502, 'apply_failed', '결제를 반영하지 못해 자동 취소했습니다.'); }
    } catch (e) {
      if (!(e instanceof BillingError)) throw e;
      await failOrder(db, order.id, e.code, e.message);
      if (bid) await provider.expireBillingKey(bid).catch(() => {});
      return fail(res, e.status, e.code, e.message);
    }
    res.status(201).json(await summary(req.params.wid, req.role));
  }));

  /** Payment window page. Only the OWNER who created the order, only while it is pending. */
  app.get('/api/billing/:provider/pay/:oid', wrap(async (req, res) => {
    if (!provider?.payWindowParams || req.params.provider !== provider.name) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent('/app/settings')}`);
    const order = await getOrder(db, req.params.oid);
    if (!order || order.user_id !== req.user.id || order.provider !== provider.name) return fail(res, 404, 'not_found', '주문을 찾을 수 없습니다.');
    if (!req.user.email_verified_at) return requireVerifiedEmail(fail)(req, res);
    if (order.status === 'PAID') return res.redirect(settingsUrl('success', '', order));
    if (order.status !== 'PENDING' || isExpired(order)) return res.redirect(settingsUrl('failed', 'order_closed', order));
    const base = emailConfig().appBaseUrl || `${req.protocol}://${req.get('host')}`;
    const params = provider.payWindowParams(order, { returnUrl: `${base}/api/billing/${provider.name}/return`, customer: { name: req.user.name, email: req.user.email } });
    res.set('Cache-Control', 'no-store').type('html').send(payPage({ order, params, sdkUrl: provider.sdkUrl, sandbox: provider.mode === 'sandbox' }));
  }));

  /** Operator full refund of a payment: provider cancel → payment.refunded (period shortened by the months it bought). */
  app.post('/api/billing/admin/payments/:id/refund', requireAuth, wrap(async (req, res) => {
    if (req.user.system_role !== 'SYSTEM_ADMIN') return fail(res, 403, 'forbidden', '운영자 권한이 필요합니다.');
    if (!provider?.refund) return unavailable(res);
    const reason = String(req.body?.reason || '').trim().slice(0, 100);
    if (!reason) return fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { reason: '환불 사유를 입력해 주세요.' } });
    const pay = await db.get('SELECT id, provider, status, moid, workspace_id FROM payments WHERE id = ?', [req.params.id]);
    if (!pay) return fail(res, 404, 'not_found', '결제 내역을 찾을 수 없습니다.');
    const order = pay.provider === provider.name ? await getOrder(db, pay.moid) : null;
    if (!order || pay.status !== 'PAID' || order.status !== 'PAID') return fail(res, 409, 'not_refundable', '환불할 수 있는 결제가 아닙니다.');
    if (order.kind === 'CREDIT_PACK') return fail(res, 409, 'use_credit_refund', 'AI 크레딧 결제는 워크스페이스 › AI 크레딧 환불로 처리합니다 (미사용 크레딧만 환불).');
    let ev;
    try { ev = await provider.refund({ order, reason }); }
    catch (e) { if (e instanceof BillingError) return fail(res, e.status, e.code, e.message); throw e; }
    const out = await processWebhookEvent(db, provider.name, ev);
    await writeAudit(db, { adminUserId: req.user.id, action: 'REFUND_PAYMENT', targetType: 'PAYMENT', targetId: pay.id, metadata: { reason, amount: order.amount, workspace_id: pay.workspace_id } });
    res.json({ refunded: true, ...out });
  }));

  /** Daily jobs (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
  app.get('/api/billing/cron/daily', wrap(async (req, res) => {
    const secret = String(process.env.CRON_SECRET || '');
    if (!secret) return fail(res, 503, 'cron_unconfigured', 'CRON_SECRET is not set');
    if (!safeEqual(req.get('authorization'), `Bearer ${secret}`)) return fail(res, 401, 'unauthenticated', '인증이 필요합니다.');
    res.json({ reminders: await sendRenewalReminders(db), renewals: await chargeDueRenewals(db, provider), ai_credits: await grantDueMonthlyCredits(db), early_access: await sendEarlyAccessNotices(db) });
  }));
}
