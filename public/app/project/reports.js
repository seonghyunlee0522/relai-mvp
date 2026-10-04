/* Weekly reports list (Overview > 주간보고 · PROJECT MANAGEMENT > Reports). Scope (Lifecycle V2 §20): list · generate · open.
 * Generation uses the existing weekly-report builder (server/reports.js: WBS/Changes/Issues/Tests history for the period);
 * no AI draft is produced here. */
import { api, wsApi } from '../core/api.js';
import { $, fmtDT, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { toast } from '../shared/dialogs.js';
import { emptyState } from '../shared/empty-state.js';
import { periodDialog } from './dashboard.js';
import { projectHead } from './guide.js';

const RS = { DRAFT: ['초안', 'chip--muted'], FINAL: ['확정', 'chip--done'] };

export async function reportsPage(pid, main = $('#main')) {
  const [g, data] = await Promise.all([api('GET', wsApi(`/${pid}`)), api('GET', wsApi(`/${pid}/weekly-reports`))]);
  const p = g.project; const archived = p.status === 'ARCHIVED';
  document.title = `주간보고 — ${p.name} — RELAI`;
  const items = data.items || [];
  const generate = () => periodDialog(data.default_period, async (period) => {
    try { const r = await api('POST', wsApi(`/${pid}/weekly-reports/generate`), period); toast('주간보고 초안을 만들었습니다.'); navigate(`/app/projects/${pid}/reports/${r.report.id}`); return true; }
    catch (e) { return e.fields || { period_end: e.message }; }
  });
  main.innerHTML = html`<div class="page page--wide page--flow">
    ${raw(projectHead(p, g, { tab: 'overview-reports', title: '주간보고' }))}
    <section class="ovsec rpl" aria-labelledby="rplT">
      <div class="ovsec__h"><h2 id="rplT">주간보고</h2><small class="ovsec__ctx">보고 기간의 WBS · 변경 · Issue · 테스트 이력을 모아 초안을 만들고, 편집 후 확정합니다.</small>
        ${raw(archived ? '' : '<button type="button" class="btn btn--primary btn--sm rpl__new" id="rp-new">주간보고 생성</button>')}</div>
      ${raw(items.length ? html`<table class="rtable rpl__t"><thead><tr><th>보고 기간</th><th>제목</th><th>상태</th><th>생성</th><th>확정</th></tr></thead><tbody>
        ${raw(items.map((r) => html`<tr><td class="mono"><a class="link" href="/app/projects/${pid}/reports/${r.id}" data-link>${r.period_start} ~ ${r.period_end}</a></td><td><a href="/app/projects/${pid}/reports/${r.id}" data-link>${r.title}</a></td><td><span class="chip ${RS[r.status][1]}">${RS[r.status][0]}</span></td><td class="dim">${fmtDT(r.generated_at)}</td><td class="dim">${r.finalized_at ? fmtDT(r.finalized_at) : '-'}</td></tr>`).join(''))}
      </tbody></table>` : emptyState({ title: '아직 생성된 주간보고가 없습니다.', body: '보고 기간을 정하면 그 기간의 진행사항·완료 Task·Issue·Risk·변경 요청을 모아 편집 가능한 초안을 만듭니다.', cta: archived ? null : { id: 'rp-new2', label: '주간보고 생성' }, small: true }))}
    </section>
  </div>`;
  const b1 = $('#rp-new'); if (b1) b1.onclick = generate;
  const b2 = $('#rp-new2'); if (b2) b2.onclick = generate;
}
