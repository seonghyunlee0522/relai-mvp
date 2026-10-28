/* 공지사항 (migration 74): operator CRUD + image upload, public popup feed (landing / app Home), signed-in list (visible only). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { clearNoticeCache } from '../notices.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const operator = async (db, client, email = 'nt-op@example.com') => {
  const A = await setup(client, email, '운영자');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [A.uid]);
  return A;
};
const iso = (ms) => new Date(Date.now() + ms).toISOString();

test('seed: the beta-open notice is visible, in the list and in both popups with its static image', async () => {
  const { client } = await boot();
  const U = await setup(client, 'nt-seed@example.com', '사용자');
  const list = await U.c('GET', '/api/notices');
  assert.equal(list.status, 200);
  const seed = list.json.notices.find((n) => n.id === 'notice-beta-open');
  assert.ok(seed); assert.match(seed.title, /베타/); assert.match(seed.body, /의견 남기기/); assert.equal(seed.image_url, undefined);
  for (const placement of ['landing', 'app_home']) {
    const p = await client()('GET', `/api/notices/popup?placement=${placement}`);
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.notices.map((n) => n.image_url), ['/img/notices/relai-beta-open.png']);
    assert.equal(p.json.notices[0].body, undefined);   // the popup carries the image only
  }
  assert.deepEqual((await client()('GET', '/api/notices/popup?placement=nope')).json.notices, []);
});

test('access: list needs sign-in; admin routes are operator-only', async () => {
  const { db, client } = await boot();
  assert.equal((await client()('GET', '/api/notices')).status, 401);
  const U = await setup(client, 'nt-user@example.com', '사용자');
  assert.equal((await U.c('GET', '/api/admin/notices')).status, 403);
  assert.equal((await U.c('POST', '/api/admin/notices', { title: 'x' })).status, 403);
  const A = await operator(db, client);
  assert.equal((await A.c('GET', '/api/admin/notices')).status, 200);
});

test('operator CRUD: validation, period, active, popup placements decide what users and the popups see', async () => {
  const { db, client } = await boot();
  const A = await operator(db, client);
  const U = await setup(client, 'nt-u2@example.com', '사용자');
  const bad = await A.c('POST', '/api/admin/notices', { title: '  ', starts_at: iso(3600e3), ends_at: iso(60e3), popup_placements: ['moon'] });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.fields.title); assert.ok(bad.json.error.fields.ends_at); assert.ok(bad.json.error.fields.popup_placements);

  const now = (await A.c('POST', '/api/admin/notices', { title: '점검 안내', body: '11월 1일 02:00~04:00 점검합니다.\n이용에 참고해 주세요.' })).json.notice;
  const later = (await A.c('POST', '/api/admin/notices', { title: '예정 공지', starts_at: iso(86400e3) })).json.notice;
  const ended = (await A.c('POST', '/api/admin/notices', { title: '지난 공지', starts_at: iso(-2 * 86400e3), ends_at: iso(-86400e3) })).json.notice;
  const off = (await A.c('POST', '/api/admin/notices', { title: '꺼진 공지', active: false })).json.notice;
  assert.deepEqual(now.popup_placements, ['landing', 'app_home']);

  const titles = (await U.c('GET', '/api/notices')).json.notices.map((n) => n.title);
  assert.ok(titles.includes('점검 안내'));
  for (const t of ['예정 공지', '지난 공지', '꺼진 공지']) assert.ok(!titles.includes(t), t);
  const mine = (await U.c('GET', '/api/notices')).json.notices.find((n) => n.id === now.id);
  assert.equal(mine.body, '11월 1일 02:00~04:00 점검합니다.\n이용에 참고해 주세요.'); assert.equal(mine.is_new, true);

  // one-sided date edit is checked against the stored other side
  assert.equal((await A.c('PATCH', `/api/admin/notices/${ended.id}`, { ends_at: iso(-3 * 86400e3) })).status, 422);
  assert.equal((await A.c('PATCH', `/api/admin/notices/${off.id}`, { active: true })).status, 200);
  assert.ok((await U.c('GET', '/api/notices')).json.notices.some((n) => n.id === off.id));
  assert.equal((await A.c('DELETE', `/api/admin/notices/${later.id}`)).status, 200);
  assert.equal((await A.c('PATCH', `/api/admin/notices/${later.id}`, { title: 'x' })).status, 404);
  const audit = await db.all(`SELECT action FROM admin_audit_logs WHERE target_type = 'NOTICE'`);
  assert.ok(['NOTICE_CREATE', 'NOTICE_UPDATE', 'NOTICE_DELETE'].every((a) => audit.some((x) => x.action === a)));
});

test('image: type sniffing, 2 MB cap, versioned public URL only while active, popup only for its placements, removal', async () => {
  const { db, client } = await boot();
  const A = await operator(db, client);
  const n = (await A.c('POST', '/api/admin/notices', { title: '이미지 공지', popup_placements: ['app_home'] })).json.notice;
  const put = (o) => A.c('PUT', `/api/admin/notices/${n.id}/image`, o);
  assert.equal((await put({ type: 'image/png', data: Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 422);
  assert.equal((await put({ type: 'image/svg+xml', data: PNG.toString('base64') })).status, 422);
  const big = await put({ type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]).toString('base64') });
  assert.equal(big.status, 422); assert.match(big.json.error.message, /2MB/);

  const ok = await put({ type: 'image/png', data: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(ok.status, 200); assert.equal(ok.json.notice.has_upload, true); assert.equal(ok.json.notice.image_size, PNG.length);
  clearNoticeCache();
  const home = (await client()('GET', '/api/notices/popup?placement=app_home')).json.notices.find((x) => x.id === n.id);
  assert.match(home.image_url, new RegExp(`^/api/notices/${n.id}/image\\?v=\\d+$`));
  assert.ok(!(await client()('GET', '/api/notices/popup?placement=landing')).json.notices.some((x) => x.id === n.id));
  const img = await client()('GET', home.image_url, undefined, { raw: true });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); assert.ok(img.buf.equals(PNG));
  assert.match(img.headers.get('cache-control'), /immutable/);

  await A.c('PATCH', `/api/admin/notices/${n.id}`, { active: false });
  assert.equal((await client()('GET', home.image_url, undefined, { raw: true })).status, 404);
  assert.equal((await A.c('GET', `/api/admin/notices/${n.id}/image`, undefined, { raw: true })).status, 200);   // operator preview still works

  const cleared = await A.c('DELETE', `/api/admin/notices/${n.id}/image`);
  assert.equal(cleared.json.notice.has_upload, false); assert.equal(cleared.json.notice.image_url, null);
});
