// Redesign Round 3b (drawers · F8/F9 · words · empty states) — hive research/relai-redesign-spec.md Round 3 + Jim F8/F9.
// Not part of `npm test` (needs a running server + Playwright).
//   BASE=http://127.0.0.1:3271 SHOTS=/tmp/r3b DATABASE_URL=postgres://… node scripts/e2e-redesign-r3b.cjs
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3271';
const SHOTS = process.env.SHOTS || 'r3b-shots';
const ONLY = process.env.ONLY || '';   // e.g. ONLY=lint to run one block while debugging
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : extra}`); };
const run = (k) => !ONLY || ONLY.split(',').includes(k);

/* English-word lint (spec R3): words of 3+ Latin letters in the rendered page, outside IDs (REQ-001, CR-002 …), e-mail addresses,
 * the user's own data and these product / format names. */
const TERM_SKIP = 'button,a,select,option,textarea,input,label,summary,script,style,th,h1,.term,.stabs,.dtabs,[role="tab"],.chip,.mono,.wcode,.toast,.gtable,.rtable,.gantt,.np__menu,.tmenu,.gpop,[contenteditable="true"]';   // = public/app/shared/term-auto.js
const ALLOW = ['RELAI', 'PDF', 'Word', 'Excel', 'Jira', 'AI', 'WBS', 'Ctrl', 'Enter', 'Cloud', 'Atlassian', 'Team', 'Free'];   // + Jira Cloud / Atlassian and the plan names (Team · Free)

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR', e.message); });
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, ...(body ? { data: body } : {}), headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const email = `r3b-${Date.now()}@relai.test`;
  await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김피엠', email, password: 'passw0rd!' });
  const me = (await api('GET', '/api/me')).json; const w = me.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const mk = async (name) => (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: '한빛제약', project_type: 'NEW_BUILD', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28', has_external_integration: 'YES' })).json.project;
  const P = await mk('한빛제약 상담 챗봇 구축'); const E = await mk('빈 프로젝트');
  const pa = `/api/workspaces/${w}/projects/${P.id}`; const U = `/app/projects/${P.id}`; const UE = `/app/projects/${E.id}`;
  const R = []; for (const t of ['상담 이력 조회', '상담원 연결', '자주 묻는 질문 응답']) R.push((await api('POST', `${pa}/requirements`, { title: t, scope: 'IN_SCOPE', status: 'CONFIRMED' })).json.requirement);
  const W = []; for (const t of ['상담 시나리오 설계', '상담원 연결 개발', '응답 품질 점검']) W.push((await api('POST', `${pa}/wbs`, { title: t, planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' })).json.item);
  await api('POST', `${pa}/requirements/${R[0].id}/links`, { wbs_item_id: W[0].id }); await api('POST', `${pa}/requirements/${R[0].id}/links`, { wbs_item_id: W[1].id });
  const I = []; for (const t of ['고객 상담 데이터 미제공', '테스트 서버 지연', '상담원 계정 부족']) I.push((await api('POST', `${pa}/issues`, { title: t, severity: 'HIGH' })).json.issue);
  const RK = []; for (const t of ['오픈 일정 지연 가능성', '개인정보 처리 동의 누락']) RK.push((await api('POST', `${pa}/risks`, { title: t })).json.risk);
  const C = []; for (const t of ['상담 이력 보관 기간 변경', '알림톡 연동 추가']) C.push((await api('POST', `${pa}/changes`, { title: t })).json.change);
  const T = []; for (const t of ['상담 이력 조회 확인', '상담원 연결 확인']) T.push((await api('POST', `${pa}/tests`, { title: t })).json.test);
  const A = (await api('POST', `${pa}/acceptances`, { title: '1차 검수 — 상담 기능' })).json.acceptance;
  const settle = async () => { await page.waitForSelector('.phead-wrap, .page__head, .page', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(350); };
  const shot = async (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  /* ---------- 1. issues · risks · 변경 요청 · tests · 검수 open in the R2 480px side drawer on desktop ---------- */
  if (run('drawer')) {
    const cases = [['이슈', `${U}/issues`, I, '[data-resolve]', '해결 처리'], ['리스크', `${U}/issues?tab=risks`, RK, '#convert', '이슈로 전환'], ['변경 요청', `${U}/changes`, C, '[data-tr="submit"]', '검토 요청'],
      ['테스트', `${U}/tests`, T, '#run', '테스트 실행'], ['검수', `${U}/tests?tab=acceptance`, [A], '[data-act="submit"]', '검수 요청']];
    for (const [what, url, list, foot, label] of cases) {
      await page.goto(`${BASE}${url}`); await settle();
      const order = await page.$$eval('tr[data-row]', (els) => els.map((e) => e.dataset.row)); const byId = (x) => list.find((y) => y.id === x);
      await page.click(`tr[data-row="${order[0]}"]`); await page.waitForSelector('#drawer:not([hidden]) .drawer__h', { timeout: 8000 });
      const d = await page.evaluate(() => { const el = document.querySelector('#drawer'); const r = el.getBoundingClientRect(); const list = document.querySelector('.rtable-wrap').getBoundingClientRect();
        const scrim = getComputedStyle(document.querySelector('.rlayout'), '::before'); return { cls: el.className, w: Math.round(r.width), right: Math.round(window.innerWidth - r.right), listVisible: list.width > 300, scrim: scrim.display !== 'none' && scrim.content !== 'none',
          more: Boolean(el.querySelector('details.dmore > summary')) && /세부 정보 더보기/.test(el.querySelector('details.dmore > summary')?.textContent || ''), nav: el.querySelectorAll('.drawer__h [data-nav]').length,
          foot: Boolean(el.querySelector('.drawer__f.dfoot')), arch: Boolean(el.querySelector('.dfoot .dfoot__arch')) }; });
      const f = await page.$eval(`#drawer .dfoot ${foot}`, (b) => b.textContent.trim()).catch(() => '');
      check(`${what}: 480px side drawer beside the list (no scrim), ↑/↓ in the header, 세부 정보 더보기, footer 보관 · ${label}`,
        /drawer--lg/.test(d.cls) && d.w === 480 && d.right === 0 && d.listVisible && !d.scrim && d.nav === 2 && (what === '검수' || d.more) && d.foot && d.arch && f === label, JSON.stringify({ ...d, f }));
      if (list.length > 1) {
        await page.click('#drawer .drawer__h [data-nav="1"]'); await page.waitForTimeout(500);
        const second = await page.textContent('#drawer .drawer__h b');
        await page.click('#drawer .drawer__h'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(500);
        const first = await page.textContent('#drawer .drawer__h b');
        check(`${what}: ↓ button → next item, keyboard ↑ → back`, second === byId(order[1]).display_id && first === byId(order[0]).display_id, `${second} ${first}`);
      }
      await page.setViewportSize({ width: 1024, height: 800 }); await page.waitForTimeout(250);
      check(`${what}: drawer open at 1024px → no sideways scroll`, await noSideScroll());
      await page.setViewportSize({ width: 1440, height: 900 }); await shot(`01-drawer-${byId(order[0]).display_id}`);
    }
    // footer actions work: 이슈 해결 처리 (one-line note dialog) and 변경 요청 검토 요청
    await page.goto(`${BASE}${U}/issues?sel=${I[2].id}`); await page.waitForSelector('#drawer .dfoot [data-resolve]');
    await page.click('#drawer .dfoot [data-resolve]'); await page.waitForSelector('#pd-in'); await page.fill('#pd-in', '계정 3개 추가 발급'); await page.click('.dialog [data-v="1"]'); await page.waitForTimeout(800);
    const iss = (await api('GET', `${pa}/issues/${I[2].id}`)).json.issue;
    check('이슈 footer 해결 처리 → 해결 + 해결 내용 saved', iss.status === 'RESOLVED' && iss.resolution === '계정 3개 추가 발급', `${iss.status} ${iss.resolution}`);
    await page.goto(`${BASE}${U}/changes?sel=${C[1].id}`); await page.waitForSelector('#drawer .dfoot [data-tr="submit"]');
    await page.click('#drawer .dfoot [data-tr="submit"]'); await page.waitForTimeout(800);
    check('변경 요청 footer 검토 요청 → 검토 중; footer then shows 반려 · 승인', (await api('GET', `${pa}/changes/${C[1].id}`)).json.change.status === 'UNDER_REVIEW'
      && JSON.stringify(await page.$$eval('#drawer .dfoot .btn', (els) => els.map((e) => e.textContent.trim()))) === JSON.stringify(['반려', '승인']));
    // the phone keeps its full-screen view (no side drawer)
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const mp = await mctx.newPage(); await mp.goto(`${BASE}${U}/issues?sel=${I[0].id}`); await mp.waitForSelector('#drawer:not([hidden]) .drawer__h', { timeout: 8000 }).catch(() => {});
    const m = await mp.evaluate(() => { const el = document.querySelector('#drawer'); return { cls: el ? el.className : '', nav: el ? el.querySelectorAll('[data-nav]').length : -1, more: el ? el.querySelectorAll('.dmore').length : -1 }; });
    check('phone: issue detail unchanged (no side drawer, no ↑/↓, no 더보기)', !/drawer--lg/.test(m.cls) && m.nav === 0 && m.more === 0, JSON.stringify(m));
    await mctx.close();
  }

  /* ---------- 2–3. F8 · F9: 변경 요청 만들기 from a confirmed requirement ---------- */
  if (run('cr')) {
    await page.goto(`${BASE}${U}/requirements?sel=${R[0].id}`); await page.waitForSelector('#drawer .dtitle');
    await page.fill('#drawer .dtitle', '상담 이력 조회 (3년)'); await page.press('#drawer .dtitle', 'Enter');
    await page.waitForSelector('[data-dialog="req-change"]'); await page.click('[data-dialog="req-change"] [data-v="cr"]');
    await page.waitForURL(/\/changes\?sel=/, { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('#drawer:not([hidden]) .drawer__h', { timeout: 8000 }).catch(() => {});
    const crId = new URL(page.url()).searchParams.get('sel');
    const t = await page.textContent('.toast--act').catch(() => '');
    check('F9: 변경 요청 만들기 opens the new CR drawer right away (toast offers 요구사항으로 돌아가기)', /\/changes\?sel=/.test(page.url()) && /CR-\d+/.test(await page.textContent('#drawer .drawer__h b')) && /요구사항으로 돌아가기/.test(t), `${page.url()} ${t}`);
    const cr = (await api('GET', `${pa}/changes/${crId}`)).json.change;
    check('F8: the CR starts with the requirement\'s 2 WBS links as 영향 WBS', cr.impacts.length === 2 && cr.impacts.map((x) => x.wbs_item_id).sort().join() === [W[0].id, W[1].id].sort().join(), JSON.stringify(cr.impacts.map((x) => x.title)));
    await shot('02-f9-cr-opened');
    await page.click('#drawer [data-dtab="links"]'); await page.waitForTimeout(200);
    check('F8: 영향 범위 tab lists 영향 WBS 2', /영향 WBS\s*2/.test(await page.textContent('#drawer [data-pane="links"]')));
    await api('POST', `${pa}/changes/${crId}/transition`, { action: 'submit' });
    await page.goto(`${BASE}${U}/changes?sel=${crId}`); await page.waitForSelector('#drawer .dfoot [data-tr="approve"]'); await page.click('#drawer .dfoot [data-tr="approve"]');
    await page.waitForSelector('[data-approval-drawer]');
    check('F8: approval dialog says 연결 작업 2건', /연결 작업\s*2건/.test(await page.textContent('[data-approval-drawer]')));
    await api('POST', `${pa}/changes/${crId}/transition`, { action: 'approve', customer_approval: { approver_name: '이수진', approver_title: '차장', date: '2026-10-14', method: 'EMAIL', evidence: '회신 메일', add_to_stakeholders: true } });
    await page.goto(`${BASE}${U}/changes?sel=${crId}`); await page.waitForSelector('#drawer a.btn[href*="/wbs?cr="]');
    await page.click('#drawer a.btn[href*="/wbs?cr="]'); await page.waitForSelector('.ctx', { timeout: 8000 }).catch(() => {});
    check('F8: WBS에서 반영 → only the 2 영향 WBS are shown', /영향 WBS 2건만 표시합니다/.test(await page.textContent('.ctx').catch(() => '')));
    await shot('03-f8-wbs-highlight');
  }

  /* ---------- 4. no English UI words on Home, 지금 할 일, all 7 doors and 설정 ---------- */
  if (run('lint')) {
    const pages = ['/app', U, `${U}/definition`, ...['STAKEHOLDERS', 'MILESTONES', 'OPERATIONS', 'KICKOFF', 'APPROVAL'].map((a) => `${U}/definition?activity=${a}`),
      `${U}/requirements`, `${U}/requirements?type=UNSPECIFIED`, `${U}/requirements?view=trace`, `${U}/wbs`, `${U}/wbs?view=gantt`, `${U}/wbs?phase=DEVELOPMENT`,
      `${U}/tests?tab=coverage`, `${U}/tests`, `${U}/tests?last_result=FAIL`, `${U}/tests?tab=acceptance`, `${U}/issues`, `${U}/issues?tab=risks`, `${U}/changes`,
      `${U}/reports`, `${U}/charter`, `${U}/overview`, UE, `${UE}/requirements`, `${UE}/wbs`, `${UE}/tests`, `${UE}/issues`, `${UE}/changes`, `${UE}/reports`,
      ...['me', 'team', 'plan', 'integrations'].map((t) => `/app/settings?tab=${t}`)];
    const bad = {};
    for (const u of pages) {
      await page.goto(`${BASE}${u}`); await settle(); await page.waitForTimeout(300);
      const words = await page.evaluate(({ allow, data }) => {
        let t = document.body.innerText; for (const d of data) t = t.split(d).join(' ');
        t = t.replace(/\b[A-Z]{2,5}-\d+\b/g, ' ').replace(/[\w.+-]+@[\w.-]+/g, ' ');
        return [...new Set((t.match(/[A-Za-z]{3,}/g) || []).filter((x) => !allow.includes(x)))];
      }, { allow: ALLOW, data: [email] });
      if (words.length) bad[u.replace(P.id, 'P').replace(E.id, 'E')] = words;
    }
    check(`English-word check passes on Home, 지금 할 일, all 7 doors (every tab) and 설정 (${pages.length} pages)`, !Object.keys(bad).length, JSON.stringify(bad));
  }

  /* ---------- 4b. ? tooltip on the first use of WBS · 간트 · 기준선 · 마일스톤 · 완료 조건 per page ---------- */
  if (run('terms')) {
    const TERMS = ['WBS', '간트', '확정본', '마일스톤', '완료 조건'];
    const miss = {};
    for (const u of [U, `${U}/requirements`, `${U}/requirements?sel=${R[1].id}`, `${U}/wbs`, `${U}/wbs?view=gantt`, `${U}/definition?activity=MILESTONES`, `${U}/reports`, `${U}/changes?sel=${C[0].id}`]) {
      await page.goto(`${BASE}${u}`); await settle(); await page.waitForTimeout(300);
      const m = await page.evaluate(({ terms, skip }) => {
        const out = [];
        for (const term of terms) {   // first visible use in page text (controls, tabs, chips, table headers, titles are not a "use")
          const w = document.createTreeWalker(document.querySelector('#main'), NodeFilter.SHOW_TEXT); let n; let host = null;
          while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest(skip) || !el.getClientRects().length) continue; if (n.nodeValue.includes(term)) { host = el; break; } }
          if (!host) continue;
          const has = (x) => x && x.matches('.term') && (x.getAttribute('aria-label') || '').split(':')[0].includes(term);
          if (![...host.querySelectorAll('.term')].some(has) && !has(host.nextElementSibling)) out.push(`${term}: ${host.textContent.trim().slice(0, 50)}`);
        }
        return out;
      }, { terms: TERMS, skip: TERM_SKIP });
      if (m.length) miss[u.replace(P.id, 'P')] = m;
    }
    check('first use of WBS · 간트 · 확정본 · 마일스톤 · 완료 조건 on each page has a ? tooltip', !Object.keys(miss).length, JSON.stringify(miss));
  }

  /* ---------- 5. empty states: one sentence + one button on every list page ---------- */
  if (run('empty')) {
    const lists = [['요구사항', `${UE}/requirements`], ['작업 목록', `${UE}/wbs`], ['테스트', `${UE}/tests`], ['검수', `${UE}/tests?tab=acceptance`], ['이슈', `${UE}/issues`], ['리스크', `${UE}/issues?tab=risks`], ['변경 요청', `${UE}/changes`], ['주간보고', `${UE}/reports`]];
    for (const [what, u] of lists) {
      await page.goto(`${BASE}${u}`); await settle(); await page.waitForTimeout(400);
      const e = await page.evaluate(() => {
        const vis = (x) => x && x.offsetParent !== null;
        const box = [...document.querySelectorAll('#main .empty, #main .wempty, #main [data-empty]')].find(vis);
        const banners = [...document.querySelectorAll('#main .notice, #main .coach, #main .info, #main .tip, #main .jira-banner, #main [data-banner]')].filter(vis).map((x) => x.textContent.trim().slice(0, 40));
        if (!box) return { box: false, banners };
        const btns = [...box.querySelectorAll('.btn')].filter(vis).map((b) => b.textContent.trim());   // other ways in (Excel · AI) may stay as small text links
        const text = [...box.querySelectorAll('h2, p:not(.tempty__alt):not(.wempty__alt)')].filter(vis).map((x) => x.textContent.trim()).filter(Boolean);
        const sentences = text.join(' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
        return { box: true, btns, text, sentences, banners };
      });
      check(`${what} empty: one sentence + one button, no tip/info banner`, e.box && e.btns.length === 1 && e.sentences === 1 && !e.banners.length, JSON.stringify(e));
      await shot(`05-empty-${what}`);
    }
  }

  check('no page errors', errors.length === 0, JSON.stringify(errors));
  await browser.close();
  const fail = results.filter((r) => !r[1]).length;
  log(`\n${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
