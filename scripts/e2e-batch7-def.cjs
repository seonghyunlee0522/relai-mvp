// batch7 T2 browser check (research/relai-batch7-spec.md §A #2 #3 #4 #10 #23 #25 #26): 01 범위 = 적용 환경 (기기·브라우저 → SCOPE 완료),
// 산출물 목록 (관리자 추가 → 프로젝트 목록에 보임, 화면 설계서 필수 → 계획서 3절 표 · 07 종료 '필수 산출물 n건 중 제출 완료 m건'), 기존 자유 텍스트 블록,
// 빈 프로젝트 계획서에 '작성되지 않음' 0건 + 작성 가이드, 작성 예시 PDF, 관계자 서랍 [닫기][저장] (임시저장 없음, 저장 → 완료),
// 관리자 '사용량' 메뉴와 두 헤더 그룹, 사용 방법 PDF (도움말 메뉴 · /docs), 랜딩 대표·임원 섹션.
// Not part of `npm test` (needs a running server, Playwright, psql and unzip):
//   BASE=http://127.0.0.1:3591 SHOTS=research/relai-b7-t2 DATABASE_URL=postgres://… node scripts/e2e-batch7-def.cjs
//   server: SAMPLE_PROJECTS=false (an empty account), no real AI needed
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3591';
const SHOTS = process.env.SHOTS || 'b7-def-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-tAc', q]).toString().trim();
const esc = (s) => String(s).replace(/'/g, "''");
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
/** Plain text of a .docx (word/document.xml without tags). */
const docxText = (file) => execFileSync('unzip', ['-p', file, 'word/document.xml']).toString().replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n) });

  const email = `b7d-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '정의테스트', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${esc(email)}'`);
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mk = async (name) => (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-11-02', planned_end_date: '2027-03-31' })).json.project;
  const p = await mk('B7 정의 확인');
  const P = `/api/workspaces/${w}/projects/${p.id}`;
  const U = `${BASE}/app/projects/${p.id}`;

  /* ---------- #4 빈 프로젝트 계획서: '작성되지 않음' 0건, 작성 가이드 문장 ---------- */
  {
    const r = await page.request.get(`${BASE}${P}/charter/export?format=docx`);
    const f = path.join(SHOTS, 'empty-plan.docx'); fs.writeFileSync(f, await r.body());
    const t = docxText(f);
    check('#4 empty plan: no 작성되지 않음', r.status() === 200 && !/작성되지 않음/.test(t), String(r.status()));
    check('#4 empty plan: guide sentences (적용 환경 · 목표)', /결과물이 동작해야 할 기기/.test(t) && /적용 환경/.test(t), t.replace(/\s+/g, ' ').slice(0, 160));
    const ex = await page.request.get(`${BASE}${P}/charter/example?format=pdf`);
    const exBody = await ex.body();
    check('#4 작성 예시 PDF: 200 application/pdf', ex.status() === 200 && /application\/pdf/.test(ex.headers()['content-type']) && exBody.slice(0, 4).toString() === '%PDF' && exBody.length > 20000, `${ex.status()} ${exBody.length}`);
    const exd = await page.request.get(`${BASE}${P}/charter/example?format=docx`);
    const fe = path.join(SHOTS, 'example-plan.docx'); fs.writeFileSync(fe, await exd.body());
    const te = docxText(fe);
    check('#4 작성 예시: every section filled (no 작성되지 않음, has 적용 환경 · 산출물 목록 · 다온생명)', !/작성되지 않음/.test(te) && /적용 환경/.test(te) && /산출물/.test(te) && /다온생명/.test(te));
  }

  /* ---------- #2 범위 = 적용 환경 ---------- */
  await page.goto(`${U}/definition/goals?activity=SCOPE`); await page.waitForSelector('#wdrawer [data-env]');
  const groups = await page.$$eval('#wdrawer .envg__k', (els) => els.map((e) => e.textContent.trim()));
  check('#2 SCOPE drawer: 기기 and 브라우저 check groups', groups.some((g) => /기기/.test(g)) && groups.some((g) => /브라우저/.test(g)), JSON.stringify(groups));
  check('#2 SCOPE drawer: link to 요구사항 for 기능 범위', Boolean(await page.$('#wdrawer [data-scope-req-link] a[href$="/requirements"]')));
  check('#10 SCOPE drawer: [닫기][저장], no 임시저장 / 완료 처리', Boolean(await page.$('#wdrawer [data-wact="save"]')) && Boolean(await page.$('#wdrawer [data-wact="close"]')) && !/임시저장|완료 처리/.test(await page.textContent('#wdrawer .wd__f')));
  await page.click('#wdrawer [data-env^="devices."][data-v="SUPPORTED"]');
  await page.click('#wdrawer [data-env^="browsers."][data-v="SUPPORTED"]');
  await page.screenshot({ path: path.join(SHOTS, '01-scope-environments.png') });
  await page.click('#wdrawer [data-wact="save"]'); await page.waitForTimeout(900);
  let def = (await api('GET', `${P}/definition`)).json;
  const secOf = (k) => (def.sections || []).find((x) => x.key === k) || {};
  check('#2 one environment chosen + 저장 → SCOPE COMPLETED', secOf('SCOPE').status === 'COMPLETED', secOf('SCOPE').status);

  /* ---------- #3 산출물 목록 ---------- */
  // operator adds a catalog item → visible in this (existing) project and a new one
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE email = '${esc(email)}'`);
  const itemName = `개인정보 영향평가서 ${Date.now() % 100000}`;
  const add = await api('POST', '/api/admin/deliverables', { name: itemName, phase_key: 'ANALYSIS_DESIGN', tier: 'ADVANCED', default_level: 'OPTIONAL' });
  check('#3 admin adds a catalog item', add.status === 200 || add.status === 201, String(add.status));
  let dl = (await api('GET', `${P}/deliverables`)).json;
  check('#3 catalog item shows in an existing project', dl.items.some((x) => x.name === itemName));
  const p2 = await mk('B7 새 프로젝트');
  const dl2 = (await api('GET', `/api/workspaces/${w}/projects/${p2.id}/deliverables`)).json;
  check('#3 catalog item shows in a new project', dl2.items.some((x) => x.name === itemName));
  await page.goto(`${BASE}/admin/deliverables`); await page.waitForTimeout(1200);
  check('#3 admin › 산출물 목록 lists the item', (await page.textContent('main')).includes(itemName));
  await shot('02-admin-deliverables.png');

  // 화면 설계서 → 필수 in the picker (UI), then 저장
  await page.goto(`${U}/definition/goals?activity=SCOPE`); await page.waitForSelector('#wdrawer [data-dl-picker]');
  const screen = dl.items.find((x) => x.name === '화면 설계서');
  check('#3 picker: 베이직 / 심화 tabs', /베이직/.test(await page.textContent('#wdrawer .dl__tabs')) && /심화/.test(await page.textContent('#wdrawer .dl__tabs')));
  await page.click(`#wdrawer [data-dl="${screen.key}"] [data-dlv="OPTIONAL"]`);
  await page.click(`#wdrawer [data-dl="${screen.key}"] [data-dlv="REQUIRED"]`);
  await page.$eval(`#wdrawer [data-dl="${screen.key}"]`, (el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOTS, '03-deliverables-picker.png') });
  await page.click('#wdrawer [data-wact="save"]'); await page.waitForTimeout(900);
  dl = (await api('GET', `${P}/deliverables`)).json;
  const scr = dl.items.find((x) => x.name === '화면 설계서');
  check('#3 화면 설계서 saved as 필수', scr && scr.level === 'REQUIRED' && dl.has_selection, scr && scr.level);
  {
    const r = await page.request.get(`${BASE}${P}/charter/export?format=docx`);
    const f = path.join(SHOTS, 'plan-with-deliverables.docx'); fs.writeFileSync(f, await r.body());
    const t = docxText(f);
    check('#3 plan §3 산출물 table: 화면 설계서 · 필수', /화면 설계서\s*\n?\s*필수/.test(t) || /화면 설계서[^\n]{0,40}필수/.test(t.replace(/\n/g, ' ')), (t.match(/[^\n]{0,30}화면 설계서[^\n]{0,30}/) || [''])[0]);
    check('#2 plan §3 적용 환경 table (지원)', /적용 환경/.test(t) && /지원/.test(t));
  }
  // 07 종료: 필수 산출물 n건 중 제출 완료 m건
  const nReq = dl.items.filter((x) => x.level === 'REQUIRED').length;
  await page.goto(`${U}/checklist?activity=CLOSE`); await page.waitForTimeout(1500);
  const dlc = await page.$('[data-dl-count]');
  const dlcText = dlc ? (await dlc.textContent()).trim() : '';
  check('#3 07 종료: 필수 산출물 n건 중 제출 완료 0건', dlcText === `필수 산출물 ${nReq}건 중 제출 완료 0건`, dlcText);
  const sub = await page.$(`[data-dlsub="${scr.key}"]`);
  if (sub) { await sub.check(); await page.waitForTimeout(900); }
  const dlcText2 = (await page.textContent('[data-dl-count]').catch(() => '')).trim();
  check('#3 07 종료: 제출 완료 check → 1건', dlcText2 === `필수 산출물 ${nReq}건 중 제출 완료 1건`, dlcText2);
  await shot('04-close-deliverables.png');

  // legacy free text stays visible
  await api('PUT', `/api/workspaces/${w}/projects/${p2.id}/definition`, { deliverables: '요구사항 정의서\n화면 설계서 (기존 입력)' });
  await page.goto(`${BASE}/app/projects/${p2.id}/definition/goals?activity=SCOPE`); await page.waitForSelector('#wdrawer [data-dl-picker]');
  check('#3 기존 자유 텍스트 → 기존 입력 block with the original text', /기존 입력/.test(await page.textContent('#wdrawer')) && /화면 설계서 \(기존 입력\)/.test(await page.textContent('#wdrawer')));

  /* ---------- #10 관계자 서랍: 저장 → 완료 ---------- */
  await page.goto(`${U}/definition/stakeholders?activity=STAKEHOLDERS`); await page.waitForSelector('#wdrawer #sh-add');
  check('#10 관계자 서랍: no 임시저장', !/임시저장/.test(await page.textContent('#wdrawer')));
  await page.click('#sh-add'); await page.waitForTimeout(200);
  const row = 'tr[data-sh]:last-child';
  await page.fill(`${row} [data-shf="name"]`, '이수진');
  const ot = await page.$(`${row} select[data-shf="org_type"]`); if (ot) await ot.selectOption('CLIENT');
  await page.click('#wdrawer [data-wact="save"]'); await page.waitForTimeout(900);
  const toastText = await page.textContent('.toast').catch(() => '');
  def = (await api('GET', `${P}/definition`)).json;
  check('#10 이름 + 조직 구분 → 저장 → STAKEHOLDERS COMPLETED', secOf('STAKEHOLDERS').status === 'COMPLETED', `${secOf('STAKEHOLDERS').status} · ${toastText}`);
  await shot('05-stakeholders-saved.png');

  /* ---------- #23 관리자 사용량 ---------- */
  await page.goto(`${BASE}/admin/usage`); await page.waitForTimeout(1500);
  const nav = await page.textContent('nav, .anav, aside').catch(() => '');
  check('#23 admin menu label 사용량 (not AI 사용량)', /사용량/.test(nav) && !/AI 사용량/.test(nav));
  const mainT = await page.textContent('main');
  check('#23 usage table: AI 크레딧 + 플랜 한도 header groups', /AI 크레딧/.test(mainT) && /플랜 한도/.test(mainT));
  check('#23 early access reads 얼리 액세스 · 무제한', /얼리 액세스 · 무제한/.test(mainT));
  await shot('06-admin-usage.png');

  /* ---------- #25 사용 방법 PDF ---------- */
  const pdf = await page.request.fetch(`${BASE}/docs/relai-guide.pdf`, { method: 'HEAD' });
  const len = Number(pdf.headers()['content-length'] || 0);
  check('#25 /docs/relai-guide.pdf: 200, application/pdf, ≤ 8MB', pdf.status() === 200 && /application\/pdf/.test(pdf.headers()['content-type']) && len > 0 && len <= 8 * 1024 * 1024, `${pdf.status()} ${len}`);
  await page.goto(`${BASE}/app`); await page.waitForSelector('.helpbtn');
  await page.click('.helpbtn'); await page.waitForTimeout(200);
  const h = await page.$('[data-h-pdf]');
  check('#25 도움말 menu: 사용 방법 (PDF) opens in a new tab', Boolean(h) && (await h.getAttribute('href')) === '/docs/relai-guide.pdf' && (await h.getAttribute('target')) === '_blank', h ? await h.textContent() : 'none');
  await shot('07-help-menu-pdf.png');

  /* ---------- #6 #7 결제 꺼짐: 앱 화면에 ₩ · '원)' · 준비 중 문구 없음 ---------- */
  for (const [nm, url, sel] of [['home', '/app', 'main'], ['settings plan', '/app/settings?tab=plan', '#billing'], ['credits', '/app/settings/credits', '#cr-summary'], ['definition', `/app/projects/${p.id}/definition`, 'main']]) {
    await page.goto(BASE + url); await page.waitForSelector(sel, { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(400);
    const t = await page.textContent('body');
    check(`#7 payments off: no ₩ / 원) on ${nm}`, !/₩|원\)/.test(t), (t.match(/.{0,30}(₩|원\)).{0,30}/) || [''])[0]);
    check(`#6 no 준비 중입니다 / 아직 지원 on ${nm}`, !/준비 중입니다|아직 지원/.test(t));
  }
  check('#6 credits page (payments off): no 충전 area, one 문의하기 link', !(await (async () => { await page.goto(BASE + '/app/settings/credits'); await page.waitForSelector('#cr-summary'); return page.$('#cr-buy'); })()) && Boolean(await page.$('[data-credit-contact] a[href^="mailto:"]')));

  /* ---------- #26 랜딩 대표·임원 ---------- */
  await page.goto(BASE + '/'); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('is-in')));
  check('#26 hero: 대표·임원 line', /대표·임원/.test(await page.textContent('[data-hero-exec]').catch(() => '')));
  const img = await page.$('#exec img');
  await page.$eval('#exec', (el) => el.scrollIntoView());
  await page.waitForTimeout(600);
  const loaded = img ? await img.evaluate((el) => el.complete && el.naturalWidth > 0) : false;
  check('#26 exec section: 대표·임원은 보고를 기다리지 않습니다 + mobile health screenshot loads', /보고를 기다리지 않습니다/.test(await page.textContent('#exec')) && loaded);
  check('#25 landing footer: 사용 방법 (PDF)', Boolean(await page.$('a[data-guide-pdf][href="/docs/relai-guide.pdf"]')));
  await page.locator('#exec').screenshot({ path: path.join(SHOTS, '08-landing-exec.png') });

  await browser.close();
  const failed = results.filter(([, ok]) => !ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
