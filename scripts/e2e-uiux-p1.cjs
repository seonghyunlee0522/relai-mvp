// UI/UX P1 batch (hive research/relai-uiux-audit.md §c) — P1-1 프로젝트 정의 tabs are real screens (/definition/<slug>),
// P1-2 one name '프로젝트 개요', P1-3 one notice block above the Home cards, P1-4 grey '<phase> 업무' chip off the current phase,
// plus the PC probe (1280 · 1440 · 1920: no horizontal scroll, no stray fixed element over the content, no page errors).
// Not part of `npm test` (needs a running server + Playwright). Needs SAMPLE_PROJECTS on (default) and DATABASE_URL for psql:
//   BASE=http://127.0.0.1:3158 SHOTS=/tmp/uiux-p1 DATABASE_URL=postgres://… node scripts/e2e-uiux-p1.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3158';
const SHOTS = process.env.SHOTS || 'uiux-p1-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const loaded = async (sel = '#main') => { await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForFunction(() => { const t = document.querySelector('#main')?.textContent || ''; return t.length > 100 && !/불러오는 중/.test(t); }, null, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(400); };
  const here = () => { const x = new URL(page.url()); return x.pathname + x.search; };
  const st = () => page.evaluate(() => ({ tab: document.querySelector('.stabs__i.is-active')?.textContent.trim() || '', secs: [...document.querySelectorAll('.defsec h2')].map((x) => x.textContent.trim()),
    drawer: document.querySelector('#wdrawer #wdT')?.textContent.trim() || '', y: Math.round(window.scrollY), body: (document.querySelector('.defsecs, .pv') || {}).textContent || '' }));

  const email = `uxp1-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김점검', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const by = Object.fromEntries((await api('GET', `/api/workspaces/${w}/projects`)).json.projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p]));
  check('3 sample projects (needs SAMPLE_PROJECTS on)', Boolean(by.early && by.mid && by.done), JSON.stringify(Object.keys(by)));

  /* ---------- P1-3: Home — one notice block, first card y ≤ 260 (new account, 1440) ---------- */
  await page.goto(`${BASE}/app`); await loaded('.hgrid .hc');
  const home = await page.evaluate(() => {
    const first = document.querySelector('.hgrid .hc'); const top = first.getBoundingClientRect().top;
    const notes = [...document.querySelectorAll('.sbanner, .obcl, .hsum, .notice')].filter((e) => e.offsetParent && e.getBoundingClientRect().top < top);
    return { top: Math.round(top), notes: notes.map((e) => e.className), sample: document.querySelector('.obcl [data-sample-banner]')?.textContent || '', del: Boolean(document.querySelector('.obcl [data-samples-delete]')) };
  });
  check('P1-3 Home 1440: exactly one notice block above the cards', home.notes.length === 1 && /obcl/.test(home.notes[0]), JSON.stringify(home));
  check('P1-3 Home 1440: first project card top ≤ 260px', home.top <= 260, String(home.top));
  check('P1-3 시작하기 card carries the sample line + [샘플 프로젝트 삭제]', /샘플 프로젝트 3개/.test(home.sample) && home.del, JSON.stringify(home));
  await page.screenshot({ path: `${SHOTS}/p13-home.png` });

  /* ---------- P1-4: phase chip ---------- */
  await page.goto(`${BASE}/app/projects/${by.mid.id}/wbs`); await loaded('.phead .pchip');
  const c1 = await page.evaluate(() => { const c = document.querySelector('.phead .pchip'); return { cls: c.className, text: c.textContent.trim(), title: c.title, bg: getComputedStyle(c).backgroundColor }; });
  check('P1-4 새솔유통(04) WBS: grey chip "03 분석·설계 업무"', /pchip--other/.test(c1.cls) && c1.text === '03 분석·설계 업무' && /현재 단계: 04 구현/.test(c1.title), JSON.stringify(c1));
  await page.screenshot({ path: `${SHOTS}/p14-wbs-other-phase.png` });
  await page.goto(`${BASE}/app/projects/${by.early.id}/requirements`); await loaded('.phead .pchip');
  const c2 = await page.evaluate(() => { const c = document.querySelector('.phead .pchip'); return { cls: c.className, text: c.textContent.trim(), bg: getComputedStyle(c).backgroundColor }; });
  check('P1-4 다온생명(02) 요구사항: blue chip "02 요구사항 정의"', !/pchip--other/.test(c2.cls) && c2.text === '02 요구사항 정의' && c2.bg !== c1.bg, JSON.stringify(c2));

  /* ---------- P1-2: 프로젝트 개요 everywhere ---------- */
  await page.goto(`${BASE}/app/projects/${by.early.id}/charter`); await loaded('.chx');
  const ch = await page.evaluate(() => ({ h1: document.querySelector('.phead__title')?.textContent.trim(), purpose: document.querySelector('.phead__purpose')?.textContent.trim(), title: document.title, heon: /헌장/.test(document.body.innerText) }));
  check('P1-2 PC 프로젝트 개요: page title + browser tab title', ch.h1 === '프로젝트 개요' && /^프로젝트 개요/.test(ch.title) && /사업수행계획서로 내려받을 수 있습니다/.test(ch.purpose), JSON.stringify(ch));
  check('P1-2 no "헌장" on screen', !ch.heon);
  await page.goto(`${BASE}/app/projects/${by.early.id}/definition`); await loaded('.pv');
  const cl = await page.getAttribute('[data-charter-link]', 'href').catch(() => null);
  check('P1-2 개요 tab: "프로젝트 개요 보기" link', cl === `/app/projects/${by.early.id}/charter`, String(cl));

  /* ---------- P1-1 AC1: 7 tabs 1:1 with tasks, each a different address and body ---------- */
  const U = `/app/projects/${by.early.id}/definition`;
  const tabs = await page.$$eval('.stabs__i', (els) => els.map((e) => e.textContent.trim()));
  check('AC1 7 tabs in order', tabs.join('|') === '개요|목표·범위|관계자|상위 일정|운영 방식|착수보고회|착수 승인', tabs.join('|'));
  const EXPECT = [['목표·범위', 'goals', ['프로젝트 목표 정의', '프로젝트 범위 정리']], ['관계자', 'stakeholders', ['관계자 / 조직 확인']], ['상위 일정', 'milestones', ['상위 일정 / 마일스톤 확인']],
    ['운영 방식', 'operations', ['프로젝트 운영 방식 확인']], ['착수보고회', 'kickoff', ['착수보고회 준비·개최']], ['착수 승인', 'approval', ['착수 결과 승인(고객·스폰서)']], ['개요', '', []]];
  let prevBody = (await st()).body;
  for (const [label, slug, secs] of EXPECT) {
    await page.click(`.stabs__i:text-is("${label}")`); await loaded(slug ? '.defsec' : '.pv');
    const x = await st();
    check(`AC1 tab ${label}: address /definition${slug ? `/${slug}` : ''} + its own body`, here() === `${U}${slug ? `/${slug}` : ''}` && x.tab === label && (slug ? x.secs.join('|') === secs.join('|') : /pv__list|프로젝트 기본 특성/.test(await page.innerHTML('#main'))) && x.body !== prevBody, `${here()} ${JSON.stringify({ ...x, body: x.body.slice(0, 60) })}`);
    prevBody = x.body;
    if (slug === 'stakeholders') await page.screenshot({ path: `${SHOTS}/p11-tab-stakeholders.png` });
  }

  /* ---------- AC2: drawer open/close keeps the scroll; a new tab starts at the top ---------- */
  await page.goto(`${BASE}${U}/goals`); await loaded('.defsec');
  await page.evaluate(() => window.scrollTo(0, 300)); await page.waitForTimeout(200);
  const y0 = (await st()).y;
  await page.click('[data-edit="SCOPE"]'); await page.waitForSelector('#wdrawer'); await page.waitForTimeout(300);
  const y1 = (await st()).y; const d1 = (await st()).drawer;
  await page.screenshot({ path: `${SHOTS}/p11-goals-drawer.png` });
  await page.click('#wd-close'); await page.waitForTimeout(300);
  const y2 = (await st()).y;
  check('AC2 drawer open/close keeps the page scroll', y0 > 100 && y1 === y0 && y2 === y0 && d1 === '프로젝트 범위 정리', JSON.stringify({ y0, y1, y2, d1 }));
  check('AC4 drawer open/close never adds history (address = same tab)', here() === `${U}/goals`, here());
  await page.click('.stabs__i:text-is("관계자")'); await loaded('.defsec');
  check('AC2 another tab starts at the top', (await st()).y === 0, String((await st()).y));

  /* ---------- AC3/AC4/AC6 on a fresh project (every task open) ---------- */
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: 'P1 점검 프로젝트', client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28' })).json.project;
  const V = `/app/projects/${P.id}/definition`;
  await page.goto(`${BASE}${V}`); await loaded('.pv');
  await page.click('.pv__row[data-row="SCOPE"]'); await loaded('.defsec'); await page.waitForSelector('#wdrawer');
  let x = await st();
  check('AC3 list row 프로젝트 범위 정리 → 목표·범위 tab + 범위 drawer', x.tab === '목표·범위' && x.drawer === '프로젝트 범위 정리' && here().startsWith(`${V}/goals`), `${here()} ${JSON.stringify({ tab: x.tab, drawer: x.drawer })}`);
  await page.click('.stabs__i:text-is("관계자")'); await loaded('.defsec'); await page.waitForSelector('#wdrawer');
  x = await st();
  check('AC1 unfinished task tab opens its drawer', x.drawer === '관계자 / 조직 확인', x.drawer);
  await page.click('#wd-close'); await page.waitForTimeout(300);
  await page.click('[data-edit="STAKEHOLDERS"]'); await page.waitForSelector('#wdrawer'); await page.click('#wd-close'); await page.waitForTimeout(300);
  await page.goBack(); await loaded('.defsec');
  check('AC4 back = previous tab (목표·범위), not the drawer', new URL(page.url()).pathname === `${V}/goals` && (await st()).tab === '목표·범위', here());
  await page.goBack(); await loaded('.pv');
  check('AC4 back again = 개요', here() === V, here());

  // AC6: unsaved-change confirm, 임시저장, 완료 처리, 건너뛰기 — same as before
  await page.goto(`${BASE}${V}/goals`); await loaded('.defsec'); await page.waitForSelector('#wdrawer [data-f="goal"]');
  await page.fill('#wdrawer [data-f="goal"]', '계약 검토 리드타임 50% 단축');
  await page.click('.stabs__i:text-is("관계자")'); await page.waitForTimeout(400);
  const dlg = await page.$('.scrim .dialog');
  check('AC6 leaving with unsaved input asks first', Boolean(dlg) && new URL(page.url()).pathname === `${V}/goals`, here());
  if (dlg) { await page.click('.scrim [data-v="0"]').catch(() => {}); await page.waitForTimeout(300); }
  await page.click('#wdrawer [data-wact="save"]'); await page.waitForTimeout(800);
  check('AC6 임시저장 still works', /임시저장/.test(await page.textContent('#wd-stat')), await page.textContent('#wd-stat'));
  const nx = await page.textContent('#wdrawer .wd__next').catch(() => '');
  check('AC1 drawer offers 다음 업무 (same tab → 프로젝트 범위 정리)', /다음 업무: 프로젝트 범위 정리/.test(nx), nx);
  await page.click('#wdrawer [data-wact="complete"]'); await page.waitForTimeout(1000);
  x = await st();
  check('AC6 완료 처리 closes the drawer and the block shows 완료', !x.drawer && /완료/.test(await page.textContent('[data-defsec="GOALS"] .defsec__st')), JSON.stringify(x.drawer));
  await page.click('[data-edit="SCOPE"]'); await page.waitForSelector('#wdrawer');
  const nx2 = await page.textContent('#wdrawer .wd__next');
  await page.click('#wdrawer .wd__next a'); await loaded('.defsec');
  check('AC1 다음 업무: 관계자 → the 관계자 tab', /다음 업무: 관계자/.test(nx2) && new URL(page.url()).pathname === `${V}/stakeholders`, `${nx2} ${here()}`);
  await page.goto(`${BASE}${V}/kickoff`); await loaded('.defsec'); await page.waitForSelector('#wdrawer [data-wact="skip"]');
  await page.click('#wdrawer [data-wact="skip"]'); await page.waitForSelector('.scrim [data-v="1"]'); await page.click('.scrim [data-v="1"]'); await page.waitForTimeout(1000);
  check('AC6 건너뛰기 (confirm) → 건너뜀', /건너뜀/.test(await page.textContent('[data-defsec="KICKOFF"] .defsec__st')) && !(await st()).drawer);

  /* ---------- AC5: old links ---------- */
  await page.goto(`${BASE}${V}?activity=STAKEHOLDERS`); await loaded('.defsec'); await page.waitForSelector('#wdrawer');
  x = await st();
  check('AC5 /definition?activity=STAKEHOLDERS → 관계자 tab + drawer', new URL(page.url()).pathname === `${V}/stakeholders` && x.tab === '관계자' && x.drawer === '관계자 / 조직 확인', `${here()} ${x.tab} ${x.drawer}`);
  await page.goto(`${BASE}${V}?activity=SCOPE&field=deliverables`); await page.waitForSelector('#wdrawer [data-field="deliverables"]');
  const flash = await page.evaluate(() => document.querySelector('#wdrawer [data-field="deliverables"]').classList.contains('is-target'));
  x = await st();
  check('AC5 /definition?activity=SCOPE&field=deliverables → 목표·범위 tab, 범위 drawer, field flashes', new URL(page.url()).pathname === `${V}/goals` && x.tab === '목표·범위' && x.drawer === '프로젝트 범위 정리' && flash, `${here()} ${JSON.stringify({ tab: x.tab, drawer: x.drawer, flash })}`);
  await page.screenshot({ path: `${SHOTS}/p11-old-link-field.png` });
  await page.goto(`${BASE}/app/projects/${by.early.id}/charter`); await loaded('.chx');
  const ctas = await page.$$eval('a.chx__cta, .chr__miss a', (els) => els.map((e) => e.getAttribute('href')));
  check('AC5 프로젝트 개요 "입력" links point at the task tabs', ctas.every((h) => !/definition\?activity=(GOALS|SCOPE|STAKEHOLDERS|MILESTONES|OPERATIONS|KICKOFF|APPROVAL)/.test(h)), JSON.stringify(ctas.slice(0, 5)));

  /* ---------- AC7: phone 390 = view only, a task address shows its read view ---------- */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ko-KR', storageState: await ctx.storageState() });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR(phone)', e.message); });
  await mp.goto(`${BASE}/app/projects/${by.early.id}/definition`); await mp.waitForSelector('.pv__list', { timeout: 10000 }).catch(() => {}); await mp.waitForTimeout(500);
  const m1 = await mp.evaluate(() => ({ list: Boolean(document.querySelector('.pv__list')), stabs: Boolean(document.querySelector('.stabs')), hx: document.documentElement.scrollWidth > innerWidth }));
  check('AC7 phone 개요 = view-only list, no tabs, no horizontal scroll', m1.list && !m1.stabs && !m1.hx, JSON.stringify(m1));
  await mp.goto(`${BASE}/app/projects/${by.early.id}/definition?activity=STAKEHOLDERS`); await mp.waitForSelector('.defsec', { timeout: 10000 }).catch(() => {}); await mp.waitForTimeout(500);
  const m2 = await mp.evaluate(() => ({ sec: document.querySelector('.defsec h2')?.textContent, drawer: Boolean(document.querySelector('#wdrawer')), edit: Boolean(document.querySelector('[data-edit]')), hx: document.documentElement.scrollWidth > innerWidth, path: location.pathname }));
  check('AC7 phone task address → read view (no drawer, no 수정)', m2.sec === '관계자 / 조직 확인' && !m2.drawer && !m2.edit && !m2.hx && /\/definition\/stakeholders$/.test(m2.path), JSON.stringify(m2));
  await mp.screenshot({ path: `${SHOTS}/p11-phone-stakeholders.png` });
  await mp.goto(`${BASE}/app/projects/${by.early.id}/charter`); await mp.waitForSelector('.chx', { timeout: 10000 }).catch(() => {}); await mp.waitForTimeout(500);
  const m3 = await mp.evaluate(() => ({ t: document.querySelector('.wsh__title')?.textContent, h: document.querySelector('.chx__head h1')?.textContent, title: document.title }));
  check('P1-2 phone 프로젝트 개요 titles', m3.t === '프로젝트 개요' && m3.h === '프로젝트 개요' && /^프로젝트 개요/.test(m3.title), JSON.stringify(m3));
  await mctx.close();

  /* ---------- PC probe: 1280 · 1440 · 1920 ---------- */
  const E = `/app/projects/${by.early.id}`; const M = `/app/projects/${by.mid.id}`;
  const ROUTES = ['/app', `${E}/definition`, `${E}/definition/goals`, `${E}/definition/stakeholders`, `${E}/definition/milestones`, `${E}/definition/operations`, `${E}/definition/kickoff`, `${E}/definition/approval`, `${E}/charter`, `${E}/requirements`, `${M}/wbs`, `${V}/stakeholders`];
  const before = errors.length;
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const r of ROUTES) {
      await page.goto(BASE + r); await loaded();
      const pr = await page.evaluate(() => {
        const hx = document.documentElement.scrollWidth > window.innerWidth;
        const OK = '.dtop, #dtop, .rail, #rail, .wdrawer, .toast, .toasts, .dmenu, .scrim, .ask, [data-ai-ask], .tour, .coach';
        const stray = [...document.querySelectorAll('body *')].filter((e) => { const cs = getComputedStyle(e); return (cs.position === 'fixed') && e.offsetParent !== undefined && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && !e.closest(OK); })
          .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`);
        return { hx, stray };
      });
      if (pr.hx || pr.stray.length) check(`PC probe ${width} ${r}`, false, JSON.stringify(pr));
    }
    check(`PC probe ${width}: ${ROUTES.length} routes — no horizontal scroll, no stray fixed element`, !results.some(([n, ok]) => !ok && n.startsWith(`PC probe ${width} `)));
  }
  check('PC probe: no page errors', errors.length === before && errors.length === 0, JSON.stringify(errors));

  await browser.close();
  const fail = results.filter(([, ok]) => !ok).length;
  log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
