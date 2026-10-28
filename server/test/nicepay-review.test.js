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

test('월간 결제만 (default): no 연간 / 추가 이용 — quote is monthly, recurring refuses ANNUAL and add-ons before NicePay; flags say so', async () => {
  delete process.env.CHECKOUT_OPTIONS_ENABLED;
  const { c, w, np, done } = await boot();
  try {
    const b = (await c('GET', `/api/workspaces/${w}/billing`)).json.billing;
    assert.equal(b.flags.monthly_only, true); assert.equal(b.flags.addons, false);
    const q = (await c('GET', `/api/workspaces/${w}/billing/quote?plan=PRO&cycle=ANNUAL&extra_users=3&extra_projects=1`)).json;
    assert.equal(q.quote.cycle, 'MONTHLY'); assert.equal(q.quote.total, 30000); assert.equal(q.quote.extra_users, 0);
    for (const body of [{ cycle: 'ANNUAL' }, { extra_users: 2 }, { extra_projects: 1 }]) {
      const r = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'PRO', cycle: 'MONTHLY', card: CARD, agree: true, disclosure_hash: q.disclosure.hash, ...body });
      assert.equal(r.status, 400, r.text); assert.equal(r.json.error.code, 'validation_error');
    }
    assert.equal(np.calls.length, 0);
    const ok = await c('POST', `/api/workspaces/${w}/billing/recurring`, { plan: 'PRO', cycle: 'MONTHLY', card: CARD, agree: true, disclosure_hash: q.disclosure.hash });
    assert.equal(ok.status, 201, ok.text);
  } finally { done(); }
});

test('landing Pro / Team → 결제하기: signed out → /login?next=checkout; the login ↔ signup switch keeps next', async () => {
  const { landingPricingHtml } = await import('../legal.js');
  const html = landingPricingHtml(undefined, { open: true, oneTime: false, monthly: true });
  for (const k of ['PRO', 'TEAM']) {
    assert.ok(html.includes(`href="/login?next=${encodeURIComponent(`/app/billing/subscribe?plan=${k}`)}"`), k);
    assert.ok(html.includes(`data-buy="/app/billing/subscribe?plan=${k}"`), k);
  }
  assert.ok(!html.includes('무료로 시작하고')); assert.ok(!html.includes('data-cycle-set')); assert.ok(!html.includes('연 288,000원'));
  const landing = readFileSync(join(root, 'public/index.html'), 'utf8');
  assert.match(landing, /data-auth="buy"[^]*data-buy/);   // a session points 결제하기 straight at checkout
  assert.match(readFileSync(join(root, 'public/app/auth.js'), 'utf8'), /safeNext \? `\?next=\$\{encodeURIComponent\(safeNext\)\}`/);
});

test('checkout card helpers: 4-box number masked as 1234 **** **** 5678; client checks match the server rules', async () => {
  const src = readFileSync(join(root, 'public/app/subscribe.js'), 'utf8');
  const mask = new Function(`${src.match(/const digitsOf[^\n]*\n/)[0]}${src.match(/export function maskCard[^]*?\n}\n/)[0].replace('export ', '')}return maskCard;`)();
  assert.equal(mask('1234567812345678'), '1234 **** **** 5678');
  for (const d of ['12345678901234', '123456789012345']) {   // 14 / 15 digits: first 4 and last 4 only
    const m = mask(d).replace(/ /g, '');
    assert.equal(m, `${d.slice(0, 4)}${'*'.repeat(d.length - 8)}${d.slice(-4)}`);
  }
  assert.match(src, /confirmDialog\(\{ title: '결제 정보를 확인해 주세요'/);   // pay asks once more before POST …/recurring
  assert.ok(src.indexOf("confirmDialog({ title: '결제 정보를") < src.indexOf("billing/recurring`"));
});

test('해지 · 청약철회 (founder 2026-10-28): no 즉시 해지 환불; 청약철회 = full refund within 7 days, refused once AI was used', async () => {
  delete process.env.CHECKOUT_OPTIONS_ENABLED; delete process.env.REFUND_IMMEDIATE_ENABLED;
  const pay = async (env) => {
    const q = (await env.c('GET', `/api/workspaces/${env.w}/billing/quote?plan=PRO&cycle=MONTHLY`)).json;
    const r = await env.c('POST', `/api/workspaces/${env.w}/billing/recurring`, { plan: 'PRO', cycle: 'MONTHLY', card: CARD, agree: true, disclosure_hash: q.disclosure.hash });
    assert.equal(r.status, 201, r.text); return r.json.billing;
  };
  const A = await boot();
  try {
    const b = await pay(A);
    assert.equal(b.refund_quote_url, null); assert.equal(b.withdrawal.eligible, true); assert.equal(b.withdrawal.total, 30000);
    const no = await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, { refund: true });
    assert.equal(no.status, 409); assert.equal(no.json.error.code, 'refund_not_offered');
    assert.equal((await A.c('GET', `/api/workspaces/${A.w}/billing/refund-quote`)).status, 409);
    const w = await A.c('POST', `/api/workspaces/${A.w}/billing/withdraw`, {});
    assert.equal(w.status, 200, w.text); assert.equal(w.json.cancel.refund_total, 30000); assert.equal(w.json.billing.plan, 'FREE');
    const rows = await A.db.all('SELECT kind, amount FROM subscription_refunds');
    assert.deepEqual(rows.map((r) => [r.kind, Number(r.amount)]), [['WITHDRAWAL', 30000]]);
  } finally { A.done(); }
  const B = await boot();
  try {
    await pay(B);
    await B.db.run(`INSERT INTO ai_runs (id, workspace_id, feature, provider, model, status) VALUES ('run1', ?, 'PROJECT_QA', 'fake', 'm', 'SUCCEEDED')`, [B.w]);
    const b = (await B.c('GET', `/api/workspaces/${B.w}/billing`)).json.billing;
    assert.equal(b.withdrawal.eligible, false); assert.equal(b.withdrawal.reason, 'used');
    const w = await B.c('POST', `/api/workspaces/${B.w}/billing/withdraw`, {});
    assert.equal(w.status, 409); assert.equal(w.json.error.code, 'withdrawal_used');
    const c = await B.c('POST', `/api/workspaces/${B.w}/billing/cancel`, {});   // 해지: auto-renew off, plan to period end, no refund
    assert.equal(c.status, 200, c.text); assert.equal(c.json.billing.plan, 'PRO'); assert.equal(c.json.cancel.immediate, false);
    assert.equal((await B.db.all('SELECT id FROM subscription_refunds')).length, 0);
  } finally { B.done(); }
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
