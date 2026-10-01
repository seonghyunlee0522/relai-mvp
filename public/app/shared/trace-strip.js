/* Delivery Trace strip (I): the RELAI differentiator made visible on detail panels.
 * items: [{ label, value, sub?, href?, tone?: 'ok'|'warn'|'crit'|'' }] — summary + drill-down, never the full relation dump. */
import { html, raw } from '../core/dom.js';

export function traceStrip(items, { title = '딜리버리 추적', compact = false } = {}) {
  const cell = (it) => {
    const textVal = typeof it.value === 'string' && !/^\d/.test(it.value);
    const inner = html`<b class="${textVal ? 'is-text' : ''}">${it.value}</b><span>${it.label}</span>${raw(it.sub ? html`<small>${it.sub}</small>` : '')}`;
    return it.href ? html`<a class="trace__i ${it.tone ? 'is-' + it.tone : ''}" href="${it.href}" data-link>${raw(inner)}</a>` : html`<div class="trace__i ${it.tone ? 'is-' + it.tone : ''}">${raw(inner)}</div>`;
  };
  return html`<div class="trace ${compact ? 'trace--compact' : ''}"><div class="trace__t">${title}</div><div class="trace__g">${raw(items.map(cell).join(''))}</div></div>`;
}
