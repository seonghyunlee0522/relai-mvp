import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_TIMEZONE } from '../db.js';
import { boot, setup, addMember } from './api-helpers.js';

const mkReq = async (A, body) => (await A.c('POST', A.req, body)).json.requirement;
const mkWbs = async (A, body) => { const r = await A.c('POST', A.wbs, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };
const day = (offset) => {
  const t = new Date(Date.now() + offset * 86400e3);
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
};

test('comments: any member may comment, author/OWNER/ADMIN may delete, validation, ordering, archived entity vs archived project', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com', '소유자');
  const M = await addMember(client, A, 'm@x.com', '멤버');
  const M2 = await addMember(client, A, 'm2@x.com', '멤버2');
  const AD = await addMember(client, A, 'ad@x.com', '관리자', 'ADMIN');
  const X = await setup(client, 'x@x.com', '외부');
  const req = await mkReq(A, { title: '요구사항' }); const wbs = await mkWbs(A, { item_type: 'TASK', title: '작업' });
  for (const [kind, base, id] of [['requirements', A.req, req.id], ['wbs', A.wbs, wbs.id]]) {
    const url = `${base}/${id}/comments`;
    const get = async () => (await A.c('GET', `${base}/${id}`)).json[kind === 'wbs' ? 'item' : 'requirement'];
    assert.deepEqual((await get()).comments, []);
    const c1 = await M.c('POST', url.replace(`/api/workspaces/${A.w}/projects/${A.p.id}`, `/api/workspaces/${A.w}/projects/${A.p.id}`), { body: '  첫 댓글  ' });
    assert.equal(c1.status, 201, JSON.stringify(c1.json));
    assert.deepEqual(Object.keys(c1.json.comment).sort(), ['author_name', 'body', 'created_at', 'created_by', 'id']);
    assert.equal(c1.json.comment.body, '첫 댓글'); assert.equal(c1.json.comment.author_name, '멤버'); assert.equal(c1.json.comment.created_by, M.uid);
    const c2 = await A.c('POST', url, { body: '두 번째' });
    assert.deepEqual(c2.json.comments.map((c) => c.body), ['첫 댓글', '두 번째']);       // oldest first
    assert.deepEqual((await get()).comments.map((c) => c.body), ['첫 댓글', '두 번째']);
    // validation
    for (const body of [undefined, '', '   ', 'a'.repeat(2001), 5, null]) {
      const bad = await A.c('POST', url, body === undefined ? {} : { body });
      assert.equal(bad.status, 400, String(body)); assert.ok(bad.json.error.fields.body);
    }
    assert.equal((await A.c('POST', url, { body: 'a'.repeat(2000) })).status, 201);
    // delete permissions
    const other = await M2.c('DELETE', `${url}/${c1.json.comment.id}`);
    assert.equal(other.status, 403); assert.equal(other.json.error.code, 'forbidden');
    assert.equal((await M.c('DELETE', `${url}/${c1.json.comment.id}`)).status, 200);                  // author
    const byAdmin = await AD.c('DELETE', `${url}/${c2.json.comment.id}`);                              // ADMIN
    assert.equal(byAdmin.status, 200); assert.equal(byAdmin.json.comments.length, 1);
    const c3 = await M2.c('POST', url, { body: '멤버2 댓글' });
    assert.equal((await A.c('DELETE', `${url}/${c3.json.comment.id}`)).status, 200);                   // OWNER
    assert.equal((await A.c('DELETE', `${url}/${c3.json.comment.id}`)).status, 404);
    assert.equal((await A.c('DELETE', `${url}/nope`)).status, 404);
    // tenant isolation: non-members get 404 for everything
    assert.equal((await X.c('POST', url, { body: 'x' })).status, 404);
    assert.equal((await X.c('DELETE', `${url}/${c3.json.comment.id}`)).status, 404);
    // unknown entity / entity of another project
    assert.equal((await A.c('POST', `${base}/nope/comments`, { body: 'x' })).status, 404);
    const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: 'P2', project_type: 'SI', current_situation: 'NOT_STARTED', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' })).json.project;
    assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/${kind}/${id}/comments`, { body: 'x' })).status, 404);
  }
  // an archived ENTITY can still be commented; an archived PROJECT cannot (409)
  await A.c('POST', `${A.req}/${req.id}/archive`, {});
  await A.c('POST', `${A.wbs}/${wbs.id}/archive`, {});
  assert.equal((await A.c('POST', `${A.req}/${req.id}/comments`, { body: '보관 후 댓글' })).status, 201);
  assert.equal((await A.c('POST', `${A.wbs}/${wbs.id}/comments`, { body: '보관 후 댓글' })).status, 201);
  const last = (await A.c('GET', `${A.req}/${req.id}`)).json.requirement.comments.at(-1);
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('POST', `${A.req}/${req.id}/comments`, { body: 'x' })).status, 409);
  assert.equal((await A.c('POST', `${A.wbs}/${wbs.id}/comments`, { body: 'x' })).status, 409);
  assert.equal((await A.c('DELETE', `${A.req}/${req.id}/comments/${last.id}`)).status, 409);
  assert.equal((await A.c('GET', `${A.req}/${req.id}`)).json.requirement.comments.length > 0, true);   // reads still work
  server.close();
});

test('wbs history: CREATED, UPDATED per tracked field, MOVED, DEP_ADDED/REMOVED, LINKED_REQ/UNLINKED_REQ/LINK_TYPE_CHANGED, ARCHIVED (+descendants)', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const M = await addMember(client, A, 'm@x.com', '멤버');
  const sum = await mkWbs(A, { item_type: 'SUMMARY', title: '상위' });
  const t = await mkWbs(A, { item_type: 'TASK', title: '작업', parent_id: sum.id });
  const u = await mkWbs(A, { item_type: 'TASK', title: '다른 작업' });
  const hist = async (id) => (await A.c('GET', `${A.wbs}/${id}`)).json.item.history;
  let h = await hist(t.id);
  assert.deepEqual(h.map((x) => x.action_type), ['CREATED']); assert.equal(h[0].changed_by_name, '홍길동');

  const p = await A.c('PATCH', `${A.wbs}/${t.id}`, { title: '새 이름', status: 'IN_PROGRESS', progress: 30, owner_user_id: M.uid, planned_start_date: '2026-11-02', planned_end_date: '2026-11-06', description: '설명', title2: 'ignored' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  h = await hist(t.id);
  const upd = h.filter((x) => x.action_type === 'UPDATED');
  assert.deepEqual(upd.map((x) => x.field_name).sort(), ['description', 'owner_user_id', 'planned_end_date', 'planned_start_date', 'progress', 'status', 'title']);
  const f = (name) => upd.find((x) => x.field_name === name);
  assert.deepEqual([f('title').old_value, f('title').new_value], ['작업', '새 이름']);
  assert.deepEqual([f('progress').old_value, f('progress').new_value], ['0', '30']);
  assert.deepEqual([f('owner_user_id').old_value, f('owner_user_id').new_value], [null, M.uid]);       // owner stored as the user id
  assert.deepEqual([f('planned_end_date').old_value, f('planned_end_date').new_value], [null, '2026-11-06']);
  // unchanged values write nothing
  const n = (await hist(t.id)).length;
  await A.c('PATCH', `${A.wbs}/${t.id}`, { title: '새 이름', progress: 30 });
  assert.equal((await hist(t.id)).length, n);
  // newest first
  assert.equal(h[h.length - 1].action_type, 'CREATED');

  // MOVED: reparent (old/new = parent code or '(최상위)'), reorder
  await A.c('POST', `${A.wbs}/${t.id}/move`, { parent_id: null });
  let mv = (await hist(t.id)).find((x) => x.action_type === 'MOVED');
  assert.deepEqual([mv.old_value, mv.new_value], ['1', '(최상위)']);
  await A.c('POST', `${A.wbs}/${t.id}/move`, { parent_id: sum.id });
  mv = (await hist(t.id)).filter((x) => x.action_type === 'MOVED')[0];
  assert.deepEqual([mv.old_value, mv.new_value], ['(최상위)', '1']);
  const before = (await hist(t.id)).length;
  await A.c('POST', `${A.wbs}/${t.id}/move`, { sequence: 1 });                                         // already first → no row
  assert.equal((await hist(t.id)).length, before);

  // dependencies
  const dep = await A.c('POST', `${A.wbs}/${t.id}/dependencies`, { predecessor_id: u.id });
  assert.equal(dep.status, 201);
  const wbsAfter = (await A.c('GET', `${A.wbs}/${t.id}`)).json.item;
  const added = wbsAfter.history.find((x) => x.action_type === 'DEP_ADDED');
  assert.equal(added.new_value, `${u.wbs_code.length ? (await A.c('GET', `${A.wbs}/${u.id}`)).json.item.wbs_code : ''} 다른 작업`);
  await A.c('DELETE', `${A.wbs}/${t.id}/dependencies/${wbsAfter.predecessors[0].id}`);
  const removed = (await hist(t.id)).find((x) => x.action_type === 'DEP_REMOVED');
  assert.match(removed.old_value, /다른 작업$/);

  // requirement links mirror onto the WBS side without changing the requirement-side rows
  const r = await mkReq(A, { title: '요구' });
  const link = (await A.c('POST', `${A.wbs}/${t.id}/links`, { requirement_id: r.id })).json.item.requirement_links[0];
  assert.equal((await hist(t.id)).find((x) => x.action_type === 'LINKED_REQ').new_value, 'REQ-001');
  await A.c('PATCH', `${A.wbs}/${t.id}/links/${link.id}`, { link_type: 'SUPPORTS' });
  const lt = (await hist(t.id)).find((x) => x.action_type === 'LINK_TYPE_CHANGED');
  assert.deepEqual([lt.old_value, lt.new_value], ['REQ-001 IMPLEMENTS', 'REQ-001 SUPPORTS']);
  await A.c('DELETE', `${A.wbs}/${t.id}/links/${link.id}`);
  assert.equal((await hist(t.id)).find((x) => x.action_type === 'UNLINKED_REQ').old_value, 'REQ-001');
  const rh = (await A.c('GET', `${A.req}/${r.id}`)).json.requirement.history.map((x) => x.action_type);
  assert.deepEqual(rh.filter((x) => /WBS/.test(x)).sort(), ['LINKED_WBS', 'UNLINKED_WBS']);          // requirement side unchanged
  // linking from the requirement side writes the WBS-side row as well
  const l2 = (await A.c('POST', `${A.req}/${r.id}/links`, { wbs_item_id: u.id, link_type: 'VALIDATES' })).json.requirement.links[0];
  assert.equal((await hist(u.id)).find((x) => x.action_type === 'LINKED_REQ').new_value, 'REQ-001');
  await A.c('DELETE', `${A.req}/${r.id}/links/${l2.id}`);
  assert.ok((await hist(u.id)).some((x) => x.action_type === 'UNLINKED_REQ'));

  // archive: the item + descendants each get an ARCHIVED row
  await A.c('POST', `${A.wbs}/${sum.id}/archive`, {});
  assert.equal((await hist(sum.id)).filter((x) => x.action_type === 'ARCHIVED').length, 1);
  assert.equal((await hist(t.id)).filter((x) => x.action_type === 'ARCHIVED').length, 1);
  assert.equal((await hist(u.id)).filter((x) => x.action_type === 'ARCHIVED').length, 0);
  server.close();
});

test('dashboard: counts, overdue, workload, milestones, timeline, issues, recent changes; tenant isolation', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'a@x.com'); const X = await setup(client, 'x@x.com');
  const M = await addMember(client, A, 'm@x.com', '멤버');
  const url = `${A.purl}/dashboard`;
  assert.equal((await X.c('GET', url)).status, 404);
  assert.equal((await client()('GET', url)).status, 401);

  // empty project
  const empty = (await A.c('GET', url)).json;
  assert.deepEqual(empty.tasks, { total: 0, in_progress: 0, completed: 0, delayed: 0 });
  assert.deepEqual(empty.requirements, { total: 0, unconfirmed: 0, unlinked_in_scope: 0 });
  assert.deepEqual([empty.overdue_tasks, empty.workload, empty.milestones, empty.timeline], [[], [], [], []]);
  assert.deepEqual(empty.issues, { open: 0, critical_or_high: 0 });
  assert.deepEqual(empty.recent_changes.map((e) => e.entity_type), ['PHASE']);                      // project creation is a phase transition

  const sum = await mkWbs(A, { item_type: 'SUMMARY', title: '개발' });
  const sub = await mkWbs(A, { item_type: 'SUMMARY', title: '하위 상위', parent_id: sum.id });
  const t1 = await mkWbs(A, { item_type: 'TASK', title: '지연 작업', parent_id: sum.id, owner_user_id: A.uid, status: 'IN_PROGRESS', progress: 50, planned_start_date: day(-20), planned_end_date: day(-5) });
  const t2 = await mkWbs(A, { item_type: 'TASK', title: '더 지연 작업', parent_id: sub.id, planned_start_date: day(-30), planned_end_date: day(-12) });
  const t3 = await mkWbs(A, { item_type: 'TASK', title: '완료 작업', parent_id: sub.id, owner_user_id: A.uid, status: 'COMPLETED', planned_end_date: day(-40) });
  const t4 = await mkWbs(A, { item_type: 'TASK', title: '진행 작업', parent_id: sub.id, owner_user_id: M.uid, status: 'IN_PROGRESS', progress: 20, planned_start_date: day(1), planned_end_date: day(9) });
  const t5 = await mkWbs(A, { item_type: 'TASK', title: '오늘 종료', owner_user_id: M.uid, planned_end_date: day(0) });
  const m1 = await mkWbs(A, { item_type: 'MILESTONE', title: '다음 마일스톤', milestone_date: day(4) });
  const m2 = await mkWbs(A, { item_type: 'MILESTONE', title: '지난 마일스톤', milestone_date: day(-1) });
  const m0 = await mkWbs(A, { item_type: 'MILESTONE', title: '날짜 없음' });
  const arch = await mkWbs(A, { item_type: 'TASK', title: '보관', planned_end_date: day(-50) });
  await A.c('POST', `${A.wbs}/${arch.id}/archive`, {});

  const q1 = await mkReq(A, { title: '미확정', status: 'DRAFT', scope: 'IN_SCOPE' });
  await mkReq(A, { title: '검토', status: 'REVIEWING', scope: 'IN_SCOPE' });
  await mkReq(A, { title: '확정', status: 'CONFIRMED', scope: 'IN_SCOPE' });
  await mkReq(A, { title: '범위 외', status: 'CONFIRMED', scope: 'OUT_OF_SCOPE' });
  const gone = await mkReq(A, { title: '보관됨', status: 'DRAFT' });
  await A.c('POST', `${A.req}/${gone.id}/archive`, {});
  await A.c('POST', `${A.req}/${q1.id}/links`, { wbs_item_id: t1.id });

  const iss = `${A.purl}/issues`;
  await A.c('POST', iss, { title: '치명', severity: 'CRITICAL' }); await A.c('POST', iss, { title: '높음', severity: 'HIGH' });
  await A.c('POST', iss, { title: '낮음', severity: 'LOW' });
  const done = (await A.c('POST', iss, { title: '해결됨', severity: 'CRITICAL' })).json.issue;
  await A.c('PATCH', `${iss}/${done.id}`, { status: 'RESOLVED' });

  const d = (await A.c('GET', url)).json;
  assert.deepEqual(d.tasks, { total: 5, in_progress: 2, completed: 1, delayed: 2 });                // t1,t2 delayed; t3 completed; t5 ends today (not delayed)
  assert.deepEqual(d.requirements, { total: 4, unconfirmed: 2, unlinked_in_scope: 2 });
  assert.deepEqual(d.issues, { open: 3, critical_or_high: 2 });
  assert.deepEqual(d.overdue_tasks.map((x) => x.title), ['더 지연 작업', '지연 작업']);              // most overdue first
  assert.deepEqual(Object.keys(d.overdue_tasks[0]).sort(), ['days_overdue', 'id', 'owner_id', 'owner_name', 'planned_end_date', 'progress', 'status', 'title', 'wbs_code']);
  assert.equal(d.overdue_tasks[0].days_overdue, 12); assert.equal(d.overdue_tasks[1].days_overdue, 5);
  assert.equal(d.overdue_tasks[1].owner_name, '홍길동'); assert.equal(d.overdue_tasks[0].owner_id, null);
  // workload: sorted by open tasks (tasks − completed) desc; null owner is '미지정'
  const byName = Object.fromEntries(d.workload.map((w) => [w.owner_name, w]));
  assert.deepEqual(d.workload[0].owner_name, '멤버');                                                // 2 open
  assert.deepEqual(byName['멤버'], { owner_id: M.uid, owner_name: '멤버', tasks: 2, in_progress: 1, completed: 0, overdue: 0, avg_progress: 10 });
  assert.deepEqual(byName['홍길동'], { owner_id: A.uid, owner_name: '홍길동', tasks: 2, in_progress: 1, completed: 1, overdue: 1, avg_progress: 75 });
  assert.deepEqual(byName['미지정'], { owner_id: null, owner_name: '미지정', tasks: 1, in_progress: 0, completed: 0, overdue: 1, avg_progress: 0 });
  // milestones ordered by date, undated last
  assert.deepEqual(d.milestones.map((m) => [m.title, m.days_left]), [['지난 마일스톤', -1], ['다음 마일스톤', 4], ['날짜 없음', null]]);
  assert.deepEqual(Object.keys(d.milestones[0]).sort(), ['days_left', 'id', 'milestone_date', 'status', 'title', 'wbs_code']);
  // timeline: summaries + top-level items in tree order; summary dates derived from descendants, progress computed
  assert.deepEqual(d.timeline.map((x) => `${x.wbs_code}:${x.title}:${x.depth}`), ['1:개발:0', '1.1:하위 상위:1', '2:오늘 종료:0', '3:다음 마일스톤:0', '4:지난 마일스톤:0', '5:날짜 없음:0']);
  const tl = d.timeline[0]; assert.deepEqual([tl.start, tl.end, tl.item_type], [day(-30), day(9), 'SUMMARY']);
  assert.deepEqual([d.timeline[1].start, d.timeline[1].end], [day(-30), day(9)]);
  assert.equal(typeof tl.progress, 'number');
  assert.deepEqual([d.timeline[3].start, d.timeline[3].end], [day(4), day(4)]);
  assert.deepEqual(Object.keys(tl).sort(), ['depth', 'end', 'id', 'is_group', 'item_type', 'progress', 'start', 'status', 'title', 'wbs_code']);
  void t4; void t5; void m1; void m2; void m0; void sub;

  // recent changes: ≤ 15, newest first, all sources, hrefs relative to /app/projects/<pid>/
  const rc = d.recent_changes;
  assert.equal(rc.length, 15);
  assert.ok(rc.every((e, i) => i === 0 || rc[i - 1].at >= e.at));
  assert.deepEqual(Object.keys(rc[0]).sort(), ['actor_name', 'at', 'display_id', 'entity_id', 'entity_type', 'href', 'summary', 'title']);
  assert.equal(rc[0].entity_type, 'ISSUE'); assert.equal(rc[0].display_id, 'ISS-004'); assert.equal(rc[0].href, `issues?sel=${rc[0].entity_id}`);
  assert.equal(rc[0].summary, "상태를 '해결'(으)로 변경했습니다."); assert.equal(rc[0].actor_name, '홍길동');
  // targeted checks on the individual sources with small, distinct events
  const q = await mkReq(A, { title: 'LAST' });
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: '변경 요청 하나', description: 'x' })).json.change;
  const risk = (await A.c('POST', `${A.purl}/risks`, { title: '리스크 하나' })).json.risk;
  const test_ = (await A.c('POST', `${A.purl}/tests`, { title: '테스트 하나' })).json.test;
  const acc = (await A.c('POST', `${A.purl}/acceptances`, { title: '검수 하나' })).json.acceptance;
  const ph = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === 'REQUIREMENTS');
  await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'MANUAL' });
  await A.c('PATCH', `${A.wbs}/${t1.id}`, { status: 'COMPLETED' });
  const ev = (await A.c('GET', url)).json.recent_changes;
  const find = (type, id) => ev.find((e) => e.entity_type === type && (id ? e.entity_id === id : true));
  assert.equal(ev[0].entity_type, 'WBS'); assert.equal(ev[0].href, `wbs?sel=${t1.id}`);
  assert.deepEqual(ev.slice(0, 2).map((e) => e.summary).sort(), ["상태를 '완료'(으)로 변경했습니다.", "진행률을 '100'(으)로 변경했습니다."]);     // status + auto progress, one row each
  const phase = find('PHASE'); assert.equal(phase.href, 'phases/REQUIREMENTS'); assert.equal(phase.display_id, null);
  assert.equal(find('CHANGE', cr.id).title, '변경 요청 하나'); assert.equal(find('CHANGE', cr.id).href, `changes?sel=${cr.id}`);
  assert.equal(find('RISK', risk.id).href, `issues?tab=risks&sel=${risk.id}`);
  assert.equal(find('TEST', test_.id).href, `tests?sel=${test_.id}`);
  assert.equal(find('ACCEPTANCE', acc.id).href, `tests?tab=acceptance&sel=${acc.id}`);
  assert.equal(find('REQUIREMENT', q.id).summary, '새로 등록했습니다.'); assert.equal(find('REQUIREMENT', q.id).display_id, q.display_id);
  // another project's events never leak
  assert.ok(!(await X.c('GET', `${X.purl}/dashboard`)).json.recent_changes.some((e) => e.title === 'LAST'));
  server.close();
});
