/* batch7 B3 (#16): WBS 고정 최상위 뼈대 — fixed phase nodes on first open, 409 system_node guards, adoption of old 뼈대 groups,
 * 단계 구조 정리 (preview → apply), 데이터 이관 switch, plan-limit / 'WBS 0건' exclusion, MAX_DEPTH. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boot, setup } from './api-helpers.js';
import { MAX_DEPTH } from '../wbs.js';
import { suggestFor } from '../wbs-structure.js';

const listW = async (A) => (await A.c('GET', A.wbs)).json;
const sys = (items) => items.filter((i) => i.is_system);

test('new project: opening the WBS shows the 6 fixed nodes 1..6; 데이터 이관 있음 → 7 with 이관 4th; nothing counted', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 's1@x.com');
  await A.c('PATCH', A.purl, { data_migration: 'NO' });
  let w = await listW(A);
  assert.deepEqual(sys(w.items).map((i) => `${i.wbs_code}:${i.title}`), ['1:착수', '2:요구사항 정의', '3:분석·설계', '4:구현', '5:시험', '6:전환·오픈']);
  assert.ok(sys(w.items).every((i) => i.item_type === 'SUMMARY' && i.is_group && i.depth === 0));
  assert.equal(w.summary.total, 0, "'WBS 0건' stays 0"); assert.equal(w.summary.summaries, 0); assert.equal(w.outside_count, 0);
  w = await listW(A); assert.equal(sys(w.items).length, 6, 'idempotent');
  // project home / guide still sees an empty WBS
  assert.equal((await A.c('GET', A.purl)).json.wbs?.total ?? 0, 0);
  const B = await setup(client, 's1b@x.com'); await B.c('PATCH', B.purl, { data_migration: 'YES' });
  assert.deepEqual(sys((await listW(B)).items).map((i) => `${i.wbs_code}:${i.title}`), ['1:착수', '2:요구사항 정의', '3:분석·설계', '4:데이터 이관', '5:구현', '6:시험', '7:전환·오픈']);
  // plan limit + usage count exclude the fixed nodes
  const n = Number((await db.get(`SELECT COUNT(*) n FROM wbs_items i JOIN projects p ON p.id = i.project_id WHERE p.workspace_id = ? AND i.archived_at IS NULL AND i.system_key IS NULL`, [A.w])).n);
  assert.equal(n, 0);
  const { workspaceUsage } = await import('../usage.js');
  const u = await workspaceUsage(db, A.w); assert.equal(u.dims.find((d) => d.key === 'wbs').used, 0);
  server.close();
});

test('guards: rename / retype / move / indent / outdent / duplicate / delete / restore a fixed node → 409 system_node; dates, owner, description and children allowed', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 's2@x.com'); await A.c('PATCH', A.purl, { data_migration: 'NO' });
  const nodes = sys((await listW(A)).items); const dev = nodes.find((i) => i.title === '구현');
  const expect409 = async (r) => { assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'system_node'); };
  await expect409(await A.c('PATCH', `${A.wbs}/${dev.id}`, { title: '개발' }));
  await expect409(await A.c('PATCH', `${A.wbs}/${dev.id}`, { item_type: 'TASK' }));
  await expect409(await A.c('POST', `${A.wbs}/${dev.id}/move`, { sequence: 1 }));
  await expect409(await A.c('POST', `${A.wbs}/${dev.id}/indent`, {}));
  await expect409(await A.c('POST', `${A.wbs}/${dev.id}/outdent`, {}));
  await expect409(await A.c('POST', `${A.wbs}/${dev.id}/duplicate`, {}));
  await expect409(await A.c('POST', `${A.wbs}/${dev.id}/archive`, {}));
  assert.equal((await A.c('PATCH', `${A.wbs}/${dev.id}`, { description: '개발 전체', owner_user_id: A.uid })).status, 200);
  assert.equal((await A.c('PATCH', `${A.wbs}/${dev.id}`, { title: '구현', description: '같은 이름은 변경 아님' })).status, 200);
  const child = (await A.c('POST', A.wbs, { title: '로그인 개발', parent_id: dev.id })).json.item; assert.equal(child.wbs_code, '4.1');
  const top = (await A.c('POST', A.wbs, { title: '사용자 최상위' })).json.item; assert.equal(top.wbs_code, '7', 'top-level user items follow the nodes');
  // moving a user item to position 1 at the root still keeps the nodes first
  const r = await A.c('POST', `${A.wbs}/${top.id}/move`, { parent_id: null, sequence: 1 }); assert.equal(r.status, 200);
  assert.equal(r.json.items.find((i) => i.id === top.id).wbs_code, '7');
  // bulk delete skips fixed nodes
  const b = await A.c('POST', `${A.wbs}/bulk`, { ids: [dev.id, top.id], action: 'archive' });
  assert.equal(b.status, 200, JSON.stringify(b.json)); assert.ok(b.json.skipped.some((s) => s.id === dev.id));
  // depth: node + 5 user levels
  assert.equal(MAX_DEPTH, 6);
  let p = dev.id; for (let i = 2; i <= 5; i++) p = (await A.c('POST', A.wbs, { title: `L${i}`, parent_id: i === 2 ? child.id : p })).json.item.id;
  assert.equal((await A.c('POST', A.wbs, { title: 'L6', parent_id: p })).status, 400, 'a 6th user level under the node is refused');
  server.close();
});

test('existing project (737c631 WBS): old 뼈대 groups adopted by phase + name, 안정화 kept, user items not moved; banner → preview → apply', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 's3@x.com'); await A.c('PATCH', A.purl, { data_migration: 'NO' });
  // what 737c631 created: 뼈대 SUMMARY groups (history source 뼈대로 생성) + user items at the root
  const mkOld = async (title, phase, skeleton) => {
    const it = (await A.c('POST', A.wbs, { title, item_type: 'SUMMARY', lifecycle_phase: phase })).json.item;
    if (skeleton) await db.run(`INSERT INTO wbs_history (id, wbs_item_id, action_type, field_name, new_value, changed_by) VALUES (?, ?, 'CREATED', 'source', '뼈대로 생성', ?)`, [randomUUID(), it.id, A.uid]);
    return it;
  };
  const ad = await mkOld('분석·설계', 'ANALYSIS_DESIGN', true); const st = await mkOld('안정화', 'TRANSITION_GO_LIVE', true); const fake = await mkOld('시험', 'TESTING', false);
  const t1 = (await A.c('POST', A.wbs, { title: '화면 설계', parent_id: ad.id })).json.item;
  const loose = (await A.c('POST', A.wbs, { title: '통합 테스트 준비' })).json.item;
  const ms = (await A.c('POST', A.wbs, { title: '서비스 오픈', item_type: 'MILESTONE', milestone_date: '2027-03-31' })).json.item;
  const odd = (await A.c('POST', A.wbs, { title: '기타 잡무' })).json.item;
  const w = await listW(A);
  const nodes = sys(w.items);
  assert.equal(nodes.length, 6);
  assert.equal(nodes.find((n) => n.title === '분석·설계').id, ad.id, 'adopted: same row, now a fixed node'); assert.equal(w.items.find((i) => i.id === t1.id).parent_id, ad.id);
  assert.ok(!nodes.some((n) => n.id === st.id), '안정화 is not a phase name → not adopted');
  assert.ok(!nodes.some((n) => n.id === fake.id), 'a hand-made 시험 group (no 뼈대 history) is not adopted');
  assert.equal(w.outside_count, 5, '안정화 · 시험 · 통합 테스트 준비 · 서비스 오픈 · 기타 잡무');
  const pv = (await A.c('GET', `${A.wbs}/structure/tidy`)).json;
  const sug = Object.fromEntries(pv.items.map((i) => [i.title, i.suggest]));
  assert.deepEqual(sug, { 안정화: 'PHASE:TRANSITION_GO_LIVE', 시험: 'PHASE:TESTING', '통합 테스트 준비': 'PHASE:TESTING', '서비스 오픈': 'PHASE:TRANSITION_GO_LIVE', '기타 잡무': null });
  assert.equal(suggestFor({ title: '데이터 이관', lifecycle_phase: null }), 'PHASE:TRANSITION_GO_LIVE', 'no 이관 node → 전환·오픈');
  // apply: user overrides one row (그대로 두기 for 안정화)
  const moves = pv.items.map((i) => ({ id: i.id, key: i.title === '안정화' ? null : i.suggest }));
  const r = await A.c('POST', `${A.wbs}/structure/tidy`, { moves }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.moved, 3); assert.equal(r.json.outside_count, 2);
  const testNode = r.json.items.find((i) => i.system_key === 'PHASE:TESTING');
  assert.equal(r.json.items.find((i) => i.id === loose.id).parent_id, testNode.id);
  assert.equal(r.json.items.find((i) => i.id === ms.id).parent_id, r.json.items.find((i) => i.system_key === 'PHASE:TRANSITION_GO_LIVE').id);
  assert.equal(r.json.items.find((i) => i.id === odd.id).parent_id, null);
  const h = (await A.c('GET', `${A.wbs}/${loose.id}`)).json.item.history; assert.ok(h.some((x) => x.new_value === '단계 구조 정리'));
  server.close();
});

test('데이터 이관 switch: on → node 4 + trait YES, numbers shift; off with children → 409 "하위 n건을 먼저 옮기세요"; off when empty → archived + NO', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 's4@x.com'); await A.c('PATCH', A.purl, { data_migration: 'NO' });
  await listW(A);
  let r = await A.c('POST', `${A.wbs}/structure/data-migration`, { on: true }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(sys(r.json.items).map((i) => `${i.wbs_code}:${i.title}`), ['1:착수', '2:요구사항 정의', '3:분석·설계', '4:데이터 이관', '5:구현', '6:시험', '7:전환·오픈']);
  assert.equal(r.json.data_migration, 'YES'); assert.equal((await db.get('SELECT data_migration FROM projects WHERE id = ?', [A.p.id])).data_migration, 'YES');
  const dm = sys(r.json.items).find((i) => i.title === '데이터 이관');
  const c1 = (await A.c('POST', A.wbs, { title: '매핑 정의', parent_id: dm.id })).json.item; await A.c('POST', A.wbs, { title: '본 이관', parent_id: dm.id });
  r = await A.c('POST', `${A.wbs}/structure/data-migration`, { on: false }); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'has_children'); assert.match(r.json.error.message, /하위 2건을 먼저 옮기세요/);
  for (const id of [c1.id, (await listW(A)).items.find((i) => i.title === '본 이관').id]) await A.c('POST', `${A.wbs}/${id}/archive`, {});
  r = await A.c('POST', `${A.wbs}/structure/data-migration`, { on: false }); assert.equal(r.status, 200);
  assert.equal(sys(r.json.items).length, 6); assert.equal(r.json.data_migration, 'NO');
  assert.equal((await A.c('POST', `${A.wbs}/${dm.id}/restore`, {})).status, 409, 'the archived node comes back through the switch only');
  r = await A.c('POST', `${A.wbs}/structure/data-migration`, { on: true }); assert.equal(sys(r.json.items).length, 7);
  server.close();
});
