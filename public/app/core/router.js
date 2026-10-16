import { api } from './api.js';
import { state } from './state.js';
import { isPhone } from './device.js';

/* BUG-001: every navigation gets a sequence number. A render that awaited past a newer navigation must not paint
 * (shell checks isCurrent(token)), and late replaceState() calls use replaceIfCurrent() so they cannot drag the URL back. */
let navSeq = 0;
export const navToken = () => navSeq;
export const isCurrent = (token) => token === navSeq;
export function replaceIfCurrent(token, path) { if (isCurrent(token)) history.replaceState(null, '', path); }
/* GA4 (server/ga4.js) is only served on /login and /signup. The SPA moves on to /app with pushState, so switch the tag off for
 * good as soon as the path leaves those pages: no in-app page_view ever reaches Google. */
function gaGuard() { const id = window.RELAI_GA4; if (id && !['/login', '/signup'].includes(location.pathname)) window[`ga-disable-${id}`] = true; }
export function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  render();
}
/* Leave guard: a page holding unsaved input registers { dirty(), ask(), href() } (프로젝트 정의 drawer). In-app links and the
 * browser Back/Forward then ask first; render() drops the guard, so it only lives while that page is on screen. */
let leaveGuard = null;
export function setLeaveGuard(g) { leaveGuard = g; }
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  if (leaveGuard && leaveGuard.dirty() && !(await leaveGuard.ask())) return;
  navigate(a.getAttribute('href'));
});
/* Back/Forward with unsaved input: put the page's address back at once (pushState right after the entry the browser moved to),
 * then ask. Cancel = stay, nothing lost. Leave = history.back() lands on the entry the user was heading for. */
window.addEventListener('popstate', async () => {
  const g = leaveGuard;
  if (!g || !g.dirty()) return render();
  history.pushState(null, '', g.href());
  if (await g.ask()) { leaveGuard = null; history.back(); }
});
/* First-party screen view (server/analytics.js): the path only — ids are normalised server-side. Never awaited, never shown. */
let lastScreen = '';
function screenView(path) {
  if (!path.startsWith('/app') || path === lastScreen) return;
  lastScreen = path;
  try { fetch('/api/analytics/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }), credentials: 'same-origin', keepalive: true }).catch(() => {}); } catch { /* ignore */ }
}
export let routes = [];
export let shellFn = null; let authFn = null; let inviteFn = null; let accountFns = {};
export function registerRoutes(list, { shell, auth, invite = null, account = {} }) { routes = list; shellFn = shell; authFn = auth; inviteFn = invite; accountFns = account; }
export async function render() {
  const token = ++navSeq;
  leaveGuard = null;
  gaGuard();
  const path = location.pathname;
  if (/^\/(login|signup)\/?$/.test(path)) return authFn(path.startsWith('/signup') ? 'signup' : 'login');
  const acct = path.match(/^\/(forgot-password|reset-password|verify-email)\/?$/);   // account-security pages: with or without a session
  if (acct && accountFns[acct[1]]) return accountFns[acct[1]]();
  const inv = path.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/);   // public landing: works with or without a session
  if (inv && inviteFn) return inviteFn(inv[1]);
  if (!state.user) {
    try {
      const me = await api('GET', '/api/me?optional=1');
      if (!me.user) { location.href = '/login'; return; }   // logged out: no 401 in the console
      Object.assign(state, me); state.workspace = state.workspaces.find((w) => w.status !== 'SUSPENDED') || state.workspaces[0];
    } catch { return; }
  }
  // phone = view mode: creating/editing a project and the Admin Console are PC-only pages (spec §4)
  const pcOnly = isPhone() && (/^\/app\/projects\/new\/?$/.test(path) || /^\/app\/projects\/[\w-]+\/edit\/?$/.test(path) ? '프로젝트 만들기와 수정은 PC에서 할 수 있습니다.'
    : /^\/admin(\/|$)/.test(path) ? '운영자 콘솔은 PC에서 사용할 수 있습니다.' : '');
  if (pcOnly) return shellFn('/app/pc-only', (main) => { main.innerHTML = `<div class="page"><div class="empty pconly" data-pc-only><h2>${pcOnly}</h2><a class="link" href="/app" data-link>홈으로</a></div></div>`; }, token);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) { screenView(path); return shellFn(path, () => fn(...m.slice(1)), token); }
  }
  navigate('/app', { replace: true });
}
