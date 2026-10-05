import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';

async function boot() {
  const db = await testDb();
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json };
    };
  };
  return { db, server, client };
}
const project = (o = {}) => ({ name: 'P', client_name: '테스트 고객사', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', ...o });
async function setup(client, email = 'u@x.com') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  return { c, w, uid, p, url: `/api/workspaces/${w}/projects/${p.id}/wbs`, purl: `/api/workspaces/${w}/projects/${p.id}` };
}
const mk = async (c, url, body) => { const r = await c('POST', url, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };
const codes = (items) => items.map((i) => `${i.wbs_code}:${i.title}`);

test('hierarchy: summary/task/milestone, 3+ depth, codes, reorder, reparent, cycle guard', async () => {
  const { server, client } = await boot();
  const { c, url } = await setup(client);
  const a = await mk(c, url, { item_type: 'SUMMARY', title: '분석' });
  const a1 = await mk(c, url, { item_type: 'TASK', title: '요구사항 분석', parent_id: a.id });
  const a2 = await mk(c, url, { item_type: 'TASK', title: '인터페이스 분석', parent_id: a.id });
  const b = await mk(c, url, { item_type: 'SUMMARY', title: '설계' });
  const b1 = await mk(c, url, { item_type: 'SUMMARY', title: '화면 설계', parent_id: b.id });
  const b11 = await mk(c, url, { item_type: 'TASK', title: '목록 화면', parent_id: b1.id });
  const b111 = await mk(c, url, { item_type: 'TASK', title: '필터 영역', parent_id: b11.id });
  const m = await mk(c, url, { item_type: 'MILESTONE', title: '요구사항 확정', milestone_date: '2026-10-15' });
  let t = (await c('GET', url)).json;
  assert.deepEqual(codes(t.items), ['1:분석', '1.1:요구사항 분석', '1.2:인터페이스 분석', '2:설계', '2.1:화면 설계', '2.1.1:목록 화면', '2.1.1.1:필터 영역', '3:요구사항 확정']);
  assert.deepEqual(t.items.map((i) => i.depth), [0, 1, 1, 0, 1, 2, 3, 0]);
  // reorder within parent
  t = (await c('POST', `${url}/${a2.id}/move`, { sequence: 1 })).json;
  assert.deepEqual(codes(t.items).slice(0, 3), ['1:분석', '1.1:인터페이스 분석', '1.2:요구사항 분석']);
  // reparent b1 under a → codes recomputed, ids intact
  t = (await c('POST', `${url}/${b1.id}/move`, { parent_id: a.id, sequence: 1 })).json;
  assert.deepEqual(codes(t.items), ['1:분석', '1.1:화면 설계', '1.1.1:목록 화면', '1.1.1.1:필터 영역', '1.2:인터페이스 분석', '1.3:요구사항 분석', '2:설계', '3:요구사항 확정']);
  assert.equal(t.items.find((i) => i.id === b111.id).wbs_code, '1.1.1.1');
  // cycle: move a under its descendant b11
  assert.equal((await c('POST', `${url}/${a.id}/move`, { parent_id: b11.id })).status, 400);
  assert.equal((await c('POST', `${url}/${a.id}/move`, { parent_id: a.id })).status, 400);
  // milestone cannot be a parent
  assert.equal((await c('POST', url, { item_type: 'TASK', title: 'x', parent_id: m.id })).status, 400);
  // move to root end
  t = (await c('POST', `${url}/${b1.id}/move`, { parent_id: null })).json;
  assert.equal(t.items.find((i) => i.id === b1.id).wbs_code, '4');
  server.close();
});

test('fields: owner member check, progress rules, status→100, date validation, milestone date', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const s = await mk(A.c, A.url, { item_type: 'SUMMARY', title: 'S' });
  const t = await mk(A.c, A.url, { item_type: 'TASK', title: 'T', parent_id: s.id });
  const m = await mk(A.c, A.url, { item_type: 'MILESTONE', title: 'M' });
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { owner_user_id: B.uid })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { owner_user_id: A.uid })).json.item.owner_name, '홍길동');
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { progress: 101 })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { progress: -1 })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { progress: 2.5 })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${s.id}`, { progress: 50 })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${m.id}`, { progress: 50 })).status, 400);
  let r = (await A.c('PATCH', `${A.url}/${t.id}`, { progress: 40, status: 'IN_PROGRESS' })).json.item;
  assert.equal(r.progress, 40); assert.equal(r.status, 'IN_PROGRESS');
  r = (await A.c('PATCH', `${A.url}/${t.id}`, { status: 'COMPLETED' })).json.item;
  assert.equal(r.progress, 100);
  r = (await A.c('PATCH', `${A.url}/${t.id}`, { progress: 100, status: 'IN_PROGRESS' })).json.item;
  assert.equal(r.status, 'IN_PROGRESS'); // 100 does not auto-complete
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { planned_start_date: '2026-11-10', planned_end_date: '2026-11-05' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { planned_start_date: '2026-11-01', planned_end_date: '2026-11-05' })).status, 200);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { planned_end_date: '2026-10-30' })).status, 400); // vs existing start
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { actual_start_date: '2026-11-02', actual_end_date: '2026-11-01' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { actual_start_date: '2026-11-02', actual_end_date: '2026-11-06' })).status, 200);
  assert.equal((await A.c('PATCH', `${A.url}/${t.id}`, { planned_start_date: 'nope' })).status, 400);
  r = (await A.c('PATCH', `${A.url}/${m.id}`, { milestone_date: '2026-12-01', status: 'COMPLETED' })).json.item;
  assert.equal(r.milestone_date, '2026-12-01'); assert.equal(r.computed_progress, 100);
  server.close();
});

test('progress roll-up: summary mean (recursive, milestones excluded), project wbs progress = leaf task mean', async () => {
  const { server, client } = await boot();
  const { c, url, purl } = await setup(client);
  const dev = await mk(c, url, { item_type: 'SUMMARY', title: '개발' });
  const be = await mk(c, url, { item_type: 'TASK', title: 'Backend', parent_id: dev.id, progress: 100, status: 'COMPLETED' });
  const fe = await mk(c, url, { item_type: 'TASK', title: 'Frontend', parent_id: dev.id, progress: 50, status: 'IN_PROGRESS' });
  await mk(c, url, { item_type: 'MILESTONE', title: '개발 완료', parent_id: dev.id, milestone_date: '2026-11-20' });
  const test = await mk(c, url, { item_type: 'SUMMARY', title: '테스트' });
  const sub = await mk(c, url, { item_type: 'SUMMARY', title: '통합 테스트', parent_id: test.id });
  await mk(c, url, { item_type: 'TASK', title: 'TC 작성', parent_id: sub.id, progress: 20 });
  const empty = await mk(c, url, { item_type: 'SUMMARY', title: '빈 그룹' });
  const t = (await c('GET', url)).json;
  const cp = (id) => t.items.find((i) => i.id === id).computed_progress;
  assert.equal(cp(dev.id), 75); assert.equal(cp(sub.id), 20); assert.equal(cp(test.id), 20); assert.equal(cp(empty.id), 0);
  assert.equal(t.summary.progress, Math.round((100 + 50 + 20) / 3)); // 57
  assert.equal(t.summary.milestones, 1); assert.equal(t.summary.tasks, 3);
  const g = (await c('GET', purl)).json;
  assert.equal(g.wbs.progress, 57); assert.equal(g.wbs.total, 8);
  assert.ok(!('progress' in g)); // Lifecycle V2: no guided progress percentage on the project payload
  server.close();
});

test('dependencies: FS links, multiple predecessors, self/cycle/duplicate/cross-project rejected, removal', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const a = await mk(A.c, A.url, { item_type: 'TASK', title: 'A' });
  const b = await mk(A.c, A.url, { item_type: 'TASK', title: 'B' });
  const cc = await mk(A.c, A.url, { item_type: 'TASK', title: 'C' });
  const d = await mk(A.c, A.url, { item_type: 'TASK', title: 'D' });
  const other = await mk(B.c, B.url, { item_type: 'TASK', title: 'X' });
  assert.equal((await A.c('POST', `${A.url}/${b.id}/dependencies`, { predecessor_id: a.id })).status, 201);
  assert.equal((await A.c('POST', `${A.url}/${cc.id}/dependencies`, { predecessor_id: b.id })).status, 201);
  let r = await A.c('POST', `${A.url}/${cc.id}/dependencies`, { predecessor_id: d.id });
  assert.equal(r.status, 201); assert.equal(r.json.item.predecessors.length, 2);
  assert.equal((await A.c('POST', `${A.url}/${a.id}/dependencies`, { predecessor_id: cc.id })).status, 400); // C→A cycle
  assert.equal((await A.c('POST', `${A.url}/${a.id}/dependencies`, { predecessor_id: a.id })).status, 400); // self
  assert.equal((await A.c('POST', `${A.url}/${b.id}/dependencies`, { predecessor_id: a.id })).status, 400); // duplicate
  assert.equal((await A.c('POST', `${A.url}/${b.id}/dependencies`, { predecessor_id: other.id })).status, 400); // other project
  assert.equal((await A.c('GET', A.url)).json.summary.dependencies, 3);
  const depId = r.json.item.predecessors.find((p) => p.predecessor_id === d.id).id;
  r = await A.c('DELETE', `${A.url}/${cc.id}/dependencies/${depId}`);
  assert.equal(r.status, 200); assert.equal(r.json.item.predecessors.length, 1);
  // after removing B→C chain partially, C→A still cycle? A→B→C remains, so C as predecessor of A is still a cycle
  assert.equal((await A.c('POST', `${A.url}/${a.id}/dependencies`, { predecessor_id: cc.id })).status, 400);
  server.close();
});

test('archive cascades to children, dependencies hidden, codes renumbered; archived project read-only', async () => {
  const { server, client } = await boot();
  const { c, url, purl } = await setup(client);
  const s = await mk(c, url, { item_type: 'SUMMARY', title: 'S' });
  const t1 = await mk(c, url, { item_type: 'TASK', title: 'T1', parent_id: s.id });
  const t2 = await mk(c, url, { item_type: 'TASK', title: 'T2', parent_id: s.id });
  const z = await mk(c, url, { item_type: 'TASK', title: 'Z' });
  await c('POST', `${url}/${z.id}/dependencies`, { predecessor_id: t2.id });
  const r = (await c('POST', `${url}/${s.id}/archive`, {})).json;
  assert.deepEqual(r.archived_ids.sort(), [s.id, t1.id, t2.id].sort());
  assert.deepEqual(codes(r.items), ['1:Z']);
  assert.equal(r.summary.dependencies, 0);
  assert.equal((await c('GET', `${url}/${z.id}`)).json.item.predecessors.length, 0);
  assert.equal((await c('PATCH', `${url}/${t1.id}`, { title: 'x' })).status, 409);
  await c('POST', `${purl}/archive`, {});
  assert.equal((await c('GET', url)).status, 200);
  assert.equal((await c('POST', url, { item_type: 'TASK', title: 'n' })).status, 409);
  assert.equal((await c('PATCH', `${url}/${z.id}`, { title: 'n' })).status, 409);
  assert.equal((await c('POST', `${url}/${z.id}/move`, { sequence: 1 })).status, 409);
  assert.equal((await c('POST', `${url}/${z.id}/archive`, {})).status, 409);
  assert.equal((await c('POST', `${url}/${z.id}/dependencies`, { predecessor_id: z.id })).status, 409);
  server.close();
});

test('tenant isolation on wbs routes', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const a = await mk(A.c, A.url, { item_type: 'TASK', title: 'secret' });
  for (const [m, path, body] of [
    ['GET', A.url], ['POST', A.url, { item_type: 'TASK', title: 'x' }], ['GET', `${A.url}/${a.id}`], ['PATCH', `${A.url}/${a.id}`, { title: 'h' }],
    ['POST', `${A.url}/${a.id}/move`, { sequence: 1 }], ['POST', `${A.url}/${a.id}/archive`, {}], ['POST', `${A.url}/${a.id}/dependencies`, { predecessor_id: a.id }],
    ['GET', `${B.url}/${a.id}`], ['PATCH', `${B.url}/${a.id}`, { title: 'h' }], ['POST', `${B.url}/${a.id}/archive`, {}],
  ]) assert.equal((await B.c(m, path, body)).status, 404, `${m} ${path}`);
  assert.equal((await A.c('GET', `${A.url}/${a.id}`)).json.item.title, 'secret');
  server.close();
});
