/* Workspace Home cards (GET …/projects/home): one card per live project, Next Action identical to What's Next, priority ladder, completed/archived handling. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, project, setup } from './api-helpers.js';
import { homePriority, comparePriority, guidanceKind, MONITOR_RULES } from '../home.js';

const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
const mk = async (A, name, o = {}) => (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name, ...o }))).json.project;

test('home: cards carry the same guidance as the project GET, list rows only for completed, archived excluded', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'h@x.com', '홈');
  const p1 = A.p;                                                                   // ACTIVE · 착수 (INIT_DEFINE)
  const p2 = await mk(A, '완료된 프로젝트'); await db.run(`UPDATE projects SET status = 'COMPLETED' WHERE id = ?`, [p2.id]);
  const p3 = await mk(A, '보관 프로젝트'); await A.c('POST', `/api/workspaces/${A.w}/projects/${p3.id}/archive`, {});
  const p4 = await mk(A, '초안 프로젝트'); await db.run(`UPDATE projects SET status = 'DRAFT' WHERE id = ?`, [p4.id]);

  const r = await A.c('GET', `/api/workspaces/${A.w}/projects/home`);
  assert.equal(r.status, 200);
  const ids = r.json.projects.map((c) => c.id);
  assert.deepEqual(ids.sort(), [p1.id, p4.id].sort());
  assert.deepEqual(r.json.completed.map((c) => c.id), [p2.id]);
  assert.ok(!ids.includes(p3.id) && !r.json.completed.some((c) => c.id === p3.id));

  const card = r.json.projects.find((c) => c.id === p1.id);
  const g = (await A.c('GET', `/api/workspaces/${A.w}/projects/${p1.id}`)).json;
  assert.equal(card.guidance.rule, g.guidance.rule);
  assert.equal(card.guidance.title, g.guidance.title);
  assert.deepEqual(card.guidance.primary_action, g.guidance.primary_action);   // Home CTA == What's Next CTA (same href)
  assert.equal(card.guidance.kind, 'ACTION');
  assert.equal(card.current_phase_sequence, 1);
  assert.equal(card.current_phase_name, g.current_phase.name);
  assert.equal(card.priority, 'ACTION');
  assert.ok(['GOOD', 'UNKNOWN'].includes(card.health.status));   // empty project: change=GOOD, the rest UNKNOWN
  assert.deepEqual(card.attention, { total: 0, crit: 0, items: [] });
  assert.ok(Array.isArray(card.upcoming) && card.upcoming.length <= 3);
  const draft = r.json.projects.find((c) => c.id === p4.id);
  assert.equal(draft.priority, 'WAITING');
  assert.deepEqual(ids, [p1.id, p4.id]);                                             // ACTION sorts before WAITING
  assert.deepEqual(r.json.counts, { ACTION: 1, WAITING: 1 });
  server.close();
});

test('home: a critical issue makes the project a Blocker (first), attention lists it, milestones come from WBS', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'b@x.com', '블로커');
  const calm = A.p;
  const hot = await mk(A, '문제 프로젝트');
  const purl = `/api/workspaces/${A.w}/projects/${hot.id}`;
  await A.c('POST', `${purl}/issues`, { title: '결제 API 차단', severity: 'CRITICAL' });
  await A.c('POST', `${purl}/wbs`, { item_type: 'MILESTONE', title: '요구사항 확정', milestone_date: day(5) });
  await A.c('POST', `${purl}/wbs`, { item_type: 'MILESTONE', title: '지난 마일스톤', milestone_date: day(-3) });
  await A.c('POST', `${purl}/wbs`, { item_type: 'MILESTONE', title: 'Go-Live', milestone_date: day(40) });

  const r = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json;
  assert.deepEqual(r.projects.map((c) => c.id), [hot.id, calm.id]);
  const card = r.projects[0];
  assert.equal(card.priority, 'BLOCKER');
  assert.equal(card.health.status, 'CRITICAL');
  assert.equal(card.attention.crit, 1);
  assert.equal(card.attention.items[0].title, '결제 API 차단');
  assert.ok(card.attention.items[0].href.startsWith('issues?sel='));
  assert.deepEqual(card.upcoming.map((u) => u.title), ['요구사항 확정', 'Go-Live']);   // past milestone excluded, soonest first
  assert.equal(card.next_date.title, '요구사항 확정');
  assert.equal(card.soon, true);
  assert.equal(card.wbs.overdue_milestones, 1);
  server.close();
});

test('home: priority ladder and monitor-kind guidance (pure)', () => {
  const base = { project: { status: 'ACTIVE' }, health: { status: 'GOOD' }, attention: { total: 0, crit: 0 }, guidance: { rule: 'INIT_DEFINE' }, issues: {}, upcoming: [] };
  assert.equal(homePriority(base), 'ACTION');
  assert.equal(homePriority({ ...base, guidance: { rule: 'DEV_STATUS' } }), 'NORMAL');
  assert.equal(homePriority({ ...base, attention: { total: 2, crit: 0 } }), 'ATTENTION');
  assert.equal(homePriority({ ...base, health: { status: 'WARNING' } }), 'ACTION');   // no concrete attention rows → the CTA is the answer
  assert.equal(homePriority({ ...base, health: { status: 'CRITICAL' } }), 'BLOCKER');
  assert.equal(homePriority({ ...base, attention: { total: 1, crit: 1 } }), 'BLOCKER');
  assert.equal(homePriority({ ...base, issues: { blocked: 1 } }), 'BLOCKER');
  assert.equal(homePriority({ ...base, project: { status: 'ON_HOLD' }, attention: { total: 1, crit: 1 } }), 'WAITING');
  for (const rule of MONITOR_RULES) assert.equal(guidanceKind({ rule }), 'MONITOR');
  assert.equal(guidanceKind({ rule: 'WBS_EMPTY' }), 'ACTION');
  const sorted = [
    { priority: 'NORMAL', next_date_days: 3, name: 'n1' }, { priority: 'BLOCKER', next_date_days: null, name: 'b' },
    { priority: 'NORMAL', next_date_days: null, name: 'n2' }, { priority: 'ACTION', next_date_days: 30, name: 'a' },
  ].sort(comparePriority).map((x) => x.name);
  assert.deepEqual(sorted, ['b', 'a', 'n1', 'n2']);
});
