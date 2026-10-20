/* batch7 B4: 근무일 달력 (토·일·한국 공휴일 제외) and the rule-based date allocation the AI WBS planner uses (#15). Pure — no DB except the seed check. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOLIDAYS_KR } from '../calendar/holidays-kr.js';
import { isWorkday, workdaysBetween, addWorkdays, snapToWorkday, FALLBACK, holidayMap } from '../calendar/workdays.js';
import { allocateSchedule, inferPlanPhase, sameAsNode, FIXED_NODES } from '../../public/app/shared/wbs-structure.js';
import { testDb } from './helpers.js';

test('holidays: 2026–2027 seed in schema.sql matches holidays-kr.js; DB table is seeded and read back', async () => {
  const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const [d, n] of HOLIDAYS_KR) assert.ok(sql.includes(`('${d}', '${n}', 'PUBLIC'`), `${d} ${n} seeded`);
  for (const d of ['2026-02-17', '2026-05-25', '2026-06-03', '2026-10-05', '2026-12-25', '2027-02-08', '2027-09-15', '2027-12-27']) assert.ok(FALLBACK.has(d), d);
  const db = await testDb();
  const m = await holidayMap(db, '2026-12-01', '2026-12-31');
  assert.deepEqual([...m], [['2026-12-25', '성탄절']]);
});

test('workdays: weekends and holidays excluded; inclusive count; add / snap', () => {
  assert.equal(isWorkday('2026-12-25'), false); assert.equal(isWorkday('2026-12-26'), false); assert.equal(isWorkday('2026-12-24'), true);
  assert.equal(workdaysBetween('2026-12-21', '2026-12-27'), 4, 'Mon–Sun with 성탄절 Fri → 4');
  assert.equal(workdaysBetween('2026-12-28', '2026-12-28'), 1); assert.equal(workdaysBetween('2026-12-29', '2026-12-28'), 0);
  assert.equal(workdaysBetween('2026-09-21', '2026-09-30'), 6, '추석 연휴 9/24–9/25 (Thu–Fri) out');
  assert.equal(snapToWorkday('2026-12-25'), '2026-12-28'); assert.equal(snapToWorkday('2026-12-25', -1), '2026-12-24');
  assert.equal(addWorkdays('2026-12-24', 1), '2026-12-28'); assert.equal(addWorkdays('2026-12-28', -1), '2026-12-24'); assert.equal(addWorkdays('2027-02-04', 1), '2027-02-09', '설날 2/5–2/8');
});

test('allocation (#15 AC): project 2026-11-02 ~ 2027-03-31 → every date a workday, last end ≤ 2027-03-31; 12/25 not counted; phases in the base ratios', () => {
  const items = [
    { temp_id: 'K', parent_temp_id: null, item_type: 'TASK', title: '착수보고회', project_area: 'PROJECT_MANAGEMENT', planned_duration_days: 1 },
    { temp_id: 'D', parent_temp_id: null, item_type: 'TASK', title: '분석/설계', project_area: 'ANALYSIS_DESIGN' },
    { temp_id: 'D1', parent_temp_id: 'D', item_type: 'TASK', title: '화면 설계', project_area: 'ANALYSIS_DESIGN', planned_duration_days: 10 },
    { temp_id: 'D2', parent_temp_id: 'D', item_type: 'TASK', title: 'DB 설계', project_area: 'ANALYSIS_DESIGN', planned_duration_days: 5 },
    ...Array.from({ length: 12 }, (_, i) => ({ temp_id: `F${i}`, parent_temp_id: null, item_type: 'TASK', title: `REQ-${i} 구현`, project_area: 'FUNCTIONAL_DEVELOPMENT', planned_duration_days: 5 })),
    { temp_id: 'T', parent_temp_id: null, item_type: 'TASK', title: '테스트 계획', project_area: 'OTHER', planned_duration_days: null },
    { temp_id: 'O', parent_temp_id: null, item_type: 'MILESTONE', title: '오픈', project_area: 'STABILIZATION' },
  ];
  const r = allocateSchedule({ items, start: '2026-11-02', end: '2027-03-31', hol: FALLBACK });
  assert.equal(r.ok, true); assert.equal(r.workdays, workdaysBetween('2026-11-02', '2027-03-31'));
  assert.equal(r.phases.map((p) => p.workdays).reduce((a, b) => a + b, 0), r.workdays, 'phases use exactly the project workdays');
  assert.deepEqual(r.phases.map((p) => p.title), ['착수', '요구사항 정의', '분석·설계', '구현', '시험', '전환·오픈']);
  assert.equal(r.phases.at(-1).end, '2027-03-31'); assert.equal(r.overrun, false);
  for (const [id, d] of Object.entries(r.dates)) for (const v of Object.values(d)) { assert.ok(isWorkday(v), `${id} ${v} is a workday`); assert.ok(v <= '2027-03-31'); }
  assert.equal(r.dates.D, undefined, 'groups get no dates (roll-up)');
  assert.ok(r.dates.D1.planned_end_date < r.dates.D2.planned_start_date || r.dates.D1.planned_end_date === r.dates.D2.planned_start_date, 'sequential inside the phase');
  const dev = r.phases.find((p) => p.plan === 'DEVELOPMENT'); assert.ok(dev.holidays.some((h) => h.day === '2026-12-25' && h.name === '성탄절') || !(dev.start <= '2026-12-25' && dev.end >= '2026-12-25'));
  const t = r.dates.T; const ts = r.phases.find((p) => p.plan === 'TESTING'); assert.equal(inferPlanPhase(items.at(-2)), 'TESTING', "'테스트 계획' → 시험"); assert.ok(t.planned_start_date >= ts.start && t.planned_end_date <= ts.end);
  assert.equal(r.dates.O.milestone_date, r.phases.at(-1).end, 'milestone on its phase end');
  // a task spanning 12/25 counts one workday less
  const span = Object.values(r.dates).find((d) => d.planned_start_date && d.planned_start_date <= '2026-12-25' && d.planned_end_date >= '2026-12-25');
  if (span) assert.equal(workdaysBetween(span.planned_start_date, span.planned_end_date), workdaysBetween(span.planned_start_date, span.planned_end_date, new Set()) - 1);
  // user override of one phase: kept, others share the rest
  const o = allocateSchedule({ items, start: '2026-11-02', end: '2027-03-31', hol: FALLBACK, phaseWorkdays: { TESTING: 10 } });
  assert.equal(o.phases.find((p) => p.plan === 'TESTING').workdays, 10); assert.equal(o.phases.at(-1).end, '2027-03-31');
  // 데이터 이관 takes its share from 구현
  const dm = allocateSchedule({ items: [...items, { temp_id: 'M', parent_temp_id: null, item_type: 'TASK', title: '데이터 이관', project_area: 'DATA_MIGRATION' }], start: '2026-11-02', end: '2027-03-31', hol: FALLBACK });
  assert.deepEqual(dm.phases.map((p) => p.title), ['착수', '요구사항 정의', '분석·설계', '데이터 이관', '구현', '시험', '전환·오픈']);
  assert.equal(allocateSchedule({ items, start: null, end: '2027-03-31' }).ok, false);
});

test('phase inference and node aliases', () => {
  assert.equal(inferPlanPhase({ phase: 'TESTING', title: 'x' }), 'TESTING');
  assert.equal(inferPlanPhase({ project_area: 'PROJECT_MANAGEMENT', title: '주간보고' }), 'INITIATION');
  assert.equal(inferPlanPhase({ title: 'REQ-001 요구사항 구현' }), 'DEVELOPMENT');
  assert.equal(inferPlanPhase({ title: '요구사항 정의서 작성' }), 'REQUIREMENTS');
  assert.equal(inferPlanPhase({ title: '무엇인지 모름' }), 'DEVELOPMENT');
  assert.equal(sameAsNode('분석/설계'), 'ANALYSIS_DESIGN'); assert.equal(sameAsNode('테스트'), 'TESTING'); assert.equal(sameAsNode('설계', { strict: true }), null); assert.equal(sameAsNode('분석·설계', { strict: true }), 'ANALYSIS_DESIGN');
  assert.equal(FIXED_NODES.filter((n) => !n.optional).length, 7);   // P2 (Jim prod 10-21 #6): + 07 운영
});
