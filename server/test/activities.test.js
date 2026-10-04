/* Lifecycle V2 activity engine (pure rules): derived states, manual marks, REQUIRED gate, CTA conventions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityStates, activitySummary, resolveState } from '../activities.js';
import { DEFAULT_PHASES, PHASE_KEYS } from '../templates/default-phases.js';

const stepsOf = (key) => DEFAULT_PHASES.find((p) => p.key === key).steps.map((s, i) => ({ id: `s${i}`, step_key: s.key, title: s.title, description: s.description, completion_criteria: s.completion_criteria, importance: s.importance, is_required: s.is_required, linked_feature_type: s.linked_feature_type, status: 'TODO', note: '' }));
const ctx = (stats = {}, extra = {}) => ({ pid: 'p1', stats, definition: { sections: [] }, overdue_tasks: 0, ...extra });

test('template: 7 lifecycle phases, no legacy keys, 검수 first in 06, every phase has a REQUIRED gate', () => {
  assert.deepEqual(PHASE_KEYS, ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS']);
  for (const p of DEFAULT_PHASES) { assert.ok(p.steps.some((s) => s.importance === 'REQUIRED'), p.key); assert.ok(p.steps.every((s) => s.is_required === (s.importance === 'REQUIRED' ? 1 : 0))); }
  assert.equal(DEFAULT_PHASES[5].steps[0].key, 'ACCEPTANCE');
  for (const bad of ['SCHEDULE', 'EXECUTION', 'ACCEPTANCE', 'LAUNCH']) assert.ok(!PHASE_KEYS.includes(bad), bad);
});

test('REQUIREMENTS: states follow the data (empty → in progress → completed), dependent rows carry no duplicate CTA', () => {
  let a = activityStates('REQUIREMENTS', stepsOf('REQUIREMENTS'), ctx({ requirements: { total: 0 } }));
  assert.ok(a.every((x) => x.state === 'NOT_STARTED'));
  assert.equal(a[0].cta.label, '요구사항 입력 시작 →'); assert.equal(a[1].cta, null, 'CLASSIFY waits for COLLECT');
  a = activityStates('REQUIREMENTS', stepsOf('REQUIREMENTS'), ctx({ requirements: { total: 4, type_unspecified: 1, priority_unspecified: 0, scope_undecided: 2, in_scope: 2, in_scope_confirmed: 1, out_of_scope: 0, non_functional: 0 } }));
  const by = Object.fromEntries(a.map((x) => [x.step_key, x]));
  assert.equal(by.COLLECT.state, 'COMPLETED'); assert.equal(by.CLASSIFY.state, 'IN_PROGRESS'); assert.equal(by.CLASSIFY.cta.href, '/app/projects/p1/requirements?type=UNSPECIFIED');
  assert.equal(by.PRIORITIZE.state, 'COMPLETED'); assert.equal(by.SCOPE_CHECK.state, 'IN_PROGRESS'); assert.equal(by.CONFIRM.state, 'IN_PROGRESS'); assert.equal(by.INTERFACE.state, 'NOT_STARTED');
  for (const x of a) if (x.cta) { assert.ok(x.cta.label.endsWith('→')); assert.ok(!/로 이동/.test(x.cta.label)); }
  const s = activitySummary(a);
  assert.deepEqual(s, { total: 6, completed: 2, skipped: 0, required_total: 4, required_done: 1, required_open: 3, gate_met: false });
});

test('manual marks: COMPLETED/SKIPPED win over derived state; SKIPPED counts toward the gate; a note means in progress', () => {
  const steps = stepsOf('TRANSITION_GO_LIVE');
  steps[1].status = 'COMPLETED'; steps[2].status = 'SKIPPED'; steps[3].note = '교육 일정 10/20';
  const a = activityStates('TRANSITION_GO_LIVE', steps, ctx({ acceptances: { total: 1, accepted: 1 } }));
  const by = Object.fromEntries(a.map((x) => [x.step_key, x]));
  assert.equal(by.ACCEPTANCE.state, 'COMPLETED'); assert.equal(by.ACCEPTANCE.derived, 'COMPLETED');
  assert.equal(by.CUTOVER_PLAN.state, 'COMPLETED'); assert.equal(by.CUTOVER_PLAN.derived, null);
  assert.equal(by.DATA_MIGRATION.state, 'SKIPPED'); assert.equal(by.TRAINING.state, 'IN_PROGRESS');
  assert.equal(resolveState({ status: 'TODO', note: '' }, 'IN_PROGRESS'), 'IN_PROGRESS');
  assert.equal(resolveState({ status: 'COMPLETED', note: '' }, 'NOT_STARTED'), 'COMPLETED');
  const s = activitySummary(a); assert.equal(s.gate_met, false); assert.equal(s.required_open, 1, 'GO_LIVE still open');
});

test('DEVELOPMENT / TESTING: red flags (overdue, fail, blocked) are IN_PROGRESS + crit; WBS by_phase narrows 구현 to DEVELOPMENT tasks', () => {
  let a = activityStates('DEVELOPMENT', stepsOf('DEVELOPMENT'), ctx({ wbs: { tasks: 6, tasks_completed: 2, in_progress: 1, progress: 40, by_phase: { DEVELOPMENT: 4, TESTING: 2 }, by_phase_completed: { DEVELOPMENT: 4 } }, issues: { total: 2, active: 1, blocked: 1 }, changes: { total: 0 } }, { overdue_tasks: 1 }));
  let by = Object.fromEntries(a.map((x) => [x.step_key, x]));
  assert.equal(by.PROGRESS.state, 'COMPLETED', 'all DEVELOPMENT-tagged tasks done');
  assert.equal(by.DELAYS.state, 'IN_PROGRESS'); assert.equal(by.DELAYS.crit, true);
  assert.equal(by.ISSUES.state, 'IN_PROGRESS'); assert.equal(by.ISSUES.crit, true); assert.equal(by.ISSUES.cta.href, '/app/projects/p1/issues?status=BLOCKED');
  assert.equal(by.CHANGES.state, 'NOT_STARTED'); assert.equal(by.DECISIONS.state, 'NOT_STARTED');
  a = activityStates('TESTING', stepsOf('TESTING'), ctx({ tests: { total: 3, executed: 3, last_fail: 1, in_scope: 3, in_scope_tested: 3, in_scope_untested: 0, coverage: 100 } }));
  by = Object.fromEntries(a.map((x) => [x.step_key, x]));
  assert.equal(by.TEST_PLAN.state, 'COMPLETED'); assert.equal(by.RUN.state, 'COMPLETED'); assert.equal(by.DEFECTS.state, 'IN_PROGRESS'); assert.equal(by.DEFECTS.crit, true);
});
