/* Detail drawer layout helpers (L): Header = ID + status chips + close · Body = state → details → relations → history · Footer = destructive action. */
import { html, raw } from '../core/dom.js';
import { store } from '../core/ui.js';

/** Drawer header. `chips` is pre-rendered HTML (status badges). */
export const drawerHead = (idLabel, chips = '', { archived = false, closeId = 'dclose', nav = '' } = {}) =>
  html`<div class="drawer__h"><b class="mono">${idLabel}</b>${raw(chips)}${raw(archived ? '<span class="chip">보관됨</span>' : '')}${raw(nav)}<button class="drawer__x" id="${closeId}" aria-label="닫기">×</button></div>`;
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

/** Redesign R2: ↑ / ↓ move the open detail drawer to the previous / next item in list order (when focus is not in a field or menu).
 * `fn(dir)` with dir = -1 | 1. One document listener; each page render replaces the target. */
let arrowNav = null;
export function bindArrowNav(fn) {
  arrowNav = fn;
  if (document.body.dataset.arrowNav) return;
  document.body.dataset.arrowNav = '1';
  document.addEventListener('keydown', (e) => {
    if (!arrowNav || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const d = document.querySelector('#drawer:not([hidden])'); if (!d || !d.querySelector('[data-nav]') || document.querySelector('.scrim')) return;
    const t = e.target; if (t && t.closest && t.closest('input,select,textarea,[contenteditable="true"],.tmenu,.np__menu,.dmenu,.gpop,.amenu,#grid')) return;
    e.preventDefault(); arrowNav(e.key === 'ArrowDown' ? 1 : -1);
  });
}

/* Redesign R3b: issues · risks · 변경 요청 · tests · 검수 use the R2 480px side drawer on desktop (detail only — create forms,
 * approval drawers and the phone keep their views). Header ↑/↓ + keyboard, 세부 정보 더보기, footer = 보관 (left) · the row's actions (right). */
/** ↑ / ↓ buttons for the drawer header; `ids` = list order. */
export const navBtns = (ids, cur, what = '항목') => {
  const at = ids.indexOf(cur);
  return html`<span class="dnav"><button type="button" data-nav="-1" aria-label="이전 ${what}" title="이전 (목록 순서)" ${at <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-nav="1" aria-label="다음 ${what}" title="다음 (목록 순서)" ${at < 0 || at >= ids.length - 1 ? 'disabled' : ''}>↓</button></span>`;
};
/** Wires the header buttons and keyboard ↑/↓; `open(id)` shows another item. */
export function bindListNav(root, ids, cur, open) {
  const go = (dir) => { const n = ids[ids.indexOf(cur) + dir]; if (n) open(n); };
  root.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => go(Number(b.dataset.nav)); });
  bindArrowNav(go);
}
/** Secondary fields folded under 세부 정보 더보기 (`inner` = .dfield rows). */
export const moreFields = (inner, open = false) => html`<details class="dmore" data-dmore ${open ? 'open' : ''}><summary>세부 정보 더보기</summary><div class="dgrid">${raw(inner)}</div></details>`;
/** Desktop footer: 보관 link + meta (left), the item's actions (right). Read-only → no footer. */
export const deskFoot = ({ ro, meta = '', archId = 'xarchive', right = '' }) => (ro ? '' : html`<div class="drawer__f dfoot"><button type="button" class="link linkbtn dfoot__arch" id="${archId}">보관</button><span class="hint">${raw(meta)}</span><span class="dfoot__r">${raw(right)}</span></div>`);

/* batch7 B1 (#1 · #19): the detail panel's width. Default = --panel-w (clamp(480px, 34vw, 760px)); dragging the 6px strip on its
 * left edge sets --panel-w-user (480–960px), kept on this device (localStorage via store, try/catch inside). Double-click = default.
 * One document listener for every detail / approval panel (.drawer--lg · .drawer--side), whatever page rendered it. */
const PANEL_MIN = 480; const PANEL_MAX = 960; const EDGE = 6;
const setPanelW = (w) => { const el = document.documentElement; if (w) el.style.setProperty('--panel-w-user', `${w}px`); else el.style.removeProperty('--panel-w-user'); };
export const panelEdge = (d, x) => { const r = d.getBoundingClientRect(); return x >= r.left - 1 && x <= r.left + EDGE; };
if (typeof document !== 'undefined' && document.body && !document.body.dataset.panelResize) {
  document.body.dataset.panelResize = '1';
  const saved = Number(store.get('panel.w', 0)); if (saved >= PANEL_MIN && saved <= PANEL_MAX) setPanelW(saved);
  const panelAt = (e) => { const d = e.target.closest && e.target.closest('.drawer--lg, .drawer--side'); return d && !d.hidden && panelEdge(d, e.clientX) ? d : null; };
  document.addEventListener('pointerdown', (e) => {
    const d = panelAt(e); if (!d || e.button !== 0) return;
    e.preventDefault();
    // width from the start width and how far the edge moved left (an in-flow panel grows to its right, so the edge stays put — the drag still reads naturally)
    const w0 = d.getBoundingClientRect().width; const x0 = e.clientX; let w = 0;
    const move = (ev) => { w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w0 + x0 - ev.clientX))); setPanelW(w); };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('is-resizing'); if (w) store.set('panel.w', w); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.body.classList.add('is-resizing');
  }, true);
  document.addEventListener('dblclick', (e) => { if (panelAt(e)) { setPanelW(0); store.set('panel.w', 0); } }, true);
}
