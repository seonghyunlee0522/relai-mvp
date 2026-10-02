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
export const FEATURE_LABEL = { REQUIREMENT_EXTRACTION: 'AI로 요구사항 추출', WBS_GENERATION: 'AI로 WBS 초안', CHANGE_IMPACT: 'AI 영향 분석', PROJECT_QA: 'RELAI에게 물어보기' };
export const CONF = { HIGH: ['높음', 'is-good'], MEDIUM: ['보통', 'is-warn'], LOW: ['낮음', 'is-crit'] };
export const confChip = (c) => html`<span class="hchip hchip--sm ${(CONF[c] || CONF.LOW)[1]}" title="AI 확신도">${(CONF[c] || CONF.LOW)[0]}</span>`;

/** "예상 10 Credits 사용 · 잔여 990" — both numbers come from the server (feature config + account), never hard-coded here. */
export const creditLine = (st, feature) => {
  if (!st?.enabled) return '';
  const cost = st.costs?.[feature]; const bal = st.credits?.available;
  const short = typeof cost === 'number' && typeof bal === 'number' && bal < cost;
  return html`<span class="ai-credit ${short ? 'is-short' : ''}" title="AI 사용량은 Workspace Credit으로 집계됩니다">예상 <b>${cost}</b> Credits 사용 · 잔여 <b>${bal ?? '-'}</b>${raw(short ? ' · <em>Credit 부족 — 관리자에게 문의하세요</em>' : '')}</span>`;
};
export const canRun = (st, feature) => Boolean(st?.enabled) && !(typeof st.costs?.[feature] === 'number' && typeof st.credits?.available === 'number' && st.credits.available < st.costs[feature]);

/** Human copy for AI error codes (the API message is kept as detail). */
export function aiErrorMessage(e) {
  const code = e?.code;
  if (code === 'AI_CREDIT_INSUFFICIENT') return `AI Credit이 부족합니다. 현재 ${e.error?.balance ?? '?'} Credits · 필요 ${e.error?.required ?? '?'} Credits — 관리자에게 문의하세요.`;
  if (code === 'AI_DISABLED') return 'AI 기능을 사용할 수 없습니다. 관리자에게 문의하세요.';
  if (code === 'AI_RATE_LIMITED') return e.message || 'AI 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'AI_INPUT_TOO_LARGE') return e.message;
  if (['AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_INVALID_OUTPUT'].includes(code)) return `AI 응답을 생성하지 못했습니다. 다시 시도해 주세요. (${e.message})`;
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
    busy(on, label = 'AI가 분석하는 중입니다…') { busy = on; el.classList.toggle('is-busy', on); let o = $('.aid__busy', el); if (on) { if (!o) { o = document.createElement('div'); o.className = 'aid__busy'; $('.dialog', el).append(o); } o.innerHTML = html`<span class="spin"></span><span>${label}</span>`; } else if (o) o.remove(); },
  };
}

/** Standard "no result" / warnings blocks. */
export const warningsHtml = (w) => (w && w.length ? html`<ul class="aid__warn">${raw(w.map((x) => html`<li>${x}</li>`).join(''))}</ul>` : '');
export const aiNotice = (st) => html`<p class="aid__notice">${st?.notice || '현재 프로젝트의 요구사항, WBS, 이슈 데이터를 참고합니다.'}</p>`;
export const reportError = (e) => toast(aiErrorMessage(e));
