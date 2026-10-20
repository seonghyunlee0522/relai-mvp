/* 관리자 › 연동 › 이메일 발송 테스트: POST /api/admin/email/test + GET /api/admin/email/status, default sender, Resend error
 * mapping, key redaction. Resend is always a mock fetch here — no real mail leaves the machine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { emailConfig, DEFAULT_EMAIL_FROM } from '../email/config.js';
import { resendProvider, redactSecrets } from '../email/provider.js';
import { setEmailTestFetch, validateTestRecipient } from '../email/admin-test.js';
import { AUDIT_ACTIONS } from '../admin.js';
import { sha256 } from '../security.js';
import { ACTIONS } from '../../public/app/shared/admin-labels.js';

const FAKE_KEY = 're_test_FAKEKEY0123456789abcdef';   // not a real key: shape only, to prove it never leaks
const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_PROVIDER'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

/** Mock Resend: records calls, answers with `status` / `body`, or throws `throwErr`. */
function mockResend({ status = 200, body = { id: 'msg_123' }, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    if (throwErr) throw throwErr;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
async function operator(db, client, email = 'ops@relai.io') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email, password: 'passw0rd!' });
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]);
  await c('POST', '/api/auth/login', { email, password: 'passw0rd!' });
  return { c, uid: s.json.user.id };
}
/** Captures console output during fn so we can assert the key is never logged. */
async function captureLogs(fn) {
  const out = []; const orig = {};
  for (const m of ['log', 'info', 'warn', 'error']) { orig[m] = console[m]; console[m] = (...a) => { out.push(a.map(String).join(' ')); }; }
  try { await fn(); } finally { Object.assign(console, orig); }
  return out.join('\n');
}

test('config: RESEND_API_KEY / EMAIL_FROM come from env only; empty EMAIL_FROM → RELAI <noreply@relai.kr>', () => {
  assert.equal(DEFAULT_EMAIL_FROM, 'RELAI <noreply@relai.kr>');
  assert.equal(emailConfig({}).from, 'RELAI <noreply@relai.kr>');
  assert.equal(emailConfig({ EMAIL_FROM: '   ' }).from, 'RELAI <noreply@relai.kr>');
  assert.equal(emailConfig({ EMAIL_FROM: 'Team <team@relai.kr>' }).from, 'Team <team@relai.kr>');
  assert.equal(emailConfig({ RESEND_API_KEY: ` ${FAKE_KEY} ` }).resendApiKey, FAKE_KEY);
  assert.equal(emailConfig({}).resendApiKey, '');
});

test('provider: the default sender goes in the Resend payload; Resend error text is replaced by a fixed Korean message', async () => {
  const f = mockResend();
  await resendProvider({ ...emailConfig({ RESEND_API_KEY: FAKE_KEY }), timeoutMs: 1000 }, f).send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' });
  assert.equal(f.calls[0].url, 'https://api.resend.com/emails');
  assert.equal(f.calls[0].payload.from, 'RELAI <noreply@relai.kr>');
  assert.deepEqual(f.calls[0].payload.to, ['a@b.co']);
  const bad = mockResend({ status: 403, body: { message: `The relai.kr domain is not verified for key ${FAKE_KEY}` } });
  await assert.rejects(resendProvider({ ...emailConfig({ RESEND_API_KEY: FAKE_KEY }), timeoutMs: 1000 }, bad).send({ to: 'a@b.co', subject: 's' }),
    (e) => e.code === 'http_403' && !e.message.includes('verified for key') && !e.message.includes(FAKE_KEY) && /인증되지 않았습니다/.test(e.message));
});

test('redactSecrets strips Bearer tokens, re_ keys and the configured key', () => {
  const s = redactSecrets(`Authorization: Bearer ${FAKE_KEY} / ${FAKE_KEY} / re_abcdefgh1234`, FAKE_KEY);
  assert.ok(!s.includes(FAKE_KEY)); assert.ok(!s.includes('re_abcdefgh1234')); assert.match(s, /\[redacted\]/);
});

test('recipient validation: syntax, length, CR/LF header injection, single recipient', () => {
  assert.equal(validateTestRecipient('founder@relai.kr'), null);
  assert.equal(validateTestRecipient(' a.b+c@sub.example.co.kr '), null);
  for (const bad of [undefined, 42, '', '   ', 'no-at-sign', 'a@b', 'a@@b.co', '.a@b.co', 'a..b@b.co', 'a@-b.co', 'a@b.c',
    'a@b.co\r\nBcc: x@y.co', 'a@b.co\nx', 'a@b.co%0d', 'a@b.co, c@d.co', 'a@b.co;c@d.co', 'a@b.co c@d.co', 'Name <a@b.co>',
    `${'x'.repeat(65)}@b.co`, `a@${'x'.repeat(250)}.co`]) {
    assert.ok(validateTestRecipient(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('auth: 401 when logged out, 403 for a non-operator (even a workspace OWNER); nothing is sent', async () => {
  const { db, server, client } = await boot();
  const f = mockResend(); setEmailTestFetch(f); process.env.RESEND_API_KEY = FAKE_KEY;
  try {
    const anon = client();
    assert.equal((await anon('POST', '/api/admin/email/test', { to: 'a@b.co' })).status, 401);
    assert.equal((await anon('GET', '/api/admin/email/status')).status, 401);
    const owner = await setup(client, 'owner@x.com', '오너');
    assert.equal((await owner.c('POST', '/api/admin/email/test', { to: 'a@b.co' })).status, 403);
    assert.equal((await owner.c('GET', '/api/admin/email/status')).status, 403);
    assert.equal(f.calls.length, 0);
  } finally { setEmailTestFetch(null); restoreEnv(); server.close(); }
});

test('status: provider, sender, key present yes/no (never the value), domain', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  try {
    process.env.EMAIL_PROVIDER = 'fake'; delete process.env.EMAIL_FROM; process.env.RESEND_API_KEY = FAKE_KEY;
    let r = await ops.c('GET', '/api/admin/email/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { provider: 'fake', from: 'RELAI <noreply@relai.kr>', from_is_default: true, default_from: 'RELAI <noreply@relai.kr>', key_present: true, domain: 'relai.kr' });
    assert.ok(!JSON.stringify(r.json).includes(FAKE_KEY));
    delete process.env.RESEND_API_KEY; process.env.EMAIL_FROM = 'RELAI <hello@mail.relai.kr>';
    r = await ops.c('GET', '/api/admin/email/status');
    assert.equal(r.json.key_present, false); assert.equal(r.json.domain, 'mail.relai.kr'); assert.equal(r.json.from_is_default, false);
  } finally { restoreEnv(); server.close(); }
});

test('send: goes through Resend even when EMAIL_PROVIDER=fake; EMAIL_TEST audit row; no key in response or logs', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const f = mockResend({ body: { id: 'msg_ok_1' } }); setEmailTestFetch(f);
  process.env.EMAIL_PROVIDER = 'fake'; process.env.RESEND_API_KEY = FAKE_KEY; delete process.env.EMAIL_FROM;
  try {
    let r;
    const logs = await captureLogs(async () => { r = await ops.c('POST', '/api/admin/email/test', { to: ' founder@relai.kr ' }); });
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'SENT'); assert.equal(r.json.to, 'founder@relai.kr'); assert.equal(r.json.provider_message_id, 'msg_ok_1');
    assert.equal(r.json.from, 'RELAI <noreply@relai.kr>');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);          // the key is used server-side…
    assert.deepEqual(f.calls[0].payload.to, ['founder@relai.kr']);
    assert.equal(f.calls[0].payload.from, 'RELAI <noreply@relai.kr>');
    assert.ok(!JSON.stringify(r.json).includes(FAKE_KEY)); assert.ok(!logs.includes(FAKE_KEY));   // …but never returned or logged
    const a = await db.get(`SELECT * FROM admin_audit_logs WHERE action = 'EMAIL_TEST'`);
    assert.equal(a.admin_user_id, ops.uid); assert.equal(a.target_type, 'EMAIL'); assert.equal(a.target_id, 'msg_ok_1');
    assert.equal(a.metadata.to, 'founder@relai.kr'); assert.equal(a.metadata.result, 'SENT');
    assert.ok(!JSON.stringify(a.metadata).includes(FAKE_KEY));
    const audit = await ops.c('GET', '/api/admin/audit?action=EMAIL_TEST');
    assert.equal(audit.json.items.length, 1); assert.match(audit.json.items[0].summary, /테스트 메일 founder@relai.kr — 발송 성공/);
    assert.ok(AUDIT_ACTIONS.includes('EMAIL_TEST')); assert.ok(ACTIONS.EMAIL_TEST);
  } finally { setEmailTestFetch(null); restoreEnv(); server.close(); }
});

test('send: each Resend failure maps to a Korean message and stable code, without vendor text or the key; FAILED audit row', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  process.env.RESEND_API_KEY = FAKE_KEY;
  const vendor = `vendor says: API key ${FAKE_KEY} is invalid or domain relai.kr not verified`;
  const cases = [
    [{ status: 401, body: { message: vendor } }, 'resend_key_invalid', /RESEND_API_KEY가 올바르지 않습니다/],
    [{ status: 403, body: { message: vendor } }, 'resend_domain_not_verified', /도메인이 Resend에서 인증되지 않았습니다/],
    [{ status: 422, body: { message: vendor } }, 'resend_invalid', /형식이 올바르지 않습니다/],
    [{ status: 429, body: { message: vendor } }, 'resend_rate_limited', /발송 한도를 초과했습니다/],
    [{ status: 500, body: { message: vendor } }, 'resend_server_error', /Resend 서버 오류/],
    [{ throwErr: Object.assign(new Error(`connect ECONNREFUSED ${FAKE_KEY}`), { name: 'TypeError' }) }, 'resend_network', /연결할 수 없습니다/],
    [{ throwErr: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 'resend_timeout', /응답 시간이 초과/],
  ];
  try {
    let i = 0;
    for (const [mock, code, msg] of cases) {
      await db.run('DELETE FROM rate_limits');
      setEmailTestFetch(mockResend(mock));
      let r;
      const logs = await captureLogs(async () => { r = await ops.c('POST', '/api/admin/email/test', { to: `t${i++}@relai.kr` }); });
      assert.equal(r.status, 502, code);
      assert.equal(r.json.error.code, code); assert.match(r.json.error.message, msg); assert.equal(r.json.error.result, 'FAILED');
      const body = JSON.stringify(r.json);
      assert.ok(!body.includes(FAKE_KEY) && !body.includes('vendor says') && !body.includes('ECONNREFUSED'), `leak in ${code}`);
      assert.ok(!logs.includes(FAKE_KEY), `key logged in ${code}`);
    }
    const rows = await db.all(`SELECT metadata FROM admin_audit_logs WHERE action = 'EMAIL_TEST' ORDER BY seq`);
    assert.equal(rows.length, cases.length);
    assert.deepEqual(rows.map((x) => x.metadata.error_code), cases.map((c) => c[1]));
    assert.ok(rows.every((x) => x.metadata.result === 'FAILED' && !JSON.stringify(x.metadata).includes(FAKE_KEY)));
  } finally { setEmailTestFetch(null); restoreEnv(); server.close(); }
});

test('validation and missing key: 400 before any send, no audit row, no rate-limit hit', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const f = mockResend(); setEmailTestFetch(f);
  try {
    process.env.RESEND_API_KEY = FAKE_KEY;
    for (const to of [undefined, '', 'nope', 'a@b.co\r\nBcc: evil@x.co', 'a@b.co,c@d.co', ['a@b.co', 'c@d.co'], `${'x'.repeat(250)}@b.co`]) {
      const r = await ops.c('POST', '/api/admin/email/test', { to });
      assert.equal(r.status, 400, JSON.stringify(to)); assert.equal(r.json.error.code, 'invalid_recipient');
    }
    delete process.env.RESEND_API_KEY;
    const r = await ops.c('POST', '/api/admin/email/test', { to: 'a@b.co' });
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'resend_key_missing'); assert.match(r.json.error.message, /RESEND_API_KEY가 설정되지 않았습니다/);
    assert.equal(f.calls.length, 0);
    assert.equal((await db.get(`SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action = 'EMAIL_TEST'`)).n, 0);
    assert.equal(await db.get('SELECT 1 FROM rate_limits WHERE key = ?', [sha256(`admin_email_test:${ops.uid}`)]), undefined);
  } finally { setEmailTestFetch(null); restoreEnv(); server.close(); }
});

test('rate limit: 5 sends per operator per 10 minutes, the 6th is 429 and never reaches Resend; other operators unaffected', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const ops2 = await operator(db, client, 'ops2@relai.io');
  const f = mockResend(); setEmailTestFetch(f); process.env.RESEND_API_KEY = FAKE_KEY;
  try {
    for (let i = 0; i < 5; i++) assert.equal((await ops.c('POST', '/api/admin/email/test', { to: 'a@b.co' })).status, 200);
    const r = await ops.c('POST', '/api/admin/email/test', { to: 'a@b.co' });
    assert.equal(r.status, 429); assert.equal(r.json.error.code, 'rate_limited'); assert.match(r.json.error.message, /10분에 5번/);
    assert.equal(f.calls.length, 5);
    assert.equal((await ops2.c('POST', '/api/admin/email/test', { to: 'a@b.co' })).status, 200);
  } finally { setEmailTestFetch(null); restoreEnv(); server.close(); }
});

test('server-only: nothing under public/ imports server e-mail code or holds a key-shaped string', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = new URL('../../public/', import.meta.url).pathname;
  const files = (await readdir(root, { recursive: true })).filter((f) => /\.(js|html)$/.test(f));
  for (const f of files) {
    const s = await readFile(join(root, f), 'utf8');
    assert.ok(!/server\/email|email\/(config|provider|service|admin-test)\.js/.test(s), `${f} imports server e-mail code`);
    assert.ok(!/re_[A-Za-z0-9_]{12,}/.test(s), `${f} holds a key-shaped string`);
  }
});
