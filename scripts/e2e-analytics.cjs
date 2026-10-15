// 사용 분석 (/admin/funnel, migration 46): landing visit → signup → sample open → own project → requirement → 02 stage →
// operator opens /admin/funnel and sees the counts, the biggest drop, top features, cohorts and the CSV export. Shot at 1440.
// Not part of `npm test` (needs a running server + Playwright). Samples on (SAMPLE_PROJECTS unset).
//   BASE=http://127.0.0.1:3291 SHOTS=/tmp/analytics DATABASE_URL=postgres://… SESSION_SECRET=<server's> node scripts/e2e-analytics.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3291';
const SHOTS = process.env.SHOTS || 'analytics-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';   // headless UA counts as a bot

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newCtx = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', userAgent: UA }); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); return { ctx, page }; };
  const apiOf = (page) => async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const visitsBefore = Number(sql(`SELECT COUNT(*) FROM analytics_events WHERE name = 'landing_visit'`));

  /* ---------- a new visitor: landing → signup → sample → own project → requirement → 02 ---------- */
  const { ctx: u, page } = await newCtx(); const api = apiOf(page);
  await page.goto(`${BASE}/`); await page.waitForLoadState('domcontentloaded');
  check('landing visit counted (anonymous, no user id)', Number(sql(`SELECT COUNT(*) FROM analytics_events WHERE name = 'landing_visit' AND user_id IS NULL`)) === visitsBefore + 1);
  const email = `funnel-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '박지민', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const uid = s.json.user.id; const w = s.json.workspaces[0].id;
  // e-mail verification through the real link (dev e-mail is fake): store a token the way the server does, then open /verify-email
  const token = require('crypto').randomBytes(24).toString('base64url');
  const hash = require('crypto').createHash('sha256').update(`EMAIL_VERIFY:${process.env.SESSION_SECRET || ''}:${token}`).digest('hex');
  sql(`UPDATE auth_tokens SET used_at = now() WHERE user_id = '${uid}' AND purpose = 'EMAIL_VERIFY' AND used_at IS NULL`);
  sql(`INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email, expires_at) VALUES (gen_random_uuid()::text, '${uid}', 'EMAIL_VERIFY', '${hash}', '${email}', now() + interval '1 hour')`);
  await page.goto(`${BASE}/verify-email?token=${token}`); await page.waitForTimeout(1500);
  check('email verified via link → email_verified event', Number(sql(`SELECT COUNT(*) FROM analytics_events WHERE user_id = '${uid}' AND name = 'email_verified'`)) === 1);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const sample = (await api('GET', `/api/workspaces/${w}/projects`)).json.projects.find((p) => p.sample_key);
  await page.goto(`${BASE}/app/projects/${sample.id}`); await page.waitForTimeout(1500);
  const proj = await api('POST', `/api/workspaces/${w}/projects`, { name: '분석 테스트 프로젝트', client_name: '고객사', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' });
  check('own project created', proj.status === 201, JSON.stringify(proj.json));
  const purl = `/api/workspaces/${w}/projects/${proj.json.project.id}`;
  await api('POST', `${purl}/requirements`, { title: '회원 로그인', description: '이메일 로그인' });
  const g = (await api('GET', purl)).json; const phases = g.guide?.phases || g.phases;
  await api('POST', `${purl}/phases/${phases.find((p) => p.phase_key === 'REQUIREMENTS').id}/activate`, { reason: 'MANUAL' });
  await page.goto(`${BASE}/app/projects/${proj.json.project.id}/requirements`); await page.waitForTimeout(1200);
  const ev = (name, extra = '') => Number(sql(`SELECT COUNT(*) FROM analytics_events WHERE user_id = '${uid}' AND name = '${name}' ${extra}`));
  check('events: signup, sample_opened, project_created, stage 01+02, first_requirement (once each)',
    ev('signup') === 1 && ev('sample_opened') === 1 && ev('project_created') === 1 && ev('stage_reached') === 2 && ev('first_requirement') === 1,
    sql(`SELECT string_agg(name || coalesce(':' || key, ''), ', ') FROM analytics_events WHERE user_id = '${uid}' AND name NOT IN ('feature','screen')`));
  check('screen views recorded with normalised paths', ev('screen', `AND key = '/app/projects/:id/requirements'`) >= 1 && ev('screen', `AND key = '/app/projects/:id' AND sample`) >= 1,
    sql(`SELECT string_agg(key || CASE WHEN sample THEN '(s)' ELSE '' END, ', ') FROM analytics_events WHERE user_id = '${uid}' AND name = 'screen'`));
  check('active today recorded', Number(sql(`SELECT COUNT(*) FROM analytics_active_days WHERE user_id = '${uid}'`)) === 1);
  check('no personal data in events (no e-mail / name text anywhere)', Number(sql(`SELECT COUNT(*) FROM analytics_events WHERE key ILIKE '%relai.test%' OR key LIKE '%박지민%'`)) === 0);
  await u.close();

  /* ---------- non-operator is refused ---------- */
  const { ctx: m, page: mp } = await newCtx(); const mapi = apiOf(mp);
  await mapi('POST', '/api/auth/login', { email, password: 'passw0rd!' });
  check('/api/admin/funnel → 403 for a normal user', (await mapi('GET', '/api/admin/funnel')).status === 403);
  await m.close();

  /* ---------- operator: /admin/funnel ---------- */
  const { ctx: o, page: op } = await newCtx(); const oapi = apiOf(op);
  const oemail = `op-${Date.now()}@relai.test`;
  await oapi('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email: oemail, password: 'passw0rd!' });
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = '${oemail}'`);
  await op.goto(`${BASE}/admin/funnel`);
  await op.waitForSelector('[data-funnel]', { timeout: 15000 });
  const v = await op.evaluate(() => {
    const c = (k) => Number((document.querySelector(`[data-step="${k}"] [data-count]`)?.textContent || '').replace(/,/g, ''));
    return { landing: c('landing_visit'), signup: c('signup'), project: c('project_created'), stage02: c('stage_02'), drop: document.querySelector('[data-biggest-drop]')?.closest('[data-step]')?.dataset.step || '',
      features: document.querySelectorAll('#features tbody tr').length, featText: document.querySelector('#features')?.textContent || '', cohorts: document.querySelectorAll('#cohorts tbody tr').length,
      firstUse: document.querySelector('#firstuse')?.textContent || '', nav: document.querySelector('[data-anav="/admin/funnel"]')?.classList.contains('is-active'), csv: document.querySelector('[data-csv]')?.getAttribute('href') || '', h1: document.querySelector('.ahead h1')?.textContent };
  });
  const api2 = (await oapi('GET', '/api/admin/funnel')).json;
  check('page title 사용 분석, nav item active', v.h1 === '사용 분석' && v.nav, JSON.stringify(v));
  check('funnel shows counts (landing ≥1, signup ≥1, project ≥1, 02 ≥1) and matches the API', v.landing >= 1 && v.signup >= 1 && v.project >= 1 && v.stage02 >= 1 && v.signup === api2.signups, JSON.stringify(v));
  check('operator signup not counted', api2.signups === Number(sql(`SELECT COUNT(DISTINCT e.user_id) FROM analytics_events e JOIN users u ON u.id = e.user_id WHERE e.name = 'signup' AND u.system_role <> 'SYSTEM_ADMIN' AND e.created_at >= (current_date - 29)::timestamp AT TIME ZONE 'Asia/Seoul'`)), String(api2.signups));
  check('biggest drop-off highlighted', Boolean(v.drop) && v.drop === api2.biggest_drop?.key, `${v.drop} vs ${api2.biggest_drop?.key}`);
  check('top features listed in Korean (요구사항 등록, 프로젝트 만들기)', v.features >= 2 && /요구사항 등록/.test(v.featText) && /프로젝트 만들기/.test(v.featText), v.featText.slice(0, 200));
  check('first-use table + cohort row', /첫 요구사항 등록/.test(v.firstUse) && v.cohorts >= 1, `${v.cohorts}`);
  await op.screenshot({ path: `${SHOTS}/admin-funnel-1440.png`, fullPage: true });

  // date range filter: a past window with no data
  await op.fill('[data-from]', '2025-01-01'); await op.dispatchEvent('[data-from]', 'change'); await op.waitForTimeout(800);   // > 1 year → 종료일 follows (30 days)
  await op.fill('[data-to]', '2025-01-31'); await op.dispatchEvent('[data-to]', 'change'); await op.waitForTimeout(800);
  const empty = await op.evaluate(() => ({ url: location.search, signup: document.querySelector('[data-step="signup"] [data-count]')?.textContent, text: document.querySelector('.aempty')?.textContent || '' }));
  check('date filter → URL keeps range, empty window shows 0 + note', /from=2025-01-01/.test(empty.url) && /to=2025-01-31/.test(empty.url) && empty.signup === '0' && /배포한 날부터/.test(empty.text), JSON.stringify(empty));
  await op.click('[data-preset="30"]'); await op.waitForTimeout(800);

  // CSV export
  const [dl] = await Promise.all([op.waitForEvent('download'), op.click('[data-csv]')]);
  const file = `${SHOTS}/${dl.suggestedFilename()}`; await dl.saveAs(file);
  const csv = fs.readFileSync(file, 'utf8');
  check('CSV downloads with funnel, features, cohorts', /^﻿?RELAI 사용 분석/.test(csv) && /퍼널 단계/.test(csv) && /가입 주/.test(csv) && /요구사항 등록/.test(csv), dl.suggestedFilename());

  // phone width: still readable, no horizontal scroll
  await op.setViewportSize({ width: 375, height: 800 }); await op.reload(); await op.waitForTimeout(1200);
  check('375: no horizontal scroll', await op.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await o.close();

  /* ---------- privacy text ---------- */
  const { ctx: pv, page: pp } = await newCtx();
  await pp.goto(`${BASE}/privacy`);
  check('privacy page says usage is analysed first-party', /서비스 개선을 위한 이용 분석/.test(await pp.textContent('main')));
  await pv.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
