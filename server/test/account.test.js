/* Account lifecycle (migration 30): profile edit, password change/set, 회원 탈퇴, workspace delete + 30-day purge, login records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { setGoogleProvider, fakeGoogleProvider } from '../auth/google.js';
import { purgeExpired } from '../maintenance.js';

process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake'; process.env.GOOGLE_PROVIDER = 'fake';
setEmailProvider(fakeEmailProvider());
const google = fakeGoogleProvider(); setGoogleProvider(google);

async function googleSignup(c, claims) {
  const start = await c('GET', '/api/auth/google/start?intent=signup&consent=1');
  const url = new URL(start.location, 'http://localhost');
  const code = google.issueCode({ email_verified: true, name: 'G User', ...claims, nonce: url.searchParams.get('nonce') });
  const cb = await c('GET', `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  assert.equal(cb.status, 302);
  return (await c('GET', '/api/me')).json;
}
const login = (client, email, password = 'passw0rd!') => { const c = client(); return c('POST', '/api/auth/login', { email, password }).then((r) => ({ c, r })); };
const n = async (db, sql, p = []) => Number((await db.get(sql, p)).n);

test('profile: name edit validated and reflected in /api/me', async () => {
  const { client } = await boot();
  const A = await setup(client, 'p@x.com');
  assert.equal((await A.c('PATCH', '/api/me', { name: '  ' })).status, 400);
  assert.equal((await A.c('PATCH', '/api/me', { name: 'x'.repeat(51) })).status, 400);
  const r = await A.c('PATCH', '/api/me', { name: '  김철수 ' }); assert.equal(r.status, 200); assert.equal(r.json.user.name, '김철수');
  assert.equal((await A.c('GET', '/api/me')).json.user.name, '김철수');
  assert.equal((await client()('PATCH', '/api/me', { name: 'a' })).status, 401);
});

test('password change: current password required, other sessions revoked (current kept), old password dead, login record written', async () => {
  const { client, db } = await boot();
  const A = await setup(client, 'pw@x.com');
  const { c: other } = await login(client, 'pw@x.com');
  assert.equal(await n(db, `SELECT COUNT(*) n FROM login_records WHERE user_id = ?`, [A.uid]), 2);   // signup + login
  const rec = await db.get(`SELECT method, ip FROM login_records WHERE user_id = ? AND method = 'PASSWORD'`, [A.uid]); assert.ok(rec.ip);

  let r = await A.c('POST', '/api/me/password', { current_password: 'wrong1pass', new_password: 'newpassw0rd' }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'invalid_password');
  r = await A.c('POST', '/api/me/password', { current_password: 'passw0rd!', new_password: 'short' }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'validation');
  r = await A.c('POST', '/api/me/password', { current_password: 'passw0rd!', new_password: 'passw0rd!' }); assert.equal(r.status, 400);
  r = await A.c('POST', '/api/me/password', { current_password: 'passw0rd!', new_password: 'newpassw0rd' }); assert.equal(r.status, 200); assert.equal(r.json.sessions_revoked, 1);
  assert.equal((await A.c('GET', '/api/me')).status, 200);
  assert.equal((await other('GET', '/api/me')).status, 401);
  assert.equal((await login(client, 'pw@x.com')).r.status, 401);
  assert.equal((await login(client, 'pw@x.com', 'newpassw0rd')).r.status, 200);
  assert.equal(await n(db, `SELECT COUNT(*) n FROM admin_audit_logs WHERE action = 'PASSWORD_CHANGED' AND target_id = ?`, [A.uid]), 1);

  // wrong current password is rate limited per user
  for (let i = 0; i < 5; i++) await A.c('POST', '/api/me/password', { current_password: 'bad1bad1', new_password: 'another1pw' });
  r = await A.c('POST', '/api/me/password', { current_password: 'newpassw0rd', new_password: 'another1pw' }); assert.equal(r.status, 429);
});

test('Google-only user: sets a password once e-mail is verified (no current password), then can log in with it', async () => {
  const { client, db } = await boot();
  const c = client(); const me = await googleSignup(c, { sub: 'g-set', email: 'gset@x.com' });
  let acc = (await c('GET', '/api/me/account')).json.account; assert.equal(acc.has_password, false); assert.equal(acc.can_set_password, true);
  assert.equal(await n(db, `SELECT COUNT(*) n FROM login_records WHERE user_id = ? AND method = 'GOOGLE'`, [me.user.id]), 1);
  await db.run('UPDATE users SET email_verified_at = NULL WHERE id = ?', [me.user.id]);
  let r = await c('POST', '/api/me/password', { new_password: 'googlepw1' }); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'email_unverified');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [me.user.id]);
  r = await c('POST', '/api/me/password', { new_password: 'googlepw1' }); assert.equal(r.status, 200);
  acc = (await c('GET', '/api/me/account')).json.account; assert.equal(acc.has_password, true); assert.deepEqual(acc.login_methods.map((m) => m.provider).sort(), ['GOOGLE', 'PASSWORD']);
  assert.equal((await login(client, 'gset@x.com', 'googlepw1')).r.status, 200);
  // from now on the current password is required
  assert.equal((await c('POST', '/api/me/password', { new_password: 'googlepw2' })).status, 400);
});

test('account deletion: re-auth, blocked while sole OWNER with members, then deleted; solo workspace deleted; e-mail reusable', async () => {
  const { client, db } = await boot();
  const A = await setup(client, 'del@x.com', '삭제자');
  const B = await addMember(client, A, 'mate@x.com', '동료');
  let r = await A.c('DELETE', '/api/me', { password: 'wrong1pass' }); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'invalid_password');
  r = await A.c('DELETE', '/api/me', { password: 'passw0rd!' }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'account_delete_blocked');
  assert.equal(r.json.error.blockers[0].code, 'sole_owner'); assert.equal(r.json.error.blockers[0].workspace_id, A.w);
  assert.equal((await A.c('GET', '/api/me/account')).json.account.deletion.blockers[0].code, 'sole_owner');

  // B (a plain member elsewhere, plus their own solo workspace) can leave at once
  const bWs = (await B.c('GET', '/api/me')).json.workspaces.find((w) => w.id !== A.w).id;
  r = await B.c('DELETE', '/api/me', { password: 'passw0rd!' }); assert.equal(r.status, 200); assert.deepEqual(r.json.workspaces_deleted.map((w) => w.id), [bWs]);
  assert.equal((await B.c('GET', '/api/me')).status, 401);
  assert.equal(await db.get('SELECT id FROM users WHERE id = ?', [B.uid]), undefined);   // mig 56: the account row itself is deleted
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM user_identities WHERE user_id = ?', [B.uid]), 0);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM workspace_members WHERE user_id = ? AND workspace_id = ?', [B.uid, A.w]), 0);
  assert.equal((await db.get('SELECT status FROM workspaces WHERE id = ?', [bWs])).status, 'CLOSED');
  assert.equal(await n(db, `SELECT COUNT(*) n FROM admin_audit_logs WHERE target_id = ? AND metadata::text LIKE '%mate@x.com%'`, [B.uid]), 0);
  assert.equal((await login(client, 'mate@x.com')).r.status, 401);
  // login records stay for their 3 months, detached: no user id, only the withdrawal pseudonym
  const ref = (await db.get(`SELECT target_id FROM admin_audit_logs WHERE action = 'ACCOUNT_DELETED' ORDER BY created_at DESC LIMIT 1`)).target_id;
  assert.match(ref, /^wd_/);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM login_records WHERE user_id = ?', [B.uid]), 0);
  assert.ok(await n(db, 'SELECT COUNT(*) n FROM login_records WHERE withdrawn_ref = ?', [ref]) >= 1);

  // A is now the only member → deletion goes through and takes the workspace along
  r = await A.c('DELETE', '/api/me', { password: 'passw0rd!' }); assert.equal(r.status, 200); assert.deepEqual(r.json.workspaces_deleted.map((w) => w.id), [A.w]);
  // the same address can sign up again as a brand-new account
  const again = await client()('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '새사람', email: 'del@x.com', password: 'passw0rd!' }); assert.equal(again.status, 201); assert.notEqual(again.json.user.id, A.uid);
});

test('account deletion: refused for a running paid subscription; Google-only re-auth needs a recent sign-in', async () => {
  const { client, db } = await boot();
  const A = await setup(client, 'paid@x.com');
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, current_period_end) VALUES ('s1', ?, 'TEAM', 'ACTIVE', 'fake', now() + interval '20 days')`, [A.w]);
  let r = await A.c('DELETE', '/api/me', { password: 'passw0rd!' }); assert.equal(r.status, 409); assert.equal(r.json.error.blockers[0].code, 'subscription_active');
  await db.run(`UPDATE subscriptions SET cancel_at_period_end = true WHERE id = 's1'`);
  assert.equal((await A.c('DELETE', '/api/me', { password: 'passw0rd!' })).status, 200);

  const c = client(); const me = await googleSignup(c, { sub: 'g-del', email: 'gdel@x.com' });
  await db.run(`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE user_id = ?`, [me.user.id]);
  r = await c('DELETE', '/api/me', {}); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'reauth_required');
  await db.run(`UPDATE sessions SET created_at = now() WHERE user_id = ?`, [me.user.id]);
  assert.equal((await c('DELETE', '/api/me', {})).status, 200);
});

test('workspace deletion: OWNER only, name + password confirmation, subscription guard, soft delete then 30-day purge keeps payments', async () => {
  const { client, db } = await boot();
  const A = await setup(client, 'own@x.com', '오너');
  const B = await addMember(client, A, 'adm@x.com', '관리자', 'ADMIN');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [A.uid]);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/invitations`, { email: 'pending@x.com', role: 'MEMBER' })).status, 201);
  assert.equal((await A.c('POST', `${A.req}`, { title: '요구사항 하나', description: '' })).status, 201);   // project children must cascade at purge
  const ws = (await A.c('GET', `/api/workspaces/${A.w}`)).json.workspace;

  assert.equal((await B.c('DELETE', `/api/workspaces/${A.w}`, { confirm_name: ws.name, password: 'passw0rd!' })).status, 403);
  let r = await A.c('DELETE', `/api/workspaces/${A.w}`, { confirm_name: 'nope', password: 'passw0rd!' }); assert.equal(r.status, 400);
  r = await A.c('DELETE', `/api/workspaces/${A.w}`, { confirm_name: ws.name, password: 'bad1bad1' }); assert.equal(r.status, 403);
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, current_period_end) VALUES ('s2', ?, 'TEAM', 'ACTIVE', 'fake', now() + interval '20 days')`, [A.w]);
  await db.run(`INSERT INTO payments (id, workspace_id, subscription_id, plan, amount, status, provider, provider_tid, paid_at) VALUES ('pay1', ?, 's2', 'TEAM', 45000, 'PAID', 'fake', 'tid-1', now())`, [A.w]);
  r = await A.c('DELETE', `/api/workspaces/${A.w}`, { confirm_name: ws.name, password: 'passw0rd!' }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'subscription_active');
  await db.run(`UPDATE subscriptions SET cancel_at_period_end = true WHERE id = 's2'`);

  r = await A.c('DELETE', `/api/workspaces/${A.w}`, { confirm_name: ws.name, password: 'passw0rd!' }); assert.equal(r.status, 200); assert.ok(r.json.purge_after); assert.ok(r.json.fallback_workspace_id);
  // gone for everyone at once; the owner lands in a fresh empty workspace, the admin keeps their own
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}`)).status, 404);
  assert.equal((await B.c('GET', `/api/workspaces/${A.w}/projects`)).status, 404);
  assert.deepEqual((await A.c('GET', '/api/me')).json.workspaces.map((w) => w.id), [r.json.fallback_workspace_id]);
  assert.ok(!(await B.c('GET', '/api/me')).json.workspaces.some((w) => w.id === A.w));
  assert.equal((await db.get(`SELECT status FROM invitations WHERE email = 'pending@x.com'`)).status, 'REVOKED');
  assert.equal(await n(db, `SELECT COUNT(*) n FROM admin_audit_logs WHERE action = 'WORKSPACE_DELETED' AND target_id = ?`, [A.w]), 1);

  // before 30 days nothing is purged
  await purgeExpired(db); assert.equal(await n(db, 'SELECT COUNT(*) n FROM projects WHERE workspace_id = ?', [A.w]), 1);
  await db.run(`UPDATE workspaces SET deleted_at = now() - interval '31 days' WHERE id = ?`, [A.w]);
  const out = await purgeExpired(db); assert.equal(out.workspaces_purged, 1);
  // every workspace-scoped table is empty for it, except the billing records kept for 5 years
  const cols = await db.all(`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'workspace_id'`);
  // free_credit_claims (pricing v3 T2, D7): the Free-100 claim outlives the workspace on purpose (부정이용 방지 — no second grant after re-signup)
  const KEEP = new Set(['subscriptions', 'payments', 'billing_events', 'free_credit_claims']);
  for (const { table_name: t } of cols) if (!KEEP.has(t)) assert.equal(await n(db, `SELECT COUNT(*) n FROM ${t} WHERE workspace_id = ?`, [A.w]), 0, t);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM requirements r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = ?', [A.w]), 0);
  assert.equal(await n(db, `SELECT COUNT(*) n FROM payments WHERE id = 'pay1'`), 1);
  const tomb = await db.get('SELECT name, status, purged_at FROM workspaces WHERE id = ?', [A.w]); assert.equal(tomb.status, 'CLOSED'); assert.equal(tomb.name, '삭제된 워크스페이스'); assert.ok(tomb.purged_at);
  assert.equal((await purgeExpired(db)).workspaces_purged, 0);   // idempotent
});

test('login records: purged after 3 months by the cron purge', async () => {
  const { client, db } = await boot();
  const A = await setup(client, 'lr@x.com');
  await login(client, 'lr@x.com');
  await db.run(`UPDATE login_records SET created_at = now() - interval '3 months' - interval '1 day' WHERE method = 'SIGNUP'`);
  const out = await purgeExpired(db); assert.equal(out.login_records, 1);
  assert.equal(await n(db, 'SELECT COUNT(*) n FROM login_records WHERE user_id = ?', [A.uid]), 1);
});
