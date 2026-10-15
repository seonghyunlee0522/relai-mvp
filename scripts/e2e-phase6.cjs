// Phase 6 (06 전환 및 오픈) browser check — every AC of hive research/relai-phase-6-spec.md (v2):
// US-1 검수 승인 = 고객 승인 기록 (공용 승인 Drawer, 422, 목록·Drawer 표시, 이력, 검수받을 내용 카드, 승인 기록 추가),
// US-2 범위 전체 검수 (1/15 진행 중, 범위 전체로 만들기 → 완료, 범위 0건이면 체크박스 숨김), US-3 오픈 dialog (미결정 → 비활성, 운영 이관 메모,
// 미래 날짜 422, 꼬리표, '오픈' 마일스톤 완료·실적일, 07 첫 줄 N건, 미완료 0건 → 오픈일만), US-4 이관 있음 → DATA_MIGRATION 필수 + DATA 요구사항 링크,
// US-5 06 주간보고 행, US-6 체크리스트 담당 선택기 (고객사 · 직접 입력 유지), US-7 06 경고 줄 열린 이슈, US-8 06 화면 영어 없음 + ? 용어 + 검수 Drawer 날짜 10/15,
// migration 37. 375px shots: 검수 승인 시트, 오픈 dialog (이관 메모 포함), 새 검수 폼.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3023 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-phase6.cjs   (playwright on NODE_PATH; server with PLAN_LIMITS=off)
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3023';
const SHOTS = process.env.SHOTS || 'phase6-shots';
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
  { id: 'sh-pm', name: '정하늘', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '오지현', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
];
// English UI words that must not appear on the 06 screens (US-8). ID prefixes (REQ/TC/ACC/ISS/CR, removed with .mono), WBS, Excel are allowed.
const EN = /\b(Go-?Live|Tests?|Acceptance|Coverage|Pass|Fail|Blocked|Status|Owner|Issues?|Defects|Requirements?|Checklist|Cutover|Migration|Training)\b/;
const STEP = (g, key) => g.phases.flatMap((p) => p.steps).find((s) => s.step_key === key);

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
  const primaries = async (pg = page, scope = 'main') => pg.$$eval(`${scope} .btn--primary`, (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));

  const email = `p6-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { name: '정하늘', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mkProject = async (name, dm = 'NO') => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: d(-90), planned_end_date: d(60), data_migration: dm, has_external_integration: 'NO' })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { stakeholders: TEAM });
    return { p, P, url: `${BASE}/app/projects/${p.id}` };
  };
  const toPhase = async (A, keys) => { for (const key of keys) { const ph = (await api('GET', A.P)).json.phases.find((x) => x.phase_key === key); await api('POST', `${A.P}/phases/${ph.id}/activate`, { reason: 'NEXT' }); } };
  const mkReqs = async (A, n, { types = {} } = {}) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const r = (await api('POST', `${A.P}/requirements`, { title: types[i] ? types[i][1] : `기능 ${i + 1}`, type: types[i] ? types[i][0] : 'FUNCTIONAL', priority: 'MEDIUM', scope: 'IN_SCOPE' })).json.requirement;
      await api('PATCH', `${A.P}/requirements/${r.id}`, { status: 'CONFIRMED' });
      out.push(r);
    }
    return out;
  };
  const mkTest = async (A, req, result = 'PASS') => {
    const t = (await api('POST', `${A.P}/tests`, { title: `${req.title} 확인` })).json.test;
    await api('POST', `${A.P}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: req.id });
    if (result) await api('POST', `${A.P}/tests/${t.id}/executions`, { result, actual_result: result === 'FAIL' ? '오류' : '' });
    return t;
  };
  const approval = { approver_id: 'sh-cl', date: d(-2), method: 'SIGNED', evidence: '검수확인서 서명본 수령, 문서번호 ACME-2026-17' };

  /* ===== project A: 이관 있음 · 15 confirmed in-scope (1 DATA) · tests · 열린 이슈 1 · 미반영 CR 1 · '오픈' milestone ===== */
  const A = await mkProject('계약 관리 시스템 구축', 'YES');
  const R = await mkReqs(A, 15, { types: { 3: ['DATA', '기존 계약 데이터 이관'] } });
  const TS = []; for (const r of R.slice(0, 5)) TS.push(await mkTest(A, r));
  await api('PATCH', `${A.P}/requirements/${R[14].id}/test-exclusion`, { reason: '문서로 대체' }).catch(() => {});
  const ms = (await api('POST', `${A.P}/wbs`, { item_type: 'MILESTONE', title: '오픈', milestone_date: d(5), lifecycle_phase: 'TRANSITION_GO_LIVE' })).json;
  await toPhase(A, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE']);
  const iss = (await api('POST', `${A.P}/issues`, { title: '계약 목록 정렬 오류', severity: 'MEDIUM' })).json;
  const issue = iss.issue || iss.item || iss;
  const cr = (await api('POST', `${A.P}/changes`, { title: '알림 메일 문구 변경', requester_name: '오지현' })).json.change;
  await api('POST', `${A.P}/changes/${cr.id}/transition`, { action: 'submit' });
  const crA = await api('POST', `${A.P}/changes/${cr.id}/transition`, { action: 'approve', customer_approval: { ...approval, evidence: '메일 회신' } });
  check('setup: 미반영 CR (APPROVED)', crA.status === 200 && crA.json.change.status === 'APPROVED', String(crA.status));

  /* ---------- US-7 06 What's Next 경고 줄 · US-5 주간보고 행 · US-4 DATA_MIGRATION 필수 ---------- */
  await page.goto(A.url); await page.waitForSelector('.rg');
  const warns = await page.$$eval('.rg__warn', (els) => els.map((e) => e.textContent.trim()));
  check('US-7 06 경고 줄: "열린 이슈 1건 · 승인 후 미반영 변경 1건"', warns.some((x) => /열린 이슈 1건 · 승인 후 미반영 변경 1건/.test(x)), JSON.stringify(warns));
  const wrRow = page.locator('.np__row:has-text("주간보고 작성·공유")');
  check('US-5 06 What\'s Next에 주간보고 행 (권장)', (await wrRow.count()) === 1 && /권장/.test(await wrRow.textContent()));
  const dmRow = page.locator('.np__row:has-text("데이터 마이그레이션")');
  const dmTxt = await dmRow.textContent();
  check('US-4 이관 있음 → 데이터 마이그레이션 필수 + DATA 요구사항 링크', /필수/.test(dmTxt) && /기존 계약 데이터 이관/.test(dmTxt) && (await dmRow.locator('[data-row-links] a').count()) === 1, dmTxt.replace(/\s+/g, ' ').slice(0, 160));
  let g = (await api('GET', A.P)).json;
  check('US-4 DATA_MIGRATION REQUIRED in the gate (필수 미완료)', STEP(g, 'DATA_MIGRATION').importance === 'REQUIRED' && g.current_phase.summary.required_open >= 3);
  check('US-4 건너뛰기 불가 (필수) → 409', (await api('PATCH', `${A.P}/steps/${STEP(g, 'DATA_MIGRATION').id}`, { status: 'SKIPPED' })).status === 409);
  await shot('d-01-06-whatsnext.png');
  const enNext = enOf(await textOf('main'));
  check('US-8 06 What\'s Next: 영어 UI 단어 없음', !enNext, enNext);
  const lnb = await page.textContent('body');
  check('US-8 LNB 하위 메뉴 "오픈" (Go-Live 없음)', !/Go-Live/.test(lnb));

  /* ---------- US-1 검수 승인 = 고객 승인 기록 ---------- */
  const acc1 = (await api('POST', `${A.P}/acceptances`, { title: '1차 검수 — 계약 등록', requirements: [R[0].id] })).json.acceptance;
  await api('POST', `${A.P}/acceptances/${acc1.id}/links`, { target_type: 'TEST', target_id: TS[0].id });
  await api('POST', `${A.P}/acceptances/${acc1.id}/transition`, { action: 'submit' });
  const no = await api('POST', `${A.P}/acceptances/${acc1.id}/transition`, { action: 'accept' });
  check('US-1 API accept without the 4 fields → 422 customer_approval_required', no.status === 422 && no.json.error.code === 'customer_approval_required', String(no.status));
  await page.goto(`${A.url}/tests?tab=acceptance&sel=${acc1.id}`); await page.waitForSelector('#drawer [data-act="accept"]');
  const reqDate = await page.textContent('#drawer .dgrid');
  check('US-8 검수 Drawer 날짜 "10/15" 형식 (요청일)', reqDate.includes(md(T)) && !/\d{4}\.\d{2}\.\d{2}/.test(reqDate), reqDate.replace(/\s+/g, ' ').slice(0, 80));
  await page.click('#drawer [data-act="accept"]'); await page.waitForSelector('[data-approval-drawer]');
  const card = await page.textContent('[data-acc-card]');
  check('US-1 검수받을 내용 카드: 요구사항 · 테스트 통과 · 제외 · 열린 이슈', /요구사항\s*1건/.test(card) && /테스트 통과\s*1건/.test(card) && /테스트 제외 \(05 사유\)\s*0건/.test(card) && /열린 이슈\s*1건/.test(card), card.replace(/\s+/g, ' '));
  check('US-1 열린 이슈 숫자 = warn 색 (빨강 아님)', await page.$eval('[data-acc-open]', (e) => e.classList.contains('is-warn')));
  check('US-1 Drawer = 공용 승인 폼 (승인자 고객사 먼저 · 필수 4개 중 N개)', /필수 4개 중 0개/.test(await page.textContent('#apv-stat')) && /^고객사 · 오지현/.test((await page.$$eval('[data-af="approver_id"] option', (o) => o.map((x) => x.textContent)))[1]));
  await page.click('#apv-save');
  const errs = await page.$$eval('.apv__err', (els) => els.length);
  const stillReq = (await api('GET', `${A.P}/acceptances/${acc1.id}`)).json.acceptance.status;
  check('US-1 4필드 미입력 → 저장 안 됨 (필드 오류 4개)', errs === 4 && stillReq === 'REQUESTED', `errs=${errs} ${stillReq}`);
  await page.selectOption('[data-af="approver_id"]', 'sh-cl');
  await page.fill('[data-af="date"]', approval.date);
  await page.check('[data-af="method"][value="SIGNED"]');
  await page.fill('[data-af="evidence"]', approval.evidence);
  await shot('d-02-acceptance-approval-drawer.png');
  await page.click('#apv-save'); await toastText(page, /고객 승인을 기록/);
  await page.waitForSelector('[data-accapv]');
  const apvLine = await page.textContent('[data-accapv]');
  check('US-1 저장 → ACCEPTED, Drawer "✓ 승인 · 날짜 · 오지현 고객 PM · 서명본 수령 (기록: 정하늘)"', /✓ 승인/.test(apvLine) && apvLine.includes(md(approval.date)) && /오지현 고객 PM/.test(apvLine) && /서명본 수령/.test(apvLine) && /기록: 정하늘/.test(apvLine), apvLine.replace(/\s+/g, ' '));
  const listLine = await page.textContent(`[data-row="${acc1.id}"]`);
  check('US-1 목록에 고객 승인자·날짜·방법', /오지현/.test(listLine) && /서명본 수령/.test(listLine) && listLine.includes(md(approval.date)));
  await shot('d-03-acceptance-approved.png');
  const a1 = (await api('GET', `${A.P}/acceptances/${acc1.id}`)).json.acceptance;
  check('US-1 이력 "고객 승인 기록"', a1.status === 'ACCEPTED' && a1.history.some((h) => h.action_type === 'CUSTOMER_APPROVAL'));
  await page.click('#drawer [data-dtab="hist"]').catch(() => {});
  check('US-1 이력 화면 문구', /고객 승인 기록/.test(await page.textContent('#drawer')));

  // legacy ACCEPTED (no record) → grey line + 승인 기록 추가 (status unchanged)
  const old = (await api('POST', `${A.P}/acceptances`, { title: '예전 검수' })).json.acceptance;
  sql(`UPDATE acceptances SET status = 'ACCEPTED', accepted_at = now(), customer_approval = '{}' WHERE id = '${old.id}'`);
  await page.goto(`${A.url}/tests?tab=acceptance&sel=${old.id}`); await page.waitForSelector('[data-accapv-none]');
  check('US-1 기존 ACCEPTED 검수: "고객 승인 기록이 없습니다" + 승인 기록 추가', /고객 승인 기록이 없습니다/.test(await page.textContent('[data-accapv-none]')));
  await page.click('[data-acc-apv-add]'); await page.waitForSelector('[data-approval-drawer]');
  await page.selectOption('[data-af="approver_id"]', '__direct');
  await page.fill('[data-af="approver_name"]', '최현업'); await page.fill('[data-af="approver_title"]', '과장');
  await page.fill('[data-af="date"]', d(-10)); await page.check('[data-af="method"][value="EMAIL"]'); await page.fill('[data-af="evidence"]', '회신 메일');
  await page.click('#apv-save'); await toastText(page, /승인 기록을 추가/);
  const oldNow = (await api('GET', `${A.P}/acceptances/${old.id}`)).json.acceptance;
  check('US-1 승인 기록 추가: 상태 그대로 ACCEPTED + 기록 · 이해관계자 추가', oldNow.status === 'ACCEPTED' && oldNow.customer_approval.recorded && oldNow.stakeholders.some((x) => x.name === '최현업'));
  // Q15-4: a recorded approval shows 승인 기록 수정 (never a silent overwrite via 추가); 이력 keeps the old record line
  await page.waitForSelector('[data-accapv] [data-acc-apv-edit]');
  check('Q15-4 기록 있음 → "승인 기록 수정" (추가 버튼 없음)', /승인 기록 수정/.test(await page.textContent('[data-accapv]')) && !(await page.$('[data-acc-apv-add]')));
  await page.click('[data-acc-apv-edit]'); await page.waitForSelector('[data-approval-drawer]');
  check('Q15-4 수정 Drawer는 기존 기록으로 채워짐', (await page.inputValue('[data-af="evidence"]')) === '회신 메일');
  await page.fill('[data-af="evidence"]', '회신 메일 (재확인)'); await page.check('[data-af="method"][value="SIGNED"]');
  await page.click('#apv-save'); await toastText(page, /승인 기록을 수정/);
  const oldEd = (await api('GET', `${A.P}/acceptances/${old.id}`)).json.acceptance;
  const edRow = oldEd.history.find((h) => h.action_type === 'CUSTOMER_APPROVAL' && h.old_value);
  check('Q15-4 수정 저장 → 서명본 수령, 이력에 이전 기록 줄 유지', oldEd.customer_approval.method === 'SIGNED' && edRow && /이메일 회신/.test(edRow.old_value), edRow && edRow.old_value);
  await page.click('#drawer [data-dtab="hist"]').catch(() => {});
  check('Q15-4 이력 화면 "고객 승인 기록 수정"', /고객 승인 기록 수정/.test(await page.textContent('#drawer')));
  await api('POST', `${A.P}/acceptances/${old.id}/archive`, {});

  /* ---------- US-2 검수는 범위 전체를 덮는다 ---------- */
  g = (await api('GET', A.P)).json;
  const accStep = STEP(g, 'ACCEPTANCE');
  check('US-2 요구사항 1건만 승인 → ACCEPTANCE 진행 중 (1/15)', accStep.state === 'IN_PROGRESS' && /범위 내 요구사항 15건 중 1건이 승인된 검수에 들어 있습니다/.test(accStep.text), accStep.text);
  check('US-2 가이드 CTA "검수 범위 보기"', g.guidance.rule === 'ACC_SCOPE' && g.guidance.primary_action.label === '검수 범위 보기', g.guidance.rule);
  await page.goto(`${A.url}/tests?tab=acceptance&new=1`); await page.waitForSelector('[data-scope-all-box]');
  const lab = await page.textContent('[data-scope-all-box]');
  check('US-2 새 검수 폼: 범위 전체로 만들기 (요구사항 14건 · 테스트 4건) 기본 ON + 힌트', /범위 전체로 만들기 \(요구사항 14건 · 테스트 4건\)/.test(lab) && (await page.isChecked('[data-scope-all]')) && /1차·2차로 나누려면 체크를 끄고 대상을 직접 고르세요/.test(lab), lab.replace(/\s+/g, ' '));
  await page.fill('#c-title', '2차 검수 — 나머지 전체');
  await shot('d-04-new-acceptance-form.png');
  await page.click('#cf button[type=submit]'); await toastText(page, /만들었습니다/);
  const acc2 = (await api('GET', `${A.P}/acceptances`)).json.items.find((x) => x.title.startsWith('2차'));
  check('US-2 나머지 14건 + 연결 테스트 4건 연결', Number(acc2.requirement_count) === 14 && Number(acc2.test_count) === 4, `${acc2.requirement_count}/${acc2.test_count}`);
  await api('POST', `${A.P}/acceptances/${acc2.id}/transition`, { action: 'submit' });
  // US-3 later needs an unfinished 검수: a 3rd one stays REQUESTED? no — keep it simple: accept 2차 now
  await api('POST', `${A.P}/acceptances/${acc2.id}/transition`, { action: 'accept', customer_approval: approval });
  g = (await api('GET', A.P)).json;
  check('US-2 2차 승인 후 ACCEPTANCE 완료 (합계 판정)', STEP(g, 'ACCEPTANCE').state === 'COMPLETED', STEP(g, 'ACCEPTANCE').text);

  /* ---------- US-6 체크리스트 담당 = 담당자 선택기 ---------- */
  const cut = STEP(g, 'CUTOVER_PLAN');
  const free = (await api('POST', `${A.P}/steps/${cut.id}/checklist`, { title: '전환 리허설', owner: '운영팀 김대리' })).json.item;
  await page.goto(`${A.url}/checklist?activity=CUTOVER_PLAN`); await page.waitForSelector('.clk__add');
  await page.fill('.clk__add [name=title]', '전환 일정 고객 확인');
  const groups = await page.$$eval('[data-add-own] optgroup', (o) => o.map((x) => x.label));
  check('US-6 담당 선택기 3그룹 + 직접 입력', JSON.stringify(groups) === JSON.stringify(['RELAI 사용자', '팀원 (계정 없음)', '고객사']) && (await page.$$eval('[data-add-own] option', (o) => o.some((x) => x.value === '__text'))), JSON.stringify(groups));
  await page.selectOption('[data-add-own]', 's:sh-cl');
  await page.click('.clk__add button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.clk__row').length >= 2);
  const items = (await api('GET', `${A.P}/checklists`)).json.items;
  const cl = items.find((x) => x.title === '전환 일정 고객 확인'); const fr = items.find((x) => x.id === free.id);
  check('US-6 고객사 이해관계자 담당 → "오지현 · 고객사"', cl.owner_stakeholder_id === 'sh-cl' && cl.owner_display === '오지현' && cl.owner_org === '고객사');
  const rowSel = await page.$eval(`[data-own="${cl.id}"]`, (s) => s.options[s.selectedIndex].textContent);
  check('US-6 목록 표시 "오지현 · 고객사"', rowSel === '오지현 · 고객사', rowSel);
  const frIn = await page.$eval(`[data-item="${free.id}"] [data-f="owner"]`, (e) => e.value).catch(() => '');
  check('US-6 기존 자유 텍스트 담당은 그대로 (직접 입력)', fr.owner_kind === 'text' && frIn === '운영팀 김대리', frIn);
  await shot('d-05-checklist-owner.png');

  /* ---------- US-5 이번 주 FINAL → ✓ ---------- */
  const wk = week();
  const rep = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end })).json.report;
  await api('POST', `${A.P}/weekly-reports/${rep.id}/finalize`, {});
  g = (await api('GET', A.P)).json;
  check('US-5 이번 주 FINAL → 06 주간보고 ✓', STEP(g, 'WEEKLY_REPORT').state === 'COMPLETED' && /이번 주 보고 확정/.test(STEP(g, 'WEEKLY_REPORT').text));

  /* ---------- US-3 오픈 dialog ---------- */
  check('US-3 PATCH 완료 처리 → 409 (오픈은 dialog로만)', (await api('PATCH', `${A.P}/steps/${STEP(g, 'GO_LIVE').id}`, { status: 'COMPLETED' })).status === 409);
  const fut = await api('POST', `${A.P}/go-live`, { date: d(1), carryovers: [] });
  check('US-3 미래 오픈일 → 422', fut.status === 422 && fut.json.error.code === 'invalid_go_live_date');
  const und = await api('POST', `${A.P}/go-live`, { date: T, carryovers: [{ type: 'ISSUE', id: issue.id, note: '운영팀 1차 대응' }] });
  check('US-3 미결정 항목 → 422 undecided_items', und.status === 422 && und.json.error.code === 'undecided_items' && /CR-001/.test(JSON.stringify(und.json.error)), JSON.stringify(und.json.error).slice(0, 120));
  await page.goto(A.url); await page.waitForSelector('.np__row');
  await page.click('.np__row:has-text("오픈") [data-golive]'); await page.waitForSelector('[data-golive-dialog]');
  const rows = await page.$$eval('[data-golive-dialog] .gl__row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')));
  check('US-3 dialog "서비스를 오픈합니다" + 2줄 (ISS · CR)', /서비스를 오픈합니다/.test(await page.textContent('[data-golive-dialog] h3')) && rows.length === 2 && rows.some((r) => /ISS-001/.test(r)) && rows.some((r) => /CR-001/.test(r)), JSON.stringify(rows));
  const dPrim = await primaries(page, '[data-golive-dialog]');
  check('US-3 primary 1개 · 미결정이면 오픈 완료 비활성', dPrim.length === 1 && dPrim[0] === '오픈 완료' && (await page.isDisabled('[data-gl-ok]')));
  check('US-3 체크리스트 미완료 = 경고 한 줄', /06 체크리스트에 완료되지 않은 항목 \d+건/.test(await page.textContent('[data-golive-dialog]')));
  check('US-8 ? 운영 이관 용어', await page.$eval('[data-golive-dialog] .term', (e) => /오픈 뒤 운영 단계에서 처리하기로 넘긴 문제/.test(e.dataset.tip)).catch(() => false));
  await page.click(`[data-carry-on="ISSUE:${issue.id}"]`);
  await page.fill(`[data-note="ISSUE:${issue.id}"]`, '운영팀 1차 대응, 11월 패치에 포함');
  check('US-3 하나만 결정 → "2건 중 1건 결정", 여전히 비활성', /2건 중 1건 결정/.test(await page.textContent('[data-gl-stat]')) && (await page.isDisabled('[data-gl-ok]')));
  await page.click(`[data-carry-on="CR:${cr.id}"]`);
  await page.fill(`[data-note="CR:${cr.id}"]`, '11월 정기 배포에 반영');
  await page.fill('#gl-date', d(-1)); await page.dispatchEvent('#gl-date', 'input');
  check('US-3 모두 운영 이관 + 메모 → 오픈 완료 켜짐', !(await page.isDisabled('[data-gl-ok]')));
  const redGl = await page.$$eval('[data-golive-dialog] *', (els) => els.filter((e) => /rgb\(2[0-4]\d, (3\d|4\d|5\d|6\d), (3\d|4\d|5\d|6\d)\)/.test(getComputedStyle(e).color) && e.textContent.trim()).length);
  check('US-3 dialog 빨강 없음', redGl === 0, String(redGl));
  const enGl = enOf(await textOf('[data-golive-dialog]'));
  check('US-8 오픈 dialog 영어 없음', !enGl, enGl);
  await shot('d-06-golive-dialog.png');
  await page.click('[data-gl-ok]'); await toastText(page, /오픈을 기록/);
  g = (await api('GET', A.P)).json;
  check('US-3 저장 → GO_LIVE 완료 + 오픈 기록 2건', STEP(g, 'GO_LIVE').state === 'COMPLETED' && g.go_live && g.go_live.date === d(-1) && g.go_live.carryovers.length === 2);
  const msNow = (await api('GET', `${A.P}/wbs`)).json.items.find((x) => x.title === '오픈');
  check('US-3 WBS "오픈" 마일스톤 완료 · 실적일 = 오픈일', msNow && msNow.status === 'COMPLETED' && String(msNow.actual_end_date).slice(0, 10) === d(-1), msNow ? `${msNow.status} ${msNow.actual_end_date}` : 'none');
  check('US-3 오픈 후 06 가이드에 "운영 이관으로 기록" 경고 없음', g.guidance.rule !== 'GO_LIVE_OPEN' && !g.guidance.warnings.some((x) => /열린 이슈/.test(x)), `${g.guidance.rule} ${JSON.stringify(g.guidance.warnings)}`);
  await page.goto(`${A.url}/issues`); await page.waitForSelector(`[data-carry="ISSUE:${issue.id}"]`);
  check('US-3 ISS-001 목록 회색 꼬리표 "운영 이관"', /운영 이관/.test(await page.textContent(`[data-carry="ISSUE:${issue.id}"]`)));
  await page.goto(`${A.url}/issues?sel=${issue.id}`); await page.waitForSelector('#drawer [data-carryline]');
  check('US-3 ISS-001 Drawer "운영 이관 · 메모"', /운영 이관 · 운영팀 1차 대응, 11월 패치에 포함/.test(await page.textContent('#drawer [data-carryline]')));
  await shot('d-07-issue-carry-tag.png');
  await page.goto(`${A.url}/changes`); await page.waitForSelector(`[data-carry="CR:${cr.id}"]`);
  check('US-3 CR-001 목록 꼬리표', /운영 이관/.test(await page.textContent(`[data-carry="CR:${cr.id}"]`)));
  await page.goto(`${A.url}/changes?sel=${cr.id}`); await page.waitForSelector('#drawer [data-carryline]');
  check('US-3 CR-001 Drawer 꼬리표', /11월 정기 배포에 반영/.test(await page.textContent('#drawer [data-carryline]')));
  check('US-3 꼬리표 = 회색 텍스트 (배지·경고색 아님)', await page.$eval('#drawer [data-carryline] .carry', (e) => getComputedStyle(e).color === 'rgb(102, 112, 133)'));
  // → 07: first line N건 + list
  await toPhase(A, ['OPERATIONS']);
  await page.goto(A.url); await page.waitForSelector('.rg');
  const w7 = await page.$$eval('.rg__warn', (els) => els.map((e) => e.textContent.trim()));
  check('US-3 07 What\'s Next 첫 줄 = 운영 이관 2건 (Phase 7 US-4: "운영 이관 2건 · 담당 지정 0/2")', /운영 이관 2건 · 담당 지정 0\/2/.test(w7[0] || ''), JSON.stringify(w7));
  check('US-3 07: 넘긴 이슈는 "운영 이관 전 열린 이슈" 가이드로 다시 나오지 않음', (await api('GET', A.P)).json.guidance.rule !== 'OPS_ISSUES');
  await page.click('.rg__warn a'); await page.waitForSelector('[data-handover-dialog]');   // Phase 7 US-3: the line opens the 운영 인수 dialog (items + 메모 + 운영 담당)
  check('US-3 07 목록 링크 → 2건 (ID · 메모)', (await page.$$eval('[data-handover-dialog] .gl__row', (e) => e.length)) === 2 && /11월 정기 배포에 반영/.test(await page.textContent('[data-handover-dialog]')));
  await shot('d-08-07-carryovers.png');
  await page.click('[data-ho-cancel]');

  /* ===== project B: 이관 없음 · 범위 내 0건 · 미완료 0 ===== */
  const B = await mkProject('사내 포털 개편', 'NO');
  await toPhase(B, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE']);
  let gb = (await api('GET', B.P)).json;
  check('US-4 이관 없음 → 데이터 마이그레이션 선택', STEP(gb, 'DATA_MIGRATION').importance === 'OPTIONAL');
  sql(`UPDATE projects SET data_migration = 'TBD' WHERE id = '${B.p.id}'`);
  gb = (await api('GET', B.P)).json;
  check('US-4 미정 → 권장 (특성을 바꾸면 바로 반영)', STEP(gb, 'DATA_MIGRATION').importance === 'RECOMMENDED');
  await page.goto(`${B.url}/tests?tab=acceptance&new=1`); await page.waitForSelector('#cf');
  check('US-2 범위 내 확정 요구사항 0건 → 체크박스 숨김', (await page.$('[data-scope-all-box]')) === null);
  await page.goto(B.url); await page.waitForSelector('.np__row');
  await page.click('.np__row:has-text("오픈") [data-golive]'); await page.waitForSelector('[data-golive-dialog]');
  check('US-3 미완료 0건 → 목록 없이 오픈일만, 바로 켜짐', (await page.$$('[data-golive-dialog] .gl__row')).length === 0 && !(await page.isDisabled('[data-gl-ok]')));
  await shot('d-09-golive-nothing-open.png');
  await page.click('[data-gl-cancel]');
  await page.goto(`${B.url}/tests?tab=acceptance`); await page.waitForSelector('main [data-tab="acceptance"].is-on'); await page.waitForSelector('main .term[data-tip*="검수확인서"]').catch(() => {});
  const enAcc = enOf(await textOf('main'));
  check('US-8 검수 탭 영어 없음', !enAcc, enAcc);
  check('US-8 ? 검수 용어', await page.$eval('main .term[data-tip*="검수확인서"]', (e) => Boolean(e.offsetParent)).catch(() => false));
  await page.goto(`${B.url}/checklist?activity=GO_LIVE`); await page.waitForSelector('.clk__card');
  const enCl = enOf(await textOf('main'));
  check('US-8 오픈 체크리스트 영어 없음 + 탭 "오픈"', !enCl && (await page.$$eval('.clk__tab', (t) => t.map((x) => x.textContent))).some((x) => /오픈$/.test(x.trim())), enCl);
  await page.click('[data-mark="COMPLETED"]'); await page.waitForSelector('[data-golive-dialog]');
  check('US-3 체크리스트 화면의 완료 처리도 오픈 dialog', true);
  await page.click('[data-gl-ok]'); await toastText(page, /오픈을 기록/);
  gb = (await api('GET', B.P)).json;
  check('US-3 미완료 0건 오픈 → 완료, 운영 이관 0건', STEP(gb, 'GO_LIVE').state === 'COMPLETED' && gb.go_live.carryovers.length === 0);

  /* ---------- regression: 01 · 02 · 04 approvals still work ---------- */
  const C = await mkProject('회귀 확인');
  const ap1 = await api('PUT', `${C.P}/definition`, { approval: { ...approval } });
  check('regression 01 착수 승인 기록 저장', ap1.status === 200, String(ap1.status));
  const [rc] = await mkReqs(C, 1);
  const cr2 = (await api('POST', `${C.P}/changes`, { title: '회귀 CR', requirements: [{ requirement_id: rc.id, relation_type: 'MODIFIES' }] })).json.change;
  await api('POST', `${C.P}/changes/${cr2.id}/transition`, { action: 'submit' });
  check('regression 04 CR 승인 422 / 저장', (await api('POST', `${C.P}/changes/${cr2.id}/transition`, { action: 'approve' })).status === 422
    && (await api('POST', `${C.P}/changes/${cr2.id}/transition`, { action: 'approve', customer_approval: approval })).json.change.status === 'APPROVED');

  if (DB) check('migration 37 recorded in schema_migrations', Number(sql('SELECT MAX(version) FROM schema_migrations')) >= 37);   // later phases add 38+

  /* ---------- 375px ---------- */
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', storageState: await ctx.storageState() });
  const mp = await m.newPage();
  const M = await mkProject('모바일 확인');
  const RM = await mkReqs(M, 3);
  await mkTest(M, RM[0]);
  await toPhase(M, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE']);
  await api('POST', `${M.P}/issues`, { title: '모바일 로그인 지연', severity: 'LOW' });
  // phone (< 768px) = view mode (hive research/relai-mobile-spec.md): new 검수 form, 승인 sheet and 오픈 dialog are PC-only
  const vw = () => mp.evaluate(() => document.documentElement.scrollWidth);
  const visN = (sel) => mp.$$eval(sel, (els) => els.filter((e) => e.getBoundingClientRect().width > 0).length);
  await mp.goto(`${M.url}/tests?tab=acceptance&new=1`); await mp.waitForSelector('.pcline'); await mp.waitForTimeout(300);
  check('375px ?new=1: 새 검수 폼 없음 · PC 한 줄 · 가로 스크롤 없음', (await visN('#cf')) === 0 && (await visN('.pcline')) === 1 && (await vw()) <= 375);
  await shot('m-01-acceptance-list.png', mp);
  const am = (await api('POST', `${M.P}/acceptances`, { title: '통합 검수' })).json;
  const amId = (am.acceptance || am.item || am).id;
  await mp.goto(`${M.url}/tests?tab=acceptance&sel=${amId}`); await mp.waitForSelector('#drawer:not([hidden]) .drawer__x'); await mp.waitForTimeout(300);
  check('375px 검수 상세: 읽기 전용 (승인·요청 버튼, 입력칸 없음) · 가로 스크롤 없음', (await visN('#drawer [data-act], #drawer button.btn')) === 0 && (await visN('#drawer input, #drawer select, #drawer textarea')) === 0 && (await vw()) <= 375);
  await shot('m-02-acceptance-detail.png', mp);
  await mp.goto(`${M.url}?golive=1`); await mp.waitForSelector('.np__row'); await mp.waitForTimeout(500);
  check('375px What\'s Next 06: 오픈 dialog·완료 처리 없음 · 가로 스크롤 없음', (await visN('[data-golive-dialog], [data-golive]')) === 0 && (await vw()) <= 375);
  await shot('m-03-whatsnext-06.png', mp);
  await m.close();

  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
