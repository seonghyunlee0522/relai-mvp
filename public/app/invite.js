/* /invite/:token — public invitation landing. Works logged-out (CTAs: Google / 이메일 가입 / 로그인) and logged-in
 * (explicit [초대 수락] when the session e-mail matches; otherwise a clear "다른 계정" message). Type-specific copy:
 *   WORKSPACE_CREATE → "{name} Workspace를 생성하고 OWNER가 됩니다"   WORKSPACE_MEMBER → "{name} Workspace에 {role}로 참여합니다" */
import { api } from './core/api.js';
import { $, fmtShort, html, raw, root } from './core/dom.js';
import { navigate } from './core/router.js';
import { state } from './core/state.js';
import { googleButton } from './auth.js';

const DEAD = { ACCEPTED: ['이미 수락된 초대입니다', '이 초대는 이미 사용되었습니다. 로그인해서 Workspace로 이동해 주세요.'], REVOKED: ['취소된 초대입니다', '초대한 분이 이 초대를 취소했습니다. 필요하면 새 초대를 요청해 주세요.'], EXPIRED: ['만료된 초대입니다', '초대 링크의 유효기간이 지났습니다. 초대한 분에게 재발송을 요청해 주세요.'] };

export async function invitePage(token) {
  document.title = '초대 — RELAI';
  const frame = (body) => { root.innerHTML = html`<div class="auth auth--single"><main class="auth__form invite"><a class="logo" href="/">RELAI</a>${raw(body)}</main></div>`; };
  // Session (optional): the landing works without one; with one we can offer explicit acceptance.
  if (!state.user) { try { Object.assign(state, await api('GET', '/api/me')); state.workspace = state.workspaces.find((w) => w.status !== 'SUSPENDED') || state.workspaces[0]; } catch { /* logged out */ } }
  let data;
  try { data = await api('GET', `/api/invitations/${encodeURIComponent(token)}`); }
  catch (e) { frame(html`<h1>초대를 찾을 수 없습니다</h1><p class="sub">${e.status === 429 ? e.message : '링크가 올바른지 확인해 주세요. 초대 메일의 링크를 그대로 열어야 합니다.'}</p><a class="btn btn--secondary btn--block btn--lg" href="/login" data-link>로그인</a>`); return; }
  const inv = data.invitation; const isCreate = inv.type === 'WORKSPACE_CREATE';
  const t = encodeURIComponent(token);
  if (inv.status !== 'PENDING') {
    const [h, p] = DEAD[inv.status] || ['유효하지 않은 초대입니다', '초대한 분에게 새 링크를 요청해 주세요.'];
    frame(html`<h1>${h}</h1><p class="sub">${p}</p>${raw(state.user ? '<a class="btn btn--primary btn--block btn--lg" href="/app" data-link>앱으로 이동</a>' : '<a class="btn btn--secondary btn--block btn--lg" href="/login" data-link>로그인</a>')}`);
    return;
  }
  const summary = html`<div class="invite__card">
      <div class="invite__k">${isCreate ? '새 Workspace' : 'Workspace'}</div><div class="invite__v"><b>${inv.workspace_name}</b></div>
      <div class="invite__k">${isCreate ? '역할' : '초대 역할'}</div><div class="invite__v">${isCreate ? 'OWNER (Workspace 소유자)' : inv.role_label}</div>
      <div class="invite__k">초대받은 이메일</div><div class="invite__v mono">${inv.email_masked}</div>
      ${raw(inv.inviter_name ? html`<div class="invite__k">초대한 사람</div><div class="invite__v">${inv.inviter_name}</div>` : '')}
      <div class="invite__k">유효기간</div><div class="invite__v">${fmtShort(inv.expires_at)} 까지</div></div>`;
  const title = isCreate ? `${inv.workspace_name} Workspace 생성 초대` : `${inv.workspace_name} Workspace 초대`;
  const lead = isCreate ? html`RELAI에서 <b>${inv.workspace_name}</b> Workspace를 생성하고 OWNER가 됩니다. 초대받은 이메일 계정으로 계속해 주세요.` : html`<b>${inv.inviter_name || '팀'}</b>님이 <b>${inv.workspace_name}</b> Workspace에 ${inv.role_label}로 초대했습니다. 초대받은 이메일 계정으로 계속해 주세요.`;
  if (!inv.me.logged_in) {
    frame(html`<h1>${title}</h1><p class="sub">${raw(lead)}</p>${raw(summary)}
      <div class="invite__cta">
        ${raw(data.google.enabled ? googleButton(`/api/auth/google/start?invite=${t}`, { divider: false }) : '')}
        <a class="btn btn--primary btn--lg btn--block" href="/signup?invite=${t}" data-link id="cta-signup">이메일로 가입</a>
        <a class="btn btn--ghost btn--lg btn--block" href="/login?next=${encodeURIComponent(`/invite/${token}`)}" data-link id="cta-login">이미 계정이 있습니다</a>
      </div>
      <p class="hint" style="text-align:center;margin-top:16px">초대받은 이메일(${inv.email_masked})과 같은 계정으로 가입·로그인해야 수락할 수 있습니다.</p>`);
    return;
  }
  // Logged in
  if (!inv.me.email_matches) {
    frame(html`<h1>${title}</h1><p class="sub">${raw(lead)}</p>${raw(summary)}
      <div class="notice notice--warn">현재 <b>${state.user.email}</b> 계정으로 로그인되어 있습니다. 초대받은 이메일 계정으로 로그인해 주세요.</div>
      <div class="invite__cta"><button class="btn btn--primary btn--lg btn--block" id="switch">다른 계정으로 로그인</button><a class="btn btn--ghost btn--lg btn--block" href="/app" data-link>앱으로 돌아가기</a></div>`);
    $('#switch').onclick = async () => { try { await api('POST', '/api/auth/logout', {}); } finally { state.user = null; location.href = `/login?next=${encodeURIComponent(`/invite/${token}`)}`; } };
    return;
  }
  frame(html`<h1>${title}</h1><p class="sub">${raw(lead)}</p>${raw(summary)}
    <div class="notice notice--invite"><b>${state.user.name}</b> (${state.user.email}) 계정으로 수락합니다. ${raw(isCreate ? html`수락하면 <b>${inv.workspace_name}</b> Workspace가 생성되고 OWNER로 설정됩니다.` : html`수락하면 <b>${inv.workspace_name}</b> Workspace에 ${inv.role_label}로 참여합니다.`)}</div>
    <div class="form-err" id="ierr" role="alert" hidden></div>
    <div class="invite__cta"><button class="btn btn--primary btn--lg btn--block" id="accept">초대 수락</button><a class="btn btn--ghost btn--lg btn--block" href="/app" data-link>나중에</a></div>`);
  $('#accept').onclick = async () => {
    const b = $('#accept'); b.disabled = true;
    try {
      const r = await api('POST', `/api/invitations/${t}/accept`, {});
      state.workspaces = r.workspaces; state.workspace = r.workspaces.find((w) => w.id === r.workspace_id) || r.workspaces[0];
      navigate('/app', { replace: true });
    } catch (e) { b.disabled = false; const el = $('#ierr'); el.textContent = e.message; el.hidden = false; }
  };
}
