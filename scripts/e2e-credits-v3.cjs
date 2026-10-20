// Pricing v3 T2 browser check — 설정 › AI 크레딧 on the fake billing provider (no real payment):
// FREE: buckets line (무료 100), 충전 panel = "Pro로 업그레이드하면 충전할 수 있어요" CTA, no pay button, checkout API 402 with no order row.
// PRO (row set with psql): chips + stepper over server-priced options, quote (결제 금액 / 충전 크레딧 / 대상 워크스페이스 / 유효기간·환불),
// 결제 → fake checkout → signed paid webhook → 구매 bucket; monthly grant shows 기본 n (소멸일); 375px: no pay button.
//   BASE=http://127.0.0.1:3162 SHOTS=… DATABASE_URL=postgres://… node scripts/e2e-credits-v3.cjs
//   server: BILLING_PROVIDER=fake AI_PROVIDER=fake AI_ENABLED=true PAYMENTS_ENABLED=true EMAIL_PROVIDER=fake
const fs = require('fs');
const { createHmac, randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3162';
const SHOTS = process.env.SHOTS || 'credits-v3-shots';
const DB = process.env.DATABASE_URL;
const SECRET = process.env.FAKE_BILLING_SECRET || 'fake-billing-secret';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const q = (s) => String(s).replace(/'/g, "''");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const hook = async (type, data) => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, data });
    const r = await page.request.fetch(`${BASE}/api/billing/webhook/fake`, { method: 'POST', data: body, headers: { 'Content-Type': 'application/json', 'x-fake-signature': createHmac('sha256', SECRET).update(body).digest('hex') } });
    return r.json();
  };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}`, fullPage: true });
  const text = (sel) => page.textContent(sel, { timeout: 6000 }).catch(() => '');

  const email = `v3cr-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email, password: 'passw0rd!' });
  const W = s.json.workspaces[0].id; const UID = s.json.user.id; const CR = `/api/workspaces/${W}/credits`;
  sql(`UPDATE users SET email_verified_at = now() WHERE id = '${q(UID)}'`);
  const wsName = sql(`SELECT name FROM workspaces WHERE id = '${q(W)}'`);

  // FREE
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-buy', { timeout: 10000 });
  check('FREE: buckets line shows 무료 100 · 구매 0', /무료 100/.test(await text('#cr-buckets')) && /구매 0/.test(await text('#cr-buckets')), await text('#cr-buckets'));
  check('FREE: upgrade CTA instead of the pay button', /Pro로 업그레이드하면 충전할 수 있어요/.test(await text('#cr-buy')) && !(await page.$('#cr-pay')));
  await shot('01-free-credits.png');
  const co = await api('POST', `${CR}/checkout`, { amount: 10000 });
  check('FREE: checkout API 402 AI_TOPUP_PLAN_REQUIRED, no order row', co.status === 402 && co.json?.error?.code === 'AI_TOPUP_PLAN_REQUIRED' && sql(`SELECT COUNT(*) FROM billing_orders WHERE workspace_id = '${q(W)}'`) === '0', JSON.stringify(co.json));

  // PRO (a paid period row, no monthly grant written)
  sql(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, auto_renew, billing_cycle, current_period_start, current_period_end) VALUES ('s_${q(W)}', '${q(W)}', 'PRO', 'ACTIVE', 'fake', false, 'MONTHLY', now(), now() + interval '30 days')`);
  await page.goto(BASE + '/app/settings/credits'); await page.waitForLoadState('networkidle'); await page.waitForSelector('#cr-topup', { timeout: 10000 });
  check('PRO: chips 10,000–100,000 and the stepper', (await page.locator('.cr-amt').count()) === 5 && Boolean(await page.$('#cr-plus')));
  await page.click('.cr-amt[data-amount="20000"]');
  const quote = await text('#cr-quote');
  check('PRO: quote = 20,000원 / 2,000 크레딧 / workspace / 5년·환불', /20,000원/.test(quote) && /2,000 크레딧/.test(quote) && quote.includes(wsName) && /5년/.test(quote) && /전액/.test(quote) && !/수수료 \d/.test(quote), quote.replace(/\s+/g, ' '));
  await page.click('#cr-plus');
  check('PRO: + steps to 30,000원 (3,000 크레딧)', /30,000원/.test(await text('#cr-amount')) && /3,000 크레딧/.test(await text('#cr-quote')));
  await page.click('#cr-minus');
  await shot('02-pro-topup.png');
  await Promise.all([page.waitForURL(/checkout=|\/app\/settings\/credits/, { timeout: 10000 }).catch(() => {}), page.click('#cr-pay')]);
  const order = sql(`SELECT id || '|' || kind || '|' || amount || '|' || credits FROM billing_orders WHERE workspace_id = '${q(W)}' ORDER BY created_at DESC LIMIT 1`).split('|');
  check('PRO: pay → CREDIT_TOPUP order 20,000 / 2,000', order[1] === 'CREDIT_TOPUP' && order[2] === '20000' && order[3] === '2000', order.join(' '));
  const paid = await hook('subscription.activated', { order_id: order[0], payment: { amount: 20000, currency: 'KRW', status: 'PAID', provider_tid: `tid_${order[0]}`, moid: order[0] } });
  check('PRO: paid webhook → +2,000 credits', paid?.credits === 2000, JSON.stringify(paid));
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-buckets');
  check('PRO: buckets line 구매 2,000', /구매 2,000/.test(await text('#cr-buckets')), await text('#cr-buckets'));
  const b = (await api('GET', `/api/workspaces/${W}/billing`)).json?.billing?.credits;
  check('GET billing credits buckets filled', b && b.total === 2100 && b.promo === 100 && b.purchased === 2000 && b.plan === 0, JSON.stringify(b));
  await shot('03-pro-after-topup.png');

  // 375px
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-buy');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('375px: no pay button, "결제는 PC에서", no horizontal scroll', !(await page.$('#cr-pay')) && /결제는 PC에서/.test(await text('#cr-buy')) && !wide);
  await shot('04-375.png');
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
