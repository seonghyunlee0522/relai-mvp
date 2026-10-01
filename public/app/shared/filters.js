/* Filter UX (O): selects stay in the toolbar; applied filters are echoed as removable chips + one "필터 초기화". */
import { html, raw } from '../core/dom.js';

/** <select> with a blank "Label: 전체" option. `cur` may be a comma list (first value is shown as selected). */
export const filterSelect = (key, label, map, cur, extra = '') => {
  const first = String(cur || '').split(',').filter(Boolean)[0] || '';
  return html`<select class="select select--sm" data-f="${key}" aria-label="${label}"><option value="">${label}: 전체</option>${raw(Object.entries(map).map(([v, l]) => html`<option value="${v}" ${first === v ? 'selected' : ''}>${l}</option>`).join(''))}${raw(extra)}</select>`;
};

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
