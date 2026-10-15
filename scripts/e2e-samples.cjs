// 샘플 프로젝트 (server/samples/) — signup → 3 samples on Home with the 샘플 badge → open each → C closes in one action →
// delete all from Home → 설정 › 샘플 프로젝트 추가 → delete from the project list. Shots at 1440 and 375 (Home + each sample).
// Not part of `npm test` (needs a running server with samples on — SAMPLE_PROJECTS unset — and Playwright).
//   BASE=http://127.0.0.1:3281 SHOTS=/tmp/samples DATABASE_URL=postgres://… node scripts/e2e-samples.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3281';
const SHOTS = process.env.SHOTS || 'sample-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const KEYS = { early: 'A-early', mid: 'B-mid', done: 'C-done' };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const settle = async (sel = '.page__head, .phead-wrap, .hsum, .hgrid') => { await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(500); };
  const loaded = async () => { await page.waitForFunction(() => { const t = document.querySelector('#main')?.textContent || ''; return t.length > 200 && !/불러오는 중/.test(t); }, null, { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(600); };
  const confirm = async () => { await page.waitForSelector('.scrim [data-v="1"]', { timeout: 5000 }); await page.click('.scrim [data-v="1"]'); await page.waitForTimeout(700); };

  /* ---------- signup → samples ---------- */
  const email = `samples-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const projects = (await api('GET', `/api/workspaces/${w}/projects`)).json.projects;
  const by = Object.fromEntries(projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p]));
  check('3 sample projects created at signup (early · mid · done)', Object.keys(by).sort().join() === 'done,early,mid', JSON.stringify(projects.map((p) => p.sample_key)));

  await page.goto(`${BASE}/app`); await settle('.hgrid');
  const home = await page.evaluate(() => ({ cards: document.querySelectorAll('.hgrid .hc').length, badges: document.querySelectorAll('.hgrid [data-sample-badge]').length,
    banner: document.querySelector('[data-sample-banner]')?.textContent || '', blueCards: document.querySelectorAll('.hgrid .btn--primary').length,
    newBtn: document.querySelector('[data-tour-id="create-project"]')?.className || '', sum: document.querySelector('[data-home-summary]')?.textContent || '' }));
  check('Home 1440: 3 cards, each with the 샘플 badge', home.cards === 3 && home.badges === 3, JSON.stringify(home));
  check('Home: 샘플 banner with 삭제 button', /샘플 프로젝트 3개/.test(home.banner) && Boolean(await page.$('[data-sample-banner] [data-samples-delete]')), home.banner);
  check('Home: the one blue button is + 새 프로젝트 (no sample card is blue)', home.blueCards === 0 && /btn--primary/.test(home.newBtn), JSON.stringify(home));
  check('Home summary speaks about real projects, not samples', /직접 만든 프로젝트가 없습니다/.test(home.sum), home.sum);
  await page.screenshot({ path: `${SHOTS}/home-1440.png`, fullPage: true });

  /* ---------- open each sample ---------- */
  for (const [key, p] of Object.entries(by)) {
    await page.goto(`${BASE}/app/projects/${p.id}`); await loaded();
    const v = await page.evaluate(() => ({ badge: Boolean(document.querySelector('[data-sample-badge]')), text: document.querySelector('#main')?.textContent || '' }));
    check(`${key}: project opens with the 샘플 badge and a 지금 할 일`, v.badge && v.text.length > 200 && !/undefined|NaN|SAMPLEOWNERNAME/.test(v.text), v.text.slice(0, 160));
    await page.screenshot({ path: `${SHOTS}/${KEYS[key]}-1440.png`, fullPage: true });
  }
  // B: WBS and 주간보고 have content
  await page.goto(`${BASE}/app/projects/${by.mid.id}/wbs`); await loaded();
  check('mid: WBS screen lists the sample tasks', /웨이브 피킹 개발/.test(await page.textContent('#main')));
  await page.screenshot({ path: `${SHOTS}/B-mid-wbs-1440.png` });
  await page.goto(`${BASE}/app/projects/${by.mid.id}/reports`); await loaded();
  check('mid: 3 weekly reports listed', ((await page.textContent('#main')).match(/확정/g) || []).length >= 3);

  /* ---------- 375 ---------- */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${BASE}/app`); await settle('.hgrid');
  const ph = await page.evaluate(() => ({ badges: document.querySelectorAll('[data-sample-badge]').length, wide: document.documentElement.scrollWidth }));
  check('Home 375: badges shown, no horizontal scroll', ph.badges === 3 && ph.wide <= 380, JSON.stringify(ph));
  await page.screenshot({ path: `${SHOTS}/home-375.png`, fullPage: true });
  for (const [key, p] of Object.entries(by)) {
    await page.goto(`${BASE}/app/projects/${p.id}`); await loaded();
    const b = await page.evaluate(() => ({ badge: Boolean(document.querySelector('[data-sample-badge]')), wide: document.documentElement.scrollWidth }));
    check(`${key} 375: badge in the header, no horizontal scroll`, b.badge && b.wide <= 380, JSON.stringify(b));
    await page.screenshot({ path: `${SHOTS}/${KEYS[key]}-375.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ---------- C: one action closes it ---------- */
  await page.goto(`${BASE}/app/projects/${by.done.id}`); await loaded();
  const cta = await page.$('a.btn--primary[href*="close=1"]');
  check('done: 지금 할 일 = 프로젝트 종료 (primary)', Boolean(cta));
  if (cta) { await cta.click(); await page.waitForSelector('[data-cl-ok]', { timeout: 8000 }).catch(() => {}); }
  await page.screenshot({ path: `${SHOTS}/C-done-close-dialog-1440.png` });
  const okBtn = await page.$('[data-cl-ok]:not([disabled])');
  check('done: close dialog ready (종료일 prefilled, button enabled)', Boolean(okBtn));
  if (okBtn) { await okBtn.click(); await page.waitForTimeout(1500); }
  check('done: project COMPLETED after the one action', sql(`SELECT status FROM projects WHERE id = '${by.done.id}'`) === 'COMPLETED');
  await page.goto(`${BASE}/app/projects/${by.done.id}`); await loaded();
  await page.screenshot({ path: `${SHOTS}/C-done-closed-1440.png`, fullPage: true });

  /* ---------- delete all from Home ---------- */
  await page.goto(`${BASE}/app`); await settle('.hgrid, .hero, [data-sample-banner]');
  await page.click('[data-sample-banner] [data-samples-delete]'); await confirm();
  await settle('.hero, .page__head');
  const after = await page.evaluate(() => ({ badges: document.querySelectorAll('[data-sample-badge]').length, banner: Boolean(document.querySelector('[data-sample-banner]')), hero: Boolean(document.querySelector('.hero')) }));
  check('Home 삭제: samples gone, first-project hero shown', after.badges === 0 && !after.banner && after.hero, JSON.stringify(after));
  check('DB: no sample rows left for the workspace', sql(`SELECT COUNT(*) FROM projects WHERE workspace_id = '${w}'`) === '0');

  /* ---------- 설정 › 샘플 프로젝트 추가 (demo account path) → delete from the project list ---------- */
  await page.goto(`${BASE}/app/settings?tab=me`); await settle('#samples');
  check('설정: 샘플 프로젝트 panel shows 0/3', /0\/3/.test(await page.textContent('#samples')));
  await page.click('#samples-add'); await page.waitForTimeout(1500);
  check('설정 추가: 3/3 and 삭제 button appears', /3\/3/.test(await page.textContent('#samples')) && Boolean(await page.$('#samples-delete')) && Boolean(await page.$('#samples-add[disabled]')));
  await page.screenshot({ path: `${SHOTS}/settings-samples-1440.png` });
  await page.goto(`${BASE}/app/projects`); await settle('.ptable');
  check('프로젝트 list: 3 badges + 샘플 프로젝트 삭제 button', (await page.$$('.ptable [data-sample-badge]')).length === 3 && Boolean(await page.$('[data-samples-delete]')));
  await page.screenshot({ path: `${SHOTS}/projects-list-1440.png` });
  // one sample from its ⋯ menu
  const mid = (await api('GET', `/api/workspaces/${w}/projects`)).json.projects.find((p) => p.sample_key === 'mid');
  await page.goto(`${BASE}/app/projects/${mid.id}`); await loaded();
  await page.click('.phead__more'); await page.click('[data-more="sample-delete"]'); await confirm();
  check('⋯ 샘플 프로젝트 삭제: one sample removed', sql(`SELECT COUNT(*) FROM projects WHERE workspace_id = '${w}'`) === '2');
  await page.goto(`${BASE}/app/projects`); await settle('.ptable');
  await page.click('[data-samples-delete]'); await confirm();
  check('프로젝트 list 삭제: all samples removed', sql(`SELECT COUNT(*) FROM projects WHERE workspace_id = '${w}'`) === '0');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
