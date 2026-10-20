/* NicePay merchant review path (결제경로 심사): the screens a reviewer sees and the safety rules around them.
 *  - billing summary carries the priced products (Team 플랜 + 3 AI 크레딧 packs) for the plans page
 *  - payments off → the card registration endpoint refuses (409) and NicePay is never called, even with 정기결제 on
 *  - 정기결제 on: card data reaches NicePay only as encData; never in the DB, the response or the server log (also on a decline)
 *  - the order page that opens the NicePay window shows 결제 수단 신용카드, and no review screen source says sample/test/샘플/테스트
 * Nothing here reaches NicePay (stubbed fetch). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { setup } from './api-helpers.js';
import { createNicepayProvider, paymentSignature } from '../billing/nicepay.js';
import { resetBillingCache } from '../billing-admin.js';
import { LEGAL, legalFooterHtml } from '../../public/app/shared/legal-info.js';
process.env.EARLY_ACCESS_CUTOFF = '2000-01-01T00:00:00Z';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const ENV = { NICEPAY_CLIENT_KEY: 'S2_reviewclient', NICEPAY_SECRET_KEY: SECRET };
const CARD = { number: '9410-1234-5678-9012', expiry: '12/29', id_no: '800101', password2: '47' };
const CARD_DIGITS = '9410123456789012';

function stub({ decline = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ path: u.pathname, body });
    const json = (o) => ({ json: async () => o });
    if (u.pathname === '/v1/subscribe/regist') return json({ resultCode: '0000', resultMsg: 'ok', bid: 'BIKY_review_1' });
    if (/\/payments$/.test(u.pathname)) {
      const p = decline ? { resultCode: 'F113', resultMsg: '한도초과', tid: 't1', orderId: body.orderId, status: 'failed', amount: body.amount }
        : { resultCode: '0000', tid: 't1', orderId: body.orderId, status: 'paid', amount: body.amount, ediDate: '2026-10-20T12:00:00.000+0900' };
      return json(decline ? p : { ...p, signature: paymentSignature(p, SECRET) });
    }
    return json({ resultCode: '0000', resultMsg: 'ok' });
  };
  return { fetch, calls };
}

async function boot({ payments = true, recurring = true, decline = false } = {}) {
  const prev = process.env.PAYMENTS_ENABLED;
  if (payments) process.env.PAYMENTS_ENABLED = 'true'; else delete process.env.PAYMENTS_ENABLED;
  const db = await testDb(); resetBillingCache();
  const np = stub({ decline });
  const provider = createNicepayProvider({ env: { ...ENV, ...(recurring ? { NICEPAY_RECURRING_ENABLED: 'true' } : {}) }, fetch: np.fetch });
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const c = async (method, path, body) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };
  const A = await setup(() => c, 'owner@review.kr', '김심사');
  await db.run('UPDATE users SET email_verified_at = now()');
  const done = () => { server.close(); if (prev === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = prev; };
  return { db, np, c, w: A.w, done };
}

/** Captures console output while fn runs. */
async function capture(fn) {
  const out = []; const orig = {};
  for (const k of ['log', 'info', 'warn', 'error']) { orig[k] = console[k]; console[k] = (...a) => { out.push(a.map(String).join(' ')); }; }
  try { await fn(); } finally { Object.assign(console, orig); }
  return out.join('\n');
}

test('billing summary lists the priced products: Team 플랜 and the 3 AI 크레딧 packs', async () => {
  const { c, w, done } = await boot({ payments: false });
  const b = (await c('GET', `/api/workspaces/${w}/billing`)).json.billing;
  assert.equal(b.plans.find((p) => p.key === 'TEAM').price.MONTHLY, 80000);   // pricing v3, VAT included
  assert.deepEqual(b.credit_packs.map((p) => p.amount), [10000, 30000, 100000]);
  assert.equal(b.payments_enabled, false);
  done();
});

test('payments off: the card registration endpoint refuses and NicePay is never called (정기결제 flag on)', async () => {
  const { c, w, np, done } = await boot({ payments: false, recurring: true });
  const r = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: CARD });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'payments_disabled');
  assert.equal(np.calls.length, 0);
  done();
});

test('정기결제 on: monthly billing key + first charge; card data only as encData, never in DB, response or log', async () => {
  const { db, c, w, np, done } = await boot();
  let r;
  const log = await capture(async () => { r = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: CARD }); });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.billing.subscription.auto_renew, true); assert.equal(r.json.billing.subscription.billing_cycle, 'MONTHLY');
  const reg = np.calls.find((x) => x.path === '/v1/subscribe/regist');
  assert.ok(reg.body.encData); assert.ok(!JSON.stringify(reg.body).includes(CARD_DIGITS));
  for (const secret of [CARD_DIGITS, '800101']) {
    assert.ok(!r.text.includes(secret)); assert.ok(!log.includes(secret));
    for (const t of ['billing_orders', 'billing_events', 'subscriptions', 'payments']) assert.ok(!JSON.stringify(await db.all(`SELECT * FROM ${t}`)).includes(secret), `${t} holds card data`);
  }
  done();
});

test('정기결제 decline: 402, nothing stored, card data not in the log', async () => {
  const { db, c, w, done } = await boot({ decline: true });
  let r;
  const log = await capture(async () => { r = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: CARD }); });
  assert.equal(r.status, 402);
  assert.ok(!log.includes(CARD_DIGITS) && !log.includes('800101'));
  assert.ok(!JSON.stringify(await db.all('SELECT * FROM billing_orders')).includes(CARD_DIGITS));
  done();
});

test('credit pack → order page that opens the NicePay window shows 결제 수단 신용카드, no test wording', async () => {
  const prev = [process.env.AI_ENABLED, process.env.AI_PROVIDER]; process.env.AI_ENABLED = 'true'; process.env.AI_PROVIDER = 'fake';   // packs are sold only while AI is on
  const { c, w, db, done } = await boot({ recurring: false });
  // pricing v3 (T2): top-ups are for PRO / TEAM workspaces
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, auto_renew, current_period_start, current_period_end) VALUES (?, ?, 'PRO', 'ACTIVE', 'fake', false, now(), now() + interval '30 days')`, [`s_${w}`, w]);
  const o = await c('POST', `/api/workspaces/${w}/credits/checkout`, { pack: 'P30' });
  assert.equal(o.status, 201, o.text);
  const page = await c('GET', o.json.checkout_url);
  assert.match(page.text, /결제 수단<\/th><td>신용카드/); assert.match(page.text, /30,000/);
  assert.doesNotMatch(page.text.replace(/<script[\s\S]*?<\/script>/g, ''), /테스트|샘플|\btest\b|\bsample\b/i);
  done();
  for (const [k, v] of [['AI_ENABLED', prev[0]], ['AI_PROVIDER', prev[1]]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

test('review screens: footer business facts + 상호, and no sample/test/샘플/테스트 in their user-facing copy', () => {
  const foot = legalFooterHtml(LEGAL);
  for (const v of [LEGAL.company, LEGAL.ceo, LEGAL.bizNo, LEGAL.address, LEGAL.mailOrderNo, LEGAL.contactEmail]) assert.ok(foot.includes(v.replace(/&/g, '&amp;')), v);
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of ['public/app/plans.js', 'public/app/subscribe.js', 'public/app/credits.js', 'public/app/shared/legal-info.js']) {
    const strings = strip(readFileSync(join(root, f), 'utf8')).match(/'[^'\n]*'|`[^`]*`/g) || [];
    const bad = strings.filter((s) => /샘플|테스트|\bsample\b|\btest\b/i.test(s));
    assert.deepEqual(bad, [], f);
  }
});
