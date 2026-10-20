/* batch7 #24: FREE plan limits on bulk paths — one total check before anything is created (Excel import, AI commits, WBS 뼈대),
 * "n건 중 m건만" in the 402, nothing half-created; the single-row paths still 402 at the limit; EARLY is never blocked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { setFakeProvider } from '../ai/provider.js';
import { PLANS } from '../plans.js';

process.env.PLAN_LIMITS = 'on';

const toFree = (db, w) => db.run(`UPDATE workspaces SET early_access_until = now() - interval '1 day' WHERE id = ?`, [w]);
const count = async (db, table, pid) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND archived_at IS NULL`, [pid])).n);
const LIM = PLANS.FREE.limits;

test('requirements: Excel import and AI commit check the whole batch first (402, allowed = free slots, nothing created); single create 402 at the limit', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'lb1@x.com'); await toFree(db, A.w);
  const rows = (n, p = 't') => Array.from({ length: n }, (_, i) => ({ row: i + 2, values: { title: `${p}${i}` } }));
  assert.equal((await A.c('POST', `${A.req}/import`, { rows: rows(LIM.requirements - 2) })).status, 200);
  let r = await A.c('POST', `${A.req}/import`, { rows: rows(5, 'x') });
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'plan_limit_reached');
  assert.equal(r.json.error.limit.allowed, 2); assert.equal(r.json.error.limit.adding, 5);
  assert.match(r.json.error.message, /5건 중 2건만 추가할 수 있어 아무것도 추가하지 않았습니다/);
  assert.equal(await count(db, 'requirements', A.p.id), LIM.requirements - 2);
  // AI commit: 3 candidates into 2 free slots → 402, nothing created
  setFakeProvider(() => ({ data: {} }));
  r = await A.c('POST', `${A.purl}/ai/requirements/commit`, { candidates: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] });
  assert.equal(r.status, 402); assert.equal(r.json.error.limit.allowed, 2);
  assert.equal(await count(db, 'requirements', A.p.id), LIM.requirements - 2);
  for (const t of ['y1', 'y2']) assert.equal((await A.c('POST', A.req, { title: t })).status, 201);
  r = await A.c('POST', A.req, { title: 'one too many' });   // 51건째
  assert.equal(r.status, 402); assert.match(r.json.error.message, /한도\(50\)에 도달했습니다/);
  server.close();
});

test('WBS: AI commit and Excel import are all-or-nothing against the FREE limit; direct add 402 at 101', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'lb2@x.com'); await toFree(db, A.w);
  // fill to limit-3 through the import (one batch fits)
  const rows = Array.from({ length: LIM.wbs - 3 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `w${i}` } }));
  assert.equal((await A.c('POST', `${A.wbs}/import`, { rows })).status, 200);
  let r = await A.c('POST', `${A.wbs}/import`, { rows: Array.from({ length: 4 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `z${i}` } })) });
  assert.equal(r.status, 402); assert.equal(r.json.error.limit.allowed, 3);
  r = await A.c('POST', `${A.purl}/ai/wbs/commit`, { items: Array.from({ length: 4 }, (_, i) => ({ temp_id: `t${i}`, item_type: 'TASK', title: `ai${i}` })) });
  assert.equal(r.status, 402); assert.equal(r.json.error.limit.allowed, 3);
  assert.equal(await count(db, 'wbs_items', A.p.id), LIM.wbs - 3);
  for (const t of ['d1', 'd2', 'd3']) assert.equal((await A.c('POST', A.wbs, { title: t, item_type: 'TASK' })).status, 201);
  r = await A.c('POST', A.wbs, { title: 'd4', item_type: 'TASK' });   // 101건째
  assert.equal(r.status, 402);
  server.close();
});

test('WBS 뼈대 on an empty WBS: refused as a whole when it does not fit (nothing created)', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'lb3@x.com');   // still EARLY: a second project is allowed
  const p2 = (await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: 'P2', client_name: 'C', project_type: 'NEW_BUILD', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28' })).json.project;
  const rows = Array.from({ length: LIM.wbs - 2 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `w${i}` } }));
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects/${p2.id}/wbs/import`, { rows })).status, 200);
  await db.run(`UPDATE projects SET status = 'ARCHIVED' WHERE id = ?`, [p2.id]);   // its WBS rows still count against the plan
  await toFree(db, A.w);
  const r = await A.c('POST', `${A.wbs}/skeleton`, {});
  assert.equal(r.status, 402); assert.match(r.json.error.message, /건 중 2건만 추가할 수 있어/);
  assert.equal(await count(db, 'wbs_items', A.p.id), 0);
  server.close();
});

test('EARLY workspace: the same bulk paths are never blocked', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'lb4@x.com');   // signup grants early access (unlimited)
  const rows = Array.from({ length: LIM.requirements + 5 }, (_, i) => ({ row: i + 2, values: { title: `t${i}` } }));
  assert.equal((await A.c('POST', `${A.req}/import`, { rows })).status, 200);
  const me = await A.c('GET', `/api/workspaces/${A.w}/billing`);
  assert.equal(me.json.billing.plan, 'EARLY');
  server.close();
});
