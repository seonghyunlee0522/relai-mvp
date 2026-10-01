import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { verificationStatus, summarizeResults } from '../testing.js';

async function boot() {
  const db = await testDb();
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json };
    };
  };
  return { db, server, client };
}
const project = (o = {}) => ({ name: 'P', project_type: 'SI', current_situation: 'NOT_STARTED', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', ...o });
async function setup(client, email = 'u@x.com') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  return { c, w, uid, p, purl, ts: `${purl}/tests`, ac: `${purl}/acceptances`,
    req: async (b) => (await c('POST', `${purl}/requirements`, { scope: 'IN_SCOPE', ...b })).json.requirement,
    wbs: async (b) => (await c('POST', `${purl}/wbs`, { item_type: 'TASK', ...b })).json.item,
    tc: async (b) => (await c('POST', `${purl}/tests`, b)).json.test,
    run: async (tid, b) => c('POST', `${purl}/tests/${tid}/executions`, b) };
}

test('verification status + summary (pure)', () => {
  assert.equal(verificationStatus([]), 'UNLINKED');
  assert.equal(verificationStatus(['PASS', 'PASS']), 'VERIFIED');
  assert.equal(verificationStatus(['PASS', 'FAIL']), 'FAILED');
  assert.equal(verificationStatus(['PASS', null]), 'IN_PROGRESS');
  assert.equal(verificationStatus(['BLOCKED']), 'IN_PROGRESS');
  assert.deepEqual(summarizeResults(['PASS', 'FAIL', null]), { total: 3, pass: 1, fail: 1, blocked: 0, not_run: 1, verification: 'FAILED' });
});

test('test cases: TC-001 per project, fields, steps, status/priority validation, owner, list filters, search, archive', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  let r = await A.c('POST', A.ts, { title: '로그인 성공', priority: 'HIGH', steps: [{ instruction: 'ID 입력', expected: '입력됨' }, 'PW 입력'], expected_result: '메인 화면 이동' });
  assert.equal(r.status, 201); const t1 = r.json.test;
  assert.equal(t1.display_id, 'TC-001'); assert.equal(t1.status, 'DRAFT'); assert.equal(t1.priority, 'HIGH');
  assert.deepEqual(t1.steps, [{ instruction: 'ID 입력', expected: '입력됨' }, { instruction: 'PW 입력', expected: '' }]);
  assert.equal(t1.last_result, null); assert.equal(t1.execution_count, 0);
  assert.equal((await A.tc({ title: 'x' })).display_id, 'TC-002');
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: 'P2' }))).json.project;
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/tests`, { title: 'x' })).json.test.display_id, 'TC-001');
  assert.equal((await A.c('POST', A.ts, { title: '' })).status, 400);
  assert.equal((await A.c('POST', A.ts, { title: 'x', status: 'DONE' })).status, 400);
  assert.equal((await A.c('POST', A.ts, { title: 'x', priority: 'URGENT' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.ts}/${t1.id}`, { owner_user_id: B.uid })).status, 400);
  r = await A.c('PATCH', `${A.ts}/${t1.id}`, { owner_user_id: A.uid, status: 'READY' });
  assert.equal(r.json.test.owner_name, '홍길동'); assert.equal(r.json.test.status, 'READY');
  assert.ok(r.json.test.history.some((h) => h.action_type === 'STATUS_CHANGED' && h.field_name === 'status' && h.new_value === 'READY'));
  // list + filters
  r = await A.c('GET', `${A.ts}?status=READY`); assert.equal(r.json.items.length, 1);
  r = await A.c('GET', `${A.ts}?priority=HIGH`); assert.equal(r.json.items.length, 1);
  r = await A.c('GET', `${A.ts}?owner=${A.uid}`); assert.equal(r.json.items.length, 1);
  r = await A.c('GET', `${A.ts}?owner=none`); assert.equal(r.json.items.length, 1);
  r = await A.c('GET', `${A.ts}?last_result=NOT_RUN`); assert.equal(r.json.items.length, 2);
  r = await A.c('GET', `${A.ts}?q=로그인`); assert.equal(r.json.items.length, 1);
  r = await A.c('GET', `${A.ts}?q=TC-002`); assert.equal(r.json.items.length, 1);
  assert.equal(r.json.tests.total, 2);
  // archive
  const t2 = (await A.c('GET', A.ts)).json.items.find((t) => t.display_id === 'TC-002');
  r = await A.c('POST', `${A.ts}/${t2.id}/archive`, {}); assert.ok(r.json.test.archived_at);
  assert.equal((await A.c('GET', A.ts)).json.items.length, 1);
  assert.equal((await A.c('GET', `${A.ts}?include_archived=1`)).json.items.length, 2);
  assert.equal((await A.c('PATCH', `${A.ts}/${t2.id}`, { title: 'y' })).status, 409);
  // access control
  assert.equal((await B.c('GET', A.ts)).status, 404);
  assert.equal((await B.c('GET', `${A.ts}/${t1.id}`)).status, 404);
  server.close();
});

test('executions: immutable numbered history, latest = last, filters by last result, archived project read-only', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com');
  const t = await A.tc({ title: '결제' });
  assert.equal((await A.run(t.id, { result: 'NOT_RUN' })).status, 400);
  assert.equal((await A.run(t.id, { result: 'SKIP' })).status, 400);
  let r = await A.run(t.id, { result: 'FAIL', actual_result: '500 에러', note: '첫 시도' });
  assert.equal(r.status, 201); assert.equal(r.json.execution.execution_number, 1); assert.equal(r.json.test.last_result, 'FAIL');
  r = await A.run(t.id, { result: 'BLOCKED' }); assert.equal(r.json.execution.execution_number, 2); assert.equal(r.json.test.last_result, 'BLOCKED');
  r = await A.run(t.id, { result: 'PASS' }); assert.equal(r.json.execution.execution_number, 3);
  assert.equal(r.json.test.last_result, 'PASS'); assert.equal(r.json.test.execution_count, 3);
  assert.deepEqual(r.json.test.executions.map((e) => e.execution_number), [3, 2, 1]);
  assert.equal(r.json.test.executions[2].actual_result, '500 에러');
  assert.equal(r.json.tests.executed, 1); assert.equal(r.json.tests.last_pass, 1);
  assert.ok(r.json.test.history.filter((h) => h.action_type === 'EXECUTED').length === 3);
  r = await A.c('GET', `${A.ts}?last_result=PASS`); assert.equal(r.json.items.length, 1);
  r = await A.c('GET', `${A.ts}?last_result=FAIL`); assert.equal(r.json.items.length, 0);
  // archived project
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.run(t.id, { result: 'PASS' })).status, 409);
  assert.equal((await A.c('POST', A.ts, { title: 'x' })).status, 409);
  assert.equal((await A.c('GET', `${A.ts}/${t.id}`)).status, 200);
  server.close();
});

test('links: requirement/WBS ↔ test, duplicates, cross-project rejection, coverage, requirement detail testing summary', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r1 = await A.req({ title: '로그인' }); const r2 = await A.req({ title: '결제' }); const rOut = await A.req({ title: '제외', scope: 'OUT_OF_SCOPE' });
  const w1 = await A.wbs({ title: '개발' });
  const t1 = await A.tc({ title: 'T1' }); const t2 = await A.tc({ title: 'T2' });
  const link = (tid, type, id) => A.c('POST', `${A.ts}/${tid}/links`, { target_type: type, target_id: id });
  let r = await link(t1.id, 'REQUIREMENT', r1.id); assert.equal(r.status, 201); assert.equal(r.json.test.links.requirements[0].code, 'REQ-001');
  assert.equal((await link(t1.id, 'REQUIREMENT', r1.id)).status, 400); // duplicate
  assert.equal(r.json.test.links.requirements.length, 1);
  r = await link(t1.id, 'WBS', w1.id); assert.equal(r.json.test.links.wbs[0].code, w1.wbs_code);
  assert.equal((await link(t1.id, 'REQUIREMENT', 'nope')).status, 404);
  assert.equal((await link(t1.id, 'ISSUE', r1.id)).status, 400);
  const bReq = await B.req({ title: 'B' });
  assert.equal((await link(t1.id, 'REQUIREMENT', bReq.id)).status, 404);
  await link(t2.id, 'REQUIREMENT', r1.id);
  // filter by requirement / wbs
  assert.equal((await A.c('GET', `${A.ts}?requirement=${r1.id}`)).json.items.length, 2);
  assert.equal((await A.c('GET', `${A.ts}?wbs=${w1.id}`)).json.items.length, 1);
  // coverage: only IN_SCOPE reqs
  r = await A.c('GET', `${A.ts}/coverage`);
  assert.equal(r.json.coverage.length, 2); assert.ok(!r.json.coverage.some((c) => c.id === rOut.id));
  const c1 = r.json.coverage.find((c) => c.id === r1.id); assert.equal(c1.tests.length, 2); assert.equal(c1.verification, 'IN_PROGRESS');
  assert.equal(r.json.coverage.find((c) => c.id === r2.id).verification, 'UNLINKED');
  assert.equal(r.json.tests.in_scope, 2); assert.equal(r.json.tests.in_scope_tested, 1); assert.equal(r.json.tests.coverage, 50);
  // verification via executions
  await A.run(t1.id, { result: 'PASS' }); await A.run(t2.id, { result: 'FAIL' });
  r = await A.c('GET', `${A.purl}/requirements/${r1.id}`);
  assert.equal(r.json.requirement.testing.summary.verification, 'FAILED'); assert.equal(r.json.requirement.testing.tests.length, 2);
  await A.run(t2.id, { result: 'PASS' });
  r = await A.c('GET', `${A.purl}/requirements/${r1.id}`); assert.equal(r.json.requirement.testing.summary.verification, 'VERIFIED');
  r = await A.c('GET', `${A.purl}/wbs/${w1.id}`); assert.equal(r.json.item.testing.tests.length, 1);
  // archived test drops out of coverage
  await A.c('POST', `${A.ts}/${t2.id}/archive`, {});
  r = await A.c('GET', `${A.ts}/coverage`); assert.equal(r.json.coverage.find((c) => c.id === r1.id).tests.length, 1);
  // unlink
  const t1d = (await A.c('GET', `${A.ts}/${t1.id}`)).json.test;
  r = await A.c('DELETE', `${A.ts}/${t1.id}/links/${t1d.links.wbs[0].id}`); assert.equal(r.json.test.links.wbs.length, 0);
  assert.equal((await A.c('DELETE', `${A.ts}/${t1.id}/links/nope`)).status, 404);
  server.close();
});

test('fail → issue: defaults, links copied, source execution, dedupe, only FAIL', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com');
  const r1 = await A.req({ title: '로그인' }); const w1 = await A.wbs({ title: '개발' });
  const t = await A.tc({ title: '로그인 실패 처리', priority: 'HIGH', owner_user_id: A.uid, expected_result: '오류 메시지' });
  await A.c('POST', `${A.ts}/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: r1.id });
  await A.c('POST', `${A.ts}/${t.id}/links`, { target_type: 'WBS', target_id: w1.id });
  const ePass = (await A.run(t.id, { result: 'PASS' })).json.execution;
  const eFail = (await A.run(t.id, { result: 'FAIL', actual_result: '화면 멈춤' })).json.execution;
  assert.equal((await A.c('POST', `${A.ts}/${t.id}/executions/${ePass.id}/issue`, {})).status, 409);
  let r = await A.c('POST', `${A.ts}/${t.id}/executions/${eFail.id}/issue`, {});
  assert.equal(r.status, 201); const issue = r.json.issue;
  assert.equal(issue.display_id, 'ISS-001'); assert.equal(issue.title, '[TC-001] 로그인 실패 처리 실패'); assert.equal(issue.severity, 'HIGH');
  assert.equal(issue.owner_user_id, A.uid); assert.match(issue.description, /화면 멈춤/); assert.match(issue.description, /오류 메시지/);
  assert.equal(issue.source_test_execution_id, eFail.id); assert.equal(issue.source_test_label, 'TC-001 #2');
  assert.equal(issue.links.requirements.length, 1); assert.equal(issue.links.wbs.length, 1);
  const ex = r.json.test.executions.find((e) => e.id === eFail.id); assert.equal(ex.issue_display_id, 'ISS-001');
  r = await A.c('POST', `${A.ts}/${t.id}/executions/${eFail.id}/issue`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'already_raised');
  assert.equal((await A.c('GET', `${A.purl}/issues`)).json.items.length, 1);
  assert.equal((await A.c('GET', A.ts)).json.tests.fail_issues_open, 1);
  assert.equal((await A.c('POST', `${A.ts}/${t.id}/executions/nope/issue`, {})).status, 404);
  server.close();
});

test('acceptances: ACC-001, transitions, decision note, links, test summary, list filters, archive, guide stats', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r1 = await A.req({ title: '로그인' }); const t1 = await A.tc({ title: 'T1' }); const t2 = await A.tc({ title: 'T2' });
  await A.c('POST', `${A.ts}/${t1.id}/links`, { target_type: 'REQUIREMENT', target_id: r1.id });
  let r = await A.c('POST', A.ac, { title: '1차 검수', due_date: '2027-01-15', requirements: [r1.id] });
  assert.equal(r.status, 201); const a = r.json.acceptance;
  assert.equal(a.display_id, 'ACC-001'); assert.equal(a.status, 'DRAFT'); assert.equal(a.requirements.length, 1); assert.equal(a.requested_at, null);
  assert.equal((await A.c('POST', A.ac, { title: 'x', requirements: ['nope'] })).status, 400);
  assert.equal((await A.c('POST', A.ac, { title: 'x', due_date: '2027-13-01' })).status, 400);
  assert.equal((await A.c('POST', A.ac, { title: 'x' })).json.acceptance.display_id, 'ACC-002');
  // links
  const link = (type, id) => A.c('POST', `${A.ac}/${a.id}/links`, { target_type: type, target_id: id });
  r = await link('TEST', t1.id); assert.equal(r.status, 201); r = await link('TEST', t2.id);
  assert.equal(r.json.acceptance.tests.length, 2); assert.equal(r.json.acceptance.test_summary.verification, 'IN_PROGRESS');
  assert.equal((await link('TEST', (await B.tc({ title: 'B' })).id)).status, 404);
  assert.equal((await link('WBS', t1.id)).status, 400);
  await A.run(t1.id, { result: 'FAIL' }); await A.run(t2.id, { result: 'PASS' });
  r = await A.c('GET', `${A.ac}/${a.id}`);
  assert.equal(r.json.acceptance.test_summary.fail, 1); assert.equal(r.json.acceptance.requirements[0].verification, 'FAILED');
  assert.equal(r.json.acceptances.target_fail_tests, 1); assert.equal(r.json.acceptances.target_requirements, 1);
  // transitions
  const tr = (action, body = {}) => A.c('POST', `${A.ac}/${a.id}/transition`, { action, ...body });
  assert.equal((await tr('accept')).status, 409);
  assert.equal((await tr('fly')).status, 400);
  r = await tr('submit'); assert.equal(r.json.acceptance.status, 'REQUESTED'); assert.ok(r.json.acceptance.requested_at);
  assert.equal((await tr('rework')).status, 400); // note required
  r = await tr('rework', { decision_note: '로그인 오류 수정 필요' }); assert.equal(r.json.acceptance.status, 'REWORK_REQUIRED'); assert.equal(r.json.acceptance.decision_note, '로그인 오류 수정 필요');
  assert.equal((await tr('accept')).status, 409);
  r = await tr('resubmit'); assert.equal(r.json.acceptance.status, 'REQUESTED');
  assert.equal((await tr('reject')).status, 400);
  r = await tr('accept'); assert.equal(r.json.acceptance.status, 'ACCEPTED'); assert.ok(r.json.acceptance.accepted_at);
  assert.equal((await tr('submit')).status, 409);
  assert.ok(r.json.acceptance.history.filter((h) => h.action_type === 'STATUS_CHANGED').length >= 4);
  // reject path on ACC-002
  const a2 = (await A.c('GET', A.ac)).json.items.find((x) => x.display_id === 'ACC-002');
  await A.c('POST', `${A.ac}/${a2.id}/transition`, { action: 'submit' });
  r = await A.c('POST', `${A.ac}/${a2.id}/transition`, { action: 'reject', decision_note: '범위 불일치' });
  assert.equal(r.json.acceptance.status, 'REJECTED'); assert.ok(r.json.acceptance.rejected_at);
  // list / filters / stats
  r = await A.c('GET', A.ac); assert.equal(r.json.items.length, 2); assert.equal(r.json.items.find((x) => x.id === a.id).test_summary.total, 2);
  assert.equal((await A.c('GET', `${A.ac}?status=ACCEPTED`)).json.items.length, 1);
  assert.equal((await A.c('GET', `${A.ac}?requirement=${r1.id}`)).json.items.length, 1);
  assert.equal((await A.c('GET', `${A.ac}?q=1차`)).json.items.length, 1);
  assert.equal(r.json.acceptances.accepted, 1); assert.equal(r.json.acceptances.rejected, 1); assert.equal(r.json.acceptances.in_progress, 0);
  // requirement + test detail show acceptances
  assert.equal((await A.c('GET', `${A.purl}/requirements/${r1.id}`)).json.requirement.acceptances[0].display_id, 'ACC-001');
  assert.equal((await A.c('GET', `${A.ts}/${t1.id}`)).json.test.acceptances.length, 1);
  // guide stats
  r = await A.c('GET', A.purl);
  assert.equal(r.json.tests.total, 2); assert.equal(r.json.tests.last_fail, 1); assert.equal(r.json.acceptances.accepted, 1);
  // archive + access
  r = await A.c('POST', `${A.ac}/${a2.id}/archive`, {}); assert.ok(r.json.acceptance.archived_at);
  assert.equal((await A.c('GET', A.ac)).json.items.length, 1);
  assert.equal((await A.c('PATCH', `${A.ac}/${a2.id}`, { title: 'y' })).status, 409);
  assert.equal((await B.c('GET', `${A.ac}/${a.id}`)).status, 404);
  server.close();
});
