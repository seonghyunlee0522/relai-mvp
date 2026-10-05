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
  return { c, w, uid, p, url: `/api/workspaces/${w}/projects/${p.id}/requirements`, purl: `/api/workspaces/${w}/projects/${p.id}` };
}

test('create: REQ-001.. sequential per project, defaults, other project restarts at REQ-001, no reuse after archive', async () => {
  const { server, client } = await boot();
  const { c, w, url } = await setup(client);
  const r1 = await c('POST', url, { title: 'SSO 로그인' });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.requirement.display_id, 'REQ-001');
  assert.equal(r1.json.requirement.type, 'UNSPECIFIED'); assert.equal(r1.json.requirement.priority, 'UNSPECIFIED');
  assert.equal(r1.json.requirement.scope, 'UNDECIDED'); assert.equal(r1.json.requirement.status, 'DRAFT');
  assert.equal(r1.json.requirement.history[0].action_type, 'CREATED');
  const ids = await Promise.all([1, 2, 3, 4].map((i) => c('POST', url, { title: `R${i}` }).then((x) => x.json.requirement.display_id)));
  assert.deepEqual(ids.sort(), ['REQ-002', 'REQ-003', 'REQ-004', 'REQ-005']);
  await c('POST', `${url}/${r1.json.requirement.id}/archive`, {});
  assert.equal((await c('POST', url, { title: 'after archive' })).json.requirement.display_id, 'REQ-006');
  const p2 = (await c('POST', `/api/workspaces/${w}/projects`, project({ name: 'P2' }))).json.project;
  assert.equal((await c('POST', `/api/workspaces/${w}/projects/${p2.id}/requirements`, { title: 'x' })).json.requirement.display_id, 'REQ-001');
  assert.equal((await c('POST', url, { title: '' })).status, 400);
  assert.equal((await c('POST', url, { title: 'x', type: 'BOGUS' })).status, 400);
  server.close();
});

test('update: tracked fields logged only when changed; requester; owner must be workspace member', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r = (await A.c('POST', A.url, { title: 'SSO 로그인' })).json.requirement;
  let u = await A.c('PATCH', `${A.url}/${r.id}`, { type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'REVIEWING', description: 'Entra ID', requester_name: '김OO 책임', requester_organization: 'A사 IT팀', owner_user_id: A.uid });
  assert.equal(u.status, 200);
  assert.deepEqual(u.json.changed.sort(), ['description', 'owner_user_id', 'priority', 'requester', 'scope', 'status', 'type']);
  assert.equal(u.json.requirement.owner_name, '홍길동');
  const h = u.json.requirement.history.map((x) => x.action_type + ':' + (x.field_name || ''));
  assert.equal(h.filter((x) => x.startsWith('UPDATED')).length, 7);
  assert.ok(u.json.requirement.history.find((x) => x.field_name === 'priority' && x.old_value === 'UNSPECIFIED' && x.new_value === 'HIGH'));
  // same values again → nothing changes, no new history
  u = await A.c('PATCH', `${A.url}/${r.id}`, { priority: 'HIGH', title: 'SSO 로그인' });
  assert.deepEqual(u.json.changed, []); assert.equal(u.json.requirement.history.length, 8);
  // scope and status independent
  u = await A.c('PATCH', `${A.url}/${r.id}`, { scope: 'OUT_OF_SCOPE', status: 'CONFIRMED' });
  assert.equal(u.json.requirement.scope, 'OUT_OF_SCOPE'); assert.equal(u.json.requirement.status, 'CONFIRMED');
  // owner from another workspace rejected (API + trigger)
  assert.equal((await A.c('PATCH', `${A.url}/${r.id}`, { owner_user_id: B.uid })).status, 400);
  assert.equal((await A.c('POST', A.url, { title: 'x', owner_user_id: B.uid })).status, 400);
  server.close();
});

test('acceptance criteria: add/update/delete/reorder with history; list search & filters; summary', async () => {
  const { server, client } = await boot();
  const { c, url, uid } = await setup(client);
  const r = (await c('POST', url, { title: 'SSO 로그인', criteria: ['Entra ID 계정으로 로그인할 수 있다.', '비인가 사용자는 접근할 수 없다.'] })).json.requirement;
  assert.equal(r.criteria.length, 2);
  let x = (await c('POST', `${url}/${r.id}/criteria`, { content: '로그인 실패 시 오류 메시지가 표시된다.' })).json.requirement;
  assert.deepEqual(x.criteria.map((q) => q.sequence), [1, 2, 3]);
  x = (await c('PATCH', `${url}/${r.id}/criteria/${x.criteria[2].id}`, { sequence: 1 })).json.requirement;
  assert.equal(x.criteria[0].content, '로그인 실패 시 오류 메시지가 표시된다.');
  x = (await c('PATCH', `${url}/${r.id}/criteria/${x.criteria[0].id}`, { content: '로그인 실패 시 오류가 표시된다.' })).json.requirement;
  assert.equal(x.criteria[0].content, '로그인 실패 시 오류가 표시된다.');
  x = (await c('DELETE', `${url}/${r.id}/criteria/${x.criteria[1].id}`)).json.requirement;
  assert.deepEqual(x.criteria.map((q) => q.sequence), [1, 2]);
  assert.deepEqual(x.history.map((h) => h.action_type).slice(0, 3), ['CRITERION_REMOVED', 'CRITERION_UPDATED', 'CRITERION_ADDED']);
  assert.equal((await c('POST', `${url}/${r.id}/criteria`, { content: '' })).status, 400);

  // more data for search/filter
  await c('POST', url, { title: '권한 관리', type: 'SECURITY', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED', owner_user_id: uid });
  await c('POST', url, { title: '배치 연동', description: 'SAP 인터페이스', type: 'INTERFACE', priority: 'LOW', scope: 'OUT_OF_SCOPE', status: 'REJECTED' });
  const arch = (await c('POST', url, { title: '삭제 예정' })).json.requirement;
  await c('POST', `${url}/${arch.id}/archive`, {});
  const all = (await c('GET', url)).json;
  assert.deepEqual(all.requirements.map((q) => q.display_id), ['REQ-001', 'REQ-002', 'REQ-003']);
  assert.equal((await c('GET', `${url}?include_archived=1`)).json.requirements.length, 4);
  assert.equal((await c('GET', `${url}?q=SAP`)).json.requirements[0].display_id, 'REQ-003');
  assert.equal((await c('GET', `${url}?q=req-002`)).json.requirements.length, 1);
  assert.equal((await c('GET', `${url}?type=SECURITY,INTERFACE`)).json.requirements.length, 2);
  assert.equal((await c('GET', `${url}?type=SECURITY&priority=HIGH&status=CONFIRMED`)).json.requirements.length, 1);
  assert.equal((await c('GET', `${url}?scope=IN_SCOPE&status=REJECTED`)).json.requirements.length, 0);
  assert.equal((await c('GET', `${url}?owner=${uid}`)).json.requirements.length, 1);
  assert.equal((await c('GET', `${url}?owner=none`)).json.requirements.length, 2);
  assert.deepEqual({ ...all.summary }, { total: 3, in_scope: 1, out_of_scope: 1, scope_undecided: 1, confirmed: 1, reviewing: 0, draft: 1, type_unspecified: 1, priority_unspecified: 1, in_scope_confirmed: 1, non_functional: 2, in_scope_linked: 0, in_scope_unlinked: 1, coverage: 0, confirmed_unlinked: 1 });
  server.close();
});

test('archived requirement immutable; archived project read-only; guided stats on project', async () => {
  const { server, client } = await boot();
  const { c, url, purl } = await setup(client);
  const r = (await c('POST', url, { title: 'x' })).json.requirement;
  await c('POST', `${url}/${r.id}/archive`, {});
  assert.equal((await c('PATCH', `${url}/${r.id}`, { title: 'y' })).status, 409);
  assert.equal((await c('POST', `${url}/${r.id}/criteria`, { content: 'c' })).status, 409);
  await c('POST', url, { title: 'live', type: 'FUNCTIONAL' });
  const g = (await c('GET', purl)).json;
  assert.equal(g.requirements.total, 1); assert.equal(g.requirements.type_unspecified, 0);
  await c('POST', `${purl}/archive`, {});
  assert.equal((await c('GET', url)).status, 200);
  assert.equal((await c('POST', url, { title: 'nope' })).status, 409);
  const live = (await c('GET', url)).json.requirements[0];
  assert.equal((await c('PATCH', `${url}/${live.id}`, { title: 'nope' })).status, 409);
  assert.equal((await c('POST', `${url}/${live.id}/archive`, {})).status, 409);
  server.close();
});

test('tenant isolation: other workspace cannot list/read/modify requirements via any id combination', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r = (await A.c('POST', A.url, { title: 'secret', criteria: ['c1'] })).json.requirement;
  for (const [m, path, body] of [
    ['GET', A.url], ['POST', A.url, { title: 'x' }], ['GET', `${A.url}/${r.id}`], ['PATCH', `${A.url}/${r.id}`, { title: 'h' }],
    ['POST', `${A.url}/${r.id}/archive`, {}], ['POST', `${A.url}/${r.id}/criteria`, { content: 'h' }],
    ['PATCH', `${A.url}/${r.id}/criteria/${r.criteria[0].id}`, { content: 'h' }], ['DELETE', `${A.url}/${r.id}/criteria/${r.criteria[0].id}`],
    ['GET', `${B.url}/${r.id}`], ['PATCH', `${B.url}/${r.id}`, { title: 'h' }], ['POST', `${B.url}/${r.id}/criteria`, { content: 'h' }],
    ['GET', `/api/workspaces/${B.w}/projects/${A.p.id}/requirements`],
  ]) assert.equal((await B.c(m, path, body)).status, 404, `${m} ${path}`);
  assert.equal((await B.c('GET', `/api/workspaces/${A.w}/members`)).status, 404);
  const fresh = (await A.c('GET', `${A.url}/${r.id}`)).json.requirement;
  assert.equal(fresh.title, 'secret'); assert.equal(fresh.criteria[0].content, 'c1');
  server.close();
});
