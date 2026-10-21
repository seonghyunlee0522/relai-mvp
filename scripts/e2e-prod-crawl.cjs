#!/usr/bin/env node
// RELAI production crawl — run after every deploy (Jim 2026-10-21, founder: "누르자마자 에러가 나는 페이지가 있는데").
// Walks EVERY reachable route as each role on each device, taps every control (one level into drawers / dialogs / menus),
// and requests every href / asset / download it finds. Records: document + fetch/XHR + asset + download status ≥ 400,
// console errors, uncaught errors / unhandled rejections, blank or error screens, dead taps (no visible effect), taps
// covered by another element. Read-only by design: write / payment / invite / delete / logout / AI-run buttons are listed, never pressed.
//
//   BASE=https://relai.kr OUT=crawl-out \
//   OWNER_EMAIL=… OWNER_PASSWORD=… MEMBER_EMAIL=… MEMBER_PASSWORD=… [ADMIN_EMAIL=… ADMIN_PASSWORD=…] \
//   [ROLES=anon,owner,member,admin] [DEVICES=desktop,iphone,android] [TAPS=1] [PACE_MS=3500] [MAX_PAGES=120] [WRITES=1] [SEEDS=/path,/path] \
//   node scripts/e2e-prod-crawl.cjs
//
// Output: OUT/results.jsonl (one row per event), OUT/shots/*.png (every failure), OUT/summary.md (route × device × role matrix).
// WRITES=1 (QA workspace accounts ONLY): also presses write buttons (추가·저장·등록·확정·만들기·적용…) and form submits, and one level into what they open.
// Never pressed in any mode: AI start / credit spend, payment, invite, delete — and logout, project archive/close, phase move (they would end the crawl
// or wreck the QA fixture). Every report starts with what was NOT pressed. Look-alikes (text styled like a button, not a control) are tapped too:
// one that does nothing is a failure (founder 10-21: phone WBS chips 진행 중/완료/마일스톤 were <span>s).
// Exit code 1 when any failure is found, 2 when stopped on a 5xx burst. Needs `playwright` (+ `npx playwright install chromium webkit`).
const fs = require('fs');
const path = require('path');
const { chromium, webkit, devices } = require('playwright');

const BASE = (process.env.BASE || 'https://relai.kr').replace(/\/$/, '');
const OUT = process.env.OUT || 'crawl-out';
const PACE = Number(process.env.PACE_MS || 3500);       // min ms between full page loads (prod: ~1 load / 3–5 s)
const SOFT_PACE = Math.round(PACE / 2);                 // min ms between taps that hit the server
const MAX_PAGES = Number(process.env.MAX_PAGES || 120); // per role × device
const PER_PATTERN = Number(process.env.PER_PATTERN || 2); // instances per route pattern (/:id)
const TAPS = process.env.TAPS !== '0';
const ROLES = (process.env.ROLES || 'anon,owner,member,admin').split(',').filter(Boolean);
const DEVICES = (process.env.DEVICES || 'desktop,iphone,android').split(',').filter(Boolean);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
const RES = path.join(OUT, 'results.jsonl');
const rec = (o) => fs.appendFileSync(RES, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

const CREDS = {
  owner: [process.env.OWNER_EMAIL, process.env.OWNER_PASSWORD],
  member: [process.env.MEMBER_EMAIL, process.env.MEMBER_PASSWORD],
  admin: [process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD],
};
const DEVICE = {
  desktop: { engine: chromium, opts: { viewport: { width: 1440, height: 900 } }, touch: false },
  iphone: { engine: webkit, opts: devices['iPhone 13'], touch: true },
  android: { engine: chromium, touch: true, opts: { viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' } },
};
// Public pages + every path an e-mail links to (server/email/templates.js callers), with bogus tokens: must show a friendly page, never a crash.
const SEEDS_PUBLIC = ['/', '/login', '/signup', '/forgot-password', '/terms', '/privacy', '/pricing', '/docs/relai-guide.pdf',
  '/reset-password?token=crawl-invalid', '/verify-email?token=crawl-invalid', '/invite/crawl-invalid-token'];
const SEEDS_APP = ['/app', '/app/projects', '/app/guide', '/app/projects/new', '/app/settings', '/app/settings/billing', '/app/settings/credits',
  '/app/billing/plans', '/app/billing/subscribe'];
const SEEDS_ADMIN = ['/admin'];

const WRITES = process.env.WRITES === '1';
// Never pressed, any mode (NOT_PRESSED, listed in the report headline): AI start / credit spend, payment, invite, delete; plus logout, project archive /
// close / reopen and phase moves, which would end the session or wreck the QA fixture. AI dialogs are also fenced by AI_BOX below.
const NO_PRESS_ALWAYS = /.{8,}[?？]$|물어|결제하기|결제 진행|결제 수단|구독하기|충전|구매|환불|해지|카드 등록|초대|재발송|재전송|삭제|제거|탈퇴|로그아웃|프로젝트 보관|보관하기|프로젝트 종료|종료하기|다시 열기|단계로 진행|단계 시작|승인 없이 진행|Go-Live|오픈 처리|비밀번호 변경|이메일 변경/;
// Read-only mode (WRITES unset, e.g. a non-QA account): also skip anything that writes.
const NO_PRESS_WRITE = /보내기|전송|발송|제출|저장|등록|추가|생성|만들기|적용|승인|반려|완료 처리|완료로|확정|되돌리|복원|보관|업로드|가져오기|실행|추출|분석하기|초안|다시 생성|AI로|요청하기|변경하기|연결|연동|해제|승격|강등|권한|이관/;
if (WRITES) { const bad = Object.values(CREDS).map((c) => c[0]).filter((e) => e && !new RegExp(process.env.WRITES_ALLOW || '^qa-', 'i').test(e));
  if (bad.length) { console.error(`WRITES=1 refused: ${bad.join(', ')} is not a QA account (WRITES_ALLOW, default ^qa-)`); process.exit(3); } }   // never write as a real customer / founder
const noPress = (t) => NO_PRESS_ALWAYS.test(t) || (!WRITES && NO_PRESS_WRITE.test(t));
const AI_BOX = '.aipanel, .scrim--ai, .dialog--ai';   // anything inside runs a paid AI call except close / cancel
const isClose = (t) => /^(×|✕|닫기|취소|Close)$/.test((t || '').trim());
const CTRL = 'button, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], summary, label.toggle, input[type=checkbox], input[type=radio], a[href="#"], a:not([href])[tabindex], a[href^="javascript"]';
const ROWS = 'tr[data-id], tr[data-i], tr[data-item], tr[data-href], .wtree__r, li[data-id]';
const OPEN_SEL = '.drawer:not([hidden]), #drawer:not([hidden]), .wdrawer, .scrim, [role=dialog]:not([hidden]), dialog[open], .dmenu, .amenu:not([hidden]), .np__menu:not([hidden]), .helpmenu, .gpop:not([hidden]), details[open] > :not(summary), .aipanel, .side.is-open, .pstepw.is-open';
const MENU_SEL = '.dmenu, .amenu:not([hidden]), .np__menu:not([hidden]), .helpmenu, .gpop:not([hidden]), details[open][class*=menu] > :not(summary), [role=menu]:not([hidden])';
const ERROR_TEXT = /Service temporarily unavailable|Cannot GET|Internal Server Error|문제가 발생했습니다|오류가 발생했습니다|불러오지 못했습니다|Unexpected token|undefined|NaN|\[object Object\]/;
// Known non-failures (keep this list short and explicit).
const IGNORE_NET = [/\/api\/analytics\//, /google-analytics|googletagmanager|doubleclick\.net|googleadservices/, /\/api\/me\?optional/];
const pattern = (u) => { const x = new URL(u, BASE); return x.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\/[A-Za-z0-9_-]{20,}$/, '/:token') + (x.search ? '?' + [...x.searchParams.keys()].sort().join('&') : ''); };
const isPage = (u) => { const x = new URL(u, BASE); return x.origin === new URL(BASE).origin && !/^\/api\//.test(x.pathname) && !/\.[a-z0-9]{2,5}$/i.test(x.pathname); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let burst = [];   // 5xx timestamps → stop on ≥ 3 within 30 s
const failures = []; const notPressed = {}; const combos = []; const matrix = {}; const resources = new Map(); // url → { from, roles }
let lastLoad = 0, lastTap = 0;
async function paced(min, which) { const last = which === 'load' ? lastLoad : lastTap; const wait = last + min - Date.now(); if (wait > 0) await sleep(wait); if (which === 'load') lastLoad = Date.now(); else lastTap = Date.now(); }

async function login(ctx, role) {
  const [email, password] = CREDS[role] || [];
  if (!email || !password) return false;
  const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email, password }, headers: { origin: BASE } });
  if (r.status() !== 200) { rec({ kind: 'login', role, status: r.status() }); return false; }
  return true;
}

async function runCombo(role, devName) {
  const dev = DEVICE[devName]; const key = `${role}/${devName}`;
  const browser = await dev.engine.launch();
  const ctx = await browser.newContext({ ...dev.opts, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
  if (role !== 'anon' && !(await login(ctx, role))) { rec({ kind: 'skip-combo', role, device: devName, why: 'no credentials or login failed' }); combos.push(`${role}/${devName}: NOT RUN (no credentials or login failed)`); await browser.close(); return; }
  const page = await ctx.newPage();
  let errs = [];   // events since the last mark
  const net = (r) => { const u = r.url(); if (IGNORE_NET.some((re) => re.test(u))) return; const s = r.status();
    if (s >= 500) { burst.push(Date.now()); burst = burst.filter((t) => Date.now() - t < 30000); if (burst.length >= 3) { rec({ kind: 'STOP', why: '5xx burst', url: u, status: s }); console.error(`STOP 5xx burst ${new Date().toISOString()} ${s} ${u}`); process.exit(2); } }
    if (s >= 400) errs.push(`${s} ${r.request().method()} ${u.replace(BASE, '')}`); };
  page.on('response', net);
  page.on('requestfailed', (q) => { const u = q.url(); if (IGNORE_NET.some((re) => re.test(u))) return; const f = q.failure() && q.failure().errorText; if (f && !/ERR_ABORTED|cancelled|NS_BINDING_ABORTED/i.test(f)) errs.push(`FAILED ${f} ${u.replace(BASE, '')}`); });
  page.on('pageerror', (e) => errs.push(`JS ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('dialog', (d) => { errs.push(`NATIVE-DIALOG ${d.message().slice(0, 80)}`); d.dismiss().catch(() => {}); });
  ctx.on('page', (p) => { p.close().catch(() => {}); });
  const shot = async (name, xy) => {
    const f = `${key.replace('/', '-')}-${name}`.replace(/[^\w가-힣.-]+/g, '_').slice(0, 120) + '.png';
    if (xy) await page.evaluate(({ x, y }) => { const d = document.createElement('div'); d.id = '__dot'; Object.assign(d.style, { position: 'fixed', left: `${x - 14}px`, top: `${y - 14}px`, width: '28px', height: '28px', border: '3px solid red', borderRadius: '50%', zIndex: 2147483647, pointerEvents: 'none' }); document.body.append(d); }, xy).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'shots', f) }).catch(() => {});
    await page.evaluate(() => document.getElementById('__dot')?.remove()).catch(() => {});
    return f;
  };
  const skipped = (o) => { const k = `${o.label}`; (notPressed[k] = notPressed[k] || new Set()).add(`${o.pat} ${devName}/${role}`); };
  const fail = (o) => { failures.push({ role, device: devName, ...o }); rec({ kind: 'FAIL', role, device: devName, ...o }); };
  const skipTour = async () => { const s = page.getByText('건너뛰기', { exact: true }); if (await s.count().catch(() => 0)) { await s.first().click({ timeout: 2000 }).catch(() => {}); await sleep(300); } };
  const load = async (u) => {
    await paced(PACE, 'load'); errs = [];
    const resp = await page.goto(BASE + u, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => ({ status: () => 0, err: e.message }));
    await sleep(500); await skipTour();
    return resp;
  };
  const collect = () => page.evaluate(() => {
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return null; } };
    const hrefs = [...document.querySelectorAll('a[href], area[href]')].map((a) => ({ u: abs(a.getAttribute('href')), t: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40), blank: a.target === '_blank', dl: a.hasAttribute('download') }));
    const res = [...document.querySelectorAll('link[href], script[src], img[src], source[src], iframe[src], [data-href]')].map((e) => abs(e.getAttribute('href') || e.getAttribute('src') || e.getAttribute('data-href')));
    return { hrefs: hrefs.filter((h) => h.u), res: res.filter(Boolean) };
  });
  const screenState = () => page.evaluate((ERR) => {
    const main = document.querySelector('main, #main, #app, body'); const txt = (main && main.innerText || '').trim();
    const re = new RegExp(ERR); const toasts = [...document.querySelectorAll('.toast, [role=alert]')].map((t) => t.innerText.trim()).filter(Boolean);
    return { len: txt.length, errText: (txt.match(re) || [null])[0], toasts, title: document.title };
  }, ERROR_TEXT.source);

  // ---------- BFS over pages ----------
  const seeds = process.env.SEEDS ? process.env.SEEDS.split(',') : [...SEEDS_PUBLIC, ...(role === 'anon' ? [] : SEEDS_APP), ...(role === 'admin' ? SEEDS_ADMIN : [])];   // SEEDS=/a,/b: a quick targeted run
  const queue = [...seeds]; const seen = new Set(); const perPattern = {}; let pages = 0;
  const tapped = new Set();   // control signature → tapped once per combo
  while (queue.length && pages < MAX_PAGES) {
    const u = queue.shift(); const pat = pattern(BASE + u); if (seen.has(u)) continue; seen.add(u);
    perPattern[pat] = (perPattern[pat] || 0) + 1; if (perPattern[pat] > PER_PATTERN) continue;
    if (/\.pdf$/i.test(u)) { resources.set(BASE + u, { from: 'seed', role }); continue; }
    pages++;
    const resp = await load(u); const status = resp.status ? resp.status() : 0;
    const landed = page.url().replace(BASE, '');
    const st = await screenState().catch(() => ({ len: 0, toasts: [] }));
    const loadErrs = errs.splice(0).filter((e) => !(/crawl-invalid/.test(u) && /^4\d\d (GET|POST) \/api\/(auth|invitations)\//.test(e)));
    const blank = st.len < 25; const cell = (matrix[pat] = matrix[pat] || {}); const ck = `${devName}/${role}`;
    const bad = status >= 400 || status === 0 || blank || st.errText || loadErrs.length;
    if (bad) fail({ kind: 'page', route: u, landed, status, blank, errText: st.errText, toasts: st.toasts, errs: loadErrs.slice(0, 8), shot: await shot(`page-${pat}`) });
    cell[ck] = cell[ck] === 'FAIL' || bad ? 'FAIL' : 'ok';
    rec({ kind: 'page', role, device: devName, route: u, pat, landed, status, len: st.len, errs: loadErrs.length });
    const { hrefs, res } = await collect().catch(() => ({ hrefs: [], res: [] }));
    for (const h of hrefs) {
      if (/^(mailto|tel):/.test(h.u)) { resources.set(h.u, { from: landed, role }); continue; }
      if (isPage(h.u) && !h.blank && !h.dl) { const p = new URL(h.u); const rel = p.pathname + p.search; if (!seen.has(rel)) queue.push(rel); }
      else resources.set(h.u.split('#')[0], { from: landed, role, text: h.t });
    }
    for (const r of res) if (!/^data:|^blob:/.test(r) && !IGNORE_NET.some((re) => re.test(r))) resources.set(r, { from: landed, role, asset: true });
    if (!TAPS || status >= 400) continue;

    // ---------- taps: rows first (one per kind), then every control ----------
    const controls = await page.evaluate(({ CTRL, ROWS, AI_BOX }) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && !el.closest('[hidden]') && !el.closest('details:not([open]) > :not(summary)'); };
      const out = []; const kinds = new Set();
      for (const sel of ROWS.split(', ')) for (const el of document.querySelectorAll(sel)) { if (!vis(el) || kinds.has(sel)) continue; kinds.add(sel); out.push({ row: sel, txt: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 40) }); }
      const modal = [...document.querySelectorAll('.scrim, [role=dialog][aria-modal=true], dialog[open]')].filter(vis).pop();   // a modal open on load (e.g. ?close=1): only its controls are reachable
      for (const el of (modal || document).querySelectorAll(CTRL)) { if (!vis(el)) continue; const txt = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        out.push({ tag: el.tagName.toLowerCase(), txt, aria: el.getAttribute('aria-label') || el.title || '', cls: String(el.className || '').split(' ').slice(0, 2).join('.'), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', type: el.type || '', on: (el.type === 'radio' && el.checked) || el.getAttribute('aria-selected') === 'true' || !!el.getAttribute('aria-current') || /(^|\s)(is-on|is-active|active)(\s|$)/.test(String(el.className)), submit: el.type === 'submit' && !!el.form, ai: !!el.closest(AI_BOX) }); }
      // look-alikes: not a control and not inside one, but shares a class with a real control here and is drawn like a button (border + radius)
      const I = 'a[href], button, summary, input, select, textarea, label, [role=button], [role=tab], [role=link], [role=menuitem], [onclick], [data-link], [tabindex]';
      const ctrlCls = new Set(); document.querySelectorAll('button, a[href], [role=button]').forEach((e) => e.classList.forEach((c) => ctrlCls.add(c)));
      const lk = new Set();
      for (const el of (modal || document.querySelector('main, #main') || document.body).querySelectorAll('*')) {
        if (el.matches(I) || el.closest(I) || !vis(el)) continue; const r = el.getBoundingClientRect(); if (r.height < 18 || r.width > 420) continue;
        const cs = getComputedStyle(el); const txt = el.innerText.replace(/\s+/g, ' ').trim(); if (!txt || txt.length > 30) continue;
        const shared = [...el.classList].filter((c) => ctrlCls.has(c) && !/^(is-|has-)|^(dim|small|link|muted)$/.test(c));
        if (!shared.length || !(parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderRadius) > 0)) continue;
        const k = `${el.tagName}|${shared.join('.')}|${txt}`; if (lk.has(k)) continue; lk.add(k);
        out.push({ look: lk.size - 1, tag: el.tagName.toLowerCase(), txt, aria: '', cls: shared.join('.') });
      }
      return out;
    }, { CTRL, ROWS, AI_BOX }).catch(() => []);
    const seenHere = {};
    for (const c of controls) {
      const label = c.row ? `row:${c.row}` : c.look !== undefined ? `look-alike ${c.tag}.${c.cls} "${c.txt}"` : (c.txt || c.aria || c.cls);
      const sig = c.row ? `${pat}|${c.row}` : c.look !== undefined ? `${pat}|look|${c.tag}|${c.cls}|${c.txt}` : `${c.tag}|${c.txt}|${c.aria}|${c.cls}`;   // shared chrome (top bar, tab bar, help) is tapped once per combo
      if (tapped.has(sig)) continue; tapped.add(sig);
      const occ = (seenHere[sig] = (seenHere[sig] ?? -1) + 1);
      if (c.disabled) { rec({ kind: 'tap', role, device: devName, pat, label, result: 'DISABLED' }); continue; }
      if (!c.row && c.look === undefined && (noPress(`${c.txt} ${c.aria}`) || (c.submit && !WRITES) || (c.ai && !isClose(c.txt || c.aria)))) { { const o = { kind: 'tap', role, device: devName, pat, label, result: 'NOT_PRESSED' }; rec(o); skipped(o); } continue; }
      const r = await tapOne(c, occ, u, pat, label);
      if (r && r.dirty) { await load(u); }
    }
  }
  async function tapOne(c, occ, u, pat, label, inner = false) {
    await paced(SOFT_PACE, 'tap');
    const p = await page.evaluate(({ c, occ, CTRL, OPEN_SEL }) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]'); };
      let el;
      if (c.row) el = [...document.querySelectorAll(c.row)].find(vis);
      else if (c.look !== undefined) el = [...document.querySelectorAll(c.tag)].filter(vis).find((e) => c.cls.split('.').every((k) => e.classList.contains(k)) && e.innerText.replace(/\s+/g, ' ').trim() === c.txt);   // found again by look: a reload drops any marker
      else { const scope = c.inner ? [...document.querySelectorAll(OPEN_SEL)].filter((b) => !b.dataset.crawlPre) : [document];
        const all = scope.flatMap((s) => [...s.querySelectorAll(CTRL)]).filter(vis).filter((e) => (e.innerText || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 40) === c.txt && (e.getAttribute('aria-label') || e.title || '') === c.aria);
        el = all[occ] || all[0]; }
      if (!el) return null;
      document.documentElement.style.scrollBehavior = 'auto'; el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rs = [...el.getClientRects()].filter((q) => q.width > 4).sort((a, b) => b.width * b.height - a.width * a.height); const r = rs[0] || el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y);
      const covered = !(top && (el === top || el.contains(top) || top.contains(el) || (el.tagName === 'LABEL' && top.closest('label') === el)));
      const d = (n) => (n ? `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')} "${(n.innerText || '').trim().slice(0, 24)}"` : 'none');
      document.querySelectorAll(OPEN_SEL).forEach((b) => { b.dataset.crawlPre = '1'; });
      window.__mut = 0; if (!window.__mo) { window.__mo = new MutationObserver((ms) => { for (const m of ms) if (!(m.type === 'attributes' && m.oldValue === m.target.getAttribute(m.attributeName))) window.__mut++; }); window.__mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true }); }   // a write that changes nothing (e.g. re-hiding a hidden popup on every document click) is not a reaction
      return { x, y, w: Math.round(r.width), h: Math.round(r.height), covered, coveredBy: covered ? d(top) : '', byPanel: covered && !!(top && top.closest(OPEN_SEL)) && !el.closest(OPEN_SEL), url: location.href, open: document.querySelectorAll(OPEN_SEL).length, scroll: scrollY, len: document.body.innerText.length };
    }, { c, occ, CTRL, OPEN_SEL }).catch(() => null);
    if (!p) { rec({ kind: 'tap', role, device: devName, pat, label, result: 'GONE' }); return { dirty: true }; }
    errs = []; let downloads = 0; const onDl = () => downloads++; page.on('download', onDl);
    const popupsBefore = ctx.pages().length;
    if (DEVICE[devName].touch) await page.touchscreen.tap(p.x, p.y).catch((e) => errs.push(`TAP ${e.message.slice(0, 80)}`)); else await page.mouse.click(p.x, p.y).catch((e) => errs.push(`CLICK ${e.message.slice(0, 80)}`));
    await sleep(900); await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    page.off('download', onDl);
    const a = await page.evaluate((OPEN_SEL) => ({ url: location.href, open: document.querySelectorAll(OPEN_SEL).length, mut: window.__mut || 0, scroll: scrollY, len: document.body.innerText.length, ro: !!document.querySelector('.toast--ro'), toasts: [...document.querySelectorAll('.toast, [role=alert]')].map((t) => t.innerText.trim().slice(0, 80)) }), OPEN_SEL).catch(() => ({ url: page.url(), open: 0, mut: 0, toasts: [] }));
    const tapErrs = errs.splice(0);
    const result = a.url !== p.url ? 'NAV' : downloads ? 'DOWNLOAD' : ctx.pages().length > popupsBefore ? 'POPUP' : a.ro ? 'PHONE_READONLY' : a.open > p.open ? 'OPEN' : a.open < p.open ? 'CLOSE' : (a.mut > 0 || a.len !== p.len || Math.abs(a.scroll - p.scroll) > 40) ? 'CHANGE' : 'NONE';
    const errToast = a.toasts.find((t) => /오류|실패|못했|없습니다|error/i.test(t));
    const bad = (result === 'NONE' && !c.on && !p.byPanel) || (p.covered && !p.byPanel) || tapErrs.some((e) => /^(JS|CONSOLE|FAILED|5\d\d|4\d\d)/.test(e)) || result === 'PHONE_READONLY' || errToast;
    const row = { kind: 'tap', role, device: devName, pat, route: u, label, inner, result: c.look !== undefined && result === 'NONE' ? 'LOOKALIKE_DEAD' : result, covered: p.covered, coveredBy: p.coveredBy, size: `${p.w}x${p.h}`, toUrl: result === 'NAV' ? a.url.replace(BASE, '') : '', toasts: a.toasts, errs: tapErrs.slice(0, 6) };
    if (bad) { row.shot = await shot(`tap-${pat}-${label}`, p); fail({ ...row, kind: 'tap' }); } else rec(row);
    // one level in: every control inside what just opened (dialog / drawer / menu / sheet)
    if (!inner && result === 'OPEN') {
      const innerCtrls = await page.evaluate(({ CTRL, OPEN_SEL, AI_BOX }) => { const out = []; for (const box of [...document.querySelectorAll(OPEN_SEL)].filter((b) => !b.dataset.crawlPre && !b.closest('[data-crawl-pre]'))) for (const el of box.querySelectorAll(CTRL)) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') out.push({ tag: el.tagName.toLowerCase(), txt: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40), aria: el.getAttribute('aria-label') || el.title || '', disabled: !!el.disabled, submit: el.type === 'submit' && !!el.form, ai: !!el.closest(AI_BOX), inner: true }); } return out; }, { CTRL, OPEN_SEL, AI_BOX }).catch(() => []);
      // tap-outside closes it?
      const vp = page.viewportSize();
      const spot = await page.evaluate(({ OPEN_SEL, w, h }) => { const boxSel = OPEN_SEL.replace(/:not\(\[hidden\]\)/g, '');
        for (const [x, y] of [[w / 2, h - 40], [12, h / 2], [w - 12, h / 2], [w / 2, 90]]) { const t = document.elementFromPoint(x, y); if (t && !t.closest(boxSel) && !t.closest('a,button,input,select,textarea,summary,label,[role=button],nav,header,.tabbar')) return { x, y }; } return null; }, { OPEN_SEL, w: vp.width, h: vp.height }).catch(() => null);
      const isMenu = await page.evaluate((MENU_SEL) => [...document.querySelectorAll(MENU_SEL)].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(m).visibility !== 'hidden' && !m.closest('details:not([open])'); }).length > 0, MENU_SEL).catch(() => false);
      if (spot && isMenu) { if (DEVICE[devName].touch) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y); await sleep(500);
        const still = await page.evaluate((MENU_SEL) => [...document.querySelectorAll(MENU_SEL)].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(m).visibility !== 'hidden' && !m.closest('details:not([open])'); }).length, MENU_SEL).catch(() => 0);
        const scrimDialog = await page.evaluate(() => !!document.querySelector('.scrim, [role=dialog][aria-modal=true]')).catch(() => false);
        if (still > 0 && !scrimDialog) { const r2 = { kind: 'outside-tap', pat, route: u, label, result: 'NOT_CLOSED', shot: await shot(`outside-${pat}-${label}`) }; fail(r2); } }
      const seenIn = {};
      for (const ic of innerCtrls) {
        const isig = `${pat}|in|${label}|${ic.tag}|${ic.txt}|${ic.aria}`; if (tapped.has(isig)) continue; tapped.add(isig);
        const ilabel = `${label} › ${ic.txt || ic.aria || ic.tag}`;
        if (ic.disabled) { rec({ kind: 'tap', role, device: devName, pat, label: ilabel, result: 'DISABLED' }); continue; }
        const aiBox = (ic.ai || /물어보기|✦|AI/.test(label)) && !isClose(ic.txt || ic.aria);   // AI panels / dialogs: their buttons run a paid AI call
        if (aiBox || noPress(`${ic.txt} ${ic.aria}`) || (ic.submit && !WRITES)) { { const o = { kind: 'tap', role, device: devName, pat, label: ilabel, result: 'NOT_PRESSED' }; rec(o); skipped(o); } continue; }
        await load(u); const re = await tapOne(c, occ, u, pat, label, true); if (!re) continue;   // reopen
        const occIn = (seenIn[isig] = (seenIn[isig] ?? -1) + 1);
        await tapOne(ic, occIn, u, pat, ilabel, true);
      }
      return { dirty: true };
    }
    return { dirty: result !== 'NONE' && result !== 'CHANGE' ? true : result === 'CHANGE' && (a.open > 0) };
  }
  await browser.close();
}

// ---------- every href / asset / download / external link: one request each ----------
async function checkResources() {
  const b = await chromium.launch(); const ctxs = {};
  for (const role of ROLES) { const c = await b.newContext(); if (role === 'anon' || (await login(c, role))) ctxs[role] = c; }
  for (const [u, meta] of resources) {
    if (/^mailto:/.test(u)) { const ok = /^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(u.split('?')[0]); rec({ kind: 'href', url: u, ok, from: meta.from }); if (!ok) failures.push({ kind: 'href', url: u, status: 'bad mailto', from: meta.from }); continue; }
    if (/^tel:|^javascript:/.test(u)) continue;
    const c = ctxs[meta.role] || ctxs.anon || Object.values(ctxs)[0]; const internal = u.startsWith(BASE);
    if (internal) await paced(SOFT_PACE, 'tap');
    let status = 0, type = '', size = 0, err = '';
    try { const r = await c.request.get(u, { timeout: 20000, maxRedirects: 5, headers: internal ? { origin: BASE } : { 'user-agent': 'Mozilla/5.0 RELAI link check' } }); status = r.status(); type = r.headers()['content-type'] || ''; size = (await r.body()).length; }
    catch (e) { err = e.message.slice(0, 120); }
    const bad = status === 0 || status >= 400 || (internal && size === 0 && status !== 204);
    const row = { kind: 'href', url: u.replace(BASE, ''), status, type: type.split(';')[0], size, from: meta.from, role: meta.role, text: meta.text, err };
    rec(row); if (bad && !(status === 403 && !internal) && !(status === 999)) failures.push(row);   // 403/999 from LinkedIn-style bot walls are noted, not failed
  }
  await b.close();
}

function summary() {
  const cols = []; for (const d of DEVICES) for (const r of ROLES) cols.push(`${d}/${r}`);
  const np = Object.entries(notPressed).sort((a, b) => b[1].size - a[1].size);
  const lines = [`# RELAI prod crawl — ${BASE} — ${new Date().toISOString()}`, '',
    `Failures: **${failures.length}** · mode: **${WRITES ? 'WRITES (QA accounts: write buttons and submits pressed)' : 'READ-ONLY (write buttons NOT pressed)'}**`, '',
    '## Not tested — read this first', '',
    `- Never pressed by design: AI start / credit spend, payment, invite, delete, logout, project archive/close/reopen, phase moves${WRITES ? '' : ', and every write button / form submit (read-only mode)'}.`,
    ...combos.map((c) => `- ${c}`),
    `- Roles not requested: ${['anon', 'owner', 'member', 'admin'].filter((r) => !ROLES.includes(r)).join(', ') || 'none'}. Devices: ${DEVICES.join(', ')}.`,
    `- ${np.length} distinct controls were seen but NOT pressed:`, '',
    ...np.slice(0, 80).map(([k, v]) => `  - ${k} — ${v.size}× (${[...v][0]})`), ...(np.length > 80 ? [`  - … ${np.length - 80} more in results.jsonl (result NOT_PRESSED)`] : []), '', '## Route × device/role', '', `| route | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`];
  for (const pat of Object.keys(matrix).sort()) lines.push(`| \`${pat}\` | ${cols.map((c) => (matrix[pat][c] === 'FAIL' ? '**FAIL**' : matrix[pat][c] ? 'ok' : '–')).join(' | ')} |`);
  lines.push('', '## Failures', '');
  for (const f of failures) lines.push(`- [${f.device || '-'}/${f.role || '-'}] ${f.kind} ${f.route || f.url || f.pat || ''} ${f.label ? `· ${f.label}` : ''} → ${f.result || f.status || ''} ${f.errText || ''} ${(f.errs || []).join(' ; ')} ${f.coveredBy ? `covered by ${f.coveredBy}` : ''} ${f.shot ? `(shots/${f.shot})` : ''}`);
  fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'failures.json'), JSON.stringify(failures, null, 1));
}

(async () => {
  for (const role of ROLES) for (const d of DEVICES) { console.log(`▶ ${role}/${d} ${new Date().toISOString()}`); await runCombo(role, d); summary(); }
  console.log(`▶ links/assets ${resources.size}`); await checkResources(); summary();
  console.log(`done: ${failures.length} failures → ${path.join(OUT, 'summary.md')}`);
  process.exit(failures.length ? 1 : 0);
})();
