/* Upsell prompt (Phase 10 Billing → batch7 T5 paywall). core/api.js fires `relai:plan-limit` on every 402 plan_limit_reached and on
 * 402 AI_CREDIT_INSUFFICIENT; this module shows one dialog per burst (an import or a bulk action can hit the limit on several calls at
 * once). The calling screen still gets the error. Every upsell points at the plans page (/app/billing/plans). Calm copy: what happened,
 * that nothing was lost, and where to look — no fear words, no prices (payments are off; the plans page says '가격 안내 예정'). */
import { html, raw } from '../core/dom.js';
import { state, oneTimeMode } from '../core/state.js';
import { navigate } from '../core/router.js';
import { confirmDialog, noticeDialog } from './dialogs.js';
import { isPhone } from '../core/device.js';

export const PLANS_URL = '/app/billing/plans';
let open = false;
const fmt = (n) => Number(n).toLocaleString('ko-KR');

/** { title, body } for a plan-limit or credit error payload (data.error from the API). */
export function upsellCopy(err) {
  const l = err?.limit || {};
  if (err?.code === 'AI_CREDIT_INSUFFICIENT' && oneTimeMode()) {   // 단건결제 모드: every plan can top up, so the way out is 충전
    return { title: 'AI 크레딧이 조금 모자라요', body: html`<p>이 AI 기능에는 <b>${fmt(err.required ?? 0)}</b> 크레딧이 필요하고, 지금 잔액은 <b>${fmt(err.balance ?? 0)}</b> 크레딧이에요.</p>
      <p class="dim" style="margin-top:8px">설정 › AI 크레딧에서 필요한 만큼 충전할 수 있어요. 직접 입력하는 기능은 그대로 쓸 수 있어요.</p>`, cta: 'AI 크레딧 충전', url: '/app/settings/credits' };
  }
  if (err?.code === 'AI_CREDIT_INSUFFICIENT') {
    return { title: 'AI 크레딧이 조금 모자라요', body: html`<p>이 AI 기능에는 <b>${fmt(err.required ?? 0)}</b> 크레딧이 필요하고, 지금 잔액은 <b>${fmt(err.balance ?? 0)}</b> 크레딧이에요.</p>
      <p class="dim" style="margin-top:8px">Free는 처음 한 번 200 크레딧을 받아요. Pro는 매월 1,000, Team은 매월 3,000 크레딧을 받고 충전도 할 수 있어요. 직접 입력하는 기능은 그대로 쓸 수 있어요.</p>` };
  }
  if (l.seats) return { title: '구매한 사용자 수를 모두 쓰고 있어요', body: html`<p>${err?.message || ''}</p>` };
  return { title: '무료 플랜 한도에 도달했어요', body: html`<p>${err?.message || '현재 플랜의 한도에 도달했어요.'}</p>
    ${raw(l.dimension ? html`<p class="dim" style="margin-top:8px" data-upsell-usage>${l.label}: <b>${l.used}</b> / ${l.limit} 사용 중</p>` : '')}
    <p class="dim" style="margin-top:8px">지금까지 만든 내용은 모두 그대로 있어요. 플랜을 살펴보고 필요할 때 바꿔 보세요.</p>` };
}

export async function showUpgradePrompt(err) {
  if (open) return; open = true;
  try {
    const { title, body, cta = '플랜 살펴보기', url: ctaUrl } = upsellCopy(err);
    const url = ctaUrl || err?.upgrade?.url || PLANS_URL;
    if (isPhone()) {   // phone = view mode: the reason + a link, 닫기 only
      await noticeDialog({ title, bodyHtml: html`${raw(body)}<p style="margin-top:8px"><a href="${url}" data-link data-upsell-cta>${cta}</a></p>` });
      return;
    }
    const isOwner = state.workspace?.role === 'OWNER';
    const who = isOwner ? '' : html`<p class="dim" style="margin-top:8px">플랜은 워크스페이스 소유자가 바꿀 수 있어요.</p>`;
    const go = await confirmDialog({ title, bodyHtml: html`<div data-upsell>${raw(body)}${raw(who)}</div>`, confirm: cta, cancel: '닫기' });
    if (go) navigate(url);
  } finally { open = false; }
}
window.addEventListener('relai:plan-limit', (e) => { showUpgradePrompt(e.detail); });
