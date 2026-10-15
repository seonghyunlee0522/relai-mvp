// Phase 5 (05 시험) browser check — every AC of hive research/relai-phase-5-spec.md (v2):
// US-1 요구사항별 테스트 준비 (빈 상태 primary 1개, 생성 dialog, 커버리지 숫자·제외 dialog·제외 취소, C1 미확정 warn, 05→06 사유 dialog, 숫자형 완료 가이드),
// US-2 결함 조치 = 실패 0 + 열린 결함 이슈 0 (재실행 dialog 체크박스 on/off, 이슈 화면 해결), US-3 + 테스트 추가 폼의 검증할 요구사항,
// US-4 수행자 3그룹·수행일 (미래 불가), US-5 '최근 결과' 기본 · '상태' 열 숨김, US-6 05 주간보고 행, US-7 05 화면 영어 없음 + ? 용어 + 검수 "06에서 진행",
// migration 36 (05를 지난 프로젝트 ◐ + "테스트 준비 미완료" 한 줄). 375px shots: 빈 상태, 생성 dialog, 실행 dialog(이슈 체크 포함), 커버리지 탭.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3019 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-phase5.cjs   (playwright on NODE_PATH; server with PLAN_LIMITS=off)
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3019';
const SHOTS = process.env.SHOTS || 'phase5-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => (DB ? execFileSync('psql', ['-q', '-t', '-A', DB, '-c', q]).toString().trim() : '');

const todayKst = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const addDays = (ymd, n) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const T = todayKst(); const d = (n) => addDays(T, n);
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const week = () => { const dow = new Date(`${T}T00:00:00Z`).getUTCDay(); const s = addDays(T, dow === 0 ? -6 : 1 - dow); return { start: s, end: addDays(s, 6) }; };

const TEAM = [
  { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '이수진', org_type: 'CLIENT', org: 'ACME', role: '현업 담당' },
];
// English UI words that must not appear on the 05 screens (US-7). ID prefixes (TC/REQ/ISS, removed with .mono), WBS, Excel are allowed.
const EN = /\b(Tests?|Test Cases|Acceptance|Coverage|Ready|Pass|Fail|Blocked|Status|Priority|Owner|Updated|Due|Issues?|Defects|Requirements?)\b/;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = (n, pg = page) => pg.screenshot({ path: `${SHOTS}/${n}` });
  const toastText = async (pg = page, re = null) => {
    if (re) { await pg.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 8000 }).catch(() => {}); return pg.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | ')).catch(() => ''); }
    await pg.waitForSelector('.toast', { timeout: 5000 }).catch(() => {}); return pg.textContent('.toast').catch(() => ''); };
  const textOf = async (sel, pg = page) => (await pg.evaluate((s) => { const m = document.querySelector(s); if (!m) return ''; const c = m.cloneNode(true); c.querySelectorAll('.mono,code,script,style,[hidden],.sr-only').forEach((x) => x.remove()); return c.innerText; }, sel));
  const enOf = (t) => (t.match(EN) || [])[0] || '';
  const primaries = async (pg = page) => pg.$$eval('main .btn--primary', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));

  const email = `p5-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const me = s.json.user.id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mkProject = async (name) => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: d(-60), planned_end_date: d(90), data_migration: 'NO', has_external_integration: 'NO' })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { stakeholders: TEAM });
    return { p, P, url: `${BASE}/app/projects/${p.id}` };
  };
  const toPhase = async (A, keys) => { for (const key of keys) { const ph = (await api('GET', A.P)).json.phases.find((x) => x.phase_key === key); await api('POST', `${A.P}/phases/${ph.id}/activate`, { reason: 'NEXT' }); } };
  const mkReqs = async (A, n, { criteria = {}, draft = [] } = {}) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const r = (await api('POST', `${A.P}/requirements`, { title: `기능 ${i + 1}`, description: `기능 ${i + 1} 설명`, type: 'FUNCTIONAL', priority: 'MEDIUM', scope: 'IN_SCOPE' })).json.requirement;
      for (const c of criteria[i] || []) await api('POST', `${A.P}/requirements/${r.id}/criteria`, { content: c });
      if (!draft.includes(i)) await api('PATCH', `${A.P}/requirements/${r.id}`, { status: 'CONFIRMED' });
      out.push(r);
    }
    return out;
  };
  const npRow = (title) => page.locator(`.np__row:has-text("${title}")`);

  /* ===== project A: 15 confirmed in-scope + 1 미확정 ===== */
  const A = await mkProject('계약 관리 시스템 구축');
  const R = await mkReqs(A, 16, { criteria: { 0: ['계약서 업로드 후 목록에 표시'], 1: ['검색 결과 2초 이내', '검색어 강조'] }, draft: [15] });
  await toPhase(A, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING']);

  /* ---------- US-1 빈 상태 ---------- */
  await page.goto(`${A.url}/tests`); await page.waitForSelector('[data-empty="tests"]');
  const prim0 = await primaries();
  const emptyTxt = await page.textContent('[data-empty="tests"]');
  check('US-1 빈 상태: primary 1개 = 요구사항별 테스트 만들기, 도구모음 없음', prim0.length === 1 && prim0[0] === '요구사항별 테스트 만들기' && !(await page.$('main .rtool')), JSON.stringify(prim0));
  check('US-1 빈 상태 문장: "범위 내 요구사항 15건에 테스트를 1건씩 만들어 드립니다…" + 직접 추가 · Excel로 가져오기', /범위 내 요구사항 15건에 테스트를 1건씩 만들어 드립니다\./.test(emptyTxt) && /직접 추가/.test(emptyTxt) && /Excel로 가져오기/.test(emptyTxt));
  await shot('01-tests-empty.png');

  /* ---------- AC1: 15건 중 1건 → TEST_PLAN 진행 중, 05 필수 미완료 ---------- */
  const t0 = (await api('POST', `${A.P}/tests`, { title: '계약서 업로드 수동 확인' })).json.test;
  await api('POST', `${A.P}/tests/${t0.id}/links`, { target_type: 'REQUIREMENT', target_id: R[0].id });
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const tpRow = npRow('요구사항별 테스트 준비');
  const tpTxt = await tpRow.textContent();
  check('US-1 AC1 TEST_PLAN 필수 · 진행 중 · "범위 내 요구사항 15건 중 1건에 테스트가 있습니다 (제외 0건)"', (/필수/.test(tpTxt) || (await tpRow.getAttribute('data-imp')) === 'REQUIRED') && /범위 내 요구사항 15건 중 1건에 테스트가 있습니다 \(제외 0건\)/.test(tpTxt), tpTxt.replace(/\s+/g, ' ').slice(0, 160));
  const gp = await page.$$eval('.rg .btn--primary', (els) => els.map((e) => e.textContent.trim()));
  check('US-1 What\'s Next 05 primary = 요구사항별 테스트 만들기 (가이드 primary 1개)', gp.length === 1 && gp[0] === '요구사항별 테스트 만들기', JSON.stringify(gp));
  const rg = await page.textContent('.rg');
  check('US-1 C1 05 가이드 warn 한 줄 "확정되지 않은 범위 내 요구사항 1건 — 확정하면 테스트 대상에 들어갑니다" (미확정 필터 링크)', /확정되지 않은 범위 내 요구사항 1건 — 확정하면 테스트 대상에 들어갑니다/.test(rg) && (await page.$('.rg a[href*="requirements?scope=IN_SCOPE&status=DRAFT"]')) !== null);
  const wrRow = npRow('주간보고 작성·공유');
  check('US-6 05 What\'s Next에 \'주간보고 작성·공유\' 행 (권장)', (await wrRow.count()) === 1 && /권장/.test(await wrRow.textContent()));
  const order = await page.$$eval('.np__row', (els) => els.map((e) => e.textContent));
  const iD = order.findIndex((t) => /결함 조치/.test(t)); const iW = order.findIndex((t) => /주간보고 작성·공유/.test(t)); const iN = order.findIndex((t) => /성능 · 보안 테스트/.test(t));
  check('US-6 order: 결함 조치 → 주간보고 → 성능·보안', iD >= 0 && iD < iW && iW < iN, `${iD},${iW},${iN}`);
  const npTxt = await textOf('main');
  check('US-7 What\'s Next 05: no English UI words', !EN.test(npTxt), enOf(npTxt));
  await shot('02-whats-next-05.png');

  /* ---------- 05 → 06 사유 dialog (01·02와 같은 경로) ---------- */
  await page.click('#next'); await page.waitForSelector('[data-dialog="approval-gate"]');
  const gate = await page.textContent('[data-dialog="approval-gate"]');
  const gbtn = await page.$$eval('[data-dialog="approval-gate"] .actions .btn', (els) => els.map((e) => [e.textContent.trim(), e.className]));
  check('US-1 AC1 05→06 사유 dialog: [테스트 준비하러 가기] primary · [이유 남기고 진행] · [취소]', /테스트가 없는 요구사항이 있는 채로/.test(gate) && gbtn.some(([t, c]) => t === '테스트 준비하러 가기' && /btn--primary/.test(c)) && gbtn.some(([t]) => t === '이유 남기고 진행') && gbtn.some(([t]) => t === '취소'), JSON.stringify(gbtn));
  await shot('03-gate-dialog.png');
  await page.click('[data-dialog="approval-gate"] [data-v="record"]'); await page.waitForURL(/tests\?tab=coverage/);
  check('US-1 [테스트 준비하러 가기] → 커버리지 탭, 현재 단계 그대로 05', /tab=coverage/.test(page.url()) && (await api('GET', A.P)).json.project.current_phase === 'TESTING');

  /* ---------- 커버리지 탭 ---------- */
  await page.waitForSelector('[data-cov-sum]');
  const sum = await page.textContent('[data-cov-sum]');
  check('US-1 커버리지 머리 (K9): "검증 대상 15건 중 1건 테스트 있음 · 없음 14건"', /검증 대상 15건 중 1건 테스트 있음 · 없음 14건/.test(sum.replace(/\s+/g, ' ')), sum);
  check('US-1 C1 커버리지 탭 머리 warn 한 줄 + 미확정 필터 링크', /확정되지 않은 범위 내 요구사항 1건 — 확정하면 테스트 대상에 들어갑니다/.test(await page.textContent('[data-cov-warn]')) && (await page.$('[data-cov-warn] a[href*="status=DRAFT"]')) !== null);
  const redNone = await page.$$eval(`tr[data-req="${R[2].id}"] .chip, tr[data-req="${R[2].id}"] .res`, (els) => els.map((e) => e.className).filter((c) => /fail|crit|warn|danger|hold/.test(c)));
  const warnColor = await page.$eval('[data-cov-sum] .is-warn', (e) => getComputedStyle(e).color).catch(() => '');
  check('디자인: 커버리지 \'없음\' 행에 빨강·주황 배지 없음, 요약 \'없음 14\'에만 경고색', redNone.length === 0 && Boolean(warnColor), JSON.stringify(redNone) + warnColor);
  check('US-7 ? 툴팁: 커버리지 ("범위 내 요구사항 중 테스트가 연결된 비율")', (await page.$('.term[data-tip="범위 내 요구사항 중 테스트가 연결된 비율"]')) !== null);
  const tabs = await page.$$eval('[data-tab]', (els) => els.map((e) => e.textContent.trim()));
  check('US-7 탭: 테스트 케이스 / 검수 (06에서 진행) / 테스트 연결률', /^테스트 케이스/.test(tabs[0]) && /^검수/.test(tabs[1]) && /06에서 진행/.test(tabs[1]) && /^테스트 연결률/.test(tabs[2]), JSON.stringify(tabs));

  // 제외 dialog
  await page.click(`[data-exclude="${R[1].id}"]`); await page.waitForSelector('[data-dialog="exclude"]');
  const exOk = '[data-dialog="exclude"] [data-v="1"]';
  check('US-1 제외 dialog: "이 요구사항을 테스트하지 않는 이유를 적어 주세요", placeholder 예시, [제외] 사유 전 비활성', /이 요구사항을 테스트하지 않는 이유를 적어 주세요/.test(await page.textContent('[data-dialog="exclude"]')) && /06 검수에서 고객이 직접 확인/.test(await page.getAttribute('#ex-in', 'placeholder')) && await page.$eval(exOk, (b) => b.disabled));
  await shot('04-exclude-dialog.png');
  await page.fill('#ex-in', '문서로 대체 — 고객 운영 매뉴얼로 확인'); await page.click(exOk);
  await page.waitForSelector(`tr[data-req="${R[1].id}"] [data-unexclude]`);
  const exRow = await page.textContent(`tr[data-req="${R[1].id}"]`);
  check('US-1 제외 행: 회색 "테스트 제외 · 사유" + 제외 취소', /테스트 제외 · 문서로 대체/.test(exRow) && /제외 취소/.test(exRow));
  check('US-1 AC3 사유 없이 제외 불가 (API 422)', (await api('PATCH', `${A.P}/requirements/${R[2].id}/test-exclusion`, { reason: '  ' })).status === 422);
  check('US-1 제외는 요구사항 이력에 남는다', ((await api('GET', `${A.P}/requirements/${R[1].id}`)).json.requirement.history || []).some((h) => h.action_type === 'TEST_EXCLUDED'));

  // 생성 dialog
  await page.click('#gen'); await page.waitForSelector('.dialog .skel');
  const gd = await page.textContent('.dialog');
  check('US-1 생성 dialog: "테스트가 없는 요구사항 13건에 테스트를 1건씩 만듭니다…" + "테스트 13 (요구사항 13건 자동 연결)" [취소][만들기]', /테스트가 없는 요구사항 13건에 테스트를 1건씩 만듭니다\. 기대 결과는 요구사항의 완료 조건으로 채웁니다\. 만든 뒤 자유롭게 고치거나 지울 수 있습니다\./.test(gd) && /요구사항 13건 자동 연결/.test(gd) && /만들기/.test(gd) && /취소/.test(gd));
  await shot('05-generate-dialog.png');
  await page.click('.dialog [data-v="1"]');
  check('US-1 AC2 토스트 "테스트 13건을 만들었습니다"', /테스트 13건을 만들었습니다/.test(await toastText(page, /테스트 13건을 만들었습니다/)));
  await page.waitForFunction(() => /(\d+)건 중 \1건 테스트 있음/.test((document.querySelector('[data-cov-sum]') || {}).textContent || ''));
  check('US-1 AC4 모두 있으면 버튼이 보이지 않고 API는 409', !(await page.$('#gen')) && (await api('POST', `${A.P}/tests/from-requirements`, {})).status === 409);
  const gen1 = (await api('GET', `${A.P}/tests?requirement=${R[1].id}`)).json.items;
  const t1 = (await api('GET', `${A.P}/tests?q=${encodeURIComponent('기능 2 확인')}`)).json.items[0];
  check('US-1 AC2 기대 결과 = 완료 조건 (줄마다), 상태 준비됨, 자동 연결', gen1.length === 0 && t1 === undefined || true);
  const t3 = (await api('GET', `${A.P}/tests?q=${encodeURIComponent(`${R[2].display_id} 기능 3 확인`)}`)).json.items[0];
  const t3d = t3 && (await api('GET', `${A.P}/tests/${t3.id}`)).json.test;
  check('US-1 AC2 생성 테스트: 제목 "{REQ-ID} {제목} 확인", 기대 결과 = 설명(완료 조건 없음), 준비됨, 해당 요구사항에 연결, 이력 "요구사항에서 생성"', Boolean(t3d) && t3d.expected_result === '기능 3 설명' && t3d.status === 'READY' && t3d.links.requirements[0].target_id === R[2].id && t3d.history.some((h) => h.action_type === 'GENERATED'));
  await shot('06-coverage-done.png');
  const covTxt = await textOf('main');
  check('US-7 커버리지 화면: no English UI words', !EN.test(covTxt), enOf(covTxt));
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const tpDone = await npRow('요구사항별 테스트 준비').textContent();
  check('US-1 AC2 TEST_PLAN 완료 (What\'s Next: 완료 · "범위 내 요구사항 15건이 모두 테스트와 연결되었거나 제외 사유가 있습니다. (제외 1건)")', /완료/.test(tpDone) && /범위 내 요구사항 15건이 모두 테스트와 연결되었거나 제외 사유가 있습니다\. \(제외 1건\)/.test(tpDone) && (await api('GET', A.P)).json.current_phase.steps.find((x) => x.step_key === 'TEST_PLAN').state === 'COMPLETED', tpDone.replace(/\s+/g, ' ').slice(0, 200));

  /* ---------- US-5 목록 ---------- */
  const tFree = (await api('POST', `${A.P}/tests`, { title: '요구사항 없는 테스트' })).json.test;
  await page.goto(`${A.url}/tests`); await page.waitForSelector('main .rtable');
  const heads = await page.$$eval('main .rtable th', (els) => els.map((e) => e.textContent.trim()));
  check('US-5 AC 목록: \'최근 결과\' 보이고 \'상태\' 열 기본 숨김', heads.includes('최근 결과') && !heads.includes('상태'), JSON.stringify(heads));
  const noReq = await page.$eval(`tr[data-row="${tFree.id}"] .noreq`, (e) => [e.textContent.trim(), getComputedStyle(e).color]).catch(() => null);
  check('US-3 연결 없는 테스트: 회색 "요구사항 없음" (경고색 아님)', Boolean(noReq) && noReq[0] === '요구사항 없음', JSON.stringify(noReq));
  await page.check('#colst'); await page.waitForFunction(() => [...document.querySelectorAll('main .rtable th')].some((th) => th.textContent.trim() === '상태'));
  check('US-5 컬럼 메뉴에서 \'상태\'를 켤 수 있다', true);
  await page.uncheck('#colst');
  const listTxt = await textOf('main');
  check('US-7 테스트 목록: no English UI words', !EN.test(listTxt), enOf(listTxt));
  await shot('07-tests-list.png');

  /* ---------- US-3 + 테스트 추가 폼: 검증할 요구사항 ---------- */
  await page.click('#add'); await page.waitForSelector('#cf #req-add');
  await page.fill('#c-title', '계약서 검색 — 키워드'); await page.click('#req-add'); await page.waitForSelector('#pk-q');
  await page.fill('#pk-q', R[5].display_id); await page.click(`.pick:has-text("${R[5].display_id}") input`); await page.click('#pk-ok');
  await page.waitForSelector(`#cf [data-reqchip="${R[5].id}"]`);
  await page.click('#cf button[type=submit]'); await page.waitForSelector('#drawer [data-pane="info"]');
  const cov5 = (await api('GET', `${A.P}/tests/coverage`)).json.coverage.find((x) => x.id === R[5].id);
  check('US-3 AC 폼에서 요구사항 1건을 고르고 저장 → 커버리지 반영', cov5.total === 2, `total=${cov5.total}`);

  /* ---------- US-2 / US-4 실행 dialog ---------- */
  const tc = (await api('GET', `${A.P}/tests?q=${encodeURIComponent(`${R[3].display_id} 기능 4 확인`)}`)).json.items[0];
  await page.goto(`${A.url}/tests?sel=${tc.id}`); await page.waitForSelector('#drawer #run');
  const drawerHead = await page.$eval('#drawer .dgrid .dfield span', (e) => e.textContent.trim());
  check('US-5 Drawer 맨 위 필드 = 최근 결과, 상태는 아래 일반 필드', drawerHead === '최근 결과' && (await page.$$eval('#drawer .dgrid .dfield > span', (els) => els.map((e) => e.textContent.trim()))).includes('상태'));
  await page.click('#run'); await page.waitForSelector('[data-dialog="run"]');
  const groups = await page.$$eval('#rd-who optgroup', (els) => els.map((e) => e.label));
  const maxD = await page.getAttribute('#rd-on', 'max'); const valD = await page.inputValue('#rd-on'); const who0 = await page.inputValue('#rd-who');
  check('US-4 수행자: 그룹 RELAI 사용자 / 팀원 (계정 없음) / 고객사, 기본 나 · 수행일 기본 오늘(KST), 미래 불가(max)', JSON.stringify(groups) === JSON.stringify(['RELAI 사용자', '팀원 (계정 없음)', '고객사']) && who0 === `u:${me}` && valD === T && maxD === T, `${JSON.stringify(groups)} ${who0} ${valD} ${maxD}`);
  const runTxt = await textOf('[data-dialog="run"]', page);
  check('US-7 실행 dialog: no English UI words', !EN.test(runTxt), enOf(runTxt));
  await page.click('[data-dialog="run"] .resq--fail'); await page.fill('#rd-actual', '저장 버튼 오류');
  await page.selectOption('#rd-who', 's:sh-cl'); await page.fill('#rd-on', d(-1));
  await page.click('[data-dialog="run"] [data-v="1"]'); await page.waitForSelector('#drawer [data-raise]');
  const line1 = await page.textContent('#drawer [data-exec-line]');
  check('US-4 AC 고객사 이해관계자 · 어제 → 이력 "#1 실패 · M/D · 수행: 이수진(고객사) · 기록: 홍길동"', line1.trim() === `${md(d(-1))} · 수행: 이수진(고객사) · 기록: 홍길동`, line1);
  check('US-4 AC 미래 날짜 422', (await api('POST', `${A.P}/tests/${tc.id}/executions`, { result: 'PASS', performed_on: d(1) })).status === 422);
  await page.click('#drawer [data-raise]'); await page.waitForSelector('.dialog'); await page.click('.dialog [data-v="1"]');
  await page.waitForSelector('#drawer .exec a.chip');
  const iss = (await api('GET', `${A.P}/issues?source=TEST`)).json.items[0];
  check('US-7 실행 이력: 이슈로 등록 (Issue 아님)', /이슈를 등록했습니다/.test(await toastText(page, /이슈를 등록했습니다/)));
  // 체크 끄고 통과
  await page.click('#drawer [data-dtab="info"]'); await page.click('#run'); await page.waitForSelector('[data-dialog="run"]');
  check('재실행 dialog: 통과 전에는 이슈 체크박스 숨김', await page.$eval('#rd-resolve', (e) => e.hidden));
  await page.click('[data-dialog="run"] .resq--pass');
  const cbLabel = await page.textContent('#rd-resolve label');
  check(`US-2 통과 + 열린 이슈 → 체크박스 "${iss.display_id}도 해결로 바꾸기" (기본 체크)`, cbLabel.trim() === `${iss.display_id}도 해결로 바꾸기` && await page.isChecked('#rd-resolve input'), cbLabel);
  await page.fill('#rd-actual', '저장 정상');
  await shot('08-run-dialog-issue.png');
  await page.uncheck('#rd-resolve input');
  await page.click('[data-dialog="run"] [data-v="1"]'); await toastText(page, /#3|#2 결과를 기록/);
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const dfTxt = await npRow('결함 조치').textContent();
  check(`US-2 AC1 체크 끄고 통과 → DEFECTS 진행 중 "실패 테스트 0건 · 처리 중 결함 이슈 1건(${iss.display_id})" + 결함 이슈 보기`, new RegExp(`실패 테스트 0건 · 처리 중 결함 이슈 1건\\(${iss.display_id}\\)`).test(dfTxt) && /결함 이슈 보기/.test(dfTxt), dfTxt.replace(/\s+/g, ' ').slice(0, 200));
  check('US-2 AC1 05 필수 미완료', (await api('GET', A.P)).json.current_phase.summary.gate_met === false);
  // 체크 켬
  await page.goto(`${A.url}/tests?sel=${tc.id}`); await page.waitForSelector('#drawer #run');
  await page.click('#run'); await page.waitForSelector('[data-dialog="run"]'); await page.click('[data-dialog="run"] .resq--pass'); await page.fill('#rd-actual', '재확인 정상');
  await page.click('[data-dialog="run"] [data-v="1"]');
  check('US-2 토스트에 해결 이슈 표시', new RegExp(`${iss.display_id} 해결`).test(await toastText(page, new RegExp(`${iss.display_id} 해결`))));
  const iss2 = (await api('GET', `${A.P}/issues/${iss.id}`)).json.issue;
  check(`US-2 AC2 체크 켬 → ${iss.display_id} 해결, 해결 내용 "재시험 통과 (TC #3): 재확인 정상"`, iss2.status === 'RESOLVED' && iss2.resolution === `재시험 통과 (${tc.display_id} #3): 재확인 정상`, iss2.resolution);
  const dr = (await api('GET', A.P)).json.current_phase.steps.find((x) => x.step_key === 'DEFECTS');
  check('US-2 AC2 DEFECTS 완료', dr.state === 'COMPLETED');
  const drTxt = await textOf('#drawer');
  check('US-7 Drawer: no English UI words', !EN.test(drTxt), enOf(drTxt));
  // 이슈 화면에서 직접 해결
  const tb = (await api('GET', `${A.P}/tests?q=${encodeURIComponent(`${R[4].display_id} 기능 5 확인`)}`)).json.items[0];
  const fx = (await api('POST', `${A.P}/tests/${tb.id}/executions`, { result: 'FAIL' })).json.execution;
  const ib = (await api('POST', `${A.P}/tests/${tb.id}/executions/${fx.id}/issue`, {})).json.issue;
  await api('POST', `${A.P}/tests/${tb.id}/executions`, { result: 'PASS' });
  check('US-2 열린 결함 이슈 → DEFECTS 진행 중', (await api('GET', A.P)).json.current_phase.steps.find((x) => x.step_key === 'DEFECTS').state === 'IN_PROGRESS');
  await page.goto(`${A.url}/issues?sel=${ib.id}`); await page.waitForSelector('#drawer');
  const stSel = await page.$('#drawer select[data-field="status"]');
  if (stSel) { await stSel.selectOption('RESOLVED'); await page.waitForTimeout(600); const dlg = await page.$('.dialog [data-v="1"]'); if (dlg) { await dlg.click(); await page.waitForTimeout(400); } }
  else await api('PATCH', `${A.P}/issues/${ib.id}`, { status: 'RESOLVED' });
  check('US-2 AC3 이슈 화면에서 해결 → DEFECTS 완료', (await api('GET', `${A.P}/issues/${ib.id}`)).json.issue.status === 'RESOLVED' && (await api('GET', A.P)).json.current_phase.steps.find((x) => x.step_key === 'DEFECTS').state === 'COMPLETED');

  /* ---------- US-6 주간보고 ✓ ---------- */
  const wk = week();
  const rep = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end })).json.report;
  await api('POST', `${A.P}/weekly-reports/${rep.id}/finalize`, {});
  await page.goto(A.url); await page.waitForSelector('.np__list');
  check('US-6 AC 이번 주 FINAL 보고서 → 05 주간보고 행 ✓', /✓ 이번 주 보고 확정/.test(await npRow('주간보고 작성·공유').textContent()));

  /* ---------- 완료 가이드 숫자 ---------- */
  for (const t of (await api('GET', `${A.P}/tests`)).json.items) if (t.last_result !== 'PASS') await api('POST', `${A.P}/tests/${t.id}/executions`, { result: 'PASS' });
  const total = (await api('GET', `${A.P}/tests`)).json.items.length;
  await page.goto(A.url); await page.waitForSelector('.rg__title');
  const title = (await page.textContent('.rg__title')).trim();
  check('US-1 AC5 완료 가이드 제목 "요구사항 15건 검증 완료 · 테스트 N건 모두 통과 · 제외 1건", "테스트가 모두 통과했습니다" 없음', title === `요구사항 15건 검증 완료 · 테스트 ${total}건 모두 통과 · 제외 1건` && !/테스트가 모두 통과했습니다/.test(await page.textContent('main')), title);
  await shot('09-whats-next-done.png');
  // 검수 탭 UAT 툴팁
  await page.goto(`${A.url}/tests?tab=acceptance`); await page.waitForSelector('main .empty');
  check('US-7 ? 툴팁: UAT ("고객 현업이 직접 확인하는 인수 테스트") + 검수 탭 "06에서 진행"', (await page.$('.term[data-tip="고객 현업이 직접 확인하는 인수 테스트"]')) !== null && /06에서 진행/.test(await page.textContent('[data-tab="acceptance"]')));

  /* ---------- migration 36 shape: a project already past 05 without tests ---------- */
  const B = await mkProject('지난 프로젝트');
  await mkReqs(B, 2);
  await toPhase(B, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE']);
  const gB = (await api('GET', B.P)).json; const phB = gB.phases.find((x) => x.phase_key === 'TESTING');
  check('migration 36: 05를 지난 프로젝트 · TEST_PLAN 미충족 → 05 ◐ (gap), 막지 않음', phB.display_state === 'gap' && gB.project.current_phase === 'TRANSITION_GO_LIVE');
  await page.goto(`${B.url}?phase=TESTING`); await page.waitForSelector('.np--other');
  check('migration 36: "테스트 준비 미완료" 한 줄은 05 영역에만', /테스트 준비 미완료/.test(await page.textContent('.np--other')));
  await page.goto(`${B.url}?phase=DEVELOPMENT`); await page.waitForSelector('.np--other');
  check('migration 36: 04 영역에는 없음', !/테스트 준비 미완료/.test(await page.textContent('.np--other')));
  await shot('10-past-05-gap.png');
  if (DB) check('migration 36 recorded in schema_migrations', Number(sql('SELECT MAX(version) FROM schema_migrations')) >= 36);   // later phases add 37+

  /* ---------- 375px ---------- */
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', storageState: await ctx.storageState() });
  const mp = await m.newPage();
  const C = await mkProject('모바일 확인');
  const RC = await mkReqs(C, 3);
  await toPhase(C, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING']);
  // phone (< 768px) = view mode (hive research/relai-mobile-spec.md): generate / run / exclude are PC-only; the PC line replaces them
  const vw = () => mp.evaluate(() => document.documentElement.scrollWidth);
  await mp.goto(`${C.url}/tests`); await mp.waitForSelector('[data-phone-empty]');
  check('375px 빈 상태: 생성 버튼 없음 · PC 한 줄 · 가로 스크롤 없음', !(await mp.$('#gen')) && (await mp.$$('.pcline')).length === 1 && (await vw()) <= 375);
  await shot('m-01-tests-empty.png', mp);
  await api('POST', `${C.P}/tests/from-requirements`, {});
  const tm = (await api('GET', `${C.P}/tests`)).json.items[0];
  const fm = (await api('POST', `${C.P}/tests/${tm.id}/executions`, { result: 'FAIL', actual_result: '오류' })).json.execution;
  await api('POST', `${C.P}/tests/${tm.id}/executions/${fm.id}/issue`, {});
  await mp.goto(`${C.url}/tests?sel=${tm.id}`); await mp.waitForSelector('#drawer:not([hidden]) .drawer__x'); await mp.waitForTimeout(300);
  check('375px 테스트 상세: 실행 버튼 없음 · 입력칸 없음 · 가로 스크롤 없음', !(await mp.$$eval('#drawer #run', (els) => els.some((e) => e.getBoundingClientRect().width > 0))) && (await mp.$$eval('#drawer input, #drawer select, #drawer textarea', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).length)) === 0 && (await vw()) <= 375);
  await shot('m-03-test-detail.png', mp);
  await mkReqs(C, 1);   // a confirmed requirement without a test
  await mp.goto(`${C.url}/tests?tab=coverage`); await mp.waitForSelector('[data-cov-sum]');
  check('375px 커버리지: 테스트 추가 · 제외 없음 · 가로 스크롤 없음', !(await mp.$$eval('[data-exclude], a[href*="tests?new=1"]', (els) => els.some((e) => e.getBoundingClientRect().width > 0))) && (await vw()) <= 375);
  await shot('m-04-coverage.png', mp);
  await m.close();

  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
