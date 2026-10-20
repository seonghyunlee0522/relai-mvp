// 구독 해지 · Free 전환 · 조회 전용 browser check (founder policy 2026-10-21) on the fake billing provider (no real payment):
//   Pro (3 projects) → 플랜 · 결제 shows the policy panel; 해지 dialog states the policy (newest project editable, rest 조회 전용,
//   nothing deleted, re-subscribe restores); period end → daily cron → FREE → Billing lists editable / 조회 전용 projects; the older
//   projects carry the 조회 전용 banner + chip and refuse writes (409 project_read_only); the newest has none; 375px: banner, no
//   horizontal scroll; re-subscribe → banner gone.
//   BASE=http://127.0.0.1:3872 DATABASE_URL=postgres://… CRON_SECRET=… SHOTS=… node scripts/e2e-downgrade.cjs
//   Server: PAYMENTS_ENABLED=true NICEPAY_RECURRING_ENABLED=true BILLING_PROVIDER=fake CRON_SECRET=…
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3872';
const SHOTS = process.env.SHOTS || 'downgrade-shots';
const DB = process.env.DATABASE_URL;
const CRON = process.env.CRON_SECRET || '';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const q = (s) => String(s).replace(/'/g, "''");
const CARD = { number: '4242424242424242', expiry: '12/29', id_no: '800101', password2: '12' };
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const project = (name) => ({ name, client_name: '고객사', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' });

async function context(browser, phone) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 375, height: 812 }, locale: 'ko-KR', isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body ?? {}, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  return { ctx, page, api, errors, shot: (n) => page.screenshot({ path: `${SHOTS}/${n}`, fullPage: true }) };
}
const subscribe = async (a, W) => {
  const hq = (await a.api('GET', `/api/workspaces/${W}/billing/quote?plan=PRO&cycle=MONTHLY`)).json.disclosure.hash;
  return a.api('POST', `/api/workspaces/${W}/billing/recurring`, { plan: 'PRO', cycle: 'MONTHLY', card: CARD, agree: true, disclosure_hash: hq });
};

(async () => {
  const browser = await chromium.launch();
  const a = await context(browser, false);
  await a.page.goto(BASE + '/login');
  const email = `v3dg-${Date.now()}@relai.test`;
  const s = await a.api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '해지테스트', email, password: 'passw0rd!' });
  const W = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE id = '${q(s.json.user.id)}'`);
  const sub = await subscribe(a, W);
  check('Pro monthly subscribed (API)', sub.status === 201, JSON.stringify(sub.json?.error || ''));
  const ids = [];
  for (const n of ['첫 프로젝트', '둘째 프로젝트', '최신 프로젝트']) { const r = await a.api('POST', `/api/workspaces/${W}/projects`, project(n)); ids.push(r.json?.project?.id); }
  check('3 projects on Pro', ids.every(Boolean), JSON.stringify(ids));
  ids.forEach((id, i) => sql(`UPDATE projects SET created_at = now() - interval '${30 - i} minutes' WHERE id = '${q(id)}'`));
  const [oldest, , newest] = ids;

  /* ---------- 1. 플랜 · 결제: policy panel + 해지 dialog ---------- */
  await a.page.goto(`${BASE}/app/settings/billing`); await a.page.waitForSelector('#bl-cancel', { timeout: 8000 }).catch(() => {});
  const pol = await a.page.textContent('#bl-policy').catch(() => '');
  check('billing: policy panel (newest 1 editable, rest 조회 전용, not deleted, re-subscribe restores)', /가장 최근인 프로젝트 1개/.test(pol) && /조회 전용/.test(pol) && /삭제되지 않/.test(pol) && /편집 권한이 돌아/.test(pol), pol.slice(0, 80));
  await a.page.click('#bl-cancel');
  await a.page.waitForSelector('#bl-cancel-policy', { timeout: 5000 }).catch(() => {});
  const dlg = await a.page.textContent('.dialog').catch(() => '');
  check('cancel dialog: states the Free policy', /가장 최근인 프로젝트 1개/.test(dlg) && /선택할 수 없/.test(dlg) && /삭제되지 않/.test(dlg) && /워크스페이스 삭제는 해지와 별도/.test(dlg));
  await a.shot('01-cancel-dialog.png');
  await a.page.click('.dialog [data-v="1"]');
  await a.page.waitForSelector('#bl-cancel-pending', { timeout: 8000 }).catch(() => {});
  check('cancel: auto-renew off, Pro until the period end', sql(`SELECT auto_renew||'|'||cancel_at_period_end||'|'||plan FROM subscriptions WHERE workspace_id = '${q(W)}'`) === 'false|true|PRO');
  const before = sql(`SELECT (SELECT COUNT(*) FROM projects WHERE workspace_id = '${q(W)}')||'|'||(SELECT COUNT(*) FROM project_phases ph JOIN projects p ON p.id = ph.project_id WHERE p.workspace_id = '${q(W)}')`);

  /* ---------- 2. period end → cron → FREE ---------- */
  sql(`UPDATE subscriptions SET current_period_end = now() - interval '1 minute', next_billing_at = NULL WHERE workspace_id = '${q(W)}'`);
  if (CRON) {
    const r = await a.page.request.fetch(`${BASE}/api/billing/cron/daily`, { headers: { Authorization: `Bearer ${CRON}` } });
    check('cron: subscription expired', r.status() === 200 && sql(`SELECT status FROM subscriptions WHERE workspace_id = '${q(W)}'`) === 'EXPIRED');
    check('cron: Free-transition mail recorded', sql(`SELECT COUNT(*) FROM email_deliveries WHERE workspace_id = '${q(W)}' AND type = 'BILLING_FREE_TRANSITION'`) === '1');
  }
  await a.page.goto(`${BASE}/app/settings/billing`); await a.page.waitForSelector('#bl-over', { timeout: 8000 }).catch(() => {});
  const ro = await a.page.textContent('#bl-ro').catch(() => '');
  check('billing (Free): lists the editable and the 조회 전용 projects', /편집 가능: 최신 프로젝트/.test(ro) && /조회 전용 2개/.test(ro) && /첫 프로젝트/.test(ro), ro);
  await a.shot('02-billing-free.png');

  /* ---------- 3. project screens: banner + chip, writes refused ---------- */
  await a.page.goto(`${BASE}/app/projects/${oldest}`); await a.page.waitForSelector('#ro-banner', { timeout: 8000 }).catch(() => {});
  const ban = await a.page.textContent('#ro-banner').catch(() => '');
  check('older project: 조회 전용 banner with the policy', /조회 전용 프로젝트/.test(ban) && /가장 최근에 만든 프로젝트 1개/.test(ban) && /삭제되지 않/.test(ban), ban.slice(0, 80));
  await a.shot('03-readonly-banner.png');
  await a.page.goto(`${BASE}/app/projects/${oldest}/requirements`); await a.page.waitForSelector('#ro-banner', { timeout: 8000 }).catch(() => {});
  check('older project › 요구사항: banner on the sub-screen too', await a.page.locator('#ro-banner').count() === 1);
  await a.page.goto(`${BASE}/app/projects/${newest}`); await a.page.waitForTimeout(1200);
  check('newest project: no banner (editable)', await a.page.locator('#ro-banner').count() === 0);
  const w1 = await a.api('POST', `/api/workspaces/${W}/projects/${oldest}/requirements`, { title: '막힘', description: 'x' });
  const w2 = await a.api('POST', `/api/workspaces/${W}/projects/${newest}/requirements`, { title: '열림', description: 'x' });
  check('older project write → 409 project_read_only; newest → 201', w1.status === 409 && w1.json?.error?.code === 'project_read_only' && w2.status === 201, `${w1.status} ${w2.status}`);
  await a.page.goto(`${BASE}/app/projects`); await a.page.waitForTimeout(1500);
  check('projects list: 조회 전용 chip on the 2 older projects', await a.page.locator('[data-ro-badge]').count() >= 2);
  await a.shot('04-projects-list.png');
  const after = sql(`SELECT (SELECT COUNT(*) FROM projects WHERE workspace_id = '${q(W)}')||'|'||(SELECT COUNT(*) FROM project_phases ph JOIN projects p ON p.id = ph.project_id WHERE p.workspace_id = '${q(W)}')`);
  check('nothing deleted (projects | phases)', after === before, `${before} → ${after}`);
  check('desktop: no page errors', !a.errors.length, a.errors.join(' | '));

  /* ---------- 4. 375px ---------- */
  const m = await context(browser, true);
  await m.ctx.addCookies((await a.ctx.cookies()).map((c) => ({ ...c })));
  await m.page.goto(`${BASE}/app/projects/${oldest}`); await m.page.waitForSelector('#ro-banner', { timeout: 8000 }).catch(() => {});
  check('375px: 조회 전용 banner on the older project', await m.page.locator('#ro-banner').count() === 1);
  check('375px: project page without horizontal scroll', await noHScroll(m.page));
  await m.shot('05-readonly-375.png');
  await m.page.goto(`${BASE}/app/settings/billing`); await m.page.waitForSelector('#bl-over', { timeout: 8000 }).catch(() => {});
  check('375px: Billing shows the 조회 전용 list', /조회 전용 2개/.test(await m.page.textContent('#bl-ro').catch(() => '')));
  check('375px: Billing without horizontal scroll', await noHScroll(m.page));
  await m.shot('06-billing-375.png');
  check('375px: no page errors', !m.errors.length, m.errors.join(' | '));

  /* ---------- 5. re-subscribe → edit access back (Pro: 3 projects) ---------- */
  const re = await subscribe(a, W);
  check('re-subscribe Pro (API)', re.status === 201, JSON.stringify(re.json?.error || ''));
  await a.page.goto(`${BASE}/app/projects/${oldest}`); await a.page.waitForTimeout(1500);
  check('after re-subscribe: banner gone, write works', await a.page.locator('#ro-banner').count() === 0 && (await a.api('POST', `/api/workspaces/${W}/projects/${oldest}/requirements`, { title: '복원', description: 'x' })).status === 201);
  await a.shot('07-restored.png');

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
