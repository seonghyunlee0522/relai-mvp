/* 담당자 picker (Phase 3 US-1), shared by WBS and Issue (Phase 4 US-6): RELAI 사용자 or 팀원 (계정 없음) — 01 이해관계자 중 당사·협력사.
 * One select value for both kinds: '' (미지정) · 'u:<user id>' · 's:<stakeholder id>'; the server keeps exactly one of
 * owner_user_id / owner_stakeholder_id. `owners` = the API's { team: [{ id, name, role }], stakeholders_total }. */
import { html, raw } from '../core/dom.js';

export const ownerKey = (it) => (it.owner_user_id ? `u:${it.owner_user_id}` : it.owner_stakeholder_id ? `s:${it.owner_stakeholder_id}` : '');
/** K13: 팀원 (계정 없음) minus a stakeholder who is also a workspace member (flag `member`), unless THIS item already has them (`cur`). */
export const teamFor = (team, cur = '') => (team || []).filter((t) => !t.member || `s:${t.id}` === cur);
const teamLabel = (t) => (t.role ? `${t.name} · ${t.role}` : t.name);
/** 미지정 · <optgroup RELAI 사용자> · <optgroup 팀원 (계정 없음)>. A deleted stakeholder still shows as the current value. short: name only (grid cells). */
export function ownerChoices(members, owners, cur = '', short = false) {
  const team = teamFor(owners.team, cur).map((t) => [`s:${t.id}`, short ? t.name : teamLabel(t)]);
  if (/^s:/.test(cur) && !team.some(([v]) => v === cur)) team.push([cur, '(삭제된 담당자)']);
  return [['', '미지정'], { group: 'RELAI 사용자', options: members.map((m) => [`u:${m.id}`, m.name]) }, { group: '팀원 (계정 없음)', options: team }];
}
export const ownerOptions = (members, owners, cur) => ownerChoices(members, owners, cur).map((o) => (Array.isArray(o) ? html`<option value="${o[0]}" ${cur === o[0] ? 'selected' : ''}>${o[1]}</option>`
  : o.options.length ? html`<optgroup label="${o.group}">${raw(o.options.map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''))}</optgroup>` : '')).join('');
/** `계정 없음` — grey text tag, not a badge. */
export const noAcct = (it) => (it.owner_no_account ? html`<small class="wnoacct">계정 없음</small>` : '');
/** Only the PM (or nobody) registered in 01 → one line under the picker pointing at 이해관계자 추가. */
export const teamHint = (owners, pid, archived) => ((owners.stakeholders_total || 0) <= 1 && !archived ? html`<p class="whint">팀원을 01 착수 › 이해관계자에 추가하면 계정 없이 담당자로 지정할 수 있습니다. <a class="link" href="/app/projects/${pid}/definition?activity=STAKEHOLDERS" data-link>이해관계자 추가 →</a></p>` : '');
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
