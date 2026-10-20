// batch7 T3 (#15 #16 #21) browser + API check on a local server with AI on against the OpenAI mock (server/test/openai-mock.js — no real AI call):
//   A. new project → the WBS shows the 6 fixed phase nodes (1..6) and the empty card; a node has no rename/delete; API rename → 409 system_node
//   B. 데이터 이관 switch (WBS ⋯ menu) → '4 데이터 이관', 구현 becomes 5; switch off with children → "하위 n건을 먼저 옮기세요"
//   C. an existing project (rows written the 737c631 way: 뼈대 groups + loose items, never listed by new code) → opened: same-name 뼈대 groups
//      adopted, banner "단계 밖 항목 n건" → 정리 미리보기 → 적용 → items under their nodes, banner gone
//   D. AI WBS planner review = full sheet (2560 and 1440 wide): one-line rows ≤ 40px, no horizontal scroll, phase heads with 근무일;
//      commit with 날짜 자동 배분 → every date a workday inside the project window, the WBS grid shows the same dates, '테스트' work under 시험
//   E. Overview 진척 편차 '이유 보기' lists the tasks behind the gap
//   DATABASE_URL=postgres://…/relai_e2e_b7 [SHOTS=research/relai-b7-t3] NODE_PATH=<dir with playwright> node scripts/e2e-batch7-wbs.cjs
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('DATABASE_URL (a disposable database) is required'); process.exit(2); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const { chromium } = require('playwright');
const results = [];
const check = (name, ok, extra = '') => { results.push([name, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startMock(mock) {
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => { const { status, json } = await mock.respond(JSON.parse(raw)); res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json)); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}
async function startServer(env) {
  const port = 3800 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATABASE_URL: DB, EMAIL_PROVIDER: 'fake', INTEGRATION_PROVIDER: 'fake', PLAN_LIMITS: 'off', SAMPLE_PROJECTS: 'false', SESSION_SECRET: 'e2e-b7-secret-0123456789abcdef', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/listening/.test(out); i++) await sleep(150);
  if (!/listening/.test(out)) { child.kill(); throw new Error(`server did not start:\n${out.slice(-800)}`); }
  return { child, base: `http://127.0.0.1:${port}`, log: () => out };
}
const client = (base) => {
  let cookie = '';
  const c = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch { /* none */ }
    return { status: r.status, json };
  };
  c.cookie = () => cookie;
  return c;
};
const isWorkday = (d, hol) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !hol.has(d); };

(async () => {
  const { openaiMock } = await import(path.join(ROOT, 'server/test/openai-mock.js'));
  const { HOLIDAYS_KR } = await import(path.join(ROOT, 'server/calendar/holidays-kr.js'));
  const { Client } = require(path.join(ROOT, 'node_modules/pg'));
  const pg = new Client({ connectionString: DB }); await pg.connect();
  const hol = new Map(HOLIDAYS_KR);
  const mock = openaiMock(); const mockSrv = await startMock(mock);
  const srv = await startServer({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-mock-not-real', AI_ENABLED: 'true', AI_MODEL: '', OPENAI_BASE_URL: `http://127.0.0.1:${mockSrv.address().port}/v1`, AI_INITIAL_TRIAL_CREDITS: '500', DEV_INITIAL_AI_CREDITS: '0', AI_USER_MINUTE_LIMIT: '0' });
  const c = client(srv.base);
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email: `b7-${Date.now()}@relai.test`, password: 'passw0rd!' });
  const W = s.json.workspaces[0].id;
  await pg.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [s.json.user.id]);
  await c('POST', `/api/workspaces/${W}/onboarding/product_tour/skip`, {});
  const mkProject = async (name, extra = {}) => { const p = (await c('POST', `/api/workspaces/${W}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-11-02', planned_end_date: '2027-03-31', data_migration: 'NO', ...extra })).json.project; return { p, P: `/api/workspaces/${W}/projects/${p.id}`, url: `${srv.base}/app/projects/${p.id}` }; };

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const [ck, cv] = c.cookie().split('='); await ctx.addCookies([{ name: ck, value: cv, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const shot = (n, o = {}) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${n}`, ...o }) : null);
  const rowsText = () => page.$$eval('.gtable--wbs tbody tr', (trs) => trs.map((tr) => [tr.querySelector('.wcode')?.textContent.trim(), tr.querySelector('.wtitle__t')?.textContent.trim()].join(' ')));
  try {
    /* ---------- A. new project ---------- */
    const A = await mkProject('계약 관리 시스템');
    await page.goto(`${A.url}/wbs`); await page.waitForSelector('.gtable--wbs tr.is-sys');
    const rowsA = await rowsText();
    check('A1 new project: 6 fixed nodes numbered 1..6', JSON.stringify(rowsA.slice(0, 6)) === JSON.stringify(['1 착수', '2 요구사항 정의', '3 분석·설계', '4 구현', '5 시험', '6 전환·오픈']), rowsA.join(' | '));
    check('A2 the empty card keeps WBS 뼈대 만들기 as the primary', await page.isVisible('#skel'));
    await shot('a-new-project-wbs.png');
    const dev = (await c('GET', `${A.P}/wbs`)).json.items.find((i) => i.system_key === 'PHASE:DEVELOPMENT');
    await page.hover(`tr:has(.wtitle__t:text-is("구현"))`); await page.click(`[data-rowmenu="${dev.id}"]`);
    const menu = await page.textContent('.amenu');
    check('A3 a fixed node menu has no 삭제 / 들여쓰기 / 복제', !/삭제|들여쓰기|복제/.test(menu) && /하위 작업 추가/.test(menu), menu);
    await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
    const r409 = await c('PATCH', `${A.P}/wbs/${dev.id}`, { title: '개발' });
    check('A4 API rename of a fixed node → 409 system_node', r409.status === 409 && r409.json.error.code === 'system_node');
    const del409 = await c('POST', `${A.P}/wbs/${dev.id}/archive`, {});
    check('A5 API delete of a fixed node → 409 system_node', del409.status === 409 && del409.json.error.code === 'system_node');
    // skeleton fills the nodes
    await page.click('#skel'); await page.click('.dialog .btn--primary'); await page.waitForSelector('.toast');
    await page.waitForTimeout(300);
    const afterSk = await rowsText();
    check('A6 뼈대 → tasks under the nodes (1.1 착수보고회, 3.x 설계), nothing new at the root', afterSk.includes('1.1 착수보고회') && afterSk.includes('3.2 화면 설계') && !afterSk.some((r) => /^7 /.test(r)), afterSk.slice(0, 12).join(' | '));
    await shot('a-skeleton-under-nodes.png');

    /* ---------- B. 데이터 이관 switch ---------- */
    const B = await mkProject('데이터 이관 프로젝트');
    await page.goto(`${B.url}/wbs`); await page.waitForSelector('.gtable--wbs tr.is-sys');
    await page.click('[data-tmore]').catch(() => {});
    await page.waitForSelector('#dm-sw', { state: 'attached' });
    await page.$eval('#dm-sw', (el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => [...document.querySelectorAll('.wtitle__t')].some((x) => x.textContent.trim() === '데이터 이관'));
    const rowsB = await rowsText();
    check('B1 switch on → 4 데이터 이관, 구현 is 5', rowsB.includes('4 데이터 이관') && rowsB.includes('5 구현'), rowsB.join(' | '));
    check('B2 project trait follows the switch (YES)', (await c('GET', B.P)).json.project.data_migration === 'YES');
    await shot('b-data-migration-on.png');
    const dmNode = (await c('GET', `${B.P}/wbs`)).json.items.find((i) => i.system_key === 'OPT:DATA_MIGRATION');
    await c('POST', `${B.P}/wbs`, { title: '매핑 정의', parent_id: dmNode.id });
    const off = await c('POST', `${B.P}/wbs/structure/data-migration`, { on: false });
    check('B3 switch off with a child → 409 "하위 1건을 먼저 옮기세요"', off.status === 409 && /하위 1건을 먼저 옮기세요/.test(off.json.error.message), JSON.stringify(off.json));

    /* ---------- C. existing project (737c631 rows) ---------- */
    const C = await mkProject('기존 프로젝트');
    const old = async (title, phase, skeleton, parent = null, type = 'SUMMARY') => {
      const r = await c('POST', `${C.P}/wbs`, { title, item_type: type, lifecycle_phase: phase, parent_id: parent });   // POST never creates nodes; only the list does
      if (skeleton) await pg.query(`INSERT INTO wbs_history (id, wbs_item_id, action_type, field_name, new_value) VALUES (gen_random_uuid()::text, $1, 'CREATED', 'source', '뼈대로 생성')`, [r.json.item.id]);
      return r.json.item;
    };
    const g1 = await old('분석·설계', 'ANALYSIS_DESIGN', true); await old('화면 설계', 'ANALYSIS_DESIGN', true, g1.id, 'TASK');
    const g2 = await old('구현', 'DEVELOPMENT', true); await old('로그인 개발', 'DEVELOPMENT', true, g2.id, 'TASK');
    const g3 = await old('안정화', 'TRANSITION_GO_LIVE', true); await old('오픈 후 안정화 지원', 'TRANSITION_GO_LIVE', true, g3.id, 'TASK');
    await old('통합 테스트 계획', null, false, null, 'TASK');
    const nodesBefore = Number((await pg.query('SELECT COUNT(*) n FROM wbs_items WHERE project_id = $1 AND system_key IS NOT NULL', [C.p.id])).rows[0].n);
    check('C0 before new code lists it: no fixed nodes (737c631 shape)', nodesBefore === 0);
    await page.goto(`${C.url}/wbs`); await page.waitForSelector('[data-tidy-banner]');
    const ad = (await pg.query('SELECT id, system_key FROM wbs_items WHERE id = ANY($1)', [[g1.id, g2.id, g3.id]])).rows;
    check('C1 adopted: 분석·설계 and 구현 groups became fixed nodes (same rows); 안정화 not', ad.find((r) => r.id === g1.id).system_key === 'PHASE:ANALYSIS_DESIGN' && ad.find((r) => r.id === g2.id).system_key === 'PHASE:DEVELOPMENT' && !ad.find((r) => r.id === g3.id).system_key);
    const banner = await page.textContent('[data-tidy-banner]');
    check('C2 banner: 단계 밖에 있는 항목 2건', /단계 밖에 있는 항목\s*2건/.test(banner), banner);
    await shot('c-existing-banner.png');
    await page.click('#tidy-open'); await page.waitForSelector('[data-tidy-dialog]');
    const sug = await page.$$eval('[data-tidy]', (xs) => xs.map((x) => x.value));
    check('C3 preview suggests 전환·오픈 for 안정화 and 시험 for 통합 테스트 계획', sug.includes('PHASE:TRANSITION_GO_LIVE') && sug.includes('PHASE:TESTING'), sug.join(','));
    await shot('c-tidy-preview.png');
    await page.click('[data-tidy-dialog] .btn--primary'); await page.waitForSelector('[data-tidy-banner]', { state: 'detached' });
    const tC = (await c('GET', `${C.P}/wbs`)).json;
    const testNode = tC.items.find((i) => i.system_key === 'PHASE:TESTING');
    check('C4 applied: 통합 테스트 계획 under 시험, outside 0, history 단계 구조 정리', tC.items.find((i) => i.title === '통합 테스트 계획').parent_id === testNode.id && tC.outside_count === 0);
    await shot('c-tidy-applied.png');

    /* ---------- D. AI planner sheet + dates ---------- */
    const D = await mkProject('한빛제약 챗봇');
    for (const t of ['로그인', '주문 조회', '결제', '배송 조회', '쿠폰', '알림']) await c('POST', `${D.P}/requirements`, { title: t, status: 'CONFIRMED', scope: 'IN_SCOPE' });
    const plan = (await c('POST', `${D.P}/ai/wbs-plans`, { all: true })).json.plan;
    const gen = await c('POST', `${D.P}/ai/wbs-plans/${plan.id}/generate`, {});
    check('D0 mock AI draft generated (phase in the strict schema)', gen.status === 200, JSON.stringify(gen.json).slice(0, 200));
    for (const [w, h, tag] of [[2560, 1440, '2560'], [1440, 900, '1440']]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${D.url}/wbs`); await page.waitForSelector('#ai-wbs-pc');
      await page.click('#ai-wbs-pc'); await page.waitForSelector('.dialog'); await page.click('.dialog .btn--primary:has-text("이어서 진행")');
      await page.waitForSelector('[data-wps] .wpr');
      const m = await page.evaluate(() => { const dlg = document.querySelector('.dialog--ai-sheet').getBoundingClientRect(); const tree = document.querySelector('.wps__tree');
        const rows = [...document.querySelectorAll('.wpr')]; return { dw: dlg.width, dh: dlg.height, sw: tree.scrollWidth, cw: tree.clientWidth, maxRow: Math.max(...rows.map((r) => r.getBoundingClientRect().height)), n: rows.length, heads: [...document.querySelectorAll('.wph__t')].map((x) => x.textContent.trim()) }; });
      check(`D1 ${tag}: sheet ${Math.round(m.dw)}×${Math.round(m.dh)} (≤1440 wide, viewport−48)`, m.dw <= 1440 && m.dw >= Math.min(1440, w - 48) - 1 && Math.abs(m.dh - (h - 48)) <= 2, JSON.stringify(m));
      check(`D2 ${tag}: ${m.n} one-line rows ≤ 40px, no horizontal scroll`, m.maxRow <= 40 && m.sw <= m.cw + 1, JSON.stringify(m));
      check(`D3 ${tag}: phase heads in RELAI order with 근무일`, m.heads[0] === '1 착수' && m.heads.includes('5 시험') && (await page.$$('[data-phase-days]')).length >= 6, m.heads.join(','));
      await page.click('.wpr >> nth=2'); await page.waitForSelector('.wps__f');
      await shot(`d-planner-sheet-${tag}.png`);
      await page.click('[data-close]').catch(() => {}); await page.waitForTimeout(200);
    }
    // commit through the UI with dates (1440)
    await page.goto(`${D.url}/wbs`); await page.waitForSelector('#ai-wbs-pc'); await page.click('#ai-wbs-pc'); await page.waitForSelector('.dialog .btn--primary:has-text("이어서 진행")'); await page.waitForTimeout(300);
    await page.click('.dialog .btn--primary:has-text("이어서 진행")'); await page.waitForSelector('[data-wps] .wpr');
    const sched = (await c('GET', `${D.P}/ai/wbs-plans/${plan.id}/schedule`)).json;
    check('D4 schedule basis = project window', sched.start === '2026-11-02' && sched.end === '2027-03-31');
    await page.click('#wp-cov'); await page.waitForSelector('#wp-commit'); await page.click('#wp-commit'); await page.locator('.dialog .btn--primary', { hasText: /^WBS에 반영$/ }).click();   // the confirm, not the sheet's 'WBS에 반영 (n건)'
    await page.waitForSelector('.dialog--ai-sheet', { state: 'detached' }); await page.waitForTimeout(400);
    const tD = (await c('GET', `${D.P}/wbs`)).json.items;
    const dated = tD.filter((i) => !i.is_system && (i.planned_start_date || i.milestone_date));
    const allDays = dated.flatMap((i) => [i.planned_start_date, i.planned_end_date, i.milestone_date].filter(Boolean));
    check(`D5 committed with dates: ${dated.length} items, every date a workday, last ≤ 2027-03-31`, dated.length > 5 && allDays.every((d) => isWorkday(d, hol) && d >= '2026-11-02' && d <= '2027-03-31'), allDays.filter((d) => !isWorkday(d, hol)).join(','));
    const tn = tD.find((i) => i.system_key === 'PHASE:TESTING'); const desc = (pid) => tD.filter((i) => { let x = i; while (x && x.parent_id) { if (x.parent_id === pid) return true; x = tD.find((y) => y.id === x.parent_id); } return false; });
    check("D6 '통합 테스트' work sits under 시험", desc(tn.id).some((i) => /통합 테스트/.test(i.title)));
    const one = dated.find((i) => i.item_type === 'TASK' && i.planned_start_date);
    await page.goto(`${D.url}/wbs?sel=${one.id}`); await page.waitForSelector('#drawer [data-field="planned_start_date"]');
    check('D7 the WBS drawer shows the same dates + n 근무일', (await page.inputValue('#drawer [data-field="planned_start_date"]')) === one.planned_start_date && /근무일/.test(await page.textContent('#drawer')));
    await shot('d-committed-wbs.png');
    await page.goto(`${D.url}/wbs?view=gantt`); await page.waitForSelector('.gantt'); await shot('d-committed-gantt.png');

    /* ---------- E. Overview 이유 보기 ---------- */
    const E = await mkProject('진척 편차 프로젝트');
    await c('POST', `${E.P}/wbs`, { title: '결제 연동 개발', planned_start_date: '2026-01-05', planned_end_date: '2026-01-30', progress: 20, status: 'IN_PROGRESS' });
    await c('POST', `${E.P}/wbs`, { title: '로그인 개발', planned_start_date: '2026-01-05', planned_end_date: '2026-01-16', progress: 100 });
    await page.goto(`${E.url}/overview`).catch(() => {}); await page.waitForSelector('[data-vwhy]', { timeout: 8000 }).catch(() => {});
    if (!(await page.$('[data-vwhy]'))) { await page.goto(`${E.url}`); await page.waitForSelector('[data-vwhy]', { timeout: 8000 }).catch(() => {}); }
    const has = await page.$('[data-vwhy] summary');
    if (has) { await has.click(); await page.waitForSelector('[data-vwhy] ol li'); }
    const why = has ? await page.textContent('[data-vwhy]') : '';
    check("E1 Overview '이유 보기' lists 결제 연동 개발 (계획 100% · 실제 20%)", /결제 연동 개발/.test(why) && /계획 100% · 실제 20%/.test(why), why.slice(0, 200));
    if (has) await shot('e-overview-why.png');
    check('no page errors', !errors.length, errors.join(' | '));
  } catch (e) { check('run', false, e.stack); }
  finally { await b.close(); srv.child.kill(); mockSrv.close(); await pg.end(); }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
