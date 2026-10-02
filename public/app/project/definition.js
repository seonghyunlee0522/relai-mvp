/* 프로젝트 정의 — the 착수 단계 work screen. Five structured sections (목표·성공 기준 / 범위 / 이해관계자 / 일정·마일스톤 / 운영 방식),
 * each saved on its own and completed on its own. Completion is the INITIATION step status, so the home reads one source.
 * Legacy step notes are shown read-only as 참고 기록; nothing is auto-interpreted into the structured fields. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw } from '../core/dom.js';
import { projectHead } from './guide.js';
import { confirmDialog, toast } from '../shared/dialogs.js';

const AUTH = { '': '-', DECIDER: '의사결정', APPROVER: '승인', CONSULTED: '협의', INFORMED: '공유' };
const OPS = [['meetings', '회의', '예: 주간 정례회의 매주 월 10시(고객·PM·개발 리드), 킥오프/중간보고/최종보고'], ['reporting', '보고', '예: 주간보고 매주 금 메일 발송, 월간 운영위원회 보고'], ['communication', '소통 채널', '예: Slack #pjt-채널, 공식 요청은 메일, 긴급은 전화'], ['decisions', '의사결정·에스컬레이션', '예: 범위 변경은 변경 요청으로 등록 후 고객 PM 승인, 일정 변경은 운영위원회 결정']];
const uid = () => Math.random().toString(36).slice(2, 10);

export async function definitionPage(id) {
  const main = $('#main');
  let [g, m] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/definition`))]);
  const p = g.project; const ro = p.status === 'ARCHIVED';
  document.title = `프로젝트 정의 — ${p.name} — RELAI`;
  // working copy per section (edits live here until 저장)
  let d = clone(m.definition); const dirty = new Set();
  const sec = (k) => m.sections.find((s) => s.key === k);

  const statusChip = (s) => (s.status === 'COMPLETED' ? (s.changed_after_completion ? '<span class="chip chip--hold">완료 후 수정됨</span>' : '<span class="chip chip--done">완료</span>') : s.ready ? '<span class="chip chip--active">작성됨 · 완료 대기</span>' : '<span class="chip chip--muted">작성 중</span>');
  const legacy = (s) => (s.legacy_note ? html`<details class="def__legacy"><summary>참고 기록 (이전 메모)</summary><pre>${s.legacy_note}</pre><small class="dim">이전 프로세스 화면에서 작성한 메모입니다. 구조화된 항목으로 옮길 내용이 있으면 위에 직접 입력하세요.</small></details>` : '');
  const listRows = (key, items, ph) => html`<ul class="def__list" data-list="${key}">${raw(items.map((it) => html`<li><input class="input input--sm" data-item="${key}" data-id="${it.id}" value="${it.text}" maxlength="500" placeholder="${ph}" ${ro ? 'disabled' : ''}>${raw(ro ? '' : html`<button type="button" class="def__x" data-del="${key}" data-id="${it.id}" aria-label="삭제">×</button>`)}</li>`).join(''))}</ul>
    ${raw(ro ? '' : html`<button type="button" class="link linkbtn def__add" data-add="${key}">+ 추가</button>`)}`;
  const foot = (s) => {
    const dirtyNow = dirty.has(s.key);
    return html`<div class="def__foot">
      <span class="def__meta">${raw(s.status === 'COMPLETED' ? html`${s.completed_by_name || ''} ${s.completed_at ? fmtShort(s.completed_at) : ''} 완료${s.changed_after_completion ? ' · 이후 내용이 수정되어 다시 확인이 필요합니다' : ''}` : s.ready ? '필요한 내용이 작성되었습니다. 확인 후 완료 처리하세요.' : html`<span class="is-warn">${s.missing[0]}</span>`)}</span>
      ${raw(ro ? '' : html`<span class="def__btns"><span class="def__save" data-savestat="${s.key}">${dirtyNow ? '저장되지 않은 변경' : ''}</span>
        <button type="button" class="btn ${dirtyNow ? 'btn--primary' : 'btn--secondary'} btn--sm" data-save="${s.key}">저장</button>
        ${raw(s.status === 'COMPLETED' ? (s.changed_after_completion ? html`<button type="button" class="btn btn--primary btn--sm" data-act="confirm" data-key="${s.key}" ${dirtyNow ? 'disabled' : ''}>다시 확인 완료</button>` : '') + html`<button type="button" class="btn btn--ghost btn--sm" data-act="reopen" data-key="${s.key}">완료 취소</button>`
          : html`<button type="button" class="btn btn--primary btn--sm" data-act="complete" data-key="${s.key}" ${s.ready && !dirtyNow ? '' : 'disabled'} title="${dirtyNow ? '먼저 저장하세요' : s.ready ? '' : s.missing[0]}">완료</button>`)}</span>`)}
    </div>`;
  };
  const section = (key, body) => { const s = sec(key); return html`<section class="def ${s.status === 'COMPLETED' ? 'is-done' : ''}" id="sec-${key}" data-sec="${key}">
    <div class="def__h"><h3>${s.title}</h3>${raw(statusChip(s))}<p>${s.description}</p></div>
    <div class="def__b">${raw(body)}${raw(legacy(s))}</div>${raw(foot(s))}</section>`; };

  const draw = () => {
    const done = m.progress.done; const u = `/app/projects/${p.id}`;
    main.innerHTML = html`<div class="page page--wide page--flow defp">
      ${raw(projectHead(p, g, { tab: 'definition' }))}
      ${raw(ro ? '<div class="notice">보관된 프로젝트입니다. 프로젝트 정의는 조회만 할 수 있습니다.</div>' : '')}
      <div class="defp__head">
        <div><h2>프로젝트 정의</h2><p>착수 단계에서 합의해야 할 내용을 항목별로 작성합니다. 일부만 작성해도 저장할 수 있고, 각 항목은 내용을 확인한 뒤 완료 처리합니다. 완료된 항목은 프로젝트 홈의 단계 준비율에 반영됩니다.</p></div>
        <div class="defp__prog"><b>${done} / ${m.progress.total}</b><span>항목 완료</span><span class="pbar"><i style="width:${m.progress.percent}%"></i></span>
          ${raw(m.needs_review.length ? html`<em class="is-warn">${m.needs_review.length}개 항목 재확인 필요</em>` : done === m.progress.total ? html`<em class="is-ok">착수 단계 준비 완료${g.current_phase && g.current_phase.phase_key === 'INITIATION' && g.next_phase ? ' · 홈에서 다음 단계로 이동할 수 있습니다' : ''}</em>` : '')}</div>
      </div>
      <div class="defp__grid">
        <nav class="defp__nav" aria-label="항목"><ol>${raw(m.sections.map((s) => html`<li class="${s.status === 'COMPLETED' ? (s.changed_after_completion ? 'is-warn' : 'is-done') : s.ready ? 'is-ready' : ''}"><a href="#sec-${s.key}" data-jump="${s.key}"><i>${s.status === 'COMPLETED' ? (s.changed_after_completion ? '!' : '✓') : m.sections.indexOf(s) + 1}</i>${s.label}</a></li>`).join(''))}</ol>
          <a class="link" href="${u}" data-link>← 프로젝트 홈</a></nav>
        <div class="defp__main">
          ${raw(section('GOALS', html`<div class="field"><label>프로젝트 목표</label><textarea class="textarea" data-f="goal" rows="3" maxlength="2000" placeholder="이 프로젝트로 달성하려는 결과를 1~3문장으로 적습니다. 예: 법무팀 계약 검토 리드타임을 50% 단축하는 AI 검토 시스템 구축" ${ro ? 'disabled' : ''}>${d.goal}</textarea></div>
            <div class="field"><label>성공 기준 <small class="dim">측정 가능한 완료·성공 조건</small></label>${raw(listRows('success_criteria', d.success_criteria, '예: 검토 요청 접수부터 결과 회신까지 평균 2영업일 이내'))}</div>`))}
          ${raw(section('SCOPE', html`<div class="cols2 def__cols"><div class="field"><label>수행 범위 <small class="dim">이번 프로젝트에서 하는 것</small></label>${raw(listRows('scope_in', d.scope_in, '예: 계약서 자동 검토 기능(국문 표준계약 5종)'))}</div>
            <div class="field"><label>제외 범위 <small class="dim">하지 않기로 한 것</small></label>${raw(listRows('scope_out', d.scope_out, '예: 영문 계약서, 기존 ERP 연동'))}</div></div>`))}
          ${raw(section('STAKEHOLDERS', html`<table class="def__tbl"><thead><tr><th>이름</th><th>조직</th><th>역할</th><th>담당 영역</th><th>의사결정 권한</th><th></th></tr></thead>
            <tbody>${raw(d.stakeholders.map((x) => html`<tr data-sh="${x.id}">
              <td><input class="input input--sm" data-shf="name" value="${x.name}" maxlength="100" placeholder="이름" ${ro ? 'disabled' : ''}></td>
              <td><input class="input input--sm" data-shf="org" value="${x.org}" maxlength="100" placeholder="고객사/부서/당사" ${ro ? 'disabled' : ''}></td>
              <td><input class="input input--sm" data-shf="role" value="${x.role}" maxlength="100" placeholder="예: 고객 PM, 현업 리더" ${ro ? 'disabled' : ''}></td>
              <td><input class="input input--sm" data-shf="area" value="${x.area}" maxlength="200" placeholder="예: 요구사항 확정, 검수" ${ro ? 'disabled' : ''}></td>
              <td><select class="select select--sm" data-shf="authority" ${ro ? 'disabled' : ''}>${raw(Object.entries(AUTH).map(([v, l]) => html`<option value="${v}" ${x.authority === v ? 'selected' : ''}>${l}</option>`).join(''))}</select></td>
              <td>${raw(ro ? '' : html`<button type="button" class="def__x" data-shdel="${x.id}" aria-label="삭제">×</button>`)}</td></tr>`).join(''))}
            ${raw(d.stakeholders.length ? '' : '<tr class="def__empty"><td colspan="6">아직 등록된 이해관계자가 없습니다. 고객 의사결정자, 고객 PM, 현업 담당자, 당사 PM·개발 리드 순으로 추가해 보세요.</td></tr>')}</tbody></table>
            ${raw(ro ? '' : '<button type="button" class="link linkbtn def__add" id="sh-add">+ 이해관계자 추가</button>')}
            <p class="hint">이름 또는 조직만 있어도 저장됩니다. 권한: 의사결정(최종 결정) · 승인(결재) · 협의(의견 수렴) · 공유(진행 상황 공유).</p>`))}
          ${raw(section('MILESTONES', html`<div class="def__dates"><span>프로젝트 기간</span><b>${fmtShort(m.project_dates.planned_start_date)} ~ ${fmtShort(m.project_dates.planned_end_date)}</b>${raw(ro ? '' : html`<a class="link" href="${u}/edit" data-link>정보 수정</a>`)}</div>
            <div class="field"><label>주요 일정 <small class="dim">계약·보고·검수 등 반드시 지켜야 할 시점</small></label>
              <ul class="def__list def__list--dates">${raw(d.key_dates.map((x) => html`<li data-kd="${x.id}"><input class="input input--sm" type="date" data-kdf="date" value="${x.date}" ${ro ? 'disabled' : ''}><input class="input input--sm" data-kdf="title" value="${x.title}" maxlength="200" placeholder="예: 킥오프, 중간보고, 최종 검수" ${ro ? 'disabled' : ''}>${raw(ro ? '' : html`<button type="button" class="def__x" data-kddel="${x.id}" aria-label="삭제">×</button>`)}</li>`).join(''))}</ul>
              ${raw(ro ? '' : '<button type="button" class="link linkbtn def__add" id="kd-add">+ 일정 추가</button>')}</div>
            <div class="field"><label>WBS 마일스톤 <small class="dim">일정 단계에서 WBS에 등록한 마일스톤 (여기서는 조회만)</small></label>
              ${raw(m.wbs_milestones.length ? html`<ul class="def__ms">${raw(m.wbs_milestones.map((x) => html`<li><a href="${u}/wbs?sel=${x.id}" data-link><i class="wms">◆</i><span class="mono">${x.wbs_code}</span>${x.title}<time>${x.milestone_date ? fmtShort(x.milestone_date) : '날짜 미정'}</time></a></li>`).join(''))}</ul>` : html`<p class="hint">아직 WBS 마일스톤이 없습니다. ${raw(ro ? '' : html`<a class="link" href="${u}/wbs?new=1&type=MILESTONE" data-link>WBS에서 마일스톤 추가</a>`)}</p>`)}</div>`))}
          ${raw(section('OPERATIONS', OPS.map(([k, label, ph]) => html`<div class="field"><label>${label}</label><textarea class="textarea" data-op="${k}" rows="2" maxlength="2000" placeholder="${ph}" ${ro ? 'disabled' : ''}>${d.operations[k] || ''}</textarea></div>`).join('')))}
          <section class="def def--memo" id="sec-MEMO"><div class="def__h"><h3>메모 <small class="dim">선택</small></h3><p>위 항목에 넣기 어려운 참고 사항을 자유롭게 적어둡니다.</p></div>
            <div class="def__b"><textarea class="textarea" data-f="memo" rows="4" maxlength="4000" ${ro ? 'disabled' : ''}>${d.memo}</textarea></div>
            ${raw(ro ? '' : html`<div class="def__foot"><span class="def__meta"></span><span class="def__btns"><span class="def__save" data-savestat="MEMO">${dirty.has('MEMO') ? '저장되지 않은 변경' : ''}</span><button type="button" class="btn ${dirty.has('MEMO') ? 'btn--primary' : 'btn--secondary'} btn--sm" data-save="MEMO">저장</button></span></div>`)}</section>
        </div>
      </div>
    </div>`;
    bind();
  };

  /* ---------- collect the working copy from the DOM (so re-render never loses typed text) ---------- */
  const collect = () => {
    const v = (sel) => { const el = main.querySelector(sel); return el ? el.value : undefined; };
    if (v('[data-f="goal"]') !== undefined) d.goal = v('[data-f="goal"]');
    for (const key of ['success_criteria', 'scope_in', 'scope_out']) d[key] = [...main.querySelectorAll(`[data-item="${key}"]`)].map((el) => ({ id: el.dataset.id, text: el.value }));
    d.stakeholders = [...main.querySelectorAll('tr[data-sh]')].map((tr) => { const o = { id: tr.dataset.sh }; tr.querySelectorAll('[data-shf]').forEach((el) => { o[el.dataset.shf] = el.value; }); return o; });
    d.key_dates = [...main.querySelectorAll('li[data-kd]')].map((li) => { const o = { id: li.dataset.kd }; li.querySelectorAll('[data-kdf]').forEach((el) => { o[el.dataset.kdf] = el.value; }); return o; });
    d.operations = { ...d.operations }; main.querySelectorAll('[data-op]').forEach((el) => { d.operations[el.dataset.op] = el.value; });
    if (v('[data-f="memo"]') !== undefined) d.memo = v('[data-f="memo"]');
  };
  const SECTION_FIELDS = { GOALS: ['goal', 'success_criteria'], SCOPE: ['scope_in', 'scope_out'], STAKEHOLDERS: ['stakeholders'], MILESTONES: ['key_dates'], OPERATIONS: ['operations'], MEMO: ['memo'] };
  const FIELD_SECTION = Object.fromEntries(Object.entries(SECTION_FIELDS).flatMap(([s, fs]) => fs.map((f) => [f, s])));
  const markDirty = (key) => { dirty.add(key); const st = main.querySelector(`[data-savestat="${key}"]`); if (st) st.textContent = '저장되지 않은 변경'; const b = main.querySelector(`[data-save="${key}"]`); if (b) { b.classList.add('btn--primary'); b.classList.remove('btn--secondary'); } const c = main.querySelector(`[data-act="complete"][data-key="${key}"], [data-act="confirm"][data-key="${key}"]`); if (c) { c.disabled = true; c.title = '먼저 저장하세요'; } };
  const refresh = async () => { g = await api('GET', wsApi(`/${id}`)); };
  const save = async (key) => {
    collect();
    const body = {}; for (const f of SECTION_FIELDS[key]) body[f] = d[f];
    const st = main.querySelector(`[data-savestat="${key}"]`); if (st) st.textContent = '저장 중…';
    try {
      m = await api('PUT', wsApi(`/${id}/definition`), body); d = { ...clone(m.definition), ...pickDirty(d, key) }; dirty.delete(key);
      await refresh(); keepScroll(draw); toast('저장했습니다.');
    } catch (e) { const msg = e.fields ? Object.values(e.fields)[0] : e.message; if (st) st.textContent = msg; toast(msg); }
  };
  // after a save of one section, keep other sections' unsaved edits in the working copy
  const pickDirty = (cur, savedKey) => { const o = {}; for (const k of dirty) if (k !== savedKey) for (const f of SECTION_FIELDS[k]) o[f] = cur[f]; return o; };
  const act = async (action, key) => {
    if (action === 'reopen' && !(await confirmDialog({ title: '완료를 취소할까요?', body: '작성한 내용은 그대로 남고, 이 항목만 다시 "작성 중"으로 바뀝니다.', confirm: '완료 취소' }))) return;
    try { const r = await api('POST', wsApi(`/${id}/definition/sections/${key}/${action}`), {}); g = r.guide; delete r.guide; m = r; d = { ...clone(m.definition), ...pickDirty(d, null) }; keepScroll(draw); toast(action === 'reopen' ? '완료를 취소했습니다.' : action === 'confirm' ? '다시 확인 완료 처리했습니다.' : '완료 처리했습니다.'); }
    catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message); }
  };

  const bind = () => {
    main.querySelectorAll('[data-save]').forEach((b) => b.onclick = () => save(b.dataset.save));
    main.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => act(b.dataset.act, b.dataset.key));
    main.querySelectorAll('[data-jump]').forEach((a) => a.onclick = (e) => { e.preventDefault(); const el = $(`#sec-${a.dataset.jump}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#sec-${a.dataset.jump}`); });
    // dirty tracking: any input inside a section marks that section
    main.oninput = (e) => { const s = e.target.closest('[data-sec]'); if (s) markDirty(s.dataset.sec); else if (e.target.closest('#sec-MEMO')) markDirty('MEMO'); };
    main.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => { collect(); d[b.dataset.add].push({ id: uid(), text: '' }); markDirty(FIELD_SECTION[b.dataset.add]); keepScroll(draw); const last = [...main.querySelectorAll(`[data-item="${b.dataset.add}"]`)].pop(); if (last) last.focus(); });
    main.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { collect(); d[b.dataset.del] = d[b.dataset.del].filter((x) => x.id !== b.dataset.id); markDirty(FIELD_SECTION[b.dataset.del]); keepScroll(draw); });
    const sa = $('#sh-add'); if (sa) sa.onclick = () => { collect(); d.stakeholders.push({ id: uid(), name: '', org: '', role: '', area: '', authority: '' }); markDirty('STAKEHOLDERS'); keepScroll(draw); const last = [...main.querySelectorAll('tr[data-sh] [data-shf="name"]')].pop(); if (last) last.focus(); };
    main.querySelectorAll('[data-shdel]').forEach((b) => b.onclick = () => { collect(); d.stakeholders = d.stakeholders.filter((x) => x.id !== b.dataset.shdel); markDirty('STAKEHOLDERS'); keepScroll(draw); });
    const ka = $('#kd-add'); if (ka) ka.onclick = () => { collect(); d.key_dates.push({ id: uid(), title: '', date: '' }); markDirty('MILESTONES'); keepScroll(draw); const last = [...main.querySelectorAll('li[data-kd] [data-kdf="date"]')].pop(); if (last) last.focus(); };
    main.querySelectorAll('[data-kddel]').forEach((b) => b.onclick = () => { collect(); d.key_dates = d.key_dates.filter((x) => x.id !== b.dataset.kddel); markDirty('MILESTONES'); keepScroll(draw); });
    // Enter in a list input adds the next row
    main.querySelectorAll('[data-item]').forEach((el) => el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = main.querySelector(`[data-add="${el.dataset.item}"]`); if (b) b.click(); } });
    // re-apply dirty markers after a re-render
    for (const k of dirty) markDirty(k);
  };
  const keepScroll = (fn) => { const y = window.scrollY; fn(); window.scrollTo(0, y); };
  draw();
  if (location.hash && location.hash.startsWith('#sec-')) { const el = $(location.hash); if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 50); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
