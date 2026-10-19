/* ADMIN_EMAILS bootstrap: a listed e-mail becomes SYSTEM_ADMIN on login / session load; unset env changes nothing; never demotes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { parseAdminEmails, bootstrapSystemAdmin, listAudit } from '../admin.js';

const signup = async (client, email) => {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '사용자', email, password: 'passw0rd!' });
  return { c, uid: s.json.user.id, email };
};
const verify = (db, uid) => db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [uid]);
const signupVerified = async (db, client, email) => {
  const u = await signup(client, email); await verify(db, u.uid); return u;
};
const role = async (db, uid) => (await db.get('SELECT system_role FROM users WHERE id = ?', [uid])).system_role;
const withEnv = async (value, fn) => {
  const prev = process.env.ADMIN_EMAILS;
  if (value === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = value;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev; }
};

test('parseAdminEmails: comma-separated, trimmed, lower-cased, blanks dropped', () => {
  assert.deepEqual([...parseAdminEmails(' Founder@Example.com , ,ops@example.com,')], ['founder@example.com', 'ops@example.com']);
  assert.equal(parseAdminEmails('').size, 0);
  assert.equal(parseAdminEmails(undefined).size, 0);
});

test('without ADMIN_EMAILS (missing or empty) nobody is promoted', async () => {
  const { db, server, client } = await boot();
  await withEnv(undefined, async () => {
    const u = await signupVerified(db, client, 'founder@example.com');
    assert.equal((await u.c('POST', '/api/auth/login', { email: u.email, password: 'passw0rd!' })).json.user.system_role, 'NONE');
    assert.equal((await u.c('GET', '/api/admin/dashboard')).status, 403);
    assert.equal(await role(db, u.uid), 'NONE');
  });
  await withEnv('  ', async () => {
    const u = await signupVerified(db, client, 'other@example.com');
    await u.c('POST', '/api/auth/login', { email: u.email, password: 'passw0rd!' });
    assert.equal(await role(db, u.uid), 'NONE');
  });
  assert.equal((await listAudit(db, { action: 'SYSTEM_ADMIN_BOOTSTRAP' })).total, 0);
  server.close();
});

test('listed e-mail is promoted on login (case-insensitive) with one audit row; unlisted users stay NONE', async () => {
  const { db, server, client } = await boot();
  const founder = await withEnv(undefined, () => signupVerified(db, client, 'Founder@Example.com'));
  const other = await withEnv(undefined, () => signupVerified(db, client, 'member@example.com'));
  assert.equal(await role(db, founder.uid), 'NONE');
  await withEnv(' FOUNDER@example.com , ops@example.com', async () => {
    const r = await founder.c('POST', '/api/auth/login', { email: 'founder@example.com', password: 'passw0rd!' });
    assert.equal(r.status, 200); assert.equal(r.json.user.system_role, 'SYSTEM_ADMIN');
    assert.equal(await role(db, founder.uid), 'SYSTEM_ADMIN');
    assert.equal((await founder.c('GET', '/api/admin/dashboard')).status, 200);
    await founder.c('POST', '/api/auth/login', { email: 'founder@example.com', password: 'passw0rd!' });   // second login: no second audit row
    await other.c('POST', '/api/auth/login', { email: other.email, password: 'passw0rd!' });
    assert.equal(await role(db, other.uid), 'NONE');
  });
  const audit = await listAudit(db, { action: 'SYSTEM_ADMIN_BOOTSTRAP' });
  assert.equal(audit.total, 1);
  assert.equal(audit.items[0].target_id, founder.uid); assert.equal(audit.items[0].admin_user_id, founder.uid);
  assert.equal(audit.items[0].metadata.source, 'ADMIN_EMAILS'); assert.match(audit.items[0].summary, /ADMIN_EMAILS/);
  server.close();
});

test('an existing session is promoted on its next request (session load), no re-login needed', async () => {
  const { db, server, client } = await boot();
  const u = await withEnv(undefined, () => signupVerified(db, client, 'founder@example.com'));   // signed up → already logged in
  assert.equal((await u.c('GET', '/api/me')).json.user.system_role, 'NONE');
  await withEnv('founder@example.com', async () => {
    assert.equal((await u.c('GET', '/api/me')).json.user.system_role, 'SYSTEM_ADMIN');
    assert.equal((await u.c('GET', '/api/admin/dashboard')).status, 200);
  });
  assert.equal(await role(db, u.uid), 'SYSTEM_ADMIN');
  server.close();
});

test('unverified e-mail is not promoted until it is verified', async () => {
  const { db, server, client } = await boot();
  const u = await withEnv(undefined, () => signup(client, 'founder@example.com'));
  await withEnv('founder@example.com', async () => {
    assert.equal((await u.c('POST', '/api/auth/login', { email: u.email, password: 'passw0rd!' })).json.user.system_role, 'NONE');
    assert.equal(await role(db, u.uid), 'NONE');
    await verify(db, u.uid);
    assert.equal((await u.c('GET', '/api/me')).json.user.system_role, 'SYSTEM_ADMIN');
  });
  server.close();
});

test('never demotes: an admin not in the list (or with the env removed) keeps SYSTEM_ADMIN', async () => {
  const { db, server, client } = await boot();
  const u = await withEnv(undefined, () => signupVerified(db, client, 'ops@example.com'));
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [u.uid]);
  await withEnv('founder@example.com', async () => {
    assert.equal((await u.c('POST', '/api/auth/login', { email: u.email, password: 'passw0rd!' })).json.user.system_role, 'SYSTEM_ADMIN');
    assert.equal((await u.c('GET', '/api/me')).json.user.system_role, 'SYSTEM_ADMIN');
  });
  await withEnv(undefined, async () => { await u.c('GET', '/api/me'); });
  assert.equal(await role(db, u.uid), 'SYSTEM_ADMIN');
  // direct call on an already-admin user is a no-op
  assert.equal(await bootstrapSystemAdmin(db, { id: u.uid, email: u.email, system_role: 'SYSTEM_ADMIN', email_verified_at: new Date().toISOString() }, 'ops@example.com'), false);
  assert.equal((await listAudit(db, { action: 'SYSTEM_ADMIN_BOOTSTRAP' })).total, 0);
  server.close();
});
