// Founder feedback part A (2026-10-15): login/signup value panel, promotion cards (관리자 › 프로모션, migration 47) on signup ·
// login · landing · 설정 › AI 크레딧 · Home, right-aligned auth actions, and the first-run guide that opens once after signup.
// Not part of `npm test` (needs a running server with samples on — SAMPLE_PROJECTS unset — and Playwright).
//   BASE=http://127.0.0.1:3361 SHOTS=/tmp/fbp DATABASE_URL=postgres://… node scripts/e2e-fb-public.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3361';
const SHOTS = process.env.SHOTS || 'fb-public-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (opts) => { const ctx = await browser.newContext({ locale: 'ko-KR', ...opts }); const p = await ctx.newPage(); p.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); }); return p; };
  const PC = { viewport: { width: 1440, height: 900 } }; const PHONE = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } };
  const page = await newPage(PC);
  const api = async (method, p, body, pg = page) => { const r = await pg.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const loaded = async (pg = page) => { await pg.waitForFunction(() => { const t = document.querySelector('#main')?.textContent || ''; return t.length > 100 && !/불러오는 중/.test(t); }, null, { timeout: 15000 }).catch(() => {}); await pg.waitForTimeout(600); };

  /* ---------- seed + public API ---------- */
  const pub = await api('GET', '/api/promotions?placement=signup');
  check('GET /api/promotions (no auth): 3 signup cards seeded (얼리 액세스 · AI 크레딧 · 이후 AI)', pub.status === 200 && pub.json.promotions.map((p) => p.badge).join() === '얼리 액세스,AI 크레딧,이후 AI', JSON.stringify(pub.json));
  check('unknown placement → empty list, not an error', (await api('GET', '/api/promotions?placement=nope')).json.promotions.length === 0);
  check('admin API refuses a visitor (401)', (await api('GET', '/api/admin/promotions')).status === 401);

  /* ---------- signup (PC 1440): value panel + pricing cards + right-aligned submit ---------- */
  await page.goto(`${BASE}/signup`); await page.waitForSelector('.sell [data-promos="signup"] .promo-card', { timeout: 8000 }).catch(() => {});
  const su = await page.evaluate(() => {
    const side = document.querySelector('.auth__side.sell'); const btn = document.querySelector('#f button[type=submit]'); const form = document.querySelector('#f');
    return { side: side && getComputedStyle(side).display !== 'none', h2: side?.querySelector('h2')?.textContent || '', benefits: side?.querySelectorAll('.sell__ben li').length || 0,
      shot: Boolean(side?.querySelector('.sell__shot .sell__steps')), trust: side?.querySelector('.sell__trust')?.textContent || '', cards: [...(side?.querySelectorAll('.promo-card') || [])].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
      btnRight: btn ? Math.round(form.getBoundingClientRect().right - btn.getBoundingClientRect().right) : -1, btnFull: btn ? btn.getBoundingClientRect().width >= form.getBoundingClientRect().width - 1 : true,
      sub: document.querySelector('.auth__form .sub')?.textContent || '', mobile: getComputedStyle(document.querySelector('.sell-m')).display };
  });
  check('signup panel: value headline + 3 benefits + product visual + trust line', su.side && /끝까지/.test(su.h2) && su.benefits === 3 && su.shot && /카드 등록 없이/.test(su.trust), JSON.stringify(su));
  check('signup pricing cards: 12개월 무료 · 500 크레딧 (₩5,000) · 1 크레딧 = ₩10', su.cards.length === 3 && /12개월/.test(su.cards[0]) && /500/.test(su.cards[1]) && /₩5,000/.test(su.cards[1]) && /1 크레딧 = ₩10/.test(su.cards[2]), JSON.stringify(su.cards));
  check('signup submit is right-aligned on PC (not full width)', su.btnRight <= 1 && !su.btnFull, JSON.stringify(su));
  check('offer text left the page copy (lives in the promo component)', !/AI 크레딧 500/.test(su.sub) && su.mobile === 'none', su.sub);
  await page.screenshot({ path: `${SHOTS}/signup-1440.png`, fullPage: true });

  /* ---------- login (PC): panel + login promo with a right-aligned link button ---------- */
  await page.goto(`${BASE}/login`); await page.waitForSelector('.sell [data-promos="login"] .promo-card', { timeout: 8000 }).catch(() => {});
  const li = await page.evaluate(() => { const c = document.querySelector('.sell [data-promos="login"] .promo-card'); const a = c?.querySelector('.promo-card__btn');
    return { text: c?.textContent || '', href: a?.getAttribute('href'), right: a ? Math.round(c.getBoundingClientRect().right - a.getBoundingClientRect().right) : -1, benefits: document.querySelectorAll('.sell .sell__ben li').length }; });
  check('login panel: 3 benefits + promo card linking to /signup, button at the right edge', li.benefits === 3 && /12개월 무료/.test(li.text) && li.href === '/signup' && li.right > 0 && li.right < 30, JSON.stringify(li));
  await page.screenshot({ path: `${SHOTS}/login-1440.png`, fullPage: true });

  /* ---------- phone 390: side panel folds under the form; full-width thumb button ---------- */
  const ph = await newPage(PHONE);
  await ph.goto(`${BASE}/signup`); await ph.waitForSelector('#f', { timeout: 8000 }).catch(() => {}); await ph.waitForTimeout(600);
  const pm = await ph.evaluate(() => ({ side: getComputedStyle(document.querySelector('.auth__side.sell')).display, m: getComputedStyle(document.querySelector('.sell-m')).display, cards: document.querySelectorAll('.sell-m .promo-card').length,
    over: document.documentElement.scrollWidth - window.innerWidth, btnW: document.querySelector('#f button[type=submit]').getBoundingClientRect().width }));
  check('phone 390 signup: side panel and the under-form value block folded away (layout-fit: one screen), no horizontal scroll', pm.side === 'none' && pm.m === 'none' && pm.over <= 0 && pm.btnW > 300, JSON.stringify(pm));
  await ph.screenshot({ path: `${SHOTS}/signup-390.png`, fullPage: true });
  await ph.goto(`${BASE}/login`); await ph.waitForSelector('#f', { timeout: 8000 }).catch(() => {}); await ph.waitForTimeout(600);
  await ph.screenshot({ path: `${SHOTS}/login-390.png`, fullPage: true });

  /* ---------- landing pricing: server-rendered cards ---------- */
  const land = await (await page.request.get(`${BASE}/`)).text();
  check('landing #early-access: 3 promo cards rendered by the server, no plain-text offer line', (land.match(/class="promo-card"/g) || []).length === 3 && /1 크레딧 = ₩10/.test(land) && !/pricing__offer/.test(land));

  /* ---------- first-run guide: real signup in the browser → tour opens once ---------- */
  const fresh = await newPage(PC);
  const email = `fbp-${Date.now()}@relai.test`;
  await fresh.goto(`${BASE}/signup`);
  await fresh.fill('#name', '정유진'); await fresh.fill('#email', email); await fresh.fill('#password', 'passw0rd!');
  await fresh.check('#agree-all'); await fresh.click('#f button[type=submit]');
  await fresh.waitForSelector('.tour__pop', { timeout: 10000 }).catch(() => {});
  const fr = await fresh.evaluate(() => ({ tour: Boolean(document.querySelector('.tour__pop')), title: document.querySelector('#tourT')?.textContent || '', url: location.pathname + location.search }));
  const wid = sql(`SELECT m.workspace_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email = '${email}'`);
  const samples = Number(sql(`SELECT COUNT(*) FROM projects WHERE workspace_id = '${wid}' AND sample_key IS NOT NULL`));
  check('first login after signup: the guide opens by itself (samples present)', fr.tour && samples === 3 && fr.url === '/app', JSON.stringify({ ...fr, samples }));
  await fresh.screenshot({ path: `${SHOTS}/firstrun-1440.png` });
  await fresh.click('.tour__x'); await fresh.waitForTimeout(600);
  const st = sql(`SELECT o.status FROM user_onboarding o JOIN users u ON u.id = o.user_id WHERE u.email = '${email}' AND onboarding_key = 'PRODUCT_TOUR'`);
  await fresh.goto(`${BASE}/app`); await loaded(fresh); await fresh.waitForTimeout(800);
  check('closed guide is not shown again on the next visit', ['SKIPPED', 'COMPLETED'].includes(st) && !(await fresh.$('.tour__pop')), st);
  await fresh.goto(`${BASE}/app?welcome=1`); await loaded(fresh); await fresh.waitForTimeout(800);
  check('?welcome=1 again does not reopen a guide that was already seen', !(await fresh.$('.tour__pop')));
  // an account made through the API (no browser signup) keeps the calm Home: no auto tour
  const apiUser = await newPage(PC);
  await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '박지후', email: `fbp-api-${Date.now()}@relai.test`, password: 'passw0rd!' }, apiUser);
  await apiUser.goto(`${BASE}/app`); await loaded(apiUser); await apiUser.waitForTimeout(800);
  check('plain /app visit (not right after signup): no auto tour', !(await apiUser.$('.tour')));

  /* ---------- admin 프로모션: create → shows on login → turn off → gone ---------- */
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN', email_verified_at = now() WHERE email = '${email}'`);
  await fresh.goto(`${BASE}/admin/promotions`); await fresh.waitForSelector('#promo-tbl', { timeout: 10000 }).catch(() => {});
  check('admin nav has 프로모션 and the 6 seeded rows are listed', /프로모션/.test(await fresh.textContent('.aside__nav')) && (await fresh.$$('#promo-tbl tbody tr[data-href]')).length === 6);
  await fresh.click('#p-new');
  await fresh.fill('#p-title', '추석 특별 혜택'); await fresh.fill('#p-body', '이번 주 가입하면 AI 크레딧 300 추가'); await fresh.fill('#p-badge', '이벤트');
  await fresh.check('[name=placements][value=login]'); await fresh.fill('#p-sort', '1');
  const pv = await fresh.textContent('#p-preview');
  await fresh.click('#p-save'); await fresh.waitForTimeout(800);
  check('admin: live preview + create', /추석 특별 혜택/.test(pv) && sql(`SELECT COUNT(*) FROM promotions WHERE title = '추석 특별 혜택'`) === '1');
  await fresh.screenshot({ path: `${SHOTS}/admin-promotions-1440.png`, fullPage: true });
  const bad = await api('POST', '/api/admin/promotions', { title: 'x', placements: ['nope'], link_url: 'javascript:alert(1)' }, fresh);
  check('admin API validates placements and link scheme (422)', bad.status === 422 && bad.json.error.fields.placements && bad.json.error.fields.link_url, JSON.stringify(bad.json));
  const lp = await newPage(PC);
  await lp.goto(`${BASE}/login`); await lp.waitForSelector('[data-promos="login"] .promo-card', { timeout: 8000 }).catch(() => {});
  check('new promo shows on /login, ordered first', /추석 특별 혜택/.test(await lp.textContent('[data-promos="login"] .promo-card').catch(() => '')));
  const id = sql(`SELECT id FROM promotions WHERE title = '추석 특별 혜택'`);
  await fresh.click(`#promo-tbl tr[data-href="#${id}"]`); await fresh.uncheck('[name=active]'); await fresh.click('#p-save'); await fresh.waitForTimeout(800);
  await lp.goto(`${BASE}/login`); await lp.waitForTimeout(1200);
  check('turned off → gone from /login', !/추석 특별 혜택/.test(await lp.textContent('.sell')));
  const future = await api('PATCH', `/api/admin/promotions/${id}`, { active: true, starts_on: '2099-01-01' }, fresh);
  check('scheduled (start date in the future) → not shown yet', future.status === 200 && !(await api('GET', '/api/promotions?placement=login')).json.promotions.some((p) => p.id === id));
  check('audit log records promotion edits', Number(sql(`SELECT COUNT(*) FROM admin_audit_logs WHERE target_type = 'PROMOTION' AND target_id = '${id}'`)) >= 3);
  const del = await api('DELETE', `/api/admin/promotions/${id}`, undefined, fresh);
  check('delete', del.status === 200 && sql(`SELECT COUNT(*) FROM promotions WHERE id = '${id}'`) === '0');

  /* ---------- in-app placements: 설정 › AI 크레딧 + Home ---------- */
  await fresh.goto(`${BASE}/app/settings/credits`); await loaded(fresh); await fresh.waitForSelector('.cr-promo .promo-card', { timeout: 8000 }).catch(() => {});
  const cr = await fresh.textContent('.cr-promo').catch(() => '');
  check('credits page: early-access promo card with this workspace\'s end date', /\d{4}\.\d{2}\.\d{2}까지 RELAI 전체 기능 무료/.test(cr) && !/\{until\}/.test(cr), cr);
  await fresh.screenshot({ path: `${SHOTS}/credits-1440.png` });
  await fresh.goto(`${BASE}/app`); await loaded(fresh); await fresh.waitForSelector('.home__promo .promo-line', { timeout: 8000 }).catch(() => {});
  const hl = await fresh.textContent('#home-credits').catch(() => '');
  check('Home: AI 크레딧 500 (₩5,000) 무료 제공 · 얼리 액세스 <date>까지 무료 (from the home promo)', /AI 크레딧 500 \(₩5,000\) 무료 제공/.test(hl) && /얼리 액세스 \d{4}\.\d{2}\.\d{2}까지 무료/.test(hl), hl);
  const phc = await newPage(PHONE); await phc.context().addCookies(await fresh.context().cookies());
  await phc.goto(`${BASE}/app/settings/credits`); await loaded(phc); await phc.waitForTimeout(600);
  await phc.screenshot({ path: `${SHOTS}/credits-390.png`, fullPage: true });
  await phc.goto(`${BASE}/admin/promotions`); await phc.waitForTimeout(1500);
  await phc.screenshot({ path: `${SHOTS}/admin-promotions-390.png`, fullPage: true });

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
