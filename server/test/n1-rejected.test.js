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
const project = (o = {}) => ({ name: 'P', client_name: '테스트 고객사', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', ...o });
async function setup(client, email = 'u@x.com') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  const req = async (b) => (await c('POST', `${purl}/requirements`, b)).json.requirement;
  const wbs = async (b) => (await c('POST', `${purl}/wbs`, b)).json.item;
  return { c, w, p, purl, rq: `${purl}/requirements`, wb: `${purl}/wbs`, req, wbs };
}

test('N1: a REJECTED in-scope requirement is out of every in-scope count (K8 rule) — summary, trace, baseline, coverage, health, unlinked filter', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const ok = await S.req({ title: 'SSO 로그인', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const rej = await S.req({ title: '레거시 연동', scope: 'IN_SCOPE', status: 'REJECTED' });
  const task = await S.wbs({ item_type: 'TASK', title: '로그인 개발' });
  assert.equal((await S.c('POST', `${S.rq}/${ok.id}/links`, { wbs_item_id: task.id })).status, 201);
  const sum = (await S.c('GET', S.rq)).json.summary;
  assert.equal(sum.in_scope, 1); assert.equal(sum.in_scope_confirmed, 1); assert.equal(sum.in_scope_unlinked, 0); assert.equal(sum.coverage, 100);
  const base = (await S.c('GET', `${S.rq}/baseline`)).json.baseline.counts;
  assert.equal(base.in_scope, 1); assert.equal(base.in_scope_unconfirmed, 0);
  const cov = (await S.c('GET', `${S.purl}/tests/coverage`)).json;
  assert.deepEqual(cov.coverage.map((r) => r.id), [ok.id]);   // no 테스트 추가 row for the rejected one
  assert.equal(cov.tests.in_scope, 1); assert.equal(cov.tests.in_scope_unconfirmed, 0); assert.equal(cov.tests.target, 1);
  const scope = (await S.c('GET', `${S.purl}/health`)).json.health.dimensions.scope;
  assert.ok(!scope.reasons.some((x) => /미확정/.test(x)), JSON.stringify(scope));
  // the "WBS 미연결 (범위 내)" link lists what the count counts
  const rows = (await S.c('GET', `${S.rq}?scope=IN_SCOPE&status=DRAFT,REVIEWING,CONFIRMED,ON_HOLD&link=unlinked`)).json.requirements;
  assert.equal(rows.length, 0);
  assert.ok(rej.id);
  server.close();
});
