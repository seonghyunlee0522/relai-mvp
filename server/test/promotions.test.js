/* Promotions (migration 47, founder feedback 2026-10-15): one admin-editable source for the offers on signup · login · landing ·
 * 설정 › AI 크레딧 · Home, rendered by the shared component public/app/shared/promo.js. Display only. UI: scripts/e2e-fb-public.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { promoHtml } from '../../public/app/shared/promo.js';
import { todayKst, addDays } from '../../public/app/shared/kst-date.js';
import { clearPromoCache } from '../promotions.js';
import { migrations } from '../migrations.js';

const T = todayKst();

test('seed: the launch offer per placement; public read needs no login', async () => {
  const { client } = await boot();
  const c = client();
  const by = async (p) => (await c('GET', `/api/promotions?placement=${p}`)).json.promotions;
  assert.deepEqual((await by('signup')).map((p) => p.badge), ['무료 플랜', 'AI 크레딧', '이후 AI']);
  assert.deepEqual((await by('landing')).map((p) => p.id), ['promo-early-access', 'promo-ai-credits', 'promo-ai-payg']);
  assert.match((await by('signup'))[2].body, /쓴 만큼만 크레딧이 차감/);
  assert.equal((await by('login'))[0].link_url, '/signup');
  // b7-fix P0-1: early access retired — no 12개월 / 얼리 액세스 promise and no {until} rows on a fresh database
  for (const p of ['signup', 'landing', 'login']) for (const x of await by(p)) assert.doesNotMatch(`${x.title} ${x.body} ${x.badge || ''}`, /12개월|얼리 액세스|\{until\}|₩/, `${p} ${x.id}`);
  assert.equal((await by('login'))[0].title, '지금 가입하면 무료 플랜으로 시작');
  assert.deepEqual(await by('home'), []); assert.deepEqual(await by('credits'), []);
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
  assert.equal((await c('GET', `/api/workspaces/${w}/credits/summary`)).json.credits.balance, 100);   // pricing v3: Free 최초 100
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]);
  const list = await c('GET', '/api/admin/promotions');
  assert.equal(list.status, 200); assert.equal(list.json.promotions.length, 4); assert.ok(list.json.placements.credits);

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

test('migration 53 (b7-fix P0-1): unedited early-access rows get Free-plan copy, unedited {until} rows are switched off; operator edits stay', async () => {
  const { db } = await boot();
  // the rows as migration 47 seeded them (promo-login already through migration 49), plus one operator edit
  await db.run(`UPDATE promotions SET title = '12개월 동안 전체 기능 무료', body = '가입한 날부터 12개월 동안 RELAI의 모든 기능을 요금 없이 씁니다.', badge = '얼리 액세스' WHERE id = 'promo-early-access'`);
  await db.run(`UPDATE promotions SET title = '지금 가입하면 12개월 무료', body = 'AI 크레딧 500도 함께 드립니다.', badge = '얼리 액세스' WHERE id = 'promo-login'`);
  await db.run(`INSERT INTO promotions (id, title, body, badge, placements, sort_order) VALUES
    ('promo-home', '얼리 액세스 {until}까지 무료', '', NULL, '{home}', 50),
    ('promo-credits', '운영자가 고친 {until} 문구', '', '얼리 액세스', '{credits}', 60)`);
  const up = migrations.find((m) => m.version === 53).up;
  await up(db); await up(db);   // idempotent
  const row = (id) => db.get('SELECT title, body, badge, active FROM promotions WHERE id = ?', [id]);
  assert.deepEqual({ ...(await row('promo-early-access')) }, { title: '무료 플랜으로 시작', body: '프로젝트 2개까지 결제 정보 없이 바로 씁니다.', badge: '무료 플랜', active: true });
  assert.deepEqual({ ...(await row('promo-login')) }, { title: '지금 가입하면 무료 플랜으로 시작', body: 'AI 크레딧 500도 함께 드립니다.', badge: '무료 플랜', active: true });
  assert.equal((await row('promo-home')).active, false);
  assert.equal((await row('promo-credits')).active, true);   // edited by an operator → untouched
  assert.equal((await db.get('SELECT COUNT(*)::int n FROM promotions')).n, 6);   // nothing deleted
});
