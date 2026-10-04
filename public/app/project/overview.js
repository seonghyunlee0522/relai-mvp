/* Overview — "Is this project on track?" Read-only, section-based (no card grid), Enterprise PM style.
 *   Progress  계획 진척률 · 실제 진척률 · 진척 편차 · 일정 상태 + Plan/Actual bars (WBS leaf tasks; server/wbs.js scheduleFigures)
 *   확인 필요  exceptions by type (counts → owning screen) + up to 5 concrete items
 *   Schedule / Scope / Quality  rows from data the system already has — never invented
 *   Project Health · Upcoming · Activity
 * The next action lives in What’s Next? (next.js); overall phase progression is shown there, not here. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, no2, raw, todayLocal } from '../core/dom.js';
import { projectHead } from './guide.js';
import { daysUntil, exceptions, scheduleState, varianceText, varianceTone } from './status.js';
import { relTime } from '../shared/jira.js';
import { toast } from '../shared/dialogs.js';

const ATT_TYPE = { ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', CHANGE: 'Change', WBS: 'WBS', ACCEPTANCE: 'Acceptance', REQUIREMENT: 'Requirement' };
const H_CLS = { GOOD: 'is-good', WARNING: 'is-warn', CRITICAL: 'is-crit', UNKNOWN: 'is-unknown' };
const pv = (v) => (v === null || v === undefined ? '-' : `${v}%`);
const n = (v) => Number(v) || 0;

/** One data row: label · value (toned) · helper. Clickable when it has a screen that owns the number. */
const kv = (label, value, { href = '', sub = '', tone = '' } = {}) => {
  const inner = html`<span class="kv__k">${label}</span><b class="kv__v ${tone ? `is-${tone}` : ''}">${value}</b>${raw(sub ? html`<small class="kv__s">${sub}</small>` : '')}`;
  return href ? html`<a class="kv" href="${href}" data-link>${raw(inner)}</a>` : html`<div class="kv">${raw(inner)}</div>`;
};
const metric = (label, value, { sub = '', tone = '' } = {}) => html`<div class="kpi ${tone ? `is-${tone}` : ''}"><span class="kpi__k">${label}</span><b class="kpi__v">${value}</b>${raw(sub ? html`<small class="kpi__s">${sub}</small>` : '')}</div>`;

/* ---------- Progress: planned vs actual ---------- */
const progressSection = (g, p) => {
  const u = `/app/projects/${p.id}`; const w = g.wbs || {}; const cur = g.current_phase; const nphase = (g.phases || []).length; const sch = scheduleState(w);
  const planned = w.planned_progress; const actual = n(w.progress); const v = w.variance;
  const basis = w.planned_basis || { dated: 0, tasks: 0 };
  return html`<section class="ovp ovsec" aria-labelledby="ovpT">
    <div class="ovsec__h"><h2 id="ovpT">Progress</h2><small class="ovsec__ctx">현재 단계 <a class="link" href="${u}" data-link>${cur ? `${no2(cur.sequence)} ${cur.name}` : '-'}</a>${nphase ? ` (${nphase}단계 중 ${cur ? cur.sequence : '-'}번째)` : ''} · WBS Task ${n(w.tasks)}건</small></div>
    ${raw(!n(w.tasks) ? html`<p class="ovnone">아직 WBS가 없습니다. 분석·설계 단계에서 작업을 등록하면 계획·실제 진척률이 계산됩니다. <a class="link" href="${u}/wbs" data-link>WBS 작성 시작 →</a></p>`
      : html`<div class="kpi4">
        ${raw(metric('계획 진척률', pv(planned), { sub: planned === null ? '계획 일정이 입력된 Task 없음' : basis.dated < basis.tasks ? `일정 입력 Task ${basis.dated}/${basis.tasks} 기준` : `오늘 기준 · Task ${basis.tasks}건` }))}
        ${raw(metric('실제 진척률', pv(actual), { sub: 'WBS Leaf Task 가중 평균' }))}
        ${raw(metric('진척 편차', varianceText(v), { sub: v === null ? '계획 진척률이 있어야 계산됩니다' : v >= 0 ? '정상' : v >= -5 ? '약간 지연' : '지연', tone: varianceTone(v) }))}
        ${raw(metric('일정 상태', sch.label, { sub: sch.detail, tone: sch.tone }))}
      </div>
      <div class="pva">
        <div class="pva__r"><span>Plan</span><span class="pbar"><i style="width:${planned ?? 0}%"></i></span><b>${pv(planned)}</b></div>
        <div class="pva__r pva__r--a"><span>Actual</span><span class="pbar pbar--g"><i style="width:${actual}%"></i></span><b>${actual}%</b></div>
      </div>`)}
    ${raw(g.jira ? html`<p class="ovs__jira">Jira <span class="mono">${g.jira.project_key}</span> · ${g.jira.total ? `${g.jira.done} Done / ${g.jira.total} 연결 (실행률 ${g.jira.rate}%)` : '연결된 Issue 없음'}${raw(g.jira.connection_status !== 'ACTIVE' ? ' <span class="chip chip--fail">연결 확인 필요</span>' : '')}</p>` : '')}
  </section>`;
};

/* ---------- 확인 필요: exceptions by type + a short preview of concrete items ---------- */
const attentionRows = (items, pid) => html`<ol class="ovatt__list">${raw(items.map((i) => html`<li><a href="/app/projects/${pid}/${i.href}" data-link>
  <i class="att__dot is-${i.severity}"></i><span class="ovatt__k">${ATT_TYPE[i.type] || i.type}</span><span class="mono">${i.display_id}</span><span class="ovatt__t">${i.title}</span><small>${i.meta}</small></a></li>`).join(''))}</ol>`;
const attentionSection = (g, snap, pid) => {
  const ex = exceptions(g, pid); const items = (snap.attention || []).slice(0, 5); const total = snap.attention_total || items.length;
  return html`<section class="ovsec ovatt" id="att" aria-labelledby="attT">
    <div class="ovsec__h"><h2 id="attT">확인 필요</h2>${raw(ex.total ? html`<em class="ovsec__n ${ex.rows.some((r) => r.tone === 'crit') ? 'is-crit' : 'is-warn'}">${ex.total}</em>` : '')}</div>
    ${raw(ex.rows.length ? html`<ul class="exl">${raw(ex.rows.map((r) => html`<li><a class="exl__a is-${r.tone}" href="${r.href}" data-link><i class="exl__dot" aria-hidden="true"></i><span class="exl__l">${r.label}${raw(r.sub ? html` <small>${r.sub}</small>` : '')}</span><b class="exl__n">${r.count}건</b><span class="exl__go" aria-hidden="true">→</span></a></li>`).join(''))}</ul>` : '<p class="ovnone">현재 즉시 확인해야 할 항목이 없습니다.</p>')}
    ${raw(items.length ? html`<div class="ovatt__pv"><div class="ovatt__ph"><span>주요 항목</span>${raw(total > items.length ? html`<button type="button" class="link ovh__more" id="att-more">전체 보기 (${total})</button>` : '')}</div>${raw(attentionRows(items, pid))}</div>` : '')}
  </section>`;
};

/* ---------- Schedule / Scope / Quality: three row groups in one band ---------- */
const scheduleCol = (g, p, dash) => {
  const u = `/app/projects/${p.id}`; const w = g.wbs || {}; const left = daysUntil(p.planned_end_date);
  const ms = dash.milestones || []; const nextMs = ms.find((m) => m.status !== 'COMPLETED' && m.milestone_date && m.days_left >= 0);
  return html`<div class="ovcol"><h3>Schedule</h3>
    ${raw(kv('프로젝트 시작일', p.planned_start_date || '-'))}
    ${raw(kv('계획 종료일', p.planned_end_date || '-'))}
    ${raw(kv('남은 기간', left === null ? '-' : left < 0 ? `${-left}일 초과` : `${left}일`, { tone: left === null ? '' : left < 0 ? 'crit' : left <= 14 ? 'warn' : '', sub: p.planned_end_date && left !== null && left >= 0 ? `오늘 ${todayLocal()} 기준` : '' }))}
    ${raw(kv('지연 Task', `${n(w.overdue_tasks)}건`, { href: `${u}/wbs?f=overdue`, tone: n(w.overdue_tasks) ? 'crit' : '', sub: n(w.overdue_tasks) ? `최대 ${n(w.max_overdue_days)}일 지연` : '' }))}
    ${raw(kv('주요 Milestone', n(w.milestones) ? `${n(w.milestones_completed)} / ${n(w.milestones)} 완료` : '-', { href: `${u}/wbs?view=gantt`, tone: n(w.overdue_milestones) ? 'crit' : '', sub: n(w.overdue_milestones) ? `지난 마일스톤 ${w.overdue_milestones}건` : nextMs ? `다음: ${nextMs.title} (${nextMs.days_left === 0 ? '오늘' : `D-${nextMs.days_left}`})` : n(w.milestones) ? '' : '등록된 마일스톤 없음' }))}
  </div>`;
};
const scopeCol = (g, p) => {
  const u = `/app/projects/${p.id}`; const r = g.requirements || {}; const k = g.kpis || {}; const c = g.changes || {};
  const unconfirmed = n(r.total) - n(r.confirmed);
  return html`<div class="ovcol"><h3>Scope</h3>
    ${raw(kv('Requirements', `${n(r.total)}건`, { href: `${u}/requirements`, sub: n(r.in_scope) ? `범위 내 ${r.in_scope}건` : '' }))}
    ${raw(kv('확정 Requirements', `${n(r.confirmed)}건`, { href: `${u}/requirements?status=CONFIRMED`, tone: unconfirmed && n(r.total) ? 'warn' : n(r.total) ? 'good' : '', sub: unconfirmed ? `미확정 ${unconfirmed}건` : '' }))}
    ${raw(kv('WBS 연결률', pv(k.requirement_coverage), { href: `${u}/requirements?view=trace`, tone: k.requirement_coverage === null || k.requirement_coverage === undefined ? '' : k.requirement_coverage < 100 ? 'warn' : 'good', sub: '범위 내 요구사항 중 WBS 연결 비율' }))}
    ${raw(kv('WBS 미연결 Requirement', `${n(r.in_scope_unlinked)}건`, { href: `${u}/requirements?scope=IN_SCOPE&link=unlinked`, tone: n(r.in_scope_unlinked) ? 'warn' : '' }))}
    ${raw(kv('Change', `${n(c.total)}건`, { href: `${u}/changes`, tone: n(c.under_review) || n(c.approved_unimplemented) ? 'warn' : '', sub: [n(c.under_review) ? `검토 중 ${c.under_review}` : '', n(c.approved_unimplemented) ? `승인 후 미반영 ${c.approved_unimplemented}` : ''].filter(Boolean).join(' · ') }))}
  </div>`;
};
const qualityCol = (g, p) => {
  const u = `/app/projects/${p.id}`; const t = g.tests || {}; const a = g.acceptances || {}; const k = g.kpis || {}; const is = g.issues || {}; const rs = g.risks || {};
  const passRate = n(t.executed) ? Math.round((n(t.last_pass) / n(t.executed)) * 100) : null; const risks = n(rs.open) + n(rs.monitoring);
  return html`<div class="ovcol"><h3>Quality</h3>
    ${raw(kv('Test Coverage', pv(k.test_coverage), { href: `${u}/tests?tab=coverage`, sub: n(t.total) ? `테스트 ${t.total}건` : '등록된 테스트 없음' }))}
    ${raw(kv('테스트 통과율', pv(passRate), { href: `${u}/tests?last_result=PASS`, tone: passRate === null ? '' : n(t.last_fail) ? 'crit' : 'good', sub: n(t.executed) ? `Pass ${n(t.last_pass)} · Fail ${n(t.last_fail)} / 실행 ${t.executed}` : '' }))}
    ${raw(kv('미해결 Issue', `${n(is.active)}건`, { href: `${u}/issues`, tone: n(is.active) ? 'crit' : '', sub: n(is.critical) ? `Critical ${is.critical}건` : '' }))}
    ${raw(kv('Risk', `${risks}건`, { href: `${u}/issues?tab=risks`, tone: n(rs.high_or_critical) ? 'crit' : '', sub: n(rs.high_or_critical) ? `High 이상 ${rs.high_or_critical}건` : '' }))}
    ${raw(kv('Acceptance', n(a.total) ? `${n(a.accepted)} / ${a.total} 승인` : '-', { href: `${u}/tests?tab=acceptance`, tone: n(a.rework) ? 'warn' : n(a.total) && n(a.accepted) === n(a.total) ? 'good' : '', sub: [n(a.requested) ? `요청 ${a.requested}` : '', n(a.rework) ? `보완 필요 ${a.rework}` : ''].filter(Boolean).join(' · ') }))}
  </div>`;
};

const healthLine = (h) => {
  if (!h) return '';
  return html`<details class="hline ${H_CLS[h.status]}" id="health" ${location.hash === '#health' ? 'open' : ''}><summary><span class="hline__l">Project Health</span><span class="hchip hchip--sm ${H_CLS[h.status]}">${h.status_label}</span>
      ${raw(Object.values(h.dimensions).map((d) => html`<span class="hline__d"><span>${d.label}</span><span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></span>`).join(''))}
      ${raw(h.partial_unknown ? '<small class="hline__note">일부 정보 부족</small>' : '')}<span class="hline__more">근거 보기</span></summary>
    <div class="hline__r">${raw(Object.values(h.dimensions).map((d) => html`<div><b>${d.label} <span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></b><ul>${raw(d.reasons.map((r) => html`<li>${r}</li>`).join(''))}${raw(d.hint ? html`<li class="dim">${d.hint}</li>` : '')}</ul></div>`).join(''))}</div>
  </details>`;
};

/* ---------- Upcoming / Activity ---------- */
const upcomingSection = (snap, pid) => {
  const all = snap.upcoming || []; const up = all.slice(0, 6);
  return html`<section class="ovsec ovup" aria-labelledby="upT"><div class="ovsec__h"><h2 id="upT">Upcoming</h2><small class="ovsec__ctx">7일 내 일정 · 마일스톤</small>${raw(up.length ? html`<em class="ovsec__n">${all.length}</em>` : '')}</div>
    ${raw(up.length ? html`<ol class="ovup__list">${raw(up.map((x) => html`<li><a href="/app/projects/${pid}/${x.href}" data-link><time>${fmtShort(x.date)}${x.date === todayLocal() ? ' 오늘' : ''}</time><span class="ovup__k">${x.label}</span><span class="ovup__t">${x.title}</span></a></li>`).join(''))}</ol>` : '<p class="ovnone">7일 내 예정된 일정이 없습니다.</p>')}
  </section>`;
};
const activitySection = (dash, pid) => {
  const ev = (dash.recent_changes || []).slice(0, 8);
  return html`<section class="ovsec ovact" aria-labelledby="acT"><div class="ovsec__h"><h2 id="acT">Activity</h2><small class="ovsec__ctx">최근 변경</small><button type="button" class="link linkbtn ovsec__more" id="act-all">전체 보기</button></div>
    ${raw(ev.length ? html`<ol class="ovact__list">${raw(ev.map((e) => html`<li><a href="/app/projects/${pid}/${e.href}" data-link><time title="${e.at}">${relTime(e.at)}</time><span class="ovact__w">${e.actor_name || '-'}</span><span class="ovact__t">${raw(e.display_id ? html`<span class="mono">${e.display_id}</span> ` : '')}${e.title}</span><small>${e.summary}</small></a></li>`).join(''))}</ol>` : '<p class="ovnone">아직 기록된 변경이 없습니다.</p>')}
  </section>`;
};

export async function overviewPage(id, main = $('#main')) {
  const [g, snap, dash] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/snapshot`)), api('GET', wsApi(`/${id}/dashboard`))]);
  const p = g.project;
  document.title = `Overview — ${p.name} — RELAI`;
  // Overview sub navigation (프로젝트 현황 · WBS · 주간보고 · 일정/마일스톤 · Project Health) lives in the LNB — nothing is duplicated here.
  main.innerHTML = html`<div class="page page--wide page--flow ov">
    ${raw(projectHead(p, g, { tab: location.hash === '#health' ? 'overview-health' : 'overview-main', title: '프로젝트 현황' }))}
    ${raw(p.status === 'ARCHIVED' ? '<div class="notice">보관된 프로젝트입니다. 현황은 조회만 할 수 있습니다.</div>' : '')}
    ${raw(progressSection(g, p))}
    ${raw(attentionSection(g, snap, p.id))}
    <section class="ovsec ovband" aria-label="Schedule · Scope · Quality">${raw(scheduleCol(g, p, dash))}${raw(scopeCol(g, p))}${raw(qualityCol(g, p))}</section>
    ${raw(healthLine(snap.health))}
    <div class="ov__row4">${raw(upcomingSection(snap, p.id))}${raw(activitySection(dash, p.id))}</div>
  </div>`;
  const aa = $('#act-all'); if (aa) aa.onclick = () => { const b = document.querySelector('.wsh__act [data-act="activity"]'); if (b) b.click(); };
  const more = $('#att-more');
  if (more) more.onclick = async () => { more.disabled = true; try { const all = await api('GET', wsApi(`/${id}/attention`)); const list = $('#att .ovatt__list'); if (list) list.outerHTML = attentionRows(all.items, p.id); more.remove(); } catch (e) { toast(e.message); more.disabled = false; } };
}
