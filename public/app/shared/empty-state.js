/* Empty state (M): title + why it matters + one primary CTA. `small` = filtered-empty variant. */
import { html, raw } from '../core/dom.js';
import { isPhone } from '../core/device.js';

export function emptyState({ title, body = '', cta = null, small = false, filter = false }) {
  // phone = view mode: one sentence, no button (filters stay — clearing one is viewing)
  if (isPhone() && !filter) return html`<div class="empty empty--sm" data-phone-empty><h2>${title}</h2><p>PC에서 추가할 수 있습니다.</p></div>`;
  const btn = !cta ? '' : cta.href
    ? html`<a class="btn ${small ? 'btn--secondary' : 'btn--primary btn--lg'}" href="${cta.href}" data-link>${cta.label}</a>`
    : html`<button class="btn ${small ? 'btn--secondary' : 'btn--primary btn--lg'}" id="${cta.id}" ${filter ? 'data-phone-ok' : ''}>${cta.label}</button>`;
  return html`<div class="empty ${small ? 'empty--sm' : ''}"><h2>${title}</h2>${raw(body ? html`<p>${body}</p>` : '')}${raw(btn)}</div>`;
}
/** Filtered list came back empty. */
export const emptyFiltered = (what, clearId = 'clear2') => emptyState({ title: `조건에 맞는 ${what}이(가) 없습니다.`, body: '검색어나 필터를 바꿔보세요.', cta: { id: clearId, label: '필터 초기화' }, small: true, filter: true });
