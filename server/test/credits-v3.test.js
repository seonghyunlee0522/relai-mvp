/* Pricing v3 T2 — AI credits (hive research/relai-pricing-v3 design.md §4, tracks.md §7 T2 rows), fake billing + fake AI only:
 * Free 100 once (per owner / e-mail / workspace, D7), no monthly grant and no top-up on FREE, PRO 1,000 / TEAM 3,000 per credit cycle
 * with expiry of the rest (annual = 12 grants), upgrade top-up of the PLAN bucket, one shared wallet split PLAN → PROMO → PURCHASED,
 * parallel reservations and expiry during a reservation (never negative), failed payments grant nothing, workspace isolation,
 * migration 62 backfill (no balance changes, idempotent), refunds from the PURCHASED bucket with a new orderId per partial cancel. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PAYMENTS_ENABLED ??= 'true';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { addMember } from './api-helpers.js';
import { createFakeProvider } from '../billing/provider.js';
import { grantMonthlyCredits, grantDueMonthlyCredits, grantUpgradeCredits, expireDuePlanCredits } from '../billing/ai-grants.js';
import { topupQuote, refundCredits } from '../billing/credit-packs.js';
import { applyCredits, ensureAccount, reserveRun, settleRun, bucketBalances, expirePlanCredits, backfillCreditBuckets, emailHash, splitDebit } from '../ai/credits.js';
import { resetBillingCache } from '../billing-admin.js';
import { PLANS } from '../plans.js';

process.env.PLAN_LIMITS = 'on';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
for (const k of ['DEV_INITIAL_AI_CREDITS', 'AI_INITIAL_TRIAL_CREDITS', 'AI_FREE_CLAIM_SCOPE', 'CREDIT_REFUND_RULE', 'AI_USER_MINUTE_LIMIT', 'AI_DAILY_LIMIT']) delete process.env[k];

async function boot() {
  const db = await testDb();
  resetBillingCache();
  const provider = createFakeProvider();
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
  };
  const deliver = async (d) => { const res = await fetch(`${base}/api/billing/webhook/fake`, { method: 'POST', headers: { ...d.headers, Origin: 'https://pg.example.com' }, body: d.body }); return { status: res.status, json: await res.json() }; };
  return { db, server, client, provider, deliver };
}
async function signup(env, email, name = '김하늘') {
  const c = env.client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name, email, password: 'passw0rd!' });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  await env.db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [s.json.user.id]);
  const w = s.json.workspaces[0].id;
  return { c, w, uid: s.json.user.id, cr: `/api/workspaces/${w}/credits` };
}
/** Raw rows (no HTTP): a user owning a workspace. */
async function rawWs(db, id, { email = `${id}@x.com`, owner = `u_${id}` } = {}) {
  await db.run('INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [owner, email, owner]);
  await db.run('INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)', [id, id, owner]);
  return id;
}
const sub = (db, wid, { plan = 'PRO', startDaysAgo = 0, endDays = 30, status = 'ACTIVE', autoRenew = false, cycle = 'MONTHLY' } = {}) => db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, auto_renew,
  billing_cycle, current_period_start, current_period_end) VALUES (?, ?, ?, ?, 'fake', ?, ?, now() - make_interval(days => ?), now() + make_interval(days => ?))
  ON CONFLICT (workspace_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end`,
[`s_${wid}`, wid, plan, status, autoRenew, cycle, startDaysAgo, endDays]);
const ledger = (db, w) => db.all('SELECT type, amount::int AS amount, balance_after::int AS balance_after, d_plan::int AS d_plan, d_promo::int AS d_promo, d_purchased::int AS d_purchased, reference_type, reference_id FROM credit_ledger WHERE workspace_id = ? ORDER BY seq', [w]);
const acc = (db, w) => db.get('SELECT balance::int AS balance, plan_balance::int AS plan, promo_balance::int AS promo, purchased_balance::int AS purchased, plan_expires_at FROM workspace_credit_accounts WHERE workspace_id = ?', [w]);
/** Invariants: balance = sum of buckets = last balance_after; every v3 row's split sums to its amount; nothing negative. */
async function consistent(db, w) {
  const a = await acc(db, w); const l = await ledger(db, w);
  assert.equal(a.balance, a.plan + a.promo + a.purchased, 'balance = buckets');
  assert.equal(a.balance, l.length ? l.at(-1).balance_after : 0, 'balance = last balance_after');
  for (const r of l) if (r.d_plan !== null) assert.equal(r.d_plan + r.d_promo + r.d_purchased, r.amount, `split of ${r.type}`);
  assert.ok(a.plan >= 0 && a.promo >= 0 && a.purchased >= 0);
}
async function buy(env, A, amount, { payAmount = null, failed = false } = {}) {
  const co = await A.c('POST', `${A.cr}/checkout`, { amount });
  assert.equal(co.status, 201, JSON.stringify(co.json));
  const o = co.json.order;
  const payment = failed ? { amount: o.amount, status: 'FAILED', provider_tid: `tid_${o.id}`, failure_code: 'card_declined' }
    : { amount: payAmount ?? o.amount, currency: 'KRW', status: 'PAID', provider_tid: `tid_${o.id}`, moid: o.id };
  const res = await env.deliver(env.provider.signedEvent(failed ? 'payment.failed' : 'subscription.activated', { order_id: o.id, payment }));
  return { order: o, res };
}

test('pure: top-up quote (₩10,000 steps, 10,000–500,000, 1 credit = ₩10, VAT split) and the PLAN → PROMO → PURCHASED split', () => {
  assert.deepEqual([10000, 20000, 500000].map((a) => topupQuote(a).credits), [1000, 2000, 50000]);
  const q = topupQuote(30000); assert.equal(q.supply_amount + q.vat_amount, 30000); assert.equal(q.supply_amount, 27273);
  for (const bad of [0, 5000, 15000, 510000, '1e4x', null]) assert.throws(() => topupQuote(bad), (e) => e.status === 400, String(bad));
  assert.deepEqual(splitDebit({ plan: 30, promo: 100, purchased: 50 }, 50), { plan: -30, promo: -20, purchased: 0 });
  assert.deepEqual(splitDebit({ plan: 0, promo: 10, purchased: 50 }, 40), { plan: 0, promo: -10, purchased: -30 });
  assert.equal(splitDebit({ plan: 1, promo: 1, purchased: 1 }, 4), null);
  assert.equal(PLANS.PRO.credits.monthly, 1000); assert.equal(PLANS.TEAM.credits.monthly, 3000); assert.equal(PLANS.FREE.credits.monthly, 0);
});

test('Free 100 once (D7): new workspace → PROMO 100; 2nd workspace of the same owner and the same e-mail (normalized) after re-signup → 0; per-workspace switch', async () => {
  const env = await boot(); const { db } = env;
  const A = await signup(env, 'Owner@X.com');
  let s = (await A.c('GET', `${A.cr}/summary`)).json.credits;
  assert.equal(s.balance, 100); assert.deepEqual(s.buckets, { plan: 0, plan_expires_at: null, promo: 100, purchased: 0 });
  assert.deepEqual((await ledger(db, A.w)).map((r) => [r.type, r.amount, r.d_promo]), [['PROMOTION', 100, 100]]);
  assert.ok(await db.get('SELECT 1 FROM free_credit_claims WHERE owner_user_id = ? AND email_hash = ?', [A.uid, emailHash(' owner+tag@x.com ')]));
  // the same owner's 2nd workspace
  const w2 = (await A.c('POST', '/api/workspaces', { name: '둘째 회사' })).json;
  const w2id = w2?.workspace?.id || (await db.get(`SELECT id FROM workspaces WHERE owner_id = ? AND id <> ? LIMIT 1`, [A.uid, A.w]))?.id || await rawWs(db, 'w_second', { owner: A.uid });
  assert.equal((await bucketBalances(db, w2id)).total, 0);
  // withdrawal + re-signup with the same mailbox (case / +tag differ): the claim row outlives the user row → 0
  await rawWs(db, 'w_resignup', { email: 'owner+again@x.com', owner: 'u_resignup' });
  assert.equal((await bucketBalances(db, 'w_resignup')).total, 0);
  // a different person → 100; upgrades never re-grant
  await rawWs(db, 'w_other');
  assert.equal((await bucketBalances(db, 'w_other')).promo, 100);
  await sub(db, 'w_other', { plan: 'PRO' }); await expirePlanCredits(db, 'w_other');
  assert.equal((await ledger(db, 'w_other')).filter((r) => r.type === 'PROMOTION').length, 1);
  // D7 alternative: once per workspace only
  process.env.AI_FREE_CLAIM_SCOPE = 'workspace';
  await rawWs(db, 'w_ws_scope', { owner: A.uid });
  assert.equal((await bucketBalances(db, 'w_ws_scope')).promo, 100);
  delete process.env.AI_FREE_CLAIM_SCOPE;
  // two concurrent first touches by one new owner on two workspaces → exactly one grant
  await rawWs(db, 'w_c1', { owner: 'u_conc', email: 'conc@x.com' }); await rawWs(db, 'w_c2', { owner: 'u_conc' });
  await Promise.all([ensureAccount(db, 'w_c1'), ensureAccount(db, 'w_c2'), ensureAccount(db, 'w_c1')]);
  assert.equal((await bucketBalances(db, 'w_c1')).total + (await bucketBalances(db, 'w_c2')).total, 100);
  for (const w of [A.w, w2id, 'w_resignup', 'w_other', 'w_c1', 'w_c2']) await consistent(db, w);
  env.server.close();
});

test('FREE: no monthly grant, no top-up (402 before any order row); PRO / TEAM: top-up by amount → CREDIT_TOPUP → PURCHASED bucket; failed / mismatched payment → nothing', async () => {
  const env = await boot(); const { db } = env;
  const A = await signup(env, 'free@x.com');
  assert.equal(await grantMonthlyCredits(db, A.w), null);
  assert.equal((await grantDueMonthlyCredits(db)).granted, 0);
  assert.equal((await ledger(db, A.w)).filter((r) => r.type === 'PLAN_GRANT').length, 0);
  const s = (await A.c('GET', `${A.cr}/summary`)).json.credits;
  assert.deepEqual([s.topup.allowed, s.topup.reason, s.topup.min, s.topup.max], [false, 'plan_required', 10000, 500000]);
  const r = await A.c('POST', `${A.cr}/checkout`, { amount: 10000 });
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'AI_TOPUP_PLAN_REQUIRED'); assert.equal(r.json.error.upgrade.url, '/app/billing/plans');
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM billing_orders WHERE workspace_id = ?', [A.w])).n, 0);
  // ENTERPRISE only by contract
  await sub(db, A.w, { plan: 'ENTERPRISE' });
  assert.equal((await A.c('POST', `${A.cr}/checkout`, { amount: 10000 })).json.error.message.includes('Enterprise'), true);
  await db.run('UPDATE workspaces SET enterprise_topup = true WHERE id = ?', [A.w]);
  assert.equal((await A.c('POST', `${A.cr}/checkout`, { amount: 10000 })).status, 201);
  // PRO
  await sub(db, A.w, { plan: 'PRO' });
  assert.equal((await A.c('POST', `${A.cr}/checkout`, { amount: 15000 })).status, 400);
  assert.equal((await A.c('POST', `${A.cr}/checkout`, { amount: 510000 })).status, 400);
  const { order, res } = await buy(env, A, 20000);
  assert.equal(res.status, 200); assert.equal(order.credits, 2000);
  assert.equal((await db.get('SELECT kind, credits::int AS credits, status FROM billing_orders WHERE id = ?', [order.id])).kind, 'CREDIT_TOPUP');
  assert.equal((await acc(db, A.w)).purchased, 2000);
  // failed card / tampered amount → order FAILED, no PURCHASE row
  const n0 = (await ledger(db, A.w)).length;
  const f = await buy(env, A, 10000, { failed: true });
  assert.equal((await db.get('SELECT status FROM billing_orders WHERE id = ?', [f.order.id])).status, 'FAILED');
  const m = await buy(env, A, 10000, { payAmount: 100 });
  assert.equal(m.res.json.reason, 'amount_mismatch');
  assert.equal((await ledger(db, A.w)).length, n0); assert.equal((await acc(db, A.w)).purchased, 2000);
  // the billing page shows the buckets
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing.credits;
  assert.deepEqual([b.total, b.plan, b.promo, b.purchased], [2100, 0, 100, 2000]);
  await consistent(db, A.w);
  env.server.close();
});

test('PRO 1,000 / TEAM 3,000 per credit cycle into the PLAN bucket; next cycle expires the rest first; annual = 12 grants; upgrade +2,000 once; ended plan → PLAN bucket expires, the rest stays', async () => {
  const db = await testDb();
  await rawWs(db, 'w_pro'); await sub(db, 'w_pro', { plan: 'PRO', startDaysAgo: 2, endDays: 28 });
  const g = await grantMonthlyCredits(db, 'w_pro');
  assert.equal(g.amount, 1000); assert.equal(g.expired, 0);
  let a = await acc(db, 'w_pro'); assert.equal(a.plan, 1000); assert.equal(a.promo, 100);
  assert.ok(Math.abs(new Date(a.plan_expires_at) - (Date.now() + 28 * 86400e3)) < 2 * 86400e3);
  assert.equal(await grantMonthlyCredits(db, 'w_pro'), null);   // idempotent per cycle
  await applyCredits(db, { wid: 'w_pro', amount: -400, type: 'ADJUSTMENT', reason: 'use' });   // spends PLAN first
  assert.deepEqual([(await acc(db, 'w_pro')).plan, (await acc(db, 'w_pro')).promo], [600, 100]);
  // next cycle (the clock moved a month and a day: period start shifted back, renewing): the 600 left expire, then a fresh 1,000
  await db.run(`UPDATE subscriptions SET current_period_start = current_period_start - interval '1 month 1 day', auto_renew = true WHERE workspace_id = 'w_pro'`);
  const g2 = await grantMonthlyCredits(db, 'w_pro');
  assert.equal(g2.expired, 600); assert.equal(g2.amount, 1000);
  assert.deepEqual((await ledger(db, 'w_pro')).slice(-2).map((r) => [r.type, r.amount, r.d_plan]), [['EXPIRY', -600, -600], ['PLAN_GRANT', 1000, 1000]]);
  a = await acc(db, 'w_pro'); assert.deepEqual([a.balance, a.plan, a.promo], [1100, 1000, 100]);

  // lazy expiry: the cycle end passes before the next grant → reading expires the PLAN bucket (no negative, promo kept)
  await db.run(`UPDATE workspace_credit_accounts SET plan_expires_at = now() - interval '1 minute' WHERE workspace_id = 'w_pro'`);
  assert.deepEqual([(await bucketBalances(db, 'w_pro')).plan, (await bucketBalances(db, 'w_pro')).total], [0, 100]);

  // TEAM annual: one grant per month of the 12 covered → 12 distinct cycle references
  await rawWs(db, 'w_team'); await sub(db, 'w_team', { plan: 'TEAM', cycle: 'ANNUAL', startDaysAgo: 0, endDays: 365 });
  for (let m = 0; m < 12; m += 1) {
    if (m) await db.run(`UPDATE subscriptions SET current_period_start = current_period_start - interval '1 month 1 day' WHERE workspace_id = 'w_team'`);   // a month (and a day) later
    const x = await grantMonthlyCredits(db, 'w_team');
    assert.equal(x.amount, 3000, `month ${m}`);
  }
  const tg = (await ledger(db, 'w_team')).filter((r) => r.type === 'PLAN_GRANT');
  assert.equal(tg.length, 12); assert.equal(new Set(tg.map((r) => r.reference_id)).size, 12);
  assert.equal((await acc(db, 'w_team')).plan, 3000);   // never accumulates

  // PRO → TEAM upgrade inside the cycle: +2,000 PLAN, same expiry, once per upgrade order
  await rawWs(db, 'w_up'); await sub(db, 'w_up', { plan: 'PRO', startDaysAgo: 5, endDays: 25 });
  await grantMonthlyCredits(db, 'w_up');
  const exp = (await acc(db, 'w_up')).plan_expires_at;
  await db.run(`UPDATE subscriptions SET plan = 'TEAM' WHERE workspace_id = 'w_up'`);
  assert.equal((await grantUpgradeCredits(db, 'w_up', { from: 'PRO', to: 'TEAM', reference: 'ord_up' })).amount, 2000);
  assert.equal(await grantUpgradeCredits(db, 'w_up', { from: 'PRO', to: 'TEAM', reference: 'ord_up' }), null);
  assert.equal(await grantMonthlyCredits(db, 'w_up'), null);   // same cycle, no full TEAM grant on top
  a = await acc(db, 'w_up'); assert.equal(a.plan, 3000); assert.equal(new Date(a.plan_expires_at).getTime(), new Date(exp).getTime());

  // the plan ends (one-time period over) → the daily sweep expires the PLAN bucket; PROMO / PURCHASED stay usable on FREE
  await applyCredits(db, { wid: 'w_up', amount: 500, type: 'PURCHASE', reason: 'top-up' });
  await db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 hour' WHERE workspace_id = 'w_up'`);
  const sw = await expireDuePlanCredits(db);
  assert.ok(sw.expired >= 1);
  a = await acc(db, 'w_up'); assert.deepEqual([a.plan, a.promo, a.purchased], [0, 100, 500]);
  assert.equal((await grantDueMonthlyCredits(db)).expired, 0);   // nothing left to expire
  for (const w of ['w_pro', 'w_team', 'w_up']) await consistent(db, w);
});

test('one shared wallet: two users / projects draw the same account, split PLAN → PROMO → PURCHASED; 10 parallel reserves on 50 → 5; failure releases; PLAN expiry during a reservation → never negative', async () => {
  const db = await testDb();
  await rawWs(db, 'w_s'); await db.run(`INSERT INTO users (id, email, name) VALUES ('u_s2', 's2@x.com', 'S2')`);
  await ensureAccount(db, 'w_s');   // PROMO 100
  await applyCredits(db, { wid: 'w_s', amount: 30, type: 'PLAN_GRANT', reason: 'plan', bucket: 'plan', expiresAt: new Date(Date.now() + 86400e3).toISOString() });
  await applyCredits(db, { wid: 'w_s', amount: 50, type: 'PURCHASE', reason: 'top-up' });
  const run = async (userId, cost, success = true) => { const r = await reserveRun(db, { wid: 'w_s', projectId: null, userId, feature: 'PROJECT_QA', provider: 'fake', model: 'fake-model', inputSummary: 'q', cost }); return settleRun(db, r.id, { success }); };
  await run('u_w_s', 50); await run('u_s2', 100);
  const use = (await ledger(db, 'w_s')).filter((r) => r.type === 'AI_USAGE');
  assert.deepEqual(use.map((r) => [r.d_plan, r.d_promo, r.d_purchased]), [[-30, -20, 0], [0, -80, -20]]);
  assert.deepEqual(Object.values(await acc(db, 'w_s')).slice(0, 4), [30, 0, 0, 30]);
  await run('u_s2', 10, false);   // failure → released, no row
  assert.equal((await ledger(db, 'w_s')).filter((r) => r.type === 'AI_USAGE').length, 2);
  await consistent(db, 'w_s');

  // 10 parallel reservations of 10 on a balance of 50 → exactly 5 succeed
  await rawWs(db, 'w_p'); await ensureAccount(db, 'w_p', { trial: 0 });
  await applyCredits(db, { wid: 'w_p', amount: 50, type: 'PURCHASE', reason: 'x' });
  const res = await Promise.allSettled(Array.from({ length: 10 }, () => reserveRun(db, { wid: 'w_p', projectId: null, userId: 'u_w_p', feature: 'PROJECT_QA', provider: 'fake', model: 'm', inputSummary: 'q', cost: 10 })));
  const ok = res.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 5); assert.ok(res.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'AI_CREDIT_INSUFFICIENT'));
  await Promise.all(ok.map((r) => settleRun(db, r.value.id, { success: true })));
  assert.equal((await acc(db, 'w_p')).balance, 0); await consistent(db, 'w_p');

  // PLAN credits reserved, then the cycle ends before settlement → EXPIRY first, the charge does not fit → conflict, nothing charged
  await rawWs(db, 'w_x'); await ensureAccount(db, 'w_x', { trial: 0 });
  await applyCredits(db, { wid: 'w_x', amount: 30, type: 'PLAN_GRANT', reason: 'plan', bucket: 'plan', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  await applyCredits(db, { wid: 'w_x', amount: 10, type: 'PURCHASE', reason: 'x' });
  const r = await reserveRun(db, { wid: 'w_x', projectId: null, userId: 'u_w_x', feature: 'WBS_GENERATION', provider: 'fake', model: 'm', inputSummary: 'q', cost: 30 });
  await db.run(`UPDATE workspace_credit_accounts SET plan_expires_at = now() - interval '1 second' WHERE workspace_id = 'w_x'`);
  const out = await settleRun(db, r.id, { success: true });
  assert.equal(out.conflict, true);
  const a = await acc(db, 'w_x'); assert.deepEqual([a.balance, a.plan, a.purchased], [10, 0, 10]);
  assert.deepEqual((await ledger(db, 'w_x')).map((l) => l.type), ['PLAN_GRANT', 'PURCHASE', 'EXPIRY']);
  await consistent(db, 'w_x');
});

test('isolation: a member of WS-B cannot read WS-A credits; a top-up into WS-A never touches WS-B', async () => {
  const env = await boot(); const { db } = env;
  const A = await signup(env, 'a@x.com'); const B = await signup(env, 'b@x.com', '이수진');
  assert.ok([403, 404].includes((await B.c('GET', `${A.cr}/summary`)).status));
  assert.ok([403, 404].includes((await B.c('GET', `${A.cr}/ledger`)).status));
  assert.ok([403, 404].includes((await B.c('GET', `/api/workspaces/${A.w}/billing`)).status));
  assert.ok([403, 404].includes((await B.c('POST', `${A.cr}/checkout`, { amount: 10000 })).status));
  await sub(db, A.w, { plan: 'PRO' });
  await buy(env, A, 10000);
  assert.equal((await acc(db, A.w)).purchased, 1000);
  assert.deepEqual([(await acc(db, B.w)).balance, (await ledger(db, B.w)).length], [100, 1]);
  // a plain member of A sees the wallet but cannot buy
  const M = await addMember(env.client, { ...A, c: A.c }, 'm@x.com', '박민수');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [M.uid]);
  assert.equal((await M.c('GET', `${A.cr}/summary`)).json.credits.balance, 1100);
  assert.equal((await M.c('POST', `${A.cr}/checkout`, { amount: 10000 })).status, 403);
  env.server.close();
});

test('migration 62 backfill: buckets split without changing any balance (purchased = unused purchased, rest promo), old starter grants count as the Free claim, idempotent; drift from pre-62 writers is folded in', async () => {
  const db = await testDb();
  await rawWs(db, 'w_old', { email: 'Legacy@x.com' });
  await ensureAccount(db, 'w_old');   // PROMOTION 100 (AI_INITIAL_TRIAL_CREDITS)
  await applyCredits(db, { wid: 'w_old', amount: 1000, type: 'PURCHASE', reason: 'pack', referenceType: 'ORDER', referenceId: 'o1' });
  await applyCredits(db, { wid: 'w_old', amount: 3000, type: 'PLAN_GRANT', reason: 'v2 TEAM monthly' });
  await applyCredits(db, { wid: 'w_old', amount: -300, type: 'REFUND', reason: 'refund', referenceType: 'ORDER', referenceId: 'o1' });
  // simulate a pre-62 database: buckets empty, claims empty
  await db.run('UPDATE workspace_credit_accounts SET plan_balance = 0, promo_balance = 0, purchased_balance = 0'); await db.run('DELETE FROM free_credit_claims');
  const before = Number((await db.get(`SELECT balance FROM workspace_credit_accounts WHERE workspace_id = 'w_old'`)).balance);
  const r1 = await backfillCreditBuckets(db);
  assert.equal(r1.claims, 1);
  let a = await acc(db, 'w_old');
  assert.equal(a.balance, before); assert.deepEqual([a.plan, a.promo, a.purchased], [0, 3100, 700]);
  const r2 = await backfillCreditBuckets(db);
  assert.deepEqual([r2.split, r2.claims], [0, 0]);
  assert.deepEqual(await acc(db, 'w_old'), a);
  // the owner already had a starter grant → a new workspace of theirs gets no Free 100
  await rawWs(db, 'w_old2', { owner: 'u_w_old' });
  assert.equal((await bucketBalances(db, 'w_old2')).total, 0);
  // drift: old code spends 3,500 from `balance` alone → the next lock takes it in spend order (promo, then purchased)
  await db.run(`UPDATE workspace_credit_accounts SET balance = balance - 3500 WHERE workspace_id = 'w_old'`);
  a = await bucketBalances(db, 'w_old');
  assert.deepEqual([a.total, a.plan, a.promo, a.purchased], [300, 0, 0, 300]);
  // old code grants 200 into `balance` alone → folded into PROMO
  await db.run(`UPDATE workspace_credit_accounts SET balance = balance + 200 WHERE workspace_id = 'w_old'`);
  assert.equal((await bucketBalances(db, 'w_old')).promo, 200);
});

test('refund: purchased credits only (PLAN / PROMO never), v3 — always in full, no fee (founder decision 2026-10-20); each partial cancel has its own orderId', async () => {
  const env = await boot(); const { db, provider } = env;
  const A = await signup(env, 'r@x.com');
  await sub(db, A.w, { plan: 'PRO' }); await grantMonthlyCredits(db, A.w);   // PLAN 1,000 + PROMO 100
  const { order } = await buy(env, A, 30000);   // PURCHASED 3,000
  await applyCredits(db, { wid: A.w, amount: -1500, type: 'ADJUSTMENT', reason: 'use' });   // PLAN 1,000 + PROMO 100 + PURCHASED 400
  assert.deepEqual(Object.values(await acc(db, A.w)).slice(1, 4), [0, 0, 2600]);
  await assert.rejects(refundCredits(db, provider, { wid: A.w, credits: 2601, reason: 'too much', adminUserId: null }), (e) => e.code === 'exceeds_refundable');
  const r1 = await refundCredits(db, provider, { wid: A.w, credits: 1000, reason: '1차', adminUserId: null });
  assert.equal(r1.amount, 10000);   // paid today, partly used → 100%
  const r2 = await refundCredits(db, provider, { wid: A.w, credits: 600, reason: '2차', adminUserId: null });
  assert.equal(r2.amount, 6000);
  const ids = provider.calls.refund.filter((c) => c.partial).map((c) => c.cancel_order_id);
  assert.deepEqual(ids, [`${order.id}C1`, `${order.id}C2`]);
  await db.run(`UPDATE billing_orders SET paid_at = now() - interval '10 days' WHERE id = ?`, [order.id]);
  assert.equal((await refundCredits(db, provider, { wid: A.w, credits: 100, reason: '3차', adminUserId: null })).amount, 1000);   // 10 days later → still 100%, no fee
  assert.equal((await acc(db, A.w)).purchased, 900);
  assert.deepEqual((await ledger(db, A.w)).filter((r) => r.type === 'REFUND').map((r) => r.d_purchased), [-1000, -600, -100]);
  await consistent(db, A.w);
  env.server.close();
});
