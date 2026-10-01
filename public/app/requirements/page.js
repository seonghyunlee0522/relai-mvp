import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { projectHead } from '../project/guide.js';
import { resBadge, statusChip, subtle, prText, verifyChip } from '../shared/badges.js';
import { appliedFilters, bindFilterClears, filterSelect } from '../shared/filters.js';
import { emptyFiltered, emptyState } from '../shared/empty-state.js';
import { drawerFoot, drawerHead, bindEscape } from '../shared/drawer.js';
import { traceStrip } from '../shared/trace-strip.js';
import { ACC_STATUS, LINK_TYPE, REQ_FIELD_LABEL, REQ_PRIORITY, REQ_SCOPE, REQ_STATUS, REQ_STATUS_CHIP, REQ_TYPE, TC_STATUS, TC_STATUS_CHIP, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE, testSummaryText } from '../shared/constants.js';
import { confirmDialog, pickerDialog, showErrors, toast } from '../shared/dialogs.js';

export async function requirementsPage(id) {
  const main = $('#main');
  const g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  const { members } = await api('GET', `/api/workspaces/${state.workspace.id}/members`);
  document.title = `Requirements — ${p.name} — RELAI`;
  const rApi = (s = '') => wsApi(`/${id}/requirements${s}`);

  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };
  const filterKeys = ['type', 'priority', 'scope', 'status', 'owner', 'link'];
  const rview = () => (params().get('view') === 'trace' ? 'trace' : 'list');
  const listQuery = () => { const q = params(); const out = new URLSearchParams(); for (const k of ['q', ...filterKeys]) if (q.get(k)) out.set(k, q.get(k)); if (q.get('archived')) out.set('include_archived', '1'); return out.toString() ? '?' + out : ''; };

  let rows = []; let summary = g.requirements; let sel = null; let creating = params().get('new') === '1';
  // B-2: arrived from an approved Change Request → edits are recorded with that CR as history source.
  let ctxCr = null;
  if (params().get('cr')) { try { ctxCr = (await api('GET', wsApi(`/${id}/changes/${params().get('cr')}`))).change; } catch { setParam('cr', ''); } }
  const load = async () => { const d = await api('GET', rApi(listQuery())); rows = d.requirements; summary = d.summary; };
  const loadSel = async (rid) => { sel = rid ? (await api('GET', rApi(`/${rid}`))).requirement : null; setParam('sel', rid); };

  const opt = (map, cur, { blank } = {}) => (blank ? html`<option value="">${blank}</option>` : '') + Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const ownerOpts = (cur) => html`<option value="">미지정</option>` + members.map((m) => html`<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>${m.name}</option>`).join('');
  const ownerMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const LINK_F = { linked: 'WBS 연결됨', unlinked: 'WBS 미연결' };
  const FILTER_DEFS = [{ key: 'q', label: '검색' }, { key: 'status', label: 'Status', map: REQ_STATUS }, { key: 'scope', label: 'Scope', map: REQ_SCOPE }, { key: 'owner', label: 'Owner', map: { ...ownerMap, none: '미지정' } },
    { key: 'type', label: '유형', map: REQ_TYPE }, { key: 'priority', label: 'Priority', map: REQ_PRIORITY }, { key: 'link', label: '연결 상태', map: LINK_F }, { key: 'archived', label: '보관 포함', format: () => '예' }];

  const draw = () => {
    const q = params();
    const hasFilter = ['q', ...filterKeys, 'archived'].some((k) => q.get(k));
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'requirements' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 요구사항은 조회만 할 수 있습니다.</div>' : '')}
      ${raw(ctxCr ? html`<div class="ctx"><span><b>${ctxCr.display_id}</b> ${ctxCr.title}에서 이동했습니다. 이 화면에서 수정하는 내용은 해당 변경 요청을 출처로 History에 기록됩니다.</span><a class="link" href="/app/projects/${p.id}/changes?sel=${ctxCr.id}" data-link>변경 요청 보기</a><button class="linkbtn" id="ctx-off" type="button">컨텍스트 해제</button></div>` : '')}
      <div class="summary summary--4">
        <div><b>${summary.total}</b><span>전체 Requirement</span></div>
        <div><b>${summary.confirmed}</b><span>확정</span></div>
        <div class="${summary.scope_undecided ? 'is-warn' : ''}"><b>${summary.scope_undecided}</b><span>범위 미결정</span></div>
        <div class="${summary.in_scope_unlinked ? 'is-warn' : ''}"><b>${summary.in_scope_unlinked}</b><span>WBS 미연결 <small>(범위 내)</small></span></div>
      </div>
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
        ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="add">+ 요구사항 추가</button>')}
      </div>
      ${raw(appliedFilters(q, FILTER_DEFS))}
      <div class="rlayout ${sel || creating ? 'has-drawer' : ''}">
        <div class="rtable-wrap">${raw(rows.length ? (rview() === 'trace' ? html`<table class="rtable rtable--trace">
          <thead><tr><th>ID</th><th>제목</th><th>Status</th><th>Scope</th><th class="num">연결 WBS</th><th>연결 상태</th></tr></thead>
          <tbody>${raw(rows.map((r) => html`<tr class="${sel && sel.id === r.id ? 'is-sel' : ''} ${r.archived_at ? 'is-arch' : ''}" data-row="${r.id}">
            <td class="mono">${r.display_id}</td>
            <td class="ttl"><span>${r.title}</span>${raw(r.archived_at ? '<small>보관됨</small>' : '')}</td>
            <td>${raw(statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status))}</td>
            <td>${raw(subtle(REQ_SCOPE[r.scope]))}</td>
            <td class="num">${r.linked_wbs_count}</td>
            <td>${raw(r.linked_wbs_count ? '<span class="chip chip--done">연결됨</span>' : r.scope === 'IN_SCOPE' ? '<span class="chip chip--hold">미연결</span>' : '<span class="chip chip--muted">미연결</span>')}</td></tr>`).join(''))}</tbody></table>`
          : html`<table class="rtable">
          <thead><tr><th>ID</th><th>제목</th><th>유형</th><th>Priority</th><th>Scope</th><th>Status</th><th>Owner</th><th>Updated</th></tr></thead>
          <tbody>${raw(rows.map((r) => html`<tr class="${sel && sel.id === r.id ? 'is-sel' : ''} ${r.archived_at ? 'is-arch' : ''}" data-row="${r.id}">
            <td class="mono">${r.display_id}</td>
            <td class="ttl"><span>${r.title}</span>${raw(r.criteria_count ? html`<small title="완료 조건 ${r.criteria_count}개">AC ${r.criteria_count}</small>` : '')}${raw(r.linked_wbs_count ? html`<small title="연결된 WBS ${r.linked_wbs_count}개">WBS ${r.linked_wbs_count}</small>` : '')}${raw(r.archived_at ? '<small>보관됨</small>' : '')}</td>
            <td>${r.type === 'UNSPECIFIED' ? raw('<span class="dim">미지정</span>') : REQ_TYPE[r.type]}</td>
            <td>${r.priority === 'UNSPECIFIED' ? raw('<span class="dim">미지정</span>') : raw(prText(r.priority, REQ_PRIORITY))}</td>
            <td>${raw(subtle(REQ_SCOPE[r.scope]))}</td>
            <td>${raw(statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status))}</td>
            <td>${r.owner_name || raw('<span class="dim">-</span>')}</td>
            <td class="dim">${fmtShort(r.updated_at)}</td></tr>`).join(''))}</tbody></table>`)
          : hasFilter ? emptyFiltered('요구사항')
          : emptyState({ title: '아직 등록된 요구사항이 없습니다.', body: '프로젝트에서 해결해야 할 요구사항을 등록하세요. 이후 WBS, 테스트, 변경관리와 연결할 수 있습니다.', cta: archived ? null : { id: 'add2', label: '첫 요구사항 추가' } }))}</div>
        <aside class="drawer" id="drawer" ${sel || creating ? '' : 'hidden'}>${raw(creating ? drawerCreate() : sel ? drawerDetail() : '')}</aside>
      </div>
    </div>`;
    bind();
  };

  const fieldRow = (label, inner) => html`<div class="dfield"><span>${label}</span><div>${raw(inner)}</div></div>`;

  const drawerCreate = () => html`<form id="cf" novalidate>
    <div class="drawer__h"><b>새 요구사항</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b">
      <div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: SSO 로그인"><div class="err" data-for="title"></div></div>
      <div class="field"><label for="c-desc">설명</label><textarea class="textarea" id="c-desc" name="description" maxlength="5000" placeholder="요구사항의 배경과 내용을 적어주세요."></textarea></div>
      <div class="row2">
        <div class="field"><label>유형</label><select class="select" name="type">${raw(opt(REQ_TYPE, 'UNSPECIFIED'))}</select></div>
        <div class="field"><label>Priority</label><select class="select" name="priority">${raw(opt(REQ_PRIORITY, 'UNSPECIFIED'))}</select></div>
        <div class="field"><label>Scope</label><select class="select" name="scope">${raw(opt(REQ_SCOPE, 'UNDECIDED'))}</select></div>
        <div class="field"><label>Status</label><select class="select" name="status">${raw(opt(REQ_STATUS, 'DRAFT'))}</select></div>
        <div class="field"><label>요청자</label><input class="input" name="requester_name" maxlength="100" placeholder="예: 김OO 책임"></div>
        <div class="field"><label>요청자 소속</label><input class="input" name="requester_organization" maxlength="100" placeholder="예: A사 IT팀"></div>
      </div>
      <div class="field"><label>Owner</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select><div class="err" data-for="owner_user_id"></div></div>
      <div class="field"><label>완료 조건</label>
        <div id="c-crit"></div>
        <div class="crit-add"><input class="input input--sm" id="c-crit-in" maxlength="1000" placeholder="완료 조건을 입력하고 Enter"><button type="button" class="btn btn--secondary btn--sm" id="c-crit-add">추가</button></div></div>
    </div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">요구사항 추가</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;

  const drawerDetail = () => {
    const r = sel; const ro = archived || Boolean(r.archived_at);
    return html`${raw(drawerHead(r.display_id, statusChip(REQ_STATUS, REQ_STATUS_CHIP, r.status) + subtle(REQ_SCOPE[r.scope]), { archived: Boolean(r.archived_at) }))}
    <div class="drawer__b">
      <input class="dtitle" data-field="title" value="${r.title}" maxlength="200" ${ro ? 'disabled' : ''} aria-label="제목">
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${ro ? 'disabled' : ''}>${r.description}</textarea>
      <div class="dgrid">
        ${raw(fieldRow('유형', html`<select class="select select--sm" data-field="type" ${ro ? 'disabled' : ''}>${raw(opt(REQ_TYPE, r.type))}</select>`))}
        ${raw(fieldRow('Priority', html`<select class="select select--sm" data-field="priority" ${ro ? 'disabled' : ''}>${raw(opt(REQ_PRIORITY, r.priority))}</select>`))}
        ${raw(fieldRow('Scope', html`<select class="select select--sm" data-field="scope" ${ro ? 'disabled' : ''}>${raw(opt(REQ_SCOPE, r.scope))}</select>`))}
        ${raw(fieldRow('Status', html`<select class="select select--sm" data-field="status" ${ro ? 'disabled' : ''}>${raw(opt(REQ_STATUS, r.status))}</select>`))}
        ${raw(fieldRow('요청자', html`<input class="input input--sm" data-field="requester_name" value="${r.requester_name}" maxlength="100" placeholder="이름" ${ro ? 'disabled' : ''}>`))}
        ${raw(fieldRow('소속', html`<input class="input input--sm" data-field="requester_organization" value="${r.requester_organization}" maxlength="100" placeholder="소속" ${ro ? 'disabled' : ''}>`))}
        ${raw(fieldRow('Owner', html`<select class="select select--sm" data-field="owner_user_id" ${ro ? 'disabled' : ''}>${raw(ownerOpts(r.owner_user_id || ''))}</select>`))}
      </div>
      <div class="dsave" id="dsave"></div>
      ${raw(deliveryTrace(r))}

      <h4 class="dh">완료 조건 <em>${r.criteria.length}</em></h4>
      <ol class="crit">${raw(r.criteria.map((c, i) => html`<li data-crit="${c.id}">
        <span class="crit__n">${i + 1}</span>
        <input class="crit__in" value="${c.content}" maxlength="1000" ${ro ? 'disabled' : ''} data-crit-in="${c.id}">
        ${raw(ro ? '' : html`<span class="crit__act"><button data-crit-move="${c.id}" data-dir="-1" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button><button data-crit-move="${c.id}" data-dir="1" title="아래로" ${i === r.criteria.length - 1 ? 'disabled' : ''}>↓</button><button data-crit-del="${c.id}" title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
      ${raw(ro ? (r.criteria.length ? '' : '<p class="hint">등록된 완료 조건이 없습니다.</p>') : html`<div class="crit-add"><input class="input input--sm" id="crit-in" maxlength="1000" placeholder="완료 조건을 입력하고 Enter"><button class="btn btn--secondary btn--sm" id="crit-add">추가</button></div>`)}

      ${raw(linkSection(r, ro))}
      <h4 class="dh">관련 테스트 <em>${r.testing ? r.testing.tests.length : 0}</em>${raw(r.testing && r.testing.tests.length ? html`<span style="margin-left:auto">${raw(verifyChip(r.testing.summary.verification))}</span>` : '')}</h4>
      ${raw(r.testing && r.testing.tests.length ? html`<p class="hint" style="margin:-4px 0 8px">${testSummaryText(r.testing.summary)}</p><ol class="crit links">${raw(r.testing.tests.map((t) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${t.id}" data-link><span class="mono">${t.display_id}</span><span class="crit__in" style="padding:6px 4px">${t.title}</span><span class="chip ${TC_STATUS_CHIP[t.status] || ''}">${TC_STATUS[t.status]}</span>${raw(resBadge(t.last_result))}</a></li>`).join(''))}</ol>`
        : html`<p class="hint">아직 연결된 테스트가 없습니다.${raw(ro || r.scope !== 'IN_SCOPE' ? '' : html` <a class="link" href="/app/projects/${p.id}/tests?new=1&requirement=${r.id}" data-link>테스트 추가</a>`)}</p>`)}
      ${raw(r.acceptances && r.acceptances.length ? html`<p class="raidline">${raw(r.acceptances.map((a) => html`<a href="/app/projects/${p.id}/tests?tab=acceptance&sel=${a.id}" data-link>${a.display_id} <b>${ACC_STATUS[a.status]}</b></a>`).join(''))}</p>` : '')}
      ${raw(r.raid && (r.raid.issues.length || r.raid.risks.length) ? html`<p class="raidline">${raw(r.raid.issues.length ? html`<a href="/app/projects/${p.id}/issues?requirement=${r.id}" data-link>관련 Issues <b>${r.raid.issues.length}</b></a>` : '')}${raw(r.raid.risks.length ? html`<a href="/app/projects/${p.id}/issues?tab=risks&requirement=${r.id}" data-link>관련 Risks <b>${r.raid.risks.length}</b></a>` : '')}</p>` : '')}

      <h4 class="dh">변경 이력</h4>
      <ol class="hist">${raw(r.history.map((h) => html`<li><time>${fmtShort(h.changed_at)}</time><span>${raw(histText(h, r))}</span></li>`).join(''))}</ol>
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(r.created_at)}`, label: '요구사항 보관', id: 'rarchive' }))}`;
  };
  /** H/I: Delivery Trace — summary numbers with drill-down to each filtered list. */
  const deliveryTrace = (r) => {
    const u = `/app/projects/${p.id}`; const live = r.links.filter((l) => !l.archived_at);
    const t = r.testing ? r.testing.summary : { total: 0 }; const issues = r.raid ? r.raid.issues.length : 0; const risks = r.raid ? r.raid.risks.length : 0;
    const acc = r.acceptances && r.acceptances.length ? r.acceptances[0] : null;
    return traceStrip([
      { label: 'WBS', value: live.length, href: `${u}/wbs?requirement=${r.id}`, tone: live.length ? '' : r.scope === 'IN_SCOPE' ? 'warn' : 'muted' },
      { label: 'Changes', value: r.changes ? r.changes.length : 0, href: `${u}/changes?requirement=${r.id}`, tone: r.changes && r.changes.length ? '' : 'muted' },
      { label: 'Issues', value: issues, sub: risks ? `Risk ${risks}` : '', href: `${u}/issues?requirement=${r.id}`, tone: issues ? 'warn' : 'muted' },
      { label: 'Tests', value: t.total, sub: t.total ? `${t.pass} Pass · ${t.fail} Fail` : '', href: `${u}/tests?requirement=${r.id}`, tone: t.fail ? 'crit' : t.total && t.verification === 'VERIFIED' ? 'ok' : t.total ? '' : 'muted' },
      { label: 'Acceptance', value: acc ? ACC_STATUS[acc.status] : '-', sub: acc ? acc.display_id : '', href: acc ? `${u}/tests?tab=acceptance&sel=${acc.id}` : `${u}/tests?tab=acceptance&requirement=${r.id}`, tone: acc ? (acc.status === 'ACCEPTED' ? 'ok' : acc.status === 'REWORK_REQUIRED' || acc.status === 'REJECTED' ? 'crit' : '') : 'muted' },
    ]);
  };

  const linkSection = (r, ro) => {
    const live = r.links.filter((l) => !l.archived_at); const arch = r.links.filter((l) => l.archived_at);
    const byType = Object.keys(LINK_TYPE).map((t) => [t, live.filter((l) => l.link_type === t).length]).filter(([, n]) => n);
    return html`<h4 class="dh">관련 WBS <em>${live.length}</em>${raw(byType.length > 1 ? html`<small class="dim" style="font-weight:500;letter-spacing:0;text-transform:none">${byType.map(([t, n]) => `${LINK_TYPE[t]} ${n}`).join(' · ')}</small>` : '')}</h4>
      ${raw(live.length ? html`<ol class="crit links">${raw(live.map((l) => html`<li data-link="${l.id}">
        <span class="mono wcode">${l.wbs_code}</span><span class="crit__in" style="padding:6px 4px">${l.title}<small class="dim" style="margin-left:6px">${WBS_TYPE[l.item_type]}${l.owner_name ? ' · ' + l.owner_name : ''}</small></span>
        ${raw(ro ? html`<span class="chip chip--muted">${LINK_TYPE[l.link_type]}</span>` : html`<select class="select select--xs" data-link-type="${l.id}">${raw(Object.entries(LINK_TYPE).map(([v, lb]) => html`<option value="${v}" ${l.link_type === v ? 'selected' : ''}>${lb}</option>`).join(''))}</select>
        <span class="crit__act" style="opacity:1"><button data-link-del="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>`
        : html`<div class="empty-inline"><b>아직 연결된 WBS가 없습니다.</b><span>이 요구사항을 구현하거나 검증하는 작업을 연결하세요.</span></div>`)}
      ${raw(arch.length ? html`<p class="hint">보관된 WBS ${arch.length}개 연결은 기록으로만 남아 있습니다.</p>` : '')}
      ${raw(ro ? '' : html`<div class="actions" style="margin-top:8px"><button class="btn btn--secondary btn--sm" id="link-add">+ WBS 연결</button></div>`)}`;
  };

  const lt = (v) => String(v || '').replace(/\b(IMPLEMENTS|SUPPORTS|VALIDATES)\b/g, (m) => LINK_TYPE[m]);
  const histText = (h, r) => {
    const val = (f, v) => { if (v == null) return '-'; if (f === 'type') return REQ_TYPE[v] || v; if (f === 'priority') return REQ_PRIORITY[v] || v; if (f === 'scope') return REQ_SCOPE[v] || v; if (f === 'status') return REQ_STATUS[v] || v;
      if (f === 'owner_user_id') return (members.find((m) => m.id === v) || {}).name || '미지정'; return v; };
    switch (h.action_type) {
      case 'CREATED': return html`<b>${r.display_id}</b> 생성 <small>${h.changed_by_name || ''}</small>`;
      case 'ARCHIVED': return html`보관 처리 <small>${h.changed_by_name || ''}</small>`;
      case 'CRITERION_ADDED': return html`완료 조건 추가 <q>${h.new_value}</q>`;
      case 'CRITERION_UPDATED': return html`완료 조건 수정 <q>${h.old_value}</q> → <q>${h.new_value}</q>`;
      case 'CRITERION_REMOVED': return html`완료 조건 삭제 <q>${h.old_value}</q>`;
      case 'LINKED_WBS': return html`WBS 연결 <q>${lt(h.new_value)}</q>`;
      case 'UNLINKED_WBS': return html`WBS 연결 해제 <q>${h.old_value}</q>`;
      case 'LINK_TYPE_CHANGED': return html`연결 유형 변경 <q>${lt(h.old_value)}</q> → <q>${lt(h.new_value)}</q>`;
      default: {
        const f = h.field_name; const long = f === 'title' || f === 'description';
        return html`<b>${REQ_FIELD_LABEL[f] || f}</b> ${long ? (f === 'description' ? '변경' : html`<q>${h.old_value}</q> → <q>${h.new_value}</q>`) : html`${val(f, h.old_value)} → ${val(f, h.new_value)}`} <small>${h.changed_by_name || ''}</small>${raw(h.source_change_request_id ? html`<span class="src">변경 출처 <a href="/app/projects/${p.id}/changes?sel=${h.source_change_request_id}" data-link>${h.source_change_display_id || 'CR'} ${h.source_change_title || ''}</a>${h.source_change_archived_at ? ' (보관됨)' : ''}</span>` : '')}`;
      }
    }
  };


  const bind = () => {
    const qi = $('#q'); let qt;
    if (qi) { qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { setParam('q', qi.value.trim()); await load(); draw(); $('#q').focus(); $('#q').setSelectionRange(99, 99); }, 350); }; }
    main.querySelectorAll('[data-f]').forEach((sl) => sl.onchange = async () => { setParam(sl.dataset.f, sl.value); await load(); draw(); });
    main.querySelectorAll('[data-rview]').forEach((b) => b.onclick = () => { setParam('view', b.dataset.rview === 'trace' ? 'trace' : ''); draw(); });
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };
    bindFilterClears(main, { setParam, keys: ['q', ...filterKeys, 'archived'], reload: async () => { await load(); draw(); } });
    const cx = $('#ctx-off'); if (cx) cx.onclick = () => { ctxCr = null; setParam('cr', ''); draw(); };
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); draw(); $('#c-title').focus(); }; }
    main.querySelectorAll('[data-row]').forEach((tr) => tr.onclick = async () => { creating = false; setParam('new', ''); await loadSel(tr.dataset.row); draw(); });
    const close = () => { creating = false; sel = null; setParam('sel', ''); setParam('new', ''); draw(); };
    for (const idc of ['dclose', 'dcancel']) { const b = $('#' + idc); if (b) b.onclick = close; }
    bindEscape(() => { if (sel || creating) close(); });
    if (creating) bindCreate(); else if (sel) bindDetail();
  };

  const bindCreate = () => {
    const form = $('#cf'); const crit = []; const list = $('#c-crit');
    const drawCrit = () => { list.innerHTML = crit.map((c, i) => html`<div class="crit-pending"><span class="crit__n">${i + 1}</span><span>${c}</span><button type="button" data-rm="${i}" aria-label="삭제">×</button></div>`).join(''); list.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { crit.splice(Number(b.dataset.rm), 1); drawCrit(); }); };
    const addCrit = () => { const v = $('#c-crit-in').value.trim(); if (!v) return; crit.push(v); $('#c-crit-in').value = ''; drawCrit(); };
    $('#c-crit-add').onclick = addCrit;
    $('#c-crit-in').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addCrit(); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '제목을 입력해 주세요.' });
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try {
        const { requirement } = await api('POST', rApi(), { ...d, criteria: crit });
        toast(`${requirement.display_id} 요구사항을 추가했습니다.`);
        creating = false; setParam('new', ''); sel = requirement; setParam('sel', requirement.id); await load(); draw();
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    };
  };

  const bindDetail = () => {
    const r = sel; const status = $('#dsave');
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try {
        const d = await api('PATCH', rApi(`/${r.id}`), { [field]: value, ...(ctxCr ? { source_change_request_id: ctxCr.id } : {}) });
        sel = d.requirement; summary = d.summary; await load(); draw();
        $('#dsave').textContent = d.changed.length ? '저장됨' : '변경 없음';
        const el = main.querySelector(`[data-field="${field}"]`); if (el && el.tagName !== 'SELECT') { el.focus(); }
      } catch (e) { status.textContent = e.message; toast(e.message); }
    };
    main.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT') el.onchange = () => save(field, el.value);
      else {
        el.onblur = () => { if (el.value.trim() !== (r[field] || '')) save(field, el.value); };
        if (el.tagName === 'INPUT') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); };
      }
    });
    const critApi = async (method, path, body) => { try { const d = await api(method, rApi(`/${r.id}${path}`), body); sel = d.requirement; await load(); draw(); } catch (e) { toast(e.message); } };
    const addIn = $('#crit-in');
    const add = () => { const v = addIn.value.trim(); if (!v) return; critApi('POST', '/criteria', { content: v }); };
    if (addIn) { addIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }; $('#crit-add').onclick = add; }
    main.querySelectorAll('[data-crit-in]').forEach((inp) => {
      const c = r.criteria.find((x) => x.id === inp.dataset.critIn);
      inp.onblur = () => { const v = inp.value.trim(); if (v && v !== c.content) critApi('PATCH', `/criteria/${c.id}`, { content: v }); else inp.value = c.content; };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    });
    main.querySelectorAll('[data-crit-move]').forEach((b) => b.onclick = () => { const c = r.criteria.find((x) => x.id === b.dataset.critMove); critApi('PATCH', `/criteria/${c.id}`, { sequence: c.sequence + Number(b.dataset.dir) }); });
    main.querySelectorAll('[data-crit-del]').forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog({ title: '완료 조건을 삭제할까요?', body: '삭제한 완료 조건은 History에만 남습니다.', confirm: '삭제', danger: true }))) return;
      critApi('DELETE', `/criteria/${b.dataset.critDel}`);
    });
    const la = $('#link-add');
    if (la) la.onclick = async () => {
      const { items } = await api('GET', wsApi(`/${id}/wbs`));
      const linked = new Set(r.links.filter((l) => !l.archived_at).map((l) => l.wbs_item_id));
      const pick = await pickerDialog({ title: `${r.display_id}에 WBS 연결`, placeholder: 'WBS 번호 또는 업무명 검색', withType: true,
        rows: items.map((w) => ({ ...w, disabled: linked.has(w.id) })), searchKeys: ['wbs_code', 'title'],
        render: (w) => html`<span class="mono wcode">${w.wbs_code}</span><span class="pick__t" style="padding-left:${w.depth * 14}px">${raw(w.item_type === 'MILESTONE' ? '<i class="wms">◆</i> ' : '')}<span class="${w.item_type === 'SUMMARY' ? 'wsum' : ''}">${w.title}</span></span>
          <small class="dim">${WBS_TYPE[w.item_type]}</small><small class="dim">${w.owner_name || '-'}</small><span class="chip ${WBS_STATUS_CHIP[w.status] || ''}">${WBS_STATUS[w.status]}</span>${raw(w.disabled ? '<small class="dim">연결됨</small>' : '')}` });
      if (!pick) return;
      try { const d = await api('POST', rApi(`/${r.id}/links`), { wbs_item_id: pick.id, link_type: pick.link_type }); sel = d.requirement; summary = d.summary; await load(); draw(); toast('WBS를 연결했습니다.'); }
      catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    main.querySelectorAll('[data-link-type]').forEach((sl) => sl.onchange = async () => {
      try { const d = await api('PATCH', rApi(`/${r.id}/links/${sl.dataset.linkType}`), { link_type: sl.value }); sel = d.requirement; summary = d.summary; await load(); draw(); } catch (e) { toast(e.message); }
    });
    main.querySelectorAll('[data-link-del]').forEach((b) => b.onclick = async () => {
      const l = r.links.find((x) => x.id === b.dataset.linkDel);
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: `${r.display_id}과 ${l.wbs_code} ${l.title}의 연결만 제거됩니다. 요구사항과 WBS는 그대로 남습니다.`, confirm: '연결 해제', danger: true }))) return;
      try { const d = await api('DELETE', rApi(`/${r.id}/links/${l.id}`)); sel = d.requirement; summary = d.summary; await load(); draw(); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const ab = $('#rarchive');
    if (ab) ab.onclick = async () => {
      if (!(await confirmDialog({ title: `${r.display_id}을 보관할까요?`, body: '보관된 요구사항은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않습니다.', confirm: '보관하기', danger: true }))) return;
      try { const d = await api('POST', rApi(`/${r.id}/archive`), {}); sel = d.requirement; toast(`${r.display_id}을 보관했습니다.`); await load(); draw(); } catch (e) { toast(e.message); }
    };
  };

  await load();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
  if (creating) { const t = $('#c-title'); if (t) t.focus(); }
}

