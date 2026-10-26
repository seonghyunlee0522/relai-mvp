/**
 * Billing API (Phase 10). Two mounts:
 *   mountBillingWebhook — registered BEFORE the global JSON parser, CSRF/Origin check and auth:
 *     POST /api/billing/webhook/:provider   raw body → signature verification (docs/production-readiness.md §6, §8). Own IP rate limiter.
 *     POST /api/billing/nicepay/return      NicePay payment window result (form-urlencoded, cross-site, no session cookie):
 *                                           verify → approve → apply → 303 to /app/settings?checkout=success|failed|canceled#billing
 *   mountBillingRoutes  — workspace-scoped: GET …/billing (any member), GET …/billing/quote, POST …/billing/checkout|cancel|recurring
 *     (OWNER: POLICY.billing); GET /api/billing/nicepay/pay/:orderId (the order's buyer); POST /api/billing/admin/payments/:id/refund
 *     (SYSTEM_ADMIN); GET /api/billing/cron/daily (CRON_SECRET: renewal reminders, renewal charges, monthly AI credit grants, 서비스 결제 cleanup).
 */
import { aiConfig } from '../ai/config.js';
import express from 'express';
import { rateLimiter } from '../security.js';
import { requireAction, can } from '../authz.js';
import { PLANS, PAID_PLANS, USAGE_DIMS, CYCLES, FOUNDING_OFFER, VAT_RATE, CREDIT_PRICE_KRW, PURCHASED_VALID_YEARS, CREDIT_PACKS, catalogue as planCatalogue, oneTimeMode } from '../plans.js';
import { workspaceUsage } from '../usage.js';
import { writeAudit } from '../admin.js';
import { emailConfig } from '../email/config.js';
import { requireVerifiedEmail } from '../auth/account-security.js';
import { BillingError, paymentsEnabled, PAYMENTS_OFF_MESSAGE, CHECKOUT_NOT_OPEN_MESSAGE } from './provider.js';
import { parseCard, safeEqual } from './nicepay.js';
import { OrderError, quoteFor, createOrder, getOrder, isExpired, failOrder, claimCharge, minUsers, MAX_USERS, publicOrder, renewalAmount, quoteAddon, quoteUpgrade, loadQuoteContext } from './orders.js';
import { countUsage, workspaceLimits, overLimit, projectAccess } from './limits.js';
import { FREE_POLICY, FREE_KEEP } from '../email/templates.js';
import { effectivePlan, getSubscription, processWebhookEvent, requestCancel } from './subscriptions.js';
import { sendRenewalReminders, chargeDueRenewals, sendEarlyAccessNotices, expireEndedSubscriptions, notifyPriceIncreases, sendCancelNotice } from './cron.js';
import { disclosure, checkConsent, recordConsent } from './consent.js';
import { scheduledChanges, composeTarget, scheduleChange, cancelScheduledChange, refundQuote, cancelWithRefund, executeRefund, markRefundDone, reopenRefund, listRefunds, refundPartialEnabled } from './lifecycle.js';
import { grantDueMonthlyCredits } from './ai-grants.js';
import { isCreditOrder } from './credit-packs.js';
import { bucketBalances } from '../ai/credits.js';
import { applyServiceEvent, serviceOrdersDaily } from './service-orders.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `₩${Number(n).toLocaleString('ko-KR')}`;
const settingsUrl = (status, reason, order = null) => (isCreditOrder(order)
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
      // 서비스 결제 orders (/pricing, service_orders) are applied there; everything else is in-app billing.
      const out = (await applyServiceEvent(db, provider.name, ev, { refunder: provider })) ?? await processWebhookEvent(db, provider.name, ev);
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
      // Replayed or concurrent return: only the claim holder approves; the other shows the current state and approves nothing.
      if (!(await claimCharge(db, order.id))) {
        const now = await getOrder(db, order.id);
        if (now?.status === 'PAID') return res.redirect(303, settingsUrl('success', '', order));
        return res.redirect(303, now?.status === 'PENDING' ? settingsUrl('processing', '', order) : settingsUrl('failed', now?.failure_code || 'order_closed', order));
      }
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
  const pack = isCreditOrder(order);
  const back = pack ? '/app/settings/credits' : '/app/settings#billing';
  const rows = pack ? `${row('AI 크레딧', `${Number(order.credits).toLocaleString('ko-KR')} 크레딧 (1 크레딧 = ₩${CREDIT_PRICE_KRW})`)}${row('공급가액', won(order.supply_amount))}${row('부가세 (10%)', won(order.vat_amount))}`
    : oneTimeMode() && Number(order.months) === 1 ? `${row('상품', '1개월 이용권 (자동 갱신 없음)')}${row('사용자', `${order.seats}명 (소유자 포함)`)}${row('이용 기간', '결제일부터 1개월')}${row('공급가액', won(order.supply_amount))}${row('부가세 (10%)', won(order.vat_amount))}`
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
<body><main><div class="card"><h1>${esc(order.goods_name)}</h1>${sandbox ? '<p class="note">샌드박스 결제입니다. 실제로 청구되지 않습니다.</p>' : ''}<table>
${rows}
${row('결제 수단', '신용카드')}
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
  /**
   * Feature flags of the v3 billing screens (design.md §10); all off unless set. Paid plans are sold ONLY as 정기결제 (founder
   * 2026-10-20: no one-time passes): checkout_open = PAYMENTS_ENABLED and NICEPAY_RECURRING_ENABLED (the provider's recurringEnabled).
   * ONE_TIME_PLANS_ENABLED=true re-opens the retired one-time plan checkout (kept for the existing tests; never set in prod).
   */
  const flags = () => ({ payments: paymentsEnabled(), recurring: Boolean(provider?.recurringEnabled), checkout_open: checkoutOpen(),
    one_time: oneTimeMode(), addons: process.env.ADDONS_ENABLED === 'true' && !oneTimeMode(), plan_change: process.env.PLAN_CHANGE_ENABLED === 'true', refund_partial: refundPartialEnabled() });
  const checkoutOpen = () => paymentsEnabled() && Boolean(provider?.recurringEnabled && provider.registerBillingKey);
  // 단건결제 모드 (ONE_TIME_PAYMENT_MODE) opens the one-time plan checkout as Pro / Team 1개월 이용권.
  const oneTimeOpen = () => process.env.ONE_TIME_PLANS_ENABLED === 'true' || oneTimeMode();
  const notOpen = (res) => fail(res, 409, 'checkout_not_open', CHECKOUT_NOT_OPEN_MESSAGE);
  /** Gate for paid checkout: payments off → payments_disabled; recurring not approved → checkout_not_open. True when it answered. */
  const closed = (res) => { if (!paymentsEnabled()) { paymentsOff(res); return true; } if (!checkoutOpen()) { notOpen(res); return true; } return false; };
  const consentFail = (res, e, d) => fail(res, e.status, e.code, e.message, { fields: e.fields, disclosure: d });
  /**
   * GET …/billing (pricing v3 shape, T1; T2 fills credits buckets, T3 scheduled changes / renewal state):
   * { plan, cycle, status, auto_renew, next_payment_at, next_payment_amount, limits {projects, users}, usage {projects_active, members, pending_invites, …dims},
   *   addons {extra_users, extra_projects}, scheduled [], credits {total, plan, plan_expires_at, promo, purchased}, catalogue, flags, over_limit, … }
   */
  const summary = async (wid, role) => {
    const { plan, limits } = await workspaceLimits(db, wid);
    const subscription = (await getSubscription(db, wid)) || null;
    const row = subscription ? await db.get('SELECT extra_users, extra_projects, price_version, renewal_amount FROM subscriptions WHERE workspace_id = ?', [wid]) : null;
    const paid = PAID_PLANS.includes(plan) && subscription && subscription.plan === plan;
    const cycle = paid ? subscription.billing_cycle || 'MONTHLY' : null;
    const renews = paid && !subscription.cancel_at_period_end;
    const addons = { extra_users: paid ? Number(row?.extra_users || 0) : 0, extra_projects: paid ? Number(row?.extra_projects || 0) : 0 };
    const counts = await countUsage(db, wid);
    const over = await overLimit(db, wid);
    // founder policy 2026-10-21: newest projects (created_at) up to the plan's limit stay editable, the rest are read-only
    const access = await projectAccess(db, wid);
    const roRows = access.readOnly.size ? await db.all(`SELECT id, name FROM projects WHERE workspace_id = ? AND id IN (${[...access.readOnly].map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC`, [wid, ...access.readOnly]) : [];
    const edRows = roRows.length && access.editable.length ? await db.all(`SELECT id, name FROM projects WHERE workspace_id = ? AND id IN (${access.editable.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC`, [wid, ...access.editable]) : [];
    // T2: bucket view (ai/credits.js bucketBalances) — total = plan + promo + purchased; plan expires at plan_expires_at.
    const creditBuckets = async (w) => { const c = await bucketBalances(db, w); return { total: c.total, plan: c.plan, plan_expires_at: c.plan_expires_at, promo: c.promo, purchased: c.purchased, available: c.available }; };
    // One-time purchases can be extended at any time; a renewing (recurring) subscription cannot be bought twice.
    const canPurchase = checkoutOpen() ? !(paid && renews) : paymentsEnabled() && oneTimeOpen() && (plan === 'FREE' || (subscription && !subscription.auto_renew));
    const early = await db.get('SELECT early_access_until FROM workspaces WHERE id = ?', [wid]);
    const full = subscription ? await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [wid]) : null;
    const changes = paid ? await scheduledChanges(db, full.id) : [];
    const target = paid && renews && row?.price_version !== 'v2' ? composeTarget(full, changes) : null;
    const notice = full ? await db.get(`SELECT id, old_amount, new_amount, effective_at, notified_at, consented_at, declined_at FROM price_change_notices
      WHERE subscription_id = ? AND consented_at IS NULL AND declined_at IS NULL AND effective_at > now() ORDER BY effective_at LIMIT 1`, [full.id]) : null;
    return { billing: {
      plan, plan_label: PLANS[plan].label, cycle, status: subscription && paid ? subscription.status : null, auto_renew: Boolean(paid && subscription.auto_renew),
      next_payment_at: renews ? subscription.next_billing_at || subscription.current_period_end : null,
      next_payment_amount: renews ? (row?.price_version === 'v2' ? row?.renewal_amount ?? null : target ? target.amount : renewalAmount(plan, cycle, addons.extra_users, addons.extra_projects)) : null,
      next_payment: target ? { plan: target.plan, cycle: target.cycle, extra_users: target.extra_users, extra_projects: target.extra_projects, amount: target.amount } : null,
      renewal_amount: paid ? row?.renewal_amount ?? null : null, retry_count: paid ? Number(full?.retry_count || 0) : 0,
      cancel_at_period_end: Boolean(paid && subscription.cancel_at_period_end), period_end: paid ? subscription.current_period_end : null,
      ended_at: full?.ended_at || null, data_retention_until: full?.data_retention_until && new Date(full.data_retention_until) > new Date() ? full.data_retention_until : null,
      price_notice: notice ? { id: notice.id, old_amount: notice.old_amount, new_amount: notice.new_amount, effective_at: notice.effective_at,
        disclosure: disclosure('PRICE_INCREASE', { plan: full.plan, cycle: full.billing_cycle || 'MONTHLY', old_amount: notice.old_amount, new_amount: notice.new_amount, effective_at: notice.effective_at }) } : null,
      refunds: subscription ? await listRefunds(db, wid) : [],
      limits, usage: { ...(await workspaceUsage(db, wid, plan)), ...counts, seats_left: limits.users === null ? null : Math.max(0, limits.users - counts.members - counts.pending_invites) },
      // to = what the screen names (plan key for DOWNGRADE, cycle key for CYCLE, null for ADDON_REDUCE); to_state = the full target fields.
      addons, scheduled: changes.map((c) => ({ id: c.id, kind: c.kind, from: c.from, to: c.kind === 'DOWNGRADE' ? c.to.plan : c.kind === 'CYCLE' ? c.to.cycle : null, to_state: c.to,
        effective_at: c.effective_at, cancel_url: `/api/workspaces/${wid}/billing/changes/${c.id}/cancel` })), credits: await creditBuckets(wid),
      // 해지: POST cancel_url (auto-renew stops, plan to period end) · POST cancel_url { refund: true } (ends now + unused days refunded; preview: refund_quote_url).
      cancel_url: paid && renews ? `/api/workspaces/${wid}/billing/cancel` : null, refund_quote_url: paid ? `/api/workspaces/${wid}/billing/refund-quote` : null,
      refund: paid ? await refundQuote(db, wid).then((q) => ({ eligible: Boolean(q.eligible), mode: q.mode, total: q.total, ends_at: q.ends_at, reason: q.reason, refund_until: q.refund_until })) : null,   // 7일 이내 미사용 전액 환불 (founder 2026-10-26)
      catalogue: planCatalogue(), flags: flags(), over_limit: over ? { projects: over.projects, members: over.members } : null,
      read_only_projects: roRows.length ? { limit: access.limit, editable: edRows, read_only: roRows } : null,
      cancel_policy: { free: FREE_POLICY, keep: FREE_KEEP }, price_version: row?.price_version || null,
      subscription, early_access_until: early?.early_access_until || null,
      plans: planCatalogue().plans, credit_packs: CREDIT_PACKS.map((p) => ({ key: p.key, credits: p.credits, amount: p.amount })), dims: USAGE_DIMS, starter_credits: aiConfig().trialCredits,
      provider_available: Boolean(provider), payments_enabled: paymentsEnabled(), can_manage: can(role, 'billing'),
      checkout: { can_purchase: Boolean(canPurchase), plans: PAID_PLANS, cycles: Object.values(CYCLES).map((c) => ({ key: c.key, label: c.label, months: c.months, discount_pct: c.discount_pct })),
        min_users: await minUsers(db, wid), max_users: MAX_USERS, vat_rate: VAT_RATE, prices_include_vat: true, prices_exclude_vat: false,
        recurring_available: Boolean(provider?.recurringEnabled), sandbox: provider?.mode === 'sandbox' } } };
  };
  app.get(b, guard, wrap(async (req, res) => res.json(await summary(req.params.wid, req.role))));

  /**
   * GET …/billing/quote — every amount a screen shows comes from here (no ₩ computed in the browser), with the 고지 (disclosure) the
   * customer consents to: kind PLAN (default; plan, cycle, extra_users, extra_projects), ADDON (extra_users, extra_projects to add now),
   * UPGRADE (plan). → { quote, disclosure }.
   */
  const quoteOf = async (wid, src) => {
    const kind = String(src.kind || 'PLAN').toUpperCase();
    if (kind === 'ADDON' || kind === 'UPGRADE') {
      const { sub } = await loadQuoteContext(db, wid);
      const q = kind === 'ADDON' ? quoteAddon({ wid, sub, extra_users: src.extra_users, extra_projects: src.extra_projects })
        : quoteUpgrade({ wid, sub, plan: String(src.plan || 'TEAM') });
      return { quote: q, disclosure: disclosure(kind, q), sub };
    }
    const q = await quoteFor(db, wid, { plan: String(src.plan || 'PRO'), cycle: String(src.cycle || 'MONTHLY'), users: src.users ?? src.seats, extra_users: src.extra_users, extra_projects: src.extra_projects });
    return { quote: q, disclosure: disclosure('CHECKOUT', q) };
  };
  app.get(`${b}/quote`, guard, wrap(async (req, res) => {
    try { const { quote, disclosure: d } = await quoteOf(req.params.wid, req.query); res.json({ quote, disclosure: d }); }
    catch (e) { if (e instanceof OrderError) return orderFail(res, e); throw e; }
  }));

  /** Shared checkout validation: PRO / TEAM, purchasable, provider present. Returns the quote or null after answering. */
  const prepare = async (req, res, { recurring = false } = {}) => {
    if (!paymentsEnabled()) { paymentsOff(res); return null; }
    if (!recurring && !oneTimeOpen()) { notOpen(res); return null; }
    const plan = String(req.body?.plan || 'PRO');
    if (!PAID_PLANS.includes(plan)) { fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { plan: PLANS[plan]?.contact_sales ? 'Enterprise는 영업 문의로 계약합니다.' : '선택할 수 없는 플랜입니다.' } }); return null; }
    if (!provider) { unavailable(res); return null; }
    const sub = await getSubscription(db, req.params.wid);
    const current = await effectivePlan(db, req.params.wid);
    if (current === plan && sub?.auto_renew) { fail(res, 409, 'already_subscribed', `이미 ${PLANS[plan].label} 플랜을 사용 중입니다.`); return null; }
    if (recurring && PAID_PLANS.includes(current) && sub?.auto_renew && !sub.cancel_at_period_end) { fail(res, 409, 'already_subscribed', `이미 ${PLANS[current].label} 플랜을 구독 중입니다. 플랜 변경을 이용해 주세요.`); return null; }
    // 단건결제 모드: 1개월 이용권 only — MONTHLY, the plan's included users and projects, no add-ons
    if (!recurring && oneTimeMode() && String(req.body?.cycle || 'MONTHLY') !== 'MONTHLY') { fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { cycle: '1개월 이용권만 구매할 수 있습니다.' } }); return null; }
    const one = !recurring && oneTimeMode();
    try { return await quoteFor(db, req.params.wid, { plan, cycle: one ? 'MONTHLY' : String(req.body?.cycle || 'MONTHLY'), users: one ? undefined : req.body?.users ?? req.body?.seats, extra_users: one ? 0 : req.body?.extra_users, extra_projects: one ? 0 : req.body?.extra_projects }); }
    catch (e) { if (e instanceof OrderError) { orderFail(res, e); return null; } throw e; }
  };

  /**
   * POST …/billing/checkout — paid plans are sold only as 정기결제 (founder 2026-10-20). Until NicePay approves recurring billing the
   * answer is 409 checkout_not_open (screens show 정기결제 준비 중). With recurring open it is the same as POST …/billing/recurring
   * (card registration + first charge + consent). ONE_TIME_PLANS_ENABLED=true keeps the retired one-time window path for tests.
   */
  app.post(`${b}/checkout`, payer, wrap(async (req, res) => {
    if (paymentsEnabled() && checkoutOpen() && req.body?.card) return subscribe(req, res);
    if (paymentsEnabled() && !oneTimeOpen()) return checkoutOpen() ? fail(res, 400, 'card_required', '정기결제에 쓸 카드 정보를 입력해 주세요.') : notOpen(res);
    const q = await prepare(req, res); if (!q) return;
    const workspace = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [req.params.wid]);
    const order = await createOrder(db, { workspaceId: workspace.id, userId: req.user.id, provider: provider.name, kind: 'ONE_TIME', q });
    const out = await provider.createCheckout({ workspace, plan: q.plan, order, customer: { id: req.user.id, email: req.user.email, name: req.user.name },
      successUrl: '/app/settings', cancelUrl: '/app/settings' });
    res.status(201).json({ checkout_url: out.checkout_url, session_id: out.session_id, provider: provider.name, order: publicOrder(order) });
  }));

  /**
   * POST …/billing/cancel — 해지, any time, monthly and annual: auto-renewal stops at once and the plan runs to the end of what was
   * paid. { refund: true } only when billing/lifecycle.js refundQuote allows it: FULL (7 days, unused → whole payment, ends now) or
   * ANNUAL (mid-term → runs to the end of this billing month, refund = paid − months × monthly list price). One click + one confirm.
   */
  app.post(`${b}/cancel`, payer, wrap(async (req, res) => {
    if (!provider) return unavailable(res);
    if (req.body?.refund === true || req.body?.refund === 'true') {
      const out = await cancelWithRefund(db, provider, { workspaceId: req.params.wid, userId: req.user.id, reason: String(req.body?.reason || '고객 해지 환불').slice(0, 100) });
      if (out.error === 'not_refundable') return fail(res, 409, out.error, out.reason === 'used' ? '결제 후 서비스를 이용해 환불 대상이 아닙니다. 해지하면 이용 기간이 끝날 때까지 쓰고 다음 결제는 되지 않습니다.' : out.reason === 'annual_nothing' ? '이용한 개월 수를 월간 요금으로 계산하면 환불 가능한 금액이 없습니다. 해지하면 결제한 기간이 끝날 때까지 쓰고 다음 결제는 되지 않습니다.' : '결제 후 7일이 지나 환불 대상이 아닙니다. 해지하면 이용 기간이 끝날 때까지 쓰고 다음 결제는 되지 않습니다.', { reason: out.reason });
      if (out.error) return fail(res, 409, out.error, '해지할 구독이 없습니다.');
      const immediate = out.mode !== 'ANNUAL';
      await sendCancelNotice(db, req.params.wid, { immediate, refunds: out.refunds, total: out.total, executed: out.executed }).catch((e) => console.error('[billing] cancel mail failed', e.message));
      return res.json({ ...(await summary(req.params.wid, req.role)), cancel: { immediate, mode: out.mode, ends_at: out.ends_at, refund_total: out.total, withdrawal: out.withdrawal, refunds: out.refunds.map((r) => ({ id: r.id, kind: r.kind, amount: r.amount, days: r.days, period_days: r.period_days, status: r.status || 'REQUESTED' })) } });
    }
    const out = await requestCancel(db, provider, req.params.wid);
    if (out.error === 'no_active_subscription') return fail(res, 409, out.error, '해지할 구독이 없습니다.');
    if (out.error === 'already_canceled') return fail(res, 409, out.error, '이미 해지 예약된 구독입니다.');
    if (out.error === 'not_recurring') return fail(res, 409, out.error, '자동 갱신이 이미 꺼져 있습니다. 결제한 기간이 끝나면 Free 플랜으로 전환됩니다.');
    await sendCancelNotice(db, req.params.wid, { immediate: false }).catch((e) => console.error('[billing] cancel mail failed', e.message));
    res.json({ ...(await summary(req.params.wid, req.role)), cancel: { immediate: false } });
  }));

  /** GET …/billing/refund-quote — what 해지 + 환불 would refund right now (per order: unused days / period days, amount). */
  app.get(`${b}/refund-quote`, owner, wrap(async (req, res) => {
    const q = await refundQuote(db, req.params.wid);
    res.json({ refund: { total: q.total, withdrawal: Boolean(q.withdrawal), eligible: Boolean(q.eligible), mode: q.mode, ends_at: q.ends_at, reason: q.reason, refund_until: q.refund_until, lines: q.lines.map(({ order_id, kind, order_kind, label, paid, paid_at, days, period_days, months_used, monthly_price, amount }) => ({ order_id, kind, order_kind, label, paid, paid_at, days, period_days, months_used, monthly_price, amount })) } });
  }));

  /**
   * 정기결제 구독 (new subscription): consent to the disclosure of this exact quote → billing key registration → first charge.
   * POST …/billing/recurring { plan, cycle, extra_users?, extra_projects?, card, agree, disclosure_hash }.
   */
  /** The other request of a double click (same client_key) lost the charge claim: it charges nothing and reports the order's current state. */
  const lostClaim = async (res, wid, role, orderId, paidStatus = 200) => {
    const o = await getOrder(db, orderId);
    if (o?.status === 'PAID') return res.status(paidStatus).json(await summary(wid, role));
    if (o?.status === 'PENDING') return fail(res, 409, 'order_in_progress', '결제를 처리하고 있습니다. 잠시 후 화면을 새로 고쳐 주세요.');
    return fail(res, 409, 'order_closed', '이미 처리된 주문입니다. 화면을 새로 고쳐 주세요.');
  };
  const subscribe = async (req, res) => {
    if (closed(res)) return;
    let card;
    try { card = parseCard(req.body?.card); } catch (e) { if (e instanceof BillingError) return fail(res, e.status, e.code, e.message, { fields: e.fields }); throw e; }
    const q = await prepare(req, res, { recurring: true }); if (!q) return;
    const d = disclosure('CHECKOUT', q);
    const bad = checkConsent(req.body, d); if (bad) return consentFail(res, bad, d);
    const order = await createOrder(db, { workspaceId: req.params.wid, userId: req.user.id, provider: provider.name, kind: 'RECURRING_FIRST', q, clientKey: req.body?.client_key });
    if (order.status !== 'PENDING') return order.status === 'PAID' ? res.status(201).json(await summary(req.params.wid, req.role)) : fail(res, 409, 'order_closed', '이미 처리된 주문입니다. 화면을 새로 고쳐 주세요.');
    if (!(await claimCharge(db, order.id))) return lostClaim(res, req.params.wid, req.role, order.id, 201);
    await recordConsent(db, { workspaceId: req.params.wid, userId: req.user.id, orderId: order.id, kind: 'CHECKOUT', d, amount: q.total, renewalAmount: q.next_renewal_amount, cycle: q.cycle, nextChargeAt: q.next_renewal_at, req });
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
  };
  app.post(`${b}/recurring`, payer, wrap(async (req, res) => {
    if (paymentsEnabled() && !checkoutOpen()) return fail(res, 404, 'recurring_disabled', CHECKOUT_NOT_OPEN_MESSAGE);
    return subscribe(req, res);
  }));

  /**
   * Charge an in-period order (ADDON / UPGRADE) on the stored billing key. A total waived under MIN_CARD_KRW is applied without a
   * charge. A decline only fails the order (the subscription is not PAST_DUE for a declined add-on). Returns true when applied.
   */
  const chargeInPeriod = async (res, wid, order) => {
    if (Number(order.amount) === 0) {
      const out = await processWebhookEvent(db, provider.name, { id: `waived:${order.id}`, type: 'subscription.activated', order_id: order.id, payment: { amount: 0, currency: 'KRW', status: 'PAID', provider_tid: `waived:${order.id}`, moid: order.id }, payload: { waived: true } });
      if (out.ignored) { fail(res, 409, 'apply_failed', '변경을 반영하지 못했습니다.'); return false; }
      return true;
    }
    const sub = await db.get('SELECT billing_key_enc FROM subscriptions WHERE workspace_id = ?', [wid]);
    let ev;
    try { ev = await provider.chargeBillingKey({ bidEnc: sub.billing_key_enc, order }); }
    catch (e) { if (!(e instanceof BillingError)) throw e; await failOrder(db, order.id, e.code, e.message); fail(res, e.status, e.code, e.message); return false; }
    if (ev.type !== 'subscription.activated') { await failOrder(db, order.id, ev.payment?.failure_code || 'declined', ev.payment?.failure_message); fail(res, 402, 'payment_failed', ev.payment?.failure_message || '결제가 승인되지 않았습니다.'); return false; }
    if (!(await applyOrRefund(db, provider, order, ev))) { fail(res, 502, 'apply_failed', '결제를 반영하지 못해 자동 취소했습니다.'); return false; }
    return true;
  };
  /** Shared ADDON / UPGRADE flow: flags, a renewing subscription with a card on file, consent, order (client_key), charge. */
  const inPeriod = (kind) => wrap(async (req, res) => {
    if (closed(res)) return;
    if (kind === 'ADDON' && process.env.ADDONS_ENABLED !== 'true') return fail(res, 409, 'addons_disabled', '추가 구매는 아직 열리지 않았습니다.');
    if (kind === 'UPGRADE' && process.env.PLAN_CHANGE_ENABLED !== 'true') return fail(res, 409, 'plan_change_disabled', '플랜 변경은 아직 열리지 않았습니다.');
    const wid = req.params.wid;
    let quote; let d; let sub;
    try { ({ quote, disclosure: d, sub } = await quoteOf(wid, { ...req.body, kind })); } catch (e) { if (e instanceof OrderError) return orderFail(res, e); throw e; }
    if (!sub?.billing_key_enc || !sub.auto_renew || sub.cancel_at_period_end) return fail(res, 409, 'not_renewing', '정기결제 중인 구독에서만 바로 변경할 수 있습니다. 해지 예약된 구독은 다음 결제가 없습니다.');
    const bad = checkConsent(req.body, d); if (bad) return consentFail(res, bad, d);
    const order = await createOrder(db, { workspaceId: wid, userId: req.user.id, provider: provider.name, kind, q: quote, clientKey: req.body?.client_key });
    if (order.status === 'PAID') return res.json(await summary(wid, req.role));
    if (order.status !== 'PENDING') return fail(res, 409, 'order_closed', '이미 처리된 주문입니다. 화면을 새로 고쳐 주세요.');
    if (!(await claimCharge(db, order.id))) return lostClaim(res, wid, req.role, order.id);
    await recordConsent(db, { workspaceId: wid, userId: req.user.id, orderId: order.id, kind, d, amount: quote.total, renewalAmount: quote.next_renewal_amount, cycle: quote.cycle, nextChargeAt: quote.next_renewal_at, req });
    if (!(await chargeInPeriod(res, wid, order))) return;
    res.status(201).json({ ...(await summary(wid, req.role)), order: publicOrder(await getOrder(db, order.id)) });
  });
  /** POST …/billing/addons { extra_users, extra_projects, agree, disclosure_hash, client_key } — more users / projects now, prorated. */
  app.post(`${b}/addons`, payer, inPeriod('ADDON'));
  /** POST …/billing/upgrade { plan: 'TEAM', agree, disclosure_hash, client_key } — PRO → TEAM now, prorated difference, +credits. */
  app.post(`${b}/upgrade`, payer, inPeriod('UPGRADE'));

  /**
   * POST …/billing/changes { kind: DOWNGRADE | CYCLE | ADDON_REDUCE, … } — scheduled for the next renewal (no refund now). A change that
   * raises the renewal amount (월간 → 연간) needs consent to the new renewal: the first call answers 400 consent_required with the
   * disclosure, the second carries agree + disclosure_hash. DELETE …/billing/changes/:id withdraws one.
   */
  app.post(`${b}/changes`, payer, wrap(async (req, res) => {
    const kind = String(req.body?.kind || '').toUpperCase();
    if (['DOWNGRADE', 'CYCLE'].includes(kind) && process.env.PLAN_CHANGE_ENABLED !== 'true') return fail(res, 409, 'plan_change_disabled', '플랜 변경은 아직 열리지 않았습니다.');
    if (kind === 'ADDON_REDUCE' && process.env.ADDONS_ENABLED !== 'true') return fail(res, 409, 'addons_disabled', '추가 구매 변경은 아직 열리지 않았습니다.');
    const wid = req.params.wid;
    const full = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [wid]);
    let d = null;
    if (full && kind === 'CYCLE') {
      const others = (await scheduledChanges(db, full.id)).filter((c) => c.kind !== 'CYCLE');
      const target = composeTarget(full, [...others, { kind, to: { cycle: String(req.body?.cycle || '') } }]);
      if (target.amount !== null && target.amount > Number(full.renewal_amount ?? 0)) {
        d = disclosure('CHECKOUT', { plan: target.plan, cycle: target.cycle, total: 0, lines: [], next_renewal_amount: target.amount, next_renewal_at: full.current_period_end });
        const bad = checkConsent(req.body, d); if (bad) return consentFail(res, bad, d);
      }
    }
    try {
      const out = await scheduleChange(db, { workspaceId: wid, userId: req.user.id, kind, body: req.body || {} });
      if (d) await recordConsent(db, { workspaceId: wid, userId: req.user.id, kind: 'RECURRING', d, amount: 0, renewalAmount: out.target.amount, cycle: out.target.cycle, nextChargeAt: full.current_period_end, req });
      res.status(201).json({ ...(await summary(wid, req.role)), change: out.change });
    } catch (e) { if (e instanceof OrderError) return orderFail(res, e); throw e; }
  }));
  const withdrawChange = wrap(async (req, res) => {
    if (!(await cancelScheduledChange(db, { workspaceId: req.params.wid, changeId: req.params.cid }))) return fail(res, 404, 'not_found', '예약된 변경을 찾을 수 없습니다.');
    res.json(await summary(req.params.wid, req.role));
  });
  app.delete(`${b}/changes/:cid`, payer, withdrawChange);
  app.post(`${b}/changes/:cid/cancel`, payer, withdrawChange);   // scheduled[].cancel_url

  /** POST …/billing/price-consent { notice_id, agree, disclosure_hash } — 증액 동의 (§13⑥): the renewal may charge the new amount. */
  app.post(`${b}/price-consent`, payer, wrap(async (req, res) => {
    const n = await db.get(`SELECT p.*, s.plan, s.billing_cycle FROM price_change_notices p JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.id = ? AND p.workspace_id = ? AND p.consented_at IS NULL AND p.declined_at IS NULL AND p.effective_at > now()`, [String(req.body?.notice_id || ''), req.params.wid]);
    if (!n) return fail(res, 404, 'not_found', '동의할 가격 변경 안내가 없습니다.');
    const d = disclosure('PRICE_INCREASE', { plan: n.plan, cycle: n.billing_cycle || 'MONTHLY', old_amount: n.old_amount, new_amount: n.new_amount, effective_at: n.effective_at });
    if (req.body?.decline === true) {
      await db.run('UPDATE price_change_notices SET declined_at = now() WHERE id = ?', [n.id]);
      return res.json(await summary(req.params.wid, req.role));
    }
    const bad = checkConsent(req.body, d); if (bad) return consentFail(res, bad, d);
    const cid = await recordConsent(db, { workspaceId: req.params.wid, userId: req.user.id, kind: 'PRICE_INCREASE', d, renewalAmount: n.new_amount, cycle: n.billing_cycle, nextChargeAt: n.effective_at, req });
    await db.run('UPDATE price_change_notices SET consented_at = now(), consent_id = ? WHERE id = ? AND consented_at IS NULL', [cid, n.id]);
    res.json(await summary(req.params.wid, req.role));
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
    if (isCreditOrder(order)) return fail(res, 409, 'use_credit_refund', 'AI 크레딧 결제는 워크스페이스 › AI 크레딧 환불로 처리합니다 (미사용 크레딧만 환불).');
    let ev;
    try { ev = await provider.refund({ order, reason }); }
    catch (e) { if (e instanceof BillingError) return fail(res, e.status, e.code, e.message); throw e; }
    const out = await processWebhookEvent(db, provider.name, ev);
    await writeAudit(db, { adminUserId: req.user.id, action: 'REFUND_PAYMENT', targetType: 'PAYMENT', targetId: pay.id, metadata: { reason, amount: order.amount, workspace_id: pay.workspace_id } });
    res.json({ refunded: true, ...out });
  }));

  /** Operator: subscription refunds (해지 환불 / 청약철회) — list open ones, retry a failed partial cancel, or mark one paid by hand. */
  const admin = (req, res) => { if (req.user?.system_role !== 'SYSTEM_ADMIN') { fail(res, 403, 'forbidden', '운영자 권한이 필요합니다.'); return false; } return true; };
  app.get('/api/billing/admin/subscription-refunds', requireAuth, wrap(async (req, res) => {
    if (!admin(req, res)) return;
    // ?status=REQUESTED|FAILED|DONE|ALL (default: open = not DONE). 관리자 › 환불 관리 lists who must be refunded by hand.
    const status = ['REQUESTED', 'FAILED', 'DONE'].includes(req.query.status) ? req.query.status : null;
    const where = status ? 'WHERE r.status = ?' : req.query.status === 'ALL' ? '' : "WHERE r.status <> 'DONE'";
    const rows = await db.all(`SELECT r.id, r.workspace_id, w.name AS workspace_name, u.name AS owner_name, u.email AS owner_email, r.order_id, o.goods_name, o.amount AS paid_amount, o.paid_at,
        o.provider_tid, r.kind, r.amount, r.days, r.period_days, r.status, r.failure_message, r.reason, r.created_at, r.done_at
      FROM subscription_refunds r JOIN workspaces w ON w.id = r.workspace_id LEFT JOIN users u ON u.id = w.owner_id LEFT JOIN billing_orders o ON o.id = r.order_id
      ${where} ORDER BY r.created_at DESC LIMIT 300`, status ? [status] : []);
    const open = await db.get(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::int AS amount FROM subscription_refunds WHERE status <> 'DONE'`);
    res.json({ refunds: rows.map(({ provider_tid, ...r }) => ({ ...r, provider_tid: provider_tid || null })), open });
  }));
  app.post('/api/billing/admin/subscription-refunds/:id/:action', requireAuth, wrap(async (req, res) => {
    if (!admin(req, res)) return;
    const r = await db.get('SELECT id, workspace_id, status, amount FROM subscription_refunds WHERE id = ?', [req.params.id]);
    if (!r) return fail(res, 404, 'not_found', '환불 건을 찾을 수 없습니다.');
    if (req.params.action === 'reopen') {
      if (r.status !== 'DONE') return fail(res, 409, 'not_done', '완료된 환불만 되돌릴 수 있습니다.');
      const ok = await reopenRefund(db, r.id);
      if (!ok) return fail(res, 409, 'not_reopenable', '결제사에서 자동 취소된 환불은 되돌릴 수 없습니다.');
      await writeAudit(db, { adminUserId: req.user.id, action: 'SUBSCRIPTION_REFUND_REOPEN', targetType: 'SUBSCRIPTION_REFUND', targetId: r.id, metadata: { amount: r.amount, workspace_id: r.workspace_id } });
      return res.json({ refund: { id: r.id, status: 'REQUESTED' } });
    }
    if (r.status === 'DONE') return fail(res, 409, 'already_done', '이미 처리된 환불입니다.');
    let out;
    if (req.params.action === 'retry') { if (!provider?.refundPartial) return unavailable(res); out = await executeRefund(db, provider, r.id); }
    else if (req.params.action === 'done') out = { status: (await markRefundDone(db, r.id, { note: req.body?.note })) ? 'DONE' : r.status };
    else return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    await writeAudit(db, { adminUserId: req.user.id, action: `SUBSCRIPTION_REFUND_${req.params.action.toUpperCase()}`, targetType: 'SUBSCRIPTION_REFUND', targetId: r.id, metadata: { amount: r.amount, workspace_id: r.workspace_id, result: out.status } });
    res.json({ refund: { id: r.id, ...out } });
  }));

  /** Daily jobs (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
  app.get('/api/billing/cron/daily', wrap(async (req, res) => {
    const secret = String(process.env.CRON_SECRET || '');
    if (!secret) return fail(res, 503, 'cron_unconfigured', 'CRON_SECRET is not set');
    if (!safeEqual(req.get('authorization'), `Bearer ${secret}`)) return fail(res, 401, 'unauthenticated', '인증이 필요합니다.');
    res.json({ reminders: await sendRenewalReminders(db), price_notices: await notifyPriceIncreases(db), renewals: await chargeDueRenewals(db, provider),
      expired: await expireEndedSubscriptions(db, provider), ai_credits: await grantDueMonthlyCredits(db), early_access: await sendEarlyAccessNotices(db),
      service_orders: await serviceOrdersDaily(db) });
  }));
}
