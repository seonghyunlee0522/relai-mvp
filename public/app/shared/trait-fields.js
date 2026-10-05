/* 프로젝트 기본 특성 — the select controls, rendered from the shared option set (project-traits.js) so 생성 화면 and 프로젝트 정의
 * can never drift apart. `bind` = 'name' (form posts via FormData) or 'data-f' (프로젝트 정의 working copy). */
import { html, raw } from '../core/dom.js';
import { PROJECT_TRAITS, traitLabel } from './project-traits.js';

export function traitFields(values = {}, { bind = 'name', disabled = false, idPrefix = 'tr', cls = 'field' } = {}) {
  return PROJECT_TRAITS.map((t) => {
    const v = values[t.field] ?? (t.required ? '' : t.default);
    const id = `${idPrefix}-${t.field}`;
    // 유형: placeholder only while nothing is chosen (required on create; "미설정" on older projects)
    const opts = (t.required && !v ? html`<option value="" selected disabled>${t.placeholder}</option>` : '')
      + t.options.map((o) => html`<option value="${o.value}" ${o.value === v ? 'selected' : ''} ${o.help ? `title="${o.help}"` : ''}>${o.label}</option>`).join('');
    const help = t.field === 'project_type'
      ? html`<div class="hint trf__help" data-type-help>${typeHelp(v)}</div>`
      : html`<div class="hint trf__help">${t.help}</div>`;
    return html`<div class="${cls} trf" data-field="${t.field}"><label for="${id}">${t.label}${raw(t.required ? ' <span class="req">*</span>' : '')}</label>
      <select class="select" id="${id}" ${bind}="${t.field}" ${disabled ? 'disabled' : ''} ${t.required ? 'data-required' : ''}>${raw(opts)}</select>${raw(help)}<div class="err" data-for="${t.field}"></div></div>`;
  }).join('');
}

/** Help line under 프로젝트 유형: the chosen type's description, or the general hint. */
export function typeHelp(value) {
  const t = PROJECT_TRAITS[0]; const o = t.options.find((x) => x.value === value);
  return o ? o.help : t.help;
}
/** Keep the 유형 help line in sync with the selection. */
export function wireTraitFields(root) {
  const sel = root.querySelector('select[name="project_type"], select[data-f="project_type"]');
  const help = root.querySelector('[data-type-help]');
  if (sel && help) sel.addEventListener('change', () => { help.textContent = typeHelp(sel.value); });
}

/** Read-only grid (프로젝트 정의 상단 · Project Chater): label / value pairs, "미설정" / "미정" muted. */
export const traitGrid = (values = {}) => html`<dl class="trg">${raw(PROJECT_TRAITS.map((t) => {
  const v = values[t.field]; const unset = !v || v === 'TBD';
  return html`<div class="trg__i"><dt>${t.label}</dt><dd class="${unset ? 'is-unset' : ''}">${traitLabel(t.field, v)}</dd></div>`;
}).join(''))}</dl>`;
