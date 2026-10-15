// Phase 7 (07 운영 및 유지보수) browser check — every AC of hive research/relai-phase-7-spec.md (v2):
// US-1 완료보고서 (보고서 ▾ 생성 · 7절 숫자 · 교훈 3칸 · 확정 → CLOSE 완료 · PDF/Word · 두 번째 생성 = 같은 보고서 · 07 이전 회색 · 수동 완료 사유 422),
// US-2 종료 (CLOSE 완료 → dialog → 헤더 "✓ 완료 · 날짜" · 홈 완료 묶음 · What's Next 종료 화면 · 종료 취소 · 미래 종료일 422 · 하자보수 기본 +12개월 · 보관 별개),
// US-3 운영 인수 (인수자·인수일 422 · 운영 담당 미정 warn · 행 표시 · 꼬리표 · 6절 담당), US-4 넘긴 건 독촉 없음, US-5 07 문구, US-6 06→07 요약 + 용어 + 영어 없음,
// one full novice path 01→07→종료 (What's Next only), migration 38. 375px shots: 종료 dialog, 종료 후 What's Next, HANDOVER dialog, 홈 완료 묶음.
// Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3028 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-phase7.cjs   (playwright on NODE_PATH; server with PLAN_LIMITS=off)
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3028';
const SHOTS = process.env.SHOTS || 'phase7-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => (DB ? execFileSync('psql', ['-q', '-t', '-A', DB, '-c', q]).toString().trim() : '');

const todayKst = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const addDays = (ymd, n) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (ymd, m) => { const [y, mo, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + m, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); };
const T = todayKst(); const d = (n) => addDays(T, n);
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

const TEAM = [
  { id: 'sh-pm', name: '정하늘', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-cl', name: '오지현', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
  { id: 'sh-ops', name: '김운영', org_type: 'CLIENT', org: 'ACME', role: '운영 담당' },
];
// English UI words that must not appear on the 07 / 완료보고서 screens (US-6). ID prefixes are removed with .mono; SLA is the agreed acronym.
const EN = /\b(Lessons?|Learned|Closed?|Completed?|Handover|Operations?|Maintenance|Release|Report|Draft|Final|Go-?Live|Status|Owner|Issues?|Warranty)\b/;
const STEP = (g, key) => g.phases.flatMap((p) => p.steps).find((s) => s.step_key === key);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
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

  const email = `p7-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '정하늘', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mkProject = async (name, extra = {}) => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: d(-120), planned_end_date: d(30), data_migration: 'NO', has_external_integration: 'NO', ...extra })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { stakeholders: TEAM, goal: '계약 처리 시간을 30% 줄인다' });
    return { p, P, url: `${BASE}/app/projects/${p.id}` };
  };
  const toPhase = async (A, keys) => { for (const key of keys) { const G = (await api('GET', A.P)).json; if (G.project.current_phase === key) continue; const ph = G.phases.find((x) => x.phase_key === key); await api('POST', `${A.P}/phases/${ph.id}/activate`, { reason: 'NEXT' }); } };
  const mkReq = async (A, title, scope = 'IN_SCOPE') => { const r = (await api('POST', `${A.P}/requirements`, { title, type: 'FUNCTIONAL', priority: 'MEDIUM', scope })).json.requirement; if (scope === 'IN_SCOPE') await api('PATCH', `${A.P}/requirements/${r.id}`, { status: 'CONFIRMED' }); return r; };
  const mkTest = async (A, req, result = 'PASS') => {
    const t = (await api('POST', `${A.P}/tests`, { title: `${req.title} 확인` })).json.test;
    await api('POST', `${A.P}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: req.id });
    const x = result ? (await api('POST', `${A.P}/tests/${t.id}/executions`, { result })).json.execution : null;
    return { t, x };
  };
  const approval = { approver_id: 'sh-cl', date: d(-6), method: 'SIGNED', evidence: '검수확인서 서명본 수령' };
  /** Handles whatever phase-move dialog appears (approval gate → reason; 계속 진행 / 다음 단계 시작 confirms) until the dialog is gone. */
  const confirmMoves = async (pg = page) => {
    for (let i = 0; i < 4; i += 1) {
      const dlg = await pg.waitForSelector('.scrim .dialog', { timeout: 2500 }).catch(() => null);
      if (!dlg) return;
      if (await pg.$('[data-dialog="approval-gate"]')) { await pg.fill('#ag-in', '고객 회신 대기 중, 다음 주 회신 예정'); await pg.click('[data-dialog="approval-gate"] [data-v="proceed"]'); }
      else await pg.click('.scrim .dialog [data-v="1"]');
      await pg.waitForTimeout(250);
    }
  };

  /* ===== project A: data through 06 (목표 · 요구사항 2+1 · 테스트 통과/제외 · 결함 이슈 해결 · 오픈 +5일 사유 · CR 승인·반영 + 미반영 · 검수 승인) ===== */
  const A = await mkProject('계약 관리 시스템 구축');
  const r1 = await mkReq(A, '계약 등록'); const r2 = await mkReq(A, '계약 검색'); await mkReq(A, '모바일 앱', 'OUT_OF_SCOPE');
  await api('PATCH', `${A.P}/requirements/${r2.id}/test-exclusion`, { reason: '고객이 운영 데이터로 직접 확인' });
  const { t: t1, x: x1 } = await mkTest(A, r1, 'FAIL');
  const di = (await api('POST', `${A.P}/tests/${t1.id}/executions/${x1.id}/issue`, {})).json; const defect = di.issue || di;
  await api('POST', `${A.P}/tests/${t1.id}/executions`, { result: 'PASS', resolve_issue_ids: [defect.id] });
  const ms = (await api('POST', `${A.P}/wbs`, { item_type: 'MILESTONE', title: '오픈', milestone_date: d(-12), lifecycle_phase: 'TRANSITION_GO_LIVE' })).json; const msId = (ms.item || ms).id;
  await toPhase(A, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT']);
  const push = await api('PATCH', `${A.P}/wbs/${msId}`, { milestone_date: d(-7), delay_reason: '고객 데이터 이관 지연' });
  check('setup: 오픈 마일스톤 +5일 (사유)', push.status === 200, String(push.status));
  const cr1 = (await api('POST', `${A.P}/changes`, { title: '알림 메일 문구 변경', requester_name: '오지현' })).json.change;
  for (const a of ['submit', 'approve', 'implement']) await api('POST', `${A.P}/changes/${cr1.id}/transition`, a === 'approve' ? { action: a, customer_approval: approval } : { action: a });
  const cr2 = (await api('POST', `${A.P}/changes`, { title: '엑셀 내려받기 추가', requester_name: '오지현' })).json.change;
  for (const a of ['submit', 'approve']) await api('POST', `${A.P}/changes/${cr2.id}/transition`, a === 'approve' ? { action: a, customer_approval: approval } : { action: a });
  await toPhase(A, ['TESTING', 'TRANSITION_GO_LIVE']);
  const acc = (await api('POST', `${A.P}/acceptances`, { title: '1차 검수', requirements: [r1.id, r2.id] })).json.acceptance;
  await api('POST', `${A.P}/acceptances/${acc.id}/transition`, { action: 'submit' });
  const accR = await api('POST', `${A.P}/acceptances/${acc.id}/transition`, { action: 'accept', customer_approval: approval });
  check('setup: 검수 승인 (고객 승인 기록)', accR.status === 200, String(accR.status));
  const iss = (await api('POST', `${A.P}/issues`, { title: '야간 배치 지연', severity: 'CRITICAL' })).json; const issue = iss.issue || iss.item || iss;
  const open = (await api('GET', `${A.P}/go-live`)).json.open_items;
  const gl = await api('POST', `${A.P}/go-live`, { date: d(-2), carryovers: open.map((x) => ({ type: x.type, id: x.id, note: `${x.display_id} 운영팀 1차 대응` })) });
  check('setup: 오픈 + 운영 이관 2건 (ISS · CR)', gl.status === 200 && gl.json.go_live.carryovers.length === 2, String(gl.status));

  /* ---------- US-6 06→07 진입 dialog: 앞 단계 미완료 필수 요약 1줄 ---------- */
  await page.goto(A.url); await page.waitForSelector('.np');
  const moveBtn = (await page.$('[data-move-next]')) || (await page.$('#next'));
  await moveBtn.click();
  await page.waitForSelector('.scrim .dialog');
  const gapTxt = await page.textContent('.scrim .dialog').catch(() => '');
  check('US-6 06→07 dialog: "앞 단계 미완료 필수 업무 N건 (01 착수 5건 · 02 요구사항 기준선 승인(고객) · …)"', /앞 단계 미완료 필수 업무 \d+건 \(01 착수 5건 · 02 요구사항 기준선 승인\(고객\) · /.test(gapTxt), gapTxt.replace(/\s+/g, ' ').slice(0, 200));
  check('US-6 요약 줄 항목이 링크 (막지 않음)', (await page.$$('[data-prior-gaps] a')).length >= 1);
  await shot('g-01-06-to-07-dialog.png');
  await confirmMoves();
  await page.waitForFunction(() => /운영 및 유지보수/.test(document.querySelector('.np h2')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  let g = (await api('GET', A.P)).json;
  check('US-6 확인 → 07 진입', g.project.current_phase === 'OPERATIONS');
  const gapsApi = g.prior_gaps.length;

  /* ---------- US-5 07 문구 · US-4 독촉 없음 ---------- */
  await page.goto(A.url); await page.waitForSelector('.np');
  const npd = await page.textContent('.np__d');
  check('US-5 07 단계 설명 문구', npd.trim() === '운영 조직에 인수인계하고, 완료보고서로 결과를 정리한 뒤 프로젝트를 종료합니다.', npd);
  const slaTxt = await page.textContent('.np__row:has-text("SLA 확인") .np__purpose'); const relTxt = await page.textContent('.np__row:has-text("정기 배포 계획") .np__purpose');
  const mtTxt = await page.textContent('.np__row:has-text("유지보수 체계 확인") .np__purpose');
  check('US-5 SLA·정기 배포 "운영 계약이 있으면 — " (선택) · 유지보수 하자보수 접수 경로', /^운영 계약이 있으면 — /.test(slaTxt) && /^운영 계약이 있으면 — /.test(relTxt) && /하자보수 기간의 요청 접수 경로/.test(mtTxt)
    && /선택/.test(await page.textContent('.np__row:has-text("SLA 확인")')), `${slaTxt} | ${relTxt}`);
  const warns = await page.$$eval('.rg__warn', (els) => els.map((e) => e.textContent.trim()));
  check('US-4 07: 독촉 없음, "운영 이관 2건 · 담당 지정 0/2"만', warns.length === 1 && /운영 이관 2건 · 담당 지정 0\/2/.test(warns[0]), JSON.stringify(warns));
  check('US-4 warn 점 (빨강 아님) + 담당 지정 링크', (await page.$$('.rg__warn .st--warn')).length === 1 && (await page.$$('.rg .is-crit, .np__row.is-crit')).length === 0 && /담당/.test(await page.textContent('.rg__warn a')));
  const home0 = (await api('GET', `/api/workspaces/${w}/projects/home`)).json.projects.find((c) => c.id === A.p.id);
  check('US-4 홈 카드: 이관 ISS·CR이 확인 필요/경고에 없음', !home0.attention.items.some((i) => i.type === 'ISSUE' || i.type === 'CHANGE') && !home0.guidance.warnings.some((x) => /심각|미반영/.test(x)), JSON.stringify(home0.attention.items));
  await shot('g-02-07-whatsnext.png');
  const en07 = enOf((await textOf('main')).replace(/SLA/g, ''));
  check('US-6 07 What\'s Next: 영어 UI 없음', !en07, en07);
  const clItems = (await api('POST', `${A.P}/steps/${STEP(g, 'CLOSE').id}/checklist/defaults`, {})).json.items.map((i) => i.title);
  check('US-6 체크리스트 기본 항목 "교훈 정리" (Lessons Learned 없음)', clItems.includes('교훈 정리') && !clItems.some((t) => /Lessons/.test(t)), JSON.stringify(clItems));

  /* ---------- US-3 HANDOVER dialog ---------- */
  const noRecv = await api('PATCH', `${A.P}/steps/${STEP(g, 'HANDOVER').id}`, { status: 'COMPLETED' });
  check('US-3 API 인수자·인수일 없이 HANDOVER 완료 → 422', noRecv.status === 422 && noRecv.json.error.code === 'handover_required', String(noRecv.status));
  await page.click('.rg__warn a'); await page.waitForSelector('[data-handover-dialog]');
  await page.click('[data-ho-ok]');
  const hoErr = await page.textContent('[data-ho-err="receiver"]');
  check('US-3 인수자 없이 인수 완료 → 필드 오류 (저장 안 됨)', /인수자를 고르세요/.test(hoErr) && STEP((await api('GET', A.P)).json, 'HANDOVER').state !== 'COMPLETED', hoErr);
  const firstGroup = await page.$eval('#ho-r optgroup', (e) => e.label);
  check('US-3 인수자 선택기: 고객사 먼저 (고객사 · RELAI 사용자 · 팀원)', firstGroup === '고객사' && (await page.$$eval('#ho-r optgroup', (o) => o.map((x) => x.label))).join('|').startsWith('고객사|RELAI 사용자'), firstGroup);
  await page.selectOption('#ho-r', 's:sh-ops'); await page.fill('#ho-d', d(-1));
  await page.selectOption(`[data-owner="ISSUE:${issue.id}"]`, 's:sh-ops'); await page.selectOption(`[data-owner="CR:${cr2.id}"]`, 'TBD');
  const tbdLine = await page.textContent('[data-ho-tbd]');
  check('US-3 미정 1건 → warn "운영 담당 미정 1건" (막지 않음)', /운영 담당 미정 1건/.test(tbdLine) && !(await page.$eval('[data-ho-ok]', (b) => b.disabled)), tbdLine);
  await shot('g-03-handover-dialog.png');
  await page.click('[data-ho-ok]'); await toastText(page, /운영 인수를 기록/);
  await page.waitForSelector('.np__row:has-text("운영 이관 / 인수인계") [data-row-text]');
  const hoRow = await page.textContent('.np__row:has-text("운영 이관 / 인수인계") [data-row-text]');
  check('US-3 HANDOVER 행 "✓ 인수 · M/D · 김운영(고객사)"', hoRow.trim() === `✓ 인수 · ${md(d(-1))} · 김운영(고객사)`, hoRow);
  const warn2 = await page.$$eval('.rg__warn', (els) => els.map((e) => e.textContent.trim()));
  check('US-4 담당 지정 후 "운영 이관 2건 · 담당 지정 1/2"', /담당 지정 1\/2/.test(warn2[0] || ''), JSON.stringify(warn2));
  await page.goto(`${A.url}/issues`); await page.waitForSelector(`[data-carry="ISSUE:${issue.id}"]`);
  const tag = await page.textContent(`[data-carry="ISSUE:${issue.id}"]`);
  check('US-3 이관 항목 꼬리표 "운영 이관 · 담당 김운영(고객사)"', /^운영 이관 · 담당 김운영/.test(tag.trim()), tag);

  /* ---------- US-1 완료보고서 ---------- */
  await page.goto(A.url); await page.waitForSelector('.np');
  await page.click('.wsh__act [data-act="reports"]'); await page.waitForSelector('[data-rep="completion"]');
  check('US-1 보고서 ▾ 메뉴에 "완료보고서 생성" (07: 활성)', !(await page.$eval('[data-rep="completion"]', (b) => b.disabled)));
  await page.click('[data-rep="completion"]');
  await page.waitForURL(/\/reports\/[0-9a-f-]+$/); await page.waitForSelector('.doc');
  const repUrl = page.url(); const rid = repUrl.split('/').pop();
  const secs = await page.$$eval('.doc__sec h2', (els) => els.map((e) => e.textContent.trim()));
  check('US-1 7절 (개요 · 범위 · 일정 · 품질 · 검수 · 남은 일 · 교훈)', JSON.stringify(secs) === JSON.stringify(['1. 개요', '2. 범위', '3. 일정', '4. 품질', '5. 검수', '6. 남은 일 (운영 이관)', '7. 교훈']), JSON.stringify(secs));
  const val = async (key) => page.$eval(`[data-sec="${key}"]`, (t) => t.value);
  const ov = await val('overview'); const sc = await val('scope'); const sch = await val('schedule'); const q = await val('quality'); const ac = await val('acceptance'); const co = await val('carryover');
  check('US-1 1절 개요: 목표 · 계약 기간 · 최초 계획 → 실제 오픈일', /목표: 계약 처리 시간을 30% 줄인다/.test(ov) && ov.includes(`계약 기간: ${d(-120)} ~ ${d(30)}`) && ov.includes(`최초 계획 ${d(-12)} → 실제 ${d(-2)} (+10일)`), ov);
  check('US-1 2절 범위: 확정 2 · 범위 밖 1 · 변경 승인 2 / 반영 1', /범위 내 확정 요구사항 2건 · 범위 밖 1건/.test(sc) && /변경 요청 승인 2건 \/ 반영 1건/.test(sc), sc);
  check('US-1 3절 일정: 미룬 작업 1건 · +5일 · 사유', /미룬 작업 1건 · 최초 계획 대비 총 \+5일/.test(sch) && /\+5일 · 고객 데이터 이관 지연/.test(sch), sch);
  check('US-1 4절 품질: 테스트 1 · 통과 1 · 제외 1(사유) · 이슈 1(해결 1)', /테스트 1건 · 최근 통과 1건 · 제외 1건/.test(q) && /제외 사유: 고객이 운영 데이터로 직접 확인/.test(q) && /테스트에서 나온 이슈 1건 \(해결 1건\)/.test(q), q);
  check('US-1 5절 검수: 고객 승인자 · 날짜 · 방법', ac.includes(`1차 검수 — 오지현 고객 PM · ${approval.date} · 서명본 수령`), ac);
  check('US-1 6절 남은 일: 이관 2건 + 운영 담당 + 앞 단계 요약 (같은 숫자)', /운영 이관 2건/.test(co) && /운영 담당 김운영\(고객사\)/.test(co) && /운영 담당 미정/.test(co) && co.includes(`앞 단계 미완료 필수 업무 ${gapsApi}건 (01 착수 5건 · 02 요구사항 기준선 승인(고객)`) && gapTxt.includes(co.split('- 앞 단계 ')[1].trim()), co);
  const lessons = await page.$$eval('[data-lesson]', (els) => els.map((e) => [e.value, e.placeholder]));
  check('US-1 7절 교훈: 빈 3칸 + placeholder', lessons.length === 3 && lessons.every(([v, ph]) => v === '' && /^예: /.test(ph)) && /요구사항 기준선 승인을 일찍 받아 변경 다툼이 적었다/.test(lessons[0][1]), JSON.stringify(lessons));
  const repPrim = await primaries(page, 'main');
  check('US-1 같은 버튼 줄 (PDF · Word · 복사 · 보고서 확정 primary 1개)', repPrim.length === 1 && repPrim[0] === '보고서 확정' && (await page.$$('[data-dl]')).length === 2, JSON.stringify(repPrim));
  check('US-1 ? 툴팁 완료보고서', /프로젝트 결과·계획 대비 차이·남은 일·교훈/.test(await page.getAttribute('.doc__meta .term', 'data-tip')));
  const enRep = enOf(await textOf('main'));
  check('US-6 완료보고서 화면 영어 UI 없음', !enRep, enRep);
  await page.waitForSelector('.lnb__i.is-active', { timeout: 5000 }).catch(() => {});
  const lnbAct = await page.$$eval('.lnb__i.is-active', (e) => e.map((x) => x.textContent.trim()));
  check('Q16-4 완료보고서 화면: LNB = 07 › 종료 정리 (주간보고 아님)', lnbAct.length === 1 && lnbAct[0] === '종료 정리', JSON.stringify(lnbAct));
  await page.fill('[data-lesson="good"]', '- 요구사항 기준선 승인을 일찍 받아 변경 다툼이 적었다'); await page.dispatchEvent('[data-lesson="good"]', 'change');
  await page.fill('[data-lesson="next"]', '- 이관 리허설을 두 번 한다'); await page.dispatchEvent('[data-lesson="next"]', 'change');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#dsave')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  await shot('g-04-completion-report-draft.png');
  let G = (await api('GET', A.P)).json;
  check('US-1 DRAFT → CLOSE 진행 중 (초안 작성 중)', STEP(G, 'CLOSE').state === 'IN_PROGRESS');
  // a second 완료보고서 생성 opens the same report
  await page.click('.wsh__act [data-act="reports"]'); await page.waitForSelector('[data-rep="completion"]'); await page.click('[data-rep="completion"]');
  await page.waitForTimeout(800);
  check('US-1 두 번째 "완료보고서 생성" → 같은 보고서', page.url() === repUrl && Number(sql(`SELECT COUNT(*) FROM weekly_reports WHERE project_id = '${A.p.id}' AND report_type = 'COMPLETION'`) || 1) === 1, page.url());
  // 확정 → CLOSE 완료 → 종료 dialog
  await page.click('#finalize'); await page.waitForSelector('.scrim .dialog'); await page.click('.scrim .dialog [data-v="1"]');
  await page.waitForSelector('[data-close-dialog]', { timeout: 8000 }).catch(() => {});
  G = (await api('GET', A.P)).json;
  check('US-1 보고서 확정 → CLOSE 완료', STEP(G, 'CLOSE').state === 'COMPLETED' && G.completion_report.state === 'FINAL');
  check('US-2 CLOSE 완료 → "프로젝트를 종료할까요?" dialog', Boolean(await page.$('[data-close-dialog]')) && /프로젝트를 종료할까요\?/.test(await page.textContent('#clT')));
  const wDef = await page.$eval('#cl-w', (e) => e.value); const dDef = await page.$eval('#cl-d', (e) => e.value);
  check('US-2 종료일 기본 오늘 · 하자보수 기본 = 종료일 + 12개월', dDef === T && wDef === addMonths(T, 12), `${dDef} ${wDef}`);
  check('US-2 dialog: 남은 운영 이관 2건 (담당 지정 1건) · [나중에] [프로젝트 종료]', /남은 운영 이관 2건 \(담당 지정 1건\)/.test(await page.textContent('[data-close-dialog]')) && /나중에/.test(await page.textContent('[data-cl-later]')) && (await page.$$('[data-close-dialog] .btn--primary')).length === 1);
  check('US-6 ? 툴팁 하자보수', /오픈 후 일정 기간 결함을 무상으로/.test(await page.getAttribute('[data-close-dialog] .term', 'data-tip')));
  await shot('g-05-close-dialog.png');
  // PDF / Word sample
  for (const ext of ['pdf', 'docx']) {
    const r = await page.request.get(`${BASE}/api/workspaces/${w}/projects/${A.p.id}/weekly-reports/${rid}/export.${ext}`);
    const buf = await r.body(); fs.writeFileSync(`${SHOTS}/sample-완료보고서.${ext}`, buf);
    check(`US-1 ${ext.toUpperCase()} 내려받기 (완료보고서.${ext})`, r.status() === 200 && buf.length > 2000 && /완료보고서/.test(decodeURIComponent(r.headers()['content-disposition'] || '')), `${r.status()} ${buf.length}`);
  }
  // 미래 종료일 422 (API) · then 종료 through the dialog
  const fut = await api('POST', `${A.P}/close`, { closed_on: d(1) });
  check('US-2 미래 종료일 → 422', fut.status === 422 && fut.json.error.code === 'invalid_closed_on', String(fut.status));
  await page.click('[data-cl-ok]'); await toastText(page, /프로젝트를 종료/);
  await page.waitForURL(new RegExp(`/app/projects/${A.p.id}$`)); await page.waitForSelector('[data-closed]');
  const pill = await page.textContent('[data-closed-pill]');
  check('US-2 헤더 pill "✓ 완료 · M/D" (초록)', pill.trim() === `✓ 완료 · ${md(T)}` && await page.$eval('[data-closed-pill]', (e) => e.classList.contains('chip--done')), pill);
  const closedTxt = await page.textContent('[data-closed]');
  check('US-2 What\'s Next "프로젝트가 종료되었습니다" · 날짜 · 하자보수', /프로젝트가 종료되었습니다/.test(closedTxt) && closedTxt.includes(`${md(T)} 종료 · 하자보수 ${addMonths(T, 12).replace(/-/g, '/')}까지`), closedTxt.replace(/\s+/g, ' '));
  const prim2 = await primaries(page, 'main');
  check('US-2 종료 후 primary 1개 = 완료보고서 보기 (링크 = 이 보고서)', prim2.length === 1 && prim2[0] === '완료보고서 보기' && (await page.getAttribute('[data-closed] .btn--primary', 'href')).endsWith(rid), JSON.stringify(prim2));
  check('US-2 종료 후 빨강·주황 독촉 없음', (await page.$$('main .rg__warn, main .is-crit:not(details *), main .st--warn:not(details *)')).length === 0);
  const AMBER = /rgb\((180, 83, 9|217, 119, 6|254, 246, 231)\)/;   // --warn-fg · --warn · --warn-bg
  const nagN = await page.$$eval('.lnb__n, .pstep__n', (e) => e.length);
  const amberN = await page.$$eval('.lnb__ph.is-gap .lnb__mark, .pstep li.is-gap a, .pstep li.is-gap .st', (els, re) => els.filter((e) => new RegExp(re).test(`${getComputedStyle(e).color} ${getComputedStyle(e).backgroundColor}`)).length, AMBER.source);
  check('M1 종료 후 LNB·단계 표시줄: 주황 숫자 없음 (회색)', nagN === 0 && amberN === 0, `counts ${nagN} amber ${amberN}`);
  await shot('g-06-closed-whatsnext.png');
  const enClosed = enOf(await textOf('main'));
  check('US-6 종료 화면 영어 UI 없음', !enClosed, enClosed);
  // a closed project is not locked (하자보수 이슈)
  const hz = await api('POST', `${A.P}/issues`, { title: '하자: 출력 정렬', severity: 'LOW' });
  check('US-2 종료 후에도 이슈 기록 가능 (잠그지 않음)', hz.status === 201);
  check('US-2 이슈가 생겨도 독촉 없음', (await api('GET', A.P)).json.guidance.rule === 'CLOSED');
  const hzi = hz.json.issue || hz.json.item || hz.json;
  check('US-2 하자 이슈 처리도 그대로 (해결)', (await api('PATCH', `${A.P}/issues/${hzi.id}`, { status: 'RESOLVED' })).status === 200);

  /* ---------- US-2 홈 '완료된 프로젝트' 묶음 ---------- */
  const B = await mkProject('인사 시스템 고도화');   // a live project next to it (in 01)
  await page.goto(`${BASE}/app`); await page.waitForSelector('.home');
  const liveNames = await page.$$eval('.hgrid .hc__name', (els) => els.map((e) => e.textContent.trim()));
  check('US-2 홈: 진행 중 목록에서 빠짐', !liveNames.includes('계약 관리 시스템 구축') && liveNames.includes('인사 시스템 고도화'), JSON.stringify(liveNames));
  const sum = await page.textContent('.hdone summary');
  check('US-2 홈: "완료된 프로젝트 1개" 접힌 묶음', /완료된 프로젝트\s*1개/.test(sum) && !(await page.$eval('.hdone', (e) => e.open)), sum);
  await page.click('.hdone summary');
  const doneRow = await page.textContent(`[data-done-pid="${A.p.id}"]`);
  check('US-2 홈 완료 카드: 이름 · 완료일 · 완료보고서 (다음 할 일 없음)', /계약 관리 시스템 구축/.test(doneRow) && doneRow.includes(`✓ 완료 · `) && /완료보고서/.test(doneRow) && !/다음 할 일/.test(doneRow), doneRow.replace(/\s+/g, ' '));
  await shot('g-07-home-completed.png');

  /* ---------- US-2 종료 취소 → 진행 중, 07 안내 다시 ---------- */
  await page.goto(A.url); await page.waitForSelector('[data-closed]');
  await page.click('.wsh__act [data-act="more"]'); await page.waitForSelector('[data-more="reopen"]');
  await page.click('[data-more="reopen"]'); await page.waitForSelector('.scrim .dialog'); await page.click('.scrim .dialog [data-v="1"]');
  await toastText(page, /종료를 취소/); await page.waitForSelector('.rg');
  G = (await api('GET', A.P)).json;
  check('US-2 종료 취소 → 진행 중 · closed_on 비움 · 07 안내 다시', G.project.status === 'ACTIVE' && G.project.closed_on === null && /프로젝트를 종료하세요/.test(await page.textContent('.rg__title')), G.guidance.rule);
  check('US-2 나중에 종료: 07 가이드 primary = "프로젝트 종료"', /프로젝트 종료/.test((await primaries(page, '.rg')).join('|')));
  check('M1 종료 취소 → 남은 필수 업무 숫자 다시 표시', (await page.$$('.lnb__n')).length > 0 && (await page.$$('.pstep__n')).length > 0);
  // 종료 again through the guide CTA → dialog (나중에 = nothing changes)
  await page.click('.rg .btn--primary'); await page.waitForSelector('[data-close-dialog]');
  await page.click('[data-cl-later]');
  check('US-2 [나중에] → 그대로 진행 중', (await api('GET', A.P)).json.project.status === 'ACTIVE');
  await page.click('.rg .btn--primary'); await page.waitForSelector('[data-close-dialog]'); await page.click('[data-cl-ok]');
  await page.waitForSelector('[data-closed]');
  check('US-2 가이드 CTA로 다시 종료', (await api('GET', A.P)).json.project.status === 'COMPLETED');

  /* ---------- US-2 보관은 별개 · US-1 07 이전 회색 ---------- */
  await page.goto(B.url); await page.waitForSelector('.np');
  await page.click('.wsh__act [data-act="reports"]'); await page.waitForSelector('[data-rep="completion"]');
  const grey = await page.$eval('[data-rep="completion"]', (b) => [b.disabled, b.title]);
  check('US-1 07 이전: 완료보고서 생성 회색 + 툴팁 "07 운영 단계에서 만들 수 있습니다"', grey[0] === true && grey[1] === '07 운영 단계에서 만들 수 있습니다', JSON.stringify(grey));
  check('US-1 07 이전 API → 409', (await api('POST', `${B.P}/weekly-reports/completion`, {})).status === 409);
  const arch = await api('POST', `${B.P}/archive`, {});
  check('US-2 보관(archive) 기존 동작 그대로 (ARCHIVED, 완료와 별개)', arch.status === 200 && arch.json.project.status === 'ARCHIVED' && !arch.json.project.closed_on);
  await page.goto(B.url); await page.waitForSelector('.wsh');
  check('US-2 완료 pill과 보관 표시가 다름', !(await page.$('[data-closed-pill]')) && /보관됨/.test(await page.textContent('.wsh__row')));

  /* ---------- US-1 CLOSE 수동 완료 (사유) ---------- */
  const C = await mkProject('물류 포털 구축');
  await toPhase(C, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS']);
  g = (await api('GET', C.P)).json;
  const noReason = await api('PATCH', `${C.P}/steps/${STEP(g, 'CLOSE').id}`, { status: 'COMPLETED' });
  check('US-1 보고서 없이 CLOSE 수동 완료, 사유 없음 → 422', noReason.status === 422 && noReason.json.error.code === 'reason_required', String(noReason.status));
  await page.goto(C.url); await page.waitForSelector('.np');
  await page.click(`[data-close-manual="${STEP(g, 'CLOSE').id}"]`); await page.waitForSelector('#pd-in');
  await page.click('.scrim [data-v="1"]');
  check('US-1 사유 dialog: 빈 사유 → 저장 안 됨', /사유/.test(await page.textContent('#pd-err')));
  await page.fill('#pd-in', '고객사 양식으로 작성해 메일로 전달함'); await page.click('.scrim [data-v="1"]');
  await toastText(page, /완료 처리했습니다/);
  g = (await api('GET', C.P)).json;
  check('US-1 사유 입력 → CLOSE 완료 (메모에 [외부 완료보고서])', STEP(g, 'CLOSE').state === 'COMPLETED' && /\[외부 완료보고서\] 고객사 양식으로/.test(STEP(g, 'CLOSE').note));
  const C409 = await api('POST', `${C.P}/close`, {});
  check('US-2 07 필수(HANDOVER) 미완료 → 종료 409', C409.status === 409 && C409.json.error.code === 'close_gate', String(C409.status));

  /* ---------- novice path 01 → 07 → 종료, What's Next only ---------- */
  const N = await mkProject('신입 PM 첫 프로젝트');
  await api('POST', `${N.P}/requirements`, { title: '로그인', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE' });
  await page.goto(N.url); await page.waitForSelector('.np');
  const visited = [];
  for (let i = 0; i < 6; i += 1) {
    const before = (await api('GET', N.P)).json.project.current_phase; visited.push(before);
    const b = (await page.$('[data-move-next]')) || (await page.$('#next'));
    if (!b) break;
    await b.click(); await confirmMoves();
    await page.waitForFunction((k) => true, before); await page.waitForTimeout(500);
    const after = (await api('GET', N.P)).json.project.current_phase;
    if (after === before) { log('novice: did not move from', before); break; }
    if (after === 'TRANSITION_GO_LIVE') {   // 오픈 through the 오픈 dialog (guide / row)
      await page.goto(`${N.url}?golive=1`); await page.waitForSelector('[data-golive-dialog]');
      await page.click('[data-gl-ok]'); await toastText(page, /오픈을 기록/);
    }
    await page.goto(N.url); await page.waitForSelector('.np');
  }
  visited.push((await api('GET', N.P)).json.project.current_phase);
  check('novice: What\'s Next만으로 01 → 07', visited[visited.length - 1] === 'OPERATIONS', visited.join(' → '));
  // 07: guide CTA 인수 완료 처리 → dialog
  const gp = await page.textContent('.rg .btn--primary');
  check('novice 07 가이드 primary = 인수 완료 처리', /인수 완료 처리/.test(gp), gp);
  await page.click('.rg .btn--primary'); await page.waitForSelector('[data-handover-dialog]');
  await page.selectOption('#ho-r', `u:${uid}`); await page.click('[data-ho-ok]'); await toastText(page, /운영 인수를 기록/);
  await page.waitForFunction(() => /완료보고서/.test(document.querySelector('.rg .btn--primary')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const gp2 = await page.textContent('.rg .btn--primary');
  check('novice 07 다음 primary = 완료보고서 만들기', /완료보고서 만들기/.test(gp2), gp2);
  await page.click('.rg .btn--primary'); await page.waitForURL(/\/reports\/[0-9a-f-]+$/); await page.waitForSelector('#finalize');
  await page.click('#finalize'); await page.waitForSelector('.scrim .dialog'); await page.click('.scrim .dialog [data-v="1"]');
  await page.waitForSelector('[data-close-dialog]'); await page.click('[data-cl-ok]'); await page.waitForSelector('[data-closed]');
  const NG = (await api('GET', N.P)).json;
  check('novice 07 → 종료: 완료 · What\'s Next 종료 화면', NG.project.status === 'COMPLETED' && /프로젝트가 종료되었습니다/.test(await page.textContent('[data-closed]')));

  /* ---------- 375px ---------- */
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', storageState: await ctx.storageState(), isMobile: true });
  const mp = await m.newPage(); mp.on('pageerror', (e) => log('PAGEERROR(375)', e.message));
  const mcheck = async (n) => { const wd = await mp.evaluate(() => document.documentElement.scrollWidth); check(`375 ${n}: 가로 스크롤 없음`, wd <= 376, String(wd)); };
  await mp.goto(A.url); await mp.waitForSelector('[data-closed]');
  check('375 종료 후 What\'s Next primary 전체 폭', (await mp.$eval('[data-closed] .btn--primary', (e) => e.getBoundingClientRect().width)) > 300);
  await shot('m-01-closed-whatsnext-375.png', mp); await mcheck('종료 후 What\'s Next');
  await mp.goto(`${BASE}/app`); await mp.waitForSelector('.home'); await mp.click('.hdone summary');
  await shot('m-02-home-completed-375.png', mp); await mcheck('홈 완료 묶음');
  // a fresh 07 project for the two dialogs
  const M = await mkProject('모바일 확인용');
  await toPhase(M, ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE']);
  const mi = (await api('POST', `${M.P}/issues`, { title: '오픈 뒤 확인할 문제', severity: 'MEDIUM' })).json; const mIssue = mi.issue || mi.item || mi;
  await api('POST', `${M.P}/go-live`, { date: T, carryovers: [{ type: 'ISSUE', id: mIssue.id, note: '운영팀 확인' }] });
  await toPhase(M, ['OPERATIONS']);
  // phone (< 768px) = view mode (hive research/relai-mobile-spec.md): 인수 / 종료 dialogs are PC-only
  for (const q of ['handover', 'close']) {
    await mp.goto(`${M.url}?${q}=1`); await mp.waitForSelector('.np'); await mp.waitForTimeout(500);
    check(`375 ?${q}=1: dialog 없음 (PC에서) · PC 한 줄`, !(await mp.$('[data-handover-dialog], [data-close-dialog]')) && (await mp.$$('.pcline')).length === 1);
    await mcheck(`What's Next 07 (?${q}=1)`);
  }
  await shot('m-03-whatsnext-07-375.png', mp);

  /* ---------- migration 38 ---------- */
  if (DB) {
    check('migration 38 recorded', sql('SELECT COUNT(*) FROM schema_migrations WHERE version = 38') === '1' && Number(sql('SELECT MAX(version) FROM schema_migrations')) >= 38);
    check('migration 38: weekly_reports.report_type · 완료보고서 1건 unique index', sql(`SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'uq_weekly_reports_completion'`) === '1');
  }

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { log('FAILED:', failed.map(([n]) => n).join(' | ')); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
