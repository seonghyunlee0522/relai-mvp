/* Invitations (Phase 13): operator view of every invitation + [고객 초대] (platform invite → new customer workspace).
 * Admin may resend / revoke PLATFORM invites only; workspace member invites are managed by that workspace's OWNER/ADMIN.
 * Email Delivery: audit of outbound mail (status / error only — never the message body or any token). */
import { $, html, raw } from '../core/dom.js';
import { api } from '../core/api.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { EMAIL_STATUS, INVITE_STATUS, INVITE_TYPE, formDialog } from '../shared/forms.js';
import { adminApi, bindFilters, bindPager, chip, errorBlock, fmtD, fmtDay, head, pager, qs, sel, table } from './ui.js';

const ROLE = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
export const invChip = (s) => chip(s, INVITE_STATUS[s] || s);
export const mailChip = (s) => (!s ? '<span class="dim">-</span>' : chip(s === 'SENT' ? 'ok' : s, EMAIL_STATUS[s] || s));
const EMAIL_TYPE = { PLATFORM_INVITE: '고객 초대', WORKSPACE_MEMBER_INVITE: '멤버 초대', EMAIL_VERIFY: '이메일 인증', PASSWORD_RESET: '비밀번호 재설정' };

/** [고객 초대] modal — shared by the Invitations page and the Dashboard. Resolves after a successful send. */
export async function customerInviteDialog() {
  const r = await formDialog({ title: '고객 초대', body: '새 고객의 담당자에게 Workspace 생성 초대 메일을 보냅니다. 담당자가 초대받은 이메일로 가입(또는 로그인 후 수락)하면 아래 이름으로 Workspace가 만들어지고 담당자가 OWNER가 됩니다. 유효기간 7일.', confirm: '초대 메일 보내기',
    fields: [{ name: 'email', label: '담당자 이메일', type: 'email', required: true, placeholder: 'pm@customer.com' }, { name: 'workspace_name', label: 'Workspace 이름', required: true, placeholder: '예: 한빛소프트', maxlength: 100 },
      { name: 'invitee_name', label: '담당자 이름', placeholder: '선택', maxlength: 50 }, { name: 'note', label: '메모', type: 'textarea', placeholder: '운영용 메모 (초대받는 사람에게는 보이지 않습니다)', maxlength: 1000 }],
    submit: (v) => api('POST', '/api/admin/invitations', { email: v.email.trim(), workspace_name: v.workspace_name.trim(), invitee_name: v.invitee_name.trim(), note: v.note.trim() }) });
  if (!r) return null;
  toast(r.email_delivery?.status === 'FAILED' ? '초대는 생성되었지만 메일 발송에 실패했습니다. [재발송]으로 다시 보내세요.' : `${r.invitation.email}에게 초대 메일을 보냈습니다.`);
  return r;
}

export async function adminInvitationsPage(main = $('#main')) {
  document.title = 'Invitations — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let data; try { data = await adminApi('invitations', { q: q.q, type: q.type, status: q.status, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">
      ${raw(head('Invitations', '<button class="btn btn--primary btn--sm" id="new-inv">고객 초대</button>'))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="이메일 · Workspace 검색" value="${q.q || ''}">
        ${raw(sel('type', '유형', INVITE_TYPE, q.type))}${raw(sel('status', '상태', INVITE_STATUS, q.status))}
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'type', label: '유형', w: 130, render: (i) => (i.type === 'WORKSPACE_CREATE' ? chip('act', '고객 초대') : chip('muted', '멤버 초대')) },
        { key: 'email', label: '이메일', w: 200, render: (i) => html`<span class="mono">${i.email}</span>${raw(i.invitee_name ? html` <small class="dim">${i.invitee_name}</small>` : '')}` },
        { key: 'workspace', label: 'Workspace', w: 170, cls: 'ttl', render: (i) => (i.type === 'WORKSPACE_CREATE' ? html`${i.workspace_name}${raw(i.accepted_workspace_id ? html` <a class="link" href="/admin/workspaces/${i.accepted_workspace_id}" data-link>열기</a>` : '')}` : html`<a class="link" href="/admin/workspaces/${i.workspace_id}" data-link>${i.target_workspace_name || '-'}</a>`) },
        { key: 'role', label: '역할', w: 80, render: (i) => (i.type === 'WORKSPACE_CREATE' ? 'OWNER' : ROLE[i.role] || i.role) },
        { key: 'status', label: '상태', w: 80, render: (i) => invChip(i.status) },
        { key: 'mail', label: '메일', w: 100, render: (i) => html`${raw(mailChip(i.last_email_status))}${raw(i.last_email_status === 'FAILED' && i.last_email_error ? html`<br><small class="dim">${i.last_email_error}</small>` : '')}` },
        { key: 'invited_by_name', label: '초대한 사람', w: 110, render: (i) => html`${i.invited_by_name || '-'}` },
        { key: 'expires_at', label: '만료', w: 100, render: (i) => html`<span title="생성 ${fmtD(i.created_at)} · 만료 ${fmtD(i.expires_at)}">${i.status === 'PENDING' ? `${Math.max(0, Math.ceil((new Date(i.expires_at) - Date.now()) / 86400000))}일 남음` : fmtDay(i.expires_at)}</span>` },
        { key: 'act', label: '', w: 150, render: (i) => (i.type !== 'WORKSPACE_CREATE' ? '<small class="dim">Workspace에서 관리</small>' : i.status === 'ACCEPTED' ? html`<small class="dim">${i.accepted_by_name || ''} 수락 · ${fmtDay(i.accepted_at)}</small>` : i.status === 'REVOKED' ? '' : html`<button class="btn btn--secondary btn--xs" data-resend="${i.id}">재발송</button> ${raw(i.status === 'PENDING' ? html`<button class="btn btn--ghost btn--xs is-danger" data-revoke="${i.id}">취소</button>` : '')}`) },
      ], data.items, { empty: '초대가 없습니다. [고객 초대]로 새 고객의 Workspace 생성 초대를 보낼 수 있습니다.' }))}
      ${raw(pager(data))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw);
    $('#new-inv').onclick = async () => { if (await customerInviteDialog()) draw(); };
    main.querySelectorAll('[data-resend]').forEach((b) => b.onclick = async () => { b.disabled = true; try { const r = await api('POST', `/api/admin/invitations/${b.dataset.resend}/resend`, {}); toast(r.email_delivery?.status === 'FAILED' ? '메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.' : '초대 메일을 다시 보냈습니다. (새 링크 발급, 이전 링크 무효)'); draw(); } catch (e) { b.disabled = false; toast(e.message); } });
    main.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { const i = data.items.find((x) => x.id === b.dataset.revoke); if (!(await confirmDialog({ title: `${i.email} 초대를 취소할까요?`, body: '보낸 초대 링크는 더 이상 사용할 수 없습니다. 필요하면 다시 초대할 수 있습니다.', confirm: '초대 취소', danger: true }))) return; try { await api('POST', `/api/admin/invitations/${i.id}/revoke`, {}); toast('초대를 취소했습니다.'); draw(); } catch (e) { toast(e.message); } });
  };
  await draw();
}

export async function adminEmailDeliveriesPage(main = $('#main')) {
  document.title = 'Email Delivery — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let data; try { data = await adminApi('email-deliveries', { q: q.q, type: q.type, status: q.status, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">
      ${raw(head('Email Delivery', '<span class="hint">발송 기록 — 상태와 오류만 기록하며 본문·링크는 저장하지 않습니다.</span>'))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="수신자 검색" value="${q.q || ''}">
        ${raw(sel('type', '유형', EMAIL_TYPE, q.type))}${raw(sel('status', '상태', EMAIL_STATUS, q.status))}
        ${raw(Object.keys(q).filter((k) => !['page', 'size'].includes(k)).length ? '<button type="button" class="link linkbtn" data-clear>필터 초기화</button>' : '')}</div>
      ${raw(table([
        { key: 'created_at', label: '일시', w: 150, render: (d) => fmtD(d.created_at) },
        { key: 'type', label: '유형', w: 120, render: (d) => EMAIL_TYPE[d.type] || d.type },
        { key: 'recipient', label: '수신자', w: 220, render: (d) => html`<span class="mono">${d.recipient}</span>` },
        { key: 'status', label: '상태', w: 90, render: (d) => mailChip(d.status) },
        { key: 'provider', label: 'Provider', w: 90, render: (d) => html`${d.provider}${raw(d.provider_message_id ? html` <small class="dim mono">${d.provider_message_id.slice(0, 12)}</small>` : '')}` },
        { key: 'workspace_name', label: 'Workspace', w: 160, render: (d) => (d.workspace_id ? html`<a class="link" href="/admin/workspaces/${d.workspace_id}" data-link>${d.workspace_name || '-'}</a>` : '<span class="dim">-</span>') },
        { key: 'error', label: '오류', render: (d) => (d.status === 'FAILED' ? html`<span class="dim">${d.error_code || ''} ${d.error_message_safe || ''}</span>` : '') },
      ], data.items, { empty: '발송 기록이 없습니다.' }))}
      ${raw(pager(data))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw);
  };
  await draw();
}
