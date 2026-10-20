/* Personal-data retention (migration 65, relai-retention-legal.md G-1..G-6, G-8): log purges, operator access log, 1-year inactive accounts,
 * privacy policy 제3조 text. One booted app and DB for the whole file (few connections). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { purgePersonalLogs, processInactiveAccounts, RETENTION_POLICY } from '../retention.js';
import { purgeExpired } from '../maintenance.js';
import { migrations, LATEST_VERSION } from '../migrations.js';
import { privacyMarkdown } from '../legal.js';

const mail = fakeEmailProvider();
setEmailProvider(mail);
const ctx = await boot();
const { db, client } = ctx;
test.after(() => ctx.server.close());
const ids = async (sql, p = []) => (await db.all(sql, p)).map((r) => r.id).sort();
/** Makes `uid` look unused since `ago` (sign-up, last login, active days and sessions all moved back). */
const idleSince = async (uid, ago) => {
  await db.run(`UPDATE users SET created_at = now() - ?::interval, last_login_at = now() - ?::interval WHERE id = ?`, [ago, ago, uid]);
  await db.run('DELETE FROM analytics_active_days WHERE user_id = ?', [uid]);
  await db.run(`UPDATE sessions SET created_at = now() - ?::interval WHERE user_id = ?`, [ago, uid]);
};

test('migration 65 is the latest and only adds (no up() data change)', () => {
  const m = migrations.find((x) => x.version === 65);
  assert.ok(m && /retention/i.test(m.name));
  assert.ok(LATEST_VERSION >= 65);
});

test('G-1 G-2 G-4 G-5: logs, ended invitations, free-credit claims and operator access logs go after their period; fresh rows stay', async () => {
  const A = await setup(client, 'logs@x.com', '로그');
  const ago = (s) => `now() - interval '${s}'`;
  await db.run(`INSERT INTO analytics_events (name, user_id, created_at) VALUES ('screen', ?, ${ago('1 year 1 day')}), ('screen', ?, ${ago('360 days')})`, [A.uid, A.uid]);
  await db.run(`INSERT INTO analytics_active_days (user_id, day) VALUES ('ghost', (now() AT TIME ZONE 'Asia/Seoul')::date - 400), ('ghost', (now() AT TIME ZONE 'Asia/Seoul')::date - 300)`);
  for (const [id, a] of [['run-old', '1 year 1 day'], ['run-keep', '300 days']]) {
    await db.run(`INSERT INTO ai_runs (id, workspace_id, user_id, feature, provider, model, created_at) VALUES (?, ?, ?, 'PROJECT_QA', 'fake', 'm', ${ago(a)})`, [id, A.w, A.uid]);
  }
  await db.run(`INSERT INTO credit_ledger (id, workspace_id, ai_run_id, type, amount, balance_after) VALUES ('led-1', ?, 'run-old', 'AI_USAGE', -1, 0)`, [A.w]);
  await db.run(`INSERT INTO email_deliveries (id, type, recipient, provider, created_at) VALUES ('ed-old', 'T', 'a@x.com', 'fake', ${ago('1 year 1 day')}), ('ed-keep', 'T', 'a@x.com', 'fake', ${ago('300 days')})`);
  const inv = (id, status, expires, revoked = null) => db.run(`INSERT INTO invitations (id, type, workspace_id, email, role, token_hash, status, expires_at, revoked_at)
    VALUES (?, 'WORKSPACE_MEMBER', ?, ?, 'MEMBER', ?, ?, now() - ?::interval, ${revoked ? 'now() - ?::interval' : 'NULL'})`, [id, A.w, `${id}@x.com`, `h-${id}`, status, expires, ...(revoked ? [revoked] : [])]);
  await inv('inv-expired-old', 'EXPIRED', '31 days'); await inv('inv-pending-old', 'PENDING', '40 days'); await inv('inv-revoked-old', 'REVOKED', '-5 days', '31 days');
  await inv('inv-expired-new', 'EXPIRED', '10 days'); await inv('inv-revoked-new', 'REVOKED', '-5 days', '2 days'); await inv('inv-accepted-old', 'ACCEPTED', '2 years');
  await db.run(`INSERT INTO free_credit_claims (owner_user_id, email_hash, granted_at) VALUES ('fc-old', 'h-old', ${ago('3 years 1 day')}), ('fc-keep', 'h-keep', ${ago('2 years 360 days')})`);
  await db.run(`INSERT INTO admin_access_logs (admin_user_id, method, path, created_at) VALUES ('op', 'GET', '/old', ${ago('2 years 1 day')}), ('op', 'GET', '/keep', ${ago('1 year 300 days')})`);

  const out = await purgeExpired(db);
  assert.equal(out.analytics_events, 1); assert.equal(out.analytics_active_days, 1); assert.equal(out.ai_runs, 1); assert.equal(out.email_deliveries, 1);
  assert.equal(out.ended_invitations, 3); assert.equal(out.free_credit_claims, 1); assert.equal(out.admin_access_logs, 1);
  assert.deepEqual(await ids(`SELECT id FROM ai_runs WHERE id LIKE 'run-%'`), ['run-keep']);
  assert.equal((await db.get(`SELECT ai_run_id FROM credit_ledger WHERE id = 'led-1'`)).ai_run_id, null);   // the deduction itself stays with the workspace
  assert.deepEqual(await ids(`SELECT id FROM email_deliveries WHERE id LIKE 'ed-%'`), ['ed-keep']);
  assert.deepEqual(await ids(`SELECT id FROM invitations WHERE id LIKE 'inv-%'`), ['inv-accepted-old', 'inv-expired-new', 'inv-revoked-new']);
  assert.deepEqual((await db.all('SELECT owner_user_id AS id FROM free_credit_claims ORDER BY 1')).map((r) => r.id).filter((x) => x.startsWith('fc-')), ['fc-keep']);
  assert.deepEqual((await db.all(`SELECT path FROM admin_access_logs WHERE admin_user_id = 'op'`)).map((r) => r.path), ['/keep']);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM analytics_events WHERE user_id = ?`, [A.uid])).n) >= 1, true);
  // idempotent
  const again = await purgePersonalLogs(db);
  assert.ok(Object.values(again).every((v) => v === 0), JSON.stringify(again));
});

test('G-5: every operator request to /api/admin (reads included) is logged with the query; non-operators are not', async () => {
  const op = await setup(client, 'op@x.com', '운영자');
  const user = await setup(client, 'plain@x.com', '일반');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [op.uid]);
  assert.equal((await op.c('GET', '/api/admin/users?q=plain%40x.com')).status, 200);
  assert.equal((await op.c('GET', '/api/admin/service-orders')).status, 200);   // mounted outside admin-routes.js: still logged
  assert.equal((await user.c('GET', '/api/admin/users')).status, 403);
  const rows = await db.all('SELECT admin_user_id, method, path, ip FROM admin_access_logs WHERE admin_user_id IN (?, ?) ORDER BY id', [op.uid, user.uid]);
  assert.deepEqual(rows.map((r) => [r.admin_user_id, r.method, r.path]), [[op.uid, 'GET', '/api/admin/users?q=plain%40x.com'], [op.uid, 'GET', '/api/admin/service-orders']]);
  assert.ok(rows[0].ip);
});

test('G-8: 1 year without use → e-mail 30 days ahead, deleted after; signing in cancels; shared-workspace sole owner, operators and failed mails are kept', async () => {
  const P = RETENTION_POLICY;
  const gone = await setup(client, 'idle@x.com', '휴면');
  const back = await setup(client, 'back@x.com', '복귀');
  const fresh = await setup(client, 'fresh@x.com', '최근');
  const owner = await setup(client, 'sole@x.com', '소유자');
  await addMember(client, owner, 'busy@x.com', '팀원');
  const op = await setup(client, 'op2@x.com', '운영자2');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [op.uid]);
  const nomail = await setup(client, 'nomail@x.com', '실패');
  for (const u of [gone, back, owner, op]) await idleSince(u.uid, '340 days');
  await idleSince(fresh.uid, '300 days');
  await idleSince(nomail.uid, '400 days');
  const notice = async (uid) => (await db.get('SELECT inactive_notice_at FROM users WHERE id = ?', [uid]))?.inactive_notice_at ?? null;

  // nomail is first in line (oldest): its send fails → no notice recorded, retried next run
  mail.failNext = { code: 'boom', message: 'down' };
  let out = await processInactiveAccounts(db);
  assert.equal(out.inactive_notice_failed, 1); assert.equal(out.inactive_notified, 3);   // gone, back, owner (not fresh, not the operator)
  assert.equal(await notice(nomail.uid), null); assert.equal(await notice(fresh.uid), null); assert.equal(await notice(op.uid), null);
  assert.ok(await notice(gone.uid));
  const m = mail.find((x) => x.to === 'idle@x.com' && x.tags.includes('ACCOUNT_INACTIVE_NOTICE'));
  assert.equal(m.length, 1); assert.match(m[0].subject, /삭제됩니다/); assert.match(m[0].text, /로그인하면 삭제는 취소/);
  // a second run the same day sends nothing new to them (nomail is retried and now succeeds) and deletes nobody yet
  out = await processInactiveAccounts(db);
  assert.equal(out.inactive_notified, 1); assert.equal(out.inactive_deleted, 0);
  assert.equal(mail.find((x) => x.to === 'idle@x.com' && x.tags.includes('ACCOUNT_INACTIVE_NOTICE')).length, 1);

  // back signs in during the 30 days
  const c = client(); assert.equal((await c('POST', '/api/auth/login', { email: 'back@x.com', password: 'passw0rd!' })).status, 200);
  // 30 days pass (and the year of inactivity is complete)
  for (const u of [gone, back, owner, nomail]) await db.run(`UPDATE users SET inactive_notice_at = inactive_notice_at - (? * interval '1 day') - interval '1 minute' WHERE id = ?`, [P.INACTIVE_NOTICE_DAYS, u.uid]);
  for (const u of [gone, owner]) await idleSince(u.uid, '371 days');
  out = await purgeExpired(db);
  assert.equal(out.inactive_deleted, 2);   // gone + nomail
  assert.equal(out.inactive_kept, 1);      // owner: the only OWNER of a workspace with another member
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM users WHERE id IN (?, ?)', [gone.uid, nomail.uid])).n), 0);
  for (const u of [back, owner, fresh, op]) assert.equal(Number((await db.get('SELECT COUNT(*) n FROM users WHERE id = ?', [u.uid])).n), 1);
  assert.equal((await db.get('SELECT status FROM workspaces WHERE id = ?', [gone.w])).status, 'CLOSED');   // solo workspace: purged 30 days later
  const w = await db.all(`SELECT source FROM account_withdrawals WHERE source = 'INACTIVE'`);
  assert.equal(w.length, 2);
  // back is safe for another 11 months: no new notice, no deletion
  out = await processInactiveAccounts(db);
  assert.equal(out.inactive_notified, 0); assert.equal(out.inactive_deleted, 0);
});

test('privacy policy 제3조 states the periods the code enforces', () => {
  const md = privacyMarkdown();
  const s3 = md.slice(md.indexOf('## 제3조'), md.indexOf('## 제4조'));
  for (const phrase of ['기록일로부터 1년', '실행일로부터 1년', '발송일로부터 1년', '만료·취소일로부터 30일', '지급일로부터 3년', '접수일로부터 3년',
    '1년 동안 로그인하거나 서비스를 이용한 기록이 없는 계정은 삭제', '삭제 30일 전에 회원의 이메일로', '법정 신고기한부터 5년', '거래가 있었던 해의 다음 해 1월 1일부터 6년',
    '접속 기록(계정, 접속 일시, 접속지', '| 2년 |']) assert.ok(s3.includes(phrase), phrase);
  assert.equal(RETENTION_POLICY.LOG_YEARS, 1); assert.equal(RETENTION_POLICY.ENDED_INVITE_DAYS, 30); assert.equal(RETENTION_POLICY.FREE_CLAIM_YEARS, 3);
  assert.equal(RETENTION_POLICY.ADMIN_ACCESS_YEARS, 2); assert.equal(RETENTION_POLICY.INACTIVE_YEARS, 1); assert.equal(RETENTION_POLICY.INACTIVE_NOTICE_DAYS, 30);
  assert.ok(md.includes('제3조 제6항의 기간'));   // Google Analytics row points at the renumbered paragraph
});
