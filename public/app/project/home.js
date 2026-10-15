/* Workspace Home — "각 프로젝트가 지금 어디까지 왔고, 내가 다음에 무엇을 해야 하는가?" in one screen.
 * One compact status card per live project (GET …/projects/home, server/home.js). Every card reuses data the project
 * screens already compute: the Next Action is the very same guidance What's Next shows (same title, same CTA href), so the
 * CTA goes straight to the work screen; progress / schedule come from scheduleState() (Overview); attention from attentionAll().
 * Projects / Project Home / What's Next / Overview are untouched — Home only decides what to show first. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, fmtDT, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { STATUS, STATUS_CHIP } from '../shared/constants.js';
import { ob } from '../onboarding/state.js';
import { bindChecklist, checklistCard } from '../onboarding/ui.js';
import { scheduleState } from './status.js';
import { newWorkspaceHome } from './list.js';
import { isPhone, pcLine } from '../core/device.js';
import { LIFECYCLE_PHASES } from '../shared/lifecycle.js';
import { pickJosa } from '../shared/josa.js';
import { upcomingList, activityList } from './next.js';

/** Default workspace names were created as '홍길동님의 Workspace' — shown in Korean on Home (L-C6; the stored name is the user's and stays). */
const wsName = (v) => String(v || '').replace(/ Workspace$/, ' 워크스페이스');
const canManage = () => state.workspace && state.workspace.role !== 'MEMBER';
const n = (v) => Number(v) || 0;
const ATT_TYPE = { ISSUE: '이슈', RISK: '리스크', TEST: '테스트', CHANGE: '변경', WBS: 'WBS', ACCEPTANCE: '검수', REQUIREMENT: '요구사항' };
const UNLINKED = 'CONFIRMED_UNLINKED_REQUIREMENT';
/** Calm by default (design §1.2): red only for real blockers — an overdue task/milestone or a critical exception (blocked issue, failed test).
 * "Not done yet" (e.g. 03 with WBS 미연결) is the next step, not an alert. */
const isAlert = (c) => Boolean(n(c.wbs && c.wbs.overdue_tasks) || n(c.wbs && c.wbs.overdue_milestones) || n(c.attention && c.attention.crit));

/** Lifecycle bar: one segment per phase — green only when that phase's REQUIRED gate is met (B-1), amber when left with REQUIRED open. */
const lifecycle = (seq, states) => html`<span class="lcpos" aria-label="단계 위치">${raw(Array.from({ length: 7 }, (_, i) => { const st = states && states[i] ? states[i] : i + 1 < seq ? 'done' : i + 1 === seq ? 'cur' : 'todo'; return `<i class="${st === 'todo' ? '' : `is-${st}`}"></i>`; }).join(''))}</span>`;
const isMove = (a) => Boolean(a && /\?move=next$/.test(a.href));

/* ---------- 다음 할 일: the What's Next CTA, verbatim. ?move=next (phase transition) keeps its confirm dialog in Project Home. ---------- */
const nextBlock = (c, first = false) => {
  const g = c.guidance; const u = `/app/projects/${c.id}`;
  const bc = first ? 'btn--primary' : 'btn--soft';   // one primary per screen (design §1.1): the top card's next step; the others are soft
  if (!g) return '';
  if (c.status === 'ON_HOLD' || c.status === 'DRAFT') {
    return html`<div class="hc__next hc__next--quiet"><span class="hc__k">상태</span><p class="hc__t">${c.status === 'ON_HOLD' ? '보류 중입니다.' : '초안 상태입니다. 프로젝트 정보를 확정하면 안내가 시작됩니다.'}</p>
      <a class="link hc__go" href="${u}" data-link>${c.status === 'ON_HOLD' ? '프로젝트 열기 →' : '지금 할 일 보기 →'}</a></div>`;
  }
  if (g.kind === 'MONITOR') {
    const nd = c.next_date;
    return html`<div class="hc__next hc__next--quiet"><span class="hc__k">상태</span>
      <p class="hc__t">정상 진행 중${raw(nd ? html` · 다음 확인 <b>${fmtShort(nd.date)} ${nd.title}</b>` : '')}</p>
      ${raw(g.primary_action ? html`<a class="link hc__go" href="${g.primary_action.href}" data-link>${g.primary_action.label}</a>` : '')}</div>`;
  }
  const pa = g.primary_action;
  // phone = view mode: the next step is text, not a button (`다음: 02 요구사항 정의 시작`)
  if (isPhone()) return html`<div class="hc__next"><span class="hc__k">다음 할 일</span><p class="hc__t">${pa && isMove(pa) && c.next_phase ? `다음: ${no2(c.next_phase.sequence)} ${c.next_phase.name} 시작` : g.title}</p></div>`;
  const cta = !pa ? '' : isMove(pa)
    ? html`<a class="btn ${bc} btn--sm" href="${u}?move=next" data-link>${c.next_phase ? `${no2(c.next_phase.sequence)} ${c.next_phase.name} 단계 시작 →` : pa.label}</a>`
    : html`<a class="btn ${bc} btn--sm" href="${pa.href}" data-link>${pa.label}</a>`;
  return html`<div class="hc__next"><span class="hc__k">다음 할 일</span><p class="hc__t">${g.title}</p>${raw(cta)}</div>`;
};

/* ---------- bottom strip: 진행률 · 일정 · 확인 필요 (one line, Overview numbers) ---------- */
const stripBlock = (c) => {
  const w = c.wbs || {}; const sch = scheduleState(w); const a = c.attention || { total: 0, crit: 0, items: [] };
  const prog = n(w.tasks) ? `${n(w.progress)}%` : null;   // no tasks yet → no 진행률 slot at all (a '-' next to '·' read as a doubled separator, L-C6)
  const overdue = n(w.overdue_tasks) || n(w.overdue_milestones);
  const tone = sch.tone === 'crit' && !overdue ? 'warn' : sch.tone;   // red only when something is actually overdue
  const other = n(a.total) - n(a.unlinked);
  const att = other ? html`<a class="hc__att is-${a.crit ? 'crit' : 'warn'}" href="/app/projects/${c.id}/overview#att" data-link>확인 필요 ${other}건</a>` : '';
  return html`<div class="hc__strip">
    ${raw(prog ? html`<span class="hc__m"><small>진행률</small><b>${prog}</b></span><i class="hc__sep">·</i>` : '')}
    <span class="hc__m"><small>일정</small><b class="is-${tone}">${sch.label === '-' ? '정상' : sch.label}</b></span>
    ${raw(att)}
  </div>`;
};
const attentionList = (c) => {
  const a = c.attention; const items = ((a && a.items) || []).filter((i) => i.kind !== UNLINKED);
  if (!items.length) return '';
  return html`<ul class="hc__attl">${raw(items.map((i) => html`<li><a href="/app/projects/${c.id}/${i.href}" data-link title="${i.meta}"><i class="att__dot ${i.severity === 'crit' ? 'is-crit' : ''}" aria-hidden="true"></i><span class="hc__attk">${ATT_TYPE[i.type] || i.type}</span>${raw(i.display_id ? html`<span class="mono">${i.display_id}</span>` : '')}<span class="hc__attt">${i.title}</span></a></li>`).join(''))}${raw(a.total > a.items.length ? html`<li class="hc__attmore"><a class="link" href="/app/projects/${c.id}/overview#att" data-link>외 ${a.total - a.items.length}건 →</a></li>` : '')}</ul>`;
};
const upcomingLine = (c) => {
  const up = c.upcoming || [];
  return html`<div class="hc__up"><span class="hc__k">주요 일정</span>${raw(up.length
    ? up.map((u) => html`<a class="hc__ms" href="/app/projects/${c.id}/${u.href}" data-link><time>${fmtShort(u.date)}</time>${u.title}</a>`).join('<i class="hc__sep">·</i>')
    : '<span class="hc__none">예정된 마일스톤 없음</span>')}</div>`;
};

const card = (c, i) => {
  const alert = isAlert(c);
  return html`<article class="hc ${alert ? 'is-blocker' : ''}" data-pid="${c.id}">
    <header class="hc__h">
      ${raw(alert ? '<span class="hc__prio" title="지연되었거나 막힌 항목이 있습니다">막힘</span>' : '')}
      <a class="hc__name" href="/app/projects/${c.id}" data-link title="${c.name}">${c.name}</a>
      <span class="hc__client">${c.client_name || ''}</span>
      <span class="chip ${STATUS_CHIP[c.status] || ''}">${STATUS[c.status]}</span>
    </header>
    <div class="hc__phase"><span class="hc__k">현재 단계</span><b>${no2(c.current_phase_sequence)} ${c.current_phase_name}</b>${raw(lifecycle(c.current_phase_sequence, c.phase_states))}${raw(c.soon && c.next_date ? html`<span class="hc__soon" title="${c.next_date.label}">D-${c.next_date_days} ${c.next_date.title}</span>` : '')}</div>
    ${raw(nextBlock(c, i === 0))}
    ${raw(stripBlock(c))}
    ${raw(attentionList(c))}
    ${raw(upcomingLine(c))}
  </article>`;
};

/** Phase 7 US-2: 완료된 프로젝트 card = 이름 · 완료일 · 완료보고서 (no progress, no 다음 할 일). */
const completedRow = (p) => html`<div class="hc__done" data-done-pid="${p.id}"><a class="hc__done-n" href="/app/projects/${p.id}" data-link>${p.name}</a><span class="hc__client">${p.client_name || ''}</span><span class="chip chip--done">✓ 완료${p.closed_on ? ` · ${fmtShort(String(p.closed_on).slice(0, 10))}` : ''}</span>${raw(p.completion_report_id ? html`<a class="link hc__done-r" href="/app/projects/${p.id}/reports/${p.completion_report_id}" data-link>완료보고서</a>` : '<span></span>')}</div>`;

const summaryLine = (live) => {
  const k = live.filter(isAlert).length;
  return k ? html`<span class="hgrid__sum"><span class="hc__cnt is-blocker"><i></i>막힘 ${k}</span></span>` : '';
};


/* ======================================================================================================================
 * Desktop Home dashboard (Redesign R2 — hive research/relai-redesign-spec.md §5.1). Phone keeps the cards above.
 *   one summary sentence → one card per live project (mini stepper + next step + one button; only the first is blue)
 *   beside 다가오는 일정 + 최근 활동. Red / 막힘 only when work is actually overdue; "not done yet" is the next step, never an alert.
 * ==================================================================================================================== */
const isOverdue = (c) => Boolean(n(c.wbs && c.wbs.overdue_tasks) || n(c.wbs && c.wbs.overdue_milestones));
const hasTodo = (c) => Boolean(c.guidance && c.guidance.kind !== 'MONITOR' && c.status !== 'ON_HOLD' && c.status !== 'DRAFT' && c.guidance.primary_action);
const todoText = (c) => (isMove(c.guidance.primary_action) && c.next_phase ? `${c.next_phase.name} 단계를 시작할 차례입니다` : `'${c.guidance.title}'`);
/** "오늘 할 일 2건이 있습니다. 한빛 챗봇은 '요구사항 2건을 확정하세요', 사내 포털은 …" — rule-based, from the same next-step data. */
export const homeSummary = (live) => {
  const todo = live.filter(hasTodo); const late = live.filter(isOverdue);
  if (!todo.length) return html`<b>오늘 처리할 다음 단계가 없습니다.</b> 진행 중인 프로젝트 ${live.length}개가 모두 정상 진행 중입니다.`;
  const parts = todo.slice(0, 2).map((c) => html`${c.name}${pickJosa(c.name, '은')} ${todoText(c)}`);
  return html`<b>오늘 할 일 ${todo.length}건</b>이 있습니다. ${raw(parts.join(', '))}${todo.length > 2 ? ` 외 ${todo.length - 2}개 프로젝트에도 다음 단계가 있습니다` : ''}.${late.length ? ` 지연된 작업이 있는 프로젝트 ${late.length}개는 일정을 먼저 확인하세요.` : ''}`;
};
const miniStepper = (c) => { const states = c.phase_states || []; return html`<ol class="hmini" aria-label="단계">${raw(LIFECYCLE_PHASES.map((ph, i) => { const st = states[i] || (i + 1 < c.current_phase_sequence ? 'done' : i + 1 === c.current_phase_sequence ? 'cur' : 'todo');
  return html`<li class="is-${st === 'quiet' ? 'done' : st}" title="${no2(i + 1)} ${ph.long}">${st === 'done' || st === 'quiet' ? '✓ ' : ''}${ph.short}</li>`; }).join(''))}</ol>`; };
const dNext = (c, first) => {
  const g = c.guidance; const u = `/app/projects/${c.id}`; if (!g) return '';
  const bc = first ? 'btn--primary' : 'btn--secondary';   // one blue button on the page: the top card's next step
  if (c.status === 'ON_HOLD' || c.status === 'DRAFT') return html`<div class="hnx hnx--quiet"><div><span class="hnx__k">상태</span><p class="hnx__t">${c.status === 'ON_HOLD' ? '보류 중입니다.' : '초안 상태입니다. 프로젝트 정보를 확정하면 안내가 시작됩니다.'}</p></div><a class="btn btn--secondary btn--sm" href="${u}" data-link>${c.status === 'ON_HOLD' ? '프로젝트 열기' : '지금 할 일 보기'}</a></div>`;
  if (g.kind === 'MONITOR') { const nd = c.next_date; return html`<div class="hnx hnx--quiet"><div><span class="hnx__k">상태</span><p class="hnx__t">정상 진행 중${raw(nd ? html` · 다음 확인 <b>${fmtShort(nd.date)} ${nd.title}</b>` : '')}</p></div>${raw(g.primary_action ? html`<a class="btn btn--secondary btn--sm" href="${g.primary_action.href}" data-link>${g.primary_action.label}</a>` : '')}</div>`; }
  const pa = g.primary_action;
  const cta = !pa ? '' : isMove(pa) ? html`<a class="btn ${bc} btn--sm" href="${u}?move=next" data-link data-home-cta>${c.next_phase ? `${no2(c.next_phase.sequence)} ${c.next_phase.name} 단계 시작 →` : pa.label}</a>`
    : html`<a class="btn ${bc} btn--sm" href="${pa.href}" data-link data-home-cta>${pa.label}</a>`;
  return html`<div class="hnx"><div><span class="hnx__k">다음 할 일</span><p class="hnx__t">${g.title}</p>${raw(g.description ? html`<p class="hnx__d">${g.description}</p>` : '')}</div>${raw(cta)}</div>`;
};
const dCard = (c, i) => {
  const late = isOverdue(c); const w = c.wbs || {};
  return html`<article class="hc hc--r2 ${late ? 'is-blocker' : ''}" data-pid="${c.id}">
    <header class="hc__h">
      <a class="hc__name" href="/app/projects/${c.id}" data-link title="${c.name}">${c.name}</a><span class="hc__client">${c.client_name || ''}</span>
      ${raw(late ? '<span class="hc__prio" title="계획 종료일이 지난 작업이나 마일스톤이 있습니다" data-overdue>지연</span>' : '')}
      ${raw(c.status !== 'ACTIVE' ? html`<span class="chip ${STATUS_CHIP[c.status] || ''}">${STATUS[c.status]}</span>` : '')}
      <span class="hc__pos">${no2(c.current_phase_sequence)} 단계 / 07</span>
    </header>
    ${raw(miniStepper(c))}
    ${raw(dNext(c, i === 0))}
    ${raw(n(w.tasks) || late ? html`<p class="hc__foot">${raw(n(w.tasks) ? html`진행률 <b>${n(w.progress)}%</b>` : '')}${raw(late ? html`${n(w.tasks) ? ' · ' : ''}<a class="link is-crit" href="/app/projects/${c.id}/wbs?f=overdue" data-link>지연 작업 ${n(w.overdue_tasks)}건${n(w.overdue_milestones) ? ` · 지난 마일스톤 ${n(w.overdue_milestones)}건` : ''}</a>` : '')}</p>` : '')}
  </article>`;
};
const homeSide = (live) => {
  const up = live.flatMap((c) => (c.upcoming || []).map((u) => ({ ...u, pid: c.id, sub: u.title === c.name ? u.label : `${c.name} · ${u.label}` }))).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 6);
  const act = live.flatMap((c) => (c.recent || []).map((e) => ({ ...e, pid: c.id, project: live.length > 1 ? c.name : '' }))).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
  return html`<aside class="nxside" aria-label="일정과 활동">
    <section class="nxbox" aria-labelledby="hUpT" data-home-upcoming><div class="nxbox__h"><h2 id="hUpT">다가오는 일정</h2></div><div class="nxbox__b">${raw(upcomingList(up, ''))}</div></section>
    <section class="nxbox" aria-labelledby="hAcT" data-home-activity><div class="nxbox__h"><h2 id="hAcT">최근 활동</h2></div><div class="nxbox__b">${raw(activityList(act, ''))}</div></section>
  </aside>`;
};

/* Phone dashboard (mobile-v2): three numbers on top, the cards, then 다가오는 일정 across projects. Same data as desktop. */
const phoneTiles = (live) => {
  const todo = live.filter(hasTodo).length; const late = live.filter(isOverdue).length;
  const att = live.reduce((k, c) => k + Math.max(0, n(c.attention && c.attention.total) - n(c.attention && c.attention.unlinked)), 0);
  const tile = (label, v, tone = '') => html`<div class="mtile ${tone}"><small>${label}</small><b>${v}</b></div>`;
  return html`<div class="mtiles" data-home-tiles>${raw(tile('진행 중', `${live.length}개`))}${raw(tile('다음 할 일', `${todo}건`, todo ? 'is-now' : ''))}${raw(late ? tile('지연', `${late}개`, 'is-crit') : tile('확인 필요', `${att}건`, att ? 'is-warn' : ''))}</div>`;
};
const phoneUpcoming = (live) => {
  const up = live.flatMap((c) => (c.upcoming || []).map((u) => ({ ...u, pid: c.id, sub: u.title === c.name ? u.label : `${c.name} · ${u.label}` }))).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 4);
  return up.length ? html`<section class="nxbox mup" aria-labelledby="hUpM" data-home-upcoming><div class="nxbox__h"><h2 id="hUpM">다가오는 일정</h2></div><div class="nxbox__b">${raw(upcomingList(up, ''))}</div></section>` : '';
};

export async function homePage(main = $('#main')) {
  document.title = '홈 — RELAI';
  const [h, o] = await Promise.all([api('GET', wsApi('/home')), ob.get()]);
  const live = h.projects || []; const done = h.completed || [];
  const any = live.length || done.length;
  const desk = !isPhone();   // Redesign R2 dashboard on desktop; the phone keeps today's cards
  main.innerHTML = html`<div class="page page--guide home">
    <div class="page__head"><div><h1>${state.user.name}님, 안녕하세요</h1><p>${raw(desk && live.length ? html`진행 중인 프로젝트 ${live.length}개 · ` : '')}${wsName(state.workspace.name)}<span id="home-credits"></span></p>${raw(any ? pcLine() : '')}</div>
      ${raw(any && canManage() && !isPhone() ? `<a class="btn ${live.length ? 'btn--secondary' : 'btn--primary'}" href="/app/projects/new" data-link data-tour-id="create-project">+ 새 프로젝트</a>` : '')}</div>
    ${raw(any && !isPhone() ? checklistCard(o, { compact: true }) : '')}
    ${raw(live.length && !canManage() ? html`<p class="home__member">${wsName(state.workspace.name)} 워크스페이스에 참여 중입니다. 프로젝트를 선택해 진행 상황을 확인하세요. <a class="link" href="/app/projects/${live[0].id}/wbs?owner=${state.user.id}" data-link>내 업무 보기</a></p>` : '')}
    ${raw(live.length && desk ? html`<p class="hsum" data-home-summary>${raw(homeSummary(live))}</p>
        <div class="hdash"><section class="hgrid__sec" aria-labelledby="hgT"><h2 id="hgT" class="sr-only">프로젝트 현황</h2><div class="hgrid">${raw(live.map(dCard).join(''))}</div></section>${raw(homeSide(live))}</div>`
      : live.length ? html`${raw(phoneTiles(live))}<section class="hgrid__sec" aria-labelledby="hgT"><div class="hgrid__h"><h2 id="hgT">프로젝트 현황</h2>${raw(summaryLine(live))}</div>
        <div class="hgrid">${raw(live.map(card).join(''))}</div></section>${raw(phoneUpcoming(live))}`
      : any ? '<div class="empty empty--sm"><h2>진행 중인 프로젝트가 없습니다.</h2><p>완료된 프로젝트는 아래에 있습니다.</p></div>'
      : isPhone() ? html`<div class="empty empty--sm" data-phone-empty><p>프로젝트 만들기는 PC에서 할 수 있습니다. PC에서 ${location.host} 에 로그인하세요.</p></div>` : newWorkspaceHome(o))}
    ${raw(done.length ? html`<details class="hdone"><summary>완료된 프로젝트 <b>${done.length}</b>개</summary><div class="hdone__l">${raw(done.map(completedRow).join(''))}</div></details>` : '')}
  </div>`;
  bindChecklist(main);
  // AI credits at a glance (AI-credits-only billing): balance + early access, linked to 설정 › AI 크레딧. Never blocks Home.
  api('GET', `/api/workspaces/${state.workspace.id}/credits/summary`).then(({ credits: c }) => {
    const el = $('#home-credits', main); if (!el) return;
    el.innerHTML = html` · <a class="link home__credits ${c.low ? 'is-low' : ''}" href="/app/settings/credits" data-link>AI 크레딧 ${c.balance.toLocaleString('ko-KR')} (₩${c.balance_krw.toLocaleString('ko-KR')})${c.purchased_remaining === 0 && c.free_remaining > 0 ? ' 무료 제공' : ''}</a>${raw(c.plan === 'EARLY' && c.early_access_until ? html` · 얼리 액세스 ${fmtDT(c.early_access_until).slice(0, 10)}까지 무료` : '')}`;
  }).catch(() => {});
}
