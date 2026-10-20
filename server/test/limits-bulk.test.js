/* batch7 #24 → pricing v3 (decision D1): the Free caps on requirements / WBS / weekly reports are gone — limits are active projects
 * and users only. The bulk paths (Excel import, AI commits, WBS 뼈대) still call assertWithinLimit once with the batch total; for these
 * dimensions it passes straight through, so nothing is refused and nothing is half-created. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { setFakeProvider } from '../ai/provider.js';
import { assertWithinLimit } from '../billing/limits.js';

process.env.PLAN_LIMITS = 'on';

const count = async (db, table, pid) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND archived_at IS NULL`, [pid])).n);

test('FREE requirements: Excel import, AI commit and single create are not capped any more (old cap 50)', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'lb1@x.com');
  const rows = (n, p = 't') => Array.from({ length: n }, (_, i) => ({ row: i + 2, values: { title: `${p}${i}` } }));
  assert.equal((await A.c('POST', `${A.req}/import`, { rows: rows(55) })).status, 200);
  setFakeProvider(() => ({ data: {} }));
  assert.equal((await A.c('POST', `${A.purl}/ai/requirements/commit`, { candidates: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })).status, 201);
  assert.equal((await A.c('POST', A.req, { title: '59번째' })).status, 201);
  assert.equal(await count(db, 'requirements', A.p.id), 59);
  server.close();
});

test('FREE WBS: import beyond the old cap (100), AI commit and direct add all succeed', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'lb2@x.com');
  const rows = Array.from({ length: 105 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `w${i}` } }));
  assert.equal((await A.c('POST', `${A.wbs}/import`, { rows })).status, 200);
  const r = await A.c('POST', `${A.purl}/ai/wbs/commit`, { items: Array.from({ length: 4 }, (_, i) => ({ temp_id: `t${i}`, item_type: 'TASK', title: `ai${i}` })) });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  assert.equal((await A.c('POST', A.wbs, { title: 'd1', item_type: 'TASK' })).status, 201);
  assert.equal(await count(db, 'wbs_items', A.p.id) >= 110, true);
  server.close();
});

test('assertWithinLimit: requirements / wbs / weekly_reports pass through for any batch size', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'lb3@x.com');
  for (const dim of ['requirements', 'wbs', 'weekly_reports']) await assertWithinLimit(db, A.w, dim, 10000);
  server.close();
});
