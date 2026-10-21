/* What’s Next? — the project's action-oriented home. Exactly four jobs (Lifecycle V2 §8):
 *   1. where the project is in the lifecycle      → compact stepper  ✓ 착수 ─ ● 요구사항 정의 ─ ○ 분석·설계 …
 *   2. the one thing to do first                  → RELAI Guide (one primary CTA, task-centred label, → for navigation)
 *   3. activities of the current phase and state  → ✓ 완료 · ● 진행 중 · ○ 미시작 · — 제외, with importance 필수/권장/선택
 *   4. what the next phase is                     → footer line + "NN 다음 단계 시작 →" once the REQUIRED gate is met
 * Status (완료/진행 중/미시작/제외) and importance (필수/권장/선택) are badges; no percentage anywhere. Activity states are derived server-side (server/activities.js) from real project data;
 * 완료 처리 / 제외 / 되돌리기 are the only stored marks (PATCH …/steps/:sid). No intermediate phase screens.
 * 완료 처리 is offered here only for `manual` activities (no data signal decides them: 06/07 checklist activities, 의사결정 기록 …);
 * data-driven ones complete on their work screen. */
import { api, wsApi } from '../core/api.js';
import { $, html, no2, raw } from '../core/dom.js';
import { isPhone, pcLine } from '../core/device.js';
import { moveToPhase, projectHead } from './guide.js';
import { phaseStepper, phaseState, daysUntil } from './status.js';
import { relTime } from '../shared/jira.js';
import { ACTIVITY_STATE } from '../shared/constants.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { navigate } from '../core/router.js';
import { bindCoach } from '../onboarding/ui.js';
import { ob } from '../onboarding/state.js';
import { josa, pickJosa } from '../shared/josa.js';
import { noApprovalLine, bindPlanMenu } from './initiation.js';
import { goLiveDialog, carryoverDialog } from './golive.js';
import { handoverDialog, closeDialog, closeManual, closeReady, closedPanel, reopenProject } from './closing.js';
import { closeOnOutsideTap } from '../core/outside.js';

const isMove = (a) => Boolean(a && /\?move=next$/.test(a.href));
/** /api/… hrefs (사업수행계획서 내려받기) are downloads, not SPA routes. */
const ctaLink = (a, cls) => (!a ? '' : /^\/api\//.test(a.href) ? html`<button type="button" class="${cls} linkbtn" data-dl="${a.href}">${a.label}</button>` : html`<a class="${cls}" href="${a.href}" data-link>${a.label}</a>`);

/* ---------- RELAI Guide: one compact card — title, 1–2 lines of "why", CTA bottom-right. The phase position is the stepper's job. ---------- */
const guideCard = (g, p, archived, created) => {
  const q = g.guidance; if (!q) return '';
  const cur = g.current_phase; const nx = g.next_phase;
  const movePrimary = isMove(q.primary_action);
  const primary = archived ? '' : movePrimary ? html`<button type="button" class="btn btn--primary btn--sm" data-move-next>${nx ? `${no2(nx.sequence)} ${nx.name} 단계 시작 →` : q.primary_action.label}</button>` : ctaLink(q.primary_action, 'btn btn--primary btn--sm');
  // One next step per screen (design §1.1, J1): when the phase can move on, the move is the only CTA.
  const secondary = archived || movePrimary || !q.secondary_action || isMove(q.secondary_action) ? '' : ctaLink(q.secondary_action, 'link rg__sec');
  return html`<section class="rg" aria-labelledby="rgT" data-tour-id="guidance">
    <header class="rg__h">
      <span class="rg__mark" aria-hidden="true"><svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M10 1.5l1.9 4.6 4.6 1.9-4.6 1.9L10 14.5 8.1 9.9 3.5 8l4.6-1.9zM4 13l.9 2.1L7 16l-2.1.9L4 19l-.9-2.1L1 16l2.1-.9zM16 12l.7 1.6 1.6.7-1.6.7L16 16.6l-.7-1.6-1.6-.7 1.6-.7z"/></svg></span><b id="rgT">RELAI 안내</b>
      ${raw(created ? '<span class="rg__new">프로젝트가 생성되었습니다.</span>' : '')}</header>
    <div class="rg__body">
      <h2 class="rg__title">${q.title}</h2>
      <div class="rg__row">
        <p class="rg__d">${q.description || ''}${raw(q.warnings && q.warnings.length ? q.warnings.map((w) => { const href = q.warning_links && q.warning_links[w];   // 03 완료 가이드: each warning links to its WBS filter (never blocks)
          return html`<span class="rg__warn"><i class="st st--warn" aria-hidden="true">!</i>${raw(href && !archived ? html`<a href="${href}" data-link>${w}</a>` : html`${w}`)}</span>`; }).join('') : '')}</p>
        ${raw(primary || secondary ? html`<div class="rg__cta">${raw(secondary)}${raw(primary)}</div>` : '')}
      </div>
    </div></section>`;
};

/* ---------- current phase activities (Process + Read view) ---------- */
const GATE_KEYS = new Set(['KICKOFF', 'APPROVAL', 'BASELINE_APPROVAL']);   // 01 착수 / 02 확정 확인 rows show their one-line status (준비 중 3/4 · ✓ 확인 · 홍길동 …)
const stateCls = (a) => (a.state === 'COMPLETED' ? 'done' : a.state === 'SKIPPED' ? 'skip' : a.state === 'IN_PROGRESS' ? (a.crit ? 'crit' : 'prog') : 'todo');
/** A row is clickable where action is due: the current activity (first open one), in-progress ones, and 착수 definition rows. Done / future / skipped rows are not.
 * State is shown once, by the badge on the right (no leading icon). `markable` = rows whose phase is current or already reached
 * (manual activities can be completed there); future phases stay read-only. */
const activityRow = (a, archived, isCurrent, browse = false, markable = false) => {
  const st = ACTIVITY_STATE[a.state] || ACTIVITY_STATE.NOT_STARTED; const cls = stateCls(a);
  const manualDone = a.status === 'COMPLETED'; const skipped = a.status === 'SKIPPED';
  // browse = another phase's list opened from the stepper: every row with a work screen is a way into it
  const href = (!archived || isPhone()) && a.cta && (browse || isCurrent || a.state === 'IN_PROGRESS' || a.linked_feature_type === 'definition') ? a.cta.href : null;   // the row itself opens the work screen (same href the server CTA carries) — no separate '… →' link
  const acts = [];
  // US-3: an inline row action (주간보고 만들기 / 이어서 작성) — secondary: the Guide CTA stays the screen's only primary
  if (!archived && a.row_action && a.cta) acts.push(html`<a class="btn btn--secondary btn--xs np__rowcta" href="${a.cta.href}" data-link data-row-cta="${a.step_key}">${a.cta.label}</a>`);
  if (!archived) {
    if (skipped) acts.push(html`<button type="button" class="link linkbtn np__act" data-step="${a.id}" data-status="TODO">업무 다시 시작 →</button>`);
    else if (manualDone && (isCurrent || (markable && a.manual))) acts.push(html`<button type="button" class="link linkbtn np__act np__act--dim" data-step="${a.id}" data-status="TODO">되돌리기</button>`);
    else if (a.state !== 'COMPLETED' && (isCurrent || a.state === 'IN_PROGRESS' || (markable && a.manual))) {
      // Data-driven activities complete on their work screen; manual ones (no data signal) are completed here.
      if (a.manual && (isCurrent || markable)) {
        const open = a.checklist && a.checklist.total ? a.checklist.total - a.checklist.done : 0;
        acts.push(a.go_live ? html`<button type="button" class="link linkbtn np__act np__done" data-golive title="오픈일과 남은 항목(처리 / 운영 이관)을 정하고 오픈을 기록합니다">✓ 완료 처리</button>`   // Phase 6 US-3: the 오픈 dialog
          : a.handover ? html`<button type="button" class="link linkbtn np__act np__done" data-handover title="인수자·인수일과 운영 이관 항목의 운영 담당을 기록합니다">✓ 완료 처리</button>`   // Phase 7 US-3
          : a.close ? html`<button type="button" class="link linkbtn np__act np__done" data-close-manual="${a.id}" title="완료보고서를 RELAI 밖에서 작성했다면 사유를 남기고 완료합니다">✓ 완료 처리</button>`   // Phase 7 US-1
          : html`<button type="button" class="link linkbtn np__act np__done" data-step="${a.id}" data-status="COMPLETED" data-title="${a.title}" data-open="${open}" title="이 업무를 완료한 것으로 기록합니다">✓ 완료 처리</button>`);
      }
      if (a.importance !== 'REQUIRED' && a.linked_feature_type !== 'definition') acts.push(html`<button type="button" class="link linkbtn np__act np__skip" data-step="${a.id}" data-status="SKIPPED" data-title="${a.title}" title="이번 프로젝트에서는 수행하지 않는 업무로 기록합니다">↷ 건너뛰기</button>`);
    }
  }
  const impCls = a.importance === 'REQUIRED' ? 'badge--req' : 'badge--muted';
  const stLabel = cls === 'crit' ? '확인 필요' : st.label;
  return html`<li class="np__row is-${cls} ${isCurrent ? 'is-cur' : ''} ${href ? 'is-link' : ''}" data-act="${a.id}" ${raw(href ? html`data-href="${href}" tabindex="0" role="link"` : '')}>
    <div class="np__m">
      <span class="np__st"><span class="badge badge--imp ${impCls}">${a.importance_label}</span>${a.title}</span>
      <span class="np__purpose">${a.description}</span>
      ${raw(a.text && ((GATE_KEYS.has(a.step_key) && a.state !== 'NOT_STARTED') || a.row_text) ? html`<span class="np__sum ${a.crit ? 'is-crit' : ''}" data-row-text>${a.text}</span>` : '')}
      ${raw(a.hint ? html`<span class="np__hint">${a.hint}</span>` : '')}
      ${raw(a.reopen_note ? html`<span class="np__hint np__reopen" data-reopen-note>${a.reopen_note}</span>` : '')}
      ${raw(a.links && !archived ? html`<span class="np__links" data-row-links>${raw(a.links.map((l) => html`<a class="link" href="${l.href}" data-link>${l.label}</a>`).join(''))}</span>` : '')}
      ${raw(a.import_ms && !archived ? html`<span class="np__imp">${a.import_ms.text} <button type="button" class="btn btn--secondary btn--xs" data-import-ms>가져오기</button></span>` : '')}
    </div>
    <span class="badge badge--st is-${cls}">${stLabel}</span>
    <span class="np__acts">${raw(acts.join(''))}</span>
  </li>`;
};

/** Another phase's activities, opened from the stepper (…?phase=KEY). Same rows as the current phase, no phase-move footer. */
const otherPhasePanel = (g, ph, archived) => {
  const acts = ph.steps || []; const s = ph.summary || { required_open: 0 }; const cur = g.current_phase;
  const st = phaseState(ph); const passed = st === 'done' || st === 'gap';
  const tag = st === 'done' ? (ph.status === 'COMPLETED' ? '<span class="np__tag is-done">✓ 완료</span>' : '<span class="np__tag is-done">✓ 다음 단계로 진행됨</span>') : st === 'gap' ? '<span class="np__tag is-gap">다음 단계로 진행됨 · 필수 업무 남음</span>' : '<span class="np__tag">예정</span>';
  const remain = passed ? (s.required_open ? `남은 필수 업무 ${s.required_open}건 — 필요하면 지금도 처리할 수 있습니다` : '이 단계의 필수 업무를 모두 마쳤습니다') : `필수 업무 ${s.required_open || 0}건`;
  const rows = acts.map((a) => activityRow(a, archived, false, true, passed)).join('');
  const hasActs = /class="np__acts">(?!<\/span>)/.test(rows);
  return html`<section class="np np--other" aria-labelledby="npT">
    <div class="np__h">
      <div class="np__t"><span class="np__no mono">${no2(ph.sequence)}</span><h2 id="npT">${ph.name}</h2>${raw(tag)}</div>
      <span class="np__remain ${passed && !s.required_open ? 'is-good' : ''}">${remain}</span>
    </div>
    <p class="np__d">${ph.description}</p>
    ${raw(ph.phase_key === 'INITIATION' || ph.phase_key === 'REQUIREMENTS' || ph.phase_key === 'TESTING' ? noApprovalLine(g, ph.phase_key) : '')}
    <ol class="np__list ${hasActs ? '' : 'np__list--noacts'}">${raw(rows)}</ol>
    <div class="np__f"><span class="np__msg">${raw(cur ? html`현재 단계는 <b>${no2(cur.sequence)} ${cur.name}</b>입니다.` : '')}</span>
      <a class="link np__back" href="/app/projects/${g.project.id}" data-link>현재 단계 업무 보기 →</a></div>
  </section>`;
};

const phasePanel = (g, p, archived) => {
  const cur = g.current_phase; if (!cur) return '';
  const acts = cur.steps || []; const s = cur.summary || { required_open: 0, gate_met: true };
  const movePrimary = isMove(g.guidance && g.guidance.primary_action);
  const current = acts.find((a) => a.state !== 'COMPLETED' && a.state !== 'SKIPPED');
  const allDone = !current;
  const remain = s.required_open ? `필수 업무 ${s.required_open}건 남음` : allDone ? '이 단계의 업무를 모두 처리했습니다' : '필수 업무를 모두 마쳤습니다';
  const rows = acts.map((a) => activityRow(a, archived, current && a.id === current.id, false, true)).join('');
  const hasActs = /class="np__acts">(?!<\/span>)/.test(rows);   // status badges hug the right edge when no row carries an action
  return html`<section class="np" aria-labelledby="npT">
    <div class="np__h">
      <div class="np__t"><span class="np__no mono">${no2(cur.sequence)}</span><h2 id="npT">${cur.name}</h2><span class="np__cur">현재 단계</span></div>
      <span class="np__remain ${s.required_open ? '' : 'is-good'}">${remain}</span>
    </div>
    <p class="np__d">${cur.description}</p>
    <ol class="np__list ${hasActs ? '' : 'np__list--noacts'}">${raw(rows)}</ol>
    <div class="np__f ${allDone && g.next_phase ? 'np__f--ready' : ''}">
      <span class="np__msg">${raw(g.next_phase ? (allDone ? html`<b>${cur.name} 단계의 필요한 업무가 정리되었습니다.</b> 다음 단계 · ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : html`다음 단계: <b>${no2(g.next_phase.sequence)} ${g.next_phase.name}</b>${s.gate_met ? ' · 남은 권장·선택 업무를 정리하거나 건너뛰면 진행할 수 있습니다.' : ' · 필수 업무를 마치면 진행할 수 있습니다.'}`) : '마지막 단계입니다.')}</span>
      ${raw(!archived && g.next_phase && !movePrimary ? html`<button type="button" class="${allDone ? 'btn btn--primary btn--sm' : 'link linkbtn np__move'}" id="next">${josa(g.next_phase.name, '으로')} 진행 →</button>` : '')}
    </div>
  </section>`;
};


/* ======================================================================================================================
 * Desktop 지금 할 일 (Redesign R2 — hive research/relai-redesign-spec.md §5.2). The phone keeps the view above untouched.
 *   stepper → 4 count tiles → one next-step card (the page's only blue button) → 필수 업무 (one visible action per row;
 *   권장·선택 collapsed with a count) beside 다가오는 일정 + 최근 활동. 되돌리기 / 건너뛰기 / 열기 (for manual rows) sit in the row ⋯.
 * ==================================================================================================================== */
const nn = (v) => Number(v) || 0;
const tile = (label, value, { href = '', tone = '', sub = '', key = '' } = {}) => {
  const inner = html`<span class="nxt__k">${label}</span><b class="nxt__v ${tone ? `is-${tone}` : ''}">${value}</b>${raw(sub ? html`<small class="nxt__s">${sub}</small>` : '')}`;
  return href ? html`<a class="nxt" href="${href}" data-link data-tile="${key}">${raw(inner)}</a>` : html`<div class="nxt" data-tile="${key}">${raw(inner)}</div>`;
};
/** The phase's own number: 02 요구사항 확정 n/m · 03/04 WBS 진척률 · 05 테스트 통과 · 06 검수 승인 · else this phase's activities done. */
const phaseMetric = (g, pid) => {
  const cur = g.current_phase; const u = (s) => `/app/projects/${pid}${s}`;
  const r = g.requirements || {}; const w = g.wbs || {}; const t = g.tests || {}; const a = g.acceptances || {};
  switch (cur && cur.phase_key) {
    case 'REQUIREMENTS': return tile('요구사항 확정', nn(r.in_scope) ? `${nn(r.in_scope_confirmed)} / ${nn(r.in_scope)}` : `${nn(r.confirmed)} / ${nn(r.total)}`, { href: u('/requirements'), key: 'metric', sub: nn(r.in_scope) ? '범위 내' : '' });   // v1 P2-2: same in-scope count as the activity row
    case 'ANALYSIS_DESIGN': case 'DEVELOPMENT': return tile('WBS 진척률', nn(w.tasks) ? `${nn(w.progress)}%` : '작업 없음', { href: u('/wbs'), key: 'metric', sub: nn(w.tasks) ? `작업 ${nn(w.tasks)}건` : '' });
    case 'TESTING': return tile('테스트 통과', `${nn(t.last_pass)} / ${nn(t.total)}`, { href: u('/tests'), key: 'metric' });
    case 'TRANSITION_GO_LIVE': return tile('검수 승인', `${nn(a.accepted)} / ${nn(a.total)}`, { href: u('/tests?tab=acceptance'), key: 'metric' });
    default: { const s = (cur && cur.steps) || []; return tile(`${cur ? cur.name : '단계'} 업무`, `${s.filter((x) => x.state === 'COMPLETED' || x.state === 'SKIPPED').length} / ${s.length}`, { key: 'metric' }); }
  }
};
const countTiles = (g, pid) => {
  const cur = g.current_phase; const s = (cur && cur.summary) || { required_open: 0 }; const w = g.wbs || {}; const is = g.issues || {};
  return html`<div class="nxtiles" data-tiles>
    ${raw(tile('필수 업무 남음', nn(s.required_open), { key: 'required', tone: nn(s.required_open) ? '' : 'good' }))}
    ${raw(phaseMetric(g, pid))}
    ${raw(tile('지연 작업', nn(w.overdue_tasks), { href: `/app/projects/${pid}/wbs?f=overdue`, tone: nn(w.overdue_tasks) ? 'crit' : '', key: 'overdue' }))}
    ${raw(tile('열린 이슈', nn(is.active), { href: `/app/projects/${pid}/issues`, key: 'issues' }))}
  </div>`;
};

/** Desktop next-step card: label · title · why (+ warnings as links) · one blue button. */
const dGuideCard = (g, p, archived, created) => {
  const q = g.guidance; if (!q) return '';
  const nx = g.next_phase; const movePrimary = isMove(q.primary_action);
  const primary = archived ? '' : movePrimary ? html`<button type="button" class="btn btn--primary" data-move-next>${nx ? `${no2(nx.sequence)} ${nx.name} 단계 시작 →` : q.primary_action.label}</button>` : ctaLink(q.primary_action, 'btn btn--primary');
  const secondary = archived || movePrimary || !q.secondary_action || isMove(q.secondary_action) ? '' : ctaLink(q.secondary_action, 'link rg__sec');
  return html`<section class="rg nxg" aria-labelledby="rgT" data-tour-id="guidance" data-next-card>
    <div class="nxg__m">
      <span class="nxg__k">${created ? '프로젝트가 생성되었습니다 · 지금 할 일' : '지금 할 일'}</span>
      <h2 class="rg__title nxg__t" id="rgT">${q.title}</h2>
      <p class="rg__d nxg__d">${q.description || ''}</p>
      ${raw(q.warnings && q.warnings.length ? html`<p class="nxg__w">${raw(q.warnings.map((w) => { const href = q.warning_links && q.warning_links[w];
        return html`<span class="rg__warn"><i class="st st--warn" aria-hidden="true">!</i>${raw(href && !archived ? html`<a href="${href}" data-link data-warn-link>${w}</a>` : html`${w}`)}</span>`; }).join(''))}</p>` : '')}
    </div>
    ${raw(primary || secondary ? html`<div class="rg__cta nxg__cta">${raw(secondary)}${raw(primary)}</div>` : '')}
  </section>`;
};

/** One row, one visible action: manual → ✓ 완료 처리 · data → 열기 (or its own verb: 가져오기 / 주간보고 만들기) · done → ✓ 완료 (text).
 * The rest (되돌리기 · 업무 다시 시작 · 건너뛰기 · 열기 of a manual row) goes into the row ⋯. */
const dActivityRow = (a, archived, isCurrent, browse = false, markable = false, pid = '') => {
  const cls = stateCls(a); const done = a.state === 'COMPLETED'; const skipped = a.state === 'SKIPPED' || a.status === 'SKIPPED';
  const manualDone = a.status === 'COMPLETED';
  let href = !archived && a.cta && !done && !skipped && (browse || markable || isCurrent || a.state === 'IN_PROGRESS') ? a.cta.href : null;
  if (href && a.step_key === 'ASSIGN' && !/select=owner/.test(href)) href += `${href.includes('?') ? '&' : '?'}select=owner`;   // Jim M3: 일정 opens with checkboxes + the owner bar
  let main = ''; const more = [];
  const mi = (inner) => html`<li role="none">${raw(inner)}</li>`;
  if (!archived) {
    if (skipped) more.push(mi(html`<button type="button" role="menuitem" class="np__act" data-step="${a.id}" data-status="TODO">업무 다시 시작</button>`));
    else if (done) { if (manualDone && (isCurrent || markable)) more.push(mi(html`<button type="button" role="menuitem" class="np__act" data-step="${a.id}" data-status="TODO">되돌리기</button>`)); }
    else {
      if (a.manual && (isCurrent || markable)) {
        const open = a.checklist && a.checklist.total ? a.checklist.total - a.checklist.done : 0;
        main = a.go_live ? html`<button type="button" class="btn btn--secondary btn--xs np__done" data-golive title="오픈일과 남은 항목(처리 / 운영 이관)을 정하고 오픈을 기록합니다">✓ 완료 처리</button>`
          : a.handover ? html`<button type="button" class="btn btn--secondary btn--xs np__done" data-handover title="인수자·인수일과 운영 이관 항목의 운영 담당을 기록합니다">✓ 완료 처리</button>`
          : a.close ? html`<button type="button" class="btn btn--secondary btn--xs np__done" data-close-manual="${a.id}" title="완료보고서를 RELAI 밖에서 작성했다면 사유를 남기고 완료합니다">✓ 완료 처리</button>`
          : html`<button type="button" class="btn btn--secondary btn--xs np__done" data-step="${a.id}" data-status="COMPLETED" data-title="${a.title}" data-open="${open}" title="이 업무를 완료한 것으로 기록합니다">✓ 완료 처리</button>`;
        if (href) more.push(mi(html`<a role="menuitem" href="${href}" data-link>${/checklist/.test(href) ? '체크리스트 열기' : '열기'}</a>`));
      } else if (a.import_ms && markable) {
        main = html`<button type="button" class="btn btn--secondary btn--xs" data-import-ms>가져오기</button>`;
        if (href) more.push(mi(html`<a role="menuitem" href="${href}" data-link>열기</a>`));
      } else if (href) main = html`<a class="btn btn--secondary btn--xs np__open" href="${href}" data-link data-row-open="${a.step_key}" ${raw(a.row_action ? `data-row-cta="${a.step_key}"` : '')} title="${a.cta.label.replace(/\s*→$/, '')}">${a.row_action ? a.cta.label.replace(/\s*→$/, '') : '열기'}</a>`;
      if (a.importance !== 'REQUIRED' && a.linked_feature_type !== 'definition' && (isCurrent || markable || a.state === 'IN_PROGRESS')) more.push(mi(html`<button type="button" role="menuitem" class="np__act" data-step="${a.id}" data-status="SKIPPED" data-title="${a.title}">건너뛰기</button>`));
    }
  }
  const wait = !archived && !done && !skipped && !main;   // no action yet: an earlier row comes first — the row says why (e.g. 먼저 요구사항을 등록하세요.)
  const tail = done ? '<span class="np__ok" data-row-done>✓ 완료</span>' : skipped ? '<span class="np__skipped">건너뜀</span>'
    : a.state === 'IN_PROGRESS' ? html`<span class="badge badge--st is-${cls}">${cls === 'crit' ? '확인 필요' : '진행 중'}</span>` : '';
  const menu = more.length ? html`<span class="np__morew"><button type="button" class="np__more" data-rowmore aria-haspopup="menu" aria-expanded="false" aria-label="${a.title} 더보기" title="더보기">⋯</button><ul class="np__menu" role="menu" hidden>${raw(more.join(''))}</ul></span>` : '';
  return html`<li class="np__row nxr is-${cls} ${isCurrent ? 'is-cur' : ''} ${href ? 'is-link' : ''}" ${raw(wait ? 'data-wait' : '')} data-act="${a.id}" data-step-key="${a.step_key}" data-imp="${a.importance}" ${raw(href ? html`data-href="${href}"` : '')}>
    <div class="np__m">
      <span class="np__st">${raw(a.importance !== 'REQUIRED' ? html`<span class="badge badge--imp badge--muted">${a.importance_label}</span>` : '')}${a.title}</span>
      <span class="np__purpose">${a.description}</span>
      ${raw(a.text && ((GATE_KEYS.has(a.step_key) && a.state !== 'NOT_STARTED') || a.row_text || a.state === 'IN_PROGRESS' || wait) ? html`<span class="np__sum ${a.crit ? 'is-crit' : ''}" data-row-text>${a.text}</span>` : '')}
      ${raw(a.hint ? html`<span class="np__hint">${a.hint}</span>` : '')}
      ${raw(a.reopen_note ? html`<span class="np__hint np__reopen" data-reopen-note>${a.reopen_note}</span>` : '')}
      ${raw(a.links && !archived ? html`<span class="np__links" data-row-links>${raw(a.links.map((l) => html`<a class="link" href="${l.href}" data-link>${l.label}</a>`).join(''))}</span>` : '')}
      ${raw(a.import_ms && !archived ? html`<span class="np__imp">${a.import_ms.text}</span>` : '')}
    </div>
    <span class="np__tail">${raw(tail)}</span>
    <span class="np__acts">${raw(main)}${raw(menu)}</span>
  </li>`;
};
/** 필수 rows in the list; 권장·선택 folded under "권장·선택 업무 N개 보기". */
const splitRows = (acts, row) => {
  const req = acts.filter((a) => a.importance === 'REQUIRED'); const opt = acts.filter((a) => a.importance !== 'REQUIRED');
  return html`<ol class="np__list nx__req">${raw(req.map(row).join('') || '<li class="np__none">이 단계에는 필수 업무가 없습니다.</li>')}</ol>
    ${raw(opt.length ? html`<details class="nx__opt" data-opt><summary>권장·선택 업무 <b>${opt.length}</b>개 보기</summary><ol class="np__list">${raw(opt.map(row).join(''))}</ol></details>` : '')}`;
};
const dPhasePanel = (g, p, archived) => {
  const cur = g.current_phase; if (!cur) return '';
  const acts = cur.steps || []; const s = cur.summary || { required_open: 0, gate_met: true };
  const movePrimary = isMove(g.guidance && g.guidance.primary_action);
  const current = acts.find((a) => a.state !== 'COMPLETED' && a.state !== 'SKIPPED'); const allDone = !current;
  const req = acts.filter((a) => a.importance === 'REQUIRED'); const reqDone = req.filter((a) => a.state === 'COMPLETED' || a.state === 'SKIPPED').length;
  return html`<section class="np nxp" aria-labelledby="npT">
    <div class="np__h"><div class="np__t"><h2 id="npT">${no2(cur.sequence)} ${cur.name} — 필수 업무</h2></div><span class="np__remain ${s.required_open ? '' : 'is-good'}" data-req-count>${reqDone} / ${req.length} 완료</span></div>
    <p class="np__d">${cur.description}</p>
    ${raw(splitRows(acts, (a) => dActivityRow(a, archived, current && a.id === current.id, false, true, p.id)))}
    <div class="np__f ${allDone && g.next_phase ? 'np__f--ready' : ''}">
      <span class="np__msg">${raw(g.next_phase ? (allDone ? html`<b>${cur.name} 단계의 필요한 업무가 정리되었습니다.</b> 다음 단계 · ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : html`다음 단계: <b>${no2(g.next_phase.sequence)} ${g.next_phase.name}</b>${s.gate_met ? ' · 남은 권장·선택 업무를 정리하거나 건너뛰면 진행할 수 있습니다.' : ' · 필수 업무를 마치면 진행할 수 있습니다.'}`) : '마지막 단계입니다.')}</span>
      ${raw(!archived && g.next_phase && !movePrimary ? html`<button type="button" class="${allDone ? 'btn btn--secondary btn--sm' : 'link linkbtn np__move'}" id="next">${josa(g.next_phase.name, '으로')} 진행 →</button>` : '')}
    </div>
  </section>`;
};
const dOtherPhasePanel = (g, ph, archived) => {
  const acts = ph.steps || []; const s = ph.summary || { required_open: 0 }; const cur = g.current_phase;
  const st = phaseState(ph); const passed = st === 'done' || st === 'gap';
  const tag = st === 'done' ? (ph.status === 'COMPLETED' ? '<span class="np__tag is-done">✓ 완료</span>' : '<span class="np__tag is-done">✓ 다음 단계로 진행됨</span>') : st === 'gap' ? '<span class="np__tag is-gap">다음 단계로 진행됨 · 필수 업무 남음</span>' : '<span class="np__tag">예정</span>';
  const remain = passed ? (s.required_open ? `남은 필수 업무 ${s.required_open}건 — 필요하면 지금도 처리할 수 있습니다` : '이 단계의 필수 업무를 모두 마쳤습니다') : `필수 업무 ${s.required_open || 0}건`;
  return html`<section class="np nxp np--other" aria-labelledby="npT">
    <div class="np__h"><div class="np__t"><h2 id="npT">${no2(ph.sequence)} ${ph.name} — 필수 업무</h2>${raw(tag)}</div><span class="np__remain ${passed && !s.required_open ? 'is-good' : ''}">${remain}</span></div>
    <p class="np__d">${ph.description}</p>
    ${raw(ph.phase_key === 'INITIATION' || ph.phase_key === 'REQUIREMENTS' || ph.phase_key === 'TESTING' ? noApprovalLine(g, ph.phase_key) : '')}
    ${raw(splitRows(acts, (a) => dActivityRow(a, archived, false, true, passed, g.project.id)))}
    <div class="np__f"><span class="np__msg">${raw(cur ? html`현재 단계는 <b>${no2(cur.sequence)} ${cur.name}</b>입니다.` : '')}</span>
      <a class="link np__back" href="/app/projects/${g.project.id}" data-link>현재 단계 업무 보기 →</a></div>
  </section>`;
};
const dday = (date) => { const d = daysUntil(date); return d === null ? '' : d < 0 ? `${-d}일 지남` : d === 0 ? '오늘' : `D-${d}`; };
const ddTone = (date) => { const d = daysUntil(date); return d !== null && d <= 1 ? 'is-crit' : ''; };
/** Right column: 다가오는 일정 (D-day; red only when overdue or ≤ 1 day) + 최근 활동 (→ 보고서 › 활동 기록). Filled after the first paint. */
const sideCol = (closed = false) => html`<aside class="nxside" aria-label="일정과 활동">
  ${raw(closed ? '' : html`<section class="nxbox" aria-labelledby="nxUpT" data-upcoming><div class="nxbox__h"><h2 id="nxUpT">다가오는 일정</h2></div><div class="nxbox__b" id="nx-up"><p class="nxbox__none">불러오는 중…</p></div></section>`)}
  <section class="nxbox" aria-labelledby="nxAcT"><div class="nxbox__h"><h2 id="nxAcT">최근 활동</h2><button type="button" class="link linkbtn nxbox__more" data-stab-action="activity">전체 보기</button></div><div class="nxbox__b" id="nx-act"><p class="nxbox__none">불러오는 중…</p></div></section>
</aside>`;
export const upcomingList = (items, pid) => (items.length ? html`<ol class="nxup">${raw(items.map((x) => html`<li><a href="/app/projects/${x.pid || pid}/${x.href}" data-link><span class="nxup__t">${x.title}<small>${x.sub || x.label || ''}</small></span><b class="nxup__d ${ddTone(x.date)}" title="${x.date}">${dday(x.date)}</b></a></li>`).join(''))}</ol>` : '<p class="nxbox__none">다가오는 일정이 없습니다.</p>');
export const activityList = (items, pid) => (items.length ? html`<ol class="nxact">${raw(items.map((e) => html`<li><a href="/app/projects/${e.pid || pid}/${e.href}" data-link><span class="nxact__t">${raw(e.display_id ? html`<span class="mono">${e.display_id}</span> ` : '')}${e.title || ''}${e.summary ? ` · ${e.summary}` : ''}</span><small>${[e.actor_name, e.project, relTime(e.at)].filter(Boolean).join(' · ')}</small></a></li>`).join(''))}</ol>` : '<p class="nxbox__none">아직 기록된 활동이 없습니다.</p>');
const fillSide = async (main, id) => {
  const [up, act] = await Promise.all([(main.querySelector('#nx-up') ? api('GET', wsApi(`/${id}/upcoming?days=30`)) : Promise.resolve({ items: [] })).catch(() => ({ items: [] })), api('GET', wsApi(`/${id}/activity?limit=5`)).catch(() => ({ items: [] }))]);
  const a = main.querySelector('#nx-up'); if (a) a.innerHTML = upcomingList((up.items || []).slice(0, 5), id);
  const b = main.querySelector('#nx-act'); if (b) b.innerHTML = activityList((act.items || []).slice(0, 5), id);
};
/** Row ⋯ menus: Enter/Space opens, focus moves in, Esc closes; one open at a time. */
if (typeof document !== 'undefined' && document.body && !document.body.dataset.nxMoreBound) {
  document.body.dataset.nxMoreBound = '1';
  const closeAll = () => document.querySelectorAll('.np__menu').forEach((m) => { m.hidden = true; const b = m.previousElementSibling; if (b) b.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rowmore]');
    if (b) { e.stopPropagation(); const m = b.nextElementSibling; const open = m.hidden; closeAll(); m.hidden = !open; b.setAttribute('aria-expanded', String(open)); if (open) { const f = m.querySelector('a,button'); if (f) f.focus(); } return; }
    if (!e.target.closest('.np__menu')) closeAll(); else if (e.target.closest('a,button')) setTimeout(closeAll, 0);
  }, true);
  closeOnOutsideTap((t) => t.closest && t.closest('.np__menu, [data-rowmore]'), () => { if (document.querySelector('.np__menu:not([hidden])')) closeAll(); }, '.np__menu:not([hidden])');
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('.np__menu:not([hidden])')) { const m = document.querySelector('.np__menu:not([hidden])'); closeAll(); const b = m.previousElementSibling; if (b) b.focus(); } });
}

export async function nextPage(id, main = $('#main')) {
  // BUG-001: strip ?created=1 / ?move=next right away (not after the awaits), so a navigation made meanwhile is never overwritten.
  { const qp0 = new URLSearchParams(location.search); nextPage._flag = qp0.get('created') === '1' ? `created:${id}` : qp0.get('move') === 'next' ? `move:${id}` : qp0.get('golive') === '1' ? `golive:${id}` : qp0.get('carryovers') === '1' ? `carry:${id}` : qp0.get('handover') === '1' ? `handover:${id}` : qp0.get('close') === '1' ? `close:${id}` : null; if (nextPage._flag) history.replaceState(null, '', `/app/projects/${id}`); }
  let g = await api('GET', wsApi(`/${id}`));
  const p = g.project;
  document.title = `지금 할 일 — ${p.name} — RELAI`;
  const isArch = p.status === 'ARCHIVED'; const archived = isArch || isPhone();   // phone = view mode: the archived read-only path
  const created = nextPage._flag === `created:${id}`; const moveNext = nextPage._flag === `move:${id}`;
  let pendingGoLive = nextPage._flag === `golive:${id}`; let pendingCarry = nextPage._flag === `carry:${id}`;
  let pendingHandover = nextPage._flag === `handover:${id}`; let pendingClose = nextPage._flag === `close:${id}`; nextPage._flag = null;   // Phase 7: 인수 완료 처리 · 프로젝트 종료   // Phase 6: guide CTA '오픈 완료 처리' · 07 '오픈 때 운영으로 넘긴 항목'
  await ob.get();
  let pendingMove = moveNext && !archived;
  const viewKey = new URLSearchParams(location.search).get('phase');   // stepper click on another phase → that phase's activity list
  const draw = async () => {
    const view = viewKey ? (g.phases || []).find((x) => x.phase_key === viewKey && !x.is_current) : null;
    const desk = !isPhone();   // Redesign R2: desktop layout; the phone keeps today's view
    main.innerHTML = html`<div class="page page--wide page--flow page--guide nx ${desk ? 'nx--r2' : ''}">
      ${raw(projectHead(g.project, g, { tab: 'next' }))}
      ${raw(isArch ? '<div class="notice">보관된 프로젝트입니다. 단계와 업무는 조회만 할 수 있습니다.</div>' : pcLine())}
      ${raw(phaseStepper(g, p.id, view ? view.phase_key : null))}
      ${raw(desk ? '' : view ? '' : g.project.status === 'COMPLETED' ? closedPanel(g) : guideCard(g, p, archived, created))}
      ${raw(desk ? '' : view ? otherPhasePanel(g, view, archived) : g.project.status === 'COMPLETED' ? html`<details class="closed__ph"><summary>단계 업무 보기</summary>${raw(phasePanel(g, p, archived))}</details>` : phasePanel(g, p, archived))}
      ${raw(desk ? html`${raw(view || g.project.status === 'COMPLETED' ? '' : countTiles(g, p.id))}
        ${raw(view ? '' : g.project.status === 'COMPLETED' ? closedPanel(g) : dGuideCard(g, p, archived, created))}
        <div class="nxcols"><div class="nxmain">${raw(view ? dOtherPhasePanel(g, view, archived) : g.project.status === 'COMPLETED' ? html`<details class="closed__ph"><summary>단계 업무 보기</summary>${raw(dPhasePanel(g, p, archived))}</details>` : dPhasePanel(g, p, archived))}</div>${raw(sideCol(g.project.status === 'COMPLETED'))}</div>` : '')}
    </div>`;
    if (desk) fillSide(main, id);
    const move = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) { g = await api('GET', wsApi(`/${id}`)); draw(); } };
    const nb = $('#next'); if (nb) nb.onclick = move;
    // 단계 선택: another phase's list → make it the current phase (same dialogs)
    main.querySelectorAll('[data-dl]').forEach((b) => { b.onclick = async () => { try { const { download } = await import('../core/ui.js'); await download(b.dataset.dl); toast(/requirements\/export-doc/.test(b.dataset.dl) ? '요구사항 정의서를 내려받았습니다.' : '사업수행계획서를 내려받았습니다.'); } catch (e) { toast(e.message); } }; });
    bindPlanMenu(main, p.id);
    main.querySelectorAll('[data-move-next]').forEach((b) => { b.onclick = g.next_phase ? move : null; });
    main.querySelectorAll('.np__row[data-href]').forEach((row) => { const go = () => navigate(row.dataset.href); row.onclick = (e) => { if (!e.target.closest('a,button')) go(); }; row.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('a,button')) { e.preventDefault(); go(); } }; });
    main.querySelectorAll('[data-step]').forEach((b) => b.onclick = async () => {
      if (b.dataset.status === 'COMPLETED' && Number(b.dataset.open) > 0 && !(await confirmDialog({ title: '이 업무를 완료 처리할까요?', body: `'${b.dataset.title}' 체크리스트에 완료되지 않은 항목 ${b.dataset.open}건이 남아 있습니다. 그래도 완료로 기록합니다.`, confirm: '완료 처리' }))) return;
      if (b.dataset.status === 'SKIPPED' && !(await confirmDialog({ title: '이 업무를 건너뛸까요?', body: `'${b.dataset.title}'${pickJosa(b.dataset.title, '은')} 이번 프로젝트에서 수행하지 않는 것으로 기록됩니다. 나중에 다시 시작할 수 있습니다.`, confirm: '건너뛰기' }))) return;
      b.disabled = true;
      try { g = await api('PATCH', wsApi(`/${id}/steps/${b.dataset.step}`), { status: b.dataset.status }); toast(b.dataset.status === 'COMPLETED' ? '완료 처리했습니다.' : b.dataset.status === 'SKIPPED' ? '이 업무를 건너뛰었습니다.' : '업무를 다시 시작합니다.'); draw(); }
      catch (e) { toast(e.message); b.disabled = false; }
    });
    // 03 MILESTONES (US-4): 01 주요 일정 → WBS 마일스톤 in one click; the row turns ✓ 완료 on redraw
    main.querySelectorAll('[data-import-ms]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation(); b.disabled = true;
      try { const r = await api('POST', wsApi(`/${id}/wbs/milestones/from-key-dates`), {}); g = await api('GET', wsApi(`/${id}`)); draw(); toast(r.created ? `마일스톤 ${r.created}건을 가져왔습니다.` : '이미 같은 마일스톤이 있습니다.'); }
      catch (err) { toast(err.message); b.disabled = false; }
    });
    // Phase 6 US-3: 오픈 = the 오픈 dialog (오픈일 + 남은 항목 처리 / 운영 이관), never a plain 완료 처리
    const openGoLive = async () => { const r = await goLiveDialog(id); if (r) { g = r; toast(`오픈을 기록했습니다.${r.go_live && r.go_live.carryovers.length ? ` 운영 이관 ${r.go_live.carryovers.length}건` : ''}`); draw(); } };
    main.querySelectorAll('[data-golive]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openGoLive(); }; });
    main.querySelectorAll('.rg__warn a[href$="?carryovers=1"]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); carryoverDialog(g); }; });
    // Phase 7: 운영 인수 dialog (row 완료 처리 · guide CTA · '운영 이관 N건 · 담당 지정' line) → then 종료 when 07 is done
    const askClose = async () => { if (g.project.status !== 'COMPLETED' && closeReady(g)) { const r = await closeDialog(id, g); if (r) { g = r; draw(); } } };
    const openHandover = async () => { const r = await handoverDialog(id); if (!r) return; g = await api('GET', wsApi(`/${id}`)); if (!r.saved_owners) toast(`운영 인수를 기록했습니다.${r.owner_counts && r.owner_counts.tbd ? ` 운영 담당 미정 ${r.owner_counts.tbd}건` : ''}`); draw(); if (!r.saved_owners) askClose(); };
    main.querySelectorAll('[data-handover]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openHandover(); }; });
    main.querySelectorAll('.rg__warn a[href$="?handover=1"]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openHandover(); }; });
    main.querySelectorAll('[data-close-manual]').forEach((b) => { b.onclick = async (e) => { e.stopPropagation(); const r = await closeManual(id, b.dataset.closeManual); if (r) { g = r; draw(); askClose(); } }; });
    const ro = main.querySelector('[data-reopen]'); if (ro) ro.onclick = async () => { const r = await reopenProject(id); if (r) { g = r; draw(); } };
    bindCoach(main);
    if (pendingHandover && !archived) { pendingHandover = false; openHandover(); }
    if (pendingClose && !archived) { pendingClose = false; const r = await closeDialog(id, g); if (r) { g = r; draw(); } }
    if (pendingGoLive && !archived) { pendingGoLive = false; openGoLive(); }
    if (pendingCarry) { pendingCarry = false; carryoverDialog(g); }
    if (pendingMove && g.next_phase) { pendingMove = false; move(); }
  };
  draw();
}
