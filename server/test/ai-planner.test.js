/* Phase 15 — AI Project WBS Planner (fake provider) + OpenAI adapter regression (mocked fetch). Spec §52 / §53. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { setFakeProvider, fakeCalls, createProvider, AiProviderError } from '../ai/provider.js';
import { normalizeQuestions, normalizeCandidates, computeCoverage, knownAreasFrom, mergeEdits } from '../ai/planner.js';

process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.DEV_INITIAL_AI_CREDITS = '1000'; process.env.AI_MODEL = '';
delete process.env.AI_USER_MINUTE_LIMIT; delete process.env.AI_DAILY_LIMIT;

const mkReq = async (A, body) => (await A.c('POST', A.req, body)).json.requirement;
const mkWbs = async (A, body) => (await A.c('POST', A.wbs, body)).json.item;
const runsOf = (db, wid) => db.all('SELECT * FROM ai_runs WHERE workspace_id = ? ORDER BY created_at, seq', [wid]);
const balance = async (A) => (await A.c('GET', `${A.purl}/ai/status`)).json.credits.balance;
const P = (A) => `${A.purl}/ai/wbs-plans`;
const q = (area, question, options, extra = {}) => ({ id: `q_${area.toLowerCase()}`, area, question, help_text: null, type: 'SINGLE', required: false, options: options.map(([id, label, followups = []]) => ({ id, label, followups: followups.map(([f, l]) => ({ id: f, label: l })) })), allow_other: false, reason: 'WBS에 영향', ...extra });
const QUESTIONS = (extra = []) => ({ areas: [{ area: 'FUNCTIONAL_DEVELOPMENT', status: 'REQUIRED', source: 'REQUIREMENT', reason: '요구사항' }, { area: 'DATA_MIGRATION', status: 'UNKNOWN', source: 'INFERRED', reason: '확인 불가' }, { area: 'INFRASTRUCTURE', status: 'UNKNOWN', source: 'INFERRED', reason: '확인 불가' }, { area: 'INTERFACE', status: 'UNKNOWN', source: 'INFERRED', reason: '확인 불가' }, { area: 'TRAINING', status: 'POSSIBLE', source: 'INFERRED', reason: '보통 필요' }],
  questions: [q('DATA_MIGRATION', '데이터 이관이 필요한가요?', [['none', '없음'], ['yes', '있음', [['db', '기존 DB'], ['excel', 'Excel / 파일']]], ['undecided', '아직 미정']]), q('INFRASTRUCTURE', '구축 환경은?', [['saas', 'SaaS'], ['customer_cloud', '고객사 Cloud'], ['on_premise', 'On-Premise'], ['undecided', '아직 미정']]),
    q('INTERFACE', '외부 연계가 있나요?', [['sso', 'SSO'], ['erp', 'ERP'], ['none', '없음']], { type: 'MULTI' }), q('TRAINING', '사용자 교육이 필요한가요?', [], { type: 'BOOLEAN' }), ...extra] });
const it = (temp, title, area, parent = null, reqs = [], o = {}) => ({ temp_id: temp, parent_temp_id: parent, item_type: 'TASK', title, description: '', project_area: area, planned_duration_days: null, related_requirement_ids: reqs, ...o });
const DRAFT = (reqIds) => ({ items: [
  it('AI-WBS-1', '프로젝트 관리', 'PROJECT_MANAGEMENT'), it('AI-WBS-2', '착수회의', 'PROJECT_MANAGEMENT', 'AI-WBS-1'), it('AI-WBS-3', '주간보고', 'PROJECT_MANAGEMENT', 'AI-WBS-1'),
  it('AI-WBS-4', '기능 개발', 'FUNCTIONAL_DEVELOPMENT'), ...reqIds.map((r, i) => it(`AI-WBS-${10 + i}`, `${r} 구현`, 'FUNCTIONAL_DEVELOPMENT', 'AI-WBS-4', [r], { planned_duration_days: 5 })),
  it('AI-WBS-20', '데이터 이관', 'DATA_MIGRATION'), it('AI-WBS-21', '이관 대상 분석', 'DATA_MIGRATION', 'AI-WBS-20'), it('AI-WBS-22', 'Final Migration', 'DATA_MIGRATION', 'AI-WBS-20'),
  it('AI-WBS-30', 'Azure 운영 환경 구성', 'INFRASTRUCTURE'), it('AI-WBS-31', 'SSO 연계', 'INTERFACE', null, [], { related_requirement_ids: ['REQ-999'] }),
  it('AI-WBS-40', '테스트', 'TESTING'), it('AI-WBS-41', '통합 테스트', 'TESTING', 'AI-WBS-40'),
  it('AI-WBS-50', '오픈', 'STABILIZATION', null, [], { item_type: 'MILESTONE' }),
], notes: ['데모'] });
/** Full happy path up to REVIEW: returns { plan, reqs }. Answers: migration yes(db), customer cloud, SSO, training true. */
async function toReview(A, { reqTitles = ['로그인 기능', '권한 관리', '사용자 조회'], all = true } = {}) {
  const reqs = []; for (const t of reqTitles) reqs.push(await mkReq(A, { title: t, status: 'CONFIRMED', scope: 'IN_SCOPE' }));
  setFakeProvider(() => ({ data: QUESTIONS() }));
  const c = await A.c('POST', P(A), all ? { all: true } : { requirement_ids: reqs.map((r) => r.id) });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const plan = c.json.plan; const pid = plan.id;
  const an = await A.c('PATCH', `${P(A)}/${pid}/answers`, { answers: { q_data_migration: { value: 'yes', followups: ['db'] }, q_infrastructure: { value: 'customer_cloud' }, q_interface: { value: ['sso'] }, q_training: { value: true } } });
  assert.equal(an.status, 200, JSON.stringify(an.json));
  setFakeProvider(() => ({ data: DRAFT(reqs.map((r) => r.display_id)) }));
  const g = await A.c('POST', `${P(A)}/${pid}/generate`, {});
  assert.equal(g.status, 200, JSON.stringify(g.json));
  return { plan: g.json.plan, reqs, pid, run: g.json.run };
}

test('planner: AI disabled → 503; questions from fake provider; all vs selected requirements; archived excluded; definition + existing WBS in context; no duplicate questions for known areas; caps; invalid area / schema', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'p1@x.com');
  const r1 = await mkReq(A, { title: '로그인 기능', status: 'CONFIRMED', scope: 'IN_SCOPE' }); const r2 = await mkReq(A, { title: '권한 관리' }); const r3 = await mkReq(A, { title: '보관됨' });
  await A.c('POST', `${A.req}/${r3.id}/archive`, {});
  await mkWbs(A, { item_type: 'TASK', title: '기존 착수회의' });
  await A.c('PUT', `${A.purl}/definition`, { goal: 'ERP 구축 — 고객사 Azure 환경, 기존 시스템 데이터 존재', scope_in: ['회계'], stakeholders: [{ name: '김', org: 'ACME', org_type: '고객사' }] });
  // 1. AI disabled
  process.env.AI_ENABLED = 'false';
  let r = await A.c('POST', P(A), { all: true }); assert.equal(r.status, 503); assert.equal(r.json.error.code, 'AI_DISABLED');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM ai_wbs_plans')).n), 0, 'no plan row left behind');
  process.env.AI_ENABLED = 'true';
  // 2/4/5/6/7. questions; all requirements (archived excluded); definition + existing WBS in the prompt
  setFakeProvider(() => ({ data: QUESTIONS([q('DATA_MIGRATION', '중복 질문', [['a', 'A'], ['b', 'B']]), q('BOGUS_AREA', '잘못된 영역', [['a', 'A'], ['b', 'B']]), q('SECURITY', '질문 9', [['a', 'A'], ['b', 'B']]), q('UAT', '질문 10', [['a', 'A'], ['b', 'B']]), q('DEPLOYMENT', '질문 11', [['a', 'A'], ['b', 'B']]), q('DOCUMENTATION', '질문 12', [['a', 'A'], ['b', 'B']]), q('STABILIZATION', '질문 13', [['a', 'A'], ['b', 'B']]), q('ENVIRONMENT', '질문 14', [['a', 'A'], ['b', 'B']]), q('CUTOVER', '질문 15', [['a', 'A'], ['b', 'B']])]) }));
  r = await A.c('POST', P(A), { all: true });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const plan = r.json.plan;
  assert.equal(plan.status, 'QUESTIONS_READY'); assert.deepEqual(plan.requirement_ids.sort(), [r1.id, r2.id].sort(), '4/5. all live requirements, archived excluded');
  const call = fakeCalls()[0]; assert.ok(call.user.includes('ERP 구축') && call.user.includes('회계'), '6. definition in context'); assert.ok(call.user.includes('기존 착수회의'), '7. existing WBS in context'); assert.ok(call.user.includes('이미 확인된 정보'));
  // 10/11. known from definition: Azure → INFRASTRUCTURE, 기존 시스템 데이터 → DATA_MIGRATION ⇒ not asked again; INTERFACE unknown → asked
  const areasQ = plan.questions.map((x) => x.area);
  assert.ok(!areasQ.includes('INFRASTRUCTURE') && !areasQ.includes('DATA_MIGRATION'), '10/12. settled areas are not asked');
  assert.ok(areasQ.includes('INTERFACE'), '11. unknown area asked');
  assert.ok(plan.areas.find((a) => a.area === 'INFRASTRUCTURE').source === 'PROJECT_DEFINITION' && plan.areas.find((a) => a.area === 'DATA_MIGRATION').status === 'REQUIRED');
  assert.ok(!areasQ.includes('BOGUS_AREA'), '15. invalid area removed'); assert.ok(plan.questions.length <= 8, '13. max 8 questions'); assert.equal(new Set(areasQ).size, areasQ.length, 'no duplicate area question');
  assert.equal(r.json.run.credit_cost, 0, 'question generation is free'); assert.equal(await balance(A), 1000);
  // 3. selected requirements only
  setFakeProvider(() => ({ data: QUESTIONS() }));
  const sel = await A.c('POST', P(A), { requirement_ids: [r1.id, r3.id, 'nope'] });
  assert.deepEqual(sel.json.plan.requirement_ids, [r1.id], '3. selected only; archived/foreign dropped');
  // 14. invalid question schema → re-prompt once then 502; plan row removed
  let n = 0; setFakeProvider(() => ({ data: ++n === 1 ? { areas: 'bad', questions: [] } : { nope: true } }));
  r = await A.c('POST', P(A), { all: true }); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'AI_INVALID_OUTPUT');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM ai_wbs_plans WHERE status = ?', ['DRAFT'])).n), 0);
  // migration known from a requirement text too
  const known = knownAreasFrom({ requirementText: '기존 DB 데이터 마이그레이션 필요', definitionText: '' }); assert.equal(known[0].area, 'DATA_MIGRATION'); assert.equal(known[0].source, 'REQUIREMENT');
  server.close();
});

test('planner: answer save / validation, plan resume, workspace + project isolation, cancel', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'p2@x.com'); await mkReq(A, { title: 'R1' });
  setFakeProvider(() => ({ data: QUESTIONS([q('CUTOVER', '전환 작업?', [['a', 'A'], ['b', 'B']], { required: true })]) }));
  const plan = (await A.c('POST', P(A), { all: true })).json.plan;
  // 16. answers: wrong option id / missing required → 400; valid → stored; unknown question ignored
  let r = await A.c('PATCH', `${P(A)}/${plan.id}/answers`, { answers: { q_data_migration: { value: 'nope' } } }); assert.equal(r.status, 400); assert.ok(r.json.error.fields.q_data_migration && r.json.error.fields.q_cutover);
  r = await A.c('PATCH', `${P(A)}/${plan.id}/answers`, { answers: { q_data_migration: { value: 'yes', followups: ['db', 'zzz'] }, q_interface: { value: ['sso', 'bad'] }, q_training: { value: 'true' }, q_cutover: { value: 'a' }, ghost: { value: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.answers.q_data_migration, { value: 'yes', followups: ['db'], other: null }); assert.deepEqual(r.json.answers.q_interface.value, ['sso']); assert.equal(r.json.answers.q_training.value, true); assert.equal(r.json.answers.ghost, undefined);
  // 17. resume: GET list returns the active plan with answers after a "refresh"
  const list = (await A.c('GET', P(A))).json; assert.equal(list.active.id, plan.id); assert.equal(list.active.answers.q_cutover.value, 'a'); assert.equal(list.plans[0].question_count, 5);
  assert.equal((await A.c('GET', `${P(A)}/${plan.id}`)).json.plan.status, 'QUESTIONS_READY');
  // 18/19. isolation
  const B = await setup(client, 'p2b@x.com');
  assert.equal((await B.c('GET', `${P(B)}/${plan.id}`)).status, 404, 'other workspace cannot read');
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: '다른 프로젝트', client_name: '테스트 고객사', planned_start_date: '2026-11-01', planned_end_date: '2027-01-31' })).json.project;
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/projects/${p2.id}/ai/wbs-plans/${plan.id}`)).status, 404, 'other project cannot read');
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/projects/${p2.id}/ai/wbs-plans`)).json.active, null);
  // cancel
  r = await A.c('POST', `${P(A)}/${plan.id}/cancel`, {}); assert.equal(r.json.plan.status, 'CANCELLED'); assert.equal((await A.c('GET', P(A))).json.active, null);
  assert.equal((await A.c('PATCH', `${P(A)}/${plan.id}/answers`, { answers: {} })).status, 409);
  server.close();
});

test('planner: final draft — requirement-linked + delivery tasks, hallucinated ids stripped, no SUMMARY, milestone no children, depth, max 80, cycles, similarity, charged once, provider cost recorded', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'p3@x.com');
  await mkWbs(A, { item_type: 'TASK', title: '주간보고' });   // existing → similarity hit for the AI "주간보고"
  const { plan, reqs, run } = await toReview(A);
  assert.equal(plan.status, 'REVIEW'); assert.equal(run.feature, 'WBS_GENERATION'); assert.equal(run.credit_cost, 15); assert.equal(await balance(A), 985, '49. charged once (questions free)');
  const items = plan.draft.items; const by = Object.fromEntries(items.map((i) => [i.temp_id, i]));
  assert.deepEqual(by['AI-WBS-10'].related_requirement_ids, [reqs[0].display_id]); assert.deepEqual(by['AI-WBS-10'].requirement_ids, [reqs[0].id], '21. requirement-linked');
  assert.deepEqual(by['AI-WBS-30'].related_requirement_ids, [], '22. delivery task with no requirement'); assert.equal(by['AI-WBS-30'].project_area, 'INFRASTRUCTURE');
  assert.deepEqual(by['AI-WBS-31'].related_requirement_ids, [], '23. invalid REQ-999 stripped'); assert.ok(plan.draft.warnings.some((w) => w.includes('REQ-999')));
  assert.ok(items.every((i) => i.item_type !== 'SUMMARY'), '25. no SUMMARY'); assert.ok(items.every((i) => i.depth <= 5), '27. depth');
  assert.equal(by['AI-WBS-3'].similar_to.wbs_code, '1', '30. similar to existing 1'); assert.equal(by['AI-WBS-3'].selected, false, 'similar → deselected by default'); assert.equal(by['AI-WBS-2'].selected, true);
  const call = fakeCalls()[0]; assert.ok(call.system.includes('전체 수행 WBS')); assert.ok(call.user.includes('<untrusted_input>') && call.user.includes('사용자 답변') && call.user.includes('고객사 Cloud')); assert.ok(call.user.includes('DATA_MIGRATION') && call.user.includes('USER_ANSWER'));
  // prompt injection inside a requirement stays data
  // 24/26/28/29: fake external system / milestone children / >80 / cycle via pure normalizer
  const big = []; for (let i = 1; i <= 90; i++) big.push(it(`T${i}`, `작업 ${i}`, 'FUNCTIONAL_DEVELOPMENT', i > 1 && i < 10 ? `T${i - 1}` : null));
  big.push(it('M1', '오픈', 'STABILIZATION', null, [], { item_type: 'MILESTONE' })); big.push(it('C1', '마일스톤 자식', 'OTHER', 'M1'));
  big.push(it('X1', '순환 A', 'OTHER', 'X2')); big.push(it('X2', '순환 B', 'OTHER', 'X1')); big.push(it('H1', 'SAP 연계', 'INTERFACE', null, ['REQ-404'], { project_area: 'MADE_UP' }));
  const n = normalizeCandidates(big, { reqs: reqs.map((r) => ({ id: r.id, display_id: r.display_id })), existing: [] });
  assert.equal(n.items.length, 80, '28. max 80'); assert.ok(n.warnings.some((w) => w.includes('80개')));
  const nb = Object.fromEntries(n.items.map((i) => [i.temp_id, i]));
  assert.ok(nb.T9.depth <= 5 && nb.T6.depth === 5, '27. depth capped at the WBS rule (5)');
  const n2 = normalizeCandidates(big.slice(85), { reqs: reqs.map((r) => ({ id: r.id, display_id: r.display_id })), existing: [] }); const b2 = Object.fromEntries(n2.items.map((i) => [i.temp_id, i]));
  assert.equal(b2.C1.parent_temp_id, null, '26. milestone cannot have children'); assert.ok(b2.X1.parent_temp_id === null || b2.X2.parent_temp_id === null, '29. cycle corrected');
  assert.deepEqual(b2.H1.related_requirement_ids, [], '24. fake requirement id rejected'); assert.equal(b2.H1.project_area, 'OTHER', '15. invalid area → OTHER');
  // 50. provider cost / tokens recorded on the draft run
  const runs = await runsOf(db, A.w); const draftRun = runs.find((x) => x.feature === 'WBS_GENERATION'); const qRun = runs.find((x) => x.feature === 'WBS_PLAN_QUESTIONS');
  assert.equal(draftRun.status, 'SUCCEEDED'); assert.equal(draftRun.credit_status, 'CHARGED'); assert.equal(draftRun.input_tokens, 100); assert.equal(Number(draftRun.provider_cost_amount), 0); assert.ok(!draftRun.input_summary.includes('로그인'));
  assert.equal(qRun.credit_status, 'NONE'); assert.equal(qRun.credit_cost, 0); assert.equal(qRun.input_tokens, 100);
  assert.equal(plan.ai_run_id, draftRun.id); assert.equal(plan.question_run_id, qRun.id);
  server.close();
});

test('planner: coverage — requirement coverage + missing warning, delivery coverage (migration / infra / training), fix adds only missing areas, manual edits + parent/child validation', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'p4@x.com');
  const { plan, reqs } = await toReview(A);
  const cov = plan.coverage;
  assert.equal(cov.requirement_summary.total, 3); assert.equal(cov.requirement_summary.covered, 3); assert.equal(cov.requirement_summary.percent, 100, '31. requirement coverage');
  const d = Object.fromEntries(cov.delivery_coverage.map((x) => [x.area, x]));
  assert.equal(d.DATA_MIGRATION.status, 'COVERED'); assert.equal(d.DATA_MIGRATION.assessment, 'REQUIRED'); assert.equal(d.DATA_MIGRATION.source, 'USER_ANSWER', '34. migration coverage from answer');
  assert.equal(d.INFRASTRUCTURE.status, 'PARTIAL', '35. infra: 1 task → partial'); assert.equal(d.TRAINING.status, 'MISSING', '36. training answered yes but no task'); assert.equal(d.INTERFACE.status, 'PARTIAL');
  assert.ok(cov.warnings.some((w) => w.includes('교육이 필요하다고 답했지만')), '36. warning text'); assert.ok(cov.warnings.some((w) => w.includes('인프라') || w.includes('1건뿐')));
  // 39/40. manual edit: deselect AI-WBS-10 and reparent; deselect parent cascades? (child selects parent chain) ; rename; invalid link dropped
  let r = await A.c('POST', `${P(A)}/${plan.id}/coverage`, { items: [{ temp_id: 'AI-WBS-10', selected: false }, { temp_id: 'AI-WBS-11', title: '권한 관리 구현 (수정)', related_requirement_ids: [reqs[1].display_id, 'REQ-777'] }, { temp_id: 'AI-WBS-4', selected: false }, { temp_id: 'AI-WBS-41', parent_temp_id: 'AI-WBS-50' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const by = Object.fromEntries(r.json.plan.draft.items.map((i) => [i.temp_id, i]));
  assert.equal(by['AI-WBS-10'].selected, false); assert.equal(by['AI-WBS-11'].title, '권한 관리 구현 (수정)'); assert.deepEqual(by['AI-WBS-11'].related_requirement_ids, [reqs[1].display_id]);
  assert.equal(by['AI-WBS-4'].selected, true, '40. a selected child re-selects its parent'); assert.equal(by['AI-WBS-41'].parent_temp_id, null, '40. milestone parent rejected');
  assert.equal(r.json.plan.coverage.requirement_summary.covered, 2, '31. recomputed'); assert.ok(r.json.plan.coverage.warnings.some((w) => w.includes(`${reqs[0].display_id}에 연결된 실행 WBS가 없습니다`)), '32. missing requirement warning');
  assert.equal((await A.c('POST', `${P(A)}/${plan.id}/coverage`, { items: [{ temp_id: 'AI-WBS-11', title: '' }] })).status, 400);
  // 37/38. fix: only missing areas + uncovered requirement; existing draft untouched
  setFakeProvider((req) => { assert.ok(req.user.includes('TRAINING (교육)') && req.user.includes('missing_areas:')); assert.ok(req.user.includes(`uncovered_requirements: ${reqs[0].display_id}`)); assert.ok(req.user.includes('## 현재 초안'));
    return { data: { items: [it('AI-FIX-1', '교육', 'TRAINING'), it('AI-FIX-2', '사용자 교육', 'TRAINING', 'AI-FIX-1'), it('AI-FIX-3', '운영자 교육', 'TRAINING', 'AI-FIX-1'), it('AI-FIX-4', `${reqs[0].display_id} 구현`, 'FUNCTIONAL_DEVELOPMENT', 'AI-WBS-4', [reqs[0].display_id])], notes: ['보완'] } }; });
  const before = r.json.plan.draft.items.length;
  r = await A.c('POST', `${P(A)}/${plan.id}/fix`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.plan.draft.items.length, before + 4, '38. existing tree kept, candidates appended'); assert.deepEqual(r.json.added, ['AI-FIX-1', 'AI-FIX-2', 'AI-FIX-3', 'AI-FIX-4']);
  assert.equal(r.json.plan.draft.items.find((i) => i.temp_id === 'AI-FIX-4').parent_temp_id, 'AI-WBS-4', 'fix item can attach under an existing draft item');
  const d2 = Object.fromEntries(r.json.plan.coverage.delivery_coverage.map((x) => [x.area, x])); assert.equal(d2.TRAINING.status, 'COVERED', '37. fixed'); assert.equal(r.json.plan.coverage.requirement_summary.covered, 3);
  assert.equal(r.json.run.credit_cost, 0, 'fix is free'); assert.equal(await balance(A), 985);
  assert.equal((await A.c('POST', `${P(A)}/${plan.id}/fix`, { areas: ['UAT'] })).status, 409, 'nothing to fix for that area');
  // pure helpers
  const cc = computeCoverage({ areas: [{ area: 'DATA_MIGRATION', status: 'NOT_NEEDED', source: 'USER_ANSWER', reason: '' }], items: [], reqs: [] });
  assert.equal(cc.delivery_coverage.find((x) => x.area === 'DATA_MIGRATION').status, 'NOT_APPLICABLE'); assert.equal(cc.delivery_coverage.find((x) => x.area === 'UAT').status, 'UNKNOWN');
  assert.deepEqual(mergeEdits([it('A', 'a', 'OTHER'), it('B', 'b', 'OTHER', 'A')], [{ temp_id: 'B', parent_temp_id: 'B' }], []).find((x) => x.temp_id === 'B').parent_temp_id, null);
  server.close();
});

test('planner: commit — selected only, real codes from renumber, links created, delivery task unlinked, transaction, double commit blocked, archived project + suspended workspace blocked, history details', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'p5@x.com');
  await mkWbs(A, { item_type: 'TASK', title: '기존 작업' });
  const { plan, reqs } = await toReview(A);
  // 45. transaction: an invalid payload rolls back everything (the plan stays REVIEW, nothing created)
  const beforeCount = Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ?', [A.p.id])).n);
  await db.run(`ALTER TABLE wbs_items ADD CONSTRAINT t_no_atomic CHECK (title <> '통합 테스트')`);
  let r = await A.c('POST', `${P(A)}/${plan.id}/commit`, {});
  assert.ok(r.status >= 400, 'commit failed'); assert.equal(Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ?', [A.p.id])).n), beforeCount, '45. rolled back'); assert.equal((await A.c('GET', `${P(A)}/${plan.id}`)).json.plan.status, 'REVIEW', '45. plan not marked committed');
  await db.run('ALTER TABLE wbs_items DROP CONSTRAINT t_no_atomic');
  // 41. selected only: drop 데이터 이관 group (children follow) and the milestone
  r = await A.c('POST', `${P(A)}/${plan.id}/commit`, { items: [{ temp_id: 'AI-WBS-20', selected: false }, { temp_id: 'AI-WBS-21', selected: false }, { temp_id: 'AI-WBS-22', selected: false }, { temp_id: 'AI-WBS-50', selected: false }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.plan.status, 'COMMITTED'); assert.ok(r.json.plan.committed_at);
  const codes = r.json.created.map((c) => c.wbs_code);
  assert.ok(codes.includes('2') && codes.includes('2.1') && codes.includes('3.1'), '42. real codes continue after existing "1"'); assert.ok(!r.json.created.some((c) => c.title === '데이터 이관' || c.title === '오픈'), '41. deselected skipped');
  assert.equal(r.json.links, 3, '43. one link per requirement task'); assert.equal(r.json.plan.commit_result.delivery > 0, true, '44. delivery tasks exist without links');
  const tree = (await A.c('GET', A.wbs)).json.items;
  const infra = tree.find((i) => i.title === 'Azure 운영 환경 구성'); assert.equal(infra.linked_req_count, 0, '44. no forced link');
  const impl = tree.find((i) => i.title === `${reqs[0].display_id} 구현`); assert.equal(impl.linked_req_count, 1);
  const detail = (await A.c('GET', `${A.wbs}/${impl.id}`)).json.item; assert.ok(detail.history.some((h) => h.action_type === 'AI_GENERATED' && String(h.new_value).includes(plan.id)), '33. history carries plan id');
  assert.ok(!JSON.stringify(detail.history).includes('<project_data>'));
  // 46. double commit
  const createdN = r.json.created.length;
  r = await A.c('POST', `${P(A)}/${plan.id}/commit`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'plan_committed');
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE project_id = ?', [A.p.id])).n), beforeCount + createdN, '46. nothing created twice');
  // 47. archived project: draft readable, commit blocked
  const B = await setup(client, 'p5b@x.com'); const { plan: pb } = await toReview(B);
  await B.c('POST', `${B.purl}/archive`, {});
  assert.equal((await B.c('GET', `${P(B)}/${pb.id}`)).status, 200); r = await B.c('POST', `${P(B)}/${pb.id}/commit`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'archived');
  // 48. suspended workspace
  const C = await setup(client, 'p5c@x.com'); const { plan: pc } = await toReview(C);
  await db.run(`UPDATE workspaces SET status = 'SUSPENDED' WHERE id = ?`, [C.w]);
  assert.equal((await C.c('POST', `${P(C)}/${pc.id}/commit`, {})).status, 403);
  // member of A's workspace can read the plan; stranger cannot
  const M = await addMember(client, A, 'p5m@x.com', '멤버'); assert.equal((await M.c('GET', `${P(A)}/${plan.id}`)).status, 200);
  server.close();
});

test('openai adapter regression: structured output, refusal, invalid JSON, 401, 429 (transient), timeout, 500, secret never in errors', async () => {
  const realFetch = globalThis.fetch;
  const cfg = { provider: 'openai', apiKey: 'sk-SECRET-123', model: 'gpt-test', timeoutMs: 200, maxOutputTokens: 500 };
  const p = createProvider(cfg);
  const req = { system: 's', user: 'u', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }, schemaName: 'x' };
  const resp = (status, body) => ({ ok: status < 400, status, statusText: 'x', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  try {
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return resp(200, { choices: [{ message: { content: JSON.stringify({ a: 'ok' }) } }], usage: { prompt_tokens: 11, completion_tokens: 5 } }); };
    const out = await p.generateStructured(req);
    assert.deepEqual(out, { data: { a: 'ok' }, usage: { input_tokens: 11, output_tokens: 5 } });
    const body = JSON.parse(seen.init.body); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.model, 'gpt-test'); assert.equal(body.max_completion_tokens, 500); assert.equal(seen.init.headers.authorization, 'Bearer sk-SECRET-123');
    globalThis.fetch = async () => resp(200, { choices: [{ message: { refusal: 'no' } }] });
    await assert.rejects(() => p.generateStructured(req), (e) => e instanceof AiProviderError && e.code === 'AI_INVALID_OUTPUT');
    globalThis.fetch = async () => resp(200, { choices: [{ message: { content: '{not json' } }] });
    await assert.rejects(() => p.generateStructured(req), (e) => e.code === 'AI_INVALID_OUTPUT');
    globalThis.fetch = async () => resp(401, { error: { message: 'Incorrect API key provided: sk-SECRET-123' } });
    await assert.rejects(() => p.generateStructured(req), (e) => e.code === 'AI_PROVIDER_ERROR' && e.status === 401 && e.transient === false);
    globalThis.fetch = async () => resp(429, { error: { message: 'rate' } });
    await assert.rejects(() => p.generateStructured(req), (e) => e.code === 'AI_PROVIDER_ERROR' && e.status === 429 && e.transient === true);
    globalThis.fetch = async () => resp(500, 'boom');
    await assert.rejects(() => p.generateStructured(req), (e) => e.code === 'AI_PROVIDER_ERROR' && e.status === 500 && e.transient === true);
    globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    await assert.rejects(() => p.generateStructured(req), (e) => e.code === 'AI_TIMEOUT' && e.transient === false);
    // secret never appears in a provider error produced by the adapter itself (status/short message only)
    globalThis.fetch = async () => resp(503, { error: { message: 'unavailable' } });
    await assert.rejects(() => p.generateStructured(req), (e) => !e.message.includes('SECRET') && !JSON.stringify(e).includes('SECRET'));
  } finally { globalThis.fetch = realFetch; }
});
