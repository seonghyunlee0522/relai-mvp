// 회원 탈퇴 = hard delete (migration 56): a member who wrote in a shared workspace deletes the account from 설정 › 내 정보 › 위험 구역;
// the users row is gone, the owner still sees the work with the author '탈퇴한 사용자', and the same e-mail signs up as a new, empty account.
// Not part of `npm test` (needs a running server + Playwright + psql). Samples off.
//   BASE=http://127.0.0.1:3561 SHOTS=/tmp/hd DATABASE_URL=postgres://… node scripts/e2e-user-harddelete.cjs
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3561';
const SHOTS = process.env.SHOTS || '/tmp/hd';
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; const log = (...a) => console.log(...a);
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const W = '탈퇴한 사용자';

(async () => {
  const browser = await chromium.launch();
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('PAGEERROR', e.message));
    const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
    return { ctx, page, api }; };
  const t = Date.now(); const ownerEmail = `hd-owner-${t}@relai.test`; const leaverEmail = `hd-leaver-${t}@relai.test`;
  const A = await mk(); const B = await mk();
  await A.api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김오너', email: ownerEmail, password: 'passw0rd!' });
  await B.api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '박떠남', email: leaverEmail, password: 'passw0rd!' });
  sql(`UPDATE users SET email_verified_at = now() WHERE email IN ('${ownerEmail}', '${leaverEmail}')`);
  const w = (await A.api('GET', '/api/me')).json.workspaces[0].id;
  const bUid = (await B.api('GET', '/api/me')).json.user.id;
  for (const X of [A, B]) { const ws = (await X.api('GET', '/api/me')).json.workspaces[0].id; await X.api('POST', `/api/workspaces/${ws}/onboarding/product_tour/skip`, {}); }
  check('owner adds the member', (await A.api('POST', `/api/workspaces/${w}/members`, { email: leaverEmail, role: 'MEMBER' })).status === 201);
  const P = (await A.api('POST', `/api/workspaces/${w}/projects`, { name: '탈퇴 확인 프로젝트', client_name: '고객사', project_type: 'NEW_BUILD', planned_start_date: '2026-10-01', planned_end_date: '2027-01-31' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`;
  const req = (await B.api('POST', `${pa}/requirements`, { title: '멤버가 쓴 요구사항', description: '' })).json.requirement;
  await B.api('POST', `${pa}/requirements/${req.id}/comments`, { body: '멤버의 댓글' });
  await B.api('PATCH', `${pa}/requirements/${req.id}`, { priority: 'HIGH' });

  // B deletes the account in the UI
  await B.page.goto(`${BASE}/app/settings?tab=me`); await B.page.waitForSelector('#danger', { timeout: 10000 });
  await B.page.click('#danger summary'); await B.page.click('#acct-delete');
  await B.page.waitForSelector('#fd', { timeout: 5000 });
  const dlg = await B.page.textContent('#fd');
  check('dialog says the account itself is deleted and lists the retention periods', /계정이 즉시 삭제/.test(dlg) && /3개월/.test(dlg) && /3년/.test(dlg) && /5년/.test(dlg), dlg);
  await B.page.screenshot({ path: `${SHOTS}/1-dialog.png` });
  await B.page.fill('#fd-password', 'passw0rd!'); await B.page.click('#fd-ok');
  await B.page.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check('after deletion the browser lands on /login', /\/login/.test(B.page.url()), B.page.url());
  check('users row is gone', sql(`SELECT COUNT(*) FROM users WHERE id = '${bUid}'`) === '0');
  check('requirement survives with a NULL author', sql(`SELECT COALESCE(created_by, 'NULL') FROM requirements WHERE id = '${req.id}'`) === 'NULL');
  check('consent record kept under a pseudonym', /^wd_/.test(sql(`SELECT ref FROM account_withdrawals ORDER BY withdrawn_at DESC LIMIT 1`)));

  // A sees 탈퇴한 사용자 on the activity page, never the old name
  await A.page.goto(`${BASE}/app/projects/${P.id}/activity`); await A.page.waitForSelector('.actpage', { timeout: 10000 }).catch(() => {}); await A.page.waitForTimeout(500);
  const actText = await A.page.textContent('#main');
  check('owner sees 탈퇴한 사용자 in 활동 기록', actText.includes(W), actText.slice(0, 300));
  check('the old name appears nowhere in 활동 기록', !actText.includes('박떠남'));
  await A.page.screenshot({ path: `${SHOTS}/2-activity.png` });
  const detail = (await A.api('GET', `${pa}/requirements/${req.id}`)).json.requirement;
  check('requirement detail: comment author and history actor are 탈퇴한 사용자', detail.comments[0].author_name === W && detail.history.every((h) => h.changed_by_name === W));

  // same e-mail signs up again: brand-new empty account
  const C = await mk();
  const s = await C.api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '박다시', email: leaverEmail, password: 'passw0rd!' });
  check('re-signup with the same e-mail works', s.status === 201 && s.json.user.id !== bUid);
  const me = (await C.api('GET', '/api/me')).json;
  check('the new account sees only its own fresh workspace', me.workspaces.length === 1 && me.workspaces[0].id !== w);

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
