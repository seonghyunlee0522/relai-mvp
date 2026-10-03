import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, no2, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { moveToPhase, phaseStrip, projectHead, stepInfo } from './guide.js';
import { PHASE_STATUS } from '../shared/constants.js';
import { toast } from '../shared/dialogs.js';
import { bindCoach, phaseIntro } from '../onboarding/ui.js';

export async function phasePage(id, phaseKey) {
  const main = $('#main');
  let g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  let ph = g.phases.find((x) => x.phase_key === phaseKey);
  if (!ph) { navigate(`/app/projects/${id}`, { replace: true }); return; }
  if (phaseKey === 'INITIATION') { navigate(`/app/projects/${id}/definition`, { replace: true }); return; }   // 착수 = 프로젝트 정의 화면
  const archived = p.status === 'ARCHIVED';
  let openId = (location.hash || '').replace('#step-', '') || null;

  const draw = () => {
    ph = g.phases.find((x) => x.phase_key === phaseKey);
    document.title = `${ph.name} — ${p.name} — RELAI`;
    const open = ph.steps.filter((s) => s.status !== 'COMPLETED');
    const nextStep = open[0];
    main.innerHTML = html`<div class="page page--wide page--flow">
      ${raw(projectHead(p, g, { tab: 'phase' }))}
      <p class="phase__crumb"><a class="link" href="/app/projects/${p.id}" data-link>← 프로젝트 홈</a><span class="dim">단계별 할 일의 완료 처리와 메모는 여기에서 관리합니다. 실제 작업은 각 업무 탭에서 합니다.</span></p>
      ${raw(phaseStrip(g, p.id))}
      ${raw(ph ? phaseIntro(ph.phase_key, ph.name) : '')}

      <section class="panel phase">
        <div class="phase__h">
          <div><div class="phase__k"><span class="phase__rec">단계 기록</span><span>${no2(ph.sequence)}</span>${raw(ph.is_current ? '<em class="chip chip--active">현재 단계</em>' : html`<em class="chip">${PHASE_STATUS[ph.status]}</em>`)}</div>
            <h2>${ph.name}</h2><p>${ph.description}</p></div>
          <div class="phase__p"><b>${ph.progress.done} / ${ph.progress.total}</b><span>완료</span><div class="pbar"><i style="width:${ph.progress.percent}%"></i></div></div>
        </div>
        ${raw(!ph.is_current ? html`<div class="phase__bar"><span>이 단계의 기록을 조회하고 있습니다. 현재 단계는 <b>${g.current_phase.name}</b>입니다.</span>${raw(archived ? '' : '<button class="btn btn--secondary btn--sm" id="setcur">이 단계를 현재 단계로 변경…</button>')}</div>` : '')}
        ${raw(ph.is_current && !archived ? (open.length
          ? html`<div class="phase__bar phase__bar--now"><span>다음에 할 일: <b>${nextStep.title}</b></span></div>`
          : html`<div class="phase__bar phase__bar--done"><span>현재 단계의 할 일을 모두 완료했습니다.</span>${raw(g.next_phase ? '<button class="btn btn--primary btn--sm" id="next">다음 단계로 이동</button>' : '')}</div>`) : '')}

        <ol class="checklist">${raw(ph.steps.map((s) => {
          const done = s.status === 'COMPLETED';
          const isOpen = s.id === openId;
          const info = stepInfo(ph.phase_key, s.step_key, g, p.id);
          return html`<li class="step ${done ? 'is-done' : ''} ${isOpen ? 'is-open' : ''}" id="step-${s.id}">
            <button class="step__row" data-toggle="${s.id}" aria-expanded="${isOpen}">
              <i class="step__mark">${done ? '✓' : s.sequence}</i>
              <span class="step__title">${s.title}</span>
              ${raw(s.note ? '<span class="step__noteflag" title="메모 있음">메모</span>' : '')}
              <span class="step__state">${done ? '완료' : (nextStep && nextStep.id === s.id && ph.is_current ? '지금 할 일' : '')}</span>
            </button>
            <div class="step__detail" ${isOpen ? '' : 'hidden'}>
              <div class="step__cols">
                <div><h4>무엇을 하나요?</h4><p>${s.description}</p></div>
                <div><h4>완료 기준</h4><p>${s.completion_criteria}</p></div>
              </div>
              ${raw(info ? html`<div class="datastat ${info.ok ? 'is-ok' : ''}"><span>${info.text}</span><a class="btn btn--secondary btn--sm" href="${info.cta.href}" data-link>${info.cta.label}</a></div>` : '')}
              ${raw(info && info.trace ? html`<div class="datastat datastat--trace"><span>${info.trace.text}</span><a class="btn btn--secondary btn--sm" href="${info.trace.cta.href}" data-link>${info.trace.cta.label}</a></div>` : '')}
              <div class="field" style="margin:18px 0 0"><label for="note-${s.id}">메모</label>
                <textarea class="textarea" id="note-${s.id}" data-note="${s.id}" maxlength="4000" ${archived ? 'disabled' : ''} placeholder="정리한 내용이나 확인한 사실을 적어두세요.">${s.note}</textarea>
                <div class="hint" data-note-status="${s.id}">${s.note ? '저장됨' : ''}</div></div>
              ${raw(archived ? '' : html`<div class="actions" style="margin-top:14px">
                ${raw(done ? html`<button class="btn btn--secondary" data-status="TODO" data-step="${s.id}">완료 취소</button>`
                           : html`<button class="btn btn--primary" data-status="COMPLETED" data-step="${s.id}">완료 처리</button>`)}
                ${raw(done && s.completed_at ? html`<span class="hint" style="align-self:center">${fmtShort(s.completed_at)} 완료</span>` : '')}
              </div>`)}
            </div></li>`;
        }).join(''))}</ol>
      </section>
    </div>`;
    bindCoach(main);

    main.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
      openId = openId === b.dataset.toggle ? null : b.dataset.toggle;
      history.replaceState(null, '', openId ? `#step-${openId}` : location.pathname);
      draw();
    });
    main.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        g = await api('PATCH', wsApi(`/${id}/steps/${b.dataset.step}`), { status: b.dataset.status });
        toast(b.dataset.status === 'COMPLETED' ? '완료 처리했습니다.' : '완료를 취소했습니다.');
        if (b.dataset.status === 'COMPLETED') { const nx = g.phases.find((x) => x.phase_key === phaseKey).steps.find((s) => s.status !== 'COMPLETED'); openId = nx ? nx.id : null; history.replaceState(null, '', openId ? `#step-${openId}` : location.pathname); }
        draw();
      } catch (e) { toast(e.message); b.disabled = false; }
    });
    main.querySelectorAll('[data-note]').forEach((ta) => {
      let timer; const st = main.querySelector(`[data-note-status="${ta.dataset.note}"]`);
      const save = async () => {
        const step = ph.steps.find((s) => s.id === ta.dataset.note);
        if (ta.value.trim() === step.note) return;
        st.textContent = '저장 중…';
        try { g = await api('PATCH', wsApi(`/${id}/steps/${ta.dataset.note}`), { note: ta.value }); ph = g.phases.find((x) => x.phase_key === phaseKey); st.textContent = '저장됨'; }
        catch (e) { st.textContent = e.message; }
      };
      ta.oninput = () => { st.textContent = ''; clearTimeout(timer); timer = setTimeout(save, 800); };
      ta.onblur = () => { clearTimeout(timer); save(); };
    });
    const sc = $('#setcur'); if (sc) sc.onclick = async () => { if (await moveToPhase(p.id, g, ph)) { g = await api('GET', wsApi(`/${id}`)); draw(); } };
    const nb = $('#next'); if (nb) nb.onclick = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) navigate(`/app/projects/${p.id}`); };
    if (openId) { const el = document.getElementById(`step-${openId}`); if (el) el.scrollIntoView({ block: 'nearest' }); }
  };
  draw();
}
