/* Delivery Trace strip (I): the RELAI differentiator made visible on detail panels.
 * items: [{ label, value, sub?, href?, tab?, tone?: 'ok'|'warn'|'crit'|'' }] — summary + drill-down, never the full relation dump.
 * tab: drills into a tab of the same detail panel (button[data-trace-tab]; the page wires it to its [data-dtab]). */
import { html, raw } from '../core/dom.js';

export function traceStrip(items, { title = '연결 추적', compact = false } = {}) {
  const cell = (it) => {
    const textVal = typeof it.value === 'string' && !/^\d/.test(it.value);
    const inner = html`<b class="${textVal ? 'is-text' : ''}">${it.value}</b><span>${it.label}</span>${raw(it.sub ? html`<small>${it.sub}</small>` : '')}`;
    const cls = `trace__i ${it.tone ? 'is-' + it.tone : ''}`;
    if (it.href) return html`<a class="${cls}" href="${it.href}" data-link>${raw(inner)}</a>`;
    if (it.tab) return html`<button type="button" class="${cls}" data-trace-tab="${it.tab}">${raw(inner)}</button>`;
    return html`<div class="${cls}">${raw(inner)}</div>`;
  };
  return html`<div class="trace ${compact ? 'trace--compact' : ''}"><div class="trace__t">${title}</div><div class="trace__g">${raw(items.map(cell).join(''))}</div></div>`;
}
