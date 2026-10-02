/* Data grid — the table used by every list screen.
 * Sort · column show/hide · column resize · multi-select (shift range) · pagination · inline edit · keyboard rows.
 * Markup is stateless (`html()`); view preferences (sort, hidden columns, widths, page size) persist per grid key.
 *
 * cfg: { key, columns, rowId(r), rowClass?(r), select = true, paginate = true, pageSize = 100, sortable = true,
 *        canEdit?(r, col), onEdit?(id, field, value), onOpen?(id), onSelect?(selectedSet), empty?(), activeId?() }
 * column: { key, label, width, min, sort?(r) → comparable, render(r) → html, cls?, align?, sticky?, hidden?, fixed?,
 *           edit?: { type: 'select'|'date'|'number', field, options?(r)|map|[[v,l]], value?(r), min?, max? } }
 */
import { esc, html, raw } from '../core/dom.js';
import { store } from '../core/ui.js';

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const SIZES = [50, 100, 200, 500];
const CHK_W = 38;

const pairs = (o) => (Array.isArray(o) ? o : Object.entries(o || {}));

export function createGrid(cfg) {
  const cols = cfg.columns;
  const prefs = store.get(`grid.${cfg.key}`, {}) || {};
  const select = cfg.select !== false;
  const st = {
    rows: [],
    sort: cfg.sortable === false ? null : (prefs.sort || cfg.defaultSort || null),
    hidden: new Set(Array.isArray(prefs.hidden) ? prefs.hidden : cols.filter((c) => c.hidden).map((c) => c.key)),
    widths: { ...(prefs.widths || {}) },
    page: 1,
    size: prefs.size || cfg.pageSize || 100,
    selected: new Set(),
    anchor: null,
    el: null,
  };
  const save = () => store.set(`grid.${cfg.key}`, { sort: st.sort, hidden: [...st.hidden], widths: st.widths, size: st.size });
  const visibleCols = () => cols.filter((c) => !st.hidden.has(c.key));
  const colW = (c) => Math.max(c.min || 56, st.widths[c.key] || c.width || 120);
  const paged = cfg.paginate !== false;

  const sortedRows = () => {
    if (!st.sort) return st.rows;
    const c = cols.find((x) => x.key === st.sort.key);
    if (!c || !c.sort) return st.rows;
    const dir = st.sort.dir === 'desc' ? -1 : 1;
    const empty = (v) => v === null || v === undefined || v === '';
    return [...st.rows].sort((a, b) => {
      const x = c.sort(a); const y = c.sort(b);
      if (empty(x)) return empty(y) ? 0 : 1;
      if (empty(y)) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y))) * dir;
    });
  };
  const view = () => {
    const all = sortedRows();
    if (!paged) return { all, rows: all, pages: 1 };
    const pages = Math.max(1, Math.ceil(all.length / st.size));
    st.page = Math.min(Math.max(1, st.page), pages);
    return { all, rows: all.slice((st.page - 1) * st.size, st.page * st.size), pages };
  };
  const rowById = (id) => st.rows.find((r) => String(cfg.rowId(r)) === String(id));

  /* ---------- markup ---------- */
  const cell = (c, r) => {
    const ed = c.edit && (!cfg.canEdit || cfg.canEdit(r, c)) ? c.edit : null;
    if (!ed) return c.render(r);
    const cur = ed.value ? ed.value(r) : r[ed.field];
    if (ed.type === 'select') {
      const opts = pairs(typeof ed.options === 'function' ? ed.options(r) : ed.options);
      const sel = html`<select class="cell cell--sel ${ed.cls || ''}" data-edit="${ed.field}" aria-label="${c.label}">${raw(opts.map(([v, l]) => html`<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${l}</option>`).join(''))}</select>`;
      return ed.prefix ? html`<span class="cellwrap">${raw(ed.prefix(r))}${raw(sel)}</span>` : sel;
    }
    if (ed.type === 'date') return html`<input type="date" class="cell cell--date" data-edit="${ed.field}" value="${cur || ''}" aria-label="${c.label}">`;
    if (ed.type === 'number') return html`<input type="number" class="cell cell--num" data-edit="${ed.field}" value="${cur ?? ''}" min="${ed.min ?? 0}" max="${ed.max ?? 100}" step="1" aria-label="${c.label}">`;
    return c.render(r);
  };

  const rowHtml = (r, i, vc) => {
    const id = String(cfg.rowId(r));
    const checked = st.selected.has(id);
    const active = cfg.activeId && String(cfg.activeId()) === id;
    return html`<tr class="${cfg.rowClass ? cfg.rowClass(r) : ''} ${checked ? 'is-checked' : ''} ${active ? 'is-sel' : ''}" data-id="${id}" tabindex="${i === 0 ? 0 : -1}">
      ${raw(select ? html`<td class="gc gc--chk"><input type="checkbox" data-pick aria-label="행 선택" ${checked ? 'checked' : ''}></td>` : '')}
      ${raw(vc.map((c) => html`<td class="gc ${c.sticky ? 'gc--stick' : ''} ${c.cls || ''} ${c.align ? 'ta-' + c.align : ''}">${raw(cell(c, r))}</td>`).join(''))}</tr>`;
  };

  const headHtml = (vc, pageRows) => {
    const allOn = pageRows.length > 0 && pageRows.every((r) => st.selected.has(String(cfg.rowId(r))));
    const some = !allOn && pageRows.some((r) => st.selected.has(String(cfg.rowId(r))));
    return html`<tr>${raw(select ? html`<th class="gc gc--chk"><input type="checkbox" data-all aria-label="현재 페이지 전체 선택" ${allOn ? 'checked' : ''} ${some ? 'data-indet' : ''}></th>` : '')}
      ${raw(vc.map((c) => {
        const on = st.sort && st.sort.key === c.key;
        const sortable = cfg.sortable !== false && c.sort;
        return html`<th class="gc ${c.sticky ? 'gc--stick' : ''} ${c.align ? 'ta-' + c.align : ''}" aria-sort="${on ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
          <span class="gh ${sortable ? 'is-sortable' : ''}" ${raw(sortable ? html`data-sort="${c.key}"` : '')}>${c.label}${raw(on ? `<i class="sa">${st.sort.dir === 'asc' ? '▲' : '▼'}</i>` : '')}</span><i class="grz" data-rz="${c.key}" title="드래그하여 너비 조절"></i></th>`;
      }).join(''))}</tr>`;
  };

  const footHtml = (all, pages) => {
    const n = st.selected.size;
    const from = all.length ? (st.page - 1) * st.size + 1 : 0;
    const to = Math.min(all.length, st.page * st.size);
    const pageIds = view().rows.map((r) => String(cfg.rowId(r)));
    const pageAll = pageIds.length && pageIds.every((i) => st.selected.has(i));
    return html`<div class="gfoot"><span>총 <b>${all.length.toLocaleString('ko-KR')}</b>건</span>
      ${raw(n ? html`<span class="gfoot__sel"><b>${n.toLocaleString('ko-KR')}</b>건 선택됨${raw(pageAll && n < all.length ? html` · <button type="button" class="link linkbtn" data-pickall>필터 결과 ${all.length.toLocaleString('ko-KR')}건 모두 선택</button>` : '')}</span>` : '')}
      <span class="gfoot__sp"></span>
      ${raw(paged ? html`<span>${from.toLocaleString('ko-KR')}–${to.toLocaleString('ko-KR')}</span>
        <select class="select select--xs" data-gsize aria-label="페이지당 행 수">${raw(SIZES.map((s) => html`<option value="${s}" ${st.size === s ? 'selected' : ''}>${s}행</option>`).join(''))}</select>
        <button type="button" class="btn btn--secondary btn--xs" data-gprev ${st.page <= 1 ? 'disabled' : ''} aria-label="이전 페이지">‹</button>
        <span class="gfoot__pg">${st.page} / ${pages}</span>
        <button type="button" class="btn btn--secondary btn--xs" data-gnext ${st.page >= pages ? 'disabled' : ''} aria-label="다음 페이지">›</button>` : '')}</div>`;
  };

  const inner = () => {
    const { all, rows, pages } = view();
    if (!all.length) return cfg.empty ? cfg.empty() : '<div class="empty empty--sm"><h2>표시할 데이터가 없습니다.</h2></div>';
    const vc = visibleCols();
    const total = (select ? CHK_W : 0) + vc.reduce((s, c) => s + colW(c), 0);
    return html`<div class="gridwrap"><table class="gtable" style="width:${total}px">
      <colgroup>${raw(select ? `<col style="width:${CHK_W}px">` : '')}${raw(vc.map((c) => html`<col data-col="${c.key}" style="width:${colW(c)}px">`).join(''))}</colgroup>
      <thead>${raw(headHtml(vc, rows))}</thead>
      <tbody>${raw(rows.map((r, i) => rowHtml(r, i, vc)).join(''))}</tbody></table></div>${raw(footHtml(all, pages))}`;
  };

  /* ---------- state helpers ---------- */
  const pageIds = () => view().rows.map((r) => String(cfg.rowId(r)));
  const notify = () => { if (cfg.onSelect) cfg.onSelect(st.selected); };
  const syncSelectionUi = () => {
    if (!st.el) return;
    const ids = new Set(st.selected);
    st.el.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      const on = ids.has(tr.dataset.id);
      tr.classList.toggle('is-checked', on);
      const cb = tr.querySelector('[data-pick]'); if (cb) cb.checked = on;
    });
    const rows = view().rows; const allOn = rows.length > 0 && rows.every((r) => ids.has(String(cfg.rowId(r))));
    const some = !allOn && rows.some((r) => ids.has(String(cfg.rowId(r))));
    const head = st.el.querySelector('[data-all]'); if (head) { head.checked = allOn; head.indeterminate = some; }
    const foot = st.el.querySelector('.gfoot'); if (foot) { const { all, pages } = view(); foot.outerHTML = footHtml(all, pages); }
    notify();
  };
  const paintIndeterminate = () => { const h = st.el && st.el.querySelector('[data-indet]'); if (h) h.indeterminate = true; };

  function refresh() {
    if (!st.el) return;
    const wrap = st.el.querySelector('.gridwrap');
    const top = wrap ? wrap.scrollTop : 0; const left = wrap ? wrap.scrollLeft : 0;
    st.el.innerHTML = inner();
    const w2 = st.el.querySelector('.gridwrap'); if (w2) { w2.scrollTop = top; w2.scrollLeft = left; }
    paintIndeterminate();
  }

  /* ---------- events (delegated on the #grid container, attached once per render of the page) ---------- */
  const onClick = (e) => {
    const t = e.target;
    const head = t.closest('[data-sort]');
    if (head) {
      const key = head.dataset.sort;
      st.sort = !st.sort || st.sort.key !== key ? { key, dir: 'asc' } : st.sort.dir === 'asc' ? { key, dir: 'desc' } : null;
      save(); refresh(); return;
    }
    if (t.closest('[data-gprev]')) { st.page -= 1; refresh(); return; }
    if (t.closest('[data-gnext]')) { st.page += 1; refresh(); return; }
    if (t.closest('[data-pickall]')) { sortedRows().forEach((r) => st.selected.add(String(cfg.rowId(r)))); syncSelectionUi(); return; }
    if (t.closest('[data-all]')) {
      const on = t.closest('[data-all]').checked;
      pageIds().forEach((id) => (on ? st.selected.add(id) : st.selected.delete(id)));
      syncSelectionUi(); return;
    }
    const pick = t.closest('[data-pick]');
    if (pick) {
      const id = pick.closest('tr').dataset.id; const ids = pageIds(); const idx = ids.indexOf(id);
      if (e.shiftKey && st.anchor !== null && st.anchor < ids.length) {
        const [a, b] = [Math.min(st.anchor, idx), Math.max(st.anchor, idx)];
        ids.slice(a, b + 1).forEach((i) => (pick.checked ? st.selected.add(i) : st.selected.delete(i)));
      } else if (pick.checked) st.selected.add(id); else st.selected.delete(id);
      st.anchor = idx; syncSelectionUi(); return;
    }
    if (t.closest('input,select,textarea,button,a,label,.grz,[data-noopen]')) return;
    const tr = t.closest('tr[data-id]');
    if (tr && cfg.onOpen) cfg.onOpen(tr.dataset.id);
  };
  const onChange = async (e) => {
    const sz = e.target.closest('[data-gsize]');
    if (sz) { st.size = Number(sz.value); st.page = 1; save(); refresh(); return; }
    const ed = e.target.closest('[data-edit]');
    if (!ed || !cfg.onEdit) return;
    const id = ed.closest('tr').dataset.id;
    const value = ed.type === 'number' ? (ed.value === '' ? null : Number(ed.value)) : ed.value;
    ed.disabled = true;
    try { await cfg.onEdit(id, ed.dataset.edit, value); } catch { /* the page reports the error */ }
    refresh();
  };
  const onKey = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || e.target !== tr) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
      if (n && n.dataset.id) { e.preventDefault(); n.tabIndex = 0; tr.tabIndex = -1; n.focus(); }
    } else if (e.key === 'Enter') { e.preventDefault(); if (cfg.onOpen) cfg.onOpen(tr.dataset.id); }
    else if (e.key === ' ') { e.preventDefault(); const cb = tr.querySelector('[data-pick]'); if (cb) cb.click(); }
  };
  const onResize = (e) => {
    const h = e.target.closest('.grz'); if (!h) return;
    e.preventDefault();
    const c = cols.find((x) => x.key === h.dataset.rz); if (!c) return;
    const colEl = st.el.querySelector(`col[data-col="${c.key}"]`); const table = st.el.querySelector('.gtable');
    const x0 = e.clientX; const w0 = colW(c); const t0 = table.offsetWidth;
    const move = (ev) => { const w = Math.max(c.min || 56, w0 + ev.clientX - x0); colEl.style.width = w + 'px'; table.style.width = (t0 + w - w0) + 'px'; st.widths[c.key] = w; };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('is-resizing'); save(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.body.classList.add('is-resizing');
  };

  /* ---------- column menu (button lives in the page toolbar) ---------- */
  const popHtml = () => html`<div class="gpop__t">표시할 컬럼</div>${raw(cols.filter((c) => !c.fixed).map((c) => html`<label class="gpop__i"><input type="checkbox" data-gcol="${c.key}" ${st.hidden.has(c.key) ? '' : 'checked'}> ${c.label}</label>`).join(''))}<button type="button" class="link linkbtn gpop__r" data-greset>기본값으로 복원</button>`;
  const bindTools = (root) => {
    root.querySelectorAll('[data-gtools]').forEach((box) => {
      if (box.dataset.gtools !== cfg.key) return;
      const btn = box.querySelector('[data-gcols]'); const pop = box.querySelector('.gpop');
      btn.onclick = (e) => { e.stopPropagation(); const open = pop.hidden; document.querySelectorAll('.gpop').forEach((p) => { p.hidden = true; }); pop.innerHTML = popHtml(); pop.hidden = !open; };
      pop.onclick = (e) => e.stopPropagation();
      pop.onchange = (e) => {
        const cb = e.target.closest('[data-gcol]'); if (!cb) return;
        if (cb.checked) st.hidden.delete(cb.dataset.gcol); else st.hidden.add(cb.dataset.gcol);
        save(); refresh();
      };
      pop.addEventListener('click', (e) => {
        if (!e.target.closest('[data-greset]')) return;
        st.hidden = new Set(cols.filter((c) => c.hidden).map((c) => c.key)); st.widths = {}; st.sort = cfg.defaultSort || null; save(); pop.innerHTML = popHtml(); refresh();
      });
    });
  };
  if (!document.body.dataset.gpopBound) {
    document.body.dataset.gpopBound = '1';
    document.addEventListener('click', () => document.querySelectorAll('.gpop').forEach((p) => { p.hidden = true; }));
  }

  /* ---------- public API ---------- */
  return {
    get selected() { return st.selected; },
    get count() { return st.rows.length; },
    setRows(rows) {
      st.rows = rows;
      const live = new Set(rows.map((r) => String(cfg.rowId(r))));
      for (const id of [...st.selected]) if (!live.has(id)) st.selected.delete(id);
    },
    html: () => html`<div id="grid" class="grid">${raw(inner())}</div>`,
    toolsHtml: () => html`<span class="gtools" data-gtools="${cfg.key}"><button type="button" class="btn btn--secondary btn--sm" data-gcols aria-haspopup="true">컬럼</button><div class="gpop" hidden></div></span>`,
    bind(root) {
      st.el = root.querySelector('#grid');
      bindTools(root);
      if (!st.el) return;
      st.el.addEventListener('click', onClick);
      st.el.addEventListener('change', onChange);
      st.el.addEventListener('keydown', onKey);
      st.el.addEventListener('pointerdown', onResize);
      paintIndeterminate();
    },
    refresh,
    rowById,
    clearSelection() { st.selected.clear(); st.anchor = null; syncSelectionUi(); },
    selectedIds: () => [...st.selected],
    /** Visible (filtered, sorted) row ids across all pages — used for prev/next navigation in the detail view. */
    orderedIds: () => sortedRows().map((r) => String(cfg.rowId(r))),
  };
}

export const gridEsc = esc;
