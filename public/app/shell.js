import { api } from './core/api.js';
import { $, html, raw, root } from './core/dom.js';
import { state } from './core/state.js';

export const icon = {
  home: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9.5 10 3l7 6.5V17H12v-5H8v5H3z" stroke-linejoin="round"/></svg>',
  projects: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14"/></svg>',
  settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" stroke-linecap="round"/></svg>',
  logout: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3H4v14h4M12 6l4 4-4 4M16 10H8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export async function shell(path, view) {
  if (!$('.shell')) {
    root.innerHTML = html`<div class="shell">
      <header class="topbar"><a class="logo" href="/app" data-link>RELAI</a><button id="menu" aria-label="메뉴">☰</button></header>
      <aside class="side" id="side">
        <a class="logo" href="/app" data-link>RELAI</a>
        <nav aria-label="주요 메뉴">
          <a class="navlink" data-nav="home" href="/app" data-link>${raw(icon.home)}Home</a>
          <a class="navlink" data-nav="projects" href="/app/projects" data-link>${raw(icon.projects)}Projects</a>
        </nav>
        <div class="side__bottom">
          <a class="navlink" data-nav="settings" href="/app/settings" data-link>${raw(icon.settings)}Settings</a>
          <div class="me"><span class="avatar">${[...state.user.name][0]}</span>
            <div style="min-width:0"><b>${state.user.name}</b><small>${state.user.email}</small></div></div>
          <button class="navlink linkbtn" id="logout">${raw(icon.logout)}Logout</button>
        </div>
      </aside>
      <main class="main" id="main"></main></div>`;
    $('#menu').onclick = () => $('#side').classList.toggle('is-open');
    $('#logout').onclick = async () => {
      try { await api('POST', '/api/auth/logout', {}); } finally { state.user = null; location.href = '/login'; }
    };
  }
  $('#side').classList.remove('is-open');
  const key = path === '/app' || path === '/app/' ? 'home' : path.startsWith('/app/projects') ? 'projects' : path.startsWith('/app/settings') ? 'settings' : '';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('is-active', a.dataset.nav === key));
  const main = $('#main');
  main.innerHTML = '<div class="loading">불러오는 중…</div>';
  window.scrollTo(0, 0);
  try { await view(main); } catch (e) { main.innerHTML = html`<div class="page"><div class="empty"><h2>${e.status === 404 ? '찾을 수 없습니다' : '문제가 발생했습니다'}</h2><p>${e.message}</p><a class="btn btn--primary" href="/app/projects" data-link>프로젝트로 돌아가기</a></div></div>`; }
}
