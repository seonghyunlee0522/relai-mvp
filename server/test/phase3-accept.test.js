/* Phase 3 acceptance fixes: J-A1 지난 주요 일정 → 완료 마일스톤 · J-A2 워크스페이스 멤버와 같은 이해관계자는 담당자 '팀원 (계정 없음)'에서 제외 ·
 * J-A3 stored 03 copy (migration 34) · B-1 단계 ✓ = REQUIRED gate on every read (LNB · stepper · Home), never a stored COMPLETED alone.
 * Spec: hive research/relai-phase-3-spec.md '## Acceptance'. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { migrations } from '../migrations.js';
import { phaseDisplayState } from '../guide.js';
import { todayStr } from '../wbs.js';

const step = (g, phase, key) => g.phases.find((x) => x.phase_key === phase).steps.find((s) => s.step_key === key);
const shift = (days) => { const d = new Date(`${todayStr()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const to03 = async (A) => {
  for (const key of ['REQUIREMENTS', 'ANALYSIS_DESIGN']) {
    const ph = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === key);
    assert.equal((await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'NEXT' })).status, 200);
  }
};

test('J-A1: a key date before today (APP_TIMEZONE) is imported as a COMPLETED milestone — no 지연 on day one of 03; a future one stays 미시작', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const past = shift(-1); const future = shift(30);
  await A.c('PUT', `${A.purl}/definition`, { key_dates: [{ title: '착수보고회', date: past }, { title: '오픈', date: future }] });
  await to03(A);
  await A.c('POST', A.wbs, { title: '설계' });
  const r = await A.c('POST', `${A.wbs}/milestones/from-key-dates`, {}); assert.equal(r.status, 201); assert.equal(r.json.created, 2);
  const ms = Object.fromEntries(r.json.items.filter((i) => i.item_type === 'MILESTONE').map((i) => [i.title, i]));
  assert.equal(ms['착수보고회'].status, 'COMPLETED'); assert.equal(ms['착수보고회'].actual_end_date, past); assert.notEqual(ms['착수보고회'].computed_status, 'DELAYED');
  assert.equal(ms['오픈'].status, 'NOT_STARTED');
  assert.equal(r.json.summary.overdue_milestones || 0, 0);
  server.close();
});

test('J-A1: the WBS skeleton milestones follow the same rule (past key date → 완료)', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  await A.c('PUT', `${A.purl}/definition`, { key_dates: [{ title: '요구사항 확정', date: shift(-3) }, { title: '오픈', date: shift(60) }] });
  await A.c('POST', A.req, { title: '기능 1', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  await to03(A);
  const r = await A.c('POST', `${A.wbs}/skeleton`, {}); assert.equal(r.status, 201);
  const ms = (await A.c('GET', A.wbs)).json.items.filter((i) => i.item_type === 'MILESTONE');
  assert.deepEqual(ms.map((m) => [m.title, m.status]), [['요구사항 확정', 'COMPLETED'], ['오픈', 'NOT_STARTED']]);
  server.close();
});

/** = shared/owner-picker.js teamFor (that module needs the DOM). */
const teamFor = (team, cur = '') => (team || []).filter((t) => !t.member || `s:${t.id}` === cur);
test('J-A2: a stakeholder with the same name as a workspace member is not offered again as 팀원 (계정 없음); one already assigned stays', async () => {
  const { server, client } = await boot();
  const A = await setup(client);   // member 홍길동
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: [
    { id: 'sh-me', name: '홍길동', org_type: 'OWN', role: 'PM' }, { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', role: '개발' }] });
  await to03(A);
  let w = (await A.c('GET', A.wbs)).json;
  assert.deepEqual(w.owners.team.filter((t) => !t.member).map((t) => t.id), ['sh-dev']); assert.equal(w.owners.stakeholders_total, 2);
  assert.deepEqual(teamFor(w.owners.team).map((t) => t.id), ['sh-dev']);   // K13: the picker hides the member duplicate…
  // a task assigned before the fix keeps its (now hidden) stakeholder visible in the picker
  const t = (await A.c('POST', A.wbs, { title: '설계' })).json.item;
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: [{ id: 'sh-old', name: '김옛날', org_type: 'OWN', role: 'PL' }, { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', role: '개발' }] });
  assert.equal((await A.c('PATCH', `${A.wbs}/${t.id}`, { owner_stakeholder_id: 'sh-old' })).status, 200);
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: [{ id: 'sh-old', name: '홍길동', org_type: 'OWN', role: 'PL' }, { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', role: '개발' }] });
  w = (await A.c('GET', A.wbs)).json;
  assert.deepEqual(teamFor(w.owners.team, 's:sh-old').map((t2) => t2.id).sort(), ['sh-dev', 'sh-old']);   // …except on the item that already has them
  assert.deepEqual(teamFor(w.owners.team, '').map((t2) => t2.id), ['sh-dev']);                             // K13: other items do not see the duplicate
  server.close();
});

test('J-A3 migration 34: stored REQ_TRACE title and PLAN description → Korean (idempotent; an edited title stays)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  await db.run(`UPDATE project_steps SET title = 'Requirements ↔ WBS 연결' WHERE step_key = 'REQ_TRACE'`);
  await db.run(`UPDATE project_steps SET description = '작업별 시작일과 종료일을 정해 Task 수준의 세부 일정을 만듭니다.' WHERE step_key = 'PLAN'`);
  const m34 = migrations.find((m) => m.version === 34); assert.ok(m34);
  await m34.up(db); await m34.up(db);
  const g = (await A.c('GET', A.purl)).json;
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'REQ_TRACE').title, '요구사항–WBS 연결');
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'PLAN').description, '작업별 시작일과 종료일을 정해 작업 수준의 세부 일정을 만듭니다.');
  await db.run(`UPDATE project_steps SET title = '추적 연결' WHERE step_key = 'REQ_TRACE'`); await m34.up(db);
  assert.equal(step((await A.c('GET', A.purl)).json, 'ANALYSIS_DESIGN', 'REQ_TRACE').title, '추적 연결');
  server.close();
});

test('B-1 phaseDisplayState: ✓ only when the REQUIRED gate is met — a stored COMPLETED with REQUIRED open is gap', () => {
  const S = (o) => phaseDisplayState({ is_current: false, is_passed: false, status: 'NOT_STARTED', summary: { required_open: 0 }, ...o });
  assert.equal(S({ is_current: true, status: 'COMPLETED' }), 'cur');
  assert.equal(S({ status: 'COMPLETED', summary: { required_open: 1 } }), 'gap');
  assert.equal(S({ is_passed: true, status: 'COMPLETED', summary: { required_open: 2 } }), 'gap');
  assert.equal(S({ is_passed: true, status: 'IN_PROGRESS', summary: { required_open: 0 } }), 'done');
  assert.equal(S({ is_passed: true, status: 'COMPLETED', summary: { required_open: 0 } }), 'done');
  assert.equal(S({}), 'todo');
  assert.equal(S({ is_passed: true, summary: null }), 'done');
});

test('B-1 legacy project (passed 01–03 before the gates, phases stored COMPLETED): no ✓ on any phase with REQUIRED open — project GET and Home agree', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  // Simulate the legacy state directly: 01–03 COMPLETED, current = 04, no baseline approval / no WBS.
  await db.run(`UPDATE project_phases SET status = 'COMPLETED' WHERE project_id = ? AND phase_key IN ('INITIATION','REQUIREMENTS','ANALYSIS_DESIGN')`, [A.p.id]);
  await db.run(`UPDATE project_phases SET status = 'IN_PROGRESS' WHERE project_id = ? AND phase_key = 'DEVELOPMENT'`, [A.p.id]);
  await db.run(`UPDATE projects SET current_phase = 'DEVELOPMENT' WHERE id = ?`, [A.p.id]);
  const g = (await A.c('GET', A.purl)).json;
  const st = Object.fromEntries(g.phases.map((p) => [p.phase_key, p.display_state]));
  assert.equal(st.INITIATION, 'gap'); assert.equal(st.REQUIREMENTS, 'gap'); assert.equal(st.ANALYSIS_DESIGN, 'gap'); assert.equal(st.DEVELOPMENT, 'cur'); assert.equal(st.TESTING, 'todo');
  assert.ok(step(g, 'REQUIREMENTS', 'BASELINE_APPROVAL').state !== 'COMPLETED');
  const home = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json;
  const card = home.projects.find((c) => c.id === A.p.id);
  assert.deepEqual(card.phase_states.slice(0, 5), ['gap', 'gap', 'gap', 'cur', 'todo']);
  server.close();
});
