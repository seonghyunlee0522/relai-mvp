/* Outside-tap close (Jim mobile 10-21 #6). Real iOS Safari does not always send a tap on a non-clickable area to a
 * `document` click listener, so a menu that only closes on click can stay open there. Menus also close on pointerdown,
 * which every touch sends. `inside(target)` = the menu itself or its own toggle: those taps are left to the click handlers
 * (a toggle closing on pointerdown would reopen on the click that follows). Keyboard / Esc handling is unchanged. */
export function closeOnOutsideTap(inside, close) {
  if (typeof document === 'undefined') return;
  document.addEventListener('pointerdown', (e) => { if (!inside(e.target)) close(); }, true);
}

/* <details class="pmenu"> / <details class="rmenu"> dropdowns (사업수행계획서 · 요구사항 정의서 · 보고서): one open at a time,
 * closed by an outside tap / click or Esc (Jim mobile 10-21 #2 — .pmenu had no outside close). */
const OPEN_DETAILS = 'details.pmenu[open], details.rmenu[open]';
const closeDetails = (keep = null) => document.querySelectorAll(OPEN_DETAILS).forEach((d) => { if (d !== keep) d.open = false; });
let wiredDetails = false;
export function wireDetailsMenus() {
  if (wiredDetails || typeof document === 'undefined') return; wiredDetails = true;
  const own = (t) => (t && t.closest ? t.closest('details.pmenu, details.rmenu') : null);
  document.addEventListener('pointerdown', (e) => closeDetails(own(e.target)), true);
  document.addEventListener('click', (e) => closeDetails(own(e.target)));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return; const o = document.querySelector(OPEN_DETAILS); if (!o) return;
    o.open = false; const s = o.querySelector('summary'); if (s) s.focus();
  });
}
