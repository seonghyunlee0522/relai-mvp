import { api } from './api.js';
import { state } from './state.js';

/* BUG-001: every navigation gets a sequence number. A render that awaited past a newer navigation must not paint
 * (shell checks isCurrent(token)), and late replaceState() calls use replaceIfCurrent() so they cannot drag the URL back. */
let navSeq = 0;
export const navToken = () => navSeq;
export const isCurrent = (token) => token === navSeq;
export function replaceIfCurrent(token, path) { if (isCurrent(token)) history.replaceState(null, '', path); }
export function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);
export let routes = [];
export let shellFn = null; let authFn = null; let inviteFn = null;
export function registerRoutes(list, { shell, auth, invite = null }) { routes = list; shellFn = shell; authFn = auth; inviteFn = invite; }
export async function render() {
  const token = ++navSeq;
  const path = location.pathname;
  if (/^\/(login|signup)\/?$/.test(path)) return authFn(path.startsWith('/signup') ? 'signup' : 'login');
  const inv = path.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/);   // public landing: works with or without a session
  if (inv && inviteFn) return inviteFn(inv[1]);
  if (!state.user) {
    try { Object.assign(state, await api('GET', '/api/me')); state.workspace = state.workspaces.find((w) => w.status !== 'SUSPENDED') || state.workspaces[0]; }
    catch { return; }
  }
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) return shellFn(path, () => fn(...m.slice(1)), token);
  }
  navigate('/app', { replace: true });
}
