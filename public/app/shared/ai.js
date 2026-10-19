/* AI layer helpers shared by the four feature dialogs: status cache (flag + credits), large dialog shell, error copy.
 * Design rule: AI results are always labelled 초안/후보, stay inside the existing blue B2B look, and are never auto-saved. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from './dialogs.js';

const cache = new Map();   // pid → promise of /ai/status
export const aiStatus = (pid, { fresh = false } = {}) => {
  if (fresh || !cache.has(pid)) { const p = api('GET', wsApi(`/${pid}/ai/status`)).catch(() => ({ enabled: false, credits: null, costs: {} })); cache.set(pid, p); }
  return cache.get(pid);
};
export const aiStatusReset = (pid) => cache.delete(pid);
export const FEATURE_LABEL = { REQUIREMENT_EXTRACTION: 'AI로 요구사항 추출', WBS_GENERATION: 'AI로 WBS 만들기', CHANGE_IMPACT: 'AI 영향 분석', PROJECT_QA: 'RELAI에게 물어보기' };
export const CONF = { HIGH: ['높음', 'is-good'], MEDIUM: ['보통', 'is-warn'], LOW: ['낮음', 'is-crit'] };
export const confChip = (c) => html`<span class="hchip hchip--sm ${(CONF[c] || CONF.LOW)[1]}" title="AI 확신도">${(CONF[c] || CONF.LOW)[0]}</span>`;

/** "예상 30 크레딧 (₩300) · 잔액 4,230 크레딧" — price, ₩ rate and balance come from the server (feature config + account), never hard-coded here.
 * The click is the consent (AI-credits-only billing §5). Amber below the low-balance threshold; at 0 / below the price the button is disabled with [크레딧 충전]. */
export const CREDITS_URL = '/app/settings/credits';
const fmt = (v) => Number(v).toLocaleString('ko-KR');
export const creditLine = (st, feature) => {
  if (!st?.enabled) return '';
  const cost = st.costs?.[feature]; const bal = st.credits?.available; const rate = st.credit_price_krw || 10;
  const short = typeof cost === 'number' && typeof bal === 'number' && bal < cost;
  const low = !short && typeof bal === 'number' && typeof st.low_balance_threshold === 'number' && bal < st.low_balance_threshold;
  const pay = st.payments_enabled !== false;   // v1: payments off → no 충전 link
  if (short) return html`<span class="ai-credit is-short" title="AI 사용량은 워크스페이스 크레딧으로 집계됩니다">크레딧이 부족합니다 (필요 <b>${fmt(cost)}</b> · 잔액 <b>${fmt(bal)}</b>)${raw(pay ? html` · <a href="${CREDITS_URL}" data-link>크레딧 충전</a>` : '')}</span>`;
  return html`<span class="ai-credit ${low ? 'is-low' : ''}" title="실행하면 이 크레딧만 차감됩니다. 실패하면 차감하지 않습니다.">예상 <b>${typeof cost === 'number' ? fmt(cost) : '-'}</b> 크레딧 (₩${typeof cost === 'number' ? fmt(cost * rate) : '-'}) · 잔액 <b>${typeof bal === 'number' ? fmt(bal) : '-'}</b> 크레딧${raw(low && pay ? ` · <a href="${CREDITS_URL}" data-link>충전</a>` : '')}</span>`;
};
/** Kept for older imports: credits are bought on the AI 크레딧 page. */
export const UPGRADE_URL = CREDITS_URL;
export const canRun = (st, feature) => Boolean(st?.enabled) && !(typeof st.costs?.[feature] === 'number' && typeof st.credits?.available === 'number' && st.credits.available < st.costs[feature]);

/** Human copy for AI error codes (the API message is kept as detail). */
export function aiErrorMessage(e) {
  const code = e?.code;
  if (code === 'AI_CREDIT_INSUFFICIENT') return `크레딧이 부족합니다 (필요 ${e.error?.required ?? '?'} · 잔액 ${e.error?.balance ?? '?'}). 설정 › AI 크레딧에서 충전하세요.`;
  if (code === 'AI_DISABLED') return 'AI 기능을 사용할 수 없습니다. 관리자에게 문의하세요.';
  if (code === 'AI_RATE_LIMITED') return e.message || 'AI 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'AI_INPUT_TOO_LARGE') return e.message;
  // failed runs are never charged (the reservation is released server-side); the server message is already plain Korean
  if (['AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_INVALID_OUTPUT', 'AI_INTERNAL_ERROR'].includes(code)) return `${e.message || 'AI 응답을 생성하지 못했습니다. 다시 시도해 주세요.'} 크레딧은 차감되지 않았습니다.`;
  return e?.message || '요청을 처리하지 못했습니다.';
}
/**
 * Large AI dialog shell: title row (with the 초안/후보 badge + credit line), scrollable body, sticky footer.
 * Returns { el, body, foot, close, busy(on, label) }. Esc / scrim click close unless `busy`.
 */
export function aiDialog({ title, subtitle = '', feature, status, size = 'lg' }) {
  const el = document.createElement('div'); el.className = 'scrim scrim--ai';
  el.innerHTML = html`<div class="dialog dialog--ai dialog--ai-${size}" role="dialog" aria-modal="true" aria-labelledby="aiT">
    <div class="aid__h"><div><h3 id="aiT">${title} <span class="aid__tag">AI 초안·후보</span></h3>${raw(subtitle ? html`<p class="aid__sub">${subtitle}</p>` : '')}</div>
      <div class="aid__hr">${raw(creditLine(status, feature))}<button type="button" class="drawer__x" data-close aria-label="닫기">×</button></div></div>
    <div class="aid__b"></div>
    <div class="aid__f"></div></div>`;
  let busy = false;
  const close = () => { if (busy) return; el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  document.body.append(el);
  return {
    el, body: $('.aid__b', el), foot: $('.aid__f', el), close,
    /** After a charged run: the header credit line shows the new balance (it was the balance when the dialog opened). */
    setBalance(bal) { if (typeof bal !== 'number' || !status?.credits) return; const hr = $('.aid__hr', el); const old = $('.ai-credit', hr); if (!old) return; old.outerHTML = creditLine({ ...status, credits: { ...status.credits, available: bal } }, feature); },
    busy(on, label = 'AI가 분석하는 중입니다…') { busy = on; el.classList.toggle('is-busy', on); let o = $('.aid__busy', el); if (on) { if (!o) { o = document.createElement('div'); o.className = 'aid__busy'; $('.dialog', el).append(o); } o.innerHTML = html`<span class="spin"></span><span>${label}</span>`; } else if (o) o.remove(); },
  };
}

/** " · 30 크레딧 (₩300) 사용 · 잔액 4,230" after a run; also refreshes the dialog's header balance. */
export const runLine = (run, d) => {
  if (!run) return '';
  d?.setBalance?.(run.balance);
  return html`<small class="dim"> · ${fmt(run.credit_cost)} 크레딧 (₩${fmt(run.credit_cost * 10)}) 사용 · 잔액 ${fmt(run.balance)}</small>`;
};
/** Standard "no result" / warnings blocks. */
export const warningsHtml = (w) => (w && w.length ? html`<ul class="aid__warn">${raw(w.map((x) => html`<li>${x}</li>`).join(''))}</ul>` : '');
export const aiNotice = (st) => html`<p class="aid__notice">${st?.notice || '현재 프로젝트의 요구사항, WBS, 이슈 데이터를 참고합니다.'}</p>`;
export const reportError = (e) => toast(aiErrorMessage(e));
