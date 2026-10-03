/* E2E QA round 1 (2026-10-03): regression tests for the fixes made from the RELAI E2E issue list.
 * BUG-002 duplicate project names · UI-001 DRAFT status · GAP-006 unarchive · BUG-003 definition key dates in upcoming ·
 * BUG-004 / UX-007 status↔progress · BUG-005 leaf→group guard · UX-008 range warnings + health · GAP-002 archived WBS list ·
 * UX-006 import aliases · UX-001 friendly 404. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, project } from './api-helpers.js';
import { parseWbs, rangeWarnings } from '../wbs.js';
import { resolveEnum } from '../importer.js';
import { KINDS } from '../importspec.js';

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const mk = async (A, body) => { const r = await A.c('POST', A.wbs, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; };

test('BUG-002 / UI-001 / GAP-006: duplicate name 409 unless allowed, NOT_STARTED → DRAFT → ACTIVE on phase move, archive remembers status', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const base = `/api/workspaces/${A.w}/projects`;
  // the fixture project is NOT_STARTED → DRAFT
  assert.equal(A.p.status, 'DRAFT');
  // same name (case/space-insensitive) → 409 with a field error
  let r = await A.c('POST', base, project({ name: ' 테스트 프로젝트 ' }));
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'duplicate_name'); assert.ok(r.json.error.fields.name);
  // explicit allow → created
  r = await A.c('POST', base, project({ name: '테스트 프로젝트', allow_duplicate: true, current_situation: 'IN_PROGRESS' }));
  assert.equal(r.status, 201); assert.equal(r.json.project.status, 'ACTIVE');
  const dup = r.json.project;
  // rename onto another live name → 409; same name as itself → ok
  assert.equal((await A.c('PATCH', `${base}/${dup.id}`, { name: '테스트 프로젝트' })).status, 200);
  r = await A.c('POST', base, project({ name: '다른 이름' })); assert.equal(r.status, 201);
  assert.equal((await A.c('PATCH', `${base}/${r.json.project.id}`, { name: '테스트 프로젝트' })).status, 409);
  // DRAFT → ACTIVE when the project leaves 착수
  let g = (await A.c('GET', A.purl)).json;
  g = (await A.c('POST', `${A.purl}/phases/${g.phases[1].id}/activate`, { reason: 'NEXT' })).json;
  assert.equal(g.project.current_phase, 'REQUIREMENTS'); assert.equal(g.project.status, 'ACTIVE');
  // archive → unarchive restores the previous status; archiving twice / unarchiving a live project → 409
  assert.equal((await A.c('POST', `${base}/${dup.id}/unarchive`, {})).status, 409);
  assert.equal((await A.c('POST', `${base}/${dup.id}/archive`, {})).json.project.status, 'ARCHIVED');
  assert.equal((await A.c('POST', `${base}/${dup.id}/archive`, {})).status, 409);
  // an archived project no longer blocks the name
  assert.equal((await A.c('POST', base, project({ name: '다른 이름 2' }))).status, 201);
  r = await A.c('POST', `${base}/${dup.id}/unarchive`, {});
  assert.equal(r.status, 200); assert.equal(r.json.project.status, 'ACTIVE');
  server.close();
});

test('BUG-003: definition key dates and the project end date appear in upcoming (snapshot)', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  await A.c('PUT', `${A.purl}/definition`, { key_dates: [{ title: '킥오프', date: day(3) }, { title: '먼 미래', date: day(40) }, { title: '날짜 없음', date: '' }] });
  const s = (await A.c('GET', `${A.purl}/snapshot`)).json;
  const kd = s.upcoming.filter((u) => u.type === 'DEFINITION');
  assert.equal(kd.length, 1); assert.equal(kd[0].title, '킥오프'); assert.equal(kd[0].label, '주요 일정'); assert.equal(kd[0].href, 'definition#sec-MILESTONES');
  // project end within 7 days shows up too
  assert.equal((await A.c('PATCH', A.purl, { planned_start_date: day(-10), planned_end_date: day(5) })).status, 200);
  const s2 = (await A.c('GET', `${A.purl}/snapshot`)).json;
  assert.ok(s2.upcoming.some((u) => u.type === 'PROJECT' && u.label === '프로젝트 종료 예정'));
  server.close();
});

test('BUG-004 / UX-007: status and progress stay consistent in both directions (parseWbs + API)', async () => {
  // unit: parser
  assert.equal(parseWbs({ progress: 100 }, { partial: true, existing: { item_type: 'TASK', status: 'IN_PROGRESS', progress: 40 } }).status, 'COMPLETED');
  assert.equal(parseWbs({ status: 'NOT_STARTED' }, { partial: true, existing: { item_type: 'TASK', status: 'COMPLETED', progress: 100 } }).progress, 0);
  assert.equal(parseWbs({ status: 'IN_PROGRESS' }, { partial: true, existing: { item_type: 'TASK', status: 'COMPLETED', progress: 100 } }).progress, 99);
  assert.equal(parseWbs({ progress: 30 }, { partial: true, existing: { item_type: 'TASK', status: 'COMPLETED', progress: 100 } }).status, 'IN_PROGRESS');
  assert.throws(() => parseWbs({ status: 'NOT_STARTED', progress: 50 }, { partial: true, existing: { item_type: 'TASK', status: 'IN_PROGRESS', progress: 50 } }), (e) => /0이어야/.test(e.fields.progress));
  assert.throws(() => parseWbs({ status: 'COMPLETED', progress: 50 }, { partial: true, existing: { item_type: 'TASK', status: 'IN_PROGRESS', progress: 50 } }), (e) => /100이어야/.test(e.fields.progress));
  // API: 완료 → 예정 resets the roll-up
  const { server, client } = await boot();
  const A = await setup(client);
  const g = (await mk(A, { title: '그룹' })).item;
  const t = (await mk(A, { title: '작업', parent_id: g.id })).item;
  let r = await A.c('PATCH', `${A.wbs}/${t.id}`, { status: 'COMPLETED' }); assert.equal(r.json.item.progress, 100);
  r = await A.c('PATCH', `${A.wbs}/${t.id}`, { status: 'NOT_STARTED' });
  assert.equal(r.json.item.progress, 0); assert.equal(r.json.item.computed_status, 'PLANNED');
  assert.equal(r.json.items.find((x) => x.id === g.id).computed_progress, 0);
  assert.equal(r.json.items.find((x) => x.id === g.id).computed_status, 'PLANNED');
  r = await A.c('PATCH', `${A.wbs}/${t.id}`, { progress: 100 }); assert.equal(r.json.item.status, 'COMPLETED');
  server.close();
});

test('BUG-005: adding a child to / moving under a leaf with values needs convert_parent; move carries the values into the child', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const leaf = (await mk(A, { title: '문서 업로드 개발', planned_start_date: '2026-10-26', planned_end_date: '2026-11-13', progress: 40 })).item;
  // refused without a decision
  let r = await A.c('POST', A.wbs, { title: 'HWP 지원', parent_id: leaf.id });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'parent_has_values'); assert.equal(r.json.error.parent.progress, 40);
  // move: child inherits dates + progress, parent is now a group that rolls up to the same numbers
  r = await A.c('POST', A.wbs, { title: 'HWP 지원', parent_id: leaf.id, convert_parent: 'move' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.item.planned_start_date, r.json.item.planned_end_date, r.json.item.progress, r.json.item.status], ['2026-10-26', '2026-11-13', 40, 'IN_PROGRESS']);
  const G = r.json.items.find((x) => x.id === leaf.id);
  assert.equal(G.is_group, true); assert.equal(G.computed_progress, 40); assert.deepEqual([G.planned_start, G.planned_end], ['2026-10-26', '2026-11-13']);
  // history records the conversion
  const h = (await A.c('GET', `${A.wbs}/${leaf.id}`)).json.item.history;
  assert.ok(h.some((x) => x.action_type === 'CONVERTED'));
  // a second child under an existing group needs no decision; a valueless leaf needs none either
  assert.equal((await A.c('POST', A.wbs, { title: '둘째', parent_id: leaf.id })).status, 201);
  const plain = (await mk(A, { title: '빈 작업' })).item;
  assert.equal((await A.c('POST', A.wbs, { title: '하위', parent_id: plain.id })).status, 201);
  // moving an item under a valued leaf: 409, then ok with 'drop'
  const valued = (await mk(A, { title: '값 있는 작업', progress: 10 })).item;
  const other = (await mk(A, { title: '옮길 작업' })).item;
  r = await A.c('POST', `${A.wbs}/${other.id}/move`, { parent_id: valued.id }); assert.equal(r.status, 409);
  r = await A.c('POST', `${A.wbs}/${other.id}/move`, { parent_id: valued.id, convert_parent: 'drop' }); assert.equal(r.status, 200);
  server.close();
});

test('UX-008: WBS outside the project window → warnings on the response and a schedule-health reason', async () => {
  const { server, client } = await boot();
  const A = await setup(client);   // project 2026-11-01 ~ 2027-02-28
  const r = await A.c('POST', A.wbs, { title: '늦은 작업', planned_start_date: '2027-02-01', planned_end_date: '2027-03-01' });
  assert.equal(r.status, 201); assert.equal(r.json.warnings.length, 1); assert.match(r.json.warnings[0], /종료일.*넘습니다/);
  const r2 = await A.c('PATCH', `${A.wbs}/${r.json.item.id}`, { planned_start_date: '2026-10-01' });
  assert.equal(r2.json.warnings.length, 2);
  const sched = (await A.c('GET', `${A.purl}/health`)).json.health.dimensions.schedule;
  assert.ok(sched.reasons.some((x) => /프로젝트 종료일을 넘는 WBS 1건/.test(x)), JSON.stringify(sched));
  assert.deepEqual(rangeWarnings({ planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' }, { milestone_date: '2027-03-05' }).length, 1);
  server.close();
});

test('GAP-002: archived WBS items can be listed with include_archived=1 and restored', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const t = (await mk(A, { title: '삭제될 작업' })).item;
  await A.c('POST', `${A.wbs}/${t.id}/archive`, {});
  assert.equal((await A.c('GET', A.wbs)).json.items.length, 0);
  const all = (await A.c('GET', `${A.wbs}?include_archived=1`)).json.items;
  assert.equal(all.length, 1); assert.ok(all[0].archived_at);
  const r = await A.c('POST', `${A.wbs}/${t.id}/restore`, {}); assert.equal(r.status, 200);
  assert.equal((await A.c('GET', A.wbs)).json.items.length, 1);
  server.close();
});

test('UX-006: import accepts on-screen status labels; UX-001: unknown pages are not "Cannot GET"', async () => {
  const col = KINDS.wbs.columns.find((c) => c.key === 'status');
  assert.equal(resolveEnum(col, '예정').value, 'NOT_STARTED');
  assert.equal(resolveEnum(col, '진행중').value, 'IN_PROGRESS');
  assert.equal(resolveEnum(col, '시작 전').value, 'NOT_STARTED');
  assert.ok(resolveEnum(col, '지연').error);
  const { server, client } = await boot();
  const anon = client();
  const r = await anon('GET', '/projects', undefined, { raw: true });
  assert.equal(r.status, 404); assert.doesNotMatch(r.buf.toString(), /Cannot GET/);
  const A = await setup(client);
  const r2 = await A.c('GET', '/projects');
  assert.ok([302, 200].includes(r2.status), String(r2.status));   // signed in → redirected into the app
  server.close();
});
