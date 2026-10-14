import { api, resetMembers } from './core/api.js';
import { $, fmtShort, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { confirmDialog, toast } from './shared/dialogs.js';
import { relTime } from './shared/jira.js';
import { formDialog, inviteStatusChip, emailStatusChip } from './shared/forms.js';
import { usageBars, fmtDay } from './admin/ui.js';

const qp0 = () => new URLSearchParams(location.search);
const ROLE = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
const ROLE_DESC = { OWNER: '모든 기능 · 멤버/설정/결제 관리', ADMIN: '프로젝트 생성·관리 · 멤버/설정 관리 (결제 불가)', MEMBER: '프로젝트 업무 수행 (멤버/설정/결제 불가)' };

export async function settingsPage(main = $('#main')) {
  document.title = 'Settings — RELAI';
  const wid = state.workspace.id;
  let integ; const [{ workspace }, { members }, integ0] = await Promise.all([api('GET', `/api/workspaces/${wid}`), api('GET', `/api/workspaces/${wid}/members`), api('GET', `/api/workspaces/${wid}/integrations`).catch(() => null)]);
  integ = integ0; const perm = workspace.permissions; const me = state.user.id;
  // Plan & billing (Phase 10): plan, usage against limits, OWNER-only purchase (cycle × seats, server-quoted, VAT excluded) / cancel.
  let billing = null; const loadBilling = async () => { try { billing = (await api('GET', `/api/workspaces/${wid}/billing`)).billing; } catch { billing = null; } };
  await loadBilling();
  const SUB_STATUS = { ACTIVE: ['chip--done', '이용 중'], PAST_DUE: ['chip--fail', '결제 실패'], CANCELED: ['chip--muted', '해지됨'], EXPIRED: ['chip--muted', '만료'] };
  const billingCard = () => {
    if (!billing) return '';
    const s = billing.subscription; const co = billing.checkout || {};
    const st = s && SUB_STATUS[s.status];
    const lines = !s ? '' : html`<dl class="info" style="margin-top:14px"><dt>구독 상태</dt><dd><span class="chip ${st?.[0] || ''}">${st?.[1] || s.status}</span>${raw(s.cancel_at_period_end && s.status === 'ACTIVE' ? ' <small class="dim">해지 예약 — 기간 종료 후 Free로 전환</small>' : '')}</dd>
      ${raw(s.current_period_end ? html`<dt>이용 기간</dt><dd>${fmtDay(s.current_period_end)}까지</dd>` : '')}
      ${raw(s.status === 'PAST_DUE' && s.grace_period_end ? html`<dt>유예 기간</dt><dd>${fmtDay(s.grace_period_end)}까지 결제수단을 확인해 주세요. 이후 Free 한도가 적용됩니다.</dd>` : '')}
      ${raw(s.seats ? html`<dt>좌석</dt><dd>${s.seats}석${raw(s.billing_cycle ? html` <small class="dim">· ${s.billing_cycle === 'ANNUAL' ? '연간 선결제' : '1개월'}</small>` : '')}</dd>` : '')}
      ${raw(s.status === 'ACTIVE' && !s.auto_renew ? '<dt>자동 결제</dt><dd>없음 <small class="dim">— 기간 종료 7일 전에 연장 안내 메일을 보내 드립니다</small></dd>' : '')}
      ${raw(s.payment_method_summary ? html`<dt>결제 수단</dt><dd>${s.payment_method_summary}</dd>` : '')}</dl>`;
    const canCancel = billing.can_manage && s && ['ACTIVE', 'PAST_DUE'].includes(s.status) && !s.cancel_at_period_end;
    const actions = !billing.can_manage ? '<p class="hint" style="margin-top:12px">플랜 변경·해지는 Workspace OWNER만 할 수 있습니다.</p>'
      : html`${raw(co.can_purchase && billing.provider_available ? buyForm() : '')}<div class="actions" style="margin-top:14px">${raw(canCancel && s.auto_renew ? '<button class="btn btn--ghost btn--sm is-danger" id="bill-cancel">구독 해지</button>' : '')}</div>
        ${raw(billing.provider_available ? '' : '<p class="hint">결제 기능 준비 중입니다. 운영자에게 문의해 주세요.</p>')}`;
    return html`<div class="panel" style="margin-top:20px" id="billing"><div class="panel__h">플랜 · 결제 <span class="chip ${billing.plan === 'FREE' ? 'chip--muted' : 'chip--active'}">${billing.plan_label}</span></div><div class="panel__b">
      ${raw(usageBars(billing.usage))}${raw(lines)}${raw(actions)}</div></div>`;
  };
  /** Purchase form: cycle × seats → server quote (VAT excluded prices, founding discount) → NicePay payment window. */
  const won = (n) => `₩${Number(n).toLocaleString('ko-KR')}`;
  const buyForm = () => {
    const co = billing.checkout; const extend = billing.plan !== 'FREE';
    return html`<form id="bill-buy" class="panel__sub" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft)">
      <p style="margin:0 0 10px;font-weight:600">${extend ? 'Team 이용 기간 연장' : 'Team 플랜 구매'} ${raw(co.founding_eligible ? html`<span class="chip chip--active">파운딩 고객 ${co.founding.pct}% 할인 · 첫 1년</span>` : '')}</p>
      <div class="inline-form" style="gap:8px;flex-wrap:wrap"><select class="select select--sm" name="cycle">${raw(co.cycles.map((c) => html`<option value="${c.key}">${c.label} · ${won(c.unit_price)}/석/월</option>`).join(''))}</select>
        <label class="dim" style="display:flex;align-items:center;gap:6px">좌석 <input class="input input--sm" name="seats" type="number" min="${co.min_seats}" max="1000" step="1" value="${Math.max(co.min_seats, billing.subscription?.seats || 0)}" style="width:84px"></label></div>
      <p class="hint" id="bill-quote" style="margin-top:8px">금액 계산 중…</p>
      <div class="actions" style="margin-top:10px"><button class="btn btn--primary btn--sm" id="bill-pay">결제하기</button></div>
      <p class="hint">가격은 부가세 별도이며 결제 시 부가세 10%가 더해집니다. 최소 ${co.min_seats}석 · 자동 결제되지 않습니다.${co.sandbox ? ' (테스트 결제 환경)' : ''}</p>
      ${raw(co.recurring_available && !extend ? html`<details style="margin-top:10px"><summary class="link">카드 등록 후 자동 결제(정기결제)로 구독</summary><div class="inline-form" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <input class="input input--sm" name="number" placeholder="카드번호" autocomplete="cc-number" inputmode="numeric"><input class="input input--sm" name="expiry" placeholder="MM/YY" autocomplete="cc-exp" style="width:80px">
        <input class="input input--sm" name="id_no" placeholder="생년월일 6자리 / 사업자번호" inputmode="numeric"><input class="input input--sm" name="password2" type="password" placeholder="비밀번호 앞 2자리" maxlength="2" style="width:130px">
        <button class="btn btn--secondary btn--sm" type="button" id="bill-recurring">카드 등록 · 결제</button></div><p class="hint">카드 정보는 결제사(NicePay)로만 전달되고 RELAI에 저장되지 않습니다.</p></details>` : '')}
    </form>`;
  };
  const bindBuy = () => {
    const f = $('#bill-buy'); if (!f) return;
    const val = () => ({ plan: 'TEAM', cycle: f.cycle.value, seats: Number(f.seats.value) });
    const q = $('#bill-quote'); let seq = 0;
    const refresh = async () => {
      const my = ++seq; const v = val();
      try {
        const { quote: x } = await api('GET', `/api/workspaces/${wid}/billing/quote?cycle=${v.cycle}&seats=${v.seats}`); if (my !== seq) return;
        q.innerHTML = html`${x.seats}석 × ${won(x.unit_price)} × ${x.months}개월 = ${won(x.list_amount)}${raw(x.discount_amount ? html` − 할인 ${won(x.discount_amount)}` : '')} + 부가세 ${won(x.vat_amount)} → <b>${won(x.amount)}</b>`;
        $('#bill-pay').disabled = false;
      } catch (e) { if (my !== seq) return; q.textContent = e.fields?.seats || e.message; $('#bill-pay').disabled = true; }
    };
    f.cycle.onchange = refresh; f.seats.oninput = refresh; refresh();
    f.onsubmit = async (e) => { e.preventDefault(); const b = $('#bill-pay'); b.disabled = true; try { const r = await api('POST', `/api/workspaces/${wid}/billing/checkout`, val()); location.href = r.checkout_url; } catch (err) { b.disabled = false; toast(err.message); } };
    const rb = $('#bill-recurring'); if (rb) rb.onclick = async () => {
      rb.disabled = true;
      try { billing = (await api('POST', `/api/workspaces/${wid}/billing/recurring`, { ...val(), card: { number: f.number.value, expiry: f.expiry.value, id_no: f.id_no.value, password2: f.password2.value } })).billing; toast('정기결제를 시작했습니다.'); draw(members0); }
      catch (err) { rb.disabled = false; toast(Object.values(err.fields || {})[0] || err.message); }
    };
  };
  let members0 = [];
  const CHECKOUT_MSG = { success: '결제가 완료되었습니다. Team 플랜이 적용되었습니다.', canceled: '결제를 취소했습니다.', failed: '결제가 완료되지 않았습니다. 청구된 금액은 없습니다. 다시 시도하거나 운영자에게 문의해 주세요.', fake: '테스트 결제 화면입니다. 결제사 연동 후 실제 결제가 진행됩니다.' };
  if (qp0().get('checkout')) { toast(CHECKOUT_MSG[qp0().get('checkout')] || '결제를 처리하고 있습니다. 잠시 후 플랜이 반영됩니다.'); history.replaceState(null, '', '/app/settings#billing'); }
  // Pending invitations (OWNER/ADMIN only) — Phase 13
  let invites = []; const loadInvites = async () => { if (!perm.member_manage) return; try { invites = (await api('GET', `/api/workspaces/${wid}/invitations`)).all.filter((i) => i.status === 'PENDING' || i.status === 'EXPIRED').slice(0, 50); } catch { invites = []; } };
  await loadInvites();
  const inviteTable = () => !perm.member_manage ? '' : html`<div class="panel" style="margin-top:20px"><div class="panel__h">초대 대기 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${invites.filter((i) => i.status === 'PENDING').length}</em><span class="panel__sp"></span><button class="btn btn--primary btn--sm" id="invite-btn" data-tour-id="invite-members">멤버 초대</button></div>
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
    <div class="panel" style="margin-top:20px" data-tour-id="workspace-settings"><div class="panel__h">Workspace</div><div class="panel__b"><dl class="info">
      <dt>이름</dt><dd>${raw(perm.workspace_settings ? html`<form id="wsf" class="inline-form"><input class="input input--sm" name="name" value="${workspace.name}" maxlength="100" style="max-width:280px"> <button class="btn btn--secondary btn--sm">저장</button></form>` : html`${workspace.name}`)}</dd>
      <dt>내 역할</dt><dd>${ROLE[workspace.role]} <small class="dim">— ${ROLE_DESC[workspace.role]}</small></dd></dl></div></div>
    ${raw(billingCard())}
    <div class="panel" style="margin-top:20px"><div class="panel__h">멤버 <em class="att__n" style="background:var(--bg-tint);color:var(--blue-deep)">${members.length}</em></div>
      <div class="rtable-wrap--in"><table class="rtable rtable--raid" style="margin:0"><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>참여</th>${raw(perm.member_manage ? '<th></th>' : '')}</tr></thead>
      <tbody>${raw(members.map((m) => html`<tr>
        <td>${m.name}${raw(m.id === me ? ' <small class="dim">(나)</small>' : '')}</td><td class="dim">${m.email}</td>
        <td>${raw(perm.member_manage ? html`<select class="select select--sm" data-role="${m.id}">${raw(Object.entries(ROLE).map(([k, l]) => html`<option value="${k}" ${m.role === k ? 'selected' : ''} ${k === 'OWNER' && !perm.owner_grant ? 'disabled' : ''}>${l}</option>`).join(''))}</select>` : ROLE[m.role])}</td>
        <td class="dim">${fmtShort(m.created_at)}</td>
        ${raw(perm.member_manage ? html`<td><button class="link linkbtn" data-remove="${m.id}" style="width:auto;color:#B42318">제거</button></td>` : '')}</tr>`).join(''))}</tbody></table></div>
      ${raw(perm.member_manage ? html`<form id="addm" class="crit-add" style="padding:12px 20px;border-top:1px solid var(--border-soft)"><input class="input input--sm" name="email" type="email" placeholder="가입된 사용자 이메일" required style="flex:1"><select class="select select--sm" name="role"><option value="MEMBER">Member</option><option value="ADMIN">Admin</option>${raw(perm.owner_grant ? '<option value="OWNER">Owner</option>' : '')}</select><button class="btn btn--secondary btn--sm">멤버 추가</button></form><div class="err" id="adderr" style="padding:0 20px 12px"></div>` : '')}
    </div>${raw(inviteTable())}${raw(jiraCard())}</div>`;
    members0 = members; bindBuy();
    const bc = $('#bill-cancel'); if (bc) bc.onclick = async () => { if (!(await confirmDialog({ title: 'Team 구독을 해지할까요?', body: '현재 이용 기간이 끝날 때까지 Team 플랜을 그대로 쓰고, 이후 Free 한도가 적용됩니다. 데이터는 삭제되지 않습니다.', confirm: '해지 예약', danger: true }))) return; try { billing = (await api('POST', `/api/workspaces/${wid}/billing/cancel`, {})).billing; toast('해지를 예약했습니다.'); draw(members); } catch (e) { toast(e.message); } };
    if (location.hash === '#billing') $('#billing')?.scrollIntoView({ block: 'start' });
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
