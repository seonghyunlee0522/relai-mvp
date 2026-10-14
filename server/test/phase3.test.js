/* Phase 3 (03 분석·설계): 계정 없는 팀원 담당자 (owner_stakeholder_id), rule-based WBS 뼈대 (+ 자동 연결, 409), 종료일 초과 경고,
 * 01 주요 일정 → 마일스톤 (중복 없음), REQ_TRACE counts 구현 tasks only, NON_DEV_TASKS 권장, migration 33.
 * Spec: hive research/relai-phase-3-spec.md (v2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, readXlsx } from './api-helpers.js';
import { PHASE_BY_KEY, ANALYSIS_DESIGN_DESCRIPTION, ANALYSIS_DESIGN_DESCRIPTION_V1 } from '../templates/default-phases.js';
import { migrations } from '../migrations.js';
import { parseWbs, pastEnd, overrunsEnd } from '../wbs.js';
import { projectGuidance } from '../guidance.js';

const TEAM = [
  { id: 'sh-pm', name: '김피엠', org_type: 'OWN', org: '수행사', role: 'PM' },
  { id: 'sh-pl', name: '최민석', org_type: 'OWN', org: '수행사', role: 'PL/아키텍트' },
  { id: 'sh-dev', name: '박협력', org_type: 'PARTNER', org: '협력사', role: '개발' },
  { id: 'sh-cl', name: '이고객', org_type: 'CLIENT', org: 'ACME', role: '고객 PM' },
  { id: 'sh-etc', name: '정기타', org_type: 'OTHER', org: '감리', role: '감리' },
];
const KEY_DATES = [{ title: '킥오프', date: '2026-11-03' }, { title: '요구사항 확정', date: '2026-12-01' }, { title: '안정화 종료', date: '2027-03-31' }];
const step = (g, phase, key) => g.phases.find((x) => x.phase_key === phase).steps.find((s) => s.step_key === key);
const to03 = async (A) => {
  for (const key of ['REQUIREMENTS', 'ANALYSIS_DESIGN']) {
    const ph = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === key);
    assert.equal((await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'NEXT' })).status, 200);
  }
};
const define = (A, extra = {}) => A.c('PUT', `${A.purl}/definition`, { stakeholders: TEAM, key_dates: KEY_DATES, ...extra });
const addReq = async (A, n, body = {}) => { const out = []; for (let i = 1; i <= n; i++) out.push((await A.c('POST', A.req, { title: `기능 ${i}`, type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED', ...body })).json.requirement); return out; };
const setTraits = (A, traits) => A.c('PATCH', A.purl, traits);

test('template: NON_DEV_TASKS is 권장 (was 선택); 03 description ends with the 설계 sentence (US-6)', () => {
  const st = PHASE_BY_KEY.ANALYSIS_DESIGN.steps.find((s) => s.key === 'NON_DEV_TASKS');
  assert.equal(st.importance, 'RECOMMENDED'); assert.equal(st.is_required, 0);
  assert.equal(PHASE_BY_KEY.ANALYSIS_DESIGN.description, `${ANALYSIS_DESIGN_DESCRIPTION_V1} 화면·DB·인터페이스 설계도 WBS 작업으로 넣어 관리하세요.`);
  assert.equal(PHASE_BY_KEY.ANALYSIS_DESIGN.steps.find((s) => s.key === 'REQ_TRACE').title, '요구사항–WBS 연결');
});

test('parseWbs owner rules: one kind at a time; owner = u:/s:/"" sets both', () => {
  assert.deepEqual(pick(parseWbs({ owner_user_id: 'u1' }, { partial: true })), { owner_user_id: 'u1', owner_stakeholder_id: null });
  assert.deepEqual(pick(parseWbs({ owner_stakeholder_id: 's1' }, { partial: true })), { owner_user_id: null, owner_stakeholder_id: 's1' });
  assert.deepEqual(pick(parseWbs({ owner: 's:s1' }, { partial: true })), { owner_user_id: null, owner_stakeholder_id: 's1' });
  assert.deepEqual(pick(parseWbs({ owner: 'u:u1' }, { partial: true })), { owner_user_id: 'u1', owner_stakeholder_id: null });
  assert.deepEqual(pick(parseWbs({ owner: '' }, { partial: true })), { owner_user_id: null, owner_stakeholder_id: null });
  assert.deepEqual(pick(parseWbs({ owner_user_id: '' }, { partial: true })), { owner_user_id: null, owner_stakeholder_id: null }, '미지정 clears both');
  assert.deepEqual(pick(parseWbs({ status: 'IN_PROGRESS' }, { partial: true, existing: { item_type: 'TASK' } })), {}, 'unrelated patch leaves owners alone');
  assert.throws(() => parseWbs({ owner: 'x' }, { partial: true }));
  assert.throws(() => parseWbs({ owner_user_id: 'u1', owner_stakeholder_id: 's1' }, { partial: true }));
});
function pick(o) { const r = {}; for (const k of ['owner_user_id', 'owner_stakeholder_id']) if (o[k] !== undefined) r[k] = o[k]; return r; }

test('US-1 담당자: 당사·협력사 stakeholders are assignable (고객사·기타 not), exclusive with users, ASSIGN, no_owner, deleted stakeholder', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await define(A); await to03(A);
  let r = await A.c('GET', A.wbs);
  assert.deepEqual(r.json.owners.team.map((t) => t.name), ['김피엠', '최민석', '박협력'], '당사·협력사 only');
  assert.equal(r.json.owners.team[1].role, 'PL/아키텍트'); assert.equal(r.json.owners.stakeholders_total, 5);
  const t1 = (await A.c('POST', A.wbs, { title: '화면 설계', owner_stakeholder_id: 'sh-pl' })).json.item;
  assert.equal(t1.owner_stakeholder_id, 'sh-pl'); assert.equal(t1.owner_name, '최민석'); assert.equal(t1.owner_no_account, true);
  for (const bad of ['sh-cl', 'sh-etc', 'nope']) {
    r = await A.c('POST', A.wbs, { title: 'x', owner_stakeholder_id: bad }); assert.equal(r.status, 400, bad); assert.ok(r.json.error.fields.owner_stakeholder_id);
  }
  // stakeholder → user clears the stakeholder, and back
  r = await A.c('PATCH', `${A.wbs}/${t1.id}`, { owner: `u:${A.uid}` }); assert.equal(r.status, 200);
  assert.equal(r.json.item.owner_user_id, A.uid); assert.equal(r.json.item.owner_stakeholder_id, null); assert.equal(r.json.item.owner_name, '홍길동');
  r = await A.c('PATCH', `${A.wbs}/${t1.id}`, { owner_stakeholder_id: 'sh-dev' });
  assert.equal(r.json.item.owner_user_id, null); assert.equal(r.json.item.owner_stakeholder_id, 'sh-dev'); assert.equal(r.json.item.owner_name, '박협력');
  assert.ok(r.json.item.history.some((h) => h.field_name === 'owner_stakeholder_id' && h.new_value === 'sh-dev'), 'history records the stakeholder');
  // every task owned by stakeholders only → ASSIGN 완료
  await A.c('POST', A.wbs, { title: 'DB 설계', owner: 's:sh-pm' });
  let g = (await A.c('GET', A.purl)).json;
  assert.equal(g.wbs.tasks_without_owner, 0); assert.equal(step(g, 'ANALYSIS_DESIGN', 'ASSIGN').state, 'COMPLETED');
  // a stakeholder deleted from 01 → (삭제된 담당자), counted as 미지정
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: TEAM.filter((x) => x.id !== 'sh-dev') });
  r = await A.c('GET', A.wbs);
  const it = r.json.items.find((x) => x.id === t1.id); assert.equal(it.owner_name, '(삭제된 담당자)'); assert.equal(it.owner_deleted, true);
  assert.equal(r.json.summary.tasks_without_owner, 1);
  g = (await A.c('GET', A.purl)).json; assert.equal(step(g, 'ANALYSIS_DESIGN', 'ASSIGN').state, 'IN_PROGRESS');
  server.close();
});

test('US-1 Gantt/주간보고/Excel: stakeholder owner names; Excel import matches a stakeholder name, unknown names still fail', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await define(A); await to03(A);
  const t = (await A.c('POST', A.wbs, { title: '통합 테스트', owner: 's:sh-pl', planned_start_date: '2026-11-02', planned_end_date: '2026-11-20' })).json.item;
  await A.c('PATCH', `${A.wbs}/${t.id}`, { status: 'IN_PROGRESS', progress: 30 });
  // weekly report (rule-based): in-progress task shows the stakeholder + (계정 없음)
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: '2026-11-02', period_end: '2026-11-08' })).json.report;
  assert.match(rep.plain_text, /통합 테스트 — 30% · 최민석 \(계정 없음\)/);
  // Excel export → the stakeholder's name; import resolves it back
  const x = await A.c('GET', `${A.wbs}/export.xlsx`);
  const wb = await readXlsx(x.buf);
  assert.ok(JSON.stringify(wb.worksheets[0].getSheetValues()).includes('최민석'));
  let r = await A.c('POST', `${A.wbs}/import`, { rows: [
    { row: 2, values: { code: '9', title: '사용자 교육', owner: '박협력' } },
    { row: 3, values: { code: '10', title: '이관', owner: '이고객' } },     // 고객사 → not assignable
    { row: 4, values: { code: '11', title: '배포', owner: '없는사람' } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.created, 1); assert.equal(r.json.failed, 2);
  const tree = (await A.c('GET', A.wbs)).json.items;
  const edu = tree.find((i) => i.title === '사용자 교육'); assert.equal(edu.owner_stakeholder_id, 'sh-dev'); assert.equal(edu.owner_user_id, null);
  // a RELAI user with the same name wins over the stakeholder
  await A.c('PUT', `${A.purl}/definition`, { stakeholders: [...TEAM, { id: 'sh-me', name: '홍길동', org_type: 'OWN', role: 'PM' }] });
  r = await A.c('POST', `${A.wbs}/import`, { rows: [{ row: 2, values: { code: '12', title: '오픈 점검', owner: '홍길동' } }] });
  const op = (await A.c('GET', A.wbs)).json.items.find((i) => i.title === '오픈 점검'); assert.equal(op.owner_user_id, A.uid); assert.equal(op.owner_stakeholder_id, null);
  server.close();
});

test('US-2 뼈대: 15 confirmed + 이관 있음 + 연계 없음 → 3·15·3·3·1 (+3 milestones), 15 links (유형 구현), REQ_TRACE 완료; 409 when not empty', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await define(A); await setTraits(A, { data_migration: 'YES', has_external_integration: 'NO' });
  const reqs = await addReq(A, 15);
  await A.c('POST', A.req, { title: '범위 외', type: 'FUNCTIONAL', scope: 'OUT_OF_SCOPE', status: 'CONFIRMED' });
  await to03(A);
  let g = (await A.c('GET', A.purl)).json;
  assert.equal(g.guidance.rule, 'WBS_EMPTY'); assert.equal(g.guidance.primary_action.label, 'WBS 뼈대 만들기'); assert.match(g.guidance.primary_action.href, /\/wbs\?skeleton=1$/);
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'NON_DEV_TASKS').importance, 'RECOMMENDED');
  const pv = (await A.c('GET', `${A.wbs}/skeleton/preview`)).json.preview;
  assert.deepEqual(pv.groups.map((x) => [x.title, x.count]), [['분석·설계', 3], ['구현', 15], ['시험', 3], ['전환·오픈', 3], ['안정화', 1]]);
  assert.equal(pv.milestones, 3); assert.equal(pv.linked, 15); assert.equal(pv.total, 28); assert.equal(pv.available, true);
  let r = await A.c('POST', `${A.wbs}/skeleton`, {});
  assert.equal(r.status, 201, JSON.stringify(r.json)); assert.deepEqual(r.json.result, { created: 28, tasks: 25, milestones: 3, linked: 15 });
  const items = r.json.items;
  const groups = items.filter((i) => i.depth === 0 && i.item_type === 'SUMMARY');
  assert.deepEqual(groups.map((x) => [x.title, x.lifecycle_phase, x.children_count]), [['분석·설계', 'ANALYSIS_DESIGN', 3], ['구현', 'DEVELOPMENT', 15], ['시험', 'TESTING', 3], ['전환·오픈', 'TRANSITION_GO_LIVE', 3], ['안정화', 'TRANSITION_GO_LIVE', 1]]);
  const kids = (title) => items.filter((i) => i.parent_id === groups.find((x) => x.title === title).id).map((i) => i.title);
  assert.deepEqual(kids('분석·설계'), ['상세 요구사항 분석', '화면 설계', 'DB 설계']);
  assert.deepEqual(kids('시험'), ['통합 테스트', '사용자 인수 테스트(UAT)', '결함 조치']);
  assert.deepEqual(kids('전환·오픈'), ['데이터 이관', '사용자 교육', '운영 환경 배포·오픈']);
  assert.deepEqual(kids('안정화'), ['오픈 후 안정화 지원']);
  assert.equal(kids('구현')[0], `${reqs[0].display_id} 기능 1`);
  const tasks = items.filter((i) => i.item_type === 'TASK');
  assert.ok(tasks.every((i) => i.lifecycle_phase && !i.owner_user_id && !i.owner_stakeholder_id && !i.planned_start_date && !i.planned_end_date), 'tagged, no dates, no owners');
  assert.deepEqual(items.filter((i) => i.item_type === 'MILESTONE').map((m) => [m.title, m.milestone_date]), KEY_DATES.map((k) => [k.title, k.date]));
  const links = await db.all(`SELECT l.link_type, w.title FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.project_id = ?`, [A.p.id]);
  assert.equal(links.length, 15); assert.ok(links.every((l) => l.link_type === 'IMPLEMENTS'));
  g = (await A.c('GET', A.purl)).json;
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'REQ_TRACE').state, 'COMPLETED');
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'WBS_BUILD').state, 'COMPLETED');
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'NON_DEV_TASKS').state, 'COMPLETED');
  assert.equal(step(g, 'ANALYSIS_DESIGN', 'MILESTONES').state, 'COMPLETED');
  assert.equal(g.guidance.rule, 'WBS_ASSIGN', 'next guide = 담당자 (dates/owners are filled by the PM)');
  // history: "뼈대로 생성"; items behave like normal ones (edit, move, archive)
  const first = tasks[0]; const d = (await A.c('GET', `${A.wbs}/${first.id}`)).json.item;
  assert.ok(d.history.some((h) => h.action_type === 'CREATED' && h.new_value === '뼈대로 생성'));
  assert.equal((await A.c('PATCH', `${A.wbs}/${first.id}`, { title: '요구사항 상세 분석', planned_start_date: '2026-11-02', planned_end_date: '2026-11-13' })).status, 200);
  assert.equal((await A.c('POST', `${A.wbs}/${first.id}/move`, { parent_id: null, sequence: 1 })).status, 200);
  assert.equal((await A.c('POST', `${A.wbs}/${first.id}/archive`, {})).status, 200);
  // not empty → 409 (preview says unavailable)
  r = await A.c('POST', `${A.wbs}/skeleton`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'wbs_not_empty');
  assert.equal((await A.c('GET', `${A.wbs}/skeleton/preview`)).json.preview.available, false);
  g = (await A.c('GET', A.purl)).json; assert.notEqual(g.guidance.primary_action.label, 'WBS 뼈대 만들기');
  server.close();
});

test('US-2 branches: 연계 있음 → 인터페이스 설계; 이관 없음 → no 데이터 이관; 0 confirmed → one unlinked 기능 구현; archived-only WBS counts as empty', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); await setTraits(A, { data_migration: 'NO', has_external_integration: 'YES' }); await to03(A);
  const pv = (await A.c('GET', `${A.wbs}/skeleton/preview`)).json.preview;
  assert.deepEqual(pv.groups.map((x) => x.count), [4, 1, 3, 2, 1]); assert.equal(pv.linked, 0); assert.equal(pv.milestones, 0);
  const t = (await A.c('POST', A.wbs, { title: '임시' })).json.item; await A.c('POST', `${A.wbs}/${t.id}/archive`, {});
  const r = await A.c('POST', `${A.wbs}/skeleton`, {}); assert.equal(r.status, 201);
  const titles = r.json.items.map((i) => i.title);
  assert.ok(titles.includes('인터페이스 설계')); assert.ok(!titles.includes('데이터 이관')); assert.ok(titles.includes('기능 구현'));
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM requirement_wbs_links WHERE project_id = ?', [A.p.id])).n), 0);
  server.close();
});

test('US-2 03 완료 가이드: 시험/오픈 작업 없음 + 종료일 초과 + 구현 미연결 warnings with filter links; never blocks the move', () => {
  const project = { id: 'p1', workspace_id: 'w1', current_phase: 'ANALYSIS_DESIGN' };
  const base = { tasks: 4, total: 4, milestones: 1, tasks_without_owner: 0, tasks_without_dates: 0 };
  const g = (wbs) => projectGuidance({ project, phase: { phase_key: 'ANALYSIS_DESIGN', name: '분석·설계', sequence: 3 }, next_phase: { name: '구현', sequence: 4 }, stats: { requirements: {}, wbs: { ...base, ...wbs } } });
  let x = g({ by_phase: { DEVELOPMENT: 4 }, tasks_over_end: 1, tasks_unlinked: 2, tasks_unlinked_scope: 'DEVELOPMENT' });
  assert.equal(x.rule, 'WBS_DONE'); assert.equal(x.title, '실행 계획이 준비되었습니다'); assert.match(x.primary_action.href, /\?move=next$/);
  assert.deepEqual(x.warnings, ['시험 작업이 없습니다', '오픈(전환) 작업이 없습니다', '종료일을 넘는 작업 1건', '구현 작업 중 요구사항과 연결되지 않은 작업 2건']);
  assert.equal(x.warning_links['시험 작업이 없습니다'], '/app/projects/p1/wbs?phase=TESTING');
  assert.equal(x.warning_links['종료일을 넘는 작업 1건'], '/app/projects/p1/wbs?f=over_end');
  assert.equal(x.warning_links['구현 작업 중 요구사항과 연결되지 않은 작업 2건'], '/app/projects/p1/wbs?f=unlinked&phase=DEVELOPMENT');
  x = g({ by_phase: { DEVELOPMENT: 2, TESTING: 1, TRANSITION_GO_LIVE: 1 } });
  assert.deepEqual(x.warnings, []);
});

test('US-2 시험 작업을 모두 지우면 완료 가이드에 "시험 작업이 없습니다"', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await define(A); await addReq(A, 2); await to03(A);
  const items = (await A.c('POST', `${A.wbs}/skeleton`, {})).json.items;
  // fill owners + dates so the guide reaches WBS_DONE
  for (const it of items.filter((i) => i.item_type === 'TASK')) await A.c('PATCH', `${A.wbs}/${it.id}`, { owner: 's:sh-pl', planned_start_date: '2026-11-02', planned_end_date: '2026-11-20' });
  let g = (await A.c('GET', A.purl)).json; assert.equal(g.guidance.rule, 'WBS_DONE'); assert.ok(!g.guidance.warnings.includes('시험 작업이 없습니다'));
  await A.c('POST', `${A.wbs}/${items.find((i) => i.title === '시험').id}/archive`, {});
  g = (await A.c('GET', A.purl)).json; assert.equal(g.guidance.rule, 'WBS_DONE'); assert.ok(g.guidance.warnings.includes('시험 작업이 없습니다'));
  server.close();
});

test('US-3 종료일 초과: row flag for task/milestone; guide count only tasks STARTING on/before the end', async () => {
  // pure rules
  const P = { planned_end_date: '2027-04-30' };
  assert.equal(pastEnd(P, { item_type: 'TASK', planned_end_date: '2027-05-14' }), true);
  assert.equal(overrunsEnd(P, { item_type: 'TASK', planned_start_date: '2027-04-01', planned_end_date: '2027-05-14' }), true);
  assert.equal(overrunsEnd(P, { item_type: 'TASK', planned_start_date: '2027-05-01', planned_end_date: '2027-05-31' }), false, '안정화 (starts after the end) → row only');
  assert.equal(pastEnd(P, { item_type: 'MILESTONE', milestone_date: '2027-05-31' }), true); assert.equal(overrunsEnd(P, { item_type: 'MILESTONE', milestone_date: '2027-05-31' }), false);
  assert.equal(pastEnd({}, { item_type: 'TASK', planned_end_date: '2099-01-01' }), false, 'no project end → no warning');
  const { server, client } = await boot();
  const A = await setup(client); await A.c('PATCH', A.purl, { planned_end_date: '2027-04-30' }); await to03(A);
  const a = (await A.c('POST', A.wbs, { title: '개발', planned_start_date: '2027-04-01', planned_end_date: '2027-05-14' })); assert.equal(a.status, 201);
  assert.ok(a.json.warnings.some((w) => /프로젝트 종료일\(2027-04-30\)을 넘습니다/.test(w)), 'save allowed, warning returned');
  await A.c('POST', A.wbs, { title: '오픈 후 안정화 지원', planned_start_date: '2027-05-01', planned_end_date: '2027-05-31' });
  await A.c('POST', A.wbs, { title: '안정화 종료', item_type: 'MILESTONE', milestone_date: '2027-05-31' });
  await A.c('POST', A.wbs, { title: '정상', planned_start_date: '2027-03-01', planned_end_date: '2027-04-30' });
  const r = (await A.c('GET', A.wbs)).json;
  const by = Object.fromEntries(r.items.map((i) => [i.title, i.past_end]));
  assert.deepEqual(by, { 개발: true, '오픈 후 안정화 지원': true, '안정화 종료': true, 정상: false });
  assert.equal(r.summary.tasks_over_end, 1);
  server.close();
});

test('US-4 01 주요 일정 → 마일스톤: one click = 3 milestones + MILESTONES 완료; twice = no duplicates; suggestion only while pending', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await define(A); await to03(A);
  await A.c('POST', A.wbs, { title: '설계' });
  let g = (await A.c('GET', A.purl)).json; let ms = step(g, 'ANALYSIS_DESIGN', 'MILESTONES');
  assert.equal(ms.state, 'NOT_STARTED'); assert.equal(ms.import_ms.count, 3);
  assert.equal(ms.import_ms.text, '착수 때 정한 주요 일정 3건(킥오프·요구사항 확정·안정화 종료)을 마일스톤으로 가져올까요?');
  assert.equal((await A.c('GET', A.wbs)).json.key_dates_pending, 3);
  let r = await A.c('POST', `${A.wbs}/milestones/from-key-dates`, {}); assert.equal(r.status, 201); assert.equal(r.json.created, 3);
  assert.deepEqual(r.json.items.filter((i) => i.item_type === 'MILESTONE').map((i) => [i.title, i.milestone_date]), KEY_DATES.map((k) => [k.title, k.date]));
  assert.equal(r.json.key_dates_pending, 0);
  g = (await A.c('GET', A.purl)).json; ms = step(g, 'ANALYSIS_DESIGN', 'MILESTONES'); assert.equal(ms.state, 'COMPLETED'); assert.equal(ms.import_ms, null);
  r = await A.c('POST', `${A.wbs}/milestones/from-key-dates`, {}); assert.equal(r.status, 200); assert.equal(r.json.created, 0);
  assert.equal(r.json.items.filter((i) => i.item_type === 'MILESTONE').length, 3, 'no duplicates');
  // a new key date in 01 → only that one is imported
  await A.c('PUT', `${A.purl}/definition`, { key_dates: [...KEY_DATES, { title: '오픈', date: '2027-03-02' }] });
  r = await A.c('POST', `${A.wbs}/milestones/from-key-dates`, {}); assert.equal(r.json.created, 1);
  server.close();
});

test('US-5 REQ_TRACE: tagged WBS counts 구현 tasks only ("구현 작업 중 …"); untagged WBS counts every task as before', async () => {
  const { server, client } = await boot();
  const A = await setup(client); await define(A); await addReq(A, 1); await to03(A);
  // untagged: 2 tasks, one linked through the requirement
  const t1 = (await A.c('POST', A.wbs, { title: 'A' })).json.item; await A.c('POST', A.wbs, { title: 'B' });
  const req = (await A.c('GET', A.req)).json.requirements[0];
  await A.c('POST', `${A.wbs}/${t1.id}/links`, { requirement_id: req.id, link_type: 'IMPLEMENTS' });
  let r = (await A.c('GET', A.wbs)).json.summary; assert.equal(r.tasks_unlinked, 1); assert.equal(r.tasks_unlinked_scope, 'ALL');
  let g = (await A.c('GET', A.purl)).json; assert.equal(step(g, 'ANALYSIS_DESIGN', 'REQ_TRACE').trace, '요구사항과 연결되지 않은 작업 1건');
  // skeleton-like tagging: design/test tasks are not counted
  for (const [title, phase] of [['화면 설계', 'ANALYSIS_DESIGN'], ['통합 테스트', 'TESTING']]) await A.c('POST', A.wbs, { title, lifecycle_phase: phase });
  await A.c('PATCH', `${A.wbs}/${t1.id}`, { lifecycle_phase: 'DEVELOPMENT' });
  r = (await A.c('GET', A.wbs)).json.summary; assert.equal(r.tasks_unlinked, 0); assert.equal(r.tasks_unlinked_scope, 'DEVELOPMENT');
  const d2 = (await A.c('POST', A.wbs, { title: '추가 구현', lifecycle_phase: 'DEVELOPMENT' })).json.item;
  g = (await A.c('GET', A.purl)).json; assert.equal(step(g, 'ANALYSIS_DESIGN', 'REQ_TRACE').trace, '구현 작업 중 요구사항과 연결되지 않은 작업 1건');
  assert.ok(d2);
  server.close();
});

test('migration 33: NON_DEV_TASKS 선택 → 권장 + 03 description in existing projects (idempotent); owner_stakeholder_id column exists', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client);
  await db.run(`UPDATE project_steps SET importance = 'OPTIONAL', is_required = 0 WHERE step_key = 'NON_DEV_TASKS'`);
  await db.run(`UPDATE project_phases SET description = ? WHERE phase_key = 'ANALYSIS_DESIGN'`, [ANALYSIS_DESIGN_DESCRIPTION_V1]);
  const m33 = migrations.find((m) => m.version === 33); assert.ok(m33); assert.ok(migrations[migrations.length - 1].version >= 33);
  await m33.up(db); await m33.up(db);
  const row = await db.get(`SELECT s.importance, s.is_required FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE p.project_id = ? AND s.step_key = 'NON_DEV_TASKS'`, [A.p.id]);
  assert.deepEqual({ ...row }, { importance: 'RECOMMENDED', is_required: 0 });
  assert.equal((await db.get(`SELECT description FROM project_phases WHERE project_id = ? AND phase_key = 'ANALYSIS_DESIGN'`, [A.p.id])).description, ANALYSIS_DESIGN_DESCRIPTION);
  assert.ok(await db.get(`SELECT 1 FROM information_schema.columns WHERE table_name = 'wbs_items' AND column_name = 'owner_stakeholder_id'`));
  const g = (await A.c('GET', A.purl)).json; assert.equal(step(g, 'ANALYSIS_DESIGN', 'NON_DEV_TASKS').importance_label, '권장');
  server.close();
});
