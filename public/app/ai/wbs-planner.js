/* AI Project WBS Planner (Phase 15) — wide wizard over /ai/wbs-plans:
 *   1 대상 확인 → 2 추가 확인 질문 → 3 AI WBS 초안 생성 → 4 초안 검토(Tree) → 5 Coverage 검토 → 6 WBS에 반영
 * The plan (requirements, questions, answers, draft, coverage) lives on the server so a refresh resumes where the user was.
 * Nothing touches real WBS until step 6; codes / sequence / links come from RELAI's own services. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { REQ_PRIORITY, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, REQ_TYPE } from '../shared/constants.js';
import { aiDialog, aiNotice, aiStatus, canRun, reportError, warningsHtml } from '../shared/ai.js';

const STEPS = ['대상 확인', '추가 확인', 'AI 초안 생성', '초안 검토', 'Coverage 검토', 'WBS 반영'];
const COV = { COVERED: ['✓', '충족', 'is-ok'], PARTIAL: ['△', '부분', 'is-warn'], MISSING: ['✕', '누락', 'is-crit'], NOT_APPLICABLE: ['–', '해당 없음', 'is-muted'], UNKNOWN: ['?', '미확인', 'is-muted'] };
const AREA_SHORT = { PROJECT_MANAGEMENT: '프로젝트 관리', ANALYSIS_DESIGN: '분석/설계', FUNCTIONAL_DEVELOPMENT: '기능 구현', NON_FUNCTIONAL: '비기능', INTERFACE: '인터페이스', DATA_MIGRATION: '데이터 이관', INFRASTRUCTURE: '인프라', SECURITY: '보안/권한', ENVIRONMENT: '환경 구성', TESTING: '테스트', UAT: 'UAT', DEPLOYMENT: '배포', CUTOVER: '전환', TRAINING: '교육', DOCUMENTATION: '산출물', OPERATION_HANDOVER: '운영 이관', STABILIZATION: '오픈/안정화', OTHER: '기타' };

export async function openWbsPlanner({ pid, onDone }) {
  const base = wsApi(`/${pid}/ai/wbs-plans`);
  const [st, reqRes, list] = await Promise.all([aiStatus(pid, { fresh: true }), api('GET', wsApi(`/${pid}/requirements`)), api('GET', base).catch(() => ({ active: null, plans: [] }))]);
  const reqs = reqRes.requirements.filter((r) => !r.archived_at);
  const d = aiDialog({ title: 'AI로 WBS 만들기', subtitle: '요구사항뿐 아니라 데이터 이관·인프라·연계·전환·교육 같은 프로젝트 수행 업무까지 확인해 전체 WBS 초안을 함께 만듭니다. 검토·선택한 항목만 WBS에 반영됩니다.', feature: 'WBS_GENERATION', status: st });
  d.el.querySelector('.dialog').classList.add('dialog--ai-xl');
  let plan = null; let step = 1; let items = []; let reqIndex = new Map();
  const picked = new Set(reqs.filter((r) => r.status === 'CONFIRMED').map((r) => r.id));
  const stepsBar = () => html`<ol class="wpz__steps" aria-label="진행 단계">${raw(STEPS.map((s, i) => html`<li class="${i + 1 === step ? 'is-cur' : i + 1 < step ? 'is-done' : ''}"><i>${i + 1 < step ? '✓' : i + 1}</i><span>${s}</span></li>`).join(''))}</ol>`;
  const foot = (left, right) => { d.foot.innerHTML = html`${raw(left || '')}<span class="aid__sp"></span><span class="aid__btns">${raw(right)}</span>`; };
  const loadItems = () => { items = (plan.draft?.items || []).map((i) => ({ ...i, selected: i.selected !== false })); reqIndex = new Map((plan.draft?.requirements || []).map((r) => [r.display_id, r])); };

  /* ---------- resume ---------- */
  if (list.active) {
    const a = list.active;
    const resume = await confirmDialog({ title: '진행 중인 AI WBS 초안이 있습니다', body: `${a.status === 'REVIEW' ? '검토 단계' : '질문 단계'}에서 멈춘 초안(${new Date(a.created_at).toLocaleString('ko-KR')})이 있습니다. 이어서 진행할까요? "새로 시작"을 선택하면 기존 초안은 취소됩니다.`, confirm: '이어서 진행' });
    if (resume) { plan = a; if (plan.status === 'REVIEW') { loadItems(); step = 4; } else step = 2; }
    else { try { await api('POST', `${base}/${a.id}/cancel`, {}); } catch { /* ignore */ } }
  }

  /* ---------- step 1: targets ---------- */
  const drawPick = () => {
    step = 1;
    d.body.innerHTML = html`${raw(stepsBar())}
      <div class="aid__sum"><b>어떤 요구사항을 기준으로 할까요?</b><span class="aid__sp"></span>
        <label class="toggle"><input type="radio" name="wp-mode" value="all" ${picked.size === reqs.length ? 'checked' : ''}> 전체 요구사항</label><label class="toggle"><input type="radio" name="wp-mode" value="sel" ${picked.size !== reqs.length ? 'checked' : ''}> 선택한 요구사항</label>
        <input class="input input--sm" id="wp-q" type="search" placeholder="ID, 제목 검색" style="max-width:200px"></div>
      ${raw(reqs.length ? html`<div class="pick-list pick-list--tall" id="wp-list">${raw(reqs.map((r) => html`<label class="pick ${picked.has(r.id) ? 'is-sel' : ''}" data-q="${(r.display_id + ' ' + r.title).toLowerCase()}"><input type="checkbox" data-pick="${r.id}" ${picked.has(r.id) ? 'checked' : ''}><span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><small class="dim">${REQ_TYPE[r.type]} · ${REQ_PRIORITY[r.priority]}</small><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span></label>`).join(''))}</div>`
        : '<div class="aempty">등록된 요구사항이 없습니다. 요구사항 없이도 프로젝트 수행 WBS(관리·환경·전환 등)는 제안할 수 있습니다.</div>')}
      <p class="hint">기본값은 확정(CONFIRMED) 요구사항입니다. 작성 중·검토 중 요구사항도 직접 선택할 수 있습니다. 보관된 요구사항은 제외됩니다.</p>${raw(aiNotice(st))}`;
    const paint = () => { const okRun = canRun(st, 'WBS_GENERATION'); foot(html`<span class="hint">${picked.size}건 선택 (최대 80건)${raw(okRun ? '' : ' · <em class="is-warn">AI 설정 또는 Credit을 확인해 주세요</em>')}</span>`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>취소</button><button type="button" class="btn btn--primary btn--sm" id="wp-next" ${okRun && picked.size <= 80 ? '' : 'disabled'}>다음: 추가 확인 질문</button>`); $('#wp-next', d.el).onclick = createPlan; };
    paint();
    const sync = () => { d.body.querySelectorAll('[data-pick]').forEach((cb) => { cb.checked = picked.has(cb.dataset.pick); cb.closest('.pick').classList.toggle('is-sel', cb.checked); }); d.body.querySelectorAll('[name=wp-mode]').forEach((r) => { r.checked = (r.value === 'all') === (picked.size === reqs.length); }); paint(); };
    d.body.querySelectorAll('[data-pick]').forEach((cb) => cb.onchange = () => { if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick); sync(); });
    d.body.querySelectorAll('[name=wp-mode]').forEach((r) => r.onchange = () => { if (r.value === 'all') reqs.forEach((x) => picked.add(x.id)); else picked.clear(); sync(); });
    const qi = $('#wp-q', d.el); if (qi) qi.oninput = () => { const t = qi.value.trim().toLowerCase(); d.body.querySelectorAll('.pick').forEach((p) => { p.hidden = Boolean(t) && !p.dataset.q.includes(t); }); };
  };
  const createPlan = async () => {
    d.busy(true, 'AI가 프로젝트 정의·요구사항·기존 WBS를 읽고 확인할 내용을 정리하는 중입니다…');
    try { const r = await api('POST', base, picked.size === reqs.length ? { all: true } : { requirement_ids: [...picked] }); plan = r.plan; drawQuestions(); }
    catch (e) { reportError(e); }
    finally { d.busy(false); }
  };

  /* ---------- step 2: questions ---------- */
  const drawQuestions = () => {
    step = 2;
    const qs = plan.questions; const an = plan.answers || {};
    const knownAreas = plan.areas.filter((a) => a.status !== 'UNKNOWN' && a.source !== 'INFERRED');
    d.body.innerHTML = html`${raw(stepsBar())}
      <div class="aid__sum"><b>추가 확인이 필요한 항목 ${qs.length}개</b><small class="dim"> · 프로젝트 정의와 요구사항으로 확인된 내용은 다시 묻지 않습니다</small></div>
      ${raw(knownAreas.length ? html`<div class="wpz__known">이미 확인된 영역: ${raw(knownAreas.map((a) => html`<span class="chip ${a.status === 'REQUIRED' ? 'chip--done' : 'chip--muted'}" title="${a.reason}">${AREA_SHORT[a.area] || a.area} · ${a.status === 'REQUIRED' ? '필요' : a.status === 'NOT_NEEDED' ? '불필요' : '가능'}</span>`).join(' '))}</div>` : '')}
      ${raw(qs.length ? html`<form id="wp-form" class="wpz__qs" novalidate>${raw(qs.map((q) => {
        const a = an[q.id] || {}; const chosen = new Set(q.type === 'MULTI' ? (a.value || []) : a.value ? [a.value] : []);
        const fu = new Set(a.followups || []);
        const opts = q.type === 'BOOLEAN' ? html`<label class="wpz__opt"><input type="radio" name="${q.id}" value="true" ${a.value === true ? 'checked' : ''}> 예</label><label class="wpz__opt"><input type="radio" name="${q.id}" value="false" ${a.value === false ? 'checked' : ''}> 아니오</label>`
          : q.type === 'TEXT' ? html`<input class="input input--sm" name="${q.id}" value="${a.value || ''}" maxlength="500" placeholder="짧게 입력">`
          : q.options.map((o) => html`<div class="wpz__optw"><label class="wpz__opt"><input type="${q.type === 'MULTI' ? 'checkbox' : 'radio'}" name="${q.id}" value="${o.id}" ${chosen.has(o.id) ? 'checked' : ''}> ${o.label}</label>
              ${raw(o.followups.length ? html`<div class="wpz__fu" data-fu="${q.id}:${o.id}" ${chosen.has(o.id) ? '' : 'hidden'}>${raw(o.followups.map((f) => html`<label class="wpz__opt wpz__opt--sm"><input type="checkbox" name="${q.id}__fu" value="${f.id}" ${fu.has(f.id) ? 'checked' : ''}> ${f.label}</label>`).join(''))}</div>` : '')}</div>`).join('');
        return html`<fieldset class="wpz__q" data-q="${q.id}"><legend><span class="chip chip--muted">${AREA_SHORT[q.area] || q.area}</span>${q.question}${raw(q.required ? ' <span class="req">*</span>' : '')}</legend>
          ${raw(q.help_text ? html`<p class="hint">${q.help_text}</p>` : '')}<div class="wpz__opts">${raw(opts)}</div>${raw(q.allow_other ? html`<input class="input input--sm" name="${q.id}__other" value="${a.other || ''}" maxlength="300" placeholder="기타 (직접 입력)">` : '')}
          <small class="wpz__why">${q.reason}</small><div class="err" data-for="${q.id}"></div></fieldset>`;
      }).join(''))}</form>` : '<div class="wpz__none"><b>추가로 확인할 내용이 없습니다.</b><p>프로젝트 정의와 요구사항에서 필요한 정보를 충분히 확인했습니다. 바로 초안을 생성할 수 있습니다.</p></div>')}`;
    foot(html`<button type="button" class="btn btn--secondary btn--sm" id="wp-back">← 대상 다시 선택</button>`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>나중에 이어하기</button><button type="button" class="btn btn--primary btn--sm" id="wp-gen">AI WBS 초안 생성 ${raw(st.costs?.WBS_GENERATION != null ? html`<small>(${st.costs.WBS_GENERATION} Credits)</small>` : '')}</button>`);
    $('#wp-back', d.el).onclick = async () => { try { await api('POST', `${base}/${plan.id}/cancel`, {}); } catch { /* ignore */ } plan = null; drawPick(); };
    d.body.querySelectorAll('.wpz__opts input[type=radio],.wpz__opts input[type=checkbox]').forEach((inp) => { if (/__fu$/.test(inp.name)) return; inp.onchange = () => { const q = inp.closest('.wpz__q'); q.querySelectorAll('[data-fu]').forEach((f) => { const [, oid] = f.dataset.fu.split(':'); const on = [...q.querySelectorAll(`input[name="${inp.name}"]`)].some((x) => x.checked && x.value === oid); f.hidden = !on; }); }; });
    $('#wp-gen', d.el).onclick = generate;
  };
  const collectAnswers = () => {
    const out = {}; const form = $('#wp-form', d.el); if (!form) return out;
    for (const q of plan.questions) {
      const els = [...form.querySelectorAll(`[name="${q.id}"]`)]; let value;
      if (q.type === 'BOOLEAN') { const c = els.find((e) => e.checked); value = c ? c.value === 'true' : null; }
      else if (q.type === 'TEXT') value = els[0]?.value.trim() || null;
      else if (q.type === 'MULTI') value = els.filter((e) => e.checked).map((e) => e.value);
      else { const c = els.find((e) => e.checked); value = c ? c.value : null; }
      const followups = [...form.querySelectorAll(`[name="${q.id}__fu"]`)].filter((e) => e.checked && !e.closest('[data-fu]').hidden).map((e) => e.value);
      const other = form.querySelector(`[name="${q.id}__other"]`)?.value.trim() || null;
      out[q.id] = { value, followups, other };
    }
    return out;
  };
  const generate = async () => {
    try {
      if (plan.questions.length) { const r = await api('PATCH', `${base}/${plan.id}/answers`, { answers: collectAnswers() }); plan = r.plan; }
    } catch (e) { if (e.fields) { d.body.querySelectorAll('.err[data-for]').forEach((el) => { el.textContent = e.fields[el.dataset.for] || ''; }); toast('필수 질문에 답해 주세요.'); return; } reportError(e); return; }
    step = 3; d.busy(true, 'AI가 전체 프로젝트 WBS 초안을 만드는 중입니다… (최대 60초)');
    try { const r = await api('POST', `${base}/${plan.id}/generate`, {}); plan = r.plan; loadItems(); d.busy(false); drawTree(r.run); }
    catch (e) { d.busy(false); reportError(e); drawQuestions(); }
  };

  /* ---------- step 4: tree review ---------- */
  const depthOf = (it) => { let n = 1; let p = it.parent_temp_id; let g = 0; while (p && g++ < 10) { const x = items.find((i) => i.temp_id === p); if (!x) break; n++; p = x.parent_temp_id; } return n; };
  const ordered = () => { const out = []; const seen = new Set(); const place = (it) => { if (seen.has(it.temp_id)) return; const p = it.parent_temp_id && items.find((i) => i.temp_id === it.parent_temp_id); if (p) place(p); seen.add(it.temp_id); out.push(it); }; items.forEach(place); return out; };
  const selectChain = (it) => { let p = it.parent_temp_id; let g = 0; while (p && g++ < 10) { const x = items.find((i) => i.temp_id === p); if (!x) break; x.selected = true; p = x.parent_temp_id; } };
  const edits = () => items.map((i) => ({ temp_id: i.temp_id, title: i.title, description: i.description, item_type: i.item_type, parent_temp_id: i.parent_temp_id, planned_duration_days: i.planned_duration_days, related_requirement_ids: i.related_requirement_ids, selected: i.selected }));
  const counts = () => { const s = items.filter((i) => i.selected); return { total: s.length, linked: s.filter((i) => i.related_requirement_ids.length).length, delivery: s.filter((i) => !i.related_requirement_ids.length && i.item_type !== 'MILESTONE').length, ms: s.filter((i) => i.item_type === 'MILESTONE').length }; };
  const drawTree = (run = null) => {
    step = 4; const list = ordered(); const c = counts();
    d.body.innerHTML = html`${raw(stepsBar())}
      <div class="aid__sum"><b>AI WBS 초안 ${list.length}건</b>${raw(run ? html`<small class="dim"> · ${run.credit_cost} Credits 사용 · 잔여 ${run.balance}</small>` : '')}<span class="aid__sp"></span>
        <span class="wpz__legend"><span class="chip chip--active">REQ</span> 요구사항 구현 <span class="chip chip--muted">수행</span> 프로젝트 수행 업무 <span class="chip chip--hold">유사</span> 기존 WBS와 유사</span>
        <label class="toggle"><input type="checkbox" id="wp-all" ${items.every((i) => i.selected) ? 'checked' : ''}> 전체 선택</label></div>
      ${raw(warningsHtml(plan.draft.warnings))}${raw(plan.draft.notes?.length ? html`<ul class="aid__notes">${raw(plan.draft.notes.map((n) => html`<li>${n}</li>`).join(''))}</ul>` : '')}
      <div class="wtree" id="wp-tree">${raw(list.map((it) => html`<div class="wtree__r ${it.selected ? 'is-sel' : ''} ${it.fix ? 'is-fix' : ''}" data-t="${it.temp_id}" style="--d:${depthOf(it) - 1}">
        <label class="aic__ck"><input type="checkbox" data-sel="${it.temp_id}" ${it.selected ? 'checked' : ''} aria-label="${it.title} 선택"></label>
        <select class="select select--xs" data-f="item_type" data-t="${it.temp_id}" aria-label="유형"><option value="TASK" ${it.item_type === 'TASK' ? 'selected' : ''}>작업</option><option value="MILESTONE" ${it.item_type === 'MILESTONE' ? 'selected' : ''}>마일스톤</option></select>
        <input class="input input--sm wtree__title" data-f="title" data-t="${it.temp_id}" value="${it.title}" maxlength="200" aria-label="업무명">
        <select class="select select--xs wtree__parent" data-f="parent_temp_id" data-t="${it.temp_id}" aria-label="상위 항목"><option value="">(최상위)</option>${raw(items.filter((p) => p.temp_id !== it.temp_id && p.item_type !== 'MILESTONE').map((p) => html`<option value="${p.temp_id}" ${p.temp_id === it.parent_temp_id ? 'selected' : ''}>${p.title}</option>`).join(''))}</select>
        <span class="wtree__meta"><span class="chip chip--muted" title="영역">${AREA_SHORT[it.project_area] || it.project_area}</span>${raw(it.related_requirement_ids.length ? it.related_requirement_ids.map((id) => html`<span class="chip chip--active" title="${reqIndex.get(id)?.title || ''}">${id}</span>`).join('') : it.item_type === 'MILESTONE' ? '' : '<span class="chip chip--muted">수행</span>')}${raw(it.similar_to ? html`<span class="chip chip--hold" title="${it.similar_to.title}">기존 ${it.similar_to.wbs_code}과 유사</span>` : '')}
          <input class="input input--xs wtree__dur" data-f="planned_duration_days" data-t="${it.temp_id}" type="number" min="0" max="365" value="${it.planned_duration_days ?? ''}" placeholder="일" title="AI 참고값 (일) — 실제 일정은 WBS에서 입력" aria-label="참고 기간">
          <button type="button" class="link linkbtn wtree__link" data-link-edit="${it.temp_id}" title="요구사항 연결 수정">연결</button></span>
      </div>`).join(''))}</div>
      <p class="hint">기간은 <b>AI 참고값</b>이며 실제 날짜·담당자는 생성 후 WBS 화면에서 입력합니다. 하위 항목을 선택하면 상위 항목이 함께 선택되고, 상위를 해제하면 하위 항목도 해제됩니다. 기존 WBS와 유사한 항목은 기본 해제되어 있습니다.</p>`;
    foot(html`<button type="button" class="btn btn--secondary btn--sm" id="wp-back2">← 질문 수정</button><span class="hint">선택 ${c.total}건 · 요구사항 연결 ${c.linked} · 수행 업무 ${c.delivery} · 마일스톤 ${c.ms}</span>`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>나중에 이어하기</button><button type="button" class="btn btn--primary btn--sm" id="wp-cov" ${c.total ? '' : 'disabled'}>다음: Coverage 검토</button>`);
    $('#wp-back2', d.el).onclick = async () => { await saveEdits(); drawQuestions(); };
    $('#wp-cov', d.el).onclick = async () => { if (await saveEdits()) drawCoverage(); };
    d.body.querySelectorAll('[data-sel]').forEach((cb) => cb.onchange = () => { const it = items.find((i) => i.temp_id === cb.dataset.sel); it.selected = cb.checked; if (cb.checked) selectChain(it); else { const off = (p) => items.filter((x) => x.parent_temp_id === p.temp_id).forEach((x) => { x.selected = false; off(x); }); off(it); } drawTree(); });
    $('#wp-all', d.el).onchange = (e) => { items.forEach((i) => { i.selected = e.target.checked; }); drawTree(); };
    d.body.querySelectorAll('[data-f]').forEach((el) => el.onchange = () => { const it = items.find((i) => i.temp_id === el.dataset.t);
      if (el.dataset.f === 'parent_temp_id') { const v = el.value || null; let p = v; let g = 0; while (p && g++ < 20) { if (p === it.temp_id) { toast('자기 자신의 하위로 옮길 수 없습니다.'); el.value = it.parent_temp_id || ''; return; } p = items.find((i) => i.temp_id === p)?.parent_temp_id || null; } it.parent_temp_id = v; if (it.selected) selectChain(it); drawTree(); }
      else if (el.dataset.f === 'planned_duration_days') it.planned_duration_days = el.value === '' ? null : Math.max(0, Math.min(365, Number(el.value) || 0));
      else if (el.dataset.f === 'item_type') { it.item_type = el.value; if (el.value === 'MILESTONE') items.filter((x) => x.parent_temp_id === it.temp_id).forEach((x) => { x.parent_temp_id = null; }); drawTree(); }
      else it[el.dataset.f] = el.value; });
    d.body.querySelectorAll('[data-link-edit]').forEach((b) => b.onclick = () => editLinks(items.find((i) => i.temp_id === b.dataset.linkEdit)));
  };
  const editLinks = (it) => {
    const all = [...reqIndex.values()]; const cur = new Set(it.related_requirement_ids);
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true"><h3>요구사항 연결 — ${it.title}</h3><div class="dialog__b"><div class="pick-list" style="max-height:300px">${raw(all.length ? all.map((r) => html`<label class="pick ${cur.has(r.display_id) ? 'is-sel' : ''}"><input type="checkbox" value="${r.display_id}" ${cur.has(r.display_id) ? 'checked' : ''}><span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span></label>`).join('') : '<div class="aempty">대상 요구사항이 없습니다.</div>')}</div><p class="hint">관리·인프라·교육 같은 수행 업무는 연결하지 않아도 됩니다.</p></div>
      <div class="actions"><button type="button" class="btn btn--secondary" data-v="0">취소</button><button type="button" class="btn btn--primary" data-v="1">적용</button></div></div>`;
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) { if (e.target === el) el.remove(); return; } if (b.dataset.v === '1') { it.related_requirement_ids = [...el.querySelectorAll('input:checked')].map((x) => x.value); } el.remove(); drawTree(); });
    document.body.append(el);
  };
  const saveEdits = async () => {
    d.busy(true, '검토 내용을 저장하고 Coverage를 계산하는 중…');
    try { const r = await api('POST', `${base}/${plan.id}/coverage`, { items: edits() }); plan = r.plan; loadItems(); return true; }
    catch (e) { const f = e.fields ? Object.values(e.fields)[0] : null; toast(f || e.message); return false; }
    finally { d.busy(false); }
  };

  /* ---------- step 5: coverage ---------- */
  const drawCoverage = () => {
    step = 5; const cov = plan.coverage; const rs = cov.requirement_summary; const c = counts();
    const fixable = cov.delivery_coverage.some((x) => x.status === 'MISSING' || (x.status === 'PARTIAL' && x.assessment === 'REQUIRED')) || rs.missing > 0;
    d.body.innerHTML = html`${raw(stepsBar())}
      <div class="wpz__cov">
        <section class="wpz__covc"><h4>Requirement Coverage</h4>
          ${raw(rs.total ? html`<div class="wpz__big"><b>${rs.percent}%</b><span>요구사항 ${rs.total}건 중 ${rs.covered}건 WBS 연결 · ${rs.missing}건 미연결</span><span class="pbar pbar--g"><i style="width:${rs.percent}%"></i></span></div>
            ${raw(rs.missing ? html`<ul class="wpz__miss">${raw(cov.requirement_coverage.filter((r) => r.status === 'MISSING').map((r) => html`<li><span class="mono">${r.display_id}</span> ${r.title}</li>`).join(''))}</ul>` : '<p class="wpz__ok">모든 대상 요구사항에 실행 WBS가 연결되었습니다.</p>')}` : '<p class="hint">대상 요구사항이 없습니다.</p>')}</section>
        <section class="wpz__covc"><h4>Project Delivery Coverage</h4>
          <ul class="wpz__areas">${raw(cov.delivery_coverage.filter((a) => a.status !== 'UNKNOWN' || a.assessment !== 'UNKNOWN').map((a) => { const [ic, lab, cls] = COV[a.status] || COV.UNKNOWN; return html`<li class="${cls}" title="${a.reason || ''}"><i>${ic}</i><span>${a.label}</span><small>${lab}${a.candidates ? ` · 후보 ${a.candidates}` : ''}${a.existing ? ` · 기존 ${a.existing}` : ''}${a.source === 'USER_ANSWER' ? ' · 답변 기준' : ''}</small></li>`; }).join(''))}</ul></section>
      </div>
      ${raw(cov.warnings.length ? html`<div class="aid__warn"><b>확인 필요</b><ul>${raw(cov.warnings.map((w) => html`<li>${w}</li>`).join(''))}</ul></div>` : '<p class="wpz__ok">Coverage 경고가 없습니다.</p>')}
      <div class="wpz__final"><b>반영 예정</b><span>WBS <b>${c.total}</b>개</span><span>요구사항 연결 <b>${c.linked}</b>개</span><span>프로젝트 수행 업무 <b>${c.delivery}</b>개</span><span>마일스톤 <b>${c.ms}</b>개</span></div>`;
    foot(html`<button type="button" class="btn btn--secondary btn--sm" id="wp-back3">← 초안 수정</button>${raw(fixable ? '<button type="button" class="btn btn--secondary btn--sm btn--ai" id="wp-fix">누락 작업 추가 제안</button>' : '')}`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>나중에 이어하기</button><button type="button" class="btn btn--primary btn--sm" id="wp-commit" ${c.total ? '' : 'disabled'}>WBS에 반영 (${c.total}건)</button>`);
    $('#wp-back3', d.el).onclick = () => drawTree();
    const fb = $('#wp-fix', d.el); if (fb) fb.onclick = async () => { d.busy(true, 'AI가 누락 영역의 작업 후보를 추가 제안하는 중…'); try { const r = await api('POST', `${base}/${plan.id}/fix`, {}); plan = r.plan; loadItems(); toast(`추가 후보 ${r.added.length}건을 초안에 넣었습니다. 검토 후 반영하세요.`); d.busy(false); drawTree(); } catch (e) { d.busy(false); reportError(e); } };
    $('#wp-commit', d.el).onclick = commit;
  };
  const commit = async () => {
    const c = counts();
    if (!(await confirmDialog({ title: `WBS ${c.total}건을 반영할까요?`, body: `선택한 항목이 실제 WBS로 생성되고 요구사항 연결 ${c.linked}건이 추가됩니다. 번호·순서는 RELAI가 정하며, 반영 후에는 WBS 화면에서 수정할 수 있습니다.`, confirm: 'WBS에 반영' }))) return;
    d.busy(true, 'WBS를 생성하는 중입니다…');
    try {
      const r = await api('POST', `${base}/${plan.id}/commit`, { items: edits() });
      toast(`WBS ${r.created.length}건을 생성하고 요구사항 연결 ${r.links}건을 추가했습니다.`);
      d.busy(false); d.close(); if (onDone) await onDone(r);
    } catch (e) { d.busy(false); const f = e.fields ? Object.values(e.fields)[0] : null; toast(f || e.message); }
  };

  if (step === 4) drawTree(); else if (step === 2) drawQuestions(); else drawPick();
}
