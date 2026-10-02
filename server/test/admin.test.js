/* Admin Console (Phase 10B): system role separation, access control, users/workspaces/usage/audit, suspension enforcement, billing absent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember, project } from './api-helpers.js';
import { suspendUser, listAudit } from '../admin.js';
import { shapeUsage } from '../usage.js';
import { resetBillingCache, maskTid } from '../billing-admin.js';

const grant = (db, uid) => db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [uid]);
/** Signs up a service operator (system_role granted straight in the DB, exactly like scripts/grant-system-admin.js). */
async function operator(db, client, email = 'ops@relai.io') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: '운영자', email, password: 'passw0rd!' });
  await grant(db, s.json.user.id);
  await c('POST', '/api/auth/login', { email, password: 'passw0rd!' });   // re-login so req.user carries the new role
  return { c, uid: s.json.user.id, email };
}
/** Page fetch (HTML routes), no JSON parsing. */
const page = (base, path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

test('access control: anonymous 401, MEMBER 403, workspace OWNER 403, SYSTEM_ADMIN 200; /admin page 403 for non-operators; system role never leaks into workspace membership', async () => {
  const { db, server, client } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = await setup(client, 'owner@x.com', '오너');
  const member = await addMember(client, owner, 'mem@x.com', '멤버', 'MEMBER');
  const ops = await operator(db, client);
  assert.equal((await client()('GET', '/api/admin/dashboard')).status, 401);
  assert.equal((await member.c('GET', '/api/admin/users')).status, 403);
  assert.equal((await owner.c('GET', '/api/admin/users')).status, 403);
  assert.equal((await owner.c('POST', `/api/admin/users/${member.uid}/suspend`, {})).status, 403);
  assert.equal((await owner.c('GET', '/api/admin/does-not-exist')).status, 403);          // unknown admin path still gated
  assert.equal((await ops.c('GET', '/api/admin/dashboard')).status, 200);
  assert.equal((await ops.c('GET', '/api/admin/does-not-exist')).status, 404);
  // page route
  const anon = await page(base, '/admin'); assert.equal(anon.status, 302); assert.match(anon.headers.get('location'), /^\/login\?next=%2Fadmin/);
  const ownerLogin = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@x.com', password: 'passw0rd!' }) }));
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await page(base, '/admin/users', ownerCookie)).status, 403);
  // /api/me exposes the system role for navigation, never a workspace role
  const me = (await ops.c('GET', '/api/me')).json; assert.equal(me.user.system_role, 'SYSTEM_ADMIN');
  assert.equal((await owner.c('GET', '/api/me')).json.user.system_role, 'NONE');
  // SYSTEM_ADMIN is not a member of the owner's workspace → the product API still answers 404 (tenant isolation untouched)
  assert.equal((await ops.c('GET', `${owner.purl}`)).status, 404);
  assert.equal((await ops.c('GET', `/api/workspaces/${owner.w}/members`)).status, 404);
  server.close();
});

test('users: list with aggregates (no N+1 inputs), pagination, search, status/role filters, detail with workspaces + activation + activity', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'a@x.com', '김가나'); await A.c('POST', `/api/workspaces/${A.w}/projects`, project());
  for (let i = 0; i < 6; i++) await client()('POST', '/api/auth/signup', { name: `유저${i}`, email: `u${i}@x.com`, password: 'passw0rd!' });
  const all = (await ops.c('GET', '/api/admin/users?size=100')).json;
  assert.equal(all.total, 8);                                                                  // ops + A + 6 (signup rate limit is 10/h per IP)
  const a = all.items.find((u) => u.email === 'a@x.com');
  assert.equal(a.workspace_count, 1); assert.equal(a.projects_created, 2); assert.equal(a.activation, 'ACTIVE_USER'); assert.ok(a.last_login_at);
  assert.equal(all.items.find((u) => u.email === 'u3@x.com').activation, 'WORKSPACE_CREATED');  // signup auto-creates a workspace, no project yet
  assert.ok(!('password_hash' in a));
  // pagination
  const p1 = (await ops.c('GET', '/api/admin/users?size=3&page=1')).json; const p3 = (await ops.c('GET', '/api/admin/users?size=3&page=3')).json;
  assert.equal(p1.items.length, 3); assert.equal(p3.items.length, 2); assert.equal(p1.total, 8);
  assert.equal(new Set([...p1.items, ...p3.items].map((u) => u.id)).size, 5);
  assert.equal((await ops.c('GET', '/api/admin/users?size=1000')).json.size, 100);               // clamp
  // search + filters
  assert.deepEqual((await ops.c('GET', '/api/admin/users?q=가나')).json.items.map((u) => u.email), ['a@x.com']);
  assert.equal((await ops.c('GET', '/api/admin/users?q=u1%25')).json.total, 0);                   // LIKE wildcard escaped (u1% matches nothing literally)
  assert.equal((await ops.c('GET', '/api/admin/users?q=u1')).json.total, 1);
  assert.equal((await ops.c('GET', '/api/admin/users?system_role=SYSTEM_ADMIN')).json.total, 1);
  assert.equal((await ops.c('GET', '/api/admin/users?status=SUSPENDED')).json.total, 0);
  // detail
  const d = (await ops.c('GET', `/api/admin/users/${A.uid}`)).json;
  assert.equal(d.user.email, 'a@x.com'); assert.equal(d.workspaces.length, 1); assert.equal(d.workspaces[0].role, 'OWNER'); assert.equal(d.workspaces[0].plan, 'FREE'); assert.equal(d.workspaces[0].sole_owner, true);
  assert.equal(d.workspaces[0].project_count, 2);
  assert.ok(d.activity.some((x) => x.type === 'PROJECT_CREATED') && d.activity.some((x) => x.type === 'LOGIN'));
  assert.ok(!d.activity.some((x) => 'name' in x || 'title' in x));                                    // no project content
  assert.equal((await ops.c('GET', '/api/admin/users/nope')).status, 404);
  server.close();
});

test('user suspend / reactivate: audit in the same transaction, sessions revoked, login + API blocked, data and last-owner workspace untouched, self-suspend refused', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'a@x.com', '김가나');
  const before = (await A.c('GET', A.purl)).json.project;
  // suspend
  const s = await ops.c('POST', `/api/admin/users/${A.uid}/suspend`, { reason: '약관 위반 신고' });
  assert.equal(s.status, 200); assert.equal(s.json.sessions_revoked, 1); assert.match(s.json.warnings[0], /유일한 OWNER/);
  assert.equal((await ops.c('POST', `/api/admin/users/${A.uid}/suspend`, {})).status, 409);
  // old session is dead, login refused
  assert.equal((await A.c('GET', '/api/me')).status, 401);
  const login = await client()('POST', '/api/auth/login', { email: 'a@x.com', password: 'passw0rd!' });
  assert.equal(login.status, 403); assert.equal(login.json.error.code, 'account_suspended');
  // workspace + project data intact, workspace NOT auto-suspended
  assert.equal((await db.get('SELECT status FROM workspaces WHERE id = ?', [A.w])).status, 'ACTIVE');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?', [A.w])).n, 1);
  // audit row
  const audit = (await ops.c('GET', '/api/admin/audit')).json;
  assert.equal(audit.total, 1); assert.equal(audit.items[0].action, 'SUSPEND_USER'); assert.equal(audit.items[0].target_id, A.uid);
  assert.equal(audit.items[0].metadata.email, 'a@x.com'); assert.match(audit.items[0].summary, /정지 — 약관 위반 신고/); assert.equal(audit.items[0].admin_email, ops.email);
  // dashboard attention + user detail status
  const dash = (await ops.c('GET', '/api/admin/dashboard')).json;
  assert.equal(dash.attention.suspended_users.total, 1); assert.deepEqual(dash.attention.workspaces_without_active_owner.map((w) => w.id), [A.w]);
  assert.equal((await ops.c('GET', `/api/admin/users/${A.uid}`)).json.user.status, 'SUSPENDED');
  assert.equal((await ops.c('GET', `/api/admin/workspaces/${A.w}`)).json.warnings.length, 1);
  // reactivate → login works, project still there
  assert.equal((await ops.c('POST', `/api/admin/users/${A.uid}/reactivate`, {})).status, 200);
  assert.equal((await ops.c('POST', `/api/admin/users/${A.uid}/reactivate`, {})).status, 409);
  const c2 = client(); assert.equal((await c2('POST', '/api/auth/login', { email: 'a@x.com', password: 'passw0rd!' })).status, 200);
  assert.deepEqual((await c2('GET', A.purl)).json.project.id, before.id);
  assert.equal((await ops.c('GET', '/api/admin/audit')).json.total, 2);
  // guards
  assert.equal((await ops.c('POST', `/api/admin/users/${ops.uid}/suspend`, {})).json.error.code, 'cannot_suspend_self');
  assert.equal((await ops.c('POST', `/api/admin/users/${A.uid}/suspend`, { reason: 'x'.repeat(501) })).status, 400);
  assert.equal((await ops.c('POST', '/api/admin/users/nope/suspend', {})).status, 404);
  server.close();
});

test('admin action is atomic: when the audit insert fails the status change rolls back', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  // admin id that violates the audit FK → INSERT fails → whole transaction rolls back
  await assert.rejects(suspendUser(db, { id: 'ghost-admin' }, A.uid, {}), /violates foreign key|invalid_reference|foreign/i);
  assert.equal((await db.get('SELECT status FROM users WHERE id = ?', [A.uid])).status, 'ACTIVE');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [A.uid])).n, 1);
  assert.equal((await listAudit(db)).total, 0);
  assert.equal((await A.c('GET', '/api/me')).status, 200);
  server.close();
});

test('workspaces: list (owner, counts, last activity, search by name/owner email), detail (members, usage with limits, no subscription), suspend blocks every workspace call, reactivate restores', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'a@x.com', '김가나');
  const B = await addMember(client, A, 'b@x.com', '박나다', 'MEMBER');
  await A.c('POST', `${A.req}`, { title: 'R1' }); await A.c('POST', `${A.wbs}`, { title: 'W1', item_type: 'TASK' });
  const other = await setup(client, 'z@x.com', '정다라');
  const list = (await ops.c('GET', '/api/admin/workspaces')).json;
  assert.equal(list.total, 4);                                                   // A, B, Z, ops (signup auto-creates one each)
  const wa = list.items.find((w) => w.id === A.w);
  assert.equal(wa.owner_email, 'a@x.com'); assert.equal(wa.member_count, 2); assert.equal(wa.project_count, 1); assert.equal(wa.plan, 'FREE'); assert.ok(wa.last_activity_at >= wa.created_at);
  assert.deepEqual((await ops.c('GET', '/api/admin/workspaces?q=z%40x.com')).json.items.map((w) => w.id), [other.w]);
  assert.equal((await ops.c('GET', '/api/admin/workspaces?size=3&page=2')).json.items.length, 1);
  // detail
  const d = (await ops.c('GET', `/api/admin/workspaces/${A.w}`)).json;
  assert.equal(d.members.length, 2); assert.equal(d.owners[0].email, 'a@x.com'); assert.equal(d.projects.active, 1); assert.equal(d.subscription, null);
  const dims = Object.fromEntries(d.usage.dims.map((x) => [x.key, x]));
  assert.deepEqual([dims.projects.used, dims.projects.limit, dims.members.used, dims.requirements.used, dims.wbs.used, dims.weekly_reports.used], [1, 1, 2, 1, 1, 0]);
  assert.equal(d.usage.plan, 'FREE'); assert.equal(d.usage.tier, 'attention');
  assert.ok(!JSON.stringify(d).includes('R1'));                                  // requirement content never leaves the admin API
  assert.equal((await ops.c('GET', '/api/admin/workspaces/nope')).status, 404);
  // suspend → every /api/workspaces/:wid/* call refused for members, login still fine, data kept
  const s = await ops.c('POST', `/api/admin/workspaces/${A.w}/suspend`, { reason: '결제 분쟁' }); assert.equal(s.status, 200);
  assert.equal((await A.c('GET', A.purl)).json.error.code, 'workspace_suspended');
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/projects`)).status, 403);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, project())).status, 403);
  assert.equal((await B.c('GET', A.req)).status, 403);
  assert.equal((await A.c('GET', '/api/me')).status, 200);
  assert.equal((await A.c('GET', '/api/me')).json.workspaces[0].status, 'SUSPENDED');
  assert.equal((await ops.c('GET', `/api/workspaces/${A.w}/projects`)).status, 404);   // operator is still not a member
  assert.equal((await ops.c('POST', `/api/admin/workspaces/${A.w}/suspend`, {})).status, 409);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM requirements')).n, 1);
  const dash = (await ops.c('GET', '/api/admin/dashboard')).json;
  assert.equal(dash.attention.suspended_workspaces.total, 1); assert.equal(dash.kpis.active_workspaces, 3);
  // reactivate
  assert.equal((await ops.c('POST', `/api/admin/workspaces/${A.w}/reactivate`, {})).status, 200);
  assert.equal((await A.c('GET', A.purl)).status, 200);
  const audit = (await ops.c('GET', '/api/admin/audit?target_type=WORKSPACE')).json;
  assert.deepEqual(audit.items.map((x) => x.action), ['REACTIVATE_WORKSPACE', 'SUSPEND_WORKSPACE']);
  assert.match(audit.items[1].summary, /결제 분쟁/);
  server.close();
});

test('usage: aggregation + limit %, tiers (warn ≥80, attention ≥90), sorts; dashboard KPIs, funnel, near-limit attention; billing KPIs hidden while billing is absent', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'a@x.com', '김가나');                           // 1 project = 100 % of FREE (limit 1) → attention
  const Bs = await client()('POST', '/api/auth/signup', { name: '박나다', email: 'b@x.com', password: 'passw0rd!' });   // no project → ok
  const Bw = Bs.json.workspaces[0].id;
  const u = (await ops.c('GET', '/api/admin/usage?sort=projects')).json;
  assert.equal(u.items[0].workspace_id, A.w); assert.equal(u.items[0].tier, 'attention'); assert.equal(u.items[0].max_pct, 100);
  assert.equal(u.items.find((x) => x.workspace_id === Bw).tier, 'ok');
  assert.deepEqual(u.plans.FREE.limits, { projects: 1, members: 3, requirements: 10, wbs: 30, weekly_reports: 8 });
  for (const s of ['requirements', 'wbs', 'activity']) assert.equal((await ops.c('GET', `/api/admin/usage?sort=${s}`)).status, 200);
  assert.equal((await ops.c('GET', '/api/admin/usage?sort=bogus')).json.sort, 'projects');
  // tier thresholds on the shaping function (80 % is not reachable with the small member limit in an integration flow)
  assert.equal(shapeUsage({ projects: 0, members: 0, requirements: 8, wbs: 0, weekly_reports: 0 }).tier, 'warn');
  assert.equal(shapeUsage({ projects: 0, members: 0, requirements: 9, wbs: 0, weekly_reports: 0 }).tier, 'attention');
  assert.equal(shapeUsage({ projects: 0, members: 0, requirements: 7, wbs: 24, weekly_reports: 0 }).tier, 'warn');
  assert.equal(shapeUsage({ projects: 0, members: 0, requirements: 0, wbs: 0, weekly_reports: 0 }, 'TEAM').max_pct, null);
  // requirements 8/10 inside A's project → still attention (projects 100 %) but the dim itself reports 80 %
  for (let i = 0; i < 8; i++) await A.c('POST', A.req, { title: `R${i}` });
  const dA = (await ops.c('GET', `/api/admin/workspaces/${A.w}`)).json.usage;
  assert.equal(dA.dims.find((x) => x.key === 'requirements').pct, 80); assert.equal(dA.tier, 'attention');
  // dashboard
  const d = (await ops.c('GET', '/api/admin/dashboard')).json;
  assert.deepEqual([d.kpis.users, d.kpis.active_workspaces, d.kpis.projects, d.kpis.signups_7d, d.kpis.signups_today], [3, 3, 1, 3, 3]);
  assert.deepEqual(d.funnel_7d, { registered: 3, workspace_created: 3, project_created: 1 });
  assert.deepEqual(d.attention.near_limit.map((x) => x.workspace_id), [A.w]);
  assert.equal(d.billing.implemented, false);
  for (const k of ['mrr', 'team_workspaces', 'past_due', 'payment_failed_7d']) assert.ok(!(k in d.kpis), k);     // no fake zeros
  assert.ok(!('paid' in d.funnel_7d) && !('payment_failed' in d.attention));
  server.close();
});

test('audit: pagination, filters (action, admin, target type), search by email / workspace name; admin audit separate from project history', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const ops2 = await operator(db, client, 'ops2@relai.io');
  const users = [];
  for (let i = 0; i < 7; i++) { const s = await client()('POST', '/api/auth/signup', { name: `유저${i}`, email: `u${i}@x.com`, password: 'passw0rd!' }); users.push(s.json); }
  for (const u of users) await ops.c('POST', `/api/admin/users/${u.user.id}/suspend`, { reason: `r${u.user.name}` });
  for (const u of users.slice(0, 3)) await ops2.c('POST', `/api/admin/users/${u.user.id}/reactivate`, {});
  await ops2.c('POST', `/api/admin/workspaces/${users[0].workspaces[0].id}/suspend`, {});
  const all = (await ops.c('GET', '/api/admin/audit')).json; assert.equal(all.total, 11);
  const p = (await ops.c('GET', '/api/admin/audit?size=4&page=3')).json; assert.equal(p.items.length, 3);
  assert.equal(all.items[0].action, 'SUSPEND_WORKSPACE');                                 // newest first
  assert.equal((await ops.c('GET', '/api/admin/audit?action=REACTIVATE_USER')).json.total, 3);
  assert.equal((await ops.c('GET', `/api/admin/audit?admin=${ops2.uid}`)).json.total, 4);
  assert.equal((await ops.c('GET', '/api/admin/audit?admin=ops2%40relai.io')).json.total, 4);
  assert.equal((await ops.c('GET', '/api/admin/audit?target_type=WORKSPACE')).json.total, 1);
  assert.equal((await ops.c('GET', '/api/admin/audit?q=u5%40x.com')).json.total, 1);
  assert.equal((await ops.c('GET', `/api/admin/audit?q=${encodeURIComponent('유저0님의 Workspace')}`)).json.total, 1);
  assert.equal((await ops.c('GET', `/api/admin/audit?q=${users[1].user.id}`)).json.total, 2);
  // project-level history tables untouched by operator actions
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM requirement_history')).n, 0);
  server.close();
});

test('billing admin: absent tables → implemented:false everywhere, 404 details; with tables present the views light up and never expose billing keys / raw TIDs / card data', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'a@x.com', '김가나');
  assert.deepEqual((await ops.c('GET', '/api/admin/subscriptions')).json.implemented, false);
  assert.deepEqual((await ops.c('GET', '/api/admin/payments')).json.items, []);
  assert.equal((await ops.c('GET', '/api/admin/subscriptions/x')).status, 404);
  assert.equal((await ops.c('GET', '/api/admin/payments/x')).status, 404);
  assert.equal((await ops.c('GET', '/api/admin/billing')).json.billing.implemented, false);
  // Simulate the Billing phase landing (contract columns + sensitive extras that must stay hidden)
  await db.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, current_period_start timestamptz, current_period_end timestamptz,
      next_billing_at timestamptz, cancel_at_period_end boolean DEFAULT false, grace_period_end timestamptz, payment_method_summary TEXT, billing_key TEXT, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE payments (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subscription_id TEXT, plan TEXT, amount numeric, currency TEXT, status TEXT, provider TEXT, provider_result_code TEXT,
      provider_tid TEXT, moid TEXT, card_number TEXT, merchant_key TEXT, birth_date TEXT, paid_at timestamptz, failed_at timestamptz, failure_code TEXT, failure_message TEXT, created_at timestamptz DEFAULT now());`);
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, payment_method_summary, billing_key) VALUES ('s1', ?, 'TEAM', 'PAST_DUE', '신한 ****1234', 'BK-SECRET')`, [A.w]);
  await db.run(`INSERT INTO payments (id, workspace_id, subscription_id, plan, amount, currency, status, provider, provider_result_code, provider_tid, moid, card_number, merchant_key, birth_date, failed_at, failure_code, failure_message)
    VALUES ('p1', ?, 's1', 'TEAM', 49000, 'KRW', 'FAILED', 'NICEPAY', '3001', 'TID1234567890ABCD', 'MOID-77', '1234-5678-9012-3456', 'MK-SECRET', '1990-01-01', now(), 'E3001', '한도 초과')`, [A.w]);
  resetBillingCache();
  const subs = (await ops.c('GET', '/api/admin/subscriptions')).json; assert.equal(subs.implemented, true); assert.equal(subs.total, 1); assert.equal(subs.items[0].workspace_name, '김가나님의 Workspace');
  const sd = (await ops.c('GET', '/api/admin/subscriptions/s1')).json; assert.equal(sd.subscription.payment_method_summary, '신한 ****1234'); assert.equal(sd.payments.length, 1);
  const pays = (await ops.c('GET', '/api/admin/payments?q=MOID-77')).json; assert.equal(pays.total, 1);
  const pd = (await ops.c('GET', '/api/admin/payments/p1')).json.payment;
  assert.equal(pd.provider_tid_masked, '*************ABCD'); assert.equal(pd.failure_message, '한도 초과'); assert.equal(pd.amount, 49000);
  for (const body of [JSON.stringify(subs), JSON.stringify(sd), JSON.stringify(pays), JSON.stringify(pd)]) {
    for (const secret of ['BK-SECRET', 'MK-SECRET', '1234-5678', '1990-01-01', 'TID1234567890ABCD', 'billing_key', 'card_number', 'merchant_key', 'birth_date']) assert.ok(!body.includes(secret), secret);
  }
  assert.equal(maskTid('ab'), '**'.slice(0, 0) + 'ab');
  assert.equal((await ops.c('GET', '/api/admin/payments?q=ABCD')).json.total, 1);                   // search by masked tail
  const d = (await ops.c('GET', '/api/admin/dashboard')).json;
  assert.equal(d.billing.implemented, true); assert.deepEqual([d.kpis.team_workspaces, d.kpis.past_due, d.kpis.payment_failed_7d, d.kpis.mrr], [0, 1, 1, null]);   // PAST_DUE is not an active TEAM; MRR null until prices exist
  assert.equal(d.attention.payment_failed.length, 1); assert.equal(d.attention.past_due.length, 1);
  assert.equal((await ops.c('GET', `/api/admin/workspaces/${A.w}`)).json.subscription.plan, 'TEAM');
  assert.ok(!JSON.stringify(d).includes('BK-SECRET'));
  server.close();
});

test('last login is recorded on login and signup; deactivated accounts cannot log in either', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com', '김가나');
  const t1 = (await db.get('SELECT last_login_at FROM users WHERE id = ?', [A.uid])).last_login_at; assert.ok(t1);
  await new Promise((r) => setTimeout(r, 20));
  await client()('POST', '/api/auth/login', { email: 'a@x.com', password: 'passw0rd!' });
  const t2 = (await db.get('SELECT last_login_at FROM users WHERE id = ?', [A.uid])).last_login_at; assert.ok(t2 > t1);
  await db.run(`UPDATE users SET status = 'DEACTIVATED' WHERE id = ?`, [A.uid]);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'a@x.com', password: 'passw0rd!' })).status, 403);
  assert.equal((await A.c('GET', '/api/me')).status, 403);                                     // existing session revoked on next request
  assert.equal((await A.c('GET', '/api/me')).status, 401);                                     // cookie cleared → plain unauthenticated afterwards
  server.close();
});
