import { api, wsApi } from '../core/api.js';
import { $, fmtDate, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { createGrid } from '../shared/grid.js';
import { STATUS, STATUS_CHIP } from '../shared/constants.js';
import { ob } from '../onboarding/state.js';
import { LIFECYCLE_PHASES } from '../shared/lifecycle.js';
import { isPhone } from '../core/device.js';
import { sampleChip, deleteAllSamples } from './samples.js';
const canManage = () => state.workspace && state.workspace.role !== 'MEMBER';

/** Project-0 home: one clear CTA + how RELAI guides a project (product UI, not a landing page). Members see the join message instead. */
export const newWorkspaceHome = (o = null) => (canManage()
  ? html`<section class="hero" data-tour-id="hero">
      <div class="hero__t"><h2>첫 프로젝트를 만들어 시작하세요.</h2><p>RELAI가 <b>착수부터 운영까지 7단계</b>를 순서대로 안내합니다. 이름, 고객사, 기간만 입력하면 됩니다.</p>
        <div class="hero__cta"><a class="btn btn--primary btn--lg" href="/app/projects/new" data-link data-tour-id="create-project">프로젝트 만들기</a><button type="button" class="link linkbtn" data-tour-start>1분 둘러보기</button></div></div>
      <ol class="hero__flow" aria-label="프로젝트 7단계">${raw(LIFECYCLE_PHASES.map((ph, i) => html`<li><i>${no2(i + 1)}</i>${ph.label}</li>`).join(''))}</ol>
    </section>`
  : html`<section class="hero hero--member"><div class="hero__t"><h2>${state.workspace.name} 워크스페이스에 참여했습니다.</h2><p>아직 프로젝트가 없습니다. 워크스페이스 관리자가 프로젝트를 만들면 여기에서 바로 볼 수 있습니다.</p></div></section>`);
export const emptyState = () => newWorkspaceHome(ob.peek());
export async function projectsPage(main = $("#main")) {
  document.title = '프로젝트 — RELAI';
  let showArchived = false; let q = ''; let status = '';
  let all = [];
  const grid = createGrid({
    key: 'projects', rowId: (r) => r.id, select: false, pageSize: 100, defaultSort: { key: 'name', dir: 'asc' },
    rowClass: (r) => (r.status === 'ARCHIVED' ? 'is-arch' : ''),
    onOpen: (pid) => navigate(`/app/projects/${pid}`),
    empty: () => (all.length ? '<div class="empty empty--sm"><h2>조건에 맞는 프로젝트가 없습니다.</h2></div>' : emptyState()),
    columns: [
      { key: 'name', label: '프로젝트명', width: 320, min: 160, sticky: true, fixed: true, sort: (r) => r.name, cls: 'ttl', render: (r) => html`<a class="link" href="/app/projects/${r.id}" data-link>${r.name}</a>${raw(sampleChip(r))}` },
      { key: 'client', label: '고객사', width: 150, sort: (r) => r.client_name || '', render: (r) => r.client_name || '-' },
      { key: 'status', label: '상태', width: 90, sort: (r) => STATUS[r.status], render: (r) => html`<span class="chip ${STATUS_CHIP[r.status] || ''}">${STATUS[r.status]}</span>` },
      { key: 'phase', label: '현재 단계', width: 180, sort: (r) => r.current_phase_sequence, render: (r) => html`${no2(r.current_phase_sequence)} ${r.current_phase_name}` },
      { key: 'lifecycle', label: '진행 단계', width: 150, sort: (r) => r.current_phase_sequence, render: (r) => html`<div class="lcpos" title="${no2(r.current_phase_sequence)} ${r.current_phase_name}">${raw(Array.from({ length: 7 }, (_, i) => `<i class="${i + 1 < r.current_phase_sequence ? 'is-done' : i + 1 === r.current_phase_sequence ? 'is-cur' : ''}"></i>`).join(''))}</div>` },
      { key: 'start', label: '시작', width: 100, sort: (r) => r.planned_start_date, cls: 'mono', render: (r) => fmtDate(r.planned_start_date) },
      { key: 'end', label: '종료', width: 100, sort: (r) => r.planned_end_date, cls: 'mono', render: (r) => fmtDate(r.planned_end_date) },
    ],
  });
  const filtered = () => all.filter((p) => (!status || p.status === status) && (!q || `${p.name} ${p.client_name || ''}`.toLowerCase().includes(q.toLowerCase())));
  const load = async () => { all = (await api('GET', wsApi(showArchived ? '?include_archived=1' : ''))).projects; };
  const draw = () => {
    grid.setRows(filtered());
    main.innerHTML = html`<div class="page">
      <div class="page__head"><div><h1>프로젝트</h1><p>${state.workspace.name} · ${all.length}개</p></div>
        ${raw(canManage() && !isPhone() ? html`<span class="page__acts">${raw(all.some((p) => p.sample_key) ? '<button type="button" class="btn btn--ghost" data-samples-delete>샘플 프로젝트 삭제</button>' : '')}<a class="btn btn--primary" href="/app/projects/new" data-link>+ 새 프로젝트</a></span>` : '')}</div>
      <div class="ptoolbar"><input class="input input--sm" id="pq" type="search" placeholder="프로젝트 검색" value="${q}" style="width:220px">
        <select class="select select--sm" id="pst" style="max-width:120px"><option value="">상태</option>${raw(Object.entries(STATUS).filter(([k]) => k !== 'ARCHIVED').map(([k, l]) => html`<option value="${k}" ${status === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>
        ${raw(isPhone() ? '' : html`<label class="toggle"><input type="checkbox" id="arch" ${showArchived ? 'checked' : ''}> 보관된 프로젝트 보기</label>`)}
        <span class="rtool__sp"></span>${raw(grid.toolsHtml())}</div>
      <div class="ptable">${raw(grid.html())}</div></div>`;
    grid.bind(main);
    const pq = $('#pq'); pq.oninput = () => { q = pq.value.trim(); grid.setRows(filtered()); grid.refresh(); };
    $('#pst').onchange = (e) => { status = e.target.value; grid.setRows(filtered()); grid.refresh(); };
    const sd = main.querySelector('[data-samples-delete]'); if (sd) sd.onclick = async () => { if (await deleteAllSamples()) { await load(); draw(); } };
    if ($('#arch')) $('#arch').onchange = async (e) => { showArchived = e.target.checked; await load(); draw(); };
  };
  await load(); draw();
}
