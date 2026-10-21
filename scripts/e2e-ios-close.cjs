// Outside-tap close on a phone (founder's real iPhone 10-21: "6번 안되는데" — pointerdown alone did not close menus).
// Every phone menu now gets a transparent full-viewport backdrop just below it (public/app/core/outside.js). This drives
// iPhone 13 WebKit (hasTouch) and Android 360 Chromium with real touchscreen taps AND with touchstart/touchend only (no click,
// no pointer events: what a real iPhone may deliver), plus a 1440px PC run that must get no backdrop.
// Starts its own server (fake email/AI, samples on) on a disposable database. Not part of `npm test`:
//   DATABASE_URL=postgres://…/relai_e2e [SHOTS=dir] node scripts/e2e-ios-close.cjs
// Against a running server instead (read-only): BASE=… STATE=state.json PID=<project id> node scripts/e2e-ios-close.cjs
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium, webkit, devices } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const HEADERS = process.env.TRUSTED_OIDC && process.env.VERCEL_OIDC_TOKEN ? { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN } : undefined;
const GAP = Number(process.env.GAP_MS || 0);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILES = {
  iphone: { eng: webkit, dev: { ...devices['iPhone 13'], hasTouch: true, isMobile: true } },
  // a touch tablet gets the PC layout: the menus a phone hides (account, ⋯, toolbar, columns, report ▾) are tapped here
  ipad: { eng: webkit, dev: { ...devices['iPad Pro 11'], hasTouch: true, isMobile: true } },
  android: { eng: chromium, dev: { viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
};
// [label, route, toggle selector, open-state selector, backdrop expected]. '@' = absolute app path, else under the project.
const MENUS = [
  ['? 도움말 메뉴 (#helpmenu)', '@/app', '.helpbtn', '#helpmenu', true],
  ['상단 계정·프로젝트 메뉴 (.dmenu)', '@/app', '[data-dmenu]', '.dmenu', true],
  ['사업수행계획서 ▾ (details.pmenu)', '/definition', 'details.pmenu > summary', 'details.pmenu[open]', true],
  ['요구사항 정의서 ▾ (details.pmenu)', '/requirements', 'details[data-reqdoc-menu] > summary', 'details[data-reqdoc-menu][open]', true],
  ['보고서 다운로드·복사 ▾ (details.rmenu)', '/reports', 'details.rmenu > summary', 'details.rmenu[open]', true, 'a[href*="/reports/"][data-link]'],
  ['프로젝트 ⋯ / 보고서 메뉴 (.amenu)', '', '.phead__act [data-act], .wsh__act [data-act]', '.amenu', true],
  ['지금 할 일 행 ⋯ (.np__menu)', '', '[data-rowmore]', '.np__menu:not([hidden])', true],
  ['목록 도구 ⋯ (.tmenu)', '/requirements', '[data-tmore]', '.tmenu:not([hidden])', true],
  ['표 열 설정 (.gpop)', '/requirements', '[data-gcols]', '.gpop:not([hidden])', true],
  ['더보기 시트 (#side.is-open, scrim)', '', '[data-tab-more]', '#side.is-open', false],
];

async function startServer(DB) {
  const port = 3900 + Math.floor(Math.random() * 400);
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, EMAIL_PROVIDER: 'fake', INTEGRATION_PROVIDER: 'fake', AI_ENABLED: 'false', SAMPLE_PROJECTS: 'true', PAYMENTS_ENABLED: 'false', NODE_ENV: 'development' };
  delete env.PLAN_LIMITS;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150 && !/listening/.test(out); i++) await sleep(150);
  if (!/listening/.test(out)) { child.kill(); throw new Error(`server did not start:\n${out.slice(-800)}`); }
  return { child, base: `http://127.0.0.1:${port}` };
}

/** A signed-in, verified account with the sample projects → { state, pid } */
async function account(BASE, DB) {
  const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
  await page.goto(BASE + '/login');
  const r = await page.request.post(BASE + '/api/auth/signup', { data: { agree_terms: true, agree_privacy: true, name: 'iOS닫기QA', email: `ioscl-${Date.now()}@relai.test`, password: 'passw0rd!' } });
  const j = await r.json(); execFileSync('psql', [DB, '-Atc', `UPDATE users SET email_verified_at = now() WHERE id = '${j.user.id}'`]);
  const pid = process.env.PID || execFileSync('psql', [DB, '-Atc', `SELECT id FROM projects WHERE workspace_id = '${j.workspaces[0].id}' ORDER BY created_at LIMIT 1`]).toString().trim();
  const state = await ctx.storageState(); await b.close();
  return { state, pid };
}

async function run(name, BASE, state, PID) {
  const { eng, dev } = PROFILES[name];
  const b = await eng.launch();
  const ctx = await b.newContext({ ...dev, storageState: state, locale: 'ko-KR', timezoneId: 'Asia/Seoul', extraHTTPHeaders: HEADERS });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const P = (s) => `[${name}] ${s}`;
  const url = (r) => BASE + (r.startsWith('@') ? r.slice(1) : `/app/projects/${PID}${r}`);
  let last = '';
  const go = async (r) => { if (url(r) === last && page.url() === url(r)) return; if (GAP) await sleep(GAP); await page.goto(url(r), { waitUntil: 'networkidle', timeout: 45000 }); await sleep(500); last = url(r); };
  const tapEl = async (loc) => { await loc.scrollIntoViewIfNeeded(); const r = await loc.boundingBox(); await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2); await sleep(400); };
  // a point whose top element is not a link / button / menu (or is the backdrop): "바깥 빈 곳"
  const blank = () => page.evaluate(() => {
    for (let y = 160; y < innerHeight - 120; y += 16) for (const x of [8, innerWidth / 2, innerWidth - 8]) {
      const e = document.elementFromPoint(x, y);
      if (e && (e.id === 'menubackdrop' || !e.closest('a,button,summary,select,input,label,textarea,[role=menu],[role=menuitem],.dmenu,.amenu,.tabbar,.topbar,#helpmenu,details,.side,.tmenu,.gpop,.np__menu,[contenteditable]'))) return { x, y, tag: e.id || e.className || e.tagName };
    }
    return null;
  });
  // only touchstart + touchend on whatever is under (x, y): no pointer events, no click (what a real iPhone may send)
  const touchOnly = (pt) => page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y); let clicks = 0; const c = () => { clicks++; }; document.addEventListener('click', c, true);
    const mk = (type) => {
      try { const tc = new Touch({ identifier: 1, target: t, clientX: x, clientY: y }); return new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [tc], changedTouches: [tc] }); }
      catch { const e = new Event(type, { bubbles: true, cancelable: true }); e.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }]; return e; }
    };
    t.dispatchEvent(mk('touchstart')); t.dispatchEvent(mk('touchend'));
    document.removeEventListener('click', c, true);
    return { target: t.id || String(t.className || t.tagName), clicksFromOutside: clicks };
  }, pt);
  const isOpen = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((n) => n.getClientRects().length), sel);
  const bd = () => page.evaluate(() => Boolean(document.getElementById('menubackdrop')));
  // the menu's first item is on top of the backdrop (tappable)
  const itemOnTop = (sel) => page.evaluate((s) => {
    const m = [...document.querySelectorAll(s)].find((n) => n.getClientRects().length); if (!m) return false;
    const box = m.matches('details') ? m.querySelector('[role=menu], div, ul') : m;
    const it = (box || m).querySelector('a,button,label,input,select') || box || m; const r = it.getBoundingClientRect();
    const e = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2); return Boolean(e && (box || m).contains(e));
  }, sel);

  for (const [label, route, toggle, open, wantBd, hop] of MENUS) {
    await go(route);
    if (hop) { const h = await page.locator(hop).evaluateAll((as) => as.map((a) => a.getAttribute('href')).find((x) => /\/reports\/[\w-]+$/.test(x))); if (h) { await page.goto(BASE + h, { waitUntil: 'networkidle' }); await sleep(500); last = ''; } }
    const tg = page.locator(toggle.split(',').map((s) => `${s.trim()}:visible`).join(', ')).first();
    if (!(await tg.count())) { console.log(`SKIP ${P(label)} (no visible toggle on a phone here)`); continue; }
    await tapEl(tg);
    if (!(await isOpen(open))) { check(P(`${label} opens`), false); continue; }
    if (wantBd) {
      check(P(`${label}: backdrop present`), await bd());
      check(P(`${label}: menu item is above the backdrop`), await itemOnTop(open));
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${label.replace(/[^\w가-힣]+/g, '_')}-open.png` });
    // 1) touchstart/touchend only, on a blank area
    let pt = await blank();
    if (!pt && !wantBd) { console.log(`SKIP ${P(label)} (full-screen sheet: no outside area to tap)`); await page.keyboard.press('Escape'); continue; }
    if (!pt) { check(P(`${label}: found a blank area`), false); continue; }
    const before = page.url();
    const r = await touchOnly(pt); await sleep(300);
    check(P(`${label}: closes on touchstart/touchend only (no click)`), !(await isOpen(open)), `target=${r.target} clicks=${r.clicksFromOutside}`);
    check(P(`${label}: backdrop removed`), !(await bd()));
    // 2) a real tap; nothing underneath gets activated
    await tapEl(tg); pt = await blank();
    await page.touchscreen.tap(pt.x, pt.y); await sleep(400);
    check(P(`${label}: closes on a real blank tap`), !(await isOpen(open)));
    check(P(`${label}: no ghost tap underneath (URL unchanged)`), page.url() === before, page.url().replace(BASE, ''));
    // 3) Esc still closes (keyboard)
    if (wantBd) { await tapEl(tg); await page.keyboard.press('Escape'); await sleep(250); check(P(`${label}: Esc closes, backdrop gone`), !(await isOpen(open)) && !(await bd())); }
  }
  check(P('no JS error'), !errs.length, errs.slice(0, 3).join(' | '));
  await b.close();
}

async function pc(BASE, state, PID) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, storageState: state, locale: 'ko-KR', extraHTTPHeaders: HEADERS });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const cases = [['@/app', '.helpbtn', '#helpmenu'], ['@/app', '[data-dmenu]', '.dmenu'], ['/definition', 'details.pmenu > summary', 'details.pmenu[open]'], ['', '.phead__act [data-act="more"], .wsh__act [data-act="more"]', '.amenu']];
  for (const [r, tg, open] of cases) {
    await page.goto(BASE + (r.startsWith('@') ? r.slice(1) : `/app/projects/${PID}${r}`), { waitUntil: 'networkidle' }); await sleep(400);
    const t = page.locator(tg.split(',').map((s) => `${s.trim()}:visible`).join(', ')).first();
    if (!(await t.count())) { console.log(`SKIP [pc] ${open}`); continue; }
    await t.click(); await sleep(250);
    const o = await page.locator(open).count();
    const nob = !(await page.evaluate(() => document.getElementById('menubackdrop')));
    await page.mouse.click(1300, 860); await sleep(250);
    check(`[pc] ${open}: opens, no backdrop, outside click closes`, o > 0 && nob && !(await page.locator(open).count()));
  }
  check('[pc] no JS error', !errs.length, errs.slice(0, 3).join(' | '));
  await b.close();
}

(async () => {
  let srv = null; let BASE = process.env.BASE; let state = process.env.STATE; let PID = process.env.PID;
  try {
    if (!BASE) { const DB = process.env.DATABASE_URL; srv = await startServer(DB); BASE = srv.base; ({ state, pid: PID } = await account(BASE, DB)); }
    for (const p of (process.env.PROFILES || 'iphone,ipad,android').split(',')) await run(p, BASE, state, PID);
    if (!process.env.NO_PC) await pc(BASE, state, PID);
  } finally { if (srv) srv.child.kill(); }
  const fail = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - fail.length}/${results.length} passed`);
  process.exit(fail.length ? 1 : 0);
})();
