/* Feature 1 — 회의록/텍스트 → 요구사항 후보. Paste → 분석 → editable candidate list (checkbox, fields, criteria, source, confidence,
 * duplicate hint) → 선택 항목 등록. Nothing is saved until the user clicks 등록; registration reuses POST /ai/requirements/commit
 * which calls the normal requirement create service (DRAFT status). */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from '../shared/dialogs.js';
import { REQ_PRIORITY, REQ_SCOPE, REQ_TYPE } from '../shared/constants.js';
import { aiDialog, aiNotice, aiStatus, canRun, confChip, reportError, warningsHtml } from '../shared/ai.js';

const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');

export async function openExtractDialog({ pid, onDone }) {
  const st = await aiStatus(pid, { fresh: true });
  const d = aiDialog({ title: 'AI로 요구사항 추출', subtitle: '회의록, 고객 인터뷰 메모, 이메일 본문, 요구사항 정의 텍스트를 붙여넣으면 요구사항 후보를 뽑아 드립니다. 파일 업로드는 아직 지원하지 않습니다.', feature: 'REQUIREMENT_EXTRACTION', status: st });
  let candidates = [];
  const drawInput = () => {
    d.body.innerHTML = html`<label class="lbl" for="ai-text">분석할 텍스트</label>
      <textarea class="textarea aid__text" id="ai-text" maxlength="20000" placeholder="예) 10/2 고객 미팅 — 고객사 IdP와 SSO 연동이 필수. 관리자 화면에서 사용자별 권한을 조정할 수 있어야 하며, 모든 변경은 감사 로그에 남아야 함…"></textarea>
      <div class="aid__row"><span class="hint" id="ai-count">0 / 20,000자</span>${raw(aiNotice(st))}</div>`;
    d.foot.innerHTML = html`<span class="hint">결과는 후보이며 검토 후 선택한 항목만 등록됩니다.</span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>취소</button><button type="button" class="btn btn--primary btn--sm" id="ai-run" ${canRun(st, 'REQUIREMENT_EXTRACTION') ? '' : 'disabled'}>요구사항 추출</button></span>`;
    const ta = $('#ai-text', d.el); const cnt = $('#ai-count', d.el);
    ta.oninput = () => { cnt.textContent = `${ta.value.length.toLocaleString('ko-KR')} / 20,000자`; };
    ta.focus();
    $('#ai-run', d.el).onclick = async () => {
      const text = ta.value.trim(); if (text.length < 10) { toast('분석할 텍스트를 10자 이상 입력해 주세요.'); return; }
      d.busy(true, 'AI가 요구사항 후보를 추출하는 중입니다… (최대 30초)');
      try { const r = await api('POST', wsApi(`/${pid}/ai/requirements/extract`), { text }); candidates = r.candidates.map((c) => ({ ...c, _sel: true })); drawResult(r); }
      catch (e) { reportError(e); }
      finally { d.busy(false); }
    };
  };
  const drawResult = (r) => {
    const n = candidates.length;
    d.body.innerHTML = html`<div class="aid__sum"><b>요구사항 후보 ${n}건</b>${raw(r.run ? html`<small class="dim"> · ${r.run.credit_cost} Credits 사용 · 잔여 ${r.run.balance}</small>` : '')}<span class="aid__sp"></span>
        <label class="toggle"><input type="checkbox" id="ai-all" checked> 전체 선택</label></div>
      ${raw(warningsHtml(r.warnings))}
      ${raw(n ? html`<ol class="aic">${raw(candidates.map((c, i) => html`<li class="aic__i ${c._sel ? 'is-sel' : ''}" data-i="${i}">
        <label class="aic__ck"><input type="checkbox" data-sel="${i}" ${c._sel ? 'checked' : ''} aria-label="후보 ${i + 1} 선택"></label>
        <div class="aic__m">
          <div class="aic__t"><span class="aic__n">${i + 1}</span><input class="input input--sm aic__title" data-f="title" data-i="${i}" value="${c.title}" maxlength="200" aria-label="제목">${raw(confChip(c.confidence))}</div>
          <textarea class="textarea aic__desc" data-f="description" data-i="${i}" maxlength="5000" placeholder="설명">${c.description}</textarea>
          <div class="aic__row">
            <label>유형 <select class="select select--sm" data-f="type" data-i="${i}">${raw(opt(REQ_TYPE, c.type))}</select></label>
            <label>우선순위 <select class="select select--sm" data-f="priority" data-i="${i}">${raw(opt(REQ_PRIORITY, c.priority))}</select></label>
            <label>Scope <select class="select select--sm" data-f="scope" data-i="${i}">${raw(opt(REQ_SCOPE, c.scope))}</select></label>
            <label>요청자 <input class="input input--sm" data-f="requester_name" data-i="${i}" value="${c.requester_name || ''}" maxlength="100" placeholder="미상"></label>
          </div>
          <div class="aic__crit"><span class="lbl">완료 조건 <small class="dim">(줄 단위)</small></span><textarea class="textarea" data-f="criteria" data-i="${i}" rows="2" placeholder="완료 조건을 한 줄에 하나씩">${c.acceptance_criteria.join('\n')}</textarea></div>
          ${raw(c.source_text ? html`<details class="aic__src"><summary>근거 원문</summary><q>${c.source_text}</q></details>` : '')}
          ${raw(c.duplicates.length ? html`<div class="aic__dup">유사한 요구사항이 이미 있습니다: ${raw(c.duplicates.map((x) => html`<a href="/app/projects/${pid}/requirements?sel=${x.id}" data-link target="_blank"><span class="mono">${x.display_id}</span> ${x.title}</a>`).join(', '))}</div>` : '')}
        </div></li>`).join(''))}</ol>` : '<div class="aempty">텍스트에서 요구사항 후보를 찾지 못했습니다. 더 구체적인 내용을 붙여넣어 보세요.</div>')}`;
    const selCount = () => candidates.filter((c) => c._sel).length;
    const paintFoot = () => { d.foot.innerHTML = html`<button type="button" class="btn btn--secondary btn--sm" id="ai-back">← 다시 입력</button><span class="aid__sp"></span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button><button type="button" class="btn btn--primary btn--sm" id="ai-commit" ${selCount() ? '' : 'disabled'}>선택 항목 등록 (${selCount()}건)</button></span>`;
      $('#ai-back', d.el).onclick = drawInput;
      $('#ai-commit', d.el).onclick = commit; };
    paintFoot();
    d.body.querySelectorAll('[data-sel]').forEach((cb) => cb.onchange = () => { candidates[Number(cb.dataset.sel)]._sel = cb.checked; cb.closest('.aic__i').classList.toggle('is-sel', cb.checked); $('#ai-all', d.el).checked = candidates.every((c) => c._sel); paintFoot(); });
    const all = $('#ai-all', d.el); if (all) all.onchange = () => { candidates.forEach((c) => { c._sel = all.checked; }); d.body.querySelectorAll('[data-sel]').forEach((cb) => { cb.checked = all.checked; cb.closest('.aic__i').classList.toggle('is-sel', all.checked); }); paintFoot(); };
    d.body.querySelectorAll('[data-f]').forEach((el) => el.onchange = () => { const c = candidates[Number(el.dataset.i)]; if (el.dataset.f === 'criteria') c.acceptance_criteria = el.value.split('\n').map((x) => x.trim()).filter(Boolean); else c[el.dataset.f] = el.value; });
  };
  const commit = async () => {
    const picked = candidates.filter((c) => c._sel).map(({ _sel, duplicates, similar_to, source_text, confidence, ...c }) => c);
    if (!picked.length) return;
    d.busy(true, '요구사항을 등록하는 중입니다…');
    try {
      const r = await api('POST', wsApi(`/${pid}/ai/requirements/commit`), { candidates: picked });
      toast(`요구사항 ${r.created.length}건을 등록했습니다. (${r.created.map((c) => c.display_id).join(', ')})`);
      d.busy(false); d.close(); if (onDone) await onDone(r);
    } catch (e) { d.busy(false); const f = e.fields ? Object.values(e.fields)[0] : null; toast(f || e.message); }
  };
  drawInput();
}
