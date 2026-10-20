/* Pricing v3 T3 — subscription lifecycle & payments (design.md §6, founder decisions 2026-10-20, tracks.md §7 T3 rows):
 * 정기결제 only (checkout closed until NICEPAY_RECURRING_ENABLED), consent with the disclosure hash, subscribe with add-ons, add-on and
 * upgrade now (prorated, idempotent), scheduled downgrade / cycle change at renewal, price-increase gate, retries ×3, cancel any time,
 * cancel + refund of unused days (no penalty), expiry → FREE with 30-day retention and the D6 over-limit lock. The fake provider's
 * 정기결제 stands in for NicePay; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { setup, project } from './api-helpers.js';
import { createFakeProvider } from '../billing/provider.js';
import { resetBillingCache } from '../billing-admin.js';
import { prorate } from '../billing/prorate.js';
import { effectivePlan } from '../billing/subscriptions.js';

process.env.PAYMENTS_ENABLED = 'true';
process.env.PLAN_LIMITS = 'on';
process.env.CRON_SECRET = 'cron-test-secret';
process.env.EARLY_ACCESS_CUTOFF = '2000-01-01T00:00:00Z';
const CARD = { number: '4242-4242-4242-4242', expiry: '12/29', id_no: '800101', password2: '12' };

async function boot({ recurring = true } = {}) {
  const db = await testDb();
  resetBillingCache();
  const provider = createFakeProvider({ recurring });
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.json(); } catch { /* empty */ }
      return { status: res.status, json };
    };
  };
  const cron = () => fetch(`${base}/api/billing/cron/daily`, { headers: { Authorization: 'Bearer cron-test-secret' } }).then((x) => x.json());
  return { db, server, client, provider, cron };
}
const owner = async (t, email = 'o@x.com') => {
  const A = await setup(t.client, email, '소유자');
  await t.db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');
  return A;
};
const sub = (db, w) => db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [w]);
const B = (A) => `/api/workspaces/${A.w}/billing`;
/** Quote → disclosure hash → POST with consent (what the screen does). */
async function consented(A, method, path, body, quoteQs) {
  const q = await A.c('GET', `${B(A)}/quote?${quoteQs}`);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  return A.c(method, path, { ...body, agree: true, disclosure_hash: q.json.disclosure.hash });
}
async function subscribe(A, { plan = 'PRO', cycle = 'MONTHLY', extra_users = 0, extra_projects = 0 } = {}) {
  const r = await consented(A, 'POST', `${B(A)}/recurring`, { plan, cycle, extra_users, extra_projects, card: CARD }, `plan=${plan}&cycle=${cycle}&extra_users=${extra_users}&extra_projects=${extra_projects}`);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r;
}
/** Put the current period at [now − usedDays, now + leftDays). */
const setPeriod = (db, w, usedDays, leftDays) => db.run(`UPDATE subscriptions SET current_period_start = now() - make_interval(days => ?), current_period_end = now() + make_interval(days => ?), next_billing_at = now() + make_interval(days => ?) WHERE workspace_id = ?`, [usedDays, leftDays, leftDays, w]);
const dueNow = (db, w) => db.run(`UPDATE subscriptions SET current_period_start = now() - interval '1 month', current_period_end = now() - interval '1 minute', next_billing_at = now() - interval '1 minute' WHERE workspace_id = ?`, [w]);

test('checkout gate: PAYMENTS on + 정기결제 off → 409 checkout_not_open on checkout / recurring 404; flags say so; no order row', async () => {
  const t = await boot({ recurring: false });
  const A = await owner(t);
  const r = await A.c('POST', `${B(A)}/checkout`, { plan: 'PRO', cycle: 'MONTHLY' });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'checkout_not_open'); assert.match(r.json.error.message, /정기결제 준비 중/);
  assert.equal((await A.c('POST', `${B(A)}/recurring`, { plan: 'PRO', cycle: 'MONTHLY', card: CARD })).status, 404);
  const b = (await A.c('GET', B(A))).json.billing;
  assert.equal(b.flags.checkout_open, false); assert.equal(b.checkout.can_purchase, false);
  assert.equal((await t.db.get('SELECT COUNT(*)::int AS n FROM billing_orders')).n, 0);
  t.server.close();
});

test('subscribe PRO monthly +2 users: consent required (400, then stale hash), one consent row with the hash, limits 17, renewal 32,000; replayed approval applies once', async () => {
  const t = await boot();
  const A = await owner(t);
  const body = { plan: 'PRO', cycle: 'MONTHLY', extra_users: 2, card: CARD };
  const no = await A.c('POST', `${B(A)}/recurring`, body);
  assert.equal(no.status, 400); assert.equal(no.json.error.code, 'consent_required');
  const keys = no.json.error.disclosure.items.map((i) => i.key);
  for (const k of ['plan', 'amount', 'first_charge_at', 'cycle', 'renewal', 'auto_renew', 'cancel', 'refund']) assert.ok(keys.includes(k), k);   // spec §5.2 items
  assert.equal((await A.c('POST', `${B(A)}/recurring`, { ...body, agree: true, disclosure_hash: 'stale' })).json.error.code, 'consent_stale');
  assert.equal(t.provider.calls.regist.length, 0);
  const r = await subscribe(A, { plan: 'PRO', extra_users: 2 });
  const b = r.json.billing;
  assert.equal(b.plan, 'PRO'); assert.equal(b.auto_renew, true); assert.deepEqual(b.limits, { projects: 3, users: 17 }); assert.equal(b.next_payment_amount, 32000);
  assert.deepEqual(b.addons, { extra_users: 2, extra_projects: 0 });
  assert.equal(t.provider.calls.charge[0].amount, 32000);
  const s = await sub(t.db, A.w);
  assert.equal(s.extra_users, 2); assert.equal(s.renewal_amount, 32000); assert.equal(s.price_version, null); assert.ok(s.billing_key_enc);
  const c = await t.db.all('SELECT * FROM billing_consents WHERE workspace_id = ?', [A.w]);
  assert.equal(c.length, 1); assert.equal(c[0].kind, 'CHECKOUT'); assert.equal(c[0].amount, 32000); assert.equal(c[0].renewal_amount, 32000); assert.ok(c[0].order_id);
  // the same approval delivered again (return replay / webhook): order already PAID → ignored; add-ons not doubled
  const order = await t.db.get(`SELECT * FROM billing_orders WHERE workspace_id = ? AND kind = 'RECURRING_FIRST'`, [A.w]);
  const { processWebhookEvent } = await import('../billing/subscriptions.js');
  const again = await processWebhookEvent(t.db, 'fake', { id: 'paid:replay-1', type: 'subscription.activated', order_id: order.id, payment: { amount: 32000, status: 'PAID', provider_tid: order.provider_tid } });
  assert.equal(again.ignored, true);
  assert.equal((await sub(t.db, A.w)).extra_users, 2);
  // a second subscribe while renewing → 409
  assert.equal((await consented(A, 'POST', `${B(A)}/recurring`, { plan: 'TEAM', cycle: 'MONTHLY', card: CARD }, 'plan=TEAM&cycle=MONTHLY')).json.error.code, 'already_subscribed');
  t.server.close();
});

test('add-on now: prorated to the period end (rounded down), limit +2 only when PAID, consent ADDON; flag off → 409; double click (client_key) → one order', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO' });
  await setPeriod(t.db, A.w, 19, 12);
  const off = await A.c('POST', `${B(A)}/addons`, { extra_users: 2 });
  assert.equal(off.status, 409); assert.equal(off.json.error.code, 'addons_disabled');
  process.env.ADDONS_ENABLED = 'true';
  try {
    const s0 = await sub(t.db, A.w);
    const want = prorate({ unit: 1000, qty: 2, periodStart: s0.current_period_start, periodEnd: s0.current_period_end, at: new Date() }).amount;
    assert.ok(want > 0 && want < 2000);
    assert.equal((await A.c('POST', `${B(A)}/addons`, { extra_users: 2 })).json.error.code, 'consent_required');
    const q = await A.c('GET', `${B(A)}/quote?kind=ADDON&extra_users=2`);
    assert.equal(q.json.quote.total, want); assert.equal(q.json.quote.next_renewal_amount, 32000);
    const body = { extra_users: 2, agree: true, disclosure_hash: q.json.disclosure.hash, client_key: 'k-1' };
    const [r1, r2] = await Promise.all([A.c('POST', `${B(A)}/addons`, body), A.c('POST', `${B(A)}/addons`, body)]);
    assert.ok([r1.status, r2.status].includes(201), JSON.stringify([r1.json, r2.json]));
    const orders = await t.db.all(`SELECT * FROM billing_orders WHERE workspace_id = ? AND kind = 'ADDON'`, [A.w]);
    assert.equal(orders.length, 1); assert.equal(orders[0].amount, want); assert.equal(orders[0].status, 'PAID');
    const s = await sub(t.db, A.w);
    assert.equal(s.extra_users, 2); assert.equal(s.renewal_amount, 32000);
    assert.equal(t.provider.calls.charge.filter((c) => c.order_id === orders[0].id).length, 1);
    const b = (await A.c('GET', B(A))).json.billing;
    assert.equal(b.limits.users, 17); assert.equal(b.next_payment_amount, 32000);
    assert.equal((await t.db.get(`SELECT COUNT(*)::int AS n FROM billing_consents WHERE workspace_id = ? AND kind = 'ADDON'`, [A.w])).n, 1);
    // declined add-on: order FAILED, subscription stays ACTIVE (not PAST_DUE), limit unchanged
    t.provider.declineNext = 1;
    const q2 = await A.c('GET', `${B(A)}/quote?kind=ADDON&extra_projects=1`);
    const d = await A.c('POST', `${B(A)}/addons`, { extra_projects: 1, agree: true, disclosure_hash: q2.json.disclosure.hash });
    assert.equal(d.status, 402);
    const s2 = await sub(t.db, A.w); assert.equal(s2.status, 'ACTIVE'); assert.equal(s2.extra_projects, 0);
  } finally { delete process.env.ADDONS_ENABLED; }
  t.server.close();
});

test('upgrade PRO → TEAM now: prorated difference, plan TEAM at once, +2,000 PLAN credits once, renewal 80,000; scheduled downgrade dropped', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO' });
  await setPeriod(t.db, A.w, 19, 12);
  await t.cron();   // the PRO grant of the (moved) current credit cycle: 1,000
  process.env.PLAN_CHANGE_ENABLED = 'true';
  try {
    const s0 = await sub(t.db, A.w);
    const want = prorate({ unit: 50000, qty: 1, periodStart: s0.current_period_start, periodEnd: s0.current_period_end, at: new Date() }).amount;
    const r = await consented(A, 'POST', `${B(A)}/upgrade`, { plan: 'TEAM' }, 'kind=UPGRADE&plan=TEAM');
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.order.amount, want);
    const s = await sub(t.db, A.w);
    assert.equal(s.plan, 'TEAM'); assert.equal(s.renewal_amount, 80000); assert.equal(await effectivePlan(t.db, A.w), 'TEAM');
    const up = await t.db.all(`SELECT amount FROM credit_ledger WHERE workspace_id = ? AND reference_type = 'PLAN_UPGRADE'`, [A.w]);
    assert.deepEqual(up.map((x) => Number(x.amount)), [2000]);
    assert.equal(Number((await t.db.get('SELECT plan_balance FROM workspace_credit_accounts WHERE workspace_id = ?', [A.w])).plan_balance), 3000);
    assert.equal(r.json.billing.limits.projects, 10);
    assert.equal((await A.c('POST', `${B(A)}/upgrade`, { plan: 'TEAM', agree: true, disclosure_hash: 'x' })).json.error.code, 'not_upgrade');   // already TEAM
  } finally { delete process.env.PLAN_CHANGE_ENABLED; }
  t.server.close();
});

test('scheduled downgrade TEAM → PRO and cycle change: nothing now, applied by the renewal at the new amount; usage over the target → reduce_first; withdraw', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'TEAM' });
  process.env.PLAN_CHANGE_ENABLED = 'true';
  try {
    // 4 active projects > PRO 3 → refused until cleaned up
    for (const n of ['b', 'c', 'd']) assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: n }))).status, 201);
    const refused = await A.c('POST', `${B(A)}/changes`, { kind: 'DOWNGRADE', plan: 'PRO' });
    assert.equal(refused.status, 409); assert.equal(refused.json.error.code, 'reduce_first');
    const p = (await t.db.get(`SELECT id FROM projects WHERE workspace_id = ? AND name = 'd'`, [A.w])).id;
    await t.db.run(`UPDATE projects SET status = 'ARCHIVED' WHERE id = ?`, [p]);
    const r = await A.c('POST', `${B(A)}/changes`, { kind: 'DOWNGRADE', plan: 'PRO' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.billing.plan, 'TEAM'); assert.equal(r.json.billing.next_payment_amount, 30000); assert.equal(r.json.billing.scheduled[0].kind, 'DOWNGRADE');
    assert.equal((await A.c('POST', `${B(A)}/changes`, { kind: 'DOWNGRADE', plan: 'FREE' })).json.error.code, 'not_downgrade');
    // 월간 → 연간 raises the renewal: consent first
    const cyc = await A.c('POST', `${B(A)}/changes`, { kind: 'CYCLE', cycle: 'ANNUAL' });
    assert.equal(cyc.status, 400); assert.equal(cyc.json.error.code, 'consent_required'); assert.match(cyc.json.error.disclosure.text, /288,000원/);
    const ok = await A.c('POST', `${B(A)}/changes`, { kind: 'CYCLE', cycle: 'ANNUAL', agree: true, disclosure_hash: cyc.json.error.disclosure.hash });
    assert.equal(ok.status, 201, JSON.stringify(ok.json)); assert.equal(ok.json.billing.next_payment_amount, 288000);
    // renewal: PRO annual charged, applied, changes APPLIED, period +12 months
    await dueNow(t.db, A.w);
    const c = await t.cron();
    assert.deepEqual(c.renewals, { due: 1, paid: 1, failed: 0, blocked: 0 });
    assert.equal(t.provider.calls.charge.at(-1).amount, 288000);
    const s = await sub(t.db, A.w);
    assert.equal(s.plan, 'PRO'); assert.equal(s.billing_cycle, 'ANNUAL'); assert.equal(s.renewal_amount, 288000);
    assert.ok(new Date(s.current_period_end) > new Date(Date.now() + 360 * 86400e3));
    assert.equal((await t.db.get(`SELECT COUNT(*)::int AS n FROM subscription_changes WHERE workspace_id = ? AND status = 'APPLIED'`, [A.w])).n, 2);
    // withdraw a scheduled change
    const r2 = await A.c('POST', `${B(A)}/changes`, { kind: 'CYCLE', cycle: 'MONTHLY' });
    assert.equal(r2.status, 201);
    assert.equal((await A.c('DELETE', `${B(A)}/changes/${r2.json.change.id}`)).status, 200);
    assert.deepEqual((await A.c('GET', B(A))).json.billing.scheduled, []);
  } finally { delete process.env.PLAN_CHANGE_ENABLED; }
  t.server.close();
});

test('price increase: 30-day notice + mail; renewal above the agreed amount without consent → not charged, auto-renew off, mail; with consent → charged', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO' });
  await t.db.run('UPDATE subscriptions SET renewal_amount = 20000 WHERE workspace_id = ?', [A.w]);   // agreed 20,000; the catalogue now says 30,000
  await setPeriod(t.db, A.w, 10, 20);
  const n = await t.cron();
  assert.equal(n.price_notices.notified, 1);
  assert.equal((await t.db.get(`SELECT COUNT(*)::int AS n FROM email_deliveries WHERE type = 'BILLING_PRICE_INCREASE'`)).n, 1);
  const b = (await A.c('GET', B(A))).json.billing;
  assert.equal(b.price_notice.old_amount, 20000); assert.equal(b.price_notice.new_amount, 30000);
  assert.equal((await t.cron()).price_notices.notified, 0);   // once per renewal
  // no consent → the renewal is blocked
  await dueNow(t.db, A.w);
  const charges = t.provider.calls.charge.length;
  assert.deepEqual((await t.cron()).renewals, { due: 1, paid: 0, failed: 0, blocked: 1 });
  assert.equal(t.provider.calls.charge.length, charges);
  const s = await sub(t.db, A.w);
  assert.equal(s.auto_renew, false); assert.equal(s.cancel_at_period_end, true); assert.equal(s.billing_key_enc, null);
  assert.equal((await t.db.get(`SELECT COUNT(*)::int AS n FROM email_deliveries WHERE type = 'BILLING_RENEWAL_BLOCKED'`)).n, 1);
  t.server.close();

  // consent → charged at the new amount
  const t2 = await boot();
  const C = await owner(t2, 'c@x.com');
  await subscribe(C, { plan: 'PRO' });
  await t2.db.run('UPDATE subscriptions SET renewal_amount = 20000 WHERE workspace_id = ?', [C.w]);
  await setPeriod(t2.db, C.w, 10, 20);
  await t2.cron();
  const notice = (await C.c('GET', B(C))).json.billing.price_notice;
  assert.equal((await C.c('POST', `${B(C)}/price-consent`, { notice_id: notice.id })).json.error.code, 'consent_required');
  const ok = await C.c('POST', `${B(C)}/price-consent`, { notice_id: notice.id, agree: true, disclosure_hash: notice.disclosure.hash });
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.billing.price_notice, null);
  await dueNow(t2.db, C.w);
  assert.deepEqual((await t2.cron()).renewals, { due: 1, paid: 1, failed: 0, blocked: 0 });
  assert.equal(t2.provider.calls.charge.at(-1).amount, 30000);
  assert.equal((await sub(t2.db, C.w)).renewal_amount, 30000);
  t2.server.close();
});

test('declined renewal: PAST_DUE, retried every 2 days ×3 with a mail each time, then no more; grace over → EXPIRED, FREE, PLAN credits gone, 30-day retention', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO' });
  t.provider.declineNext = 10;
  await dueNow(t.db, A.w);
  for (let i = 1; i <= 4; i += 1) {
    const c = await t.cron();
    assert.deepEqual(c.renewals, { due: 1, paid: 0, failed: 1, blocked: 0 }, `attempt ${i}`);
    const s = await sub(t.db, A.w);
    assert.equal(s.status, 'PAST_DUE'); assert.equal(s.retry_count, i);
    assert.ok(new Date(s.next_billing_at) > new Date(Date.now() + 86400e3));   // 2 days out
    await t.db.run(`UPDATE subscriptions SET next_billing_at = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  }
  assert.equal((await t.cron()).renewals.due, 0);   // 1 attempt + 3 retries, then stop
  assert.equal((await t.db.get(`SELECT COUNT(*)::int AS n FROM email_deliveries WHERE type = 'BILLING_PAYMENT_FAILED'`)).n, 4);
  assert.equal(await effectivePlan(t.db, A.w), 'PRO');   // grace keeps the plan
  await t.db.run(`UPDATE subscriptions SET grace_period_end = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  const c = await t.cron();
  assert.equal(c.expired.expired, 1);
  const s = await sub(t.db, A.w);
  assert.equal(s.status, 'EXPIRED'); assert.ok(s.ended_at); assert.ok(new Date(s.data_retention_until) > new Date(Date.now() + 29 * 86400e3)); assert.equal(s.billing_key_enc, null);
  assert.equal(await effectivePlan(t.db, A.w), 'FREE');
  assert.equal(Number((await t.db.get('SELECT plan_balance FROM workspace_credit_accounts WHERE workspace_id = ?', [A.w])).plan_balance), 0);
  t.server.close();
});

test('cancel any time (monthly and annual): auto-renew off at once, plan to period end, mail; then EXPIRED → FREE; over-limit is read-only, nothing deleted', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO', cycle: 'ANNUAL' });
  for (const n of ['b', 'c']) assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: n }))).status, 201);
  const r = await A.c('POST', `${B(A)}/cancel`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cancel.immediate, false); assert.equal(r.json.billing.auto_renew, false); assert.equal(r.json.billing.cancel_at_period_end, true); assert.equal(r.json.billing.plan, 'PRO');
  assert.equal(r.json.billing.next_payment_at, null);
  assert.equal(t.provider.calls.expire.length, 1);
  assert.equal((await t.db.get(`SELECT COUNT(*)::int AS n FROM email_deliveries WHERE type = 'BILLING_CANCELED'`)).n, 1);
  assert.equal((await A.c('POST', `${B(A)}/cancel`, {})).json.error.code, 'already_canceled');
  // period ends → expired by the cron, FREE, 3 active projects > 1: readable, edits locked (D6), nothing deleted
  await t.db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  assert.equal((await t.cron()).expired.expired, 1);
  const b = (await A.c('GET', B(A))).json.billing;
  assert.equal(b.plan, 'FREE'); assert.ok(b.over_limit); assert.ok(b.data_retention_until);
  assert.equal((await t.db.get('SELECT COUNT(*)::int AS n FROM projects WHERE workspace_id = ?', [A.w])).n, 3);
  assert.equal((await A.c('GET', A.purl)).status, 200);
  const edit = await A.c('PATCH', A.purl, { name: '바꿈' });
  assert.equal(edit.status, 409); assert.equal(edit.json.error.code, 'over_limit');
  t.server.close();
});

test('cancel + refund: plan ends now, unused days refunded (rounded up, no penalty, 청약철회 within 7 days), partial cancel with a new orderId; flag off → REQUESTED for the operator', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO', cycle: 'ANNUAL' });
  // annual: 100 days used of 365 → refund = ceil(288,000 × unused / 365) — NOT re-priced at the monthly list price
  await t.db.run(`UPDATE subscriptions SET current_period_start = now() - interval '100 days', current_period_end = now() - interval '100 days' + interval '365 days' WHERE workspace_id = ?`, [A.w]);
  await t.db.run(`UPDATE billing_orders SET period_start = NULL, period_end = NULL, paid_at = now() - interval '100 days' WHERE workspace_id = ?`, [A.w]);
  const s0 = await sub(t.db, A.w);
  const want = prorate({ unit: 288000, qty: 1, periodStart: s0.current_period_start, periodEnd: s0.current_period_end, at: new Date(Date.now() + 86400e3), dir: 'up' }).amount;
  assert.ok(want > 288000 * 0.7 && want < 288000 * 0.75, String(want));
  const q = (await A.c('GET', `${B(A)}/refund-quote`)).json.refund;
  assert.equal(q.total, want); assert.equal(q.withdrawal, false); assert.equal(q.lines[0].kind, 'CANCEL');
  process.env.REFUND_PARTIAL_ENABLED = 'true';
  try {
    const r = await A.c('POST', `${B(A)}/cancel`, { refund: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.cancel.immediate, true); assert.equal(r.json.cancel.refund_total, want); assert.equal(r.json.billing.plan, 'FREE');
    const call = t.provider.calls.refund.at(-1);
    assert.equal(call.partial, true); assert.equal(call.amount, want); assert.ok(call.cancel_order_id && call.cancel_order_id !== call.order_id);
    const rf = await t.db.get('SELECT * FROM subscription_refunds WHERE workspace_id = ?', [A.w]);
    assert.equal(rf.status, 'DONE'); assert.equal(rf.amount, want);
    assert.equal((await t.db.get('SELECT refunded_amount FROM billing_orders WHERE id = ?', [rf.order_id])).refunded_amount, want);
    const s = await sub(t.db, A.w);
    assert.equal(s.status, 'CANCELED'); assert.ok(s.data_retention_until); assert.equal(s.billing_key_enc, null);
    assert.equal(Number((await t.db.get('SELECT plan_balance FROM workspace_credit_accounts WHERE workspace_id = ?', [A.w])).plan_balance), 0);
  } finally { delete process.env.REFUND_PARTIAL_ENABLED; }
  t.server.close();

  // within 7 days: 청약철회; REFUND_PARTIAL_ENABLED off → REQUESTED, the operator marks it done
  const t2 = await boot();
  const C = await owner(t2, 'c@x.com');
  await subscribe(C, { plan: 'PRO' });
  await t2.db.run(`UPDATE subscriptions SET current_period_start = now() - interval '2 days', current_period_end = now() - interval '2 days' + interval '30 days' WHERE workspace_id = ?`, [C.w]);
  await t2.db.run(`UPDATE billing_orders SET period_start = now() - interval '2 days', period_end = now() - interval '2 days' + interval '30 days' WHERE workspace_id = ?`, [C.w]);
  const r = await C.c('POST', `${B(C)}/cancel`, { refund: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.cancel.withdrawal, true); assert.equal(r.json.cancel.refunds[0].kind, 'WITHDRAWAL'); assert.equal(r.json.cancel.refunds[0].status, 'REQUESTED');
  assert.equal(r.json.cancel.refunds[0].amount, 27000);   // 30,000 × 27 / 30 (3 KST days used incl. today)
  assert.equal(t2.provider.calls.refund.length, 0);
  await t2.db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = 'c@x.com'`);
  const list = await C.c('GET', '/api/billing/admin/subscription-refunds');
  assert.equal(list.json.refunds.length, 1);
  assert.equal((await C.c('POST', `/api/billing/admin/subscription-refunds/${list.json.refunds[0].id}/done`, { note: '콘솔 부분취소' })).json.refund.status, 'DONE');
  assert.equal((await C.c('GET', '/api/billing/admin/subscription-refunds')).json.refunds.length, 0);
  t2.server.close();
});

test('workspace isolation: a member of WS-A cannot read or change WS-B billing; MEMBER cannot cancel', async () => {
  const t = await boot();
  const A = await owner(t, 'a@x.com');
  const Bw = await owner(t, 'b@x.com');
  await subscribe(Bw, { plan: 'PRO' });
  const hidden = (r) => assert.ok([403, 404].includes(r.status), String(r.status));
  hidden(await A.c('GET', B(Bw)));
  hidden(await A.c('POST', `${B(Bw)}/cancel`, { refund: true }));
  hidden(await A.c('GET', `${B(Bw)}/refund-quote`));
  hidden(await A.c('POST', `${B(Bw)}/changes`, { kind: 'CYCLE', cycle: 'ANNUAL' }));
  assert.equal((await sub(t.db, Bw.w)).status, 'ACTIVE');
  t.server.close();
});
