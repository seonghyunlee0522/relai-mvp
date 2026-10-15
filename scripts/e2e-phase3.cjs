// Phase 3 (03 분석·설계) browser check — empty WBS = one primary (WBS 뼈대 만들기), 뼈대 dialog (list preview) → 28 items + 15 links,
// J3 (no blank row / 총 N건 on an empty WBS), 계정 없는 팀원 담당자 (optgroups · 계정 없음 tag in table / Gantt / 주간보고 · 1-stakeholder hint),
// 종료일 초과 warnings (warn colour, never red; guide count), 01 주요 일정 → 마일스톤 (What's Next row + WBS screen), 03 완료 가이드 warnings
// with filter links, terms (?), NON_DEV_TASKS 권장, landing 요금 안내 → /#pricing, 375px shots.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3012 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-phase3.cjs   (playwright on NODE_PATH; server with PLAN_LIMITS=off)
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3012';
const SHOTS = process.env.SHOTS || 'phase3-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

const TEAM = [
  { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-pl', name: '최민석', org_type: 'OWN', org: '수행사', role: 'PL/아키텍트' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '이고객', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
];
const KEY_DATES = [{ title: '킥오프', date: '2026-11-03' }, { title: '요구사항 확정', date: '2026-12-01' }, { title: '오픈', date: '2027-04-01' }];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}` });
  const toastText = async () => { await page.waitForSelector('.toast', { timeout: 5000 }).catch(() => {}); return page.textContent('.toast').catch(() => ''); };
  const isRed = (rgb) => { const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb || ''); return m ? Number(m[1]) > 170 && Number(m[2]) < 80 && Number(m[3]) < 80 : false; };

  /* ---------- landing footer ---------- */
  // The footer legal line is still an HTML comment (company info pending) — check the markup itself.
  const landing = await (await page.request.get(BASE + '/')).text();
  check('landing footer 요금 안내 → /#pricing (no /pricing link left)', landing.includes('<a href="/#pricing">요금 안내</a>') && !/href="\/pricing"/.test(landing));

  const email = `p3-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  /** A project through 01 + 02 and now in 03, with `n` confirmed in-scope requirements. */
  const mkProject = async (name, { n = 15, team = TEAM, keyDates = KEY_DATES } = {}) => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-04-30', data_migration: 'YES', has_external_integration: 'NO' })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { stakeholders: team, key_dates: keyDates });
    for (let i = 1; i <= n; i++) await api('POST', `${P}/requirements`, { title: `기능 ${i}`, type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED' });
    for (const key of ['REQUIREMENTS', 'ANALYSIS_DESIGN']) { const ph = (await api('GET', P)).json.phases.find((x) => x.phase_key === key); await api('POST', `${P}/phases/${ph.id}/activate`, { reason: 'NEXT' }); }
    return { p, P, url: `${BASE}/app/projects/${p.id}` };
  };
  const A = await mkProject('계약 관리 시스템 구축');

  /* ---------- What's Next in 03 (empty WBS) ---------- */
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const guide = await page.textContent('.rg');
  check('US-2 03 guide primary = WBS 뼈대 만들기', (await page.textContent('.rg .btn--primary')).trim() === 'WBS 뼈대 만들기', guide.replace(/\s+/g, ' ').slice(0, 120));
  check('US-2 NON_DEV_TASKS shown 권장', /권장/.test(await page.textContent('.np__row:has-text("기능 개발 외 작업 확인")')));
  check('US-6 03 description ends with the 설계 sentence', /화면·DB·인터페이스 설계도 WBS 작업으로 넣어 관리하세요\./.test(await page.textContent('.np__d')));
  await shot('01-whats-next-03-empty.png');

  /* ---------- empty WBS: one primary, no table / blank row / 총 N건 / Jira banner (J3) ---------- */
  for (const q of ['', '?new=1']) {
    await page.goto(`${A.url}/wbs${q}`); await page.waitForSelector('.wempty');
    const prim = await page.$$eval('main .btn--primary', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
    check(`US-2 empty WBS${q}: the only primary is WBS 뼈대 만들기`, prim.length === 1 && prim[0] === 'WBS 뼈대 만들기', JSON.stringify(prim));
    check(`J3 empty WBS${q}: no table, no blank row, no 총 N건`, !(await page.$('main table')) && !(await page.$('.gfoot')) && !(await page.$('[data-ghost]')));
    check(`US-2 empty WBS${q}: no Jira banner`, !/Jira를 사용하고 있나요/.test(await page.textContent('main')));
  }
  const emptyTxt = await page.textContent('.wempty');
  check('US-2 empty copy: 15건 + 직접 추가 · Excel로 가져오기 · AI 초안', /아직 작업이 없습니다/.test(emptyTxt) && /확정한 요구사항 15건으로 기본 작업 목록을 만들어 드립니다\. 일정과 담당자는 직접 채우면 됩니다\./.test(emptyTxt) && /직접 추가/.test(emptyTxt) && /Excel로 가져오기/.test(emptyTxt) && /AI 초안/.test(emptyTxt));
  const terms0 = await page.$$eval('main .term', (els) => els.map((e) => e.getAttribute('aria-label')));
  check('US-2 term: 뼈대 (?) next to the button', terms0.some((x) => x.startsWith('WBS 뼈대: 요구사항과 꼭 필요한 시험·오픈 작업을 넣은 기본 작업 목록')), JSON.stringify(terms0));
  await shot('02-wbs-empty.png');
  // 직접 추가 opens one input inside the empty state; Esc closes it — still no 총 N건
  await page.click('#add2'); await page.waitForSelector('.wempty [data-ghost]');
  check('직접 추가 → input inside the empty state (no table)', !(await page.$('main table')) && !(await page.$('.gfoot')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  // Gantt tab with 0 items
  await page.goto(`${A.url}/wbs?view=gantt`); await page.waitForSelector('.wempty');
  check('Gantt 0건 copy', /작업에 시작일·종료일을 넣으면 여기에 일정표가 그려집니다\./.test(await page.textContent('.wempty')));

  /* ---------- 375px = view mode: empty state without the skeleton trigger, PC line instead ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${A.url}/wbs`); await page.waitForSelector('.wempty');
  check('375px: no 뼈대 만들기 trigger, one PC line, no sideways scroll', !(await page.$('#skel')) && (await page.$$('.pcline')).length === 1 && (await page.evaluate(() => document.documentElement.scrollWidth)) <= 376);
  await shot('03-wbs-empty-375.png');
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ---------- US-2 skeleton via ?skeleton=1 (What's Next CTA) ---------- */
  await page.goto(A.url); await page.waitForSelector('.rg .btn--primary'); await page.click('.rg .btn--primary');
  await page.waitForSelector('.dialog .skel');
  const rows = await page.$$eval('.dialog .skel li', (els) => els.map((e) => `${e.querySelector('span').textContent} ${e.querySelector('b').textContent}`.replace(/\s+/g, ' ').trim()));
  check('US-2 dialog list: 분석·설계 3 / 구현 15 (자동 연결) / 시험 3 / 전환·오픈 3 / 안정화 1 / 마일스톤 3',
    JSON.stringify(rows) === JSON.stringify(['분석·설계 3', '구현 15 (요구사항 15건 자동 연결)', '시험 3', '전환·오픈 3', '안정화 1', '마일스톤 3']), JSON.stringify(rows));
  check('US-2 dialog note + [취소] [만들기]', /만든 뒤 자유롭게 고치거나 지울 수 있습니다\. 일정과 담당자는 직접 채웁니다 — 다음 가이드가 안내합니다\./.test(await page.textContent('.dialog')) && (await page.textContent('.dialog [data-v="1"]')).trim() === '만들기');
  await shot('05-skeleton-dialog.png');
  await page.click('.dialog [data-v="1"]');
  const t1 = await toastText();
  check('US-2 toast 작업 28건을 만들었습니다', /작업 28건을 만들었습니다/.test(t1), t1);
  await page.waitForSelector('main table');
  const foot = (await page.textContent('.gfoot')).replace(/\s+/g, ' ');
  const visibleRows = await page.$$eval('main tbody tr', (els) => els.length);
  check('US-2 first group open, others folded', visibleRows === 1 + 3 + 4 + 3, String(visibleRows));
  const chipTotal = (await page.textContent('.kchip[data-kf=""] b')).trim();
  check('K11 총 N건 = the 전체 항목 chip (folded rows counted)', new RegExp(`총 ${chipTotal}건`).test(foot), `${foot} · chip ${chipTotal}`);
  await shot('06-wbs-after-skeleton.png');
  const tree = (await api('GET', `${A.P}/wbs`)).json;
  const tasks = tree.items.filter((i) => i.item_type === 'TASK');
  check('US-2 33 items (5 groups + 25 tasks + 3 milestones), all tasks tagged', tree.items.length === 33 && tasks.length === 25 && tasks.every((t) => t.lifecycle_phase), String(tree.items.length));
  let g = (await api('GET', A.P)).json;
  const st = (k) => g.phases.find((x) => x.phase_key === 'ANALYSIS_DESIGN').steps.find((x) => x.step_key === k).state;
  check('US-2 REQ_TRACE 완료 (15 links)', st('REQ_TRACE') === 'COMPLETED');
  check('US-2/4 MILESTONES + NON_DEV_TASKS 완료', st('MILESTONES') === 'COMPLETED' && st('NON_DEV_TASKS') === 'COMPLETED');
  check('US-2 409 when not empty', (await api('POST', `${A.P}/wbs/skeleton`, {})).status === 409);
  await page.goto(`${A.url}/wbs`); await page.waitForSelector('main table');
  check('US-2 skeleton button gone once the WBS has items', !(await page.$('#skel')));
  const terms1 = await page.$$eval('main .term', (els) => els.map((e) => e.getAttribute('aria-label')));
  check('US-6 terms: WBS · Gantt · 마일스톤', ['WBS: 프로젝트에서 해야 할 일을 잘게 나눈 작업 목록', 'Gantt:', '마일스톤: 고객과 공유할 주요 시점. 01 주요 일정을 가져올 수 있습니다'].every((t) => terms1.some((x) => x.startsWith(t))), JSON.stringify(terms1));

  /* ---------- US-1 owner picker ---------- */
  const design = tasks.find((t) => t.title === '화면 설계');
  await page.goto(`${A.url}/wbs?sel=${design.id}`); await page.waitForSelector('#drawer [data-field="owner"]');
  const groups = await page.$$eval('#drawer [data-field="owner"] optgroup', (els) => els.map((o) => [o.label, [...o.querySelectorAll('option')].map((x) => x.textContent)]));
  check('US-1 optgroups RELAI 사용자 / 팀원 (계정 없음); 고객사 not listed', groups.length === 2 && groups[0][0] === 'RELAI 사용자' && groups[1][0] === '팀원 (계정 없음)'
    && JSON.stringify(groups[1][1]) === JSON.stringify(['김피엠 · PM', '최민석 · PL/아키텍트', '박협력 · 개발']), JSON.stringify(groups));
  check('US-1 no 1-stakeholder hint when the team is registered', !(await page.$('#drawer .whint')));
  await page.click('[data-dtab="dep"]');
  check('US-6 term: 선행관계', /^선행관계: 앞 작업이 끝나야 시작할 수 있는 관계/.test(await page.getAttribute('#drawer [data-pane="dep"] .term', 'aria-label').catch(() => '')));
  await page.click('[data-dtab="info"]');
  await page.selectOption('#drawer [data-field="owner"]', 's:sh-pl'); await page.waitForTimeout(700);
  let row = await page.textContent(`main tr[data-id="${design.id}"]`);
  check('US-1 table: 최민석 + 계정 없음 tag', /최민석/.test(row) && Boolean(await page.$(`main tr[data-id="${design.id}"] .wnoacct`)), row.replace(/\s+/g, ' ').slice(0, 100));
  const tagStyle = await page.$eval(`main tr[data-id="${design.id}"] .wnoacct`, (e) => { const c = getComputedStyle(e); return { fs: c.fontSize, col: c.color, bg: c.backgroundColor }; });
  check('US-1 계정 없음 = grey 12px text (not a badge)', tagStyle.fs === '12px' && tagStyle.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(tagStyle));
  await shot('07-owner-stakeholder.png');
  let it = (await api('GET', `${A.P}/wbs/${design.id}`)).json.item;
  check('US-1 saved as stakeholder only', it.owner_stakeholder_id === 'sh-pl' && !it.owner_user_id);
  await page.selectOption('#drawer [data-field="owner"]', `u:${s.json.user.id}`); await page.waitForTimeout(700);
  it = (await api('GET', `${A.P}/wbs/${design.id}`)).json.item;
  check('US-1 switch to a user clears the stakeholder', it.owner_user_id === s.json.user.id && !it.owner_stakeholder_id && !(await page.$(`main tr[data-id="${design.id}"] .wnoacct`)));
  await page.selectOption('#drawer [data-field="owner"]', 's:sh-pl'); await page.waitForTimeout(500);
  // owner filter by stakeholder
  await page.goto(`${A.url}/wbs?owner=s:sh-pl`); await page.waitForSelector('main table');
  check('US-1 owner filter (팀원): only 화면 설계 (+ its group)', (await page.$$eval('main tbody tr', (els) => els.map((e) => e.querySelector('.wtitle__t').textContent))).join('|') === '분석·설계|화면 설계');

  /* ---------- US-3 종료일 초과 (row warn colour, drawer copy) ---------- */
  const dev1 = tasks.find((t) => t.lifecycle_phase === 'DEVELOPMENT');
  const stab = tasks.find((t) => t.title === '오픈 후 안정화 지원');
  await api('PATCH', `${A.P}/wbs/${dev1.id}`, { planned_start_date: '2027-04-01', planned_end_date: '2027-05-14' });
  await api('PATCH', `${A.P}/wbs/${stab.id}`, { planned_start_date: '2027-05-01', planned_end_date: '2027-05-31' });
  await api('PATCH', `${A.P}/wbs/${design.id}`, { planned_start_date: '2026-11-02', planned_end_date: '2026-11-20' });
  await page.goto(`${A.url}/wbs?sel=${dev1.id}`); await page.waitForSelector('#drawer .wpast__msg');
  check('US-3 drawer copy', (await page.textContent('#drawer .wpast__msg')).trim() === '프로젝트 종료일(04/30) 이후입니다. 계약 기간 안에 끝나도록 일정을 다시 확인하세요.');
  const cellCol = await page.$eval(`main tr[data-id="${dev1.id}"] .cell--past`, (e) => getComputedStyle(e).color).catch(() => '');
  check('US-3 row date in warn colour (not red) + !', Boolean(cellCol) && !isRed(cellCol) && Boolean(await page.$(`main tr[data-id="${dev1.id}"] .wpast__i`)), cellCol);
  await shot('08-past-end-warning.png');
  check('US-3 summary count 1 (안정화 starting after the end not counted)', (await api('GET', `${A.P}/wbs`)).json.summary.tasks_over_end === 1);
  await page.goto(`${A.url}/wbs?f=over_end`); await page.waitForSelector('main table');
  const over = await page.$$eval('main tbody tr', (els) => els.map((e) => e.textContent));
  check('US-3 ?f=over_end shows the 2 past-end tasks (+ their groups)', over.some((t) => /기능 1/.test(t)) && over.some((t) => /오픈 후 안정화 지원/.test(t)) && !over.some((t) => /화면 설계/.test(t)));

  /* ---------- Gantt + 주간보고 show the stakeholder owner ---------- */
  await page.goto(`${A.url}/wbs?view=gantt`); await page.waitForSelector('.gantt');
  const gOwner = await page.textContent(`.gantt__left [data-row="${design.id}"]`);
  check('US-1 Gantt: 최민석 + 계정 없음', /최민석/.test(gOwner) && /계정 없음/.test(gOwner), gOwner.replace(/\s+/g, ' '));
  await shot('09-gantt-owner.png');
  await api('PATCH', `${A.P}/wbs/${design.id}`, { status: 'IN_PROGRESS', progress: 40 });
  const rep = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: '2026-11-02', period_end: '2026-11-08' })).json.report;
  check('US-1 주간보고: 최민석 (계정 없음)', /화면 설계 — 40% · 최민석 \(계정 없음\)/.test(rep.plain_text));

  /* ---------- 03 완료 가이드 warnings (links, primary stays the move) ---------- */
  const items2 = (await api('GET', `${A.P}/wbs`)).json.items;
  for (const t of items2.filter((x) => x.item_type === 'TASK' && !x.is_group)) {
    const b = { owner: 's:sh-dev' }; if (!t.planned_start_date) Object.assign(b, { planned_start_date: '2026-11-02', planned_end_date: '2026-12-31' });
    await api('PATCH', `${A.P}/wbs/${t.id}`, b);
  }
  const testGroup = items2.find((x) => x.title === '시험' && x.depth === 0);
  await api('POST', `${A.P}/wbs/${testGroup.id}/archive`, {});
  await page.goto(A.url); await page.waitForSelector('.rg');
  const warns = await page.$$eval('.rg__warn', (els) => els.map((e) => [e.textContent.replace('!', '').trim(), (e.querySelector('a') || {}).getAttribute ? e.querySelector('a').getAttribute('href') : null]));
  check('US-2/3 guide: 실행 계획이 준비되었습니다 + move stays primary', /실행 계획이 준비되었습니다/.test(await page.textContent('.rg__title')) && Boolean(await page.$('.rg [data-move-next]')));
  check('US-2 warning 시험 작업이 없습니다 → ?phase=TESTING', warns.some(([t, h]) => t === '시험 작업이 없습니다' && /\/wbs\?phase=TESTING$/.test(h || '')), JSON.stringify(warns));
  check('US-3 warning 종료일을 넘는 작업 1건 → ?f=over_end', warns.some(([t, h]) => t === '종료일을 넘는 작업 1건' && /\/wbs\?f=over_end$/.test(h || '')));
  check('US-2 no 오픈(전환) warning (전환·오픈 tasks exist)', !warns.some(([t]) => /오픈\(전환\)/.test(t)));
  const warnCol = await page.$eval('.rg__warn', (e) => getComputedStyle(e).color);
  check('guide warnings are not red', !isRed(warnCol), warnCol);
  await shot('10-guide-warnings.png');
  await page.click('.rg__warn a:has-text("종료일을 넘는")'); await page.waitForSelector('main table');
  check('warning link opens the filtered WBS', /f=over_end/.test(page.url()));

  /* ---------- US-4 milestones from 01 key dates (WBS screen + What's Next row) ---------- */
  const B = await mkProject('인사 시스템 고도화', { n: 2, team: [{ id: 'only-pm', name: '김피엠', org_type: 'OWN', role: 'PM' }] });
  const bt = (await api('POST', `${B.P}/wbs`, { title: '현행 분석' })).json.item;
  await page.goto(`${B.url}/wbs`); await page.waitForSelector('.wsuggest');
  check('US-4 WBS screen: inline suggestion (not a banner)', /착수 때 정한 주요 일정 3건을 마일스톤으로 가져올까요\?/.test(await page.textContent('.wsuggest')));
  await page.goto(`${B.url}/wbs?sel=${bt.id}`); await page.waitForSelector('#drawer [data-field="owner"]');
  check('US-1 only the PM registered → hint + 이해관계자 추가 link', /팀원을 01 착수 › 이해관계자에 추가하면 계정 없이 담당자로 지정할 수 있습니다\./.test(await page.textContent('#drawer .whint')) && /definition\?activity=STAKEHOLDERS/.test(await page.getAttribute('#drawer .whint a', 'href')));
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${B.url}/wbs?sel=${bt.id}`); await page.waitForSelector('#drawer:not([hidden]) .drawer__x'); await page.waitForTimeout(300);
  check('375px: read-only detail (no owner picker, no input), one PC line, no sideways scroll', !(await page.$('#drawer [data-field="owner"]')) && (await page.$$eval('#drawer input, #drawer select, #drawer textarea', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).length)) === 0
    && (await page.$$('.pcline')).length === 1 && (await page.evaluate(() => document.documentElement.scrollWidth)) <= 376);
  await shot('11-wbs-detail-375.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(B.url); await page.waitForSelector('.np__list');
  const msRow = await page.textContent('.np__row:has-text("마일스톤 등록")');
  check('US-4 What\'s Next row suggestion + 가져오기', /착수 때 정한 주요 일정 3건\(킥오프·요구사항 확정·오픈\)을 마일스톤으로 가져올까요\?/.test(msRow) && Boolean(await page.$('[data-import-ms]')), msRow.replace(/\s+/g, ' ').slice(0, 140));
  await shot('12-milestone-suggestion.png');
  await page.click('[data-import-ms]');
  const t2 = await toastText();
  await page.waitForTimeout(500);
  const msRow2 = await page.textContent('.np__row:has-text("마일스톤 등록")');
  check('US-4 one click → 마일스톤 3건 + row 완료', /마일스톤 3건을 가져왔습니다/.test(t2) && /완료/.test(msRow2) && !(await page.$('[data-import-ms]')), t2);
  const again = (await api('POST', `${B.P}/wbs/milestones/from-key-dates`, {})).json;
  check('US-4 twice → no duplicates', again.created === 0 && again.items.filter((i) => i.item_type === 'MILESTONE').length === 3);
  await shot('13-milestones-imported.png');

  /* ---------- Phase 3 acceptance fixes (J-A1 · J-A2 · J-A3 · B-1 · L-C1 · L-C6) ---------- */
  const todayK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const dayShift = (n) => { const d = new Date(`${todayK}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // J-A1 + J-A2: a past key date and the PM (= the signed-up member 홍길동) listed as a 당사 stakeholder, as 01 tells the PM to do
  const C = await mkProject('지난 일정 프로젝트', { n: 2, team: [{ id: 'sh-me', name: '홍길동', org_type: 'OWN', role: 'PM' }, ...TEAM], keyDates: [{ title: '착수보고회', date: dayShift(-1) }, { title: '오픈', date: '2027-04-01' }] });
  const ct = (await api('POST', `${C.P}/wbs`, { title: '현행 분석' })).json.item;
  const imp = (await api('POST', `${C.P}/wbs/milestones/from-key-dates`, {})).json;
  const kick = imp.items.find((i) => i.title === '착수보고회');
  check('J-A1 past key date → 완료 milestone (no 지연)', kick && kick.status === 'COMPLETED' && kick.computed_status !== 'DELAYED' && !imp.summary.overdue_milestones, JSON.stringify(kick && [kick.status, kick.computed_status]));
  await page.goto(`${C.url}/wbs?sel=${ct.id}`); await page.waitForSelector('#drawer [data-field="owner"]');
  check('J-A1 WBS: no red 지연 row / 지연 작업 chip on day one', !(await page.$('main tr.is-late')) && !(await page.$('.kchip.is-crit[data-kf="overdue"]')));
  const cGroups = await page.$$eval('#drawer [data-field="owner"] optgroup', (els) => els.map((o) => [o.label, [...o.querySelectorAll('option')].map((x) => x.textContent)]));
  const users = (cGroups.find((x) => x[0] === 'RELAI 사용자') || [0, []])[1]; const team = (cGroups.find((x) => x[0] === '팀원 (계정 없음)') || [0, []])[1];
  check('J-A2 PM listed once (RELAI 사용자), not again as 팀원 (계정 없음)', users.includes('홍길동') && !team.some((t) => /홍길동/.test(t)) && team.includes('김피엠 · PM'), JSON.stringify(cGroups));
  await shot('14-accept-owner-picker.png');

  // J-A3: 03 activity copy (What's Next, project A in 03)
  const D = await mkProject('복사 확인 프로젝트', { n: 1 });
  await page.goto(D.url); await page.waitForSelector('.np__list');
  const npText = await page.textContent('.np__list');
  check('J-A3 row 요구사항–WBS 연결 (no English)', /요구사항–WBS 연결/.test(npText) && !/Requirements ↔ WBS/.test(npText));
  check('J-A3 일정 입력: 작업 수준 (no "Task 수준")', /작업 수준/.test(npText) && !/Task 수준/.test(npText));

  // B-1: a legacy project that passed 01–03 before the gates existed (phase rows set directly) — no ✓ anywhere while REQUIRED is open
  if (process.env.DATABASE_URL) {
    const { Client } = require('pg'); const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect();
    const E = await mkProject('예전 프로젝트', { n: 1 });
    await pg.query(`UPDATE project_phases SET status = 'COMPLETED' WHERE project_id = $1 AND phase_key IN ('INITIATION','REQUIREMENTS','ANALYSIS_DESIGN')`, [E.p.id]);
    await pg.query(`UPDATE project_phases SET status = 'IN_PROGRESS' WHERE project_id = $1 AND phase_key = 'DEVELOPMENT'`, [E.p.id]);
    await pg.query(`UPDATE projects SET current_phase = 'DEVELOPMENT' WHERE id = $1`, [E.p.id]);
    await pg.end();
    await page.goto(E.url); await page.waitForSelector('.pstep li');
    const stepper = await page.$$eval('.pstep li', (els) => els.slice(0, 4).map((e) => [e.className.trim().split(/\s+/)[0], e.querySelector('.st').textContent]));
    check('B-1 stepper: 01–03 ◐ (is-gap), no ✓; 04 current', JSON.stringify(stepper) === JSON.stringify([['is-gap', '◐'], ['is-gap', '◐'], ['is-gap', '◐'], ['is-cur', '●']]), JSON.stringify(stepper));
    const lnb = await page.$$eval('.lnb__ph', (els) => els.slice(0, 3).map((e) => [e.classList.contains('is-gap'), e.querySelector('.lnb__mark').textContent]));
    check('B-1 LNB: 01–03 number + count, no ✓', lnb.length === 3 && lnb.every(([gap, m]) => gap && m !== '✓'), JSON.stringify(lnb));
    await shot('15-accept-b1-stepper.png');
    await page.goto(`${BASE}/app`); await page.waitForSelector(`.hc[data-pid="${E.p.id}"]`);
    const bar = await page.$$eval(`.hc[data-pid="${E.p.id}"] .lcpos i`, (els) => els.map((e) => e.className));
    check('B-1 Home lifecycle bar: 01–03 amber (is-gap), never green', JSON.stringify(bar.slice(0, 4)) === JSON.stringify(['is-gap', 'is-gap', 'is-gap', 'is-cur']), JSON.stringify(bar));
  } else check('B-1 legacy project (needs DATABASE_URL)', false, 'DATABASE_URL not set');

  // L-C6: Home — 워크스페이스 (no English) · no 진행률 slot / doubled separator on a card without tasks
  await page.goto(`${BASE}/app`); await page.waitForSelector(`.hc[data-pid="${D.p.id}"]`);
  const sub = await page.textContent('.page__head p');
  check('L-C6 Home subtitle 워크스페이스', /워크스페이스/.test(sub) && !/Workspace/.test(sub), sub);
  const strip = (await page.textContent(`.hc[data-pid="${D.p.id}"] .hc__strip`)).replace(/\s+/g, ' ').trim();
  check('L-C6 empty progress: no "진행률 -" and no doubled separator', !/진행률/.test(strip) && !/·\s*·/.test(strip) && !/^·/.test(strip), strip);
  await shot('16-accept-home.png');

  // L-C1: WBS grid — one text format for dates (10/20) and progress (0%) on editable rows; no mm/dd/yyyy; owner name + 계정 없음 not clipped
  await page.goto(`${A.url}/wbs`); await page.waitForSelector('main table');
  await page.mouse.move(5, 5);
  const fmt = await page.$$eval('main tbody tr:not(.is-group)', (trs) => trs.slice(0, 12).map((tr) => [...tr.querySelectorAll('.cedit__v')].map((v) => v.textContent.trim())).flat());
  check('L-C1 editable dates as M/DD, progress as N%', fmt.length > 0 && fmt.every((t) => /^(\d{1,2}\/\d{2}|-|\d{1,3}%)$/.test(t)) && fmt.some((t) => /%$/.test(t)) && fmt.some((t) => /\//.test(t)), JSON.stringify(fmt.slice(0, 8)));
  const restInput = await page.$eval('main tbody tr:not(.is-group) .cedit .cell--date', (e) => getComputedStyle(e).color);
  check('L-C1 native date text hidden at rest (no mm/dd/yyyy)', restInput === 'rgba(0, 0, 0, 0)', restInput);
  const clip = await page.$eval(`main tr[data-id="${design.id}"] .wnoacct`, (e) => { const td = e.closest('td').getBoundingClientRect(); const r = e.getBoundingClientRect(); return r.right <= td.right + 0.5 && e.scrollWidth <= e.clientWidth + 1; }).catch(() => false);
  const ownerSel = await page.$eval(`main tr[data-id="${design.id}"] select[data-edit="owner"]`, (e) => [e.options[e.selectedIndex].textContent, e.scrollWidth <= e.clientWidth + 1]).catch(() => ['', false]);
  check('L-C1 owner cell: name only + 계정 없음 fully visible', clip && ownerSel[0] === '박협력', JSON.stringify(ownerSel));
  await shot('17-accept-grid-format.png');

  await browser.close();
  const fails = results.filter((x) => !x[1]);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
