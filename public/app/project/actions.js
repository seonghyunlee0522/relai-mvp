/* Project workspace header actions: Activity panel, 보고서 menu, ⋯ menu.
 * The header is rendered as a string by projectHead() on every project screen, so the actions are wired once by
 * document-level delegation and read the project id / state from data attributes on the header. */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { periodDialog } from './dashboard.js';
import { openJiraProjectSettings } from '../shared/jira.js';

const ENT = { REQUIREMENT: 'REQ', WBS: 'WBS', CHANGE: 'CR', ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', ACCEPTANCE: 'Acc.', PHASE: '단계', JIRA: 'Jira' };
const KINDS = [['ALL', '전체'], ['COMMENT', '댓글'], ['STATUS', '상태'], ['OWNER', '담당자'], ['SCHEDULE', '일정'], ['PHASE', '단계'], ['JIRA', 'Jira'], ['DATA', '기타']];
const RS = { DRAFT: ['Draft', 'chip--muted'], FINAL: ['Final', 'chip--done'] };
const fmtAt = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${no2(d.getDate())} ${no2(d.getHours())}:${no2(d.getMinutes())}`; };

/** Header action group (rendered inside projectHead). */
export const headerActions = (p) => {
  const ro = p.status === 'ARCHIVED';
  return html`<span class="wsh__act" data-pid="${p.id}" data-ro="${ro ? '1' : ''}" data-name="${p.name}">
    <button type="button" class="btn btn--ghost btn--sm" data-act="activity" title="댓글·상태·담당자·일정·단계 변경 이력">Activity</button>
    <span class="menuwrap"><button type="button" class="btn btn--ghost btn--sm" data-act="reports" aria-haspopup="menu" aria-expanded="false">보고서 ▾</button></span>
    <span class="menuwrap"><button type="button" class="btn btn--ghost btn--sm wsh__more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="더보기" title="더보기">⋯</button></span>
  </span>`;
};

const ctx = (el) => { const h = el.closest('.wsh__act'); return h ? { pid: h.dataset.pid, ro: h.dataset.ro === '1', name: h.dataset.name } : null; };
const closeMenus = () => { document.querySelectorAll('.amenu').forEach((m) => m.remove()); document.querySelectorAll('[data-act][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); };

function openMenu(btn, inner) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'amenu'; m.setAttribute('role', 'menu'); m.innerHTML = inner;
  btn.parentElement.append(m); btn.setAttribute('aria-expanded', 'true');
  return m;
}

async function reportsMenu(btn, c) {
  const m = openMenu(btn, html`${raw(c.ro ? '' : '<button type="button" role="menuitem" data-rep="new">주간보고 생성</button><hr>')}<div class="amenu__h">최근 보고서</div><div class="amenu__list"><span class="amenu__empty">불러오는 중…</span></div>`);
  let reports = null;
  try { reports = await api('GET', wsApi(`/${c.pid}/weekly-reports`)); } catch (e) { toast(e.message); }
  const items = (reports?.items || []).slice(0, 8);
  const list = $('.amenu__list', m); if (!list) return;
  list.innerHTML = items.length ? items.map((r) => html`<a role="menuitem" href="/app/projects/${c.pid}/reports/${r.id}" data-link><span>${r.period_start.slice(5).replace('-', '/')} ~ ${r.period_end.slice(5).replace('-', '/')}</span><span class="chip ${RS[r.status][1]}">${RS[r.status][0]}</span></a>`).join('')
    : '<span class="amenu__empty">아직 생성된 주간보고가 없습니다.</span>';
  const nb = $('[data-rep="new"]', m);
  if (nb) nb.onclick = () => { closeMenus(); periodDialog(reports?.default_period, async (period) => {
    try { const r = await api('POST', wsApi(`/${c.pid}/weekly-reports/generate`), period); navigate(`/app/projects/${c.pid}/reports/${r.report.id}`); return true; }
    catch (e) { return e.fields || { period_end: e.message }; }
  }); };
}

function moreMenu(btn, c) {
  const m = openMenu(btn, html`<button type="button" role="menuitem" class="amenu__act" data-more="activity">Activity</button>
    ${raw(c.ro ? '' : '<button type="button" role="menuitem" class="amenu__act amenu__act--sm" data-more="report-new">주간보고 생성</button>')}
    ${raw(c.ro ? '' : html`<a role="menuitem" href="/app/projects/${c.pid}/edit" data-link>프로젝트 정보 수정</a>`)}
    <button type="button" role="menuitem" data-more="jira">Jira 연동 설정</button>
    ${raw(c.ro ? '<hr><button type="button" role="menuitem" data-more="unarchive">보관 해제</button>' : '<hr><button type="button" role="menuitem" class="is-danger" data-more="archive">프로젝트 보관</button>')}`);
  const ub = $('[data-more="unarchive"]', m);   // GAP-006
  if (ub) ub.onclick = async () => {
    closeMenus();
    if (!(await confirmDialog({ title: '보관을 해제할까요?', body: '프로젝트가 목록에 다시 표시되고 수정할 수 있게 됩니다.', confirm: '보관 해제' }))) return;
    try { await api('POST', wsApi(`/${c.pid}/unarchive`), {}); toast('보관을 해제했습니다.'); navigate(`/app/projects/${c.pid}`, { replace: true }); } catch (e) { toast(e.message); }
  };
  $('[data-more="activity"]', m).onclick = () => openActivity(c.pid);
  $('[data-more="jira"]', m).onclick = () => { closeMenus(); openJiraProjectSettings(c.pid); };
  const rn = $('[data-more="report-new"]', m); if (rn) rn.onclick = () => { closeMenus(); periodDialog(undefined, async (period) => { try { const r = await api('POST', wsApi(`/${c.pid}/weekly-reports/generate`), period); navigate(`/app/projects/${c.pid}/reports/${r.report.id}`); return true; } catch (e) { return e.fields || { period_end: e.message }; } }); };
  const ab = $('[data-more="archive"]', m);
  if (ab) ab.onclick = async () => {
    closeMenus();
    if (!(await confirmDialog({ title: '프로젝트를 보관할까요?', body: '보관한 프로젝트는 목록에서 숨겨지고 더 이상 수정할 수 없습니다. 데이터는 삭제되지 않습니다.', confirm: '보관하기', danger: true }))) return;
    try { await api('POST', wsApi(`/${c.pid}/archive`), {}); toast('프로젝트를 보관했습니다.'); navigate('/app/projects'); } catch (e) { toast(e.message); }
  };
}

/** Activity slide-over: unified feed with kind filters. Opened on demand, never part of a default screen. */
export async function openActivity(pid) {
  closeMenus();
  document.querySelector('.actpanel')?.remove();
  const el = document.createElement('div'); el.className = 'actpanel';
  el.innerHTML = html`<div class="actpanel__scrim" data-close></div><aside class="actpanel__p" role="dialog" aria-modal="true" aria-labelledby="actT">
    <div class="actpanel__h"><b id="actT">Activity</b><button type="button" class="drawer__x" data-close aria-label="닫기">×</button></div>
    <div class="actpanel__f">${raw(KINDS.map(([k, l]) => html`<button type="button" class="fchip2 ${k === 'ALL' ? 'is-on' : ''}" data-kind="${k}">${l}</button>`).join(''))}</div>
    <div class="actpanel__b"><div class="amenu__empty" style="padding:16px">불러오는 중…</div></div></aside>`;
  document.body.append(el);
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); else if (e.target.closest('a[data-link]')) close(); });
  let items = [];
  const draw = (kind) => {
    const rows = kind === 'ALL' ? items : items.filter((i) => i.kind === kind);
    $('.actpanel__b', el).innerHTML = rows.length ? html`<ol class="actlist">${raw(rows.map((r) => html`<li class="${r.kind === 'COMMENT' ? 'is-comment' : ''}">
      <div class="actlist__m"><span class="chip chip--muted">${r.kind === 'COMMENT' ? '댓글' : ENT[r.entity_type] || r.entity_type}</span><b>${r.actor_name || '시스템'}</b><time>${fmtAt(r.at)}</time></div>
      <a href="/app/projects/${pid}/${r.href}" data-link>${raw(r.display_id ? html`<span class="mono">${r.display_id}</span> ` : '')}${r.kind === 'COMMENT' ? r.title || '' : r.title || ''}</a>
      <p>${r.summary}</p></li>`).join(''))}</ol>` : '<div class="amenu__empty" style="padding:16px">해당하는 활동이 없습니다.</div>';
  };
  el.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => { el.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('is-on', x === b)); draw(b.dataset.kind); });
  try { items = (await api('GET', wsApi(`/${pid}/activity?limit=120`))).items; draw('ALL'); }
  catch (e) { $('.actpanel__b', el).innerHTML = html`<div class="amenu__empty" style="padding:16px">${e.message}</div>`; }
}

let wired = false;
export function wireProjectActions() {
  if (wired) return; wired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.wsh__act [data-act]');
    if (!btn) { if (!e.target.closest('.amenu')) closeMenus(); else if (e.target.closest('a[data-link]')) closeMenus(); return; }
    const c = ctx(btn); if (!c) return;
    if (btn.getAttribute('aria-expanded') === 'true') { closeMenus(); return; }
    if (btn.dataset.act === 'activity') openActivity(c.pid);
    else if (btn.dataset.act === 'reports') reportsMenu(btn, c);
    else if (btn.dataset.act === 'more') moreMenu(btn, c);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
}
