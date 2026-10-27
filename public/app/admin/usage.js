/* 사용량 (batch7 #23): every workspace's AI runs, API cost (30 days) and AI allowance used (current window), then plan-limit use
 * (group '플랜 한도 (Free만)'; early access retired 2026-10-20, every non-paid workspace is FREE). ≥80 % warning, ≥90 % attention. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { adminApi, bindFilters, bindPager, bindRows, chip, errorBlock, head, n, pager, pctTxt, qs, rel, sel, table, usd } from './ui.js';


export async function adminUsagePage(main = $('#main')) {
  document.title = '사용량 — RELAI 관리자';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('usage', { q: q.q, sort: q.sort, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    const total = d.items.reduce((a, r) => ({ runs: a.runs + r.ai.runs_30d, cost: a.cost + r.ai.cost_usd_30d }), { runs: 0, cost: 0 });
    main.innerHTML = html`<div class="apage">${raw(head('사용량', html`<span class="hint">최근 30일 AI 실행·API 비용 (이 페이지 합계: 실행 ${n(total.runs)}회 · ${usd(total.cost)}). 플랜 한도는 Free 플랜에만 적용됩니다.</span>`))}
      <div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="워크스페이스 검색" value="${q.q || ''}">
        ${raw(sel('sort', '정렬: AI 실행 (30일)', { projects: '정렬: 프로젝트 사용률', requirements: '정렬: 요구사항 사용률', wbs: '정렬: WBS 사용률', activity: '정렬: 최근 활동' }, q.sort))}</div>
      ${raw(table([
        { key: 'name', label: '워크스페이스', w: 240, cls: 'ttl', render: (r) => html`${r.name}${raw(r.status !== 'ACTIVE' ? ' ' + chip(r.status) : '')}` }, { key: 'plan_label', label: '플랜', w: 150, render: (r) => html`${r.plan_label}` },   // early access is on FREE limits since 2026-10-20 (no 무제한 row)
        { key: 'ai_runs', label: 'AI 실행 (30일)', w: 120, render: (r) => html`<b>${n(r.ai.runs_30d)}</b>${raw(r.ai.failed_30d ? html` <small class="txt-bad">실패 ${n(r.ai.failed_30d)}</small>` : '')}` },
        { key: 'ai_cost', label: 'API 비용 (30일)', w: 120, render: (r) => usd(r.ai.cost_usd_30d) },
        { key: 'ai_pct', label: 'AI 사용률', w: 130, render: (r) => (r.ai.limit_usd === null ? html`<span class="dim">무제한</span>` : html`<b class="${r.ai.used_pct >= 95 ? 'txt-bad' : r.ai.used_pct >= 80 ? 'txt-warn' : ''}">${pctTxt(r.ai.used_pct)}</b> <small class="dim">/ $${r.ai.limit_usd}${r.ai.allowance === 'ONCE' ? ' 1회' : ' 월'}</small>`) },
        { key: 'ai_last', label: '마지막 AI 사용', w: 120, render: (r) => rel(r.ai.last_run_at) },
        { key: 'max_pct', label: '한도 사용률', w: 150, render: (r) => (r.max_pct === null ? html`<span class="dim">무제한</span>` : html`<span title="${r.dims.map((x) => `${x.label} ${x.used}/${x.limit ?? '∞'}`).join(' · ')}"><b class="${r.tier === 'attention' ? 'txt-bad' : r.tier === 'warn' ? 'txt-warn' : ''}">${r.max_pct}%</b> ${raw(r.tier === 'ok' ? '' : chip(r.tier))}</span>`) },
        { key: 'last_activity_at', label: '최근 활동', w: 120, render: (r) => rel(r.last_activity_at) },
      ], d.items, { rowHref: (r) => `/admin/workspaces/${r.workspace_id}`, empty: '워크스페이스가 없습니다.',
        groups: [{ label: '', span: 2 }, { label: 'AI (30일 실행·비용 / 이번 기간 사용률)', span: 4 }, { label: '플랜 한도 (Free만)', span: 1 }, { label: '', span: 1 }] }))}
      ${raw(pager(d))}
    </div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}
