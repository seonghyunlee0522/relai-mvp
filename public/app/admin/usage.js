/* Usage: every workspace against plan limits, sortable by the dimension that matters today. ≥80 % subtle warning, ≥90 % attention. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { adminApi, bindFilters, bindPager, bindRows, chip, errorBlock, head, n, pager, qs, rel, sel, table } from './ui.js';

const cell = (d) => html`<span class="auv ${d.pct === null ? '' : d.pct >= 90 ? 'is-bad' : d.pct >= 80 ? 'is-warn' : ''}"><b>${n(d.used)}</b><small>/ ${d.limit === null ? '∞' : n(d.limit)}</small>${raw(d.pct === null ? '' : html`<i style="width:${Math.min(100, d.pct)}%"></i>`)}</span>`;

export async function adminUsagePage(main = $('#main')) {
  document.title = 'Usage — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('usage', { q: q.q, sort: q.sort, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    const dim = (r, k) => r.dims.find((x) => x.key === k);
    main.innerHTML = html`<div class="apage">${raw(head('Usage', html`<span class="hint">Free 한도: Projects ${d.plans.FREE.limits.projects} · Members ${d.plans.FREE.limits.members} · Requirements ${d.plans.FREE.limits.requirements} · WBS ${d.plans.FREE.limits.wbs} · 주간보고 ${d.plans.FREE.limits.weekly_reports}/월</span>`))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="Workspace 검색" value="${q.q || ''}">
        ${raw(sel('sort', '정렬: Projects 사용률', { requirements: '정렬: Requirements 사용률', wbs: '정렬: WBS 사용률', activity: '정렬: 최근 활동' }, q.sort))}</div>
      ${raw(table([
        { key: 'name', label: 'Workspace', w: 240, cls: 'ttl', render: (r) => html`${r.name}${raw(r.status !== 'ACTIVE' ? ' ' + chip(r.status) : '')}` }, { key: 'plan_label', label: 'Plan', w: 70 },
        { key: 'projects', label: 'Projects', w: 130, render: (r) => cell(dim(r, 'projects')) }, { key: 'members', label: 'Members', w: 130, render: (r) => cell(dim(r, 'members')) },
        { key: 'requirements', label: 'Requirements', w: 140, render: (r) => cell(dim(r, 'requirements')) }, { key: 'wbs', label: 'WBS', w: 140, render: (r) => cell(dim(r, 'wbs')) },
        { key: 'weekly_reports', label: '주간보고 (월)', w: 120, render: (r) => cell(dim(r, 'weekly_reports')) },
        { key: 'max_pct', label: 'Limit %', w: 150, render: (r) => (r.max_pct === null ? '-' : html`<b class="${r.tier === 'attention' ? 'txt-bad' : r.tier === 'warn' ? 'txt-warn' : ''}">${r.max_pct}%</b> ${raw(r.tier === 'ok' ? '' : chip(r.tier))}`) },
        { key: 'last_activity_at', label: 'Last Activity', w: 120, render: (r) => rel(r.last_activity_at) },
      ], d.items, { rowHref: (r) => `/admin/workspaces/${r.workspace_id}` }))}
      ${raw(pager(d))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}
