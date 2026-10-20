/**
 * RELAI 서비스 결제 — a public page, no RELAI login (founder 2026-10-20; layout after docreel.kr/pricing).
 *   GET  /pricing[?plan=once|monthly&product=agent]   product cards, buyer form, consents, 결제 전 확인해주세요, contact, business footer
 *   POST /api/service-pay/orders                       { product, buyer, agree_* } → service_orders row (catalogue amount) + NicePay window params
 *   POST /api/service-pay/nicepay/return               NicePay window result (form POST, cross-site): verify → approve (amount from the order) → apply → 303
 *   POST /api/service-pay/subscriptions                월 구독 (billing key). Refused while NICEPAY_RECURRING_ENABLED is off; the page never calls it then
 *   GET  /pricing/done?order=…  · /pricing/failed?reason=…
 *   GET  /api/admin/service-orders                     SYSTEM_ADMIN, read-only (관리자 › 결제)
 * The NicePay webhook stays /api/billing/webhook/nicepay; billing/routes.js hands service orders to applyServiceEvent.
 * SERVICE_PAY_ENABLED=false closes checkout (the page still renders). Without a NicePay provider checkout answers 503.
 */
import express from 'express';
import { rateLimiter } from './security.js';
import { BillingError } from './billing/provider.js';
import { LEGAL, legalFooterHtml } from '../public/app/shared/legal-info.js';
import { shareMeta } from './share-meta.js';
import { SERVICE_PRODUCTS, productFor, RECURRING_SOON, ServiceOrderError, parseBuyer, createServiceOrder, getServiceOrder, failServiceOrder,
  applyServiceEvent, listServiceOrders, serviceBaseUrl } from './billing/service-orders.js';

const ORDER_TTL_MS = 60 * 60e3;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
export const servicePayEnabled = () => String(process.env.SERVICE_PAY_ENABLED ?? '').trim().toLowerCase() !== 'false';
const checkoutReady = (provider) => servicePayEnabled() && Boolean(provider?.payWindowParams && provider?.completeReturn);
const done = (id) => `/pricing/done?order=${encodeURIComponent(id)}`;
const failed = (reason, id) => `/pricing/failed?reason=${encodeURIComponent(reason || 'failed')}${id ? `&order=${encodeURIComponent(id)}` : ''}`;

/** NicePay window result. Mounted BEFORE the JSON parser / Origin check: NicePay posts it cross-site as a form. */
export function mountServicePayReturn(app, db, { provider }) {
  if (!provider?.completeReturn) return;
  const limiter = rateLimiter(db, { name: 'service-pay-return', max: 120, windowMs: 60 * 1000 });
  app.post(`/api/service-pay/${provider.name}/return`, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res, next) => {
    try {
      if (await limiter.blocked(req.ip)) return res.redirect(303, failed('rate_limited'));
      await limiter.hit(req.ip);
      const form = req.body || {};
      const order = await getServiceOrder(db, form.orderId);
      if (!order || order.provider !== provider.name || order.kind !== 'ONE_TIME') return res.redirect(303, failed('unknown_order'));
      if (order.status === 'PAID') return res.redirect(303, done(order.id));   // replayed return: approve only once
      if (order.status !== 'PENDING') return res.redirect(303, failed(order.failure_code || 'order_closed', order.id));
      if (Date.now() - new Date(order.created_at).getTime() > ORDER_TTL_MS) { await failServiceOrder(db, order.id, 'expired', '결제 시간이 초과되었습니다.'); return res.redirect(303, failed('expired', order.id)); }
      let ev;
      try { ev = await provider.completeReturn({ form, order }); }   // window signature + amount === order.amount, then approve order.amount
      catch (e) {
        if (!(e instanceof BillingError)) throw e;
        await failServiceOrder(db, order.id, e.code, e.message);
        return res.redirect(303, failed(e.code === 'auth_failed' ? 'canceled' : e.code, order.id));
      }
      let out = null;
      try { out = await applyServiceEvent(db, provider.name, ev); } catch (e) { console.error('[service-pay] apply failed', order.id, e.message); }
      const after = await getServiceOrder(db, order.id);   // a webhook for the same payment may have applied it first (duplicate event)
      if (!(after?.status === 'PAID' && after.provider_tid === ev.payment?.provider_tid)) {
        // Approved but not recorded as paid: refund so nobody is charged for nothing.
        await provider.refund({ order: { ...order, provider_tid: ev.payment?.provider_tid }, reason: '결제 반영 오류로 자동 취소' })
          .catch((err) => console.error('[service-pay] AUTO-REFUND FAILED — refund by hand in the NicePay console', order.id, err.message));
        await failServiceOrder(db, order.id, 'apply_failed', out?.reason || 'apply failed');
        return res.redirect(303, failed('apply_failed', order.id));
      }
      res.redirect(303, done(order.id));
    } catch (e) { next(e); }
  });
}

/** 관리자 › 결제 › 서비스 결제 (read-only). Mounted before admin-routes.js, whose /api/admin/* catch-all answers 404. */
export function mountServicePayAdmin({ app, db, wrap, fail, requireAuth }) {
  app.get('/api/admin/service-orders', requireAuth, wrap(async (req, res) => {
    if (req.user.system_role !== 'SYSTEM_ADMIN') return fail(res, 403, 'forbidden', '운영자 권한이 필요합니다.');
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const size = Math.min(200, Math.max(1, Number.parseInt(req.query.size, 10) || 50));
    res.json(await listServiceOrders(db, { q: String(req.query.q || '').trim(), status: String(req.query.status || ''), page, size }));
  }));
}

export function mountServicePay({ app, db, wrap, fail, provider }) {
  const orderLimit = rateLimiter(db, { name: 'service-pay-order', max: 20, windowMs: 60 * 60 * 1000 });
  const fieldsFail = (res, e) => fail(res, e.status, e.code, e.message, e.fields ? { fields: e.fields } : {});

  app.get('/pricing', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sel = productFor(String(req.query.plan || 'once'), String(req.query.product || 'agent')) || SERVICE_PRODUCTS['agent-once'];
    res.type('html').send(pricingPage({ selected: sel, recurring: Boolean(provider?.recurringEnabled), meta: shareMeta(req, { title: '서비스 결제 — RELAI', description: 'RELAI AI Agent 개발 및 운영 서비스 결제', path: '/pricing' }) }));
  });
  app.get('/pricing/done', wrap(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const o = await getServiceOrder(db, req.query.order);
    if (!o) return res.redirect(failed('unknown_order'));
    if (o.status === 'FAILED') return res.redirect(failed(o.failure_code, o.id));
    res.type('html').send(resultPage({ ok: true, order: o }));
  }));
  app.get('/pricing/failed', wrap(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const o = req.query.order ? await getServiceOrder(db, req.query.order) : null;
    if (o?.status === 'PAID') return res.redirect(done(o.id));
    res.type('html').send(resultPage({ ok: false, order: o, reason: String(req.query.reason || '') }));
  }));

  app.post('/api/service-pay/orders', wrap(async (req, res) => {
    const product = SERVICE_PRODUCTS[String(req.body?.product || '')];
    if (!product) return fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { product: '상품을 선택해 주세요.' } });
    if (product.kind !== 'ONE_TIME') return fail(res, 409, 'recurring_unavailable', RECURRING_SOON);
    let buyer; try { buyer = parseBuyer(req.body); } catch (e) { if (e instanceof ServiceOrderError) return fieldsFail(res, e); throw e; }
    if (!checkoutReady(provider)) return fail(res, 503, 'service_pay_unavailable', `지금은 온라인 결제를 받을 수 없습니다. ${LEGAL.contactEmail}로 문의해 주세요.`);
    if (await orderLimit.blocked(req.ip)) return fail(res, 429, 'rate_limited', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    await orderLimit.hit(req.ip);
    const order = await createServiceOrder(db, { product, buyer, provider: provider.name });
    const pay = provider.payWindowParams(order, { returnUrl: `${serviceBaseUrl(req)}/api/service-pay/${provider.name}/return`, customer: { name: buyer.name, email: buyer.email } });
    res.status(201).json({ order: { id: order.id, goods_name: order.goods_name, amount: order.amount }, pay, sdk_url: provider.sdkUrl });
  }));

  /** 월 구독: the card form posts here only once NicePay approves recurring billing. Until then nothing is called. */
  app.post('/api/service-pay/subscriptions', wrap(async (req, res) => {
    if (!provider?.recurringEnabled) return fail(res, 409, 'recurring_unavailable', RECURRING_SOON);
    // Registration + monthly charging for buyers without an account is a follow-up (needs a billing-key column + renewal job).
    return fail(res, 409, 'recurring_unavailable', RECURRING_SOON);
  }));

}

/* ---------- pages ---------- */
const head = (title, meta = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${meta}<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="/service/pricing.css"></head>`;
const topbar = () => `<header class="sp-top"><div class="sp-wrap sp-top__in"><a class="sp-brand" href="/"><b>relai</b><span class="sp-brand__sep">/</span><span>서비스 결제</span></a>
<a class="sp-top__link" href="mailto:${esc(LEGAL.contactEmail)}">문의하기</a></div></header>`;

const CARDS = {
  'agent-once': { unit: '1회', badge: '1회 결제', bullets: ['AI Agent 개발 및 운영 지원 (협의한 범위)', '1개월 이용 · 자동 갱신 없음', '신용카드 결제 · 부가세 포함'], cta: '1회 결제 선택' },
  'agent-monthly': { unit: '월', badge: '준비 중', bullets: ['AI Agent 개발 및 운영 · 부가세 포함', '카드 등록 시 첫 결제 · 이후 월 1회', '다음 결제일 전에 해지 가능'], cta: '월 구독 선택' },
};
function card(p, selected) {
  const c = CARDS[p.key];
  return `<article class="sp-card${selected ? ' is-on' : ''}" data-product="${p.key}" data-plan="${p.plan}">
<div class="sp-card__top"><h3>${esc(p.title)}</h3><span class="sp-badge${p.kind === 'RECURRING' ? ' sp-badge--soon' : ''}">${c.badge}</span></div>
<p class="sp-price"><b>${won(p.amount)}</b><span> / ${c.unit}</span></p><p class="sp-vat">부가세 포함</p>
<ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
<a class="sp-btn sp-btn--line" href="/pricing?plan=${p.plan}&amp;product=${p.product}" data-pick="${p.key}" aria-pressed="${selected}">${selected ? '선택됨' : c.cta}</a></article>`;
}
const field = (id, label, attrs, hint = '') => `<label class="sp-f" for="${id}"><span class="sp-f__l">${label}</span><input class="sp-in" id="${id}" name="${id}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}<em class="sp-err" data-err="${id}"></em></label>`;
const check = (id, label, link = '') => `<label class="sp-chk"><input type="checkbox" id="${id}" name="${id}" data-consent><span>${label}${link}</span></label><em class="sp-err" data-err="${id}"></em>`;

export function pricingPage({ selected, recurring, meta = '' }) {
  const prods = Object.values(SERVICE_PRODUCTS);
  return `${head('서비스 결제 — RELAI', meta)}<body class="sp">${topbar()}
<main class="sp-wrap">
<section class="sp-hero"><p class="sp-eyebrow">RELAI · SERVICE PLANS</p><h1>AI Agent 개발과 운영,<br>맞는 방식으로 시작하세요.</h1>
<p class="sp-sub">업무에 맞는 AI Agent를 만들고, 안정적으로 운영합니다. 1개월 단위로 결제하거나 월 구독으로 이용할 수 있습니다.</p></section>
<section class="sp-cards" aria-label="상품">${prods.map((p) => card(p, p.key === selected.key)).join('')}</section>
<section class="sp-pay" id="pay" data-recurring="${recurring ? '1' : '0'}" data-selected="${selected.key}">
<div class="sp-pay__sum"><h2>주문 정보</h2>
${prods.map((p) => `<div class="sp-sum" data-sum="${p.key}"${p.key === selected.key ? '' : ' hidden'}><p class="sp-sum__t">${esc(p.title)}</p>
<dl><dt>이용 기간</dt><dd>${p.kind === 'RECURRING' ? '매월 자동 결제' : '1개월 · 자동 갱신 없음'}</dd><dt>공급가액</dt><dd>${won(p.supply_amount)}</dd><dt>부가세</dt><dd>${won(p.vat_amount)}</dd>
<dt class="sp-sum__tot">결제 금액</dt><dd class="sp-sum__tot">${won(p.amount)}${p.kind === 'RECURRING' ? ' / 월' : ''}</dd></dl>
${p.kind === 'RECURRING' ? `<p class="sp-soon" role="note">${RECURRING_SOON} 정기결제 심사가 끝나면 열립니다.</p>` : ''}</div>`).join('')}</div>
<form class="sp-form" id="sp-form" novalidate>
<h2>구매자 정보</h2>
<div class="sp-grid">${field('name', '이름', 'autocomplete="name" maxlength="40" required')}${field('company', '회사명 <i>(선택)</i>', 'autocomplete="organization" maxlength="80"')}
${field('email', '이메일', 'type="email" autocomplete="email" maxlength="120" required', '결제 확인 메일을 이 주소로 보냅니다.')}${field('phone', '연락처', 'type="tel" autocomplete="tel" inputmode="tel" maxlength="20" placeholder="010-0000-0000" required')}</div>
<fieldset class="sp-cardf" id="sp-cardf"${selected.kind === 'RECURRING' ? '' : ' hidden'}><legend>정기결제 카드 등록</legend>
<div class="sp-grid">${field('card_number', '카드번호', 'inputmode="numeric" autocomplete="cc-number" maxlength="19" placeholder="0000 0000 0000 0000"')}${field('card_expiry', '유효기간', 'inputmode="numeric" autocomplete="cc-exp" maxlength="5" placeholder="MM/YY"')}
${field('card_id_no', '생년월일 6자리 또는 사업자번호 10자리', 'inputmode="numeric" maxlength="10" placeholder="YYMMDD"')}${field('card_pw', '카드 비밀번호 앞 2자리', 'type="password" inputmode="numeric" maxlength="2" autocomplete="off" placeholder="••"')}</div>
${check('agree_recurring', '[필수] 정기결제에 동의합니다. 등록한 카드로 매월 400,000원(부가세 포함)이 자동 결제되며, 다음 결제일 전에 해지할 수 있습니다.')}
<p class="sp-note">카드 정보는 결제사(NICEPAY)로 암호화해 전달하며 RELAI에 저장하지 않습니다.</p></fieldset>
<h2>약관 동의</h2>
<label class="sp-chk sp-chk--all"><input type="checkbox" id="agree_all"><span><b>전체 동의</b></span></label>
${check('agree_terms', '[필수] 이용약관에 동의합니다.', ' <a href="/terms" target="_blank" rel="noopener">보기</a>')}
${check('agree_privacy', '[필수] 개인정보 수집·이용에 동의합니다.', ' <button type="button" class="sp-link" data-toggle="privacy-box">내용 보기</button>')}
<div class="sp-box" id="privacy-box" hidden><table><tr><th>수집 항목</th><td>이름, 회사명(선택), 이메일, 연락처, 결제 기록(카드사·승인번호, 카드번호는 저장하지 않음)</td></tr>
<tr><th>목적</th><td>서비스 결제와 계약 이행, 결제 확인 메일, 고객 문의 응대</td></tr><tr><th>보유 기간</th><td>전자상거래법에 따라 대금 결제·재화 공급 기록 5년, 소비자 불만·분쟁 처리 기록 3년</td></tr>
<tr><th>동의 거부</th><td>동의를 거부할 수 있으나, 거부하면 결제를 진행할 수 없습니다.</td></tr></table> <a href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a></div>
${check('agree_payment', '[필수] 주문 내용과 결제 금액을 확인했으며 결제 진행에 동의합니다.')}
<p class="sp-msg" id="sp-msg" role="alert"></p>
<button class="sp-btn sp-btn--pri" id="sp-submit" type="submit" data-label-once="${won(SERVICE_PRODUCTS['agent-once'].amount)} 결제하기" data-label-monthly="카드 등록하고 구독하기">${selected.kind === 'RECURRING' ? '카드 등록하고 구독하기' : `${won(selected.amount)} 결제하기`}</button>
<p class="sp-note">결제는 NICEPAY 결제창에서 신용카드로 진행됩니다.</p>
</form></section>
<section class="sp-notes"><h2>결제 전 확인해주세요</h2><ul>
<li>결제 전에 서비스 범위와 시작일을 담당자와 협의해 주세요. 협의 없이 결제한 경우에도 담당자가 연락드려 확정합니다.</li>
<li>1회 결제는 1개월 이용이며 자동으로 갱신되지 않습니다.</li>
<li>월 구독은 카드 등록 시 첫 결제가 이루어지고 이후 매월 같은 날 결제됩니다. 다음 결제일 전에 해지할 수 있습니다.</li>
<li>이미 결제한 이용료의 취소·환불은 서비스 제공 여부와 계약 내용, 관련 법령에 따라 처리합니다.</li>
<li>결제 금액은 모두 부가세 포함 금액입니다.</li></ul></section>
<section class="sp-contact"><h2>문의</h2><p>서비스 범위, 견적, 세금계산서 발행은 <a href="mailto:${esc(LEGAL.contactEmail)}">${esc(LEGAL.contactEmail)}</a>로 문의해 주세요.</p></section>
</main>
${legalFooterHtml(LEGAL).replace('class="legal-foot"', 'class="legal-foot sp-wrap"')}
<script type="module" src="/service/pricing.js"></script></body></html>`;
}

const REASON = { canceled: '결제가 취소되었습니다.', expired: '결제 시간이 초과되었습니다. 다시 시도해 주세요.', amount_mismatch: '결제 금액이 주문 금액과 달라 결제하지 않았습니다.',
  payment_failed: '카드사에서 결제를 승인하지 않았습니다.', apply_failed: '결제를 반영하지 못해 자동으로 취소했습니다.', unknown_order: '주문 정보를 찾을 수 없습니다.' };
export function resultPage({ ok, order, reason = '' }) {
  const rows = order ? `<dl class="sp-dl"><dt>주문번호</dt><dd class="sp-mono" id="order-id">${esc(order.id)}</dd><dt>상품</dt><dd>${esc(order.goods_name)}</dd>
<dt>결제 금액</dt><dd id="order-amount"><b>${won(order.amount)}</b> (부가세 포함)</dd>${ok && order.paid_at ? `<dt>결제 일시</dt><dd>${esc(new Date(order.paid_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</dd>` : ''}</dl>` : '';
  const pending = ok && order.status === 'PENDING';
  const title = ok ? (pending ? '결제를 확인하고 있습니다' : order.status === 'REFUNDED' ? '환불된 주문입니다' : '결제가 완료되었습니다') : '결제가 완료되지 않았습니다';
  const body = ok ? (pending ? '<p>결제 확인까지 잠시 걸릴 수 있습니다. 잠시 후 이 페이지를 새로고침해 주세요.</p>'
    : `<p>결제 확인 메일을 보냈습니다. 서비스 범위와 시작일은 담당자가 연락드려 확정합니다.</p>`)
    : `<p>${esc(REASON[reason] || '결제 중 문제가 발생했습니다. 다시 시도해 주세요.')}</p><p class="sp-note">결제가 완료되지 않았으므로 청구되지 않습니다.</p>`;
  return `${head(`${title} — RELAI`)}<body class="sp">${topbar()}<main class="sp-wrap"><section class="sp-result ${ok ? 'is-ok' : 'is-bad'}" id="sp-result" data-status="${esc(order?.status || 'NONE')}">
<div class="sp-result__icon" aria-hidden="true">${ok ? '✓' : '!'}</div><h1>${title}</h1>${body}${rows}
<div class="sp-result__a">${ok ? '<a class="sp-btn sp-btn--line" href="/pricing">서비스 결제로 돌아가기</a>' : '<a class="sp-btn sp-btn--pri" href="/pricing">다시 결제하기</a>'}
<a class="sp-btn sp-btn--line" href="mailto:${esc(LEGAL.contactEmail)}">문의하기</a></div></section></main>${legalFooterHtml(LEGAL).replace('class="legal-foot"', 'class="legal-foot sp-wrap"')}</body></html>`;
}
