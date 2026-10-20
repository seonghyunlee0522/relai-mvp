/* batch7 #2 · #3 · #4 · #5 (T2): 적용 환경 on 01 범위, 산출물 카탈로그 (operator list → project picks → 계획서 §3 · 07 · 완료보고서),
 * 사업수행계획서 작성 가이드 + 작성 예시, migration 49 (open APPROVAL → 권장, promotion copy without ₩). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { migrations } from '../migrations.js';
import { buildPlanMarkdown } from '../charter-export.js';
import { buildProjectCharter, charterPromptBlock } from '../charter.js';
import { buildCompletionData, completionSections } from '../reports.js';

const admin = async (db, client, email = 'op@x.com') => {
  const A = await setup(client, email);
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [A.uid]);
  return A;
};
const projectRow = (db, id) => db.get('SELECT * FROM projects WHERE id = ?', [id]);

test('catalog seed: 31 items, BASIC = 필수 by default, ADVANCED = 제외; a project reads the defaults without rows', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'd1@x.com');
  const r = await A.c('GET', `${A.purl}/deliverables`);
  assert.equal(r.status, 200);
  const items = r.json.items;
  assert.equal(items.length, 31); assert.equal(r.json.has_selection, false);
  const ui = items.find((x) => x.name === '화면 설계서'); assert.equal(ui.tier, 'BASIC'); assert.equal(ui.level, 'REQUIRED'); assert.equal(ui.phase_key, 'ANALYSIS_DESIGN');
  assert.equal(items.find((x) => x.name === '아키텍처 설계서').level, 'EXCLUDED');
  assert.equal(r.json.summary.required, items.filter((x) => x.tier === 'BASIC').length);
  assert.deepEqual([...new Set(items.map((x) => x.phase_key))], ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS']);
  server.close();
});

test('project picks: level per item, 직접 추가 (update / remove), validation, archived 409, other workspace 404', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'd2@x.com'); const U = `${A.purl}/deliverables`;
  const cat = (await A.c('GET', U)).json.items; const arch = cat.find((x) => x.name === '아키텍처 설계서');
  let r = await A.c('PUT', U, { items: [{ catalog_id: arch.catalog_id, level: 'REQUIRED' }, { custom_name: '개인정보 영향평가서', phase_key: 'ANALYSIS_DESIGN', level: 'OPTIONAL' }] });
  assert.equal(r.status, 200); assert.equal(r.json.has_selection, true);
  assert.equal(r.json.items.find((x) => x.catalog_id === arch.catalog_id).level, 'REQUIRED');
  const custom = r.json.items.find((x) => x.custom); assert.equal(custom.name, '개인정보 영향평가서'); assert.equal(custom.level, 'OPTIONAL');
  r = await A.c('PUT', U, { items: [{ id: custom.id, level: 'REQUIRED', submitted_at: '2026-10-01' }] });
  assert.equal(r.json.items.find((x) => x.id === custom.id).submitted_at, '2026-10-01');
  assert.equal((await A.c('PUT', U, { items: [{ catalog_id: arch.catalog_id, level: 'MAYBE' }] })).status, 400);
  assert.equal((await A.c('PUT', U, { items: [{ custom_name: '', phase_key: 'TESTING' }] })).status, 400);
  assert.equal((await A.c('PUT', U, { items: [{ catalog_id: 'nope', level: 'REQUIRED' }] })).status, 400);
  r = await A.c('PUT', U, { items: [{ id: custom.id, remove: true }] }); assert.ok(!r.json.items.some((x) => x.custom));
  const B = await setup(client, 'd2b@x.com');
  assert.equal((await B.c('GET', U)).status, 404);
  await db.run(`UPDATE projects SET status = 'ARCHIVED' WHERE id = ?`, [A.p.id]);
  assert.equal((await A.c('PUT', U, { items: [{ catalog_id: arch.catalog_id, level: 'OPTIONAL' }] })).status, 409);
  server.close();
});

test('operator 산출물 목록: add → shows in new and existing projects (새 항목 · 선택 once 범위 is complete); edit; audit; non-operator 403', async () => {
  const { db, server, client } = await boot();
  const O = await admin(db, client);
  const A = await setup(client, 'd3@x.com');
  // A completes 범위 before the item exists (지원 환경 1개 → SCOPE 완료)
  let r = await A.c('POST', `${A.purl}/definition/sections/SCOPE/complete`, { environments: { devices: { PC_WEB: 'SUPPORTED' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await A.c('GET', '/api/admin/deliverables')).status, 403);
  r = await O.c('POST', '/api/admin/deliverables', { name: '개인정보 영향평가서', phase_key: 'ANALYSIS_DESIGN', tier: 'BASIC' });
  assert.equal(r.status, 200); const item = r.json.item; assert.equal(item.default_level, 'REQUIRED');
  assert.equal((await O.c('POST', '/api/admin/deliverables', { name: '', phase_key: 'X', tier: 'BASIC' })).status, 422);
  const inA = (await A.c('GET', `${A.purl}/deliverables`)).json.items.find((x) => x.catalog_id === item.id);
  assert.equal(inA.is_new, true); assert.equal(inA.level, 'OPTIONAL');   // finished plans never gain a 필수 silently
  const B = await setup(client, 'd3b@x.com');
  const inB = (await B.c('GET', `${B.purl}/deliverables`)).json.items.find((x) => x.catalog_id === item.id);
  assert.equal(inB.is_new, false); assert.equal(inB.level, 'REQUIRED');
  r = await O.c('PATCH', `/api/admin/deliverables/${item.id}`, { active: false });
  assert.equal(r.status, 200); assert.ok(!(await B.c('GET', `${B.purl}/deliverables`)).json.items.some((x) => x.catalog_id === item.id));
  const audit = await db.all(`SELECT action FROM admin_audit_logs WHERE target_type = 'DELIVERABLE' ORDER BY created_at`);
  assert.deepEqual(audit.map((x) => x.action), ['DELIVERABLE_CATALOG_CREATE', 'DELIVERABLE_CATALOG_UPDATE']);
  server.close();
});

test('적용 환경: saved on 01 범위, completes SCOPE (legacy 수행 범위 still counts), summary, AI block says 적용 환경, plan §3 table', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'd4@x.com'); const D = `${A.purl}/definition`;
  let r = await A.c('POST', `${D}/sections/SCOPE/complete`, {});
  assert.equal(r.status, 400); assert.match(r.json.error.fields.missing, /지원 환경/);
  assert.equal((await A.c('PUT', D, { environments: { devices: { PC_WEB: 'MAYBE' } } })).status, 400);
  assert.equal((await A.c('PUT', D, { environments: { devices: { SMART_TV: 'SUPPORTED' } } })).status, 400);
  r = await A.c('PUT', D, { environments: { devices: { PC_WEB: 'SUPPORTED', IOS_APP: 'UNSUPPORTED' }, browsers: { CHROME: 'SUPPORTED', EDGE: 'SUPPORTED' }, os: 'Windows 10 이상', languages: '한국어' }, scope_out: ['외부 접속'] });
  assert.equal(r.status, 200);
  const sec = r.json.sections.find((s) => s.key === 'SCOPE');
  assert.equal(sec.ready, true); assert.match(sec.summary, /지원 PC 웹·Chrome·Edge · 미지원 모바일 앱\(iOS\)/);
  assert.equal((await A.c('POST', `${D}/sections/SCOPE/complete`, {})).status, 200);
  const project = await projectRow(db, A.p.id);
  const c = await buildProjectCharter(db, project);
  assert.deepEqual(c.environments.rows[0], ['기기', 'PC 웹', '모바일 앱(iOS)']);
  const block = charterPromptBlock(c, (s, n = 400) => String(s || '').slice(0, n));
  assert.match(block, /적용 환경:\nPC 웹, Chrome, Edge \/ OS: Windows 10 이상 \/ 언어: 한국어/); assert.match(block, /제외 환경:\n모바일 앱\(iOS\)/);
  const md = buildPlanMarkdown(c, { today: '2026-10-20' }).markdown;
  assert.match(md, /\| 기기 \| PC 웹 \| 모바일 앱\(iOS\) \|/); assert.match(md, /제외: 외부 접속/);
  // a project that listed 수행 범위 before batch7 is still complete (하위 호환)
  const B = await setup(client, 'd4b@x.com');
  assert.equal((await B.c('POST', `${B.purl}/definition/sections/SCOPE/complete`, { scope_in: ['사내망 전용'] })).status, 200);
  server.close();
});

test('계획서 §3 산출물 표 + 07 count + 완료보고서 lines once the project chose; free text stays as 기존 입력', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'd5@x.com');
  await A.c('PUT', `${A.purl}/definition`, { deliverables: '요구사항 정의서, 운영 매뉴얼' });
  let r = await A.c('GET', `${A.purl}/deliverables`); assert.equal(r.json.legacy_text, '요구사항 정의서, 운영 매뉴얼');
  let c = await buildProjectCharter(db, await projectRow(db, A.p.id));
  assert.deepEqual(c.deliverableList, []);   // nothing chosen yet → the plan prints the free text
  assert.match(buildPlanMarkdown(c, { today: '2026-10-20' }).markdown, /\*\*산출물 목록\*\*\n- 요구사항 정의서, 운영 매뉴얼|\*\*산출물 목록\*\*\n요구사항 정의서, 운영 매뉴얼/);
  const ui = r.json.items.find((x) => x.name === '화면 설계서');
  r = await A.c('PUT', `${A.purl}/deliverables`, { items: [{ catalog_id: ui.catalog_id, level: 'REQUIRED', submitted_at: '2026-10-10' }] });
  assert.equal(r.json.summary.submitted, 1);
  c = await buildProjectCharter(db, await projectRow(db, A.p.id));
  const md = buildPlanMarkdown(c, { today: '2026-10-20' }).markdown;
  assert.match(md, /\| 단계 \| 산출물 \| 구분 \|/); assert.match(md, /\| 분석·설계 \| 화면 설계서 \| 필수 \|/);
  assert.ok(!md.includes('아키텍처 설계서'));   // 제외 is left out
  const data = await buildCompletionData(db, await projectRow(db, A.p.id));
  const scope = completionSections(data).find((s) => s.key === 'scope').body;
  assert.match(scope, new RegExp(`필수 산출물 ${r.json.summary.required}건 중 제출 1건`)); assert.match(scope, /\[분석·설계\] 화면 설계서 — 제출 2026-10-10/);
  server.close();
});

test('사업수행계획서: empty project prints 작성 가이드 (no 작성되지 않음); 작성 예시 PDF from the sample; WBS 단계별 일정 table when a WBS exists', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'd6@x.com');
  const md = buildPlanMarkdown(await buildProjectCharter(db, await projectRow(db, A.p.id)), { today: '2026-10-20' }).markdown;
  assert.ok(!md.includes('작성되지 않음')); assert.ok((md.match(/⟦작성 가이드: /g) || []).length >= 10);
  const ex = await A.c('GET', `${A.purl}/charter/example?format=pdf`, undefined, { raw: true });
  assert.equal(ex.status, 200); assert.equal(ex.headers.get('content-type'), 'application/pdf'); assert.equal(ex.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(decodeURIComponent(ex.headers.get('content-disposition')), /사업수행계획서_작성예시\.pdf/);
  const { examplePlan } = await import('../charter-export.js');
  const doc = await examplePlan({ today: '2026-10-20', catalog: await db.all('SELECT * FROM deliverable_catalog WHERE active ORDER BY sort') });
  assert.ok(!doc.markdown.includes('작성 가이드')); assert.match(doc.markdown, /다온생명/); assert.match(doc.markdown, /\| 분석·설계 \| 인터페이스 정의서 \| 필수 \|/);
  await A.c('POST', `${A.wbs}`, { title: '분석', item_type: 'SUMMARY' });
  const ex2 = await A.c('GET', `${A.purl}/charter/export?format=pdf`, undefined, { raw: true }); assert.equal(ex2.status, 200);
  const { wbsTopLevel } = await import('../charter-export.js');
  const top = await wbsTopLevel(db, A.p.id); assert.equal(top.length, 1); assert.equal(top[0].title, '분석');
  assert.match(buildPlanMarkdown(await buildProjectCharter(db, await projectRow(db, A.p.id)), { today: '2026-10-20', wbsPhases: top }).markdown, /\*\*단계별 일정 \(WBS\)\*\*/);
  server.close();
});

test('migration 49: open APPROVAL steps → 권장, completed ones untouched; unedited launch promotions lose ₩, edited ones stay', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'd7@x.com'); const B = await setup(client, 'd7b@x.com');
  const step = (p) => `(SELECT s.id FROM project_steps s JOIN project_phases ph ON ph.id = s.project_phase_id WHERE ph.project_id = '${p}' AND s.step_key = 'APPROVAL')`;
  await db.run(`UPDATE project_steps SET importance = 'REQUIRED', is_required = 1 WHERE id IN (${step(A.p.id)}, ${step(B.p.id)})`);
  await db.run(`UPDATE project_steps SET status = 'COMPLETED', completed_at = now() WHERE id = ${step(B.p.id)}`);
  await db.run(`UPDATE promotions SET body = '1 크레딧 = ₩10 (부가세 포함). 월 기본료 없이 쓴 만큼만 냅니다.' WHERE id = 'promo-ai-payg'`);
  await db.run(`UPDATE promotions SET body = '운영자가 고친 문구 ₩' WHERE id = 'promo-login'`);
  await migrations.find((m) => m.version === 49).up(db);
  const imp = async (p) => (await db.get(`SELECT importance, is_required FROM project_steps WHERE id = ${step(p)}`));
  assert.deepEqual({ ...(await imp(A.p.id)) }, { importance: 'RECOMMENDED', is_required: 0 });
  assert.deepEqual({ ...(await imp(B.p.id)) }, { importance: 'REQUIRED', is_required: 1 });
  assert.equal((await db.get(`SELECT body FROM promotions WHERE id = 'promo-ai-payg'`)).body, '월 기본료 없이 쓴 만큼만 크레딧이 차감됩니다.');
  assert.equal((await db.get(`SELECT body FROM promotions WHERE id = 'promo-login'`)).body, '운영자가 고친 문구 ₩');
  server.close();
});
