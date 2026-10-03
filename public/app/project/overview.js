/* 프로젝트 홈 — read-only dashboard. Answers, in this order: 지금 어느 단계인가 → 이 단계는 얼마나 준비됐나 → 실행은 얼마나 진행됐나
 * → 다음에 무엇을 하나 → 확인할 것·다가오는 일정. No forms, no inline editing: every action links to the screen that owns it
 * (프로젝트 정의, 업무 탭, 단계 기록). Stage changes happen only through a confirmed dialog. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, no2, raw, todayLocal } from '../core/dom.js';
import { moveToPhase, projectHead, stepInfo } from './guide.js';
import { PHASE_STATUS } from '../shared/constants.js';
import { toast } from '../shared/dialogs.js';
import { bindCoach, phaseIntro } from '../onboarding/ui.js';
import { ob } from '../onboarding/state.js';

const ATT_TYPE = { ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', CHANGE: 'Change', WBS: 'WBS', ACCEPTANCE: 'Acceptance', REQUIREMENT: 'Requirement' };
const H_CLS = { GOOD: 'is-good', WARNING: 'is-warn', CRITICAL: 'is-crit', UNKNOWN: 'is-unknown' };

const attentionRows = (items, pid) => html`<ol class="ovatt__list">${raw(items.map((i) => html`<li><a href="/app/projects/${pid}/${i.href}" data-link>
  <i class="att__dot is-${i.severity}"></i><span class="ovatt__k">${ATT_TYPE[i.type] || i.type}</span><span class="mono">${i.display_id}</span><span class="ovatt__t">${i.title}</span><small>${i.meta}</small></a></li>`).join(''))}</ol>`;

/** Phase 14 — "지금 해야 할 일": rule-based guidance from the server (g.guidance). Always present; never a gate. */
const guidanceCard = (g, p, archived, created) => {
  const q = g.guidance; if (!q) return '';
  const act = (a, cls) => (!a ? '' : /\?move=next$/.test(a.href) ? html`<button type="button" class="btn ${cls} btn--sm" data-move-next>${a.label}</button>` : html`<a class="btn ${cls} btn--sm" href="${a.href}" data-link>${a.label}</a>`);
  return html`<section class="gcard ${created ? 'is-new' : ''}" aria-labelledby="gcT" data-tour-id="guidance">
    ${raw(created ? '<div class="gcard__new"><b>프로젝트가 생성되었습니다.</b> 이제 프로젝트의 목표와 범위를 정의해 주세요.</div>' : '')}
    <div class="gcard__row">
      <div class="gcard__m">
        <div class="gcard__k"><span class="gcard__cur">현재 단계 · ${q.current_phase.name}</span><span class="gcard__lbl">지금 할 일</span></div>
        <h2 id="gcT">${q.title}</h2>
        ${raw(q.description ? html`<p class="gcard__d">${q.description}</p>` : '')}
        ${raw(q.why ? html`<p class="gcard__why"><b>왜 필요한가</b>${q.why}</p>` : '')}
        ${raw(q.warnings && q.warnings.length ? html`<ul class="gcard__warn">${raw(q.warnings.map((w) => html`<li>${w}</li>`).join(''))}</ul>` : '')}
      </div>
      <div class="gcard__a">${raw(archived ? '' : act(q.primary_action, 'btn--primary') + act(q.secondary_action, 'btn--secondary'))}
        ${raw(q.next_preview ? html`<small class="gcard__next"><b>Next</b> ${q.next_preview}</small>` : '')}</div>
    </div></section>`;
};

/** 현재 단계 + 다음 할 일. Steps are listed with their live status text and a link to the screen where the work happens. */
const stagePanel = (g, p, archived) => {
  const cur = g.current_phase; const u = `/app/projects/${p.id}`;
  const done = cur.progress.done; const total = cur.progress.total; const allDone = done === total;
  const init = cur.phase_key === 'INITIATION';
  const open = cur.steps.filter((s) => s.status !== 'COMPLETED');
  const review = init && g.definition ? g.definition.needs_review : [];
  const nextStep = open[0];
  return html`<section class="stage" aria-labelledby="stT">
    <div class="stage__h">
      <div class="stage__t"><span class="stage__no mono">${no2(cur.sequence)}</span><h2 id="stT">${cur.name}</h2><span class="stage__cur">현재 단계</span></div>
      <div class="stage__p" title="이 단계의 할 일 완료 수 (준비 완료율)"><small>단계 준비</small><b>${done} / ${total}</b><span class="pbar"><i style="width:${cur.progress.percent}%"></i></span></div>
    </div>
    <p class="stage__d">${cur.description}</p>
    <ol class="stage__list stage__list--ro">${raw(cur.steps.map((s) => {
      const isDone = s.status === 'COMPLETED';
      const info = stepInfo(cur.phase_key, s.step_key, g, p.id);
      const warn = init && review.includes(s.step_key);
      const isNext = !isDone && nextStep && nextStep.id === s.id;
      return html`<li class="${isDone ? 'is-done' : ''} ${isNext ? 'is-next' : ''}">
        <i class="stage__mk ${isDone ? (warn ? 'is-warn' : 'is-done') : ''}" aria-hidden="true">${isDone ? (warn ? '!' : '✓') : s.sequence}</i>
        <span class="stage__st">${s.title}${raw(isNext ? '<em class="stage__nx">다음 할 일</em>' : '')}</span>
        <span class="stage__info ${info && !info.ok && !isDone ? 'is-warn' : ''} ${warn ? 'is-warn' : ''}">${info ? info.text : s.completion_criteria}</span>
        ${raw(info && (!isDone || warn || init) ? html`<a class="stage__go" href="${info.cta.href}" data-link>${info.cta.label}</a>` : !isDone ? html`<a class="stage__go" href="${u}/phases/${cur.phase_key}#step-${s.id}" data-link>단계 기록에서 처리</a>` : '<span></span>')}
      </li>`;
    }).join(''))}</ol>
    <div class="stage__f">
      ${raw(allDone ? html`<span class="stage__msg"><b>현재 단계의 할 일을 모두 완료했습니다.</b> ${g.next_phase ? `다음 단계: ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : '마지막 단계입니다.'}</span>`
        : html`<span class="stage__msg">${raw(init ? '각 항목은 <b>프로젝트 정의</b>에서 작성하고 완료합니다.' : '완료 처리는 <b>단계 기록</b>에서, 실제 작업은 각 업무 탭에서 합니다.')}</span>`)}
      <span class="stage__btns">
        ${raw(init ? html`<a class="btn ${allDone ? 'btn--secondary' : 'btn--primary'} btn--sm" href="${u}/definition" data-link>프로젝트 정의 ${allDone ? '보기' : '작성'}</a>`
          : html`<a class="btn btn--secondary btn--sm" href="${u}/phases/${cur.phase_key}" data-link>단계 기록·완료 처리</a>`)}
        ${raw(!archived && g.next_phase ? html`<button class="btn ${allDone ? 'btn--primary' : 'btn--secondary'} btn--sm" id="next">다음 단계로 이동</button>` : '')}</span>
    </div>
  </section>`;
};

/** 실행 진척률 — WBS based, shown apart from the stage readiness so the two are never confused. */
const executionPanel = (g, dash, p) => {
  const u = `/app/projects/${p.id}`; const w = g.wbs || {}; const t = dash.tasks || {};
  const ms = (dash.milestones || []).find((m) => m.status !== 'COMPLETED' && m.milestone_date);
  if (!w.total) {
    return html`<section class="exec exec--empty" aria-labelledby="exT"><div class="ovh"><b id="exT">실행 진척률</b><small class="dim">WBS 기준</small></div>
      <p class="exec__none">아직 집계할 WBS가 없습니다. 일정 단계에서 작업(WBS)을 등록하면 작업 진행률을 기준으로 실행 진척률이 계산됩니다.</p>
      <a class="link" href="${u}/wbs" data-link>WBS 화면으로</a></section>`;
  }
  const d = ms ? (ms.days_left < 0 ? `D+${-ms.days_left}` : ms.days_left === 0 ? '오늘' : `D-${ms.days_left}`) : '';
  return html`<section class="exec" aria-labelledby="exT"><div class="ovh"><b id="exT">실행 진척률</b><small class="dim">WBS ${w.total}개 작업 기준 · 단계 준비율과 다른 지표입니다</small></div>
    <div class="exec__row">
      <a class="exec__big" href="${u}/wbs" data-link><b>${w.progress}%</b><span class="pbar"><i style="width:${w.progress}%"></i></span></a>
      <a class="exec__k" href="${u}/wbs?f=overdue" data-link><span>지연 작업</span><b class="${t.delayed ? 'is-crit' : ''}">${t.delayed || 0}</b></a>
      <a class="exec__k" href="${u}/wbs" data-link><span>진행 중 / 완료</span><b>${w.in_progress || 0} / ${w.completed || 0}</b></a>
      ${raw(ms ? html`<a class="exec__k" href="${u}/wbs?sel=${ms.id}" data-link><span>다음 마일스톤</span><b class="${ms.days_left < 0 ? 'is-crit' : ''}">${d}</b><small>${ms.title}</small></a>` : html`<span class="exec__k"><span>다음 마일스톤</span><b class="dim">-</b><small>등록된 마일스톤 없음</small></span>`)}
    </div>${raw(g.jira ? html`<div class="exec__jira"><span class="exec__jl">Jira 실행 <small class="mono">${g.jira.project_key}</small></span>${raw(g.jira.total ? html`<b>${g.jira.total}개 연결</b><span>${g.jira.done} Done · ${g.jira.in_progress} In Progress · ${g.jira.todo} To Do</span><em title="연결된 Jira Issue 중 Done 비율 — WBS 진행률과 별개">실행률 ${g.jira.rate}%</em>${raw(g.jira.missing ? html`<span class="is-warn">찾을 수 없음 ${g.jira.missing}</span>` : '')}` : '<span class="dim">아직 연결된 Jira Issue가 없습니다. WBS 작업의 Jira 실행 탭에서 연결하세요.</span>')}${raw(g.jira.connection_status !== 'ACTIVE' ? '<span class="chip chip--fail">연결 확인 필요</span>' : '')}</div>` : '')}</section>`;
};

/** 확인 필요 + 7일 내 일정 (exceptions only). */
const attentionPanel = (snap, pid) => {
  const items = snap.attention || []; const total = snap.attention_total || items.length;
  const up = (snap.upcoming || []).slice(0, 5);
  return html`<aside class="ovside">
    <section class="ovatt ${items.some((i) => i.severity === 'crit') ? 'is-crit' : ''}" id="att" aria-labelledby="attT">
      <div class="ovh"><b id="attT">확인 필요</b>${raw(total ? html`<em class="ovh__n">${total}</em>` : '')}
        ${raw(total > items.length ? html`<button type="button" class="link ovh__more" id="att-more">모두 보기</button>` : '')}</div>
      ${raw(items.length ? attentionRows(items, pid) : '<p class="ovnone">현재 즉시 확인해야 할 항목이 없습니다.</p>')}
    </section>
    <section class="ovup" aria-labelledby="upT"><div class="ovh"><b id="upT">7일 내 일정</b>${raw(up.length ? html`<em class="ovh__n">${(snap.upcoming || []).length}</em>` : '')}</div>
      ${raw(up.length ? html`<ol class="ovup__list">${raw(up.map((x) => html`<li><a href="/app/projects/${pid}/${x.href}" data-link><time>${fmtShort(x.date)}${x.date === todayLocal() ? ' 오늘' : ''}</time><span class="ovup__k">${x.label}</span><span class="ovup__t">${x.title}</span></a></li>`).join(''))}</ol>` : '<p class="ovnone">7일 내 예정된 일정이 없습니다.</p>')}</section>
  </aside>`;
};

/** 단계 안내: all phases with status; a phase opens its record screen (read-only); the current phase is changed only there, after a confirmation. */
const stagesPanel = (g, p) => {
  const u = `/app/projects/${p.id}`;
  return html`<section class="stages" aria-labelledby="sgT"><div class="ovh"><b id="sgT">진행 단계</b><small class="dim">단계를 누르면 그 단계의 할 일과 기록을 조회합니다. 현재 단계 변경은 기록 화면에서 확인 후 진행합니다.</small></div>
    <ol class="stages__list">${raw(g.phases.map((ph) => {
      const cls = ph.is_current ? 'is-current' : ph.status === 'COMPLETED' ? 'is-done' : ph.status === 'IN_PROGRESS' ? 'is-open' : '';
      const href = ph.phase_key === 'INITIATION' ? `${u}/definition` : `${u}/phases/${ph.phase_key}`;
      return html`<li class="${cls}"><a href="${href}" data-link>
        <i>${ph.status === 'COMPLETED' ? '✓' : ph.sequence}</i><span class="stages__n">${ph.name}</span>
        <small>${ph.is_current ? '현재 단계' : PHASE_STATUS[ph.status]} · ${ph.progress.done}/${ph.progress.total}</small>
        ${raw(ph.completed_at ? html`<time>${fmtShort(ph.completed_at)} 완료</time>` : ph.started_at ? html`<time>${fmtShort(ph.started_at)} 시작</time>` : '')}</a></li>`;
    }).join(''))}</ol></section>`;
};

/** Project Summary: one compact bar of area status; each item opens its working screen. */
const summaryBar = (g, dash, p) => {
  const u = `/app/projects/${p.id}`; const t = dash.tasks; const rq = dash.requirements;
  const is = g.issues || {}; const rs = g.risks || {}; const ch = g.changes || {}; const ts = g.tests || {};
  const item = (href, label, value, ex = [], title = '') => html`<a class="sumbar__i" href="${href}" data-link title="${title}"><span>${label}</span><b>${value}</b>${raw(ex.filter((e) => e && e.n).map((e) => html`<em class="${e.tone}">${e.label} ${e.n}</em>`).join(''))}</a>`;
  const items = [
    item(`${u}/requirements`, '요구사항', rq.total, [{ n: rq.unconfirmed, label: '미확정', tone: 'is-warn' }, { n: rq.unlinked_in_scope, label: 'WBS 미연결', tone: 'is-warn' }]),
    item(`${u}/wbs`, 'WBS 작업', t.total, [{ n: t.delayed, label: '지연', tone: 'is-crit' }]),
    item(`${u}/changes`, '변경', ch.total ?? 0, [{ n: ch.under_review, label: '검토', tone: 'is-warn' }, { n: ch.approved_unimplemented, label: '미반영', tone: 'is-warn' }]),
    item(`${u}/issues`, 'Issue', is.active ?? 0, [{ n: is.critical, label: 'Critical', tone: 'is-crit' }, { n: is.overdue, label: '지연', tone: 'is-warn' }]),
    item(`${u}/issues?tab=risks`, 'Risk', rs.open !== undefined ? rs.open + (rs.monitoring || 0) : 0, [{ n: rs.high_or_critical, label: 'High+', tone: 'is-warn' }]),
    item(`${u}/tests`, 'Test', ts.total ? `${ts.last_pass}/${ts.total} Pass` : 0, [{ n: ts.last_fail, label: 'Fail', tone: 'is-crit' }]),
  ];
  return html`<nav class="sumbar" aria-label="프로젝트 요약">${raw(items.join(''))}</nav>`;
};

const healthLine = (h) => {
  if (!h) return '';
  return html`<details class="hline ${H_CLS[h.status]}"><summary><span class="hline__l">프로젝트 상태</span><span class="hchip hchip--sm ${H_CLS[h.status]}">${h.status_label}</span>
      ${raw(Object.values(h.dimensions).map((d) => html`<span class="hline__d"><span>${d.label}</span><span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></span>`).join(''))}
      ${raw(h.partial_unknown ? '<small class="hline__note">일부 정보 부족</small>' : '')}<span class="hline__more">근거 보기</span></summary>
    <div class="hline__r">${raw(Object.values(h.dimensions).map((d) => html`<div><b>${d.label} <span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></b><ul>${raw(d.reasons.map((r) => html`<li>${r}</li>`).join(''))}${raw(d.hint ? html`<li class="dim">${d.hint}</li>` : '')}</ul></div>`).join(''))}</div>
  </details>`;
};

export async function overviewPage(id, main = $('#main')) {
  const [g, snap, dash] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/snapshot`)), api('GET', wsApi(`/${id}/dashboard`))]);
  const p = g.project;
  document.title = `${p.name} — RELAI`;
  const archived = p.status === 'ARCHIVED';
  const qp = new URLSearchParams(location.search); const created = qp.get('created') === '1'; const moveNext = qp.get('move') === 'next';
  if (created || moveNext) history.replaceState(null, '', `/app/projects/${id}`);
  await ob.get();   // cached; phase intro needs guides_seen
  main.innerHTML = html`<div class="page page--wide page--flow ov">
    ${raw(projectHead(p, g, { tab: 'overview' }))}
    ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 단계와 할 일은 조회만 할 수 있습니다.</div>' : '')}
    ${raw(guidanceCard(g, p, archived, created))}
    ${raw(g.current_phase ? phaseIntro(g.current_phase.phase_key, g.current_phase.name) : '')}
    <div class="ov__grid"><div class="ov__main">${raw(stagePanel(g, p, archived))}${raw(executionPanel(g, dash, p))}</div>${raw(attentionPanel(snap, p.id))}</div>
    <div class="ov__sum">${raw(summaryBar(g, dash, p))}${raw(healthLine(snap.health))}</div>
    ${raw(stagesPanel(g, p))}
  </div>`;
  const more = $('#att-more');
  if (more) more.onclick = async () => { more.disabled = true; try { const all = await api('GET', wsApi(`/${id}/attention`)); const list = $('#att .ovatt__list'); if (list) list.outerHTML = attentionRows(all.items, p.id); more.remove(); } catch (e) { toast(e.message); more.disabled = false; } };
  const nb = $('#next');
  if (nb) nb.onclick = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) overviewPage(id); };
  main.querySelectorAll('[data-move-next]').forEach((b) => { b.onclick = nb ? () => nb.click() : null; });
  bindCoach(main);
  if (moveNext && nb) nb.click();
}
