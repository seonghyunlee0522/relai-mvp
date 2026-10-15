import { api, getMembers, wsApi } from '../core/api.js';
import { pcLine } from '../core/device.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { download, keepUi } from '../core/ui.js';
import { projectHead } from '../project/guide.js';
import { resBadge, statusChip, subtle, prText, verifyChip } from '../shared/badges.js';
import { appliedFilters, bindFilterClears, bindMoreFilters, filterSelect, moreFilters, isPhone } from '../shared/filters.js';
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
import { guardEdit, needsPrompt, needsAddPrompt, changePromptDialog, createChangeDraft, proposalLine } from './change-guard.js';
import { approvalFields, collectApproval, approvalBody, approvalErrors, approvalStatusText, showApprovalErrors } from '../shared/approval.js';
import { term, reqDocMenu, bindReqDocMenu } from '../project/initiation.js';
import { josa } from '../shared/josa.js';
import { toolMenu, tmItem, aiPrice } from '../shared/toolmenu.js';
import { bindArrowNav } from '../shared/drawer.js';
import { reqJiraPaneHtml, bindReqJiraPane, reqJiraCell, bulkCreateReqIssues } from '../shared/jira.js';

export async function requirementsPage(id) {
  const main = $('#main');
  let [g, members, ai, baseline] = await Promise.all([api('GET', wsApi(`/${id}`)), getMembers(), aiStatus(id), api('GET', wsApi(`/${id}/requirements/baseline`)).then((x) => x.baseline).catch(() => null)]);
  const p = g.project;
  // WBS guidance (이동 배너 · 연결 안내 · Delivery Trace · KPI 'WBS 미연결' · 표의 'WBS 없음' 칩) belongs to 03 분석·설계 onward (Phase 2 US-4, P-1)
  const wbsPhase = () => Boolean(g.current_phase && g.current_phase.sequence >= 3);
  const isArch = p.status === 'ARCHIVED'; const archived = isArch || isPhone();   // phone = view mode: the archived read-only path
  document.title = `Requirements — ${p.name} — RELAI`;
  const rApi = (s = '') => wsApi(`/${id}/requirements${s}`);
  const meId = state.user.id;
  const desk = !isPhone();   // Redesign R2: quiet toolbar, 5 default columns, 480px side drawer — desktop only; the phone keeps today's view
  const baselineApproved = Boolean(baseline && baseline.status === 'COMPLETED');   // 범위 column: shown while 02 is open, hidden by default once the baseline is approved (Jim M2)

  const params = () => new URLSearchParams(location.search);
  let selMode = new URLSearchParams(location.search).get('select') === '1';
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };
  const filterKeys = ['type', 'priority', 'scope', 'status', 'owner', 'link'];
  const rview = () => (params().get('view') === 'trace' ? 'trace' : 'list');
  const listQuery = () => { const q = params(); const out = new URLSearchParams(); for (const k of ['q', ...filterKeys]) if (q.get(k)) out.set(k, q.get(k)); if (q.get('archived')) out.set('include_archived', '1'); return out.toString() ? '?' + out : ''; };

  let rows = []; let summary = g.requirements; let sel = null; let creating = params().get('new') === '1' && !archived;   /* archived / phone: no create form */
  let apvOpen = params().get('approval') === '1' && !archived && Boolean(baseline && baseline.step_id); let bw = null; let confirmAll = true;   // 요구사항 기준선 승인 Drawer (Phase 2 US-1) — not when archived / on a phone
  let dtab = 'info'; let actFilter = 'ALL';
  let reqJira = null;        // v42: { enabled, auto_mark, by: { reqId: summary + keys } } when the project is mapped to Jira, else null
  let reqJiraDetail = null;  // Jira tab data of the open requirement (fetched when the tab is first opened)
  // Arrived from an approved Change Request → edits are recorded with that CR as the history source.
  let ctxCr = null;
  if (params().get('cr')) { try { ctxCr = (await api('GET', wsApi(`/${id}/changes/${params().get('cr')}`))).change; } catch { setParam('cr', ''); } }
  const crBody = () => (ctxCr ? { source_change_request_id: ctxCr.id } : {});

  const load = async () => { const d = await api('GET', rApi(listQuery())); rows = d.requirements; summary = d.summary; reqJira = d.jira || null; listGrid.setRows(rows); traceGrid.setRows(rows); };
  const loadSel = async (rid) => { if (!sel || sel.id !== rid) reqJiraDetail = null; sel = rid ? (await api('GET', rApi(`/${rid}`))).requirement : null; setParam('sel', rid); };
  const jiraCell = (r) => (reqJira ? reqJiraCell(reqJira.by[r.id], { done: reqJira.auto_mark && Boolean(r.jira_done_at) }) || dim() : dim());
  const jiraSort = (r) => { const j = reqJira && reqJira.by[r.id]; return j ? j.rate ?? -1 : -2; };

  const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const ownerOpts = (cur) => html`<option value="">미지정</option>` + members.map((m) => html`<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>${m.name}</option>`).join('');
  const ownerMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const ownerPairs = [['', '미지정'], ...members.map((m) => [m.id, m.name])];
  const LINK_F = { linked: 'WBS 연결됨', unlinked: 'WBS 미연결' };
  const FILTER_DEFS = [{ key: 'q', label: '검색' }, { key: 'status', label: '상태', map: REQ_STATUS }, { key: 'scope', label: '범위', map: REQ_SCOPE }, { key: 'owner', label: '담당자', map: { ...ownerMap, none: '미지정' } },
    { key: 'type', label: '유형', map: REQ_TYPE }, { key: 'priority', label: '우선순위', map: REQ_PRIORITY }, { key: 'link', label: '연결 상태', map: LINK_F }, { key: 'archived', label: '보관 포함', format: () => '예' }];
  const dim = (t = '—') => html`<span class="dim">${t}</span>`;
  const scopeOut = () => ((g.definition && g.definition.scope_out) || []);
  const PRIORITY_HINT = '높음 = 없으면 오픈할 수 없는 것';

  /* ---------- grids ---------- */
  const ro = (r) => archived || Boolean(r.archived_at);
  const listGrid = createGrid({
    key: desk ? `req.list.r2.${meId}` : 'req.list', rowId: (r) => r.id, tableClass: 'gtable--req', defaultSort: { key: 'display_id', dir: 'asc' }, pageSize: 100,   // R2: column choice remembered per user
    selectMode: !desk || selMode, forceShow: () => (desk && params().get('scope') ? ['scope'] : []),   // filtering by 범위 always shows the 범위 column (Jim M2)
    rowClass: (r) => (r.archived_at ? 'is-arch' : ''), canEdit: (r) => !ro(r),
    activeId: () => (sel ? sel.id : null),
    onOpen: (rid) => openDetail(rid),
    onEdit: async (rid, field, value) => {
      const row0 = rows.find((x) => x.id === rid);
      if (row0 && needsPrompt(row0, field) && !(await guardEdit(id, { r: row0, field, before: row0[field], after: value }, async () => {}))) return;   // CR draft or 취소 → the grid redraws the old value
      try { const d = await api('PATCH', rApi(`/${rid}`), { [field]: value, ...crBody() }); summary = d.summary; if (sel && sel.id === rid) sel = d.requirement; await load(); paintKpi(); if (sel && sel.id === rid) drawDetail(); toast(`${d.requirement?.display_id || ''} 저장됨`.trim()); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); throw e; }
    },
    onSelect: (s) => bulk.update(s.size),
    empty: () => emptyBlock(),
    columns: [
      { key: 'display_id', label: 'ID', width: 84, sticky: true, fixed: true, sort: (r) => r.display_id, cls: 'mono', render: (r) => html`${r.display_id}` },
      { key: 'title', label: '제목', width: 260, min: 160, sticky: true, fixed: true, sort: (r) => r.title, cls: 'ttl', render: (r) => html`<span>${r.title}</span>${raw(r.archived_at ? '<small>보관됨</small>' : '')}` },
      { key: 'status', label: '상태', width: 96, sort: (r) => REQ_STATUS[r.status], edit: { type: 'select', field: 'status', options: REQ_STATUS }, render: (r) => statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) },
      { key: 'scope', label: '범위', width: 88, hidden: desk && baselineApproved, sort: (r) => REQ_SCOPE[r.scope], edit: { type: 'select', field: 'scope', options: REQ_SCOPE }, render: (r) => subtle(REQ_SCOPE[r.scope]) },
      { key: 'priority', label: '우선순위', width: 84, sort: (r) => ['HIGH', 'MEDIUM', 'LOW', 'UNSPECIFIED'].indexOf(r.priority), edit: { type: 'select', field: 'priority', options: REQ_PRIORITY }, render: (r) => prText(r.priority === 'UNSPECIFIED' ? '' : r.priority, REQ_PRIORITY) },
      { key: 'type', label: '유형', width: 96, card: false, hidden: desk, sort: (r) => REQ_TYPE[r.type], edit: { type: 'select', field: 'type', options: REQ_TYPE }, render: (r) => REQ_TYPE[r.type] },
      { key: 'owner', label: '담당자', width: 112, card: false, sort: (r) => r.owner_name || '', edit: { type: 'select', field: 'owner_user_id', options: ownerPairs, value: (r) => r.owner_user_id || '', prefix: (r) => (r.owner_name ? html`<i class="av">${[...r.owner_name][0]}</i>` : '') },
        render: (r) => (r.owner_name ? html`<span class="cellwrap"><i class="av">${[...r.owner_name][0]}</i>${r.owner_name}</span>` : dim()) },
      { key: 'wbs', label: 'WBS', width: 64, align: 'right', card: false, hidden: desk, sort: (r) => r.linked_wbs_count, render: (r) => (r.linked_wbs_count ? String(r.linked_wbs_count) : (r.scope === 'IN_SCOPE' && r.status !== 'REJECTED' && !r.archived_at && wbsPhase() ? '<span class="dim is-unlinked" title="WBS 미연결">—</span>' : dim())) },
      { key: 'ac', label: '완료 조건', width: 72, card: false, hidden: desk, align: 'right', sort: (r) => r.criteria_count, render: (r) => (r.criteria_count ? String(r.criteria_count) : dim()) },
      { key: 'requester_name', label: '요청자', width: 110, hidden: true, sort: (r) => r.requester_name || '', render: (r) => r.requester_name || dim() },
      { key: 'requester_organization', label: '요청자 소속', width: 120, hidden: true, sort: (r) => r.requester_organization || '', render: (r) => r.requester_organization || dim() },
      { key: 'updated', label: '수정일', width: 80, card: false, hidden: desk, sort: (r) => r.updated_at, cls: 'mono', render: (r) => fmtShort(r.updated_at) },
      { key: 'jira', label: 'Jira', width: 150, card: false, hidden: true, sort: jiraSort, render: jiraCell },   // v42: column option (⋯ → 보기)
    ],
  });
  const traceGrid = createGrid({
    key: 'req.trace', rowId: (r) => r.id, select: false, defaultSort: { key: 'display_id', dir: 'asc' },
    rowClass: (r) => (r.archived_at ? 'is-arch' : ''), activeId: () => (sel ? sel.id : null), onOpen: (rid) => openDetail(rid), empty: () => emptyBlock(),
    columns: [
      { key: 'display_id', label: 'ID', width: 84, sticky: true, fixed: true, sort: (r) => r.display_id, cls: 'mono', render: (r) => html`${r.display_id}` },
      { key: 'title', label: '제목', width: 420, min: 160, sticky: true, fixed: true, sort: (r) => r.title, cls: 'ttl', render: (r) => html`<span>${r.title}</span>${raw(r.archived_at ? '<small>보관됨</small>' : '')}` },
      { key: 'status', label: '상태', width: 100, sort: (r) => REQ_STATUS[r.status], render: (r) => statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) },
      { key: 'scope', label: '범위', width: 100, sort: (r) => REQ_SCOPE[r.scope], render: (r) => subtle(REQ_SCOPE[r.scope]) },
      { key: 'wbs', label: '연결 WBS', width: 90, align: 'right', sort: (r) => r.linked_wbs_count, render: (r) => String(r.linked_wbs_count) },
      { key: 'link', label: '연결 상태', width: 110, sort: (r) => r.linked_wbs_count, render: (r) => (r.linked_wbs_count ? '<span class="chip chip--done">연결됨</span>' : r.scope === 'IN_SCOPE' && r.status !== 'REJECTED' ? '<span class="chip chip--hold">미연결</span>' : '<span class="chip chip--muted">미연결</span>') },
      { key: 'jira', label: 'Jira', width: 160, sort: jiraSort, render: jiraCell },   // v42: linked Jira issues (요구사항 › 추적)
    ],
  });
  const curGrid = () => (rview() === 'trace' ? traceGrid : listGrid);

  const emptyBlock = () => {
    const q = params();
    const hasFilter = ['q', ...filterKeys, 'archived'].some((k) => q.get(k));
    return hasFilter ? emptyFiltered('요구사항')
      : html`<div class="empty empty--ob" data-tour-id="req-empty"><h2>고객이 원하는 기능과 조건을 요구사항으로 등록하세요.</h2>
        ${raw(archived ? '' : html`<div class="empty__a"><button class="btn btn--primary btn--lg" id="add2">요구사항 추가</button></div><p class="tempty__alt"><button type="button" class="link linkbtn" id="xl-import2">Excel로 가져오기</button>${raw(ai.enabled ? ' · <button type="button" class="link linkbtn" id="ai-extract2">AI로 요구사항 추출</button>' : '')}</p>`)}</div>`;
  };

  /* ---------- bulk ---------- */
  const NONE = '__none';
  const bulk = { update() {}, destroy() {} };
  const bulkFields = [
    { key: 'status', label: '상태', options: REQ_STATUS }, { key: 'scope', label: '범위', options: REQ_SCOPE }, { key: 'priority', label: '우선순위', options: REQ_PRIORITY },
    { key: 'type', label: '유형', options: REQ_TYPE }, { key: 'owner_user_id', label: '담당자', options: [[NONE, '미지정'], ...members.map((m) => [m.id, m.name])] },
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
        let ids = listGrid.selectedIds();
        const guarded = field === 'scope' ? rows.filter((r) => ids.includes(r.id) && needsPrompt(r, 'scope') && r.scope !== value) : [];
        if (guarded.length) {   // 확정 요구사항의 범위 변경 → one prompt; 변경 요청 = one CR linking all of them, they stay unchanged
          const v = await changePromptDialog({ diff: `범위: 확정 요구사항 ${guarded.length}건 → ${shown}` }); if (!v) return;
          if (v === 'cr') {
            try { await createChangeDraft(id, { title: `${guarded.map((r) => r.display_id).join(', ')} 범위 변경`.slice(0, 200), lines: guarded.map((r) => `${r.display_id} ${r.title}\n  ${proposalLine('scope', r.scope, value)}`), requirementIds: guarded.map((r) => r.id), open: false }); } catch (e) { toast(e.message); return; }
            ids = ids.filter((x) => !guarded.some((r) => r.id === x)); if (!ids.length) { await bulkAfter(); return; }
          }
        }
        try { reportBulk(await bulkRun(rApi('/bulk'), ids, { action: 'update', patch: { [field]: value === NONE ? '' : value }, ...crBody() }), '변경'); await bulkAfter(); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
      },
      onArchive: async () => {
        const n = listGrid.selected.size; let ids = listGrid.selectedIds();
        const guarded = rows.filter((r) => ids.includes(r.id) && needsPrompt(r, 'archive'));
        if (guarded.length) {   // 확정된 범위 내 요구사항 보관 → prompt; 변경 요청 = CR only, those are not archived
          const v = await changePromptDialog({ diff: `보관: 확정된 범위 내 요구사항 ${guarded.length}건 (범위에서 제외)` }); if (!v) return;
          if (v === 'cr') {
            try { await createChangeDraft(id, { title: `${guarded.map((r) => r.display_id).join(', ')} 범위 제외(보관)`.slice(0, 200), lines: guarded.map((r) => `- 보관(범위에서 제외): ${r.display_id} ${r.title}`), requirementIds: guarded.map((r) => r.id), relation: 'REMOVES', open: false }); } catch (e) { toast(e.message); return; }
            ids = ids.filter((x) => !guarded.some((r) => r.id === x)); if (!ids.length) { await bulkAfter(); return; }
          }
        } else if (!(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건을 보관할까요?`, body: '보관된 요구사항은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않습니다.', confirm: '보관하기', danger: true }))) return;
        try { reportBulk(await bulkRun(rApi('/bulk'), ids, { action: 'archive', ...crBody() }), '보관'); await bulkAfter(); } catch (e) { toast(e.message); }
      },
      onClear: () => listGrid.clearSelection(),
      extra: reqJira && !archived ? [{ key: 'jira', label: '지라 태스크 만들기', onClick: async () => { try { if (await bulkCreateReqIssues(id, listGrid.selectedIds())) await bulkAfter(); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); } } }] : [],
    });
    bulk.update = b.update; bulk.destroy = b.destroy;
  };

  /* ---------- page ---------- */
  const kpiHtml = () => html`<button type="button" class="kchip" data-kf=""><b>${summary.total}</b>전체</button>
    <button type="button" class="kchip" data-kf="status=CONFIRMED"><b>${summary.confirmed}</b>확정</button>
    <button type="button" class="kchip ${summary.scope_undecided ? 'is-warn' : ''}" data-kf="scope=UNDECIDED"><b>${summary.scope_undecided}</b>범위 미결정</button>
    ${raw(wbsPhase() ? html`<button type="button" class="kchip ${summary.in_scope_unlinked ? 'is-warn' : ''}" data-kf="scope=IN_SCOPE&status=DRAFT,REVIEWING,CONFIRMED,ON_HOLD&link=unlinked"><b>${summary.in_scope_unlinked}</b>WBS 미연결 (범위 내)</button>` : '')}`;
  const paintKpi = () => { const k = $('#kstrip'); if (k) k.innerHTML = kpiHtml(); };

  /* ---------- desktop toolbar (R2 §5.4): status segments · search · ⋯ · + 요구사항 추가 (≤ 4 controls) ---------- */
  const SEG = [['', '전체', () => summary.total], ['CONFIRMED', '확정', () => summary.confirmed], ['REVIEWING', '검토 중', () => summary.reviewing], ['DRAFT', '작성 중', () => summary.draft], ['ON_HOLD', '보류', () => summary.on_hold], ['REJECTED', '반려', () => summary.rejected]];
  const statusSeg = (cur) => html`<div class="sseg" role="group" aria-label="상태" data-status-seg>${raw(SEG.filter(([v, , c]) => !v || v === cur || Number(c()) > 0 || v !== 'REJECTED').map(([v, l, c]) => html`<button type="button" class="${(cur || '') === v ? 'is-on' : ''}" data-stf="${v}" aria-pressed="${(cur || '') === v}">${l} <b>${Number(c()) || 0}</b></button>`).join(''))}</div>`;
  const deskTool = (q) => {
    const curSt = (q.get('status') || '').includes(',') ? 'MULTI' : q.get('status') || '';
    const f = (key, label, inner) => html`<label class="tmenu__f"><span>${label}</span>${raw(inner)}</label>`;
    const menu = toolMenu([
      ['필터 더보기', html`${raw(f('scope', '범위', filterSelect('scope', '범위', REQ_SCOPE, q.get('scope'))))}${raw(f('owner', '담당자', filterSelect('owner', '담당자', ownerMap, q.get('owner'), html`<option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>`)))}
        ${raw(f('type', '유형', filterSelect('type', '유형', REQ_TYPE, q.get('type'))))}${raw(f('priority', '우선순위', filterSelect('priority', '우선순위', REQ_PRIORITY, q.get('priority'))))}${raw(f('link', '연결 상태', filterSelect('link', '연결 상태', LINK_F, q.get('link'))))}
        <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>
        ${raw(tmItem(`범위 미결정 ${summary.scope_undecided}건 보기`, 'data-kf="scope=UNDECIDED"'))}${raw(wbsPhase() ? tmItem(`WBS 미연결 (범위 내) ${summary.in_scope_unlinked}건 보기`, 'data-kf="scope=IN_SCOPE&status=DRAFT,REVIEWING,CONFIRMED,ON_HOLD&link=unlinked"') : '')}`],
      ['보기', html`${raw(rview() === 'list' ? listGrid.toolsHtml() : '')}${raw(rview() === 'list' && !archived ? tmItem('여러 개 선택', `data-selmode class="tmenu__i ${selMode ? 'is-on' : ''}"`, '체크박스로 여러 요구사항을 한 번에 바꿉니다') : '')}`],
      ['가져오기·내보내기', html`${raw(archived ? '' : tmItem('Excel로 가져오기…', 'data-xl="import"'))}${raw(tmItem('등록 템플릿 내려받기 (Excel)', 'data-xl="template"'))}${raw(tmItem('현재 목록 내보내기 (Excel)', 'data-xl="export"'))}${raw(tmItem('요구사항 정의서 PDF', 'data-reqdoc="pdf"'))}${raw(tmItem('요구사항 정의서 Word', 'data-reqdoc="docx"'))}`],
      [ai.enabled && !archived ? 'AI' : '', ai.enabled && !archived ? tmItem('AI로 요구사항 추출', 'id="ai-extract" title="회의록·메모 텍스트에서 요구사항 후보 추출 (초안)"', aiPrice(ai, 'REQUIREMENT_EXTRACTION')) : ''],
    ], { label: '요구사항 메뉴 더보기' });
    return html`<div class="rtool rtool--r2" data-rtool-r2>${raw(statusSeg(curSt))}<input class="input input--sm" id="q" type="search" placeholder="ID, 제목, 설명 검색" value="${q.get('q') || ''}" aria-label="요구사항 검색"><span class="rtool__sp"></span>${raw(menu)}${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ 요구사항 추가</button>')}</div>`;
  };

  const draw = () => {
    const q = params();
    // K18: on phones 상태 · 범위 move into the 필터 sheet (search + 필터 + one primary stay in the toolbar)
    const phone = isPhone(); const quick = html`${raw(filterSelect('status', '상태', REQ_STATUS, q.get('status')))}${raw(filterSelect('scope', '범위', REQ_SCOPE, q.get('scope')))}`;
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { tab: (() => { const q = new URLSearchParams(location.search); return q.get('view') === 'trace' ? (q.get('scope') === 'IN_SCOPE' ? 'wbs-trace' : 'req-trace') : q.get('type') === 'UNSPECIFIED' || q.get('priority') === 'UNSPECIFIED' ? 'req-classify' : 'requirements'; })(), title: '요구사항' }))}
      ${raw(isArch ? '<div class="notice">보관된 프로젝트입니다. 요구사항은 조회만 할 수 있습니다.</div>' : pcLine())}
      ${raw(summary.total && !(g.wbs && g.wbs.tasks) && !archived && wbsPhase() ? html`<div class="nextstrip nextstrip--slim" data-tour-id="req-next"><div><b>요구사항 ${summary.total}건이 등록되었습니다.</b><span>요구사항을 기준으로 실행 계획을 구성하세요.</span></div><div class="nextstrip__a"><a class="btn btn--primary btn--sm" href="/app/projects/${p.id}/wbs?new=1" data-link><span class="go__tab">WBS</span>로 이동 →</a>${raw(ai.enabled ? html`<a class="btn btn--secondary btn--sm btn--ai" href="/app/projects/${p.id}/wbs?ai=1" data-link>AI로 WBS 만들기</a>` : '')}</div></div>` : '')}
      ${raw(summary.total && wbsPhase() ? coachMark('REQ_TRACE_INTRO') : '')}
      ${raw(ctxCr ? html`<div class="ctx"><span><b>${ctxCr.display_id}</b> ${ctxCr.title}에서 이동했습니다. 이 화면에서 수정하는 내용은 해당 변경 요청을 출처로 History에 기록됩니다.</span><a class="link" href="/app/projects/${p.id}/changes?sel=${ctxCr.id}" data-link>변경 요청 보기</a><button class="linkbtn" id="ctx-off" type="button">컨텍스트 해제</button></div>` : '')}
      ${raw(desk ? deskTool(q) : '')}
      ${raw(desk ? '' : html`<div class="rtool">
        <div class="seg" role="tablist"><button class="${rview() === 'list' ? 'is-on' : ''}" data-rview="list" role="tab">요구사항 목록</button><button class="${rview() === 'trace' ? 'is-on' : ''}" data-rview="trace" role="tab">연결 추적</button></div>
        <input class="input input--sm" id="q" type="search" placeholder="ID, 제목, 설명 검색" value="${q.get('q') || ''}">
        ${raw(phone ? '' : quick)}
        ${raw(moreFilters(html`${raw(phone ? quick : '')}${raw(filterSelect('owner', '담당자', ownerMap, q.get('owner'), html`<option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>`))}
          ${raw(filterSelect('type', '유형', REQ_TYPE, q.get('type')))}
          ${raw(filterSelect('priority', '우선순위', REQ_PRIORITY, q.get('priority')))}
          ${raw(filterSelect('link', '연결 상태', LINK_F, q.get('link')))}
          <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>`, [...(phone ? ['status', 'scope'] : []), 'owner', 'type', 'priority', 'link', 'archived'].filter((k) => q.get(k)).length))}
        <span class="rtool__sp"></span>
        ${raw(rview() === 'list' ? html`<span class="ph-hide">${raw(listGrid.toolsHtml())}</span>` : '')}
        <span class="gtools ph-hide"><button type="button" class="btn btn--secondary btn--sm" id="xl-btn" aria-haspopup="true">Excel ▾</button>
          <div class="gpop" id="xl-pop" hidden>${raw(archived ? '' : '<button type="button" class="gpop__i linkbtn" data-xl="import">Excel로 가져오기…</button>')}<button type="button" class="gpop__i linkbtn" data-xl="template">등록 템플릿 내려받기</button><button type="button" class="gpop__i linkbtn" data-xl="export">현재 목록 내보내기</button></div></span>
        <span class="ph-hide">${raw(reqDocMenu())}</span>
        ${raw(ai.enabled && !archived ? '<button type="button" class="btn btn--secondary btn--sm btn--ai ph-hide" id="ai-extract" title="회의록·메모 텍스트에서 요구사항 후보 추출 (초안)">AI로 요구사항 추출</button>' : '')}
        ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ 요구사항 추가</button>')}
      </div>
      <div class="rrow2"><div class="kstrip" id="kstrip">${raw(kpiHtml())}</div>
      ${raw(archived || rview() === 'trace' ? '' : html`<form class="qa" id="qa"><input class="input input--sm" id="qa-t" maxlength="200" placeholder="제목 입력 후 Enter — 요구사항 연속 추가" title="상세 항목은 목록에서 바로 수정하거나 행을 클릭해 입력하세요" autocomplete="off"></form>`)}</div>`)}
      ${raw(isPhone() ? '<p class="pcdl" data-phone-reqdoc>요구사항 정의서 <button type="button" class="link linkbtn" data-reqdoc="pdf" data-phone-ok>PDF</button> · <button type="button" class="link linkbtn" data-reqdoc="docx" data-phone-ok>Word</button></p>' : '')}
      ${raw(appliedFilters(q, FILTER_DEFS))}
      ${raw(q.get('scope') === 'UNDECIDED' && scopeOut().length ? html`<p class="req-excl" data-scope-excl>착수 때 제외하기로 한 것: <b>${scopeOut().join(', ')}</b>. 여기에 해당하는 요구사항은 '범위 외'로 두세요.</p>` : '')}
      <div id="bulkslot"></div>
      <div class="rlayout ${sel || creating || apvOpen ? 'has-drawer' : ''}">
        ${raw(curGrid().html())}
        ${raw(desk && !archived && rview() !== 'trace' && rows.length ? html`<form class="qa qa--foot" id="qa"><input class="input input--sm" id="qa-t" maxlength="200" placeholder="+ 제목 입력 후 Enter로 바로 추가" title="상세 항목은 행을 클릭해 오른쪽에서 입력하세요" autocomplete="off" aria-label="요구사항 빠른 추가"></form>` : '')}
        <aside class="drawer ${creating ? 'drawer--form' : 'drawer--lg'}" id="drawer" ${sel || creating || apvOpen ? '' : 'hidden'}></aside>
      </div>
    </div>`;
    bind();
    mountBulkBar();
    bulk.update(listGrid.selected.size);
    if (apvOpen) drawApproval(); else if (creating) drawCreate(); else if (sel) drawDetail();
  };

  const bind = () => {
    const qi = $('#q'); let qt;
    if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { setParam('q', qi.value.trim()); await load(); keepUi(draw); }, 300); };
    main.querySelectorAll('[data-f]').forEach((sl) => sl.onchange = async () => { setParam(sl.dataset.f, sl.value); await load(); keepUi(draw); });
    main.querySelectorAll('[data-rview]').forEach((b) => b.onclick = () => { setParam('view', b.dataset.rview === 'trace' ? 'trace' : ''); draw(); });
    main.querySelectorAll('[data-kf]').forEach((b) => b.onclick = async () => { for (const k of filterKeys) setParam(k, ''); setParam('q', ''); for (const kv of (b.dataset.kf ? b.dataset.kf.split('&') : [])) { const [k, v] = kv.split('='); setParam(k, v); } await load(); draw(); });
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };
    bindMoreFilters(main);
    bindFilterClears(main, { setParam, keys: ['q', ...filterKeys, 'archived'], reload: async () => { await load(); draw(); } });
    const cx = $('#ctx-off'); if (cx) cx.onclick = () => { ctxCr = null; setParam('cr', ''); draw(); };
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; apvOpen = false; setParam('approval', ''); setParam('sel', ''); setParam('new', '1'); showDrawer(); drawCreate(); }; }
    for (const ida of ['ai-extract', 'ai-extract2']) { const ax = $('#' + ida); if (ax) ax.onclick = () => openExtractDialog({ pid: id, onDone: async () => { await load(); paintKpi(); draw(); } }); }
    const xi2 = $('#xl-import2'); if (xi2) xi2.onclick = () => openImport({ kind: 'requirements', base: rApi(), onDone: async () => { await load(); paintKpi(); draw(); } });
    bindCoach(main);
    if (params().get('import') === '1' && !archived) { setParam('import', ''); openImport({ kind: 'requirements', base: rApi(), onDone: async () => { await load(); paintKpi(); draw(); } }); }
    // Excel menu
    const xb = $('#xl-btn'); const xp = $('#xl-pop');
    const runXl = async (kind) => {
      const base = rApi();
      try {
        if (kind === 'import') openImport({ kind: 'requirements', base, onDone: async () => { await load(); paintKpi(); draw(); } });
        else if (kind === 'template') await download(`${base}/template.xlsx`, { filename: '요구사항 등록 템플릿.xlsx' });
        else await download(`${base}/export.xlsx`);
      } catch (err) { toast(err.message); }
    };
    if (xb) xb.onclick = (e) => { e.stopPropagation(); const open = xp.hidden; document.querySelectorAll('.gpop').forEach((x) => { x.hidden = true; }); xp.hidden = !open; };
    if (xp) xp.onclick = async (e) => { const b = e.target.closest('[data-xl]'); if (!b) return; xp.hidden = true; runXl(b.dataset.xl); };
    main.querySelectorAll('.tmenu [data-xl]').forEach((b) => { b.onclick = () => runXl(b.dataset.xl); });
    main.querySelectorAll('[data-stf]').forEach((b) => { b.onclick = async () => { setParam('status', b.dataset.stf); await load(); draw(); }; });
    const sm = main.querySelector('[data-selmode]'); if (sm) sm.onclick = () => { selMode = !selMode; setParam('select', selMode ? '1' : ''); listGrid.setSelectMode(selMode); draw(); };
    // Quick add
    const qa = $('#qa');
    if (qa) qa.onsubmit = async (e) => {
      e.preventDefault(); const inp = $('#qa-t'); const title = inp.value.trim(); if (!title) return;
      inp.disabled = true;
      try { const { requirement } = await api('POST', rApi(), { title }); inp.value = ''; toast(`${requirement.display_id} 추가됨`); await load(); paintKpi(); listGrid.refresh(); }
      catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message); }
      inp.disabled = false; inp.focus();
    };
    bindReqDocMenu(main, id);
    curGrid().bind(main);
    bindEscape(() => { if (sel || creating || apvOpen) closeDrawer(); });
  };

  /* ---------- detail / create modal ---------- */
  const showDrawer = () => { const d = $('#drawer'); d.hidden = false; d.className = `drawer ${creating ? 'drawer--form' : 'drawer--lg'}`; $('.rlayout').classList.add('has-drawer'); };
  const closeDrawer = () => { creating = false; sel = null; apvOpen = false; setParam('sel', ''); setParam('new', ''); setParam('approval', ''); const d = $('#drawer'); d.hidden = true; d.innerHTML = ''; $('.rlayout').classList.remove('has-drawer'); curGrid().refresh(); };
  const openDetail = async (rid) => {
    try { creating = false; apvOpen = false; setParam('new', ''); setParam('approval', ''); dtab = 'info'; actFilter = 'ALL'; await loadSel(rid); showDrawer(); drawDetail(); curGrid().refresh(); }
    catch (e) { toast(e.message); }
  };

  const fieldRow = (label, inner) => html`<div class="dfield"><span>${raw(label)}</span><div>${raw(inner)}</div></div>`;
  
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
            <div class="field"><label>우선순위</label><select class="select" name="priority">${raw(opt(REQ_PRIORITY, 'UNSPECIFIED'))}</select><small class="hint req-phint">${PRIORITY_HINT}</small></div>
            <div class="field"><label>범위 ${raw(term('scope'))}</label><select class="select" name="scope">${raw(opt(REQ_SCOPE, 'UNDECIDED'))}</select></div>
            <div class="field"><label>상태</label><select class="select" name="status">${raw(opt(REQ_STATUS, 'DRAFT'))}</select></div>
            <div class="field"><label>담당자</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select><div class="err" data-for="owner_user_id"></div></div>
            <div class="field"></div>
            <div class="field"><label>요청자</label><input class="input" name="requester_name" maxlength="100" placeholder="예: 김OO 책임"></div>
            <div class="field"><label>요청자 소속</label><input class="input" name="requester_organization" maxlength="100" placeholder="예: A사 IT팀"></div>
          </div>
          <div class="field" style="margin-bottom:0"><label for="c-desc">설명</label><textarea class="textarea" id="c-desc" name="description" maxlength="5000" placeholder="요구사항의 배경과 내용을 적어주세요." style="min-height:96px"></textarea></div>
        </div>
        <div class="fsec"><h4>완료 조건 ${raw(term('criteria'))}</h4><div id="c-crit"></div>
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
      if (needsAddPrompt(baseline, d.scope)) {   // 승인된 기준선에 범위 내 추가 → 변경 요청 권유 (US-3)
        const v = await changePromptDialog({ adding: true, diff: `추가: ${d.title.trim().slice(0, 80)} (범위 내)` }); if (!v) return;
        if (v === 'cr') {
          try { await createChangeDraft(id, { title: `요구사항 추가: ${d.title.trim()}`, lines: [`- 신규 요구사항(범위 내): ${d.title.trim()}`, ...(d.description.trim() ? [`- 설명: ${d.description.trim()}`] : []), ...crit.map((c) => `- 완료 조건: ${c}`)], relation: 'ADDS' }); closeDrawer(); } catch (err) { toast(err.message); }
          return;
        }
      }
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

  /* ---------- 요구사항 기준선 승인 Drawer (?approval=1, Phase 2 US-1) — the 01 approval form, plus "미확정 함께 확정" ---------- */
  const UNCONF_QS = '?scope=IN_SCOPE&status=DRAFT,REVIEWING,ON_HOLD,REJECTED';
  const drawApproval = () => {
    const b = baseline; const d = $('#drawer'); if (!b || !d) return;
    if (!bw) bw = { add_to_stakeholders: true, ...b.approval };
    const done = b.status === 'COMPLETED'; const lock = archived || done; const c = b.counts; const unconf = c.in_scope_unconfirmed;
    const empty = !done && !c.in_scope;   // nothing in scope → no baseline to approve (Q6-2; the API refuses too)
    const methods = Object.entries(b.methods);
    d.className = 'drawer drawer--side'; d.dataset.mode = 'approval';   // the same right-side panel as 01 착수 결과 승인 (Q6-1)
    d.innerHTML = html`<div class="wd__h"><div class="wd__ht"><b>요구사항 기준선 승인(고객)${raw(done ? ' <span class="chip chip--done">승인 기록됨</span>' : '')}</b><small>확정한 요구사항을 고객에게 보내 승인받고 그 근거를 남깁니다. 승인된 요구사항이 이후 설계·개발·검수의 기준선 ${raw(term('req_baseline'))}이 됩니다.</small></div><button class="wd__ib" id="dclose" aria-label="닫기">×</button></div>
      <div class="drawer__b apv" data-approval-drawer>
        ${raw(!done && b.bypass ? html`<div class="notice notice--soft">승인 전 진행 — 사유: ${b.bypass.reason} (${[b.bypass.date, b.bypass.name].filter(Boolean).join(' · ')}). 승인을 받으면 아래에 기록하세요.</div>` : '')}
        ${raw(done ? html`<div class="notice">고객 승인이 기록되었습니다 · ${b.summary}</div>` : '')}
        <div class="apv__what"><div class="apv__wh"><b>승인받을 내용</b>${raw(reqDocMenu('요구사항 정의서 내려받기'))}</div>
          <dl><div><dt>범위 내</dt><dd data-apv-in>${c.in_scope}건 (확정 ${c.in_scope_confirmed}건)</dd></div><div><dt>범위 외</dt><dd>${c.out_of_scope}건</dd></div></dl>${raw(empty ? '<p class="hint" data-apv-empty style="margin:6px 0 0">아직 범위 내 요구사항이 없습니다. 요구사항을 등록하고 범위 내로 분류한 뒤 승인을 기록하세요.</p>' : '')}</div>
        <div class="wd__form">${raw(approvalFields(bw, { people: b.stakeholders, methods, disabled: lock, approverHint: '<small class="dim">고객 PM 또는 요구사항 승인 권한자</small>', evidencePh: "예: 2026-11-20 이수진 차장 회신 메일 '요구사항 정의서 v1.0 승인'" }))}</div>
        ${raw(!lock && unconf ? html`<label class="toggle apv__confirm"><input type="checkbox" id="apv-confirm" ${confirmAll ? 'checked' : ''}> 범위 내 미확정 ${unconf}건을 함께 확정합니다</label>` : '')}
        <div class="apv__block" id="apv-block" role="alert" hidden></div>
        <p class="hint">승인자·승인일·승인 방법·근거가 있어야 완료 처리할 수 있습니다. 승인 이후 확정된 요구사항을 바꾸면 변경 요청으로 처리하도록 안내합니다.</p>
      </div>
      ${raw(archived ? '' : html`<div class="drawer__f"><span class="wd__stat hint" id="apv-stat">${lock ? '' : approvalStatusText(bw)}</span><span style="display:flex;gap:8px;margin-left:auto">${raw(done ? '<button type="button" class="btn btn--ghost btn--sm" data-apv="reopen">완료 취소</button>' : html`<button type="button" class="btn btn--secondary btn--sm" data-apv="save">임시저장</button><button type="button" class="btn btn--primary btn--sm" data-apv="complete" ${empty ? 'disabled' : ''}>완료 처리</button>`)}</span></div>`)}`;
    bindApproval();
  };
  const bindApproval = () => {
    const d = $('#drawer'); const stat = $('#apv-stat');
    $('#dclose').onclick = closeDrawer;
    bindReqDocMenu(d, id);
    const collect = () => { const f = d.querySelector('.wd__form'); if (f) bw = collectApproval(f, bw); const cb = $('#apv-confirm'); if (cb) confirmAll = cb.checked; };
    const asel = d.querySelector('[data-af="approver_id"]'); if (asel) asel.onchange = () => { collect(); drawApproval(); };
    const cb = $('#apv-confirm'); if (cb) cb.onchange = () => { confirmAll = cb.checked; const bl = $('#apv-block'); bl.hidden = true; };
    const fail = (e) => { const f = e.fields || {}; if (showApprovalErrors(d, Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('approval.'))))) return; const msg = e.fields ? (f.section || Object.values(f)[0]) : e.message; toast(msg); if (stat) stat.textContent = msg; };
    const form = d.querySelector('.wd__form');
    if (form && stat && !d.querySelector('[data-af]:disabled')) form.addEventListener('input', () => { collect(); stat.textContent = approvalStatusText(bw); });
    if (form && stat && !d.querySelector('[data-af]:disabled')) form.addEventListener('change', () => { collect(); stat.textContent = approvalStatusText(bw); });
    const after = async (res) => { baseline = res.baseline; if (res.summary) summary = res.summary; if (res.guide) g = res.guide; };
    d.querySelectorAll('[data-apv]').forEach((btn) => { btn.onclick = async () => {
      const act = btn.dataset.apv; collect(); if (stat) stat.textContent = '';
      try {
        if (act === 'save') { await after(await api('PUT', rApi('/baseline'), { approval: approvalBody(bw) })); bw = null; drawApproval(); toast('임시저장했습니다.'); const s2 = $('#apv-stat'); if (s2) s2.textContent = '임시저장됨'; return; }
        if (act === 'reopen') {
          if (!(await confirmDialog({ title: '완료를 취소할까요?', body: '승인 기록은 그대로 남고, 이 업무만 다시 "진행 중"으로 바뀝니다.', confirm: '완료 취소' }))) return;
          await after(await api('POST', rApi('/baseline/reopen'), {})); bw = null; drawApproval(); toast('완료를 취소했습니다.'); return;
        }
        if (showApprovalErrors(d, approvalErrors(bw))) { if (stat) stat.textContent = approvalStatusText(bw); return; }   // L-D2: inline, under each field
        const unconf = baseline.counts.in_scope_unconfirmed;
        if (unconf && !confirmAll) {   // 체크 OFF + 미확정 남음 → 막힘, nothing saved
          const bl = $('#apv-block'); bl.hidden = false;
          bl.innerHTML = html`범위 내 미확정 ${unconf}건이 있습니다. 먼저 확정하세요. <a class="link" href="${location.pathname}${UNCONF_QS}" data-unconf>미확정 보기 →</a>`;
          bl.querySelector('[data-unconf]').onclick = async (e) => { e.preventDefault(); closeDrawer(); for (const k of filterKeys) setParam(k, ''); setParam('scope', 'IN_SCOPE'); setParam('status', 'DRAFT,REVIEWING,ON_HOLD,REJECTED'); await load(); draw(); };
          return;
        }
        const res = await api('POST', rApi('/baseline/complete'), { approval: approvalBody(bw), confirm_unconfirmed: Boolean(unconf && confirmAll) });
        await after(res); bw = null;
        toast(res.confirmed ? `승인을 기록하고 범위 내 미확정 ${res.confirmed}건을 확정했습니다.` : '승인을 기록했습니다.');
        closeDrawer(); await load(); paintKpi(); draw();
      } catch (e) { fail(e); }
    }; });
  };

  /** 완료 조건 list + add row (shared by the desktop drawer and the phone sheet). */
  const critHtml = (r, readOnly) => html`
            <h4 class="dh">완료 조건 ${raw(term('criteria'))} <em>${r.criteria.length}</em></h4>
            <ol class="crit">${raw(r.criteria.map((c, i) => html`<li data-crit="${c.id}">
              <span class="crit__n">${i + 1}</span>
              <input class="crit__in" value="${c.content}" maxlength="1000" ${readOnly ? 'disabled' : ''} data-crit-in="${c.id}">
              ${raw(readOnly ? '' : html`<span class="crit__act"><button data-crit-move="${c.id}" data-dir="-1" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button><button data-crit-move="${c.id}" data-dir="1" title="아래로" ${i === r.criteria.length - 1 ? 'disabled' : ''}>↓</button><button data-crit-del="${c.id}" title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
            ${raw(readOnly ? (r.criteria.length ? '' : '<p class="hint">등록된 완료 조건이 없습니다.</p>') : html`<div class="crit-add"><input class="input input--sm" id="crit-in" maxlength="1000" placeholder="완료 조건을 입력하고 Enter"><button class="btn btn--secondary btn--sm" id="crit-add">추가</button></div>`)}`;
  /** Desktop drawer (R2 §5.4): 제목 · 설명 · 완료 조건 · 범위 · 우선순위 · 담당자; 상태 · 유형 · 요청자 · 소속 under 세부 정보 더보기. */
  let moreOpen = false;
  const deskInfo = (r, readOnly) => html`<div class="dstack">
    <input class="dtitle" data-field="title" value="${r.title}" maxlength="200" ${readOnly ? 'disabled' : ''} aria-label="제목">
    <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요. 예) 고객이 주문번호로 배송 상태를 조회한다." ${readOnly ? 'disabled' : ''} aria-label="설명">${r.description}</textarea>
    ${raw(critHtml(r, readOnly))}
    <div class="dgrid">
      ${raw(fieldRow(html`범위 ${raw(term('scope'))}`, html`<select class="select select--sm" data-field="scope" ${readOnly ? 'disabled' : ''} aria-label="범위">${raw(opt(REQ_SCOPE, r.scope))}</select>`))}
      ${raw(fieldRow('우선순위', html`<select class="select select--sm" data-field="priority" ${readOnly ? 'disabled' : ''} aria-label="우선순위">${raw(opt(REQ_PRIORITY, r.priority))}</select><small class="hint req-phint">${PRIORITY_HINT}</small>`))}
      ${raw(fieldRow('담당자', html`<select class="select select--sm" data-field="owner_user_id" ${readOnly ? 'disabled' : ''} aria-label="담당자">${raw(ownerOpts(r.owner_user_id || ''))}</select>`))}
    </div>
    <details class="dmore" data-dmore ${moreOpen ? 'open' : ''}><summary>세부 정보 더보기</summary><div class="dgrid">
      ${raw(fieldRow('상태', html`<select class="select select--sm" data-field="status" ${readOnly ? 'disabled' : ''} aria-label="상태">${raw(opt(REQ_STATUS, r.status))}</select>`))}
      ${raw(fieldRow(html`유형 ${raw(term('nonfunctional'))}`, html`<select class="select select--sm" data-field="type" ${readOnly ? 'disabled' : ''} aria-label="유형">${raw(opt(REQ_TYPE, r.type))}</select>`))}
      ${raw(fieldRow('요청자', html`<input class="input input--sm" data-field="requester_name" value="${r.requester_name}" maxlength="100" placeholder="예) 김OO 책임" ${readOnly ? 'disabled' : ''}>`))}
      ${raw(fieldRow('요청자 소속', html`<input class="input input--sm" data-field="requester_organization" value="${r.requester_organization}" maxlength="100" placeholder="예) A사 IT팀" ${readOnly ? 'disabled' : ''}>`))}
    </div></details>
    <div class="dsave" id="dsave"></div>
  </div>`;
  /** Desktop footer: 댓글 · 보관 (left) · 보류 · 확정하기 (the drawer's one primary). */
  const deskFoot = (r, readOnly) => (readOnly ? '' : html`<div class="drawer__f dfoot"><button type="button" class="link linkbtn" data-goto-tab="activity">댓글</button><button type="button" class="link linkbtn dfoot__arch" id="rarchive">보관</button><span class="hint">등록 ${fmtShort(r.created_at)}</span>
    <span class="dfoot__r">${raw(r.status === 'ON_HOLD' ? '<span class="hint">보류 중</span>' : '<button type="button" class="btn btn--secondary btn--sm" data-set-status="ON_HOLD">보류</button>')}${raw(r.status === 'CONFIRMED' ? '<span class="dfoot__ok" data-confirmed>✓ 확정됨</span>' : '<button type="button" class="btn btn--primary btn--sm" data-set-status="CONFIRMED">확정하기</button>')}</span></div>`);

  const drawDetail = () => keepUi(() => {
    const r = sel; if (!r) return;
    const d = $('#drawer'); const readOnly = ro(r);
    const ids = curGrid().orderedIds(); const at = ids.indexOf(r.id);
    const events = mergeActivity({ history: r.history, comments: r.comments || [], fmt: (h) => histText(h, r), meId });
    d.innerHTML = html`<div class="drawer__h"><b class="mono">${r.display_id}</b>${raw(statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) + subtle(REQ_SCOPE[r.scope]))}${raw(r.archived_at ? '<span class="chip">보관됨</span>' : '')}
        <span class="dnav"><button type="button" data-nav="-1" aria-label="이전 요구사항" title="이전 (목록 순서)" ${at <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-nav="1" aria-label="다음 요구사항" title="다음 (목록 순서)" ${at < 0 || at >= ids.length - 1 ? 'disabled' : ''}>↓</button></span>
        <button class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
      ${raw(dtabs([{ key: 'info', label: '업무정보' }, { key: 'links', label: 'WBS 연결', count: r.links.filter((l) => !l.archived_at).length }, { key: 'jira', label: 'Jira', count: reqJira && reqJira.by[r.id] ? reqJira.by[r.id].total : null }, { key: 'activity', label: '댓글·활동', count: events.length }], dtab))}
      <div class="drawer__b">
        <section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
          ${raw(desk ? deskInfo(r, readOnly) : html`
          <div class="dlayout"><div>
            <input class="dtitle" data-field="title" value="${r.title}" maxlength="200" ${readOnly ? 'disabled' : ''} aria-label="제목">
            <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${readOnly ? 'disabled' : ''}>${r.description}</textarea>
            ${raw(critHtml(r, readOnly))}
          </div>
          <div class="dside">
            ${raw(fieldRow('상태', html`<select class="select select--sm" data-field="status" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_STATUS, r.status))}</select>`))}
            ${raw(fieldRow(html`범위 ${raw(term('scope'))}`, html`<select class="select select--sm" data-field="scope" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_SCOPE, r.scope))}</select>`))}
            ${raw(fieldRow('우선순위', html`<select class="select select--sm" data-field="priority" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_PRIORITY, r.priority))}</select><small class="hint req-phint">${PRIORITY_HINT}</small>`))}
            ${raw(fieldRow(html`유형 ${raw(term('nonfunctional'))}`, html`<select class="select select--sm" data-field="type" ${readOnly ? 'disabled' : ''}>${raw(opt(REQ_TYPE, r.type))}</select>`))}
            ${raw(fieldRow('담당자', html`<select class="select select--sm" data-field="owner_user_id" ${readOnly ? 'disabled' : ''}>${raw(ownerOpts(r.owner_user_id || ''))}</select>`))}
            ${raw(fieldRow('요청자', html`<input class="input input--sm" data-field="requester_name" value="${r.requester_name}" maxlength="100" placeholder="이름" ${readOnly ? 'disabled' : ''}>`))}
            ${raw(fieldRow('요청자 소속', html`<input class="input input--sm" data-field="requester_organization" value="${r.requester_organization}" maxlength="100" placeholder="소속" ${readOnly ? 'disabled' : ''}>`))}
            <div class="dsave" id="dsave"></div>
          </div></div>
          `)}
        </section>
        <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>
          ${raw(wbsPhase() ? deliveryTrace(r) : '')}
          ${raw(linkSection(r, readOnly))}
          <h4 class="dh">관련 테스트 <em>${r.testing ? r.testing.tests.length : 0}</em>${raw(r.testing && r.testing.tests.length ? html`<span style="margin-left:auto">${raw(verifyChip(r.testing.summary.verification))}</span>` : '')}</h4>
          ${raw(r.testing && r.testing.tests.length ? html`<p class="hint" style="margin:-4px 0 8px">${testSummaryText(r.testing.summary)}</p><ol class="crit links">${raw(r.testing.tests.map((t) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${t.id}" data-link><span class="mono">${t.display_id}</span><span class="crit__in" style="padding:6px 4px">${t.title}</span><span class="chip ${TC_STATUS_CHIP[t.status] || ''}">${TC_STATUS[t.status]}</span>${raw(resBadge(t.last_result))}</a></li>`).join(''))}</ol>`
            : html`<p class="hint">아직 연결된 테스트가 없습니다.${raw(readOnly || r.scope !== 'IN_SCOPE' ? '' : html` <a class="link" href="/app/projects/${p.id}/tests?new=1&requirement=${r.id}" data-link>테스트 추가</a>`)}</p>`)}
          ${raw(r.acceptances && r.acceptances.length ? html`<p class="raidline">${raw(r.acceptances.map((a) => html`<a href="/app/projects/${p.id}/tests?tab=acceptance&sel=${a.id}" data-link>${a.display_id} <b>${ACC_STATUS[a.status]}</b></a>`).join(''))}</p>` : '')}
          ${raw(r.raid && (r.raid.issues.length || r.raid.risks.length) ? html`<p class="raidline">${raw(r.raid.issues.length ? html`<a href="/app/projects/${p.id}/issues?requirement=${r.id}" data-link>관련 이슈 <b>${r.raid.issues.length}</b></a>` : '')}${raw(r.raid.risks.length ? html`<a href="/app/projects/${p.id}/issues?tab=risks&requirement=${r.id}" data-link>관련 리스크 <b>${r.raid.risks.length}</b></a>` : '')}</p>` : '')}
        </section>
        <section data-pane="jira" class="dpane-jira" ${dtab === 'jira' ? '' : 'hidden'}>${raw(reqJiraPaneHtml(reqJiraDetail, r, { ro: readOnly }))}</section>
        <section data-pane="activity" ${dtab === 'activity' ? '' : 'hidden'}>${raw(activityPane({ events, filter: actFilter, ro: archived }))}</section>
      </div>
      ${raw(desk ? deskFoot(r, readOnly) : drawerFoot({ ro: readOnly, meta: `등록 ${fmtShort(r.created_at)}`, label: '요구사항 보관', id: 'rarchive' }))}`;
    bindDetail();
  });

  /** Delivery Trace — summary numbers with drill-down to each filtered list. */
  const deliveryTrace = (r) => {
    const u = `/app/projects/${p.id}`; const live = r.links.filter((l) => !l.archived_at);
    const t = r.testing ? r.testing.summary : { total: 0 }; const issues = r.raid ? r.raid.issues.length : 0; const risks = r.raid ? r.raid.risks.length : 0;
    const acc = r.acceptances && r.acceptances.length ? r.acceptances[0] : null;
    return traceStrip([
      { label: 'WBS', value: live.length, href: `${u}/wbs?requirement=${r.id}`, tone: live.length ? '' : r.scope === 'IN_SCOPE' && r.status !== 'REJECTED' ? 'warn' : 'muted' },
      ...((() => { const j = reqJira && reqJira.by[r.id]; return j && j.total ? [{ label: 'Jira', value: `${j.done}/${j.total} 완료`, sub: `지라 진행률 ${j.rate}%`, href: `${location.pathname}?sel=${r.id}&tab=jira`, tone: j.done === j.total ? 'ok' : '' }] : []; })()),
      ...(r.jira && r.jira.total && !(reqJira && reqJira.by[r.id]) ? [{ label: 'Jira', value: `${r.jira.done}/${r.jira.total} 완료`, sub: `${r.jira.rate}% · WBS 경유`, href: `${u}/wbs?requirement=${r.id}`, tone: r.jira.done === r.jira.total ? 'ok' : '' }] : []),
      { label: '변경 요청', value: r.changes ? r.changes.length : 0, href: `${u}/changes?requirement=${r.id}`, tone: r.changes && r.changes.length ? '' : 'muted' },
      { label: '이슈', value: issues, sub: risks ? `리스크 ${risks}` : '', href: `${u}/issues?requirement=${r.id}`, tone: issues ? 'warn' : 'muted' },
      { label: '테스트', value: t.total, sub: t.total ? `통과 ${t.pass} · 실패 ${t.fail}` : r.test_exclusion_reason ? '테스트 제외' : '', href: `${u}/tests?requirement=${r.id}`, tone: t.fail ? 'crit' : t.total && t.verification === 'VERIFIED' ? 'ok' : t.total ? '' : 'muted' },
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
      case 'TEST_EXCLUDED': return html`테스트 제외 <q>${h.new_value}</q>`;   // Phase 5 US-1
      case 'TEST_EXCLUSION_CANCELLED': return html`테스트 제외 취소 <q>${h.old_value}</q>`;
      case 'CRITERION_ADDED': return html`완료 조건 추가 <q>${h.new_value}</q>`;
      case 'CRITERION_UPDATED': return html`완료 조건 수정 <q>${h.old_value}</q> → <q>${h.new_value}</q>`;
      case 'CRITERION_REMOVED': return html`완료 조건 삭제 <q>${h.old_value}</q>`;
      case 'LINKED_WBS': return html`WBS 연결 <q>${lt(h.new_value)}</q>`;
      case 'UNLINKED_WBS': return html`WBS 연결 해제 <q>${h.old_value}</q>`;
      case 'JIRA_LINKED': return html`Jira 이슈 연결 <q>${h.new_value}</q>`;
      case 'JIRA_UNLINKED': return html`Jira 이슈 연결 해제 <q>${h.old_value}</q>`;
      case 'JIRA_DONE': return html`연결된 Jira 이슈가 모두 완료 — 구현 완료로 표시`;
      case 'JIRA_DONE_CLEARED': return html`Jira 이슈가 다시 진행 중 — 구현 완료 표시 해제`;
      case 'LINK_TYPE_CHANGED': return html`연결 유형 변경 <q>${lt(h.old_value)}</q> → <q>${lt(h.new_value)}</q>`;
      default: {
        const f = h.field_name; const long = f === 'title' || f === 'description';
        return html`<b>${REQ_FIELD_LABEL[f] || f}</b> ${raw(long ? (f === 'description' ? '변경' : html`<q>${h.old_value}</q> → <q>${h.new_value}</q>`) : html`${val(f, h.old_value)} → ${val(f, h.new_value)}`)}${raw(h.source_change_request_id ? html`<small>변경 출처 <a href="/app/projects/${p.id}/changes?sel=${h.source_change_request_id}" data-link>${h.source_change_display_id || 'CR'} ${h.source_change_title || ''}</a>${h.source_change_archived_at ? ' (보관됨)' : ''}</small>` : '')}`;
      }
    }
  };

  const bindDetail = () => {
    const r = sel; const d = $('#drawer'); const status = $('#dsave');
    $('#dclose').onclick = closeDrawer;
    bindDtabs(d, (k) => { dtab = k; if (k === 'jira' && !reqJiraDetail) loadJira(); });
    const loadJira = async () => { const rid = r.id; try { reqJiraDetail = await api('GET', rApi(`/${rid}/jira`)); } catch (e) { reqJiraDetail = { error: e.message }; } if (sel && sel.id === rid) drawDetail(); };
    if (dtab === 'jira' && !reqJiraDetail) loadJira();
    bindReqJiraPane(d.querySelector('[data-pane="jira"]'), { pid: id, rid: r.id, r, onChange: async (j) => { reqJiraDetail = j; try { await load(); sel = (await api('GET', rApi(`/${r.id}`))).requirement; } catch { /* keep */ } curGrid().refresh(); drawDetail(); } });
    d.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { const ids = curGrid().orderedIds(); const n = ids[ids.indexOf(r.id) + Number(b.dataset.nav)]; if (n) openDetail(n); });
    bindArrowNav((dir) => { if (!sel) return; const ids = curGrid().orderedIds(); const n = ids[ids.indexOf(sel.id) + dir]; if (n) openDetail(n); });   // R2: keyboard ↑/↓ between items
    const dm = d.querySelector('[data-dmore]'); if (dm) dm.ontoggle = () => { moreOpen = dm.open; };
    d.querySelectorAll('[data-goto-tab]').forEach((b) => { b.onclick = () => { dtab = b.dataset.gotoTab; drawDetail(); }; });
    d.querySelectorAll('[data-set-status]').forEach((b) => { b.onclick = async () => { b.disabled = true; await save('status', b.dataset.setStatus); const v = b.dataset.setStatus; if (sel && sel.status === v) toast(v === 'CONFIRMED' ? `${r.display_id} 확정했습니다.` : `${r.display_id} 보류했습니다.`); }; });
    const refreshAll = async (data) => { if (data.requirement) sel = data.requirement; if (data.summary) summary = data.summary; await load(); paintKpi(); curGrid().refresh(); drawDetail(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try {
        const res = await api('PATCH', rApi(`/${r.id}`), { [field]: value, ...crBody() });
        await refreshAll(res);
        const s = $('#dsave'); if (s) s.textContent = res.changed.length ? '저장됨' : '변경 없음';
      } catch (e) { status.textContent = e.message; toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    // 확정 요구사항의 제목·설명·범위 → 변경 요청 prompt first (US-3); 취소 / 변경 요청 → the field shows the saved value again
    const guarded = async (el, field, value) => { if (!(await guardEdit(id, { r, field, before: r[field], after: value }, () => save(field, value)))) { el.value = r[field] || ''; drawDetail(); } };
    d.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT') el.onchange = () => (field === 'scope' ? guarded(el, field, el.value) : save(field, el.value));
      else {
        el.onblur = () => { if (el.value.trim() !== (r[field] || '')) { if (field === 'title' || field === 'description') guarded(el, field, el.value); else save(field, el.value); } };
        if (el.tagName === 'INPUT') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); };
      }
    });
    const critApi = async (method, path, body) => { try { await refreshAll(await api(method, rApi(`/${r.id}${path}`), body)); } catch (e) { toast(e.message); } };
    const addIn = $('#crit-in');
    const critGuard = (before, after, run) => guardEdit(id, { r, field: 'criteria', before, after }, run);
    const add = () => { const v = addIn.value.trim(); if (!v) return; critGuard('', v, () => critApi('POST', '/criteria', { content: v })).then((ok) => { if (!ok) addIn.value = ''; }); };
    if (addIn) { addIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }; $('#crit-add').onclick = add; }
    d.querySelectorAll('[data-crit-in]').forEach((inp) => {
      const c = r.criteria.find((x) => x.id === inp.dataset.critIn);
      inp.onblur = () => { const v = inp.value.trim(); if (v && v !== c.content) critGuard(c.content, v, () => critApi('PATCH', `/criteria/${c.id}`, { content: v })).then((ok) => { if (!ok) inp.value = c.content; }); else inp.value = c.content; };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    });
    d.querySelectorAll('[data-crit-move]').forEach((b) => b.onclick = () => { const c = r.criteria.find((x) => x.id === b.dataset.critMove); critApi('PATCH', `/criteria/${c.id}`, { sequence: c.sequence + Number(b.dataset.dir) }); });
    d.querySelectorAll('[data-crit-del]').forEach((b) => b.onclick = async () => {
      const c = r.criteria.find((x) => x.id === b.dataset.critDel);
      if (needsPrompt(r, 'criteria')) { await critGuard(c.content, '(삭제)', () => critApi('DELETE', `/criteria/${c.id}`)); return; }
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
      if (needsPrompt(r, 'archive')) { if (!(await guardEdit(id, { r, field: 'archive' }, async () => {}))) return; }   // 확정된 범위 내 → prompt; 변경 요청 = CR only, not archived
      else if (!(await confirmDialog({ title: `${josa(r.display_id, '을')} 보관할까요?`, body: '보관된 요구사항은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않습니다.', confirm: '보관하기', danger: true }))) return;
      try { const res = await api('POST', rApi(`/${r.id}/archive`), {}); sel = res.requirement; toast(`${r.display_id}을 보관했습니다.`); await load(); paintKpi(); curGrid().refresh(); drawDetail(); } catch (e) { toast(e.message); }
    };
  };

  if (params().get('approval') === '1' && !apvOpen) setParam('approval', '');
  await load();
  const initSel = params().get('sel');
  if (initSel && params().get('tab') === 'jira') { dtab = 'jira'; setParam('tab', ''); }
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
}
