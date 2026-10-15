// Redesign Round 3a (보고서 + 설정) — one check per R3 acceptance line in hive research/relai-redesign-spec.md (reports, settings).
// Not part of `npm test` (needs a running server + Playwright). AI price lines (credits AC3) are covered by e2e-credits.cjs.
//   BASE=http://127.0.0.1:3241 SHOTS=/tmp/r3 DATABASE_URL=postgres://… node scripts/e2e-redesign-r3.cjs
// DATABASE_URL marks the user's e-mail verified (invitations need it) and seeds one invitation for the invite page.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3241';
const SHOTS = process.env.SHOTS || 'r3-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const EN = /\b(Workspace|Integrations?|Owner|OWNER|Member|MEMBER|Admin|ADMIN|Members|Profile|Billing|Danger)\b/g;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const email = `r3-${Date.now()}@relai.test`;
  await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김피엠', email, password: 'passw0rd!' });
  const me = (await api('GET', '/api/me')).json; const w = me.workspaces[0].id;
  if (process.env.DATABASE_URL) sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const P = (await api('POST', `/api/workspaces/${w}/projects`, { name: '한빛제약 AI 고객상담 챗봇 구축', client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28', has_external_integration: 'YES' })).json.project;
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`;
  for (let i = 0; i < 3; i++) await api('POST', `${pa}/wbs`, { title: `작업 ${i + 1} — 상담 시나리오 설계`, planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' });
  const old = (await api('POST', `${pa}/weekly-reports/generate`, { period_start: '2026-10-05', period_end: '2026-10-11' })).json.report;
  await api('POST', `${pa}/weekly-reports/${old.id}/finalize`, {});
  const settle = async () => { await page.waitForSelector('.phead-wrap, .page__head', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(300); };
  const vis = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null));
  const primaries = () => page.$$eval('#main .btn--primary', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
  const shot = async (n) => { for (const wd of [1440, 1920]) { await page.setViewportSize({ width: wd, height: 900 }); await page.waitForTimeout(150); await page.screenshot({ path: `${SHOTS}/${n}-${wd}.png` }); } await page.setViewportSize({ width: 1440, height: 900 }); };

  // ---- 보고서 door: 4 tabs; weekly report reachable from one menu place (보고서 › 주간보고)
  await page.goto(`${BASE}${U}`); await settle();
  await page.click('#rail [data-door="reports"]'); await settle();
  const tabs = await page.$$eval('.stabs .stabs__i', (els) => els.map((e) => e.textContent.trim()));
  check('보고서 door has 4 tabs: 주간보고 · 공식 문서 · 건강도 · 활동 기록', JSON.stringify(tabs) === JSON.stringify(['주간보고', '공식 문서', '건강도', '활동 기록']), JSON.stringify(tabs));
  check('rail 보고서 opens 보고서 › 주간보고 (active tab)', /\/reports$/.test(page.url()) && (await page.textContent('.stabs .is-active')).trim() === '주간보고', page.url());
  const prim = await primaries();
  check('주간보고 tab: one primary "이번 주 주간보고 만들기" + past report list (기간 · 확정)', prim.length === 1 && prim[0] === '이번 주 주간보고 만들기' && /2026-10-05 ~ 2026-10-11/.test(await page.textContent('.rpl__t')) && /확정/.test(await page.textContent('.rpl__t')), JSON.stringify(prim));
  await shot('01-reports-weekly');
  for (const [n, k] of [['02-reports-docs', 'docs'], ['03-reports-health', 'health']]) { await page.click(`.stabs [data-stab="${k}"]`); await settle(); await page.waitForTimeout(500); await shot(n); }
  await page.click('.stabs [data-stab-action="activity"]'); await page.waitForTimeout(800); await shot('04-reports-activity'); await page.keyboard.press('Escape');

  // ---- create this week's report from the tab, then the report view header
  await page.goto(`${BASE}${U}/reports`); await settle();
  await page.click('#rp-new'); await page.waitForSelector('#pd-s'); await page.click('.dialog [data-v="1"]');
  await page.waitForURL(/\/reports\/[0-9a-f-]+$/, { timeout: 8000 }); await page.waitForSelector('.doc__actions');
  const head = async () => page.$$eval('.doc__actions > .btn, .doc__actions > details > summary', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
  let hb = await head();
  check('report view header ≤ 3 buttons: 다운로드 ▾ · 복사 ▾ · 보고서 확정', hb.length <= 3 && JSON.stringify(hb) === JSON.stringify(['다운로드 ▾', '복사 ▾', '보고서 확정']), JSON.stringify(hb));
  const old2 = await page.evaluate(() => ({ crumb: Boolean([...document.querySelectorAll('.crumb')].find((e) => e.offsetParent)), coach: Boolean([...document.querySelectorAll('.coach, .notice')].find((e) => e.offsetParent && /주간보고 —/.test(e.textContent))) }));
  check('no old 주간보고 info banner and no "← 프로젝트명" back link (Jim L2)', !old2.crumb && !old2.coach, JSON.stringify(old2));
  check('report view keeps the 보고서 rail door + 주간보고 tab', (await page.getAttribute('#rail [data-door="reports"]', 'aria-current').catch(() => null)) === 'page' || /is-active|is-on/.test(await page.getAttribute('#rail [data-door="reports"]', 'class')), '');
  await page.click('#dl-menu summary'); await page.waitForTimeout(150); await shot('05-report-view-download-menu');
  for (const [k, re] of [['pdf', /\.pdf$/], ['docx', /\.docx$/]]) {
    if (!(await page.isVisible(`#dl-menu [data-dl="${k}"]`))) await page.click('#dl-menu summary');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click(`#dl-menu [data-dl="${k}"]`)]);
    const fn = dl ? dl.suggestedFilename() : ''; const size = dl ? fs.statSync(await dl.path()).size : 0;
    check(`다운로드 ▾ › ${k === 'pdf' ? 'PDF' : 'Word'} downloads a file (${fn})`, re.test(fn) && size > 1000, `${fn} ${size}`);
    check(`menu closes after picking ${k}`, !(await page.getAttribute('#dl-menu', 'open').then((v) => v !== null)));
  }
  await page.click('#cp-menu summary'); await page.waitForTimeout(150);
  check('복사 ▾ offers Markdown and 텍스트', (await page.isVisible('#copy-md')) && (await page.isVisible('#copy-txt')));
  await page.click('#copy-md'); await page.waitForTimeout(800);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('복사 ▾ › Markdown copies the report (# title, ## sections)', /^# .*주간보고/.test(clip) && /\n## 1\. /.test(clip), clip.slice(0, 80));
  await page.click('#cp-menu summary'); await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  check('Esc closes an open menu', !(await page.getAttribute('#cp-menu', 'open').then((v) => v !== null)));
  await page.click('#finalize'); await page.waitForSelector('.scrim .dialog'); await page.click('.scrim .dialog [data-v="1"]'); await page.waitForSelector('#reopen');
  hb = await head();
  check('확정 ↔ 다시 편집 is one button (still ≤ 3)', JSON.stringify(hb) === JSON.stringify(['다운로드 ▾', '복사 ▾', '다시 편집']), JSON.stringify(hb));
  await shot('06-report-view-final');

  // ---- 설정: 4 tabs; each = title + purpose + ≤ 1 primary; no English labels
  const TABS = [['me', '내 정보'], ['team', '팀원'], ['plan', '요금제'], ['integrations', '연동']];
  if (process.env.DATABASE_URL) await api('POST', `/api/workspaces/${w}/invitations`, { email: `invitee-${Date.now()}@relai.test`, role: 'MEMBER' });
  await page.goto(`${BASE}/app/settings`); await page.waitForSelector('.stabs--settings');
  const st = await page.$$eval('.stabs--settings .stabs__i', (els) => els.map((e) => e.textContent.trim()));
  check('설정 has 4 tabs: 내 정보 · 팀원 · 요금제 · 연동', JSON.stringify(st) === JSON.stringify(TABS.map((t) => t[1])), JSON.stringify(st));
  for (const [k, l] of TABS) {
    await page.click(`[data-set-tab="${k}"]`); await page.waitForSelector(`.stab-body[data-tab="${k}"]`);
    const t = await page.evaluate(() => ({ h: document.querySelector('.stab-head h2')?.textContent, p: document.querySelector('.stab-head__p')?.textContent, txt: document.querySelector('#main').innerText }));
    const pr = await primaries(); const en = t.txt.match(EN) || [];
    check(`설정 › ${l}: title + purpose, ≤ 1 primary (${pr.join(',') || '없음'}), no English labels, URL ?tab=${k}`, t.h === l && Boolean(t.p) && pr.length <= 1 && !en.length && page.url().endsWith(`?tab=${k}`), JSON.stringify({ t: t.h, pr, en }));
    await shot(`1${TABS.findIndex((x) => x[0] === k)}-settings-${k}`);
  }
  // 팀원: members + pending invitations in one table
  await page.goto(`${BASE}/app/settings?tab=team`); await page.waitForSelector('#teamtbl');
  const rows = await page.$$eval('#teamtbl tbody tr', (els) => els.map((e) => ({ inv: e.classList.contains('is-invite'), t: e.innerText })));
  check('팀원 tab: one table with members and (if any) invites as rows "초대 대기 · N일 남음" + 다시 보내기', rows.some((r) => !r.inv && /김피엠/.test(r.t)) && (!process.env.DATABASE_URL || rows.some((r) => r.inv && /초대 대기 · 7일 남음/.test(r.t) && /다시 보내기/.test(r.t))), JSON.stringify(rows));
  check('팀원 tab: + 팀원 초대 is the one primary', JSON.stringify(await primaries()) === JSON.stringify(['+ 팀원 초대']));
  // 위험 구역: delete buttons only inside the expanded zone, existing confirmations unchanged
  await page.goto(`${BASE}/app/settings`); await page.waitForSelector('#danger');
  const before = { acct: await page.isVisible('#acct-delete'), ws: await page.isVisible('#ws-delete') };
  const outside = await page.evaluate(() => [...document.querySelectorAll('#acct-delete, #ws-delete')].filter((b) => !b.closest('#danger')).length);
  check('계정 삭제 / 워크스페이스 삭제 hidden until 위험 구역 is expanded (and only inside it)', !before.acct && !before.ws && outside === 0, JSON.stringify({ before, outside }));
  await page.click('#danger summary'); await page.waitForTimeout(150);
  check('expanded 위험 구역 shows both delete buttons', (await page.isVisible('#acct-delete')) && (await page.isVisible('#ws-delete')));
  await shot('14-settings-danger-open');
  await page.click('#ws-delete'); await page.waitForSelector('.scrim .dialog');
  const wsDlg = await page.textContent('.scrim .dialog');
  check('워크스페이스 삭제 still asks for the workspace name (existing confirmation)', /워크스페이스를 삭제할까요/.test(wsDlg) && Boolean(await page.$('.scrim .dialog [name="confirm_name"]')), wsDlg.slice(0, 80));
  await page.click('.scrim .dialog [data-v="0"]'); await page.waitForTimeout(200);
  await page.click('#acct-delete'); await page.waitForSelector('.scrim .dialog');
  check('계정 삭제 still opens its confirmation (password / blockers)', /계정을 삭제할까요|계정을 삭제할 수 없습니다/.test(await page.textContent('.scrim .dialog')));
  await page.click('.scrim .dialog [data-v="0"]').catch(() => page.keyboard.press('Escape'));
  check('workspace still exists after cancelling', (await api('GET', `/api/workspaces/${w}`)).status === 200);
  // #billing / ?checkout= land on 요금제
  await page.goto(`${BASE}/app/settings#billing`); await page.waitForSelector('.stab-body');
  check('/app/settings#billing opens 요금제', (await page.getAttribute('.stab-body', 'data-tab')) === 'plan' && Boolean(await page.$('#billing')));

  // ---- invite page: Korean labels (no 'Workspace' / 'OWNER')
  if (process.env.DATABASE_URL) {
    const token = crypto.randomBytes(24).toString('base64url');
    const hash = crypto.createHash('sha256').update(`invite:${process.env.SESSION_SECRET || ''}:${token}`).digest('hex');
    sql(`INSERT INTO invitations (id, type, workspace_id, email, role, workspace_name, token_hash, invited_by, expires_at) VALUES ('${crypto.randomUUID()}', 'WORKSPACE_MEMBER', '${w}', 'inv-page-${Date.now()}@relai.test', 'MEMBER', '한빛 PMO', '${hash}', '${me.user.id}', now() + interval '7 days')`);
    const ip = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })).newPage();
    await ip.goto(`${BASE}/invite/${token}`); await ip.waitForTimeout(1500);
    const it = (await ip.evaluate(() => document.body.innerText)).split('김피엠님의 Workspace').join('');   // the workspace's own name is data
    check('invite page: 워크스페이스 labels, no English Workspace / OWNER', /워크스페이스/.test(it) && !/Workspace|OWNER/.test(it), it.slice(0, 200));
    await ip.screenshot({ path: `${SHOTS}/20-invite-1440.png` });
  } else log('SKIP invite page (no DATABASE_URL)');

  check('no page errors', errors.length === 0, JSON.stringify(errors));
  await browser.close();
  const fail = results.filter((r) => !r[1]).length;
  log(`\n${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
