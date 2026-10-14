/* Phase 5 (05 시험): 요구사항별 테스트 준비 = 필수 (US-1), 결함 조치 = 실패 0 AND 열린 결함 이슈 0 (US-2), 목록 생성 테스트의 요구사항 연결 (US-3),
 * 수행자·수행일 (US-4), 05 주간보고 (US-6), 한국어 문구 (US-7), migration 36.
 * Spec: hive research/relai-phase-5-spec.md (v2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { PHASE_BY_KEY } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import { projectGuidance, testDoneTitle } from '../guidance.js';
import { testFromRequirement } from '../testing.js';
import { todayKst, addDays, weekKst } from '../../public/app/shared/kst-date.js';

const T = todayKst();
const STAKE = [
  { id: 'sh-pl', name: '최민석', org_type: 'OWN', org: '수행사', role: 'PL' },
  { id: 'sh-cl', name: '이수진', org_type: 'CLIENT', org: 'ACME', role: '현업 담당' },
];
const step = (g, phase, key) => g.phases.find((x) => x.phase_key === phase).steps.find((s) => s.step_key === key);
const toPhase = async (A, target) => {
  const order = ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE'];
  for (const key of order.slice(0, order.indexOf(target) + 1)) {
    const g = (await A.c('GET', A.purl)).json; if (g.project.current_phase === key) continue;
    const ph = g.phases.find((x) => x.phase_key === key);
    assert.equal((await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'NEXT' })).status, 200, `activate ${key}`);
  }
};
/** n in-scope requirements; criteria per index (array of lines), confirmed unless listed in `draft`. */
const reqs = async (A, n, { criteria = {}, draft = [] } = {}) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = (await A.c('POST', A.req, { title: `요구사항 ${i + 1}`, description: `설명 ${i + 1}`, scope: 'IN_SCOPE' })).json.requirement;
    for (const c of criteria[i] || []) assert.equal((await A.c('POST', `${A.req}/${r.id}/criteria`, { content: c })).status, 201);
    if (!draft.includes(i)) assert.equal((await A.c('PATCH', `${A.req}/${r.id}`, { status: 'CONFIRMED' })).status, 200);
    out.push(r);
  }
  return out;
};
const tests = (A) => `${A.purl}/tests`;
const stats = async (A) => (await A.c('GET', tests(A))).json.tests;
const g = async (A) => (await A.c('GET', A.purl)).json;

/* ---------- template ---------- */
test('template: 05 TEST_PLAN = 필수 "요구사항별 테스트 준비"; WEEKLY_REPORT 권장 right after DEFECTS, before NON_FUNCTIONAL; no English result words', () => {
  const st = PHASE_BY_KEY.TESTING.steps; const keys = st.map((s) => s.key);
  const tp = st.find((s) => s.key === 'TEST_PLAN');
  assert.equal(tp.importance, 'REQUIRED'); assert.equal(tp.is_required, 1); assert.equal(tp.title, '요구사항별 테스트 준비');
  assert.equal(tp.completion_criteria, '범위 내 요구사항이 모두 테스트와 연결되었거나 제외 사유가 있습니다.');
  assert.deepEqual(keys, ['TEST_PLAN', 'CASES', 'RUN', 'DEFECTS', 'WEEKLY_REPORT', 'NON_FUNCTIONAL']);
  assert.equal(st.find((s) => s.key === 'WEEKLY_REPORT').importance, 'RECOMMENDED');
  assert.ok(!/Pass|Fail|Blocked/.test(st.map((s) => s.description + s.completion_criteria).join(' ')));
});

/* ---------- US-1 ---------- */
test('US-1 coverage gate: 15 confirmed + 1 linked test → TEST_PLAN 진행 중, 05 gate unmet; progress text with real numbers', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const R = await reqs(A, 15); await toPhase(A, 'TESTING');
  const t = (await A.c('POST', tests(A), { title: '로그인' })).json.test;
  assert.equal((await A.c('POST', `${tests(A)}/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: R[0].id })).status, 201);
  const G = await g(A); const a = step(G, 'TESTING', 'TEST_PLAN');
  assert.equal(a.importance, 'REQUIRED'); assert.equal(a.state, 'IN_PROGRESS');
  assert.equal(a.text, '범위 내 요구사항 15건 중 1건에 테스트가 있습니다 (제외 0건)');
  assert.equal(a.cta.label, '요구사항별 테스트 만들기');
  assert.equal(G.current_phase.summary.gate_met, false);
  assert.equal(G.guidance.rule, 'TEST_PLAN'); assert.equal(G.guidance.primary_action.label, '요구사항별 테스트 만들기');
  const s = await stats(A); assert.equal(s.target, 15); assert.equal(s.target_tested, 1); assert.equal(s.in_scope_untested, 14);
  server.close();
});

test('US-1 요구사항별 테스트 만들기: preview 14 → 14 created + linked, 기대 결과 = 완료 조건 (줄마다) or 설명, 준비됨, history; TEST_PLAN 완료; then 409', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const R = await reqs(A, 15, { criteria: { 1: ['로그인 성공 시 홈으로 이동'], 2: ['조건 A', '조건 B'] } });
  await toPhase(A, 'TESTING');
  const t0 = (await A.c('POST', tests(A), { title: '수동 테스트' })).json.test;
  await A.c('POST', `${tests(A)}/${t0.id}/links`, { target_type: 'REQUIREMENT', target_id: R[0].id });
  const pv = (await A.c('GET', `${tests(A)}/from-requirements/preview`)).json.preview;
  assert.equal(pv.count, 14); assert.equal(pv.items[0].title, `${R[1].display_id} 요구사항 2 확인`);
  const r = await A.c('POST', `${tests(A)}/from-requirements`, {});
  assert.equal(r.status, 201); assert.equal(r.json.created, 14); assert.equal(r.json.tests.in_scope_untested, 0);
  const list = (await A.c('GET', tests(A))).json.items;
  const byTitle = (s) => list.find((x) => x.title === s);
  const t1 = (await A.c('GET', `${tests(A)}/${byTitle(`${R[1].display_id} 요구사항 2 확인`).id}`)).json.test;
  assert.equal(t1.expected_result, '로그인 성공 시 홈으로 이동'); assert.equal(t1.status, 'READY');
  assert.deepEqual(t1.links.requirements.map((l) => l.target_id), [R[1].id]);
  assert.ok(t1.history.some((h) => h.action_type === 'GENERATED' && h.new_value === '요구사항에서 생성'));
  assert.equal(byTitle(`${R[2].display_id} 요구사항 3 확인`) && (await A.c('GET', `${tests(A)}/${byTitle(`${R[2].display_id} 요구사항 3 확인`).id}`)).json.test.expected_result, '- 조건 A\n- 조건 B');
  assert.equal((await A.c('GET', `${tests(A)}/${byTitle(`${R[3].display_id} 요구사항 4 확인`).id}`)).json.test.expected_result, '설명 4', 'no criteria → description');
  assert.equal(step(await g(A), 'TESTING', 'TEST_PLAN').state, 'COMPLETED');
  // nothing left → preview 0, POST 409, What's Next CTA gone
  assert.equal((await A.c('GET', `${tests(A)}/from-requirements/preview`)).json.preview.count, 0);
  const again = await A.c('POST', `${tests(A)}/from-requirements`, {}); assert.equal(again.status, 409); assert.equal(again.json.error.code || again.json.code || 'nothing_to_create', 'nothing_to_create');
  assert.equal((await A.c('GET', tests(A))).json.items.length, 15, 'no duplicates');
  server.close();
});

test('US-1 testFromRequirement: title, criteria lines, description fallback', () => {
  assert.deepEqual(testFromRequirement({ display_id: 'REQ-007', title: '결재', description: 'd', criteria: [] }), { title: 'REQ-007 결재 확인', expected_result: 'd', status: 'READY', priority: 'MEDIUM' });
  assert.equal(testFromRequirement({ display_id: 'REQ-1', title: 'x', description: 'd', criteria: ['a'] }).expected_result, 'a');
});

test('US-1 테스트 제외: reason counts as covered, blank 422, null cancels, requirement history; unconfirmed in-scope not counted + C1 warn line', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const R = await reqs(A, 3, { draft: [2] }); await toPhase(A, 'TESTING');
  const ex = (rid, body) => A.c('PATCH', `${A.req}/${rid}/test-exclusion`, body);
  for (const bad of [{ reason: '' }, { reason: '   ' }, {}]) assert.equal((await ex(R[0].id, bad)).status, 422, JSON.stringify(bad));
  await A.c('POST', `${tests(A)}/from-requirements`, {});   // 2 confirmed → 2 tests (the draft one is not a target)
  let s = await stats(A); assert.equal(s.target, 2); assert.equal(s.in_scope_unconfirmed, 1); assert.equal(s.in_scope_untested, 0);
  // archive R[1]'s test → untested; exclude it → covered
  const tl = (await A.c('GET', `${tests(A)}?requirement=${R[1].id}`)).json.items[0];
  await A.c('POST', `${tests(A)}/${tl.id}/archive`, {});
  assert.equal(step(await g(A), 'TESTING', 'TEST_PLAN').state, 'IN_PROGRESS');
  const r = await ex(R[1].id, { reason: '06 검수에서 고객이 직접 확인' }); assert.equal(r.status, 200);
  s = await stats(A); assert.equal(s.excluded, 1); assert.equal(s.in_scope_untested, 0);
  let G = await g(A); assert.equal(step(G, 'TESTING', 'TEST_PLAN').state, 'COMPLETED'); assert.match(step(G, 'TESTING', 'TEST_PLAN').text, /제외 1건/);
  const cov = (await A.c('GET', `${tests(A)}/coverage`)).json.coverage; assert.equal(cov.find((x) => x.id === R[1].id).test_exclusion_reason, '06 검수에서 고객이 직접 확인');
  // C1: guidance warns about the unconfirmed in-scope requirement (and links the 미확정 filter); 0 → no line
  const w = '확정되지 않은 범위 내 요구사항 1건 — 확정하면 테스트 대상에 들어갑니다';
  assert.ok(G.guidance.warnings.includes(w)); assert.match(G.guidance.warning_links[w], /requirements\?scope=IN_SCOPE&status=DRAFT,REVIEWING,ON_HOLD,REJECTED$/);
  assert.ok(!G.guidance.warnings.some((x) => /^미확정 요구사항/.test(x)), 'no duplicate generic line in 05');
  // cancel → back to untested; history
  assert.equal((await ex(R[1].id, { reason: null })).status, 200);
  assert.equal(step(await g(A), 'TESTING', 'TEST_PLAN').state, 'IN_PROGRESS');
  const hist = (await A.c('GET', `${A.req}/${R[1].id}/history`)).json;
  const rows = (hist && (hist.history || hist.items)) || (await A.c('GET', `${A.req}/${R[1].id}`)).json.requirement.history || [];
  assert.ok(rows.some((h) => h.action_type === 'TEST_EXCLUDED') && rows.some((h) => h.action_type === 'TEST_EXCLUSION_CANCELLED'), 'history rows');
  // confirm the draft one → it becomes a target; warn line gone
  await A.c('PATCH', `${A.req}/${R[2].id}`, { status: 'CONFIRMED' });
  G = await g(A); assert.ok(!G.guidance.warnings.some((x) => /확정되지 않은 범위 내/.test(x)));
  assert.equal((await stats(A)).target, 3);
  server.close();
});

test('US-1 completion guide title uses real numbers, never "테스트가 모두 통과했습니다"', async () => {
  assert.equal(testDoneTitle({ target: 15, total: 16, last_pass: 16, excluded: 0 }), '요구사항 15건 검증 완료 · 테스트 16건 모두 통과');
  assert.equal(testDoneTitle({ target: 15, total: 16, last_pass: 16, excluded: 2 }), '요구사항 15건 검증 완료 · 테스트 16건 모두 통과 · 제외 2건');
  const { server, client } = await boot();
  const A = await setup(client); await reqs(A, 2); await toPhase(A, 'TESTING');
  await A.c('POST', `${tests(A)}/from-requirements`, {});
  for (const t of (await A.c('GET', tests(A))).json.items) await A.c('POST', `${tests(A)}/${t.id}/executions`, { result: 'PASS' });
  const G = await g(A);
  assert.equal(G.guidance.rule, 'TEST_DONE'); assert.equal(G.guidance.title, '요구사항 2건 검증 완료 · 테스트 2건 모두 통과');
  assert.ok(!JSON.stringify(G.guidance).includes('테스트가 모두 통과했습니다'));
  assert.equal(G.current_phase.summary.gate_met, true);
  server.close();
});

/* ---------- US-2 ---------- */
test('US-2 DEFECTS: fail → issue → pass with box off keeps it open (05 required unmet); box on resolves the issue with text; issue-screen resolve also completes', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await reqs(A, 1); await toPhase(A, 'TESTING');
  await A.c('POST', `${tests(A)}/from-requirements`, {});
  const tc = (await A.c('GET', tests(A))).json.items[0];
  const fail = (await A.c('POST', `${tests(A)}/${tc.id}/executions`, { result: 'FAIL', actual_result: '오류 화면' })).json.execution;
  const iss = (await A.c('POST', `${tests(A)}/${tc.id}/executions/${fail.id}/issue`, {})).json.issue;
  let a = step(await g(A), 'TESTING', 'DEFECTS'); assert.equal(a.state, 'IN_PROGRESS');
  // 체크 끄고 통과
  await A.c('POST', `${tests(A)}/${tc.id}/executions`, { result: 'PASS', actual_result: '정상' });
  let G = await g(A); a = step(G, 'TESTING', 'DEFECTS');
  assert.equal(a.state, 'IN_PROGRESS'); assert.equal(a.text, `실패 테스트 0건 · 처리 중 결함 이슈 1건(${iss.display_id})`);
  assert.equal(a.cta.label, '결함 이슈 보기'); assert.match(a.cta.href, /issues\?source=TEST$/);
  assert.equal(G.current_phase.summary.gate_met, false); assert.equal(G.guidance.rule, 'TEST_DEFECT_OPEN');
  assert.deepEqual((await A.c('GET', `${A.purl}/issues?source=TEST`)).json.items.map((x) => x.display_id), [iss.display_id]);
  // 체크 켬 (resolve_issue_ids)
  const r = await A.c('POST', `${tests(A)}/${tc.id}/executions`, { result: 'PASS', actual_result: '재확인 정상', resolve_issue_ids: [iss.id] });
  assert.equal(r.status, 201); assert.deepEqual(r.json.execution.resolved, [iss.display_id]);
  const i2 = (await A.c('GET', `${A.purl}/issues/${iss.id}`)).json.issue;
  assert.equal(i2.status, 'RESOLVED'); assert.equal(i2.resolution, `재시험 통과 (${tc.display_id} #3): 재확인 정상`);
  G = await g(A); assert.equal(step(G, 'TESTING', 'DEFECTS').state, 'COMPLETED'); assert.equal(G.current_phase.summary.gate_met, true);
  // a FAIL never resolves; a second test + issue resolved from the Issue screen also completes
  const t2 = (await A.c('POST', tests(A), { title: '두 번째' })).json.test;
  const f2 = (await A.c('POST', `${tests(A)}/${t2.id}/executions`, { result: 'FAIL' })).json.execution;
  const is2 = (await A.c('POST', `${tests(A)}/${t2.id}/executions/${f2.id}/issue`, {})).json.issue;
  await A.c('POST', `${tests(A)}/${t2.id}/executions`, { result: 'FAIL', resolve_issue_ids: [is2.id] });
  assert.equal((await A.c('GET', `${A.purl}/issues/${is2.id}`)).json.issue.status, 'OPEN', 'FAIL ignores resolve_issue_ids');
  await A.c('POST', `${tests(A)}/${t2.id}/executions`, { result: 'PASS' });
  assert.equal(step(await g(A), 'TESTING', 'DEFECTS').state, 'IN_PROGRESS');
  assert.equal((await A.c('PATCH', `${A.purl}/issues/${is2.id}`, { status: 'RESOLVED' })).status, 200);
  assert.equal(step(await g(A), 'TESTING', 'DEFECTS').state, 'COMPLETED');
  // another test's issue id is ignored
  server.close();
});

/* ---------- US-3 ---------- */
test('US-3 a test created from the list with a requirement shows on coverage', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const R = await reqs(A, 2); await toPhase(A, 'TESTING');
  const t = (await A.c('POST', tests(A), { title: '목록에서 추가' })).json.test;
  assert.equal(Number((await A.c('GET', tests(A))).json.items[0].requirement_count), 0, '요구사항 없음');
  await A.c('POST', `${tests(A)}/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: R[1].id });
  const cov = (await A.c('GET', `${tests(A)}/coverage`)).json.coverage;
  assert.equal(cov.find((x) => x.id === R[1].id).total, 1); assert.equal(cov.find((x) => x.id === R[0].id).total, 0);
  server.close();
});

/* ---------- US-4 ---------- */
test('US-4 수행자·수행일: client stakeholder + yesterday kept; recorder stays; default = me + today; future 422; 3 groups offered', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await A.c('PUT', `${A.purl}/definition`, { stakeholders: STAKE }); await toPhase(A, 'TESTING');
  const t = (await A.c('POST', tests(A), { title: '현업 확인' })).json.test;
  const d = (await A.c('GET', `${tests(A)}/${t.id}`)).json;
  assert.deepEqual(d.performers.clients.map((x) => x.name), ['이수진']); assert.deepEqual(d.performers.team.map((x) => x.name), ['최민석']);
  const y = addDays(T, -1);
  assert.equal((await A.c('POST', `${tests(A)}/${t.id}/executions`, { result: 'PASS', performer_stakeholder_id: 'sh-cl', performed_on: y })).status, 201);
  assert.equal((await A.c('POST', `${tests(A)}/${t.id}/executions`, { result: 'PASS' })).status, 201);
  const fut = await A.c('POST', `${tests(A)}/${t.id}/executions`, { result: 'PASS', performed_on: addDays(T, 1) });
  assert.equal(fut.status, 422); assert.match(JSON.stringify(fut.json), /오늘 이후/);
  assert.equal((await A.c('POST', `${tests(A)}/${t.id}/executions`, { result: 'PASS', performer_stakeholder_id: 'nope' })).status, 400);
  const ex = (await A.c('GET', `${tests(A)}/${t.id}`)).json.test.executions;
  const e1 = ex.find((e) => e.execution_number === 1); const e2 = ex.find((e) => e.execution_number === 2);
  assert.equal(String(e1.performed_on).slice(0, 10), y); assert.equal(e1.performer_name, '이수진'); assert.equal(e1.performer_org, '고객사'); assert.equal(e1.executed_by, A.uid);
  assert.equal(String(e2.performed_on).slice(0, 10), T); assert.equal(e2.performer_user_id, A.uid); assert.equal(e2.performer_name, '홍길동');
  assert.equal(ex.length, 2, 'the 422 and 400 attempts recorded nothing');
  server.close();
});

/* ---------- US-6 ---------- */
test('US-6 05 WEEKLY_REPORT: 권장 row, FINAL this week → ✓; never part of the 05 gate', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toPhase(A, 'TESTING');
  let a = step(await g(A), 'TESTING', 'WEEKLY_REPORT');
  assert.equal(a.importance, 'RECOMMENDED'); assert.equal(a.state, 'NOT_STARTED'); assert.equal(a.cta.label, '주간보고 만들기');
  const wk = weekKst();
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end })).json.report;
  await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/finalize`, {});
  a = step(await g(A), 'TESTING', 'WEEKLY_REPORT'); assert.equal(a.state, 'COMPLETED'); assert.match(a.text, /^✓ 이번 주 보고 확정/);
  server.close();
});

/* ---------- US-7 ---------- */
test('US-7 05 activity / guide texts: Korean result words, "실패를" (no 실패을), 이슈 not Issue', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await reqs(A, 1); await toPhase(A, 'TESTING');
  await A.c('POST', `${tests(A)}/from-requirements`, {});
  const tc = (await A.c('GET', tests(A))).json.items[0];
  await A.c('POST', `${tests(A)}/${tc.id}/executions`, { result: 'FAIL' });
  let G = await g(A);
  const txt = JSON.stringify([G.guidance, G.current_phase.steps.map((s) => [s.title, s.text, s.description, s.completion_criteria, s.cta && s.cta.label])]);
  assert.ok(!/실패을/.test(txt)); assert.match(G.guidance.description, /실패를/);
  assert.ok(!/\b(Pass|Fail|Blocked|Coverage|Issue)\b/.test(txt), txt.match(/\b(Pass|Fail|Blocked|Coverage|Issue)\b/));
  await A.c('POST', `${tests(A)}/${tc.id}/executions`, { result: 'PASS' });
  G = await g(A); assert.match(step(G, 'TESTING', 'RUN').text, /\(통과 1 · 실패 0 · 막힘 0\)/);
  server.close();
});

/* ---------- migration 36 ---------- */
test('migration 36: TEST_PLAN → 필수 + new texts, WEEKLY_REPORT after DEFECTS once; a project past 05 without coverage shows 05 as gap (◐)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await reqs(A, 2); await toPhase(A, 'TRANSITION_GO_LIVE');   // 05 passed with no tests at all
  // legacy shape: TEST_PLAN 권장 with old texts, no 05 WEEKLY_REPORT
  await db.run(`UPDATE project_steps SET is_required = 0, importance = 'RECOMMENDED', title = '테스트 범위 정의', completion_criteria = '범위 내 요구사항이 모두 테스트와 연결되어 있습니다.' WHERE step_key = 'TEST_PLAN'`);
  await db.run(`DELETE FROM project_steps WHERE step_key = 'WEEKLY_REPORT' AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TESTING')`);
  const m36 = migrations.find((m) => m.version === 36); assert.ok(m36); assert.ok(migrations[migrations.length - 1].version >= 36);
  await m36.up(db); await m36.up(db);
  const steps = await db.all(`SELECT s.step_key, s.importance, s.is_required, s.title, s.completion_criteria, s.status FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE p.project_id = ? AND p.phase_key = 'TESTING' ORDER BY s.sequence`, [A.p.id]);
  const keys = steps.map((s) => s.step_key);
  assert.deepEqual(keys, ['TEST_PLAN', 'CASES', 'RUN', 'DEFECTS', 'WEEKLY_REPORT', 'NON_FUNCTIONAL']);
  const tp = steps[0]; assert.equal(tp.importance, 'REQUIRED'); assert.equal(Number(tp.is_required), 1); assert.equal(tp.title, '요구사항별 테스트 준비');
  assert.equal(tp.completion_criteria, '범위 내 요구사항이 모두 테스트와 연결되었거나 제외 사유가 있습니다.');
  const wr = steps.find((s) => s.step_key === 'WEEKLY_REPORT'); assert.equal(wr.importance, 'RECOMMENDED'); assert.equal(wr.status, 'TODO');
  const G = await g(A); const ph = G.phases.find((x) => x.phase_key === 'TESTING');
  assert.equal(ph.display_state, 'gap', '05 passed with REQUIRED open → ◐, not ✓');
  assert.equal(G.project.current_phase, 'TRANSITION_GO_LIVE', 'never blocked');
  server.close();
});

/* ---------- 01–04 regression on the shared guidance ---------- */
test('regression: other phases keep the generic 미확정 warning; TESTING with 0 tests and 0 targets → manual add CTA', () => {
  const base = { project: { id: 'p', workspace_id: 'w', current_phase: 'DEVELOPMENT' }, next_phase: null, definition: {}, overdue_tasks: 0 };
  const dev = projectGuidance({ ...base, phase: { phase_key: 'DEVELOPMENT', steps: [] }, stats: { requirements: { total: 3, in_scope: 3, in_scope_confirmed: 2 }, wbs: { tasks: 1, by_phase: {} } } });
  assert.ok(dev.warnings.includes('미확정 요구사항 1건'));
  const te = projectGuidance({ ...base, phase: { phase_key: 'TESTING', steps: [] }, stats: { tests: { total: 0, in_scope_untested: 0 } } });
  assert.equal(te.rule, 'TEST_EMPTY'); assert.equal(te.primary_action.label, '테스트 케이스 작성 →');
});
