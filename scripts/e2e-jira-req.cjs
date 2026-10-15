// Requirement ↔ Jira (v43) in the browser against the in-memory fake Jira. Not part of `npm test`.
// Needs a server started with INTEGRATION_PROVIDER=fake (mounts POST /api/integrations/jira/fake/status, which plays "someone changed the status in Jira").
//   BASE=http://127.0.0.1:3311 SHOTS=/tmp/jira node scripts/e2e-jira-req.cjs
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3311';
const SHOTS = process.env.SHOTS || 'jira-req-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const mkApi = (pg) => async (method, p, body) => { const r = await pg.request.fetch(BASE + p, { method, ...(body ? { data: body } : {}), headers: { 'Content-Type': 'application/json' }, maxRedirects: 0 }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const api = mkApi(page);
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const text = async (sel) => (await page.textContent(sel).catch(() => '')) || '';
  const email = `jira-${Date.now()}@relai.test`;
  await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김피엠', email, password: 'passw0rd!' });
  const me = (await api('GET', '/api/me')).json; const w = me.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: '한빛몰 리뉴얼', client_name: '한빛', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`;
  const R = []; for (const [t, c] of [['주문 조회', ['주문번호로 조회된다']], ['배송 조회', []], ['반품 신청', []]]) R.push((await api('POST', `${pa}/requirements`, { title: t, scope: 'IN_SCOPE', status: 'CONFIRMED', description: `${t} 기능`, criteria: c })).json.requirement);
  const openJiraTab = async (rid) => { await page.goto(`${BASE}${U}/requirements?sel=${rid}&tab=jira`); await page.waitForSelector('[data-pane="jira"]:not([hidden]) .jhead, [data-pane="jira"]:not([hidden]) [data-jira-empty]', { timeout: 8000 }).catch(() => {}); };

  /* 1. not connected: one sentence + 지라 연결 (OWNER) */
  await openJiraTab(R[0].id);
  check('J1 drawer has a Jira tab', await page.locator('.dtabs [data-dtab="jira"]').count() === 1);
  check('J1 not connected → one sentence', /워크스페이스에 Jira가 연결되어 있지 않습니다/.test(await text('[data-pane="jira"]')));
  check('J1 OWNER sees 지라 연결 button', await page.locator('[data-pane="jira"] [data-jira-connect]').isVisible().catch(() => false));
  await shot('01-not-connected');

  /* 2. member (not OWNER/ADMIN) sees the request sentence, no button */
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }); const p2 = await ctx2.newPage(); const api2 = mkApi(p2);
  const memEmail = `jira-m-${Date.now()}@relai.test`;
  await api2('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '이멤버', email: memEmail, password: 'passw0rd!' });
  await api('POST', `/api/workspaces/${w}/members`, { email: memEmail, role: 'MEMBER' });
  const m2 = (await api2('GET', '/api/me')).json; const mw = m2.workspaces.find((x) => x.id === w);
  if (mw) await api2('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  await p2.goto(`${BASE}/app/projects/${P.id}/requirements?sel=${R[0].id}&tab=jira`).catch(() => {});
  await p2.waitForSelector('[data-pane="jira"] [data-jira-empty]', { timeout: 8000 }).catch(() => {});
  const memTxt = (await p2.textContent('[data-pane="jira"]').catch(() => '')) || '';
  check('J2 MEMBER: ask owner/admin, no connect button', /소유자·관리자에게 연결을 요청하세요/.test(memTxt) && await p2.locator('[data-jira-connect]').count() === 0, memTxt.slice(0, 120));

  /* 3. connect (OAuth round trip on the fake) → not mapped → 'Jira 프로젝트 연결' opens the mapping modal */
  const st = await api('POST', `/api/workspaces/${w}/integrations/jira/connect`, {});
  const cb = await api('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(st.json.state)}`);
  check('J3 OAuth callback redirects', cb.status === 302, String(cb.status));
  await openJiraTab(R[0].id);
  check('J3 connected, unmapped → one sentence', /이 프로젝트에 연결된 Jira 프로젝트가 없습니다/.test(await text('[data-pane="jira"]')));
  await page.click('[data-pane="jira"] [data-jira-map]');
  await page.waitForSelector('.scrim--jira #jp-key option[value="ABC"]', { timeout: 8000 }).catch(() => {});
  await page.selectOption('.scrim--jira #jp-key', 'ABC');
  await page.waitForFunction(() => { const s = document.querySelector('.scrim--jira #jp-leaf'); return s && !s.disabled && s.value; }, null, { timeout: 8000 }).catch(() => {});
  check('J3 mapping modal has the requirement toggle, default off', await page.locator('.scrim--jira #jp-mark').count() === 1 && !(await page.isChecked('.scrim--jira #jp-mark')));
  await shot('02-mapping');
  await page.click('.scrim--jira #jp-save');
  await page.waitForSelector('.scrim--jira #jp-sync', { timeout: 8000 }).catch(() => {});
  check('J3 mapping saved', /ABC/.test(await text('.scrim--jira .jinfo')));
  await page.click('.scrim--jira [data-close]');

  /* 4. 지라 태스크 만들기 from the drawer */
  await openJiraTab(R[0].id);
  check('J4 empty linked state + two actions', /아직 연결된 Jira 이슈가 없습니다/.test(await text('[data-pane="jira"]')) && await page.locator('#rjcreate').isEnabled() && await page.locator('#rjlink').isVisible());
  await page.click('#rjcreate');
  const sum = await page.inputValue('#rjc-summary');
  check('J4 summary = REQ-ID + 제목', sum === `${R[0].display_id} 주문 조회`, sum);
  await page.click('#rjc-ok');
  await page.waitForSelector('[data-rjira-list] .jrow', { timeout: 8000 }).catch(() => {});
  const key1 = (await text('[data-rjira-list] .jrow__k')).trim();
  check('J4 issue created and shown with key + status chip + link', /^ABC-\d+$/.test(key1) && /To Do/.test(await text('[data-rjira-list] .jrow')) && /\/browse\/ABC-/.test(await page.getAttribute('[data-rjira-list] .jrow__k', 'href') || ''), key1);
  check('J4 지라 진행률 0 / 1', /지라 진행률\s*0 \/ 1 완료/.test(await text('[data-jira-rate]')));
  check('J4 tab count 1', /Jira\s*1/.test(await text('.dtabs [data-dtab="jira"]')));
  await shot('03-created');

  /* 5. bulk 지라 태스크 만들기 from the list (select mode) */
  await page.goto(`${BASE}${U}/requirements?select=1`);
  await page.waitForSelector(`tr[data-id="${R[1].id}"] [data-pick]`);
  for (const r of [R[0], R[1]]) await page.check(`tr[data-id="${r.id}"] [data-pick]`);
  await page.waitForSelector('.bulk [data-bextra="jira"]', { timeout: 5000 }).catch(() => {});
  check('J5 bulk bar shows 지라 태스크 만들기', await page.locator('.bulk [data-bextra="jira"]').isVisible().catch(() => false));
  await page.click('.bulk [data-bextra="jira"]');
  await page.click('.scrim [data-v="1"]');
  await page.waitForSelector('.toast', { timeout: 8000 }).catch(() => {});
  const bt = await text('.toast');
  check('J5 bulk: 1 created, the already-linked one skipped', /지라 태스크 1건을 만들었습니다/.test(bt) && /건너뜀/.test(bt), bt);
  const lst = (await api('GET', `${pa}/requirements`)).json;
  check('J5 list API carries the Jira map', lst.jira && lst.jira.by[R[1].id] && lst.jira.by[R[1].id].total === 1);

  /* 6. 기존 이슈 연결 (an issue already linked to another requirement is allowed) */
  await openJiraTab(R[2].id);
  await page.click('#rjlink');
  await page.waitForSelector('#jl-list [data-pick]', { timeout: 8000 }).catch(() => {});
  await page.click(`#jl-list [data-pick]:has-text("${key1}")`);
  await page.click('#jl-ok');
  await page.waitForSelector('[data-rjira-list] .jrow', { timeout: 8000 }).catch(() => {});
  check('J6 linked existing issue', (await text('[data-rjira-list]')).includes(key1));

  /* 7. status changes in Jira → 새로고침 → chip + 지라 진행률; requirement status unchanged */
  await api('POST', '/api/integrations/jira/fake/status', { key: key1, status: 'done' });
  await page.click('#rjrefresh');
  await page.waitForFunction(() => /1 \/ 1 완료 · 100%/.test(document.querySelector('[data-jira-rate]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('J7 chip shows Done after sync', /Done/.test(await text('[data-rjira-list] .jrow')));
  check('J7 지라 진행률 100%', /1 \/ 1 완료 · 100%/.test(await text('[data-jira-rate]')));
  check('J7 no 구현 완료 mark while the toggle is off', await page.locator('[data-jira-done]').count() === 0);
  check('J7 requirement status still 확정', (await api('GET', `${pa}/requirements/${R[2].id}`)).json.requirement.status === 'CONFIRMED');
  await shot('04-synced');

  /* 8. toggle on → '구현 완료 (Jira)' mark; status unchanged */
  const mp = (await api('GET', `${pa}/integrations/jira`)).json.mapping;
  await api('PUT', `${pa}/integrations/jira/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: mp.leaf_issue_type_id, auto_mark_requirements: true });
  await openJiraTab(R[2].id);
  check('J8 구현 완료 (Jira) mark with the toggle on', await page.locator('[data-jira-done]').isVisible().catch(() => false));
  check('J8 status still 확정', (await api('GET', `${pa}/requirements/${R[2].id}`)).json.requirement.status === 'CONFIRMED');

  /* 9. 요구사항 › 추적 shows the linked Jira issues; list has a Jira column option */
  await page.goto(`${BASE}${U}/requirements?view=trace`);
  await page.waitForSelector('.rjcell', { timeout: 8000 }).catch(() => {});
  check('J9 추적 view: Jira column with keys', (await page.locator('.rjcell').count()) >= 3 && (await text('main')).includes(key1));
  await shot('05-trace');
  await page.goto(`${BASE}${U}/requirements`);
  await page.click('[data-tmore]');
  await page.click('.tmenu [data-gcols]').catch(() => {});
  check('J9 list: Jira column option', await page.locator('.gpop [data-gcol="jira"]').count() === 1);
  await page.check('.gpop [data-gcol="jira"]').catch(() => {});
  await page.waitForSelector('.gtable .rjcell', { timeout: 5000 }).catch(() => {});
  check('J9 list: Jira column shows keys when on', (await page.locator('.gtable .rjcell').count()) >= 1);
  await page.keyboard.press('Escape');

  /* 10. unlink */
  await openJiraTab(R[2].id);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-rjira-list] [data-junlink]');
  await page.click('.scrim [data-v="1"]').catch(() => {});
  await page.waitForSelector('[data-pane="jira"] .empty-inline', { timeout: 8000 }).catch(() => {});
  check('J10 unlink → back to empty linked state', /아직 연결된 Jira 이슈가 없습니다/.test(await text('[data-pane="jira"]')));

  /* 11. WBS link of the same issue still works (WBS rule unchanged) */
  const wi = (await api('POST', `${pa}/wbs`, { title: '주문 조회 개발' })).json.item;
  const wl = await api('POST', `${pa}/wbs/${wi.id}/jira/links`, { issue_keys: [key1] });
  check('J11 same issue can be linked to a WBS leaf', wl.status === 201 && wl.json.results[0].ok, JSON.stringify(wl.json).slice(0, 160));

  /* 12. disconnect → connect state again */
  await api('POST', `/api/workspaces/${w}/integrations/jira/disconnect`, {});
  await openJiraTab(R[0].id);
  check('J12 disconnected → 지라 연결 again', await page.locator('[data-pane="jira"] [data-jira-connect]').isVisible().catch(() => false));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const fails = results.filter(([, ok]) => !ok).length;
  log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
