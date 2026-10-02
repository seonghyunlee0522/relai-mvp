/* Bulk action bar — appears while rows are selected. Explicit "field + value + 적용" so a stray click cannot rewrite hundreds of rows.
 * fields: [{ key, label, type?: 'select'|'date'|'number', options?: [[value,label]…]|map, min?, max?, hint? }] */
import { api } from '../core/api.js';
import { html, raw } from '../core/dom.js';

const pairs = (o) => (Array.isArray(o) ? o : Object.entries(o || {}));

const valueControl = (f) => {
  if (!f) return '';
  if (f.type === 'date') return html`<input class="input input--sm" type="date" data-bv aria-label="${f.label}">`;
  if (f.type === 'number') return html`<input class="input input--sm" type="number" data-bv min="${f.min ?? 0}" max="${f.max ?? 100}" step="1" placeholder="${f.hint || ''}" aria-label="${f.label}" style="width:110px">`;
  return html`<select class="select select--sm" data-bv aria-label="${f.label}"><option value="" disabled selected>값 선택</option>${raw(pairs(f.options).map(([v, l]) => html`<option value="${v}">${l}</option>`).join(''))}</select>`;
};

/**
 * Mounts the bar into `slot` (an empty container) and returns { update(count), destroy() }.
 * onApply({ field, value }) / onArchive() / onClear() may be async; the Apply button is disabled while they run.
 */
export function mountBulk(slot, { fields, canArchive = true, onApply, onArchive, onClear }) {
  let bar = null;
  const build = (count) => {
    slot.innerHTML = html`<div class="bulk" role="region" aria-label="일괄 작업">
      <b class="bulk__n"><span data-bcount>${count}</span>건 선택</b>
      <select class="select select--sm" data-bf aria-label="변경할 항목">${raw(fields.map((f, i) => html`<option value="${f.key}" ${i === 0 ? 'selected' : ''}>${f.label}</option>`).join(''))}</select>
      <span data-bslot>${raw(valueControl(fields[0]))}</span>
      <button type="button" class="btn btn--primary btn--sm" data-bapply disabled>일괄 변경</button>
      <span class="bulk__sp"></span>
      ${raw(canArchive ? '<button type="button" class="btn btn--danger btn--sm" data-barch>보관</button>' : '')}
      <button type="button" class="btn btn--secondary btn--sm" data-bclear>선택 해제</button></div>`;
    bar = slot.firstElementChild;
    const field = () => fields.find((f) => f.key === bar.querySelector('[data-bf]').value);
    const val = () => bar.querySelector('[data-bv]');
    const ready = () => { if (!bar || !slot.contains(bar)) return; const v = val(); bar.querySelector('[data-bapply]').disabled = !v || v.value === ''; };
    bar.querySelector('[data-bf]').onchange = () => { bar.querySelector('[data-bslot]').innerHTML = valueControl(field()); ready(); };
    bar.addEventListener('input', (e) => { if (e.target.closest('[data-bv]')) ready(); });
    bar.addEventListener('change', (e) => { if (e.target.closest('[data-bv]')) ready(); });
    const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; ready(); } };
    bar.querySelector('[data-bapply]').onclick = (e) => run(e.currentTarget, async () => {
      const f = field(); const v = val().value;
      await onApply({ field: f.key, value: f.type === 'number' ? Number(v) : v });
    });
    const arch = bar.querySelector('[data-barch]'); if (arch) arch.onclick = (e) => run(e.currentTarget, onArchive);
    bar.querySelector('[data-bclear]').onclick = () => onClear();
  };
  return {
    update(count) {
      if (!count) { slot.innerHTML = ''; bar = null; return; }
      if (!bar || !slot.contains(bar)) build(count);
      bar.querySelector('[data-bcount]').textContent = count.toLocaleString('ko-KR');
    },
    destroy() { slot.innerHTML = ''; bar = null; },
  };
}

/** POST a bulk action in chunks of 500 ids (server limit) and merge the answers: { updated, skipped:[{id,reason}], last }. */
export async function bulkRun(url, ids, body) {
  const out = { updated: 0, skipped: [], last: null };
  for (let i = 0; i < ids.length; i += 500) {
    const d = await api('POST', url, { ...body, ids: ids.slice(i, i + 500) });
    out.updated += d.updated || 0; out.skipped.push(...(d.skipped || [])); out.last = d;
  }
  return out;
}
