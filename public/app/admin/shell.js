/* Admin Console shell: "RELAI Admin" header + operator sidebar. Never shows the product's project navigation.
 * The server already refuses /admin and /api/admin/* to non-operators; this check only avoids a broken page. */
import { api } from '../core/api.js';
import { $, html, raw, root } from '../core/dom.js';
import { state } from '../core/state.js';

const NAV = [['/admin', 'Dashboard', /^\/admin\/?$/], ['/admin/users', 'Users', /^\/admin\/users/], ['/admin/workspaces', 'Workspaces', /^\/admin\/workspaces/], ['/admin/subscriptions', 'Subscriptions', /^\/admin\/subscriptions/],
  ['/admin/payments', 'Payments', /^\/admin\/payments/], ['/admin/usage', 'Usage', /^\/admin\/usage/], ['/admin/integrations', 'Integrations', /^\/admin\/integrations/], ['/admin/audit', 'Audit', /^\/admin\/audit/]];

export async function adminShell(path, view) {
  if (!state.user || state.user.system_role !== 'SYSTEM_ADMIN') {
    root.innerHTML = html`<div class="page"><div class="empty"><h2>403 — 운영자 권한이 필요합니다.</h2><a class="btn btn--primary" href="/app" data-link>앱으로 돌아가기</a></div></div>`;
    return;
  }
  if (!$('.ashell')) {
    root.innerHTML = html`<div class="ashell">
      <aside class="aside" id="aside">
        <div class="aside__brand"><a href="/admin" data-link>RELAI <em>Admin</em></a><button class="aside__menu" id="amenu" aria-label="메뉴">☰</button></div>
        <nav class="aside__nav" aria-label="Admin 메뉴">${raw(NAV.map(([href, label]) => html`<a href="${href}" data-link data-anav="${href}">${label}</a>`).join(''))}</nav>
        <div class="aside__foot"><a href="/app" data-link>← RELAI 앱으로</a><div class="aside__me"><b>${state.user.name}</b><small>${state.user.email}</small></div><button class="linkbtn" id="alogout">Logout</button></div>
      </aside>
      <main class="amain" id="main"></main></div>`;
    $('#alogout').onclick = async () => { try { await api('POST', '/api/auth/logout', {}); } finally { state.user = null; location.href = '/login'; } };
    $('#amenu').onclick = () => $('#aside').classList.toggle('is-open');
  }
  document.querySelectorAll('[data-anav]').forEach((a) => { const nav = NAV.find((x) => x[0] === a.dataset.anav); a.classList.toggle('is-active', nav[2].test(path)); });
  $('#aside').classList.remove('is-open');
  const main = $('#main');
  main.innerHTML = '<div class="loading">불러오는 중…</div>';
  window.scrollTo(0, 0);
  try { await view(main); }
  catch (e) { main.innerHTML = html`<div class="apage"><div class="empty"><h2>${e.status === 404 ? '찾을 수 없습니다' : e.status === 403 ? '권한이 없습니다' : '문제가 발생했습니다'}</h2><p>${e.message}</p><a class="btn btn--secondary" href="/admin" data-link>Dashboard</a></div></div>`; }
}
