/* What’s Next? — the project’s landing screen. Not a dashboard: it answers, in this order,
 *   무엇을 완료했나 → 지금 어디에 있나 → 다음에 무엇을 하나 → 어느 탭으로 가나
 * Dashboard information (attention, upcoming, execution %, coverage, health) lives in Overview (overview.js).
 * Everything here reads from the project GET payload (guide + stats + guidance); nothing is stored. */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { store } from '../core/ui.js';
import { moveToPhase, projectHead, stepInfo } from './guide.js';
import { bindCoach, phaseIntro } from '../onboarding/ui.js';
import { ob } from '../onboarding/state.js';

/* ---------- tab naming: every CTA says which top tab it opens ("[프로젝트 정의]로 이동 →") ---------- */
const TAB_OF = [[/\/definition/, '프로젝트 정의'], [/\/requirements/, 'Requirements'], [/\/wbs/, 'WBS'], [/\/changes/, 'Changes'], [/\/issues/, 'Issues & Risks'], [/\/tests/, 'Tests & Acceptance'], [/\/phases\//, '단계 기록'], [/\/overview/, 'Overview'], [/\/settings/, 'Settings']];
export const tabOf = (href) => { const h = String(href || ''); const hit = TAB_OF.find(([re]) => re.test(h)); return hit ? hit[1] : null; };
const batchim = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0; };
const ro = (tab) => (batchim(tab) ? '으로' : '로');
/** `<a>` that reads "[탭] 로 이동 →" (tab shown as a chip) — the single pattern for navigation CTAs on this screen. */
export const goTab = (href, { cls = 'btn btn--primary', fallback = '이동' } = {}) => {
  if (!href) return '';
  const tab = tabOf(href);
  return html`<a class="${cls} go" href="${href}" data-link>${raw(tab ? html`<span class="go__tab">${tab}</span>${ro(tab)} 이동 →` : html`${fallback} →`)}</a>`;
};

/** 완료한 일: project created → earlier phases completed → completed steps of the current phase (last 3). Explainable, data-only. */
function doneItems(g) {
  const items = ['프로젝트 생성'];
  for (const ph of g.phases) { if (ph.status === 'COMPLETED' && !ph.is_current) items.push(`${ph.name} 단계 완료`); }
  const cur = g.current_phase;
  if (cur) for (const s of cur.steps) if (s.status === 'COMPLETED') items.push(s.title);
  if (g.guidance && g.guidance.rule === 'INIT_DONE' && !items.includes('프로젝트 정의 완료')) items.push('프로젝트 정의 완료');
  return items.slice(-3);
}

/* ---------- RELAI Guide (collapsible; the next action never disappears) ---------- */
const guideCard = (g, p, archived, created) => {
  const q = g.guidance; if (!q) return '';
  const cur = g.current_phase; const collapsed = store.get(`guide.collapsed.${p.id}`, false);
  const done = doneItems(g);
  const isMove = (a) => a && /\?move=next$/.test(a.href);
  const primary = archived ? '' : isMove(q.primary_action) ? html`<button type="button" class="btn btn--primary go" data-move-next>${q.primary_action.label} →</button>` : goTab(q.primary_action && q.primary_action.href, {});
  const secondary = archived || !q.secondary_action ? '' : isMove(q.secondary_action) ? html`<button type="button" class="link linkbtn go--sec" data-move-next>${q.secondary_action.label} →</button>` : goTab(q.secondary_action.href, { cls: 'link go--sec', fallback: q.secondary_action.label });
  const nextTab = q.primary_action ? tabOf(q.primary_action.href) : null;
  return html`<section class="rg ${collapsed ? 'is-collapsed' : ''}" aria-labelledby="rgT" data-tour-id="guidance">
    <header class="rg__h">
      <span class="rg__mark" aria-hidden="true"><svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M10 1.5l1.9 4.6 4.6 1.9-4.6 1.9L10 14.5 8.1 9.9 3.5 8l4.6-1.9zM4 13l.9 2.1L7 16l-2.1.9L4 19l-.9-2.1L1 16l2.1-.9zM16 12l.7 1.6 1.6.7-1.6.7L16 16.6l-.7-1.6-1.6-.7 1.6-.7z"/></svg></span>
      <b id="rgT">RELAI Guide</b>
      ${raw(collapsed ? html`<span class="rg__line"><span class="rg__sep">·</span>현재: <b>${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</b><span class="rg__sep">·</span>다음 할 일: <a class="link" href="${q.primary_action ? q.primary_action.href : '#'}" data-link>${nextTab || q.title} →</a></span>` : html`<span class="rg__sub">프로젝트 상태를 읽고 다음 행동을 안내합니다</span>`)}
      <button type="button" class="rg__toggle" id="rg-toggle" aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="rg-body">${collapsed ? '펼치기' : '접기'}</button>
    </header>
    <div class="rg__body" id="rg-body" ${collapsed ? 'hidden' : ''}>
      ${raw(created ? '<p class="rg__new">프로젝트가 생성되었습니다.</p>' : '')}
      <div class="rg__flow">
        <div class="rg__col rg__col--done"><span class="rg__k">완료한 일</span><ul>${raw(done.map((d) => html`<li><i class="st st--done" aria-hidden="true">✓</i>${d}</li>`).join(''))}</ul></div>
        <span class="rg__arrow" aria-hidden="true">→</span>
        <div class="rg__col rg__col--cur"><span class="rg__k">현재 단계</span><div class="rg__cur"><i class="st st--cur" aria-hidden="true">●</i><b>${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</b>${raw(cur ? html`<small>${cur.progress.done} / ${cur.progress.total} 완료</small>` : '')}</div></div>
        <span class="rg__arrow" aria-hidden="true">→</span>
        <div class="rg__col rg__col--next"><span class="rg__k">다음 할 일</span>
          <h2 class="rg__title">${q.title}</h2>
          ${raw(q.description ? html`<p class="rg__d">${q.description}</p>` : '')}
          ${raw(q.why ? html`<p class="rg__why">${q.why}</p>` : '')}
          ${raw(q.warnings && q.warnings.length ? html`<ul class="rg__warn">${raw(q.warnings.map((w) => html`<li><i class="st st--warn" aria-hidden="true">!</i>${w}</li>`).join(''))}</ul>` : '')}
          <div class="rg__cta">${raw(primary)}${raw(secondary)}</div>
          ${raw(q.next_preview ? html`<p class="rg__next"><span>Next</span>${q.next_preview}</p>` : '')}
        </div>
      </div>
    </div></section>`;
};

/* ---------- current phase: progress + scannable checklist (✓ 완료 · ● 진행 중 · ○ 미완료) ---------- */
const phasePanel = (g, p, archived) => {
  const cur = g.current_phase; if (!cur) return '';
  const u = `/app/projects/${p.id}`;
  const open = cur.steps.filter((s) => s.status !== 'COMPLETED'); const nextStep = open[0]; const allDone = !open.length;
  const review = cur.phase_key === 'INITIATION' && g.definition ? g.definition.needs_review : [];
  return html`<section class="np" aria-labelledby="npT">
    <div class="np__h">
      <div class="np__t"><span class="np__no mono">${no2(cur.sequence)}</span><h2 id="npT">${cur.name}</h2><span class="np__cur">현재 단계</span></div>
      <div class="np__p"><b>${cur.progress.done} / ${cur.progress.total}</b><span>완료</span><span class="pbar pbar--g"><i style="width:${cur.progress.percent}%"></i></span></div>
    </div>
    <p class="np__d">${cur.description}</p>
    <h3 class="np__lh">현재 단계 완료 조건</h3>
    <ol class="np__list">${raw(cur.steps.map((s) => {
      const isDone = s.status === 'COMPLETED'; const warn = isDone && review.includes(s.step_key);
      const isNext = !isDone && nextStep && nextStep.id === s.id;
      const info = stepInfo(cur.phase_key, s.step_key, g, p.id);
      const state = warn ? 'warn' : isDone ? 'done' : isNext ? 'cur' : 'todo';
      const label = { done: '완료', cur: '진행 중', todo: '미완료', warn: '재확인' }[state];
      const href = info ? info.cta.href : `${u}/phases/${cur.phase_key}#step-${s.id}`;
      return html`<li class="is-${state}">
        <i class="st st--${state}" aria-hidden="true">${state === 'done' ? '✓' : state === 'cur' ? '●' : state === 'warn' ? '!' : '○'}</i>
        <div class="np__m"><span class="np__st">${s.title}</span><span class="np__info">${info ? info.text : s.completion_criteria}</span></div>
        <span class="np__lab np__lab--${state}">${label}</span>
        ${raw(archived || (isDone && !warn) ? '<span class="np__go"></span>' : goTab(href, { cls: 'link np__go', fallback: '이동' }))}
      </li>`;
    }).join(''))}</ol>
    <div class="np__f">
      ${raw(allDone ? html`<span class="np__msg"><i class="st st--done" aria-hidden="true">✓</i><b>${cur.name} 단계의 완료 조건을 모두 충족했습니다.</b> ${g.next_phase ? `다음 단계: ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : '마지막 단계입니다.'}</span>`
        : html`<span class="np__msg">각 항목은 해당 탭에서 작업하고 완료 처리합니다. 저장은 데이터만 저장하고, 완료 처리가 이 목록과 RELAI Guide를 갱신합니다.</span>`)}
      <span class="np__btns">${raw(cur.phase_key !== 'INITIATION' ? goTab(`${u}/phases/${cur.phase_key}`, { cls: 'btn btn--secondary btn--sm' }) : '')}
        ${raw(!archived && g.next_phase ? html`<button class="btn ${allDone ? 'btn--primary' : 'btn--secondary'} btn--sm" id="next">${g.next_phase.name} 단계로 이동 →</button>` : '')}</span>
    </div>
  </section>`;
};

/* ---------- side: compact lifecycle (완료 → 현재 → 다음), no dashboard numbers ---------- */
const lifecycle = (g, p) => {
  const u = `/app/projects/${p.id}`;
  return html`<aside class="nl" aria-labelledby="nlT"><div class="nl__h"><b id="nlT">진행 순서</b><a class="link" href="${u}/overview" data-link>Overview →</a></div>
    <ol class="nl__list">${raw(g.phases.map((ph) => {
      const state = ph.is_current ? 'cur' : ph.status === 'COMPLETED' ? 'done' : ph.status === 'IN_PROGRESS' ? 'open' : 'todo';
      const href = ph.phase_key === 'INITIATION' ? `${u}/definition` : `${u}/phases/${ph.phase_key}`;
      return html`<li class="is-${state}"><a href="${href}" data-link><i class="st st--${state === 'open' ? 'todo' : state}" aria-hidden="true">${state === 'done' ? '✓' : state === 'cur' ? '●' : '○'}</i><span>${no2(ph.sequence)} ${ph.name}</span><small>${state === 'cur' ? '현재' : state === 'done' ? '완료' : `${ph.progress.done}/${ph.progress.total}`}</small></a></li>`;
    }).join(''))}</ol>
    <p class="nl__hint">단계를 누르면 그 단계의 완료 조건과 기록을 봅니다. 프로젝트 전체 현황은 Overview에서 확인하세요.</p></aside>`;
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
    ${raw(guideCard(g, p, archived, created))}
    ${raw(g.current_phase ? phaseIntro(g.current_phase.phase_key, g.current_phase.name) : '')}
    <div class="nx__grid"><div class="nx__main">${raw(phasePanel(g, p, archived))}</div>${raw(lifecycle(g, p))}</div>
  </div>`;
  const tg = $('#rg-toggle'); if (tg) tg.onclick = () => { store.set(`guide.collapsed.${p.id}`, !store.get(`guide.collapsed.${p.id}`, false)); nextPage(id, main); };
  const nb = $('#next');
  if (nb) nb.onclick = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) nextPage(id, main); };
  main.querySelectorAll('[data-move-next]').forEach((b) => { b.onclick = nb ? () => nb.click() : null; });
  bindCoach(main);
  if (moveNext && nb) nb.click();
}
