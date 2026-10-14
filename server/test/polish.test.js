/* Polish batch (hive research/relai-polish-batch.md, K1–K32): K32 migration 39 (legacy hand-✓ without a record → TODO) and the K items that change server output. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { migrations, LEGACY_RESET_NOTE } from '../migrations.js';
import { scheduleLines } from '../reports.js';
import { projectGuidance } from '../guidance.js';
import { testFromRequirement } from '../testing.js';
import { coverLines } from '../doc-export.js';
import { planVersion } from '../charter-export.js';
import { lessonsBody } from '../reports.js';

const g = async (A) => (await A.c('GET', A.purl)).json;
const stepId = async (db, pid, phase, key) => (await db.get(`SELECT s.id FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND p.phase_key = ? AND s.step_key = ?`, [pid, phase, key])).id;
const LEGACY = [['TRANSITION_GO_LIVE', 'ACCEPTANCE'], ['TRANSITION_GO_LIVE', 'GO_LIVE'], ['OPERATIONS', 'HANDOVER'], ['OPERATIONS', 'CLOSE']];
const handMark = async (db, pid, note = '') => { for (const [ph, k] of LEGACY) await db.run(`UPDATE project_steps SET status = 'COMPLETED', completed_at = now(), note = ? WHERE id = ?`, [note, await stepId(db, pid, ph, k)]); };
const statusOf = async (db, pid) => Object.fromEntries(await Promise.all(LEGACY.map(async ([ph, k]) => [k, (await db.get('SELECT status, note FROM project_steps WHERE id = ?', [await stepId(db, pid, ph, k)]))])));

/* ---------- K32 migration 39 ---------- */
test('K32 migration 39: legacy hand-✓ 검수/오픈/인수/종료 with no record → TODO + note on live projects; records, 외부 완료보고서 사유 and COMPLETED projects untouched; idempotent', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);                                        // live, no records
  const B = await setup(client, 'b@x.com');                            // live, every record present
  const C = await setup(client, 'c@x.com');                            // closed before Phase 7
  for (const X of [A, B, C]) await handMark(db, X.p.id);
  await db.run(`UPDATE project_steps SET note = '[외부 완료보고서] 고객사 양식 · 2026-09-01 · 홍길동' WHERE id = ?`, [await stepId(db, B.p.id, 'OPERATIONS', 'CLOSE')]);
  await db.run('INSERT INTO project_definitions (project_id, updated_by) VALUES (?, ?) ON CONFLICT (project_id) DO NOTHING', [B.p.id, B.uid]);
  await db.run(`UPDATE project_definitions SET go_live = '{"date":"2026-09-01","carryovers":[]}', handover = '{"date":"2026-09-10","receiver_stakeholder_id":"s1"}' WHERE project_id = ?`, [B.p.id]);
  await db.run(`INSERT INTO acceptances (id, project_id, sequence_number, display_id, title, status, customer_approval, created_by) VALUES ('acc-b', ?, 1, 'ACC-001', '1차 검수', 'ACCEPTED', '{"approver_name":"오지현","date":"2026-09-01","method":"SIGNED","evidence":"서명본"}', ?)`, [B.p.id, B.uid]);
  await db.run(`UPDATE projects SET status = 'COMPLETED', closed_on = '2026-09-30' WHERE id = ?`, [C.p.id]);
  const trBefore = Number((await db.get('SELECT COUNT(*) AS n FROM phase_transitions')).n);

  const m39 = migrations.find((m) => m.version === 39); assert.ok(m39);
  await m39.up(db); await m39.up(db);

  const a = await statusOf(db, A.p.id);
  for (const k of ['ACCEPTANCE', 'GO_LIVE', 'HANDOVER', 'CLOSE']) { assert.equal(a[k].status, 'TODO', k); assert.equal(a[k].note, LEGACY_RESET_NOTE, k); }
  const b = await statusOf(db, B.p.id);
  for (const k of ['ACCEPTANCE', 'GO_LIVE', 'HANDOVER', 'CLOSE']) assert.equal(b[k].status, 'COMPLETED', k);
  const c = await statusOf(db, C.p.id);
  for (const k of ['ACCEPTANCE', 'GO_LIVE', 'HANDOVER', 'CLOSE']) { assert.equal(c[k].status, 'COMPLETED', k); assert.equal(c[k].note, '', k); }
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM phase_transitions')).n), trBefore);
  // A PM note already on the step is kept (the reset note is only added to an empty one)
  await handMark(db, A.p.id, 'PM 메모'); await m39.up(db);
  assert.equal((await statusOf(db, A.p.id)).HANDOVER.note, 'PM 메모');
  // the reset rows now read as not done, so 07 종료 is gated again
  const G = await g(A);
  const close = G.phases.find((p) => p.phase_key === 'OPERATIONS').steps.find((s) => s.step_key === 'CLOSE');
  assert.notEqual(close.state, 'COMPLETED');
  server.close();
});

/* ---------- K12 weekly report 일정: net change against the first plan ---------- */
test('K12 scheduleLines: a push then a pull-back in the same week → each line shows 최초 계획 대비, total is the net change', () => {
  const L = scheduleLines([
    { wbs_id: 'w1', display_id: '1.1', title: '로그인', before: '2026-10-10', after: '2026-10-20', days: 10, note: '지연', orig: '2026-10-10', cur: '2026-10-13' },
    { wbs_id: 'w2', display_id: '1.2', title: '목록', before: '2026-10-12', after: '2026-10-14', days: 2, note: '검토', orig: '2026-10-12', cur: '2026-10-14' },
  ]);
  assert.equal(L[0], '- 일정: 이번 주 일정 변경 2건 (최초 계획 대비 총 +5일)');
  assert.equal(L[1], '  - 1.1 로그인 · +10일 · 최초 계획 대비 +3일 · 지연');
  assert.equal(L[2], '  - 1.2 목록 · +2일 · 최초 계획 대비 +2일 · 검토');
});

/* ---------- K1 · K25 What's Next copy ---------- */
test('K1 approved definition edited → "변경 내용을 고객에게 다시 승인받으세요" + 승인 drawer CTA; K25 after 오픈 → "오픈 완료 · 운영 이관 N건" + next-phase CTA', () => {
  const g = (ctx) => projectGuidance({ project: { id: 'p1', workspace_id: 'w1' }, ...ctx });
  let r = g({ phase: { phase_key: 'INITIATION', name: '착수', sequence: 1 }, definition: { progress: { done: 5, total: 5 }, needs_review: ['SCOPE'], initiation_gate: { approval: { status: 'COMPLETED' } } } });
  assert.equal(r.title, '변경 내용을 고객에게 다시 승인받으세요'); assert.equal(r.primary_action.href, '/app/projects/p1/definition?activity=APPROVAL');
  r = g({ phase: { phase_key: 'INITIATION', name: '착수', sequence: 1 }, definition: { progress: { done: 5, total: 5 }, needs_review: ['SCOPE'], initiation_gate: { approval: { status: 'TODO' } } } });
  assert.equal(r.rule, 'INIT_REVIEW');   // never approved → re-check, not re-approve
  const TR = { phase: { phase_key: 'TRANSITION_GO_LIVE', name: '전환 및 오픈', sequence: 6, steps: [{ step_key: 'ACCEPTANCE', state: 'COMPLETED' }, { step_key: 'GO_LIVE', state: 'COMPLETED' }] }, next_phase: { name: '운영 및 유지보수', sequence: 7 } };
  r = g({ ...TR, stats: { acceptances: { total: 1, accepted: 1 } }, go_live: { date: '2026-10-10', carryovers: [{}, {}] } });
  assert.equal(r.title, '오픈 완료 · 운영 이관 2건'); assert.equal(r.primary_action.href, '/app/projects/p1?move=next');
  r = g({ ...TR, phase: { ...TR.phase, steps: [TR.phase.steps[0]] }, stats: { acceptances: { total: 1, accepted: 1 } } });
  assert.match(r.title, /검수가 승인되었습니다/);   // before 오픈: unchanged
});

/* ---------- K2 · K7 · K30 copy ---------- */
test('K2 stale-approval footer says 재승인 전까지는; K7 no doubled 확인; K30 empty 교훈 → 없음', () => {
  assert.match(coverLines('t', 'n', [], planVersion({ status: 'REAPPROVAL' }).footer).join('\n'), /승인 후 변경된 초안\*\* — 재승인 전까지는/);
  assert.match(coverLines('t', 'n', [], planVersion({ status: 'TODO' }).footer).join('\n'), /고객 승인 전에는/);
  assert.equal(testFromRequirement({ display_id: 'REQ-005', title: '입고 확인', criteria: [], description: '' }).title, 'REQ-005 입고 확인');
  assert.equal(testFromRequirement({ display_id: 'REQ-006', title: '입고 등록', criteria: [], description: '' }).title, 'REQ-006 입고 등록 확인');
  assert.equal(lessonsBody([{ label: '아쉬운 점', body: '' }]), '**아쉬운 점**\n없음');
});
