/* Phase 9 Overview widgets: Project Health, Upcoming 7 Days, Weekly Report. Pure rendering — every rule lives in server/health.js / metrics.js. */
import { api, wsApi } from '../core/api.js';
import { $, fmtShort, html, raw, todayLocal } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { toast } from '../shared/dialogs.js';

const H_CLS = { GOOD: 'is-good', WARNING: 'is-warn', CRITICAL: 'is-crit', UNKNOWN: 'is-unknown' };

/** §10: one panel — overall status + 5 dimension rows; a row opens its reasons (click / keyboard), hover shows them as a title. */
export const healthPanel = (h) => {
  if (!h) return '';
  return html`<section class="panel health ${H_CLS[h.status]}" aria-labelledby="hT">
    <div class="health__top"><div class="panel__h" id="hT" style="border:0;padding:0">프로젝트 상태</div>
      <span class="hchip ${H_CLS[h.status]}">${h.status_label}</span>${raw(h.partial_unknown ? '<small class="health__partial">일부 정보 부족</small>' : '')}</div>
    <div class="health__dims">${raw(Object.values(h.dimensions).map((d) => html`<details class="hdim ${H_CLS[d.status]}" title="${d.reasons.join(' · ')}">
      <summary><span class="hdim__l">${d.label}</span><span class="hchip hchip--sm ${H_CLS[d.status]}">${d.status_label}</span></summary>
      <ul class="hdim__r">${raw(d.reasons.map((r) => html`<li>${r}</li>`).join(''))}${raw(d.hint ? html`<li class="hdim__hint">${d.hint}</li>` : '')}</ul></details>`).join(''))}</div>
  </section>`;
};

/** §13: dated events in the next 7 days, grouped by day. */
export const upcomingPanel = (items, p) => {
  const days = new Map(); for (const u of items || []) { if (!days.has(u.date)) days.set(u.date, []); days.get(u.date).push(u); }
  return html`<section class="panel up" aria-labelledby="upT"><div class="panel__h" id="upT">Upcoming 7 Days${raw(items?.length ? html`<em class="up__n">${items.length}</em>` : '')}</div>
    ${raw(days.size ? html`<ol class="up__list">${raw([...days].map(([d, rows]) => html`<li><time>${fmtShort(d)}${raw(d === todayLocal() ? '<small>오늘</small>' : '')}</time><div>${raw(rows.map((u) => html`<a href="/app/projects/${p.id}/${u.href}" data-link><span class="up__k is-${u.type.toLowerCase()}">${u.label}</span><span class="mono">${u.display_id}</span><span class="up__t">${u.title}</span></a>`).join(''))}</div></li>`).join(''))}</ol>`
      : '<div class="att__ok">앞으로 7일 안에 예정된 WBS 시작/종료, 마일스톤, 이슈 기한, 리스크 검토, 검수 기한이 없습니다.</div>')}
  </section>`;
};

/** §14/§29: generate CTA + recent reports. */
const RS = { DRAFT: ['Draft', 'chip--muted'], FINAL: ['Final', 'chip--done'] };
export const reportPanel = (reports, p, archived) => {
  const items = (reports?.items || []).slice(0, 5);
  return html`<section class="panel rep" aria-labelledby="rpT"><div class="panel__h" id="rpT">주간보고
      ${raw(archived ? '' : '<button class="btn btn--primary btn--sm" id="rep-new" style="margin-left:auto">주간보고 생성</button>')}</div>
    ${raw(items.length ? html`<ol class="rep__list">${raw(items.map((r) => html`<li><a href="/app/projects/${p.id}/reports/${r.id}" data-link>
        <span class="rep__p">${r.period_start.slice(5).replace('-', '/')} ~ ${r.period_end.slice(5).replace('-', '/')}</span><span class="rep__t">${r.title}</span><span class="chip ${RS[r.status][1]}">${RS[r.status][0]}</span></a></li>`).join(''))}</ol>`
      : '<div class="att__ok">아직 생성된 주간보고가 없습니다. 이번 주 데이터로 바로 만들 수 있습니다.</div>')}
  </section>`;
};

/** Period modal → POST generate → report page. */
export function bindReportPanel(p, reports, archived) {
  const b = $('#rep-new'); if (!b || archived) return;
  b.onclick = () => periodDialog(reports?.default_period, async (period) => {
    try { const r = await api('POST', wsApi(`/${p.id}/weekly-reports/generate`), period); navigate(`/app/projects/${p.id}/reports/${r.report.id}`); return true; }
    catch (e) { return e.fields || { period_end: e.message }; }
  });
}
export function periodDialog(def, onSubmit) {
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = html`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pdT"><h3 id="pdT">주간보고 생성</h3>
    <div class="dialog__b">보고 기간을 확인하세요. 기본값은 이번 주 월요일부터 오늘(주가 끝났으면 금요일)까지입니다. 기간 내 상태 변경, 테스트 실행, 승인·반영 이력을 기준으로 보고서를 만듭니다.</div>
    <div class="row2"><div class="field"><label for="pd-s">시작일</label><input class="input" type="date" id="pd-s" value="${def?.period_start || ''}"><div class="err" data-for="period_start"></div></div>
      <div class="field"><label for="pd-e">종료일</label><input class="input" type="date" id="pd-e" value="${def?.period_end || ''}"><div class="err" data-for="period_end"></div></div></div>
    <div class="actions"><button class="btn btn--secondary" data-v="0">취소</button><button class="btn btn--primary" data-v="1">생성</button></div></div>`;
  const done = () => el.remove();
  el.addEventListener('click', async (e) => {
    const bt = e.target.closest('[data-v]'); if (!bt) { if (e.target === el) done(); return; }
    if (bt.dataset.v === '0') return done();
    bt.disabled = true; el.querySelectorAll('.err').forEach((x) => { x.textContent = ''; });
    const r = await onSubmit({ period_start: $('#pd-s', el).value, period_end: $('#pd-e', el).value });
    if (r === true) return done();
    bt.disabled = false; for (const [k, v] of Object.entries(r || {})) { const x = el.querySelector(`[data-for="${k}"]`); if (x) x.textContent = v; else toast(v); }
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
  document.body.append(el); $('#pd-s', el).focus();
}
