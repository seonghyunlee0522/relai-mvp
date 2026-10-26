import { api, resetMembers } from './core/api.js';
import { $, fmtShort, html, raw } from './core/dom.js';
import { isPhone, pcLine } from './core/device.js';
import { state, creditsOnly } from './core/state.js';
import { confirmDialog, toast } from './shared/dialogs.js';
import { relTime } from './shared/jira.js';
import { formDialog, inviteStatusChip, emailStatusChip } from './shared/forms.js';
import { addSamples, deleteAllSamples } from './project/samples.js';
import { phoneFeedback } from './feedback.js';
import { LEGAL, legalFooterHtml } from './shared/legal-info.js';
import { mountBilling } from './billing.js';

const qp0 = () => new URLSearchParams(location.search);
const unverified = () => state.user?.email_verified === false;   // server refuses checkout/invitations until the e-mail is verified
const VERIFY_HINT = '이메일 인증 후 사용할 수 있습니다.';
/** K24: the disabled 결제하기 / 멤버 초대 hint carries its own `인증 메일 다시 받기` (the top banner can be hidden). */
const verifyHint = (id, style = '') => html`<span class="hint" id="${id}"${raw(style ? ` style="${style}"` : '')}>${VERIFY_HINT} <button type="button" class="link linkbtn" data-verify-again>인증 메일 다시 받기</button></span>`;
const ROLE = { OWNER: '소유자', ADMIN: '관리자', MEMBER: '멤버' };
const ROLE_DESC = { OWNER: '모든 기능 · 멤버/설정/결제 관리', ADMIN: '프로젝트 생성·관리 · 멤버/설정 관리 (결제 불가)', MEMBER: '프로젝트 업무 수행 (멤버/설정/결제 불가)' };

export async function settingsPage(main = $('#main')) {
  document.title = '설정 — RELAI';
  const wid = state.workspace.id;
  let integ; const [{ workspace }, { members }, integ0] = await Promise.all([api('GET', `/api/workspaces/${wid}`), api('GET', `/api/workspaces/${wid}/members`), api('GET', `/api/workspaces/${wid}/integrations`).catch(() => null)]);
  integ = integ0; const perm = isPhone() ? { ...workspace.permissions, member_manage: false, workspace_settings: false, integration_manage: false } : workspace.permissions; const me = state.user.id;   // phone = view mode: no member / workspace / Jira management
  // Plan & billing: the 요금제 tab mounts the v3 Billing view (billing.js, pricing v3 T4) — it loads its own data.
  // 샘플 프로젝트 (OWNER / ADMIN): how many of the 3 examples this workspace has — 추가 brings back the missing ones, 삭제 removes all
  let samples = 0; const loadSamples = async () => { try { samples = (await api('GET', `/api/workspaces/${wid}/projects?include_archived=1`)).projects.filter((p) => p.sample_key).length; } catch { samples = 0; } };
  await loadSamples();
  const samplesCard = () => (!perm.workspace_settings ? '' : html`<div class="panel" style="margin-top:20px" id="samples"><div class="panel__h">샘플 프로젝트 <span class="chip chip--sample">${samples}/3</span></div><div class="panel__b">
    <p style="margin:0">시작 단계 · 구현 단계 · 종료 직전, 세 가지 예시 프로젝트로 RELAI 사용 흐름을 보여 줍니다. 샘플은 사용량과 플랜 한도에 포함되지 않습니다.</p>
    <div class="actions" style="margin-top:14px"><button class="btn btn--secondary btn--sm" id="samples-add"${raw(samples >= 3 ? ' disabled title="샘플 프로젝트가 모두 있습니다."' : '')}>샘플 프로젝트 추가</button>${raw(samples ? '<button class="btn btn--ghost btn--sm is-danger" id="samples-delete">샘플 프로젝트 삭제</button>' : '')}</div></div></div>`);
  let account = null; const loadAccount = async () => { try { account = (await api('GET', '/api/me/account')).account; } catch { account = null; } };
  await loadAccount();
  let members0 = [];
  const CHECKOUT_MSG = { success: '결제가 완료되었습니다. 요금제가 적용되었습니다.', canceled: '결제를 취소했습니다.', failed: '결제가 완료되지 않았습니다. 청구된 금액은 없습니다. 다시 시도하거나 운영자에게 문의해 주세요.', fake: '모의 결제로 처리했습니다. 결제사 연동 후 실제 결제가 진행됩니다.' };
  if (qp0().get('checkout')) { toast(CHECKOUT_MSG[qp0().get('checkout')] || '결제를 처리하고 있습니다. 잠시 후 플랜이 반영됩니다.'); history.replaceState(null, '', '/app/settings#billing'); }
  // Pending invitations (OWNER/ADMIN only) — Phase 13
  let invites = []; const loadInvites = async () => { if (!perm.member_manage) return; try { invites = (await api('GET', `/api/workspaces/${wid}/invitations`)).all.filter((i) => i.status === 'PENDING' || i.status === 'EXPIRED').slice(0, 50); } catch { invites = []; } };
  await loadInvites();
  const inviteTable = () => !perm.member_manage ? '' : html`<div class="panel" style="margin-top:20px"><div class="panel__h">초대 대기 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${invites.filter((i) => i.status === 'PENDING').length}</em><span class="panel__sp"></span><button class="btn btn--secondary btn--sm" id="invite-btn" data-tour-id="invite-members"${raw(unverified() ? html` disabled title="${VERIFY_HINT}"` : '')}>멤버 초대</button></div>${raw(unverified() ? html`<p style="padding:0 20px">${raw(verifyHint('invite-verify'))}</p>` : '')}
      <div class="rtable-wrap--in"><table class="rtable rtable--raid" style="margin:0" id="invtbl"><thead><tr><th>이메일</th><th>역할</th><th>초대한 사람</th><th>만료</th><th>상태</th><th>메일</th><th></th></tr></thead>
      <tbody>${raw(invites.length ? invites.map((i) => html`<tr data-inv="${i.id}">
        <td class="mono">${i.email}</td><td>${ROLE[i.role] || i.role}</td><td class="dim">${i.invited_by_name || '-'}</td><td class="dim">${fmtShort(i.expires_at)}</td><td>${raw(inviteStatusChip(i.status))}</td>
        <td>${raw(emailStatusChip(i.last_email_status))}${raw(i.last_email_status === 'FAILED' ? html` <small class="dim">${i.last_email_error || ''}</small>` : '')}</td>
        <td style="white-space:nowrap">${raw(i.role === 'ADMIN' && workspace.role !== 'OWNER' ? '' : html`<button class="link linkbtn" data-resend="${i.id}" style="width:auto">${i.last_email_status === 'FAILED' ? '다시 보내기' : '재발송'}</button> `)}${raw(i.status === 'PENDING' ? html`<button class="link linkbtn" data-revoke="${i.id}" style="width:auto;color:#B42318">취소</button>` : '')}</td></tr>`).join('')
        : '<tr><td colspan="7" class="dim" style="text-align:center;padding:18px">대기 중인 초대가 없습니다. 아직 가입하지 않은 동료는 [멤버 초대]로 메일을 보내 초대할 수 있습니다.</td></tr>')}</tbody></table></div></div>`;
  // OAuth callback lands here with ?jira=ok|error
  const qp = new URLSearchParams(location.search);
  if (qp.get('jira')) { toast(qp.get('jira') === 'ok' ? '지라를 연결했습니다.' : `지라 연결에 실패했습니다. (${qp.get('reason') || 'oauth_error'})`); history.replaceState(null, '', '/app/settings'); }
  const jiraCard = () => {
    const pv = integ && integ.providers.find((x) => x.provider === 'JIRA'); if (!pv) return '';
    const c = pv.connection; const can = perm.integration_manage;
    const status = !c ? '' : c.status === 'ACTIVE' ? '<span class="chip chip--done">정상</span>' : c.status === 'ERROR' ? html`<span class="chip chip--fail">${c.reconnect_required ? '재연결 필요' : '오류'}</span>` : c.status === 'DISABLED' ? '<span class="chip chip--muted">연결 해제됨</span>' : '<span class="chip chip--hold">대기</span>';
    return html`<div class="panel" style="margin-top:20px"><div class="panel__h">연동</div><div class="panel__b">
      <div class="icard"><div class="icard__logo">J</div><div class="icard__m">
        <div class="icard__t"><b>지라</b>${raw(c && c.status !== 'DISABLED' ? '<span class="chip chip--active">연결됨</span>' : '<span class="chip chip--muted">미연결</span>')}${raw(!pv.configured ? '<span class="chip chip--hold">서버 설정 필요</span>' : '')}</div>
        ${raw(c && c.status !== 'DISABLED' ? html`<div class="icard__site"><a href="${c.site_url}" target="_blank" rel="noopener noreferrer">${(c.site_url || '').replace(/^https?:\/\//, '')}</a></div>
          <dl class="icard__d"><dt>상태</dt><dd>${raw(status)}${raw(c.last_error ? html` <small class="dim">${c.last_error}</small>` : '')}</dd><dt>연결자</dt><dd>${c.connected_by_name || '-'}${raw(c.external_account_name ? html` <small class="dim">(지라: ${c.external_account_name})</small>` : '')}</dd><dt>마지막 동기화</dt><dd>${c.last_synced_at ? relTime(c.last_synced_at) : '아직 없음'}</dd><dt>연결된 프로젝트</dt><dd>${c.mapped_projects}개</dd></dl>`
          : html`<p class="hint">지라 클라우드 사이트를 연결하면 각 프로젝트의 ⋯ 메뉴 → 지라 연동 설정에서 지라 프로젝트를 연결하고, WBS 하위 작업에 지라 이슈를 연결해 실행 상태를 볼 수 있습니다. ${pv.configured ? '' : '운영자가 서버에 Atlassian 앱 정보를 설정하면 연결할 수 있습니다.'}</p>`)}
        ${raw(can ? html`<div class="actions" style="margin-top:10px">${raw(c && c.status !== 'DISABLED' ? html`<button class="btn btn--secondary btn--sm" id="jira-reconnect" ${pv.configured ? '' : 'disabled'}>재연결</button><button class="btn btn--ghost btn--sm is-danger" id="jira-disconnect">연결 해제</button>` : html`<button class="btn btn--secondary btn--sm" id="jira-connect" ${pv.configured ? '' : 'disabled'}>지라 연결</button>`)}</div>` : '<p class="hint">연결 설정은 워크스페이스 소유자·관리자만 할 수 있습니다.</p>')}
      </div></div></div></div>`;
  };
  // Redesign R3 §5.7 (desktop): four tabs — 내 정보 · 팀원 · 요금제 · 연동; each with a title, purpose line and one primary.
  // The phone keeps the single long page below (view mode).
  const co = creditsOnly();   // NicePay 심사 모드: the 요금제 tab becomes AI 크레딧 (no plan / 구독 screens)
  const TABS = [['me', '내 정보', '내 계정과 워크스페이스 정보를 관리합니다.'], ['team', '팀원', '함께 일할 팀원과 초대 현황을 한곳에서 관리합니다.'], co ? ['plan', 'AI 크레딧', 'AI 크레딧 잔액과 사용 내역을 확인하고 충전합니다.'] : ['plan', '요금제', '플랜, 사용량, AI 크레딧을 확인하고 결제합니다.'], ['integrations', '연동', '외부 도구를 연결해 프로젝트와 동기화합니다.']];
  const creditsCard = () => html`<div class="panel" id="credits-link" style="margin-top:20px"><div class="panel__h">AI 크레딧</div><div class="panel__b">
    <p style="margin:0">AI 기능은 워크스페이스 공용 크레딧으로 이용합니다. 잔액과 사용 내역을 확인하고, 워크스페이스 소유자는 신용카드 1회 결제로 충전할 수 있습니다.</p>
    <div class="actions" style="margin-top:14px"><a class="btn btn--primary btn--sm" href="/app/settings/credits" data-link>AI 크레딧 확인 · 충전</a></div></div></div>`;
  const billingSlot = () => (co ? creditsCard() : '<div id="billing" class="bl-wrap"></div>');
  const tabOf = () => { const t = qp0().get('tab'); if (TABS.some(([k]) => k === t)) return t; if (location.hash === '#billing' || qp0().get('checkout')) return 'plan'; if (qp0().get('jira')) return 'integrations'; return 'me'; };
  let tab = tabOf();
  const daysLeft = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000));
  /** Members and invitations in one table — invites are rows with `초대 대기 · N일 남음` and 다시 보내기 / 취소. */
  const teamTable = (members) => html`<div class="rtable-wrap--in"><table class="rtable rtable--raid rtable--mem" style="margin:0" id="teamtbl"><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>상태</th><th>참여 · 만료</th>${raw(perm.member_manage ? '<th></th>' : '')}</tr></thead>
      <tbody>${raw(members.map((m) => html`<tr data-mem="${m.id}">
        <td>${m.name}${raw(m.id === me ? ' <small class="dim">(나)</small>' : '')}</td><td class="dim">${m.email}</td>
        <td>${raw(perm.member_manage ? html`<select class="select select--sm" data-role="${m.id}" aria-label="${m.name} 역할">${raw(Object.entries(ROLE).map(([k, l]) => html`<option value="${k}" ${m.role === k ? 'selected' : ''} ${k === 'OWNER' && !perm.owner_grant ? 'disabled' : ''}>${l}</option>`).join(''))}</select>` : ROLE[m.role])}</td>
        <td><span class="chip chip--done">참여 중</span></td><td class="dim">${fmtShort(m.created_at)} 참여</td>
        ${raw(perm.member_manage ? html`<td style="white-space:nowrap"><button class="link linkbtn" data-remove="${m.id}" style="width:auto;color:#B42318">제거</button></td>` : '')}</tr>`).join(''))}
      ${raw(invites.map((i) => html`<tr data-inv="${i.id}" class="is-invite">
        <td class="dim">가입 전 <small>· ${i.invited_by_name || '-'} 초대</small></td><td class="mono">${i.email}</td><td>${ROLE[i.role] || i.role}</td>
        <td>${raw(i.status === 'PENDING' ? html`<span class="chip chip--hold">초대 대기 · ${daysLeft(i.expires_at)}일 남음</span>` : inviteStatusChip(i.status))}${raw(i.last_email_status ? ` ${emailStatusChip(i.last_email_status)}` : '')}${raw(i.last_email_status === 'FAILED' ? html` <small class="dim">${i.last_email_error || ''}</small>` : '')}</td>
        <td class="dim">${fmtShort(i.expires_at)} 만료</td>
        <td style="white-space:nowrap">${raw(i.role === 'ADMIN' && workspace.role !== 'OWNER' ? '' : html`<button class="link linkbtn" data-resend="${i.id}" style="width:auto">다시 보내기</button> `)}${raw(i.status === 'PENDING' ? html`<button class="link linkbtn" data-revoke="${i.id}" style="width:auto;color:#B42318">취소</button>` : '')}</td></tr>`).join(''))}</tbody></table></div>`;
  const tabHead = (title, purpose, primary = '') => html`<div class="stab-head"><div><h2>${title}</h2><p class="stab-head__p">${purpose}</p></div>${raw(primary)}</div>`;
  const deskBody = (members) => {
    const [, label, purpose] = TABS.find(([k]) => k === tab);
    if (tab === 'team') return html`${raw(tabHead(label, purpose, perm.member_manage ? html`<button class="btn btn--primary btn--sm" id="invite-btn" data-tour-id="invite-members"${raw(unverified() ? html` disabled title="${VERIFY_HINT}"` : '')}>+ 팀원 초대</button>` : ''))}
      ${raw(perm.member_manage && unverified() ? html`<p>${raw(verifyHint('invite-verify'))}</p>` : '')}
      <div class="panel"><div class="panel__h"><span>팀원 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${members.length}</em>${raw(perm.member_manage ? html` <small class="dim" style="font-weight:400;margin-left:6px">초대 대기 ${invites.filter((i) => i.status === 'PENDING').length}건</small>` : '')}</span></div>
      ${raw(teamTable(members))}
      ${raw(perm.member_manage ? html`<form id="addm" class="crit-add" style="padding:12px 20px;border-top:1px solid var(--border-soft)"><input class="input input--sm" name="email" type="email" placeholder="이미 가입한 사용자 이메일" required style="flex:1;max-width:480px"><select class="select select--sm" name="role" aria-label="역할"><option value="MEMBER">멤버</option><option value="ADMIN">관리자</option>${raw(perm.owner_grant ? '<option value="OWNER">소유자</option>' : '')}</select><button class="btn btn--secondary btn--sm">바로 추가</button></form><div class="err" id="adderr" style="padding:0 20px 12px"></div>` : '<p class="hint" style="padding:0 20px 14px">팀원 초대·역할 변경은 워크스페이스 소유자·관리자만 할 수 있습니다.</p>')}</div>`;
    if (tab === 'plan') return html`${raw(tabHead(label, purpose))}${raw(billingSlot())}`;
    if (tab === 'integrations') return html`${raw(tabHead(label, purpose))}${raw(jiraCard() || '<p class="dim">연결할 수 있는 도구가 없습니다.</p>')}`;
    const ownerWs = workspace.role === 'OWNER';
    return html`${raw(tabHead(label, purpose))}
    <div class="panel" id="profile"><div class="panel__h">프로필</div><div class="panel__b"><dl class="info">
      <dt>이름</dt><dd><form id="mef" class="inline-form"><input class="input input--sm" name="name" value="${state.user.name}" maxlength="50" style="max-width:280px"> <button class="btn btn--primary btn--sm">저장</button></form></dd>
      <dt>이메일</dt><dd>${state.user.email}</dd>
      <dt>약관 · 정책</dt><dd><a class="link" href="/terms" target="_blank" rel="noopener">이용약관</a> · <a class="link" href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a></dd>
      ${raw(account ? html`<dt>로그인 방법</dt><dd>${account.login_methods.map((m) => (m.provider === 'GOOGLE' ? 'Google' : '비밀번호')).join(' · ') || '-'}</dd>` : '')}</dl>
      ${raw(account ? html`<div class="actions" style="margin-top:14px">${raw(account.has_password ? '<button class="btn btn--secondary btn--sm" id="pw-change">비밀번호 변경</button>'
        : account.can_set_password ? '<button class="btn btn--secondary btn--sm" id="pw-change">비밀번호 설정</button>' : '<small class="dim">이메일 인증 후 비밀번호를 설정할 수 있습니다.</small>')}</div>` : '')}</div></div>
    <div class="panel" style="margin-top:20px" data-tour-id="workspace-settings"><div class="panel__h">워크스페이스</div><div class="panel__b"><dl class="info">
      <dt>이름</dt><dd>${raw(perm.workspace_settings ? html`<form id="wsf" class="inline-form"><input class="input input--sm" name="name" value="${workspace.name}" maxlength="100" style="max-width:280px"> <button class="btn btn--secondary btn--sm">저장</button></form>` : html`${workspace.name}`)}</dd>
      <dt>내 역할</dt><dd>${ROLE[workspace.role]} <small class="dim">— ${ROLE_DESC[workspace.role]}</small></dd></dl></div></div>
    ${raw(samplesCard())}
    ${raw(account || ownerWs ? html`<details class="danger-zone" id="danger"><summary>위험 구역 <small class="dim">계정 삭제${ownerWs ? ' · 워크스페이스 삭제' : ''}</small></summary><div class="danger-zone__b">
      ${raw(account ? html`<div class="danger-zone__row"><div><b>계정 삭제</b><p class="hint">계정이 즉시 삭제되고 복구할 수 없습니다.</p></div><button class="btn btn--ghost btn--sm is-danger" id="acct-delete">계정 삭제</button></div>` : '')}
      ${raw(ownerWs ? html`<div class="danger-zone__row"><div><b>워크스페이스 삭제</b><p class="hint">모든 프로젝트와 데이터에 접근할 수 없게 되고 30일 후 파기됩니다.</p></div><button class="btn btn--ghost btn--sm is-danger" id="ws-delete">워크스페이스 삭제</button></div>` : '')}
    </div></details>` : '')}`;
  };
  const draw = (members) => {
    resetMembers();
    if (!isPhone()) {
      main.innerHTML = html`<div class="page page--narrow page--guide page--settings"><div class="page__head"><div><h1>설정</h1></div></div>
      <nav class="stabs stabs--settings" aria-label="설정 메뉴">${raw(TABS.map(([k, l]) => html`<a class="stabs__i ${k === tab ? 'is-active' : ''}" href="/app/settings?tab=${k}" data-set-tab="${k}" ${raw(k === tab ? 'aria-current="page"' : '')}>${l}</a>`).join(''))}</nav>
      <section class="stab-body" data-tab="${tab}">${raw(deskBody(members))}</section>${raw(legalFooterHtml(LEGAL))}</div>`;
      main.querySelectorAll('[data-set-tab]').forEach((a) => a.onclick = (e) => { e.preventDefault(); tab = a.dataset.setTab; history.replaceState(null, '', `/app/settings?tab=${tab}`); draw(members); });
    } else {
      main.innerHTML = html`<div class="page page--narrow page--guide"><div class="page__head"><div><h1>설정</h1>${raw(pcLine())}</div></div>
      <div class="panel" id="profile"><div class="panel__h">프로필</div><div class="panel__b"><dl class="info">
        <dt>이름</dt><dd><form id="mef" class="inline-form"><input class="input input--sm" name="name" value="${state.user.name}" maxlength="50" style="max-width:280px"> <button class="btn btn--secondary btn--sm">저장</button></form></dd>
        <dt>이메일</dt><dd>${state.user.email}</dd>
        <dt>약관 · 정책</dt><dd><a class="link" href="/terms" target="_blank" rel="noopener">이용약관</a> · <a class="link" href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a></dd>
        ${raw(account ? html`<dt>로그인 방법</dt><dd>${account.login_methods.map((m) => (m.provider === 'GOOGLE' ? 'Google' : '비밀번호')).join(' · ') || '-'}</dd>` : '')}</dl>
        ${raw(account ? html`<div class="actions" style="margin-top:14px">${raw(account.has_password ? '<button class="btn btn--secondary btn--sm" id="pw-change">비밀번호 변경</button>'
          : account.can_set_password ? '<button class="btn btn--secondary btn--sm" id="pw-change">비밀번호 설정</button>' : '<small class="dim">이메일 인증 후 비밀번호를 설정할 수 있습니다.</small>')}
          <span class="panel__sp"></span><button class="btn btn--ghost btn--sm is-danger" id="acct-delete">계정 삭제</button></div>` : '')}</div></div>
      <div class="panel" style="margin-top:20px" data-tour-id="workspace-settings"><div class="panel__h">워크스페이스</div><div class="panel__b"><dl class="info">
        <dt>이름</dt><dd>${raw(perm.workspace_settings ? html`<form id="wsf" class="inline-form"><input class="input input--sm" name="name" value="${workspace.name}" maxlength="100" style="max-width:280px"> <button class="btn btn--secondary btn--sm">저장</button></form>` : html`${workspace.name}`)}</dd>
        <dt>내 역할</dt><dd>${ROLE[workspace.role]} <small class="dim">— ${ROLE_DESC[workspace.role]}</small></dd></dl>
        ${raw(workspace.role === 'OWNER' ? '<div class="actions" style="margin-top:14px"><button class="btn btn--ghost btn--sm is-danger" id="ws-delete">워크스페이스 삭제</button></div>' : '')}</div></div>
      ${raw(billingSlot())}
      <div class="panel" style="margin-top:20px"><div class="panel__h">멤버 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${members.length}</em></div>
        <div class="rtable-wrap--in"><table class="rtable rtable--raid rtable--mem" style="margin:0"><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>참여</th>${raw(perm.member_manage ? '<th></th>' : '')}</tr></thead>
        <tbody>${raw(members.map((m) => html`<tr>
          <td>${m.name}${raw(m.id === me ? ' <small class="dim">(나)</small>' : '')}</td><td class="dim">${m.email}</td>
          <td>${raw(perm.member_manage ? html`<select class="select select--sm" data-role="${m.id}">${raw(Object.entries(ROLE).map(([k, l]) => html`<option value="${k}" ${m.role === k ? 'selected' : ''} ${k === 'OWNER' && !perm.owner_grant ? 'disabled' : ''}>${l}</option>`).join(''))}</select>` : ROLE[m.role])}</td>
          <td class="dim">${fmtShort(m.created_at)}</td>
          ${raw(perm.member_manage ? html`<td><button class="link linkbtn" data-remove="${m.id}" style="width:auto;color:#B42318">제거</button></td>` : '')}</tr>`).join(''))}</tbody></table></div>
        ${raw(perm.member_manage ? html`<form id="addm" class="crit-add" style="padding:12px 20px;border-top:1px solid var(--border-soft)"><input class="input input--sm" name="email" type="email" placeholder="가입된 사용자 이메일" required style="flex:1"><select class="select select--sm" name="role"><option value="MEMBER">멤버</option><option value="ADMIN">관리자</option>${raw(perm.owner_grant ? '<option value="OWNER">소유자</option>' : '')}</select><button class="btn btn--secondary btn--sm">멤버 추가</button></form><div class="err" id="adderr" style="padding:0 20px 12px"></div>` : '')}
      </div>${raw(inviteTable())}${raw(isPhone() ? '' : jiraCard())}${raw(isPhone() ? phoneFeedback() + '<button type="button" class="btn btn--secondary phone-logout" data-logout data-phone-ok>로그아웃</button>' : '')}</div>`;
    }
    members0 = members;
    const br = $('#billing'); if (br) mountBilling(br, { wid });
    const sa = $('#samples-add'); if (sa) sa.onclick = async () => { sa.disabled = true; if (await addSamples()) { await loadSamples(); draw(members); } else sa.disabled = false; };
    const sx = $('#samples-delete'); if (sx) sx.onclick = async () => { if (await deleteAllSamples()) { await loadSamples(); draw(members); } };
    if (location.hash === '#billing') $('#billing')?.scrollIntoView({ block: 'start' });
    const ib = $('#invite-btn'); if (ib) ib.onclick = async () => {
      const roles = [['MEMBER', '멤버 — 프로젝트 업무 수행']]; if (workspace.role === 'OWNER') roles.push(['ADMIN', '관리자 — 프로젝트·멤버·설정 관리']);
      const r = await formDialog({ title: '멤버 초대', body: html`초대 메일을 보냅니다. 초대받은 사람은 같은 이메일로 가입하거나 로그인한 뒤 수락하면 <b>${workspace.name}</b>${/(workspace|워크스페이스)$/i.test(workspace.name.trim()) ? '' : ' 워크스페이스'}에 참여합니다. (유효기간 7일)`, confirm: '초대 메일 보내기',
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
    const jd = $('#jira-disconnect'); if (jd) jd.onclick = async () => { if (!(await confirmDialog({ title: '지라 연결을 해제할까요?', body: '저장된 지라 인증 정보가 삭제되고 모든 프로젝트의 동기화가 중단됩니다. 프로젝트·WBS·요구사항 데이터와 기존 지라 연결 기록은 삭제되지 않습니다.', confirm: '연결 해제', danger: true }))) return; try { integ = await api('POST', `/api/workspaces/${wid}/integrations/jira/disconnect`, {}); toast('지라 연결을 해제했습니다.'); draw(members); } catch (e) { toast(e.message); } };
    const mef = $('#mef'); if (mef) mef.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('PATCH', '/api/me', { name: mef.name.value.trim() }); state.user.name = r.user.name; const sb = $('.me__t b'); if (sb) sb.textContent = r.user.name; const av = $('.me .avatar'); if (av) av.textContent = [...r.user.name][0]; const dm = $('.dtop__me'); if (dm) { dm.textContent = [...r.user.name][0]; dm.title = `${r.user.name} · 설정`; } toast('이름을 저장했습니다.'); } catch (err) { toast(err.fields?.name || err.message); } };
    const reauthField = () => (account?.has_password ? [{ name: 'password', label: '비밀번호', type: 'password', required: true, hint: '본인 확인을 위해 비밀번호를 입력해 주세요.' }] : []);
    const reauthNote = () => (account?.has_password ? '' : html`<p class="hint">Google 계정 사용자는 보안을 위해 최근 ${account?.reauth_minutes || 10}분 안에 다시 로그인한 경우에만 진행할 수 있습니다.</p>`);
    const pw = $('#pw-change'); if (pw) pw.onclick = async () => {
      const set = !account.has_password;
      const r = await formDialog({ title: set ? '비밀번호 설정' : '비밀번호 변경', body: '변경하면 이 기기를 제외한 모든 기기에서 로그아웃됩니다.', confirm: set ? '설정' : '변경',
        fields: [...(set ? [] : [{ name: 'current_password', label: '현재 비밀번호', type: 'password', required: true }]), { name: 'new_password', label: '새 비밀번호', type: 'password', required: true, hint: '영문과 숫자를 포함해 8자 이상' }],
        submit: (v) => api('POST', '/api/me/password', { current_password: v.current_password, new_password: v.new_password }) });
      if (!r) return; toast(set ? '비밀번호를 설정했습니다. 이제 이메일과 비밀번호로도 로그인할 수 있습니다.' : '비밀번호를 변경했습니다.'); await loadAccount(); draw(members);
    };
    const ad = $('#acct-delete'); if (ad) ad.onclick = async () => {
      await loadAccount(); const d = account.deletion;
      if (d.blockers.length) return confirmDialog({ title: '지금은 계정을 삭제할 수 없습니다', body: d.blockers.map((b) => b.message).join(' '), confirm: '확인' });
      const r = await formDialog({ title: '계정을 삭제할까요?', confirm: '계정 삭제',
        body: html`<p>계정이 즉시 삭제되고 다시 복구할 수 없습니다. 다른 워크스페이스에서 작성한 업무 기록은 '탈퇴한 사용자'로 남습니다.</p>
          ${raw(d.workspaces_deleted.length ? html`<p>혼자 쓰는 워크스페이스 <b>${d.workspaces_deleted.map((w) => w.name).join(', ')}</b>도 함께 삭제되며 30일 후 데이터가 완전히 파기됩니다.</p>` : '')}
          <p class="hint">법령에 따라 계정과 연결을 끊은 채 로그인 기록은 3개월, 의견·문의 기록은 3년, 결제 기록과 약관 동의 기록은 5년 동안 보관 후 파기합니다.</p>${raw(reauthNote())}`,
        fields: reauthField(), submit: (v) => api('DELETE', '/api/me', { password: v.password }) });
      if (r) location.href = '/login?deleted=1';
    };
    const wd = $('#ws-delete'); if (wd) wd.onclick = async () => {
      const r = await formDialog({ title: '워크스페이스를 삭제할까요?', confirm: '워크스페이스 삭제',
        body: html`<p><b>${workspace.name}</b>의 모든 프로젝트와 데이터에 모든 멤버가 즉시 접근할 수 없게 되고, 30일 후 완전히 파기됩니다. 유료 구독은 먼저 해지해야 합니다.</p>${raw(reauthNote())}`,
        fields: [{ name: 'confirm_name', label: '확인을 위해 워크스페이스 이름을 입력하세요', required: true, placeholder: workspace.name }, ...reauthField()],
        submit: (v) => api('DELETE', `/api/workspaces/${wid}`, { confirm_name: v.confirm_name, password: v.password }) });
      if (r) { toast('워크스페이스를 삭제했습니다.'); location.href = '/app'; }
    };
    main.querySelectorAll('[data-verify-again]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { const r = await api('POST', '/api/auth/email/resend', {}); b.textContent = r.already_verified ? '이미 인증되었습니다' : '메일을 보냈습니다'; }
      catch (err) { b.disabled = false; b.textContent = err.code === 'rate_limited' ? '잠시 후 다시 시도해 주세요' : '다시 시도'; }
    });
    // K5 (B11): renaming also updates the local copy, so the invite dialog reads the new name without a reload
    const wsf = $('#wsf'); if (wsf) wsf.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('PATCH', `/api/workspaces/${wid}`, { name: wsf.name.value.trim() }); state.workspace.name = r.workspace.name; workspace.name = r.workspace.name; toast('워크스페이스 이름을 저장했습니다.'); } catch (err) { toast(err.fields?.name || err.message); } };
    const addm = $('#addm'); if (addm) addm.onsubmit = async (e) => { e.preventDefault(); $('#adderr').textContent = ''; try { const r = await api('POST', `/api/workspaces/${wid}/members`, { email: addm.email.value, role: addm.role.value }); toast('멤버를 추가했습니다.'); draw(r.members); } catch (err) { $('#adderr').textContent = err.message; } };
    main.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => { try { const r = await api('PATCH', `/api/workspaces/${wid}/members/${sel.dataset.role}`, { role: sel.value }); toast('역할을 변경했습니다.'); draw(r.members); } catch (err) { toast(err.message); draw(members); } });
    main.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => { const m = members.find((x) => x.id === b.dataset.remove); if (!(await confirmDialog({ title: `${m.name}님을 워크스페이스에서 제거할까요?`, body: '제거된 멤버는 이 워크스페이스의 프로젝트에 접근할 수 없습니다. 이미 작성한 데이터는 유지됩니다.', confirm: '제거', danger: true }))) return; try { const r = await api('DELETE', `/api/workspaces/${wid}/members/${m.id}`); toast('멤버를 제거했습니다.'); draw(r.members); } catch (err) { toast(err.message); } });
  };
  draw(members);
}
