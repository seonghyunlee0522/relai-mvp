/* AI Project WBS Planner (Phase 15) — wide wizard over /ai/wbs-plans:
 *   1 대상 확인 → 2 추가 확인 질문 → 3 AI WBS 초안 생성 → 4 초안 검토(Tree) → 5 Coverage 검토 → 6 WBS에 반영
 * The plan (requirements, questions, answers, draft, coverage) lives on the server so a refresh resumes where the user was.
 * Nothing touches real WBS until step 6; codes / sequence / links come from RELAI's own services. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { REQ_PRIORITY, REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, REQ_TYPE, plannerDefaultReq } from '../shared/constants.js';
import { aiDialog, runLine, aiNotice, aiStatus, canRun, reportError, warningsHtml } from '../shared/ai.js';
import { allocateSchedule, inferPlanPhase, sameAsNode, nodesFor, nodeByPlan, FIXED_NODES } from '../shared/wbs-structure.js';
import { workdaysBetween, md } from '../shared/kst-date.js';

const STEPS = ['대상 확인', '추가 확인', 'AI 초안 생성', '초안 검토', '누락 검토', 'WBS 반영'];
const COV = { COVERED: ['✓', '충족', 'is-ok'], PARTIAL: ['△', '부분', 'is-warn'], MISSING: ['✕', '누락', 'is-crit'], NOT_APPLICABLE: ['–', '해당 없음', 'is-muted'], UNKNOWN: ['?', '미확인', 'is-muted'] };
const AREA_SHORT = { PROJECT_MANAGEMENT: '프로젝트 관리', ANALYSIS_DESIGN: '분석/설계', FUNCTIONAL_DEVELOPMENT: '기능 구현', NON_FUNCTIONAL: '비기능', INTERFACE: '인터페이스', DATA_MIGRATION: '데이터 이관', INFRASTRUCTURE: '인프라', SECURITY: '보안/권한', ENVIRONMENT: '환경 구성', TESTING: '테스트', UAT: '인수 테스트', DEPLOYMENT: '배포', CUTOVER: '전환', TRAINING: '교육', DOCUMENTATION: '산출물', OPERATION_HANDOVER: '운영 이관', STABILIZATION: '오픈/안정화', OTHER: '기타' };

export async function openWbsPlanner({ pid, onDone }) {
  const base = wsApi(`/${pid}/ai/wbs-plans`);
  const [st, reqRes, list] = await Promise.all([aiStatus(pid, { fresh: true }), api('GET', wsApi(`/${pid}/requirements`)), api('GET', base).catch(() => ({ active: null, plans: [] }))]);
  const reqs = reqRes.requirements.filter((r) => !r.archived_at);
  const d = aiDialog({ title: 'AI로 WBS 만들기', subtitle: '요구사항뿐 아니라 데이터 이관·인프라·연계·전환·교육 같은 프로젝트 수행 업무까지 확인해 전체 WBS 초안을 함께 만듭니다. 검토·선택한 항목만 WBS에 반영됩니다.', feature: 'WBS_GENERATION', status: st });
  d.el.querySelector('.dialog').classList.add('dialog--ai-xl', 'dialog--ai-sheet');   // batch7 #15: full sheet (min(1440px, 100vw−48px) × 100vh−48px)
  let plan = null; let step = 1; let items = []; let reqIndex = new Map();
  const picked = new Set(reqs.filter(plannerDefaultReq).map((r) => r.id)); const defaultCount = picked.size;
  const stepsBar = () => html`<ol class="wpz__steps" aria-label="진행 단계">${raw(STEPS.map((s, i) => html`<li class="${i + 1 === step ? 'is-cur' : i + 1 < step ? 'is-done' : ''}"><i>${i + 1 < step ? '✓' : i + 1}</i><span>${s}</span></li>`).join(''))}</ol>`;
  const foot = (left, right) => { d.foot.innerHTML = html`${raw(left || '')}<span class="aid__sp"></span><span class="aid__btns">${raw(right)}</span>`; };
  const loadItems = () => { items = (plan.draft?.items || []).map((i) => ({ ...i, selected: i.selected !== false })); reqIndex = new Map((plan.draft?.requirements || []).map((r) => [r.display_id, r])); };

  /* ---------- resume ---------- */
  if (list.active) {
    const a = list.active;
    // A backdrop click / Esc only closes (the plan stays and can be resumed later). Discarding needs 새로 시작 plus a second confirm,
    // because a REVIEW plan already cost credits for its draft.
    for (;;) {
      const resume = await confirmDialog({ title: '진행 중인 AI WBS 초안이 있습니다', body: `${a.status === 'REVIEW' ? '검토 단계' : '질문 단계'}에서 멈춘 초안(${new Date(a.created_at).toLocaleString('ko-KR')})이 있습니다. 이어서 진행할까요? "새로 시작"을 선택하면 기존 초안은 취소됩니다.`, confirm: '이어서 진행', cancel: '새로 시작', dismissable: true });
      if (resume === null) { d.close(); return; }
      if (resume) { plan = a; if (plan.status === 'REVIEW') { loadItems(); step = 4; } else step = 2; break; }
      const sure = await confirmDialog({ title: '기존 초안을 취소하고 새로 시작할까요?', body: a.status === 'REVIEW' ? '이미 생성된 AI 초안(크레딧 사용됨)이 취소되며 되돌릴 수 없습니다. 새 초안을 만들면 크레딧이 다시 차감됩니다.' : '답변한 추가 확인 질문이 모두 취소되며 되돌릴 수 없습니다.', confirm: '취소하고 새로 시작', cancel: '돌아가기', danger: true, dismissable: true });
      if (sure) { try { await api('POST', `${base}/${a.id}/cancel`, {}); } catch { /* ignore */ } break; }
    }
  }

  /* ---------- step 1: targets ---------- */
  const drawPick = () => {
    step = 1;
    d.body.innerHTML = html`${raw(stepsBar())}
      <div class="aid__sum"><b>어떤 요구사항을 기준으로 할까요?</b> <span class="chip chip--muted" id="wp-count">${picked.size} / ${reqs.length}건 선택</span><span class="aid__sp"></span>
        <label class="toggle"><input type="radio" name="wp-mode" value="all" ${picked.size === reqs.length ? 'checked' : ''}> 전체 요구사항</label><label class="toggle"><input type="radio" name="wp-mode" value="sel" ${picked.size !== reqs.length ? 'checked' : ''}> 선택한 요구사항</label>
        <input class="input input--sm" id="wp-q" type="search" placeholder="ID, 제목 검색" style="max-width:200px"></div>
      ${raw(reqs.length ? html`<div class="pick-list pick-list--tall" id="wp-list">${raw(reqs.map((r) => html`<label class="pick ${picked.has(r.id) ? 'is-sel' : ''}" data-q="${(r.display_id + ' ' + r.title).toLowerCase()}"><input type="checkbox" data-pick="${r.id}" ${picked.has(r.id) ? 'checked' : ''}><span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><small class="dim">${REQ_TYPE[r.type]} · ${REQ_PRIORITY[r.priority]}</small><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span></label>`).join(''))}</div>`
        : '<div class="aempty">등록된 요구사항이 없습니다. 요구사항 없이도 프로젝트 수행 WBS(관리·환경·전환 등)는 제안할 수 있습니다.</div>')}
      <p class="hint" id="wp-default">확정·작성 중(AI 추출 포함) 요구사항 ${defaultCount}건을 기본으로 선택했습니다. 반려·범위 외·보관된 요구사항은 제외됩니다. 검토 중·보류 요구사항은 직접 선택할 수 있습니다.</p>${raw(aiNotice(st))}`;
    const paint = () => { const okRun = canRun(st, 'WBS_GENERATION'); foot(html`<span class="hint">${picked.size}건 선택 (최대 80건)${raw(okRun ? '' : ' · <em class="is-warn">AI 설정 또는 크레딧을 확인해 주세요</em>')}</span>`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>취소</button><button type="button" class="btn btn--primary btn--sm" id="wp-next" ${okRun && picked.size <= 80 ? '' : 'disabled'}>다음: 추가 확인 질문</button>`); $('#wp-next', d.el).onclick = createPlan; };
    paint();
    const sync = () => { const cnt = $('#wp-count', d.el); if (cnt) cnt.textContent = `${picked.size} / ${reqs.length}건 선택`; d.body.querySelectorAll('[data-pick]').forEach((cb) => { cb.checked = picked.has(cb.dataset.pick); cb.closest('.pick').classList.toggle('is-sel', cb.checked); }); d.body.querySelectorAll('[name=wp-mode]').forEach((r) => { r.checked = (r.value === 'all') === (picked.size === reqs.length); }); paint(); };
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
    foot(html`<button type="button" class="btn btn--secondary btn--sm" id="wp-back">← 대상 다시 선택</button>`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>나중에 이어하기</button><button type="button" class="btn btn--primary btn--sm" id="wp-gen">AI WBS 초안 생성 ${raw(st.costs?.WBS_GENERATION != null ? html`<small>(${st.costs.WBS_GENERATION} 크레딧)</small>` : '')}</button>`);
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

  /* ---------- step 4: tree review (batch7 #15) — full sheet: tree under the fixed phase heads (left) + edit panel (right, 320px).
   * Rows are one line (check · 번호 · 제목 · 기간 · one chip); the rest lives in the panel. Dates are spread by rule (근무일, phase ratios —
   * public/app/shared/wbs-structure.js allocateSchedule), the same function the server runs on commit; '날짜 넣지 않기' turns it off. */
  const depthOf = (it) => { let n = 1; let p = it.parent_temp_id; let g = 0; while (p && g++ < 10) { const x = items.find((i) => i.temp_id === p); if (!x) break; n++; p = x.parent_temp_id; } return n; };
  const ordered = () => { const out = []; const seen = new Set(); const place = (it) => { if (seen.has(it.temp_id)) return; const p = it.parent_temp_id && items.find((i) => i.temp_id === it.parent_temp_id); if (p) place(p); seen.add(it.temp_id); out.push(it); }; items.forEach(place); return out; };
  const selectChain = (it) => { let p = it.parent_temp_id; let g = 0; while (p && g++ < 10) { const x = items.find((i) => i.temp_id === p); if (!x) break; x.selected = true; p = x.parent_temp_id; } };
  const edits = () => items.map((i) => ({ temp_id: i.temp_id, title: i.title, description: i.description, item_type: i.item_type, parent_temp_id: i.parent_temp_id, phase: i.phase ?? null, planned_duration_days: i.planned_duration_days, related_requirement_ids: i.related_requirement_ids, selected: i.selected }));
  const counts = () => { const s = items.filter((i) => i.selected); return { total: s.length, linked: s.filter((i) => i.related_requirement_ids.length).length, delivery: s.filter((i) => !i.related_requirement_ids.length && i.item_type !== 'MILESTONE').length, ms: s.filter((i) => i.item_type === 'MILESTONE').length }; };
  const topOf = (it) => { let x = it; let g = 0; while (x.parent_temp_id && g++ < 20) { const p = items.find((i) => i.temp_id === x.parent_temp_id); if (!p) break; x = p; } return x; };
  const phaseOf = (it) => inferPlanPhase(topOf(it));
  let sched = null; let datesOn = true; const phaseDays = {}; let selTemp = null; const folded = new Set(); let foldInit = false;
  const loadSched = async () => { if (sched) return; try { sched = await api('GET', `${base}/${plan.id}/schedule`); } catch { sched = { start: null, end: null, holidays: [] }; } sched.hol = new Map((sched.holidays || []).map((h) => [h.day, h.name])); datesOn = Boolean(sched.start); };
  /** The same input the server uses: chosen items, a parent kept only when it is chosen too. */
  const allocation = () => {
    const chosen = ordered().filter((i) => i.selected); const ids = new Set(chosen.map((i) => i.temp_id));
    const input = chosen.map((i) => ({ ...i, parent_temp_id: i.parent_temp_id && ids.has(i.parent_temp_id) ? i.parent_temp_id : null }));
    return allocateSchedule({ items: input, start: sched.start, end: sched.end, hol: sched.hol, withDm: sched.with_dm, phaseWorkdays: phaseDays });
  };
  const dper = (a, b) => (a ? `${md(a)}${b && b !== a ? `–${md(b)}` : ''}` : '');
  const drawTree = async (run = null) => {
    step = 4; await loadSched();
    const list = ordered(); const c = counts(); const alloc = datesOn && sched.start ? allocation() : null; const dates = alloc && alloc.ok ? alloc.dates : {};
    const withDm = sched.with_dm || list.some((i) => phaseOf(i) === 'DATA_MIGRATION');
    const heads = alloc && alloc.ok ? alloc.phases : nodesFor(withDm).map((n) => ({ plan: n.plan, title: n.title }));
    // a top-level group that only repeats its phase name is the phase itself (commit does the same) → its children show one level up
    const merged = new Set(list.filter((i) => !i.parent_temp_id && list.some((x) => x.parent_temp_id === i.temp_id) && sameAsNode(i.title) === phaseOf(i)).map((i) => i.temp_id));
    const lvl = (it) => depthOf(it) - (merged.has(topOf(it).temp_id) ? 1 : 0);
    if (!foldInit) { foldInit = true; for (const it of list) if (lvl(it) >= 2 && list.some((x) => x.parent_temp_id === it.temp_id)) folded.add(it.temp_id); }   // 단계 + 1·2레벨 open
    const hiddenBy = (it) => { let p = it.parent_temp_id; let g = 0; while (p && g++ < 20) { if (folded.has(p)) return true; p = items.find((i) => i.temp_id === p)?.parent_temp_id; } return folded.has(`PH:${phaseOf(it)}`); };
    const chip = (it) => (it.related_requirement_ids.length ? html`<span class="chip chip--active" title="${it.related_requirement_ids.map((d) => `${d} ${reqIndex.get(d)?.title || ''}`).join('\n')}">${it.related_requirement_ids[0]}${it.related_requirement_ids.length > 1 ? ` +${it.related_requirement_ids.length - 1}` : ''}</span>`
      : it.similar_to ? html`<span class="chip chip--hold" title="기존 ${it.similar_to.wbs_code} ${it.similar_to.title}">유사</span>` : it.item_type === 'MILESTONE' ? '' : '<span class="chip chip--muted">수행</span>');
    const rowHtml = (it, code) => { const dt = dates[it.temp_id]; const kids = list.some((x) => x.parent_temp_id === it.temp_id);
      const per = it.item_type === 'MILESTONE' ? (dt ? `◆ ${md(dt.milestone_date)}` : '') : dt ? `${dper(dt.planned_start_date, dt.planned_end_date)} · ${workdaysBetween(dt.planned_start_date, dt.planned_end_date, sched.hol)}일` : kids ? '' : it.planned_duration_days ? `참고 ${it.planned_duration_days}일` : '';
      return html`<div class="wpr ${it.selected ? 'is-sel' : ''} ${selTemp === it.temp_id ? 'is-cur' : ''} ${it.fix ? 'is-fix' : ''} ${kids ? 'is-grp' : ''}" data-t="${it.temp_id}" style="--l:${lvl(it) - 1}" role="row">
        <label class="wpr__ck"><input type="checkbox" data-sel="${it.temp_id}" ${it.selected ? 'checked' : ''} aria-label="${it.title} 선택"></label>
        ${raw(kids ? html`<button type="button" class="wpr__tog" data-fold="${it.temp_id}" aria-label="${folded.has(it.temp_id) ? '펼치기' : '접기'}">${folded.has(it.temp_id) ? '▸' : '▾'}</button>` : '<span class="wpr__tog"></span>')}
        <span class="wpr__code mono">${code}</span><span class="wpr__t" title="${it.title}" data-title="${it.temp_id}">${it.item_type === 'MILESTONE' ? '◆ ' : ''}${it.title}</span>
        <span class="wpr__per">${per}</span><span class="wpr__chip">${raw(chip(it))}</span></div>`; };
    let body = '';
    heads.forEach((h, hi) => {
      const mine = list.filter((i) => phaseOf(i) === h.plan && !merged.has(i.temp_id)); const n = mine.filter((i) => i.selected).length;
      const tip = h.holidays && h.holidays.length ? `공휴일: ${h.holidays.map((x) => `${md(x.day)} ${x.name}`).join(', ')}` : '이 기간에 공휴일이 없습니다';
      const pk = `PH:${h.plan}`;
      body += html`<div class="wph wph--${h.plan.toLowerCase()}" data-phase="${h.plan}" role="row"><button type="button" class="wpr__tog" data-fold="${pk}" aria-label="${folded.has(pk) ? '펼치기' : '접기'}">${folded.has(pk) ? '▸' : '▾'}</button>
        <b class="wph__t">${hi + 1} ${h.title}</b><small class="wph__n">작업 ${n}</small><span class="wph__sp"></span>
        ${raw(h.start ? html`<span class="wph__per" title="${tip}">${dper(h.start, h.end)}</span><label class="wph__d" title="이 단계의 근무일 수 — 바꾸면 단계 안 작업이 다시 배분됩니다"><input type="number" class="input input--xs" min="1" max="999" data-phase-days="${h.plan}" value="${h.workdays}" aria-label="${h.title} 근무일"> 근무일</label>` : '')}</div>`;
      // codes: phase index + position among visible siblings
      const kidsOf = (pid) => mine.filter((i) => (pid ? i.parent_temp_id === pid : !i.parent_temp_id || merged.has(i.parent_temp_id)));
      const walk = (pid, prefix) => kidsOf(pid).forEach((it, k) => { const code = `${prefix}.${k + 1}`; if (!hiddenBy(it)) body += rowHtml(it, code); walk(it.temp_id, code); });
      walk(null, String(hi + 1));
    });
    const sumText = !sched.start ? '<span class="hint">프로젝트 기간(01 프로젝트 개요의 시작·종료일)이 없어 날짜는 넣지 않습니다.</span>'
      : html`<label class="toggle"><input type="checkbox" id="wp-dates" ${datesOn ? 'checked' : ''}> 날짜 자동 배분</label><small class="dim">${datesOn && alloc && alloc.ok ? `${sched.start} ~ ${sched.end} · 근무일 ${alloc.workdays}일 (주말·공휴일 제외)${alloc.overrun ? ' · 종료일을 넘습니다' : ''}` : '날짜 없이 반영합니다 (WBS에서 직접 입력)'}</small>`;
    d.body.innerHTML = html`${raw(stepsBar())}
      <div class="aid__sum"><b>AI WBS 초안 ${list.length}건</b>${raw(runLine(run, d))}<span class="aid__sp"></span>${raw(sumText)}
        <label class="toggle"><input type="checkbox" id="wp-all" ${items.every((i) => i.selected) ? 'checked' : ''}> 전체 선택</label></div>
      ${raw(warningsHtml(plan.draft.warnings))}${raw(plan.draft.notes?.length ? html`<ul class="aid__notes">${raw(plan.draft.notes.map((n) => html`<li>${n}</li>`).join(''))}</ul>` : '')}
      <div class="wps" data-wps><div class="wps__tree" id="wp-tree" role="treegrid" aria-label="WBS 초안">${raw(body)}</div><aside class="wps__side" id="wp-side">${raw(sidePanel(dates))}</aside></div>`;
    foot(html`<button type="button" class="btn btn--secondary btn--sm" id="wp-back2">← 질문 수정</button><span class="hint">선택 ${c.total}건 · 요구사항 연결 ${c.linked} · 수행 업무 ${c.delivery} · 마일스톤 ${c.ms}</span>`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>나중에 이어하기</button><button type="button" class="btn btn--primary btn--sm" id="wp-cov" ${c.total ? '' : 'disabled'}>다음: 누락 검토</button>`);
    $('#wp-back2', d.el).onclick = async () => { await saveEdits(); drawQuestions(); };
    $('#wp-cov', d.el).onclick = async () => { if (await saveEdits()) drawCoverage(); };
    const dsw = $('#wp-dates', d.el); if (dsw) dsw.onchange = () => { datesOn = dsw.checked; drawTree(); };
    d.body.querySelectorAll('[data-sel]').forEach((cb) => cb.onchange = () => { const it = items.find((i) => i.temp_id === cb.dataset.sel); it.selected = cb.checked; if (cb.checked) selectChain(it); else { const off = (p) => items.filter((x) => x.parent_temp_id === p.temp_id).forEach((x) => { x.selected = false; off(x); }); off(it); } drawTree(); });
    $('#wp-all', d.el).onchange = (e) => { items.forEach((i) => { i.selected = e.target.checked; }); drawTree(); };
    d.body.querySelectorAll('[data-fold]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.fold; if (folded.has(k)) folded.delete(k); else folded.add(k); drawTree(); });
    d.body.querySelectorAll('[data-phase-days]').forEach((inp) => inp.onchange = () => { const v = Math.round(Number(inp.value)); if (v > 0) phaseDays[inp.dataset.phaseDays] = v; else delete phaseDays[inp.dataset.phaseDays]; drawTree(); });
    d.body.querySelectorAll('.wpr').forEach((r) => r.onclick = (e) => { if (e.target.closest('input,button,label') || selTemp === r.dataset.t) return; selTemp = r.dataset.t; drawTree(); });   // the current row stays put so a double-click edits its title
    d.body.querySelectorAll('[data-title]').forEach((t) => t.ondblclick = () => { const it = items.find((i) => i.temp_id === t.dataset.title); const inp = document.createElement('input'); inp.className = 'input input--xs wpr__in'; inp.value = it.title; inp.maxLength = 200; t.replaceWith(inp); inp.focus(); inp.select();
      const fin = (ok) => { if (ok && inp.value.trim()) it.title = inp.value.trim(); drawTree(); }; inp.onkeydown = (e) => { if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); }; inp.onblur = () => fin(true); });
    bindSide();
  };
  /** Right panel: the selected row's 유형 · 단계 · 상위 · 참고 기간 · 요구사항 (the row itself stays one line). */
  const sidePanel = (dates) => {
    const it = selTemp && items.find((i) => i.temp_id === selTemp);
    if (!it) return '<div class="wps__empty"><b>행을 선택하세요</b><p class="hint">행을 누르면 유형·단계·상위 항목·기간·요구사항을 여기서 고칩니다. 제목은 두 번 눌러 바로 고칠 수 있습니다.</p><p class="hint">날짜는 프로젝트 기간을 근무일(주말·공휴일 제외)로 바꿔 단계 비율(착수 5 · 요구사항 15 · 분석·설계 20 · 구현 35 · 시험 15 · 전환·오픈 10)로 나누고, 단계 안에서는 AI 참고 기간을 비율로 써서 차례로 배치합니다.</p></div>';
    const top = !it.parent_temp_id; const dt = dates[it.temp_id];
    return html`<div class="wps__f"><h4>${it.title}</h4>
      <label class="field"><span>유형</span><select class="select select--sm" data-f="item_type"><option value="TASK" ${it.item_type === 'TASK' ? 'selected' : ''}>작업</option><option value="MILESTONE" ${it.item_type === 'MILESTONE' ? 'selected' : ''}>마일스톤</option></select></label>
      ${raw(top ? html`<label class="field"><span>단계</span><select class="select select--sm" data-f="phase">${raw(FIXED_NODES.map((n) => html`<option value="${n.plan}" ${phaseOf(it) === n.plan ? 'selected' : ''}>${n.title}</option>`).join(''))}</select></label>` : html`<p class="hint">단계: ${nodeByPlan.get(phaseOf(it))?.title || ''} (최상위 항목을 따릅니다)</p>`)}
      <label class="field"><span>상위 항목</span><select class="select select--sm" data-f="parent_temp_id"><option value="">(단계 바로 아래)</option>${raw(items.filter((p) => p.temp_id !== it.temp_id && p.item_type !== 'MILESTONE').map((p) => html`<option value="${p.temp_id}" ${p.temp_id === it.parent_temp_id ? 'selected' : ''}>${p.title}</option>`).join(''))}</select></label>
      ${raw(it.item_type === 'MILESTONE' ? '' : html`<label class="field"><span>참고 기간 (근무일)</span><input class="input input--sm" data-f="planned_duration_days" type="number" min="0" max="365" value="${it.planned_duration_days ?? ''}" placeholder="AI 참고값"></label>`)}
      ${raw(dt ? html`<p class="hint">배분된 일정: ${dt.milestone_date || `${dt.planned_start_date} ~ ${dt.planned_end_date} (${workdaysBetween(dt.planned_start_date, dt.planned_end_date, sched.hol)} 근무일)`}</p>` : '')}
      <div class="field"><span>요구사항 연결</span><div>${raw(it.related_requirement_ids.length ? it.related_requirement_ids.map((x) => html`<span class="chip chip--active" title="${reqIndex.get(x)?.title || ''}">${x}</span>`).join(' ') : '<span class="dim">없음 (수행 업무)</span>')} <button type="button" class="link linkbtn" data-link-edit="${it.temp_id}">수정</button></div></div>
      ${raw(it.similar_to ? html`<p class="hint">기존 ${it.similar_to.wbs_code} ${it.similar_to.title}과 비슷해 기본 해제했습니다.</p>` : '')}
      <small class="dim">영역: ${AREA_SHORT[it.project_area] || it.project_area}</small></div>`;
  };
  const bindSide = () => {
    const side = $('#wp-side', d.el); if (!side) return;
    side.querySelectorAll('[data-f]').forEach((el) => el.onchange = () => { const it = items.find((i) => i.temp_id === selTemp); if (!it) return;
      if (el.dataset.f === 'parent_temp_id') { const v = el.value || null; let p = v; let g = 0; while (p && g++ < 20) { if (p === it.temp_id) { toast('자기 자신의 하위로 옮길 수 없습니다.'); el.value = it.parent_temp_id || ''; return; } p = items.find((i) => i.temp_id === p)?.parent_temp_id || null; } it.parent_temp_id = v; if (it.selected) selectChain(it); }
      else if (el.dataset.f === 'planned_duration_days') it.planned_duration_days = el.value === '' ? null : Math.max(0, Math.min(365, Number(el.value) || 0));
      else if (el.dataset.f === 'item_type') { it.item_type = el.value; if (el.value === 'MILESTONE') items.filter((x) => x.parent_temp_id === it.temp_id).forEach((x) => { x.parent_temp_id = null; }); }
      else if (el.dataset.f === 'phase') it.phase = el.value;
      drawTree(); });
    side.querySelectorAll('[data-link-edit]').forEach((b) => b.onclick = () => editLinks(items.find((i) => i.temp_id === b.dataset.linkEdit)));
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
    d.busy(true, '검토 내용을 저장하고 빠진 작업을 확인하는 중…');
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
        <section class="wpz__covc"><h4>요구사항 연결 현황</h4>
          ${raw(rs.total ? html`<div class="wpz__big"><b>${rs.percent}%</b><span>요구사항 ${rs.total}건 중 ${rs.covered}건 WBS 연결 · ${rs.missing}건 미연결</span><span class="pbar pbar--g"><i style="width:${rs.percent}%"></i></span></div>
            ${raw(rs.missing ? html`<ul class="wpz__miss">${raw(cov.requirement_coverage.filter((r) => r.status === 'MISSING').map((r) => html`<li><span class="mono">${r.display_id}</span> ${r.title}</li>`).join(''))}</ul>` : '<p class="wpz__ok">모든 대상 요구사항에 실행 WBS가 연결되었습니다.</p>')}` : '<p class="hint">대상 요구사항이 없습니다.</p>')}</section>
        <section class="wpz__covc"><h4>수행 업무 포함 현황</h4>
          <ul class="wpz__areas">${raw(cov.delivery_coverage.filter((a) => a.status !== 'UNKNOWN' || a.assessment !== 'UNKNOWN').map((a) => { const [ic, lab, cls] = COV[a.status] || COV.UNKNOWN; return html`<li class="${cls}" title="${a.reason || ''}"><i>${ic}</i><span>${a.label}</span><small>${lab}${a.candidates ? ` · 후보 ${a.candidates}` : ''}${a.existing ? ` · 기존 ${a.existing}` : ''}${a.source === 'USER_ANSWER' ? ' · 답변 기준' : ''}</small></li>`; }).join(''))}</ul></section>
      </div>
      ${raw(cov.warnings.length ? html`<div class="aid__warn"><b>확인 필요</b><ul>${raw(cov.warnings.map((w) => html`<li>${w}</li>`).join(''))}</ul></div>` : '<p class="wpz__ok">빠진 작업 경고가 없습니다.</p>')}
      <div class="wpz__final"><b>반영 예정</b><span>WBS <b>${c.total}</b>개</span><span>요구사항 연결 <b>${c.linked}</b>개</span><span>프로젝트 수행 업무 <b>${c.delivery}</b>개</span><span>마일스톤 <b>${c.ms}</b>개</span></div>`;
    foot(html`<button type="button" class="btn btn--secondary btn--sm" id="wp-back3">← 초안 수정</button>${raw(fixable ? '<button type="button" class="btn btn--secondary btn--sm btn--ai" id="wp-fix">누락 작업 추가 제안</button>' : '')}`, html`<button type="button" class="btn btn--secondary btn--sm" data-close>나중에 이어하기</button><button type="button" class="btn btn--primary btn--sm" id="wp-commit" ${c.total ? '' : 'disabled'}>WBS에 반영 (${c.total}건)</button>`);
    $('#wp-back3', d.el).onclick = () => drawTree();
    const fb = $('#wp-fix', d.el); if (fb) fb.onclick = async () => { d.busy(true, 'AI가 누락 영역의 작업 후보를 추가 제안하는 중…'); try { const r = await api('POST', `${base}/${plan.id}/fix`, {}); plan = r.plan; loadItems(); toast(`추가 후보 ${r.added.length}건을 초안에 넣었습니다. 검토 후 반영하세요.`); d.busy(false); drawTree(); } catch (e) { d.busy(false); reportError(e); } };
    $('#wp-commit', d.el).onclick = commit;
  };
  const commit = async () => {
    const c = counts();
    if (!(await confirmDialog({ title: `WBS ${c.total}건을 반영할까요?`, body: `선택한 항목이 단계 아래 실제 WBS로 생성되고 요구사항 연결 ${c.linked}건이 추가됩니다.${datesOn && sched && sched.start ? ' 배분한 날짜(근무일 기준)도 함께 넣습니다.' : ' 날짜는 넣지 않습니다.'} 번호·순서는 RELAI가 정하며, 반영 후에는 WBS 화면에서 수정할 수 있습니다.`, confirm: 'WBS에 반영' }))) return;
    d.busy(true, 'WBS를 생성하는 중입니다…');
    try {
      const r = await api('POST', `${base}/${plan.id}/commit`, { items: edits(), schedule: { enabled: Boolean(datesOn && sched && sched.start), phase_workdays: { ...phaseDays } } });
      toast(`WBS ${r.created.length}건을 생성하고 요구사항 연결 ${r.links}건을 추가했습니다.`);
      d.busy(false); d.close(); if (onDone) await onDone(r);
    } catch (e) { d.busy(false); const f = e.fields ? Object.values(e.fields)[0] : null; toast(f || e.message); }
  };

  if (step === 4) drawTree(); else if (step === 2) drawQuestions(); else drawPick();
}
