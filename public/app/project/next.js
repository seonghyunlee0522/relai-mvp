/* What’s Next? — the project’s action-oriented home ("What should I do next?"), one column, Enterprise PM style.
 *   [Project Summary] 전체 진행률(단계 진행) · 현재 단계 · 일정 상태 · 확인 필요
 *   [Phase Stepper]   ✓ 착수 — ✓ 요구사항 — ● 일정 — ○ 실행 …
 *   [RELAI Guide]     완료 → 현재 → 다음 Action, exactly one primary CTA (+ at most one subtle secondary)
 *   [Current Phase]   title + helper text + checklist (✓ 완료 · ⚠ 확인 필요 · ○ 미시작 · ✕ 문제 있음) with contextual row actions
 * Dashboard numbers (plan vs actual, scope, quality, upcoming, activity) live in Overview (overview.js).
 * Everything reads from the project GET payload (guide + stats + guidance); nothing is stored. */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { moveToPhase, projectHead, stepInfo } from './guide.js';
import { exceptions, phaseProgression, phaseStepper, scheduleState } from './status.js';
import { bindCoach } from '../onboarding/ui.js';
import { ob } from '../onboarding/state.js';

const isMove = (a) => Boolean(a && /\?move=next$/.test(a.href));
const ctaLink = (a, cls) => (a ? html`<a class="${cls}" href="${a.href}" data-link>${a.label}</a>` : '');

/** 완료: the most recent finished thing — last completed phase, or the last completed step of the current phase. */
function lastDone(g) {
  const cur = g.current_phase;
  const steps = cur ? cur.steps.filter((s) => s.status === 'COMPLETED') : [];
  if (steps.length) return steps[steps.length - 1].title;
  const phases = g.phases.filter((ph) => ph.status === 'COMPLETED' && !ph.is_current);
  if (phases.length) return `${phases[phases.length - 1].name} 단계 완료`;
  if (g.guidance && g.guidance.rule === 'INIT_DONE') return '프로젝트 정의 완료';
  return '프로젝트 생성';
}

/* ---------- Project Summary: four compact metrics ---------- */
const summaryBar = (g, p) => {
  const pp = phaseProgression(g); const cur = g.current_phase; const sch = scheduleState(g.wbs); const ex = exceptions(g, p.id);
  const top = ex.rows.slice(0, 2).map((r) => `${r.label} ${r.count}`).join(' · ');
  return html`<section class="psum" aria-label="Project Summary">
    <div class="psum__m"><span class="psum__k">전체 진행률</span><b class="psum__v">${pp.percent}%</b><small>${pp.total}개 단계 중 ${pp.done}개 완료</small></div>
    <div class="psum__m"><span class="psum__k">현재 단계</span><b class="psum__v psum__v--cur">${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</b><small>${cur ? `완료 조건 ${cur.progress.done} / ${cur.progress.total}` : ''}</small></div>
    <div class="psum__m"><span class="psum__k">일정 상태</span><b class="psum__v is-${sch.tone}">${sch.label}</b><small>${sch.detail}</small></div>
    <a class="psum__m psum__m--link" href="/app/projects/${p.id}/overview#att" data-link title="Overview에서 확인 필요 항목 보기"><span class="psum__k">확인 필요</span><b class="psum__v ${ex.total ? (ex.rows.some((r) => r.tone === 'crit') ? 'is-crit' : 'is-warn') : 'is-good'}">${ex.total}건</b><small>${top || '즉시 확인할 항목 없음'}</small></a>
  </section>`;
};

/* ---------- RELAI Guide: 완료 → 현재 → 다음 Action, one primary CTA ---------- */
const guideCard = (g, p, archived, created) => {
  const q = g.guidance; if (!q) return '';
  const cur = g.current_phase;
  // A phase transition is never the strong CTA unless it is literally the only thing left to do (every completion criterion met).
  const movePrimary = isMove(q.primary_action);
  const primary = archived ? '' : movePrimary ? html`<button type="button" class="btn btn--primary" data-move-next>${g.next_phase ? `${no2(g.next_phase.sequence)} ${g.next_phase.name} 단계 시작` : q.primary_action.label} →</button>` : ctaLink(q.primary_action, 'btn btn--primary');
  const secondary = archived || !q.secondary_action || isMove(q.secondary_action) ? '' : ctaLink(q.secondary_action, 'link rg__sec');
  return html`<section class="rg" aria-labelledby="rgT" data-tour-id="guidance">
    <header class="rg__h"><span class="rg__mark" aria-hidden="true"><svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M10 1.5l1.9 4.6 4.6 1.9-4.6 1.9L10 14.5 8.1 9.9 3.5 8l4.6-1.9zM4 13l.9 2.1L7 16l-2.1.9L4 19l-.9-2.1L1 16l2.1-.9zM16 12l.7 1.6 1.6.7-1.6.7L16 16.6l-.7-1.6-1.6-.7 1.6-.7z"/></svg></span><b id="rgT">RELAI Guide</b>
      ${raw(created ? '<span class="rg__new">프로젝트가 생성되었습니다.</span>' : '')}</header>
    <div class="rg__body">
      <dl class="rg__meta">
        <div><dt>완료</dt><dd><i class="st st--done" aria-hidden="true">✓</i>${lastDone(g)}</dd></div>
        <div><dt>현재</dt><dd><i class="st st--cur" aria-hidden="true">●</i>${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</dd></div>
      </dl>
      <div class="rg__next">
        <span class="rg__k">다음 Action</span>
        <h2 class="rg__title">${q.title}</h2>
        ${raw(q.description ? html`<p class="rg__d">${q.description}</p>` : '')}
        ${raw(q.warnings && q.warnings.length ? html`<ul class="rg__warn">${raw(q.warnings.map((w) => html`<li><i class="st st--warn" aria-hidden="true">!</i>${w}</li>`).join(''))}</ul>` : '')}
        <div class="rg__cta">${raw(primary)}${raw(secondary)}</div>
      </div>
    </div></section>`;
};

/* ---------- current phase: title + helper + checklist with status icons / chips / contextual actions ---------- */
const STATE = {
  done: { icon: '✓', label: '완료' }, warn: { icon: '!', label: '확인 필요' }, todo: { icon: '○', label: '미시작' }, crit: { icon: '✕', label: '문제 있음' },
};
function rowState(s, info, review) {
  if (s.status === 'COMPLETED') return review.includes(s.step_key) ? 'warn' : 'done';
  if (!info) return 'todo';
  if (info.crit) return 'crit';
  if (info.empty) return 'todo';
  return 'warn';   // data exists but the criterion is not met (or met and waiting to be marked complete)
}
const phasePanel = (g, p, archived) => {
  const cur = g.current_phase; if (!cur) return '';
  const u = `/app/projects/${p.id}`;
  const open = cur.steps.filter((s) => s.status !== 'COMPLETED'); const allDone = !open.length;
  const review = cur.phase_key === 'INITIATION' && g.definition ? g.definition.needs_review : [];
  const movePrimary = isMove(g.guidance && g.guidance.primary_action);
  return html`<section class="np" aria-labelledby="npT">
    <div class="np__h">
      <div class="np__t"><span class="np__no mono">${no2(cur.sequence)}</span><h2 id="npT">${cur.name}</h2><span class="np__cur">현재 단계</span>
        ${raw(cur.phase_key !== 'INITIATION' ? html`<a class="link np__rec" href="${u}/phases/${cur.phase_key}" data-link>단계 완료 조건 보기</a>` : '')}</div>
      <div class="np__p"><b>${cur.progress.done} / ${cur.progress.total}</b><span>완료</span><span class="pbar pbar--g"><i style="width:${cur.progress.percent}%"></i></span></div>
    </div>
    <p class="np__d">${cur.description}</p>
    <ol class="np__list">${raw(cur.steps.map((s) => {
      const info = stepInfo(cur.phase_key, s.step_key, g, p.id);
      const state = rowState(s, info, review);
      const action = archived || state === 'done' ? '' : state === 'warn' && info && info.ok ? { label: '완료 처리', href: `${u}/phases/${cur.phase_key}#step-${s.id}` } : info ? info.cta : { label: '완료 조건 보기', href: `${u}/phases/${cur.phase_key}#step-${s.id}` };
      const text = s.status === 'COMPLETED' && state === 'warn' ? '완료 후 내용이 수정되었습니다. 다시 확인해 주세요.' : info ? info.text : s.completion_criteria;
      return html`<li class="is-${state}">
        <i class="st st--${state}" aria-hidden="true">${STATE[state].icon}</i>
        <div class="np__m"><span class="np__st">${s.title}</span><span class="np__info">${text}</span></div>
        <span class="np__lab np__lab--${state}">${STATE[state].label}</span>
        ${raw(action ? html`<a class="link np__go" href="${action.href}" data-link>${action.label}</a>` : '<span class="np__go"></span>')}
      </li>`;
    }).join(''))}</ol>
    ${raw(allDone || (!archived && g.next_phase && !movePrimary) ? html`<div class="np__f">
      ${raw(allDone ? html`<span class="np__msg"><i class="st st--done" aria-hidden="true">✓</i><b>${cur.name} 단계의 완료 조건을 모두 충족했습니다.</b> ${g.next_phase ? `다음 단계: ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : '마지막 단계입니다.'}</span>` : '<span class="np__msg"></span>')}
      ${raw(!archived && g.next_phase && !movePrimary ? html`<button type="button" class="link linkbtn np__move" id="next">${no2(g.next_phase.sequence)} ${g.next_phase.name} 단계로 전환…</button>` : '')}
    </div>` : '')}
  </section>`;
};

export async function nextPage(id, main = $('#main')) {
  // BUG-001: strip ?created=1 / ?move=next right away (not after the awaits), so a navigation made meanwhile is never overwritten.
  { const qp0 = new URLSearchParams(location.search); nextPage._flag = qp0.get('created') === '1' ? `created:${id}` : qp0.get('move') === 'next' ? `move:${id}` : null; if (nextPage._flag) history.replaceState(null, '', `/app/projects/${id}`); }
  const g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  document.title = `What’s Next? — ${p.name} — RELAI`;
  const archived = p.status === 'ARCHIVED';
  const created = nextPage._flag === `created:${id}`; const moveNext = nextPage._flag === `move:${id}`; nextPage._flag = null;
  await ob.get();
  main.innerHTML = html`<div class="page page--wide page--flow nx">
    ${raw(projectHead(p, g, { tab: 'next' }))}
    ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 단계와 할 일은 조회만 할 수 있습니다.</div>' : '')}
    ${raw(summaryBar(g, p))}
    ${raw(phaseStepper(g, p.id))}
    ${raw(guideCard(g, p, archived, created))}
    ${raw(phasePanel(g, p, archived))}
  </div>`;
  const move = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) nextPage(id, main); };
  const nb = $('#next'); if (nb) nb.onclick = move;
  main.querySelectorAll('[data-move-next]').forEach((b) => { b.onclick = g.next_phase ? move : null; });
  bindCoach(main);
  if (moveNext && g.next_phase && !archived) move();
}
