// AI on with OpenAI — end-to-end on a local server whose real OpenAI adapter talks to a mock api.openai.com (server/test/openai-mock.js).
// No real API call, no real key. Starts its own mock + server twice (AI on, then AI_ENABLED=false) on a disposable database:
//   DATABASE_URL=postgres://…/relai_e2e_ai [SHOTS=research/design/ai-on] [NODE_PATH=<dir with playwright>] node scripts/e2e-ai-on.cjs
// API part: every AI feature returns schema-valid output and charges its price (the mock answers 400 to a schema strict mode would reject); 429 / timeout / invalid JSON → Korean message,
// credits released; strict json_schema with gpt-4o-mini and a per-feature token cap on every call.
// Browser part (skipped with a note when Playwright cannot be loaded): every AI entry point is shown with AI on and hidden or
// disabled with AI off; a failed ask shows the Korean message. Not part of `npm test`.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('DATABASE_URL (a disposable database) is required'); process.exit(2); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let chromium = null; try { ({ chromium } = require('playwright')); } catch { /* browser part skipped */ }

const results = [];
const check = (name, ok, extra = '') => { results.push([name, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); };
const HANGUL = /[가-힣]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startMock(mock) {
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (req.url !== '/v1/chat/completions' || !/^Bearer sk-/.test(req.headers.authorization || '')) { res.writeHead(404).end('{}'); return; }
      const { status, json } = await mock.respond(JSON.parse(raw));
      if (!res.destroyed) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}
async function startServer(env) {
  const port = 3300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATABASE_URL: DB, EMAIL_PROVIDER: 'fake', INTEGRATION_PROVIDER: 'fake', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function seed(base, tag) {
  const c = client(base);
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email: `ai-${tag}-${Date.now()}@relai.test`, password: 'passw0rd!' });
  const W = s.json.workspaces[0].id;
  const P = (await c('POST', `/api/workspaces/${W}/projects`, { name: '한빛제약 챗봇', client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' })).json.project;
  const PP = `/api/workspaces/${W}/projects/${P.id}`;
  const reqs = []; for (const t of ['로그인', '주문 조회', '결제']) reqs.push((await c('POST', `${PP}/requirements`, { title: t, status: 'CONFIRMED', scope: 'IN_SCOPE' })).json.requirement);
  const cr = (await c('POST', `${PP}/changes`, { title: '결제 수단 추가' })).json.change;
  return { c, W, P, PP, reqs, cr };
}

async function browser(base, cookie, fn) {
  if (!chromium) return;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const [name, value] = cookie.split('='); const u = new URL(base);
  await ctx.addCookies([{ name, value, domain: u.hostname, path: '/' }]);
  const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  try { await fn(page); } finally { await b.close(); }
}
const shot = (page, n) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${n}`, fullPage: true }) : null);

(async () => {
  const { openaiMock } = await import(path.join(ROOT, 'server/test/openai-mock.js'));
  const { SCHEMAS, PLANNER_SCHEMAS, validateSchema } = await import(path.join(ROOT, 'server/ai/schemas.js'));
  const mock = openaiMock(); mock.hangMs = 5000;
  const mockSrv = await startMock(mock);
  const MOCK = `http://127.0.0.1:${mockSrv.address().port}/v1`;
  const AI_ENV = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-mock-not-real', AI_ENABLED: 'true', AI_MODEL: '', OPENAI_BASE_URL: MOCK, AI_REQUEST_TIMEOUT_MS: '2000', AI_INITIAL_TRIAL_CREDITS: '500', DEV_INITIAL_AI_CREDITS: '0', AI_USER_MINUTE_LIMIT: '0' };   // the script makes more than 10 calls a minute

  /* ---------- 1. AI on ---------- */
  let srv = await startServer(AI_ENV);
  try {
    const { c, W, P, PP, reqs, cr } = await seed(srv.base, 'on');
    const st = (await c('GET', `${PP}/ai/status`)).json;
    check('status: enabled, provider openai, model gpt-4o-mini, starter 500 credits', st.enabled === true && st.provider === 'openai' && st.model === 'gpt-4o-mini' && st.credits?.available === 500, JSON.stringify(st));
    const bal = async () => (await c('GET', `${PP}/ai/status`)).json.credits.available;
    const feature = async (label, cost, schema, call, ok = 200) => {
      const before = await bal(); mock.calls = [];
      const r = await call(); const after = await bal(); const sent = mock.calls.at(-1) || {};
      check(`${label}: ${ok}`, r.status === ok, JSON.stringify(r.json?.error || ''));
      check(`${label}: mock output valid per schemas.js`, validateSchema(schema, mock.lastData).length === 0);
      check(`${label}: gpt-4o-mini, token cap ${sent.max_completion_tokens}`, sent.model === 'gpt-4o-mini' && sent.max_completion_tokens > 0 && sent.max_completion_tokens <= 8000);
      check(`${label}: charged ${cost} credits`, before - after === cost, `${before} → ${after}`);
      return r.json;
    };
    await feature('AI 요구사항 추출', 30, SCHEMAS.REQUIREMENT_EXTRACTION, () => c('POST', `${PP}/ai/requirements/extract`, { text: '회원은 이메일로 로그인할 수 있어야 한다. 관리자는 권한을 부여할 수 있어야 한다.' }));
    await feature('AI WBS 초안', 50, SCHEMAS.WBS_GENERATION, () => c('POST', `${PP}/ai/wbs/generate`, { requirement_ids: reqs.map((x) => x.id) }));
    await feature('AI 영향 분석', 20, SCHEMAS.CHANGE_IMPACT, () => c('POST', `${PP}/changes/${cr.id}/ai/impact`, {}));
    await feature('RELAI에게 물어보기', 10, SCHEMAS.PROJECT_QA, () => c('POST', `${PP}/ai/ask`, { question: '이번 주 확인할 일은?' }));
    const plan = (await feature('AI WBS Planner 질문 (무과금)', 0, PLANNER_SCHEMAS.wbs_planning_questions, () => c('POST', `${PP}/ai/wbs-plans`, { all: true }), 201)).plan;
    await feature('AI WBS Planner 초안', 50, PLANNER_SCHEMAS.project_wbs_draft, () => c('POST', `${PP}/ai/wbs-plans/${plan.id}/generate`, {}));

    // 보완 (gap-fix): parentless candidates with clumsy titles → placed under the matching area node, titles tidied (prod-test defect 3)
    const drafted = (await c('GET', `${PP}/ai/wbs-plans/${plan.id}`)).json?.plan;
    const reqItem = drafted?.draft?.items.find((i) => (i.related_requirement_ids || []).length);
    await c('POST', `${PP}/ai/wbs-plans/${plan.id}/coverage`, { items: [{ temp_id: reqItem.temp_id, selected: false }] });   // leaves one requirement uncovered → fix allowed
    const fixItem = (temp_id, title, project_area, related = []) => ({ temp_id, parent_temp_id: null, item_type: 'TASK', title, description: '', project_area, planned_duration_days: null, related_requirement_ids: related });
    mock.transform = (name, data) => (name === 'wbs_plan_fix' ? { items: [fixItem('AI-FIX-1', '[보완] 성능 테스트 테스트', 'TESTING'), fixItem('AI-FIX-2', '기능 구현: 결제 요구사항 요구사항 구현', 'FUNCTIONAL_DEVELOPMENT', reqItem.related_requirement_ids)], notes: [] } : data);
    const fx = await c('POST', `${PP}/ai/wbs-plans/${plan.id}/fix`, {}); mock.transform = null;
    const fItems = fx.json?.plan?.draft?.items || []; const fBy = Object.fromEntries(fItems.map((i) => [i.temp_id, i])); const titleOf = (t) => fBy[t]?.title;
    check('AI WBS Planner 보완: 200, free', fx.status === 200 && fx.json?.run?.credit_cost === 0, JSON.stringify(fx.json?.error || ''));
    check('AI WBS Planner 보완: testing item under 테스트, clean title "성능 테스트"', titleOf(fBy['AI-FIX-1']?.parent_temp_id) === '테스트' && titleOf('AI-FIX-1') === '성능 테스트', JSON.stringify(fBy['AI-FIX-1']));
    check('AI WBS Planner 보완: requirement item under 기능 개발, clean title', titleOf(fBy['AI-FIX-2']?.parent_temp_id) === '기능 개발' && titleOf('AI-FIX-2') === '결제 요구사항 구현', JSON.stringify(fBy['AI-FIX-2']));
    check('AI WBS Planner 보완: no fix item at top level', fItems.filter((i) => i.fix && !i.parent_temp_id).length === 0);

    for (const [label, script, code, http] of [['429 (twice)', ['429', '429'], 'AI_PROVIDER_ERROR', 502], ['timeout', ['hang'], 'AI_TIMEOUT', 504], ['invalid JSON (twice)', ['invalid_json', 'invalid_json'], 'AI_INVALID_OUTPUT', 502]]) {
      const before = await bal(); mock.script = [...script];
      const r = await c('POST', `${PP}/ai/ask`, { question: '실패 확인' });
      const msg = r.json?.error?.message || '';
      check(`${label}: ${http} ${code}`, r.status === http && r.json?.error?.code === code, JSON.stringify(r.json));
      check(`${label}: Korean message, no vendor text ("${msg}")`, HANGUL.test(msg) && !/org-|Rate limit|schema/i.test(msg));
      check(`${label}: credits released`, (await bal()) === before);
      mock.script = [];
    }
    const sum = (await c('GET', `/api/workspaces/${W}/credits/summary`)).json?.credits;
    check('AI 크레딧 dashboard: ai_enabled true, 160 used this month', sum?.ai_enabled === true && sum?.this_month?.used === 160, JSON.stringify({ ai: sum?.ai_enabled, used: sum?.this_month?.used }));
    check('server log has no prompt text or key', !/실패 확인|이번 주 확인할 일은|sk-mock-not-real/.test(srv.log()));

    await browser(srv.base, c.cookie(), async (page) => {
      const go = async (p, sel) => { await page.goto(srv.base + p); await page.waitForSelector(sel, { state: 'attached', timeout: 10000 }).catch(() => null); };
      await go(`/app/projects/${P.id}/requirements`, '#ai-extract');
      check('UI 요구사항: AI로 요구사항 추출 shown', await page.$('#ai-extract')); await shot(page, 'on-requirements.png');
      await go(`/app/projects/${P.id}/wbs`, '#ai-wbs, #ai-wbs2');
      check('UI WBS: AI로 WBS 만들기 / AI 초안 shown and enabled', await page.$$eval('#ai-wbs, #ai-wbs2', (bs) => bs.length > 0 && bs.every((b) => !b.disabled))); await shot(page, 'on-wbs.png');
      await go(`/app/projects/${P.id}/changes?sel=${cr.id}`, '#ai-impact');
      check('UI 변경: AI 영향 분석 shown', await page.$('#ai-impact')); await shot(page, 'on-changes.png');
      await go(`/app/projects/${P.id}/requirements`, '[data-ai-ask]');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-ai-ask]')].some((b) => !b.hidden), null, { timeout: 8000 }).catch(() => null);
      check('UI header: RELAI에게 물어보기 shown', await page.$$eval('[data-ai-ask]', (bs) => bs.some((b) => !b.hidden)));
      await page.click('[data-ai-ask]:not([hidden])');
      await page.fill('#ai-q', '이번 주 확인할 일은?'); await page.click('#ai-send');
      await page.waitForFunction(() => /확인할 항목|특별히 확인할/.test(document.querySelector('.aipanel')?.textContent || ''), null, { timeout: 10000 }).catch(() => null);
      check('UI ask: answer shown', /확인할 항목|특별히 확인할/.test(await page.textContent('.aipanel').catch(() => '')));
      mock.script = ['429', '429'];
      await page.fill('#ai-q', '실패 확인'); await page.click('#ai-send');
      await page.waitForFunction(() => /크레딧은 차감되지 않았습니다/.test(document.body.textContent), null, { timeout: 10000 }).catch(() => null);
      check('UI ask failure: Korean message + "크레딧은 차감되지 않았습니다"', /잠시 후 다시 시도해 주세요\.? ?크레딧은 차감되지 않았습니다/.test(await page.textContent('body')));
      await shot(page, 'on-ask-429.png'); mock.script = [];
      // WBS Planner resume dialog (prod-test defect 2): backdrop / Esc only close; discarding needs 새로 시작 + a confirm
      const activeId = async () => (await c('GET', `${PP}/ai/wbs-plans`)).json?.active?.id || null;
      const openPlanner = async () => { await go(`/app/projects/${P.id}/wbs`, '#ai-wbs, #ai-wbs2'); await page.evaluate(() => document.querySelector('#ai-wbs, #ai-wbs2').click()); await page.waitForSelector('#dlgT', { timeout: 8000 }).catch(() => null); };
      const dlgTitle = () => page.textContent('#dlgT').catch(() => '');
      await openPlanner();
      check('UI planner: resume dialog shown for the active plan', /진행 중인 AI WBS 초안/.test(await dlgTitle()));
      await shot(page, 'on-planner-resume.png');
      await page.mouse.click(5, 5); await sleep(400);
      check('UI planner: backdrop click closes the dialog and the planner', !(await page.$('#dlgT')) && !(await page.$('.dialog--ai-xl')));
      check('UI planner: backdrop click keeps the paid plan', (await activeId()) === plan.id);
      await openPlanner(); await page.keyboard.press('Escape'); await sleep(400);
      check('UI planner: Esc keeps the plan too', !(await page.$('#dlgT')) && (await activeId()) === plan.id);
      // default pick: 확정 + 작성 중 (AI-extracted), not 반려 / 범위 외 (prod-test defect 1)
      for (const [title, status, scope] of [['AI 추출 요구사항', 'DRAFT', 'UNDECIDED'], ['반려된 요구사항', 'REJECTED', 'UNDECIDED'], ['범위 외 요구사항', 'DRAFT', 'OUT_OF_SCOPE']]) await c('POST', `${PP}/requirements`, { title, status, scope });
      await openPlanner();
      await page.click('.dialog [data-v="0"]'); await page.waitForFunction(() => /새로 시작할까요/.test(document.querySelector('#dlgT')?.textContent || ''), null, { timeout: 5000 }).catch(() => null);
      check('UI planner: 새로 시작 asks for a second confirm', /기존 초안을 취소하고 새로 시작할까요/.test(await dlgTitle()));
      await shot(page, 'on-planner-discard-confirm.png');
      await page.click('.dialog [data-v="0"]'); await sleep(300);
      check('UI planner: 돌아가기 returns to the resume dialog, plan kept', /진행 중인 AI WBS 초안/.test(await dlgTitle()) && (await activeId()) === plan.id);
      await page.click('.dialog [data-v="0"]'); await page.waitForFunction(() => /새로 시작할까요/.test(document.querySelector('#dlgT')?.textContent || ''), null, { timeout: 5000 }).catch(() => null);
      await page.click('.dialog [data-v="1"]'); await page.waitForSelector('#wp-count', { timeout: 8000 }).catch(() => null);
      check('UI planner: confirmed 새로 시작 cancels the plan', (await activeId()) === null);
      const pickState = await page.$$eval('#wp-list .pick', (ps) => ps.map((p) => [p.querySelector('.pick__t').textContent, p.querySelector('input').checked]));
      const on = Object.fromEntries(pickState);
      check('UI planner: CONFIRMED + DRAFT pre-selected, REJECTED / OUT_OF_SCOPE not', on['로그인'] && on['AI 추출 요구사항'] && !on['반려된 요구사항'] && !on['범위 외 요구사항'], JSON.stringify(pickState));
      check('UI planner: selection count shown ("4 / 6건 선택")', /4 \/ 6건 선택/.test(await page.textContent('#wp-count').catch(() => '')) && /요구사항 4건을 기본으로 선택/.test(await page.textContent('#wp-default').catch(() => '')));
      await page.click('#wp-list .pick:has-text("반려된 요구사항") input'); await sleep(150);
      check('UI planner: count follows the selection', /5 \/ 6건 선택/.test(await page.textContent('#wp-count').catch(() => '')));
      await shot(page, 'on-planner-pick.png');
      await page.goto(srv.base + '/app/settings/credits'); await page.waitForSelector('#cr-summary', { timeout: 8000 }).catch(() => null);
      check('UI AI 크레딧: no "AI 기능 준비 중" notice', !(await page.$('[data-ai-off]'))); await shot(page, 'on-credits.png');
    });
  } finally { srv.child.kill(); }

  /* ---------- 2. AI off ---------- */
  srv = await startServer({ ...AI_ENV, AI_ENABLED: 'false' });
  try {
    const { c, P, PP, cr } = await seed(srv.base, 'off');
    mock.calls = [];
    const st = (await c('GET', `${PP}/ai/status`)).json;
    check('AI off: status enabled false, no provider/model', st.enabled === false && st.provider === null && st.model === null);
    const r = await c('POST', `${PP}/ai/ask`, { question: '안녕' });
    check('AI off: ask 503 AI_DISABLED in Korean, provider never called', r.status === 503 && r.json?.error?.code === 'AI_DISABLED' && HANGUL.test(r.json.error.message) && mock.calls.length === 0);
    await browser(srv.base, c.cookie(), async (page) => {
      await page.goto(`${srv.base}/app/projects/${P.id}/requirements`); await page.waitForSelector('#main .page__head, #main h1', { timeout: 10000 }).catch(() => null); await sleep(800);
      check('AI off UI 요구사항: no AI 추출 entry', !(await page.$('#ai-extract')) && !(await page.$('#ai-extract2')));
      check('AI off UI header: RELAI에게 물어보기 hidden', await page.$$eval('[data-ai-ask]', (bs) => bs.every((b) => b.hidden)));
      await page.goto(`${srv.base}/app/projects/${P.id}/wbs`); await page.waitForSelector('#main .wempty, #main .page__head', { timeout: 10000 }).catch(() => null); await sleep(800);
      check('AI off UI WBS: no usable AI button (disabled or "사용 불가")', await page.$$eval('#ai-wbs, #ai-wbs2', (bs) => bs.every((b) => b.disabled)) && /사용 불가|AI 기능이 설정되지 않았습니다/.test(await page.innerHTML('#main')));
      await page.goto(`${srv.base}/app/projects/${P.id}/changes?sel=${cr.id}`); await sleep(1500);
      check('AI off UI 변경: no AI 영향 분석', !(await page.$('#ai-impact'))); await shot(page, 'off-changes.png');
      await page.goto(srv.base + '/app/settings/credits'); await page.waitForSelector('#cr-summary', { timeout: 8000 }).catch(() => null);
      check('AI off UI AI 크레딧: packs closed (data-ai-off or payments off), no 충전 button', !(await page.$('[data-pack]')) && !(await page.$('#cr-buy-top')));
    });
  } finally { srv.child.kill(); mockSrv.close(); }

  if (!chromium) console.log('NOTE browser part skipped: Playwright not found (set NODE_PATH to a folder with playwright)');
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
