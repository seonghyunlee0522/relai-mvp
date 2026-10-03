import { api, wsApi } from '../core/api.js';
import { $, fmtDays, fmtKRW, fmtMD, fmtShort, html, raw, todayLocal } from '../core/dom.js';
import { projectHead } from '../project/guide.js';
import { CR_PRIORITY, CR_STATUS, CR_STATUS_CHIP, IMPACT_TYPE, RELATION_TYPE, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE } from '../shared/constants.js';
import { confirmDialog, pickerDialog, promptDialog, showErrors, toast } from '../shared/dialogs.js';
import { aiStatus } from '../shared/ai.js';
import { openImpactDialog } from '../ai/impact.js';
import { statusChip, prText } from '../shared/badges.js';
import { appliedFilters, bindFilterClears, filterSelect } from '../shared/filters.js';
import { emptyFiltered, emptyState } from '../shared/empty-state.js';
import { bindCoach, coachMark } from '../onboarding/ui.js';
import { drawerFoot, drawerHead, bindEscape } from '../shared/drawer.js';
import { bindDtabs, dtabs } from '../shared/detail.js';

export async function changesPage(id) {
  const main = $('#main');
  const [g, ai] = await Promise.all([api('GET', wsApi(`/${id}`)), aiStatus(id)]);
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  document.title = `Changes — ${p.name} — RELAI`;
  const cApi = (s = '') => wsApi(`/${id}/changes${s}`);
  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };
  const filterKeys = ['status', 'priority', 'requester', 'requirement', 'wbs', 'schedule', 'cost'];
  const FILTER_DEFS = [{ key: 'q', label: '검색' }, { key: 'status', label: 'Status', map: CR_STATUS }, { key: 'priority', label: 'Priority', map: CR_PRIORITY }, { key: 'requester', label: '요청자' },
    { key: 'requirement', label: '관련 요구사항', format: (v) => { const r = (reqOptions || []).find((x) => x.id === v); return r ? `${r.display_id} ${r.title}` : '선택됨'; } }, { key: 'wbs', label: '영향 WBS', format: () => '선택됨' },
    { key: 'schedule', label: '일정 영향', format: () => '있음' }, { key: 'cost', label: '비용 영향', format: () => '있음' }, { key: 'archived', label: '보관 포함', format: () => '예' }];
  const listQuery = () => { const q = params(); const out = new URLSearchParams(); for (const k of ['q', ...filterKeys]) if (q.get(k)) out.set(k, q.get(k)); if (q.get('archived')) out.set('include_archived', '1'); return out.toString() ? '?' + out : ''; };

  let rows = []; let summary = g.changes; let requesters = []; let sel = null; let creating = params().get('new') === '1'; let dtab = 'info';
  let reqOptions = null; // lazily loaded requirement list for the filter + picker
  const load = async () => { const d = await api('GET', cApi(listQuery())); rows = d.changes; summary = d.summary; requesters = d.requesters; g.changes = summary; };
  const loadSel = async (cid) => { sel = cid ? (await api('GET', cApi(`/${cid}`))).change : null; setParam('sel', cid); };
  const loadReqs = async () => { if (!reqOptions) reqOptions = (await api('GET', wsApi(`/${id}/requirements`))).requirements; return reqOptions; };
  const opt = (map, cur, blank) => (blank ? html`<option value="">${blank}</option>` : '') + Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');

  const draw = () => {
    const q = params();
    const hasFilter = ['q', ...filterKeys, 'archived'].some((k) => q.get(k));
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'changes' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 변경 요청은 조회만 할 수 있습니다.</div>' : '')}
      ${raw(coachMark('CHANGE_REQUEST_INTRO'))}
      <div class="summary summary--inline" style="margin-bottom:8px">
        <div><b>${summary.total}</b><span>전체 변경 요청</span></div>
        <div class="${summary.under_review ? 'is-warn' : ''}"><b>${summary.under_review}</b><span>검토 중</span></div>
        <div class="${summary.approved_unimplemented ? 'is-warn' : ''}"><b>${summary.approved_unimplemented}</b><span>승인 후 미반영</span></div>
        <div><b>${fmtDays(summary.approved_schedule_days)}</b><span>승인 변경 일정 영향 <small>(입력 기준)</small></span></div>
      </div>
      <div class="rtool">
        <input class="input input--sm" id="q" type="search" placeholder="ID, 제목, 설명, 요청자 검색" value="${q.get('q') || ''}">
        ${raw(filterSelect('status', 'Status', CR_STATUS, q.get('status')))}
        ${raw(filterSelect('priority', 'Priority', CR_PRIORITY, q.get('priority')))}
        <select class="select select--sm" data-f="requester"><option value="">요청자: 전체</option>${raw(requesters.map((r) => html`<option value="${r}" ${q.get('requester') === r ? 'selected' : ''}>${r}</option>`).join(''))}</select>
        <select class="select select--sm" data-f="requirement" id="f-req"><option value="">관련 요구사항: 전체</option>${raw((reqOptions || []).map((r) => html`<option value="${r.id}" ${q.get('requirement') === r.id ? 'selected' : ''}>${r.display_id} ${r.title}</option>`).join(''))}${raw(!reqOptions && q.get('requirement') ? html`<option value="${q.get('requirement')}" selected>선택됨</option>` : '')}</select>
        <label class="toggle"><input type="checkbox" data-t="schedule" ${q.get('schedule') ? 'checked' : ''}> 일정 영향 있음</label>
        <label class="toggle"><input type="checkbox" data-t="cost" ${q.get('cost') ? 'checked' : ''}> 비용 영향 있음</label>
        <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>
        <span class="rtool__sp"></span>
        ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ 변경 요청</button>')}
      </div>
      ${raw(appliedFilters(q, FILTER_DEFS))}
      <div class="rlayout rlayout--cr ${sel || creating ? 'has-drawer' : ''}">
        <div class="rtable-wrap">${raw(rows.length ? html`<table class="rtable rtable--cr">
          <thead><tr><th>ID</th><th>제목</th><th>Status</th><th>Priority</th><th>요청자</th><th class="num">관련 Req</th><th class="num">일정 영향</th><th class="num">비용 영향</th><th>Updated</th></tr></thead>
          <tbody>${raw(rows.map((c) => html`<tr class="${sel && sel.id === c.id ? 'is-sel' : ''} ${c.archived_at ? 'is-arch' : ''}" data-row="${c.id}">
            <td class="mono">${c.display_id}</td>
            <td class="ttl"><span>${c.title}</span>${raw(c.impact_count ? html`<small title="영향 WBS ${c.impact_count}개">WBS ${c.impact_count}</small>` : '')}${raw(c.archived_at ? '<small>보관됨</small>' : '')}</td>
            <td>${raw(statusChip(CR_STATUS, CR_STATUS_CHIP, c.status))}</td>
            <td>${raw(prText(c.priority, CR_PRIORITY))}</td>
            <td>${c.requester_organization || c.requester_name || raw('<span class="dim">-</span>')}${raw(c.requester_organization && c.requester_name ? html`<small class="dim" style="margin-left:6px">${c.requester_name}</small>` : '')}</td>
            <td class="num">${c.requirement_count || raw('<span class="dim">0</span>')}</td>
            <td class="num">${c.schedule_impact_days ? fmtDays(c.schedule_impact_days) : raw('<span class="dim">-</span>')}</td>
            <td class="num">${c.cost_impact ? fmtKRW(c.cost_impact) : raw('<span class="dim">-</span>')}</td>
            <td class="dim">${fmtShort(c.updated_at)}</td></tr>`).join(''))}</tbody></table>`
          : hasFilter ? emptyFiltered('변경 요청')
          : emptyState({ title: '아직 등록된 변경 요청이 없습니다.', body: '프로젝트 진행 중 들어오는 추가·변경 요청을 기록하면 영향 요구사항과 WBS, 일정·비용 영향을 함께 관리할 수 있습니다.', cta: archived ? null : { id: 'add2', label: '첫 변경 요청 등록' } }))}</div>
        <aside class="drawer drawer--cr" id="drawer" ${sel || creating ? '' : 'hidden'}>${raw(creating ? drawerCreate() : sel ? drawerDetail() : '')}</aside>
      </div>
    </div>`;
    bind(); bindCoach(main);
  };

  const drawerCreate = () => html`<form id="cf" novalidate>
    <div class="drawer__h"><b>새 변경 요청</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b">
      <div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: MFA 인증 추가"><div class="err" data-for="title"></div></div>
      <div class="field"><label for="c-desc">설명</label><textarea class="textarea" id="c-desc" name="description" maxlength="5000" style="min-height:72px" placeholder="어떤 변경을 요청받았는지 적어주세요."></textarea></div>
      <div class="field"><label for="c-reason">요청 사유</label><textarea class="textarea" id="c-reason" name="reason" maxlength="2000" style="min-height:60px" placeholder="왜 필요한지"></textarea></div>
      <div class="row2">
        <div class="field"><label>요청자</label><input class="input" name="requester_name" maxlength="100" placeholder="예: 김OO 책임"></div>
        <div class="field"><label>요청자 조직</label><input class="input" name="requester_organization" maxlength="100" placeholder="예: A사 보안팀"></div>
        <div class="field"><label>Priority</label><select class="select" name="priority">${raw(opt(CR_PRIORITY, 'MEDIUM'))}</select></div>
        <div class="field"><label>요청일</label><input class="input" type="date" name="requested_at" value="${todayLocal()}"></div>
      </div>
      <div class="field"><span class="lbl">관련 요구사항</span><div id="c-reqs" class="crit-pending-list"></div><div class="actions" style="margin-top:6px"><button type="button" class="btn btn--secondary btn--sm" id="c-req-add">+ 요구사항 연결</button></div></div>
    </div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">변경 요청 등록</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;

  const impactSummary = (c) => {
    const liveReq = c.requirements.filter((x) => !x.archived_at).length; const liveImp = c.impacts.filter((x) => !x.archived_at).length;
    return html`<div class="impact"><div><b>${liveReq}</b><span>영향 요구사항</span></div><div><b>${liveImp}</b><span>영향 WBS</span></div>
      <div><b>${fmtDays(c.schedule_impact_days)}</b><span>일정 영향</span></div><div><b>${fmtMD(c.effort_impact_md)}</b><span>추가 공수</span></div><div><b>${fmtKRW(c.cost_impact)}</b><span>비용 영향</span></div></div>`;
  };

  const drawerDetail = () => {
    const c = sel; const ro = archived || Boolean(c.archived_at); const st = c.status;
    const liveReq = c.requirements.filter((x) => !x.archived_at); const archReq = c.requirements.length - liveReq.length;
    const liveImp = c.impacts.filter((x) => !x.archived_at); const archImp = c.impacts.length - liveImp.length;
    const fieldsRo = ro || st === 'IMPLEMENTED' || st === 'REJECTED';
    const decision = () => {
      if (st === 'DRAFT') return html`<div class="decision"><p>작성 중인 변경 요청입니다. 내용과 영향을 정리한 뒤 검토를 요청하세요.</p>${raw(ro ? '' : '<button class="btn btn--primary" data-tr="submit">검토 요청</button>')}</div>`;
      if (st === 'UNDER_REVIEW') return html`<div class="decision decision--review"><p><b>검토 중인 변경 요청입니다.</b> ${c.submitted_at ? fmtShort(c.submitted_at) + ' 검토 요청' : ''}</p>
        ${raw(ro ? '' : html`<div class="actions" style="margin-top:0"><button class="btn btn--primary" data-tr="approve">승인</button><button class="btn btn--danger" data-tr="reject">반려</button></div>`)}</div>`;
      if (st === 'APPROVED') {
        const firstReq = liveReq[0]; const firstImp = liveImp[0];
        return html`<div class="decision decision--ok"><p><b>승인된 변경사항입니다.</b> ${c.reviewed_by_name || ''} · ${c.approved_at ? fmtShort(c.approved_at) : ''}${c.decision_note ? raw(html`<br><q>${c.decision_note}</q>`) : ''}</p>
        <p class="decision__targets"><span>반영 대상</span>
          <a href="/app/projects/${p.id}/requirements?cr=${c.id}${firstReq ? '&sel=' + firstReq.requirement_id : ''}" data-link>관련 Requirement <b>${liveReq.length}</b></a>
          <a href="/app/projects/${p.id}/wbs?cr=${c.id}${firstImp ? '&sel=' + firstImp.wbs_item_id : ''}" data-link>영향 WBS <b>${liveImp.length}</b></a></p>
        <p>각 화면에서 직접 반영하세요. 요구사항 수정은 이 변경 요청을 출처로 History에 남습니다. 반영이 끝나면 '반영 완료'로 처리하세요.</p>
        <div class="actions" style="margin-top:0"><a class="btn btn--secondary btn--sm" href="/app/projects/${p.id}/requirements?cr=${c.id}${firstReq ? '&sel=' + firstReq.requirement_id : ''}" data-link>요구사항에서 반영</a><a class="btn btn--secondary btn--sm" href="/app/projects/${p.id}/wbs?cr=${c.id}${firstImp ? '&sel=' + firstImp.wbs_item_id : ''}" data-link>WBS에서 반영</a>${raw(ro ? '' : '<button class="btn btn--primary btn--sm" data-tr="implement">반영 완료</button>')}</div></div>`;
      }
      if (st === 'IMPLEMENTED') return html`<div class="decision decision--ok"><p><b>반영 완료된 변경 요청입니다.</b> ${c.implemented_at ? fmtShort(c.implemented_at) + ' 반영' : ''} · 승인 ${c.reviewed_by_name || ''} ${c.approved_at ? fmtShort(c.approved_at) : ''}${c.decision_note ? raw(html`<br><q>${c.decision_note}</q>`) : ''}</p></div>`;
      return html`<div class="decision decision--no"><p><b>반려된 변경 요청입니다.</b> ${c.reviewed_by_name || ''} · ${c.rejected_at ? fmtShort(c.rejected_at) : ''}${c.decision_note ? raw(html`<br><q>${c.decision_note}</q>`) : ''}</p></div>`;
    };
    const histText = (h) => {
      switch (h.action_type) {
        case 'CREATED': return html`<b>${c.display_id}</b> 생성 <small>${h.changed_by_name || ''}</small>`;
        case 'ARCHIVED': return html`보관 처리 <small>${h.changed_by_name || ''}</small>`;
        case 'STATUS_CHANGED': return html`<b>${CR_STATUS[h.old_value] || h.old_value}</b> → <b>${CR_STATUS[h.new_value] || h.new_value}</b> <small>${h.changed_by_name || ''}</small>`;
        case 'REQUIREMENT_LINKED': return html`요구사항 연결 <q>${lt(h.new_value)}</q>`;
        case 'REQUIREMENT_UNLINKED': return html`요구사항 연결 해제 <q>${h.old_value}</q>`;
        case 'WBS_IMPACT_ADDED': return html`영향 WBS 추가 <q>${lt(h.new_value)}</q>`;
        case 'WBS_IMPACT_UPDATED': return html`영향 유형 변경 <q>${lt(h.old_value)}</q> → <q>${lt(h.new_value)}</q>`;
        case 'WBS_IMPACT_REMOVED': return html`영향 WBS 제거 <q>${h.old_value}</q>`;
        default: { const f = h.field_name; const L = { title: '제목', priority: 'Priority', requester_name: '요청자', requester_organization: '요청자 조직', requested_at: '요청일', schedule_impact_days: '일정 영향', effort_impact_md: '공수 영향', cost_impact: '비용 영향', relation_type: '관계 유형' };
          const v = (x) => (x === null ? '-' : f === 'priority' ? CR_PRIORITY[x] || x : f === 'relation_type' ? lt(x) : x);
          return html`<b>${L[f] || f}</b> ${v(h.old_value)} → ${v(h.new_value)} <small>${h.changed_by_name || ''}</small>`; }
      }
    };
    return html`${raw(drawerHead(c.display_id, statusChip(CR_STATUS, CR_STATUS_CHIP, st), { archived: Boolean(c.archived_at) }))}
    ${raw(dtabs([{ key: 'info', label: '업무정보' }, { key: 'links', label: '영향 범위', count: liveReq.length + liveImp.length }, { key: 'hist', label: '변경 이력', count: c.history.length }], dtab))}
    <div class="drawer__b"><section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
      <input class="dtitle" data-field="title" value="${c.title}" maxlength="200" ${fieldsRo ? 'disabled' : ''} aria-label="제목">
      ${raw(decision())}
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${fieldsRo ? 'disabled' : ''}>${c.description}</textarea>
      <div class="dgrid">
        <div class="dfield" style="grid-column:1/-1"><span>요청 사유</span><div><textarea class="textarea" data-field="reason" maxlength="2000" style="min-height:56px;font-size:14px" placeholder="요청 사유" ${fieldsRo ? 'disabled' : ''}>${c.reason}</textarea></div></div>
        <div class="dfield"><span>요청자</span><div><input class="input input--sm" data-field="requester_name" value="${c.requester_name}" maxlength="100" placeholder="이름" ${fieldsRo ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>요청자 조직</span><div><input class="input input--sm" data-field="requester_organization" value="${c.requester_organization}" maxlength="100" placeholder="조직" ${fieldsRo ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>Priority</span><div><select class="select select--sm" data-field="priority" ${fieldsRo ? 'disabled' : ''}>${raw(opt(CR_PRIORITY, c.priority))}</select></div></div>
        <div class="dfield"><span>요청일</span><div><input class="input input--sm" type="date" data-field="requested_at" value="${c.requested_at || ''}" ${fieldsRo ? 'disabled' : ''}></div></div>
      </div>
      <div class="dsave" id="dsave"></div>

      <h4 class="dh">영향 요약${raw(ai.enabled && !ro ? '<button type="button" class="btn btn--secondary btn--sm btn--ai" id="ai-impact" style="margin-left:auto" title="연결 관계·테스트·Risk를 바탕으로 영향 후보 분석">AI 영향 분석</button>' : '')}</h4>
      ${raw(impactSummary(c))}
      <div class="dgrid dgrid--3">
        <div class="dfield"><span>일정 영향 (일)</span><div><input class="input input--sm" type="number" min="0" step="1" data-field="schedule_impact_days" value="${c.schedule_impact_days ?? ''}" placeholder="0" ${fieldsRo ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>추가 공수 (MD)</span><div><input class="input input--sm" type="number" min="0" step="0.5" data-field="effort_impact_md" value="${c.effort_impact_md ?? ''}" placeholder="0" ${fieldsRo ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>비용 영향 (₩)</span><div><input class="input input--sm" type="number" min="0" step="1000" data-field="cost_impact" value="${c.cost_impact ?? ''}" placeholder="0" ${fieldsRo ? 'disabled' : ''}></div></div>
      </div>

      </section>
      <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>
      <h4 class="dh">관련 요구사항 <em>${liveReq.length}</em></h4>
      ${raw(liveReq.length ? html`<ol class="crit links">${raw(liveReq.map((x) => html`<li>
        <span class="mono">${x.display_id}</span><span class="crit__in" style="padding:6px 4px">${x.title}<small class="dim" style="margin-left:6px">${REQ_SCOPE[x.scope]} · ${REQ_STATUS[x.status]}</small></span>
        ${raw(ro ? html`<span class="chip chip--muted">${RELATION_TYPE[x.relation_type]}</span>` : html`<select class="select select--xs" data-rel="${x.id}">${raw(opt(RELATION_TYPE, x.relation_type))}</select><span class="crit__act" style="opacity:1"><button data-rel-del="${x.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>`
        : html`<div class="empty-inline"><b>연결된 요구사항이 없습니다.</b><span>이 변경이 어떤 요구사항을 바꾸거나 추가하는지 연결하세요.</span></div>`)}
      ${raw(archReq ? html`<p class="hint">보관된 요구사항 ${archReq}건 연결은 기록으로만 남아 있습니다.</p>` : '')}
      ${raw(ro ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="req-add">+ 요구사항 연결</button></div>`)}

      <h4 class="dh">영향 WBS <em>${liveImp.length}</em></h4>
      ${raw(c.wbs_candidates.length && !ro ? html`<div class="cand"><div class="cand__h">연결된 요구사항과 관련된 WBS ${c.wbs_candidates.length}개가 있습니다. 실제로 영향받는 항목을 선택하세요.</div>
        ${raw(c.wbs_candidates.map((w) => html`<div class="cand__row"><span class="mono wcode">${w.wbs_code}</span><span class="pick__t">${w.title}<small class="dim" style="margin-left:6px">${WBS_TYPE[w.item_type]}${w.owner_name ? ' · ' + w.owner_name : ''} · via ${w.via}</small></span>
          <select class="select select--xs" data-cand-type="${w.wbs_item_id}">${raw(opt(IMPACT_TYPE, 'SCHEDULE'))}</select><button class="btn btn--secondary btn--sm" data-cand-add="${w.wbs_item_id}">영향에 추가</button></div>`).join(''))}</div>` : '')}
      ${raw(liveImp.length ? html`<ol class="crit links impacts">${raw(liveImp.map((x) => html`<li>
        <span class="mono wcode">${x.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${x.title}<small class="dim" style="margin-left:6px">${WBS_TYPE[x.item_type]} · ${WBS_STATUS[x.status]}</small></span>
        ${raw(ro ? html`<span class="chip chip--muted">${IMPACT_TYPE[x.impact_type]}</span>` : html`<select class="select select--xs" data-imp-type="${x.id}">${raw(opt(IMPACT_TYPE, x.impact_type))}</select><span class="crit__act" style="opacity:1"><button data-imp-del="${x.id}" title="제거">×</button></span>`)}
        <input class="imp-note" data-imp-note="${x.id}" value="${x.impact_note}" maxlength="1000" placeholder="영향 메모" ${ro ? 'disabled' : ''}></li>`).join(''))}</ol>`
        : (c.wbs_candidates.length && !ro ? '' : html`<div class="empty-inline"><b>영향 WBS가 없습니다.</b><span>${liveReq.length ? '연결된 요구사항에 WBS가 연결되어 있지 않습니다. 영향받는 WBS를 직접 추가하세요.' : '요구사항을 먼저 연결하면 관련 WBS 후보를 보여드립니다.'}</span></div>`))}
      ${raw(archImp ? html`<p class="hint">보관된 WBS ${archImp}건 영향은 기록으로만 남아 있습니다.</p>` : '')}
      ${raw(ro ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="imp-add">+ WBS 직접 추가</button></div>`)}
      </section>
      <section data-pane="hist" ${dtab === 'hist' ? '' : 'hidden'}>${raw(c.history.length ? html`<ol class="hist">${raw(c.history.map((h) => html`<li><time>${fmtShort(h.changed_at)}</time><span>${raw(histText(h))}</span></li>`).join(''))}</ol>` : '<p class="hint">변경 이력이 없습니다.</p>')}</section>
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(c.created_at)} · ${c.created_by_name || ''}`, label: '변경 요청 보관', id: 'carchive' }))}`;
  };
  const lt = (v) => String(v || '').replace(/\b(MODIFIES|ADDS|REMOVES|SCHEDULE|SCOPE|REWORK|NEW_WORK|NONE)\b/g, (m) => RELATION_TYPE[m] || IMPACT_TYPE[m] || m);

  const pickRequirement = async (excludeIds) => {
    const reqs = (await loadReqs()).filter((r) => !r.archived_at);
    return pickerDialog({ title: '요구사항 연결', placeholder: '요구사항 번호 또는 제목 검색', types: RELATION_TYPE, typeLabel: '관계 유형',
      rows: reqs.map((r) => ({ ...r, disabled: excludeIds.has(r.id) })), searchKeys: ['display_id', 'title'],
      render: (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span>${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}` });
  };

  const bind = () => {
    const qi = $('#q'); let qt;
    if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { setParam('q', qi.value.trim()); await load(); draw(); $('#q').focus(); $('#q').setSelectionRange(99, 99); }, 350); };
    main.querySelectorAll('[data-f]').forEach((sl) => sl.onchange = async () => { setParam(sl.dataset.f, sl.value); await load(); draw(); });
    main.querySelectorAll('[data-t]').forEach((cb) => cb.onchange = async () => { setParam(cb.dataset.t, cb.checked ? '1' : ''); await load(); draw(); });
    const fr = $('#f-req'); if (fr && !reqOptions) fr.onfocus = async () => { await loadReqs(); draw(); };
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };
    bindFilterClears(main, { setParam, keys: ['q', ...filterKeys, 'archived'], reload: async () => { await load(); draw(); } });
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); draw(); $('#c-title').focus(); }; }
    main.querySelectorAll('[data-row]').forEach((tr) => tr.onclick = async () => { creating = false; dtab = 'info'; setParam('new', ''); await loadSel(tr.dataset.row); draw(); });
    const close = () => { creating = false; sel = null; setParam('sel', ''); setParam('new', ''); draw(); };
    for (const idc of ['dclose', 'dcancel']) { const b = $('#' + idc); if (b) b.onclick = close; }
    bindEscape(() => { if (sel || creating) close(); });
    if (creating) bindCreate(); else if (sel) bindDetail();
  };

  const bindCreate = () => {
    const form = $('#cf'); const picked = []; const list = $('#c-reqs');
    const drawPicked = () => { list.innerHTML = picked.map((r, i) => html`<div class="crit-pending"><span class="mono">${r.display_id}</span><span>${r.title}</span><span class="chip chip--muted">${RELATION_TYPE[r.relation_type]}</span><button type="button" data-rm="${i}" aria-label="삭제">×</button></div>`).join(''); list.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { picked.splice(Number(b.dataset.rm), 1); drawPicked(); }); };
    $('#c-req-add').onclick = async () => { const pk = await pickRequirement(new Set(picked.map((r) => r.id))); if (!pk) return; const r = reqOptions.find((x) => x.id === pk.id); picked.push({ ...r, relation_type: pk.link_type }); drawPicked(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '제목을 입력해 주세요.' });
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try {
        const r = await api('POST', cApi(), { ...d, requirements: picked.map((x) => ({ requirement_id: x.id, relation_type: x.relation_type })) });
        toast(`${r.change.display_id} 변경 요청을 등록했습니다.`); creating = false; setParam('new', ''); sel = r.change; setParam('sel', r.change.id); await load(); draw();
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    };
  };

  const bindDetail = () => {
    const c = sel; const status = $('#dsave');
    bindDtabs(main.querySelector('.drawer'), (k) => { dtab = k; });
    const apply = async (d) => { sel = d.change; summary = d.summary; g.changes = summary; await load(); draw(); };
    const ai1 = $('#ai-impact'); if (ai1) ai1.onclick = () => openImpactDialog({ pid: id, change: c, onDone: apply });
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { const d = await api('PATCH', cApi(`/${c.id}`), { [field]: value }); await apply(d); $('#dsave').textContent = d.changed.length ? '저장됨' : ''; }
      catch (e) { status.textContent = e.fields ? Object.values(e.fields)[0] : e.message; toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    main.querySelectorAll('.drawer [data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT' || el.type === 'date') el.onchange = () => save(field, el.value);
      else {
        el.onblur = () => { const v = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim(); if (String(v ?? '') !== String(c[field] ?? '')) save(field, v); };
        if (el.tagName !== 'TEXTAREA') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); };
      }
    });
    const act = async (method, path, body) => { try { await apply(await api(method, cApi(`/${c.id}${path}`), body)); return true; } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); return false; } };
    main.querySelectorAll('[data-tr]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.tr;
      if (a === 'submit') { if (await act('POST', '/transition', { action: 'submit' })) toast('검토를 요청했습니다.'); return; }
      if (a === 'approve') {
        const missing = c.schedule_impact_days === null && c.effort_impact_md === null;
        const note = await promptDialog({ title: `${c.display_id} 승인`, body: missing ? '<b>일정/공수 영향이 입력되지 않았습니다.</b> 그래도 승인하시겠습니까?' : '', label: '결정 메모', placeholder: '승인 조건이나 비고', confirm: '승인' });
        if (note === null) return; if (await act('POST', '/transition', { action: 'approve', decision_note: note })) toast('승인했습니다.'); return;
      }
      if (a === 'reject') { const note = await promptDialog({ title: `${c.display_id} 반려`, label: '반려 사유', required: true, confirm: '반려', danger: true }); if (note === null) return; if (await act('POST', '/transition', { action: 'reject', decision_note: note })) toast('반려했습니다.'); return; }
      if (a === 'implement') {
        if (!(await confirmDialog({ title: '이 변경 요청이 실제 프로젝트에 반영되었나요?', body: '관련 요구사항과 WBS의 수정 여부를 확인해주세요. 요구사항이나 WBS가 자동으로 바뀌지는 않습니다.', confirm: '반영 완료' }))) return;
        if (await act('POST', '/transition', { action: 'implement' })) toast('반영 완료로 처리했습니다.');
      }
    });
    const ra = $('#req-add'); if (ra) ra.onclick = async () => { const pk = await pickRequirement(new Set(c.requirements.filter((x) => !x.archived_at).map((x) => x.requirement_id))); if (!pk) return; if (await act('POST', '/requirements', { requirement_id: pk.id, relation_type: pk.link_type })) toast('요구사항을 연결했습니다.'); };
    main.querySelectorAll('[data-rel]').forEach((sl) => sl.onchange = () => act('PATCH', `/requirements/${sl.dataset.rel}`, { relation_type: sl.value }));
    main.querySelectorAll('[data-rel-del]').forEach((b) => b.onclick = async () => { const x = c.requirements.find((y) => y.id === b.dataset.relDel); if (!(await confirmDialog({ title: '연결을 해제할까요?', body: `${c.display_id}과 ${x.display_id}의 연결만 제거됩니다.`, confirm: '연결 해제', danger: true }))) return; if (await act('DELETE', `/requirements/${x.id}`)) toast('연결을 해제했습니다.'); });
    main.querySelectorAll('[data-cand-add]').forEach((b) => b.onclick = async () => { const wid = b.dataset.candAdd; const type = main.querySelector(`[data-cand-type="${wid}"]`).value; if (await act('POST', '/impacts', { wbs_item_id: wid, impact_type: type })) toast('영향 WBS에 추가했습니다.'); });
    const ia = $('#imp-add'); if (ia) ia.onclick = async () => {
      const { items } = await api('GET', wsApi(`/${id}/wbs`));
      const have = new Set(c.impacts.filter((x) => !x.archived_at).map((x) => x.wbs_item_id));
      const pk = await pickerDialog({ title: '영향 WBS 추가', placeholder: 'WBS 번호 또는 업무명 검색', types: IMPACT_TYPE, typeLabel: '영향 유형', confirm: '추가',
        rows: items.map((w) => ({ ...w, disabled: have.has(w.id) })), searchKeys: ['wbs_code', 'title'],
        render: (w) => html`<span class="mono wcode">${w.wbs_code}</span><span class="pick__t" style="padding-left:${w.depth * 14}px">${w.title}</span><small class="dim">${WBS_TYPE[w.item_type]}</small><span class="chip ${WBS_STATUS_CHIP[w.status] || ''}">${WBS_STATUS[w.status]}</span>${raw(w.disabled ? '<small class="dim">등록됨</small>' : '')}` });
      if (!pk) return; if (await act('POST', '/impacts', { wbs_item_id: pk.id, impact_type: pk.link_type })) toast('영향 WBS에 추가했습니다.');
    };
    main.querySelectorAll('[data-imp-type]').forEach((sl) => sl.onchange = () => act('PATCH', `/impacts/${sl.dataset.impType}`, { impact_type: sl.value }));
    main.querySelectorAll('[data-imp-note]').forEach((inp) => { const x = c.impacts.find((y) => y.id === inp.dataset.impNote); inp.onblur = () => { if (inp.value.trim() !== x.impact_note) act('PATCH', `/impacts/${x.id}`, { impact_note: inp.value }); }; inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); }; });
    main.querySelectorAll('[data-imp-del]').forEach((b) => b.onclick = () => act('DELETE', `/impacts/${b.dataset.impDel}`));
    const ab = $('#carchive');
    if (ab) ab.onclick = async () => {
      if (!(await confirmDialog({ title: `${c.display_id}을 보관할까요?`, body: '보관된 변경 요청은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않으며 요구사항·WBS 연결은 기록으로 보존됩니다.', confirm: '보관하기', danger: true }))) return;
      if (await act('POST', '/archive', {})) toast(`${c.display_id}을 보관했습니다.`);
    };
  };

  await load();
  if (params().get('requirement')) await loadReqs();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
  if (creating) { const t = $('#c-title'); if (t) t.focus(); }
}

