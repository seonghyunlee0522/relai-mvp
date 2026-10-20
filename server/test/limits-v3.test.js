/* Pricing v3 T1 — limits, seats and project states (spec §1.3 / §1.4, design.md §5, decisions D1 + D6):
 *   members = active accounts in workspace_members (one seat per person, deactivated/suspended excluded), pending invites hold a seat,
 *   active projects = DRAFT / ACTIVE / ON_HOLD (COMPLETED / ARCHIVED / samples never count), unarchive/reopen at the limit → 402,
 *   COMPLETED / ARCHIVED are read-only (409), over the limit after a downgrade → nothing deleted, editing locked until cleanup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boot, setup, project, addMember } from './api-helpers.js';
import { tx } from '../db.js';
import { countUsage, assertSeatForInvite, overLimit, PlanLimitError } from '../billing/limits.js';
import * as I from '../invitations.js';
import { migrations } from '../migrations.js';
import { createOrder, quotePlan } from '../billing/orders.js';
import { limitsFor } from '../plans.js';

process.env.PLAN_LIMITS = 'on';
process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake';
delete process.env.OVER_LIMIT_LOCK;
const ws = (w) => `/api/workspaces/${w}`;
const mkUser = async (db, email, status = 'ACTIVE') => {
  const id = randomUUID();
  await db.run(`INSERT INTO users (id, email, name, password_hash, status, email_verified_at) VALUES (?,?,?,?,?, now())`, [id, email, email.split('@')[0], 'x', status]);
  return { id, email, status };
};
const join = (db, w, uid, role = 'MEMBER') => db.run('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)', [w, uid, role]);
const mkProject = async (db, w, owner, status, extra = {}) => {
  const id = randomUUID();
  await db.run(`INSERT INTO projects (id, workspace_id, name, status, created_by, sample_key, planned_start_date, planned_end_date) VALUES (?,?,?,?,?,?, '2026-11-01', '2027-02-28')`,
    [id, w, `${status}-${id.slice(0, 4)}`, status, owner, extra.sample_key || null]);
  return id;
};
const subscribe = (db, w, plan, o = {}) => db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, billing_cycle, auto_renew, current_period_start, current_period_end, next_billing_at, extra_users, extra_projects)
  VALUES (?,?,?,'ACTIVE',?, ?, now() - interval '10 days', ${o.ended ? "now() - interval '1 day'" : "now() + interval '20 days'"}, NULL, ?, ?)`,
[randomUUID(), w, plan, o.cycle || 'MONTHLY', o.auto_renew ?? false, o.extra_users || 0, o.extra_projects || 0]);

test('counting: a person is one seat however many projects; deactivated / suspended / deleted accounts and removed members are not seats; pending invites reserve', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'cnt@x.com');
  await db.run('UPDATE users SET email_verified_at = now()');
  let u = await countUsage(db, A.w);
  assert.deepEqual(u, { projects_active: 1, members: 1, pending_invites: 0 });
  const B = await addMember(client, A, 'cnt-b@x.com', '비');
  // B in three projects of the same workspace: still one seat
  for (let i = 0; i < 2; i += 1) await mkProject(db, A.w, A.uid, 'COMPLETED');
  u = await countUsage(db, A.w); assert.equal(u.members, 2);
  const gone = await mkUser(db, 'gone@x.com', 'DEACTIVATED'); await join(db, A.w, gone.id);
  const sus = await mkUser(db, 'sus@x.com', 'SUSPENDED'); await join(db, A.w, sus.id);
  const del = await mkUser(db, 'del@x.com'); await join(db, A.w, del.id); await db.run('UPDATE users SET deleted_at = now() WHERE id = ?', [del.id]);
  assert.equal((await countUsage(db, A.w)).members, 2);
  await db.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [A.w, B.uid]);
  assert.equal((await countUsage(db, A.w)).members, 1);
  // the same person in a second workspace counts there too
  const C = await setup(client, 'cnt-c@x.com');
  await join(db, C.w, A.uid);
  assert.equal((await countUsage(db, C.w)).members, 2); assert.equal((await countUsage(db, A.w)).members, 1);
  // pending (unexpired) invites reserve; expired / revoked do not
  assert.equal((await A.c('POST', `${ws(A.w)}/invitations`, { email: 'p1@x.com', role: 'MEMBER' })).status, 201);
  await db.run(`INSERT INTO invitations (id, type, workspace_id, email, role, token_hash, invited_by, expires_at, status) VALUES (?, 'WORKSPACE_MEMBER', ?, 'old@x.com', 'MEMBER', ?, ?, now() - interval '1 day', 'PENDING')`, [randomUUID(), A.w, randomUUID(), A.uid]);
  assert.equal((await countUsage(db, A.w)).pending_invites, 1);
  server.close();
});

test('active projects by status: DRAFT / ACTIVE / ON_HOLD count; COMPLETED / ARCHIVED / samples do not (D1: no requirement/WBS caps)', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'st@x.com');   // 1 ACTIVE
  for (const s of ['DRAFT', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']) await mkProject(db, A.w, A.uid, s);
  await mkProject(db, A.w, A.uid, 'ACTIVE', { sample_key: 'demo' });
  assert.equal((await countUsage(db, A.w)).projects_active, 3);
  const b = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing;
  assert.equal(b.usage.projects_active, 3); assert.deepEqual(b.limits, { projects: 1, users: 3 });
  assert.deepEqual(b.usage.dims.map((d) => d.key), ['projects', 'members']);
  // D1: requirements and WBS are never capped any more (FREE used to stop at 50 / 100)
  await db.run(`UPDATE projects SET status = 'ARCHIVED' WHERE workspace_id = ? AND id <> ? AND sample_key IS NULL`, [A.w, A.p.id]);
  const rows = Array.from({ length: 120 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `w${i}` } }));
  assert.equal((await A.c('POST', `${A.wbs}/import`, { rows })).status, 200);
  assert.equal((await A.c('POST', A.wbs, { title: '121번째', item_type: 'TASK' })).status, 201);
  server.close();
});

test('FREE 1 active project: create / unarchive / reopen at the limit → 402; completing or archiving frees the slot; COMPLETED / ARCHIVED are read-only', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pj@x.com');
  let r = await A.c('POST', `${ws(A.w)}/projects`, project({ name: '둘째' }));
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'plan_limit_reached'); assert.equal(r.json.error.limit.limit, 1); assert.equal(r.json.error.limit.plan, 'FREE');
  assert.equal(r.json.error.upgrade.url, '/app/billing/plans');
  // complete the first (07 종료 → COMPLETED): it stops counting
  await db.run(`UPDATE projects SET status = 'COMPLETED' WHERE id = ?`, [A.p.id]);
  r = await A.c('POST', `${ws(A.w)}/projects`, project({ name: '둘째' })); assert.equal(r.status, 201);
  const second = r.json.project;
  // COMPLETED: read OK, edits 409, reopen at the limit 402
  assert.equal((await A.c('GET', A.purl)).status, 200);
  r = await A.c('PATCH', A.purl, { name: '바꿈' }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'project_completed');
  r = await A.c('POST', A.req, { title: '완료 후 추가', description: 'x' }); assert.equal(r.status, 409);
  r = await A.c('POST', `${A.purl}/reopen`, {}); assert.equal(r.status, 402); assert.equal(r.json.error.limit.dimension, 'projects');
  // archive the second → reopen the first works
  assert.equal((await A.c('POST', `${ws(A.w)}/projects/${second.id}/archive`, {})).status, 200);
  r = await A.c('PATCH', `${ws(A.w)}/projects/${second.id}`, { name: '보관 중 수정' }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'archived');
  r = await A.c('POST', `${A.purl}/reopen`, {}); assert.equal(r.status, 200); assert.equal(r.json.project.status, 'ACTIVE');
  // unarchive back to ACTIVE at the limit → 402; a project archived from COMPLETED comes back COMPLETED without a check
  r = await A.c('POST', `${ws(A.w)}/projects/${second.id}/unarchive`, {}); assert.equal(r.status, 402);
  const done = await mkProject(db, A.w, A.uid, 'ARCHIVED');
  await db.run(`UPDATE projects SET status_before_archive = 'COMPLETED' WHERE id = ?`, [done]);
  r = await A.c('POST', `${ws(A.w)}/projects/${done}/unarchive`, {}); assert.equal(r.status, 200); assert.equal(r.json.project.status, 'COMPLETED');
  // nothing was deleted along the way
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM projects WHERE workspace_id = ? AND sample_key IS NULL', [A.w])).n), 3);
  server.close();
});

test('seat reservation: invites count pending seats (FREE 3 users); revoke frees it; resending an expired invite re-reserves; direct add respects reservations', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'seat@x.com');
  await db.run('UPDATE users SET email_verified_at = now()');
  assert.equal((await A.c('POST', `${ws(A.w)}/invitations`, { email: 's1@x.com', role: 'MEMBER' })).status, 201);
  const second = await A.c('POST', `${ws(A.w)}/invitations`, { email: 's2@x.com', role: 'MEMBER' });
  assert.equal(second.status, 201);
  let r = await A.c('POST', `${ws(A.w)}/invitations`, { email: 's3@x.com', role: 'MEMBER' });   // 1 member + 2 pending = 3
  assert.equal(r.status, 402); assert.equal(r.json.error.limit.dimension, 'members'); assert.equal(r.json.error.limit.pending, 2);
  // a direct add cannot take a reserved seat either
  await mkUser(db, 'direct@x.com');
  assert.equal((await A.c('POST', `${ws(A.w)}/members`, { email: 'direct@x.com', role: 'MEMBER' })).status, 402);
  // revoke one → the seat is free again
  assert.equal((await A.c('DELETE', `${ws(A.w)}/invitations/${second.json.invitation.id}`)).status, 200);
  assert.equal((await A.c('POST', `${ws(A.w)}/invitations`, { email: 's3@x.com', role: 'MEMBER' })).status, 201);
  // an expired invite holds nothing; resending it re-reserves and is refused when full
  await db.run(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE workspace_id = ? AND email = 's1@x.com'`, [A.w]);
  assert.equal((await countUsage(db, A.w)).pending_invites, 1);
  assert.equal((await A.c('POST', `${ws(A.w)}/invitations`, { email: 's4@x.com', role: 'MEMBER' })).status, 201);
  const s1 = await db.get(`SELECT id FROM invitations WHERE workspace_id = ? AND email = 's1@x.com'`, [A.w]);
  assert.equal((await A.c('POST', `${ws(A.w)}/invitations/${s1.id}/resend`, {})).status, 402);
  const b = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing;
  assert.deepEqual([b.usage.members, b.usage.pending_invites, b.usage.seats_left], [1, 2, 0]);
  server.close();
});

test('seat races: two concurrent invites for the last seat → one 201, one 402; two concurrent accepts for the last seat → one joins, the other 402 and stays PENDING', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'race@x.com');
  await db.run('UPDATE users SET email_verified_at = now()');
  const B = await addMember(client, A, 'race-b@x.com', '비');   // 2 of 3 seats
  const res = await Promise.all(['r1@x.com', 'r2@x.com'].map((email) => A.c('POST', `${ws(A.w)}/invitations`, { email, role: 'MEMBER' })));
  assert.deepEqual(res.map((x) => x.status).sort(), [201, 402]);
  // accepts: two invitations exist (inserted directly, as after a downgrade), one seat is left → only one accept wins
  await db.run(`UPDATE invitations SET status = 'REVOKED' WHERE workspace_id = ?`, [A.w]);
  const u1 = await mkUser(db, 'a1@x.com'); const u2 = await mkUser(db, 'a2@x.com');
  const inv = [];
  for (const u of [u1, u2]) {
    const id = randomUUID();
    await db.run(`INSERT INTO invitations (id, type, workspace_id, email, role, token_hash, invited_by, expires_at, status) VALUES (?, 'WORKSPACE_MEMBER', ?, ?, 'MEMBER', ?, ?, now() + interval '1 day', 'PENDING')`, [id, A.w, u.email, randomUUID(), A.uid]);
    inv.push({ id, user: u });
  }
  const out = await Promise.allSettled(inv.map(({ id, user }) => tx(db, async (t) => I.acceptInvite(t, { id, type: 'WORKSPACE_MEMBER' }, user))));
  assert.deepEqual(out.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  const lost = out.find((o) => o.status === 'rejected').reason;
  assert.ok(lost instanceof PlanLimitError); assert.equal(lost.status, 402);
  const u = await countUsage(db, A.w);
  assert.deepEqual([u.members, u.pending_invites], [3, 1]);   // the loser's invite stays PENDING (accept after an upgrade)
  assert.ok(B.uid);
  server.close();
});

test('PRO with add-ons: limits = included + extra; plan limits from the subscription; GET …/billing v3 shape', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pro@x.com');
  await subscribe(db, A.w, 'PRO', { extra_users: 2, extra_projects: 1, auto_renew: true });
  await db.run(`UPDATE subscriptions SET next_billing_at = current_period_end WHERE workspace_id = ?`, [A.w]);
  for (let i = 0; i < 3; i += 1) assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: `p${i}` }))).status, 201);   // 4 of 4
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: 'p5' }))).status, 402);
  const b = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing;
  assert.equal(b.plan, 'PRO'); assert.equal(b.cycle, 'MONTHLY'); assert.equal(b.status, 'ACTIVE'); assert.equal(b.auto_renew, true);
  assert.deepEqual(b.limits, { projects: 4, users: 17 });
  assert.deepEqual(b.addons, { extra_users: 2, extra_projects: 1 });
  assert.equal(b.next_payment_amount, 30000 + 2000 + 10000); assert.ok(b.next_payment_at);
  assert.deepEqual([b.usage.projects_active, b.usage.members, b.usage.pending_invites], [4, 1, 0]);
  assert.deepEqual(b.scheduled, []); assert.equal(typeof b.credits.total, 'number');
  assert.deepEqual(b.catalogue.plans.map((p) => p.key), ['FREE', 'PRO', 'TEAM', 'ENTERPRISE']);
  assert.deepEqual(Object.keys(b.flags).sort(), ['addons', 'checkout_open', 'payments', 'plan_change', 'recurring', 'refund_partial']);
  assert.equal(b.over_limit, null);
  // FREE workspace: no cycle, no payment
  const F = await setup(client, 'free@x.com');
  const f = (await F.c('GET', `${ws(F.w)}/billing`)).json.billing;
  assert.deepEqual([f.plan, f.cycle, f.next_payment_amount, f.next_payment_at, f.auto_renew], ['FREE', null, null, null, false]);
  server.close();
});

test('over limit after expiry (founder policy 2026-10-21): nothing deleted, all readable, newest project editable, older ones read-only (409 project_read_only) except 보관', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'over@x.com');
  await subscribe(db, A.w, 'PRO');
  const p2 = (await A.c('POST', `${ws(A.w)}/projects`, project({ name: '둘째' }))).json.project;
  const p3 = (await A.c('POST', `${ws(A.w)}/projects`, project({ name: '셋째' }))).json.project;
  assert.equal((await A.c('POST', A.req, { title: '요구사항', description: 'x' })).status, 201);
  // the PRO period ends → FREE (1 project)
  await db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE workspace_id = ?`, [A.w]);
  const st = await overLimit(db, A.w);
  assert.deepEqual([st.plan, st.projects, st.members], ['FREE', 2, 0]);
  assert.equal((await A.c('GET', A.req)).status, 200);   // readable
  let r = await A.c('POST', A.req, { title: '잠김', description: 'x' });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'project_read_only'); assert.deepEqual(r.json.error.read_only, { plan: 'FREE', limit: 1 });
  assert.equal((await A.c('PATCH', A.purl, { name: '잠김' })).status, 409);
  assert.equal((await A.c('PATCH', `${ws(A.w)}/projects/${p3.id}`, { ...project({ name: '셋째 수정' }) })).status, 200);   // the newest stays editable
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: '넷째' }))).status, 402);
  const b = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing;
  assert.deepEqual(b.over_limit, { projects: 2, members: 0 });
  assert.deepEqual(b.read_only_projects.editable.map((x) => x.id), [p3.id]); assert.deepEqual(b.read_only_projects.read_only.map((x) => x.id), [p2.id, A.p.id]);
  const list = (await A.c('GET', `${ws(A.w)}/projects`)).json.projects;
  assert.deepEqual(Object.fromEntries(list.filter((x) => !x.sample_key).map((x) => [x.id, x.read_only])), { [p3.id]: false, [p2.id]: true, [A.p.id]: true });
  // 보관 is allowed on a read-only project (no data change); 종료 is not
  assert.equal((await A.c('POST', `${ws(A.w)}/projects/${p2.id}/close`, {})).json.error.code, 'project_read_only');
  assert.equal((await A.c('POST', `${ws(A.w)}/projects/${p2.id}/archive`, {})).status, 200);
  assert.equal((await A.c('POST', A.req, { title: '아직 잠김', description: 'x' })).status, 409);   // still behind the newest
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM projects WHERE workspace_id = ? AND sample_key IS NULL', [A.w])).n), 3);
  // OVER_LIMIT_LOCK=off turns the read-only lock off (only new rows refused)
  process.env.OVER_LIMIT_LOCK = 'off';
  assert.equal((await A.c('POST', A.req, { title: '잠금 끔', description: 'x' })).status, 201);
  delete process.env.OVER_LIMIT_LOCK;
  server.close();
});

test('mig 57: subscriptions.plan accepts FREE/PRO/TEAM/ENTERPRISE; pre-v3 paid rows → v2 (idempotent) and keep what they bought; order kinds + client_key', async () => {
  const { db, server, client } = await boot();
  const ids = [];
  for (const plan of ['FREE', 'PRO', 'TEAM', 'ENTERPRISE']) { const A = await setup(client, `m-${plan}@x.com`); ids.push(A.w); await subscribe(db, A.w, plan); }
  await assert.rejects(db.run(`UPDATE subscriptions SET plan = 'GOLD' WHERE workspace_id = ?`, [ids[0]]));
  await db.run(`UPDATE subscriptions SET price_version = NULL`);
  const m57 = migrations.find((m) => m.version === 57);
  await m57.up(db); await m57.up(db);
  const rows = await db.all('SELECT plan, price_version FROM subscriptions ORDER BY plan');
  assert.deepEqual(rows.map((r) => [r.plan, r.price_version]), [['ENTERPRISE', 'v2'], ['FREE', null], ['PRO', 'v2'], ['TEAM', 'v2']]);
  await db.run(`UPDATE subscriptions SET seats = 4 WHERE workspace_id = ?`, [ids[2]]);
  const team = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [ids[2]]);
  assert.deepEqual(limitsFor(team), { projects: null, users: 4 });   // legacy TEAM keeps unlimited projects and its seats until the period ends
  // orders: v3 kinds, add-on columns, double click (same client_key) → same order
  const q = quotePlan({ plan: 'PRO', cycle: 'MONTHLY', extra_users: 2 });
  const o1 = await createOrder(db, { workspaceId: ids[1], userId: null, provider: 'fake', kind: 'ONE_TIME', q, clientKey: 'k-1' });
  const o2 = await createOrder(db, { workspaceId: ids[1], userId: null, provider: 'fake', kind: 'ONE_TIME', q, clientKey: 'k-1' });
  assert.equal(o1.id, o2.id); assert.equal(o1.amount, 32000); assert.equal(o1.addon_users, 2); assert.equal(o1.price_version, 'v3-2026-10');
  for (const kind of ['ADDON', 'UPGRADE', 'CREDIT_TOPUP']) await createOrder(db, { workspaceId: ids[1], userId: null, provider: 'fake', kind, q });
  await assert.rejects(createOrder(db, { workspaceId: ids[1], userId: null, provider: 'fake', kind: 'BOGUS', q }));
  server.close();
});

test('assertSeatForInvite outside HTTP: unlimited ENTERPRISE never refuses', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'ent@x.com');
  await subscribe(db, A.w, 'ENTERPRISE');
  for (let i = 0; i < 5; i += 1) await tx(db, (t) => assertSeatForInvite(t, A.w));
  await db.run(`UPDATE subscriptions SET seats = 1 WHERE workspace_id = ?`, [A.w]);
  await assert.rejects(tx(db, (t) => assertSeatForInvite(t, A.w)), PlanLimitError);
  server.close();
});
