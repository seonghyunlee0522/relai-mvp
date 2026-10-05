import { api } from './core/api.js';
import { isCurrent } from './core/router.js';
import { $, html, raw, root } from './core/dom.js';
import { state } from './core/state.js';
import { store } from './core/ui.js';
import { helpButton, wireHelp, maybeWelcome } from './onboarding/ui.js';
import { tour } from './onboarding/tour.js';
import { ob } from './onboarding/state.js';

export const icon = {
  home: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9.5 10 3l7 6.5V17H12v-5H8v5H3z" stroke-linejoin="round"/></svg>',
  projects: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14"/></svg>',
  settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" stroke-linecap="round"/></svg>',
  logout: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3H4v14h4M12 6l4 4-4 4M16 10H8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  admin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.5 16 5v4.5c0 3.7-2.6 6.6-6 8-3.4-1.4-6-4.3-6-8V5z" stroke-linejoin="round"/><path d="M7.5 10l1.8 1.8L12.8 8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  collapse: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M11 5 6 10l5 5M15 4v12" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** Project Workspace = any screen inside a project (not the "new project" form). Global navigation stays folded away there. */
export const isWorkspacePath = (path) => /^\/app\/projects\/(?!new(\/|$))[\w-]+/.test(path) && !/\/edit\/?$/.test(path);

const closeNav = () => { const s = $('#side'); if (s) s.classList.remove('is-open'); const sc = $('#sidescrim'); if (sc) sc.hidden = true; };
const toggleNav = () => { const s = $('#side'); if (!s) return; const open = !s.classList.contains('is-open'); s.classList.toggle('is-open', open); $('#sidescrim').hidden = !open; };

let wired = false;
function wireOnce() {
  if (wired) return; wired = true;
  document.addEventListener('click', (e) => { if (e.target.closest('[data-ws-menu]')) toggleNav(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#side') && $('#side').classList.contains('is-open')) closeNav(); });
}

/** Global navigation (outside a project). Inside a project the sidebar holds the project LNB (project/lnb.js). */
const globalNav = () => html`<a class="logo" href="/app" data-link><span class="logo__full">RELAI</span><span class="logo__mark">R</span></a>
  <nav aria-label="주요 메뉴">
    <a class="navlink" data-nav="home" href="/app" data-link title="Home" data-tour-id="nav-home">${raw(icon.home)}<span class="nl">Home</span></a>
    <a class="navlink" data-nav="projects" href="/app/projects" data-link title="Projects" data-tour-id="nav-projects">${raw(icon.projects)}<span class="nl">Projects</span></a>
  </nav>
  <div class="side__bottom">
    <a class="navlink" data-nav="settings" href="/app/settings" data-link title="Settings" data-tour-id="nav-settings">${raw(icon.settings)}<span class="nl">Settings</span></a>
    <div class="navlink navlink--help">${raw(helpButton())}<span class="nl">도움말</span></div>
    ${raw(state.user.system_role === 'SYSTEM_ADMIN' ? html`<a class="navlink navlink--admin" href="/admin" data-link title="Admin Console">${raw(icon.admin)}<span class="nl">Admin Console</span></a>` : '')}
    <div class="me"><span class="avatar">${[...state.user.name][0]}</span>
      <div class="me__t" style="min-width:0"><b>${state.user.name}</b><small>${state.user.email}</small></div></div>
    <button class="navlink linkbtn" id="logout" title="Logout">${raw(icon.logout)}<span class="nl">Logout</span></button>
    <button class="navlink linkbtn side__fold" id="fold" title="메뉴 접기/펼치기">${raw(icon.collapse)}<span class="nl">메뉴 접기</span></button>
  </div>`;

/** Compact in-app footer (§40): name + copyright + contact. The detailed business footer lives on the landing page only. */
export const appFooter = () => html`<footer class="appfoot"><span>RELAI · © ${new Date().getFullYear()}</span><a href="mailto:enj.shlee@gmail.com">문의</a></footer>`;

const wireSideButtons = () => {
  const lo = $('#logout'); if (lo) lo.onclick = async () => { try { await api('POST', '/api/auth/logout', {}); } finally { state.user = null; location.href = '/login'; } };
  const fo = $('#fold'); if (fo) fo.onclick = () => { const c = !store.get('nav.collapsed', false); store.set('nav.collapsed', c); $('.shell').classList.toggle('is-collapsed', c); };
};

export async function shell(path, view, token = null) {
  const stale = () => token !== null && !isCurrent(token);
  wireOnce();
  if (!$('.shell')) {
    root.innerHTML = html`<div class="shell">
      <header class="topbar"><a class="logo" href="/app" data-link>RELAI</a><span class="topbar__r">${raw(helpButton())}<button id="menu" aria-label="메뉴">☰</button></span></header>
      <aside class="side" id="side"></aside>
      <div class="sidescrim" id="sidescrim" hidden></div>
      <div class="maincol"><main class="main" id="main"></main>${raw(appFooter())}</div></div>`;
    $('#menu').onclick = toggleNav;
    wireHelp(root);
    $('#sidescrim').onclick = closeNav;
  }
  const sh = $('.shell'); const side = $('#side');
  const ws = isWorkspacePath(path);
  sh.classList.toggle('shell--ws', ws);
  sh.classList.toggle('is-collapsed', store.get('nav.collapsed', false));
  if (!ws) {
    // leaving a project (or first paint): global navigation. Inside a project the page's projectHead() mounts the LNB.
    if (side.classList.contains('side--project') || !side.childElementCount) { side.classList.remove('side--project'); side.innerHTML = globalNav(); wireSideButtons(); wireHelp(side); }
  } else if (!side.classList.contains('side--project')) {
    side.classList.add('side--project'); side.innerHTML = '<div class="lnb__wrap"><div class="loading loading--sm">불러오는 중…</div></div>';
  }
  closeNav();
  const key = path === '/app' || path === '/app/' ? 'home' : path.startsWith('/app/projects') ? 'projects' : path.startsWith('/app/settings') ? 'settings' : '';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('is-active', a.dataset.nav === key));
  const main = $('#main');
  main.innerHTML = '<div class="loading">불러오는 중…</div>';
  window.scrollTo(0, 0);
  if (state.workspace && state.workspace.status === 'SUSPENDED') {
    main.innerHTML = html`<div class="page"><div class="empty"><h2>정지된 Workspace입니다</h2><p>'${state.workspace.name}'은(는) 운영자에 의해 정지되어 조회와 수정이 차단됩니다. 데이터는 그대로 보관되어 있습니다. 문의는 운영자에게 해 주세요.</p><a class="btn btn--secondary" href="/app" data-link>Home</a></div></div>`;
    return;
  }
  if (!ob.peek()) await ob.get();   // Phase 14: one onboarding request per workspace, before the page decides what to guide
  if (stale()) return;              // BUG-001: a newer navigation already owns #main
  try { await view(main); } catch (e) { main.innerHTML = html`<div class="page"><div class="empty"><h2>${e.status === 404 ? '찾을 수 없습니다' : '문제가 발생했습니다'}</h2><p>${e.message}</p><a class="btn btn--primary" href="/app/projects" data-link>프로젝트로 돌아가기</a></div></div>`; }
  if (stale()) return;
  // Phase 14: pages are rendered → first-login welcome (once), resume an in-progress tour, help button inside the workspace header
  wireHelp(main);
  document.dispatchEvent(new CustomEvent('relai:rendered', { detail: { path } }));
  if (!welcomed) { welcomed = true; maybeWelcome().then(() => tour.onRender()); } else tour.onRender();
}
let welcomed = false;
