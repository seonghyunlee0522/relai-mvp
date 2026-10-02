import { api, getMembers, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw, todayLocal } from '../core/dom.js';
import { state } from '../core/state.js';
import { download, keepUi } from '../core/ui.js';
import { projectHead } from '../project/guide.js';
import { resBadge, sevBadge, verifyChip } from '../shared/badges.js';
import { ISSUE_STATUS, ISSUE_STATUS_CHIP, LINK_TYPE, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, RISK_STATUS, RISK_STATUS_CHIP, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE } from '../shared/constants.js';
import { traceStrip } from '../shared/trace-strip.js';
import { drawerFoot, bindEscape } from '../shared/drawer.js';
import { appliedFilters, bindFilterClears } from '../shared/filters.js';
import { emptyState } from '../shared/empty-state.js';
import { createGrid } from '../shared/grid.js';
import { bulkRun, mountBulk } from '../shared/bulk.js';
import { activityPane, bindActivity, bindDtabs, dtabs, mergeActivity } from '../shared/detail.js';
import { openImport } from '../shared/importer.js';
import { confirmDialog, pickerDialog, showErrors, toast } from '../shared/dialogs.js';

export async function wbsPage(id) {
  const main = $('#main');
  const [g, members] = await Promise.all([api('GET', wsApi(`/${id}`)), getMembers()]);
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  document.title = `WBS — ${p.name} — RELAI`;
  const wApi = (s = '') => wsApi(`/${id}/wbs${s}`);
  const meId = state.user.id;
  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };

  let items = []; let summary = g.wbs; let sel = null; let creating = params().get('new') === '1';
  let dtab = 'info'; let actFilter = 'ALL'; let qaParent = '';
  // Context from other screens: ?requirement=<id> narrows to that requirement's WBS; ?cr=<id> shows the Change Request banner.
  let ctxReq = null; let ctxCr = null;
  if (params().get('requirement')) { try { ctxReq = (await api('GET', wsApi(`/${id}/requirements/${params().get('requirement')}`))).requirement; } catch { setParam('requirement', ''); } }
  if (params().get('cr')) { try { ctxCr = (await api('GET', wsApi(`/${id}/changes/${params().get('cr')}`))).change; } catch { setParam('cr', ''); } }
  const collapsed = new Set(); const gx = { px: 16, mode: 'fit', left: 0, start: null }; // Gantt viewport: mode = fit | today | keep
  const view = () => (params().get('view') === 'gantt' ? 'gantt' : 'list');
  const quick = () => params().get('f') || '';
  const QUICK_LABEL = { no_owner: '담당자 미지정 작업', no_dates: '일정 미설정 작업', linked: '요구사항 연결됨', unlinked: '요구사항 미연결 작업', overdue: '지연 작업' };
  const isOverdue = (it) => it.item_type === 'TASK' && it.status !== 'COMPLETED' && it.planned_end_date && it.planned_end_date < todayLocal();
  const byId = () => new Map(items.map((i) => [i.id, i]));
  const apply = (r) => { items = r.items || items; summary = r.summary || summary; if (r.item && sel && r.item.id === sel.id) sel = r.item; syncRows(); paintKpi(); };
  const load = async () => { const d = await api('GET', wApi()); items = d.items; summary = d.summary; syncRows(); };
  const loadSel = async (iid) => { sel = iid ? (await api('GET', wApi(`/${iid}`))).item : null; setParam('sel', iid); };

  /** Visible rows after collapse + quick filter (a filter shows matching tasks together with their ancestors). */
  const visible = () => {
    const m = byId(); const f = quick();
    let keep = null;
    const reqWbs = ctxReq ? new Set(ctxReq.links.map((l) => l.wbs_item_id)) : null;
    const crWbs = ctxCr ? new Set((ctxCr.impacts || []).map((l) => l.wbs_item_id)) : null;
    if (f || reqWbs || crWbs) {
      keep = new Set();
      for (const it of items) {
        let hit = !f || (f === 'linked' ? it.linked_req_count > 0
          : f === 'overdue' ? isOverdue(it)
          : it.item_type === 'TASK' && (f === 'no_owner' ? !it.owner_user_id : f === 'no_dates' ? (!it.planned_start_date || !it.planned_end_date) : f === 'unlinked' ? it.linked_req_count === 0 : true));
        if (reqWbs && !reqWbs.has(it.id)) hit = false;
        if (crWbs && crWbs.size && !crWbs.has(it.id)) hit = false;
        if (!hit) continue;
        let cur = it; while (cur) { keep.add(cur.id); cur = cur.parent_id ? m.get(cur.parent_id) : null; }
      }
    }
    const out = []; const hidden = new Set();
    for (const it of items) {
      if (it.parent_id && (hidden.has(it.parent_id) || collapsed.has(it.parent_id))) { hidden.add(it.id); continue; }
      if (keep && !keep.has(it.id)) { hidden.add(it.id); continue; }
      out.push(it);
    }
    return out;
  };
  const syncRows = () => grid.setRows(visible());

  const ownerOpts = (cur) => html`<option value="">미지정</option>` + members.map((mm) => html`<option value="${mm.id}" ${cur === mm.id ? 'selected' : ''}>${mm.name}</option>`).join('');
  const ownerPairs = [['', '미지정'], ...members.map((m) => [m.id, m.name])];
  const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const parentOpts = (cur, excludeId) => {
    const m = byId(); const blocked = new Set();
    if (excludeId) { blocked.add(excludeId); for (const it of items) { let c = it; while (c) { if (c.id === excludeId) { blocked.add(it.id); break; } c = c.parent_id ? m.get(c.parent_id) : null; } } }
    return html`<option value="">(최상위)</option>` + items.filter((i) => i.item_type !== 'MILESTONE' && !blocked.has(i.id))
      .map((i) => html`<option value="${i.id}" ${cur === i.id ? 'selected' : ''}>${'  '.repeat(i.depth)}${i.wbs_code} ${i.title}</option>`).join('');
  };
  const dim = (t = '-') => html`<span class="dim">${t}</span>`;
  const dateCell = (d, derived = false) => (d ? (derived ? html`<span class="dim">${fmtShort(d)}</span>` : html`${fmtShort(d)}`) : dim());

  /** Summary date span derived from descendants (display only). */
  let spanCache = null;
  const spans = () => {
    if (spanCache && spanCache.items === items) return spanCache.map;
    const map = new Map(); const m = byId();
    for (const x of items) {
      const a = x.item_type === 'MILESTONE' ? x.milestone_date : x.planned_start_date; const b = x.item_type === 'MILESTONE' ? x.milestone_date : x.planned_end_date;
      if (!a && !b) continue;
      let c = x.parent_id ? m.get(x.parent_id) : null;
      while (c) { const cur = map.get(c.id) || { s: null, e: null }; if (a && (!cur.s || a < cur.s)) cur.s = a; if (b && (!cur.e || b > cur.e)) cur.e = b; map.set(c.id, cur); c = c.parent_id ? m.get(c.parent_id) : null; }
    }
    spanCache = { items, map }; return map;
  };
  const span = (it) => { if (it.item_type !== 'SUMMARY') return { s: it.planned_start_date, e: it.planned_end_date, derived: false }; const x = spans().get(it.id) || { s: null, e: null }; return { ...x, derived: true }; };

  /* ---------- grid (tree) ---------- */
  const roRow = (it) => archived || Boolean(it.archived_at);
  const titleCell = (it, { withAdd = true } = {}) => html`<div class="wtitle" style="padding-left:${it.depth * 18}px">
    ${raw(it.children_count ? html`<button class="wtog" data-tog="${it.id}" aria-label="${collapsed.has(it.id) ? '펼치기' : '접기'}">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : '<span class="wtog wtog--none"></span>')}
    ${raw(it.item_type === 'MILESTONE' ? '<i class="wms" title="마일스톤">◆</i>' : '')}<span class="${it.item_type === 'SUMMARY' ? 'wsum' : ''}">${it.title}</span>
    ${raw(it.predecessors.length ? html`<small class="wdep" title="선행 작업 ${it.predecessors.length}개">←${it.predecessors.length}</small>` : '')}
    ${raw(it.linked_req_count ? html`<small class="wdep" title="연결된 요구사항 ${it.linked_req_count}개">REQ ${it.linked_req_count}</small>` : '')}
    ${raw(withAdd && !archived && it.item_type !== 'MILESTONE' ? html`<button class="wadd" data-addchild="${it.id}" title="하위 항목 추가" aria-label="하위 항목 추가">+</button>` : '')}</div>`;
  const editable = (it, col) => {
    if (roRow(it)) return false;
    const f = col.edit.field;
    if (it.item_type === 'SUMMARY') return f === 'status';
    if (it.item_type === 'MILESTONE') return f === 'status' || f === 'owner_user_id' || f === 'planned_end_date';
    return true;
  };
  const grid = createGrid({
    key: 'wbs.tree', rowId: (r) => r.id, paginate: false, sortable: false,
    rowClass: (r) => `${r.item_type === 'SUMMARY' ? 'is-sum' : ''} ${isOverdue(r) ? 'is-late' : ''}`,
    canEdit: editable, activeId: () => (sel ? sel.id : null), onOpen: (iid) => openDetail(iid),
    onSelect: (s) => bulk.update(s.size),
    onEdit: async (iid, field, value) => {
      const it = byId().get(iid);
      const f = it.item_type === 'MILESTONE' && field === 'planned_end_date' ? 'milestone_date' : field;
      try { apply(await api('PATCH', wApi(`/${iid}`), { [f]: value })); if (sel && sel.id === iid) { sel = (await api('GET', wApi(`/${iid}`))).item; drawDetail(); } }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); throw e; }
    },
    columns: [
      { key: 'code', label: 'WBS', width: 74, sticky: true, fixed: true, cls: 'mono wcode', render: (r) => html`${r.wbs_code}` },
      { key: 'title', label: '업무명', width: 380, min: 180, sticky: true, fixed: true, cls: 'ttl', render: (r) => titleCell(r) },
      { key: 'status', label: '상태', width: 112, edit: { type: 'select', field: 'status', options: WBS_STATUS }, render: (r) => html`<span class="chip ${WBS_STATUS_CHIP[r.status] || ''}">${WBS_STATUS[r.status]}</span>` },
      { key: 'owner', label: '담당자', width: 132, edit: { type: 'select', field: 'owner_user_id', options: ownerPairs, value: (r) => r.owner_user_id || '', prefix: (r) => (r.owner_name ? html`<i class="av">${[...r.owner_name][0]}</i>` : '') },
        render: (r) => (r.owner_name ? html`<span class="cellwrap"><i class="av">${[...r.owner_name][0]}</i>${r.owner_name}</span>` : dim()) },
      { key: 'start', label: '시작일', width: 124, edit: { type: 'date', field: 'planned_start_date' }, render: (r) => (r.item_type === 'MILESTONE' ? dim('마일스톤') : (() => { const s = span(r); return dateCell(s.s, s.derived); })()) },
      { key: 'end', label: '종료일', width: 124, edit: { type: 'date', field: 'planned_end_date', value: (r) => (r.item_type === 'MILESTONE' ? r.milestone_date : r.planned_end_date) }, render: (r) => (r.item_type === 'MILESTONE' ? dateCell(r.milestone_date) : (() => { const s = span(r); return dateCell(s.e, s.derived); })()) },
      { key: 'progress', label: '진행률', width: 130, align: 'right', edit: { type: 'number', field: 'progress', value: (r) => r.progress },
        render: (r) => (r.item_type === 'MILESTONE' ? '' : html`<div class="pcell"><div class="pbar"><i style="width:${r.computed_progress}%"></i></div><span>${r.computed_progress}%</span></div>`) },
      { key: 'type', label: '유형', width: 84, render: (r) => WBS_TYPE[r.item_type] },
      { key: 'astart', label: '실제 시작', width: 124, hidden: true, edit: { type: 'date', field: 'actual_start_date' }, render: (r) => dateCell(r.actual_start_date) },
      { key: 'aend', label: '실제 종료', width: 124, hidden: true, edit: { type: 'date', field: 'actual_end_date' }, render: (r) => dateCell(r.actual_end_date) },
    ],
    empty: () => (items.length ? emptyState({ title: '조건에 맞는 작업이 없습니다.', body: '보기 조건을 바꾸거나 필터를 초기화하세요.', cta: { id: 'clear2', label: '필터 초기화' }, small: true }) : ''),
  });
  // date/number editors apply to rows whose type allows them (canEdit above); the grid renders plain text elsewhere.

  /* ---------- bulk ---------- */
  const NONE = '__none';
  const bulk = { update() {}, destroy() {} };
  const bulkFields = [
    { key: 'status', label: '상태', options: WBS_STATUS }, { key: 'owner_user_id', label: '담당자', options: [[NONE, '미지정'], ...members.map((m) => [m.id, m.name])] },
    { key: 'planned_start_date', label: '계획 시작일', type: 'date' }, { key: 'planned_end_date', label: '계획 종료일', type: 'date' },
    { key: 'shift_days', label: '일정 이동(일)', type: 'number', min: -3650, max: 3650, hint: '예: 7 (−는 앞으로)' },
    { key: 'progress', label: '진행률(%)', type: 'number', min: 0, max: 100, hint: '0~100' },
  ];
  const reportBulk = (r, verb) => {
    const sk = r.skipped.length;
    toast(sk ? `${r.updated.toLocaleString('ko-KR')}건 ${verb}, ${sk.toLocaleString('ko-KR')}건 제외 (${r.skipped[0].reason})` : `${r.updated.toLocaleString('ko-KR')}건을 ${verb}했습니다.`);
  };
  const bulkAfter = async (r) => {
    if (r.last) apply(r.last); else await load();
    grid.clearSelection(); grid.refresh();
    if (sel) { try { sel = (await api('GET', wApi(`/${sel.id}`))).item; drawDetail(); } catch { sel = null; setParam('sel', ''); closeDrawer(); } }
  };
  const mountBulkBar = () => {
    const slot = $('#bulkslot'); if (!slot) return;
    const b = mountBulk(slot, {
      fields: bulkFields, canArchive: !archived,
      onApply: async ({ field, value }) => {
        const n = grid.selected.size; const f = bulkFields.find((x) => x.key === field);
        const shown = value === NONE ? '미지정' : (Array.isArray(f.options) ? f.options : Object.entries(f.options || {})).find(([v]) => v === value)?.[1] || value;
        if (n >= 20 && !(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건의 ${f.label}을(를) ${field === 'shift_days' ? `${value}일 이동` : `'${shown}'(으)로 변경`}할까요?`, body: '선택한 모든 WBS 항목에 적용되며 각각 변경 이력이 남습니다. 상위 항목·마일스톤 등 적용할 수 없는 항목은 제외되고 결과에 표시됩니다.', confirm: '일괄 변경' }))) return;
        const body = field === 'shift_days' ? { action: 'update', shift_days: value } : { action: 'update', patch: { [field]: value === NONE ? '' : value } };
        try { const r = await bulkRun(wApi('/bulk'), grid.selectedIds(), body); reportBulk(r, '변경'); await bulkAfter(r); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
      },
      onArchive: async () => {
        const n = grid.selected.size;
        if (!(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건을 보관할까요?`, body: '하위 항목도 함께 보관되고 WBS 번호가 다시 매겨집니다. 선행 관계는 기록으로 남습니다.', confirm: '보관하기', danger: true }))) return;
        try { const r = await bulkRun(wApi('/bulk'), grid.selectedIds(), { action: 'archive' }); reportBulk(r, '보관'); await bulkAfter(r); } catch (e) { toast(e.message); }
      },
      onClear: () => grid.clearSelection(),
    });
    bulk.update = b.update; bulk.destroy = b.destroy;
  };

  /* ---------- Gantt (unchanged behaviour) ---------- */
  const day = 86400000; const toD = (s) => new Date(s + 'T00:00:00');
  /** Active TASK/MILESTONE date range ±5 days; today-based default only when nothing is scheduled. */
  const fitRange = () => {
    const ts = [];
    for (const it of items) { if (it.item_type === 'SUMMARY') continue; for (const k of ['planned_start_date', 'planned_end_date', 'milestone_date']) if (it[k]) ts.push(toD(it[k]).getTime()); }
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const min = (ts.length ? Math.min(...ts) : t0.getTime() - 7 * day) - 5 * day; const max = (ts.length ? Math.max(...ts) : t0.getTime() + 30 * day) + 5 * day;
    return { min, max, days: Math.max(14, Math.round((max - min) / day) + 1) };
  };
  const placeGantt = () => {
    const sc = main.querySelector('.gantt__scroll'); if (!sc) return;
    sc.onscroll = () => { gx.left = sc.scrollLeft; };
    const px = gx.px;
    if (gx.mode === 'fit') {
      const fr = fitRange(); const npx = Math.max(3, Math.min(40, Math.floor(sc.clientWidth / fr.days)));
      if (npx !== gx.px) { gx.px = npx; draw(); return; }
      sc.scrollLeft = Math.max(0, Math.round((fr.min - gx.start) / day) * px); gx.left = sc.scrollLeft; gx.mode = 'keep';
    } else if (gx.mode === 'today') {
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      sc.scrollLeft = Math.max(0, Math.round((t0 - gx.start) / day) * px + px / 2 - sc.clientWidth / 2); gx.left = sc.scrollLeft; gx.mode = 'keep';
    } else sc.scrollLeft = gx.left;
  };
  const gantt = (rows) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const px = gx.px;
    const fr = fitRange(); const lo = Math.min(fr.min, today.getTime()); const hi = Math.max(fr.max, today.getTime());
    const start = new Date(lo); start.setDate(start.getDate() - start.getDay() - 7);
    const end = new Date(hi); end.setDate(end.getDate() + (7 - end.getDay()) + 7);
    const days = Math.round((end - start) / day); gx.start = start;
    const x = (d) => Math.round((toD(d) - start) / day) * px;
    const weeks = []; for (let t = new Date(start); t < end; t.setDate(t.getDate() + 7)) weeks.push(new Date(t));
    const months = []; for (let t = new Date(start); t < end; t.setDate(t.getDate() + 1)) { const key = `${t.getFullYear()}.${t.getMonth() + 1}`; if (!months.length || months[months.length - 1].key !== key) months.push({ key, start: new Date(t), days: 0 }); months[months.length - 1].days++; }
    const todayX = Math.round((today - start) / day) * px + px / 2;
    return html`<div class="gantt">
      <div class="gantt__left"><div class="gantt__hdr"><span>WBS</span><span>업무명</span></div>
        ${raw(rows.map((it) => html`<div class="gantt__row ${sel && sel.id === it.id ? 'is-sel' : ''} ${it.item_type === 'SUMMARY' ? 'is-sum' : ''}" data-row="${it.id}"><span class="mono wcode">${it.wbs_code}</span>${raw(titleCell(it, { withAdd: false }))}</div>`).join(''))}</div>
      <div class="gantt__scroll"><div class="gantt__right" style="width:${days * px}px">
        <div class="gantt__hdr gantt__hdr--m">${raw(months.map((mo) => html`<span style="width:${mo.days * px}px">${mo.key}</span>`).join(''))}</div>
        <div class="gantt__hdr gantt__hdr--w">${raw(weeks.map((w) => html`<span style="width:${7 * px}px">${w.getMonth() + 1}/${w.getDate()}</span>`).join(''))}</div>
        <div class="gantt__body" style="background-size:${7 * px}px 100%">
          <div class="gantt__today" style="left:${todayX}px"><em>오늘</em></div>
          ${raw(rows.map((it) => {
            let bar = '';
            if (it.item_type === 'MILESTONE' && it.milestone_date) bar = html`<i class="gms ${it.status === 'COMPLETED' ? 'is-done' : ''}" style="left:${x(it.milestone_date) + px / 2}px" title="${it.title} · ${it.milestone_date}"></i><b class="glab" style="left:${x(it.milestone_date) + px / 2 + 12}px">${it.title}</b>`;
            else { const sp = span(it); if (sp.s && sp.e) { const l = x(sp.s); const w = x(sp.e) - l + px;
              bar = html`<i class="gbar ${it.item_type === 'SUMMARY' ? 'gbar--sum' : ''} ${it.status === 'COMPLETED' ? 'is-done' : ''}" style="left:${l}px;width:${w}px" title="${it.title} · ${sp.s} – ${sp.e}"><span style="width:${it.computed_progress}%"></span></i>`; }
              else bar = html`<b class="glab glab--none">일정 없음</b>`; }
            return html`<div class="gantt__row ${sel && sel.id === it.id ? 'is-sel' : ''}" data-row="${it.id}">${raw(bar)}</div>`;
          }).join(''))}
        </div></div></div></div>`;
  };

  /* ---------- page ---------- */
  const kpiHtml = () => {
    const late = items.filter(isOverdue).length;
    return html`<button type="button" class="kchip" data-kf=""><b>${summary.total}</b>전체 항목</button>
      <span class="kchip"><b>${summary.in_progress}</b>진행 중</span><span class="kchip"><b>${summary.completed}</b>완료</span><span class="kchip"><b>${summary.milestones}</b>마일스톤</span>
      <button type="button" class="kchip ${late ? 'is-crit' : ''}" data-kf="overdue"><b>${late}</b>지연 작업</button>`;
  };
  const paintKpi = () => { const k = $('#kstrip'); if (k) k.innerHTML = kpiHtml(); };

  const draw = () => {
    const rows = visible(); const v = view(); const f = quick();
    g.wbs = summary;
    const body = !items.length ? emptyState({ title: '아직 등록된 WBS가 없습니다.', body: '한 건씩 추가하거나 Excel(WBS Code 계층)로 한 번에 등록하세요. 등록한 WBS는 요구사항, 변경 요청, 이슈, 테스트와 연결됩니다.', cta: archived ? null : { id: 'add2', label: '첫 WBS 만들기' } })
      : v === 'gantt' ? html`<div class="rtable-wrap wbs-wrap">${raw(rows.length ? gantt(rows) : emptyState({ title: '조건에 맞는 작업이 없습니다.', body: '보기 조건을 바꾸거나 필터를 초기화하세요.', cta: { id: 'clear2', label: '필터 초기화' }, small: true }))}</div>`
      : grid.html();
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'wbs' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. WBS는 조회만 할 수 있습니다.</div>' : '')}
      ${raw(ctxCr ? html`<div class="ctx"><span><b>${ctxCr.display_id}</b> ${ctxCr.title}에서 이동했습니다. ${ctxCr.impacts && ctxCr.impacts.length ? `영향 WBS ${ctxCr.impacts.length}건만 표시합니다.` : '영향 WBS가 등록되지 않아 전체를 표시합니다.'} 반영이 끝나면 변경 요청을 '반영 완료'로 바꾸세요.</span><a class="link" href="/app/projects/${p.id}/changes?sel=${ctxCr.id}" data-link>변경 요청 보기</a><button class="linkbtn" id="ctx-off" type="button">컨텍스트 해제</button></div>` : '')}
      <div class="rtool">
        <div class="seg" role="tablist"><button class="${v === 'list' ? 'is-on' : ''}" data-view="list" role="tab">목록</button><button class="${v === 'gantt' ? 'is-on' : ''}" data-view="gantt" role="tab">Gantt</button></div>
        ${raw(v === 'gantt' ? '<span class="gtools"><button class="btn btn--secondary btn--sm" id="gfit">전체 일정</button><button class="btn btn--secondary btn--sm" id="gtoday">오늘</button></span>' : '')}
        <select class="select select--sm" id="quick"><option value="">전체 보기</option>${raw(Object.entries(QUICK_LABEL).map(([k, l]) => html`<option value="${k}" ${f === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>
        <button class="link linkbtn" id="expall" style="width:auto">모두 펼치기</button><button class="link linkbtn" id="colall" style="width:auto">모두 접기</button>
        <span class="rtool__sp"></span>
        ${raw(v === 'list' && items.length ? grid.toolsHtml() : '')}
        <span class="gtools"><button type="button" class="btn btn--secondary btn--sm" id="xl-btn" aria-haspopup="true">Excel ▾</button>
          <div class="gpop" id="xl-pop" hidden>${raw(archived ? '' : '<button type="button" class="gpop__i linkbtn" data-xl="import">Excel로 가져오기…</button>')}<button type="button" class="gpop__i linkbtn" data-xl="template">등록 템플릿 내려받기</button><button type="button" class="gpop__i linkbtn" data-xl="export">현재 WBS 내보내기</button></div></span>
        ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ WBS 추가</button>')}
      </div>
      <div class="kstrip" id="kstrip">${raw(kpiHtml())}</div>
      ${raw(appliedFilters(params(), [{ key: 'f', label: '보기', map: QUICK_LABEL }, { key: 'requirement', label: '요구사항', format: () => (ctxReq ? `${ctxReq.display_id} ${ctxReq.title}` : '…') }]))}
      ${raw(archived || v === 'gantt' ? '' : html`<form class="qa" id="qa"><input class="input input--sm" id="qa-t" maxlength="200" placeholder="업무명을 입력하고 Enter — 작업을 연속으로 빠르게 추가" autocomplete="off">
        <select class="select select--sm" id="qa-p" aria-label="상위 항목" style="max-width:260px">${raw(parentOpts(qaParent))}</select>
        <select class="select select--sm" id="qa-type" aria-label="항목 유형"><option value="TASK">작업</option><option value="SUMMARY">상위 항목</option><option value="MILESTONE">마일스톤</option></select></form>`)}
      <div id="bulkslot"></div>
      <div class="rlayout ${sel || creating ? 'has-drawer' : ''}">
        ${raw(body)}
        <aside class="drawer ${creating ? 'drawer--form' : 'drawer--lg'}" id="drawer" ${sel || creating ? '' : 'hidden'}></aside>
      </div>
    </div>`;
    bind();
    if (v === 'list' && items.length) { mountBulkBar(); bulk.update(grid.selected.size); }
    if (creating) drawCreate(); else if (sel) drawDetail();
  };

  const bind = () => {
    main.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { setParam('view', b.dataset.view === 'gantt' ? 'gantt' : ''); if (b.dataset.view === 'gantt') gx.mode = 'fit'; draw(); });
    const gf = $('#gfit'); if (gf) gf.onclick = () => { gx.mode = 'fit'; placeGantt(); };
    const gt = $('#gtoday'); if (gt) gt.onclick = () => { gx.mode = 'today'; placeGantt(); };
    const qk = $('#quick'); if (qk) qk.onchange = () => { setParam('f', qk.value); syncRows(); draw(); };
    main.querySelectorAll('[data-kf]').forEach((b) => b.onclick = () => { setParam('f', b.dataset.kf); setParam('requirement', ''); ctxReq = null; syncRows(); draw(); });
    bindFilterClears(main, { setParam, keys: ['f', 'requirement'], reload: async () => { if (!params().get('requirement')) ctxReq = null; syncRows(); draw(); } });
    const cx = $('#ctx-off'); if (cx) cx.onclick = () => { ctxCr = null; setParam('cr', ''); syncRows(); draw(); };
    $('#expall').onclick = () => { collapsed.clear(); syncRows(); draw(); };
    $('#colall').onclick = () => { items.filter((i) => i.children_count).forEach((i) => collapsed.add(i.id)); syncRows(); draw(); };
    // tree toggles + inline "add child" (delegated: works for both the grid and the Gantt's left pane)
    main.querySelector('.rlayout').addEventListener('click', (e) => {
      const tog = e.target.closest('[data-tog]');
      if (tog) { e.stopPropagation(); const k = tog.dataset.tog; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); syncRows(); keepUi(() => { if (view() === 'gantt') draw(); else grid.refresh(); }); return; }
      const ad = e.target.closest('[data-addchild]');
      if (ad) { e.stopPropagation(); qaParent = ad.dataset.addchild; collapsed.delete(qaParent); syncRows(); grid.refresh(); const sp = $('#qa-p'); if (sp) { sp.innerHTML = parentOpts(qaParent); } const t = $('#qa-t'); if (t) t.focus(); }
    });
    for (const ida of ['add', 'add2']) { const b = $(`#${ida}`); if (b) b.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); setParam('parent', ''); setParam('type', ''); showDrawer(); drawCreate(); }; }
    main.querySelectorAll('.gantt [data-row]').forEach((row) => row.onclick = () => openDetail(row.dataset.row));
    // Excel menu
    const xb = $('#xl-btn'); const xp = $('#xl-pop');
    xb.onclick = (e) => { e.stopPropagation(); const open = xp.hidden; document.querySelectorAll('.gpop').forEach((x) => { x.hidden = true; }); xp.hidden = !open; };
    xp.onclick = async (e) => {
      const b = e.target.closest('[data-xl]'); if (!b) return; xp.hidden = true;
      try {
        if (b.dataset.xl === 'import') openImport({ kind: 'wbs', base: wApi(), onDone: async () => { await load(); draw(); } });
        else if (b.dataset.xl === 'template') await download(`${wApi()}/template.xlsx`, { filename: 'WBS 등록 템플릿.xlsx' });
        else await download(`${wApi()}/export.xlsx`);
      } catch (err) { toast(err.message); }
    };
    // Quick add
    const qa = $('#qa');
    if (qa) {
      $('#qa-p').onchange = (e) => { qaParent = e.target.value; };
      qa.onsubmit = async (e) => {
        e.preventDefault(); const inp = $('#qa-t'); const title = inp.value.trim(); if (!title) return;
        const item_type = $('#qa-type').value; const body = { title, item_type, parent_id: $('#qa-p').value || '' };
        inp.disabled = true;
        try { const r = await api('POST', wApi(), body); inp.value = ''; apply(r); toast(`${r.item.wbs_code} ${r.item.title} 추가됨`); grid.refresh(); const sp = $('#qa-p'); if (sp) sp.innerHTML = parentOpts(qaParent); }
        catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message); }
        inp.disabled = false; inp.focus();
      };
    }
    grid.bind(main);
    bindEscape(() => { if (sel || creating) closeDrawer(); });
    if (view() === 'gantt' && items.length) placeGantt();
  };

  /* ---------- detail / create modal ---------- */
  const showDrawer = () => { const d = $('#drawer'); d.hidden = false; d.className = `drawer ${creating ? 'drawer--form' : 'drawer--lg'}`; $('.rlayout').classList.add('has-drawer'); };
  const closeDrawer = () => { creating = false; sel = null; for (const k of ['sel', 'new', 'parent', 'type']) setParam(k, ''); const d = $('#drawer'); d.hidden = true; d.innerHTML = ''; $('.rlayout').classList.remove('has-drawer'); if (view() === 'gantt') draw(); else grid.refresh(); };
  const openDetail = async (iid) => {
    try { creating = false; setParam('new', ''); dtab = 'info'; actFilter = 'ALL'; await loadSel(iid); showDrawer(); drawDetail(); if (view() === 'gantt') draw(); else grid.refresh(); }
    catch (e) { toast(e.message); }
  };

  const dateFields = (type, it = {}, readOnly = false) => (type === 'MILESTONE'
    ? html`<div class="field"><label>마일스톤 날짜</label><input class="input input--sm" type="date" name="milestone_date" data-field="milestone_date" value="${it.milestone_date || ''}" ${readOnly ? 'disabled' : ''}></div>`
    : html`<div class="cols2"><div class="field"><label>계획 시작일</label><input class="input input--sm" type="date" name="planned_start_date" data-field="planned_start_date" value="${it.planned_start_date || ''}" ${readOnly ? 'disabled' : ''}><div class="err" data-for="planned_start_date"></div></div>
      <div class="field"><label>계획 종료일</label><input class="input input--sm" type="date" name="planned_end_date" data-field="planned_end_date" value="${it.planned_end_date || ''}" ${readOnly ? 'disabled' : ''}><div class="err" data-for="planned_end_date"></div></div></div>`);

  const drawCreate = () => {
    const type = params().get('type') && WBS_TYPE[params().get('type')] ? params().get('type') : 'TASK';
    const parent = params().get('parent') || '';
    $('#drawer').innerHTML = html`<form id="cf" novalidate style="display:flex;flex-direction:column;min-height:0;flex:1">
      <div class="drawer__h"><b>새 WBS</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기" style="margin-left:auto">×</button></div>
      <div class="drawer__b">
        <div class="form-err" role="alert" hidden></div>
        <div class="fsec"><h4>기본 정보</h4>
          <div class="field"><span class="lbl">항목 유형</span><div class="choices choices--3">${raw(Object.entries(WBS_TYPE).map(([v, l]) => html`<label class="choice"><input type="radio" name="item_type" value="${v}" ${type === v ? 'checked' : ''}><span>${l}</span></label>`).join(''))}</div></div>
          <div class="cols2">
            <div class="field"><label for="c-title">업무명 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: 요구사항 분석"><div class="err" data-for="title"></div></div>
            <div class="field"><label>상위 항목</label><select class="select" name="parent_id">${raw(parentOpts(parent))}</select><div class="err" data-for="parent_id"></div></div>
          </div>
          <div class="field" style="margin-bottom:0"><label>설명</label><textarea class="textarea" name="description" maxlength="5000" style="min-height:72px"></textarea></div>
        </div>
        <div class="fsec"><h4>일정 · 담당</h4>
          <div id="c-type-fields">${raw(dateFields(type))}</div>
          <div class="cols2" id="c-work" ${type === 'SUMMARY' ? 'hidden' : ''}>
            <div class="field"><label>담당자</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select><div class="err" data-for="owner_user_id"></div></div>
            <div class="field"><label>상태</label><select class="select" name="status">${raw(opt(WBS_STATUS, 'NOT_STARTED'))}</select></div>
          </div>
          <div class="field" id="c-prog" style="margin-bottom:0;max-width:240px" ${type !== 'TASK' ? 'hidden' : ''}><label>진행률 (%)</label><input class="input" type="number" name="progress" min="0" max="100" step="1" value="0"><div class="err" data-for="progress"></div></div>
        </div>
      </div>
      <div class="drawer__f"><span class="hint">Ctrl+Enter로 저장</span><span style="display:flex;gap:8px;margin-left:auto"><button class="btn btn--secondary" type="button" id="dcancel">취소</button><button class="btn btn--secondary" type="submit" data-more="1">저장 후 계속 추가</button><button class="btn btn--primary" type="submit">저장</button></span></div></form>`;
    $('#dclose').onclick = closeDrawer; $('#dcancel').onclick = closeDrawer;
    bindCreate();
    $('#c-title').focus();
  };

  const bindCreate = () => {
    const form = $('#cf'); let more = false;
    form.querySelectorAll('[name=item_type]').forEach((r) => r.onchange = () => {
      const t = r.value; $('#c-type-fields').innerHTML = dateFields(t); $('#c-work').hidden = t === 'SUMMARY'; $('#c-prog').hidden = t !== 'TASK';
    });
    form.querySelectorAll('[type=submit]').forEach((b) => { b.onclick = () => { more = Boolean(b.dataset.more); }; });
    form.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); more = false; form.requestSubmit(); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '업무명을 입력해 주세요.' });
      const body = { ...d }; if (d.item_type !== 'TASK') delete body.progress; if (d.item_type === 'SUMMARY') delete body.owner_user_id;
      const btns = form.querySelectorAll('[type=submit]'); btns.forEach((b) => { b.disabled = true; });
      try {
        const r = await api('POST', wApi(), body);
        apply(r); toast(`${r.item.wbs_code} ${r.item.title} 항목을 추가했습니다.`);
        if (more) {
          btns.forEach((b) => { b.disabled = false; });
          const keepParent = form.parent_id.value; const keepType = d.item_type;
          form.reset(); form.parent_id.innerHTML = parentOpts(keepParent); form.querySelector(`[name=item_type][value=${keepType}]`).checked = true; $('#c-title').focus(); grid.refresh(); return;
        }
        creating = false; for (const k of ['new', 'parent', 'type']) setParam(k, ''); dtab = 'info'; actFilter = 'ALL'; sel = r.item; setParam('sel', r.item.id); showDrawer(); drawDetail(); grid.refresh();
      } catch (err) { btns.forEach((b) => { b.disabled = false; }); showErrors(form, err.fields, err.message); }
    };
  };

  const wbsLabel = { title: '업무명', description: '설명', item_type: '항목 유형', status: '상태', owner_user_id: '담당자', progress: '진행률', planned_start_date: '계획 시작일', planned_end_date: '계획 종료일', actual_start_date: '실제 시작일', actual_end_date: '실제 종료일', milestone_date: '마일스톤 날짜' };
  const histText = (h, it) => {
    const val = (f, v) => { if (v == null || v === '') return '-'; if (f === 'status') return WBS_STATUS[v] || v; if (f === 'item_type') return WBS_TYPE[v] || v; if (f === 'owner_user_id') return (members.find((m) => m.id === v) || {}).name || '미지정'; if (f === 'progress') return `${v}%`; return v; };
    switch (h.action_type) {
      case 'CREATED': return html`<b>${it.wbs_code}</b> 생성`;
      case 'ARCHIVED': return html`보관 처리`;
      case 'MOVED': return html`위치 이동 <q>${h.old_value || '-'}</q> → <q>${h.new_value || '-'}</q>`;
      case 'DEP_ADDED': return html`선행 작업 추가 <q>${h.new_value}</q>`;
      case 'DEP_REMOVED': return html`선행 작업 삭제 <q>${h.old_value}</q>`;
      case 'LINKED_REQ': return html`요구사항 연결 <q>${h.new_value}</q>`;
      case 'UNLINKED_REQ': return html`요구사항 연결 해제 <q>${h.old_value}</q>`;
      case 'LINK_TYPE_CHANGED': return html`연결 유형 변경 <q>${h.old_value}</q> → <q>${h.new_value}</q>`;
      default: { const f = h.field_name; const long = f === 'title' || f === 'description';
        return html`<b>${wbsLabel[f] || f}</b> ${long ? (f === 'description' ? '변경' : html`<q>${h.old_value}</q> → <q>${h.new_value}</q>`) : html`${val(f, h.old_value)} → ${val(f, h.new_value)}`}`; }
    }
  };

  const drawDetail = () => keepUi(() => {
    const it = sel; if (!it) return;
    const d = $('#drawer'); const readOnly = roRow(it); const t = it.item_type;
    const live = byId().get(it.id) || it; const sibs = items.filter((x) => x.parent_id === it.parent_id);
    const idx = sibs.findIndex((x) => x.id === it.id);
    const predCandidates = items.filter((x) => x.id !== it.id && !it.predecessors.some((pp) => pp.predecessor_id === x.id));
    const ids = view() === 'gantt' ? visible().map((x) => x.id) : grid.orderedIds(); const at = ids.indexOf(it.id);
    const events = mergeActivity({ history: it.history || [], comments: it.comments || [], fmt: (h) => histText(h, it), meId });
    const liveReq = it.requirement_links.filter((l) => !l.archived_at);
    d.innerHTML = html`<div class="drawer__h"><b class="mono">${it.wbs_code}</b><span class="chip ${WBS_STATUS_CHIP[it.status] || ''}">${WBS_STATUS[it.status]}</span><span class="lbl-sub">${WBS_TYPE[t]}</span>${raw(it.archived_at ? '<span class="chip">보관됨</span>' : '')}
        <span class="dnav"><button type="button" data-nav="-1" aria-label="이전 항목" title="이전 (목록 순서)" ${at <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-nav="1" aria-label="다음 항목" title="다음 (목록 순서)" ${at < 0 || at >= ids.length - 1 ? 'disabled' : ''}>↓</button></span>
        <button class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
      ${raw(dtabs([{ key: 'info', label: '업무정보' }, { key: 'rel', label: '연결·관계', count: liveReq.length + it.predecessors.length }, { key: 'activity', label: '댓글·활동', count: events.length }], dtab))}
      <div class="drawer__b">
        <section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
          <div class="dlayout"><div>
            <input class="dtitle" data-field="title" value="${it.title}" maxlength="200" ${readOnly ? 'disabled' : ''} aria-label="업무명">
            <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${readOnly ? 'disabled' : ''}>${it.description}</textarea>
            ${raw(traceStrip([
              { label: 'Requirements', value: liveReq.length, tone: liveReq.length ? '' : t === 'TASK' ? 'warn' : 'muted' },
              { label: 'Changes', value: it.changes ? it.changes.length : 0, href: `/app/projects/${p.id}/changes?wbs=${it.id}`, tone: it.changes && it.changes.length ? 'warn' : 'muted' },
              { label: 'Issues', value: it.raid ? it.raid.issues.length : 0, sub: it.raid && it.raid.risks.length ? `Risk ${it.raid.risks.length}` : '', href: `/app/projects/${p.id}/issues?wbs=${it.id}`, tone: it.raid && it.raid.issues.length ? 'warn' : 'muted' },
              { label: 'Tests', value: it.testing ? it.testing.tests.length : 0, sub: it.testing && it.testing.tests.length ? `${it.testing.summary.pass} Pass · ${it.testing.summary.fail} Fail` : '', href: `/app/projects/${p.id}/tests?wbs=${it.id}`, tone: it.testing && it.testing.summary.fail ? 'crit' : it.testing && it.testing.tests.length ? '' : 'muted' },
            ], { compact: true }))}
          </div>
          <div class="dside">
            <div class="dfield"><span>항목 유형</span><div><select class="select select--sm" data-field="item_type" ${readOnly ? 'disabled' : ''}>${raw(opt(WBS_TYPE, t))}</select></div></div>
            <div class="dfield"><span>상태</span><div><select class="select select--sm" data-field="status" ${readOnly ? 'disabled' : ''}>${raw(opt(WBS_STATUS, it.status))}</select></div></div>
            ${raw(t === 'SUMMARY' ? '' : html`<div class="dfield"><span>담당자</span><div><select class="select select--sm" data-field="owner_user_id" ${readOnly ? 'disabled' : ''}>${raw(ownerOpts(it.owner_user_id || ''))}</select></div></div>`)}
            ${raw(t === 'TASK' ? html`<div class="dfield"><span>진행률 (%)</span><div><input class="input input--sm" type="number" min="0" max="100" step="1" data-field="progress" value="${it.progress}" ${readOnly ? 'disabled' : ''}></div></div>`
              : t === 'SUMMARY' ? html`<div class="dfield"><span>진행률 (하위 작업 기준)</span><div class="pcell"><div class="pbar"><i style="width:${live.computed_progress || 0}%"></i></div><span>${live.computed_progress || 0}%</span></div></div>` : '')}
            ${raw(dateFields(t, it, readOnly))}
            ${raw(t === 'MILESTONE' ? '' : html`<div class="cols2"><div class="field"><label>실제 시작일</label><input class="input input--sm" type="date" data-field="actual_start_date" value="${it.actual_start_date || ''}" ${readOnly ? 'disabled' : ''}></div>
              <div class="field"><label>실제 종료일</label><input class="input input--sm" type="date" data-field="actual_end_date" value="${it.actual_end_date || ''}" ${readOnly ? 'disabled' : ''}></div></div>`)}
            <div class="dfield"><span>상위 항목</span><div><select class="select select--sm" id="mv-parent" ${readOnly ? 'disabled' : ''}>${raw(parentOpts(it.parent_id || '', it.id))}</select></div></div>
            ${raw(readOnly ? '' : html`<div class="actions"><button class="btn btn--secondary btn--xs" id="mv-up" ${idx <= 0 ? 'disabled' : ''}>↑ 위로</button><button class="btn btn--secondary btn--xs" id="mv-down" ${idx < 0 || idx >= sibs.length - 1 ? 'disabled' : ''}>↓ 아래로</button>${raw(t === 'MILESTONE' ? '' : '<button class="btn btn--secondary btn--xs" id="addchild">+ 하위</button>')}</div>`)}
            <div class="dsave" id="dsave"></div>
          </div></div>
        </section>
        <section data-pane="rel" ${dtab === 'rel' ? '' : 'hidden'}>
          <h4 class="dh">관련 요구사항 <em>${liveReq.length}</em></h4>
          ${raw(liveReq.length ? html`<ol class="crit links">${raw(liveReq.map((l) => html`<li>
            <span class="mono">${l.display_id}</span><span class="crit__in" style="padding:6px 4px">${l.title}<small class="dim" style="margin-left:6px">${REQ_STATUS[l.status]} · ${REQ_SCOPE[l.scope]}</small></span>
            ${raw(readOnly ? html`<span class="chip chip--muted">${LINK_TYPE[l.link_type]}</span>` : html`<select class="select select--xs" data-rlink-type="${l.id}">${raw(Object.entries(LINK_TYPE).map(([v, lb]) => html`<option value="${v}" ${l.link_type === v ? 'selected' : ''}>${lb}</option>`).join(''))}</select>
            <span class="crit__act" style="opacity:1"><button data-rlink-del="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>`
            : t === 'TASK' ? html`<div class="empty-inline"><b>아직 연결된 요구사항이 없습니다.</b><span>이 작업이 어떤 요구사항을 수행하기 위한 것인지 연결하면 프로젝트 추적성을 높일 수 있습니다.</span></div>` : html`<p class="hint">연결된 요구사항이 없습니다.</p>`)}
          ${raw(it.requirement_links.length - liveReq.length ? html`<p class="hint">보관된 요구사항 ${it.requirement_links.length - liveReq.length}건 연결은 기록으로만 남아 있습니다.</p>` : '')}
          ${raw(readOnly ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="rlink-add">+ 요구사항 연결</button></div>`)}
          <h4 class="dh">선행 작업 <em>${it.predecessors.length}</em></h4>
          <ol class="crit">${raw(it.predecessors.map((pp) => html`<li><span class="mono wcode">${pp.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${pp.title}</span><small class="dim">Finish to Start</small>
            ${raw(readOnly ? '' : html`<span class="crit__act" style="opacity:1"><button data-dep-del="${pp.id}" title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
          ${raw(readOnly ? (it.predecessors.length ? '' : '<p class="hint">선행 작업이 없습니다.</p>') : html`<div class="crit-add"><select class="select select--sm" id="dep-sel" style="flex:1"><option value="">선행 작업 선택…</option>${raw(predCandidates.map((x) => html`<option value="${x.id}">${x.wbs_code} ${x.title}</option>`).join(''))}</select><button class="btn btn--secondary btn--sm" id="dep-add">추가</button></div><div class="err" id="dep-err"></div>`)}
          ${raw(it.successors.length ? html`<p class="hint" style="margin-top:8px">후행 작업: ${it.successors.map((x) => `${x.wbs_code} ${x.title}`).join(', ')}</p>` : '')}
          ${raw(it.testing && it.testing.tests.length ? html`<h4 class="dh">관련 테스트 <em>${it.testing.tests.length}</em><span style="margin-left:auto">${raw(verifyChip(it.testing.summary.verification))}</span></h4>
            <ol class="crit links">${raw(it.testing.tests.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(resBadge(x.last_result))}</a></li>`).join(''))}</ol>` : '')}
          ${raw(it.raid && (it.raid.issues.length || it.raid.risks.length) ? html`<h4 class="dh">관련 Issues & Risks <em>${it.raid.issues.length + it.raid.risks.length}</em></h4>
            <ol class="crit links">${raw(it.raid.issues.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/issues?sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(sevBadge(x.severity))}<span class="chip ${ISSUE_STATUS_CHIP[x.status] || ''}">${ISSUE_STATUS[x.status]}</span></a></li>`).join(''))}
            ${raw(it.raid.risks.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/issues?tab=risks&sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(sevBadge(x.risk_level))}<span class="chip ${RISK_STATUS_CHIP[x.status] || ''}">${RISK_STATUS[x.status]}</span></a></li>`).join(''))}</ol>` : '')}
        </section>
        <section data-pane="activity" ${dtab === 'activity' ? '' : 'hidden'}>${raw(activityPane({ events, filter: actFilter, ro: archived }))}</section>
      </div>
      ${raw(drawerFoot({ ro: readOnly, meta: `등록 ${fmtShort(it.created_at)}`, label: 'WBS 보관', id: 'warchive' }))}`;
    bindDetail();
  });

  const bindDetail = () => {
    const it = sel; const d = $('#drawer'); const status = $('#dsave');
    $('#dclose').onclick = closeDrawer;
    bindDtabs(d, (k) => { dtab = k; });
    d.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { const ids = view() === 'gantt' ? visible().map((x) => x.id) : grid.orderedIds(); const n = ids[ids.indexOf(it.id) + Number(b.dataset.nav)]; if (n) openDetail(n); });
    const after = async (r) => { apply(r); sel = (await api('GET', wApi(`/${it.id}`))).item; grid.refresh(); drawDetail(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { await after(await api('PATCH', wApi(`/${it.id}`), { [field]: value })); const s = $('#dsave'); if (s) s.textContent = '저장됨'; if (view() === 'gantt') { /* bars changed */ } }
      catch (e) { status.textContent = e.fields ? Object.values(e.fields)[0] : e.message; toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    d.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT' || el.type === 'date') el.onchange = () => save(field, el.value);
      else {
        el.onblur = () => { const v = el.type === 'number' ? Number(el.value) : el.value.trim(); if (String(v) !== String(it[field] ?? '')) save(field, v); };
        el.onkeydown = (e) => { if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') el.blur(); };
      }
    });
    const move = async (body) => { try { await after(await api('POST', wApi(`/${it.id}/move`), body)); toast('위치를 변경했습니다.'); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); drawDetail(); } };
    const mp = $('#mv-parent'); if (mp) mp.onchange = () => move({ parent_id: mp.value || null });
    const up = $('#mv-up'); if (up) up.onclick = () => move({ sequence: it.sequence - 1 });
    const dn = $('#mv-down'); if (dn) dn.onclick = () => move({ sequence: it.sequence + 1 });
    const ac = $('#addchild'); if (ac) ac.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); setParam('parent', it.id); setParam('type', 'TASK'); collapsed.delete(it.id); showDrawer(); drawCreate(); };
    const da = $('#dep-add'); if (da) da.onclick = async () => {
      const v = $('#dep-sel').value; if (!v) return;
      try { dtab = 'rel'; await after(await api('POST', wApi(`/${it.id}/dependencies`), { predecessor_id: v })); }
      catch (e) { $('#dep-err').textContent = e.fields ? Object.values(e.fields)[0] : e.message; }
    };
    d.querySelectorAll('[data-dep-del]').forEach((b) => b.onclick = async () => { try { await after(await api('DELETE', wApi(`/${it.id}/dependencies/${b.dataset.depDel}`))); } catch (e) { toast(e.message); } });
    const ra = $('#rlink-add');
    if (ra) ra.onclick = async () => {
      const { requirements } = await api('GET', wsApi(`/${id}/requirements`));
      const linked = new Set(it.requirement_links.filter((l) => !l.archived_at).map((l) => l.requirement_id));
      const pick = await pickerDialog({ title: `${it.wbs_code} ${it.title}에 요구사항 연결`, placeholder: '요구사항 번호 또는 제목 검색', withType: true,
        rows: requirements.map((r) => ({ ...r, disabled: linked.has(r.id) })), searchKeys: ['display_id', 'title'],
        render: (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span>${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}` });
      if (!pick) return;
      try { dtab = 'rel'; await after(await api('POST', wApi(`/${it.id}/links`), { requirement_id: pick.id, link_type: pick.link_type })); toast('요구사항을 연결했습니다.'); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    d.querySelectorAll('[data-rlink-type]').forEach((sl) => sl.onchange = async () => { try { await after(await api('PATCH', wApi(`/${it.id}/links/${sl.dataset.rlinkType}`), { link_type: sl.value })); } catch (e) { toast(e.message); } });
    d.querySelectorAll('[data-rlink-del]').forEach((b) => b.onclick = async () => {
      const l = it.requirement_links.find((x) => x.id === b.dataset.rlinkDel);
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: `${it.wbs_code} ${it.title}과 ${l.display_id}의 연결만 제거됩니다.`, confirm: '연결 해제', danger: true }))) return;
      try { await after(await api('DELETE', wApi(`/${it.id}/links/${l.id}`))); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const reloadComments = (c) => { sel.comments = c; dtab = 'activity'; drawDetail(); };
    bindActivity(d, {
      onFilter: (f) => { actFilter = f; dtab = 'activity'; drawDetail(); },
      onSubmit: async (body) => { reloadComments((await api('POST', wApi(`/${it.id}/comments`), { body })).comments); },
      onDelete: async (cid) => { if (!(await confirmDialog({ title: '댓글을 삭제할까요?', body: '삭제한 댓글은 복구할 수 없습니다.', confirm: '삭제', danger: true }))) return; try { reloadComments((await api('DELETE', wApi(`/${it.id}/comments/${cid}`))).comments); } catch (e) { toast(e.message); } },
    });
    const ab = $('#warchive');
    if (ab) ab.onclick = async () => {
      const kids = items.filter((x) => { let c = x; while (c && c.parent_id) { if (c.parent_id === it.id) return true; c = byId().get(c.parent_id); } return false; }).length;
      const ok = await confirmDialog({ title: `${it.wbs_code} ${it.title} 항목을 보관할까요?`,
        body: raw(html`${raw(kids ? html`<p style="margin-bottom:10px"><b>이 항목에는 ${kids}개의 하위 WBS가 있습니다.</b> 하위 항목도 함께 보관됩니다.</p>` : '')}보관된 항목은 목록과 Gantt에서 숨겨지고 WBS 번호가 다시 매겨집니다. 선행 관계는 기록으로 남습니다.`), confirm: kids ? '하위 항목 포함 보관' : '보관하기', danger: true });
      if (!ok) return;
      try { const r = await api('POST', wApi(`/${it.id}/archive`), {}); apply(r); toast('항목을 보관했습니다.'); closeDrawer(); } catch (e) { toast(e.message); }
    };
  };

  await load();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
}
