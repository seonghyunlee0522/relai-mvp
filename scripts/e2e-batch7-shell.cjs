// batch7 T1 — shell & design system (hive research/relai-batch7-spec.md #1 #8 #9 #12 #14 #17 #19 #22, B1 · B2 · B5):
// the detail panel sits right next to the list at 2560 / 1920 / 1440 / 1280 (gap ≤ 24px, width = clamp(480px, 34vw, 760px),
// overlay below 1280), a dragged width survives a reload, the top-bar 다음 할 일 strip (and its refresh after a save), tab-bar
// overflow ‹ ›, WBS detail tabs on one line, the RELAI에게 물어보기 button, always-on checkboxes + 컬럼 outside ⋯, status / priority
// tags, and 보고서 › 활동 기록 as a full page.
// Not part of `npm test` (needs a running server with samples on — SAMPLE_PROJECTS unset — and Playwright). AI = the fake
// provider (AI_PROVIDER=fake) for the RELAI에게 물어보기 checks; with AI off those checks are skipped:
//   BASE=http://127.0.0.1:3471 SHOTS=/tmp/b7-shell DATABASE_URL=postgres://… node scripts/e2e-batch7-shell.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3471';
const SHOTS = process.env.SHOTS || 'b7-shell-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => (process.env.DATABASE_URL ? execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim() : '');
const panelW = (w) => Math.round(Math.min(760, Math.max(480, w * 0.34)));
const lum = (rgb) => { const c = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

(async () => {
  sql('DELETE FROM rate_limits');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const settle = async (sel) => { if (sel) await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForFunction(() => !/불러오는 중/.test(document.querySelector('#main')?.textContent || '불러오는 중'), null, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(400); };
  const go = async (u, sel) => { await page.goto(BASE + u); await settle(sel); };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

  /* ---------- seed: an owner with the sample projects (새솔유통 = 04 구현) ---------- */
  const email = `b7shell-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김배치', email, password: 'passw0rd!' });
  check('seed: signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id; sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  for (const k of ['welcome', 'product_tour']) await api('POST', `/api/workspaces/${w}/onboarding/${k}/skip`, {});
  const by = Object.fromEntries((await api('GET', `/api/workspaces/${w}/projects`)).json.projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p]));
  check('seed: sample project 새솔유통 (needs SAMPLE_PROJECTS on)', Boolean(by.mid), JSON.stringify(Object.keys(by)));
  const M = `/app/projects/${by.mid.id}`;
  const ai = (await api('GET', `/api/workspaces/${w}/projects/${by.mid.id}/ai/status`)).json || {};

  /* ---------- #1 · #19 B1: the panel right next to the list ---------- */
  const geo = (list) => page.evaluate((ls) => {
    const d = document.querySelector('#drawer'); const t = document.querySelector(ls); if (!d || !t) return null;
    const dr = d.getBoundingClientRect(); const tr = t.getBoundingClientRect();
    return { dl: Math.round(dr.left), dw: Math.round(dr.width), dr: Math.round(innerWidth - dr.right), tr: Math.round(tr.right), pos: getComputedStyle(d).position, hs: document.scrollingElement.scrollWidth - innerWidth, vw: innerWidth };
  }, list);
  for (const W of [2560, 1920, 1440, 1280, 1180]) {
    await page.setViewportSize({ width: W, height: W >= 1920 ? 1080 : 900 });
    for (const [what, url, row, list] of [['요구사항', `${M}/requirements`, '#grid tbody tr[data-id] td.ttl', '#grid .gtable'], ['WBS', `${M}/wbs`, '#grid tbody tr[data-id] .wtitle__t', '#grid .gtable'], ['이슈', `${M}/issues`, '.rtable tbody tr[data-row]', '.rtable']]) {
      await go(url, row); await page.click(row); await page.waitForSelector('#drawer:not([hidden]) .drawer__h', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500);
      const g = await geo(list);
      if (!g) { check(`B1 ${W} ${what}: drawer opened`, false); continue; }
      if (W >= 1280) {
        const narrow = g.tr < g.vw - g.dw - 40;   // the table is narrower than the screen → the panel must hug it
        check(`B1 ${W} ${what}: panel in the flow next to the table (gap ${g.dl - g.tr}px ≤ 24), width ${g.dw} = clamp(480, 34vw, 760), no sideways scroll`,
          g.pos !== 'fixed' && (!narrow || (g.dl - g.tr >= -1 && g.dl - g.tr <= 24)) && Math.abs(g.dw - panelW(W)) <= 1 && g.hs <= 0, JSON.stringify(g));
      } else check(`B1 ${W} ${what}: below 1280 the panel overlays the right edge (as before)`, g.pos === 'fixed' && g.dr === 0 && g.hs <= 0, JSON.stringify(g));
      if (what === '요구사항') await shot(`b1-${W}-req`);
      if (what === 'WBS' && (W === 2560 || W === 1280)) await shot(`b1-${W}-wbs`);
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(`${M}/requirements`, '#grid'); await page.click('#grid tbody tr[data-id] td.ttl'); await page.waitForSelector('#drawer:not([hidden]) .drawer__h');
  const w0 = (await geo('#grid .gtable')).dw;
  check('#19 at 1920 the detail panel is ≥ 650px', w0 >= 650, String(w0));
  const box = await page.$eval('#drawer', (d) => { const r = d.getBoundingClientRect(); return { x: r.left + 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x - 60, box.y, { steps: 4 }); await page.mouse.move(box.x - 120, box.y, { steps: 4 }); await page.mouse.up();
  const w1 = (await geo('#grid .gtable')).dw;
  await page.reload(); await settle('#grid'); if (!(await page.$('#drawer:not([hidden])'))) { await page.click('#grid tbody tr[data-id] td.ttl'); await page.waitForSelector('#drawer:not([hidden]) .drawer__h'); }
  await page.waitForTimeout(300); const w2 = (await geo('#grid .gtable')).dw;
  check('#19 dragging the panel edge widens it (480–960) and the width is kept after a reload', w1 >= w0 + 100 && Math.abs(w2 - w1) <= 2, JSON.stringify({ w0, w1, w2 }));
  await page.mouse.dblclick(box.x - 120 + 2, box.y); await page.waitForTimeout(300);
  const w3 = (await geo('#grid .gtable')).dw;
  check('#19 double-clicking the edge returns to the default width', Math.abs(w3 - w0) <= 2, JSON.stringify({ w0, w3 }));

  /* ---------- #12 B2: status / priority tags in the requirement list ---------- */
  const tagLook = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#grid tbody tr[data-id]')];
    const pick = (re) => rows.map((r) => r.querySelector('[data-label="상태"] .tsel, [data-label="상태"] .chip, [data-label="상태"] .tag')).find((e) => e && re.test(e.textContent));
    const pr = (re) => rows.map((r) => r.querySelector('[data-label="우선순위"] .tsel, [data-label="우선순위"] .prio')).find((e) => e && (re.test(e.textContent) || re.test(e.querySelector('select')?.selectedOptions[0]?.textContent || '')));
    const cs = (e) => (e ? { bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color, cls: e.className, mark: getComputedStyle(e, '::before').content + (e.querySelector('i')?.textContent || '') } : null);
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return { ok: cs(pick(/확정/)), draft: cs(pick(/작성 중/)), high: cs(pr(/높음/)), low: cs(pr(/낮음/)), tok: { done: v('--tag-done-bg'), draft: v('--tag-draft-bg'), hi: v('--prio-high'), lo: v('--prio-low') } };
  });
  const hex = (h) => { const m = h.replace('#', '').match(/../g).map((x) => parseInt(x, 16)); return `rgb(${m.join(', ')})`; };
  check('#12 요구사항 목록: 확정 = 초록 tag, 작성 중 = 노랑 tag (label shown)', tagLook.ok && tagLook.draft && tagLook.ok.bg === hex(tagLook.tok.done) && tagLook.draft.bg === hex(tagLook.tok.draft), JSON.stringify(tagLook));
  check('#12 요구사항 목록: 높음 = 빨강 ▲, 낮음 = 파랑 ▼', tagLook.high && tagLook.low && tagLook.high.fg === hex(tagLook.tok.hi) && /▲/.test(tagLook.high.mark) && tagLook.low.fg === hex(tagLook.tok.lo) && /▼/.test(tagLook.low.mark), JSON.stringify({ h: tagLook.high, l: tagLook.low }));
  check('#12 tag text contrast ≥ 4.5:1 (확정 · 작성 중)', tagLook.ok && contrast(tagLook.ok.fg, tagLook.ok.bg) >= 4.5 && contrast(tagLook.draft.fg, tagLook.draft.bg) >= 4.5,
    tagLook.ok ? `${contrast(tagLook.ok.fg, tagLook.ok.bg).toFixed(2)} / ${contrast(tagLook.draft.fg, tagLook.draft.bg).toFixed(2)}` : '');
  const tones = await page.evaluate(() => [...document.styleSheets].length && ['done', 'active', 'draft', 'hold', 'bad', 'muted'].map((t) => { const e = document.createElement('span'); e.className = `tag tag--${t}`; e.textContent = 'x'; document.body.append(e); const c = getComputedStyle(e); const r = [t, c.color, c.backgroundColor]; e.remove(); return r; }));
  check('#12 every tag tone (done · active · draft · hold · bad · muted) has text contrast ≥ 4.5:1', tones.every(([, fg, bg]) => contrast(fg, bg) >= 4.5), JSON.stringify(tones.map(([t, fg, bg]) => [t, contrast(fg, bg).toFixed(2)])));
  await shot('b2-req-tags');

  /* ---------- #9: checkboxes always, 컬럼 outside ⋯ ---------- */
  await page.click('#drawer .drawer__x').catch(() => {}); await page.waitForTimeout(300);
  const c9 = await page.evaluate(() => ({ first: document.querySelector('#grid thead th')?.classList.contains('gc--chk'), cols: Boolean(document.querySelector('[data-rtool-r2] > .gtools [data-gcols]')), menu: document.querySelector('[data-rtool-r2] .tmenu')?.textContent || '' }));
  check('#9 1440+ 요구사항 목록: first column is the checkbox; 컬럼 sits in the toolbar; ⋯ has no 여러 개 선택 / 컬럼', c9.first && c9.cols && !/여러 개 선택/.test(c9.menu) && !/컬럼/.test(c9.menu), JSON.stringify({ ...c9, menu: c9.menu.slice(0, 80) }));
  const picks = await page.$$('#grid tbody [data-pick]'); await picks[0].check(); await picks[1].check(); await page.waitForTimeout(300);
  const bulk = await page.evaluate(() => { const b = document.querySelector('#bulkslot .bulk'); return b ? { n: b.querySelector('[data-bcount]')?.textContent, vis: b.getBoundingClientRect().height > 0 } : null; });
  check('#9 selecting 2 rows shows the bulk bar (2건 선택)', bulk && bulk.vis && bulk.n === '2', JSON.stringify(bulk));
  await shot('b9-req-bulk');
  const e0 = errors.length; await go(`${M}/requirements?select=1`, '#grid');
  check('#9 an old ?select=1 link still opens without errors (checkboxes on)', errors.length === e0 && (await page.$$('#grid tbody [data-pick]')).length > 0);
  await go(`${M}/wbs`, '#grid');
  const w9 = await page.evaluate(() => ({ chk: document.querySelectorAll('#grid tbody [data-pick]').length, cols: Boolean(document.querySelector('[data-rtool-r2] > .gtools [data-gcols]')), menu: document.querySelector('[data-rtool-r2] .tmenu')?.textContent || '' }));
  check('#9 WBS: checkboxes always shown, 컬럼 outside ⋯ (same grid default)', w9.chk > 0 && w9.cols && !/여러 개 선택/.test(w9.menu), JSON.stringify({ ...w9, menu: w9.menu.slice(0, 60) }));

  /* ---------- #14: WBS detail tabs on one line at 1280; overflow shows › ---------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  await go(`${M}/wbs`, '#grid'); await page.click('#grid tbody tr[data-id] .wtitle__t'); await page.waitForSelector('#drawer:not([hidden]) .dtabs'); await page.waitForTimeout(400);
  const t14 = await page.evaluate(() => { const t = document.querySelector('#drawer .dtabs'); const w = t.closest('[data-dtabs-w]'); const r = t.getBoundingClientRect();
    return { n: t.querySelectorAll('[data-dtab]').length, labels: [...t.querySelectorAll('[data-dtab]')].map((b) => b.childNodes[0].textContent.trim()), allIn: [...t.querySelectorAll('[data-dtab]')].every((b) => b.getBoundingClientRect().right <= r.right + 1), over: w.classList.contains('is-over') }; });
  check('#14 1280 WBS 상세: short tab labels, 지라 hidden without a Jira link (5 tabs), all visible on one line', t14.n === 5 && t14.allIn && !t14.over && JSON.stringify(t14.labels) === JSON.stringify(['기본', '요구사항', '선행', '이력', '댓글']), JSON.stringify(t14));
  await shot('b14-wbs-tabs-1280');
  await page.evaluate(() => { document.querySelector('#drawer [data-dtabs-w]').style.width = '200px'; });
  await page.waitForTimeout(400);
  const ov = await page.evaluate(() => { const w = document.querySelector('#drawer [data-dtabs-w]'); const v = (s) => getComputedStyle(w.querySelector(s)).display !== 'none'; return { over: w.classList.contains('is-over'), r: v('.dtabs__arr--r'), l: v('.dtabs__arr--l') }; });
  await page.click('#drawer .dtabs__arr--r'); await page.waitForTimeout(700);
  const ov2 = await page.evaluate(() => { const w = document.querySelector('#drawer [data-dtabs-w]'); return { left: w.querySelector('.dtabs').scrollLeft, l: getComputedStyle(w.querySelector('.dtabs__arr--l')).display !== 'none' }; });
  check('#14 a tab bar that does not fit shows › (and ‹ after scrolling)', ov.over && ov.r && !ov.l && ov2.left > 0 && ov2.l, JSON.stringify({ ov, ov2 }));
  await shot('b14-tabs-overflow');

  /* ---------- #17 B5: 다음 할 일 strip ---------- */
  await page.setViewportSize({ width: 1440, height: 900 });
  await go(`${M}/requirements`, '#grid'); await page.waitForSelector('#dtop-next:not([hidden])', { timeout: 5000 }).catch(() => {});
  const g17 = (await api('GET', `/api/workspaces/${w}/projects/${by.mid.id}/guidance`)).json.guidance;
  const st = await page.evaluate(() => { const e = document.querySelector('#dtop-next'); const a = e && e.querySelector('[data-next-go]'); return e ? { hidden: e.hidden, text: e.textContent.replace(/\s+/g, ' ').trim(), href: a && a.getAttribute('href'), title: a && a.title, dot: Boolean(e.querySelector('.dnext__dot')) } : null; });
  check('#17 guidance API carries short_title (≤ 30), cta_label, href', g17 && g17.short_title && [...g17.short_title].length <= 30 && g17.cta_label && g17.href, JSON.stringify(g17 && { s: g17.short_title, c: g17.cta_label, h: g17.href }));
  check('#17 PC top bar on 요구사항: "다음 할 일 · <제목>" + 지금 하기 → (to the guidance target); warning dot when there are warnings', st && !st.hidden && /다음 할 일/.test(st.text) && st.text.includes(g17.short_title) && /지금 하기/.test(st.text) && st.href === g17.href && st.dot === Boolean((g17.warnings || []).length), JSON.stringify(st));
  await shot('b17-strip-req');
  await page.click('#dtop-next [data-next-go]'); await settle();
  const dest = new URL(page.url()); check('#17 지금 하기 → opens the guidance target', `${dest.pathname}${dest.search}` === g17.href || dest.pathname === g17.href.split('?')[0], `${dest.pathname}${dest.search} vs ${g17.href}`);
  await go(M, '.phead'); await page.waitForTimeout(300);
  const onNext = await page.evaluate(() => { const e = document.querySelector('#dtop-next'); return e ? { hidden: e.hidden, text: e.textContent.replace(/\s+/g, ' ').trim(), go: Boolean(e.querySelector('[data-next-go]')) } : null; });
  check('#17 on 지금 할 일 the strip shrinks to "단계 진행 n/m" (no duplicate CTA)', onNext && !onNext.hidden && /단계 진행 \d+\/\d+/.test(onNext.text) && !onNext.go, JSON.stringify(onNext));
  // refresh after a save: own project at 02 with one 검토 중 requirement → 확정 in the grid → the strip changes within 3 s
  const pr = await api('POST', `/api/workspaces/${w}/projects`, { name: '스트립 확인', client_name: '테스트고객', project_type: 'NEW_BUILD', planned_start_date: '2026-10-01', planned_end_date: '2027-03-31' });
  const pid = pr.json?.project?.id || pr.json?.id; const PB = `/api/workspaces/${w}/projects/${pid}`;
  const full = (await api('GET', PB)).json; const rq = (full.phases || []).find((x) => x.phase_key === 'REQUIREMENTS');
  await api('POST', `${PB}/phases/${rq.id}/activate`, { reason: 'MANUAL' });
  const r1 = (await api('POST', `${PB}/requirements`, { title: '회원 로그인', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'REVIEWING' })).json.requirement;
  await go(`/app/projects/${pid}/requirements`, '#grid'); await page.waitForSelector('#dtop-next:not([hidden])', { timeout: 5000 }).catch(() => {});
  const before = await page.$eval('#dtop-next .dnext__t', (e) => e.textContent).catch(() => '');
  await page.selectOption(`#grid tr[data-id="${r1.id}"] [data-edit="status"]`, 'CONFIRMED'); const t0 = Date.now();
  let after = before; while (Date.now() - t0 < 3000 && after === before) { await page.waitForTimeout(150); after = await page.$eval('#dtop-next .dnext__t', (e) => e.textContent).catch(() => before); }
  check('#17 확정 in the list → the strip text changes within 3 s', before && after !== before, JSON.stringify({ before, after, ms: Date.now() - t0 }));
  await shot('b17-strip-after-confirm');
  const closed = sql(`UPDATE projects SET status = 'COMPLETED', closed_on = CURRENT_DATE WHERE id = '${pid}'`);
  if (process.env.DATABASE_URL) { await go(`/app/projects/${pid}/requirements`, '#grid'); check('#17 a closed project has no strip', await page.$eval('#dtop-next', (e) => e.hidden).catch(() => true), String(closed)); }

  /* ---------- #8: RELAI에게 물어보기 ---------- */
  if (ai.enabled) {
    await go(`${M}/requirements`, '#grid'); await page.waitForSelector('.phead [data-ai-ask]:not([hidden])', { timeout: 8000 }).catch(() => {});
    const b8 = await page.evaluate(() => { const b = document.querySelector('.phead [data-ai-ask]'); const r = document.querySelector('.phead__r'); const vis = [...r.querySelectorAll('button, a.btn')].filter((x) => x.offsetParent !== null);
      const cs = getComputedStyle(b); const other = vis.filter((x) => x !== b).map((x) => getComputedStyle(x).backgroundColor);
      return { first: vis[0] === b, h: Math.round(b.getBoundingClientRect().height), bg: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor, fg: cs.color, icon: /✦/.test(b.textContent), other, cls: b.className }; });
    const solid = b8.bg.startsWith('rgb') ? b8.bg : 'rgb(232, 236, 249)';
    check('#8 RELAI에게 물어보기: first in the header, brand tint + ✦, 32px, the only coloured secondary', b8.first && b8.icon && b8.h === 32 && b8.bg !== 'rgb(255, 255, 255)' && b8.other.every((o) => o === 'rgb(255, 255, 255)' || o === 'rgba(0, 0, 0, 0)'), JSON.stringify(b8));
    check('#8 its text passes AA (≥ 4.5:1)', contrast(b8.fg, solid) >= 4.5, contrast(b8.fg, solid).toFixed(2));
    await page.click('.phead [data-ai-ask]'); await page.waitForSelector('#ai-q', { timeout: 8000 }).catch(() => {});
    check('#8 the question box suggests "예: 진척률이 계획보다 낮은 이유는?"', /진척률이 계획보다 낮은 이유는/.test(await page.$eval('#ai-q', (t) => t.placeholder).catch(() => '')));
    await shot('b8-ask'); await page.keyboard.press('Escape');
  } else log('SKIP #8 (AI is off on this server — start it with AI_PROVIDER=fake)');

  /* ---------- #22: 보고서 › 활동 기록 = a page ---------- */
  await go(`${M}/reports`, '.stabs');
  await page.click('.stabs [data-stab="activity"]'); await settle('.actpage');
  const a22 = await page.evaluate(() => ({ path: location.pathname, panel: document.querySelectorAll('.actpanel').length, rows: document.querySelectorAll('[data-act-row]').length, days: document.querySelectorAll('[data-act-day]').length,
    w: Math.round(document.querySelector('.actpage').getBoundingClientRect().width), main: Math.round(document.querySelector('#main').getBoundingClientRect().width), tab: document.querySelector('.stabs__i.is-active')?.textContent.trim(), more: Boolean(document.querySelector('#act-more')) }));
  check('#22 보고서 › 활동 기록 → /activity page (full width, grouped by day, no slide-over)', /\/activity$/.test(a22.path) && a22.panel === 0 && a22.rows > 0 && a22.days > 0 && a22.w > a22.main * 0.6 && a22.tab === '활동 기록', JSON.stringify(a22));
  await shot('b22-activity');
  await page.click('[data-act-kind="wbs"]'); await page.waitForTimeout(300);
  const kinds = await page.$$eval('[data-act-row] .actrow__k', (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
  check('#22 종류 filter (WBS) keeps only WBS rows and lands in the URL', kinds.length > 0 && kinds.every((k) => k === 'WBS' || k === '지라') && /kind=wbs/.test(page.url()), JSON.stringify(kinds));
  await page.click('[data-act-kind=""]'); await page.waitForTimeout(200);
  if (a22.more) { const n0 = await page.$$eval('[data-act-row]', (e) => e.length); await page.click('#act-more'); await page.waitForFunction((n) => document.querySelectorAll('[data-act-row]').length > n, n0, { timeout: 8000 }).catch(() => {}); const n1 = await page.$$eval('[data-act-row]', (e) => e.length); check('#22 더 보기 loads older events (?before=)', n1 > n0, `${n0} → ${n1}`); }
  else log('SKIP #22 더 보기 (fewer than 120 events)');
  await page.goBack(); await settle();
  check('#22 Back returns to the previous screen', /\/reports$/.test(new URL(page.url()).pathname), page.url());
  for (const [label, url, sel] of [['⋯ 메뉴', `${M}/requirements`, null], ['지금 할 일 전체 보기', M, '[data-stab-action="activity"]'], ['건강도 전체 보기', `${M}/overview`, '#act-all']]) {
    await go(url, '.phead');
    if (sel) await page.click(sel); else { await page.click('.phead__more'); await page.click('[data-more="activity"]'); }
    await settle('.actpage');
    check(`#22 ${label} → the 활동 기록 page`, /\/activity$/.test(new URL(page.url()).pathname) && (await page.$$('.actpanel')).length === 0, page.url());
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const fail = results.filter((r) => !r[1]).length;
  log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
