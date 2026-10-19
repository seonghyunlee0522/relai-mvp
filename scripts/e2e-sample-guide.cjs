// RELAI 가이드 · 샘플로 보기 (/app/guide) — signup (3 samples) → guide renders one section per sample, each worked example has
// a filled-in preview + 왜 중요한가 + a button to the same screen of that sample → entry points (도움말 menu, Home banner) →
// a button opens the real sample screen → 375 has no horizontal scroll → after deleting the samples the guide still reads, without buttons.
// batch5 P2-4: the 주간보고 example's WBS 진행률 is the sample's own (= Home), and the closing example opens the 완료보고서 itself.
// Not part of `npm test` (needs a running server with samples on — SAMPLE_PROJECTS unset — and Playwright).
//   BASE=http://127.0.0.1:3281 SHOTS=research/relai-guide-samples DATABASE_URL=postgres://… node scripts/e2e-sample-guide.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3281';
const SHOTS = process.env.SHOTS || 'research/relai-guide-samples';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
// sample key → the worked examples it must show, with the screen each button opens
const EXPECT = {
  early: { charter: '/definition', milestones: '/definition/milestones', approval: '/definition/approval', requirements: '/requirements' },
  mid: { wbs: '/wbs', raid: '/issues?tab=risks', change: '/changes', weekly: '/reports' },
  done: { acceptance: '/tests?tab=acceptance', closing: '/reports' },
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const guide = async () => { await page.goto(`${BASE}/app/guide`); await page.waitForSelector('[data-sample-guide]', { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(400); };

  /* ---------- signup → samples ---------- */
  const email = `sguide-${Date.now()}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const by = Object.fromEntries((await api('GET', `/api/workspaces/${w}/projects`)).json.projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p.id]));
  check('3 samples present', Object.keys(by).sort().join() === 'done,early,mid', JSON.stringify(by));
  const midWbs = Math.round(Number((await api('GET', `/api/workspaces/${w}/projects/${by.mid}`)).json.wbs.progress));
  const completion = ((await api('GET', `/api/workspaces/${w}/projects/${by.done}/weekly-reports`)).json.items || []).find((r) => r.report_type === 'COMPLETION');
  check('done sample has a 완료보고서', Boolean(completion));
  if (completion) EXPECT.done.closing = `/reports/${completion.id}`;

  /* ---------- the guide ---------- */
  await guide();
  const v = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('[data-sg-sample]')].map((sec) => ({ key: sec.dataset.sgSample, head: sec.querySelector('h2')?.textContent || '',
      open: sec.querySelector('.sg-s__open a')?.getAttribute('href') || '',
      ex: [...sec.querySelectorAll('[data-sg-ex]')].map((a) => ({ id: a.dataset.sgEx, title: a.querySelector('h3')?.textContent || '', pv: (a.querySelector('.sg-pv')?.textContent || '').trim().length,
        why: (a.querySelector('.sg-why p')?.textContent || '').trim().length, href: a.querySelector('[data-sg-open]')?.getAttribute('href') || '' })) }));
    return { h1: document.querySelector('.sg h1')?.textContent || '', secs, missing: Boolean(document.querySelector('[data-sg-missing]')), text: document.querySelector('#main')?.textContent || '' };
  });
  check('guide: title and 3 sample sections in order (early · mid · done)', /RELAI 가이드/.test(v.h1) && v.secs.map((x) => x.key).join() === 'early,mid,done', JSON.stringify(v.secs.map((x) => x.key)));
  check('guide: no "samples missing" note while all 3 exist', !v.missing);
  for (const sec of v.secs) {
    const want = EXPECT[sec.key];
    check(`${sec.key}: section opens its sample`, sec.open === `/app/projects/${by[sec.key]}`, sec.open);
    check(`${sec.key}: worked examples = ${Object.keys(want).join(' · ')}`, sec.ex.map((x) => x.id).join() === Object.keys(want).join(), sec.ex.map((x) => x.id).join());
    for (const ex of sec.ex) check(`${sec.key}/${ex.id}: filled-in preview + 왜 중요한가 + button to ${want[ex.id]}`, ex.pv > 40 && ex.why > 40 && ex.href === `/app/projects/${by[sec.key]}${want[ex.id]}`, JSON.stringify(ex));
  }
  check('guide: keeps the terms 마일스톤 · 산출물 · WBS · 프로젝트 개요 · 프로젝트 관리 방법', ['마일스톤', '산출물', 'WBS', '프로젝트 개요', '프로젝트 관리 방법'].every((t) => v.text.includes(t)));
  const weeklyPv = await page.textContent('[data-sg-ex="weekly"] .sg-pv');
  check(`P2-4 주간보고 example: WBS 진행률 ${midWbs}% comes from the sample (not a fixed 46%)`, weeklyPv.includes(`WBS 진행률 ${midWbs}%`), weeklyPv);
  check('guide: no template leftovers', !/undefined|NaN|SAMPLEOWNERNAME|\[object/.test(v.text));
  check('guide: styles loaded (scoped sheet)', await page.evaluate(() => getComputedStyle(document.querySelector('.sg-ex')).borderRadius !== '0px'));
  await page.screenshot({ path: `${SHOTS}/guide-1440.png`, fullPage: true });
  for (const k of ['early', 'mid', 'done']) { await page.locator(`#sg-${k}`).screenshot({ path: `${SHOTS}/guide-${k}-1440.png` }); }

  /* ---------- a button opens the real sample screen ---------- */
  await page.click('[data-sg-ex="wbs"] [data-sg-open]');
  await page.waitForFunction(() => /웨이브 피킹 개발/.test(document.querySelector('#main')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('WBS button → the mid sample WBS screen', page.url().endsWith(`/app/projects/${by.mid}/wbs`) && /웨이브 피킹 개발/.test(await page.textContent('#main')), page.url());
  await guide();
  await page.click('[data-sg-ex="closing"] [data-sg-open]');
  await page.waitForFunction(() => /완료보고서/.test(document.querySelector('#main h1, #main .phead__title')?.textContent || document.querySelector('#main')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('P2-4 closing example → the done sample 완료보고서 (not the 주간보고 list)', completion && page.url().endsWith(`/app/projects/${by.done}/reports/${completion.id}`) && /완료보고서/.test(await page.textContent('#main')) && !(await page.$('.rpl__p')), page.url());
  await page.goto(`${BASE}/app/projects/${by.mid}`); await page.waitForTimeout(1500);
  check(`P2-4 the same ${midWbs}% shows on the sample's 지금 할 일`, (await page.textContent('#main')).includes(`${midWbs}%`));
  await guide();
  await page.click('[data-sg-ex="milestones"] [data-sg-open]'); await page.waitForTimeout(1500);
  check('마일스톤 button → the early sample 마일스톤 tab', page.url().endsWith(`/app/projects/${by.early}/definition/milestones`) && /요구사항 확정/.test(await page.textContent('#main')), page.url());

  /* ---------- entry points ---------- */
  await page.goto(`${BASE}/app`); await page.waitForSelector('.hgrid', { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(500);
  const homeLink = await page.$('[data-sample-guide-link]');
  check('Home sample banner links to the guide', Boolean(homeLink) && (await homeLink.getAttribute('href')) === '/app/guide');
  await page.click('.helpbtn'); await page.waitForSelector('#helpmenu [data-h-guide]', { timeout: 3000 }).catch(() => {});
  check('도움말 menu has 샘플로 보는 RELAI 가이드', Boolean(await page.$('#helpmenu [data-h-guide]')));
  await page.screenshot({ path: `${SHOTS}/help-menu-1440.png` });
  await page.click('#helpmenu [data-h-guide]'); await page.waitForSelector('[data-sample-guide]', { timeout: 8000 }).catch(() => {});
  check('도움말 menu item opens the guide', /\/app\/guide$/.test(page.url()) && Boolean(await page.$('[data-sample-guide]')), page.url());

  /* ---------- 375 ---------- */
  await page.setViewportSize({ width: 375, height: 812 });
  await guide();
  const ph = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth, ex: document.querySelectorAll('[data-sg-ex]').length, btns: document.querySelectorAll('.sg-why [data-sg-open]').length }));
  check('guide 375: 10 examples, buttons shown, no horizontal scroll', ph.ex === 10 && ph.btns === 10 && ph.wide <= 380, JSON.stringify(ph));
  await page.screenshot({ path: `${SHOTS}/guide-375.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ---------- samples deleted → guide still reads ---------- */
  await api('DELETE', `/api/workspaces/${w}/samples`);
  await guide();
  const gone = await page.evaluate(() => ({ ex: document.querySelectorAll('[data-sg-ex] .sg-pv').length, btns: document.querySelectorAll('[data-sg-open]').length, note: document.querySelector('[data-sg-missing]')?.textContent || '' }));
  check('P2-4 samples deleted: 주간보고 example drops the WBS 진행률 (no stale number)', !/WBS 진행률/.test(await page.textContent('[data-sg-ex="weekly"] .sg-pv')));
  check('samples deleted: 10 examples still shown, no open buttons, note with 설정 link', gone.ex === 10 && gone.btns === 0 && /설정에서 샘플 다시 추가/.test(gone.note), JSON.stringify(gone));
  await page.screenshot({ path: `${SHOTS}/guide-no-samples-1440.png` });

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
