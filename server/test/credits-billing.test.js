/* AI-credits-only billing (research/relai-ai-credit-billing-spec.md, AC1–AC12 on the fake provider — no real payment or refund):
 * prices + packs + refund maths (pure), early access (new / backfill / expiry / notices), 500 starter credits (once), exact metering,
 * pack purchase through the signed webhook (replay, tamper, 403), the customer dashboard + CSV, the low-balance e-mail, operator refund. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { addMember } from './api-helpers.js';
import { createFakeProvider } from '../billing/provider.js';
import { effectivePlan, grantEarlyAccess } from '../billing/subscriptions.js';
import { grantMonthlyCredits } from '../billing/ai-grants.js';
import { sendEarlyAccessNotices } from '../billing/cron.js';
import { packQuote, refundQuote } from '../billing/credit-packs.js';
import { applyCredits, ensureAccount, topUpStarterCredits } from '../ai/credits.js';
import { featureCreditCosts } from '../ai/config.js';
import { setFakeProvider, AiProviderError } from '../ai/provider.js';
import { resetBillingCache } from '../billing-admin.js';
import { CREDIT_PACKS, EARLY_ACCESS, splitVat } from '../plans.js';

process.env.PLAN_LIMITS = 'on';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
for (const k of ['DEV_INITIAL_AI_CREDITS', 'AI_INITIAL_TRIAL_CREDITS', 'AI_USER_MINUTE_LIMIT', 'AI_DAILY_LIMIT', 'EARLY_ACCESS_CUTOFF', 'EARLY_ACCESS_LAUNCH', 'AI_LOW_BALANCE_CREDITS',
  'AI_CREDIT_COST_REQUIREMENT_EXTRACTION', 'AI_CREDIT_COST_WBS_GENERATION', 'AI_CREDIT_COST_CHANGE_IMPACT', 'AI_CREDIT_COST_PROJECT_QA']) delete process.env[k];
process.env.SUPPORT_EMAIL = 'support@relai.test';

const DAY = 86400e3;
const answer = () => ({ data: { answer: 'ok', references: [], warnings: [] }, usage: { input_tokens: 100, output_tokens: 50 } });
const extractAnswer = () => ({ data: { candidates: [] }, usage: { input_tokens: 100, output_tokens: 50 } });
const proj = (name = '한빛제약 챗봇') => ({ name, client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' });

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
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()); let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: res.status, json, text, headers: res.headers };
    };
  };
  const deliver = async (d) => { const res = await fetch(`${base}/api/billing/webhook/fake`, { method: 'POST', headers: { ...d.headers, Origin: 'https://pg.example.com' }, body: d.body }); return { status: res.status, json: await res.json() }; };
  return { db, server, client, provider, deliver };
}
async function owner(env, email = 'owner@x.com', name = '김하늘') {
  const c = env.client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name, email, password: 'passw0rd!' });
  await env.db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [s.json.user.id]);
  const w = s.json.workspaces[0].id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, proj())).json.project;
  return { c, w, uid: s.json.user.id, p, purl: `/api/workspaces/${w}/projects/${p.id}`, cr: `/api/workspaces/${w}/credits` };
}
const ledger = (db, w) => db.all('SELECT * FROM credit_ledger WHERE workspace_id = ? ORDER BY created_at, seq', [w]);
const balance = async (db, w) => Number((await db.get('SELECT balance FROM workspace_credit_accounts WHERE workspace_id = ?', [w])).balance);
const mails = (db, type) => db.all('SELECT recipient, workspace_id FROM email_deliveries WHERE type = ? ORDER BY created_at', [type]);
/** OWNER buys a pack; the fake provider's signed "paid" webhook carries the order id and the amount. */
async function buy(env, A, pack = 'P10', { amount = null, tid = null, eventId } = {}) {
  const co = await A.c('POST', `${A.cr}/checkout`, { pack });
  assert.equal(co.status, 201, JSON.stringify(co.json));
  const o = co.json.order;
  const d = env.provider.signedEvent('subscription.activated', { order_id: o.id, payment: { amount: amount ?? o.amount, currency: 'KRW', status: 'PAID', provider_tid: tid || `tid_${o.id}`, moid: o.id,
    receipt_url: `https://npg.nicepay.co.kr/issue/IssueLoader.do?TID=tid_${o.id}` } }, eventId);
  return { order: o, event: d, res: await env.deliver(d) };
}

test('prices (AC3 table), packs (VAT included split) and refund maths are exact', () => {
  assert.deepEqual(featureCreditCosts(), { REQUIREMENT_EXTRACTION: 30, WBS_GENERATION: 50, CHANGE_IMPACT: 20, PROJECT_QA: 10, WBS_PLAN_QUESTIONS: 0, WBS_PLAN_FIX: 0 });
  assert.deepEqual(CREDIT_PACKS.map((p) => [p.amount, p.credits]), [[10000, 1000], [30000, 3000], [100000, 10000]]);
  assert.deepEqual([10000, 30000, 100000].map(splitVat), [{ supply: 9091, vat: 909 }, { supply: 27273, vat: 2727 }, { supply: 90909, vat: 9091 }]);
  const q = packQuote('P10'); assert.equal(q.amount, 10000); assert.equal(q.credits, 1000); assert.equal(q.supply_amount + q.vat_amount, 10000);
  assert.throws(() => packQuote('P5'), /입력값/);
  const now = new Date('2026-11-01T00:00:00Z');
  const old = { id: 'o1', credits: 3000, refunded_credits: 0, paid_at: new Date(now - 10 * DAY), amount: 30000 };
  const fresh = { id: 'o2', credits: 1000, refunded_credits: 0, paid_at: new Date(now - 2 * DAY), amount: 10000 };
  // > 7 days: unused purchased credits × ₩10 less 10%
  assert.deepEqual(refundQuote({ credits: 2000, packs: [old], unused: 3000, now }), { allocations: [{ order_id: 'o1', credits: 2000, amount: 18000, full: false, manual: false }], credits: 2000, amount: 18000 });
  // within 7 days and untouched → 100%; newest pack first
  const both = refundQuote({ credits: 1500, packs: [fresh, old], unused: 4000, now });
  assert.deepEqual(both.allocations.map((a) => [a.order_id, a.credits, a.amount, a.full]), [['o2', 1000, 10000, true], ['o1', 500, 4500, false]]);
  // a fresh pack partly used (unused 600 of 1000) is not a 청약철회 → fee applies
  assert.equal(refundQuote({ credits: 600, packs: [fresh], unused: 600, now }).allocations[0].amount, 5400);
  // more than the unused purchased credits → refused
  assert.throws(() => refundQuote({ credits: 3001, packs: [old], unused: 3000, now }), (e) => e.code === 'exceeds_refundable');
  assert.throws(() => refundQuote({ credits: 0, packs: [old], unused: 3000, now }), (e) => e.code === 'validation_error');
  // older than the card cancel window → bank transfer by hand
  assert.equal(refundQuote({ credits: 10, packs: [{ ...old, paid_at: new Date(now - 400 * DAY) }], unused: 3000, now }).allocations[0].manual, true);
});

test('AC1 + AC2: new workspace = early access 12 months (TEAM limits) + exactly one 500 starter grant; backfill + top-up are idempotent; cut-off respected', async () => {
  const env = await boot(); const { db } = env;
  const A = await owner(env);
  const w = await db.get(`SELECT created_at, early_access_until, early_access_until = created_at + interval '12 months' AS exact FROM workspaces WHERE id = ?`, [A.w]);
  assert.equal(w.exact, true);
  assert.equal(await effectivePlan(db, A.w), 'EARLY');
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b.plan, 'EARLY'); assert.equal(b.plan_label, '얼리 액세스'); assert.ok(b.early_access_until); assert.equal(b.checkout.can_purchase, false);   // TEAM checkout hidden
  // no FREE limit: 2nd project, 4th member, 51st requirement
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, proj('두 번째'))).status, 201);
  for (const [i, e] of ['m1', 'm2', 'm3'].entries()) await addMember(env.client, A, `${e}@x.com`, `멤버${i}`);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?', [A.w])).n, 4);
  for (let i = 0; i < 51; i++) assert.equal((await A.c('POST', `${A.purl}/requirements`, { title: `요구사항 ${i + 1}` })).status, 201);
  // AC2: exactly 500 credits, one PROMOTION row
  const led = await ledger(db, A.w);
  assert.deepEqual(led.map((l) => [l.type, Number(l.amount), l.reference_id]), [['PROMOTION', 500, 'AI_INITIAL_TRIAL_CREDITS']]);
  const s = (await A.c('GET', `${A.cr}/summary`)).json.credits;
  assert.equal(s.balance, 500); assert.equal(s.balance_krw, 5000); assert.equal(s.free_remaining, 500); assert.equal(s.purchased_remaining, 0); assert.equal(s.starter_credits, 500);
  assert.equal(s.plan, 'EARLY');

  // backfill of a workspace that existed before launch: early access from the launch date; old 100 trial topped up to 500, once
  const oldW = (await db.get(`INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (gen_random_uuid()::text, '예전 Workspace', ?, '2026-03-01T00:00:00Z') RETURNING id`, [A.uid])).id;
  await db.run(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'OWNER')`, [oldW, A.uid]);
  await ensureAccount(db, oldW, { trial: 100 });
  await applyCredits(db, { wid: oldW, amount: -40, type: 'ADJUSTMENT', reason: 'used before' });
  assert.equal(await grantEarlyAccess(db), 1);
  const ow = await db.get(`SELECT early_access_until = (?::timestamptz + interval '12 months') AS from_launch FROM workspaces WHERE id = ?`, [EARLY_ACCESS.launch, oldW]);
  assert.equal(ow.from_launch, true);
  assert.equal((await topUpStarterCredits(db)).topped, 1);   // A already has its 500 → untouched
  assert.equal(await balance(db, oldW), 60 + 400);
  assert.equal(await grantEarlyAccess(db), 0); assert.equal((await topUpStarterCredits(db)).topped, 0);   // re-run: nothing twice
  assert.equal(await balance(db, oldW), 460); assert.equal(await balance(db, A.w), 500);
  // a workspace created after the cut-off gets no early access
  process.env.EARLY_ACCESS_CUTOFF = '2000-01-01T00:00:00Z';
  const L = await owner(env, 'late@x.com', '늦은가입');
  delete process.env.EARLY_ACCESS_CUTOFF;
  assert.equal((await db.get('SELECT early_access_until FROM workspaces WHERE id = ?', [L.w])).early_access_until, null);
  assert.equal(await effectivePlan(db, L.w), 'FREE');
  env.server.close();
});

test('AC10 + AC12: after 12 months → FREE limits (data kept, read-only over the limit), credits still work; 30/7-day notices once each; an active TEAM keeps TEAM + monthly credits', async () => {
  const env = await boot(); const { db } = env;
  const A = await owner(env);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, proj('두 번째'))).status, 201);
  // notices: 20 days left → the 30-day notice, once; 5 days left → the 7-day notice, once
  await db.run(`UPDATE workspaces SET early_access_until = now() + interval '20 days' WHERE id = ?`, [A.w]);
  assert.equal((await sendEarlyAccessNotices(db)).d30, 1); assert.equal((await sendEarlyAccessNotices(db)).d30, 0);
  await db.run(`UPDATE workspaces SET early_access_until = now() + interval '5 days' WHERE id = ?`, [A.w]);
  assert.equal((await sendEarlyAccessNotices(db)).d7, 1); assert.equal((await sendEarlyAccessNotices(db)).d7, 0);
  assert.deepEqual((await mails(db, 'EARLY_ACCESS_ENDING_30D')).map((m) => m.recipient), ['owner@x.com']);
  assert.deepEqual((await mails(db, 'EARLY_ACCESS_ENDING_7D')).map((m) => m.recipient), ['owner@x.com']);
  // clock moved past the end
  await db.run(`UPDATE workspaces SET early_access_until = now() - interval '1 second' WHERE id = ?`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'FREE');
  const p3 = await A.c('POST', `/api/workspaces/${A.w}/projects`, proj('세 번째'));
  assert.equal(p3.status, 402); assert.equal(p3.json.error.limit.plan, 'FREE');
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/projects`)).json.projects.length, 2);   // nothing deleted
  setFakeProvider(answer);
  const ask = await A.c('POST', `${A.purl}/ai/ask`, { question: '남은 크레딧으로 질문' });
  assert.equal(ask.status, 200); assert.equal(ask.json.run.credit_cost, 10); assert.equal(await balance(db, A.w), 490);
  // an existing paid TEAM subscription keeps working until its period ends (with its monthly credits), early access or not
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, current_period_start, current_period_end, auto_renew)
    VALUES ('sub_t', ?, 'TEAM', 'ACTIVE', 'fake', now() - interval '3 days', now() + interval '27 days', false)`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'TEAM');
  assert.equal((await grantMonthlyCredits(db, A.w)).amount, 1000);
  await db.run(`UPDATE workspaces SET early_access_until = now() + interval '200 days' WHERE id = ?`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'TEAM');   // the paid plan wins while it runs
  await db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 second' WHERE id = 'sub_t'`);
  assert.equal(await effectivePlan(db, A.w), 'EARLY');   // then the rest of the early-access year
  env.server.close();
});

test('AC4 + AC6: exact charge per action with one AI_USAGE row (feature, project, user, balance_after); failure = 0 and shown as 실패; insufficient = 402, no row', async () => {
  const env = await boot(); const { db } = env;
  const A = await owner(env);
  const st = (await A.c('GET', `${A.purl}/ai/status`)).json;
  assert.equal(st.costs.REQUIREMENT_EXTRACTION, 30); assert.equal(st.credit_price_krw, 10); assert.equal(st.low_balance_threshold, 200); assert.equal(st.credits.available, 500);
  setFakeProvider(extractAnswer);
  const r = await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '회의록: 로그인과 결제 기능이 필요합니다.' });
  assert.equal(r.status, 200); assert.equal(r.json.run.credit_cost, 30); assert.equal(r.json.run.balance, 470);
  let led = await ledger(db, A.w);
  const use = led.at(-1);
  assert.equal(use.type, 'AI_USAGE'); assert.equal(Number(use.amount), -30); assert.equal(Number(use.balance_after), 470); assert.equal(use.created_by, A.uid);
  const run = await db.get('SELECT feature, project_id, user_id FROM ai_runs WHERE id = ?', [use.ai_run_id]);
  assert.deepEqual(run, { feature: 'REQUIREMENT_EXTRACTION', project_id: A.p.id, user_id: A.uid });
  // forced provider failure → nothing charged, visible in the log at 0
  setFakeProvider(() => { throw new AiProviderError('AI_TIMEOUT', 'timeout'); });
  assert.equal((await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '두 번째 회의록 본문입니다.' })).status, 504);
  assert.equal((await ledger(db, A.w)).length, led.length);
  const log = (await A.c('GET', `${A.cr}/ledger`)).json;
  assert.equal(log.rows[0].type, 'AI_FAILED'); assert.equal(log.rows[0].credits, 0); assert.equal(log.rows[0].krw, 0); assert.match(log.rows[0].label, /실패 \(차감 없음\)/);
  assert.equal(log.rows[1].label, '요구사항 추출'); assert.equal(log.rows[1].credits, -30); assert.equal(log.rows[1].krw, -300); assert.equal(log.rows[1].project_name, '한빛제약 챗봇'); assert.equal(log.rows[1].user_name, '김하늘'); assert.equal(log.rows[1].balance_after, 470);
  // balance == last balance_after, always
  led = await ledger(db, A.w); assert.equal(await balance(db, A.w), Number(led.at(-1).balance_after));
  // insufficient: 12 left < 30
  await applyCredits(db, { wid: A.w, amount: -458, type: 'ADJUSTMENT', reason: 'test drain' });
  setFakeProvider(extractAnswer);
  const n0 = (await ledger(db, A.w)).length;
  const no = await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '세 번째 회의록 본문입니다.' });
  assert.equal(no.status, 402); assert.equal(no.json.error.code, 'AI_CREDIT_INSUFFICIENT'); assert.equal(no.json.error.balance, 12); assert.equal(no.json.error.required, 30);
  assert.equal((await ledger(db, A.w)).length, n0);
  const s = (await A.c('GET', `${A.cr}/summary`)).json.credits; assert.equal(s.low, true); assert.equal(s.available, 12);
  env.server.close();
});

test('AC5: OWNER buys ₩10,000 → order 9,091 + 909 → +1,000 PURCHASE with receipt; replay adds nothing; tampered amount refused; non-OWNER 403; no subscription touched', async () => {
  const env = await boot(); const { db } = env;
  const A = await owner(env);
  const M = await addMember(env.client, A, 'member@x.com', '이수진');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [M.uid]);
  assert.equal((await M.c('POST', `${A.cr}/checkout`, { pack: 'P10' })).status, 403);
  assert.equal((await A.c('POST', `${A.cr}/checkout`, { pack: 'P7' })).status, 400);
  const { order, event, res } = await buy(env, A, 'P10');
  assert.equal(order.amount, 10000); assert.equal(order.supply_amount, 9091); assert.equal(order.vat_amount, 909); assert.equal(order.credits, 1000);
  assert.equal(res.status, 200); assert.equal(res.json.credits, 1000);
  assert.equal(await balance(db, A.w), 1500);
  const row = (await ledger(db, A.w)).at(-1);
  assert.equal(row.type, 'PURCHASE'); assert.equal(Number(row.amount), 1000); assert.equal(row.reference_type, 'ORDER'); assert.equal(row.reference_id, order.id);
  const o = await db.get('SELECT status, receipt_url, provider_tid FROM billing_orders WHERE id = ?', [order.id]);
  assert.equal(o.status, 'PAID'); assert.match(o.receipt_url, /^https:\/\/npg\.nicepay/);
  const log = (await A.c('GET', `${A.cr}/ledger`)).json;
  assert.equal(log.rows[0].label, '충전 ₩10,000'); assert.equal(log.rows[0].credits, 1000); assert.ok(log.rows[0].receipt_url); assert.equal(log.rows[0].balance_after, 1500);
  // replayed webhook (same event id) and a second "paid" for the same order → nothing added
  assert.equal((await env.deliver(event)).json.duplicate, true);
  const again = env.provider.signedEvent('payment.succeeded', { order_id: order.id, payment: { amount: 10000, status: 'PAID', provider_tid: 'tid_other' } });
  assert.equal((await env.deliver(again)).json.ignored, true);
  assert.equal(await balance(db, A.w), 1500);
  // tampered amount: the order fails, no credits
  const t = await buy(env, A, 'P30', { amount: 300 });
  assert.equal(t.res.json.ignored, true); assert.equal(t.res.json.reason, 'amount_mismatch');
  assert.equal((await db.get('SELECT status FROM billing_orders WHERE id = ?', [t.order.id])).status, 'FAILED');
  assert.equal(await balance(db, A.w), 1500);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM subscriptions WHERE workspace_id = ?', [A.w])).n, 0);
  assert.equal(await effectivePlan(db, A.w), 'EARLY');
  // the operator's full-payment refund must not be used for packs (it would not take the credits back)
  const admin = env.client(); const sa = await admin('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email: 'ops@x.com', password: 'passw0rd!' });
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [sa.json.user.id]);
  const pay = await db.get('SELECT id FROM payments WHERE moid = ?', [order.id]);
  assert.equal((await admin('POST', `/api/billing/admin/payments/${pay.id}/refund`, { reason: 'x' })).json.error.code, 'use_credit_refund');
  env.server.close();
});

test('AC7 + AC11: dashboard totals = SUM over the ledger; month / project / user filters; CSV (BOM, Korean) total = page total', async () => {
  const env = await boot(); const { db } = env;
  const A = await owner(env);
  const P2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, proj('두 번째 프로젝트'))).json.project;
  const M = await addMember(env.client, A, 'member@x.com', '이수진');
  await buy(env, A, 'P30');
  setFakeProvider(answer);
  for (let i = 0; i < 3; i++) assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: `질문 ${i}` })).status, 200);
  assert.equal((await M.c('POST', `/api/workspaces/${A.w}/projects/${P2.id}/ai/ask`, { question: '멤버 질문' })).status, 200);
  setFakeProvider(extractAnswer);
  assert.equal((await M.c('POST', `/api/workspaces/${A.w}/projects/${P2.id}/ai/requirements/extract`, { text: '회의록 본문입니다. 요구사항.' })).status, 200);
  // one usage row moved to last month
  const moved = await db.get(`SELECT id FROM credit_ledger WHERE workspace_id = ? AND type = 'AI_USAGE' ORDER BY seq LIMIT 1`, [A.w]);
  await db.run(`UPDATE credit_ledger SET created_at = date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul' - interval '2 days' WHERE id = ?`, [moved.id]);
  const s = (await M.c('GET', `${A.cr}/summary`)).json.credits;   // any member can read it
  const sum = async (where, p = []) => Number((await db.get(`SELECT COALESCE(-SUM(amount), 0) AS n FROM credit_ledger WHERE workspace_id = ? AND type = 'AI_USAGE' AND ${where}`, [A.w, ...p])).n);
  const thisMonth = `created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`;
  assert.equal(s.this_month.used, await sum(thisMonth)); assert.equal(s.this_month.used, 10 + 10 + 10 + 30);
  assert.equal(s.this_month.krw, 600); assert.equal(s.last_month.used, 10); assert.equal(s.last_month.krw, 100);
  assert.deepEqual(s.this_month.by_feature.filter((f) => f.runs).map((f) => [f.label, f.runs, f.credits]), [['요구사항 추출', 1, 30], ['RELAI에게 물어보기', 3, 30]]);
  assert.equal(s.balance, 500 + 3000 - 70); assert.equal(s.purchased_remaining, 3000); assert.equal(s.free_remaining, 430);
  assert.equal(s.balance, Number((await db.get('SELECT SUM(amount) AS n FROM credit_ledger WHERE workspace_id = ?', [A.w])).n));
  assert.equal(s.can_buy, false); assert.equal(s.refundable, null);   // member view
  // filters
  const L = async (q) => (await A.c('GET', `${A.cr}/ledger?${q}`)).json;
  const month = s.this_month.month;
  assert.equal((await L(`month=${month}`)).totals.used, 60);
  assert.equal((await L(`month=${s.last_month.month}`)).totals.used, 10);
  assert.equal((await L(`project=${P2.id}`)).totals.used, 40);
  assert.equal((await L(`user=${M.uid}`)).totals.used, 40);
  assert.equal((await L(`month=${month}&user=${A.uid}`)).totals.used, 20);
  const all = await L('');
  assert.ok(all.filters.projects.length === 2 && all.filters.users.length === 2 && all.filters.months.includes(month));
  // CSV = the statement: BOM, Korean header, its total row equals the page total for the same filter
  const csv = await A.c('GET', `${A.cr}/ledger.csv?month=${month}`);
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), new RegExp(`relai-ai-credits-${month}\\.csv`));
  assert.equal(csv.text.charCodeAt(0), 0xFEFF);
  const lines = csv.text.slice(1).trim().split('\r\n');
  assert.equal(lines[0], '일시,구분,프로젝트,사용자,크레딧,금액(원),잔액(크레딧),비고');
  assert.deepEqual(lines.at(-1).split(',').slice(0, 6), ['합계 (AI 사용)', '', '', '', '-60', '-600']);
  assert.ok(lines.some((l) => l.includes('요구사항 추출') && l.includes('두 번째 프로젝트') && l.includes('이수진') && l.includes('-30') && l.includes('-300')));
  // AC11: "how much did AI cost us this month and who used it" — answered by the summary + the user filter alone
  assert.equal(`${s.this_month.used} 크레딧 (₩${s.this_month.krw})`, '60 크레딧 (₩600)');
  env.server.close();
});

test('AC8: a new user is not warned on the first action; crossing below 200 sends exactly one e-mail to the OWNER; a purchase re-arms it', async () => {
  const env = await boot(); const { db } = env;
  const A = await owner(env);
  await addMember(env.client, A, 'member@x.com', '이수진');
  setFakeProvider(answer);
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '첫 질문' })).status, 200);   // 500 → 490: starter balance is not low
  let m = await mails(db, 'AI_CREDIT_LOW_BALANCE'); assert.equal(m.length, 0);
  assert.equal((await A.c('GET', `${A.cr}/summary`)).json.credits.low, false);
  await applyCredits(db, { wid: A.w, amount: -285, type: 'ADJUSTMENT', reason: 'test' });   // 205
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '두 번째' })).status, 200);   // 195 → mail
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '세 번째' })).status, 200);   // 185: no second mail
  m = await mails(db, 'AI_CREDIT_LOW_BALANCE');
  assert.deepEqual(m.map((x) => x.recipient), ['owner@x.com']);
  assert.equal((await A.c('GET', `${A.cr}/summary`)).json.credits.low, true);
  await buy(env, A, 'P10');   // 1,185 → re-armed
  assert.equal((await db.get('SELECT low_balance_notified_at FROM workspace_credit_accounts WHERE workspace_id = ?', [A.w])).low_balance_notified_at, null);
  assert.equal((await A.c('GET', `${A.cr}/summary`)).json.credits.low, false);
  await applyCredits(db, { wid: A.w, amount: -980, type: 'ADJUSTMENT', reason: 'test' });   // 205
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '네 번째' })).status, 200);   // 195 → second mail
  m = await mails(db, 'AI_CREDIT_LOW_BALANCE'); assert.equal(m.length, 2);
  env.server.close();
});

test('AC9: operator refund — 2,000 unused purchased credits → ₩18,000 partial cancel, one REFUND −2,000 + audit; over the limit refused; free credits never; 7-day untouched pack 100%; failed cancel restored', async () => {
  const env = await boot(); const { db, provider } = env;
  const A = await owner(env);
  const admin = env.client(); const sa = await admin('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email: 'ops@x.com', password: 'passw0rd!' });
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [sa.json.user.id]);
  const url = `/api/billing/admin/workspaces/${A.w}/credit-refund`;
  assert.equal((await admin('GET', url)).json.refundable, 0);   // starter credits only → nothing refundable
  assert.equal((await admin('POST', url, { credits: 100, reason: '무료 크레딧' })).json.error.code, 'exceeds_refundable');
  const { order } = await buy(env, A, 'P30');
  await db.run(`UPDATE billing_orders SET paid_at = now() - interval '10 days' WHERE id = ?`, [order.id]);
  assert.equal((await A.c('POST', url, { credits: 10, reason: 'x' })).status, 403);   // customers ask; operators refund
  assert.equal((await admin('GET', url)).json.refundable, 3000);
  assert.equal((await admin('GET', `${url}?credits=2000`)).json.quote.amount, 18000);
  const r = await admin('POST', url, { credits: 2000, reason: '고객 요청' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.amount, 18000); assert.equal(r.json.credits, 2000);
  assert.deepEqual(provider.calls.refund.map((x) => [x.order_id, x.amount, x.partial]), [[order.id, 18000, true]]);
  const refunds = (await ledger(db, A.w)).filter((l) => l.type === 'REFUND');
  assert.deepEqual(refunds.map((l) => [Number(l.amount), l.reference_type]), [[-2000, 'ORDER']]);
  assert.equal(await balance(db, A.w), 500 + 1000);
  const o = await db.get('SELECT status, refunded_credits, refunded_amount FROM billing_orders WHERE id = ?', [order.id]);
  assert.deepEqual([o.status, o.refunded_credits, o.refunded_amount], ['PAID', 2000, 18000]);
  const audit = await db.get(`SELECT metadata FROM admin_audit_logs WHERE action = 'CREDIT_REFUND' AND target_id = ?`, [A.w]);
  assert.equal((typeof audit.metadata === 'string' ? JSON.parse(audit.metadata) : audit.metadata).amount, 18000);
  // more than min(balance, purchased − refunded) = 1,000 → refused; the 500 free credits are never refundable
  assert.equal((await admin('POST', url, { credits: 1001, reason: 'x' })).json.error.code, 'exceeds_refundable');
  const sum = (await A.c('GET', `${A.cr}/summary`)).json.credits; assert.equal(sum.refundable, 1000); assert.equal(sum.purchased_remaining, 1000); assert.equal(sum.free_remaining, 500);
  // a fresh, untouched pack within 7 days → 100%
  const fresh = await buy(env, A, 'P10');
  const full = await admin('POST', url, { credits: 1000, reason: '청약철회' });
  assert.equal(full.json.amount, 10000); assert.equal(full.json.allocations[0].order_id, fresh.order.id); assert.equal(full.json.allocations[0].full, true);
  assert.equal((await db.get('SELECT status FROM billing_orders WHERE id = ?', [fresh.order.id])).status, 'REFUNDED');
  // provider failure → the credits come back, nothing recorded as refunded
  provider.failNextRefund = '카드사 응답 없음';
  const before = await balance(db, A.w);
  const bad = await admin('POST', url, { credits: 100, reason: '실패 테스트' });
  assert.equal(bad.status, 502); assert.equal(bad.json.failed.length, 1);
  assert.equal(await balance(db, A.w), before);
  assert.equal((await db.get('SELECT refunded_credits FROM billing_orders WHERE id = ?', [order.id])).refunded_credits, 2000);
  assert.equal((await A.c('GET', `${A.cr}/summary`)).json.credits.refundable, 1000);
  // the customer's refund request goes to support by e-mail
  const rq = await A.c('POST', `${A.cr}/refund-request`, { note: '프로젝트 종료' });
  assert.equal(rq.status, 200); assert.deepEqual((await mails(db, 'AI_CREDIT_REFUND_REQUEST')).map((m) => m.recipient), ['support@relai.test']);
  env.server.close();
});
