/* 06 전환·오픈 · 07 운영 — activity checklists and manual 완료 처리: the 7-phase lifecycle can be finished end to end. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { activityStates, checklistDerived } from '../activities.js';
import { CHECKLIST_TEMPLATES } from '../templates/default-phases.js';
import { todayKst } from '../../public/app/shared/kst-date.js';

const phase = (g, key) => g.phases.find((p) => p.phase_key === key);
const step = (g, key) => g.phases.flatMap((p) => p.steps).find((s) => s.step_key === key);

test('checklistDerived / activityStates: items drive manual activities only; manual flag; hand mark wins', () => {
  assert.deepEqual(checklistDerived({ derived: null, text: 'x' }, { total: 0, done: 0 }), { derived: null, text: 'x' });
  assert.equal(checklistDerived({ derived: null, text: '' }, { total: 3, done: 1 }).derived, 'IN_PROGRESS');
  assert.equal(checklistDerived({ derived: null, text: '' }, { total: 3, done: 3 }).derived, 'COMPLETED');
  assert.equal(checklistDerived({ derived: 'NOT_STARTED', text: '' }, { total: 3, done: 3 }).derived, 'NOT_STARTED', 'data-driven rules are untouched');

  const mk = (step_key, o = {}) => ({ id: step_key, step_key, title: step_key, importance: 'REQUIRED', status: 'TODO', note: '', ...o });
  const ctx = { pid: 'p1', stats: {}, checklists: { CUTOVER_PLAN: { total: 2, done: 1 }, HANDOVER: { total: 2, done: 2 } } };
  const [acc, cut, mig, live] = activityStates('TRANSITION_GO_LIVE', [mk('ACCEPTANCE'), mk('CUTOVER_PLAN'), mk('DATA_MIGRATION'), mk('GO_LIVE', { status: 'COMPLETED' })], ctx);
  assert.equal(acc.manual, false); assert.equal(acc.checklist, null);   // acceptance has its own screen and data
  assert.equal(cut.manual, true); assert.equal(cut.state, 'IN_PROGRESS'); assert.match(cut.text, /체크리스트 1\/2 완료/);
  assert.equal(cut.cta.href, '/app/projects/p1/checklist?activity=CUTOVER_PLAN');
  assert.equal(mig.state, 'NOT_STARTED'); assert.deepEqual(mig.checklist, { total: 0, done: 0 });
  assert.equal(live.state, 'COMPLETED'); assert.equal(live.cta, null);
  // Phase 7: HANDOVER never completes from its checklist alone (인수자 · 인수일); CLOSE = 완료보고서 확정
  const [ho, close] = activityStates('OPERATIONS', [mk('HANDOVER'), mk('CLOSE')], ctx);
  assert.equal(ho.state, 'IN_PROGRESS'); assert.match(ho.text, /인수 완료 처리가 남았습니다/); assert.equal(ho.handover, true);
  assert.equal(close.state, 'NOT_STARTED'); assert.equal(close.cta.href, '/app/projects/p1/reports?new=completion'); assert.equal(close.manual, true);
  // 04 의사결정 기록 has no data signal either → manual (완료 처리 on What's Next), but no checklist
  const [dec] = activityStates('DEVELOPMENT', [mk('DECISIONS', { importance: 'OPTIONAL' })], { pid: 'p1', stats: {} });
  assert.equal(dec.manual, true); assert.equal(dec.checklist, null);
});

test('checklist API: CRUD, defaults, validation, scoping, derived state', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com');
  const B = await setup(client, 'b@x.com');
  let g = (await A.c('GET', A.purl)).json;
  const cut = step(g, 'CUTOVER_PLAN'); const collect = step(g, 'COLLECT');
  const url = `${A.purl}/steps/${cut.id}/checklist`;
  assert.equal(cut.state, 'NOT_STARTED'); assert.equal(cut.manual, true); assert.deepEqual(cut.checklist, { total: 0, done: 0 });

  // validation
  for (const body of [{}, { title: '   ' }, { title: 'a'.repeat(201) }, { title: 5 }, { title: 'x', due_date: '2026-13-45' }, { title: 'x', due_date: '10/14' }, { title: 'x', owner: 'o'.repeat(101) }, { title: 'x', note: 'n'.repeat(2001) }, { title: 'x', done: 'yes' }]) {
    const r = await A.c('POST', url, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.ok(Object.keys(r.json.error.fields).length);
  }
  // non-checklist activity / unknown step / other tenant
  const no = await A.c('POST', `${A.purl}/steps/${collect.id}/checklist`, { title: 'x' });
  assert.equal(no.status, 409); assert.equal(no.json.error.code, 'no_checklist');
  assert.equal((await A.c('POST', `${A.purl}/steps/nope/checklist`, { title: 'x' })).status, 404);
  assert.equal((await B.c('POST', url, { title: 'x' })).status, 404);
  assert.equal((await B.c('POST', `${B.purl}/steps/${cut.id}/checklist`, { title: 'x' })).status, 404, 'step of another project');

  // create
  const c1 = await A.c('POST', url, { title: '  전환 Runbook  ', owner: '김운영', due_date: '2026-12-01', note: 'v1' });
  assert.equal(c1.status, 201, JSON.stringify(c1.json));
  const it1 = c1.json.item;
  assert.equal(it1.title, '전환 Runbook'); assert.equal(it1.owner, '김운영'); assert.equal(it1.due_date, '2026-12-01'); assert.equal(it1.done, false); assert.equal(it1.step_key, 'CUTOVER_PLAN');
  g = (await A.c('GET', A.purl)).json;
  assert.equal(step(g, 'CUTOVER_PLAN').state, 'IN_PROGRESS'); assert.deepEqual(step(g, 'CUTOVER_PLAN').checklist, { total: 1, done: 0 });

  // defaults: starter items added once
  let d = (await A.c('POST', `${url}/defaults`, {})).json;
  assert.equal(d.added, CHECKLIST_TEMPLATES.CUTOVER_PLAN.length);
  assert.equal((await A.c('POST', `${url}/defaults`, {})).json.added, 0, 'idempotent');
  const mine = d.items.filter((x) => x.step_id === cut.id);
  assert.equal(mine.length, CHECKLIST_TEMPLATES.CUTOVER_PLAN.length + 1);
  assert.deepEqual(mine.map((x) => x.sequence), mine.map((_, i) => i + 1), 'appended in order');
  assert.equal((await A.c('POST', `${A.purl}/steps/${collect.id}/checklist/defaults`, {})).status, 409);

  // patch
  const p1 = await A.c('PATCH', `${A.purl}/checklist/${it1.id}`, { done: true, owner: null, due_date: '' });
  assert.equal(p1.status, 200); assert.equal(p1.json.item.done, true); assert.ok(p1.json.item.done_at); assert.equal(p1.json.item.done_by, A.uid);
  assert.equal(p1.json.item.owner, ''); assert.equal(p1.json.item.due_date, null);
  assert.equal((await A.c('PATCH', `${A.purl}/checklist/${it1.id}`, {})).status, 400);
  assert.equal((await A.c('PATCH', `${A.purl}/checklist/${it1.id}`, { title: '' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.purl}/checklist/nope`, { done: true })).status, 404);
  assert.equal((await B.c('PATCH', `${B.purl}/checklist/${it1.id}`, { done: false })).status, 404, 'item of another project');
  const undone = (await A.c('PATCH', `${A.purl}/checklist/${it1.id}`, { done: false })).json.item;
  assert.equal(undone.done_at, null); assert.equal(undone.done_by, null);

  // all done → activity COMPLETED (derived), one reopened → IN_PROGRESS
  for (const x of mine) await A.c('PATCH', `${A.purl}/checklist/${x.id}`, { done: true });
  g = (await A.c('GET', A.purl)).json;
  assert.equal(step(g, 'CUTOVER_PLAN').state, 'COMPLETED'); assert.equal(step(g, 'CUTOVER_PLAN').status, 'TODO', 'derived, not stored');
  await A.c('PATCH', `${A.purl}/checklist/${it1.id}`, { done: false });
  assert.equal(step((await A.c('GET', A.purl)).json, 'CUTOVER_PLAN').state, 'IN_PROGRESS');

  // list + delete
  const list = (await A.c('GET', `${A.purl}/checklists`)).json.items;
  assert.equal(list.length, mine.length);
  assert.equal((await B.c('GET', `${A.purl}/checklists`)).status, 404);
  assert.equal((await A.c('DELETE', `${A.purl}/checklist/${it1.id}`)).status, 200);
  assert.equal((await A.c('DELETE', `${A.purl}/checklist/${it1.id}`)).status, 404);
  assert.equal(step((await A.c('GET', A.purl)).json, 'CUTOVER_PLAN').state, 'COMPLETED', 'remaining items are all done');

  // archived project: read-only
  await A.c('POST', `${A.purl}/archive`, {});
  const ar = (await A.c('GET', A.purl)).json;
  if (ar.project.status === 'ARCHIVED') {
    assert.equal((await A.c('POST', url, { title: 'x' })).status, 409);
    assert.equal((await A.c('PATCH', `${A.purl}/checklist/${list[1].id}`, { done: false })).status, 409);
    assert.equal((await A.c('DELETE', `${A.purl}/checklist/${list[1].id}`)).status, 409);
    assert.equal((await A.c('GET', `${A.purl}/checklists`)).status, 200);
  }
  server.close();
});

test('end to end: 06 전환·오픈 and 07 운영 can be completed (checklists + 완료 처리), project closes', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'e2e@x.com');
  let g = (await A.c('GET', A.purl)).json;
  // jump to 06 (moving ahead with open activities is allowed)
  g = (await A.c('POST', `${A.purl}/phases/${phase(g, 'TRANSITION_GO_LIVE').id}/activate`, {})).json;
  assert.equal(g.current_phase.phase_key, 'TRANSITION_GO_LIVE');
  assert.equal(phase(g, 'TRANSITION_GO_LIVE').summary.gate_met, false);
  // REQUIRED manual activities still cannot be skipped
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(g, 'GO_LIVE').id}`, { status: 'SKIPPED' })).status, 409);

  // ACCEPTANCE is data-driven (검수 screen; hand-marking is 409 until the scope is accepted): seed one accepted 검수 to isolate 06's manual activities
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(g, 'ACCEPTANCE').id}`, { status: 'COMPLETED' })).status, 409);
  const acc = (await A.c('POST', `${A.purl}/acceptances`, { title: '검수' })).json.acceptance;
  await db.run(`UPDATE acceptances SET status = 'ACCEPTED', accepted_at = now() WHERE id = ?`, [acc.id]);
  g = (await A.c('GET', A.purl)).json;
  // guidance points at the first open REQUIRED activity's checklist
  assert.equal(g.guidance.rule, 'TRANSITION_RUN');
  assert.equal(g.guidance.primary_action.href, `/app/projects/${A.p.id}/checklist?activity=CUTOVER_PLAN`);
  assert.match(g.guidance.primary_action.label, /전환 계획 수립 체크리스트 →/);

  // CUTOVER_PLAN through its checklist, GO_LIVE by 완료 처리
  const cutUrl = `${A.purl}/steps/${step(g, 'CUTOVER_PLAN').id}/checklist`;
  const items = (await A.c('POST', `${cutUrl}/defaults`, {})).json.items;
  for (const it of items) await A.c('PATCH', `${A.purl}/checklist/${it.id}`, { done: true });
  // Phase 6 US-3: 오픈 completes through the 오픈 dialog (POST …/go-live), never by a plain 완료 처리
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(g, 'GO_LIVE').id}`, { status: 'COMPLETED' })).status, 409);
  g = (await A.c('POST', `${A.purl}/go-live`, { date: todayKst(), carryovers: [] })).json;
  assert.equal(step(g, 'CUTOVER_PLAN').state, 'COMPLETED');
  assert.equal(step(g, 'GO_LIVE').state, 'COMPLETED');
  assert.equal(phase(g, 'TRANSITION_GO_LIVE').summary.gate_met, true);
  // optional ones may be skipped
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(g, 'DATA_MIGRATION').id}`, { status: 'SKIPPED' })).status, 200);

  // → 07: leaving phase is COMPLETED because its REQUIRED gate is met
  g = (await A.c('POST', `${A.purl}/phases/${phase(g, 'OPERATIONS').id}/activate`, { reason: 'NEXT' })).json;
  assert.equal(phase(g, 'TRANSITION_GO_LIVE').status, 'COMPLETED');
  assert.equal(g.current_phase.phase_key, 'OPERATIONS');
  assert.equal(g.guidance.primary_action.href, `/app/projects/${A.p.id}?handover=1`);   // Phase 7 US-3

  // HANDOVER via one custom item, CLOSE via 완료 처리 with a memo
  const ho = (await A.c('POST', `${A.purl}/steps/${step(g, 'HANDOVER').id}/checklist`, { title: '운영 매뉴얼 인계', owner: '고객사 운영팀', due_date: '2027-03-01', done: true })).json.item;
  assert.equal(ho.done, true); assert.ok(ho.done_at);
  await A.c('PATCH', `${A.purl}/steps/${step(g, 'CLOSE').id}`, { note: '완료 보고 3/5 · 교훈 정리 위키' });
  g = (await A.c('GET', A.purl)).json;
  assert.equal(step(g, 'CLOSE').state, 'NOT_STARTED', 'Phase 7: CLOSE follows the 완료보고서, a memo alone does not move it');
  // Phase 7: HANDOVER needs 인수자 · 인수일; CLOSE without a 완료보고서 needs a 사유
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(g, 'HANDOVER').id}`, { status: 'COMPLETED' })).status, 422);
  g = (await A.c('PATCH', `${A.purl}/steps/${step(g, 'HANDOVER').id}`, { status: 'COMPLETED', handover: { receiver: `u:${A.uid}`, date: todayKst() } })).json;
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${step(g, 'CLOSE').id}`, { status: 'COMPLETED' })).status, 422);
  g = (await A.c('PATCH', `${A.purl}/steps/${step(g, 'CLOSE').id}`, { status: 'COMPLETED', reason: '고객사 양식으로 작성해 전달' })).json;
  const ops = phase(g, 'OPERATIONS');
  assert.equal(step(g, 'HANDOVER').state, 'COMPLETED');
  assert.equal(step(g, 'CLOSE').state, 'COMPLETED');
  assert.equal(ops.summary.gate_met, true); assert.equal(ops.summary.required_open, 0);
  assert.equal(g.next_phase, null);
  // 되돌리기: the hand mark is removable again
  g = (await A.c('PATCH', `${A.purl}/steps/${step(g, 'CLOSE').id}`, { status: 'TODO' })).json;
  assert.equal(step(g, 'CLOSE').state, 'NOT_STARTED'); assert.equal(phase(g, 'OPERATIONS').summary.gate_met, false);   // data-driven now: no 완료보고서 → 미시작
  server.close();
});
