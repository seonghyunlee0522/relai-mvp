// Pricing v3 T3 browser check — 구독하기 · 추가 · 업그레이드 · 해지 on the fake billing provider (fake 정기결제, no real payment):
//   CLOSED server (PAYMENTS_ENABLED, 정기결제 off): /app/billing/subscribe renders in full with 정기결제 준비 중; submit sends nothing;
//     POST …/billing/checkout → 409 checkout_not_open.
//   OPEN server (NICEPAY_RECURRING_ENABLED=true with BILLING_PROVIDER=fake, ADDONS_ENABLED, PLAN_CHANGE_ENABLED, REFUND_PARTIAL_ENABLED):
//     Pro monthly + 2 users from the server quote (30,000 → 32,000원), 정기결제 안내 items, consent required, card → 플랜 · 결제;
//     ?addon=1 (+1 project, prorated) · Pro → Team upgrade · 해지 (one click + one confirm) on 플랜 · 결제 · 해지 + 환불 (API);
//     375px: subscribe page and 플랜 · 결제 without horizontal scroll, 해지 works in phone view mode.
//   BASE_CLOSED=http://127.0.0.1:3871 BASE=http://127.0.0.1:3872 DATABASE_URL=postgres://… SHOTS=… node scripts/e2e-subscribe-v3.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3872';
const BASE_CLOSED = process.env.BASE_CLOSED || 'http://127.0.0.1:3871';
const SHOTS = process.env.SHOTS || 'subscribe-v3-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const q = (s) => String(s).replace(/'/g, "''");
const CARD = { number: '4242424242424242', mm: '12', yy: '29', id: '800101', pw: '12' };

async function account(browser, base, { phone = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 375, height: 812 }, locale: 'ko-KR', isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sent = []; page.on('request', (r) => { if (r.method() === 'POST' && /\/billing\//.test(r.url())) sent.push(r.url()); });
  await page.goto(base + '/login');
  const api = async (method, p, body) => { const r = await page.request.fetch(base + p, { method, data: body ?? {}, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const email = `v3sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@relai.test`;
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '이구독', email, password: 'passw0rd!' });
  const W = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE id = '${q(s.json.user.id)}'`);
  return { ctx, page, api, W, errors, sent, shot: (n) => page.screenshot({ path: `${SHOTS}/${n}`, fullPage: true }) };
}
const fillCard = async (page) => {
  await page.fill('#sub-number', CARD.number); await page.selectOption('#sub-mm', CARD.mm); await page.selectOption('#sub-yy', CARD.yy);
  await page.fill('#sub-id', CARD.id); await page.fill('#sub-pw', CARD.pw);
};
const amountIs = (page, want) => page.waitForFunction((w) => document.querySelector('#sub-amount')?.textContent === w, want, { timeout: 8000 }).then(() => true).catch(() => false);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const browser = await chromium.launch();

  /* ---------- 1. closed: 정기결제 준비 중 ---------- */
  {
    const a = await account(browser, BASE_CLOSED);
    await a.page.goto(`${BASE_CLOSED}/app/billing/subscribe?plan=PRO`); await a.page.waitForSelector('#subscribe-page');
    check('closed: 정기결제 준비 중 notice', /정기결제 준비 중/.test(await a.page.textContent('#sub-not-open').catch(() => '')));
    check('closed: quote still from the server (30,000원)', await amountIs(a.page, '30,000원'));
    check('closed: button says 정기결제 준비 중', /정기결제 준비 중/.test(await a.page.textContent('#sub-pay')));
    await fillCard(a.page); await a.page.check('input[name=agree]'); await a.page.check('input[name=agree_pg]');
    await a.page.click('#sub-pay'); await a.page.waitForTimeout(600);
    check('closed: submit sends nothing', !a.sent.some((u) => /recurring|checkout/.test(u)), a.sent.join(','));
    check('closed: card fields cleared', (await a.page.inputValue('#sub-number')) === '');
    const co = await a.api('POST', `/api/workspaces/${a.W}/billing/checkout`, { plan: 'PRO', cycle: 'MONTHLY' });
    check('closed: checkout API 409 checkout_not_open', co.status === 409 && co.json?.error?.code === 'checkout_not_open', JSON.stringify(co.json));
    await a.shot('01-closed-subscribe.png');
    check('closed: no page errors', !a.errors.length, a.errors.join(' | '));
    await a.ctx.close();
  }

  /* ---------- 2. open: subscribe Pro monthly + 2 users ---------- */
  const o = await account(browser, BASE);
  {
    const { page } = o;
    await page.goto(`${BASE}/app/billing/subscribe?plan=PRO&cycle=MONTHLY`); await page.waitForSelector('#subscribe-page');
    check('open: no 준비 중 notice', !(await page.locator('#sub-not-open').count()));
    check('open: Pro monthly 30,000원', await amountIs(page, '30,000원'));
    await page.click('[data-step=extra_users][data-d="1"]'); await page.click('[data-step=extra_users][data-d="1"]');
    check('open: +2 users → 32,000원 (server quote)', await amountIs(page, '32,000원'));
    const disc = await page.textContent('#sub-disclosure-items');
    for (const k of ['요금제', '지금 결제 금액', '최초 결제일', '결제 주기', '다음 결제 예정', '자동 갱신', '해지 방법', '환불 기준']) check(`open: 정기결제 안내 — ${k}`, disc.includes(k));
    check('open: 안내 says 32,000원 renewal', /32,000원/.test(disc));
    check('open: consents unchecked', !(await page.isChecked('input[name=agree]')) && !(await page.isChecked('input[name=agree_pg]')));
    check('open: pay button shows the exact amount', /32,000원 결제하고 구독 시작/.test(await page.textContent('#sub-pay')));
    await fillCard(page); await page.click('#sub-pay'); await page.waitForTimeout(300);
    check('open: no consent → error, no request', /동의/.test(await page.textContent('[data-err=agree]')) && !o.sent.some((u) => /recurring/.test(u)));
    await o.shot('02-open-subscribe.png');
    await page.check('input[name=agree]'); await page.check('input[name=agree_pg]'); await fillCard(page);
    await page.click('#sub-pay');
    await page.waitForURL(/\/app\/settings\/billing/, { timeout: 10000 }).catch(() => {});
    check('open: lands on 플랜 · 결제', /\/app\/settings\/billing/.test(page.url()), page.url());
    const s = sql(`SELECT plan||'|'||extra_users||'|'||renewal_amount||'|'||auto_renew FROM subscriptions WHERE workspace_id = '${q(o.W)}'`);
    check('open: DB PRO, +2 users, renewal 32,000, auto-renew', s === 'PRO|2|32000|true', s);
    check('open: one consent row with the hash', sql(`SELECT COUNT(*) FROM billing_consents WHERE workspace_id = '${q(o.W)}' AND kind = 'CHECKOUT' AND length(disclosure_hash) = 64`) === '1');
    await page.waitForSelector('#bl-root', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    check('billing page: 다음 결제 예정 금액 32,000원', /32,000원/.test(await page.textContent('#bl-root').catch(() => '')));
    await o.shot('03-billing-after-subscribe.png');
  }

  /* ---------- 3. add-on (?addon=1) and upgrade ---------- */
  {
    const { page } = o;
    await page.goto(`${BASE}/app/billing/subscribe?addon=1`); await page.waitForSelector('#subscribe-page');
    check('addon: title 사용자 · 프로젝트 추가, no card section', /사용자 · 프로젝트 추가/.test(await page.textContent('h1')) && !(await page.locator('#sub-card').count()));
    await page.click('[data-step=extra_projects][data-d="1"]');
    await page.waitForFunction(() => /원$/.test(document.querySelector('#sub-amount')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    const amt = Number(((await page.textContent('#sub-amount').catch(() => '')) || '').replace(/\D/g, ''));
    check('addon: prorated amount 1..10,000원', amt > 0 && amt <= 10000, String(amt));
    await page.check('input[name=agree]'); await page.click('#sub-pay');
    await page.waitForURL(/\/app\/settings\/billing/, { timeout: 10000 }).catch(() => {});
    check('addon: extra_projects 1 after PAID', sql(`SELECT extra_projects FROM subscriptions WHERE workspace_id = '${q(o.W)}'`) === '1');
    await page.goto(`${BASE}/app/billing/subscribe?plan=TEAM`); await page.waitForSelector('#subscribe-page');
    check('upgrade: title Pro → Team', /업그레이드/.test(await page.textContent('h1')));
    await page.waitForFunction(() => /원$/.test(document.querySelector('#sub-amount')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await o.shot('04-upgrade.png');
    await page.check('input[name=agree]'); await page.click('#sub-pay');
    await page.waitForURL(/\/app\/settings\/billing/, { timeout: 10000 }).catch(() => {});
    check('upgrade: plan TEAM now', sql(`SELECT plan FROM subscriptions WHERE workspace_id = '${q(o.W)}'`) === 'TEAM');
  }

  /* ---------- 4. 해지 on 플랜 · 결제: one click + one confirm ---------- */
  {
    const { page } = o;
    await page.goto(`${BASE}/app/settings/billing`); await page.waitForSelector('#bl-cancel', { timeout: 8000 }).catch(() => {});
    await page.click('#bl-cancel'); await page.click('.dialog [data-v="1"]');
    await page.waitForSelector('#bl-cancel-pending', { timeout: 8000 }).catch(() => {});
    check('cancel: 해지 예약 shown', await page.locator('#bl-cancel-pending').count() > 0);
    check('cancel: DB auto-renew off, plan to period end', sql(`SELECT auto_renew||'|'||cancel_at_period_end||'|'||plan FROM subscriptions WHERE workspace_id = '${q(o.W)}'`) === 'false|true|TEAM');
    await o.shot('05-cancel-pending.png');
    check('open: no page errors', !o.errors.length, o.errors.join(' | '));
  }

  /* ---------- 5. 해지 + 환불 (API), 375px ---------- */
  {
    const m = await account(browser, BASE, { phone: true });
    const hq = (await m.api('GET', `/api/workspaces/${m.W}/billing/quote?plan=PRO&cycle=ANNUAL`)).json.disclosure.hash;
    await m.page.goto(`${BASE}/app/billing/subscribe?plan=PRO&cycle=ANNUAL`); await m.page.waitForSelector('#subscribe-page');
    await amountIs(m.page, '288,000원');
    check('375px: subscribe page without horizontal scroll', await noHScroll(m.page));
    await m.shot('06-subscribe-375.png');
    const r = await m.api('POST', `/api/workspaces/${m.W}/billing/recurring`, { plan: 'PRO', cycle: 'ANNUAL', card: { number: CARD.number, expiry: '12/29', id_no: CARD.id, password2: CARD.pw }, agree: true, disclosure_hash: hq });
    check('375px account: subscribed Pro annual (API)', r.status === 201, JSON.stringify(r.json?.error || ''));
    await m.page.goto(`${BASE}/app/settings/billing`); await m.page.waitForSelector('#bl-root', { timeout: 8000 }).catch(() => {});
    await m.page.waitForTimeout(800);
    check('375px: 플랜 · 결제 without horizontal scroll', await noHScroll(m.page));
    await m.shot('07-billing-375.png');
    const rq = await m.api('GET', `/api/workspaces/${m.W}/billing/refund-quote`);
    check('refund quote: 청약철회 within 7 days, ≤ 288,000', rq.json.refund.withdrawal === true && rq.json.refund.total > 0 && rq.json.refund.total <= 288000, JSON.stringify(rq.json.refund));
    const c = await m.api('POST', `/api/workspaces/${m.W}/billing/cancel`, { refund: true });
    check('cancel + refund: FREE now, refund DONE (partial cancel)', c.status === 200 && c.json.billing.plan === 'FREE' && sql(`SELECT status FROM subscription_refunds WHERE workspace_id = '${q(m.W)}'`) === 'DONE', JSON.stringify(c.json?.cancel || c.json));
    check('375px: no page errors', !m.errors.length, m.errors.join(' | '));
    await m.ctx.close();
  }
  {
    // 해지 works in phone view mode (one click + one confirm)
    const p = await account(browser, BASE, { phone: true });
    const hq = (await p.api('GET', `/api/workspaces/${p.W}/billing/quote?plan=PRO&cycle=MONTHLY`)).json.disclosure.hash;
    await p.api('POST', `/api/workspaces/${p.W}/billing/recurring`, { plan: 'PRO', cycle: 'MONTHLY', card: { number: CARD.number, expiry: '12/29', id_no: CARD.id, password2: CARD.pw }, agree: true, disclosure_hash: hq });
    await p.page.goto(`${BASE}/app/settings/billing`); await p.page.waitForSelector('#bl-cancel', { timeout: 8000 }).catch(() => {});
    await p.page.click('#bl-cancel'); await p.page.click('.dialog [data-v="1"]');
    await p.page.waitForSelector('#bl-cancel-pending', { timeout: 8000 }).catch(() => {});
    check('375px: 해지 works on a phone', sql(`SELECT cancel_at_period_end FROM subscriptions WHERE workspace_id = '${q(p.W)}'`) === 't');
    await p.shot('08-cancel-375.png');
    await p.ctx.close();
  }

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
