/* Project Overview — Execution Workspace home, not a BI dashboard.
 * Order of importance: Current Stage (what to do now) → Attention Needed (exceptions only) → Project Summary (one compact bar).
 * Timeline/workload/history/reports live in their own screens or behind header actions (Activity, 보고서, ⋯). */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, no2, raw, todayLocal } from '../core/dom.js';
import { moveToPhase, projectHead, stepInfo } from './guide.js';
import { toast } from '../shared/dialogs.js';

const ATT_TYPE = { ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', CHANGE: 'Change', WBS: 'WBS', ACCEPTANCE: 'Acceptance', REQUIREMENT: 'Requirement' };
const H_CLS = { GOOD: 'is-good', WARNING: 'is-warn', CRITICAL: 'is-crit', UNKNOWN: 'is-unknown' };

const attentionRows = (items, pid) => html`<ol class="ovatt__list">${raw(items.map((i) => html`<li><a href="/app/projects/${pid}/${i.href}" data-link>
  <i class="att__dot is-${i.severity}"></i><span class="ovatt__k">${ATT_TYPE[i.type] || i.type}</span><span class="mono">${i.display_id}</span><span class="ovatt__t">${i.title}</span><small>${i.meta}</small></a></li>`).join(''))}</ol>`;

/** Current Stage: the checklist of the current phase, checkable in place. */
const stagePanel = (g, p, archived) => {
  const cur = g.current_phase; const u = `/app/projects/${p.id}`;
  const done = cur.progress.done; const total = cur.progress.total; const allDone = done === total;
  const open = cur.steps.filter((s) => s.status !== 'COMPLETED');
  return html`<section class="stage" aria-labelledby="stT">
    <div class="stage__h">
      <div class="stage__t"><span class="stage__no mono">${no2(cur.sequence)}</span><h2 id="stT">${cur.name}</h2><span class="stage__cur">현재 단계</span></div>
      <div class="stage__p"><b>${done} / ${total}</b><span class="pbar"><i style="width:${cur.progress.percent}%"></i></span></div>
    </div>
    <p class="stage__d">${cur.description}</p>
    <ol class="stage__list">${raw(cur.steps.map((s) => {
      const isDone = s.status === 'COMPLETED';
      const info = stepInfo(cur.phase_key, s.step_key, g, p.id);
      return html`<li class="${isDone ? 'is-done' : ''} ${!isDone && open[0] && open[0].id === s.id ? 'is-next' : ''}">
        <label class="stage__ck"><input type="checkbox" data-step="${s.id}" ${isDone ? 'checked' : ''} ${archived ? 'disabled' : ''} aria-label="${s.title} 완료"><span></span></label>
        <a class="stage__st" href="${u}/phases/${cur.phase_key}#step-${s.id}" data-link>${s.title}</a>
        <span class="stage__info ${info && !info.ok && !isDone ? 'is-warn' : ''}">${info ? info.text : s.completion_criteria}</span>
        ${raw(info && !isDone ? html`<a class="stage__go" href="${info.cta.href}" data-link>${info.cta.label}</a>` : '<span></span>')}
      </li>`;
    }).join(''))}</ol>
    <div class="stage__f">
      ${raw(allDone ? html`<span class="stage__msg"><b>현재 단계의 할 일을 모두 완료했습니다.</b> ${g.next_phase ? `다음 단계: ${no2(g.next_phase.sequence)} ${g.next_phase.name}` : '마지막 단계입니다.'}</span>`
        : html`<span class="stage__msg">다음 할 일 <b>${open[0].title}</b></span>`)}
      <span class="stage__btns">${raw(archived ? '' : html`
        <a class="btn ${allDone ? 'btn--secondary' : 'btn--primary'} btn--sm" href="${u}/phases/${cur.phase_key}" data-link>${allDone ? '단계 상세' : '할 일 진행하기'}</a>
        ${raw(g.next_phase ? html`<button class="btn ${allDone ? 'btn--primary' : 'btn--secondary'} btn--sm" id="next">다음 단계로 이동</button>` : '')}`)}</span>
    </div>
  </section>`;
};

/** Attention Needed: exceptions only; one line when there is nothing. Upcoming 7 days rides along only when it has rows. */
const attentionPanel = (snap, pid) => {
  const items = snap.attention || []; const total = snap.attention_total || items.length;
  const up = (snap.upcoming || []).slice(0, 5);
  return html`<aside class="ovside">
    <section class="ovatt ${items.some((i) => i.severity === 'crit') ? 'is-crit' : ''}" id="att" aria-labelledby="attT">
      <div class="ovh"><b id="attT">확인 필요</b>${raw(total ? html`<em class="ovh__n">${total}</em>` : '')}
        ${raw(total > items.length ? html`<button type="button" class="link ovh__more" id="att-more">모두 보기</button>` : '')}</div>
      ${raw(items.length ? attentionRows(items, pid) : '<p class="ovnone">현재 즉시 확인해야 할 항목이 없습니다.</p>')}
    </section>
    ${raw(up.length ? html`<section class="ovup" aria-labelledby="upT"><div class="ovh"><b id="upT">7일 내 일정</b><em class="ovh__n">${(snap.upcoming || []).length}</em></div>
      <ol class="ovup__list">${raw(up.map((x) => html`<li><a href="/app/projects/${pid}/${x.href}" data-link><time>${fmtShort(x.date)}${x.date === todayLocal() ? ' 오늘' : ''}</time><span class="ovup__k">${x.label}</span><span class="ovup__t">${x.title}</span></a></li>`).join(''))}</ol></section>` : '')}
  </aside>`;
};

/** Project Summary: one compact bar of area status; only exceptions get color. Each item opens its working screen. */
const summaryBar = (g, dash, p) => {
  const u = `/app/projects/${p.id}`; const t = dash.tasks; const rq = dash.requirements;
  const is = g.issues || {}; const rs = g.risks || {}; const ch = g.changes || {}; const ts = g.tests || {};
  const ms = (dash.milestones || []).find((m) => m.status !== 'COMPLETED' && m.milestone_date);
  const prog = g.wbs && g.wbs.total ? g.wbs.progress : 0;
  const item = (href, label, value, ex = [], title = '') => html`<a class="sumbar__i" href="${href}" data-link title="${title}"><span>${label}</span><b>${value}</b>${raw(ex.filter((e) => e && e.n).map((e) => html`<em class="${e.tone}">${e.label} ${e.n}</em>`).join(''))}</a>`;
  const items = [
    item(`${u}/wbs`, '진행률', `${prog}%`, [], 'WBS 진행률'),
    item(`${u}/wbs`, 'Task', t.total, [{ n: t.delayed, label: '지연', tone: 'is-crit' }]),
    item(`${u}/requirements`, '요구사항', rq.total, [{ n: rq.unconfirmed, label: '미확정', tone: 'is-warn' }, { n: rq.unlinked_in_scope, label: 'WBS 미연결', tone: 'is-warn' }]),
    item(`${u}/issues`, 'Issue', is.active ?? 0, [{ n: is.critical, label: 'Critical', tone: 'is-crit' }, { n: is.overdue, label: '지연', tone: 'is-warn' }]),
    item(`${u}/issues?tab=risks`, 'Risk', rs.open !== undefined ? rs.open + (rs.monitoring || 0) : 0, [{ n: rs.high_or_critical, label: 'High+', tone: 'is-warn' }]),
    item(`${u}/changes`, '변경', ch.total ?? 0, [{ n: ch.under_review, label: '검토', tone: 'is-warn' }, { n: ch.approved_unimplemented, label: '미반영', tone: 'is-warn' }]),
    item(`${u}/tests`, 'Test', ts.total ? `${ts.last_pass}/${ts.total} Pass` : 0, [{ n: ts.last_fail, label: 'Fail', tone: 'is-crit' }]),
  ];
  if (ms) {
    const d = ms.days_left < 0 ? `D+${-ms.days_left}` : ms.days_left === 0 ? '오늘' : `D-${ms.days_left}`;
    items.push(html`<a class="sumbar__i" href="${u}/wbs?sel=${ms.id}" data-link><span>다음 마일스톤</span><b>${ms.title}</b><em class="${ms.days_left < 0 ? 'is-crit' : 'is-plain'}">${d}</em></a>`);
  }
  return html`<nav class="sumbar" aria-label="프로젝트 요약">${raw(items.join(''))}</nav>`;
};

/** Health: one line of five chips; opening it shows the reasons per dimension. */
const healthLine = (h) => {
  if (!h) return '';
  return html`<details class="hline ${H_CLS[h.status]}"><summary><span class="hline__l">프로젝트 상태</span><span class="hchip hchip--sm ${H_CLS[h.status]}">${h.status_label}</span>
      ${raw(Object.values(h.dimensions).map((d) => html`<span class="hline__d"><span>${d.label}</span><span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></span>`).join(''))}
      ${raw(h.partial_unknown ? '<small class="hline__note">일부 정보 부족</small>' : '')}<span class="hline__more">근거 보기</span></summary>
    <div class="hline__r">${raw(Object.values(h.dimensions).map((d) => html`<div><b>${d.label} <span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></b><ul>${raw(d.reasons.map((r) => html`<li>${r}</li>`).join(''))}${raw(d.hint ? html`<li class="dim">${d.hint}</li>` : '')}</ul></div>`).join(''))}</div>
  </details>`;
};

export async function overviewPage(id, main = $('#main')) {
  let [g, snap, dash] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/snapshot`)), api('GET', wsApi(`/${id}/dashboard`))]);
  const p = g.project;
  document.title = `${p.name} — RELAI`;
  const archived = p.status === 'ARCHIVED';
  const draw = () => {
    main.innerHTML = html`<div class="page page--wide page--flow ov">
      ${raw(projectHead(p, g, { tab: 'overview' }))}
      ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 단계와 할 일은 조회만 할 수 있습니다.</div>' : '')}
      <div class="ov__grid">${raw(stagePanel(g, p, archived))}${raw(attentionPanel(snap, p.id))}</div>
      <div class="ov__sum">${raw(summaryBar(g, dash, p))}${raw(healthLine(snap.health))}</div>
    </div>`;
    bind();
  };
  const bind = () => {
    const more = $('#att-more');
    if (more) more.onclick = async () => { more.disabled = true; try { const all = await api('GET', wsApi(`/${id}/attention`)); const list = $('#att .ovatt__list'); if (list) list.outerHTML = attentionRows(all.items, p.id); more.remove(); } catch (e) { toast(e.message); more.disabled = false; } };
    const nb = $('#next');
    if (nb) nb.onclick = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) overviewPage(id); };
    main.querySelectorAll('[data-step]').forEach((cb) => cb.onchange = async () => {
      cb.disabled = true;
      try {
        g = await api('PATCH', wsApi(`/${id}/steps/${cb.dataset.step}`), { status: cb.checked ? 'COMPLETED' : 'TODO' });
        snap = await api('GET', wsApi(`/${id}/snapshot`));
        draw();
      } catch (e) { toast(e.message); cb.checked = !cb.checked; cb.disabled = false; }
    });
  };
  draw();
}
