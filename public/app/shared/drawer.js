/* Detail drawer layout helpers (L): Header = ID + status chips + close · Body = state → details → relations → history · Footer = destructive action. */
import { html, raw } from '../core/dom.js';

/** Drawer header. `chips` is pre-rendered HTML (status badges). */
export const drawerHead = (idLabel, chips = '', { archived = false, closeId = 'dclose' } = {}) =>
  html`<div class="drawer__h"><b class="mono">${idLabel}</b>${raw(chips)}${raw(archived ? '<span class="chip">보관됨</span>' : '')}<button class="drawer__x" id="${closeId}" aria-label="닫기">×</button></div>`;
/** Drawer footer with the archive (destructive) action; omitted entirely when read-only. */
export const drawerFoot = ({ ro, meta = '', label, id = 'xarchive' }) =>
  (ro ? '' : html`<div class="drawer__f"><span class="hint">${raw(meta)}</span><button class="btn btn--danger btn--sm" id="${id}">${label}</button></div>`);
/** Section heading inside a drawer body. */
export const drawerSection = (title, count = null, right = '') =>
  html`<h4 class="dh">${title}${raw(count === null ? '' : html` <em>${count}</em>`)}${raw(right ? html`<span class="dh__r">${raw(right)}</span>` : '')}</h4>`;
/** Esc closes the open drawer unless a dialog is open (dialogs handle their own Esc). One handler per page render. */
export function bindEscape(close) {
  document.onkeydown = (e) => { if (e.key === 'Escape' && !document.querySelector('.scrim') && !e.target.closest('select')) close(); };
}
