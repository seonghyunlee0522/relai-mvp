// batch7 #24 / B6 + T5: every FREE limit point answers 402 with the upsell target, and inside the app the same 402 opens the upsell
// dialog with its 플랜 살펴보기 CTA. Points: 3rd project, project unarchive over the limit, 4th member (direct add + invitation),
// 51st requirement (single + Excel import + AI commit), 101st WBS (single + import + AI commit + 뼈대), 9th weekly report this month.
// A fresh signup is used as-is: early access no longer lifts the limits (founder decision 2026-10-20).
// Not part of `npm test` (needs a running server, Playwright and psql):
//   BASE=http://127.0.0.1:3595 SHOTS=research/relai-b7-t5 DATABASE_URL=postgres://… node scripts/e2e-batch7-limits.cjs
//   server: PLAN_LIMITS unset (on), PAYMENTS_ENABLED unset, SAMPLE_PROJECTS=false, AI_ENABLED=true AI_PROVIDER=fake
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

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body, c = page) => { const r = await c.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const viaApp = (method, url, body) => page.evaluate(async ([m, u, b]) => { const { api: call } = await import('/assets/core/api.js'); try { await call(m, u, b); return null; } catch (e) { return { status: e.status, code: e.code }; } }, [method, url, body]);
  const signup = async (c, name, email) => { const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name, email, password: 'passw0rd!' }, c); sql(`UPDATE users SET email_verified_at = now() WHERE email = '${esc(email)}'`); return s.json; };

  const tag = Date.now();
  await page.goto(BASE + '/login');
  const s = await signup(page, '한도테스트', `b7lim-${tag}@relai.test`);
  const w = s.workspaces[0].id; const W = `/api/workspaces/${w}`;
  await api('POST', `${W}/onboarding/product_tour/skip`, {});
  const body = (name) => ({ name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-11-02', planned_end_date: '2027-03-31' });
  const p1 = (await api('POST', `${W}/projects`, body('한도 1'))).json.project;
  const p2 = (await api('POST', `${W}/projects`, body('한도 2'))).json.project;
  const P = `${W}/projects/${p1.id}`;
  await page.goto(`${BASE}/app`); await page.waitForSelector('#main');

  /** One limit point: the API answers 402 plan_limit_reached → /app/billing/plans, and through the app the upsell dialog shows its CTA. */
  const point = async (name, method, url, payload, { dim, allowed } = {}) => {
    const r = await api(method, url, payload);
    const e = r.json?.error || {};
    check(`${name}: 402 → plans page`, r.status === 402 && e.code === 'plan_limit_reached' && e.upgrade?.url === '/app/billing/plans' && (!dim || e.limit?.dimension === dim) && (allowed === undefined || e.limit?.allowed === allowed),
      `${r.status} ${e.code} ${e.limit?.dimension} allowed=${e.limit?.allowed}`);
    const ae = await viaApp(method, url, payload);
    const dlg = page.locator('.dialog:has([data-upsell])');
    await dlg.waitFor({ timeout: 4000 }).catch(() => {});
    const cta = await dlg.locator('[data-v="1"]').textContent().catch(() => '');
    check(`${name}: upsell CTA in the app`, ae?.status === 402 && cta.trim() === '플랜 살펴보기', `${JSON.stringify(ae)} cta=${cta}`);
    await dlg.locator('[data-v="0"]').click().catch(() => {});
    await dlg.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  };

  /* projects: 2 → 3rd refused; archive one, create, unarchive refused */
  await point('#24 project 3', 'POST', `${W}/projects`, body('한도 3'), { dim: 'projects' });
  await api('POST', `${W}/projects/${p2.id}/archive`, {});
  const p3 = await api('POST', `${W}/projects`, body('한도 3b'));
  check('archive frees a slot', p3.status === 201);
  await point('#24 unarchive over the limit', 'POST', `${W}/projects/${p2.id}/unarchive`, {}, { dim: 'projects' });

  /* members: owner + 2 → 4th refused (direct add, invitation) */
  for (const n of [1, 2]) {
    const c = await browser.newContext(); const pg = await c.newPage();
    const em = `b7lim-m${n}-${tag}@relai.test`; await signup(pg, `멤버${n}`, em);
    check(`member ${n + 1} added`, (await api('POST', `${W}/members`, { email: em, role: 'MEMBER' })).status === 201);
    await c.close();
  }
  { const c = await browser.newContext(); const pg = await c.newPage(); await signup(pg, '멤버3', `b7lim-m3-${tag}@relai.test`); await c.close(); }
  await point('#24 member 4 (direct add)', 'POST', `${W}/members`, { email: `b7lim-m3-${tag}@relai.test`, role: 'MEMBER' }, { dim: 'members' });
  await point('#24 member 4 (invitation)', 'POST', `${W}/invitations`, { email: `b7lim-inv-${tag}@relai.test`, role: 'MEMBER' }, { dim: 'members' });

  /* requirements: 48 by import → import 5 / AI commit 3 refused (allowed 2) → 2 single → 51st refused */
  const rrows = (n, p) => Array.from({ length: n }, (_, i) => ({ row: i + 2, values: { title: `${p}${i}` } }));
  check('48 requirements imported', (await api('POST', `${P}/requirements/import`, { rows: rrows(48, 'r') })).status === 200);
  await point('#24 requirements import over the limit', 'POST', `${P}/requirements/import`, { rows: rrows(5, 'x') }, { dim: 'requirements', allowed: 2 });
  await point('#24 requirements AI commit over the limit', 'POST', `${P}/ai/requirements/commit`, { candidates: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }, { dim: 'requirements', allowed: 2 });
  for (const t of ['y1', 'y2']) await api('POST', `${P}/requirements`, { title: t });
  await point('#24 requirement 51', 'POST', `${P}/requirements`, { title: '51번째' }, { dim: 'requirements' });

  /* WBS: 뼈대 on an empty project that does not fit → refused whole; 97 imported → import 4 / AI commit 4 refused (allowed 3) → 3 single → 101st refused */
  const wrows = (n, p) => Array.from({ length: n }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `${p}${i}` } }));
  check('97 WBS items imported', (await api('POST', `${P}/wbs/import`, { rows: wrows(97, 'w') })).status === 200);
  const P3 = `${W}/projects/${p3.json.project.id}`;
  await point('#24 WBS 뼈대 over the limit', 'POST', `${P3}/wbs/skeleton`, {}, { dim: 'wbs' });
  await point('#24 WBS import over the limit', 'POST', `${P}/wbs/import`, { rows: wrows(4, 'z') }, { dim: 'wbs', allowed: 3 });
  await point('#24 WBS AI commit over the limit', 'POST', `${P}/ai/wbs/commit`, { items: Array.from({ length: 4 }, (_, i) => ({ temp_id: `t${i}`, item_type: 'TASK', title: `ai${i}` })) }, { dim: 'wbs', allowed: 3 });
  for (const t of ['d1', 'd2', 'd3']) await api('POST', `${P}/wbs`, { title: t, item_type: 'TASK' });
  await point('#24 WBS 101', 'POST', `${P}/wbs`, { title: '101번째', item_type: 'TASK' }, { dim: 'wbs' });

  /* weekly reports: 8 this month → 9th refused */
  const today = new Date(); const ymd = (d) => d.toISOString().slice(0, 10);
  const period = { period_start: ymd(new Date(today.getTime() - 6 * 864e5)), period_end: ymd(today) };
  let made = 0; for (let i = 0; i < 8; i++) if ((await api('POST', `${P}/weekly-reports/generate`, period)).status === 201) made += 1;
  check('8 weekly reports generated', made === 8, String(made));
  await point('#24 weekly report 9', 'POST', `${P}/weekly-reports/generate`, period, { dim: 'weekly_reports' });

  /* existing data untouched: everything created above is still there and editable */
  const reqs = (await api('GET', `${P}/requirements`)).json.requirements;
  check('existing requirements kept (50) and editable', reqs.length === 50 && (await api('PATCH', `${P}/requirements/${reqs[0].id}`, { title: '수정됨' })).status === 200, String(reqs.length));
  await page.goto(`${BASE}/app/settings?tab=plan`); await page.waitForSelector('#plan-limits');
  check('settings plan line shows the limits', /진행 중 프로젝트 2\/2/.test(await page.textContent('#plan-limits')) && /WBS 100\/100/.test(await page.textContent('#plan-limits')), await page.textContent('#plan-limits'));
  await page.screenshot({ path: path.join(SHOTS, 't5-settings-limits.png') });

  await browser.close();
  const fails = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
