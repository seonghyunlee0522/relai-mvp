import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';

const mkReq = async (A, body) => (await A.c('POST', A.req, body)).json.requirement;
const mkWbs = async (A, body) => { const r = await A.c('POST', A.wbs, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };

test('requirements bulk: update applies per id, skips unknown/archived/other-project/non-member, history rows + source CR', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const m = await addMember(client, A, 'm@x.com', '멤버');
  const r1 = await mkReq(A, { title: 'one' }); const r2 = await mkReq(A, { title: 'two', status: 'CONFIRMED' }); const r3 = await mkReq(A, { title: 'three' });
  await A.c('POST', `${A.req}/${r3.id}/archive`, {});
  const foreign = await mkReq(B, { title: 'foreign' });
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: '변경', description: 'x' })).json.change;

  const r = await A.c('POST', `${A.req}/bulk`, { ids: [r1.id, r2.id, r3.id, foreign.id, 'nope'], action: 'update', patch: { status: 'CONFIRMED', priority: 'HIGH', owner_user_id: m.uid }, source_change_request_id: cr.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.updated, 2);
  const reason = Object.fromEntries(r.json.skipped.map((s) => [s.id, s.reason]));
  assert.equal(reason[r3.id], '보관된 요구사항은 수정할 수 없습니다.');
  assert.equal(reason[foreign.id], '요구사항을 찾을 수 없습니다.'); assert.equal(reason.nope, '요구사항을 찾을 수 없습니다.');
  assert.equal(r.json.summary.total, 2); assert.equal(r.json.summary.confirmed, 2);
  const one = (await A.c('GET', `${A.req}/${r1.id}`)).json.requirement;
  assert.equal(one.status, 'CONFIRMED'); assert.equal(one.priority, 'HIGH'); assert.equal(one.owner_user_id, m.uid);
  assert.deepEqual(one.history.filter((h) => h.action_type === 'UPDATED').map((h) => h.field_name).sort(), ['owner_user_id', 'priority', 'status']);
  assert.ok(one.history.filter((h) => h.action_type === 'UPDATED').every((h) => h.source_change_display_id === cr.display_id));
  const two = (await A.c('GET', `${A.req}/${r2.id}`)).json.requirement;                       // status already CONFIRMED: only priority + owner changed
  assert.deepEqual(two.history.filter((h) => h.action_type === 'UPDATED').map((h) => h.field_name).sort(), ['owner_user_id', 'priority']);
  assert.equal((await B.c('GET', `${B.req}/${foreign.id}`)).json.requirement.status, 'DRAFT');   // foreign project untouched

  // nothing changes → skipped with a reason, not counted
  const same = await A.c('POST', `${A.req}/bulk`, { ids: [r1.id], action: 'update', patch: { status: 'CONFIRMED' } });
  assert.equal(same.json.updated, 0); assert.equal(same.json.skipped[0].reason, '변경할 내용이 없습니다.');
  // unassign owner with null
  assert.equal((await A.c('POST', `${A.req}/bulk`, { ids: [r1.id], action: 'update', patch: { owner_user_id: null } })).json.updated, 1);
  assert.equal((await A.c('GET', `${A.req}/${r1.id}`)).json.requirement.owner_user_id, null);
  // a user from another workspace as owner: every id skipped, nothing applied
  const o = await A.c('POST', `${A.req}/bulk`, { ids: [r1.id, r2.id], action: 'update', patch: { owner_user_id: B.uid } });
  assert.equal(o.status, 200); assert.equal(o.json.updated, 0); assert.equal(o.json.skipped.length, 2);
  assert.match(o.json.skipped[0].reason, /Workspace 멤버/);
  server.close();
});

test('requirements bulk: archive, validation (400), tenant isolation (404), archived project (409)', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const a = await mkReq(A, { title: 'a' }); const b = await mkReq(A, { title: 'b' });
  const url = `${A.req}/bulk`;
  assert.equal((await A.c('POST', url, { ids: [], action: 'archive' })).status, 400);
  assert.equal((await A.c('POST', url, { action: 'archive' })).status, 400);
  assert.equal((await A.c('POST', url, { ids: 'x', action: 'archive' })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [1], action: 'archive' })).status, 400);
  assert.equal((await A.c('POST', url, { ids: Array.from({ length: 501 }, (_, i) => `id${i}`), action: 'archive' })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [a.id], action: 'delete' })).status, 400);
  const noPatch = await A.c('POST', url, { ids: [a.id], action: 'update', patch: {} });
  assert.equal(noPatch.status, 400); assert.ok(noPatch.json.error.fields.patch);
  assert.equal((await A.c('POST', url, { ids: [a.id], action: 'update' })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [a.id], action: 'update', patch: { title: 'x' } })).status, 400);       // not a bulk-editable field
  assert.equal((await A.c('POST', url, { ids: [a.id], action: 'update', patch: { status: 'BOGUS' } })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [a.id], action: 'update', patch: { status: 'DRAFT' }, source_change_request_id: 'nope' })).status, 400);
  assert.equal((await B.c('POST', url, { ids: [a.id], action: 'archive' })).status, 404);
  // another tenant's id used inside my own project is simply "not found"
  const mine = await B.c('POST', `${B.req}/bulk`, { ids: [a.id], action: 'archive' });
  assert.equal(mine.json.updated, 0); assert.equal(mine.json.skipped[0].reason, '요구사항을 찾을 수 없습니다.');
  assert.equal((await A.c('GET', `${A.req}/${a.id}`)).json.requirement.archived_at, null);
  // duplicate ids are processed once
  const ar = await A.c('POST', url, { ids: [a.id, a.id, b.id], action: 'archive' });
  assert.equal(ar.json.updated, 2); assert.deepEqual(ar.json.skipped, []);
  assert.equal(ar.json.summary.total, 0);
  const h = (await A.c('GET', `${A.req}/${a.id}`)).json.requirement.history;
  assert.equal(h.filter((x) => x.action_type === 'ARCHIVED').length, 1);
  const again = await A.c('POST', url, { ids: [a.id], action: 'archive' });
  assert.equal(again.json.updated, 0); assert.equal(again.json.skipped.length, 1);
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('POST', url, { ids: [a.id], action: 'archive' })).status, 409);
  server.close();
});

test('wbs bulk: owner/status/dates/progress per item, skips with reasons, history rows, WBS tree in the response', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const B = await setup(client, 'b@x.com');
  const m = await addMember(client, A, 'm@x.com', '멤버');
  const sum = await mkWbs(A, { item_type: 'SUMMARY', title: '상위' });
  const t1 = await mkWbs(A, { item_type: 'TASK', title: 't1', parent_id: sum.id, planned_start_date: '2026-11-02', planned_end_date: '2026-11-06' });
  const t2 = await mkWbs(A, { item_type: 'TASK', title: 't2', parent_id: sum.id });
  const ms = await mkWbs(A, { item_type: 'MILESTONE', title: 'ms', milestone_date: '2026-12-01' });
  const foreign = await mkWbs(B, { item_type: 'TASK', title: 'f' });
  const url = `${A.wbs}/bulk`;

  const r = await A.c('POST', url, { ids: [sum.id, t1.id, t2.id, ms.id, foreign.id], action: 'update', patch: { owner_user_id: m.uid, progress: 40, status: 'IN_PROGRESS' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.updated, 2);   // t1, t2 — SUMMARY/MILESTONE cannot take progress
  const reason = Object.fromEntries(r.json.skipped.map((s) => [s.id, s.reason]));
  assert.match(reason[sum.id], /진행률/); assert.match(reason[ms.id], /진행률/); assert.equal(reason[foreign.id], 'WBS 항목을 찾을 수 없습니다.');
  assert.ok(Array.isArray(r.json.items) && r.json.summary && r.json.summary.tasks === 2);        // spread of the usual WBS response
  const i1 = (await A.c('GET', `${A.wbs}/${t1.id}`)).json.item;
  assert.equal(i1.progress, 40); assert.equal(i1.owner_user_id, m.uid); assert.equal(i1.status, 'IN_PROGRESS');
  assert.deepEqual(i1.history.filter((h) => h.action_type === 'UPDATED').map((h) => h.field_name).sort(), ['owner_user_id', 'progress', 'status']);
  assert.equal(i1.history.find((h) => h.field_name === 'progress').old_value, '0'); assert.equal(i1.history.find((h) => h.field_name === 'progress').new_value, '40');
  assert.equal(i1.history[0].changed_by_name, '홍길동');

  // owner SUMMARY is allowed by the data model (same as PATCH); only owner on non-member is skipped
  const o = await A.c('POST', url, { ids: [sum.id, t1.id], action: 'update', patch: { owner_user_id: B.uid } });
  assert.equal(o.json.updated, 0); assert.equal(o.json.skipped.length, 2);
  // end < start after merge → skipped, others applied
  const d = await A.c('POST', url, { ids: [t1.id, t2.id], action: 'update', patch: { planned_end_date: '2026-11-04' } });
  assert.equal(d.json.updated, 2);                                // both fit (t1 starts 11-02, t2 has no start)
  await A.c('POST', url, { ids: [t2.id], action: 'update', patch: { planned_start_date: '2026-11-01' } });
  const e = await A.c('POST', url, { ids: [t1.id, t2.id], action: 'update', patch: { planned_start_date: '2026-11-04' } });
  assert.equal(e.json.updated, 2);                                // start == end is fine
  const f = await A.c('POST', url, { ids: [t1.id, t2.id], action: 'update', patch: { planned_start_date: '2026-11-05' } });
  assert.equal(f.json.updated, 0); assert.equal(f.json.skipped.length, 2);                   // start after the merged end → each skipped with the reason
  assert.match(f.json.skipped[0].reason, /종료일/);
  // completing a task sets progress 100
  await A.c('POST', url, { ids: [t2.id], action: 'update', patch: { status: 'COMPLETED' } });
  assert.equal((await A.c('GET', `${A.wbs}/${t2.id}`)).json.item.progress, 100);
  // milestone cannot take planned dates
  const md = await A.c('POST', url, { ids: [ms.id], action: 'update', patch: { planned_end_date: '2026-12-02' } });
  assert.equal(md.json.updated, 0); assert.match(md.json.skipped[0].reason, /마일스톤/);
  // validation
  assert.equal((await A.c('POST', url, { ids: [t1.id], action: 'update', patch: { progress: 101 } })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [t1.id], action: 'update', patch: { planned_start_date: '2026/11/01' } })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [t1.id], action: 'update', patch: { title: 'x' } })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [t1.id], action: 'update', patch: {} })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [t1.id], action: 'update', shift_days: 4000 })).status, 400);
  assert.equal((await A.c('POST', url, { ids: [t1.id], action: 'update', shift_days: 1.5 })).status, 400);
  assert.equal((await B.c('POST', `${B.wbs}/bulk`, { ids: [t1.id], action: 'update', patch: { status: 'COMPLETED' } })).json.skipped[0].reason, 'WBS 항목을 찾을 수 없습니다.');
  assert.equal((await B.c('POST', url, { ids: [t1.id], action: 'update', patch: { status: 'COMPLETED' } })).status, 404);
  assert.equal((await client()('POST', url, { ids: [t1.id], action: 'archive' })).status, 401);
  server.close();
});

test('wbs bulk: shift_days (task, milestone, summary/undated skipped) and archive with descendants deduplicated', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const B = await setup(client, 'b@x.com');
  const sum = await mkWbs(A, { item_type: 'SUMMARY', title: '상위' });
  const t1 = await mkWbs(A, { item_type: 'TASK', title: 't1', parent_id: sum.id, planned_start_date: '2026-11-02', planned_end_date: '2026-11-06' });
  const t2 = await mkWbs(A, { item_type: 'TASK', title: 't2', parent_id: sum.id, planned_end_date: '2026-11-30' });
  const t3 = await mkWbs(A, { item_type: 'TASK', title: '일정 없음' });
  const ms = await mkWbs(A, { item_type: 'MILESTONE', title: 'ms', milestone_date: '2026-12-01' });
  const ms0 = await mkWbs(A, { item_type: 'MILESTONE', title: 'ms0' });
  const url = `${A.wbs}/bulk`;
  const r = await A.c('POST', url, { ids: [t1.id, t2.id, t3.id, ms.id, ms0.id, sum.id], action: 'update', shift_days: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.updated, 3);
  const reason = Object.fromEntries(r.json.skipped.map((s) => [s.id, s.reason]));
  assert.match(reason[t3.id], /일정이 없어/); assert.match(reason[ms0.id], /날짜가 없어/); assert.match(reason[sum.id], /상위 항목/);
  const get = async (id) => (await A.c('GET', `${A.wbs}/${id}`)).json.item;
  const g1 = await get(t1.id); assert.deepEqual([g1.planned_start_date, g1.planned_end_date], ['2026-11-09', '2026-11-13']);
  const g2 = await get(t2.id); assert.deepEqual([g2.planned_start_date, g2.planned_end_date], [null, '2026-12-07']);
  assert.equal((await get(ms.id)).milestone_date, '2026-12-08');
  assert.ok(g1.history.some((h) => h.field_name === 'planned_end_date' && h.old_value === '2026-11-06' && h.new_value === '2026-11-13'));
  // negative shift, month/year boundaries
  await A.c('POST', url, { ids: [t1.id], action: 'update', shift_days: -10 });
  assert.deepEqual([(await get(t1.id)).planned_start_date, (await get(t1.id)).planned_end_date], ['2026-10-30', '2026-11-03']);
  // shift_days together with a patch
  await A.c('POST', url, { ids: [t1.id], action: 'update', patch: { status: 'IN_PROGRESS' }, shift_days: 1 });
  const g1b = await get(t1.id); assert.equal(g1b.status, 'IN_PROGRESS'); assert.equal(g1b.planned_start_date, '2026-10-31');

  // archive: parent + child both listed, plus a duplicate → each archived once, descendants included
  const a = await A.c('POST', url, { ids: [t1.id, sum.id, sum.id, t3.id, 'nope'], action: 'archive' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.updated, 3); assert.equal(a.json.skipped.length, 1);
  assert.deepEqual([...a.json.archived_ids].sort(), [t1.id, t2.id, sum.id, t3.id].sort());
  assert.deepEqual(a.json.items.map((i) => `${i.wbs_code}:${i.title}`), ['1:ms', '2:ms0']);        // codes renumbered once at the end
  const archived = await get(t2.id);
  assert.deepEqual(archived.history.filter((h) => h.action_type === 'ARCHIVED').length, 1);      // descendant gets its own ARCHIVED row
  assert.equal((await get(sum.id)).history.filter((h) => h.action_type === 'ARCHIVED').length, 1);
  assert.equal((await get(t1.id)).history.filter((h) => h.action_type === 'ARCHIVED').length, 1);
  assert.equal((await A.c('POST', url, { ids: [sum.id], action: 'archive' })).json.updated, 0);
  assert.equal((await A.c('POST', url, { ids: [sum.id], action: 'update', patch: { status: 'COMPLETED' } })).json.skipped[0].reason, '보관된 WBS 항목은 수정할 수 없습니다.');
  assert.equal((await B.c('POST', `${B.wbs}/bulk`, { ids: [ms.id], action: 'archive' })).json.updated, 0);
  assert.equal((await B.c('POST', url, { ids: [ms.id], action: 'archive' })).status, 404);
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('POST', url, { ids: [ms.id], action: 'archive' })).status, 409);
  assert.equal((await B.c('POST', `${B.wbs}/bulk`, { ids: [], action: 'archive' })).status, 400);
  server.close();
});
