/* Status / result badges — one colour language for every domain (batch7 B2): the tone of a status code comes from
 * constants.js TAG_TONE only — done 초록 · active 파랑 · draft 노랑 · hold 보라 회색 · bad 빨강 · muted 회색 (tokens --tag-*-fg/bg/bd). */
import { html } from '../core/dom.js';
import { ACC_STATUS, CR_STATUS, ISSUE_STATUS, REQ_SCOPE, REQ_STATUS, RESULT, RISK_LEVEL, RISK_STATUS, SEVERITY, TAG_TONE, TC_PRIORITY, TC_STATUS, VERIFY, WBS_CSTATUS } from './constants.js';

const TAG_LABEL = { req: REQ_STATUS, scope: REQ_SCOPE, wbs: WBS_CSTATUS, test: RESULT, tc: TC_STATUS, verify: VERIFY, cr: CR_STATUS, issue: ISSUE_STATUS, risk: RISK_STATUS, acc: ACC_STATUS };
/** Tone of a status code: 'done' | 'active' | 'draft' | 'hold' | 'bad' | 'muted' ('' when unknown). */
export const tagTone = (kind, code) => (TAG_TONE[kind] && TAG_TONE[kind][code]) || '';
/** `<span class="tag tag--done" data-tone="done">확정</span>` — kind: req | scope | wbs | test | tc | verify | cr | issue | risk | acc. */
export const tag = (kind, code, label = null) => { const t = tagTone(kind, code) || 'muted'; return html`<span class="tag tag--${t}" data-tone="${t}">${label || (TAG_LABEL[kind] && TAG_LABEL[kind][code]) || code || '-'}</span>`; };
/** Priority: text + arrow, no border (so it never reads as a status chip). 높음 ▲ 빨강 · 보통 – 회색 · 낮음 ▼ 파랑 · 미지정 '-'. */
const PRIO_MARK = { CRITICAL: '▲', HIGH: '▲', MEDIUM: '–', LOW: '▼' };
export const prio = (code, map = TC_PRIORITY) => (code && code !== 'UNSPECIFIED' && PRIO_MARK[code]
  ? html`<span class="prio prio--${String(code).toLowerCase()}"><i aria-hidden="true">${PRIO_MARK[code]}</i>${map[code] || code}</span>` : html`<span class="dim">-</span>`);

/** Generic chip. tone: '' | chip--active | chip--done | chip--hold | chip--fail | chip--muted */
export const chip = (label, tone = '') => html`<span class="chip ${tone}">${label}</span>`;
/** Status badge from a label map + tone map (the only thing that should be a colored badge in a table row). */
export const statusChip = (labels, tones, v) => chip(labels[v] || v, tones[v] || '');
/** Severity / risk level: dot + text, never a filled badge. */
export const sevBadge = (v) => html`<span class="sev sev--${String(v || 'MEDIUM').toLowerCase()}">${SEVERITY[v] || RISK_LEVEL[v] || v}</span>`;
/** Test result pill. */
export const resBadge = (v) => html`<span class="res res--${(v || 'NOT_RUN').toLowerCase()} tag--${tagTone('test', v || 'NOT_RUN')}">${RESULT[v] || RESULT.NOT_RUN}</span>`;
/** Requirement verification status (UNLINKED / IN_PROGRESS / VERIFIED / FAILED). */
export const verifyChip = (v) => html`<span class="chip tag--${tagTone('verify', v) || 'muted'}">${VERIFY[v] || v}</span>`;
/** Priority is text with an arrow, not a badge — kept for older call sites; the same as prio(). */
export const prText = (v, labels = TC_PRIORITY) => prio(v, labels);
/** Kept for compatibility with older call sites — now the same text treatment. */
export const prBadge = (v) => prText(v);
/** Subtle secondary label (scope, type). */
export const subtle = (label) => html`<span class="lbl-sub">${label}</span>`;
