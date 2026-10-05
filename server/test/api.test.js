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
      const res = await fetch(base + path, {
        method, redirect: 'manual',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json, headers: res.headers };
    };
  };
  return { db, server, client };
}
const project = (o = {}) => ({ name: 'A사 AI 상담 시스템 구축', client_name: 'A사', project_type: 'NEW_BUILD', project_scale: '3억 원 · 6개월',
  planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', description: '', ...o });

test('signup creates workspace + OWNER membership, session persists, logout revokes', async () => {
  const { server, client, db } = await boot();
  const c = client();
  const r = await c('POST', '/api/auth/signup', { name: '이성현', email: 'A@x.com', password: 'passw0rd!' });
  assert.equal(r.status, 201);
  assert.equal(r.json.workspaces[0].name, '이성현님의 Workspace');
  assert.equal(r.json.workspaces[0].role, 'OWNER');
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await c('GET', '/api/me')).status, 200);
  assert.equal((await c('POST', '/api/auth/signup', { name: 'x', email: 'a@x.com', password: 'passw0rd!' })).status, 409);
  assert.equal((await c('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await db.get('SELECT COUNT(*) n FROM sessions')).n, 0);
  server.close();
});

test('unauthenticated API and /app are blocked', async () => {
  const { server, client } = await boot();
  const c = client();
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await c('GET', '/api/workspaces/x/projects')).status, 401);
  const app = await c('GET', '/app/projects');
  assert.equal(app.status, 302);
  assert.match(app.headers.get('location'), /^\/login/);
  server.close();
});

test('login: wrong password rejected, correct works, weak signup rejected', async () => {
  const { server, client } = await boot();
  const a = client();
  assert.equal((await a('POST', '/api/auth/signup', { name: 'n', email: 'u@x.com', password: 'short' })).status, 400);
  await a('POST', '/api/auth/signup', { name: 'n', email: 'u@x.com', password: 'passw0rd!' });
  const b = client();
  assert.equal((await b('POST', '/api/auth/login', { email: 'u@x.com', password: 'wrong-pass1' })).status, 401);
  assert.equal((await b('POST', '/api/auth/login', { email: 'U@x.com', password: 'passw0rd!' })).status, 200);
  server.close();
});

test('project CRUD defaults, validation, edit, archive (no delete)', async () => {
  const { server, client } = await boot();
  const c = client();
  const { json } = await c('POST', '/api/auth/signup', { name: 'n', email: 'u@x.com', password: 'passw0rd!' });
  const w = json.workspaces[0].id;
  assert.equal((await c('POST', `/api/workspaces/${w}/projects`, project({ planned_end_date: '2026-01-01' }))).status, 400);
  assert.equal((await c('POST', `/api/workspaces/${w}/projects`, project({ client_name: '' }))).status, 400);
  const created = await c('POST', `/api/workspaces/${w}/projects`, project());
  assert.equal(created.status, 201);
  const p = created.json.project;
  assert.equal(p.status, 'ACTIVE'); assert.equal(p.current_phase, 'INITIATION');
  assert.equal(p.client_name, 'A사'); assert.equal(p.project_scale, '3억 원 · 6개월');
  const upd = await c('PATCH', `/api/workspaces/${w}/projects/${p.id}`, project({ name: '수정됨' }));
  assert.equal(upd.json.project.name, '수정됨');
  assert.equal((await c('DELETE', `/api/workspaces/${w}/projects/${p.id}`, {})).status, 404);
  assert.equal((await c('POST', `/api/workspaces/${w}/projects/${p.id}/archive`, {})).json.project.status, 'ARCHIVED');
  assert.equal((await c('GET', `/api/workspaces/${w}/projects`)).json.projects.length, 0);
  assert.equal((await c('GET', `/api/workspaces/${w}/projects?include_archived=1`)).json.projects.length, 1);
  assert.equal((await c('PATCH', `/api/workspaces/${w}/projects/${p.id}`, project())).status, 409);
  server.close();
});

test('tenant isolation: other workspace members cannot read/modify/create', async () => {
  const { server, client, db } = await boot();
  const a = client(); const b = client();
  const A = (await a('POST', '/api/auth/signup', { name: 'A', email: 'a@x.com', password: 'passw0rd!' })).json;
  const B = (await b('POST', '/api/auth/signup', { name: 'B', email: 'b@x.com', password: 'passw0rd!' })).json;
  const wa = A.workspaces[0].id; const wb = B.workspaces[0].id;
  const p = (await a('POST', `/api/workspaces/${wa}/projects`, project())).json.project;
  // B using A's workspace id
  for (const [m, path, body] of [
    ['GET', `/api/workspaces/${wa}/projects`], ['GET', `/api/workspaces/${wa}/projects/${p.id}`],
    ['PATCH', `/api/workspaces/${wa}/projects/${p.id}`, project()], ['POST', `/api/workspaces/${wa}/projects`, project()],
    ['POST', `/api/workspaces/${wa}/projects/${p.id}/archive`, {}],
  ]) assert.equal((await b(m, path, body)).status, 404, `${m} ${path}`);
  // B using own workspace id with A's project id
  assert.equal((await b('GET', `/api/workspaces/${wb}/projects/${p.id}`)).status, 404);
  assert.equal((await b('PATCH', `/api/workspaces/${wb}/projects/${p.id}`, project({ name: 'hijack' }))).status, 404);
  assert.equal((await db.get('SELECT name FROM projects WHERE id=?', [p.id])).name, 'A사 AI 상담 시스템 구축');
  // DB-level: non-member creator and workspace move rejected by triggers
  const uidB = B.user.id;
  await assert.rejects(async () => (await db.run(`INSERT INTO projects (id,workspace_id,name,client_name,planned_start_date,planned_end_date,created_by)
    VALUES ('x',?, 'n','A사','2026-01-01','2026-02-01',?)`, [wa, uidB])), /workspace member/);
  await assert.rejects(async () => (await db.run('UPDATE projects SET workspace_id=? WHERE id=?', [wb, p.id])), /immutable/);
  server.close();
});

test('cross-origin writes rejected; landing is public and has no beta form', async () => {
  const { server } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /href="\/signup"/);
  assert.match(page, /href="\/login"/);
  assert.doesNotMatch(page, /베타|data-open|id="modal"/);
  assert.equal((await fetch(`${base}/`, { method: 'POST', body: 'x=1' })).status, 404);
  server.close();
});
