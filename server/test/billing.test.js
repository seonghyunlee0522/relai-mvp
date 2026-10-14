/* Phase 10 Billing: FREE plan limits on the product API (402), subscription webhooks (idempotent, signed), checkout/cancel, admin views. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { setup, addMember, project } from './api-helpers.js';
import { createFakeProvider, assertProvider, providerFromEnv } from '../billing/provider.js';
import { effectivePlan } from '../billing/subscriptions.js';
import { resetBillingCache } from '../billing-admin.js';
import { LATEST_VERSION } from '../migrations.js';

process.env.PLAN_LIMITS = 'on';   // helpers.js turns enforcement off for the legacy suites

async function boot({ provider = createFakeProvider() } = {}) {
  const db = await testDb();
  resetBillingCache();
  const server = createApp(db, { billingProvider: provider }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.json(); } catch { /* empty */ }
      return { status: res.status, json };
    };
  };
  /** Deliver a signed webhook (cross-origin, no cookie: the route must not need either). */
  const deliver = async (d, { headers = {} } = {}) => {
    const res = await fetch(`${base}/api/billing/webhook/fake`, { method: 'POST', headers: { ...d.headers, Origin: 'https://pg.example.com', ...headers }, body: d.body });
    return { status: res.status, json: await res.json() };
  };
  return { db, server, client, provider, deliver };
}
const period = (days = 30) => ({ period_start: new Date().toISOString(), period_end: new Date(Date.now() + days * 86400e3).toISOString() });
const activate = (provider, w, extra = {}) => provider.signedEvent('subscription.activated', { workspace_id: w, plan: 'TEAM', subscription_id: `sub_${w}`, customer_id: 'cus_1',
  payment_method_summary: '신한 ****1234', ...period(), payment: { amount: 49000, currency: 'KRW', status: 'PAID', provider_tid: `tid_act_${w}`, moid: 'M-1' }, ...extra });

test('provider interface: fake implements createCheckout/handleWebhook/cancel; registry refuses fake in production', () => {
  assert.equal(assertProvider(createFakeProvider()).name, 'fake');
  assert.throws(() => assertProvider({ name: 'half', createCheckout() {} }), /missing handleWebhook/);
  assert.equal(providerFromEnv({}).name, 'fake');
  assert.equal(providerFromEnv({ NODE_ENV: 'production' }), null);
  assert.equal(providerFromEnv({ NODE_ENV: 'production', BILLING_PROVIDER: 'fake' }), null);
  assert.throws(() => providerFromEnv({ BILLING_PROVIDER: 'nope' }), /unknown BILLING_PROVIDER/);
  assert.ok(LATEST_VERSION >= 25);   // 25 = billing; later migrations (26 auth) follow
});

test('FREE limits: projects / requirements / WBS / weekly reports / members answer 402 plan_limit_reached with the limit payload', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  // projects: 1 active
  const p2 = await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '두 번째' }));
  assert.equal(p2.status, 402); assert.equal(p2.json.error.code, 'plan_limit_reached');
  assert.deepEqual(p2.json.error.limit, { dimension: 'projects', label: 'Active Projects', used: 1, limit: 1, plan: 'FREE', adding: 1 });
  assert.equal(p2.json.error.upgrade.plan, 'TEAM');
  // archive frees the slot; unarchiving the first while the second is active is refused
  await A.c('POST', `${A.purl}/archive`, {});
  const p3 = await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '세 번째' })); assert.equal(p3.status, 201);
  assert.equal((await A.c('POST', `${A.purl}/unarchive`, {})).status, 402);
  const P = `/api/workspaces/${A.w}/projects/${p3.json.project.id}`;
  // requirements: 50
  for (let i = 0; i < 50; i++) assert.equal((await A.c('POST', `${P}/requirements`, { title: `R${i}` })).status, 201);
  const r11 = await A.c('POST', `${P}/requirements`, { title: 'R50' });
  assert.equal(r11.status, 402); assert.equal(r11.json.error.limit.dimension, 'requirements'); assert.equal(r11.json.error.limit.used, 50);
  // WBS: 100 (duplicate goes through the same check)
  let last;
  for (let i = 0; i < 100; i++) { last = await A.c('POST', `${P}/wbs`, { title: `W${i}`, item_type: 'TASK' }); assert.equal(last.status, 201, JSON.stringify(last.json)); }
  assert.equal((await A.c('POST', `${P}/wbs`, { title: 'W100', item_type: 'TASK' })).json.error.limit.dimension, 'wbs');
  assert.equal((await A.c('POST', `${P}/wbs/${last.json.item.id}/duplicate`, {})).status, 402);
  assert.equal((await db.get(`SELECT COUNT(*) n FROM wbs_items WHERE project_id = ?`, [p3.json.project.id])).n, 100);
  // weekly reports: 8 per month
  for (let i = 0; i < 8; i++) assert.equal((await A.c('POST', `${P}/weekly-reports/generate`, { period_start: '2026-10-05', period_end: '2026-10-11' })).status, 201);
  assert.equal((await A.c('POST', `${P}/weekly-reports/generate`, { period_start: '2026-10-05', period_end: '2026-10-11' })).status, 402);
  // members: 3 (owner + 2); direct add and invitation both refused at the limit
  await addMember(client, A, 'b@x.com', '박나다'); await addMember(client, A, 'c@x.com', '최다라');
  await client()('POST', '/api/auth/signup', { name: '정라마', email: 'd@x.com', password: 'passw0rd!' });
  const m4 = await A.c('POST', `/api/workspaces/${A.w}/members`, { email: 'd@x.com', role: 'MEMBER' });
  assert.equal(m4.status, 402); assert.equal(m4.json.error.limit.dimension, 'members');
  await db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // invites need a verified sender (auth hardening); the plan limit is what is tested here
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/invitations`, { email: 'e@x.com', role: 'MEMBER' })).status, 402);
  // the customer billing summary reflects all of it
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b.plan, 'FREE'); assert.equal(b.subscription, null); assert.equal(b.can_manage, true); assert.equal(b.provider_available, true);
  assert.deepEqual(b.usage.dims.map((d) => [d.key, d.used, d.limit]), [['projects', 1, 1], ['members', 3, 3], ['requirements', 50, 50], ['wbs', 100, 100], ['weekly_reports', 8, 8]]);
  server.close();
});

test('webhooks: signed + idempotent; activation lifts limits; payment failure → PAST_DUE with grace; grace over → FREE; expiry → FREE, data kept', async () => {
  const { db, server, client, provider, deliver } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  // bad signature / unknown provider path
  const bad = activate(provider, A.w); bad.headers['x-fake-signature'] = '0'.repeat(64);
  assert.equal((await deliver(bad)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/billing/webhook/stripe`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await db.get('SELECT COUNT(*) n FROM billing_events')).n, 0);
  // activation (cross-origin, no session) — then the same event again, sequentially and concurrently
  const ev = activate(provider, A.w);
  const r1 = await deliver(ev); assert.equal(r1.status, 200); assert.equal(r1.json.status, 'ACTIVE'); assert.ok(r1.json.payment_id);
  assert.equal((await deliver(ev)).json.duplicate, true);
  const many = await Promise.all(Array.from({ length: 5 }, () => deliver(ev)));
  assert.ok(many.every((r) => r.status === 200 && r.json.duplicate));
  assert.equal((await db.get('SELECT COUNT(*) n FROM billing_events')).n, 1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM payments')).n, 1);
  // concurrent first delivery of a fresh event: exactly one applies
  const renew = provider.signedEvent('payment.succeeded', { subscription_id: `sub_${A.w}`, ...period(60), payment: { amount: 49000, status: 'PAID', provider_tid: 'tid_renew_1' } });
  const rr = await Promise.all(Array.from({ length: 4 }, () => deliver(renew)));
  assert.equal(rr.filter((r) => r.json.status === 'ACTIVE').length, 1); assert.equal(rr.filter((r) => r.json.duplicate).length, 3);
  assert.equal((await db.get('SELECT COUNT(*) n FROM payments')).n, 2);
  // TEAM: limits lifted
  assert.equal(await effectivePlan(db, A.w), 'TEAM');
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '두 번째' }))).status, 201);
  for (let i = 0; i < 51; i++) assert.equal((await A.c('POST', A.req, { title: `R${i}` })).status, 201);
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b.plan, 'TEAM'); assert.equal(b.subscription.payment_method_summary, '신한 ****1234'); assert.ok(!('provider_customer_id' in b.subscription));
  assert.equal(b.usage.dims.find((d) => d.key === 'requirements').limit, null);
  // payment failure: PAST_DUE, plan kept during the grace period
  const f = await deliver(provider.signedEvent('payment.failed', { subscription_id: `sub_${A.w}`, payment: { amount: 49000, status: 'FAILED', provider_tid: 'tid_fail_1', failure_code: 'E3001', failure_message: '한도 초과' } }));
  assert.equal(f.json.status, 'PAST_DUE');
  const s = await db.get('SELECT status, grace_period_end FROM subscriptions WHERE workspace_id = ?', [A.w]);
  assert.equal(s.status, 'PAST_DUE'); assert.ok(new Date(s.grace_period_end) > new Date());
  assert.equal(await effectivePlan(db, A.w), 'TEAM');
  // grace over → FREE: existing data stays, new rows refused
  await db.run(`UPDATE subscriptions SET grace_period_end = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'FREE');
  assert.equal((await A.c('POST', A.req, { title: 'over' })).status, 402);
  assert.equal((await db.get(`SELECT COUNT(*) n FROM requirements r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = ?`, [A.w])).n, 51);
  // recovery payment → ACTIVE again; expiry → FREE; a late failure after expiry is recorded but ignored
  assert.equal((await deliver(provider.signedEvent('payment.succeeded', { subscription_id: `sub_${A.w}`, ...period(), payment: { amount: 49000, status: 'PAID', provider_tid: 'tid_renew_2' } }))).json.status, 'ACTIVE');
  assert.equal(await effectivePlan(db, A.w), 'TEAM');
  assert.equal((await deliver(provider.signedEvent('subscription.expired', { subscription_id: `sub_${A.w}` }))).json.status, 'EXPIRED');
  assert.equal(await effectivePlan(db, A.w), 'FREE');
  const late = await deliver(provider.signedEvent('payment.failed', { subscription_id: `sub_${A.w}` }));
  assert.equal(late.json.ignored, true);
  // events for unknown workspaces / types are stored and ignored
  assert.equal((await deliver(activate(provider, 'no-such-ws'))).json.reason, 'unknown_workspace');
  assert.equal((await deliver(provider.signedEvent('invoice.whatever', {}))).json.reason, 'unknown_type');
  const trail = await db.all(`SELECT e.event_type FROM subscription_events e JOIN subscriptions s ON s.id = e.subscription_id WHERE s.workspace_id = ? ORDER BY e.created_at`, [A.w]);
  assert.deepEqual(trail.map((x) => x.event_type), ['subscription.activated', 'payment.succeeded', 'payment.failed', 'payment.succeeded', 'subscription.expired', 'IGNORED:payment.failed']);
  assert.ok((await db.all('SELECT processed_at FROM billing_events')).every((r) => r.processed_at));
  server.close();
});

test('checkout and cancel: OWNER only, provider called, cancel keeps TEAM until the period ends; no provider → 503', async () => {
  const { db, server, client, provider, deliver } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  const M = await addMember(client, A, 'm@x.com', '멤버');
  const Ad = await addMember(client, A, 'ad@x.com', '관리자', 'ADMIN');
  assert.equal((await M.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM' })).status, 403);
  assert.equal((await Ad.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM' })).status, 403);
  assert.equal((await M.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing.can_manage, false);
  const unverified = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM' });
  assert.equal(unverified.status, 403); assert.equal(unverified.json.error.code, 'email_unverified');
  await db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // paying needs a verified e-mail (requireVerifiedEmail)
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'FREE' })).status, 400);
  const co = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM' });
  assert.equal(co.status, 201); assert.match(co.json.checkout_url, /^\/app\/settings\?checkout=fake&session=fake_cs_/);
  assert.equal(provider.calls.checkout[0].workspace_id, A.w);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {})).json.error.code, 'no_active_subscription');
  await deliver(activate(provider, A.w));
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM' })).status, 409);
  assert.equal((await M.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {})).status, 403);
  const c = await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {});
  assert.equal(c.status, 200); assert.equal(c.json.billing.subscription.cancel_at_period_end, true); assert.equal(c.json.billing.plan, 'TEAM');
  assert.equal(provider.calls.cancel.length, 1);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {})).json.error.code, 'already_canceled');
  await db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 second' WHERE workspace_id = ?`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'FREE');   // period over without the provider's expiry webhook → still FREE
  server.close();

  const none = await boot({ provider: null });
  const B = await setup(none.client, 'b@x.com', '박나다');
  await none.db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');
  assert.equal((await B.c('POST', `/api/workspaces/${B.w}/billing/checkout`, { plan: 'TEAM' })).status, 503);
  assert.equal((await B.c('GET', `/api/workspaces/${B.w}/billing`)).json.billing.provider_available, false);
  assert.equal((await fetch(`http://127.0.0.1:${none.server.address().port}/api/billing/webhook/fake`, { method: 'POST', body: '{}' })).status, 404);
  none.server.close();
});

test('admin console lights up from real billing rows: TEAM workspace, usage plan, no provider ids exposed', async () => {
  const { db, server, client, provider, deliver } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  await setup(client, 'b@x.com', '박나다');
  await deliver(activate(provider, A.w));
  const ops = client(); const s = await ops('POST', '/api/auth/signup', { name: '운영자', email: 'ops@relai.io', password: 'passw0rd!' });
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]);
  const d = (await ops('GET', '/api/admin/dashboard')).json;
  assert.equal(d.billing.implemented, true); assert.equal(d.kpis.team_workspaces, 1); assert.equal(d.funnel_7d.paid, 1);
  assert.ok(!d.attention.near_limit.some((x) => x.workspace_id === A.w));       // TEAM is unlimited
  const w = (await ops('GET', `/api/admin/workspaces/${A.w}`)).json;
  assert.equal(w.workspace.plan, 'TEAM'); assert.equal(w.usage.plan, 'TEAM'); assert.equal(w.subscription.status, 'ACTIVE');
  const u = (await ops('GET', '/api/admin/usage')).json;
  assert.equal(u.items.find((x) => x.workspace_id === A.w).plan, 'TEAM');
  const pays = (await ops('GET', '/api/admin/payments')).json;
  assert.equal(pays.total, 1); assert.ok(!JSON.stringify(pays).includes(`tid_act_${A.w}`));
  assert.ok(!JSON.stringify(w).includes('cus_1'));
  server.close();
});

test('orders through the fake provider: server-priced checkout, paid event verified against the order amount, months extend the period, cancel runs outside the transaction', async () => {
  const provider = createFakeProvider();
  let lockedDuringCancel = null;
  const { db, server, client, deliver } = await boot({ provider: { ...provider, async cancel(args) { lockedDuringCancel = (await db.get(`SELECT COUNT(*) n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'subscriptions' AND l.mode = 'RowShareLock'`)).n; return provider.cancel(args); } } });
  const A = await setup(client, 'a@x.com', '김가나');
  await db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');   // paying needs a verified e-mail (requireVerifiedEmail)
  const co = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3 });
  assert.equal(co.status, 201); assert.equal(co.json.order.amount, Math.round(57000 * 0.6) + Math.round(57000 * 0.6 * 0.1));
  const orderId = co.json.order.id;
  const paid = (amount, tid) => provider.signedEvent('subscription.activated', { order_id: orderId, payment: { amount, status: 'PAID', provider_tid: tid, moid: orderId } });
  assert.equal((await deliver(paid(1000, 'tid_low'))).json.reason, 'amount_mismatch');
  assert.equal(await effectivePlan(db, A.w), 'FREE');
  const co2 = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'MONTHLY', seats: 3 });
  const ok = provider.signedEvent('subscription.activated', { order_id: co2.json.order.id, payment: { amount: co2.json.order.amount, status: 'PAID', provider_tid: 'tid_ok', moid: co2.json.order.id } });
  assert.equal((await deliver(ok)).json.status, 'ACTIVE');
  const s = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [A.w]);
  assert.equal(s.auto_renew, false); assert.equal(s.seats, 3); assert.ok(Math.abs((new Date(s.current_period_end) - Date.now()) / 86400e3 - 30.5) < 2);
  assert.equal((await db.get('SELECT status FROM billing_orders WHERE id = ?', [co2.json.order.id])).status, 'PAID');
  // a renewing subscription: cancel calls the provider with no subscription row lock held
  await db.run(`UPDATE subscriptions SET auto_renew = true WHERE workspace_id = ?`, [A.w]);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/billing/cancel`, {})).status, 200);
  assert.equal(lockedDuringCancel, 0);
  server.close();
});
