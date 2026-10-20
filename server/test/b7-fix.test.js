/* Batch7 review fixes (Jim 2026-10-20, research/relai-batch7-review.md): P1-1 the WBS GET never writes fixed nodes into a real
 * project from a preview deploy; 관리자 › 테스트 계정 정리 (one-off purge of every user but the operator, founder 2026-10-20).
 * P0-1 / P2s are covered in legal, promotions, credits-billing, paywall, limits-bulk and email-admin-test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boot, setup, addMember, project } from './api-helpers.js';
import { structureOnOpen } from '../wbs-structure.js';
import { PURGE_MAX_USERS } from '../purge.js';

const fixed = async (db, pid) => Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ? AND system_key IS NOT NULL', [pid])).n);
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('P1-1: GET …/wbs on a preview deploy leaves a real project untouched (sample projects still structured); prod/local unchanged', async () => {
  assert.equal(structureOnOpen({}, {}), true);
  assert.equal(structureOnOpen({}, { VERCEL_ENV: 'production' }), true);
  assert.equal(structureOnOpen({}, { VERCEL_ENV: 'preview' }), false);
  assert.equal(structureOnOpen({ sample_key: 'si-portal' }, { VERCEL_ENV: 'preview' }), true);

  const { db, server, client } = await boot();
  const A = await setup(client, 'wbs-prev@x.com');
  await withEnv({ VERCEL_ENV: 'preview' }, async () => {
    const r = await A.c('GET', A.wbs); assert.equal(r.status, 200);
    assert.equal(await fixed(db, A.p.id), 0);   // nothing written into the (shared) production data
  });
  assert.equal((await A.c('GET', A.wbs)).status, 200);
  assert.ok(await fixed(db, A.p.id) > 0);       // production / local: fixed phase nodes appear on open, as before
  server.close();
});

/** Operator + a small floor of test accounts. */
async function floor(db, client) {
  const O = await setup(client, 'ops@relai.io', '운영자');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [O.uid]);
  // A: own workspace with data, feedback and a pending invitation → all deleted
  const A = await setup(client, 'a@test.io', '에이');
  for (const t of ['r1', 'r2']) assert.equal((await A.c('POST', A.req, { title: t })).status, 201);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '둘째' }))).status, 201);
  await db.run(`INSERT INTO feedback (id, user_id, workspace_id, category, message) VALUES (?,?,?,'BUG','test')`, [randomUUID(), A.uid, A.w]);
  await db.run(`INSERT INTO invitations (id, type, role, email, token_hash, expires_at, workspace_id, invited_by) VALUES (?, 'WORKSPACE_MEMBER', 'MEMBER', 'x@test.io', ?, now() + interval '7 days', ?, ?)`, [randomUUID(), randomUUID(), A.w, A.uid]);
  // B: a member of the operator's workspace who wrote a requirement there → B goes, the requirement stays (now the operator's)
  const B = await addMember(client, O, 'b@test.io', '비');
  const breq = (await B.c('POST', O.req, { title: 'B가 쓴 요구사항' })).json.requirement;
  // C: owns a workspace the operator is a member of → kept, ownership passes to the operator
  const C = await setup(client, 'c@test.io', '씨');
  await db.run(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'MEMBER')`, [C.w, O.uid]);
  return { O, A, B, C, breq };
}

test('purge: non-operator 403, preview refused, confirm required; dry run = real run; keeps the operator + their workspaces, deletes the rest; audit has counts only', async () => {
  const { db, server, client } = await boot();
  const { O, A, B, C, breq } = await floor(db, client);
  const url = '/api/admin/purge-test-accounts';

  assert.equal((await A.c('GET', url)).status, 403);
  assert.equal((await A.c('POST', url, { confirm: '삭제' })).status, 403);
  assert.equal((await client()('GET', url)).status, 401);
  await withEnv({ VERCEL_ENV: 'preview' }, async () => {
    for (const r of [await O.c('GET', url), await O.c('POST', url, { confirm: '삭제' })]) { assert.equal(r.status, 403); assert.equal(r.json.error.code, 'preview_refused'); }
  });
  const nope = await O.c('POST', url, { confirm: '네' });
  assert.equal(nope.status, 400); assert.equal(nope.json.error.code, 'confirm_required');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM users')).n), 4);   // nothing happened yet

  const dry = await O.c('GET', url);
  assert.equal(dry.status, 200); assert.equal(dry.json.dry_run, true);
  assert.deepEqual(
    { users: dry.json.counts.users, workspaces: dry.json.counts.workspaces, projects: dry.json.counts.projects, requirements: dry.json.counts.requirements, invitations: dry.json.counts.invitations, feedback: dry.json.counts.feedback },
    { users: 3, workspaces: 2, projects: 2, requirements: 2, invitations: 1, feedback: 1 });   // A's + B's own workspaces; C's is kept
  assert.deepEqual(dry.json.kept, { users: 1, workspaces: 2 });
  assert.equal(dry.json.labels.users, '회원');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM users')).n), 4);   // the dry run wrote nothing

  const run = await O.c('POST', url, { confirm: '삭제' });
  assert.equal(run.status, 200); assert.equal(run.json.dry_run, false);
  assert.deepEqual(run.json.counts, dry.json.counts);

  assert.deepEqual((await db.all('SELECT id FROM users')).map((u) => u.id), [O.uid]);
  assert.deepEqual((await db.all('SELECT id FROM workspaces ORDER BY id')).map((w) => w.id), [O.w, C.w].sort());
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM projects WHERE workspace_id = ?', [A.w])).n), 0);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM feedback')).n), 0);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM invitations WHERE workspace_id = ?', [A.w])).n), 0);
  const kept = await db.get('SELECT created_by FROM requirements WHERE id = ?', [breq.id]);
  assert.equal(kept.created_by, O.uid);                                                       // B's work in a kept workspace stays
  assert.equal((await db.get('SELECT owner_id FROM workspaces WHERE id = ?', [C.w])).owner_id, O.uid);
  assert.equal((await db.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [C.w, O.uid])).role, 'OWNER');
  assert.equal((await db.get('SELECT COUNT(*)::int n FROM workspace_members WHERE workspace_id = ?', [O.w])).n, 1);
  assert.equal((await O.c('GET', `/api/workspaces/${O.w}/projects`)).status, 200);           // the operator's session still works
  assert.equal((await B.c('GET', '/api/me')).status, 401);                                   // B's session is gone

  const audit = await db.get(`SELECT admin_user_id, target_type, metadata FROM admin_audit_logs WHERE action = 'PURGE_TEST_ACCOUNTS'`);
  assert.equal(audit.admin_user_id, O.uid); assert.equal(audit.target_type, 'SYSTEM');
  const meta = typeof audit.metadata === 'string' ? JSON.parse(audit.metadata) : audit.metadata;
  assert.deepEqual(meta.counts, dry.json.counts);
  assert.doesNotMatch(JSON.stringify(meta), /@/);                                            // counts only — no e-mail address

  const again = await O.c('GET', url);                                                       // re-run: nothing left to delete
  assert.equal(again.json.counts.users, 0); assert.equal(again.json.counts.workspaces, 0);
  server.close();
});

test(`purge: refuses above the safety cap (${PURGE_MAX_USERS} users) and deletes nothing`, async () => {
  const { db, server, client } = await boot();
  const O = await setup(client, 'ops2@relai.io', '운영자');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [O.uid]);
  await db.run(`INSERT INTO users (id, email, name) SELECT gen_random_uuid()::text, 'bulk' || g || '@test.io', '벌크' FROM generate_series(1, ${PURGE_MAX_USERS + 1}) g`);
  for (const r of [await O.c('GET', '/api/admin/purge-test-accounts'), await O.c('POST', '/api/admin/purge-test-accounts', { confirm: '삭제' })]) {
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'too_many_users');
  }
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM users')).n), PURGE_MAX_USERS + 2);
  server.close();
});
