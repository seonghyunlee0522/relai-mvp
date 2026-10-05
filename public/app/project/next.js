/* What’s Next? — the project's action-oriented home. Exactly four jobs (Lifecycle V2 §8):
 *   1. where the project is in the lifecycle      → compact stepper  ✓ 착수 ─ ● 요구사항 정의 ─ ○ 분석·설계 …
 *   2. the one thing to do first                  → RELAI Guide (one primary CTA, task-centred label, → for navigation)
 *   3. activities of the current phase and state  → ✓ 완료 · ● 진행 중 · ○ 미시작 · — 제외, with importance 필수/권장/선택
 *   4. what the next phase is                     → footer line + "NN 다음 단계 시작 →" once the REQUIRED gate is met
 * No percentage anywhere. Activity states are derived server-side (server/activities.js) from real project data;
 * 완료 처리 / 제외 / 되돌리기 are the only stored marks (PATCH …/steps/:sid). No intermediate phase screens. */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { moveToPhase, projectHead } from './guide.js';
import { phaseStepper } from './status.js';
import { ACTIVITY_STATE } from '../shared/constants.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { navigate } from '../core/router.js';
import { bindCoach } from '../onboarding/ui.js';
import { ob } from '../onboarding/state.js';

const isMove = (a) => Boolean(a && /\?move=next$/.test(a.href));
const ctaLink = (a, cls) => (a ? html`<a class="${cls}" href="${a.href}" data-link>${a.label}</a>` : '');

/* ---------- RELAI Guide: 현재 단계 → 다음 할 일, one primary CTA ---------- */
const guideCard = (g, p, archived, created) => {
  const q = g.guidance; if (!q) return '';
  const cur = g.current_phase; const nx = g.next_phase;
  const movePrimary = isMove(q.primary_action);
  const primary = archived ? '' : movePrimary ? html`<button type="button" class="btn btn--primary" data-move-next>${nx ? `${no2(nx.sequence)} ${nx.name} 단계 시작 →` : q.primary_action.label}</button>` : ctaLink(q.primary_action, 'btn btn--primary');
  const secondary = archived || !q.secondary_action || isMove(q.secondary_action) ? '' : ctaLink(q.secondary_action, 'link rg__sec');
  return html`<section class="rg" aria-labelledby="rgT" data-tour-id="guidance">
    <header class="rg__h"><span class="rg__mark" aria-hidden="true"><svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M10 1.5l1.9 4.6 4.6 1.9-4.6 1.9L10 14.5 8.1 9.9 3.5 8l4.6-1.9zM4 13l.9 2.1L7 16l-2.1.9L4 19l-.9-2.1L1 16l2.1-.9zM16 12l.7 1.6 1.6.7-1.6.7L16 16.6l-.7-1.6-1.6-.7 1.6-.7z"/></svg></span><b id="rgT">RELAI Guide</b>
      ${raw(created ? '<span class="rg__new">프로젝트가 생성되었습니다.</span>' : '')}</header>
    <div class="rg__body">
      <dl class="rg__meta">
        <div><dt>현재 단계</dt><dd><i class="st st--cur" aria-hidden="true">●</i>${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</dd></div>
        <div><dt>다음 단계</dt><dd><i class="st st--todo" aria-hidden="true">○</i>${nx ? `${no2(nx.sequence)} ${nx.name}` : '마지막 단계'}</dd></div>
      </dl>
      <div class="rg__next">
        <span class="rg__k">다음 할 일</span>
        <h2 class="rg__title">${q.title}</h2>
        ${raw(q.description ? html`<p class="rg__d">${q.description}</p>` : '')}
        ${raw(q.warnings && q.warnings.length ? html`<ul class="rg__warn">${raw(q.warnings.map((w) => html`<li><i class="st st--warn" aria-hidden="true">!</i>${w}</li>`).join(''))}</ul>` : '')}
        <div class="rg__cta">${raw(primary)}${raw(secondary)}</div>
      </div>
    </div></section>`;
};

/* ---------- current phase activities (Process + Read view) ---------- */
const stateCls = (a) => (a.state === 'COMPLETED' ? 'done' : a.state === 'SKIPPED' ? 'skip' : a.state === 'IN_PROGRESS' ? (a.crit ? 'crit' : 'prog') : 'todo');
/** CTA only where action is due: the current activity (first open one) and in-progress ones. Done / future / skipped rows carry none. */
const activityRow = (a, archived, isCurrent) => {
  const st = ACTIVITY_STATE[a.state] || ACTIVITY_STATE.NOT_STARTED; const cls = stateCls(a);
  const manualDone = a.status === 'COMPLETED'; const skipped = a.status === 'SKIPPED';
  const showCta = !archived && a.cta && (isCurrent || a.state === 'IN_PROGRESS');
  const acts = [];
  if (!archived) {
    if (showCta) acts.push(html`<a class="link np__go" href="${a.cta.href}" data-link>${a.cta.label}</a>`);
    if (skipped) acts.push(html`<button type="button" class="link linkbtn np__act" data-step="${a.id}" data-status="TODO">업무 다시 시작 →</button>`);
    else if (manualDone && isCurrent) acts.push(html`<button type="button" class="link linkbtn np__act np__act--dim" data-step="${a.id}" data-status="TODO">되돌리기</button>`);
    else if (a.state !== 'COMPLETED' && (isCurrent || a.state === 'IN_PROGRESS')) {
      const manual = !a.derived && a.linked_feature_type !== 'definition';
      if (manual || (a.state === 'IN_PROGRESS' && a.linked_feature_type !== 'definition')) acts.push(html`<button type="button" class="link linkbtn np__act" data-step="${a.id}" data-status="COMPLETED" title="${a.derived ? '실제 데이터 기준과 별개로 이 업무를 완료로 표시합니다' : '이 업무를 완료로 표시합니다'}">완료 처리</button>`);
      if (a.importance !== 'REQUIRED' && a.linked_feature_type !== 'definition') acts.push(html`<button type="button" class="link linkbtn np__act np__skip" data-step="${a.id}" data-status="SKIPPED" data-title="${a.title}" title="이번 프로젝트에서는 수행하지 않는 업무로 기록합니다">↷ 건너뛰기</button>`);
    }
  }
  const href = a.linked_feature_type === 'definition' && a.cta ? a.cta.href : null;   // 착수 activities open their work screen from the row itself
  return html`<li class="np__row is-${cls} ${isCurrent ? 'is-cur' : ''} ${href ? 'is-link' : ''}" data-act="${a.id}" ${raw(href ? html`data-href="${href}" tabindex="0" role="link"` : '')}>
    <i class="st st--${cls}" aria-hidden="true">${st.icon}</i>
    <div class="np__m">
      <span class="np__st">${a.title}<small class="np__imp">${a.importance_label}</small></span>
      <span class="np__purpose">${a.description}</span>
      <span class="np__info">${a.text}</span>
    </div>
    <span class="np__lab">${st.label}</span>
    <span class="np__acts">${raw(acts.join(''))}</span>
  </li>`;
};

const phasePanel = (g, p, archived) => {
  const cur = g.current_phase; if (!cur) return '';
  const acts = cur.steps || []; const s = cur.summary || { required_open: 0, gate_met: true };
  const movePrimary = isMove(g.guidance && g.guidance.primary_action);
  const current = acts.find((a) => a.state !== 'COMPLETED' && a.state !== 'SKIPPED');
  const allDone = !current;
  const remain = s.required_open ? `필수 업무 ${s.required_open}건 남음` : allDone ? '이 단계의 업무를 모두 처리했습니다' : '필수 업무를 모두 마쳤습니다';
  return html`<section class="np" aria-labelledby="npT">
    <div class="np__h">
      <div class="np__t"><span class="np__no mono">${no2(cur.sequence)}</span><h2 id="npT">${cur.name}</h2><span class="np__cur">현재 단계</span></div>
      <span class="np__remain ${s.required_open ? '' : 'is-good'}">${remain}</span>
    </div>
    <p class="np__d">${cur.description}</p>
    <ol class="np__list">${raw(acts.map((a) => activityRow(a, archived, current && a.id === current.id)).join(''))}</ol>
    <div class="np__f ${allDone && g.next_phase ? 'np__f--ready' : ''}">
      <span class="np__msg">${raw(g.next_phase ? (allDone ? html`<b>${cur.name} 단계의 필요한 업무가 정리되었습니다.</b> 다음 단계 · ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : html`다음 단계: <b>${no2(g.next_phase.sequence)} ${g.next_phase.name}</b>${s.gate_met ? ' · 남은 권장·선택 업무를 정리하거나 건너뛰면 진행할 수 있습니다.' : ' · 필수 업무를 마치면 진행할 수 있습니다.'}`) : '마지막 단계입니다.')}</span>
      ${raw(!archived && g.next_phase && !movePrimary ? html`<button type="button" class="${allDone ? 'btn btn--primary btn--sm' : 'link linkbtn np__move'}" id="next">${g.next_phase.name}(으)로 진행 →</button>` : '')}
    </div>
  </section>`;
};

export async function nextPage(id, main = $('#main')) {
  // BUG-001: strip ?created=1 / ?move=next right away (not after the awaits), so a navigation made meanwhile is never overwritten.
  { const qp0 = new URLSearchParams(location.search); nextPage._flag = qp0.get('created') === '1' ? `created:${id}` : qp0.get('move') === 'next' ? `move:${id}` : null; if (nextPage._flag) history.replaceState(null, '', `/app/projects/${id}`); }
  let g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  document.title = `What’s Next? — ${p.name} — RELAI`;
  const archived = p.status === 'ARCHIVED';
  const created = nextPage._flag === `created:${id}`; const moveNext = nextPage._flag === `move:${id}`; nextPage._flag = null;
  await ob.get();
  let pendingMove = moveNext && !archived;
  const draw = () => {
    main.innerHTML = html`<div class="page page--wide page--flow nx">
      ${raw(projectHead(p, g, { tab: 'next' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 단계와 업무는 조회만 할 수 있습니다.</div>' : '')}
      ${raw(phaseStepper(g, p.id))}
      ${raw(guideCard(g, p, archived, created))}
      ${raw(phasePanel(g, p, archived))}
    </div>`;
    const move = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) { g = await api('GET', wsApi(`/${id}`)); draw(); } };
    const nb = $('#next'); if (nb) nb.onclick = move;
    main.querySelectorAll('[data-move-next]').forEach((b) => { b.onclick = g.next_phase ? move : null; });
    main.querySelectorAll('.np__row[data-href]').forEach((row) => { const go = () => navigate(row.dataset.href); row.onclick = (e) => { if (!e.target.closest('a,button')) go(); }; row.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('a,button')) { e.preventDefault(); go(); } }; });
    main.querySelectorAll('[data-step]').forEach((b) => b.onclick = async () => {
      if (b.dataset.status === 'SKIPPED' && !(await confirmDialog({ title: '이 업무를 건너뛸까요?', body: `'${b.dataset.title}'은(는) 이번 프로젝트에서 수행하지 않는 것으로 기록됩니다. 나중에 다시 시작할 수 있습니다.`, confirm: '건너뛰기' }))) return;
      b.disabled = true;
      try { g = await api('PATCH', wsApi(`/${id}/steps/${b.dataset.step}`), { status: b.dataset.status }); toast(b.dataset.status === 'COMPLETED' ? '완료 처리했습니다.' : b.dataset.status === 'SKIPPED' ? '이 업무를 건너뛰었습니다.' : '업무를 다시 시작합니다.'); draw(); }
      catch (e) { toast(e.message); b.disabled = false; }
    });
    bindCoach(main);
    if (pendingMove && g.next_phase) { pendingMove = false; move(); }
  };
  draw();
}
