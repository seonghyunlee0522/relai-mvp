import { api, wsApi } from '../core/api.js';
import { $, fmtDate, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
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
  let showArchived = false;
  const draw = async () => {
    const { projects } = await api('GET', wsApi(showArchived ? '?include_archived=1' : ''));
    main.innerHTML = html`<div class="page">
      <div class="page__head"><div><h1>Projects</h1><p>${state.workspace.name}</p></div>
        ${raw(canManage() ? '<a class="btn btn--primary" href="/app/projects/new" data-link>+ 새 프로젝트</a>' : '')}</div>
      <div class="toolbar"><label class="toggle"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''}> 보관된 프로젝트 보기</label></div>
      ${raw(projects.length ? html`<div class="plist">
        <div class="prow prow--head"><span>프로젝트명</span><span>상태</span><span>현재 단계</span><span>진행률</span><span>기간</span></div>
        ${raw(projects.map((p) => html`<a class="prow" href="/app/projects/${p.id}" data-link>
          <div><div class="nm">${p.name}</div><div class="sub">${TYPE[p.project_type]}</div></div>
          <div><span class="cell-l">상태</span><span class="chip ${STATUS_CHIP[p.status] || ''}">${STATUS[p.status]}</span></div>
          <div><span class="cell-l">현재 단계</span>${no2(p.current_phase_sequence)} ${p.current_phase_name}</div>
          <div><span class="cell-l">진행률</span><div class="pcell"><div class="pbar"><i style="width:${p.progress}%"></i></div><span>${p.progress}%</span></div></div>
          <div><span class="cell-l">기간</span>${fmtDate(p.planned_start_date)} – ${fmtDate(p.planned_end_date)}</div></a>`).join(''))}</div>` : emptyState())}
    </div>`;
    $('#arch').onchange = (e) => { showArchived = e.target.checked; draw(); };
  };
  await draw();
}
