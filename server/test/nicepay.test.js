/* NicePay billing: pricing/quotes, signature + amount checks (unit), and the full one-time / recurring / refund / reminder flow
 * against a stubbed NicePay API (injected fetch). Nothing here reaches NicePay. */
import { test } from 'node:test';
process.env.ONE_TIME_PLANS_ENABLED ??= 'true';   // the retired one-time plan checkout (paid plans = 정기결제 only since 2026-10-20) is still exercised here
import assert from 'node:assert/strict';
process.env.PAYMENTS_ENABLED ??= 'true';   // v1 ships with payments off (PAYMENTS_ENABLED); this suite exercises checkout
import { createHash, createDecipheriv } from 'node:crypto';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { setup, addMember } from './api-helpers.js';
import { quote, foundingEligible, OrderError } from '../billing/orders.js';
import { CYCLES, PLANS } from '../plans.js';
import { createNicepayProvider, nicepayConfig, windowSignature, paymentSignature, encryptCardData, parseCard, NICEPAY_API } from '../billing/nicepay.js';
import { providerFromEnv } from '../billing/provider.js';
import { effectivePlan } from '../billing/subscriptions.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { resetBillingCache } from '../billing-admin.js';
process.env.EARLY_ACCESS_CUTOFF = '2000-01-01T00:00:00Z';   // these suites test FREE/TEAM on fresh workspaces: no early access (AI-credits billing is in credits-billing.test.js)

process.env.PLAN_LIMITS = 'on';
process.env.CRON_SECRET = 'cron-test-secret';
const CLIENT = 'S2_testclient';
const SECRET = 'abcdefghijklmnopqrstuvwxyz012345';   // 32 chars → encMode A2
const ENV = { NICEPAY_CLIENT_KEY: CLIENT, NICEPAY_SECRET_KEY: SECRET };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const DAY = 86400e3;

/** Stub of the NicePay API: records every call, answers like the real one (signed payment objects). */
function stubNicepay() {
  const calls = []; const st = { approveAmount: null, approveThrows: false, chargeDecline: false, seq: 0 };
  const payObj = (o) => { const ediDate = '2026-10-14T12:00:00.000+0900'; const p = { resultCode: '0000', resultMsg: '정상 처리되었습니다.', ediDate, currency: 'KRW', payMethod: 'card',
    card: { cardCode: '04', cardName: '삼성', cardNum: '536112******1234', cardQuota: 0 }, ...o }; return { ...p, signature: paymentSignature(p, SECRET) }; };
  const fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, body, host: u.host, auth: init.headers.Authorization });
    const json = (o) => ({ json: async () => o });
    let m;
    if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/))) {
      if (st.approveThrows) throw new Error('socket hang up');
      return json(payObj({ tid: m[1], orderId: st.orders.get(m[1]), status: 'paid', amount: st.approveAmount ?? body.amount, paidAt: new Date().toISOString() }));
    }
    if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/cancel$/))) return json(payObj({ tid: m[1], cancelledTid: `c_${m[1]}`, orderId: body.orderId, status: 'cancelled', amount: 0 }));
    if (u.pathname === '/v1/payments/netcancel') return json({ resultCode: '0000', resultMsg: 'ok' });
    if (u.pathname === '/v1/subscribe/regist') return json({ ResultCode: '0000', ResultMsg: 'ok', BID: 'BIKY_test_1', cardName: '삼성' });
    if ((m = u.pathname.match(/^\/v1\/subscribe\/([^/]+)\/payments$/))) {
      const tid = `bill_${++st.seq}`;
      return json(st.chargeDecline ? { resultCode: 'F113', resultMsg: '한도초과', tid, orderId: body.orderId, status: 'failed', amount: body.amount }
        : payObj({ tid, orderId: body.orderId, status: 'paid', amount: body.amount }));
    }
    if (/^\/v1\/subscribe\/[^/]+\/expire$/.test(u.pathname)) return json({ resultCode: '0000', resultMsg: 'ok', bid: 'BIKY_test_1' });
    return json({ resultCode: '9999', resultMsg: 'unknown' });
  };
  st.orders = new Map();   // tid → orderId (the payment window binds them)
  return { fetch, calls, st, called: (re) => calls.filter((c) => re.test(c.path)) };
}

async function boot(env = {}) {
  const db = await testDb(); resetBillingCache();
  const np = stubNicepay();
  const provider = createNicepayProvider({ env: { ...ENV, ...env }, fetch: np.fetch });
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text, location: res.headers.get('location') || '' };
    };
  };
  /** NicePay's cross-site form POST to returnUrl: no cookie, foreign Origin. */
  const returnPost = async (form) => {
    const res = await fetch(`${base}/api/billing/nicepay/return`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://pay.nicepay.co.kr' },
      body: new URLSearchParams(form).toString() });
    return { status: res.status, location: res.headers.get('location') || '' };
  };
  /** A valid payment window result for `order` (the authToken/tid NicePay would issue). */
  const windowResult = (order, over = {}) => {
    const tid = `tid_${order.id.slice(-8)}_${Math.random().toString(36).slice(2, 7)}`; np.st.orders.set(tid, order.id);
    const f = { authResultCode: '0000', authResultMsg: '인증 성공', tid, clientId: CLIENT, orderId: order.id, amount: String(order.amount), mallReserved: '', authToken: `tok_${tid}`, ...over };
    return { ...f, signature: over.signature || windowSignature(f, SECRET) };
  };
  const webhook = async (p) => {
    const body = JSON.stringify({ ...p, signature: p.signature || paymentSignature(p, SECRET) });
    const res = await fetch(`${base}/api/billing/webhook/nicepay`, { method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8', Origin: 'https://pay.nicepay.co.kr' }, body });
    return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
  };
  return { db, server, client, np, provider, returnPost, windowResult, webhook, base };
}
const sub = (db, w) => db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [w]);
const months = (from, to) => (new Date(to) - new Date(from)) / (30.4375 * DAY);

test('pricing v3 checkout quote: VAT-inclusive list price, users above the included ones become extra users, Enterprise not sold by checkout', () => {
  const one = quote({ plan: 'PRO', cycle: 'MONTHLY', users: 1 });   // fewer than included → no extra users
  assert.deepEqual([one.extra_users, one.amount, one.supply_amount + one.vat_amount, one.seats], [0, 30000, 30000, 15]);
  const a = quote({ plan: 'TEAM', cycle: 'ANNUAL', users: 42 });
  assert.deepEqual([a.extra_users, a.amount, a.months, a.seats, a.discount_amount], [2, 768000 + 2 * 9600, 12, 42, (80000 + 2000) * 12 - (768000 + 2 * 9600)]);
  assert.equal(CYCLES.ANNUAL.discount_pct, 20); assert.equal(PLANS.PRO.price.MONTHLY, 30000);
  assert.throws(() => quote({ plan: 'PRO', cycle: 'ANNUAL', users: 0 }), OrderError);
  assert.throws(() => quote({ plan: 'PRO', cycle: 'ANNUAL', users: 3.5 }), OrderError);
  assert.throws(() => quote({ plan: 'PRO', cycle: 'WEEKLY', seats: 3 }), OrderError);
  assert.throws(() => quote({ plan: 'ENTERPRISE', cycle: 'ANNUAL', seats: 10 }), OrderError);
  assert.ok(a.goods_name.length <= 40);
});

test('NicePay unit: config/mode guard, signature formulas, return verification (amount, signature, clientId, auth result), card encryption', async () => {
  assert.equal(nicepayConfig(ENV).apiBase, NICEPAY_API.sandbox);
  assert.equal(nicepayConfig({ ...ENV, NICEPAY_MODE: 'live' }).problems.length, 1);                       // sandbox key in live mode
  assert.equal(nicepayConfig({ NICEPAY_CLIENT_KEY: 'R2_live', NICEPAY_SECRET_KEY: SECRET }).problems.length, 1);   // live key, sandbox mode
  assert.equal(nicepayConfig({ NICEPAY_CLIENT_KEY: 'R2_live', NICEPAY_SECRET_KEY: SECRET, NICEPAY_MODE: 'live' }).apiBase, 'https://api.nicepay.co.kr');
  assert.equal(nicepayConfig(ENV).recurringEnabled, false);
  assert.equal(providerFromEnv({ BILLING_PROVIDER: 'nicepay' }), null);                                      // no keys → billing off, app still boots
  assert.equal(providerFromEnv({ BILLING_PROVIDER: 'nicepay', NODE_ENV: 'production', ...ENV }).name, 'nicepay');
  assert.equal(windowSignature({ authToken: 'T', clientId: 'C', amount: '1004' }, 'K'), sha('TC1004K'));
  assert.equal(paymentSignature({ tid: 'X', amount: 1004, ediDate: 'D' }, 'K'), sha('X1004DK'));

  const np = stubNicepay();
  const p = createNicepayProvider({ env: ENV, fetch: np.fetch });
  const order = { id: 'RELAI20261014abc', amount: 594000, goods_name: 'RELAI Team 3석 1년' };
  const good = { authResultCode: '0000', tid: 't1', clientId: CLIENT, orderId: order.id, amount: '594000', authToken: 'tok' };
  const signed = (f) => ({ ...f, signature: windowSignature(f, SECRET) });
  assert.deepEqual(p.verifyReturn(signed(good), order), { tid: 't1' });
  const code = (f) => { try { p.verifyReturn(f, order); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(signed({ ...good, amount: '1000' })), 'amount_mismatch');                    // re-signed by an attacker without the secret key is impossible; amount still checked
  assert.equal(code({ ...signed(good), amount: '1000' }), 'amount_mismatch');
  assert.equal(code({ ...signed(good), signature: 'f'.repeat(64) }), 'invalid_signature');
  assert.equal(code({ ...good, signature: windowSignature(good, 'wrong-secret') }), 'invalid_signature');
  assert.equal(code(signed({ ...good, clientId: 'S2_other' })), 'client_mismatch');
  assert.equal(code(signed({ ...good, orderId: 'other' })), 'order_mismatch');
  assert.equal(code({ ...good, authResultCode: 'U104', authResultMsg: '사용자 취소' }), 'auth_failed');
  assert.equal(code(signed({ ...good, amount: '594000.5' })), 'amount_mismatch');
  // webhook signature
  const pay = { tid: 't1', orderId: order.id, status: 'paid', amount: 594000, ediDate: 'E', resultCode: '0000' };
  await assert.rejects(p.handleWebhook({ rawBody: Buffer.from(JSON.stringify({ ...pay, signature: '0'.repeat(64) })) }), (e) => e.code === 'invalid_signature');
  await assert.rejects(p.handleWebhook({ rawBody: Buffer.from(JSON.stringify({ ...pay, amount: 1, signature: paymentSignature(pay, SECRET) })) }), (e) => e.code === 'invalid_signature');
  const ev = await p.handleWebhook({ rawBody: Buffer.from(JSON.stringify({ ...pay, card: { cardNum: '1234****5678', cardName: '신한' }, signature: paymentSignature(pay, SECRET) })) });
  assert.equal(ev.id, 'paid:t1'); assert.equal(ev.type, 'subscription.activated'); assert.equal(ev.order_id, order.id); assert.equal(ev.payment.amount, 594000);
  assert.ok(!JSON.stringify(ev.payload).includes('1234****5678'));
  // approve: a response whose amount differs from the order is refused and cancelled
  np.st.orders.set('t9', order.id); np.st.approveAmount = 1000;
  await assert.rejects(p.approve({ tid: 't9', order }), (e) => e.code === 'approval_unverified');
  assert.equal(np.called(/\/v1\/payments\/t9\/cancel$/).length, 1);
  assert.equal(np.called(/\/v1\/payments\/t9$/)[0].body.amount, 594000);
  assert.match(np.calls[0].auth, /^Basic /); assert.equal(Buffer.from(np.calls[0].auth.slice(6), 'base64').toString(), `${CLIENT}:${SECRET}`);
  // card data: A2 = AES-256-CBC, key = secret key, iv = first 16 chars
  const { encData, encMode } = encryptCardData('cardNo=1234567890123456&expYear=29&expMonth=12&idNo=800101&cardPw=12', SECRET);
  const d = createDecipheriv('aes-256-cbc', Buffer.from(SECRET), Buffer.from(SECRET.slice(0, 16)));
  assert.equal(encMode, 'A2'); assert.equal(Buffer.concat([d.update(Buffer.from(encData, 'hex')), d.final()]).toString(), 'cardNo=1234567890123456&expYear=29&expMonth=12&idNo=800101&cardPw=12');
  assert.throws(() => parseCard({ number: '1234', expiry: '13/29', id_no: '1', password2: 'ab' }), (e) => Object.keys(e.fields).length === 4);
});

test('one-time checkout: order priced on the server, pay page, signed return → approve → TEAM for 12 months; replay/webhook idempotent; tampering refused', async () => {
  const { db, server, client, np, returnPost, windowResult, webhook } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  await db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // paying needs a verified e-mail (requireVerifiedEmail)
  const M = await addMember(client, A, 'm@x.com', '멤버');
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b.checkout.can_purchase, true); assert.equal(b.checkout.min_users, 15);   // PRO includes 15 users
  assert.deepEqual([b.catalogue.plans.find((p) => p.key === 'PRO').price.MONTHLY, b.catalogue.plans.find((p) => p.key === 'PRO').addons.user.MONTHLY], [30000, 1000]);
  assert.equal(b.plans.find((p) => p.key === 'ENTERPRISE').price, null);   // Enterprise: no price, contact sales
  assert.equal(b.checkout.recurring_available, false); assert.equal(b.checkout.sandbox, true);
  assert.deepEqual(b.plans.map((p) => p.key), ['FREE', 'PRO', 'TEAM', 'ENTERPRISE']);
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing/quote?plan=PRO&cycle=MONTHLY&extra_users=2`)).json.quote.amount, 32000);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', extra_users: -1 })).status, 400);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'ENTERPRISE' })).status, 400);
  assert.equal((await M.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM' })).status, 403);
  const co = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', seats: 3, amount: 1 });   // client amount ignored
  assert.equal(co.status, 201); assert.equal(co.json.order.amount, 768000); assert.equal(co.json.order.founding, false);
  assert.match(co.json.checkout_url, /^\/api\/billing\/nicepay\/pay\/RELAI\d{8}[0-9a-f]{18}$/);
  const order = await db.get('SELECT * FROM billing_orders WHERE id = ?', [co.json.session_id]);
  // pay page: buyer only; carries the server amount and the sandbox client key, never the secret
  const page = await A.c('GET', co.json.checkout_url);
  assert.equal(page.status, 200); assert.ok(page.text.includes('"amount":768000')); assert.ok(page.text.includes(CLIENT)); assert.ok(!page.text.includes(SECRET));
  assert.ok(page.text.includes('/api/billing/nicepay/return')); assert.ok(page.text.includes('https://pay.nicepay.co.kr/v1/js/'));
  assert.equal((await M.c('GET', co.json.checkout_url)).status, 404);
  assert.equal((await client()('GET', co.json.checkout_url)).status, 302);
  // tampered amount (window says 1000) → refused before any approval
  let r = await returnPost(windowResult(order, { amount: '1000' }));
  assert.equal(r.status, 303); assert.match(r.location, /checkout=failed&reason=amount_mismatch/);
  assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 0);
  assert.equal((await db.get('SELECT status FROM billing_orders WHERE id = ?', [order.id])).status, 'FAILED');
  // a fresh order; bad signature → refused, no approval
  const co2 = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', seats: 3 });
  const order2 = await db.get('SELECT * FROM billing_orders WHERE id = ?', [co2.json.session_id]);
  r = await returnPost(windowResult(order2, { signature: 'a'.repeat(64) }));
  assert.match(r.location, /reason=invalid_signature/); assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 0);
  // user closed / failed authentication
  const co3 = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', seats: 3 });
  const order3 = await db.get('SELECT * FROM billing_orders WHERE id = ?', [co3.json.session_id]);
  assert.match((await returnPost({ authResultCode: 'U104', authResultMsg: '취소', orderId: order3.id, clientId: CLIENT, amount: String(order3.amount) })).location, /checkout=canceled/);
  // the real thing
  const co4 = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', seats: 3 });
  const order4 = await db.get('SELECT * FROM billing_orders WHERE id = ?', [co4.json.session_id]);
  const form = windowResult(order4);
  r = await returnPost(form);
  assert.equal(r.location, '/app/settings?checkout=success#billing');
  const approves = np.called(/^\/v1\/payments\/[^/]+$/); assert.equal(approves.length, 1); assert.equal(approves[0].body.amount, 768000); assert.equal(approves[0].host, 'sandbox-api.nicepay.co.kr');
  let s = await sub(db, A.w);
  assert.equal(s.status, 'ACTIVE'); assert.equal(s.plan, 'TEAM'); assert.equal(s.seats, 40); assert.equal(s.billing_cycle, 'ANNUAL'); assert.equal(s.auto_renew, false);
  assert.equal(s.next_billing_at, null); assert.ok(Math.abs(months(new Date(), s.current_period_end) - 12) < 0.2); assert.equal(s.founding_until, null);
  assert.equal(s.payment_method_summary, '삼성 ****1234');
  assert.equal(await effectivePlan(db, A.w), 'TEAM');
  const pay = await db.get('SELECT * FROM payments WHERE workspace_id = ?', [A.w]);
  assert.equal(Number(pay.amount), 768000); assert.equal(pay.status, 'PAID'); assert.equal(pay.moid, order4.id);
  // replayed return and NicePay's own webhook for the same payment: no second approval, no second period
  assert.equal((await returnPost(form)).location, '/app/settings?checkout=success#billing');
  const hook = await webhook({ resultCode: '0000', tid: form.tid, orderId: order4.id, status: 'paid', amount: 768000, ediDate: 'E1' });
  assert.equal(hook.status, 200); assert.equal(hook.text, 'OK'); assert.match(hook.type, /text\/html/);
  assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM payments')).n, 1);
  assert.equal(new Date((await sub(db, A.w)).current_period_end).getTime(), new Date(s.current_period_end).getTime());
  assert.equal((await webhook({ resultCode: '0000', tid: 'x', orderId: order4.id, status: 'paid', amount: 1, ediDate: 'E', signature: 'b'.repeat(64) })).status, 400);
  // a paid notification whose amount does not match its order is recorded and ignored (e.g. a client-approval key by mistake)
  const co5 = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3 });
  assert.equal((await webhook({ resultCode: '0000', tid: 'tid_bad', orderId: co5.json.session_id, status: 'paid', amount: 100, ediDate: 'E2' })).text, 'OK');
  assert.equal((await db.get(`SELECT result FROM billing_events WHERE provider_event_id = 'paid:tid_bad'`)).result, 'IGNORED:amount_mismatch');
  assert.equal(new Date((await sub(db, A.w)).current_period_end).getTime(), new Date(s.current_period_end).getTime());
  // seats: TEAM includes 40 users
  await addMember(client, A, 'b@x.com', '박나다');
  await client()('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '최다라', email: 'c@x.com', password: 'passw0rd!' });
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing.usage.dims.find((d) => d.key === 'members').limit, 40);
  // one-time: nothing to cancel; extension allowed and continues from the current end (1 month)
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {})).json.error.code, 'not_recurring');
  const b2 = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b2.checkout.can_purchase, true); assert.ok(!('billing_key_enc' in b2.subscription));
  const ext = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 41 });
  assert.equal(ext.status, 201);
  const extOrder = await db.get('SELECT * FROM billing_orders WHERE id = ?', [ext.json.session_id]);
  assert.equal((await returnPost(windowResult(extOrder))).location, '/app/settings?checkout=success#billing');
  s = await sub(db, A.w);
  assert.ok(Math.abs(months(new Date(), s.current_period_end) - 13) < 0.2); assert.equal(s.seats, 41);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/members`, { email: 'c@x.com', role: 'MEMBER' })).status, 201);
  // period over → FREE without any provider event (no auto-renew)
  await db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 second' WHERE workspace_id = ?`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'FREE');
  void M; server.close();
});

test('approval network failure → net cancel, order failed; refund by operator shortens the period; renewal reminder 7 days before, once', async () => {
  const { db, server, client, np, returnPost, windowResult } = await boot();
  const mail = fakeEmailProvider(); setEmailProvider(mail);
  const A = await setup(client, 'a@x.com', '김가나');
  await db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // paying needs a verified e-mail (requireVerifiedEmail)
  const buy = async (cycle) => { const co = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle, seats: 3 }); return db.get('SELECT * FROM billing_orders WHERE id = ?', [co.json.session_id]); };
  np.st.approveThrows = true;
  const o1 = await buy('ANNUAL');
  assert.match((await returnPost(windowResult(o1))).location, /reason=provider_unavailable/);
  assert.equal(np.called(/netcancel$/).length, 1); assert.equal(np.called(/netcancel$/)[0].body.orderId, o1.id);
  assert.equal((await sub(db, A.w)), undefined);
  np.st.approveThrows = false;
  const o2 = await buy('ANNUAL'); await returnPost(windowResult(o2));
  const o3 = await buy('MONTHLY'); await returnPost(windowResult(o3));
  let s = await sub(db, A.w); assert.ok(Math.abs(months(new Date(), s.current_period_end) - 13) < 0.2);
  // operator refund of the 1-month extension
  const ops = client(); const u = await ops('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email: 'ops@relai.io', password: 'passw0rd!' });
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [u.json.user.id]);
  const p3 = await db.get('SELECT id FROM payments WHERE moid = ?', [o3.id]);
  assert.equal((await A.c('POST', `/api/billing/admin/payments/${p3.id}/refund`, { reason: '중복 결제' })).status, 403);
  assert.equal((await ops('POST', `/api/billing/admin/payments/${p3.id}/refund`, {})).status, 400);
  const rf = await ops('POST', `/api/billing/admin/payments/${p3.id}/refund`, { reason: '중복 결제' });
  assert.equal(rf.status, 200, JSON.stringify(rf.json));
  assert.equal(np.called(/\/cancel$/)[0].body.orderId, o3.id);
  assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [p3.id])).status, 'REFUNDED');
  assert.equal((await db.get('SELECT status FROM billing_orders WHERE id = ?', [o3.id])).status, 'REFUNDED');
  s = await sub(db, A.w); assert.equal(s.status, 'ACTIVE'); assert.ok(Math.abs(months(new Date(), s.current_period_end) - 12) < 0.2);
  assert.equal((await ops('POST', `/api/billing/admin/payments/${p3.id}/refund`, { reason: 'again' })).status, 409);
  assert.equal((await db.get(`SELECT COUNT(*) n FROM admin_audit_logs WHERE action = 'REFUND_PAYMENT'`)).n, 1);
  // reminder: not yet due; then 6 days left → one mail per OWNER, once per period end
  const cron = (auth) => fetch(`http://127.0.0.1:${server.address().port}/api/billing/cron/daily`, { headers: auth ? { Authorization: auth } : {} }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await cron()).status, 401); assert.equal((await cron('Bearer nope')).status, 401);
  assert.equal((await cron('Bearer cron-test-secret')).json.reminders.sent, 0);
  await db.run(`UPDATE subscriptions SET current_period_end = now() + interval '6 days' WHERE workspace_id = ?`, [A.w]);
  const c1 = await cron('Bearer cron-test-secret');
  assert.equal(c1.json.reminders.sent, 1); assert.equal(c1.json.renewals.skipped, 'recurring_disabled');
  assert.equal(mail.last().to, 'a@x.com'); assert.match(mail.last().subject, /Team 플랜 이용 기간이/);
  assert.equal((await cron('Bearer cron-test-secret')).json.reminders.sent, 0);
  // a refund that leaves no paid time ends the plan now
  const p2 = await db.get('SELECT id FROM payments WHERE moid = ?', [o2.id]);
  await ops('POST', `/api/billing/admin/payments/${p2.id}/refund`, { reason: '환불 요청' });
  assert.equal((await sub(db, A.w)).status, 'CANCELED'); assert.equal(await effectivePlan(db, A.w), 'FREE');
  setEmailProvider(null); server.close();
});

test('founding offer retired (pricing v3): never eligible', async () => {
  const db = await testDb();
  await db.run(`INSERT INTO users (id, email, name) VALUES ('u_f', 'f@x.com', 'F')`);
  await db.run(`INSERT INTO workspaces (id, name, owner_id) VALUES ('ws_f', 'W', 'u_f')`);
  assert.equal(await foundingEligible(db, 'ws_f'), false);
});

test('recurring (정기결제) is off by default; when enabled: billing key, first charge, daily renewal charge, decline → PAST_DUE, cancel expires the key', async () => {
  const off = await boot();
  const A0 = await setup(off.client, 'z@x.com', '정기');
  await off.db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // paying needs a verified e-mail (requireVerifiedEmail)
  const card = { number: '1234-5678-9012-3456', expiry: '12/29', id_no: '800101', password2: '12' };
  assert.equal((await A0.c('POST', `/api/workspaces/${A0.w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3, card })).status, 404);
  assert.equal(off.np.calls.length, 0);
  off.server.close();

  const { db, server, client, np } = await boot({ NICEPAY_RECURRING_ENABLED: 'true' });
  const A = await setup(client, 'a@x.com', '김가나');
  await db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // paying needs a verified e-mail (requireVerifiedEmail)
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing.checkout.recurring_available, true);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3, card: { ...card, number: '12' } })).status, 400);
  // 정기결제 고지 · 동의 (T3): without the consent → 400 consent_required + the disclosure; a stale hash → consent_stale
  const noConsent = await A.c('POST', `/api/workspaces/${A.w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3, card });
  assert.equal(noConsent.status, 400); assert.equal(noConsent.json.error.code, 'consent_required'); assert.ok(noConsent.json.error.disclosure.hash);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3, card, agree: true, disclosure_hash: 'x' })).json.error.code, 'consent_stale');
  const hash = (await A.c('GET', `/api/workspaces/${A.w}/billing/quote?plan=TEAM&cycle=MONTHLY&seats=3`)).json.disclosure.hash;
  assert.equal(np.called(/regist$/).length, 0);   // nothing reached NicePay before the consent
  const r = await A.c('POST', `/api/workspaces/${A.w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3, card, agree: true, disclosure_hash: hash });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const consent = await db.get('SELECT * FROM billing_consents WHERE workspace_id = ?', [A.w]);
  assert.equal(consent.kind, 'CHECKOUT'); assert.equal(consent.disclosure_hash, hash); assert.equal(consent.amount, 80000); assert.equal(consent.renewal_amount, 80000);
  assert.equal(r.json.billing.plan, 'TEAM'); assert.equal(r.json.billing.subscription.auto_renew, true); assert.ok(!JSON.stringify(r.json).includes('BIKY'));
  const reg = np.called(/regist$/)[0]; assert.equal(reg.body.encMode, 'A2'); assert.ok(!JSON.stringify(reg.body).includes('1234567890123456'));
  assert.equal(np.called(/subscribe\/BIKY_test_1\/payments$/)[0].body.amount, 80000);   // pricing v3: Team monthly, VAT included
  let s = await sub(db, A.w);
  assert.ok(s.billing_key_enc && !s.billing_key_enc.includes('BIKY')); assert.ok(s.next_billing_at);
  assert.ok(!JSON.stringify((await db.all('SELECT payload FROM billing_events'))).includes('BIKY'));
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', seats: 3 })).status, 409);
  // renewal due → charged by the daily cron, period +1 month
  await db.run(`UPDATE subscriptions SET next_billing_at = now() - interval '1 minute', current_period_end = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  const cron = () => fetch(`http://127.0.0.1:${server.address().port}/api/billing/cron/daily`, { headers: { Authorization: 'Bearer cron-test-secret' } }).then((x) => x.json());
  assert.deepEqual((await cron()).renewals, { due: 1, paid: 1, failed: 0, blocked: 0 });
  s = await sub(db, A.w); assert.ok(Math.abs(months(new Date(), s.current_period_end) - 1) < 0.1); assert.equal(s.status, 'ACTIVE');
  assert.deepEqual((await cron()).renewals, { due: 0, paid: 0, failed: 0, blocked: 0 });
  // decline → PAST_DUE with grace; retried the next day only
  np.st.chargeDecline = true;
  await db.run(`UPDATE subscriptions SET next_billing_at = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  assert.deepEqual((await cron()).renewals, { due: 1, paid: 0, failed: 1, blocked: 0 });
  s = await sub(db, A.w); assert.equal(s.status, 'PAST_DUE'); assert.ok(new Date(s.next_billing_at) > new Date());
  assert.equal((await cron()).renewals.due, 0);
  // OWNER cancel: billing key expired at NicePay (outside the DB transaction), no more renewals
  const c = await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {});
  assert.equal(c.status, 200); assert.equal(np.called(/subscribe\/BIKY_test_1\/expire$/).length, 1);
  s = await sub(db, A.w); assert.equal(s.billing_key_enc, null); assert.equal(s.cancel_at_period_end, true);
  server.close();
});
