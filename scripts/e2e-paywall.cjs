// batch7 T5 paywall browser check: a FREE limit hit inside the app (3rd project) opens the upsell dialog whose CTA routes to
// /app/billing/plans; AI with too few credits opens the same upsell; the plans page shows 무료 vs 유료 플랜, the limit table and the FAQ
// with Team 플랜 월 22,000원 (NicePay review product list); 구독하기 opens the card page whose submit only says '결제 준비 중입니다. 곧 오픈 예정이에요.' (no checkout call);
// 설정 › 플랜 links to the plans page; the landing pricing shows FREE = 2 projects and '가격 안내 예정'.
// Not part of `npm test` (needs a running server, Playwright and psql):
//   BASE=http://127.0.0.1:3595 SHOTS=research/relai-b7-t5 DATABASE_URL=postgres://… node scripts/e2e-paywall.cjs
//   server: PLAN_LIMITS unset (on), PAYMENTS_ENABLED unset (off), SAMPLE_PROJECTS=false, AI_ENABLED=true AI_PROVIDER=fake (no real AI)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3595';
const SHOTS = process.env.SHOTS || 'b7-t5-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const esc = (s) => String(s).replace(/'/g, "''");
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const SOON = '결제 준비 중입니다. 곧 오픈 예정이에요.';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const checkoutCalls = [];
  page.on('request', (r) => { if (/\/billing\/(checkout|orders)|\/credits\/checkout/.test(r.url())) checkoutCalls.push(r.url()); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  /** Calls the API through the app's own core/api.js, so the 402 → upsell mapping is what is exercised. */
  const viaApp = (method, url, body) => page.evaluate(async ([m, u, b]) => { const { api: call } = await import('/assets/core/api.js'); try { await call(m, u, b); return null; } catch (e) { return { status: e.status, code: e.code }; } }, [method, url, body]);
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n) });

  const email = `b7pw-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '플랜테스트', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${esc(email)}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const body = (name) => ({ name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-11-02', planned_end_date: '2027-03-31' });
  const p1 = (await api('POST', `/api/workspaces/${w}/projects`, body('첫 번째'))).json.project;
  check('2nd project allowed on FREE', (await api('POST', `/api/workspaces/${w}/projects`, body('두 번째'))).status === 201);

  /* ---------- 3rd project → upsell dialog → plans page ---------- */
  await page.goto(`${BASE}/app`); await page.waitForSelector('#main');
  const err = await viaApp('POST', `/api/workspaces/${w}/projects`, body('세 번째'));
  check('3rd project: 402 plan_limit_reached', err && err.status === 402 && err.code === 'plan_limit_reached', JSON.stringify(err));
  const dlg = page.locator('.dialog:has([data-upsell])');
  await dlg.waitFor({ timeout: 5000 }).catch(() => {});
  const title = await dlg.locator('#dlgT').textContent().catch(() => '');
  const text = await dlg.textContent().catch(() => '');
  check('upsell dialog: calm title', title.trim() === '무료 플랜 한도에 도달했어요', title);
  check('upsell dialog: usage line + data kept, no ₩', /진행 중 프로젝트: 2 \/ 2 사용 중/.test(text) && /그대로 있어요/.test(text) && !/₩/.test(text), text.replace(/\s+/g, ' ').slice(0, 200));
  await shot('t5-upsell-dialog.png');
  await dlg.locator('[data-v="1"]', { hasText: '플랜 살펴보기' }).click();
  await page.waitForSelector('#plans-page', { timeout: 5000 }).catch(() => {});
  check('CTA routes to /app/billing/plans', new URL(page.url()).pathname === '/app/billing/plans', page.url());

  /* ---------- plans page ---------- */
  const pt = await page.textContent('#main');
  check('plans page: 무료 vs 유료 플랜 cards', (await page.locator('.pl-card[data-plan="FREE"]').count()) === 1 && (await page.locator('.pl-card[data-plan="TEAM"]').count()) === 1);
  check('plans page: current plan = 무료', /현재 플랜/.test(await page.locator('.pl-card[data-plan="FREE"]').textContent()));
  check('plans page: Team 플랜 priced 월 22,000원 (부가세 포함) — NicePay review product list, no ₩ sign', /월 22,000원/.test(pt) && /부가세 포함/.test(pt) && !/₩/.test(pt));
  const rows = await page.$$eval('.pl-table tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim())));
  const row = (k) => rows.find((r) => r[0].startsWith(k)) || [];
  check('limit table: projects 2개 / 무제한', row('진행 중 프로젝트')[1] === '2개' && row('진행 중 프로젝트')[2] === '무제한', JSON.stringify(row('진행 중 프로젝트')));
  check('limit table: WBS 100개, 요구사항 50건, 주간보고 8건, 멤버 3명', row('WBS')[1] === '100개' && row('요구사항')[1] === '50건' && row('주간보고')[1] === '8건' && row('멤버')[1] === '3명');
  check('limit table: AI 크레딧 워크스페이스당 500 (1회)', /워크스페이스당 500 \(1회\)/.test(row('AI 크레딧')[1] || ''), JSON.stringify(row('AI 크레딧')));
  check('FAQ present (≥ 4 questions, data-kept answer)', (await page.locator('#pl-faq details').count()) >= 4 && /삭제되거나 읽기 전용으로 바뀌지 않아요/.test(pt));
  await shot('t5-plans.png');
  await page.click('#pl-subscribe');   // → card registration page; with payments off its submit only says 결제 준비 중
  await page.waitForSelector('#subscribe-page', { timeout: 5000 }).catch(() => {});
  await page.fill('#sub-number', '1234567890123456'); await page.selectOption('#sub-mm', '12'); await page.selectOption('#sub-yy', '29');
  await page.fill('#sub-id', '800101'); await page.fill('#sub-pw', '12'); await page.check('input[name=agree_recurring]'); await page.check('input[name=agree_pg]');
  await page.click('#sub-pay');
  const toast = await page.locator('.toast', { hasText: SOON }).first().textContent({ timeout: 3000 }).catch(() => '');
  check('구독하기 → card page → submit → 준비 중 message', toast.trim() === SOON, toast);
  await shot('t5-plans-subscribe.png');
  check('no checkout / NicePay call made', checkoutCalls.length === 0, JSON.stringify(checkoutCalls));

  /* ---------- AI with too few credits → same upsell ---------- */
  sql(`UPDATE workspace_credit_accounts SET balance = 5 WHERE workspace_id = '${esc(w)}'`);
  await page.goto(`${BASE}/app`); await page.waitForSelector('#main');
  const aerr = await viaApp('POST', `/api/workspaces/${w}/projects/${p1.id}/ai/ask`, { question: '진행 상황은?' });
  check('AI ask with 5 credits: 402 AI_CREDIT_INSUFFICIENT', aerr && aerr.status === 402 && aerr.code === 'AI_CREDIT_INSUFFICIENT', JSON.stringify(aerr));
  const adlg = page.locator('.dialog:has([data-upsell])');
  await adlg.waitFor({ timeout: 5000 }).catch(() => {});
  const at = await adlg.textContent().catch(() => '');
  check('credit upsell: title + CTA, no ₩', /AI 크레딧이 조금 모자라요/.test(at) && /플랜 살펴보기/.test(at) && !/₩/.test(at), at.replace(/\s+/g, ' ').slice(0, 160));
  await shot('t5-credit-upsell.png');
  await adlg.locator('[data-v="1"]').click();
  await page.waitForSelector('#plans-page', { timeout: 5000 }).catch(() => {});
  check('credit CTA routes to the plans page', new URL(page.url()).pathname === '/app/billing/plans');

  /* ---------- 설정 › 플랜 ---------- */
  await page.goto(`${BASE}/app/settings?tab=plan`); await page.waitForSelector('#billing');
  const bt = await page.textContent('#billing');
  check('settings: 무료 chip + 진행 중 프로젝트 2/2 + no 무제한', /무료/.test(bt) && /진행 중 프로젝트 2\/2/.test(bt) && !/무제한/.test(bt), bt.replace(/\s+/g, ' ').slice(0, 200));
  await page.click('#plans-link'); await page.waitForSelector('#plans-page', { timeout: 5000 }).catch(() => {});
  check('settings: 플랜 살펴보기 → plans page', new URL(page.url()).pathname === '/app/billing/plans');

  /* ---------- landing pricing aligned ---------- */
  await page.goto(`${BASE}/`); const lt = await page.textContent('#pricing').catch(async () => page.textContent('body'));
  check('landing: FREE 진행 중 프로젝트 2개 + 가격 안내 예정, no ₩0 / ₩20,000', /진행 중 프로젝트 2개/.test(lt) && /가격 안내 예정/.test(lt) && !/₩/.test(lt));

  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
