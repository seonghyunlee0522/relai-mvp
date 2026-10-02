/* Subscriptions / Payments (read-only). While Billing is not implemented the pages say so explicitly — no placeholder rows, no fake zeros.
 * Sensitive provider data never reaches this UI: the API whitelists columns and masks transaction ids. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { adminApi, bindFilters, bindPager, bindRows, chip, dl, errorBlock, fmtD, fmtDay, head, n, pager, qs, sel, section, table } from './ui.js';

const NOT_YET = (what) => html`<div class="aempty aempty--lg"><b>Billing이 아직 연동되지 않았습니다.</b><p>Phase 10 Billing에서 subscriptions · payments 테이블이 생기면 ${what} 목록이 이 화면에 자동으로 표시됩니다. 임의의 데이터는 만들지 않습니다.</p></div>`;
const money = (p) => (p.amount === null || p.amount === undefined ? '-' : `${p.currency === 'KRW' || !p.currency ? '₩' : p.currency + ' '}${n(p.amount)}`);

export async function adminSubscriptionsPage(main = $('#main')) {
  document.title = 'Subscriptions — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('subscriptions', { q: q.q, plan: q.plan, status: q.status, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">${raw(head('Subscriptions', '<span class="hint">읽기 전용 — Plan 변경은 Provider 결제와 분리해 임의로 바꾸지 않습니다.</span>'))}
      ${raw(!d.implemented ? NOT_YET('구독') : html`<div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="Workspace 검색" value="${q.q || ''}">${raw(sel('plan', 'Plan', { FREE: 'Free', TEAM: 'Team' }, q.plan))}${raw(sel('status', 'Status', { ACTIVE: 'ACTIVE', PAST_DUE: 'PAST_DUE', CANCELED: 'CANCELED', TRIALING: 'TRIALING' }, q.status))}</div>
      ${raw(table([
        { key: 'workspace_name', label: 'Workspace', w: 240, cls: 'ttl' }, { key: 'plan_label', label: 'Plan', w: 80 }, { key: 'status', label: 'Status', w: 110, render: (s) => chip(s.status, s.status) },
        { key: 'period', label: 'Current Period', w: 200, render: (s) => `${fmtDay(s.current_period_start)} ~ ${fmtDay(s.current_period_end)}` }, { key: 'next_billing_at', label: 'Next Billing', w: 120, render: (s) => fmtDay(s.next_billing_at) },
        { key: 'cancel_at_period_end', label: 'Cancel at End', w: 110, render: (s) => (s.cancel_at_period_end ? '예' : '-') }, { key: 'updated_at', label: 'Updated', w: 150, render: (s) => fmtD(s.updated_at) },
      ], d.items, { rowHref: (s) => `/admin/subscriptions/${s.id}` }))}${raw(pager(d))}`)}</div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

export async function adminSubscriptionPage(id, main = $('#main')) {
  const d = await adminApi(`subscriptions/${id}`); const s = d.subscription;
  document.title = `${s.workspace_name} — Subscriptions — RELAI Admin`;
  main.innerHTML = html`<div class="apage">${raw(head(`${s.workspace_name} · ${s.plan_label}`, '', { href: '/admin/subscriptions', label: 'Subscriptions' }))}
    <div class="agrid2">
      ${raw(section('Subscription', dl([['Workspace', html`<a class="link" href="/admin/workspaces/${s.workspace_id}" data-link>${s.workspace_name}</a>`], ['Plan', html`${s.plan_label}`], ['Status', chip(s.status, s.status)],
        ['current_period_start', fmtD(s.current_period_start)], ['current_period_end', fmtD(s.current_period_end)], ['next_billing_at', fmtD(s.next_billing_at)], ['cancel_at_period_end', s.cancel_at_period_end ? '예' : '아니오'], ['grace_period_end', fmtD(s.grace_period_end)],
        ['Payment Method', html`${s.payment_method_summary || '-'}`], ['Updated', fmtD(s.updated_at)]])))}
      ${raw(section('Subscription Events', d.events.length ? html`<ul class="aact">${raw(d.events.map((e) => html`<li><time>${fmtD(e.created_at)}</time><span>${e.event_type}</span></li>`).join(''))}</ul>` : '<div class="aempty">이벤트 기록이 없습니다.</div>'))}
    </div>
    ${raw(section('최근 Payment', table([{ key: 'created_at', label: 'Date', w: 150, render: (p) => fmtD(p.created_at) }, { key: 'amount', label: 'Amount', w: 110, cls: 'num', render: money }, { key: 'status', label: 'Status', w: 100, render: (p) => chip(p.status, p.status) }, { key: 'provider', label: 'Provider', w: 100 }, { key: 'provider_tid_masked', label: 'TID (masked)', w: 170, render: (p) => html`<span class="mono">${p.provider_tid_masked || '-'}</span>` }, { key: 'failure', label: '실패 사유', render: (p) => html`${p.failure_code || ''} ${p.failure_message || ''}` }], d.payments, { rowHref: (p) => `/admin/payments/${p.id}`, empty: '결제 내역이 없습니다.' })))}
  </div>`;
  bindRows(main, navigate);
}

export async function adminPaymentsPage(main = $('#main')) {
  document.title = 'Payments — RELAI Admin';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('payments', { q: q.q, status: q.status, provider: q.provider, from: q.from, to: q.to, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">${raw(head('Payments', '<span class="hint">Billing Key · 카드번호 · Merchant Key는 어디에도 표시되지 않습니다.</span>'))}
      ${raw(!d.implemented ? NOT_YET('결제') : html`<div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="Workspace · Moid · TID 끝 4자리" value="${q.q || ''}">${raw(sel('status', 'Status', { PAID: 'PAID', FAILED: 'FAILED', PENDING: 'PENDING', REFUNDED: 'REFUNDED' }, q.status))}
        <input class="input input--sm" data-f="provider" placeholder="Provider" value="${q.provider || ''}" style="width:120px"><input class="input input--sm" type="date" data-f="from" value="${q.from || ''}"><input class="input input--sm" type="date" data-f="to" value="${q.to || ''}"></div>
      ${raw(table([
        { key: 'created_at', label: 'Date', w: 150, render: (p) => fmtD(p.created_at) }, { key: 'workspace_name', label: 'Workspace', w: 220, cls: 'ttl' }, { key: 'plan', label: 'Plan', w: 70 },
        { key: 'amount', label: 'Amount', w: 110, cls: 'num', render: money }, { key: 'status', label: 'Status', w: 100, render: (p) => chip(p.status, p.status) }, { key: 'provider', label: 'Provider', w: 100 },
        { key: 'provider_result_code', label: 'Result Code', w: 100 }, { key: 'provider_tid_masked', label: 'TID (masked)', w: 170, render: (p) => html`<span class="mono">${p.provider_tid_masked || '-'}</span>` },
      ], d.items, { rowHref: (p) => `/admin/payments/${p.id}` }))}${raw(pager(d))}`)}</div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

export async function adminPaymentPage(id, main = $('#main')) {
  const { payment: p } = await adminApi(`payments/${id}`);
  document.title = `Payment ${p.id} — RELAI Admin`;
  main.innerHTML = html`<div class="apage">${raw(head(`Payment · ${p.workspace_name}`, '', { href: '/admin/payments', label: 'Payments' }))}
    ${raw(section('Payment', dl([['Payment ID', html`<span class="mono">${p.id}</span>`], ['Workspace', html`<a class="link" href="/admin/workspaces/${p.workspace_id}" data-link>${p.workspace_name}</a>`], ['Subscription', p.subscription_id ? html`<a class="link" href="/admin/subscriptions/${p.subscription_id}" data-link>${p.subscription_id}</a>` : '-'],
      ['Amount', money(p)], ['Currency', html`${p.currency || '-'}`], ['Status', chip(p.status, p.status)], ['Provider', html`${p.provider || '-'}`], ['Moid', html`<span class="mono">${p.moid || '-'}</span>`], ['Provider TID (masked)', html`<span class="mono">${p.provider_tid_masked || '-'}</span>`],
      ['Result Code', html`${p.provider_result_code || '-'}`], ['paid_at', fmtD(p.paid_at)], ['failed_at', fmtD(p.failed_at)], ['failure_code', html`${p.failure_code || '-'}`], ['failure_message', html`${p.failure_message || '-'}`]])))}
  </div>`;
}
