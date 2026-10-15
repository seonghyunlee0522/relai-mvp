/* Jira integration UI pieces (Phase 12): status chips, execution summary, the WBS "Jira 실행" pane, the project mapping modal.
 * Everything renders from RELAI's snapshots — no Jira call from the browser. Jira execution is shown apart from WBS progress. */
import { api, wsApi } from '../core/api.js';
import { isPhone } from '../core/device.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { confirmDialog, toast } from './dialogs.js';

export const JIRA_CAT = { new: '할 일', indeterminate: '진행 중', done: '완료' };
export const JIRA_CAT_CHIP = { new: 'chip--muted', indeterminate: 'chip--active', done: 'chip--done' };
export const relTime = (iso) => { if (!iso) return '-'; const d = Date.now() - new Date(iso).getTime(); const m = Math.round(d / 60000); if (m < 1) return '방금'; if (m < 60) return `${m}분 전`; const h = Math.round(m / 60); if (h < 24) return `${h}시간 전`; const dd = Math.round(h / 24); return dd < 30 ? `${dd}일 전` : fmtShort(iso); };
/** "3 / 5 Done · 60%" — compact, used by grid column, group summaries, trace strips. */
export const execText = (s) => (!s || !s.total ? '' : `${s.done} / ${s.total} 완료${s.rate === null ? '' : ` · ${s.rate}%`}`);
export const execChip = (s) => (!s || !s.total ? '' : html`<span class="jx ${s.done === s.total ? 'is-done' : s.in_progress ? 'is-run' : ''}" title="지라 실행률 (WBS 진행률과 별개)">${s.done}/${s.total}<small>완료</small>${raw(s.missing ? html`<em title="지라에서 찾을 수 없는 이슈 ${s.missing}개">!</em>` : '')}</span>`);
const catChip = (l) => (l.status === 'MISSING' ? '<span class="chip chip--fail">찾을 수 없음</span>' : html`<span class="chip ${JIRA_CAT_CHIP[l.status_category] || 'chip--muted'}" title="${JIRA_CAT[l.status_category] || ''}">${l.status_name || JIRA_CAT[l.status_category] || '-'}</span>`);
const issueRow = (l, ro) => html`<li class="jrow ${l.status !== 'ACTIVE' ? 'is-missing' : ''}" data-jlink="${l.id}">
  <a class="mono jrow__k" href="${l.browser_url || '#'}" target="_blank" rel="noopener noreferrer" ${l.browser_url ? '' : 'data-nolink'}>${l.external_key}</a>
  <span class="jrow__t">${l.summary || ''}${raw(l.issue_type ? html`<small class="dim"> · ${l.issue_type}</small>` : '')}${raw(l.link_role === 'EPIC' ? ' <span class="chip chip--muted">에픽</span>' : '')}</span>
  ${raw(catChip(l))}<span class="jrow__a ${l.assignee_name ? '' : 'dim'}">${l.assignee_name || '미지정'}</span><time class="dim" title="${l.external_updated_at || ''}">${relTime(l.external_updated_at || l.synced_at)}</time>
  ${raw(ro ? '' : html`<button type="button" class="def__x" data-junlink="${l.id}" title="연결 해제 (지라 이슈는 삭제되지 않습니다)" aria-label="연결 해제">×</button>`)}</li>`;

/** WBS detail → "Jira 실행" pane. `it` = tree node (needs id, is_group, item_type, wbs_code, title). */
export function jiraPaneHtml(d, it, { ro = false } = {}) {
  if (!d) return '<p class="hint" style="padding:12px 2px">불러오는 중…</p>';
  if (!d.mapped) return html`<div class="empty-inline"><b>이 프로젝트는 아직 지라 프로젝트와 연결되지 않았습니다.</b><span>헤더의 ⋯ 메뉴 → <b>지라 연동 설정</b>에서 지라 프로젝트를 연결하면 이 작업의 실제 실행(지라 이슈)을 여기서 볼 수 있습니다. (워크스페이스 소유자·관리자)</span></div>`;
  const m = d.mapping; const s = d.summary; const ms = it.item_type === 'MILESTONE'; const group = it.is_group;
  const exec = d.links.filter((l) => l.link_role === 'EXECUTION'); const epics = d.links.filter((l) => l.link_role === 'EPIC');
  const head = html`<div class="jhead"><span class="dim">지라</span><b>${m.external_project_key}</b><span class="dim">${m.external_project_name}</span>${raw(m.connection_status !== 'ACTIVE' ? '<span class="chip chip--fail">연결 확인 필요</span>' : '')}${raw(d.paused ? '<span class="chip chip--hold">보관됨 · 동기화 제외</span>' : '')}
    ${raw(ro ? '' : html`<button type="button" class="link linkbtn" id="jrefresh" style="margin-left:auto;width:auto">새로고침</button>`)}</div>`;
  if (ms) return html`${raw(head)}<p class="hint">주요 일정에는 지라 이슈를 연결하지 않습니다. 실제 개발 작업(하위 작업)에 연결하세요.</p>`;
  if (group) {
    return html`${raw(head)}
      <div class="jsum"><div><span>하위 작업 연결 지라</span><b>${s.total}</b></div><div><span>완료</span><b>${s.done}</b></div><div><span>진행 중</span><b>${s.in_progress}</b></div><div><span>할 일</span><b>${s.todo}</b></div><div class="jsum__r"><span>지라 실행률</span><b>${s.rate === null ? '-' : s.rate + '%'}</b><small>WBS 진행률과 별개</small></div></div>
      <h4 class="dh">지라 에픽 <em>${epics.length}</em><small class="dim" style="margin-left:8px;font-weight:500;letter-spacing:0;text-transform:none">계층 연결용 · 실행률에는 포함되지 않습니다</small></h4>
      ${raw(epics.length ? html`<ol class="jlist">${raw(epics.map((l) => issueRow(l, ro)).join(''))}</ol>` : '<p class="hint">연결된 에픽이 없습니다.</p>')}
      ${raw(ro || !m.group_issue_type_name && !epics.length ? '' : '')}${raw(ro ? '' : html`<div class="actions" style="margin-top:8px"><button type="button" class="btn btn--secondary btn--sm" data-jlink-add="EPIC">이 상위 작업을 지라 에픽과 연결</button></div>`)}
      <p class="hint">실행 이슈는 하위 작업에 연결합니다. 상위 작업의 진행률·상태는 기존처럼 하위 작업을 합산합니다.</p>`;
  }
  return html`${raw(head)}
    ${raw(exec.length ? html`<ol class="jlist">${raw(exec.map((l) => issueRow(l, ro)).join(''))}</ol>
      <div class="jrate"><span>지라 실행률</span><b>${s.done} / ${s.total} 완료 · ${s.rate}%</b><small class="dim">WBS 진행률(${it.progress ?? 0}%)과는 별개 지표입니다${m.auto_complete_leaf_wbs ? ' · 모두 완료되면 자동 완료' : ''}</small>${raw(s.missing ? html`<em class="is-warn">지라에서 찾을 수 없는 이슈 ${s.missing}개 — 연결을 해제하거나 지라에서 확인하세요.</em>` : '')}</div>`
      : html`<div class="empty-inline"><b>아직 연결된 지라 이슈가 없습니다.</b><span>이 작업의 실제 실행에 해당하는 지라 이슈를 생성하거나, 이미 있는 이슈를 연결하세요. 여러 이슈를 연결할 수 있습니다.</span></div>`)}
    ${raw(ro ? '' : html`<div class="actions" style="margin-top:10px"><button type="button" class="btn btn--primary btn--sm" id="jcreate" ${m.leaf_issue_type_name ? '' : 'disabled title="지라 연동 설정에서 하위 작업의 이슈 유형을 먼저 지정하세요"'}>+ 지라 이슈 생성</button><button type="button" class="btn btn--secondary btn--sm" data-jlink-add="EXECUTION">+ 기존 지라 이슈 연결</button></div>`)}`;
}

/** Wires the pane. `ctx` = { pid, wbsId, it, onChange(d) }. */
export function bindJiraPane(root, ctx) {
  const U = wsApi(`/${ctx.pid}/wbs/${ctx.wbsId}/jira`);
  const rf = $('#jrefresh', root); if (rf) rf.onclick = async () => { rf.disabled = true; try { const r = await api('POST', `${U}/refresh`, {}); toast(r.run.items_total ? `지라 ${r.run.items_success}개 항목을 새로고침했습니다.` : '새로고침할 연결이 없습니다.'); ctx.onChange(r); } catch (e) { toast(e.message); rf.disabled = false; } };
  const cr = $('#jcreate', root); if (cr) cr.onclick = () => createIssueDialog(ctx);
  root.querySelectorAll('[data-jlink-add]').forEach((b) => b.onclick = () => linkIssuesDialog({ ...ctx, role: b.dataset.jlinkAdd }));
  root.querySelectorAll('[data-junlink]').forEach((b) => b.onclick = async () => {
    const row = b.closest('[data-jlink]'); const key = row?.querySelector('.jrow__k')?.textContent || '';
    if (!(await confirmDialog({ title: `${key} 연결을 해제할까요?`, body: 'RELAI의 연결만 제거됩니다. 지라 이슈는 삭제되거나 변경되지 않습니다.', confirm: '연결 해제', danger: true }))) return;
    try { const r = await api('DELETE', `${U}/links/${b.dataset.junlink}`); toast('연결을 해제했습니다.'); ctx.onChange(r); } catch (e) { toast(e.message); }
  });
}

function createIssueDialog(ctx) {
  const it = ctx.it;
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="jcT"><h3 id="jcT">지라 이슈 생성</h3>
    <p class="dialog__b">연결된 지라 프로젝트에 이슈를 만들고 이 작업(${it.wbs_code} ${it.title})의 실행으로 연결합니다. 설명에는 WBS 정보와 관련 요구사항, RELAI 링크가 들어갑니다.</p>
    <div class="field"><label>제목</label><input class="input" id="jc-summary" maxlength="255" value="[${it.wbs_code}] ${it.title}"></div>
    <div class="field"><label>설명 (선택) <small class="dim">비우면 WBS 설명을 사용합니다</small></label><textarea class="textarea" id="jc-desc" rows="4" maxlength="5000">${it.description || ''}</textarea></div>
    <div class="err" id="jc-err"></div>
    <div class="actions"><button class="btn btn--secondary" data-v="">취소</button><button class="btn btn--primary" id="jc-ok">생성 후 연결</button></div></div>`;
  document.body.append(el); $('#jc-summary', el).focus();
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target.closest('[data-v]') || e.target === el) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#jc-ok', el).onclick = async () => {
    const b = $('#jc-ok', el); b.disabled = true; $('#jc-err', el).textContent = '';
    try { const r = await api('POST', wsApi(`/${ctx.pid}/wbs/${ctx.wbsId}/jira/issues`), { summary: $('#jc-summary', el).value, description: $('#jc-desc', el).value }); toast(`지라 ${r.issue.external_key}을(를) 생성하고 연결했습니다.`); close(); ctx.onChange(r); }
    catch (e) { $('#jc-err', el).textContent = e.fields ? Object.values(e.fields)[0] : e.message; b.disabled = false; }
  };
}

/** Search the mapped Jira project and link several issues at once. WBS: issues already linked to another WBS cannot be selected.
 *  Requirement (ctx.rid): any issue of the mapped project may be linked; ones already on this requirement are disabled. */
function linkIssuesDialog(ctx) {
  const role = ctx.role || 'EXECUTION'; const picked = new Map(); const forReq = Boolean(ctx.rid);
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="jlT"><h3 id="jlT">${forReq ? '기존 이슈 연결' : role === 'EPIC' ? '지라 에픽 연결' : '기존 지라 이슈 연결'}</h3>
    <p class="dialog__b">${forReq ? `${ctx.r.display_id} ${ctx.r.title}과 관련된 지라 이슈를 고르세요. 여러 개를 선택할 수 있습니다.` : role === 'EPIC' ? `${ctx.it.wbs_code} ${ctx.it.title}(상위 작업)과 연결할 에픽을 고르세요. 계층 참고용이며 실행률에는 포함되지 않습니다.` : `${ctx.it.wbs_code} ${ctx.it.title}의 실제 실행에 해당하는 이슈를 고르세요. 여러 개를 선택할 수 있습니다. 하나의 이슈는 하나의 WBS에만 연결됩니다.`}</p>
    <input class="input" id="jl-q" placeholder="이슈 키(ABC-123) 또는 제목 검색 — 연결된 지라 프로젝트 안에서만 검색합니다" autocomplete="off">
    <div class="pick-list" id="jl-list"><p class="hint" style="padding:10px">검색어를 입력하거나 Enter로 최근 이슈를 불러오세요.</p></div>
    <div class="jl-sel" id="jl-sel"></div><div class="err" id="jl-err"></div>
    <div class="actions"><button class="btn btn--secondary" data-v="">취소</button><button class="btn btn--primary" id="jl-ok" disabled>연결</button></div></div>`;
  document.body.append(el); const q = $('#jl-q', el); q.focus();
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target.closest('[data-v]') || e.target === el) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const paintSel = () => { $('#jl-sel', el).innerHTML = picked.size ? html`<span class="dim">선택 ${picked.size}개:</span> ${raw([...picked.values()].map((i) => html`<span class="fchip">${i.external_key}<button type="button" data-unpick="${i.external_entity_id}" aria-label="제외">×</button></span>`).join(''))}` : ''; $('#jl-ok', el).disabled = !picked.size; el.querySelectorAll('[data-unpick]').forEach((b) => b.onclick = () => { picked.delete(b.dataset.unpick); paintSel(); paintList(); }); };
  let rows = [];
  const paintList = () => {
    const list = $('#jl-list', el);
    list.innerHTML = rows.length ? rows.map((i) => { const taken = !forReq && i.linked_wbs && i.linked_wbs.id !== ctx.wbsId; const mine = forReq ? (i.linked_requirements || []).some((x) => x.id === ctx.rid) : i.linked_wbs && i.linked_wbs.id === ctx.wbsId; const on = picked.has(i.external_entity_id);
      return html`<button type="button" class="pick ${taken || mine ? 'is-disabled' : ''} ${on ? 'is-sel' : ''}" data-pick="${i.external_entity_id}" ${taken || mine ? 'disabled' : ''}><span class="mono">${i.external_key}</span><span class="pick__t">${i.summary}<small class="dim"> · ${i.issue_type || ''}</small></span>${raw(catChip(i))}
        ${raw(taken ? html`<small class="jl-taken">연결됨 · WBS ${i.linked_wbs.wbs_code} ${i.linked_wbs.title}</small>` : mine ? '<small class="jl-taken">이미 이 항목에 연결됨</small>' : forReq && i.linked_wbs ? html`<small class="dim">WBS ${i.linked_wbs.wbs_code}</small>` : '')}</button>`; }).join('') : '<p class="hint" style="padding:10px">검색 결과가 없습니다.</p>';
    list.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { const i = rows.find((x) => x.external_entity_id === b.dataset.pick); if (picked.has(i.external_entity_id)) picked.delete(i.external_entity_id); else picked.set(i.external_entity_id, i); paintSel(); paintList(); });
  };
  let timer; const search = async () => { $('#jl-err', el).textContent = ''; try { rows = (await api('GET', wsApi(`/${ctx.pid}/integrations/jira/issues/search?q=${encodeURIComponent(q.value.trim())}`))).issues; paintList(); } catch (e) { $('#jl-err', el).textContent = e.message; } };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 350); };
  q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } };
  $('#jl-ok', el).onclick = async () => {
    const b = $('#jl-ok', el); b.disabled = true; $('#jl-err', el).textContent = '';
    try {
      const r = await api('POST', wsApi(forReq ? `/${ctx.pid}/requirements/${ctx.rid}/jira/links` : `/${ctx.pid}/wbs/${ctx.wbsId}/jira/links`), { issue_keys: [...picked.values()].map((i) => i.external_key), link_role: role });
      const ok = r.results.filter((x) => x.ok).length; const bad = r.results.filter((x) => !x.ok);
      toast(ok ? `지라 이슈 ${ok}개를 연결했습니다.${bad.length ? ` (${bad.length}개 제외)` : ''}` : (bad[0]?.error || '연결하지 못했습니다.'));
      if (bad.length && !ok) { $('#jl-err', el).textContent = bad.map((x) => `${x.key}: ${x.error}`).join(' / '); b.disabled = false; return; }
      close(); ctx.onChange(r);
    } catch (e) { $('#jl-err', el).textContent = e.fields ? Object.values(e.fields)[0] : e.message; b.disabled = false; }
  };
  search();
}

/* ---------- Project ⋯ → Jira 연동 설정 (modal) ---------- */
export async function openJiraProjectSettings(pid) {
  if (isPhone()) return;   // phone = view mode: Jira is PC-only
  document.querySelector('.scrim--jira')?.remove();
  const el = document.createElement('div'); el.className = 'scrim scrim--jira';
  el.innerHTML = '<div class="dialog dialog--wide" role="dialog" aria-modal="true"><h3>지라 연동 설정</h3><p class="hint">불러오는 중…</p></div>';
  document.body.append(el);
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const canManage = ['OWNER', 'ADMIN'].includes(state.workspace?.role);
  let d; let editing = false; let jp = []; let types = []; let sel = { key: '', leaf: '', group: '', auto: false, mark: false };
  const load = async () => { d = await api('GET', wsApi(`/${pid}/integrations/jira`)); };
  const statusChip = (c) => (!c ? '<span class="chip chip--muted">미연결</span>' : c.status === 'ACTIVE' ? '<span class="chip chip--done">정상</span>' : c.status === 'ERROR' ? html`<span class="chip chip--fail">${c.reconnect_required ? '재연결 필요' : '오류'}</span>` : html`<span class="chip chip--hold">${c.status}</span>`);
  const draw = () => {
    const c = d.connection; const m = d.mapping; const s = d.summary; const lr = d.last_run;
    const body = !d.configured ? '<div class="notice">지라 연동이 아직 서버에 설정되지 않았습니다. 운영자가 Atlassian 앱 정보(ATLASSIAN_CLIENT_ID 등)를 설정해야 합니다.</div>'
      : !c || c.status === 'DISABLED' ? html`<div class="empty-inline"><b>워크스페이스에 지라가 연결되어 있지 않습니다.</b><span>설정 → 연동에서 지라를 먼저 연결하세요. (워크스페이스 소유자·관리자)</span></div><div class="actions"><a class="btn btn--secondary btn--sm" href="/app/settings" data-link data-close>설정 → 연동</a></div>`
      : editing || !m ? mappingForm(c) : html`
        <dl class="jinfo">
          <dt>지라 사이트</dt><dd><a href="${c.site_url}" target="_blank" rel="noopener noreferrer">${c.site_url.replace(/^https?:\/\//, '')}</a></dd>
          <dt>지라 프로젝트</dt><dd><b>${m.external_project_key}</b> — ${m.external_project_name}</dd>
          <dt>프로젝트 키</dt><dd class="mono">${m.external_project_key}</dd>
          <dt>이슈 유형</dt><dd>하위 작업 → <b>${m.leaf_issue_type_name || '<span class="dim">미지정</span>'}</b> · 상위 작업 → <b>${m.group_issue_type_name || '<span class="dim">미지정 (에픽 연결 안 함)</span>'}</b></dd>
          <dt>연결 상태</dt><dd>${raw(statusChip(c))}${raw(c.last_error ? html` <small class="dim">${c.last_error}</small>` : '')}</dd>
          <dt>마지막 동기화</dt><dd>${c.last_synced_at ? `${relTime(c.last_synced_at)} (${new Date(c.last_synced_at).toLocaleString('ko-KR')})` : '아직 동기화 전'}${raw(lr ? html` <small class="dim">· 최근 실행 ${lr.trigger} ${lr.status} ${lr.items_success}/${lr.items_total}${lr.error_summary ? ` — ${lr.error_summary}` : ''}</small>` : '')}</dd>
          <dt>요구사항 구현 완료 표시</dt><dd>${m.auto_mark_requirements ? '<b>켜짐</b> — 요구사항에 연결된 지라 이슈가 모두 완료되면 \'구현 완료\'로 표시합니다 (요구사항 상태는 바꾸지 않습니다)' : '<b>꺼짐</b>'}</dd>
          <dt>하위 WBS 자동 완료</dt><dd>${m.auto_complete_leaf_wbs ? '<b>켜짐</b> — 연결된 지라 작업이 모두 완료되면 하위 WBS를 완료 처리합니다' : '<b>꺼짐</b>'}</dd>
          <dt>연결 현황</dt><dd>요구사항 연결 ${d.counts.requirements || 0}개 · 실행 이슈 ${d.counts.execution}개 (${s ? `완료 ${s.done} · 진행 중 ${s.in_progress} · 할 일 ${s.todo}` : '-'}) · 에픽 ${d.counts.epics}개${d.counts.missing ? html` · <span class="is-warn">찾을 수 없음 ${d.counts.missing}</span>` : ''}</dd>
        </dl>
        <div class="actions"><button type="button" class="btn btn--primary btn--sm" id="jp-sync">지금 동기화</button>${raw(canManage ? '<button type="button" class="btn btn--secondary btn--sm" id="jp-edit">연결 변경</button><button type="button" class="btn btn--ghost btn--sm is-danger" id="jp-remove">연결 해제</button>' : '')}<span class="sp"></span><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button></div>
        ${raw(d.activity && d.activity.length ? html`<details class="jact"><summary>최근 지라 활동 ${d.activity.length}</summary><ol>${raw(d.activity.map((a) => html`<li><time>${relTime(a.at)}</time><span>${a.summary}</span><small class="dim">${a.actor_name || '시스템'}</small></li>`).join(''))}</ol></details>` : '')}`;
    el.querySelector('.dialog').innerHTML = html`<h3>지라 연동 설정</h3><p class="dialog__b">RELAI 프로젝트 하나를 지라 프로젝트 하나와 연결합니다. 연결 후 요구사항과 WBS 하위 작업에서 지라 이슈를 만들거나 연결할 수 있고, 실행 상태는 RELAI에 동기화됩니다.</p>${raw(body)}`;
    bind();
  };
  const mappingForm = (c) => html`${raw(d.previous_mapping && !d.mapping ? html`<div class="notice">지라 프로젝트 연결이 해제되어 동기화되지 않습니다. (이전 연결: ${d.previous_mapping.external_project_key}) 기존 지라 연결 기록은 유지됩니다.</div>` : '')}
    ${raw(canManage ? html`<div class="field"><label>지라 프로젝트 <small class="dim">${c.site_url.replace(/^https?:\/\//, '')}</small></label><select class="select" id="jp-key">${raw(jp.length ? `<option value="">선택…</option>` + jp.map((p) => html`<option value="${p.key}" ${sel.key === p.key ? 'selected' : ''}>${p.key} — ${p.name}</option>`).join('') : '<option value="">불러오는 중…</option>')}</select></div>
      <div class="cols2"><div class="field"><label>하위 작업 → 이슈 유형</label><select class="select" id="jp-leaf" ${sel.key ? '' : 'disabled'}><option value="">선택…</option>${raw(types.map((t) => html`<option value="${t.id}" ${sel.leaf === t.id ? 'selected' : ''}>${t.name}</option>`).join(''))}</select></div>
        <div class="field"><label>상위 작업 → 이슈 유형 <small class="dim">(선택, 보통 에픽)</small></label><select class="select" id="jp-group" ${sel.key ? '' : 'disabled'}><option value="">연결 안 함</option>${raw(types.map((t) => html`<option value="${t.id}" ${sel.group === t.id ? 'selected' : ''}>${t.name}</option>`).join(''))}</select></div></div>
      <label class="toggle"><input type="checkbox" id="jp-auto" ${sel.auto ? 'checked' : ''}> 연결된 지라 작업이 모두 완료되면 하위 WBS 완료 (기본 꺼짐)</label>
      <label class="toggle"><input type="checkbox" id="jp-mark" ${sel.mark ? 'checked' : ''}> 지라 완료 시 요구사항 구현 완료로 표시 (기본 꺼짐 · 요구사항 상태는 바뀌지 않습니다)</label>
      <p class="hint">이슈 유형은 지라 프로젝트에서 실제로 생성 가능한 목록을 조회합니다. 지라 프로젝트에 추가 필수 필드가 있으면 이슈 생성 시 안내합니다.</p>
      <div class="err" id="jp-err"></div>
      <div class="actions"><button type="button" class="btn btn--primary btn--sm" id="jp-save" ${sel.key ? '' : 'disabled'}>${d.mapping ? '연결 저장' : '지라 프로젝트 연결'}</button>${raw(d.mapping ? '<button type="button" class="btn btn--secondary btn--sm" id="jp-cancel">취소</button>' : '')}<span class="sp"></span><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button></div>`
      : html`<div class="empty-inline"><b>아직 지라 프로젝트가 연결되지 않았습니다.</b><span>워크스페이스 소유자·관리자가 이 화면에서 지라 프로젝트를 연결할 수 있습니다.</span></div><div class="actions"><span class="sp"></span><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button></div>`)}`;
  const loadTypes = async () => { types = sel.key ? (await api('GET', wsApi(`/${pid}/integrations/jira/issue-types?project_key=${encodeURIComponent(sel.key)}`))).issue_types : []; if (!types.some((t) => t.id === sel.leaf)) sel.leaf = types.find((t) => /^(task|작업)$/i.test(t.name))?.id || types.find((t) => /story/i.test(t.name))?.id || ''; if (!types.some((t) => t.id === sel.group)) sel.group = types.find((t) => /epic/i.test(t.name))?.id || ''; };
  const bind = () => {
    const sync = $('#jp-sync', el); if (sync) sync.onclick = async () => { sync.disabled = true; sync.textContent = '동기화 중…'; try { const r = await api('POST', wsApi(`/${pid}/integrations/jira/sync`), {}); toast(r.run.status === 'SUCCESS' ? `지라 ${r.run.items_success}개 이슈를 동기화했습니다.` : r.run.status === 'PARTIAL' ? `${r.run.items_success}개 동기화, ${r.run.items_failed}개는 지라에서 찾을 수 없습니다.` : `동기화 실패: ${r.run.error_summary || ''}`); await load(); draw(); } catch (e) { toast(e.message); await load(); draw(); } };
    const ed = $('#jp-edit', el); if (ed) ed.onclick = async () => { editing = true; sel = { key: d.mapping.external_project_key, leaf: d.mapping.leaf_issue_type_id || '', group: d.mapping.group_issue_type_id || '', auto: d.mapping.auto_complete_leaf_wbs, mark: d.mapping.auto_mark_requirements }; draw(); try { jp = (await api('GET', wsApi(`/${pid}/integrations/jira/projects`))).projects; await loadTypes(); } catch (e) { toast(e.message); } draw(); };
    const cn = $('#jp-cancel', el); if (cn) cn.onclick = () => { editing = false; draw(); };
    const rm = $('#jp-remove', el); if (rm) rm.onclick = async () => { if (!(await confirmDialog({ title: '지라 프로젝트 연결을 해제할까요?', body: '동기화가 중단됩니다. 기존 지라 연결 기록과 WBS·요구사항 데이터는 삭제되지 않습니다. 지라 쪽 이슈도 변경되지 않습니다.', confirm: '연결 해제', danger: true }))) return; try { await api('DELETE', wsApi(`/${pid}/integrations/jira/mapping`)); toast('지라 프로젝트 연결을 해제했습니다.'); editing = false; await load(); draw(); } catch (e) { toast(e.message); } };
    const key = $('#jp-key', el); if (key) key.onchange = async () => { sel.key = key.value; sel.leaf = ''; sel.group = ''; try { await loadTypes(); } catch (e) { toast(e.message); types = []; } draw(); };
    const lf = $('#jp-leaf', el); if (lf) lf.onchange = () => { sel.leaf = lf.value; };
    const gr = $('#jp-group', el); if (gr) gr.onchange = () => { sel.group = gr.value; };
    const au = $('#jp-auto', el); if (au) au.onchange = () => { sel.auto = au.checked; };
    const mk = $('#jp-mark', el); if (mk) mk.onchange = () => { sel.mark = mk.checked; };
    const sv = $('#jp-save', el); if (sv) sv.onclick = async () => { sv.disabled = true; $('#jp-err', el).textContent = ''; try { d = await api('PUT', wsApi(`/${pid}/integrations/jira/mapping`), { external_project_key: sel.key, leaf_issue_type_id: sel.leaf || null, group_issue_type_id: sel.group || null, auto_complete_leaf_wbs: sel.auto, auto_mark_requirements: sel.mark }); toast('지라 프로젝트를 연결했습니다.'); editing = false; draw(); } catch (e) { $('#jp-err', el).textContent = e.fields ? Object.values(e.fields)[0] : e.message; sv.disabled = false; } };
  };
  try { await load(); if (!d.mapping && d.connection && d.connection.status !== 'DISABLED' && canManage) { draw(); try { jp = (await api('GET', wsApi(`/${pid}/integrations/jira/projects`))).projects; } catch (e) { toast(e.message); } } draw(); }
  catch (e) { el.querySelector('.dialog').innerHTML = html`<h3>지라 연동 설정</h3><p class="err">${e.message}</p><div class="actions"><button class="btn btn--secondary" data-close>닫기</button></div>`; }
}

/* ---------- Requirement ↔ Jira (v43): drawer pane, list cell, bulk create ---------- */
const canManageWs = () => ['OWNER', 'ADMIN'].includes(state.workspace?.role);
/** One sentence + one button for every state before a link is possible (no Jira on the server · workspace not connected · project not mapped). */
export function jiraEmptyHtml(d, { ro = false } = {}) {
  const mgr = canManageWs() && !ro && !isPhone();
  if (!d.configured) return '<div class="empty-inline" data-jira-empty="server"><b>지라 연동이 아직 서버에 설정되지 않았습니다.</b><span>운영자가 Atlassian 앱 정보를 설정하면 연결할 수 있습니다.</span></div>';
  if (!d.connected || d.reconnect_required) return html`<div class="empty-inline" data-jira-empty="connect"><b>${d.reconnect_required ? '지라 재연결이 필요합니다.' : '워크스페이스에 지라가 연결되어 있지 않습니다.'}</b>${raw(mgr ? '' : '<span>워크스페이스 소유자·관리자에게 연결을 요청하세요.</span>')}</div>${raw(mgr ? '<div class="actions"><button type="button" class="btn btn--primary btn--sm" data-jira-connect>지라 연결</button></div>' : '')}`;
  return html`<div class="empty-inline" data-jira-empty="map"><b>이 프로젝트에 연결된 지라 프로젝트가 없습니다.</b>${raw(mgr ? '' : '<span>워크스페이스 소유자·관리자에게 연결을 요청하세요.</span>')}</div>${raw(mgr ? '<div class="actions"><button type="button" class="btn btn--primary btn--sm" data-jira-map>지라 프로젝트 연결</button></div>' : '')}`;
}
export function bindJiraEmpty(root, pid) {
  const c = root.querySelector('[data-jira-connect]'); if (c) c.onclick = async () => { c.disabled = true; try { const r = await api('POST', `/api/workspaces/${state.workspace.id}/integrations/jira/connect`, {}); location.href = r.url; } catch (e) { toast(e.message); c.disabled = false; } };
  const m = root.querySelector('[data-jira-map]'); if (m) m.onclick = () => openJiraProjectSettings(pid);
}
/** Requirement drawer → Jira tab. `d` = GET …/requirements/:rid/jira. */
export function reqJiraPaneHtml(d, r, { ro = false } = {}) {
  if (!d) return '<p class="hint" style="padding:12px 2px">불러오는 중…</p>';
  if (d.error) return html`<p class="err">${d.error}</p>`;
  if (!d.mapped || !d.connected || d.reconnect_required) return jiraEmptyHtml(d, { ro });
  const m = d.mapping; const s = d.summary; const w = d.via_wbs;
  ro = ro || d.paused;
  return html`<div class="jhead"><span class="dim">지라</span><b>${m.external_project_key}</b><span class="dim">${m.external_project_name}</span>${raw(m.connection_status !== 'ACTIVE' ? '<span class="chip chip--fail">연결 확인 필요</span>' : '')}${raw(d.jira_done_at ? '<span class="chip chip--done" data-jira-done>구현 완료 (지라)</span>' : '')}
      ${raw(ro ? '' : '<button type="button" class="link linkbtn" id="rjrefresh" style="margin-left:auto;width:auto">새로고침</button>')}</div>
    ${raw(d.links.length ? html`<ol class="jlist" data-rjira-list>${raw(d.links.map((l) => issueRow(l, ro)).join(''))}</ol>
      <div class="jrate" data-jira-rate><span>지라 진행률</span><b>${s.done} / ${s.total} 완료 · ${s.rate}%</b><small class="dim">요구사항 상태와는 별개입니다${m.auto_mark_requirements ? ' · 모두 완료되면 구현 완료로 표시' : ''}</small>${raw(s.missing ? html`<em class="is-warn">지라에서 찾을 수 없는 이슈 ${s.missing}개 — 연결을 해제하거나 지라에서 확인하세요.</em>` : '')}</div>`
      : '<div class="empty-inline"><b>아직 연결된 지라 이슈가 없습니다.</b><span>이 요구사항을 개발할 지라 태스크를 만들거나, 이미 있는 이슈를 연결하세요.</span></div>')}
    ${raw(ro ? '' : html`<div class="actions" style="margin-top:10px"><button type="button" class="btn btn--primary btn--sm" id="rjcreate" ${m.issue_type_name ? '' : 'disabled title="지라 연동 설정에서 만들 이슈 유형을 먼저 지정하세요"'}>지라 태스크 만들기</button><button type="button" class="btn btn--secondary btn--sm" id="rjlink">기존 이슈 연결</button></div>`)}
    ${raw(w && w.total ? html`<p class="hint" data-jira-wbs>WBS를 통한 지라 실행: ${w.done} / ${w.total} 완료 (${w.wbs.filter((x) => x.jira).map((x) => x.wbs_code).join(', ')})</p>` : '')}`;
}
export function bindReqJiraPane(root, ctx) {
  if (!root) return;
  bindJiraEmpty(root, ctx.pid);
  const U = wsApi(`/${ctx.pid}/requirements/${ctx.rid}/jira`);
  const rf = $('#rjrefresh', root); if (rf) rf.onclick = async () => { rf.disabled = true; try { const r = await api('POST', `${U}/refresh`, {}); toast(r.run.items_total ? `지라 ${r.run.items_success}개 이슈를 새로고침했습니다.` : '새로고침할 연결이 없습니다.'); ctx.onChange(r.jira); } catch (e) { toast(e.message); rf.disabled = false; } };
  const cr = $('#rjcreate', root); if (cr) cr.onclick = () => createReqIssueDialog(ctx);
  const ln = $('#rjlink', root); if (ln) ln.onclick = () => linkIssuesDialog({ ...ctx, onChange: (r) => ctx.onChange(r.jira) });
  root.querySelectorAll('[data-junlink]').forEach((b) => b.onclick = async () => {
    const key = b.closest('[data-jlink]')?.querySelector('.jrow__k')?.textContent || '';
    if (!(await confirmDialog({ title: `${key} 연결을 해제할까요?`, body: 'RELAI의 연결만 제거됩니다. 지라 이슈는 삭제되거나 변경되지 않습니다.', confirm: '연결 해제', danger: true }))) return;
    try { const r = await api('DELETE', `${U}/links/${b.dataset.junlink}`); toast('연결을 해제했습니다.'); ctx.onChange(r.jira); } catch (e) { toast(e.message); }
  });
}
function createReqIssueDialog(ctx) {
  const r = ctx.r;
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="rjcT"><h3 id="rjcT">지라 태스크 만들기</h3>
    <p class="dialog__b">연결된 지라 프로젝트에 이슈를 만들고 ${r.display_id}에 연결합니다. 설명에는 요구사항 설명과 완료 조건, RELAI로 돌아오는 링크가 들어갑니다.</p>
    <div class="field"><label for="rjc-summary">제목</label><input class="input" id="rjc-summary" maxlength="255" value="${r.display_id} ${r.title}"></div>
    <div class="err" id="rjc-err"></div>
    <div class="actions"><button class="btn btn--secondary" data-v="">취소</button><button class="btn btn--primary" id="rjc-ok">만들고 연결</button></div></div>`;
  document.body.append(el); $('#rjc-summary', el).focus();
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target.closest('[data-v]') || e.target === el) close(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#rjc-ok', el).onclick = async () => {
    const b = $('#rjc-ok', el); b.disabled = true; $('#rjc-err', el).textContent = '';
    try { const x = await api('POST', wsApi(`/${ctx.pid}/requirements/${ctx.rid}/jira/issues`), { summary: $('#rjc-summary', el).value }); toast(`지라 ${x.issue.external_key}을(를) 만들고 연결했습니다.`); close(); ctx.onChange(x.jira); }
    catch (e) { $('#rjc-err', el).textContent = e.fields ? Object.values(e.fields)[0] : e.message; b.disabled = false; }
  };
}
/** List / trace cell: first key + status chip, "+n", and the 지라 진행률. `s` = list response jira.by[rid]. */
export const reqJiraCell = (s, { done = false } = {}) => {
  if (!s || !s.total) return '';
  const k = s.keys[0];
  return html`<span class="rjcell" title="${s.keys.map((x) => `${x.key} ${x.status_name || ''}`).join(' · ')}"><span class="mono">${k.key}</span>${raw(s.keys.length > 1 ? html`<small class="dim">+${s.keys.length - 1}</small>` : '')} ${raw(execChip(s))}${raw(done ? '<span class="chip chip--done">구현 완료</span>' : '')}</span>`;
};
/** Bulk 지라 태스크 만들기. Returns the server answer or null when cancelled. */
export async function bulkCreateReqIssues(pid, ids) {
  if (!(await confirmDialog({ title: `${ids.length}건의 지라 태스크를 만들까요?`, body: '선택한 요구사항마다 연결된 지라 프로젝트에 이슈를 하나씩 만들고 연결합니다. 이미 지라 이슈가 연결된 요구사항은 건너뜁니다.', confirm: '지라 태스크 만들기' }))) return null;
  const r = await api('POST', wsApi(`/${pid}/requirements/jira/bulk-create`), { ids });
  toast(r.created.length ? `지라 태스크 ${r.created.length}건을 만들었습니다.${r.skipped.length ? ` (${r.skipped.length}건 건너뜀: ${r.skipped[0].reason})` : ''}` : `만든 태스크가 없습니다. (${r.skipped[0]?.reason || '건너뜀'})`);
  return r;
}
