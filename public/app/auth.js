import { api } from './core/api.js';
import { $, html, raw, root } from './core/dom.js';
import { navigate } from './core/router.js';
import { state } from './core/state.js';
import { showErrors } from './shared/dialogs.js';

export function authPage(mode) {
  const isSignup = mode === 'signup';
  const next = new URLSearchParams(location.search).get('next');
  document.title = `${isSignup ? '회원가입' : '로그인'} — RELAI`;
  root.innerHTML = html`<div class="auth">
    <main class="auth__form">
      <a class="logo" href="/">RELAI</a>
      <h1>${isSignup ? '무료로 시작하기' : '다시 만나서 반갑습니다'}</h1>
      <p class="sub">${isSignup ? '가입하면 나만의 Workspace가 바로 만들어집니다.' : '이메일과 비밀번호로 로그인해 주세요.'}</p>
      <form id="f" novalidate>
        <div class="form-err" id="ferr" role="alert" hidden></div>
        ${raw(isSignup ? html`<div class="field"><label for="name">이름 <span class="req">*</span></label>
          <input class="input" id="name" name="name" autocomplete="name" maxlength="50"><div class="err" data-for="name"></div></div>` : '')}
        <div class="field"><label for="email">이메일 <span class="req">*</span></label>
          <input class="input" id="email" name="email" type="email" autocomplete="${isSignup ? 'email' : 'username'}"><div class="err" data-for="email"></div></div>
        <div class="field"><label for="password">비밀번호 <span class="req">*</span></label>
          <input class="input" id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          ${raw(isSignup ? '<div class="hint">영문과 숫자를 포함해 8자 이상</div>' : '')}<div class="err" data-for="password"></div></div>
        <button class="btn btn--primary btn--lg btn--block" type="submit">${isSignup ? '가입하고 시작하기' : '로그인'}</button>
      </form>
      <p class="auth__alt">${isSignup ? '이미 계정이 있나요?' : '아직 계정이 없나요?'}
        <a class="link" href="${isSignup ? '/login' : '/signup'}">${isSignup ? '로그인' : '회원가입'}</a></p>
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
      const data = await api('POST', `/api/auth/${mode}`, d);
      Object.assign(state, data); state.workspace = data.workspaces[0];
      const dest = next && next.startsWith('/app') ? next : '/app';
      navigate(dest, { replace: true });
    } catch (err) {
      btn.disabled = false;
      showErrors(form, err.fields, err.message);
    }
  });
}
