/* 담당자 picker (Phase 3 US-1), shared by WBS and Issue (Phase 4 US-6): RELAI 사용자 or 팀원 (계정 없음) — 01 이해관계자 중 당사·협력사.
 * One select value for both kinds: '' (미지정) · 'u:<user id>' · 's:<stakeholder id>'; the server keeps exactly one of
 * owner_user_id / owner_stakeholder_id. `owners` = the API's { team: [{ id, name, role }], stakeholders_total }. */
import { html, raw } from '../core/dom.js';

export const ownerKey = (it) => (it.owner_user_id ? `u:${it.owner_user_id}` : it.owner_stakeholder_id ? `s:${it.owner_stakeholder_id}` : '');
const teamLabel = (t) => (t.role ? `${t.name} · ${t.role}` : t.name);
/** 미지정 · <optgroup RELAI 사용자> · <optgroup 팀원 (계정 없음)>. A deleted stakeholder still shows as the current value. short: name only (grid cells). */
export function ownerChoices(members, owners, cur = '', short = false) {
  const team = (owners.team || []).map((t) => [`s:${t.id}`, short ? t.name : teamLabel(t)]);
  if (/^s:/.test(cur) && !team.some(([v]) => v === cur)) team.push([cur, '(삭제된 담당자)']);
  return [['', '미지정'], { group: 'RELAI 사용자', options: members.map((m) => [`u:${m.id}`, m.name]) }, { group: '팀원 (계정 없음)', options: team }];
}
export const ownerOptions = (members, owners, cur) => ownerChoices(members, owners, cur).map((o) => (Array.isArray(o) ? html`<option value="${o[0]}" ${cur === o[0] ? 'selected' : ''}>${o[1]}</option>`
  : o.options.length ? html`<optgroup label="${o.group}">${raw(o.options.map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join(''))}</optgroup>` : '')).join('');
/** `계정 없음` — grey text tag, not a badge. */
export const noAcct = (it) => (it.owner_no_account ? html`<small class="wnoacct">계정 없음</small>` : '');
/** Only the PM (or nobody) registered in 01 → one line under the picker pointing at 이해관계자 추가. */
export const teamHint = (owners, pid, archived) => ((owners.stakeholders_total || 0) <= 1 && !archived ? html`<p class="whint">팀원을 01 착수 › 이해관계자에 추가하면 계정 없이 담당자로 지정할 수 있습니다. <a class="link" href="/app/projects/${pid}/definition?activity=STAKEHOLDERS" data-link>이해관계자 추가 →</a></p>` : '');
