// Layout fit (founder 2026-10-19): login, signup and every guidance screen (account pages, invitation landing, empty list
// screens, the first-run guide, explain-only dialogs) fit ONE screen — no vertical page scroll — at 1366×768, 1440×900,
// 1920×1080 and 390×844. Work screens may scroll, but share one look on PC: 20px page title, 32px header/toolbar controls,
// 36px list rows, no stray footer scroll under the full-height lists, 사업수행계획서 내려받기 in the 프로젝트 개요 header,
// one phase-chip wording ('04 구현', never '03 분석·설계 업무') and the 이슈 · 리스크 tab counts on every tab of that group (batch5 P2-2/3).
// Not part of `npm test` (needs a running server with samples on — SAMPLE_PROJECTS unset — and Playwright):
//   BASE=http://127.0.0.1:3171 SHOTS=/tmp/layout-fit DATABASE_URL=postgres://… SESSION_SECRET=<server's> node scripts/e2e-layout-fit.cjs
// Run it once more with Google sign-in configured (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI, GOOGLE_PROVIDER=fake): the Google
// button must still fit.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3171';
const SHOTS = process.env.SHOTS || 'layout-fit-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const SIZES = [[1366, 768], [1440, 900], [1920, 1080], [390, 844]];
const PHONE = (w) => w < 768;

(async () => {
  sql('DELETE FROM rate_limits');
  const browser = await chromium.launch();
  const errors = [];
  const ctxFor = (w, h) => browser.newContext({ viewport: { width: w, height: h }, locale: 'ko-KR', ...(PHONE(w) ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const api = async (page, method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  /** Vertical page overflow in px (0 = fits one screen) and horizontal overflow. */
  const fit = (page) => page.evaluate(() => { const se = document.scrollingElement; return { v: se.scrollHeight - innerHeight, h: se.scrollWidth - innerWidth }; });
  const settle = async (page, sel) => { if (sel) await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForFunction(() => !/불러오는 중|확인 중…/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(700); };
  const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

  /* ---------- seed: an owner with the sample projects, an empty project of their own, and a pending invitation ---------- */
  const sc = await browser.newContext(); const sp = await sc.newPage();
  const email = `lfit-${Date.now()}@relai.test`;
  const s = await api(sp, 'POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김배치', email, password: 'passw0rd!' });
  check('seed: signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id; sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  for (const k of ['welcome', 'product_tour']) await api(sp, 'POST', `/api/workspaces/${w}/onboarding/${k}/skip`, {});
  const mid = (await api(sp, 'GET', `/api/workspaces/${w}/projects`)).json.projects.find((p) => p.sample_key === 'mid');
  check('seed: sample project 새솔유통 (needs SAMPLE_PROJECTS on)', Boolean(mid));
  const ep = await api(sp, 'POST', `/api/workspaces/${w}/projects`, { name: '빈 프로젝트', client_name: '테스트고객', project_type: 'NEW_BUILD', planned_start_date: '2026-10-01', planned_end_date: '2027-03-31' });
  const eid = ep.json?.project?.id || ep.json?.id; check('seed: empty project', Boolean(eid), JSON.stringify(ep.json).slice(0, 200));
  const inv = await api(sp, 'POST', `/api/workspaces/${w}/invitations`, { email: `lfit-inv-${Date.now()}@relai.test`, name: '초대받음', role: 'MEMBER' });
  // the raw token only travels by e-mail; with the server's SESSION_SECRET we pin a known one (DB keeps sha256('invite:<secret>:<token>'))
  let invToken = '';
  if (inv.status < 300 && process.env.SESSION_SECRET) {
    invToken = `lfit${Date.now()}`;
    sql(`UPDATE invitations SET token_hash = encode(sha256(convert_to('invite:${process.env.SESSION_SECRET}:${invToken}', 'UTF8')), 'hex') WHERE workspace_id = '${w}' AND status = 'PENDING'`);
  }
  check('seed: pending member invitation (set SESSION_SECRET to also check the invitation landing)', inv.status < 300, JSON.stringify(inv.json).slice(0, 200));
  const cookies = (await sc.storageState()).cookies; await sc.close();

  const PUBLIC = [['/login', '#email'], ['/signup', '#name'], ['/login?error=google_denied', '#email'], ['/signup?invite=bad-token', '#name'],
    ['/forgot-password', '#email'], ['/reset-password', '.auth'], ['/reset-password?token=abc', '#password'], ['/verify-email?token=bad', '.auth .btn'], ['/invite/bad-token', '.auth h1'],
    ...(invToken ? [[`/invite/${invToken}`, '.auth h1'], [`/signup?invite=${invToken}`, '#name']] : [])];
  const EMPTY = eid ? ['requirements', 'wbs', 'issues', 'changes', 'tests'].map((t) => `/app/projects/${eid}/${t}`) : [];
  const label = (u) => u.replace(eid, '<빈 프로젝트>').replace(invToken || '@@', '<초대>');

  for (const [vw, vh] of SIZES) {
    const tag = `${vw}x${vh}`;
    /* ---------- auth + account screens (logged out) ---------- */
    const pc = await ctxFor(vw, vh); const pg = await pc.newPage(); pg.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
    for (const [u, sel] of PUBLIC) {
      await pg.goto(BASE + u); await settle(pg, sel);
      const f = await fit(pg);
      check(`${tag} ${label(u)}: fits one screen, no vertical scroll`, f.v <= 0 && f.h <= 0, JSON.stringify(f));
      if (/^\/(login|signup)$/.test(u)) await shot(pg, `${tag}${u.replace('/', '-')}`);
    }
    // the form is still all there: submit button and the sign-up/log-in switch are on screen, not cut off
    await pg.goto(`${BASE}/signup`); await settle(pg, '#name');
    const su = await pg.evaluate(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const b = r('#f button[type=submit]'); const a = r('.auth__alt'); const c = r('#consent');
      return { btn: b && b.bottom <= innerHeight, alt: a && a.bottom <= innerHeight, consent: Boolean(c), biz: /551-25-02019/.test(document.querySelector('.legal-foot')?.textContent || '') }; });
    check(`${tag} /signup: 전체 동의 + submit + 로그인 link on screen, business info still in the footer (folded)`, su.btn && su.alt && su.consent && su.biz, JSON.stringify(su));
    await pc.close();

    /* ---------- guidance screens (logged in): empty list screens ---------- */
    const ac = await ctxFor(vw, vh); await ac.addCookies(cookies); const ap = await ac.newPage(); ap.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
    for (const u of EMPTY) {
      await ap.goto(BASE + u); await settle(ap, '#main');
      const f = await fit(ap);
      check(`${tag} ${label(u)} (empty state): fits one screen`, f.v <= 0 && f.h <= 0, JSON.stringify(f));
    }
    if (EMPTY.length) await shot(ap, `${tag}-empty-requirements`);
    /* ---------- an explain-only dialog never runs past the window ---------- */
    await ap.goto(`${BASE}/app/projects/${eid || mid.id}/requirements`); await settle(ap, '#main');
    const dlg = await ap.evaluate(() => { const sc = document.createElement('div'); sc.className = 'scrim'; sc.innerHTML = `<div class="dialog" role="dialog"><h3>안내</h3><p>${'설명 문장입니다. '.repeat(400)}</p><div class="actions"><button class="btn btn--primary">확인</button></div></div>`;
      document.body.append(sc); const r = sc.firstChild.getBoundingClientRect(); const out = { top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom), scrolls: sc.firstChild.scrollHeight > sc.firstChild.clientHeight }; sc.remove(); return out; });
    check(`${tag} long explain dialog stays inside the window (scrolls inside)`, dlg.top >= 0 && dlg.bottom >= 0 && dlg.scrolls, JSON.stringify(dlg));

    /* ---------- work screens on PC: one look ---------- */
    if (!PHONE(vw) && mid) {
      const looks = [];
      for (const t of ['', 'definition', 'charter', 'wbs', 'issues', 'requirements', 'changes', 'tests']) {
        await ap.goto(`${BASE}/app/projects/${mid.id}${t ? `/${t}` : ''}`); await settle(ap, '.phead__title');
        looks.push({ t: t || 'home', ...(await ap.evaluate(() => { const ti = document.querySelector('.phead__title'); const cs = getComputedStyle(ti); const x = Math.round(ti.getBoundingClientRect().left);
          const ctl = [...document.querySelectorAll('.phead__r .btn, .rtool .btn:not(.btn--xs), .rtool .input, .rtool .select')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));
          const rows = [...document.querySelectorAll('.rtable tbody tr, .gtable tbody tr')].filter((e) => e.offsetParent).slice(0, 3).map((e) => Math.round(e.getBoundingClientRect().height));
          const chip = document.querySelector('.phead .pchip'); const n = (k) => document.querySelector(`.stabs [data-stab="${k}"] .stabs__n`)?.textContent || '';
          return { fs: cs.fontSize, fw: cs.fontWeight, x, ctl: [...new Set(ctl)], rows: [...new Set(rows)], v: document.scrollingElement.scrollHeight - innerHeight, list: Boolean(document.querySelector('.page--wide>.rlayout')),
            chip: chip ? chip.textContent.trim() : '', badges: `${n('raid')}/${n('risks')}` }; })) });
      }
      const x0 = looks[0].x;
      check(`${tag} work screens: title 20px/800 at the same left edge`, looks.every((l) => l.fs === '20px' && l.fw === '800' && Math.abs(l.x - x0) <= 1), JSON.stringify(looks.map((l) => [l.t, l.fs, l.fw, l.x])));
      check(`${tag} work screens: header + toolbar controls are 32px`, looks.every((l) => l.ctl.every((h) => h === 32)), JSON.stringify(looks.map((l) => [l.t, l.ctl])));
      check(`${tag} list screens: rows 36px (both table kinds)`, looks.filter((l) => ['wbs', 'issues', 'requirements'].includes(l.t)).every((l) => l.rows.length && l.rows.every((h) => h === 36)), JSON.stringify(looks.map((l) => [l.t, l.rows])));
      const chips = looks.filter((l) => l.chip);
      check(`${tag} P2-2 phase chips: one wording "NN 단계명" (no 업무 suffix) on every work screen`, chips.length >= 4 && chips.every((l) => /^\d{2} [^\s].*$/.test(l.chip) && !/업무$/.test(l.chip)), JSON.stringify(chips.map((l) => [l.t, l.chip])));
      const iss = looks.find((l) => l.t === 'issues'); const chg = looks.find((l) => l.t === 'changes');
      check(`${tag} P2-3 변경 요청 tab keeps the 이슈 · 리스크 counts shown on 이슈`, iss.badges !== '/' && chg.badges === iss.badges, JSON.stringify({ issues: iss.badges, changes: chg.badges }));
      check(`${tag} full-height lists: the table scrolls, the page does not (no footer strip)`, looks.filter((l) => l.list).every((l) => l.v <= 0), JSON.stringify(looks.filter((l) => l.list).map((l) => [l.t, l.v])));
      await ap.goto(`${BASE}/app/projects/${mid.id}/charter`); await settle(ap, '.chx');
      const ch = await ap.evaluate(() => ({ inHead: Boolean(document.querySelector('.phead__r .pmenu [data-plan="pdf"]')), oldRow: Boolean(document.querySelector('.chx__head')) }));
      check(`${tag} 프로젝트 개요: 사업수행계획서 내려받기 sits in the page header`, ch.inHead && !ch.oldRow, JSON.stringify(ch));
      for (const t of ['', '/app/settings', '/app/projects']) { if (!t) continue; await ap.goto(BASE + t); await settle(ap, '.page__head h1');
        const h = await ap.evaluate(() => { const e = document.querySelector('.page__head h1'); const cs = getComputedStyle(e); return { fs: cs.fontSize, fw: cs.fontWeight }; });
        check(`${tag} ${t}: page title matches the project pages (20px/800)`, h.fs === '20px' && h.fw === '800', JSON.stringify(h)); }
      if (vw === 1440) { await ap.goto(`${BASE}/app/projects/${mid.id}/wbs`); await settle(ap, '.gtable'); await shot(ap, `${tag}-wbs`); await ap.goto(`${BASE}/app/projects/${mid.id}/charter`); await settle(ap, '.chx'); await shot(ap, `${tag}-charter`); }
    }
    await ac.close();

    /* ---------- first-run guide (new owner, /app?welcome=1): every step's card is inside the window ---------- */
    const tc = await ctxFor(vw, vh); const tp = await tc.newPage();
    await api(tp, 'POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '박환영', email: `lfit-w-${Date.now()}-${vw}@relai.test`, password: 'passw0rd!' });
    await tp.goto(`${BASE}/app?welcome=1`); await settle(tp, '#main'); await tp.waitForTimeout(800);
    let steps = 0; const bad = [];
    for (let i = 0; i < 10; i++) {
      if (!(await tp.$('.tour__pop'))) break;
      const r = await tp.evaluate(() => { const b = document.querySelector('.tour__pop').getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(innerHeight - b.bottom), step: document.querySelector('.tour__step')?.textContent }; });
      steps++; if (r.top < 0 || r.bottom < 0) bad.push(r);
      const nx = await tp.$('.tour__pop [data-t="next"], .tour__pop [data-t="skip"]'); if (!nx) break; await nx.click(); await tp.waitForTimeout(1000);
    }
    if (!PHONE(vw)) check(`${tag} first-run guide: ${steps} step card(s), each fully inside the window`, steps > 0 && !bad.length, JSON.stringify(bad));
    await tc.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
