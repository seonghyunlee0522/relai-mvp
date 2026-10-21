/* Project workspace header actions: 보고서 menu, ⋯ menu (활동 기록 opens its page).
 * The header is rendered as a string by projectHead() on every project screen, so the actions are wired once by
 * document-level delegation and read the project id / state from data attributes on the header. */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { periodDialog } from './dashboard.js';
import { openJiraProjectSettings } from '../shared/jira.js';
import { closeOnOutsideTap } from '../core/outside.js';

const RS = { DRAFT: ['초안', 'chip--muted'], FINAL: ['확정', 'chip--done'] };

/** Header action group (rendered inside projectHead). */
export const headerActions = (p) => {
  const ro = p.status === 'ARCHIVED';
  const ops = p.current_phase === 'OPERATIONS' || p.status === 'COMPLETED';   // Phase 7: 완료보고서 is made in 07
  return html`<span class="wsh__act" data-pid="${p.id}" data-sample="${p.sample_key ? '1' : ''}" data-ro="${ro ? '1' : ''}" data-name="${p.name}" data-ops="${ops ? '1' : ''}" data-is-closed="${p.status === 'COMPLETED' ? '1' : ''}">
    <button type="button" class="btn btn--ghost btn--sm" data-act="activity" title="댓글·상태·담당자·일정·단계 변경 이력">활동 기록</button>
    <span class="menuwrap"><button type="button" class="btn btn--ghost btn--sm" data-act="reports" aria-haspopup="menu" aria-expanded="false">보고서 ▾</button></span>
    <span class="menuwrap"><button type="button" class="btn btn--ghost btn--sm wsh__more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="더보기" title="더보기">⋯</button></span>
  </span>`;
};

/** Desktop page header (Redesign R1): only `⋯` — 활동 기록, 보고서 and project actions live in it (and in the 보고서 door). */
export const headerMore = (p) => {
  const ro = p.status === 'ARCHIVED';
  const ops = p.current_phase === 'OPERATIONS' || p.status === 'COMPLETED';
  return html`<span class="phead__act" data-pid="${p.id}" data-sample="${p.sample_key ? '1' : ''}" data-ro="${ro ? '1' : ''}" data-name="${p.name}" data-ops="${ops ? '1' : ''}" data-is-closed="${p.status === 'COMPLETED' ? '1' : ''}">
    <span class="menuwrap"><button type="button" class="btn btn--secondary btn--sm btn--icon phead__more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="더보기 메뉴" title="더보기">⋯</button></span></span>`;
};

const ctx = (el) => { const h = el.closest('.wsh__act, .phead__act'); return h ? { pid: h.dataset.pid, ro: h.dataset.ro === '1', name: h.dataset.name, ops: h.dataset.ops === '1', closed: h.dataset.isClosed === '1', sample: h.dataset.sample === '1' } : null; };
const closeMenus = () => { document.querySelectorAll('.amenu').forEach((m) => m.remove()); document.querySelectorAll('[data-act][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); };

function openMenu(btn, inner) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'amenu'; m.setAttribute('role', 'menu'); m.innerHTML = inner;
  btn.parentElement.append(m); btn.setAttribute('aria-expanded', 'true');
  const first = btn.closest('.phead__act') && m.querySelector('a[role=menuitem],button[role=menuitem]:not([disabled])'); if (first) first.focus();   // keyboard: Tab / ↑↓ move, Esc closes
  return m;
}

async function reportsMenu(btn, c) {
  // Phase 7 US-1: 완료보고서 생성 — grey before 07 (툴팁 "07 운영 단계에서 만들 수 있습니다"); a second click opens the existing one
  const done = c.ro ? '' : c.ops ? '<button type="button" role="menuitem" data-rep="completion">완료보고서 생성</button>'
    : '<button type="button" role="menuitem" data-rep="completion" disabled aria-disabled="true" title="07 운영 단계에서 만들 수 있습니다">완료보고서 생성</button>';
  const m = openMenu(btn, html`${raw(c.ro ? '' : `<button type="button" role="menuitem" data-rep="new">주간보고 생성</button>${done}<hr>`)}<div class="amenu__h">최근 보고서</div><div class="amenu__list"><span class="amenu__empty">불러오는 중…</span></div>`);
  const cb = $('[data-rep="completion"]', m); if (cb && !cb.disabled) cb.onclick = async () => { closeMenus(); const { openCompletion } = await import('./closing.js'); openCompletion(c.pid); };
  let reports = null;
  try { reports = await api('GET', wsApi(`/${c.pid}/weekly-reports`)); } catch (e) { toast(e.message); }
  const items = (reports?.items || []).slice(0, 8);
  const list = $('.amenu__list', m); if (!list) return;
  list.innerHTML = items.length ? items.map((r) => html`<a role="menuitem" href="/app/projects/${c.pid}/reports/${r.id}" data-link><span>${r.report_type === 'COMPLETION' ? '완료보고서' : `${r.period_start.slice(5).replace('-', '/')} ~ ${r.period_end.slice(5).replace('-', '/')}`}</span><span class="chip ${RS[r.status][1]}">${RS[r.status][0]}</span></a>`).join('')
    : '<span class="amenu__empty">아직 생성된 주간보고가 없습니다.</span>';
  const nb = $('[data-rep="new"]', m);
  if (nb) nb.onclick = () => { closeMenus(); periodDialog(reports?.default_period, async (period) => {
    try { const r = await api('POST', wsApi(`/${c.pid}/weekly-reports/generate`), period); navigate(`/app/projects/${c.pid}/reports/${r.report.id}`); return true; }
    catch (e) { return e.fields || { period_end: e.message }; }
  }); };
}

function moreMenu(btn, c) {
  const desk = Boolean(btn.closest('.phead__act'));
  const done = desk && !c.ro ? (c.ops ? '<button type="button" role="menuitem" data-rep="completion">완료보고서 생성·보기</button>' : '<button type="button" role="menuitem" data-rep="completion" disabled aria-disabled="true" title="07 운영 단계에서 만들 수 있습니다">완료보고서 생성·보기</button>') : '';
  const m = openMenu(btn, html`<button type="button" role="menuitem" class="amenu__act" data-more="activity">활동 기록</button>
    ${raw(c.ro ? '' : '<button type="button" role="menuitem" class="amenu__act amenu__act--sm" data-more="report-new">주간보고 생성</button>')}${raw(done)}
    ${raw(c.ro ? '' : html`<a role="menuitem" href="/app/projects/${c.pid}/edit" data-link>프로젝트 정보 수정</a>`)}
    <button type="button" role="menuitem" data-more="jira">지라 연동 설정</button>
    ${raw(c.closed && !c.ro ? '<hr><button type="button" role="menuitem" data-more="reopen">종료 취소</button>' : '')}
    ${raw(c.sample ? (state.workspace && state.workspace.role !== 'MEMBER' ? '<hr><button type="button" role="menuitem" class="is-danger" data-more="sample-delete">샘플 프로젝트 삭제</button>' : '')
      : c.ro ? '<hr><button type="button" role="menuitem" data-more="unarchive">보관 해제</button>' : '<hr><button type="button" role="menuitem" class="is-danger" data-more="archive">프로젝트 보관</button>')}`);
  const sd = $('[data-more="sample-delete"]', m);   // 샘플 프로젝트: deleted for good (real projects are only archived)
  if (sd) sd.onclick = async () => { closeMenus(); const { deleteSample } = await import('./samples.js'); if (await deleteSample(c.pid, c.name)) navigate('/app'); };
  const rb = $('[data-more="reopen"]', m);   // Phase 7 US-2
  if (rb) rb.onclick = async () => { closeMenus(); const { reopenProject } = await import('./closing.js'); if (await reopenProject(c.pid)) navigate(`/app/projects/${c.pid}`, { replace: true }); };
  const ub = $('[data-more="unarchive"]', m);   // GAP-006
  if (ub) ub.onclick = async () => {
    closeMenus();
    if (!(await confirmDialog({ title: '보관을 해제할까요?', body: '프로젝트가 목록에 다시 표시되고 수정할 수 있게 됩니다.', confirm: '보관 해제' }))) return;
    try { await api('POST', wsApi(`/${c.pid}/unarchive`), {}); toast('보관을 해제했습니다.'); navigate(`/app/projects/${c.pid}`, { replace: true }); } catch (e) { toast(e.message); }
  };
  $('[data-more="activity"]', m).onclick = () => openActivity(c.pid);
  const cb = $('[data-rep="completion"]', m); if (cb && !cb.disabled) cb.onclick = async () => { closeMenus(); const { openCompletion } = await import('./closing.js'); openCompletion(c.pid); };
  $('[data-more="jira"]', m).onclick = () => { closeMenus(); openJiraProjectSettings(c.pid); };
  const rn = $('[data-more="report-new"]', m); if (rn) rn.onclick = () => { closeMenus(); periodDialog(undefined, async (period) => { try { const r = await api('POST', wsApi(`/${c.pid}/weekly-reports/generate`), period); navigate(`/app/projects/${c.pid}/reports/${r.report.id}`); return true; } catch (e) { return e.fields || { period_end: e.message }; } }); };
  const ab = $('[data-more="archive"]', m);
  if (ab) ab.onclick = async () => {
    closeMenus();
    if (!(await confirmDialog({ title: '프로젝트를 보관할까요?', body: '보관한 프로젝트는 목록에서 숨겨지고 더 이상 수정할 수 없습니다. 데이터는 삭제되지 않습니다.', confirm: '보관하기', danger: true }))) return;
    try { await api('POST', wsApi(`/${c.pid}/archive`), {}); toast('프로젝트를 보관했습니다.'); navigate('/app/projects'); } catch (e) { toast(e.message); }
  };
}

/** batch7 #22: 활동 기록 is a full page (보고서 › 활동 기록, /activity) — every old entry point (⋯, 지금 할 일 '전체 보기', 건강도, the phone menu) lands there. */
export function openActivity(pid) {
  closeMenus();
  navigate(`/app/projects/${pid}/activity`);
}

let wired = false;
export function wireProjectActions() {
  if (wired) return; wired = true;
  document.addEventListener('click', (e) => {
    const sa = e.target.closest('[data-stab-action="activity"]');   // 지금 할 일 › 최근 활동 '전체 보기' → the 활동 기록 page
    if (sa) { const h = document.querySelector('.phead__act'); if (h) openActivity(h.dataset.pid); return; }
    const btn = e.target.closest('.wsh__act [data-act], .phead__act [data-act]');
    if (!btn) { if (!e.target.closest('.amenu')) closeMenus(); else if (e.target.closest('a[data-link]')) closeMenus(); return; }
    const c = ctx(btn); if (!c) return;
    if (btn.getAttribute('aria-expanded') === 'true') { closeMenus(); return; }
    if (btn.dataset.act === 'activity') openActivity(c.pid);
    else if (btn.dataset.act === 'reports') reportsMenu(btn, c);
    else if (btn.dataset.act === 'more') moreMenu(btn, c);
  });
  closeOnOutsideTap((t) => t.closest && t.closest('.amenu, .wsh__act [data-act], .phead__act [data-act]'), () => { if (document.querySelector('.amenu')) closeMenus(); }, '.amenu');   // .amenu--row (WBS row ⋯) too
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.amenu')) { const b = document.querySelector('[data-act][aria-expanded="true"]'); closeMenus(); if (b) b.focus(); return; }
    const m = e.target.closest && e.target.closest('.amenu');
    if (!m || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault(); const list = [...m.querySelectorAll('a[role=menuitem],button[role=menuitem]:not([disabled])')].filter((x) => x.offsetParent !== null); const i = list.indexOf(document.activeElement);
    const n = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]; if (n) n.focus();
  });
}
