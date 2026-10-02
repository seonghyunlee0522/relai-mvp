import { api, wsApi } from '../core/api.js';
import { $, fmtDate, fmtShort, html, no2, raw, todayLocal } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { moveToPhase, projectHead, stepInfo } from './guide.js';
import { SITUATION, TYPE } from '../shared/constants.js';
import { confirmDialog, toast } from '../shared/dialogs.js';
import { healthPanel, upcomingPanel, reportPanel, bindReportPanel } from './dashboard.js';

/** "지금 확인 필요" (§11–12): priority-ordered rows from the snapshot; top 7 shown, "모두 보기" loads the rest in place. */
const ATT_TYPE = { ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', CHANGE: 'Change', WBS: 'WBS', ACCEPTANCE: 'Acceptance', REQUIREMENT: 'Requirement' };
const attentionRows = (items, p) => html`<ol class="att__list">${raw(items.map((i) => html`<li><a href="/app/projects/${p.id}/${i.href}" data-link>
    <i class="att__dot is-${i.severity}"></i><span class="mono">${i.display_id}</span><span class="att__t">${i.title}</span><small>${i.meta}</small><span class="att__k">${ATT_TYPE[i.type] || i.type}</span></a></li>`).join(''))}</ol>`;
const attentionPanel = (snap, p) => {
  const items = snap.attention || []; const total = snap.attention_total || items.length;
  return html`<section class="panel att ${items.some((i) => i.severity === 'crit') ? 'att--crit' : ''}" aria-labelledby="attT" id="att">
    <div class="panel__h" id="attT">지금 확인 필요${raw(total ? html`<em class="att__n">${total}</em>` : '')}
      ${raw(total > items.length ? html`<button class="link att__more" id="att-more" style="margin-left:auto;font-size:13px">모두 보기 (${total}) →</button>` : '')}</div>
    ${raw(items.length ? attentionRows(items, p)
      : '<div class="att__ok">지금 바로 확인해야 할 경고가 없습니다. Critical Issue, Fail 테스트, 승인 후 미반영 변경, 기한이 지난 작업이 생기면 여기에 표시됩니다.</div>')}
  </section>`;
};
const ENT = { REQUIREMENT: 'REQ', WBS: 'WBS', CHANGE: 'CR', ISSUE: 'Issue', RISK: 'Risk', TEST: 'Test', ACCEPTANCE: 'Acc.', PHASE: '단계' };
const dayMs = 86400000;
const fmtAt = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${no2(d.getDate())} ${no2(d.getHours())}:${no2(d.getMinutes())}`; };

/** Timeline + milestones on one shared date axis (top-level phases and summary rows). */
const timelinePanel = (dash, p) => {
  const rows = (dash.timeline || []).filter((r) => r.start && r.end && r.depth <= 1).slice(0, 10);
  const ms = (dash.milestones || []).filter((m) => m.milestone_date);
  const all = [...rows.flatMap((r) => [r.start, r.end]), ...ms.map((m) => m.milestone_date)].sort();
  if (!all.length) return html`<section class="dpanel"><div class="dpanel__h">일정 타임라인<a class="link" href="/app/projects/${p.id}/wbs?view=gantt" data-link>Gantt 보기 →</a></div><div class="dempty">일정이 입력된 WBS가 없습니다. WBS에서 시작일/종료일을 입력하면 여기에 표시됩니다.</div></section>`;
  const t = (d) => new Date(d + 'T00:00:00').getTime();
  const today = todayLocal();
  const lo = Math.min(t(all[0]), t(today)) - 3 * dayMs; const hi = Math.max(t(all[all.length - 1]), t(today)) + 3 * dayMs; const span = hi - lo;
  const pct = (d) => ((t(d) - lo) / span) * 100;
  const axis = [0, 1, 2, 3, 4].map((i) => new Date(lo + (span * i) / 4)).map((d) => `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`);
  return html`<section class="dpanel"><div class="dpanel__h">일정 타임라인<em>${rows.length}</em><a class="link" href="/app/projects/${p.id}/wbs?view=gantt" data-link>Gantt 보기 →</a></div>
    <div class="tl"><div class="tl__axis">${raw(axis.map((a) => `<span>${a}</span>`).join(''))}</div>
      <div class="tl__rows">
        <div class="tl__today" style="left:calc(150px + 8px + (100% - 158px) * ${(pct(today) / 100).toFixed(4)})" title="오늘"></div>
        ${raw(rows.map((r) => html`<div class="tl__row"><span class="tl__l" title="${r.title}"><small>${r.wbs_code}</small>${r.title}</span><div class="tl__t"><a class="tl__bar ${r.status === 'COMPLETED' ? 'is-done' : ''}" href="/app/projects/${p.id}/wbs?sel=${r.id}" data-link style="left:${pct(r.start).toFixed(2)}%;width:${Math.max(0.8, pct(r.end) - pct(r.start)).toFixed(2)}%" title="${r.start} – ${r.end} · ${r.progress}%"><i style="width:${r.progress}%"></i></a></div></div>`).join(''))}
        ${raw(ms.length ? html`<div class="tl__row"><span class="tl__l"><small>◆</small>마일스톤</span><div class="tl__t">${raw(ms.map((m) => html`<a class="tl__ms ${m.status === 'COMPLETED' ? 'is-done' : ''}" href="/app/projects/${p.id}/wbs?sel=${m.id}" data-link style="left:${pct(m.milestone_date).toFixed(2)}%" title="${m.title} · ${m.milestone_date}"></a>`).join(''))}</div></div>` : '')}
      </div></div></section>`;
};

const milestonePanel = (dash, p) => {
  const ms = (dash.milestones || []).slice(0, 6);
  return html`<section class="dpanel"><div class="dpanel__h">마일스톤<em>${(dash.milestones || []).length}</em><a class="link" href="/app/projects/${p.id}/wbs" data-link>WBS →</a></div>
    ${raw(ms.length ? html`<ul class="dlist">${raw(ms.map((m) => html`<li><a href="/app/projects/${p.id}/wbs?sel=${m.id}" data-link><span class="dl__t">◆ ${m.title}</span><span class="dl__m">${m.milestone_date ? fmtShort(m.milestone_date) : '-'}</span></a>${raw(m.status === 'COMPLETED' ? '<span class="chip chip--done">완료</span>' : m.days_left < 0 ? html`<span class="dl__late">D+${-m.days_left}</span>` : m.days_left === 0 ? '<span class="dl__late">오늘</span>' : html`<span class="dl__m">D-${m.days_left}</span>`)}</li>`).join(''))}</ul>` : '<div class="dempty">등록된 마일스톤이 없습니다.</div>')}</section>`;
};

const overduePanel = (dash, p) => {
  const rows = dash.overdue_tasks || []; const total = dash.tasks.delayed;
  return html`<section class="dpanel"><div class="dpanel__h">지연 Task<em>${total}</em>${raw(total ? html`<a class="link" href="/app/projects/${p.id}/wbs?f=overdue" data-link>전체 ${total}건 →</a>` : '')}</div>
    ${raw(rows.length ? html`<ul class="dlist">${raw(rows.slice(0, 8).map((r) => html`<li><a href="/app/projects/${p.id}/wbs?sel=${r.id}" data-link><span class="mono dl__m">${r.wbs_code}</span><span class="dl__t">${r.title}</span><span class="dl__m">${r.owner_name || '미지정'}</span></a><span class="dl__late">+${r.days_overdue}일</span></li>`).join(''))}</ul>` : '<div class="dempty">기한이 지난 미완료 작업이 없습니다.</div>')}</section>`;
};

const workloadPanel = (dash, p) => {
  const rows = (dash.workload || []).slice(0, 8); const max = Math.max(1, ...rows.map((r) => r.tasks));
  return html`<section class="dpanel"><div class="dpanel__h">담당자별 업무량<em>${(dash.workload || []).length}</em></div>
    ${raw(rows.length ? rows.map((r) => html`<div class="wl" title="전체 ${r.tasks} · 완료 ${r.completed} · 진행 ${r.in_progress} · 지연 ${r.overdue}"><span class="wl__n">${r.owner_name}</span>
      <div class="wl__bar" style="width:${Math.max(6, (r.tasks / max) * 100)}%"><i class="d" style="width:${(r.completed / r.tasks) * 100}%"></i><i class="p" style="width:${(r.in_progress / r.tasks) * 100}%"></i><i class="l" style="width:${Math.min(100, (r.overdue / r.tasks) * 100)}%"></i></div>
      <span class="wl__m">${r.tasks}건${raw(r.overdue ? html` · <b style="color:#B42318">지연 ${r.overdue}</b>` : '')}</span></div>`).join('') : '<div class="dempty">담당자가 지정된 작업이 없습니다.</div>')}
    <div class="dempty" style="padding-top:2px;font-size:11.5px">■ 완료 <span style="color:var(--blue)">■</span> 진행 중 <span style="color:#DC3545">■</span> 지연</div></section>`;
};

const recentPanel = (dash, p) => {
  const rows = (dash.recent_changes || []).slice(0, 8);
  return html`<section class="dpanel"><div class="dpanel__h">최근 변경</div>
    ${raw(rows.length ? html`<ul class="dlist">${raw(rows.map((r) => html`<li><a href="/app/projects/${p.id}/${r.href}" data-link><span class="chip chip--muted">${ENT[r.entity_type] || r.entity_type}</span><span class="dl__t" title="${r.summary}">${r.display_id ? r.display_id + ' ' : ''}${r.summary}</span><span class="dl__m">${r.actor_name || ''}</span></a><span class="dl__m">${fmtAt(r.at)}</span></li>`).join(''))}</ul>` : '<div class="dempty">아직 변경 이력이 없습니다.</div>')}</section>`;
};

export async function overviewPage(id, main = $('#main')) {
  const [g, snap, reports, dash] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/snapshot`)), api('GET', wsApi(`/${id}/weekly-reports`)), api('GET', wsApi(`/${id}/dashboard`))]);
  const p = g.project;
  document.title = `${p.name} — RELAI`;
  const archived = p.status === 'ARCHIVED';
  const cur = g.current_phase;
  const open = cur.steps.filter((s) => s.status !== 'COMPLETED');
  const allDone = open.length === 0;
  const u = `/app/projects/${p.id}`;
  const prog = g.wbs && g.wbs.total ? g.wbs.progress : p.progress;
  const t = dash.tasks;
  const kpi = (label, value, sub, href, tone = '') => html`<a class="${tone}" href="${href}" data-link><span>${label}</span><b>${value}</b><small>${sub}</small></a>`;
  main.innerHTML = html`<div class="page page--wide page--flow">
    ${raw(projectHead(p, g, { tab: 'overview' }))}
    ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 단계와 할 일은 조회만 할 수 있습니다.</div>' : '')}
    <div class="dkpi">
      <a href="${u}/wbs" data-link><span>전체 진행률</span><b>${prog}%</b><div class="pbar"><i style="width:${prog}%"></i></div></a>
      ${raw(kpi('전체 Task', t.total.toLocaleString('ko-KR'), `진행 중 ${t.in_progress} · 완료 ${t.completed}`, `${u}/wbs`))}
      ${raw(kpi('지연 Task', t.delayed.toLocaleString('ko-KR'), t.delayed ? '기한 초과 · 바로 확인' : '지연 없음', `${u}/wbs?f=overdue`, t.delayed ? 'is-crit' : ''))}
      ${raw(kpi('미처리 요구사항', dash.requirements.unconfirmed.toLocaleString('ko-KR'), `미확정 · WBS 미연결 ${dash.requirements.unlinked_in_scope}`, `${u}/requirements?status=DRAFT,REVIEWING`, dash.requirements.unlinked_in_scope ? 'is-warn' : ''))}
      ${raw(kpi('주요 이슈', dash.issues.critical_or_high, `Open ${dash.issues.open} · High 이상`, `${u}/issues`, dash.issues.critical_or_high ? 'is-crit' : ''))}
    </div>
    <div class="dgrid3"><div>${raw(timelinePanel(dash, p))}</div><div class="dcol">${raw(milestonePanel(dash, p))}${raw(upcomingPanel(snap.upcoming, p))}</div></div>
    <div class="dgrid3 dgrid3--3">${raw(overduePanel(dash, p))}${raw(workloadPanel(dash, p))}${raw(recentPanel(dash, p))}</div>
    <div class="dgrid3 dgrid3--3">${raw(attentionPanel(snap, p))}${raw(healthPanel(snap.health))}${raw(reportPanel(reports, p, archived))}</div>

    <section class="dpanel dguide dash-sec" style="margin-top:10px"><div class="dpanel__h"><span><small class="mono">${no2(cur.sequence)}</small> 현재 단계 · ${cur.name}</span><em>${cur.progress.done} / ${cur.progress.total}</em>
      <span style="margin-left:auto;display:flex;gap:6px">${raw(archived ? '' : allDone && g.next_phase
        ? html`<button class="btn btn--primary btn--sm" id="next">다음 단계로 이동</button><a class="btn btn--secondary btn--sm" href="${u}/phases/${cur.phase_key}" data-link>단계 상세</a>`
        : html`<a class="btn btn--primary btn--sm" href="${u}/phases/${cur.phase_key}" data-link>${allDone ? '단계 상세' : '할 일 진행하기'}</a>${raw(g.next_phase ? '<button class="btn btn--secondary btn--sm" id="next">다음 단계로 이동</button>' : '')}`)}</span></div>
      ${raw(allDone
        ? html`<div class="dempty"><b>현재 단계의 할 일을 모두 완료했습니다.</b> ${raw(g.next_phase ? html`다음 단계는 <b>${no2(g.next_phase.sequence)} ${g.next_phase.name}</b>입니다.` : '마지막 단계까지 완료했습니다.')}</div>`
        : html`<ol class="nowl">${raw(open.map((s) => {
            const info = stepInfo(cur.phase_key, s.step_key, g, p.id);
            return html`<li class="nowl__row"><a class="nowl__t" href="${u}/phases/${cur.phase_key}#step-${s.id}" data-link>${s.title}</a>
              <div class="nowl__c">${info ? info.text : s.completion_criteria}${raw(info && info.trace ? html`<a class="nowl__trace" href="${info.trace.cta.href}" data-link>${info.trace.text} →</a>` : '')}</div>
              ${raw(info ? html`<a class="nowl__go" href="${info.cta.href}" data-link>${info.cta.label} →</a>` : '')}</li>`;
          }).join(''))}</ol>`)}</section>

    <div class="dgrid3">
      <section class="dpanel"><div class="dpanel__h">기본 정보${raw(archived ? '' : `<a class="link" href="${u}/edit" data-link>수정</a>`)}</div>
        <div class="dpanel__b"><dl class="info">
          <dt>프로젝트 유형</dt><dd>${TYPE[p.project_type]}</dd>
          <dt>현재 상황</dt><dd>${SITUATION[p.current_situation]}</dd>
          <dt>예상 기간</dt><dd>${fmtDate(p.planned_start_date)} – ${fmtDate(p.planned_end_date)}</dd>
          <dt>설명</dt><dd>${p.description || '-'}</dd></dl>
          ${raw(archived ? '' : '<div class="actions"><button class="btn btn--danger btn--sm" id="archive">프로젝트 보관</button></div>')}</div></section>
      <section class="dpanel"><div class="dpanel__h">단계 이력</div>
        <div class="dpanel__b"><ol class="hist">${raw(g.history.slice().reverse().slice(0, 6).map((h) => html`<li><time>${fmtShort(h.changed_at)}</time>
          <span>${h.reason === 'PROJECT_CREATED' ? '프로젝트 생성 · 현재 단계: ' + h.to_name : `${h.from_name} → ${h.to_name}`}</span></li>`).join(''))}</ol></div></section>
    </div>
  </div>`;
  bindReportPanel(p, reports, archived);
  const more = $('#att-more');
  if (more) more.onclick = async () => { more.disabled = true; try { const all = await api('GET', wsApi(`/${id}/attention`)); $('#att').innerHTML = html`<div class="panel__h">지금 확인 필요<em class="att__n">${all.total}</em></div>${raw(attentionRows(all.items, p))}`; } catch (e) { toast(e.message); more.disabled = false; } };
  const nb = $('#next');
  if (nb) nb.onclick = async () => { if (await moveToPhase(p.id, g, g.next_phase, { next: true })) overviewPage(id); };
  const ab = $('#archive');
  if (ab) ab.onclick = async () => {
    if (!(await confirmDialog({ title: '프로젝트를 보관할까요?', body: '보관한 프로젝트는 목록에서 숨겨지고 더 이상 수정할 수 없습니다. 데이터는 삭제되지 않습니다.', confirm: '보관하기', danger: true }))) return;
    try { await api('POST', wsApi(`/${id}/archive`), {}); toast('프로젝트를 보관했습니다.'); navigate('/app/projects'); }
    catch (e) { toast(e.message); }
  };
}
