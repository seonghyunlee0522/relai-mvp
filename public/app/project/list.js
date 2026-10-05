import { api, wsApi } from '../core/api.js';
import { $, fmtDate, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { createGrid } from '../shared/grid.js';
import { STATUS, STATUS_CHIP } from '../shared/constants.js';
import { ob } from '../onboarding/state.js';
import { checklistCard } from '../onboarding/ui.js';
const canManage = () => state.workspace && state.workspace.role !== 'MEMBER';

/** Project-0 home: one clear CTA + how RELAI guides a project (product UI, not a landing page). Members see the join message instead. */
export const newWorkspaceHome = (o = null) => (canManage()
  ? html`<section class="hero" data-tour-id="hero">
      <div class="hero__t"><h2>첫 프로젝트를 만들어 시작하세요.</h2><p>RELAI가 착수부터 검수까지 필요한 단계를 순서대로 안내합니다. 이름, 유형, 기간만 입력하면 됩니다.</p>
        <a class="btn btn--primary btn--lg" href="/app/projects/new" data-link data-tour-id="create-project">프로젝트 만들기</a></div>
      <ol class="hero__steps"><li><i>1</i><b>프로젝트 정의</b><span>목표·범위·이해관계자·일정을 정리합니다.</span></li><li><i>2</i><b>요구사항 → WBS</b><span>요구사항을 등록하고 실행 작업으로 나눕니다.</span></li><li><i>3</i><b>실행 → 테스트 → 검수</b><span>진행 현황, 테스트 결과, 고객 검수를 기록합니다.</span></li></ol>
    </section>${raw(checklistCard(o))}`
  : html`<section class="hero hero--member"><div class="hero__t"><h2>${state.workspace.name} Workspace에 참여했습니다.</h2><p>아직 프로젝트가 없습니다. Workspace 관리자(OWNER/ADMIN)가 프로젝트를 만들면 여기에서 바로 볼 수 있습니다.</p></div></section>`);
export const emptyState = () => newWorkspaceHome(ob.peek());
export async function projectsPage(main = $("#main")) {
  document.title = 'Projects — RELAI';
  let showArchived = false; let q = ''; let status = '';
  let all = [];
  const grid = createGrid({
    key: 'projects', rowId: (r) => r.id, select: false, pageSize: 100, defaultSort: { key: 'name', dir: 'asc' },
    rowClass: (r) => (r.status === 'ARCHIVED' ? 'is-arch' : ''),
    onOpen: (pid) => navigate(`/app/projects/${pid}`),
    empty: () => (all.length ? '<div class="empty empty--sm"><h2>조건에 맞는 프로젝트가 없습니다.</h2></div>' : emptyState()),
    columns: [
      { key: 'name', label: '프로젝트명', width: 320, min: 160, sticky: true, fixed: true, sort: (r) => r.name, cls: 'ttl', render: (r) => html`<a class="link" href="/app/projects/${r.id}" data-link>${r.name}</a>` },
      { key: 'client', label: '고객사', width: 150, sort: (r) => r.client_name || '', render: (r) => r.client_name || '-' },
      { key: 'status', label: '상태', width: 90, sort: (r) => STATUS[r.status], render: (r) => html`<span class="chip ${STATUS_CHIP[r.status] || ''}">${STATUS[r.status]}</span>` },
      { key: 'phase', label: '현재 단계', width: 180, sort: (r) => r.current_phase_sequence, render: (r) => html`${no2(r.current_phase_sequence)} ${r.current_phase_name}` },
      { key: 'lifecycle', label: 'Lifecycle', width: 150, sort: (r) => r.current_phase_sequence, render: (r) => html`<div class="lcpos" title="${no2(r.current_phase_sequence)} ${r.current_phase_name}">${raw(Array.from({ length: 7 }, (_, i) => `<i class="${i + 1 < r.current_phase_sequence ? 'is-done' : i + 1 === r.current_phase_sequence ? 'is-cur' : ''}"></i>`).join(''))}</div>` },
      { key: 'start', label: '시작', width: 100, sort: (r) => r.planned_start_date, cls: 'mono', render: (r) => fmtDate(r.planned_start_date) },
      { key: 'end', label: '종료', width: 100, sort: (r) => r.planned_end_date, cls: 'mono', render: (r) => fmtDate(r.planned_end_date) },
    ],
  });
  const filtered = () => all.filter((p) => (!status || p.status === status) && (!q || `${p.name} ${p.client_name || ''}`.toLowerCase().includes(q.toLowerCase())));
  const load = async () => { all = (await api('GET', wsApi(showArchived ? '?include_archived=1' : ''))).projects; };
  const draw = () => {
    grid.setRows(filtered());
    main.innerHTML = html`<div class="page">
      <div class="page__head"><div><h1>Projects</h1><p>${state.workspace.name} · ${all.length}개</p></div>
        ${raw(canManage() ? '<a class="btn btn--primary" href="/app/projects/new" data-link>+ 새 프로젝트</a>' : '')}</div>
      <div class="ptoolbar"><input class="input input--sm" id="pq" type="search" placeholder="프로젝트 검색" value="${q}" style="width:220px">
        <select class="select select--sm" id="pst" style="max-width:120px"><option value="">상태</option>${raw(Object.entries(STATUS).filter(([k]) => k !== 'ARCHIVED').map(([k, l]) => html`<option value="${k}" ${status === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>
        <label class="toggle"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''}> 보관된 프로젝트 보기</label>
        <span class="rtool__sp"></span>${raw(grid.toolsHtml())}</div>
      <div class="ptable">${raw(grid.html())}</div></div>`;
    grid.bind(main);
    const pq = $('#pq'); pq.oninput = () => { q = pq.value.trim(); grid.setRows(filtered()); grid.refresh(); };
    $('#pst').onchange = (e) => { status = e.target.value; grid.setRows(filtered()); grid.refresh(); };
    $('#arch').onchange = async (e) => { showArchived = e.target.checked; await load(); draw(); };
  };
  await load(); draw();
}
