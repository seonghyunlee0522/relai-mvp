// AI-credits-only billing browser check (AC3–AC9 on the fake billing provider + fake AI autoreply — no real payment or refund):
// starter credits on Home / settings / 설정 › AI 크레딧, price line in the 4 AI entry points, exact charge, pack purchase through the
// signed fake webhook (replay, tamper), dashboard filters + CSV, amber low balance, disabled AI at 0 with [크레딧 충전], operator refund,
// member read-only view, 375px. Not part of `npm test` (needs a running server + Playwright + psql):
//   BASE=http://127.0.0.1:3121 SHOTS=research/design/credits DATABASE_URL=postgres://… FAKE_BILLING_SECRET=… node scripts/e2e-credits.cjs
//   server: BILLING_PROVIDER=fake AI_PROVIDER=fake AI_FAKE_AUTOREPLY=1 AI_ENABLED=true EMAIL_PROVIDER=fake SUPPORT_EMAIL=…
const fs = require('fs');
const { createHmac, randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3121';
const SHOTS = process.env.SHOTS || 'credits-shots';
const DB = process.env.DATABASE_URL;
const SECRET = process.env.FAKE_BILLING_SECRET || 'fake-billing-secret';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const q = (s) => String(s).replace(/'/g, "''");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body, c = page) => { const r = await c.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const hook = async (type, data, id = `evt_${randomUUID()}`) => {
    const body = JSON.stringify({ id, type, data });
    const r = await page.request.fetch(`${BASE}/api/billing/webhook/fake`, { method: 'POST', data: body, headers: { 'Content-Type': 'application/json', 'x-fake-signature': createHmac('sha256', SECRET).update(body).digest('hex') } });
    return { id, body, json: await r.json() };
  };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}`, fullPage: true });
  const text = (sel) => page.textContent(sel, { timeout: 6000 }).catch(() => '');

  // fresh owner (verified e-mail so packs can be bought), one project with requirements, one CR
  const email = `cr-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email, password: 'passw0rd!' });
  const W = s.json.workspaces[0].id; const UID = s.json.user.id;
  sql(`UPDATE users SET email_verified_at = now() WHERE id = '${q(UID)}'`);
  const P = (await api('POST', `/api/workspaces/${W}/projects`, { name: '한빛제약 챗봇', client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' })).json.project;
  const PP = `/api/workspaces/${W}/projects/${P.id}`;
  for (const t of ['로그인', '주문 조회', '결제']) await api('POST', `${PP}/requirements`, { title: t });
  const cr = (await api('POST', `${PP}/changes`, { title: '결제 수단 추가' })).json.change;
  const CR = `/api/workspaces/${W}/credits`;

  // Q21-2: server with AI off (AI_OFF=1 run: AI_ENABLED=false or no AI_PROVIDER) → no pack is sold; the dashboard, ledger and CSV stay
  if (process.env.AI_OFF === '1') {
    check('AI off: /ai/status enabled:false', (await api('GET', `${PP}/ai/status`)).json?.enabled === false);
    await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-summary', { timeout: 8000 });
    const off = await text('[data-ai-off]');
    check('AI off: 충전 panel says "AI 기능 준비 중입니다. 충전은 AI가 켜지면 열립니다."', off.trim() === 'AI 기능 준비 중입니다. 충전은 AI가 켜지면 열립니다.', off);
    check('AI off: no pack buttons, no top 크레딧 충전 button', !(await page.$('[data-pack]')) && !(await page.$('#cr-buy-top')));
    check('AI off: dashboard + ledger still shown (잔액 500, +500 row)', /500 크레딧/.test(await text('#cr-balance')) && Boolean(await page.$('#cr-log tbody tr')));
    const co = await api('POST', `${CR}/checkout`, { pack: 'P10' });
    check('AI off: checkout 409 ai_disabled "AI 기능 준비 중에는 크레딧을 충전할 수 없습니다."', co.status === 409 && co.json?.error?.code === 'ai_disabled' && co.json.error.message === 'AI 기능 준비 중에는 크레딧을 충전할 수 없습니다.', JSON.stringify(co.json));
    check('AI off: no CREDIT_PACK order created', sql(`SELECT count(*) FROM billing_orders WHERE workspace_id = '${q(W)}' AND kind = 'CREDIT_PACK'`) === '0');
    const csv = await page.request.fetch(`${BASE}${CR}/ledger.csv`); check('AI off: ledger CSV 200', csv.status() === 200);
    await shot('00-ai-off.png');
    await browser.close();
    const fails = results.filter(([, ok]) => !ok); log(`\n${results.length - fails.length}/${results.length} passed`);
    process.exit(fails.length ? 1 : 0);
  }
  check('AI on: credits summary ai_enabled:true (packs on sale)', (await api('GET', `${CR}/summary`)).json?.credits?.ai_enabled === true);

  // starter credits + early access visible on Home, settings, and the AI 크레딧 page (founder: show the free starter credits clearly)
  await page.goto(BASE + '/app'); await page.waitForSelector('#home-credits a', { timeout: 8000 }).catch(() => {});
  const home = await text('#home-credits');
  check('Home: AI 크레딧 500 (₩5,000) 무료 제공 + 얼리 액세스', /AI 크레딧 500 \(₩5,000\) 무료 제공/.test(home) && /얼리 액세스 \d{4}\.\d{2}\.\d{2}까지 무료/.test(home), home);
  await shot('01-home.png');
  await page.goto(BASE + '/app/settings'); await page.waitForSelector('#billing', { timeout: 8000 });
  const plan = await text('#billing .panel__h');
  check('AC1 settings: 플랜 = 얼리 액세스 · <date>까지, no Team 구매 form', /얼리 액세스 · \d{4}\.\d{2}\.\d{2}까지/.test(plan) && !(await page.$('#bill-buy')), plan);
  check('settings: AI 크레딧 panel (잔액 500 크레딧 (₩5,000))', /잔액 500 크레딧 \(₩5,000\)/.test(await text('#ai-credits')));
  await shot('02-settings.png');
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-summary', { timeout: 8000 });
  check('AC2 credits page: balance 500 (₩5,000) = 무료 500', /500 크레딧/.test(await text('#cr-balance')) && /구매 0 · 무료 500/.test(await text('#cr-summary')));
  check('credits page: 무료 시작 크레딧 500 크레딧 (₩5,000) callout', /무료 시작 크레딧 500 크레딧 \(₩5,000\)/.test(await text('.cr-gift')));
  const priceTbl = await text('.cr-price');
  check('AC3 price table: 30/₩300 · 50/₩500 · 20/₩200 · 10/₩100', ['요구사항 추출30₩300', 'WBS 초안50₩500', '영향 분석20₩200', 'RELAI에게 물어보기10₩100'].every((x) => priceTbl.replace(/\s+/g, '').includes(x.replace(/\s+/g, ''))), priceTbl.replace(/\s+/g, ' '));
  await shot('03-credits-start.png');

  // AC3: price line before each of the 4 AI entry points (starter 500 is above the 200 low-balance line, so no amber yet)
  const line = async () => (await text('.ai-credit')).replace(/\s+/g, ' ').trim();
  await page.goto(`${BASE}/app/projects/${P.id}/requirements`); await page.click('#ai-extract', { timeout: 8000 });
  await page.waitForSelector('.dialog--ai .ai-credit');
  let l = await line(); check('AC3 요구사항 추출: 예상 30 크레딧 (₩300) · 잔액 500 크레딧', l === '예상 30 크레딧 (₩300) · 잔액 500 크레딧', l);
  await shot('04-extract-price.png');
  // AC4: run it → exactly 30
  await page.fill('.dialog--ai textarea', '회의록: 로그인, 주문 조회, 결제 기능이 필요합니다. 관리자는 주문을 엑셀로 내려받을 수 있어야 합니다.');
  await page.click('#ai-run'); await page.waitForSelector('.aid__sum', { timeout: 15000 }).catch(() => {});
  const sum = await text('.aid__sum');
  check('AC4 extraction charged 30 크레딧 (₩300), 잔액 470', /30 크레딧 \(₩300\) 사용 · 잔액 470/.test(sum), sum);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/app/projects/${P.id}/wbs`); await page.locator('#ai-wbs2, #ai-wbs:visible').first().click({ timeout: 8000 }); await page.waitForSelector('.dialog--ai .ai-credit');
  l = await line(); check('AC3 WBS 초안: 예상 50 크레딧 (₩500) · 잔액 470 크레딧', l.startsWith('예상 50 크레딧 (₩500) · 잔액 470 크레딧'), l);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/app/projects/${P.id}/changes`); await page.click(`[data-row="${cr.id}"]`, { timeout: 8000 }); await page.click('#ai-impact', { timeout: 8000 }); await page.waitForSelector('.dialog--ai .ai-credit');
  l = await line(); check('AC3 영향 분석: 예상 20 크레딧 (₩200) · 잔액 470 크레딧', l.startsWith('예상 20 크레딧 (₩200) · 잔액 470 크레딧'), l);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/app/projects/${P.id}`); await page.waitForSelector('[data-ai-ask]:not([hidden])', { timeout: 8000 }).catch(() => {});
  await page.click('[data-ai-ask]', { timeout: 8000 }).catch((e) => log('ask', e.message.split('\n')[0]));
  await page.waitForSelector('.aipanel__meta .ai-credit', { timeout: 8000 }).catch(() => {});
  l = await line(); check('AC3 RELAI에게 물어보기: 예상 10 크레딧 (₩100) · 잔액 470 크레딧', l.startsWith('예상 10 크레딧 (₩100) · 잔액 470 크레딧'), l);
  await shot('05-ask-price.png');
  const ask = await api('POST', `${PP}/ai/ask`, { question: '이번 주 할 일은?' });
  check('AC4 question charged exactly 10 (balance 460)', ask.status === 200 && ask.json.run.credit_cost === 10 && ask.json.run.balance === 460);

  // AC5: buy ₩10,000 through the pack button (fake checkout) → signed paid webhook → +1,000 with receipt
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('[data-pack="P10"]', { timeout: 8000 });
  await page.click('[data-pack="P10"]'); await page.waitForURL(/checkout=fake|\/app\/settings\/credits/, { timeout: 8000 }).catch(() => {});
  const ord = sql(`SELECT id || '|' || amount || '|' || supply_amount || '|' || vat_amount || '|' || credits FROM billing_orders WHERE workspace_id = '${q(W)}' AND kind = 'CREDIT_PACK' ORDER BY created_at DESC LIMIT 1`).split('|');
  check('AC5 order: ₩10,000 = 9,091 + 909, 1,000 credits', ord[1] === '10000' && ord[2] === '9091' && ord[3] === '909' && ord[4] === '1000', ord.join(' '));
  const paid = await hook('subscription.activated', { order_id: ord[0], payment: { amount: 10000, currency: 'KRW', status: 'PAID', provider_tid: `tid_${ord[0]}`, moid: ord[0], receipt_url: `https://npg.nicepay.co.kr/issue/IssueLoader.do?TID=tid_${ord[0]}` } });
  check('AC5 paid webhook → +1,000 credits', paid.json.credits === 1000, JSON.stringify(paid.json));
  const replay = await page.request.fetch(`${BASE}/api/billing/webhook/fake`, { method: 'POST', data: paid.body, headers: { 'Content-Type': 'application/json', 'x-fake-signature': createHmac('sha256', SECRET).update(paid.body).digest('hex') } });
  check('AC5 replayed webhook adds nothing', (await replay.json()).duplicate === true);
  const co2 = await api('POST', `${CR}/checkout`, { pack: 'P30' });
  const tam = await hook('subscription.activated', { order_id: co2.json.order.id, payment: { amount: 3000, status: 'PAID', provider_tid: `tid_t_${Date.now()}` } });
  check('AC5 tampered amount refused (amount_mismatch, no credits)', tam.json.reason === 'amount_mismatch');
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-summary');
  check('credits page after purchase: 1,460 크레딧 (₩14,600) · 구매 1,000 · 무료 460', /1,460 크레딧/.test(await text('#cr-balance')) && /₩14,600/.test(await text('#cr-summary')) && /구매 1,000 · 무료 460/.test(await text('#cr-summary')));
  const firstRow = await text('.cr-log tbody tr:first-child');
  check('AC5 ledger: 충전 ₩10,000 row with 영수증 link, +1,000', /충전 ₩10,000/.test(firstRow) && /영수증/.test(firstRow) && /\+1,000/.test(firstRow), firstRow.replace(/\s+/g, ' '));
  await shot('06-credits-after-purchase.png');

  // AC7: filters + CSV, as a member sees it too (read-only)
  const mEmail = `crm-${Date.now()}@relai.test`;
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true }); const mp = await mctx.newPage();
  await mp.goto(BASE + '/login'); const ms = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '이수진', email: mEmail, password: 'passw0rd!' }, mp);
  await api('POST', `/api/workspaces/${W}/members`, { email: mEmail, role: 'MEMBER' });
  await mp.evaluate((w) => localStorage.setItem('relai.ws', w), W).catch(() => {});
  const mAsk = await api('POST', `${PP}/ai/ask`, { question: '멤버 질문입니다' }, mp);
  check('member can use AI from the shared wallet', mAsk.status === 200 && mAsk.json.run.credit_cost === 10, String(mAsk.status));
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('.cr-filt');
  const tot = async () => (await text('#cr-total')).replace(/\s+/g, ' ');
  check('AC7 month total: AI 사용 50 크레딧 (₩500)', /AI 사용 50 크레딧 \(₩500\)/.test(await tot()), await tot());
  await page.selectOption('.cr-filt select[name="user"]', ms.json.user.id); await page.waitForTimeout(500);
  check('AC7 user filter → 10 크레딧 (₩100)', /AI 사용 10 크레딧 \(₩100\)/.test(await tot()), await tot());
  await page.selectOption('.cr-filt select[name="user"]', ''); await page.selectOption('.cr-filt select[name="project"]', P.id); await page.waitForTimeout(500);
  check('AC7 project filter → 50 크레딧', /AI 사용 50 크레딧/.test(await tot()), await tot());
  await page.selectOption('.cr-filt select[name="project"]', ''); await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#cr-csv')]);
  const buf = fs.readFileSync(await dl.path());
  const csv = buf.toString('utf8');
  check('AC7 CSV: UTF-8 BOM + Korean header + total row = page total (−50 / −500)', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF && csv.includes('일시,구분,프로젝트,사용자,크레딧,금액(원)') && /합계 \(AI 사용\),,,,-50,-500/.test(csv), csv.split('\r\n').slice(-2).join(' | '));
  fs.writeFileSync(`${SHOTS}/statement.csv`, buf);
  await mp.goto(BASE + '/app/settings/credits'); await mp.waitForSelector('#cr-summary', { timeout: 8000 }).catch(() => {});
  check('member view: whole page readable, no pack buttons, owner-only note', !(await mp.$('[data-pack]')) && /소유자/.test(await mp.textContent('#cr-buy').catch(() => '')));
  await mp.screenshot({ path: `${SHOTS}/07-member-view.png`, fullPage: true });

  // AC8: amber below 200 (AI_LOW_BALANCE_CREDITS default) (operator adjustment through the Admin API, ledger kept consistent)
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = '${q(UID)}'`);
  const bal = () => Number(sql(`SELECT balance FROM workspace_credit_accounts WHERE workspace_id = '${q(W)}'`));
  await api('POST', `/api/admin/workspaces/${W}/ai/credits`, { amount: -(bal() - 195), reason: 'e2e: low balance' });
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-summary');
  check('AC8 page amber under 200', Boolean(await page.$('.cr-sum.is-low')) && /아래입니다/.test(await text('.cr-warn')));
  await shot('08-low-balance.png');
  await page.goto(`${BASE}/app/projects/${P.id}/requirements`); await page.click('#ai-extract'); await page.waitForSelector('.dialog--ai .ai-credit');
  check('AC8 AI cost line amber + 충전 link', Boolean(await page.$('.ai-credit.is-low')) && /충전/.test(await line()), await line());
  await page.keyboard.press('Escape');
  // AC6: balance 12 < 30 → button disabled with [크레딧 충전]; API refuses with no ledger row
  await api('POST', `/api/admin/workspaces/${W}/ai/credits`, { amount: -(bal() - 12), reason: 'e2e: insufficient' });
  const rows0 = sql(`SELECT COUNT(*) FROM credit_ledger WHERE workspace_id = '${q(W)}'`);
  await page.goto(`${BASE}/app/projects/${P.id}/requirements`); await page.click('#ai-extract'); await page.waitForSelector('.dialog--ai .ai-credit');
  l = await line();
  check('AC6 dialog: 크레딧이 부족합니다 (필요 30 · 잔액 12) · 크레딧 충전 + 추출 disabled', l === '크레딧이 부족합니다 (필요 30 · 잔액 12) · 크레딧 충전' && await page.$eval('#ai-run', (b) => b.disabled), l);
  await shot('09-insufficient.png');
  await page.keyboard.press('Escape');
  const no = await api('POST', `${PP}/ai/requirements/extract`, { text: '잔액 부족 상태의 요청 본문입니다.' });
  check('AC6 API: 402 AI_CREDIT_INSUFFICIENT, no ledger row', no.status === 402 && no.json.error.code === 'AI_CREDIT_INSUFFICIENT' && sql(`SELECT COUNT(*) FROM credit_ledger WHERE workspace_id = '${q(W)}'`) === rows0);

  // AC9: operator refund on the fake provider (pack paid 10 days ago → −10%)
  const o3 = (await api('POST', `${CR}/checkout`, { pack: 'P30' })).json.order;
  await hook('subscription.activated', { order_id: o3.id, payment: { amount: 30000, status: 'PAID', provider_tid: `tid_${o3.id}` } });
  sql(`UPDATE billing_orders SET paid_at = now() - interval '10 days' WHERE workspace_id = '${q(W)}' AND kind = 'CREDIT_PACK' AND status = 'PAID'`);   // both packs older than 7 days → −10%
  const rf = await api('POST', `/api/billing/admin/workspaces/${W}/credit-refund`, { credits: 2000, reason: 'e2e 환불' });
  check('AC9 refund 2,000 → ₩18,000, one REFUND −2,000', rf.status === 200 && rf.json.amount === 18000 && sql(`SELECT string_agg(amount::text, ',') FROM credit_ledger WHERE workspace_id = '${q(W)}' AND type = 'REFUND'`) === '-2000', JSON.stringify(rf.json).slice(0, 200));
  const over = await api('POST', `/api/billing/admin/workspaces/${W}/credit-refund`, { credits: 99999, reason: 'x' });
  check('AC9 more than refundable → 409 exceeds_refundable', over.status === 409 && over.json.error.code === 'exceeds_refundable');
  await page.goto(`${BASE}/admin/workspaces/${W}`); await page.waitForSelector('#ai-refund', { timeout: 8000 }).catch(() => {});
  check('Admin console: 미사용 크레딧 환불 button', Boolean(await page.$('#ai-refund')));
  await shot('10-admin-refund.png');
  sql(`UPDATE users SET system_role = 'NONE' WHERE id = '${q(UID)}'`);

  // 375px: credits page has no horizontal page scroll
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-summary');
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check('375px: credits page fits (no horizontal scroll)', sw <= 375, `scrollWidth=${sw}`);
  await shot('11-credits-375.png');
  await page.goto(BASE + '/'); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('is-in')));
  const landing = await page.textContent('#pricing');
  check('landing: 얼리 액세스 line + AI price block', /얼리 액세스/.test(landing) && /1 크레딧 = 10원/.test(landing) && /AI 요구사항 추출 30 크레딧 \(₩300\)/.test(landing));
  await page.locator('#pricing').screenshot({ path: `${SHOTS}/12-landing-pricing-375.png` });

  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} PASS`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
