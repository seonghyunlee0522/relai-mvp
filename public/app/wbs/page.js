/* WBS — Tree Grid workspace (Phase 12).
 * One hierarchy, no "type first" decision: `+ 항목 추가` makes a TASK, `◆ 마일스톤 추가` a MILESTONE; a TASK with children is a group
 * (date/progress roll-ups, expand/collapse). Codes (1, 1.1, 1.1.1) are always computed by the server after any structural change.
 * Inline: quick-add rows (Enter/Esc), cell edits, row menu (하위/같은 레벨/마일스톤/들여쓰기/내어쓰기/복제/삭제), drag & drop, undo toasts.
 * Detail: large modal with tabs 기본 정보 / 관련 요구사항 / 선행 작업 / 변경 이력 / 댓글. */
import { api, getMembers, wsApi } from '../core/api.js';
import { isPhone as onPhone, pcLine } from '../core/device.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { download, keepUi } from '../core/ui.js';
import { projectHead } from '../project/guide.js';
import { LIFECYCLE_LABEL } from '../shared/constants.js';
import { resBadge, sevBadge, verifyChip } from '../shared/badges.js';
import { ISSUE_STATUS, ISSUE_STATUS_CHIP, LINK_TYPE, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, RISK_STATUS, RISK_STATUS_CHIP, WBS_CSTATUS, WBS_CSTATUS_CHIP, WBS_STATUS, WBS_TYPE } from '../shared/constants.js';
import { traceStrip } from '../shared/trace-strip.js';
import { drawerFoot, bindEscape , bindArrowNav } from '../shared/drawer.js';
import { appliedFilters, bindFilterClears, bindMoreFilters, moreFilters, isPhone } from '../shared/filters.js';
import { emptyState } from '../shared/empty-state.js';
import { bindCoach, coachMark } from '../onboarding/ui.js';
import { toolMenu, tmItem, aiPrice } from '../shared/toolmenu.js';
import { createGrid } from '../shared/grid.js';
import { bulkRun, mountBulk } from '../shared/bulk.js';
import { activityPane, bindActivity, bindDtabs, dtabs, mergeActivity } from '../shared/detail.js';
import { openImport } from '../shared/importer.js';
import { choiceDialog, confirmDialog, pickerDialog, toast, toastAction, withDelayReason } from '../shared/dialogs.js';
import { planShiftText, workdaysBetween } from '../shared/kst-date.js';
import { holidays } from '../shared/holidays.js';
import { nodeByKey } from '../shared/wbs-structure.js';
import * as OP from '../shared/owner-picker.js';
import { aiStatus } from '../shared/ai.js';
import { openWbsPlanner } from '../ai/wbs-planner.js';
import { bindJiraPane, execChip, jiraPaneHtml } from '../shared/jira.js';

const GHOST = '__new';
const STATUS_EDIT = { NOT_STARTED: '예정', IN_PROGRESS: '진행중', COMPLETED: '완료', ON_HOLD: '보류' };

export async function wbsPage(id) {
  const main = $('#main');
  const [g, members, ai] = await Promise.all([api('GET', wsApi(`/${id}`)), getMembers(), aiStatus(id)]);
  const p = g.project;
  const isArch = p.status === 'ARCHIVED'; const archived = isArch || isPhone();   // phone = view mode: the archived read-only path
  // Lifecycle V2: one WBS, two entry points — 03 분석·설계 > WBS 작성 (plan) and Overview > WBS (monitor). Same screen, same data; only the context label differs.
  const ctx = () => (params().get('ctx') === 'monitor' ? 'monitor' : 'plan');
  document.title = `WBS — ${p.name} — RELAI`;
  const wApi = (s = '') => wsApi(`/${id}/wbs${s}`);
  const meId = state.user.id;
  const desk = !isPhone();   // Redesign R2: quiet toolbar, 6 default columns, 480px side drawer — desktop only
  const ownerMode = new URLSearchParams(location.search).get('select') === 'owner';   // Jim M3: 지금 할 일 › 담당자 지정 → checkboxes + the owner bar
  let selMode = ownerMode || new URLSearchParams(location.search).get('select') === '1';
  let moreOpen = false;
  const params0 = () => new URLSearchParams(location.search);
  const params = params0;
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };

  let items = []; let summary = g.wbs; let sel = null;
  let owners = { team: [], stakeholders_total: 0 }; let kdPending = 0;   // Phase 3: 팀원 (계정 없음) · 01 주요 일정 not yet imported
  let outside = 0; let dmTrait = p.data_migration || null; let hol = null;   // batch7 B3/B4: top-level items outside the fixed nodes · 데이터 이관 trait · 공휴일 Map
  let jira = null;          // { enabled, by: { wbsId: summary } } when the project is mapped to Jira (Phase 12), else null
  let jiraDetail = null;    // Jira pane data of the open detail (fetched when the tab is first opened)
  let dtab = 'info';
  let ghost = null;   // { parent_id, item_type, after } — the inline "new item" row
  // Context from other screens: ?requirement=<id> narrows to that requirement's WBS; ?cr=<id> shows the Change Request banner.
  let ctxReq = null; let ctxCr = null;
  if (params().get('requirement')) { try { ctxReq = (await api('GET', wsApi(`/${id}/requirements/${params().get('requirement')}`))).requirement; } catch { setParam('requirement', ''); } }
  if (params().get('cr')) { try { ctxCr = (await api('GET', wsApi(`/${id}/changes/${params().get('cr')}`))).change; } catch { setParam('cr', ''); } }
  const collapsed = new Set(); const gx = { px: 16, mode: 'fit', left: 0, start: null }; // Gantt viewport: mode = fit | today | keep
  const view = () => (!onPhone() && params().get('view') === 'gantt' ? 'gantt' : 'list');   // phone: no Gantt (spec §4 — list + one line)
  const quick = () => params().get('f') || '';
  const QUICK_LABEL = { no_owner: '담당자 미지정 작업', no_dates: '일정 미설정 작업', linked: '요구사항 연결됨', unlinked: '요구사항 미연결 작업', overdue: '지연 작업', over_end: '종료일 초과 작업', open: '미완료 작업·마일스톤' };
  /* Phase 3 US-1: one owner value for both kinds — 'u:<user>' (RELAI 사용자) · 's:<stakeholder>' (팀원, 계정 없음) · '' (미지정) */
  const ownerKey = OP.ownerKey;
  const hasOwner = (it) => Boolean(it.owner_user_id || (it.owner_stakeholder_id && !it.owner_deleted));
  const pe = p.planned_end_date ? String(p.planned_end_date).slice(0, 10) : '';
  const mmdd = (d) => d.slice(5).replace('-', '/');
  const PAST_END = () => `프로젝트 종료일(${mmdd(pe)}) 이후입니다. 계약 기간 안에 끝나도록 일정을 다시 확인하세요.`;
  const isLeafTask = (it) => it.item_type !== 'MILESTONE' && !it.is_group;
  const isOverdue = (it) => it.computed_status === 'DELAYED';
  const byId = () => new Map(items.map((i) => [i.id, i]));
  const apply = (r) => { items = r.items || items; summary = r.summary || summary; if (r.jira !== undefined) jira = r.jira; if (r.owners) owners = r.owners; if (r.key_dates_pending !== undefined) kdPending = r.key_dates_pending; if (r.outside_count !== undefined) outside = r.outside_count; if (r.data_migration !== undefined) dmTrait = r.data_migration; if (r.item && sel && r.item.id === sel.id) sel = r.item; syncRows(); paintKpi(); };
  const load = async () => { const d = await api('GET', wApi(params().get('archived') ? '?include_archived=1' : '')); items = d.items; summary = d.summary; jira = d.jira || null; owners = d.owners || owners; kdPending = d.key_dates_pending || 0; outside = d.outside_count || 0; if (d.data_migration !== undefined) dmTrait = d.data_migration; syncRows(); };
  /* batch7 B3: fixed phase nodes (system rows) are structure — 'empty WBS' means no user item */
  const isSys = (it) => Boolean(it && it.is_system);
  const userItems = () => items.filter((x) => !isSys(x));
  const hasUser = () => items.some((x) => !isSys(x));
  const hasNodes = () => items.some(isSys);
  const dmNode = () => items.find((x) => x.system_key === 'OPT:DATA_MIGRATION' && !x.archived_at);
  /** '+ 작업 추가' with nothing chosen: under the selected item (a node or a group), else the node of the project's current phase. */
  const defaultParent = () => {
    if (sel && !sel.archived_at && sel.item_type !== 'MILESTONE') return sel.id;
    const ph = p.current_phase === 'OPERATIONS' ? 'TRANSITION_GO_LIVE' : p.current_phase;
    const key = { INITIATION: 'PHASE:INITIATION', REQUIREMENTS: 'PHASE:REQUIREMENTS', ANALYSIS_DESIGN: 'PHASE:ANALYSIS_DESIGN', DEVELOPMENT: 'PHASE:DEVELOPMENT', TESTING: 'PHASE:TESTING', TRANSITION_GO_LIVE: 'PHASE:TRANSITION_GO_LIVE' }[ph];
    return items.find((x) => x.system_key === key)?.id || null;
  };
  const wdays = (r) => { const s0 = r.item_type === 'MILESTONE' ? r.milestone_date : r.planned_start; const e0 = r.item_type === 'MILESTONE' ? r.milestone_date : r.planned_end; return s0 && e0 && hol ? workdaysBetween(s0, e0, hol) : null; };
  const loadSel = async (iid) => { sel = iid ? (await api('GET', wApi(`/${iid}`))).item : null; jiraDetail = null; setParam('sel', iid); };

  /** Visible rows after search / filters / collapse (a match shows together with its ancestors), plus the inline ghost row. */
  let matched = 0;
  const visible = () => {
    const m = byId(); const f = quick(); const q = (params().get('q') || '').trim().toLowerCase();
    const owner = params().get('owner') || ''; const cst = params().get('cst') || '';
    // ?phase=DEVELOPMENT (04 구현 현황 etc.): narrow to tasks tagged with that lifecycle phase — only when any task is tagged, otherwise the whole WBS stays visible.
    const phaseQ = params().get('phase') || ''; const phase = phaseQ && items.some((it) => it.lifecycle_phase === phaseQ) ? phaseQ : '';
    let keep = null;
    const reqWbs = ctxReq ? new Set(ctxReq.links.map((l) => l.wbs_item_id)) : null;
    const crWbs = ctxCr ? new Set((ctxCr.impacts || []).map((l) => l.wbs_item_id)) : null;
    if (f || q || owner || cst || reqWbs || crWbs || phase) {
      keep = new Set();
      for (const it of items) {
        let hit = !f || (f === 'linked' ? it.linked_req_count > 0
          : f === 'overdue' ? isOverdue(it)
          : f === 'over_end' ? Boolean(it.past_end)
          : f === 'open' ? (isLeafTask(it) || it.item_type === 'MILESTONE') && it.status !== 'COMPLETED'
          : isLeafTask(it) && (f === 'no_owner' ? !hasOwner(it) : f === 'no_dates' ? (!it.planned_start_date || !it.planned_end_date) : f === 'unlinked' ? it.linked_req_count === 0 : true));
        if (q && !(it.title.toLowerCase().includes(q) || it.wbs_code.toLowerCase().startsWith(q))) hit = false;
        if (owner && (owner === 'none' ? hasOwner(it) : ownerKey(it) !== (owner.includes(':') ? owner : `u:${owner}`))) hit = false;
        if (cst && it.computed_status !== cst) hit = false;
        if (phase && it.lifecycle_phase !== phase) hit = false;
        if (reqWbs && !reqWbs.has(it.id)) hit = false;
        if (crWbs && crWbs.size && !crWbs.has(it.id)) hit = false;
        if (!hit) continue;
        let cur = it; while (cur) { keep.add(cur.id); cur = cur.parent_id ? m.get(cur.parent_id) : null; }
      }
    }
    matched = keep ? [...keep].filter((k) => !isSys(m.get(k))).length : userItems().length;   // batch7: fixed phase nodes are not counted   // K11: footer counts every matching item (folded children too), the same rule as the 전체 항목 chip
    const out = []; const hidden = new Set();
    for (const it of items) {
      if (it.parent_id && (hidden.has(it.parent_id) || collapsed.has(it.parent_id))) { hidden.add(it.id); continue; }
      if (keep && !keep.has(it.id)) { hidden.add(it.id); continue; }
      out.push(it);
    }
    if (ghost && !archived) {
      const pid = ghost.parent_id || null; const parent = pid ? m.get(pid) : null;
      const depth = parent ? parent.depth + 1 : 0;
      const row = { id: GHOST, _ghost: true, parent_id: pid, depth, item_type: ghost.item_type, title: '', children_count: 0, predecessors: [], linked_req_count: 0, wbs_code: '' };
      // insert after the last visible descendant of the parent (or at the very end for root)
      let at = out.length;
      if (parent) { let idx = out.findIndex((x) => x.id === pid); if (idx >= 0) { idx++; while (idx < out.length && out[idx].depth > parent.depth) idx++; at = idx; } }
      out.splice(at, 0, row);
    }
    return out;
  };
  const syncRows = () => grid.setRows(visible());

  /** Owner picker: the shared component (shared/owner-picker.js, also the Issue 담당자 — Phase 4 US-6). */
  const ownerChoices = (cur = '', short = false) => OP.ownerChoices(members, owners, cur, short);
  const ownerOpts = (cur) => OP.ownerOptions(members, owners, cur);
  const noAcct = OP.noAcct;
  const ownerCell = (it) => (it.owner_name ? html`<span class="cellwrap"><i class="av">${[...it.owner_name][0]}</i>${it.owner_name}${raw(noAcct(it))}</span>` : dim());
  const teamHint = () => OP.teamHint(owners, p.id, archived);
  const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const parentOpts = (cur, excludeId) => {
    const m = byId(); const blocked = new Set();
    if (excludeId) { blocked.add(excludeId); for (const it of items) { let c = it; while (c) { if (c.id === excludeId) { blocked.add(it.id); break; } c = c.parent_id ? m.get(c.parent_id) : null; } } }
    return html`<option value="">(최상위)</option>` + items.filter((i) => i.item_type !== 'MILESTONE' && !blocked.has(i.id))
      .map((i) => html`<option value="${i.id}" ${cur === i.id ? 'selected' : ''}>${'  '.repeat(i.depth)}${i.wbs_code} ${i.title}</option>`).join('');
  };
  const dim = (t = '-') => html`<span class="dim">${t}</span>`;
  const progCell = (r) => html`<div class="pcell ${r.rollup ? 'is-roll' : ''}" title="${r.rollup ? '하위 작업 기준 자동 계산' : ''}"><div class="pbar"><i style="width:${r.computed_progress}%"></i></div><span>${r.computed_progress}%</span></div>`;   // same bar + % on editable and roll-up rows (L-C1)
  /** Phase 4 US-1: "계획 5/14 → 5/21 (+7일)" under a leaf's end date when it moved from the 최초 계획일 (record, not a block — never red). */
  const endOf = (r) => (r.item_type === 'MILESTONE' ? r.milestone_date : r.planned_end_date);
  const shiftLine = (r) => { if (r._ghost || r.is_group || r.rollup) return ''; const t = planShiftText(r.original_planned_end_date, endOf(r)); return t ? html`<small class="wshift" data-shift>${t}</small>` : ''; };
  /** PATCH one end-date field through the delay-reason dialog (same rule as the server); resolves the response or null on 취소. */
  const patchItem = (it, body) => {
    const f = Object.keys(body).find((k) => k === 'planned_end_date' || k === 'milestone_date');
    return withDelayReason((extra) => api('PATCH', wApi(`/${it.id}`), { ...body, ...extra }), f ? { before: it[f] || null, after: body[f] || null, status: it.status } : null);
  };
  const dateCell = (d, derived = false, past = false) => (d ? (derived ? html`<span class="dim" title="하위 작업 기준 자동 계산">${fmtShort(d)}</span>` : past ? html`<span class="wpast" title="${PAST_END()}"><i aria-hidden="true">!</i>${fmtShort(d)}</span>` : html`${fmtShort(d)}`) : dim());
  const statusBadge = (it) => html`<span class="chip ${WBS_CSTATUS_CHIP[it.computed_status] || ''}">${WBS_CSTATUS[it.computed_status] || it.computed_status}</span>`;

  /* ---------- grid (tree) ---------- */
  const roRow = (it) => archived || Boolean(it.archived_at);
  const titleCell = (it, { withActions = true } = {}) => {
    if (it._ghost) return html`<div class="wtitle wghost" style="padding-left:${it.depth * 18}px"><span class="wtog wtog--none"></span>${raw(it.item_type === 'MILESTONE' ? '<i class="wms">◆</i>' : '')}
      <input class="input input--sm wghost__in" data-ghost maxlength="200" placeholder="${it.item_type === 'MILESTONE' ? '마일스톤 이름 입력 후 Enter' : '작업명 입력 후 Enter · Esc 취소'}" autocomplete="off"></div>`;
    if (isSys(it)) return html`<div class="wtitle wtitle--sys" style="padding-left:${it.depth * 18}px">
      ${raw(it.children_count ? html`<button class="wtog" data-tog="${it.id}" aria-label="${collapsed.has(it.id) ? '펼치기' : '접기'}">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : '<span class="wtog wtog--none"></span>')}
      <span class="wtitle__t">${it.title}</span><small class="wsys" title="단계 구조(고정) — 이름·위치는 바꿀 수 없고, 아래에 작업을 추가해 씁니다">단계</small>${raw(it.children_count ? html`<small class="wdep">${it.children_count}</small>` : '')}
      ${raw(withActions && !archived ? html`<span class="wact"><button class="wadd" data-addchild="${it.id}" title="${it.title} 아래에 작업 추가" aria-label="하위 작업 추가">+</button><button class="wadd wmenu" data-rowmenu="${it.id}" title="더보기" aria-label="행 메뉴">⋯</button></span>` : '')}</div>`;
    return html`<div class="wtitle" style="padding-left:${it.depth * 18}px">
      ${raw(withActions && !archived ? html`<span class="wdrag" draggable="true" data-drag="${it.id}" title="끌어서 이동" aria-hidden="true">⋮⋮</span>` : '')}
      ${raw(it.children_count ? html`<button class="wtog" data-tog="${it.id}" aria-label="${collapsed.has(it.id) ? '펼치기' : '접기'}">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : '<span class="wtog wtog--none"></span>')}
      ${raw(it.item_type === 'MILESTONE' ? '<i class="wms" title="마일스톤">◆</i>' : '')}<span class="wtitle__t">${it.title}</span>
      ${raw(it.predecessors.length ? html`<small class="wdep" title="선행 작업 ${it.predecessors.length}개">←${it.predecessors.length}</small>` : '')}
      ${raw(it.linked_req_count ? html`<small class="wdep" title="연결된 요구사항 ${it.linked_req_count}개">요구 ${it.linked_req_count}</small>` : '')}
      ${raw(withActions && !archived ? html`<span class="wact"><button class="wadd" data-addchild="${it.id}" title="하위 작업 추가" aria-label="하위 작업 추가" ${it.item_type === 'MILESTONE' ? 'disabled' : ''}>+</button><button class="wadd wmenu" data-rowmenu="${it.id}" title="더보기" aria-label="행 메뉴">⋯</button></span>` : '')}</div>`;
  };
  const editable = (it, col) => {
    if (it._ghost || roRow(it)) return false;
    const f = col.edit.field;
    if (isSys(it)) return f === 'owner';
    if (it.item_type === 'MILESTONE') return f === 'status' || f === 'owner' || f === 'planned_end_date';
    if (it.is_group || it.item_type === 'SUMMARY') return f === 'owner' || f === 'weight';   // status is computed from children (보류 via the detail view)
    return true;
  };
  /** R2 §5.5: one 기간 column "10/19–10/31" (plan-change note under it); the editable 계획 시작 / 계획 종료 columns stay in 컬럼. */
  const periodShift = (r) => (grid.isShown('end') ? '' : shiftLine(r));   // the restored 계획 종료 column carries the note — never twice
  const periodCol = () => (desk ? [{ key: 'period', label: '기간', width: 130, render: (r) => { if (r._ghost) return '';
    if (r.item_type === 'MILESTONE') return html`${raw(dateCell(r.milestone_date, false, r.past_end))}${raw(periodShift(r))}`;
    const s0 = r.planned_start; const e0 = r.planned_end; if (!s0 && !e0) return isLeafTask(r) && !roRow(r) ? '<span class="wper wper--empty" data-period-empty title="눌러서 계획 시작·종료일을 입력합니다">날짜 지정</span>' : dim();   // Jim P2-3: an empty 기간 says it can be clicked
    return html`<span class="wper ${r.past_end ? 'wpast' : r.computed_status === 'DELAYED' ? 'cell--late' : ''} ${r.rollup ? 'dim' : ''}" title="${r.rollup ? '하위 작업 기준 자동 계산' : r.past_end ? PAST_END() : ''}">${raw(r.past_end ? '<i class="wpast__i" aria-hidden="true">!</i>' : '')}${s0 ? fmtShort(s0) : '?'}–${e0 ? fmtShort(e0) : '?'}</span>${raw(periodShift(r))}`; } }] : []);
  const grid = createGrid({
    key: desk ? `wbs.tree.r2.${meId}` : 'wbs.tree', select: !archived, selectMode: !desk || selMode, rowId: (r) => r.id, paginate: false, sortable: false, total: () => matched, tableClass: 'gtable--wbs',   // K19: phone card = 1.1 제목 / 담당자 · 시작–종료 · 상태
    rowClass: (r) => `${isSys(r) ? 'is-sys' : ''} ${r._ghost ? 'is-ghost' : ''} wd${Math.min(r.depth, 4)} ${r.is_group || r.item_type === 'SUMMARY' ? 'is-group' : ''} ${r.item_type === 'MILESTONE' ? 'is-ms' : ''} ${isOverdue(r) ? 'is-late' : ''} ${r.archived_at ? 'is-arch' : ''}`,
    canEdit: editable, activeId: () => (sel ? sel.id : null), onOpen: (iid) => { if (iid !== GHOST) openDetail(iid); },
    onSelect: (s) => bulk.update(s.size),
    onEdit: async (iid, field, value) => {
      const it = byId().get(iid);
      const f = it.item_type === 'MILESTONE' && field === 'planned_end_date' ? 'milestone_date' : field;
      try { const r = await patchItem(it, { [f]: value }); if (!r) { grid.refresh(); return; } apply(r); if (sel && sel.id === iid) { sel = (await api('GET', wApi(`/${iid}`))).item; drawDetail(); } toast(r.warnings && r.warnings.length ? r.warnings[0] : '저장됨'); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); throw e; }
    },
    columns: [
      { key: 'code', label: desk ? '번호' : 'WBS', width: 70, sticky: true, fixed: true, cls: 'mono wcode', render: (r) => html`${r.wbs_code}` },
      { key: 'title', label: desk ? '작업' : '업무명', width: desk ? 300 : 400, min: 200, sticky: true, fixed: true, cls: 'ttl', render: (r) => titleCell(r) },
      ...periodCol(), { key: 'start', label: '계획 시작', width: 118, hidden: desk, edit: { type: 'date', field: 'planned_start_date' }, render: (r) => (r._ghost ? '' : r.item_type === 'MILESTONE' ? dim('—') : dateCell(r.planned_start, r.rollup)) },
      { key: 'end', label: '계획 종료', width: 118, hidden: desk, edit: { type: 'date', field: 'planned_end_date', cls: (r) => (r.past_end ? 'cell--past' : r.computed_status === 'DELAYED' ? 'cell--late' : ''), title: (r) => (r.past_end ? PAST_END() : ''), prefix: (r) => (r.past_end ? '<i class="wpast__i" aria-hidden="true">!</i>' : ''), value: (r) => (r.item_type === 'MILESTONE' ? r.milestone_date : r.planned_end_date), after: shiftLine }, render: (r) => (r._ghost ? '' : (r.item_type === 'MILESTONE' ? dateCell(r.milestone_date, false, r.past_end) : dateCell(r.planned_end, r.rollup, r.past_end)) + shiftLine(r)) },   // US-3: past the project end → warn colour + !, never red
      { key: 'astart', label: '실적 시작', width: 118, hidden: true, edit: { type: 'date', field: 'actual_start_date' }, render: (r) => (r._ghost || r.item_type === 'MILESTONE' ? '' : dateCell(r.actual_start, r.rollup)) },
      { key: 'aend', label: '실적 종료', width: 118, hidden: true, edit: { type: 'date', field: 'actual_end_date' }, render: (r) => (r._ghost ? '' : dateCell(r.actual_end, r.rollup)) },
      { key: 'wdays', label: '근무일', width: 76, hidden: true, align: 'right', render: (r) => { if (r._ghost) return ''; const n0 = wdays(r); return n0 === null ? dim() : html`<span title="주말·공휴일 제외">${n0}일</span>`; } },   // batch7 B4 (hidden by default; 컬럼)
      { key: 'progress', label: '진행률', width: desk ? 112 : 126, card: false, align: 'right', edit: { type: 'number', field: 'progress', value: (r) => r.progress, display: (r) => progCell(r) },
        render: (r) => (r._ghost || r.item_type === 'MILESTONE' ? '' : progCell(r)) },
      { key: 'owner', label: '담당자', width: desk ? 140 : 176, edit: { type: 'select', field: 'owner', options: (r) => ownerChoices(ownerKey(r), true), value: ownerKey, prefix: (r) => (r.owner_name ? html`<i class="av">${[...r.owner_name][0]}</i>` : ''), suffix: noAcct },
        render: (r) => (r._ghost ? '' : ownerCell(r)) },
      { key: 'status', label: '상태', width: desk ? 104 : 118, edit: { type: 'select', field: 'status', options: STATUS_EDIT, cls: (r) => (r.computed_status === 'DELAYED' ? 'cell--late' : ''), prefix: (r) => (r.computed_status === 'DELAYED' ? '<i class="wlate" title="계획 종료일이 지났습니다">지연</i>' : '') }, render: (r) => (r._ghost ? '' : statusBadge(r)) },   // UI-006: leaf rows show 지연 on the select too
      { key: 'weight', label: '가중치', width: 76, hidden: true, align: 'right', edit: { type: 'number', field: 'weight', value: (r) => r.weight, min: 0, max: 1000 }, render: (r) => (r._ghost || r.item_type === 'MILESTONE' ? '' : html`${r.weight}`) },
      { key: 'type', label: '유형', width: 80, hidden: true, render: (r) => (r._ghost ? '' : r.is_group ? '작업 그룹' : WBS_TYPE[r.item_type]) },
      { key: 'jira', label: '지라 실행', width: 110, hidden: true, render: (r) => (r._ghost || !jira || r.item_type === 'MILESTONE' ? '' : execChip(jira.by[r.id]) || dim()) },
    ],
    empty: () => (items.length ? emptyState({ title: '조건에 맞는 작업이 없습니다.', body: '검색어나 필터를 바꾸거나 초기화하세요.', cta: { id: 'clear2', label: '필터 초기화' }, small: true }) : ''),
  });

  /* ---------- bulk ---------- */
  const NONE = '__none';
  const bulk = { update() {}, destroy() {} };
  const bulkFields = [
    { key: 'status', label: '상태', options: STATUS_EDIT }, { key: 'owner_user_id', label: '담당자 (RELAI 사용자)', options: [[NONE, '미지정'], ...members.map((m) => [m.id, m.name])] },
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
      fields: bulkFields, canArchive: !archived, initial: ownerMode ? 'owner_user_id' : null,
      onApply: async ({ field, value }) => {
        const n = grid.selected.size; const f = bulkFields.find((x) => x.key === field);
        const shown = value === NONE ? '미지정' : (Array.isArray(f.options) ? f.options : Object.entries(f.options || {})).find(([v]) => v === value)?.[1] || value;
        if (n >= 20 && !(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건의 ${f.label}을(를) ${field === 'shift_days' ? `${value}일 이동` : `'${shown}'(으)로 변경`}할까요?`, body: '선택한 모든 WBS 항목에 적용되며 각각 변경 이력이 남습니다. 상위 작업·마일스톤 등 적용할 수 없는 항목은 제외되고 결과에 표시됩니다.', confirm: '일괄 변경' }))) return;
        const body = field === 'shift_days' ? { action: 'update', shift_days: value } : { action: 'update', patch: { [field]: value === NONE ? '' : value } };
        try {
          const ids = grid.selectedIds().filter((x) => x !== GHOST);
          const r = await withDelayReason((extra) => bulkRun(wApi('/bulk'), ids, { ...body, ...extra }), { count: ids.length });   // US-1: a pushed started/late row → 422 → reason dialog
          if (!r) return; reportBulk(r, '변경'); await bulkAfter(r);
        } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
      },
      onArchive: async () => {
        const n = grid.selected.size;
        if (!(await confirmDialog({ title: `${n.toLocaleString('ko-KR')}건을 삭제(보관)할까요?`, body: '하위 항목도 함께 보관되고 WBS 번호가 다시 매겨집니다. 선행 관계는 기록으로 남습니다.', confirm: '삭제', danger: true }))) return;
        try { const r = await bulkRun(wApi('/bulk'), grid.selectedIds().filter((x) => x !== GHOST), { action: 'archive' }); reportBulk(r, '삭제'); await bulkAfter(r); } catch (e) { toast(e.message); }
      },
      onClear: () => grid.clearSelection(),
    });
    bulk.update = b.update; bulk.destroy = b.destroy;
  };

  /* ---------- Gantt (unchanged behaviour; groups use the server roll-up) ---------- */
  const day = 86400000; const toD = (s) => new Date(s + 'T00:00:00');
  const span = (it) => ({ s: it.planned_start, e: it.planned_end, derived: Boolean(it.rollup) });
  const fitRange = () => {
    const ts = [];
    for (const it of items) { if (it.is_group || it.item_type === 'SUMMARY') continue; for (const k of ['planned_start_date', 'planned_end_date', 'milestone_date']) if (it[k]) ts.push(toD(it[k]).getTime()); }
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
        ${raw(rows.filter((r) => !r._ghost).map((it) => html`<div class="gantt__row ${sel && sel.id === it.id ? 'is-sel' : ''} ${it.is_group || it.item_type === 'SUMMARY' ? 'is-sum' : ''}" data-row="${it.id}"><span class="mono wcode">${it.wbs_code}</span>${raw(titleCell(it, { withActions: false }))}${raw(it.owner_name ? html`<small class="gowner">${it.owner_name}${raw(noAcct(it))}</small>` : '')}</div>`).join(''))}</div>
      <div class="gantt__scroll"><div class="gantt__right" style="width:${days * px}px">
        <div class="gantt__hdr gantt__hdr--m">${raw(months.map((mo) => html`<span style="width:${mo.days * px}px">${mo.key}</span>`).join(''))}</div>
        <div class="gantt__hdr gantt__hdr--w">${raw(weeks.map((w) => html`<span style="width:${7 * px}px">${w.getMonth() + 1}/${w.getDate()}</span>`).join(''))}</div>
        <div class="gantt__body" style="background-size:${7 * px}px 100%">
          <div class="gantt__today" style="left:${todayX}px"><em>오늘</em></div>
          ${raw(rows.filter((r) => !r._ghost).map((it) => {
            let bar = '';
            if (it.item_type === 'MILESTONE' && it.milestone_date) bar = html`<i class="gms ${it.status === 'COMPLETED' ? 'is-done' : ''}" style="left:${x(it.milestone_date) + px / 2}px" title="${it.title} · ${it.milestone_date}"></i><b class="glab" style="left:${x(it.milestone_date) + px / 2 + 12}px">${it.title}</b>`;
            else { const sp = span(it); if (sp.s && sp.e) { const l = x(sp.s); const w = x(sp.e) - l + px;
              bar = html`<i class="gbar ${sp.derived ? 'gbar--sum' : ''} ${it.computed_status === 'COMPLETED' ? 'is-done' : ''}" style="left:${l}px;width:${w}px" title="${it.title} · ${sp.s} – ${sp.e}"><span style="width:${it.computed_progress}%"></span></i>`; }
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

  /* ---------- empty WBS (Phase 3 US-2): one primary = WBS 뼈대 만들기; 직접 추가 · Excel · AI are secondary links ---------- */
  const emptyWbs = (v) => {
    const conf = Number(g.requirements && g.requirements.in_scope_confirmed) || 0;
    const lead = v === 'gantt' ? '작업에 시작일·종료일을 넣으면 여기에 일정표가 그려집니다.' : '아직 작업이 없습니다';
    const bodyText = conf ? `확정한 요구사항 ${conf}건으로 기본 작업 목록을 만들어 드립니다.` : '기본 작업 목록을 먼저 만들고 구현 작업은 요구사항이 확정되면 연결할 수 있습니다.';
    // R3b: one sentence + one button (the list's sentence is the helpful one; '아직 작업이 없습니다' is implied)
    return html`<div class="wempty" data-tour-id="wbs-empty"><span class="wempty__ic" aria-hidden="true">▤</span><h2>${v === 'gantt' ? lead : bodyText}</h2>
      ${raw(archived ? '' : html`<div class="wempty__a"><button class="btn btn--primary" id="skel">WBS 뼈대 만들기</button></div>
        ${raw(ghost && !hasNodes() ? html`<div class="wempty__add"><input class="input" data-ghost maxlength="200" placeholder="${ghost.item_type === 'MILESTONE' ? '마일스톤 이름 입력 후 Enter' : '작업명 입력 후 Enter · Esc 취소'}" autocomplete="off" aria-label="첫 작업 이름"></div>` : '')}
        <p class="wempty__alt"><button type="button" class="link linkbtn" id="add2">직접 추가</button> · <button type="button" class="link linkbtn" id="xl-import2">Excel로 가져오기</button> · ${raw(ai.enabled ? '<button type="button" class="link linkbtn" id="ai-wbs2">AI 초안</button>' : '<span class="dim" title="AI 기능이 설정되지 않았습니다.">AI 초안(사용 불가)</span>')}</p>
        ${raw(hasNodes() ? html`<p class="wempty__alt"><label class="toggle" title="분석·설계 다음에 '데이터 이관' 단계를 둡니다. 프로젝트 특성 '데이터 이관'도 함께 바뀝니다."><input type="checkbox" id="dm-sw" ${dmNode() ? 'checked' : ''}> 데이터 이관 단계</label></p>` : '')}`)}</div>`;
  };
  /** 뼈대 확인 dialog: a short list (그룹명 + 건수) instead of a sentence; [취소] [만들기]. */
  const openSkeleton = async () => {
    if (archived || hasUser()) return;
    let pv; try { pv = (await api('GET', wApi('/skeleton/preview'))).preview; } catch (e) { toast(e.message); return; }
    if (!pv.available) { toast('WBS에 이미 항목이 있어 뼈대를 만들 수 없습니다.'); await load(); draw(); return; }
    const rows = pv.groups.map((x) => [x.title, x.key === 'DEVELOPMENT' && pv.linked ? `${x.count} <small>(요구사항 ${pv.linked}건 자동 연결)</small>` : String(x.count)]);
    if (pv.milestones) rows.push(['마일스톤', String(pv.milestones)]);
    const bodyHtml = html`<ul class="skel">${raw(rows.map(([l, n]) => html`<li><span>${l}</span><b>${raw(n)}</b></li>`).join(''))}</ul>
      <p class="skel__note">만든 뒤 자유롭게 고치거나 지울 수 있습니다. 일정과 담당자는 직접 채웁니다 — 다음 가이드가 안내합니다.</p>`;
    if (!(await confirmDialog({ title: `WBS 뼈대 ${pv.total}건을 만들까요?`, bodyHtml, confirm: '만들기' }))) return;
    try {
      const r = await api('POST', wApi('/skeleton'), {}); apply(r);
      collapsed.clear(); for (const it of items.filter((x) => x.depth === 0 && x.children_count).slice(3)) collapsed.add(it.id);   // batch7: the first phases open, the rest folded
      ghost = null; syncRows(); draw(); toast(`작업 ${r.result.created}건을 만들었습니다.`);
    } catch (e) { toast(e.message); await load(); draw(); }
  };
  /** US-4 on the WBS screen: no milestone yet + 01 key dates not imported → one inline suggestion (not a banner). */
  const msSuggest = () => (!archived && hasUser() && !summary.milestones && kdPending ? html`<div class="wsuggest"><span>착수 때 정한 주요 일정 ${kdPending}건을 마일스톤으로 가져올까요?</span><button type="button" class="btn btn--secondary btn--sm" id="ms-import">가져오기</button></div>` : '');
  const importMs = async () => {
    try { const r = await api('POST', wApi('/milestones/from-key-dates'), {}); apply(r); draw(); toast(r.created ? `마일스톤 ${r.created}건을 가져왔습니다.` : '가져올 주요 일정이 없습니다. 이미 같은 마일스톤이 있습니다.'); }
    catch (e) { toast(e.message); }
  };

  /* ---------- batch7 B3: 데이터 이관 switch · 단계 구조 정리 banner (7 days 나중에, per user) ---------- */
  const tidyKey = `relai.wbs.tidyLater.${id}.${meId}`;
  const tidyHidden = () => { try { const t = Number(localStorage.getItem(tidyKey) || 0); return t && Date.now() - t < 7 * 86400000; } catch { return false; } };
  const tidyBanner = () => (!archived && hasNodes() && outside && !tidyHidden() ? html`<div class="wsuggest wtidy" data-tidy-banner><span>단계 밖에 있는 항목 <b>${outside}건</b>을 단계 아래로 정리할까요?</span><button type="button" class="btn btn--secondary btn--sm" id="tidy-open">정리 미리보기</button><button type="button" class="link linkbtn" id="tidy-later">나중에</button></div>` : '');
  const toggleDm = async (on) => {
    try { const r = await api('POST', wApi('/structure/data-migration'), { on }); apply(r); draw(); toast(on ? '데이터 이관 단계를 켰습니다.' : '데이터 이관 단계를 껐습니다.'); }
    catch (e) { toast(e.message); draw(); }
  };
  const openTidy = async () => {
    let pv; try { pv = await api('GET', wApi('/structure/tidy')); } catch (e) { toast(e.message); return; }
    if (!pv.items.length) { toast('단계 밖에 있는 항목이 없습니다.'); await load(); draw(); return; }
    const opts = (cur) => html`<option value="" ${cur ? '' : 'selected'}>그대로 두기</option>${raw(pv.nodes.map((n) => html`<option value="${n.key}" ${cur === n.key ? 'selected' : ''}>${n.title} 아래로</option>`).join(''))}`;
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="tidyT" data-tidy-dialog><h3 id="tidyT">단계 구조 정리 미리보기</h3>
      <div class="dialog__b"><p class="hint">단계 밖(최상위)에 있는 항목 ${pv.items.length}건입니다. 단계 태그나 이름으로 제안한 위치를 확인하고, 행마다 바꾸거나 '그대로 두기'를 고르세요. 하위 작업은 함께 옮겨집니다.</p>
      <table class="tidyt"><thead><tr><th>번호</th><th>항목</th><th>옮길 위치</th></tr></thead><tbody>${raw(pv.items.map((i) => html`<tr><td class="mono">${i.wbs_code}</td><td>${i.item_type === 'MILESTONE' ? '◆ ' : ''}${i.title}${raw(i.children ? html` <small class="dim">하위 ${i.children}</small>` : '')}</td><td><select class="select select--sm" data-tidy="${i.id}">${raw(opts(i.suggest))}</select></td></tr>`).join(''))}</tbody></table></div>
      <div class="actions"><button type="button" class="btn btn--secondary" data-v="0">취소</button><button type="button" class="btn btn--primary" data-v="1">적용</button></div></div>`;
    document.body.append(el);
    const done = () => el.remove();
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
    el.addEventListener('click', async (e) => {
      if (e.target === el) return done();
      const b = e.target.closest('[data-v]'); if (!b) return;
      if (b.dataset.v !== '1') return done();
      const moves = [...el.querySelectorAll('[data-tidy]')].map((x) => ({ id: x.dataset.tidy, key: x.value || null }));
      b.disabled = true;
      try { const r = await api('POST', wApi('/structure/tidy'), { moves }); apply(r); done(); draw(); toast(r.moved ? `${r.moved}건을 단계 아래로 정리했습니다.` : '옮긴 항목이 없습니다.'); }
      catch (err) { b.disabled = false; toast(err.message); }
    });
  };

  /* ---------- desktop toolbar (R2 §5.5): status segments · search · 담당자 · ⋯ · + 작업 추가 (≤ 5 controls) ---------- */
  const deskTool = (v, q, f) => {
    const leaf = items.filter((x) => !x.archived_at && !isSys(x)); const cnt = (k) => leaf.filter((x) => x.computed_status === k).length;   // same rows the 상태 filter keeps, so 전체 = the footer's 총 N건 (K11)
    const cur = q.get('cst') || '';
    const SEG = [['', '전체', leaf.length], ['IN_PROGRESS', '진행 중', cnt('IN_PROGRESS')], ['DELAYED', '지연', cnt('DELAYED')], ['COMPLETED', '완료', cnt('COMPLETED')]];
    const seg = html`<div class="sseg" role="group" aria-label="상태" data-status-seg>${raw(SEG.map(([k, l, c]) => html`<button type="button" class="${cur === k ? 'is-on' : ''}" data-cstf="${k}" aria-pressed="${cur === k}">${l} <b>${c}</b></button>`).join(''))}${raw(cur && !SEG.some(([k]) => k === cur) ? html`<button type="button" class="is-on" data-cstf="${cur}" aria-pressed="true">${WBS_CSTATUS[cur] || cur}</button>` : '')}</div>`;
    const ownerSel = html`<select class="select select--sm" id="f-owner" aria-label="담당자"><option value="">담당자</option><option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>${raw(members.map((m) => html`<option value="${m.id}" ${q.get('owner') === m.id ? 'selected' : ''}>${m.name}</option>`).join(''))}${raw(owners.team.some((t) => !t.member) ? html`<optgroup label="팀원 (계정 없음)">${raw(owners.team.filter((t) => !t.member).map((t) => html`<option value="s:${t.id}" ${q.get('owner') === `s:${t.id}` ? 'selected' : ''}>${t.name}</option>`).join(''))}</optgroup>` : '')}</select>`;
    const fl = (label, inner) => html`<label class="tmenu__f"><span>${label}</span>${raw(inner)}</label>`;
    const menu = toolMenu([
      ['필터 더보기', html`${raw(fl('보기', html`<select class="select select--sm" id="quick" aria-label="보기"><option value="">전체 보기</option>${raw(Object.entries(QUICK_LABEL).map(([k, l]) => html`<option value="${k}" ${f === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>`))}
        ${raw(fl('상태', html`<select class="select select--sm" id="f-cst" aria-label="상태"><option value="">전체</option>${raw(Object.entries(WBS_CSTATUS).map(([k, l]) => html`<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>`))}
        <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>`],
      ['보기', html`${raw(v === 'gantt' ? tmItem('전체 일정 맞추기', 'id="gfit"') + tmItem('오늘로 이동', 'id="gtoday"') : '')}${raw(tmItem('모두 펼치기', 'id="expall"'))}${raw(tmItem('모두 접기', 'id="colall"'))}`],
      [archived ? '' : '추가', archived ? '' : tmItem('◆ 마일스톤 추가', 'id="add-ms"', '기간 없이 날짜만 있는 주요 시점')],
      [archived || !hasNodes() ? '' : '단계 구조', archived || !hasNodes() ? '' : html`<label class="toggle tmenu__sw" title="분석·설계 다음에 '데이터 이관' 단계를 둡니다. 프로젝트 특성 '데이터 이관'도 함께 바뀝니다."><input type="checkbox" id="dm-sw" ${dmNode() ? 'checked' : ''}> 데이터 이관 단계</label>${raw(outside ? tmItem(`단계 밖 항목 ${outside}건 정리…`, 'id="tidy-open"') : '')}`],
      ['가져오기·내보내기', html`${raw(archived ? '' : tmItem('Excel로 가져오기…', 'data-xl="import"'))}${raw(tmItem('등록 템플릿 내려받기 (Excel)', 'data-xl="template"'))}${raw(tmItem('현재 WBS 내보내기 (Excel)', 'data-xl="export"'))}`],
      [archived ? '' : 'AI', archived ? '' : ai.enabled ? tmItem('AI로 초안 만들기', 'id="ai-wbs" title="요구사항과 프로젝트 수행 업무(데이터 이관·인프라·연계·전환·교육)를 확인해 전체 WBS 초안을 만듭니다" data-tour-id="ai-wbs"', aiPrice(ai, 'WBS_GENERATION')) : tmItem('AI로 초안 만들기', 'id="ai-wbs" disabled', 'AI 기능이 설정되지 않았습니다')],
    ], { label: '일정 메뉴 더보기' });
    return html`<div class="rtool rtool--r2" data-rtool-r2>${raw(seg)}<input class="input input--sm" id="q" type="search" placeholder="작업명, 번호 검색" value="${q.get('q') || ''}" aria-label="작업 검색">${raw(ownerSel)}${raw(v === 'list' ? grid.toolsHtml() : '')}<span class="rtool__sp"></span>${raw(menu)}${raw(ai.enabled && !archived ? '<button type="button" class="btn btn--secondary btn--sm btn--ai ai-pc" id="ai-wbs-pc" data-ai-pc title="요구사항과 프로젝트 수행 업무(데이터 이관·인프라·연계·전환·교육)를 확인해 전체 WBS 초안을 만듭니다">AI로 초안 만들기</button>' : '')}${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ 작업 추가</button>')}</div>`;
  };

  const draw = () => {
    const rows = visible(); const v = view(); const f = quick(); const q = params();
    // K18: on phones 담당자 · 상태 move into the 필터 sheet (search + 필터 + one primary stay in the toolbar)
    const phone = isPhone(); const quickSel = html`<select class="select select--sm" id="f-owner" aria-label="담당자"><option value="">담당자</option><option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>${raw(members.map((m) => html`<option value="${m.id}" ${q.get('owner') === m.id ? 'selected' : ''}>${m.name}</option>`).join(''))}${raw(owners.team.some((t) => !t.member) ? html`<optgroup label="팀원 (계정 없음)">${raw(owners.team.filter((t) => !t.member).map((t) => html`<option value="s:${t.id}" ${q.get('owner') === `s:${t.id}` ? 'selected' : ''}>${t.name}</option>`).join(''))}</optgroup>` : '')}</select>
        <select class="select select--sm" id="f-cst" aria-label="상태"><option value="">상태</option>${raw(Object.entries(WBS_CSTATUS).map(([k, l]) => html`<option value="${k}" ${q.get('cst') === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>`;
    g.wbs = summary;
    // Phase 3 (US-2, J3): 0 items → the empty state only (no toolbar table, no blank row, no 총 N건). 직접 추가 opens one input inside it.
    // batch7: no user item yet → the empty card (뼈대 primary) above the fixed phase nodes
    const body = !hasUser() ? html`${raw(emptyWbs(v))}${raw(hasNodes() && v === 'list' && !archived ? grid.html() : '')}`
      : v === 'gantt' ? html`<div class="rtable-wrap wbs-wrap">${raw(rows.length ? gantt(rows) : emptyState({ title: '조건에 맞는 작업이 없습니다.', body: '보기 조건을 바꾸거나 필터를 초기화하세요.', cta: { id: 'clear2', label: '필터 초기화' }, small: true }))}</div>`
      : grid.html();
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { tab: ctx() === 'monitor' ? 'overview-wbs' : 'wbs', title: ctx() === 'monitor' ? 'WBS · 운영 조회' : 'WBS 작성' }))}
      ${raw(isArch ? '<div class="notice">보관된 프로젝트입니다. WBS는 조회만 할 수 있습니다.</div>' : pcLine())}
      ${raw(params().get('phase') && !items.some((it) => it.lifecycle_phase === params().get('phase')) && items.length ? html`<div class="notice notice--soft">${LIFECYCLE_LABEL[params().get('phase')] || params().get('phase')} 단계로 지정된 작업이 아직 없어 전체 WBS를 표시합니다. 작업 상세에서 단계를 지정할 수 있습니다.</div>` : '')}
      ${raw(onPhone() && params().get('view') === 'gantt' ? '<p class="pcnote" data-gantt-pc>간트 차트는 PC에서 볼 수 있습니다</p>' : '')}
      ${raw(msSuggest())}${raw(tidyBanner())}
      ${raw(items.length && jira ? coachMark('JIRA_EXECUTION_INTRO') : '')}
      ${raw(ctxCr ? html`<div class="ctx"><span><b>${ctxCr.display_id}</b> ${ctxCr.title}에서 이동했습니다. ${ctxCr.impacts && ctxCr.impacts.length ? `영향 WBS ${ctxCr.impacts.length}건만 표시합니다.` : '영향 WBS가 등록되지 않아 전체를 표시합니다.'} 반영이 끝나면 변경 요청을 '반영 완료'로 바꾸세요.</span><a class="link" href="/app/projects/${p.id}/changes?sel=${ctxCr.id}" data-link>변경 요청 보기</a><button class="linkbtn" id="ctx-off" type="button">컨텍스트 해제</button></div>` : '')}
      ${raw(hasUser() && desk ? deskTool(v, q, f) : '')}
      ${raw(items.length && ownerMode && desk && !archived ? html`<div class="ownbar" data-owner-bar><b>담당자 지정</b><span>담당자가 없는 작업을 미리 선택했습니다. 아래에서 담당자를 고르고 적용하세요. 체크박스로 선택을 바꿀 수 있습니다.</span></div>` : '')}
      ${raw(hasUser() && !desk ? html`<div class="rtool">
        <div class="seg" role="tablist"><button class="${v === 'list' ? 'is-on' : ''}" data-view="list" role="tab">WBS</button><button class="${v === 'gantt' ? 'is-on' : ''}" data-view="gantt" role="tab">간트</button></div>
        ${raw(v === 'gantt' ? '<span class="gtools"><button class="btn btn--secondary btn--sm" id="gfit">전체 일정</button><button class="btn btn--secondary btn--sm" id="gtoday">오늘</button></span>' : '')}
        <input class="input input--sm" id="q" type="search" placeholder="WBS명, 번호 검색" value="${q.get('q') || ''}" style="max-width:200px">
        ${raw(phone ? '' : quickSel)}
        ${raw(moreFilters(html`${raw(phone ? quickSel : '')}<select class="select select--sm" id="quick" aria-label="보기"><option value="">전체 보기</option>${raw(Object.entries(QUICK_LABEL).map(([k, l]) => html`<option value="${k}" ${f === k ? 'selected' : ''}>${l}</option>`).join(''))}</select>
          <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>`, [...(phone ? [q.get('owner'), q.get('cst')] : []), f, q.get('archived')].filter(Boolean).length))}
        <span class="ph-hide"><button class="link linkbtn" id="expall" style="width:auto">모두 펼치기</button><button class="link linkbtn" id="colall" style="width:auto">모두 접기</button></span>
        <span class="rtool__sp"></span>
        ${raw(v === 'list' && items.length ? html`<span class="ph-hide">${raw(grid.toolsHtml())}</span>` : '')}
        <span class="gtools ph-hide"><button type="button" class="btn btn--secondary btn--sm" id="xl-btn" aria-haspopup="true">Excel ▾</button>
          <div class="gpop" id="xl-pop" hidden>${raw(archived ? '' : '<button type="button" class="gpop__i linkbtn" data-xl="import">Excel로 가져오기…</button>')}<button type="button" class="gpop__i linkbtn" data-xl="template">등록 템플릿 내려받기</button><button type="button" class="gpop__i linkbtn" data-xl="export">현재 WBS 내보내기</button></div></span>
        ${raw(archived ? '' : ai.enabled ? '<button type="button" class="btn btn--secondary btn--sm btn--ai ph-hide" id="ai-wbs" title="요구사항과 프로젝트 수행 업무(데이터 이관·인프라·연계·전환·교육)를 확인해 전체 WBS 초안을 만듭니다" data-tour-id="ai-wbs">AI로 WBS 만들기</button>' : '<button type="button" class="btn btn--secondary btn--sm btn--ai ph-hide" id="ai-wbs" disabled title="AI 기능이 설정되지 않았습니다.">AI로 WBS 만들기</button>')}
        ${raw(archived ? '' : '<button class="btn btn--secondary btn--sm ph-hide" id="add-ms" title="마일스톤 추가 (기간 없이 날짜만)">◆ 마일스톤 추가</button><button class="btn btn--primary btn--sm" id="add">+ 항목 추가</button>')}
      </div>
      <div class="kstrip" id="kstrip">${raw(kpiHtml())}</div>` : '')}
      ${raw(appliedFilters(q, [{ key: 'q', label: '검색' }, { key: 'owner', label: '담당자', format: (v2) => (v2 === 'none' ? '미지정' : /^s:/.test(v2) ? (owners.team.find((t) => `s:${t.id}` === v2) || {}).name || v2 : (members.find((m) => m.id === v2) || {}).name || v2) }, { key: 'cst', label: '상태', map: WBS_CSTATUS }, { key: 'f', label: '보기', map: QUICK_LABEL }, { key: 'phase', label: '단계', map: LIFECYCLE_LABEL }, { key: 'requirement', label: '요구사항', format: () => (ctxReq ? `${ctxReq.display_id} ${ctxReq.title}` : '…') }]))}
      <div id="bulkslot"></div>
      <div class="rlayout ${sel ? 'has-drawer' : ''}">
        ${raw(body)}
        <aside class="drawer drawer--lg" id="drawer" ${sel ? '' : 'hidden'}></aside>
      </div>
    </div>`;
    bind();
    if (v === 'list' && items.length) { mountBulkBar(); bulk.update(grid.selected.size); }
    if (sel) drawDetail();
    focusGhost();
  };
  const focusGhost = () => { const inp = main.querySelector('[data-ghost]'); if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); } };
  const openGhost = (parent_id, item_type = 'TASK') => {
    if (archived) return;
    const fromGantt = view() === 'gantt';   // Jim B4: read before leaving 간트 — after setParam view() is 'list' and the grid isn't mounted yet
    if (fromGantt) setParam('view', '');
    ghost = { parent_id: parent_id || null, item_type };
    if (parent_id) collapsed.delete(parent_id);
    syncRows(); if (!hasUser() || fromGantt) { draw(); } else { grid.refresh(); focusGhost(); }
  };
  const closeGhost = () => { ghost = null; syncRows(); if (!hasUser()) draw(); else grid.refresh(); };
  /* BUG-005: the server refuses to turn a leaf that has its own schedule/progress into a group without being told what to
   * do with those values. Ask, then retry with convert_parent. `allowMove` = the values can be carried into the new child. */
  const withConvert = async (call, { allowMove = true } = {}) => {
    try { return await call({}); }
    catch (e) {
      if (e.code !== 'parent_has_values') throw e;
      const p = e.error?.parent || {};
      const opts = [];
      if (allowMove) opts.push({ id: 'move', label: '기존 값을 하위 작업으로 옮기기', hint: `새 하위 작업이 ${p.progress ?? 0}% · ${p.planned_start_date || '-'}~${p.planned_end_date || '-'} 을(를) 이어받습니다.` });
      opts.push({ id: 'drop', label: '하위 작업 기준으로 다시 계산', hint: '상위 작업에 입력된 진행률·일정은 더 이상 쓰이지 않습니다 (이력에 남습니다).', danger: true });
      const v = await choiceDialog({ title: `${p.wbs_code || ''} ${p.title || '상위 작업'}에 이미 일정·진행률이 있습니다`, body: '하위 작업이 생기면 상위 작업의 일정과 진행률은 하위 작업을 합산해 계산됩니다. 기존 값을 어떻게 할까요?', options: opts });
      if (!v) return null;
      return call({ convert_parent: v });
    }
  };
  const createFromGhost = async (title) => {
    const t = title.trim(); if (!t || !ghost) return;
    const body = { title: t, item_type: ghost.item_type, parent_id: ghost.parent_id || '' };
    try {
      const r = await withConvert((extra) => api('POST', wApi(), { ...body, ...extra })); if (!r) return; apply(r);
      const kept = ghost; toast(r.warnings && r.warnings.length ? `${r.item.wbs_code} 추가됨 — ${r.warnings[0]}` : `${r.item.wbs_code} ${r.item.title} 추가됨`);
      ghost = { ...kept }; syncRows(); if (userItems().length === 1) draw(); else { grid.refresh(); focusGhost(); }   // keep typing: next sibling
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message); }
  };

  /* ---------- structural actions with undo ---------- */
  const undoMove = (it, label) => { const from = { parent_id: it.parent_id || null, sequence: it.sequence }; return (r) => toastAction(label, { onAction: async () => { try { apply(await api('POST', wApi(`/${it.id}/move`), from)); if (sel && sel.id === it.id) { sel = (await api('GET', wApi(`/${it.id}`))).item; drawDetail(); } grid.refresh(); toast('이동을 되돌렸습니다.'); } catch (e) { toast(e.message); } } }); };
  const structural = async (it, path, label, body = {}) => {
    const undo = undoMove(it, label);
    try { const r = await withConvert((extra) => api('POST', wApi(`/${it.id}/${path}`), { ...body, ...extra }), { allowMove: false }); if (!r) return; apply(r); if (sel && sel.id === it.id) { sel = r.item; drawDetail(); } grid.refresh(); undo(); }
    catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
  };
  const removeItem = async (it) => {
    const kids = items.filter((x) => x.parent_id === it.id).length;
    let mode = 'cascade';
    if (kids) {
      const all = items.filter((x) => { let c = x; while (c && c.parent_id) { if (c.parent_id === it.id) return true; c = byId().get(c.parent_id); } return false; }).length;
      mode = await choiceDialog({ title: `${it.wbs_code} ${it.title}에는 ${all}개의 하위 작업이 있습니다.`, body: '삭제한 항목은 목록에서 숨겨지며(보관) 바로 실행 취소할 수 있습니다. 요구사항 연결과 선행 관계는 기록으로 남습니다.',
        options: [{ id: 'cascade', label: '하위 작업과 함께 삭제', hint: `${all}개 하위 작업도 함께 숨겨집니다`, danger: true }, { id: 'promote', label: '하위 작업을 상위 레벨로 이동 후 삭제', hint: '하위 작업은 이 항목의 자리에 남습니다' }] });
      if (!mode) return;
    } else if (!(await confirmDialog({ title: `${it.wbs_code} ${it.title} 항목을 삭제할까요?`, body: '삭제한 항목은 목록에서 숨겨지며(보관) 바로 실행 취소할 수 있습니다.', confirm: '삭제', danger: true }))) return;
    try {
      const r = await api('POST', wApi(`/${it.id}/archive`), { children: mode }); apply(r);
      if (sel && sel.id === it.id) closeDrawer(); else grid.refresh();
      toastAction(`${it.wbs_code} ${it.title}을(를) 삭제했습니다.`, { onAction: async () => { try { apply(await api('POST', wApi(`/${it.id}/restore`), {})); grid.refresh(); toast('삭제를 되돌렸습니다.'); } catch (e) { toast(e.message); } } });
    } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
  };
  const rowMenu = (btn, it) => {
    document.querySelectorAll('.amenu').forEach((m) => m.remove());
    const m = document.createElement('div'); m.className = 'amenu amenu--row'; m.setAttribute('role', 'menu');
    const ms = it.item_type === 'MILESTONE';
    if (isSys(it)) m.innerHTML = html`<button type="button" role="menuitem" data-m="child">하위 작업 추가</button><button type="button" role="menuitem" data-m="msc">◆ 마일스톤 추가 (하위)</button>`;   // batch7: no rename / move / delete on a fixed node
    else m.innerHTML = html`${raw(ms ? '' : html`<button type="button" role="menuitem" data-m="child">하위 작업 추가</button>`)}<button type="button" role="menuitem" data-m="sibling">같은 레벨 작업 추가</button><button type="button" role="menuitem" data-m="ms">◆ 마일스톤 추가 (같은 레벨)</button><hr>
      <button type="button" role="menuitem" data-m="indent">들여쓰기 →</button><button type="button" role="menuitem" data-m="outdent" ${it.parent_id ? '' : 'disabled'}>← 내어쓰기</button><button type="button" role="menuitem" data-m="dup">복제</button><hr>
      <button type="button" role="menuitem" class="is-danger" data-m="del">삭제</button>`;
    const r = btn.getBoundingClientRect(); m.style.position = 'fixed'; m.style.visibility = 'hidden';
    document.body.append(m);
    // UI-005: flip upward when the menu would run past the bottom of the viewport; clamp horizontally by real width.
    const mh = m.offsetHeight, mw = m.offsetWidth;
    const top = r.bottom + 4 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
    m.style.top = `${top}px`; m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))}px`; m.style.visibility = '';
    const close = () => { m.remove(); document.removeEventListener('click', onDoc, true); };
    const onDoc = (e) => { if (!m.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    m.onclick = async (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return; close();
      const act = b.dataset.m;
      if (act === 'child') openGhost(it.id, 'TASK');
      else if (act === 'sibling') openGhost(it.parent_id, 'TASK');
      else if (act === 'ms') openGhost(it.parent_id, 'MILESTONE');
      else if (act === 'msc') openGhost(it.id, 'MILESTONE');
      else if (act === 'indent') structural(it, 'indent', `${it.wbs_code} ${it.title}을(를) 들여썼습니다.`);
      else if (act === 'outdent') structural(it, 'outdent', `${it.wbs_code} ${it.title}을(를) 내어썼습니다.`);
      else if (act === 'dup') { try { const r2 = await api('POST', wApi(`/${it.id}/duplicate`), {}); apply(r2); grid.refresh(); toast(`${r2.item.wbs_code} ${r2.item.title} 항목을 만들었습니다.`); } catch (e2) { toast(e2.message); } }
      else if (act === 'del') removeItem(it);
    };
  };

  /* ---------- drag & drop (title column handle; drop before / after / inside) ---------- */
  const bindDnd = () => {
    const gridEl = $('#grid'); if (!gridEl || archived) return;
    let dragId = null; let over = null;
    const clear = () => { gridEl.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-inside')); over = null; };
    gridEl.addEventListener('dragstart', (e) => { const h = e.target.closest('[data-drag]'); if (!h) return; dragId = h.dataset.drag; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); h.closest('tr').classList.add('is-dragging'); });
    gridEl.addEventListener('dragend', () => { gridEl.querySelectorAll('.is-dragging').forEach((x) => x.classList.remove('is-dragging')); clear(); dragId = null; });
    gridEl.addEventListener('dragover', (e) => {
      if (!dragId) return; const tr = e.target.closest('tr[data-id]'); if (!tr || tr.dataset.id === GHOST) return;
      const target = byId().get(tr.dataset.id); if (!target || target.id === dragId) return;
      // never into itself / its own subtree
      let c = target; while (c) { if (c.id === dragId) return; c = c.parent_id ? byId().get(c.parent_id) : null; }
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const rect = tr.getBoundingClientRect(); const y = (e.clientY - rect.top) / rect.height;
      const zone = target.item_type === 'MILESTONE' ? (y < 0.5 ? 'before' : 'after') : y < 0.4 ? 'before' : y > 0.6 ? 'after' : 'inside';   // UX-005: wider before/after bands so sibling reorder is reachable
      if (over && (over.tr !== tr || over.zone !== zone)) clear();
      if (!over) { tr.classList.add(`drop-${zone}`); over = { tr, zone }; }
    });
    gridEl.addEventListener('dragleave', (e) => { if (over && !gridEl.contains(e.relatedTarget)) clear(); });
    gridEl.addEventListener('drop', async (e) => {
      e.preventDefault(); if (!dragId || !over) { clear(); return; }
      const target = byId().get(over.tr.dataset.id); const zone = over.zone; const it = byId().get(dragId); clear();
      if (!it || !target) return;
      const undo = undoMove(it, `${it.wbs_code} ${it.title}을(를) ${zone === 'inside' ? `${target.wbs_code} ${target.title} 아래로` : `${target.wbs_code} ${target.title} ${zone === 'before' ? '앞으로' : '뒤로'}`}이동했습니다.`);
      let body;
      if (zone === 'inside') { body = { parent_id: target.id, sequence: 9999 }; collapsed.delete(target.id); }
      else {
        const sibs = items.filter((x) => (x.parent_id || null) === (target.parent_id || null) && x.id !== it.id);
        const idx = sibs.findIndex((x) => x.id === target.id);
        body = { parent_id: target.parent_id || null, sequence: (zone === 'before' ? idx : idx + 1) + 1 };
      }
      try { const r = await withConvert((extra) => api('POST', wApi(`/${it.id}/move`), { ...body, ...extra }), { allowMove: false }); if (!r) return; apply(r); if (sel && sel.id === it.id) { sel = r.item; drawDetail(); } grid.refresh(); undo(); }
      catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message); }
    });
  };

  const bind = () => {
    const gEl = main.querySelector('#grid'); if (gEl) gEl.addEventListener('pointerdown', (e) => { wantDates = Boolean(e.target.closest('[data-period-empty]')); }, true);
    for (const idb of ['ai-wbs', 'ai-wbs2', 'ai-wbs-pc']) { const aw = $(`#${idb}`); if (aw) aw.onclick = () => openWbsPlanner({ pid: id, onDone: async () => { await load(); paintKpi(); draw(); } }); }
    main.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { setParam('view', b.dataset.view === 'gantt' ? 'gantt' : ''); if (b.dataset.view === 'gantt') gx.mode = 'fit'; ghost = null; syncRows(); draw(); });
    const gf = $('#gfit'); if (gf) gf.onclick = () => { gx.mode = 'fit'; placeGantt(); };
    const gt = $('#gtoday'); if (gt) gt.onclick = () => { gx.mode = 'today'; placeGantt(); };
    const qi = $('#q'); let qt; if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { setParam('q', qi.value.trim()); syncRows(); keepUi(() => { if (view() === 'gantt') draw(); else grid.refresh(); }); }, 250); };
    const fo = $('#f-owner'); if (fo) fo.onchange = () => { setParam('owner', fo.value); syncRows(); draw(); };
    const fc = $('#f-cst'); if (fc) fc.onchange = () => { setParam('cst', fc.value); syncRows(); draw(); };
    const qk = $('#quick'); if (qk) qk.onchange = () => { setParam('f', qk.value); syncRows(); draw(); };
    main.querySelectorAll('[data-cstf]').forEach((b) => { b.onclick = () => { setParam('cst', b.dataset.cstf); syncRows(); draw(); }; });
    const sm = main.querySelector('[data-selmode]'); if (sm) sm.onclick = () => { selMode = !selMode; setParam('select', selMode ? '1' : ''); grid.setSelectMode(selMode); draw(); };
    main.querySelectorAll('.tmenu [data-xl]').forEach((b) => { b.onclick = async () => { try { if (b.dataset.xl === 'import') openImport({ kind: 'wbs', base: wApi(), onDone: async () => { await load(); draw(); } }); else if (b.dataset.xl === 'template') await download(`${wApi()}/template.xlsx`, { filename: 'WBS 등록 템플릿.xlsx' }); else await download(`${wApi()}/export.xlsx`); } catch (err) { toast(err.message); } }; });
    main.querySelectorAll('[data-kf]').forEach((b) => b.onclick = () => { setParam('f', b.dataset.kf); setParam('requirement', ''); ctxReq = null; syncRows(); draw(); });
    bindMoreFilters(main);
    bindFilterClears(main, { setParam, keys: ['q', 'owner', 'cst', 'f', 'requirement'], reload: async () => { if (!params().get('requirement')) ctxReq = null; syncRows(); draw(); } });
    const cl2 = $('#clear2'); if (cl2) cl2.onclick = () => { for (const k of ['q', 'owner', 'cst', 'f']) setParam(k, ''); syncRows(); draw(); };
    const cx = $('#ctx-off'); if (cx) cx.onclick = () => { ctxCr = null; setParam('cr', ''); syncRows(); draw(); };
    const ea = $('#expall'); if (ea) ea.onclick = () => { collapsed.clear(); syncRows(); draw(); };
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };   // GAP-002
    const ca = $('#colall'); if (ca) ca.onclick = () => { items.filter((i) => i.children_count).forEach((i) => collapsed.add(i.id)); syncRows(); draw(); };
    // tree toggles, inline add, row menu (delegated: works for both the grid and the Gantt's left pane)
    main.querySelector('.rlayout').addEventListener('click', (e) => {
      const tog = e.target.closest('[data-tog]');
      if (tog) { e.stopPropagation(); const k = tog.dataset.tog; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); syncRows(); keepUi(() => { if (view() === 'gantt') draw(); else grid.refresh(); }); return; }
      const ad = e.target.closest('[data-addchild]');
      if (ad) { e.stopPropagation(); openGhost(ad.dataset.addchild, 'TASK'); return; }
      const rm = e.target.closest('[data-rowmenu]');
      if (rm) { e.stopPropagation(); const it = byId().get(rm.dataset.rowmenu); if (it) rowMenu(rm, it); }
    });
    main.querySelector('.rlayout').addEventListener('keydown', (e) => {
      const inp = e.target.closest('[data-ghost]'); if (!inp) return;
      if (e.key === 'Enter') { e.preventDefault(); createFromGhost(inp.value); }
      else if (e.key === 'Escape') { e.preventDefault(); closeGhost(); }
      else if (e.key === 'Tab' && !e.shiftKey && ghost) {   // Tab = indent the new row under the previous visible sibling
        const vis = visible(); const gi = vis.findIndex((x) => x._ghost); const prev = vis.slice(0, gi).reverse().find((x) => (x.parent_id || null) === (ghost.parent_id || null) && x.item_type !== 'MILESTONE');
        if (prev) { e.preventDefault(); const val = inp.value; ghost.parent_id = prev.id; collapsed.delete(prev.id); syncRows(); grid.refresh(); const n = main.querySelector('[data-ghost]'); if (n) { n.value = val; n.focus(); } }
      }
    });
    main.querySelector('.rlayout').addEventListener('focusout', (e) => { const inp = e.target.closest && e.target.closest('[data-ghost]'); if (inp && !inp.value.trim()) setTimeout(() => { if (ghost && !main.querySelector('[data-ghost]:focus')) closeGhost(); }, 150); });
    for (const ida of ['add', 'add2']) { const b = $(`#${ida}`); if (b) b.onclick = () => openGhost(defaultParent(), 'TASK'); }   // batch7 B3.3: under the chosen node, else the current phase's node
    const dsw = $('#dm-sw'); if (dsw) dsw.onchange = () => toggleDm(dsw.checked);
    const tdy = $('#tidy-open'); if (tdy) tdy.onclick = openTidy;
    const tdl = $('#tidy-later'); if (tdl) tdl.onclick = () => { try { localStorage.setItem(tidyKey, String(Date.now())); } catch { /* private mode */ } draw(); };
    const sk = $('#skel'); if (sk) sk.onclick = openSkeleton;
    const mi0 = $('#ms-import'); if (mi0) mi0.onclick = importMs;
    if (params().get('skeleton') === '1') { setParam('skeleton', ''); if (!hasUser() && !archived) setTimeout(openSkeleton, 0); }
    const am = $('#add-ms'); if (am) am.onclick = () => openGhost(defaultParent(), 'MILESTONE');
    main.querySelectorAll('.gantt [data-row]').forEach((row) => row.onclick = () => openDetail(row.dataset.row));
    // Excel menu
    const xb = $('#xl-btn'); const xp = $('#xl-pop');
    if (xb) xb.onclick = (e) => { e.stopPropagation(); const open = xp.hidden; document.querySelectorAll('.gpop').forEach((x) => { x.hidden = true; }); xp.hidden = !open; };
    const doImport = () => openImport({ kind: 'wbs', base: wApi(), onDone: async () => { await load(); draw(); } });
    if (xp) xp.onclick = async (e) => {
      const b = e.target.closest('[data-xl]'); if (!b) return; xp.hidden = true;
      try {
        if (b.dataset.xl === 'import') doImport();
        else if (b.dataset.xl === 'template') await download(`${wApi()}/template.xlsx`, { filename: 'WBS 등록 템플릿.xlsx' });
        else await download(`${wApi()}/export.xlsx`);
      } catch (err) { toast(err.message); }
    };
    const xi2 = $('#xl-import2'); if (xi2) xi2.onclick = doImport;
    bindCoach(main);
    if (params().get('import') === '1' && !archived) { setParam('import', ''); doImport(); }
    if (params().get('ai') === '1' && !archived && ai.enabled) { setParam('ai', ''); openWbsPlanner({ pid: id, onDone: async () => { await load(); paintKpi(); draw(); } }); }
    grid.bind(main);
    bindDnd();
    bindEscape(() => { if (sel) closeDrawer(); });
    if (view() === 'gantt' && items.length) placeGantt();
  };

  /* ---------- detail modal ---------- */
  const showDrawer = () => { const d = $('#drawer'); d.hidden = false; $('.rlayout').classList.add('has-drawer'); };
  const closeDrawer = () => { sel = null; setParam('sel', ''); const d = $('#drawer'); d.hidden = true; d.innerHTML = ''; $('.rlayout').classList.remove('has-drawer'); if (view() === 'gantt') draw(); else grid.refresh(); };
  let wantDates = false;   // Jim P2-3: 날짜 지정 in an empty 기간 cell opens the drawer on 계획 시작일
  const openDetail = async (iid) => {
    const dates = wantDates; wantDates = false;
    try { dtab = 'info'; await loadSel(iid); showDrawer(); drawDetail(); if (view() === 'gantt') draw(); else grid.refresh();
      if (dates) { const inp = $('#drawer [data-field="planned_start_date"]'); if (inp && !inp.disabled) inp.focus(); } }
    catch (e) { toast(e.message); }
  };

  const wbsLabel = { lifecycle_phase: '단계', title: '업무명', description: '설명', item_type: '항목 유형', status: '상태', owner_user_id: '담당자', owner_stakeholder_id: '담당자 (팀원)', progress: '진행률', weight: '가중치', planned_start_date: '계획 시작일', planned_end_date: '계획 종료일', actual_start_date: '실적 시작일', actual_end_date: '실적 종료일', milestone_date: '마일스톤 날짜', parent: '상위 항목', sequence: '순서', source: '출처' };
  const histText = (h, it) => {
    const val = (f, v) => { if (v == null || v === '') return '-'; if (f === 'status') return STATUS_EDIT[v] || WBS_STATUS[v] || v; if (f === 'item_type') return WBS_TYPE[v] || v; if (f === 'owner_user_id') return (members.find((m) => m.id === v) || {}).name || '미지정'; if (f === 'owner_stakeholder_id') return (owners.team.find((x) => x.id === v) || {}).name || '(삭제된 담당자)'; if (f === 'lifecycle_phase') return LIFECYCLE_LABEL[v] || v; if (f === 'progress') return `${v}%`; return v; };
    switch (h.action_type) {
      case 'CREATED': return h.new_value ? html`생성 <q>${h.new_value}</q>` : html`<b>${it.wbs_code}</b> 생성`;
      case 'AI_GENERATED': return html`AI WBS 초안에서 생성`;
      case 'ARCHIVED': return html`삭제(보관)`;
      case 'CONVERTED': return html`<b>작업 그룹으로 전환</b> — 기존 값 <q>${h.old_value || '-'}</q> → ${h.new_value || ''}`;
      case 'RESTORED': return html`삭제 취소(복구)`;
      case 'JIRA_LINKED': return html`지라 이슈 연결 <q>${h.new_value}</q>`;
      case 'JIRA_UNLINKED': return html`지라 이슈 연결 해제 <q>${h.old_value}</q>`;
      case 'JIRA_AUTO_COMPLETED': return html`연결된 지라 작업이 모두 완료 — 동기화로 완료 처리`;
      case 'MOVED': return html`<b>${h.field_name === 'sequence' ? '순서' : '상위 항목'}</b> 변경 <q>${h.old_value || '-'}</q> → <q>${h.new_value || '-'}</q>`;
      case 'DEP_ADDED': return html`선행 작업 추가 <q>${h.new_value}</q>`;
      case 'DEP_REMOVED': return html`선행 작업 삭제 <q>${h.old_value}</q>`;
      case 'LINKED_REQ': return html`요구사항 연결 <q>${h.new_value}</q>`;
      case 'UNLINKED_REQ': return html`요구사항 연결 해제 <q>${h.old_value}</q>`;
      case 'LINK_TYPE_CHANGED': return html`연결 유형 변경 <q>${h.old_value}</q> → <q>${h.new_value}</q>`;
      default: { const f = h.field_name; const long = f === 'title' || f === 'description';
        return html`<b>${wbsLabel[f] || f}</b> 변경 ${raw(long ? (f === 'description' ? '' : html`<q>${h.old_value}</q> → <q>${h.new_value}</q>`) : html`${val(f, h.old_value)} → ${val(f, h.new_value)}`)}${raw(h.note ? html` <span class="hnote">· 사유: ${h.note}</span>` : '')}`; }
    }
  };

  /** Drawer: the shift line with the 최초 계획일 tooltip + the latest delay reason. */
  const shiftNote = (it) => { const t = planShiftText(it.original_planned_end_date, endOf(it)); if (!t) return '';
    return html`<p class="wshift wshift--d" data-shift-note>${t}${raw(it.delay_note ? html`<br><span>최근 사유: ${it.delay_note.note}</span>` : '')}</p>`; };
  const drawDetail = () => keepUi(() => {
    const it = sel; if (!it) return;
    const d = $('#drawer'); const readOnly = roRow(it); const t = it.item_type; const sysRo = readOnly || isSys(it);   // batch7: a fixed node keeps its name, phase and place
    const live = byId().get(it.id) || it; const group = Boolean(live.is_group) || t === 'SUMMARY';
    const sibs = items.filter((x) => (x.parent_id || null) === (it.parent_id || null));
    const idx = sibs.findIndex((x) => x.id === it.id);
    const predCandidates = items.filter((x) => x.id !== it.id && !it.predecessors.some((pp) => pp.predecessor_id === x.id));
    const ids = (view() === 'gantt' ? visible().map((x) => x.id) : grid.orderedIds()).filter((x) => x !== GHOST); const at = ids.indexOf(it.id);
    const events = mergeActivity({ history: it.history || [], comments: it.comments || [], fmt: (h) => histText(h, it), meId });
    const hist = events.filter((e) => e.kind !== 'COMMENT'); const comments = events.filter((e) => e.kind === 'COMMENT');
    const liveReq = it.requirement_links.filter((l) => !l.archived_at);
    const dateInput = (field, value, ro) => html`<input class="input input--sm" type="date" data-field="${field}" value="${value || ''}" ${ro ? 'disabled' : ''}>`;
    d.innerHTML = html`<div class="drawer__h"><b class="mono">${it.wbs_code}</b>${raw(statusBadge(live))}<span class="lbl-sub">${group ? '작업 그룹' : WBS_TYPE[t]}</span>${raw(it.archived_at ? `<span class="chip">보관됨</span>${archived ? '' : '<button type="button" class="btn btn--secondary btn--xs" id="restore">복구</button>'}` : '')}
        <span class="dnav"><button type="button" data-nav="-1" aria-label="이전 항목" title="이전 (목록 순서)" ${at <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-nav="1" aria-label="다음 항목" title="다음 (목록 순서)" ${at < 0 || at >= ids.length - 1 ? 'disabled' : ''}>↓</button></span>
        <button class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
      ${raw(dtabs([{ key: 'info', label: '기본' }, { key: 'req', label: '요구사항', count: liveReq.length }, { key: 'dep', label: '선행', count: it.predecessors.length }, ...(jira ? [{ key: 'jira', label: '지라', count: it.jira && it.jira.total ? it.jira.total : undefined }] : []), { key: 'hist', label: '이력', count: hist.length }, { key: 'cmt', label: '댓글', count: comments.length }], dtab))}
      <div class="drawer__b">
        <section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
          <div class="dlayout"><div>
            <input class="dtitle" data-field="title" value="${it.title}" maxlength="200" ${sysRo ? 'disabled' : ''} aria-label="WBS명">
            ${raw(isSys(it) ? '<p class="hint" data-sys-hint>단계 구조(고정) 항목입니다. 이름·위치는 바꿀 수 없고 삭제할 수 없습니다. 아래에 작업을 추가해 쓰세요.</p>' : '')}
            <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${readOnly ? 'disabled' : ''}>${it.description}</textarea>
            ${raw(group ? html`<p class="hint">하위 작업 ${live.children_count}개가 있는 작업 그룹입니다. 일정과 진행률은 하위 작업에서 자동 계산됩니다.</p>` : '')}
            ${raw(traceStrip([
              { label: '요구사항', value: liveReq.length, tone: liveReq.length ? '' : isLeafTask(live) ? 'warn' : 'muted' },
              { label: '변경 요청', value: it.changes ? it.changes.length : 0, href: `/app/projects/${p.id}/changes?wbs=${it.id}`, tone: it.changes && it.changes.length ? 'warn' : 'muted' },
              { label: '이슈', value: it.raid ? it.raid.issues.length : 0, sub: it.raid && it.raid.risks.length ? `리스크 ${it.raid.risks.length}` : '', href: `/app/projects/${p.id}/issues?wbs=${it.id}`, tone: it.raid && it.raid.issues.length ? 'warn' : 'muted' },
              { label: '테스트', value: it.testing ? it.testing.tests.length : 0, sub: it.testing && it.testing.tests.length ? `통과 ${it.testing.summary.pass} · 실패 ${it.testing.summary.fail}` : '', href: `/app/projects/${p.id}/tests?wbs=${it.id}`, tone: it.testing && it.testing.summary.fail ? 'crit' : it.testing && it.testing.tests.length ? '' : 'muted' },
            ], { compact: true }))}
          </div>
          <div class="dside">
            <div class="dfield"><span>담당자</span><div><select class="select select--sm" data-field="owner" ${readOnly ? 'disabled' : ''}>${raw(ownerOpts(ownerKey(it)))}</select>${raw(noAcct(live))}${raw(teamHint())}</div></div>
            <div class="dfield"><span>상태</span><div><select class="select select--sm" data-field="status" ${readOnly ? 'disabled' : ''}>${raw(opt(STATUS_EDIT, it.status))}</select>${raw(live.computed_status === 'DELAYED' ? '<small class="wlate" style="margin-left:6px">지연 — 계획 종료일 경과</small>' : '')}</div></div>
            ${raw(t === 'MILESTONE' ? html`<div class="dfield"><span>마일스톤 날짜</span><div>${raw(dateInput('milestone_date', it.milestone_date, readOnly))}${raw(live.past_end ? html`<p class="def__warn wpast__msg">${PAST_END()}</p>` : '')}${raw(shiftNote(it))}</div></div>`
              : group ? html`<div class="dfield"><span>계획 일정 <small class="dim">(자동)</small></span><div class="hint" style="height:36px;display:flex;align-items:center">${live.planned_start ? fmtShort(live.planned_start) : '-'} ~ ${live.planned_end ? fmtShort(live.planned_end) : '-'}${wdays(live) !== null ? ` · ${wdays(live)} 근무일` : ''}</div></div>
                <div class="dfield"><span>실적 일정 <small class="dim">(자동)</small></span><div class="hint" style="height:36px;display:flex;align-items:center">${live.actual_start ? fmtShort(live.actual_start) : '-'} ~ ${live.actual_end ? fmtShort(live.actual_end) : '-'}</div></div>
                <div class="dfield"><span>진행률 <small class="dim">(하위 작업 기준)</small></span><div class="pcell"><div class="pbar"><i style="width:${live.computed_progress || 0}%"></i></div><span>${live.computed_progress || 0}%</span></div></div>`
              : html`<div class="cols2"><div class="field"><label>계획 시작일</label>${raw(dateInput('planned_start_date', it.planned_start_date, readOnly))}<div class="err" data-for="planned_start_date"></div></div>
                <div class="field"><label>계획 종료일</label>${raw(dateInput('planned_end_date', it.planned_end_date, readOnly))}<div class="err" data-for="planned_end_date"></div></div></div>
                ${raw(shiftNote(it))}
                ${raw(wdays(live) !== null ? html`<p class="hint" data-wdays>${wdays(live)} 근무일 <small class="dim">(주말·공휴일 제외)</small></p>` : '')}
                ${raw(live.past_end ? html`<p class="def__warn wpast__msg">${PAST_END()}</p>` : '')}
                <div class="cols2 dx"><div class="field"><label>실적 시작일</label>${raw(dateInput('actual_start_date', it.actual_start_date, readOnly))}</div><div class="field"><label>실적 종료일</label>${raw(dateInput('actual_end_date', it.actual_end_date, readOnly))}</div></div>
                <div class="dfield"><span>진행률 (%)</span><div><input class="input input--sm" type="number" min="0" max="100" step="1" data-field="progress" value="${it.progress}" ${readOnly ? 'disabled' : ''}></div></div>`)}
            ${raw(t === 'MILESTONE' ? '' : html`<div class="dfield dx"><span>단계</span><div><select class="select select--sm" data-field="lifecycle_phase" ${sysRo ? 'disabled' : ''}><option value="" ${it.lifecycle_phase ? '' : 'selected'}>미지정</option>${raw(Object.entries(LIFECYCLE_LABEL).map(([k, l]) => html`<option value="${k}" ${it.lifecycle_phase === k ? 'selected' : ''}>${l}</option>`).join(''))}</select></div></div>`)}
            ${raw(t === 'MILESTONE' ? '' : html`<div class="dfield dx"><span>가중치 <small class="dim">(상위 진행률 계산)</small></span><div><input class="input input--sm" type="number" min="0" max="1000" step="1" data-field="weight" value="${it.weight ?? 1}" ${readOnly ? 'disabled' : ''}></div></div>`)}
            <div class="dfield dx"><span>상위 항목</span><div><select class="select select--sm" id="mv-parent" ${sysRo ? 'disabled' : ''}>${raw(parentOpts(it.parent_id || '', it.id))}</select></div></div>
            ${raw(sysRo ? '' : html`<div class="actions dx"><button class="btn btn--secondary btn--xs" id="mv-up" ${idx <= 0 ? 'disabled' : ''}>↑ 위로</button><button class="btn btn--secondary btn--xs" id="mv-down" ${idx < 0 || idx >= sibs.length - 1 ? 'disabled' : ''}>↓ 아래로</button><button class="btn btn--secondary btn--xs" id="mv-in" ${idx <= 0 ? 'disabled' : ''}>들여쓰기 →</button><button class="btn btn--secondary btn--xs" id="mv-out" ${it.parent_id ? '' : 'disabled'}>← 내어쓰기</button>${raw(t === 'MILESTONE' ? '' : '<button class="btn btn--secondary btn--xs" id="addchild">+ 하위 작업</button>')}</div>`)}
            ${raw(desk ? html`<button type="button" class="link linkbtn dmore__b" data-dx aria-expanded="${moreOpen}">${moreOpen ? '세부 정보 접기 ▴' : '세부 정보 더보기 ▾'}</button>` : '')}
            <div class="dsave" id="dsave"></div>
          </div></div>
        </section>
        <section data-pane="req" ${dtab === 'req' ? '' : 'hidden'}>
          <h4 class="dh">관련 요구사항 <em>${liveReq.length}</em></h4>
          ${raw(liveReq.length ? html`<ol class="crit links">${raw(liveReq.map((l) => html`<li>
            <a class="mono" href="/app/projects/${p.id}/requirements?sel=${l.requirement_id}" data-link>${l.display_id}</a><span class="crit__in" style="padding:6px 4px">${l.title}<small class="dim" style="margin-left:6px">${REQ_STATUS[l.status]} · ${REQ_SCOPE[l.scope]}</small></span>
            ${raw(readOnly ? html`<span class="chip chip--muted">${LINK_TYPE[l.link_type]}</span>` : html`<select class="select select--xs" data-rlink-type="${l.id}">${raw(Object.entries(LINK_TYPE).map(([v, lb]) => html`<option value="${v}" ${l.link_type === v ? 'selected' : ''}>${lb}</option>`).join(''))}</select>
            <span class="crit__act" style="opacity:1"><button data-rlink-del="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>`
            : isLeafTask(live) ? html`<div class="empty-inline"><b>아직 연결된 요구사항이 없습니다.</b><span>이 작업이 어떤 요구사항을 수행하기 위한 것인지 연결하면 나중에 추적하기 쉽습니다. 하나의 작업에 여러 요구사항을 연결할 수 있습니다.</span></div>` : html`<p class="hint">연결된 요구사항이 없습니다.</p>`)}
          ${raw(it.requirement_links.length - liveReq.length ? html`<p class="hint">보관된 요구사항 ${it.requirement_links.length - liveReq.length}건 연결은 기록으로만 남아 있습니다.</p>` : '')}
          ${raw(readOnly ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="rlink-add">+ 요구사항 연결</button></div>`)}
          ${raw(it.testing && it.testing.tests.length ? html`<h4 class="dh">관련 테스트 <em>${it.testing.tests.length}</em><span style="margin-left:auto">${raw(verifyChip(it.testing.summary.verification))}</span></h4>
            <ol class="crit links">${raw(it.testing.tests.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(resBadge(x.last_result))}</a></li>`).join(''))}</ol>` : '')}
          ${raw(it.raid && (it.raid.issues.length || it.raid.risks.length) ? html`<h4 class="dh">관련 이슈·리스크 <em>${it.raid.issues.length + it.raid.risks.length}</em></h4>
            <ol class="crit links">${raw(it.raid.issues.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/issues?sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(sevBadge(x.severity))}<span class="chip ${ISSUE_STATUS_CHIP[x.status] || ''}">${ISSUE_STATUS[x.status]}</span></a></li>`).join(''))}
            ${raw(it.raid.risks.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/issues?tab=risks&sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(sevBadge(x.risk_level))}<span class="chip ${RISK_STATUS_CHIP[x.status] || ''}">${RISK_STATUS[x.status]}</span></a></li>`).join(''))}</ol>` : '')}
        </section>
        <section data-pane="dep" ${dtab === 'dep' ? '' : 'hidden'}>
          <h4 class="dh">선행 작업 <em>${it.predecessors.length}</em></h4>
          <ol class="crit">${raw(it.predecessors.map((pp) => html`<li><span class="mono wcode">${pp.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${pp.title}</span><small class="dim">선행 완료 후 시작</small>
            ${raw(readOnly ? '' : html`<span class="crit__act" style="opacity:1"><button data-dep-del="${pp.id}" title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
          ${raw(readOnly ? (it.predecessors.length ? '' : '<p class="hint">선행 작업이 없습니다.</p>') : html`<div class="crit-add"><input class="input input--sm" id="dep-q" placeholder="선행 작업 검색 (번호 또는 이름)" style="flex:1" list="dep-list"><datalist id="dep-list">${raw(predCandidates.map((x) => html`<option value="${x.wbs_code} ${x.title}">`).join(''))}</datalist><button class="btn btn--secondary btn--sm" id="dep-add">추가</button></div><div class="err" id="dep-err"></div><p class="hint">순환 관계(A→B→A)는 저장되지 않습니다.</p>`)}
          ${raw(it.successors.length ? html`<h4 class="dh">후행 작업 <em>${it.successors.length}</em></h4><ol class="crit">${raw(it.successors.map((x) => html`<li><span class="mono wcode">${x.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span></li>`).join(''))}</ol>` : '')}
        </section>
        <section data-pane="hist" class="dpane-hist" ${dtab === 'hist' ? '' : 'hidden'}>${raw(activityPane({ events: hist, filter: 'CHANGES', ro: true }))}</section>
        <section data-pane="jira" class="dpane-jira" ${dtab === 'jira' ? '' : 'hidden'}>${raw(jiraPaneHtml(jiraDetail, live, { ro: readOnly }))}</section>
        <section data-pane="cmt" class="dpane-cmt" ${dtab === 'cmt' ? '' : 'hidden'}>${raw(activityPane({ events: comments, filter: 'COMMENT', ro: archived }))}</section>
      </div>
      ${raw(drawerFoot({ ro: sysRo, meta: `등록 ${fmtShort(it.created_at)}`, label: 'WBS 삭제', id: 'warchive' }))}`;
    bindDetail();
  });

  const bindDetail = () => {
    const it = sel; const d = $('#drawer'); const status = $('#dsave');
    $('#dclose').onclick = closeDrawer;
    bindDtabs(d, (k) => { dtab = k; if (k === 'jira' && !jiraDetail) loadJira(); });
    const loadJira = async () => { try { jiraDetail = await api('GET', wApi(`/${it.id}/jira`)); } catch (e) { jiraDetail = { mapped: false, error: e.message }; } if (sel && sel.id === it.id) { drawDetail(); } };
    const jiraChanged = async (r) => { jiraDetail = { ...(jiraDetail || {}), ...(r.links ? { links: r.links } : {}), ...(r.summary ? { summary: r.summary } : {}) }; try { const t = await api('GET', wApi()); apply(t); sel = (await api('GET', wApi(`/${it.id}`))).item; } catch { /* keep pane */ } grid.refresh(); drawDetail(); };
    bindJiraPane(d.querySelector('[data-pane="jira"]'), { pid: id, wbsId: it.id, it: byId().get(it.id) || it, onChange: jiraChanged });
    d.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { const ids = (view() === 'gantt' ? visible().map((x) => x.id) : grid.orderedIds()).filter((x) => x !== GHOST); const n = ids[ids.indexOf(it.id) + Number(b.dataset.nav)]; if (n) openDetail(n); });
    bindArrowNav((dir) => { if (!sel) return; const ids = (view() === 'gantt' ? visible().map((x) => x.id) : grid.orderedIds()).filter((x) => x !== GHOST); const n = ids[ids.indexOf(sel.id) + dir]; if (n) openDetail(n); });   // R2: keyboard ↑/↓ between items
    d.classList.toggle('is-more', moreOpen);
    const dxb = d.querySelector('[data-dx]'); if (dxb) dxb.onclick = () => { moreOpen = !moreOpen; d.classList.toggle('is-more', moreOpen); dxb.setAttribute('aria-expanded', String(moreOpen)); dxb.textContent = moreOpen ? '세부 정보 접기 ▴' : '세부 정보 더보기 ▾'; };
    const after = async (r) => { apply(r); sel = (await api('GET', wApi(`/${it.id}`))).item; grid.refresh(); drawDetail(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { const r = await patchItem(it, { [field]: value }); if (!r) { drawDetail(); return; } await after(r); const s = $('#dsave'); if (s) s.textContent = '저장됨'; }
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
    const move = async (body, label) => { const undo = undoMove(it, label); try { const r = await withConvert((extra) => api('POST', wApi(`/${it.id}/move`), { ...body, ...extra }), { allowMove: false }); if (!r) { drawDetail(); return; } await after(r); undo(); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); drawDetail(); } };
    const mp = $('#mv-parent'); if (mp) mp.onchange = () => move({ parent_id: mp.value || null }, `${it.wbs_code} ${it.title}의 상위 항목을 바꿨습니다.`);
    const rs = $('#restore'); if (rs) rs.onclick = async () => { try { const r = await api('POST', wApi(`/${it.id}/restore`), {}); toast(`${r.restored_ids.length}개 항목을 복구했습니다.`); await load(); sel = r.item; draw(); drawDetail(); } catch (e) { toast(e.message); } };   // GAP-002
    const up = $('#mv-up'); if (up) up.onclick = () => move({ sequence: it.sequence - 1 }, '순서를 위로 옮겼습니다.');
    const dn = $('#mv-down'); if (dn) dn.onclick = () => move({ sequence: it.sequence + 1 }, '순서를 아래로 옮겼습니다.');
    const mi = $('#mv-in'); if (mi) mi.onclick = () => structural(it, 'indent', `${it.wbs_code} ${it.title}을(를) 들여썼습니다.`);
    const mo = $('#mv-out'); if (mo) mo.onclick = () => structural(it, 'outdent', `${it.wbs_code} ${it.title}을(를) 내어썼습니다.`);
    const ac = $('#addchild'); if (ac) ac.onclick = () => { closeDrawer(); openGhost(it.id, 'TASK'); };
    const da = $('#dep-add'); if (da) da.onclick = async () => {
      const q = ($('#dep-q').value || '').trim().toLowerCase(); if (!q) return;
      const cand = items.filter((x) => x.id !== it.id && !it.predecessors.some((pp) => pp.predecessor_id === x.id));
      const hit = cand.find((x) => `${x.wbs_code} ${x.title}`.toLowerCase() === q) || cand.find((x) => x.wbs_code === q) || cand.filter((x) => x.title.toLowerCase().includes(q));
      const picked = Array.isArray(hit) ? (hit.length === 1 ? hit[0] : null) : hit;
      if (!picked) { $('#dep-err').textContent = Array.isArray(hit) && hit.length > 1 ? '여러 작업이 일치합니다. 번호까지 입력해 주세요.' : '일치하는 작업이 없습니다.'; return; }
      try { dtab = 'dep'; await after(await api('POST', wApi(`/${it.id}/dependencies`), { predecessor_id: picked.id })); }
      catch (e) { $('#dep-err').textContent = e.fields ? Object.values(e.fields)[0] : e.message; }
    };
    const dq = $('#dep-q'); if (dq) dq.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dep-add').click(); } };
    d.querySelectorAll('[data-dep-del]').forEach((b) => b.onclick = async () => { try { dtab = 'dep'; await after(await api('DELETE', wApi(`/${it.id}/dependencies/${b.dataset.depDel}`))); } catch (e) { toast(e.message); } });
    const ra = $('#rlink-add');
    if (ra) ra.onclick = async () => {
      const { requirements } = await api('GET', wsApi(`/${id}/requirements`));
      const linked = new Set(it.requirement_links.filter((l) => !l.archived_at).map((l) => l.requirement_id));
      const pick = await pickerDialog({ title: `${it.wbs_code} ${it.title}에 요구사항 연결`, placeholder: '요구사항 번호 또는 제목 검색', withType: true,
        rows: requirements.map((r) => ({ ...r, disabled: linked.has(r.id) })), searchKeys: ['display_id', 'title'],
        render: (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span>${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}` });
      if (!pick) return;
      try { dtab = 'req'; await after(await api('POST', wApi(`/${it.id}/links`), { requirement_id: pick.id, link_type: pick.link_type })); toast('요구사항을 연결했습니다.'); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    d.querySelectorAll('[data-rlink-type]').forEach((sl) => sl.onchange = async () => { try { dtab = 'req'; await after(await api('PATCH', wApi(`/${it.id}/links/${sl.dataset.rlinkType}`), { link_type: sl.value })); } catch (e) { toast(e.message); } });
    d.querySelectorAll('[data-rlink-del]').forEach((b) => b.onclick = async () => {
      const l = it.requirement_links.find((x) => x.id === b.dataset.rlinkDel);
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: `${it.wbs_code} ${it.title}과 ${l.display_id}의 연결만 제거됩니다.`, confirm: '연결 해제', danger: true }))) return;
      try { dtab = 'req'; await after(await api('DELETE', wApi(`/${it.id}/links/${l.id}`))); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const reloadComments = (c) => { sel.comments = c; dtab = 'cmt'; drawDetail(); };
    bindActivity(d, {
      onFilter: () => drawDetail(),
      onSubmit: async (body) => { reloadComments((await api('POST', wApi(`/${it.id}/comments`), { body })).comments); },
      onDelete: async (cid) => { if (!(await confirmDialog({ title: '댓글을 삭제할까요?', body: '삭제한 댓글은 복구할 수 없습니다.', confirm: '삭제', danger: true }))) return; try { reloadComments((await api('DELETE', wApi(`/${it.id}/comments/${cid}`))).comments); } catch (e) { toast(e.message); } },
    });
    const ab = $('#warchive'); if (ab) ab.onclick = () => removeItem(byId().get(it.id) || it);
  };

  await load();
  holidays().then((m) => { hol = m; if (grid.isShown && grid.isShown('wdays')) grid.refresh(); if (sel) drawDetail(); });   // batch7 B4: 근무일 (async; never blocks the page)
  const initSel = params().get('sel');
  if (initSel) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  if (params().get('new') === '1' && !hasUser()) { for (const k of ['new', 'parent', 'type']) setParam(k, ''); }   // J3: an empty WBS shows the empty state only (its 직접 추가 opens the input)
  else if (params().get('new') === '1' && !archived) { ghost = { parent_id: params().get('parent') || null, item_type: params().get('type') === 'MILESTONE' ? 'MILESTONE' : 'TASK' }; for (const k of ['new', 'parent', 'type']) setParam(k, ''); syncRows(); }
  draw();
  if (ownerMode && !archived) grid.select(items.filter((it) => isLeafTask(it) && !it.archived_at && !hasOwner(it)).map((it) => it.id));   // Jim P1-1: tasks without an owner come pre-ticked, the owner bar opens on them
}
