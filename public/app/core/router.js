import { api } from './api.js';
import { state } from './state.js';

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
export let shellFn = null; let authFn = null;
export function registerRoutes(list, { shell, auth }) { routes = list; shellFn = shell; authFn = auth; }
export async function render() {
  const path = location.pathname;
  if (/^\/(login|signup)\/?$/.test(path)) return authFn(path.startsWith('/signup') ? 'signup' : 'login');
  if (!state.user) {
    try { Object.assign(state, await api('GET', '/api/me')); state.workspace = state.workspaces.find((w) => w.status !== 'SUSPENDED') || state.workspaces[0]; }
    catch { return; }
  }
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) return shellFn(path, () => fn(...m.slice(1)));
  }
  navigate('/app', { replace: true });
}
