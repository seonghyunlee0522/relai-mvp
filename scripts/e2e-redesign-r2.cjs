// Redesign Round 2 (guide screens + busy tables) — one check per acceptance line in hive research/relai-redesign-spec.md §7 R2,
// plus Jim M1/M2/M3 and the P3s (Q23-1, Q23-2, invite.js). Desktop only; the phone view is covered by e2e-mobile.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3231 SHOTS=/tmp/r2 [SHOTS2=<dir for the 1440/1920 review shots>] node scripts/e2e-redesign-r2.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3231';
const SHOTS = process.env.SHOTS || 'r2-shots';
const SHOTS2 = process.env.SHOTS2 || '';
fs.mkdirSync(SHOTS, { recursive: true }); if (SHOTS2) fs.mkdirSync(SHOTS2, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const ymd = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body, pg = page) => { const r = await pg.request.fetch(BASE + p, { method, data: body === null ? undefined : body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const signup = async (pg, name) => {
    await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name, email: `r2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@relai.test`, password: 'passw0rd!' }, pg);
    const me = (await api('GET', '/api/me', undefined, pg)).json; const w = me.workspaces[0].id;
    await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {}, pg);
    return { w, uid: me.user.id };
  };
  const { w, uid } = await signup(page, '김하늘');
  const mk = async (name, client, pg = page, ws = w) => (await api('POST', `/api/workspaces/${ws}/projects`, { name, client_name: client, project_type: 'NEW_BUILD', planned_start_date: day(-30), planned_end_date: day(120), has_external_integration: 'YES' }, pg)).json.project;
  const pa = (pid, ws = w) => `/api/workspaces/${ws}/projects/${pid}`;
  const phaseId = async (pid, key) => ((await api('GET', pa(pid))).json.phases || []).find((p) => p.phase_key === key).id;
  const activate = async (pid, key) => api('POST', `${pa(pid)}/phases/${await phaseId(pid, key)}/activate`, { reason: 'MANUAL' });
  const settle = async (sel = '.phead-wrap, .page__head') => { await page.waitForSelector(sel, { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(400); };
  const go = async (u, sel) => { await page.goto(BASE + u); await settle(sel); };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}`, fullPage: false });
  const vis = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden').length);
  const primaries = () => page.$$eval('#main .btn--primary', (els) => els.filter((e) => e.offsetParent !== null && getComputedStyle(e).backgroundColor !== 'rgb(255, 255, 255)').map((e) => e.textContent.trim()));

  // ---- seed: P = 02 요구사항 (requirements, some undecided), P2 = 03 분석·설계 (10 unowned tasks, 1 overdue), P3 = 01 착수
  const P = await mk('한빛제약 AI 고객상담 챗봇 구축', '(주)한빛제약');
  for (let i = 0; i < 7; i++) await api('POST', `${pa(P.id)}/requirements`, { title: `상담 기능 ${i + 1} — 주문번호로 배송 상태 조회`, type: 'FUNCTIONAL', priority: i % 2 ? 'HIGH' : 'MEDIUM', scope: i < 5 ? 'IN_SCOPE' : 'UNDECIDED' });
  for (let i = 0; i < 3; i++) await api('POST', `${pa(P.id)}/wbs`, { title: `설계 작업 ${i + 1}`, planned_start_date: day(2), planned_end_date: day(9 + i) });
  await api('POST', `${pa(P.id)}/issues`, { title: '배포 권한 미발급', severity: 'HIGH' });
  await activate(P.id, 'REQUIREMENTS');
  const P2 = await mk('사내 포털 개편', '(주)누리');
  for (let i = 0; i < 3; i++) await api('POST', `${pa(P2.id)}/requirements`, { title: `포털 요구 ${i + 1}`, type: 'FUNCTIONAL', priority: 'HIGH', scope: 'UNDECIDED' });
  const T = []; for (let i = 0; i < 10; i++) T.push((await api('POST', `${pa(P2.id)}/wbs`, { title: `포털 작업 ${i + 1}`, planned_start_date: day(-20), planned_end_date: i === 0 ? day(-3) : day(10 + i) })).json.item);
  await activate(P2.id, 'ANALYSIS_DESIGN');
  const P3 = await mk('물류 정산 시스템', '(주)바로물류');

  // ================= 지금 할 일 =================
  await go(`/app/projects/${P.id}`, '[data-next-card]');
  const nx = await page.evaluate(() => {
    const v = (e) => e && e.offsetParent !== null;
    const rows = [...document.querySelectorAll('.nxp .np__row')];
    const btnsPer = rows.filter(v).map((r) => [...r.querySelectorAll('.np__acts .btn, .np__acts .np__done')].filter(v).length);
    const opt = document.querySelector('details[data-opt]');
    return { tiles: document.querySelectorAll('[data-tiles] .nxt').length, card: Boolean(document.querySelector('[data-next-card]')),
      maxBtns: Math.max(0, ...btnsPer), reqRows: document.querySelectorAll('.nx__req > .np__row').length, reqImp: [...document.querySelectorAll('.nx__req > .np__row')].every((r) => r.dataset.imp === 'REQUIRED'),
      optOpen: opt ? opt.open : null, optCountText: opt ? opt.querySelector('summary').textContent : '', optRows: opt ? opt.querySelectorAll('.np__row').length : 0,
      noActReq: [...document.querySelectorAll('.nx__req > .np__row')].filter((r) => !r.classList.contains('is-done') && !r.classList.contains('is-skip') && ![...r.querySelectorAll('.np__acts .btn')].some(v)).map((r) => r.querySelector('.np__st').textContent.trim()),
      up: Boolean(document.querySelector('#nx-up')), act: Boolean(document.querySelector('#nx-act')) };
  });
  const prim = await primaries();
  check('R2-1 지금 할 일: exactly one primary (the next-step card)', prim.length === 1 && (await page.$$eval('[data-next-card] .btn--primary', (e) => e.length)) === 1, JSON.stringify(prim));
  check('R2-1 4 count tiles + one next-step card', nx.tiles === 4 && nx.card, JSON.stringify(nx));
  check('R2-1 each checklist row has at most one visible button', nx.maxBtns <= 1, String(nx.maxBtns));
  check('R2-1 main list = 필수 only; 권장·선택 collapsed by default with its count', nx.reqImp && nx.optOpen === false && new RegExp(`${nx.optRows}개`).test(nx.optCountText), JSON.stringify(nx));
  check('Jim L3: every open 필수 row shows a visible action', nx.noActReq.length === 0, JSON.stringify(nx.noActReq));
  await page.waitForFunction(() => !/불러오는 중/.test((document.querySelector('#nx-up') || {}).textContent || '') && !/불러오는 중/.test((document.querySelector('#nx-act') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const side = await page.evaluate(() => ({ up: document.querySelectorAll('#nx-up .nxup li').length, act: document.querySelectorAll('#nx-act .nxact li').length }));
  check('R2-1 다가오는 일정 + 최근 활동 filled', nx.up && nx.act && side.up > 0 && side.act > 0, JSON.stringify(side));
  // row ⋯ keeps 건너뛰기 / 되돌리기 reachable
  const optRow = await page.$('details[data-opt] .np__row:has([data-rowmore])');
  if (optRow) { await page.click('details[data-opt] > summary'); await optRow.$eval('[data-rowmore]', (b) => b.click()); await page.waitForTimeout(150);
    check('R2-1 권장 row ⋯ → 건너뛰기 is still one click away', /건너뛰기/.test(await optRow.$eval('.np__menu', (m) => (m.hidden ? '' : m.textContent)))); await page.keyboard.press('Escape'); }
  await shot('a-whats-next-02.png');

  // ================= Home =================
  await api('PATCH', `${pa(P2.id)}/wbs/${T[0].id}`, { status: 'IN_PROGRESS' });
  await go('/app', '[data-home-summary]');
  const home = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.hc--r2')];
    return { sum: (document.querySelector('[data-home-summary]') || {}).textContent || '', cards: cards.length, next: cards.filter((c) => c.querySelector('.hnx')).length,
      up: Boolean(document.querySelector('[data-home-upcoming]')), upN: document.querySelectorAll('[data-home-upcoming] li').length, act: document.querySelectorAll('[data-home-activity] li').length,
      labels: cards.map((c) => ({ name: c.querySelector('.hc__name').textContent.trim(), overdue: Boolean(c.querySelector('[data-overdue]')), alarm: /Blocker|위험|막힘|확인 필요 \d+건/.test(c.textContent) })) };
  });
  const hp = await primaries();
  check('R2-2 Home: summary sentence + one card per active project with a next step', /오늘 할 일 \d+건/.test(home.sum) && home.cards === 3 && home.next === 3, JSON.stringify(home));
  check('R2-2 Home: 다가오는 일정 + 최근 활동 shown', home.up && home.upN > 0 && home.act > 0, JSON.stringify(home));
  check('R2-2 Home: only one blue button on the page', hp.length === 1, JSON.stringify(hp));
  const overdueCard = home.labels.find((x) => x.name === '사내 포털 개편');
  check('R2-2 Home: no Blocker/위험 label unless work is overdue (only 사내 포털 개편 shows 지연)', home.labels.every((x) => !x.alarm) && overdueCard && overdueCard.overdue && home.labels.filter((x) => x.overdue).length === 1, JSON.stringify(home.labels));
  await shot('b-home-3.png');

  // ---- M1: 06 / 07 manual 필수 rows finished with the visible ✓ 완료 처리 only
  const M = await mk('M1 전환 프로젝트', '(주)한빛제약');
  const finishDialog = async () => {
    await page.waitForTimeout(500);
    if (await page.$('[data-golive-dialog]')) { await page.click('[data-gl-ok]'); }
    else if (await page.$('[data-handover-dialog]')) { await page.selectOption('#ho-r', { index: 1 }).catch(() => {}); await page.click('[data-ho-ok]'); }
    else if (await page.$('[data-close-dialog]')) { await page.click('[data-close-dialog] .btn--primary'); }
    else if (await page.$('.scrim')) { const inp = await page.$('.scrim textarea, .scrim input[type=text], .scrim input:not([type])'); if (inp) await inp.fill('고객사 양식으로 작성해 메일로 전달함'); await page.click('.scrim [data-v="1"]'); }
    await page.waitForTimeout(900);
  };
  const doneManual = async (key) => {
    await activate(M.id, key); await go(`/app/projects/${M.id}`, '.nxp');
    const done = []; const via = [];
    for (let k = 0; k < 8; k++) {
      const row = await page.$('.nx__req > .np__row:not(.is-done) .np__done');
      if (!row) break;
      const visible = await row.isVisible(); const li = await row.evaluateHandle((b) => b.closest('.np__row'));
      const title = await li.evaluate((r) => r.querySelector('.np__st').textContent.trim());
      via.push(visible); await row.click(); await finishDialog(); done.push(title);
      if (await page.$('[data-closed]')) break;
      await settle('.nxp');
    }
    return { done, via };
  };
  const m6 = await doneManual('TRANSITION_GO_LIVE');
  const g6 = (await api('GET', pa(M.id))).json.phases.find((p) => p.phase_key === 'TRANSITION_GO_LIVE').steps.filter((s) => s.manual && s.importance === 'REQUIRED');
  check(`M1 06: manual 필수 rows completed with the visible ✓ 완료 처리 (${m6.done.join(', ')})`, m6.done.length >= 2 && m6.via.every(Boolean) && g6.every((s) => s.state === 'COMPLETED'), JSON.stringify({ m6, g6: g6.map((s) => [s.step_key, s.state]) }));
  const m7 = await doneManual('OPERATIONS');
  const g7 = (await api('GET', pa(M.id))).json.phases.find((p) => p.phase_key === 'OPERATIONS').steps.filter((s) => s.manual && s.importance === 'REQUIRED');
  check(`M1 07: manual 필수 rows completed with the visible ✓ 완료 처리 (${m7.done.join(', ')})`, m7.done.length >= 2 && m7.via.every(Boolean) && g7.every((s) => s.state === 'COMPLETED'), JSON.stringify({ m7, g7: g7.map((s) => [s.step_key, s.state]) }));

  // ---- every 필수 row in 01–07 has its one visible action (or is waiting on an earlier row)
  const W = await mk('단계 순회 프로젝트', '(주)한빛제약'); const walk = [];
  for (const key of ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS']) {
    await activate(W.id, key); await go(`/app/projects/${W.id}`, '.nxp');
    const r = await page.evaluate(() => [...document.querySelectorAll('.nx__req > .np__row')].filter((x) => !x.classList.contains('is-done') && !x.classList.contains('is-skip')).map((x) => ({ t: x.querySelector('.np__st').textContent.trim(), n: [...x.querySelectorAll('.np__acts .btn')].filter((b) => b.offsetParent !== null).length, wait: x.hasAttribute('data-wait'), why: ((x.querySelector('[data-row-text]') || {}).textContent || '').trim() })));
    walk.push({ key, rows: r, prim: (await primaries()).length });
  }
  const noAct = walk.flatMap((x) => x.rows.filter((r) => r.n === 0 && !(r.wait && r.why)).map((r) => `${x.key}:${r.t}`));
  const waits = walk.flatMap((x) => x.rows.filter((r) => r.n === 0).map((r) => `${x.key}:${r.t} — ${r.why}`)); fs.writeFileSync(`${SHOTS}/phase-walk-waiting.txt`, waits.join('\n'));
  check('R2-6 01–07: every open 필수 row has exactly one visible action (rows without one wait on an earlier row)', noAct.length === 0 && walk.every((x) => x.rows.every((r) => r.n <= 1)), JSON.stringify(noAct));
  check('R2-1 01–07: one primary on 지금 할 일 in every phase', walk.every((x) => x.prim <= 1), JSON.stringify(walk.map((x) => [x.key, x.prim])));
  fs.writeFileSync(`${SHOTS}/phase-walk.json`, JSON.stringify(walk, null, 1));

  // ================= 요구사항 =================
  const colsOf = () => page.$$eval('#grid thead th', (ths) => ths.filter((t) => !t.classList.contains('gc--chk')).map((t) => t.textContent.replace(/[▲▼]/g, '').trim()));
  const ctrlCount = (sel) => page.evaluate((s) => {
    const bar = document.querySelector(s); if (!bar) return -1;
    const v = (e) => e.offsetParent !== null && !e.closest('.tmenu') && !e.closest('.sseg');
    return [...bar.querySelectorAll('button, input, select, a.btn')].filter(v).length + (bar.querySelector('.sseg') ? 1 : 0);
  }, sel);
  await go(`/app/projects/${P.id}/requirements`, '#grid');
  const rc = await colsOf();
  check('R2-3 요구사항 default columns = ID, 제목, 상태, (범위 while 02 is open — Jim M2), 우선순위, 담당자', JSON.stringify(rc) === JSON.stringify(['ID', '제목', '상태', '범위', '우선순위', '담당자']), JSON.stringify(rc));
  const rCtl = await ctrlCount('[data-rtool-r2]');
  const above = await page.evaluate(() => { const g = document.querySelector('#grid').getBoundingClientRect().top; const v = (e) => e && e.offsetParent !== null; return { kstrip: v(document.querySelector('#kstrip')), qaBelow: document.querySelector('#qa') ? document.querySelector('#qa').getBoundingClientRect().top > g : null }; });
  check('R2-4 controls above the requirements table ≤ 4 (status filter, search, ⋯, + 추가); quick add sits under the table', rCtl <= 4 && !above.kstrip && above.qaBelow === true, JSON.stringify({ rCtl, above }));
  // 컬럼 chooser via ⋯, remembered after reload
  await page.click('[data-rtool-r2] [data-tmore]'); await page.click('.tmenu [data-gcols]'); await page.check('.gpop [data-gcol="type"]'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.reload(); await settle('#grid');
  const rc2 = await colsOf();
  check('R2-3 요구사항: hidden column restored from ⋯ › 컬럼 and remembered after reload', rc2.includes('유형'), JSON.stringify(rc2));
  await page.click('[data-rtool-r2] [data-tmore]'); await page.click('.tmenu [data-gcols]'); await page.uncheck('.gpop [data-gcol="type"]'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // ⋯ keyboard: Enter opens and focuses inside, Esc closes
  await page.focus('[data-rtool-r2] [data-tmore]'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  const kOpen = await page.evaluate(() => { const m = document.querySelector('[data-rtool-r2] .tmenu'); return !m.hidden && m.contains(document.activeElement); });
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  check('R2-4 toolbar ⋯ opens by keyboard (Enter → focus inside, Esc closes)', kOpen && await page.$eval('[data-rtool-r2] .tmenu', (m) => m.hidden));
  // drawer beside the list
  const reqs = (await api('GET', `${pa(P.id)}/requirements`)).json.requirements.sort((a, b) => a.display_id.localeCompare(b.display_id));
  await page.click(`#grid tr[data-id="${reqs[0].id}"] td.ttl`); await page.waitForSelector('#drawer:not([hidden]) .dstack'); await page.waitForTimeout(300);
  const dr = await page.evaluate(() => {
    const d = document.querySelector('#drawer').getBoundingClientRect(); const g = document.querySelector('#grid').getBoundingClientRect(); const v = (s) => { const e = document.querySelector(`#drawer ${s}`); return Boolean(e && e.checkVisibility()); };
    return { dw: Math.round(d.width), gRight: Math.round(g.right), dLeft: Math.round(d.left), gW: Math.round(g.width), scrim: getComputedStyle(document.querySelector('.rlayout'), '::before').display,
      fields: ['[data-field="title"]', '[data-field="description"]', '#crit-in', '[data-field="scope"]', '[data-field="priority"]', '[data-field="owner_user_id"]'].map(v), hiddenMore: !v('[data-field="type"]'), more: v('[data-dmore] > summary'),
      foot: [...document.querySelectorAll('#drawer .drawer__f button')].map((b) => b.textContent.trim()) };
  });
  check('R2-9 requirement drawer opens beside the list at 1440 (480px, list still visible, no scrim)', dr.dw === 480 && dr.gRight <= dr.dLeft + 1 && dr.gW > 500 && dr.scrim === 'none', JSON.stringify(dr));
  check('R2-9 drawer shows 6 fields (제목·설명·완료 조건·범위·우선순위·담당자) + "세부 정보 더보기"', dr.fields.every(Boolean) && dr.hiddenMore && dr.more, JSON.stringify(dr.fields));
  check('R2-9 drawer footer: 댓글 · 보류 · 확정하기 (one primary)', ['댓글', '보류', '확정하기'].every((x) => dr.foot.includes(x)) && (await page.$$eval('#drawer .drawer__f .btn--primary', (e) => e.length)) === 1, JSON.stringify(dr.foot));
  await shot('c-requirements-drawer.png');
  // 확정 / 보류 from the footer
  await page.click('#drawer [data-set-status="CONFIRMED"]'); await page.waitForTimeout(900);
  const st1 = (await api('GET', `${pa(P.id)}/requirements/${reqs[0].id}`)).json.requirement.status;
  await page.click('#drawer [data-set-status="ON_HOLD"]'); await page.waitForTimeout(900);
  const st2 = (await api('GET', `${pa(P.id)}/requirements/${reqs[0].id}`)).json.requirement.status;
  check('R2-9 확정 and 보류 work from the drawer footer', st1 === 'CONFIRMED' && st2 === 'ON_HOLD', `${st1} ${st2}`);
  // keyboard ↓ / ↑
  await page.click('#drawer .drawer__h'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(900);
  const idDown = await page.textContent('#drawer .drawer__h .mono');
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(900);
  const idUp = await page.textContent('#drawer .drawer__h .mono');
  check('R2-9 keyboard ↓ / ↑ moves between items with the drawer open', idDown === reqs[1].display_id && idUp === reqs[0].display_id, `${idDown} ${idUp}`);
  // 1024 wide: no sideways scroll with the drawer open
  await page.setViewportSize({ width: 1024, height: 800 }); await page.waitForTimeout(400);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check('R2-5 drawer open at 1024px: no sideways scroll (drawer overlays the list edge)', sw[0] <= sw[1], JSON.stringify(sw));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');

  // ---- M2: the 지금 할 일 warning → filtered list with 범위 shown → 범위 set in ≤ 2 clicks
  await go(`/app/projects/${P2.id}`, '[data-next-card]');
  const warn = await page.$('[data-warn-link]:has-text("범위가 결정되지 않은")');
  check('M2 지금 할 일 shows "범위가 결정되지 않은 요구사항 N건" as a link', Boolean(warn));
  if (warn) {
    await warn.click(); await settle('#grid');
    const c2 = await colsOf(); const url = new URL(page.url());
    const r0 = (await api('GET', `${pa(P2.id)}/requirements`)).json.requirements[0];
    let clicks = 0;
    await page.click(`#grid tr[data-id="${r0.id}"] select[data-edit="scope"]`); clicks++;
    await page.selectOption(`#grid tr[data-id="${r0.id}"] select[data-edit="scope"]`, 'IN_SCOPE'); clicks++;
    await page.waitForTimeout(900);
    const after = (await api('GET', `${pa(P2.id)}/requirements/${r0.id}`)).json.requirement.scope;
    check(`M2 warning opens 요구사항 filtered to 범위 미결정 with the 범위 column; 범위 set in ${clicks} clicks`, url.searchParams.get('scope') === 'UNDECIDED' && c2.includes('범위') && after === 'IN_SCOPE' && clicks <= 2, JSON.stringify({ c2, after, q: url.search }));
  }

  // ================= 일정 (WBS) =================
  await go(`/app/projects/${P2.id}/wbs`, '#grid');
  const wc = await colsOf();
  check('R2-3 일정 default columns = 번호, 작업, 기간, 진행률, 담당자, 상태', JSON.stringify(wc) === JSON.stringify(['번호', '작업', '기간', '진행률', '담당자', '상태']), JSON.stringify(wc));
  const wCtl = await ctrlCount('[data-rtool-r2]');
  check('R2-4 controls above the WBS table ≤ 5 (status filter, search, 담당자, ⋯, + 작업 추가)', wCtl <= 5 && !(await vis('#kstrip')), String(wCtl));
  await page.click('[data-rtool-r2] [data-tmore]'); await page.click('.tmenu [data-gcols]'); await page.check('.gpop [data-gcol="end"]'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.reload(); await settle('#grid');
  const wc2 = await colsOf();
  check('R2-3 일정: hidden column (계획 종료) restored from 컬럼 and remembered after reload', wc2.includes('계획 종료'), JSON.stringify(wc2));
  await page.click('[data-rtool-r2] [data-tmore]'); await page.click('.tmenu [data-gcols]'); await page.uncheck('.gpop [data-gcol="end"]'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const menuTxt = await page.$eval('[data-rtool-r2] .tmenu', (m) => m.textContent);
  check('R2-4 WBS ⋯ keeps every moved action (마일스톤, AI 초안 + price, Excel, 컬럼, 모두 펼치기/접기, 여러 개 선택)', ['마일스톤 추가', 'AI로 초안 만들기', '크레딧 (₩', 'Excel로 가져오기', '컬럼', '모두 펼치기', '모두 접기', '여러 개 선택'].every((x) => menuTxt.includes(x)), menuTxt.replace(/\s+/g, ' ').slice(0, 300));
  check('R2-4 no row checkboxes until 여러 개 선택', (await page.$$('#grid [data-pick]')).length === 0);
  await page.click(`#grid tr[data-id="${T[1].id}"] .wtitle__t`); await page.waitForSelector('#drawer:not([hidden]) [data-dx]'); await page.waitForTimeout(300);
  const wd = await page.evaluate(() => { const d = document.querySelector('#drawer').getBoundingClientRect(); const g = document.querySelector('#grid').getBoundingClientRect(); const hid = [...document.querySelectorAll('#drawer .dx')].every((e) => e.offsetParent === null); return { dw: Math.round(d.width), ok: g.right <= d.left + 1 && g.width > 500, hid }; });
  await page.click('#drawer [data-dx]'); await page.waitForTimeout(150);
  const shown = await page.$$eval('#drawer .dx', (els) => els.some((e) => e.offsetParent !== null));
  check('R2-9 WBS drawer beside the list (480px); 실적·단계·가중치·상위 항목 behind "세부 정보 더보기"', wd.dw === 480 && wd.ok && wd.hid && shown, JSON.stringify({ wd, shown }));
  await shot('d-wbs-drawer.png');
  await page.click('#drawer .drawer__h'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(900);
  check('R2-9 WBS: keyboard ↓ moves to the next item', /^3$/.test((await page.textContent('#drawer .drawer__h .mono')).trim()), await page.textContent('#drawer .drawer__h .mono'));
  await page.keyboard.press('Escape');

  // ---- M3 / Jim P1-1: 담당자 지정 (row or blue card) → 일정 with the unowned tasks pre-ticked + the owner bar → one owner on 10 WBS items in ≤ 4 clicks
  { // the blue card path (a 03 project whose next step is 담당자 지정): card → pre-ticked tasks → 담당자 → 적용 = 3 clicks
    const P4 = await mk('담당자 지정 카드 프로젝트', '(주)누리'); const T4 = [];
    for (let i = 0; i < 3; i++) T4.push((await api('POST', `${pa(P4.id)}/wbs`, { title: `카드 작업 ${i + 1}`, planned_start_date: day(1), planned_end_date: day(9) })).json.item);
    await activate(P4.id, 'ANALYSIS_DESIGN'); await go(`/app/projects/${P4.id}`, '[data-next-card]');
    const card = await page.$('[data-next-card] .btn--primary'); const cardHref = card ? await card.getAttribute('href') : '';
    check('P1-1 the 03 blue card 담당자 지정 opens ?select=owner (not the bare ?f=no_owner list)', /f=no_owner/.test(cardHref || '') && /select=owner/.test(cardHref || ''), cardHref);
    if (card) {
      await card.click(); await settle('#grid'); await page.waitForSelector('.bulk [data-bv]', { timeout: 5000 }).catch(() => {});
      await page.selectOption('.bulk [data-bv]', uid).catch(() => {}); await page.click('.bulk [data-bapply]').catch(() => {}); await page.waitForTimeout(1500);
      const own4 = (await api('GET', `${pa(P4.id)}/wbs`)).json.items.filter((x) => x.item_type === 'TASK' && x.owner_user_id === uid).length;
      check('P1-1 card → 담당자 → 적용 (3 clicks) sets the owner on every unowned task', own4 === 3, String(own4));
    }
  }
  await go(`/app/projects/${P2.id}`, '.nxp');
  let clicks = 0;
  const assign = await page.$('.np__row[data-step-key="ASSIGN"] .np__open');
  check('M3 03 담당자 지정 row shows its visible action', Boolean(assign) && await assign.isVisible());
  if (assign) {
    await assign.click(); clicks++; await settle('#grid');
    check('M3 일정 opens in multi-select mode with the owner bar (?select=owner)', /select=owner/.test(page.url()) && (await page.$$('#grid [data-pick]')).length >= 10 && await vis('[data-owner-bar]') === 1);
    await page.waitForSelector('.bulk [data-bv]', { timeout: 5000 }).catch(() => {});
    const pre = await page.$$eval('#grid tbody tr[data-id] [data-pick]', (els) => els.filter((e) => e.checked).map((e) => e.closest('tr').dataset.id));
    check('P1-1 the 10 tasks without an owner arrive pre-ticked and the owner bar is open', pre.length === 10 && T.every((t) => pre.includes(t.id)) && await vis('.bulk [data-bv]') === 1, JSON.stringify({ pre: pre.length }));
    await shot('p1-1-owner-preticked.png');
    const fieldPre = await page.$eval('.bulk [data-bf]', (s) => s.value);
    await page.selectOption('.bulk [data-bv]', uid); clicks++;
    await page.click('.bulk [data-bapply]'); clicks++;
    await page.waitForTimeout(1500);
    const items = (await api('GET', `${pa(P2.id)}/wbs`)).json.items.filter((x) => x.item_type === 'TASK');
    const owned = items.filter((x) => x.owner_user_id === uid).length;
    check(`M3 one owner set on 10 WBS items in ${clicks} clicks (bulk field preset to 담당자)`, owned === 10 && clicks <= 4 && fieldPre === 'owner_user_id', JSON.stringify({ owned, clicks, fieldPre }));
  }

  // ================= Jim R2+R3a acceptance fixes =================
  // P1-2: 요구사항 분류 → 분류·우선순위 shows 유형 (and 우선순위); the drawer has 유형 at the top while the 02 분류 step is open
  const U = (await api('POST', `${pa(P.id)}/requirements`, { title: '상담 이력 엑셀 내보내기', scope: 'IN_SCOPE', priority: 'MEDIUM' })).json.requirement;
  await go(`/app/projects/${P.id}`, '.nxp');
  const clsRow = await page.$('.np__row[data-step-key="CLASSIFY"] .np__open');
  if (clsRow) { await clsRow.click(); await settle('#grid'); } else await go(`/app/projects/${P.id}/requirements?type=UNSPECIFIED`, '#grid');
  const cc = await colsOf();
  check('P1-2 요구사항 분류 row opens 분류·우선순위 with the 유형 and 우선순위 columns shown', Boolean(clsRow) && /type=UNSPECIFIED/.test(page.url()) && cc.includes('유형') && cc.includes('우선순위'), JSON.stringify({ row: Boolean(clsRow), url: page.url(), cc }));
  await page.click(`#grid tr[data-id="${U.id}"] td.ttl`); await page.waitForSelector('#drawer:not([hidden]) .dstack'); await page.waitForTimeout(300);
  const ty = await page.evaluate(() => { const e = document.querySelector('#drawer [data-field="type"]'); return { vis: Boolean(e && e.checkVisibility()), inMore: Boolean(e && e.closest('[data-dmore]')) }; });
  check('P1-2 drawer: 유형 at the top level (not under 세부 정보 더보기) while 분류 is open', ty.vis && !ty.inMore, JSON.stringify(ty));
  await shot('p1-2-classify.png');
  await page.selectOption('#drawer [data-field="type"]', 'FUNCTIONAL'); await page.waitForTimeout(1200);
  check('P1-2 유형 set from the drawer', (await api('GET', `${pa(P.id)}/requirements/${U.id}`)).json.requirement.type === 'FUNCTIONAL');
  await go(`/app/projects/${P.id}/requirements`, '#grid');
  check('P1-2 the plain 요구사항 list keeps its 6 default columns (유형 not forced)', !(await colsOf()).includes('유형'));

  // P2-3: an empty 기간 cell says 날짜 지정 and opens the drawer on 계획 시작일
  const ND = (await api('POST', `${pa(P2.id)}/wbs`, { title: '일정 미정 작업' })).json.item;
  await go(`/app/projects/${P2.id}/wbs`, '#grid');
  const emptyTxt = await page.$eval(`#grid tr[data-id="${ND.id}"] [data-period-empty]`, (e) => e.textContent.trim()).catch(() => '');
  const datedEmpty = await page.$$(`#grid tr[data-id="${T[1].id}"] [data-period-empty]`);
  check('P2-3 empty 기간 shows "날짜 지정"; dated rows do not', emptyTxt === '날짜 지정' && datedEmpty.length === 0, emptyTxt);
  await page.click(`#grid tr[data-id="${ND.id}"] [data-period-empty]`); await page.waitForSelector('#drawer:not([hidden])'); await page.waitForTimeout(500);
  check('P2-3 날짜 지정 opens the drawer with 계획 시작일 focused', await page.evaluate(() => document.activeElement && document.activeElement.dataset.field === 'planned_start_date'));
  await page.keyboard.press('Escape');

  // P2-5: 보고서 › 주간보고 has no 완료보고서 생성 before 07 (the closed project still has it — e2e-redesign-r1 A4)
  await go(`/app/projects/${P2.id}/reports`, '#rp-new');
  check('P2-5 03 project: 주간보고 list shows 이번 주 주간보고 만들기 but no 완료보고서 생성', (await vis('#rp-new')) === 1 && (await page.$$('#rp-done')).length === 0);

  // P2-2: a closed project (M, closed by the 07 rows above) shows no 다가오는 일정
  if (process.env.DATABASE_URL) require('child_process').execFileSync('psql', [process.env.DATABASE_URL, '-qc', `UPDATE projects SET status='COMPLETED', closed_on=CURRENT_DATE WHERE id='${M.id}' AND status <> 'COMPLETED'`]);
  const mSt = (await api('GET', pa(M.id))).json.project.status;
  await go(`/app/projects/${M.id}`, '.nxside');
  await page.waitForTimeout(600);
  check('P2-2 closed project: 지금 할 일 has no 다가오는 일정 (최근 활동 stays)', mSt === 'COMPLETED' && (await page.$$('[data-upcoming], #nx-up')).length === 0 && (await page.$$('#nx-act')).length === 1, mSt);
  await go(`/app/projects/${P2.id}`, '.nxside');
  check('P2-2 an active project keeps 다가오는 일정', (await page.$$('[data-upcoming] #nx-up')).length === 1);

  // ================= P3s =================
  await go(`/app/projects/${P.id}/issues`, '.phead-wrap');
  check('Q23-1 이슈·변경: no duplicate 이슈/리스크 switch under the section tabs on desktop', (await vis('.rhead .seg [data-tab="risks"]')) === 0 && (await vis('.stabs [data-stab="risks"]')) === 1);
  const settingsSrc = fs.readFileSync(path.join(__dirname, '../public/app/settings.js'), 'utf8'); const inviteSrc = fs.readFileSync(path.join(__dirname, '../public/app/invite.js'), 'utf8');
  const visibleStrings = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\/?\*|import )/.test(l)).join('\n').match(/(['`>])[^'`<]*\b(Workspace|OWNER)\b[^'`<]*\1?/g) || [];
  check('Q23-2 settings member-remove confirm says 워크스페이스 (no "Workspace")', /이 워크스페이스의 프로젝트에 접근할 수 없습니다/.test(settingsSrc) && !/이 Workspace의/.test(settingsSrc));
  const inv = visibleStrings(inviteSrc).filter((s) => !/replace\(|Workspace\|워크스페이스/.test(s));
  check('invite.js: no "Workspace 소유자" / English Workspace or OWNER in user-facing copy', !/Workspace 소유자/.test(inviteSrc) && inv.length === 0, JSON.stringify(inv));

  // ================= review shots (1440 + 1920) =================
  if (SHOTS2) {
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });   // its own session: signing up here must not log out the main user
    const p2 = await ctx2.newPage(); const { w: w1 } = await signup(p2, '이수진');
    const one = (await api('POST', `/api/workspaces/${w1}/projects`, { name: '한빛제약 AI 고객상담 챗봇 구축', client_name: '(주)한빛제약', project_type: 'NEW_BUILD', planned_start_date: day(-30), planned_end_date: day(120), has_external_integration: 'YES' }, p2)).json.project;
    for (let i = 0; i < 3; i++) await api('POST', `/api/workspaces/${w1}/projects/${one.id}/requirements`, { title: `상담 기능 ${i + 1}`, scope: 'IN_SCOPE', priority: 'HIGH', type: 'FUNCTIONAL' }, p2);
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 }); await p2.setViewportSize({ width, height: 1000 });
      const s2 = async (pg, u, sel, n, click) => { await pg.goto(BASE + u); await pg.waitForSelector(sel, { timeout: 15000 }).catch(() => {}); await pg.waitForTimeout(1200); if (click) { await pg.click(click); await pg.waitForTimeout(1000); } await pg.screenshot({ path: `${SHOTS2}/${width}-${n}.png`, fullPage: false }); };
      await s2(page, `/app/projects/${P.id}`, '[data-next-card]', '01-whats-next');
      await s2(page, '/app', '[data-home-summary]', '02-home-3-projects');
      await s2(p2, '/app', '[data-home-summary]', '03-home-1-project');
      await s2(page, `/app/projects/${P.id}/requirements`, '#grid', '04-requirements');
      await s2(page, `/app/projects/${P.id}/requirements`, '#grid', '05-requirements-drawer', `#grid tr[data-id="${reqs[2].id}"] td.ttl`);
      await s2(page, `/app/projects/${P2.id}/wbs`, '#grid', '06-wbs');
      await s2(page, `/app/projects/${P2.id}/wbs`, '#grid', '07-wbs-drawer', `#grid tr[data-id="${T[2].id}"] .wtitle__t`);
    }
    await ctx2.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  const fail = results.filter((r) => !r[1]).length;
  log(`\n${results.length - fail}/${results.length} passed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
