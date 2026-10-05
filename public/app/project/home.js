/* Workspace Home — "각 프로젝트가 지금 어디까지 왔고, 내가 다음에 무엇을 해야 하는가?" in one screen.
 * One compact status card per live project (GET …/projects/home, server/home.js). Every card reuses data the project
 * screens already compute: the Next Action is the very same guidance What's Next shows (same title, same CTA href), so the
 * CTA goes straight to the work screen; progress / schedule come from scheduleState() (Overview); attention from attentionAll().
 * Projects / Project Home / What's Next / Overview are untouched — Home only decides what to show first. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, no2, raw } from '../core/dom.js';
import { state } from '../core/state.js';
import { STATUS, STATUS_CHIP } from '../shared/constants.js';
import { ob } from '../onboarding/state.js';
import { bindChecklist, checklistCard } from '../onboarding/ui.js';
import { scheduleState } from './status.js';
import { newWorkspaceHome } from './list.js';

const canManage = () => state.workspace && state.workspace.role !== 'MEMBER';
const n = (v) => Number(v) || 0;
const PRIO = { BLOCKER: { cls: 'is-blocker', label: 'Blocker' }, ATTENTION: { cls: 'is-attn', label: '확인 필요' }, ACTION: { cls: 'is-action', label: 'Action 필요' }, NORMAL: { cls: 'is-ok', label: '정상' }, WAITING: { cls: 'is-wait', label: '대기' } };
const ATT_TYPE = { ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', CHANGE: 'Change', WBS: 'WBS', ACCEPTANCE: 'Acceptance', REQUIREMENT: 'Req' };

const lifecycle = (seq) => html`<span class="lcpos" aria-label="Lifecycle 위치">${raw(Array.from({ length: 7 }, (_, i) => `<i class="${i + 1 < seq ? 'is-done' : i + 1 === seq ? 'is-cur' : ''}"></i>`).join(''))}</span>`;
const isMove = (a) => Boolean(a && /\?move=next$/.test(a.href));

/* ---------- 다음 할 일: the What's Next CTA, verbatim. ?move=next (phase transition) keeps its confirm dialog in Project Home. ---------- */
const nextBlock = (c) => {
  const g = c.guidance; const u = `/app/projects/${c.id}`;
  if (!g) return '';
  if (c.status === 'ON_HOLD' || c.status === 'DRAFT') {
    return html`<div class="hc__next hc__next--quiet"><span class="hc__k">상태</span><p class="hc__t">${c.status === 'ON_HOLD' ? '보류 중입니다.' : '초안 상태입니다. 프로젝트 정보를 확정하면 안내가 시작됩니다.'}</p>
      <a class="link hc__go" href="${u}" data-link>${c.status === 'ON_HOLD' ? '프로젝트 열기 →' : 'What’s Next 보기 →'}</a></div>`;
  }
  if (g.kind === 'MONITOR') {
    const nd = c.next_date;
    return html`<div class="hc__next hc__next--quiet"><span class="hc__k">상태</span>
      <p class="hc__t">정상 진행 중${raw(nd ? html` · 다음 확인 <b>${fmtShort(nd.date)} ${nd.title}</b>` : '')}</p>
      ${raw(g.primary_action ? html`<a class="link hc__go" href="${g.primary_action.href}" data-link>${g.primary_action.label}</a>` : '')}</div>`;
  }
  const pa = g.primary_action;
  const cta = !pa ? '' : isMove(pa)
    ? html`<a class="btn btn--primary btn--sm" href="${u}?move=next" data-link>${c.next_phase ? `${no2(c.next_phase.sequence)} ${c.next_phase.name} 단계 시작 →` : pa.label}</a>`
    : html`<a class="btn btn--primary btn--sm" href="${pa.href}" data-link>${pa.label}</a>`;
  return html`<div class="hc__next"><span class="hc__k">다음 할 일</span><p class="hc__t">${g.title}</p>${raw(cta)}</div>`;
};

/* ---------- bottom strip: 진행률 · 일정 · 확인 필요 (one line, Overview numbers) ---------- */
const stripBlock = (c) => {
  const w = c.wbs || {}; const sch = scheduleState(w); const a = c.attention || { total: 0, crit: 0, items: [] };
  const prog = n(w.tasks) ? `${n(w.progress)}%` : '-';
  const hasHealth = c.health && c.health.status !== 'UNKNOWN';
  const att = a.total
    ? html`<a class="hc__att is-${a.crit ? 'crit' : 'warn'}" href="/app/projects/${c.id}/overview#att" data-link><i class="att__dot ${a.crit ? 'is-crit' : ''}" aria-hidden="true"></i>확인 필요 ${a.total}건</a>`
    : hasHealth ? '' : html`<span class="hc__att is-ok">정상 진행</span>`;
  return html`<div class="hc__strip">
    <span class="hc__m"><small>진행률</small><b>${prog}</b></span>
    <span class="hc__m"><small>일정</small><b class="is-${sch.tone}">${sch.label}</b></span>
    ${raw(att)}
    ${raw(hasHealth ? html`<a class="hchip hchip--sm hc__health ${c.health.status === 'GOOD' ? 'is-good' : c.health.status === 'WARNING' ? 'is-warn' : 'is-crit'}" href="/app/projects/${c.id}/overview#health" data-link title="Project Health">${c.health.status_label}</a>` : '')}
  </div>`;
};
const attentionList = (c) => {
  const a = c.attention; if (!a || !a.total) return '';
  return html`<ul class="hc__attl">${raw(a.items.map((i) => html`<li><a href="/app/projects/${c.id}/${i.href}" data-link title="${i.meta}"><i class="att__dot ${i.severity === 'crit' ? 'is-crit' : ''}" aria-hidden="true"></i><span class="hc__attk">${ATT_TYPE[i.type] || i.type}</span>${raw(i.display_id ? html`<span class="mono">${i.display_id}</span>` : '')}<span class="hc__attt">${i.title}</span></a></li>`).join(''))}${raw(a.total > a.items.length ? html`<li class="hc__attmore"><a class="link" href="/app/projects/${c.id}/overview#att" data-link>외 ${a.total - a.items.length}건 →</a></li>` : '')}</ul>`;
};
const upcomingLine = (c) => {
  const up = c.upcoming || [];
  return html`<div class="hc__up"><span class="hc__k">주요 일정</span>${raw(up.length
    ? up.map((u) => html`<a class="hc__ms" href="/app/projects/${c.id}/${u.href}" data-link><time>${fmtShort(u.date)}</time>${u.title}</a>`).join('<i class="hc__sep">·</i>')
    : '<span class="hc__none">예정된 마일스톤 없음</span>')}</div>`;
};

const card = (c) => {
  const pr = PRIO[c.priority] || PRIO.ACTION;
  return html`<article class="hc ${pr.cls}" data-pid="${c.id}">
    <header class="hc__h">
      <span class="hc__prio" title="${pr.label}">${pr.label}</span>
      <a class="hc__name" href="/app/projects/${c.id}" data-link title="${c.name}">${c.name}</a>
      <span class="hc__client">${c.client_name || ''}</span>
      <span class="chip ${STATUS_CHIP[c.status] || ''}">${STATUS[c.status]}</span>
    </header>
    <div class="hc__phase"><span class="hc__k">현재 단계</span><b>${no2(c.current_phase_sequence)} ${c.current_phase_name}</b>${raw(lifecycle(c.current_phase_sequence))}${raw(c.soon && c.next_date ? html`<span class="hc__soon" title="${c.next_date.label}">D-${c.next_date_days} ${c.next_date.title}</span>` : '')}</div>
    ${raw(nextBlock(c))}
    ${raw(stripBlock(c))}
    ${raw(attentionList(c))}
    ${raw(upcomingLine(c))}
  </article>`;
};

const completedRow = (p) => html`<a class="hc__done" href="/app/projects/${p.id}" data-link><span class="hc__done-n">${p.name}</span><span class="hc__client">${p.client_name || ''}</span><span class="chip chip--done">완료</span><span class="hc__done-ph">${no2(p.current_phase_sequence)} ${p.current_phase_name}</span></a>`;

const summaryLine = (counts) => {
  const parts = ['BLOCKER', 'ATTENTION', 'ACTION', 'NORMAL', 'WAITING'].filter((k) => counts[k]).map((k) => html`<span class="hc__cnt ${PRIO[k].cls}"><i></i>${PRIO[k].label} ${counts[k]}</span>`);
  return parts.length ? html`<span class="hgrid__sum">${raw(parts.join(''))}</span>` : '';
};

export async function homePage(main = $('#main')) {
  document.title = 'Home — RELAI';
  const [h, o] = await Promise.all([api('GET', wsApi('/home')), ob.get()]);
  const live = h.projects || []; const done = h.completed || [];
  const any = live.length || done.length;
  main.innerHTML = html`<div class="page home">
    <div class="page__head"><div><h1>${state.user.name}님, 안녕하세요</h1><p>${state.workspace.name}</p></div>
      ${raw(any && canManage() ? '<a class="btn btn--primary" href="/app/projects/new" data-link data-tour-id="create-project">+ 새 프로젝트</a>' : '')}</div>
    ${raw(any ? checklistCard(o, { compact: true }) : '')}
    ${raw(live.length && !canManage() ? html`<p class="home__member">${state.workspace.name} Workspace에 참여 중입니다. 프로젝트를 선택해 진행 상황을 확인하세요. <a class="link" href="/app/projects/${live[0].id}/wbs?owner=${state.user.id}" data-link>내 업무 보기</a></p>` : '')}
    ${raw(live.length ? html`<section class="hgrid__sec" aria-labelledby="hgT"><div class="hgrid__h"><h2 id="hgT">프로젝트 현황</h2>${raw(summaryLine(h.counts || {}))}</div>
        <div class="hgrid">${raw(live.map(card).join(''))}</div></section>`
      : any ? '<div class="empty empty--sm"><h2>진행 중인 프로젝트가 없습니다.</h2><p>완료·보관된 프로젝트는 Projects에서 볼 수 있습니다.</p></div>' : newWorkspaceHome(o))}
    ${raw(done.length ? html`<details class="hdone"><summary>완료된 프로젝트 <b>${done.length}</b>개</summary><div class="hdone__l">${raw(done.map(completedRow).join(''))}</div></details>` : '')}
  </div>`;
  bindChecklist(main);
}
