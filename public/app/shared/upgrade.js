/* Upgrade prompt (Phase 10 Billing). core/api.js fires `relai:plan-limit` on every 402 plan_limit_reached; this module shows one
 * dialog per burst (an import or a bulk action can hit the limit on several calls at once). The calling screen still gets the error.
 * The Team price shown comes from the server catalogue (server/plans.js) via GET …/billing, so it never drifts from checkout. */
import { html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { confirmDialog } from './dialogs.js';

let open = false;
const won = (n) => `₩${Number(n).toLocaleString('ko-KR')}`;
/** Team price line from the billing summary, or '' when it cannot be loaded. */
async function teamPrice() {
  try {
    const co = (await api('GET', `/api/workspaces/${state.workspace.id}/billing`)).billing?.checkout;
    return co?.base_monthly ? `Team: ${won(co.base_monthly)}/월 · Workspace 1개(소유자 포함) · 사용자 추가 1명당 ${won(co.extra_user_monthly)}/월 (부가세 별도)` : '';
  } catch { return ''; }
}
export async function showUpgradePrompt(err) {
  if (open) return; open = true;
  try {
    const l = err?.limit || {};
    const isOwner = state.workspace?.role === 'OWNER';
    const price = state.workspace?.id ? await teamPrice() : '';
    const body = html`<p>${err?.message || '현재 플랜의 한도에 도달했습니다.'}</p>
      ${raw(l.dimension ? html`<p class="dim" style="margin-top:8px">${l.label}: <b>${l.used}</b> / ${l.limit} 사용 중 (${l.plan} 플랜)</p>` : '')}
      <p class="dim" style="margin-top:8px">${isOwner ? 'Team 플랜은 프로젝트·요구사항·WBS·주간보고 한도가 없고, 멤버는 구매한 사용자 수만큼 초대할 수 있습니다. 기존 데이터는 그대로 유지됩니다.' : '업그레이드는 Workspace OWNER가 할 수 있습니다. OWNER에게 Team 플랜 전환을 요청하세요.'}</p>
      ${raw(price ? html`<p style="margin-top:8px"><b>${price}</b></p>` : '')}`;
    const go = await confirmDialog({ title: l.seats ? '구매한 사용자 수에 도달했습니다' : 'Free 플랜 한도에 도달했습니다', body: raw(body), confirm: isOwner ? 'Team 플랜 보기' : '플랜 확인하기' });
    if (go) navigate(err?.upgrade?.url || '/app/settings#billing');
  } finally { open = false; }
}
window.addEventListener('relai:plan-limit', (e) => { showUpgradePrompt(e.detail); });
