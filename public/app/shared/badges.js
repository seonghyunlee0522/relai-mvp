/* Status / result badges — one color language for every domain (D-1):
 *  blue = active/current · green = done/pass/accepted · orange = pending/review/attention · red = fail/critical/blocked · gray = draft/none */
import { html } from '../core/dom.js';
import { RESULT, RISK_LEVEL, SEVERITY, TC_PRIORITY, VERIFY, VERIFY_CHIP } from './constants.js';

/** Generic chip. tone: '' | chip--active | chip--done | chip--hold | chip--fail | chip--muted */
export const chip = (label, tone = '') => html`<span class="chip ${tone}">${label}</span>`;
/** Status badge from a label map + tone map (the only thing that should be a colored badge in a table row). */
export const statusChip = (labels, tones, v) => chip(labels[v] || v, tones[v] || '');
/** Severity / risk level: dot + text, never a filled badge. */
export const sevBadge = (v) => html`<span class="sev sev--${String(v || 'MEDIUM').toLowerCase()}">${SEVERITY[v] || RISK_LEVEL[v] || v}</span>`;
/** Test result pill. */
export const resBadge = (v) => html`<span class="res res--${(v || 'NOT_RUN').toLowerCase()}">${RESULT[v] || RESULT.NOT_RUN}</span>`;
/** Requirement verification status (UNLINKED / IN_PROGRESS / VERIFIED / FAILED). */
export const verifyChip = (v) => html`<span class="chip ${VERIFY_CHIP[v] || ''}">${VERIFY[v] || v}</span>`;
/** Priority is text with weight, not a badge (P). */
export const prText = (v, labels = TC_PRIORITY) => (v ? html`<span class="prio prio--${String(v).toLowerCase()}">${labels[v] || v}</span>` : html`<span class="dim">-</span>`);
/** Kept for compatibility with older call sites — now the same text treatment. */
export const prBadge = (v) => prText(v);
/** Subtle secondary label (scope, type). */
export const subtle = (label) => html`<span class="lbl-sub">${label}</span>`;
