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
const project = (o = {}) => ({ name: 'P', project_type: 'SI', current_situation: 'NOT_STARTED', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', ...o });
async function setup(client, email = 'u@x.com') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  const req = async (b) => (await c('POST', `${purl}/requirements`, b)).json.requirement;
  const wbs = async (b) => (await c('POST', `${purl}/wbs`, b)).json.item;
  return { c, w, p, purl, rq: `${purl}/requirements`, wb: `${purl}/wbs`, req, wbs };
}

test('N:M links from both sides, link type, duplicates, unlink, history', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const r1 = await S.req({ title: 'SSO 로그인', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const r2 = await S.req({ title: '권한 관리', scope: 'IN_SCOPE' });
  const dev = await S.wbs({ item_type: 'SUMMARY', title: '개발' });
  const be = await S.wbs({ item_type: 'TASK', title: 'Backend', parent_id: dev.id });
  const fe = await S.wbs({ item_type: 'TASK', title: 'Frontend', parent_id: dev.id });
  // requirement side: default type IMPLEMENTS
  let r = await S.c('POST', `${S.rq}/${r1.id}/links`, { wbs_item_id: be.id });
  assert.equal(r.status, 201); assert.equal(r.json.requirement.links[0].link_type, 'IMPLEMENTS'); assert.equal(r.json.requirement.links[0].wbs_code, '1.1');
  r = await S.c('POST', `${S.rq}/${r1.id}/links`, { wbs_item_id: fe.id, link_type: 'SUPPORTS' });
  assert.equal(r.json.requirement.links.length, 2); assert.equal(r.json.requirement.linked_wbs_count, 2);
  // wbs side: same WBS, second requirement → N:M
  r = await S.c('POST', `${S.wb}/${be.id}/links`, { requirement_id: r2.id, link_type: 'VALIDATES' });
  assert.equal(r.status, 201); assert.equal(r.json.item.requirement_links.length, 2);
  assert.deepEqual(r.json.item.requirement_links.map((l) => l.display_id), ['REQ-001', 'REQ-002']);
  assert.equal(r.json.items.find((i) => i.id === be.id).linked_req_count, 2);
  // duplicates rejected from either side
  assert.equal((await S.c('POST', `${S.rq}/${r1.id}/links`, { wbs_item_id: be.id })).status, 400);
  assert.equal((await S.c('POST', `${S.wb}/${be.id}/links`, { requirement_id: r1.id })).status, 400);
  assert.equal((await S.c('POST', `${S.rq}/${r1.id}/links`, { wbs_item_id: be.id, link_type: 'NOPE' })).status, 400);
  // change type, then unlink
  const lid = (await S.c('GET', `${S.rq}/${r1.id}`)).json.requirement.links.find((l) => l.wbs_item_id === be.id).id;
  r = await S.c('PATCH', `${S.rq}/${r1.id}/links/${lid}`, { link_type: 'VALIDATES' });
  assert.equal(r.json.requirement.links.find((l) => l.id === lid).link_type, 'VALIDATES');
  r = await S.c('DELETE', `${S.rq}/${r1.id}/links/${lid}`);
  assert.equal(r.status, 200); assert.equal(r.json.requirement.links.length, 1);
  assert.equal((await S.c('DELETE', `${S.rq}/${r1.id}/links/${lid}`)).status, 404);
  const hist = r.json.requirement.history.map((h) => h.action_type);
  assert.deepEqual(hist.slice(0, 3), ['UNLINKED_WBS', 'LINK_TYPE_CHANGED', 'LINKED_WBS']);
  // mismatched owner of link → 404 (link belongs to r1, not r2)
  const lid2 = r.json.requirement.links[0].id;
  assert.equal((await S.c('DELETE', `${S.rq}/${r2.id}/links/${lid2}`)).status, 404);
  server.close();
});

test('coverage & filters: in-scope only, archived excluded, link filters, guided stats', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const a = await S.req({ title: 'A', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const b = await S.req({ title: 'B', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const cc = await S.req({ title: 'C', scope: 'IN_SCOPE', status: 'REVIEWING' });
  const out = await S.req({ title: 'OUT', scope: 'OUT_OF_SCOPE', status: 'CONFIRMED' });
  const und = await S.req({ title: 'UND' });
  const t1 = await S.wbs({ item_type: 'TASK', title: 'T1' });
  const t2 = await S.wbs({ item_type: 'TASK', title: 'T2' });
  const t3 = await S.wbs({ item_type: 'TASK', title: 'T3' });
  const sum = await S.wbs({ item_type: 'SUMMARY', title: 'S' });
  await S.c('POST', `${S.rq}/${a.id}/links`, { wbs_item_id: t1.id });
  await S.c('POST', `${S.rq}/${out.id}/links`, { wbs_item_id: t2.id }); // out of scope: not counted
  await S.c('POST', `${S.rq}/${und.id}/links`, { wbs_item_id: sum.id }); // undecided: not counted, summary not a task
  let s = (await S.c('GET', S.rq)).json.summary;
  assert.equal(s.in_scope, 3); assert.equal(s.in_scope_linked, 1); assert.equal(s.in_scope_unlinked, 2); assert.equal(s.coverage, 33);
  assert.equal(s.confirmed_unlinked, 1); // B
  // filters
  assert.deepEqual((await S.c('GET', `${S.rq}?link=linked`)).json.requirements.map((x) => x.title), ['A', 'OUT', 'UND']);
  assert.deepEqual((await S.c('GET', `${S.rq}?link=unlinked&scope=IN_SCOPE&status=CONFIRMED`)).json.requirements.map((x) => x.title), ['B']);
  // guided stats on project
  let g = (await S.c('GET', S.purl)).json;
  assert.equal(g.requirements.confirmed_unlinked, 1);
  assert.equal(g.wbs.tasks_unlinked, 1); // T3 (T2 linked to out-of-scope requirement still counts as linked)
  // archive the linked WBS → A becomes unlinked; link row still exists but hidden
  await S.c('POST', `${S.wb}/${t1.id}/archive`, {});
  s = (await S.c('GET', S.rq)).json.summary;
  assert.equal(s.in_scope_linked, 0); assert.equal(s.coverage, 0);
  const aFull = (await S.c('GET', `${S.rq}/${a.id}`)).json.requirement;
  assert.equal(aFull.links.length, 1); assert.ok(aFull.links[0].archived_at); assert.equal(aFull.linked_wbs_count, 0);
  // archive requirement OUT → T2 unlinked
  await S.c('POST', `${S.rq}/${out.id}/archive`, {});
  g = (await S.c('GET', S.purl)).json;
  assert.equal(g.wbs.tasks_unlinked, 2);
  // no in-scope targets → coverage null
  const S2 = await setup(client, 'z@x.com');
  assert.equal((await S2.c('GET', S2.rq)).json.summary.coverage, null);
  // linking to archived entities rejected
  assert.equal((await S.c('POST', `${S.rq}/${b.id}/links`, { wbs_item_id: t1.id })).status, 400);
  assert.equal((await S.c('POST', `${S.wb}/${t3.id}/links`, { requirement_id: out.id })).status, 400);
  server.close();
});

test('cross-project and cross-workspace links blocked; archived project read-only', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const ra = await A.req({ title: 'RA', scope: 'IN_SCOPE' }); const wa = await A.wbs({ item_type: 'TASK', title: 'WA' });
  const rb = await B.req({ title: 'RB' }); const wb = await B.wbs({ item_type: 'TASK', title: 'WB' });
  // A tries to link to B's wbs via own project → 404 (not found in project)
  assert.equal((await A.c('POST', `${A.rq}/${ra.id}/links`, { wbs_item_id: wb.id })).status, 404);
  assert.equal((await A.c('POST', `${A.wb}/${wa.id}/links`, { requirement_id: rb.id })).status, 404);
  // second project in A's workspace: cross-project also blocked
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: 'P2' }))).json.project;
  const w2 = (await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/wbs`, { item_type: 'TASK', title: 'W2' })).json.item;
  assert.equal((await A.c('POST', `${A.rq}/${ra.id}/links`, { wbs_item_id: w2.id })).status, 404);
  // B cannot touch A's links at all
  const link = (await A.c('POST', `${A.rq}/${ra.id}/links`, { wbs_item_id: wa.id })).json.requirement.links[0];
  assert.equal((await B.c('POST', `${A.rq}/${ra.id}/links`, { wbs_item_id: wa.id })).status, 404);
  assert.equal((await B.c('DELETE', `${A.rq}/${ra.id}/links/${link.id}`)).status, 404);
  assert.equal((await B.c('PATCH', `${A.rq}/${ra.id}/links/${link.id}`, { link_type: 'SUPPORTS' })).status, 404);
  assert.equal((await B.c('GET', `${A.rq}?link=linked`)).status, 404);
  assert.equal((await A.c('GET', `${A.rq}/${ra.id}`)).json.requirement.links.length, 1);
  // archived project
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', `${A.rq}/${ra.id}`)).json.requirement.links.length, 1);
  assert.equal((await A.c('POST', `${A.rq}/${ra.id}/links`, { wbs_item_id: wa.id })).status, 409);
  assert.equal((await A.c('PATCH', `${A.rq}/${ra.id}/links/${link.id}`, { link_type: 'SUPPORTS' })).status, 409);
  assert.equal((await A.c('DELETE', `${A.rq}/${ra.id}/links/${link.id}`)).status, 409);
  assert.equal((await A.c('DELETE', `${A.wb}/${wa.id}/links/${link.id}`)).status, 409);
  server.close();
});

test('db trigger rejects a link whose ends are in different projects; list queries stay O(1) statements', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'a@x.com');
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: 'P2' }))).json.project;
  const ra = await A.req({ title: 'RA' });
  const w2 = (await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/wbs`, { item_type: 'TASK', title: 'W2' })).json.item;
  await assert.rejects(async () => (await db.run("INSERT INTO requirement_wbs_links (id, project_id, requirement_id, wbs_item_id) VALUES ('x', ?, ?, ?)", [A.p.id, ra.id, w2.id])), /same project/);
  // bulk: 60 requirements × 60 tasks, 60 links — list + summary respond and counts are right
  for (let i = 0; i < 59; i++) await A.req({ title: `R${i}`, scope: 'IN_SCOPE' });
  const tasks = []; for (let i = 0; i < 60; i++) tasks.push(await A.wbs({ item_type: 'TASK', title: `T${i}` }));
  const reqs = (await A.c('GET', A.rq)).json.requirements;
  for (let i = 0; i < 60; i++) await A.c('POST', `${A.rq}/${reqs[i].id}/links`, { wbs_item_id: tasks[i].id });
  const t0 = Date.now();
  const list = (await A.c('GET', A.rq)).json; const tree = (await A.c('GET', A.wb)).json;
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(list.requirements.filter((r) => r.linked_wbs_count === 1).length, 60);
  assert.equal(tree.items.filter((i) => i.linked_req_count === 1).length, 60);
  assert.equal(list.summary.coverage, 100);
  server.close();
});
