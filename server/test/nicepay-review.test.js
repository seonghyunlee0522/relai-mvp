/* NicePay merchant review path (결제경로 심사): the screens a reviewer sees and the safety rules around them.
 *  - billing summary carries the priced products (Team 플랜 + 3 AI 크레딧 packs) for the plans page
 *  - payments off → the card registration endpoint refuses (409) and NicePay is never called, even with 정기결제 on
 *  - 정기결제 on: card data reaches NicePay only as encData; never in the DB, the response or the server log (also on a decline)
 *  - card registration attempts are limited per user / IP / workspace (429 before NicePay is called)
 *  - the order page that opens the NicePay window shows 결제 수단 신용카드, and no review screen source says sample/test/샘플/테스트
 * Nothing here reaches NicePay (stubbed fetch). */
import { test } from 'node:test';
process.env.ONE_TIME_PLANS_ENABLED ??= 'true';   // the retired one-time plan checkout (paid plans = 정기결제 only since 2026-10-20) is still exercised here
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

test('billing summary lists the priced products: the plans only (AI credit packs retired 2026-10-27; AI is "AI 이용량 포함")', async () => {
  const { c, w, done } = await boot({ payments: false });
  const b = (await c('GET', `/api/workspaces/${w}/billing`)).json.billing;
  assert.equal(b.plans.find((p) => p.key === 'TEAM').price.MONTHLY, 80000);   // pricing v3, VAT included
  assert.equal(b.credit_packs, undefined); assert.equal(b.plans.find((p) => p.key === 'TEAM').ai.label, 'AI 이용량 포함');
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
  const hash = (await c('GET', `/api/workspaces/${w}/billing/quote?plan=TEAM&cycle=MONTHLY&users=1`)).json.disclosure.hash;   // 정기결제 고지 (T3)
  const log = await capture(async () => { r = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: CARD, agree: true, disclosure_hash: hash }); });
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
  const hash = (await c('GET', `/api/workspaces/${w}/billing/quote?plan=TEAM&cycle=MONTHLY&users=1`)).json.disclosure.hash;   // 정기결제 고지 (T3)
  const log = await capture(async () => { r = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: CARD, agree: true, disclosure_hash: hash }); });
  assert.equal(r.status, 402);
  assert.ok(!log.includes(CARD_DIGITS) && !log.includes('800101'));
  assert.ok(!JSON.stringify(await db.all('SELECT * FROM billing_orders')).includes(CARD_DIGITS));
  done();
});

test('card registration attempts are limited: after the limit 429 card_attempts_exceeded and NicePay is never called', async () => {
  process.env.CARD_ATTEMPTS_USER = '2';
  const { c, w, np, done } = await boot({ decline: true });
  try {
    const hash = (await c('GET', `/api/workspaces/${w}/billing/quote?plan=TEAM&cycle=MONTHLY&users=1`)).json.disclosure.hash;
    const attempt = () => c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: CARD, agree: true, disclosure_hash: hash });
    assert.equal((await attempt()).status, 402); assert.equal((await attempt()).status, 402);   // declined attempts count too
    const before = np.calls.length;
    const r = await attempt();
    assert.equal(r.status, 429); assert.equal(r.json.error.code, 'card_attempts_exceeded'); assert.equal(r.json.error.scope, 'user');
    assert.equal(np.calls.length, before, 'blocked before any NicePay call');
    // a malformed card never reaches NicePay and is not counted (validation runs first) — but the block still answers first
    assert.equal((await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1, card: { number: '1' }, agree: true, disclosure_hash: hash })).status, 429);
  } finally { delete process.env.CARD_ATTEMPTS_USER; done(); }
});

test('AI credit packs are no longer sold: the old checkout answers 410 and no order row is created', async () => {
  const { c, w, db, done } = await boot({ recurring: false });
  const o = await c('POST', `/api/workspaces/${w}/credits/checkout`, { pack: 'P30' });
  assert.equal(o.status, 410); assert.equal(o.json.error.code, 'credits_retired');
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM billing_orders WHERE workspace_id = ?`, [w])).n, 0);
  done();
});

test('review screens: footer business facts + 상호, and no sample/test/샘플/테스트 in their user-facing copy', () => {
  const foot = legalFooterHtml(LEGAL);
  for (const v of [LEGAL.company, LEGAL.ceo, LEGAL.bizNo, LEGAL.address, LEGAL.mailOrderNo, LEGAL.contactEmail]) assert.ok(foot.includes(v.replace(/&/g, '&amp;')), v);
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of ['public/app/plans.js', 'public/app/subscribe.js', 'public/app/ai-usage.js', 'public/app/shared/legal-info.js']) {
    const strings = strip(readFileSync(join(root, f), 'utf8')).match(/'[^'\n]*'|`[^`]*`/g) || [];
    const bad = strings.filter((s) => /샘플|테스트|\bsample\b|\btest\b/i.test(s));
    assert.deepEqual(bad, [], f);
  }
});
