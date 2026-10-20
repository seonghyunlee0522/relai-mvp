/**
 * Shared pieces of the customer documents RELAI exports (01 사업수행계획서 · 02 요구사항 정의서 …): markdown tables, text blocks,
 * the 표지 key/value table, the auto 개정 이력 row and the 승인란. The markdown subset is rendered by report-export.js (PDF / Word).
 *
 * Version rule shared by every approved document (no document versioning yet):
 *   승인 전   v0.9 (초안)   footer "승인 전 초안"   개정 이력: v0.9 · 오늘 · 초안
 *   승인됨    v1.0                                   개정 이력: v1.0 · 승인일 · 승인
 */
export const NONE = '작성되지 않음';

/** Table cell: escape pipes, keep line breaks as <br>. null = a deliberately blank cell (서명 칸); '' = "-". */
export const cellText = (v) => (v === null ? '' : String(v ?? '').trim().replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') || '-');
export const row = (cells) => `| ${cells.map(cellText).join(' | ')} |`;
export const table = (header, rows) => [row(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(row)].join('\n');
/** 항목 | 내용 table; an empty value prints NONE so the structure never changes. */
export const kv = (pairs) => table(['항목', '내용'], pairs.map(([k, val]) => [k, val || NONE]));
/** Free text → bullets when it has several lines, a paragraph otherwise; NONE when empty. */
export const textBlock = (text, empty = NONE) => {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return empty;
  return lines.length === 1 ? lines[0] : lines.map((l) => `- ${l}`).join('\n');
};

/** v0.9 초안 / v1.0 for an approval status (TODO · COMPLETED). */
export function docVersion(status) {
  if (status === 'COMPLETED') return { version: 'v1.0', file: 'v1.0', footer: '' };
  return { version: 'v0.9 (초안)', file: 'v0.9', footer: '승인 전 초안' };
}
/** 표지: title, project name in bold, key/value table, the draft notice when not approved, then a page break. */
export function coverLines(title, name, pairs, footer) {
  const L = [`# ${title}`, '', `**${name}**`, '', kv(pairs)];
  // K2: a changed approved document is waiting for 재승인, not a first 승인
  if (footer) L.push('', `**${footer}** — ${/승인 후 변경/.test(footer) ? '재승인 전까지는' : '고객 승인 전에는'} 내용이 바뀔 수 있습니다.`);
  L.push('', '<!-- pagebreak -->');
  return L;
}
/** The one auto 개정 이력 row matching the document state (approved on its 승인일, otherwise today's draft). */
export const revisionRows = (status, { today, approvedOn, author }) => (status === 'TODO' ? [['v0.9', today, '초안', author]] : [['v1.0', approvedOn || today, '승인', author]]);
export const revisionTable = (rows) => table(['버전', '일자', '내용', '작성자'], rows);

/**
 * 승인란: 고객사 approver (name/title, date once approved) and 수행사 PM; 서명 칸 always blank.
 * a = { status, date, approver: { name, title }, method_label, evidence, conditions, bypass }.
 */
export function approvalLines(a, { stakeholders = [], author = '' } = {}) {
  const who = a.approver; const done = a.status === 'COMPLETED' || a.status === 'REAPPROVAL';
  const pm = stakeholders.find((s) => s.category === 'OWN' && /PM|PL|책임/i.test(s.role || '')) || stakeholders.find((s) => s.category === 'OWN');
  const L = [table(['구분', '성명', '직위', '서명', '일자'], [
    ['고객사', who ? who.name : null, who ? who.title : null, null, done ? a.date : null],
    ['수행사', pm ? pm.name : author, pm ? pm.role : 'PM', null, null],
  ])];
  if (done) L.push('', `승인 방법: ${a.method_label || '-'} · 근거: ${a.evidence || '-'}`);
  if (a.status === 'REAPPROVAL') L.push('', '**승인 후 목표·범위·일정이 바뀌었습니다. 바뀐 내용을 고객에게 다시 확인받으세요.**');
  if (a.conditions) L.push('', '**조건 / 보완 요청**', textBlock(a.conditions));
  // 01 착수 승인 is 권장 since batch7 #5: the gate writes the fixed reason '승인 없이 진행' instead of asking one
  if (!done && a.bypass) L.push('', `**미승인 — ${a.bypass.reason === '승인 없이 진행' ? '승인 없이 진행' : `사유: ${a.bypass.reason}`}** (${[a.bypass.date, a.bypass.name].filter(Boolean).join(' · ')})`);
  return L;
}
