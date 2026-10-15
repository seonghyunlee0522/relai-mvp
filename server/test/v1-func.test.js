/* v1 functional fixes (Jim audit research/relai-v1-functional-audit.md): F2 no "null" in 주요 일정 · F3 milestones follow events ·
 * F4 WBS 실적 시작/종료 · F5 close warns about open WBS · F6 의사결정 기록 log · F7 데이터 이관 skeleton task · payments off (PAYMENTS_ENABLED). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { todayKst, addDays } from '../../public/app/shared/kst-date.js';
import { upcomingDates } from '../metrics.js';
import { syncMilestones, milestoneKind } from '../milestone-sync.js';
import { autoActualDates } from '../wbs.js';
import { skeletonPlan } from '../wbs-skeleton.js';

const T = todayKst();
const STAKE = [{ id: 'sh-pm', name: '정하늘', org_type: 'OWN', org: '수행사', role: 'PM' }, { id: 'sh-cl', name: '오지현', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' }];
const APV = { approver_id: 'sh-cl', date: addDays(T, -1), method: 'SIGNED', evidence: '검수확인서 서명본 수령' };
const proj = async (db, A) => db.get('SELECT * FROM projects WHERE id = ?', [A.p.id]);
const item = async (A, id) => (await A.c('GET', `${A.wbs}/${id}`)).json.item;
const ms = async (A, title, date) => (await A.c('POST', A.wbs, { item_type: 'MILESTONE', title, milestone_date: date })).json.item;

test('F3: milestoneKind maps titles to events', () => {
  assert.equal(milestoneKind('착수보고회'), 'KICKOFF'); assert.equal(milestoneKind('킥오프'), 'KICKOFF');
  assert.equal(milestoneKind('설계 완료'), 'DESIGN'); assert.equal(milestoneKind('최종 검수'), 'ACCEPTANCE');
  assert.equal(milestoneKind('서비스 오픈'), 'GO_LIVE'); assert.equal(milestoneKind('중간 보고'), null);
});

test('F2 + F3: weekly report 주요 일정 never prints null; kickoff held → its key date and milestone are no longer upcoming', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'f2@x.com'); const D = `${A.purl}/definition`;
  await A.c('PUT', D, { stakeholders: STAKE, key_dates: [{ title: '중간 보고', date: addDays(T, 3) }, { title: '착수보고회', date: addDays(T, 4) }] });
  const before = await upcomingDates(db, A.p.id, { days: 7 });
  assert.deepEqual(before.filter((r) => r.kind === 'KEY_DATE').map((r) => r.title), ['중간 보고', '착수보고회']);
  let rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: addDays(T, -6), period_end: T })).json.report;
  assert.doesNotMatch(rep.rendered_content, /null/);
  assert.match(rep.rendered_content, /주요 일정: 중간 보고/);
  // the 착수보고회 is held (yesterday) → 완료
  const r = await A.c('POST', `${D}/sections/KICKOFF/complete`, { kickoff: { datetime: `${addDays(T, -1)}T10:00`, attendees: ['sh-cl'], decisions: ['범위 확정'] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = await upcomingDates(db, A.p.id, { days: 7 });
  assert.deepEqual(after.filter((x) => x.kind === 'KEY_DATE').map((x) => x.title), ['중간 보고']);
  // a 착수보고회 milestone made later (03) lands 완료 at the next sync (weekly report generation runs it)
  const k = await ms(A, '착수보고회', addDays(T, 4));
  assert.equal(k.status, 'NOT_STARTED');
  rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: addDays(T, -6), period_end: T })).json.report;
  const k2 = await item(A, k.id); assert.equal(k2.status, 'COMPLETED'); assert.equal(String(k2.actual_end_date).slice(0, 10), addDays(T, -1));
  assert.doesNotMatch(rep.rendered_content.split('차주 계획')[1] || '', /착수보고회/);
  assert.doesNotMatch(rep.rendered_content, /null/);
  server.close();
});

test('F3: design gate, whole-scope acceptance and go-live complete their milestones with the actual date', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'f3@x.com');
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: STAKE });
  const d = await ms(A, '설계 완료', addDays(T, 20)); const a = await ms(A, '최종 검수', addDays(T, 40)); const o = await ms(A, '오픈', addDays(T, 60));
  // nothing happened yet
  assert.equal(await syncMilestones(db, await proj(db, A)), 0);
  // 03 passed its gate
  await db.run(`UPDATE project_phases SET status = 'COMPLETED', completed_at = now() WHERE project_id = ? AND phase_key = 'ANALYSIS_DESIGN'`, [A.p.id]);
  assert.equal(await syncMilestones(db, await proj(db, A)), 1);
  assert.equal((await item(A, d.id)).status, 'COMPLETED'); assert.equal(String((await item(A, d.id)).actual_end_date).slice(0, 10), T);
  // whole scope accepted through the API → 최종 검수 완료 with the approval date
  const rq = (await A.c('POST', A.req, { title: '로그인', scope: 'IN_SCOPE' })).json.requirement;
  await A.c('PATCH', `${A.req}/${rq.id}`, { status: 'CONFIRMED' });
  const acc = (await A.c('POST', `${A.purl}/acceptances`, { title: '최종 검수', requirements: [rq.id] })).json.acceptance;
  await A.c('POST', `${A.purl}/acceptances/${acc.id}/transition`, { action: 'submit' });
  assert.equal((await A.c('POST', `${A.purl}/acceptances/${acc.id}/transition`, { action: 'accept', customer_approval: APV })).status, 200);
  const a2 = await item(A, a.id); assert.equal(a2.status, 'COMPLETED'); assert.equal(String(a2.actual_end_date).slice(0, 10), APV.date);
  // go-live recorded → 오픈 완료 with the go-live date
  await db.run('UPDATE project_definitions SET go_live = ? WHERE project_id = ?', [JSON.stringify({ date: addDays(T, -2), carryovers: [] }), A.p.id]);
  assert.equal(await syncMilestones(db, await proj(db, A)), 1);
  const o2 = await item(A, o.id); assert.equal(o2.status, 'COMPLETED'); assert.equal(String(o2.actual_end_date).slice(0, 10), addDays(T, -2));
  server.close();
});

test('F4: autoActualDates (pure)', () => {
  const t = { item_type: 'TASK', status: 'NOT_STARTED', progress: 0 };
  assert.deepEqual(autoActualDates(t, { status: 'IN_PROGRESS' }, '2026-10-15'), { actual_start_date: '2026-10-15' });
  assert.deepEqual(autoActualDates(t, { progress: 30 }, '2026-10-15'), { actual_start_date: '2026-10-15' });
  assert.deepEqual(autoActualDates(t, { status: 'COMPLETED', progress: 100 }, '2026-10-15'), { actual_start_date: '2026-10-15', actual_end_date: '2026-10-15' });
  assert.deepEqual(autoActualDates({ ...t, actual_start_date: '2026-10-01' }, { status: 'IN_PROGRESS', actual_start_date: undefined }, '2026-10-15'), {});
  assert.deepEqual(autoActualDates(t, { status: 'IN_PROGRESS', actual_start_date: '2026-10-02' }, '2026-10-15'), {});   // typed date wins
  assert.deepEqual(autoActualDates({ ...t, status: 'COMPLETED', progress: 100, actual_start_date: '2026-10-01', actual_end_date: '2026-10-10' }, { status: 'IN_PROGRESS', progress: 90 }, '2026-10-15'), { actual_end_date: null });
  assert.deepEqual(autoActualDates({ item_type: 'SUMMARY', status: 'NOT_STARTED' }, { status: 'IN_PROGRESS' }), {});
});

test('F4: WBS PATCH records 실적 시작 / 실적 종료 and keeps typed dates', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'f4@x.com');
  const w = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '화면 개발' })).json.item;
  assert.equal(w.actual_start_date, null);
  let it = (await A.c('PATCH', `${A.wbs}/${w.id}`, { status: 'IN_PROGRESS' })).json.item;
  assert.equal(String(it.actual_start_date).slice(0, 10), T); assert.equal(it.actual_end_date, null);
  it = (await A.c('PATCH', `${A.wbs}/${w.id}`, { progress: 100 })).json.item;
  assert.equal(it.status, 'COMPLETED'); assert.equal(String(it.actual_end_date).slice(0, 10), T);
  it = (await A.c('PATCH', `${A.wbs}/${w.id}`, { status: 'IN_PROGRESS' })).json.item;
  assert.equal(it.actual_end_date, null, 'reopened → 실적 종료 cleared'); assert.equal(String(it.actual_start_date).slice(0, 10), T);
  it = (await A.c('PATCH', `${A.wbs}/${w.id}`, { actual_start_date: addDays(T, -5) })).json.item;
  assert.equal(String(it.actual_start_date).slice(0, 10), addDays(T, -5));
  server.close();
});

test('F5: open WBS tasks and milestones are counted for the close dialog (07 only)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'f5@x.com');
  const g0 = (await A.c('GET', A.purl)).json; assert.equal(g0.open_wbs, null);
  await A.c('POST', A.wbs, { item_type: 'TASK', title: '통합 테스트' });
  const done = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '배포' })).json.item;
  await A.c('PATCH', `${A.wbs}/${done.id}`, { status: 'COMPLETED' });
  await ms(A, '최종 검수', addDays(T, 5));
  await db.run(`UPDATE projects SET current_phase = 'OPERATIONS' WHERE id = ?`, [A.p.id]);
  const g = (await A.c('GET', A.purl)).json;
  assert.deepEqual(g.open_wbs, { tasks: 1, milestones: 1 });
  server.close();
});

test('F6: 주요 의사결정 기록 is a decision log — 1 decision recorded → 완료', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'f6@x.com');
  const dec = (G) => G.phases.find((p) => p.phase_key === 'DEVELOPMENT').steps.find((s) => s.step_key === 'DECISIONS');
  let s = dec((await A.c('GET', A.purl)).json);
  assert.match(s.cta.href, /checklist\?activity=DECISIONS$/); assert.notEqual(s.state, 'COMPLETED');
  const r = await A.c('POST', `${A.purl}/steps/${s.id}/checklist`, { title: '2차 오픈으로 리포트 기능 이월', owner: '오지현 고객 PM', due_date: T, done: true, note: '주간회의' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  s = dec((await A.c('GET', A.purl)).json); assert.equal(s.state, 'COMPLETED');
  const list = (await A.c('GET', `${A.purl}/checklists`)).json.items.filter((x) => x.step_id === s.id);
  assert.equal(list.length, 1); assert.equal(list[0].owner_display, '오지현 고객 PM'); assert.equal(String(list[0].due_date).slice(0, 10), T);
  server.close();
});

test('F7: WBS skeleton has a 데이터 이관 task when data migration is 있음 or 미정, not when 없음', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'f7@x.com');
  const tasks = async (v) => { await db.run('UPDATE projects SET data_migration = ? WHERE id = ?', [v, A.p.id]); return (await skeletonPlan(db, await proj(db, A))).groups.find((g) => g.key === 'TRANSITION').tasks.map((t) => t.title); };
  assert.ok((await tasks('YES')).includes('데이터 이관'));
  assert.ok((await tasks('TBD')).includes('데이터 이관'));
  assert.ok(!(await tasks('NO')).includes('데이터 이관'));
  server.close();
});

test('payments off by default: no checkout (409 payments_disabled), summaries say so; PAYMENTS_ENABLED=true restores', async () => {
  const prev = process.env.PAYMENTS_ENABLED; delete process.env.PAYMENTS_ENABLED;
  const { server, client, db } = await boot();
  const A = await setup(client, 'pay@x.com');
  await db.run('UPDATE users SET email_verified_at = now() WHERE id = ?', [A.uid]);
  let r = await A.c('POST', `/api/workspaces/${A.w}/credits/checkout`, { pack: 'S' });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'payments_disabled'); assert.match(r.json.error.message, /초기 고객은 무료로 이용합니다/);
  r = await A.c('POST', `/api/workspaces/${A.w}/billing/checkout`, { plan: 'TEAM', cycle: 'ANNUAL', users: 1 });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'payments_disabled');
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/credits/summary`)).json.credits.payments_enabled, false);
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b.payments_enabled, false); assert.equal(b.checkout.can_purchase, false);
  assert.equal((await A.c('GET', `${A.purl}/ai/status`)).json.payments_enabled, false);
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/credits/ledger`)).status, 200);   // ledger unchanged
  process.env.PAYMENTS_ENABLED = 'true';
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/credits/summary`)).json.credits.payments_enabled, true);
  r = await A.c('POST', `/api/workspaces/${A.w}/credits/checkout`, { pack: 'S' });
  assert.notEqual(r.json?.error?.code, 'payments_disabled');
  if (prev === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = prev;
  server.close();
});
