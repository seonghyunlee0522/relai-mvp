import { api } from './core/api.js';
import { $, fmtShort, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { confirmDialog, toast } from './shared/dialogs.js';

const ROLE = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
const ROLE_DESC = { OWNER: '모든 기능 · 멤버/설정/결제 관리', ADMIN: '프로젝트 생성·관리 · 멤버/설정 관리 (결제 불가)', MEMBER: '프로젝트 업무 수행 (멤버/설정/결제 불가)' };

export async function settingsPage(main = $('#main')) {
  document.title = 'Settings — RELAI';
  const wid = state.workspace.id;
  const [{ workspace }, { members }] = await Promise.all([api('GET', `/api/workspaces/${wid}`), api('GET', `/api/workspaces/${wid}/members`)]);
  const perm = workspace.permissions; const me = state.user.id;
  const draw = (members) => {
    main.innerHTML = html`<div class="page page--narrow"><div class="page__head"><h1>Settings</h1></div>
    <div class="panel"><div class="panel__h">프로필</div><div class="panel__b"><dl class="info">
      <dt>이름</dt><dd>${state.user.name}</dd><dt>이메일</dt><dd>${state.user.email}</dd></dl></div></div>
    <div class="panel" style="margin-top:20px"><div class="panel__h">Workspace</div><div class="panel__b"><dl class="info">
      <dt>이름</dt><dd>${raw(perm.workspace_settings ? html`<form id="wsf" class="inline-form"><input class="input input--sm" name="name" value="${workspace.name}" maxlength="100" style="max-width:280px"> <button class="btn btn--secondary btn--sm">저장</button></form>` : html`${workspace.name}`)}</dd>
      <dt>내 역할</dt><dd>${ROLE[workspace.role]} <small class="dim">— ${ROLE_DESC[workspace.role]}</small></dd></dl></div></div>
    <div class="panel" style="margin-top:20px"><div class="panel__h">멤버 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${members.length}</em></div>
      <div class="rtable-wrap--in"><table class="rtable rtable--raid" style="margin:0"><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>참여</th>${raw(perm.member_manage ? '<th></th>' : '')}</tr></thead>
      <tbody>${raw(members.map((m) => html`<tr>
        <td>${m.name}${raw(m.id === me ? ' <small class="dim">(나)</small>' : '')}</td><td class="dim">${m.email}</td>
        <td>${raw(perm.member_manage ? html`<select class="select select--sm" data-role="${m.id}">${raw(Object.entries(ROLE).map(([k, l]) => html`<option value="${k}" ${m.role === k ? 'selected' : ''} ${k === 'OWNER' && !perm.owner_grant ? 'disabled' : ''}>${l}</option>`).join(''))}</select>` : ROLE[m.role])}</td>
        <td class="dim">${fmtShort(m.created_at)}</td>
        ${raw(perm.member_manage ? html`<td><button class="link linkbtn" data-remove="${m.id}" style="width:auto;color:#B42318">제거</button></td>` : '')}</tr>`).join(''))}</tbody></table></div>
      ${raw(perm.member_manage ? html`<form id="addm" class="crit-add" style="padding:12px 20px;border-top:1px solid var(--border-soft)"><input class="input input--sm" name="email" type="email" placeholder="가입된 사용자 이메일" required style="flex:1"><select class="select select--sm" name="role"><option value="MEMBER">Member</option><option value="ADMIN">Admin</option>${raw(perm.owner_grant ? '<option value="OWNER">Owner</option>' : '')}</select><button class="btn btn--secondary btn--sm">멤버 추가</button></form><div class="err" id="adderr" style="padding:0 20px 12px"></div>` : '')}
    </div></div>`;
    const wsf = $('#wsf'); if (wsf) wsf.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('PATCH', `/api/workspaces/${wid}`, { name: wsf.name.value.trim() }); state.workspace.name = r.workspace.name; toast('Workspace 이름을 저장했습니다.'); } catch (err) { toast(err.fields?.name || err.message); } };
    const addm = $('#addm'); if (addm) addm.onsubmit = async (e) => { e.preventDefault(); $('#adderr').textContent = ''; try { const r = await api('POST', `/api/workspaces/${wid}/members`, { email: addm.email.value, role: addm.role.value }); toast('멤버를 추가했습니다.'); draw(r.members); } catch (err) { $('#adderr').textContent = err.message; } };
    main.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => { try { const r = await api('PATCH', `/api/workspaces/${wid}/members/${sel.dataset.role}`, { role: sel.value }); toast('역할을 변경했습니다.'); draw(r.members); } catch (err) { toast(err.message); draw(members); } });
    main.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => { const m = members.find((x) => x.id === b.dataset.remove); if (!(await confirmDialog({ title: `${m.name}님을 Workspace에서 제거할까요?`, body: '제거된 멤버는 이 Workspace의 프로젝트에 접근할 수 없습니다. 이미 작성한 데이터는 유지됩니다.', confirm: '제거', danger: true }))) return; try { const r = await api('DELETE', `/api/workspaces/${wid}/members/${m.id}`); toast('멤버를 제거했습니다.'); draw(r.members); } catch (err) { toast(err.message); } });
  };
  draw(members);
}
