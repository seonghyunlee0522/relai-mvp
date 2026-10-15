/* Filter UX (O): selects stay in the toolbar; applied filters are echoed as removable chips + one "필터 초기화". */
import { html, raw } from '../core/dom.js';
import { isPhone } from '../core/device.js';

/** <select> with a blank "Label: 전체" option. `cur` may be a comma list (first value is shown as selected). */
export const filterSelect = (key, label, map, cur, extra = '') => {
  const first = String(cur || '').split(',').filter(Boolean)[0] || '';
  return html`<select class="select select--sm" data-f="${key}" aria-label="${label}"><option value="">${label}</option>${raw(Object.entries(map).map(([v, l]) => html`<option value="${v}" ${first === v ? 'selected' : ''}>${l}</option>`).join(''))}${raw(extra)}</select>`;
};

/** Filters beyond search + 2 dropdowns sit behind one "필터 (n)" button (design §3.3): a popover on desktop, a bottom sheet under 640px.
 * The controls inside keep their own ids / data-f, so the page's existing bindings work unchanged. */
/* K20: on phones the sheet has a dim backdrop (CSS), a header with ✕ and an 적용 button; filters still apply as they change, 적용 closes the sheet. */
export const moreFilters = (inner, n = 0) => html`<span class="gtools fmore"><button type="button" class="btn btn--secondary btn--sm" data-fmore data-phone-ok aria-haspopup="true">필터${n ? ` (${n})` : ''}</button><div class="gpop gpop--filters" hidden><div class="gpop__t"><span>필터</span><button type="button" class="fsheet__x" data-fclose aria-label="닫기">✕</button></div>${raw(inner)}<div class="fsheet__f"><button type="button" class="btn btn--primary" data-fclose data-phone-ok>적용</button></div></div></span>`;
let keepSheet = false;   // a filter changed inside the phone sheet → the page redraws; reopen the sheet until 적용 / ✕
export function bindMoreFilters(root) {
  root.querySelectorAll('[data-fmore]').forEach((btn) => {
    const pop = btn.nextElementSibling;
    btn.onclick = (e) => { e.stopPropagation(); const open = pop.hidden; document.querySelectorAll('.gpop').forEach((x) => { x.hidden = true; }); pop.hidden = !open; };
    pop.onclick = (e) => { e.stopPropagation(); if (e.target.closest('[data-fclose]')) { pop.hidden = true; keepSheet = false; } };
    pop.addEventListener('change', () => { keepSheet = isPhone(); }, true);
    if (keepSheet) { pop.hidden = false; keepSheet = false; }
  });
}

/** Phone width (< 768px, core/device.js), decided at render time like the grid's card mode. */
export { isPhone };
/** Phone = view mode: a list toolbar is search + 필터 (n) + tabs, so every other filter control moves into the 필터 sheet. */
export const phoneFilters = (inner, keys, q) => (isPhone() ? moreFilters(inner, keys.filter((k) => q.get(k)).length) : inner);

/**
 * Applied-filter chips. defs: [{ key, label, map?, format?(value) }]. Values can be comma lists.
 * Renders nothing when no filter is active. Chips carry data-fclear="<key>"; "필터 초기화" carries id="clear".
 */
export function appliedFilters(q, defs) {
  const chips = [];
  for (const d of defs) {
    const v = q.get(d.key); if (!v) continue;
    const text = d.format ? d.format(v) : v.split(',').map((x) => (d.map && d.map[x]) || x).join(', ');
    chips.push(html`<span class="fchip">${d.label}: <b>${text}</b><button type="button" data-fclear="${d.key}" aria-label="${d.label} 필터 해제">×</button></span>`);
  }
  if (!chips.length) return '';
  return html`<div class="applied">${raw(chips.join(''))}<button type="button" class="link linkbtn" id="clear" style="width:auto">필터 초기화</button></div>`;
}
/** Wires chip × buttons and the clear button. `keys` = every filter key to clear on reset. */
export function bindFilterClears(root, { setParam, keys, reload }) {
  root.querySelectorAll('[data-fclear]').forEach((b) => b.onclick = async () => { setParam(b.dataset.fclear, ''); await reload(); });
  for (const id of ['clear', 'clear2']) { const b = root.querySelector('#' + id); if (b) b.onclick = async () => { for (const k of keys) setParam(k, ''); await reload(); }; }
}
