/* Phase 1 (01 착수) v2: 착수보고회 (KICKOFF) · 착수 결과 승인 (APPROVAL) activities, re-approval detection, guidance ladder,
 * 사업수행계획서 export (PDF / Word, tables), josa helper, migration 31 for existing projects. Spec: hive research/relai-phase-1-spec.md. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { josa, pickJosa } from '../../public/app/shared/josa.js';
import { parseReportMarkdown } from '../report-export.js';
import { buildPlanMarkdown, planVersion } from '../charter-export.js';
import { KICKOFF_IMPORTANCE, APPROVAL_IMPORTANCE, PHASE_BY_KEY } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import { isMeasurable } from '../../public/app/shared/criteria.js';
import { LIFECYCLE_PHASES } from '../../public/app/shared/lifecycle.js';
import { DEFAULT_PHASES } from '../templates/default-phases.js';

const CORE = { goal: '계약 검토 리드타임 50% 단축', success_criteria: ['검토 리드타임 평균 2영업일 이내'], scope_in: ['국문 표준계약 5종 자동 검토'],
  stakeholders: [{ id: 'sh-client', name: '이수진', org_type: 'CLIENT', org: 'ACME', role: '차장', area: '요구사항 최종 승인' }, { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '당사', role: 'PM' }],
  key_dates: [{ title: '착수보고회', date: '2026-11-03' }, { title: '최종 검수', date: '2027-02-20' }], operations: { meetings: '주간 정례 월 10시' } };
const completeCore = async (A) => {
  assert.equal((await A.c('PUT', `${A.purl}/definition`, CORE)).status, 200);
  for (const k of ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS']) { const r = await A.c('POST', `${A.purl}/definition/sections/${k}/complete`, {}); assert.equal(r.status, 200, `${k} ${JSON.stringify(r.json)}`); }
};

test('template: 01 착수 = GOALS … OPERATIONS → KICKOFF (권장, one constant) → APPROVAL (권장 since batch7 #5, last)', () => {
  const st = PHASE_BY_KEY.INITIATION.steps;
  assert.deepEqual(st.map((s) => s.key), ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS', 'KICKOFF', 'APPROVAL']);
  assert.equal(st.find((s) => s.key === 'KICKOFF').importance, KICKOFF_IMPORTANCE); assert.equal(KICKOFF_IMPORTANCE, 'RECOMMENDED');
  assert.equal(st.at(-1).importance, APPROVAL_IMPORTANCE); assert.equal(APPROVAL_IMPORTANCE, 'RECOMMENDED');
});

test('KICKOFF: defaults, completion needs a held meeting + minutes/decisions, summaries (준비 중 n/m, 후속 조치 남음), skippable', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const D = `${A.purl}/definition`;
  let r = await A.c('GET', D);
  assert.deepEqual(r.json.sections.map((s) => s.key), ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS', 'KICKOFF', 'APPROVAL']);
  assert.deepEqual(r.json.progress, { done: 0, total: 5, percent: 0 });   // progress counts the five definition sections only
  assert.equal(r.json.definition.kickoff.prep.length, 4); assert.match(r.json.definition.kickoff.agenda, /질의응답/);
  const kick = () => r.json.sections.find((s) => s.key === 'KICKOFF');
  assert.equal(kick().skippable, true);
  r = await A.c('POST', `${D}/sections/KICKOFF/complete`, {}); assert.equal(r.status, 400); assert.match(r.json.error.fields.section, /일시/);
  // future meeting, 3 of 4 prepared → 준비 중 · 3/4 · 11/02 10:00 (진행 중 on What's Next)
  r = await A.c('PUT', D, { kickoff: { datetime: '2099-11-02T10:00', place: '고객사 대회의실', attendees: ['sh-client'], prep: [{ text: '안건 확정', done: true }, { text: '발표자료', done: true }, { text: '초대 발송', done: true }, { text: '회의실', done: false }] } });
  assert.equal(r.status, 200); assert.equal(kick().summary, '준비 중 · 3/4 · 11/02 10:00');
  r = await A.c('PUT', D, { kickoff: { datetime: '2099-11-02T10:00', prep: [] } });   // empty checklist → no "준비 중 · 0/0"
  assert.equal(r.status, 200); assert.equal(kick().summary, '예정 · 11/02 10:00');
  r = await A.c('PUT', D, { kickoff: { datetime: '2099-11-02T10:00', place: '고객사 대회의실', attendees: ['sh-client'], prep: [{ text: '안건 확정', done: true }, { text: '발표자료', done: true }, { text: '초대 발송', done: true }, { text: '회의실', done: false }] } });
  let g = await A.c('GET', A.purl);
  assert.equal(g.json.current_phase.steps.find((s) => s.step_key === 'KICKOFF').state, 'IN_PROGRESS');
  r = await A.c('POST', `${D}/sections/KICKOFF/complete`, {}); assert.equal(r.status, 400); assert.match(r.json.error.fields.section, /아직 열리지 않았습니다/);
  // held, but no minutes / decisions
  r = await A.c('POST', `${D}/sections/KICKOFF/complete`, { kickoff: { datetime: '2026-01-05T10:00' } }); assert.equal(r.status, 400); assert.match(r.json.error.fields.section, /회의록 요약 또는 결정사항/);
  r = await A.c('PUT', D, { kickoff: { datetime: '2026-13-05' } }); assert.equal(r.status, 400);
  r = await A.c('POST', `${D}/sections/KICKOFF/complete`, { kickoff: { datetime: '2026-01-05T10:00', attendees: ['sh-client'], decisions: ['범위 확정'], followups: [{ text: '회의록 송부', owner: '김피엠', due: '2026-01-07' }, { text: '계정 발급', done: false }, { text: '자료 공유', done: true }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(kick().status, 'COMPLETED'); assert.match(kick().summary, /후속 조치 2건 남음/);
  r = await A.c('POST', `${D}/sections/KICKOFF/reopen`, {}); r = await A.c('POST', `${D}/sections/KICKOFF/skip`, {}); assert.equal(r.status, 200); assert.equal(kick().status, 'SKIPPED');
  server.close();
});

test('APPROVAL (진행 여부 체크, 2026-10-21): 권장 → skippable, check needs no record, who/when stamped, optional note, uncheck clears, no re-approval loop', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const D = `${A.purl}/definition`;
  await completeCore(A);
  let r = await A.c('GET', D); const apv = () => r.json.sections.find((s) => s.key === 'APPROVAL');
  assert.equal(apv().importance, 'RECOMMENDED'); assert.equal(apv().skippable, true);
  assert.equal(apv().summary, '');   // unchecked → no summary
  assert.equal((await A.c('POST', `${D}/sections/APPROVAL/skip`, {})).status, 200);   // 권장: may be skipped, and resumed
  assert.equal((await A.c('POST', `${D}/sections/APPROVAL/resume`, {})).status, 200);
  // legacy fields are still validated when sent (승인일 ≤ today, method from the list)
  r = await A.c('PUT', D, { approval: { approver_id: 'sh-client', date: '2099-01-01', method: 'EMAIL', evidence: 'x' } });
  assert.equal(r.status, 400); assert.equal(r.json.error.fields['approval.date'], '승인일은 오늘 이후일 수 없습니다.');
  assert.equal((await A.c('PUT', D, { approval: { method: 'TELEPATHY' } })).status, 400);
  // 체크 with nothing recorded → allowed (was 400 승인자·승인일·방법·근거 missing)
  r = await A.c('POST', `${D}/sections/APPROVAL/complete`, {}); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(apv().status, 'COMPLETED'); assert.equal(apv().changed_after_completion, false);
  assert.match(apv().summary, /^✓ 확인 · 홍길동 · \d{4}-\d{2}-\d{2}$/);
  assert.equal(r.json.definition.approval.checked, true); assert.equal(r.json.definition.approval.checked_by_name, '홍길동'); assert.ok(r.json.definition.approval.checked_at);
  assert.equal(r.json.guide.guidance.rule, 'INIT_DONE');
  // 체크 해제 → TODO, who/when cleared
  r = await A.c('POST', `${D}/sections/APPROVAL/reopen`, {}); assert.equal(r.status, 200);
  assert.equal(apv().status, 'TODO'); assert.equal(r.json.definition.approval.checked, false); assert.equal(r.json.definition.approval.checked_at, null);
  // 체크 + one-line 메모 in one click
  r = await A.c('POST', `${D}/sections/APPROVAL/complete`, { approval: { note: '착수보고회에서 스폰서와 공유' } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.match(apv().summary, /^✓ 확인 · 홍길동 · .* · 착수보고회에서 스폰서와 공유$/);
  // legacy: a direct-entry approver sent with 이해관계자에도 추가 still becomes a CLIENT stakeholder (not an edit of 이해관계자)
  r = await A.c('PUT', D, { approval: { approver_name: '박스폰서', approver_title: '상무' } }); assert.equal(r.status, 200);
  const added = r.json.definition.stakeholders.find((s) => s.name === '박스폰서');
  assert.ok(added); assert.equal(added.org_type, 'CLIENT'); assert.equal(r.json.definition.approval.approver_id, added.id);
  assert.equal(r.json.sections.find((s) => s.key === 'STAKEHOLDERS').changed_after_completion, false);
  assert.equal(apv().status, 'COMPLETED'); assert.equal(r.json.definition.approval.checked, true);   // saving the record keeps the check
  let g = await A.c('GET', A.purl);
  let row = g.json.current_phase.steps.find((s) => s.step_key === 'APPROVAL');
  assert.equal(row.crit, false); assert.equal(row.state, 'COMPLETED'); assert.match(row.text, /^✓ 확인/);
  // no re-approval: 목표·일정·승인자 row changes never reopen the check (was REAPPROVAL)
  r = await A.c('PUT', D, { stakeholders: r.json.definition.stakeholders.map((s) => (s.id === added.id ? { ...s, role: '전무' } : s)) });
  assert.equal(apv().changed_after_completion, false); assert.ok(!apv().reapproval); assert.ok(!r.json.needs_review.includes('APPROVAL'));
  r = await A.c('PUT', D, { key_dates: [{ title: '착수보고회', date: '2026-11-04' }, { title: '최종 검수', date: '2027-02-20' }] }); assert.ok(!apv().reapproval);
  r = await A.c('PUT', D, { goal: '리드타임 70% 단축' }); assert.ok(!apv().reapproval); assert.equal(apv().status, 'COMPLETED');
  g = await A.c('GET', A.purl); assert.ok(!['INIT_REAPPROVE'].includes(g.json.guidance.rule));
  row = g.json.current_phase.steps.find((s) => s.step_key === 'APPROVAL'); assert.equal(row.state, 'COMPLETED'); assert.doesNotMatch(row.text, /다시 확인받으세요|승인 후/);
  const c = await A.c('GET', `${A.purl}/charter`); assert.equal(c.json.charter.approval.status, 'COMPLETED');
  assert.equal(c.json.charter.approval.checked, true); assert.equal(c.json.charter.approval.checked_by_name, '홍길동'); assert.equal(c.json.charter.approval.note, '착수보고회에서 스폰서와 공유');
  assert.equal(c.json.charter.approval.bypass, null);
  server.close();
});

test('guidance: INIT_DEFINE → INIT_KICKOFF → INIT_CHECK → INIT_DONE; skipped kickoff goes straight to the check; no bypass reason, 01→02 never blocked', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const D = `${A.purl}/definition`;
  let g = await A.c('GET', A.purl); assert.equal(g.json.guidance.rule, 'INIT_DEFINE');
  await completeCore(A);
  g = await A.c('GET', A.purl); assert.equal(g.json.guidance.rule, 'INIT_KICKOFF');
  assert.equal(g.json.guidance.primary_action.href, `/app/projects/${A.p.id}/definition?activity=KICKOFF`);
  assert.match(g.json.guidance.description, /착수보고회 전에 고객에게 보내고/); assert.doesNotMatch(g.json.guidance.description, /승인/);
  assert.equal(g.json.guidance.secondary_action.href, `/api/workspaces/${A.w}/projects/${A.p.id}/charter/export?format=pdf`);
  assert.equal(g.json.current_phase.summary.gate_met, true);   // APPROVAL is 권장 — the five sections open the gate
  await A.c('POST', `${D}/sections/KICKOFF/skip`, {});
  g = await A.c('GET', A.purl); assert.equal(g.json.guidance.rule, 'INIT_CHECK'); assert.equal(g.json.guidance.primary_action.label, '진행 여부 체크 →');
  assert.equal(g.json.guidance.primary_action.href, `/app/projects/${A.p.id}/definition?activity=APPROVAL`);
  assert.match(g.json.guidance.description, /체크하지 않아도 다음 단계로 넘어갈 수 있습니다/);
  // an old "[승인 전 진행]" note is just a note now: no INIT_DONE shortcut, no 미승인 warning, no bypass on the charter
  const step = g.json.current_phase.steps.find((s) => s.step_key === 'APPROVAL');
  let r = await A.c('PATCH', `${A.purl}/steps/${step.id}`, { note: '[승인 전 진행] 고객 일정상 승인 회신이 다음 주 · 2026-10-15 · 홍길동' }); assert.equal(r.status, 200);
  assert.equal(r.json.guidance.rule, 'INIT_CHECK'); assert.ok(!r.json.guidance.warnings.some((w) => /미승인|승인 전 진행/.test(w)));
  const row = r.json.current_phase.steps.find((s) => s.step_key === 'APPROVAL');
  assert.doesNotMatch(row.text, /승인 전 진행 · 사유 있음/);
  const c = await A.c('GET', `${A.purl}/charter`);
  assert.equal(c.json.charter.approval.bypass, null); assert.equal(c.json.charter.approval.checked, false);
  assert.equal(c.json.charter.kickoff.skipped, true);
  // 01→02 with the check still open: allowed
  const phases = r.json.phases; const req = phases.find((p) => p.phase_key === 'REQUIREMENTS');
  assert.equal((await A.c('POST', `${A.purl}/phases/${req.id}/activate`, { reason: 'NEXT' })).status, 200);
  server.close();
});

test('사업수행계획서 export: PDF + Word, Korean filename with version, version/footer by approval state, member access, 400 on bad format', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const X = `${A.purl}/charter/export`;
  let pdf = await A.c('GET', `${X}?format=pdf`, undefined, { raw: true });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.buf.toString('latin1'), /NanumGothic/);
  const cd = decodeURIComponent(pdf.headers.get('content-disposition').split("UTF-8''")[1]);
  assert.match(cd, /^테스트_프로젝트_사업수행계획서_v0\.9_\d{8}\.pdf$/);
  const docx = await A.c('GET', `${X}?format=docx`, undefined, { raw: true });
  assert.equal(docx.status, 200); assert.match(docx.headers.get('content-type'), /wordprocessingml/); assert.equal(docx.buf.subarray(0, 2).toString(), 'PK');
  assert.equal((await A.c('GET', `${X}?format=xls`)).status, 400);
  const M = await addMember(client, A, 'm@x.com', '멤버');   // any member who can see the project
  assert.equal((await M.c('GET', `${X}?format=pdf`, undefined, { raw: true })).status, 200);
  const B = await setup(client, 'b@x.com'); assert.equal((await B.c('GET', `${X}?format=pdf`)).status, 404);
  // after the 착수 결과 확인 체크 (no 승인 record needed) → v1.0 in the filename
  await completeCore(A);
  assert.equal((await A.c('POST', `${A.purl}/definition/sections/APPROVAL/complete`, {})).status, 200);
  pdf = await A.c('GET', `${X}?format=pdf`, undefined, { raw: true });
  assert.match(decodeURIComponent(pdf.headers.get('content-disposition')), /사업수행계획서_v1\.0_\d{8}\.pdf/);
  server.close();
});

test('plan markdown: fixed sections, 작성 가이드 for empty parts (never 작성되지 않음), tables, 확인란 rows, 체크 line (no bypass note), kickoff section hidden when skipped', () => {
  const c = { profile: { name: 'P', client: '고객', start_date: '2026-11-01', end_date: '2027-02-28', description: '', project_type: '', scale: '' }, goals: '', successCriteria: '', scope: { inScope: 'A\nB', outOfScope: '' }, deliverables: '',
    stakeholders: [{ name: '이수진', org: 'ACME', department: '', category: 'CLIENT', category_label: '고객사', role: '차장', responsibility: '최종 승인' }, { name: '김피엠', org: '당사', category: 'OWN', category_label: '당사', role: 'PM', responsibility: '' }],
    governance: '', timeline: { startDate: '2026-11-01', endDate: '2027-02-28', milestones: [{ title: '하자보수 종료', date: '2027-05-01', source: 'KEY_DATE' }] }, assumptions: '', constraints: '', risks: '',
    operatingModel: { communication: '', changeManagement: '', acceptance: '' }, kickoff: { skipped: true }, approval: { status: 'TODO', approver: null, bypass: { reason: '회신 대기', date: '2026-10-15', name: '홍길동' } } };
  const doc = buildPlanMarkdown(c, { workspaceName: '수행사', author: '홍길동', today: '2026-10-15' });
  for (const h of ['개정 이력', '1. 사업 개요', '2. 성공 기준', '3. 사업 범위', '4. 전제·제약·초기 리스크', '5. 추진 조직', '6. 사업 기간 및 마일스톤', '7. 운영 방식', '8. 확인']) assert.ok(doc.markdown.includes(`## ${h}`), h);
  assert.ok(!doc.markdown.includes('착수보고회'));   // skipped kickoff → section omitted
  assert.ok(!doc.markdown.includes('작성되지 않음')); assert.match(doc.markdown, /⟦작성 가이드: /); assert.match(doc.markdown, /\| 종료 후 \|/);
  assert.match(doc.markdown, /고객 확인: 아직 체크하지 않음/); assert.doesNotMatch(doc.markdown, /미승인|회신 대기/);   // a legacy bypass is not printed any more
  assert.equal(doc.version, 'v0.9 (초안)'); assert.equal(doc.footer, '초안');
  const blocks = parseReportMarkdown(doc.markdown); const tables = blocks.filter((b) => b.type === 'table');
  const org = tables.find((t) => t.header && t.header.includes('주요 책임'));
  assert.deepEqual(org.header, ['구분', '조직', '부서', '이름', '역할', '주요 책임']); assert.deepEqual(org.rows[0], ['고객사', 'ACME', '-', '이수진', '차장', '최종 승인']);
  const sign = tables.find((t) => t.header && t.header.includes('서명')); assert.deepEqual(sign.rows.map((r) => r[0]), ['고객사', '수행사']); assert.equal(sign.rows[1][1], '김피엠');
  assert.ok(blocks.some((b) => b.type === 'pagebreak'));
  const rev = () => tables.find((t) => t.header && t.header.includes('내용') && t.header.includes('버전'));
  assert.deepEqual(rev().rows, [['v0.9', '2026-10-15', '초안', '홍길동']]);   // draft: one row, matches the cover, no blank rows
  const checkedMd = buildPlanMarkdown({ ...c, approval: { status: 'COMPLETED', date: '2026-10-10', approver: null, checked: true, checked_by_name: '홍길동', checked_on: '2026-10-10', note: '착수보고회에서 공유' } }, { author: '홍길동', today: '2026-10-15' }).markdown;
  assert.match(checkedMd, /고객 확인: ✓ 체크됨 \(홍길동 · 2026-10-10\) · 착수보고회에서 공유/); assert.doesNotMatch(checkedMd, /승인 방법|근거:/);
  const approved = parseReportMarkdown(checkedMd).filter((x) => x.type === 'table').find((t) => t.header && t.header.includes('버전'));
  assert.deepEqual(approved.rows, [['v1.0', '2026-10-10', '확정', '홍길동']]);
  assert.deepEqual(planVersion({ status: 'COMPLETED' }), { version: 'v1.0', file: 'v1.0', footer: '' });
  assert.deepEqual(planVersion({ status: 'TODO' }), { version: 'v0.9 (초안)', file: 'v0.9', footer: '초안' });
  assert.doesNotMatch(planVersion({ status: 'REAPPROVAL' }).version, /재승인/);   // no re-approval state any more
});

test('josa: 받침 / ㄹ받침 / 받침 없음 / digits / Latin', () => {
  assert.equal(josa('요구사항 정의', '으로'), '요구사항 정의로');
  assert.equal(josa('분석·설계', '으로'), '분석·설계로');
  assert.equal(josa('운영', '으로'), '운영으로');
  assert.equal(josa('전환·오픈', '으로'), '전환·오픈으로');
  assert.equal(josa('서울', '으로'), '서울로');   // ㄹ받침 → 로
  assert.equal(josa('목표', '을'), '목표를'); assert.equal(josa('범위', '을'), '범위를'); assert.equal(josa('성공 기준', '를'), '성공 기준을');
  assert.equal(josa('이해관계자', '은'), '이해관계자는'); assert.equal(josa('착수', '이'), '착수가');
  assert.equal(pickJosa('3', '으로'), '으로'); assert.equal(pickJosa('2', '을'), '를'); assert.equal(pickJosa('WBS', '을'), '를'); assert.equal(pickJosa('Excel', '으로'), '로');
});

test('migration 31: existing projects get KICKOFF + APPROVAL in 01 as TODO (idempotent), later phases untouched', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  // simulate a pre-31 project: drop the two steps
  await db.run(`DELETE FROM project_steps WHERE step_key IN ('KICKOFF','APPROVAL') AND project_phase_id IN (SELECT id FROM project_phases WHERE project_id = ?)`, [A.p.id]);
  let r = await A.c('GET', `${A.purl}/definition`); assert.deepEqual(r.json.sections.map((s) => s.key), ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS']);
  const m31 = migrations.find((m) => m.version === 31);
  await m31.up(db); await m31.up(db);
  const rows = await db.all(`SELECT s.step_key, s.status, s.sequence, s.importance FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND p.phase_key = 'INITIATION' ORDER BY s.sequence`, [A.p.id]);
  assert.deepEqual(rows.map((x) => x.step_key), ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS', 'KICKOFF', 'APPROVAL']);
  assert.ok(rows.slice(5).every((x) => x.status === 'TODO')); assert.deepEqual(rows.slice(5).map((x) => x.importance), ['RECOMMENDED', 'RECOMMENDED']);
  r = await A.c('GET', `${A.purl}/definition`); assert.equal(r.json.sections.find((s) => s.key === 'APPROVAL').changed_after_completion, false);
  server.close();
});

test('success-criteria hint rule + Home 7-phase constant matches the server template', () => {
  assert.equal(isMeasurable('사용자 만족도 향상'), false);
  assert.equal(isMeasurable('만족도 4.0/5 이상'), true);
  assert.equal(isMeasurable('UAT Critical 결함 0건'), true);
  assert.equal(isMeasurable('검토 리드타임 단축(2영업일 이내)'), true);
  assert.deepEqual(LIFECYCLE_PHASES.map((p) => p.key), DEFAULT_PHASES.map((p) => p.key));
  assert.deepEqual(LIFECYCLE_PHASES.map((p) => [p.long, p.short]), DEFAULT_PHASES.map((p) => [p.name, p.short]));   // one phase-name constant (design §3.8)
});
