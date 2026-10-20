/* 플랜 (/app/billing/plans, pricing v3 T4): where every plan-limit / AI-credit upsell lands.
 * The same plan cards as the landing #pricing (shared/pricing.js) built from the server catalogue (GET …/billing → catalogue),
 * so no number is typed here; 월간/연간 switch (default 월간), the current plan badge, and per card 선택 → the checkout screen
 * (/app/billing/subscribe?plan=&cycle=, T3) which shows the server quote and the 정기결제 고지 before any payment.
 * Payments off (PAYMENTS_ENABLED unset) → 선택 only answers SUBSCRIBE_SOON and calls nothing. Plan prices are shown in won, VAT
 * included (a priced product list; spec §4.1); AI feature costs stay in credits (batch7 #7). */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { navigate } from './core/router.js';
import { toast } from './shared/dialogs.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';
import { pricingHtml, bindCycleToggle } from './shared/pricing.js';

export const SUBSCRIBE_SOON = '결제 준비 중입니다. 곧 오픈 예정이에요.';

const FAQ = [
  ['활성 프로젝트는 어떻게 세나요?', '준비·진행·보류 상태의 프로젝트만 한도에 들어가요. 완료하거나 보관한 프로젝트는 세지 않고, 계속 보고 내보낼 수 있어요. 보관을 풀거나 다시 진행할 때 한도를 확인해요.'],
  ['사용자는 어떻게 세나요?', '워크스페이스에 참여한 활성 사용자 기준이에요. 한 사람이 여러 프로젝트에 참여해도 1명이고, 초대를 보내면 수락 전까지 자리 하나를 잡아 둬요. 내보낸 사용자는 세지 않아요.'],
  ['한도를 넘으면 데이터는 어떻게 되나요?', '데이터는 삭제되지 않아요. 요금제를 낮추거나 이용 기간이 끝나 한도를 넘으면, 정리될 때까지 새 프로젝트·초대와 편집이 잠기고 조회·내보내기·완료·보관·구성원 정리는 언제든 할 수 있어요.'],
  ['AI 크레딧은 어떻게 받나요?', 'Free는 처음 한 번 100 크레딧, Pro는 매월 1,000, Team은 매월 3,000 크레딧을 받아요. 매월 받은 기본 크레딧은 그 달이 끝나면 소멸하고 이월되지 않아요. 크레딧은 워크스페이스 공용이고, 실패한 AI 요청은 차감하지 않아요.'],
  ['AI 크레딧은 어떻게 충전하나요?', 'Pro·Team에서 10,000원 단위로 충전해요(10,000원 = 1,000 크레딧). 충전한 크레딧은 5년간 쓸 수 있고, 7일 안에는 남은 크레딧을 전액 환불받을 수 있어요. Free에서는 충전할 수 없어요.'],
  ['연간 결제는 어떻게 다른가요?', '12개월분을 한 번에 결제하고 20% 할인돼요. AI 기본 크레딧은 연간 결제에도 매월 지급돼요. 중간에 해지하면 이용한 기간을 월간 정상가로 계산하고 나머지를 환불해요.'],
  ['추가 사용자·프로젝트는 얼마인가요?', '추가 사용자는 1명당 월 1,000원, 추가 프로젝트는 Pro 월 10,000원 · Team 월 8,000원이에요. 이용 기간 중간에 사면 남은 일수만큼만 결제하고, 결제 전에 금액과 다음 갱신 금액을 보여 드려요.'],
];

export async function plansPage(main = $('#main')) {
  document.title = '플랜 — RELAI';
  let b = null;
  try { b = (await api('GET', `/api/workspaces/${state.workspace.id}/billing`)).billing; } catch { b = null; }
  const cur = b?.plan || 'FREE';
  const owner = Boolean(b?.can_manage);
  const cta = (p) => {
    if (p.contact_sales) return '<a class="btn btn--secondary btn--sm btn--block" href="mailto:' + LEGAL.contactEmail + '?subject=RELAI%20Enterprise%20%EB%AC%B8%EC%9D%98" data-plan-cta="ENTERPRISE">도입 문의</a>';
    if (p.key === cur) return '<button class="btn btn--secondary btn--sm btn--block" disabled>사용 중</button>';
    if (p.key === 'FREE') return '';
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
    if (!b?.payments_enabled) return toast(SUBSCRIBE_SOON);
    const cycle = main.querySelector('.pcw')?.dataset.cycle || 'MONTHLY';
    navigate(`/app/billing/subscribe?plan=${a.dataset.planCta}&cycle=${cycle}`);
  }; });
}
