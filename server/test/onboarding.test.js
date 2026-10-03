/* Phase 13 — identity, invitations, Google sign-in, e-mail, admin. Fake Google + fake e-mail providers (no network). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { setGoogleProvider, fakeGoogleProvider } from '../auth/google.js';

process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake'; process.env.GOOGLE_PROVIDER = 'fake'; process.env.INVITE_EXPIRY_DAYS = '7';
const mail = fakeEmailProvider(); setEmailProvider(mail);
const google = fakeGoogleProvider(); setGoogleProvider(google);

const linkOf = (msg) => (msg.text.match(/https:\/\/relai\.test\/invite\/([A-Za-z0-9_-]+)/) || [])[1];
const lastToken = () => linkOf(mail.last());
async function admin(client, db, email = 'root@relai.test') { const c = client(); const s = await c('POST', '/api/auth/signup', { name: '운영자', email, password: 'passw0rd!' }); await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]); return { c, uid: s.json.user.id }; }
const signup = async (client, { name, email, invite_token }) => { const c = client(); const r = await c('POST', '/api/auth/signup', { name, email, password: 'passw0rd!', invite_token }); return { c, r }; };
const login = async (client, email) => { const c = client(); const r = await c('POST', '/api/auth/login', { email, password: 'passw0rd!' }); return { c, r }; };
/** Runs the Google round trip for a client: start (intent/invite) → fake code → callback. Returns the callback response + Location. */
async function googleLogin(c, claims, { intent = 'login', invite = null, nonceOverride = null, rawIdToken = null, stateOverride = null } = {}) {
  const start = await c('GET', `/api/auth/google/start?intent=${intent}${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`);
  const url = new URL(start.headers?.location || start.location || '', 'http://localhost');
  const state = stateOverride ?? url.searchParams.get('state'); const nonce = nonceOverride ?? url.searchParams.get('nonce');
  const code = google.issueCode({ ...claims, nonce, rawIdToken });
  const cb = await c('GET', `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  return { status: cb.status, location: cb.headers?.location || cb.location || '' };
}

test('existing auth: password login/session/direct signup personal workspace/system admin/suspended login blocked; PASSWORD identity present', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  const me = await A.c('GET', '/api/me'); assert.equal(me.status, 200); assert.equal(me.json.workspaces.length, 1); assert.match(me.json.workspaces[0].name, /님의 Workspace/);
  const ids = await db.all('SELECT provider, provider_subject, email FROM user_identities WHERE user_id = ?', [A.uid]); assert.deepEqual(ids, [{ provider: 'PASSWORD', provider_subject: A.uid, email: 'u@x.com' }]);
  const { r } = await login(client, 'u@x.com'); assert.equal(r.status, 200);
  const ad = await admin(client, db); assert.equal((await ad.c('GET', '/api/admin/users')).status, 200);
  await db.run(`UPDATE users SET status = 'SUSPENDED' WHERE id = ?`, [A.uid]);
  assert.equal((await login(client, 'u@x.com')).r.status, 403);
  // a Google-only account cannot be brute forced through the password form
  const r2 = await googleLogin(client(), { sub: 'g-1', email: 'gonly@x.com' }); assert.equal(r2.status, 302);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'gonly@x.com', password: 'anything1' })).status, 401);
  server.close();
});

test('platform invitation: admin only, unknown/existing e-mail, duplicate pending, resend rotates token, old token invalid, revoke, expiry, accept flows (new signup / existing login), no personal workspace, AI account, double accept, wrong e-mail', async () => {
  const { server, client, db } = await boot();
  const ad = await admin(client, db); const U = await setup(client, 'normal@x.com');
  assert.equal((await U.c('POST', '/api/admin/invitations', { email: 'pm@acme.co.kr', workspace_name: 'ACME' })).status, 403);
  let r = await ad.c('POST', '/api/admin/invitations', { email: 'bad-email', workspace_name: 'ACME' }); assert.equal(r.status, 400);
  r = await ad.c('POST', '/api/admin/invitations', { email: 'PM@acme.co.kr', workspace_name: 'ACME', invitee_name: '김PM' }); assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = r.json.invitation; assert.equal(inv.status, 'PENDING'); assert.equal(inv.email, 'pm@acme.co.kr'); assert.equal(inv.type, 'WORKSPACE_CREATE'); assert.equal(r.json.email_delivery.status, 'SENT');
  assert.ok(!('token_hash' in inv) && !JSON.stringify(r.json).includes('token'), 'no token in API response');
  const m1 = mail.last(); assert.equal(m1.to, 'pm@acme.co.kr'); assert.match(m1.subject, /ACME/); const t1 = linkOf(m1); assert.ok(t1);
  // raw token never in DB
  const rows = await db.all('SELECT token_hash FROM invitations'); assert.ok(rows.every((x) => x.token_hash !== t1 && !x.token_hash.includes(t1)));
  // duplicate pending
  r = await ad.c('POST', '/api/admin/invitations', { email: 'pm@acme.co.kr', workspace_name: 'ACME2' }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'invite_pending');
  // existing RELAI e-mail can be invited (they will log in to accept)
  r = await ad.c('POST', '/api/admin/invitations', { email: 'normal@x.com', workspace_name: 'Normal Corp' }); assert.equal(r.status, 201);
  // public landing (no session): masked e-mail, type, workspace
  const pub = await client()('GET', `/api/invitations/${t1}`); assert.equal(pub.status, 200); assert.equal(pub.json.invitation.email_masked, 'p***@acme.co.kr'); assert.equal(pub.json.invitation.workspace_name, 'ACME'); assert.equal(pub.json.invitation.me.logged_in, false); assert.ok(!JSON.stringify(pub.json).includes('pm@acme.co.kr'));
  assert.equal((await client()('GET', '/api/invitations/nope')).status, 404);
  // resend rotates: old link dead, new one works
  r = await ad.c('POST', `/api/admin/invitations/${inv.id}/resend`, {}); assert.equal(r.status, 200); const t2 = lastToken(); assert.notEqual(t2, t1);
  assert.equal((await client()('GET', `/api/invitations/${t1}`)).status, 404); assert.equal((await client()('GET', `/api/invitations/${t2}`)).status, 200);
  // wrong e-mail cannot accept (existing user normal@x.com)
  r = await U.c('POST', `/api/invitations/${t2}/accept`, {}); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'invite_email_mismatch');
  // signup through the link with the wrong e-mail → blocked; right e-mail → user + ACME workspace as OWNER, no personal workspace
  r = (await signup(client, { name: '김PM', email: 'other@acme.co.kr', invite_token: t2 })).r; assert.equal(r.status, 403);
  assert.equal(await db.get(`SELECT COUNT(*) n FROM users WHERE email = 'other@acme.co.kr'`).then((x) => Number(x.n)), 0);
  const { c: pm, r: sr } = await signup(client, { name: '김PM', email: 'pm@acme.co.kr', invite_token: t2 }); assert.equal(sr.status, 201, JSON.stringify(sr.json));
  assert.equal(sr.json.workspaces.length, 1); assert.equal(sr.json.workspaces[0].name, 'ACME'); assert.equal(sr.json.workspaces[0].role, 'OWNER'); assert.equal(sr.json.accepted.type, 'WORKSPACE_CREATE');
  assert.equal(await db.get(`SELECT COUNT(*) n FROM workspaces WHERE name LIKE '%님의 Workspace' AND owner_id = ?`, [sr.json.user.id]).then((x) => Number(x.n)), 0);
  assert.ok(await db.get('SELECT 1 FROM workspace_credit_accounts WHERE workspace_id = ?', [sr.json.workspaces[0].id]), 'AI account initialized');
  const after = await ad.c('GET', `/api/admin/invitations?status=ACCEPTED`); assert.ok(after.json.items.some((x) => x.id === inv.id && x.status === 'ACCEPTED' && x.accepted_by_name === '김PM'));
  // double accept / replay
  r = await pm('POST', `/api/invitations/${t2}/accept`, {}); assert.equal(r.status, 409);
  // existing user: login + explicit accept → workspace created, personal workspace kept
  const t3 = (() => { const m = mail.find((x) => x.to === 'normal@x.com').pop(); return linkOf(m); })();
  r = await U.c('GET', `/api/invitations/${t3}`); assert.equal(r.json.invitation.me.email_matches, true);
  r = await U.c('POST', `/api/invitations/${t3}/accept`, {}); assert.equal(r.status, 200); assert.equal(r.json.type, 'WORKSPACE_CREATE');
  const wsU = (await U.c('GET', '/api/me')).json.workspaces; assert.equal(wsU.length, 2); assert.ok(wsU.some((w) => w.name === 'Normal Corp' && w.role === 'OWNER')); assert.ok(wsU.some((w) => /님의 Workspace/.test(w.name)));
  // revoke + expired
  r = await ad.c('POST', '/api/admin/invitations', { email: 'rev@acme.co.kr', workspace_name: 'Rev' }); const revT = lastToken();
  r = await ad.c('POST', `/api/admin/invitations/${r.json.invitation.id}/revoke`, {}); assert.equal(r.json.invitation.status, 'REVOKED');
  assert.equal((await client()('GET', `/api/invitations/${revT}`)).json.invitation.status, 'REVOKED');
  r = (await signup(client, { name: 'x', email: 'rev@acme.co.kr', invite_token: revT })).r; assert.equal(r.status, 410);
  r = await ad.c('POST', '/api/admin/invitations', { email: 'exp@acme.co.kr', workspace_name: 'Exp' }); const expId = r.json.invitation.id; const expT = lastToken();
  await db.run(`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = ?`, [expId]);
  r = await client()('GET', `/api/invitations/${expT}`); assert.equal(r.json.invitation.status, 'EXPIRED');
  r = (await signup(client, { name: 'x', email: 'exp@acme.co.kr', invite_token: expT })).r; assert.equal(r.status, 410);
  r = await ad.c('POST', `/api/admin/invitations/${expId}/resend`, {}); assert.equal(r.status, 200); assert.equal(r.json.invitation.status, 'PENDING');   // resend revives with a fresh expiry
  // atomic: a workspace creation failure (bad name) leaves the invitation PENDING
  r = await ad.c('POST', '/api/admin/invitations', { email: 'atomic@acme.co.kr', workspace_name: 'Atomic' }); const atId = r.json.invitation.id; const atT = lastToken();
  await db.run(`ALTER TABLE workspaces ADD CONSTRAINT t_no_atomic CHECK (name <> 'Atomic')`);   // forces the workspace INSERT to fail after the user/invite steps
  r = (await signup(client, { name: 'x', email: 'atomic@acme.co.kr', invite_token: atT })).r; assert.equal(r.status, 400);
  assert.equal((await db.get('SELECT status FROM invitations WHERE id = ?', [atId])).status, 'PENDING');
  assert.equal(await db.get(`SELECT COUNT(*) n FROM users WHERE email = 'atomic@acme.co.kr'`).then((x) => Number(x.n)), 0);   // user creation rolled back with it
  await db.run('ALTER TABLE workspaces DROP CONSTRAINT t_no_atomic');
  r = (await signup(client, { name: 'x', email: 'atomic@acme.co.kr', invite_token: atT })).r; assert.equal(r.status, 201);   // same link works once the cause is gone
  server.close();
});

test('member invitation: OWNER→MEMBER/ADMIN, ADMIN→MEMBER only, MEMBER forbidden, existing member, duplicate, accept new/existing user, wrong e-mail, no new workspace, role exact, suspended workspace, double accept, isolation', async () => {
  const { server, client, db } = await boot();
  const O = await setup(client, 'owner@acme.co.kr', '홍길동'); const AD = await addMember(client, O, 'admin@acme.co.kr', '관리자', 'ADMIN'); const M = await addMember(client, O, 'member@acme.co.kr', '멤버', 'MEMBER');
  const W = `/api/workspaces/${O.w}/invitations`;
  assert.equal((await M.c('POST', W, { email: 'x@y.com', role: 'MEMBER' })).status, 403);
  let r = await AD.c('POST', W, { email: 'a1@acme.co.kr', role: 'ADMIN' }); assert.equal(r.status, 403);
  r = await AD.c('POST', W, { email: 'a1@acme.co.kr', role: 'MEMBER' }); assert.equal(r.status, 201); assert.equal(r.json.invitation.invited_by_name, '관리자');
  r = await O.c('POST', W, { email: 'dev@acme.co.kr', role: 'ADMIN' }); assert.equal(r.status, 201, JSON.stringify(r.json)); const devInv = r.json.invitation; assert.equal(devInv.role, 'ADMIN');
  const devMail = mail.last(); assert.equal(devMail.to, 'dev@acme.co.kr'); assert.match(devMail.subject, /Workspace에 초대되었습니다/); assert.match(devMail.text, /홍길동/); assert.match(devMail.text, /Admin/); const devT = linkOf(devMail);
  assert.equal((await O.c('POST', W, { email: 'member@acme.co.kr', role: 'MEMBER' })).json.error.code, 'already_member');
  assert.equal((await O.c('POST', W, { email: 'dev@acme.co.kr', role: 'MEMBER' })).json.error.code, 'invite_pending');
  assert.equal((await O.c('POST', W, { email: 'dev2@acme.co.kr', role: 'OWNER' })).status, 400);
  r = await O.c('GET', W); assert.equal(r.json.invitations.length, 2);
  // landing shows inviter + role, no workspace creation on accept; new user via signup → MEMBER/ADMIN of ACME only
  r = await client()('GET', `/api/invitations/${devT}`); assert.equal(r.json.invitation.type, 'WORKSPACE_MEMBER'); assert.equal(r.json.invitation.inviter_name, '홍길동'); assert.equal(r.json.invitation.role_label, 'Admin'); assert.match(r.json.invitation.workspace_name, /님의 Workspace/);
  const before = Number((await db.get('SELECT COUNT(*) n FROM workspaces')).n);
  const { r: sr } = await signup(client, { name: '개발자', email: 'dev@acme.co.kr', invite_token: devT }); assert.equal(sr.status, 201, JSON.stringify(sr.json));
  assert.equal(sr.json.workspaces.length, 1); assert.equal(sr.json.workspaces[0].id, O.w); assert.equal(sr.json.workspaces[0].role, 'ADMIN');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM workspaces')).n), before);
  // existing user with its own workspace: login + accept → membership added, own workspace kept; wrong e-mail blocked
  const X = await setup(client, 'exist@other.com', '기존');
  r = await O.c('POST', W, { email: 'exist@other.com', role: 'MEMBER' }); const exT = lastToken();
  assert.equal((await M.c('POST', `/api/invitations/${exT}/accept`, {})).status, 403);
  r = await X.c('POST', `/api/invitations/${exT}/accept`, {}); assert.equal(r.status, 200); assert.equal(r.json.workspace_id, O.w);
  const xw = (await X.c('GET', '/api/me')).json.workspaces; assert.equal(xw.length, 2); assert.equal(xw.find((w) => w.id === O.w).role, 'MEMBER');
  assert.equal((await X.c('POST', `/api/invitations/${exT}/accept`, {})).status, 409);
  // other workspace cannot see/revoke these invitations
  const B = await setup(client, 'b@other.com');
  assert.equal((await B.c('GET', W)).status, 404); assert.equal((await B.c('DELETE', `/api/workspaces/${B.w}/invitations/${devInv.id}`)).status, 404);
  // suspended workspace: create / resend / accept blocked
  r = await O.c('POST', W, { email: 'late@acme.co.kr', role: 'MEMBER' }); const lateId = r.json.invitation.id; const lateT = lastToken();
  await db.run(`UPDATE workspaces SET status = 'SUSPENDED' WHERE id = ?`, [O.w]);
  assert.equal((await O.c('POST', W, { email: 'z@acme.co.kr', role: 'MEMBER' })).status, 403);
  const L = await signup(client, { name: '늦은', email: 'late@acme.co.kr' }); assert.equal((await L.c('POST', `/api/invitations/${lateT}/accept`, {})).status, 403);
  await db.run(`UPDATE workspaces SET status = 'ACTIVE' WHERE id = ?`, [O.w]);
  assert.equal((await O.c('POST', `${W}/${lateId}/resend`, {})).status, 200);
  // revoke
  r = await O.c('DELETE', `${W}/${lateId}`); assert.equal(r.json.invitation.status, 'REVOKED');
  server.close();
});

test('concurrent accept: one membership, one ACCEPTED; concurrent platform accept: one workspace', async () => {
  const { server, client, db } = await boot();
  const O = await setup(client, 'o@acme.co.kr'); const ad = await admin(client, db);
  await O.c('POST', `/api/workspaces/${O.w}/invitations`, { email: 'c@acme.co.kr', role: 'MEMBER' }); const t = lastToken();
  const C = await signup(client, { name: 'c', email: 'c@acme.co.kr' });
  const rs = await Promise.all([1, 2, 3, 4].map(() => C.c('POST', `/api/invitations/${t}/accept`, {})));
  assert.equal(rs.filter((x) => x.status === 200).length, 1); assert.equal(rs.filter((x) => x.status === 409).length, 3);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [O.w, C.r.json.user.id])).n), 1);
  await ad.c('POST', '/api/admin/invitations', { email: 'c@acme.co.kr', workspace_name: 'CC' }); const t2 = lastToken();
  const rs2 = await Promise.all([1, 2, 3].map(() => C.c('POST', `/api/invitations/${t2}/accept`, {})));
  assert.equal(rs2.filter((x) => x.status === 200).length, 1); assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM workspaces WHERE name = 'CC'`)).n), 1);
  server.close();
});

test('google: new signup (personal workspace), same verified e-mail links to password user, repeat login same user, different e-mail no merge, suspended blocked, unverified blocked, invite accept (platform + member), invite e-mail mismatch, invalid/expired state, bad nonce, bad id token, start rate limit', async () => {
  const { server, client, db } = await boot();
  // 37. new Google user → direct signup with personal workspace, email_verified_at set
  let r = await googleLogin(client(), { sub: 'g-100', email: 'new@corp.com', name: '구글' }); assert.equal(r.status, 302); assert.equal(r.location, '/app');
  const nu = await db.get(`SELECT id, password_hash, email_verified_at FROM users WHERE email = 'new@corp.com'`); assert.equal(nu.password_hash, null); assert.ok(nu.email_verified_at);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM workspace_members WHERE user_id = ?', [nu.id])).n), 1);
  assert.deepEqual((await db.all('SELECT provider, provider_subject FROM user_identities WHERE user_id = ?', [nu.id])), [{ provider: 'GOOGLE', provider_subject: 'g-100' }]);
  // 38. existing password user + same verified e-mail → same user, GOOGLE identity linked
  const P = await setup(client, 'pw@corp.com', '비번');
  const gc = client(); r = await googleLogin(gc, { sub: 'g-200', email: 'PW@corp.com' }); assert.equal(r.status, 302);
  const me = await gc('GET', '/api/me'); assert.equal(me.json.user.id, P.uid);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM users WHERE email = 'pw@corp.com'`)).n), 1);
  assert.deepEqual((await db.all('SELECT provider FROM user_identities WHERE user_id = ? ORDER BY provider', [P.uid])).map((x) => x.provider), ['GOOGLE', 'PASSWORD']);
  // 39. repeat → same user (by sub even if the e-mail changed)
  const gc2 = client(); r = await googleLogin(gc2, { sub: 'g-200', email: 'renamed@corp.com' }); assert.equal((await gc2('GET', '/api/me')).json.user.id, P.uid);
  // 40. different e-mail → separate user (no merge)
  r = await googleLogin(client(), { sub: 'g-300', email: 'pw2@corp.com' }); assert.notEqual((await db.get(`SELECT id FROM users WHERE email = 'pw2@corp.com'`)).id, P.uid);
  // unverified e-mail: never links, never creates
  r = await googleLogin(client(), { sub: 'g-400', email: 'pw@corp.com', email_verified: false }); assert.match(r.location, /error=google_email_unverified/);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM user_identities WHERE provider_subject = 'g-400'`)).n), 0);
  // 41. suspended → blocked
  await db.run(`UPDATE users SET status = 'SUSPENDED' WHERE id = ?`, [P.uid]);
  r = await googleLogin(client(), { sub: 'g-200', email: 'pw@corp.com' }); assert.match(r.location, /suspended=1/);
  await db.run(`UPDATE users SET status = 'ACTIVE' WHERE id = ?`, [P.uid]);
  // 42. platform invite via Google: user created WITHOUT personal workspace; landing → explicit accept
  const ad = await admin(client, db);
  await ad.c('POST', '/api/admin/invitations', { email: 'ceo@startup.io', workspace_name: 'Startup' }); const t = lastToken();
  const ic = client(); r = await googleLogin(ic, { sub: 'g-500', email: 'ceo@startup.io', name: '대표' }, { invite: t }); assert.equal(r.status, 302); assert.equal(r.location, `/invite/${t}`);
  const ceo = await db.get(`SELECT id FROM users WHERE email = 'ceo@startup.io'`); assert.equal(Number((await db.get('SELECT COUNT(*) n FROM workspace_members WHERE user_id = ?', [ceo.id])).n), 0);
  r = await ic('GET', `/api/invitations/${t}`); assert.equal(r.json.invitation.me.email_matches, true);
  r = await ic('POST', `/api/invitations/${t}/accept`, {}); assert.equal(r.status, 200); const ws = (await ic('GET', '/api/me')).json.workspaces; assert.equal(ws.length, 1); assert.equal(ws[0].name, 'Startup'); assert.equal(ws[0].role, 'OWNER');
  // 43. member invite via Google (new user) → membership only
  const O = await setup(client, 'o@startup.io'); await O.c('POST', `/api/workspaces/${O.w}/invitations`, { email: 'eng@startup.io', role: 'MEMBER' }); const mt = lastToken();
  const ec = client(); r = await googleLogin(ec, { sub: 'g-600', email: 'eng@startup.io' }, { invite: mt }); r = await ec('POST', `/api/invitations/${mt}/accept`, {}); assert.equal(r.status, 200);
  const ews = (await ec('GET', '/api/me')).json.workspaces; assert.equal(ews.length, 1); assert.equal(ews[0].id, O.w); assert.equal(ews[0].role, 'MEMBER');
  // 44. invite e-mail mismatch: Google account differs → accept blocked with masked hint
  await O.c('POST', `/api/workspaces/${O.w}/invitations`, { email: 'kim@abc.co.kr', role: 'MEMBER' }); const kt = lastToken();
  const kc = client(); await googleLogin(kc, { sub: 'g-700', email: 'kim@gmail.com' }, { invite: kt });
  r = await kc('POST', `/api/invitations/${kt}/accept`, {}); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'invite_email_mismatch'); assert.equal(r.json.error.email_masked, 'ki***@abc.co.kr');
  // 45/46/47/48. invalid state, expired state, wrong nonce, invalid token, state replay
  r = await googleLogin(client(), { sub: 'g-800', email: 'z@corp.com' }, { stateOverride: 'bogus' }); assert.match(r.location, /error=oauth_state_invalid/);
  const sc = client(); const st = await sc('GET', '/api/auth/google/start?intent=login'); const su = new URL(st.headers?.location || st.location, 'http://localhost');
  await db.run(`UPDATE auth_oauth_states SET expires_at = now() - interval '1 minute'`);
  let code = google.issueCode({ sub: 'g-801', email: 'z@corp.com', nonce: su.searchParams.get('nonce') });
  r = await sc('GET', `/api/auth/google/callback?code=${code}&state=${encodeURIComponent(su.searchParams.get('state'))}`); assert.match(r.headers?.location || r.location, /error=oauth_state_expired/);
  r = await googleLogin(client(), { sub: 'g-802', email: 'z@corp.com' }, { nonceOverride: 'wrong-nonce' }); assert.match(r.location, /error=google_nonce_mismatch/);
  r = await googleLogin(client(), { sub: 'g-803', email: 'z@corp.com' }, { rawIdToken: 'not-a-token' }); assert.match(r.location, /error=google_id_token_invalid|google_nonce_mismatch/);
  r = await googleLogin(client(), { sub: 'g-804', email: 'z@corp.com', aud: 'other-client' }); assert.match(r.location, /error=google_id_token_invalid/);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM users WHERE email = 'z@corp.com'`)).n), 0);
  // state single use: replaying the callback fails
  const rc = client(); const st2 = await rc('GET', '/api/auth/google/start?intent=login'); const u2 = new URL(st2.headers?.location || st2.location, 'http://localhost');
  code = google.issueCode({ sub: 'g-805', email: 'y@corp.com', nonce: u2.searchParams.get('nonce') });
  r = await rc('GET', `/api/auth/google/callback?code=${code}&state=${encodeURIComponent(u2.searchParams.get('state'))}`); assert.equal(r.headers?.location || r.location, '/app');
  code = google.issueCode({ sub: 'g-805', email: 'y@corp.com', nonce: u2.searchParams.get('nonce') });
  r = await rc('GET', `/api/auth/google/callback?code=${code}&state=${encodeURIComponent(u2.searchParams.get('state'))}`); assert.match(r.headers?.location || r.location, /oauth_state_invalid/);
  // start rate limit (20 / 10 min per IP)
  const lc = client(); let last; for (let i = 0; i < 25; i++) last = await lc('GET', '/api/auth/google/start?intent=login'); assert.equal(last.status, 429);
  server.close();
});

test('e-mail: fake provider, platform + member mails, failed delivery keeps the invitation and allows resend, deliveries never store HTML/tokens, links use APP_BASE_URL not Host', async () => {
  const { server, client, db } = await boot();
  const ad = await admin(client, db);
  mail.failNext = { code: 'http_500', message: 'provider down', retryable: true };
  let r = await ad.c('POST', '/api/admin/invitations', { email: 'fail@acme.co.kr', workspace_name: 'Fail Co' }); assert.equal(r.status, 201); assert.equal(r.json.email_delivery.status, 'FAILED'); assert.equal(r.json.invitation.last_email_status, 'FAILED');
  const inv = r.json.invitation;
  r = await ad.c('POST', `/api/admin/invitations/${inv.id}/resend`, {}); assert.equal(r.json.email_delivery.status, 'SENT'); assert.equal(r.json.invitation.last_email_status, 'SENT');
  const d = await db.all('SELECT * FROM email_deliveries WHERE invitation_id = ? ORDER BY created_at', [inv.id]); assert.deepEqual(d.map((x) => x.status), ['FAILED', 'SENT']); assert.equal(d[0].error_code, 'http_500');
  const cols = Object.keys(d[0]); assert.ok(!cols.some((c) => /html|token|body/.test(c)));
  const token = lastToken(); assert.ok(!JSON.stringify(d).includes(token));
  // host header does not influence links
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/admin/invitations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example', cookie: '' }, body: '{}' }); assert.equal(res.status, 401);
  assert.ok(mail.outbox.every((m) => m.text.includes('https://relai.test/invite/') && !m.text.includes('127.0.0.1') && !m.text.includes('evil.example')));
  const list = await ad.c('GET', '/api/admin/email-deliveries?status=FAILED'); assert.equal(list.status, 200); assert.ok(list.json.items.some((x) => x.invitation_id === inv.id));
  server.close();
});

test('admin: users list with login methods + filter, user detail identities (no subjects/hashes), workspace list pending invites, invitations list/filters, secrets never exposed', async () => {
  const { server, client, db } = await boot();
  const ad = await admin(client, db); const P = await setup(client, 'pw@corp.com', '비번');
  await googleLogin(client(), { sub: 'g-900', email: 'pw@corp.com' }); await googleLogin(client(), { sub: 'g-901', email: 'g@corp.com' });
  let r = await ad.c('GET', '/api/admin/users'); const byEmail = Object.fromEntries(r.json.items.map((u) => [u.email, u]));
  assert.equal(byEmail['pw@corp.com'].login_method_label, 'Password + Google'); assert.equal(byEmail['g@corp.com'].login_method_label, 'Google'); assert.equal(byEmail['root@relai.test'].login_method_label, 'Password');
  r = await ad.c('GET', '/api/admin/users?login_method=GOOGLE'); assert.deepEqual(r.json.items.map((u) => u.email).sort(), ['g@corp.com', 'pw@corp.com']);
  r = await ad.c('GET', `/api/admin/users/${P.uid}`); assert.deepEqual(r.json.identities.map((i) => i.provider), ['PASSWORD', 'GOOGLE']); assert.equal(r.json.user.email_verified, true);
  const txt = JSON.stringify(r.json); assert.ok(!/password_hash|provider_subject|g-900|scrypt|token_hash/.test(txt), txt.slice(0, 300));
  await ad.c('POST', '/api/admin/invitations', { email: 'cust@corp.com', workspace_name: 'Cust' });
  await P.c('POST', `/api/workspaces/${P.w}/invitations`, { email: 'tm@corp.com', role: 'MEMBER' });
  r = await ad.c('GET', '/api/admin/workspaces'); assert.equal(Number(r.json.items.find((w) => w.id === P.w).pending_invitations), 1);
  r = await ad.c('GET', `/api/admin/workspaces/${P.w}`); assert.equal(r.json.invitations.length, 1); assert.equal(r.json.invitations[0].email, 'tm@corp.com');
  r = await ad.c('GET', '/api/admin/invitations'); assert.equal(r.json.items.length, 2);
  r = await ad.c('GET', '/api/admin/invitations?type=WORKSPACE_CREATE'); assert.equal(r.json.items.length, 1); assert.equal(r.json.items[0].email, 'cust@corp.com');
  r = await ad.c('GET', '/api/admin/invitations?type=WORKSPACE_MEMBER'); assert.equal(r.json.items.length, 1); assert.equal(r.json.items[0].target_workspace_name, P.w ? r.json.items[0].target_workspace_name : '');
  r = await ad.c('GET', '/api/admin/invitations?status=PENDING'); assert.equal(r.json.items.length, 2);
  assert.ok(!JSON.stringify(r.json).includes('token'));
  // admin cannot resend/revoke a member invitation (workspace owners manage those)
  const mid = r.json.items.find((x) => x.type === 'WORKSPACE_MEMBER').id; assert.equal((await ad.c('POST', `/api/admin/invitations/${mid}/revoke`, {})).status, 403);
  // ordinary user cannot reach admin lists
  assert.equal((await P.c('GET', '/api/admin/invitations')).status, 403); assert.equal((await P.c('GET', '/api/admin/email-deliveries')).status, 403);
  server.close();
});
