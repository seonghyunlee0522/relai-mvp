// Phase 4 (04 구현) browser check — every AC of hive research/relai-phase-4-spec.md (v2):
// US-1 일정 미루기 = 사유 dialog (표 셀 · Drawer · 일괄) + 422 + 최초 계획일 line (never red) + history + 주간보고 '일정' lines,
// US-2 CR 승인 = 고객 승인 Drawer (01·02 form, 422, 이해관계자 추가, 목록·Drawer 상태 줄, 승인 기록 추가, guide CTA),
// US-3 WEEKLY_REPORT row (만들기 → 이번 주 월~일 dialog, 초안, 확정 ✓), US-4 반영 완료 dialog (links / warn),
// US-5 차단됨 → 해결 + 해결 내용 hint + Issue 0건 text, US-6 Issue 담당자 팀원 (계정 없음), US-7 no English on 04 screens + ? terms,
// US-8 주간보고 목록 375px · 테스트 빈 화면 primary 1개, C1 Korea-time week. 375px shots of the new dialogs/sheet.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3017 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-phase4.cjs   (playwright on NODE_PATH; server with PLAN_LIMITS=off)
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3017';
const SHOTS = process.env.SHOTS || 'phase4-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => execFileSync('psql', ['-q', '-t', '-A', DB, '-c', q]).toString().trim();

// Korea-time dates (C1) — same rule as public/app/shared/kst-date.js
const todayKst = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const addDays = (ymd, n) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const T = todayKst(); const d = (n) => addDays(T, n);
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const week = () => { const dow = new Date(`${T}T00:00:00Z`).getUTCDay(); const s = addDays(T, dow === 0 ? -6 : 1 - dow); return { start: s, end: addDays(s, 6) }; };
const WK = week();

const TEAM = [
  { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '이고객', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
];
// English UI words that must not appear on the 04 screens (US-7). ID prefixes (ISS/CR/REQ-), WBS, Excel, Jira, AI, MD, Issue (a Korean-text term) are allowed.
// Q13-1: RELAI's own Issue entity reads 이슈 everywhere; only the Jira term "Jira Issue" may stay English.
const EN_ISSUE = /(?<!Jira )\bIssues?\b/;
const EN = /\b(Schedule|Scope|Coverage|Severity|Resolution|Owner|Blocked|Critical|Updated|Status|Due|Requirements?|Issues|Tests?|Risks?|Overdue|Review|Probability|Impact|Pass|Fail|Lifecycle|Changes)\b/;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = (n, pg = page) => pg.screenshot({ path: `${SHOTS}/${n}` });
  const toastText = async () => { await page.waitForSelector('.toast', { timeout: 5000 }).catch(() => {}); return page.textContent('.toast').catch(() => ''); };
  const isRed = (rgb) => { const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb || ''); return m ? Number(m[1]) > 170 && Number(m[2]) < 80 && Number(m[3]) < 80 : false; };
  const mainText = async () => (await page.evaluate(() => { const m = document.querySelector('main'); const c = m.cloneNode(true); c.querySelectorAll('.mono,code,script,style,[hidden],.sr-only').forEach((x) => x.remove()); return c.innerText; }));

  const email = `p4-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mkProject = async (name) => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: d(-30), planned_end_date: d(120), data_migration: 'NO', has_external_integration: 'NO' })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { stakeholders: TEAM });
    return { p, P, url: `${BASE}/app/projects/${p.id}` };
  };
  const toPhase = async (A, keys) => { for (const key of keys) { const ph = (await api('GET', A.P)).json.phases.find((x) => x.phase_key === key); await api('POST', `${A.P}/phases/${ph.id}/activate`, { reason: 'NEXT' }); } };
  const A = await mkProject('계약 관리 시스템 구축');
  const r1 = (await api('POST', `${A.P}/requirements`, { title: '로그인', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED' })).json.requirement;
  await toPhase(A, ['REQUIREMENTS', 'ANALYSIS_DESIGN']);
  const mk = async (body) => (await api('POST', `${A.P}/wbs`, body)).json.item;
  const t1 = await mk({ title: '로그인 화면 개발', planned_start_date: d(-3), planned_end_date: d(5) });
  const t2 = await mk({ title: '관리자 화면 개발', planned_start_date: d(3), planned_end_date: d(10) });
  const t3 = await mk({ title: '배치 개발', planned_start_date: d(-6), planned_end_date: d(6) });
  await api('PATCH', `${A.P}/wbs/${t1.id}`, { planned_end_date: d(7) });   // 03 planning change: no dialog, becomes the original at 04 entry
  await toPhase(A, ['DEVELOPMENT']);
  await api('PATCH', `${A.P}/wbs/${t1.id}`, { status: 'IN_PROGRESS', progress: 30 });
  await api('PATCH', `${A.P}/wbs/${t3.id}`, { status: 'IN_PROGRESS', progress: 10 });
  check('US-1 04 entry froze the original end date (03 change counted as planning)', (await api('GET', `${A.P}/wbs/${t1.id}`)).json.item.original_planned_end_date === d(7));

  /* ---------- US-5 / US-3 What's Next (before any issue / report) ---------- */
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const issuesRow = page.locator('.np__row:has-text("이슈 관리")');
  check('US-5 ISSUES 0건 text + manual 완료 처리', /아직 기록된 이슈가 없습니다\. 문제가 없었다면 완료 처리하세요\./.test(await page.textContent('main')) && (await issuesRow.locator('[data-status="COMPLETED"]').count()) === 1);
  const wrRow = page.locator('.np__row:has-text("주간보고 작성·공유")');
  check('US-3 WEEKLY_REPORT row: 권장 · 미시작 · "이번 주 주간보고를 만드세요"', (await wrRow.count()) === 1 && /권장/.test(await wrRow.textContent()) && /이번 주 주간보고를 만드세요/.test(await wrRow.textContent()) && /미시작/.test(await wrRow.textContent()));
  const wrBtn = wrRow.locator('[data-row-cta]');
  check('US-3 row button 주간보고 만들기 is secondary (Guide keeps the only primary)', (await wrBtn.textContent()).trim() === '주간보고 만들기' && /btn--secondary/.test(await wrBtn.getAttribute('class')) && (await page.$$eval('main .btn--primary', (els) => els.filter((e) => e.offsetParent).length)) <= 1);
  const rows04 = await page.$$eval('.np__row .np__st', (els) => els.map((e) => e.textContent.trim()));
  check('US-3 WEEKLY_REPORT right after CHANGES', rows04.findIndex((t) => /주간보고 작성·공유/.test(t)) === rows04.findIndex((t) => /변경 요청 관리/.test(t)) + 1, JSON.stringify(rows04));
  await shot('01-whats-next-04.png');
  await wrBtn.click(); await page.waitForSelector('#pd-s');
  check('US-3 주간보고 만들기 → create dialog with this week Mon–Sun (Korea time)', (await page.inputValue('#pd-s')) === WK.start && (await page.inputValue('#pd-e')) === WK.end, `${await page.inputValue('#pd-s')} ~ ${await page.inputValue('#pd-e')} vs ${WK.start} ~ ${WK.end}`);
  await shot('02-weekly-create-dialog.png');
  await page.click('.dialog [data-v="1"]'); await page.waitForURL(/\/reports\/[0-9a-f-]+$/);
  const draftId = page.url().split('/').pop();
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const wrRow2 = page.locator('.np__row:has-text("주간보고 작성·공유")');
  check('US-3 DRAFT → 진행 중 "초안 작성 중" + 이어서 작성', /초안 작성 중/.test(await wrRow2.textContent()) && (await wrRow2.locator('[data-row-cta]').textContent()).trim() === '이어서 작성' && /진행 중/.test(await wrRow2.textContent()));
  await api('POST', `${A.P}/weekly-reports/${draftId}/finalize`, {});
  await page.reload(); await page.waitForSelector('.np__list');
  const fin = await page.locator('.np__row:has-text("주간보고 작성·공유")').textContent();
  check('US-3 FINAL this week → ✓ 이번 주 보고 확정 · m/d', /✓ 이번 주 보고 확정 · \d+\/\d+/.test(fin) && /완료/.test(fin), fin.replace(/\s+/g, ' '));
  // next week = computed again: a report whose period ended last week does not count
  await api('POST', `${A.P}/weekly-reports/${draftId}/reopen`, {});
  sql(`UPDATE weekly_reports SET period_start = '${addDays(WK.start, -7)}', period_end = '${addDays(WK.start, -1)}', status = 'FINAL', finalized_at = now() WHERE id = '${draftId}'`);
  await page.reload(); await page.waitForSelector('.np__list');
  check('US-3 last week\'s FINAL report → this week open again (미시작)', /이번 주 주간보고를 만드세요/.test(await page.locator('.np__row:has-text("주간보고 작성·공유")').textContent()));

  /* ---------- US-1 표 셀 편집 ---------- */
  await page.goto(`${A.url}/wbs?ctx=monitor`); await page.waitForSelector(`tr[data-id="${t1.id}"]`);
  const setCell = async (id, field, v) => page.$eval(`tr[data-id="${id}"] [data-edit="${field}"]`, (el, val) => { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  await setCell(t1.id, 'planned_end_date', d(14));
  await page.waitForSelector('[data-delay-dialog]');
  const dlg = await page.textContent('[data-delay-dialog]');
  check('US-1 cell edit (진행 중, later) → "작업 일정을 미루려 합니다" with 계획 m/d → m/d (+7일)', /작업 일정을 미루려 합니다/.test(dlg) && dlg.includes(`계획 ${md(d(7))} → ${md(d(14))} (+7일)`) && /미루는 이유와 대응을 한 줄 남기면 주간보고에 함께 나갑니다/.test(dlg), dlg.replace(/\s+/g, ' ').slice(0, 160));
  check('US-1 [일정 변경 저장] disabled until a reason is typed', await page.isDisabled('[data-delay-dialog] [data-v="1"]'));
  await shot('03-delay-dialog.png');
  await page.click('[data-delay-dialog] [data-v="0"]'); await page.waitForTimeout(400);
  check('US-1 취소 → nothing saved', (await api('GET', `${A.P}/wbs/${t1.id}`)).json.item.planned_end_date === d(7));
  const r422 = await api('PATCH', `${A.P}/wbs/${t1.id}`, { planned_end_date: d(14) });
  check('US-1 API without delay_reason → 422 delay_reason_required', r422.status === 422 && r422.json.error.code === 'delay_reason_required');
  await setCell(t1.id, 'planned_end_date', d(14));
  await page.waitForSelector('[data-delay-dialog]');
  await page.fill('#dly-in', '고객 계정 발급 지연 → 버퍼 3일 사용');
  await page.click('[data-delay-dialog] [data-v="1"]');
  await page.waitForFunction((id) => { const el = document.querySelector(`tr[data-id="${id}"] [data-shift]`); return el && /\+7일/.test(el.textContent); }, t1.id, { timeout: 8000 }).catch(() => {});
  const shiftEl = page.locator(`tr[data-id="${t1.id}"] [data-shift]`);
  const shiftTxt = (await shiftEl.count()) ? (await shiftEl.textContent()).trim() : '';
  check('US-1 saved → row shows "계획 m/d → m/d (+7일)"', shiftTxt === `계획 ${md(d(7))} → ${md(d(14))} (+7일)`, shiftTxt);
  check('US-1 design: the shift line is not red', !isRed(await shiftEl.evaluate((e) => getComputedStyle(e).color)));
  await shot('04-wbs-shift-line.png');
  // 미시작 + 미래 → no dialog; pulling earlier → no dialog
  await setCell(t2.id, 'planned_end_date', d(15)); await page.waitForTimeout(700);
  check('US-1 미시작·미래 task pushed later → no dialog, saved', !(await page.$('[data-delay-dialog]')) && (await api('GET', `${A.P}/wbs/${t2.id}`)).json.item.planned_end_date === d(15));
  await setCell(t1.id, 'planned_end_date', d(12)); await page.waitForTimeout(700);
  check('US-1 pulling a date earlier → no dialog, saved', !(await page.$('[data-delay-dialog]')) && (await api('GET', `${A.P}/wbs/${t1.id}`)).json.item.planned_end_date === d(12));
  // second push → original stays, +total
  await api('PATCH', `${A.P}/wbs/${t1.id}`, { planned_end_date: d(17), delay_reason: '외부 API 일정 변경' });
  const it1 = (await api('GET', `${A.P}/wbs/${t1.id}`)).json.item;
  check('US-1 pushed twice → 최초 종료일 stays the first value, "+총 일수"', it1.original_planned_end_date === d(7) && it1.planned_end_date === d(17));

  /* ---------- US-1 Drawer + 이력 ---------- */
  await page.goto(`${A.url}/wbs?ctx=monitor&sel=${t1.id}`); await page.waitForSelector('[data-shift-note]');
  const note = await page.textContent('[data-shift-note]');
  check('US-1 Drawer: shift line + 최근 사유 + 최초 계획일 (?) term', note.includes(`계획 ${md(d(7))} → ${md(d(17))} (+10일)`) && /최근 사유: 외부 API 일정 변경/.test(note) && (await page.$('[data-shift-note] .term[aria-label^="최초 계획일:"]')) !== null, note.replace(/\s+/g, ' '));
  await page.click('[data-dtab="hist"], [data-tab-key="hist"], .dtabs [data-k="hist"]').catch(() => {});
  const histTxt = await page.evaluate(() => (document.querySelector('[data-pane="hist"]') || {}).textContent || '');
  check('US-1 이력 shows the reason', /사유: 고객 계정 발급 지연 → 버퍼 3일 사용/.test(histTxt) && /사유: 외부 API 일정 변경/.test(histTxt));
  // Drawer save path: t3 (진행 중) push via the drawer date input
  await page.goto(`${A.url}/wbs?ctx=monitor&sel=${t3.id}`); await page.waitForSelector('#drawer [data-field="planned_end_date"]');
  await page.$eval('#drawer [data-field="planned_end_date"]', (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, d(9));
  await page.waitForSelector('[data-delay-dialog]');
  check('US-1 Drawer save → the same dialog', /작업 일정을 미루려 합니다/.test(await page.textContent('[data-delay-dialog]')));
  await page.fill('#dly-in', '배치 서버 반입 지연'); await page.click('[data-delay-dialog] [data-v="1"]');
  await page.waitForSelector('[data-shift-note]', { timeout: 8000 }).catch(() => {});
  check('US-1 Drawer push saved with reason', (await api('GET', `${A.P}/wbs/${t3.id}`)).json.item.delay_note?.note === '배치 서버 반입 지연');

  /* ---------- US-1 일괄 편집 ---------- */
  await page.goto(`${A.url}/wbs?ctx=monitor`); await page.waitForSelector(`tr[data-id="${t1.id}"]`);
  await page.check(`tr[data-id="${t1.id}"] [data-pick]`); await page.check(`tr[data-id="${t3.id}"] [data-pick]`);
  await page.waitForSelector('.bulk [data-bf]');
  await page.selectOption('.bulk [data-bf]', 'shift_days'); await page.fill('.bulk [data-bv]', '2');
  await page.click('.bulk [data-bapply]');
  await page.waitForSelector('[data-delay-dialog]', { timeout: 8000 }).catch(() => {});
  const bd = (await page.$('[data-delay-dialog]')) ? await page.textContent('[data-delay-dialog]') : '';
  check('US-1 bulk 일정 이동 → the same dialog ("선택한 작업 중 2건")', /작업 일정을 미루려 합니다/.test(bd) && /2건/.test(bd), bd.replace(/\s+/g, ' ').slice(0, 120));
  if (bd) { await page.fill('#dly-in', '일괄 조정'); await page.click('[data-delay-dialog] [data-v="1"]'); }
  await page.waitForTimeout(1200);
  check('US-1 bulk saved after the reason', (await api('GET', `${A.P}/wbs/${t1.id}`)).json.item.planned_end_date === d(19) && (await api('GET', `${A.P}/wbs/${t3.id}`)).json.item.delay_note?.note === '일괄 조정');

  /* ---------- US-1 주간보고 '일정' ---------- */
  const rep = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: WK.start, period_end: WK.end })).json.report;
  await page.goto(`${A.url}/reports/${rep.id}`); await page.waitForSelector('.doc__sec');
  const repTxt = await page.inputValue('[data-sec="status"]');
  check('US-1 주간보고 \'일정\': "이번 주 일정 변경 N건 (최초 계획 대비 총 +M일)" + 작업명 · +일 · 사유 lines', /- 일정: 이번 주 일정 변경 5건 \(최초 계획 대비 총 \+17일\)/.test(repTxt) && /로그인 화면 개발 · \+7일 · 최초 계획 대비 \+12일 · 고객 계정 발급 지연 → 버퍼 3일 사용/.test(repTxt), repTxt.split('\n').filter((l) => /일정/.test(l)).join(' | '));

  /* ---------- US-6 Issue 담당자 + US-5 차단됨 → 해결 ---------- */
  await page.goto(`${A.url}/issues?new=1`); await page.waitForSelector('#cf');
  const groups = await page.$$eval('#cf select[name="owner"] optgroup', (els) => els.map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent.trim())]));
  check('US-6 create form: Phase 3 picker (RELAI 사용자 / 팀원 (계정 없음) = 당사·협력사)', JSON.stringify(groups) === JSON.stringify([['RELAI 사용자', ['홍길동']], ['팀원 (계정 없음)', ['김피엠 · PM', '박협력 · 개발']]]), JSON.stringify(groups));
  await page.fill('#c-title', 'API 응답 지연'); await page.selectOption('#cf select[name="severity"]', 'CRITICAL'); await page.selectOption('#cf select[name="owner"]', 's:sh-dev');
  await page.click('#cf button[type=submit]'); await page.waitForSelector('tr[data-row]');
  const issRow = await page.textContent('tr[data-row]');
  check('US-6 list shows 박협력 + 계정 없음', /박협력/.test(issRow) && /계정 없음/.test(issRow), issRow.replace(/\s+/g, ' '));
  const iss = (await api('GET', `${A.P}/issues`)).json.items[0];
  check('US-6 stored as owner_stakeholder_id only', iss.owner_stakeholder_id === 'sh-dev' && iss.owner_user_id === null);
  const both = await api('POST', `${A.P}/issues`, { title: 'x', owner_user_id: s.json.user.id, owner_stakeholder_id: 'sh-dev' });
  check('US-6 user ↔ stakeholder exclusive (API 400)', both.status === 400);
  await api('PATCH', `${A.P}/issues/${iss.id}`, { status: 'BLOCKED' });
  await page.goto(`${A.url}/issues?sel=${iss.id}`); await page.waitForSelector('#drawer [data-field="status"]');
  check('US-5 차단됨 → 해결 is offered directly', await page.$eval('#drawer [data-field="status"] option[value="RESOLVED"]', (o) => !o.disabled));
  await shot('05-issue-drawer.png');
  await page.selectOption('#drawer [data-field="status"]', 'RESOLVED');
  await page.waitForSelector('#pd-in');
  check('US-5 해결 dialog hint "어떻게 해결했는지 한 줄 남겨 두면 주간보고에 나옵니다."', /어떻게 해결했는지 한 줄 남겨 두면 주간보고에 나옵니다\./.test(await page.textContent('.dialog')));
  await page.click('.dialog [data-v="1"]'); await page.waitForSelector('[data-res-hint]', { timeout: 8000 }).catch(() => {});
  check('US-5 empty 해결 내용 → saved RESOLVED + hint under the field', (await api('GET', `${A.P}/issues/${iss.id}`)).json.issue.status === 'RESOLVED' && Boolean(await page.$('[data-res-hint]')));
  const issueTxt = await mainText();
  check('US-7 Issue screen: no English UI words', !EN.test(issueTxt), (issueTxt.match(EN) || [])[0] || '');
  check('Q13-1 이슈 screen (help card + list + Drawer): no English "Issue"', !EN_ISSUE.test(issueTxt), (issueTxt.match(EN_ISSUE) || [])[0] || '');
  const rep2 = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: WK.start, period_end: WK.end })).json.report;
  await api('POST', `${A.P}/issues`, { title: '배포 권한 미발급', severity: 'HIGH', owner: 's:sh-pm' });
  const rep3 = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: WK.start, period_end: WK.end })).json.report;
  check('US-6 주간보고: Issue 담당자 이름 + (계정 없음)', /배포 권한 미발급 — 높음 · 열림 · 김피엠 \(계정 없음\)/.test(rep3.rendered_content));
  void rep2;

  /* ---------- US-2 CR 승인 = 고객 승인 기록 ---------- */
  const cr = (await api('POST', `${A.P}/changes`, { title: 'MFA 인증 추가', requester_name: '이고객', requirements: [{ requirement_id: r1.id, relation_type: 'MODIFIES' }] })).json.change;
  await api('PATCH', `${A.P}/changes/${cr.id}`, { schedule_impact_days: 5, effort_impact_md: 3, cost_impact: 1500000 });
  await api('POST', `${A.P}/changes/${cr.id}/impacts`, { wbs_item_id: t1.id, impact_type: 'SCHEDULE' });
  await api('POST', `${A.P}/changes/${cr.id}/transition`, { action: 'submit' });
  const apiNo = await api('POST', `${A.P}/changes/${cr.id}/transition`, { action: 'approve' });
  check('US-2 API approve without the 4 fields → 422 customer_approval_required', apiNo.status === 422 && apiNo.json.error.code === 'customer_approval_required');
  // guide CTA → straight into the Drawer
  await page.goto(A.url); await page.waitForSelector('.np__list');
  const chRow = page.locator('.np__row:has-text("변경 요청 관리")');
  check('US-2 CHANGES row: "고객 결정을 받아 기록하세요"', /고객 결정을 받아 기록하세요/.test(await chRow.textContent()));
  check('US-2 guide CTA 승인 기록하기', /승인 기록하기/.test(await page.textContent('.rg')));
  await chRow.click(); await page.waitForSelector('[data-approval-drawer]');
  check('US-2 승인 기록하기 → the approval Drawer of the 검토 중 CR', /MFA 인증 추가/.test(await page.textContent('[data-approval-drawer]')));
  const what = await page.textContent('.apv__what');
  check('US-2 "승인받을 내용": CR · 영향 일정/공수/비용 · 연결 요구사항 1건 · 연결 작업 1건', /MFA 인증 추가/.test(what) && /\+5일/.test(what) && /3 MD/.test(what) && /1,500,000/.test(what) && /연결 요구사항\s*1건/.test(what) && /연결 작업\s*1건/.test(what), what.replace(/\s+/g, ' '));
  const cls = await page.getAttribute('#drawer', 'class');
  check('US-2 same Drawer as 01·02 (drawer--side · 필수 4개 중 0개 입력 · 승인 기록 저장 primary)', /drawer--side/.test(cls) && /필수 4개 중 0개 입력/.test(await page.textContent('#apv-stat')) && (await page.textContent('#apv-save')).trim() === '승인 기록 저장' && /btn--primary/.test(await page.getAttribute('#apv-save', 'class')));
  await page.click('#apv-save'); await page.waitForTimeout(300);
  check('US-2 저장 without fields → 4 inline errors, nothing saved', (await page.$$('.apv__err')).length === 4 && (await api('GET', `${A.P}/changes/${cr.id}`)).json.change.status === 'UNDER_REVIEW');
  await shot('06-cr-approval-drawer.png');
  const groupsA = await page.$$eval('[data-af="approver_id"] option', (els) => els.map((o) => o.textContent.trim()));
  check('US-2 approver picker: 고객사 first', /^고객사 · 이고객/.test(groupsA[1] || ''), JSON.stringify(groupsA));
  await page.selectOption('[data-af="approver_id"]', '__direct'); await page.waitForSelector('[data-af="approver_name"]');
  await page.fill('[data-af="approver_name"]', '이수진'); await page.fill('[data-af="approver_title"]', '차장');
  await page.fill('[data-af="date"]', T); await page.check('[data-af="method"][value="EMAIL"]'); await page.fill('[data-af="evidence"]', `${T} 이수진 차장 회신 메일 'CR-001 승인'`);
  check('US-2 footer counts 필수 4개 중 4개 입력', /필수 4개 중 4개 입력/.test(await page.textContent('#apv-stat')));
  await page.click('#apv-save'); await page.waitForSelector('[data-crapv]', { timeout: 8000 }).catch(() => {});
  const crNow = (await api('GET', `${A.P}/changes/${cr.id}`)).json.change;
  check('US-2 saved → APPROVED with the customer record', crNow.status === 'APPROVED' && crNow.customer_approval.recorded);
  const line = await page.textContent('.decision [data-crapv]').catch(() => '');
  check('US-2 Drawer: "고객 승인: 이수진 차장 · m/d · 이메일 회신 (기록: 홍길동)"', line.includes(`고객 승인: 이수진 차장 · ${md(T)} · 이메일 회신`) && /\(기록: 홍길동\)/.test(line), line.replace(/\s+/g, ' '));
  await page.goto(`${A.url}/changes?sel=${cr.id}`); await page.waitForSelector(`tr[data-row="${cr.id}"]`);
  const listLine = await page.textContent(`tr[data-row="${cr.id}"] [data-crapv]`).catch(() => '');
  check('US-2 list: ✓ 승인 + "m/d · 이수진 차장 · 이메일 회신"', listLine.trim() === `${md(T)} · 이수진 차장 · 이메일 회신` && /승인/.test(await page.textContent(`tr[data-row="${cr.id}"]`)), listLine);
  check('US-2 history "고객 승인 기록"', crNow.history.some((h) => h.action_type === 'CUSTOMER_APPROVAL'));
  const defn = (await api('GET', `${A.P}/definition`)).json; const shs = (defn.definition || defn).stakeholders;
  check('US-2 direct approver added to 01 이해관계자 (고객사)', shs.some((x) => x.name === '이수진' && x.org_type === 'CLIENT'));
  await shot('07-cr-approved.png');

  /* ---------- US-2 기존 APPROVED CR: 승인 기록 추가 ---------- */
  const old = (await api('POST', `${A.P}/changes`, { title: '보고서 양식 변경' })).json.change;
  sql(`UPDATE change_requests SET status = 'APPROVED', approved_at = now(), customer_approval = '{}' WHERE id = '${old.id}'`);
  await page.goto(`${A.url}/changes?sel=${old.id}`); await page.waitForSelector('[data-crapv-none]');
  const noneLine = await page.$eval('[data-crapv-none]', (e) => ({ t: e.textContent, c: getComputedStyle(e.querySelector('.dim')).color }));
  check('US-2 legacy APPROVED CR: grey "고객 승인 기록이 없습니다" + 승인 기록 추가 (no warn colour)', /고객 승인 기록이 없습니다/.test(noneLine.t) && /승인 기록 추가/.test(noneLine.t) && !isRed(noneLine.c));
  await page.click('[data-apv-add]'); await page.waitForSelector('[data-approval-drawer]');
  await page.selectOption('[data-af="approver_id"]', 'sh-cl'); await page.waitForTimeout(200);
  await page.fill('[data-af="date"]', T); await page.check('[data-af="method"][value="REVIEW"]'); await page.fill('[data-af="evidence"]', '주간 검토 회의록');
  await page.click('#apv-save'); await page.waitForSelector('.decision [data-crapv]', { timeout: 8000 }).catch(() => {});
  const oldNow = (await api('GET', `${A.P}/changes/${old.id}`)).json.change;
  check('US-2 승인 기록 추가 saves the record; status stays APPROVED', oldNow.status === 'APPROVED' && oldNow.customer_approval.recorded && /이고객/.test(oldNow.customer_approval.summary));

  /* ---------- US-4 반영 완료 ---------- */
  await page.goto(`${A.url}/changes?sel=${cr.id}`); await page.waitForSelector('[data-tr="implement"]');
  await page.click('[data-tr="implement"]'); await page.waitForSelector('.dialog');
  const implLinks = await page.$$eval('.dialog [data-impl-link]', (els) => els.map((e) => e.textContent.trim()));
  check('US-4 연결 2건 → "변경 내용을 모두 반영했나요?" with 2 linked rows', /변경 내용을 모두 반영했나요\?/.test(await page.textContent('.dialog')) && implLinks.length === 2, JSON.stringify(implLinks));
  await shot('08-implement-dialog.png');
  await page.click('.dialog [data-v="0"]');
  await page.goto(`${A.url}/changes?sel=${old.id}`); await page.waitForSelector('[data-tr="implement"]');
  await page.click('[data-tr="implement"]'); await page.waitForSelector('.dialog');
  const warn = await page.$eval('.dialog [data-impl-warn]', (e) => ({ t: e.textContent, c: getComputedStyle(e).color })).catch(() => ({ t: '', c: '' }));
  check('US-4 연결 0건 → one warn line (warn colour, no box)', /연결된 요구사항·작업이 없습니다\. 고친 곳을 연결해 두면 나중에 추적할 수 있습니다\./.test(warn.t) && !isRed(warn.c));
  await page.click('.dialog [data-v="1"]'); await page.waitForTimeout(800);
  check('US-4 연결 0건 → 반영 완료 still possible', (await api('GET', `${A.P}/changes/${old.id}`)).json.change.status === 'IMPLEMENTED');

  /* ---------- US-7 04 screens: Korean only + (?) terms ---------- */
  const cr3x = (await api('POST', `${A.P}/changes`, { title: '요청자 자동완성 확인' })).json.change;
  await page.goto(`${A.url}/changes`); await page.waitForSelector('tr[data-row]');
  const crTxt = await mainText();
  check('US-7 CR screen: no English UI words', !EN.test(crTxt), (crTxt.match(EN) || [])[0] || '');
  check('US-7 (?) 변경 요청 term on the CR screen', (await page.$('main .term[aria-label^="변경 요청: 확정한 범위·일정·비용을 바꾸자는 요청. 고객 승인 후 반영합니다"]')) !== null);
  await page.goto(`${A.url}/changes?sel=${cr3x.id}`); await page.waitForSelector('#cr-people', { state: 'attached' });
  const reqAuto = await page.$$eval('#cr-people option', (els) => els.map((o) => o.value));
  check('US-6 CR 요청자: 이해관계자 이름 자동완성 (datalist)', ['김피엠', '박협력', '이고객', '이수진'].every((n) => reqAuto.includes(n)), JSON.stringify(reqAuto));
  await page.goto(`${A.url}/wbs?ctx=monitor`); await page.waitForSelector(`tr[data-id="${t1.id}"]`);
  const wbsTxt = await mainText();
  check('US-7 WBS monitor: no English UI words', !EN.test(wbsTxt), (wbsTxt.match(EN) || [])[0] || '');
  await page.goto(`${A.url}/reports/${rep3.id}`); await page.waitForSelector('.doc__sec');
  const docTxt = (await page.$$eval('[data-sec]', (els) => els.map((e) => e.value).join('\n')));
  check('US-7 주간보고 본문: 일정·범위·요구사항 반영률·심각도… (no Schedule/Scope/Coverage/Critical)', !EN.test(docTxt) && /일정:/.test(docTxt) && /범위:/.test(docTxt) && /요구사항 반영률/.test(docTxt), (docTxt.match(EN) || [])[0] || '');

  /* ---------- US-8 Q9-2 테스트 빈 화면 ---------- */
  await page.goto(`${A.url}/tests`); await page.waitForSelector('main .empty, main .estate, main [class*="empty"]');
  const prim0 = await page.$$eval('main .btn--primary', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
  // Phase 5 US-1 replaced the label: with untested confirmed requirements the one primary is 요구사항별 테스트 만들기 (else 테스트 추가)
  check('US-8 Q9-2 테스트 0건 → one primary (요구사항별 테스트 만들기 / 테스트 추가), no toolbar', prim0.length === 1 && /요구사항별 테스트 만들기|테스트 추가/.test(prim0[0]) && !(await page.$('main .rtool')), JSON.stringify(prim0));
  await shot('09-tests-empty.png');
  await api('POST', `${A.P}/tests`, { title: '로그인 성공' });
  await page.reload(); await page.waitForSelector('main .rtool');
  check('US-8 Q9-2 테스트 1건 → toolbar back (+ 테스트 추가)', /테스트 추가/.test(await page.textContent('main .rtool')));

  /* ---------- Q13-1 / Q13-2: 보고서 + 개요 ---------- */
  await page.goto(`${A.url}/reports`); await page.waitForSelector('#rp-new');
  check('Q13-1 보고서 screen: no English "Issue"', !EN_ISSUE.test(await mainText()), ((await mainText()).match(EN_ISSUE) || [])[0] || '');
  await page.click('#rp-new'); await page.waitForSelector('#pd-s');
  check('Q13-2 보고서 → 주간보고 생성: default this week Mon–Sun (Korea time)', (await page.inputValue('#pd-s')) === WK.start && (await page.inputValue('#pd-e')) === WK.end && /이번 주 월요일부터 일요일까지/.test(await page.textContent('.dialog')), `${await page.inputValue('#pd-s')} ~ ${await page.inputValue('#pd-e')} vs ${WK.start} ~ ${WK.end}`);
  await page.click('.dialog [data-v="0"]');
  check('Q13-2 API default_period = this week Mon–Sun', JSON.stringify((await api('GET', `${A.P}/weekly-reports`)).json.default_period) === JSON.stringify({ period_start: WK.start, period_end: WK.end }));
  await page.goto(`${A.url}/overview`); await page.waitForSelector('text=미해결', { timeout: 8000 }).catch(() => {});
  const ovTxt = await mainText();
  check('Q13-1 개요 screen: no English "Issue" (미해결 이슈)', !EN_ISSUE.test(ovTxt) && /미해결 이슈/.test(ovTxt), (ovTxt.match(EN_ISSUE) || [])[0] || '');

  /* ---------- 375px ---------- */
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', storageState: await ctx.storageState() });
  const mp = await m.newPage();
  await mp.goto(`${A.url}/reports`); await mp.waitForSelector('.rpl__t');
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth);
  check('US-8 Q9-1 375px 주간보고 목록 (≥1건): page scrollWidth ≤ 375', sw <= 375, `scrollWidth=${sw}`);
  await shot('m-01-reports-list.png', mp);
  await mp.goto(`${A.url}/wbs?ctx=monitor&sel=${t2.id}`); await mp.waitForSelector('#drawer [data-field="planned_end_date"]');
  await api('PATCH', `${A.P}/wbs/${t2.id}`, { status: 'IN_PROGRESS', progress: 5 });
  await mp.reload(); await mp.waitForSelector('#drawer [data-field="planned_end_date"]');
  await mp.$eval('#drawer [data-field="planned_end_date"]', (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, d(22));
  await mp.waitForSelector('[data-delay-dialog]');
  const btns = await mp.$$eval('[data-delay-dialog] .actions .btn', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), y: r.y, w: Math.round(r.width) }; }));
  check('375px delay dialog: buttons full width, primary on top', btns.length === 2 && btns[0].y < btns[1].y ? btns[0].t === '일정 변경 저장' : btns.find((b) => b.t === '일정 변경 저장').y < btns.find((b) => b.t === '취소').y, JSON.stringify(btns));
  await shot('m-02-delay-dialog.png', mp);
  await mp.click('[data-delay-dialog] [data-v="0"]');
  const cr3 = (await api('POST', `${A.P}/changes`, { title: '알림톡 추가' })).json.change;
  await api('POST', `${A.P}/changes/${cr3.id}/transition`, { action: 'submit' });
  await mp.goto(`${A.url}/changes?sel=${cr3.id}`); await mp.waitForSelector('[data-tr="approve"]');
  await mp.click('[data-tr="approve"]'); await mp.waitForSelector('[data-approval-drawer]');
  const sheet = await mp.$eval('#drawer', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), sw: document.documentElement.scrollWidth }; });
  check('375px CR 승인 sheet: full width, no horizontal scroll', sheet.w <= 375 && sheet.sw <= 375, JSON.stringify(sheet));
  await shot('m-03-cr-approval-sheet.png', mp);
  await mp.goto(`${A.url}/changes?sel=${cr.id}`); await mp.waitForSelector('[data-tr="implement"]');
  await mp.click('[data-tr="implement"]'); await mp.waitForSelector('.dialog');
  await shot('m-04-implement-dialog.png', mp);
  await m.close();

  /* ---------- 01·02 approval regression is e2e-phase1/2; C1 week (Mon 08:00 KST) is unit-tested in server/test/phase4.test.js ---------- */
  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
