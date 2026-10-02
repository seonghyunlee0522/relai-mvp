/* Feature 2 — 요구사항 → WBS 초안. Step 1 pick requirements (default: CONFIRMED + IN_SCOPE) → Step 2 tree preview with
 * select / title / type / parent edits → 선택 항목 생성. Real WBS codes, sequence and requirement links come from RELAI's own
 * services via POST /ai/wbs/commit. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from '../shared/dialogs.js';
import { REQ_SCOPE, REQ_SCOPE_CHIP, REQ_STATUS, REQ_STATUS_CHIP, WBS_TYPE } from '../shared/constants.js';
import { aiDialog, aiNotice, aiStatus, canRun, reportError, warningsHtml } from '../shared/ai.js';

export async function openWbsDraftDialog({ pid, onDone }) {
  const [st, reqRes] = await Promise.all([aiStatus(pid, { fresh: true }), api('GET', wsApi(`/${pid}/requirements`))]);
  const reqs = reqRes.requirements.filter((r) => !r.archived_at);
  const d = aiDialog({ title: 'AI로 WBS 초안 만들기', subtitle: '선택한 요구사항을 구현하기 위한 작업 트리를 제안합니다. 코드·순서·일정은 생성 시 RELAI가 정하고, AI는 구조와 참고 기간만 제안합니다.', feature: 'WBS_GENERATION', status: st });
  const picked = new Set(reqs.filter((r) => r.status === 'CONFIRMED' && r.scope === 'IN_SCOPE').map((r) => r.id));
  let items = []; let reqIndex = new Map();

  const drawPick = () => {
    d.body.innerHTML = html`<div class="aid__sum"><b>대상 요구사항 선택</b><small class="dim"> · 기본값은 확정 + 범위 내 요구사항입니다</small><span class="aid__sp"></span>
        <input class="input input--sm" id="ai-q" type="search" placeholder="ID, 제목 검색" style="max-width:220px"><label class="toggle"><input type="checkbox" id="ai-all" ${picked.size === reqs.length && reqs.length ? 'checked' : ''}> 전체</label></div>
      ${raw(reqs.length ? html`<div class="pick-list pick-list--tall" id="ai-list">${raw(reqs.map((r) => html`<label class="pick ${picked.has(r.id) ? 'is-sel' : ''}" data-row="${r.id}" data-q="${(r.display_id + ' ' + r.title).toLowerCase()}"><input type="checkbox" data-pick="${r.id}" ${picked.has(r.id) ? 'checked' : ''}><span class="mono">${r.display_id}</span><span class="pick__t">${r.title}</span><span class="chip ${REQ_SCOPE_CHIP[r.scope]}">${REQ_SCOPE[r.scope]}</span><span class="chip ${REQ_STATUS_CHIP[r.status] || ''}">${REQ_STATUS[r.status]}</span></label>`).join(''))}</div>` : '<div class="aempty">요구사항이 없습니다. 먼저 요구사항을 등록하거나 AI로 추출해 주세요.</div>')}
      ${raw(aiNotice(st))}`;
    const paintFoot = () => { d.foot.innerHTML = html`<span class="hint">${picked.size}건 선택 (최대 60건)</span><span class="aid__sp"></span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>취소</button><button type="button" class="btn btn--primary btn--sm" id="ai-run" ${picked.size && picked.size <= 60 && canRun(st, 'WBS_GENERATION') ? '' : 'disabled'}>WBS 초안 생성</button></span>`; $('#ai-run', d.el).onclick = run; };
    paintFoot();
    d.body.querySelectorAll('[data-pick]').forEach((cb) => cb.onchange = () => { if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick); cb.closest('.pick').classList.toggle('is-sel', cb.checked); paintFoot(); });
    const all = $('#ai-all', d.el); if (all) all.onchange = () => { d.body.querySelectorAll('[data-pick]').forEach((cb) => { if (cb.closest('.pick').hidden) return; cb.checked = all.checked; if (all.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick); cb.closest('.pick').classList.toggle('is-sel', all.checked); }); paintFoot(); };
    const q = $('#ai-q', d.el); if (q) q.oninput = () => { const t = q.value.trim().toLowerCase(); d.body.querySelectorAll('.pick').forEach((p) => { p.hidden = Boolean(t) && !p.dataset.q.includes(t); }); };
  };
  const run = async () => {
    d.busy(true, 'AI가 WBS 초안을 만드는 중입니다… (최대 30초)');
    try {
      const r = await api('POST', wsApi(`/${pid}/ai/wbs/generate`), { requirement_ids: [...picked] });
      reqIndex = new Map(r.requirements.map((q) => [q.display_id, q]));
      items = r.items.map((it) => ({ ...it, _sel: true }));
      drawTree(r);
    } catch (e) { reportError(e); }
    finally { d.busy(false); }
  };
  const depthOf = (it) => { let n = 1; let p = it.parent_temp_id; let guard = 0; while (p && guard++ < 10) { const x = items.find((i) => i.temp_id === p); if (!x) break; n++; p = x.parent_temp_id; } return n; };
  const ordered = () => { const out = []; const seen = new Set(); const place = (it) => { if (seen.has(it.temp_id)) return; const p = it.parent_temp_id && items.find((i) => i.temp_id === it.parent_temp_id); if (p) place(p); seen.add(it.temp_id); out.push(it); }; items.forEach(place); return out; };
  const drawTree = (r) => {
    const list = ordered();
    const selCount = () => items.filter((i) => i._sel).length;
    d.body.innerHTML = html`<div class="aid__sum"><b>WBS 초안 ${list.length}건</b>${raw(r.run ? html`<small class="dim"> · ${r.run.credit_cost} Credits 사용 · 잔여 ${r.run.balance}</small>` : '')}<span class="aid__sp"></span><label class="toggle"><input type="checkbox" id="ai-all" checked> 전체 선택</label></div>
      ${raw(warningsHtml(r.warnings))}
      ${raw(r.notes?.length ? html`<ul class="aid__notes">${raw(r.notes.map((n) => html`<li>${n}</li>`).join(''))}</ul>` : '')}
      <div class="wtree" id="ai-tree">${raw(list.map((it) => html`<div class="wtree__r ${it._sel ? 'is-sel' : ''}" data-t="${it.temp_id}" style="--d:${depthOf(it) - 1}">
        <label class="aic__ck"><input type="checkbox" data-sel="${it.temp_id}" ${it._sel ? 'checked' : ''} aria-label="${it.title} 선택"></label>
        <select class="select select--xs" data-f="item_type" data-t="${it.temp_id}" aria-label="유형">${raw(Object.entries(WBS_TYPE).filter(([v]) => v !== 'SUMMARY').map(([v, l]) => html`<option value="${v}" ${v === it.item_type ? 'selected' : ''}>${l}</option>`).join(''))}</select>
        <input class="input input--sm wtree__title" data-f="title" data-t="${it.temp_id}" value="${it.title}" maxlength="200" aria-label="업무명">
        <select class="select select--xs wtree__parent" data-f="parent_temp_id" data-t="${it.temp_id}" aria-label="상위 항목" title="상위 항목"><option value="">(최상위)</option>${raw(items.filter((p) => p.temp_id !== it.temp_id && p.item_type !== 'MILESTONE').map((p) => html`<option value="${p.temp_id}" ${p.temp_id === it.parent_temp_id ? 'selected' : ''}>${p.title}</option>`).join(''))}</select>
        <span class="wtree__meta">${raw(it.planned_duration_days ? html`<span class="chip chip--muted" title="AI 참고 기간 (일정은 생성 후 직접 입력)">${it.planned_duration_days}일</span>` : '')}${raw(it.related_requirement_ids.map((id) => html`<span class="chip" title="${reqIndex.get(id)?.title || ''}">${id}</span>`).join(''))}</span>
      </div>`).join(''))}</div>
      <p class="hint">기간은 참고 정보입니다. 시작·종료일, 담당자는 생성 후 WBS 화면에서 입력하세요. 상위 항목을 바꾸면 트리가 다시 그려집니다.</p>`;
    const paintFoot = () => { d.foot.innerHTML = html`<button type="button" class="btn btn--secondary btn--sm" id="ai-back">← 요구사항 다시 선택</button><span class="aid__sp"></span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button><button type="button" class="btn btn--primary btn--sm" id="ai-commit" ${selCount() ? '' : 'disabled'}>선택 항목 생성 (${selCount()}건)</button></span>`; $('#ai-back', d.el).onclick = drawPick; $('#ai-commit', d.el).onclick = commit; };
    paintFoot();
    d.body.querySelectorAll('[data-sel]').forEach((cb) => cb.onchange = () => { const it = items.find((i) => i.temp_id === cb.dataset.sel); it._sel = cb.checked; cb.closest('.wtree__r').classList.toggle('is-sel', cb.checked); if (!cb.checked) items.filter((c) => c.parent_temp_id === it.temp_id).forEach((c) => { c._sel = false; const x = d.body.querySelector(`[data-sel="${c.temp_id}"]`); if (x) { x.checked = false; x.closest('.wtree__r').classList.remove('is-sel'); } }); $('#ai-all', d.el).checked = items.every((i) => i._sel); paintFoot(); });
    $('#ai-all', d.el).onchange = (e) => { items.forEach((i) => { i._sel = e.target.checked; }); drawTree(r); };
    d.body.querySelectorAll('[data-f]').forEach((el) => el.onchange = () => { const it = items.find((i) => i.temp_id === el.dataset.t); if (el.dataset.f === 'parent_temp_id') { const v = el.value || null; let p = v; let guard = 0; while (p && guard++ < 20) { if (p === it.temp_id) { toast('자기 자신의 하위로 옮길 수 없습니다.'); el.value = it.parent_temp_id || ''; return; } p = items.find((i) => i.temp_id === p)?.parent_temp_id || null; } it.parent_temp_id = v; drawTree(r); } else it[el.dataset.f] = el.value; });
  };
  const commit = async () => {
    const chosen = items.filter((i) => i._sel);
    const chosenIds = new Set(chosen.map((i) => i.temp_id));
    const payload = chosen.map((i) => ({ temp_id: i.temp_id, parent_temp_id: i.parent_temp_id && chosenIds.has(i.parent_temp_id) ? i.parent_temp_id : null, item_type: i.item_type, title: i.title, description: i.description || '', requirement_ids: i.requirement_ids || [] }));
    d.busy(true, 'WBS를 생성하는 중입니다…');
    try {
      const r = await api('POST', wsApi(`/${pid}/ai/wbs/commit`), { items: payload });
      toast(`WBS ${r.created.length}건을 생성하고 요구사항 연결 ${r.links}건을 추가했습니다.`);
      d.busy(false); d.close(); if (onDone) await onDone(r);
    } catch (e) { d.busy(false); const f = e.fields ? Object.values(e.fields)[0] : null; toast(f || e.message); }
  };
  drawPick();
}
