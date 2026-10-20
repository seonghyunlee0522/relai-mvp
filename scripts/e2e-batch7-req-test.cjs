// batch7 T4 (요구사항·테스트) browser check — hive research/relai-batch7-spec.md #11 · #13 · #18 · #20:
// #13 요구사항 tabs = 목록 · 연결 현황; 02 '요구사항 분류' link opens the 목록 with the 미분류 chip on and the 유형 column; ?view=classify still works;
//     연결 현황 = coverage 3칸 + matrix (WBS 작업 · 테스트 · 최근 결과 · 지라), red 없음, 연결 안 된 것 먼저, 바로가기.
// #11 담당자 picker 조직·부서 → 사람 (고객사 관계자 included for 요구사항): detail, list label "한도윤 · 다온생명", bulk bar uses the same picker.
// #20 테스트 실행 = inline 실행 기록 in the detail (no .dialog--run): 단계별 결과, FAIL + 이슈로 등록 → 1 issue, 이력 updates at once; phone stays view-only.
// #18 AI로 시나리오 만들기 (mock AI): default selection, 30 크레딧, cards with 유형 · 사전 조건 · 테스트 계정·데이터 · 단계 · 최종 예상 결과, no ₩, save → tests + links.
// Not part of `npm test` (needs a running server + Playwright; the server must run AI_PROVIDER=fake AI_FAKE_AUTOREPLY=1 DEV_INITIAL_AI_CREDITS>=100 PLAN_LIMITS=off):
//   BASE=http://127.0.0.1:3047 SHOTS=research/relai-b7-t4 DATABASE_URL=postgres://… [NODE_PATH=<dir with playwright>] node scripts/e2e-batch7-req-test.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3047';
const SHOTS = process.env.SHOTS || 'b7-t4-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => (DB ? execFileSync('psql', ['-q', '-t', '-A', DB, '-c', q]).toString().trim() : '');

const SH = [
  { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '수행사', department: 'PMO', role: 'PM' },
  { id: 'sh-han', name: '한도윤', org_type: 'CLIENT', org: '다온생명', department: '고객경험본부', role: '과장' },
  { id: 'sh-ko', name: '고은비', org_type: 'CLIENT', org: '다온생명', department: 'IT기획팀', role: '대리' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '누리소프트', department: '개발1팀', role: '개발' },
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = (n, pg = page) => pg.screenshot({ path: `${SHOTS}/${n}` });
  const settle = async (sel = '#main') => { await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(400); };
  const toastText = async (re) => { await page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 8000 }).catch(() => {}); return page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | ')).catch(() => ''); };
  const colsOf = () => page.$$eval('#grid th', (ths) => ths.map((t) => t.textContent.trim()));

  const email = `b7t4-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '홍길동', email, password: 'passw0rd!' });
  check('signup 201', s.status === 201, JSON.stringify(s.json));
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: '다온생명 보험금 청구 포털', client_name: '다온생명', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-03-31' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`;
  await api('PUT', `${pa}/definition`, { stakeholders: SH });
  for (const key of ['REQUIREMENTS']) { const ph = (await api('GET', pa)).json.phases.find((x) => x.phase_key === key); await api('POST', `${pa}/phases/${ph.id}/activate`, { reason: 'NEXT' }); }   // 02: the 요구사항 분류 row is on 지금 할 일
  const R = [];
  for (const [title, extra] of [['보험금 청구 접수', { type: 'FUNCTIONAL', priority: 'HIGH' }], ['청구 진행 상태 조회', { type: 'FUNCTIONAL', priority: 'MEDIUM' }], ['청구 결과 알림톡 발송', { type: 'INTERFACE', priority: 'LOW' }]]) {
    R.push((await api('POST', `${pa}/requirements`, { title, scope: 'IN_SCOPE', status: 'CONFIRMED', criteria: [`${title} 결과가 화면에 보인다`], ...extra })).json.requirement);
  }
  R.push((await api('POST', `${pa}/requirements`, { title: '서류 이미지 자동 판독', scope: 'IN_SCOPE' })).json.requirement);                    // 미분류 · 우선순위 미지정
  R.push((await api('POST', `${pa}/requirements`, { title: '오프라인 지점 연동', scope: 'OUT_OF_SCOPE', status: 'REJECTED', type: 'INTERFACE', priority: 'LOW' })).json.requirement);
  const wb = (await api('POST', `${pa}/wbs`, { title: '청구 접수 화면 개발', planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' })).json.item;
  await api('POST', `${pa}/requirements/${R[0].id}/links`, { wbs_item_id: wb.id });

  /* ---------- #13 tabs · 미분류 chip ---------- */
  await page.goto(`${BASE}${U}/requirements`); await settle('#grid');
  const tabs = await page.$$eval('.stabs [data-stab]', (els) => els.map((e) => [e.dataset.stab, e.textContent.trim()]));
  check('#13 요구사항 tabs = 목록 · 연결 현황 (2)', tabs.length === 2 && tabs[0][1].startsWith('목록') && tabs[1][1].startsWith('연결 현황'), JSON.stringify(tabs));
  const chips = await page.$$eval('[data-cls]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('#13 목록 top: 미분류 1 · 우선순위 미지정 1 chips', JSON.stringify(chips) === JSON.stringify(['1미분류', '1우선순위 미지정']), JSON.stringify(chips));
  await page.goto(`${BASE}${U}`); await settle('.np__list');
  const cls = await page.$('.np__row[data-step-key="CLASSIFY"] .np__open');
  if (cls) { await cls.click(); await settle('#grid'); } else await page.goto(`${BASE}${U}/requirements?type=UNSPECIFIED`);
  await settle('#grid');
  const on = await page.$eval('[data-cls="type"]', (b) => b.getAttribute('aria-pressed')).catch(() => '');
  const c1 = await colsOf(); const rowsN = await page.$$eval('#grid tbody tr[data-id]', (t) => t.length);
  check('#13 02 요구사항 분류 → 목록 with 미분류 chip on, 유형 column shown, only the unclassified row', Boolean(cls) && on === 'true' && c1.some((c) => c.includes('유형')) && rowsN === 1 && /type=UNSPECIFIED/.test(page.url()), JSON.stringify({ cls: Boolean(cls), on, c1, rowsN, url: page.url() }));
  await shot('01-req-list-classify-chip.png');
  await page.click('[data-cls="type"]'); await page.waitForTimeout(700);
  check('#13 chip off → full 목록, filter removed', !/type=UNSPECIFIED/.test(page.url()) && (await page.$$eval('#grid tbody tr[data-id]', (t) => t.length)) === 5, page.url());
  await page.goto(`${BASE}${U}/requirements?view=classify`); await settle('#grid');
  check('#13 old ?view=classify link → 목록 + 미분류 filter (still unclassified rows)', /type=UNSPECIFIED/.test(page.url()) && (await page.getAttribute('.stabs [aria-current="page"]', 'data-stab')) === 'requirements', page.url());

  /* ---------- #13 연결 현황 ---------- */
  const t0 = (await api('POST', `${pa}/tests`, { title: '청구 조회 확인' })).json.test;
  await api('POST', `${pa}/tests/${t0.id}/links`, { target_type: 'REQUIREMENT', target_id: R[1].id });
  await api('POST', `${pa}/tests/${t0.id}/executions`, { result: 'PASS' });
  await page.goto(`${BASE}${U}/requirements?view=trace`); await settle('[data-covbar]');
  const cov = (await page.textContent('[data-covbar]')).replace(/\s+/g, ' ');
  check('#13 coverage 3칸: 범위 내 4건 중 WBS 연결 1 · 테스트 연결 1 · 통과 1', /범위 내 요구사항 4건/.test(cov) && /1 \/ 4\s*WBS 연결/.test(cov) && /1 \/ 4\s*테스트 연결/.test(cov) && /1 \/ 4\s*테스트 통과/.test(cov), cov);
  const tc = await colsOf();
  check('#13 matrix columns WBS 작업 · 테스트 · 최근 결과 · 지라 (테스트 열 있음)', ['WBS 작업', '테스트', '최근 결과', '지라'].every((x) => tc.some((c) => c.startsWith(x))), JSON.stringify(tc));
  const order = await page.$$eval('#grid tbody tr[data-id]', (t) => t.map((x) => x.dataset.id));
  check('#13 연결 안 된 것 먼저 (both gaps first, the out-of-scope row last)', order[0] === R[2].id || order[0] === R[3].id ? order[order.length - 1] === R[4].id : false, JSON.stringify(order.map((id) => R.findIndex((r) => r.id === id))));
  const none = await page.$$eval('[data-tr-none]', (e) => e.length);
  check('#13 red 없음 badges for in-scope gaps only (R2 WBS, R3/R4 both, R1 test → 6)', none === 6, `none=${none}`);
  check('#13 바로가기: WBS 연결 (R2·R3·R4) · 테스트 만들기 (R1·R3·R4)', (await page.$$('[data-tr-link]')).length === 3 && (await page.$$('[data-tr-test]')).length === 3);
  await shot('02-req-trace-matrix-1440.png');
  await page.setViewportSize({ width: 1920, height: 1000 }); await page.waitForTimeout(300); await shot('02b-req-trace-matrix-1920.png');
  await page.setViewportSize({ width: 2560, height: 1200 }); await page.waitForTimeout(300); await shot('02c-req-trace-matrix-2560.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click(`[data-tr-link="${R[2].id}"]`); await page.waitForSelector('#drawer:not([hidden]) #link-add');
  check('#13 바로가기 WBS 연결 opens the detail on the WBS 연결 tab', await page.$eval('#drawer [data-dtab="links"]', (b) => b.classList.contains('is-on') || b.getAttribute('aria-selected') === 'true'));

  /* ---------- #11 담당자 picker 조직·부서 → 사람 ---------- */
  await page.goto(`${BASE}${U}/requirements?sel=${R[0].id}`); await page.waitForSelector('#drawer [data-opick]');
  const gl = await page.$$eval('#drawer [data-opick-g] option', (o) => o.map((x) => x.textContent.trim()));
  check('#11 1단계 조직·부서: 우리 팀 · 다온생명 · 고객경험본부 · 다온생명 · IT기획팀 · 누리소프트 · 개발1팀', JSON.stringify(gl) === JSON.stringify(['우리 팀 (2)', '다온생명 · 고객경험본부 (1)', '다온생명 · IT기획팀 (1)', '누리소프트 · 개발1팀 (1)']), JSON.stringify(gl));
  await page.selectOption('#drawer [data-opick-g]', '1'); await page.waitForTimeout(200);
  const people = await page.$$eval('#drawer [data-field="owner"] option', (o) => o.map((x) => x.textContent.trim()));
  check('#11 2단계 사람: 미지정 + 한도윤 · 과장 only', JSON.stringify(people) === JSON.stringify(['미지정', '한도윤 · 과장']), JSON.stringify(people));
  await shot('03-owner-picker-department.png');
  await page.selectOption('#drawer [data-field="owner"]', 's:sh-han'); await page.waitForTimeout(900);
  const r0 = (await api('GET', `${pa}/requirements/${R[0].id}`)).json.requirement;
  check('#11 saved: 관계자 owner, label 한도윤 · 다온생명', r0.owner_stakeholder_id === 'sh-han' && r0.owner_label === '한도윤 · 다온생명', JSON.stringify([r0.owner_stakeholder_id, r0.owner_label]));
  await page.goto(`${BASE}${U}/requirements`); await settle('#grid');
  const cell = await page.$eval(`#grid tr[data-id="${R[0].id}"]`, (tr) => [...tr.querySelectorAll('td')].map((td) => { const sl = td.querySelector('select'); return sl ? sl.selectedOptions[0].text + td.textContent.replace(/[\s\S]*<\/select>/, '') + [...td.querySelectorAll('small')].map((x) => x.textContent).join(' ') : td.textContent; }).join(' | '));
  check('#11 목록 담당자 열: 한도윤 · 다온생명 + 계정 없음', /한도윤 · 다온생명/.test(cell) && /계정 없음/.test(cell), cell.replace(/\s+/g, ' ').slice(0, 160));
  await page.fill('#q', '판독'); await page.waitForTimeout(200);
  await page.fill('#q', ''); await page.waitForTimeout(600);
  await page.goto(`${BASE}${U}/requirements?owner=s:sh-han`); await settle('#grid');
  check('#11 담당자 filter by 관계자', (await page.$$eval('#grid tbody tr[data-id]', (t) => t.map((x) => x.dataset.id))).join() === R[0].id);
  // bulk bar: the same picker
  await page.goto(`${BASE}${U}/requirements?select=1`); await settle('#grid');
  for (const r of [R[1], R[2]]) await page.check(`#grid tr[data-id="${r.id}"] [data-pick]`);
  await page.selectOption('.bulk [data-bf]', 'owner'); await page.waitForSelector('.bulk [data-opick-g]');
  check('#11 bulk 담당자: 일괄 변경 disabled until a person is picked', await page.$eval('.bulk [data-bapply]', (b) => b.disabled));
  await page.selectOption('.bulk [data-opick-g]', '2'); await page.selectOption('.bulk [data-bv]', 's:sh-ko');
  await shot('04-bulk-owner-picker.png');
  await page.click('.bulk [data-bapply]'); await toastText(/변경했습니다/);
  const bo = (await api('GET', `${pa}/requirements?owner=s:sh-ko`)).json.requirements.map((x) => x.id).sort();
  check('#11 bulk applied: 2 requirements → 고은비 (다온생명 IT기획팀)', JSON.stringify(bo) === JSON.stringify([R[1].id, R[2].id].sort()), JSON.stringify(bo));
  const doc = await page.request.fetch(`${BASE}${pa}/requirements/export-doc?format=docx`);
  check('#11 요구사항 정의서 export still downloads (담당자 column — content in unit test)', doc.status() === 200);

  /* ---------- #20 inline 실행 기록 ---------- */
  const t1 = (await api('POST', `${pa}/tests`, { title: '보험금 청구 접수 확인', status: 'READY', steps: [{ instruction: '청구 화면을 연다', expected: '화면이 열린다' }, { instruction: '서류를 첨부하고 접수한다', expected: '접수 번호가 보인다' }], expected_result: '접수 완료', test_data: '청구 이력이 있는 고객 계정' })).json.test;
  await api('POST', `${pa}/tests/${t1.id}/links`, { target_type: 'REQUIREMENT', target_id: R[0].id });
  await page.goto(`${BASE}${U}/tests?sel=${t1.id}`); await page.waitForSelector('#drawer #run');
  await page.click('#run'); await page.waitForSelector('[data-runbox]'); await page.waitForTimeout(500);
  const focus = await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('[data-runbox]')));
  check('#20 테스트 실행 → inline 실행 기록 in the detail (no modal), first input focused', (await page.$$('.dialog--run, [data-dialog="run"]')).length === 0 && focus);
  await page.check('[data-run-step="0"] input[value=PASS]'); await page.check('[data-run-step="1"] input[value=FAIL]');
  check('#20 every step answered → overall 실패 suggested, 이슈로 등록 shown (checked)', await page.isChecked('[data-runbox] input[name=result][value=FAIL]') && !(await page.$eval('#rd-issue-wrap', (e) => e.hidden)) && await page.isChecked('#rd-issue'));
  await page.fill('#rd-actual', '접수 버튼을 누르면 오류 500'); await page.fill('#rd-note', 'PC Chrome');
  await shot('05-test-inline-run.png');
  await page.click('#run-save');
  const tt = await toastText(/결과를 기록/);
  const t1b = (await api('GET', `${pa}/tests/${t1.id}`)).json.test;
  const issues = (await api('GET', `${pa}/issues`)).json.items;
  check('#20 FAIL + 이슈로 등록 → 1 issue in the same save, toast names it', issues.length === 1 && t1b.executions[0].issue_display_id === issues[0].display_id && tt.includes(issues[0].display_id), tt);
  check('#20 단계별 결과 stored', JSON.stringify(t1b.executions[0].step_results) === JSON.stringify([{ index: 0, result: 'PASS' }, { index: 1, result: 'FAIL' }]));
  await page.waitForSelector('[data-runlog-i]');
  check('#20 이력 updates at once (최근 실행 under the form, 단계 1/2 통과)', /#1/.test(await page.textContent('[data-runlog]')) && /단계 1\/2 통과/.test(await page.textContent('[data-runlog]')));
  check('#20 테스트 계정·데이터 field in the detail', (await page.inputValue('#drawer [data-field="test_data"]')) === '청구 이력이 있는 고객 계정');
  await shot('06-test-after-run.png');

  /* ---------- #18 AI로 시나리오 만들기 (mock AI) ---------- */
  const bal0 = (await api('GET', `${pa}/ai/status`)).json.credits.available;
  const n0 = (await api('GET', `${pa}/tests`)).json.items.length;
  await page.goto(`${BASE}${U}/tests`); await settle('#ai-testgen');
  await page.click('#ai-testgen'); await page.waitForSelector('[data-dialog="test-gen"] [data-tg-reqs]');
  const picked = await page.$$eval('[data-tg-req]:checked', (e) => e.map((x) => x.dataset.tgReq));
  check('#18 default selection = 확정 · 범위 내 · 테스트 미연결 (R3 only: R1/R2 have tests, R4 is not 확정)', JSON.stringify(picked) === JSON.stringify([R[2].id]), JSON.stringify(picked));
  await page.check(`[data-tg-req="${R[3].id}"]`);
  const costTxt = await page.textContent('[data-tg-cost]');
  check('#18 cost line in 크레딧 (30), no ₩', /30/.test(costTxt) && /크레딧/.test(costTxt) && !/₩/.test(await page.textContent('[data-dialog="test-gen"]')), costTxt);
  await page.click('#tg-run'); await page.waitForSelector('[data-tg-card]', { timeout: 20000 });
  const cards = await page.$$eval('[data-tg-card]', (els) => els.map((c) => ({ n: c.querySelectorAll('[data-tg-sc]').length, types: [...c.querySelectorAll('[data-tg-type]')].map((t) => t.textContent.trim()), heads: [...c.querySelectorAll('th')].map((t) => t.textContent.trim()) })));
  check('#18 one card per requirement, 1~3 scenarios, 유형 tags', cards.length === 2 && cards.every((c) => c.n >= 1 && c.n <= 3) && cards[0].types.includes('정상'), JSON.stringify(cards.map((c) => [c.n, c.types])));
  check('#18 scenario fields: 사전 조건 · 테스트 계정·데이터 · 단계 · 예상 결과 · 최종 예상 결과 · 대상 환경', ['사전 조건', '테스트 계정·데이터', '단계 · 예상 결과', '최종 예상 결과', '대상 환경'].every((h) => cards[0].heads.includes(h)), JSON.stringify(cards[0].heads));
  const dlgTxt = await page.textContent('[data-dialog="test-gen"]');
  check('#18 30 크레딧 사용 shown, no ₩ anywhere in the sheet', /30 크레딧 사용/.test(dlgTxt) && !/₩/.test(dlgTxt), (dlgTxt.match(/[^.]*크레딧[^.]*/) || [''])[0]);
  await shot('07-ai-testgen-sheet.png');
  const firstSel = await page.$$('[data-tg-sel]'); await firstSel[firstSel.length - 1].uncheck();
  const commitLabel = await page.textContent('#tg-commit');
  const expectN = (await page.$$eval('[data-tg-sel]:checked', (e) => e.length));
  await page.click('#tg-commit'); await toastText(/테스트 \d+건을 만들었습니다/);
  const after = (await api('GET', `${pa}/tests`)).json.items;
  const bal1 = (await api('GET', `${pa}/ai/status`)).json.credits.available;
  check(`#18 save → only the ticked ${expectN} scenarios become tests (DRAFT) linked to their requirement`, after.length === n0 + expectN && after.filter((t) => t.requirement_count === 1 && t.status === 'DRAFT').length >= expectN, `${commitLabel} n0=${n0} after=${after.length}`);
  check('#18 credits 30 used for the run', bal0 - bal1 === 30, `${bal0} → ${bal1}`);
  const gen = after.find((t) => t.title.startsWith(R[2].display_id));
  const genD = (await api('GET', `${pa}/tests/${gen.id}`)).json.test;
  check('#18 saved test keeps 테스트 계정·데이터 and 단계', Boolean(genD.test_data) && genD.steps.length >= 1 && genD.links.requirements[0].target_id === R[2].id, JSON.stringify([genD.test_data, genD.steps.length]));

  /* ---------- 390px: view only ---------- */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const mp = await mctx.newPage(); mp.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR(m)', e.message); });
  await mp.goto(`${BASE}${U}/requirements?view=trace`); await mp.waitForSelector('[data-covbar]', { timeout: 10000 }).catch(() => {}); await mp.waitForTimeout(500);
  const seg = await mp.$$eval('[data-rview]', (b) => b.map((x) => x.textContent.trim()));
  const vw = await mp.evaluate(() => document.documentElement.scrollWidth);
  check('390px 요구사항: 목록 · 연결 현황 switch, coverage shown, no sideways scroll', JSON.stringify(seg) === JSON.stringify(['요구사항 목록', '연결 현황']) && Boolean(await mp.$('[data-covbar]')) && vw <= 390, JSON.stringify({ seg, vw }));
  await shot('08-m-req-trace.png', mp);
  await mp.goto(`${BASE}${U}/tests?sel=${t1.id}`); await mp.waitForSelector('#drawer:not([hidden]) .drawer__x'); await mp.waitForTimeout(300);
  check('390px 테스트 상세: no 실행 기록 form (view only)', !(await mp.$('[data-runbox]')) && !(await mp.$$eval('#drawer #run', (els) => els.some((e) => e.getBoundingClientRect().width > 0))));
  await shot('09-m-test-detail.png', mp);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
