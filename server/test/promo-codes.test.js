/* 프로모션 코드 (founder 2026-10-26): operator creates / stops codes; CREDITS and FREE_MONTHS are redeemed in 설정; PERCENT / AMOUNT
 * discount a 1개월 이용권 checkout (counted once the order is paid); once per workspace; limits, dates and stop are enforced. Fake billing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { createFakeProvider } from '../billing/provider.js';
import { resetBillingCache } from '../billing-admin.js';

process.env.PAYMENTS_ENABLED = 'true';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';

async function boot() {
  process.env.ONE_TIME_PAYMENT_MODE = 'true';
  const db = await testDb(); resetBillingCache();
  const provider = createFakeProvider();
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json };
    };
  };
  const signup = async (email) => {
    const c = client();
    const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김코드', email, password: 'passw0rd!' });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [s.json.user.id]);
    return { c, w: s.json.workspaces[0].id, uid: s.json.user.id };
  };
  const deliver = async (d) => (await fetch(`${base}/api/billing/webhook/fake`, { method: 'POST', headers: { ...d.headers, Origin: 'https://pg.example.com' }, body: d.body })).status;
  return { db, provider, signup, deliver, done: () => { server.close(); delete process.env.ONE_TIME_PAYMENT_MODE; } };
}

test('operator creates and stops codes; CREDITS and FREE_MONTHS redeem once per workspace', async () => {
  const t = await boot();
  try {
    const admin = await t.signup('op@relai.kr');
    await t.db.run("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [admin.uid]);
    assert.equal((await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'a', kind: 'PERCENT', value: 20 })).status, 400);
    assert.equal((await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'X1', kind: 'PERCENT', value: 120 })).json.error.fields.value.length > 0, true);
    const w500 = await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'welcome500', kind: 'CREDITS', value: 500 });
    assert.equal(w500.status, 201); assert.equal(w500.json.code.code, 'WELCOME500'); assert.equal(w500.json.code.benefit, '크레딧 500');
    assert.equal((await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'WELCOME500', kind: 'CREDITS', value: 1 })).status, 409);
    await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'PRO1M', kind: 'FREE_MONTHS', value: 1, plan: 'PRO', max_uses: 1 });
    await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'LAUNCH20', kind: 'PERCENT', value: 20 });

    const A = await t.signup('a@x.com');
    const bal0 = (await A.c('GET', `/api/workspaces/${A.w}/credits/summary`)).json.credits.balance;
    const r1 = await A.c('POST', `/api/workspaces/${A.w}/promo-codes/redeem`, { code: 'welcome500' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r1.json.redeemed.credits, 500);
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/credits/summary`)).json.credits.balance, bal0 + 500);
    const again = await A.c('POST', `/api/workspaces/${A.w}/promo-codes/redeem`, { code: 'WELCOME500' });
    assert.equal(again.status, 409); assert.equal(again.json.error.code, 'promo_used');
    // a discount code is entered in the purchase dialog, not here
    assert.equal((await A.c('POST', `/api/workspaces/${A.w}/promo-codes/redeem`, { code: 'LAUNCH20' })).json.error.code, 'promo_wrong_place');
    // unknown → the same generic refusal
    assert.equal((await A.c('POST', `/api/workspaces/${A.w}/promo-codes/redeem`, { code: 'NOPE99' })).json.error.code, 'promo_unusable');

    const fm = await A.c('POST', `/api/workspaces/${A.w}/promo-codes/redeem`, { code: 'PRO1M' });
    assert.equal(fm.status, 200, JSON.stringify(fm.json)); assert.equal(fm.json.redeemed.kind, 'FREE_MONTHS');
    const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
    assert.equal(b.plan, 'PRO'); assert.equal(b.auto_renew, false);
    assert.equal(b.refund.eligible, false, 'a free pass has nothing to refund');
    // max_uses 1 → the next workspace is refused; then the operator stops WELCOME500
    const B = await t.signup('b@x.com');
    assert.equal((await B.c('POST', `/api/workspaces/${B.w}/promo-codes/redeem`, { code: 'PRO1M' })).json.error.code, 'promo_unusable');
    const list = (await admin.c('GET', '/api/billing/admin/promo-codes')).json.codes;
    const pro1m = list.find((c) => c.code === 'PRO1M'); assert.equal(pro1m.used_count, 1); assert.equal(pro1m.status, 'USED_UP');
    const welcome = list.find((c) => c.code === 'WELCOME500');
    assert.equal((await admin.c('POST', `/api/billing/admin/promo-codes/${welcome.id}/stop`, {})).json.code.status, 'STOPPED');
    assert.equal((await B.c('POST', `/api/workspaces/${B.w}/promo-codes/redeem`, { code: 'WELCOME500' })).json.error.code, 'promo_unusable');
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/promo-codes`)).json.redemptions.length, 2);
    // non-admin cannot list codes
    assert.equal((await A.c('GET', '/api/billing/admin/promo-codes')).status, 403);
  } finally { t.done(); }
});

test('discount code: quote shows the net amount, the window charges it, the use counts once the order is paid', async () => {
  const t = await boot();
  try {
    const admin = await t.signup('op2@relai.kr');
    await t.db.run("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [admin.uid]);
    await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'LAUNCH20', kind: 'PERCENT', value: 20 });
    await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'SAVE50K', kind: 'AMOUNT', value: 50000 });
    await admin.c('POST', '/api/billing/admin/promo-codes', { code: 'LATER', kind: 'PERCENT', value: 10, starts_on: '2099-01-01' });
    const A = await t.signup('c@x.com');
    const q = (await A.c('GET', `/api/workspaces/${A.w}/billing/quote?plan=PRO&cycle=MONTHLY&promo_code=launch20`)).json.quote;
    assert.equal(q.total, 24000); assert.equal(q.promo.discount, 6000); assert.equal(q.supply + q.vat, 24000);
    // 50,000원 off a 30,000원 pass would leave nothing → refused; a code that has not started yet → generic refusal
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing/quote?plan=PRO&cycle=MONTHLY&promo_code=SAVE50K`)).json.error.code, 'promo_too_large');
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing/quote?plan=PRO&cycle=MONTHLY&promo_code=LATER`)).json.error.code, 'promo_unusable');

    const co = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'PRO', cycle: 'MONTHLY', promo_code: 'LAUNCH20' });
    assert.equal(co.status, 201, JSON.stringify(co.json));
    const order = await t.db.get("SELECT * FROM billing_orders WHERE workspace_id = ? AND kind = 'ONE_TIME'", [A.w]);
    assert.equal(Number(order.amount), 24000); assert.equal(Number(order.promo_discount), 6000); assert.ok(order.promo_code_id);
    assert.equal(Number((await t.db.get("SELECT used_count FROM promo_codes WHERE code = 'LAUNCH20'")).used_count), 0, 'not counted before payment');
    assert.equal(await t.deliver(t.provider.signedEvent('subscription.activated', { order_id: order.id, workspace_id: A.w,
      payment: { amount: 24000, currency: 'KRW', status: 'PAID', provider_tid: 'tid_promo_1', moid: order.id } })), 200);
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing.plan, 'PRO');
    assert.equal(Number((await t.db.get("SELECT used_count FROM promo_codes WHERE code = 'LAUNCH20'")).used_count), 1);
    const red = await t.db.get('SELECT * FROM promo_redemptions WHERE workspace_id = ?', [A.w]);
    assert.equal(red.discount_amount, 6000); assert.equal(red.order_id, order.id);
    // used: the same workspace cannot apply it again
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing/quote?plan=PRO&cycle=MONTHLY&promo_code=LAUNCH20`)).json.error.code, 'promo_used');
    // 7-day unused refund = what was actually paid
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing/refund-quote`)).json.refund.total, 24000);
  } finally { t.done(); }
});
