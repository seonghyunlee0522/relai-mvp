import { api, getMembers, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { download, keepUi } from '../core/ui.js';
import { projectHead } from '../project/guide.js';
import { resBadge, statusChip, subtle, prText, verifyChip } from '../shared/badges.js';
import { appliedFilters, bindFilterClears, filterSelect } from '../shared/filters.js';
import { emptyFiltered } from '../shared/empty-state.js';
import { bindCoach, coachMark } from '../onboarding/ui.js';
import { drawerFoot, bindEscape } from '../shared/drawer.js';
import { traceStrip } from '../shared/trace-strip.js';
import { createGrid } from '../shared/grid.js';
import { bulkRun, mountBulk } from '../shared/bulk.js';
import { activityPane, bindActivity, bindDtabs, dtabs, mergeActivity } from '../shared/detail.js';
import { openImport } from '../shared/importer.js';
import { ACC_STATUS, LINK_TYPE, REQ_FIELD_LABEL, REQ_PRIORITY, REQ_SCOPE, REQ_STATUS, REQ_STATUS_CHIP, REQ_TYPE, TC_STATUS, TC_STATUS_CHIP, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE, testSummaryText } from '../shared/constants.js';
import { confirmDialog, pickerDialog, showErrors, toast } from '../shared/dialogs.js';
import { aiStatus } from '../shared/ai.js';
import { openExtractDialog } from '../ai/extract.js';

export async function requirementsPage(id) {
  const main = $('#main');
  const [g, members, ai] = await Promise.all([api('GET', wsApi(`/${id}`)), getMembers(), aiStatus(id)]);
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  document.title = `Requirements — ${p.name} — RELAI`;
  const rApi = (s = '') => wsApi(`/${id}/requirements${s}`);
  const meId = state.user.id;

  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };
  const filterKeys = ['type', 'priority', 'scope', 'status', 'owner', 'link'];
  const rview = () => (params().get('view') === 'trace' ? 'trace' : 'list');
  const listQuery = () => { const q = params(); const out = new URLSearchParams(); for (const k of ['q', ...filterKeys]) if (q.get(k)) out.set(k, q.get(k)); if (q.get('archived')) out.set('include_archived', '1'); return out.toString() ? '?' + out : ''; };

  let rows = []; let summary = g.requirements; let sel = null; let creating = params().get('new') === '1';
  let dtab = 'info'; let actFilter = 'ALL';
  // Arrived from an approved Change Request → edits are recorded with that CR as the history source.
  let ctxCr = null;
  if (params().get('cr')) { try { ctxCr = (await api('GET', wsApi(`/${id}/changes/${params().get('cr')}`))).change; } catch { setParam('cr', ''); } }
  const crBody = () => (ctxCr ? { source_change_request_id: ctxCr.id } : {});

  const load = async () => { const d = await api('GET', rApi(listQuery())); rows = d.requirements; summary = d.summary; listGrid.setRows(rows); traceGrid.setRows(rows); };
  const loadSel = async (rid) => { sel = rid ? (await api('GET', rApi(`/${rid}`))).requirement : null; setParam('sel', rid); };

  const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const ownerOpts = (cur) => html`<option value="">미지정</option>` + members.map((m) => html`<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>${m.name}</option>`).join('');
  const ownerMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const ownerPairs = [['', '미지정'], ...members.map((m) => [m.id, m.name])];
  const LINK_F = { linked: 'WBS 연결됨', unlinked: 'WBS 미연결' };
  const FILTER_DEFS = [{ key: 'q', label: '검색' }, { key: 'status', label: 'Status', map: REQ_STATUS }, { key: 'scope', label: 'Scope', map: REQ_SCOPE }, { key: 'owner', label: 'Owner', map: { ...ownerMap, none: '미지정' } },
    { key: 'type', label: '유형', map: REQ_TYPE }, { key: 'priority', label: 'Priority', map: REQ_PRIORITY }, { key: 'link', label: '연결 상태', map: LINK_F }, { key: 'archived', label: '보관 포함', format: () => '예' }];
  const dim = (t = '-') => html`<span class="dim">${t}</span>`;

  /* ---------- grids ---------- */
  const ro = (r) => archived || Boolean(r.archived_at);
  const listGrid = createGrid({
    key: 'req.list', rowId: (r) => r.id, defaultSort: { key: 'display_id', dir: 'asc' }, pageSize: 100,
    rowClass: (r) => (r.archived_at ? 'is-arch' : ''), canEdit: (r) => !ro(r),
    activeId: () => (sel ? sel.id : null),
    onOpen: (rid) => openDetail(rid),
    onEdit: async (rid, field, value) => {
      try { const d = await api('PATCH', rApi(`/${rid}`), { [field]: value, ...crBody() }); summary = d.summary; if (sel && sel.id === rid) sel = d.requirement; await load(); paintKpi(); if (sel && sel.id === rid) drawDetail(); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); throw e; }
    },
    onSelect: (s) => bulk.update(s.size),
    empty: () => emptyBlock(),
    columns: [
      { key: 'display_id', label: 'ID', width: 84, sticky: true, fixed: true, sort: (r) => r.display_id, cls: 'mono', render: (r) => html`${r.display_id}` },
      { key: 'title', label: '제목', width: 340, min: 160, sticky: true, fixed: true, sort: (r) => r.title, cls: 'ttl', render: (r) => html`<span>${r.title}</span>${raw(r.archived_at ? '<small>보관됨</small>' : '')}` },
      { key: 'status', label: 'Status', width: 112, sort: (r) => REQ_STATUS[r.status], edit: { type: 'select', field: 'status', options: REQ_STATUS }, render: (r) => statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) },
      { key: 'scope', label: 'Scope', width: 108, sort: (r) => REQ_SCOPE[r.scope], edit: { type: 'select', field: 'scope', options: REQ_SCOPE }, render: (r) => subtle(REQ_SCOPE[r.scope]) },
      { key: 'priority', label: 'Priority', width: 100, sort: (r) => ['HIGH', 'MEDIUM', 'LOW', 'UNSPECIFIED'].indexOf(r.priority), edit: { type: 'select', field: 'priority', options: REQ_PRIORITY }, render: (r) => prText(r.priority === 'UNSPECIFIED' ? '' : r.priority, REQ_PRIORITY) },
      { key: 'type', label: '유형', width: 104, sort: (r) => REQ_TYPE[r.type], edit: { type: 'select', field: 'type', options: REQ_TYPE }, render: (r) => REQ_TYPE[r.type] },
      { key: 'owner', label: 'Owner', width: 128, sort: (r) => r.owner_name || '', edit: { type: 'select', field: 'owner_user_id', options: ownerPairs, value: (r) => r.owner_user_id || '', prefix: (r) => (r.owner_name ? html`<i class="av">${[...r.owner_name][0]}</i>` : '') },
        render: (r) => (r.owner_name ? html`<span class="cellwrap"><i class="av">${[...r.owner_name][0]}</i>${r.owner_name}</span>` : dim()) },
      { key: 'wbs', label: 'WBS', width: 64, align: 'right', sort: (r) => r.linked_wbs_count, render: (r) => (r.linked_wbs_count ? String(r.linked_wbs_count) : (r.scope === 'IN_SCOPE' && !r.archived_at ? '<span class="chip chip--hold">없음</span>' : dim())) },
      { key: 'ac', label: '완료 조건', width: 80, align: 'right', sort: (r) => r.criteria_count, render: (r) => (r.criteria_count ? String(r.criteria_count) : dim()) },
      { key: 'requester_name', label: '요청자', width: 110, hidden: true, sort: (r) => r.requester_name || '', render: (r) => r.requester_name || dim() },
      { key: 'requester_organization', label: '요청자 소속', width: 120, hidden: true, sort: (r) => r.requester_organization || '', render: (r) => r.requester_organization || dim() },
      { key: 'updated', label: '수정일', width: 80, sort: (r) => r.updated_at, cls: 'mono', render: (r) => fmtShort(r.updated_at) },
    ],
  });
  const traceGrid = createGrid({
    key: 'req.trace', rowId: (r) => r.id, select: false, defaultSort: { key: 'display_id', dir: 'asc' },
    rowClass: (r) => (r.archived_at ? 'is-arch' : ''), activeId: () => (sel ? sel.id : null), onOpen: (rid) => openDetail(rid), empty: () => emptyBlock(),
    columns: [
      { key: 'display_id', label: 'ID', width: 84, sticky: true, fixed: true, sort: (r) => r.display_id, cls: 'mono', render: (r) => html`${r.display_id}` },
      { key: 'title', label: '제목', width: 420, min: 160, sticky: true, fixed: true, sort: (r) => r.title, cls: 'ttl', render: (r) => html`<span>${r.title}</span>${raw(r.archived_at ? '<small>보관됨</small>' : '')}` },
      { key: 'status', label: 'Status', width: 100, sort: (r) => REQ_STATUS[r.status], render: (r) => statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) },
      { key: 'scope', label: 'Scope', width: 100, sort: (r) => REQ_SCOPE[r.scope], render: (r) => subtle(REQ_SCOPE[r.scope]) },
      { key: 'wbs', label: '연결 WBS', width: 90, align: 'right', sort: (r) => r.linked_wbs_count, render: (r) => String(r.linked_wbs_count) },
      { key: 'link', label: '연결 상태', width: 110, sort: (r) => r.linked_wbs_count, render: (r) => (r.linked_wbs_count ? '<span class="chip chip--done">연결됨</span>' : r.scope === 'IN_SCOPE' ? '<span class="chip chip--hold">미연결</span>' : '<span class="chip chip--muted">미연결</span>') },
    ],
  });
  const curGrid = () => (rview() === 'trace' ? traceGrid : listGrid);

  const emptyBlock = () => {
    const q = params();
    const hasFilter = ['q', ...filterKeys, 'archived'].some((k) => q.get(k));
    return hasFilter ? emptyFiltered('요구사항')
      : html`<div class="empty empty--ob" data-tour-id="req-empty"><h2>아직 등록된 요구사항이 없습니다.</h2><p>프로젝트 범위와 검수 기준이 되는 요구사항을 등록하세요. 이후 WBS, 테스트, 변경관리와 연결됩니다.</p>
        ${raw(archived ? '' : html`<div class="empty__a"><button class="btn btn--primary btn--lg" id="add2">요구사항 추가</button><button class="btn btn--secondary btn--lg" id="xl-import2">Excel 가져오기</button>${raw(ai.enabled ? '<button class="btn btn--secondary btn--lg btn--ai" id="ai-extract2">AI로 요구사항 추출</button>' : '')}</div>`)}</div>`;
  };

  /* ---------- bulk ---------- */
  const NONE = '__none';
  const bulk = { update() {}, destroy() {} };
  const bulkFields = [
    { key: 'status', label: 'Status', options: REQ_STATUS }, { key: 'scope', label: 'Scope', options: REQ_SCOPE }, { key: 'priority', label: 'Priority', options: REQ_PRIORITY },
    { key: 'type', label: '유형', options: REQ_TYPE }, { key: 'owner_user_id', label: 'Owner', options: [[NONE, '미지정'], ...members.map((m) => [m.id, m.name])] },
  ];
  const reportBulk = (r, verb) => {
    const sk = r.skipped.length;
    toast(sk ? `${r.updated.toLocaleString('ko-KR')}건 ${verb}, ${sk.toLocaleString('ko-KR')}건 제외 (${r.skipped[0].reason})` : `${r.updated.toLocaleString('ko-KR')}건을 ${verb}했습니다.`);
  };
  const bulkAfter = async () => { await load(); paintKpi(); listGrid.clearSelection(); listGrid.refresh(); if (sel) { try { sel = (await api('GET', rApi(`/${sel.id}`))).requirement; drawDetail(); } catch { /* row may be gone */ } } };
  const mountBulkBar = () => {
    const slot = $('#bulkslot'); if (!slot) return;
    const b = mountBulk(slot, {
      fields: bulkFields, canArchive: !archived,
      onApply: async ({ field, value }) => {
        const n = listGrid.selected.size;
        const f = bulkFields.find((x) => x.key === field);
        const shown = value === NONE ? '미지정' : (Array.isArray(f.options) ? f.options : Object.entries(f.options)).find(([v]) => v === value)?.[1] || value;
        if (n >= 20 && !(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건의 ${f.label}을(를) '${shown}'(으)로 변경할까요?`, body: '선택한 모든 요구사항에 적용되며 각각 변경 이력이 남습니다.', confirm: '일괄 변경' }))) return;
        try { reportBulk(await bulkRun(rApi('/bulk'), listGrid.selectedIds(), { action: 'update', patch: { [field]: value === NONE ? '' : value }, ...crBody() }), '변경'); await bulkAfter(); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
      },
      onArchive: async () => {
        const n = listGrid.selected.size;
        if (!(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건을 보관할까요?`, body: '보관된 요구사항은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않습니다.', confirm: '보관하기', danger: true }))) return;
        try { reportBulk(await bulkRun(rApi('/bulk'), listGrid.selectedIds(), { action: 'archive', ...crBody() }), '보관'); await bulkAfter(); } catch (e) { toast(e.message); }
      },
      onClear: () => listGrid.clearSelection(),
    });
    bulk.update = b.update; bulk.destroy = b.destroy;
  };

  /* ---------- page ---------- */
  const kpiHtml = () => html`<button type="button" class="kchip" data-kf=""><b>${summary.total}</b>전체</button>
    <button type="button" class="kchip" data-kf="status=CONFIRMED"><b>${summary.confirmed}</b>확정</button>
    <button type="button" class="kchip ${summary.scope_undecided ? 'is-warn' : ''}" data-kf="scope=UNDECIDED"><b>${summary.scope_undecided}</b>범위 미결정</button>
    <button type="button" class="kchip ${summary.in_scope_unlinked ? 'is-warn' : ''}" data-kf="scope=IN_SCOPE&link=unlinked"><b>${summary.in_scope_unlinked}</b>WBS 미연결 (범위 내)</button>`;
  const paintKpi = () => { const k = $('#kstrip'); if (k) k.innerHTML = kpiHtml(); };

  const draw = () => {
    const q = params();
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'requirements' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 요구사항은 조회만 할 수 있습니다.</div>' : '')}
      ${raw(summary.total && !(g.wbs && g.wbs.tasks) && !archived ? html`<div class="nextstrip nextstrip--slim" data-tour-id="req-next"><div><b>요구사항 ${summary.total}건이 등록되었습니다.</b><span>요구사항을 기준으로 실행 계획을 구성하세요.</span></div><div class="nextstrip__a"><a class="btn btn--primary btn--sm" href="/app/projects/${p.id}/wbs?new=1" data-link>직접 WBS 작성</a>${raw(ai.enabled ? html`<a class="btn btn--secondary btn--sm" href="/app/projects/${p.id}/wbs?ai=1" data-link>AI로 WBS 생성</a>` : '')}</div></div>` : '')}
      ${raw(summary.total ? coachMark('REQ_TRACE_INTRO') : '')}
      ${raw(ctxCr ? html`<div class="ctx"><span><b>${ctxCr.display_id}</b> ${ctxCr.title}에서 이동했습니다. 이 화면에서 수정하는 내용은 해당 변경 요청을 출처로 History에 기록됩니다.</span><a class="link" href="/app/projects/${p.id}/changes?sel=${ctxCr.id}" data-link>변경 요청 보기</a><button class="linkbtn" id="ctx-off" type="button">컨텍스트 해제</button></div>` : '')}
      <div class="rtool">
        <div class="seg" role="tablist"><button class="${rview() === 'list' ? 'is-on' : ''}" data-rview="list" role="tab">요구사항 목록</button><button class="${rview() === 'trace' ? 'is-on' : ''}" data-rview="trace" role="tab">Traceability</button></div>
        <input class="input input--sm" id="q" type="search" placeholder="ID, 제목, 설명 검색" value="${q.get('q') || ''}">
        ${raw(filterSelect('status', 'Status', REQ_STATUS, q.get('status')))}
        ${raw(filterSelect('scope', 'Scope', REQ_SCOPE, q.get('scope')))}
        ${raw(filterSelect('owner', 'Owner', ownerMap, q.get('owner'), html`<option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>`))}
        ${raw(filterSelect('type', '유형', REQ_TYPE, q.get('type')))}
        ${raw(filterSelect('priority', 'Priority', REQ_PRIORITY, q.get('priority')))}
        ${raw(filterSelect('link', '연결 상태', LINK_F, q.get('link')))}
        <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>
        <span class="rtool__sp"></span>
        ${raw(rview() === 'list' ? listGrid.toolsHtml() : '')}
        <span class="gtools"><button type="button" class="btn btn--secondary btn--sm" id="xl-btn" aria-haspopup="true">Excel ▾</button>
          <div class="gpop" id="xl-pop" hidden>${raw(archived ? '' : '<button type="button" class="gpop__i linkbtn" data-xl="import">Excel로 가져오기…</button>')}<button type="button" class="gpop__i linkbtn" data-xl="template">등록 템플릿 내려받기</button><button type="button" class="gpop__i linkbtn" data-xl="export">현재 목록 내보내기</button></div></span>
        ${raw(ai.enabled && !archived ? '<button type="button" class="btn btn--secondary btn--sm btn--ai" id="ai-extract" title="회의록·메모 텍스트에서 요구사항 후보 추출 (초안)">AI로 요구사항 추출</button>' : '')}
        ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ 요구사항 추가</button>')}
      </div>
      <div class="rrow2"><div class="kstrip" id="kstrip">${raw(kpiHtml())}</div>
      ${raw(archived || rview() === 'trace' ? '' : html`<form class="qa" id="qa"><input class="input input--sm" id="qa-t" maxlength="200" placeholder="제목 입력 후 Enter — 요구사항 연속 추가" title="상세 항목은 목록에서 바로 수정하거나 행을 클릭해 입력하세요" autocomplete="off"></form>`)}</div>
      ${raw(appliedFilters(q, FILTER_DEFS))}
      <div id="bulkslot"></div>
      <div class="rlayout ${sel || creating ? 'has-drawer' : ''}">
        ${raw(curGrid().html())}
        <aside class="drawer ${creating ? 'drawer--form' : 'drawer--lg'}" id="drawer" ${sel || creating ? '' : 'hidden'}></aside>
      </div>
    </div>`;
    bind();
    mountBulkBar();
    bulk.update(listGrid.selected.size);
    if (creating) drawCreate(); else if (sel) drawDetail();
  };

  const bind = () => {
    const qi = $('#q'); let qt;
    if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { setParam('q', qi.value.trim()); await load(); keepUi(draw); }, 300); };
    main.querySelectorAll('[data-f]').forEach((sl) => sl.onchange = async () => { setParam(sl.dataset.f, sl.value); await load(); keepUi(draw); });
    main.querySelectorAll('[data-rview]').forEach((b) => b.onclick = () => { setParam('view', b.dataset.rview === 'trace' ? 'trace' : ''); draw(); });
    main.querySelectorAll('[data-kf]').forEach((b) => b.onclick = async () => { for (const k of filterKeys) setParam(k, ''); setParam('q', ''); for (const kv of (b.dataset.kf ? b.dataset.kf.split('&') : [])) { const [k, v] = kv.split('='); setParam(k, v); } await load(); draw(); });
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };
    bindFilterClears(main, { setParam, keys: ['q', ...filterKeys, 'archived'], reload: async () => { await load(); draw(); } });
    const cx = $('#ctx-off'); if (cx) cx.onclick = () => { ctxCr = null; setParam('cr', ''); draw(); };
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); showDrawer(); drawCreate(); }; }
    for (const ida of ['ai-extract', 'ai-extract2']) { const ax = $('#' + ida); if (ax) ax.onclick = () => openExtractDialog({ pid: id, onDone: async () => { await load(); paintKpi(); draw(); } }); }
    const xi2 = $('#xl-import2'); if (xi2) xi2.onclick = () => openImport({ kind: 'requirements', base: rApi(), onDone: async () => { await load(); paintKpi(); draw(); } });
    bindCoach(main);
    if (params().get('import') === '1' && !archived) { setParam('import', ''); openImport({ kind: 'requirements', base: rApi(), onDone: async () => { await load(); paintKpi(); draw(); } }); }
    // Excel menu
    const xb = $('#xl-btn'); const xp = $('#xl-pop');
    xb.onclick = (e) => { e.stopPropagation(); const open = xp.hidden; document.querySelectorAll('.gpop').forEach((x) => { x.hidden = true; }); xp.hidden = !open; };
    xp.onclick = async (e) => {
      const b = e.target.closest('[data-xl]'); if (!b) return; xp.hidden = true;
      const base = rApi();
      try {
        if (b.dataset.xl === 'import') openImport({ kind: 'requirements', base, onDone: async () => { await load(); paintKpi(); draw(); } });
        else if (b.dataset.xl === 'template') await download(`${base}/template.xlsx`, { filename: '요구사항 등록 템플릿.xlsx' });
        else await download(`${base}/export.xlsx`);
      } catch (err) { toast(err.message); }
    };
    // Quick add
    const qa = $('#qa');
    if (qa) qa.onsubmit = async (e) => {
      e.preventDefault(); const inp = $('#qa-t'); const title = inp.value.trim(); if (!title) return;
      inp.disabled = true;
      try { const { requirement } = await api('POST', rApi(), { title }); inp.value = ''; toast(`${requirement.display_id} 추가됨`); await load(); paintKpi(); listGrid.refresh(); }
      catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message); }
      inp.disabled = false; inp.focus();
    };
    curGrid().bind(main);
    bindEscape(() => { if (sel || creating) closeDrawer(); });
  };

  /* ---------- detail / create modal ---------- */
  const showDrawer = () => { const d = $('#drawer'); d.hidden = false; d.className = `drawer ${creating ? 'drawer--form' : 'drawer--lg'}`; $('.rlayout').classList.add('has-drawer'); };
  const closeDrawer = () => { creating = false; sel = null; setParam('sel', ''); setParam('new', ''); const d = $('#drawer'); d.hidden = true; d.innerHTML = ''; $('.rlayout').classList.remove('has-drawer'); curGrid().refresh(); };
  const openDetail = async (rid) => {
    try { creating = false; setParam('new', ''); dtab = 'info'; actFilter = 'ALL'; await loadSel(rid); showDrawer(); drawDetail(); curGrid().refresh(); }
    catch (e) { toast(e.message); }
  };

  const fieldRow = (label, inner) => html`<div class="dfield"><span>${label}</span><div>${raw(inner)}</div></div>`;
  
  const drawCreate = () => {
    const d = $('#drawer');
    d.innerHTML = html`<form id="cf" novalidate style="display:flex;flex-direction:column;min-height:0;flex:1">
      <div class="drawer__h"><b>새 요구사항</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기" style="margin-left:auto">×</button></div>
      <div class="drawer__b">
        <div class="form-err" role="alert" hidden></div>
        <div class="fsec"><h4>기본 정보</h4>
          <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: SSO 로그인"><div class="err" data-for="title"></div></div>
          <div class="cols2">
            <div class="field"><label>유형</label><select class="select" name="type">${raw(opt(REQ_TYPE, 'UNSPECIFIED'))}</select></div>
            <div class="field"><label>Priority</label><select class="select" name="priority">${raw(opt(REQ_PRIORITY, 'UNSPECIFIED'))}</select></div>
            <div class="field"><label>Scope</label><select class="select" name="scope">${raw(opt(REQ_SCOPE, 'UNDECIDED'))}</select></div>
            <div class="field"><label>Status</label><select class="select" name="status">${raw(opt(REQ_STATUS, 'DRAFT'))}</select></div>
            <div class="field"><label>Owner</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select><div class="err" data-for="owner_user_id"></div></div>
            <div class="field"></div>
            <div class="field"><label>요청자</label><input class="input" name="requester_name" maxlength="100" placeholder="예: 김OO 책임"></div>
            <div class="field"><label>요청자 소속</label><input class="input" name="requester_organization" maxlength="100" placeholder="예: A사 IT팀"></div>
          </div>
          <div class="field" style="margin-bottom:0"><label for="c-desc">설명</label><textarea class="textarea" id="c-desc" name="description" maxlength="5000" placeholder="요구사항의 배경과 내용을 적어주세요." style="min-height:96px"></textarea></div>
        </div>
        <div class="fsec"><h4>완료 조건</h4><div id="c-crit"></div>
          <div class="crit-add"><input class="input input--sm" id="c-crit-in" maxlength="1000" placeholder="완료 조건을 입력하고 Enter"><button type="button" class="btn btn--secondary btn--sm" id="c-crit-add">추가</button></div></div>
      </div>
      <div class="drawer__f"><span class="hint">Ctrl+Enter로 저장</span><span style="display:flex;gap:8px;margin-left:auto"><button class="btn btn--secondary" type="button" id="dcancel">취소</button><button class="btn btn--secondary" type="submit" data-more="1">저장 후 계속 추가</button><button class="btn btn--primary" type="submit">저장</button></span></div></form>`;
    $('#dclose').onclick = closeDrawer; $('#dcancel').onclick = closeDrawer;
    bindCreate();
    $('#c-title').focus();
  };

  const bindCreate = () => {
    const form = $('#cf'); let crit = []; const list = $('#c-crit'); let more = false;
    const drawCrit = () => { list.innerHTML = crit.map((c, i) => html`<div class="crit-pending"><span class="crit__n">${i + 1}</span><span>${c}</span><button type="button" data-rm="${i}" aria-label="삭제">×</button></div>`).join(''); list.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { crit.splice(Number(b.dataset.rm), 1); drawCrit(); }); };
    const addCrit = () => { const v = $('#c-crit-in').value.trim(); if (!v) return; crit.push(v); $('#c-crit-in').value = ''; drawCrit(); };
    $('#c-crit-add').onclick = addCrit;
    $('#c-crit-in').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addCrit(); } };
    form.querySelectorAll('[type=submit]').forEach((b) => { b.onclick = () => { more = Boolean(b.dataset.more); }; });
    form.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); more = false; form.requestSubmit(); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '제목을 입력해 주세요.' });
      const btns = form.querySelectorAll('[type=submit]'); btns.forEach((b) => { b.disabled = true; });
      try {
        const { requirement } = await api('POST', rApi(), { ...d, criteria: crit });
        toast(`${requirement.display_id} 요구사항을 추가했습니다.`);
        await load(); paintKpi();
        if (more) { crit = []; form.reset(); drawCrit(); btns.forEach((b) => { b.disabled = false; }); $('#c-title').focus(); listGrid.refresh(); return; }
        creating = false; setParam('new', ''); dtab = 'info'; actFilter = 'ALL'; sel = requirement; setParam('sel', requirement.id); showDrawer(); drawDetail(); curGrid().refresh();
      } catch (err) { btns.forEach((b) => { b.disabled = false; }); showErrors(form, err.fields, err.message); }
    };
  };

  const drawDetail = () => keepUi(() => {
    const r = sel; if (!r) return;
    const d = $('#drawer'); const readOnly = ro(r);
    const ids = curGrid().orderedIds(); const at = ids.indexOf(r.id);
    const events = mergeActivity({ history: r.history, comments: r.comments || [], fmt: (h) => histText(h, r), meId });
    d.innerHTML = html`<div class="drawer__h"><b class="mono">${r.display_id}</b>${raw(statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) + subtle(REQ_SCOPE[r.scope]))}${raw(r.archived_at ? '<span class="chip">보관됨</span>' : '')}
        <span class="dnav"><button type="button" data-nav="-1" aria-label="이전 요구사항" title="이전 (목록 순서)" ${at <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-nav="1" aria-label="다음 요구사항" title="다음 (목록 순서)" ${at < 0 || at >= ids.length - 1 ? 'disabled' : ''}>↓</button></span>
        <button class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
      ${raw(dtabs([{ key: 'info', label: '업무정보' }, { key: 'links', label: '연결·검증', count: r.links.filter((l) => !l.archived_at).length }, { key: 'activity', label: '댓글·활동', count: events.length }], dtab))}
      <div class="drawer__b">
        <section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
          <div class="dlayout"><div>
            <input class="dtitle" data-field="title" value="${r.title}" maxlength="200" ${readOnly ? 'disabled' : ''} aria-label="제목">
            <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${readOnly ? 'disabled' : ''}>${r.description}</textarea>
            <h4 class="dh">완료 조건 <em>${r.criteria.length}</em></h4>
            <ol class="crit">${raw(r.criteria.map((c, i) => html`<li data-crit="${c.id}">
              <span class="crit__n">${i + 1}</span>
              <input class="crit__in" value="${c.content}" maxlength="1000" ${readOnly ? 'disabled' : ''} data-crit-in="${c.id}">
              ${raw(readOnly ? '' : html`<span class="crit__act"><button data-crit-move="${c.id}" data-dir="-1" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button><button data-crit-move="${c.id}" data-dir="1" title="아래로" ${i === r.criteria.length - 1 ? 'disabled' : ''}>↓</button><button data-crit-del="${c.id}" title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
            ${raw(readOnly ? (r.criteria.length ? '' : '<p class="hint">등록된 완료 조건이 없습니다.</p>') : html`<div class="crit-add"><input class="input input--sm" id="crit-in" maxlength="1000" placeholder="완료 조건을 입력하고 Enter"><button class="btn btn--secondary btn--sm" id="crit-add">추가</button></div>`)}
          </div>
          <div class="dside">
            ${raw(fieldRow('Status', html`<select class="select select--sm" data-field="status" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_STATUS, r.status))}</select>`))}
            ${raw(fieldRow('Scope', html`<select class="select select--sm" data-field="scope" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_SCOPE, r.scope))}</select>`))}
            ${raw(fieldRow('Priority', html`<select class="select select--sm" data-field="priority" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_PRIORITY, r.priority))}</select>`))}
            ${raw(fieldRow('유형', html`<select class="select select--sm" data-field="type" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_TYPE, r.type))}</select>`))}
            ${raw(fieldRow('Owner', html`<select class="select select--sm" data-field="owner_user_id" ${readOnly ? 'disabled' : ''}>${raw(ownerOpts(r.owner_user_id || ''))}</select>`))}
            ${raw(fieldRow('요청자', html`<input class="input input--sm" data-field="requester_name" value="${r.requester_name}" maxlength="100" placeholder="이름" ${readOnly ? 'disabled' : ''}>`))}
            ${raw(fieldRow('요청자 소속', html`<input class="input input--sm" data-field="requester_organization" value="${r.requester_organization}" maxlength="100" placeholder="소속" ${readOnly ? 'disabled' : ''}>`))}
            <div class="dsave" id="dsave"></div>
          </div></div>
        </section>
        <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>
          ${raw(deliveryTrace(r))}
          ${raw(linkSection(r, readOnly))}
          <h4 class="dh">관련 테스트 <em>${r.testing ? r.testing.tests.length : 0}</em>${raw(r.testing && r.testing.tests.length ? html`<span style="margin-left:auto">${raw(verifyChip(r.testing.summary.verification))}</span>` : '')}</h4>
          ${raw(r.testing && r.testing.tests.length ? html`<p class="hint" style="margin:-4px 0 8px">${testSummaryText(r.testing.summary)}</p><ol class="crit links">${raw(r.testing.tests.map((t) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${t.id}" data-link><span class="mono">${t.display_id}</span><span class="crit__in" style="padding:6px 4px">${t.title}</span><span class="chip ${TC_STATUS_CHIP[t.status] || ''}">${TC_STATUS[t.status]}</span>${raw(resBadge(t.last_result))}</a></li>`).join(''))}</ol>`
            : html`<p class="hint">아직 연결된 테스트가 없습니다.${raw(readOnly || r.scope !== 'IN_SCOPE' ? '' : html` <a class="link" href="/app/projects/${p.id}/tests?new=1&requirement=${r.id}" data-link>테스트 추가</a>`)}</p>`)}
          ${raw(r.acceptances && r.acceptances.length ? html`<p class="raidline">${raw(r.acceptances.map((a) => html`<a href="/app/projects/${p.id}/tests?tab=acceptance&sel=${a.id}" data-link>${a.display_id} <b>${ACC_STATUS[a.status]}</b></a>`).join(''))}</p>` : '')}
          ${raw(r.raid && (r.raid.issues.length || r.raid.risks.length) ? html`<p class="raidline">${raw(r.raid.issues.length ? html`<a href="/app/projects/${p.id}/issues?requirement=${r.id}" data-link>관련 Issues <b>${r.raid.issues.length}</b></a>` : '')}${raw(r.raid.risks.length ? html`<a href="/app/projects/${p.id}/issues?tab=risks&requirement=${r.id}" data-link>관련 Risks <b>${r.raid.risks.length}</b></a>` : '')}</p>` : '')}
        </section>
        <section data-pane="activity" ${dtab === 'activity' ? '' : 'hidden'}>${raw(activityPane({ events, filter: actFilter, ro: archived }))}</section>
      </div>
      ${raw(drawerFoot({ ro: readOnly, meta: `등록 ${fmtShort(r.created_at)}`, label: '요구사항 보관', id: 'rarchive' }))}`;
    bindDetail();
  });

  /** Delivery Trace — summary numbers with drill-down to each filtered list. */
  const deliveryTrace = (r) => {
    const u = `/app/projects/${p.id}`; const live = r.links.filter((l) => !l.archived_at);
    const t = r.testing ? r.testing.summary : { total: 0 }; const issues = r.raid ? r.raid.issues.length : 0; const risks = r.raid ? r.raid.risks.length : 0;
    const acc = r.acceptances && r.acceptances.length ? r.acceptances[0] : null;
    return traceStrip([
      { label: 'WBS', value: live.length, href: `${u}/wbs?requirement=${r.id}`, tone: live.length ? '' : r.scope === 'IN_SCOPE' ? 'warn' : 'muted' },
      ...(r.jira && r.jira.total ? [{ label: 'Jira', value: `${r.jira.done}/${r.jira.total} Done`, sub: `${r.jira.rate}% · WBS 경유`, href: `${u}/wbs?requirement=${r.id}`, tone: r.jira.done === r.jira.total ? 'ok' : '' }] : []),
      { label: 'Changes', value: r.changes ? r.changes.length : 0, href: `${u}/changes?requirement=${r.id}`, tone: r.changes && r.changes.length ? '' : 'muted' },
      { label: 'Issues', value: issues, sub: risks ? `Risk ${risks}` : '', href: `${u}/issues?requirement=${r.id}`, tone: issues ? 'warn' : 'muted' },
      { label: 'Tests', value: t.total, sub: t.total ? `${t.pass} Pass · ${t.fail} Fail` : '', href: `${u}/tests?requirement=${r.id}`, tone: t.fail ? 'crit' : t.total && t.verification === 'VERIFIED' ? 'ok' : t.total ? '' : 'muted' },
      { label: 'Acceptance', value: acc ? ACC_STATUS[acc.status] : '-', sub: acc ? acc.display_id : '', href: acc ? `${u}/tests?tab=acceptance&sel=${acc.id}` : `${u}/tests?tab=acceptance&requirement=${r.id}`, tone: acc ? (acc.status === 'ACCEPTED' ? 'ok' : acc.status === 'REWORK_REQUIRED' || acc.status === 'REJECTED' ? 'crit' : '') : 'muted' },
    ]);
  };

  const linkSection = (r, readOnly) => {
    const live = r.links.filter((l) => !l.archived_at); const arch = r.links.filter((l) => l.archived_at);
    const byType = Object.keys(LINK_TYPE).map((t) => [t, live.filter((l) => l.link_type === t).length]).filter(([, n]) => n);
    return html`<h4 class="dh">관련 WBS <em>${live.length}</em>${raw(byType.length > 1 ? html`<small class="dim" style="font-weight:500;letter-spacing:0;text-transform:none">${byType.map(([t, n]) => `${LINK_TYPE[t]} ${n}`).join(' · ')}</small>` : '')}</h4>
      ${raw(live.length ? html`<ol class="crit links">${raw(live.map((l) => html`<li data-link="${l.id}">
        <span class="mono wcode">${l.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${l.title}<small class="dim" style="margin-left:6px">${WBS_TYPE[l.item_type]}${l.owner_name ? ' · ' + l.owner_name : ''}</small>${raw((() => { const j = r.jira && r.jira.wbs ? r.jira.wbs.find((x) => x.id === l.wbs_item_id) : null; return j && j.jira ? html`<small class="jx-inline" title="Jira 실행 (Done / 연결)">Jira ${j.jira.done}/${j.jira.total}${j.jira.in_progress ? ` · 진행 ${j.jira.in_progress}` : ''}</small>` : ''; })())}</span>
        ${raw(readOnly ? html`<span class="chip chip--muted">${LINK_TYPE[l.link_type]}</span>` : html`<select class="select select--xs" data-link-type="${l.id}">${raw(Object.entries(LINK_TYPE).map(([v, lb]) => html`<option value="${v}" ${l.link_type === v ? 'selected' : ''}>${lb}</option>`).join(''))}</select>
        <span class="crit__act" style="opacity:1"><button data-link-del="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>`
        : html`<div class="empty-inline"><b>아직 연결된 WBS가 없습니다.</b><span>이 요구사항을 구현하거나 검증하는 작업을 연결하세요.</span></div>`)}
      ${raw(arch.length ? html`<p class="hint">보관된 WBS ${arch.length}개 연결은 기록으로만 남아 있습니다.</p>` : '')}
      ${raw(readOnly ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="link-add">+ WBS 연결</button></div>`)}`;
  };

  const lt = (v) => String(v || '').replace(/\b(IMPLEMENTS|SUPPORTS|VALIDATES)\b/g, (m) => LINK_TYPE[m]);
  const histText = (h, r) => {
    const val = (f, v) => { if (v == null) return '-'; if (f === 'type') return REQ_TYPE[v] || v; if (f === 'priority') return REQ_PRIORITY[v] || v; if (f === 'scope') return REQ_SCOPE[v] || v; if (f === 'status') return REQ_STATUS[v] || v;
      if (f === 'owner_user_id') return (members.find((m) => m.id === v) || {}).name || '미지정'; return v; };
    switch (h.action_type) {
      case 'CREATED': return html`<b>${r.display_id}</b> 생성`;
      case 'ARCHIVED': return html`보관 처리`;
      case 'CRITERION_ADDED': return html`완료 조건 추가 <q>${h.new_value}</q>`;
      case 'CRITERION_UPDATED': return html`완료 조건 수정 <q>${h.old_value}</q> → <q>${h.new_value}</q>`;
      case 'CRITERION_REMOVED': return html`완료 조건 삭제 <q>${h.old_value}</q>`;
      case 'LINKED_WBS': return html`WBS 연결 <q>${lt(h.new_value)}</q>`;
      case 'UNLINKED_WBS': return html`WBS 연결 해제 <q>${h.old_value}</q>`;
      case 'LINK_TYPE_CHANGED': return html`연결 유형 변경 <q>${lt(h.old_value)}</q> → <q>${lt(h.new_value)}</q>`;
      default: {
        const f = h.field_name; const long = f === 'title' || f === 'description';
        return html`<b>${REQ_FIELD_LABEL[f] || f}</b> ${long ? (f === 'description' ? '변경' : html`<q>${h.old_value}</q> → <q>${h.new_value}</q>`) : html`${val(f, h.old_value)} → ${val(f, h.new_value)}`}${raw(h.source_change_request_id ? html`<small>변경 출처 <a href="/app/projects/${p.id}/changes?sel=${h.source_change_request_id}" data-link>${h.source_change_display_id || 'CR'} ${h.source_change_title || ''}</a>${h.source_change_archived_at ? ' (보관됨)' : ''}</small>` : '')}`;
      }
    }
  };

  const bindDetail = () => {
    const r = sel; const d = $('#drawer'); const status = $('#dsave');
    $('#dclose').onclick = closeDrawer;
    bindDtabs(d, (k) => { dtab = k; });
    d.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { const ids = curGrid().orderedIds(); const n = ids[ids.indexOf(r.id) + Number(b.dataset.nav)]; if (n) openDetail(n); });
    const refreshAll = async (data) => { if (data.requirement) sel = data.requirement; if (data.summary) summary = data.summary; await load(); paintKpi(); curGrid().refresh(); drawDetail(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try {
        const res = await api('PATCH', rApi(`/${r.id}`), { [field]: value, ...crBody() });
        await refreshAll(res);
        const s = $('#dsave'); if (s) s.textContent = res.changed.length ? '저장됨' : '변경 없음';
      } catch (e) { status.textContent = e.message; toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    d.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT') el.onchange = () => save(field, el.value);
      else {
        el.onblur = () => { if (el.value.trim() !== (r[field] || '')) save(field, el.value); };
        if (el.tagName === 'INPUT') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); };
      }
    });
    const critApi = async (method, path, body) => { try { await refreshAll(await api(method, rApi(`/${r.id}${path}`), body)); } catch (e) { toast(e.message); } };
    const addIn = $('#crit-in');
    const add = () => { const v = addIn.value.trim(); if (!v) return; critApi('POST', '/criteria', { content: v }); };
    if (addIn) { addIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }; $('#crit-add').onclick = add; }
    d.querySelectorAll('[data-crit-in]').forEach((inp) => {
      const c = r.criteria.find((x) => x.id === inp.dataset.critIn);
      inp.onblur = () => { const v = inp.value.trim(); if (v && v !== c.content) critApi('PATCH', `/criteria/${c.id}`, { content: v }); else inp.value = c.content; };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    });
    d.querySelectorAll('[data-crit-move]').forEach((b) => b.onclick = () => { const c = r.criteria.find((x) => x.id === b.dataset.critMove); critApi('PATCH', `/criteria/${c.id}`, { sequence: c.sequence + Number(b.dataset.dir) }); });
    d.querySelectorAll('[data-crit-del]').forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog({ title: '완료 조건을 삭제할까요?', body: '삭제한 완료 조건은 History에만 남습니다.', confirm: '삭제', danger: true }))) return;
      critApi('DELETE', `/criteria/${b.dataset.critDel}`);
    });
    const la = $('#link-add');
    if (la) la.onclick = async () => {
      const { items } = await api('GET', wsApi(`/${id}/wbs`));
      const linked = new Set(r.links.filter((l) => !l.archived_at).map((l) => l.wbs_item_id));
      const pick = await pickerDialog({ title: `${r.display_id}에 WBS 연결`, placeholder: 'WBS 번호 또는 업무명 검색', withType: true,
        rows: items.map((w) => ({ ...w, disabled: linked.has(w.id) })), searchKeys: ['wbs_code', 'title'],
        render: (w) => html`<span class="mono wcode">${w.wbs_code}</span><span class="pick__t" style="padding-left:${w.depth * 14}px">${raw(w.item_type === 'MILESTONE' ? '<i class="wms">◆</i> ' : '')}<span class="${w.is_group || w.item_type === 'SUMMARY' ? 'wsum' : ''}">${w.title}</span></span>
          <small class="dim">${WBS_TYPE[w.item_type]}</small><small class="dim">${w.owner_name || '-'}</small><span class="chip ${WBS_STATUS_CHIP[w.status] || ''}">${WBS_STATUS[w.status]}</span>${raw(w.disabled ? '<small class="dim">연결됨</small>' : '')}` });
      if (!pick) return;
      try { await refreshAll(await api('POST', rApi(`/${r.id}/links`), { wbs_item_id: pick.id, link_type: pick.link_type })); toast('WBS를 연결했습니다.'); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    d.querySelectorAll('[data-link-type]').forEach((sl) => sl.onchange = async () => {
      try { await refreshAll(await api('PATCH', rApi(`/${r.id}/links/${sl.dataset.linkType}`), { link_type: sl.value })); } catch (e) { toast(e.message); }
    });
    d.querySelectorAll('[data-link-del]').forEach((b) => b.onclick = async () => {
      const l = r.links.find((x) => x.id === b.dataset.linkDel);
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: `${r.display_id}과 ${l.wbs_code} ${l.title}의 연결만 제거됩니다. 요구사항과 WBS는 그대로 남습니다.`, confirm: '연결 해제', danger: true }))) return;
      try { await refreshAll(await api('DELETE', rApi(`/${r.id}/links/${l.id}`))); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    // Activity: comments + filter
    const reloadComments = (c) => { r.comments = c; sel.comments = c; dtab = 'activity'; drawDetail(); };
    bindActivity(d, {
      onFilter: (f) => { actFilter = f; dtab = 'activity'; drawDetail(); },
      onSubmit: async (body) => { const res = await api('POST', rApi(`/${r.id}/comments`), { body }); reloadComments(res.comments); },
      onDelete: async (cid) => { if (!(await confirmDialog({ title: '댓글을 삭제할까요?', body: '삭제한 댓글은 복구할 수 없습니다.', confirm: '삭제', danger: true }))) return; try { reloadComments((await api('DELETE', rApi(`/${r.id}/comments/${cid}`))).comments); } catch (e) { toast(e.message); } },
    });
    const ab = $('#rarchive');
    if (ab) ab.onclick = async () => {
      if (!(await confirmDialog({ title: `${r.display_id}을 보관할까요?`, body: '보관된 요구사항은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않습니다.', confirm: '보관하기', danger: true }))) return;
      try { const res = await api('POST', rApi(`/${r.id}/archive`), {}); sel = res.requirement; toast(`${r.display_id}을 보관했습니다.`); await load(); paintKpi(); curGrid().refresh(); drawDetail(); } catch (e) { toast(e.message); }
    };
  };

  await load();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
}
