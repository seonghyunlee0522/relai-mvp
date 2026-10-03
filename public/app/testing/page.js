import { api, wsApi } from '../core/api.js';
import { $, fmtDT, fmtShort, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { state } from '../core/state.js';
import { projectHead } from '../project/guide.js';
import { resBadge, verifyChip } from '../shared/badges.js';
import { ACC_ACTIONS, ACC_ACTION_LABEL, ACC_STATUS, ACC_STATUS_CHIP, ISSUE_STATUS, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, RESULT, TC_PRIORITY, TC_STATUS, TC_STATUS_CHIP, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE, testSummaryText } from '../shared/constants.js';
import { appliedFilters, bindFilterClears, filterSelect } from '../shared/filters.js';
import { emptyFiltered, emptyState } from '../shared/empty-state.js';
import { bindCoach, coachMark } from '../onboarding/ui.js';
import { drawerFoot, drawerHead, bindEscape } from '../shared/drawer.js';
import { statusChip, prText } from '../shared/badges.js';
import { confirmDialog, pickerDialog, promptDialog, showErrors, toast } from '../shared/dialogs.js';
import { bindDtabs, dtabs } from '../shared/detail.js';

export async function testsPage(id) {
  const main = $('#main');
  const g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  const { members } = await api('GET', `/api/workspaces/${state.workspace.id}/members`);
  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };
  const tab = () => { const t = params().get('tab'); return t === 'acceptance' || t === 'coverage' ? t : 'cases'; };
  const isCases = () => tab() === 'cases'; const isAcc = () => tab() === 'acceptance';
  const tApi = (s = '') => wsApi(`/${id}/tests${s}`); const aApi = (s = '') => wsApi(`/${id}/acceptances${s}`);
  const CASE_F = ['status', 'priority', 'owner', 'last_result', 'requirement', 'wbs'];
  const ACC_F = ['status', 'requirement'];
  const filterKeys = () => (isAcc() ? ACC_F : CASE_F);
  const listQuery = () => { const q = params(); const out = new URLSearchParams(); for (const k of ['q', ...filterKeys()]) if (q.get(k)) out.set(k, q.get(k)); if (q.get('archived')) out.set('include_archived', '1'); return out.toString() ? '?' + out : ''; };

  let rows = []; let cov = []; let ts = g.tests; let ac = g.acceptances; let sel = null; let creating = params().get('new') === '1'; let dtab = 'info';
  const load = async () => {
    if (isCases()) { const d = await api('GET', tApi(listQuery())); rows = d.items; ts = d.tests; }
    else if (isAcc()) { const d = await api('GET', aApi(listQuery())); rows = d.items; ac = d.acceptances; }
    else { const d = await api('GET', tApi('/coverage')); cov = d.coverage; ts = d.tests; }
    g.tests = ts; g.acceptances = ac;
  };
  const loadSel = async (xid) => { sel = xid ? (isAcc() ? (await api('GET', aApi(`/${xid}`))).acceptance : (await api('GET', tApi(`/${xid}`))).test) : null; setParam('sel', xid); };
  const opt = (map, cur, blank) => (blank ? html`<option value="">${blank}</option>` : '') + Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const ownerMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const FILTER_DEFS = (T) => [{ key: 'q', label: '검색' }, { key: 'status', label: 'Status', map: T === 'cases' ? TC_STATUS : ACC_STATUS }, { key: 'last_result', label: '최근 결과', map: RESULT }, { key: 'priority', label: 'Priority', map: TC_PRIORITY },
    { key: 'owner', label: 'Owner', map: { ...ownerMap, none: '미지정' } }, { key: 'requirement', label: '요구사항', format: () => '선택 항목' }, { key: 'wbs', label: 'WBS', format: () => '선택 항목' }, { key: 'archived', label: '보관 포함', format: () => '예' }];
  const ownerOpts = (cur, blank = '미지정') => html`<option value="">${blank}</option>` + members.map((m) => html`<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>${m.name}</option>`).join('');
  const dcell = (d) => (d ? html`${fmtShort(d)}` : '<span class="dim">-</span>');
  document.title = `Tests — ${p.name} — RELAI`;

  const draw = () => {
    const q = params(); const T = tab();
    const hasFilter = ['q', ...filterKeys(), 'archived'].some((k) => q.get(k));
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'tests' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 테스트와 검수는 조회만 할 수 있습니다.</div>' : '')}
      ${raw(T === 'acceptance' ? coachMark('ACCEPTANCE_INTRO') : coachMark('TESTING_INTRO'))}
      <div class="rhead"><div class="seg seg--lg" role="tablist" title="${T === 'cases' ? '요구사항이 의도대로 동작하는지 확인하는 테스트를 관리합니다.' : T === 'acceptance' ? '고객이 결과물을 확인하고 승인하는 검수를 관리합니다.' : '범위 내 요구사항마다 테스트가 연결되어 있는지, 결과는 어떤지 확인합니다.'}">
        <button class="${T === 'cases' ? 'is-on' : ''}" data-tab="cases" role="tab">Test Cases${raw(ts.total ? html`<em>${ts.total}</em>` : '')}</button>
        <button class="${T === 'acceptance' ? 'is-on' : ''}" data-tab="acceptance" role="tab">Acceptance${raw(ac.in_progress ? html`<em>${ac.in_progress}</em>` : '')}</button>
        <button class="${T === 'coverage' ? 'is-on' : ''}" data-tab="coverage" role="tab">Coverage${raw(ts.coverage !== null && ts.coverage !== undefined ? html`<em>${ts.coverage}%</em>` : '')}</button></div>
      ${raw(T === 'cases' ? html`<div class="summary summary--inline">
          <div><b>${ts.total}</b><span>전체 <small>(미실행 ${ts.total - ts.executed})</small></span></div><div><b>${ts.ready}</b><span>Ready</span></div>
          <div class="${ts.last_fail ? 'is-crit' : ''}"><b>${ts.last_fail}</b><span>Fail</span></div><div class="${ts.last_blocked ? 'is-warn' : ''}"><b>${ts.last_blocked}</b><span>Blocked</span></div></div>`
        : T === 'acceptance' ? html`<div class="summary summary--inline">
          <div><b>${ac.total}</b><span>전체 <small>(작성 중 ${ac.draft})</small></span></div><div><b>${ac.requested}</b><span>검수 요청</span></div>
          <div><b>${ac.accepted}</b><span>승인</span></div><div class="${ac.rework || ac.rejected ? 'is-warn' : ''}"><b>${ac.rework + ac.rejected}</b><span>보완 필요 / 반려</span></div></div>`
        : html`<div class="summary summary--inline">
          <div><b>${ts.in_scope}</b><span>범위 내 요구사항</span></div><div><b>${ts.in_scope_tested}</b><span>테스트 연결됨</span></div>
          <div class="${ts.in_scope_untested ? 'is-warn' : ''}"><b>${ts.in_scope_untested}</b><span>테스트 없음</span></div><div><b>${ts.coverage === null ? '-' : ts.coverage + '%'}</b><span>Coverage</span></div></div>`)}</div>
      ${raw(T === 'coverage' ? '' : html`<div class="rtool">
        <input class="input input--sm" id="q" type="search" placeholder="ID, 제목, 설명 검색" value="${q.get('q') || ''}">
        ${raw(T === 'cases' ? html`${raw(filterSelect('status', 'Status', TC_STATUS, q.get('status')))}${raw(filterSelect('last_result', '최근 결과', RESULT, q.get('last_result')))}
          ${raw(filterSelect('priority', 'Priority', TC_PRIORITY, q.get('priority')))}${raw(filterSelect('owner', 'Owner', ownerMap, q.get('owner'), html`<option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>`))}`
        : html`${raw(filterSelect('status', 'Status', ACC_STATUS, q.get('status')))}`)}
        <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>
        <span class="rtool__sp"></span>
        ${raw(archived ? '' : html`<button class="btn btn--primary btn--sm" id="add">+ ${T === 'cases' ? '테스트 추가' : '검수 만들기'}</button>`)}
      </div>
      ${raw(appliedFilters(q, FILTER_DEFS(T)))}`)}
      <div class="rlayout rlayout--cr ${sel || creating ? 'has-drawer' : ''}">
        <div class="rtable-wrap">${raw(T === 'coverage' ? coverageTable()
          : rows.length ? (T === 'cases' ? caseTable() : accTable())
          : hasFilter ? emptyFiltered(T === 'cases' ? '테스트' : '검수')
          : T === 'cases' ? emptyState({ title: '아직 등록된 테스트가 없습니다.', body: '요구사항을 기준으로 테스트를 만들고 실행 결과를 기록하세요. Fail은 바로 Issue로 등록할 수 있습니다.', cta: archived ? null : { id: 'add2', label: '첫 테스트 추가' } })
          : emptyState({ title: '아직 등록된 검수가 없습니다.', body: '검수 대상 요구사항과 테스트를 묶어 고객에게 검수를 요청하고 결과를 기록하세요.', cta: archived ? null : { id: 'add2', label: '첫 검수 만들기' } }))}</div>
        <aside class="drawer drawer--cr" id="drawer" ${sel || creating ? '' : 'hidden'}>${raw(creating ? (isAcc() ? createAcc() : createTest()) : sel ? (isAcc() ? detailAcc() : detailTest()) : '')}</aside>
      </div></div>`;
    bind(); bindCoach(main);
  };

  const caseTable = () => html`<table class="rtable rtable--raid"><thead><tr><th>ID</th><th>제목</th><th>Status</th><th>Priority</th><th>최근 결과</th><th>Owner</th><th class="num">실행</th><th class="num">요구사항</th><th>Updated</th></tr></thead>
    <tbody>${raw(rows.map((x) => html`<tr class="${sel && sel.id === x.id ? 'is-sel' : ''} ${x.archived_at ? 'is-arch' : ''}" data-row="${x.id}">
      <td class="mono">${x.display_id}</td>
      <td class="ttl"><span>${x.title}</span>${raw(x.archived_at ? '<small>보관됨</small>' : '')}</td>
      <td>${raw(statusChip(TC_STATUS, TC_STATUS_CHIP, x.status))}</td><td>${raw(prText(x.priority))}</td>
      <td>${raw(resBadge(x.last_result))}${raw(x.last_run_at ? html` <small class="dim">${fmtShort(x.last_run_at)}</small>` : '')}</td>
      <td>${x.owner_name || raw('<span class="dim">-</span>')}</td>
      <td class="num">${x.execution_count || raw('<span class="dim">0</span>')}</td><td class="num">${x.requirement_count || raw('<span class="dim">0</span>')}</td><td class="dim">${fmtShort(x.updated_at)}</td></tr>`).join(''))}</tbody></table>`;
  const accTable = () => html`<table class="rtable rtable--raid"><thead><tr><th>ID</th><th>제목</th><th>Status</th><th class="num">대상 요구사항</th><th>Test 상태</th><th>요청일</th><th>Due</th><th>Updated</th></tr></thead>
    <tbody>${raw(rows.map((x) => html`<tr class="${sel && sel.id === x.id ? 'is-sel' : ''} ${x.archived_at ? 'is-arch' : ''}" data-row="${x.id}">
      <td class="mono">${x.display_id}</td>
      <td class="ttl"><span>${x.title}</span>${raw(x.archived_at ? '<small>보관됨</small>' : '')}</td>
      <td>${raw(statusChip(ACC_STATUS, ACC_STATUS_CHIP, x.status))}</td>
      <td class="num">${x.requirement_count || raw('<span class="dim">0</span>')}</td>
      <td class="${x.test_summary.fail ? 'is-overdue' : ''}">${testSummaryText(x.test_summary)}</td>
      <td>${raw(dcell(x.requested_at))}</td><td>${raw(dcell(x.due_date))}</td><td class="dim">${fmtShort(x.updated_at)}</td></tr>`).join(''))}</tbody></table>`;
  const coverageTable = () => cov.length ? html`<table class="rtable rtable--raid"><thead><tr><th>요구사항</th><th>제목</th><th>Status</th><th class="num">테스트</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">미실행</th><th>검증 상태</th><th></th></tr></thead>
    <tbody>${raw(cov.map((r) => html`<tr class="${r.verification === 'UNLINKED' ? 'is-untested' : ''}" data-req="${r.id}">
      <td class="mono">${r.display_id}</td><td class="ttl"><span>${r.title}</span></td>
      <td><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span></td>
      <td class="num">${r.total || raw('<span class="dim">0</span>')}</td><td class="num">${r.pass || raw('<span class="dim">0</span>')}</td><td class="num ${r.fail ? 'is-overdue' : ''}">${r.fail || raw('<span class="dim">0</span>')}</td><td class="num">${r.not_run || raw('<span class="dim">0</span>')}</td>
      <td>${raw(verifyChip(r.verification))}</td>
      <td class="num">${raw(r.total ? html`<a class="link" href="/app/projects/${p.id}/tests?requirement=${r.id}" data-link data-stop>테스트 보기</a>` : archived ? '' : html`<a class="link" href="/app/projects/${p.id}/tests?new=1&requirement=${r.id}" data-link data-stop>테스트 추가</a>`)}</td></tr>`).join(''))}</tbody></table>`
    : html`<div class="empty"><h2>범위 내 요구사항이 없습니다.</h2><p>요구사항의 Scope를 '범위 내'로 정하면 여기에 테스트 커버리지가 표시됩니다.</p><a class="btn btn--secondary" href="/app/projects/${p.id}/requirements" data-link>요구사항 관리</a></div>`;

  /* ----- steps editor (shared by create / detail) ----- */
  const stepsEditor = (steps, ro) => html`<ol class="steps" id="steps">${raw(steps.map((s, i) => html`<li data-step="${i}"><span class="steps__n">${i + 1}</span>
      <div class="steps__in"><input class="input input--sm" data-si value="${s.instruction}" maxlength="1000" placeholder="수행할 절차" ${ro ? 'disabled' : ''}><input class="input input--sm" data-se value="${s.expected || ''}" maxlength="1000" placeholder="이 단계의 기대 결과 (선택)" ${ro ? 'disabled' : ''}></div>
      ${raw(ro ? '' : html`<span class="crit__act" style="opacity:1"><button type="button" data-step-move="-1" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-step-move="1" title="아래로" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-step-del title="삭제">×</button></span>`)}</li>`).join(''))}</ol>
    ${raw(ro ? (steps.length ? '' : '<p class="hint">등록된 절차가 없습니다.</p>') : '<button type="button" class="btn btn--secondary btn--sm" id="step-add">+ 절차 추가</button>')}`;
  const readSteps = (scope) => [...scope.querySelectorAll('#steps li')].map((li) => ({ instruction: $('[data-si]', li).value.trim(), expected: $('[data-se]', li).value.trim() })).filter((s) => s.instruction);
  let draftSteps = [];
  const bindSteps = (scope, onChange) => {
    const addB = $('#step-add', scope);
    if (addB) addB.onclick = () => { draftSteps = readSteps(scope); draftSteps.push({ instruction: '', expected: '' }); onChange(draftSteps, true); };
    scope.querySelectorAll('[data-step-move]').forEach((b) => b.onclick = () => { const li = b.closest('li'); const i = Number(li.dataset.step); const d = Number(b.dataset.stepMove); const all = [...scope.querySelectorAll('#steps li')].map((l) => ({ instruction: $('[data-si]', l).value, expected: $('[data-se]', l).value })); const [m] = all.splice(i, 1); all.splice(i + d, 0, m); draftSteps = all; onChange(all, false); });
    scope.querySelectorAll('[data-step-del]').forEach((b) => b.onclick = () => { const li = b.closest('li'); const i = Number(li.dataset.step); const all = [...scope.querySelectorAll('#steps li')].map((l) => ({ instruction: $('[data-si]', l).value, expected: $('[data-se]', l).value })); all.splice(i, 1); draftSteps = all; onChange(all, false); });
  };

  const createTest = () => html`<form id="cf" novalidate><div class="drawer__h"><b>새 테스트</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b"><div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: 로그인 — 올바른 계정으로 로그인"><div class="err" data-for="title"></div></div>
      <div class="field"><label>설명</label><textarea class="textarea" name="description" maxlength="5000" style="min-height:60px" placeholder="무엇을 확인하는 테스트인지"></textarea></div>
      <div class="field"><label>사전 조건</label><textarea class="textarea" name="precondition" maxlength="2000" style="min-height:48px" placeholder="예: 가입된 계정이 있어야 함"></textarea></div>
      <div class="field"><span class="lbl">테스트 절차</span><div id="steps-wrap">${raw(stepsEditor(draftSteps, false))}</div></div>
      <div class="field"><label>기대 결과</label><textarea class="textarea" name="expected_result" maxlength="2000" style="min-height:48px" placeholder="테스트가 성공했을 때의 결과"></textarea></div>
      <div class="row2">
        <div class="field"><label>Priority</label><select class="select" name="priority">${raw(opt(TC_PRIORITY, 'MEDIUM'))}</select></div>
        <div class="field"><label>담당자</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select></div></div>
      ${raw(params().get('requirement') ? '<p class="hint">등록 후 현재 필터의 요구사항과 자동으로 연결됩니다.</p>' : '')}</div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">테스트 등록</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;
  const createAcc = () => html`<form id="cf" novalidate><div class="drawer__h"><b>새 검수</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b"><div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: 1차 검수 — 회원/로그인 기능"><div class="err" data-for="title"></div></div>
      <div class="field"><label>설명</label><textarea class="textarea" name="description" maxlength="5000" style="min-height:60px" placeholder="검수 범위와 기준"></textarea></div>
      <div class="field"><label>검수 기한</label><input class="input" type="date" name="due_date"></div>
      <p class="hint">대상 요구사항과 테스트는 등록 후 상세 화면에서 연결합니다.</p></div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">검수 만들기</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;

  const histText = (h, x) => {
    const lab = { title: '제목', priority: 'Priority', owner_user_id: '담당자', due_date: '검수 기한', description: '설명', decision_note: '결정 사유' };
    const val = (f, v) => { if (v == null || v === '') return '-'; if (f === 'owner_user_id') return (members.find((m) => m.id === v) || {}).name || '미지정'; if (f === 'status') return TC_STATUS[v] || ACC_STATUS[v] || v; if (f === 'priority') return TC_PRIORITY[v] || v; return v; };
    switch (h.action_type) {
      case 'CREATED': return html`<b>${x.display_id}</b> 생성 <small>${h.changed_by_name || ''}</small>`;
      case 'ARCHIVED': return html`보관 처리 <small>${h.changed_by_name || ''}</small>`;
      case 'STATUS_CHANGED': return html`<b>${val('status', h.old_value)}</b> → <b>${val('status', h.new_value)}</b>${raw(h.field_name && h.field_name !== 'status' ? html` <q>${h.field_name}</q>` : '')} <small>${h.changed_by_name || ''}</small>`;
      case 'EXECUTED': return html`실행 <b>#${h.field_name}</b> ${raw(resBadge(h.new_value))} <small>${h.changed_by_name || ''}</small>`;
      case 'ISSUE_RAISED': return html`실행 <b>${h.field_name}</b> → Issue 등록 <q>${h.new_value}</q>`;
      case 'LINKED': return html`${h.field_name === 'REQUIREMENT' ? '요구사항' : h.field_name === 'TEST' ? '테스트' : 'WBS'} 연결 <q>${h.new_value}</q>`;
      case 'UNLINKED': return html`${h.field_name === 'REQUIREMENT' ? '요구사항' : h.field_name === 'TEST' ? '테스트' : 'WBS'} 연결 해제 <q>${h.old_value}</q>`;
      case 'STEPS_CHANGED': return html`테스트 절차 수정 <small>${h.changed_by_name || ''}</small>`;
      default: return html`<b>${lab[h.field_name] || h.field_name}</b> ${val(h.field_name, h.old_value)} → ${val(h.field_name, h.new_value)} <small>${h.changed_by_name || ''}</small>`;
    }
  };

  const testLinkBlocks = (x, ro) => ['REQUIREMENT', 'WBS'].map((t) => {
    const list = t === 'WBS' ? x.links.wbs : x.links.requirements;
    const live = list.filter((l) => !l.archived_at); const arch = list.length - live.length;
    const href = (l) => t === 'WBS' ? `/app/projects/${p.id}/wbs?sel=${l.target_id}` : `/app/projects/${p.id}/requirements?sel=${l.target_id}`;
    return html`<h4 class="dh">${t === 'WBS' ? '관련 WBS' : '검증 대상 요구사항'} <em>${live.length}</em></h4>
      ${raw(live.length ? html`<ol class="crit links">${raw(live.map((l) => html`<li><a class="raidrow" href="${href(l)}" data-link><span class="mono ${t === 'WBS' ? 'wcode' : ''}">${l.code}</span><span class="crit__in" style="padding:6px 4px">${l.title}</span></a>
        ${raw(ro ? '' : html`<span class="crit__act" style="opacity:1"><button data-unlink="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>` : html`<p class="hint">${t === 'WBS' ? '연결된 WBS가 없습니다.' : '연결된 요구사항이 없습니다. 이 테스트가 어떤 요구사항을 검증하는지 연결하세요.'}</p>`)}
      ${raw(arch ? html`<p class="hint">보관된 항목 ${arch}건 연결은 기록으로만 남아 있습니다.</p>` : '')}
      ${raw(ro ? '' : html`<div class="actions" style="margin-top:6px"><button class="btn btn--secondary btn--sm" data-link-add="${t}">+ ${t === 'WBS' ? 'WBS' : '요구사항'} 연결</button></div>`)}`;
  }).join('');

  const histPane = (x) => (x.history.length ? html`<ol class="hist">${raw(x.history.map((h) => html`<li><time>${fmtShort(h.changed_at)}</time><span>${raw(histText(h, x))}</span></li>`).join(''))}</ol>` : '<p class="hint">변경 이력이 없습니다.</p>');
  const testLinkCount = (x) => Object.values(x.links || {}).reduce((n, l) => n + (Array.isArray(l) ? l.filter((v) => !v.archived_at).length : 0), 0) + x.acceptances.length;
  const detailTest = () => {
    const x = sel; const ro = archived || Boolean(x.archived_at);
    const last = x.executions[0] || null;
    return html`${raw(drawerHead(x.display_id, statusChip(TC_STATUS, TC_STATUS_CHIP, x.status) + resBadge(last ? last.result : null) + prText(x.priority), { archived: Boolean(x.archived_at) }))}
    ${raw(dtabs([{ key: 'info', label: '업무정보' }, { key: 'exec', label: '실행 이력', count: x.executions.length }, { key: 'links', label: '연결', count: testLinkCount(x) }, { key: 'hist', label: '변경 이력', count: x.history.length }], dtab))}
    <div class="drawer__b"><section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
      <input class="dtitle" data-field="title" value="${x.title}" maxlength="200" ${ro ? 'disabled' : ''} aria-label="제목">
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="무엇을 확인하는 테스트인지 설명을 입력하세요." ${ro ? 'disabled' : ''}>${x.description}</textarea>
      <div class="dgrid">
        <div class="dfield"><span>Status</span><div><select class="select select--sm" data-field="status" ${ro ? 'disabled' : ''}>${raw(opt(TC_STATUS, x.status))}</select></div></div>
        <div class="dfield"><span>Priority</span><div><select class="select select--sm" data-field="priority" ${ro ? 'disabled' : ''}>${raw(opt(TC_PRIORITY, x.priority))}</select></div></div>
        <div class="dfield"><span>담당자</span><div><select class="select select--sm" data-field="owner_user_id" ${ro ? 'disabled' : ''}>${raw(ownerOpts(x.owner_user_id || ''))}</select></div></div>
        <div class="dfield"><span>최근 실행</span><div class="hint" style="height:36px;display:flex;align-items:center;gap:6px">${raw(last ? html`${raw(resBadge(last.result))} <span>#${last.execution_number} · ${fmtShort(last.executed_at)}</span>` : '아직 실행 전')}</div></div>
      </div>
      <div class="dfield" style="margin-top:10px"><span>사전 조건</span><div><textarea class="textarea" data-field="precondition" maxlength="2000" style="min-height:44px;font-size:14px" placeholder="테스트 전에 갖춰야 할 조건" ${ro ? 'disabled' : ''}>${x.precondition}</textarea></div></div>
      <h4 class="dh">테스트 절차 <em>${x.steps.length}</em>${raw(ro ? '' : '<button class="link linkbtn" id="steps-save" style="margin-left:auto;width:auto;font-size:12.5px" hidden>절차 저장</button>')}</h4>
      <div id="steps-wrap">${raw(stepsEditor(x.steps, ro))}</div>
      <div class="dfield" style="margin-top:10px"><span>기대 결과</span><div><textarea class="textarea" data-field="expected_result" maxlength="2000" style="min-height:44px;font-size:14px" placeholder="성공했을 때 기대하는 결과" ${ro ? 'disabled' : ''}>${x.expected_result}</textarea></div></div>
      <div class="dsave" id="dsave"></div>
      ${raw(ro ? '' : html`<div class="decision decision--review"><p><b>이 테스트를 실행했나요?</b> 결과(Pass / Fail / Blocked)와 실제 결과를 기록하세요. 기록은 수정되지 않고 실행 이력으로 쌓입니다.</p><div class="actions" style="margin-top:0"><button class="btn btn--primary btn--sm" id="run">테스트 실행</button></div></div>`)}
      </section>
      <section data-pane="exec" ${dtab === 'exec' ? '' : 'hidden'}>
      ${raw(x.executions.length ? html`<ol class="exec">${raw(x.executions.map((e) => html`<li class="exec__i exec--${e.result.toLowerCase()}"><details ${e === last ? 'open' : ''}><summary><span class="exec__n">#${e.execution_number}</span>${raw(resBadge(e.result))}<span class="exec__who">${e.executed_by_name || ''}</span><time>${fmtShort(e.executed_at)}</time>
          ${raw(e.issue_display_id ? html`<a class="chip chip--fail" href="/app/projects/${p.id}/issues?sel=${e.issue_id}" data-link data-stop title="연결된 Issue">${e.issue_display_id} · ${ISSUE_STATUS[e.issue_status] || e.issue_status}</a>` : '')}</summary>
          <div class="exec__b">${raw(e.actual_result ? html`<p><b>실제 결과</b>${e.actual_result}</p>` : '<p class="hint">실제 결과 기록 없음</p>')}${raw(e.note ? html`<p><b>메모</b>${e.note}</p>` : '')}
            ${raw(e.result === 'FAIL' && !ro ? (e.issue_display_id ? html`<p class="hint">연결된 Issue: <a class="link" href="/app/projects/${p.id}/issues?sel=${e.issue_id}" data-link>${e.issue_display_id}</a></p>` : html`<div class="actions" style="margin-top:4px"><button class="btn btn--secondary btn--sm" data-raise="${e.id}">Issue로 등록</button></div>`) : '')}</div></details></li>`).join(''))}</ol>` : '<p class="hint">아직 실행 기록이 없습니다.</p>')}
      </section>
      <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>
      ${raw(testLinkBlocks(x, ro))}
      ${raw(x.acceptances.length ? html`<h4 class="dh">포함된 검수 <em>${x.acceptances.length}</em></h4><ol class="crit links">${raw(x.acceptances.map((a) => html`<li><a class="raidrow" href="/app/projects/${p.id}/tests?tab=acceptance&sel=${a.id}" data-link><span class="mono">${a.display_id}</span><span class="crit__in" style="padding:6px 4px">${a.title}</span><span class="chip ${ACC_STATUS_CHIP[a.status] || ''}">${ACC_STATUS[a.status]}</span></a></li>`).join(''))}</ol>` : '')}
      </section>
      <section data-pane="hist" ${dtab === 'hist' ? '' : 'hidden'}>${raw(histPane(x))}</section>
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(x.created_at)}`, label: '테스트 보관' }))}`;
  };

  const detailAcc = () => {
    const x = sel; const ro = archived || Boolean(x.archived_at);
    const actions = ro ? [] : ACC_ACTIONS[x.status] || [];
    const liveTests = x.tests.filter((t) => !t.archived_at);
    const failTests = liveTests.filter((t) => t.last_result === 'FAIL'); const openIssues = liveTests.filter((t) => t.open_issue);
    const final = x.status === 'ACCEPTED' || x.status === 'REJECTED';
    return html`${raw(drawerHead(x.display_id, statusChip(ACC_STATUS, ACC_STATUS_CHIP, x.status), { archived: Boolean(x.archived_at) }))}
    ${raw(dtabs([{ key: 'info', label: '업무정보' }, { key: 'links', label: '대상·테스트', count: x.requirements.filter((r) => !r.archived_at).length + liveTests.length }, { key: 'hist', label: '변경 이력', count: x.history.length }], dtab))}
    <div class="drawer__b"><section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
      <input class="dtitle" data-field="title" value="${x.title}" maxlength="200" ${ro || final ? 'disabled' : ''} aria-label="제목">
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="검수 범위와 기준을 적어두세요." ${ro || final ? 'disabled' : ''}>${x.description}</textarea>
      <div class="dgrid">
        <div class="dfield"><span>검수 기한</span><div><input class="input input--sm" type="date" data-field="due_date" value="${x.due_date || ''}" ${ro || final ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>요청일</span><div class="hint" style="height:36px;display:flex;align-items:center">${fmtDT(x.requested_at)}</div></div>
        <div class="dfield"><span>승인일</span><div class="hint" style="height:36px;display:flex;align-items:center">${fmtDT(x.accepted_at)}</div></div>
        <div class="dfield"><span>반려일</span><div class="hint" style="height:36px;display:flex;align-items:center">${fmtDT(x.rejected_at)}</div></div>
      </div>
      <div class="dsave" id="dsave"></div>
      ${raw(x.decision_note ? html`<div class="decision ${x.status === 'ACCEPTED' ? 'decision--ok' : x.status === 'REJECTED' || x.status === 'REWORK_REQUIRED' ? 'decision--no' : ''}"><p><b>결정 사유</b></p><p><q>${x.decision_note}</q></p></div>` : '')}
      ${raw(actions.length ? html`<div class="decision decision--review">
        ${raw(x.status === 'DRAFT' ? '<p><b>검수 준비가 끝났나요?</b> 대상 요구사항과 테스트를 연결한 뒤 고객에게 검수를 요청하세요.</p>' : x.status === 'REQUESTED' ? html`<p><b>고객 검수 결과를 기록하세요.</b>${raw(failTests.length || openIssues.length ? html` <span class="warn-inline">Fail 테스트 ${failTests.length}건${openIssues.length ? ` · 처리 중인 Issue ${openIssues.length}건` : ''}이 남아 있습니다.</span>` : ' 연결된 테스트에 남은 Fail이 없습니다.')}</p>` : '<p><b>보완이 끝났나요?</b> 보완 사항을 처리한 뒤 다시 검수를 요청하세요.</p>')}
        <div class="actions" style="margin-top:0">${raw(actions.map((a) => html`<button class="btn ${a === 'accept' || a === 'submit' || a === 'resubmit' ? 'btn--primary' : a === 'reject' ? 'btn--danger' : 'btn--secondary'} btn--sm" data-act="${a}">${ACC_ACTION_LABEL[a]}</button>`).join(''))}</div></div>` : '')}
      </section>
      <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>
      <h4 class="dh">대상 요구사항 <em>${x.requirements.filter((r) => !r.archived_at).length}</em></h4>
      ${raw(x.requirements.length ? html`<ol class="crit links">${raw(x.requirements.map((r) => html`<li class="${r.archived_at ? 'is-arch' : ''}"><a class="raidrow" href="/app/projects/${p.id}/requirements?sel=${r.id}" data-link><span class="mono">${r.display_id}</span><span class="crit__in" style="padding:6px 4px">${r.title}</span>${raw(verifyChip(r.verification))}</a>
        ${raw(ro || final ? '' : html`<span class="crit__act" style="opacity:1"><button data-unlink="${r.link_id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>` : '<p class="hint">검수 대상 요구사항이 없습니다.</p>')}
      ${raw(ro || final ? '' : html`<div class="actions" style="margin-top:6px"><button class="btn btn--secondary btn--sm" data-link-add="REQUIREMENT">+ 요구사항 연결</button></div>`)}
      <h4 class="dh">검수 테스트 <em>${liveTests.length}</em><span class="dim" style="margin-left:auto;font-weight:600;text-transform:none;letter-spacing:0">${testSummaryText(x.test_summary)}</span></h4>
      ${raw(x.tests.length ? html`<ol class="crit links">${raw(x.tests.map((t) => html`<li class="${t.archived_at ? 'is-arch' : ''}"><a class="raidrow" href="/app/projects/${p.id}/tests?sel=${t.id}" data-link><span class="mono">${t.display_id}</span><span class="crit__in" style="padding:6px 4px">${t.title}</span>${raw(t.open_issue ? html`<small class="dim" title="처리 중 Issue">${t.open_issue}</small>` : '')}${raw(resBadge(t.last_result))}</a>
        ${raw(ro || final ? '' : html`<span class="crit__act" style="opacity:1"><button data-unlink="${t.link_id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>` : '<p class="hint">연결된 테스트가 없습니다. 검수 근거가 되는 테스트를 연결하세요.</p>')}
      ${raw(ro || final ? '' : html`<div class="actions" style="margin-top:6px"><button class="btn btn--secondary btn--sm" data-link-add="TEST">+ 테스트 연결</button></div>`)}
      </section>
      <section data-pane="hist" ${dtab === 'hist' ? '' : 'hidden'}>${raw(histPane(x))}</section>
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(x.created_at)} · ${x.created_by_name || ''}`, label: '검수 보관' }))}`;
  };

  /** Execution dialog. Resolves {result, actual_result, note} or null. */
  const runDialog = (x) => new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rdT"><h3 id="rdT">${x.display_id} 테스트 실행</h3>
      <div class="dialog__b">${x.title}${raw(x.expected_result ? html`<p class="hint" style="margin:6px 0 0">기대 결과: ${x.expected_result}</p>` : '')}</div>
      <div class="field"><span class="lbl">결과 <span class="req">*</span></span><div class="resq">${raw(['PASS', 'FAIL', 'BLOCKED'].map((r) => html`<label class="resq__o resq--${r.toLowerCase()}"><input type="radio" name="result" value="${r}"><b>${RESULT[r]}</b><small>${r === 'PASS' ? '기대한 대로 동작' : r === 'FAIL' ? '기대와 다르게 동작' : '환경 문제 등으로 수행 불가'}</small></label>`).join(''))}</div><div class="err" id="rd-err"></div></div>
      <div class="field"><label for="rd-actual">실제 결과</label><textarea class="textarea" id="rd-actual" maxlength="2000" style="min-height:64px" placeholder="실제로 어떻게 동작했는지 (Fail이면 꼭 적어주세요)"></textarea></div>
      <div class="field"><label for="rd-note">메모</label><input class="input" id="rd-note" maxlength="1000" placeholder="환경, 데이터, 참고 사항"></div>
      <div class="actions"><button class="btn btn--secondary" data-v="0">취소</button><button class="btn btn--primary" data-v="1">결과 기록</button></div></div>`;
    const done = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) done(null); return; }
      if (b.dataset.v === '0') return done(null);
      const r = el.querySelector('input[name=result]:checked'); if (!r) { $('#rd-err', el).textContent = '결과를 선택해 주세요.'; return; }
      done({ result: r.value, actual_result: $('#rd-actual', el).value.trim(), note: $('#rd-note', el).value.trim() }); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    document.body.append(el); el.querySelector('input[name=result]').focus();
  });

  const bind = () => {
    main.querySelectorAll('[data-tab]').forEach((b) => b.onclick = async () => { const next = b.dataset.tab; if (next === tab()) return; for (const k of ['q', ...CASE_F, ...ACC_F, 'archived', 'sel', 'new']) setParam(k, ''); setParam('tab', next === 'cases' ? '' : next); sel = null; creating = false; await load(); draw(); });
    const qi = $('#q'); let qt;
    if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { setParam('q', qi.value.trim()); await load(); draw(); $('#q').focus(); $('#q').setSelectionRange(99, 99); }, 350); };
    main.querySelectorAll('[data-f]').forEach((sl) => sl.onchange = async () => { setParam(sl.dataset.f, sl.value); await load(); draw(); });
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };
    bindFilterClears(main, { setParam, keys: ['q', ...filterKeys(), 'archived'], reload: async () => { await load(); draw(); } });
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; draftSteps = []; setParam('sel', ''); setParam('new', '1'); draw(); $('#c-title').focus(); }; }
    main.querySelectorAll('[data-row]').forEach((tr) => tr.onclick = async () => { creating = false; dtab = 'info'; setParam('new', ''); await loadSel(tr.dataset.row); draw(); });
    main.querySelectorAll('[data-stop]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
    main.querySelectorAll('[data-req]').forEach((tr) => tr.onclick = () => navigate(`/app/projects/${p.id}/requirements?sel=${tr.dataset.req}`));
    const close = () => { creating = false; sel = null; setParam('sel', ''); setParam('new', ''); draw(); };
    for (const idc of ['dclose', 'dcancel']) { const b = $('#' + idc); if (b) b.onclick = close; }
    bindEscape(() => { if (sel || creating) close(); });
    if (creating) bindCreate(); else if (sel) (isAcc() ? bindDetailAcc() : bindDetailTest());
  };
  const bindCreate = () => {
    const form = $('#cf');
    if (isCases()) { const onSteps = (steps) => { draftSteps = steps; $('#steps-wrap', form).innerHTML = stepsEditor(steps, false); bindSteps(form, onSteps); const last = form.querySelector('#steps li:last-child [data-si]'); if (last && !last.value) last.focus(); }; bindSteps(form, onSteps); }
    form.onsubmit = async (e) => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '제목을 입력해 주세요.' });
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try {
        if (isCases()) {
          d.steps = readSteps(form);
          const r = await api('POST', tApi(), d); let x = r.test;
          const reqId = params().get('requirement');
          if (reqId) { try { x = (await api('POST', tApi(`/${x.id}/links`), { target_type: 'REQUIREMENT', target_id: reqId })).test; } catch {} }
          toast(`${x.display_id}을 등록했습니다.`); creating = false; draftSteps = []; setParam('new', ''); sel = x; setParam('sel', x.id); await load(); draw();
        } else {
          const r = await api('POST', aApi(), d); const x = r.acceptance;
          toast(`${x.display_id}을 만들었습니다.`); creating = false; setParam('new', ''); sel = x; setParam('sel', x.id); await load(); draw();
        }
      } catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    };
  };
  const pickReq = async (title, have) => {
    const rows2 = (await api('GET', wsApi(`/${id}/requirements`))).requirements;
    return pickerDialog({ title, placeholder: '번호 또는 제목 검색', withType: false, rows: rows2.map((r) => ({ ...r, disabled: have.has(r.id) })), searchKeys: ['display_id', 'title'],
      render: (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span>${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}` });
  };
  const bindDetailTest = () => {
    const x = sel; const status = $('#dsave');
    bindDtabs(main.querySelector('.drawer'), (k) => { dtab = k; });
    const apply = async (d) => { sel = d.test; ts = d.tests; g.tests = ts; await load(); draw(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { const d = await api('PATCH', tApi(`/${x.id}`), { [field]: value }); await apply(d); $('#dsave').textContent = d.changed.length ? '저장됨' : ''; }
      catch (e) { const m = e.fields ? Object.values(e.fields)[0] : e.message; status.textContent = m; toast(m); draw(); }
    };
    main.querySelectorAll('.drawer [data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT' || el.type === 'date') el.onchange = () => save(field, el.value);
      else { el.onblur = () => { const v = el.value.trim(); if (v !== (x[field] || '')) save(field, v); }; if (el.tagName !== 'TEXTAREA') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); }; }
    });
    // steps: edit locally, save explicitly
    const drawer = $('#drawer'); const saveBtn = $('#steps-save');
    const markDirty = () => { if (saveBtn) saveBtn.hidden = false; };
    const rebind = () => {
      bindSteps(drawer, (steps) => { $('#steps-wrap', drawer).innerHTML = stepsEditor(steps, false); rebind(); markDirty(); const last = drawer.querySelector('#steps li:last-child [data-si]'); if (last && !last.value) last.focus(); });
      drawer.querySelectorAll('#steps input').forEach((i) => i.oninput = markDirty);
    };
    if (saveBtn) { rebind(); saveBtn.onclick = () => save('steps', readSteps(drawer)); }
    const run = $('#run');
    if (run) run.onclick = async () => {
      const r = await runDialog(x); if (!r) return;
      try { const d = await api('POST', tApi(`/${x.id}/executions`), r); dtab = 'exec'; await apply(d); toast(`실행 #${d.execution.execution_number} 결과를 기록했습니다.`); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    };
    main.querySelectorAll('[data-raise]').forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog({ title: 'Fail 결과를 Issue로 등록할까요?', body: `${x.display_id}의 제목·실제 결과·담당자와 연결된 요구사항/WBS를 복사해 새 Issue를 만듭니다. 같은 실행 기록에서는 한 번만 등록됩니다.`, confirm: 'Issue로 등록' }))) return;
      try { const d = await api('POST', tApi(`/${x.id}/executions/${b.dataset.raise}/issue`), {}); toast(`${d.issue.display_id} Issue를 등록했습니다.`); await apply(d); }
      catch (e) { toast(e.message); if (e.code === 'already_raised') { await loadSel(x.id); draw(); } }
    });
    main.querySelectorAll('[data-link-add]').forEach((b) => b.onclick = async () => {
      const t = b.dataset.linkAdd; const list = t === 'WBS' ? x.links.wbs : x.links.requirements;
      const have = new Set(list.filter((l) => !l.archived_at).map((l) => l.target_id));
      let pk;
      if (t === 'WBS') { const rows2 = (await api('GET', wsApi(`/${id}/wbs`))).items; pk = await pickerDialog({ title: `${x.display_id}에 WBS 연결`, placeholder: '코드 또는 제목 검색', withType: false, rows: rows2.map((r) => ({ ...r, disabled: have.has(r.id) })), searchKeys: ['wbs_code', 'title'], render: (w) => html`<span class="mono wcode">${w.wbs_code}</span><span class="pick__t" style="padding-left:${w.depth * 14}px">${w.title}</span><small class="dim">${WBS_TYPE[w.item_type]}</small><span class="chip ${WBS_STATUS_CHIP[w.status] || ''}">${WBS_STATUS[w.status]}</span>${raw(w.disabled ? '<small class="dim">연결됨</small>' : '')}` }); }
      else pk = await pickReq(`${x.display_id}이 검증하는 요구사항 연결`, have);
      if (!pk) return;
      try { await apply(await api('POST', tApi(`/${x.id}/links`), { target_type: t, target_id: pk.id })); toast('연결했습니다.'); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    });
    main.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: '연결 관계만 제거되며 항목 자체는 그대로 남습니다.', confirm: '연결 해제', danger: true }))) return;
      try { await apply(await api('DELETE', tApi(`/${x.id}/links/${b.dataset.unlink}`))); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const ab = $('#xarchive');
    if (ab) ab.onclick = async () => {
      if (!(await confirmDialog({ title: `${x.display_id}을 보관할까요?`, body: '보관된 테스트는 기본 목록과 Coverage에서 제외되고 수정할 수 없습니다. 실행 이력과 연결 관계는 보존됩니다.', confirm: '보관하기', danger: true }))) return;
      try { await apply(await api('POST', tApi(`/${x.id}/archive`), {})); toast('보관했습니다.'); } catch (e) { toast(e.message); }
    };
  };
  const bindDetailAcc = () => {
    const x = sel; const status = $('#dsave');
    bindDtabs(main.querySelector('.drawer'), (k) => { dtab = k; });
    const apply = async (d) => { sel = d.acceptance; ac = d.acceptances; g.acceptances = ac; await load(); draw(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { const d = await api('PATCH', aApi(`/${x.id}`), { [field]: value }); await apply(d); $('#dsave').textContent = d.changed.length ? '저장됨' : ''; }
      catch (e) { const m = e.fields ? Object.values(e.fields)[0] : e.message; status.textContent = m; toast(m); draw(); }
    };
    main.querySelectorAll('.drawer [data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.type === 'date') el.onchange = () => save(field, el.value);
      else { el.onblur = () => { const v = el.value.trim(); if (v !== (x[field] || '')) save(field, v); }; if (el.tagName !== 'TEXTAREA') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); }; }
    });
    main.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.act; let note = '';
      const fails = x.tests.filter((t) => !t.archived_at && t.last_result === 'FAIL').length;
      if (a === 'submit' || a === 'resubmit') { if (!(await confirmDialog({ title: a === 'submit' ? '고객에게 검수를 요청할까요?' : '검수를 다시 요청할까요?', body: `${x.display_id}의 상태가 '검수 요청'으로 바뀌고 요청일이 기록됩니다.${fails ? ` 연결된 테스트 중 Fail ${fails}건이 남아 있습니다.` : ''}`, confirm: ACC_ACTION_LABEL[a] }))) return; }
      else if (a === 'accept') { if (!(await confirmDialog({ title: '검수를 승인 처리할까요?', body: fails ? `연결된 테스트 중 Fail ${fails}건이 남아 있습니다. 고객이 승인했더라도 남은 결함은 Issue로 관리하세요.` : '고객이 결과물을 확인하고 승인했음을 기록합니다.', confirm: '승인' }))) return; note = await promptDialog({ title: `${x.display_id} 승인`, body: '승인 조건이나 비고가 있으면 적어두세요. (선택)', label: '비고', confirm: '승인 기록' }); if (note === null) return; }
      else { note = await promptDialog({ title: a === 'reject' ? `${x.display_id} 반려` : `${x.display_id} 보완 요청`, body: a === 'reject' ? '반려 사유는 필수입니다. 반려된 검수는 다시 진행할 수 없습니다.' : '어떤 항목을 보완해야 하는지 적어두면 다음 요청 때 기준이 됩니다.', label: a === 'reject' ? '반려 사유' : '보완 요청 사유', required: true, confirm: ACC_ACTION_LABEL[a], danger: a === 'reject' }); if (note === null) return; }
      try { await apply(await api('POST', aApi(`/${x.id}/transition`), { action: a, decision_note: note })); toast(`${ACC_ACTION_LABEL[a]} 처리했습니다.`); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    });
    main.querySelectorAll('[data-link-add]').forEach((b) => b.onclick = async () => {
      const t = b.dataset.linkAdd; let pk;
      if (t === 'REQUIREMENT') pk = await pickReq(`${x.display_id} 대상 요구사항 연결`, new Set(x.requirements.map((r) => r.id)));
      else { const rows2 = (await api('GET', tApi())).items; const have = new Set(x.tests.map((r) => r.id)); pk = await pickerDialog({ title: `${x.display_id}에 테스트 연결`, placeholder: '번호 또는 제목 검색', withType: false, rows: rows2.map((r) => ({ ...r, disabled: have.has(r.id) })), searchKeys: ['display_id', 'title'], render: (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span>${raw(resBadge(r.last_result))}${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}` }); }
      if (!pk) return;
      try { await apply(await api('POST', aApi(`/${x.id}/links`), { target_type: t, target_id: pk.id })); toast('연결했습니다.'); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    });
    main.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: '연결 관계만 제거되며 항목 자체는 그대로 남습니다.', confirm: '연결 해제', danger: true }))) return;
      try { await apply(await api('DELETE', aApi(`/${x.id}/links/${b.dataset.unlink}`))); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const ab = $('#xarchive');
    if (ab) ab.onclick = async () => {
      if (!(await confirmDialog({ title: `${x.display_id}을 보관할까요?`, body: '보관된 검수는 기본 목록에서 숨겨지고 수정할 수 없습니다. 연결 관계와 이력은 보존됩니다.', confirm: '보관하기', danger: true }))) return;
      try { await apply(await api('POST', aApi(`/${x.id}/archive`), {})); toast('보관했습니다.'); } catch (e) { toast(e.message); }
    };
  };

  await load();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
  if (creating) { const t = $('#c-title'); if (t) t.focus(); }
}

