import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { projectHead } from '../project/guide.js';
import { resBadge, sevBadge, verifyChip } from '../shared/badges.js';
import { ISSUE_STATUS, ISSUE_STATUS_CHIP, LINK_TYPE, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, RISK_STATUS, RISK_STATUS_CHIP, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE } from '../shared/constants.js';
import { traceStrip } from '../shared/trace-strip.js';
import { drawerFoot, drawerHead, bindEscape } from '../shared/drawer.js';
import { appliedFilters, bindFilterClears } from '../shared/filters.js';
import { emptyState } from '../shared/empty-state.js';
import { confirmDialog, pickerDialog, showErrors, toast } from '../shared/dialogs.js';

export async function wbsPage(id) {
  const main = $('#main');
  const g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  const { members } = await api('GET', `/api/workspaces/${state.workspace.id}/members`);
  document.title = `WBS — ${p.name} — RELAI`;
  const wApi = (s = '') => wsApi(`/${id}/wbs${s}`);
  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };

  let items = []; let summary = g.wbs; let sel = null; let creating = params().get('new') === '1';
  // Context from other screens: ?requirement=<id> narrows to that requirement's WBS; ?cr=<id> shows the Change Request banner (B-2).
  let ctxReq = null; let ctxCr = null;
  if (params().get('requirement')) { try { ctxReq = (await api('GET', wsApi(`/${id}/requirements/${params().get('requirement')}`))).requirement; } catch { setParam('requirement', ''); } }
  if (params().get('cr')) { try { ctxCr = (await api('GET', wsApi(`/${id}/changes/${params().get('cr')}`))).change; } catch { setParam('cr', ''); } }
  const collapsed = new Set(); const gx = { px: 16, mode: 'fit', left: 0, start: null }; // Gantt viewport: mode = fit | today | keep
  const view = () => params().get('view') === 'gantt' ? 'gantt' : 'list';
  const quick = () => params().get('f') || '';
  const QUICK_LABEL = { no_owner: '담당자 미지정 작업', no_dates: '일정 미설정 작업', linked: '요구사항 연결됨', unlinked: '요구사항 미연결 작업' };
  const load = async () => { const d = await api('GET', wApi()); items = d.items; summary = d.summary; };
  const byId = () => new Map(items.map((i) => [i.id, i]));
  const loadSel = async (iid) => { sel = iid ? (await api('GET', wApi(`/${iid}`))).item : null; setParam('sel', iid); };

  /** Visible rows after collapse + quick filter (quick filter shows matching tasks with their ancestors). */
  const visible = () => {
    const m = byId(); const f = quick();
    let keep = null;
    const reqWbs = ctxReq ? new Set(ctxReq.links.map((l) => l.wbs_item_id)) : null;
    const crWbs = ctxCr ? new Set((ctxCr.impacts || []).map((l) => l.wbs_item_id)) : null;
    if (f || reqWbs || crWbs) {
      keep = new Set();
      for (const it of items) {
        let hit = !f || (f === 'linked' ? it.linked_req_count > 0
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

  const ownerOpts = (cur) => html`<option value="">미지정</option>` + members.map((mm) => html`<option value="${mm.id}" ${cur === mm.id ? 'selected' : ''}>${mm.name}</option>`).join('');
  const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const parentOpts = (cur, excludeId) => {
    const m = byId(); const blocked = new Set();
    if (excludeId) { blocked.add(excludeId); for (const it of items) { let c = it; while (c) { if (c.id === excludeId) { blocked.add(it.id); break; } c = c.parent_id ? m.get(c.parent_id) : null; } } }
    return html`<option value="">(최상위)</option>` + items.filter((i) => i.item_type !== 'MILESTONE' && !blocked.has(i.id))
      .map((i) => html`<option value="${i.id}" ${cur === i.id ? 'selected' : ''}>${'  '.repeat(i.depth)}${i.wbs_code} ${i.title}</option>`).join('');
  };
  const dateCell = (d, derived = false) => (d ? (derived ? html`<span class="dim">${fmtShort(d)}</span>` : html`${fmtShort(d)}`) : '<span class="dim">-</span>');
  /** Summary date span derived from descendants (display only). */
  const span = (it) => {
    if (it.item_type !== 'SUMMARY') return { s: it.planned_start_date, e: it.planned_end_date, derived: false };
    const m = byId(); let s0 = null; let e0 = null;
    for (const x of items) {
      let c = x; let under = false; while (c && c.parent_id) { if (c.parent_id === it.id) { under = true; break; } c = m.get(c.parent_id); }
      if (!under) continue;
      const a = x.item_type === 'MILESTONE' ? x.milestone_date : x.planned_start_date; const b = x.item_type === 'MILESTONE' ? x.milestone_date : x.planned_end_date;
      if (a && (!s0 || a < s0)) s0 = a; if (b && (!e0 || b > e0)) e0 = b;
    }
    return { s: s0, e: e0, derived: true };
  };

  const draw = () => {
    const rows = visible(); const v = view(); const f = quick(); g.wbs = summary;
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'wbs' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. WBS는 조회만 할 수 있습니다.</div>' : '')}
      ${raw(ctxCr ? html`<div class="ctx"><span><b>${ctxCr.display_id}</b> ${ctxCr.title}에서 이동했습니다. ${ctxCr.impacts && ctxCr.impacts.length ? `영향 WBS ${ctxCr.impacts.length}건만 표시합니다.` : '영향 WBS가 등록되지 않아 전체를 표시합니다.'} 반영이 끝나면 변경 요청을 '반영 완료'로 바꾸세요.</span><a class="link" href="/app/projects/${p.id}/changes?sel=${ctxCr.id}" data-link>변경 요청 보기</a><button class="linkbtn" id="ctx-off" type="button">컨텍스트 해제</button></div>` : '')}
      <div class="summary summary--4">
        <div><b>${summary.total}</b><span>전체 항목</span></div>
        <div><b>${summary.in_progress}</b><span>진행 중</span></div>
        <div><b>${summary.completed}</b><span>완료</span></div>
        <div><b>${summary.milestones}</b><span>마일스톤</span></div>
      </div>
      <div class="rtool">
        <div class="seg" role="tablist"><button class="${v === 'list' ? 'is-on' : ''}" data-view="list" role="tab">목록</button><button class="${v === 'gantt' ? 'is-on' : ''}" data-view="gantt" role="tab">Gantt</button></div>
        ${raw(v === 'gantt' ? '<span class="gtools"><button class="btn btn--secondary btn--sm" id="gfit">전체 일정</button><button class="btn btn--secondary btn--sm" id="gtoday">오늘</button></span>' : '')}
        <select class="select select--sm" id="quick"><option value="">전체 보기</option><option value="no_owner" ${f === 'no_owner' ? 'selected' : ''}>담당자 미지정 작업</option><option value="no_dates" ${f === 'no_dates' ? 'selected' : ''}>일정 미설정 작업</option><option value="linked" ${f === 'linked' ? 'selected' : ''}>요구사항 연결됨</option><option value="unlinked" ${f === 'unlinked' ? 'selected' : ''}>요구사항 미연결 작업</option></select>
        <button class="link linkbtn" id="expall" style="width:auto">모두 펼치기</button><button class="link linkbtn" id="colall" style="width:auto">모두 접기</button>
        <span class="rtool__sp"></span>
        ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ WBS 추가</button>')}
      </div>
      ${raw(appliedFilters(params(), [{ key: 'f', label: '보기', map: QUICK_LABEL }, { key: 'requirement', label: '요구사항', format: () => (ctxReq ? `${ctxReq.display_id} ${ctxReq.title}` : '…') }]))}
      <div class="rlayout ${sel || creating ? 'has-drawer' : ''}">
        <div class="rtable-wrap wbs-wrap">${raw(items.length ? (v === 'gantt' ? gantt(rows) : table(rows))
          : emptyState({ title: '아직 등록된 WBS가 없습니다.', body: '프로젝트에서 수행할 주요 작업과 일정을 정의하세요. 등록한 WBS는 요구사항, 변경 요청, 이슈, 테스트와 연결됩니다.', cta: archived ? null : { id: 'add2', label: '첫 WBS 만들기' } }))}
          ${raw(items.length && !rows.length ? emptyState({ title: '조건에 맞는 작업이 없습니다.', body: '보기 조건을 바꾸거나 필터를 초기화하세요.', cta: { id: 'clear2', label: '필터 초기화' }, small: true }) : '')}</div>
        <aside class="drawer" id="drawer" ${sel || creating ? '' : 'hidden'}>${raw(creating ? drawerCreate() : sel ? drawerDetail() : '')}</aside>
      </div>
    </div>`;
    bind();
  };

  const titleCell = (it) => html`<div class="wtitle" style="padding-left:${it.depth * 18}px">
    ${raw(it.children_count ? html`<button class="wtog" data-tog="${it.id}" aria-label="${collapsed.has(it.id) ? '펼치기' : '접기'}">${collapsed.has(it.id) ? '▸' : '▾'}</button>` : '<span class="wtog wtog--none"></span>')}
    ${raw(it.item_type === 'MILESTONE' ? '<i class="wms" title="마일스톤">◆</i>' : '')}<span class="${it.item_type === 'SUMMARY' ? 'wsum' : ''}">${it.title}</span>
    ${raw(it.predecessors.length ? html`<small class="wdep" title="선행 작업 ${it.predecessors.length}개">←${it.predecessors.length}</small>` : '')}
    ${raw(it.linked_req_count ? html`<small class="wdep" title="연결된 요구사항 ${it.linked_req_count}개">REQ ${it.linked_req_count}</small>` : '')}</div>`;

  const table = (rows) => html`<table class="rtable wbs">
    <thead><tr><th class="wcode">WBS</th><th>업무명</th><th>담당자</th><th>시작일</th><th>종료일</th><th class="wprog">진행률</th><th>상태</th></tr></thead>
    <tbody>${raw(rows.map((it) => html`<tr class="${sel && sel.id === it.id ? 'is-sel' : ''} ${it.item_type === 'SUMMARY' ? 'is-sum' : ''}" data-row="${it.id}">
      <td class="mono wcode">${it.wbs_code}</td>
      <td class="ttl">${raw(titleCell(it))}</td>
      <td>${it.owner_name || raw('<span class="dim">-</span>')}</td>
      <td>${raw(it.item_type === 'MILESTONE' ? html`<span class="dim">마일스톤</span>` : (() => { const sp = span(it); return dateCell(sp.s, sp.derived); })())}</td>
      <td>${raw(it.item_type === 'MILESTONE' ? dateCell(it.milestone_date) : (() => { const sp = span(it); return dateCell(sp.e, sp.derived); })())}</td>
      <td class="wprog">${raw(it.item_type === 'MILESTONE' ? '' : html`<div class="pcell"><div class="pbar"><i style="width:${it.computed_progress}%"></i></div><span>${it.computed_progress}%</span></div>`)}</td>
      <td><span class="chip ${WBS_STATUS_CHIP[it.status] || ''}">${WBS_STATUS[it.status]}</span></td></tr>`).join(''))}</tbody></table>`;

  const day = 86400000; const toD = (s) => new Date(s + 'T00:00:00');
  /** Active TASK/MILESTONE date range ±5 days; today-based default only when nothing is scheduled. */
  const fitRange = () => {
    const ts = [];
    for (const it of items) { if (it.item_type === 'SUMMARY') continue; for (const k of ['planned_start_date', 'planned_end_date', 'milestone_date']) if (it[k]) ts.push(toD(it[k]).getTime()); }
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const min = (ts.length ? Math.min(...ts) : t0.getTime() - 7 * day) - 5 * day; const max = (ts.length ? Math.max(...ts) : t0.getTime() + 30 * day) + 5 * day;
    return { min, max, days: Math.max(14, Math.round((max - min) / day) + 1) };
  };
  /** Apply the pending viewport action after the Gantt DOM exists (px depends on the measured width). */
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

  /* ---- Gantt: day-based columns, week header, bars for planned ranges, diamonds for milestones, today line ---- */
  const gantt = (rows) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const px = gx.px;
    const fr = fitRange(); const lo = Math.min(fr.min, today.getTime()); const hi = Math.max(fr.max, today.getTime());
    const start = new Date(lo); start.setDate(start.getDate() - start.getDay() - 7); // week-aligned, one week of slack for scrolling
    const end = new Date(hi); end.setDate(end.getDate() + (7 - end.getDay()) + 7);
    const days = Math.round((end - start) / day); gx.start = start;
    const x = (d) => Math.round((toD(d) - start) / day) * px;
    const weeks = []; for (let t = new Date(start); t < end; t.setDate(t.getDate() + 7)) weeks.push(new Date(t));
    const months = []; for (let t = new Date(start); t < end; t.setDate(t.getDate() + 1)) { const key = `${t.getFullYear()}.${t.getMonth() + 1}`; if (!months.length || months[months.length - 1].key !== key) months.push({ key, start: new Date(t), days: 0 }); months[months.length - 1].days++; }
    const todayX = Math.round((today - start) / day) * px + px / 2;
    return html`<div class="gantt">
      <div class="gantt__left"><div class="gantt__hdr"><span>WBS</span><span>업무명</span></div>
        ${raw(rows.map((it) => html`<div class="gantt__row ${sel && sel.id === it.id ? 'is-sel' : ''} ${it.item_type === 'SUMMARY' ? 'is-sum' : ''}" data-row="${it.id}"><span class="mono wcode">${it.wbs_code}</span>${raw(titleCell(it))}</div>`).join(''))}</div>
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

  const typeFields = (type, it = {}, ro = false) => type === 'MILESTONE'
    ? html`<div class="field"><label>마일스톤 날짜</label><input class="input input--sm" type="date" name="milestone_date" data-field="milestone_date" value="${it.milestone_date || ''}" ${ro ? 'disabled' : ''}></div>`
    : html`<div class="row2">
        <div class="field"><label>계획 시작일</label><input class="input input--sm" type="date" name="planned_start_date" data-field="planned_start_date" value="${it.planned_start_date || ''}" ${ro ? 'disabled' : ''}><div class="err" data-for="planned_start_date"></div></div>
        <div class="field"><label>계획 종료일</label><input class="input input--sm" type="date" name="planned_end_date" data-field="planned_end_date" value="${it.planned_end_date || ''}" ${ro ? 'disabled' : ''}><div class="err" data-for="planned_end_date"></div></div></div>`;

  const drawerCreate = () => {
    const type = params().get('type') && WBS_TYPE[params().get('type')] ? params().get('type') : 'TASK';
    const parent = params().get('parent') || '';
    return html`<form id="cf" novalidate>
    <div class="drawer__h"><b>새 WBS</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b">
      <div class="form-err" role="alert" hidden></div>
      <div class="field"><span class="lbl">항목 유형</span><div class="choices choices--3">${raw(Object.entries(WBS_TYPE).map(([v, l]) => html`<label class="choice"><input type="radio" name="item_type" value="${v}" ${type === v ? 'checked' : ''}><span>${l}</span></label>`).join(''))}</div></div>
      <div class="field"><label for="c-title">업무명 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: 요구사항 분석"><div class="err" data-for="title"></div></div>
      <div class="field"><label>상위 항목</label><select class="select" name="parent_id">${raw(parentOpts(parent))}</select><div class="err" data-for="parent_id"></div></div>
      <div class="field"><label>설명</label><textarea class="textarea" name="description" maxlength="5000" style="min-height:72px"></textarea></div>
      <div id="c-type-fields">${raw(typeFields(type))}</div>
      <div class="row2" id="c-work" ${type === 'SUMMARY' ? 'hidden' : ''}>
        <div class="field"><label>담당자</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select><div class="err" data-for="owner_user_id"></div></div>
        <div class="field"><label>상태</label><select class="select" name="status">${raw(opt(WBS_STATUS, 'NOT_STARTED'))}</select></div>
      </div>
      <div class="field" id="c-prog" ${type !== 'TASK' ? 'hidden' : ''}><label>진행률 (%)</label><input class="input" type="number" name="progress" min="0" max="100" step="1" value="0"><div class="err" data-for="progress"></div></div>
    </div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">WBS 추가</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;
  };

  const drawerDetail = () => {
    const it = sel; const ro = archived || Boolean(it.archived_at); const t = it.item_type;
    const live = byId().get(it.id); const sibs = items.filter((x) => x.parent_id === it.parent_id);
    const idx = sibs.findIndex((x) => x.id === it.id);
    const predCandidates = items.filter((x) => x.id !== it.id && !it.predecessors.some((pp) => pp.predecessor_id === x.id));
    return html`${raw(drawerHead(it.wbs_code, html`<span class="chip ${WBS_STATUS_CHIP[it.status] || ''}">${WBS_STATUS[it.status]}</span><span class="lbl-sub">${WBS_TYPE[t]}</span>`, { archived: Boolean(it.archived_at) }))}
    <div class="drawer__b">
      <input class="dtitle" data-field="title" value="${it.title}" maxlength="200" ${ro ? 'disabled' : ''} aria-label="업무명">
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${ro ? 'disabled' : ''}>${it.description}</textarea>
      <div class="dgrid">
        <div class="dfield"><span>항목 유형</span><div><select class="select select--sm" data-field="item_type" ${ro ? 'disabled' : ''}>${raw(opt(WBS_TYPE, t))}</select></div></div>
        <div class="dfield"><span>상태</span><div><select class="select select--sm" data-field="status" ${ro ? 'disabled' : ''}>${raw(opt(WBS_STATUS, it.status))}</select></div></div>
        ${raw(t === 'SUMMARY' ? '' : html`<div class="dfield"><span>담당자</span><div><select class="select select--sm" data-field="owner_user_id" ${ro ? 'disabled' : ''}>${raw(ownerOpts(it.owner_user_id || ''))}</select></div></div>`)}
        ${raw(t === 'TASK' ? html`<div class="dfield"><span>진행률 (%)</span><div><input class="input input--sm" type="number" min="0" max="100" step="1" data-field="progress" value="${it.progress}" ${ro ? 'disabled' : ''}></div></div>`
          : t === 'SUMMARY' ? html`<div class="dfield"><span>진행률 (하위 작업 기준)</span><div class="pcell" style="height:36px"><div class="pbar"><i style="width:${live ? live.computed_progress : 0}%"></i></div><span>${live ? live.computed_progress : 0}%</span></div></div>` : '')}
      </div>
      <div style="margin-top:12px">${raw(typeFields(t, it, ro))}</div>
      ${raw(t === 'MILESTONE' ? '' : html`<div class="row2">
        <div class="field"><label>실제 시작일</label><input class="input input--sm" type="date" data-field="actual_start_date" value="${it.actual_start_date || ''}" ${ro ? 'disabled' : ''}></div>
        <div class="field"><label>실제 종료일</label><input class="input input--sm" type="date" data-field="actual_end_date" value="${it.actual_end_date || ''}" ${ro ? 'disabled' : ''}></div></div>`)}
      <div class="dsave" id="dsave"></div>
      ${raw(traceStrip([
        { label: 'Requirements', value: it.requirement_links.filter((l) => !l.archived_at).length, tone: it.requirement_links.some((l) => !l.archived_at) ? '' : t === 'TASK' ? 'warn' : 'muted' },
        { label: 'Changes', value: it.changes ? it.changes.length : 0, href: `/app/projects/${p.id}/changes?wbs=${it.id}`, tone: it.changes && it.changes.length ? 'warn' : 'muted' },
        { label: 'Issues', value: it.raid ? it.raid.issues.length : 0, sub: it.raid && it.raid.risks.length ? `Risk ${it.raid.risks.length}` : '', href: `/app/projects/${p.id}/issues?wbs=${it.id}`, tone: it.raid && it.raid.issues.length ? 'warn' : 'muted' },
        { label: 'Tests', value: it.testing ? it.testing.tests.length : 0, sub: it.testing && it.testing.tests.length ? `${it.testing.summary.pass} Pass · ${it.testing.summary.fail} Fail` : '', href: `/app/projects/${p.id}/tests?wbs=${it.id}`, tone: it.testing && it.testing.summary.fail ? 'crit' : it.testing && it.testing.tests.length ? '' : 'muted' },
      ], { compact: true }))}

      <h4 class="dh">위치</h4>
      <div class="dfield"><span>상위 항목</span><div><select class="select select--sm" id="mv-parent" ${ro ? 'disabled' : ''}>${raw(parentOpts(it.parent_id || '', it.id))}</select></div></div>
      ${raw(ro ? '' : html`<div class="actions" style="margin-top:10px"><button class="btn btn--secondary btn--sm" id="mv-up" ${idx <= 0 ? 'disabled' : ''}>↑ 위로</button><button class="btn btn--secondary btn--sm" id="mv-down" ${idx < 0 || idx >= sibs.length - 1 ? 'disabled' : ''}>↓ 아래로</button>
        ${raw(t === 'MILESTONE' ? '' : html`<button class="btn btn--secondary btn--sm" id="addchild">+ 하위 항목</button>`)}</div>`)}

      ${raw((() => { const live = it.requirement_links.filter((l) => !l.archived_at); const arch = it.requirement_links.length - live.length;
        return html`<h4 class="dh">관련 요구사항 <em>${live.length}</em></h4>
        ${raw(live.length ? html`<ol class="crit links">${raw(live.map((l) => html`<li>
          <span class="mono">${l.display_id}</span><span class="crit__in" style="padding:6px 4px">${l.title}<small class="dim" style="margin-left:6px">${REQ_STATUS[l.status]} · ${REQ_SCOPE[l.scope]}</small></span>
          ${raw(ro ? html`<span class="chip chip--muted">${LINK_TYPE[l.link_type]}</span>` : html`<select class="select select--xs" data-rlink-type="${l.id}">${raw(Object.entries(LINK_TYPE).map(([v, lb]) => html`<option value="${v}" ${l.link_type === v ? 'selected' : ''}>${lb}</option>`).join(''))}</select>
          <span class="crit__act" style="opacity:1"><button data-rlink-del="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>`
          : t === 'TASK' ? html`<div class="empty-inline"><b>아직 연결된 요구사항이 없습니다.</b><span>이 작업이 어떤 요구사항을 수행하기 위한 것인지 연결하면 프로젝트 추적성을 높일 수 있습니다.</span></div>`
          : html`<p class="hint">연결된 요구사항이 없습니다.</p>`)}
        ${raw(arch ? html`<p class="hint">보관된 요구사항 ${arch}건 연결은 기록으로만 남아 있습니다.</p>` : '')}
        ${raw(ro ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="rlink-add">+ 요구사항 연결</button></div>`)}`; })())}

      ${raw(it.testing && it.testing.tests.length ? html`<h4 class="dh">관련 테스트 <em>${it.testing.tests.length}</em><span style="margin-left:auto">${raw(verifyChip(it.testing.summary.verification))}</span></h4>
        <ol class="crit links">${raw(it.testing.tests.map((t) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${t.id}" data-link><span class="mono">${t.display_id}</span><span class="crit__in" style="padding:6px 4px">${t.title}</span>${raw(resBadge(t.last_result))}</a></li>`).join(''))}</ol>` : '')}
      ${raw(it.raid && (it.raid.issues.length || it.raid.risks.length) ? html`<h4 class="dh">관련 Issues & Risks <em>${it.raid.issues.length + it.raid.risks.length}</em></h4>
        <ol class="crit links">${raw(it.raid.issues.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/issues?sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(sevBadge(x.severity))}<span class="chip ${ISSUE_STATUS_CHIP[x.status] || ''}">${ISSUE_STATUS[x.status]}</span></a></li>`).join(''))}
        ${raw(it.raid.risks.map((x) => html`<li><a class="raidrow" href="/app/projects/${p.id}/issues?tab=risks&sel=${x.id}" data-link><span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}</span>${raw(sevBadge(x.risk_level))}<span class="chip ${RISK_STATUS_CHIP[x.status] || ''}">${RISK_STATUS[x.status]}</span></a></li>`).join(''))}</ol>` : '')}

      <h4 class="dh">선행 작업 <em>${it.predecessors.length}</em></h4>
      <ol class="crit">${raw(it.predecessors.map((pp) => html`<li><span class="mono wcode">${pp.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${pp.title}</span><small class="dim">Finish to Start</small>
        ${raw(ro ? '' : html`<span class="crit__act" style="opacity:1"><button data-dep-del="${pp.id}" title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
      ${raw(ro ? (it.predecessors.length ? '' : '<p class="hint">선행 작업이 없습니다.</p>') : html`<div class="crit-add"><select class="select select--sm" id="dep-sel" style="flex:1"><option value="">선행 작업 선택…</option>${raw(predCandidates.map((x) => html`<option value="${x.id}">${x.wbs_code} ${x.title}</option>`).join(''))}</select><button class="btn btn--secondary btn--sm" id="dep-add">추가</button></div><div class="err" id="dep-err"></div>`)}
      ${raw(it.successors.length ? html`<p class="hint" style="margin-top:8px">후행 작업: ${it.successors.map((x) => `${x.wbs_code} ${x.title}`).join(', ')}</p>` : '')}
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(it.created_at)}`, label: 'WBS 보관', id: 'warchive' }))}`;
  };

  const bind = () => {
    main.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { setParam('view', b.dataset.view === 'gantt' ? 'gantt' : ''); if (b.dataset.view === 'gantt') gx.mode = 'fit'; draw(); });
    const gf = $('#gfit'); if (gf) gf.onclick = () => { gx.mode = 'fit'; placeGantt(); };
    const gt = $('#gtoday'); if (gt) gt.onclick = () => { gx.mode = 'today'; placeGantt(); };
    const qk = $('#quick'); if (qk) qk.onchange = () => { setParam('f', qk.value); draw(); };
    bindFilterClears(main, { setParam, keys: ['f', 'requirement'], reload: async () => { if (!params().get('requirement')) ctxReq = null; draw(); } });
    const cx = $('#ctx-off'); if (cx) cx.onclick = () => { ctxCr = null; setParam('cr', ''); draw(); };
    $('#expall').onclick = () => { collapsed.clear(); draw(); };
    $('#colall').onclick = () => { items.filter((i) => i.children_count).forEach((i) => collapsed.add(i.id)); draw(); };
    main.querySelectorAll('[data-tog]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.tog; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); draw(); });
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); setParam('parent', ''); setParam('type', ''); draw(); $('#c-title').focus(); }; }
    main.querySelectorAll('[data-row]').forEach((tr) => tr.onclick = async () => { creating = false; setParam('new', ''); await loadSel(tr.dataset.row); draw(); });
    const close = () => { creating = false; sel = null; setParam('sel', ''); setParam('new', ''); setParam('parent', ''); setParam('type', ''); draw(); };
    for (const idc of ['dclose', 'dcancel']) { const b = $('#' + idc); if (b) b.onclick = close; }
    bindEscape(() => { if (sel || creating) close(); });
    if (creating) bindCreate(); else if (sel) bindDetail();
    if (view() === 'gantt') placeGantt();
  };

  const bindCreate = () => {
    const form = $('#cf');
    form.querySelectorAll('[name=item_type]').forEach((r) => r.onchange = () => {
      const t = r.value; $('#c-type-fields').innerHTML = typeFields(t); $('#c-work').hidden = t === 'SUMMARY'; $('#c-prog').hidden = t !== 'TASK';
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '업무명을 입력해 주세요.' });
      const body = { ...d }; if (d.item_type !== 'TASK') delete body.progress; if (d.item_type === 'SUMMARY') { delete body.owner_user_id; }
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try {
        const r = await api('POST', wApi(), body);
        items = r.items; summary = r.summary; toast(`${r.item.wbs_code} ${r.item.title} 항목을 추가했습니다.`);
        creating = false; setParam('new', ''); setParam('parent', ''); setParam('type', ''); sel = r.item; setParam('sel', r.item.id); draw();
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    };
  };

  const bindDetail = () => {
    const it = sel; const status = $('#dsave');
    const apply = (r) => { items = r.items; summary = r.summary; sel = r.item || sel; };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { apply(await api('PATCH', wApi(`/${it.id}`), { [field]: value })); draw(); $('#dsave').textContent = '저장됨'; }
      catch (e) { status.textContent = e.fields ? Object.values(e.fields)[0] : e.message; toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    main.querySelectorAll('.drawer [data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT' || el.type === 'date') el.onchange = () => save(field, el.value);
      else {
        el.onblur = () => { const v = el.type === 'number' ? Number(el.value) : el.value.trim(); if (String(v) !== String(it[field] ?? '')) save(field, v); };
        el.onkeydown = (e) => { if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') el.blur(); };
      }
    });
    const move = async (body) => { try { apply(await api('POST', wApi(`/${it.id}/move`), body)); draw(); toast('위치를 변경했습니다.'); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); draw(); } };
    const mp = $('#mv-parent'); if (mp) mp.onchange = () => move({ parent_id: mp.value || null });
    const up = $('#mv-up'); if (up) up.onclick = () => move({ sequence: it.sequence - 1 });
    const dn = $('#mv-down'); if (dn) dn.onclick = () => move({ sequence: it.sequence + 1 });
    const ac = $('#addchild'); if (ac) ac.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); setParam('parent', it.id); setParam('type', 'TASK'); collapsed.delete(it.id); draw(); $('#c-title').focus(); };
    const da = $('#dep-add'); if (da) da.onclick = async () => {
      const v = $('#dep-sel').value; if (!v) return;
      try { apply(await api('POST', wApi(`/${it.id}/dependencies`), { predecessor_id: v })); draw(); }
      catch (e) { $('#dep-err').textContent = e.fields ? Object.values(e.fields)[0] : e.message; }
    };
    main.querySelectorAll('[data-dep-del]').forEach((b) => b.onclick = async () => { try { apply(await api('DELETE', wApi(`/${it.id}/dependencies/${b.dataset.depDel}`))); draw(); } catch (e) { toast(e.message); } });
    const ra = $('#rlink-add');
    if (ra) ra.onclick = async () => {
      const { requirements } = await api('GET', wsApi(`/${id}/requirements`));
      const linked = new Set(it.requirement_links.filter((l) => !l.archived_at).map((l) => l.requirement_id));
      const pick = await pickerDialog({ title: `${it.wbs_code} ${it.title}에 요구사항 연결`, placeholder: '요구사항 번호 또는 제목 검색', withType: true,
        rows: requirements.map((r) => ({ ...r, disabled: linked.has(r.id) })), searchKeys: ['display_id', 'title'],
        render: (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span>${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}` });
      if (!pick) return;
      try { apply(await api('POST', wApi(`/${it.id}/links`), { requirement_id: pick.id, link_type: pick.link_type })); draw(); toast('요구사항을 연결했습니다.'); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    main.querySelectorAll('[data-rlink-type]').forEach((sl) => sl.onchange = async () => { try { apply(await api('PATCH', wApi(`/${it.id}/links/${sl.dataset.rlinkType}`), { link_type: sl.value })); draw(); } catch (e) { toast(e.message); } });
    main.querySelectorAll('[data-rlink-del]').forEach((b) => b.onclick = async () => {
      const l = it.requirement_links.find((x) => x.id === b.dataset.rlinkDel);
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: `${it.wbs_code} ${it.title}과 ${l.display_id}의 연결만 제거됩니다.`, confirm: '연결 해제', danger: true }))) return;
      try { apply(await api('DELETE', wApi(`/${it.id}/links/${l.id}`))); draw(); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const ab = $('#warchive');
    if (ab) ab.onclick = async () => {
      const kids = items.filter((x) => { let c = x; while (c && c.parent_id) { if (c.parent_id === it.id) return true; c = byId().get(c.parent_id); } return false; }).length;
      const ok = await confirmDialog({ title: `${it.wbs_code} ${it.title} 항목을 보관할까요?`,
        body: raw(html`${raw(kids ? html`<p style="margin-bottom:10px"><b>이 항목에는 ${kids}개의 하위 WBS가 있습니다.</b> 하위 항목도 함께 보관됩니다.</p>` : '')}보관된 항목은 목록과 Gantt에서 숨겨지고 WBS 번호가 다시 매겨집니다. 선행 관계는 기록으로 남습니다.`), confirm: kids ? '하위 항목 포함 보관' : '보관하기', danger: true });
      if (!ok) return;
      try { const r = await api('POST', wApi(`/${it.id}/archive`), {}); items = r.items; summary = r.summary; sel = null; setParam('sel', ''); toast('항목을 보관했습니다.'); draw(); } catch (e) { toast(e.message); }
    };
  };

  await load();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
  if (creating) { const t = $('#c-title'); if (t) t.focus(); }
}

