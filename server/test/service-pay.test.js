/* RELAI 서비스 결제 (/pay/agent): public page, catalogue-only amounts (tamper rejected), idempotent approve + webhook, receipt
 * e-mail once, 월 구독 off → nothing called, 관리자 list. NicePay is a stubbed fetch: nothing here reaches NicePay. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { setup } from './api-helpers.js';
import { createNicepayProvider, windowSignature, paymentSignature } from '../billing/nicepay.js';
import { SERVICE_PRODUCTS, serviceOrdersDaily } from '../billing/service-orders.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { LEGAL } from '../../public/app/shared/legal-info.js';

const CLIENT = 'S2_testclient';
const SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const ENV = { NICEPAY_CLIENT_KEY: CLIENT, NICEPAY_SECRET_KEY: SECRET };
process.env.SERVICE_PAY_ENABLED = 'true';   // checkout is opt-in (review P1-1); the closed state is tested below

function stubNicepay() {
  const calls = []; const st = { approveAmount: null, orders: new Map(), approveDelay: 0, onApprove: null, cancelFails: false };
  const payObj = (o) => { const p = { resultCode: '0000', resultMsg: '정상 처리되었습니다.', ediDate: '2026-10-20T12:00:00.000+0900', currency: 'KRW', payMethod: 'card',
    card: { cardCode: '04', cardName: '삼성', cardNum: '536112******1234', cardQuota: 0 }, ...o }; return { ...p, signature: paymentSignature(p, SECRET) }; };
  const fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ path: u.pathname, body });
    const json = (o) => ({ json: async () => o }); let m;
    if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/))) {
      if (st.approveDelay) await new Promise((r) => setTimeout(r, st.approveDelay));
      if (st.onApprove) await st.onApprove(st.orders.get(m[1]));
      return json(payObj({ tid: m[1], orderId: st.orders.get(m[1]), status: 'paid', amount: st.approveAmount ?? body.amount, paidAt: new Date().toISOString() }));
    }
    if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/cancel$/))) return st.cancelFails ? json({ resultCode: '2015', resultMsg: '취소 실패' }) : json(payObj({ tid: m[1], cancelledTid: `c_${m[1]}`, orderId: body.orderId, status: 'cancelled', amount: 0 }));
    return json({ resultCode: '9999', resultMsg: 'unknown' });
  };
  return { fetch, calls, st, called: (re) => calls.filter((c) => re.test(c.path)) };
}

async function boot(env = {}) {
  const db = await testDb();
  const np = stubNicepay();
  const provider = createNicepayProvider({ env: { ...ENV, ...env }, fetch: np.fetch });
  const mail = fakeEmailProvider(); setEmailProvider(mail);
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text, location: res.headers.get('location') || '' };
    };
  };
  const returnPost = async (form) => {
    const res = await fetch(`${base}/api/service-pay/nicepay/return`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://pay.nicepay.co.kr' }, body: new URLSearchParams(form).toString() });
    return { status: res.status, location: res.headers.get('location') || '' };
  };
  const windowResult = (order, over = {}) => {
    const tid = `tid_${order.id.slice(-8)}_${Math.random().toString(36).slice(2, 7)}`; np.st.orders.set(tid, order.id);
    const f = { authResultCode: '0000', authResultMsg: '인증 성공', tid, clientId: CLIENT, orderId: order.id, amount: String(order.amount), authToken: `tok_${tid}`, ...over };
    return { ...f, signature: over.signature || windowSignature(f, SECRET) };
  };
  const webhook = async (p) => {
    const body = JSON.stringify({ ...p, signature: paymentSignature(p, SECRET) });
    const res = await fetch(`${base}/api/billing/webhook/nicepay`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://pay.nicepay.co.kr' }, body });
    return { status: res.status, text: await res.text() };
  };
  return { db, server, client, np, mail, returnPost, windowResult, webhook };
}
const BUYER = { name: '김하늘', company: '한빛제약', email: 'buyer@example.com', phone: '010-1234-5678' };
const ORDER = (o = {}) => ({ product: 'agent-once', buyer: BUYER, agree_terms: true, agree_privacy: true, agree_payment: true, ...o });
const visible = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

test('catalogue: exactly two products, 400,000원 VAT included', () => {
  assert.deepEqual(Object.keys(SERVICE_PRODUCTS), ['agent-once', 'agent-monthly']);
  for (const p of Object.values(SERVICE_PRODUCTS)) { assert.equal(p.amount, 400000); assert.equal(p.supply_amount + p.vat_amount, 400000); }
  assert.equal(SERVICE_PRODUCTS['agent-once'].title, 'AI Agent 개발 및 운영');
  assert.equal(SERVICE_PRODUCTS['agent-monthly'].title, 'AI Agent 개발 및 운영 월 구독');
});

test('GET /pay/agent: public (no login), both cards, consents, notes, business footer, ?plan selects a card, no sample/test words', async () => {
  const { server, client } = await boot();
  try {
    const c = client();
    const r = await c('GET', '/pay/agent?plan=once&product=agent');
    assert.equal(r.status, 200);
    for (const s of ['relai', '서비스 결제', 'AI Agent 개발 및 운영', 'AI Agent 개발 및 운영 월 구독', '400,000원', '결제 전 확인해주세요', '이용약관', '개인정보처리방침',
      '개인정보 수집·이용', '결제 진행', '회사명', '연락처', LEGAL.bizNo, LEGAL.mailOrderNo, LEGAL.contactEmail, '카드번호', '유효기간', '정기결제에 동의']) assert.ok(r.text.includes(s), s);
    assert.match(r.text, /data-selected="agent-once"/);
    assert.doesNotMatch(visible(r.text), /sample|test|샘플|테스트/i);
    assert.match((await c('GET', '/pay/agent?plan=monthly&product=agent')).text, /data-selected="agent-monthly"/);
    assert.match((await c('GET', '/pay/agent?plan=monthly&product=agent')).text, /data-recurring="0"/);
    const done = await c('GET', '/pay/agent/failed?reason=canceled');
    assert.equal(done.status, 200); assert.match(done.text, /결제가 취소되었습니다/);
  } finally { server.close(); }
});

test('order: consents + buyer fields required; amount always from the catalogue (client amount ignored)', async () => {
  const { db, server, client } = await boot();
  try {
    const c = client();
    const bad = await c('POST', '/api/service-pay/orders', ORDER({ agree_payment: false, buyer: { ...BUYER, email: 'nope', phone: '1' } }));
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.json.error.fields).sort(), ['agree_payment', 'email', 'phone']);
    assert.equal((await c('POST', '/api/service-pay/orders', ORDER({ product: 'agent-gold' }))).status, 400);
    const r = await c('POST', '/api/service-pay/orders', ORDER({ amount: 1000, price: 1000 }));
    assert.equal(r.status, 201);
    assert.equal(r.json.order.amount, 400000);
    assert.equal(r.json.pay.amount, 400000);
    assert.equal(r.json.pay.clientId, CLIENT);
    assert.match(r.json.pay.returnUrl, /\/api\/service-pay\/nicepay\/return$/);
    const row = await db.get('SELECT * FROM service_orders WHERE id = ?', [r.json.order.id]);
    assert.deepEqual([row.amount, row.status, row.buyer_name, row.buyer_company, row.buyer_email, row.buyer_phone, row.terms_version], [400000, 'PENDING', '김하늘', '한빛제약', 'buyer@example.com', '010-1234-5678', LEGAL.termsVersion]);
  } finally { server.close(); }
});

test('amount tamper: a window result for another amount is rejected without approving; an approval for another amount is refunded', async () => {
  const { db, server, client, np, returnPost, windowResult } = await boot();
  try {
    const c = client();
    const o1 = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    const r1 = await returnPost(windowResult({ ...o1, amount: 1000 }));   // window re-signed for 1,000원 (attacker-chosen amount)
    assert.equal(r1.status, 303); assert.match(r1.location, /^\/pay/agent\/failed\?reason=amount_mismatch/);
    assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 0, 'never approved');
    assert.equal((await db.get('SELECT status FROM service_orders WHERE id = ?', [o1.id])).status, 'FAILED');

    const o2 = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    np.st.approveAmount = 1000;   // NicePay answers with a different amount → refund, never PAID
    const r2 = await returnPost(windowResult(o2));
    np.st.approveAmount = null;
    assert.match(r2.location, /^\/pay/agent\/failed/);
    assert.equal(np.called(/\/cancel$/).length, 1);
    assert.notEqual((await db.get('SELECT status FROM service_orders WHERE id = ?', [o2.id])).status, 'PAID');
  } finally { server.close(); }
});

test('approve is idempotent: replayed return and the NicePay webhook for the same payment apply once, one receipt e-mail; done page shows order + amount', async () => {
  const { db, server, client, np, mail, returnPost, windowResult, webhook } = await boot();
  try {
    const c = client();
    const o = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    const form = windowResult(o);
    const r = await returnPost(form);
    assert.equal(r.status, 303); assert.equal(r.location, `/pay/agent/done?order=${o.id}`);
    const row = await db.get('SELECT * FROM service_orders WHERE id = ?', [o.id]);
    assert.deepEqual([row.status, row.provider_tid, row.payment_method_summary], ['PAID', form.tid, '삼성 ****1234']);
    assert.ok(row.receipt_email_sent_at);
    assert.equal((await returnPost(form)).location, `/pay/agent/done?order=${o.id}`);   // replay
    assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 1, 'approved once');
    const paid = { resultCode: '0000', resultMsg: 'ok', tid: form.tid, orderId: o.id, status: 'paid', amount: 400000, ediDate: '2026-10-20T12:00:01.000+0900', payMethod: 'card' };
    const w = await webhook(paid); assert.equal(w.status, 200); assert.equal(w.text, 'OK');
    assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM billing_events WHERE provider_event_id = ?`, [`paid:${form.tid}`])).n), 1);
    const receipts = mail.find((m) => m.to === 'buyer@example.com');
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].subject, new RegExp(o.id)); assert.match(receipts[0].text, /400,000원/);
    assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM email_deliveries WHERE type = 'SERVICE_RECEIPT'`)).n), 1);
    const done = await c('GET', `/pay/agent/done?order=${o.id}`);
    assert.equal(done.status, 200); assert.match(done.text, /결제가 완료되었습니다/); assert.ok(done.text.includes(o.id)); assert.match(done.text, /400,000원/);
    // webhook refund → REFUNDED (in-app subscriptions untouched)
    const refunded = await webhook({ resultCode: '0000', tid: form.tid, cancelledTid: `c_${form.tid}`, orderId: o.id, status: 'cancelled', amount: 0, ediDate: '2026-10-21T09:00:00.000+0900' });
    assert.equal(refunded.status, 200);
    assert.equal((await db.get('SELECT status FROM service_orders WHERE id = ?', [o.id])).status, 'REFUNDED');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM subscriptions')).n), 0);
  } finally { server.close(); }
});

test('canceled window → failure page, nothing approved', async () => {
  const { server, client, np, returnPost, windowResult } = await boot();
  try {
    const o = (await client()('POST', '/api/service-pay/orders', ORDER())).json.order;
    const r = await returnPost(windowResult(o, { authResultCode: 'U310', authResultMsg: '사용자 취소' }));
    assert.match(r.location, /^\/pay/agent\/failed\?reason=canceled/);
    assert.equal(np.calls.length, 0);
  } finally { server.close(); }
});

test('월 구독 while NICEPAY_RECURRING_ENABLED is off: refused, no order row, no NicePay call', async () => {
  const { db, server, client, np } = await boot();
  try {
    const c = client();
    const a = await c('POST', '/api/service-pay/orders', ORDER({ product: 'agent-monthly' }));
    assert.equal(a.status, 409); assert.equal(a.json.error.message, '월 구독은 준비 중입니다.');
    const b = await c('POST', '/api/service-pay/subscriptions', { product: 'agent-monthly', card: { number: '5361120000001234', expiry: '12/29', id_no: '900101', password2: '12' }, ...ORDER() });
    assert.equal(b.status, 409);
    assert.equal(np.calls.length, 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM service_orders')).n), 0);
  } finally { server.close(); }
});

test('SERVICE_PAY_ENABLED=false closes checkout; 관리자 list is SYSTEM_ADMIN only with buyer name/email/amount/status', async () => {
  const { db, server, client } = await boot();
  try {
    const anon = client();
    await anon('POST', '/api/service-pay/orders', ORDER());
    process.env.SERVICE_PAY_ENABLED = 'false';
    try { assert.equal((await anon('POST', '/api/service-pay/orders', ORDER())).status, 503); } finally { delete process.env.SERVICE_PAY_ENABLED; }
    assert.equal((await anon('GET', '/api/admin/service-orders')).status, 401);
    const user = await setup(client, 'member@x.com');
    assert.equal((await user.c('GET', '/api/admin/service-orders')).status, 403);
    await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [user.uid]);
    const l = await user.c('GET', '/api/admin/service-orders');
    assert.equal(l.status, 200); assert.equal(l.json.total, 1);
    const it = l.json.items[0];
    assert.deepEqual([it.buyer_name, it.buyer_email, it.amount, it.status, it.provider_tid], ['김하늘', 'buyer@example.com', 400000, 'PENDING', undefined]);
  } finally { server.close(); }
});

const statusOf = async (db, id) => (await db.get('SELECT status, failure_code, receipt_email_sent_at FROM service_orders WHERE id = ?', [id]));
const alerts = (mail) => mail.find((m) => /RELAI 결제 확인 필요/.test(m.subject));

test('P1-1 opt-in: unset / "1" / "yes" keep checkout closed (503, page shows 결제 준비 중, button disabled); only "true" opens it', async () => {
  const { server, client, np } = await boot();
  try {
    const c = client();
    for (const v of [undefined, '', '1', 'yes', 'TRUE ', 'false']) {
      if (v === undefined) delete process.env.SERVICE_PAY_ENABLED; else process.env.SERVICE_PAY_ENABLED = v;
      const shouldOpen = v === 'TRUE ';   // trimmed + case-insensitive 'true'
      const page = await c('GET', '/pay/agent');
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(`data-open="${shouldOpen ? 1 : 0}"`), String(v));
      assert.match(page.text, /<button[^>]*id="sp-submit"[^>]*disabled/, 'the button ships disabled; pricing.js enables it only when open');
      if (!shouldOpen) {
        assert.match(page.text, />결제 준비 중</);
        assert.equal((await c('POST', '/api/service-pay/orders', ORDER())).status, 503, String(v));
      }
    }
    assert.equal(np.calls.length, 0);
  } finally { process.env.SERVICE_PAY_ENABLED = 'true'; server.close(); }
});

test('P2-1 form: method=post (never GET), card inputs carry no name, so a native submit can never put card data in a URL', async () => {
  const { server, client } = await boot();
  try {
    const t = (await client()('GET', '/pay/agent?plan=monthly&product=agent')).text;
    const form = t.match(/<form[^>]*id="sp-form"[^>]*>/)[0];
    assert.match(form, /method="post"/);
    for (const id of ['card_number', 'card_expiry', 'card_id_no', 'card_pw']) {
      const input = t.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
      assert.doesNotMatch(input, /\sname=/, id);
    }
    assert.match(t, /<input[^>]*id="email"[^>]*name="email"/);
  } finally { server.close(); }
});

test('P1-2 claim: two concurrent returns for one order approve once, never refund, both land on done; a return while APPROVING shows 확인 중', async () => {
  const { db, server, client, np, returnPost, windowResult } = await boot();
  try {
    const c = client();
    const o = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    const form = windowResult(o);
    np.st.approveDelay = 150;
    const [a, b] = await Promise.all([returnPost(form), returnPost(form)]);
    np.st.approveDelay = 0;
    assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 1, 'approved once');
    assert.equal(np.called(/cancel$/).length, 0, 'the good payment is never refunded');
    assert.equal(np.called(/netcancel$/).length, 0);
    assert.equal(a.location, `/pay/agent/done?order=${o.id}`); assert.equal(b.location, `/pay/agent/done?order=${o.id}`);
    assert.equal((await statusOf(db, o.id)).status, 'PAID');

    const o2 = (await c('POST', '/api/service-pay/orders', ORDER({ buyer: { ...BUYER, email: 'two@example.com' } }))).json.order;
    await db.run(`UPDATE service_orders SET status = 'APPROVING' WHERE id = ?`, [o2.id]);   // another request holds the claim
    const r = await returnPost(windowResult(o2));
    assert.equal(r.location, `/pay/agent/done?order=${o2.id}`);
    assert.equal(np.called(/^\/v1\/payments\/[^/]+$/).length, 1, 'no second approval');
    assert.equal((await statusOf(db, o2.id)).status, 'APPROVING', 'never failed by the losing request');
    const page = await c('GET', `/pay/agent/done?order=${o2.id}`);
    assert.match(page.text, /결제를 확인하고 있습니다/);
  } finally { server.close(); }
});

test('P1-3 refund failure: refund_failed + operator alert e-mail + honest buyer copy (no 청구되지 않습니다, no 다시 결제하기); a clean refund keeps apply_failed', async () => {
  const { db, server, client, np, mail, returnPost, windowResult } = await boot({ SUPPORT_EMAIL: 'ops@relai.test' });
  const prev = process.env.SUPPORT_EMAIL; process.env.SUPPORT_EMAIL = 'ops@relai.test';
  try {
    const c = client();
    // A 'failed' notification lands while approving, so the approved payment cannot be recorded → auto refund.
    np.st.onApprove = (id) => db.run(`UPDATE service_orders SET status = 'FAILED', failure_code = 'payment_failed' WHERE id = ?`, [id]);
    const o1 = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    const r1 = await returnPost(windowResult(o1));
    assert.match(r1.location, /^\/pay/agent\/failed\?reason=apply_failed/);
    assert.equal(np.called(/cancel$/).length, 1);
    assert.equal(alerts(mail).length, 0, 'a clean refund needs no operator');
    assert.match((await c('GET', r1.location)).text, /청구되지 않습니다/);

    np.st.cancelFails = true;
    const o2 = (await c('POST', '/api/service-pay/orders', ORDER({ buyer: { ...BUYER, email: 'b2@example.com' } }))).json.order;
    const r2 = await returnPost(windowResult(o2));
    np.st.onApprove = null; np.st.cancelFails = false;
    assert.match(r2.location, /^\/pay/agent\/failed\?reason=refund_failed/);
    const row = await statusOf(db, o2.id);
    assert.deepEqual([row.status, row.failure_code], ['FAILED', 'refund_failed']);
    const al = alerts(mail);
    assert.equal(al.length, 1); assert.equal(al[0].to, 'ops@relai.test'); assert.ok(al[0].subject.includes(o2.id));
    assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM email_deliveries WHERE type = 'SERVICE_PAY_ALERT'`)).n), 1);
    const page = await c('GET', `/pay/agent/failed?reason=canceled&order=${o2.id}`);   // the order's state wins over the query
    assert.match(page.text, /결제 확인 중 문제가 생겼습니다\. 영업일 1일 안에 연락드립니다/);
    assert.doesNotMatch(page.text, /청구되지 않습니다|다시 결제하기/);
    // 관리자 list carries the code the console flags
    const admin = await setup(client, 'ops-admin@x.com');
    await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [admin.uid]);
    const l = await admin.c('GET', '/api/admin/service-orders');
    assert.equal(l.json.items.find((i) => i.id === o2.id).failure_code, 'refund_failed');
  } finally { if (prev === undefined) delete process.env.SUPPORT_EMAIL; else process.env.SUPPORT_EMAIL = prev; server.close(); }
});

test('P2-3 webhook paid for another amount: the tid is refunded and the operator alerted; a failed refund is flagged refund_failed', async () => {
  const { db, server, client, np, mail, webhook } = await boot();
  try {
    const c = client();
    const o = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    const w = await webhook({ resultCode: '0000', tid: 'tid_mm1', orderId: o.id, status: 'paid', amount: 1000, ediDate: '2026-10-20T12:00:01.000+0900', payMethod: 'card' });
    assert.equal(w.status, 200);
    assert.deepEqual(np.called(/cancel$/).map((x) => x.path), ['/v1/payments/tid_mm1/cancel']);
    assert.deepEqual(Object.values(await statusOf(db, o.id)).slice(0, 2), ['FAILED', 'amount_mismatch']);
    assert.equal(alerts(mail).length, 1);

    np.st.cancelFails = true;
    const o2 = (await c('POST', '/api/service-pay/orders', ORDER({ buyer: { ...BUYER, email: 'm2@example.com' } }))).json.order;
    await webhook({ resultCode: '0000', tid: 'tid_mm2', orderId: o2.id, status: 'paid', amount: 1000, ediDate: '2026-10-20T12:00:02.000+0900', payMethod: 'card' });
    np.st.cancelFails = false;
    assert.equal((await statusOf(db, o2.id)).failure_code, 'refund_failed');
    assert.equal(alerts(mail).length, 2);
  } finally { server.close(); }
});

test('P2-4 receipt: a failed send releases the claim, the done page does not say 보냈습니다, the daily job resends once', async () => {
  const { db, server, client, mail, returnPost, windowResult } = await boot();
  try {
    const c = client();
    const o = (await c('POST', '/api/service-pay/orders', ORDER())).json.order;
    mail.failNext = { code: 'provider_down', message: 'down' };
    assert.equal((await returnPost(windowResult(o))).location, `/pay/agent/done?order=${o.id}`);
    assert.equal((await statusOf(db, o.id)).receipt_email_sent_at, null);
    let page = await c('GET', `/pay/agent/done?order=${o.id}`);
    assert.match(page.text, /결제 확인 메일을 보내 드립니다/); assert.doesNotMatch(page.text, /메일을 보냈습니다/);
    const d = await serviceOrdersDaily(db);
    assert.equal(d.receipts_sent, 1);
    assert.equal((await serviceOrdersDaily(db)).receipts_sent, 0, 'sent once');
    assert.ok((await statusOf(db, o.id)).receipt_email_sent_at);
    assert.equal(mail.find((m) => m.to === 'buyer@example.com').length, 1);
    page = await c('GET', `/pay/agent/done?order=${o.id}`);
    assert.match(page.text, /결제 확인 메일을 보냈습니다/);
  } finally { server.close(); }
});

test('P2-5 spam: 5 orders per e-mail per hour; daily job deletes PENDING > 24h, closes stale APPROVING (alert) and a late paid webhook still records it', async () => {
  const { db, server, client, mail, webhook } = await boot();
  try {
    const c = client();
    const ids = [];
    for (let i = 0; i < 5; i += 1) { const r = await c('POST', '/api/service-pay/orders', ORDER({ buyer: { ...BUYER, email: 'Spam@Example.com' } })); assert.equal(r.status, 201); ids.push(r.json.order.id); }
    assert.equal((await c('POST', '/api/service-pay/orders', ORDER({ buyer: { ...BUYER, email: 'spam@example.com' } }))).status, 429);
    assert.equal((await c('POST', '/api/service-pay/orders', ORDER({ buyer: { ...BUYER, email: 'other@example.com' } }))).status, 201);
    await db.run(`UPDATE service_orders SET created_at = now() - interval '25 hours' WHERE id = ANY(?::text[])`, [ids.slice(0, 3)]);
    await db.run(`UPDATE service_orders SET status = 'APPROVING', updated_at = now() - interval '31 minutes' WHERE id = ?`, [ids[3]]);
    const d = await serviceOrdersDaily(db);
    assert.deepEqual([d.purged_pending, d.stale_approving], [3, 1]);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM service_orders WHERE id = ANY(?::text[])', [ids.slice(0, 3)])).n), 0);
    assert.deepEqual(Object.values(await statusOf(db, ids[3])).slice(0, 2), ['FAILED', 'approval_unknown']);
    assert.equal(alerts(mail).length, 1);
    await webhook({ resultCode: '0000', tid: 'tid_late', orderId: ids[3], status: 'paid', amount: 400000, ediDate: '2026-10-20T12:00:03.000+0900', payMethod: 'card' });
    assert.equal((await statusOf(db, ids[3])).status, 'PAID');
  } finally { server.close(); }
});

test('P2-6 audit: each 관리자 service-order view writes SERVICE_ORDERS_VIEW with counts only (no buyer data, no search text)', async () => {
  const { db, server, client } = await boot();
  try {
    await client()('POST', '/api/service-pay/orders', ORDER());
    const admin = await setup(client, 'auditor@x.com');
    await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [admin.uid]);
    await admin.c('GET', '/api/admin/service-orders?q=buyer%40example.com');
    const a = await db.all(`SELECT * FROM admin_audit_logs WHERE action = 'SERVICE_ORDERS_VIEW'`);
    assert.equal(a.length, 1);
    assert.equal(a[0].admin_user_id, admin.uid);
    const meta = JSON.stringify(a[0].metadata);
    assert.doesNotMatch(meta, /buyer@example\.com|김하늘|010-1234/);
    assert.equal(a[0].metadata.searched, true); assert.equal(a[0].metadata.shown, 1);
  } finally { server.close(); }
});
