/* batch7 T5 plan limits + paywall, updated for pricing v3 (D1, D6):
 *   FREE = 1 active project / 3 users (no requirement/WBS/report caps), early access is no longer unlimited (FREE limits), existing data over a
 *   limit is never deleted (editing is locked until cleanup — D6), every refusal is a 402 pointing at /app/billing/plans. AI: credits were retired
 *   2026-10-27 — a Free workspace whose AI allowance is used up gets 402 AI_USAGE_LIMIT_REACHED (ai-usage.test.js covers the allowance). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, project } from './api-helpers.js';
import { PLANS, PLANS_URL } from '../plans.js';
import { effectivePlan } from '../billing/subscriptions.js';
import { migrations, LATEST_VERSION } from '../migrations.js';
import { setFakeProvider } from '../ai/provider.js';

process.env.PLAN_LIMITS = 'on';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
for (const k of ['EARLY_ACCESS_CUTOFF', 'EARLY_ACCESS_LAUNCH']) delete process.env[k];
process.env.AI_FREE_CLAIM_SCOPE = 'workspace';

const ws = (w) => `/api/workspaces/${w}`;

test('catalogue (pricing v3): FREE = 1 active project, 3 users, no requirement/WBS/report caps (D1); EARLY carries the FREE limits', () => {
  assert.deepEqual({ ...PLANS.FREE.limits }, { projects: 1, members: 3, requirements: null, wbs: null, weekly_reports: null });
  assert.deepEqual({ ...PLANS.EARLY.limits }, { ...PLANS.FREE.limits });
  assert.equal(PLANS_URL, '/app/billing/plans');
});

test('1-project limit (v3): the 2nd project is 402 with the upsell target; early access (future early_access_until) is on FREE limits', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw1@x.com');
  assert.equal((await db.get('SELECT early_access_until FROM workspaces WHERE id = ?', [A.w])).early_access_until, null);   // b7-fix: signup grants no early access
  await db.run(`UPDATE workspaces SET early_access_until = now() + interval '1 year' WHERE id = ?`, [A.w]);   // an old stamped account …
  assert.equal(await effectivePlan(db, A.w), 'FREE');         // … is on the Free limits too
  const r = await A.c('POST', `${ws(A.w)}/projects`, project({ name: '둘째' }));
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'plan_limit_reached');
  assert.equal(r.json.error.limit.dimension, 'projects'); assert.equal(r.json.error.limit.limit, 1); assert.equal(r.json.error.limit.plan, 'FREE');
  assert.equal(r.json.error.upgrade.url, '/app/billing/plans');
  assert.match(r.json.error.message, /Free 플랜의 활성 프로젝트 한도\(1개\)에 도달했습니다/);
  assert.doesNotMatch(r.json.error.message, /₩/);
  // samples do not count
  assert.equal((await A.c('GET', `${ws(A.w)}/billing`)).json.billing.usage.dims.find((d) => d.key === 'projects').used, 1);
  server.close();
});

test('D1: no WBS cap on FREE any more — the 101st item is created', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw2@x.com');
  const rows = Array.from({ length: 100 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `w${i}` } }));
  assert.equal((await A.c('POST', `${A.wbs}/import`, { rows })).status, 200);
  assert.equal((await A.c('POST', A.wbs, { title: '101번째', item_type: 'TASK' })).status, 201);
  assert.ok(db);
  server.close();
});

test('over-limit existing data is untouched and readable; older projects read-only (409 project_read_only), new projects 402', async () => {
  const { db, server, client } = await boot();
  process.env.PLAN_LIMITS = 'off';   // build a workspace that was unlimited (former early access)
  const A = await setup(client, 'pw3@x.com');
  for (const n of ['2', '3', '4']) assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: `p${n}` }))).status, 201);
  for (let i = 0; i < 55; i++) assert.equal((await A.c('POST', A.req, { title: `R${i}` })).status, 201);
  process.env.PLAN_LIMITS = 'on';
  const list = (await A.c('GET', `${ws(A.w)}/projects`)).json.projects.filter((p) => !p.sample_key);
  assert.equal(list.length, 4);
  const reqs = (await A.c('GET', A.req)).json.requirements;
  assert.equal(reqs.length, 55);
  const upd = await A.c('PATCH', `${A.req}/${reqs[0].id}`, { title: '잠김' });
  assert.equal(upd.status, 409); assert.equal(upd.json.error.code, 'project_read_only');   // oldest of 4 on Free (1): read-only
  assert.equal((await A.c('POST', A.req, { title: '새 항목' })).status, 409);
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: 'p5' }))).status, 402);
  assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND sample_key IS NULL AND status != 'ARCHIVED'`, [A.w])).n), 4);
  const u = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing.usage;
  assert.equal(u.dims.find((d) => d.key === 'projects').used, 4); assert.equal(Number((await db.get('SELECT COUNT(*) n FROM requirements WHERE project_id = ?', [A.p.id])).n), 55);
  server.close();
});

test('AI with the Free allowance used up: 402 AI_USAGE_LIMIT_REACHED, the dialog points at the plans page', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw4@x.com');
  await db.run(`INSERT INTO ai_runs (id, workspace_id, user_id, feature, provider, model, status, provider_cost_amount, plan_key) VALUES ('spent', ?, ?, 'PROJECT_QA', 'fake', 'fake-model', 'SUCCEEDED', 2, 'FREE')`, [A.w, A.uid]);
  setFakeProvider(() => ({ data: { answer: 'ok', references: [], warnings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }));
  const r = await A.c('POST', `${A.purl}/ai/ask`, { question: '진행 상황은?' });
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'AI_USAGE_LIMIT_REACHED'); assert.equal(r.json.error.usage.allowance, 'ONCE');
  assert.ok(r.json.error.message.includes('Pro'));
  server.close();
});
