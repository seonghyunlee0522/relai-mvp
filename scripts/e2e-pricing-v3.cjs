// Pricing v3 T4 browser check: landing #pricing (월간 default → 연간 toggle shows the annual card amount + 월 환산 + 할인), the plans page
// (current plan badge, Pro/Team buttons = 정기결제 준비 중 while recurring is not approved, no checkout call), 설정 › 요금제 (Billing view on the live T1 shape: Free,
// usage, credits total, Pro upgrade instead of 충전), and /app/settings/billing against the v3 fixture (server/test/fixtures/billing-v3.json:
// T2 credit buckets + T3 scheduled changes filled in, merged over the live response), the operator console (dashboard MRR, workspace 요금 · 한도,
// subscriptions list) — desktop 1440 and phone 390, no horizontal scroll.
// Not part of `npm test` (needs a running server, Playwright and psql):
//   BASE=http://127.0.0.1:3597 SHOTS=…/relai-pricing-v3/shots DATABASE_URL=postgres://… node scripts/e2e-pricing-v3.cjs
//   server: PAYMENTS_ENABLED unset (off), BILLING_PROVIDER=fake, SAMPLE_PROJECTS=false, AI_PROVIDER=fake
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3597';
const SHOTS = process.env.SHOTS || 'pricing-v3-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const esc = (s) => String(s).replace(/'/g, "''");
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/test/fixtures/billing-v3.json'), 'utf8')).billing;
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const ORDERS = [
  { id: 'o3', kind: 'ADDON', kind_label: '추가 이용', title: '추가 사용자 2명', amount: 774, refunded_amount: 0, status: 'PAID', status_label: '결제 완료', created_at: '2026-10-20T03:00:00Z', paid_at: '2026-10-20T03:00:00Z' },
  { id: 'o2', kind: 'CREDIT_TOPUP', kind_label: 'AI 크레딧 충전', title: 'AI 크레딧 2,000', amount: 20000, refunded_amount: 0, status: 'PAID', status_label: '결제 완료', created_at: '2026-10-12T03:00:00Z', paid_at: '2026-10-12T03:00:00Z', receipt_url: 'https://example.invalid/r/2' },
  { id: 'o1', kind: 'ONE_TIME', kind_label: '요금제 결제', title: 'Pro 월간', amount: 30000, refunded_amount: 0, status: 'PAID', status_label: '결제 완료', created_at: '2026-09-20T03:00:00Z', paid_at: '2026-09-20T03:00:00Z' },
];

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (viewport, opts = {}) => { const ctx = await browser.newContext({ viewport, locale: 'ko-KR', ...opts }); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); return { ctx, page }; };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const vis = (page, sel) => page.isVisible(sel).catch(() => false);
  /** Whole-page shot without fullPage: the app re-renders on resize, so grow the viewport first, let it settle, then shoot. */
  const tallShot = async (page, file) => {
    const vp = page.viewportSize(); const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.min(4000, Math.max(vp.height, h)) }); await page.waitForTimeout(900);
    const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h2 > h) { await page.setViewportSize({ width: vp.width, height: Math.min(4000, h2) }); await page.waitForTimeout(900); }
    await page.screenshot({ path: path.join(SHOTS, file) }); await page.setViewportSize(vp); await page.waitForTimeout(400);
  };

  // ---- landing (desktop + phone) ----
  for (const [tag, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
    const { ctx, page } = await mk(vp, mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});
    await page.goto(BASE + '/#pricing'); await page.waitForSelector('#plan-cards .pcw');
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('is-in')));
    const pro = '#plan-cards [data-plan="PRO"]';
    check(`landing ${tag}: 월간 default, Pro 30,000원 /월 visible, annual hidden`, (await page.getAttribute('#plan-cards .pcw', 'data-cycle')) === 'MONTHLY'
      && /30,000원\s*\/월/.test(await page.textContent(`${pro} .pc-m .pc__p`)) && !(await vis(page, `${pro} .pc-a .pc__p`)));
    await page.locator('#pricing').scrollIntoViewIfNeeded(); await page.evaluate(() => document.getElementById('pricing').scrollIntoView());
    await page.screenshot({ path: path.join(SHOTS, `landing-pricing-monthly-${tag}.png`), fullPage: false });
    if (!mobile) await page.locator('#pricing').screenshot({ path: path.join(SHOTS, `landing-pricing-section-monthly-${tag}.png`) });
    await page.click('#plan-cards [data-cycle-set="ANNUAL"]');
    const a = await page.textContent(`${pro} .pc-a`);
    check(`landing ${tag}: 연간 → 연 288,000원 결제 + 월 24,000원 환산 + 72,000원 할인(20%)`, /연 288,000원/.test(a) && /월 24,000원 환산/.test(a) && /72,000원 할인\(20%\)/.test(a) && !(await vis(page, `${pro} .pc-m .pc__p`)));
    const sizes = await page.evaluate((p) => { const e = document.querySelector(`${p} .pc-a .pc__p`); const q = document.querySelector(`${p} .pc-a .pc__s--eq`); return [parseFloat(getComputedStyle(e).fontSize), parseFloat(getComputedStyle(q).fontSize)]; }, pro);
    check(`landing ${tag}: annual charge at least as large as the monthly equivalent (§21의2)`, sizes[0] >= sizes[1], JSON.stringify(sizes));
    const team = await page.textContent('#plan-cards [data-plan="TEAM"]');
    check(`landing ${tag}: Team 연 768,000원 · 월 64,000원 · 10개 · 40명 · 매월 3,000`, /연 768,000원/.test(team) && /월 64,000원 환산/.test(team) && /10개/.test(team) && /40명/.test(team) && /매월 3,000 크레딧/.test(team));
    const free = await page.textContent('#plan-cards [data-plan="FREE"]');
    check(`landing ${tag}: Free 1개 · 3명 · 최초 100 · 충전 불가`, /1개/.test(free) && /3명/.test(free) && /최초 100 크레딧/.test(free) && /불가/.test(free));
    check(`landing ${tag}: Enterprise 별도 견적 + 도입 문의`, /별도 견적/.test(await page.textContent('#plan-cards [data-plan="ENTERPRISE"]')) && Boolean(await page.$('#plan-cards [data-loc="pricing_enterprise"][href^="mailto:"]')));
    check(`landing ${tag}: VAT 포함 note + AI credits block in credits only`, /VAT 10%\) 포함/.test(await page.textContent('#plan-cards .pc-note')) && !/₩|\d원/.test(await page.textContent('#ai-credits')));
    check(`landing ${tag}: Pro/Team buy buttons = 정기결제 준비 중 (recurring not approved), Free = 무료로 시작하기`, /정기결제 준비 중/.test(await page.textContent('#plan-cards [data-plan-soon="PRO"]')) && /정기결제 준비 중/.test(await page.textContent('#plan-cards [data-plan-soon="TEAM"]')) && !(await page.$('#plan-cards [data-loc="pricing_pro"]')) && Boolean(await page.$('#plan-cards [data-loc="pricing_free"]')));
    check(`landing ${tag}: no horizontal scroll`, await noHScroll(page));
    await page.evaluate(() => document.getElementById('pricing').scrollIntoView());
    await page.screenshot({ path: path.join(SHOTS, `landing-pricing-annual-${tag}.png`) });
    if (!mobile) await page.locator('#pricing').screenshot({ path: path.join(SHOTS, `landing-pricing-section-annual-${tag}.png`) });
    else await page.locator('#plan-cards [data-plan="PRO"]').screenshot({ path: path.join(SHOTS, 'landing-pricing-pro-card-mobile.png') });
    await ctx.close();
  }

  // ---- signed-in screens ----
  const email = `v3t4-${Date.now()}@relai.test`;
  const { ctx, page } = await mk({ width: 1440, height: 900 });
  const calls = []; page.on('request', (r) => { if (/\/billing\/(checkout|recurring)|\/credits\/checkout/.test(r.url())) calls.push(r.url()); });
  await page.goto(BASE + '/login');
  const s = await page.request.post(BASE + '/api/auth/signup', { data: { agree_terms: true, agree_privacy: true, name: '요금테스트', email, password: 'passw0rd!' } });
  const w = (await s.json()).workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${esc(email)}'`);
  await page.request.post(`${BASE}/api/workspaces/${w}/onboarding/product_tour/skip`, { data: {} });

  await page.goto(BASE + '/app/billing/plans'); await page.waitForSelector('#plans-page .pcw');
  check('plans: 4 cards, Free = 현재 플랜, 월간 default', (await page.$$('#plans-page .pc')).length === 4 && /현재 플랜/.test(await page.textContent('#plans-page [data-plan="FREE"]')) && (await page.getAttribute('#plans-page .pcw', 'data-cycle')) === 'MONTHLY');
  await page.click('#plans-page [data-cycle-set="ANNUAL"]');
  check('plans: 연간 toggle → 연 288,000원', /연 288,000원/.test(await page.textContent('#plans-page [data-plan="PRO"] .pc-a')));
  await tallShot(page, 'app-plans-annual-desktop.png');
  check('plans: Pro/Team = 정기결제 준비 중, not clickable, no 선택 link, no checkout call', /정기결제 준비 중/.test(await page.textContent('#plans-page [data-plan-soon="PRO"]')) && Boolean(await page.$('#plans-page [data-plan-soon="TEAM"]')) && !(await page.$('#plans-page a[data-plan-cta="PRO"]')) && calls.length === 0);
  check('plans FAQ: 해지 any time, 30일 조회·내보내기, 일할 환불, no 월간 정상가', /30일 동안 모든 프로젝트/.test(await page.textContent('#pl-faq')) && /일할 계산/.test(await page.textContent('#pl-faq')) && !/월간 정상가/.test(await page.textContent('#pl-faq')));

  await page.goto(BASE + '/app/settings?tab=plan'); await page.waitForSelector('#billing #bl-plan');
  const bt = await page.textContent('#billing');
  check('settings 요금제 (live T1 shape): Free, 결제 정보 없이, usage 0/1 + 1/3, credits total, Pro upgrade instead of 충전',
    /Free/.test(bt) && /결제 정보 없이 이용 중/.test(bt) && /활성 프로젝트\s*0 \/ 1/.test(bt) && /사용자\s*1 \/ 3/.test(bt) && /사용 가능/.test(bt) && /AI 크레딧 충전은 Pro부터/.test(bt) && !(await page.$('#bl-topup')) && !(await page.$('#bl-b-plan')));
  await page.waitForSelector('#bl-ledger table, #bl-ledger p', { timeout: 4000 }).catch(() => {});
  check('settings 요금제: 결제 내역 panel for the OWNER, no ₩ outside it', Boolean(await page.$('#bl-orders')) && !/₩/.test(await page.textContent('#bl-credits')));
  await tallShot(page, 'app-billing-free-desktop.png');

  // ---- /app/settings/billing on the v3 fixture (T2/T3 fields), desktop + phone ----
  const fixtureRoutes = async (p) => {
    await p.route(/\/api\/workspaces\/[^/]+\/billing$/, async (route) => { const r = await route.fetch(); const j = await r.json(); route.fulfill({ response: r, json: { billing: { ...j.billing, ...FIX, subscription: { ...(j.billing.subscription || {}), ...FIX.subscription } } } }); });
    await p.route(/\/api\/workspaces\/[^/]+\/billing\/orders/, (route) => route.fulfill({ json: { orders: ORDERS } }));
  };
  await fixtureRoutes(page);
  await page.goto(BASE + '/app/settings/billing'); await page.waitForSelector('#billing-page #bl-plan');
  const ft = await page.textContent('#billing-page');
  check('billing (fixture): Pro 월간, 다음 결제 2026.11.20 · 32,000원 VAT 포함', /Pro/.test(ft) && /월간/.test(ft) && /2026\.11\.20/.test(ft) && /32,000원/.test(ft) && /VAT 포함/.test(ft));
  check('billing (fixture): 활성 프로젝트 2 / 3, 사용자 10 / 17, 남은 자리 7명', /활성 프로젝트\s*2 \/ 3/.test(ft) && /사용자\s*10 \/ 17/.test(ft) && /남은 자리 7명/.test(ft));
  check('billing (fixture): credits 1,450 = 기본 900 (소멸일) + 가입 50 + 유상 500', /1,450/.test(await page.textContent('#bl-credit-total')) && /900/.test(await page.textContent('#bl-b-plan')) && /소멸/.test(await page.textContent('#bl-b-plan')) && /500/.test(await page.textContent('#bl-b-purchased')));
  check('billing (fixture): 예약된 변경 + 예약 취소, actions incl. 추가 · 충전 · 해지', Boolean(await page.$('#bl-scheduled [data-sched-cancel]')) && Boolean(await page.$('#bl-addon')) && Boolean(await page.$('#bl-topup')) && Boolean(await page.$('#bl-cancel')));
  check('billing (fixture): 결제 내역 3 rows with 영수증', (await page.$$('#bl-orders-tbl tbody tr')).length === 3 && Boolean(await page.$('#bl-orders-tbl a[href^="https://example.invalid"]')));
  await page.waitForSelector('#bl-ledger table, #bl-ledger p', { timeout: 4000 }).catch(() => {});
  check('billing: credit history (credits only, no won)', Boolean(await page.$('#bl-ledger table')) && !/₩|\d원/.test(await page.textContent('#bl-ledger')));
  await tallShot(page, 'app-billing-fixture-desktop.png');
  await page.click('#bl-cancel'); await page.waitForTimeout(200);
  check('billing: 해지 = one click + one confirm (no survey)', /구독을 해지할까요/.test(await page.textContent('body')) && (await page.$$('.dialog input, .modal input, dialog input')).length === 0);
  await page.keyboard.press('Escape');
  await ctx.close();

  const ph = await mk({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ph.page.goto(BASE + '/login');
  await ph.page.request.post(BASE + '/api/auth/login', { data: { email, password: 'passw0rd!' } });
  await fixtureRoutes(ph.page);
  await ph.page.goto(BASE + '/app/settings/billing'); await ph.page.waitForSelector('#billing-page #bl-plan', { timeout: 8000 }).catch(() => {}); await ph.page.waitForSelector('#bl-ledger table, #bl-ledger p', { timeout: 4000 }).catch(() => {});
  check('billing mobile 390: renders, no horizontal scroll', Boolean(await ph.page.$('#bl-usage')) && await noHScroll(ph.page));
  check('billing mobile 390: order + ledger rows show date, title and amount', await ph.page.evaluate(() => [...document.querySelectorAll('#bl-orders-tbl tbody tr, #bl-ledger-tbl tbody tr')].every((tr) => [0, 1, 2].every((i) => tr.children[i].offsetHeight > 0))));
  await tallShot(ph.page, 'app-billing-fixture-mobile.png');
  await ph.page.goto(BASE + '/app/settings'); await ph.page.waitForSelector('#billing #bl-plan', { timeout: 8000 }).catch(() => {});
  check('settings phone layout: billing view mounted, no horizontal scroll', Boolean(await ph.page.$('#billing #bl-credits')) && await noHScroll(ph.page));
  await ph.ctx.close();

  // ---- operator console (read-only v3 billing views) ----
  for (const [tag, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
    sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = '${esc(email)}'`);
    const ad = await mk(vp, mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});
    await ad.page.goto(BASE + '/login'); await ad.page.request.post(BASE + '/api/auth/login', { data: { email, password: 'passw0rd!' } });
    await ad.page.goto(`${BASE}/admin/workspaces/${w}`); await ad.page.waitForSelector('text=요금 · 한도 (v3)', { timeout: 8000 }).catch(() => {});
    const at = await ad.page.textContent('body');
    check(`admin ${tag}: workspace 요금 · 한도 (v3) — plan, seats, 활성 프로젝트 0 / 1, credits, 결제 내역`, /요금 · 한도 \(v3\)/.test(at) && /활성 프로젝트\s*0 \/ 1/.test(at) && /남은 좌석/.test(at) && /AI 크레딧\s*합계/.test(at) && /결제 내역 \(\d+\)/.test(at) && !/이용권/.test(at));
    check(`admin ${tag}: workspace page no horizontal scroll`, await noHScroll(ad.page));
    if (!mobile) await tallShot(ad.page, 'admin-workspace-billing-desktop.png'); else await tallShot(ad.page, 'admin-workspace-billing-mobile.png');
    await ad.page.goto(`${BASE}/admin`); await ad.page.waitForTimeout(1200);
    const dt = await ad.page.textContent('body');
    check(`admin ${tag}: dashboard MRR (VAT 포함) + 유료 워크스페이스 (Pro·Team) when billing tables exist`, /MRR \(VAT 포함\)/.test(dt) && /유료 워크스페이스/.test(dt));
    await ad.page.goto(`${BASE}/admin/subscriptions`); await ad.page.waitForTimeout(1200);
    check(`admin ${tag}: subscriptions list renders (plan filter incl. Pro/Enterprise when implemented)`, /구독/.test(await ad.page.textContent('body')));
    await ad.ctx.close();
  }

  // ---- terms anchors ----
  const tp = await mk({ width: 1280, height: 900 });
  await tp.page.goto(BASE + '/terms#refund');
  check('terms v3: #billing #credits #recurring #refund anchors, 2026-10-21', (await Promise.all(['billing', 'credits', 'recurring', 'refund'].map((id) => tp.page.$(`#${id}`)))).every(Boolean) && /버전 2026-10-21/.test(await tp.page.textContent('.doc__meta')));
  await tp.ctx.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const fail = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - fail.length}/${results.length} passed`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
