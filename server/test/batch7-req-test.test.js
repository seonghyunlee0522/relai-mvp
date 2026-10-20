/* batch7 T4: #11 요구사항 담당자 = 01 관계자 (조직·부서 → 사람) · #13 연결 현황 매트릭스 · #20 인라인 실행 기록 (단계별 결과 + 이슈 등록) ·
 * migration 51 columns (test_data, environment). The AI 시나리오 (#18) is covered by ai-testgen.test.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { buildReqDocMarkdown } from '../req-export.js';

const SH = [
  { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '수행사', department: 'PMO', role: 'PM' },
  { id: 'sh-han', name: '한도윤', org_type: 'CLIENT', org: '다온생명', department: '고객경험본부', role: '과장' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', department: '개발팀', role: '개발' },
];

test('#11 requirement owner: a 01 관계자 (고객사 included) via owner=s:<id>; label "이름 · 조직"; filter; history text; bulk; export; bad ids refused', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'own@x.com');
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: SH });
  const r1 = (await A.c('POST', A.req, { title: '보험금 청구 조회', owner: 's:sh-han' })).json.requirement;
  assert.equal(r1.owner_stakeholder_id, 'sh-han'); assert.equal(r1.owner_user_id, null);
  assert.equal(r1.owner_label, '한도윤 · 다온생명'); assert.equal(r1.owner_no_account, true);
  const list = (await A.c('GET', A.req)).json;
  assert.equal(list.requirements[0].owner_label, '한도윤 · 다온생명');
  assert.deepEqual(list.owners.directory.map((x) => [x.name, x.org, x.department]), [['김피엠', '수행사', 'PMO'], ['한도윤', '다온생명', '고객경험본부'], ['박협력', '협력사', '개발팀']]);
  assert.deepEqual(list.owners.team.map((x) => x.name), ['김피엠', '박협력'], 'WBS / 이슈 keep the Phase 3 team (당사·협력사)');
  // filter by 관계자, by 미지정
  const r2 = (await A.c('POST', A.req, { title: '두 번째' })).json.requirement;
  assert.deepEqual((await A.c('GET', `${A.req}?owner=s:sh-han`)).json.requirements.map((x) => x.id), [r1.id]);
  assert.deepEqual((await A.c('GET', `${A.req}?owner=none`)).json.requirements.map((x) => x.id), [r2.id]);
  // user ↔ 관계자 is exclusive; history is one '담당자' row with display text
  let u = await A.c('PATCH', `${A.req}/${r1.id}`, { owner: `u:${A.uid}` });
  assert.equal(u.status, 200); assert.equal(u.json.requirement.owner_user_id, A.uid); assert.equal(u.json.requirement.owner_stakeholder_id, null);
  const h = u.json.requirement.history.find((x) => x.field_name === 'owner');
  assert.equal(h.old_value, '한도윤 · 다온생명'); assert.equal(h.new_value, '홍길동');
  u = await A.c('PATCH', `${A.req}/${r1.id}`, { owner_user_id: null });   // old clients: owner_user_id '' / null = 미지정
  assert.equal(u.json.requirement.owner_label, ''); assert.equal(u.json.requirement.owner_stakeholder_id, null);
  assert.equal((await A.c('PATCH', `${A.req}/${r1.id}`, { owner: 's:nope' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.req}/${r1.id}`, { owner_user_id: A.uid, owner_stakeholder_id: 'sh-han' })).status, 400, 'one of the two');
  assert.equal((await A.c('POST', A.req, { title: 'x', owner: 'zz' })).status, 400);
  // bulk: owner value from the same picker
  const b = await A.c('POST', `${A.req}/bulk`, { action: 'update', ids: [r1.id, r2.id], patch: { owner: 's:sh-han' } });
  assert.equal(b.status, 200); assert.equal(b.json.updated, 2);
  const nb = await A.c('POST', `${A.req}/bulk`, { action: 'update', ids: [r1.id], patch: { owner: 's:ghost' } });
  assert.equal(nb.json.updated, 0); assert.match(nb.json.skipped[0].reason, /관계자/);
  // 요구사항 정의서: 담당자 column
  await A.c('PATCH', `${A.req}/${r1.id}`, { scope: 'IN_SCOPE' });
  const rows = (await A.c('GET', A.req)).json.requirements.map((r) => ({ ...r, criteria: [] }));
  const doc = buildReqDocMarkdown({ profile: { name: 'P', client: 'C' }, goals: '', successCriteria: '', scope: { inScope: '', outOfScope: '' }, stakeholders: [] }, rows, { status: 'TODO', approval: { date: '' }, approver: null, bypass: null }, { today: '2026-10-20' });
  assert.match(doc.markdown, /\| ID \| 제목 \| 유형 \| 우선순위 \| 담당자 \| 완료 조건 \|/); assert.match(doc.markdown, /한도윤 · 다온생명/);
  // a deleted 관계자 shows as (삭제된 담당자)
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: SH.filter((x) => x.id !== 'sh-han') });
  assert.equal((await A.c('GET', `${A.req}/${r1.id}`)).json.requirement.owner_label, '(삭제된 담당자)');
  assert.ok(await db.get('SELECT 1 FROM requirements WHERE id = ? AND owner_stakeholder_id = ?', [r1.id, 'sh-han']));
  server.close();
});

test('#11 WBS / 이슈 keep the Phase 3 rule: 고객사 관계자 is not assignable there', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'wbs@x.com');
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: SH });
  assert.equal((await A.c('POST', `${A.purl}/issues`, { title: 'x', owner_stakeholder_id: 'sh-han' })).status, 400);
  assert.equal((await A.c('POST', `${A.purl}/issues`, { title: 'y', owner_stakeholder_id: 'sh-dev' })).status, 201);
  server.close();
});

test('#13 연결 현황: ?trace=1 → per requirement WBS · tests · latest result, coverage over in-scope (REJECTED excluded)', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'trace@x.com');
  const mk = async (title, extra = {}) => (await A.c('POST', A.req, { title, scope: 'IN_SCOPE', status: 'CONFIRMED', ...extra })).json.requirement;
  const r1 = await mk('A'); const r2 = await mk('B'); const r3 = await mk('C'); const rx = await mk('X', { status: 'REJECTED' });
  const w = (await A.c('POST', A.wbs, { title: '작업', item_type: 'TASK' })).json.item;
  assert.equal((await A.c('POST', `${A.req}/${r1.id}/links`, { wbs_item_id: w.id })).status, 201);
  const t1 = (await A.c('POST', `${A.purl}/tests`, { title: 'T1' })).json.test;
  const t2 = (await A.c('POST', `${A.purl}/tests`, { title: 'T2' })).json.test;
  await A.c('POST', `${A.purl}/tests/${t1.id}/links`, { target_type: 'REQUIREMENT', target_id: r1.id });
  await A.c('POST', `${A.purl}/tests/${t2.id}/links`, { target_type: 'REQUIREMENT', target_id: r2.id });
  await A.c('POST', `${A.purl}/tests/${t1.id}/executions`, { result: 'PASS' });
  await A.c('POST', `${A.purl}/tests/${t2.id}/executions`, { result: 'FAIL' });
  const d = (await A.c('GET', `${A.req}?trace=1`)).json;
  assert.deepEqual(d.trace.coverage, { in_scope: 3, wbs: 1, tests: 2, passed: 1 });
  assert.deepEqual([d.trace.rows[r1.id].wbs, d.trace.rows[r1.id].tests, d.trace.rows[r1.id].last], [1, 1, 'PASS']);
  assert.equal(d.trace.rows[r2.id].last, 'FAIL'); assert.equal(d.trace.rows[r3.id].tests, 0); assert.equal(d.trace.rows[r3.id].last, null);
  assert.ok(d.trace.rows[rx.id]);
  assert.equal((await A.c('GET', A.req)).json.trace, undefined, 'only on request');
  server.close();
});

test('#20 inline 실행 기록: step_results saved and returned; FAIL + raise_issue creates one issue in the same save; PASS ignores raise_issue; bad step_results 400', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'run@x.com');
  const t = (await A.c('POST', `${A.purl}/tests`, { title: '로그인', steps: [{ instruction: '열기', expected: '열림' }, { instruction: '저장', expected: '저장됨' }], test_data: '일반 사용자 계정', environment: 'PC Chrome' })).json.test;
  assert.equal(t.test_data, '일반 사용자 계정'); assert.equal(t.environment, 'PC Chrome');
  let r = await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result: 'FAIL', actual_result: '저장 오류', step_results: [{ index: 0, result: 'PASS' }, { index: 1, result: 'FAIL' }], raise_issue: true });
  assert.equal(r.status, 201); assert.match(r.json.execution.issue_display_id, /^ISS-\d+/);
  const ex = r.json.test.executions[0];
  assert.deepEqual(ex.step_results, [{ index: 0, result: 'PASS' }, { index: 1, result: 'FAIL' }]); assert.equal(ex.issue_display_id, r.json.execution.issue_display_id);
  r = await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result: 'PASS', raise_issue: true });
  assert.equal(r.status, 201); assert.equal(r.json.execution.issue_display_id, undefined);
  assert.equal(r.json.test.executions[0].step_results, null);
  assert.equal((await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result: 'PASS', step_results: [{ index: 0, result: 'MAYBE' }] })).status, 400);
  assert.equal((await A.c('GET', `${A.purl}/issues`)).json.items.length, 1);
  const p = await A.c('PATCH', `${A.purl}/tests/${t.id}`, { test_data: '관리자 계정', environment: '' });
  assert.equal(p.json.test.test_data, '관리자 계정'); assert.equal(p.json.test.environment, '');
  server.close();
});
