import { api } from './core/api.js';
import { $, html, raw, root } from './core/dom.js';
import { navigate } from './core/router.js';
import { state } from './core/state.js';
import { showErrors } from './shared/dialogs.js';

const ERRORS = { google_denied: 'Google 로그인이 취소되었습니다.', oauth_state_invalid: 'Google 로그인 세션이 유효하지 않습니다. 다시 시도해 주세요.', oauth_state_expired: 'Google 로그인 세션이 만료되었습니다. 다시 시도해 주세요.',
  google_not_configured: 'Google 로그인이 아직 설정되지 않았습니다.', google_email_unverified: 'Google 계정의 이메일이 인증되지 않아 로그인할 수 없습니다.', google_id_token_invalid: 'Google 인증에 실패했습니다. 다시 시도해 주세요.', google_nonce_mismatch: 'Google 인증에 실패했습니다. 다시 시도해 주세요.',
  google_exchange_failed: 'Google 인증에 실패했습니다. 다시 시도해 주세요.', google_unavailable: 'Google에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', google_profile_incomplete: 'Google 계정 정보(이메일)를 가져올 수 없습니다.', account_suspended: '정지된 계정입니다. 운영자에게 문의해 주세요.', invite_invalid: '초대 링크가 유효하지 않습니다. 초대한 분에게 새 링크를 요청해 주세요.', rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };

/** Google button + divider, inserted under the password form on both pages (and the invite landing). */
export const googleButton = (href, { label = 'Google로 계속하기', divider = true } = {}) => html`${raw(divider ? '<div class="auth__or" role="separator"><span>또는</span></div>' : '')}
  <a class="btn btn--secondary btn--lg btn--block btn--google" href="${href}" id="google-btn" data-google><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.7 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>${label}</a>`;

export async function authPage(mode) {
  const isSignup = mode === 'signup';
  const qp = new URLSearchParams(location.search);
  const next = qp.get('next'); const inviteToken = qp.get('invite'); const errCode = qp.get('error');
  document.title = `${isSignup ? '회원가입' : '로그인'} — RELAI`;
  // Invitation context (signup?invite=…): the token is validated server-side; nothing about workspace/role is trusted from the browser.
  let invite = null; let google = { enabled: false };
  try {
    if (inviteToken) { const r = await api('GET', `/api/invitations/${encodeURIComponent(inviteToken)}`); invite = r.invitation; google = r.google; }
    else google = await api('GET', '/api/auth/providers').then((r) => r.google);
  } catch { /* providers unknown → password only; an invalid invite simply shows the plain form with a notice */ if (inviteToken) invite = { invalid: true }; }
  if (invite && invite.status && invite.status !== 'PENDING') invite = { invalid: true, status: invite.status };
  const safeNext = next && /^\/(app|invite|admin)(\/|\?|$)/.test(next) && !next.startsWith('//') ? next : '';
  const googleHref = `/api/auth/google/start?intent=${mode}${inviteToken && invite && !invite.invalid ? `&invite=${encodeURIComponent(inviteToken)}` : ''}${safeNext ? `&next=${encodeURIComponent(safeNext)}` : ''}`;
  const inviteBanner = !invite ? '' : invite.invalid ? html`<div class="notice notice--warn" style="margin-bottom:14px">초대 링크가 ${invite.status === 'ACCEPTED' ? '이미 사용되었습니다' : invite.status === 'REVOKED' ? '취소되었습니다' : invite.status === 'EXPIRED' ? '만료되었습니다' : '유효하지 않습니다'}. 초대한 분에게 새 링크를 요청해 주세요. 일반 가입은 계속할 수 있습니다.</div>`
    : html`<div class="notice notice--invite" style="margin-bottom:14px"><b>${invite.type === 'WORKSPACE_CREATE' ? `${invite.workspace_name} Workspace 생성 초대` : `${invite.workspace_name} Workspace 멤버 초대`}</b><br>
      <span class="dim">${invite.email_masked} 로 초대되었습니다. 초대받은 이메일로 가입해야 하며, 가입 완료 시 ${raw(invite.type === 'WORKSPACE_CREATE' ? html`<b>${invite.workspace_name}</b> Workspace가 생성되고 OWNER가 됩니다.` : html`<b>${invite.workspace_name}</b> Workspace에 ${invite.role_label}로 참여합니다.`)}</span></div>`;
  root.innerHTML = html`<div class="auth">
    <main class="auth__form">
      <a class="logo" href="/">RELAI</a>
      <h1>${isSignup ? (invite && !invite.invalid ? '초대받은 계정 만들기' : '무료로 시작하기') : '다시 만나서 반갑습니다'}</h1>
      <p class="sub">${isSignup ? (invite && !invite.invalid ? '초대받은 이메일로 가입하면 바로 시작할 수 있습니다.' : '가입하면 나만의 Workspace가 바로 만들어집니다.') : '이메일과 비밀번호 또는 Google 계정으로 로그인해 주세요.'}</p>
      <form id="f" novalidate>
        <div class="form-err" id="ferr" role="alert" hidden></div>
        ${raw(!isSignup && qp.get('suspended') ? '<div class="notice notice--warn" style="margin-bottom:14px">정지된 계정입니다. 운영자에게 문의해 주세요.</div>' : '')}
        ${raw(errCode ? html`<div class="notice notice--warn" style="margin-bottom:14px">${ERRORS[errCode] || '로그인에 실패했습니다. 다시 시도해 주세요.'}</div>` : '')}
        ${raw(isSignup ? inviteBanner : '')}
        ${raw(isSignup ? html`<div class="field"><label for="name">이름 <span class="req">*</span></label>
          <input class="input" id="name" name="name" autocomplete="name" maxlength="50" value="${invite && invite.invitee_name ? invite.invitee_name : ''}"><div class="err" data-for="name"></div></div>` : '')}
        <div class="field"><label for="email">이메일 <span class="req">*</span></label>
          <input class="input" id="email" name="email" type="email" autocomplete="${isSignup ? 'email' : 'username'}" placeholder="${invite && !invite.invalid && isSignup ? `초대받은 이메일 (${invite.email_masked})` : ''}"><div class="err" data-for="email"></div></div>
        <div class="field"><label for="password">비밀번호 <span class="req">*</span></label>
          <input class="input" id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          ${raw(isSignup ? '<div class="hint">영문과 숫자를 포함해 8자 이상</div>' : '')}<div class="err" data-for="password"></div></div>
        <button class="btn btn--primary btn--lg btn--block" type="submit">${isSignup ? (invite && !invite.invalid ? '가입하고 초대 수락하기' : '가입하고 시작하기') : '로그인'}</button>
      </form>
      ${raw(google.enabled ? googleButton(googleHref) : '')}
      <p class="auth__alt">${isSignup ? '이미 계정이 있나요?' : '아직 계정이 없나요?'}
        <a class="link" href="${isSignup ? `/login${inviteToken ? `?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : ''}` : `/signup${inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ''}`}">${isSignup ? '로그인' : '회원가입'}</a></p>
    </main>
    <aside class="auth__side"><blockquote>
      <h2>프로젝트를 처음 맡아도<br>끝까지 진행할 수 있도록.</h2>
      <p>RELAI가 프로젝트의 시작부터 종료까지 다음에 해야 할 일을 안내합니다.</p>
      <div class="flow"><span>착수</span><span>요구사항</span><span>일정</span><span>실행</span><span>테스트</span><span>검수</span><span>오픈</span></div>
    </blockquote></aside></div>`;
  const form = $('#f');
  $(isSignup ? '#name' : '#email').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    showErrors(form, {});
    const local = {};
    if (isSignup && !d.name.trim()) local.name = '이름을 입력해 주세요.';
    if (!d.email.trim()) local.email = '이메일을 입력해 주세요.';
    if (!d.password) local.password = '비밀번호를 입력해 주세요.';
    if (isSignup && d.password && (d.password.length < 8 || !/[A-Za-z]/.test(d.password) || !/\d/.test(d.password))) local.password = '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.';
    if (Object.keys(local).length) return showErrors(form, local);
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      if (isSignup && inviteToken && invite && !invite.invalid) d.invite_token = inviteToken;
      const data = await api('POST', `/api/auth/${mode}`, d);
      Object.assign(state, data); state.workspace = data.workspaces.find((w) => data.accepted && w.id === data.accepted.workspace_id) || data.workspaces[0];
      const dest = safeNext || '/app';
      navigate(dest, { replace: true });
    } catch (err) {
      btn.disabled = false;
      showErrors(form, err.fields, err.message);
    }
  });
}
