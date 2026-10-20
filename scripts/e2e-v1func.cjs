// v1 functional fixes — UI checks for F4 (WBS 실적 dates in the drawer), F5 (close dialog warns about open WBS), F6 (의사결정 기록 log)
// and payments off (PAYMENTS_ENABLED unset: no pack / plan purchase; plan limits + 플랜 살펴보기 since batch7 T5). API-level checks live in server/test/v1-func.test.js.
// Not part of `npm test` (needs a running server WITHOUT PAYMENTS_ENABLED + Playwright).
//   BASE=http://127.0.0.1:3261 SHOTS=/tmp/v1 DATABASE_URL=postgres://… node scripts/e2e-v1func.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3261';
const SHOTS = process.env.SHOTS || 'v1func-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const email = `v1f-${Date.now()}@relai.test`;
  await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김피엠', email, password: 'passw0rd!' });
  const w = (await api('GET', '/api/me')).json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: '한빛물류 WMS 구축', client_name: '한빛물류', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`;
  const settle = async () => { await page.waitForSelector('.phead-wrap, .page__head, .clk', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(400); };

  /* ---------- payments off ---------- */
  await page.goto(`${BASE}/app/settings?tab=plan`); await settle(); await page.waitForSelector('#billing', { timeout: 8000 }).catch(() => {});
  const plan = await page.evaluate(() => ({ line: document.querySelector('#free-line')?.textContent.trim() || '', lim: Boolean(document.querySelector('#plan-limits')), plans: document.querySelector('#plans-link')?.getAttribute('href') || '', pay: Boolean(document.querySelector('#bill-pay, #bill-form, [data-cycle]')),
    credits: [...document.querySelectorAll('#ai-credits a')].map((a) => a.textContent.trim()).join('|') }));
  // batch7 T5: the '초기 고객은 무료로 이용합니다.' line is gone (early access is on Free limits) → plan limits + 플랜 살펴보기 → /app/billing/plans
  check('요금제: plan limits + 플랜 살펴보기 → /app/billing/plans, no plan purchase form', !plan.line && plan.lim && plan.plans === '/app/billing/plans' && !plan.pay, JSON.stringify(plan));
  check('요금제: AI 크레딧 card link says 자세히 (no 충전)', plan.credits === '자세히', plan.credits);
  await page.screenshot({ path: `${SHOTS}/01-plan.png` });
  await page.goto(`${BASE}/app/settings/credits`); await page.waitForSelector('#cr-summary', { timeout: 8000 });
  const cr = await page.evaluate(() => ({ packs: document.querySelectorAll('[data-pack]').length, buy: Boolean(document.querySelector('#cr-buy')), top: Boolean(document.querySelector('#cr-buy-top')), bal: document.querySelector('#cr-balance')?.textContent || '', charge: /크레딧 충전/.test(document.querySelector('#main').textContent) }));
  // NicePay review (122c3ee): the 3 packs stay listed with payments off (priced products), no top button, a click says 결제 준비 중 and buys nothing
  check('AI 크레딧: 3 packs listed, no top 충전 button; balance still shown', cr.packs === 3 && cr.buy && !cr.top && /크레딧/.test(cr.bal), JSON.stringify(cr));
  await page.screenshot({ path: `${SHOTS}/02-credits.png` });
  await page.click('[data-pack]');
  const soon = await page.locator('.toast', { hasText: '결제 준비 중' }).first().textContent({ timeout: 3000 }).catch(() => '');
  check('AI 크레딧: pack click says 결제 준비 중, stays on the page', /결제 준비 중/.test(soon) && /\/app\/settings\/credits/.test(page.url()), page.url());
  const co = await api('POST', `/api/workspaces/${w}/credits/checkout`, { pack: 'S' });
  check('credit checkout refused: 409 payments_disabled', co.status === 409 && co.json?.error?.code === 'payments_disabled', JSON.stringify(co));
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${BASE}/app/settings/credits`); await page.waitForSelector('#cr-summary', { timeout: 8000 });
  const ph = await page.evaluate(() => ({ packs: document.querySelectorAll('[data-pack]').length, pc: /결제는 PC에서/.test(document.body.textContent) }));
  check('phone AI 크레딧: no pack button and no "결제는 PC에서"', ph.packs === 0 && !ph.pc, JSON.stringify(ph));
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ---------- F6 의사결정 기록 ---------- */
  sql(`UPDATE projects SET current_phase = 'DEVELOPMENT' WHERE id = '${P.id}'`);
  await page.goto(`${BASE}${U}`); await settle();
  const link = await page.$(`a[href*="checklist?activity=DECISIONS"]`);
  check('04 지금 할 일: 주요 의사결정 기록 links to the decision log', Boolean(link));
  await page.goto(`${BASE}${U}/checklist?activity=DECISIONS`); await page.waitForSelector('.clk__card', { timeout: 8000 });
  const empty = await page.textContent('.clk__card');
  check('decision log empty state + 결정일 · 결정 내용 · 결정자 form', /아직 기록된 의사결정이 없습니다/.test(empty) && Boolean(await page.$('[data-add][data-dec] [name=due_date]')), empty.slice(0, 200));
  await page.fill('[data-add][data-dec] [name=title]', '리포트 기능은 2차 오픈으로 이월');
  await page.selectOption('[data-add][data-dec] [name=owner_ref]', '__text'); await page.fill('[data-add][data-dec] [name=owner]', '오지현 고객 PM');
  await page.fill('[data-add][data-dec] [name=note]', '10/14 주간회의');
  await page.click('[data-add][data-dec] button[type=submit]'); await page.waitForSelector('[data-decisions] tbody tr', { timeout: 8000 });
  const dec = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-decisions] tbody tr').length, head: [...document.querySelectorAll('[data-decisions] th')].map((t) => t.textContent.trim()).filter(Boolean).join('·'),
    badge: document.querySelector('.clk__h .badge--st')?.textContent.trim(), date: document.querySelector('[data-decisions] [data-f=due_date]')?.value }));
  check('one decision recorded → table 결정일·결정 내용·결정자·메모, activity 완료', dec.rows === 1 && dec.head === '결정일·결정 내용·결정자·메모' && dec.badge === '완료' && dec.date === today, JSON.stringify(dec));
  await page.screenshot({ path: `${SHOTS}/03-decisions.png` });

  /* ---------- F4 실적 dates in the WBS drawer ---------- */
  const t = (await api('POST', `${pa}/wbs`, { item_type: 'TASK', title: '입고 화면 개발', planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' })).json.item;
  await api('PATCH', `${pa}/wbs/${t.id}`, { status: 'COMPLETED' });
  await page.goto(`${BASE}${U}/wbs?sel=${t.id}`); await page.waitForSelector('[data-dx]', { timeout: 8000 });
  await page.click('[data-dx]'); await page.waitForTimeout(300);
  const ad = await page.evaluate(() => ({ s: document.querySelector('input[data-field="actual_start_date"]')?.value, e: document.querySelector('input[data-field="actual_end_date"]')?.value }));
  check('F4 drawer 더보기: 실적 시작일 / 실적 종료일 filled on 완료 (editable)', ad.s === today && ad.e === today, JSON.stringify(ad));
  await page.screenshot({ path: `${SHOTS}/04-wbs-actual.png` });

  /* ---------- F5 close dialog warns ---------- */
  await api('POST', `${pa}/wbs`, { item_type: 'TASK', title: '안정화 지원' });
  await api('POST', `${pa}/wbs`, { item_type: 'MILESTONE', title: '최종 검수', milestone_date: '2027-02-10' });
  sql(`UPDATE projects SET current_phase = 'OPERATIONS', status = 'ACTIVE' WHERE id = '${P.id}'`);
  await page.goto(`${BASE}${U}`); await settle();
  await page.evaluate(async ({ pa, pid }) => { const m = await import('/assets/project/closing.js'); const g = await (await fetch(pa)).json(); m.closeDialog(pid, g); }, { pa, pid: P.id });
  await page.waitForSelector('[data-close-dialog]', { timeout: 8000 });
  const warn = (await page.textContent('[data-cl-open]').catch(() => '')) || '';
  check('F5 close dialog: "완료되지 않은 작업 1건 · 마일스톤 1건" + WBS link', /작업 1건 · 마일스톤 1건/.test(warn) && /WBS에서 확인/.test(warn), warn);
  await page.screenshot({ path: `${SHOTS}/05-close-warn.png` });
  await page.click('[data-cl-wbs]'); await page.waitForURL(/\/wbs\?f=open/, { timeout: 8000 }); await page.waitForTimeout(800);
  const rows = await page.$$eval('#main tbody tr', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent));
  check('WBS link opens 미완료 filter: open task + milestone only', rows.length === 2 && rows.some((r) => /안정화 지원/.test(r)) && rows.some((r) => /최종 검수/.test(r)) && !rows.some((r) => /입고 화면 개발/.test(r)), JSON.stringify(rows.map((r) => r.slice(0, 40))));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const fail = results.filter(([, ok]) => !ok).length;
  log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
