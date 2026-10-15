/* QA job 1 fixes (2026-10-14): B2 wrong re-auth password is 403 (not 401 → the client would redirect to /login),
 * B8 anonymous session probe without a 401, B10 the client contract behind disabling 결제하기/멤버 초대 for unverified users. */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PAYMENTS_ENABLED ??= 'true';   // v1 ships with payments off (PAYMENTS_ENABLED); this suite exercises checkout
import { boot, setup } from './api-helpers.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';

process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake';
setEmailProvider(fakeEmailProvider());

test('B2: wrong password in 계정 삭제 / Workspace 삭제 → 403 invalid_password with a field error; session stays valid', async () => {
  const { client, server } = await boot();
  const A = await setup(client, 'b2@x.com', '비투');
  let r = await A.c('DELETE', '/api/me', { password: 'wrong1pass' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'invalid_password');
  assert.equal(r.json.error.fields.password, '비밀번호가 올바르지 않습니다.');
  const ws = (await A.c('GET', `/api/workspaces/${A.w}`)).json.workspace;
  r = await A.c('DELETE', `/api/workspaces/${A.w}`, { confirm_name: ws.name, password: 'wrong1pass' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'invalid_password');
  assert.equal((await A.c('GET', '/api/me')).status, 200);   // still logged in
  r = await A.c('DELETE', '/api/me', { password: 'passw0rd!' }); assert.equal(r.status, 200);
  assert.equal((await A.c('GET', '/api/me')).status, 401);
  server.close();
});

test('B8: /api/me?optional=1 → 200 { user: null } when anonymous, the session when logged in; plain /api/me still 401', async () => {
  const { client, server } = await boot();
  const anon = client();
  let r = await anon('GET', '/api/me?optional=1'); assert.equal(r.status, 200); assert.equal(r.json.user, null); assert.deepEqual(r.json.workspaces, []);
  assert.equal((await anon('GET', '/api/me')).status, 401);
  const A = await setup(client, 'b8@x.com', '비에잇');
  r = await A.c('GET', '/api/me?optional=1'); assert.equal(r.status, 200); assert.equal(r.json.user.email, 'b8@x.com'); assert.equal(r.json.workspaces[0].id, A.w);
  server.close();
});

test('B10: unverified owner sees email_verified=false (the UI disables 결제하기/멤버 초대) and the server refuses both with 403', async () => {
  const { client, server, db } = await boot();
  const A = await setup(client, 'b10@x.com', '비텐');
  assert.equal((await A.c('GET', '/api/me')).json.user.email_verified, false);
  let r = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'MONTHLY', users: 1 });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'email_unverified');
  r = await A.c('POST', `/api/workspaces/${A.w}/invitations`, { email: 'friend@x.com', role: 'MEMBER' });
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'email_unverified');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [A.uid]);
  assert.equal((await A.c('GET', '/api/me')).json.user.email_verified, true);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/invitations`, { email: 'friend@x.com', role: 'MEMBER' })).status, 201);
  server.close();
});
