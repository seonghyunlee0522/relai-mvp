/* Auth hardening: password reset, e-mail verification, Postgres-backed rate limits, expired-row purge. Fake e-mail provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { createApp } from '../app.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { purgeExpired } from '../maintenance.js';
import { rateLimiter } from '../security.js';

process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake';
const mail = fakeEmailProvider(); setEmailProvider(mail);
const tokenIn = (kind) => (m) => (m && m.text.match(new RegExp(`https://relai\\.test/${kind}\\?token=([A-Za-z0-9_-]+)`)) || [])[1];
const resetToken = tokenIn('reset-password'); const verifyToken = tokenIn('verify-email');
const mailsTo = (to, type) => mail.find((m) => m.to === to && m.tags[0] === type);

test('password reset: no account-existence leak, hashed single-use 30-min token, sessions revoked, old password dead, newer request invalidates older link', async () => {
  const { server, client, db } = await boot();
  const U = await setup(client, 'reset@x.com');
  const other = client(); await other('POST', '/api/auth/login', { email: 'reset@x.com', password: 'passw0rd!' });
  assert.equal((await other('GET', '/api/me')).status, 200);

  // unknown address: same 200 body, nothing sent
  const before = mail.outbox.length;
  let r = await client()('POST', '/api/auth/password/forgot', { email: 'nobody@x.com' });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true }); assert.equal(mail.outbox.length, before);
  assert.equal((await client()('POST', '/api/auth/password/forgot', { email: 'not-an-email' })).status, 400);

  r = await client()('POST', '/api/auth/password/forgot', { email: 'Reset@X.com' });
  assert.deepEqual(r.json, { ok: true });
  const t1 = resetToken(mailsTo('reset@x.com', 'PASSWORD_RESET').at(-1)); assert.ok(t1);
  const row = await db.get(`SELECT * FROM auth_tokens WHERE purpose = 'PASSWORD_RESET'`);
  assert.notEqual(row.token_hash, t1); assert.ok(!row.token_hash.includes(t1));
  const ttl = (new Date(row.expires_at) - new Date(row.created_at)) / 60e3; assert.ok(ttl > 29 && ttl <= 30.1, `ttl ${ttl}`);
  const del = await db.get(`SELECT * FROM email_deliveries WHERE type = 'PASSWORD_RESET'`); assert.ok(!JSON.stringify(del).includes(t1));

  // a newer request invalidates the older link
  await client()('POST', '/api/auth/password/forgot', { email: 'reset@x.com' });
  const t2 = resetToken(mailsTo('reset@x.com', 'PASSWORD_RESET').at(-1)); assert.notEqual(t2, t1);
  r = await client()('POST', '/api/auth/password/reset', { token: t1, password: 'newpassw0rd' }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'token_invalid');

  // weak password rejected without consuming the token
  r = await client()('POST', '/api/auth/password/reset', { token: t2, password: 'short' }); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'validation');
  r = await client()('POST', '/api/auth/password/reset', { token: t2, password: 'newpassw0rd' }); assert.equal(r.status, 200);
  // single use
  r = await client()('POST', '/api/auth/password/reset', { token: t2, password: 'another1pw' }); assert.equal(r.status, 400);
  // every session revoked, old password dead, new one works
  assert.equal((await U.c('GET', '/api/me')).status, 401); assert.equal((await other('GET', '/api/me')).status, 401);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', [U.uid])).n), 0);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'reset@x.com', password: 'passw0rd!' })).status, 401);
  const c = client(); r = await c('POST', '/api/auth/login', { email: 'reset@x.com', password: 'newpassw0rd' }); assert.equal(r.status, 200);
  assert.equal(r.json.user.email_verified, true);   // the reset link proved the address
  assert.ok(await db.get(`SELECT 1 FROM admin_audit_logs WHERE action = 'PASSWORD_RESET' AND target_id = ?`, [U.uid]));

  // expired link
  await client()('POST', '/api/auth/password/forgot', { email: 'reset@x.com' });
  const t3 = resetToken(mailsTo('reset@x.com', 'PASSWORD_RESET').at(-1));
  await db.run(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE purpose = 'PASSWORD_RESET' AND used_at IS NULL`);
  assert.equal((await client()('POST', '/api/auth/password/reset', { token: t3, password: 'newpassw0rd2' })).status, 400);
  assert.equal((await client()('POST', '/api/auth/password/reset', { token: 'x'.repeat(43), password: 'newpassw0rd2' })).status, 400);

  // suspended account: same answer, no mail
  await db.run(`UPDATE users SET status = 'SUSPENDED' WHERE id = ?`, [U.uid]);
  const n = mail.outbox.length; r = await client()('POST', '/api/auth/password/forgot', { email: 'reset@x.com' });
  assert.deepEqual(r.json, { ok: true }); assert.equal(mail.outbox.length, n);
  server.close();
});

test('password reset for a Google-only account sets a password and adds a PASSWORD identity; per-address limit is silent', async () => {
  const { server, client, db } = await boot();
  const U = await setup(client, 'g@x.com');
  await db.run('UPDATE users SET password_hash = NULL WHERE id = ?', [U.uid]); await db.run(`DELETE FROM user_identities WHERE user_id = ?`, [U.uid]);
  const n0 = mailsTo('g@x.com', 'PASSWORD_RESET').length;
  for (let i = 0; i < 5; i++) assert.deepEqual((await client()('POST', '/api/auth/password/forgot', { email: 'g@x.com' })).json, { ok: true });
  assert.equal(mailsTo('g@x.com', 'PASSWORD_RESET').length - n0, 3);   // 3 per address per hour, then silently nothing
  const t = resetToken(mailsTo('g@x.com', 'PASSWORD_RESET').at(-1));
  assert.equal((await client()('POST', '/api/auth/password/reset', { token: t, password: 'fresh1pass' })).status, 200);
  assert.deepEqual((await db.all('SELECT provider, email_verified FROM user_identities WHERE user_id = ?', [U.uid])).map((i) => [i.provider, i.email_verified]), [['PASSWORD', true]]);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'g@x.com', password: 'fresh1pass' })).status, 200);
  server.close();
});

test('e-mail verification: direct signup is unverified and cannot invite; link verifies (no session needed), single use; resend rotates + is rate-limited; invite signups are verified', async () => {
  const { server, client, db } = await boot();
  const U = await setup(client, 'v@x.com');
  let me = await U.c('GET', '/api/me'); assert.equal(me.json.user.email_verified, false);
  const first = verifyToken(mailsTo('v@x.com', 'EMAIL_VERIFY').at(-1)); assert.ok(first);
  let r = await U.c('POST', `/api/workspaces/${U.w}/invitations`, { email: 'friend@x.com', role: 'MEMBER' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'email_unverified');
  // unverified users still use their own workspace
  assert.equal((await U.c('GET', `/api/workspaces/${U.w}/projects`)).status, 200);

  // resend rotates the token (old link dies) and is limited to 3/hour
  r = await U.c('POST', '/api/auth/email/resend', {}); assert.equal(r.status, 200);
  const second = verifyToken(mailsTo('v@x.com', 'EMAIL_VERIFY').at(-1)); assert.notEqual(second, first);
  assert.equal((await client()('POST', '/api/auth/email/verify', { token: first })).status, 400);
  await U.c('POST', '/api/auth/email/resend', {}); await U.c('POST', '/api/auth/email/resend', {});
  r = await U.c('POST', '/api/auth/email/resend', {}); assert.equal(r.status, 429);
  const latest = verifyToken(mailsTo('v@x.com', 'EMAIL_VERIFY').at(-1));
  assert.equal((await client()('POST', '/api/auth/email/resend', {})).status, 401);

  // verify from a browser without a session
  r = await client()('POST', '/api/auth/email/verify', { token: latest }); assert.equal(r.status, 200); assert.equal(r.json.email_verified, true);
  assert.equal((await client()('POST', '/api/auth/email/verify', { token: latest })).status, 400);
  me = await U.c('GET', '/api/me'); assert.equal(me.json.user.email_verified, true);
  assert.equal((await db.get(`SELECT email_verified FROM user_identities WHERE user_id = ? AND provider = 'PASSWORD'`, [U.uid])).email_verified, true);
  assert.deepEqual((await U.c('POST', '/api/auth/email/resend', {})).json, { ok: true, already_verified: true });
  r = await U.c('POST', `/api/workspaces/${U.w}/invitations`, { email: 'friend@x.com', role: 'MEMBER' }); assert.equal(r.status, 201);

  // invitation signup: verified at creation, no verification mail
  const inviteT = (mail.last().text.match(/https:\/\/relai\.test\/invite\/([A-Za-z0-9_-]+)/) || [])[1];
  const f = client(); r = await f('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '친구', email: 'friend@x.com', password: 'passw0rd!', invite_token: inviteT });
  assert.equal(r.status, 201); assert.equal(r.json.user.email_verified, true); assert.equal(mailsTo('friend@x.com', 'EMAIL_VERIFY').length, 0);
  server.close();
});

test('rate limits live in Postgres: a second app instance on the same database sees the same login counter; keys are hashed', async () => {
  const { server, client, db } = await boot();
  await setup(client, 'rl@x.com');
  const other = createApp(db).listen(0);
  const viaB = (body) => fetch(`http://127.0.0.1:${other.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (let i = 0; i < 8; i++) assert.equal((await client()('POST', '/api/auth/login', { email: 'rl@x.com', password: 'wrong1pass' })).status, 401);
  assert.equal((await viaB({ email: 'rl@x.com', password: 'passw0rd!' })).status, 429);   // instance B is blocked by A's failures
  const rows = await db.all('SELECT key FROM rate_limits'); assert.ok(rows.length > 0);
  assert.ok(rows.every((x) => /^[0-9a-f]{64}$/.test(x.key) && !x.key.includes('rl@x.com')));
  other.close();

  // window expiry: a fresh window starts once reset_at has passed
  const lim = rateLimiter(db, { name: 'unit', max: 2, windowMs: 60_000 });
  await lim.hit('k'); await lim.hit('k'); assert.equal(await lim.blocked('k'), true);
  await db.run(`UPDATE rate_limits SET reset_at = now() - interval '1 second'`);
  assert.equal(await lim.blocked('k'), false); await lim.hit('k'); assert.equal(await lim.blocked('k'), false);
  await lim.reset('k'); assert.equal(await lim.blocked('k'), false);
  server.close();
});

test('purge: expired sessions / old tokens / ended rate windows are deleted; cron route needs CRON_SECRET', async () => {
  const { server, client, db } = await boot();
  const U = await setup(client, 'p@x.com');
  await db.run(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('old-session', ?, now() - interval '1 hour')`, [U.uid]);
  await db.run(`INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email, expires_at) VALUES ('t-old', ?, 'PASSWORD_RESET', 'h-old', 'p@x.com', now() - interval '2 days')`, [U.uid]);
  await db.run(`INSERT INTO rate_limits (key, count, reset_at) VALUES ('rk-old', 3, now() - interval '1 minute')`);
  const base = `http://127.0.0.1:${server.address().port}/api/cron/purge`;
  const prev = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET; assert.equal((await fetch(base)).status, 404);
    process.env.CRON_SECRET = 'cron-test-secret';
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const r = await fetch(base, { headers: { Authorization: 'Bearer cron-test-secret' } }); assert.equal(r.status, 200);
    const j = await r.json(); assert.equal(j.purged.sessions, 1); assert.equal(j.purged.auth_tokens, 1); assert.ok(j.purged.rate_limits >= 1);
  } finally { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; }
  assert.equal((await U.c('GET', '/api/me')).status, 200);   // live session untouched
  assert.ok(!(await db.get(`SELECT 1 FROM sessions WHERE token_hash = 'old-session'`)));
  assert.deepEqual(await purgeExpired(db), { sessions: 0, auth_tokens: 0, rate_limits: 0, oauth_states: 0, login_records: 0, workspaces_purged: 0,
    withdrawals: 0, complaints: 0, withdrawn_orders: 0, service_orders: 0, workspace_payments: 0 });   // mig 56 retention classes
  server.close();
});
