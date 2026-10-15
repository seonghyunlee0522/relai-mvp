/* Demo findings fix round (recorded demo 01→07): 완료보고서 planned 오픈일 from the 01 key date milestone, a closed project's 07 reads ✓,
 * test-raised issues stay out of 04 이슈 관리, checklist activities complete the same way, the same person once in the pickers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { activityStates } from '../activities.js';
import { DEFAULT_PHASES, CHECKLIST_TEMPLATES } from '../templates/default-phases.js';
import { isMemberStakeholder } from '../wbs-skeleton.js';
import { buildCompletionData, completionSections } from '../reports.js';
import { goLiveMilestone } from '../golive.js';

const stepsOf = (key) => DEFAULT_PHASES.find((p) => p.key === key).steps.map((s, i) => ({ id: `s${i}`, step_key: s.key, title: s.title, description: s.description, completion_criteria: s.completion_criteria, importance: s.importance, is_required: s.is_required, status: 'TODO', note: '' }));

test('fix 1: a 01 key date naming the 오픈 becomes the go-live milestone → 완료보고서 §1 has the planned 오픈일', async () => {
  const { db, server, client } = await boot();
  try {
    const A = await setup(client, 'df1@x.com');
    await A.c('PUT', `${A.purl}/definition`, { key_dates: [{ title: '착수 보고', date: '2026-11-05' }, { title: '서비스 오픈', date: '2027-03-31' }] });
    assert.equal((await A.c('POST', `${A.wbs}/milestones/from-key-dates`, {})).status < 300, true);
    const ms = await db.all(`SELECT title, lifecycle_phase FROM wbs_items WHERE project_id = ? AND item_type = 'MILESTONE' ORDER BY title`, [A.p.id]);
    assert.deepEqual(ms.map((m) => [m.title, m.lifecycle_phase]), [['서비스 오픈', 'TRANSITION_GO_LIVE'], ['착수 보고', null]]);
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [A.p.id]);
    const d = await buildCompletionData(db, project, { goLive: { date: '2027-04-02' } });
    assert.equal(String(d.overview.open_planned).slice(0, 10), '2027-03-31');
    const text = completionSections(d).overview || JSON.stringify(completionSections(d));
    assert.doesNotMatch(String(text), /최초 계획 오픈일 기록 없음/);
    // a milestone made before the tag (title only, untagged) is still found; the tagged one wins over it
    await db.run(`UPDATE wbs_items SET lifecycle_phase = NULL WHERE project_id = ? AND title = '서비스 오픈'`, [A.p.id]);
    assert.equal((await goLiveMilestone(db, A.p.id)).title, '서비스 오픈');
    await A.c('POST', A.wbs, { item_type: 'MILESTONE', title: '오픈 리허설', milestone_date: '2027-03-01', lifecycle_phase: 'TRANSITION_GO_LIVE' });
    assert.equal((await goLiveMilestone(db, A.p.id)).title, '오픈 리허설');
  } finally { server.close(); }
});

test('fix 2: after 종료 (status COMPLETED) the current phase reads ✓ (done), not the blue current dot', async () => {
  const { db, server, client } = await boot();
  try {
    const A = await setup(client, 'df2@x.com');
    let G = (await A.c('GET', A.purl)).json;
    assert.equal(G.phases.find((p) => p.is_current).display_state, 'cur');
    await db.run(`UPDATE projects SET status = 'COMPLETED' WHERE id = ?`, [A.p.id]);
    G = (await A.c('GET', A.purl)).json;
    const cur = G.phases.find((p) => p.is_current);
    assert.equal(cur.display_state, 'done');
  } finally { server.close(); }
});

test('fix 3: an open issue raised from a failed test counts in 05 결함 조치, not 04 이슈 관리', () => {
  const ctx = (issues) => ({ pid: 'p1', stats: { issues, wbs: {}, changes: {} }, definition: { sections: [] }, overdue_tasks: 0 });
  const iss = (is) => activityStates('DEVELOPMENT', stepsOf('DEVELOPMENT'), ctx(is)).find((a) => a.step_key === 'ISSUES');
  // one dev issue (resolved) + one open test defect → 04 stays 완료
  let a = iss({ total: 2, active: 1, critical: 0, blocked: 0, test_total: 1, test_active: 1, test_critical: 0, test_blocked: 0 });
  assert.equal(a.state, 'COMPLETED'); assert.match(a.text, /이슈 1건이 모두 해결/);
  // an open dev issue still keeps 04 in progress
  a = iss({ total: 3, active: 2, critical: 0, blocked: 0, test_total: 1, test_active: 1, test_critical: 0, test_blocked: 0 });
  assert.equal(a.state, 'IN_PROGRESS'); assert.match(a.text, /열린 이슈 1건/);
  // only test defects → 04 has no own issue: the manual 완료 처리 row (not orange)
  a = iss({ total: 1, active: 1, critical: 1, blocked: 0, test_total: 1, test_active: 1, test_critical: 1, test_blocked: 0 });
  assert.notEqual(a.state, 'IN_PROGRESS'); assert.equal(a.crit, false);
});

test('fix 4: every checklist activity completes itself when all items are ticked (오픈 · 운영 인수 keep their own dialog, 종료 = 완료보고서)', () => {
  for (const ph of DEFAULT_PHASES) {
    const steps = stepsOf(ph.key).filter((s) => CHECKLIST_TEMPLATES[s.step_key]);
    if (!steps.length) continue;
    const checklists = Object.fromEntries(steps.map((s) => [s.id, { total: 3, done: 3 }]));
    for (const a of activityStates(ph.key, steps, { pid: 'p1', stats: {}, checklists })) {
      if (a.step_key === 'CLOSE') continue;   // 종료 정리 = 완료보고서 확정 (data, not the checklist)
      const own = (a.step_key === 'GO_LIVE' && ph.key === 'TRANSITION_GO_LIVE') || (a.step_key === 'HANDOVER' && ph.key === 'OPERATIONS');
      assert.equal(a.state, own ? 'IN_PROGRESS' : 'COMPLETED', `${ph.key}.${a.step_key}`);
      if (!own) assert.equal(a.cta, null, `${a.step_key}: no 완료 처리 left`);
    }
  }
});

test('fix 6: a stakeholder who is a workspace member is recognised despite a title word / role in the name', () => {
  const m = [{ name: '김하늘 PM', email: 'pm@x.com' }];
  assert.equal(isMemberStakeholder({ name: '김하늘', role: '수행 PM' }, m), true);
  assert.equal(isMemberStakeholder({ name: '김하늘 PM' }, m), true);
  assert.equal(isMemberStakeholder({ name: '김 하늘' }, [{ name: '김하늘' }]), true);
  assert.equal(isMemberStakeholder({ name: '이수진', email: 'PM@x.com' }, m), true, 'email wins');
  assert.equal(isMemberStakeholder({ name: '김하늘' }, [{ name: '김하늘 팀원2' }]), false);
  assert.equal(isMemberStakeholder({ name: '박민수', role: 'PM' }, m), false);
});

test('fix 5: CR 내부 처리자 left empty names the OWNER/ADMIN members, not the role alone', async () => {
  const { approverDefault } = await import('../../public/app/shared/owner-picker.js');
  assert.equal(approverDefault([{ name: '김하늘', role: 'OWNER' }, { name: '박개발', role: 'MEMBER' }]), '김하늘 (소유자·관리자)');
  assert.equal(approverDefault([{ name: 'A', role: 'OWNER' }, { name: 'B', role: 'ADMIN' }, { name: 'C', role: 'ADMIN' }, { name: 'D', role: 'ADMIN' }]), 'A, B, C 외 1명 (소유자·관리자)');
  assert.equal(approverDefault([]), '소유자·관리자');
});
