/* Phase 4 (04 구현): 일정 미루기 = 사유 + 최초 계획일 (US-1), 변경 요청 승인 = 고객 승인 기록 (US-2), WEEKLY_REPORT (US-3),
 * Issue 상태·담당자 (US-5 · US-6), 한국어 라벨 (US-7), 한국 시간 날짜 (C1), migration 35.
 * Spec: hive research/relai-phase-4-spec.md (v2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { PHASE_BY_KEY } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import * as W from '../wbs.js';
import { weeklyReportState, scheduleLines } from '../reports.js';
import { DIMENSION_LABEL } from '../health.js';
import { ISSUE_TRANSITIONS } from '../raid.js';
import { todayKst, weekKst, addDays, needsDelayReason, planShiftText } from '../../public/app/shared/kst-date.js';

const T = todayKst();
const d = (n) => addDays(T, n);
const TEAM = [
  { id: 'sh-pl', name: '최민석', org_type: 'OWN', org: '수행사', role: 'PL' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '이고객', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
];
const CA = { approver_name: '이수진', approver_title: '차장', date: T, method: 'EMAIL', evidence: '회신 메일 "CR-001 승인"' };
const step = (g, phase, key) => g.phases.find((x) => x.phase_key === phase).steps.find((s) => s.step_key === key);
const toPhase = async (A, target) => {
  const order = ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING'];
  for (const key of order.slice(0, order.indexOf(target) + 1)) {
    const g = (await A.c('GET', A.purl)).json; if (g.project.current_phase === key) continue;
    const ph = g.phases.find((x) => x.phase_key === key);
    assert.equal((await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'NEXT' })).status, 200, `activate ${key}`);
  }
};
const task = async (A, body) => (await A.c('POST', A.wbs, { title: '작업', ...body })).json.item;
const patch = (A, id, body) => A.c('PATCH', `${A.wbs}/${id}`, body);

/* ---------- C1 / shared helpers ---------- */
test('C1: today/this week are Korea time — Monday 08:00 KST (Sunday 23:00 UTC) is already the new week', () => {
  const mon8 = new Date('2026-10-18T23:00:00Z');   // = 2026-10-19 (Mon) 08:00 KST
  assert.equal(todayKst(mon8), '2026-10-19');
  assert.deepEqual(weekKst(mon8), { start: '2026-10-19', end: '2026-10-25' });
  assert.deepEqual(weekKst(new Date('2026-10-18T14:00:00Z')), { start: '2026-10-12', end: '2026-10-18' }, 'Sunday 23:00 KST is still last week');
  // 오늘(KST)이 종료일인 작업은 지연이 아니다
  assert.equal(W.computeStatus({ item_type: 'TASK', status: 'IN_PROGRESS', progress: 30, planned_end_date: T }, T), 'IN_PROGRESS');
  assert.equal(needsDelayReason(T, d(3), T, 'NOT_STARTED'), false, 'ending today is not late yet');
});

test('US-1 needsDelayReason: later + (started or already late) only', () => {
  assert.equal(needsDelayReason('2026-05-14', '2026-05-21', '2026-05-10', 'IN_PROGRESS'), true);
  assert.equal(needsDelayReason('2026-05-14', '2026-05-21', '2026-05-10', 'NOT_STARTED'), false, '미시작 + 미래 = 재계획');
  assert.equal(needsDelayReason('2026-05-14', '2026-05-21', '2026-05-15', 'NOT_STARTED'), true, '이미 지연');
  assert.equal(needsDelayReason('2026-05-14', '2026-05-10', '2026-05-20', 'IN_PROGRESS'), false, '앞당김');
  assert.equal(needsDelayReason(null, '2026-05-21', '2026-05-20', 'IN_PROGRESS'), false, 'first date');
  assert.equal(needsDelayReason('2026-05-14', '2026-05-21', '2026-05-10', 'COMPLETED'), true);
  assert.equal(planShiftText('2026-05-14', '2026-05-21'), '계획 5/14 → 5/21 (+7일)');
  assert.equal(planShiftText('2026-05-14', '2026-05-14'), '');
  assert.equal(planShiftText(null, '2026-05-14'), '');
});

/* ---------- US-1 ---------- */
test('US-1 delay reason: 422 without it, note in history, original end date kept across two pushes, no dialog for planning moves', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toPhase(A, 'ANALYSIS_DESIGN');
  const t1 = await task(A, { planned_start_date: d(-3), planned_end_date: d(5) });
  // 03: planning change (not started, future) — free, and no original yet
  let r = await patch(A, t1.id, { planned_end_date: d(6) }); assert.equal(r.status, 200); assert.equal(r.json.item.original_planned_end_date, null);
  await toPhase(A, 'DEVELOPMENT');
  r = await A.c('GET', `${A.wbs}/${t1.id}`); assert.equal(r.json.item.original_planned_end_date, d(6), 'frozen at 04 entry');
  assert.equal((await patch(A, t1.id, { status: 'IN_PROGRESS', progress: 20 })).status, 200);
  r = await patch(A, t1.id, { planned_end_date: d(13) });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'delay_reason_required');
  assert.equal(r.json.error.before, d(6)); assert.equal(r.json.error.after, d(13)); assert.equal(r.json.error.days, 7);
  r = await patch(A, t1.id, { planned_end_date: d(13), delay_reason: '고객 계정 발급 지연 → 버퍼 3일 사용' });
  assert.equal(r.status, 200); assert.equal(r.json.item.planned_end_date, d(13)); assert.equal(r.json.item.original_planned_end_date, d(6));
  const h = r.json.item.history.find((x) => x.field_name === 'planned_end_date');
  assert.equal(h.note, '고객 계정 발급 지연 → 버퍼 3일 사용'); assert.equal(r.json.item.delay_note.note, h.note);
  r = await patch(A, t1.id, { planned_end_date: d(16), delay_reason: '두 번째' }); assert.equal(r.status, 200);
  assert.equal(r.json.item.original_planned_end_date, d(6), 'still the first value');
  assert.equal(planShiftText(r.json.item.original_planned_end_date, r.json.item.planned_end_date), `계획 ${planShiftText(d(6), d(16)).slice(3)}`);
  assert.match(planShiftText(d(6), d(16)), /\(\+10일\)$/, '+총 일수');
  // pulling earlier never asks
  assert.equal((await patch(A, t1.id, { planned_end_date: d(10) })).status, 200);
  // 미시작 + 미래: no reason
  const t2 = await task(A, { planned_start_date: d(2), planned_end_date: d(8) });
  assert.equal(t2.original_planned_end_date, d(8), 'created in 04 → first end date is the original');
  assert.equal((await patch(A, t2.id, { planned_end_date: d(20) })).status, 200);
  // 미시작 but already late → reason needed
  const t3 = await task(A, { planned_start_date: d(-9), planned_end_date: d(-2) });
  assert.equal((await patch(A, t3.id, { planned_end_date: d(4) })).status, 422);
  // milestone: same rule on milestone_date
  const ms = await task(A, { item_type: 'MILESTONE', title: '중간 점검', milestone_date: d(-1) });
  assert.equal(ms.original_planned_end_date, d(-1));
  assert.equal((await patch(A, ms.id, { milestone_date: d(3) })).json.error.code, 'delay_reason_required');
  assert.equal((await patch(A, ms.id, { milestone_date: d(3), delay_reason: '고객 일정' })).status, 200);
  // bulk: one reason for the pushed rows, otherwise the whole request is refused (nothing saved)
  r = await A.c('POST', `${A.wbs}/bulk`, { ids: [t1.id, t2.id], action: 'update', shift_days: 2 });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'delay_reason_required');
  assert.equal((await A.c('GET', `${A.wbs}/${t2.id}`)).json.item.planned_end_date, d(20), 'rolled back');
  r = await A.c('POST', `${A.wbs}/bulk`, { ids: [t1.id, t2.id], action: 'update', shift_days: 2, delay_reason: '일괄 조정' });
  assert.equal(r.status, 200); assert.equal(r.json.updated, 2);
  assert.equal((await A.c('GET', `${A.wbs}/${t1.id}`)).json.item.delay_note.note, '일괄 조정');
  server.close();
});

test('US-1 Excel path: the auto reason "Excel 가져오기로 변경" is stored when a started task is pushed through the import path', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await toPhase(A, 'DEVELOPMENT');
  const t = await task(A, { planned_start_date: d(-3), planned_end_date: d(5), status: 'IN_PROGRESS', progress: 10 });
  const project = await db.get('SELECT * FROM projects WHERE id = ?', [A.p.id]);
  const row = await db.get('SELECT * FROM wbs_items WHERE id = ?', [t.id]);
  await W.updateWbs(db, project, row, { planned_end_date: d(9) }, A.uid, { delayReason: W.EXCEL_DELAY_REASON });
  const h = await db.get(`SELECT note FROM wbs_history WHERE wbs_item_id = ? AND field_name = 'planned_end_date'`, [t.id]);
  assert.equal(h.note, 'Excel 가져오기로 변경');
  await assert.rejects(W.updateWbs(db, project, { ...row, planned_end_date: d(9) }, { planned_end_date: d(12) }, A.uid), (e) => e.code === 'delay_reason_required' && e.status === 422);
  server.close();
});

test('US-1 weekly report: "이번 주 일정 변경 1건 (총 +7일)" + reason line; no line when nothing was pushed', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toPhase(A, 'DEVELOPMENT');
  const wk = weekKst();
  let r = await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end });
  assert.equal(r.status, 201); assert.doesNotMatch(r.json.report.rendered_content, /일정 변경/);
  const t = await task(A, { title: '로그인 화면', planned_start_date: d(-3), planned_end_date: d(5), status: 'IN_PROGRESS', progress: 10 });
  assert.equal((await patch(A, t.id, { planned_end_date: d(12), delay_reason: '고객 계정 발급 지연' })).status, 200);
  r = await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end });
  const md = r.json.report.rendered_content;
  assert.match(md, /- 일정: 이번 주 일정 변경 1건 \(최초 계획 대비 총 \+7일\)/);
  assert.match(md, /로그인 화면 · \+7일 · 최초 계획 대비 \+7일 · 고객 계정 발급 지연/);
  assert.deepEqual(scheduleLines([]), []);
  // US-7: no English labels in the report body
  for (const en of ['Schedule', 'Scope', 'Coverage', 'Severity', 'Critical', 'Blocked', 'Resolution', 'Owner']) assert.doesNotMatch(md, new RegExp(en), en);
  assert.match(md, /요구사항 반영률/);
  server.close();
});

/* ---------- US-2 ---------- */
test('US-2 CR approve: no record needed (고객 확인 체크 optional, no 422); check + note stored + APPROVED in one go; who/when stamped', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await A.c('PUT', `${A.purl}/definition`, { stakeholders: TEAM }); await toPhase(A, 'DEVELOPMENT');
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: 'MFA 추가', requester_name: '이고객' })).json.change;
  const tr = (id, body) => A.c('POST', `${A.purl}/changes/${id}/transition`, body);
  assert.equal((await tr(cr.id, { action: 'submit' })).status, 200);
  // a bad legacy date is still a 400 and nothing is saved
  let r = await tr(cr.id, { action: 'approve', customer_approval: { checked: true, date: d(1) } });
  assert.equal(r.status, 400); assert.ok(r.json.error.fields['approval.date'], '승인일 미래 불가');
  assert.equal((await A.c('GET', `${A.purl}/changes/${cr.id}`)).json.change.status, 'UNDER_REVIEW', 'nothing saved');
  // approve with the optional check + note
  r = await tr(cr.id, { action: 'approve', customer_approval: { checked: true, note: '이수진 차장 메일 회신' } });
  assert.equal(r.status, 200); const c = r.json.change;
  assert.equal(c.status, 'APPROVED'); assert.equal(c.customer_approval.checked, true); assert.equal(c.customer_approval.recorded, true);
  assert.equal(c.customer_approval.checked_by_name, '홍길동'); assert.ok(c.customer_approval.checked_at, 'when stamped');
  assert.equal(c.customer_approval.summary, `✓ 고객 확인 · 홍길동 · ${T} · 이수진 차장 메일 회신`);
  assert.ok(c.history.some((h) => h.action_type === 'CUSTOMER_APPROVAL'));
  const def = (await A.c('GET', `${A.purl}/definition`)).json;
  assert.ok(!(def.definition || def).stakeholders.some((x) => x.name === '이수진'), 'a check never adds a stakeholder');
  const list = (await A.c('GET', `${A.purl}/changes`)).json.changes;
  assert.equal(list.find((x) => x.id === cr.id).customer_approval.summary, c.customer_approval.summary, 'list shows the check summary');
  // no record at all: approve straight from 작성 중 (DRAFT), check stays off
  const cr2 = (await A.c('POST', `${A.purl}/changes`, { title: '보고서 추가' })).json.change;
  r = await tr(cr2.id, { action: 'approve' });
  assert.equal(r.status, 200, 'no 422 customer_approval_required'); assert.equal(r.json.change.status, 'APPROVED');
  assert.equal(r.json.change.customer_approval.checked, false); assert.equal(r.json.change.customer_approval.summary, '');
  assert.ok(!r.json.change.history.some((h) => h.action_type === 'CUSTOMER_APPROVAL'), 'no check → no check history row');
  assert.deepEqual(r.json.change.stakeholders.map((x) => x.name).slice(0, 3), ['최민석', '박협력', '이고객'], 'Drawer gets the 01 stakeholders (requester autocomplete)');
  server.close();
});

test('US-2 고객 확인 체크 editable on any CR via PATCH customer-approval (no 409 by status); legacy 4-field record reads as checked', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await toPhase(A, 'DEVELOPMENT');
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: '옛 CR' })).json.change;
  const put = (body) => A.c('PATCH', `${A.purl}/changes/${cr.id}/customer-approval`, { customer_approval: body });
  let r = await put({ checked: true, note: '구두 확인' });
  assert.equal(r.status, 200, 'DRAFT CR may be checked (was 409)');
  r = await A.c('GET', `${A.purl}/changes/${cr.id}`);
  assert.equal(r.json.change.status, 'DRAFT', 'status unchanged'); assert.equal(r.json.change.customer_approval.checked, true); assert.equal(r.json.change.customer_approval.note, '구두 확인');
  r = await put({ checked: false });
  assert.equal(r.status, 200); r = await A.c('GET', `${A.purl}/changes/${cr.id}`);
  assert.equal(r.json.change.customer_approval.checked, false); assert.equal(r.json.change.customer_approval.checked_by_name, '', 'who/when cleared on uncheck');
  assert.ok(r.json.change.history.some((h) => h.action_type === 'CUSTOMER_APPROVAL' && h.new_value === '고객 확인 체크 해제'));
  // legacy IMPLEMENTED CR with a full pre-2026-10-21 record counts as checked; without one, a check can be added and status stays
  await db.run(`UPDATE change_requests SET status = 'IMPLEMENTED', customer_approval = ? WHERE id = ?`, [JSON.stringify(CA), cr.id]);
  r = await A.c('GET', `${A.purl}/changes/${cr.id}`); assert.equal(r.json.change.customer_approval.recorded, true);
  assert.match(r.json.change.customer_approval.summary, /^✓ 고객 확인 · 이수진 차장 · .* · 이메일 회신$/);
  await db.run(`UPDATE change_requests SET customer_approval = '{}' WHERE id = ?`, [cr.id]);
  r = await A.c('GET', `${A.purl}/changes/${cr.id}`); assert.equal(r.json.change.customer_approval.recorded, false);
  r = await put({ checked: true });
  assert.equal(r.status, 200); r = await A.c('GET', `${A.purl}/changes/${cr.id}`);
  assert.equal(r.json.change.status, 'IMPLEMENTED'); assert.equal(r.json.change.customer_approval.recorded, true);
  server.close();
});

/* ---------- US-3 ---------- */
test('US-3 WEEKLY_REPORT: 04 권장 after CHANGES; NONE → 주간보고 만들기, DRAFT → 이어서 작성, FINAL → ✓; next week open again', async () => {
  const st = PHASE_BY_KEY.DEVELOPMENT.steps; const i = st.findIndex((s) => s.key === 'WEEKLY_REPORT');
  assert.equal(st[i - 1].key, 'CHANGES'); assert.equal(st[i].importance, 'RECOMMENDED'); assert.equal(st[i].linked_feature_type, 'reports');
  const { server, client, db } = await boot();
  const A = await setup(client); await toPhase(A, 'DEVELOPMENT');
  let a = step((await A.c('GET', A.purl)).json, 'DEVELOPMENT', 'WEEKLY_REPORT');
  assert.equal(a.state, 'NOT_STARTED'); assert.equal(a.text, '이번 주 주간보고를 만드세요'); assert.equal(a.cta.label, '주간보고 만들기'); assert.match(a.cta.href, /\/reports\?new=week$/); assert.equal(a.row_action, true);
  const wk = weekKst();
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end })).json.report;
  a = step((await A.c('GET', A.purl)).json, 'DEVELOPMENT', 'WEEKLY_REPORT');
  assert.equal(a.state, 'IN_PROGRESS'); assert.equal(a.text, '초안 작성 중'); assert.equal(a.cta.label, '이어서 작성'); assert.match(a.cta.href, new RegExp(`/reports/${rep.id}$`));
  await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/finalize`, {});
  a = step((await A.c('GET', A.purl)).json, 'DEVELOPMENT', 'WEEKLY_REPORT');
  assert.equal(a.state, 'COMPLETED'); assert.match(a.text, /^✓ 이번 주 보고 확정 · \d+\/\d+$/);
  assert.ok(!(await A.c('GET', A.purl)).json.current_phase.steps.some((x) => x.step_key === 'WEEKLY_REPORT' && x.importance === 'REQUIRED'), '권장: never part of the gate');
  // next week: computed again from scratch
  const nextWeek = new Date(Date.parse(`${addDays(wk.end, 1)}T00:00:00+09:00`) + 8 * 3600e3);
  assert.equal((await weeklyReportState(db, A.p.id, nextWeek)).state, 'NONE');
  assert.equal((await weeklyReportState(db, A.p.id)).state, 'FINAL');
  server.close();
});

/* ---------- US-5 · US-6 ---------- */
test('US-5 issues: BLOCKED → RESOLVED directly; empty resolution allowed; 0 issues → manual 완료 처리 text', async () => {
  assert.ok(ISSUE_TRANSITIONS.BLOCKED.includes('RESOLVED'));
  const { server, client } = await boot();
  const A = await setup(client); await toPhase(A, 'DEVELOPMENT');
  let a = step((await A.c('GET', A.purl)).json, 'DEVELOPMENT', 'ISSUES');
  assert.equal(a.text, '아직 기록된 이슈가 없습니다. 문제가 없었다면 완료 처리하세요.'); assert.equal(a.manual, true);
  const iss = (await A.c('POST', `${A.purl}/issues`, { title: '배포 서버 접근 불가', severity: 'CRITICAL' })).json.issue;
  assert.equal((await A.c('PATCH', `${A.purl}/issues/${iss.id}`, { status: 'BLOCKED' })).status, 200);
  a = step((await A.c('GET', A.purl)).json, 'DEVELOPMENT', 'ISSUES');
  assert.match(a.text, /열린 이슈 1건 · 심각 1건 · 차단됨 1건/);
  const r = await A.c('PATCH', `${A.purl}/issues/${iss.id}`, { status: 'RESOLVED', resolution: '' });
  assert.equal(r.status, 200); assert.equal(r.json.issue.status, 'RESOLVED');
  server.close();
});

test('US-6 issue owner = RELAI user or 팀원 (계정 없음): exclusive, validated, shown in list and weekly report', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await A.c('PUT', `${A.purl}/definition`, { stakeholders: TEAM }); await toPhase(A, 'DEVELOPMENT');
  let r = await A.c('GET', `${A.purl}/issues`);
  assert.deepEqual(r.json.owners.team.map((x) => x.name), ['최민석', '박협력'], 'Phase 3 picker: 당사·협력사 only');
  r = await A.c('POST', `${A.purl}/issues`, { title: 'API 응답 지연', severity: 'HIGH', owner: 's:sh-dev' });
  assert.equal(r.status, 201); const iss = r.json.issue;
  assert.equal(iss.owner_stakeholder_id, 'sh-dev'); assert.equal(iss.owner_user_id, null); assert.equal(iss.owner_name, '박협력'); assert.equal(iss.owner_no_account, true);
  assert.equal((await A.c('POST', `${A.purl}/issues`, { title: 'x', owner_stakeholder_id: 'sh-cl' })).status, 400, '고객사 is not a team member');
  assert.equal((await A.c('POST', `${A.purl}/issues`, { title: 'x', owner_user_id: A.uid, owner_stakeholder_id: 'sh-dev' })).status, 400, 'one kind only');
  const wk = weekKst();
  const md = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: wk.start, period_end: wk.end })).json.report.rendered_content;
  assert.match(md, /API 응답 지연 — 높음 · 열림 · 박협력 \(계정 없음\)/);
  r = await A.c('PATCH', `${A.purl}/issues/${iss.id}`, { owner_user_id: A.uid });
  assert.equal(r.json.issue.owner_user_id, A.uid); assert.equal(r.json.issue.owner_stakeholder_id, null, 'user clears stakeholder');
  r = await A.c('PATCH', `${A.purl}/issues/${iss.id}`, { owner: 's:sh-pl' });
  assert.equal(r.json.issue.owner_user_id, null); assert.equal(r.json.issue.owner_name, '최민석');
  assert.equal((await A.c('GET', `${A.purl}/issues?owner=s:sh-pl`)).json.items.length, 1);
  server.close();
});

test('US-7 health dimension labels are Korean', () => {
  assert.deepEqual(Object.values(DIMENSION_LABEL), ['일정', '범위', '품질', '변경', '리스크']);
});

/* ---------- migration 35 ---------- */
test('migration 35: originals backfilled for projects at/after 04 (value at 04 entry: first post-04 change\'s old value, else last pre-04 value, else current), NULL before 04; WEEKLY_REPORT after CHANGES once', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'a@x.com'); await toPhase(A, 'ANALYSIS_DESIGN');
  const t1 = await task(A, { planned_start_date: d(-5), planned_end_date: d(5) });
  await patch(A, t1.id, { planned_end_date: d(7) });             // 03 planning change → value at 04 entry = d(7)
  const t2 = await task(A, { planned_start_date: d(-5), planned_end_date: d(4) });
  const ms = await task(A, { item_type: 'MILESTONE', title: '중간보고', milestone_date: '2026-11-01' });   // Q12-1: dated in 03, never edited before 04
  const t4 = await task(A, { planned_start_date: '2026-10-20', planned_end_date: '2026-11-01' });
  await toPhase(A, 'DEVELOPMENT');
  await patch(A, ms.id, { milestone_date: '2026-11-05' });         // first change after 04 entry (old build: no original frozen)
  await patch(A, ms.id, { milestone_date: '2026-11-08' });
  await patch(A, t4.id, { planned_end_date: '2026-11-05' });
  await patch(A, t1.id, { status: 'IN_PROGRESS', progress: 5 });
  await patch(A, t1.id, { planned_end_date: d(15), delay_reason: '사유' });
  const B = await setup(client, 'b@x.com'); await toPhase(B, 'ANALYSIS_DESIGN');
  const t3 = await task(B, { planned_end_date: d(9) });
  // legacy shape: no originals, no WEEKLY_REPORT step
  await db.run('UPDATE wbs_items SET original_planned_end_date = NULL');
  await db.run(`DELETE FROM project_steps WHERE step_key = 'WEEKLY_REPORT'`);
  const m35 = migrations.find((m) => m.version === 35); assert.ok(m35); assert.ok(migrations[migrations.length - 1].version >= 35);
  await m35.up(db); await m35.up(db);
  const orig = async (id) => (await db.get('SELECT original_planned_end_date AS o FROM wbs_items WHERE id = ?', [id])).o;
  assert.equal(await orig(t1.id), d(7), 'last end date recorded before 04 entry');
  assert.equal(await orig(t2.id), d(4), 'no change before 04 → its value then');
  assert.equal(await orig(ms.id), '2026-11-01', 'milestone created 11/01 in 03, moved to 11/05 in 04 → original 11/01');
  assert.equal(await orig(t4.id), '2026-11-01', 'task dated in 03, first pushed in 04 → value at 04 entry');
  assert.equal(await orig(t3.id), null, 'project still in 03');
  for (const P of [A, B]) {
    const steps = await db.all(`SELECT s.step_key, s.sequence, s.importance, s.status FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
      WHERE p.project_id = ? AND p.phase_key = 'DEVELOPMENT' ORDER BY s.sequence`, [P.p.id]);
    const keys = steps.map((s) => s.step_key);
    assert.equal(keys.filter((k) => k === 'WEEKLY_REPORT').length, 1);
    assert.equal(keys[keys.indexOf('CHANGES') + 1], 'WEEKLY_REPORT');
    const wr = steps.find((s) => s.step_key === 'WEEKLY_REPORT'); assert.equal(wr.importance, 'RECOMMENDED'); assert.equal(wr.status, 'TODO');
  }
  // B enters 04 later → frozen then
  await toPhase(B, 'DEVELOPMENT'); assert.equal(await orig(t3.id), d(9));
  server.close();
});
