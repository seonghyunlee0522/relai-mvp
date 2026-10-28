/* Rail flyout (desktop, hover devices): hovering a rail item shows its sub-menu next to the rail so any tab is one click away.
 * Project rail → the door's tabs (DOORS in shared/lifecycle.js, current tab marked). Global rail → 프로젝트: projects in progress
 * (fetched once per workspace on first hover) + 전체 보기 / 새 프로젝트. One fixed element in <body>: the rail scrolls (overflow-y),
 * an absolutely placed child would be clipped. Keyboard: → or Enter-less focus opens it from a focused item, ↑↓ move, Esc / ← close. */
import { api, wsApi } from './core/api.js';
import { html, raw } from './core/dom.js';
import { state } from './core/state.js';
import { DOORS, doorOf } from './shared/lifecycle.js';

const OPEN_DELAY = 80; const CLOSE_DELAY = 180;
let fly = null; let anchor = null; let tOpen = 0; let tClose = 0;
let projCache = { wid: null, list: null, at: 0 };

const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const el = () => {
  if (fly) return fly;
  fly = document.createElement('div'); fly.className = 'rfly'; fly.hidden = true; fly.setAttribute('role', 'menu');
  fly.addEventListener('mouseenter', () => clearTimeout(tClose));
  fly.addEventListener('mouseleave', () => scheduleClose());
  fly.addEventListener('click', (e) => { if (e.target.closest('a')) hide(); });   // the router handles the data-link click
  fly.addEventListener('keydown', onFlyKey);
  document.body.append(fly);
  return fly;
};

function hide() {
  clearTimeout(tOpen); clearTimeout(tClose);
  if (fly) fly.hidden = true;
  if (anchor) anchor.removeAttribute('aria-expanded');
  anchor = null;
}
const scheduleClose = () => { clearTimeout(tClose); tClose = setTimeout(hide, CLOSE_DELAY); };

async function projectsItems() {
  const wid = state.workspace && state.workspace.id; if (!wid) return [];
  if (projCache.wid !== wid || !projCache.list || Date.now() - projCache.at > 60_000) {
    try { const r = await api('GET', wsApi('')); projCache = { wid, list: r.projects || [], at: Date.now() }; } catch { return []; }
  }
  return projCache.list.filter((p) => !['COMPLETED', 'ARCHIVED', 'CANCELLED'].includes(p.status)).slice(0, 8);
}

/** { title, items: [{ label, href, active }], foot: [{ label, href }] } for the hovered rail item, or null (no sub-menu). */
async function menuFor(a) {
  const door = a.dataset.door; const pid = a.closest('#rail')?.dataset.pid;
  if (pid) {
    const d = DOORS(pid).find((x) => x.key === door);
    if (!d || !d.tabs.length) return null;
    const cur = doorOf(pid, location.pathname, new URLSearchParams(location.search));
    return { title: d.label, items: d.tabs.map((t) => ({ label: t.label, href: t.href, active: cur.door === d.key && cur.tab === t.key })) };
  }
  if (door === 'projects') {
    const list = await projectsItems();
    const manage = state.workspace && state.workspace.role !== 'MEMBER';
    return { title: '프로젝트', items: list.map((p) => ({ label: p.name, href: `/app/projects/${p.id}`, active: location.pathname.startsWith(`/app/projects/${p.id}`) })),
      empty: '진행 중인 프로젝트가 없습니다.', foot: [{ label: '전체 보기', href: '/app/projects' }, ...(manage ? [{ label: '+ 새 프로젝트', href: '/app/projects/new' }] : [])] };
  }
  return null;
}

async function show(a, { focus = false } = {}) {
  const m = await menuFor(a);
  if (!m || !a.isConnected) { if (anchor === a) hide(); return; }
  const f = el();
  f.innerHTML = html`<div class="rfly__h">${m.title}</div>
    ${raw(m.items.length ? html`<div class="rfly__l">${raw(m.items.map((i) => html`<a class="rfly__i ${i.active ? 'is-active' : ''}" role="menuitem" href="${i.href}" data-link ${raw(i.active ? 'aria-current="page"' : '')}>${i.label}</a>`).join(''))}</div>` : html`<p class="rfly__e">${m.empty || ''}</p>`)}
    ${raw(m.foot ? html`<div class="rfly__f">${raw(m.foot.map((i) => html`<a class="rfly__i" role="menuitem" href="${i.href}" data-link>${i.label}</a>`).join(''))}</div>` : '')}`;
  if (anchor && anchor !== a) anchor.removeAttribute('aria-expanded');
  anchor = a; a.setAttribute('aria-expanded', 'true');
  f.hidden = false;
  const r = a.getBoundingClientRect(); const rail = a.closest('#rail').getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top - 6, innerHeight - f.offsetHeight - 8));
  f.style.left = `${rail.right + 6}px`; f.style.top = `${top}px`;
  if (focus) f.querySelector('a')?.focus();
}

function onFlyKey(e) {
  const links = [...fly.querySelectorAll('a')]; const i = links.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); links[(i + 1) % links.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); links[(i - 1 + links.length) % links.length]?.focus(); }
  else if (e.key === 'Escape' || e.key === 'ArrowLeft') { e.preventDefault(); const a = anchor; hide(); a?.focus(); }
  else if (e.key === 'Tab') { const a = anchor; hide(); if (a && !e.shiftKey) { e.preventDefault(); a.focus(); } }
}

let wired = false;
export function wireRailFlyout() {
  if (wired) return; wired = true;
  const item = (e) => e.target.closest?.('#rail .rail__nav .rail__i[data-door]');
  document.addEventListener('mouseover', (e) => {
    const a = item(e); if (!a || !canHover()) return;
    clearTimeout(tClose); if (anchor === a && fly && !fly.hidden) return;
    clearTimeout(tOpen); tOpen = setTimeout(() => show(a), anchor ? 0 : OPEN_DELAY);   // moving between items: switch at once
  });
  document.addEventListener('mouseout', (e) => {
    const a = item(e); if (!a) return;
    if (e.relatedTarget && (a.contains(e.relatedTarget) || fly?.contains(e.relatedTarget))) return;
    clearTimeout(tOpen); scheduleClose();
  });
  document.addEventListener('keydown', (e) => {
    const a = e.target.closest?.('#rail .rail__nav .rail__i[data-door]'); if (!a) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(a, { focus: true }); }
    else if (e.key === 'Escape') hide();
  });
  addEventListener('popstate', hide);
  addEventListener('scroll', hide, true);
  addEventListener('resize', hide);
  window.addEventListener('relai:navigate', hide);
}
/** The rail re-renders on navigation: a menu for the old item would point at a detached node. */
export const closeRailFlyout = hide;
