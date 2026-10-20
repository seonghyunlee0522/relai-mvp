/* Desktop frame (Redesign R1 — hive research/relai-redesign-spec.md §4): 56px top bar · 76px icon rail · section tabs ·
 * page header (title + phase chip + one purpose line + ≤1 primary + ≤2 secondary + ⋯).
 * Phone (< 768px) never uses this file's markup: it keeps the side sheet, the LNB and the bottom tab bar (shell.js). */
import { api, wsApi } from './core/api.js';
import { $, html, no2, raw } from './core/dom.js';
import { state } from './core/state.js';
import { helpButton, wireHelp } from './onboarding/ui.js';
import { DOORS, PHASE_ITEMS, doorOf } from './shared/lifecycle.js';
import { railFeedback } from './feedback.js';

const SV = (d) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const RAIL_ICON = {
  home: SV('<path d="M3 9.5 10 3l7 6.5V17H12v-5H8v5H3z"/>'),
  projects: SV('<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14"/>'),
  next: SV('<path d="M4 10h11M11 5l5 5-5 5"/>'),
  plan: SV('<rect x="4" y="3.5" width="12" height="14" rx="2"/><path d="M7.5 3.5v-1h5v1M7 9h6M7 12.5h4"/>'),
  requirements: SV('<path d="M7 5.5h9M7 10h9M7 14.5h9"/><circle cx="4" cy="5.5" r=".6"/><circle cx="4" cy="10" r=".6"/><circle cx="4" cy="14.5" r=".6"/>'),
  schedule: SV('<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2.5v3M13 2.5v3"/>'),
  tests: SV('<path d="M4.5 10.5l3.5 3.5 7.5-8"/>'),
  issues: SV('<path d="M10 3l8 14H2z"/><path d="M10 8v4M10 14.5v.5"/>'),
  reports: SV('<path d="M5 3h7l3 3v11H5z"/><path d="M8 10h4M8 13h4"/>'),
};

/* ---------- small accessible dropdown (top bar menus): Enter/Space opens, focus moves in, Esc closes and returns focus ---------- */
export function closeDmenus() { document.querySelectorAll('.dmenu').forEach((m) => m.remove()); document.querySelectorAll('[data-dmenu][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
function openDmenu(btn, inner, { align = 'left' } = {}) {
  closeDmenus();
  const m = document.createElement('div'); m.className = `dmenu dmenu--${align}`; m.setAttribute('role', 'menu'); m.innerHTML = inner;
  btn.parentElement.append(m); btn.setAttribute('aria-expanded', 'true');
  const first = m.querySelector('a,button'); if (first) first.focus();
  return m;
}
const items = (m) => [...m.querySelectorAll('a[role=menuitem],button[role=menuitem]')];
let wiredMenus = false;
function wireMenus() {
  if (wiredMenus) return; wiredMenus = true;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dmenu]');
    if (b) { if (b.getAttribute('aria-expanded') === 'true') { closeDmenus(); return; } MENUS[b.dataset.dmenu](b); return; }
    if (!e.target.closest('.dmenu') || e.target.closest('a[data-link],[data-logout]')) closeDmenus();
  });
  document.addEventListener('keydown', (e) => {
    const m = e.target.closest && e.target.closest('.dmenu');
    if (e.key === 'Escape' && document.querySelector('.dmenu')) { const open = document.querySelector('[data-dmenu][aria-expanded="true"]'); closeDmenus(); if (open) open.focus(); return; }
    if (!m || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault(); const list = items(m); const i = list.indexOf(document.activeElement);
    const n = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]; if (n) n.focus();
  });
}
const MENUS = {
  me(btn) {
    const u = state.user;
    openDmenu(btn, html`<div class="dmenu__who"><b>${u.name}</b><small>${u.email}</small></div>
      <a role="menuitem" href="/app/settings" data-link>설정</a>
      ${raw(u.system_role === 'SYSTEM_ADMIN' ? '<a role="menuitem" href="/admin" data-link>Admin Console</a>' : '')}
      <hr><button type="button" role="menuitem" data-logout>로그아웃</button>`, { align: 'right' });
  },
  async projects(btn) {
    const m = openDmenu(btn, '<div class="dmenu__h">프로젝트 전환</div><div class="dmenu__list"><span class="dmenu__empty">불러오는 중…</span></div><hr><a role="menuitem" href="/app/projects" data-link>모든 프로젝트 보기</a>');
    let list = [];
    try { list = (await api('GET', wsApi(''))).projects || []; } catch { /* the menu still offers 모든 프로젝트 */ }
    const box = m.querySelector('.dmenu__list'); if (!box || !m.isConnected) return;
    const cur = btn.dataset.pid;
    box.innerHTML = list.length ? list.slice(0, 12).map((p) => html`<a role="menuitem" href="/app/projects/${p.id}" data-link class="${p.id === cur ? 'is-cur' : ''}" ${raw(p.id === cur ? 'aria-current="true"' : '')}>${p.name}</a>`).join('') : '<span class="dmenu__empty">프로젝트가 없습니다.</span>';
  },
};

/* ---------- top bar ---------- */
/** Right side of the top bar: 이메일 인증 pill (only while unverified) · ? · avatar. The avatar menu is the one way to 설정 (fb-app: the ⚙ icon and 내 정보 went to the same page). Rebuilt on every shell() call. */
export function topbarRight() {
  const u = state.user;
  const pill = u && u.email_verified === false ? html`<button type="button" class="vpill" id="verify-pill" title="인증 전에는 팀원 초대와 결제를 할 수 없습니다 · 눌러서 인증 메일 다시 받기">이메일 인증 필요</button>` : '';
  return html`${raw(pill)}${raw(helpButton())}
    <span class="dmenuwrap"><button type="button" class="dtop__me" data-dmenu="me" aria-haspopup="menu" aria-expanded="false" aria-label="내 계정 메뉴 (설정)" title="${u.name} · 설정" data-tour-id="nav-settings">${[...u.name][0]}</button></span>`;
}
export function mountTopbar() {
  wireMenus();
  const r = $('#dtop-r'); if (!r) return;
  r.innerHTML = topbarRight(); wireHelp(r);
  const vp = $('#verify-pill');
  if (vp) vp.onclick = async () => {
    vp.disabled = true;
    try { const res = await api('POST', '/api/auth/email/resend', {}); vp.textContent = res.already_verified ? '이미 인증되었습니다' : '인증 메일을 보냈습니다'; }
    catch (e) { vp.textContent = e.message; vp.disabled = false; }
  };
}
/** Middle of the top bar inside a project: 프로젝트 전환 ▾ · current phase · status pill (+ the 다음 할 일 strip). Empty outside a project. */
export function setTopProject(p, g, pill) {
  const el = $('#dtop-p'); if (!el) return;
  setTopNext(p, g);
  if (!p) { el.innerHTML = ''; el.dataset.pid = ''; return; }
  const cur = g && g.current_phase;
  el.dataset.pid = p.id;
  el.innerHTML = html`<span class="dmenuwrap"><button type="button" class="dtop__proj" data-dmenu="projects" data-pid="${p.id}" aria-haspopup="menu" aria-expanded="false" title="${p.name} · 프로젝트 전환"><b>${p.name}</b><i aria-hidden="true">▾</i></button></span>
    ${raw(cur ? html`<a class="dtop__phase" href="/app/projects/${p.id}" data-link title="현재 단계 · 지금 할 일">${no2(cur.sequence)} ${cur.name}</a>` : '')}${raw(pill)}`;
}

/* ---------- 다음 할 일 strip (batch7 #17 / B5): the guidance CTA on every project screen, so nobody has to go back to 지금 할 일 ----------
 * `[!] 다음 할 일 · 요구사항 12건을 WBS에 연결하세요 [지금 하기 →]`. Data = the page's own guide payload (g.guidance); after a save
 * (core/api.js fires relai:data-changed) it re-reads GET …/:pid/guidance, debounced. Hidden: closed / archived project, phone.
 * On 지금 할 일 the big card already says it → the strip only shows '단계 진행 n/m'. */
let nextState = { pid: null, g: null, timer: null };
const isMoveHref = (h) => /\?move=next$/.test(h || '');
function drawNext() {
  const el = $('#dtop-next'); if (!el) return;
  const { pid, g } = nextState; const q = g && g.guidance; const p = g && g.project;
  if (!pid || !q || !p || p.status === 'COMPLETED' || p.status === 'ARCHIVED') { el.hidden = true; el.innerHTML = ''; el.dataset.pid = ''; return; }
  el.hidden = false; el.dataset.pid = pid;
  const onNext = location.pathname.replace(/\/$/, '') === `/app/projects/${pid}`;
  if (onNext) {
    const cur = g.current_phase; const req = cur && Array.isArray(cur.steps) ? cur.steps.filter((s) => s.importance === 'REQUIRED') : [];
    const done = req.filter((s) => s.state === 'COMPLETED' || s.state === 'SKIPPED').length;
    el.className = 'dnext dnext--slim';
    el.innerHTML = req.length ? html`<span class="dnext__k">단계 진행</span><b class="dnext__n" data-next-progress>${done}/${req.length}</b>` : '';
    el.hidden = !req.length; return;
  }
  const warns = q.warnings || []; const a = q.primary_action;
  const href = q.href || (a && a.href) || ''; const label = q.cta_label || (a && a.label) || '';
  const nx = g.next_phase; const cta = isMoveHref(href) && nx ? `${no2(nx.sequence)} ${nx.name} 단계 시작 →` : label;
  const go = !href ? '' : href.startsWith('/api/') ? html`<a class="dnext__go" href="${href}" download title="${cta}" data-next-go>지금 하기 →</a>`
    : html`<a class="dnext__go" href="${href}" data-link title="${cta}" aria-label="지금 하기: ${cta}" data-next-go>지금 하기 →</a>`;
  el.className = `dnext ${warns.length ? 'has-warn' : ''}`;
  el.innerHTML = html`${raw(warns.length ? html`<i class="dnext__dot" role="img" aria-label="주의 ${warns.length}건" title="${warns.join('\n')}"></i>` : '')}<span class="dnext__k">다음 할 일</span><span class="dnext__t" title="${q.title}">${q.short_title || q.title}</span>${raw(go)}`;
}
export function setTopNext(p, g) {
  clearTimeout(nextState.timer);
  nextState = { pid: p ? p.id : null, g: p && g ? { ...g, project: g.project || p } : null, timer: null };
  drawNext();
}
let wiredNext = false;
function wireNext() {
  if (wiredNext) return; wiredNext = true;
  window.addEventListener('relai:data-changed', (e) => {
    const { pid } = nextState; const url = (e.detail && e.detail.url) || '';
    if (!pid || !url.includes(`/projects/${pid}`)) return;
    clearTimeout(nextState.timer);
    nextState.timer = setTimeout(async () => {
      try { const r = await api('GET', wsApi(`/${pid}/guidance`)); if (nextState.pid === pid && nextState.g) { nextState.g = { ...nextState.g, guidance: r.guidance }; drawNext(); } } catch { /* keep the last strip */ }
    }, 500);
  });
}
wireNext();

/* ---------- rail ---------- */
const railItem = (key, label, href, active, tourId) => html`<a class="rail__i ${active ? 'is-active' : ''}" href="${href}" data-link data-door="${key}" ${raw(active ? 'aria-current="page"' : '')} data-tour-id="${tourId}">${raw(RAIL_ICON[key])}<span>${label}</span></a>`;
/** Outside a project: 홈 · 프로젝트. */
export function mountGlobalRail(path) {
  const rail = $('#rail'); if (!rail) return;
  const key = path === '/app' || path === '/app/' ? 'home' : path.startsWith('/app/projects') ? 'projects' : '';
  rail.dataset.pid = '';
  rail.innerHTML = html`<nav class="rail__nav" aria-label="주요 메뉴">${raw(railItem('home', '홈', '/app', key === 'home', 'nav-home') + railItem('projects', '프로젝트', '/app/projects', key === 'projects', 'nav-projects'))}</nav>${raw(railFeedback())}`;
}
/** Inside a project: exactly the 7 doors; one is active. */
export function mountProjectRail(pid, door) {
  const rail = $('#rail'); if (!rail) return;
  rail.dataset.pid = pid;
  rail.innerHTML = html`<nav class="rail__nav" aria-label="프로젝트 메뉴">${raw(DOORS(pid).map((d) => railItem(d.key, d.label, d.href, d.key === door, `rail-${d.key}`)).join(''))}</nav>${raw(railFeedback())}`;
}

/* ---------- page header ---------- */
const checklistActivity = (pid, qs) => {
  const a = qs.get('activity');
  for (const [phase, list] of Object.entries(PHASE_ITEMS)) { const it = list(pid).find((x) => x.href && x.href.endsWith(`activity=${a}`) && x.href.includes('/checklist')); if (it) return { phase, label: it.label }; }
  return null;
};
/** Where a project page sits: door, tab, title, purpose, phase key for the chip, breadcrumb. */
export function pageInfo(p, g, { tab = null, title = '', badges = null } = {}) {
  const qs = new URLSearchParams(location.search); const path = location.pathname;
  const { door, tab: tkey } = doorOf(p.id, path, qs, tab);
  const d = DOORS(p.id).find((x) => x.key === door); const t = d.tabs.find((x) => x.key === tkey) || null;
  const curKey = g.current_phase ? g.current_phase.phase_key : null;
  const info = { door: d, tab: t, title: t ? t.label : d.label, purpose: t ? t.purpose : d.purpose, phase: t ? t.phase || curKey : null, crumb: null, badges: badges || {} };
  const TITLES = { definition: '프로젝트 정의', requirements: '요구사항', 'req-trace': '요구사항 연결 현황', wbs: '일정 (WBS)', gantt: '간트 차트', 'wbs-trace': '요구사항–작업 연결', 'test-plan': '테스트 연결률', acceptance: '검수 / 인수 승인', docs: title || '공식 문서', health: '프로젝트 건강도' };
  if (t && TITLES[t.key]) info.title = TITLES[t.key];
  if (/\/checklist\/?$/.test(path)) {
    const a = checklistActivity(p.id, qs); const ph = a && (g.phases || []).find((x) => x.phase_key === a.phase);
    info.title = a ? a.label : title || '체크리스트'; info.purpose = '이 업무의 체크리스트를 확인하고 완료 처리합니다.'; info.phase = a ? a.phase : curKey;
    info.crumb = [{ label: '지금 할 일', href: `/app/projects/${p.id}` }, ...(ph ? [{ label: `${no2(ph.sequence)} ${ph.name}`, href: `/app/projects/${p.id}?phase=${ph.phase_key}` }] : [])];
  } else if (/\/charter\/?$/.test(path)) {
    info.purpose = '목표·범위·일정을 한 장에서 봅니다. 사업수행계획서로 내려받을 수 있습니다.';   // = charter.js CHARTER_PURPOSE (P1-2)
  } else if (/\/reports\/[\w-]+\/?$/.test(path)) {
    info.title = title || '보고서'; info.purpose = '보고서 내용을 확인하고 편집·확정한 뒤 내려받습니다.';
  }
  return info;
}
/** Section tabs (or the 지금 할 일 breadcrumb on a checklist sub-view). Tab with `action` = a button (활동 기록 panel). */
const sectionTabs = (info) => {
  if (info.crumb) return html`<nav class="stabs stabs--crumb" aria-label="경로">${raw(info.crumb.map((c) => html`<a href="${c.href}" data-link>${c.label}</a><span aria-hidden="true">›</span>`).join(''))}<b>${info.title}</b></nav>`;
  if (!info.door.tabs.length) return '';
  return html`<nav class="stabs" aria-label="${info.door.label} 하위 메뉴">${raw(info.door.tabs.map((t) => (t.action
    ? html`<button type="button" class="stabs__i" data-stab-action="${t.action}">${t.label}</button>`
    : html`<a class="stabs__i ${info.tab && info.tab.key === t.key ? 'is-active' : ''}" href="${t.href}" data-link data-stab="${t.key}" ${raw(info.tab && info.tab.key === t.key ? 'aria-current="page"' : '')}>${t.label}${raw(info.badges[t.key] || '')}</a>`)).join(''))}</nav>`;
};
/** Phase chip next to the title — links to that phase's list on 지금 할 일. The current phase = blue chip with its name; any other
 * phase = grey chip with the same '03 분석·설계' wording (batch5 P2-2: one format), so colour and title — not a suffix — say it is not
 * the current phase (UI/UX P1-4). */
const phaseChip = (p, g, key) => {
  const ph = key && (g.phases || []).find((x) => x.phase_key === key); if (!ph) return '';
  if (ph.is_current) return html`<a class="pchip" href="/app/projects/${p.id}" data-link data-phase-chip="${ph.phase_key}" title="현재 단계 · 지금 할 일에서 보기">${no2(ph.sequence)} ${ph.name}</a>`;
  const cur = g.current_phase;
  return html`<a class="pchip pchip--other" href="/app/projects/${p.id}?phase=${ph.phase_key}" data-link data-phase-chip="${ph.phase_key}" title="이 화면이 속한 단계${cur ? ` (현재 단계: ${no2(cur.sequence)} ${cur.name})` : ''}">${no2(ph.sequence)} ${ph.name}</a>`;
};
/** The desktop page header. `actions` = the ⋯ menu group (project actions) + optional secondaries, already rendered. */
export function pageHeader(p, g, info, actions) {
  return html`<div class="phead-wrap" data-door="${info.door.key}">${raw(sectionTabs(info))}
    <header class="phead">
      <div class="phead__l"><div class="phead__t"><h1 class="phead__title">${info.title}</h1>${raw(info.door.key === 'next' && !info.crumb ? '' : phaseChip(p, g, info.phase))}</div>
        <p class="phead__purpose">${info.purpose}</p></div>
      <div class="phead__r">${raw(actions)}</div>
    </header></div>`;
}
