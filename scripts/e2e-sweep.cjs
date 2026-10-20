// Jim's button sweep (batch3) — B1 admin 대시보드 'Free 플랜 한도 90% 이상' rows open the workspace · B2 개요 활동 기록 '전체 보기'
// (and the rail 활동 기록) open the activity panel · B3 요구사항 tabs = 목록 · 연결 현황 (batch7 #13); ?view=classify opens the 목록 unfiltered when everything is classified
// (지금 할 일 keeps the 미지정 filter) · B4 간트 '+ 작업 추가' opens the add-task input.
// Not part of `npm test` (needs a running server and Playwright). Samples may be on or off.
//   BASE=http://127.0.0.1:3381 SHOTS=/tmp/sweep DATABASE_URL=postgres://… node scripts/e2e-sweep.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3381';
const SHOTS = process.env.SHOTS || 'sweep-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const loaded = async (sel = '#main') => { await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForFunction(() => { const t = document.querySelector('#main')?.textContent || ''; return t.length > 100 && !/불러오는 중/.test(t); }, null, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(300); };

  const email = `sweep-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '버튼검', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: '새솔유통 물류 시스템', client_name: '새솔유통', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`;
  for (const [t, type, priority] of [['입고 등록', 'FUNCTIONAL', 'HIGH'], ['재고 조회', 'FUNCTIONAL', 'MEDIUM'], ['응답 3초 이내', 'NON_FUNCTIONAL', 'LOW']]) await api('POST', `${pa}/requirements`, { title: t, type, priority, scope: 'IN_SCOPE' });
  for (const t of ['입고 화면 개발', '재고 API 개발']) await api('POST', `${pa}/wbs`, { title: t, planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' });
  const unspec = Number(sql(`SELECT COUNT(*) FROM requirements WHERE project_id = '${P.id}' AND type = 'UNSPECIFIED'`));
  check('setup: 3 requirements, all with a type', unspec === 0 && Number(sql(`SELECT COUNT(*) FROM requirements WHERE project_id = '${P.id}'`)) === 3, `unspecified ${unspec}`);

  /* ---------- B3 → batch7 #13: 분류·우선순위 is no longer a tab; ?view=classify opens the 목록 unfiltered when everything is classified ---------- */
  await page.goto(`${BASE}${U}/requirements`); await loaded('#grid');
  const tabs = await page.$$eval('.stabs [data-stab]', (els) => els.map((e) => e.dataset.stab));
  check('B3 요구사항 tabs are 목록 · 연결 현황 (no 분류·우선순위)', JSON.stringify(tabs) === JSON.stringify(['requirements', 'req-trace']), JSON.stringify(tabs));
  await page.goto(`${BASE}${U}/requirements?view=classify`); await loaded('#grid'); await page.waitForTimeout(500);
  const body = await page.textContent('#main');
  check('B3 ?view=classify shows all 3 requirements (no 조건에 맞는 … 없습니다)', ['입고 등록', '재고 조회', '응답 3초 이내'].every((t) => body.includes(t)) && !/조건에 맞는/.test(body), page.url());
  const cols = await page.$$eval('#grid th, #grid [role=columnheader]', (ths) => ths.map((t) => t.textContent.trim()));
  check('B3 ?view=classify shows 유형 + 우선순위 columns on the 목록 tab', cols.some((c) => c.includes('유형')) && cols.some((c) => c.includes('우선순위')) && /view=classify/.test(page.url()) && (await page.getAttribute('.stabs [aria-current="page"]', 'data-stab').catch(() => '')) === 'requirements', JSON.stringify(cols));
  await page.screenshot({ path: `${SHOTS}/b3-classify-tab.png` });
  await page.goto(`${BASE}${U}/requirements?type=UNSPECIFIED`); await loaded('#grid');
  const empty = await page.textContent('#main');
  check('B3 the 미지정 filter (지금 할 일 link) still filters, particle is 요구사항이', /조건에 맞는 요구사항이 없습니다/.test(empty), (empty.match(/조건에 맞는[^.]*/) || [''])[0]);

  /* ---------- B4: 간트 + 작업 추가 ---------- */
  await page.goto(`${BASE}${U}/wbs?view=gantt`); await loaded('.gantt');
  await page.click('#add'); await page.waitForTimeout(800);
  const ghost = await page.$('[data-ghost]');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-ghost'));
  check('B4 간트 + 작업 추가 → 작업 목록 with the add-task input open and focused', Boolean(ghost) && focused && !/view=gantt/.test(page.url()), `${Boolean(ghost)} ${focused} ${page.url()}`);
  await page.screenshot({ path: `${SHOTS}/b4-gantt-add.png` });

  /* ---------- B2: 활동 기록 전체 보기 ---------- */
  for (const [label, url] of [['개요', `${U}/overview`], ['건강도', `${U}/overview#health`]]) {
    await page.goto(`${BASE}${url}`); await loaded('#act-all');
    await page.click('#act-all'); await page.waitForSelector('.actpage', { timeout: 5000 }).catch(() => {});
    check(`B2 ${label} 활동 기록 전체 보기 opens the 활동 기록 page (batch7 #22)`, Boolean(await page.$('.actpage')) && /\/activity$/.test(new URL(page.url()).pathname) && !(await page.$('.actpanel')));
    if (label === '개요') await page.screenshot({ path: `${SHOTS}/b2-activity.png` });
  }
  const rail = await page.$('[data-lnb-action="activity"]');
  if (rail) { await rail.click(); await page.waitForSelector('.actpage', { timeout: 5000 }).catch(() => {}); check('B2 rail 활동 기록 opens the 활동 기록 page', Boolean(await page.$('.actpage'))); }

  /* ---------- B1: admin 대시보드 near-limit rows ---------- */
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = '${email}'`);
  sql(`UPDATE workspaces SET early_access_until = NULL WHERE id = '${w}'`);   // since admin-fix 7b5b1d2 an early-access workspace reads EARLY, not Free
  await page.goto(`${BASE}/admin`); await loaded('.apage');
  const near = page.locator('.aattn', { hasText: 'Free 플랜 한도 90% 이상' });
  const hrefs = await near.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  check('B1 near-limit list has rows and none links to undefined', hrefs.length > 0 && hrefs.every((h) => /^\/admin\/workspaces\/[\w-]+$/.test(h) && !/undefined/.test(h)), JSON.stringify(hrefs));
  const mine = near.locator(`a[href="/admin/workspaces/${w}"]`);
  check('B1 own Free workspace (1/1 projects) is listed', (await mine.count()) === 1);
  if (await mine.count()) {
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().includes(`/api/admin/workspaces/${w}`)), mine.click()]);
    await loaded('.apage');
    check('B1 row opens that workspace admin page', resp.status() === 200 && !/찾을 수 없습니다/.test(await page.textContent('#main')), `${resp.status()} ${page.url()}`);
    await page.screenshot({ path: `${SHOTS}/b1-admin-ws.png` });
  }

  check('no page errors', errors.length === 0, JSON.stringify(errors));
  await browser.close();
  const fail = results.filter(([, ok]) => !ok).length;
  log(`${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
