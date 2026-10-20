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
import { toast } from './shared/dialogs.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';
import { pricingHtml, bindCycleToggle, soonCta, FAQ } from './shared/pricing.js';

export const SUBSCRIBE_SOON = '결제 준비 중입니다. 곧 오픈 예정이에요.';


export async function plansPage(main = $('#main')) {
  document.title = '플랜 — RELAI';
  let b = null;
  try { b = (await api('GET', `/api/workspaces/${state.workspace.id}/billing`)).billing; } catch { b = null; }
  const cur = b?.plan || 'FREE';
  const owner = Boolean(b?.can_manage);
  const open = Boolean(b?.payments_enabled && b?.flags?.recurring);
  const cta = (p) => {
    if (p.contact_sales) return '<a class="btn btn--secondary btn--sm btn--block" href="mailto:' + LEGAL.contactEmail + '?subject=RELAI%20Enterprise%20%EB%AC%B8%EC%9D%98" data-plan-cta="ENTERPRISE">도입 문의</a>';
    if (p.key === cur) return '<button class="btn btn--secondary btn--sm btn--block" disabled>사용 중</button>';
    if (p.key === 'FREE') return '';
    if (!open) return soonCta(p);
    if (!owner) return '<p class="hint" style="margin:0">요금제 변경은 소유자만 할 수 있어요</p>';
    return html`<a class="btn ${p.key === 'PRO' ? 'btn--primary' : 'btn--secondary'} btn--sm btn--block" href="/app/billing/subscribe?plan=${p.key}" data-plan-cta="${p.key}">${p.label} 선택</a>`;
  };
  main.innerHTML = html`<div class="page page--plans" id="plans-page">
    <div class="page__head"><div><a class="link" href="/app/settings?tab=plan" data-link>← 플랜 · 결제</a><h1 style="margin-top:4px">요금제</h1>
      <p class="dim" style="margin-top:4px">워크스페이스 단위 요금제예요. 활성 프로젝트와 사용자 수, AI 크레딧으로 고르세요.</p></div></div>
    <div id="pl-cards">${raw(b?.catalogue ? pricingHtml(b.catalogue, { current: cur, cta }) : '<p class="hint">요금 정보를 불러오지 못했어요. 잠시 후 다시 열어 주세요.</p>')}</div>
    <div class="panel" style="margin-top:20px" id="pl-faq"><div class="panel__h">자주 묻는 질문</div><div class="panel__b">
      ${raw(FAQ.map(([q, a]) => html`<details class="pl-faq"><summary>${q}</summary><p class="dim">${a}</p></details>`).join(''))}</div></div>
    ${raw(legalFooterHtml(LEGAL))}
  </div>`;
  bindCycleToggle(main);
  main.querySelectorAll('a[data-plan-cta]').forEach((a) => { if (a.dataset.planCta === 'ENTERPRISE') return; a.onclick = (e) => {
    e.preventDefault();
    if (!open) return toast(SUBSCRIBE_SOON);
    const cycle = main.querySelector('.pcw')?.dataset.cycle || 'MONTHLY';
    navigate(`/app/billing/subscribe?plan=${a.dataset.planCta}&cycle=${cycle}`);
  }; });
}
