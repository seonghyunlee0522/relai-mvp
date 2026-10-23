import { api } from './core/api.js';
import { $, html, raw, root } from './core/dom.js';
import { navigate } from './core/router.js';
import { state } from './core/state.js';
import { showErrors } from './shared/dialogs.js';
import { LIFECYCLE_PHASES } from './shared/lifecycle.js';
import { CONSENT_PRIVACY_ROWS, legalFooterHtml } from './shared/legal-info.js';
import { loadPromos, promoHtml } from './shared/promo.js';

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
  <div class="consent__row"><label><input type="checkbox" name="agree_terms" value="true" data-agree> <span class="req">[필수]</span> 이용약관 동의</label><a class="link" href="/terms" target="_blank" rel="noopener" aria-label="이용약관 보기">보기</a></div>
  <div class="err" data-for="agree_terms"></div>
  <div class="consent__row"><label><input type="checkbox" name="agree_privacy" value="true" data-agree> <span class="req">[필수]</span> 개인정보 수집·이용 동의</label><a class="link" href="/privacy" target="_blank" rel="noopener" aria-label="개인정보처리방침 보기">보기</a></div>
  <details class="consent__d"><summary>수집·이용 내용 보기</summary><dl>${raw(CONSENT_PRIVACY_ROWS.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`).join(''))}</dl></details>
  <div class="err" data-for="agree_privacy"></div></fieldset>`;
const consentErrors = (form) => ({ ...(form.agree_terms.checked ? {} : { agree_terms: '이용약관에 동의해 주세요.' }), ...(form.agree_privacy.checked ? {} : { agree_privacy: '개인정보 수집·이용에 동의해 주세요.' }) });

/* Login/signup value panel (founder 2026-10-15): sell the product — value headline, 3 concrete benefits, a product visual
 * (지금 할 일 + 7단계), the current offer (관리자 › 프로모션, placement signup/login) and a trust line. < 900px the same pieces
 * sit under the form (.sell-m) because app.css hides the side panel there. */
const ICONS = {
  next: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  flow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3v6"/></svg>',
  ai: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/></svg>',
};
const BENEFITS = [
  ['next', '오늘 할 일을 먼저 알려줍니다', '착수부터 운영까지 7단계마다 해야 할 일과 바로 가는 버튼. PM 경험이 없어도 순서대로 진행합니다.'],
  ['flow', '요구사항부터 검수까지 한 흐름', '요구사항 · WBS · 시험 · 변경 · 주간보고가 서로 이어져, 빠진 것과 늦어지는 것을 바로 찾습니다.'],
  ['ai', 'AI가 초안을 몇 분 만에', '문서에서 요구사항 추출, WBS 초안, 변경 영향 분석. 실행 전에 드는 크레딧을 먼저 보여 드립니다.'],
];
const benefitsHtml = () => html`<ul class="sell__ben">${raw(BENEFITS.map(([ic, t, d]) => html`<li><i class="sell__ic">${raw(ICONS[ic])}</i><div><b>${t}</b><span>${d}</span></div></li>`).join(''))}</ul>`;
const trustHtml = () => '<p class="sell__trust"><span>카드 등록 없이 시작</span><span>설치 없이 웹에서</span><span>언제든 Excel · Word로 내보내기</span></p>';
const productShot = () => html`<div class="sell__shot" aria-hidden="true">
    <div class="sell__bar"><i></i><i></i><i></i><span>지금 할 일 · 한빛제약 AI 고객상담 챗봇</span></div>
    <div class="sell__body">
      <ol class="sell__steps">${raw(LIFECYCLE_PHASES.map((p, i) => html`<li class="${i < 2 ? 'is-done' : i === 2 ? 'is-cur' : ''}">${String(i + 1).padStart(2, '0')}</li>`).join(''))}</ol>
      <div class="sell__todo"><small>✦ 지금 할 일 · 03 분석·설계</small><b>화면 설계를 확정하세요</b><em>설계 검토 →</em><p>요구사항 16건이 확정되었습니다. 화면 설계를 확정하면 WBS 일정이 이어집니다.</p></div>
      <div class="sell__kpi"><div><span>요구사항</span><b>16<small>확정</small></b></div><div><span>WBS 작업</span><b>42<small>38%</small></b></div><div><span>다음 주요 일정</span><b>D-12</b></div></div>
    </div></div>`;
/** account: the account pages (forgot / reset / verify-email) keep the headline, benefits and trust line — no product visual, no offer. */
const sidePanel = (isSignup, { account = false } = {}) => html`<aside class="auth__side sell" aria-label="RELAI 소개"><div class="sell__in">
    <p class="sell__eyebrow"><i></i>IT 프로젝트 관리 SaaS · RELAI</p>
    <h2>처음 맡은 프로젝트도<br><em>끝까지 놓치지 않게.</em></h2>
    <p class="sell__lead">착수부터 운영까지 7단계, 오늘 해야 할 일을 RELAI가 먼저 짚어 드립니다.</p>
    ${raw(benefitsHtml())}
    ${raw(account ? '' : productShot())}
    ${raw(account ? '' : html`<div data-promo-slot="${isSignup ? 'signup' : 'login'}"></div>`)}
    ${raw(trustHtml())}
  </div></aside>`;
/** < 900px: benefits + offer + trust under the form (the brand band on top already shows the product). */
const valueMobile = (isSignup) => html`<section class="sell-m" aria-label="RELAI 소개"><h2>처음 맡은 프로젝트도 끝까지 놓치지 않게.</h2>
  ${raw(benefitsHtml())}<div data-promo-slot="${isSignup ? 'signup' : 'login'}"></div>${raw(trustHtml())}</section>`;
/** Fills every promo slot on the page from 관리자 › 프로모션 (one request per placement; nothing shows when there is no offer). */
async function fillPromos() {
  const slots = [...document.querySelectorAll('[data-promo-slot]')]; if (!slots.length) return;
  const placement = slots[0].dataset.promoSlot; const list = await loadPromos(placement);
  slots.forEach((el) => { if (el.isConnected) el.innerHTML = promoHtml(list, { placement }); });
}
/** Small screens hide the side panel, so the 7 phases move under the headline. */
const signupMobile = () => html`<div class="su-mobile su-a-m" aria-label="프로젝트 7단계">${raw(PHASES.map((p, i) => html`<span class="${i === 0 ? 'is-current' : ''}"><i>${i + 1}</i>${p}</span>`).join(''))}</div>`;

/** Phone (< 768px, mobile-v2): a brand band on top — the value in one line and a glimpse of 지금 할 일 — instead of a bare form. */
const phoneBand = (isSignup) => html`<div class="aband" aria-hidden="true">
  <a class="aband__logo" href="/" tabindex="-1"><img class="brandlogo" src="/brand/logo-white.svg" alt="RELAI" width="94" height="30"></a>
  <p class="aband__t">${isSignup ? '첫 프로젝트, 다음 할 일부터 안내합니다' : '오늘 할 일이 기다리고 있어요'}</p>
  <div class="aband__card"><span class="aband__k">✦ 다음 할 일</span><b>화면 설계를 확정하세요</b>
    <span class="aband__dots">${raw(PHASES.map((p, i) => `<i class="${i < 2 ? 'is-done' : i === 2 ? 'is-cur' : ''}"></i>`).join(''))}</span><small>03 / 07 · 분석·설계</small></div>
</div>`;

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
  const wsName = (v) => String(v || '').replace(/ ?(Workspace|워크스페이스)$/, '');
  const inviteBanner = !invite ? '' : invite.invalid ? html`<div class="notice notice--warn" style="margin-bottom:14px">초대 링크가 ${invite.status === 'ACCEPTED' ? '이미 사용되었습니다' : invite.status === 'REVOKED' ? '취소되었습니다' : invite.status === 'EXPIRED' ? '만료되었습니다' : '유효하지 않습니다'}. 초대한 분에게 새 링크를 요청해 주세요. 일반 가입은 계속할 수 있습니다.</div>`
    : html`<div class="notice notice--invite" style="margin-bottom:14px"><b>${invite.type === 'WORKSPACE_CREATE' ? `${wsName(invite.workspace_name)} 워크스페이스 생성 초대` : `${wsName(invite.workspace_name)} 워크스페이스 멤버 초대`}</b><br>
      <span class="dim">${invite.email_masked} 로 초대되었습니다. 초대받은 이메일로 가입해야 하며, 가입 완료 시 ${raw(invite.type === 'WORKSPACE_CREATE' ? html`<b>${wsName(invite.workspace_name)}</b> 워크스페이스가 생성되고 소유자가 됩니다.` : html`<b>${wsName(invite.workspace_name)}</b> 워크스페이스에 ${invite.role_label}로 참여합니다.`)}</span></div>`;
  root.innerHTML = html`<div class="auth${isSignup ? ' auth--su-a' : ''}">
    <main class="auth__form">
      ${raw(phoneBand(isSignup))}
      <a class="logo" href="/" aria-label="RELAI 홈"><img class="brandlogo" src="/brand/logo.svg" alt="RELAI" width="94" height="30"></a>
      <h1>${isSignup ? (invite && !invite.invalid ? '초대받은 계정 만들기' : raw('처음 맡은 프로젝트,<br>다음 할 일부터 알려드릴게요.')) : '다시 만나서 반갑습니다'}</h1>
      <p class="sub">${isSignup ? (invite && !invite.invalid ? '초대받은 이메일로 가입하면 바로 시작할 수 있습니다.' : '프로젝트 관리 방법을 몰라도 괜찮습니다. 착수부터 운영까지 7단계를 따라, 지금 해야 할 일을 RELAI가 하나씩 짚어 드립니다.') : (google.enabled ? '이메일과 비밀번호 또는 Google 계정으로 로그인해 주세요.' : '이메일과 비밀번호로 로그인해 주세요.')}</p>
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
      ${raw(valueMobile(isSignup))}
      ${raw(legalFooterHtml(undefined, { compact: true }))}
    </main>
    ${raw(sidePanel(isSignup))}</div>`;
  const form = $('#f');
  $(isSignup ? '#name' : '#email').focus();
  fillPromos();
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
      if (isSignup) await gaSignUp();
      const dest = safeNext || (isSignup ? '/app?welcome=1' : '/app');   // ?welcome=1 → the first-run guide opens once (shell.js)
      navigate(dest, { replace: true });
    } catch (err) {
      btn.disabled = false;
      showErrors(form, err.fields, err.message);
    }
  });
}

/* GA4 'sign_up' (server/ga4.js; only present on /signup when GA4_MEASUREMENT_ID is set). No PII: just the method. Waits for the
 * hit (max 800 ms) because navigating to /app switches GA off (router.js gaGuard). */
function gaSignUp() {
  if (!window.RELAI_GA4 || typeof window.gtag !== 'function') return null;
  return new Promise((done) => { const t = setTimeout(done, 800); window.gtag('event', 'sign_up', { method: 'email', event_callback: () => { clearTimeout(t); done(); } }); });
}

/* ---------- account security: forgot / reset password, e-mail verification (work with or without a session) ----------
 * One result-card layout for every state (verify-email polish, founder 2026-10-20): the login/signup frame — form column +
 * the same dark value panel (no product visual or offer) on PC, the slim brand band on phones — a state icon, title, body
 * and one action row (primary on the right on PC, full-width and stacked on phones). */
const ACCT_ICONS = {
  ok: '<path d="M20 6L9 17l-5-5"/>',
  warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>',
  key: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  wait: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
};
const acctIcon = (tone, icon) => `<div class="acct__ic acct__ic--${tone}${icon === 'wait' ? ' acct__ic--wait' : ''}" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACCT_ICONS[icon]}</svg></div>`;
/** tone: ok | warn | info · icon: ACCT_ICONS key · note: a quieter second line · actions: buttons/links (primary last) · alt: 로그인으로 돌아가기. */
const authCard = ({ tone = 'info', icon = 'key', title, sub, note = '', body = '', actions = '', alt = true }) => html`<div class="auth auth--acct"><main class="auth__form acct">
    <div class="aband aband--acct" aria-hidden="true"><a class="aband__logo" href="/" tabindex="-1"><img class="brandlogo" src="/brand/logo-white.svg" alt="RELAI" width="94" height="30"></a></div>
    <a class="logo" href="/" aria-label="RELAI 홈"><img class="brandlogo" src="/brand/logo.svg" alt="RELAI" width="94" height="30"></a>${raw(acctIcon(tone, icon))}<h1>${title}</h1><p class="sub">${sub}</p>
    ${raw(note ? html`<p class="acct__note">${note}</p>` : '')}${raw(body)}
    ${raw(actions ? `<div class="acct__actions">${actions}</div>` : '')}
    ${raw(alt ? '<p class="auth__alt"><a class="link" href="/login">로그인으로 돌아가기</a></p>' : '')}${raw(legalFooterHtml(undefined, { compact: true }))}</main>
  ${raw(sidePanel(false, { account: true }))}</div>`;
const btnLink = (href, label, kind = 'primary') => html`<a class="btn btn--${kind} btn--lg" href="${href}">${label}</a>`;
const linkToken = () => { const t = new URLSearchParams(location.search).get('token') || ''; history.replaceState(null, '', location.pathname); return t; };   // keep the token out of history

export function forgotPage() {
  document.title = '비밀번호 찾기 — RELAI';
  root.innerHTML = authCard({ title: '비밀번호 찾기', sub: '가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내 드립니다.', body: html`<form id="f" novalidate>
    <div class="form-err" id="ferr" role="alert" hidden></div>
    <div class="field"><label for="email">이메일 <span class="req">*</span></label><input class="input" id="email" name="email" type="email" autocomplete="username"><div class="err" data-for="email"></div></div>
    <button class="btn btn--primary btn--lg btn--block" type="submit">재설정 링크 받기</button></form>` });
  const form = $('#f'); $('#email').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showErrors(form, {});
    const email = $('#email').value.trim(); if (!email) return showErrors(form, { email: '이메일을 입력해 주세요.' });
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      await api('POST', '/api/auth/password/forgot', { email });
      root.innerHTML = authCard({ icon: 'mail', title: '메일을 확인해 주세요', sub: `${email} 로 가입된 계정이 있다면 비밀번호 재설정 링크를 보냈습니다.`,
        note: '링크는 30분 동안 한 번만 사용할 수 있습니다. 메일이 보이지 않으면 스팸함을 확인해 주세요.',
        actions: btnLink('/forgot-password', '다시 받기', 'secondary') + btnLink('/login', '로그인으로 돌아가기'), alt: false });
    } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
  });
}

export function resetPage() {
  document.title = '새 비밀번호 설정 — RELAI';
  const token = linkToken();
  const badLink = (title, sub) => authCard({ tone: 'warn', icon: 'warn', title, sub, actions: btnLink('/forgot-password', '재설정 링크 다시 받기') });
  if (!token) { root.innerHTML = badLink('링크가 올바르지 않습니다', '메일의 링크를 다시 열거나 재설정 링크를 새로 받아 주세요.'); return; }
  root.innerHTML = authCard({ title: '새 비밀번호 설정', sub: '새 비밀번호를 정하면 모든 기기에서 로그아웃되고, 새 비밀번호로 다시 로그인합니다.', body: html`<form id="f" novalidate>
    <div class="form-err" id="ferr" role="alert" hidden></div>
    <div class="field"><label for="password">새 비밀번호 <span class="req">*</span></label><input class="input" id="password" name="password" type="password" autocomplete="new-password"><div class="hint">영문과 숫자를 포함해 8자 이상</div><div class="err" data-for="password"></div></div>
    <div class="field"><label for="password2">새 비밀번호 확인 <span class="req">*</span></label><input class="input" id="password2" name="password2" type="password" autocomplete="new-password"><div class="err" data-for="password2"></div></div>
    <button class="btn btn--primary btn--lg btn--block" type="submit">비밀번호 변경</button></form>` });
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
      root.innerHTML = authCard({ tone: 'ok', icon: 'ok', title: '비밀번호를 변경했습니다', sub: '모든 기기에서 로그아웃되었습니다. 새 비밀번호로 로그인해 주세요.', actions: btnLink('/login', '로그인'), alt: false });
    } catch (err) {
      btn.disabled = false;
      if (err.code === 'token_invalid') root.innerHTML = badLink('링크를 사용할 수 없습니다', err.message);
      else showErrors(form, err.fields, err.message);
    }
  });
}

export async function verifyPage() {
  document.title = '이메일 인증 — RELAI';
  const token = linkToken();
  root.innerHTML = authCard({ icon: 'wait', title: '이메일 인증', sub: '인증 링크를 확인 중…', alt: false });
  let ok = false; let code = token ? '' : 'token_missing'; let msg = '';
  if (token) { try { await api('POST', '/api/auth/email/verify', { token }); ok = true; } catch (err) { code = err.code || 'error'; msg = err.message; } }
  // the session (optional) only picks the next step: 시작하기 vs 로그인, 인증 메일 다시 받기, 이미 인증됨
  let user = state.user;
  if (!user) { try { user = (await api('GET', '/api/me?optional=1')).user || null; } catch { user = null; } }
  if (state.user && ok) state.user.email_verified = true;
  const toApp = (label = 'RELAI로 이동', kind = 'primary') => btnLink('/app', label, kind);
  const show = (view) => { root.innerHTML = authCard(view); };
  const already = () => show({ tone: 'ok', icon: 'ok', title: '이미 인증된 이메일입니다', sub: `${user.email} 계정은 인증이 끝났습니다. 모든 기능을 바로 사용할 수 있습니다.`, actions: toApp(), alt: false });
  if (ok) return show({ tone: 'ok', icon: 'ok', title: '이메일이 인증되었습니다', sub: '이제 팀원 초대와 결제를 포함한 모든 기능을 사용할 수 있습니다.',
    actions: user ? toApp('RELAI 시작하기') : btnLink('/login', '로그인하고 시작하기'), alt: false });
  if (user && user.email_verified) return already();
  if (code === 'rate_limited') return show({ tone: 'warn', icon: 'warn', title: '잠시 후 다시 시도해 주세요', sub: msg, note: '요청이 많아 지금은 확인할 수 없습니다. 잠시 뒤 메일의 링크를 다시 열어 주세요.', actions: user ? toApp() : '', alt: !user });
  const title = code === 'token_missing' ? '인증 링크가 올바르지 않습니다' : '인증 링크를 사용할 수 없습니다';
  const sub = code === 'token_missing' ? '메일에 있는 링크를 그대로 열어 주세요. 주소 일부가 빠지면 인증할 수 없습니다.' : (msg || '인증 링크가 올바르지 않습니다.');
  if (!user) return show({ tone: 'warn', icon: 'warn', title, sub, note: '로그인하면 화면 상단 안내에서 인증 메일을 다시 받을 수 있습니다.', actions: btnLink('/login', '로그인'), alt: false });
  show({ tone: 'warn', icon: 'warn', title, sub, note: `${user.email} 로 새 인증 메일을 받을 수 있습니다.`, body: '<div class="form-err" id="verr" role="alert" hidden></div>',
    actions: toApp('나중에 하기', 'secondary') + '<button class="btn btn--primary btn--lg" type="button" id="verify-again">인증 메일 다시 받기</button>', alt: false });
  const b = $('#verify-again');
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api('POST', '/api/auth/email/resend', {});
      if (r.already_verified) { user.email_verified = true; if (state.user) state.user.email_verified = true; return already(); }
      show({ icon: 'mail', title: '인증 메일을 다시 보냈습니다', sub: `${user.email} 로 새 인증 링크를 보냈습니다. 메일의 링크를 열면 인증이 끝납니다.`,
        note: '메일이 보이지 않으면 스팸함을 확인해 주세요. 이전에 받은 링크는 더 이상 쓸 수 없습니다.', actions: toApp(), alt: false });
    } catch (err) { b.disabled = false; const e = $('#verr'); e.textContent = err.message || '인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.'; e.hidden = false; }
  };
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
