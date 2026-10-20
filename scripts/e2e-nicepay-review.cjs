// NicePay merchant review path (결제경로 심사) browser check + the desktop screenshots for research/nicepay/RELAI_결제경로.pptx.
//   정기과금: footer business info · 이용약관/개인정보처리방침 상호 · login · 플랜 (Team 플랜, 월 금액 VAT 포함) → 구독하기 →
//            /app/billing/subscribe (카드번호 · 유효기간 · 생년월일/사업자번호 · 비밀번호 앞 2자리, 금액 · 결제일, 정기결제 동의).
//   단건:    AI 크레딧 상품 3개 (10,000 / 30,000 / 100,000원) · 결제 수단 신용카드 · 상품 → order page that opens the NicePay window.
//   No 'sample/test/샘플/테스트' on any of those screens. Card data never reaches storage; nothing is sent to NicePay:
//   the card POST is intercepted in the browser (fake NicePay answer) and every *.nicepay.co.kr request is aborted.
// Two modes, picked from the server's own flags (GET …/billing): payments off → submit says '결제 준비 중' and sends nothing;
// payments + 정기결제 on → submit sends one POST …/billing/recurring { cycle: MONTHLY, card } and lands on 설정.
// Not part of `npm test` (needs a running server, Playwright and psql):
//   BASE=http://127.0.0.1:3647 SHOTS=research/nicepay/shots DATABASE_URL=postgres://… node scripts/e2e-nicepay-review.cjs
//   server for the deck: BILLING_PROVIDER=nicepay NICEPAY_MODE=live with placeholder keys, NICEPAY_SDK_URL=data:… stub,
//   PAYMENTS_ENABLED=true NICEPAY_RECURRING_ENABLED=true SAMPLE_PROJECTS=false (never real keys: nothing may reach NicePay).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3647';
const SHOTS = process.env.SHOTS || 'nicepay-review-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const esc = (s) => String(s).replace(/'/g, "''");
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const SOON = '결제 준비 중입니다. 곧 오픈 예정이에요.';
const BANNED = /sample|test|샘플|테스트/i;
const CARD = { number: '1234567890123456', mm: '12', yy: '29', id: '800101', pw: '12' };   // placeholder digits, not a real card

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', deviceScaleFactor: 1 });
  await ctx.route(/nicepay\.co\.kr/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const sent = [];
  page.on('request', (r) => { if (/\/billing\/(recurring|checkout)|\/credits\/checkout/.test(r.url())) sent.push({ url: r.url(), body: r.postData() }); });
  const shot = (n, opts = {}) => page.screenshot({ path: path.join(SHOTS, n), ...opts });
  const visibleText = () => page.evaluate(() => document.body.innerText);
  const noBanned = async (name) => { const t = await visibleText(); const m = t.match(BANNED); check(`${name}: no sample/test/샘플/테스트`, !m, m ? t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ') : ''); };

  /* ---------- 1. homepage footer (business info) · 2. URL ---------- */
  await page.goto(BASE + '/'); await page.waitForLoadState('networkidle');
  await shot('01-home-top.png');
  const foot = page.locator('footer.legal-foot').first();
  const ft = (await foot.textContent()) || '';
  for (const k of ['상호', '대표', '사업자등록번호', '통신판매업 신고번호', '주소']) check(`landing footer: ${k}`, ft.includes(k));
  check('landing footer: e-mail', /@/.test(ft));
  check('landing footer: 전화번호 (LEGAL.contactPhone)', /전화/.test(ft), '(founder must fill LEGAL.contactPhone)');
  await foot.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot('02-home-footer.png');
  const box = await foot.boundingBox(); fs.writeFileSync(path.join(SHOTS, '02-home-footer.box.json'), JSON.stringify({ box, scrollY: await page.evaluate(() => window.scrollY), vh: 900 }));
  for (const [p, n] of [['/terms', '03-terms.png'], ['/privacy', '04-privacy.png']]) {
    await page.goto(BASE + p); const t = await page.textContent('body');
    check(`${p}: 상호 in the document`, t.includes('릴레이(RELAI)'));
    await shot(n);
  }

  /* ---------- 3. login page ---------- */
  await page.goto(BASE + '/login'); await page.waitForSelector('form');
  await noBanned('login'); await shot('05-login.png');

  /* ---------- reviewer-like account (owner, verified) ---------- */
  const email = `review-${Date.now()}@relai.example`;
  const r = await page.request.post(BASE + '/api/auth/signup', { data: { agree_terms: true, agree_privacy: true, name: '김심사', email, password: 'Revi3w-pass!' } });
  const w = (await r.json()).workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${esc(email)}'`);
  sql(`UPDATE workspaces SET name = '심사용 워크스페이스' WHERE id = '${esc(w)}'`);
  await page.request.post(`${BASE}/api/workspaces/${w}/onboarding/product_tour/skip`, { data: {} });
  const billing = (await (await page.request.get(`${BASE}/api/workspaces/${w}/billing`)).json()).billing;
  const live = Boolean(billing.payments_enabled && billing.checkout.recurring_available);
  log(`mode: payments ${billing.payments_enabled ? 'on' : 'off'}, 정기결제 ${billing.checkout.recurring_available ? 'on' : 'off'}`);

  /* ---------- 4. product list: plans (정기) ---------- */
  await page.goto(`${BASE}/app/billing/plans`); await page.waitForSelector('#plans-page');
  const team = (await page.locator('.pl-card[data-plan="TEAM"]').textContent()) || '';
  check('plans: Team 플랜 with 월 22,000원 (부가세 포함)', /Team 플랜/.test(team) && /월 22,000원/.test(team) && /부가세 포함/.test(team), team.replace(/\s+/g, ' ').slice(0, 160));
  check('plans: 3 credit products priced', (await page.locator('[data-plan-pack]').count()) === 3 && /10,000원[\s\S]*30,000원[\s\S]*100,000원/.test(await page.textContent('#pl-credits')));
  check('plans: footer business info', /사업자등록번호/.test(await page.textContent('#plans-page footer')));
  await noBanned('plans');
  await shot('06-plans.png');
  await shot('06-plans-full.png', { fullPage: true });

  /* ---------- 5. 구독하기 → card registration page ---------- */
  await page.click('#pl-subscribe');
  await page.waitForSelector('#subscribe-page', { timeout: 5000 }).catch(() => {});
  check('구독하기 opens /app/billing/subscribe', new URL(page.url()).pathname === '/app/billing/subscribe', page.url());
  for (const [sel, name] of [['#sub-number', '카드번호'], ['#sub-mm', '유효기간 월'], ['#sub-yy', '유효기간 년'], ['#sub-id', '생년월일/사업자번호'], ['#sub-pw', '비밀번호 앞 2자리']]) check(`card page: ${name} field`, await page.locator(sel).isVisible());
  check('card page: 비밀번호 field is masked, max 2', (await page.getAttribute('#sub-pw', 'type')) === 'password' && (await page.getAttribute('#sub-pw', 'maxlength')) === '2');
  const order = (await page.textContent('#sub-order')) || '';
  check('card page: amount + billing day shown', /월 결제 금액/.test(order) && /\d[\d,]*원/.test(order) && /매월 \d+일 자동 결제/.test(order), order.replace(/\s+/g, ' ').slice(0, 200));
  check('card page: 정기결제 consent (2 required boxes)', (await page.locator('.sub-agree input[type=checkbox]').count()) === 2);
  await noBanned('card page');
  await shot('07-subscribe.png'); await shot('07-subscribe-full.png', { fullPage: true });
  // empty submit → field errors, nothing sent
  await page.click('#sub-pay');
  check('empty submit: field errors, no request', (await page.locator('[data-err="number"]').textContent()).length > 0 && sent.length === 0);
  // filled submit
  await page.fill('#sub-number', CARD.number); await page.selectOption('#sub-mm', CARD.mm); await page.selectOption('#sub-yy', CARD.yy);
  await page.fill('#sub-id', CARD.id); await page.fill('#sub-pw', CARD.pw);
  check('card number formatted in 4-digit groups', (await page.inputValue('#sub-number')) === '1234-5678-9012-3456');
  await page.click('#sub-pay');
  check('without consent: agree error, no request', /동의/.test(await page.locator('[data-err="agree"]').textContent()) && sent.length === 0);
  await page.check('input[name=agree_recurring]'); await page.check('input[name=agree_pg]');
  await page.locator('#sub-card').scrollIntoViewIfNeeded(); await shot('07-subscribe-filled.png');
  if (live) {
    await page.route('**/billing/recurring', (rt) => rt.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ billing }) }));   // fake NicePay answer
    await page.click('#sub-pay');
    await page.waitForURL(/\/app\/settings/, { timeout: 5000 }).catch(async () => log('  toast:', await page.locator('.toast').allTextContents(), 'errs:', await page.$$eval('[data-err]', (e) => e.map((x) => x.textContent).join('|'))));
    const body = JSON.parse(sent.find((x) => /recurring/.test(x.url))?.body || '{}');
    check('payments on: one POST …/billing/recurring, cycle MONTHLY, the 4 card fields', sent.length === 1 && body.cycle === 'MONTHLY' && body.card?.number === CARD.number && body.card?.expiry === '12/29' && body.card?.id_no === CARD.id && body.card?.password2 === CARD.pw, JSON.stringify({ ...body, card: body.card && Object.keys(body.card) }));
    check('payments on: lands on 설정', /\/app\/settings/.test(page.url()), page.url());
    await page.unroute('**/billing/recurring');
  } else {
    await page.click('#sub-pay');
    const t = await page.locator('.toast', { hasText: SOON }).first().textContent({ timeout: 3000 }).catch(() => '');
    check('payments off: submit says 결제 준비 중 and sends nothing', t.trim() === SOON && sent.length === 0, JSON.stringify(sent));
  }
  check('card fields cleared after submit', await page.evaluate(() => !document.querySelector('#sub-number') || document.querySelector('#sub-number').value === ''));
  check('card data not in web storage', await page.evaluate((n) => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(n), CARD.number));
  sent.length = 0;

  /* ---------- 단건: credit products · 결제 수단 신용카드 · order page that opens the NicePay window ---------- */
  await page.goto(`${BASE}/app/settings/credits`); await page.waitForSelector('#cr-buy');
  check('credits: 3 packs', (await page.locator('[data-pack]').count()) === 3);
  check('credits: 결제 수단 신용카드', /신용카드/.test(await page.textContent('#cr-method')));
  check('credits: footer business info', /사업자등록번호/.test(await page.textContent('.page--credits footer')));
  await noBanned('credits');
  await page.locator('#cr-buy').scrollIntoViewIfNeeded();
  await shot('08-credits.png'); await shot('08-credits-full.png', { fullPage: true });
  await page.click('[data-pack="P30"]');
  if (billing.payments_enabled) {
    await page.waitForURL(/\/api\/billing\/nicepay\/pay\//, { timeout: 5000 }).catch(() => {});
    const t = await page.textContent('body').catch(() => '');
    check('pack → order page: 30,000원 · 결제 수단 신용카드', /30,000/.test(t) && /신용카드/.test(t), page.url());
    await noBanned('order page');
    await shot('09-paywindow-order.png');
  } else {
    const t = await page.locator('.toast', { hasText: SOON }).first().textContent({ timeout: 3000 }).catch(() => '');
    check('payments off: pack click says 결제 준비 중, no checkout', t.trim() === SOON && sent.length === 0);
  }

  /* ---------- app shell: settings footer ---------- */
  await page.goto(`${BASE}/app/settings`); await page.waitForSelector('.page--settings');
  check('settings: footer business info', /사업자등록번호/.test(await page.textContent('.page--settings footer')));

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
