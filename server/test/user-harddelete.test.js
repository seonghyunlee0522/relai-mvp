/* 회원 탈퇴 = hard delete (migration 56): users row gone, shared work survives as '탈퇴한 사용자', retained records detached, purge, backfill. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { USER_REFS, userFkColumns, hardDeleteDeactivated, purgeRetained } from '../auth/user-delete.js';
import { migrations } from '../migrations.js';
import { purgeExpired } from '../maintenance.js';

const n = async (db, sql, p = []) => Number((await db.get(sql, p)).n);
const W = '탈퇴한 사용자';

/** A owns the shared workspace; B is a member who writes a requirement, a comment and a status change there, buys credits and sends feedback. */
async function sharedWork(client, db) {
  const A = await setup(client, 'owner@x.com', '오너');
  const B = await addMember(client, A, 'leaver@x.com', '떠날사람', 'ADMIN');
  const r = await B.c('POST', A.req, { title: 'B가 쓴 요구사항', description: '' }); assert.equal(r.status, 201);
  const rid = r.json.requirement.id;
  assert.ok((await B.c('POST', `${A.req}/${rid}/comments`, { body: 'B의 댓글' })).status < 300);
  assert.equal((await B.c('PATCH', `${A.req}/${rid}`, { priority: 'HIGH' })).status, 200);
  assert.ok((await B.c('POST', '/api/feedback', { category: 'BUG', message: '불편해요', workspace_id: A.w })).status < 300);
  await db.run(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, unit_price, list_amount, supply_amount, vat_amount, amount, goods_name, credits, status, paid_at)
    VALUES ('ord-b', ?, ?, 'fake', 'CREDIT_PACK', 11000, 11000, 10000, 1000, 11000, 'RELAI AI 크레딧 1,000', 1000, 'PAID', now())`, [A.w, B.uid]);
  return { A, B, rid };
}

test('every FK to users is handled explicitly by hardDeleteUser (a new table must be added to USER_REFS)', async () => {
  const { db, server } = await boot();
  const listed = new Set(USER_REFS.map(([t, c]) => `${t}.${c}`));
  const fks = (await userFkColumns(db)).map((r) => `${r.tbl}.${r.col}`);
  assert.ok(fks.length >= 50);
  assert.deepEqual(fks.filter((k) => !listed.has(k)), []);
  server.close();
});

test('withdrawal deletes the users row; shared-workspace records survive with a NULL author shown as 탈퇴한 사용자; payments and feedback stay detached', async () => {
  const { client, db, server } = await boot();
  const { A, B, rid } = await sharedWork(client, db);
  const r = await B.c('DELETE', '/api/me', { password: 'passw0rd!' }); assert.equal(r.status, 200);

  assert.equal(await n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', [B.uid]), 0);
  for (const t of ['sessions', 'user_identities', 'user_onboarding', 'workspace_members', 'analytics_active_days']) assert.equal(await n(db, `SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, [B.uid]), 0, t);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM analytics_events WHERE user_id = ?', [B.uid]), 0);
  // no column anywhere still holds B's id
  for (const [t, c] of USER_REFS) assert.equal(await n(db, `SELECT COUNT(*) n FROM ${t} WHERE ${c} = ?`, [B.uid]), 0, `${t}.${c}`);

  // shared work survives, author NULL → '탈퇴한 사용자'
  const req = await db.get('SELECT created_by FROM requirements WHERE id = ?', [rid]); assert.equal(req.created_by, null);
  const detail = (await A.c('GET', `${A.req}/${rid}`)).json.requirement;
  assert.equal(detail.comments[0].author_name, W);
  assert.ok(detail.history.length >= 2 && detail.history.every((h) => h.changed_by_name === W));
  const act = (await A.c('GET', `${A.purl}/activity`)).json;
  const items = act.items || act.events || act;
  assert.ok(items.some((e) => e.actor_name === W));
  assert.ok(!JSON.stringify(items).includes('떠날사람'));

  // retained records: no user id, a pseudonym + the buyer fields on the order
  const ref = (await db.get(`SELECT ref FROM account_withdrawals ORDER BY withdrawn_at DESC LIMIT 1`)).ref;
  const ord = await db.get(`SELECT user_id, withdrawn_ref, buyer_name, buyer_email, amount, status FROM billing_orders WHERE id = 'ord-b'`);
  assert.deepEqual(ord, { user_id: null, withdrawn_ref: ref, buyer_name: '떠날사람', buyer_email: 'leaver@x.com', amount: 11000, status: 'PAID' });
  const fb = await db.get('SELECT user_id, withdrawn_ref FROM feedback LIMIT 1'); assert.deepEqual(fb, { user_id: null, withdrawn_ref: ref });
  assert.ok(await n(db, 'SELECT COUNT(*) n FROM login_records WHERE withdrawn_ref = ? AND user_id IS NULL', [ref]) >= 1);
  const audit = await db.get(`SELECT admin_user_id, withdrawn_ref, target_id, metadata FROM admin_audit_logs WHERE action = 'ACCOUNT_DELETED'`);
  assert.equal(audit.admin_user_id, null); assert.equal(audit.withdrawn_ref, ref); assert.equal(audit.target_id, ref);
  const consent = await db.get('SELECT terms_version, privacy_version, source FROM account_withdrawals WHERE ref = ?', [ref]);
  assert.ok(consent.terms_version && consent.privacy_version); assert.equal(consent.source, 'SELF');
  // the accepted invitation / member add no longer names the address
  assert.equal(await n(db, `SELECT COUNT(*) n FROM invitations WHERE email = 'leaver@x.com'`), 0);
  server.close();
});

test('re-signup with the same e-mail is a brand-new account with none of the old data', async () => {
  const { client, db, server } = await boot();
  const { A, B } = await sharedWork(client, db);
  assert.equal((await B.c('DELETE', '/api/me', { password: 'passw0rd!' })).status, 200);
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '새사람', email: 'leaver@x.com', password: 'passw0rd!' });
  assert.equal(s.status, 201); assert.notEqual(s.json.user.id, B.uid);
  const me = (await c('GET', '/api/me')).json;
  assert.equal(me.workspaces.length, 1); assert.notEqual(me.workspaces[0].id, A.w);
  assert.ok([403, 404].includes((await c('GET', `/api/workspaces/${A.w}/projects`)).status));
  for (const [t, col] of [['requirements', 'created_by'], ['feedback', 'user_id'], ['billing_orders', 'user_id'], ['comments', 'created_by']]) {
    assert.equal(await n(db, `SELECT COUNT(*) n FROM ${t} WHERE ${col} = ?`, [s.json.user.id]), 0, t);
  }
  server.close();
});

test('purge job deletes each retained class only after its period', async () => {
  const { client, db, server } = await boot();
  const { A, B } = await sharedWork(client, db);
  assert.equal((await B.c('DELETE', '/api/me', { password: 'passw0rd!' })).status, 200);
  const ref = (await db.get('SELECT ref FROM account_withdrawals')).ref;
  // old copies of each class (just past the period) next to fresh ones (just inside it)
  await db.run(`INSERT INTO account_withdrawals (ref, withdrawn_at) VALUES ('wd_old', now() - interval '5 years 1 day'), ('wd_keep', now() - interval '4 years 360 days')`);
  await db.run(`INSERT INTO feedback (id, withdrawn_ref, category, message, created_at) VALUES ('fb-old', 'wd_old', 'BUG', 'x', now() - interval '3 years 1 day'), ('fb-keep', 'wd_old', 'BUG', 'x', now() - interval '2 years 360 days')`);
  await db.run(`INSERT INTO feedback (id, user_id, category, message, created_at) VALUES ('fb-live', ?, 'BUG', 'x', now() - interval '4 years')`, [A.uid]);   // a live account's: untouched
  const order = (id, ago, who) => db.run(`INSERT INTO billing_orders (id, workspace_id, user_id, withdrawn_ref, provider, kind, unit_price, list_amount, supply_amount, vat_amount, amount, goods_name, credits, status, created_at)
    VALUES (?, ?, ?, ?, 'fake', 'CREDIT_PACK', 1, 1, 1, 0, 1, 'g', 1, 'PAID', now() - ?::interval)`, [id, A.w, who === 'live' ? A.uid : null, who === 'live' ? null : 'wd_old', ago]);
  await order('ord-old', '5 years 1 day', 'gone'); await order('ord-keep', '4 years 360 days', 'gone'); await order('ord-live', '6 years', 'live');
  await db.run(`INSERT INTO login_records (id, withdrawn_ref, method, created_at) VALUES ('lr-old', 'wd_old', 'PASSWORD', now() - interval '3 months 1 day'), ('lr-keep', 'wd_old', 'PASSWORD', now() - interval '80 days')`);
  const so = (id, ago) => db.run(`INSERT INTO service_orders (id, product, kind, provider, goods_name, amount, supply_amount, vat_amount, buyer_name, buyer_email, buyer_phone, terms_version, privacy_version, created_at)
    VALUES (?, 'agent-once', 'ONE_TIME', 'fake', 'g', 1, 1, 0, 'n', 'e@x.com', '010', 't', 'p', now() - ?::interval)`, [id, ago]);
  await so('so-old', '5 years 1 day'); await so('so-keep', '4 years 360 days');
  // a deleted workspace whose tombstone (payments only) was purged more than 5 years ago, and one purged 4 years ago
  for (const [wid, ago] of [['ws-old', '5 years 1 day'], ['ws-keep', '4 years']]) {
    await db.run(`INSERT INTO workspaces (id, name, owner_id, status, deleted_at, purged_at) VALUES (?, '삭제된 워크스페이스', NULL, 'CLOSED', now() - ?::interval, now() - ?::interval)`, [wid, ago, ago]);
    await db.run(`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_tid, paid_at) VALUES (?, ?, 1000, 'PAID', 'fake', ?, now() - ?::interval)`, [`p-${wid}`, wid, `tid-${wid}`, ago]);
  }

  const out = await purgeExpired(db);
  assert.equal(out.withdrawals, 1); assert.equal(out.complaints, 1); assert.equal(out.withdrawn_orders, 1); assert.equal(out.service_orders, 1); assert.equal(out.workspace_payments, 1);
  const ids = async (sql) => (await db.all(sql)).map((r) => r.id).sort();
  assert.deepEqual((await db.all('SELECT ref FROM account_withdrawals ORDER BY ref')).map((r) => r.ref), [ref, 'wd_keep'].sort());
  assert.deepEqual(await ids(`SELECT id FROM feedback WHERE id LIKE 'fb-%'`), ['fb-keep', 'fb-live']);
  assert.deepEqual(await ids(`SELECT id FROM billing_orders WHERE id LIKE 'ord-%'`), ['ord-b', 'ord-keep', 'ord-live']);
  assert.deepEqual(await ids(`SELECT id FROM login_records WHERE id LIKE 'lr-%'`), ['lr-keep']);
  assert.deepEqual(await ids(`SELECT id FROM service_orders`), ['so-keep']);
  assert.deepEqual(await ids(`SELECT id FROM payments`), ['p-ws-keep']);
  assert.deepEqual(await ids(`SELECT id FROM workspaces WHERE id LIKE 'ws-%'`), ['ws-keep']);
  // running it again changes nothing
  const again = await purgeRetained(db);
  assert.deepEqual(again, { withdrawals: 0, complaints: 0, withdrawn_orders: 0, service_orders: 0, workspace_payments: 0 });
  server.close();
});

test('migration 56 backfill: DEACTIVATED tombstones are hard-deleted with the same rules; idempotent', async () => {
  const { client, db, server } = await boot();
  const { A, B, rid } = await sharedWork(client, db);
  // a pre-56 withdrawal: the old code left a tombstone row (name / e-mail replaced, status DEACTIVATED), membership and identities gone
  await db.run('DELETE FROM workspace_members WHERE user_id = ?', [B.uid]);
  await db.run('DELETE FROM user_identities WHERE user_id = ?', [B.uid]);
  await db.run(`UPDATE users SET email = ?, name = '탈퇴한 사용자', password_hash = NULL, status = 'DEACTIVATED', deleted_at = now() - interval '2 days' WHERE id = ?`, [`deleted-${B.uid}@deleted.invalid`, B.uid]);
  const m56 = migrations.find((m) => m.version === 56);
  assert.ok(m56);
  await m56.up(db);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', [B.uid]), 0);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', [A.uid]), 1);
  assert.equal((await db.get('SELECT created_by FROM requirements WHERE id = ?', [rid])).created_by, null);
  const w = await db.get(`SELECT source, withdrawn_at < now() - interval '1 day' AS kept_date FROM account_withdrawals`);
  assert.deepEqual(w, { source: 'BACKFILL', kept_date: true });
  const ord = await db.get(`SELECT user_id, buyer_name, buyer_email FROM billing_orders WHERE id = 'ord-b'`);
  assert.deepEqual(ord, { user_id: null, buyer_name: null, buyer_email: null });   // the tombstone held no real name / e-mail to copy
  assert.equal((await A.c('GET', `${A.req}/${rid}`)).json.requirement.comments[0].author_name, W);
  // second run: nothing left, nothing changes
  await m56.up(db);
  assert.equal(await hardDeleteDeactivated(db), 0);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM account_withdrawals'), 1);
  server.close();
});
