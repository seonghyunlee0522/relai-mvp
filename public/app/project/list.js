import { api, wsApi } from '../core/api.js';
import { $, fmtDate, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { createGrid } from '../shared/grid.js';
import { STATUS, STATUS_CHIP, TYPE } from '../shared/constants.js';
import { ob } from '../onboarding/state.js';
import { bindChecklist, checklistCard } from '../onboarding/ui.js';
const canManage = () => state.workspace && state.workspace.role !== 'MEMBER';

export async function homePage(main = $("#main")) {
  document.title = 'Home — RELAI';
  const [{ projects }, o] = await Promise.all([api('GET', wsApi()), ob.get()]);
  const active = projects.filter((p) => p.status === 'ACTIVE');
  main.innerHTML = html`<div class="page">
    <div class="page__head"><div><h1>${state.user.name}님, 안녕하세요</h1><p>${state.workspace.name}</p></div>
      ${raw(projects.length && canManage() ? '<a class="btn btn--primary" href="/app/projects/new" data-link data-tour-id="create-project">+ 새 프로젝트</a>' : '')}</div>
    ${raw(projects.length ? checklistCard(o, { compact: true }) : '')}
    ${raw(active.length && !canManage() ? html`<p class="home__member">${state.workspace.name} Workspace에 참여 중입니다. 프로젝트를 선택해 진행 상황을 확인하세요. <a class="link" href="/app/projects/${active[0].id}/wbs?owner=${state.user.id}" data-link>내 업무 보기</a></p>` : '')}
    ${raw(active.length ? html`<div class="panel"><div class="panel__h">지금 해야 할 일</div>
      <div class="plist" style="border:0;border-radius:0 0 12px 12px">${raw(active.map((p) => html`
        <a class="prow" style="grid-template-columns:minmax(0,1.6fr) minmax(0,2fr) auto" href="/app/projects/${p.id}" data-link>
          <div><div class="nm">${p.name}</div><div class="sub">${TYPE[p.project_type]}</div></div>
          <div><div class="sub" style="margin:0">${no2(p.current_phase_sequence)} ${p.current_phase_name}</div>
            <div class="pbar" style="margin-top:8px"><i style="width:${p.progress}%"></i></div></div>
          <span class="link">${p.progress}% · 이어서 보기</span></a>`).join(''))}</div></div>` : projects.length ? '<div class="empty empty--sm"><h2>진행 중인 프로젝트가 없습니다.</h2><p>보관된 프로젝트는 Projects에서 볼 수 있습니다.</p></div>' : newWorkspaceHome(o))}
  </div>`;
  bindChecklist(main);
}

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
