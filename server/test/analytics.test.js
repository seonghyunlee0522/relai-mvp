/* Product analytics (migration 46): track helper, middleware milestones, screen beacon, aggregates, admin page API + CSV. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { track, markActive, parseRange, screenKey, funnel, topFeatures, cohorts, activeUsers, funnelCsv, funnelReport, isBot } from '../analytics.js';
import { todayKst } from '../../public/app/shared/kst-date.js';

const count = async (db, where, params = []) => Number((await db.get(`SELECT COUNT(*) AS n FROM analytics_events WHERE ${where}`, params)).n);
const at = (day, hh = '03') => `${day}T${hh}:00:00Z`;   // 12:00 KST that day
const addDays = (d, k) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };

describe('track helper', () => {
  test('stores ids + key only; milestones once per user; feature repeats; never throws', async () => {
    const { db, server } = await boot();
    try {
      await track(db, 'signup', { userId: 'u1', workspaceId: 'w1' });
      await track(db, 'signup', { userId: 'u1', workspaceId: 'w1' });
      await track(db, 'stage_reached', { userId: 'u1', key: '02' });
      await track(db, 'stage_reached', { userId: 'u1', key: '03' });
      await track(db, 'stage_reached', { userId: 'u1', key: '02' });
      await track(db, 'feature', { userId: 'u1', key: 'POST /projects' });
      await track(db, 'feature', { userId: 'u1', key: 'POST /projects' });
      await track(db, 'landing_visit'); await track(db, 'landing_visit');
      assert.equal(await count(db, `name = 'signup'`), 1);
      assert.equal(await count(db, `name = 'stage_reached'`), 2);
      assert.equal(await count(db, `name = 'feature'`), 2);
      assert.equal(await count(db, `name = 'landing_visit' AND user_id IS NULL`), 2);
      const cols = (await db.all(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'analytics_events' ORDER BY ordinal_position`)).map((r) => r.column_name);
      assert.deepEqual(cols, ['id', 'name', 'key', 'user_id', 'workspace_id', 'project_id', 'sample', 'created_at']);   // no ip / email / name columns
      await assert.doesNotReject(track({ run: async () => { throw new Error('db down'); } }, 'signup', { userId: 'x' }));
      await markActive(db, 'u1'); await markActive(db, 'u1');
      assert.equal(Number((await db.get('SELECT COUNT(*) n FROM analytics_active_days')).n), 1);
    } finally { server.close(); }
  });

  test('screenKey normalises ids and refuses non-app paths; parseRange defaults to 30 days and swaps reversed dates; bot UA', () => {
    assert.equal(screenKey('/app/projects/1b0c7a2e-1111-4a2b-9c3d-0123456789ab/requirements?x=1'), '/app/projects/:id/requirements');
    assert.equal(screenKey('/app/projects/new/'), '/app/projects/new');
    assert.equal(screenKey('/admin/users'), null);
    assert.equal(screenKey('/app/<script>'), null);
    assert.deepEqual(parseRange({}, '2026-10-15'), { from: '2026-09-16', to: '2026-10-15' });
    assert.deepEqual(parseRange({ from: '2026-10-10', to: '2026-10-01' }, '2026-10-15'), { from: '2026-10-01', to: '2026-10-10' });
    assert.deepEqual(parseRange({ from: 'bad', to: '2026-10-05' }, '2026-10-15'), { from: '2026-09-06', to: '2026-10-05' });
    assert.ok(isBot('Googlebot/2.1') && isBot('') && isBot('Mozilla/5.0 HeadlessChrome/120') && !isBot('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36'));
  });
});

describe('aggregates', () => {
  test('funnel: cohort = signups in range, admins and sample events excluded, % per step, biggest drop', async () => {
    const { db, server } = await boot();
    try {
      await db.run(`INSERT INTO users (id, email, name, password_hash, system_role) VALUES ('adm', 'adm@x.com', 'A', 'x', 'SYSTEM_ADMIN')`);
      const ev = (name, user, day, extra = {}) => db.run(`INSERT INTO analytics_events (name, key, user_id, sample, created_at) VALUES (?, ?, ?, ?, ?)`, [name, extra.key ?? null, user, Boolean(extra.sample), at(day)]);
      for (let i = 0; i < 10; i += 1) await ev('landing_visit', null, '2026-10-02');
      await ev('landing_visit', null, '2026-09-01');                                   // outside the range
      for (const u of ['a', 'b', 'c', 'd', 'adm']) await ev('signup', u, '2026-10-03');
      await ev('signup', 'old', '2026-09-01'); await ev('project_created', 'old', '2026-10-03');   // signed up before the range → not in the cohort
      for (const u of ['a', 'b', 'c', 'adm']) await ev('email_verified', u, '2026-10-03');
      for (const u of ['a', 'b']) await ev('sample_opened', u, '2026-10-04');
      for (const u of ['a', 'b']) await ev('project_created', u, '2026-10-05');
      await ev('stage_reached', 'a', '2026-10-06', { key: '02' });
      await ev('first_requirement', 'a', '2026-10-06');
      await ev('first_wbs', 'c', '2026-10-06', { sample: true });                      // inside a sample → ignored
      const f = await funnel(db, { from: '2026-10-01', to: '2026-10-10' });
      const c = Object.fromEntries(f.steps.map((s) => [s.key, s.count]));
      assert.equal(f.landing_visits, 10); assert.equal(f.signups, 4);
      assert.deepEqual([c.landing_visit, c.signup, c.email_verified, c.sample_opened, c.project_created, c.stage_02, c.stage_03], [10, 4, 3, 2, 2, 1, 0]);
      const step = (k) => f.steps.find((s) => s.key === k);
      assert.equal(step('signup').pct_prev, 40); assert.equal(step('email_verified').pct_prev, 75); assert.equal(step('sample_opened').pct_signup, 50);
      assert.equal(f.biggest_drop.key, 'stage_03'); assert.equal(f.biggest_drop.pct_lost, 100);
      const fu = Object.fromEntries(f.first_use.map((x) => [x.key, x]));
      assert.equal(fu.first_requirement.count, 1); assert.equal(fu.first_requirement.pct_signup, 25); assert.equal(fu.first_wbs.count, 0);
    } finally { server.close(); }
  });

  test('top features by users then uses; sample + admin excluded; screen labels in Korean', async () => {
    const { db, server } = await boot();
    try {
      await db.run(`INSERT INTO users (id, email, name, password_hash, system_role) VALUES ('adm', 'adm@x.com', 'A', 'x', 'SYSTEM_ADMIN')`);
      const ev = (name, user, key, sample = false) => db.run(`INSERT INTO analytics_events (name, key, user_id, sample, created_at) VALUES (?, ?, ?, ?, ?)`, [name, key, user, sample, at('2026-10-05')]);
      for (const u of ['a', 'b']) await ev('feature', u, 'POST /projects/:pid/requirements');
      for (let i = 0; i < 5; i += 1) await ev('feature', 'a', 'POST /projects/:pid/wbs');
      for (const u of ['a', 'b', 'c']) await ev('feature', u, 'POST /projects/:pid/issues', true);   // samples only
      for (let i = 0; i < 9; i += 1) await ev('feature', 'adm', 'POST /projects/:pid/wbs');           // operator only
      await ev('screen', 'a', '/app/projects/:id/wbs');
      const t = await topFeatures(db, { from: '2026-10-01', to: '2026-10-10' });
      assert.deepEqual(t.map((x) => [x.label, x.users, x.uses]), [['요구사항 등록', 2, 2], ['WBS 작업 추가', 1, 5], ['화면 · WBS', 1, 1]]);
    } finally { server.close(); }
  });

  test('weekly cohorts: D1 / D7 / D30 return visits, not-yet-measurable days are null; DAU/WAU/MAU', async () => {
    const { db, server } = await boot();
    try {
      const today = '2026-10-15';
      const ev = (user, day) => db.run(`INSERT INTO analytics_events (name, user_id, created_at) VALUES ('signup', ?, ?)`, [user, at(day)]);
      const active = (user, day) => db.run('INSERT INTO analytics_active_days (user_id, day) VALUES (?, ?)', [user, day]);
      await ev('a', '2026-09-07'); await ev('b', '2026-09-08'); await ev('c', '2026-10-14');   // weeks of Mon 09-07 (a, b) and Mon 10-12 (c)
      await active('a', '2026-09-08'); await active('a', '2026-10-10');                         // a: D1, D7, D30 all yes
      await active('b', '2026-09-10');                                                          // b: D1 yes (on or after day 1), D7 no
      await active('c', '2026-10-15');
      const r = await cohorts(db, { from: '2026-09-01', to: '2026-10-15' }, today);
      assert.equal(r.length, 2);
      assert.deepEqual([r[0].week, r[0].users, r[0].d1.pct, r[0].d7.pct, r[0].d30.pct], ['2026-09-07', 2, 100, 50, 50]);
      assert.deepEqual([r[1].week, r[1].users, r[1].d1.pct, r[1].d7, r[1].d30], ['2026-10-12', 1, 100, null, null]);
      assert.deepEqual(await activeUsers(db, { to: today }), { dau: 1, wau: 2, mau: 2 });
    } finally { server.close(); }
  });

  test('CSV has every block, a BOM and quoted cells', async () => {
    const { db, server } = await boot();
    try {
      await track(db, 'feature', { userId: 'u', key: 'POST /x,"y"' });
      const r = await funnelReport(db, { from: todayKst(), to: todayKst() });
      const csv = funnelCsv(r);
      assert.ok(csv.startsWith('﻿RELAI 사용 분석'));
      for (const h of ['퍼널 단계', '가장 큰 이탈', '기능 첫 사용', '기능,구분,사용자 수,사용 횟수', '가입 주', 'DAU']) assert.ok(csv.includes(h), h);
      assert.ok(csv.includes('"POST /x,""y"""'));
    } finally { server.close(); }
  });
});

describe('server-side tracking through the API', () => {
  test('signup → milestones, sample open, project + stage, feature events; sample writes flagged; landing counted anonymously', async () => {
    process.env.SAMPLE_PROJECTS = 'true';
    const { db, server, client } = await boot();
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const A = await setup(client, 'pm@x.com');
      const ev = (name, extra = '') => count(db, `name = ? AND user_id = ? ${extra}`, [name, A.uid]);
      assert.equal(await ev('signup'), 1);
      assert.equal(await ev('project_created'), 1);
      assert.equal(await count(db, `name = 'stage_reached' AND key = '01' AND user_id = ?`, [A.uid]), 1);
      assert.equal(await ev('feature', `AND key = 'POST /projects'`), 1);
      assert.equal(Number((await db.get('SELECT COUNT(*) n FROM analytics_active_days WHERE user_id = ?', [A.uid])).n), 1);

      await A.c('POST', A.req, { title: '로그인', description: '이메일 로그인' });
      await A.c('POST', A.req, { title: '로그아웃', description: '로그아웃' });
      assert.equal(await ev('first_requirement'), 1);
      assert.equal(await ev('feature', `AND key = 'POST /projects/:pid/requirements'`), 2);
      const bad = await A.c('POST', A.req, { title: '' });
      assert.ok(bad.status >= 400); assert.equal(await ev('feature', `AND key = 'POST /projects/:pid/requirements'`), 2);   // failures are not usage

      // sample project: opening counts once; writes inside it are flagged sample and never become milestones
      const sample = (await A.c('GET', `/api/workspaces/${A.w}/projects`)).json.projects.find((p) => p.sample_key);
      assert.ok(sample, 'signup adds sample projects');
      await A.c('GET', `/api/workspaces/${A.w}/projects/${sample.id}`); await A.c('GET', `/api/workspaces/${A.w}/projects/${sample.id}`);
      assert.equal(await ev('sample_opened'), 1);
      const before = await ev('first_issue');
      const iss = await A.c('POST', `/api/workspaces/${A.w}/projects/${sample.id}/issues`, { title: '샘플 이슈' });
      if (iss.status === 201) assert.equal(await ev('feature', `AND key = 'POST /projects/:pid/issues' AND sample`), 1);
      assert.equal(await ev('first_issue'), before);

      // stage move 01 → 02
      const g = (await A.c('GET', A.purl)).json;
      const phases = g.guide?.phases || g.phases;
      const next = phases.find((p) => p.phase_key === 'REQUIREMENTS');
      const mv = await A.c('POST', `${A.purl}/phases/${next.id}/activate`, { reason: 'MANUAL' });
      assert.equal(mv.status, 200);
      assert.equal(await count(db, `name = 'stage_reached' AND key = '02' AND user_id = ?`, [A.uid]), 1);

      // screen beacon: ids normalised, project kept for members only
      assert.equal((await A.c('POST', '/api/analytics/screen', { path: `/app/projects/${A.p.id}/wbs` })).status, 204);
      const s = await db.get(`SELECT key, project_id, sample FROM analytics_events WHERE name = 'screen' AND user_id = ?`, [A.uid]);
      assert.deepEqual([s.key, s.project_id, s.sample], ['/app/projects/:id/wbs', A.p.id, false]);
      const B = await setup(client, 'other@x.com');
      await B.c('POST', '/api/analytics/screen', { path: `/app/projects/${A.p.id}` });
      assert.equal((await db.get(`SELECT project_id FROM analytics_events WHERE name = 'screen' AND user_id = ?`, [B.uid])).project_id, null);
      assert.equal((await client()('POST', '/api/analytics/screen', { path: '/app' })).status, 401);

      // landing: anonymous browser counted, bot and signed-in user not
      const land = (headers) => fetch(base + '/', { headers });
      await land({ 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36' });
      await land({ 'user-agent': 'Googlebot/2.1' });
      const r = await land({ 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36', cookie: (await (async () => { const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pm@x.com', password: 'passw0rd!' }) }); return res.headers.get('set-cookie').split(';')[0]; })()) });
      assert.equal(r.status, 200);
      assert.equal(await count(db, `name = 'landing_visit'`), 1);
      assert.equal(await count(db, `name = 'landing_visit' AND (user_id IS NOT NULL OR workspace_id IS NOT NULL)`), 0);
    } finally { server.close(); delete process.env.SAMPLE_PROJECTS; process.env.SAMPLE_PROJECTS = 'false'; }
  });

  test('/api/admin/funnel and .csv: 401 / 403 for non-operators, data for SYSTEM_ADMIN', async () => {
    const { db, server, client } = await boot();
    try {
      const A = await setup(client, 'pm2@x.com');
      assert.equal((await client()('GET', '/api/admin/funnel')).status, 401);
      assert.equal((await A.c('GET', '/api/admin/funnel')).status, 403);
      assert.equal((await A.c('GET', '/api/admin/funnel.csv')).status, 403);
      const op = client();
      await op('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email: 'op@x.com', password: 'passw0rd!' });
      await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = 'op@x.com'`);
      const r = await op('GET', `/api/admin/funnel?from=${todayKst()}&to=${todayKst()}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.signups, 1, 'the operator\'s own signup is excluded');
      assert.equal(r.json.steps.find((s) => s.key === 'project_created').count, 1);
      const csv = await op('GET', '/api/admin/funnel.csv', undefined, { raw: true });
      assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /relai-funnel-/);
      assert.ok(csv.buf.toString('utf8').includes('퍼널 단계'));
      assert.equal(addDays('2026-10-15', 1), '2026-10-16');
    } finally { server.close(); }
  });
});
