import { api, wsApi } from '../core/api.js';
import { $, fmtDate, fmtShort, html, no2, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { moveToPhase, phaseStrip, projectHead, stepInfo } from './guide.js';
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
/** Compact per-area summary (F-4): two numbers per area, details live in each menu. */
const areaSummary = (g, p) => {
  const u = `/app/projects/${p.id}`;
  const n = (v) => (v === null || v === undefined ? '-' : v);
  const cards = [
    { label: 'Requirements', href: `${u}/requirements`, a: [n(g.requirements?.total), '전체'], b: [n(g.requirements?.in_scope_unlinked), 'WBS 미연결'], warn: g.requirements?.in_scope_unlinked },
    { label: 'WBS', href: `${u}/wbs`, a: [n(g.wbs?.total), '항목'], b: [n(g.wbs?.in_progress), '진행 중'] },
    { label: 'Changes', href: `${u}/changes`, a: [n(g.changes?.under_review), '검토 중'], b: [n(g.changes?.approved_unimplemented), '승인 후 미반영'], warn: g.changes?.under_review || g.changes?.approved_unimplemented },
    { label: 'Issues & Risks', href: `${u}/issues`, a: [n(g.issues?.active), 'Open Issue'], b: [n(g.risks?.high_or_critical), 'High+ Risk'], crit: g.issues?.critical || g.risks?.critical },
    { label: 'Tests', href: `${u}/tests`, a: [`${n(g.tests?.executed)}/${n(g.tests?.total)}`, '실행'], b: [n(g.tests?.last_fail), 'Fail'], crit: g.tests?.last_fail },
    { label: 'Acceptance', href: `${u}/tests?tab=acceptance`, a: [`${n(g.acceptances?.accepted)}/${n(g.acceptances?.total)}`, '승인'], b: [n(g.acceptances?.in_progress), '진행 중'], warn: g.acceptances?.rework },
  ];
  return html`<div class="areas">${raw(cards.map((c) => html`<a class="area ${c.crit ? 'is-crit' : c.warn ? 'is-warn' : ''}" href="${c.href}" data-link>
    <span class="area__l">${c.label}</span><div class="area__v"><div><b>${c.a[0]}</b><span>${c.a[1]}</span></div><div><b>${c.b[0]}</b><span>${c.b[1]}</span></div></div></a>`).join(''))}</div>`;
};

export async function overviewPage(id, main = $('#main')) {
  const [g, snap, reports] = await Promise.all([api('GET', wsApi(`/${id}`)), api('GET', wsApi(`/${id}/snapshot`)), api('GET', wsApi(`/${id}/weekly-reports`))]);
  const p = g.project;
  document.title = `${p.name} — RELAI`;
  const archived = p.status === 'ARCHIVED';
  const cur = g.current_phase;
  const open = cur.steps.filter((s) => s.status !== 'COMPLETED');
  const allDone = open.length === 0;
  main.innerHTML = html`<div class="page">
    ${raw(projectHead(p, g))}
    ${raw(archived ? '<div class="notice">보관된 프로젝트입니다. 단계와 할 일은 조회만 할 수 있습니다.</div>' : '')}
    ${raw(phaseStrip(g, p.id))}
    ${raw(healthPanel(snap.health))}

    <section class="panel guide" aria-labelledby="gT">
      <div class="guide__top"><span>현재 단계</span><em>${cur.progress.done} / ${cur.progress.total} 완료</em></div>
      <div class="guide__body">
        <h2 id="gT"><small>${no2(cur.sequence)}</small> ${cur.name}</h2>
        <p class="guide__desc">${cur.description}</p>
        <div class="pbar pbar--lg"><i style="width:${cur.progress.percent}%"></i></div>

        <h3 class="guide__h">지금 해야 할 일</h3>
        ${raw(allDone
          ? html`<div class="done-note"><b>현재 단계의 할 일을 모두 완료했습니다.</b>${raw(g.next_phase ? html`<span>다음 단계는 <b>${no2(g.next_phase.sequence)} ${g.next_phase.name}</b>입니다.</span>` : '<span>마지막 단계까지 완료했습니다.</span>')}</div>`
          : html`<ol class="nowl">${raw(open.map((s) => {
              const info = stepInfo(cur.phase_key, s.step_key, g, p.id);
              return html`<li class="nowl__row">
                <a class="nowl__t" href="/app/projects/${p.id}/phases/${cur.phase_key}#step-${s.id}" data-link>${s.title}</a>
                <div class="nowl__c">${info ? info.text : s.completion_criteria}${raw(info && info.trace ? html`<a class="nowl__trace" href="${info.trace.cta.href}" data-link>${info.trace.text} →</a>` : '')}</div>
                ${raw(info ? html`<a class="nowl__go" href="${info.cta.href}" data-link>${info.cta.label} →</a>` : '')}</li>`;
            }).join(''))}</ol>`)}
        <div class="actions">
          ${raw(archived ? '' : allDone && g.next_phase
            ? html`<button class="btn btn--primary btn--lg" id="next">다음 단계로 이동</button><a class="btn btn--secondary btn--lg" href="/app/projects/${p.id}/phases/${cur.phase_key}" data-link>단계 상세 보기</a>`
            : html`<a class="btn btn--primary btn--lg" href="/app/projects/${p.id}/phases/${cur.phase_key}" data-link>${allDone ? '단계 상세 보기' : '할 일 진행하기'}</a>${raw(g.next_phase ? '<button class="btn btn--secondary btn--lg" id="next">다음 단계로 이동</button>' : '')}`)}
        </div>
      </div></section>

    ${raw(attentionPanel(snap, p))}
    <div class="grid2 grid2--dash">
      ${raw(upcomingPanel(snap.upcoming, p))}
      ${raw(reportPanel(reports, p, archived))}
    </div>
    ${raw(areaSummary(g, p))}
    <div class="grid2">
      <div class="panel"><div class="panel__h">기본 정보
        ${raw(archived ? '' : `<a class="link" style="font-size:14px" href="/app/projects/${p.id}/edit" data-link>수정</a>`)}</div>
        <div class="panel__b"><dl class="info">
          <dt>프로젝트 유형</dt><dd>${TYPE[p.project_type]}</dd>
          <dt>현재 상황</dt><dd>${SITUATION[p.current_situation]}</dd>
          <dt>예상 기간</dt><dd>${fmtDate(p.planned_start_date)} – ${fmtDate(p.planned_end_date)}</dd>
          <dt>설명</dt><dd>${p.description || '-'}</dd></dl>
          ${raw(archived ? '' : '<div class="actions"><button class="btn btn--danger btn--sm" id="archive">프로젝트 보관</button></div>')}</div></div>
      <div class="panel"><div class="panel__h">단계 이력</div>
        <div class="panel__b"><ol class="hist">${raw(g.history.slice().reverse().slice(0, 6).map((h) => html`<li><time>${fmtShort(h.changed_at)}</time>
          <span>${h.reason === 'PROJECT_CREATED' ? '프로젝트 생성 · 현재 단계: ' + h.to_name : `${h.from_name} → ${h.to_name}`}</span></li>`).join(''))}</ol></div></div>
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
