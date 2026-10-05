import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { computeRiskLevel } from '../raid.js';

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
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  return { c, w, uid, p, purl, is: `${purl}/issues`, rs: `${purl}/risks`,
    req: async (b) => (await c('POST', `${purl}/requirements`, b)).json.requirement,
    wbs: async (b) => (await c('POST', `${purl}/wbs`, b)).json.item,
    cr: async (b) => (await c('POST', `${purl}/changes`, b)).json.change };
}
const yesterday = () => new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86400e3).toISOString().slice(0, 10);

test('risk matrix: all 9 combinations', () => {
  const exp = { 'LOW,LOW': 'LOW', 'LOW,MEDIUM': 'LOW', 'LOW,HIGH': 'MEDIUM', 'MEDIUM,LOW': 'LOW', 'MEDIUM,MEDIUM': 'MEDIUM', 'MEDIUM,HIGH': 'HIGH', 'HIGH,LOW': 'MEDIUM', 'HIGH,MEDIUM': 'HIGH', 'HIGH,HIGH': 'CRITICAL' };
  for (const [k, v] of Object.entries(exp)) { const [p, i] = k.split(','); assert.equal(computeRiskLevel(p, i), v, k); }
});

test('issues: ISS-001 per project, fields, owner, transitions, resolution, overdue, archive', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  let r = await A.c('POST', A.is, { title: '고객 API 미제공', severity: 'HIGH', due_date: yesterday() });
  assert.equal(r.status, 201); const i1 = r.json.issue;
  assert.equal(i1.display_id, 'ISS-001'); assert.equal(i1.status, 'OPEN'); assert.equal(i1.is_overdue, 1); assert.ok(i1.identified_at);
  assert.equal((await A.c('POST', A.is, { title: 'x' })).json.issue.display_id, 'ISS-002');
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: 'P2' }))).json.project;
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/issues`, { title: 'x' })).json.issue.display_id, 'ISS-001');
  assert.equal((await A.c('POST', A.is, { title: 'x', severity: 'SEVERE' })).status, 400);
  assert.equal((await A.c('PATCH', `${A.is}/${i1.id}`, { owner_user_id: B.uid })).status, 400);
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { owner_user_id: A.uid, due_date: tomorrow() });
  assert.equal(r.json.issue.owner_name, '홍길동'); assert.equal(r.json.issue.is_overdue, 0);
  // transitions
  assert.equal((await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'CLOSED' })).status, 409);
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'IN_PROGRESS' }); assert.equal(r.json.issue.status, 'IN_PROGRESS');
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'BLOCKED' }); assert.equal(r.json.issue.status, 'BLOCKED');
  assert.equal((await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'RESOLVED' })).status, 409); // blocked → resolved not allowed
  await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'IN_PROGRESS' });
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'RESOLVED', resolution: 'Mock API 기반으로 우선 개발' });
  assert.equal(r.json.issue.status, 'RESOLVED'); assert.ok(r.json.issue.resolved_at); assert.equal(r.json.issue.resolution, 'Mock API 기반으로 우선 개발');
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'CLOSED' }); assert.ok(r.json.issue.closed_at);
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { status: 'OPEN' }); assert.equal(r.json.issue.closed_at, null); // reopen allowed
  const hist = r.json.issue.history.filter((h) => h.action_type === 'STATUS_CHANGED').map((h) => h.new_value);
  assert.deepEqual(hist, ['OPEN', 'CLOSED', 'RESOLVED', 'IN_PROGRESS', 'BLOCKED', 'IN_PROGRESS']);
  // unchanged PATCH → no history
  const before = r.json.issue.history.length;
  r = await A.c('PATCH', `${A.is}/${i1.id}`, { severity: 'HIGH' }); assert.deepEqual(r.json.changed, []); assert.equal(r.json.issue.history.length, before);
  // overdue stats and archive
  await A.c('POST', A.is, { title: 'late', due_date: yesterday(), severity: 'CRITICAL' });
  let st = (await A.c('GET', A.is)).json.issues;
  assert.equal(st.overdue, 1); assert.equal(st.critical, 1); assert.equal(st.active, 3);
  const ar = await A.c('POST', `${A.is}/${i1.id}/archive`, {}); assert.ok(ar.json.issue.archived_at);
  assert.equal((await A.c('GET', A.is)).json.items.length, 2);
  assert.equal((await A.c('PATCH', `${A.is}/${i1.id}`, { title: 'x' })).status, 409);
  assert.equal((await A.c('POST', A.is, { title: 'next' })).json.issue.display_id, 'ISS-004');
  server.close();
});

test('risks: RSK-001, level recomputed on prob/impact change, strategy, review needed, transitions', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  let r = await S.c('POST', S.rs, { title: '고객 API 지연 가능성', probability: 'HIGH', impact: 'MEDIUM', response_strategy: 'MITIGATE', mitigation_plan: 'Mock API 준비', review_date: yesterday() });
  assert.equal(r.status, 201); const k = r.json.risk;
  assert.equal(k.display_id, 'RSK-001'); assert.equal(k.risk_level, 'HIGH'); assert.equal(k.needs_review, 1); assert.equal(k.status, 'OPEN');
  r = await S.c('PATCH', `${S.rs}/${k.id}`, { impact: 'HIGH' });
  assert.equal(r.json.risk.risk_level, 'CRITICAL'); assert.ok(r.json.risk.history.find((h) => h.field_name === 'risk_level' && h.new_value === 'CRITICAL'));
  r = await S.c('PATCH', `${S.rs}/${k.id}`, { probability: 'LOW', impact: 'LOW' }); assert.equal(r.json.risk.risk_level, 'LOW');
  assert.equal((await S.c('PATCH', `${S.rs}/${k.id}`, { probability: 'VERY_HIGH' })).status, 400);
  assert.equal((await S.c('PATCH', `${S.rs}/${k.id}`, { response_strategy: 'IGNORE' })).status, 400);
  r = await S.c('PATCH', `${S.rs}/${k.id}`, { review_date: tomorrow() }); assert.equal(r.json.risk.needs_review, 0);
  // transitions
  r = await S.c('PATCH', `${S.rs}/${k.id}`, { status: 'MONITORING' }); assert.equal(r.json.risk.status, 'MONITORING');
  assert.equal((await S.c('PATCH', `${S.rs}/${k.id}`, { status: 'OPEN' })).status, 409);
  r = await S.c('PATCH', `${S.rs}/${k.id}`, { status: 'MATERIALIZED' }); assert.ok(r.json.risk.materialized_at);
  assert.equal((await S.c('PATCH', `${S.rs}/${k.id}`, { status: 'MONITORING' })).status, 409);
  assert.equal((await S.c('PATCH', `${S.rs}/${k.id}`, { status: 'OPEN' })).status, 409);
  r = await S.c('PATCH', `${S.rs}/${k.id}`, { status: 'CLOSED' }); assert.ok(r.json.risk.closed_at);
  const st = (await S.c('GET', S.rs)).json.risks; assert.equal(st.closed, 1); assert.equal(st.high_or_critical, 0);
  server.close();
});

test('risk → issue conversion: defaults, links copied, risk materialised, no duplicate, closed refused', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const w = await S.wbs({ item_type: 'TASK', title: '연동 개발' }); const rq = await S.req({ title: 'API 연동' });
  const k = (await S.c('POST', S.rs, { title: '고객 API 지연', description: '고객사 일정 미확정', probability: 'HIGH', impact: 'HIGH', owner_user_id: S.uid })).json.risk;
  await S.c('POST', `${S.rs}/${k.id}/links`, { target_type: 'WBS', target_id: w.id });
  await S.c('POST', `${S.rs}/${k.id}/links`, { target_type: 'REQUIREMENT', target_id: rq.id });
  const r = await S.c('POST', `${S.rs}/${k.id}/convert`, {});
  assert.equal(r.status, 201);
  const i = r.json.issue;
  assert.equal(i.display_id, 'ISS-001'); assert.equal(i.title, '고객 API 지연'); assert.equal(i.description, '고객사 일정 미확정'); assert.equal(i.severity, 'CRITICAL'); assert.equal(i.owner_user_id, S.uid);
  assert.equal(i.source_risk_id, k.id); assert.equal(i.source_risk_display_id, 'RSK-001');
  assert.equal(i.links.wbs.length, 1); assert.equal(i.links.requirements.length, 1);
  assert.equal(r.json.risk.status, 'MATERIALIZED'); assert.ok(r.json.risk.materialized_at); assert.equal(r.json.risk.converted_issue_display_id, 'ISS-001');
  assert.equal((await S.c('POST', `${S.rs}/${k.id}/convert`, {})).status, 409);
  const k2 = (await S.c('POST', S.rs, { title: 'closed one' })).json.risk;
  await S.c('PATCH', `${S.rs}/${k2.id}`, { status: 'CLOSED' });
  assert.equal((await S.c('POST', `${S.rs}/${k2.id}/convert`, {})).status, 409);
  server.close();
});

test('links: wbs / requirement / change for both entities; reverse lookup; duplicates; cross-project; filters & search', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const w1 = await A.wbs({ item_type: 'TASK', title: 'W1' }); const w2 = await A.wbs({ item_type: 'TASK', title: 'W2' });
  const rq = await A.req({ title: 'R1' }); const cr = await A.cr({ title: 'C1' });
  const wb = await B.wbs({ item_type: 'TASK', title: 'WB' });
  const i = (await A.c('POST', A.is, { title: 'Issue 1', severity: 'CRITICAL' })).json.issue;
  const k = (await A.c('POST', A.rs, { title: 'Risk 1' })).json.risk;
  for (const [tt, id] of [['WBS', w1.id], ['WBS', w2.id], ['REQUIREMENT', rq.id], ['CHANGE', cr.id]]) assert.equal((await A.c('POST', `${A.is}/${i.id}/links`, { target_type: tt, target_id: id })).status, 201);
  for (const [tt, id] of [['WBS', w1.id], ['REQUIREMENT', rq.id], ['CHANGE', cr.id]]) assert.equal((await A.c('POST', `${A.rs}/${k.id}/links`, { target_type: tt, target_id: id })).status, 201);
  let full = (await A.c('GET', `${A.is}/${i.id}`)).json.issue;
  assert.equal(full.wbs_count, 2); assert.equal(full.requirement_count, 1); assert.equal(full.change_count, 1); assert.equal(full.links.changes[0].code, 'CR-001');
  assert.equal((await A.c('POST', `${A.is}/${i.id}/links`, { target_type: 'WBS', target_id: w1.id })).status, 400); // duplicate
  assert.equal((await A.c('POST', `${A.is}/${i.id}/links`, { target_type: 'WBS', target_id: wb.id })).status, 404); // other project
  assert.equal((await A.c('POST', `${A.is}/${i.id}/links`, { target_type: 'NOPE', target_id: w1.id })).status, 400);
  await assert.rejects(async () => (await db.run("INSERT INTO raid_links (id, project_id, source_type, source_id, target_type, target_id) VALUES ('z', ?, 'ISSUE', ?, 'WBS', ?)", [A.p.id, i.id, wb.id])), /same project/);
  // reverse lookup on wbs + requirement detail
  const wd = (await A.c('GET', `${A.purl}/wbs/${w1.id}`)).json.item;
  assert.deepEqual(wd.raid.issues.map((x) => x.display_id), ['ISS-001']); assert.deepEqual(wd.raid.risks.map((x) => x.display_id), ['RSK-001']);
  const rd = (await A.c('GET', `${A.purl}/requirements/${rq.id}`)).json.requirement;
  assert.equal(rd.raid.issues.length, 1); assert.equal(rd.raid.risks.length, 1);
  // unlink
  const lid = full.links.wbs.find((l) => l.target_id === w2.id).id;
  full = (await A.c('DELETE', `${A.is}/${i.id}/links/${lid}`)).json.issue; assert.equal(full.wbs_count, 1);
  assert.equal((await A.c('DELETE', `${A.is}/${i.id}/links/${lid}`)).status, 404);
  // filters & search
  await A.c('POST', A.is, { title: '검색용 두번째', description: 'SAP 연동 오류', severity: 'LOW', due_date: yesterday() });
  const items = (q) => A.c('GET', `${A.is}?${q}`).then((x) => x.json.items.map((y) => y.display_id));
  assert.deepEqual(await items('q=SAP'), ['ISS-002']);
  assert.deepEqual(await items('severity=CRITICAL'), ['ISS-001']);
  assert.deepEqual(await items('overdue=1'), ['ISS-002']);
  assert.deepEqual(await items(`wbs=${w1.id}`), ['ISS-001']);
  assert.deepEqual(await items(`requirement=${rq.id}`), ['ISS-001']);
  assert.deepEqual(await items(`status=OPEN&severity=LOW,CRITICAL&owner=none`), ['ISS-002', 'ISS-001']);
  await A.c('POST', A.rs, { title: 'r2', probability: 'LOW', impact: 'LOW', response_strategy: 'ACCEPT' });
  const risks = (q) => A.c('GET', `${A.rs}?${q}`).then((x) => x.json.items.map((y) => y.display_id));
  assert.deepEqual(await risks('risk_level=MEDIUM'), ['RSK-001']);
  assert.deepEqual(await risks('response_strategy=ACCEPT'), ['RSK-002']);
  assert.deepEqual(await risks(`wbs=${w1.id}`), ['RSK-001']);
  // other workspace: everything 404
  for (const [m, path, body] of [['GET', A.is], ['GET', `${A.is}/${i.id}`], ['PATCH', `${A.is}/${i.id}`, { title: 'h' }], ['POST', `${A.is}/${i.id}/links`, { target_type: 'WBS', target_id: w1.id }],
    ['POST', `${A.rs}/${k.id}/convert`, {}], ['POST', `${A.rs}/${k.id}/archive`, {}], ['GET', `${B.is}/${i.id}`], ['PATCH', `${B.rs}/${k.id}`, { title: 'h' }]])
    assert.equal((await B.c(m, path, body)).status, 404, `${m} ${path}`);
  // archived project read-only
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', A.is)).status, 200);
  for (const [m, path, body] of [['POST', A.is, { title: 'x' }], ['PATCH', `${A.is}/${i.id}`, { status: 'IN_PROGRESS' }], ['POST', `${A.is}/${i.id}/links`, { target_type: 'WBS', target_id: w1.id }],
    ['DELETE', `${A.is}/${i.id}/links/${full.links.wbs[0].id}`], ['POST', `${A.rs}/${k.id}/convert`, {}], ['POST', `${A.is}/${i.id}/archive`, {}], ['POST', A.rs, { title: 'x' }]])
    assert.equal((await A.c(m, path, body)).status, 409, `${m} ${path}`);
  // guided stats on project
  const g = (await A.c('GET', A.purl)).json;
  assert.equal(g.issues.active, 2); assert.equal(g.issues.critical, 1); assert.equal(g.issues.overdue, 1); assert.equal(g.risks.total, 2);
  server.close();
});
