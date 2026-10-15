/* Promotions (migration 47, founder feedback 2026-10-15): one admin-editable source for the offers on signup · login · landing ·
 * 설정 › AI 크레딧 · Home, rendered by the shared component public/app/shared/promo.js. Display only. UI: scripts/e2e-fb-public.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { promoHtml } from '../../public/app/shared/promo.js';
import { todayKst, addDays } from '../../public/app/shared/kst-date.js';
import { clearPromoCache } from '../promotions.js';

const T = todayKst();

test('seed: the launch offer per placement; public read needs no login', async () => {
  const { client } = await boot();
  const c = client();
  const by = async (p) => (await c('GET', `/api/promotions?placement=${p}`)).json.promotions;
  assert.deepEqual((await by('signup')).map((p) => p.badge), ['얼리 액세스', 'AI 크레딧', '이후 AI']);
  assert.deepEqual((await by('landing')).map((p) => p.id), ['promo-early-access', 'promo-ai-credits', 'promo-ai-payg']);
  assert.match((await by('signup'))[2].body, /1 크레딧 = ₩10/);
  assert.equal((await by('login'))[0].link_url, '/signup');
  assert.match((await by('home'))[0].title, /\{until\}/);
  assert.match((await by('credits'))[0].title, /\{until\}/);
  assert.deepEqual(await by('nope'), []);
});

test('landing pricing renders the cards server-side', async () => {
  const { client } = await boot();
  const r = await client()('GET', '/', undefined, { raw: true });
  const page = r.buf.toString();
  assert.equal((page.match(/class="promo-card"/g) || []).length, 3);
  assert.ok(!page.includes('<!--PROMO:landing-->'));
});

test('admin CRUD: operator only, validated, audited, honours active + KST date window', async () => {
  const { client, db } = await boot();
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email: 'promo-op@x.com', password: 'passw0rd!' });
  assert.equal((await c('GET', '/api/admin/promotions')).status, 403);
  // credit grant is untouched by promotions: the starter grant still lands
  const w = s.json.workspaces[0].id;
  assert.equal((await c('GET', `/api/workspaces/${w}/credits/summary`)).json.credits.balance, 500);
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]);
  const list = await c('GET', '/api/admin/promotions');
  assert.equal(list.status, 200); assert.equal(list.json.promotions.length, 6); assert.ok(list.json.placements.credits);

  const bad = await c('POST', '/api/admin/promotions', { title: '', placements: ['nope'], link_url: 'javascript:alert(1)', starts_on: '2026-12-01', ends_on: '2026-11-01' });
  assert.equal(bad.status, 422);
  for (const k of ['title', 'placements', 'link_url', 'ends_on']) assert.ok(bad.json.error.fields[k], k);

  const made = await c('POST', '/api/admin/promotions', { title: '추석 이벤트', body: '크레딧 추가', badge: '이벤트', placements: ['login', 'signup'], sort_order: 1, link_url: '/signup', link_label: '가입' });
  assert.equal(made.status, 200);
  const id = made.json.promotion.id;
  const pub = async (p) => { clearPromoCache(); return (await client()('GET', `/api/promotions?placement=${p}`)).json.promotions.map((x) => x.id); };
  assert.equal((await pub('login'))[0], id);
  assert.equal((await pub('signup'))[0], id);

  assert.equal((await c('PATCH', `/api/admin/promotions/${id}`, { active: false })).status, 200);
  assert.ok(!(await pub('login')).includes(id));
  await c('PATCH', `/api/admin/promotions/${id}`, { active: true, starts_on: addDays(T, 1) });
  assert.ok(!(await pub('login')).includes(id), 'starts tomorrow');
  await c('PATCH', `/api/admin/promotions/${id}`, { starts_on: T, ends_on: T });
  assert.ok((await pub('login')).includes(id), 'today is inside an inclusive window');
  await c('PATCH', `/api/admin/promotions/${id}`, { starts_on: addDays(T, -9), ends_on: addDays(T, -1) });
  assert.ok(!(await pub('login')).includes(id), 'ended yesterday');
  const oneSided = await c('PATCH', `/api/admin/promotions/${id}`, { starts_on: T });
  assert.equal(oneSided.status, 422, 'a start after the stored end is refused');

  assert.equal((await c('DELETE', `/api/admin/promotions/${id}`)).status, 200);
  assert.equal((await c('DELETE', `/api/admin/promotions/${id}`)).status, 404);
  const audit = await db.all(`SELECT action FROM admin_audit_logs WHERE target_type = 'PROMOTION' AND target_id = ? ORDER BY created_at`, [id]);
  assert.ok(audit.length >= 5);
  assert.equal(audit[0].action, 'PROMOTION_CREATE'); assert.equal(audit.at(-1).action, 'PROMOTION_DELETE');
});

test('shared component: escapes, fills {until}, skips {until} rows without a date, refuses unsafe links', () => {
  const rows = [{ id: 'a', title: '<b>무료</b>', body: '{until}까지', badge: 'X', link_url: 'javascript:x' }, { id: 'b', title: '항상', body: '', link_url: '/signup', link_label: '가입' }];
  const h = promoHtml(rows, { placement: 'credits', until: '2027.10.15' });
  assert.match(h, /&lt;b&gt;무료/); assert.match(h, /2027\.10\.15까지/); assert.ok(!h.includes('javascript:')); assert.match(h, /href="\/signup"/);
  const noDate = promoHtml(rows, { placement: 'credits' });
  assert.ok(!noDate.includes('data-promo="a"') && noDate.includes('data-promo="b"'));
  assert.equal(promoHtml([], {}), '');
  assert.match(promoHtml(rows.slice(1), { variant: 'line' }), /class="promo-line"/);
});
