/* Phase 2 (02 요구사항 정의): 요구사항 기준선 승인 (BASELINE_APPROVAL, shared approval record), 요구사항 정의서 export (PDF / Word),
 * confirmed-requirement → change-request prompt rules, phase-aware 02 guidance (WBS hints from 03, Charter 제외 범위, INTERFACE 권장),
 * migration 32 for existing projects. Spec: hive research/relai-phase-2-spec.md (v2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { boot, setup } from './api-helpers.js';
import { PHASE_BY_KEY } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import { activityStates, activitySummary, COLLECT_HINT } from '../activities.js';
import { projectGuidance } from '../guidance.js';
import { buildReqDocMarkdown, NO_IN_SCOPE, NO_OUT_OF_SCOPE } from '../req-export.js';
import { parseReportMarkdown } from '../report-export.js';
import { needsPrompt, needsAddPrompt, proposalLine } from '../../public/app/requirements/change-rules.js';

const APV = { approver_name: '이수진', approver_title: '차장', date: '2026-01-10', method: 'EMAIL', evidence: "2026-01-10 회신 메일 '요구사항 정의서 v1.0 승인'" };
const toReq = async (A) => { const ph = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === 'REQUIREMENTS'); assert.equal((await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'NEXT' })).status, 200); };
const addReq = async (A, body) => (await A.c('POST', A.req, { type: 'FUNCTIONAL', priority: 'HIGH', ...body })).json.requirement;
const step = (g, phase, key) => g.phases.find((x) => x.phase_key === phase).steps.find((s) => s.step_key === key);
const stepsOf = (key) => PHASE_BY_KEY[key].steps.map((s, i) => ({ id: `s${i}`, step_key: s.key, title: s.title, description: s.description, completion_criteria: s.completion_criteria, importance: s.importance, linked_feature_type: s.linked_feature_type, status: 'TODO', note: '' }));
const stats = (requirements) => ({ requirements, wbs: {}, tests: {}, acceptances: {}, issues: {}, changes: {} });

test('template: 02 = … CONFIRM → BASELINE_APPROVAL (필수) → INTERFACE (선택)', () => {
  const st = PHASE_BY_KEY.REQUIREMENTS.steps;
  assert.deepEqual(st.map((s) => s.key), ['COLLECT', 'CLASSIFY', 'PRIORITIZE', 'SCOPE_CHECK', 'CONFIRM', 'BASELINE_APPROVAL', 'INTERFACE']);
  const b = st.find((s) => s.key === 'BASELINE_APPROVAL');
  assert.equal(b.title, '요구사항 기준선 승인(고객)'); assert.equal(b.importance, 'REQUIRED'); assert.equal(b.linked_feature_type, 'requirements');
});

test('US-1 기준선 승인: every field required, 승인일 ≤ today, not skippable (409), direct approver → 이해관계자 (01 untouched)', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toReq(A);
  await addReq(A, { title: 'R1', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  let r = await A.c('GET', `${A.req}/baseline`); const b0 = r.json.baseline;
  assert.equal(b0.status, 'TODO'); assert.deepEqual(Object.keys(b0.methods), ['SIGNED', 'EMAIL', 'REVIEW', 'OTHER']);
  assert.equal(b0.methods.REVIEW, '검토 회의에서 승인');
  // REQUIRED: PATCH steps {SKIPPED} → 409
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${b0.step_id}`, { status: 'SKIPPED' })).status, 409);
  // each missing field blocks 완료 처리
  r = await A.c('POST', `${A.req}/baseline/complete`, {}); assert.equal(r.status, 400); assert.match(r.json.error.fields.missing, /승인자[\s\S]*승인일[\s\S]*승인 방법[\s\S]*근거/);
  for (const k of ['approver_name', 'date', 'method', 'evidence']) {
    const a = { ...APV, [k]: '' }; r = await A.c('POST', `${A.req}/baseline/complete`, { approval: a }); assert.equal(r.status, 400, k);
  }
  r = await A.c('POST', `${A.req}/baseline/complete`, { approval: { ...APV, date: '2099-01-01' } }); assert.equal(r.status, 400); assert.equal(r.json.error.fields['approval.date'], '승인일은 오늘 이후일 수 없습니다.');
  assert.equal((await A.c('PUT', `${A.req}/baseline`, { approval: { method: 'KICKOFF' } })).status, 400, '01-only method is not a 02 method');
  r = await A.c('GET', `${A.req}/baseline`); assert.equal(r.json.baseline.status, 'TODO');
  // 임시저장 then 완료 처리 with a directly entered approver (+ 이해관계자에도 추가 by default)
  assert.equal((await A.c('PUT', `${A.req}/baseline`, { approval: { evidence: '메일' } })).status, 200);
  r = await A.c('POST', `${A.req}/baseline/complete`, { approval: APV }); assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = r.json.baseline; assert.equal(b.status, 'COMPLETED'); assert.equal(b.approver.name, '이수진'); assert.equal(b.summary, '이수진 차장 · 2026-01-10 · 이메일 회신');
  const def = (await A.c('GET', `${A.purl}/definition`)).json;
  const sh = def.definition.stakeholders.find((s) => s.name === '이수진'); assert.ok(sh); assert.equal(sh.org_type, 'CLIENT'); assert.equal(sh.area, '요구사항 기준선 승인');
  assert.equal(b.approval.approver_id, sh.id);
  assert.equal(def.sections.find((s) => s.key === 'STAKEHOLDERS').changed_after_completion, false);
  assert.equal(r.json.guide.guidance.rule, 'REQ_DONE');
  const g = (await A.c('GET', A.purl)).json; assert.equal(step(g, 'REQUIREMENTS', 'BASELINE_APPROVAL').state, 'COMPLETED');
  assert.match(step(g, 'REQUIREMENTS', 'BASELINE_APPROVAL').text, /이수진 차장 · 2026-01-10 · 이메일 회신/);
  // 완료 취소 → TODO, record kept
  r = await A.c('POST', `${A.req}/baseline/reopen`, {}); assert.equal(r.json.baseline.status, 'TODO'); assert.equal(r.json.baseline.approval.evidence, APV.evidence);
  server.close();
});

test('US-1 미확정 함께 확정: 3 unconfirmed + ON → all confirmed, CONFIRM + BASELINE_APPROVAL complete; OFF → blocked, nothing saved', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toReq(A);
  await addReq(A, { title: 'R1', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const open = [await addReq(A, { title: 'R2', scope: 'IN_SCOPE', status: 'DRAFT' }), await addReq(A, { title: 'R3', scope: 'IN_SCOPE', status: 'REVIEWING' }), await addReq(A, { title: 'R4', scope: 'IN_SCOPE', status: 'ON_HOLD' })];
  await addReq(A, { title: 'OUT', scope: 'OUT_OF_SCOPE', status: 'DRAFT' });
  let r = await A.c('GET', `${A.req}/baseline`); assert.deepEqual(r.json.baseline.counts, { total: 5, in_scope: 4, in_scope_confirmed: 1, in_scope_unconfirmed: 3, out_of_scope: 1 });
  // OFF → 400 "범위 내 미확정 3건이 있습니다. 먼저 확정하세요", nothing stored (approval, statuses, step)
  r = await A.c('POST', `${A.req}/baseline/complete`, { approval: APV, confirm_unconfirmed: false });
  assert.equal(r.status, 400); assert.equal(r.json.error.fields.section, '범위 내 미확정 3건이 있습니다. 먼저 확정하세요.');
  r = await A.c('GET', `${A.req}/baseline`); assert.equal(r.json.baseline.status, 'TODO'); assert.equal(r.json.baseline.approval.evidence, '', 'approval not saved');
  assert.equal(r.json.baseline.counts.in_scope_unconfirmed, 3);
  assert.equal((await A.c('GET', `${A.purl}/definition`)).json.definition.stakeholders.length, 0, 'approver not added either');
  // ON → one save: approval + 3 confirmed + 완료
  r = await A.c('POST', `${A.req}/baseline/complete`, { approval: APV, confirm_unconfirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.confirmed, 3); assert.equal(r.json.summary.in_scope_confirmed, 4);
  for (const x of open) { const d = (await A.c('GET', `${A.req}/${x.id}`)).json.requirement; assert.equal(d.status, 'CONFIRMED'); assert.ok(d.history.some((h) => h.field_name === 'status' && h.new_value === 'CONFIRMED')); }
  assert.equal((await A.c('GET', `${A.req}?scope=OUT_OF_SCOPE`)).json.requirements[0].status, 'DRAFT', '범위 외 untouched');
  const g = (await A.c('GET', A.purl)).json;
  assert.equal(step(g, 'REQUIREMENTS', 'CONFIRM').state, 'COMPLETED'); assert.equal(step(g, 'REQUIREMENTS', 'BASELINE_APPROVAL').state, 'COMPLETED');
  assert.equal(g.guidance.rule, 'REQ_DONE'); assert.match(g.guidance.description, /기준선이 잡혔습니다/);
  server.close();
});

test('US-1 guidance ladder: REQ_CONFIRM (승인 기록 → + 정의서) → REQ_APPROVE → REQ_DONE; 02→03 bypass reason → row text, note, document, LNB data', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toReq(A);
  await addReq(A, { title: 'R1', scope: 'IN_SCOPE', status: 'DRAFT' });
  let g = (await A.c('GET', A.purl)).json;
  assert.equal(g.guidance.rule, 'REQ_CONFIRM'); assert.equal(g.guidance.primary_action.label, '승인 기록 →'); assert.match(g.guidance.primary_action.href, /\/requirements\?approval=1$/);
  assert.match(g.guidance.description, /요구사항 정의서를 고객에게 보내 검토받으세요\. 승인 회신을 받으면 승인 기록에서 한 번에 확정됩니다\./);
  assert.equal(g.guidance.secondary_action.label, '요구사항 정의서 내려받기'); assert.match(g.guidance.secondary_action.href, /requirements\/export-doc\?format=pdf$/);
  assert.equal(step(g, 'REQUIREMENTS', 'CONFIRM').cta.label, '승인 기록 →');
  const rid = (await A.c('GET', A.req)).json.requirements[0].id;
  await A.c('PATCH', `${A.req}/${rid}`, { status: 'CONFIRMED' });
  g = (await A.c('GET', A.purl)).json;
  assert.equal(g.guidance.rule, 'REQ_APPROVE'); assert.equal(g.guidance.title, '요구사항 기준선을 고객에게 승인받으세요');
  assert.equal(g.guidance.description, '고객이 승인한 요구사항이 설계·개발·테스트·검수의 기준(기준선)이 됩니다. 요구사항 정의서를 보내고, 승인 회신을 받으면 기록하세요.');
  assert.ok(!/기준선이 잡혔습니다/.test(JSON.stringify(g.guidance)));
  assert.equal(g.current_phase.summary.gate_met, false);
  // 02→03 without approval: the client writes the reason through the step note API, then activates (server never blocks)
  const st = step(g, 'REQUIREMENTS', 'BASELINE_APPROVAL');
  assert.equal((await A.c('PATCH', `${A.purl}/steps/${st.id}`, { note: '[승인 전 진행] 고객 PM 출장으로 다음 주 회신 · 2026-10-15 · 홍길동' })).status, 200);
  const nx = g.phases.find((x) => x.phase_key === 'ANALYSIS_DESIGN');
  assert.equal((await A.c('POST', `${A.purl}/phases/${nx.id}/activate`, { reason: 'NEXT' })).status, 200);
  g = (await A.c('GET', A.purl)).json;
  const rq = g.phases.find((x) => x.phase_key === 'REQUIREMENTS');
  assert.equal(rq.status, 'IN_PROGRESS'); assert.equal(rq.summary.required_open, 1);   // LNB/stepper: number + badge, no ✓ (F6 rule)
  assert.equal(step(g, 'REQUIREMENTS', 'BASELINE_APPROVAL').text, '승인 전 진행 · 사유 있음');
  const b = (await A.c('GET', `${A.req}/baseline`)).json.baseline;
  assert.deepEqual(b.bypass, { reason: '고객 PM 출장으로 다음 주 회신', date: '2026-10-15', name: '홍길동', count: 1 });
  const doc = await A.c('GET', `${A.req}/export-doc?format=docx`, undefined, { raw: true });
  const xml = await (await JSZip.loadAsync(doc.buf)).file('word/document.xml').async('string');
  assert.match(xml, /미승인 — 사유: 고객 PM 출장으로 다음 주 회신/);
  // approval recorded later → 02 gate met (✓ on the passed phase)
  assert.equal((await A.c('POST', `${A.req}/baseline/complete`, { approval: APV })).status, 200);
  g = (await A.c('GET', A.purl)).json; assert.equal(g.phases.find((x) => x.phase_key === 'REQUIREMENTS').summary.required_open, 0);
  server.close();
});

test('US-2 요구사항 정의서: PDF + Word download, Korean, sections, type order, archived excluded, version/footer before and after approval', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toReq(A);
  await A.c('PUT', `${A.purl}/definition`, { goal: '계약 검토 리드타임 50% 단축', scope_in: ['국문 계약 검토'], scope_out: ['모바일 앱', 'OCR'] });
  const X = `${A.req}/export-doc`;
  // empty project: fixed sentences, structure kept
  let docx = await A.c('GET', `${X}?format=docx`, undefined, { raw: true }); assert.equal(docx.status, 200);
  let xml = await (await JSZip.loadAsync(docx.buf)).file('word/document.xml').async('string');
  for (const t of ['요구사항 정의서', '개정 이력', '1. 개요', '2. 범위 내 요구사항', '3. 범위 외 요구사항', '4. 승인', NO_IN_SCOPE, NO_OUT_OF_SCOPE, 'v0.9 (초안)', '승인 전 초안', '모바일 앱, OCR']) assert.ok(xml.includes(t), t);
  const nf = await addReq(A, { title: 'API 연계', scope: 'IN_SCOPE', status: 'CONFIRMED', type: 'INTERFACE' });
  const f1 = await addReq(A, { title: '로그인 | SSO', scope: 'IN_SCOPE', status: 'CONFIRMED', type: 'FUNCTIONAL', criteria: ['SSO 로그인 성공', '실패 시 안내'] });
  await addReq(A, { title: '모바일 앱', scope: 'OUT_OF_SCOPE', status: 'DRAFT' });
  const gone = await addReq(A, { title: '보관된 요구사항', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  await A.c('POST', `${A.req}/${gone.id}/archive`, {});
  await addReq(A, { title: '미결정 하나', scope: 'UNDECIDED' });
  docx = await A.c('GET', `${X}?format=docx`, undefined, { raw: true });
  assert.equal(docx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(decodeURIComponent(docx.headers.get('content-disposition')), /테스트_프로젝트_요구사항정의서_v0\.9_\d{8}\.docx/);
  xml = await (await JSZip.loadAsync(docx.buf)).file('word/document.xml').async('string');
  assert.ok(xml.includes('로그인 | SSO')); assert.ok(xml.includes('1. SSO 로그인 성공')); assert.ok(!xml.includes('보관된 요구사항'));
  assert.ok(xml.indexOf(f1.display_id) < xml.indexOf(nf.display_id), '유형별: 기능 before 인터페이스');
  assert.ok(xml.includes('범위가 결정되지 않은 요구사항 1건은 이 문서에 포함되지 않습니다.'));
  assert.ok(xml.includes('cantSplit'), 'table rows never split across pages');
  const pdf = await A.c('GET', `${X}?format=pdf`, undefined, { raw: true });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.buf.includes(Buffer.from('NanumGothic')), 'Hangul font embedded');
  assert.equal((await A.c('GET', `${X}?format=hwp`)).status, 400);
  const B = await setup(client, 'b2@x.com'); assert.equal((await B.c('GET', `${X}?format=pdf`)).status, 404);
  // approved → v1.0, no draft footer, approver + 승인일 in the 승인란
  assert.equal((await A.c('POST', `${A.req}/baseline/complete`, { approval: APV })).status, 200);
  docx = await A.c('GET', `${X}?format=docx`, undefined, { raw: true });
  assert.match(decodeURIComponent(docx.headers.get('content-disposition')), /_v1\.0_\d{8}\.docx/);
  xml = await (await JSZip.loadAsync(docx.buf)).file('word/document.xml').async('string');
  assert.ok(xml.includes('v1.0')); assert.ok(!xml.includes('승인 전 초안')); assert.ok(xml.includes('이수진')); assert.ok(xml.includes('2026-01-10'));
  server.close();
});

test('US-2 markdown: revision row per state, tables parse, empty lists keep the structure', () => {
  const c = { profile: { name: 'P', client: 'C' }, goals: '목표 1\n목표 2', successCriteria: '', scope: { inScope: '- A\n- B', outOfScope: '' }, stakeholders: [{ category: 'OWN', name: '김피엠', role: 'PM' }] };
  const draft = buildReqDocMarkdown(c, [], { status: 'TODO', approval: { date: '' }, approver: null, bypass: null }, { workspaceName: 'W', author: '홍', today: '2026-10-15' });
  assert.equal(draft.version, 'v0.9 (초안)'); assert.equal(draft.footer, '승인 전 초안'); assert.equal(draft.fileVersion, 'v0.9');
  assert.match(draft.markdown, /\| v0\.9 \| 2026-10-15 \| 초안 \| 홍 \|/); assert.match(draft.markdown, /\| 프로젝트 목표 \| 목표 1 \|/); assert.match(draft.markdown, /\| 수행 범위 \| A, B \|/);
  assert.ok(draft.markdown.includes(NO_IN_SCOPE)); assert.ok(draft.markdown.includes(NO_OUT_OF_SCOPE));
  assert.match(draft.markdown, /\| 수행사 \| 김피엠 \| PM \|/);
  const done = buildReqDocMarkdown(c, [{ id: '1', display_id: 'REQ-001', sequence_number: 1, title: 'T', type: 'SECURITY', priority: 'HIGH', scope: 'IN_SCOPE', criteria: [] }], { status: 'COMPLETED', approval: { date: '2026-01-10', evidence: 'e' }, approver: { name: '이', title: '차장' }, method_label: '이메일 회신', bypass: null }, { workspaceName: 'W', author: '홍', today: '2026-10-15' });
  assert.equal(done.version, 'v1.0'); assert.equal(done.footer, ''); assert.match(done.markdown, /\| v1\.0 \| 2026-01-10 \| 승인 \| 홍 \|/);
  const t = parseReportMarkdown(done.markdown).filter((x) => x.type === 'table').find((x) => x.header && x.header[0] === 'ID');
  assert.deepEqual(t.rows[0], ['REQ-001', 'T', '보안', 'High', '-']);
});

test('US-3 rules: prompt only for 확정 요구사항 제목·설명·완료 조건·범위 / 범위 내 보관, never with an approved CR; add after approval', () => {
  const r = { status: 'CONFIRMED', scope: 'IN_SCOPE', approved_cr_count: 0 };
  for (const f of ['title', 'description', 'criteria', 'scope', 'archive']) assert.equal(needsPrompt(r, f), true, f);
  for (const f of ['owner_user_id', 'priority', 'type', 'status', 'requester_name']) assert.equal(needsPrompt(r, f), false, f);
  assert.equal(needsPrompt({ ...r, status: 'REVIEWING' }, 'title'), false);
  assert.equal(needsPrompt({ ...r, approved_cr_count: 1 }, 'title'), false);
  assert.equal(needsPrompt({ ...r, scope: 'OUT_OF_SCOPE' }, 'archive'), false); assert.equal(needsPrompt({ ...r, scope: 'OUT_OF_SCOPE' }, 'scope'), true);
  assert.equal(needsAddPrompt({ status: 'COMPLETED' }, 'IN_SCOPE'), true); assert.equal(needsAddPrompt({ status: 'TODO' }, 'IN_SCOPE'), false); assert.equal(needsAddPrompt({ status: 'COMPLETED' }, 'UNDECIDED'), false);
  assert.equal(proposalLine('scope', 'IN_SCOPE', 'OUT_OF_SCOPE'), '- 범위: 범위 내 → 범위 외'); assert.equal(proposalLine('title', 'A', ''), '- 제목: A → (없음)');
});

test('US-3 API: CR draft linked to the requirement leaves it unchanged; an APPROVED CR shows on the row (approved_cr_count)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await toReq(A);
  const r = await addReq(A, { title: 'SSO 로그인', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const c = await A.c('POST', `${A.purl}/changes`, { title: `${r.display_id} 변경: ${r.title}`, description: '제안 내용 (변경 전 → 후)\n- 제목: SSO 로그인 → SSO·OTP 로그인', requirements: [{ requirement_id: r.id, relation_type: 'MODIFIES' }] });
  assert.equal(c.status, 201); assert.equal(c.json.change.status, 'DRAFT'); assert.equal(c.json.change.requirements.length, 1);
  let row = (await A.c('GET', A.req)).json.requirements[0];
  assert.equal(row.title, 'SSO 로그인'); assert.equal(Number(row.approved_cr_count), 0);
  await db.run(`UPDATE change_requests SET status = 'APPROVED' WHERE id = ?`, [c.json.change.id]);   // approval workflow itself is covered by changes.test
  row = (await A.c('GET', A.req)).json.requirements[0]; assert.equal(Number(row.approved_cr_count), 1);
  assert.equal(Number((await A.c('GET', `${A.req}/${r.id}`)).json.requirement.approved_cr_count), 1);
  server.close();
});

test('US-4/5 activities: CONFIRM → 승인 기록, INTERFACE 권장 by traits (gate unchanged), COLLECT hint, BASELINE_APPROVAL states', () => {
  const ctx = (requirements, extra = {}) => ({ pid: 'p1', stats: stats(requirements), definition: { sections: [] }, ...extra });
  let a = activityStates('REQUIREMENTS', stepsOf('REQUIREMENTS'), ctx({ total: 3, in_scope: 3, in_scope_confirmed: 1, non_functional: 0 }));
  let by = Object.fromEntries(a.map((x) => [x.step_key, x]));
  assert.deepEqual(by.CONFIRM.cta, { label: '승인 기록 →', href: '/app/projects/p1/requirements?approval=1' });
  assert.equal(by.COLLECT.hint, COLLECT_HINT); assert.equal(COLLECT_HINT, '계약서·제안요청서(RFP)·인터뷰 등 출처를 빠짐없이 확인했나요?');
  assert.equal(by.INTERFACE.importance, 'OPTIONAL'); assert.equal(by.BASELINE_APPROVAL.state, 'NOT_STARTED'); assert.equal(by.BASELINE_APPROVAL.cta.label, '승인 기록 →');
  assert.equal(by.BASELINE_APPROVAL.manual, false, 'never completed by hand on What\'s Next');
  const before = activitySummary(a);
  a = activityStates('REQUIREMENTS', stepsOf('REQUIREMENTS'), ctx({ total: 3, in_scope: 3, in_scope_confirmed: 1 }, { traits: { data_migration: 'TBD', has_external_integration: 'YES' } }));
  by = Object.fromEntries(a.map((x) => [x.step_key, x]));
  assert.equal(by.INTERFACE.importance, 'RECOMMENDED'); assert.equal(by.INTERFACE.importance_label, '권장'); assert.match(by.INTERFACE.description, /\(프로젝트 특성: 외부 연계 있음\)$/);
  assert.deepEqual(activitySummary(a), before, 'gate unaffected');
  a = activityStates('REQUIREMENTS', stepsOf('REQUIREMENTS'), ctx({ total: 3 }, { traits: { data_migration: 'YES', has_external_integration: 'YES' } }));
  assert.match(a.find((x) => x.step_key === 'INTERFACE').description, /\(프로젝트 특성: 데이터 이관·외부 연계 있음\)$/);
  a = activityStates('REQUIREMENTS', stepsOf('REQUIREMENTS'), ctx({ total: 3 }, { definition: { sections: [], req_baseline: { status: 'TODO', bypass: { reason: 'x' }, summary: '승인 전 진행 · 사유 있음' } } }));
  assert.equal(a.find((x) => x.step_key === 'BASELINE_APPROVAL').text, '승인 전 진행 · 사유 있음');
});

test('US-4(5) 범위 확정 guidance shows the Charter 제외 범위 (hidden when empty)', () => {
  const base = { project: { id: 'p1', workspace_id: 'w1', current_phase: 'REQUIREMENTS' }, phase: { phase_key: 'REQUIREMENTS', name: '요구사항 정의', sequence: 2 }, next_phase: null, stats: stats({ total: 3, scope_undecided: 2, type_unspecified: 0 }) };
  let r = projectGuidance({ ...base, definition: { scope_out: ['모바일 앱', 'OCR'] } });
  assert.equal(r.rule, 'REQ_SCOPE'); assert.match(r.description, /착수 때 제외하기로 한 것: 모바일 앱, OCR\. 여기에 해당하는 요구사항은 '범위 외'로 두세요\./);
  r = projectGuidance({ ...base, definition: { scope_out: [] } }); assert.ok(!/착수 때 제외/.test(r.description));
});

test('US-4(6) Home: WBS 미연결 is neither 확인 필요 nor Blocker during 01·02, back from 03', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await toReq(A);
  for (const t of ['R1', 'R2']) await addReq(A, { title: t, scope: 'IN_SCOPE', status: 'CONFIRMED' });
  let card = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json.projects.find((x) => x.id === A.p.id);
  assert.ok(!card.attention.items.some((i) => /WBS 미연결/.test(i.meta))); assert.notEqual(card.priority, 'BLOCKER'); assert.notEqual(card.health.status, 'CRITICAL');
  const nx = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === 'ANALYSIS_DESIGN');
  await A.c('POST', `${A.purl}/phases/${nx.id}/activate`, { reason: 'NEXT' });
  card = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json.projects.find((x) => x.id === A.p.id);
  assert.ok(card.attention.items.some((i) => /WBS 미연결/.test(i.meta))); assert.equal(card.priority, 'BLOCKER');
  server.close();
});

test('migration 32: existing projects get BASELINE_APPROVAL right after CONFIRM as TODO (idempotent); 03+ projects not blocked', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await toReq(A);
  const nx = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === 'ANALYSIS_DESIGN');
  await db.run(`DELETE FROM project_steps WHERE step_key = 'BASELINE_APPROVAL' AND project_phase_id IN (SELECT id FROM project_phases WHERE project_id = ?)`, [A.p.id]);
  await db.run(`UPDATE project_steps SET sequence = 6 WHERE step_key = 'INTERFACE' AND project_phase_id IN (SELECT id FROM project_phases WHERE project_id = ?)`, [A.p.id]);
  assert.equal((await A.c('POST', `${A.purl}/phases/${nx.id}/activate`, { reason: 'NEXT' })).status, 200);
  const m32 = migrations.find((m) => m.version === 32);
  await m32.up(db); await m32.up(db);
  const rows = await db.all(`SELECT s.step_key, s.status, s.sequence, s.importance FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND p.phase_key = 'REQUIREMENTS' ORDER BY s.sequence`, [A.p.id]);
  assert.deepEqual(rows.map((x) => x.step_key), ['COLLECT', 'CLASSIFY', 'PRIORITIZE', 'SCOPE_CHECK', 'CONFIRM', 'BASELINE_APPROVAL', 'INTERFACE']);
  assert.deepEqual(rows.map((x) => x.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rows[5].status, 'TODO'); assert.equal(rows[5].importance, 'REQUIRED');
  const g = (await A.c('GET', A.purl)).json; assert.equal(g.current_phase.phase_key, 'ANALYSIS_DESIGN', 'still in 03');
  assert.equal((await A.c('GET', `${A.req}/baseline`)).json.baseline.status, 'TODO');
  server.close();
});
