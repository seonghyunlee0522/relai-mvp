/* batch7 #18 (B8) — AI로 시나리오 만들기. 요구사항 선택 (기본: 확정 · 범위 내 · 테스트 미연결, 최대 20) → 생성 (30 크레딧) →
 * 요구사항별 카드에 시나리오 표 (유형 · 사전 조건 · 테스트 계정·데이터 · 단계·예상 결과 · 최종 예상 결과 · 대상 환경) → 체크한 것만 저장.
 * Nothing is saved until 저장; saving reuses POST /ai/tests/commit (test_cases + test_links REQUIREMENT). Credits are shown in 크레딧 only. */
import { api, wsApi } from '../core/api.js';
import { $, html, raw } from '../core/dom.js';
import { toast } from '../shared/dialogs.js';
import { tag } from '../shared/badges.js';
import { aiDialog, aiNotice, aiStatus, aiStatusReset, canRun, reportError, warningsHtml } from '../shared/ai.js';

export const TEST_GEN_MAX = 20;
const fmt = (v) => Number(v || 0).toLocaleString('ko-KR');
const TYPE_TONE = { 정상: 'done', 예외: 'bad', 경계: 'hold' };   // batch7 B2 tones (--tag-*)

/** "30 크레딧 · 잔액 70" — never a money amount (#7). */
const costLine = (st) => {
  const cost = st?.costs?.TEST_GENERATION; const bal = st?.credits?.available;
  if (typeof cost !== 'number') return '';
  const short = typeof bal === 'number' && bal < cost;
  return html`<span class="ai-credit ${short ? 'is-short' : ''}" data-tg-cost>${short ? '크레딧이 부족합니다 · ' : '실행하면 '}<b>${fmt(cost)}</b> 크레딧${typeof bal === 'number' ? html` · 잔액 <b>${fmt(bal)}</b>` : ''}${raw(short ? ' · <a href="/app/billing/plans" data-link data-upsell-cta>플랜 살펴보기</a>' : '')}</span>`;
};

export async function openTestGenDialog({ pid, onDone, preselect = null }) {
  const st = await aiStatus(pid, { fresh: true });
  // aiDialog without `status` → no header price line; ours (costLine) never shows ₩
  const d = aiDialog({ title: 'AI로 테스트 시나리오 만들기', subtitle: '요구사항의 설명과 완료 조건, 01 적용 환경을 바탕으로 요구사항마다 1~3개의 시나리오 초안을 만듭니다. 검토하고 고른 것만 테스트로 저장됩니다.', feature: 'TEST_GENERATION', status: null });
  d.el.querySelector('.dialog').setAttribute('data-dialog', 'test-gen');
  let cov = [];
  try { cov = (await api('GET', wsApi(`/${pid}/tests/coverage`))).coverage || []; } catch (e) { toast(e.message); }
  const picked = new Set(preselect && preselect.length ? preselect
    : cov.filter((r) => r.status === 'CONFIRMED' && !r.total && !r.test_exclusion_reason).slice(0, TEST_GEN_MAX).map((r) => r.id));
  let groups = [];

  const drawPick = () => {
    d.body.innerHTML = cov.length ? html`<div class="aid__sum"><b>요구사항 선택</b> <span class="dim" data-tg-n>${picked.size} / 최대 ${TEST_GEN_MAX}건</span><span class="aid__sp"></span>${raw(costLine(st))}</div>
      <p class="hint tg-lead">기본으로 확정됐지만 아직 테스트가 없는 범위 내 요구사항을 골라 두었습니다.</p>
      <ol class="aic" data-tg-reqs>${raw(cov.map((r) => html`<li class="aic__i tg-req ${picked.has(r.id) ? 'is-sel' : ''}">
        <input type="checkbox" data-tg-req="${r.id}" ${picked.has(r.id) ? 'checked' : ''} aria-label="${r.display_id} 선택"><span class="mono">${r.display_id}</span><span class="tg-req__t">${r.title}</span>
        ${raw(tag('req', r.status))}<small class="dim">${r.total ? `테스트 ${r.total}건` : r.test_exclusion_reason ? '테스트 제외' : '테스트 없음'}</small></li>`).join(''))}</ol>
      ${raw(aiNotice(st))}<p class="hint">테스트 계정은 역할과 데이터 종류만 제안합니다. 실제 비밀번호 같은 비밀값은 저장하지 마세요.</p>`
      : '<div class="aempty">범위 내 요구사항이 없습니다. 요구사항의 범위를 먼저 정하세요.</div>';
    d.foot.innerHTML = html`<span class="hint">결과는 초안이며 저장하기 전까지 아무것도 바뀌지 않습니다.</span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>취소</button><button type="button" class="btn btn--primary btn--sm" id="tg-run" ${picked.size && canRun(st, 'TEST_GENERATION') ? '' : 'disabled'}>시나리오 만들기</button></span>`;
    d.body.querySelectorAll('[data-tg-req]').forEach((cb) => { cb.onchange = () => {
      if (cb.checked && picked.size >= TEST_GEN_MAX) { cb.checked = false; toast(`한 번에 최대 ${TEST_GEN_MAX}건까지 고를 수 있습니다.`); return; }
      if (cb.checked) picked.add(cb.dataset.tgReq); else picked.delete(cb.dataset.tgReq);
      cb.closest('.aic__i').classList.toggle('is-sel', cb.checked); $('[data-tg-n]', d.el).textContent = `${picked.size} / 최대 ${TEST_GEN_MAX}건`;
      $('#tg-run', d.el).disabled = !picked.size || !canRun(st, 'TEST_GENERATION');
    }; });
    const run = $('#tg-run', d.el); if (run) run.onclick = generate;
  };

  const generate = async () => {
    d.busy(true, 'AI가 테스트 시나리오를 만드는 중입니다… (최대 30초)');
    try {
      const r = await api('POST', wsApi(`/${pid}/ai/tests/generate`), { requirement_ids: [...picked] });
      groups = r.requirements.map((g) => ({ ...g, scenarios: g.scenarios.map((s) => ({ ...s, _sel: true })) }));
      aiStatusReset(pid); drawResult(r);
    } catch (e) { reportError(e); }
    finally { d.busy(false); }
  };

  const stepsHtml = (s) => (s.steps.length ? html`<ol class="tg-steps">${raw(s.steps.map((x) => html`<li>${x.instruction}${raw(x.expected ? html` <span class="dim">→ ${x.expected}</span>` : '')}</li>`).join(''))}</ol>` : '<span class="dim">-</span>');
  const cell = (label, v) => html`<tr><th scope="row">${label}</th><td>${raw(v)}</td></tr>`;
  const drawResult = (r) => {
    const n = groups.reduce((a, g) => a + g.scenarios.length, 0);
    d.body.innerHTML = html`<div class="aid__sum"><b>시나리오 ${n}개 · 요구사항 ${groups.length}건</b>${raw(r.run ? html`<small class="dim" data-tg-used> · ${fmt(r.run.credit_cost)} 크레딧 사용 · 잔액 ${fmt(r.run.balance)}</small>` : '')}<span class="aid__sp"></span>
        <label class="toggle"><input type="checkbox" id="tg-all" checked> 전체 선택</label></div>
      ${raw(warningsHtml(r.warnings))}
      ${raw(r.environments && r.environments.length ? html`<p class="hint" data-tg-env>적용 환경: ${r.environments.join(' · ')}</p>` : '')}
      ${raw(groups.length ? groups.map((g, gi) => html`<section class="tg-card" data-tg-card="${g.requirement.id}">
        <h4><span class="mono">${g.requirement.display_id}</span> ${g.requirement.title}</h4>
        ${raw(g.scenarios.map((s, si) => html`<div class="tg-sc ${s._sel ? 'is-sel' : ''}" data-tg-sc="${gi}:${si}">
          <label class="tg-sc__h"><input type="checkbox" data-tg-sel="${gi}:${si}" ${s._sel ? 'checked' : ''}><span class="tag tag--${TYPE_TONE[s.type] || 'muted'}" data-tone="${TYPE_TONE[s.type] || 'muted'}" data-tg-type>${s.type}</span>${s.title}</label>
          <table class="tg-tbl"><tbody>
            ${raw(cell('사전 조건', html`${s.precondition || '-'}`))}${raw(cell('테스트 계정·데이터', html`<span data-tg-data>${s.test_data || '-'}</span>`))}
            ${raw(cell('단계 · 예상 결과', stepsHtml(s)))}${raw(cell('최종 예상 결과', html`<b>${s.expected_result || '-'}</b>`))}${raw(cell('대상 환경', html`${s.environment || '-'}`))}
          </tbody></table></div>`).join(''))}</section>`).join('') : '<div class="aempty">시나리오를 만들지 못했습니다. 요구사항에 설명이나 완료 조건을 더 적어 보세요.</div>')}`;
    const selCount = () => groups.reduce((a, g) => a + g.scenarios.filter((s) => s._sel).length, 0);
    const paintFoot = () => {
      d.foot.innerHTML = html`<button type="button" class="btn btn--secondary btn--sm" id="tg-back">← 요구사항 다시 고르기</button><span class="aid__sp"></span><span class="aid__btns"><button type="button" class="btn btn--secondary btn--sm" data-close>닫기</button><button type="button" class="btn btn--primary btn--sm" id="tg-commit" ${selCount() ? '' : 'disabled'}>선택한 ${selCount()}개 테스트로 저장</button></span>`;
      $('#tg-back', d.el).onclick = drawPick; $('#tg-commit', d.el).onclick = commit;
    };
    paintFoot();
    d.body.querySelectorAll('[data-tg-sel]').forEach((cb) => { cb.onchange = () => { const [gi, si] = cb.dataset.tgSel.split(':').map(Number); groups[gi].scenarios[si]._sel = cb.checked; cb.closest('.tg-sc').classList.toggle('is-sel', cb.checked); paintFoot(); }; });
    const all = $('#tg-all', d.el); if (all) all.onchange = () => { groups.forEach((g) => g.scenarios.forEach((s) => { s._sel = all.checked; })); d.body.querySelectorAll('[data-tg-sel]').forEach((cb) => { cb.checked = all.checked; }); paintFoot(); };
  };

  const commit = async () => {
    const scenarios = groups.flatMap((g) => g.scenarios.filter((s) => s._sel).map(({ _sel, temp_id, ...s }) => ({ ...s, requirement_id: g.requirement.id })));
    if (!scenarios.length) return;
    d.busy(true, '테스트를 저장하는 중입니다…');
    try { const r = await api('POST', wsApi(`/${pid}/ai/tests/commit`), { scenarios }); d.busy(false); d.close(); toast(`테스트 ${r.created.length}건을 만들었습니다.`); if (onDone) await onDone(r); }
    catch (e) { d.busy(false); toast(e.fields ? Object.values(e.fields)[0] : e.message); }
  };
  drawPick();
}
