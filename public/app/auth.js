import { api } from './core/api.js';
import { $, html, raw, root } from './core/dom.js';
import { navigate } from './core/router.js';
import { state } from './core/state.js';
import { showErrors } from './shared/dialogs.js';
import { LIFECYCLE_PHASES } from './shared/lifecycle.js';
import { CONSENT_PRIVACY_ROWS, legalFooterHtml } from './shared/legal-info.js';

/** The 7 lifecycle phases (docs/lifecycle-v2.md); the auth side panels list these, never the retired 일정/실행/검수 names. */
export const PHASES = LIFECYCLE_PHASES.map((p) => p.long);

const ERRORS = { google_denied: 'Google 로그인이 취소되었습니다.', oauth_state_invalid: 'Google 로그인 세션이 유효하지 않습니다. 다시 시도해 주세요.', oauth_state_expired: 'Google 로그인 세션이 만료되었습니다. 다시 시도해 주세요.',
  google_not_configured: 'Google 로그인이 아직 설정되지 않았습니다.', google_email_unverified: 'Google 계정의 이메일이 인증되지 않아 로그인할 수 없습니다.', google_id_token_invalid: 'Google 인증에 실패했습니다. 다시 시도해 주세요.', google_nonce_mismatch: 'Google 인증에 실패했습니다. 다시 시도해 주세요.',
  google_exchange_failed: 'Google 인증에 실패했습니다. 다시 시도해 주세요.', google_unavailable: 'Google에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', google_profile_incomplete: 'Google 계정 정보(이메일)를 가져올 수 없습니다.', account_suspended: '정지된 계정입니다. 운영자에게 문의해 주세요.', invite_invalid: '초대 링크가 유효하지 않습니다. 초대한 분에게 새 링크를 요청해 주세요.', consent_required: 'Google 계정으로 가입하려면 아래 이용약관과 개인정보 수집·이용에 동의한 뒤 다시 Google로 계속해 주세요.', rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' };

/** Google button + divider, inserted under the password form on both pages (and the invite landing). */
export const googleButton = (href, { label = 'Google로 계속하기', divider = true } = {}) => html`${raw(divider ? '<div class="auth__or" role="separator"><span>또는</span></div>' : '')}
  <a class="btn btn--secondary btn--lg btn--block btn--google" href="${href}" id="google-btn" data-google><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.7 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>${label}</a>`;

/** B9: required consents on signup (이용약관 + 개인정보 수집·이용). The server refuses signup without both (422). */
const consentBlock = () => html`<fieldset class="consent" id="consent"><legend class="sr-only">약관 동의</legend>
  <label class="consent__all"><input type="checkbox" id="agree-all"> <b>전체 동의</b></label>
  <div class="consent__row"><label><input type="checkbox" name="agree_terms" value="true" data-agree> <span class="req">[필수]</span> 이용약관 동의</label><a class="link" href="/terms" target="_blank" rel="noopener">보기</a></div>
  <div class="err" data-for="agree_terms"></div>
  <div class="consent__row"><label><input type="checkbox" name="agree_privacy" value="true" data-agree> <span class="req">[필수]</span> 개인정보 수집·이용 동의</label><a class="link" href="/privacy" target="_blank" rel="noopener">처리방침</a></div>
  <details class="consent__d"><summary>수집·이용 내용 보기</summary><dl>${raw(CONSENT_PRIVACY_ROWS.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`).join(''))}</dl></details>
  <div class="err" data-for="agree_privacy"></div></fieldset>`;
const consentErrors = (form) => ({ ...(form.agree_terms.checked ? {} : { agree_terms: '이용약관에 동의해 주세요.' }), ...(form.agree_privacy.checked ? {} : { agree_privacy: '개인정보 수집·이용에 동의해 주세요.' }) });

/* Signup direction A — "가입하면 바로 보게 될 화면": a What's Next preview instead of a slogan. */
const signupSide = () => html`<aside class="auth__side su-a">
  <div class="su-a__inner">
    <p class="su-eyebrow">가입하면 바로 보게 될 화면</p>
    <h2>막히는 순간마다,<br>다음 순서를 먼저 보여줍니다.</h2>
    <div class="su-a__card" aria-hidden="true">
      <div class="su-a__head"><b>지금 할 일</b><span>01 착수</span></div>
      <ol class="su-a__steps">${raw(PHASES.map((p, i) => html`<li class="${i === 0 ? 'is-current' : ''}"><i>${String(i + 1).padStart(2, '0')}</i>${p}</li>`).join(''))}</ol>
      <div class="su-a__todo">
        <p class="su-a__k">지금 할 일</p>
        <p class="su-a__t">프로젝트 목표와 범위 정리하기</p>
        <p class="su-a__d">범위를 먼저 정해 두면 요구사항 정의 단계에서 고객과의 논의가 흔들리지 않습니다.</p>
        <span class="su-a__cta">프로젝트 정의 시작 →</span>
      </div>
    </div>
    <p class="su-a__foot"><b>얼리 액세스</b> · 12개월 동안 전체 기능 무료 · 가입하면 <b>AI 크레딧 500 (₩5,000)</b> 무료 · AI는 쓴 만큼만 (1 크레딧 = ₩10)</p>
  </div></aside>`;
/** Small screens hide the side panel, so the 7 phases move under the headline. */
const signupMobile = () => html`<div class="su-mobile su-a-m" aria-label="프로젝트 7단계">${raw(PHASES.map((p, i) => html`<span class="${i === 0 ? 'is-current' : ''}"><i>${i + 1}</i>${p}</span>`).join(''))}</div>`;

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
  root.innerHTML = html`<div class="auth${isSignup ? ' auth--su-a' : ''}">
    <main class="auth__form">
      <a class="logo" href="/">RELAI</a>
      <h1>${isSignup ? (invite && !invite.invalid ? '초대받은 계정 만들기' : raw('처음 맡은 프로젝트,<br>다음 할 일부터 알려드릴게요.')) : '다시 만나서 반갑습니다'}</h1>
      <p class="sub">${isSignup ? (invite && !invite.invalid ? '초대받은 이메일로 가입하면 바로 시작할 수 있습니다.' : 'PM 방법론을 몰라도 괜찮습니다. 착수부터 운영까지 7단계를 따라, 지금 해야 할 일을 RELAI가 하나씩 짚어 드립니다. 얼리 액세스로 12개월 무료이고, AI 크레딧 500(₩5,000)을 무료로 드립니다.') : (google.enabled ? '이메일과 비밀번호 또는 Google 계정으로 로그인해 주세요.' : '이메일과 비밀번호로 로그인해 주세요.')}</p>
      ${raw(isSignup ? signupMobile() : '')}
      <form id="f" novalidate>
        <div class="form-err" id="ferr" role="alert" hidden></div>
        ${raw(!isSignup && qp.get('deleted') ? '<div class="notice" style="margin-bottom:14px">계정이 삭제되었습니다. 그동안 RELAI를 이용해 주셔서 감사합니다.</div>' : '')}
        ${raw(!isSignup && qp.get('suspended') ? '<div class="notice notice--warn" style="margin-bottom:14px">정지된 계정입니다. 운영자에게 문의해 주세요.</div>' : '')}
        ${raw(errCode ? html`<div class="notice notice--warn" style="margin-bottom:14px">${ERRORS[errCode] || '로그인에 실패했습니다. 다시 시도해 주세요.'}</div>` : '')}
        ${raw(isSignup ? inviteBanner : '')}
        ${raw(isSignup ? html`<div class="field"><label for="name">이름 <span class="req">*</span></label>
          <input class="input" id="name" name="name" autocomplete="name" maxlength="50" value="${invite && invite.invitee_name ? invite.invitee_name : ''}"><div class="err" data-for="name"></div></div>` : '')}
        <div class="field"><label for="email">이메일 <span class="req">*</span></label>
          <input class="input" id="email" name="email" type="email" autocomplete="${isSignup ? 'email' : 'username'}" placeholder="${invite && !invite.invalid && isSignup ? `초대받은 이메일 (${invite.email_masked})` : ''}"><div class="err" data-for="email"></div></div>
        <div class="field"><label for="password">비밀번호 <span class="req">*</span></label>
          <input class="input" id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          ${raw(isSignup ? '<div class="hint">영문과 숫자를 포함해 8자 이상</div>' : '<div class="hint"><a class="link" href="/forgot-password">비밀번호를 잊으셨나요?</a></div>')}<div class="err" data-for="password"></div></div>
        ${raw(isSignup ? consentBlock() : '')}
        <button class="btn btn--primary btn--lg btn--block" type="submit">${isSignup ? (invite && !invite.invalid ? '가입하고 초대 수락하기' : '무료로 첫 프로젝트 시작하기') : '로그인'}</button>
      </form>
      ${raw(google.enabled ? googleButton(googleHref) : '')}
      ${raw(google.enabled && !isSignup ? '<p class="hint auth__gnote">Google 계정으로 처음 이용하면 회원가입 화면에서 이용약관과 개인정보 수집·이용에 동의한 뒤 계속합니다.</p>' : '')}
      <p class="auth__alt">${isSignup ? '이미 계정이 있나요?' : '아직 계정이 없나요?'}
        <a class="link" href="${isSignup ? `/login${inviteToken ? `?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : ''}` : `/signup${inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ''}`}">${isSignup ? '로그인' : '회원가입'}</a></p>
      ${raw(legalFooterHtml())}
    </main>
    ${raw(isSignup ? signupSide() : html`<aside class="auth__side"><blockquote>
      <h2>프로젝트를 처음 맡아도<br>끝까지 진행할 수 있도록.</h2>
      <p>RELAI가 프로젝트의 시작부터 종료까지 다음에 해야 할 일을 안내합니다.</p>
      <div class="auth__phases">${raw(PHASES.map((p) => html`<span>${p}</span>`).join(''))}</div>
    </blockquote></aside>`)}</div>`;
  const form = $('#f');
  $(isSignup ? '#name' : '#email').focus();
  if (isSignup) {
    const boxes = [...form.querySelectorAll('[data-agree]')]; const all = $('#agree-all');
    const clear = () => boxes.forEach((b) => { if (b.checked) form.querySelector(`.err[data-for="${b.name}"]`).textContent = ''; });
    all.onchange = () => { boxes.forEach((b) => { b.checked = all.checked; }); clear(); };
    boxes.forEach((b) => { b.onchange = () => { all.checked = boxes.every((x) => x.checked); clear(); }; });
    // Google: the same consent before leaving for Google; the server only creates a new account when consent=1 came back.
    const g = $('#google-btn');
    if (g) g.addEventListener('click', (e) => {
      const errs = consentErrors(form);
      if (Object.keys(errs).length) { e.preventDefault(); showErrors(form, errs, 'Google로 계속하려면 이용약관과 개인정보 수집·이용에 동의해 주세요.'); $('#consent').scrollIntoView({ block: 'center' }); return; }
      g.href = `${googleHref}&consent=1`;
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    showErrors(form, {});
    const local = {};
    if (isSignup && !d.name.trim()) local.name = '이름을 입력해 주세요.';
    if (!d.email.trim()) local.email = '이메일을 입력해 주세요.';
    if (!d.password) local.password = '비밀번호를 입력해 주세요.';
    if (isSignup) Object.assign(local, consentErrors(form));
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

/* ---------- account security: forgot / reset password, e-mail verification (work with or without a session) ---------- */
const authCard = (title, sub, body) => html`<div class="auth"><main class="auth__form">
    <a class="logo" href="/">RELAI</a><h1>${title}</h1><p class="sub">${sub}</p>${raw(body)}
    <p class="auth__alt"><a class="link" href="/login">로그인으로 돌아가기</a></p>${raw(legalFooterHtml())}</main>
  <aside class="auth__side"><blockquote><h2>프로젝트를 처음 맡아도<br>끝까지 진행할 수 있도록.</h2>
    <p>RELAI가 프로젝트의 시작부터 종료까지 다음에 해야 할 일을 안내합니다.</p></blockquote></aside></div>`;
const linkToken = () => { const t = new URLSearchParams(location.search).get('token') || ''; history.replaceState(null, '', location.pathname); return t; };   // keep the token out of history

export function forgotPage() {
  document.title = '비밀번호 찾기 — RELAI';
  root.innerHTML = authCard('비밀번호 찾기', '가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내 드립니다.', html`<form id="f" novalidate>
    <div class="form-err" id="ferr" role="alert" hidden></div>
    <div class="field"><label for="email">이메일 <span class="req">*</span></label><input class="input" id="email" name="email" type="email" autocomplete="username"><div class="err" data-for="email"></div></div>
    <button class="btn btn--primary btn--lg btn--block" type="submit">재설정 링크 받기</button></form>`);
  const form = $('#f'); $('#email').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showErrors(form, {});
    const email = $('#email').value.trim(); if (!email) return showErrors(form, { email: '이메일을 입력해 주세요.' });
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      await api('POST', '/api/auth/password/forgot', { email });
      form.outerHTML = html`<div class="notice" role="status">${email} 로 가입된 계정이 있다면 재설정 링크를 보냈습니다. 링크는 30분 동안 한 번만 사용할 수 있습니다. 메일이 보이지 않으면 스팸함을 확인해 주세요.</div>`;
    } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
  });
}

export function resetPage() {
  document.title = '새 비밀번호 설정 — RELAI';
  const token = linkToken();
  if (!token) { root.innerHTML = authCard('링크가 올바르지 않습니다', '메일의 링크를 다시 열거나 재설정 링크를 새로 받아 주세요.', '<a class="btn btn--primary btn--lg btn--block" href="/forgot-password">재설정 링크 다시 받기</a>'); return; }
  root.innerHTML = authCard('새 비밀번호 설정', '새 비밀번호를 정하면 모든 기기에서 로그아웃되고, 새 비밀번호로 다시 로그인합니다.', html`<form id="f" novalidate>
    <div class="form-err" id="ferr" role="alert" hidden></div>
    <div class="field"><label for="password">새 비밀번호 <span class="req">*</span></label><input class="input" id="password" name="password" type="password" autocomplete="new-password"><div class="hint">영문과 숫자를 포함해 8자 이상</div><div class="err" data-for="password"></div></div>
    <div class="field"><label for="password2">새 비밀번호 확인 <span class="req">*</span></label><input class="input" id="password2" name="password2" type="password" autocomplete="new-password"><div class="err" data-for="password2"></div></div>
    <button class="btn btn--primary btn--lg btn--block" type="submit">비밀번호 변경</button></form>`);
  const form = $('#f'); $('#password').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showErrors(form, {});
    const pw = $('#password').value; const local = {};
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) local.password = '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.';
    if (pw !== $('#password2').value) local.password2 = '비밀번호가 일치하지 않습니다.';
    if (Object.keys(local).length) return showErrors(form, local);
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      await api('POST', '/api/auth/password/reset', { token, password: pw });
      state.user = null;
      form.outerHTML = html`<div class="notice" role="status">비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.</div><a class="btn btn--primary btn--lg btn--block" href="/login">로그인</a>`;
    } catch (err) {
      btn.disabled = false;
      if (err.code === 'token_invalid') form.outerHTML = html`<div class="notice notice--warn" role="alert">${err.message}</div><a class="btn btn--primary btn--lg btn--block" href="/forgot-password">재설정 링크 다시 받기</a>`;
      else showErrors(form, err.fields, err.message);
    }
  });
}

export async function verifyPage() {
  document.title = '이메일 인증 — RELAI';
  const token = linkToken();
  root.innerHTML = authCard('이메일 인증', '잠시만 기다려 주세요…', '<div class="loading">확인 중…</div>');
  let ok = false; let msg = '인증 링크가 올바르지 않습니다.';
  if (token) { try { await api('POST', '/api/auth/email/verify', { token }); ok = true; } catch (err) { msg = err.message; } }
  if (state.user && ok) state.user.email_verified = true;
  root.innerHTML = ok
    ? authCard('이메일이 인증되었습니다', '이제 팀원 초대와 결제를 포함한 모든 기능을 사용할 수 있습니다.', '<a class="btn btn--primary btn--lg btn--block" href="/app">RELAI 시작하기</a>')
    : authCard('인증하지 못했습니다', msg, '<p class="dim" style="margin-bottom:16px">로그인한 뒤 화면 상단의 안내에서 인증 메일을 다시 받을 수 있습니다.</p><a class="btn btn--primary btn--lg btn--block" href="/app">RELAI로 이동</a>');
}

/** In-app banner for unverified accounts (shown above every page until verified). */
const VB_KEY = 'relai.verifybar.hidden';
const vbHidden = () => { try { return sessionStorage.getItem(VB_KEY) === '1'; } catch { return false; } };
/** Slim neutral bar for unverified accounts (design §3.10): one line, one link, ✕ hides it for this session. */
export const verifyBanner = () => (state.user && state.user.email_verified === false && !vbHidden() ? html`<div class="verifybar" id="verifybar" role="status">
  <span class="verifybar__t"><b>${state.user.email}</b> 이메일 인증이 필요합니다<span class="verifybar__why"> · 인증 전에는 팀원 초대와 결제를 할 수 없습니다</span></span>
  <button class="linkbtn verifybar__a" id="verify-resend" type="button">인증 메일 다시 받기</button>
  <button class="verifybar__x" id="verify-hide" type="button" aria-label="이번 접속 동안 숨기기" title="숨기기">×</button></div>` : '');
export function wireVerifyBanner() {
  const x = $('#verify-hide');
  if (x) x.onclick = () => { try { sessionStorage.setItem(VB_KEY, '1'); } catch { /* private mode: hide for this page only */ } $('#verifybar')?.remove(); };
  const b = $('#verify-resend'); if (!b) return;
  b.onclick = async () => {
    b.disabled = true;
    try { const r = await api('POST', '/api/auth/email/resend', {}); b.textContent = r.already_verified ? '이미 인증되었습니다' : '메일을 보냈습니다'; if (r.already_verified) $('#verifybar').remove(); }
    catch (err) { b.disabled = false; b.textContent = err.code === 'rate_limited' ? '잠시 후 다시 시도해 주세요' : '다시 시도'; }
  };
}
