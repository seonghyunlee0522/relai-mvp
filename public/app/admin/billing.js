/* Subscriptions / Payments (read-only). While Billing is not implemented the pages say so explicitly — no placeholder rows, no fake zeros.
 * Sensitive provider data never reaches this UI: the API whitelists columns and masks transaction ids. */
import { $, html, raw } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { serviceOrdersSection } from './service-orders.js';
import { adminApi, bindFilters, bindPager, bindRows, chip, dl, errorBlock, fmtD, fmtDay, head, n, pager, qs, sel, section, table } from './ui.js';
const SUB_KO = { ACTIVE: '이용 중', PAST_DUE: '결제 연체', CANCELED: '해지', TRIALING: '체험 중' };
const PAY_KO = { PAID: '결제 완료', FAILED: '실패', PENDING: '대기', REFUNDED: '환불' };

const NOT_YET = (what) => html`<div class="aempty aempty--lg"><b>결제가 아직 연동되지 않았습니다.</b><p>결제 기능에서 구독·결제 데이터가 생기면 ${what} 목록이 이 화면에 자동으로 표시됩니다. 임의의 데이터는 만들지 않습니다.</p></div>`;
const money = (p) => (p.amount === null || p.amount === undefined ? '-' : `${p.currency === 'KRW' || !p.currency ? '₩' : p.currency + ' '}${n(p.amount)}`);

export async function adminSubscriptionsPage(main = $('#main')) {
  document.title = '구독 — RELAI 관리자';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('subscriptions', { q: q.q, plan: q.plan, status: q.status, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">${raw(head('구독', '<span class="hint">읽기 전용 — 플랜 변경은 결제사 결제와 분리해 임의로 바꾸지 않습니다.</span>'))}
      ${raw(!d.implemented ? NOT_YET('구독') : html`<div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="워크스페이스 검색" value="${q.q || ''}">${raw(sel('plan', '플랜', { FREE: 'Free', TEAM: 'Team' }, q.plan))}${raw(sel('status', '상태', SUB_KO, q.status))}</div>
      ${raw(table([
        { key: 'workspace_name', label: '워크스페이스', w: 240, cls: 'ttl' }, { key: 'plan_label', label: '플랜', w: 80 }, { key: 'status', label: '상태', w: 110, render: (s) => chip(s.status, SUB_KO[s.status] || s.status) },
        { key: 'period', label: '현재 이용 기간', w: 200, render: (s) => `${fmtDay(s.current_period_start)} ~ ${fmtDay(s.current_period_end)}` }, { key: 'next_billing_at', label: '다음 결제일', w: 120, render: (s) => fmtDay(s.next_billing_at) },
        { key: 'cancel_at_period_end', label: '기간 종료 시 해지', w: 110, render: (s) => (s.cancel_at_period_end ? '예' : '-') }, { key: 'updated_at', label: '수정일', w: 150, render: (s) => fmtD(s.updated_at) },
      ], d.items, { rowHref: (s) => `/admin/subscriptions/${s.id}` }))}${raw(pager(d))}`)}</div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
  };
  await draw();
}

export async function adminSubscriptionPage(id, main = $('#main')) {
  const d = await adminApi(`subscriptions/${id}`); const s = d.subscription;
  document.title = `${s.workspace_name} — 구독 — RELAI 관리자`;
  main.innerHTML = html`<div class="apage">${raw(head(`${s.workspace_name} · ${s.plan_label}`, '', { href: '/admin/subscriptions', label: '구독' }))}
    <div class="agrid2">
      ${raw(section('구독', dl([['워크스페이스', html`<a class="link" href="/admin/workspaces/${s.workspace_id}" data-link>${s.workspace_name}</a>`], ['플랜', html`${s.plan_label}`], ['상태', chip(s.status, SUB_KO[s.status] || s.status)],
        ['current_period_start', fmtD(s.current_period_start)], ['current_period_end', fmtD(s.current_period_end)], ['next_billing_at', fmtD(s.next_billing_at)], ['cancel_at_period_end', s.cancel_at_period_end ? '예' : '아니오'], ['grace_period_end', fmtD(s.grace_period_end)],
        ['결제 수단', html`${s.payment_method_summary || '-'}`], ['수정일', fmtD(s.updated_at)]])))}
      ${raw(section('구독 이벤트', d.events.length ? html`<ul class="aact">${raw(d.events.map((e) => html`<li><time>${fmtD(e.created_at)}</time><span>${e.event_type}</span></li>`).join(''))}</ul>` : '<div class="aempty">이벤트 기록이 없습니다.</div>'))}
    </div>
    ${raw(section('최근 결제', table([{ key: 'created_at', label: '일시', w: 150, render: (p) => fmtD(p.created_at) }, { key: 'amount', label: '금액', w: 110, cls: 'num', render: money }, { key: 'status', label: '상태', w: 100, render: (p) => chip(p.status, PAY_KO[p.status] || p.status) }, { key: 'provider', label: '결제사', w: 100 }, { key: 'provider_tid_masked', label: 'TID (일부 가림)', w: 170, render: (p) => html`<span class="mono">${p.provider_tid_masked || '-'}</span>` }, { key: 'failure', label: '실패 사유', render: (p) => html`${p.failure_code || ''} ${p.failure_message || ''}` }], d.payments, { rowHref: (p) => `/admin/payments/${p.id}`, empty: '결제 내역이 없습니다.' })))}
  </div>`;
  bindRows(main, navigate);
}

export async function adminPaymentsPage(main = $('#main')) {
  document.title = '결제 — RELAI 관리자';
  const draw = async () => {
    const q = qs();
    let d; try { d = await adminApi('payments', { q: q.q, status: q.status, provider: q.provider, from: q.from, to: q.to, page: q.page, size: q.size }); } catch (e) { main.innerHTML = errorBlock(e); return; }
    main.innerHTML = html`<div class="apage">${raw(head('결제', '<span class="hint">결제 Key · 카드번호 · Merchant Key는 어디에도 표시되지 않습니다.</span>'))}
      ${raw(!d.implemented ? NOT_YET('결제') : html`<div class="atool"><input class="input input--sm" data-f="q" type="search" placeholder="워크스페이스 · 주문번호 · TID 끝 4자리" value="${q.q || ''}">${raw(sel('status', '상태', PAY_KO, q.status))}
        <input class="input input--sm" data-f="provider" placeholder="결제사" value="${q.provider || ''}" style="width:120px"><input class="input input--sm" type="date" data-f="from" value="${q.from || ''}"><input class="input input--sm" type="date" data-f="to" value="${q.to || ''}"></div>
      ${raw(table([
        { key: 'created_at', label: '일시', w: 150, render: (p) => fmtD(p.created_at) }, { key: 'workspace_name', label: '워크스페이스', w: 220, cls: 'ttl' }, { key: 'plan', label: '플랜', w: 70 },
        { key: 'amount', label: '금액', w: 110, cls: 'num', render: money }, { key: 'status', label: '상태', w: 100, render: (p) => chip(p.status, PAY_KO[p.status] || p.status) }, { key: 'provider', label: '결제사', w: 100 },
        { key: 'provider_result_code', label: '결과 코드', w: 100 }, { key: 'provider_tid_masked', label: 'TID (일부 가림)', w: 170, render: (p) => html`<span class="mono">${p.provider_tid_masked || '-'}</span>` },
      ], d.items, { rowHref: (p) => `/admin/payments/${p.id}` }))}${raw(pager(d))}`)}<div id="svc-orders"></div></div>`;
    bindFilters(main, draw); bindPager(main, draw); bindRows(main, navigate);
    serviceOrdersSection(main.querySelector('#svc-orders'));   // 서비스 결제 (/pricing), shown with or without in-app billing
  };
  await draw();
}

export async function adminPaymentPage(id, main = $('#main')) {
  const { payment: p } = await adminApi(`payments/${id}`);
  document.title = `결제 ${p.id} — RELAI 관리자`;
  main.innerHTML = html`<div class="apage">${raw(head(`결제 · ${p.workspace_name}`, '', { href: '/admin/payments', label: '결제' }))}
    ${raw(section('결제', dl([['결제 ID', html`<span class="mono">${p.id}</span>`], ['워크스페이스', html`<a class="link" href="/admin/workspaces/${p.workspace_id}" data-link>${p.workspace_name}</a>`], ['구독', p.subscription_id ? html`<a class="link" href="/admin/subscriptions/${p.subscription_id}" data-link>${p.subscription_id}</a>` : '-'],
      ['금액', money(p)], ['통화', html`${p.currency || '-'}`], ['상태', chip(p.status, PAY_KO[p.status] || p.status)], ['결제사', html`${p.provider || '-'}`], ['주문번호(Moid)', html`<span class="mono">${p.moid || '-'}</span>`], ['결제사 TID (일부 가림)', html`<span class="mono">${p.provider_tid_masked || '-'}</span>`],
      ['결과 코드', html`${p.provider_result_code || '-'}`], ['결제 시각', fmtD(p.paid_at)], ['실패 시각', fmtD(p.failed_at)], ['실패 코드', html`${p.failure_code || '-'}`], ['실패 메시지', html`${p.failure_message || '-'}`]])))}
  </div>`;
}
