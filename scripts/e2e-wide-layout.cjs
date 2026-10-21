// Wide-screen layout check (founder 2026-10-21, 4K monitor at 150% = 2560 CSS px; laptop = 1707 CSS px).
// For every main page at 1280/1366/1440/1707/1920/2560 (+ 1707 at zoom 125/150 via deviceScaleFactor-free CSS zoom
// emulation = narrower viewport) and tablet 1024/820 + phone 390: horizontal overflow, the width the content actually uses
// inside the main column (leaf boxes' left/right span), and a screenshot. Not part of `npm test` (needs a running server
// with samples on and Playwright):
//   BASE=http://127.0.0.1:3177 SHOTS=/tmp/wide OUT=/tmp/wide.json DATABASE_URL=postgres://… node scripts/e2e-wide-layout.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3177';
const SHOTS = process.env.SHOTS || 'wide-shots';
const OUT = process.env.OUT || `${SHOTS}/metrics.json`;
fs.mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
// zoom 125/150 % on the laptop (1707 CSS px at 100 %) = 1366 / 1138 CSS px; on the 4K monitor (2560) = 2048 / 1707.
const SIZES = (process.env.SIZES || '390x844,820x1180,1024x768,1138x711,1280x800,1366x768,1440x900,1707x1067,1920x1080,2048x1152,2560x1440')
  .split(',').map((s) => s.split('x').map(Number));
const PHONE = (w) => w < 768;

(async () => {
  try { sql('DELETE FROM rate_limits'); } catch {}
  const browser = await chromium.launch();
  const api = async (page, method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const email = process.env.EMAIL || 'wide-layout@relai.test';
  const sc = await browser.newContext(); const sp = await sc.newPage();
  let r = await api(sp, 'POST', '/api/auth/login', { email, password: 'passw0rd!' });
  if (r.status !== 200) {
    r = await api(sp, 'POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김와이드', email, password: 'passw0rd!' });
    sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  }
  const me = await api(sp, 'GET', '/api/auth/me');
  const w = (me.json.workspaces || r.json.workspaces)[0].id;
  for (const k of ['welcome', 'product_tour']) await api(sp, 'POST', `/api/workspaces/${w}/onboarding/${k}/skip`, {});
  const projects = (await api(sp, 'GET', `/api/workspaces/${w}/projects`)).json.projects;
  const p = projects.find((x) => x.sample_key === 'mid') || projects[0];
  const cookies = (await sc.storageState()).cookies; await sc.close();
  const PAGES = [
    ['home', '/app'], ['projects', '/app/projects'], ['new', '/app/projects/new'], ['settings', '/app/settings'], ['credits', '/app/settings/credits'],
    ['p-home', `/app/projects/${p.id}`], ['p-overview', `/app/projects/${p.id}/overview`], ['p-req', `/app/projects/${p.id}/requirements`],
    ['p-wbs', `/app/projects/${p.id}/wbs`], ['p-changes', `/app/projects/${p.id}/changes`], ['p-issues', `/app/projects/${p.id}/issues`],
    ['p-tests', `/app/projects/${p.id}/tests`], ['p-reports', `/app/projects/${p.id}/reports`], ['p-edit', `/app/projects/${p.id}/edit`],
  ].filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').includes(n));
  const out = [];
  for (const [vw, vh] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, locale: 'ko-KR', ...(PHONE(vw) ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    for (const [name, url] of PAGES) {
      await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => !/불러오는 중|확인 중…/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const se = document.scrollingElement;
        const main = document.querySelector('.maincol') || document.querySelector('.main') || document.body;
        const mr = main.getBoundingClientRect();
        let L = Infinity, R = -Infinity;
        for (const el of main.querySelectorAll('*')) {
          if (el.closest('.wsh,.dtop,.appfoot,.topbar,header')) continue;
          const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const b = el.getBoundingClientRect(); if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight * 2) continue;
          const leaf = !el.children.length || /^(TABLE|INPUT|SELECT|TEXTAREA|BUTTON|IMG|SVG|CANVAS)$/i.test(el.tagName);
          const boxed = cs.borderLeftWidth !== '0px' || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && b.width < mr.width - 4);
          if (!leaf && !boxed) continue;
          L = Math.min(L, b.left); R = Math.max(R, b.right);
        }
        const pg = document.querySelector('.page'); const pr = pg ? pg.getBoundingClientRect() : null;
        const rail = document.querySelector('.side'); const rr = rail ? rail.getBoundingClientRect() : null;
        return { h: se.scrollWidth - innerWidth, main: Math.round(mr.width), mainLeft: Math.round(mr.left), railW: rr ? Math.round(rr.width) : 0,
          page: pr ? Math.round(pr.width) : null, used: Number.isFinite(L) ? Math.round(R - L) : null, usedL: Math.round(L - mr.left), usedR: Math.round(mr.right - R) };
      });
      m.ratio = m.used ? +(m.used / m.main).toFixed(2) : null;
      out.push({ vw, vh, name, ...m });
      console.log(`${vw}x${vh} ${name.padEnd(11)} hOverflow=${m.h} rail=${m.railW} main=${m.main} used=${m.used} (${m.ratio}) gapL=${m.usedL} gapR=${m.usedR}`);
      await page.screenshot({ path: `${SHOTS}/${name}-${vw}.png` });
    }
    await ctx.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
