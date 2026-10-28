/* 공지 팝업 (migration 74): the images of visible notices as one modal on the landing page (placement 'landing') and app Home
 * ('app_home'). Several notices = one modal with ◀ ▶ / dots. '오늘 하루 보지 않기' hides the notices shown for the rest of the KST day
 * (localStorage, per notice id); 닫기 hides the modal for this browser session (sessionStorage, per placement).
 * Standalone on purpose (no app imports, own styles): the landing page loads it as a plain module from /assets/shared/. */
const HIDE_KEY = 'relai.notice.hide';          // { [noticeId]: 'YYYY-MM-DD' (KST day it was hidden) }
const SEEN_KEY = (p) => `relai.notice.seen.${p}`;
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const store = (s) => { try { return window[s]; } catch { return null; } };   // storage can throw (privacy modes, sandboxed frames)
const readHidden = () => { try { return JSON.parse(store('localStorage')?.getItem(HIDE_KEY) || '{}') || {}; } catch { return {}; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function hiddenToday(id) { return readHidden()[id] === todayKst(); }
export function hideToday(ids) {
  const today = todayKst(); const h = readHidden();
  for (const k of Object.keys(h)) if (h[k] !== today) delete h[k];   // drop older days so the key never grows
  for (const id of ids) h[id] = today;
  try { store('localStorage')?.setItem(HIDE_KEY, JSON.stringify(h)); } catch { /* full / blocked: the modal still closes */ }
}

const CSS = `
.ntp{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(16,24,40,.55);animation:ntp-in .18s ease-out}
@keyframes ntp-in{from{opacity:0}to{opacity:1}}
.ntp__d{outline:none;position:relative;width:min(560px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 24px 64px -12px rgba(16,24,40,.45);font-family:Pretendard,'Pretendard Variable',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif}
.ntp__v{position:relative;flex:1 1 auto;min-height:0;background:#F2F4F7;overflow:hidden}
.ntp__track{display:flex;height:100%;transition:transform .28s ease}
.ntp__s{flex:0 0 100%;display:flex;align-items:center;justify-content:center;margin:0}
.ntp__s img{display:block;width:100%;height:auto;max-height:calc(100vh - 120px);object-fit:contain}
.ntp__s a{display:block;width:100%}
.ntp__nav{position:absolute;top:50%;transform:translateY(-50%);width:36px;height:36px;border-radius:50%;border:0;background:rgba(255,255,255,.9);color:#101828;font-size:18px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(16,24,40,.18);display:grid;place-items:center}
.ntp__nav:hover{background:#fff}.ntp__nav:focus-visible,.ntp__dot:focus-visible{outline:2px solid #2E51C4;outline-offset:2px}.ntp__f button:focus-visible{outline:2px solid #2E51C4;outline-offset:-3px}
.ntp__prev{left:10px}.ntp__next{right:10px}
.ntp__cnt{position:absolute;right:12px;bottom:10px;padding:3px 9px;border-radius:999px;background:rgba(16,24,40,.6);color:#fff;font-size:12px;font-weight:600}
.ntp__dots{position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;gap:6px;pointer-events:none}
.ntp__dot{pointer-events:auto;width:8px;height:8px;padding:0;border-radius:999px;border:0;background:rgba(255,255,255,.65);box-shadow:0 0 0 1px rgba(16,24,40,.15);cursor:pointer;transition:width .2s}
.ntp__dot[aria-current=true]{width:20px;background:#2E51C4}
.ntp__f{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;border-top:1px solid #EAECF0;background:#fff}
.ntp__f button{flex:1;min-height:48px;border:0;background:none;font:inherit;font-size:14px;font-weight:600;color:#475467;cursor:pointer}
.ntp__f button+button{border-left:1px solid #EAECF0}
.ntp__f button:hover{background:#F8FAFD;color:#101828}
.ntp__f .ntp__close{color:#101828}
.ntp .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){.ntp{padding:12px}.ntp__d{border-radius:14px}}
`;
let styled = false;
const style = () => { if (styled) return; styled = true; const s = document.createElement('style'); s.dataset.noticePopup = ''; s.textContent = CSS; document.head.append(s); };

/**
 * Shows the modal for `notices` ({ id, title, image_url }[]). Hidden-today ones are skipped. Returns the element or null.
 * opts.detailHref(n) → wraps the image in a link (app: the notice in 공지사항); opts.onClose().
 */
export function openNoticePopup(notices, { detailHref = null, onClose = null, respectHidden = true } = {}) {
  const list = (notices || []).filter((n) => n.image_url && !(respectHidden && hiddenToday(n.id)));
  if (!list.length || document.querySelector('.ntp, .scrim')) return null;   // never on top of another dialog (onboarding, a form)
  style();
  const many = list.length > 1;
  const el = document.createElement('div'); el.className = 'ntp'; el.dataset.noticePopup = '';
  el.innerHTML = `<div class="ntp__d" tabindex="-1" role="dialog" aria-modal="true" aria-label="공지사항">
    <div class="ntp__v"><div class="ntp__track">${list.map((n, i) => {
      const img = `<img src="${esc(n.image_url)}" alt="${esc(n.title)}" ${i ? 'loading="lazy"' : ''} draggable="false">`;
      const href = detailHref ? detailHref(n) : null;
      return `<figure class="ntp__s" aria-roledescription="slide" aria-label="${i + 1} / ${list.length}">${href ? `<a href="${esc(href)}" data-link data-ntp-link>${img}</a>` : img}</figure>`;
    }).join('')}</div>
    ${many ? `<button type="button" class="ntp__nav ntp__prev" data-ntp-prev aria-label="이전 공지">‹</button><button type="button" class="ntp__nav ntp__next" data-ntp-next aria-label="다음 공지">›</button>
      <div class="ntp__dots">${list.map((n, i) => `<button type="button" class="ntp__dot" data-ntp-go="${i}" aria-label="${i + 1}번째 공지: ${esc(n.title)}"></button>`).join('')}</div>` : ''}
    <span class="sr" aria-live="polite" data-ntp-live></span></div>
    <div class="ntp__f"><button type="button" data-ntp-today>오늘 하루 보지 않기</button><button type="button" class="ntp__close" data-ntp-close>닫기</button></div>
  </div>`;
  const track = el.querySelector('.ntp__track'); const live = el.querySelector('[data-ntp-live]');
  let at = 0;
  const go = (i) => {
    at = (i + list.length) % list.length;
    track.style.transform = `translateX(${-100 * at}%)`;
    el.querySelectorAll('.ntp__dot').forEach((d, k) => d.setAttribute('aria-current', String(k === at)));
    el.querySelectorAll('.ntp__s').forEach((s, k) => { s.inert = k !== at; s.setAttribute('aria-hidden', String(k !== at)); });
    if (many) live.textContent = `${at + 1} / ${list.length}: ${list[at].title}`;
  };
  const opener = document.activeElement;
  const close = () => { document.removeEventListener('keydown', onKey, true); el.remove(); if (opener && opener.focus) try { opener.focus(); } catch { /* gone */ } if (onClose) onClose(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (many && e.key === 'ArrowRight') go(at + 1);
    else if (many && e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Tab') {   // keep focus inside the modal
      const f = [...el.querySelectorAll('button, a[href]')].filter((x) => !x.closest('[inert]'));
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-ntp-close]')) return close();
    if (e.target.closest('[data-ntp-today]')) { hideToday(list.map((n) => n.id)); return close(); }
    if (e.target.closest('[data-ntp-prev]')) return go(at - 1);
    if (e.target.closest('[data-ntp-next]')) return go(at + 1);
    const d = e.target.closest('[data-ntp-go]'); if (d) return go(Number(d.dataset.ntpGo));
    if (e.target.closest('[data-ntp-link]')) close();   // the link navigates (the app router picks up data-link clicks too)
  });
  let x0 = null;   // swipe on touch screens
  el.querySelector('.ntp__v').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  el.querySelector('.ntp__v').addEventListener('touchend', (e) => { if (x0 == null || !many) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 40) go(at + (dx < 0 ? 1 : -1)); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(el);
  go(0);
  el.querySelector('.ntp__d').focus({ preventScroll: true });   // the dialog itself: no focus ring on a button before any key is pressed
  return el;
}

/** Fetches the popup notices for `placement` and opens them once per browser session (closing marks the session as seen). */
export async function showNoticePopup(placement, opts = {}) {
  const ss = store('sessionStorage');
  try { if (ss?.getItem(SEEN_KEY(placement))) return null; } catch { /* ignore */ }
  let notices;
  try {
    const r = await fetch(`/api/notices/popup?placement=${encodeURIComponent(placement)}`, { credentials: 'same-origin' });
    if (!r.ok) return null;
    notices = (await r.json()).notices || [];
  } catch { return null; }   // never break the page over a notice
  if (opts.stillWanted && !opts.stillWanted()) return null;   // the user already left the page
  return openNoticePopup(notices, { ...opts, onClose: () => { try { ss?.setItem(SEEN_KEY(placement), '1'); } catch { /* ignore */ } if (opts.onClose) opts.onClose(); } });
}
