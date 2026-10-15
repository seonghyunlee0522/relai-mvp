// v1 fix batch (Jim v1 final sign-off) — UI checks: P1-1 every 06 checklist row has a checkbox that saves and clears the warnings ·
// P2-1 sample feed says 샘플 · P2-2 sample A 요구사항 확정 tile = the in-scope row · P2-3 Home with only a closed own project ·
// P2-6 phone card says 지연 like desktop. API-level checks live in server/test/v1-fixes.test.js.
// Not part of `npm test` (needs a running server with samples on — SAMPLE_PROJECTS unset — and Playwright).
//   BASE=http://127.0.0.1:3311 SHOTS=/tmp/v1fixes DATABASE_URL=postgres://… node scripts/e2e-v1fixes.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3311';
const SHOTS = process.env.SHOTS || 'v1fixes-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const loaded = async (sel = '#main') => { await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForFunction(() => { const t = document.querySelector('#main')?.textContent || ''; return t.length > 100 && !/불러오는 중/.test(t); }, null, { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(500); };

  const email = `v1fix-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '최종검', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const by = Object.fromEntries((await api('GET', `/api/workspaces/${w}/projects`)).json.projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p]));
  check('3 samples', Object.keys(by).length === 3, JSON.stringify(Object.keys(by)));

  /* ---------- P2-1: the sample feed is not the new user's ---------- */
  await page.goto(`${BASE}/app`); await loaded('.hgrid');
  const feed = await page.$$eval('[data-home-activity] .nxact small', (els) => els.map((e) => e.textContent));
  check('P2-1 Home 최근 활동: sample events say 샘플, never the new user', feed.length > 0 && feed.every((t) => /샘플/.test(t) && !/최종검/.test(t)), JSON.stringify(feed));
  const banner = await page.textContent('[data-sample-banner]');
  check('P2-3 sample intro has no stage words that can go stale', !/종료 직전/.test(banner), banner);

  /* ---------- P2-2: sample A KPI = in-scope row ---------- */
  const reqA = (await api('GET', `/api/workspaces/${w}/projects/${by.early.id}`)).json.requirements;
  await page.goto(`${BASE}/app/projects/${by.early.id}`); await loaded('[data-tiles]');
  const kpi = (await page.textContent('[data-tile="metric"] .nxt__v')).replace(/\s+/g, ' ').trim();
  const row = await page.textContent('#main');
  const m = row.match(/범위 내 (\d+)건 중 (\d+)건이 확정/);
  check('P2-2 sample A 요구사항 확정 tile = in-scope count', kpi === `${reqA.in_scope_confirmed} / ${reqA.in_scope}` && Number(reqA.total) !== Number(reqA.in_scope), `${kpi} vs ${JSON.stringify(reqA)}`);
  check('P2-2 tile and the activity row agree', !m || kpi === `${m[2]} / ${m[1]}`, `${kpi} vs ${m && m[0]}`);
  await page.screenshot({ path: `${SHOTS}/p22-sampleA-kpi.png` });

  /* ---------- P1-1: own project, 06 checklists ---------- */
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: '태광식품 MES 구축', client_name: '태광식품', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28', data_migration: 'YES' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`;
  const stepOf = async (key) => (await api('GET', pa)).json.phases.flatMap((ph) => ph.steps).find((x) => x.step_key === key);
  for (const key of ['CUTOVER_PLAN', 'DATA_MIGRATION', 'TRAINING']) {
    await page.goto(`${BASE}${U}/checklist?activity=${key}`); await loaded('.clk__card');
    if (!(await page.$(`[data-tab="${key}"].is-active, .clk__tab.is-active[data-tab="${key}"]`))) { check(`P1-1 ${key}: checklist page opens`, false); continue; }
    await page.click('[data-defaults]'); await page.waitForSelector('.clk__tbl [data-item]', { timeout: 8000 }); await page.waitForTimeout(400);
    const rows = await page.$$eval('.clk__tbl tbody tr', (trs) => trs.map((tr) => ({ ck: Boolean(tr.querySelector('input[type=checkbox][data-f=done][aria-label="완료"]')), dec: Boolean(tr.querySelector('[aria-label="결정일"]')) })));
    check(`P1-1 ${key}: every row (${rows.length}) has a 완료 checkbox and none is a decision row`, rows.length >= 4 && rows.every((r) => r.ck && !r.dec), JSON.stringify(rows));
    // tick item 2 → saved
    await page.locator('.clk__tbl tbody tr').nth(1).locator('input[data-f=done]').check(); await page.waitForTimeout(800);
    await page.reload(); await loaded('.clk__tbl');
    const second = await page.locator('.clk__tbl tbody tr').nth(1).locator('input[data-f=done]').isChecked();
    check(`P1-1 ${key}: item 2 stays ticked after reload`, second);
    if (key === 'CUTOVER_PLAN') await page.screenshot({ path: `${SHOTS}/p11-cutover-item2.png` });
    // tick the rest → the activity completes on its own, no 완료 처리 warning left
    for (let i = 0, n = await page.locator('.clk__tbl tbody tr').count(); i < n; i++) {
      const box = page.locator('.clk__tbl tbody tr').nth(i).locator('input[data-f=done]');
      if (!(await box.isChecked())) { await box.check(); await page.waitForTimeout(700); }
    }
    const st = await stepOf(key);
    const cnt = await page.textContent('.clk__cnt');
    check(`P1-1 ${key}: all ticked → 완료 (no 완료 처리 needed)`, st.state === 'COMPLETED' && !(await page.$('[data-mark="COMPLETED"]')) && /(\d+)\/\1 완료/.test(cnt), `${st.state} ${cnt}`);
  }
  const gl = (await api('GET', `${pa}/go-live`)).json;
  const left = Number(sql(`SELECT COUNT(*) FROM activity_checklist_items WHERE project_id = '${P.id}' AND NOT done`));
  check('P1-1 go-live: checklist warning counts only items not ticked', gl.checklist_open === left && left === 0, `${gl.checklist_open} vs ${left}`);

  /* ---------- P2-3: own project closed → Home does not say "아직 직접 만든 프로젝트가 없습니다" ---------- */
  sql(`UPDATE projects SET status = 'COMPLETED', closed_on = '${today}' WHERE id = '${P.id}'`);
  await page.goto(`${BASE}/app`); await loaded('.hgrid');
  const sum = await page.textContent('[data-home-summary]');
  check('P2-3 Home: closed own project → "진행 중인 직접 만든 프로젝트가 없습니다"', /진행 중인 직접 만든 프로젝트가 없습니다/.test(sum) && !/아직 직접 만든/.test(sum), sum);
  await page.screenshot({ path: `${SHOTS}/p23-home-closed-own.png`, fullPage: true });

  /* ---------- P2-6: phone card label = desktop (지연) ---------- */
  await page.waitForSelector('.hgrid .hc__prio', { timeout: 8000 }).catch(() => {});
  const deskLabels = await page.$$eval('.hgrid .hc__prio', (els) => els.map((e) => e.textContent.trim()));
  const state = await ctx.storageState();
  const m390 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', storageState: state, isMobile: true, hasTouch: true });
  const mp = await m390.newPage();
  await mp.goto(`${BASE}/app`); await mp.waitForSelector('.hgrid', { timeout: 10000 }); await mp.waitForTimeout(800);
  const phone = await mp.evaluate(() => ({ labels: [...document.querySelectorAll('.hgrid .hc__prio')].map((e) => e.textContent.trim()), text: document.querySelector('#main').textContent }));
  check('P2-6 desktop shows 지연 for the late sample', deskLabels.includes('지연'), JSON.stringify(deskLabels));
  check('P2-6 phone shows 지연 too, never 막힘', phone.labels.includes('지연') && !/막힘/.test(phone.text), JSON.stringify(phone.labels));
  await mp.screenshot({ path: `${SHOTS}/p26-phone-home.png`, fullPage: true });
  await m390.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
