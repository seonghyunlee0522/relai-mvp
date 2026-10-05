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
  const s = await c('POST', '/api/auth/signup', { name: '홍길동', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id; const uid = s.json.user.id;
  const p = (await c('POST', `/api/workspaces/${w}/projects`, project())).json.project;
  const purl = `/api/workspaces/${w}/projects/${p.id}`;
  return { c, w, uid, p, purl, cr: `${purl}/changes`, rq: `${purl}/requirements`, wb: `${purl}/wbs`,
    req: async (b) => (await c('POST', `${purl}/requirements`, b)).json.requirement,
    wbs: async (b) => (await c('POST', `${purl}/wbs`, b)).json.item };
}

test('create: CR-001.., per-project numbering, defaults, requirements at create, validation', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const r1 = await S.req({ title: 'SSO 로그인', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  let r = await S.c('POST', S.cr, { title: 'MFA 인증 추가', requester_name: '김보안', requester_organization: 'A사 보안팀', priority: 'HIGH', requirements: [{ requirement_id: r1.id, relation_type: 'MODIFIES' }] });
  assert.equal(r.status, 201);
  const cr = r.json.change;
  assert.equal(cr.display_id, 'CR-001'); assert.equal(cr.status, 'DRAFT'); assert.equal(cr.priority, 'HIGH'); assert.ok(cr.requested_at);
  assert.equal(cr.requirements.length, 1); assert.equal(cr.requirements[0].relation_type, 'MODIFIES');
  assert.deepEqual(cr.history.map((h) => h.action_type), ['REQUIREMENT_LINKED', 'CREATED']);
  const ids = await Promise.all([1, 2, 3].map((i) => S.c('POST', S.cr, { title: `C${i}` }).then((x) => x.json.change.display_id)));
  assert.deepEqual(ids.sort(), ['CR-002', 'CR-003', 'CR-004']);
  const p2 = (await S.c('POST', `/api/workspaces/${S.w}/projects`, project({ name: 'P2' }))).json.project;
  assert.equal((await S.c('POST', `/api/workspaces/${S.w}/projects/${p2.id}/changes`, { title: 'x' })).json.change.display_id, 'CR-001');
  assert.equal((await S.c('POST', S.cr, { title: '' })).status, 400);
  assert.equal((await S.c('POST', S.cr, { title: 'x', priority: 'URGENT' })).status, 400);
  assert.equal((await S.c('POST', S.cr, { title: 'x', requirements: ['does-not-exist'] })).status, 400);
  server.close();
});

test('impact fields, requirement links, WBS candidates via traceability, impacts', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const r1 = await S.req({ title: 'SSO 로그인', scope: 'IN_SCOPE', status: 'CONFIRMED' });
  const r2 = await S.req({ title: '권한 관리', scope: 'IN_SCOPE' });
  const w1 = await S.wbs({ item_type: 'TASK', title: '인증 설계' });
  const w2 = await S.wbs({ item_type: 'TASK', title: 'Backend 개발' });
  const w3 = await S.wbs({ item_type: 'TASK', title: '통합테스트' });
  await S.c('POST', `${S.rq}/${r1.id}/links`, { wbs_item_id: w1.id }); await S.c('POST', `${S.rq}/${r1.id}/links`, { wbs_item_id: w2.id });
  await S.c('POST', `${S.rq}/${r2.id}/links`, { wbs_item_id: w2.id });
  const cr = (await S.c('POST', S.cr, { title: 'MFA' })).json.change;
  // impact fields
  let u = await S.c('PATCH', `${S.cr}/${cr.id}`, { schedule_impact_days: 4, effort_impact_md: 3.5, cost_impact: 3000000 });
  assert.equal(u.status, 200); assert.equal(u.json.change.schedule_impact_days, 4); assert.equal(u.json.change.effort_impact_md, 3.5); assert.equal(u.json.change.cost_impact, 3000000);
  assert.equal((await S.c('PATCH', `${S.cr}/${cr.id}`, { schedule_impact_days: -1 })).status, 400);
  assert.equal((await S.c('PATCH', `${S.cr}/${cr.id}`, { schedule_impact_days: 1.5 })).status, 400);
  assert.equal((await S.c('PATCH', `${S.cr}/${cr.id}`, { cost_impact: 'abc' })).status, 400);
  u = await S.c('PATCH', `${S.cr}/${cr.id}`, { schedule_impact_days: 4 }); assert.deepEqual(u.json.changed, []);
  // link requirements (multiple), relation type, duplicate
  assert.equal((await S.c('POST', `${S.cr}/${cr.id}/requirements`, { requirement_id: r1.id })).status, 201);
  u = await S.c('POST', `${S.cr}/${cr.id}/requirements`, { requirement_id: r2.id, relation_type: 'ADDS' });
  assert.equal(u.json.change.requirements.length, 2); assert.equal(u.json.change.requirement_count, 2);
  assert.equal((await S.c('POST', `${S.cr}/${cr.id}/requirements`, { requirement_id: r1.id })).status, 400);
  // candidates: w1 (via r1), w2 (via r1, r2); not w3
  assert.deepEqual(u.json.change.wbs_candidates.map((x) => x.title), ['인증 설계', 'Backend 개발']);
  assert.equal(u.json.change.wbs_candidates[1].via.split(',').length, 2);
  // record impacts: candidate + non-candidate; type + note; duplicate
  u = await S.c('POST', `${S.cr}/${cr.id}/impacts`, { wbs_item_id: w2.id, impact_type: 'REWORK', impact_note: 'API 변경' });
  assert.equal(u.status, 201); assert.equal(u.json.change.impacts[0].impact_type, 'REWORK');
  assert.deepEqual(u.json.change.wbs_candidates.map((x) => x.title), ['인증 설계']); // recorded one drops out
  u = await S.c('POST', `${S.cr}/${cr.id}/impacts`, { wbs_item_id: w3.id, impact_type: 'NEW_WORK' });
  assert.equal(u.json.change.impact_count, 2);
  assert.equal((await S.c('POST', `${S.cr}/${cr.id}/impacts`, { wbs_item_id: w2.id })).status, 400);
  assert.equal((await S.c('POST', `${S.cr}/${cr.id}/impacts`, { wbs_item_id: w2.id, impact_type: 'HUGE' })).status, 400);
  const imp = u.json.change.impacts[0];
  u = await S.c('PATCH', `${S.cr}/${cr.id}/impacts/${imp.id}`, { impact_type: 'SCHEDULE', impact_note: '2일 지연' });
  assert.equal(u.json.change.impacts[0].impact_type, 'SCHEDULE'); assert.equal(u.json.change.impacts[0].impact_note, '2일 지연');
  u = await S.c('DELETE', `${S.cr}/${cr.id}/impacts/${imp.id}`); assert.equal(u.json.change.impacts.length, 1);
  // relation type change + unlink
  const lid = u.json.change.requirements.find((x) => x.requirement_id === r2.id).id;
  u = await S.c('PATCH', `${S.cr}/${cr.id}/requirements/${lid}`, { relation_type: 'REMOVES' }); assert.equal(u.json.change.requirements.find((x) => x.id === lid).relation_type, 'REMOVES');
  u = await S.c('DELETE', `${S.cr}/${cr.id}/requirements/${lid}`); assert.equal(u.json.change.requirements.length, 1);
  server.close();
});

test('workflow: submit → approve/reject → implement; guards; reviewer recorded; decision note', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const a = (await S.c('POST', S.cr, { title: 'A' })).json.change;
  const b = (await S.c('POST', S.cr, { title: 'B' })).json.change;
  const tr = (id, action, note) => S.c('POST', `${S.cr}/${id}/transition`, { action, decision_note: note });
  assert.equal((await tr(a.id, 'approve')).status, 409);   // DRAFT cannot be approved
  assert.equal((await tr(a.id, 'implement')).status, 409);
  assert.equal((await tr(a.id, 'bogus')).status, 400);
  let r = await tr(a.id, 'submit'); assert.equal(r.json.change.status, 'UNDER_REVIEW'); assert.ok(r.json.change.submitted_at);
  assert.equal((await tr(a.id, 'submit')).status, 409);
  r = await tr(a.id, 'approve', '범위 내 처리 가능');
  assert.equal(r.json.change.status, 'APPROVED'); assert.equal(r.json.change.reviewed_by, S.uid); assert.equal(r.json.change.reviewed_by_name, '홍길동'); assert.ok(r.json.change.approved_at); assert.equal(r.json.change.decision_note, '범위 내 처리 가능');
  assert.equal((await tr(a.id, 'reject', 'x')).status, 409);
  r = await tr(a.id, 'implement'); assert.equal(r.json.change.status, 'IMPLEMENTED'); assert.ok(r.json.change.implemented_at);
  assert.deepEqual(r.json.change.history.filter((h) => h.action_type === 'STATUS_CHANGED').map((h) => `${h.old_value}→${h.new_value}`), ['APPROVED→IMPLEMENTED', 'UNDER_REVIEW→APPROVED', 'DRAFT→UNDER_REVIEW']);
  await tr(b.id, 'submit');
  assert.equal((await tr(b.id, 'reject', '')).status, 400); // reason required
  r = await tr(b.id, 'reject', '계약 범위 외'); assert.equal(r.json.change.status, 'REJECTED'); assert.ok(r.json.change.rejected_at); assert.equal(r.json.change.decision_note, '계약 범위 외');
  assert.equal((await tr(b.id, 'implement')).status, 409);
  server.close();
});

test('list, search, filters, summary, guided/overview stats, archive', async () => {
  const { server, client } = await boot();
  const S = await setup(client);
  const r1 = await S.req({ title: 'SSO' });
  const a = (await S.c('POST', S.cr, { title: 'MFA 인증 추가', requester_name: '김보안', requester_organization: 'A사 보안팀', priority: 'HIGH', requirements: [r1.id] })).json.change;
  const b = (await S.c('POST', S.cr, { title: 'Excel 다운로드', description: '리포트 export', requester_organization: 'A사 운영팀' })).json.change;
  const cc = (await S.c('POST', S.cr, { title: '색상 변경', priority: 'LOW' })).json.change;
  await S.c('PATCH', `${S.cr}/${a.id}`, { schedule_impact_days: 4, cost_impact: 3000000 });
  await S.c('PATCH', `${S.cr}/${b.id}`, { schedule_impact_days: 2 });
  const tr = (id, action, note) => S.c('POST', `${S.cr}/${id}/transition`, { action, decision_note: note });
  await tr(a.id, 'submit'); await tr(a.id, 'approve'); await tr(b.id, 'submit'); await tr(cc.id, 'submit'); await tr(cc.id, 'reject', '불필요');
  const list = (await S.c('GET', S.cr)).json;
  assert.deepEqual(list.changes.map((x) => x.display_id), ['CR-003', 'CR-002', 'CR-001']);
  assert.deepEqual(list.requesters, ['A사 보안팀', 'A사 운영팀', '김보안']);
  const s = list.summary;
  assert.equal(s.total, 3); assert.equal(s.under_review, 1); assert.equal(s.approved, 1); assert.equal(s.rejected, 1); assert.equal(s.approved_schedule_days, 4); assert.equal(s.approved_cost, 3000000);
  assert.deepEqual((await S.c('GET', `${S.cr}?q=export`)).json.changes.map((x) => x.display_id), ['CR-002']);
  assert.deepEqual((await S.c('GET', `${S.cr}?q=보안`)).json.changes.map((x) => x.display_id), ['CR-001']);
  assert.deepEqual((await S.c('GET', `${S.cr}?status=UNDER_REVIEW,REJECTED`)).json.changes.map((x) => x.display_id), ['CR-003', 'CR-002']);
  assert.deepEqual((await S.c('GET', `${S.cr}?priority=HIGH`)).json.changes.map((x) => x.display_id), ['CR-001']);
  assert.deepEqual((await S.c('GET', `${S.cr}?requester=${encodeURIComponent('A사 운영팀')}`)).json.changes.map((x) => x.display_id), ['CR-002']);
  assert.deepEqual((await S.c('GET', `${S.cr}?requirement=${r1.id}`)).json.changes.map((x) => x.display_id), ['CR-001']);
  assert.equal((await S.c('GET', `${S.cr}?schedule=1`)).json.changes.length, 2);
  assert.equal((await S.c('GET', `${S.cr}?cost=1`)).json.changes.length, 1);
  assert.equal((await S.c('GET', `${S.cr}?schedule=1&status=APPROVED`)).json.changes.length, 1);
  const g = (await S.c('GET', S.purl)).json;
  assert.equal(g.changes.under_review, 1); assert.equal(g.changes.approved_unimplemented, 1);
  // archive: hidden by default, immutable, number not reused
  const ar = await S.c('POST', `${S.cr}/${cc.id}/archive`, {}); assert.ok(ar.json.change.archived_at);
  assert.equal((await S.c('GET', S.cr)).json.changes.length, 2);
  assert.equal((await S.c('GET', `${S.cr}?include_archived=1`)).json.changes.length, 3);
  assert.equal((await S.c('PATCH', `${S.cr}/${cc.id}`, { title: 'x' })).status, 409);
  assert.equal((await S.c('POST', S.cr, { title: 'next' })).json.change.display_id, 'CR-004');
  assert.equal((await S.c('GET', `${S.cr}/${cc.id}`)).json.change.requirements.length, 0);
  server.close();
});

test('isolation: other workspace, other project requirement/wbs, archived project read-only, db triggers', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const ra = await A.req({ title: 'RA' }); const wa = await A.wbs({ item_type: 'TASK', title: 'WA' });
  const rb = await B.req({ title: 'RB' }); const wb = await B.wbs({ item_type: 'TASK', title: 'WB' });
  const cr = (await A.c('POST', A.cr, { title: 'CR A' })).json.change;
  assert.equal((await A.c('POST', `${A.cr}/${cr.id}/requirements`, { requirement_id: rb.id })).status, 404);
  assert.equal((await A.c('POST', `${A.cr}/${cr.id}/impacts`, { wbs_item_id: wb.id })).status, 404);
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: 'P2' }))).json.project;
  const r2 = (await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/requirements`, { title: 'R2' })).json.requirement;
  assert.equal((await A.c('POST', `${A.cr}/${cr.id}/requirements`, { requirement_id: r2.id })).status, 404);
  await assert.rejects(async () => (await db.run("INSERT INTO change_request_requirements (id, change_request_id, requirement_id) VALUES ('x', ?, ?)", [cr.id, r2.id])), /project/);
  await assert.rejects(async () => (await db.run("INSERT INTO change_request_wbs_impacts (id, change_request_id, wbs_item_id) VALUES ('y', ?, ?)", [cr.id, wb.id])), /project/);
  await A.c('POST', `${A.cr}/${cr.id}/requirements`, { requirement_id: ra.id });
  await A.c('POST', `${A.cr}/${cr.id}/impacts`, { wbs_item_id: wa.id });
  const full = (await A.c('GET', `${A.cr}/${cr.id}`)).json.change;
  for (const [m, path, body] of [
    ['GET', A.cr], ['POST', A.cr, { title: 'x' }], ['GET', `${A.cr}/${cr.id}`], ['PATCH', `${A.cr}/${cr.id}`, { title: 'h' }],
    ['POST', `${A.cr}/${cr.id}/transition`, { action: 'submit' }], ['POST', `${A.cr}/${cr.id}/archive`, {}],
    ['POST', `${A.cr}/${cr.id}/requirements`, { requirement_id: ra.id }], ['DELETE', `${A.cr}/${cr.id}/requirements/${full.requirements[0].id}`],
    ['POST', `${A.cr}/${cr.id}/impacts`, { wbs_item_id: wa.id }], ['DELETE', `${A.cr}/${cr.id}/impacts/${full.impacts[0].id}`],
    ['GET', `${B.cr}/${cr.id}`], ['PATCH', `${B.cr}/${cr.id}`, { title: 'h' }],
  ]) assert.equal((await B.c(m, path, body)).status, 404, `${m} ${path}`);
  assert.equal((await A.c('GET', `${A.cr}/${cr.id}`)).json.change.title, 'CR A');
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', A.cr)).status, 200);
  for (const [m, path, body] of [
    ['POST', A.cr, { title: 'x' }], ['PATCH', `${A.cr}/${cr.id}`, { title: 'h' }], ['POST', `${A.cr}/${cr.id}/transition`, { action: 'submit' }],
    ['POST', `${A.cr}/${cr.id}/requirements`, { requirement_id: ra.id }], ['DELETE', `${A.cr}/${cr.id}/requirements/${full.requirements[0].id}`],
    ['POST', `${A.cr}/${cr.id}/impacts`, { wbs_item_id: wa.id }], ['PATCH', `${A.cr}/${cr.id}/impacts/${full.impacts[0].id}`, { impact_type: 'NONE' }], ['POST', `${A.cr}/${cr.id}/archive`, {}],
  ]) assert.equal((await A.c(m, path, body)).status, 409, `${m} ${path}`);
  server.close();
});
