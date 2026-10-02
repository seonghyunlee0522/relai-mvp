import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw, todayLocal } from '../core/dom.js';
import { state } from '../core/state.js';
import { projectHead } from '../project/guide.js';
import { sevBadge } from '../shared/badges.js';
import { CR_STATUS, CR_STATUS_CHIP, ISSUE_STATUS, ISSUE_STATUS_CHIP, ISSUE_TRANSITIONS, LEVEL3, RAID_TARGET, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, RISK_LEVEL, RISK_STATUS, RISK_STATUS_CHIP, RISK_TRANSITIONS, SEVERITY, STRATEGY, WBS_STATUS, WBS_STATUS_CHIP, WBS_TYPE } from '../shared/constants.js';
import { appliedFilters, bindFilterClears, filterSelect } from '../shared/filters.js';
import { emptyFiltered, emptyState } from '../shared/empty-state.js';
import { drawerFoot, drawerHead, bindEscape } from '../shared/drawer.js';
import { statusChip } from '../shared/badges.js';
import { confirmDialog, pickerDialog, promptDialog, showErrors, toast } from '../shared/dialogs.js';
import { bindDtabs, dtabs } from '../shared/detail.js';

export async function raidPage(id) {
  const main = $('#main');
  const g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  const archived = p.status === 'ARCHIVED';
  const { members } = await api('GET', `/api/workspaces/${state.workspace.id}/members`);
  const params = () => new URLSearchParams(location.search);
  const setParam = (k, v) => { const q = params(); if (v) q.set(k, v); else q.delete(k); history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); };
  const tab = () => (params().get('tab') === 'risks' ? 'risks' : 'issues');
  const isIssue = () => tab() === 'issues';
  const xApi = (s = '') => wsApi(`/${id}/${tab()}${s}`);
  const key = () => (isIssue() ? 'issue' : 'risk');
  const ISSUE_F = ['status', 'severity', 'owner', 'wbs', 'requirement', 'change', 'overdue'];
  const RISK_F = ['status', 'probability', 'impact', 'risk_level', 'owner', 'response_strategy', 'wbs', 'requirement', 'change', 'review'];
  const filterKeys = () => (isIssue() ? ISSUE_F : RISK_F);
  const listQuery = () => { const q = params(); const out = new URLSearchParams(); for (const k of ['q', ...filterKeys()]) if (q.get(k)) out.set(k, q.get(k)); if (q.get('archived')) out.set('include_archived', '1'); return out.toString() ? '?' + out : ''; };

  let rows = []; let is = g.issues; let rs = g.risks; let sel = null; let creating = params().get('new') === '1'; let dtab = 'info';
  const load = async () => { const d = await api('GET', xApi(listQuery())); rows = d.items; is = d.issues; rs = d.risks; g.issues = is; g.risks = rs; };
  const loadSel = async (xid) => { sel = xid ? (await api('GET', xApi(`/${xid}`)))[key()] : null; setParam('sel', xid); };
  const opt = (map, cur, blank) => (blank ? html`<option value="">${blank}</option>` : '') + Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  const ownerMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const FILTER_DEFS = (I) => [{ key: 'q', label: '검색' }, { key: 'status', label: 'Status', map: I ? ISSUE_STATUS : RISK_STATUS }, { key: 'severity', label: 'Severity', map: SEVERITY }, { key: 'risk_level', label: 'Level', map: RISK_LEVEL },
    { key: 'probability', label: 'Probability', map: LEVEL3 }, { key: 'impact', label: 'Impact', map: LEVEL3 }, { key: 'response_strategy', label: '전략', map: STRATEGY }, { key: 'owner', label: 'Owner', map: { ...ownerMap, none: '미지정' } },
    { key: 'wbs', label: 'WBS', format: () => '선택 항목' }, { key: 'requirement', label: '요구사항', format: () => '선택 항목' }, { key: 'change', label: '변경 요청', format: () => '선택 항목' },
    { key: 'overdue', label: 'Overdue', format: () => '예' }, { key: 'review', label: 'Review 필요', format: () => '예' }, { key: 'archived', label: '보관 포함', format: () => '예' }];
  const ownerOpts = (cur, blank = '미지정') => html`<option value="">${blank}</option>` + members.map((m) => html`<option value="${m.id}" ${cur === m.id ? 'selected' : ''}>${m.name}</option>`).join('');
  const dcell = (d) => (d ? html`${fmtShort(d)}` : '<span class="dim">-</span>');
  document.title = `Issues & Risks — ${p.name} — RELAI`;

  const draw = () => {
    const q = params(); const I = isIssue();
    const hasFilter = ['q', ...filterKeys(), 'archived'].some((k) => q.get(k));
    main.innerHTML = html`<div class="page page--wide">
      ${raw(projectHead(p, g, { crumb: `/app/projects/${p.id}`, crumbLabel: p.name, tab: 'raid' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. Issue와 Risk는 조회만 할 수 있습니다.</div>' : '')}
      <div class="rhead"><div class="seg seg--lg" role="tablist" title="${I ? 'Issue는 이미 발생해 대응이 필요한 문제입니다.' : 'Risk는 아직 발생하지 않았지만 발생 가능성이 있는 위험입니다.'}"><button class="${I ? 'is-on' : ''}" data-tab="issues" role="tab">Issues${raw(is.active ? html`<em>${is.active}</em>` : '')}</button><button class="${!I ? 'is-on' : ''}" data-tab="risks" role="tab">Risks${raw(rs.high_or_critical ? html`<em>${rs.high_or_critical}</em>` : '')}</button></div>
      ${raw(I ? html`<div class="summary summary--inline">
        <div><b>${is.active}</b><span>Open <small>(진행 중 포함)</small></span></div><div class="${is.blocked ? 'is-warn' : ''}"><b>${is.blocked}</b><span>Blocked</span></div>
        <div class="${is.critical ? 'is-crit' : ''}"><b>${is.critical}</b><span>Critical</span></div><div class="${is.overdue ? 'is-warn' : ''}"><b>${is.overdue}</b><span>Overdue</span></div></div>`
      : html`<div class="summary summary--inline">
        <div><b>${rs.open + rs.monitoring}</b><span>Open <small>(모니터링 포함)</small></span></div><div class="${rs.critical ? 'is-crit' : rs.high ? 'is-warn' : ''}"><b>${rs.high_or_critical}</b><span>High / Critical</span></div>
        <div class="${rs.review_needed ? 'is-warn' : ''}"><b>${rs.review_needed}</b><span>Review 필요</span></div><div><b>${rs.materialized}</b><span>발생</span></div></div>`)}</div>
      <div class="rtool">
        <input class="input input--sm" id="q" type="search" placeholder="ID, 제목, 설명 검색" value="${q.get('q') || ''}">
        ${raw(I ? html`${raw(filterSelect('status', 'Status', ISSUE_STATUS, q.get('status')))}${raw(filterSelect('severity', 'Severity', SEVERITY, q.get('severity')))}`
        : html`${raw(filterSelect('status', 'Status', RISK_STATUS, q.get('status')))}${raw(filterSelect('risk_level', 'Level', RISK_LEVEL, q.get('risk_level')))}
          ${raw(filterSelect('probability', 'Probability', LEVEL3, q.get('probability')))}${raw(filterSelect('impact', 'Impact', LEVEL3, q.get('impact')))}${raw(filterSelect('response_strategy', '전략', STRATEGY, q.get('response_strategy')))}`)}
        ${raw(filterSelect('owner', 'Owner', ownerMap, q.get('owner'), html`<option value="none" ${q.get('owner') === 'none' ? 'selected' : ''}>미지정</option>`))}
        <label class="toggle"><input type="checkbox" data-t="${I ? 'overdue' : 'review'}" ${q.get(I ? 'overdue' : 'review') ? 'checked' : ''}> ${I ? 'Overdue만' : 'Review 필요만'}</label>
        <label class="toggle"><input type="checkbox" id="arch" ${q.get('archived') ? 'checked' : ''}> 보관 포함</label>
        <span class="rtool__sp"></span>
        ${raw(archived ? '' : html`<button class="btn btn--primary btn--sm" id="add">+ ${I ? 'Issue' : 'Risk'} 등록</button>`)}
      </div>
      ${raw(appliedFilters(q, FILTER_DEFS(I)))}
      <div class="rlayout rlayout--cr ${sel || creating ? 'has-drawer' : ''}">
        <div class="rtable-wrap">${raw(rows.length ? (I ? issueTable() : riskTable())
          : hasFilter ? emptyFiltered(I ? 'Issue' : 'Risk')
          : I ? emptyState({ title: '현재 등록된 Issue가 없습니다.', body: '프로젝트 진행 중 발생한 문제를 기록하면 담당자·기한·해결 상태를 관리하고 관련 요구사항·WBS와 연결할 수 있습니다.', cta: archived ? null : { id: 'add2', label: '첫 Issue 등록' } })
          : emptyState({ title: '현재 등록된 Risk가 없습니다.', body: '프로젝트에 영향을 줄 수 있는 잠재 위험을 미리 기록하고 대응 계획과 Review 일정을 관리하세요.', cta: archived ? null : { id: 'add2', label: '첫 Risk 등록' } }))}</div>
        <aside class="drawer drawer--cr" id="drawer" ${sel || creating ? '' : 'hidden'}>${raw(creating ? (I ? createIssue() : createRisk()) : sel ? (I ? detailIssue() : detailRisk()) : '')}</aside>
      </div></div>`;
    bind();
  };

  const issueTable = () => html`<table class="rtable rtable--raid"><thead><tr><th>ID</th><th>제목</th><th>Severity</th><th>Status</th><th>Owner</th><th>Due</th><th class="num">관련 WBS</th><th>Updated</th></tr></thead>
    <tbody>${raw(rows.map((x) => html`<tr class="${sel && sel.id === x.id ? 'is-sel' : ''} ${x.archived_at ? 'is-arch' : ''}" data-row="${x.id}">
      <td class="mono">${x.display_id}</td>
      <td class="ttl"><span>${x.title}</span>${raw(x.source_risk_display_id ? html`<small title="Source Risk">${x.source_risk_display_id}</small>` : '')}${raw(x.source_test_execution_id ? '<small title="테스트 Fail에서 등록">TEST</small>' : '')}${raw(x.archived_at ? '<small>보관됨</small>' : '')}</td>
      <td>${raw(sevBadge(x.severity))}</td><td>${raw(statusChip(ISSUE_STATUS, ISSUE_STATUS_CHIP, x.status))}</td>
      <td>${x.owner_name || raw('<span class="dim">-</span>')}</td>
      <td class="${x.is_overdue ? 'is-overdue' : ''}">${raw(dcell(x.due_date))}${raw(x.is_overdue ? ' <small class="over">지남</small>' : '')}</td>
      <td class="num">${x.wbs_count || raw('<span class="dim">0</span>')}</td><td class="dim">${fmtShort(x.updated_at)}</td></tr>`).join(''))}</tbody></table>`;
  const riskTable = () => html`<table class="rtable rtable--raid"><thead><tr><th>ID</th><th>제목</th><th>Probability</th><th>Impact</th><th>Level</th><th>Status</th><th>Owner</th><th>Review</th></tr></thead>
    <tbody>${raw(rows.map((x) => html`<tr class="${sel && sel.id === x.id ? 'is-sel' : ''} ${x.archived_at ? 'is-arch' : ''}" data-row="${x.id}">
      <td class="mono">${x.display_id}</td>
      <td class="ttl"><span>${x.title}</span>${raw(x.converted_issue_display_id ? html`<small title="전환된 Issue">→ ${x.converted_issue_display_id}</small>` : '')}${raw(x.archived_at ? '<small>보관됨</small>' : '')}</td>
      <td>${LEVEL3[x.probability]}</td><td>${LEVEL3[x.impact]}</td><td>${raw(sevBadge(x.risk_level))}</td>
      <td>${raw(statusChip(RISK_STATUS, RISK_STATUS_CHIP, x.status))}</td>
      <td>${x.owner_name || raw('<span class="dim">-</span>')}</td>
      <td class="${x.needs_review ? 'is-overdue' : ''}">${raw(dcell(x.review_date))}${raw(x.needs_review ? ' <small class="over">Review</small>' : '')}</td></tr>`).join(''))}</tbody></table>`;

  const createIssue = () => html`<form id="cf" novalidate><div class="drawer__h"><b>새 Issue</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b"><div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: 고객 API 미제공"><div class="err" data-for="title"></div></div>
      <div class="field"><label>설명</label><textarea class="textarea" name="description" maxlength="5000" style="min-height:72px"></textarea></div>
      <div class="row2">
        <div class="field"><label>Severity</label><select class="select" name="severity">${raw(opt(SEVERITY, 'MEDIUM'))}</select></div>
        <div class="field"><label>담당자</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select></div>
        <div class="field"><label>발견일</label><input class="input" type="date" name="identified_at" value="${todayLocal()}"></div>
        <div class="field"><label>기한</label><input class="input" type="date" name="due_date"></div></div></div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">Issue 등록</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;
  const createRisk = () => html`<form id="cf" novalidate><div class="drawer__h"><b>새 Risk</b><button type="button" class="drawer__x" id="dclose" aria-label="닫기">×</button></div>
    <div class="drawer__b"><div class="form-err" role="alert" hidden></div>
      <div class="field"><label for="c-title">제목 <span class="req">*</span></label><input class="input" id="c-title" name="title" maxlength="200" placeholder="예: 고객 API 일정 지연 가능성"><div class="err" data-for="title"></div></div>
      <div class="field"><label>설명</label><textarea class="textarea" name="description" maxlength="5000" style="min-height:72px"></textarea></div>
      <div class="row2">
        <div class="field"><label>Probability</label><select class="select" name="probability" data-mx>${raw(opt(LEVEL3, 'MEDIUM'))}</select></div>
        <div class="field"><label>Impact</label><select class="select" name="impact" data-mx>${raw(opt(LEVEL3, 'MEDIUM'))}</select></div></div>
      <div class="field"><span class="lbl">Risk Level <small class="dim" style="font-weight:500">(Probability × Impact)</small></span><div id="c-level">${raw(sevBadge(riskLevel('MEDIUM', 'MEDIUM')))}</div></div>
      <div class="row2">
        <div class="field"><label>대응 전략</label><select class="select" name="response_strategy">${raw(opt(STRATEGY, '', '미정'))}</select></div>
        <div class="field"><label>담당자</label><select class="select" name="owner_user_id">${raw(ownerOpts(''))}</select></div>
        <div class="field"><label>식별일</label><input class="input" type="date" name="identified_at" value="${todayLocal()}"></div>
        <div class="field"><label>Review Date</label><input class="input" type="date" name="review_date"></div></div>
      <div class="field"><label>대응 계획</label><textarea class="textarea" name="mitigation_plan" maxlength="5000" style="min-height:60px"></textarea></div></div>
    <div class="drawer__f"><button class="btn btn--primary" type="submit">Risk 등록</button><button class="btn btn--secondary" type="button" id="dcancel">취소</button></div></form>`;

  const linkBlocks = (x, ro, labels) => ['WBS', 'REQUIREMENT', 'CHANGE'].map((t) => {
    const list = t === 'WBS' ? x.links.wbs : t === 'REQUIREMENT' ? x.links.requirements : x.links.changes;
    const live = list.filter((l) => !l.archived_at); const arch = list.length - live.length;
    const href = (l) => t === 'WBS' ? `/app/projects/${p.id}/wbs?sel=${l.target_id}` : t === 'REQUIREMENT' ? `/app/projects/${p.id}/requirements?sel=${l.target_id}` : `/app/projects/${p.id}/changes?sel=${l.target_id}`;
    return html`<h4 class="dh">${labels[t] || RAID_TARGET[t]} <em>${live.length}</em></h4>
      ${raw(live.length ? html`<ol class="crit links">${raw(live.map((l) => html`<li><a class="raidrow" href="${href(l)}" data-link><span class="mono ${t === 'WBS' ? 'wcode' : ''}">${l.code}</span><span class="crit__in" style="padding:6px 4px">${l.title}</span></a>
        ${raw(ro ? '' : html`<span class="crit__act" style="opacity:1"><button data-unlink="${l.id}" title="연결 해제">×</button></span>`)}</li>`).join(''))}</ol>` : html`<p class="hint">${t === 'WBS' ? '연결된 WBS가 없습니다.' : t === 'REQUIREMENT' ? '연결된 요구사항이 없습니다.' : '연결된 변경 요청이 없습니다.'}</p>`)}
      ${raw(arch ? html`<p class="hint">보관된 항목 ${arch}건 연결은 기록으로만 남아 있습니다.</p>` : '')}
      ${raw(ro ? '' : html`<div class="actions" style="margin-top:6px"><button class="btn btn--secondary btn--sm" data-link-add="${t}">+ ${t === 'WBS' ? 'WBS' : t === 'REQUIREMENT' ? '요구사항' : '변경 요청'} 연결</button></div>`)}`;
  }).join('');

  const histText = (h, x) => {
    const lab = { title: '제목', severity: 'Severity', owner_user_id: '담당자', due_date: '기한', identified_at: I_LABEL(), probability: 'Probability', impact: 'Impact', risk_level: 'Risk Level', review_date: 'Review Date', response_strategy: '대응 전략' };
    const val = (f, v) => { if (v == null || v === '') return '-'; if (f === 'owner_user_id') return (members.find((m) => m.id === v) || {}).name || '미지정'; if (f === 'status') return ISSUE_STATUS[v] || RISK_STATUS[v] || v;
      if (f === 'severity' || f === 'risk_level') return SEVERITY[v] || RISK_LEVEL[v] || v; if (f === 'probability' || f === 'impact') return LEVEL3[v] || v; if (f === 'response_strategy') return STRATEGY[v] || v; return v; };
    switch (h.action_type) {
      case 'CREATED': return html`<b>${x.display_id}</b> 생성 <small>${h.changed_by_name || ''}</small>`;
      case 'ARCHIVED': return html`보관 처리 <small>${h.changed_by_name || ''}</small>`;
      case 'STATUS_CHANGED': return html`<b>${val('status', h.old_value)}</b> → <b>${val('status', h.new_value)}</b> <small>${h.changed_by_name || ''}</small>`;
      case 'LINKED': return html`${RAID_TARGET[h.field_name] || '연결'} 추가 <q>${h.new_value}</q>`;
      case 'UNLINKED': return html`${RAID_TARGET[h.field_name] || '연결'} 해제 <q>${h.old_value}</q>`;
      case 'CONVERTED': return h.new_value ? html`Issue로 전환 <q>${h.new_value}</q>` : html`Risk에서 전환됨 <q>${h.old_value}</q>`;
      default: return html`<b>${lab[h.field_name] || h.field_name}</b> ${val(h.field_name, h.old_value)} → ${val(h.field_name, h.new_value)} <small>${h.changed_by_name || ''}</small>`;
    }
  };
  const I_LABEL = () => (isIssue() ? '발견일' : '식별일');
  const statusSelect = (map, transitions, cur, ro) => {
    const allowed = [cur, ...(transitions[cur] || [])];
    return html`<select class="select select--sm" data-field="status" ${ro ? 'disabled' : ''}>${raw(Object.entries(map).map(([v, l]) => html`<option value="${v}" ${cur === v ? 'selected' : ''} ${allowed.includes(v) ? '' : 'disabled'}>${l}</option>`).join(''))}</select>`;
  };

  const liveLinks = (x) => ['wbs', 'requirements', 'changes'].reduce((n, k) => n + (x.links[k] || []).filter((l) => !l.archived_at).length, 0);
  const detailTabs = (x) => dtabs([{ key: 'info', label: '업무정보' }, { key: 'links', label: '연결', count: liveLinks(x) }, { key: 'hist', label: '변경 이력', count: x.history.length }], dtab);
  const histPane = (x) => (x.history.length ? html`<ol class="hist">${raw(x.history.map((h) => html`<li><time>${fmtShort(h.changed_at)}</time><span>${raw(histText(h, x))}</span></li>`).join(''))}</ol>` : '<p class="hint">변경 이력이 없습니다.</p>');

  const detailIssue = () => {
    const x = sel; const ro = archived || Boolean(x.archived_at);
    return html`${raw(drawerHead(x.display_id, statusChip(ISSUE_STATUS, ISSUE_STATUS_CHIP, x.status) + sevBadge(x.severity) + (x.is_overdue ? '<span class="chip chip--hold">Overdue</span>' : ''), { archived: Boolean(x.archived_at) }))}
    ${raw(detailTabs(x))}
    <div class="drawer__b"><section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
      <input class="dtitle" data-field="title" value="${x.title}" maxlength="200" ${ro ? 'disabled' : ''} aria-label="제목">
      ${raw(x.source_risk_id ? html`<p class="srcline">Source Risk · <a class="link" href="/app/projects/${p.id}/issues?tab=risks&sel=${x.source_risk_id}" data-link>${x.source_risk_display_id} ${x.source_risk_title}</a></p>` : '')}
      ${raw(x.source_test_id ? html`<p class="srcline">Source Test · <a class="link" href="/app/projects/${p.id}/tests?sel=${x.source_test_id}" data-link>${x.source_test_label}</a> 실행 Fail</p>` : '')}
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${ro ? 'disabled' : ''}>${x.description}</textarea>
      <div class="dgrid">
        <div class="dfield"><span>Severity</span><div><select class="select select--sm" data-field="severity" ${ro ? 'disabled' : ''}>${raw(opt(SEVERITY, x.severity))}</select></div></div>
        <div class="dfield"><span>Status</span><div>${raw(statusSelect(ISSUE_STATUS, ISSUE_TRANSITIONS, x.status, ro))}</div></div>
        <div class="dfield"><span>담당자</span><div><select class="select select--sm" data-field="owner_user_id" ${ro ? 'disabled' : ''}>${raw(ownerOpts(x.owner_user_id || ''))}</select></div></div>
        <div class="dfield"><span>발견일</span><div><input class="input input--sm" type="date" data-field="identified_at" value="${x.identified_at || ''}" ${ro ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>기한</span><div><input class="input input--sm" type="date" data-field="due_date" value="${x.due_date || ''}" ${ro ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>해결/종료</span><div class="hint" style="height:36px;display:flex;align-items:center">${x.resolved_at ? '해결 ' + fmtShort(x.resolved_at) : '-'}${x.closed_at ? ' · 종료 ' + fmtShort(x.closed_at) : ''}</div></div>
      </div>
      <div class="dfield" style="margin-top:10px"><span>Resolution</span><div><textarea class="textarea" data-field="resolution" maxlength="2000" style="min-height:56px;font-size:14px" placeholder="해결 조치 내용" ${ro ? 'disabled' : ''}>${x.resolution}</textarea></div></div>
      <div class="dsave" id="dsave"></div>
      </section>
      <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>${raw(linkBlocks(x, ro, { WBS: '영향 WBS' }))}
      </section>
      <section data-pane="hist" ${dtab === 'hist' ? '' : 'hidden'}>${raw(histPane(x))}</section>
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(x.created_at)}`, label: 'Issue 보관' }))}`;
  };
  const detailRisk = () => {
    const x = sel; const ro = archived || Boolean(x.archived_at);
    const canConvert = !ro && ['OPEN', 'MONITORING', 'MATERIALIZED'].includes(x.status) && !x.converted_issue_id;
    return html`${raw(drawerHead(x.display_id, statusChip(RISK_STATUS, RISK_STATUS_CHIP, x.status) + sevBadge(x.risk_level) + (x.needs_review ? '<span class="chip chip--hold">Review 필요</span>' : ''), { archived: Boolean(x.archived_at) }))}
    ${raw(detailTabs(x))}
    <div class="drawer__b"><section data-pane="info" ${dtab === 'info' ? '' : 'hidden'}>
      <input class="dtitle" data-field="title" value="${x.title}" maxlength="200" ${ro ? 'disabled' : ''} aria-label="제목">
      ${raw(x.converted_issue_id ? html`<p class="srcline">전환된 Issue · <a class="link" href="/app/projects/${p.id}/issues?sel=${x.converted_issue_id}" data-link>${x.converted_issue_display_id} ${x.title}</a>${x.materialized_at ? ' · 발생 ' + fmtShort(x.materialized_at) : ''}</p>` : '')}
      <textarea class="textarea ddesc" data-field="description" maxlength="5000" placeholder="설명을 입력하세요." ${ro ? 'disabled' : ''}>${x.description}</textarea>
      <div class="matrix"><div><span>Probability</span><select class="select select--sm" data-field="probability" ${ro ? 'disabled' : ''}>${raw(opt(LEVEL3, x.probability))}</select></div><span class="matrix__x">×</span>
        <div><span>Impact</span><select class="select select--sm" data-field="impact" ${ro ? 'disabled' : ''}>${raw(opt(LEVEL3, x.impact))}</select></div><span class="matrix__x">=</span>
        <div><span>Risk Level</span><div style="height:36px;display:flex;align-items:center">${raw(sevBadge(x.risk_level))}</div></div></div>
      <div class="dgrid">
        <div class="dfield"><span>Status</span><div>${raw(statusSelect(RISK_STATUS, RISK_TRANSITIONS, x.status, ro))}</div></div>
        <div class="dfield"><span>대응 전략</span><div><select class="select select--sm" data-field="response_strategy" ${ro ? 'disabled' : ''}>${raw(opt(STRATEGY, x.response_strategy || '', '미정'))}</select></div></div>
        <div class="dfield"><span>담당자</span><div><select class="select select--sm" data-field="owner_user_id" ${ro ? 'disabled' : ''}>${raw(ownerOpts(x.owner_user_id || ''))}</select></div></div>
        <div class="dfield"><span>식별일</span><div><input class="input input--sm" type="date" data-field="identified_at" value="${x.identified_at || ''}" ${ro ? 'disabled' : ''}></div></div>
        <div class="dfield"><span>Review Date</span><div><input class="input input--sm" type="date" data-field="review_date" value="${x.review_date || ''}" ${ro ? 'disabled' : ''}></div></div>
      </div>
      <div class="dfield" style="margin-top:10px"><span>대응 계획 (Mitigation Plan)</span><div><textarea class="textarea" data-field="mitigation_plan" maxlength="5000" style="min-height:64px;font-size:14px" placeholder="완화·회피를 위해 할 일" ${ro ? 'disabled' : ''}>${x.mitigation_plan}</textarea></div></div>
      <div class="dsave" id="dsave"></div>
      ${raw(canConvert ? html`<div class="decision decision--review"><p><b>이 Risk가 실제로 발생했나요?</b> Issue로 전환하면 제목·설명·담당자·연결 항목이 복사되고 Risk는 '발생' 상태가 됩니다.</p><div class="actions" style="margin-top:0"><button class="btn btn--primary btn--sm" id="convert">Issue로 전환</button></div></div>` : '')}
      </section>
      <section data-pane="links" ${dtab === 'links' ? '' : 'hidden'}>${raw(linkBlocks(x, ro, { WBS: '영향 가능 WBS' }))}
      </section>
      <section data-pane="hist" ${dtab === 'hist' ? '' : 'hidden'}>${raw(histPane(x))}</section>
    </div>
    ${raw(drawerFoot({ ro, meta: `등록 ${fmtShort(x.created_at)}`, label: 'Risk 보관' }))}`;
  };

  const bind = () => {
    main.querySelectorAll('[data-tab]').forEach((b) => b.onclick = async () => { const next = b.dataset.tab; if (next === tab()) return; for (const k of ['q', ...ISSUE_F, ...RISK_F, 'archived', 'sel', 'new']) setParam(k, ''); setParam('tab', next === 'risks' ? 'risks' : ''); sel = null; creating = false; await load(); draw(); });
    const qi = $('#q'); let qt;
    if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { setParam('q', qi.value.trim()); await load(); draw(); $('#q').focus(); $('#q').setSelectionRange(99, 99); }, 350); };
    main.querySelectorAll('[data-f]').forEach((sl) => sl.onchange = async () => { setParam(sl.dataset.f, sl.value); await load(); draw(); });
    main.querySelectorAll('[data-t]').forEach((cb) => cb.onchange = async () => { setParam(cb.dataset.t, cb.checked ? '1' : ''); await load(); draw(); });
    const ar = $('#arch'); if (ar) ar.onchange = async () => { setParam('archived', ar.checked ? '1' : ''); await load(); draw(); };
    bindFilterClears(main, { setParam, keys: ['q', ...filterKeys(), 'archived'], reload: async () => { await load(); draw(); } });
    for (const ida of ['add', 'add2']) { const b = $('#' + ida); if (b) b.onclick = () => { creating = true; sel = null; setParam('sel', ''); setParam('new', '1'); draw(); $('#c-title').focus(); }; }
    main.querySelectorAll('[data-row]').forEach((tr) => tr.onclick = async () => { creating = false; dtab = 'info'; setParam('new', ''); await loadSel(tr.dataset.row); draw(); });
    const close = () => { creating = false; sel = null; setParam('sel', ''); setParam('new', ''); draw(); };
    for (const idc of ['dclose', 'dcancel']) { const b = $('#' + idc); if (b) b.onclick = close; }
    bindEscape(() => { if (sel || creating) close(); });
    if (creating) bindCreate(); else if (sel) bindDetail();
  };
  const bindCreate = () => {
    const form = $('#cf');
    form.querySelectorAll('[data-mx]').forEach((sl) => sl.onchange = () => { $('#c-level').innerHTML = sevBadge(riskLevel(form.probability.value, form.impact.value)); });
    form.onsubmit = async (e) => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(form));
      if (!d.title.trim()) return showErrors(form, { title: '제목을 입력해 주세요.' });
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try { const r = await api('POST', xApi(), d); const x = r[key()]; toast(`${x.display_id}을 등록했습니다.`); creating = false; setParam('new', ''); sel = x; setParam('sel', x.id); await load(); draw(); }
      catch (err) { btn.disabled = false; showErrors(form, err.fields, err.message); }
    };
  };
  const bindDetail = () => {
    const x = sel; const status = $('#dsave');
    bindDtabs(main.querySelector('.drawer'), (k) => { dtab = k; });
    const apply = async (d) => { sel = d[key()]; is = d.issues; rs = d.risks; g.issues = is; g.risks = rs; await load(); draw(); };
    const save = async (field, value) => {
      status.textContent = '저장 중…';
      try { const d = await api('PATCH', xApi(`/${x.id}`), { [field]: value }); await apply(d); $('#dsave').textContent = d.changed.length ? '저장됨' : ''; }
      catch (e) { const m = e.fields ? Object.values(e.fields)[0] : e.message; status.textContent = m; toast(m); draw(); }
    };
    main.querySelectorAll('.drawer [data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.tagName === 'SELECT' || el.type === 'date') el.onchange = async () => {
        if (field === 'status' && isIssue() && el.value === 'RESOLVED') {
          const note = await promptDialog({ title: `${x.display_id} 해결 처리`, body: '어떻게 해결했는지 적어두면 나중에 같은 문제를 다룰 때 도움이 됩니다.', label: 'Resolution', placeholder: '예: Mock API 기반으로 우선 개발 후 실제 API 연동 완료', confirm: '해결 처리' });
          if (note === null) { el.value = x.status; return; }
          status.textContent = '저장 중…';
          try { await apply(await api('PATCH', xApi(`/${x.id}`), { status: 'RESOLVED', resolution: note || x.resolution })); toast('해결 처리했습니다.'); } catch (e) { toast(e.message); draw(); }
          return;
        }
        save(field, el.value);
      };
      else { el.onblur = () => { const v = el.value.trim(); if (v !== (x[field] || '')) save(field, v); }; if (el.tagName !== 'TEXTAREA') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); }; }
    });
    main.querySelectorAll('[data-link-add]').forEach((b) => b.onclick = async () => {
      const t = b.dataset.linkAdd; const list = t === 'WBS' ? x.links.wbs : t === 'REQUIREMENT' ? x.links.requirements : x.links.changes;
      const have = new Set(list.filter((l) => !l.archived_at).map((l) => l.target_id));
      let rows2; let render; let keys;
      if (t === 'WBS') { rows2 = (await api('GET', wsApi(`/${id}/wbs`))).items; keys = ['wbs_code', 'title']; render = (w) => html`<span class="mono wcode">${w.wbs_code}</span><span class="pick__t" style="padding-left:${w.depth * 14}px">${w.title}</span><small class="dim">${WBS_TYPE[w.item_type]}</small><span class="chip ${WBS_STATUS_CHIP[w.status] || ''}">${WBS_STATUS[w.status]}</span>${raw(w.disabled ? '<small class="dim">연결됨</small>' : '')}`; }
      else if (t === 'REQUIREMENT') { rows2 = (await api('GET', wsApi(`/${id}/requirements`))).requirements; keys = ['display_id', 'title']; render = (r) => html`<span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span>${raw(r.disabled ? '<small class="dim">연결됨</small>' : '')}`; }
      else { rows2 = (await api('GET', wsApi(`/${id}/changes`))).changes; keys = ['display_id', 'title']; render = (c) => html`<span class="mono">${c.display_id}</span><span class="pick__t">${c.title}</span><span class="chip ${CR_STATUS_CHIP[c.status] || ''}">${CR_STATUS[c.status]}</span>${raw(c.disabled ? '<small class="dim">연결됨</small>' : '')}`; }
      const pk = await pickerDialog({ title: `${x.display_id}에 ${t === 'WBS' ? 'WBS' : t === 'REQUIREMENT' ? '요구사항' : '변경 요청'} 연결`, placeholder: '번호 또는 제목 검색', withType: false, rows: rows2.map((r) => ({ ...r, disabled: have.has(r.id) })), searchKeys: keys, render });
      if (!pk) return;
      try { await apply(await api('POST', xApi(`/${x.id}/links`), { target_type: t, target_id: pk.id })); toast('연결했습니다.'); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
    });
    main.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog({ title: '연결을 해제할까요?', body: '연결 관계만 제거되며 항목 자체는 그대로 남습니다.', confirm: '연결 해제', danger: true }))) return;
      try { await apply(await api('DELETE', xApi(`/${x.id}/links/${b.dataset.unlink}`))); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message); }
    });
    const cv = $('#convert');
    if (cv) cv.onclick = async () => {
      if (!(await confirmDialog({ title: '이 Risk가 실제 Issue로 발생했나요?', body: `${x.display_id}의 제목·설명·담당자·연결 항목을 복사해 새 Issue를 만들고, Risk 상태를 '발생'으로 바꿉니다.`, confirm: 'Issue로 전환' }))) return;
      try { const d = await api('POST', xApi(`/${x.id}/convert`), {}); toast(`${d.issue.display_id} Issue를 생성했습니다.`); setParam('tab', ''); setParam('sel', d.issue.id); sel = d.issue; dtab = 'info'; await load(); draw(); }
      catch (e) { toast(e.message); }
    };
    const ab = $('#xarchive');
    if (ab) ab.onclick = async () => {
      if (!(await confirmDialog({ title: `${x.display_id}을 보관할까요?`, body: '보관된 항목은 기본 목록에서 숨겨지고 수정할 수 없습니다. 번호는 재사용되지 않고 연결 관계는 보존됩니다.', confirm: '보관하기', danger: true }))) return;
      try { await apply(await api('POST', xApi(`/${x.id}/archive`), {})); toast('보관했습니다.'); } catch (e) { toast(e.message); }
    };
  };

  await load();
  const initSel = params().get('sel');
  if (initSel && !creating) { try { await loadSel(initSel); } catch { setParam('sel', ''); } }
  draw();
  if (creating) { const t = $('#c-title'); if (t) t.focus(); }
}
/** Mirrors server/raid.js computeRiskLevel for live preview only; the server value is authoritative. */
export const riskLevel = (pr, im) => ({ LOW: { LOW: 'LOW', MEDIUM: 'LOW', HIGH: 'MEDIUM' }, MEDIUM: { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' }, HIGH: { LOW: 'MEDIUM', MEDIUM: 'HIGH', HIGH: 'CRITICAL' } })[pr]?.[im] || 'MEDIUM';

