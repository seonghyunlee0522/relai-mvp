/* Plan limits ON with operators exempt (founder 2026-10-21, Slack 1792510926.552669 "관리자만 예외로하고 켜줘"):
 *   a FREE workspace owned by an operator (users.system_role = 'SYSTEM_ADMIN') → every active project editable, invites past 3 seats,
 *   no over-limit / read-only banner data; a normal FREE workspace → newest project editable, the rest 409 project_read_only,
 *   the 4th seat 402 plan_limit_reached. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boot, setup, project } from './api-helpers.js';
import { operatorOwned, projectAccess, overLimit } from '../billing/limits.js';
import { allWorkspacesUsage } from '../usage.js';

process.env.PLAN_LIMITS = 'on';
process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake';
delete process.env.OVER_LIMIT_LOCK;
const ws = (w) => `/api/workspaces/${w}`;
const mkProject = async (db, w, owner, mins) => {
  const id = randomUUID();
  await db.run(`INSERT INTO projects (id, workspace_id, name, status, created_by, planned_start_date, planned_end_date, created_at) VALUES (?,?,?, 'ACTIVE', ?, '2026-11-01', '2027-02-28', now() - make_interval(mins => ?))`,
    [id, w, `p-${id.slice(0, 4)}`, owner, mins]);
  return id;
};
/** FREE workspace with 3 active projects (A.p oldest), as after a downgrade. Returns ids oldest → newest. */
async function threeProjects(db, A) {
  await db.run(`UPDATE projects SET created_at = now() - interval '300 minutes' WHERE id = ?`, [A.p.id]);
  return [A.p.id, await mkProject(db, A.w, A.uid, 200), await mkProject(db, A.w, A.uid, 100)];
}
const write = (A, pid) => A.c('POST', `${ws(A.w)}/projects/${pid}/requirements`, { title: '요구사항', description: 'x' });
const invite = (A, email) => A.c('POST', `${ws(A.w)}/invitations`, { email, role: 'MEMBER' });

test('operator-owned FREE workspace: 3 projects all editable, new projects and invites past 3 seats allowed, no banner data', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'op@x.com');
  await db.run(`UPDATE users SET email_verified_at = now(), system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [A.uid]);
  assert.equal(await operatorOwned(db, A.w), true);
  const ids = await threeProjects(db, A);
  for (const id of ids) assert.equal((await write(A, id)).status, 201);
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: '넷째' }))).status, 201);
  for (const e of ['a1', 'a2', 'a3', 'a4']) assert.equal((await invite(A, `${e}@x.com`)).status, 201, e);
  assert.equal((await projectAccess(db, A.w)).readOnly.size, 0);
  assert.equal(await overLimit(db, A.w), null);
  const list = (await A.c('GET', `${ws(A.w)}/projects`)).json.projects;
  assert.ok(list.every((p) => p.read_only === false));
  const b = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing;
  assert.equal(b.plan, 'FREE'); assert.deepEqual(b.limits, { projects: null, users: null });
  assert.equal(b.over_limit, null); assert.equal(b.usage.seats_left, null);
  assert.ok(b.usage.dims.every((d) => d.limit === null && d.pct === null));
  const row = (await allWorkspacesUsage(db, { q: '' })).items.find((r) => r.workspace_id === A.w);
  assert.equal(row.max_pct, null);
  server.close();
});

test('an operator who is only a MEMBER does not exempt the workspace; an OWNER membership does (owner_id may be null)', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'own@x.com');
  const O = await setup(client, 'op2@x.com');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [O.uid]);
  await db.run(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?, 'MEMBER')`, [A.w, O.uid]);
  assert.equal(await operatorOwned(db, A.w), false);
  await db.run(`UPDATE workspace_members SET role = 'OWNER' WHERE workspace_id = ? AND user_id = ?`, [A.w, O.uid]);
  await db.run('UPDATE workspaces SET owner_id = NULL WHERE id = ?', [A.w]);
  assert.equal(await operatorOwned(db, A.w), true);
  server.close();
});

test('normal FREE workspace: newest project editable, the others 409 project_read_only; 2nd project 402; 4th seat 402', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'free@x.com');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [A.uid]);
  assert.equal(await operatorOwned(db, A.w), false);
  const [oldest, mid, newest] = await threeProjects(db, A);
  assert.equal((await write(A, newest)).status, 201);
  for (const id of [oldest, mid]) { const r = await write(A, id); assert.equal(r.status, 409); assert.equal(r.json.error?.code ?? r.json.code, 'project_read_only'); }
  const np = await A.c('POST', `${ws(A.w)}/projects`, project({ name: '넷째' }));
  assert.equal(np.status, 402); assert.match(JSON.stringify(np.json), /plan_limit_reached/);
  assert.equal((await invite(A, 'b1@x.com')).status, 201);
  assert.equal((await invite(A, 'b2@x.com')).status, 201);   // owner + 2 pending = 3 seats
  const r4 = await invite(A, 'b3@x.com');
  assert.equal(r4.status, 402); assert.match(JSON.stringify(r4.json), /plan_limit_reached/);
  const b = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing;
  assert.deepEqual(b.limits, { projects: 1, users: 3 }); assert.ok(b.over_limit);
  server.close();
});
