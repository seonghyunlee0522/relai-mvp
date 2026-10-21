// Mobile tap fixes (Jim live test 2026-10-21, hive research/relai-mobile-buttons-2026-10-21.md) — real touch taps on
// iPhone 13 WebKit and Android 360 Chromium, items 1–6. Read-only on the data: safe on a preview that shares the prod DB.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3101 STATE=state.json PID=<project id> [SHOTS=dir] [EXTRA_HEADERS='{"x-vercel-protection-bypass":"…"}'] node scripts/e2e-mobile-fix.cjs
// STATE = a Playwright storageState of a signed-in, verified account whose workspace holds project PID and the 3 sample projects.
const fs = require('fs');
const { chromium, webkit, devices } = require('playwright');
const BASE = process.env.BASE; const PID = process.env.PID; const SHOTS = process.env.SHOTS || '';
const HEADERS = process.env.EXTRA_HEADERS ? JSON.parse(process.env.EXTRA_HEADERS) : undefined;
const GAP = Number(process.env.GAP_MS || 0);   // pause between page loads (use ≥ 3000 on a deployment that shares the prod DB)
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const PROFILES = {
  iphone: { eng: webkit, dev: devices['iPhone 13'] },
  android: { eng: chromium, dev: { viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' } },
};
// [route, selector, label] — the controls Jim measured below 32px (#4); each must offer a ≥ 44×44 box on a phone
const TARGETS = [
  ['/changes', '.coach__x', '변경 코치마크 ×'], ['/changes', '.coach .coach__more', "코치마크 '자세히'"],
  ['@/app/guide', '.sg-end a', "샘플 가이드 '홈'"], ['/activity', '.actrow__h a', '활동 기록 항목 링크'],
  ['/overview', '.ovsec__ctx a', "현황 '01 착수'"], ['@/app/projects', '.gfoot .btn--xs', '프로젝트 목록 ‹ ›'],
  ['@/app', '.appfoot a', "푸터 '문의' 외"], ['@/app', '.sbanner p a, .hsum__smp a', "홈 '샘플로 보는 가이드'"], ['@/app', '.hc__attmore a', "홈 '외 N건 →'"],
  ['/definition/goals', '.defsec__pg a', "정의 '← 개요' · '다음 업무'"], ['@/app/billing/plans', '.pl-faq summary', '요금제 FAQ 질문'],
];
const url = (r) => BASE + (r.startsWith('@') ? r.slice(1) : `/app/projects/${PID}${r}`);

async function run(name) {
  const { eng, dev } = PROFILES[name];
  const b = await eng.launch();
  const ctx = await b.newContext({ ...dev, storageState: process.env.STATE, locale: 'ko-KR', timezoneId: 'Asia/Seoul', extraHTTPHeaders: HEADERS });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('response', (r) => { if (r.status() >= 500 && r.url().startsWith(BASE)) errs.push(`${r.status()} ${r.url()}`); });
  const go = async (u) => { if (GAP) await page.waitForTimeout(GAP); await page.goto(u, { waitUntil: 'networkidle', timeout: 45000 }); await page.waitForTimeout(500); };
  const tapEl = async (loc) => { await loc.scrollIntoViewIfNeeded(); const r = await loc.boundingBox(); await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2); await page.waitForTimeout(500); };
  // a point on a non-interactive area (no link / button / menu under it): what Jim's "바깥 탭" means
  const blank = () => page.evaluate(() => {
    for (let y = 200; y < innerHeight - 120; y += 20) for (const x of [6, innerWidth / 2, innerWidth - 6]) {
      const e = document.elementFromPoint(x, y); if (e && !e.closest('a,button,summary,select,input,label,[role=menu],[role=menuitem],.dmenu,.amenu,.tabbar,#helpmenu,details')) return { x, y };
    }
    return null;
  });
  const shot = (f) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}-${f}.png` }) : null);
  const P = (s) => `[${name}] ${s}`;

  // #1 도움말 › RELAI 가이드 다시 보기 → /app/guide
  await go(BASE + '/app');
  await tapEl(page.locator('.helpbtn:visible').first());
  check(P('#1 help menu opens'), await page.locator('#helpmenu').isVisible());
  await shot('1-help-open');
  await tapEl(page.locator('#helpmenu [data-h="tour"]'));
  await page.waitForURL(/\/app\/guide$/, { timeout: 8000 }).catch(() => {});
  check(P('#1 가이드 다시 보기 → /app/guide'), new URL(page.url()).pathname === '/app/guide', page.url().replace(BASE, ''));
  await shot('1-guide');

  // #5 A/B/C cards open the sample
  const cards = page.locator('.sg-pick__i');
  check(P('#5 three sample cards'), (await cards.count()) === 3);
  const href = await cards.first().getAttribute('href');
  check(P('#5 card links to a project'), /^\/app\/projects\/[\w-]+$/.test(href || ''), href);
  await tapEl(cards.first());
  await page.waitForURL(/\/app\/projects\/[\w-]+$/, { timeout: 8000 }).catch(() => {});
  check(P('#5 tap card A → sample project'), new URL(page.url()).pathname === href, page.url().replace(BASE, ''));

  // #6 help menu: a blank-area tap closes; and a bare pointerdown (no click, as real iOS Safari may send) closes too
  await go(BASE + '/app');
  await tapEl(page.locator('.helpbtn:visible').first());
  let pt = await blank(); await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(300);
  check(P('#6 help menu closes on a blank tap'), !(await page.locator('#helpmenu').count()));
  await tapEl(page.locator('.helpbtn:visible').first());
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })), pt); await page.waitForTimeout(200);
  check(P('#6 help menu closes on pointerdown alone (no click)'), !(await page.locator('#helpmenu').count()));
  await tapEl(page.locator('.helpbtn:visible').first()); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(P('#6 Esc still closes the help menu'), !(await page.locator('#helpmenu').count()));

  // #2 사업수행계획서 ▾ (.pmenu) closes on an outside tap; pointerdown alone too; its own summary still toggles
  await go(url('/definition'));
  const sum = page.locator('details.pmenu > summary').first();
  await tapEl(sum);
  check(P('#2 plan menu opens'), await page.locator('details.pmenu[open]').count() === 1);
  await shot('2-pmenu-open');
  pt = await blank(); await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(300);
  check(P('#2 plan menu closes on a blank tap'), await page.locator('details.pmenu[open]').count() === 0);
  await shot('2-pmenu-closed');
  await tapEl(sum);
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })), pt); await page.waitForTimeout(200);
  check(P('#2/#6 plan menu closes on pointerdown alone'), await page.locator('details.pmenu[open]').count() === 0);
  await tapEl(sum); await tapEl(sum);
  check(P('#2 summary tap still toggles it shut'), await page.locator('details.pmenu[open]').count() === 0);
  await tapEl(sum); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(P('#2 Esc closes it'), await page.locator('details.pmenu[open]').count() === 0);
  await go(url('/requirements'));
  const rq = page.locator('details[data-reqdoc-menu]:visible > summary');
  if (!(await rq.count())) console.log(`SKIP ${P('#2 요구사항 정의서 ▾')} (hidden on a phone)`);
  else {
    await tapEl(rq.first()); pt = await blank(); await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(300);
    check(P('#2 요구사항 정의서 ▾ closes on a blank tap'), await page.locator('details[data-reqdoc-menu][open]').count() === 0);
  }

  // #3 더보기 sheet › current phase on 지금 할 일 → sheet closes, phase list in view
  await go(url(''));
  await tapEl(page.locator('[data-tab-more]').first());
  check(P('#3 더보기 sheet opens'), await page.locator('#side.is-open').count() === 1);
  const cur = page.locator('#side .lnb__ph.is-cur .lnb__phh, #side .lnb__ph.is-gap .lnb__phh').first();
  await tapEl(cur);
  await shot('3-after-phase-tap');
  check(P('#3 current-phase tap closes the sheet'), await page.locator('#side.is-open').count() === 0);
  const inView = await page.evaluate(() => { const n = document.querySelector('#main .np'); if (!n) return false; const r = n.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
  check(P('#3 phase activity list is in view'), inView);

  // #4 tap areas ≥ 44×44
  let last = '';
  for (const [r, sel, label] of TARGETS) {
    if (url(r) !== last) { await go(url(r)); last = url(r); }
    const sizes = await page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length).map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }));
    if (!sizes.length) { console.log(`SKIP ${P('#4 ' + label)} (not on this page/account)`); continue; }
    const min = sizes.reduce((m, [w, h]) => [Math.min(m[0], w), Math.min(m[1], h)], [1e9, 1e9]);
    check(P(`#4 ${label} ≥ 44×44`), min[0] >= 44 && min[1] >= 44, `min ${min[0]}×${min[1]} (${sizes.length})`);
  }
  check(P('no JS error / 5xx'), !errs.length, errs.slice(0, 3).join(' | '));
  await b.close();
}

(async () => {
  for (const p of (process.env.PROFILES || 'iphone,android').split(',')) await run(p);
  const fail = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - fail.length}/${results.length} passed`);
  process.exit(fail.length ? 1 : 0);
})();
