/* 단건결제 모드 (ONE_TIME_PAYMENT_MODE; NicePay 카드사 심사 2026-10-26, 정기결제 승인 전).
 *  on:  Pro / Team = 1개월 이용권 (one-time order through the card window, MONTHLY only, no add-ons, no auto renewal),
 *       AI credits for every plan (Free tops up), landing shows the plan cards without 월간/연간 · 정기결제 wording + 3 credit packs,
 *       /api/me and the billing summary carry the flag.
 *  off: unchanged (plan checkout 409 checkout_not_open, Free cannot top up, no credit packs on the landing).
 * Fake billing and fake AI only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { createFakeProvider } from '../billing/provider.js';
import { resetBillingCache } from '../billing-admin.js';
import { project } from './api-helpers.js';

process.env.PAYMENTS_ENABLED = 'true';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
delete process.env.ONE_TIME_PLANS_ENABLED;

async function boot(on) {
  if (on) process.env.ONE_TIME_PAYMENT_MODE = 'true'; else delete process.env.ONE_TIME_PAYMENT_MODE;
  const db = await testDb(); resetBillingCache();
  const provider = createFakeProvider();
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const c = async (method, path, body) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김심사', email: `review${Date.now()}@relai.kr`, password: 'passw0rd!' });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  await db.run('UPDATE users SET email_verified_at = now()');
  const deliver = async (d) => { const r = await fetch(`${base}/api/billing/webhook/fake`, { method: 'POST', headers: { ...d.headers, Origin: 'https://pg.example.com' }, body: d.body }); return r.status; };
  return { db, c, deliver, provider, w: s.json.workspaces[0].id, done: () => { server.close(); delete process.env.ONE_TIME_PAYMENT_MODE; } };
}
const pricingSection = (html) => html.slice(html.indexOf('id="pricing"'), html.indexOf('<!-- CLOSING -->'));

test('one-time mode: Pro 1개월 이용권 + credits for Free, landing without 정기결제 wording', async () => {
  const env = await boot(true);
  try {
    assert.equal((await env.c('GET', '/api/me')).json.features.one_time_payment, true);
    const b = (await env.c('GET', `/api/workspaces/${env.w}/billing`)).json.billing;
    assert.equal(b.flags.one_time, true); assert.equal(b.flags.addons, false); assert.equal(b.checkout.can_purchase, true);

    // Pro 1개월 이용권: one-time order, MONTHLY, 30,000원, named 이용권
    const annual = await env.c('POST', `/api/workspaces/${env.w}/billing/checkout`, { plan: 'PRO', cycle: 'ANNUAL' });
    assert.equal(annual.status, 400);
    const co = await env.c('POST', `/api/workspaces/${env.w}/billing/checkout`, { plan: 'PRO', cycle: 'MONTHLY', extra_users: 5 });
    assert.equal(co.status, 201, JSON.stringify(co.json));
    const order = await env.db.get('SELECT kind, amount, months, cycle, goods_name FROM billing_orders WHERE workspace_id = ? AND kind = ?', [env.w, 'ONE_TIME']);
    assert.equal(order.months, 1); assert.equal(order.cycle, 'MONTHLY'); assert.equal(Number(order.amount), 30000);
    assert.match(order.goods_name, /1개월 이용권/);

    // credits for Free
    const sum = (await env.c('GET', `/api/workspaces/${env.w}/credits/summary`)).json.credits;
    assert.equal(sum.plan, 'FREE'); assert.equal(sum.topup.allowed, true); assert.equal(sum.one_time_mode, true);
    assert.equal((await env.c('POST', `/api/workspaces/${env.w}/credits/checkout`, { amount: 10000 })).status, 201);

    const sec = pricingSection((await env.c('GET', '/')).text);
    assert.match(sec, /data-plan="PRO"/); assert.match(sec, /data-plan="TEAM"/);
    assert.match(sec, /Pro 1개월 이용권 구매/);
    assert.match(sec, /href="\/signup\?next=%2Fapp%2Fbilling%2Fplans%3Fbuy%3DPRO"/);
    // signed in: /signup?next=… goes straight there
    const r = await env.c('GET', '/signup?next=%2Fapp%2Fbilling%2Fplans%3Fbuy%3DPRO');
    assert.equal(r.status, 302);
    assert.equal((sec.match(/data-credit-pack=/g) || []).length, 1);
    assert.match(sec, /10,000원/); assert.match(sec, /href="\/login\?next=%2Fapp%2Fsettings%2Fcredits"/);
    for (const w of ['연간', '정기결제', '자동 결제됩니다', '추가 사용자 1명', '정기결제 준비 중', 'Pro·Team은 필요한 만큼']) assert.ok(!sec.includes(w), `pricing section must not say ${w}`);
  } finally { env.done(); }
});

test('one-time mode off: unchanged', async () => {
  const env = await boot(false);
  try {
    assert.equal((await env.c('GET', '/api/me')).json.features.one_time_payment, false);
    const co = await env.c('POST', `/api/workspaces/${env.w}/billing/checkout`, { plan: 'PRO', cycle: 'MONTHLY' });
    assert.equal(co.status, 409); assert.equal(co.json.error.code, 'checkout_not_open');
    const cr = await env.c('POST', `/api/workspaces/${env.w}/credits/checkout`, { amount: 10000 });
    assert.equal(cr.status, 402); assert.equal(cr.json.error.code, 'AI_TOPUP_PLAN_REQUIRED');
    const sec = pricingSection((await env.c('GET', '/')).text);
    assert.ok(!sec.includes('data-credit-pack')); assert.match(sec, /연간 결제/);
  } finally { env.done(); }
});

test('one-time mode: 해지 환불 = the whole payment, listed in 관리자 › 환불 관리 until marked done by hand', async () => {
  const env = await boot(true);
  try {
    const co = await env.c('POST', `/api/workspaces/${env.w}/billing/checkout`, { plan: 'PRO', cycle: 'MONTHLY' });
    assert.equal(co.status, 201, JSON.stringify(co.json));
    const order = await env.db.get("SELECT id, amount FROM billing_orders WHERE workspace_id = ? AND kind = 'ONE_TIME'", [env.w]);
    assert.equal(await env.deliver(env.provider.signedEvent('subscription.activated', { order_id: order.id, workspace_id: env.w,
      payment: { amount: 30000, currency: 'KRW', status: 'PAID', provider_tid: 'tid_review_1', moid: order.id } })), 200);
    assert.equal((await env.c('GET', `/api/workspaces/${env.w}/billing`)).json.billing.plan, 'PRO');
    const q = (await env.c('GET', `/api/workspaces/${env.w}/billing/refund-quote`)).json.refund;
    assert.equal(q.total, 30000, 'refund = what was paid, not prorated days');
    const cancel = await env.c('POST', `/api/workspaces/${env.w}/billing/cancel`, { refund: true });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.json)); assert.equal(cancel.json.cancel.refund_total, 30000);
    assert.equal(env.provider.calls.refund.length, 0, 'no automatic card cancel');

    await env.db.run("UPDATE users SET system_role = 'SYSTEM_ADMIN'");
    const list = (await env.c('GET', '/api/billing/admin/subscription-refunds')).json;
    assert.equal(list.refunds.length, 1); assert.equal(list.open.n, 1); assert.equal(list.open.amount, 30000);
    const r = list.refunds[0];
    assert.equal(r.amount, 30000); assert.equal(r.paid_amount, 30000); assert.equal(r.status, 'REQUESTED'); assert.equal(r.provider_tid, 'tid_review_1');
    assert.match(r.goods_name, /1개월 이용권/); assert.ok(r.owner_email);
    assert.equal((await env.c('POST', `/api/billing/admin/subscription-refunds/${r.id}/done`, { note: '나이스페이 관리자 전체취소' })).status, 200);
    assert.equal((await env.c('GET', '/api/billing/admin/subscription-refunds')).json.refunds.length, 0);
    const done = (await env.c('GET', '/api/billing/admin/subscription-refunds?status=DONE')).json.refunds[0];
    assert.equal(done.status, 'DONE'); assert.match(done.failure_message, /나이스페이 관리자 전체취소/);
    assert.equal(Number((await env.db.get('SELECT refunded_amount FROM billing_orders WHERE id = ?', [order.id])).refunded_amount), 30000);
    assert.equal((await env.c('POST', `/api/billing/admin/subscription-refunds/${r.id}/reopen`, {})).status, 200);
    assert.equal((await env.c('GET', '/api/billing/admin/subscription-refunds')).json.refunds[0].status, 'REQUESTED');
    assert.equal(Number((await env.db.get('SELECT refunded_amount FROM billing_orders WHERE id = ?', [order.id])).refunded_amount), 0);
  } finally { env.done(); }
});

test('refund policy: within 7 days and unused → full refund; used or after 7 days → no refund, plan runs to the end', async () => {
  const env = await boot(true);
  try {
    const pay = async (tid) => {
      const co = await env.c('POST', `/api/workspaces/${env.w}/billing/checkout`, { plan: 'PRO', cycle: 'MONTHLY' });
      assert.equal(co.status, 201, JSON.stringify(co.json));
      const o = await env.db.get("SELECT id FROM billing_orders WHERE workspace_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1", [env.w]);
      assert.equal(await env.deliver(env.provider.signedEvent('subscription.activated', { order_id: o.id, workspace_id: env.w,
        payment: { amount: 30000, currency: 'KRW', status: 'PAID', provider_tid: tid, moid: o.id } })), 200);
      return o.id;
    };
    const oid = await pay('tid_used_1');
    // a project write after the payment = used
    const pr = await env.c('POST', `/api/workspaces/${env.w}/projects`, project({ name: '결제 후 만든 프로젝트' }));
    assert.ok(pr.status < 300, JSON.stringify(pr.json));
    await new Promise((r) => setTimeout(r, 200));
    const b = (await env.c('GET', `/api/workspaces/${env.w}/billing`)).json.billing;
    assert.equal(b.refund.eligible, false); assert.equal(b.refund.reason, 'used');
    const q = (await env.c('GET', `/api/workspaces/${env.w}/billing/refund-quote`)).json.refund;
    assert.equal(q.total, 0); assert.equal(q.eligible, false);
    const c = await env.c('POST', `/api/workspaces/${env.w}/billing/cancel`, { refund: true });
    assert.equal(c.status, 409); assert.equal(c.json.error.code, 'not_refundable');
    assert.equal((await env.c('GET', `/api/workspaces/${env.w}/billing`)).json.billing.plan, 'PRO', 'still PRO to the end');

    // paid 8 days ago (and nothing used since) → period over
    await env.db.run("UPDATE billing_orders SET paid_at = now() - interval '8 days' WHERE id = ?", [oid]);
    await env.db.run('UPDATE workspaces SET content_changed_at = NULL WHERE id = ?', [env.w]);
    await env.db.run("UPDATE projects SET created_at = now() - interval '9 days' WHERE workspace_id = ?", [env.w]);
    const q2 = (await env.c('GET', `/api/workspaces/${env.w}/billing/refund-quote`)).json.refund;
    assert.equal(q2.eligible, false); assert.equal(q2.reason, 'period_over');
  } finally { env.done(); }
});
