/* Outside-tap close (Jim mobile 10-21 #6; founder's real iPhone 10-21: "6번 안되는데" — pointerdown alone was not enough).
 * Real iOS Safari does not reliably send a tap on a non-clickable area to `document` listeners. So on a touch phone every open
 * menu gets a full-viewport transparent backdrop just below it: a real, clickable element, which iOS always delivers taps to.
 * Tapping it closes the menu (touchend or click) and it is removed when the menu closes, however it closes (item, Esc, toggle).
 * Menus register an "open" selector; one MutationObserver (+ the <details> toggle event) shows / hides the backdrop.
 * PC (fine pointer, ≥ 768px) gets no backdrop: outside clicks keep going straight to what was clicked, as before.
 * The pointerdown listeners stay as a fallback for taps that land above the backdrop (e.g. on a sticky header). */
const BD_ID = 'menubackdrop';
const MENUS = [];   // { sel: CSS selector matching an OPEN menu, close }
export const isBackdrop = (t) => Boolean(t && t.id === BD_ID);

const touchPhone = () => typeof matchMedia !== 'undefined'
  && (matchMedia('(max-width: 767px)').matches || matchMedia('(hover: none) and (pointer: coarse)').matches);

/** A tap on `el` runs `fn`: touchend (iOS — no reliance on the synthetic click; preventDefault so that click cannot fall through
 * to whatever is under the backdrop once it is gone) and click (mouse, keyboard, and touch browsers that skip touchend). */
export function onTap(el, fn) {
  let x = 0, y = 0, moved = false;
  el.addEventListener('touchstart', (e) => { const t = e.touches && e.touches[0]; moved = false; if (t) { x = t.clientX; y = t.clientY; } }, { passive: true });
  el.addEventListener('touchmove', (e) => { const t = e.touches && e.touches[0]; if (t && Math.hypot(t.clientX - x, t.clientY - y) > 10) moved = true; }, { passive: true });
  el.addEventListener('touchend', (e) => { if (moved) return; if (e.cancelable) e.preventDefault(); fn(e); });
  el.addEventListener('click', (e) => fn(e));
}

/* z-index for the backdrop: the menu is compared with the rest of the page through its outermost stacking-context ancestor
 * (e.g. the sticky .wsh header for the project ⋯ menu). The backdrop takes that same z and sits just before it in the DOM,
 * so it paints under the whole menu and over everything else at that level. */
function stackRoot(m) {
  let root = m, z = 0;
  for (let n = m; n && n !== document.body && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const ctx = (cs.position !== 'static' && cs.zIndex !== 'auto') || cs.position === 'fixed' || cs.position === 'sticky'
      || cs.transform !== 'none' || cs.filter !== 'none' || Number(cs.opacity) < 1 || cs.isolation === 'isolate';
    if (ctx) { root = n; z = parseInt(cs.zIndex, 10) || 0; }
  }
  let top = root; while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
  return { z, before: top.parentElement === document.body ? top : null };
}

function closeAll() {
  MENUS.forEach((m) => { try { if (document.querySelector(m.sel)) m.close(); } catch { /* one menu failing must not keep the others open */ } });
  sync();
}

function backdrop() {
  let b = document.getElementById(BD_ID);
  if (b) return b;
  b = document.createElement('div'); b.id = BD_ID; b.className = 'menubackdrop'; b.setAttribute('aria-hidden', 'true');
  onTap(b, (e) => { if (e.type === 'touchend') b.click(); else closeAll(); });   // the synthetic click also reaches every document click closer
  return b;
}

let pending = false;
function sync() {
  if (typeof document === 'undefined' || !document.body) return;
  const sel = MENUS.map((m) => m.sel).join(', ');
  const open = sel && touchPhone() ? [...document.querySelectorAll(sel)] : [];
  const cur = document.getElementById(BD_ID);
  if (!open.length) { if (cur) cur.remove(); return; }
  const spots = open.map(stackRoot); const s = spots.reduce((a, b) => (b.z < a.z ? b : a));
  const b = backdrop(); b.style.zIndex = String(s.z);
  const want = s.before || document.body.firstChild;
  if (b.nextSibling !== want || b.parentElement !== document.body) document.body.insertBefore(b, want);
}
const later = () => { if (pending) return; pending = true; Promise.resolve().then(() => { pending = false; sync(); }); };

let observing = false;
/** Register a menu: `sel` matches it while it is open, `close` closes it. Safe to call before <body> exists or outside a browser. */
export function trackMenu(sel, close) {
  MENUS.push({ sel, close });
  if (observing || typeof document === 'undefined' || typeof MutationObserver === 'undefined' || !document.documentElement) return;
  observing = true;
  new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  document.addEventListener('toggle', later, true);   // <details> open / close (toggle does not bubble: capture)
  if (typeof matchMedia !== 'undefined') matchMedia('(max-width: 767px)').addEventListener('change', later);
  later();
}

/** `inside(target)` = the menu itself or its own toggle: those taps are left to the click handlers (a toggle closing on pointerdown
 * would reopen on the click that follows). `openSel` (optional) puts the menu under the phone backdrop. Esc handling is unchanged. */
export function closeOnOutsideTap(inside, close, openSel) {
  if (typeof document === 'undefined') return;
  document.addEventListener('pointerdown', (e) => { if (!isBackdrop(e.target) && !inside(e.target)) close(); }, true);
  if (openSel) trackMenu(openSel, close);
}

/* .gpop popovers (Excel ▾ · 컬럼 · 필터): one global closer, wired once at app start (app.js). It used to live in shared/grid.js and
 * was bound only after a grid with column tools rendered, so on a page visited first without one (테스트 › Excel ▾) the popover
 * never closed on an outside click (Jim 10-21). Toggles open their popover on click after closing the others, so they count as inside. */
const GPOP_TOGGLES = '.gpop, [data-gcols], [data-fmore], #xl-btn';
const closeGpops = () => document.querySelectorAll('.gpop:not([hidden])').forEach((p) => { p.hidden = true; });
let wiredGpops = false;
export function wireGpops() {
  if (wiredGpops || typeof document === 'undefined') return; wiredGpops = true;
  document.addEventListener('click', () => document.querySelectorAll('.gpop').forEach((p) => { p.hidden = true; }));
  closeOnOutsideTap((t) => t.closest && t.closest(GPOP_TOGGLES), closeGpops, '.gpop:not([hidden])');
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGpops(); });
}

/* <details class="pmenu"> / <details class="rmenu"> dropdowns (사업수행계획서 · 요구사항 정의서 · 보고서): one open at a time,
 * closed by an outside tap / click or Esc (Jim mobile 10-21 #2 — .pmenu had no outside close). */
const OPEN_DETAILS = 'details.pmenu[open], details.rmenu[open]';
const closeDetails = (keep = null) => document.querySelectorAll(OPEN_DETAILS).forEach((d) => { if (d !== keep) d.open = false; });
let wiredDetails = false;
export function wireDetailsMenus() {
  if (wiredDetails || typeof document === 'undefined') return; wiredDetails = true;
  const own = (t) => (t && t.closest ? t.closest('details.pmenu, details.rmenu') : null);
  document.addEventListener('pointerdown', (e) => { if (!isBackdrop(e.target)) closeDetails(own(e.target)); }, true);
  document.addEventListener('click', (e) => closeDetails(own(e.target)));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return; const o = document.querySelector(OPEN_DETAILS); if (!o) return;
    o.open = false; const s = o.querySelector('summary'); if (s) s.focus();
  });
  trackMenu(OPEN_DETAILS, () => closeDetails());
}
