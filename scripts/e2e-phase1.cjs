// Phase 1 v2 (01 착수) browser check — tour click (QA B1), Home 7 phases, kickoff screen, approval gate on 3 paths into 02,
// Charter, 사업수행계획서 PDF/Word download, approval + re-approval. Not part of `npm test` (needs a running server + Playwright):
//   BASE=http://127.0.0.1:3091 SHOTS=/tmp/shots node scripts/e2e-phase1.cjs   (run `npm i playwright` somewhere on NODE_PATH first)
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3091';
const SHOTS = process.env.SHOTS || 'phase1-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, path, body) => { const r = await page.request.fetch(BASE + path, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };

  // fresh owner, 0 projects
  const email = `p1-${Date.now()}@relai.test`;
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  // 1. tour: CREATE_PROJECT step highlighted → the real button is clickable (QA B1)
  await page.goto(BASE + '/app');
  await page.waitForSelector('.hero', { timeout: 8000 }); await page.waitForTimeout(600);
  check('design clean-up: no welcome modal and no auto tour on a new account', !(await page.$('.scrim')) && !(await page.$('.tour')));
  await page.click('[data-tour-start]', { timeout: 5000 }).catch((e) => log('tour start', e.message.split('\n')[0]));   // "1분 둘러보기" — the tour runs only when started
  for (let i = 0; i < 4; i++) { await page.waitForSelector('.tour__pop', { timeout: 8000 }).catch(() => {}); const t = await page.textContent('#tourT').catch(() => ''); if (/첫 프로젝트 만들기/.test(t)) break; await page.click('[data-t="next"]').catch(() => {}); await page.waitForTimeout(400); }
  const tourShown = await page.$('.tour');
  check('tour overlay visible on Home', Boolean(tourShown));
  check('design clean-up: tour step has ✕ and 건너뛰기', Boolean(await page.$('.tour__x')) && /건너뛰기/.test(await page.textContent('.tour__btns').catch(() => '')));
  await page.screenshot({ path: `${SHOTS}/00-home-tour.png` });
  const homeText = await page.textContent('.hero');
  check('Home copy: 착수부터 운영까지 7단계 + 고객사', /착수부터 운영까지 7단계/.test(homeText) && /고객사/.test(homeText));
  check('Home 7-phase flow', (await page.$$('.hero__flow li')).length === 7);
  await page.click('[data-tour-id="create-project"]', { timeout: 5000 }).catch(async (e) => { log('click err', e.message.split('\n').slice(0, 14).join(' | ')); log('vars', await page.evaluate(() => { const t = document.querySelector('.tour'); const cs = getComputedStyle(t, '::before'); return [t.style.cssText, cs.clipPath, cs.pointerEvents]; })); });
  await page.waitForURL(/\/app\/projects\/new/, { timeout: 5000 }).catch(() => {});
  check('tour: clicking 프로젝트 만들기 → /app/projects/new', /\/app\/projects\/new/.test(page.url()), page.url());

  // project + definition via API
  const p = (await api('POST', `/api/workspaces/${w}/projects`, { name: '법무 AI 검토 시스템', client_name: 'ACME', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28', description: '계약 검토 자동화' })).json.project;
  const P = `/api/workspaces/${w}/projects/${p.id}`;
  await api('PUT', `${P}/definition`, { goal: '계약 검토 리드타임 50% 단축', success_criteria: ['사용자 만족도 향상', '검토 리드타임 평균 2영업일 이내'], scope_in: ['국문 표준계약 5종 자동 검토', '검토 이력 관리'], scope_out: ['영문 계약서'], deliverables: '요구사항 정의서\n화면 설계서',
    stakeholders: [{ id: 's1', name: '이수진', org_type: 'CLIENT', org: 'ACME', department: '법무팀', role: '차장 (고객 PM)', area: '요구사항 최종 승인' }, { id: 's2', name: '박상무', org_type: 'CLIENT', org: 'ACME', role: '상무 (스폰서)', area: '예산·범위 결정' }, { id: 's3', name: '김피엠', org_type: 'OWN', org: '수행사', role: 'PM', area: '프로젝트 총괄' }],
    key_dates: [{ title: '착수보고회', date: '2026-10-08' }, { title: '중간보고', date: '2026-12-10' }, { title: '최종 검수', date: '2027-02-20' }, { title: '하자보수 종료', date: '2027-05-31' }], operations: { meetings: '주간 정례 월 10시', reporting: '주간보고 금요일' } });
  for (const k of ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS']) await api('POST', `${P}/definition/sections/${k}/complete`, {});
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});

  // 2. What's Next → INIT_KICKOFF
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.rg__title');
  check("What's Next guidance = 착수보고회", /착수보고회를 준비하고 진행하세요/.test(await page.textContent('.rg__title')));
  await page.screenshot({ path: `${SHOTS}/01-whats-next-kickoff.png` });

  // 3. kickoff screen (prefilled from milestone)
  await page.goto(`${BASE}/app/projects/${p.id}/definition?activity=KICKOFF`); await page.waitForSelector('#wdrawer [data-kf="datetime"]');
  const dtv = await page.inputValue('[data-kf="datetime"]');
  check('kickoff date prefilled from 착수보고회 milestone', dtv.startsWith('2026-10-08'), dtv);
  await page.check('[data-katt="s1"]'); await page.check('[data-katt="s2"]'); await page.check('[data-katt="s3"]');
  for (let i = 1; i <= 3; i++) await page.check(`[data-kl="prep"] li:nth-child(${i}) [data-klf="done"]`);
  await page.$eval('#wdrawer .wd__b', (el) => { el.scrollTop = 0; });
  await page.screenshot({ path: `${SHOTS}/02-kickoff-screen.png`, fullPage: false });
  await page.fill('[data-kf="minutes"]', '목표·범위·일정 설명. 고객 질의 3건 답변. 영문 계약서는 제외로 합의.');
  await page.click('[data-kladd="decisions"]'); await page.fill('[data-kl="decisions"] li:last-child [data-klf="text"]', '주간 정례회의 매주 월 10시 확정');
  await page.click('[data-kladd="followups"]'); await page.fill('[data-kl="followups"] li:last-child .kl__text', '회의록 송부'); await page.fill('[data-kl="followups"] li:last-child .kl__owner', '김피엠');
  await page.click('[data-wact="complete"]'); await page.waitForTimeout(800);
  const krow = await page.textContent('[data-row="KICKOFF"]');
  check('kickoff completed with 후속 조치 1건 남음', /완료/.test(krow) && /후속 조치 1건 남음/.test(krow), krow.replace(/\s+/g, ' ').slice(0, 120));

  // 4. success-criteria hint + stakeholder 주요 책임 + milestone after-end warning
  await page.goto(`${BASE}/app/projects/${p.id}/definition?activity=GOALS`); await page.waitForSelector('[data-schint]');
  const hints = await page.$$eval('[data-schint]', (els) => els.map((e) => e.textContent.trim()));
  check('success-criteria hint only on 사용자 만족도 향상', Boolean(hints[0]) && !hints[1], JSON.stringify(hints));
  await page.goto(`${BASE}/app/projects/${p.id}/definition?activity=STAKEHOLDERS`); await page.waitForSelector('[data-shf="area"]');
  check('stakeholders 주요 책임 column', (await page.inputValue('tr[data-sh="s1"] [data-shf="area"]')) === '요구사항 최종 승인');
  await page.goto(`${BASE}/app/projects/${p.id}/definition?activity=MILESTONES`); await page.waitForSelector('[data-kd]');
  const warn = await page.$$eval('[data-kdwarn]', (els) => els.map((e) => e.textContent));
  check('milestone after end-date warning', warn.length === 1 && /종료일\(02\/28\) 이후입니다/.test(warn[0]), JSON.stringify(warn));
  await page.screenshot({ path: `${SHOTS}/03-milestone-warning.png` });

  // 5. approval gate — path A: What's Next primary/footer button
  const gatePath = async (name, open, shot) => {
    await open();
    const ok = await page.waitForSelector('[data-dialog="approval-gate"]', { timeout: 5000 }).then(() => true).catch(() => false);
    if (ok && shot) await page.screenshot({ path: `${SHOTS}/${shot}` });
    check(`gate dialog on path: ${name}`, ok);
    if (!ok) return;
    const title = await page.textContent('#agT');
    check(`gate title (${name})`, title.trim() === '고객 승인 없이 요구사항 단계로 넘어가려 합니다', title);
    await page.click('[data-v="proceed"]');
    check(`reason required (${name})`, /이유를 입력/.test(await page.textContent('#ag-err')));
    return true;
  };
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.rg__title');
  check("What's Next guidance = 승인", /착수 결과를 고객에게 승인받으세요/.test(await page.textContent('.rg__title')));
  const nextBtn = await page.$('#next');
  check('footer button josa: 요구사항 정의로 진행 →', nextBtn && (await nextBtn.textContent()).trim() === '요구사항 정의로 진행 →', nextBtn ? await nextBtn.textContent() : 'none');
  await gatePath("What's Next button", async () => { await page.click('#next'); }, '04-approval-gate-dialog.png');
  await page.click('[data-v="cancel"]');
  // path B: the guide/Home "단계 시작" link (…?move=next → moveToPhase on load)
  await gatePath('?move=next (Guide / Home 단계 시작 링크)', async () => { await page.goto(`${BASE}/app/projects/${p.id}?move=next`); });
  await page.click('[data-v="record"]'); await page.waitForURL(/activity=APPROVAL/, { timeout: 5000 }).catch(() => {});
  check('승인 기록하러 가기 → APPROVAL work screen', /definition\?activity=APPROVAL/.test(page.url()), page.url());
  // only these 2 paths leave 01: the 02 list has no "이 단계를 현재 단계로 변경" link
  await page.goto(`${BASE}/app/projects/${p.id}?phase=REQUIREMENTS`); await page.waitForSelector('.np__list');
  check('no 이 단계를 현재 단계로 변경 link', !(await page.$('[data-set-phase]')) && !/현재 단계로 변경/.test(await page.textContent('main')));
  // proceed with a reason through the What's Next button
  await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('#next');
  await gatePath("What's Next button (사유 입력)", async () => { await page.click('#next'); });
  await page.fill('#ag-in', '고객 PM 휴가로 승인 회신이 다음 주 예정');
  await page.click('[data-v="proceed"]');
  await page.waitForTimeout(600);
  // the general dialog (if any other required items) — none expected; may get "현재 단계로 변경" confirm for manual path
  const conf = await page.$('.scrim .dialog');
  if (conf) { await page.screenshot({ path: `${SHOTS}/05-after-gate-confirm.png` }); const b = await page.$('.scrim .dialog [data-v="1"], .scrim .dialog .btn--primary'); if (b) await b.click(); await page.waitForTimeout(800); }
  const g = (await api('GET', P)).json;
  check('moved to 02 after reason', g.project.current_phase === 'REQUIREMENTS', g.project.current_phase);
  const apvStep = g.phases[0].steps.find((x) => x.step_key === 'APPROVAL');
  check('reason stored in APPROVAL note', /^\[승인 전 진행\] 고객 PM 휴가로 승인 회신이 다음 주 예정 · \d{4}-\d{2}-\d{2} · 홍길동$/.test(apvStep.note), apvStep.note);
  check('APPROVAL row text 승인 전 진행 · 사유 있음', /승인 전 진행 · 사유 있음/.test(apvStep.text), apvStep.text);

  // F6: 01 left with approval unrecorded → number + open-required badge in LNB and stepper, never ✓
  const lc01 = async () => { await page.goto(`${BASE}/app/projects/${p.id}`); await page.waitForSelector('.pstep'); return page.evaluate(() => {
    const ph = document.querySelector('.lnb__ph[data-grp="INITIATION"]'); const st = document.querySelector('.pstep li:first-child');
    return { lnbCls: ph.className, mark: ph.querySelector('.lnb__mark').textContent.trim(), badge: (ph.querySelector('.lnb__n') || {}).textContent || '',
      stCls: st.className, stIcon: st.querySelector('.st').textContent.trim(), stBadge: (st.querySelector('.pstep__n') || {}).textContent || '' }; }); };
  const b1 = await lc01();
  check('bypass: LNB 01 shows number + badge 1, not ✓', /is-gap/.test(b1.lnbCls) && b1.mark === '01' && b1.badge.trim() === '1', JSON.stringify(b1));
  check('bypass: stepper 01 not ✓, badge 1', /is-gap/.test(b1.stCls) && b1.stIcon !== '✓' && b1.stBadge.trim() === '1', JSON.stringify(b1));
  await page.screenshot({ path: `${SHOTS}/05b-lnb-gap.png` });

  // 6. Charter: approval area shows 미승인 — 사유, timeline 종료 후 zone, export menu
  await page.goto(`${BASE}/app/projects/${p.id}/charter`); await page.waitForSelector('.chx__head');
  check('Charter title = 프로젝트 헌장 (Korean label set)', (await page.title()).startsWith('프로젝트 헌장'));
  check('Charter shows 미승인 — 사유', /미승인 — 사유: 고객 PM 휴가로/.test(await page.textContent('#ch-approval')));
  check('Charter timeline 종료 후 zone', Boolean(await page.$('.chtl__after')));
  await page.screenshot({ path: `${SHOTS}/06-charter.png`, fullPage: true });
  await page.click('.chx__head .pmenu summary');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.chx__head [data-plan="pdf"]')]);
  const pdfPath = `${SHOTS}/plan.pdf`; await dl.saveAs(pdfPath);
  check('PDF downloaded', fs.statSync(pdfPath).size > 5000, dl.suggestedFilename());
  const [dl2] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('.chx__head .pmenu summary'); await page.click('.chx__head [data-plan="docx"]'); })()]);
  await dl2.saveAs(`${SHOTS}/plan.docx`); check('Word downloaded', fs.statSync(`${SHOTS}/plan.docx`).size > 3000, dl2.suggestedFilename());

  // 7. approval record screen (back in 01) + re-approval
  await page.goto(`${BASE}/app/projects/${p.id}/definition?activity=APPROVAL`); await page.waitForSelector('[data-af="approver_id"]');
  check('01 screen shows 착수 승인 기록 없음? (has bypass → hidden)', !(await page.$('.np__noapv')));
  await page.selectOption('[data-af="approver_id"]', 's2');
  await page.fill('[data-af="date"]', '2026-10-09');
  check('approval method 착수보고회에서 승인 preselected', await page.isChecked('[data-af="method"][value="KICKOFF"]'));
  await page.fill('[data-af="evidence"]', "2026-10-09 박상무 회신 메일 '사업수행계획서 v1.0 승인'");
  await page.screenshot({ path: `${SHOTS}/07-approval-screen.png` });
  await page.click('[data-wact="complete"]'); await page.waitForTimeout(800);
  check('approval completed', /완료/.test(await page.textContent('[data-row="APPROVAL"]')));
  const b2 = await lc01();
  check('approval recorded: LNB 01 ✓, no badge', /is-done/.test(b2.lnbCls) && b2.mark === '✓' && !b2.badge, JSON.stringify(b2));
  check('approval recorded: stepper 01 ✓', /is-done/.test(b2.stCls) && b2.stIcon === '✓' && !b2.stBadge, JSON.stringify(b2));
  await api('PUT', `${P}/definition`, { goal: '계약 검토 리드타임 70% 단축' });
  await page.goto(`${BASE}/app/projects/${p.id}/definition`); await page.waitForSelector('[data-row="APPROVAL"]');
  check('re-approval → 확인 필요', /확인 필요/.test(await page.textContent('[data-row="APPROVAL"]')));
  await page.screenshot({ path: `${SHOTS}/08-reapproval.png` });

  await browser.close();
  const fails = results.filter((r) => !r[1]);
  log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
