/* Admin Dashboard: operator KPIs, 7-day activation funnel, attention queue, recent operator actions. Billing blocks appear only when Billing exists. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { ACTIONS, adminApi, bindRows, chip, fmtD, head, kpis, n, rel, section, table } from './ui.js';

export async function adminDashboardPage(main = $('#main')) {
  document.title = 'Dashboard — RELAI Admin';
  const d = await adminApi('dashboard');
  const k = d.kpis; const f = d.funnel_7d; const a = d.attention; const b = d.billing.implemented;
  const cards = [
    { label: '전체 Users', value: n(k.users), href: '/admin/users' },
    { label: '활성 Workspaces', value: n(k.active_workspaces), href: '/admin/workspaces?status=ACTIVE' },
    { label: '전체 Projects', value: n(k.projects), sub: '보관 제외' },
    { label: '최근 7일 가입', value: n(k.signups_7d), sub: `오늘 ${n(k.signups_today)}`, href: '/admin/users?since=7d' },
  ];
  if (b) cards.push({ label: 'Team Workspaces', value: n(k.team_workspaces), href: '/admin/subscriptions?status=ACTIVE' }, { label: 'MRR', value: k.mrr === null ? '가격 미설정' : `₩${n(k.mrr)}` });
  if (b) cards.push({ label: 'Payment Failed (7일)', value: n(k.payment_failed_7d), tone: k.payment_failed_7d ? 'bad' : '', href: '/admin/payments?status=FAILED' }, { label: 'Past Due', value: n(k.past_due), tone: k.past_due ? 'warn' : '', href: '/admin/subscriptions?status=PAST_DUE' });
  const pct = (x) => (f.registered ? Math.round((x / f.registered) * 100) : 0);
  const funnel = [['가입', f.registered], ['Workspace 생성', f.workspace_created], ['Project 생성', f.project_created], ...(b ? [['Paid', f.paid]] : [])];
  const attn = [];
  if (b && a.payment_failed?.length) attn.push(['최근 결제 실패', a.payment_failed.map((p) => ({ href: `/admin/payments/${p.id}`, t: p.workspace_name, s: `${p.provider || ''} ${p.failure_code || ''} ${p.failure_message || ''}`, at: p.failed_at || p.created_at, tone: 'bad' }))]);
  if (b && a.past_due?.length) attn.push(['PAST_DUE Workspace', a.past_due.map((s) => ({ href: `/admin/subscriptions/${s.id}`, t: s.workspace_name, s: `${s.plan_label} · ${s.status}`, at: s.updated_at, tone: 'warn' }))]);
  if (a.suspended_users.total) attn.push([`정지된 User (${a.suspended_users.total})`, a.suspended_users.items.map((u) => ({ href: `/admin/users/${u.id}`, t: `${u.name} · ${u.email}`, s: '정지', at: u.suspended_at, tone: 'bad' }))]);
  if (a.suspended_workspaces.total) attn.push([`정지된 Workspace (${a.suspended_workspaces.total})`, a.suspended_workspaces.items.map((w) => ({ href: `/admin/workspaces/${w.id}`, t: w.name, s: '정지', at: w.suspended_at, tone: 'bad' }))]);
  if (a.workspaces_without_active_owner.length) attn.push(['활성 OWNER가 없는 Workspace', a.workspaces_without_active_owner.map((w) => ({ href: `/admin/workspaces/${w.id}`, t: w.name, s: 'OWNER 전원 정지 — 데이터는 유지됨', tone: 'warn' }))]);
  if (a.near_limit.length) attn.push(['Free Plan 한도 90% 이상', a.near_limit.map((w) => ({ href: `/admin/workspaces/${w.id}`, t: w.name, s: w.dims.filter((x) => x.pct !== null && x.pct >= 90).map((x) => `${x.label} ${x.used}/${x.limit}`).join(' · '), tone: 'warn' }))]);
  main.innerHTML = html`<div class="apage">
    ${raw(head('Dashboard', html`<span class="hint">${b ? 'Billing 연동됨' : 'Billing 미연동 — 결제 지표는 Phase 10 Billing 이후 표시됩니다'}</span>`))}
    ${raw(kpis(cards))}
    <div class="agrid2">
      ${raw(section('가입 → 활성화 Funnel (최근 7일)', html`<div class="afunnel">${raw(funnel.map(([l, v], i) => html`<div class="afunnel__r"><span>${l}</span><div class="afunnel__b"><i style="width:${i === 0 ? 100 : pct(v)}%"></i></div><b>${n(v)}</b><small>${i === 0 ? '' : pct(v) + '%'}</small></div>`).join(''))}
        <p class="hint">가입 시 Workspace가 자동 생성되므로 2단계는 가입 수와 같습니다. 실질 활성화 지표는 Project 생성입니다.</p></div>`))}
      ${raw(section('확인 필요', attn.length ? attn.map(([t, items]) => html`<div class="aattn"><div class="aattn__t">${t}</div><ul>${raw(items.map((i) => html`<li><a href="${i.href}" data-link><i class="adot adot--${i.tone}"></i><span class="aattn__n">${i.t}</span><small>${i.s}</small>${raw(i.at ? html`<time>${rel(i.at)}</time>` : '')}</a></li>`).join(''))}</ul></div>`).join('') : '<div class="aempty">확인할 항목이 없습니다. 정지된 계정/Workspace, 한도 초과 Workspace가 생기면 여기에 표시됩니다.</div>'))}
    </div>
    ${raw(section('최근 운영자 조작', table([
      { key: 'created_at', label: '일시', w: 150, render: (r) => fmtD(r.created_at) }, { key: 'admin', label: 'Admin', w: 200, render: (r) => html`${r.admin_name || '-'} <small class="dim">${r.admin_email || ''}</small>` },
      { key: 'action', label: 'Action', w: 170, render: (r) => ACTIONS[r.action] || r.action }, { key: 'summary', label: 'Summary' },
    ], d.recent_audit, { rowHref: (r) => (r.target_type === 'USER' ? `/admin/users/${r.target_id}` : `/admin/workspaces/${r.target_id}`), empty: '아직 운영자 조작 기록이 없습니다.' }), html`<a class="link" href="/admin/audit" data-link>전체 Audit →</a>`))}
  </div>`;
  bindRows(main, navigate);
}
