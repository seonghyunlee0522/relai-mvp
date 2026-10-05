/* Stabilization suite: CR → requirement history source, relation integrity across all link tables, common counters, metrics snapshot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { getNextProjectSequence, formatDisplayId, resolveLinkTarget } from '../common.js';
import { tx } from '../db.js';

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
async function setup(client, email) {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  const post = async (path, b, key) => { const r = await c('POST', `${purl}/${path}`, b); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.json)}`); return r.json[key]; };
  return { c, w, uid, p, purl,
    req: async (b) => (await post('requirements', { scope: 'IN_SCOPE', ...b }, 'requirement')),
    wbs: async (b) => (await post('wbs', { item_type: 'TASK', ...b }, 'item')),
    cr: async (b) => (await post('changes', b, 'change')),
    issue: async (b) => (await post('issues', b, 'issue')),
    risk: async (b) => (await post('risks', b, 'risk')),
    tc: async (b) => (await post('tests', b, 'test')),
    acc: async (b) => (await post('acceptances', b, 'acceptance')) };
}

test('CR → requirement history: source recorded, optional, survives CR archive, rejects foreign CR', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r = await A.req({ title: 'SSO 로그인', scope: 'UNDECIDED' });
  const cr = await A.cr({ title: 'MFA 기능 추가' });
  // plain edit: no source
  let u = await A.c('PATCH', `${A.purl}/requirements/${r.id}`, { priority: 'HIGH' });
  assert.equal(u.status, 200); assert.equal(u.json.requirement.history[0].source_change_request_id, null);
  // edit with source
  u = await A.c('PATCH', `${A.purl}/requirements/${r.id}`, { scope: 'IN_SCOPE', source_change_request_id: cr.id });
  assert.equal(u.status, 200);
  const h = u.json.requirement.history[0];
  assert.equal(h.field_name, 'scope'); assert.equal(h.old_value, 'UNDECIDED'); assert.equal(h.new_value, 'IN_SCOPE');
  assert.equal(h.source_change_request_id, cr.id); assert.equal(h.source_change_display_id, 'CR-001'); assert.equal(h.source_change_title, 'MFA 기능 추가');
  // no-op edit with source adds no row
  const before = u.json.requirement.history.length;
  u = await A.c('PATCH', `${A.purl}/requirements/${r.id}`, { scope: 'IN_SCOPE', source_change_request_id: cr.id });
  assert.equal(u.json.requirement.history.length, before);
  // foreign CR / unknown CR → 400
  const bcr = await B.cr({ title: 'B CR' });
  assert.equal((await A.c('PATCH', `${A.purl}/requirements/${r.id}`, { title: 'x', source_change_request_id: bcr.id })).status, 400);
  assert.equal((await A.c('PATCH', `${A.purl}/requirements/${r.id}`, { title: 'x', source_change_request_id: 'nope' })).status, 400);
  // archive CR → history still readable, archived flag exposed
  await A.c('POST', `${A.purl}/changes/${cr.id}/archive`, {});
  const g = await A.c('GET', `${A.purl}/requirements/${r.id}`);
  const hh = g.json.requirement.history.find((x) => x.source_change_request_id === cr.id);
  assert.ok(hh); assert.equal(hh.source_change_display_id, 'CR-001'); assert.ok(hh.source_change_archived_at);
  // archived CR can no longer be a source
  assert.equal((await A.c('PATCH', `${A.purl}/requirements/${r.id}`, { title: 'y', source_change_request_id: cr.id })).status, 400);
  server.close();
});

test('relation integrity: same-project, cross-workspace, archived target, duplicate, bad type — every link table', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r = await A.req({ title: 'R' }); const w = await A.wbs({ title: 'W' }); const cr = await A.cr({ title: 'C' });
  const i = await A.issue({ title: 'I' }); const k = await A.risk({ title: 'K' }); const t = await A.tc({ title: 'T' }); const a = await A.acc({ title: 'A' });
  const rA = await A.req({ title: 'R-arch' }); await A.c('POST', `${A.purl}/requirements/${rA.id}/archive`, {});
  const bR = await B.req({ title: 'BR' }); const bW = await B.wbs({ title: 'BW' }); const bT = await B.tc({ title: 'BT' });
  const cases = [
    // [path, good body, foreign body, archived body, bad-type body]
    [`${A.purl}/requirements/${r.id}/links`, { wbs_item_id: w.id }, { wbs_item_id: bW.id }, null, null],
    [`${A.purl}/changes/${cr.id}/requirements`, { requirement_id: r.id }, { requirement_id: bR.id }, { requirement_id: rA.id }, null],
    [`${A.purl}/changes/${cr.id}/impacts`, { wbs_item_id: w.id }, { wbs_item_id: bW.id }, null, null],
    [`${A.purl}/issues/${i.id}/links`, { target_type: 'REQUIREMENT', target_id: r.id }, { target_type: 'REQUIREMENT', target_id: bR.id }, { target_type: 'REQUIREMENT', target_id: rA.id }, { target_type: 'TEST', target_id: t.id }],
    [`${A.purl}/risks/${k.id}/links`, { target_type: 'WBS', target_id: w.id }, { target_type: 'WBS', target_id: bW.id }, null, { target_type: 'ACCEPTANCE', target_id: a.id }],
    [`${A.purl}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: r.id }, { target_type: 'REQUIREMENT', target_id: bR.id }, { target_type: 'REQUIREMENT', target_id: rA.id }, { target_type: 'CHANGE', target_id: cr.id }],
    [`${A.purl}/acceptances/${a.id}/links`, { target_type: 'TEST', target_id: t.id }, { target_type: 'TEST', target_id: bT.id }, { target_type: 'REQUIREMENT', target_id: rA.id }, { target_type: 'WBS', target_id: w.id }],
  ];
  for (const [path, good, foreign, archived, badType] of cases) {
    assert.equal((await A.c('POST', path, good)).status, 201, `good ${path}`);
    assert.equal((await A.c('POST', path, good)).status, 400, `duplicate ${path}`);
    assert.equal((await A.c('POST', path, foreign)).status, 404, `foreign ${path}`);
    if (archived) assert.equal((await A.c('POST', path, archived)).status, 400, `archived ${path}`);
    if (badType) assert.equal((await A.c('POST', path, badType)).status, 400, `bad type ${path}`);
    assert.equal((await B.c('POST', path, good)).status, 404, `non-member ${path}`);
  }
  // archived project: every relation write is 409
  await A.c('POST', `${A.purl}/archive`, {});
  for (const [path, good] of cases) assert.equal((await A.c('POST', path, good)).status, 409, `archived project ${path}`);
  server.close();
});

test('common project counter: independent per entity type and per project, never reused after archive', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com');
  const ids = {};
  ids.r = (await A.req({ title: 'r' })).display_id; ids.c = (await A.cr({ title: 'c' })).display_id; ids.i = (await A.issue({ title: 'i' })).display_id;
  ids.k = (await A.risk({ title: 'k' })).display_id; ids.t = (await A.tc({ title: 't' })).display_id; ids.a = (await A.acc({ title: 'a' })).display_id;
  assert.deepEqual(ids, { r: 'REQ-001', c: 'CR-001', i: 'ISS-001', k: 'RSK-001', t: 'TC-001', a: 'ACC-001' });
  const r2 = await A.req({ title: 'r2' }); await A.c('POST', `${A.purl}/requirements/${r2.id}/archive`, {});
  assert.equal((await A.req({ title: 'r3' })).display_id, 'REQ-003');
  // direct helper: atomic increments inside a tx
  const seqs = await tx(db, async (db) => { const out = []; for (let i = 0; i < 3; i++) out.push(await getNextProjectSequence(db, A.p.id, 'REQUIREMENT')); return out; });
  assert.deepEqual(seqs, [4, 5, 6]); assert.equal(formatDisplayId('REQUIREMENT', 7), 'REQ-007');
  // resolveLinkTarget whitelist
  await assert.rejects(() => resolveLinkTarget(db, A.p, 'USER', 'x'));
  assert.equal((await resolveLinkTarget(db, A.p, 'REQUIREMENT', 'nope')).error, 'not_found');
  server.close();
});

test('metrics: snapshot endpoint + attention items + kpis from computed data only', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const r1 = await A.req({ title: 'R1' }); await A.req({ title: 'R2' });
  const w = await A.wbs({ title: 'W', planned_start_date: '2026-01-01', planned_end_date: '2026-01-10' });
  await A.c('POST', `${A.purl}/requirements/${r1.id}/links`, { wbs_item_id: w.id });
  await A.issue({ title: 'crit', severity: 'CRITICAL' });
  const cr = await A.cr({ title: 'C' }); await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'submit' }); await A.c('POST', `${A.purl}/changes/${cr.id}/transition`, { action: 'approve' });
  const t = await A.tc({ title: 'T' }); await A.c('POST', `${A.purl}/tests/${t.id}/links`, { target_type: 'REQUIREMENT', target_id: r1.id }); await A.c('POST', `${A.purl}/tests/${t.id}/executions`, { result: 'FAIL' });
  const a = await A.acc({ title: 'A' }); await A.c('POST', `${A.purl}/acceptances/${a.id}/transition`, { action: 'submit' }); await A.c('POST', `${A.purl}/acceptances/${a.id}/transition`, { action: 'rework', decision_note: 'x' });
  const s = await A.c('GET', `${A.purl}/snapshot`);
  assert.equal(s.status, 200);
  assert.deepEqual(Object.keys(s.json.kpis), ['wbs_progress', 'requirement_coverage', 'test_coverage']);   // Lifecycle V2: no guided progress percentage
  assert.equal(s.json.kpis.requirement_coverage, 50); assert.equal(s.json.kpis.test_coverage, 50);
  const types = s.json.attention.map((x) => `${x.type}:${x.severity}`);
  for (const t2 of ['ISSUE:crit', 'TEST:crit', 'CHANGE:warn', 'WBS:warn', 'ACCEPTANCE:warn']) assert.ok(types.includes(t2), t2);
  assert.ok(types.indexOf('ISSUE:crit') < types.indexOf('CHANGE:warn'), 'crit first');
  assert.ok(Array.isArray(s.json.upcoming));
  const g = await A.c('GET', A.purl); assert.ok(g.json.kpis); assert.ok(g.json.attention.length >= 5);
  assert.equal((await B.c('GET', `${A.purl}/snapshot`)).status, 404);
  server.close();
});
