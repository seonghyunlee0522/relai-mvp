// Phone = view mode (hive research/relai-mobile-spec.md §6 A1–A16) browser check.
// Seed (demo-shaped): project A at 05 시험 with 7 requirements, a WBS skeleton, 6 TCs, 1 open issue, 1 CR, 1 finalised 주간보고;
// project B closed with a final 완료보고서. Then every §4 route at 375×812 (A1–A13), 360/430 spot widths, rotate 375→1024 (A14),
// PC 1440 (A15), tablet 768/900 + phone landscape 844 (A16), and the A6 downloads again in WebKit (devices['iPhone 13']).
// Not part of `npm test` (needs a running server + Playwright with chromium + webkit):
//   BASE=http://127.0.0.1:3101 SHOTS=/tmp/shots DATABASE_URL=postgres://… node scripts/e2e-mobile.cjs   (server with PLAN_LIMITS=off)
const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { chromium, webkit, devices } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:3101';
const SHOTS = process.env.SHOTS || 'mobile-shots';
const DB = process.env.DATABASE_URL;
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const sql = (q) => (DB ? execFileSync('psql', ['-q', '-t', '-A', DB, '-c', q]).toString().trim() : '');

const todayKst = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const addDays = (ymd, n) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const T = todayKst(); const d = (n) => addDays(T, n);
const week = () => { const dow = new Date(`${T}T00:00:00Z`).getUTCDay(); const s = addDays(T, dow === 0 ? -6 : 1 - dow); return { start: s, end: addDays(s, 6) }; };

const TEAM = [
  { id: 'sh-pm', name: '김하늘', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '이수진', org_type: 'CLIENT', org: '한빛제약', role: '현업 담당' },
];
const PHASES = ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];
// A5: words of controls that create, edit, approve, tick, move, generate, import, invite or pay
const FORBIDDEN = /^(\+ ?새 프로젝트|\+ ?항목 추가|\+ ?테스트 추가|.*단계 시작.*|주간보고 생성|다시 편집|결제하기|초대.*|.*추가|저장|확정|승인.*|수정|완료 처리|가져오기|Excel.*)$/;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  const api = async (method, p, body) => { const r = await page.request.fetch(BASE + p, { method, data: body, headers: { 'Content-Type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };

  /* ================= seed ================= */
  const email = `mob-${Date.now()}@relai.test`; const password = 'passw0rd!';
  await page.goto(BASE + '/login');
  const s = await api('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김하늘', email, password });
  const w = s.json.workspaces[0].id;
  await api('POST', `/api/workspaces/${w}/onboarding/product_tour/skip`, {});
  const toPhase = async (A, keys) => { for (const key of keys) { const ph = (await api('GET', A.P)).json.phases.find((x) => x.phase_key === key); await api('POST', `${A.P}/phases/${ph.id}/activate`, { reason: 'NEXT' }); } };
  const mkProject = async (name, client) => {
    const p = (await api('POST', `/api/workspaces/${w}/projects`, { name, client_name: client, project_type: 'NEW_BUILD', planned_start_date: d(-60), planned_end_date: d(90), data_migration: 'NO', has_external_integration: 'NO' })).json.project;
    const P = `/api/workspaces/${w}/projects/${p.id}`;
    await api('PUT', `${P}/definition`, { stakeholders: TEAM });
    return { p, P, url: `/app/projects/${p.id}` };
  };
  const A = await mkProject('한빛제약 AI 고객상담 챗봇 구축 및 상담 이력 분석 고도화 프로젝트', '한빛제약');
  const R = [];
  for (const [i, t] of ['상담 챗봇 FAQ 응답', '상담 이력 검색', '상담원 연결 전환', '응답 시간 3초 이내 확인', '관리자 통계 대시보드', '개인정보 마스킹', '음성 상담 연동'].entries()) {
    const r = (await api('POST', `${A.P}/requirements`, { title: t, description: `${t} 기능`, type: 'FUNCTIONAL', priority: i < 3 ? 'HIGH' : 'MEDIUM', scope: i === 6 ? 'OUT_OF_SCOPE' : 'IN_SCOPE' })).json.requirement;
    await api('POST', `${A.P}/requirements/${r.id}/criteria`, { content: `${t} 동작 확인` });
    if (i < 6) await api('PATCH', `${A.P}/requirements/${r.id}`, { status: 'CONFIRMED' });
    R.push(r);
  }
  await toPhase(A, ['REQUIREMENTS', 'ANALYSIS_DESIGN']);
  await api('POST', `${A.P}/wbs/skeleton`, {});
  await toPhase(A, ['DEVELOPMENT']);
  const iss = (await api('POST', `${A.P}/issues`, { title: '상담 이력 API 응답 지연', severity: 'HIGH', owner: 's:sh-dev', due_date: d(5) })).json;
  const cr = (await api('POST', `${A.P}/changes`, { title: '카카오톡 상담 채널 추가', requester_name: '이수진' })).json.change;
  const WK = week();
  const rep = (await api('POST', `${A.P}/weekly-reports/generate`, { period_start: WK.start, period_end: WK.end })).json.report;
  await api('POST', `${A.P}/weekly-reports/${rep.id}/finalize`, {});
  await toPhase(A, ['TESTING']);
  const TC = [];
  for (let i = 0; i < 6; i += 1) {
    const t = (await api('POST', `${A.P}/tests`, { title: `REQ-00${i + 1} ${R[i].title} 확인`, priority: 'HIGH' })).json.test;
    await api('POST', `${A.P}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: R[i].id });
    if (i < 4) await api('POST', `${A.P}/tests/${t.id}/executions`, { result: i === 3 ? 'FAIL' : 'PASS' });
    TC.push(t);
  }
  const B = await mkProject('사내 포털 개편', '한빛제약');
  await toPhase(B, PHASES);
  const comp = (await api('POST', `${B.P}/weekly-reports/completion`, {})).json.report;
  await api('POST', `${B.P}/weekly-reports/${comp.id}/finalize`, {});
  sql(`UPDATE projects SET status = 'COMPLETED', closed_on = '${T}' WHERE id = '${B.p.id}'`);
  check('seed: A at 05 · 6 TCs · issue · CR · final weekly · B closed + 완료보고서', Boolean(iss && cr && rep && comp && TC.length === 6), JSON.stringify({ iss: Boolean(iss), cr: Boolean(cr), rep: Boolean(rep), comp: Boolean(comp) }));
  const state = await ctx.storageState();
  fs.writeFileSync(`${SHOTS}/seed.json`, JSON.stringify({ email, w, A: A.url, B: B.url, rep: rep.id, comp: comp.id }));

  /* ================= phone 375×812 ================= */
  const ROUTES = [
    ['home', '/app'], ['projects', '/app/projects'], ['settings', '/app/settings'], ['credits', '/app/settings/credits'],
    ['next', A.url], ['next-01', `${A.url}?phase=INITIATION`], ['overview', `${A.url}/overview`], ['definition', `${A.url}/definition`], ['charter', `${A.url}/charter`],
    ['requirements', `${A.url}/requirements`], ['wbs', `${A.url}/wbs`], ['issues', `${A.url}/issues`], ['changes', `${A.url}/changes`],
    ['tests', `${A.url}/tests`], ['coverage', `${A.url}/tests?tab=coverage`], ['checklist', `${A.url}/checklist?phase=TRANSITION_GO_LIVE`],
    ['reports', `${A.url}/reports`], ['report', `${A.url}/reports/${rep.id}`], ['closed-next', B.url], ['completion', `${B.url}/reports/${comp.id}`], ['b-reports', `${B.url}/reports`],
  ];
  const settle = async (pg) => { await pg.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 10000 }).catch(() => {}); await pg.waitForTimeout(250); };
  const audit = (pg) => pg.evaluate((src) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const forb = new RegExp(src);
    const ctrls = [...document.querySelectorAll('main button, main a.btn, main [role=button], main input[type=checkbox]')].filter(vis)
      .filter((e) => !e.closest('[data-phone-ok]') && !e.matches('[data-phone-ok]'));
    const bad = ctrls.filter((e) => e.matches('button.btn, a.btn') || e.matches('input[type=checkbox]') || forb.test((e.textContent || '').trim()))
      .filter((e) => !e.matches('a.btn[data-link]:not([href$="/new"]):not([href*="/edit"]):not([href*="move=next"])'))
      .map((e) => (e.textContent || e.type || '').trim().slice(0, 30));
    const tabs = [...document.querySelectorAll('.tabbar .tabbar__i')].filter(vis);
    return {
      sw: document.documentElement.scrollWidth, vw: innerWidth,
      wide: [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1).slice(-3).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`),
      pclines: [...document.querySelectorAll('.pcline')].filter(vis).length,
      bad, tabs: tabs.length, tabH: Math.min(...tabs.map((t) => t.getBoundingClientRect().height)), activeTab: (document.querySelector('.tabbar .is-active') || {}).textContent || '',
      thead: [...document.querySelectorAll('main thead, main .grid__head, main .rtable__head, main .prow--head')].filter(vis).length,
      tiny: [...document.querySelectorAll('main *')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() && vis(e) && parseFloat(getComputedStyle(e).fontSize) < 11.5).map((e) => e.textContent.trim().slice(0, 20)).slice(0, 5),
    };
  }, FORBIDDEN.source);

  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', storageState: state, isMobile: true, hasTouch: true });
  const mp = await m.newPage(); mp.on('pageerror', (e) => log('PAGEERROR(375)', e.message));
  const reqs = []; mp.on('request', (r) => reqs.push(`${r.method()} ${new URL(r.url()).pathname}`));
  const go = async (u) => { await mp.goto(BASE + u); await settle(mp); };
  const AUD = {};
  for (const [name, u] of ROUTES) {
    await go(u); const a = await audit(mp); AUD[name] = a;
    await mp.screenshot({ path: `${SHOTS}/m-${name}.png`, fullPage: true });
    check(`A1 375 ${name}: scrollWidth ≤ 375`, a.sw <= 375, `${a.sw} ${a.sw > 375 ? JSON.stringify(a.wide) : ''}`);
    check(`A5 375 ${name}: no edit control visible`, a.bad.length === 0, JSON.stringify(a.bad));
    const inProject = u.startsWith('/app/projects/');
    check(`A2 375 ${name}: tab bar ${inProject ? 5 : 3} tabs ≥ 44px, one active`, a.tabs === (inProject ? 5 : 3) && a.tabH >= 44, `${a.tabs} ${a.tabH} active=${a.activeTab.trim()}`);
    const viewer = name === 'report' || name === 'completion';
    if (inProject || name === 'home' || name === 'settings' || name === 'credits') check(`A4 375 ${name}: ${viewer ? 'no' : 'exactly one'} PC line`, a.pclines === (viewer ? 0 : 1), String(a.pclines));
    if (a.tiny.length) log(`  note ${name} text < 12px:`, JSON.stringify(a.tiny));
  }
  /* ---------- A17 설정 › AI 크레딧 on a phone: the dashboard is readable, 충전 / 환불 요청 are PC-only ---------- */
  await go('/app/settings/credits');
  const crd = await mp.evaluate(() => ({ sum: Boolean(document.querySelector('#cr-summary')), log: Boolean(document.querySelector('#cr-log tbody tr')),
    packs: document.querySelectorAll('[data-pack]').length, refund: Boolean(document.querySelector('#cr-refund')), top: Boolean(document.querySelector('#cr-buy-top')),
    pay: (document.querySelector('[data-phone-pay]')?.textContent || '').trim(), filters: document.querySelectorAll('.cr-filt select').length,
    csv: Boolean(document.querySelector('#cr-csv')), cells: [...document.querySelectorAll('.cr-price tbody td')].filter((td) => td.offsetParent).length }));
  check('A17 375 AI 크레딧: summary + price table + usage log readable', crd.sum && crd.log && crd.cells >= 6, JSON.stringify(crd));
  check('A17 375 AI 크레딧: no pack button / 충전 / 환불 요청; "결제는 PC에서"', crd.packs === 0 && !crd.refund && !crd.top && /결제는 PC에서/.test(crd.pay), JSON.stringify(crd));
  check('A17 375 AI 크레딧: month/project/user filters stay live + CSV link', crd.filters === 3 && crd.csv, JSON.stringify(crd));
  log('AUDIT', JSON.stringify(Object.fromEntries(Object.entries(AUD).map(([k, v]) => [k, v.bad.length ? v.bad : v.sw]))));

  /* ---------- A2 더보기 · A3 top bar ---------- */
  await go(`${A.url}/tests`);
  const top = await mp.evaluate(() => { const n = document.querySelector('#ptop'); const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
    return { name: n.textContent, h: r.height, nowrap: cs.whiteSpace === 'nowrap', ell: cs.textOverflow === 'ellipsis', strip: document.querySelector('#pstrip').innerText.replace(/\s+/g, ' ').trim(), logo: getComputedStyle(document.querySelector('.topbar .logo')).display }; });
  check('A3 top bar: project name, one line with ellipsis', top.name.startsWith('한빛제약 AI') && top.h <= 48 && top.nowrap && top.ell && top.logo === 'none', JSON.stringify(top));
  check('A3 status strip "05 / 07 · 시험" + status chip', /^05 \/ 07 · 시험 진행 중$/.test(top.strip), top.strip);
  await mp.click('[data-tab-more]'); await mp.waitForTimeout(300);
  const sheet = await mp.evaluate(() => { const s = document.querySelector('#side'); const r = s.getBoundingClientRect(); return { open: s.classList.contains('is-open'), h: r.height, w: r.width, txt: s.innerText }; });
  check('A2 더보기 opens the LNB as a full-height sheet (요구사항 · 테스트 · 프로젝트 · 로그아웃)', sheet.open && sheet.h >= 700 && sheet.w >= 375 && ['요구사항', '테스트', '프로젝트', '로그아웃'].every((t) => sheet.txt.includes(t)), JSON.stringify({ ...sheet, txt: '' }));
  await mp.screenshot({ path: `${SHOTS}/m-more-sheet.png` });
  await mp.click('[data-tab-more]'); await mp.waitForTimeout(200);
  check('A2 더보기 again closes the sheet', !(await mp.evaluate(() => document.querySelector('#side').classList.contains('is-open'))));

  /* ---------- A5 paywall dialog ---------- */
  await go('/app');
  await mp.evaluate(() => window.dispatchEvent(new CustomEvent('relai:plan-limit', { detail: { message: 'Free 플랜에서는 진행 중 프로젝트를 1개까지 만들 수 있습니다.', limit: { dimension: 'projects', label: '진행 중 프로젝트', used: 1, limit: 1, plan: 'Free' } } })));
  await mp.waitForSelector('[data-notice]');
  const pay = await mp.evaluate(() => { const d = document.querySelector('[data-notice]'); return { txt: d.innerText, btns: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) }; });
  check('A5 paywall on phone: "결제는 PC에서 할 수 있습니다" + 닫기 only', /결제는 PC에서 할 수 있습니다/.test(pay.txt) && JSON.stringify(pay.btns) === '["닫기"]', JSON.stringify(pay.btns));
  await mp.screenshot({ path: `${SHOTS}/m-paywall.png` });
  await mp.click('[data-notice] [data-v]');

  /* ---------- A7 guard ---------- */
  await go(A.url);
  const before = reqs.length;
  const guard = await mp.evaluate(async (P) => { const { api } = await import('/assets/core/api.js'); try { await api('POST', `${P}/issues`, { title: 'phone write' }); return { ok: true }; } catch (e) { await new Promise((r) => setTimeout(r, 50)); return { code: e.code, msg: e.message, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }; } }, A.P);
  const sent = reqs.slice(before).filter((r) => r.startsWith('POST') || r.startsWith('PATCH'));
  check('A7 guard: api(POST …/issues) → phone_read_only, one toast, no request', guard.code === 'phone_read_only' && guard.toasts.length === 1 && guard.toasts[0] === 'PC에서 편집할 수 있습니다.' && sent.length === 0, JSON.stringify({ guard, sent }));
  const allowed = await mp.evaluate(async (w) => { const { api } = await import('/assets/core/api.js'); const codes = []; for (const u of ['/api/guides/WBS_INTRO/seen', `/api/workspaces/${w}/onboarding/product_tour/skip`]) { try { await api('POST', u, {}); codes.push('ok'); } catch (e) { codes.push(e.code === 'phone_read_only' ? 'blocked' : 'sent'); } } return codes.includes('blocked') ? 'blocked' : 'ok'; }, w);
  check('A7 allowlist: /api/guides/ and /onboarding/ still go out', allowed === 'ok', allowed);

  /* ---------- A8 PC-only pages (the server serves /admin to operators only) ---------- */
  sql(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = '${s.json.user.id}'`);
  for (const u of ['/app/projects/new', `${A.url}/edit`, '/admin']) {
    await go(u);
    const t = await mp.evaluate(() => { const e = document.querySelector('[data-pc-only]'); return e ? { h: e.querySelector('h2').textContent, home: Boolean(e.querySelector('a[href="/app"]')) } : null; });
    check(`A8 ${u}: PC-only page + 홈으로`, Boolean(t && t.home && (u === '/admin' ? t.h === '운영자 콘솔은 PC에서 사용할 수 있습니다.' : t.h === '프로젝트 만들기와 수정은 PC에서 할 수 있습니다.')), JSON.stringify(t));
  }
  await mp.screenshot({ path: `${SHOTS}/m-pc-only.png` });

  /* ---------- A9 cards · A10 read-only detail ---------- */
  const LISTS = [['requirements', '.gtable tbody tr[data-id]'], ['wbs', '.gtable tbody tr[data-id]'], ['issues', '.rtable tbody tr[data-row]'], ['changes', '.rtable tbody tr[data-row]'], ['tests', '.rtable tbody tr[data-row]']];
  for (const [k, rowSel] of LISTS) {
    await go(`${A.url}/${k}`);
    const card = await mp.evaluate((sel) => { const tr = document.querySelector(sel); if (!tr) return null; const tds = [...tr.children].filter((td) => td.getBoundingClientRect().width > 0);
      const r = tr.getBoundingClientRect(); const ys = [...new Set(tds.map((td) => Math.round(td.getBoundingClientRect().top / 6)))];
      return { lines: ys.length, h: Math.round(r.height), w: Math.round(r.width), thead: [...document.querySelectorAll('main thead')].filter((t) => t.getBoundingClientRect().height > 0).length }; }, rowSel);
    check(`A9 ${k}: card rows (≥ 2 lines, full width), no table header`, Boolean(card && card.lines >= 2 && card.w >= 330 && card.thead === 0), JSON.stringify(card));
    await mp.click(rowSel); await mp.waitForSelector('#drawer:not([hidden]) .drawer__x', { timeout: 8000 }).catch(() => {}); await mp.waitForTimeout(400);
    const det = await mp.evaluate(() => { const d = document.querySelector('#drawer'); if (!d || d.hidden) return null; const r = d.getBoundingClientRect(); const vis = (e) => e.getBoundingClientRect().width > 0;
      return { w: Math.round(r.width), x: Math.round(r.left), close: Boolean(d.querySelector('.drawer__x')), fields: [...d.querySelectorAll('input, select, textarea')].filter(vis).length, btns: [...d.querySelectorAll('button.btn')].filter(vis).map((b) => b.textContent.trim()) }; });
    check(`A10 ${k}: tap → full-screen read-only detail with ✕ (no input/select/textarea, no edit button)`, Boolean(det && det.w >= 375 && det.x === 0 && det.close && det.fields === 0 && det.btns.length === 0), JSON.stringify(det));
    await mp.screenshot({ path: `${SHOTS}/m-detail-${k}.png` });
  }

  /* ---------- A11 no Gantt ---------- */
  await go(`${A.url}/wbs`);
  check('A11 WBS: no WBS/Gantt switch', !(await mp.evaluate(() => [...document.querySelectorAll('[data-view="gantt"]')].some((e) => e.getBoundingClientRect().width > 0))));
  await go(`${A.url}/wbs?view=gantt`);
  const gl = await mp.evaluate(() => ({ line: (document.querySelector('[data-gantt-pc]') || {}).textContent || '', list: document.querySelectorAll('.gtable tbody tr').length, gantt: [...document.querySelectorAll('.gantt, .ganttwrap')].some((e) => e.getBoundingClientRect().width > 0) }));
  check('A11 /wbs?view=gantt: list + "간트 차트는 PC에서 볼 수 있습니다"', gl.line === '간트 차트는 PC에서 볼 수 있습니다' && gl.list > 5 && !gl.gantt, JSON.stringify(gl));

  /* ---------- A12 What's Next 01 rows ---------- */
  for (const [n, u] of [['01', `${A.url}?phase=INITIATION`], ['05', A.url]]) {
    await go(u);
    const rows = await mp.evaluate(() => [...document.querySelectorAll('.np__row')].map((r) => ({ w: Math.round(r.querySelector('.np__m').getBoundingClientRect().width), imp: Boolean(r.querySelector('.badge--imp')), st: Boolean(r.querySelector('.badge--st')), desc: r.querySelector('.np__purpose') ? r.querySelector('.np__purpose').getBoundingClientRect().height : 0 })));
    check(`A12 What's Next ${n}: rows ≥ 280px text, 필수/권장 + state, no description`, rows.length > 3 && rows.every((r) => r.w >= 280 && r.imp && r.st && r.desc === 0), JSON.stringify(rows.slice(0, 3)));
  }

  /* ---------- A13 tests first card ---------- */
  await go(`${A.url}/tests`);
  const first = await mp.evaluate(() => { const tr = document.querySelector('.rtable--tc tbody tr'); return { y: Math.round(tr.getBoundingClientRect().top), sw: document.querySelector('.rtable-wrap').scrollWidth, cw: document.querySelector('.rtable-wrap').clientWidth }; });
  check('A13 05 tests: first TC card above y = 320, no sideways scroll in the list', first.y < 320 && first.sw <= first.cw, JSON.stringify(first));

  /* ---------- 360 / 430 spot widths ---------- */
  for (const wd of [360, 430]) {
    await mp.setViewportSize({ width: wd, height: 812 });
    for (const [name, u] of ROUTES.filter(([n]) => ['home', 'next', 'next-01', 'overview', 'tests', 'wbs', 'requirements', 'report', 'settings', 'definition'].includes(n))) {
      await go(u); const a = await audit(mp);
      check(`A1 ${wd} ${name}: scrollWidth ≤ ${wd}`, a.sw <= wd, `${a.sw} ${a.sw > wd ? JSON.stringify(a.wide) : ''}`);
    }
  }
  await mp.setViewportSize({ width: 375, height: 812 });

  /* ---------- A14 rotate / resize 375 → 1024 → 375 without reload ---------- */
  await go(`${A.url}/requirements`);
  await mp.evaluate(() => { window.__noReload = 1; });
  await mp.setViewportSize({ width: 1024, height: 768 }); await mp.waitForTimeout(1200);
  const wide = await mp.evaluate(() => ({ same: window.__noReload === 1, phone: document.documentElement.classList.contains('is-phone'), tab: getComputedStyle(document.querySelector('.tabbar')).display, add: Boolean([...document.querySelectorAll('#add')].find((b) => b.getBoundingClientRect().width > 0)), pc: document.querySelectorAll('.pcline').length, chk: [...document.querySelectorAll('.gtable input[type=checkbox]')].filter((e) => e.getBoundingClientRect().width > 0).length }));
  const selEntry = await mp.evaluate(() => Boolean(document.querySelector('[data-rtool-r2] [data-selmode]')));   // Redesign R2: desktop checkboxes come from ⋯ › 여러 개 선택
  check('A14 375 → 1024: desktop re-render without reload (no tab bar, + 요구사항 추가 back, row checkboxes / 여러 개 선택 back)', wide.same && !wide.phone && wide.tab === 'none' && wide.add && wide.pc === 0 && (wide.chk > 0 || selEntry), JSON.stringify({ ...wide, selEntry }));
  await mp.setViewportSize({ width: 375, height: 812 }); await mp.waitForTimeout(1200);
  const back = await mp.evaluate(() => ({ same: window.__noReload === 1, phone: document.documentElement.classList.contains('is-phone'), pc: document.querySelectorAll('.pcline').length }));
  check('A14 1024 → 375: phone again without reload', back.same && back.phone && back.pc === 1, JSON.stringify(back));

  /* ---------- A18 desktop 1440 → 700 → 1440: an open 새 요구사항 drawer keeps what was typed (Q21-1) ---------- */
  {
    const dp = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', storageState: state })).newPage();
    dp.on('pageerror', (e) => log('PAGEERROR(1440)', e.message));
    await dp.goto(`${BASE}${A.url}/requirements`); await settle(dp);
    await dp.click('#add'); await dp.waitForSelector('#c-title');
    await dp.fill('#c-title', 'A18 리사이즈 제목'); await dp.fill('#c-desc', 'A18 설명 본문'); await dp.selectOption('select[name=scope]', 'OUT_OF_SCOPE'); await dp.fill('input[name=requester_name]', '김OO');
    const vals = () => dp.evaluate(() => { const v = (s) => { const e = document.querySelector(s); return e && e.getBoundingClientRect().height > 0 ? e.value : null; }; return { title: v('#c-title'), desc: v('#c-desc'), scope: v('select[name=scope]'), req: v('input[name=requester_name]') }; });
    await dp.setViewportSize({ width: 700, height: 900 }); await dp.waitForTimeout(1000);
    const mid = await dp.evaluate(() => document.documentElement.classList.contains('is-phone'));
    await dp.setViewportSize({ width: 1440, height: 900 }); await dp.waitForTimeout(1500);
    const got = await vals();
    check('A18 1440 → 700 → 1440: 새 요구사항 drawer keeps 제목, 설명, 범위, 요청자', mid && got.title === 'A18 리사이즈 제목' && got.desc === 'A18 설명 본문' && got.scope === 'OUT_OF_SCOPE' && got.req === '김OO', JSON.stringify({ mid, got }));
    await dp.click('#cf [type=submit]:not([data-more])'); await dp.waitForTimeout(1200);
    const saved = (await api('GET', `${A.P}/requirements?q=${encodeURIComponent('A18 리사이즈')}`)).json;
    const row = (saved?.requirements || saved?.items || []).find((r) => r.title === 'A18 리사이즈 제목');
    check('A18 the restored draft saves as typed (설명 + 범위)', Boolean(row) && row.description === 'A18 설명 본문' && row.scope === 'OUT_OF_SCOPE', JSON.stringify(row || saved).slice(0, 200));
    await dp.goto(`${BASE}${A.url}/requirements`); await settle(dp); await dp.click('#add'); await dp.waitForSelector('#c-title');
    await dp.setViewportSize({ width: 700, height: 900 }); await dp.waitForTimeout(800); await dp.setViewportSize({ width: 1440, height: 900 }); await dp.waitForTimeout(1200);
    check('A18 an untouched drawer comes back empty (nothing carried over)', (await vals()).title === '', JSON.stringify(await vals()));
    await dp.context().close();
  }

  /* ---------- M mobile-v2: landing impact, auth band, home tiles, 7 doors in 더보기, quiet WBS cards (phone only; desktop unchanged) ---------- */
  {
    const vis = (pg, sel) => pg.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }).length, sel);
    const lc = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', isMobile: true, hasTouch: true });
    const lp = await lc.newPage(); lp.on('pageerror', (e) => log('PAGEERROR(landing)', e.message));
    await lp.goto(BASE + '/'); await lp.waitForTimeout(400);
    const L = await lp.evaluate(() => ({ sw: document.documentElement.scrollWidth, h1: document.querySelector('.hero h1').getBoundingClientRect().bottom, cta: document.querySelector('.hero__actions a.btn--primary').getBoundingClientRect().bottom,
      og: Boolean(document.querySelector('meta[property="og:image"]')) }));
    const heroBtns = await vis(lp, '.hero__actions a.btn'); const shot = await vis(lp, '.mshot'); const desk = await vis(lp, '#preview'); const proof = await vis(lp, '.mproof li');
    check('M1 landing 375: one hero CTA above the fold, phone product shot + 3 proof cards, no 840px desktop mock, no sideways scroll', heroBtns === 1 && L.cta < 812 && shot === 1 && desk === 0 && proof === 3 && L.sw <= 375 && L.og, JSON.stringify({ ...L, heroBtns, shot, desk, proof }));
    const stickyAt = async (y) => { await lp.evaluate((v) => scrollTo(0, v), y); await lp.waitForTimeout(450); return lp.evaluate(() => document.getElementById('mcta').classList.contains('is-on')); };
    const s0 = await stickyAt(0); const s1 = await stickyAt(1800); const s2 = await stickyAt(999999);
    check('M1 landing 375: sticky 무료로 시작하기 appears after the hero CTA scrolls away and hides at the closing CTA', !s0 && s1 && !s2, JSON.stringify({ s0, s1, s2 }));
    await lp.goto(BASE + '/login'); await lp.waitForSelector('#email');
    const band = await vis(lp, '.aband'); const logo = await vis(lp, '.auth__form > .logo'); const lsw = await lp.evaluate(() => document.documentElement.scrollWidth);
    check('M2 /login 375: brand band on top (form logo folded into it), no sideways scroll', band === 1 && logo === 0 && lsw <= 375, JSON.stringify({ band, logo, lsw }));
    await lp.goto(BASE + '/signup'); await lp.waitForSelector('#name');
    check('M2 /signup 375: brand band, 7-phase pills folded away', (await vis(lp, '.aband')) === 1 && (await vis(lp, '.su-a-m')) === 0);
    await lp.setViewportSize({ width: 1440, height: 900 }); await lp.goto(BASE + '/'); await lp.waitForTimeout(400);
    const D = { phoneBlocks: await vis(lp, '.mshot, .mproof, .mcta, .hero__msub, .hero__mnote'), shot: await vis(lp, '#preview'), heroBtns: await vis(lp, '.hero__actions a.btn'), flow: await vis(lp, '.flowline') };
    check('M3 landing 1440 unchanged: desktop mock + 2 hero buttons + flowline, no phone blocks', D.phoneBlocks === 0 && D.shot === 1 && D.heroBtns === 2 && D.flow === 1, JSON.stringify(D));
    await lp.goto(BASE + '/login'); await lp.waitForSelector('#email');
    check('M3 /login 1440 unchanged: no brand band, side panel shown', (await vis(lp, '.aband')) === 0 && (await vis(lp, '.auth__side')) === 1);
    await lc.close();

    await go('/app');
    const tiles = await mp.evaluate(() => [...document.querySelectorAll('[data-home-tiles] .mtile')].map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
    check('M4 home 375: three tiles (진행 중 · 다음 할 일 · 지연/확인 필요) above the cards', tiles.length === 3 && /^진행 중 \d+개$/.test(tiles[0]) && /^다음 할 일 \d+건$/.test(tiles[1]), JSON.stringify(tiles));
    await go(`${A.url}/wbs`);
    const W = await mp.evaluate(() => ({ dots: document.querySelectorAll('#pstrip .pstrip__dots i').length, cur: [...document.querySelectorAll('#pstrip .pstrip__dots i')].findIndex((i) => i.classList.contains('is-cur')),
      dash: [...document.querySelectorAll('.gtable--wbs tbody td')].filter((td) => td.getBoundingClientRect().width > 0 && td.innerText.trim() === '-').length }));
    check('M5 status strip: 7 phase dots, current = 05; WBS cards show no bare "-" values', W.dots === 7 && W.cur === 4 && W.dash === 0, JSON.stringify(W));
    await mp.click('[data-tab-more]'); await mp.waitForTimeout(300);
    const doors = await mp.evaluate(() => ({ n: [...document.querySelectorAll('#side .mdoors__i')].filter((a) => a.getBoundingClientRect().height >= 44).length, act: (document.querySelector('#side .mdoors__i.is-active') || {}).textContent || '' }));
    check('M6 더보기: 7 doors as ≥ 44px tiles on top, 일정 active on /wbs', doors.n === 7 && doors.act.trim() === '▦일정', JSON.stringify(doors));
    await mp.click('#side .mdoors__i[data-door="requirements"]'); await mp.waitForTimeout(800);
    check('M6 door tile navigates (요구사항) and closes the sheet', /\/requirements$/.test(new URL(mp.url()).pathname) && !(await mp.evaluate(() => document.querySelector('#side').classList.contains('is-open'))), mp.url());
    await mp.screenshot({ path: `${SHOTS}/m-v2-requirements.png` });
  }

  /* ---------- A6 downloads (Chromium 375) ---------- */
  const DL = [
    ['사업수행계획서 PDF', `${A.url}/charter`, async (pg) => { await pg.click('.pmenu summary'); await pg.click('[data-plan="pdf"]'); }, /사업수행계획서.*\.pdf$/],
    ['요구사항 정의서 Word', `${A.url}/requirements`, (pg) => pg.click('[data-phone-reqdoc] [data-reqdoc="docx"]'), /요구사항.*\.docx$/],
    ['주간보고 PDF', `${A.url}/reports/${rep.id}`, (pg) => pg.click('[data-dl="pdf"]'), /주간보고.*\.pdf$/],
    ['주간보고 Word', `${A.url}/reports/${rep.id}`, (pg) => pg.click('[data-dl="docx"]'), /주간보고.*\.docx$/],
    ['완료보고서 PDF', `${B.url}/reports/${comp.id}`, (pg) => pg.click('[data-dl="pdf"]'), /완료보고서.*\.pdf$/],
    ['완료보고서 Word', `${B.url}/reports/${comp.id}`, (pg) => pg.click('[data-dl="docx"]'), /완료보고서.*\.docx$/],
  ];
  // WebKit hands the file name back decomposed (NFD) → compare in NFC
  const downloads = async (pg, label) => {
    for (const [n, u, act, re] of DL) {
      await pg.goto(BASE + u); await settle(pg);
      const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 20000 }).catch(() => null), act(pg).catch(() => null)]);
      const name = dl ? dl.suggestedFilename().normalize('NFC') : ''; const path = dl ? await dl.path().catch(() => null) : null; const size = path ? fs.statSync(path).size : 0;
      check(`A6 ${label} ${n}: file arrives with its Korean name`, re.test(name) && size > 1000, `${name} ${size}`);
    }
  };
  await downloads(mp, 'Chromium 375');

  /* ---------- A6 verify mail · logout · login · invite accept (Chromium 375) ---------- */
  await go('/app');
  await mp.click('#verify-resend'); await mp.waitForTimeout(800);
  check('A6 인증 메일 다시 받기 visible and sent', /메일을 보냈습니다|이미 인증/.test(await mp.textContent('#verify-resend').catch(() => '')) || !(await mp.$('#verifybar')));
  await go('/app/settings');
  const [lo] = await Promise.all([mp.waitForRequest((r) => r.url().endsWith('/api/auth/logout') && r.method() === 'POST', { timeout: 8000 }).catch(() => null), mp.click('[data-logout]')]);
  await mp.waitForURL(/\/login/, { timeout: 8000 }).catch(() => {});
  check('A6/A7 로그아웃 (POST /api/auth/logout goes out) → /login', Boolean(lo) && /\/login/.test(mp.url()), mp.url());
  await mp.fill('#email', email); await mp.fill('#password', password); await mp.click('button[type=submit]');
  await mp.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {});
  check('A6 로그인 on phone → /app', /\/app/.test(mp.url()), mp.url());
  // invitation: raw token in the mail, sha256(invite:SESSION_SECRET:token) in the DB (server/invitations.js)
  const token = crypto.randomBytes(24).toString('base64url'); const invEmail = `mob-inv-${Date.now()}@relai.test`;
  const hash = crypto.createHash('sha256').update(`invite:${process.env.SESSION_SECRET || ''}:${token}`).digest('hex');
  const meId = s.json.user.id;
  sql(`INSERT INTO invitations (id, type, workspace_id, email, role, workspace_name, token_hash, invited_by, expires_at) VALUES ('${crypto.randomUUID()}', 'WORKSPACE_MEMBER', '${w}', '${invEmail}', 'MEMBER', '김하늘님의 Workspace', '${hash}', '${meId}', now() + interval '7 days')`);
  const inv = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ko-KR', isMobile: true, hasTouch: true });
  const ip = await inv.newPage();
  await ip.goto(BASE + '/login');
  await ip.request.post(BASE + '/api/auth/signup', { data: { agree_terms: true, agree_privacy: true, name: '박초대', email: invEmail, password } });
  await ip.goto(`${BASE}/invite/${token}`); await ip.waitForSelector('#accept', { timeout: 8000 }).catch(() => {});
  await ip.screenshot({ path: `${SHOTS}/m-invite.png` });
  await ip.click('#accept').catch(() => {}); await ip.waitForTimeout(1500);
  const joined = Number(sql(`SELECT COUNT(*) FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = '${w}' AND u.email = '${invEmail}'`) || 0);
  check('A6 초대 수락 on phone (POST /api/invitations/:token/accept allowed)', joined === 1, `members=${joined} url=${ip.url()}`);
  await inv.close();

  /* ---------- A6 WebKit · devices['iPhone 13'] ---------- */
  const wk = await webkit.launch();
  const wctx = await wk.newContext({ ...devices['iPhone 13'], locale: 'ko-KR', acceptDownloads: true });
  const wp = await wctx.newPage(); wp.on('pageerror', (e) => log('PAGEERROR(webkit)', e.message));
  await wp.goto(BASE + '/'); await wp.waitForTimeout(400);
  const wl = await wp.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth, shot: document.querySelector('.mshot').getBoundingClientRect().height > 0, desk: document.querySelector('#preview').getBoundingClientRect().height }));
  check('M1 WebKit iPhone 13 landing: phone shot, no desktop mock, no sideways scroll', wl.sw <= wl.vw && wl.shot && wl.desk === 0, JSON.stringify(wl));
  await wp.goto(BASE + '/login'); await wp.fill('#email', email); await wp.fill('#password', password); await wp.click('button[type=submit]');
  await wp.waitForURL(/\/app/, { timeout: 15000 }).catch(() => {});
  check('A6 WebKit iPhone 13: 로그인 → /app, phone mode', /\/app/.test(wp.url()) && await wp.evaluate(() => document.documentElement.classList.contains('is-phone')), wp.url());
  await downloads(wp, 'WebKit iPhone 13');
  await wk.close();

  /* ---------- A15 PC 1440 ---------- */
  // the phone logout above ended the seed session → log in again for the PC / tablet contexts
  const login = async (c) => { const pg0 = await c.newPage(); await pg0.goto(BASE + '/login'); await pg0.request.post(BASE + '/api/auth/login', { data: { email, password } }); await pg0.close(); };
  const pc = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }); await login(pc);
  const pp = await pc.newPage(); pp.on('pageerror', (e) => log('PAGEERROR(1440)', e.message));
  const desk = async (label, vw, pg) => {
    for (const [n, u, sel] of [['home', '/app', 'a[href="/app/projects/new"]'], ['requirements', `${A.url}/requirements`, '#add'], ['wbs', `${A.url}/wbs`, '#add'], ['issues', `${A.url}/issues`, '#add'], ['tests', `${A.url}/tests`, '#add'], ['reports', `${A.url}/reports`, '#rp-new'], ['report', `${A.url}/reports/${rep.id}`, '#reopen']]) {
      await pg.goto(BASE + u); await settle(pg);
      const d = await pg.evaluate((sl) => ({ phone: document.documentElement.classList.contains('is-phone'), tab: getComputedStyle(document.querySelector('.tabbar')).display, pc: document.querySelectorAll('.pcline').length, ctl: Boolean([...document.querySelectorAll(sl)].find((e) => e.getBoundingClientRect().width > 0)), sw: document.documentElement.scrollWidth }), sel);
      check(`${label} ${n}: desktop (no tab bar, no PC line, edit control ${sel} present, no sideways scroll)`, !d.phone && d.tab === 'none' && d.pc === 0 && d.ctl && d.sw <= vw, JSON.stringify(d));
    }
  };
  await desk('A15 1440', 1440, pp);
  const made = await pp.evaluate(async (P) => { const { api } = await import('/assets/core/api.js'); return (await api('POST', `${P}/issues`, { title: 'PC write' })).issue ? 'ok' : 'no'; }, A.P);
  check('A15 1440: api() writes go out', made === 'ok', made);
  await pp.goto(BASE + '/app/projects/new'); await settle(pp);
  check('A15 1440: /app/projects/new shows the form', Boolean(await pp.$('main form')) && !(await pp.$('[data-pc-only]')));
  await pp.screenshot({ path: `${SHOTS}/pc-1440-new.png` });
  await pc.close();

  /* ---------- A16 tablet 768 / 900 · phone landscape 844 ---------- */
  for (const [vw, vh, mob] of [[768, 1024, false], [900, 1200, false], [844, 390, true]]) {
    const c2 = await browser.newContext({ viewport: { width: vw, height: vh }, locale: 'ko-KR', isMobile: mob, hasTouch: mob }); await login(c2);
    const p2 = await c2.newPage();
    await desk(`A16 ${vw}${mob ? ' landscape' : ''}`, vw, p2);
    await c2.close();
  }

  await browser.close();
  const fail = results.filter(([, ok]) => !ok);
  log(`\n${results.length - fail.length}/${results.length} PASS`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
