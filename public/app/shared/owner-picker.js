/* 담당자 picker (Phase 3 US-1 → batch7 #11), shared by 요구사항 · WBS · 이슈·리스크: RELAI 사용자 or a 01 관계자 (계정 없음).
 * One select value for both kinds: '' (미지정) · 'u:<user id>' · 's:<stakeholder id>'; the server keeps exactly one of
 * owner_user_id / owner_stakeholder_id. `owners` = the API's { team: [{ id, name, role }], stakeholders_total }. */
import { html, raw } from '../core/dom.js';
import { definitionHref } from './lifecycle.js';

export const ownerKey = (it) => (it.owner_user_id ? `u:${it.owner_user_id}` : it.owner_stakeholder_id ? `s:${it.owner_stakeholder_id}` : '');
/** K13: 팀원 (계정 없음) minus a stakeholder who is also a workspace member (flag `member`), unless THIS item already has them (`cur`). */
export const teamFor = (team, cur = '') => (team || []).filter((t) => !t.member || `s:${t.id}` === cur);
const teamLabel = (t) => (t.role ? `${t.name} · ${t.role}` : t.name);
/* ---- batch7 #11: one 담당자 picker for 요구사항 · WBS · 이슈·리스크 — 조직·부서 first, then the person ----
 * Groups: '우리 팀' = workspace members + 당사 관계자 (계정 없음), then one group per "조직 · 부서" of the other 01 관계자, in 01 order.
 * Who is offered: `team` (당사·협력사 — WBS, 이슈, Phase 3 rule) by default; `{ all: true }` = `owners.directory`, every named 01 관계자 (요구사항, #11). */
const ORG = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
export const OUR_TEAM = '우리 팀';
const groupLabel = (t) => [t.org || ORG[t.org_type] || '기타', t.department].filter(Boolean).join(' · ');
export function ownerGroups(members, owners, cur = '', short = false, { all = false } = {}) {
  const o = owners || {};
  const dir = ((all && o.directory) || o.team || []).filter((t) => !t.member || `s:${t.id}` === cur);   // K13
  const lab = (t) => (short ? t.name : teamLabel(t));
  const groups = [{ label: OUR_TEAM, options: [...(members || []).map((m) => [`u:${m.id}`, m.name]), ...dir.filter((t) => t.org_type === 'OWN').map((t) => [`s:${t.id}`, lab(t)])] }];
  for (const t of dir.filter((x) => x.org_type !== 'OWN')) {
    const label = groupLabel(t); let g = groups.find((x) => x.label === label);
    if (!g) groups.push(g = { label, options: [] });
    g.options.push([`s:${t.id}`, lab(t)]);
  }
  if (/^s:/.test(cur) && !groups.some((g) => g.options.some(([v]) => v === cur))) groups[0].options.push([cur, '(삭제된 담당자)']);
  return groups.filter((g, i) => i === 0 || g.options.length);
}
/** 미지정 · <optgroup 우리 팀> · <optgroup "조직 · 부서">… (grid cells and plain selects). A deleted stakeholder still shows as the current value. short: name only. */
export function ownerChoices(members, owners, cur = '', short = false, opts = {}) {
  return [['', '미지정'], ...ownerGroups(members, owners, cur, short, opts).map((g) => ({ group: g.label, options: g.options }))];
}
export const ownerOptions = (members, owners, cur, opts = {}) => ownerChoices(members, owners, cur, false, opts).map((o) => (Array.isArray(o) ? html`<option value="${o[0]}" ${cur === o[0] ? 'selected' : ''}>${o[1]}</option>`
  : o.options.length ? html`<optgroup label="${o.group}">${raw(o.options.map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''))}</optgroup>` : '')).join('');
/** Display text of an owner value in the same words the picker uses ('' → 미지정). */
export const ownerText = (members, owners, v, opts = {}) => { if (!v) return '미지정'; for (const g of ownerGroups(members, owners, v, false, opts)) { const hit = g.options.find(([x]) => x === v); if (hit) return hit[1]; } return v; };

export const BULK_NONE = '__none';
const personOpts = (groups, gi, cur, q = '', bulk = false) => {
  const needle = q.trim().toLowerCase();
  const pool = needle ? groups.flatMap((g) => g.options.filter(([, l]) => l.toLowerCase().includes(needle)).map(([v, l]) => [v, `${l} (${g.label})`])) : (groups[gi] || groups[0]).options;
  const inPool = pool.some(([v]) => v === cur);
  const head = bulk ? [html`<option value="" disabled ${cur && inPool ? '' : 'selected'}>사람 선택</option>`, html`<option value="${BULK_NONE}" ${cur === BULK_NONE ? 'selected' : ''}>미지정 (담당자 해제)</option>`]
    : [html`<option value="">미지정</option>`, ...(cur && !inPool ? [html`<option value="${cur}" selected hidden>사람 선택…</option>`] : [])];
  return [...head,
    ...pool.map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`)].join('');
};
/**
 * Two-step picker: [조직·부서 ▾] [사람 ▾] + 이름 검색. The person <select> carries `attrs` (data-field="owner" / name="owner" / data-bv),
 * so every existing change / form handler keeps working — choosing a group only refills the person list (no save until a person is picked).
 * Behaviour is wired once for the whole document (delegated listeners below), so a page only renders this string.
 */
export function ownerPicker(members, owners, cur = '', { attrs = '', disabled = false, label = '담당자', search = true, all = false, bulk = false } = {}) {   // bulk: 사람 선택 placeholder + 미지정 (담당자 해제) = BULK_NONE
  const groups = ownerGroups(members, owners, cur, false, { all });
  const gi = Math.max(0, groups.findIndex((g) => g.options.some(([v]) => v === cur)));
  const dis = disabled ? 'disabled' : '';
  return html`<span class="opick" data-opick="${JSON.stringify({ groups, cur, bulk })}" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0">
    <select class="select select--sm opick__g" style="flex:1 1 150px;min-width:0" data-opick-g aria-label="${label} 조직·부서" ${dis}>${raw(groups.map((g, i) => html`<option value="${i}" ${i === gi ? 'selected' : ''}>${g.label} (${g.options.length})</option>`).join(''))}</select>
    <select class="select select--sm opick__p" style="flex:1 1 150px;min-width:0" ${raw(attrs)} aria-label="${label}" ${dis}>${raw(personOpts(groups, gi, cur, '', bulk))}</select>
    ${raw(search && !disabled ? html`<input class="input input--sm opick__q" style="flex:1 1 100%;min-width:0" type="search" data-opick-q placeholder="이름 검색" aria-label="${label} 이름 검색">` : '')}</span>`;
}
if (typeof document !== 'undefined' && !globalThis.__relaiOpick) {
  globalThis.__relaiOpick = true;
  const refill = (wrap, q) => {
    let d; try { d = JSON.parse(wrap.dataset.opick); } catch { return; }
    const p = wrap.querySelector('.opick__p'); const g = wrap.querySelector('[data-opick-g]');
    p.innerHTML = personOpts(d.groups, Number(g.value) || 0, p.value || d.cur, q, d.bulk);
    if (d.bulk) p.dispatchEvent(new Event('change', { bubbles: true }));   // the bulk bar re-checks 일괄 변경 (placeholder → disabled)
  };
  document.addEventListener('change', (e) => { const g = e.target.closest && e.target.closest('[data-opick-g]'); if (!g) return; e.stopPropagation(); const w = g.closest('[data-opick]'); const q = w.querySelector('[data-opick-q]'); if (q) q.value = ''; refill(w, ''); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-opick-q]')) { e.preventDefault(); e.stopPropagation(); const p = e.target.closest('[data-opick]').querySelector('.opick__p'); if (p) p.focus(); } }, true);   // Enter in 이름 검색 never submits the form
  document.addEventListener('input', (e) => { const q = e.target.closest && e.target.closest('[data-opick-q]'); if (!q) return; e.stopPropagation(); refill(q.closest('[data-opick]'), q.value); }, true);
}
/** 관계자가 0명 → one line pointing at 01 관계자 (the picker then only offers 우리 팀). */
export const stakeholderHint = (owners, pid, archived) => (!(owners && owners.stakeholders_total) && !archived ? html`<p class="whint" data-sh-hint>고객사·협력사 담당자는 01 관계자에 먼저 등록하세요. <a class="link" href="${definitionHref(pid, 'STAKEHOLDERS')}" data-link>관계자 등록 →</a></p>` : '');
/** `계정 없음` — grey text tag, not a badge. */
export const noAcct = (it) => (it.owner_no_account ? html`<small class="wnoacct">계정 없음</small>` : '');
/** Only the PM (or nobody) registered in 01 → one line under the picker pointing at 이해관계자 추가. */
export const teamHint = (owners, pid, archived) => ((owners.stakeholders_total || 0) <= 1 && !archived ? html`<p class="whint">팀원을 01 착수 › 관계자에 추가하면 계정 없이 담당자로 지정할 수 있습니다. <a class="link" href="${definitionHref(pid, 'STAKEHOLDERS')}" data-link>관계자 추가 →</a></p>` : '');
/** 수행자 picker (Phase 5 US-4): the same picker plus 고객사 이해관계자, no 미지정 — groups RELAI 사용자 / 팀원 (계정 없음) / 고객사.
 * `performers` = the API's { team, clients }. Values 'u:<user id>' · 's:<stakeholder id>'. */
export function performerChoices(members, performers, cur = '') {
  const p = performers || {}; const lab = (t) => (t.role ? `${t.name} · ${t.role}` : t.name);
  return [{ group: 'RELAI 사용자', options: members.map((m) => [`u:${m.id}`, m.name]) }, { group: '팀원 (계정 없음)', options: teamFor(p.team, cur).map((t) => [`s:${t.id}`, lab(t)]) },
    { group: '고객사', options: (p.clients || []).map((t) => [`s:${t.id}`, `${lab(t)}${t.org ? ` (${t.org})` : ''}`]) }];
}
export const performerOptions = (members, performers, cur) => performerChoices(members, performers, cur).map((o) => (o.options.length
  ? html`<optgroup label="${o.group}">${raw(o.options.map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''))}</optgroup>` : '')).join('');
/** "{execution body} → { performer_user_id | performer_stakeholder_id }" from one picker value. */
export const performerBody = (v) => (/^s:/.test(v || '') ? { performer_stakeholder_id: v.slice(2) } : /^u:/.test(v || '') ? { performer_user_id: v.slice(2) } : {});
/** 내부 처리자 not chosen → the OWNER/ADMIN members decide: name them, not the role alone (demo finding: the select read '소유자·관리자'). */
export const approverDefault = (members) => { const names = (members || []).filter((m) => m.role === 'OWNER' || m.role === 'ADMIN').map((m) => m.name).filter(Boolean); return names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}명` : ''} (소유자·관리자)` : '소유자·관리자'; };
