/* Phase 9: Project Health rules, attention priority, upcoming 7 days, weekly report lifecycle, access control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tx } from '../db.js';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { scheduleHealth, scopeHealth, qualityHealth, changeHealth, riskHealth, overallHealth, evaluateHealth, HEALTH_RULES, STATUS } from '../health.js';
import { attentionAll, upcomingDates } from '../metrics.js';
import { defaultPeriod, parsePeriod, toPlainText } from '../reports.js';

async function boot() {
  const db = await testDb();
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json };
    };
  };
  return { db, server, client };
}
const ymd = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function setup(client, email) {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, { name: 'P', client_name: '테스트 고객사', planned_start_date: '2026-09-01', planned_end_date: '2027-02-28' })).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  const post = async (path, b, key) => { const r = await c('POST', `${purl}/${path}`, b); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.json)}`); return r.json[key]; };
  return { c, w, uid, p, purl,
    req: async (b) => (await post('requirements', { scope: 'IN_SCOPE', ...b }, 'requirement')), wbs: async (b) => (await post('wbs', { item_type: 'TASK', ...b }, 'item')),
    cr: async (b) => (await post('changes', b, 'change')), issue: async (b) => (await post('issues', b, 'issue')), risk: async (b) => (await post('risks', b, 'risk')),
    tc: async (b) => (await post('tests', b, 'test')), acc: async (b) => (await post('acceptances', b, 'acceptance')) };
}
const facts = (o = {}) => ({ phase: 'EXECUTION',
  wbs: { tasks: 5, tasks_dated: 5, milestones: 1, milestones_dated: 1, overdue_tasks: 0, overdue_milestones: 0, ...o.wbs },
  req: { in_scope: 4, confirmed: 4, unconfirmed: 0, reviewing: 0, confirmed_unlinked: 0, ...o.req },
  chg: { total: 0, under_review: 0, approved_unimplemented: 0, approved_schedule_days: 0, ...o.chg },
  iss: { open: 0, critical_open: 0, high_open: 0, overdue: 0, ...o.iss }, tst: { total: 3, last_fail: 0, ...o.tst }, acc: { total: 1, rework: 0, overdue: 0, ...o.acc },
  rsk: { total: 2, active: 2, critical: 0, high: 0, review_overdue: 0, ...o.rsk }, ...(o.phase ? { phase: o.phase } : {}) });

test('health rules: schedule / scope / quality / change / risk — each status reachable, every status has a reason', () => {
  // schedule
  assert.equal(scheduleHealth(facts({ wbs: { tasks_dated: 0, milestones_dated: 0 } })).status, STATUS.UNKNOWN);
  assert.equal(scheduleHealth(facts()).status, STATUS.GOOD);
  let h = scheduleHealth(facts({ wbs: { overdue_tasks: 2, overdue_milestones: 1 } })); assert.equal(h.status, STATUS.WARNING); assert.deepEqual(h.reasons, ['종료 예정일이 지난 WBS 2건', '지난 마일스톤 1건']);
  assert.equal(scheduleHealth(facts({ wbs: { overdue_tasks: HEALTH_RULES.schedule.crit_tasks_min } })).status, STATUS.CRITICAL);
  assert.equal(scheduleHealth(facts({ wbs: { overdue_milestones: 2 } })).status, STATUS.CRITICAL);
  // scope
  assert.equal(scopeHealth(facts({ req: { in_scope: 0 } })).status, STATUS.UNKNOWN);
  assert.equal(scopeHealth(facts()).status, STATUS.GOOD);
  h = scopeHealth(facts({ req: { unconfirmed: 1 } })); assert.equal(h.status, STATUS.WARNING); assert.match(h.reasons[0], /미확정 요구사항 1건/);
  h = scopeHealth(facts({ req: { confirmed: 10, confirmed_unlinked: 3 } })); assert.equal(h.status, STATUS.CRITICAL); assert.match(h.reasons.at(-1), /30%/);
  assert.equal(scopeHealth(facts({ req: { confirmed: 10, confirmed_unlinked: 2 } })).status, STATUS.WARNING);
  assert.equal(scopeHealth(facts({ chg: { approved_unimplemented: 3 } })).status, STATUS.CRITICAL);
  assert.equal(scopeHealth(facts({ chg: { approved_unimplemented: 1 } })).status, STATUS.WARNING);
  // quality
  assert.equal(qualityHealth(facts({ iss: { open: 0 }, tst: { total: 0 }, acc: { total: 0 } })).status, STATUS.UNKNOWN);
  assert.equal(qualityHealth(facts()).status, STATUS.GOOD);
  assert.equal(qualityHealth(facts({ iss: { open: 1, critical_open: 1 } })).status, STATUS.CRITICAL);
  assert.equal(qualityHealth(facts({ iss: { open: 1, high_open: 1 } })).status, STATUS.WARNING);
  assert.equal(qualityHealth(facts({ tst: { last_fail: 1 } })).status, STATUS.WARNING);
  assert.equal(qualityHealth(facts({ acc: { rework: 1 } })).status, STATUS.WARNING);
  assert.equal(qualityHealth(facts({ tst: { last_fail: 3 } })).status, STATUS.WARNING, 'many fails outside TESTING/ACCEPTANCE stays WARNING');
  assert.equal(qualityHealth(facts({ phase: 'TESTING', tst: { last_fail: 3 } })).status, STATUS.CRITICAL);
  // change
  assert.equal(changeHealth(facts()).status, STATUS.GOOD);
  assert.equal(changeHealth(facts({ chg: { total: 1, under_review: 1 } })).status, STATUS.WARNING);
  assert.equal(changeHealth(facts({ chg: { total: 3, approved_unimplemented: 3 } })).status, STATUS.CRITICAL);
  h = changeHealth(facts({ chg: { total: 1, approved_unimplemented: 1, approved_schedule_days: 20 } })); assert.equal(h.status, STATUS.CRITICAL); assert.match(h.reasons.at(-1), /예측치 아님/);
  // risk
  assert.equal(riskHealth(facts({ rsk: { total: 0, active: 0 } })).status, STATUS.UNKNOWN);
  assert.equal(riskHealth(facts()).status, STATUS.GOOD);
  assert.equal(riskHealth(facts({ rsk: { high: 1 } })).status, STATUS.WARNING);
  assert.equal(riskHealth(facts({ rsk: { review_overdue: 1 } })).status, STATUS.WARNING);
  assert.equal(riskHealth(facts({ rsk: { critical: 1 } })).status, STATUS.CRITICAL);
  // every result carries at least one reason
  for (const f of [facts(), facts({ wbs: { tasks_dated: 0, milestones_dated: 0 }, req: { in_scope: 0 }, rsk: { total: 0, active: 0 }, iss: { open: 0 }, tst: { total: 0 }, acc: { total: 0 } })])
    for (const d of Object.values(evaluateHealth(f).dimensions)) assert.ok(d.reasons.length >= 1, `${d.key} ${d.status} has a reason`);
});

test('overall health: CRITICAL > WARNING > GOOD, all-UNKNOWN → UNKNOWN, GOOD+UNKNOWN → GOOD with partial flag; no averaging', () => {
  const d = (...st) => Object.fromEntries(st.map((s, i) => [`d${i}`, { status: s }]));
  assert.deepEqual(overallHealth(d('GOOD', 'GOOD', 'CRITICAL', 'WARNING')), { status: 'CRITICAL', partial_unknown: false });
  assert.deepEqual(overallHealth(d('GOOD', 'WARNING', 'UNKNOWN')), { status: 'WARNING', partial_unknown: true });
  assert.deepEqual(overallHealth(d('GOOD', 'GOOD')), { status: 'GOOD', partial_unknown: false });
  assert.deepEqual(overallHealth(d('GOOD', 'UNKNOWN', 'UNKNOWN')), { status: 'GOOD', partial_unknown: true });
  assert.deepEqual(overallHealth(d('UNKNOWN', 'UNKNOWN')), { status: 'UNKNOWN', partial_unknown: false });
  // an empty project: 4 dimensions UNKNOWN, change GOOD (no CRs is a known fact) → GOOD with "일부 정보 부족"
  const all = evaluateHealth(facts({ wbs: { tasks_dated: 0, milestones_dated: 0 }, req: { in_scope: 0 }, rsk: { total: 0, active: 0 }, iss: { open: 0 }, tst: { total: 0 }, acc: { total: 0 } }));
  assert.equal(all.status, 'GOOD'); assert.equal(all.partial_unknown, true); assert.equal(all.dimensions.schedule.status_label, '정보 부족'); assert.equal(all.dimensions.schedule.hint, '일정 상태를 확인하려면 WBS 일정을 입력하세요.');
});

test('health + attention + upcoming from real data: computed, archived excluded, priority ladder, 7-day window, snapshot shape', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  // empty project → all unknown except change (GOOD: no CRs) → overall GOOD + partial
  let s = await A.c('GET', `${A.purl}/snapshot`); assert.equal(s.status, 200);
  assert.equal(s.json.health.dimensions.schedule.status, 'UNKNOWN'); assert.equal(s.json.health.dimensions.change.status, 'GOOD'); assert.equal(s.json.health.partial_unknown, true);
  assert.deepEqual(s.json.attention, []); assert.equal(s.json.attention_total, 0); assert.deepEqual(s.json.upcoming, []);
  // data
  const r1 = await A.req({ title: 'R1', status: 'CONFIRMED' }); await A.req({ title: 'R2', status: 'REVIEWING' });
  const w1 = await A.wbs({ title: 'Overdue task', planned_start_date: ymd(-20), planned_end_date: ymd(-3), status: 'IN_PROGRESS', progress: 50 });
  await A.wbs({ title: 'Starts soon', planned_start_date: ymd(2), planned_end_date: ymd(20) });
  await A.wbs({ title: 'Ends in 5 days', planned_start_date: ymd(-5), planned_end_date: ymd(5), status: 'IN_PROGRESS' });
  await A.wbs({ title: 'Far away', planned_start_date: ymd(30), planned_end_date: ymd(40) });
  const ms = await A.wbs({ item_type: 'MILESTONE', title: 'Past milestone', milestone_date: ymd(-1) });
  await A.wbs({ item_type: 'MILESTONE', title: 'Milestone in 3 days', milestone_date: ymd(3) });
  const archivedW = await A.wbs({ title: 'Archived overdue', planned_start_date: ymd(-20), planned_end_date: ymd(-10) });
  await A.c('POST', `${A.purl}/wbs/${archivedW.id}/archive`, {});
  const i1 = await A.issue({ title: 'Critical issue', severity: 'CRITICAL' });
  const i2 = await A.issue({ title: 'High overdue', severity: 'HIGH', due_date: ymd(-2) });
  await A.issue({ title: 'Medium due in 4 days', severity: 'MEDIUM', due_date: ymd(4) });
  const iArch = await A.issue({ title: 'Archived critical', severity: 'CRITICAL' }); await A.c('POST', `${A.purl}/issues/${iArch.id}/archive`, {});
  const k1 = await A.risk({ title: 'Critical risk', probability: 'HIGH', impact: 'HIGH' });
  await A.risk({ title: 'Review overdue low risk', probability: 'LOW', impact: 'LOW', review_date: ymd(-1) });
  await A.risk({ title: 'Review in 6 days', probability: 'LOW', impact: 'MEDIUM', review_date: ymd(6) });
  const t1 = await A.tc({ title: 'Fails' }); await A.c('POST', `${A.purl}/tests/${t1.id}/executions`, { result: 'FAIL' });
  const cr1 = await A.cr({ title: 'Approved CR' }); await A.c('PATCH', `${A.purl}/changes/${cr1.id}`, { schedule_impact_days: 3 }); await A.c('POST', `${A.purl}/changes/${cr1.id}/transition`, { action: 'submit' }); await A.c('POST', `${A.purl}/changes/${cr1.id}/transition`, { action: 'approve' });
  const cr2 = await A.cr({ title: 'Under review CR' }); await A.c('POST', `${A.purl}/changes/${cr2.id}/transition`, { action: 'submit' });
  const a1 = await A.acc({ title: 'Rework acc', requirements: [r1.id], due_date: ymd(7) }); await A.c('POST', `${A.purl}/acceptances/${a1.id}/transition`, { action: 'submit' });
  await A.c('POST', `${A.purl}/acceptances/${a1.id}/transition`, { action: 'rework', decision_note: '보완' });

  s = await A.c('GET', `${A.purl}/snapshot`);
  const H = s.json.health;
  assert.equal(H.status, 'CRITICAL');
  assert.equal(H.dimensions.schedule.status, 'WARNING'); assert.deepEqual(H.dimensions.schedule.reasons, ['종료 예정일이 지난 WBS 1건', '지난 마일스톤 1건']);
  assert.equal(H.dimensions.scope.status, 'CRITICAL'); assert.match(H.dimensions.scope.reasons.join(), /미확정 요구사항 1건.*WBS와 미연결.*100%/); // R2 unconfirmed; R1 confirmed-unlinked = 1/1 ≥ 30%
  assert.equal(H.dimensions.quality.status, 'CRITICAL'); assert.match(H.dimensions.quality.reasons.join(), /Critical Issue 1건/);
  assert.equal(H.dimensions.change.status, 'WARNING'); assert.equal(H.dimensions.risk.status, 'CRITICAL');
  // attention: ladder order, archived excluded, all kinds present
  const all = (await A.c('GET', `${A.purl}/attention`)).json;
  const kinds = all.items.map((i) => i.kind);
  assert.deepEqual(kinds.slice(0, 4), ['CRITICAL_ISSUE', 'CRITICAL_RISK', 'OVERDUE_HIGH_ISSUE', 'FAIL_TEST']);
  for (const k of ['REWORK_ACCEPTANCE', 'APPROVED_UNIMPLEMENTED_CHANGE', 'OVERDUE_WBS', 'OVERDUE_MILESTONE', 'CONFIRMED_UNLINKED_REQUIREMENT', 'REVIEW_OVERDUE_RISK', 'UNDER_REVIEW_CHANGE']) assert.ok(kinds.includes(k), k);
  assert.ok(kinds.indexOf('REWORK_ACCEPTANCE') < kinds.indexOf('APPROVED_UNIMPLEMENTED_CHANGE')); assert.ok(kinds.indexOf('OVERDUE_WBS') < kinds.indexOf('CONFIRMED_UNLINKED_REQUIREMENT')); assert.ok(kinds.indexOf('CONFIRMED_UNLINKED_REQUIREMENT') < kinds.indexOf('REVIEW_OVERDUE_RISK'));
  assert.ok(!all.items.some((i) => i.id === iArch.id || i.id === archivedW.id), 'archived rows never appear');
  assert.equal(all.items.find((i) => i.id === i1.id).href, `issues?sel=${i1.id}`); assert.equal(all.items.find((i) => i.id === k1.id).href, `issues?tab=risks&sel=${k1.id}`);
  assert.equal(s.json.attention.length, 7); assert.equal(s.json.attention_total, all.total); assert.ok(all.total > 7);
  for (let i = 1; i < all.items.length; i++) assert.ok(all.items[i - 1].priority <= all.items[i].priority);
  // upcoming: within 7 days only, dated only, sorted, href present
  const up = s.json.upcoming; const labels = up.map((u) => `${u.kind}:${u.title}`);
  assert.deepEqual(labels, ['WBS_START:Starts soon', 'MILESTONE:Milestone in 3 days', 'ISSUE_DUE:Medium due in 4 days', 'WBS_END:Ends in 5 days', 'RISK_REVIEW:Review in 6 days', 'ACCEPTANCE_DUE:Rework acc']);
  assert.ok(up.every((u) => u.date >= ymd(0) && u.date <= ymd(7) && u.href));
  assert.ok(!labels.some((l) => l.includes('Far away') || l.includes('Overdue')));
  // direct service calls match the API
  assert.equal((await attentionAll(db, A.p.id)).length, all.total); assert.equal((await upcomingDates(db, A.p.id, { days: 7 })).length, up.length);
  // access: other workspace member → 404 on health / attention / snapshot
  for (const path of ['health', 'attention', 'snapshot']) assert.equal((await B.c('GET', `${A.purl}/${path}`)).status, 404, path);
  // archived project: health still readable
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', `${A.purl}/health`)).status, 200);
  void w1; void ms; void i2; void tx;
  server.close();
});

test('weekly report: default period, generate (structured + sections + markdown), period-bounded completions, edit, finalize, reopen, copy text', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  // default period rule
  assert.deepEqual(defaultPeriod('2026-10-02'), { period_start: '2026-09-28', period_end: '2026-10-02' }); // Fri → Mon–Fri (today)
  assert.deepEqual(defaultPeriod('2026-09-30'), { period_start: '2026-09-28', period_end: '2026-09-30' }); // Wed → Mon–today
  assert.deepEqual(defaultPeriod('2026-10-03'), { period_start: '2026-09-28', period_end: '2026-10-03' }); // Sat → Mon–Sat (UX-010)
  assert.deepEqual(defaultPeriod('2026-10-04'), { period_start: '2026-09-28', period_end: '2026-10-04' }); // Sun → Mon–Sun
  assert.throws(() => parsePeriod({ period_start: '2026-10-05', period_end: '2026-10-01' }));
  assert.throws(() => parsePeriod({ period_start: 'x', period_end: '2026-10-01' }));
  // data with status changes "this week" (now) and some state
  const r1 = await A.req({ title: 'Req confirmed this week', status: 'DRAFT' }); await A.c('PATCH', `${A.purl}/requirements/${r1.id}`, { status: 'CONFIRMED' });
  await A.req({ title: 'Reviewing req', status: 'REVIEWING' });
  const w1 = await A.wbs({ title: 'Done task', planned_start_date: ymd(-10), planned_end_date: ymd(-1) }); await A.c('PATCH', `${A.purl}/wbs/${w1.id}`, { status: 'COMPLETED', progress: 100 });
  const w2 = await A.wbs({ title: 'Running task', planned_start_date: ymd(-5), planned_end_date: ymd(3), status: 'IN_PROGRESS', progress: 40, owner_user_id: A.uid });
  await A.wbs({ title: 'Next week task', planned_start_date: ymd(5), planned_end_date: ymd(15) }); await A.wbs({ title: 'Too far task', planned_start_date: ymd(9), planned_end_date: ymd(15) });
  await A.wbs({ item_type: 'MILESTONE', title: 'Next week milestone', milestone_date: ymd(6) });
  const i1 = await A.issue({ title: 'Resolved issue', severity: 'HIGH' }); await A.c('PATCH', `${A.purl}/issues/${i1.id}`, { status: 'RESOLVED' });
  await A.issue({ title: 'Open critical', severity: 'CRITICAL', owner_user_id: A.uid });
  await A.risk({ title: 'High risk', probability: 'HIGH', impact: 'MEDIUM' });
  const cr = await A.cr({ title: 'CR approved' }); await A.c('PATCH', `${A.purl}/changes/${cr.id}`, { schedule_impact_days: 2 }); await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'submit' }); await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'approve' });
  const t1 = await A.tc({ title: 'T pass' }); await A.c('POST', `${A.purl}/tests/${t1.id}/executions`, { result: 'PASS' });
  const t2 = await A.tc({ title: 'T fail' }); await A.c('POST', `${A.purl}/tests/${t2.id}/executions`, { result: 'FAIL' });
  const a1 = await A.acc({ title: 'Acc accepted', requirements: [r1.id] }); await A.c('POST', `${A.purl}/acceptances/${a1.id}/transition`, { action: 'submit' }); await A.c('POST', `${A.purl}/acceptances/${a1.id}/transition`, { action: 'accept' });

  const list0 = await A.c('GET', `${A.purl}/weekly-reports`); assert.equal(list0.status, 200); assert.deepEqual(list0.json.items, []); assert.ok(list0.json.default_period.period_start);
  const period = { period_start: ymd(-3), period_end: ymd(0) };
  const g = await A.c('POST', `${A.purl}/weekly-reports/generate`, period); assert.equal(g.status, 201, JSON.stringify(g.json));
  const rep = g.json.report; const d = rep.structured_content.data;
  assert.equal(rep.status, 'DRAFT'); assert.equal(rep.period_start, period.period_start); assert.ok(rep.generated_at); assert.equal(rep.finalized_at, null);
  // §18 status
  assert.equal(d.summary.phase_name, '착수'); assert.ok(['GOOD', 'WARNING', 'CRITICAL'].includes(d.summary.health.status)); assert.equal(d.summary.dimensions.length, 5); assert.ok('wbs_progress' in d.summary.kpis);
  // §19 completed: history-based, in period
  const ev = d.completed_items.map((c) => `${c.type}:${c.event}:${c.title}`);
  for (const e of ['WBS:COMPLETED:Done task', 'REQUIREMENT:CONFIRMED:Req confirmed this week', 'ISSUE:RESOLVED:Resolved issue', 'CHANGE:APPROVED:CR approved', 'TEST:PASS:T pass', 'ACCEPTANCE:ACCEPTED:Acc accepted']) assert.ok(ev.includes(e), e);
  // §20 in progress
  assert.deepEqual(d.in_progress_items.map((w) => w.title), ['Running task']); assert.equal(d.in_progress_items[0].owner, '홍길동');
  // §21 issues/risks
  assert.deepEqual(d.issues_and_risks.issues.map((i) => i.title), ['Open critical']); assert.equal(d.issues_and_risks.issues[0].owner, '홍길동'); assert.deepEqual(d.issues_and_risks.risks.map((r) => r.title), ['High risk']);
  // §22 changes
  assert.deepEqual(d.changes.created.map((c) => c.title), ['CR approved']); assert.deepEqual(d.changes.approved_unimplemented.map((c) => c.title), ['CR approved']); assert.equal(d.changes.impact.schedule_days, 2);
  // §23 tests/acceptance
  assert.deepEqual(d.test_and_acceptance.executions, { total: 2, pass: 1, fail: 1, blocked: 0 }); assert.deepEqual(d.test_and_acceptance.latest_fail.map((t) => t.title), ['T fail']);
  assert.equal(d.test_and_acceptance.acceptance_now.accepted, 1); assert.equal(d.test_and_acceptance.acceptance_period.ACCEPTED, 1);
  // §24 decisions include critical issue, high risk, approved CR, reviewing req
  const dk = d.attention_items.map((a) => a.kind);
  for (const k of ['CRITICAL_ISSUE', 'HIGH_RISK', 'APPROVED_UNIMPLEMENTED_CHANGE', 'REVIEWING_REQUIREMENT']) assert.ok(dk.includes(k), k);
  assert.ok(!dk.includes('FAIL_TEST'), 'fail test is not a decision item');
  // §25 next week = 7 days after period end
  assert.deepEqual(d.next_week_plan.map((u) => `${u.kind}:${u.title}`), ['WBS_END:Running task', 'WBS_START:Next week task', 'MILESTONE:Next week milestone']); // period_end+1 … +7, 'Too far' excluded
  // sections + markdown
  assert.deepEqual(rep.structured_content.sections.map((s) => s.title), ['프로젝트 현황', '금주 주요 완료사항', '진행 중 주요 업무', '주요 이슈 및 리스크', '변경사항', '테스트 / 검수 현황', '확인 및 의사결정 필요사항', '차주 계획']);
  assert.match(rep.rendered_content, /^# P 주간보고/); assert.match(rep.rendered_content, /## 2\. 금주 주요 완료사항\n\n- \[WBS\] 1 Done task — 완료/); assert.match(rep.rendered_content, /예측치가 아님/);
  assert.match(rep.plain_text, /^P 주간보고/); assert.ok(!rep.plain_text.includes('##')); assert.ok(rep.plain_text.includes('• [WBS] 1 Done task'));
  assert.equal(toPlainText('## A\n\n- **b** c'), 'A\n\n• b c');
  // period bound: a window before any activity has no completions, and next-week is empty
  const old = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: '2025-01-06', period_end: '2025-01-10' })).json.report;
  assert.deepEqual(old.structured_content.data.completed_items, []); assert.equal(old.structured_content.data.test_and_acceptance.executions.total, 0); assert.deepEqual(old.structured_content.data.next_week_plan, []);
  assert.match(old.rendered_content, /기간 내 완료 처리된 항목이 없습니다/);
  // edit (draft): title + section body; re-rendered
  let u = await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { title: '주간보고 10월 1주', sections: [{ key: 'completed', body: '- 직접 수정한 완료 항목\n- 두 번째' }] });
  assert.equal(u.status, 200); assert.equal(u.json.report.title, '주간보고 10월 1주'); assert.match(u.json.report.rendered_content, /# 주간보고 10월 1주[\s\S]*## 2\. 금주 주요 완료사항\n\n- 직접 수정한 완료 항목\n- 두 번째/);
  assert.equal(u.json.report.structured_content.data.completed_items.length >= 6, true, 'structured data is preserved when a section is edited');
  assert.equal((await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { sections: [{ key: 'nope', body: 'x' }] })).status, 400);
  // finalize → read-only → reopen
  let f = await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/finalize`, {}); assert.equal(f.status, 200); assert.equal(f.json.report.status, 'FINAL'); assert.ok(f.json.report.finalized_at);
  assert.equal((await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { title: 'x' })).status, 409);
  assert.equal((await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/finalize`, {})).status, 409);
  const ro = await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/reopen`, {}); assert.equal(ro.status, 200); assert.equal(ro.json.report.status, 'DRAFT'); assert.ok(ro.json.report.finalized_at, 'last finalization kept'); assert.ok(ro.json.report.updated_at >= f.json.report.updated_at);
  assert.equal((await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { title: '다시 편집' })).status, 200);
  // list newest period first
  const list = (await A.c('GET', `${A.purl}/weekly-reports`)).json.items; assert.equal(list.length, 2); assert.equal(list[0].id, rep.id); assert.ok(!('structured_content' in list[0]));
  // access control: other workspace → 404 everywhere
  assert.equal((await B.c('GET', `${A.purl}/weekly-reports`)).status, 404); assert.equal((await B.c('GET', `${A.purl}/weekly-reports/${rep.id}`)).status, 404);
  assert.equal((await B.c('POST', `${A.purl}/weekly-reports/generate`, period)).status, 404); assert.equal((await B.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { title: 'x' })).status, 404);
  assert.equal((await A.c('GET', `${A.purl}/weekly-reports/${'00000000-0000-0000-0000-000000000000'}`)).status, 404);
  // archived project: read OK, generate/patch/finalize → 409
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', `${A.purl}/weekly-reports/${rep.id}`)).status, 200);
  assert.equal((await A.c('POST', `${A.purl}/weekly-reports/generate`, period)).status, 409);
  assert.equal((await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { title: 'x' })).status, 409);
  assert.equal((await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/finalize`, {})).status, 409);
  void w2;
  server.close();
});

test('snapshot performance: query count stays flat as rows grow (no per-row queries)', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com');
  const count = async () => { let n = 0; const orig = db.pool.query; db.pool.query = function (...a) { n++; return orig.apply(this, a); }; await A.c('GET', `${A.purl}/snapshot`); db.pool.query = orig; return n; };
  const seed = async (k) => { for (let i = 0; i < k; i++) { await A.wbs({ title: `T${i}`, planned_start_date: ymd(-2), planned_end_date: ymd(-1) }); await A.issue({ title: `I${i}`, severity: 'HIGH', due_date: ymd(-1) }); await A.risk({ title: `R${i}`, probability: 'HIGH', impact: 'HIGH' }); const t = await A.tc({ title: `C${i}` }); await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result: 'FAIL' }); } };
  await seed(2); const small = await count(); await seed(10); const big = await count();
  assert.equal(big, small, `prepare() calls grew with data: ${small} → ${big}`);
  assert.ok(small < 60, `snapshot uses ${small} statements`);
  server.close();
});
