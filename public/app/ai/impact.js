/* Feature 3 — Change Request → 영향 후보. Candidates grouped by Requirements / WBS / Tests / Risks, each with reason + confidence;
 * requirements, WBS and risks can be added as real relations (existing change / raid link services). Tests are shown for
 * information only — RELAI has no Change ↔ Test relation, and this phase does not add data structures. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from '../shared/dialogs.js';
import { IMPACT_TYPE, RELATION_TYPE, RESULT, RISK_LEVEL } from '../shared/constants.js';
import { aiDialog, aiNotice, aiStatus, canRun, confChip, reportError, warningsHtml } from '../shared/ai.js';

const opt = (map, cur) => Object.entries(map).map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');

export async function openImpactDialog({ pid, change, onDone }) {
  const st = await aiStatus(pid, { fresh: true });
  const d = aiDialog({ title: `AI 영향 분석 — ${change.display_id}`, subtitle: `${change.title} · 연결된 요구사항, Traceability, 테스트, Risk를 바탕으로 영향 후보를 찾습니다. 선택한 항목만 영향으로 기록됩니다.`, feature: 'CHANGE_IMPACT', status: st });
  let res = null;
  const start = () => {
    d.body.innerHTML = html`<div class="aid__intro"><p>변경 요청의 제목·설명·사유와 현재 프로젝트의 요구사항 ↔ WBS 연결, 테스트, Open Risk/Issue를 AI에게 전달합니다.</p>${raw(aiNotice(st))}</div>`;
    d.foot.innerHTML = html`<span></span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>취소</button><button type="button" class="btn btn--primary btn--sm" id="ai-run" ${canRun(st, 'CHANGE_IMPACT') ? '' : 'disabled'}>영향 분석 시작</button></span>`;
    $('#ai-run', d.el).onclick = run;
  };
  const run = async () => {
    d.busy(true, 'AI가 영향 범위를 분석하는 중입니다… (최대 30초)');
    try { res = await api('POST', wsApi(`/${pid}/changes/${change.id}/ai/impact`), {}); for (const k of ['affected_requirements', 'affected_wbs', 'possible_risks']) res[k].forEach((x) => { x._sel = !x.already; }); draw(); }
    catch (e) { reportError(e); }
    finally { d.busy(false); }
  };
  const group = (title, key, rows, extra) => html`<section class="aim"><h4 class="dh">${title} <em>${rows.length}</em></h4>
    ${raw(rows.length ? html`<ul class="aim__l">${raw(rows.map((x, i) => html`<li class="aim__i ${x.already ? 'is-done' : ''} ${x._sel ? 'is-sel' : ''}">
      ${raw(key ? html`<label class="aic__ck"><input type="checkbox" data-sel="${key}:${i}" ${x._sel ? 'checked' : ''} ${x.already ? 'disabled' : ''} aria-label="${x.display_id} 선택"></label>` : '<span class="aic__ck aic__ck--na" title="참고 정보">·</span>')}
      <div class="aim__m"><div class="aim__t"><a class="mono" href="/app/projects/${pid}/${x.href}" data-link target="_blank">${x.display_id}</a><b>${x.title}</b>${raw(confChip(x.confidence))}${raw(x.already ? '<span class="chip chip--done">이미 연결됨</span>' : '')}${raw(extra ? extra(x, i) : '')}</div><p class="aim__r">${x.reason}</p></div></li>`).join(''))}</ul>` : '<p class="hint">해당 없음</p>')}</section>`;
  const draw = () => {
    const sel = () => res.affected_requirements.filter((x) => x._sel).length + res.affected_wbs.filter((x) => x._sel).length + res.possible_risks.filter((x) => x._sel).length;
    d.body.innerHTML = html`<div class="aid__sum"><b>영향 후보</b>${raw(res.run ? html`<small class="dim"> · ${res.run.credit_cost} Credits 사용 · 잔여 ${res.run.balance}</small>` : '')}</div>
      ${raw(warningsHtml(res.warnings))}
      ${raw(res.summary ? html`<div class="aid__summary"><b>AI 요약</b><p>${res.summary}</p></div>` : '')}
      ${raw(group('관련 요구사항 후보', 'affected_requirements', res.affected_requirements, (x, i) => (x.already ? '' : html`<select class="select select--xs" data-rel="${i}" aria-label="관계 유형">${raw(opt(RELATION_TYPE, 'MODIFIES'))}</select>`)))}
      ${raw(group('영향 WBS 후보', 'affected_wbs', res.affected_wbs, (x, i) => (x.already ? '' : html`<select class="select select--xs" data-imp="${i}" aria-label="영향 유형">${raw(opt(IMPACT_TYPE, x.impact_type))}</select>`)))}
      ${raw(group('관련 Risk 후보', 'possible_risks', res.possible_risks, (x) => html`<span class="chip chip--muted">${RISK_LEVEL[x.risk_level] || x.risk_level}</span>`))}
      ${raw(group('재수행·수정이 필요한 테스트 (참고)', null, res.affected_tests, (x) => html`<span class="chip ${x.last_result === 'FAIL' ? 'chip--fail' : 'chip--muted'}">${RESULT[x.last_result] || '미실행'}</span>`))}`;
    const paintFoot = () => { d.foot.innerHTML = html`<button type="button" class="btn btn--secondary btn--sm" id="ai-again">다시 분석</button><span class="aid__sp"></span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button><button type="button" class="btn btn--primary btn--sm" id="ai-commit" ${sel() ? '' : 'disabled'}>선택 항목 영향으로 추가 (${sel()}건)</button></span>`; $('#ai-again', d.el).onclick = run; $('#ai-commit', d.el).onclick = commit; };
    paintFoot();
    d.body.querySelectorAll('[data-sel]').forEach((cb) => cb.onchange = () => { const [k, i] = cb.dataset.sel.split(':'); res[k][Number(i)]._sel = cb.checked; cb.closest('.aim__i').classList.toggle('is-sel', cb.checked); paintFoot(); });
    d.body.querySelectorAll('[data-rel]').forEach((s) => s.onchange = () => { res.affected_requirements[Number(s.dataset.rel)].relation_type = s.value; });
    d.body.querySelectorAll('[data-imp]').forEach((s) => s.onchange = () => { res.affected_wbs[Number(s.dataset.imp)].impact_type = s.value; });
  };
  const commit = async () => {
    const body = {
      requirements: res.affected_requirements.filter((x) => x._sel).map((x) => ({ id: x.id, relation_type: x.relation_type || 'MODIFIES' })),
      wbs: res.affected_wbs.filter((x) => x._sel).map((x) => ({ id: x.id, impact_type: x.impact_type || 'SCHEDULE', note: x.reason })),
      risks: res.possible_risks.filter((x) => x._sel).map((x) => ({ id: x.id })),
    };
    d.busy(true, '영향 관계를 기록하는 중입니다…');
    try {
      const r = await api('POST', wsApi(`/${pid}/changes/${change.id}/ai/impact/commit`), body);
      toast(`영향 추가: 요구사항 ${r.added.requirements}건 · WBS ${r.added.wbs}건 · Risk ${r.added.risks}건${r.skipped.length ? ` (이미 연결 ${r.skipped.length}건 건너뜀)` : ''}`);
      d.busy(false); d.close(); if (onDone) await onDone(r);
    } catch (e) { d.busy(false); const f = e.fields ? Object.values(e.fields)[0] : null; toast(f || e.message); }
  };
  start();
}
