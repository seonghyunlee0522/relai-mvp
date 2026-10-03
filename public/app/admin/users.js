/* Users: registration management list (server-paged) + user detail with suspend / reactivate. No password surface exists here. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { promptDialog, toast } from '../shared/dialogs.js';
import { ACTIONS, adminApi, bindFilters, bindPager, bindRows, chip, dl, errorBlock, fmtD, fmtDay, head, kpis, n, pager, qs, rel, sel, section, table } from './ui.js';

const STATUS = { ACTIVE: '정상', SUSPENDED: '정지', DEACTIVATED: '탈퇴' };
const ROLE = { SYSTEM_ADMIN: 'System Admin', NONE: '일반' };
const LOGIN = { PASSWORD: 'Password', GOOGLE: 'Google', BOTH: 'Password + Google' };
const SINCE = { today: '오늘 가입', '7d': '최근 7일 가입', '30d': '최근 30일 가입' };
const sinceIso = (v) => { if (!v) return ''; const d = new Date(); if (v === 'today') d.setHours(0, 0, 0, 0); else d.setDate(d.getDate() - (v === '7d' ? 7 : 30)); return d.toISOString(); };

export async function adminUsersPage(main = $('#main')) {
  document.title = 'Users — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let data; try { data = await adminApi('users', { q: q.q, status: q.status, system_role: q.system_role, login_method: q.login_method, since: sinceIso(q.since), page: q.page, size: q.size, sort: q.sort }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">
      ${raw(head('Users', html`<span class="hint">회원가입 관리 — 가입·활성화 상태·정지 여부를 확인합니다.</span>`))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="이름 · 이메일 검색" value="${q.q || ''}">
        ${raw(sel('status', '상태', STATUS, q.status))}${raw(sel('login_method', '가입 방식', LOGIN, q.login_method))}${raw(sel('system_role', 'System Role', ROLE, q.system_role))}${raw(sel('since', '가입 시점', SINCE, q.since))}
        ${raw(sel('sort', '정렬: 가입일', { last_login: '정렬: 마지막 로그인', name: '정렬: 이름', email: '정렬: 이메일' }, q.sort))}
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'name', label: '이름', w: 150, cls: 'ttl', render: (r) => html`${r.name}${raw(r.id === state.user.id ? ' <small class="dim">(나)</small>' : '')}` },
        { key: 'email', label: '이메일', w: 220, render: (r) => html`<span class="mono">${r.email}</span>` },
        { key: 'status', label: '상태', w: 80, render: (r) => chip(r.status) },
        { key: 'login_method_label', label: '가입 방식', w: 140, render: (r) => html`${r.login_method_label || '-'}` },
        { key: 'activation', label: '활성화', w: 130, render: (r) => chip(r.activation) },
        { key: 'created_at', label: '가입일', w: 110, render: (r) => fmtDay(r.created_at) },
        { key: 'last_login_at', label: '마지막 로그인', w: 130, render: (r) => html`<span title="${fmtD(r.last_login_at)}">${rel(r.last_login_at)}</span>` },
        { key: 'workspace_count', label: 'Workspace', w: 90, cls: 'num', render: (r) => n(r.workspace_count) },
        { key: 'projects_created', label: 'Project 생성', w: 100, cls: 'num', render: (r) => n(r.projects_created) },
        { key: 'system_role', label: 'System Role', w: 120, render: (r) => (r.system_role === 'SYSTEM_ADMIN' ? chip('SYSTEM_ADMIN') : html`<span class="dim">-</span>`) },
      ], data.items, { rowHref: (r) => `/admin/users/${r.id}`, empty: '조건에 맞는 사용자가 없습니다.' }))}
      ${raw(pager(data))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

export async function adminUserPage(id, main = $('#main')) {
  const draw = async () => {
    const d = await adminApi(`users/${id}`);
    const u = d.user; const mine = u.id === state.user.id;
    document.title = `${u.name} — Users — RELAI Admin`;
    const actions = u.status === 'SUSPENDED' ? '<button class="btn btn--primary btn--sm" id="reactivate">정지 해제</button>'
      : u.status === 'ACTIVE' && !mine ? '<button class="btn btn--danger btn--sm" id="suspend">사용자 정지</button>' : '';
    main.innerHTML = html`<div class="apage">
      ${raw(head(u.name, actions, { href: '/admin/users', label: 'Users' }))}
      ${raw(u.status === 'SUSPENDED' ? html`<div class="anotice anotice--bad">정지된 계정입니다 (${fmtD(u.suspended_at)}). 로그인과 API 호출이 차단되며 데이터는 유지됩니다.</div>` : '')}
      ${raw(d.workspaces.some((w) => w.sole_owner && u.status !== 'ACTIVE') ? html`<div class="anotice anotice--warn">이 사용자는 ${d.workspaces.filter((w) => w.sole_owner).map((w) => `'${w.name}'`).join(', ')}의 유일한 OWNER입니다. 정지 상태에서는 해당 Workspace를 관리할 사용자가 없습니다.</div>` : '')}
      ${raw(kpis([{ label: 'Workspace', value: n(u.workspace_count) }, { label: '생성한 Project', value: n(u.projects_created) }, { label: '활성화', value: chip(u.activation) }, { label: '마지막 로그인', value: rel(u.last_login_at), sub: fmtD(u.last_login_at) }]))}
      <div class="agrid2">
        ${raw(section('기본 정보', dl([['이름', html`${u.name}`], ['이메일', html`<span class="mono">${u.email}</span>`], ['가입일', fmtD(u.created_at)], ['마지막 로그인', fmtD(u.last_login_at)],
          ['로그인 방식', html`${u.login_method_label || '-'}`], ['이메일 인증', u.email_verified ? chip('ok', '인증됨 (Google)') : chip('muted', '미인증')], ['상태', chip(u.status)], ['System Role', u.system_role === 'SYSTEM_ADMIN' ? chip('SYSTEM_ADMIN') : '<span class="dim">일반 사용자</span>'], ['사용자 ID', html`<span class="mono dim">${u.id}</span>`]])))}
        ${raw(section('최근 활동', d.activity.length ? html`<ul class="aact">${raw(d.activity.map((x) => html`<li><time>${fmtD(x.at)}</time><span>${x.type === 'LOGIN' ? '로그인' : `프로젝트 생성${x.workspace_name ? ` — ${x.workspace_name}` : ''}`}</span></li>`).join(''))}</ul>` : '<div class="aempty">활동 기록이 없습니다.</div>'))}
      </div>
      ${raw(section(`소속 Workspace (${d.workspaces.length})`, table([
        { key: 'name', label: 'Workspace', cls: 'ttl', render: (w) => html`${w.name}${raw(w.sole_owner ? ' <small class="dim">단독 OWNER</small>' : '')}` },
        { key: 'role', label: 'Role', w: 90 }, { key: 'plan_label', label: 'Plan', w: 80 }, { key: 'status', label: '상태', w: 80, render: (w) => chip(w.status) },
        { key: 'project_count', label: 'Projects', w: 90, cls: 'num', render: (w) => n(w.project_count) }, { key: 'joined_at', label: '가입일', w: 110, render: (w) => fmtDay(w.joined_at) },
      ], d.workspaces, { rowHref: (w) => `/admin/workspaces/${w.id}` })))}
      ${raw(section('로그인 방식', table([
        { key: 'provider', label: 'Provider', w: 120, render: (i) => (i.provider === 'GOOGLE' ? 'Google' : 'Password') }, { key: 'email', label: '연결 이메일', w: 240, render: (i) => html`<span class="mono">${i.email || '-'}</span>` },
        { key: 'email_verified', label: '이메일 인증', w: 100, render: (i) => (i.email_verified ? chip('ok', '인증됨') : chip('muted', '미인증')) }, { key: 'created_at', label: '연결일', w: 110, render: (i) => fmtDay(i.created_at) }, { key: 'last_used_at', label: '마지막 사용', w: 130, render: (i) => rel(i.last_used_at) },
      ], d.identities || [], { empty: '로그인 수단이 없습니다.' })))}
      ${raw(d.invitations && d.invitations.length ? section(`초대 이력 (${d.invitations.length})`, table([
        { key: 'type', label: '유형', w: 110, render: (i) => (i.type === 'WORKSPACE_CREATE' ? '고객 초대' : '멤버 초대') }, { key: 'workspace', label: 'Workspace', render: (i) => html`${i.type === 'WORKSPACE_CREATE' ? i.workspace_name : i.target_workspace_name || '-'}` },
        { key: 'status', label: '상태', w: 80, render: (i) => chip(i.status, { PENDING: '대기', ACCEPTED: '수락', REVOKED: '취소', EXPIRED: '만료' }[i.status]) }, { key: 'created_at', label: '초대일', w: 110, render: (i) => fmtDay(i.created_at) },
      ], d.invitations)) : '')}
      ${raw(section('이 사용자에 대한 운영자 조작', table([
        { key: 'created_at', label: '일시', w: 150, render: (r) => fmtD(r.created_at) }, { key: 'admin_name', label: 'Admin', w: 180, render: (r) => html`${r.admin_name || '-'} <small class="dim">${r.admin_email || ''}</small>` },
        { key: 'action', label: 'Action', w: 160, render: (r) => ACTIONS[r.action] || r.action }, { key: 'summary', label: 'Summary' }], d.audit, { empty: '기록 없음' })))}
    </div>`;
    bindRows(main, navigate);
    const run = async (path, title, body, confirm, danger) => {
      const reason = await promptDialog({ title, body, label: '사유 (선택, Audit에 기록)', placeholder: '예: 약관 위반 신고 접수', confirm, danger });
      if (reason === null) return;
      try { const r = await api('POST', `/api/admin/users/${id}/${path}`, { reason }); toast(`${confirm} 처리했습니다.`); (r.warnings || []).forEach((w) => toast(w)); await draw(); }
      catch (e) { toast(e.message); }
    };
    const sb = $('#suspend'); if (sb) sb.onclick = () => run('suspend', `${u.name} (${u.email}) 계정을 정지할까요?`, '즉시 모든 세션이 종료되고 로그인이 차단됩니다. Workspace와 프로젝트 데이터는 삭제되지 않으며, 이 사용자가 OWNER인 Workspace도 자동으로 정지되지 않습니다.', '정지', true);
    const rb = $('#reactivate'); if (rb) rb.onclick = () => run('reactivate', `${u.name} (${u.email}) 계정 정지를 해제할까요?`, '다시 로그인할 수 있게 됩니다.', '정지 해제', false);
  };
  await draw();
}
