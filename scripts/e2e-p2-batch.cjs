// P2 batch (Jim prod full test 2026-10-21, P2 #1–#9, #11) in a real browser. Starts its own server (fake email, fake AI provider with
// canned replies, samples on, Free limits on) on a disposable database and drives Chromium at 1440px:
//   DATABASE_URL=postgres://…/relai_e2e [SHOTS=…/relai-qa-shots/p2-batch-20261021] node scripts/e2e-p2-batch.cjs
// Not part of `npm test`. The invite mail subject (#1) and the FS rule (#11) are also covered by server/test/p2-batch.test.js.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const DB = process.env.DATABASE_URL;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${String(extra).slice(0, 300)}`}`); };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const port = 3900 + Math.floor(Math.random() * 400);
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, EMAIL_PROVIDER: 'fake', INTEGRATION_PROVIDER: 'fake', AI_ENABLED: 'true', AI_PROVIDER: 'fake', AI_FAKE_AUTOREPLY: '1',
    AI_INITIAL_TRIAL_CREDITS: '100', DEV_INITIAL_AI_CREDITS: '0', AI_USER_MINUTE_LIMIT: '0', SAMPLE_PROJECTS: 'true', PAYMENTS_ENABLED: 'false', NODE_ENV: 'development' };
  delete env.PLAN_LIMITS;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150 && !/listening/.test(out); i++) await sleep(150);
  if (!/listening/.test(out)) { child.kill(); throw new Error(`server did not start:\n${out.slice(-800)}`); }
  return { child, base: `http://127.0.0.1:${port}` };
}

(async () => {
  const srv = await startServer(); const BASE = srv.base;
  const browser = await chromium.launch();
  const ctxFor = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body ?? {}, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
    return { ctx, page, api, errors, shot: (n) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${n}` }) : null) };
  };
  const go = async (page, p, sel) => { await page.goto(BASE + p); if (sel) await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {}); await sleep(300); };
  try {
    /* ---------- owner, a real project, a member ---------- */
    const A = await ctxFor(); await A.page.goto(BASE + '/login');
    const stamp = Date.now(); const emailA = `p2a-${stamp}@relai.test`; const emailB = `p2b-${stamp}@relai.test`;
    const s = await A.api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: 'QA테스트PM', email: emailA, password: 'passw0rd!' });
    const W = s.json.workspaces[0].id; sql(`UPDATE users SET email_verified_at = now() WHERE id = '${s.json.user.id}'`);
    const P = (await A.api('POST', `/api/workspaces/${W}/projects`, { name: '사내 ERP 구축', client_name: 'QA제조', project_type: 'NEW_BUILD', planned_start_date: '2026-11-02', planned_end_date: '2027-04-30' })).json.project;
    check('setup: project created on Free', Boolean(P && P.id));
    const PP = `/api/workspaces/${W}/projects/${P.id}`; const PU = `/app/projects/${P.id}`;

    /* #2 home: own projects only, balance wording */
    await go(A.page, '/app', '.page__head');
    const head = await A.page.textContent('.page__head');
    check('#2 home: 진행 중인 프로젝트 1개 (3 samples not counted)', /진행 중인 프로젝트 1개/.test(head), head);
    await A.page.waitForSelector('.home__credits', { timeout: 6000 }).catch(() => {});
    const cr = (await A.page.textContent('.home__credits').catch(() => '')) || '';
    check('#2 home: "AI 크레딧 잔액 100", no "무료 제공"', /AI 크레딧 잔액 100/.test(cr) && !/무료 제공/.test(await A.page.textContent('body')), cr);
    await A.shot('02-home-owner.png');

    /* #1 member home: '…님의 워크스페이스에 참여 중' (no duplicate) */
    const B = await ctxFor(); await B.page.goto(BASE + '/login');
    await B.api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '개발리드', email: emailB, password: 'passw0rd!' });
    const add = await A.api('POST', `/api/workspaces/${W}/members`, { email: emailB, role: 'MEMBER' });
    check('setup: member added', add.status === 201, JSON.stringify(add.json));
    await go(B.page, '/app', '.page__head');   // /api/me lists workspaces by creation → A's (older) is B's current one
    let body = await B.page.textContent('body');
    check('#1 member home: "QA테스트PM님의 워크스페이스에 참여 중입니다", never "워크스페이스 워크스페이스"', /QA테스트PM님의 워크스페이스에 참여 중입니다/.test(body) && !/워크스페이스 워크스페이스/.test(body), body.slice(0, 400));
    check('#2 member home: balance wording', !/무료 제공/.test(body));
    await B.shot('01-member-home.png');

    /* #3 requirement count chips after quick-add */
    for (const t of ['로그인', '주문 조회']) await A.api('POST', `${PP}/requirements`, { title: t });
    await go(A.page, `${PU}/requirements`, '[data-status-seg]');
    const segText = async () => (await A.page.textContent('[data-status-seg]')).replace(/\s+/g, ' ');
    const before = await segText();
    await A.page.fill('#qa-t', '거래처 마스터 중복 정리'); await A.page.press('#qa-t', 'Enter');
    await A.page.waitForFunction(() => /전체 3/.test(document.querySelector('[data-status-seg]')?.textContent.replace(/\s+/g, ' ') || ''), null, { timeout: 6000 }).catch(() => {});
    const after = await segText();
    check('#3 quick-add: status segments 전체 2 → 3 and 작성 중 2 → 3 without reload', /전체 2/.test(before) && /전체 3/.test(after) && /작성 중 3/.test(after), `${before} → ${after}`);
    await A.page.click('[data-stf="DRAFT"]'); await sleep(600);
    check('#3 repainted segment still filters (re-bound)', /status=DRAFT/.test(A.page.url()), A.page.url());
    await A.shot('03-req-quickadd.png');

    /* #4 가이드 이어보기 pill vs the detail drawer */
    const rq = await A.api('GET', `${PP}/requirements`);
    const rid = (rq.json.requirements || rq.json.items || [])[0]?.id;
    await go(A.page, `${PU}/requirements?sel=${rid}`, '#drawer:not([hidden]) .drawer__f'); await sleep(400);
    await A.page.evaluate(() => { const p = document.createElement('button'); p.id = 'tourpill'; p.className = 'tourpill'; p.innerHTML = '<span>▶</span> 가이드 이어보기'; document.body.append(p); });
    const rects = await A.page.evaluate(() => { const r = (el) => el && el.getBoundingClientRect().toJSON(); return { pill: r(document.getElementById('tourpill')), drawer: r(document.querySelector('#drawer:not([hidden])')) }; });
    const overlap = rects.drawer && rects.pill && rects.pill.right > rects.drawer.left && rects.pill.left < rects.drawer.right;
    check('#4 drawer open: the pill sits left of the drawer (no overlap with its buttons)', Boolean(rects.drawer) && !overlap, JSON.stringify(rects));
    await A.shot('04-pill-drawer.png');
    await A.page.click('#dclose').catch(() => {}); await sleep(300);
    const pill2 = await A.page.evaluate(() => document.getElementById('tourpill').getBoundingClientRect().right);
    check('#4 drawer closed: the pill is back bottom-right', pill2 > 1380, String(pill2));

    /* #5 FAQ */
    await go(A.page, '/app/billing/plans', '.pl-faq');
    const faq = await A.page.evaluate(() => [...document.querySelectorAll('.pl-faq')].map((d) => d.textContent.replace(/\s+/g, ' ')).find((t) => /한도를 넘으면/.test(t)) || '');
    check('#5 FAQ 한도를 넘으면: newest projects editable, rest 조회 전용; no 편집 잠금', /가장 최근인 프로젝트부터 한도만큼만 편집/.test(faq) && /조회 전용/.test(faq) && !/편집이 잠기/.test(faq), faq);
    await A.page.evaluate(() => document.querySelectorAll('.pl-faq').forEach((d) => { d.open = true; })); await A.page.evaluate(() => document.querySelector('.pl-faq').scrollIntoView());
    await A.shot('05-faq.png');

    /* #6 WBS: 운영 node + current-phase chip */
    await A.api('POST', `${PP}/wbs`, { item_type: 'TASK', title: '운영 인수 지원', lifecycle_phase: 'OPERATIONS', planned_start_date: '2027-04-19', planned_end_date: '2027-04-30' });
    const tree = await A.api('GET', `${PP}/wbs`);
    const sys = tree.json.items.filter((i) => i.system_key).map((i) => `${i.wbs_code} ${i.title}`);
    check('#6 WBS fixed nodes end with "7 운영"', sys.at(-1) === '7 운영', sys.join(' | '));
    await go(A.page, `${PU}/wbs`, '.phead');
    const chip = (await A.page.textContent('.phead [data-phase-chip]').catch(() => '')) || '';
    check('#6 WBS title chip = current phase 01 착수 (not 03)', /^01 착수$/.test(chip.trim()), chip);
    const ops = await A.page.$$eval('.wtitle--sys .wtitle__t', (els) => els.map((e) => e.textContent.trim()));
    check('#6 WBS list shows the 운영 node', ops.includes('운영'), ops.join(','));
    await A.shot('06-wbs-ops-chip.png');
    await go(A.page, `${PU}/wbs?view=gantt`, '.gantt');
    const gchip = (await A.page.textContent('.phead [data-phase-chip]').catch(() => '')) || '';
    check('#6 간트 title chip = 01 착수', /^01 착수$/.test(gchip.trim()), gchip);

    /* #11 FS conflict: chip, detail warning, Gantt links */
    const t1 = (await A.api('POST', `${PP}/wbs`, { item_type: 'TASK', title: '현업 인터뷰', planned_start_date: '2026-11-09', planned_end_date: '2026-11-20' })).json.item;
    const t2 = (await A.api('POST', `${PP}/wbs`, { item_type: 'TASK', title: '요구사항 정의서 작성', planned_start_date: '2026-11-16', planned_end_date: '2026-11-27' })).json.item;
    const t3 = (await A.api('POST', `${PP}/wbs`, { item_type: 'TASK', title: '화면 설계', planned_start_date: '2026-11-30', planned_end_date: '2026-12-11' })).json.item;
    const dep = await A.api('POST', `${PP}/wbs/${t2.id}/dependencies`, { predecessor_id: t1.id });
    await A.api('POST', `${PP}/wbs/${t3.id}/dependencies`, { predecessor_id: t2.id });
    check('#11 API: FS link that the dates break → 201 + warning', dep.status === 201 && /전에 시작/.test(dep.json.warning || ''), JSON.stringify(dep.json && dep.json.warning));
    await go(A.page, `${PU}/wbs`, '.wtitle');
    const warnChips = await A.page.$$eval('[data-fs-warn]', (els) => els.map((e) => e.getAttribute('title') || e.textContent));
    check('#11 WBS list: one "⚠ 선행 일정" chip (on 요구사항 정의서 작성 only)', warnChips.length === 1 && /현업 인터뷰/.test(warnChips[0]), JSON.stringify(warnChips));
    await A.shot('11-wbs-fs-chip.png');
    await go(A.page, `${PU}/wbs?sel=${t2.id}`, '#drawer:not([hidden]), .wdrawer');
    await A.page.click('[data-dtab="dep"]').catch(() => {}); await sleep(300);
    const dw = (await A.page.textContent('[data-pane="dep"] [data-fs-warn]').catch(() => '')) || '';
    check('#11 detail 선행 tab: warning line with both dates', /종료\(11\/20\) 전에 시작\(11\/16\)/.test(dw), dw);
    await A.shot('11-wbs-fs-detail.png');
    await go(A.page, `${PU}/wbs?view=gantt`, '.gantt');
    const links = await A.page.$$eval('.glinks .glink', (els) => els.map((e) => ({ bad: e.classList.contains('is-bad'), id: e.getAttribute('data-glink') })));
    check('#11 Gantt: 2 link lines, the broken one red', links.length === 2 && links.filter((l) => l.bad).length === 1 && links.find((l) => l.bad).id === `${t1.id}>${t2.id}`, JSON.stringify(links));
    await A.shot('11-gantt-links.png');

    /* #7 변경 요청 tab count */
    await A.api('POST', `${PP}/changes`, { title: '결제 수단 추가' });
    await go(A.page, `${PU}/changes`, '.stabs');
    const cnt = (await A.page.textContent('[data-stab="changes"] .stabs__n').catch(() => '')) || '';
    check('#7 이슈·변경 tabs: 변경 요청 shows 1', cnt.trim() === '1', cnt);
    await go(A.page, `${PU}/issues`, '.stabs');
    const cnt2 = (await A.page.textContent('[data-stab="changes"] .stabs__n').catch(() => '')) || '';
    check('#7 count also on the 이슈 tab view', cnt2.trim() === '1', cnt2);
    await A.shot('07-cr-count.png');

    /* #9 AI extraction: close asks, result kept, reopen shows it without a new charge */
    await go(A.page, `${PU}/requirements`, '#ai-extract-pc');
    const bal0 = (await A.api('GET', `${PP}/ai/status`)).json.credits.available;
    await A.page.click('#ai-extract-pc'); await A.page.waitForSelector('#ai-text', { timeout: 6000 });
    await A.page.fill('#ai-text', '고객사 IdP와 SSO 연동이 필수입니다. 관리자 화면에서 사용자별 권한을 조정할 수 있어야 합니다. 모든 변경은 감사 로그에 남아야 합니다.');
    await A.page.click('#ai-run'); await A.page.waitForSelector('.aic__i', { timeout: 10000 }).catch(() => {});
    const nCand = (await A.page.$$('.aic__i')).length; const bal1 = (await A.api('GET', `${PP}/ai/status`)).json.credits.available;
    check('#9 extraction ran (candidates shown, credits charged)', nCand > 0 && bal1 < bal0, `${nCand} ${bal0}→${bal1}`);
    await A.page.click('.scrim--ai .aid__hr [data-close]'); await sleep(300);
    const ask = (await A.page.textContent('.scrim:not(.scrim--ai) .dialog').catch(() => '')) || '';
    check('#9 × asks before closing (unregistered candidates, credits already used)', /등록하지 않은 요구사항 후보/.test(ask) && /차감/.test(ask), ask);
    await A.shot('09-ai-close-confirm.png');
    await A.page.click('.scrim:not(.scrim--ai) [data-v="0"]'); await sleep(200);
    check('#9 계속 검토 keeps the dialog open', Boolean(await A.page.$('.scrim--ai .aic__i')));
    await A.page.keyboard.press('Escape'); await sleep(300);
    check('#9 Esc asks the same way', Boolean(await A.page.$('.scrim:not(.scrim--ai) .dialog')));
    await A.page.click('.scrim:not(.scrim--ai) [data-v="1"]'); await sleep(300);
    check('#9 보관하고 닫기 closes', !(await A.page.$('.scrim--ai')));
    await A.page.click('#ai-extract-pc'); await A.page.waitForSelector('[data-ai-kept]', { timeout: 6000 }).catch(() => {});
    const kept = (await A.page.$$('.aic__i')).length; const bal2 = (await A.api('GET', `${PP}/ai/status`)).json.credits.available;
    check('#9 reopen: the same candidates are back, no new charge', Boolean(await A.page.$('[data-ai-kept]')) && kept === nCand && bal2 === bal1, `${kept} ${bal1}→${bal2}`);
    await A.shot('09-ai-kept.png');
    await A.page.click('#ai-commit'); await sleep(800);
    check('#9 등록 closes without asking', !(await A.page.$('.scrim')));

    /* #8 new-project form across 768px */
    await A.api('DELETE', `/api/workspaces/${W}/samples`).catch(() => {});
    await go(A.page, '/app/projects/new', '#name');
    await A.page.fill('#name', '그룹웨어 고도화'); await A.page.fill('#client', '한결건설'); await A.page.fill('#scale', '2억 · 4개월'); await A.page.fill('#d', '전자결재 개편');
    await A.page.setViewportSize({ width: 700, height: 900 }); await sleep(700);
    await A.shot('08-form-phone.png');
    await A.page.setViewportSize({ width: 1440, height: 900 }); await A.page.waitForSelector('#name', { timeout: 6000 }).catch(() => {}); await sleep(1500);
    const vals = await A.page.evaluate(() => ['name', 'client', 'scale', 'd'].map((id) => document.getElementById(id)?.value || ''));
    check('#8 new project: typed values survive 1440 → 700 → 1440', vals.join('|') === '그룹웨어 고도화|한결건설|2억 · 4개월|전자결재 개편', vals.join('|'));
    await A.shot('08-form-restored.png');

    check('no page errors', A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(' / '));
  } catch (e) { check('script ran without exceptions', false, e.stack); }
  finally { await browser.close(); srv.child.kill(); }
  const fail = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
