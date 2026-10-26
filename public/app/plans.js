/* 플랜 (/app/billing/plans, pricing v3 T4): where every plan-limit / AI-credit upsell lands.
 * The same plan cards as the landing #pricing (shared/pricing.js) built from the server catalogue (GET …/billing → catalogue),
 * so no number is typed here; 월간/연간 switch (default 월간), the current plan badge, and per card 선택 → the checkout screen
 * (/app/billing/subscribe?plan=&cycle=, T3) which shows the server quote and the 정기결제 고지 before any payment.
 * Checkout closed (PAYMENTS_ENABLED unset, or NicePay recurring not approved — founder 2026-10-20, no one-time passes) → the
 * button reads 정기결제 준비 중 and calls nothing; a stale 선택 link still only answers SUBSCRIBE_SOON. Plan prices are shown in won, VAT
 * included (a priced product list; spec §4.1); AI feature costs stay in credits (batch7 #7). */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { navigate } from './core/router.js';
import { toast, confirmDialog } from './shared/dialogs.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';
import { pricingHtml, bindCycleToggle, soonCta, FAQ, FAQ_ONE_TIME } from './shared/pricing.js';

export const SUBSCRIBE_SOON = '결제 준비 중입니다. 곧 오픈 예정이에요.';


export async function plansPage(main = $('#main')) {
  document.title = '플랜 — RELAI';
  let b = null;
  try { b = (await api('GET', `/api/workspaces/${state.workspace.id}/billing`)).billing; } catch { b = null; }
  const cur = b?.plan || 'FREE';
  const owner = Boolean(b?.can_manage);
  // 단건결제 모드 (ONE_TIME_PAYMENT_MODE): Pro / Team are sold as 1개월 이용권 — one card payment through the NicePay window, no auto renewal.
  const oneTime = Boolean(b?.flags?.one_time);
  const buyable = oneTime && Boolean(b?.payments_enabled && b?.checkout?.can_purchase);
  const open = Boolean(b?.payments_enabled && b?.flags?.recurring);
  const cta = (p) => {
    if (p.contact_sales) return '<a class="btn btn--secondary btn--sm btn--block" href="mailto:' + LEGAL.contactEmail + '?subject=RELAI%20Enterprise%20%EB%AC%B8%EC%9D%98" data-plan-cta="ENTERPRISE">도입 문의</a>';
    if (oneTime && (p.key === 'PRO' || p.key === 'TEAM')) {
      if (!owner) return '<p class="hint" style="margin:0">이용권 구매는 소유자만 할 수 있어요</p>';
      if (!buyable) return soonCta(p);
      return html`<button type="button" class="btn ${p.key === 'PRO' ? 'btn--primary' : 'btn--secondary'} btn--sm btn--block" data-plan-buy="${p.key}">${p.key === cur ? '1개월 연장' : `${p.label} 1개월 이용권 구매`}</button>`;
    }
    if (p.key === cur) return '<button class="btn btn--secondary btn--sm btn--block" disabled>사용 중</button>';
    if (p.key === 'FREE') return '';
    if (!open) return soonCta(p);
    if (!owner) return '<p class="hint" style="margin:0">요금제 변경은 소유자만 할 수 있어요</p>';
    return html`<a class="btn ${p.key === 'PRO' ? 'btn--primary' : 'btn--secondary'} btn--sm btn--block" href="/app/billing/subscribe?plan=${p.key}" data-plan-cta="${p.key}">${p.label} 선택</a>`;
  };
  main.innerHTML = html`<div class="page page--plans" id="plans-page">
    <div class="page__head"><div><a class="link" href="/app/settings?tab=plan" data-link>← 플랜 · 결제</a><h1 style="margin-top:4px">요금제</h1>
      <p class="dim" style="margin-top:4px">${oneTime ? '워크스페이스 단위 요금제예요. Pro·Team은 1개월 이용권으로 신용카드 1회 결제하며 자동으로 다시 결제되지 않아요.' : '워크스페이스 단위 요금제예요. 활성 프로젝트와 사용자 수, AI 크레딧으로 고르세요.'}</p></div></div>
    <div id="pl-cards">${raw(b?.catalogue ? pricingHtml(b.catalogue, { current: cur, cta, oneTime }) : '<p class="hint">요금 정보를 불러오지 못했어요. 잠시 후 다시 열어 주세요.</p>')}</div>
    <div class="panel" style="margin-top:20px" id="pl-faq"><div class="panel__h">자주 묻는 질문</div><div class="panel__b">
      ${raw((oneTime ? FAQ_ONE_TIME : FAQ).map(([q, a]) => html`<details class="pl-faq"><summary>${q}</summary><p class="dim">${a}</p></details>`).join(''))}</div></div>
    ${raw(legalFooterHtml(LEGAL))}
  </div>`;
  bindCycleToggle(main);
  main.querySelectorAll('[data-plan-buy]').forEach((btn) => { btn.onclick = () => buyPass(btn.dataset.planBuy, btn); });
  // ?buy=PRO|TEAM (landing 'Pro 1개월 이용권 구매' after sign-in): open the purchase dialog once; the URL loses the param.
  const want = new URLSearchParams(location.search).get('buy');
  if (want) {
    history.replaceState(null, '', '/app/billing/plans');
    const btn = main.querySelector(`[data-plan-buy="${want === 'TEAM' ? 'TEAM' : 'PRO'}"]`);
    if (btn) buyPass(btn.dataset.planBuy, btn);
    else if (oneTime && !owner) toast('이용권 구매는 워크스페이스 소유자만 할 수 있어요.');
  }
  main.querySelectorAll('a[data-plan-cta]').forEach((a) => { if (a.dataset.planCta === 'ENTERPRISE') return; a.onclick = (e) => {
    e.preventDefault();
    if (!open) return toast(SUBSCRIBE_SOON);
    const cycle = main.querySelector('.pcw')?.dataset.cycle || 'MONTHLY';
    navigate(`/app/billing/subscribe?plan=${a.dataset.planCta}&cycle=${cycle}`);
  }; });
}

/**
 * 단건결제 모드: Pro / Team 1개월 이용권. The amount comes from the server quote (GET …/billing/quote, MONTHLY, no add-ons); the dialog
 * shows 상품 · 이용 기간 · 결제 금액 · 결제 수단 신용카드 · 자동 갱신 없음 before anything is charged; 결제하기 → POST …/billing/checkout
 * → the NicePay card window (/api/billing/nicepay/pay/:orderId). Payment happens only on the server approval after the window.
 */
async function buyPass(plan, btn) {
  const wid = state.workspace.id;
  const n = (v) => Number(v || 0).toLocaleString('ko-KR');
  let q;
  try { q = (await api('GET', `/api/workspaces/${wid}/billing/quote?plan=${encodeURIComponent(plan)}&cycle=MONTHLY`)).quote; } catch (e) { toast(e.message); return; }
  const label = plan === 'TEAM' ? 'Team' : 'Pro';
  const bodyHtml = html`<dl class="info" id="pl-buy-sum"><dt>상품</dt><dd><b>RELAI ${label} 1개월 이용권</b></dd>
    <dt>이용 기간</dt><dd>결제일부터 1개월</dd>
    <dt>결제 금액</dt><dd><b>${n(q.total)}원</b> <small class="dim">(공급가액 ${n(q.supply)}원 + 부가세 ${n(q.vat)}원)</small></dd>
    <dt>결제 수단</dt><dd>신용카드 <small class="dim">· 나이스페이먼츠 결제창</small></dd>
    <dt>자동 갱신</dt><dd>없음 <small class="dim">· 기간이 끝나면 Free로 바뀌고 데이터는 삭제되지 않아요</small></dd></dl>
    <p class="hint" style="margin-top:10px">결제하기를 누르면 카드 결제창이 열려요. 환불 기준은 <a class="link" href="/terms#refund" target="_blank" rel="noopener">이용약관</a>을 확인해 주세요.</p>`;
  if (!(await confirmDialog({ title: `${label} 1개월 이용권 구매`, bodyHtml, confirm: `${n(q.total)}원 결제하기` }))) return;
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/workspaces/${wid}/billing/checkout`, { plan, cycle: 'MONTHLY' });
    location.href = r.checkout_url;
  } catch (e) { btn.disabled = false; toast(e.message); }
}
