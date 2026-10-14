/* Upgrade prompt (Phase 10 Billing). core/api.js fires `relai:plan-limit` on every 402 plan_limit_reached; this module shows one
 * dialog per burst (an import or a bulk action can hit the limit on several calls at once). The calling screen still gets the error. */
import { html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { confirmDialog } from './dialogs.js';

let open = false;
export async function showUpgradePrompt(err) {
  if (open) return; open = true;
  try {
    const l = err?.limit || {};
    const isOwner = state.workspace?.role === 'OWNER';
    const body = html`<p>${err?.message || '현재 플랜의 한도에 도달했습니다.'}</p>
      ${raw(l.dimension ? html`<p class="dim" style="margin-top:8px">${l.label}: <b>${l.used}</b> / ${l.limit} 사용 중 (${l.plan} 플랜)</p>` : '')}
      <p class="dim" style="margin-top:8px">${isOwner ? 'Team 플랜은 프로젝트·멤버·요구사항·WBS·주간보고 한도가 없습니다. 기존 데이터는 그대로 유지됩니다.' : '업그레이드는 Workspace OWNER가 할 수 있습니다. OWNER에게 Team 플랜 전환을 요청하세요.'}</p>`;
    const go = await confirmDialog({ title: 'Free 플랜 한도에 도달했습니다', body: raw(body), confirm: isOwner ? 'Team 플랜 보기' : '플랜 확인하기' });
    if (go) navigate(err?.upgrade?.url || '/app/settings#billing');
  } finally { open = false; }
}
window.addEventListener('relai:plan-limit', (e) => { showUpgradePrompt(e.detail); });
