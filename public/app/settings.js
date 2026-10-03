import { api, resetMembers } from './core/api.js';
import { $, fmtShort, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { confirmDialog, toast } from './shared/dialogs.js';
import { relTime } from './shared/jira.js';
import { formDialog, inviteStatusChip, emailStatusChip } from './shared/forms.js';

const ROLE = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
const ROLE_DESC = { OWNER: '모든 기능 · 멤버/설정/결제 관리', ADMIN: '프로젝트 생성·관리 · 멤버/설정 관리 (결제 불가)', MEMBER: '프로젝트 업무 수행 (멤버/설정/결제 불가)' };

export async function settingsPage(main = $('#main')) {
  document.title = 'Settings — RELAI';
  const wid = state.workspace.id;
  let integ; const [{ workspace }, { members }, integ0] = await Promise.all([api('GET', `/api/workspaces/${wid}`), api('GET', `/api/workspaces/${wid}/members`), api('GET', `/api/workspaces/${wid}/integrations`).catch(() => null)]);
  integ = integ0; const perm = workspace.permissions; const me = state.user.id;
  // Pending invitations (OWNER/ADMIN only) — Phase 13
  let invites = []; const loadInvites = async () => { if (!perm.member_manage) return; try { invites = (await api('GET', `/api/workspaces/${wid}/invitations`)).all.filter((i) => i.status === 'PENDING' || i.status === 'EXPIRED').slice(0, 50); } catch { invites = []; } };
  await loadInvites();
  const inviteTable = () => !perm.member_manage ? '' : html`<div class="panel" style="margin-top:20px"><div class="panel__h">초대 대기 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${invites.filter((i) => i.status === 'PENDING').length}</em><span class="panel__sp"></span><button class="btn btn--primary btn--sm" id="invite-btn">멤버 초대</button></div>
      <div class="rtable-wrap--in"><table class="rtable rtable--raid" style="margin:0" id="invtbl"><thead><tr><th>이메일</th><th>역할</th><th>초대한 사람</th><th>만료</th><th>상태</th><th>메일</th><th></th></tr></thead>
      <tbody>${raw(invites.length ? invites.map((i) => html`<tr data-inv="${i.id}">
        <td class="mono">${i.email}</td><td>${ROLE[i.role] || i.role}</td><td class="dim">${i.invited_by_name || '-'}</td><td class="dim">${fmtShort(i.expires_at)}</td><td>${raw(inviteStatusChip(i.status))}</td>
        <td>${raw(emailStatusChip(i.last_email_status))}${raw(i.last_email_status === 'FAILED' ? html` <small class="dim">${i.last_email_error || ''}</small>` : '')}</td>
        <td style="white-space:nowrap">${raw(i.role === 'ADMIN' && workspace.role !== 'OWNER' ? '' : html`<button class="link linkbtn" data-resend="${i.id}" style="width:auto">${i.last_email_status === 'FAILED' ? '다시 보내기' : '재발송'}</button> `)}${raw(i.status === 'PENDING' ? html`<button class="link linkbtn" data-revoke="${i.id}" style="width:auto;color:#B42318">취소</button>` : '')}</td></tr>`).join('')
        : '<tr><td colspan="7" class="dim" style="text-align:center;padding:18px">대기 중인 초대가 없습니다. 아직 가입하지 않은 동료는 [멤버 초대]로 메일을 보내 초대할 수 있습니다.</td></tr>')}</tbody></table></div></div>`;
  // OAuth callback lands here with ?jira=ok|error
  const qp = new URLSearchParams(location.search);
  if (qp.get('jira')) { toast(qp.get('jira') === 'ok' ? 'Jira를 연결했습니다.' : `Jira 연결에 실패했습니다. (${qp.get('reason') || 'oauth_error'})`); history.replaceState(null, '', '/app/settings'); }
  const jiraCard = () => {
    const pv = integ && integ.providers.find((x) => x.provider === 'JIRA'); if (!pv) return '';
    const c = pv.connection; const can = perm.integration_manage;
    const status = !c ? '' : c.status === 'ACTIVE' ? '<span class="chip chip--done">정상</span>' : c.status === 'ERROR' ? html`<span class="chip chip--fail">${c.reconnect_required ? '재연결 필요' : '오류'}</span>` : c.status === 'DISABLED' ? '<span class="chip chip--muted">연결 해제됨</span>' : '<span class="chip chip--hold">대기</span>';
    return html`<div class="panel" style="margin-top:20px"><div class="panel__h">Integrations</div><div class="panel__b">
      <div class="icard"><div class="icard__logo">J</div><div class="icard__m">
        <div class="icard__t"><b>Jira</b>${raw(c && c.status !== 'DISABLED' ? '<span class="chip chip--active">연결됨</span>' : '<span class="chip chip--muted">미연결</span>')}${raw(!pv.configured ? '<span class="chip chip--hold">서버 설정 필요</span>' : '')}</div>
        ${raw(c && c.status !== 'DISABLED' ? html`<div class="icard__site"><a href="${c.site_url}" target="_blank" rel="noopener noreferrer">${(c.site_url || '').replace(/^https?:\/\//, '')}</a></div>
          <dl class="icard__d"><dt>상태</dt><dd>${raw(status)}${raw(c.last_error ? html` <small class="dim">${c.last_error}</small>` : '')}</dd><dt>연결자</dt><dd>${c.connected_by_name || '-'}${raw(c.external_account_name ? html` <small class="dim">(Jira: ${c.external_account_name})</small>` : '')}</dd><dt>마지막 동기화</dt><dd>${c.last_synced_at ? relTime(c.last_synced_at) : '아직 없음'}</dd><dt>연결된 프로젝트</dt><dd>${c.mapped_projects}개</dd></dl>`
          : html`<p class="hint">Jira Cloud 사이트를 연결하면 각 프로젝트의 ⋯ 메뉴 → Jira 연동 설정에서 Jira 프로젝트를 매핑하고, WBS Leaf 작업에 Jira Issue를 연결해 실행 상태를 볼 수 있습니다. ${pv.configured ? '' : '운영자가 서버에 Atlassian 앱 정보를 설정하면 연결할 수 있습니다.'}</p>`)}
        ${raw(can ? html`<div class="actions" style="margin-top:10px">${raw(c && c.status !== 'DISABLED' ? html`<button class="btn btn--secondary btn--sm" id="jira-reconnect" ${pv.configured ? '' : 'disabled'}>재연결</button><button class="btn btn--ghost btn--sm is-danger" id="jira-disconnect">연결 해제</button>` : html`<button class="btn btn--primary btn--sm" id="jira-connect" ${pv.configured ? '' : 'disabled'}>Jira 연결</button>`)}</div>` : '<p class="hint">연결 설정은 Workspace OWNER/ADMIN만 할 수 있습니다.</p>')}
      </div></div></div></div>`;
  };
  const draw = (members) => {
    resetMembers();
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
    </div>${raw(inviteTable())}${raw(jiraCard())}</div>`;
    const ib = $('#invite-btn'); if (ib) ib.onclick = async () => {
      const roles = [['MEMBER', 'Member — 프로젝트 업무 수행']]; if (workspace.role === 'OWNER') roles.push(['ADMIN', 'Admin — 프로젝트·멤버·설정 관리']);
      const r = await formDialog({ title: '멤버 초대', body: html`초대 메일을 보냅니다. 초대받은 사람은 같은 이메일로 가입하거나 로그인한 뒤 수락하면 <b>${workspace.name}</b> Workspace에 참여합니다. (유효기간 7일)`, confirm: '초대 메일 보내기',
        fields: [{ name: 'email', label: '이메일', type: 'email', required: true, placeholder: 'teammate@company.com' }, { name: 'role', label: '역할', type: 'select', options: roles, value: 'MEMBER' }],
        submit: (v) => api('POST', `/api/workspaces/${wid}/invitations`, { email: v.email.trim(), role: v.role }) });
      if (!r) return;
      toast(r.email_delivery?.status === 'FAILED' ? '초대는 생성되었지만 메일 발송에 실패했습니다. [다시 보내기]로 재시도하세요.' : `${r.invitation.email}에게 초대 메일을 보냈습니다.`);
      await loadInvites(); draw(members);
    };
    main.querySelectorAll('[data-resend]').forEach((b) => b.onclick = async () => { b.disabled = true; try { const r = await api('POST', `/api/workspaces/${wid}/invitations/${b.dataset.resend}/resend`, {}); toast(r.email_delivery?.status === 'FAILED' ? '메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.' : '초대 메일을 다시 보냈습니다.'); await loadInvites(); draw(members); } catch (err) { b.disabled = false; toast(err.message); } });
    main.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { const i = invites.find((x) => x.id === b.dataset.revoke); if (!(await confirmDialog({ title: `${i.email} 초대를 취소할까요?`, body: '이미 보낸 초대 링크는 더 이상 사용할 수 없습니다.', confirm: '초대 취소', danger: true }))) return; try { await api('DELETE', `/api/workspaces/${wid}/invitations/${i.id}`); toast('초대를 취소했습니다.'); await loadInvites(); draw(members); } catch (err) { toast(err.message); } });
    const connect = async () => { try { const r = await api('POST', `/api/workspaces/${wid}/integrations/jira/connect`, {}); location.href = r.url; } catch (e) { toast(e.message); } };
    const jc = $('#jira-connect'); if (jc) jc.onclick = connect;
    const jr = $('#jira-reconnect'); if (jr) jr.onclick = connect;
    const jd = $('#jira-disconnect'); if (jd) jd.onclick = async () => { if (!(await confirmDialog({ title: 'Jira 연결을 해제할까요?', body: '저장된 Jira 인증 정보가 삭제되고 모든 프로젝트의 동기화가 중단됩니다. 프로젝트·WBS·요구사항 데이터와 기존 Jira 연결 기록은 삭제되지 않습니다.', confirm: '연결 해제', danger: true }))) return; try { integ = await api('POST', `/api/workspaces/${wid}/integrations/jira/disconnect`, {}); toast('Jira 연결을 해제했습니다.'); draw(members); } catch (e) { toast(e.message); } };
    const wsf = $('#wsf'); if (wsf) wsf.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('PATCH', `/api/workspaces/${wid}`, { name: wsf.name.value.trim() }); state.workspace.name = r.workspace.name; toast('Workspace 이름을 저장했습니다.'); } catch (err) { toast(err.fields?.name || err.message); } };
    const addm = $('#addm'); if (addm) addm.onsubmit = async (e) => { e.preventDefault(); $('#adderr').textContent = ''; try { const r = await api('POST', `/api/workspaces/${wid}/members`, { email: addm.email.value, role: addm.role.value }); toast('멤버를 추가했습니다.'); draw(r.members); } catch (err) { $('#adderr').textContent = err.message; } };
    main.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => { try { const r = await api('PATCH', `/api/workspaces/${wid}/members/${sel.dataset.role}`, { role: sel.value }); toast('역할을 변경했습니다.'); draw(r.members); } catch (err) { toast(err.message); draw(members); } });
    main.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => { const m = members.find((x) => x.id === b.dataset.remove); if (!(await confirmDialog({ title: `${m.name}님을 Workspace에서 제거할까요?`, body: '제거된 멤버는 이 Workspace의 프로젝트에 접근할 수 없습니다. 이미 작성한 데이터는 유지됩니다.', confirm: '제거', danger: true }))) return; try { const r = await api('DELETE', `/api/workspaces/${wid}/members/${m.id}`); toast('멤버를 제거했습니다.'); draw(r.members); } catch (err) { toast(err.message); } });
  };
  draw(members);
}
