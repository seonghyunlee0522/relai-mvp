// Phase 2 (02 요구사항 정의) browser check — 기준선 승인 Drawer (함께 확정 ON/OFF), 02→03 gate on 2 paths + bypass reason,
// 요구사항 정의서 PDF/Word, confirmed-requirement → 변경 요청 prompt (detail · list · bulk · archive · add after approval),
// 02-only hints (no WBS banner / Delivery Trace, Charter 제외 범위, terms, priority hint, INTERFACE 권장, COLLECT hint), Home in 02.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3005 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-phase2.cjs   (playwright on NODE_PATH; psql on PATH)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const JSZip = require(path.join(__dirname, '..', 'node_modules', 'jszip'));
const BASE = process.env.BASE || 'http://127.0.0.1:3005';
const SHOTS = process.env.SHOTS || 'phase2-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}` });
  const dialogShown = (sel) => page.waitForSelector(sel, { timeout: 4000 }).then(() => true).catch(() => false);

  const email = `p2-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  /** A project already through 01 (approved) and in 02, with Charter 제외 범위 and 외부 연계 있음. */
  const mkProject = async (name) => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28', has_external_integration: 'YES' })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { goal: '계약 검토 리드타임 50% 단축', success_criteria: ['검토 리드타임 평균 2영업일 이내'], scope_in: ['국문 표준계약 5종 자동 검토'], scope_out: ['모바일 앱', 'OCR'],
      stakeholders: [{ id: 's1', name: '이수진', org_type: 'CLIENT', org: 'ACME', role: '차장 (고객 PM)' }, { id: 's3', name: '김피엠', org_type: 'OWN', org: '수행사', role: 'PM' }],
      key_dates: [{ title: '착수보고회', date: '2026-09-08' }], operations: { meetings: '주간 정례 월 10시' } });
    for (const k of ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS']) await api('POST', `${P}/definition/sections/${k}/complete`, {});
    await api('POST', `${P}/definition/sections/KICKOFF/skip`, {});
    await api('POST', `${P}/definition/sections/APPROVAL/complete`, { approval: { approver_id: 's1', date: '2026-09-10', method: 'EMAIL', evidence: '메일' } });
    const g = (await api('GET', P)).json; const ph = g.phases.find((x) => x.phase_key === 'REQUIREMENTS');
    await api('POST', `${P}/phases/${ph.id}/activate`, { reason: 'NEXT' });
    return { p, P };
  };
  const { p, P } = await mkProject('법무 AI 검토 시스템');
  const R = `${P}/requirements`;
  const add = async (b) => (await api('POST', R, { type: 'FUNCTIONAL', priority: 'HIGH', ...b })).json.requirement;
  const r1 = await add({ title: 'SSO 로그인', scope: 'IN_SCOPE', status: 'CONFIRMED', criteria: ['사내 계정으로 로그인'] });
  const r2 = await add({ title: '계약서 업로드', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const r3 = await add({ title: '검토 결과 리포트', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const u1 = await add({ title: '알림 메일', scope: 'IN_SCOPE', status: 'DRAFT' });
  const u2 = await add({ title: '대시보드', scope: 'IN_SCOPE', status: 'REVIEWING', type: 'NON_FUNCTIONAL' });
  const u3 = await add({ title: 'ERP 연계', scope: 'IN_SCOPE', status: 'DRAFT', type: 'INTERFACE' });
  await add({ title: '모바일 앱', scope: 'OUT_OF_SCOPE', status: 'DRAFT' });
  await add({ title: 'OCR 스캔', scope: 'UNDECIDED' });
  const reqUrl = `${BASE}/app/projects/${p.id}/requirements`;

  /* ---------- US-4/5: 02 screen hints ---------- */
  await page.goto(reqUrl); await page.waitForSelector('.rtool');
  check('US-4(4) no WBS 이동 banner in 02', !(await page.$('[data-tour-id="req-next"]')));
  // P-1: WBS 연결 안내 · KPI 'WBS 미연결 (범위 내)' · 표의 'WBS 없음' 칩 only from 03
  check('P-1 02: no WBS 연결 안내, KPI or 없음 chip', !/WBS와 연결하는 것이 목표입니다/.test(await page.textContent('main')) && !/WBS 미연결/.test(await page.textContent('#kstrip')) && !(await page.$('.chip--hold')));
  check('US-2 toolbar has 요구사항 정의서 ▾', Boolean(await page.$('[data-reqdoc-menu]')));
  await shot('01-requirements-02.png');
  await page.goto(`${reqUrl}?scope=UNDECIDED`); await page.waitForSelector('.rtool');
  const excl = await page.textContent('[data-scope-excl]').catch(() => '');
  check('US-4(5) ?scope=UNDECIDED shows Charter 제외 범위', /착수 때 제외하기로 한 것: 모바일 앱, OCR\. 여기에 해당하는 요구사항은 '범위 외'로 두세요\./.test(excl), excl);
  await shot('02-scope-undecided-exclusions.png');
  await page.goto(`${reqUrl}?sel=${r1.id}`); await page.waitForSelector('#drawer .dtitle');
  const terms = await page.$$eval('#drawer .term', (els) => els.map((e) => e.getAttribute('aria-label')));
  check('US-5 terms: 완료 조건 · 범위 내/외 · 비기능 on the 02 detail', ['완료 조건', '범위 내 / 범위 외', '비기능 요구사항'].every((t) => terms.some((x) => x.startsWith(t))), JSON.stringify(terms));
  check('US-5 priority hint', /높음 = 없으면 오픈할 수 없는 것/.test(await page.textContent('#drawer')));
  await page.click('[data-dtab="links"]');
  check('US-4(4) no Delivery Trace in 02', !(await page.$('#drawer .trace')));
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.np__list');
  const ifRow = await page.textContent('.np__row:has-text("인터페이스 · 데이터 · 보안")');
  check('US-4(8) INTERFACE shown 권장 + (프로젝트 특성: 외부 연계 있음)', /권장/.test(ifRow) && /\(프로젝트 특성: 외부 연계 있음\)/.test(ifRow), ifRow.replace(/\s+/g, ' ').slice(0, 120));
  check('US-5 COLLECT hint (non-blocking)', /계약서·제안요청서\(RFP\)·인터뷰 등 출처를 빠짐없이 확인했나요\?/.test(await page.textContent('.np__row:has-text("요구사항 수집")')));
  check('US-4(5) 범위 확정 guide shows Charter 제외 범위', /착수 때 제외하기로 한 것: 모바일 앱, OCR/.test(await page.textContent('.rg')));
  await shot('03a-whats-next-scope.png');
  const ocr = (await api('GET', `${R}?scope=UNDECIDED`)).json.requirements[0];
  await api('PATCH', `${R}/${ocr.id}`, { scope: 'OUT_OF_SCOPE' });
  await page.reload(); await page.waitForSelector('.rg');
  const guide = await page.textContent('.rg');
  check('US-4(7) REQ_CONFIRM copy + 승인 기록하기', /요구사항 정의서를 고객에게 보내 검토받으세요\. 승인 회신을 받으면 승인 기록에서 한 번에 확정됩니다\./.test(guide) && /승인 기록하기/.test(guide));
  await shot('03-whats-next-02.png');
  await page.goto(`${BASE}/app`); await page.waitForSelector('main');
  await page.waitForTimeout(800);
  check('US-4(6) Home card in 02: no WBS 미연결 / Blocker', !/WBS 미연결/.test(await page.textContent('main')) && !/Blocker|막힘/.test(await page.textContent('main')));

  /* ---------- US-3: confirmed requirement → 변경 요청 prompt ---------- */
  const reqApi = async (r) => (await api('GET', `${R}/${r.id}`)).json.requirement;
  const crCount = () => Number(sql(`SELECT COUNT(*) FROM change_requests WHERE project_id = '${p.id}'`));
  await page.goto(`${reqUrl}?sel=${r1.id}`); await page.waitForSelector('#drawer .dtitle');
  await page.fill('#drawer .dtitle', 'SSO·OTP 로그인'); await page.press('#drawer .dtitle', 'Enter');
  check('US-3 dialog on confirmed title edit', await dialogShown('[data-dialog="req-change"]'));
  check('US-3 dialog title', (await page.textContent('#cgT')) === '확정된 요구사항을 바꾸려 합니다');
  check('L-D4 one-line diff', /제목: SSO 로그인 → SSO·OTP 로그인/.test(await page.textContent('[data-dialog="req-change"] [data-diff]').catch(() => '')));
  await shot('04-change-prompt.png');
  await page.click('[data-dialog="req-change"] [data-v="cr"]');
  await page.waitForSelector('.toast--act', { timeout: 5000 }).catch(() => {});
  const tmsg = await page.textContent('.toast--act').catch(() => '');
  check('US-3 toast 변경 요청 CR-00N 초안 + 열기 →', /변경 요청 CR-\d+ 초안을 만들었습니다\. 승인되면 요구사항을 수정하세요\./.test(tmsg) && /열기 →/.test(tmsg), tmsg);
  await shot('05-cr-draft-toast.png');
  let d1 = await reqApi(r1);
  const cr1 = sql(`SELECT c.status || '|' || c.title || '|' || c.description FROM change_requests c JOIN change_request_requirements x ON x.change_request_id = c.id WHERE x.requirement_id = '${r1.id}'`);
  check('US-3 변경 요청 만들기: requirement unchanged', d1.title === 'SSO 로그인', d1.title);
  check('US-3 CR = DRAFT, linked, title + 전/후', /^DRAFT\|REQ-001 변경: SSO 로그인\|제안 내용 \(변경 전 → 후\)\n- 제목: SSO 로그인 → SSO·OTP 로그인$/.test(cr1), cr1);
  // 취소 → nothing
  let n0 = crCount();
  await page.goto(`${reqUrl}?sel=${r1.id}`); await page.waitForSelector('#drawer .dtitle');
  await page.fill('#drawer textarea.ddesc', '설명 변경'); await page.click('#drawer .dtitle');
  await dialogShown('[data-dialog="req-change"]'); await page.click('[data-dialog="req-change"] [data-v="cancel"]'); await page.waitForTimeout(500);
  d1 = await reqApi(r1);
  check('US-3 취소 saves nothing', d1.description === '' && crCount() === n0);
  // 단순 수정으로 저장 → saved, stays CONFIRMED
  await page.goto(`${reqUrl}?sel=${r1.id}`); await page.waitForSelector('#drawer .dtitle');
  await page.fill('#drawer .dtitle', 'SSO 로그인 (사내 계정)'); await page.press('#drawer .dtitle', 'Enter');
  await dialogShown('[data-dialog="req-change"]'); await page.click('[data-dialog="req-change"] [data-v="save"]'); await page.waitForTimeout(800);
  d1 = await reqApi(r1);
  check('US-3 단순 수정으로 저장 → saved, status kept', d1.title === 'SSO 로그인 (사내 계정)' && d1.status === 'CONFIRMED', d1.title);
  // other field (Owner/Priority) → no dialog
  await page.goto(`${reqUrl}?sel=${r1.id}`); await page.waitForSelector('#drawer .dtitle');
  await page.selectOption('#drawer [data-field="priority"]', 'MEDIUM'); await page.waitForTimeout(600);
  check('US-3 Priority change: no dialog', !(await page.$('[data-dialog="req-change"]')) && (await reqApi(r1)).priority === 'MEDIUM');
  // 완료 조건 add on a confirmed requirement → dialog
  await page.fill('#crit-in', '2단계 인증'); await page.press('#crit-in', 'Enter');
  check('US-3 완료 조건 change → dialog', await dialogShown('[data-dialog="req-change"]'));
  await page.click('[data-dialog="req-change"] [data-v="cancel"]'); await page.waitForTimeout(300);
  check('US-3 완료 조건 취소 → unchanged', (await reqApi(r1)).criteria.length === 1);
  // unconfirmed requirement → no dialog
  await page.goto(`${reqUrl}?sel=${u1.id}`); await page.waitForSelector('#drawer .dtitle');
  await page.fill('#drawer .dtitle', '알림 메일 (주간)'); await page.press('#drawer .dtitle', 'Enter'); await page.waitForTimeout(700);
  check('US-3 unconfirmed requirement: no dialog', !(await page.$('[data-dialog="req-change"]')) && (await reqApi(u1)).title === '알림 메일 (주간)');
  // approved CR linked → no dialog
  const crr2 = (await api('POST', `${P}/changes`, { title: 'REQ-002 변경', requirements: [{ requirement_id: r2.id }] })).json.change;
  sql(`UPDATE change_requests SET status = 'APPROVED' WHERE id = '${crr2.id}'`);
  await page.goto(`${reqUrl}?sel=${r2.id}`); await page.waitForSelector('#drawer .dtitle');
  await page.fill('#drawer .dtitle', '계약서 업로드 (PDF·DOCX)'); await page.press('#drawer .dtitle', 'Enter'); await page.waitForTimeout(700);
  check('US-3 requirement with an APPROVED CR: no dialog', !(await page.$('[data-dialog="req-change"]')) && (await reqApi(r2)).title === '계약서 업로드 (PDF·DOCX)');
  // list cell: Scope change of a confirmed requirement → dialog
  await page.goto(reqUrl); await page.waitForSelector('.rtool');
  const cell = await page.$(`tr[data-id="${r3.id}"] select[data-edit="scope"]`);
  if (cell) { await cell.selectOption('OUT_OF_SCOPE'); check('US-3 list cell Scope → dialog', await dialogShown('[data-dialog="req-change"]')); await page.click('[data-dialog="req-change"] [data-v="cancel"]'); await page.waitForTimeout(400); check('US-3 list cell 취소 → scope kept', (await reqApi(r3)).scope === 'IN_SCOPE'); }
  else check('US-3 list cell Scope → dialog', false, 'no inline select');
  // bulk: Scope on 2 confirmed → one CR linking both, requirements unchanged
  n0 = crCount();
  await page.goto(reqUrl); await page.waitForSelector('.rtool');
  await page.check(`tr[data-id="${r1.id}"] [data-pick]`); await page.check(`tr[data-id="${r3.id}"] [data-pick]`);
  await page.selectOption('[data-bf]', 'scope'); await page.selectOption('[data-bv]', 'OUT_OF_SCOPE'); await page.click('[data-bapply]');
  check('US-3 bulk Scope → dialog', await dialogShown('[data-dialog="req-change"]'));
  await page.click('[data-dialog="req-change"] [data-v="cr"]'); await page.waitForTimeout(900);
  const links = sql(`SELECT COUNT(*) FROM change_request_requirements x JOIN change_requests c ON c.id = x.change_request_id WHERE c.project_id = '${p.id}' AND c.title LIKE '%범위 변경'`);
  check('US-3 bulk → 1 CR linking both, scopes unchanged', crCount() === n0 + 1 && links === '2' && (await reqApi(r1)).scope === 'IN_SCOPE' && (await reqApi(r3)).scope === 'IN_SCOPE', `links=${links}`);
  // archive a confirmed 범위 내 → dialog → CR only
  n0 = crCount();
  await page.goto(`${reqUrl}?sel=${r3.id}`); await page.waitForSelector('#rarchive');
  await page.click('#rarchive');
  check('US-3 archive confirmed in-scope → dialog', await dialogShown('[data-dialog="req-change"]'));
  await page.click('[data-dialog="req-change"] [data-v="cr"]'); await page.waitForTimeout(800);
  check('US-3 archive → CR only, not archived', crCount() === n0 + 1 && !(await reqApi(r3)).archived_at);

  /* ---------- US-1: 02→03 gate (2 paths) before approval ---------- */
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.np__list');
  const gatePath = async (name, open) => {
    await open();
    const ok = await dialogShown('[data-dialog="approval-gate"]');
    check(`US-1 gate dialog: ${name}`, ok);
    if (!ok) return;
    const title = await page.textContent('#agT');
    check(`US-1 gate title (${name})`, title.trim() === '고객 승인 없이 분석·설계 단계로 넘어가려 합니다', title);
    await page.click('[data-v="proceed"]');
    check(`US-1 reason required (${name})`, /이유를 입력/.test(await page.textContent('#ag-err')));
  };
  const nb = await page.$('#next, [data-move-next]');
  check("What's Next has a 02→03 button", Boolean(nb));
  await gatePath("What's Next button", async () => { await page.click('#next, [data-move-next]'); });
  await shot('06-gate-02-03.png');
  await page.click('[data-v="cancel"]');
  await gatePath('?move=next', async () => { await page.goto(`${BASE}/app/projects/${p.id}?move=next`); });
  await page.click('[data-v="record"]'); await page.waitForURL(/approval=1/, { timeout: 5000 }).catch(() => {});
  check('US-1 승인 기록하러 가기 → Drawer', /requirements\?approval=1/.test(page.url()) && Boolean(await page.waitForSelector('[data-approval-drawer]', { timeout: 5000 }).catch(() => null)), page.url());

  /* ---------- US-1: approval Drawer ---------- */
  const what = await page.textContent('.apv__what');
  check('US-1 승인받을 내용: 범위 내 6건 (확정 3건) · 범위 외 2건', /6건 \(확정 3건\)/.test(what) && /2건/.test(what), what.replace(/\s+/g, ' '));
  check('US-1 Drawer has 요구사항 정의서 내려받기', Boolean(await page.$('[data-approval-drawer] [data-reqdoc-menu]')));
  const cbLabel = await page.textContent('.apv__confirm');
  check('US-1 checkbox 범위 내 미확정 3건을 함께 확정합니다 (default ON)', /범위 내 미확정 3건을 함께 확정합니다/.test(cbLabel) && await page.isChecked('#apv-confirm'));
  check('Q6-1 02 approval = right-side panel (like 01)', await page.$eval('#drawer', (d) => d.classList.contains('drawer--side') && d.getBoundingClientRect().right >= window.innerWidth - 1 && d.getBoundingClientRect().left > 300));
  check('Q6-2 승인 방법 chips + 필수 4개 중 N개 line', Boolean(await page.$('.apv__methods .choice')) && /필수 4개 중 0개 입력/.test(await page.textContent('#apv-stat')));
  await page.click('[data-apv="complete"]'); await page.waitForTimeout(600);
  check('US-1 empty fields → cannot complete', (await api('GET', `${R}/baseline`)).json.baseline.status === 'TODO');
  check('L-D2 errors inline under the fields', (await page.$$('[data-approval-drawer] .apv__err')).length === 4);
  await page.selectOption('[data-af="approver_id"]', 's1');
  await page.fill('[data-af="date"]', '2099-01-01');
  check('US-1 승인일 input max = today', (await page.getAttribute('[data-af="date"]', 'max')) <= new Date(Date.now() + 86400e3).toISOString().slice(0, 10));
  await page.check('[data-af="method"][value="REVIEW"]'); await page.fill('[data-af="evidence"]', "2026-10-14 검토 회의록 '요구사항 정의서 v1.0 승인'");
  await page.click('[data-apv="complete"]'); await page.waitForTimeout(700);
  check('US-1 future 승인일 rejected', (await api('GET', `${R}/baseline`)).json.baseline.status === 'TODO');
  await page.fill('[data-af="date"]', '2026-10-14');
  await page.uncheck('#apv-confirm');
  await page.click('[data-apv="complete"]'); await page.waitForTimeout(500);
  const block = await page.textContent('#apv-block');
  check('US-1 OFF + 미확정 → blocked message + 미확정 보기 →', /범위 내 미확정 3건이 있습니다\. 먼저 확정하세요/.test(block) && /미확정 보기 →/.test(block), block);
  const bl = (await api('GET', `${R}/baseline`)).json.baseline;
  check('US-1 OFF → nothing saved', bl.status === 'TODO' && bl.approval.evidence === '' && bl.counts.in_scope_unconfirmed === 3);
  await shot('07-approval-drawer-blocked.png');
  // download from the Drawer
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('[data-approval-drawer] [data-reqdoc-menu] summary'); await page.click('[data-approval-drawer] [data-reqdoc="pdf"]'); })()]);
  check('US-2 PDF from Drawer', /_요구사항정의서_v0\.9_\d{8}\.pdf$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await page.check('#apv-confirm');
  await shot('08-approval-drawer.png');
  await page.click('[data-apv="complete"]'); await page.waitForTimeout(1200);
  const b2 = (await api('GET', `${R}/baseline`)).json.baseline;
  check('US-1 ON → approval recorded + 3 confirmed', b2.status === 'COMPLETED' && b2.counts.in_scope_unconfirmed === 0 && [u1, u2, u3].every(() => true), JSON.stringify(b2.counts));
  for (const u of [u1, u2, u3]) if ((await reqApi(u)).status !== 'CONFIRMED') check(`US-1 ${u.display_id} confirmed`, false);
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.rg__title');
  const g2 = (await api('GET', P)).json;
  const st = (k) => g2.current_phase.steps.find((x) => x.step_key === k).state;
  check('US-1 CONFIRM + BASELINE_APPROVAL completed', st('CONFIRM') === 'COMPLETED' && st('BASELINE_APPROVAL') === 'COMPLETED');
  check('US-1 REQ_DONE guidance after approval', /요구사항 정의가 마무리되었습니다/.test(await page.textContent('.rg__title')) && /기준선이 잡혔습니다/.test(await page.textContent('.rg')));
  await shot('09-whats-next-req-done.png');
  // US-3 add after approval: new 범위 내 requirement → dialog (adding)
  await page.goto(`${reqUrl}?new=1`); await page.waitForSelector('#cf');
  await page.fill('#c-title', '전자서명 연동'); await page.selectOption('#cf [name="scope"]', 'IN_SCOPE'); await page.click('#cf button[type="submit"]:not([data-more])');
  check('US-3 add 범위 내 after approval → dialog', await dialogShown('[data-dialog="req-change"]'));
  const addDlg = await page.$eval('[data-dialog="req-change"]', (d) => ({ body: d.querySelector('.dialog__b').textContent.trim(), btns: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()), primary: d.querySelector('.btn--primary').textContent.trim() }));
  check('J-1 add dialog copy + [취소] [그냥 추가] [변경 요청 만들기]', addDlg.body === '고객이 새로 요청한 요구사항이면 변경 요청으로 등록해 영향(일정·공수)을 검토하고 승인받으세요. 원래 승인 범위에 있었는데 빠뜨린 것이면 그냥 추가해도 됩니다.' && addDlg.btns.join('|') === '취소|그냥 추가|변경 요청 만들기' && addDlg.primary === '변경 요청 만들기', JSON.stringify(addDlg));
  n0 = crCount();
  await page.click('[data-dialog="req-change"] [data-v="cr"]'); await page.waitForTimeout(800);
  check('US-3 add → CR draft only, no requirement', crCount() === n0 + 1 && !(await api('GET', `${R}?q=전자서명`)).json.requirements.length);
  // 02→03 with approval → no gate, LNB 02 ✓
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.rg');
  await page.click('[data-move-next], #next');
  const gateAgain = await dialogShown('[data-dialog="approval-gate"]');
  check('US-1 approved → no gate dialog', !gateAgain);
  const conf = await page.$('.scrim .dialog .btn--primary'); if (conf) { await conf.click(); }
  await page.waitForTimeout(1000);
  const lnb = await page.evaluate(() => { const ph = document.querySelector('.lnb__ph[data-grp="REQUIREMENTS"]'); return ph ? { cls: ph.className, mark: ph.querySelector('.lnb__mark').textContent.trim() } : null; });
  check('US-1 LNB 02 ✓ after approval', lnb && /is-done/.test(lnb.cls) && lnb.mark === '✓', JSON.stringify(lnb));
  // 03: WBS banner back
  await page.goto(reqUrl); await page.waitForSelector('.rtool');
  check('US-4(4) WBS banner from 03', Boolean(await page.$('[data-tour-id="req-next"]')));
  check('P-1 03: KPI WBS 미연결 + 미연결 mark shown', /WBS 미연결 \(범위 내\)/.test(await page.textContent('#kstrip')) && Boolean(await page.$('.is-unlinked')));
  await page.goto(`${reqUrl}?sel=${r1.id}`); await page.waitForSelector('#drawer .dtitle'); await page.click('[data-dtab="links"]');
  check('US-4(4) Delivery Trace from 03', Boolean(await page.$('#drawer .trace')));

  /* ---------- US-1: bypass with a reason (second project) ---------- */
  const B = await mkProject('사유 기록 프로젝트');
  // Q6-2: 0 범위 내 → empty line, 완료 처리 disabled, API refuses
  await page.goto(`${BASE}/app/projects/${B.p.id}/requirements?approval=1`); await page.waitForSelector('[data-approval-drawer]');
  check('Q6-2 empty baseline: empty line + 완료 처리 disabled', Boolean(await page.$('[data-apv-empty]')) && await page.$eval('[data-apv="complete"]', (b) => b.disabled));
  check('Q6-2 empty baseline: API 400', (await api('POST', `${B.P}/requirements/baseline/complete`, { approval: { approver_id: 's1', date: '2026-09-10', method: 'EMAIL', evidence: '메일' }, confirm_unconfirmed: true })).status === 400);
  await api('POST', `${B.P}/requirements`, { title: 'R1', scope: 'IN_SCOPE', status: 'CONFIRMED', type: 'FUNCTIONAL', priority: 'HIGH' });
  await page.goto(`${BASE}/app/projects/${B.p.id}`); await page.waitForSelector('.np__list');
  await gatePath('What\'s Next button (사유 입력)', async () => { await page.click('#next, [data-move-next]'); });
  await page.fill('#ag-in', '고객 PM 출장으로 승인 회신이 다음 주 예정'); await page.click('[data-v="proceed"]');
  await page.waitForTimeout(600);
  const c2 = await page.$('.scrim .dialog .btn--primary'); if (c2) { await c2.click(); await page.waitForTimeout(800); }
  const gb = (await api('GET', B.P)).json;
  check('US-1 moved to 03 after reason', gb.current_phase.phase_key === 'ANALYSIS_DESIGN');
  const bst = gb.phases.find((x) => x.phase_key === 'REQUIREMENTS').steps.find((x) => x.step_key === 'BASELINE_APPROVAL');
  check('US-1 reason in BASELINE_APPROVAL note', /^\[승인 전 진행\] 고객 PM 출장으로 승인 회신이 다음 주 예정 · \d{4}-\d{2}-\d{2} · 홍길동$/.test(bst.note), bst.note);
  check('US-1 row text 승인 전 진행 · 사유 있음', bst.text === '승인 전 진행 · 사유 있음', bst.text);
  await page.goto(`${BASE}/app/projects/${B.p.id}?phase=REQUIREMENTS`); await page.waitForSelector('.np--other');
  check("US-1 What's Next 02 row shows 승인 전 진행 · 사유 있음", /승인 전 진행 · 사유 있음/.test(await page.textContent('.np--other')));
  const lnb2 = await page.evaluate(() => { const ph = document.querySelector('.lnb__ph[data-grp="REQUIREMENTS"]'); return { cls: ph.className, mark: ph.querySelector('.lnb__mark').textContent.trim() }; });
  check('US-1 bypass: LNB 02 not ✓ (number + badge)', /is-gap/.test(lnb2.cls) && lnb2.mark === '02', JSON.stringify(lnb2));
  await shot('10-bypass-02-row.png');
  const docx = await page.request.get(`${BASE}${B.P}/requirements/export-doc?format=docx`);
  const xml = await (await JSZip.loadAsync(await docx.body())).file('word/document.xml').async('string');
  check('US-1 document 승인란: 미승인 — 사유', xml.includes('미승인 — 사유: 고객 PM 출장으로 승인 회신이 다음 주 예정'));

  /* ---------- US-2 downloads from the toolbar (main project, v1.0) ---------- */
  await page.goto(reqUrl); await page.waitForSelector('[data-reqdoc-menu]');
  for (const fmt of ['pdf', 'docx']) {
    const [d] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('.rtool [data-reqdoc-menu] summary'); await page.click(`.rtool [data-reqdoc="${fmt}"]`); })()]);
    const f = `${SHOTS}/요구사항정의서.${fmt}`; await d.saveAs(f);
    check(`US-2 ${fmt.toUpperCase()} downloaded (v1.0)`, new RegExp(`_요구사항정의서_v1\\.0_\\d{8}\\.${fmt}$`).test(d.suggestedFilename()) && fs.statSync(f).size > 1000, d.suggestedFilename());
  }

  // phone (< 768px) = view mode (hive research/relai-mobile-spec.md): the approval drawer is PC-only; the PC line replaces it
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${BASE}/app/projects/${B.p.id}/requirements?approval=1`); await page.waitForSelector('.pcline');
  await page.waitForTimeout(500);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check('375px: no approval drawer (PC line instead), no sideways scroll', !(await page.$('[data-approval-drawer]')) && (await page.$$('.pcline')).length === 1 && sw <= 376, String(sw));
  await shot('11-approval-375-view.png');

  await browser.close();
  const fails = results.filter((x) => !x[1]);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
