/* 의견 남기기 (migration 48): one entry at the bottom of the desktop rail (phone: a button on 설정) opens a small modal —
 * 종류 + 내용 (필수, 2,000자). The current path, workspace / project id, user id (session) and browser UA go along automatically.
 * Stored in RELAI's own database only (server/feedback.js); read in 관리자 › 의견. Styles: feedback.css. */
import { api } from './core/api.js';
import { $, html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { toast } from './shared/dialogs.js';

export const FEEDBACK_CATEGORIES = [['INCONVENIENCE', '불편'], ['SUGGESTION', '개선 제안'], ['BUG', '오류'], ['OTHER', '기타']];
const MAX = 2000;
const ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M7 8.5h6M7 11h4"/></svg>';

/** Desktop rail: the last item of both rails (frame.js mountGlobalRail / mountProjectRail). */
export const railFeedback = (above = '') => html`<div class="rail__fb">${raw(above)}<button type="button" class="rail__i" data-feedback title="RELAI 팀에 의견 보내기">${raw(ICON)}<span>의견 남기기</span></button></div>`;
/** Phone (view mode, no rail): a full-width button on 설정, next to 로그아웃 (settings.js). */
export const phoneFeedback = () => html`<button type="button" class="btn btn--secondary phone-feedback" data-feedback data-phone-ok>의견 남기기</button>`;

let wired = false;
export function wireFeedback() {
  if (wired) return; wired = true;
  document.addEventListener('click', (e) => { if (e.target.closest('[data-feedback]')) { e.preventDefault(); openFeedback(); } });
}

const ctx = () => {
  const m = location.pathname.match(/^\/app\/projects\/(?!new(?:\/|$))([\w-]+)/);
  return { page_path: `${location.pathname}${location.search}`.slice(0, 500), workspace_id: state.workspace?.id || null, project_id: m ? m[1] : null };
};

export function openFeedback() {
  if (!state.user || $('.fbdlg')) return;
  const opener = document.activeElement;
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<form class="dialog fbdlg" data-phone-ok role="dialog" aria-modal="true" aria-labelledby="fbT" novalidate>
    <h3 id="fbT">의견 남기기</h3>
    <p class="fbdlg__lead">불편한 점이나 바라는 점을 RELAI 팀에 알려 주세요. 보내는 화면 주소가 함께 전달됩니다.</p>
    <fieldset class="fbdlg__cats"><legend>종류 <span class="req">*</span></legend>
      ${raw(FEEDBACK_CATEGORIES.map(([v, l], i) => html`<label class="fbdlg__cat"><input type="radio" name="category" value="${v}" ${i === 1 ? 'checked' : ''}><span>${l}</span></label>`).join(''))}
      <div class="err" data-for="category"></div></fieldset>
    <div class="field"><label for="fb-msg">내용 <span class="req">*</span></label>
      <textarea class="textarea fbdlg__msg" id="fb-msg" name="message" maxlength="${MAX}" rows="6" placeholder="예: 간트 차트에서 주말을 숨길 수 있으면 좋겠어요."></textarea>
      <div class="fbdlg__meta"><div class="err" data-for="message" id="fb-err"></div><span class="fbdlg__count" id="fb-count">0 / ${MAX.toLocaleString('ko-KR')}</span></div></div>
    <div class="form-err" id="fb-gen" role="alert" hidden></div>
    <div class="actions"><button type="button" class="btn btn--secondary" data-fb-cancel>취소</button><button type="submit" class="btn btn--primary" id="fb-send">보내기</button></div>
  </form>`;
  const form = $('.fbdlg', el); const msg = $('#fb-msg', el); const gen = $('#fb-gen', el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };   // on document: a disabled 보내기 button drops focus to <body>
  const close = () => { document.removeEventListener('keydown', onKey); el.remove(); if (opener && opener.focus) opener.focus(); };
  const setErr = (k, t) => { const d = el.querySelector(`[data-for="${k}"]`); if (d) d.textContent = t || ''; };
  msg.addEventListener('input', () => { $('#fb-count', el).textContent = `${msg.value.length.toLocaleString('ko-KR')} / ${MAX.toLocaleString('ko-KR')}`; if (msg.value.trim()) setErr('message', ''); });
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-fb-cancel]')) close(); });
  document.addEventListener('keydown', onKey);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); setErr('message', ''); setErr('category', ''); gen.hidden = true;
    const category = form.querySelector('[name=category]:checked')?.value || '';
    const message = msg.value.trim();
    if (!message) { setErr('message', '내용을 입력해 주세요.'); msg.focus(); return; }
    const btn = $('#fb-send', el); btn.disabled = true; btn.textContent = '보내는 중…';
    try {
      await api('POST', '/api/feedback', { category, message, ...ctx() });
      close();
      toast('의견을 보냈습니다. 고맙습니다!');
    } catch (err) {
      btn.disabled = false; btn.textContent = '보내기';
      const f = err.fields || {};
      if (f.message || f.category) { setErr('message', f.message); setErr('category', f.category); } else { gen.textContent = err.message; gen.hidden = false; }
    }
  });
  document.body.append(el); msg.focus();
}
