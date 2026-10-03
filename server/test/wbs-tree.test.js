/* Tree WBS (Phase 12): groups by children, roll-ups, computed status, indent/outdent/duplicate/restore, delete policy,
 * max depth, column-mapping import, leaf-only metrics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, xlsxBase64 } from './api-helpers.js';

const mk = async (A, body) => { const r = await A.c('POST', A.wbs, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };
const tree = async (A) => (await A.c('GET', A.wbs)).json.items;
const codes = (items) => items.map((i) => `${i.wbs_code}:${i.title}`);
const find = (items, title) => items.find((i) => i.title === title);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test('group = has children; weighted progress + date roll-up; group edits refused; computed status', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const g = await mk(A, { title: '설계' });                       // no type given → TASK
  assert.equal(g.item_type, 'TASK');
  let t = await tree(A);
  assert.equal(find(t, '설계').is_group, false);
  const a = await mk(A, { title: 'A', parent_id: g.id, planned_start_date: '2026-11-03', planned_end_date: '2026-11-10', progress: 50, weight: 3 });
  const b = await mk(A, { title: 'B', parent_id: g.id, planned_start_date: '2026-11-01', planned_end_date: '2026-11-20', progress: 100, weight: 1, status: 'COMPLETED', actual_start_date: '2026-11-01', actual_end_date: '2026-11-19' });
  await mk(A, { title: 'M', parent_id: g.id, item_type: 'MILESTONE', milestone_date: '2026-12-01' });
  t = await tree(A);
  const G = find(t, '설계');
  assert.equal(G.is_group, true); assert.equal(G.rollup, true);
  assert.equal(G.computed_progress, Math.round((50 * 3 + 100 * 1) / 4));                           // weighted: (150+100)/4 = 63
  assert.deepEqual([G.planned_start, G.planned_end], ['2026-11-01', '2026-12-01']);                 // milestone date counts
  assert.deepEqual([G.actual_start, G.actual_end], ['2026-11-01', '2026-11-19']);
  assert.ok(!find(t, 'A').rollup);                                                                   // leaves report their own dates
  assert.deepEqual([find(t, 'A').planned_start, find(t, 'A').planned_end], ['2026-11-03', '2026-11-10']);
  // group cannot take its own progress / dates
  let r = await A.c('PATCH', `${A.wbs}/${g.id}`, { progress: 10 }); assert.equal(r.status, 400); assert.match(JSON.stringify(r.json), /자동 계산/);
  r = await A.c('PATCH', `${A.wbs}/${g.id}`, { planned_start_date: '2026-11-01' }); assert.equal(r.status, 400);
  r = await A.c('PATCH', `${A.wbs}/${g.id}`, { status: 'ON_HOLD', owner_user_id: A.uid, weight: 5 }); assert.equal(r.status, 200);   // allowed
  // weight 0 is excluded; all-zero → equal average
  await A.c('PATCH', `${A.wbs}/${a.id}`, { weight: 0 });
  t = await tree(A); assert.equal(find(t, '설계').computed_progress, 100);
  await A.c('PATCH', `${A.wbs}/${b.id}`, { weight: 0 });
  t = await tree(A); assert.equal(find(t, '설계').computed_progress, 75);
  // computed status: 보류 (explicit) wins on the group; children by dates/progress
  assert.equal(find(t, '설계').computed_status, 'ON_HOLD');
  assert.equal(find(t, 'B').computed_status, 'COMPLETED');
  const late = await mk(A, { title: 'late', planned_start_date: day(-10), planned_end_date: day(-2), progress: 10 });
  const future = await mk(A, { title: 'future', planned_start_date: day(5), planned_end_date: day(9) });
  const run = await mk(A, { title: 'run', planned_start_date: day(-1), planned_end_date: day(9), progress: 1 });
  t = await tree(A);
  assert.deepEqual([find(t, 'late').computed_status, find(t, 'future').computed_status, find(t, 'run').computed_status], ['DELAYED', 'PLANNED', 'IN_PROGRESS']);
  await A.c('PATCH', `${A.wbs}/${late.id}`, { status: 'COMPLETED' });
  t = await tree(A); assert.equal(find(t, 'late').computed_status, 'COMPLETED');            // completed is never late
  // group status follows its roll-up (max end date not passed → 진행중 even with a delayed child); explicit 보류 removed
  await A.c('PATCH', `${A.wbs}/${g.id}`, { status: 'IN_PROGRESS' });
  await A.c('POST', `${A.wbs}/${run.id}/move`, { parent_id: g.id });
  await A.c('POST', `${A.wbs}/${future.id}/move`, { parent_id: g.id });
  await A.c('PATCH', `${A.wbs}/${future.id}`, { planned_start_date: day(-9), planned_end_date: day(-3) });
  t = await tree(A); assert.equal(find(t, 'future').computed_status, 'DELAYED'); assert.equal(find(t, '설계').computed_status, 'IN_PROGRESS');
  // once every descendant's end has passed the group itself is 지연
  await A.c('PATCH', `${A.wbs}/${run.id}`, { planned_start_date: day(-9), planned_end_date: day(-3) });
  await A.c('PATCH', `${A.wbs}/${a.id}`, { planned_start_date: day(-9), planned_end_date: day(-3) });
  await A.c('PATCH', `${A.wbs}/${b.id}`, { planned_start_date: day(-9), planned_end_date: day(-3) });
  t = await tree(A); const M = find(t, 'M'); await A.c('PATCH', `${A.wbs}/${M.id}`, { milestone_date: day(-1) });
  t = await tree(A); assert.equal(find(t, '설계').computed_status, 'DELAYED');
  // stats: tasks counts leaf tasks, summaries counts groups
  const s = (await A.c('GET', A.wbs)).json.summary;
  assert.equal(s.summaries, 1); assert.equal(s.milestones, 1); assert.equal(s.tasks, 5);
  server.close();
});

test('indent / outdent / duplicate / restore / delete policy / max depth / history', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const p1 = await mk(A, { title: '1' }); const p2 = await mk(A, { title: '2' }); const p3 = await mk(A, { title: '3' });
  // indent 2 under 1 (previous sibling), then 3 under 2
  let r = await A.c('POST', `${A.wbs}/${p2.id}/indent`, {}); assert.equal(r.status, 200);
  assert.deepEqual(r.json.undo.from, { parent_id: null, sequence: 2 }); assert.equal(r.json.undo.to.parent_id, p1.id);
  assert.deepEqual(codes(r.json.items), ['1:1', '1.1:2', '2:3']);
  r = await A.c('POST', `${A.wbs}/${p3.id}/indent`, {}); assert.deepEqual(codes(r.json.items), ['1:1', '1.1:2', '1.2:3']);
  r = await A.c('POST', `${A.wbs}/${p3.id}/indent`, {}); assert.deepEqual(codes(r.json.items), ['1:1', '1.1:2', '1.1.1:3']);
  // first child cannot indent; root cannot outdent
  assert.equal((await A.c('POST', `${A.wbs}/${p2.id}/indent`, {})).status, 400);
  assert.equal((await A.c('POST', `${A.wbs}/${p1.id}/outdent`, {})).status, 400);
  // outdent 3 → sibling right after its former parent
  r = await A.c('POST', `${A.wbs}/${p3.id}/outdent`, {}); assert.deepEqual(codes(r.json.items), ['1:1', '1.1:2', '1.2:3']);
  // undo via move with the returned `from`
  r = await A.c('POST', `${A.wbs}/${p3.id}/move`, r.json.undo.from); assert.deepEqual(codes(r.json.items), ['1:1', '1.1:2', '1.1.1:3']);
  // max depth 5: 1 > 1.1 > 1.1.1 > 1.1.1.1 > 1.1.1.1.1 ok, deeper refused
  const d4 = await mk(A, { title: '4', parent_id: p3.id }); const d5 = await mk(A, { title: '5', parent_id: d4.id });
  assert.equal((await A.c('POST', A.wbs, { title: '6', parent_id: d5.id })).status, 400);
  assert.equal((await A.c('POST', `${A.wbs}/${d5.id}/indent`, {})).status, 400);               // no previous sibling anyway
  // moving a subtree that would exceed depth
  const x = await mk(A, { title: 'x' }); await mk(A, { title: 'x1', parent_id: x.id });
  assert.equal((await A.c('POST', `${A.wbs}/${x.id}/move`, { parent_id: d5.id })).status, 400);
  // duplicate subtree
  r = await A.c('POST', `${A.wbs}/${p2.id}/duplicate`, {}); assert.equal(r.status, 201);
  assert.equal(r.json.item.title, '2 (복사)'); assert.equal(r.json.created_ids.length, 4);        // 2,3,4,5
  assert.deepEqual(codes(r.json.items).slice(0, 10), ['1:1', '1.1:2', '1.1.1:3', '1.1.1.1:4', '1.1.1.1.1:5', '1.2:2 (복사)', '1.2.1:3', '1.2.1.1:4', '1.2.1.1.1:5', '2:x']);
  const dupId = r.json.item.id;
  // delete with children: promote
  r = await A.c('POST', `${A.wbs}/${dupId}/archive`, { children: 'promote' }); assert.equal(r.status, 200);
  assert.deepEqual(codes(r.json.items).slice(0, 8), ['1:1', '1.1:2', '1.1.1:3', '1.1.1.1:4', '1.1.1.1.1:5', '1.2:3', '1.2.1:4', '1.2.1.1:5']);
  // delete with children: cascade, then restore brings the subtree back at its place
  r = await A.c('POST', `${A.wbs}/${p2.id}/archive`, {}); assert.equal(r.status, 200);
  assert.deepEqual(codes(r.json.items), ['1:1', '1.1:3', '1.1.1:4', '1.1.1.1:5', '2:x', '2.1:x1']);
  r = await A.c('POST', `${A.wbs}/${p2.id}/restore`, {}); assert.equal(r.status, 200);
  assert.deepEqual(codes(r.json.items), ['1:1', '1.1:2', '1.1.1:3', '1.1.1.1:4', '1.1.1.1.1:5', '1.2:3', '1.2.1:4', '1.2.1.1:5', '2:x', '2.1:x1']);
  assert.equal((await A.c('POST', `${A.wbs}/${p2.id}/restore`, {})).status, 409);
  // history: parent moves, weight, restore
  const h = (await A.c('GET', `${A.wbs}/${p2.id}`)).json.item.history.map((e) => e.action_type);
  assert.ok(h.includes('MOVED') && h.includes('ARCHIVED') && h.includes('RESTORED') && h.includes('CREATED'));
  await A.c('PATCH', `${A.wbs}/${p2.id}`, { weight: 4 });
  const h2 = (await A.c('GET', `${A.wbs}/${p2.id}`)).json.item.history;
  assert.ok(h2.some((e) => e.action_type === 'UPDATED' && e.field_name === 'weight' && e.new_value === '4'));
  // legacy SUMMARY still accepted by the API
  assert.equal((await A.c('POST', A.wbs, { title: 'legacy', item_type: 'SUMMARY' })).status, 201);
  server.close();
});

test('import inspect + mapping: Lv1..Lv3 layout, code layout, flat layout; progress on a group row is an error', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  // levels layout: group labels repeated or blank
  const lv = await xlsxBase64(['Lv1', 'Lv2', 'Lv3', '담당자', '시작일', '종료일', '진행률'], [
    ['분석', '', '', '', '', '', ''],
    ['분석', '요구사항 정의', '', '', '2026-11-02', '2026-11-06', '30'],
    ['', '요구사항 정의', '인터뷰', '', '2026-11-02', '2026-11-03', '100'],
    ['', '화면 설계', '', '', '2026-11-09', '2026-11-13', ''],
    ['설계', '', '', '', '', '', ''],
    ['', 'DB 설계', '', '', '2026-11-16', '2026-11-20', '0'],
  ]);
  let r = await A.c('POST', `${A.wbs}/import/inspect`, { data: lv }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.layout, 'levels'); assert.deepEqual([r.json.suggested.lv1, r.json.suggested.lv2, r.json.suggested.lv3, r.json.suggested.progress], [1, 2, 3, 7]);
  r = await A.c('POST', `${A.wbs}/import/preview`, { data: lv, mapping: r.json.suggested }); assert.equal(r.status, 200, JSON.stringify(r.json));
  const got = r.json.rows.map((x) => `${x.values.code}:${x.values.title}`);
  assert.deepEqual(got, ['1:분석', '1.1:요구사항 정의', '1.1.1:인터뷰', '1.2:화면 설계', '2:설계', '2.1:DB 설계']);
  const bad = r.json.rows.find((x) => x.values.title === '요구사항 정의');
  assert.ok(bad.errors && Object.values(bad.errors).some((m) => /하위|상위|진행률/.test(m)), JSON.stringify(bad));   // group row with progress
  assert.ok(r.json.rows.filter((x) => x.values.title !== '요구사항 정의').every((x) => !x.errors || !Object.keys(x.errors).length), JSON.stringify(r.json.rows));
  // code layout with "1." style and a differently named title column
  const cd = await xlsxBase64(['No', 'Task', 'Owner'], [['1.', '분석', ''], ['1-1', '요구사항', ''], ['2', '설계', '']]);
  r = await A.c('POST', `${A.wbs}/import/inspect`, { data: cd }); assert.equal(r.json.layout, 'code');
  r = await A.c('POST', `${A.wbs}/import/preview`, { data: cd, mapping: { code: 1, title: 2, owner: 3 } });
  assert.deepEqual(r.json.rows.map((x) => `${x.values.code}:${x.values.title}`), ['1:분석', '1.1:요구사항', '2:설계']);
  assert.equal(r.json.summary.errors ?? r.json.summary.error ?? 0, 0);
  // flat layout → sequential root codes, then commit creates TASK items (no SUMMARY)
  const fl = await xlsxBase64(['업무', '메모'], [['킥오프', ''], ['요구사항 정리', '']]);
  r = await A.c('POST', `${A.wbs}/import/inspect`, { data: fl }); assert.equal(r.json.layout, 'flat'); assert.equal(r.json.suggested.title, 1);
  r = await A.c('POST', `${A.wbs}/import/preview`, { data: fl, mapping: { title: 1 } });
  assert.deepEqual(r.json.rows.map((x) => x.values.code), ['1', '2']);
  r = await A.c('POST', `${A.wbs}/import`, { rows: r.json.rows.map((x) => ({ row: x.row, values: x.values })) }); assert.equal(r.status, 200, JSON.stringify(r.json));
  const t = await tree(A); assert.deepEqual(codes(t), ['1:킥오프', '2:요구사항 정리']); assert.ok(t.every((i) => i.item_type === 'TASK'));
  // mapping without a title/lv1 column is rejected
  assert.equal((await A.c('POST', `${A.wbs}/import/preview`, { data: fl, mapping: { owner: 2 } })).status, 400);
  server.close();
});

test('metrics count leaf tasks only (groups excluded from dashboard/health counts)', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const g = await mk(A, { title: '그룹', planned_start_date: day(-20), planned_end_date: day(-5) });    // becomes a group → its own stale dates must not count
  await mk(A, { title: '자식 지연', parent_id: g.id, planned_start_date: day(-10), planned_end_date: day(-2), progress: 10, convert_parent: 'drop' });   // BUG-005: explicit decision
  await mk(A, { title: '자식 정상', parent_id: g.id, planned_start_date: day(1), planned_end_date: day(5) });
  const d = (await A.c('GET', `${A.purl}/dashboard`)).json;
  assert.deepEqual(d.tasks, { total: 2, in_progress: 0, completed: 0, delayed: 1 });
  assert.deepEqual(d.overdue_tasks.map((x) => x.title), ['자식 지연']);
  const tl = d.timeline.find((x) => x.title === '그룹'); assert.ok(tl && tl.is_group);
  server.close();
});
