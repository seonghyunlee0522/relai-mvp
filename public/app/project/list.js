import { api, wsApi } from '../core/api.js';
import { $, fmtDate, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { createGrid } from '../shared/grid.js';
import { STATUS, STATUS_CHIP, TYPE } from '../shared/constants.js';
const canManage = () => state.workspace && state.workspace.role !== 'MEMBER';

export async function homePage(main = $("#main")) {
  document.title = 'Home — RELAI';
  const { projects } = await api('GET', wsApi());
  const active = projects.filter((p) => p.status === 'ACTIVE');
  main.innerHTML = html`<div class="page">
    <div class="page__head"><div><h1>${state.user.name}님, 안녕하세요</h1><p>${state.workspace.name}</p></div>
      ${raw(projects.length && canManage() ? '<a class="btn btn--primary" href="/app/projects/new" data-link>+ 새 프로젝트</a>' : '')}</div>
    ${raw(active.length ? html`<div class="panel"><div class="panel__h">지금 해야 할 일</div>
      <div class="plist" style="border:0;border-radius:0 0 12px 12px">${raw(active.map((p) => html`
        <a class="prow" style="grid-template-columns:minmax(0,1.6fr) minmax(0,2fr) auto" href="/app/projects/${p.id}" data-link>
          <div><div class="nm">${p.name}</div><div class="sub">${TYPE[p.project_type]}</div></div>
          <div><div class="sub" style="margin:0">${no2(p.current_phase_sequence)} ${p.current_phase_name}</div>
            <div class="pbar" style="margin-top:8px"><i style="width:${p.progress}%"></i></div></div>
          <span class="link">${p.progress}% · 이어서 보기</span></a>`).join(''))}</div></div>` : emptyState())}
  </div>`;
}

export const emptyState = () => html`<div class="empty"><h2>첫 프로젝트를 시작해보세요.</h2>
  <p>RELAI가 프로젝트의 시작부터 종료까지 다음에 해야 할 일을 안내합니다.</p>
  ${raw(canManage() ? '<a class="btn btn--primary btn--lg" href="/app/projects/new" data-link>프로젝트 시작하기</a>' : '<p class="dim">프로젝트 생성은 Workspace의 Owner/Admin이 할 수 있습니다.</p>')}</div>`;
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
      { key: 'type', label: '유형', width: 130, sort: (r) => TYPE[r.project_type], render: (r) => TYPE[r.project_type] },
      { key: 'status', label: '상태', width: 90, sort: (r) => STATUS[r.status], render: (r) => html`<span class="chip ${STATUS_CHIP[r.status] || ''}">${STATUS[r.status]}</span>` },
      { key: 'phase', label: '현재 단계', width: 180, sort: (r) => r.current_phase_sequence, render: (r) => html`${no2(r.current_phase_sequence)} ${r.current_phase_name}` },
      { key: 'progress', label: '진행률', width: 150, sort: (r) => r.progress, render: (r) => html`<div class="pcell"><div class="pbar"><i style="width:${r.progress}%"></i></div><span>${r.progress}%</span></div>` },
      { key: 'start', label: '시작', width: 100, sort: (r) => r.planned_start_date, cls: 'mono', render: (r) => fmtDate(r.planned_start_date) },
      { key: 'end', label: '종료', width: 100, sort: (r) => r.planned_end_date, cls: 'mono', render: (r) => fmtDate(r.planned_end_date) },
    ],
  });
  const filtered = () => all.filter((p) => (!status || p.status === status) && (!q || `${p.name} ${TYPE[p.project_type]}`.toLowerCase().includes(q.toLowerCase())));
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
