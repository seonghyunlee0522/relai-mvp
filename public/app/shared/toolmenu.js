/* Toolbar ⋯ menu (Redesign R2 — hive research/relai-redesign-spec.md §5.4/5.5): the quiet list toolbar keeps the status filter,
 * search, ⋯ and one primary visible; everything else (필터 더보기, 컬럼, 여러 개 선택, Excel, documents, AI) lives in here.
 * Sections are [title, html] pairs. Controls inside keep their own data-* hooks, so the page binds them as before.
 * Keyboard: Enter/Space on ⋯ opens and focuses the first control; Esc closes and returns focus. One open at a time. */
import { html, raw } from '../core/dom.js';

export const toolMenu = (sections, { label = '더보기' } = {}) => html`<span class="tmore" data-tmore-wrap><button type="button" class="btn btn--secondary btn--sm tmore__b" data-tmore aria-haspopup="true" aria-expanded="false" aria-label="${label}" title="${label}">⋯</button><div class="tmenu" hidden>${raw(sections.filter((s) => s && s[1]).map(([title, body]) => html`<div class="tmenu__sec">${raw(title ? html`<div class="tmenu__t">${title}</div>` : '')}${raw(body)}</div>`).join(''))}</div></span>`;
/** A plain menu row (button). `attrs` is trusted attribute markup. */
export const tmItem = (label, attrs, sub = '') => html`<button type="button" class="tmenu__i" ${raw(attrs)}>${label}${raw(sub ? html`<small>${raw(sub)}</small>` : '')}</button>`;
/** " · 50 크레딧" — the AI price shown before the click (credits AC3); from the server's /ai/status, never hard-coded. No won amount (batch7 #7). */
export const aiPrice = (st, feature) => { const c = st && st.costs ? st.costs[feature] : null; return typeof c === 'number' ? `${c.toLocaleString('ko-KR')} 크레딧` : ''; };

const closeAll = (except = null) => document.querySelectorAll('.tmenu').forEach((m) => { if (m === except) return; m.hidden = true; const b = m.previousElementSibling; if (b) b.setAttribute('aria-expanded', 'false'); });
if (typeof document !== 'undefined' && document.body && !document.body.dataset.tmoreBound) {
  document.body.dataset.tmoreBound = '1';
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tmore]');
    if (b) { const m = b.nextElementSibling; const open = m.hidden; closeAll(m); m.hidden = !open; b.setAttribute('aria-expanded', String(open)); if (open && e.detail === 0) { const f = m.querySelector('button,select,input,a'); if (f) f.focus(); } return; }
    const m = e.target.closest('.tmenu');
    if (!m) { if (!e.target.closest('.gpop')) closeAll(); return; }
    if (e.target.closest('.tmenu__i,[data-tm-close]')) closeAll();   // a plain row acts and closes; selects / checkboxes keep it open
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return; const m = document.querySelector('.tmenu:not([hidden])'); if (!m) return;
    const pop = m.querySelector('.gpop:not([hidden])'); if (pop) { e.stopPropagation(); pop.hidden = true; const b0 = pop.previousElementSibling; if (b0) b0.focus(); return; }   // a nested popover (컬럼) closes first
    e.stopPropagation(); closeAll(); const b = m.previousElementSibling; if (b) b.focus();
  }, true);
}
