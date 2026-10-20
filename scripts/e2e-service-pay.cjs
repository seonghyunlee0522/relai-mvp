// RELAI 서비스 결제 (/pricing) browser check on the stubbed NicePay (scripts/e2e-service-pay-server.mjs). No real payment.
//   BASE=http://127.0.0.1:3131 SHOTS=research/relai-service-pay DATABASE_URL=postgres://… node scripts/e2e-service-pay.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3131';
const SHOTS = process.env.SHOTS || 'research/relai-service-pay';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const shot = (n, p = page) => p.screenshot({ path: `${SHOTS}/${n}`, fullPage: true });
  const fill = async (p = page) => { await p.fill('#name', '김하늘'); await p.fill('#company', '한빛제약'); await p.fill('#email', 'buyer@example.com'); await p.fill('#phone', '010-1234-5678'); };
  const ncalls = async () => (await (await page.request.get(`${BASE}/__nicepay/calls`)).json()).length;

  // 1) page: public, header, cards, notes, footer, no sample/test words
  await page.goto(`${BASE}/pricing?plan=once&product=agent`);
  const body = await page.innerText('body');
  check('header relai / 서비스 결제', /relai\s*\/\s*서비스 결제/.test(await page.innerText('.sp-top')));
  check('two product cards with 400,000원', (await page.$$('.sp-card')).length === 2 && /AI Agent 개발 및 운영[\s\S]*400,000원[\s\S]*AI Agent 개발 및 운영 월 구독[\s\S]*400,000원/.test(await page.innerText('.sp-cards')));
  check('?plan=once selects the one-time card', await page.$eval('.sp-card.is-on', (e) => e.dataset.product) === 'agent-once');
  check('결제 전 확인해주세요 + 문의 + 사업자 정보 + 약관 links', /결제 전 확인해주세요/.test(body) && /551-25-02019/.test(body) && /통신판매업 신고번호/.test(body) && Boolean(await page.$('footer a[href="/terms"]')) && Boolean(await page.$('footer a[href="/privacy"]')));
  check('no sample/test/샘플/테스트 words', !/sample|test|샘플|테스트/i.test(body), (body.match(/.{0,20}(sample|test|샘플|테스트).{0,20}/i) || [''])[0]);
  check('no console/page errors on load', errors.length === 0, errors.join(' | '));
  await shot('01-pricing-desktop.png');

  // 2) validation: consents required, nothing called
  const before = await ncalls();
  await page.click('#sp-submit');
  check('empty submit → field + consent errors, no order', /이름을 입력해 주세요/.test(await page.innerText('#sp-form')) && /이용약관에 동의해 주세요/.test(await page.innerText('#sp-form')) && sql("SELECT count(*) FROM service_orders") === '0');

  // 3) 월 구독: card form, 준비 중 message, nothing called
  await page.click('[data-pick="agent-monthly"]');
  check('monthly: card registration form shown (카드번호/유효기간/생년월일/비밀번호 앞 2자리/정기결제 동의)', await page.isVisible('#card_number') && await page.isVisible('#card_expiry') && await page.isVisible('#card_id_no') && await page.isVisible('#card_pw') && await page.isVisible('#agree_recurring'));
  check('monthly: URL ?plan=monthly', /plan=monthly/.test(page.url()));
  await fill(); await page.fill('#card_number', '5361120000001234'); await page.fill('#card_expiry', '1229'); await page.fill('#card_id_no', '900101'); await page.fill('#card_pw', '12');
  await page.check('#agree_all');
  let fetched = 0; const onReq = (r) => { if (r.url().includes('/api/')) fetched++; }; page.on('request', onReq);
  await page.click('#sp-submit'); await page.waitForTimeout(400);
  page.off('request', onReq);
  check('monthly submit → "월 구독은 준비 중입니다." and no request', /월 구독은 준비 중입니다/.test(await page.innerText('#sp-msg')) && fetched === 0 && (await ncalls()) === before && sql("SELECT count(*) FROM service_orders") === '0');
  await shot('02-monthly-soon.png');

  // 4) one-time: order → NicePay window (stand-in) → approve → done page
  await page.goto(`${BASE}/pricing?plan=once&product=agent`);
  await fill(); await page.check('#agree_all');
  check('전체 동의 checks all three consents', await page.isChecked('#agree_terms') && await page.isChecked('#agree_privacy') && await page.isChecked('#agree_payment'));
  await shot('03-once-filled.png');
  await Promise.all([page.waitForURL(/__nicepay\/window/), page.click('#sp-submit')]);
  check('payment window opened for 400000원 (server amount)', /400000원/.test(await page.innerText('body')));
  await Promise.all([page.waitForURL(/\/pricing\/done/), page.click('#np-pay button')]);
  const oid = new URL(page.url()).searchParams.get('order');
  const doneText = await page.innerText('#sp-result');
  check('done page: 결제가 완료되었습니다 + order number + 400,000원', /결제가 완료되었습니다/.test(doneText) && doneText.includes(oid) && /400,000원/.test(doneText));
  check('order PAID with buyer info', sql(`SELECT status||'|'||amount||'|'||buyer_name||'|'||buyer_email FROM service_orders WHERE id='${oid}'`) === 'PAID|400000|김하늘|buyer@example.com');
  check('receipt e-mail recorded once', sql(`SELECT count(*) FROM email_deliveries WHERE type='SERVICE_RECEIPT' AND recipient='buyer@example.com'`) === '1');
  const approvals = (await (await page.request.get(`${BASE}/__nicepay/calls`)).json()).filter((c) => /^\/v1\/payments\/[^/]+$/.test(c.path));
  check('approved once for 400000', approvals.length === 1 && approvals[0].amount === 400000, JSON.stringify(approvals));
  await shot('04-done.png');
  await page.goBack(); await page.goBack().catch(() => {});

  // 5) tamper: window says 1,000원 → refused, failure page, no extra approval
  await page.goto(`${BASE}/pricing?plan=once&product=agent`); await fill(); await page.check('#agree_all');
  await Promise.all([page.waitForURL(/__nicepay\/window/), page.click('#sp-submit')]);
  await Promise.all([page.waitForURL(/\/pricing\/failed/), page.click('#np-tamper button')]);
  check('tampered amount → failure page (amount_mismatch), no approval', /결제 금액이 주문 금액과 달라/.test(await page.innerText('#sp-result')) && (await (await page.request.get(`${BASE}/__nicepay/calls`)).json()).filter((c) => /^\/v1\/payments\/[^/]+$/.test(c.path)).length === 1);
  await shot('05-failed-tamper.png');

  // 6) cancel in the window → failure page
  await page.goto(`${BASE}/pricing?plan=once&product=agent`); await fill(); await page.check('#agree_all');
  await Promise.all([page.waitForURL(/__nicepay\/window/), page.click('#sp-submit')]);
  await Promise.all([page.waitForURL(/\/pricing\/failed/), page.click('#np-cancel button')]);
  check('cancel → 결제가 취소되었습니다', /결제가 취소되었습니다/.test(await page.innerText('#sp-result')));
  await shot('06-failed-cancel.png');

  // 7) mobile 375px: no horizontal scroll
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', isMobile: true });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/pricing?plan=monthly&product=agent`);
  check('375px: no horizontal scroll', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot('07-mobile-monthly.png', mp);
  await mp.goto(`${BASE}/pricing/done?order=${oid}`); await shot('08-mobile-done.png', mp);
  await m.close();

  // 8) 관리자 › 결제 lists the service order (read-only)
  const email = `ops-${Date.now()}@relai.example`;
  const s = await page.request.post(`${BASE}/api/auth/signup`, { data: { agree_terms: true, agree_privacy: true, name: '운영자', email, password: 'passw0rd!' } });
  const uid = (await s.json()).user.id;
  sql(`UPDATE users SET system_role='SYSTEM_ADMIN', email_verified_at=now() WHERE id='${uid}'`);
  await page.goto(`${BASE}/admin/payments`);
  await page.waitForSelector('#svc-orders-tbl', { timeout: 10000 }).catch(() => {});
  const adm = await page.innerText('#svc-orders').catch(() => '');
  check('관리자 › 결제 › 서비스 결제: buyer name, email, amount, status', /서비스 결제/.test(adm) && /김하늘/.test(adm) && /buyer@example.com/.test(adm) && /400,000/.test(adm) && /결제 완료/.test(adm), adm.slice(0, 300));
  await shot('09-admin-payments.png');

  await browser.close();
  const fails = results.filter(([, ok]) => !ok); console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
