/* Admin Dashboard: operator KPIs, 7-day activation funnel, attention queue, recent operator actions. Billing blocks appear only when Billing exists. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { ACTIONS, adminApi, aiFeatureTable, barChart, bindRows, fmtD, fxNote, head, kpis, money, n, pctTxt, rel, section, table, usd } from './ui.js';

export async function adminDashboardPage(main = $('#main')) {
  document.title = '대시보드 — RELAI 관리자';
  const [d, ai] = await Promise.all([adminApi('dashboard'), adminApi('ai/usage').catch(() => null)]);
  const k = d.kpis; const f = d.funnel_7d; const a = d.attention; const b = d.billing.implemented;
  const cards = [
    { label: '전체 사용자', value: n(k.users), href: '/admin/users' },
    { label: '활성 워크스페이스', value: n(k.active_workspaces), href: '/admin/workspaces?status=ACTIVE' },
    { label: '전체 프로젝트', value: n(k.projects), sub: '보관 제외' },
    { label: '최근 7일 가입', value: n(k.signups_7d), sub: `오늘 ${n(k.signups_today)}`, href: '/admin/users?since=7d' },
  ];
  if (b) cards.push({ label: '유료 워크스페이스 (Pro·Team)', value: n(k.team_workspaces), href: '/admin/subscriptions?status=ACTIVE' }, { label: 'MRR (VAT 포함)', value: k.mrr === null ? '가격 미설정' : `₩${n(k.mrr)}` });
  if (b) cards.push({ label: '결제 실패 (7일)', value: n(k.payment_failed_7d), tone: k.payment_failed_7d ? 'bad' : '', href: '/admin/payments?status=FAILED' }, { label: '결제 연체', value: n(k.past_due), tone: k.past_due ? 'warn' : '', href: '/admin/subscriptions?status=PAST_DUE' });
  const pct = (x) => (f.registered ? Math.round((x / f.registered) * 100) : 0);
  const funnel = [['가입', f.registered], ['워크스페이스 생성', f.workspace_created], ['프로젝트 생성', f.project_created], ...(b ? [['결제', f.paid]] : [])];
  const attn = [];
  if (b && a.payment_failed?.length) attn.push(['최근 결제 실패', a.payment_failed.map((p) => ({ href: `/admin/payments/${p.id}`, t: p.workspace_name, s: `${p.provider || ''} ${p.failure_code || ''} ${p.failure_message || ''}`, at: p.failed_at || p.created_at, tone: 'bad' }))]);
  if (b && a.past_due?.length) attn.push(['결제 연체 워크스페이스', a.past_due.map((s) => ({ href: `/admin/subscriptions/${s.id}`, t: s.workspace_name, s: `${s.plan_label} · ${s.status}`, at: s.updated_at, tone: 'warn' }))]);
  if (a.suspended_users.total) attn.push([`정지된 사용자 (${a.suspended_users.total})`, a.suspended_users.items.map((u) => ({ href: `/admin/users/${u.id}`, t: `${u.name} · ${u.email}`, s: '정지', at: u.suspended_at, tone: 'bad' }))]);
  if (a.suspended_workspaces.total) attn.push([`정지된 워크스페이스 (${a.suspended_workspaces.total})`, a.suspended_workspaces.items.map((w) => ({ href: `/admin/workspaces/${w.id}`, t: w.name, s: '정지', at: w.suspended_at, tone: 'bad' }))]);
  if (a.workspaces_without_active_owner.length) attn.push(['활성 소유자가 없는 워크스페이스', a.workspaces_without_active_owner.map((w) => ({ href: `/admin/workspaces/${w.id}`, t: w.name, s: '소유자 전원 정지 — 데이터는 유지됨', tone: 'warn' }))]);
  if (a.near_limit.length) attn.push(['Free 플랜 한도 90% 이상', a.near_limit.map((w) => ({ href: `/admin/workspaces/${w.workspace_id}`, t: w.name, s: w.dims.filter((x) => x.pct !== null && x.pct >= 90).map((x) => `${x.label} ${x.used}/${x.limit}`).join(' · '), tone: 'warn' }))]);
  main.innerHTML = html`<div class="apage">
    ${raw(head('대시보드', html`<span class="hint">${b ? '결제 연동됨' : '결제 미연동 — 결제 지표는 결제 연동 후 표시됩니다'}</span>`))}
    ${raw(kpis(cards))}
    <div class="agrid2">
      ${raw(section('가입 → 활성화 단계 (최근 7일)', html`<div class="afunnel">${raw(funnel.map(([l, v], i) => html`<div class="afunnel__r"><span>${l}</span><div class="afunnel__b"><i style="width:${i === 0 ? 100 : pct(v)}%"></i></div><b>${n(v)}</b><small>${i === 0 ? '' : pct(v) + '%'}</small></div>`).join(''))}
        <p class="hint">가입 시 워크스페이스가 자동 생성되므로 2단계는 가입 수와 같습니다. 실질 활성화 지표는 프로젝트 생성입니다.</p></div>`))}
      ${raw(section('확인 필요', attn.length ? attn.map(([t, items]) => html`<div class="aattn"><div class="aattn__t">${t}</div><ul>${raw(items.map((i) => html`<li><a href="${i.href}" data-link><i class="adot adot--${i.tone}"></i><span class="aattn__n">${i.t}</span><small>${i.s}</small>${raw(i.at ? html`<time>${rel(i.at)}</time>` : '')}</a></li>`).join(''))}</ul></div>`).join('') : '<div class="aempty">확인할 항목이 없습니다. 정지된 계정/워크스페이스, 한도 초과 워크스페이스가 생기면 여기에 표시됩니다.</div>'))}
    </div>
    ${raw(ai ? section(`AI 사용량 · API 비용${ai.config.enabled ? ` — ${ai.config.provider} ${ai.config.model}` : ' — AI 미설정'}`, html`${raw(kpis([
        { label: '이번 달 API 비용', value: money(ai.kpis.provider_cost_month, ai.fx) }, { label: '30일 API 비용', value: money(ai.kpis.provider_cost_30d, ai.fx), sub: `실패 요청 ${usd(ai.kpis.failed_cost_30d)}` },
        { label: '오늘 AI 요청', value: n(ai.kpis.runs_today) }, { label: '30일 요청', value: n(ai.kpis.runs_30d), sub: `실패 ${n(ai.kpis.failed_30d)}${ai.kpis.estimated_runs_30d ? ` · 추정 비용 ${n(ai.kpis.estimated_runs_30d)}건` : ''}` },
        { label: '성공률', value: ai.kpis.success_rate_30d === null ? '-' : `${ai.kpis.success_rate_30d}%`, tone: ai.kpis.success_rate_30d !== null && ai.kpis.success_rate_30d < 90 ? 'warn' : '' },
        { label: '토큰 (30일)', value: n(ai.kpis.input_tokens_30d + ai.kpis.output_tokens_30d), sub: `입력 ${n(ai.kpis.input_tokens_30d)} · 출력 ${n(ai.kpis.output_tokens_30d)} · 캐시 ${n(ai.kpis.cached_input_tokens_30d)}` },
      ]))}
      <div class="agrid2" style="margin-top:12px"><div><div class="asec__h">일별 API 비용 (30일)</div>${raw(barChart(ai.daily.map((x) => ({ label: x.date.slice(5), value: x.cost_usd })), { id: 'ai-daily' }))}</div>
        <div><div class="asec__h">월별 API 비용 (12개월)</div>${raw(barChart(ai.monthly.map((x) => ({ label: x.month, value: x.cost_usd })), { id: 'ai-monthly' }))}</div></div>
      <div class="asec__h" style="margin-top:12px">기능별 (30일)</div>${raw(aiFeatureTable(ai.features))}
      <div class="asec__h" style="margin-top:12px">모델별 (30일)</div>${raw(table([{ key: 'model', label: '모델', w: 200, render: (r) => html`${r.model} <small class="dim">${r.provider}</small>` }, { key: 'runs', label: '요청', w: 70, render: (r) => n(r.runs) },
        { key: 'input_tokens', label: '입력 토큰', w: 110, render: (r) => n(r.input_tokens) }, { key: 'output_tokens', label: '출력 토큰', w: 110, render: (r) => n(r.output_tokens) }, { key: 'cached_input_tokens', label: '캐시 토큰', w: 100, render: (r) => n(r.cached_input_tokens) },
        { key: 'provider_cost', label: '비용', w: 150, render: (r) => money(r.provider_cost, ai.fx) }], ai.models, { empty: 'AI 요청 기록이 없습니다.', id: 'aimodels' }))}
      ${raw(ai.workspaces.length ? html`<div style="margin-top:12px"><div><div class="asec__h">워크스페이스별 비용 (상위 10, 30일)</div>${raw(table([{ key: 'name', label: '워크스페이스', cls: 'ttl' }, { key: 'plan', label: '플랜', w: 70 },
          { key: 'provider_cost', label: '30일 비용', w: 140, render: (r) => money(r.provider_cost, ai.fx) }, { key: 'used_pct', label: '사용률', w: 90, render: (r) => (r.limit_usd === null ? html`<span class="dim">무제한</span>` : html`<b class="${r.used_pct >= 95 ? 'txt-bad' : r.used_pct >= 80 ? 'txt-warn' : ''}">${pctTxt(r.used_pct)}</b>`) },
          { key: 'limit_usd', label: '한도', w: 70, render: (r) => (r.limit_usd === null ? '-' : `$${r.limit_usd}`) }], ai.workspaces, { rowHref: (r) => `/admin/workspaces/${r.id}` }))}</div>
        <div style="margin-top:12px"><div class="asec__h">최근 실패</div>${raw(table([{ key: 'created_at', label: '일시', w: 130, render: (r) => fmtD(r.created_at) }, { key: 'workspace_name', label: '워크스페이스', w: 150 }, { key: 'error_code', label: '오류', w: 150 },
          { key: 'provider_cost_amount', label: '비용', w: 90, render: (r) => html`${usd(r.provider_cost_amount)}${raw(r.cost_estimated ? ' <small class="dim">추정</small>' : '')}` }], ai.recent_failures, { rowHref: (r) => `/admin/workspaces/${r.workspace_id}`, empty: '최근 실패가 없습니다.' }))}</div></div>` : '')}
      <p class="hint">비용은 AI 제공사 응답의 토큰 수 × 내부 단가표(server/ai/config.js)로 계산한 USD이며 실패한 요청도 포함합니다. 원화는 ${fxNote(ai.fx)} 기준 표시용입니다. 워크스페이스 한도(USD): Free 최초 $${ai.limits.FREE} · Pro 월 $${ai.limits.PRO} · Team 월 $${ai.limits.TEAM} · Enterprise ${ai.limits.ENTERPRISE === null ? '무제한' : `$${ai.limits.ENTERPRISE}`}.</p>`) : '')}
    ${raw(section('최근 운영자 조작', table([
      { key: 'created_at', label: '일시', w: 150, render: (r) => fmtD(r.created_at) }, { key: 'admin', label: '운영자', w: 200, render: (r) => html`${r.admin_name || '-'} <small class="dim">${r.admin_email || ''}</small>` },
      { key: 'action', label: '작업', w: 170, render: (r) => ACTIONS[r.action] || r.action }, { key: 'summary', label: '요약' },
    ], d.recent_audit, { rowHref: (r) => (r.target_type === 'USER' ? `/admin/users/${r.target_id}` : `/admin/workspaces/${r.target_id}`), empty: '아직 운영자 조작 기록이 없습니다.' }), html`<a class="link" href="/admin/audit" data-link>전체 감사 기록 →</a>`))}
  </div>`;
  bindRows(main, navigate);
}
