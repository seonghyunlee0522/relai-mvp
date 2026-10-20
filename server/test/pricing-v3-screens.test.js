/* Pricing v3 T4 — screens, legal docs, admin (tracks.md T4):
 *  - shared plan cards (landing #pricing / plans page): founder numbers for both cycles, annual card amount at least as prominent
 *    as the monthly equivalent (legal-review §8.9), 월간 default, nothing pre-selected, no ₩;
 *  - Billing page renderer against the v3 fixture (T2 buckets / T3 scheduled changes filled in) and against the live T1 shape
 *    (buckets null → total only, never fake zeros); Free → Pro upgrade instead of 충전; credits never next to won;
 *  - GET …/billing/orders: OWNER only, whitelisted columns, isolated per workspace;
 *  - admin workspace detail: v3 billing block (plan, cycle, limits, seats, add-ons, orders); admin MRR at v3 card amounts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, setup, addMember } from './api-helpers.js';
import { catalogue } from '../plans.js';
import { pricingHtml, planRows } from '../../public/app/shared/pricing.js';
import { billingHtml, ordersHtml } from '../../public/app/billing.js';
import { landingPricingHtml } from '../legal.js';
import { orderView } from '../billing/history.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/billing-v3.json', import.meta.url), 'utf8')).billing;
const fixture = (o = {}) => ({ ...structuredClone(FIX), catalogue: catalogue(), ...o });
const text = (h) => h.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('plan cards: founder numbers for 월간 and 연간, VAT 포함, 월간 default, annual charge shown as the price', () => {
  const h = pricingHtml(catalogue());
  assert.match(h, /class="pcw" data-cycle="MONTHLY"/);
  assert.match(h, /data-cycle-set="MONTHLY" aria-checked="true"/); assert.match(h, /data-cycle-set="ANNUAL" aria-checked="false"/);
  const t = text(h);
  for (const s of ['30,000원 /월', '80,000원 /월', '연 288,000원 결제', '월 24,000원 환산', '72,000원 할인(20%)', '연 768,000원 결제', '월 64,000원 환산', '192,000원 할인(20%)',
    '활성 프로젝트 1개', '활성 프로젝트 3개', '활성 프로젝트 10개', '기본 사용자 3명', '기본 사용자 15명', '기본 사용자 40명',
    '최초 100 크레딧 (1회)', '매월 1,000 크레딧', '매월 3,000 크레딧', '추가 사용자 1명 월 1,000원', '추가 사용자 1명 월 800원 환산',
    '추가 프로젝트 1개 월 10,000원', '추가 프로젝트 1개 월 8,000원 환산', '추가 프로젝트 1개 월 8,000원', '추가 프로젝트 1개 월 6,400원 환산',
    'AI 크레딧 충전 불가', 'AI 크레딧 충전 10,000원 단위', '10,000원 = 1,000 크레딧 단위', '계약에 따름', '별도 견적', 'VAT 10%', '12개월분을 한 번에 결제', '이월되지 않습니다']) assert.ok(t.includes(s), `cards lack "${s}"`);
  // §21의2①1: in 연간 the big price (.pc__p) is the amount charged, the monthly equivalent is the smaller line
  const pro = h.slice(h.indexOf('data-plan="PRO"')); const annual = pro.slice(pro.indexOf('<div class="pc-a">'));
  assert.match(annual, /^<div class="pc-a"><div class="pc__p" data-amount="288000">연 288,000원/);
  assert.doesNotMatch(h, /₩|checked(?!=)|selected/);
  assert.deepEqual(planRows(catalogue().plans[0], catalogue()).map((r) => r[0]), ['활성 프로젝트', '기본 사용자', 'AI 크레딧', 'AI 크레딧 충전']);
  // the landing wraps the same cards with its CTAs (Enterprise → 도입 문의 mail), no price typed in index.html
  const l = landingPricingHtml();
  assert.match(l, /<style>/); assert.match(l, /data-loc="pricing_enterprise">도입 문의/); // founder 2026-10-20 (D3): no one-time passes; Pro/Team buy buttons say 정기결제 준비 중 until recurring is approved
  assert.match(l, /data-plan-soon="PRO">정기결제 준비 중/); assert.match(l, /data-plan-soon="TEAM">정기결제 준비 중/); assert.doesNotMatch(l, /data-loc="pricing_pro"/); assert.match(l, /data-loc="pricing_free"/);
  const live = landingPricingHtml(undefined, { open: true }); assert.match(live, /data-loc="pricing_pro"/); assert.doesNotMatch(live, /data-plan-soon="/);
  const idx = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  const sec = idx.slice(idx.indexOf('id="pricing"'), idx.indexOf('<!-- CLOSING -->'));
  assert.doesNotMatch(sec.replace(/<!--[\s\S]*?-->/g, ''), /\d{1,3},000원|₩/);
});

test('Billing page (v3 fixture): plan, cycle, next payment, usage vs limits with seats, credit buckets, scheduled change, actions', () => {
  const t = text(billingHtml(fixture(), { orders: [] }));
  for (const s of ['현재 요금제', 'Pro', '월간', '이용 중', '다음 결제일 2026.11.20', '다음 결제 예정 금액 32,000원 VAT 포함 · 추가 이용 포함', '추가 이용 사용자 2명',
    '활성 프로젝트 2 / 3', '완료·보관한 프로젝트는 포함하지 않아요', '사용자 10 / 17', '초대 대기 1명 포함 · 남은 자리 7명',
    '사용 가능 1,450 크레딧', '기본 크레딧 900', '2026.11.20 소멸 · 이월 없음', '가입·프로모션 50', '유상(충전) 500', '충전일부터 5년',
    '예약된 변경', '요금제 변경 → Free', '2026.11.20 적용', '예약 취소', '요금제 변경', '사용자 · 프로젝트 추가', 'AI 크레딧 충전', '해지', '결제 내역이 없어요']) assert.ok(t.includes(s), `billing lacks "${s}"`);
  const h = billingHtml(fixture(), { orders: [] });
  assert.doesNotMatch(h, /₩/);
  assert.doesNotMatch(t, /크레딧[^.]{0,12}\d원|\d원[^.]{0,6}크레딧/, 'no won amount next to a credit number');
  assert.match(h, /href="\/terms#refund"/); assert.match(h, /href="\/terms#recurring"/);
});

test('Billing page (live T1 shape): null buckets → total only; empty scheduled hidden; Free → Pro upgrade, no 충전 / 해지; member read-only', () => {
  const free = fixture({ plan: 'FREE', plan_label: 'Free', cycle: null, status: null, auto_renew: false, next_payment_at: null, next_payment_amount: null, addons: { extra_users: 0, extra_projects: 0 },
    limits: { projects: 1, users: 3 }, usage: { projects_active: 1, members: 2, pending_invites: 0, seats_left: 1 }, scheduled: [], subscription: null,
    credits: { total: 100, plan: null, plan_expires_at: null, promo: null, purchased: null } });
  const h = billingHtml(free); const t = text(h);
  assert.ok(t.includes('사용 가능 100 크레딧')); assert.doesNotMatch(h, /bl-b-plan|bl-scheduled|id="bl-topup"|id="bl-cancel"|id="bl-addon"/);
  assert.ok(t.includes('AI 크레딧 충전은 Pro부터 할 수 있어요')); assert.ok(t.includes('요금제 살펴보기')); assert.ok(t.includes('결제 정보 없이 이용 중'));
  const member = billingHtml({ ...free, can_manage: false });
  assert.match(member, /id="bl-owner-only"/); assert.doesNotMatch(member, /id="bl-change"/);
  // auto renewal off (cancelled; D3: no one-time passes): no 해지 button, the end date, 'Free로 전환' and the 30-day export promise
  const pass = fixture({ auto_renew: false, next_payment_at: null, next_payment_amount: null, subscription: { ...FIX.subscription, auto_renew: false } });
  const pt = text(billingHtml(pass)); assert.ok(pt.includes('자동 결제되지 않아요')); assert.ok(pt.includes('자동 갱신이 꺼져 있어요')); assert.ok(pt.includes('30일 동안 모든 프로젝트를 조회하고 내보낼 수 있어요')); assert.doesNotMatch(pt, /이용권/); assert.doesNotMatch(billingHtml(pass), /id="bl-cancel"/);
  // over the limit after a downgrade (D6): banner says data is kept and what to reduce
  const over = text(billingHtml(fixture({ over_limit: { projects: 2, members: 0 } })));
  assert.ok(over.includes('한도를 넘었어요 — 데이터는 그대로예요.')); assert.ok(over.includes('한도 초과: 활성 프로젝트 2개.'));
  // a scheduled change without cancel_url (T3 not live) is listed but not cancellable
  assert.doesNotMatch(billingHtml(fixture({ scheduled: [{ kind: 'CYCLE', to: 'ANNUAL', effective_at: '2026-11-20' }] })), /data-sched-cancel/);
});

test('orders view: titles in words, refund state, VAT-included amount; table has no provider ids', () => {
  const rows = [
    orderView({ id: 'o1', kind: 'ONE_TIME', plan: 'PRO', cycle: 'ANNUAL', amount: 288000, supply_amount: 261818, vat_amount: 26182, refunded_amount: 0, status: 'PAID', created_at: '2026-10-20T01:00:00Z', paid_at: '2026-10-20T01:00:00Z' }),
    orderView({ id: 'o2', kind: 'ADDON', plan: 'PRO', cycle: 'MONTHLY', addon_users: 2, amount: 774, supply_amount: 704, vat_amount: 70, refunded_amount: 0, status: 'PAID', created_at: '2026-10-20T02:00:00Z' }),
    orderView({ id: 'o3', kind: 'CREDIT_TOPUP', credits: 2000, amount: 20000, supply_amount: 18182, vat_amount: 1818, refunded_amount: 5000, status: 'PAID', created_at: '2026-10-20T03:00:00Z', receipt_url: 'https://r.example/1' }),
  ];
  assert.deepEqual(rows.map((r) => [r.title, r.kind_label, r.status_label]), [['Pro 연간', '요금제 결제', '결제 완료'], ['추가 사용자 2명', '추가 이용', '결제 완료'], ['AI 크레딧 2,000', 'AI 크레딧 충전', '부분 환불']]);
  const t = text(ordersHtml(rows));
  for (const s of ['288,000원', '774원', '20,000원 (환불 5,000원)', '영수증', 'VAT 포함']) assert.ok(t.includes(s), s);
});

test('GET …/billing/orders: OWNER only, own workspace only; v3 billing summary + admin workspace detail (seats, add-ons, orders)', async () => {
  const { db, server, client } = await boot();
  try {
    const A = await setup(client, 'owner-a@x.com', '가소유');
    const m = await addMember(client, A, 'member-a@x.com', '가멤버');
    const B = await setup(client, 'owner-b@x.com', '나소유');
    await db.run(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, plan, cycle, seats, months, unit_price, list_amount, supply_amount, vat_amount, amount, goods_name, status, provider_tid, client_key, paid_at, addon_users)
      VALUES ('ord_a1', ?, ?, 'fake', 'ADDON', 'PRO', 'MONTHLY', 2, 1, 1000, 774, 704, 70, 774, 'RELAI 추가 사용자', 'PAID', 'TID-SECRET-1234', 'ck1', now(), 2),
             ('ord_a0', ?, ?, 'fake', 'ONE_TIME', 'PRO', 'MONTHLY', 15, 1, 30000, 30000, 27273, 2727, 30000, 'RELAI Pro', 'PENDING', NULL, NULL, NULL, 0)`, [A.w, A.uid, A.w, A.uid]);
    await db.run(`UPDATE billing_orders SET created_at = now() - interval '2 days' WHERE id = 'ord_a0'`);   // abandoned window → not listed
    const r = await A.c('GET', `/api/workspaces/${A.w}/billing/orders`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.orders.map((o) => [o.id, o.title, o.amount, o.status]), [['ord_a1', '추가 사용자 2명', 774, 'PAID']]);
    assert.doesNotMatch(JSON.stringify(r.json), /TID-SECRET|provider_tid|client_key|ck1/);
    assert.equal((await m.c('GET', `/api/workspaces/${A.w}/billing/orders`)).status, 403);   // MEMBER: no payment data
    assert.ok([403, 404].includes((await B.c('GET', `/api/workspaces/${A.w}/billing/orders`)).status));   // other workspace's owner: not a member
    assert.deepEqual((await B.c('GET', `/api/workspaces/${B.w}/billing/orders`)).json.orders, []);
    // the summary the Billing page reads (T1 v3 shape): limits, usage with pending invites and seats_left, catalogue
    const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
    for (const k of ['plan', 'cycle', 'limits', 'usage', 'addons', 'scheduled', 'credits', 'catalogue', 'flags', 'over_limit']) assert.ok(k in b, k);
    assert.equal(b.usage.members, 2); assert.equal(typeof b.usage.seats_left, 'number');
    // admin: the workspace detail carries the v3 billing block
    await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = 'owner-b@x.com'`);
    const adm = await B.c('GET', `/api/admin/workspaces/${A.w}`);
    assert.equal(adm.status, 200);
    {
      const v = adm.json.billing_v3;
      assert.ok(v, 'admin detail has billing_v3');
      assert.deepEqual([v.plan, v.limits, v.usage.members, v.usage.pending_invites], ['FREE', { projects: 1, users: 3 }, 2, 0]);
      assert.deepEqual(v.orders.map((o) => o.id), ['ord_a1']); assert.doesNotMatch(JSON.stringify(v), /TID-SECRET|client_key/);
    }
  } finally { server.close(); }
});

test('admin MRR (VAT included): plan + add-ons per month, annual = 1/12 of the annual amount', async () => {
  const { subscriptionMrr } = await import('../billing-admin.js');
  assert.equal(subscriptionMrr({ plan: 'PRO', billing_cycle: 'MONTHLY', extra_users: 2, extra_projects: 0 }), 32000);
  assert.equal(subscriptionMrr({ plan: 'TEAM', billing_cycle: 'ANNUAL', extra_users: 0, extra_projects: 1 }), 70400);   // 844,800 / 12
  assert.equal(subscriptionMrr({ plan: 'PRO', billing_cycle: 'ANNUAL' }), 24000);
  assert.equal(subscriptionMrr({ plan: 'FREE', billing_cycle: 'MONTHLY' }), 0);
  assert.equal(subscriptionMrr({ plan: 'ENTERPRISE', billing_cycle: 'MONTHLY' }), 0);
});
