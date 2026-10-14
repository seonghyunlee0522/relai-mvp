/* Phase 6 (06 전환 및 오픈): 검수 승인 = 고객 승인 기록 (US-1), 검수는 범위 전체를 덮는다 (US-2), 오픈 = 남은 항목 처리 / 운영 이관 (US-3),
 * 이관 있음 → DATA_MIGRATION 필수 (US-4), 06 주간보고 (US-5), 체크리스트 담당 선택기 (US-6), 06 경고 줄 열린 이슈 (US-7), migration 37.
 * Spec: hive research/relai-phase-6-spec.md (v2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { PHASE_BY_KEY } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import { projectGuidance } from '../guidance.js';
import { effectiveImportance, activityStates } from '../activities.js';
import { todayKst, addDays } from '../../public/app/shared/kst-date.js';

const T = todayKst();
const STAKE = [
  { id: 'sh-pm', name: '정하늘', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-cl', name: '오지현', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
];
const APV = { approver_id: 'sh-cl', date: addDays(T, -1), method: 'SIGNED', evidence: '검수확인서 서명본 수령' };
const step = (g, key) => g.phases.find((x) => x.phase_key === 'TRANSITION_GO_LIVE').steps.find((s) => s.step_key === key);
const g = async (A) => (await A.c('GET', A.purl)).json;
const toPhase = async (A, target) => {
  const order = ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];
  for (const key of order.slice(0, order.indexOf(target) + 1)) {
    const G = await g(A); if (G.project.current_phase === key) continue;
    assert.equal((await A.c('POST', `${A.purl}/phases/${G.phases.find((x) => x.phase_key === key).id}/activate`, { reason: 'NEXT' })).status, 200, key);
  }
};
const reqs = async (A, n, { draft = [], type = null } = {}) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = (await A.c('POST', A.req, { title: `요구사항 ${i + 1}`, scope: 'IN_SCOPE', ...(type ? { type } : {}) })).json.requirement;
    if (!draft.includes(i)) assert.equal((await A.c('PATCH', `${A.req}/${r.id}`, { status: 'CONFIRMED' })).status, 200);
    out.push(r);
  }
  return out;
};
const acc = (A, s = '') => `${A.purl}/acceptances${s}`;
const mkTest = async (A, r, result = 'PASS') => {
  const t = (await A.c('POST', `${A.purl}/tests`, { title: `${r.title} 테스트` })).json.test;
  await A.c('POST', `${A.purl}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: r.id });
  if (result) await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result });
  return t;
};
const stakeholders = (A) => A.c('PUT', `${A.purl}/definition`, { stakeholders: STAKE });

/* ---------- US-1 ---------- */
test('US-1 검수 승인: 4 fields or 422; saved record + ACCEPTED in one go; view · history · card; 승인 기록 추가 keeps the status; rework/reject unchanged', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await stakeholders(A);
  const R = await reqs(A, 2); await mkTest(A, R[0]); const tf = await mkTest(A, R[1], 'FAIL');
  await A.c('PATCH', `${A.req}/${R[1].id}/test-exclusion`, { reason: '문서로 대체' });
  await A.c('POST', `${A.purl}/issues`, { title: '열린 이슈', severity: 'LOW' });
  const a = (await A.c('POST', acc(A), { title: '1차 검수', requirements: [R[0].id, R[1].id] })).json.acceptance;
  await A.c('POST', acc(A, `/${a.id}/links`), { target_type: 'TEST', target_id: tf.id });
  await A.c('POST', acc(A, `/${a.id}/transition`), { action: 'submit' });
  let r = await A.c('POST', acc(A, `/${a.id}/transition`), { action: 'accept' });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'customer_approval_required');
  r = await A.c('POST', acc(A, `/${a.id}/transition`), { action: 'accept', customer_approval: { ...APV, evidence: '' } });
  assert.equal(r.status, 422); assert.ok(r.json.error.fields['approval.evidence']);
  r = await A.c('POST', acc(A, `/${a.id}/transition`), { action: 'accept', customer_approval: { ...APV, date: addDays(T, 1) } });
  assert.equal(r.status, 400, 'future 승인일');
  assert.equal((await A.c('GET', acc(A, `/${a.id}`))).json.acceptance.status, 'REQUESTED', 'nothing saved on refusal');
  // card before approval
  let x = (await A.c('GET', acc(A, `/${a.id}`))).json.acceptance;
  assert.deepEqual(x.scope_card, { requirements: 2, tests_pass: 0, excluded: 1, open_issues: 1 }, 'only the linked FAIL test → 통과 0; 열린 이슈 = project-wide');
  r = await A.c('POST', acc(A, `/${a.id}/transition`), { action: 'accept', customer_approval: APV });
  assert.equal(r.status, 200);
  x = r.json.acceptance;
  assert.equal(x.status, 'ACCEPTED'); assert.ok(x.accepted_at);
  assert.equal(x.customer_approval.recorded, true); assert.equal(x.customer_approval.approver.name, '오지현'); assert.equal(x.customer_approval.method_label, '서명본 수령');
  assert.equal(x.customer_approval.recorded_by_name, '홍길동');
  assert.ok(x.history.some((h) => h.action_type === 'CUSTOMER_APPROVAL' && /오지현/.test(h.new_value)));
  const list = (await A.c('GET', acc(A))).json.items;
  assert.equal(list[0].customer_approval.recorded, true);
  // 승인 기록 추가: only on ACCEPTED; status unchanged; a directly entered approver joins 이해관계자
  const old = (await A.c('POST', acc(A), { title: '예전 검수' })).json.acceptance;
  assert.equal((await A.c('PATCH', acc(A, `/${old.id}/customer-approval`), { customer_approval: APV })).status, 409, 'DRAFT → use 승인');
  await A.c('POST', acc(A, `/${old.id}/transition`), { action: 'submit' });
  assert.equal((await A.c('PATCH', acc(A, `/${old.id}/customer-approval`), { customer_approval: APV })).status, 409, 'REQUESTED → use 승인');
  const third = (await A.c('POST', acc(A), { title: '반려 흐름' })).json.acceptance;
  await A.c('POST', acc(A, `/${third.id}/transition`), { action: 'submit' });
  assert.equal((await A.c('POST', acc(A, `/${third.id}/transition`), { action: 'rework' })).status, 400, '보완 사유 필수 (unchanged)');
  assert.equal((await A.c('POST', acc(A, `/${third.id}/transition`), { action: 'rework', decision_note: '화면 보완' })).json.acceptance.status, 'REWORK_REQUIRED');
  server.close();
});

test('US-1 legacy ACCEPTED without a record: grey line data + 승인 기록 추가 (direct approver → 이해관계자)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await stakeholders(A);
  const a = (await A.c('POST', acc(A), { title: '예전 검수' })).json.acceptance;
  await db.run(`UPDATE acceptances SET status = 'ACCEPTED', accepted_at = now() WHERE id = ?`, [a.id]);
  let x = (await A.c('GET', acc(A, `/${a.id}`))).json.acceptance;
  assert.equal(x.customer_approval.recorded, false);
  const r = await A.c('PATCH', acc(A, `/${a.id}/customer-approval`), { customer_approval: { approver_name: '최현업', approver_title: '과장', date: T, method: 'EMAIL', evidence: '회신 메일', add_to_stakeholders: true } });
  assert.equal(r.status, 200); x = r.json.acceptance;
  assert.equal(x.status, 'ACCEPTED'); assert.equal(x.customer_approval.recorded, true); assert.equal(x.customer_approval.approver.name, '최현업');
  assert.ok(x.stakeholders.some((s) => s.name === '최현업' && s.org_type === 'CLIENT'));
  server.close();
});

/* ---------- US-2 ---------- */
test('US-2 검수는 범위 전체: 1/3 → 진행 중; scope_all links the rest (not the already accepted, not unconfirmed/archived) + their tests; 1차 + 2차 → 완료', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await stakeholders(A);
  const R = await reqs(A, 4, { draft: [3] });   // R[3] 미확정 → not a target
  const t0 = await mkTest(A, R[0]); const t1 = await mkTest(A, R[1]); const t2 = await mkTest(A, R[2]);
  await toPhase(A, 'TRANSITION_GO_LIVE');
  const a1 = (await A.c('POST', acc(A), { title: '1차', requirements: [R[0].id] })).json.acceptance;
  await A.c('POST', acc(A, `/${a1.id}/transition`), { action: 'submit' });
  await A.c('POST', acc(A, `/${a1.id}/transition`), { action: 'accept', customer_approval: APV });
  let G = await g(A);
  assert.equal(step(G, 'ACCEPTANCE').state, 'IN_PROGRESS');
  assert.match(step(G, 'ACCEPTANCE').text, /범위 내 요구사항 3건 중 1건이 승인된 검수에 들어 있습니다/);
  assert.equal(step(G, 'ACCEPTANCE').cta.label, '검수 범위 보기');
  assert.equal(G.guidance.rule, 'ACC_SCOPE');
  const st = (await A.c('GET', acc(A))).json.acceptances;
  assert.equal(st.scope_target, 3); assert.equal(st.scope_accepted, 1); assert.equal(st.scope_remaining, 2); assert.equal(st.scope_remaining_tests, 2);
  const a2 = (await A.c('POST', acc(A), { title: '2차', scope_all: true })).json.acceptance;
  assert.deepEqual(a2.requirements.map((r) => r.id).sort(), [R[1].id, R[2].id].sort(), 'already accepted R[0] and unconfirmed R[3] left out');
  assert.deepEqual(a2.tests.map((t) => t.id).sort(), [t1.id, t2.id].sort()); assert.ok(!a2.tests.some((t) => t.id === t0.id));
  const a3 = (await A.c('POST', acc(A), { title: '수동', scope_all: false })).json.acceptance;
  assert.equal(a3.requirements.length, 0, 'checkbox off → link later');
  await A.c('POST', acc(A, `/${a2.id}/transition`), { action: 'submit' });
  G = await g(A); assert.equal(step(G, 'ACCEPTANCE').state, 'IN_PROGRESS', 'requested is not accepted');
  await A.c('POST', acc(A, `/${a2.id}/transition`), { action: 'accept', customer_approval: APV });
  G = await g(A);
  assert.equal(step(G, 'ACCEPTANCE').state, 'COMPLETED', '1차 + 2차 add up');
  assert.equal((await A.c('GET', acc(A))).json.acceptances.scope_remaining, 0);
  server.close();
});

test('US-2 no in-scope confirmed requirement → no scope target (old rule: every 검수 approved); pure rule', () => {
  const steps = PHASE_BY_KEY.TRANSITION_GO_LIVE.steps.map((s, i) => ({ id: `s${i}`, step_key: s.key, title: s.title, importance: s.importance, status: 'TODO', note: '' }));
  const st = (a) => activityStates('TRANSITION_GO_LIVE', steps, { pid: 'p', stats: { acceptances: a } }).find((x) => x.step_key === 'ACCEPTANCE');
  assert.equal(st({ total: 1, accepted: 1, scope_target: 0 }).state, 'COMPLETED');
  assert.equal(st({ total: 1, accepted: 1, scope_target: 15, scope_accepted: 1 }).state, 'IN_PROGRESS');
  assert.equal(st({ total: 2, accepted: 2, scope_target: 15, scope_accepted: 15 }).state, 'COMPLETED');
  assert.match(st({ total: 2, accepted: 1, requested: 1, scope_target: 15, scope_accepted: 1 }).text, /검수 요청 1건이 고객 확인을 기다립니다\. 범위 내 요구사항 15건 중 1건이 승인된 검수에 들어 있습니다\./);
});

/* ---------- US-3 ---------- */
test('US-3 오픈: server recomputes open items (422 undecided_items), future date 422, record + GO_LIVE 완료 + 오픈 milestone 실적일, 409 twice / by PATCH', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await stakeholders(A);
  const [r0] = await reqs(A, 1); const tf = await mkTest(A, r0, 'FAIL');
  await A.c('POST', `${A.wbs}`, { item_type: 'MILESTONE', title: '오픈', milestone_date: addDays(T, 10) });
  await A.c('POST', `${A.wbs}`, { item_type: 'MILESTONE', title: '중간보고', milestone_date: addDays(T, 20) });
  await toPhase(A, 'TRANSITION_GO_LIVE');
  const iss = (await A.c('POST', `${A.purl}/issues`, { title: '정렬 오류', severity: 'MEDIUM' })).json;
  const issue = iss.issue || iss.item || iss;
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: '문구 변경' })).json.change;
  await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'submit' });
  await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'approve', customer_approval: APV });
  const ac = (await A.c('POST', acc(A), { title: '검수', requirements: [r0.id] })).json.acceptance;
  await A.c('POST', acc(A, `/${ac.id}/transition`), { action: 'submit' });
  const G0 = await g(A);
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(G0, 'GO_LIVE').id}`, { status: 'COMPLETED' })).status, 409);
  const open = (await A.c('GET', `${A.purl}/go-live`)).json;
  assert.deepEqual(open.open_items.map((x) => x.type), ['ISSUE', 'TEST', 'CR', 'ACCEPTANCE']);
  assert.equal(open.go_live, null); assert.equal(open.today, T);
  const all = open.open_items.map((x) => ({ type: x.type, id: x.id, note: `${x.display_id} 운영팀 1차 대응` }));
  let r = await A.c('POST', `${A.purl}/go-live`, { date: T, carryovers: all.slice(1) });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'undecided_items'); assert.match(r.json.error.fields.items, /ISS-001/);
  r = await A.c('POST', `${A.purl}/go-live`, { date: T, carryovers: all.map((c, i) => (i === 2 ? { ...c, note: '  ' } : c)) });
  assert.equal(r.status, 422, 'an empty memo is not a decision');
  r = await A.c('POST', `${A.purl}/go-live`, { date: addDays(T, 1), carryovers: all });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'invalid_go_live_date');
  assert.equal((await A.c('POST', `${A.purl}/go-live`, { carryovers: all })).status, 422, '오픈일 required');
  const day = addDays(T, -3);
  r = await A.c('POST', `${A.purl}/go-live`, { date: day, carryovers: [...all, { type: 'ISSUE', id: 'not-open', note: 'x' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.go_live.date, day); assert.equal(r.json.go_live.carryovers.length, 4, 'unknown ids ignored');
  assert.deepEqual(r.json.go_live.carryovers.map((c) => c.display_id), [issue.display_id, tf.display_id, cr.display_id, ac.display_id]);
  assert.equal(step(r.json, 'GO_LIVE').state, 'COMPLETED');
  assert.match(step(r.json, 'GO_LIVE').text, /운영 이관 4건/);
  assert.equal(r.json.milestone.title, '오픈');
  const ms = (await A.c('GET', A.wbs)).json.items.find((x) => x.title === '오픈');
  assert.equal(ms.status, 'COMPLETED'); assert.equal(String(ms.actual_end_date).slice(0, 10), day);
  assert.notEqual((await A.c('GET', A.wbs)).json.items.find((x) => x.title === '중간보고').status, 'COMPLETED');
  assert.equal((await A.c('POST', `${A.purl}/go-live`, { date: day, carryovers: all })).status, 409, 'already_live');
  const G = await g(A);
  assert.equal(G.go_live.carryovers.length, 4, 'project payload carries the record for the grey tags');
  assert.notEqual(G.guidance.rule, 'GO_LIVE_OPEN'); assert.ok(!G.guidance.warnings.some((w) => /열린 이슈/.test(w)), 'recorded → no warning');
  // → 07: first line = N건; carried issue/CR are not a fresh warning
  await toPhase(A, 'OPERATIONS');
  const O = await g(A);
  assert.equal(O.guidance.warnings[0], '운영 이관 4건 · 담당 지정 0/4');   // Phase 7 US-4 replaces the Phase 6 line
  assert.equal(O.guidance.warning_links['운영 이관 4건 · 담당 지정 0/4'], `/app/projects/${A.p.id}?handover=1`);
  assert.notEqual(O.guidance.rule, 'OPS_ISSUES');
  assert.ok(!O.guidance.warnings.some((w) => /미반영 변경/.test(w)));
  await A.c('POST', `${A.purl}/issues`, { title: '오픈 뒤 새 이슈', severity: 'LOW' });
  assert.equal((await g(A)).guidance.rule, 'OPS_ISSUES', 'a new issue after 오픈 still shows');
  server.close();
});

test('US-3 nothing open → date only; GO_LIVE checklist all done is not 오픈 (needs the record); no milestone is fine', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  await toPhase(A, 'TRANSITION_GO_LIVE');
  let G = await g(A);
  const items = (await A.c('POST', `${A.purl}/steps/${step(G, 'GO_LIVE').id}/checklist/defaults`, {})).json.items;
  for (const it of items) await A.c('PATCH', `${A.purl}/checklist/${it.id}`, { done: true });
  G = await g(A);
  assert.equal(step(G, 'GO_LIVE').state, 'IN_PROGRESS'); assert.match(step(G, 'GO_LIVE').text, /오픈 완료 처리가 남았습니다/);
  const o = (await A.c('GET', `${A.purl}/go-live`)).json;
  assert.equal(o.open_items.length, 0);
  const r = await A.c('POST', `${A.purl}/go-live`, { date: T });
  assert.equal(r.status, 200); assert.equal(r.json.milestone, null); assert.equal(step(r.json, 'GO_LIVE').state, 'COMPLETED');
  server.close();
});

/* ---------- US-4 ---------- */
test('US-4 DATA_MIGRATION importance from the trait (YES 필수 · TBD 권장 · NO 선택), gate + 건너뛰기 follow, DATA links', async () => {
  assert.equal(effectiveImportance('TRANSITION_GO_LIVE', 'DATA_MIGRATION', 'OPTIONAL', { data_migration: 'YES' }), 'REQUIRED');
  assert.equal(effectiveImportance('TRANSITION_GO_LIVE', 'DATA_MIGRATION', 'OPTIONAL', { data_migration: 'TBD' }), 'RECOMMENDED');
  assert.equal(effectiveImportance('TRANSITION_GO_LIVE', 'DATA_MIGRATION', 'OPTIONAL', { data_migration: 'NO' }), 'OPTIONAL');
  assert.equal(effectiveImportance('TRANSITION_GO_LIVE', 'TRAINING', 'RECOMMENDED', { data_migration: 'YES' }), 'RECOMMENDED');
  const { server, client, db } = await boot();
  const A = await setup(client);
  await db.run(`UPDATE projects SET data_migration = 'YES' WHERE id = ?`, [A.p.id]);
  const [d0] = await reqs(A, 1, { type: 'DATA' });
  await toPhase(A, 'TRANSITION_GO_LIVE');
  let G = await g(A); let dm = step(G, 'DATA_MIGRATION');
  assert.equal(dm.importance, 'REQUIRED'); assert.equal(dm.importance_label, '필수');
  assert.deepEqual(dm.links, [{ label: `${d0.display_id} 요구사항 1`, href: `/app/projects/${A.p.id}/requirements?sel=${d0.id}` }]);
  const reqOpen = G.current_phase.summary.required_open;
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${dm.id}`, { status: 'SKIPPED' })).status, 409);
  await db.run(`UPDATE projects SET data_migration = 'NO' WHERE id = ?`, [A.p.id]);
  G = await g(A); dm = step(G, 'DATA_MIGRATION');
  assert.equal(dm.importance, 'OPTIONAL'); assert.equal(dm.links, null); assert.equal(G.current_phase.summary.required_open, reqOpen - 1);
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${dm.id}`, { status: 'SKIPPED' })).status, 200);
  server.close();
});

/* ---------- US-5 · US-7 ---------- */
test('US-5 06 WEEKLY_REPORT (권장) right before GO_LIVE · US-7 06 warn line = 열린 이슈 · 미반영 변경 (never blocks)', () => {
  const keys = PHASE_BY_KEY.TRANSITION_GO_LIVE.steps.map((s) => s.key);
  assert.deepEqual(keys, ['ACCEPTANCE', 'CUTOVER_PLAN', 'DATA_MIGRATION', 'TRAINING', 'WEEKLY_REPORT', 'GO_LIVE', 'STABILIZE']);
  assert.equal(PHASE_BY_KEY.TRANSITION_GO_LIVE.steps[4].importance, 'RECOMMENDED');
  const steps = PHASE_BY_KEY.TRANSITION_GO_LIVE.steps.map((s, i) => ({ id: `s${i}`, step_key: s.key, title: s.title, importance: s.importance, status: 'TODO', note: '' }));
  const wr = activityStates('TRANSITION_GO_LIVE', steps, { pid: 'p', stats: {}, weekly_report: { state: 'FINAL', finalized_at: new Date().toISOString() } }).find((x) => x.step_key === 'WEEKLY_REPORT');
  assert.equal(wr.state, 'COMPLETED');
  const base = { project: { id: 'p', workspace_id: 'w', current_phase: 'TRANSITION_GO_LIVE' }, next_phase: null, definition: {}, overdue_tasks: 0 };
  const r = projectGuidance({ ...base, phase: { phase_key: 'TRANSITION_GO_LIVE', steps: [] }, stats: { acceptances: { total: 0 }, issues: { active: 1 }, changes: { approved_unimplemented: 1 } } });
  assert.equal(r.rule, 'ACC_EMPTY'); assert.ok(r.warnings.includes('열린 이슈 1건 · 승인 후 미반영 변경 1건'));
  const r2 = projectGuidance({ ...base, phase: { phase_key: 'TRANSITION_GO_LIVE', steps: [] }, stats: { acceptances: { total: 0 }, issues: { active: 2 } } });
  assert.ok(r2.warnings.includes('열린 이슈 2건'));
  const r3 = projectGuidance({ ...base, phase: { phase_key: 'TRANSITION_GO_LIVE', steps: [] }, stats: { acceptances: { total: 2, accepted: 2 }, tests: { last_fail: 1 } } });
  assert.equal(r3.rule, 'GO_LIVE_OPEN'); assert.equal(r3.primary_action.label, '실패 테스트 조치 →'); assert.equal(r3.secondary_action.href, '/app/projects/p?golive=1');
  for (const x of [r, r2, r3]) assert.ok(!/Go-Live|Fail|Issue/.test(JSON.stringify(x)), 'no English UI words in 06 guidance');
});

/* ---------- US-6 ---------- */
test('US-6 체크리스트 담당: RELAI 사용자 · 팀원 · 고객사 · 직접 입력 (one of three); old free text kept; bad ids refused', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await stakeholders(A);
  await toPhase(A, 'TRANSITION_GO_LIVE');
  const G = await g(A); const url = `${A.purl}/steps/${step(G, 'CUTOVER_PLAN').id}/checklist`;
  const free = (await A.c('POST', url, { title: '전환 리허설', owner: '운영팀 김대리' })).json.item;
  assert.equal(free.owner_kind, 'text'); assert.equal(free.owner_display, '운영팀 김대리');
  const cl = (await A.c('POST', url, { title: '고객 확인', owner_ref: 's:sh-cl' })).json.item;
  assert.equal(cl.owner_kind, 'stakeholder'); assert.equal(cl.owner_display, '오지현'); assert.equal(cl.owner_org, '고객사'); assert.equal(cl.owner, '');
  let it = (await A.c('PATCH', `${A.purl}/checklist/${cl.id}`, { owner_ref: `u:${A.uid}` })).json.item;
  assert.equal(it.owner_kind, 'user'); assert.equal(it.owner_display, '홍길동'); assert.equal(it.owner_stakeholder_id, null);
  it = (await A.c('PATCH', `${A.purl}/checklist/${cl.id}`, { owner: '고객사 운영팀' })).json.item;
  assert.equal(it.owner_kind, 'text'); assert.equal(it.owner_user_id, null);
  it = (await A.c('PATCH', `${A.purl}/checklist/${cl.id}`, { owner_ref: '' })).json.item;
  assert.equal(it.owner_kind, 'none');
  assert.equal((await A.c('PATCH', `${A.purl}/checklist/${cl.id}`, { owner_ref: 's:nobody' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.purl}/checklist/${cl.id}`, { owner_ref: 'u:nobody' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.purl}/checklist/${cl.id}`, { owner_ref: 'x' })).status, 400);
  const list = (await A.c('GET', `${A.purl}/checklists`)).json;
  assert.equal(list.items.find((x) => x.id === free.id).owner_display, '운영팀 김대리', 'untouched free text');
  assert.deepEqual(list.owners.clients.map((c) => c.name), ['오지현']);
  server.close();
});

/* ---------- migration 37 ---------- */
test('migration 37: ACCEPTANCE texts, WEEKLY_REPORT inserted once right before GO_LIVE; a project past 06 is never blocked (◐ when the new gate is unmet)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const [r0] = await reqs(A, 2);
  await toPhase(A, 'TRANSITION_GO_LIVE');
  // legacy: one accepted 검수 over 1 of 2 requirements, old texts, no 06 WEEKLY_REPORT; then moved on to 07
  await db.run(`UPDATE project_steps SET completion_criteria = '검수 항목이 모두 승인되었습니다.' WHERE step_key = 'ACCEPTANCE'`);
  await db.run(`DELETE FROM project_steps WHERE step_key = 'WEEKLY_REPORT' AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TRANSITION_GO_LIVE')`);
  const a = (await A.c('POST', acc(A), { title: '예전 검수', requirements: [r0.id] })).json.acceptance;
  await db.run(`UPDATE acceptances SET status = 'ACCEPTED', accepted_at = now() WHERE id = ?`, [a.id]);
  await toPhase(A, 'OPERATIONS');
  const m37 = migrations.find((m) => m.version === 37); assert.ok(m37); assert.ok(migrations[migrations.length - 1].version >= 37);
  await m37.up(db); await m37.up(db);
  const steps = await db.all(`SELECT s.step_key, s.importance, s.status, s.completion_criteria FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    WHERE p.project_id = ? AND p.phase_key = 'TRANSITION_GO_LIVE' ORDER BY s.sequence`, [A.p.id]);
  assert.deepEqual(steps.map((s) => s.step_key), ['ACCEPTANCE', 'CUTOVER_PLAN', 'DATA_MIGRATION', 'TRAINING', 'WEEKLY_REPORT', 'GO_LIVE', 'STABILIZE']);
  assert.equal(steps[0].completion_criteria, '범위 내 확정 요구사항이 모두 승인된 검수에 들어 있습니다.');
  assert.equal(steps[4].importance, 'RECOMMENDED'); assert.equal(steps[4].status, 'TODO');
  const G = await g(A);
  assert.equal(G.project.current_phase, 'OPERATIONS');
  assert.equal(G.phases.find((x) => x.phase_key === 'TRANSITION_GO_LIVE').display_state, 'gap');
  server.close();
});

/* ---------- 01 · 02 · 04 regression (shared approval code) ---------- */
test('regression: 04 CR approval still 422 / saves; 01 approval record still saves', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await stakeholders(A);
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: 'CR' })).json.change;
  await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'submit' });
  assert.equal((await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'approve' })).status, 422);
  const r = await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'approve', customer_approval: APV });
  assert.equal(r.json.change.status, 'APPROVED'); assert.equal(r.json.change.customer_approval.recorded, true);
  assert.equal((await A.c('PUT', `${A.purl}/definition`, { approval: APV })).status, 200);
  server.close();
});
