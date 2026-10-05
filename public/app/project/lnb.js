/* Project LNB (Lifecycle V2) — the primary navigation inside a project.
 *
 *   PROJECT HOME        What's Next · Overview ▾ (프로젝트 현황 · Project Chater · WBS · 주간보고 · 일정/마일스톤 · Project Health)
 *   PROJECT LIFECYCLE   01…07 as an accordion: current phase open + blue bar, completed phases ✓ green, future gray
 *   PROJECT MANAGEMENT  Changes · Issues & Risks · Activity · Reports
 *
 * Rendered into the shell's <aside id="side"> by projectHead() on every project screen, so the same payload (g) that
 * drives What's Next drives the menu. Expanded / collapsed (icons + phase numbers) is a persisted preference. */
import { $, html, no2, raw } from '../core/dom.js';
import { store } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { HOME_ITEMS, PHASE_ITEMS, PM_ITEMS, phaseOfPath } from '../shared/lifecycle.js';
import { phaseState, phaseTip } from './status.js';

const ICON = {
  next: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 10h11M11 5l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  overview: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 16V9M8 16V4M13 16v-5M18 16V7" stroke-linecap="round"/></svg>',
  changes: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h10l-3-3M16 13H6l3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  raid: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 3l8 14H2z" stroke-linejoin="round"/><path d="M10 8v4M10 14.5v.5" stroke-linecap="round"/></svg>',
  activity: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2" stroke-linecap="round"/></svg>',
  reports: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 3h7l3 3v11H5z" stroke-linejoin="round"/><path d="M8 10h4M8 13h4" stroke-linecap="round"/></svg>',
};

/** user-opened / closed groups for this project; current phase is open unless the user closed it. */
const openKey = (pid) => `lnb.open.${pid}`;
const openState = (pid) => store.get(openKey(pid), {});
const setOpen = (pid, key, v) => { const o = openState(pid); o[key] = v; store.set(openKey(pid), o); };

const link = (it, active, { tour = null, cls = '' } = {}) => it.action
  ? html`<button type="button" class="lnb__i ${cls}" data-lnb-action="${it.action}" title="${it.label}">${raw(ICON[it.key] ? `<i class="lnb__ic">${ICON[it.key]}</i>` : '')}<span class="lnb__t">${it.label}</span></button>`
  : html`<a class="lnb__i ${active ? 'is-active' : ''} ${cls}" href="${it.href}" data-link title="${it.label}" ${tour ? `data-tour-id="${tour}"` : ''}>${raw(ICON[it.key] ? `<i class="lnb__ic">${ICON[it.key]}</i>` : '')}<span class="lnb__t">${it.label}</span></a>`;

export function projectNav(p, g, activeKey) {
  const pid = p.id; const path = location.pathname; const qs = new URLSearchParams(location.search);
  const isActive = (it) => (activeKey ? it.key === activeKey : Boolean(it.match && it.match(path, qs)));
  const open = openState(pid);
  const curKey = g.current_phase ? g.current_phase.phase_key : null;
  const pathPhase = phaseOfPath(pid, path, qs) || (activeKey && Object.keys(PHASE_ITEMS).find((k) => PHASE_ITEMS[k](pid).some((it) => it.key === activeKey))) || null;

  const home = HOME_ITEMS(pid);
  const ovOpen = open.overview !== undefined ? open.overview : (home[1].children.some(isActive) || path.includes('/overview'));
  const homeHtml = html`<div class="lnb__sec"><div class="lnb__h">PROJECT HOME</div>
    ${raw(link(home[0], isActive(home[0]), { tour: 'lnb-next' }))}
    <div class="lnb__grp ${ovOpen ? 'is-open' : ''}" data-grp="overview">
      <div class="lnb__row">${raw(link(home[1], isActive(home[1]) || (!ovOpen && home[1].children.some(isActive)), { tour: 'lnb-overview' }))}<button type="button" class="lnb__tg" data-lnb-toggle="overview" aria-label="Overview 하위 메뉴 ${ovOpen ? '접기' : '펼치기'}" aria-expanded="${ovOpen}"></button></div>
      <div class="lnb__sub">${raw(home[1].children.map((c) => link(c, isActive(c), { cls: 'lnb__i--sub' })).join(''))}</div>
    </div></div>`;

  const phases = (g.phases || []).map((ph) => {
    const items = (PHASE_ITEMS[ph.phase_key] ? PHASE_ITEMS[ph.phase_key](pid) : []).filter((it) => it.enabled !== false);
    const state = phaseState(ph);   // a phase left for a later one shows as ended (✓), same as the stepper
    const isOpen = open[ph.phase_key] !== undefined ? open[ph.phase_key] : (ph.is_current || pathPhase === ph.phase_key);
    const reqOpen = ph.summary ? ph.summary.required_open : 0;
    return html`<div class="lnb__ph is-${state} ${isOpen ? 'is-open' : ''} ${items.length ? '' : 'is-leaf'}" data-grp="${ph.phase_key}">
      <button type="button" class="lnb__phh" data-lnb-toggle="${ph.phase_key}" data-phase-href="/app/projects/${pid}${ph.is_current ? '' : `?phase=${ph.phase_key}`}" aria-expanded="${isOpen}" title="${no2(ph.sequence)} ${ph.name} · ${phaseTip(ph)} — 업무 목록 보기">
        <i class="lnb__mark" aria-hidden="true">${state === 'done' ? '✓' : no2(ph.sequence)}</i>
        <span class="lnb__t"><span class="lnb__pn">${ph.name}</span></span>
        ${raw(state === 'cur' && reqOpen ? html`<span class="lnb__n" title="필수 업무 ${reqOpen}건 남음">${reqOpen}</span>` : '')}
        ${raw(items.length ? '<span class="lnb__chev" aria-hidden="true"></span>' : '')}
      </button>
      ${raw(items.length ? html`<div class="lnb__sub">${raw(items.map((it, i) => link(it, isActive(it), { cls: 'lnb__i--sub', tour: i === 0 ? `lnb-${it.key}` : it.key === 'wbs' || it.key === 'tests' || it.key === 'requirements' || it.key === 'definition' ? `lnb-${it.key}` : null })).join(''))}</div>` : '')}
    </div>`;
  }).join('');

  const pm = PM_ITEMS(pid);
  return html`<nav class="lnb" aria-label="프로젝트 메뉴">
    <a class="lnb__back" href="/app/projects" data-link title="프로젝트 목록"><span class="lnb__ic">‹</span><span class="lnb__t">프로젝트</span></a>
    ${raw(homeHtml)}
    <div class="lnb__sec lnb__sec--lc" data-tour-id="lnb-lifecycle"><div class="lnb__h">PROJECT LIFECYCLE</div>${raw(phases)}</div>
    <div class="lnb__sec"><div class="lnb__h">PROJECT MANAGEMENT</div>${raw(pm.map((it) => link(it, isActive(it), { tour: `lnb-${it.key}` })).join(''))}</div>
  </nav>`;
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-lnb-toggle]');
    // Phase name → that phase's activity list on What's Next (and open its menu). Only the chevron just folds/unfolds.
    if (tg && tg.dataset.phaseHref && !e.target.closest('.lnb__chev')) {
      const grp = tg.closest('[data-grp]'); const pidEl = grp && grp.closest('[data-lnb-pid]');
      if (grp && !grp.classList.contains('is-open') && !grp.classList.contains('is-leaf')) { grp.classList.add('is-open'); tg.setAttribute('aria-expanded', 'true'); if (pidEl) setOpen(pidEl.dataset.lnbPid, tg.dataset.lnbToggle, true); }
      if (location.pathname + location.search !== tg.dataset.phaseHref) navigate(tg.dataset.phaseHref);
      return;
    }
    if (tg) {
      const grp = tg.closest('[data-grp]'); const pid = grp && grp.closest('[data-lnb-pid]') ? grp.closest('[data-lnb-pid]').dataset.lnbPid : null;
      const openNow = !grp.classList.contains('is-open');
      grp.classList.toggle('is-open', openNow); tg.setAttribute('aria-expanded', String(openNow));
      if (pid) setOpen(pid, tg.dataset.lnbToggle, openNow);
      return;
    }
    const ac = e.target.closest('[data-lnb-action]');
    if (ac) {
      if (ac.dataset.lnbAction === 'activity') { const b = document.querySelector('.wsh__act [data-act="activity"]'); if (b) b.click(); }
    }
  });
}

/** Put the project LNB into the shell's sidebar. */
export function mountLnb(p, g, activeKey = null) {
  wire();
  const side = $('#side'); if (!side) return;
  side.classList.add('side--project');
  side.innerHTML = html`<div class="lnb__wrap" data-lnb-pid="${p.id}">${raw(projectNav(p, g, activeKey))}</div>
    <div class="side__bottom side__bottom--project">
      <a class="navlink" href="/app" data-link title="Home"><span class="lnb__ic">⌂</span><span class="nl">Home</span></a>
      <a class="navlink" href="/app/settings" data-link title="Settings"><span class="lnb__ic">⚙</span><span class="nl">Settings</span></a>
      <button type="button" class="navlink linkbtn side__fold" id="fold" title="메뉴 접기/펼치기"><span class="lnb__ic">⇤</span><span class="nl">메뉴 접기</span></button>
    </div>`;
  const fold = $('#fold', side);
  if (fold) fold.onclick = () => { const c = !store.get('nav.collapsed', false); store.set('nav.collapsed', c); document.querySelector('.shell').classList.toggle('is-collapsed', c); };
  const act = side.querySelector('.lnb__i.is-active'); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}
