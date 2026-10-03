import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_TIMEZONE } from '../db.js';
import { boot, setup } from './api-helpers.js';
import { plannedPercent, scheduleFigures } from '../wbs.js';

const mkWbs = async (A, body) => { const r = await A.c('POST', A.wbs, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };
const day = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400e3));

/* ---------- pure functions (What’s Next / Overview redesign §14–§17) ---------- */
test('plannedPercent: before start 0, after end 100, inclusive elapsed share in between, null without both dates', () => {
  const t = { planned_start_date: '2026-10-01', planned_end_date: '2026-10-10' };   // 10 days
  assert.equal(plannedPercent(t, '2026-09-30'), 0);
  assert.equal(plannedPercent(t, '2026-10-01'), 10);
  assert.equal(plannedPercent(t, '2026-10-05'), 50);
  assert.equal(plannedPercent(t, '2026-10-10'), 100);
  assert.equal(plannedPercent(t, '2026-11-01'), 100);
  assert.equal(plannedPercent({ planned_start_date: '2026-10-01' }, '2026-10-05'), null);
});

test('scheduleFigures: weighted planned vs actual (§14 example), variance, overdue counts and longest delay — no invented data', () => {
  const today = '2026-10-10';
  const tasks = [
    { status: 'COMPLETED', progress: 100, weight: 30, planned_start_date: '2026-09-01', planned_end_date: '2026-09-30' },   // planned 100
    { status: 'IN_PROGRESS', progress: 50, weight: 40, planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' },  // planned 50
    { status: 'NOT_STARTED', progress: 0, weight: 30, planned_start_date: '2026-11-01', planned_end_date: '2026-11-30' },   // planned 0
  ];
  const f = scheduleFigures(tasks, [], today);
  assert.equal(f.planned_progress, 50);                       // 30 + 20 + 0
  assert.equal(f.progress, 50);                               // 30 + 20 + 0 (weighted actual)
  assert.equal(f.variance, 0);
  assert.deepEqual(f.planned_basis, { dated: 3, tasks: 3 });
  assert.equal(f.overdue_tasks, 0); assert.equal(f.max_overdue_days, 0);
  // undated tasks are excluded from planned (not guessed) but counted in actual; weight null = 1, weight 0 excluded
  const g = scheduleFigures([{ status: 'NOT_STARTED', progress: 0, weight: null }, { status: 'IN_PROGRESS', progress: 40, weight: 0, planned_start_date: '2026-09-01', planned_end_date: '2026-09-05' }, { status: 'IN_PROGRESS', progress: 20, weight: 1, planned_start_date: '2026-09-01', planned_end_date: '2026-10-01' }], [{ status: 'NOT_STARTED', milestone_date: '2026-10-07' }], today);
  assert.equal(g.planned_progress, 100); assert.equal(g.progress, 10); assert.equal(g.variance, -90);
  assert.deepEqual(g.planned_basis, { dated: 2, tasks: 3 });
  assert.equal(g.overdue_tasks, 2); assert.equal(g.overdue_milestones, 1); assert.equal(g.max_overdue_days, 35);   // 2026-09-05 → 10-10
  // nothing dated → planned/variance null (UI shows "-"), never a fake number
  const h = scheduleFigures([{ status: 'IN_PROGRESS', progress: 30, weight: 1 }], [], today);
  assert.equal(h.planned_progress, null); assert.equal(h.variance, null); assert.equal(h.progress, 30);
  assert.equal(scheduleFigures([], [], today).progress, 0);
});

/* ---------- API: the same numbers reach the project GET (What’s Next · Overview · header KPI) ---------- */
test('GET project: wbs stats carry planned/actual/variance/overdue figures; header KPI wbs_progress equals wbs.progress', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'lp@x.com', '진척');
  await mkWbs(A, { item_type: 'TASK', title: '완료', status: 'COMPLETED', weight: 1, planned_start_date: day(-20), planned_end_date: day(-10) });
  await mkWbs(A, { item_type: 'TASK', title: '지연', status: 'IN_PROGRESS', progress: 20, weight: 1, planned_start_date: day(-15), planned_end_date: day(-3) });
  await mkWbs(A, { item_type: 'TASK', title: '미래', weight: 2, planned_start_date: day(10), planned_end_date: day(20) });
  await mkWbs(A, { item_type: 'TASK', title: '일정 없음' });
  await mkWbs(A, { item_type: 'MILESTONE', title: '지난 MS', milestone_date: day(-1) });
  const g = (await A.c('GET', A.purl)).json;
  const w = g.wbs;
  assert.equal(w.tasks, 4); assert.equal(w.tasks_without_dates, 1);
  assert.equal(w.planned_progress, Math.round((100 * 1 + 100 * 1 + 0 * 2) / 4));          // dated tasks only, weighted → 50
  assert.equal(w.progress, Math.round((100 + 20 + 0 + 0) / 5));                              // weights 1,1,2,1 → 24
  assert.equal(w.variance, w.progress - w.planned_progress);
  assert.deepEqual(w.planned_basis, { dated: 3, tasks: 4 });
  assert.equal(w.overdue_tasks, 1); assert.equal(w.overdue_milestones, 1); assert.equal(w.max_overdue_days, 3);
  assert.equal(w.milestones, 1); assert.equal(w.milestones_completed, 0);
  assert.equal(g.kpis.wbs_progress, w.progress);
  // SCHEDULE-phase guidance uses the action-oriented CTA names (no "WBS로 이동")
  await A.c('POST', `${A.purl}/phases/${g.phases.find((p) => p.phase_key === 'SCHEDULE').id}/activate`, { reason: 'MANUAL' });
  const q = (await A.c('GET', A.purl)).json.guidance;
  assert.equal(q.rule, 'WBS_PLAN'); assert.equal(q.primary_action.label, '담당자와 일정 입력하기'); assert.equal(q.secondary_action.label, '전체 WBS 보기');
  server.close();
});
