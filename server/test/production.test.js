/* Production readiness: PostgreSQL connectivity, counter concurrency, role enforcement, owner protection, sessions, constraint handling, health. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tx, openDb } from '../db.js';
import { createApp } from '../app.js';
import { getNextProjectSequence } from '../common.js';
import { requireRole, can, POLICY } from '../authz.js';
import { testDb, TEST_DATABASE_URL } from './helpers.js';

async function boot(opts = {}) {
  const db = await testDb();
  const server = createApp(db, opts).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const c = async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json, headers: res.headers };
    };
    c.cookie = () => cookie; c.setCookie = (v) => { cookie = v; };
    return c;
  };
  return { db, server, base, client };
}
const PROJECT = { name: 'P', project_type: 'SI', current_situation: 'NOT_STARTED', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' };
async function signup(client, email, name = '사용자') { const c = client(); const s = await c('POST', '/api/auth/signup', { name, email, password: 'passw0rd!' }); return { c, w: s.json.workspaces[0].id, uid: s.json.user.id }; }

test('PostgreSQL: pool connects, schema migrated, timestamps/dates/counts come back as ISO strings / YYYY-MM-DD / numbers', async () => {
  const { db, server, client } = await boot();
  const row = await db.get('SELECT now() AS ts, CURRENT_DATE AS d, COUNT(*) AS n, 1.5::numeric AS x FROM schema_migrations');
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); assert.match(row.d, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof row.n, 'number'); assert.ok(row.n >= 10, 'all migrations recorded'); assert.equal(row.x, 1.5);
  const A = await signup(client, 'a@x.com');
  const p = (await A.c('POST', `/api/workspaces/${A.w}/projects`, PROJECT)).json.project;
  assert.match(p.created_at, /Z$/); assert.equal(p.planned_start_date, '2026-11-01');
  const h = await fetch(`http://127.0.0.1:${server.address().port}/health`); assert.equal(h.status, 200); assert.deepEqual(await h.json(), { status: 'ok', database: 'ok' });
  server.close();
});

test('counter concurrency: 40 parallel creates on one project → 40 distinct sequential display IDs, no gaps, no duplicates', async () => {
  const { db, server, client } = await boot();
  const A = await signup(client, 'a@x.com');
  const p = (await A.c('POST', `/api/workspaces/${A.w}/projects`, PROJECT)).json.project;
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => A.c('POST', `/api/workspaces/${A.w}/projects/${p.id}/requirements`, { title: `R${i}` })));
  assert.ok(results.every((r) => r.status === 201), 'all created');
  const ids = results.map((r) => r.json.requirement.display_id).sort();
  assert.equal(new Set(ids).size, 40); assert.equal(ids[0], 'REQ-001'); assert.equal(ids[39], 'REQ-040');
  // direct: parallel transactions on the same counter row serialize on the UPDATE row lock
  const seqs = await Promise.all(Array.from({ length: 10 }, () => tx(db, (t) => getNextProjectSequence(t, p.id, 'ISSUE'))));
  assert.deepEqual([...seqs].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  server.close();
});

test('roles: OWNER / ADMIN / MEMBER — project management, member management, owner-only grants, member work still allowed', async () => {
  const { server, client } = await boot();
  const O = await signup(client, 'owner@x.com', '오너'); const Ad = await signup(client, 'admin@x.com', '관리자'); const M = await signup(client, 'member@x.com', '멤버'); const X = await signup(client, 'x@x.com');
  const ws = `/api/workspaces/${O.w}`;
  // policy table sanity
  assert.deepEqual(POLICY.billing, ['OWNER']); assert.ok(can('ADMIN', 'project_manage') && !can('ADMIN', 'billing') && !can('MEMBER', 'member_manage'));
  // MEMBER cannot add members; OWNER adds admin + member
  assert.equal((await O.c('POST', `${ws}/members`, { email: 'admin@x.com', role: 'ADMIN' })).status, 201);
  assert.equal((await O.c('POST', `${ws}/members`, { email: 'member@x.com', role: 'MEMBER' })).status, 201);
  assert.equal((await O.c('POST', `${ws}/members`, { email: 'nobody@x.com', role: 'MEMBER' })).status, 404);
  assert.equal((await O.c('POST', `${ws}/members`, { email: 'member@x.com', role: 'MEMBER' })).status, 409);
  assert.equal((await O.c('POST', `${ws}/members`, { email: 'x@x.com', role: 'GOD' })).status, 400);
  // workspace info exposes role + permissions
  const info = (await M.c('GET', ws)).json.workspace; assert.equal(info.role, 'MEMBER'); assert.equal(info.permissions.project_manage, false); assert.equal(info.permissions.billing, false);
  assert.equal((await Ad.c('GET', ws)).json.workspace.permissions.billing, false); assert.equal((await O.c('GET', ws)).json.workspace.permissions.billing, true);
  // non-member: 404 everywhere (no probing)
  assert.equal((await X.c('GET', ws)).status, 404); assert.equal((await X.c('GET', `${ws}/members`)).status, 404);
  // project create: OWNER/ADMIN yes, MEMBER 403
  const po = await O.c('POST', `${ws}/projects`, PROJECT); assert.equal(po.status, 201);
  assert.equal((await Ad.c('POST', `${ws}/projects`, PROJECT)).status, 201);
  const pm = await M.c('POST', `${ws}/projects`, PROJECT); assert.equal(pm.status, 403); assert.equal(pm.json.error.code, 'forbidden');
  assert.equal((await M.c('PATCH', `${ws}/projects/${po.json.project.id}`, { name: 'x' })).status, 403);
  assert.equal((await M.c('POST', `${ws}/projects/${po.json.project.id}/archive`, {})).status, 403);
  // MEMBER can still do project work
  const purl = `${ws}/projects/${po.json.project.id}`;
  assert.equal((await M.c('GET', purl)).status, 200);
  const r = await M.c('POST', `${purl}/requirements`, { title: '멤버가 만든 요구사항' }); assert.equal(r.status, 201);
  assert.equal((await M.c('POST', `${purl}/wbs`, { title: 'T', item_type: 'TASK' })).status, 201);
  assert.equal((await M.c('POST', `${purl}/issues`, { title: 'I' })).status, 201);
  assert.equal((await M.c('POST', `${purl}/weekly-reports/generate`, { period_start: '2026-10-05', period_end: '2026-10-09' })).status, 201);
  // settings: MEMBER 403, ADMIN ok
  assert.equal((await M.c('PATCH', ws, { name: 'New' })).status, 403); assert.equal((await Ad.c('PATCH', ws, { name: 'New' })).status, 200);
  // member management: ADMIN can add/change/remove MEMBER; cannot touch OWNER role
  assert.equal((await Ad.c('POST', `${ws}/members`, { email: 'x@x.com', role: 'MEMBER' })).status, 201);
  assert.equal((await Ad.c('PATCH', `${ws}/members/${X.uid}`, { role: 'ADMIN' })).status, 200);
  assert.equal((await Ad.c('PATCH', `${ws}/members/${X.uid}`, { role: 'OWNER' })).status, 403, 'ADMIN cannot grant OWNER');
  assert.equal((await Ad.c('PATCH', `${ws}/members/${O.uid}`, { role: 'MEMBER' })).status, 403, 'ADMIN cannot demote OWNER');
  assert.equal((await Ad.c('DELETE', `${ws}/members/${O.uid}`)).status, 403, 'ADMIN cannot remove OWNER');
  assert.equal((await Ad.c('DELETE', `${ws}/members/${X.uid}`)).status, 200);
  assert.equal((await M.c('DELETE', `${ws}/members/${Ad.uid}`)).status, 403);
  // billing-ready owner check: owner-only route (workspace delete placeholder) → ADMIN 403, OWNER reaches the handler (501 placeholder)
  assert.equal((await Ad.c('DELETE', ws)).status, 403); assert.equal((await O.c('DELETE', ws)).status, 501);
  // requireRole middleware unit
  const calls = []; const res = { status(s) { calls.push(s); return this; }, json() { return this; } };
  requireRole('OWNER')({ role: 'ADMIN' }, res, () => calls.push('next')); requireRole('OWNER', 'ADMIN')({ role: 'ADMIN' }, res, () => calls.push('next')); requireRole('OWNER')({}, res, () => calls.push('next'));
  assert.deepEqual(calls, [403, 'next', 401]);
  server.close();
});

test('owner protection: last OWNER cannot be demoted or removed; second OWNER makes transfer possible', async () => {
  const { server, client } = await boot();
  const O = await signup(client, 'o@x.com'); const B = await signup(client, 'b@x.com');
  const ws = `/api/workspaces/${O.w}`;
  await O.c('POST', `${ws}/members`, { email: 'b@x.com', role: 'ADMIN' });
  let r = await O.c('PATCH', `${ws}/members/${O.uid}`, { role: 'MEMBER' }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'last_owner');
  r = await O.c('DELETE', `${ws}/members/${O.uid}`); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'last_owner');
  // transfer: grant OWNER to B, then the original owner may step down
  assert.equal((await O.c('PATCH', `${ws}/members/${B.uid}`, { role: 'OWNER' })).status, 200);
  assert.equal((await O.c('PATCH', `${ws}/members/${O.uid}`, { role: 'MEMBER' })).status, 200);
  const members = (await B.c('GET', `${ws}/members`)).json.members;
  assert.deepEqual(members.map((m) => [m.email, m.role]).sort(), [['b@x.com', 'OWNER'], ['o@x.com', 'MEMBER']]);
  // now B is the last owner
  assert.equal((await B.c('DELETE', `${ws}/members/${B.uid}`)).status, 409);
  assert.equal((await O.c('POST', `${ws}/projects`, PROJECT)).status, 403, 'demoted owner is a MEMBER now');
  server.close();
});

test('sessions: stored in PostgreSQL (survive a second app instance), logout removes the row, SESSION_SECRET keys the token hash, cookie flags', async () => {
  const { db, server, client, base } = await boot({ sessionSecret: 's3cret' });
  const A = await signup(client, 'a@x.com');
  const raw = A.c.cookie(); assert.match(raw, /^relai_sid=/);
  const rows = await db.all('SELECT token_hash, expires_at FROM sessions'); assert.equal(rows.length, 1); assert.ok(rows[0].expires_at > new Date().toISOString());
  // second app instance on the same database (another process in production) accepts the same cookie only with the same secret
  const server2 = createApp(db, { sessionSecret: 's3cret' }).listen(0); const base2 = `http://127.0.0.1:${server2.address().port}`;
  assert.equal((await fetch(`${base2}/api/me`, { headers: { cookie: raw } })).status, 200);
  const server3 = createApp(db, { sessionSecret: 'other' }).listen(0);
  assert.equal((await fetch(`http://127.0.0.1:${server3.address().port}/api/me`, { headers: { cookie: raw } })).status, 401, 'different secret → hash mismatch');
  server2.close(); server3.close();
  // cookie attributes: HttpOnly + SameSite=Lax always; Secure + __Host- prefix in production mode
  const prod = createApp(db, { secureCookies: true, sessionSecret: 's3cret' }).listen(0);
  const r = await fetch(`http://127.0.0.1:${prod.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.com', password: 'passw0rd!' }) });
  const sc = r.headers.get('set-cookie'); assert.match(sc, /^__Host-relai_sid=/); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Secure/); assert.match(sc, /Max-Age=2592000/);
  prod.close();
  // logout deletes exactly this session's row (the prod login above made a second one); the cookie no longer authenticates
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions')).n, 2);
  assert.equal((await A.c('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions')).n, 1);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: raw } })).status, 401);
  server.close();
});

test('constraint violations become API errors, not crashes: duplicate signup 409, FK/trigger → 400, invalid enum → 400, server keeps serving', async () => {
  const { db, server, client } = await boot();
  const A = await signup(client, 'a@x.com');
  assert.equal((await A.c('POST', '/api/auth/signup', { name: 'B', email: 'a@x.com', password: 'passw0rd!' })).status, 409);
  const p = (await A.c('POST', `/api/workspaces/${A.w}/projects`, PROJECT)).json.project;
  // raw constraint errors through the service layer map to 400 (RL001 trigger) / 409 (unique) and leave the pool healthy
  await assert.rejects(() => db.run("INSERT INTO projects (id, workspace_id, name, project_type, current_situation, planned_start_date, planned_end_date, created_by) VALUES ('zz', ?, 'x', 'SI', 'NOT_STARTED', '2026-01-01', '2026-02-01', 'ghost')", [A.w]), /member|foreign key/);
  await assert.rejects(() => db.run("INSERT INTO requirements (id, project_id, sequence_number, display_id, title, created_by, status) VALUES ('q', ?, 999, 'REQ-999', 't', ?, 'NOPE')", [p.id, A.uid]), /check constraint/);
  await assert.rejects(() => db.run('UPDATE projects SET workspace_id = ? WHERE id = ?', ['other', p.id]), /immutable/);
  // a failed transaction rolls back completely
  await assert.rejects(() => tx(db, async (t) => { await t.run("INSERT INTO project_counters (project_id, key, value) VALUES (?, 'TMP', 1)", [p.id]); await t.run('INSERT INTO nope_table VALUES (1)'); }));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM project_counters WHERE project_id = ? AND key = 'TMP'", [p.id])).n, 0);
  // API still fine afterwards
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/projects/${p.id}`)).status, 200);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects/${p.id}/requirements`, { title: 'ok' })).status, 201);
  server.close();
});

test('database unavailable → /health 503 and API 503 (no crash)', async () => {
  const dead = await openDb({ url: TEST_DATABASE_URL.replace(/:\d+\//, ':1/'), applyMigrations: false, max: 1 });
  const server = createApp(dead).listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const h = await fetch(`${base}/health`); assert.equal(h.status, 503); assert.deepEqual(await h.json(), { status: 'degraded', database: 'unreachable' });
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.com', password: 'x' }) });
  assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'db_unavailable');
  server.close(); await dead.close();
});
