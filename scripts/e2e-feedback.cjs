// In-app feedback (migration 48): '의견 남기기' at the bottom of the desktop rail (phone: a button on 설정) → modal → POST /api/feedback,
// rate limit shown inline, then 관리자 › 의견: badge, filters, detail with sender + page, status/note change with an audit row.
// Not part of `npm test` (needs a running server and Playwright). Run with samples off:
//   BASE=http://127.0.0.1:3461 SHOTS=research/relai-feedback DATABASE_URL=postgres://… node scripts/e2e-feedback.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3461';
const SHOTS = process.env.SHOTS || 'feedback-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const RUN = Date.now().toString(36);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (opts) => { const ctx = await browser.newContext({ locale: 'ko-KR', ...opts }); const p = await ctx.newPage(); p.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); }); return p; };
  const PC = { viewport: { width: 1440, height: 900 } }; const PHONE = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } };
  const api = async (pg, method, p, body) => { const r = await pg.request.fetch(BASE + p, { method, ...(body !== undefined ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const loaded = async (pg) => { await pg.waitForFunction(() => { const t = document.querySelector('#main')?.textContent || ''; return t.length > 40 && !/불러오는 중/.test(t); }, null, { timeout: 15000 }).catch(() => {}); await pg.waitForTimeout(500); };
  const signup = async (pg, email, name) => (await api(pg, 'POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name, email, password: 'passw0rd!' })).json;

  /* ---------- anonymous: API refuses ---------- */
  const anon = await newPage(PC);
  check('anonymous POST /api/feedback → 401', (await api(anon, 'POST', '/api/feedback', { category: 'BUG', message: 'x' })).status === 401);
  check('anonymous GET /api/admin/feedback → 401', (await api(anon, 'GET', '/api/admin/feedback')).status === 401);

  /* ---------- PC 1440: rail entry at the bottom ---------- */
  const page = await newPage(PC);
  const email = `fb-e2e-${RUN}@example.com`;
  const s = await signup(page, email, '의견러');
  const wid = s.workspaces[0].id; const uid = s.user.id;
  await page.goto(`${BASE}/app`); await loaded(page);
  const rail = await page.evaluate(() => { const r = document.querySelector('#rail'); const b = r?.querySelector('[data-feedback]'); if (!b) return null;
    const rr = r.getBoundingClientRect(); const br = b.getBoundingClientRect(); return { label: b.textContent.trim(), gap: Math.round(rr.bottom - br.bottom), below: br.top > r.querySelector('.rail__nav').getBoundingClientRect().bottom }; });
  check('rail (home): 의견 남기기 at the bottom of the rail', rail && rail.label === '의견 남기기' && rail.gap < 30 && rail.below, JSON.stringify(rail));
  await page.screenshot({ path: `${SHOTS}/01-rail-home-1440.png`, clip: { x: 0, y: 0, width: 420, height: 900 } });

  /* ---------- modal: required message, category, send ---------- */
  await page.click('#rail [data-feedback]');
  await page.waitForSelector('.fbdlg');
  const m = await page.evaluate(() => ({ cats: [...document.querySelectorAll('.fbdlg__cat span')].map((x) => x.textContent), checked: document.querySelector('.fbdlg [name=category]:checked')?.value, focus: document.activeElement?.id, max: document.querySelector('#fb-msg').maxLength }));
  check('modal: 4 categories 불편/개선 제안/오류/기타, 개선 제안 preselected, textarea focused, max 2000', m.cats.join() === '불편,개선 제안,오류,기타' && m.checked === 'SUGGESTION' && m.focus === 'fb-msg' && m.max === 2000, JSON.stringify(m));
  await page.screenshot({ path: `${SHOTS}/02-modal-1440.png` });
  await page.click('#fb-send');
  check('empty message: inline error, nothing sent', /내용을 입력해 주세요/.test(await page.textContent('[data-for=message]')) && sql(`SELECT COUNT(*) FROM feedback WHERE user_id = '${uid}'`) === '0');
  await page.click('.fbdlg__cat:has(input[value=BUG])');
  await page.fill('#fb-msg', `홈 화면에서 프로젝트 카드가 가끔 두 번 보여요. (${RUN})`);
  check('counter follows the text', /^\d+ \/ 2,000$/.test((await page.textContent('#fb-count')).trim()), await page.textContent('#fb-count'));
  await page.screenshot({ path: `${SHOTS}/03-modal-filled-1440.png` });
  await page.click('#fb-send');
  await page.waitForSelector('.toast', { timeout: 5000 }).catch(() => {});
  const toast = await page.textContent('.toast').catch(() => '');
  check('send → modal closes + success toast', !(await page.$('.fbdlg')) && /의견을 보냈습니다/.test(toast), toast);
  await page.screenshot({ path: `${SHOTS}/04-toast-1440.png` });
  const row = sql(`SELECT category || '|' || page_path || '|' || COALESCE(workspace_id,'') || '|' || COALESCE(project_id,'-') || '|' || status || '|' || (user_agent LIKE '%Chrome%')::text FROM feedback WHERE user_id = '${uid}'`);
  check('row stored with category, path, workspace id, user agent, status NEW', row === `BUG|/app|${wid}|-|NEW|true`, row);

  /* ---------- inside a project: project id attached; rail keeps the entry ---------- */
  const pr = await api(page, 'POST', `/api/workspaces/${wid}/projects`, { name: '의견 테스트 프로젝트', client_name: '고객사', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' });
  const pid = pr.json.project.id;
  await page.goto(`${BASE}/app/projects/${pid}/wbs`); await loaded(page);
  check('rail (project): 의견 남기기 still at the bottom', Boolean(await page.$('#rail [data-feedback]')));
  await page.screenshot({ path: `${SHOTS}/05-rail-project-1440.png`, clip: { x: 0, y: 0, width: 420, height: 900 } });
  await page.click('#rail [data-feedback]'); await page.fill('#fb-msg', 'WBS에서 여러 작업 기간을 한 번에 미루고 싶어요.'); await page.click('#fb-send');
  await page.waitForFunction(() => !document.querySelector('.fbdlg'), null, { timeout: 5000 }).catch(() => {});
  const prow = sql(`SELECT category || '|' || project_id || '|' || page_path FROM feedback WHERE user_id = '${uid}' AND project_id IS NOT NULL`);
  check('project page: project id + /wbs path attached', prow === `SUGGESTION|${pid}|/app/projects/${pid}/wbs`, prow);

  /* ---------- rate limit: 11th send in the hour → inline message ---------- */
  for (let i = 0; i < 8; i++) await api(page, 'POST', '/api/feedback', { category: 'OTHER', message: `반복 의견 ${i}` });
  await page.click('#rail [data-feedback]'); await page.fill('#fb-msg', '한 번 더'); await page.click('#fb-send');
  await page.waitForSelector('#fb-gen:not([hidden])', { timeout: 5000 }).catch(() => {});
  const rl = await page.textContent('#fb-gen').catch(() => '');
  check('rate limit (10/hour): modal stays open with the 429 message', /너무 많이/.test(rl) && Boolean(await page.$('.fbdlg')), rl);
  await page.screenshot({ path: `${SHOTS}/06-rate-limit-1440.png` });
  await page.keyboard.press('Escape');
  check('Esc closes the modal', !(await page.$('.fbdlg')));
  check('non-operator: /api/admin/feedback → 403', (await api(page, 'GET', '/api/admin/feedback')).status === 403);

  /* ---------- phone 390: 설정 button ---------- */
  const ph = await newPage(PHONE);
  await signup(ph, `fb-e2e-ph-${RUN}@example.com`, '폰사용자');
  await ph.goto(`${BASE}/app/settings`); await loaded(ph);
  check('phone 390: 의견 남기기 button on 설정 (no rail on phone)', Boolean(await ph.$('#main .phone-feedback[data-feedback]')));
  await ph.screenshot({ path: `${SHOTS}/07-phone-settings-390.png`, fullPage: true });
  await ph.click('#main [data-feedback]'); await ph.waitForSelector('.fbdlg');
  const over = await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await ph.fill('#fb-msg', '휴대폰에서도 보낼 수 있네요.'); await ph.screenshot({ path: `${SHOTS}/08-phone-modal-390.png` });
  await ph.click('#fb-send'); await ph.waitForSelector('.toast', { timeout: 5000 }).catch(() => {});
  check('phone 390: modal fits (no horizontal scroll) and sends in view mode', over <= 0 && /의견을 보냈습니다/.test(await ph.textContent('.toast').catch(() => '')), String(over));

  /* ---------- admin console › 의견 ---------- */
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = '${uid}'`);
  const newCount = Number(sql(`SELECT COUNT(*) FROM feedback WHERE status = 'NEW'`)); const allCount = Number(sql('SELECT COUNT(*) FROM feedback'));
  await page.goto(`${BASE}/admin/feedback`); await loaded(page);
  await page.waitForFunction(() => { const b = document.querySelector('[data-fb-badge]'); return b && !b.hidden; }, null, { timeout: 5000 }).catch(() => {});
  const nav = await page.evaluate(() => ({ active: document.querySelector('.aside__nav a.is-active')?.textContent, badge: document.querySelector('[data-fb-badge]')?.textContent, rows: document.querySelectorAll('#fb-tbl tbody tr[data-href]').length }));
  check(`admin: 의견 tab active, badge = new count (${newCount}), rows listed`, /^의견/.test(nav.active || '') && nav.badge === String(newCount) && nav.rows === Math.min(50, allCount), JSON.stringify(nav));
  await page.screenshot({ path: `${SHOTS}/09-admin-list-1440.png`, fullPage: true });
  await page.selectOption('[data-f=category]', 'BUG'); await page.waitForTimeout(800);
  const bugs = await page.$$eval('#fb-tbl tbody tr[data-href]', (r) => r.length);
  check('admin: 종류 filter (오류) narrows the list', bugs === Number(sql(`SELECT COUNT(*) FROM feedback WHERE category = 'BUG'`)) && bugs >= 1, String(bugs));
  await page.fill('[data-f=q]', RUN); await page.waitForTimeout(900);
  check('admin: search by text', (await page.$$eval('#fb-tbl tbody tr[data-href]', (r) => r.length)) === 1);
  await page.screenshot({ path: `${SHOTS}/10-admin-filtered-1440.png`, fullPage: true });
  await page.click('#fb-tbl tbody tr[data-href]'); await loaded(page);
  const det = await page.evaluate(() => ({ msg: document.querySelector('#fb-message')?.textContent, text: document.querySelector('#main').textContent }));
  check('detail: message, sender name + email, page path, browser', /두 번 보여요/.test(det.msg || '') && det.text.includes('의견러') && det.text.includes(email) && /페이지\s*\/app/.test(det.text) && /Chrome/.test(det.text), det.text.slice(0, 300));
  await page.screenshot({ path: `${SHOTS}/11-admin-detail-1440.png`, fullPage: true });
  await page.selectOption('#fb-status', 'IN_REVIEW'); await page.fill('#fb-note', '홈 카드 중복 — 재현 중');
  await page.click('#fb-save'); await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({ log: document.querySelector('.afb__log')?.textContent || '', badge: document.querySelector('[data-fb-badge]')?.textContent, chip: document.querySelector('.ahead .achip')?.textContent }));
  check('save: status 검토 중 + note stored, 처리 기록 shows the audit row, badge −1', after.chip === '검토 중' && /새 의견 → 검토 중 · 메모 수정/.test(after.log) && after.badge === String(newCount - 1)
    && sql(`SELECT status || '|' || admin_note FROM feedback WHERE message LIKE '%${RUN}%'`) === 'IN_REVIEW|홈 카드 중복 — 재현 중', JSON.stringify(after));
  check('audit log row FEEDBACK_UPDATE by the operator', sql(`SELECT COUNT(*) FROM admin_audit_logs WHERE action = 'FEEDBACK_UPDATE' AND admin_user_id = '${uid}'`) === '1');
  await page.screenshot({ path: `${SHOTS}/12-admin-detail-saved-1440.png`, fullPage: true });
  await page.goto(`${BASE}/admin/audit`); await loaded(page);
  check('감사 로그 lists 의견 처리', /의견 처리/.test(await page.textContent('#main')));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const fail = results.filter((r) => !r[1]).length;
  log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
