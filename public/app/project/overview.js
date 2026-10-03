/* Overview — read-only project dashboard: "프로젝트 전체적으로 어떻게 되고 있지?"
 * Hierarchy: 1) project progress + lifecycle  2) attention / issues / risks  3) execution · requirements · tests  4) upcoming · activity.
 * No forms, no guidance: the next action lives in What’s Next? (next.js). Every number links to the screen that owns it. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, no2, raw, todayLocal } from '../core/dom.js';
import { projectHead } from './guide.js';
import { STATUS } from '../shared/constants.js';
import { relTime } from '../shared/jira.js';
import { toast } from '../shared/dialogs.js';

const ATT_TYPE = { ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', CHANGE: 'Change', WBS: 'WBS', ACCEPTANCE: 'Acceptance', REQUIREMENT: 'Requirement' };
const H_CLS = { GOOD: 'is-good', WARNING: 'is-warn', CRITICAL: 'is-crit', UNKNOWN: 'is-unknown' };
const pv = (v) => (v === null || v === undefined ? '-' : `${v}%`);

const attentionRows = (items, pid) => html`<ol class="ovatt__list">${raw(items.map((i) => html`<li><a href="/app/projects/${pid}/${i.href}" data-link>
  <i class="att__dot is-${i.severity}"></i><span class="ovatt__k">${ATT_TYPE[i.type] || i.type}</span><span class="mono">${i.display_id}</span><span class="ovatt__t">${i.title}</span><small>${i.meta}</small></a></li>`).join(''))}</ol>`;

/* 1순위 — Project Progress: overall %, lifecycle, status, schedule */
const progressPanel = (g, p, snap) => {
  const u = `/app/projects/${p.id}`; const cur = g.current_phase; const h = snap.health; const sch = h ? h.dimensions.schedule : null;
  return html`<section class="ovp" aria-labelledby="ovpT">
    <div class="ovp__top">
      <div class="ovp__big"><span class="ovp__k">전체 진행률</span><b>${g.progress}%</b><span class="pbar pbar--g"><i style="width:${g.progress}%"></i></span><small>7개 단계의 할 일 기준</small></div>
      <dl class="ovp__kv">
        <dt>현재 단계</dt><dd><a class="link" href="${u}" data-link><i class="st st--cur" aria-hidden="true">●</i> ${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</a> <small class="dim">${cur ? `${cur.progress.done}/${cur.progress.total} 완료` : ''}</small></dd>
        <dt>프로젝트 상태</dt><dd><span class="chip ${p.status === 'ACTIVE' ? 'chip--done' : p.status === 'ON_HOLD' ? 'chip--warn' : 'chip--muted'}">${STATUS[p.status]}</span></dd>
        <dt>일정 상태</dt><dd>${raw(sch ? html`<span class="hchip hchip--sm ${H_CLS[sch.status]}">${sch.status_label}</span> <small class="dim">${sch.reasons[0] || ''}</small>` : '<span class="dim">-</span>')}</dd>
        <dt>기간</dt><dd class="mono">${p.planned_start_date || '-'} ~ ${p.planned_end_date || '-'}</dd>
      </dl>
    </div>
    <ol class="lc" id="ovpT" aria-label="Lifecycle">${raw(g.phases.map((ph) => {
      const state = ph.is_current ? 'cur' : ph.status === 'COMPLETED' ? 'done' : ph.status === 'IN_PROGRESS' ? 'open' : 'todo';
      const href = ph.phase_key === 'INITIATION' ? `${u}/definition` : `${u}/phases/${ph.phase_key}`;
      return html`<li class="is-${state}"><a href="${href}" data-link title="${ph.name} · ${ph.progress.done}/${ph.progress.total}"><i class="st st--${state === 'open' ? 'todo' : state}" aria-hidden="true">${state === 'done' ? '✓' : state === 'cur' ? '●' : '○'}</i><span>${ph.name}</span><small>${ph.progress.done}/${ph.progress.total}</small></a></li>`;
    }).join(''))}</ol>
  </section>`;
};

/* 2순위 — Attention: 확인 필요 + Issue / Risk summary */
const attentionPanel = (g, snap, pid) => {
  const items = snap.attention || []; const total = snap.attention_total || items.length; const u = `/app/projects/${pid}`;
  const is = g.issues || {}; const rs = g.risks || {};
  return html`<section class="ovatt ovcard ${items.some((i) => i.severity === 'crit') ? 'is-crit' : ''}" id="att" aria-labelledby="attT">
    <div class="ovh"><b id="attT">확인 필요</b>${raw(total ? html`<em class="ovh__n">${total}</em>` : '')}<span class="ovh__sp"></span>
      <a class="ovh__chip ${is.critical ? 'is-crit' : is.active ? 'is-warn' : ''}" href="${u}/issues" data-link>Issue <b>${is.active ?? 0}</b>${raw(is.critical ? html` <small>Critical ${is.critical}</small>` : '')}</a>
      <a class="ovh__chip ${rs.critical ? 'is-crit' : rs.high_or_critical ? 'is-warn' : ''}" href="${u}/issues?tab=risks" data-link>Risk <b>${(rs.open || 0) + (rs.monitoring || 0)}</b>${raw(rs.high_or_critical ? html` <small>High+ ${rs.high_or_critical}</small>` : '')}</a>
      ${raw(total > items.length ? html`<button type="button" class="link ovh__more" id="att-more">모두 보기</button>` : '')}</div>
    ${raw(items.length ? attentionRows(items, pid) : '<p class="ovnone">현재 즉시 확인해야 할 항목이 없습니다.</p>')}
  </section>`;
};

/* 3순위 — Execution / Requirements / Tests cards */
const stat = (label, value, href, tone = '') => html`<a class="ovs ${tone}" href="${href}" data-link><span>${label}</span><b>${value}</b></a>`;
const executionCard = (g, dash, p) => {
  const u = `/app/projects/${p.id}`; const w = g.wbs || {}; const t = dash.tasks || {};
  return html`<section class="ovcard" aria-labelledby="exT"><div class="ovh"><b id="exT">Execution Progress</b><small class="dim">WBS 기준</small></div>
    ${raw(!w.total ? html`<p class="ovnone">아직 WBS가 없습니다. 일정 단계에서 작업을 등록하면 실행 진척률이 계산됩니다. <a class="link" href="${u}/wbs" data-link>WBS →</a></p>`
      : html`<div class="ovs__big"><a href="${u}/wbs" data-link><b>${w.progress}%</b><span class="pbar pbar--g"><i style="width:${w.progress}%"></i></span></a></div>
      <div class="ovs__row">${raw(stat('완료 Task', t.completed || 0, `${u}/wbs?cst=COMPLETED`, 'is-ok'))}${raw(stat('진행 중', t.in_progress || 0, `${u}/wbs?cst=IN_PROGRESS`, 'is-act'))}${raw(stat('지연', t.delayed || 0, `${u}/wbs?f=overdue`, t.delayed ? 'is-crit' : ''))}${raw(stat('전체', t.total || 0, `${u}/wbs`))}</div>
      ${raw(g.jira ? html`<p class="ovs__jira">Jira <span class="mono">${g.jira.project_key}</span> · ${g.jira.total ? `${g.jira.done} Done / ${g.jira.total} 연결 (실행률 ${g.jira.rate}%)` : '연결된 Issue 없음'}${raw(g.jira.connection_status !== 'ACTIVE' ? ' <span class="chip chip--fail">연결 확인 필요</span>' : '')}</p>` : '')}`)}
  </section>`;
};
const requirementsCard = (g, p) => {
  const u = `/app/projects/${p.id}`; const r = g.requirements || {}; const k = g.kpis || {};
  const unconfirmed = (r.total || 0) - (r.confirmed || 0);
  return html`<section class="ovcard" aria-labelledby="rqT"><div class="ovh"><b id="rqT">Requirements</b><small class="dim">범위·확정·WBS 연결</small></div>
    ${raw(!r.total ? html`<p class="ovnone">등록된 요구사항이 없습니다. <a class="link" href="${u}/requirements" data-link>Requirements →</a></p>`
      : html`<div class="ovs__row">${raw(stat('전체', r.total, `${u}/requirements`))}${raw(stat('확정', r.confirmed || 0, `${u}/requirements?status=CONFIRMED`, 'is-ok'))}${raw(stat('미확정', unconfirmed, `${u}/requirements?status=DRAFT,REVIEWING,ON_HOLD`, unconfirmed ? 'is-warn' : ''))}${raw(stat('Coverage', pv(k.requirement_coverage), `${u}/requirements?view=trace`, k.requirement_coverage !== null && k.requirement_coverage < 100 ? 'is-warn' : 'is-ok'))}</div>
      ${raw(r.in_scope_unlinked ? html`<p class="ovs__note"><i class="st st--warn" aria-hidden="true">!</i>확정된 범위 내 요구사항 ${r.in_scope_unlinked}건이 WBS와 연결되지 않았습니다.</p>` : '')}`)}
  </section>`;
};
const testsCard = (g, p) => {
  const u = `/app/projects/${p.id}`; const t = g.tests || {}; const a = g.acceptances || {}; const k = g.kpis || {};
  const notRun = (t.total || 0) - (t.executed || 0);
  return html`<section class="ovcard" aria-labelledby="tsT"><div class="ovh"><b id="tsT">Tests & Acceptance</b><small class="dim">최근 실행 결과 기준</small></div>
    ${raw(!t.total ? html`<p class="ovnone">등록된 테스트가 없습니다. <a class="link" href="${u}/tests" data-link>Tests & Acceptance →</a></p>`
      : html`<div class="ovs__row">${raw(stat('Coverage', pv(k.test_coverage), `${u}/tests?tab=coverage`))}${raw(stat('통과', t.last_pass || 0, `${u}/tests?last_result=PASS`, 'is-ok'))}${raw(stat('실패', t.last_fail || 0, `${u}/tests?last_result=FAIL`, t.last_fail ? 'is-crit' : ''))}${raw(stat('미실행', notRun, `${u}/tests?last_result=NOT_RUN`, notRun ? 'is-warn' : ''))}</div>`)}
    ${raw(a.total ? html`<p class="ovs__note">검수 ${a.total}건 · 승인 ${a.accepted || 0} · 요청 ${a.requested || 0}${a.rework ? ` · <span class="is-warn">보완 필요 ${a.rework}</span>` : ''} <a class="link" href="${u}/tests?tab=acceptance" data-link>→</a></p>` : '')}
  </section>`;
};
const healthLine = (h) => {
  if (!h) return '';
  return html`<details class="hline ${H_CLS[h.status]}"><summary><span class="hline__l">Project Health</span><span class="hchip hchip--sm ${H_CLS[h.status]}">${h.status_label}</span>
      ${raw(Object.values(h.dimensions).map((d) => html`<span class="hline__d"><span>${d.label}</span><span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></span>`).join(''))}
      ${raw(h.partial_unknown ? '<small class="hline__note">일부 정보 부족</small>' : '')}<span class="hline__more">근거 보기</span></summary>
    <div class="hline__r">${raw(Object.values(h.dimensions).map((d) => html`<div><b>${d.label} <span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></b><ul>${raw(d.reasons.map((r) => html`<li>${r}</li>`).join(''))}${raw(d.hint ? html`<li class="dim">${d.hint}</li>` : '')}</ul></div>`).join(''))}</div>
  </details>`;
};

/* 4순위 — Upcoming / Activity */
const upcomingPanel = (snap, dash, pid) => {
  const up = (snap.upcoming || []).slice(0, 6); const ms = (dash.milestones || []).filter((m) => m.status !== 'COMPLETED' && m.milestone_date).slice(0, 3);
  return html`<section class="ovup ovcard" aria-labelledby="upT"><div class="ovh"><b id="upT">Upcoming</b><small class="dim">7일 내 일정 · 마일스톤</small>${raw(up.length ? html`<em class="ovh__n">${(snap.upcoming || []).length}</em>` : '')}</div>
    ${raw(up.length ? html`<ol class="ovup__list">${raw(up.map((x) => html`<li><a href="/app/projects/${pid}/${x.href}" data-link><time>${fmtShort(x.date)}${x.date === todayLocal() ? ' 오늘' : ''}</time><span class="ovup__k">${x.label}</span><span class="ovup__t">${x.title}</span></a></li>`).join(''))}</ol>` : '<p class="ovnone">7일 내 예정된 일정이 없습니다.</p>')}
    ${raw(ms.length ? html`<div class="ovup__ms">${raw(ms.map((m) => html`<a href="/app/projects/${pid}/wbs?sel=${m.id}" data-link><span class="${m.days_left < 0 ? 'is-crit' : ''}">${m.days_left < 0 ? `D+${-m.days_left}` : m.days_left === 0 ? '오늘' : `D-${m.days_left}`}</span>${m.title}</a>`).join(''))}</div>` : '')}
  </section>`;
};
const activityPanel = (dash, pid) => {
  const ev = (dash.recent_changes || []).slice(0, 8);
  return html`<section class="ovcard ovact" aria-labelledby="acT"><div class="ovh"><b id="acT">Activity</b><small class="dim">최근 변경</small><span class="ovh__sp"></span><button type="button" class="link linkbtn" id="act-all" style="width:auto">전체 보기</button></div>
    ${raw(ev.length ? html`<ol class="ovact__list">${raw(ev.map((e) => html`<li><a href="/app/projects/${pid}/${e.href}" data-link><time title="${e.at}">${relTime(e.at)}</time><span class="ovact__w">${e.actor_name || '-'}</span><span class="ovact__t">${raw(e.display_id ? html`<span class="mono">${e.display_id}</span> ` : '')}${e.title}</span><small>${e.summary}</small></a></li>`).join(''))}</ol>` : '<p class="ovnone">아직 기록된 변경이 없습니다.</p>')}
  </section>`;
};

export async function overviewPage(id, main = $('#main')) {
  const [g, snap, dash] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/snapshot`)), api('GET', wsApi(`/${id}/dashboard`))]);
  const p = g.project;
  document.title = `Overview — ${p.name} — RELAI`;
  main.innerHTML = html`<div class="page page--wide page--flow ov">
    ${raw(projectHead(p, g, { tab: 'overview' }))}
    ${raw(p.status === 'ARCHIVED' ? '<div class="notice">보관된 프로젝트입니다. 현황은 조회만 할 수 있습니다.</div>' : '')}
    ${raw(progressPanel(g, p, snap))}
    <div class="ov__row2">${raw(attentionPanel(g, snap, p.id))}</div>
    <div class="ov__row3">${raw(executionCard(g, dash, p))}${raw(requirementsCard(g, p))}${raw(testsCard(g, p))}</div>
    ${raw(healthLine(snap.health))}
    <div class="ov__row4">${raw(upcomingPanel(snap, dash, p.id))}${raw(activityPanel(dash, p.id))}</div>
  </div>`;
  const aa = $('#act-all'); if (aa) aa.onclick = () => { const b = document.querySelector('.wsh__act [data-act="activity"]'); if (b) b.click(); };
  const more = $('#att-more');
  if (more) more.onclick = async () => { more.disabled = true; try { const all = await api('GET', wsApi(`/${id}/attention`)); const list = $('#att .ovatt__list'); if (list) list.outerHTML = attentionRows(all.items, p.id); more.remove(); } catch (e) { toast(e.message); more.disabled = false; } };
}
