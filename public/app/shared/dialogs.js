import { $, html, raw } from '../core/dom.js';
import { LINK_TYPE } from './constants.js';

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export function confirmDialog({ title, body, confirm, danger }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgT">
      <h3 id="dlgT">${title}</h3><div class="dialog__b">${body}</div>
      <div class="actions"><button class="btn btn--secondary" data-v="0">취소</button>
      <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-v="1">${confirm}</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1'); else if (e.target === el) done(false); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    document.body.append(el);
    $('[data-v="0"]', el).focus();
  });
}

/** Generic picker modal: search + list of candidates (already-linked ones disabled), optional link type. Resolves {id, link_type} or null. */
export function pickerDialog({ title, placeholder, rows, render, searchKeys, withType = true, types = LINK_TYPE, typeLabel = '연결 유형', confirm = '연결' }) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    let selected = null;
    const list = (q) => {
      const term = q.trim().toLowerCase();
      const shown = term ? rows.filter((r) => searchKeys.some((k) => String(r[k] || '').toLowerCase().includes(term))) : rows;
      return shown.length ? shown.map((r) => html`<label class="pick ${r.disabled ? 'is-disabled' : ''} ${selected === r.id ? 'is-sel' : ''}">
        <input type="radio" name="pick" value="${r.id}" ${r.disabled ? 'disabled' : ''} ${selected === r.id ? 'checked' : ''}>${raw(render(r))}</label>`).join('')
        : '<p class="hint" style="padding:16px 4px">검색 결과가 없습니다.</p>';
    };
    el.innerHTML = html`<div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="pkT">
      <h3 id="pkT">${title}</h3>
      <input class="input input--sm" id="pk-q" type="search" placeholder="${placeholder}" autocomplete="off">
      <div class="pick-list" id="pk-list">${raw(list(''))}</div>
      <div class="actions" style="justify-content:space-between;align-items:center">
        ${raw(withType ? html`<label class="toggle">${typeLabel} <select class="select select--sm" id="pk-type">${raw(Object.entries(types).map(([v, l]) => html`<option value="${v}">${l}</option>`).join(''))}</select></label>` : '<span></span>')}
        <span style="display:flex;gap:10px"><button class="btn btn--secondary" data-v="0">취소</button><button class="btn btn--primary" data-v="1" id="pk-ok" disabled>${confirm}</button></span></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    const qi = $('#pk-q', el); const lst = $('#pk-list', el);
    qi.oninput = () => { lst.innerHTML = list(qi.value); };
    lst.addEventListener('change', (e) => { if (e.target.name === 'pick') { selected = e.target.value; $('#pk-ok', el).disabled = false; lst.querySelectorAll('.pick').forEach((p) => p.classList.toggle('is-sel', p.querySelector('input').value === selected)); } });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1' && selected ? { id: selected, link_type: withType ? $('#pk-type', el).value : undefined } : null); else if (e.target === el) done(null); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    document.body.append(el); qi.focus();
  });
}

/** Confirm dialog with a textarea. Resolves the text (may be '') or null on cancel. */
export function promptDialog({ title, body, label, placeholder = '', required = false, confirm, danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pdT"><h3 id="pdT">${title}</h3>
      ${raw(body ? html`<div class="dialog__b">${raw(body)}</div>` : '')}
      <div class="field"><label for="pd-in">${label}${raw(required ? ' <span class="req">*</span>' : '')}</label><textarea class="textarea" id="pd-in" placeholder="${placeholder}" maxlength="2000" style="min-height:84px"></textarea><div class="err" id="pd-err"></div></div>
      <div class="actions"><button class="btn btn--secondary" data-v="0">취소</button><button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-v="1">${confirm}</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; }
      if (b.dataset.v === '0') return done(null);
      const v = $('#pd-in', el).value.trim(); if (required && !v) { $('#pd-err', el).textContent = `${label}을(를) 입력해 주세요.`; return; } done(v); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    document.body.append(el); $('#pd-in', el).focus();
  });
}
export function showErrors(form, fields = {}, general) {
  form.querySelectorAll('.err').forEach((el) => { el.textContent = ''; });
  form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
  let first;
  for (const [k, msg] of Object.entries(fields)) {
    const slot = form.querySelector(`.err[data-for="${k}"]`);
    if (slot) { slot.textContent = msg; }
    const input = form.querySelector(`[name="${k}"]`);
    if (input?.classList) input.classList.add('is-invalid');
    first ||= input;
  }
  const g = form.querySelector('.form-err');
  if (g) { g.hidden = !(general && !Object.keys(fields).length); g.textContent = general || ''; }
  if (first?.focus) first.focus();
}
