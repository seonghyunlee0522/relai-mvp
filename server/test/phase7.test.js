/* Phase 7 (07 운영 및 유지보수): 완료보고서 (US-1), 프로젝트 종료 / 종료 취소 (US-2), 운영 인수 = 누가·언제 (US-3), 넘긴 건 독촉하지 않음 (US-4),
 * 07 문구 (US-5), 06→07 앞 단계 요약 + 용어 (US-6), migration 38. Spec: hive research/relai-phase-7-spec.md (v2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { PHASE_BY_KEY, CHECKLIST_TEMPLATES } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import { projectGuidance } from '../guidance.js';
import { addMonths, priorGaps, priorGapsText } from '../closing.js';
import { todayKst, addDays } from '../../public/app/shared/kst-date.js';

const T = todayKst();
const STAKE = [
  { id: 'sh-pm', name: '정하늘', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-cl', name: '오지현', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
  { id: 'sh-ops', name: '김운영', org_type: 'CLIENT', org: 'ACME', role: '운영 담당' },
];
const APV = { approver_id: 'sh-cl', date: addDays(T, -5), method: 'SIGNED', evidence: '검수확인서 서명본 수령' };
const g = async (A) => (await A.c('GET', A.purl)).json;
const ph = (G, key) => G.phases.find((x) => x.phase_key === key);
const st = (G, key, phase = 'OPERATIONS') => ph(G, phase).steps.find((s) => s.step_key === key);
const toPhase = async (A, target) => {
  const order = ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];
  for (const key of order.slice(0, order.indexOf(target) + 1)) {
    const G = await g(A); if (G.project.current_phase === key) continue;
    assert.equal((await A.c('POST', `${A.purl}/phases/${ph(G, key).id}/activate`, { reason: 'NEXT' })).status, 200, key);
  }
};
const mkReq = async (A, title, { scope = 'IN_SCOPE', confirm = true } = {}) => {
  const r = (await A.c('POST', A.req, { title, scope })).json.requirement;
  if (confirm) assert.equal((await A.c('PATCH', `${A.req}/${r.id}`, { status: 'CONFIRMED' })).status, 200);
  return r;
};
const mkTest = async (A, r, result = 'PASS') => {
  const t = (await A.c('POST', `${A.purl}/tests`, { title: `${r.title} 테스트` })).json.test;
  await A.c('POST', `${A.purl}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: r.id });
  const x = result ? (await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result })).json.execution : null;
  return { t, x };
};

/** A project with data through 06: 목표 · 요구사항 (범위 내 2 + 범위 밖 1) · 테스트 (통과 · 제외 · 결함 이슈 해결) · 오픈 milestone pushed +5일 with a reason ·
 * 변경 요청 승인 → 반영 + 승인 후 미반영 1건 · 검수 승인 (고객 승인 기록) · 오픈 with 운영 이관 ISS + CR → 07. */
async function ready07(A, { carry = true } = {}) {
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: STAKE, goal: '주문 처리 시간을 30% 줄인다\n둘째 줄' });
  const r1 = await mkReq(A, '주문 조회'); const r2 = await mkReq(A, '정산 리포트'); await mkReq(A, '모바일 앱', { scope: 'OUT_OF_SCOPE', confirm: false });
  await A.c('PATCH', `${A.req}/${r2.id}/test-exclusion`, { reason: '고객 정산팀이 수기로 확인' });
  const { t: t1, x: x1 } = await mkTest(A, r1, 'FAIL');
  const issueFromTest = (await A.c('POST', `${A.purl}/tests/${t1.id}/executions/${x1.id}/issue`, {})).json;
  const defect = issueFromTest.issue || issueFromTest;
  await A.c('POST', `${A.purl}/tests/${t1.id}/executions`, { result: 'PASS', resolve_issue_ids: [defect.id] });
  const ms = (await A.c('POST', A.wbs, { item_type: 'MILESTONE', title: '오픈', milestone_date: addDays(T, -10) })).json;
  const msId = (ms.item || ms).id;
  await toPhase(A, 'DEVELOPMENT');   // freezes 최초 계획 종료일
  const pushed = await A.c('PATCH', `${A.wbs}/${msId}`, { milestone_date: addDays(T, -5), delay_reason: '고객 데이터 이관 지연' });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
  const cr1 = (await A.c('POST', `${A.purl}/changes`, { title: '주문 상태 문구 변경' })).json.change;
  await A.c('POST', `${A.purl}/changes/${cr1.id}/transition`, { action: 'submit' });
  await A.c('POST', `${A.purl}/changes/${cr1.id}/transition`, { action: 'approve', customer_approval: APV });
  await A.c('POST', `${A.purl}/changes/${cr1.id}/transition`, { action: 'implement' });
  const cr2 = (await A.c('POST', `${A.purl}/changes`, { title: '엑셀 내려받기 추가' })).json.change;
  await A.c('POST', `${A.purl}/changes/${cr2.id}/transition`, { action: 'submit' });
  await A.c('POST', `${A.purl}/changes/${cr2.id}/transition`, { action: 'approve', customer_approval: APV });
  await toPhase(A, 'TRANSITION_GO_LIVE');
  const acc = (await A.c('POST', `${A.purl}/acceptances`, { title: '1차 검수', requirements: [r1.id, r2.id] })).json.acceptance;
  await A.c('POST', `${A.purl}/acceptances/${acc.id}/transition`, { action: 'submit' });
  assert.equal((await A.c('POST', `${A.purl}/acceptances/${acc.id}/transition`, { action: 'accept', customer_approval: APV })).status, 200);
  const iss = (await A.c('POST', `${A.purl}/issues`, { title: '야간 배치 지연', severity: 'CRITICAL' })).json;
  const issue = iss.issue || iss.item || iss;
  const open = (await A.c('GET', `${A.purl}/go-live`)).json.open_items;
  assert.deepEqual(open.map((x) => x.type).sort(), ['CR', 'ISSUE']);
  const r = await A.c('POST', `${A.purl}/go-live`, { date: addDays(T, -2), carryovers: open.map((x) => ({ type: x.type, id: x.id, note: carry ? `${x.display_id} 운영팀 처리` : 'x' })) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await toPhase(A, 'OPERATIONS');
  return { r1, r2, cr1, cr2, issue, acc, defect, msId };
}
const handoverBody = (G, owners = {}) => ({ receiver: 's:sh-ops', date: addDays(T, -1),
  owners: G.go_live.carryovers.map((c) => ({ type: c.type, id: c.id, owner: owners[c.type] ?? 's:sh-ops' })) });

/* ---------- US-1 ---------- */
test('US-1 완료보고서: 7 sections filled with numbers; one per project; finalize → CLOSE 완료; PDF/Word; manual CLOSE needs a reason (422)', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const F = await ready07(A);
  let G = await g(A);
  assert.equal(st(G, 'CLOSE').state, 'NOT_STARTED'); assert.equal(st(G, 'CLOSE').cta.href, `/app/projects/${A.p.id}/reports?new=completion`);
  assert.equal(st(G, 'CLOSE').manual, true, '완료 처리 (사유) stays offered');
  // HANDOVER first so 6절 shows the owners
  assert.equal((await A.c('POST', `${A.purl}/handover`, handoverBody(G, { CR: 'TBD' }))).status, 200);
  let r = await A.c('POST', `${A.purl}/weekly-reports/completion`, {});
  assert.equal(r.status, 201); assert.equal(r.json.existing, false);
  const rep = r.json.report;
  assert.equal(rep.report_type, 'COMPLETION'); assert.equal(rep.status, 'DRAFT'); assert.equal(rep.title, '테스트 프로젝트 완료보고서');
  const S = Object.fromEntries(rep.structured_content.sections.map((s) => [s.key, s]));
  assert.deepEqual(rep.structured_content.sections.map((s) => s.title), ['개요', '범위', '일정', '품질', '검수', '남은 일 (운영 이관)', '교훈']);
  assert.match(S.overview.body, /목표: 주문 처리 시간을 30% 줄인다\n/); assert.doesNotMatch(S.overview.body, /둘째 줄/);
  assert.match(S.overview.body, /계약 기간: 2026-11-01 ~ 2027-02-28/);
  assert.match(S.overview.body, new RegExp(`오픈일: 최초 계획 ${addDays(T, -10)} → 실제 ${addDays(T, -2)} \\(\\+8일\\)`));
  assert.match(S.scope.body, /범위 내 확정 요구사항 2건 · 범위 밖 1건/); assert.match(S.scope.body, /변경 요청 승인 2건 \/ 반영 1건/);
  assert.match(S.schedule.body, /미룬 작업 1건 · 최초 계획 대비 총 \+5일/); assert.match(S.schedule.body, /\+5일 · 고객 데이터 이관 지연/);
  assert.match(S.quality.body, /테스트 1건 · 최근 통과 1건 · 제외 1건/); assert.match(S.quality.body, /제외 사유: 고객 정산팀이 수기로 확인/);
  assert.match(S.quality.body, /테스트에서 나온 이슈 1건 \(해결 1건\)/);
  assert.match(S.acceptance.body, new RegExp(`${F.acc.display_id} 1차 검수 — 오지현 고객 PM · ${APV.date} · 서명본 수령`));
  assert.match(S.carryover.body, /운영 인수: 김운영\(고객사\)/); assert.match(S.carryover.body, /운영 이관 2건/);
  assert.match(S.carryover.body, new RegExp(`${F.issue.display_id} 야간 배치 지연 — .* · 운영 담당 김운영\\(고객사\\)`));
  assert.match(S.carryover.body, new RegExp(`${F.cr2.display_id} .* · 운영 담당 미정`));
  assert.match(S.carryover.body, /앞 단계 미완료 필수 업무 \d+건 \(01 착수 \d+건 · 02 /, 'same line as the 06→07 dialog (one label per phase)');
  assert.deepEqual(S.lessons.fields.map((x) => x.label), ['잘된 점', '아쉬운 점', '다음에 할 일']); assert.ok(S.lessons.fields.every((x) => x.body === ''), 'no auto fill');
  assert.match(rep.rendered_content, /^# 테스트 프로젝트 완료보고서\n\n프로젝트 기간: /);
  // DRAFT → CLOSE 진행 중; the weekly 04/05/06 state ignores it
  G = await g(A); assert.equal(st(G, 'CLOSE').state, 'IN_PROGRESS'); assert.equal(st(G, 'CLOSE').cta.href, `/app/projects/${A.p.id}/reports/${rep.id}`);
  assert.equal(st(G, 'WEEKLY_REPORT', 'TRANSITION_GO_LIVE').state === 'COMPLETED', false, 'a 완료보고서 is not this week\'s 주간보고');
  // second generate opens the same report
  r = await A.c('POST', `${A.purl}/weekly-reports/completion`, {});
  assert.equal(r.status, 200); assert.equal(r.json.existing, true); assert.equal(r.json.report.id, rep.id);
  // edit: a section body + the 교훈 fields
  r = await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { sections: [{ key: 'scope', body: '- 범위 내 2건 (고객 확인)' }, { key: 'lessons', fields: { good: '- 기준선 승인을 일찍 받았다', next: '- 이관 리허설을 두 번 한다' } }] });
  assert.equal(r.status, 200);
  assert.match(r.json.report.rendered_content, /\*\*잘된 점\*\*\n- 기준선 승인을 일찍 받았다\n\n\*\*아쉬운 점\*\*\n없음\n\n\*\*다음에 할 일\*\*\n- 이관 리허설을 두 번 한다/);
  assert.equal((await A.c('PATCH', `${A.purl}/weekly-reports/${rep.id}`, { sections: [{ key: 'lessons', fields: { nope: 'x' } }] })).status, 400);
  // finalize → CLOSE 완료 (data), PDF / Word
  r = await A.c('POST', `${A.purl}/weekly-reports/${rep.id}/finalize`, {});
  assert.equal(r.status, 200);
  G = await g(A); assert.equal(st(G, 'CLOSE').state, 'COMPLETED'); assert.match(st(G, 'CLOSE').text, /✓ 완료보고서 확정/);
  assert.equal(G.completion_report.state, 'FINAL');
  for (const ext of ['pdf', 'docx']) {
    const d = await A.c('GET', `${A.purl}/weekly-reports/${rep.id}/export.${ext}`, undefined, { raw: true });
    assert.equal(d.status, 200, ext); assert.ok(d.buf.length > 1000, ext);
    assert.match(decodeURIComponent(d.headers.get('content-disposition')), /완료보고서\.(pdf|docx)/);
  }
  // listed with the weekly reports, typed
  const list = (await A.c('GET', `${A.purl}/weekly-reports`)).json.items;
  assert.equal(list.find((x) => x.id === rep.id).report_type, 'COMPLETION');
  server.close();
});

test('US-1 CLOSE 수동 완료: without a FINAL 완료보고서 the reason is required (422); 07 이전에는 만들 수 없음 (409)', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  assert.equal((await A.c('POST', `${A.purl}/weekly-reports/completion`, {})).status, 409, '07 이전');
  await toPhase(A, 'OPERATIONS');
  const G = await g(A); const close = st(G, 'CLOSE');
  let r = await A.c('PATCH', `${A.purl}/steps/${close.id}`, { status: 'COMPLETED' });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'reason_required');
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${close.id}`, { status: 'COMPLETED', reason: '   ' })).status, 422);
  r = await A.c('PATCH', `${A.purl}/steps/${close.id}`, { status: 'COMPLETED', reason: '고객사 양식으로 작성해 전달함' });
  assert.equal(r.status, 200); assert.equal(st(r.json, 'CLOSE').state, 'COMPLETED');
  assert.match(st(r.json, 'CLOSE').note, /^\[외부 완료보고서\] 고객사 양식으로 작성해 전달함 · /);
  server.close();
});

/* ---------- US-2 ---------- */
test('US-2 종료: 409 until 07 필수 done; 미래 종료일 422; 하자보수 = 종료일 + 12개월; header data; Home 완료 묶음; What\'s Next CLOSED; 종료 취소; 보관 그대로', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const other = (await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: '진행 중 프로젝트', client_name: 'B', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' })).json.project;
  await toPhase(A, 'OPERATIONS');
  assert.equal((await A.c('POST', `${A.purl}/close`, {})).status, 409, 'HANDOVER · CLOSE open');
  let G = await g(A);
  assert.equal((await A.c('POST', `${A.purl}/handover`, { receiver: `u:${A.uid}`, date: T })).status, 200);
  let r = await A.c('PATCH', `${A.purl}/steps/${st(G, 'CLOSE').id}`, { status: 'COMPLETED', reason: '외부 문서' });
  assert.equal(st(r.json, 'CLOSE').state, 'COMPLETED');
  assert.equal(r.json.guidance.rule, 'OPS_CLOSE'); assert.equal(r.json.guidance.primary_action.label, '프로젝트 종료'); assert.equal(r.json.guidance.primary_action.href, `/app/projects/${A.p.id}?close=1`);
  r = await A.c('POST', `${A.purl}/close`, { closed_on: addDays(T, 1) });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'invalid_closed_on');
  assert.equal((await A.c('POST', `${A.purl}/close`, { closed_on: T, warranty_end_on: addDays(T, -1) })).status, 422, '하자보수 < 종료일');
  const day = addDays(T, -1);
  r = await A.c('POST', `${A.purl}/close`, { closed_on: day });
  assert.equal(r.status, 200);
  assert.equal(r.json.project.status, 'COMPLETED'); assert.equal(String(r.json.project.closed_on).slice(0, 10), day);
  assert.equal(String(r.json.project.warranty_end_on).slice(0, 10), addMonths(day, 12));
  assert.equal(addMonths('2026-10-30', 12), '2027-10-30'); assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(r.json.guidance.rule, 'CLOSED'); assert.equal(r.json.guidance.title, '프로젝트가 종료되었습니다');
  assert.equal(r.json.guidance.primary_action.label, '완료보고서 보기'); assert.deepEqual(r.json.guidance.warnings, []);
  assert.match(r.json.guidance.description, /하자보수 \d{4}\/\d{2}\/\d{2}까지/);
  assert.equal((await A.c('POST', `${A.purl}/close`, {})).status, 409, 'already closed');
  // not locked: an issue can still be recorded during 하자보수
  assert.equal((await A.c('POST', `${A.purl}/issues`, { title: '하자: 버튼 정렬', severity: 'LOW' })).status, 201);
  assert.equal((await g(A)).guidance.rule, 'CLOSED', 'no 독촉 after close');
  // Home: out of the live list, into 완료된 프로젝트 with 완료일
  let home = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json;
  assert.deepEqual(home.projects.map((c) => c.id), [other.id]);
  assert.equal(home.completed.length, 1); assert.equal(home.completed[0].id, A.p.id); assert.equal(String(home.completed[0].closed_on).slice(0, 10), day);
  // 이력
  const act = (await A.c('GET', `${A.purl}/activity`)).json.items;
  assert.ok(act.some((x) => x.summary === '프로젝트 종료'));
  assert.ok(!(await g(A)).history.some((h) => h.reason === 'PROJECT_CLOSED'), 'not a phase move');
  // 종료 취소
  r = await A.c('POST', `${A.purl}/reopen`, {});
  assert.equal(r.status, 200); assert.equal(r.json.project.status, 'ACTIVE'); assert.equal(r.json.project.closed_on, null);
  assert.notEqual(r.json.guidance.rule, 'CLOSED');
  assert.equal((await A.c('POST', `${A.purl}/reopen`, {})).status, 409);
  home = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json;
  assert.ok(home.projects.some((c) => c.id === A.p.id)); assert.equal(home.completed.length, 0);
  // 보관 is separate: archive / unarchive a closed project keeps COMPLETED
  await A.c('POST', `${A.purl}/close`, { closed_on: day });
  assert.equal((await A.c('POST', `${A.purl}/archive`, {})).status, 200);
  assert.equal((await A.c('POST', `${A.purl}/reopen`, {})).status, 409, 'archived → read only');
  r = await A.c('POST', `${A.purl}/unarchive`, {});
  assert.equal(r.json.project.status, 'COMPLETED');
  server.close();
});

/* ---------- US-3 ---------- */
test('US-3 HANDOVER: 인수자·인수일 required (422), 운영 담당 per item (미정 allowed, warn count), shown on the row and in the report', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const F = await ready07(A);
  let G = await g(A);
  const ho = st(G, 'HANDOVER');
  assert.equal(ho.handover, true); assert.equal(ho.cta.href, `/app/projects/${A.p.id}?handover=1`);
  let r = await A.c('PATCH', `${A.purl}/steps/${ho.id}`, { status: 'COMPLETED' });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'handover_required');
  r = await A.c('POST', `${A.purl}/handover`, { date: T });
  assert.equal(r.status, 422); assert.ok(r.json.error.fields.receiver);
  r = await A.c('POST', `${A.purl}/handover`, { receiver: 's:sh-ops' });
  assert.equal(r.status, 422); assert.ok(r.json.error.fields.date);
  r = await A.c('POST', `${A.purl}/handover`, { receiver: 's:sh-ops', date: addDays(T, 1), owners: handoverBody(G).owners });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'invalid_handover_date');
  r = await A.c('POST', `${A.purl}/handover`, { receiver: 's:nobody', date: T, owners: handoverBody(G).owners });
  assert.equal(r.status, 422);
  r = await A.c('POST', `${A.purl}/handover`, { receiver: 's:sh-ops', date: T });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'owner_required', '운영 담당 is required (미정 allowed)');
  // GET: picker groups (고객사 first in the client), carryovers with owners
  const H0 = (await A.c('GET', `${A.purl}/handover`)).json;
  assert.equal(H0.handover, null); assert.equal(H0.carryovers.length, 2); assert.ok(H0.owners.clients.some((x) => x.id === 'sh-ops'));
  // 담당만 저장 (before 인수): one assigned, one 미정
  r = await A.c('PATCH', `${A.purl}/carryovers/owners`, { owners: [{ type: 'ISSUE', id: F.issue.id, owner: 's:sh-ops' }, { type: 'CR', id: F.cr2.id, owner: 'TBD' }] });
  assert.equal(r.status, 200); assert.deepEqual(r.json.owner_counts, { total: 2, assigned: 1, tbd: 1 });
  assert.equal(r.json.guidance.warnings[0], '운영 이관 2건 · 담당 지정 1/2');
  assert.equal(st(r.json, 'HANDOVER').state === 'COMPLETED', false, 'owners alone do not complete it');
  assert.equal((await A.c('PATCH', `${A.purl}/carryovers/owners`, { owners: [{ type: 'ISSUE', id: F.issue.id, owner: 'u:stranger' }] })).status, 400);
  // 인수 완료 through PATCH steps (handover field) — owners already stored count
  r = await A.c('PATCH', `${A.purl}/steps/${ho.id}`, { status: 'COMPLETED', handover: { receiver: 's:sh-ops', date: addDays(T, -1) } });
  assert.equal(r.status, 200); assert.equal(r.json.owner_counts.tbd, 1);
  const row = st(r.json, 'HANDOVER');
  assert.equal(row.state, 'COMPLETED');
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(addDays(T, -1));
  assert.equal(row.text, `✓ 인수 · ${Number(m[1])}/${Number(m[2])} · 김운영(고객사)`);
  assert.equal(r.json.handover.receiver_name, '김운영(고객사)');
  const carried = r.json.go_live.carryovers;
  assert.equal(carried.find((c) => c.type === 'ISSUE').owner_name, '김운영(고객사)'); assert.equal(carried.find((c) => c.type === 'CR').owner_name, '미정');
  // the report 6절 names the owners
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/completion`, {})).json.report;
  const six = rep.structured_content.sections.find((s) => s.key === 'carryover').body;
  assert.match(six, /운영 담당 김운영\(고객사\)/); assert.match(six, /운영 담당 미정/);
  server.close();
});

/* ---------- US-4 ---------- */
test('US-4 넘긴 건 독촉하지 않음: carried ISS + CR only → no 독촉, one warn line; a new issue after 오픈 still counts; Home 확인 필요 skips carried', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await ready07(A);
  let G = await g(A);
  assert.deepEqual(G.guidance.warnings, ['운영 이관 2건 · 담당 지정 0/2'], 'no 심각한 이슈 / 미반영 변경 numbers for carried items');
  assert.equal(G.guidance.warning_links['운영 이관 2건 · 담당 지정 0/2'], `/app/projects/${A.p.id}?handover=1`);
  assert.notEqual(G.guidance.rule, 'OPS_ISSUES');
  assert.doesNotMatch(st(G, 'MAINTENANCE').text, /열린 이슈/);
  let home = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json.projects[0];
  assert.ok(!home.attention.items.some((i) => i.type === 'ISSUE' || i.type === 'CHANGE'), JSON.stringify(home.attention));
  assert.ok(!home.guidance.warnings.some((w) => /심각|미반영/.test(w)));
  await A.c('POST', `${A.purl}/issues`, { title: '오픈 뒤 새 이슈', severity: 'HIGH' });
  G = await g(A);
  assert.equal(G.guidance.rule, 'OPS_ISSUES'); assert.match(G.guidance.description, /오픈 뒤 새로 열린 이슈 1건/);
  assert.match(st(G, 'MAINTENANCE').text, /오픈 뒤 열린 이슈 1건/);
  home = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json.projects[0];
  assert.equal(home.attention.items.filter((i) => i.type === 'ISSUE').length, 1);
  server.close();
});

/* ---------- US-5 · US-6 · guidance order ---------- */
test('US-5 07 문구 · US-6 앞 단계 요약 + 교훈 · 07 화면 영어 없음; guidance ladder HANDOVER → 완료보고서 → 종료', () => {
  const ops = PHASE_BY_KEY.OPERATIONS;
  assert.equal(ops.description, '운영 조직에 인수인계하고, 완료보고서로 결과를 정리한 뒤 프로젝트를 종료합니다.');
  const S = Object.fromEntries(ops.steps.map((s) => [s.key, s]));
  assert.match(S.SLA.description, /^운영 계약이 있으면 — /); assert.match(S.RELEASE_PLAN.description, /^운영 계약이 있으면 — /);
  assert.equal(S.SLA.importance, 'OPTIONAL'); assert.equal(S.RELEASE_PLAN.importance, 'OPTIONAL');
  assert.match(S.MAINTENANCE.description, /하자보수 기간의 요청 접수 경로/);
  assert.equal(S.CLOSE.completion_criteria, '완료보고서가 확정되어 있습니다.');
  assert.ok(CHECKLIST_TEMPLATES.CLOSE.includes('교훈 정리'));
  const all = [ops.description, ...ops.steps.flatMap((s) => [s.title, s.description, s.completion_criteria]), ...['HANDOVER', 'MAINTENANCE', 'SLA', 'RELEASE_PLAN', 'CLOSE'].flatMap((k) => CHECKLIST_TEMPLATES[k])].join(' ');
  assert.doesNotMatch(all.replace(/SLA/g, ''), /[A-Za-z]{3,}/, '07 영어 UI 없음 (SLA is the only acronym)');
  // priorGaps: REQUIRED open in phases before 07
  const phases = [
    { phase_key: 'REQUIREMENTS', sequence: 2, name: '요구사항 정의', steps: [{ step_key: 'BASELINE_APPROVAL', title: '요구사항 기준선 승인(고객)', importance: 'REQUIRED', state: 'IN_PROGRESS' }, { step_key: 'INTERFACE', title: 'x', importance: 'OPTIONAL', state: 'NOT_STARTED' }] },
    { phase_key: 'DEVELOPMENT', sequence: 4, name: '구현', steps: [{ step_key: 'ISSUES', title: '이슈 관리', importance: 'REQUIRED', state: 'COMPLETED' }] },
    { phase_key: 'TESTING', sequence: 5, name: '시험', steps: [{ step_key: 'RUN', title: '테스트 수행', importance: 'REQUIRED', state: 'NOT_STARTED' }] },
    { phase_key: 'OPERATIONS', sequence: 7, name: '운영', steps: [{ step_key: 'CLOSE', title: '프로젝트 종료 정리', importance: 'REQUIRED', state: 'NOT_STARTED' }] },
  ];
  assert.equal(priorGapsText(priorGaps(phases)), '앞 단계 미완료 필수 업무 2건 (02 요구사항 기준선 승인(고객) · 05 테스트 수행)');
  assert.equal(priorGapsText([]), '');
  // ladder
  const P = { id: 'p1', status: 'ACTIVE' }; const steps = (h, c) => [{ step_key: 'HANDOVER', state: h, importance: 'REQUIRED' }, { step_key: 'CLOSE', state: c, importance: 'REQUIRED' }];
  const G = (h, c, extra = {}) => projectGuidance({ project: P, phase: { phase_key: 'OPERATIONS', name: '운영 및 유지보수', sequence: 7, steps: steps(h, c), summary: { gate_met: h === 'COMPLETED' && c === 'COMPLETED' } }, stats: {}, ...extra });
  assert.equal(G('NOT_STARTED', 'NOT_STARTED').primary_action.label, '인수 완료 처리');
  assert.equal(G('COMPLETED', 'NOT_STARTED').primary_action.label, '완료보고서 만들기');
  assert.equal(G('COMPLETED', 'IN_PROGRESS', { completion_report: { state: 'DRAFT', report_id: 'r1' } }).primary_action.href, '/app/projects/p1/reports/r1');
  assert.equal(G('COMPLETED', 'COMPLETED').rule, 'OPS_CLOSE');
  const closed = projectGuidance({ project: { id: 'p1', status: 'COMPLETED', closed_on: '2026-10-30', warranty_end_on: '2027-10-30' }, phase: { phase_key: 'OPERATIONS', steps: [] }, stats: { issues: { active: 3, critical: 1 } }, completion_report: { report_id: 'r9' } });
  assert.equal(closed.rule, 'CLOSED'); assert.equal(closed.description.startsWith('10/30 종료 · 하자보수 2027/10/30까지'), true);
  assert.deepEqual(closed.warnings, []); assert.equal(closed.primary_action.href, '/app/projects/p1/reports/r9');
});

/* ---------- migration 38 ---------- */
test('migration 38: report_type + 1건 index, closed_on / warranty / handover columns, 07 copy on existing projects, 교훈 rename keeps PM titles; idempotent', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  await toPhase(A, 'OPERATIONS');
  const G = await g(A);
  const close = st(G, 'CLOSE');
  // pretend a pre-38 project: old copy + old checklist titles
  await db.run(`UPDATE project_phases SET description = '운영 조직에 이관하고 유지보수 체계, SLA, 정기 배포 계획을 정리해 프로젝트를 마무리합니다.' WHERE project_id = ? AND phase_key = 'OPERATIONS'`, [A.p.id]);
  await db.run(`UPDATE project_steps SET description = '결과 공유, 미결 사항, 교훈을 정리하고 프로젝트를 종료합니다.', completion_criteria = '종료 정리가 기록되어 있습니다.' WHERE id = ?`, [close.id]);
  await A.c('POST', `${A.purl}/steps/${close.id}/checklist/defaults`, {});
  const items = (await A.c('GET', `${A.purl}/checklists`)).json.items.filter((i) => i.step_id === close.id);
  await db.run(`UPDATE activity_checklist_items SET title = '교훈(Lessons Learned) 정리' WHERE id = ?`, [items.find((i) => /교훈/.test(i.title)).id]);
  const custom = items.find((i) => !/교훈/.test(i.title));
  await db.run(`UPDATE activity_checklist_items SET title = 'PM이 고친 제목' WHERE id = ?`, [custom.id]);
  const m38 = migrations.find((m) => m.version === 38); assert.ok(m38); assert.ok(migrations[migrations.length - 1].version >= 38);
  await m38.up(db); await m38.up(db);
  const P = await db.get(`SELECT description FROM project_phases WHERE project_id = ? AND phase_key = 'OPERATIONS'`, [A.p.id]);
  assert.equal(P.description, PHASE_BY_KEY.OPERATIONS.description);
  const S = await db.get('SELECT description, completion_criteria FROM project_steps WHERE id = ?', [close.id]);
  assert.equal(S.completion_criteria, '완료보고서가 확정되어 있습니다.');
  const titles = (await db.all('SELECT title FROM activity_checklist_items WHERE step_id = ?', [close.id])).map((x) => x.title);
  assert.ok(titles.includes('교훈 정리')); assert.ok(!titles.some((t) => /Lessons/.test(t))); assert.ok(titles.includes('PM이 고친 제목'));
  // columns + constraints
  const cols = (await db.all(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name IN ('report_type','closed_on','warranty_end_on','handover')`)).map((c) => `${c.table_name}.${c.column_name}`).sort();
  assert.deepEqual(cols, ['project_definitions.handover', 'projects.closed_on', 'projects.warranty_end_on', 'weekly_reports.report_type']);
  await A.c('POST', `${A.purl}/weekly-reports/completion`, {});
  await assert.rejects(db.run(`INSERT INTO weekly_reports (id, project_id, report_type, period_start, period_end, created_by) VALUES ('dup', ?, 'COMPLETION', '2026-01-01', '2026-01-02', ?)`, [A.p.id, A.uid]), /unique|duplicate/i);
  await assert.rejects(db.run(`INSERT INTO weekly_reports (id, project_id, report_type, period_start, period_end, created_by) VALUES ('bad', ?, 'OTHER', '2026-01-01', '2026-01-02', ?)`, [A.p.id, A.uid]));
  assert.equal((await db.get(`SELECT report_type FROM weekly_reports WHERE project_id = ? LIMIT 1`, [A.p.id])).report_type, 'COMPLETION');
  server.close();
});

/* ---------- acceptance fixes (M2 · Q16-3) ---------- */
test('M2 운영 이관: a carried CRITICAL issue + approved CR are not open work — 04 ISSUES met, no 심각한 이슈 in guidance or 완료보고서 6절', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const F = await ready07(A);
  const G = await g(A);
  const iss = st(G, 'ISSUES', 'DEVELOPMENT');
  assert.equal(iss.state, 'COMPLETED', JSON.stringify(iss)); assert.match(iss.text, /1건 운영 이관/);
  assert.doesNotMatch(st(G, 'CHANGES', 'DEVELOPMENT').text, /미반영/);
  const all = JSON.stringify([G.guidance, G.phases.map((p) => p.steps.map((s) => s.text))]);
  assert.doesNotMatch(all, /심각한 이슈|심각 \d|미반영 변경/);
  assert.ok(!G.prior_gaps.some((x) => x.step_key === 'ISSUES'), JSON.stringify(G.prior_gaps));
  assert.equal((await A.c('POST', `${A.purl}/handover`, handoverBody(G))).status, 200);
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/completion`, {})).json.report;
  const six = rep.structured_content.sections.find((s) => s.key === 'carryover').body;
  assert.match(six, new RegExp(`${F.issue.display_id} 야간 배치 지연`), 'still listed as handed over');
  assert.doesNotMatch(six, /04 이슈 관리|심각한 이슈/); assert.doesNotMatch(rep.rendered_content, /심각한 이슈/);
  // the issue screen still counts it (real data, not 독촉)
  assert.equal(Number((await A.c('GET', `${A.purl}/issues`)).json.issues.critical), 1);
  server.close();
});

test('Q16-3 종료일: not before 오픈일 (422, Korean message); 오픈일 itself is fine', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await ready07(A);
  let G = await g(A);
  assert.equal((await A.c('POST', `${A.purl}/handover`, handoverBody(G))).status, 200);
  G = await g(A);
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${st(G, 'CLOSE').id}`, { status: 'COMPLETED', reason: '외부 문서' })).status, 200);
  let r = await A.c('POST', `${A.purl}/close`, { closed_on: addDays(T, -3) });
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'invalid_closed_on');
  assert.match(JSON.stringify(r.json), new RegExp(`종료일은 오픈일\\(${addDays(T, -2)}\\)보다 앞설 수 없습니다`));
  r = await A.c('POST', `${A.purl}/close`, { closed_on: addDays(T, -2) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  server.close();
});
