/* Small modal form used by invitation flows (Settings › 멤버 초대, Admin › 고객 초대).
 * fields: [{ name, label, type?: 'text'|'email'|'select'|'textarea', required?, placeholder?, options?: [[value,label]], value?, hint? }]
 * Resolves the submitted values object, or null on cancel. `submit(values)` may throw { message, fields } to show errors inline. */
import { $, html, raw } from '../core/dom.js';
import { showErrors } from './dialogs.js';

export function formDialog({ title, body = '', fields, confirm = '저장', submit }) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    const control = (f) => {
      if (f.type === 'select') return html`<select class="select" id="fd-${f.name}" name="${f.name}">${raw(f.options.map(([v, l]) => html`<option value="${v}" ${v === f.value ? 'selected' : ''}>${l}</option>`).join(''))}</select>`;
      if (f.type === 'textarea') return html`<textarea class="textarea" id="fd-${f.name}" name="${f.name}" placeholder="${f.placeholder || ''}" maxlength="${f.maxlength || 1000}" style="min-height:72px">${f.value || ''}</textarea>`;
      return html`<input class="input" id="fd-${f.name}" name="${f.name}" type="${f.type || 'text'}" placeholder="${f.placeholder || ''}" value="${f.value || ''}" maxlength="${f.maxlength || 254}" autocomplete="off">`;
    };
    el.innerHTML = html`<form class="dialog" id="fd" role="dialog" aria-modal="true" aria-labelledby="fdT" novalidate><h3 id="fdT">${title}</h3>
      ${raw(body ? html`<div class="dialog__b">${raw(body)}</div>` : '')}
      <div class="form-err" id="ferr" role="alert" hidden></div>
      ${raw(fields.map((f) => html`<div class="field"><label for="fd-${f.name}">${f.label}${raw(f.required ? ' <span class="req">*</span>' : '')}</label>${raw(control(f))}${raw(f.hint ? html`<div class="hint">${f.hint}</div>` : '')}<div class="err" data-for="${f.name}"></div></div>`).join(''))}
      <div class="actions"><button type="button" class="btn btn--secondary" data-v="0">취소</button><button type="submit" class="btn btn--primary" id="fd-ok">${confirm}</button></div></form>`;
    const form = $('#fd', el);
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-v="0"]')) done(null); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form)); const local = {};
      for (const f of fields) if (f.required && !String(v[f.name] || '').trim()) local[f.name] = `${f.label}을(를) 입력해 주세요.`;
      showErrors(form, local); if (Object.keys(local).length) return;
      const ok = $('#fd-ok', el); ok.disabled = true;
      try { const r = submit ? await submit(v) : v; done(r === undefined ? v : r); }
      catch (err) { ok.disabled = false; showErrors(form, err.fields || {}, err.message); }
    });
    document.body.append(el); const first = form.querySelector('input,select,textarea'); if (first) first.focus();
  });
}

export const INVITE_STATUS = { PENDING: '대기', ACCEPTED: '수락', REVOKED: '취소', EXPIRED: '만료' };
export const INVITE_TYPE = { WORKSPACE_CREATE: '고객(Workspace 생성)', WORKSPACE_MEMBER: 'Workspace 멤버' };
export const EMAIL_STATUS = { PENDING: '발송 중', SENT: '발송됨', FAILED: '발송 실패' };
export const inviteStatusChip = (s) => html`<span class="chip ${s === 'PENDING' ? 'chip--hold' : s === 'ACCEPTED' ? 'chip--done' : s === 'REVOKED' ? 'chip--muted' : 'chip--fail'}">${INVITE_STATUS[s] || s}</span>`;
export const emailStatusChip = (s) => (!s ? '<span class="dim">-</span>' : html`<span class="chip ${s === 'SENT' ? 'chip--done' : s === 'FAILED' ? 'chip--fail' : 'chip--hold'}">${EMAIL_STATUS[s] || s}</span>`);
