// Redesign Round 1 (desktop frame + navigation) — one check per acceptance line in hive research/relai-redesign-spec.md §7 R1.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3151 SHOTS=/tmp/r1 DATABASE_URL=postgres://… node scripts/e2e-redesign-r1.cjs
// DATABASE_URL (optional) lets the closed-project check mark a project COMPLETED directly; without it that check is skipped.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3151';
const SHOTS = process.env.SHOTS || 'r1-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();

(async () => {
  const lc = await import(path.join(__dirname, '../public/app/shared/lifecycle.js'));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };

  await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김피엠', email: `r1-${Date.now()}@relai.test`, password: 'passw0rd!' });
  const w = (await api('GET', '/api/me')).json.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mk = async (name) => (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28', has_external_integration: 'YES' })).json.project;
  const P = await mk('한빛제약 AI 고객상담 챗봇 구축 — 아주 긴 프로젝트 이름으로 상단 바가 넘치지 않는지 확인');
  const pa = `/api/workspaces/${w}/projects/${P.id}`;
  for (let i = 0; i < 6; i++) await api('POST', `${pa}/requirements`, { title: `상담 기능 ${i + 1} — 주문번호로 배송 상태를 조회하고 상담원에게 이력을 넘기는 긴 요구사항 제목`, type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE' });
  for (let i = 0; i < 4; i++) await api('POST', `${pa}/wbs`, { title: `작업 ${i + 1} — 상담 시나리오 설계와 화면 구현`, planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' });
  await api('POST', `${pa}/issues`, { title: '배포 권한 미발급', severity: 'HIGH' });
  await api('POST', `${pa}/changes`, { title: '알림톡 추가' });
  const U = `/app/projects/${P.id}`;
  const settle = async () => { await page.waitForSelector('.phead-wrap', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(250); };
  const frame = () => page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
    const banners = [...document.querySelectorAll('.notice, .coach, .verifybar')].filter(vis);
    return {
      rail: [...document.querySelectorAll('#rail .rail__i')].filter(vis).map((x) => x.textContent.trim()),
      active: [...document.querySelectorAll('#rail .rail__i.is-active')].map((x) => x.dataset.door),
      tab: [...document.querySelectorAll('.stabs__i.is-active')].map((x) => x.dataset.stab),
      title: (document.querySelector('.phead__title') || {}).textContent || '',
      purpose: ((document.querySelector('.phead__purpose') || {}).textContent || '').trim(),
      chip: Boolean(document.querySelector('.phead .pchip')),
      stepper: [...document.querySelectorAll('.pstep')].filter(vis).length,
      headPrimary: document.querySelectorAll('.phead .btn--primary').length,
      headSecondary: [...document.querySelectorAll('.phead .btn--secondary')].filter(vis).length,
      banners: banners.length, bannerText: banners.map((b) => b.textContent.trim().slice(0, 40)),
      broken: /찾을 수 없습니다|문제가 발생했습니다/.test((document.querySelector('#main') || {}).textContent || ''),
      lnbVisible: [...document.querySelectorAll('.lnb, .lnb__ph, .wsh')].filter(vis).length,
      nested: document.querySelectorAll('.stabs .stabs, .rail .stabs, .rail__i .rail__i').length,
    };
  });

  // ---- A2/A3/A8/A9/A10 + M4: walk every old LNB link in shared/lifecycle.js (HOME_ITEMS, PHASE_ITEMS incl. 06/07 CL, PM_ITEMS)
  const links = [];
  for (const it of lc.HOME_ITEMS(P.id)) { links.push(it); for (const c of it.children || []) links.push(c); }
  for (const list of Object.values(lc.PHASE_ITEMS)) for (const it of list(P.id)) if (it.enabled !== false) links.push(it);
  for (const it of lc.PM_ITEMS(P.id)) links.push(it);
  const hrefs = [...new Set(links.filter((x) => x.href).map((x) => x.href)), `${U}/phases/REQUIREMENTS`];
  const bad = []; const walk = [];
  for (const href of hrefs) {
    await page.goto(BASE + href); await settle();
    const f = await frame();
    const url = new URL(page.url()); const want = lc.doorOf(P.id, url.pathname, url.searchParams);
    const isNext = want.door === 'next' && !/\/checklist/.test(url.pathname);
    const row = { href: href.replace(U, '') || '/', door: f.active.join('+'), tab: f.tab.join('+'), title: f.title };
    walk.push(row);
    const why = [];
    if (f.broken || !f.title) why.push('blank/404');
    if (f.active.length !== 1) why.push(`active doors ${f.active.length}`);
    else if (f.active[0] !== want.door) why.push(`door ${f.active[0]}≠${want.door}`);
    if (want.tab && f.tab[0] !== want.tab) why.push(`tab ${f.tab[0]}≠${want.tab}`);
    if (!f.purpose) why.push('no purpose line');
    if (f.headPrimary > 1) why.push(`${f.headPrimary} primaries in header`);
    if (f.headSecondary > 2) why.push(`${f.headSecondary} secondaries in header`);
    if (f.banners > 1) why.push(`banners ${f.banners}: ${f.bannerText.join(' | ')}`);
    if (isNext ? f.stepper !== 1 : f.stepper !== 0) why.push(`stepper ${f.stepper}`);
    if (!isNext && !f.chip) why.push('no phase chip');
    if (f.rail.length !== 7) why.push(`rail ${f.rail.length}`);
    if (f.lnbVisible) why.push('old LNB/header visible');
    if (why.length) bad.push(`${row.href}: ${why.join(', ')}`);
  }
  fs.writeFileSync(`${SHOTS}/url-walk.json`, JSON.stringify(walk, null, 1));
  check(`M4 old URL walk: ${hrefs.length} links from lifecycle.js each open one door (+ tab), no 404/blank`, bad.length === 0, bad.join(' ; '));
  check('A1 rail = exactly the 7 doors, in order', JSON.stringify((await frame()).rail) === JSON.stringify(['지금 할 일', '계획', '요구사항', '일정', '시험', '이슈·변경', '보고서']), JSON.stringify((await frame()).rail));
  const nest = await page.evaluate(() => ({ menus: document.querySelectorAll('.rail details, .rail .lnb__sub, .rail ul ul, .stabs nav').length }));
  check('A1 no third menu level (rail → tab only)', nest.menus === 0 && (await frame()).nested === 0);

  // report detail + completion report = 보고서 door
  const rep = await api('POST', `${pa}/weekly-reports/generate`, { period_start: '2026-10-05', period_end: '2026-10-11' });
  await page.goto(`${BASE}${U}/reports/${rep.json.report.id}`); await settle();
  const fr = await frame();
  check('A3 weekly report view: 보고서 › 주간보고', fr.active.join() === 'reports' && fr.tab.join() === 'weekly', JSON.stringify(fr));

  // ---- A8 phase chip links to that phase on 지금 할 일
  await page.goto(`${BASE}${U}/requirements`); await settle();
  const chipHref = await page.getAttribute('.phead .pchip', 'href');
  check('A8 phase chip next to the title links to 지금 할 일?phase=REQUIREMENTS', /\?phase=REQUIREMENTS$/.test(chipHref || ''), chipHref);

  // ---- A12 novice path: 지금 할 일 → 요구사항 → 일정 → 주간보고 with rail clicks only (no back button)
  await page.goto(BASE + U); await settle();
  const t0 = page.url();
  await page.click('#rail [data-door="requirements"]'); await settle(); const r1 = page.url();
  await page.click('#rail [data-door="schedule"]'); await settle(); const r2 = page.url();
  await page.click('#rail [data-door="reports"]'); await settle(); const r3 = (await frame()).tab.join();
  check('A13 novice: 지금 할 일 → 요구사항 → 일정 → 주간보고, one rail click each', /\/requirements$/.test(r1) && /\/wbs$/.test(r2) && r3 === 'weekly' && t0 !== r1, `${r1} ${r2} ${r3}`);
  // ---- Q22-1: every in-page view toggle hidden on desktop has a section-tab equivalent (each of its states is the
  // selected state on some door tab page), and the risk register is reachable from the 이슈·변경 door
  const tabHrefs = [...new Set(lc.DOORS(P.id).flatMap((d) => [d.href, ...d.tabs.filter((t) => t.href).map((t) => t.href)]))];
  const toggles = {};   // signature → { options, seenOn:Set }
  for (const href of tabHrefs) {
    await page.goto(BASE + href); await settle();
    const segs = await page.evaluate(() => [...document.querySelectorAll('#main .seg')].map((seg) => {
      const opts = [...seg.querySelectorAll(':scope>[data-tab],:scope>[data-view],:scope>[data-rview]')];
      if (!opts.length) return null;
      const key = (b) => b.dataset.tab || b.dataset.view || b.dataset.rview;
      return { sig: opts.map(key).join('|'), hidden: seg.getClientRects().length === 0, on: opts.filter((b) => b.classList.contains('is-on')).map(key) };
    }).filter(Boolean));
    for (const sg of segs) if (sg.hidden) { const t = toggles[sg.sig] || (toggles[sg.sig] = { options: sg.sig.split('|'), seenOn: new Set() }); sg.on.forEach((o) => t.seenOn.add(o)); }
  }
  const orphanStates = Object.values(toggles).flatMap((t) => t.options.filter((o) => !t.seenOn.has(o)).map((o) => `${t.options.join('/')}:${o}`));
  check(`Q22-1 every hidden in-page toggle (${Object.keys(toggles).length}) has a tab for each state`, Object.keys(toggles).length >= 2 && orphanStates.length === 0, JSON.stringify({ orphanStates, sigs: Object.keys(toggles) }));
  await page.goto(BASE + U); await settle();
  await page.click('#rail [data-door="issues"]'); await settle();
  await page.click('.stabs__i[data-stab="risks"]'); await settle();
  const rk = await frame(); const addRisk = await page.isVisible('#add') && /리스크 등록/.test(await page.textContent('#add'));
  check('Q22-1 이슈·변경 › 리스크 tab opens the risk register with + 리스크 등록', rk.active.join() === 'issues' && rk.tab.join() === 'risks' && /tab=risks/.test(page.url()) && addRisk, JSON.stringify({ rk, addRisk, url: page.url() }));
  // ---- Q22-2: 시험 tabs carry the counts / 06 tag the hidden toggle used to show
  await page.goto(`${BASE}${U}/tests`); await settle();
  const accTab = await page.textContent('.stabs__i[data-stab="acceptance"]');
  check('Q22-2 시험 › 검수 tab shows the "06에서 진행" tag before 06', /06에서 진행/.test(accTab), accTab);
  // ---- Q22-3: ⋯ › 프로젝트 정보 수정 keeps the project's rail (계획 door)
  await page.goto(`${BASE}${U}/edit`); await page.waitForSelector('#f', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(250);
  const ed = await frame();
  check('Q22-3 /edit shows the project rail with the 계획 door', ed.rail.length === 7 && ed.active.join() === 'plan', JSON.stringify(ed));
  // ---- Jim L1 → UI/UX P1-2: 보고서 › 공식 문서 says 프로젝트 개요 once (the body's own heading stays on the phone)
  await page.goto(`${BASE}${U}/charter`); await settle();
  const doc = await page.evaluate(() => ({ title: document.querySelector('.phead__title').textContent.trim(), h: [...document.querySelectorAll('#main h1')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()) }));
  check('L1 공식 문서 title = 프로젝트 개요, shown once on desktop', doc.title === '프로젝트 개요' && doc.h.length === 1, JSON.stringify(doc));

  await page.click('[data-stab-action="activity"]'); await page.waitForSelector('.actpanel', { timeout: 4000 }).catch(() => {});
  check('보고서 › 활동 기록 tab opens the activity panel', Boolean(await page.$('.actpanel')));
  await page.keyboard.press('Escape');

  // ---- A6 header ⋯ by keyboard (Tab focus, Enter opens + focus inside, ↓ moves, Esc closes and returns focus)
  await page.goto(`${BASE}${U}/requirements`); await settle();
  await page.focus('.phead__more'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  const k1 = await page.evaluate(() => ({ open: Boolean(document.querySelector('.phead .amenu')), inMenu: Boolean(document.activeElement && document.activeElement.closest('.amenu')), first: document.activeElement && document.activeElement.textContent.trim() }));
  await page.keyboard.press('ArrowDown'); const k2 = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
  await page.keyboard.press('Tab'); const k3 = await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.amenu')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const k4 = await page.evaluate(() => ({ open: Boolean(document.querySelector('.amenu')), back: document.activeElement && document.activeElement.classList.contains('phead__more') }));
  check('A6 ⋯ menu: Enter opens with focus inside, ↓/Tab move, Esc closes and returns focus', k1.open && k1.inMenu && k2 !== k1.first && k3 && !k4.open && k4.back, JSON.stringify({ k1, k2, k3, k4 }));
  await page.focus('.phead__more'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  await page.keyboard.press('Enter'); await page.waitForSelector('.actpanel', { timeout: 4000 }).catch(() => {});
  check('A6 ⋯ › 활동 기록 works from the keyboard', Boolean(await page.$('.actpanel'))); await page.keyboard.press('Escape');
  await page.focus('[data-dmenu="me"]'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  const me = await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.dmenu')));
  await page.keyboard.press('Escape');
  check('A6 top-bar account menu works by keyboard', me && !(await page.$('.dmenu')));
  await page.click('[data-dmenu="projects"]'); await page.waitForSelector('.dmenu a[href^="/app/projects/"]', { timeout: 4000 }).catch(() => {});
  check('top bar project switcher lists projects', (await page.$$('.dmenu a[href^="/app/projects/"]')).length >= 1); await page.keyboard.press('Escape');

  // ---- A10 one banner + email-verify pill (user is unverified) that still blocks invites with the same message
  await page.goto(`${BASE}${U}/wbs`); await settle();
  const pill = await page.$('#verify-pill');
  check('A10 email-verify shows as a top-bar pill, not a banner', Boolean(pill) && (await pill.isVisible()) && !(await page.isVisible('#verifybar').catch(() => false)));
  await page.goto(`${BASE}/app/settings?tab=team`); await page.waitForSelector('#invite-btn', { timeout: 8000 }).catch(() => {});
  const inv = await page.evaluate(() => { const b = document.querySelector('#invite-btn'); return b ? { dis: b.disabled, title: b.title } : null; });
  const invApi = await api('POST', `/api/workspaces/${w}/invitations`, { email: `x-${Date.now()}@relai.test`, role: 'MEMBER' });
  check('A10 unverified: invite still blocked with the same message (button + API 403 email_unverified)', inv && inv.dis && /이메일 인증 후 사용할 수 있습니다/.test(inv.title) && invApi.status === 403 && invApi.json.error.code === 'email_unverified', JSON.stringify({ inv, s: invApi.status }));
  await page.click('#verify-pill'); await page.waitForTimeout(500);
  check('A10 pill re-sends the verification mail', /보냈습니다|이미 인증/.test(await page.textContent('#verify-pill')));

  // ---- A7 settings: no English labels
  const eng = await page.evaluate(() => (document.querySelector('#main').innerText.match(/\b(Workspace|Integrations?|Owner|OWNER|Member|MEMBER|Admin|ADMIN|Active Projects|Members|Requirements)\b/g) || []));
  check('A7 설정 shows no English labels (Workspace, Integrations, Owner, Member, Active Projects…)', eng.length === 0, JSON.stringify(eng));

  // ---- A5 no horizontal page scroll at 1024 and 800 (every door + home + settings)
  const pages = ['', '/definition', '/requirements', '/wbs', '/wbs?view=gantt', '/tests?tab=coverage', '/tests', '/issues', '/changes', '/reports', '/overview', '/charter', '/checklist?activity=GO_LIVE'];
  for (const width of [1024, 800]) {
    await page.setViewportSize({ width, height: 800 });
    const over = [];
    for (const s of [...pages.map((x) => U + x), '/app', '/app/projects', '/app/settings']) {
      await page.goto(BASE + s); await page.waitForTimeout(700);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (m.sw > m.cw + 1) over.push(`${s.replace(U, '')}=${m.sw}`);
    }
    check(`A5 no horizontal page scroll at ${width}px (${pages.length + 3} pages)`, over.length === 0, over.join(' '));
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- A4 closed project: 완료보고서 and 종료 취소 each ≤ 2 clicks from any project page
  if (process.env.DATABASE_URL) {
    const C = await mk('종료된 프로젝트');
    sql(`UPDATE projects SET status='COMPLETED', closed_on=CURRENT_DATE WHERE id='${C.id}'`);
    await page.goto(`${BASE}/app/projects/${C.id}/requirements`); await settle();
    await page.click('#rail [data-door="reports"]'); await settle();   // click 1
    const doneBtn = await page.$('#rp-done'); const doneOk = doneBtn && (await doneBtn.isEnabled());
    await page.goto(`${BASE}/app/projects/${C.id}/wbs`); await settle();
    await page.click('.phead__more');   // click 1
    const reopen = await page.$('[data-more="reopen"]'); const reopenOk = reopen && (await reopen.isVisible());   // click 2 = 종료 취소
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/app/projects/${C.id}`); await settle();
    const panel = await page.evaluate(() => ({ reopen: Boolean(document.querySelector('[data-reopen]')), report: /완료보고서/.test((document.querySelector('.closed, .closedp, #main') || {}).textContent || '') }));
    check('A4 closed project: 완료보고서 (보고서 › 완료보고서 보기) and 종료 취소 (⋯ › 종료 취소) each in ≤ 2 clicks; 지금 할 일 card has both', doneOk && reopenOk && panel.reopen && panel.report, JSON.stringify({ doneOk, reopenOk, panel }));
  } else log('SKIP A4 (no DATABASE_URL)');

  // ---- tour re-anchored: every project-step target exists and is visible on desktop
  const ob = (await api('GET', `/api/workspaces/${w}/onboarding`)).json;
  const tgt = (ob.tour.steps || []).filter((s) => s.needsProject).map((s) => s.target);
  await page.goto(BASE + U); await settle();
  const missing = await page.evaluate((ids) => ids.filter((id) => ![...document.querySelectorAll(`[data-tour-id="${id}"]`)].some((e) => e.offsetParent !== null)), tgt);
  check(`tour: ${tgt.length} project steps anchor on the rail / stepper`, tgt.length >= 4 && missing.length === 0 && tgt.some((t) => /^rail-/.test(t)), JSON.stringify({ tgt, missing }));

  // ---- A12 phone (< 768) keeps its own frame: no top bar / rail, bottom tab bar + old header
  const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', storageState: await ctx.storageState() });
  const pp = await pc.newPage(); await pp.goto(BASE + U + '/requirements'); await pp.waitForSelector('.tabbar a', { timeout: 8000 }).catch(() => {});
  const ph = await pp.evaluate(() => { const vis = (s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');   /* the tab bar is position:fixed (no offsetParent) */ return { dtop: vis('.dtop'), rail: vis('.rail'), tabbar: vis('.tabbar'), phead: vis('.phead'), sw: document.documentElement.scrollWidth }; });
  check('A12 phone 390px: no desktop top bar / rail / page header; bottom tab bar kept', !ph.dtop && !ph.rail && !ph.phead && ph.tabbar && ph.sw <= 390, JSON.stringify(ph));
  await pc.close();

  // ---- screenshots of each door at 1440 and 1024
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [n, s] of [['01-next', ''], ['02-plan', '/definition'], ['03-requirements', '/requirements'], ['04-schedule', '/wbs'], ['05-tests', '/tests'], ['06-issues', '/issues'], ['07-reports', '/reports'], ['08-home', '/app'], ['09-settings', '/app/settings']]) {
      await page.goto(BASE + (s.startsWith('/app') ? s : U + s)); await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/${n}-${width}.png` });
    }
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const fail = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fail.length}/${results.length} passed`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
